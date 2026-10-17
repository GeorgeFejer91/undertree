use super::*;
use crate::document::Decision;

pub(super) struct Receipt {
    from: String,
    to: String,
}

impl Service {
    pub(super) fn direct_edit_snapshot(
        &self,
        binding: SourceBinding<'_>,
        root: RootObservation,
        snapshot: &mut Value,
    ) -> Result<()> {
        let id =
            source_identity::rooted_document_id(binding.project, binding.path, binding.epoch, root);
        if let Some(receipt) = lock(&self.direct_edits)?.get(&id) {
            if snapshot["review"]["revision"] == receipt.to {
                snapshot["directEdit"] =
                    json!({"fromRevision":receipt.from,"toRevision":receipt.to});
            }
        }
        Ok(())
    }

    pub(super) fn apply_direct_edit(
        &self,
        binding: SourceBinding<'_>,
        file: &Path,
        document: &HeldDocument,
        mut review: Review,
        suggestion_id: &str,
        editor: &editor::EditorState,
    ) -> Result<Value> {
        let text = &document.content;
        let from_revision = digest(text);
        editor.check_remote_edit(binding, &from_revision)?;
        if let Some(suggestion) = review.suggestions.iter().find(|suggestion| {
            suggestion.id == suggestion_id && suggestion.replacement_parts.is_some()
        }) {
            if suggestion.context_scope.as_deref()
                != Some(self.current_context_scope(binding, editor)?.as_str())
            {
                return Err(Error::new(
                    "context_stale",
                    "Complete manuscript context changed before the protected rewrite could apply.",
                ));
            }
        }
        self.history_recover_empty_producer_init()?;
        let changed = review.decide_format(
            text,
            &from_revision,
            suggestion_id,
            Decision::Accepted,
            binding.path.ends_with(".typ"),
        )?;
        self.pdf_annotation_policy(&self.project(binding.project)?, binding.root)?
            .check()?;
        if let Some(suggestion) = review.suggestions.iter().find(|suggestion| {
            suggestion.id == suggestion_id && suggestion.replacement_parts.is_some()
        }) {
            if suggestion.context_scope.as_deref()
                != Some(self.current_context_scope(binding, editor)?.as_str())
            {
                return Err(Error::new(
                    "context_stale",
                    "Complete manuscript context changed before committing the protected rewrite.",
                ));
            }
        }
        let maintenance_pending = self.persist_observed_cause(
            binding.guarded(true),
            file,
            document,
            &changed,
            &review,
            (
                None,
                Some(history::NativeCause::Acceptance {
                    suggestion_id: suggestion_id.into(),
                }),
                Some(editor),
            ),
        )?;
        let id = source_identity::rooted_document_id(
            binding.project,
            binding.path,
            binding.epoch,
            document.group.observation(),
        );
        let mut receipts = lock(&self.direct_edits)?;
        // One receipt per source, at most the session's manuscript sharing limit.
        if receipts.len() >= 20 && !receipts.contains_key(&id) {
            receipts.pop_first();
        }
        receipts.insert(
            id,
            Receipt {
                from: from_revision,
                to: review.revision.clone(),
            },
        );
        let suggestion = review
            .suggestions
            .iter()
            .find(|item| item.id == suggestion_id)
            .ok_or_else(|| Error::new("state", "The direct edit receipt is unavailable."))?;
        Ok(
            json!({"suggestion":suggestion,"manuscriptChanged":true,"revision":review.revision,"historyMaintenancePending":maintenance_pending}),
        )
    }
}

#[cfg(test)]
mod tests;
