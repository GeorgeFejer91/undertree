//! Private UI coordination. These operations are never part of the CLI or MCP catalogue.
use super::*;
use cap_fs_ext::{DirExt, FollowSymlinks, MetadataExt, OpenOptionsFollowExt, OpenOptionsSyncExt};
use cap_std::fs::{Dir, OpenOptions};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

const PROTOCOL_VERSION: u32 = 1;
const MAX_SESSIONS: usize = 64;
const MAX_REQUESTS: usize = 64;
const MAX_RECEIPTS: usize = 1024;
const LEASE_MS: u64 = 30_000;
const REQUEST_MS: u64 = 25_000;
const MAX_GENERATION: u64 = 9_007_199_254_740_991;

#[derive(Debug, Deserialize)]
#[serde(
    tag = "action",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum EditorOperation {
    EditorRegister {
        project: String,
        path: String,
        #[serde(default)]
        source_epoch: u64,
        #[serde(default, deserialize_with = "crate::root_observation::optional")]
        expected_root: Option<RootObservation>,
        generation: u64,
        revision: String,
        content_digest: String,
        dirty: bool,
        composing: bool,
        conflict: bool,
    },
    EditorUpdate {
        session_id: String,
        generation: u64,
        revision: String,
        content_digest: String,
        dirty: bool,
        composing: bool,
        conflict: bool,
    },
    EditorUnregister {
        session_id: String,
    },
    EditorPoll {},
    EditorCommit {
        request_id: String,
        ticket: String,
        session_id: String,
        generation: u64,
        revision: String,
        content: String,
    },
    EditorComplete {
        request_id: String,
        ticket: String,
        session_id: String,
        status: BufferResult,
        generation: u64,
    },
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn native_page_epoch_rejects_delayed_registration_and_preserves_receipts() {
        let (_temp, service, project, _file) = fixture();
        let connect = service.connect_native_editor("main").unwrap();
        let first = connect["ownerId"].as_str().unwrap();
        let owner = service.native_editor_owner("main", first).unwrap();
        let register = || EditorOperation::EditorRegister {
            project: project.id.clone(),
            path: "main.typ".into(),
            source_epoch: 0,
            expected_root: None,
            generation: 0,
            revision: digest("Original"),
            content_digest: digest("Original"),
            dirty: false,
            composing: false,
            conflict: false,
        };
        let session = service.editor_local(&owner, register()).unwrap()["sessionId"]
            .as_str()
            .unwrap()
            .to_owned();
        let id = Uuid::new_v4().to_string();
        lock(&service.editor).unwrap().requests.insert(
            id.clone(),
            Request {
                owner: owner.clone(),
                ticket: Uuid::new_v4().to_string(),
                session_id: session,
                project: project.id.clone(),
                path: "main.typ".into(),
                source_epoch: 0,
                expected_root: Some(RootedRoot::observe(&project.root).unwrap()),
                expires_at: now_ms() + REQUEST_MS,
            },
        );
        let receipt = pending(&service, &project);
        service.write_editor_receipt(&receipt).unwrap();
        service.write_committed_receipt(&receipt).unwrap();
        let next = service.connect_native_editor("main").unwrap();
        assert_ne!(next["ownerId"], connect["ownerId"]);
        assert_eq!(
            service.native_editor_owner("main", first).unwrap_err().code,
            "stale_session"
        );
        assert_eq!(
            service
                .native_editor_owner("other", next["ownerId"].as_str().unwrap())
                .unwrap_err()
                .code,
            "stale_session"
        );
        assert_eq!(
            service.editor_local(&owner, register()).unwrap_err().code,
            "stale_session"
        );
        assert!(lock(&service.editor).unwrap().sessions.is_empty());
        assert_eq!(
            service.read_editor_receipt(&id).unwrap().unwrap().status,
            "rejected"
        );
        assert_eq!(
            service
                .read_editor_receipt(&receipt.request_id)
                .unwrap()
                .unwrap()
                .status,
            "committed"
        );
        let current = service
            .native_editor_owner("main", next["ownerId"].as_str().unwrap())
            .unwrap();
        service.editor_local(&current, register()).unwrap();
    }

    #[test]
    fn editor_callbacks_and_cli_saves_reject_authority_or_replacement_fields() {
        assert!(serde_json::from_value::<EditorOperation>(
            json!({"action":"editor_poll","owner":"native:main"})
        )
        .is_err());
        assert!(serde_json::from_value::<Operation>(json!({"action":"save_editor","project":"approved","path":"main.typ","requestId":Uuid::new_v4().to_string(),"content":"replacement"})).is_err());
        assert!(serde_json::from_value::<Operation>(json!({"action":"editor_poll"})).is_err());
    }

    fn fixture() -> (tempfile::TempDir, Arc<Service>, Project, PathBuf) {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("project");
        fs::create_dir(&root).unwrap();
        let file = root.join("main.typ");
        fs::write(&file, "Original").unwrap();
        let service = Service::new(temp.path().join("state")).unwrap();
        let project: Project = serde_json::from_value(
            service
                .local(Operation::AddProject {
                    root: root.to_string_lossy().into(),
                })
                .unwrap(),
        )
        .unwrap();
        (temp, service, project, file)
    }
    fn pending(service: &Service, project: &Project) -> SaveReceipt {
        SaveReceipt {
            protocol_version: PROTOCOL_VERSION,
            request_id: Uuid::new_v4().to_string(),
            instance_id: service.instance_id.clone(),
            project: project.id.clone(),
            path: "main.typ".into(),
            source_epoch: 0,
            expected_root: None,
            session_id: Uuid::new_v4().to_string(),
            status: "pending".into(),
            saved_generation: Some(3),
            saved_revision: Some(digest("Captured")),
            buffer_status: "unconfirmed".into(),
            error: None,
            commit_fingerprint: digest("capture fingerprint"),
        }
    }

    #[test]
    fn interrupted_editor_journal_recovers_source_registry_and_receipt() {
        for phase in 0..3 {
            let (temp, service, project, file) = fixture();
            let receipt = pending(&service, &project);
            service.write_editor_receipt(&receipt).unwrap();
            let journal = Journal {
                old_revision: digest("Original"),
                content: "Captured".into(),
                review: Review::new("Captured"),
                editor_receipt: Some(receipt.clone()),
                prior_review: None,
                ownership: None,
                history: None,
            };
            atomic_write(
                &journal_path(&file),
                &serde_json::to_vec_pretty(&journal).unwrap(),
            )
            .unwrap();
            if phase >= 1 {
                fs::write(&file, "Captured").unwrap();
            }
            if phase >= 2 {
                fs::write(
                    sidecar(&file),
                    serde_json::to_vec_pretty(&journal.review).unwrap(),
                )
                .unwrap();
            }
            drop(service);
            let restarted = Service::new(temp.path().join("state")).unwrap();
            let result = restarted.editor_save_receipt(&receipt.request_id).unwrap();
            assert_eq!(result["status"], "committed");
            assert_eq!(result["bufferStatus"], "unconfirmed");
            assert_eq!(fs::read_to_string(&file).unwrap(), "Captured");
            assert!(!journal_path(&file).exists());
            assert_eq!(
                restarted.project(&project.id).unwrap().pending_revisions["main.typ"],
                digest("Captured")
            );
        }
    }

    #[test]
    fn malformed_editor_receipt_is_rejected_before_source_or_sidecar_recovery() {
        let (_temp, service, project, file) = fixture();
        let mut receipt = pending(&service, &project);
        receipt.saved_revision = Some(digest("Different"));
        let journal = Journal {
            old_revision: digest("Original"),
            content: "Captured".into(),
            review: Review::new("Captured"),
            editor_receipt: Some(receipt),
            prior_review: None,
            ownership: None,
            history: None,
        };
        let bytes = serde_json::to_vec(&journal).unwrap();
        fs::write(journal_path(&file), &bytes).unwrap();
        assert_eq!(
            service
                .read_document(&project, "main.typ", &file)
                .unwrap_err()
                .code,
            "recovery_conflict"
        );
        assert_eq!(fs::read_to_string(&file).unwrap(), "Original");
        assert!(!sidecar(&file).exists());
        assert_eq!(fs::read(journal_path(&file)).unwrap(), bytes);
    }

    #[test]
    fn uncertain_intent_without_journal_never_fabricates_success() {
        let (_temp, service, project, file) = fixture();
        let receipt = pending(&service, &project);
        service.write_editor_receipt(&receipt).unwrap();
        assert_eq!(
            service.editor_save_receipt(&receipt.request_id).unwrap()["status"],
            "pending"
        );
        assert_eq!(fs::read_to_string(file).unwrap(), "Original");
    }

    #[test]
    fn expired_tickets_and_receipt_capacity_preserve_source() {
        let (_temp, service, project, file) = fixture();
        let owner = "native:main";
        let registration = service
            .editor_local(
                owner,
                EditorOperation::EditorRegister {
                    project: project.id.clone(),
                    path: "main.typ".into(),
                    source_epoch: 0,
                    expected_root: None,
                    generation: 1,
                    revision: digest("Original"),
                    content_digest: digest("Captured"),
                    dirty: true,
                    composing: false,
                    conflict: false,
                },
            )
            .unwrap();
        let session = registration["sessionId"].as_str().unwrap().to_owned();
        let id = Uuid::new_v4().to_string();
        let ticket = Uuid::new_v4().to_string();
        lock(&service.editor).unwrap().requests.insert(
            id.clone(),
            Request {
                owner: owner.into(),
                ticket: ticket.clone(),
                session_id: session.clone(),
                project: project.id.clone(),
                path: "main.typ".into(),
                source_epoch: 0,
                expected_root: Some(RootedRoot::observe(&project.root).unwrap()),
                expires_at: now_ms() - 1,
            },
        );
        let operation = || EditorOperation::EditorCommit {
            request_id: id.clone(),
            ticket: ticket.clone(),
            session_id: session.clone(),
            generation: 1,
            revision: digest("Original"),
            content: "Captured".into(),
        };
        assert_eq!(
            service.editor_local(owner, operation()).unwrap_err().code,
            "expired_ticket"
        );
        lock(&service.editor)
            .unwrap()
            .requests
            .get_mut(&id)
            .unwrap()
            .expires_at = now_ms() + REQUEST_MS;
        let directory = service.state.join("editor-saves");
        fs::create_dir(&directory).unwrap();
        for index in 0..MAX_RECEIPTS {
            fs::write(directory.join(format!("preserved-{index}")), b"evidence").unwrap();
        }
        assert_eq!(
            service.editor_local(owner, operation()).unwrap_err().code,
            "limit"
        );
        assert_eq!(fs::read_to_string(file).unwrap(), "Original");
        assert_eq!(fs::read_dir(directory).unwrap().count(), MAX_RECEIPTS);
    }

    #[tokio::test]
    async fn stale_lease_and_full_queue_cannot_fall_back_to_disk() {
        let (_temp, service, project, file) = fixture();
        let owner = "native:main";
        let registration = service
            .editor_local(
                owner,
                EditorOperation::EditorRegister {
                    project: project.id.clone(),
                    path: "main.typ".into(),
                    source_epoch: 0,
                    expected_root: None,
                    generation: 0,
                    revision: digest("Original"),
                    content_digest: digest("Original"),
                    dirty: false,
                    composing: false,
                    conflict: false,
                },
            )
            .unwrap();
        let session = registration["sessionId"].as_str().unwrap().to_owned();
        lock(&service.editor)
            .unwrap()
            .sessions
            .get_mut(&session)
            .unwrap()
            .seen_at = 0;
        assert_eq!(
            service
                .request_editor_save(&project.id, "main.typ", &Uuid::new_v4().to_string())
                .await
                .unwrap_err()
                .code,
            "ui_unavailable"
        );
        service
            .editor_local(owner, EditorOperation::EditorPoll {})
            .unwrap();
        for index in 0..MAX_REQUESTS {
            lock(&service.editor).unwrap().requests.insert(
                format!("request-{index}"),
                Request {
                    owner: owner.into(),
                    ticket: Uuid::new_v4().to_string(),
                    session_id: format!("other-{index}"),
                    project: project.id.clone(),
                    path: "other.typ".into(),
                    source_epoch: 0,
                    expected_root: None,
                    expires_at: now_ms() + REQUEST_MS,
                },
            );
        }
        assert_eq!(
            service
                .request_editor_save(&project.id, "main.typ", &Uuid::new_v4().to_string())
                .await
                .unwrap_err()
                .code,
            "busy"
        );
        assert_eq!(fs::read_to_string(file).unwrap(), "Original");
    }
    #[test]
    fn nonzero_editor_producer_recovers_exact_binding_and_cannot_replay_into_retired_identity() {
        let (_temp, service, project, file) = fixture();
        service
            .retire_source_for_test(&project.id, "main.typ")
            .unwrap();
        let owner = "native:main";
        let registration = service
            .editor_local(
                owner,
                EditorOperation::EditorRegister {
                    project: project.id.clone(),
                    path: "main.typ".into(),
                    source_epoch: 1,
                    expected_root: None,
                    generation: 3,
                    revision: digest("Original"),
                    content_digest: digest("Captured"),
                    dirty: true,
                    composing: false,
                    conflict: false,
                },
            )
            .unwrap();
        assert_eq!(registration["sourceEpoch"], 1);
        let session = registration["sessionId"].as_str().unwrap().to_owned();
        let id = Uuid::new_v4().to_string();
        let ticket = Uuid::new_v4().to_string();
        lock(&service.editor).unwrap().requests.insert(
            id.clone(),
            Request {
                owner: owner.into(),
                ticket: ticket.clone(),
                session_id: session.clone(),
                project: project.id.clone(),
                path: "main.typ".into(),
                source_epoch: 1,
                expected_root: Some(RootedRoot::observe(&project.root).unwrap()),
                expires_at: now_ms() + REQUEST_MS,
            },
        );
        let commit = || EditorOperation::EditorCommit {
            request_id: id.clone(),
            ticket: ticket.clone(),
            session_id: session.clone(),
            generation: 3,
            revision: digest("Original"),
            content: "Captured".into(),
        };
        *lock(&service.fail_after_journal).unwrap() = true;
        assert_eq!(
            service.editor_local(owner, commit()).unwrap_err().code,
            "outcome_unknown"
        );
        let journal: Value =
            serde_json::from_slice(&fs::read(journal_path(&file)).unwrap()).unwrap();
        assert_eq!(journal["ownership"]["source_epoch"], 1);
        assert_eq!(journal["editor_receipt"]["sourceEpoch"], 1);
        let recovered = service.editor_save_receipt(&id).unwrap();
        assert_eq!(recovered["sourceEpoch"], 1);
        assert_eq!(recovered["status"], "committed");
        assert_eq!(fs::read(&file).unwrap(), b"Captured");
        assert!(!journal_path(&file).exists());
        let receipt_bytes = fs::read(service.receipt_path(&id).unwrap()).unwrap();
        let policy_bytes = fs::read(sidecar(&file)).unwrap();
        service
            .retire_source_for_test(&project.id, "main.typ")
            .unwrap();
        assert_eq!(
            service.editor_local(owner, commit()).unwrap_err().code,
            "stale_document"
        );
        assert_eq!(service.editor_save_receipt(&id).unwrap()["sourceEpoch"], 1);
        assert_eq!(
            fs::read(service.receipt_path(&id).unwrap()).unwrap(),
            receipt_bytes
        );
        assert_eq!(fs::read(sidecar(&file)).unwrap(), policy_bytes);
        assert_eq!(fs::read(&file).unwrap(), b"Captured");
    }
    #[test]
    fn history_receipt_fingerprint_binds_identity_but_not_outcome_or_buffer_acknowledgement() {
        let (_temp, service, project, _file) = fixture();
        let receipt = pending(&service, &project);
        let fingerprint = receipt.history_fingerprint().unwrap();
        let mut acknowledged = receipt.clone();
        acknowledged.status = "committed".into();
        acknowledged.buffer_status = "newer_buffer".into();
        assert!(acknowledged.history_committed());
        assert_eq!(acknowledged.history_fingerprint().unwrap(), fingerprint);
        acknowledged.status = "rejected".into();
        acknowledged.error = Some(json!({"code":"history_aborted"}));
        assert!(!acknowledged.history_committed());
        assert_eq!(acknowledged.history_fingerprint().unwrap(), fingerprint);
        let mut different = receipt.clone();
        different.request_id = Uuid::new_v4().to_string();
        assert_ne!(different.history_fingerprint().unwrap(), fingerprint);
        different = receipt.clone();
        different.instance_id = Uuid::new_v4().to_string();
        assert_ne!(different.history_fingerprint().unwrap(), fingerprint);
        different = receipt.clone();
        different.source_epoch += 1;
        assert_ne!(different.history_fingerprint().unwrap(), fingerprint);
        different = receipt.clone();
        different.expected_root = Some(RootObservation::new(1, 2));
        assert_ne!(different.history_fingerprint().unwrap(), fingerprint);
    }

    #[test]
    fn history_receipt_retirement_is_exact_idempotent_and_never_relabels_a_committed_save() {
        let (_temp, service, project, file) = fixture();
        let original = fs::read(&file).unwrap();
        let receipt = pending(&service, &project);
        let fingerprint = receipt.history_fingerprint().unwrap();
        service.write_editor_receipt(&receipt).unwrap();
        service.history_confirm_pending(&receipt).unwrap();
        assert!(service
            .history_confirm_committed_fingerprint(&fingerprint)
            .is_err());
        let book = EditorState::default();
        service
            .history_retire_unarmed_receipt(Some(&fingerprint), &book)
            .unwrap();
        let cancelled = service
            .read_editor_receipt(&receipt.request_id)
            .unwrap()
            .unwrap();
        assert_eq!(cancelled.status, "rejected");
        assert_eq!(cancelled.error.as_ref().unwrap()["code"], "history_aborted");
        assert_eq!(cancelled.history_fingerprint().unwrap(), fingerprint);
        let cancelled_bytes = fs::read(service.receipt_path(&receipt.request_id).unwrap()).unwrap();
        service
            .history_retire_unarmed_receipt(Some(&fingerprint), &book)
            .unwrap();
        assert_eq!(
            fs::read(service.receipt_path(&receipt.request_id).unwrap()).unwrap(),
            cancelled_bytes
        );
        let pending = pending(&service, &project);
        let mut committed = pending.clone();
        committed.status = "committed".into();
        committed.buffer_status = "newer_buffer".into();
        let fingerprint = committed.history_fingerprint().unwrap();
        service.write_editor_receipt(&committed).unwrap();
        assert!(service.history_confirm_pending(&pending).is_err());
        service
            .history_confirm_committed_fingerprint(&fingerprint)
            .unwrap();
        assert_eq!(
            service
                .read_editor_receipt(&committed.request_id)
                .unwrap()
                .unwrap()
                .buffer_status,
            "newer_buffer"
        );
        let committed_bytes =
            fs::read(service.receipt_path(&committed.request_id).unwrap()).unwrap();
        assert!(service
            .history_retire_unarmed_receipt(Some(&fingerprint), &book)
            .is_err());
        assert_eq!(
            fs::read(service.receipt_path(&committed.request_id).unwrap()).unwrap(),
            committed_bytes
        );
        assert_eq!(fs::read(file).unwrap(), original);
    }

    #[test]
    fn history_receipt_absence_is_observational_and_a_resumable_request_blocks_cancellation() {
        let (_temp, service, project, file) = fixture();
        let receipt = pending(&service, &project);
        let fingerprint = receipt.history_fingerprint().unwrap();
        let mut book = EditorState::default();
        service
            .history_retire_unarmed_receipt(Some(&fingerprint), &book)
            .unwrap();
        assert!(!service.state.join("editor-saves").exists());
        book.requests.insert(
            receipt.request_id.clone(),
            Request {
                owner: "native:main:current".into(),
                ticket: Uuid::new_v4().to_string(),
                session_id: receipt.session_id.clone(),
                project: project.id.clone(),
                path: "main.typ".into(),
                source_epoch: 0,
                expected_root: None,
                expires_at: now_ms() + REQUEST_MS,
            },
        );
        assert!(book.has_source_binding(&project.id, "main.typ", 0));
        assert!(!book.has_source_binding(&project.id, "main.typ", 1));
        assert_eq!(
            service
                .history_retire_unarmed_receipt(None, &book)
                .unwrap_err()
                .code,
            "busy"
        );
        assert!(!service.state.join("editor-saves").exists());
        assert_eq!(fs::read_to_string(file).unwrap(), "Original");
    }

    #[cfg(unix)]
    #[test]
    fn history_receipt_scan_preserves_unknown_corrupt_and_linked_entries() {
        use std::os::unix::fs::symlink;
        let (temp, service, project, file) = fixture();
        let mut receipt = pending(&service, &project);
        receipt.status = "committed".into();
        let fingerprint = receipt.history_fingerprint().unwrap();
        service.write_editor_receipt(&receipt).unwrap();
        service
            .history_confirm_committed_fingerprint(&fingerprint)
            .unwrap();
        let path = service.receipt_path(&receipt.request_id).unwrap();
        let bytes = fs::read(&path).unwrap();
        let unknown = path.parent().unwrap().join("unknown.json");
        fs::write(&unknown, b"preserve unknown bytes").unwrap();
        assert!(service
            .history_confirm_committed_fingerprint(&fingerprint)
            .is_err());
        assert_eq!(fs::read(&unknown).unwrap(), b"preserve unknown bytes");
        fs::remove_file(unknown).unwrap();
        let outside = temp.path().join("linked-receipt.json");
        fs::hard_link(&path, &outside).unwrap();
        assert!(service
            .history_confirm_committed_fingerprint(&fingerprint)
            .is_err());
        assert_eq!(fs::read(&outside).unwrap(), bytes);
        fs::remove_file(&outside).unwrap();
        fs::rename(&path, &outside).unwrap();
        symlink(&outside, &path).unwrap();
        assert!(service
            .history_confirm_committed_fingerprint(&fingerprint)
            .is_err());
        assert_eq!(fs::read(&outside).unwrap(), bytes);
        fs::remove_file(&path).unwrap();
        fs::rename(&outside, &path).unwrap();
        fs::write(&path, b"{}").unwrap();
        assert!(service
            .history_confirm_committed_fingerprint(&fingerprint)
            .is_err());
        assert_eq!(fs::read(&path).unwrap(), b"{}");
        assert_eq!(fs::read_to_string(file).unwrap(), "Original");
    }
}

#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BufferResult {
    Saved,
    NewerBuffer,
    Busy,
    StaleBuffer,
}

#[derive(Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct SaveReceipt {
    protocol_version: u32,
    request_id: String,
    instance_id: String,
    pub(super) project: String,
    pub(super) path: String,
    #[serde(default)]
    pub(super) source_epoch: u64,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::root_observation::optional"
    )]
    pub(super) expected_root: Option<RootObservation>,
    session_id: String,
    status: String,
    saved_generation: Option<u64>,
    saved_revision: Option<String>,
    buffer_status: String,
    error: Option<Value>,
    // Persisted for exact replay checks; omitted from the public receipt.
    commit_fingerprint: String,
}

impl SaveReceipt {
    pub(super) fn history_fingerprint(&self) -> Result<String> {
        request_id(&self.request_id)?;
        for id in [&self.instance_id, &self.project, &self.session_id] {
            Uuid::parse_str(id).map_err(|_| history_receipt_error())?;
        }
        super::source_path::validate_source_path(&self.path)?;
        if self.protocol_version != PROTOCOL_VERSION
            || self.source_epoch > crate::MAX_SOURCE_EPOCH
            || self.saved_generation.is_some_and(|g| g > MAX_GENERATION)
            || self
                .saved_revision
                .as_ref()
                .is_some_and(|r| !valid_digest(r))
            || (!self.commit_fingerprint.is_empty() && !valid_digest(&self.commit_fingerprint))
        {
            return Err(history_receipt_error());
        }
        Ok(digest(&serde_json::to_string(&json!([
            self.protocol_version,
            self.request_id,
            self.instance_id,
            self.project,
            self.path,
            self.source_epoch,
            self.expected_root,
            self.session_id,
            self.saved_generation,
            self.saved_revision,
            self.commit_fingerprint
        ]))?))
    }

    pub(super) fn history_committed(&self) -> bool {
        self.status == "committed"
            && self.error.is_none()
            && self.saved_generation.is_some_and(|g| g <= MAX_GENERATION)
            && self
                .saved_revision
                .as_ref()
                .is_some_and(|r| valid_digest(r))
            && valid_digest(&self.commit_fingerprint)
            && matches!(
                self.buffer_status.as_str(),
                "unconfirmed" | "saved" | "newer_buffer"
            )
    }

    fn value(&self) -> Value {
        let mut value = json!(self);
        value.as_object_mut().unwrap().remove("commitFingerprint");
        value
    }
}

fn history_receipt_error() -> Error {
    Error::new(
        "history_unavailable",
        "The exact native save receipt could not be confirmed. Existing data was preserved.",
    )
}

struct HistoryReceiptEntry {
    name: String,
    receipt: SaveReceipt,
    bytes: Vec<u8>,
    file: cap_std::fs::File,
}

fn history_read_receipt(directory: &Dir, name: &str) -> Result<HistoryReceiptEntry> {
    let id = name
        .strip_suffix(".json")
        .ok_or_else(history_receipt_error)?;
    request_id(id).map_err(|_| history_receipt_error())?;
    let mut options = OpenOptions::new();
    options.read(true).follow(FollowSymlinks::No).nonblock(true);
    let mut file = directory
        .open_with(name, &options)
        .map_err(|_| history_receipt_error())?;
    let before = file.metadata().map_err(|_| history_receipt_error())?;
    if !before.is_file() || before.nlink() != 1 || before.len() > 16 * 1024 {
        return Err(history_receipt_error());
    }
    let mut bytes = Vec::new();
    (&mut file)
        .take(16 * 1024 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| history_receipt_error())?;
    let after = file.metadata().map_err(|_| history_receipt_error())?;
    let current = directory
        .symlink_metadata(name)
        .map_err(|_| history_receipt_error())?;
    if bytes.len() > 16 * 1024
        || before.len() != bytes.len() as u64
        || after.len() != before.len()
        || before.modified().ok() != after.modified().ok()
        || !current.is_file()
        || current.nlink() != 1
        || (before.dev(), before.ino()) != (current.dev(), current.ino())
    {
        return Err(history_receipt_error());
    }
    let receipt: SaveReceipt =
        serde_json::from_slice(&bytes).map_err(|_| history_receipt_error())?;
    receipt
        .history_fingerprint()
        .map_err(|_| history_receipt_error())?;
    if receipt.request_id != id
        || !matches!(
            receipt.status.as_str(),
            "pending" | "committed" | "rejected"
        )
        || !matches!(
            receipt.buffer_status.as_str(),
            "unconfirmed" | "saved" | "newer_buffer"
        )
        || (receipt.status == "pending"
            && (receipt.buffer_status != "unconfirmed"
                || receipt.error.is_some()
                || receipt.saved_generation.is_none()
                || receipt.saved_revision.is_none()
                || !valid_digest(&receipt.commit_fingerprint)))
        || (receipt.status == "committed" && !receipt.history_committed())
        || (receipt.status == "rejected"
            && receipt
                .error
                .as_ref()
                .and_then(|error| error.get("code"))
                .and_then(Value::as_str)
                .is_none())
    {
        return Err(history_receipt_error());
    }
    Ok(HistoryReceiptEntry {
        name: name.into(),
        receipt,
        bytes,
        file,
    })
}

fn history_sync_receipt_directory(directory: &Dir) -> Result<()> {
    directory.open(".").and_then(|file| file.sync_all()).map_err(|_| {
        Error::new("outcome_unknown", "Native save receipt durability could not be confirmed. Inspect the same save before retrying.")
    })
}

fn history_find_receipt(directory: &Dir, fingerprint: &str) -> Result<Option<HistoryReceiptEntry>> {
    let mut found = None;
    for (index, entry) in directory
        .entries()
        .map_err(|_| history_receipt_error())?
        .enumerate()
    {
        if index >= MAX_RECEIPTS {
            return Err(history_receipt_error());
        }
        let name = entry
            .map_err(|_| history_receipt_error())?
            .file_name()
            .into_string()
            .map_err(|_| history_receipt_error())?;
        let entry = history_read_receipt(directory, &name)?;
        if entry.receipt.history_fingerprint()? == fingerprint {
            if found.is_some() {
                return Err(history_receipt_error());
            }
            found = Some(entry);
        }
    }
    Ok(found)
}

#[derive(Clone)]
struct Session {
    owner: String,
    project: String,
    path: String,
    source_epoch: u64,
    expected_root: Option<RootObservation>,
    generation: u64,
    revision: String,
    content_digest: String,
    dirty: bool,
    composing: bool,
    conflict: bool,
    seen_at: u64,
}

#[derive(Clone)]
struct Request {
    owner: String,
    ticket: String,
    session_id: String,
    project: String,
    path: String,
    source_epoch: u64,
    expected_root: Option<RootObservation>,
    expires_at: u64,
}

#[derive(Default)]
pub(super) struct EditorState {
    native_owners: BTreeMap<String, String>,
    browser_owners: BTreeSet<String>,
    sessions: BTreeMap<String, Session>,
    requests: BTreeMap<String, Request>,
    import_paths: BTreeSet<(String, String)>,
}

impl EditorState {
    pub(super) fn has_source_binding(&self, project: &str, path: &str, epoch: u64) -> bool {
        self.sessions.values().any(|session| {
            session.project == project && session.path == path && session.source_epoch == epoch
        }) || self.requests.values().any(|request| {
            request.project == project && request.path == path && request.source_epoch == epoch
        })
    }

    pub(super) fn check_native_owner(&self, window: &str, id: &str) -> Result<String> {
        if window != "main"
            || self
                .native_owners
                .get(window)
                .is_none_or(|current| current != id)
        {
            return Err(Error::new("stale_session", "This native editor page has been retired. Its callbacks cannot reconnect themselves."));
        }
        Ok(format!("native:{window}:{id}"))
    }
    pub(super) fn check_import_owner(&self, owner: &str) -> Result<()> {
        if !self
            .native_owners
            .iter()
            .any(|(window, id)| owner == format!("native:{window}:{id}"))
        {
            return Err(Error::new(
                "stale_session",
                "The native import owner was retired.",
            ));
        }
        Ok(())
    }

    pub(super) fn reserve_import(
        &mut self,
        owner: &str,
        project: &str,
        paths: &[String],
    ) -> Result<()> {
        self.check_import_owner(owner)?;
        if paths.iter().any(|path| {
            self.import_paths.contains(&(project.into(), path.clone()))
                || self
                    .sessions
                    .values()
                    .any(|session| session.project == project && session.path == *path)
        }) {
            return Err(Error::new(
                "busy",
                "Close the destination's editor buffer before importing; its content is preserved.",
            ));
        }
        self.import_paths
            .extend(paths.iter().map(|path| (project.into(), path.clone())));
        Ok(())
    }

    pub(super) fn release_import(&mut self, project: &str, paths: &[String]) {
        for path in paths {
            self.import_paths.remove(&(project.into(), path.clone()));
        }
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
fn valid_digest(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|b| b.is_ascii_hexdigit())
}
fn request_id(value: &str) -> Result<()> {
    if Uuid::parse_str(value).is_err() || value.len() != 36 {
        return Err(Error::new(
            "format",
            "Use a UUID requestId for an editor save.",
        ));
    }
    Ok(())
}
fn validate_state(generation: u64, revision: &str, content_digest: &str) -> Result<()> {
    if generation > MAX_GENERATION || !valid_digest(revision) || !valid_digest(content_digest) {
        return Err(Error::new(
            "format",
            "The editor generation or source digest is invalid.",
        ));
    }
    Ok(())
}
fn check_request<'a>(
    book: &'a EditorState,
    owner: &str,
    id: &str,
    ticket: &str,
    session: &str,
) -> Result<&'a Request> {
    let request = book.requests.get(id).ok_or_else(|| {
        Error::new(
            "expired_ticket",
            "The editor save ticket is no longer active.",
        )
    })?;
    if request.owner != owner || request.ticket != ticket || request.session_id != session {
        return Err(Error::new(
            "scope",
            "This editor owner cannot answer that save request.",
        ));
    }
    Ok(request)
}

impl Service {
    pub(super) fn assert_editor_owner(&self, owner: &str) -> Result<()> {
        let book = lock(&self.editor)?;
        if book.browser_owners.contains(owner)
            || book
                .native_owners
                .iter()
                .any(|(window, id)| owner == format!("native:{window}:{id}"))
        {
            return Ok(());
        }
        Err(Error::new(
            "stale_session",
            "The local UI owner has been retired.",
        ))
    }

    pub(super) fn assert_clean_editor_buffers(&self) -> Result<()> {
        if lock(&self.editor)?
            .sessions
            .values()
            .any(|session| session.dirty || session.composing || session.conflict)
        {
            return Err(Error::new("busy","Local buffers must be saved and composition/conflicts resolved before this app control."));
        }
        Ok(())
    }
    pub fn connect_native_editor(&self, window_label: &str) -> Result<Value> {
        if window_label != "main" {
            return Err(Error::new(
                "scope",
                "Only the main native editor window can connect a document bridge.",
            ));
        }
        let mut book = lock(&self.editor)?;
        if let Some(previous) = book.native_owners.get(window_label).cloned() {
            let owner = format!("native:{window_label}:{previous}");
            let retired: Vec<_> = book
                .requests
                .iter()
                .filter(|(_, r)| r.owner == owner)
                .map(|(id, _)| id.clone())
                .collect();
            for request in retired {
                self.retire_editor_request(
                    &mut book,
                    &request,
                    "stale_session",
                    "The native editor page was replaced before this save completed.",
                )?;
            }
            book.sessions.retain(|_, session| session.owner != owner);
        }
        let id = Uuid::new_v4().to_string();
        book.native_owners.insert(window_label.into(), id.clone());
        Ok(json!({"protocolVersion":PROTOCOL_VERSION,"ownerId":id}))
    }

    pub fn native_editor_owner(&self, window_label: &str, owner_id: &str) -> Result<String> {
        lock(&self.editor)?.check_native_owner(window_label, owner_id)
    }

    fn retire_editor_request(
        &self,
        book: &mut EditorState,
        id: &str,
        code: &str,
        message: &str,
    ) -> Result<()> {
        if let Some(request) = book.requests.get(id) {
            if self.read_editor_receipt(id)?.is_none() {
                self.write_editor_receipt(&self.rejected_receipt(id, request, code, message))?;
            }
        }
        book.requests.remove(id);
        Ok(())
    }

    fn editor_path(&self, project: &Project, relative: &str) -> Result<PathBuf> {
        let path = self.path(project, relative, false)?;
        let canonical = path.canonicalize()?;
        let expected = canonical
            .strip_prefix(&project.root)
            .map_err(|_| Error::new("path", "The editor source is outside its approved project."))?
            .to_string_lossy()
            .replace('\\', "/");
        if relative != expected {
            return Err(Error::new(
                "path",
                "Use the canonical project-relative source path for an editor session.",
            ));
        }
        Ok(path)
    }

    pub(crate) fn connect_browser_editor(&self) -> Result<Value> {
        let mut book = lock(&self.editor)?;
        if book.browser_owners.len() >= MAX_SESSIONS {
            return Err(Error::new(
                "limit",
                "Too many editor pages are connected. Restart the local adapter.",
            ));
        }
        let id = Uuid::new_v4().to_string();
        book.browser_owners.insert(format!("browser:{id}"));
        Ok(json!({"protocolVersion":PROTOCOL_VERSION,"ownerId":id}))
    }

    pub(crate) fn browser_editor_owner(&self, id: &str) -> Result<String> {
        let owner = format!("browser:{id}");
        if !lock(&self.editor)?.browser_owners.contains(&owner) {
            return Err(Error::new(
                "scope",
                "Connect this editor page before using its private bridge.",
            ));
        }
        Ok(owner)
    }

    pub async fn editor(
        self: &Arc<Self>,
        owner: &str,
        operation: EditorOperation,
    ) -> Result<Value> {
        if owner.is_empty() || owner.len() > 128 {
            return Err(Error::new(
                "scope",
                "The native editor owner is unavailable.",
            ));
        }
        let service = self.clone();
        let owner = owner.to_owned();
        tokio::task::spawn_blocking(move || service.editor_local(&owner, operation))
            .await
            .map_err(|_| {
                Error::new(
                    "outcome_unknown",
                    "The editor bridge stopped; inspect the save receipt before retrying.",
                )
            })?
    }

    pub async fn editor_native(
        self: &Arc<Self>,
        window_label: &str,
        owner_id: &str,
        operation: EditorOperation,
    ) -> Result<Value> {
        let (service, window, id) = (self.clone(), window_label.to_owned(), owner_id.to_owned());
        tokio::task::spawn_blocking(move || {
            let owner = service.native_editor_owner(&window, &id)?;
            service.editor_local_context(&owner, operation, true)
        })
        .await
        .map_err(|_| {
            Error::new(
                "outcome_unknown",
                "The native editor stopped; inspect its receipt before retrying.",
            )
        })?
    }

    fn editor_local(&self, owner: &str, operation: EditorOperation) -> Result<Value> {
        self.editor_local_context(owner, operation, false)
    }
    fn editor_local_context(
        &self,
        owner: &str,
        operation: EditorOperation,
        native: bool,
    ) -> Result<Value> {
        let mut book = lock(&self.editor)?;
        if native {
            book.check_import_owner(owner)?;
            if matches!(
                &operation,
                EditorOperation::EditorRegister {
                    expected_root: None,
                    ..
                }
            ) {
                return Err(Error::new(
                    "stale_root",
                    "Capture the project folder before registering a native editor.",
                ));
            }
        }
        if owner.starts_with("native:")
            && !book.native_owners.is_empty()
            && !book
                .native_owners
                .iter()
                .any(|(window, id)| owner == format!("native:{window}:{id}"))
        {
            return Err(Error::new(
                "stale_session",
                "The native editor page was retired before this callback ran.",
            ));
        }
        let _documents = if matches!(
            operation,
            EditorOperation::EditorRegister { .. }
                | EditorOperation::EditorUpdate { .. }
                | EditorOperation::EditorCommit { .. }
                | EditorOperation::EditorComplete { .. }
        ) {
            Some(
                self.documents
                    .try_lock()
                    .map_err(|_| Error::new("busy", "Another document operation is running."))?,
            )
        } else {
            None
        };
        let now = now_ms();
        match operation {
            EditorOperation::EditorRegister {
                project,
                path,
                source_epoch,
                expected_root,
                generation,
                revision,
                content_digest,
                dirty,
                composing,
                conflict,
            } => {
                validate_state(generation, &revision, &content_digest)?;
                self.require_source_epoch(&project, &path, source_epoch)?;
                if book.import_paths.contains(&(project.clone(), path.clone())) {
                    return Err(Error::new(
                        "busy",
                        "A native import owns this destination. Retry after it finishes.",
                    ));
                }
                let approved = self.project(&project)?;
                self.editor_path(&approved, &path)?;
                let expected_root = Some(
                    self.acquire_group(
                        SourceBinding::new(&project, &path, source_epoch).rooted(expected_root),
                    )?
                    .observation(),
                );
                let existing = book
                    .sessions
                    .iter()
                    .find(|(_, s)| s.project == project && s.path == path)
                    .map(|(id, s)| (id.clone(), s.clone()));
                if let Some((id, session)) = existing {
                    if session.owner != owner
                        && session.source_epoch == source_epoch
                        && session.expected_root == expected_root
                        && now.saturating_sub(session.seen_at) <= LEASE_MS
                    {
                        return Err(Error::new(
                            "busy",
                            "Another editor owns this document session.",
                        ));
                    }
                    let retired: Vec<_> = book
                        .requests
                        .iter()
                        .filter(|(_, r)| r.session_id == id)
                        .map(|(id, _)| id.clone())
                        .collect();
                    for request in retired {
                        self.retire_editor_request(
                            &mut book,
                            &request,
                            "stale_session",
                            "The editor was replaced before this save completed.",
                        )?;
                    }
                    book.sessions.remove(&id);
                }
                if book.sessions.len() >= MAX_SESSIONS {
                    return Err(Error::new(
                        "limit",
                        "At most 64 document sessions may register.",
                    ));
                }
                let id = Uuid::new_v4().to_string();
                book.sessions.insert(
                    id.clone(),
                    Session {
                        owner: owner.into(),
                        project,
                        path,
                        source_epoch,
                        expected_root,
                        generation,
                        revision,
                        content_digest,
                        dirty,
                        composing,
                        conflict,
                        seen_at: now,
                    },
                );
                Ok(
                    json!({"protocolVersion":PROTOCOL_VERSION,"sessionId":id,"sourceEpoch":source_epoch,"expectedRoot":expected_root}),
                )
            }
            EditorOperation::EditorUpdate {
                session_id,
                generation,
                revision,
                content_digest,
                dirty,
                composing,
                conflict,
            } => {
                validate_state(generation, &revision, &content_digest)?;
                let session = book
                    .sessions
                    .get_mut(&session_id)
                    .filter(|s| s.owner == owner)
                    .ok_or_else(|| {
                        Error::new(
                            "stale_session",
                            "Reopen the document to register its current editor session.",
                        )
                    })?;
                self.require_source_epoch(&session.project, &session.path, session.source_epoch)?;
                self.acquire_group(
                    SourceBinding::new(&session.project, &session.path, session.source_epoch)
                        .rooted(session.expected_root),
                )?;
                if generation < session.generation
                    || (generation == session.generation
                        && content_digest != session.content_digest)
                {
                    return Err(Error::new(
                        "stale_buffer",
                        "The editor generation does not describe this buffer.",
                    ));
                }
                session.generation = generation;
                session.revision = revision;
                session.content_digest = content_digest;
                session.dirty = dirty;
                session.composing = composing;
                session.conflict = conflict;
                session.seen_at = now;
                Ok(
                    json!({"protocolVersion":PROTOCOL_VERSION,"sessionId":session_id,"generation":generation,"sourceEpoch":session.source_epoch,"expectedRoot":session.expected_root}),
                )
            }
            EditorOperation::EditorUnregister { session_id } => {
                if !book
                    .sessions
                    .get(&session_id)
                    .is_some_and(|s| s.owner == owner)
                {
                    return Err(Error::new(
                        "stale_session",
                        "This editor session is no longer registered.",
                    ));
                }
                let retired: Vec<_> = book
                    .requests
                    .iter()
                    .filter(|(_, r)| r.session_id == session_id)
                    .map(|(id, _)| id.clone())
                    .collect();
                for request in retired {
                    self.retire_editor_request(
                        &mut book,
                        &request,
                        "stale_session",
                        "The editor was closed before this save completed.",
                    )?;
                }
                book.sessions.remove(&session_id);
                Ok(json!({"protocolVersion":PROTOCOL_VERSION,"retired":true}))
            }
            EditorOperation::EditorPoll {} => {
                for session in book.sessions.values_mut().filter(|s| s.owner == owner) {
                    session.seen_at = now;
                }
                let requests: Vec<_> = book.requests.iter().filter(|(_,r)|r.owner==owner && r.expires_at>now)
                    .map(|(id,r)|json!({"requestId":id,"ticket":r.ticket,"sessionId":r.session_id,"project":r.project,"path":r.path,"sourceEpoch":r.source_epoch,"expectedRoot":r.expected_root,"expiresAt":r.expires_at})).collect();
                Ok(json!({"protocolVersion":PROTOCOL_VERSION,"requests":requests}))
            }
            EditorOperation::EditorCommit {
                request_id,
                ticket,
                session_id,
                generation,
                revision,
                content,
            } => {
                let request =
                    check_request(&book, owner, &request_id, &ticket, &session_id)?.clone();
                self.require_source_epoch(&request.project, &request.path, request.source_epoch)?;
                self.acquire_group(
                    SourceBinding::new(&request.project, &request.path, request.source_epoch)
                        .rooted(request.expected_root),
                )?;
                let fingerprint = digest(&serde_json::to_string(&json!([
                    session_id,
                    generation,
                    revision,
                    digest(&content)
                ]))?);
                if let Some(receipt) = self.read_editor_receipt(&request_id)? {
                    if receipt.expected_root != request.expected_root
                        || receipt.source_epoch != request.source_epoch
                        || receipt.project != request.project
                        || receipt.path != request.path
                        || receipt.commit_fingerprint != fingerprint
                    {
                        return Err(Error::new(
                            "request_reused",
                            "This requestId already describes a different save.",
                        ));
                    }
                    if receipt.status == "committed" {
                        let approved = self.project(&request.project)?;
                        let file = self.path(&approved, &request.path, false)?;
                        if digest(
                            self.acquire_group(
                                SourceBinding::new(
                                    &request.project,
                                    &request.path,
                                    request.source_epoch,
                                )
                                .rooted(request.expected_root),
                            )?
                            .read_utf8(Member::Source, MAX_TEXT)?
                            .text()?
                            .ok_or_else(|| Error::new("io", "The source is unavailable."))?,
                        ) != receipt.saved_revision.clone().unwrap_or_default()
                        {
                            return Err(Error::new("conflict","The captured save is committed, but disk has changed since. Inspect its durable receipt."));
                        }
                        return Ok(
                            json!({"snapshot":self.snapshot_binding(SourceBinding::new(&request.project,&request.path,request.source_epoch).rooted(request.expected_root).guarded(native),&file,true)?,"receipt":receipt.value()}),
                        );
                    }
                    return Err(Error::new(
                        "outcome_unknown",
                        "Inspect this save receipt before retrying an uncertain commit.",
                    ));
                }
                if request.expires_at <= now {
                    return Err(Error::new(
                        "expired_ticket",
                        "This editor save ticket expired before commit.",
                    ));
                }
                let session = book
                    .sessions
                    .get(&session_id)
                    .filter(|s| s.owner == owner)
                    .ok_or_else(|| {
                        Error::new(
                            "stale_session",
                            "The editor was closed or replaced before save.",
                        )
                    })?;
                validate_state(generation, &revision, &digest(&content))?;
                if now.saturating_sub(session.seen_at) > LEASE_MS {
                    return Err(Error::new(
                        "ui_unavailable",
                        "The editor is no longer responding.",
                    ));
                }
                if session.composing || session.conflict {
                    return Err(Error::new(
                        "busy",
                        "Finish composition or resolve the editor conflict before saving.",
                    ));
                }
                if session.expected_root != request.expected_root {
                    return Err(Error::new(
                        "stale_root",
                        "The document session belongs to another project folder.",
                    ));
                }
                if session.source_epoch != request.source_epoch {
                    return Err(source_identity::stale());
                }
                if session.generation != generation
                    || session.revision != revision
                    || session.content_digest != digest(&content)
                {
                    return Err(Error::new(
                        "stale_buffer",
                        "The editor changed after its save capture.",
                    ));
                }
                if content.len() > MAX_TEXT {
                    return Err(Error::new("limit", "The manuscript exceeds 2 MB."));
                }
                let approved = self.project(&request.project)?;
                let file = self.path(&approved, &request.path, false)?;
                self.require_source_epoch(&request.project, &request.path, request.source_epoch)?;
                self.acquire_group(
                    SourceBinding::new(&request.project, &request.path, request.source_epoch)
                        .rooted(request.expected_root),
                )?;
                let binding =
                    SourceBinding::new(&request.project, &request.path, request.source_epoch)
                        .rooted(request.expected_root)
                        .guarded(native);
                if native {
                    self.history_recover_empty_producer_init()?;
                }
                let document = self.held_document(binding, &file, true)?;
                let old = document.content.clone();
                let mut review = document.review.clone();
                review.check_revision(&revision, &old)?;
                review.reconcile(&old, &content);
                let receipt = SaveReceipt {
                    protocol_version: PROTOCOL_VERSION,
                    request_id: request_id.clone(),
                    instance_id: self.instance_id.clone(),
                    project: request.project,
                    path: request.path,
                    source_epoch: request.source_epoch,
                    expected_root: request.expected_root,
                    session_id: session_id.clone(),
                    status: "pending".into(),
                    saved_generation: Some(generation),
                    saved_revision: Some(digest(&content)),
                    buffer_status: "unconfirmed".into(),
                    error: None,
                    commit_fingerprint: fingerprint,
                };
                let history_maintenance_pending = match self.persist_observed_cause(
                    SourceBinding::new(&receipt.project, &receipt.path, receipt.source_epoch)
                        .rooted(receipt.expected_root)
                        .guarded(native),
                    &file,
                    &document,
                    &content,
                    &review,
                    (
                        Some(&receipt),
                        native.then_some(history::NativeCause::Save),
                        native.then_some(&*book),
                    ),
                ) {
                    Ok(pending) => pending,
                    Err(error) => {
                        if self.read_editor_receipt(&request_id)?.is_none() {
                            return Err(error);
                        }
                        return Err(Error::new(
                            "outcome_unknown",
                            "The save may have committed. Inspect its receipt before retrying.",
                        ));
                    }
                };
                let receipt = self.read_editor_receipt(&request_id)?.ok_or_else(|| {
                    Error::new("outcome_unknown", "The save receipt is unavailable.")
                })?;
                Ok(
                    json!({"snapshot":self.snapshot_after_persist(SourceBinding::new(&receipt.project,&receipt.path,receipt.source_epoch).rooted(receipt.expected_root).guarded(native),&file,history_maintenance_pending)?,"receipt":receipt.value()}),
                )
            }
            EditorOperation::EditorComplete {
                request_id,
                ticket,
                session_id,
                status,
                generation,
            } => {
                let request =
                    check_request(&book, owner, &request_id, &ticket, &session_id)?.clone();
                self.require_source_epoch(&request.project, &request.path, request.source_epoch)?;
                self.acquire_group(
                    SourceBinding::new(&request.project, &request.path, request.source_epoch)
                        .rooted(request.expected_root),
                )?;
                if let Some(mut receipt) = self.read_editor_receipt(&request_id)? {
                    if receipt.status != "committed" {
                        return Err(Error::new(
                            "outcome_unknown",
                            "Inspect the pending native save before completing it.",
                        ));
                    }
                    // Completion describes the buffer only; it can never revoke or hide a committed save.
                    receipt.buffer_status = if matches!(status, BufferResult::Saved)
                        && receipt.saved_generation == Some(generation)
                        && book.sessions.get(&session_id).is_some_and(|s| {
                            s.generation == generation && !s.composing && !s.conflict
                        }) {
                        "saved"
                    } else {
                        "newer_buffer"
                    }
                    .into();
                    self.write_editor_receipt(&receipt)?;
                    book.requests.remove(&request_id);
                    return Ok(receipt.value());
                }
                if request.expires_at <= now {
                    return Err(Error::new(
                        "expired_ticket",
                        "This editor save ticket expired.",
                    ));
                }
                let code = match status {
                    BufferResult::Busy => "busy",
                    _ => "stale_buffer",
                };
                let receipt = self.rejected_receipt(
                    &request_id,
                    &request,
                    code,
                    "The editor could not capture a stable buffer.",
                );
                self.write_editor_receipt(&receipt)?;
                book.requests.remove(&request_id);
                Ok(receipt.value())
            }
        }
    }

    fn rejected_receipt(
        &self,
        id: &str,
        request: &Request,
        code: &str,
        message: &str,
    ) -> SaveReceipt {
        SaveReceipt {
            protocol_version: PROTOCOL_VERSION,
            request_id: id.into(),
            instance_id: self.instance_id.clone(),
            project: request.project.clone(),
            path: request.path.clone(),
            source_epoch: request.source_epoch,
            expected_root: request.expected_root,
            session_id: request.session_id.clone(),
            status: "rejected".into(),
            saved_generation: None,
            saved_revision: None,
            buffer_status: "unconfirmed".into(),
            error: Some(json!({"code":code,"message":message})),
            commit_fingerprint: String::new(),
        }
    }

    fn receipt_path(&self, id: &str) -> Result<PathBuf> {
        request_id(id)?;
        Ok(self.state.join("editor-saves").join(format!("{id}.json")))
    }

    fn history_receipt_directories(&self) -> Result<(Dir, Option<Dir>)> {
        let metadata = fs::symlink_metadata(&self.state).map_err(|_| history_receipt_error())?;
        if !metadata.is_dir() || metadata.file_type().is_symlink() {
            return Err(history_receipt_error());
        }
        let state = Dir::open_ambient_dir(&self.state, cap_std::ambient_authority())
            .map_err(|_| history_receipt_error())?;
        let directory = match state.symlink_metadata("editor-saves") {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
            Err(_) => return Err(history_receipt_error()),
            Ok(metadata) if !metadata.is_dir() || metadata.file_type().is_symlink() => {
                return Err(history_receipt_error())
            }
            Ok(_) => Some(
                state
                    .open_dir_nofollow("editor-saves")
                    .map_err(|_| history_receipt_error())?,
            ),
        };
        Ok((state, directory))
    }

    fn history_check_receipt_directories(
        &self,
        state: &Dir,
        directory: Option<&Dir>,
    ) -> Result<()> {
        let (current_state, current_directory) = self.history_receipt_directories()?;
        let held = state.dir_metadata().map_err(|_| history_receipt_error())?;
        let current = current_state
            .dir_metadata()
            .map_err(|_| history_receipt_error())?;
        if (held.dev(), held.ino()) != (current.dev(), current.ino()) {
            return Err(history_receipt_error());
        }
        match (directory, current_directory) {
            (None, None) => Ok(()),
            (Some(held), Some(current)) => {
                let held = held.dir_metadata().map_err(|_| history_receipt_error())?;
                let current = current
                    .dir_metadata()
                    .map_err(|_| history_receipt_error())?;
                if (held.dev(), held.ino()) == (current.dev(), current.ino()) {
                    Ok(())
                } else {
                    Err(history_receipt_error())
                }
            }
            _ => Err(history_receipt_error()),
        }
    }

    fn history_sync_receipt(
        &self,
        state: &Dir,
        directory: &Dir,
        entry: &HistoryReceiptEntry,
    ) -> Result<()> {
        entry.file.sync_all().map_err(|_| {
            Error::new(
                "outcome_unknown",
                "Native save receipt synchronization is uncertain.",
            )
        })?;
        history_sync_receipt_directory(directory)?;
        // The receipt directory itself may have been created by this save.
        history_sync_receipt_directory(state)?;
        let checked = history_read_receipt(directory, &entry.name)?;
        let before = entry.file.metadata().map_err(|_| history_receipt_error())?;
        let after = checked
            .file
            .metadata()
            .map_err(|_| history_receipt_error())?;
        if checked.bytes != entry.bytes
            || (before.dev(), before.ino()) != (after.dev(), after.ino())
        {
            return Err(history_receipt_error());
        }
        self.history_check_receipt_directories(state, Some(directory))
    }

    pub(super) fn history_confirm_pending(&self, receipt: &SaveReceipt) -> Result<()> {
        let current = self.matching_journal_receipt(receipt)?;
        if current.status != "pending"
            || current.buffer_status != "unconfirmed"
            || current.error.is_some()
        {
            return Err(history_receipt_error());
        }
        let (state, directory) = self.history_receipt_directories()?;
        let directory = directory.ok_or_else(history_receipt_error)?;
        let name = format!("{}.json", receipt.request_id);
        let before = history_read_receipt(&directory, &name)?;
        if before.receipt != current {
            return Err(history_receipt_error());
        }
        self.history_check_receipt_directories(&state, Some(&directory))?;
        self.write_editor_receipt(&current)?;
        let entry = history_read_receipt(&directory, &name)?;
        if entry.receipt != current {
            return Err(history_receipt_error());
        }
        self.history_sync_receipt(&state, &directory, &entry)
    }

    pub(super) fn history_confirm_committed_fingerprint(&self, fingerprint: &str) -> Result<()> {
        if !valid_digest(fingerprint) {
            return Err(history_receipt_error());
        }
        let (state, directory) = self.history_receipt_directories()?;
        let directory = directory.ok_or_else(history_receipt_error)?;
        let entry =
            history_find_receipt(&directory, fingerprint)?.ok_or_else(history_receipt_error)?;
        if !entry.receipt.history_committed() {
            return Err(history_receipt_error());
        }
        self.history_sync_receipt(&state, &directory, &entry)
    }

    /// Caller holds the native book and document guard and has proved this intent unarmed.
    pub(super) fn history_retire_unarmed_receipt(
        &self,
        fingerprint: Option<&str>,
        book: &EditorState,
    ) -> Result<()> {
        if !book.requests.is_empty() {
            return Err(Error::new(
                "busy",
                "An editor save may still resume; its receipt was preserved.",
            ));
        }
        let Some(fingerprint) = fingerprint else {
            return Ok(());
        };
        if !valid_digest(fingerprint) {
            return Err(history_receipt_error());
        }
        let (state, directory) = self.history_receipt_directories()?;
        let entry = directory
            .as_ref()
            .map(|directory| history_find_receipt(directory, fingerprint))
            .transpose()?
            .flatten();
        if let Some(entry) = entry {
            let directory = directory.as_ref().ok_or_else(history_receipt_error)?;
            if entry.receipt.status == "pending" {
                let mut rejected = entry.receipt.clone();
                rejected.status = "rejected".into();
                rejected.error = Some(
                    json!({"code":"history_aborted","message":"This unapplied native save was cancelled; the manuscript was preserved."}),
                );
                self.history_check_receipt_directories(&state, Some(directory))?;
                self.write_editor_receipt(&rejected)?;
                let confirmed = history_read_receipt(directory, &entry.name)?;
                if confirmed.receipt != rejected {
                    return Err(history_receipt_error());
                }
                return self.history_sync_receipt(&state, directory, &confirmed);
            }
            if entry.receipt.status == "rejected"
                && entry
                    .receipt
                    .error
                    .as_ref()
                    .and_then(|error| error.get("code"))
                    .and_then(Value::as_str)
                    == Some("history_aborted")
            {
                return self.history_sync_receipt(&state, directory, &entry);
            }
            return Err(history_receipt_error());
        }
        if let Some(directory) = &directory {
            history_sync_receipt_directory(directory)?;
        }
        history_sync_receipt_directory(&state)?;
        self.history_check_receipt_directories(&state, directory.as_ref())?;
        if directory
            .as_ref()
            .map(|directory| history_find_receipt(directory, fingerprint))
            .transpose()?
            .flatten()
            .is_some()
        {
            return Err(history_receipt_error());
        }
        Ok(())
    }

    fn read_editor_receipt(&self, id: &str) -> Result<Option<SaveReceipt>> {
        let path = self.receipt_path(id)?;
        match fs::symlink_metadata(&path) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(error.into()),
            Ok(metadata) if !metadata.is_file() || metadata.file_type().is_symlink() => {
                return Err(Error::new(
                    "path",
                    "The save receipt is not a regular local file.",
                ))
            }
            _ => (),
        }
        let receipt: SaveReceipt = serde_json::from_str(&read_text(&path, 16 * 1024)?)?;
        if receipt.request_id != id
            || receipt.protocol_version != PROTOCOL_VERSION
            || receipt.source_epoch > crate::MAX_SOURCE_EPOCH
        {
            return Err(Error::new(
                "format",
                "The save receipt identity is invalid.",
            ));
        }
        Ok(Some(receipt))
    }

    pub(super) fn write_editor_receipt(&self, receipt: &SaveReceipt) -> Result<()> {
        let path = self.receipt_path(&receipt.request_id)?;
        let directory = path.parent().unwrap();
        if fs::symlink_metadata(directory).is_ok_and(|m| m.file_type().is_symlink()) {
            return Err(Error::new(
                "path",
                "Linked receipt directories are not writable.",
            ));
        }
        fs::create_dir_all(directory)?;
        if !path.exists() && fs::read_dir(directory)?.take(MAX_RECEIPTS + 1).count() >= MAX_RECEIPTS
        {
            return Err(Error::new(
                "limit",
                "The bounded save receipt store is full; existing receipts were preserved.",
            ));
        }
        atomic_write(&path, &serde_json::to_vec_pretty(receipt)?)
    }

    pub(super) fn write_committed_receipt(&self, receipt: &SaveReceipt) -> Result<()> {
        let mut current = self.matching_journal_receipt(receipt)?;
        if current.status == "committed" {
            // A lost-ack recovery cannot erase a later buffer confirmation.
            return Ok(());
        }
        current.status = "committed".into();
        self.write_editor_receipt(&current)
    }

    fn matching_journal_receipt(&self, receipt: &SaveReceipt) -> Result<SaveReceipt> {
        let current = self
            .read_editor_receipt(&receipt.request_id)?
            .ok_or_else(policy_continuity::conflict)?;
        if receipt.status != "pending"
            || receipt.buffer_status != "unconfirmed"
            || receipt.error.is_some()
            || !matches!(
                (current.status.as_str(), current.buffer_status.as_str()),
                ("pending", "unconfirmed")
                    | ("committed", "unconfirmed" | "saved" | "newer_buffer")
            )
        {
            return Err(policy_continuity::conflict());
        }
        let mut normalized = current.clone();
        normalized.status = "pending".into();
        normalized.buffer_status = "unconfirmed".into();
        if normalized != *receipt {
            return Err(policy_continuity::conflict());
        }
        Ok(current)
    }

    pub(super) fn validate_editor_journal(
        &self,
        path: &Path,
        content: &str,
        receipt: &SaveReceipt,
    ) -> Result<()> {
        request_id(&receipt.request_id)?;
        let approved = self.project(&receipt.project)?;
        self.require_source_epoch(&receipt.project, &receipt.path, receipt.source_epoch)?;
        self.acquire_group(
            SourceBinding::new(&receipt.project, &receipt.path, receipt.source_epoch)
                .rooted(receipt.expected_root),
        )?;
        if self.path(&approved, &receipt.path, false)? != path
            || receipt.saved_revision.as_deref() != Some(digest(content).as_str())
            || receipt.protocol_version != PROTOCOL_VERSION
            || receipt.status != "pending"
            || !valid_digest(&receipt.commit_fingerprint)
            || receipt.saved_generation.is_none_or(|g| g > MAX_GENERATION)
        {
            return Err(Error::new(
                "format",
                "The interrupted editor save does not match its document.",
            ));
        }
        self.matching_journal_receipt(receipt)?;
        Ok(())
    }

    pub(super) fn editor_save_receipt(&self, id: &str) -> Result<Value> {
        let mut receipt = self.read_editor_receipt(id)?.ok_or_else(|| {
            Error::new(
                "request_unknown",
                "No durable save receipt exists for this requestId.",
            )
        })?;
        if receipt.status == "pending" {
            let _documents = self
                .documents
                .try_lock()
                .map_err(|_| Error::new("busy", "The native save is still running."))?;
            let approved = self.project(&receipt.project)?;
            let file = self.path(&approved, &receipt.path, false)?;
            self.held_document(
                SourceBinding::new(&receipt.project, &receipt.path, receipt.source_epoch)
                    .rooted(receipt.expected_root)
                    .guarded(receipt.expected_root.is_some()),
                &file,
                true,
            )?;
            receipt = self
                .read_editor_receipt(id)?
                .ok_or_else(|| Error::new("outcome_unknown", "The save receipt is unavailable."))?;
        }
        Ok(receipt.value())
    }

    pub(super) async fn request_editor_save(
        self: &Arc<Self>,
        project: &str,
        path: &str,
        id: &str,
    ) -> Result<Value> {
        request_id(id)?;
        let approved = self.project(project)?;
        self.editor_path(&approved, path)?;
        {
            let mut book = lock(&self.editor)?;
            if let Some(receipt) = self.read_editor_receipt(id)? {
                if receipt.project != project || receipt.path != path {
                    return Err(Error::new(
                        "request_reused",
                        "This requestId describes a different document.",
                    ));
                }
                drop(book);
                return self.editor_save_receipt(id);
            }
            if let Some(existing) = book.requests.get(id) {
                self.require_source_epoch(project, path, existing.source_epoch)?;
                if existing.project != project || existing.path != path {
                    return Err(Error::new(
                        "request_reused",
                        "This requestId describes a different document.",
                    ));
                }
            } else {
                let _documents = self
                    .documents
                    .try_lock()
                    .map_err(|_| Error::new("busy", "Another document operation is running."))?;
                let now = now_ms();
                let expired: Vec<_> = book
                    .requests
                    .iter()
                    .filter(|(_, r)| r.expires_at <= now)
                    .map(|(id, _)| id.clone())
                    .collect();
                for request in expired {
                    self.retire_editor_request(
                        &mut book,
                        &request,
                        "expired_ticket",
                        "The editor save ticket expired before completion.",
                    )?;
                }
                if book.requests.len() >= MAX_REQUESTS {
                    return Err(Error::new("busy", "The editor save queue is full."));
                }
                let (session_id,session)=book.sessions.iter().find(|(_,s)|s.project==project && s.path==path && now.saturating_sub(s.seen_at)<=LEASE_MS)
                    .ok_or_else(||Error::new("ui_unavailable","Open this document in a live UnderTree editor before saving from the CLI."))?;
                self.require_source_epoch(project, path, session.source_epoch)?;
                self.acquire_group(
                    SourceBinding::new(project, path, session.source_epoch)
                        .rooted(session.expected_root),
                )?;
                if session.composing || session.conflict {
                    return Err(Error::new(
                        "busy",
                        "Finish composition or resolve the editor conflict before saving.",
                    ));
                }
                if book.requests.values().any(|r| r.session_id == *session_id) {
                    return Err(Error::new(
                        "busy",
                        "This document already has a pending editor save.",
                    ));
                }
                let request = Request {
                    owner: session.owner.clone(),
                    ticket: Uuid::new_v4().to_string(),
                    session_id: session_id.clone(),
                    project: project.into(),
                    path: path.into(),
                    source_epoch: session.source_epoch,
                    expected_root: session.expected_root,
                    expires_at: now + REQUEST_MS,
                };
                book.requests.insert(id.into(), request);
            }
        }
        let deadline = tokio::time::Instant::now() + Duration::from_millis(REQUEST_MS + 100);
        let mut committed_at = None;
        loop {
            if let Some(receipt) = self.read_editor_receipt(id)? {
                if receipt.status != "pending" {
                    if receipt.buffer_status != "unconfirmed"
                        || !lock(&self.editor)?.requests.contains_key(id)
                    {
                        return Ok(receipt.value());
                    }
                    let since = committed_at.get_or_insert_with(tokio::time::Instant::now);
                    if since.elapsed() >= Duration::from_millis(500) {
                        return Ok(receipt.value());
                    }
                }
            }
            if !lock(&self.editor)?.requests.contains_key(id)
                && self.read_editor_receipt(id)?.is_none()
            {
                return Err(Error::new(
                    "ui_unavailable",
                    "The document editor was closed or replaced before saving.",
                ));
            }
            if tokio::time::Instant::now() >= deadline {
                let mut book = lock(&self.editor)?;
                if let Some(receipt) = self.read_editor_receipt(id)? {
                    if receipt.status == "committed" {
                        book.requests.remove(id);
                        return Ok(receipt.value());
                    }
                    return Err(Error::new(
                        "outcome_unknown",
                        "The native save outcome requires receipt inspection.",
                    ));
                }
                if let Some(request) = book.requests.remove(id) {
                    let receipt = self.rejected_receipt(
                        id,
                        &request,
                        "expired_ticket",
                        "The editor did not finish before the save ticket expired.",
                    );
                    self.write_editor_receipt(&receipt)?;
                    return Ok(receipt.value());
                }
                return Err(Error::new(
                    "ui_unavailable",
                    "The document editor was closed or replaced before saving.",
                ));
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
    }
}
