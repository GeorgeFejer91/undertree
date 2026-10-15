//! Exact native save ownership; recovery never guesses a project from a pathname.
use super::*;

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct JournalOwnership {
    pub project: String,
    pub path: String,
    #[serde(default)]
    pub source_epoch: u64,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::root_observation::optional"
    )]
    pub expected_root: Option<RootObservation>,
    pub owns_source: bool,
}

impl Service {
    pub(super) fn validate_save_ownership(
        &self,
        ownership: &JournalOwnership,
        path: &Path,
    ) -> Result<()> {
        self.require_source_epoch(&ownership.project, &ownership.path, ownership.source_epoch)
            .map_err(|_| policy_continuity::conflict())?;
        let approved = self
            .project(&ownership.project)
            .map_err(|_| policy_continuity::conflict())?;
        if approved.root.join(&ownership.path) != path {
            return Err(policy_continuity::conflict());
        }
        self.acquire_group(
            SourceBinding::new(&ownership.project, &ownership.path, ownership.source_epoch)
                .rooted(ownership.expected_root),
        )
        .map_err(|_| policy_continuity::conflict())?;
        Ok(())
    }

    pub(super) fn journal_ownership(
        &self,
        project: &Project,
        relative: &str,
        path: &Path,
        journal: &Journal,
        binding: SourceBinding<'_>,
    ) -> Result<JournalOwnership> {
        let source_epoch = binding.epoch;
        if let Some(receipt) = &journal.editor_receipt {
            self.validate_editor_journal(path, &journal.content, receipt)
                .map_err(|_| policy_continuity::conflict())?;
            if receipt.project != project.id
                || receipt.path != relative
                || receipt.source_epoch != source_epoch
                || (binding.guarded && receipt.expected_root != binding.root)
            {
                return Err(policy_continuity::conflict());
            }
        }
        let changes_source = journal.old_revision != digest(&journal.content);
        let ownership = match (&journal.ownership, &journal.editor_receipt) {
            (Some(ownership), _) => ownership.clone(),
            (None, Some(receipt)) => JournalOwnership {
                project: receipt.project.clone(),
                path: receipt.path.clone(),
                source_epoch: receipt.source_epoch,
                owns_source: changes_source,
                expected_root: receipt.expected_root,
            },
            (None, None) => return Err(policy_continuity::conflict()),
        };
        if ownership.project != project.id
            || ownership.path != relative
            || ownership.source_epoch != source_epoch
            || ownership.owns_source != changes_source
            || (binding.guarded
                && (binding.root.is_none() || ownership.expected_root != binding.root))
        {
            return Err(policy_continuity::conflict());
        }
        self.validate_save_ownership(&ownership, path)?;
        Ok(ownership)
    }

    pub(super) fn finish_journal_ownership_rooted(
        &self,
        ownership: &JournalOwnership,
        path: &Path,
        content: &str,
        review_json: &str,
        group: &SourceGroup,
    ) -> Result<()> {
        self.validate_save_ownership(ownership, path)?;
        if ownership
            .expected_root
            .is_some_and(|root| root != group.observation())
            || group.read_utf8(Member::Source, MAX_TEXT)?.text()? != Some(content)
            || group.read_utf8(Member::Review, MAX_TEXT * 8)?.text()? != Some(review_json)
        {
            return Err(policy_continuity::conflict());
        }
        group.check_current()?;
        let mut registry = lock(&self.registry)?;
        let mut next = registry.clone();
        let project = next
            .projects
            .iter_mut()
            .find(|project| project.id == ownership.project)
            .ok_or_else(policy_continuity::conflict)?;
        if ownership.owns_source {
            project.pending.insert(ownership.path.clone());
            project
                .pending_revisions
                .insert(ownership.path.clone(), digest(content));
        }
        let metadata = format!("{}.undertree-review.json", ownership.path);
        project.pending.insert(metadata.clone());
        project
            .pending_revisions
            .insert(metadata, digest(review_json));
        self.save_registry(&next)?;
        group.check_current()?;
        source_identity::require_in(
            &registry,
            &ownership.project,
            &ownership.path,
            ownership.source_epoch,
        )?;
        *registry = next;
        Ok(())
    }
}

#[cfg(test)]
mod tests;
