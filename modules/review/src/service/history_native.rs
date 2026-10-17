//! Native saved-source History integration. Queries never recover or open source roots.
use super::*;
use history::{
    AppliedSource, Capture, HistoryReference, HistoryStore, NativeCause, ProducerCompletion,
    ProducerPhase, ProducerReservation, SourceSlot,
};
use std::time::{SystemTime, UNIX_EPOCH};

fn unavailable() -> Error {
    Error::new(
        "history_unavailable",
        "Saved History is unavailable. Existing data was preserved.",
    )
}
fn busy() -> Error {
    Error::new("busy", "An original saved-History operation is unresolved. Inspect that operation before changing this source.")
}

pub(super) fn anchor(registry: &Registry) -> Result<Option<Uuid>> {
    registry
        .history_store_id
        .as_deref()
        .map(|text| {
            Uuid::parse_str(text)
                .ok()
                .filter(|id| id.to_string() == text)
                .ok_or_else(unavailable)
        })
        .transpose()
}

pub(super) struct Producer {
    store: HistoryStore,
    binding: history::SourceBinding,
    slot: SourceSlot,
    reference: HistoryReference,
    journal_sha256: String,
    receipt_fingerprint: Option<String>,
    pub(super) applied: bool,
}
impl Producer {
    pub(super) fn abort_failed_unarmed(
        &mut self,
        service: &Service,
        document: &HeldDocument,
        book: &editor::EditorState,
    ) -> Result<()> {
        service.require_source_epoch(
            &self.binding.project_id,
            &self.binding.path,
            self.binding.source_epoch,
        )?;
        let group = &document.group;
        let slot = group.history_source_slot(&document.source)?;
        let reservation = self
            .store
            .producer_reservation(&self.binding, &slot)?
            .ok_or_else(unavailable)?;
        reservation.check_caller(&self.binding, &slot)?;
        if reservation.reference() != &self.reference
            || reservation.phase() != ProducerPhase::Unarmed
            || reservation.journal_sha256() != self.journal_sha256
            || reservation.receipt_fingerprint() != self.receipt_fingerprint.as_deref()
        {
            return Err(unavailable());
        }
        group.verify(Member::Source, document.source.expectation())?;
        group.verify(Member::Review, document.metadata.expectation())?;
        if document.journal.bytes().is_some() {
            return Err(busy());
        }
        group.retire_journal(document.journal.expectation())?;
        service.history_retire_unarmed_receipt(self.receipt_fingerprint.as_deref(), book)?;
        group.verify(Member::Source, document.source.expectation())?;
        group.verify(Member::Review, document.metadata.expectation())?;
        group.retire_journal(document.journal.expectation())?;
        self.store
            .abort_unapplied(&reservation, &self.binding, &slot)?;
        self.store.maintain()
    }

    pub(super) fn arm(&mut self, journal: &[u8]) -> Result<()> {
        let reservation = self
            .store
            .producer_reservation(&self.binding, &self.slot)?
            .ok_or_else(unavailable)?;
        if reservation.reference() != &self.reference {
            return Err(unavailable());
        }
        self.store
            .arm_source_effects(&reservation, &self.binding, &self.slot, journal)?;
        self.store
            .validate_journal(&self.reference, &self.binding, &self.slot, journal)
    }
    pub(super) fn finalize(
        &mut self,
        service: &Service,
        group: &SourceGroup,
        journal: &[u8],
        recovered: bool,
    ) -> Result<()> {
        let source = group.read_utf8(Member::Source, MAX_TEXT)?;
        let metadata = group.read_utf8(Member::Review, MAX_TEXT * 8)?;
        let ownership = service.history_verify_applied(&self.binding, group, &source, &metadata)?;
        let fresh_slot = group.history_source_slot(&source)?;
        let ownership_digest = digest(&serde_json::to_string(&ownership)?);
        self.store.finalize(
            &self.reference,
            &AppliedSource {
                binding: &self.binding,
                slot: &fresh_slot,
                content: source.text()?.ok_or_else(unavailable)?,
                review_bytes: metadata.bytes().ok_or_else(unavailable)?,
                ownership_digest: &ownership_digest,
            },
            journal,
            recovered,
        )?;
        Ok(())
    }
    // Source/receipt/Journal completion is already proved. Failure only retains a maintenance pin.
    pub(super) fn complete(&mut self) -> bool {
        self.store
            .complete(
                &self.reference,
                &self.binding,
                &self.slot,
                &ProducerCompletion {
                    journal_sha256: &self.journal_sha256,
                    committed_receipt_fingerprint: self.receipt_fingerprint.as_deref(),
                },
            )
            .and_then(|_| self.store.maintain())
            .is_err()
    }
}

impl Service {
    fn history_state(&self) -> Result<cap_std::fs::Dir> {
        project_tree::open_root(&self.state).map_err(|_| unavailable())
    }
    // Registry paths are approved native paths; this check never opens an old source root.
    fn history_check_overlap(&self) -> Result<()> {
        let registry = lock(&self.registry)?;
        if registry
            .projects
            .iter()
            .any(|p| p.root.starts_with(&self.state) || self.state.starts_with(&p.root))
        {
            return Err(Error::new("history_state_overlap", "Choose a project outside the application's private state before using saved History."));
        }
        Ok(())
    }
    fn history_open(&self) -> Result<Option<HistoryStore>> {
        let id = anchor(&*lock(&self.registry)?)?;
        HistoryStore::open(self.history_state()?, id)
    }
    fn history_producer_store(&self) -> Result<HistoryStore> {
        self.history_check_overlap()?;
        let mut registry = lock(&self.registry)?;
        if anchor(&registry)?.is_none() {
            let state = self.history_state()?;
            let id = HistoryStore::initialize_unanchored(&state)?;
            let mut next = registry.clone();
            next.history_store_id = Some(id.to_string());
            // An uncertain registry install is not adopted in memory; the same empty UUID is retryable.
            self.save_registry(&next)?;
            let exact = serde_json::to_string_pretty(&next)?;
            if read_text(&self.state.join("projects.json"), MAX_TEXT)? != exact {
                return Err(unavailable());
            }
            *registry = next;
        }
        let id = anchor(&registry)?;
        drop(registry);
        HistoryStore::open(self.history_state()?, id)?.ok_or_else(unavailable)
    }
    fn history_binding(binding: SourceBinding<'_>, group: &SourceGroup) -> history::SourceBinding {
        history::SourceBinding {
            project_id: binding.project.into(),
            root: group.observation(),
            path: binding.path.into(),
            source_epoch: binding.epoch,
        }
    }
    pub(super) fn history_writer_fence(
        &self,
        binding: SourceBinding<'_>,
        group: &SourceGroup,
        source: &ReadEntry,
        native_capture: bool,
    ) -> Result<()> {
        let store = if native_capture {
            Some(self.history_producer_store()?)
        } else {
            self.history_open()?
        };
        if let Some(store) = store {
            self.history_check_overlap()?;
            let slot = group.history_source_slot(source)?;
            if store
                .producer_reservation(&Self::history_binding(binding, group), &slot)?
                .is_some()
            {
                return Err(busy());
            }
        }
        Ok(())
    }
    pub(super) fn history_preflight_project(&self, project_id: &str) -> Result<()> {
        self.project(project_id)?;
        if let Some(store) = self.history_open()? {
            self.history_check_overlap()?;
            // shortcut: a reserved parent can move across approved roots; broad file-lifecycle/Git admission waits for all outstanding producers.
            if !store.producer_reservations()?.is_empty() {
                return Err(busy());
            }
        }
        Ok(())
    }
    pub(super) fn history_recover_empty_producer_init(&self) -> Result<()> {
        if anchor(&*lock(&self.registry)?)?.is_some() {
            return Ok(());
        }
        let state = self.history_state()?;
        match state.symlink_metadata("history-v1") {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(_) => Err(unavailable()),
            Ok(_) => self.history_producer_store().map(|_| ()),
        }
    }
    pub(super) fn history_prepare(
        &self,
        binding: SourceBinding<'_>,
        document: &HeldDocument,
        journal: &mut Journal,
        cause: NativeCause,
    ) -> Result<Producer> {
        // Called by native Save/acceptance or locally authorized direct prompt application.
        if !binding.guarded || binding.root != Some(document.group.observation()) {
            return Err(unavailable());
        }
        let mut store = self.history_producer_store()?;
        if binding.epoch == 0 {
            let mut registry = lock(&self.registry)?;
            if !registry
                .source_epochs
                .get(binding.project)
                .is_some_and(|paths| paths.contains_key(binding.path))
            {
                let mut next = registry.clone();
                next.source_epochs
                    .entry(binding.project.into())
                    .or_default()
                    .insert(binding.path.into(), 0);
                document.group.check_current()?;
                self.save_registry(&next)?;
                document.group.check_current()?;
                *registry = next;
            }
        }
        let source_binding = Self::history_binding(binding, &document.group);
        let slot = document.group.history_source_slot(&document.source)?;
        if store
            .producer_reservation(&source_binding, &slot)?
            .is_some()
        {
            return Err(busy());
        }
        let final_review = serde_json::to_string_pretty(&journal.review)?;
        let ownership = journal.ownership.as_ref().ok_or_else(unavailable)?;
        let intent = store.capture(
            Capture {
                binding: source_binding.clone(),
                slot: slot.clone(),
                cause,
                old_digest: journal.old_revision.clone(),
                final_review_digest: digest(&final_review),
                prior_review_digest: document.metadata.text()?.map(digest),
                ownership_digest: digest(&serde_json::to_string(ownership)?),
                receipt_fingerprint: journal
                    .editor_receipt
                    .as_ref()
                    .map(editor::SaveReceipt::history_fingerprint)
                    .transpose()?,
                captured_at_ms: SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .ok()
                    .and_then(|t| t.as_millis().try_into().ok()),
            },
            &journal.content,
        )?;
        let reference = intent.reference()?;
        journal.history = Some(reference.clone());
        let bytes = serde_json::to_vec_pretty(journal)?;
        store.prepare(&intent, &bytes)?;
        Ok(Producer {
            store,
            binding: source_binding,
            slot,
            reference,
            journal_sha256: digest(std::str::from_utf8(&bytes).map_err(|_| unavailable())?),
            receipt_fingerprint: journal
                .editor_receipt
                .as_ref()
                .map(editor::SaveReceipt::history_fingerprint)
                .transpose()?,
            applied: false,
        })
    }
    fn history_verify_applied(
        &self,
        binding: &history::SourceBinding,
        group: &SourceGroup,
        source: &ReadEntry,
        metadata: &ReadEntry,
    ) -> Result<journal_ownership::JournalOwnership> {
        let ownership = journal_ownership::JournalOwnership {
            project: binding.project_id.clone(),
            path: binding.path.clone(),
            source_epoch: binding.source_epoch,
            expected_root: Some(binding.root),
            owns_source: true,
        };
        self.require_source_epoch(&binding.project_id, &binding.path, binding.source_epoch)?;
        if group.observation() != binding.root {
            return Err(unavailable());
        }
        group.verify(Member::Source, source.expectation())?;
        group.verify(Member::Review, metadata.expectation())?;
        let content = source.text()?.ok_or_else(unavailable)?;
        let review = metadata.text()?.ok_or_else(unavailable)?;
        let approved = self.project(&binding.project_id)?;
        if !approved.pending.contains(&binding.path)
            || approved.pending_revisions.get(&binding.path) != Some(&digest(content))
        {
            return Err(unavailable());
        }
        let sidecar = format!("{}.undertree-review.json", binding.path);
        if !approved.pending.contains(&sidecar)
            || approved.pending_revisions.get(&sidecar) != Some(&digest(review))
        {
            return Err(unavailable());
        }
        self.check_policy_continuity(&approved.root.join(&binding.path), Some(review))?;
        group.check_current()?;
        Ok(ownership)
    }
    // Return the original armed producer for Journal recovery, or a cleanup-only saved flag.
    pub(super) fn history_recovery(
        &self,
        binding: SourceBinding<'_>,
        group: &SourceGroup,
        observed: (&ReadEntry, &ReadEntry),
        journal_entry: &mut ReadEntry,
        journal: Option<&Journal>,
        native_book: Option<&editor::EditorState>,
    ) -> Result<(Option<Producer>, bool)> {
        let (source, metadata) = observed;
        let Some(mut store) = self.history_open()? else {
            if journal.and_then(|j| j.history.as_ref()).is_some() {
                return Err(unavailable());
            }
            return Ok((None, false));
        };
        self.history_check_overlap()?;
        let current_binding = Self::history_binding(binding, group);
        let slot = group.history_source_slot(source)?;
        let Some(reservation) = store.producer_reservation(&current_binding, &slot)? else {
            if journal.and_then(|j| j.history.as_ref()).is_some() {
                return Err(unavailable());
            }
            return Ok((None, false));
        };
        if reservation.binding() != &current_binding {
            return Err(busy());
        }
        reservation
            .check_caller(&current_binding, &slot)
            .map_err(|_| busy())?;
        match reservation.phase() {
            ProducerPhase::Unarmed if journal.is_none() => {
                let book = native_book.ok_or_else(busy)?;
                group.retire_journal(journal_entry.expectation())?;
                self.history_retire_unarmed_receipt(reservation.receipt_fingerprint(), book)?;
                group.retire_journal(journal_entry.expectation())?;
                store.abort_unapplied(&reservation, &current_binding, &slot)?;
                store.maintain()?;
                Ok((None, false))
            }
            ProducerPhase::AbortedPendingMaintenance if journal.is_none() => {
                let book = native_book.ok_or_else(busy)?;
                group.retire_journal(journal_entry.expectation())?;
                self.history_retire_unarmed_receipt(reservation.receipt_fingerprint(), book)?;
                group.retire_journal(journal_entry.expectation())?;
                store.maintain()?;
                Ok((None, false))
            }
            ProducerPhase::CommittedPinned if journal.is_none() => {
                let ownership = self.history_verify_applied(&current_binding, group, source, metadata)?;
                let ownership_digest = digest(&serde_json::to_string(&ownership)?);
                store.validate_committed_applied(&reservation, &AppliedSource { binding: &current_binding, slot: &slot, content: source.text()?.ok_or_else(unavailable)?, review_bytes: metadata.bytes().ok_or_else(unavailable)?, ownership_digest: &ownership_digest })?;
                if let Some(fp) = reservation.receipt_fingerprint() { self.history_confirm_committed_fingerprint(fp)?; }
                group.retire_journal(journal_entry.expectation())?;
                let mut producer = Self::history_existing_producer(store, current_binding, slot, reservation);
                Ok((None, producer.complete()))
            }
            ProducerPhase::Armed if journal.is_none() => Err(Error::new("outcome_unknown", "An armed saved-History operation lost its Journal. Its original event and source were preserved.")),
            ProducerPhase::AbortedPendingMaintenance => Err(busy()),
            _ => {
                let journal = journal.ok_or_else(busy)?;
                let reference = journal.history.as_ref().ok_or_else(busy)?;
                let raw = journal_entry.bytes().ok_or_else(unavailable)?.to_vec();
                if reference != reservation.reference() || digest(std::str::from_utf8(&raw).map_err(|_| unavailable())?) != reservation.journal_sha256() { return Err(unavailable()); }
                // All existing ownership/policy validation happens before this helper is invoked.
                if reservation.phase() == ProducerPhase::Unarmed {
                    native_book.ok_or_else(busy)?;
                    if let Some(receipt) = &journal.editor_receipt { self.history_confirm_pending(receipt)?; }
                    let expected = replaced(group.replace(Member::Journal, journal_entry.expectation(), &raw, MAX_TEXT * 9, &[(Member::Source, source.expectation()), (Member::Review, metadata.expectation())])?)?;
                    group.verify(Member::Journal, &expected)?;
                    let reread = group.read_bytes(Member::Journal, MAX_TEXT * 9)?;
                    if reread.expectation() != &expected || reread.bytes() != Some(raw.as_slice()) { return Err(unavailable()); }
                    *journal_entry = reread;
                    store.arm_source_effects(&reservation, &current_binding, &slot, &raw)?;
                }
                store.validate_journal(reference, &current_binding, &slot, &raw)?;
                if reservation.phase() == ProducerPhase::CommittedPinned {
                    self.history_verify_applied(&current_binding, group, source, metadata)?;
                    if source.text()? != Some(journal.content.as_str()) || metadata.text()? != Some(serde_json::to_string_pretty(&journal.review)?.as_str()) { return Err(unavailable()); }
                }
                Ok((Some(Self::history_existing_producer(store, current_binding, slot, reservation)), false))
            }
        }
    }
    fn history_existing_producer(
        store: HistoryStore,
        binding: history::SourceBinding,
        slot: SourceSlot,
        reservation: ProducerReservation,
    ) -> Producer {
        Producer {
            store,
            binding,
            slot,
            reference: reservation.reference().clone(),
            journal_sha256: reservation.journal_sha256().into(),
            receipt_fingerprint: reservation.receipt_fingerprint().map(str::to_owned),
            applied: reservation.phase() == ProducerPhase::CommittedPinned,
        }
    }
    pub async fn history_query_native(
        self: &Arc<Self>,
        window_label: &str,
        owner_id: &str,
        query: HistoryQuery,
    ) -> Result<HistoryReply> {
        self.native_editor_owner(window_label, owner_id)?;
        let service = Arc::clone(self);
        let window = window_label.to_owned();
        let owner = owner_id.to_owned();
        let reply = tokio::task::spawn_blocking(move || {
            let identity = (window, owner);
            let _guard = service.source_effect_guard(Some(&identity))?;
            service.history_check_overlap()?;
            let project = match &query { HistoryQuery::List { project_id, .. } | HistoryQuery::Read { project_id, .. } | HistoryQuery::Compare { project_id, .. } => project_id };
            if !lock(&service.registry)?.projects.iter().any(|entry| entry.id == *project) {
                return Err(Error::new("project", "Choose an approved project."));
            }
            service.history_open()?.ok_or_else(|| Error::new("history_not_initialized", "Saved History starts with a successful native source-changing Save or accepted suggestion."))?.query(query)
        }).await.map_err(|_| unavailable())??;
        self.native_editor_owner(window_label, owner_id)?;
        Ok(reply)
    }
}

#[cfg(test)]
mod tests;
