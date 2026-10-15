use super::*;
use axum::body::Bytes;
use base64::Engine;
use futures_core::Stream;
use sha2::{Digest, Sha256};
use std::pin::Pin;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::task::{Context, Poll};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

const MAX_PDF: usize = 16 * 1024 * 1024;
const MAX_BYTES: usize = 4 * MAX_PDF;
const MAX_TICKETS: usize = 4;
const MAX_STREAMS: usize = 2;
const MAX_AUTH_WORKERS: usize = 4;
const MAX_DOWNLOADS: usize = 4;
const TICKET_LIFE: Duration = Duration::from_secs(300);
const STREAM_LIFE: Duration = Duration::from_secs(60);
const CHUNK: usize = 64 * 1024;

#[derive(Clone)]
struct Permission {
    generation: String,
    app_generation: String,
    owner: String,
    roots: BTreeMap<String, RootGrant>,
}

#[derive(Clone)]
struct RootGrant {
    path: PathBuf,
    identity: (u64, u64),
}
impl RootGrant {
    fn matches(&self, project: &Project) -> bool {
        self.path == project.root
            && project_tree::root_identity(&project.root)
                .is_ok_and(|identity| identity == self.identity)
    }
}

#[derive(Clone)]
struct Scope {
    permission: Permission,
    project: Project,
    path: String,
    document_id: String,
    source_epoch: u64,
    root: RootObservation,
    origin: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PdfInfo {
    available: bool,
    revision: String,
    artifact_id: String,
    sha256: String,
    bytes: usize,
}

struct Artifact {
    bytes: Vec<u8>,
    budget: Arc<AtomicUsize>,
}
impl Drop for Artifact {
    fn drop(&mut self) {
        self.budget.fetch_sub(self.bytes.len(), Ordering::AcqRel);
    }
}

#[derive(Clone)]
struct Ticket {
    scope: Scope,
    info: PdfInfo,
    artifact: Arc<Artifact>,
    expires: Instant,
    expires_at: u64,
    downloads: usize,
}

pub(super) struct PdfExportState {
    generation: String,
    permission: Option<Permission>,
    tickets: BTreeMap<String, Ticket>,
    work: Arc<Mutex<()>>,
    budget: Arc<AtomicUsize>,
    active: Arc<AtomicUsize>,
    authorize: Arc<tokio::sync::Semaphore>,
}
impl Default for PdfExportState {
    fn default() -> Self {
        Self {
            generation: Uuid::new_v4().to_string(),
            permission: None,
            tickets: BTreeMap::new(),
            work: Arc::new(Mutex::new(())),
            budget: Arc::new(AtomicUsize::new(0)),
            active: Arc::new(AtomicUsize::new(0)),
            authorize: Arc::new(tokio::sync::Semaphore::new(MAX_AUTH_WORKERS)),
        }
    }
}

fn denied() -> Error {
    Error::new(
        "scope",
        "PDF export is disabled, revoked, or outside its approved project roots.",
    )
}
fn unavailable() -> Error {
    Error::new(
        "unavailable",
        "No verified saved PDF is available. Compile explicitly before requesting a download.",
    )
}

impl Service {
    pub(super) fn revoke_pdf_exports(&self) -> Result<()> {
        let mut state = lock(&self.pdf_exports)?;
        state.generation = Uuid::new_v4().to_string();
        state.permission = None;
        state.tickets.clear();
        Ok(())
    }

    fn pdf_tunnel_live(&self) -> Result<()> {
        let mut tunnel = self
            .tunnel
            .try_lock()
            .map_err(|_| Error::new("busy", "The connection is processing another operation."))?;
        if tunnel
            .as_mut()
            .is_none_or(|t| !t.child.try_wait().is_ok_and(|status| status.is_none()))
        {
            return Err(denied());
        }
        Ok(())
    }

    fn eligible_pdf_projects(&self) -> Result<Value> {
        let shared = self.current_shared()?;
        let mut counts = BTreeMap::<String, usize>::new();
        for (project, _, _, _) in shared.values() {
            *counts.entry(project.clone()).or_default() += 1;
        }
        let mut projects = Vec::new();
        for (id, count) in counts {
            let Ok(project) = self.project(&id) else {
                continue;
            };
            projects.push(
                json!({"project":id,"name":project.name,"root":project.root,"sharedCount":count}),
            );
        }
        Ok(json!(projects))
    }

    pub(super) fn pdf_export_status(&self) -> Result<Value> {
        let authority = self.pdf_app_authority(false).ok();
        let state = lock(&self.pdf_exports)?;
        let permission = state.permission.as_ref().filter(|p| {
            authority.as_ref().is_some_and(|(generation, owner, _)| {
                p.app_generation == *generation && p.owner == *owner
            })
        });
        let mut result = json!({"enabled":permission.is_some(),
            "generation":state.generation,
            "projects":permission.map(|p|p.roots.keys().cloned().collect::<Vec<_>>()).unwrap_or_default(),
            "limits":{"maxPdfBytes":MAX_PDF,"maxRetainedBytes":MAX_BYTES,"maxTickets":MAX_TICKETS,
                "maxConcurrentDownloads":MAX_STREAMS,"expiresInSeconds":TICKET_LIFE.as_secs()}});
        drop(state);
        result["eligibleProjects"] = self.eligible_pdf_projects()?;
        Ok(result)
    }

    pub(super) fn set_pdf_export_permission(
        &self,
        owner: &str,
        expected_generation: &str,
        expected_export_generation: &str,
        enabled: bool,
        projects: Vec<String>,
    ) -> Result<()> {
        self.assert_editor_owner(owner)?;
        let (app_generation, current_owner, _) = self.pdf_app_authority(false)?;
        if current_owner != owner || app_generation != expected_generation {
            return Err(denied());
        }
        if lock(&self.pdf_exports)?.generation != expected_export_generation {
            return Err(denied());
        }
        let mut roots = BTreeMap::new();
        if !enabled {
            if !projects.is_empty() {
                return Err(Error::new(
                    "arguments",
                    "Disabled PDF export takes an empty project list.",
                ));
            }
        } else {
            self.pdf_tunnel_live()?;
            let (generation, current_owner, _) = self.pdf_app_authority(true)?;
            if generation != expected_generation || current_owner != owner {
                return Err(denied());
            }
            if projects.is_empty() || projects.len() > 20 {
                return Err(Error::new(
                    "arguments",
                    "Choose between one and twenty currently shared projects.",
                ));
            }
            let shared = self.current_shared()?;
            for id in projects {
                if !shared.values().any(|(project, _, _, _)| project == &id)
                    || roots.contains_key(&id)
                {
                    return Err(denied());
                }
                let project = self.project(&id)?;
                let identity = project_tree::root_identity(&project.root)?;
                roots.insert(
                    id,
                    RootGrant {
                        path: project.root,
                        identity,
                    },
                );
            }
            for (id, root) in &roots {
                if !root.matches(&self.project(id)?) {
                    return Err(denied());
                }
            }
        }
        let _authority = self.pdf_permission_guard(owner, expected_generation, enabled)?;
        let mut state = lock(&self.pdf_exports)?;
        if state.generation != expected_export_generation {
            return Err(denied());
        }
        state.generation = Uuid::new_v4().to_string();
        state.tickets.clear();
        state.permission = enabled.then(|| Permission {
            generation: state.generation.clone(),
            app_generation,
            owner: owner.into(),
            roots,
        });
        Ok(())
    }

    fn pdf_scope(&self, document_id: &str) -> Result<Scope> {
        let (app_generation, owner, origin) = self.pdf_app_authority(true)?;
        let (project, path, source_epoch, root) =
            self.shared_source(document_id).map_err(|_| denied())?;
        let project = self.project(&project)?;
        let file = self.path(&project, &path, false)?;
        if file.extension().and_then(|e| e.to_str()) != Some("typ") {
            return Err(unavailable());
        }
        match fs::symlink_metadata(journal_path(&file)) {
            Ok(_) => {
                return Err(Error::new(
                    "busy",
                    "Resolve the pending local save before exporting its PDF.",
                ))
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => (),
            Err(e) => return Err(e.into()),
        }
        let permission = lock(&self.pdf_exports)?
            .permission
            .clone()
            .ok_or_else(denied)?;
        if permission.app_generation != app_generation
            || permission.owner != owner
            || permission
                .roots
                .get(&project.id)
                .is_none_or(|root| !root.matches(&project))
        {
            return Err(denied());
        }
        Ok(Scope {
            permission,
            project,
            path,
            document_id: document_id.into(),
            source_epoch,
            root,
            origin,
        })
    }

    fn check_pdf_scope(&self, scope: &Scope) -> Result<()> {
        let current = self.pdf_scope(&scope.document_id)?;
        if current.permission.generation != scope.permission.generation
            || current.project.root != scope.project.root
            || current.path != scope.path
            || current.project.id != scope.project.id
            || current.source_epoch != scope.source_epoch
            || current.root != scope.root
        {
            return Err(denied());
        }
        Ok(())
    }

    fn saved_pdf(&self, scope: &Scope) -> Result<(PdfInfo, Vec<u8>)> {
        let result = self.preview_pdf(&scope.project.id, &scope.path)?;
        if result["available"] != true {
            return Err(unavailable());
        }
        if result["externalDependencyCount"] != 0 {
            return Err(Error::new("unsupported_scope","This PDF uses external package-cache inputs outside the selected project roots. PDF export is unavailable under the current project-input permission."));
        }
        if result["current"] != true
            || result["sourceEpoch"].as_u64().unwrap_or(0) != scope.source_epoch
            || result.get("expectedRoot") != Some(&json!(scope.root))
        {
            return Err(Error::new("stale","The saved PDF no longer matches its verified saved project inputs. Build explicitly before exporting."));
        }
        let encoded = result["base64"].as_str().ok_or_else(unavailable)?;
        if encoded.len() > MAX_PDF.div_ceil(3) * 4 {
            return Err(Error::new("limit", "The saved PDF exceeds 16 MiB."));
        }
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(encoded)
            .map_err(|_| unavailable())?;
        if bytes.len() > MAX_PDF || !bytes.starts_with(b"%PDF-") {
            return Err(unavailable());
        }
        let info = PdfInfo {
            available: true,
            revision: result["revision"].as_str().ok_or_else(unavailable)?.into(),
            artifact_id: digest(encoded),
            sha256: format!("{:x}", Sha256::digest(&bytes)),
            bytes: bytes.len(),
        };
        self.check_pdf_scope(scope)?;
        Ok((info, bytes))
    }

    pub(super) fn pdf_remote(&self, name: &str, arguments: Value) -> Result<Value> {
        self.pdf_app_authority(false)?;
        let work = lock(&self.pdf_exports)?.work.clone();
        let _work = work
            .try_lock()
            .map_err(|_| Error::new("busy", "Another PDF inspection or export is running."))?;
        if name == "list_manuscripts" {
            if arguments.as_object().is_none_or(|a| !a.is_empty()) {
                return Err(Error::new("arguments", "This tool takes no arguments."));
            }
            let (app_generation, _, _) = self.pdf_app_authority(false)?;
            let export_permission = lock(&self.pdf_exports)?.permission.clone();
            let shared = self.current_shared()?;
            let mut results = Vec::new();
            for (id, (project, path, _, _)) in shared {
                let approved = self.project(&project)?;
                self.path(&approved, &path, false)?;
                let mut item = json!({"documentId":id,"path":path});
                let permitted = export_permission.as_ref().is_some_and(|p| {
                    p.app_generation == app_generation
                        && p.roots
                            .get(&project)
                            .is_some_and(|root| root.matches(&approved))
                });
                if permitted {
                    item["savedPdf"] = match self
                        .pdf_scope(&id)
                        .and_then(|scope| self.saved_pdf(&scope))
                    {
                        Ok((info, _)) => json!(info),
                        Err(error) if error.code == "unsupported_scope" => {
                            json!({"available":false,"code":"unavailable","reason":"external_dependencies"})
                        }
                        Err(error) => {
                            json!({"available":false,"code":if error.code=="stale" {"stale"}else{"unavailable"}})
                        }
                    };
                }
                results.push(item);
            }
            if self.pdf_app_authority(false)?.0 != app_generation {
                return Err(denied());
            }
            if lock(&self.pdf_exports)?
                .permission
                .as_ref()
                .map(|p| &p.generation)
                != export_permission.as_ref().map(|p| &p.generation)
            {
                return Err(denied());
            }
            for item in &results {
                if self
                    .shared_source(item["documentId"].as_str().unwrap_or(""))
                    .is_err()
                {
                    return Err(denied());
                }
            }
            return Ok(json!(results));
        }
        if name != "get_pdf_download" {
            return Err(denied());
        }
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        struct Input {
            document_id: String,
            revision: String,
            artifact_id: String,
        }
        let input: Input = serde_json::from_value(arguments)?;
        if input.document_id.len() > 128
            || [&input.revision, &input.artifact_id]
                .iter()
                .any(|s| s.len() != 64 || !s.bytes().all(|b| b.is_ascii_hexdigit()))
        {
            return Err(Error::new(
                "arguments",
                "Use the exact shared document, saved revision and artifact ID.",
            ));
        }
        let scope = self.pdf_scope(&input.document_id)?;
        let (info, bytes) = self.saved_pdf(&scope)?;
        if info.revision != input.revision || info.artifact_id != input.artifact_id {
            return Err(Error::new("stale","The requested saved PDF artifact is no longer available. No replacement was exported."));
        }
        self.check_pdf_scope(&scope)?;
        let mut state = lock(&self.pdf_exports)?;
        if state
            .permission
            .as_ref()
            .is_none_or(|p| p.generation != scope.permission.generation)
        {
            return Err(denied());
        }
        state
            .tickets
            .retain(|_, ticket| ticket.expires > Instant::now());
        if let Some((secret, ticket)) = state.tickets.iter().find(|(_, t)| {
            t.scope.permission.generation == scope.permission.generation
                && t.scope.document_id == input.document_id
                && t.info.artifact_id == input.artifact_id
                && t.downloads < MAX_DOWNLOADS
        }) {
            return Ok(download_value(secret, ticket));
        }
        if state.tickets.len() >= MAX_TICKETS
            || state.budget.load(Ordering::Acquire) + bytes.len() > MAX_BYTES
        {
            return Err(Error::new("limit","The PDF export cache is full. Revoke exports or wait for existing downloads to expire."));
        }
        state.budget.fetch_add(bytes.len(), Ordering::AcqRel);
        let artifact = Arc::new(Artifact {
            bytes,
            budget: state.budget.clone(),
        });
        let secret = format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple());
        let ticket = Ticket {
            scope,
            info,
            artifact,
            expires: Instant::now() + TICKET_LIFE,
            expires_at: SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis() as u64
                + TICKET_LIFE.as_millis() as u64,
            downloads: 0,
        };
        let result = download_value(&secret, &ticket);
        state.tickets.insert(secret, ticket);
        Ok(result)
    }

    fn pdf_ticket_live(&self, ticket: &Ticket) -> Result<()> {
        if ticket.expires <= Instant::now() {
            return Err(denied());
        }
        let (generation, owner, _) = self.pdf_app_authority(true)?;
        if generation != ticket.scope.permission.app_generation
            || owner != ticket.scope.permission.owner
        {
            return Err(denied());
        }
        let state = lock(&self.pdf_exports)?;
        if state
            .permission
            .as_ref()
            .is_none_or(|p| p.generation != ticket.scope.permission.generation)
        {
            return Err(denied());
        }
        drop(state);
        if self.shared_source(&ticket.scope.document_id).ok()
            != Some((
                ticket.scope.project.id.clone(),
                ticket.scope.path.clone(),
                ticket.scope.source_epoch,
                ticket.scope.root,
            ))
        {
            return Err(denied());
        }
        if let Ok(mut tunnel) = self.tunnel.try_lock() {
            if tunnel
                .as_mut()
                .is_none_or(|t| !t.child.try_wait().is_ok_and(|status| status.is_none()))
            {
                return Err(denied());
            }
        }
        Ok(())
    }

    pub(crate) fn pdf_download(
        self: &Arc<Self>,
        secret: &str,
        head: bool,
    ) -> Result<(Value, Option<PdfByteStream>)> {
        if secret.len() != 64 || !secret.bytes().all(|b| b.is_ascii_hexdigit()) {
            return Err(denied());
        }
        self.pdf_tunnel_live()?;
        let ticket = lock(&self.pdf_exports)?
            .tickets
            .get(secret)
            .cloned()
            .ok_or_else(denied)?;
        self.pdf_ticket_live(&ticket)?;
        self.check_pdf_scope(&ticket.scope)?;
        let metadata = json!({"bytes":ticket.info.bytes,"sha256":ticket.info.sha256});
        if head {
            return Ok((metadata, None));
        }
        let mut state = lock(&self.pdf_exports)?;
        if state.active.load(Ordering::Acquire) >= MAX_STREAMS {
            return Err(Error::new("busy", "Two PDF downloads are already running."));
        }
        let current = state.tickets.get_mut(secret).ok_or_else(denied)?;
        if current.downloads >= MAX_DOWNLOADS {
            return Err(Error::new(
                "limit",
                "This PDF ticket has reached its download limit.",
            ));
        }
        current.downloads += 1;
        state.active.fetch_add(1, Ordering::AcqRel);
        let stream = PdfByteStream {
            service: self.clone(),
            ticket,
            offset: 0,
            started: Instant::now(),
            active: state.active.clone(),
        };
        Ok((metadata, Some(stream)))
    }

    pub(crate) fn pdf_download_worker(&self) -> Result<tokio::sync::OwnedSemaphorePermit> {
        lock(&self.pdf_exports)?
            .authorize
            .clone()
            .try_acquire_owned()
            .map_err(|_| Error::new("busy", "PDF download authorization is busy."))
    }
}

fn download_value(secret: &str, ticket: &Ticket) -> Value {
    json!({"documentId":ticket.scope.document_id,"revision":ticket.info.revision,"artifactId":ticket.info.artifact_id,
        "sha256":ticket.info.sha256,"bytes":ticket.info.bytes,"mimeType":"application/pdf",
        "fileName":format!("manuscript-{}.pdf",&ticket.info.sha256[..12]),
        "downloadUrl":format!("{}/artifacts/pdf/{secret}/document.pdf",ticket.scope.origin),"expiresAt":ticket.expires_at})
}

pub(crate) struct PdfByteStream {
    service: Arc<Service>,
    ticket: Ticket,
    offset: usize,
    started: Instant,
    active: Arc<AtomicUsize>,
}
impl Drop for PdfByteStream {
    fn drop(&mut self) {
        self.active.fetch_sub(1, Ordering::AcqRel);
    }
}
impl Stream for PdfByteStream {
    type Item = std::io::Result<Bytes>;
    fn poll_next(mut self: Pin<&mut Self>, _: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        if self.offset >= self.ticket.artifact.bytes.len() {
            return Poll::Ready(None);
        }
        if self.started.elapsed() > STREAM_LIFE
            || self.service.pdf_ticket_live(&self.ticket).is_err()
        {
            self.offset = self.ticket.artifact.bytes.len();
            return Poll::Ready(Some(Err(std::io::Error::new(
                std::io::ErrorKind::PermissionDenied,
                "PDF download expired or was revoked.",
            ))));
        }
        let end = (self.offset + CHUNK).min(self.ticket.artifact.bytes.len());
        let bytes = Bytes::copy_from_slice(&self.ticket.artifact.bytes[self.offset..end]);
        self.offset = end;
        Poll::Ready(Some(Ok(bytes)))
    }
}

pub(super) fn tool_descriptor() -> Value {
    json!({"name":"get_pdf_download","description":"Download only an exact existing saved PDF from a currently shared manuscript in an explicitly export-permitted project. Never compiles, saves or substitutes another artifact.",
        "inputSchema":{"type":"object","properties":{"documentId":{"type":"string","maxLength":128},"revision":{"type":"string","pattern":"^[a-f0-9]{64}$"},"artifactId":{"type":"string","pattern":"^[a-f0-9]{64}$"}},"required":["documentId","revision","artifactId"],"additionalProperties":false},
        "annotations":{"readOnlyHint":true,"destructiveHint":false,"openWorldHint":false}})
}

#[cfg(test)]
mod tests;
