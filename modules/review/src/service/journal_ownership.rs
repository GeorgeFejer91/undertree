//! Exact native save ownership; recovery never guesses a project from a pathname.
use super::*;

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct JournalOwnership {
    pub project: String,
    pub path: String,
    pub owns_source: bool,
}

impl Service {
    pub(super) fn validate_save_ownership(
        &self,
        ownership: &JournalOwnership,
        path: &Path,
    ) -> Result<()> {
        let approved = self
            .project(&ownership.project)
            .map_err(|_| policy_continuity::conflict())?;
        if self
            .path(&approved, &ownership.path, false)
            .map_err(|_| policy_continuity::conflict())?
            != path
        {
            return Err(policy_continuity::conflict());
        }
        Ok(())
    }

    pub(super) fn journal_ownership(
        &self,
        project: &Project,
        relative: &str,
        path: &Path,
        journal: &Journal,
    ) -> Result<JournalOwnership> {
        if let Some(receipt) = &journal.editor_receipt {
            self.validate_editor_journal(path, &journal.content, receipt)
                .map_err(|_| policy_continuity::conflict())?;
            if receipt.project != project.id || receipt.path != relative {
                return Err(policy_continuity::conflict());
            }
        }
        let changes_source = journal.old_revision != digest(&journal.content);
        let ownership = match (&journal.ownership, &journal.editor_receipt) {
            (Some(ownership), _) => ownership.clone(),
            (None, Some(receipt)) => JournalOwnership {
                project: receipt.project.clone(),
                path: receipt.path.clone(),
                owns_source: changes_source,
            },
            (None, None) => return Err(policy_continuity::conflict()),
        };
        if ownership.project != project.id
            || ownership.path != relative
            || ownership.owns_source != changes_source
        {
            return Err(policy_continuity::conflict());
        }
        self.validate_save_ownership(&ownership, path)?;
        Ok(ownership)
    }

    pub(super) fn finish_journal_ownership(
        &self,
        ownership: &JournalOwnership,
        path: &Path,
        content: &str,
        review_json: &str,
    ) -> Result<()> {
        self.validate_save_ownership(ownership, path)?;
        if read_text(path, MAX_TEXT)? != content
            || self.raw_review(path)?.as_deref() != Some(review_json)
        {
            return Err(policy_continuity::conflict());
        }
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
        *registry = next;
        Ok(())
    }
}

#[cfg(test)]
mod tests;
