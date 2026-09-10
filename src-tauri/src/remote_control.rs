use std::collections::HashMap;
use std::fs;
use std::io::{Read, Write};
use std::net::{Ipv4Addr, SocketAddr, SocketAddrV4, TcpListener, TcpStream};
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, mpsc};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use atomic_write_file::AtomicWriteFile;
use hmac::{Hmac, Mac};
use serde::{Deserialize, Serialize};
use sha2::Sha256;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::agent_annotations::{
    AgentAnnotationService, AgentEditingPolicy, PrepareAgentReplacementRequest,
};
use crate::compiler::{CompileRequest, CompilerAssets};
use crate::error::BoundaryError;
use crate::pdf::{self, PdfExportResult, PdfExportState, RevealPdfRequest};
use crate::project::{ProjectSnapshot, ProjectState};

pub const REMOTE_EVENT: &str = "undertree-remote-control";

const APP_IDENTIFIER: &str = "io.github.georgefejer91.UnderTree";
const ENDPOINT_FILE: &str = "remote-control.json";
const PROTOCOL_VERSION: u32 = 1;
const MAX_ENDPOINT_BYTES: u64 = 4096;
const MAX_FRAME_BYTES: usize = 8 * 1024 * 1024;
const MAX_SOURCE_BYTES: usize = 1024 * 1024;
const MAX_CONNECTIONS: usize = 8;
const MAX_PENDING_REQUESTS: usize = 64;
const MAX_HANDSHAKE_FRAME_BYTES: usize = 4096;
const SERVER_POLL_INTERVAL: Duration = Duration::from_millis(50);
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(2);
const IO_TIMEOUT: Duration = Duration::from_secs(5);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(120);
const MAX_REQUEST_TIMEOUT_MS: u64 = 120_000;
const CLAIMED_REQUEST_TTL: Duration = Duration::from_secs(10 * 60);

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(
    tag = "action",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum RemoteRequest {
    Status,
    Focus,
    ProjectOpen {
        project: PathBuf,
        source: Option<String>,
        discard_unsaved: bool,
    },
    ProjectRefresh {
        discard_unsaved: bool,
    },
    DocumentOpen {
        path: String,
        discard_unsaved: bool,
    },
    DocumentRead,
    DocumentReplace {
        source: String,
        expected_revision: u64,
    },
    AgentContext,
    AgentReplace {
        source: String,
        expected_revision: u64,
        expected_policy_version: u64,
    },
    DocumentSave,
    BibliographyCreate {
        path: String,
        discard_unsaved: bool,
    },
    Compile,
    PdfExport {
        output: PathBuf,
        overwrite: bool,
    },
    PdfReveal,
    ConvertTypstToLatex,
    Quit {
        discard_unsaved: bool,
    },
}

/// The WebView receives only the fields it must apply to the editor overlay.
/// Native-only authority such as project roots and PDF destinations remains in
/// the claimed request and is resolved later by request id.
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(
    tag = "action",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase"
)]
pub enum FrontendRemoteRequest {
    Status,
    Focus,
    ProjectOpen {
        discard_unsaved: bool,
    },
    ProjectRefresh {
        discard_unsaved: bool,
    },
    DocumentOpen {
        path: String,
        discard_unsaved: bool,
    },
    DocumentRead,
    DocumentReplace {
        source: String,
        expected_revision: u64,
    },
    AgentContext,
    AgentReplace {
        source: String,
        expected_revision: u64,
        expected_policy_version: u64,
    },
    DocumentSave,
    BibliographyCreate {
        path: String,
        discard_unsaved: bool,
    },
    Compile,
    PdfExport,
    PdfReveal,
    ConvertTypstToLatex,
    Quit {
        discard_unsaved: bool,
    },
}

impl From<&RemoteRequest> for FrontendRemoteRequest {
    fn from(request: &RemoteRequest) -> Self {
        match request {
            RemoteRequest::Status => Self::Status,
            RemoteRequest::Focus => Self::Focus,
            RemoteRequest::ProjectOpen {
                discard_unsaved, ..
            } => Self::ProjectOpen {
                discard_unsaved: *discard_unsaved,
            },
            RemoteRequest::ProjectRefresh { discard_unsaved } => Self::ProjectRefresh {
                discard_unsaved: *discard_unsaved,
            },
            RemoteRequest::DocumentOpen {
                path,
                discard_unsaved,
            } => Self::DocumentOpen {
                path: path.clone(),
                discard_unsaved: *discard_unsaved,
            },
            RemoteRequest::DocumentRead => Self::DocumentRead,
            RemoteRequest::DocumentReplace {
                source,
                expected_revision,
            } => Self::DocumentReplace {
                source: source.clone(),
                expected_revision: *expected_revision,
            },
            RemoteRequest::AgentContext => Self::AgentContext,
            RemoteRequest::AgentReplace {
                source,
                expected_revision,
                expected_policy_version,
            } => Self::AgentReplace {
                source: source.clone(),
                expected_revision: *expected_revision,
                expected_policy_version: *expected_policy_version,
            },
            RemoteRequest::DocumentSave => Self::DocumentSave,
            RemoteRequest::BibliographyCreate {
                path,
                discard_unsaved,
            } => Self::BibliographyCreate {
                path: path.clone(),
                discard_unsaved: *discard_unsaved,
            },
            RemoteRequest::Compile => Self::Compile,
            RemoteRequest::PdfExport { .. } => Self::PdfExport,
            RemoteRequest::PdfReveal => Self::PdfReveal,
            RemoteRequest::ConvertTypstToLatex => Self::ConvertTypstToLatex,
            RemoteRequest::Quit { discard_unsaved } => Self::Quit {
                discard_unsaved: *discard_unsaved,
            },
        }
    }
}

impl RemoteRequest {
    pub fn validate(&self) -> Result<(), RemoteFailure> {
        match self {
            Self::ProjectOpen {
                project, source, ..
            } => {
                if !project.is_absolute() {
                    return Err(RemoteFailure::new(
                        "invalid_remote_request",
                        "Remote project paths must be absolute.",
                    ));
                }
                if let Some(source) = source {
                    validate_relative_path(source, Some("typ"))?;
                }
            }
            Self::DocumentOpen { path, .. } => validate_relative_path(path, None)?,
            Self::DocumentReplace { source, .. } | Self::AgentReplace { source, .. } => {
                if source.len() > MAX_SOURCE_BYTES {
                    return Err(RemoteFailure::new(
                        "document_too_large",
                        "Editable documents are limited to 1 MiB.",
                    ));
                }
                if source.contains('\0') {
                    return Err(RemoteFailure::new(
                        "invalid_source",
                        "Document source cannot contain NUL bytes.",
                    ));
                }
            }
            Self::BibliographyCreate { path, .. } => {
                validate_relative_path(path, Some("bib"))?;
            }
            Self::PdfExport { output, .. } => validate_pdf_output(output)?,
            Self::Status
            | Self::Focus
            | Self::ProjectRefresh { .. }
            | Self::DocumentRead
            | Self::AgentContext
            | Self::DocumentSave
            | Self::Compile
            | Self::PdfReveal
            | Self::ConvertTypstToLatex
            | Self::Quit { .. } => {}
        }
        Ok(())
    }

    fn is_quit(&self) -> bool {
        matches!(self, Self::Quit { .. })
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RemoteEditorState {
    pub project: Option<String>,
    pub project_name: String,
    pub path: Option<String>,
    pub revision: u64,
    pub digest: String,
    pub dirty: bool,
    pub busy: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(
    tag = "kind",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum RemoteResult {
    Application {
        state: RemoteEditorState,
    },
    Document {
        state: RemoteEditorState,
        source: String,
    },
    AgentDocument {
        state: RemoteEditorState,
        source: String,
        policy: AgentEditingPolicy,
    },
    Saved {
        state: RemoteEditorState,
        conflict_path: Option<String>,
    },
    Compiled {
        state: RemoteEditorState,
        pages: usize,
        warnings: usize,
        elapsed_ms: u64,
    },
    PdfExported {
        state: RemoteEditorState,
        file_name: String,
        pages: usize,
        warnings: usize,
        elapsed_ms: u64,
    },
    Converted {
        state: RemoteEditorState,
        source: String,
        output: String,
        warnings: usize,
    },
    Acknowledged {
        action: String,
    },
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RemoteFailure {
    pub code: String,
    pub message: String,
}

impl RemoteFailure {
    pub fn new(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
        }
    }
}

impl From<BoundaryError> for RemoteFailure {
    fn from(error: BoundaryError) -> Self {
        Self::new(error.code, error.message)
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RemoteDispatch {
    pub request_id: u64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RemoteCompletion {
    pub request_id: u64,
    pub result: Option<RemoteResult>,
    pub error: Option<RemoteFailure>,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct EndpointRecord {
    version: u32,
    port: u16,
    token: String,
    pid: u32,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ClientHello {
    version: u32,
    client_nonce: String,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ServerHello {
    version: u32,
    server_nonce: String,
    proof: String,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AuthenticatedRequest {
    proof: String,
    timeout_ms: u64,
    request: RemoteRequest,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RpcResponse {
    version: u32,
    ok: bool,
    result: Option<RemoteResult>,
    error: Option<RemoteFailure>,
}

impl RpcResponse {
    fn success(result: RemoteResult) -> Self {
        Self {
            version: PROTOCOL_VERSION,
            ok: true,
            result: Some(result),
            error: None,
        }
    }

    fn failure(error: RemoteFailure) -> Self {
        Self {
            version: PROTOCOL_VERSION,
            ok: false,
            result: None,
            error: Some(error),
        }
    }
}

struct PendingRequest {
    request: RemoteRequest,
    reply: Option<mpsc::Sender<Result<RemoteResult, RemoteFailure>>>,
    phase: PendingPhase,
    created_at: Instant,
    deadline: Instant,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum PendingPhase {
    Queued,
    Dispatched,
    Claimed,
}

struct RemoteControlInner {
    next_request_id: AtomicU64,
    frontend_ready: AtomicBool,
    pending: Mutex<HashMap<u64, PendingRequest>>,
}

#[derive(Clone)]
pub struct RemoteControlState {
    inner: Arc<RemoteControlInner>,
}

impl Default for RemoteControlState {
    fn default() -> Self {
        Self {
            inner: Arc::new(RemoteControlInner {
                next_request_id: AtomicU64::new(1),
                frontend_ready: AtomicBool::new(false),
                pending: Mutex::new(HashMap::new()),
            }),
        }
    }
}

type PendingReply = mpsc::Sender<Result<RemoteResult, RemoteFailure>>;

fn expire_pending(
    pending: &mut HashMap<u64, PendingRequest>,
    now: Instant,
) -> Vec<(PendingReply, RemoteFailure)> {
    let expired = pending
        .iter()
        .filter_map(|(request_id, request)| {
            let expired = if request.phase == PendingPhase::Claimed {
                now.duration_since(request.created_at) >= CLAIMED_REQUEST_TTL
            } else {
                now >= request.deadline
            };
            expired.then_some(*request_id)
        })
        .collect::<Vec<_>>();
    expired
        .into_iter()
        .filter_map(|request_id| {
            pending.remove(&request_id).and_then(|request| {
                request.reply.map(|reply| {
                    let failure = if request.phase == PendingPhase::Claimed {
                        outcome_unknown_failure()
                    } else {
                        pending_timeout_failure()
                    };
                    (reply, failure)
                })
            })
        })
        .collect()
}

fn notify_expired(expired: Vec<(PendingReply, RemoteFailure)>) {
    for (reply, failure) in expired {
        let _ = reply.send(Err(failure));
    }
}

impl RemoteControlState {
    fn enqueue(
        &self,
        app: &AppHandle,
        request: RemoteRequest,
        reply: Option<mpsc::Sender<Result<RemoteResult, RemoteFailure>>>,
        timeout: Duration,
    ) -> Result<u64, RemoteFailure> {
        request.validate()?;
        let request_id = self.inner.next_request_id.fetch_add(1, Ordering::Relaxed);
        let dispatch = RemoteDispatch { request_id };
        let mut pending = self
            .inner
            .pending
            .lock()
            .map_err(|_| remote_internal_error())?;
        let now = Instant::now();
        let expired = expire_pending(&mut pending, now);
        if pending.len() >= MAX_PENDING_REQUESTS {
            drop(pending);
            notify_expired(expired);
            return Err(RemoteFailure::new(
                "remote_busy",
                "UnderTree's remote-control queue is full.",
            ));
        }
        let should_dispatch = self.inner.frontend_ready.load(Ordering::Acquire);
        pending.insert(
            request_id,
            PendingRequest {
                request,
                reply,
                phase: if should_dispatch {
                    PendingPhase::Dispatched
                } else {
                    PendingPhase::Queued
                },
                created_at: now,
                deadline: now + timeout,
            },
        );
        if should_dispatch && app.emit_to("main", REMOTE_EVENT, &dispatch).is_err() {
            if let Some(pending) = pending.get_mut(&request_id) {
                pending.phase = PendingPhase::Queued;
            }
            self.inner.frontend_ready.store(false, Ordering::Release);
        }
        drop(pending);
        notify_expired(expired);
        Ok(request_id)
    }

    pub fn enqueue_forwarded(&self, app: &AppHandle, request: RemoteRequest) {
        let _ = self.enqueue(app, request, None, REQUEST_TIMEOUT);
    }

    fn submit(
        &self,
        app: &AppHandle,
        request: RemoteRequest,
        timeout: Duration,
    ) -> Result<RemoteResult, RemoteFailure> {
        let (sender, receiver) = mpsc::channel();
        let request_id = self.enqueue(app, request, Some(sender), timeout)?;
        match receiver.recv_timeout(timeout) {
            Ok(result) => result,
            Err(_) => {
                let phase = self
                    .inner
                    .pending
                    .lock()
                    .map(|mut pending| {
                        match pending.get(&request_id).map(|pending| pending.phase) {
                            Some(PendingPhase::Claimed) => Some(PendingPhase::Claimed),
                            Some(PendingPhase::Queued | PendingPhase::Dispatched) => {
                                pending.remove(&request_id);
                                Some(PendingPhase::Queued)
                            }
                            None => None,
                        }
                    })
                    .unwrap_or(Some(PendingPhase::Claimed));
                match phase {
                    Some(PendingPhase::Queued | PendingPhase::Dispatched) => {
                        Err(pending_timeout_failure())
                    }
                    Some(PendingPhase::Claimed) => Err(outcome_unknown_failure()),
                    None => receiver
                        .try_recv()
                        .unwrap_or_else(|_| Err(outcome_unknown_failure())),
                }
            }
        }
    }

    fn ready(&self) -> Result<Vec<RemoteDispatch>, BoundaryError> {
        let mut pending = self
            .inner
            .pending
            .lock()
            .map_err(|_| BoundaryError::internal())?;
        self.inner.frontend_ready.store(true, Ordering::Release);
        let expired = expire_pending(&mut pending, Instant::now());
        let mut dispatches = pending
            .iter_mut()
            .filter_map(|(request_id, pending)| {
                if pending.phase == PendingPhase::Claimed {
                    return None;
                }
                pending.phase = PendingPhase::Dispatched;
                Some(RemoteDispatch {
                    request_id: *request_id,
                })
            })
            .collect::<Vec<_>>();
        dispatches.sort_by_key(|dispatch| dispatch.request_id);
        drop(pending);
        notify_expired(expired);
        Ok(dispatches)
    }

    fn claim(&self, request_id: u64) -> Result<RemoteRequest, BoundaryError> {
        let mut pending = self
            .inner
            .pending
            .lock()
            .map_err(|_| BoundaryError::internal())?;
        let expired = expire_pending(&mut pending, Instant::now());
        let result = match pending.get_mut(&request_id) {
            None => Err(BoundaryError::project(
                "remote_request_expired",
                "The remote-control request is no longer active.",
            )),
            Some(request) if request.phase != PendingPhase::Dispatched => {
                Err(BoundaryError::project(
                    "remote_request_claimed",
                    "The remote-control request was already claimed.",
                ))
            }
            Some(request) => {
                request.phase = PendingPhase::Claimed;
                Ok(request.request.clone())
            }
        };
        drop(pending);
        notify_expired(expired);
        result
    }

    fn claimed_request(&self, request_id: u64) -> Result<RemoteRequest, BoundaryError> {
        let pending = self
            .inner
            .pending
            .lock()
            .map_err(|_| BoundaryError::internal())?;
        let pending = pending.get(&request_id).ok_or_else(|| {
            BoundaryError::project(
                "remote_request_expired",
                "The remote-control request is no longer active.",
            )
        })?;
        if pending.phase != PendingPhase::Claimed {
            return Err(BoundaryError::project(
                "remote_request_not_claimed",
                "Claim the remote-control request before executing it.",
            ));
        }
        Ok(pending.request.clone())
    }

    fn complete(&self, completion: RemoteCompletion) -> Result<(), BoundaryError> {
        let outcome = match (completion.result, completion.error) {
            (Some(result), None) => Ok(result),
            (None, Some(error)) => Err(error),
            _ => {
                return Err(BoundaryError::project(
                    "invalid_remote_completion",
                    "A remote completion must contain exactly one result or error.",
                ));
            }
        };
        let mut requests = self
            .inner
            .pending
            .lock()
            .map_err(|_| BoundaryError::internal())?;
        let pending = requests.get(&completion.request_id).ok_or_else(|| {
            BoundaryError::project(
                "remote_request_expired",
                "The remote-control request is no longer active.",
            )
        })?;
        if pending.phase != PendingPhase::Claimed {
            return Err(BoundaryError::project(
                "remote_request_not_claimed",
                "Claim the remote-control request before completing it.",
            ));
        }
        validate_completion(&pending.request, &outcome)?;
        let reply = requests
            .get_mut(&completion.request_id)
            .and_then(|pending| pending.reply.take());
        if let Some(reply) = reply {
            let _ = reply.send(outcome.clone());
        }
        requests
            .remove(&completion.request_id)
            .ok_or_else(BoundaryError::internal)?;
        drop(requests);
        Ok(())
    }
}

pub struct RemoteControlServer {
    endpoint_path: PathBuf,
    token: String,
    shutdown: Arc<AtomicBool>,
    thread: Mutex<Option<JoinHandle<()>>>,
}

impl Drop for RemoteControlServer {
    fn drop(&mut self) {
        self.shutdown();
    }
}

impl RemoteControlServer {
    pub fn shutdown(&self) {
        self.shutdown.store(true, Ordering::Release);
        if let Ok(mut thread) = self.thread.lock()
            && let Some(thread) = thread.take()
        {
            let _ = thread.join();
        }
        remove_matching_endpoint(&self.endpoint_path, &self.token);
    }
}

pub fn start_server(
    app: AppHandle,
    state: RemoteControlState,
    app_config_dir: PathBuf,
) -> Result<RemoteControlServer, BoundaryError> {
    let listener = TcpListener::bind(SocketAddrV4::new(Ipv4Addr::LOCALHOST, 0)).map_err(|_| {
        BoundaryError::project(
            "remote_control_unavailable",
            "UnderTree could not start its local remote-control channel.",
        )
    })?;
    listener
        .set_nonblocking(true)
        .map_err(|_| BoundaryError::internal())?;
    let port = listener
        .local_addr()
        .map_err(|_| BoundaryError::internal())?
        .port();
    let token = random_token()?;
    let endpoint_path = app_config_dir.join(ENDPOINT_FILE);
    write_endpoint(
        &endpoint_path,
        &EndpointRecord {
            version: PROTOCOL_VERSION,
            port,
            token: token.clone(),
            pid: std::process::id(),
        },
    )?;

    let shutdown = Arc::new(AtomicBool::new(false));
    let server_shutdown = shutdown.clone();
    let server_token = token.clone();
    let server_endpoint_path = endpoint_path.clone();
    let thread = thread::Builder::new()
        .name("undertree-remote-control".into())
        .spawn(move || {
            run_server(
                listener,
                app,
                state,
                server_token,
                server_shutdown,
                server_endpoint_path,
            )
        });
    let thread = match thread {
        Ok(thread) => thread,
        Err(_) => {
            remove_matching_endpoint(&endpoint_path, &token);
            return Err(BoundaryError::internal());
        }
    };

    Ok(RemoteControlServer {
        endpoint_path,
        token,
        shutdown,
        thread: Mutex::new(Some(thread)),
    })
}

fn run_server(
    listener: TcpListener,
    app: AppHandle,
    state: RemoteControlState,
    token: String,
    shutdown: Arc<AtomicBool>,
    endpoint_path: PathBuf,
) {
    let active = Arc::new(AtomicUsize::new(0));
    while !shutdown.load(Ordering::Acquire) {
        match accept_blocking_stream(&listener) {
            Ok(Some((stream, address))) => {
                if !address.ip().is_loopback() {
                    continue;
                }
                if active.fetch_add(1, Ordering::AcqRel) >= MAX_CONNECTIONS {
                    active.fetch_sub(1, Ordering::AcqRel);
                    let _ = write_response(
                        stream,
                        RpcResponse::failure(RemoteFailure::new(
                            "remote_busy",
                            "UnderTree is handling too many remote requests.",
                        )),
                    );
                    continue;
                }
                let connection_app = app.clone();
                let connection_state = state.clone();
                let connection_token = token.clone();
                let connection_active = active.clone();
                if thread::Builder::new()
                    .name("undertree-remote-request".into())
                    .spawn(move || {
                        handle_connection(
                            stream,
                            &connection_app,
                            &connection_state,
                            &connection_token,
                        );
                        connection_active.fetch_sub(1, Ordering::AcqRel);
                    })
                    .is_err()
                {
                    active.fetch_sub(1, Ordering::AcqRel);
                }
            }
            Ok(None) => {
                thread::sleep(SERVER_POLL_INTERVAL);
            }
            Err(_) => break,
        }
    }
    remove_matching_endpoint(&endpoint_path, &token);
}

fn accept_blocking_stream(
    listener: &TcpListener,
) -> std::io::Result<Option<(TcpStream, SocketAddr)>> {
    match listener.accept() {
        Ok((stream, address)) => {
            // On Windows, a stream accepted from a nonblocking listener can
            // remain nonblocking. The framed protocol uses bounded blocking
            // reads, so normalize the accepted socket before reading a frame.
            normalize_accepted_stream(&stream)?;
            Ok(Some((stream, address)))
        }
        Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => Ok(None),
        Err(error) => Err(error),
    }
}

fn normalize_accepted_stream(stream: &TcpStream) -> std::io::Result<()> {
    stream.set_nonblocking(false)
}

fn handle_connection(
    mut stream: TcpStream,
    app: &AppHandle,
    state: &RemoteControlState,
    token: &str,
) {
    if stream.set_read_timeout(Some(HANDSHAKE_TIMEOUT)).is_err()
        || stream.set_write_timeout(Some(HANDSHAKE_TIMEOUT)).is_err()
    {
        return;
    }
    let mut should_quit = false;
    let response = read_frame_limited(&mut stream, MAX_HANDSHAKE_FRAME_BYTES)
        .and_then(|bytes| {
            serde_json::from_slice::<ClientHello>(&bytes).map_err(|_| {
                RemoteFailure::new(
                    "invalid_remote_request",
                    "The remote-control handshake was not valid JSON.",
                )
            })
        })
        .and_then(|hello| {
            if hello.version != PROTOCOL_VERSION {
                return Err(RemoteFailure::new(
                    "remote_protocol_mismatch",
                    "The CLI and running UnderTree application use different remote-control protocols.",
                ));
            }
            validate_nonce(&hello.client_nonce)?;
            let server_nonce = random_token().map_err(RemoteFailure::from)?;
            let server_hello = ServerHello {
                version: PROTOCOL_VERSION,
                proof: authentication_proof(
                    token,
                    b"undertree-server",
                    &hello.client_nonce,
                    &server_nonce,
                )?,
                server_nonce: server_nonce.clone(),
            };
            write_frame(&mut stream, &server_hello)?;
            let bytes = read_frame(&mut stream)?;
            let request: AuthenticatedRequest = serde_json::from_slice(&bytes).map_err(|_| {
                RemoteFailure::new(
                    "invalid_remote_request",
                    "The authenticated remote-control request was not valid JSON.",
                )
            })?;
            if request.timeout_ms == 0 || request.timeout_ms > MAX_REQUEST_TIMEOUT_MS {
                return Err(RemoteFailure::new(
                    "invalid_remote_timeout",
                    "Remote-control timeouts must be between 1 ms and 120 seconds.",
                ));
            }
            let expected = authenticated_request_proof(
                token,
                &server_nonce,
                &hello.client_nonce,
                request.timeout_ms,
                &request.request,
            )?;
            if !constant_time_eq(request.proof.as_bytes(), expected.as_bytes()) {
                return Err(RemoteFailure::new(
                    "remote_unauthorized",
                    "The remote-control capability is invalid.",
                ));
            }
            let _ = stream.set_write_timeout(Some(IO_TIMEOUT));
            should_quit = request.request.is_quit();
            state.submit(
                app,
                request.request,
                Duration::from_millis(request.timeout_ms),
            )
        });
    let succeeded = response.is_ok();
    let response = match response {
        Ok(result) => RpcResponse::success(result),
        Err(error) => RpcResponse::failure(error),
    };
    if write_frame(&mut stream, &response).is_ok() && succeeded && should_quit {
        drop(stream);
        app.exit(0);
    }
}

fn write_response(mut stream: TcpStream, response: RpcResponse) -> Result<(), RemoteFailure> {
    let _ = stream.set_write_timeout(Some(IO_TIMEOUT));
    write_frame(&mut stream, &response)
}

#[derive(Debug)]
pub enum RemoteClientError {
    NotRunning,
    TimedOut,
    Failure(RemoteFailure),
    Protocol,
}

pub fn send_request(
    request: RemoteRequest,
    timeout: Duration,
) -> Result<RemoteResult, RemoteClientError> {
    let endpoint_path = endpoint_path();
    send_request_with_endpoint(request, timeout, endpoint_path.as_deref())
}

fn send_request_with_endpoint(
    request: RemoteRequest,
    timeout: Duration,
    endpoint_path: Option<&Path>,
) -> Result<RemoteResult, RemoteClientError> {
    let requested_timeout_ms = u64::try_from(timeout.as_millis()).map_err(|_| {
        RemoteClientError::Failure(RemoteFailure::new(
            "invalid_remote_timeout",
            "Remote-control timeouts must be between 1 ms and 120 seconds.",
        ))
    })?;
    if requested_timeout_ms == 0 || timeout > REQUEST_TIMEOUT {
        return Err(RemoteClientError::Failure(RemoteFailure::new(
            "invalid_remote_timeout",
            "Remote-control timeouts must be between 1 ms and 120 seconds.",
        )));
    }
    let deadline = Instant::now()
        .checked_add(timeout)
        .ok_or(RemoteClientError::TimedOut)?;
    request.validate().map_err(RemoteClientError::Failure)?;
    let endpoint_path = endpoint_path.ok_or(RemoteClientError::NotRunning)?;
    let metadata =
        fs::symlink_metadata(endpoint_path).map_err(|_| RemoteClientError::NotRunning)?;
    if metadata.file_type().is_symlink()
        || !metadata.is_file()
        || metadata.len() > MAX_ENDPOINT_BYTES
    {
        return Err(RemoteClientError::Protocol);
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if metadata.permissions().mode() & 0o077 != 0 {
            return Err(RemoteClientError::Protocol);
        }
    }
    let mut endpoint_file =
        fs::File::open(endpoint_path).map_err(|_| RemoteClientError::NotRunning)?;
    let opened_metadata = endpoint_file
        .metadata()
        .map_err(|_| RemoteClientError::Protocol)?;
    if !opened_metadata.is_file() || opened_metadata.len() > MAX_ENDPOINT_BYTES {
        return Err(RemoteClientError::Protocol);
    }
    let mut bytes = Vec::with_capacity(MAX_ENDPOINT_BYTES as usize);
    (&mut endpoint_file)
        .take(MAX_ENDPOINT_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| RemoteClientError::Protocol)?;
    if bytes.len() as u64 > MAX_ENDPOINT_BYTES {
        return Err(RemoteClientError::Protocol);
    }
    let endpoint: EndpointRecord =
        serde_json::from_slice(&bytes).map_err(|_| RemoteClientError::Protocol)?;
    if endpoint.version != PROTOCOL_VERSION
        || endpoint.port == 0
        || endpoint.token.len() != 64
        || !endpoint.token.bytes().all(|byte| byte.is_ascii_hexdigit())
    {
        return Err(RemoteClientError::Protocol);
    }
    let address = SocketAddr::V4(SocketAddrV4::new(Ipv4Addr::LOCALHOST, endpoint.port));
    let connect_timeout = remaining_client_timeout(deadline)?.min(IO_TIMEOUT);
    let mut stream = TcpStream::connect_timeout(&address, connect_timeout).map_err(|error| {
        if matches!(
            error.kind(),
            std::io::ErrorKind::TimedOut | std::io::ErrorKind::WouldBlock
        ) {
            RemoteClientError::TimedOut
        } else {
            RemoteClientError::NotRunning
        }
    })?;
    let handshake_timeout = remaining_client_timeout(deadline)?.min(HANDSHAKE_TIMEOUT);
    stream
        .set_read_timeout(Some(handshake_timeout))
        .map_err(|_| RemoteClientError::Protocol)?;
    stream
        .set_write_timeout(Some(handshake_timeout))
        .map_err(|_| RemoteClientError::Protocol)?;
    let client_nonce = random_token().map_err(|_| RemoteClientError::Protocol)?;
    let hello = ClientHello {
        version: PROTOCOL_VERSION,
        client_nonce: client_nonce.clone(),
    };
    write_frame(&mut stream, &hello).map_err(|error| {
        if error.code == "remote_timeout" {
            RemoteClientError::TimedOut
        } else {
            RemoteClientError::Protocol
        }
    })?;
    let bytes = read_frame_limited(&mut stream, MAX_HANDSHAKE_FRAME_BYTES).map_err(|error| {
        if error.code == "remote_timeout" {
            RemoteClientError::TimedOut
        } else {
            RemoteClientError::Protocol
        }
    })?;
    let hello: ServerHello =
        serde_json::from_slice(&bytes).map_err(|_| RemoteClientError::Protocol)?;
    if hello.version != PROTOCOL_VERSION || validate_nonce(&hello.server_nonce).is_err() {
        return Err(RemoteClientError::Protocol);
    }
    let expected = authentication_proof(
        &endpoint.token,
        b"undertree-server",
        &client_nonce,
        &hello.server_nonce,
    )
    .map_err(|_| RemoteClientError::Protocol)?;
    if !constant_time_eq(hello.proof.as_bytes(), expected.as_bytes()) {
        return Err(RemoteClientError::Protocol);
    }
    let operation_timeout = remaining_client_timeout(deadline)?;
    let timeout_ms =
        u64::try_from(operation_timeout.as_millis()).map_err(|_| RemoteClientError::TimedOut)?;
    if timeout_ms == 0 {
        return Err(RemoteClientError::TimedOut);
    }
    stream
        .set_write_timeout(Some(operation_timeout.min(IO_TIMEOUT)))
        .map_err(|_| RemoteClientError::Protocol)?;
    let request = AuthenticatedRequest {
        proof: authenticated_request_proof(
            &endpoint.token,
            &hello.server_nonce,
            &client_nonce,
            timeout_ms,
            &request,
        )
        .map_err(|_| RemoteClientError::Protocol)?,
        timeout_ms,
        request,
    };
    write_frame(&mut stream, &request).map_err(|error| {
        if error.code == "remote_timeout" {
            RemoteClientError::TimedOut
        } else {
            RemoteClientError::Protocol
        }
    })?;
    stream
        .set_read_timeout(Some(remaining_client_timeout(deadline)?))
        .map_err(|_| RemoteClientError::Protocol)?;
    let bytes = read_frame(&mut stream).map_err(|error| {
        if error.code == "remote_timeout" {
            RemoteClientError::TimedOut
        } else {
            RemoteClientError::Protocol
        }
    })?;
    let response: RpcResponse =
        serde_json::from_slice(&bytes).map_err(|_| RemoteClientError::Protocol)?;
    if response.version != PROTOCOL_VERSION {
        return Err(RemoteClientError::Protocol);
    }
    match (response.ok, response.result, response.error) {
        (true, Some(result), None) => Ok(result),
        (false, None, Some(error)) => Err(RemoteClientError::Failure(error)),
        _ => Err(RemoteClientError::Protocol),
    }
}

fn remaining_client_timeout(deadline: Instant) -> Result<Duration, RemoteClientError> {
    let remaining = deadline.saturating_duration_since(Instant::now());
    if remaining.is_zero() {
        Err(RemoteClientError::TimedOut)
    } else {
        Ok(remaining)
    }
}

pub fn endpoint_exists() -> bool {
    endpoint_path().is_some_and(|path| path.is_file())
}

fn endpoint_path() -> Option<PathBuf> {
    dirs::config_dir().map(|directory| directory.join(APP_IDENTIFIER).join(ENDPOINT_FILE))
}

fn write_endpoint(path: &Path, endpoint: &EndpointRecord) -> Result<(), BoundaryError> {
    let parent = path.parent().ok_or_else(BoundaryError::internal)?;
    fs::create_dir_all(parent).map_err(|_| BoundaryError::internal())?;
    if let Ok(metadata) = fs::symlink_metadata(path)
        && metadata.file_type().is_symlink()
    {
        return Err(BoundaryError::project(
            "remote_control_unavailable",
            "UnderTree refused an unsafe remote-control endpoint file.",
        ));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(parent, fs::Permissions::from_mode(0o700))
            .map_err(|_| BoundaryError::internal())?;
    }
    let bytes = serde_json::to_vec(endpoint).map_err(|_| BoundaryError::internal())?;
    let options = {
        #[cfg(unix)]
        let mut options = AtomicWriteFile::options();
        #[cfg(not(unix))]
        let options = AtomicWriteFile::options();
        #[cfg(unix)]
        {
            use atomic_write_file::unix::OpenOptionsExt as AtomicOpenOptionsExt;
            use std::os::unix::fs::OpenOptionsExt;
            AtomicOpenOptionsExt::preserve_mode(&mut options, false);
            options.mode(0o600);
        }
        options
    };
    let mut file = options.open(path).map_err(|_| BoundaryError::internal())?;
    file.write_all(&bytes)
        .map_err(|_| BoundaryError::internal())?;
    file.sync_all().map_err(|_| BoundaryError::internal())?;
    file.commit().map_err(|_| BoundaryError::internal())
}

fn remove_matching_endpoint(path: &Path, token: &str) {
    let safe_file = fs::symlink_metadata(path).ok().is_some_and(|metadata| {
        metadata.is_file()
            && !metadata.file_type().is_symlink()
            && metadata.len() <= MAX_ENDPOINT_BYTES
    });
    let matches = safe_file
        && fs::read(path)
            .ok()
            .filter(|bytes| bytes.len() as u64 <= MAX_ENDPOINT_BYTES)
            .and_then(|bytes| serde_json::from_slice::<EndpointRecord>(&bytes).ok())
            .is_some_and(|endpoint| constant_time_eq(endpoint.token.as_bytes(), token.as_bytes()));
    if matches {
        let _ = fs::remove_file(path);
    }
}

fn random_token() -> Result<String, BoundaryError> {
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes).map_err(|_| BoundaryError::internal())?;
    let mut token = String::with_capacity(64);
    for byte in bytes {
        use std::fmt::Write as _;
        write!(&mut token, "{byte:02x}").map_err(|_| BoundaryError::internal())?;
    }
    Ok(token)
}

fn authentication_proof(
    token: &str,
    context: &[u8],
    first_nonce: &str,
    second_nonce: &str,
) -> Result<String, RemoteFailure> {
    let mut mac =
        Hmac::<Sha256>::new_from_slice(token.as_bytes()).map_err(|_| remote_internal_error())?;
    mac.update(context);
    mac.update(b"\0");
    mac.update(first_nonce.as_bytes());
    mac.update(b"\0");
    mac.update(second_nonce.as_bytes());
    let bytes = mac.finalize().into_bytes();
    let mut proof = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        use std::fmt::Write as _;
        write!(&mut proof, "{byte:02x}").map_err(|_| remote_internal_error())?;
    }
    Ok(proof)
}

fn authenticated_request_proof(
    token: &str,
    server_nonce: &str,
    client_nonce: &str,
    timeout_ms: u64,
    request: &RemoteRequest,
) -> Result<String, RemoteFailure> {
    let request = serde_json::to_vec(request).map_err(|_| remote_internal_error())?;
    let request_length = u64::try_from(request.len()).map_err(|_| remote_internal_error())?;
    let mut mac =
        Hmac::<Sha256>::new_from_slice(token.as_bytes()).map_err(|_| remote_internal_error())?;
    mac.update(b"undertree-client-request-v1\0");
    mac.update(server_nonce.as_bytes());
    mac.update(b"\0");
    mac.update(client_nonce.as_bytes());
    mac.update(b"\0");
    mac.update(&timeout_ms.to_be_bytes());
    mac.update(&request_length.to_be_bytes());
    mac.update(&request);
    let bytes = mac.finalize().into_bytes();
    let mut proof = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        use std::fmt::Write as _;
        write!(&mut proof, "{byte:02x}").map_err(|_| remote_internal_error())?;
    }
    Ok(proof)
}

fn validate_nonce(nonce: &str) -> Result<(), RemoteFailure> {
    if nonce.len() == 64 && nonce.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        Ok(())
    } else {
        Err(RemoteFailure::new(
            "invalid_remote_request",
            "The remote-control handshake nonce is invalid.",
        ))
    }
}

fn read_frame(stream: &mut TcpStream) -> Result<Vec<u8>, RemoteFailure> {
    read_frame_limited(stream, MAX_FRAME_BYTES)
}

fn read_frame_limited(stream: &mut TcpStream, maximum: usize) -> Result<Vec<u8>, RemoteFailure> {
    let mut length = [0u8; 4];
    stream.read_exact(&mut length).map_err(io_failure)?;
    let length = u32::from_be_bytes(length) as usize;
    if length == 0 || length > maximum {
        return Err(RemoteFailure::new(
            "remote_frame_too_large",
            "The remote-control message exceeds UnderTree's size limit.",
        ));
    }
    let mut bytes = vec![0u8; length];
    stream.read_exact(&mut bytes).map_err(io_failure)?;
    Ok(bytes)
}

fn write_frame<T: Serialize>(stream: &mut TcpStream, value: &T) -> Result<(), RemoteFailure> {
    let bytes = serde_json::to_vec(value).map_err(|_| remote_internal_error())?;
    if bytes.is_empty() || bytes.len() > MAX_FRAME_BYTES {
        return Err(RemoteFailure::new(
            "remote_frame_too_large",
            "The remote-control message exceeds UnderTree's size limit.",
        ));
    }
    let length = u32::try_from(bytes.len()).map_err(|_| remote_internal_error())?;
    stream
        .write_all(&length.to_be_bytes())
        .map_err(io_failure)?;
    stream.write_all(&bytes).map_err(io_failure)?;
    stream.flush().map_err(io_failure)
}

fn io_failure(error: std::io::Error) -> RemoteFailure {
    if matches!(
        error.kind(),
        std::io::ErrorKind::TimedOut | std::io::ErrorKind::WouldBlock
    ) {
        RemoteFailure::new("remote_timeout", "The remote-control connection timed out.")
    } else {
        RemoteFailure::new(
            "remote_connection_failed",
            "The local remote-control connection failed.",
        )
    }
}

fn remote_internal_error() -> RemoteFailure {
    RemoteFailure::new(
        "remote_internal_error",
        "UnderTree could not complete the remote-control request.",
    )
}

fn pending_timeout_failure() -> RemoteFailure {
    RemoteFailure::new(
        "remote_timeout",
        "The UnderTree editor did not start the remote request in time.",
    )
}

fn outcome_unknown_failure() -> RemoteFailure {
    RemoteFailure::new(
        "remote_outcome_unknown",
        "The remote operation started but did not finish before the deadline; do not repeat a mutating request without checking application status.",
    )
}

fn validate_completion(
    request: &RemoteRequest,
    outcome: &Result<RemoteResult, RemoteFailure>,
) -> Result<(), BoundaryError> {
    match outcome {
        Err(error) => {
            let valid_code = !error.code.is_empty()
                && error.code.len() <= 64
                && error
                    .code
                    .bytes()
                    .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'_');
            if !valid_code
                || error.message.is_empty()
                || error.message.len() > 1000
                || error.message.contains('\0')
            {
                return Err(invalid_completion());
            }
            return Ok(());
        }
        Ok(result) => {
            let shape_matches = matches!(
                (request, result),
                (RemoteRequest::Status, RemoteResult::Application { .. })
                    | (
                        RemoteRequest::ProjectOpen { .. } | RemoteRequest::ProjectRefresh { .. },
                        RemoteResult::Application { .. }
                    )
                    | (
                        RemoteRequest::DocumentOpen { .. }
                            | RemoteRequest::DocumentRead
                            | RemoteRequest::DocumentReplace { .. }
                            | RemoteRequest::BibliographyCreate { .. },
                        RemoteResult::Document { .. }
                    )
                    | (
                        RemoteRequest::AgentContext | RemoteRequest::AgentReplace { .. },
                        RemoteResult::AgentDocument { .. }
                    )
                    | (RemoteRequest::DocumentSave, RemoteResult::Saved { .. })
                    | (RemoteRequest::Compile, RemoteResult::Compiled { .. })
                    | (
                        RemoteRequest::PdfExport { .. },
                        RemoteResult::PdfExported { .. }
                    )
                    | (
                        RemoteRequest::ConvertTypstToLatex,
                        RemoteResult::Converted { .. }
                    )
                    | (
                        RemoteRequest::Focus
                            | RemoteRequest::PdfReveal
                            | RemoteRequest::Quit { .. },
                        RemoteResult::Acknowledged { .. }
                    )
            );
            if !shape_matches {
                return Err(invalid_completion());
            }
        }
    }

    let result = outcome.as_ref().map_err(|_| invalid_completion())?;
    let state = match result {
        RemoteResult::Application { state }
        | RemoteResult::Document { state, .. }
        | RemoteResult::AgentDocument { state, .. }
        | RemoteResult::Saved { state, .. }
        | RemoteResult::Compiled { state, .. }
        | RemoteResult::PdfExported { state, .. }
        | RemoteResult::Converted { state, .. } => Some(state),
        RemoteResult::Acknowledged { action } => {
            let expected = match request {
                RemoteRequest::Focus => "focus",
                RemoteRequest::PdfReveal => "pdf-reveal",
                _ => "quit",
            };
            if action != expected {
                return Err(invalid_completion());
            }
            None
        }
    };
    if let Some(state) = state {
        validate_editor_state(state)?;
    }
    match result {
        RemoteResult::Document { source, .. } => {
            if source.len() > MAX_SOURCE_BYTES || source.contains('\0') {
                return Err(invalid_completion());
            }
        }
        RemoteResult::AgentDocument {
            state,
            source,
            policy,
        } => {
            if source.len() > MAX_SOURCE_BYTES
                || source.contains('\0')
                || state.path.as_deref() != Some(policy.path.as_str())
                || !policy.validate_remote(source)
            {
                return Err(invalid_completion());
            }
        }
        RemoteResult::Saved { conflict_path, .. } => {
            if conflict_path
                .as_deref()
                .is_some_and(|path| !valid_bounded_text(path, 4096))
            {
                return Err(invalid_completion());
            }
        }
        RemoteResult::Converted { source, output, .. } => {
            if !valid_bounded_text(source, 4096) || !valid_bounded_text(output, 4096) {
                return Err(invalid_completion());
            }
        }
        RemoteResult::PdfExported { file_name, .. } => {
            let path = Path::new(file_name);
            if !valid_bounded_text(file_name, 512)
                || path.components().count() != 1
                || !path
                    .extension()
                    .is_some_and(|extension| extension.eq_ignore_ascii_case("pdf"))
            {
                return Err(invalid_completion());
            }
        }
        RemoteResult::Application { .. }
        | RemoteResult::Compiled { .. }
        | RemoteResult::Acknowledged { .. } => {}
    }
    Ok(())
}

fn validate_editor_state(state: &RemoteEditorState) -> Result<(), BoundaryError> {
    if state
        .project
        .as_deref()
        .is_some_and(|value| !valid_bounded_text(value, 32_768))
        || !valid_bounded_text(&state.project_name, 512)
        || state
            .path
            .as_deref()
            .is_some_and(|value| !valid_bounded_text(value, 4096))
        || (!state.digest.is_empty()
            && (state.digest.len() != 64
                || !state.digest.bytes().all(|byte| byte.is_ascii_hexdigit())))
    {
        return Err(invalid_completion());
    }
    Ok(())
}

fn valid_bounded_text(value: &str, maximum: usize) -> bool {
    !value.is_empty()
        && value.len() <= maximum
        && !value
            .chars()
            .any(|character| character == '\0' || character == '\r' || character == '\n')
}

fn invalid_completion() -> BoundaryError {
    BoundaryError::project(
        "invalid_remote_completion",
        "The editor returned an invalid remote-control completion.",
    )
}

fn constant_time_eq(left: &[u8], right: &[u8]) -> bool {
    if left.len() != right.len() {
        return false;
    }
    left.iter()
        .zip(right)
        .fold(0u8, |difference, (left, right)| difference | (left ^ right))
        == 0
}

fn validate_relative_path(
    path: &str,
    expected_extension: Option<&str>,
) -> Result<(), RemoteFailure> {
    let path = Path::new(path);
    if path.as_os_str().is_empty()
        || path.is_absolute()
        || path
            .components()
            .any(|component| !matches!(component, Component::Normal(_)))
    {
        return Err(RemoteFailure::new(
            "path_denied",
            "Remote document paths must remain relative to the active project.",
        ));
    }
    if let Some(expected) = expected_extension
        && !path
            .extension()
            .is_some_and(|extension| extension.eq_ignore_ascii_case(expected))
    {
        return Err(RemoteFailure::new(
            "invalid_document_type",
            format!("The remote path must end in .{expected}."),
        ));
    }
    Ok(())
}

fn validate_pdf_output(path: &Path) -> Result<(), RemoteFailure> {
    if path.as_os_str().to_string_lossy().len() > 32_768
        || !path.is_absolute()
        || path.file_name().is_none()
        || !path
            .extension()
            .is_some_and(|extension| extension.eq_ignore_ascii_case("pdf"))
    {
        return Err(RemoteFailure::new(
            "pdf_destination_invalid",
            "Remote PDF output must be an absolute path ending in .pdf.",
        ));
    }
    let parent = path.parent().ok_or_else(|| {
        RemoteFailure::new(
            "pdf_destination_invalid",
            "Remote PDF output must have an existing local parent folder.",
        )
    })?;
    let canonical_parent = parent.canonicalize().map_err(|_| {
        RemoteFailure::new(
            "pdf_destination_invalid",
            "The remote PDF output folder is unavailable.",
        )
    })?;
    if !canonical_parent.is_dir() || canonical_parent != parent {
        return Err(RemoteFailure::new(
            "pdf_destination_invalid",
            "Remote PDF output must use a canonical existing local folder.",
        ));
    }
    Ok(())
}

#[tauri::command]
pub fn remote_control_claim(
    app: AppHandle,
    state: State<'_, RemoteControlState>,
    request_id: u64,
) -> Result<FrontendRemoteRequest, BoundaryError> {
    let request = state.claim(request_id)?;
    if matches!(
        &request,
        RemoteRequest::Focus | RemoteRequest::ProjectOpen { .. }
    ) && let Some(window) = app.get_webview_window("main")
    {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
    Ok(FrontendRemoteRequest::from(&request))
}

#[tauri::command]
pub fn remote_control_ready(
    state: State<'_, RemoteControlState>,
) -> Result<Vec<RemoteDispatch>, BoundaryError> {
    state.ready()
}

#[tauri::command]
pub async fn remote_control_open_project(
    state: State<'_, RemoteControlState>,
    projects: State<'_, ProjectState>,
    request_id: u64,
) -> Result<ProjectSnapshot, BoundaryError> {
    let (project, source) = match state.claimed_request(request_id)? {
        RemoteRequest::ProjectOpen {
            project, source, ..
        } => (project, source),
        _ => {
            return Err(BoundaryError::project(
                "remote_request_mismatch",
                "The pending remote request cannot open a project.",
            ));
        }
    };
    let projects = projects.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        projects.select_with_preferred(project, source.as_deref())
    })
    .await
    .map_err(|_| BoundaryError::internal())?
}

/// Validates and advances the durable AI editing policy before the WebView is
/// allowed to replace live source. The candidate source is taken from the
/// already authenticated, claimed request rather than from WebView arguments.
#[tauri::command]
pub async fn remote_control_prepare_agent_replace(
    state: State<'_, RemoteControlState>,
    annotations: State<'_, AgentAnnotationService>,
    projects: State<'_, ProjectState>,
    request_id: u64,
    path: String,
    current_source: String,
) -> Result<AgentEditingPolicy, BoundaryError> {
    let (replacement_source, expected_policy_version) = match state.claimed_request(request_id)? {
        RemoteRequest::DocumentReplace { source, .. } => (source, None),
        RemoteRequest::AgentReplace {
            source,
            expected_policy_version,
            ..
        } => (source, Some(expected_policy_version)),
        _ => {
            return Err(BoundaryError::project(
                "remote_request_mismatch",
                "The pending remote request cannot replace agent-governed source.",
            ));
        }
    };
    let root = projects.root()?.ok_or_else(|| {
        BoundaryError::project("project_required", "Choose a Typst project first.")
    })?;
    let annotations = annotations.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        annotations.prepare_replacement(
            &root,
            PrepareAgentReplacementRequest {
                path,
                current_source,
                replacement_source,
                expected_policy_version,
            },
        )
    })
    .await
    .map_err(|_| BoundaryError::internal())?
}

#[tauri::command]
pub async fn remote_control_export_pdf(
    state: State<'_, RemoteControlState>,
    compiler: State<'_, CompilerAssets>,
    projects: State<'_, ProjectState>,
    exports: State<'_, PdfExportState>,
    request_id: u64,
    request: CompileRequest,
) -> Result<PdfExportResult, BoundaryError> {
    let (destination, overwrite) = match state.claimed_request(request_id)? {
        RemoteRequest::PdfExport { output, overwrite } => (output, overwrite),
        _ => {
            return Err(BoundaryError::project(
                "remote_request_mismatch",
                "The pending remote request cannot export a PDF.",
            ));
        }
    };
    let document_path = request.path.clone();
    let project_root = if request.path.is_some() {
        projects.root()?
    } else {
        None
    };
    let compiler = compiler.inner().clone();
    let exports = exports.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let saved = pdf::export_document(&compiler, request, project_root, destination, overwrite)?;
        exports.remember(saved.path, document_path, saved.result.revision)?;
        Ok(saved.result)
    })
    .await
    .map_err(|_| BoundaryError::internal())?
}

#[tauri::command]
pub async fn remote_control_reveal_pdf(
    state: State<'_, RemoteControlState>,
    exports: State<'_, PdfExportState>,
    request_id: u64,
    request: RevealPdfRequest,
) -> Result<(), BoundaryError> {
    if !matches!(state.claimed_request(request_id)?, RemoteRequest::PdfReveal) {
        return Err(BoundaryError::project(
            "remote_request_mismatch",
            "The pending remote request cannot reveal a PDF.",
        ));
    }
    let exports = exports.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let path = exports.current_path(&request)?;
        pdf::reveal_pdf(path)
    })
    .await
    .map_err(|_| BoundaryError::internal())?
}

#[tauri::command]
pub fn remote_control_complete(
    state: State<'_, RemoteControlState>,
    completion: RemoteCompletion,
) -> Result<(), BoundaryError> {
    state.complete(completion)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn remote_request_validation_confines_paths_and_source_size() {
        assert!(
            RemoteRequest::DocumentOpen {
                path: "chapters/intro.typ".into(),
                discard_unsaved: false,
            }
            .validate()
            .is_ok()
        );
        assert!(
            RemoteRequest::DocumentOpen {
                path: "../secret.typ".into(),
                discard_unsaved: false,
            }
            .validate()
            .is_err()
        );
        assert!(
            RemoteRequest::BibliographyCreate {
                path: "references.txt".into(),
                discard_unsaved: false,
            }
            .validate()
            .is_err()
        );
        assert!(
            RemoteRequest::DocumentReplace {
                source: "x".repeat(MAX_SOURCE_BYTES + 1),
                expected_revision: 1,
            }
            .validate()
            .is_err()
        );
    }

    #[test]
    fn pdf_request_keeps_its_destination_native_and_bounded() {
        let directory = tempfile::tempdir().expect("temporary PDF output directory");
        let output = directory
            .path()
            .canonicalize()
            .expect("temporary directory should canonicalize")
            .join("paper.pdf");
        let request = RemoteRequest::PdfExport {
            output: output.clone(),
            overwrite: false,
        };
        assert!(request.validate().is_ok());

        let frontend = FrontendRemoteRequest::from(&request);
        let json = serde_json::to_string(&frontend).expect("serialize redacted request");
        assert_eq!(json, r#"{"action":"pdf-export"}"#);
        assert!(!json.contains(&output.to_string_lossy().into_owned()));

        let relative = RemoteRequest::PdfExport {
            output: PathBuf::from("paper.pdf"),
            overwrite: false,
        };
        assert!(relative.validate().is_err());
        let wrong_extension = RemoteRequest::PdfExport {
            output: directory.path().join("paper.txt"),
            overwrite: false,
        };
        assert!(wrong_extension.validate().is_err());
    }

    #[test]
    fn pdf_completion_shape_is_typed() {
        let directory = tempfile::tempdir().expect("temporary PDF output directory");
        let request = RemoteRequest::PdfExport {
            output: directory
                .path()
                .canonicalize()
                .expect("temporary directory should canonicalize")
                .join("paper.pdf"),
            overwrite: false,
        };
        let state = RemoteEditorState {
            project: None,
            project_name: "Scratch workspace".into(),
            path: Some("main.typ".into()),
            revision: 4,
            digest: "a".repeat(64),
            dirty: true,
            busy: false,
        };
        let exported = RemoteResult::PdfExported {
            state: state.clone(),
            file_name: "paper.pdf".into(),
            pages: 1,
            warnings: 0,
            elapsed_ms: 12,
        };
        assert!(validate_completion(&request, &Ok(exported)).is_ok());
        assert!(
            validate_completion(
                &request,
                &Ok(RemoteResult::Compiled {
                    state,
                    pages: 1,
                    warnings: 0,
                    elapsed_ms: 12,
                }),
            )
            .is_err()
        );
    }

    #[test]
    fn rpc_contract_round_trips_without_exposing_an_untyped_command() {
        let request = AuthenticatedRequest {
            proof: "a".repeat(64),
            timeout_ms: 30_000,
            request: RemoteRequest::ProjectOpen {
                project: PathBuf::from("C:\\Writing"),
                source: Some("paper.typ".into()),
                discard_unsaved: false,
            },
        };
        let json = serde_json::to_vec(&request).expect("serialize request");
        let restored: AuthenticatedRequest =
            serde_json::from_slice(&json).expect("deserialize request");
        assert_eq!(restored.proof, request.proof);
        assert_eq!(restored.timeout_ms, request.timeout_ms);
        assert_eq!(restored.request, request.request);
    }

    #[test]
    fn capability_comparison_rejects_length_and_content_changes() {
        assert!(constant_time_eq(b"same", b"same"));
        assert!(!constant_time_eq(b"same", b"diff"));
        assert!(!constant_time_eq(b"same", b"same!"));
    }

    #[test]
    fn broker_dispatches_and_claims_each_request_exactly_once() {
        let state = RemoteControlState::default();
        let (sender, receiver) = mpsc::channel();
        let now = Instant::now();
        state.inner.pending.lock().expect("pending lock").insert(
            7,
            PendingRequest {
                request: RemoteRequest::Focus,
                reply: Some(sender),
                phase: PendingPhase::Queued,
                created_at: now,
                deadline: now + REQUEST_TIMEOUT,
            },
        );

        let first = state.ready().expect("first ready");
        assert_eq!(first.len(), 1);
        assert_eq!(first[0].request_id, 7);
        let replay = state.ready().expect("reload ready");
        assert_eq!(replay.len(), 1);
        assert_eq!(replay[0].request_id, 7);
        assert_eq!(state.claim(7).expect("first claim"), RemoteRequest::Focus);
        assert!(state.ready().expect("claimed ready").is_empty());
        assert!(state.claim(7).is_err());

        let result = RemoteResult::Acknowledged {
            action: "focus".into(),
        };
        state
            .complete(RemoteCompletion {
                request_id: 7,
                result: Some(result.clone()),
                error: None,
            })
            .expect("complete claimed request");
        assert_eq!(
            receiver.recv().expect("reply").expect("successful reply"),
            result
        );
        assert!(state.claim(7).is_err());
    }

    #[test]
    fn broker_never_dispatches_or_claims_an_expired_request() {
        let state = RemoteControlState::default();
        let (sender, receiver) = mpsc::channel();
        let now = Instant::now();
        state.inner.pending.lock().expect("pending lock").insert(
            8,
            PendingRequest {
                request: RemoteRequest::DocumentSave,
                reply: Some(sender),
                phase: PendingPhase::Dispatched,
                created_at: now - Duration::from_secs(2),
                deadline: now - Duration::from_secs(1),
            },
        );

        assert!(state.ready().expect("ready after expiry").is_empty());
        assert!(state.claim(8).is_err());
        let error = receiver
            .recv()
            .expect("expiry reply")
            .expect_err("expired request must fail");
        assert_eq!(error.code, "remote_timeout");
    }

    #[test]
    fn mutual_authentication_proofs_bind_context_and_both_nonces() {
        let token = "a".repeat(64);
        let client = "b".repeat(64);
        let server = "c".repeat(64);
        let server_proof = authentication_proof(&token, b"undertree-server", &client, &server)
            .expect("server proof");
        assert_eq!(server_proof.len(), 64);
        assert_eq!(
            server_proof,
            authentication_proof(&token, b"undertree-server", &client, &server,)
                .expect("same proof")
        );
        assert_ne!(
            server_proof,
            authentication_proof(&token, b"undertree-client", &server, &client,)
                .expect("client proof")
        );

        let request = RemoteRequest::DocumentSave;
        let request_proof = authenticated_request_proof(&token, &server, &client, 30_000, &request)
            .expect("request proof");
        assert_ne!(
            request_proof,
            authenticated_request_proof(&token, &server, &client, 30_001, &request,)
                .expect("changed timeout proof")
        );
        assert_ne!(
            request_proof,
            authenticated_request_proof(
                &token,
                &server,
                &client,
                30_000,
                &RemoteRequest::DocumentRead,
            )
            .expect("changed request proof")
        );
    }

    #[test]
    fn event_contract_uses_kebab_actions_and_camel_case_fields() {
        let request = RemoteRequest::DocumentReplace {
            source: "= Draft".into(),
            expected_revision: 42,
        };
        let json = serde_json::to_string(&request).expect("serialize request");
        assert!(json.contains("\"action\":\"document-replace\""));
        assert!(json.contains("\"expectedRevision\":42"));
        assert!(!json.contains("expected_revision"));

        let agent = RemoteRequest::AgentReplace {
            source: "= Revised draft".into(),
            expected_revision: 43,
            expected_policy_version: 7,
        };
        let json = serde_json::to_string(&agent).expect("serialize agent request");
        assert!(json.contains("\"action\":\"agent-replace\""));
        assert!(json.contains("\"expectedRevision\":43"));
        assert!(json.contains("\"expectedPolicyVersion\":7"));
        assert!(!json.contains("expected_policy_version"));
    }

    #[test]
    fn authenticated_tcp_client_completes_the_framed_protocol() {
        let directory = tempfile::tempdir().expect("temporary endpoint directory");
        let endpoint_path = directory.path().join(ENDPOINT_FILE);
        let listener = TcpListener::bind(SocketAddrV4::new(Ipv4Addr::LOCALHOST, 0))
            .expect("bind test listener");
        let port = listener.local_addr().expect("test listener address").port();
        let token = "a".repeat(64);
        write_endpoint(
            &endpoint_path,
            &EndpointRecord {
                version: PROTOCOL_VERSION,
                port,
                token: token.clone(),
                pid: std::process::id(),
            },
        )
        .expect("write test endpoint");

        let server = thread::spawn(move || {
            let (mut stream, address) = listener.accept().expect("accept test client");
            assert!(address.ip().is_loopback());
            stream
                .set_read_timeout(Some(Duration::from_secs(2)))
                .expect("test read timeout");
            stream
                .set_write_timeout(Some(Duration::from_secs(2)))
                .expect("test write timeout");
            let hello: ClientHello = serde_json::from_slice(
                &read_frame_limited(&mut stream, MAX_HANDSHAKE_FRAME_BYTES)
                    .expect("read client hello"),
            )
            .expect("parse client hello");
            let server_nonce = "c".repeat(64);
            write_frame(
                &mut stream,
                &ServerHello {
                    version: PROTOCOL_VERSION,
                    server_nonce: server_nonce.clone(),
                    proof: authentication_proof(
                        &token,
                        b"undertree-server",
                        &hello.client_nonce,
                        &server_nonce,
                    )
                    .expect("server proof"),
                },
            )
            .expect("write server hello");
            let request: AuthenticatedRequest =
                serde_json::from_slice(&read_frame(&mut stream).expect("read request"))
                    .expect("parse request");
            assert_eq!(request.request, RemoteRequest::Focus);
            assert_eq!(
                request.proof,
                authenticated_request_proof(
                    &token,
                    &server_nonce,
                    &hello.client_nonce,
                    request.timeout_ms,
                    &request.request,
                )
                .expect("client proof")
            );
            write_frame(
                &mut stream,
                &RpcResponse::success(RemoteResult::Acknowledged {
                    action: "focus".into(),
                }),
            )
            .expect("write response");
        });

        let result = send_request_with_endpoint(
            RemoteRequest::Focus,
            Duration::from_secs(2),
            Some(&endpoint_path),
        )
        .expect("authenticated request succeeds");
        assert_eq!(
            result,
            RemoteResult::Acknowledged {
                action: "focus".into(),
            }
        );
        server.join().expect("test server completes");
    }

    #[test]
    fn nonblocking_listener_normalizes_accepted_stream_before_framed_reads() {
        let listener = TcpListener::bind(SocketAddrV4::new(Ipv4Addr::LOCALHOST, 0))
            .expect("bind test listener");
        listener
            .set_nonblocking(true)
            .expect("set test listener nonblocking");
        let address = listener.local_addr().expect("test listener address");
        let client = thread::spawn(move || {
            let mut stream = TcpStream::connect(address).expect("connect test client");
            thread::sleep(Duration::from_millis(100));
            stream.write_all(b"x").expect("write delayed test byte");
        });

        let (mut stream, peer) = loop {
            match accept_blocking_stream(&listener).expect("accept test client") {
                Some(connection) => break connection,
                None => thread::sleep(Duration::from_millis(5)),
            }
        };
        assert!(peer.ip().is_loopback());
        stream
            .set_nonblocking(true)
            .expect("force accepted stream nonblocking on every platform");
        normalize_accepted_stream(&stream).expect("restore accepted stream blocking mode");
        stream
            .set_read_timeout(Some(Duration::from_secs(2)))
            .expect("set test read timeout");
        let mut byte = [0_u8; 1];
        stream
            .read_exact(&mut byte)
            .expect("accepted stream waits for the delayed frame byte");
        assert_eq!(byte, [b'x']);
        client.join().expect("test client completes");
    }
}
