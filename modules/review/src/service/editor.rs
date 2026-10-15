//! Private UI coordination. These operations are never part of the CLI or MCP catalogue.
use super::*;
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
    fn value(&self) -> Value {
        let mut value = json!(self);
        value.as_object_mut().unwrap().remove("commitFingerprint");
        value
    }
}

#[derive(Clone)]
struct Session {
    owner: String,
    project: String,
    path: String,
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
        let book = lock(&self.editor)?;
        if window_label != "main"
            || !book
                .native_owners
                .get(window_label)
                .is_some_and(|id| id == owner_id)
        {
            return Err(Error::new("stale_session","This native editor page has been retired. Its callbacks cannot reconnect themselves."));
        }
        Ok(format!("native:{window_label}:{owner_id}"))
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

    fn editor_local(&self, owner: &str, operation: EditorOperation) -> Result<Value> {
        let mut book = lock(&self.editor)?;
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
        let now = now_ms();
        match operation {
            EditorOperation::EditorRegister {
                project,
                path,
                generation,
                revision,
                content_digest,
                dirty,
                composing,
                conflict,
            } => {
                validate_state(generation, &revision, &content_digest)?;
                if book.import_paths.contains(&(project.clone(), path.clone())) {
                    return Err(Error::new(
                        "busy",
                        "A native import owns this destination. Retry after it finishes.",
                    ));
                }
                let approved = self.project(&project)?;
                self.editor_path(&approved, &path)?;
                let existing = book
                    .sessions
                    .iter()
                    .find(|(_, s)| s.project == project && s.path == path)
                    .map(|(id, s)| (id.clone(), s.clone()));
                if let Some((id, session)) = existing {
                    if session.owner != owner && now.saturating_sub(session.seen_at) <= LEASE_MS {
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
                        generation,
                        revision,
                        content_digest,
                        dirty,
                        composing,
                        conflict,
                        seen_at: now,
                    },
                );
                Ok(json!({"protocolVersion":PROTOCOL_VERSION,"sessionId":id}))
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
                    json!({"protocolVersion":PROTOCOL_VERSION,"sessionId":session_id,"generation":generation}),
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
                    .map(|(id,r)|json!({"requestId":id,"ticket":r.ticket,"sessionId":r.session_id,"project":r.project,"path":r.path,"expiresAt":r.expires_at})).collect();
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
                let fingerprint = digest(&serde_json::to_string(&json!([
                    session_id,
                    generation,
                    revision,
                    digest(&content)
                ]))?);
                if let Some(receipt) = self.read_editor_receipt(&request_id)? {
                    if receipt.commit_fingerprint != fingerprint {
                        return Err(Error::new(
                            "request_reused",
                            "This requestId already describes a different save.",
                        ));
                    }
                    if receipt.status == "committed" {
                        let approved = self.project(&request.project)?;
                        let file = self.path(&approved, &request.path, false)?;
                        if digest(&read_text(&file, MAX_TEXT)?)
                            != receipt.saved_revision.clone().unwrap_or_default()
                        {
                            return Err(Error::new("conflict","The captured save is committed, but disk has changed since. Inspect its durable receipt."));
                        }
                        return Ok(
                            json!({"snapshot":self.snapshot(&approved,&request.path,&file)?,"receipt":receipt.value()}),
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
                let _documents = self
                    .documents
                    .try_lock()
                    .map_err(|_| Error::new("busy", "Another document operation is running."))?;
                let approved = self.project(&request.project)?;
                let file = self.path(&approved, &request.path, false)?;
                let (old, mut review) = self.read_document(&approved, &request.path, &file)?;
                review.check_revision(&revision, &old)?;
                review.reconcile(&old, &content);
                let receipt = SaveReceipt {
                    protocol_version: PROTOCOL_VERSION,
                    request_id: request_id.clone(),
                    instance_id: self.instance_id.clone(),
                    project: request.project,
                    path: request.path,
                    session_id: session_id.clone(),
                    status: "pending".into(),
                    saved_generation: Some(generation),
                    saved_revision: Some(digest(&content)),
                    buffer_status: "unconfirmed".into(),
                    error: None,
                    commit_fingerprint: fingerprint,
                };
                self.write_editor_receipt(&receipt)?;
                if self
                    .persist_with_receipt(
                        &receipt.project,
                        &receipt.path,
                        &file,
                        Some(&old),
                        &content,
                        &review,
                        Some(&receipt),
                    )
                    .is_err()
                {
                    return Err(Error::new(
                        "outcome_unknown",
                        "The save may have committed. Inspect its receipt before retrying.",
                    ));
                }
                let receipt = self.read_editor_receipt(&request_id)?.ok_or_else(|| {
                    Error::new("outcome_unknown", "The save receipt is unavailable.")
                })?;
                Ok(
                    json!({"snapshot":self.snapshot(&approved,&receipt.path,&file)?,"receipt":receipt.value()}),
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
        if receipt.request_id != id || receipt.protocol_version != PROTOCOL_VERSION {
            return Err(Error::new(
                "format",
                "The save receipt identity is invalid.",
            ));
        }
        Ok(Some(receipt))
    }

    fn write_editor_receipt(&self, receipt: &SaveReceipt) -> Result<()> {
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
            self.read_document(&approved, &receipt.path, &file)?;
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
                if existing.project != project || existing.path != path {
                    return Err(Error::new(
                        "request_reused",
                        "This requestId describes a different document.",
                    ));
                }
            } else {
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
