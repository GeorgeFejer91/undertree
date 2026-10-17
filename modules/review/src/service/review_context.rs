//! Saved manuscript context, explicit path consent and native read-before-proposal receipts.
use super::*;
use std::time::{Duration, Instant};

const MAX_CONTEXT_BYTES: usize = 1024 * 1024;
const MAX_RECEIPTS: usize = 64;

#[derive(Clone)]
pub(super) struct Grant {
    generation: String,
    main: String,
    paths: BTreeSet<String>,
    consent_scope: String,
    witnesses: Vec<Witness>,
}

#[derive(Clone, PartialEq, Eq)]
struct Witness {
    path: String,
    epoch: u64,
    source: source_files::Expectation,
    policy: String,
}

struct Receipt {
    document: String,
    generation: String,
    scope: String,
    witnesses: Vec<Witness>,
    issued: Instant,
}

struct HighlightReceipt {
    document: String,
    generation: String,
    fingerprint: String,
    scope: String,
    witnesses: Vec<Witness>,
    result: Option<Value>,
}

#[derive(Default)]
pub(super) struct ContextState {
    grants: BTreeMap<String, Grant>,
    receipts: BTreeMap<String, Receipt>,
    highlights: BTreeMap<(String, String), HighlightReceipt>,
}

impl ContextState {
    pub(super) fn commit_grant(&mut self, id: &str, grant: Grant, current: &BTreeSet<String>) {
        self.grants.retain(|document, _| current.contains(document));
        self.receipts.retain(|_, receipt| receipt.document != id);
        self.highlights
            .retain(|_, receipt| current.contains(&receipt.document) && receipt.document != id);
        self.grants.insert(id.into(), grant);
    }
}

struct Capture {
    scope: String,
    main: String,
    paths: BTreeSet<String>,
    files: Vec<Value>,
    witnesses: Vec<Witness>,
}

impl Service {
    fn context_policy_digest(review: &Review) -> Result<String> {
        Ok(digest(&serde_json::to_string(
            &json!({"rules":review.rules,"markers":review.markers,"pdfAnnotations":review.pdf_annotations}),
        )?))
    }
    fn capture_review_context(
        &self,
        binding: SourceBinding<'_>,
        editor: &editor::EditorState,
    ) -> Result<Capture> {
        let project = self.project(binding.project)?;
        let root = binding.root.unwrap_or(RootedRoot::observe(&project.root)?);
        self.require_source_epoch(binding.project, binding.path, binding.epoch)?;
        let held_root = RootedRoot::acquire(&project.root, &root)?;
        let (main, paths) = project_tree::context_paths(&held_root, &project, binding.path)?;
        #[cfg(test)]
        if let Some(hook) = lock(&self.context_after_discovery)?.take() {
            hook()?;
        }
        let mut documents = Vec::new();
        let mut files = Vec::new();
        let mut witnesses = Vec::new();
        let mut total = 0;
        for path in &paths {
            let epoch = self.source_epoch(binding.project, path)?;
            let source_binding =
                SourceBinding::new(binding.project, path, epoch).rooted(Some(root));
            let file = self.path(&project, path, false)?;
            let document = self.held_document(source_binding, &file, false)?;
            total += document.content.len();
            if total > MAX_CONTEXT_BYTES {
                return Err(Error::new("context_limit", "Complete manuscript context exceeds the bounded review limit. No read receipt was issued."));
            }
            editor.check_remote_edit(source_binding, &digest(&document.content))
                .map_err(|_| Error::new("context_draft", "Save or resolve every manuscript context buffer explicitly before sharing or reading saved context. No draft was saved."))?;
            if (path.ends_with(".html") || path.ends_with(".htm"))
                && ["<iframe", "<object", "<embed", "<script"]
                    .iter()
                    .any(|tag| document.content.to_ascii_lowercase().contains(tag))
            {
                return Err(Error::new("context_incomplete", "HTML with executable or embedded document context is not a complete self-contained manuscript."));
            }
            let policy = Self::context_policy_digest(&document.review)?;
            witnesses.push(Witness {
                path: path.clone(),
                epoch,
                source: document.source.expectation().clone(),
                policy: policy.clone(),
            });
            files.push(json!({"path":path,"revision":digest(&document.content),"sourceEpoch":epoch,"content":document.content,"editable":path == binding.path}));
            documents.push(document);
        }
        // Bind dependency discovery to the held source observations: a source may have changed
        // after the first graph walk but before its held read, introducing an omitted chapter.
        let current_graph = project_tree::context_paths(&held_root, &project, binding.path)?;
        if current_graph.0 != main || current_graph.1 != paths {
            return Err(Error::new("context_scope", "The manuscript dependency scope changed while context was collected. Preview and share its complete scope again."));
        }
        // All held observations must still agree after the final graph walk.
        for document in &documents {
            document
                .group
                .verify(Member::Source, document.source.expectation())?;
            document
                .group
                .verify(Member::Review, document.metadata.expectation())?;
            document
                .group
                .verify(Member::Journal, document.journal.expectation())?;
        }
        held_root.check_current()?;
        let manifest: Vec<_> = files.iter().zip(&witnesses).map(|(file,witness)| json!({"path":file["path"],"revision":file["revision"],"sourceEpoch":witness.epoch,"policy":witness.policy})).collect();
        let scope = digest(&serde_json::to_string(
            &json!({"project":binding.project,"active":binding.path,"epoch":binding.epoch,"root":root,"main":main,"files":manifest}),
        )?);
        Ok(Capture {
            scope,
            main,
            paths,
            files,
            witnesses,
        })
    }

    pub(super) fn context_preview(
        &self,
        binding: SourceBinding<'_>,
        editor: &editor::EditorState,
    ) -> Result<Value> {
        let capture = self.capture_review_context(binding, editor)?;
        let files: Vec<_> = capture.files.iter().map(|file| json!({"path":file["path"],"revision":file["revision"],"sourceEpoch":file["sourceEpoch"]})).collect();
        Ok(
            json!({"scopeId":capture.scope,"main":capture.main,"files":files,"snapshot":"saved","complete":true}),
        )
    }

    pub(super) fn prepare_context_consent(
        &self,
        binding: SourceBinding<'_>,
        expected: Option<&str>,
        editor: &editor::EditorState,
    ) -> Result<Grant> {
        let capture = self.capture_review_context(binding, editor)?;
        if expected != Some(capture.scope.as_str()) {
            return Err(Error::new("context_scope", "Preview and explicitly approve the current complete manuscript context before sharing. The scope changed or consent is missing."));
        }
        Ok(Grant {
            generation: Uuid::new_v4().to_string(),
            main: capture.main,
            paths: capture.paths,
            consent_scope: capture.scope,
            witnesses: capture.witnesses,
        })
    }

    pub(super) fn check_context_consent(
        &self,
        binding: SourceBinding<'_>,
        grant: &Grant,
        editor: &editor::EditorState,
    ) -> Result<()> {
        let capture = self.capture_review_context(binding, editor)?;
        if capture.scope != grant.consent_scope || capture.witnesses != grant.witnesses {
            return Err(Error::new(
                "context_scope",
                "The reviewed context changed before sharing. Preview and approve it again.",
            ));
        }
        Ok(())
    }

    pub(super) fn revoke_review_context(&self, id: &str) -> Result<()> {
        let mut state = lock(&self.review_context)?;
        state.grants.remove(id);
        state.receipts.retain(|_, receipt| receipt.document != id);
        state.highlights.retain(|_, receipt| receipt.document != id);
        Ok(())
    }

    fn granted_capture(
        &self,
        id: &str,
        binding: SourceBinding<'_>,
        editor: &editor::EditorState,
    ) -> Result<(Grant, Capture)> {
        let grant = lock(&self.review_context)?
            .grants
            .get(id)
            .cloned()
            .ok_or_else(|| {
                Error::new(
                    "context_consent",
                    "The complete manuscript context has not been explicitly shared locally.",
                )
            })?;
        let capture = self.capture_review_context(binding, editor)?;
        if grant.main != capture.main || grant.paths != capture.paths {
            return Err(Error::new("context_scope", "The manuscript now needs different context files. Preview and approve its new scope locally."));
        }
        Ok((grant, capture))
    }

    pub(super) fn read_review_context(
        &self,
        id: &str,
        binding: SourceBinding<'_>,
        editor: &editor::EditorState,
        document: &HeldDocument,
        mut value: Value,
    ) -> Result<Value> {
        let (grant, capture) = self.granted_capture(id, binding, editor)?;
        let witness = capture
            .witnesses
            .iter()
            .find(|item| item.path == binding.path)
            .ok_or_else(|| {
                Error::new(
                    "context_incomplete",
                    "The active source is absent from manuscript context.",
                )
            })?;
        if witness.source != *document.source.expectation()
            || witness.policy != Self::context_policy_digest(&document.review)?
        {
            return Err(Error::new(
                "context_stale",
                "The active source changed during context retrieval. Read complete context again.",
            ));
        }
        let context_id = Uuid::new_v4().to_string();
        value["contextId"] = json!(context_id);
        value["revision"] = value["review"]["revision"].clone();
        value["snapshot"] = json!("saved");
        value["context"] = json!({"complete":true,"main":capture.main,"files":capture.files});
        crate::transport::check_context_wire_size(&value)?;
        let mut state = lock(&self.review_context)?;
        state
            .receipts
            .retain(|_, receipt| receipt.issued.elapsed() < Duration::from_secs(900));
        if state.receipts.len() >= MAX_RECEIPTS {
            state.receipts.pop_first();
        }
        state.receipts.insert(
            context_id,
            Receipt {
                document: id.into(),
                generation: grant.generation,
                scope: capture.scope,
                witnesses: capture.witnesses,
                issued: Instant::now(),
            },
        );
        Ok(value)
    }

    pub(super) fn require_review_context(
        &self,
        id: &str,
        binding: SourceBinding<'_>,
        context_id: Option<&str>,
        editor: &editor::EditorState,
    ) -> Result<()> {
        let token = context_id.ok_or_else(|| {
            Error::new(
                "context_required",
                "Read the complete manuscript context before submitting any highlighted change.",
            )
        })?;
        let (grant, capture) = self.granted_capture(id, binding, editor)?;
        let state = lock(&self.review_context)?;
        let receipt = state.receipts.get(token).ok_or_else(|| Error::new("context_required", "This context read receipt is missing or expired. Read the complete manuscript again."))?;
        if receipt.document != id
            || receipt.generation != grant.generation
            || receipt.scope != capture.scope
            || receipt.witnesses != capture.witnesses
            || receipt.issued.elapsed() >= Duration::from_secs(900)
        {
            return Err(Error::new("context_stale", "Manuscript source, policy, identity or sharing changed after the context read. Read complete context again."));
        }
        Ok(())
    }

    pub(super) fn current_context_scope(
        &self,
        binding: SourceBinding<'_>,
        editor: &editor::EditorState,
    ) -> Result<String> {
        Ok(self.capture_review_context(binding, editor)?.scope)
    }

    pub(super) fn replay_highlighting(
        &self,
        id: &str,
        binding: SourceBinding<'_>,
        request: &str,
        fingerprint: &str,
        editor: &editor::EditorState,
    ) -> Result<Option<Value>> {
        let (grant, capture) = self.granted_capture(id, binding, editor)?;
        let state = lock(&self.review_context)?;
        if let Some(receipt) = state.highlights.get(&(id.into(), request.into())) {
            if receipt.fingerprint != fingerprint {
                return Err(Error::new(
                    "duplicate",
                    "That request ID already identifies a different marking.",
                ));
            }
            let result = receipt.result.as_ref().ok_or_else(|| Error::new("outcome_unknown", "This marking was reserved and may have committed. Inspect current highlights locally before making another marking request."))?;
            if receipt.generation != grant.generation
                || receipt.scope != capture.scope
                || receipt.witnesses != capture.witnesses
            {
                return Err(Error::new(
                    "context_stale",
                    "Source, neutral color policy or sharing changed after this marking.",
                ));
            }
            return Ok(Some(result.clone()));
        }
        if state.highlights.len() >= 128 {
            return Err(Error::new("limit", "This session has reached its marking receipt limit. Revoke and explicitly share again before further marking."));
        }
        Ok(None)
    }

    pub(super) fn record_highlighting(
        &self,
        id: &str,
        binding: SourceBinding<'_>,
        request: &str,
        fingerprint: String,
        result: Value,
        editor: &editor::EditorState,
    ) -> Result<()> {
        let (grant, capture) = self.granted_capture(id, binding, editor)?;
        let mut state = lock(&self.review_context)?;
        let receipt = state
            .highlights
            .get_mut(&(id.into(), request.into()))
            .ok_or_else(|| {
                Error::new(
                    "outcome_unknown",
                    "This marking reservation was revoked before its acknowledgement.",
                )
            })?;
        if receipt.fingerprint != fingerprint || receipt.generation != grant.generation {
            return Err(Error::new(
                "outcome_unknown",
                "The marking reservation no longer matches this grant.",
            ));
        }
        receipt.scope = capture.scope;
        receipt.witnesses = capture.witnesses;
        receipt.result = Some(result);
        Ok(())
    }

    pub(super) fn reserve_highlighting(
        &self,
        id: &str,
        request: &str,
        fingerprint: &str,
    ) -> Result<()> {
        let mut state = lock(&self.review_context)?;
        let generation = state
            .grants
            .get(id)
            .ok_or_else(|| Error::new("context_consent", "The manuscript share was revoked."))?
            .generation
            .clone();
        let key = (id.into(), request.into());
        if state.highlights.contains_key(&key) || state.highlights.len() >= 128 {
            return Err(Error::new("duplicate", "This marking request is already reserved or the session receipt bound was reached."));
        }
        state.highlights.insert(
            key,
            HighlightReceipt {
                document: id.into(),
                generation,
                fingerprint: fingerprint.into(),
                scope: String::new(),
                witnesses: vec![],
                result: None,
            },
        );
        Ok(())
    }
}

#[cfg(test)]
mod tests;
