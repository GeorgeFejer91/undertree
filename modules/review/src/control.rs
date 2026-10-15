use crate::{Error, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet, VecDeque};
use std::sync::{Mutex, MutexGuard};
use std::time::{Duration, Instant};
use subtle::ConstantTimeEq;
use uuid::Uuid;

const MAX_JOBS: usize = 128;
const MAX_PENDING: usize = 16;
const MAX_DOCUMENTS: usize = 20;
const MAX_OUTCOME_BYTES: usize = 16 * 1024;
const UI_LEASE: Duration = Duration::from_secs(5);
const QUEUED_DEADLINE: Duration = Duration::from_secs(15);
const RUNNING_DEADLINE: Duration = Duration::from_secs(90);

/// Product actions that cannot provide replacement source, accept proposals, or save files.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum AppCommand {
    OpenManuscript {
        document_id: String,
    },
    SelectPassage {
        document_id: String,
        revision: String,
        from: usize,
        to: usize,
        quote: String,
    },
    SetWorkspaceView {
        files_visible: Option<bool>,
        editor_visible: Option<bool>,
        preview_visible: Option<bool>,
        review_visible: Option<bool>,
        outline_visible: Option<bool>,
        logs_visible: Option<bool>,
    },
    SetEditorPreferences {
        font_size: Option<u8>,
        word_wrap: Option<bool>,
    },
    SetPreviewView {
        page: Option<u32>,
        zoom_percent: Option<u16>,
        fit_width: Option<bool>,
    },
    SetWindowState {
        state: WindowState,
    },
    CompileManuscript {
        document_id: String,
        revision: String,
    },
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum WindowState {
    Minimize,
    Maximize,
    Restore,
    Focus,
    Close,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DocumentState {
    pub document_id: String,
    pub revision: String,
    pub dirty: bool,
    pub conflict: bool,
    pub composing: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PreviewState {
    pub page: u32,
    pub pages: u32,
    pub zoom_percent: u16,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkspaceView {
    pub files_visible: bool,
    pub editor_visible: bool,
    pub preview_visible: bool,
    pub review_visible: bool,
    pub outline_visible: bool,
    pub logs_visible: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EditorPreferences {
    pub font_size: u8,
    pub word_wrap: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkspaceSnapshot {
    pub open_documents: Vec<DocumentState>,
    pub active_document_id: Option<String>,
    pub preview: Option<PreviewState>,
    pub view: WorkspaceView,
    pub editor: EditorPreferences,
}

/// Returned only to the authenticated local UI. Remote receipts never contain this token.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UiJob {
    pub request_id: String,
    pub command: AppCommand,
    pub ack_token: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(tag = "state", rename_all = "snake_case", deny_unknown_fields)]
pub enum UiOutcome {
    Applied { result: Value },
    Rejected { code: String, message: String },
}

enum JobState {
    Queued(Instant),
    Dispatched(Instant),
    Complete(UiOutcome),
    Expired,
    OutcomeUnknown,
}

struct Job {
    command: AppCommand,
    fingerprint: String,
    ack_token: String,
    active_document_id: Option<String>,
    state: JobState,
}

impl Job {
    fn validate(&self, workspace: &WorkspaceSnapshot) -> Result<()> {
        if matches!(self.command, AppCommand::SetPreviewView { .. })
            && self.active_document_id != workspace.active_document_id
        {
            return Err(Error::new(
                "stale",
                "The active manuscript changed before this preview command was applied.",
            ));
        }
        self.command.validate(workspace)
    }
}

struct BridgeState {
    generation: String,
    workspace: Option<(Instant, WorkspaceSnapshot)>,
    jobs: BTreeMap<String, Job>,
    queue: VecDeque<String>,
}

impl Default for BridgeState {
    fn default() -> Self {
        Self {
            generation: Uuid::new_v4().to_string(),
            workspace: None,
            jobs: BTreeMap::new(),
            queue: VecDeque::new(),
        }
    }
}

pub struct ControlBridge {
    state: Mutex<BridgeState>,
}

impl Default for ControlBridge {
    fn default() -> Self {
        Self::new()
    }
}

fn identifier(value: &str, maximum: usize) -> bool {
    !value.is_empty()
        && value.len() <= maximum
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
}

fn invalid(message: &str) -> Error {
    Error::new("arguments", message)
}

impl WorkspaceSnapshot {
    fn validate(&self) -> Result<()> {
        if self.open_documents.len() > MAX_DOCUMENTS {
            return Err(invalid("The workspace exceeds 20 document states."));
        }
        let mut identifiers = BTreeSet::new();
        for document in &self.open_documents {
            if !identifier(&document.document_id, 128)
                || !identifier(&document.revision, 128)
                || !identifiers.insert(document.document_id.as_str())
            {
                return Err(invalid(
                    "The workspace has invalid or duplicate document identities.",
                ));
            }
        }
        if self
            .active_document_id
            .as_ref()
            .is_some_and(|active| !identifiers.contains(active.as_str()))
        {
            return Err(invalid("The active document must be an open document."));
        }
        if !self.view.editor_visible && !self.view.preview_visible {
            return Err(invalid("Keep the editor or preview visible."));
        }
        if !(10..=28).contains(&self.editor.font_size) {
            return Err(invalid("Editor font size must be between 10 and 28."));
        }
        if self.preview.as_ref().is_some_and(|preview| {
            preview.pages == 0
                || preview.pages > 100_000
                || preview.page == 0
                || preview.page > preview.pages
                || preview.zoom_percent == 0
                || preview.zoom_percent > 800
        }) {
            return Err(invalid("The preview state is outside its supported range."));
        }
        Ok(())
    }

    fn clean(&self) -> bool {
        self.open_documents
            .iter()
            .all(|document| !document.dirty && !document.conflict && !document.composing)
    }
}

impl AppCommand {
    fn validate(&self, workspace: &WorkspaceSnapshot) -> Result<()> {
        match self {
            Self::OpenManuscript { document_id } => {
                if !identifier(document_id, 128) {
                    return Err(invalid("Use an approved opaque manuscript ID."));
                }
                if !workspace.clean() {
                    return Err(Error::new(
                        "busy",
                        "Save or resolve local buffers before remote navigation.",
                    ));
                }
            }
            Self::SelectPassage {
                document_id,
                revision,
                from,
                to,
                quote,
            } => {
                if !identifier(document_id, 128)
                    || !identifier(revision, 128)
                    || from >= to
                    || *to > crate::document::MAX_TEXT
                    || quote.len() > 32_000
                    || quote.encode_utf16().count() != to - from
                {
                    return Err(invalid(
                        "Use an exact bounded UTF-16 passage and its current revision.",
                    ));
                }
                let document = workspace
                    .open_documents
                    .iter()
                    .find(|document| document.document_id == *document_id)
                    .ok_or_else(|| {
                        Error::new(
                            "unavailable",
                            "Open the shared manuscript before selecting a passage.",
                        )
                    })?;
                if document.revision != *revision
                    || workspace.active_document_id.as_ref() != Some(document_id)
                    || document.dirty
                    || document.conflict
                    || document.composing
                {
                    return Err(Error::new(
                        "stale",
                        "Read a clean current manuscript before selecting its passage.",
                    ));
                }
            }
            Self::SetWorkspaceView {
                files_visible,
                editor_visible,
                preview_visible,
                review_visible,
                outline_visible,
                logs_visible,
            } => {
                if [
                    files_visible,
                    editor_visible,
                    preview_visible,
                    review_visible,
                    outline_visible,
                    logs_visible,
                ]
                .iter()
                .all(|value| value.is_none())
                {
                    return Err(invalid("Choose at least one workspace view setting."));
                }
                if !editor_visible.unwrap_or(workspace.view.editor_visible)
                    && !preview_visible.unwrap_or(workspace.view.preview_visible)
                {
                    return Err(invalid("Keep the editor or preview visible."));
                }
            }
            Self::SetEditorPreferences {
                font_size,
                word_wrap,
            } => {
                if (font_size.is_none() && word_wrap.is_none())
                    || font_size.is_some_and(|size| !(10..=28).contains(&size))
                {
                    return Err(invalid(
                        "Choose word wrap or an editor font size between 10 and 28.",
                    ));
                }
            }
            Self::SetPreviewView {
                page,
                zoom_percent,
                fit_width,
            } => {
                if page.is_none() && zoom_percent.is_none() && fit_width.is_none() {
                    return Err(invalid("Choose at least one preview setting."));
                }
                let preview = workspace.preview.as_ref().ok_or_else(|| {
                    Error::new("unavailable", "No PDF preview is currently rendered.")
                })?;
                if page.is_some_and(|page| page == 0 || page > preview.pages)
                    || zoom_percent.is_some_and(|zoom| !(10..=400).contains(&zoom))
                    || (zoom_percent.is_some() && *fit_width == Some(true))
                {
                    return Err(invalid(
                        "Use an existing PDF page and either 10–400% zoom or fit width.",
                    ));
                }
            }
            Self::SetWindowState {
                state: WindowState::Close,
            } if !workspace.clean() => {
                return Err(Error::new(
                    "busy",
                    "Save or resolve local buffers before remotely closing UnderTree.",
                ));
            }
            Self::CompileManuscript {
                document_id,
                revision,
            } => {
                if !identifier(document_id, 128) || !identifier(revision, 128) {
                    return Err(invalid("Use an approved manuscript ID and saved revision."));
                }
                let document = workspace
                    .open_documents
                    .iter()
                    .find(|document| document.document_id == *document_id)
                    .ok_or_else(|| {
                        Error::new(
                            "unavailable",
                            "Open the shared manuscript before compiling it.",
                        )
                    })?;
                if document.revision != *revision || !workspace.clean() {
                    return Err(Error::new("stale", "Remote compilation requires current saved inputs and no unresolved local buffers."));
                }
            }
            Self::SetWindowState { .. } => {}
        }
        Ok(())
    }
}

impl ControlBridge {
    pub fn new() -> Self {
        Self {
            state: Mutex::new(BridgeState::default()),
        }
    }

    fn lock(&self) -> Result<MutexGuard<'_, BridgeState>> {
        self.state.lock().map_err(|_| {
            Error::new(
                "state",
                "Restart UnderTree to recover the UI control bridge.",
            )
        })
    }

    fn expire(state: &mut BridgeState, now: Instant) {
        for job in state.jobs.values_mut() {
            match &job.state {
                JobState::Queued(start) if now.duration_since(*start) >= QUEUED_DEADLINE => {
                    job.state = JobState::Expired
                }
                JobState::Dispatched(start) if now.duration_since(*start) >= RUNNING_DEADLINE => {
                    job.state = JobState::OutcomeUnknown
                }
                _ => {}
            }
        }
        state.queue.retain(|id| {
            state
                .jobs
                .get(id)
                .is_some_and(|job| matches!(job.state, JobState::Queued(_)))
        });
    }

    fn attached(state: &BridgeState, now: Instant) -> Result<&WorkspaceSnapshot> {
        state
            .workspace
            .as_ref()
            .filter(|(seen, _)| now.duration_since(*seen) < UI_LEASE)
            .map(|(_, workspace)| workspace)
            .ok_or_else(|| {
                Error::new(
                    "unavailable",
                    "The local workspace is not attached or its heartbeat expired.",
                )
            })
    }

    fn receipt(state: &BridgeState, request_id: &str) -> Result<Value> {
        let job = state.jobs.get(request_id).ok_or_else(|| {
            Error::new(
                "scope",
                "This command is unavailable or its grant was revoked.",
            )
        })?;
        let mut receipt = json!({"requestId":request_id,"generation":state.generation});
        match &job.state {
            JobState::Queued(_) => receipt["state"] = json!("queued"),
            JobState::Dispatched(_) => receipt["state"] = json!("dispatched"),
            JobState::Complete(outcome) => {
                let outcome = serde_json::to_value(outcome)?;
                for (key, value) in outcome
                    .as_object()
                    .ok_or_else(|| Error::new("state", "Invalid UI outcome."))?
                {
                    receipt[key] = value.clone();
                }
            }
            JobState::Expired => {
                receipt["state"] = json!("expired");
                receipt["message"] =
                    json!("The command expired before dispatch and was not applied.");
            }
            JobState::OutcomeUnknown => {
                receipt["state"] = json!("outcome_unknown");
                receipt["message"] = json!("The UI did not acknowledge completion. Inspect its state before issuing another command.");
            }
        }
        Ok(receipt)
    }

    /// Heartbeat and dequeue are one local operation; a lost reply must not dispatch twice.
    pub fn publish(&self, snapshot: WorkspaceSnapshot) -> Result<Vec<UiJob>> {
        snapshot.validate()?;
        let mut state = self.lock()?;
        let now = Instant::now();
        Self::expire(&mut state, now);
        state.workspace = Some((now, snapshot));
        let pending: Vec<_> = state.queue.drain(..).collect();
        let mut dispatched = Vec::with_capacity(pending.len());
        for request_id in pending {
            let validation = {
                let job = state
                    .jobs
                    .get(&request_id)
                    .ok_or_else(|| Error::new("state", "A queued UI command is unavailable."))?;
                job.validate(Self::attached(&state, now)?)
            };
            let job = state
                .jobs
                .get_mut(&request_id)
                .ok_or_else(|| Error::new("state", "A queued UI command is unavailable."))?;
            if let Err(error) = validation {
                job.state = JobState::Complete(UiOutcome::Rejected {
                    code: error.code.into(),
                    message: error.message,
                });
                continue;
            }
            job.state = JobState::Dispatched(now);
            dispatched.push(UiJob {
                request_id,
                command: job.command.clone(),
                ack_token: job.ack_token.clone(),
            });
        }
        Ok(dispatched)
    }

    pub fn enqueue(&self, request_id: &str, command: AppCommand) -> Result<Value> {
        if !identifier(request_id, 100) {
            return Err(invalid(
                "Use a stable request ID of up to 100 letters, digits, hyphens or underscores.",
            ));
        }
        let fingerprint = serde_json::to_string(&command)?;
        let mut state = self.lock()?;
        let now = Instant::now();
        Self::expire(&mut state, now);
        if let Some(job) = state.jobs.get(request_id) {
            if job.fingerprint != fingerprint {
                return Err(Error::new(
                    "conflict",
                    "This request ID already belongs to a different command.",
                ));
            }
            return Self::receipt(&state, request_id);
        }
        let workspace = Self::attached(&state, now)?;
        command.validate(workspace)?;
        let active_document_id = workspace.active_document_id.clone();
        if state.jobs.len() >= MAX_JOBS
            || state
                .jobs
                .values()
                .filter(|job| matches!(job.state, JobState::Queued(_) | JobState::Dispatched(_)))
                .count()
                >= MAX_PENDING
        {
            return Err(Error::new("limit", "The bounded UI command history or pending queue is full. Revoke and re-enable app controls to start a fresh history."));
        }
        state.jobs.insert(
            request_id.to_owned(),
            Job {
                command,
                fingerprint,
                ack_token: Uuid::new_v4().to_string(),
                active_document_id,
                state: JobState::Queued(now),
            },
        );
        state.queue.push_back(request_id.to_owned());
        Self::receipt(&state, request_id)
    }

    pub fn complete(&self, request_id: &str, ack_token: &str, outcome: UiOutcome) -> Result<Value> {
        let encoded = serde_json::to_string(&outcome)?;
        if encoded.len() > MAX_OUTCOME_BYTES {
            return Err(invalid("The UI acknowledgement exceeds 16 KB."));
        }
        if let UiOutcome::Rejected { code, message } = &outcome {
            if !identifier(code, 100) || message.is_empty() || message.len() > 4000 {
                return Err(invalid("Use a bounded UI rejection code and message."));
            }
        }
        let mut state = self.lock()?;
        Self::expire(&mut state, Instant::now());
        let job = state.jobs.get_mut(request_id).ok_or_else(|| {
            Error::new(
                "scope",
                "This command is unavailable or its grant was revoked.",
            )
        })?;
        if ack_token.len() != job.ack_token.len()
            || !bool::from(ack_token.as_bytes().ct_eq(job.ack_token.as_bytes()))
        {
            return Err(Error::new(
                "scope",
                "The command acknowledgement is not authorized.",
            ));
        }
        if encoded.contains(&job.ack_token) {
            return Err(invalid(
                "Keep acknowledgement credentials out of UI results.",
            ));
        }
        if let JobState::Complete(previous) = &job.state {
            if serde_json::to_vec(previous)? == serde_json::to_vec(&outcome)? {
                return Self::receipt(&state, request_id);
            }
            return Err(Error::new(
                "conflict",
                "This command already has a different outcome.",
            ));
        }
        if !matches!(job.state, JobState::Dispatched(_)) {
            return Err(Error::new("stale", "This command is not awaiting a UI acknowledgement. Inspect its receipt before retrying."));
        }
        job.state = JobState::Complete(outcome);
        Self::receipt(&state, request_id)
    }

    /// The local UI checks this immediately before applying its specific product effect.
    pub fn authorize(&self, request_id: &str, ack_token: &str) -> Result<()> {
        let mut state = self.lock()?;
        let now = Instant::now();
        Self::expire(&mut state, now);
        let job = state.jobs.get(request_id).ok_or_else(|| {
            Error::new(
                "scope",
                "This command is unavailable or its grant was revoked.",
            )
        })?;
        if ack_token.len() != job.ack_token.len()
            || !bool::from(ack_token.as_bytes().ct_eq(job.ack_token.as_bytes()))
        {
            return Err(Error::new(
                "scope",
                "The command acknowledgement is not authorized.",
            ));
        }
        if !matches!(job.state, JobState::Dispatched(_)) {
            return Err(Error::new(
                "stale",
                "This command is not awaiting UI application.",
            ));
        }
        job.validate(Self::attached(&state, now)?)
    }

    pub fn result(&self, request_id: &str) -> Result<Value> {
        let mut state = self.lock()?;
        Self::expire(&mut state, Instant::now());
        Self::receipt(&state, request_id)
    }

    pub fn workspace(&self) -> Result<Value> {
        let state = self.lock()?;
        let workspace = Self::attached(&state, Instant::now())?;
        Ok(json!({"generation":state.generation,"workspace":workspace}))
    }

    pub fn revoke(&self) -> Result<()> {
        *self.lock()? = BridgeState::default();
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn snapshot() -> WorkspaceSnapshot {
        WorkspaceSnapshot {
            open_documents: vec![DocumentState {
                document_id: "document-1".into(),
                revision: "revision-1".into(),
                dirty: false,
                conflict: false,
                composing: false,
            }],
            active_document_id: Some("document-1".into()),
            preview: Some(PreviewState {
                page: 1,
                pages: 5,
                zoom_percent: 100,
            }),
            view: WorkspaceView {
                files_visible: true,
                editor_visible: true,
                preview_visible: true,
                review_visible: false,
                outline_visible: false,
                logs_visible: false,
            },
            editor: EditorPreferences {
                font_size: 12,
                word_wrap: true,
            },
        }
    }

    fn command() -> AppCommand {
        AppCommand::SetEditorPreferences {
            font_size: Some(16),
            word_wrap: None,
        }
    }

    #[test]
    fn closed_commands_cannot_carry_source_changes_or_proxy_actions() {
        for kind in [
            "edit_source",
            "save",
            "save_editor",
            "decide",
            "format_passage",
            "undo",
            "replace_matches",
            "import_tex",
            "run_cli",
            "review_action",
        ] {
            assert!(serde_json::from_value::<AppCommand>(json!({"kind":kind})).is_err());
        }
        for field in [
            "content",
            "replacement",
            "operation",
            "script",
            "path",
            "caller",
            "grant",
        ] {
            let mut value = json!({"kind":"set_editor_preferences","fontSize":16});
            value[field] = json!("untrusted");
            assert!(serde_json::from_value::<AppCommand>(value).is_err());
        }
        let valid: AppCommand =
            serde_json::from_value(json!({"kind":"set_editor_preferences","fontSize":16})).unwrap();
        assert_eq!(valid, command());
    }

    #[test]
    fn exact_replays_keep_receipts_and_dispatch_only_once() {
        let bridge = ControlBridge::new();
        bridge.publish(snapshot()).unwrap();
        let queued = bridge.enqueue("request-1", command()).unwrap();
        assert_eq!(queued["state"], "queued");
        assert!(queued.get("ackToken").is_none());
        assert_eq!(bridge.enqueue("request-1", command()).unwrap(), queued);
        assert_eq!(
            bridge
                .enqueue(
                    "request-1",
                    AppCommand::SetWindowState {
                        state: WindowState::Focus
                    }
                )
                .unwrap_err()
                .code,
            "conflict"
        );
        let jobs = bridge.publish(snapshot()).unwrap();
        assert_eq!(jobs.len(), 1);
        assert!(bridge.publish(snapshot()).unwrap().is_empty());
        let applied = UiOutcome::Applied {
            result: json!({"fontSize":16}),
        };
        let receipt = bridge
            .complete("request-1", &jobs[0].ack_token, applied.clone())
            .unwrap();
        assert_eq!(receipt["state"], "applied");
        assert!(!receipt.to_string().contains(&jobs[0].ack_token));
        assert_eq!(
            bridge
                .complete("request-1", &jobs[0].ack_token, applied)
                .unwrap(),
            receipt
        );
        assert_eq!(bridge.enqueue("request-1", command()).unwrap(), receipt);
        assert_eq!(
            bridge
                .complete(
                    "request-1",
                    &jobs[0].ack_token,
                    UiOutcome::Rejected {
                        code: "busy".into(),
                        message: "Busy".into()
                    }
                )
                .unwrap_err()
                .code,
            "conflict"
        );
    }

    #[test]
    fn unavailable_stale_snapshots_and_invalid_arguments_fail_closed() {
        let bridge = ControlBridge::new();
        assert_eq!(bridge.workspace().unwrap_err().code, "unavailable");
        assert_eq!(
            bridge.enqueue("request-1", command()).unwrap_err().code,
            "unavailable"
        );
        let mut bad = snapshot();
        bad.open_documents.push(bad.open_documents[0].clone());
        assert!(bridge.publish(bad).is_err());
        bridge.publish(snapshot()).unwrap();
        for command in [
            AppCommand::OpenManuscript {
                document_id: "../main.typ".into(),
            },
            AppCommand::SetEditorPreferences {
                font_size: Some(29),
                word_wrap: None,
            },
            AppCommand::SetEditorPreferences {
                font_size: None,
                word_wrap: None,
            },
            AppCommand::SetWorkspaceView {
                files_visible: None,
                editor_visible: Some(false),
                preview_visible: Some(false),
                review_visible: None,
                outline_visible: None,
                logs_visible: None,
            },
            AppCommand::SetPreviewView {
                page: Some(6),
                zoom_percent: None,
                fit_width: None,
            },
            AppCommand::SetPreviewView {
                page: None,
                zoom_percent: Some(100),
                fit_width: Some(true),
            },
            AppCommand::SelectPassage {
                document_id: "document-1".into(),
                revision: "revision-1".into(),
                from: 0,
                to: 1,
                quote: "😀".into(),
            },
        ] {
            assert_eq!(
                bridge.enqueue("invalid-command", command).unwrap_err().code,
                "arguments"
            );
        }
        assert!(bridge.enqueue("", command()).is_err());
        bridge.state.lock().unwrap().workspace.as_mut().unwrap().0 = Instant::now() - UI_LEASE;
        assert_eq!(
            bridge.enqueue("request-1", command()).unwrap_err().code,
            "unavailable"
        );
    }

    #[test]
    fn navigation_close_and_compile_do_not_trigger_implicit_saves() {
        let bridge = ControlBridge::new();
        bridge.publish(snapshot()).unwrap();
        bridge
            .enqueue(
                "navigation",
                AppCommand::OpenManuscript {
                    document_id: "document-1".into(),
                },
            )
            .unwrap();
        let mut dirty = snapshot();
        dirty.open_documents[0].dirty = true;
        assert!(bridge.publish(dirty.clone()).unwrap().is_empty());
        assert_eq!(bridge.result("navigation").unwrap()["state"], "rejected");
        for command in [
            AppCommand::OpenManuscript {
                document_id: "document-1".into(),
            },
            AppCommand::SetWindowState {
                state: WindowState::Close,
            },
            AppCommand::CompileManuscript {
                document_id: "document-1".into(),
                revision: "revision-1".into(),
            },
        ] {
            assert!(bridge.enqueue("unsafe-command", command).is_err());
        }
        dirty.open_documents[0].dirty = false;
        dirty.open_documents[0].composing = true;
        bridge.publish(dirty).unwrap();
        assert!(bridge
            .enqueue(
                "selection",
                AppCommand::SelectPassage {
                    document_id: "document-1".into(),
                    revision: "revision-1".into(),
                    from: 0,
                    to: 5,
                    quote: "Hello".into()
                }
            )
            .is_err());
    }

    #[test]
    fn pending_queue_and_retained_history_are_bounded() {
        let bridge = ControlBridge::new();
        bridge.publish(snapshot()).unwrap();
        for index in 0..MAX_PENDING {
            bridge
                .enqueue(&format!("request-{index}"), command())
                .unwrap();
        }
        assert_eq!(
            bridge.enqueue("overflow", command()).unwrap_err().code,
            "limit"
        );
        let jobs = bridge.publish(snapshot()).unwrap();
        assert_eq!(jobs.len(), MAX_PENDING);
        for job in jobs {
            bridge
                .complete(
                    &job.request_id,
                    &job.ack_token,
                    UiOutcome::Applied { result: json!({}) },
                )
                .unwrap();
        }
        for index in MAX_PENDING..MAX_JOBS {
            bridge
                .enqueue(&format!("request-{index}"), command())
                .unwrap();
            let job = bridge.publish(snapshot()).unwrap().remove(0);
            bridge
                .complete(
                    &job.request_id,
                    &job.ack_token,
                    UiOutcome::Applied { result: json!({}) },
                )
                .unwrap();
        }
        assert_eq!(
            bridge.enqueue("overflow", command()).unwrap_err().code,
            "limit"
        );
    }

    #[test]
    fn stale_queued_commands_never_dispatch_and_running_timeouts_are_uncertain() {
        let bridge = ControlBridge::new();
        bridge.publish(snapshot()).unwrap();
        bridge.enqueue("expired", command()).unwrap();
        bridge
            .state
            .lock()
            .unwrap()
            .jobs
            .get_mut("expired")
            .unwrap()
            .state = JobState::Queued(Instant::now() - QUEUED_DEADLINE);
        assert!(bridge.publish(snapshot()).unwrap().is_empty());
        assert_eq!(bridge.result("expired").unwrap()["state"], "expired");
        bridge.enqueue("uncertain", command()).unwrap();
        let job = bridge.publish(snapshot()).unwrap().remove(0);
        bridge
            .state
            .lock()
            .unwrap()
            .jobs
            .get_mut("uncertain")
            .unwrap()
            .state = JobState::Dispatched(Instant::now() - RUNNING_DEADLINE);
        assert_eq!(
            bridge.result("uncertain").unwrap()["state"],
            "outcome_unknown"
        );
        assert_eq!(
            bridge
                .complete(
                    "uncertain",
                    &job.ack_token,
                    UiOutcome::Applied { result: json!({}) }
                )
                .unwrap_err()
                .code,
            "stale"
        );
    }

    #[test]
    fn forged_early_and_revoked_acknowledgements_are_denied() {
        let bridge = ControlBridge::new();
        bridge.publish(snapshot()).unwrap();
        bridge.enqueue("request-1", command()).unwrap();
        let token = bridge.state.lock().unwrap().jobs["request-1"]
            .ack_token
            .clone();
        assert_eq!(
            bridge
                .complete(
                    "request-1",
                    &token,
                    UiOutcome::Applied { result: json!({}) }
                )
                .unwrap_err()
                .code,
            "stale"
        );
        bridge.publish(snapshot()).unwrap();
        assert_eq!(
            bridge
                .complete(
                    "request-1",
                    "wrong",
                    UiOutcome::Applied { result: json!({}) }
                )
                .unwrap_err()
                .code,
            "scope"
        );
        assert_eq!(
            bridge
                .complete(
                    "request-1",
                    &token,
                    UiOutcome::Applied {
                        result: json!({"oversized":"x".repeat(MAX_OUTCOME_BYTES)})
                    }
                )
                .unwrap_err()
                .code,
            "arguments"
        );
        let generation = bridge.workspace().unwrap()["generation"].clone();
        bridge.revoke().unwrap();
        assert_eq!(bridge.workspace().unwrap_err().code, "unavailable");
        assert_eq!(
            bridge
                .complete(
                    "request-1",
                    &token,
                    UiOutcome::Applied { result: json!({}) }
                )
                .unwrap_err()
                .code,
            "scope"
        );
        assert_eq!(bridge.result("request-1").unwrap_err().code, "scope");
        bridge.publish(snapshot()).unwrap();
        assert_ne!(bridge.workspace().unwrap()["generation"], generation);
    }

    #[test]
    fn authorization_requires_a_live_dispatched_exact_job_and_current_clean_inputs() {
        let bridge = ControlBridge::new();
        bridge.publish(snapshot()).unwrap();
        bridge
            .enqueue(
                "navigation",
                AppCommand::OpenManuscript {
                    document_id: "document-1".into(),
                },
            )
            .unwrap();
        let token = bridge.state.lock().unwrap().jobs["navigation"]
            .ack_token
            .clone();
        assert_eq!(
            bridge.authorize("navigation", &token).unwrap_err().code,
            "stale"
        );
        bridge.publish(snapshot()).unwrap();
        assert_eq!(
            bridge.authorize("navigation", "forged").unwrap_err().code,
            "scope"
        );
        bridge.authorize("navigation", &token).unwrap();
        let mut dirty = snapshot();
        dirty.open_documents[0].dirty = true;
        bridge.publish(dirty).unwrap();
        assert_eq!(
            bridge.authorize("navigation", &token).unwrap_err().code,
            "busy"
        );
        bridge.publish(snapshot()).unwrap();
        bridge.state.lock().unwrap().workspace.as_mut().unwrap().0 = Instant::now() - UI_LEASE;
        assert_eq!(
            bridge.authorize("navigation", &token).unwrap_err().code,
            "unavailable"
        );
        bridge.publish(snapshot()).unwrap();
        bridge
            .state
            .lock()
            .unwrap()
            .jobs
            .get_mut("navigation")
            .unwrap()
            .state = JobState::Dispatched(Instant::now() - RUNNING_DEADLINE);
        assert_eq!(
            bridge.authorize("navigation", &token).unwrap_err().code,
            "stale"
        );
        assert_eq!(
            bridge.result("navigation").unwrap()["state"],
            "outcome_unknown"
        );
        bridge.revoke().unwrap();
        assert_eq!(
            bridge.authorize("navigation", &token).unwrap_err().code,
            "scope"
        );
    }

    #[test]
    fn preview_and_selection_cannot_target_a_different_active_manuscript() {
        let bridge = ControlBridge::new();
        let preview = AppCommand::SetPreviewView {
            page: Some(3),
            zoom_percent: None,
            fit_width: None,
        };
        bridge.publish(snapshot()).unwrap();
        bridge
            .enqueue("before-navigation", preview.clone())
            .unwrap();
        let mut navigated = snapshot();
        navigated.open_documents.push(DocumentState {
            document_id: "document-2".into(),
            revision: "revision-2".into(),
            dirty: false,
            conflict: false,
            composing: false,
        });
        navigated.active_document_id = Some("document-2".into());
        assert!(bridge.publish(navigated.clone()).unwrap().is_empty());
        assert_eq!(
            bridge.result("before-navigation").unwrap()["state"],
            "rejected"
        );
        assert_eq!(
            bridge
                .enqueue(
                    "select-inactive",
                    AppCommand::SelectPassage {
                        document_id: "document-1".into(),
                        revision: "revision-1".into(),
                        from: 0,
                        to: 5,
                        quote: "Hello".into()
                    }
                )
                .unwrap_err()
                .code,
            "stale"
        );
        bridge.enqueue("after-navigation", preview).unwrap();
        let job = bridge.publish(navigated).unwrap().remove(0);
        bridge.authorize(&job.request_id, &job.ack_token).unwrap();
        bridge.publish(snapshot()).unwrap();
        assert_eq!(
            bridge
                .authorize(&job.request_id, &job.ack_token)
                .unwrap_err()
                .code,
            "stale"
        );
    }
}
