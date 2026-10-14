use crate::document::{digest, Anchor, Marker, Proposal, Review, MAX_ITEMS, MAX_TEXT};
use crate::{Error, Operation, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};
use std::sync::{Arc, Mutex};
use tokio::process::{Child, Command};
use uuid::Uuid;

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    pub id: String,
    pub name: String,
    pub root: PathBuf,
    #[serde(default)]
    pub repository: String,
    #[serde(default)]
    pub auto_sync: bool,
    #[serde(default)]
    pub pending: BTreeSet<String>,
    #[serde(default)]
    pub pending_revisions: BTreeMap<String, String>,
}

#[derive(Default, Serialize, Deserialize)]
struct Registry {
    projects: Vec<Project>,
}

pub struct Service {
    state: PathBuf,
    registry: Mutex<Registry>,
    documents: tokio::sync::Mutex<()>,
    pub shared: Mutex<BTreeMap<String, (String, String)>>,
    pub tunnel: tokio::sync::Mutex<Option<Tunnel>>,
    pub sync_lock: tokio::sync::Mutex<()>,
    pub compile_lock: tokio::sync::Mutex<()>,
    connection_settings: Mutex<crate::transport::ConnectionSettings>,
}

pub struct Tunnel {
    pub endpoint: String,
    pub secret: String,
    pub child: Child,
    pub shutdown: tokio::sync::oneshot::Sender<()>,
    pub mcp_initialized: bool,
    pub last_activity_ms: u64,
    pub tool_calls: u64,
}

#[derive(Serialize, Deserialize)]
struct Journal {
    old_revision: String,
    content: String,
    review: Review,
}

pub fn atomic_write(path: &Path, content: &[u8]) -> Result<()> {
    if path
        .symlink_metadata()
        .is_ok_and(|m| m.file_type().is_symlink())
    {
        return Err(Error::new("path", "Linked files are not writable."));
    }
    let parent = path
        .parent()
        .ok_or_else(|| Error::new("path", "Missing parent directory."))?;
    let permissions = fs::metadata(path).ok().map(|m| m.permissions());
    let mut temporary = tempfile::NamedTempFile::new_in(parent)?;
    temporary.write_all(content)?;
    if let Some(permissions) = permissions {
        temporary.as_file().set_permissions(permissions)?;
    }
    temporary.as_file().sync_all()?;
    temporary
        .persist(path)
        .map_err(|_| Error::new("io", "Could not atomically replace the local file."))?;
    #[cfg(unix)]
    fs::File::open(parent)?.sync_all()?;
    Ok(())
}

fn lock<T>(mutex: &Mutex<T>) -> Result<std::sync::MutexGuard<'_, T>> {
    mutex
        .lock()
        .map_err(|_| Error::new("state", "Restart UnderTree to recover its local state."))
}

fn read_text(path: &Path, maximum: usize) -> Result<String> {
    if !fs::symlink_metadata(path)?.is_file() {
        return Err(Error::new("path", "Only regular local files can be read."));
    }
    let mut content = String::new();
    fs::File::open(path)?
        .take(maximum as u64 + 1)
        .read_to_string(&mut content)?;
    if content.len() > maximum {
        return Err(Error::new(
            "limit",
            "The file exceeds the supported size limit.",
        ));
    }
    Ok(content)
}

fn sidecar(path: &Path) -> PathBuf {
    PathBuf::from(format!("{}.undertree-review.json", path.to_string_lossy()))
}
fn journal_path(path: &Path) -> PathBuf {
    PathBuf::from(format!("{}.undertree-pending.json", path.to_string_lossy()))
}

impl Service {
    pub fn new(state: PathBuf) -> Result<Arc<Self>> {
        fs::create_dir_all(&state)?;
        let config = state.join("projects.json");
        let registry = if config.exists() {
            serde_json::from_str(&read_text(&config, MAX_TEXT)?)?
        } else {
            Registry::default()
        };
        let config = state.join("connection.json");
        let settings = if config.exists() {
            serde_json::from_str(&read_text(&config, 4096)?)?
        } else {
            crate::transport::ConnectionSettings::default()
        };
        Ok(Arc::new(Self {
            state,
            registry: Mutex::new(registry),
            documents: tokio::sync::Mutex::new(()),
            shared: Mutex::new(BTreeMap::new()),
            tunnel: tokio::sync::Mutex::new(None),
            sync_lock: tokio::sync::Mutex::new(()),
            compile_lock: tokio::sync::Mutex::new(()),
            connection_settings: Mutex::new(settings),
        }))
    }

    pub(crate) fn connection_settings(&self) -> Result<crate::transport::ConnectionSettings> {
        Ok(lock(&self.connection_settings)?.clone())
    }

    pub(crate) fn save_connection_settings(
        &self,
        settings: crate::transport::ConnectionSettings,
    ) -> Result<()> {
        atomic_write(
            &self.state.join("connection.json"),
            &serde_json::to_vec_pretty(&settings)?,
        )?;
        *lock(&self.connection_settings)? = settings;
        Ok(())
    }

    pub(crate) fn shared_manuscripts(&self) -> Result<Value> {
        let shared = lock(&self.shared)?.clone();
        let registry = lock(&self.registry)?;
        Ok(json!(shared.iter().map(|(id, (project, path))| json!({
            "documentId":id,"project":project,"path":path,
            "projectName":registry.projects.iter().find(|p| &p.id == project).map(|p| p.name.as_str()).unwrap_or("Project")
        })).collect::<Vec<_>>()))
    }

    fn save_registry(&self, registry: &Registry) -> Result<()> {
        atomic_write(
            &self.state.join("projects.json"),
            &serde_json::to_vec_pretty(registry)?,
        )
    }

    pub fn project(&self, id: &str) -> Result<Project> {
        lock(&self.registry)?
            .projects
            .iter()
            .find(|p| p.id == id)
            .cloned()
            .ok_or_else(|| Error::new("project", "Choose an approved project."))
    }

    pub fn path(&self, project: &Project, relative: &str, create: bool) -> Result<PathBuf> {
        if project.root.canonicalize()? != project.root {
            return Err(Error::new("path", "The approved project folder moved or became a link. Approve its current location again."));
        }
        let relative = Path::new(relative);
        if relative.as_os_str().is_empty()
            || relative
                .components()
                .any(|c| !matches!(c, Component::Normal(_)))
            || relative
                .components()
                .any(|c| c.as_os_str().to_string_lossy().starts_with('.'))
            || !["html", "htm", "typ", "css", "md", "txt", "tex"]
                .contains(&relative.extension().and_then(|x| x.to_str()).unwrap_or(""))
        {
            return Err(Error::new(
                "path",
                "Choose a Typst, HTML, TeX, CSS, Markdown, or text source inside this project.",
            ));
        }
        let path = project.root.join(relative);
        let parent = path
            .parent()
            .ok_or_else(|| Error::new("path", "Invalid file path."))?
            .canonicalize()?;
        if !parent.starts_with(&project.root)
            || path
                .symlink_metadata()
                .is_ok_and(|m| m.file_type().is_symlink())
        {
            return Err(Error::new(
                "path",
                "Linked files and paths outside the project are not allowed.",
            ));
        }
        if !create && !path.canonicalize()?.starts_with(&project.root) {
            return Err(Error::new("path", "The file is outside this project."));
        }
        for metadata in [sidecar(&path), journal_path(&path)] {
            if metadata
                .symlink_metadata()
                .is_ok_and(|m| m.file_type().is_symlink())
            {
                return Err(Error::new("path", "Linked review files are not allowed."));
            }
        }
        Ok(path)
    }

    fn read_document(&self, path: &Path) -> Result<(String, Review)> {
        let pending = journal_path(path);
        if pending.exists() {
            let journal: Journal = serde_json::from_str(&read_text(&pending, MAX_TEXT * 9)?)?;
            journal.review.validate_for_text(&journal.content)?;
            if journal.content.len() > MAX_TEXT
                || journal.review.revision != digest(&journal.content)
                || journal.old_revision.len() != 64
                || !journal.old_revision.bytes().all(|b| b.is_ascii_hexdigit())
            {
                return Err(Error::new(
                    "format",
                    "The interrupted save is invalid. Its files have been preserved.",
                ));
            }
            let current = read_text(path, MAX_TEXT)?;
            if digest(&current) == journal.old_revision {
                atomic_write(path, journal.content.as_bytes())?;
            } else if current != journal.content {
                return Err(Error::new("conflict", "A pending save conflicts with external edits. Both versions have been retained; resolve the pending JSON file first."));
            }
            atomic_write(&sidecar(path), &serde_json::to_vec_pretty(&journal.review)?)?;
            fs::remove_file(pending)?;
        }
        let content = read_text(path, MAX_TEXT)?;
        let metadata = sidecar(path);
        let mut review = if metadata.exists() {
            serde_json::from_str::<Review>(&read_text(&metadata, MAX_TEXT * 8)?)?
        } else {
            Review::new(&content)
        };
        review.validate_for_text(&content)?;
        review.invalidate_external(&content);
        Ok((content, review))
    }

    fn persist(
        &self,
        project: &str,
        relative: &str,
        path: &Path,
        old: &str,
        content: &str,
        review: &Review,
    ) -> Result<()> {
        review.validate_for_text(content)?;
        if review.revision != digest(content) {
            return Err(Error::new(
                "format",
                "Review metadata does not describe this source revision.",
            ));
        }
        if digest(&read_text(path, MAX_TEXT)?) != digest(old) {
            return Err(Error::new("conflict", "The file changed externally. Your edits are still in the editor; refresh or export them before retrying."));
        }
        let review_json = serde_json::to_string_pretty(review)?;
        if review_json.len() > MAX_TEXT * 8 {
            return Err(Error::new(
                "limit",
                "The review metadata exceeds its 16 MB limit.",
            ));
        }
        if content != old {
            let journal = Journal {
                old_revision: digest(old),
                content: content.to_owned(),
                review: review.clone(),
            };
            atomic_write(&journal_path(path), &serde_json::to_vec_pretty(&journal)?)?;
            atomic_write(path, content.as_bytes())?;
        }
        atomic_write(&sidecar(path), review_json.as_bytes())?;
        if journal_path(path).exists() {
            fs::remove_file(journal_path(path))?;
        }
        let mut registry = lock(&self.registry)?;
        let p = registry
            .projects
            .iter_mut()
            .find(|p| p.id == project)
            .ok_or_else(|| Error::new("project", "Project unavailable."))?;
        p.pending.insert(relative.to_owned());
        p.pending
            .insert(format!("{relative}.undertree-review.json"));
        p.pending_revisions
            .insert(relative.to_owned(), digest(content));
        p.pending_revisions.insert(
            format!("{relative}.undertree-review.json"),
            digest(&review_json),
        );
        self.save_registry(&registry)
    }

    fn snapshot(&self, project: &Project, relative: &str, path: &Path) -> Result<Value> {
        let (content, review) = self.read_document(path)?;
        let id = digest(&format!("{}:{relative}", project.id));
        let shared = lock(&self.shared)?.contains_key(&id);
        Ok(
            json!({ "documentId": id, "path": relative, "content": content, "review": review, "shared": shared }),
        )
    }

    pub fn local(&self, operation: Operation) -> Result<Value> {
        let _documents = self.documents.try_lock().map_err(|_| {
            Error::new(
                "busy",
                "A local document operation is running. Retry this action.",
            )
        })?;
        match operation {
            Operation::Projects => Ok(json!(lock(&self.registry)?.projects)),
            Operation::AddProject { root } => {
                let root = PathBuf::from(root).canonicalize()?;
                if !root.is_dir() {
                    return Err(Error::new("project", "Choose a project folder."));
                }
                let mut registry = lock(&self.registry)?;
                if let Some(existing) = registry.projects.iter().find(|p| p.root == root) {
                    return Ok(json!(existing));
                }
                if registry.projects.len() >= 100 {
                    return Err(Error::new(
                        "limit",
                        "At most 100 project folders can be approved.",
                    ));
                }
                let project = Project {
                    id: Uuid::new_v4().to_string(),
                    name: root
                        .file_name()
                        .unwrap_or_default()
                        .to_string_lossy()
                        .into(),
                    root,
                    repository: String::new(),
                    auto_sync: false,
                    pending: BTreeSet::new(),
                    pending_revisions: BTreeMap::new(),
                };
                registry.projects.push(project.clone());
                self.save_registry(&registry)?;
                Ok(json!(project))
            }
            Operation::Files { project } => {
                let project = self.project(&project)?;
                let mut files = vec![];
                fn walk(
                    root: &Path,
                    directory: &Path,
                    depth: usize,
                    files: &mut Vec<String>,
                ) -> Result<()> {
                    if depth > 12 || files.len() >= 1000 {
                        return Ok(());
                    }
                    let mut entries = fs::read_dir(directory)?
                        .take(2000)
                        .collect::<std::io::Result<Vec<_>>>()?;
                    entries.sort_by_key(|e| e.file_name());
                    for entry in entries {
                        if files.len() >= 1000 {
                            break;
                        }
                        let kind = entry.file_type()?;
                        let path = entry.path();
                        if entry.file_name().to_string_lossy().starts_with('.')
                            || kind.is_symlink()
                            || entry.file_name() == "node_modules"
                        {
                            continue;
                        }
                        if kind.is_dir() {
                            walk(root, &path, depth + 1, files)?;
                        } else if ["html", "htm", "typ", "css", "md", "txt", "tex"]
                            .contains(&path.extension().and_then(|x| x.to_str()).unwrap_or(""))
                        {
                            if let Ok(relative) = path.strip_prefix(root) {
                                files.push(relative.to_string_lossy().replace('\\', "/"));
                            }
                        }
                    }
                    Ok(())
                }
                walk(&project.root, &project.root, 0, &mut files)?;
                Ok(json!(files))
            }
            Operation::Open { project, path } | Operation::Review { project, path } => {
                let project = self.project(&project)?;
                self.snapshot(&project, &path, &self.path(&project, &path, false)?)
            }
            Operation::Create { project, path } => {
                let p = self.project(&project)?;
                let file = self.path(&p, &path, true)?;
                let content = if path.ends_with(".typ") {
                    "#set page(paper: \"a4\")\n#set text(size: 11pt)\n\n= Manuscript\n\nStart writing here.\n"
                } else {
                    "<!doctype html>\n<html lang=\"en\">\n<head><meta charset=\"UTF-8\"><title>Manuscript</title></head>\n<body>\n<h1>Manuscript</h1>\n<p>Start writing here.</p>\n</body>\n</html>\n"
                };
                let mut new = fs::OpenOptions::new()
                    .write(true)
                    .create_new(true)
                    .open(&file)?;
                new.write_all(content.as_bytes())?;
                new.sync_all()?;
                let review = Review::new(content);
                self.persist(&project, &path, &file, content, content, &review)?;
                self.snapshot(&p, &path, &file)
            }
            Operation::ImportTex {
                project,
                path,
                target,
            } => {
                if !path.ends_with(".tex") || !target.ends_with(".typ") {
                    return Err(Error::new(
                        "import",
                        "Choose a .tex source and a new .typ destination.",
                    ));
                }
                let p = self.project(&project)?;
                let source = self.path(&p, &path, false)?;
                let destination = self.path(&p, &target, true)?;
                let original = read_text(&source, MAX_TEXT)?;
                let converted = crate::tex_import::convert(&original)?;
                let report = PathBuf::from(format!(
                    "{}.import-report.json",
                    destination.to_string_lossy()
                ));
                let mut new = fs::OpenOptions::new()
                    .write(true)
                    .create_new(true)
                    .open(&destination)?;
                new.write_all(converted.content.as_bytes())?;
                new.sync_all()?;
                let report_json = serde_json::to_string_pretty(&converted)?;
                atomic_write(&report, report_json.as_bytes())?;
                let review = Review::new(&converted.content);
                self.persist(
                    &project,
                    &target,
                    &destination,
                    &converted.content,
                    &converted.content,
                    &review,
                )?;
                let mut registry = lock(&self.registry)?;
                if let Some(p) = registry.projects.iter_mut().find(|p| p.id == project) {
                    let relative = format!("{target}.import-report.json");
                    p.pending.insert(relative.clone());
                    p.pending_revisions.insert(relative, digest(&report_json));
                }
                self.save_registry(&registry)?;
                Ok(
                    json!({"snapshot":self.snapshot(&p,&target,&destination)?,"warnings":converted.warnings,"exactFormatting":false}),
                )
            }
            Operation::Save {
                project,
                path,
                revision,
                content,
            } => {
                if content.len() > MAX_TEXT {
                    return Err(Error::new("limit", "The manuscript exceeds 2 MB."));
                }
                let p = self.project(&project)?;
                let file = self.path(&p, &path, false)?;
                let (old, mut review) = self.read_document(&file)?;
                review.check_revision(&revision, &old)?;
                review.reconcile(&old, &content);
                self.persist(&project, &path, &file, &old, &content, &review)?;
                self.snapshot(&p, &path, &file)
            }
            Operation::Palette {
                project,
                path,
                revision,
                rules,
            } => {
                let p = self.project(&project)?;
                let file = self.path(&p, &path, false)?;
                let (text, mut review) = self.read_document(&file)?;
                review.check_revision(&revision, &text)?;
                review.rules = rules;
                self.persist(&project, &path, &file, &text, &text, &review)?;
                self.snapshot(&p, &path, &file)
            }
            Operation::Mark {
                project,
                path,
                revision,
                from,
                to,
                rule,
                prompt,
            } => {
                if prompt.len() > 4000 {
                    return Err(Error::new(
                        "limit",
                        "Keep the passage prompt under 4,000 bytes.",
                    ));
                }
                let p = self.project(&project)?;
                let file = self.path(&p, &path, false)?;
                let (text, mut review) = self.read_document(&file)?;
                review.check_revision(&revision, &text)?;
                review.rule(&rule)?;
                if review.markers.len() >= MAX_ITEMS {
                    return Err(Error::new("limit", "At most 500 highlights are supported."));
                }
                review.markers.push(Marker {
                    id: Uuid::new_v4().to_string(),
                    anchor: Anchor::new(&text, from, to)?,
                    rule,
                    prompt,
                });
                self.persist(&project, &path, &file, &text, &text, &review)?;
                self.snapshot(&p, &path, &file)
            }
            Operation::Unmark {
                project,
                path,
                revision,
                id,
            } => {
                let p = self.project(&project)?;
                let file = self.path(&p, &path, false)?;
                let (text, mut review) = self.read_document(&file)?;
                review.check_revision(&revision, &text)?;
                review.markers.retain(|m| m.id != id);
                self.persist(&project, &path, &file, &text, &text, &review)?;
                self.snapshot(&p, &path, &file)
            }
            Operation::Decide {
                project,
                path,
                revision,
                id,
                decision,
            } => {
                let p = self.project(&project)?;
                let file = self.path(&p, &path, false)?;
                let (text, mut review) = self.read_document(&file)?;
                let changed = review.decide_format(
                    &text,
                    &revision,
                    &id,
                    decision,
                    path.ends_with(".typ"),
                )?;
                self.persist(&project, &path, &file, &text, &changed, &review)?;
                self.snapshot(&p, &path, &file)
            }
            Operation::Share {
                project,
                path,
                enabled,
            } => {
                let p = self.project(&project)?;
                let file = self.path(&p, &path, false)?;
                if !["html", "htm", "typ"]
                    .contains(&file.extension().and_then(|x| x.to_str()).unwrap_or(""))
                {
                    return Err(Error::new(
                        "scope",
                        "Only HTML and Typst manuscripts can be shared with agents.",
                    ));
                }
                let id = digest(&format!("{project}:{path}"));
                let mut shared = lock(&self.shared)?;
                if enabled {
                    if shared.len() >= 20 {
                        return Err(Error::new(
                            "limit",
                            "At most 20 manuscripts can be shared in one session.",
                        ));
                    }
                    shared.insert(id.clone(), (project, path));
                } else {
                    shared.remove(&id);
                }
                Ok(json!({"documentId":id,"shared":enabled}))
            }
            _ => Err(Error::new(
                "operation",
                "This action uses the asynchronous native adapter.",
            )),
        }
    }

    pub fn remote(&self, tool: &str, arguments: Value) -> Result<Value> {
        let _documents = self.documents.try_lock().map_err(|_| {
            Error::new(
                "busy",
                "A local document operation is running. Retry this action.",
            )
        })?;
        match tool {
            "list_manuscripts" => {
                if arguments.as_object().is_none_or(|a| !a.is_empty()) {
                    return Err(Error::new("arguments", "This tool takes no arguments."));
                }
                let shared = lock(&self.shared)?;
                Ok(json!(shared
                    .iter()
                    .map(|(id, (_, path))| json!({"documentId":id,"path":path}))
                    .collect::<Vec<_>>()))
            }
            "read_manuscript" | "suggest_text" => {
                #[derive(Deserialize)]
                #[serde(rename_all = "camelCase", deny_unknown_fields)]
                struct Read {
                    document_id: String,
                }
                #[derive(Deserialize)]
                #[serde(rename_all = "camelCase", deny_unknown_fields)]
                struct Suggest {
                    document_id: String,
                    proposal: Proposal,
                }
                let (id, proposal) = if tool == "read_manuscript" {
                    let a: Read = serde_json::from_value(arguments)?;
                    (a.document_id, None)
                } else {
                    let a: Suggest = serde_json::from_value(arguments)?;
                    (a.document_id, Some(a.proposal))
                };
                let (project, path) = lock(&self.shared)?.get(&id).cloned().ok_or_else(|| {
                    Error::new(
                        "scope",
                        "This manuscript is not shared, or its grant was revoked.",
                    )
                })?;
                let p = self.project(&project)?;
                let file = self.path(&p, &path, false)?;
                if let Some(proposal) = proposal {
                    let (text, mut review) = self.read_document(&file)?;
                    let suggestion =
                        review.propose_format(&text, proposal, path.ends_with(".typ"))?;
                    self.persist(&project, &path, &file, &text, &text, &review)?;
                    Ok(json!({"suggestion":suggestion,"manuscriptChanged":false}))
                } else {
                    self.snapshot(&p, &path, &file)
                }
            }
            _ => Err(Error::new(
                "scope",
                "Agents can only list shared manuscripts, read them, and submit suggestions.",
            )),
        }
    }

    pub async fn dispatch(self: &Arc<Self>, operation: Operation) -> Result<Value> {
        match operation {
            Operation::Tunnel {
                enabled,
                reservation,
                public_url,
            } => crate::transport::tunnel(self, enabled, reservation, public_url).await,
            Operation::Connection => crate::transport::connection(self).await,
            Operation::GitStatus { project } => self.git_status(&project).await,
            Operation::BindGithub {
                project,
                repository,
                auto_sync,
            } => self.bind_github(&project, &repository, auto_sync).await,
            Operation::Sync { project } => self.sync(&project).await,
            Operation::Compile {
                project,
                path,
                revision,
            } => self.compile_typst(&project, &path, &revision).await,
            Operation::Pdf { project, path } => self.preview_pdf(&project, &path),
            operation => {
                let service = self.clone();
                tokio::task::spawn_blocking(move || service.local(operation))
                    .await
                    .map_err(|_| Error::new("state", "The local operation stopped unexpectedly."))?
            }
        }
    }
}

impl Service {
    pub fn publishing_root(&self) -> &Path {
        &self.state
    }
}

const MAX_GIT_OUTPUT: usize = 128 * 1024;

async fn git_output(
    root: &Path,
    args: &[&str],
    index: Option<&Path>,
    worktree: Option<&Path>,
) -> Result<(std::process::ExitStatus, String)> {
    use std::process::Stdio;
    use tokio::io::AsyncReadExt;
    let mut command = Command::new("git");
    command
        .args([
            "-c",
            "core.hooksPath=",
            "-c",
            "commit.gpgsign=false",
            "--literal-pathspecs",
        ])
        .args(args)
        .current_dir(root)
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_OPTIONAL_LOCKS", "0")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .stdin(Stdio::null())
        .kill_on_drop(true);
    for variable in [
        "GIT_DIR",
        "GIT_WORK_TREE",
        "GIT_COMMON_DIR",
        "GIT_INDEX_FILE",
        "GIT_OBJECT_DIRECTORY",
        "GIT_ALTERNATE_OBJECT_DIRECTORIES",
    ] {
        command.env_remove(variable);
    }
    if let Some(index) = index {
        command.env("GIT_INDEX_FILE", index);
    }
    if let Some(worktree) = worktree {
        command.env("GIT_WORK_TREE", worktree);
    }
    let mut child = command.spawn()?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| Error::new("git", "Could not read Git output."))?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| Error::new("git", "Could not read Git diagnostics."))?;
    async fn bounded(stream: impl tokio::io::AsyncRead + Unpin) -> Result<Vec<u8>> {
        let mut bytes = Vec::new();
        stream
            .take(MAX_GIT_OUTPUT as u64 + 1)
            .read_to_end(&mut bytes)
            .await?;
        if bytes.len() > MAX_GIT_OUTPUT {
            return Err(Error::new(
                "limit",
                "Git output exceeded its bounded buffer.",
            ));
        }
        Ok(bytes)
    }
    let work = async {
        let (out, _) = tokio::try_join!(bounded(stdout), bounded(stderr))?;
        let status = child.wait().await?;
        let output = String::from_utf8(out)
            .map_err(|_| Error::new("git", "Git returned non-UTF-8 output."))?;
        Ok((status, output))
    };
    match tokio::time::timeout(std::time::Duration::from_secs(30), work).await {
        Ok(Ok(result)) => Ok(result),
        result => {
            let _ = child.start_kill();
            let _ = tokio::time::timeout(std::time::Duration::from_secs(3), child.wait()).await;
            match result {
                Ok(Err(error)) => Err(error),
                _ => Err(Error::new(
                    "timeout",
                    "Git took too long. Recheck the remote state before retrying.",
                )),
            }
        }
    }
}

async fn git(root: &Path, args: &[&str]) -> Result<String> {
    git_index(root, args, None, None).await
}

async fn git_index(
    root: &Path,
    args: &[&str],
    index: Option<&Path>,
    worktree: Option<&Path>,
) -> Result<String> {
    let (status, output) = git_output(root, args, index, worktree).await?;
    if !status.success() {
        return Err(Error::new(
            "git",
            "Git stopped. Check the repository, configured Git credentials, and branch state.",
        ));
    }
    Ok(output)
}

async fn git_head(root: &Path) -> Result<Option<String>> {
    let (status, output) = git_output(
        root,
        &["rev-parse", "--verify", "--quiet", "HEAD"],
        None,
        None,
    )
    .await?;
    if status.success() {
        Ok(Some(output.trim().to_owned()))
    } else if status.code() == Some(1) {
        Ok(None)
    } else {
        Err(Error::new(
            "git",
            "Could not inspect the current Git branch.",
        ))
    }
}

fn github_repository(value: &str) -> Result<String> {
    let parts: Vec<_> = value.split('/').collect();
    if parts.len() != 2
        || parts.iter().any(|s| {
            s.is_empty()
                || matches!(*s, "." | "..")
                || s.starts_with('-')
                || !s
                    .bytes()
                    .all(|c| c.is_ascii_alphanumeric() || b"-_.".contains(&c))
        })
        || value.len() > 200
    {
        return Err(Error::new(
            "github",
            "Enter a GitHub repository as owner/name.",
        ));
    }
    Ok(format!("https://github.com/{value}.git"))
}

fn git_changes(status: &str) -> impl Iterator<Item = &str> {
    status
        .split('\0')
        .filter(|record| !record.is_empty())
        .filter(|record| {
            let snapshot = record
                .strip_prefix("?? ")
                .and_then(|path| Path::new(path).file_name())
                .and_then(|name| name.to_str());
            !snapshot.is_some_and(|name| {
                name.starts_with(".undertree-compile-") && name.ends_with(".typ")
            })
        })
}

// Owning Git's index lock prevents another local Git command from staging while a checkpoint is assembled.
struct IndexLock(PathBuf);
impl Drop for IndexLock {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.0);
    }
}

impl Service {
    fn checked_root(&self, project: &Project) -> Result<()> {
        if project.root.canonicalize()? != project.root || !project.root.is_dir() {
            return Err(Error::new(
                "path",
                "The approved project folder moved or became a link.",
            ));
        }
        Ok(())
    }

    async fn git_status(&self, project: &str) -> Result<Value> {
        let p = self.project(project)?;
        self.checked_root(&p)?;
        let branch = git(&p.root, &["branch", "--show-current"]).await?;
        let status = git(&p.root, &["status", "--short"]).await?;
        Ok(
            json!({"branch":branch.trim(),"status":status,"repository":p.repository,"autoSync":p.auto_sync}),
        )
    }

    async fn bind_github(&self, project: &str, repository: &str, auto_sync: bool) -> Result<Value> {
        let _sync = self
            .sync_lock
            .try_lock()
            .map_err(|_| Error::new("busy", "A Git operation is already running."))?;
        let url = github_repository(repository)?;
        let p = self.project(project)?;
        self.checked_root(&p)?;
        if !p.root.join(".git").exists() {
            git(&p.root, &["init", "-b", "main"]).await?;
        }
        let remotes = git(&p.root, &["remote"]).await?;
        if remotes.lines().any(|name| name == "origin") {
            let existing = git(&p.root, &["remote", "get-url", "origin"]).await?;
            let ssh = format!("git@github.com:{repository}.git");
            if existing.trim() != url && existing.trim() != ssh {
                return Err(Error::new(
                    "github",
                    "This project already has a different origin. UnderTree will not retarget it.",
                ));
            }
        } else {
            git(&p.root, &["remote", "add", "origin", &url]).await?;
        }
        let mut registry = lock(&self.registry)?;
        let p = registry
            .projects
            .iter_mut()
            .find(|p| p.id == project)
            .ok_or_else(|| Error::new("project", "Project unavailable."))?;
        p.repository = repository.to_owned();
        p.auto_sync = auto_sync;
        self.save_registry(&registry)?;
        Ok(json!({"repository":repository,"autoSync":auto_sync}))
    }

    async fn sync(&self, project: &str) -> Result<Value> {
        let _sync = self
            .sync_lock
            .try_lock()
            .map_err(|_| Error::new("busy", "A Git operation is already running."))?;
        let p = self.project(project)?;
        self.checked_root(&p)?;
        let expected_url = github_repository(&p.repository)?;
        let remote = git(&p.root, &["remote", "get-url", "origin"]).await?;
        if remote.trim() != expected_url
            && remote.trim() != format!("git@github.com:{}.git", p.repository)
        {
            return Err(Error::new(
                "github",
                "The origin changed; reconnect the project before synchronizing.",
            ));
        }
        // Push URLs may differ from fetch URLs; both must be the explicitly connected repository.
        let pushes = git(&p.root, &["remote", "get-url", "--push", "--all", "origin"]).await?;
        if pushes.lines().count() != 1
            || !pushes.lines().all(|url| {
                url == expected_url || url == format!("git@github.com:{}.git", p.repository)
            })
        {
            return Err(Error::new(
                "github",
                "The push destination differs from the connected GitHub repository.",
            ));
        }
        self.sync_remote(&p, remote.trim(), pushes.trim()).await
    }

    async fn sync_remote(&self, p: &Project, fetch_url: &str, push_url: &str) -> Result<Value> {
        let top = git(&p.root, &["rev-parse", "--show-toplevel"]).await?;
        if Path::new(top.trim()).canonicalize()? != p.root {
            return Err(Error::new(
                "git",
                "Approve the Git repository root before synchronizing.",
            ));
        }
        let branch = git(&p.root, &["branch", "--show-current"]).await?;
        let branch = branch.trim();
        if branch.is_empty() || branch.starts_with('-') {
            return Err(Error::new(
                "git",
                "Choose a named Git branch before synchronizing.",
            ));
        }
        let branch_ref = format!("refs/heads/{branch}");
        let advertised = git(&p.root, &["ls-remote", "--heads", fetch_url, &branch_ref]).await?;
        let remote_head = advertised.split_whitespace().next();
        let mut head = git_head(&p.root).await?;
        if let Some(remote) = remote_head {
            let tracking = format!("refs/remotes/undertree-sync/{branch}");
            let refspec = format!("{branch_ref}:{tracking}");
            git(
                &p.root,
                &[
                    "fetch",
                    "--no-tags",
                    "--no-recurse-submodules",
                    fetch_url,
                    &refspec,
                ],
            )
            .await?;
            if git(&p.root, &["rev-parse", "--verify", &tracking])
                .await?
                .trim()
                != remote
            {
                return Err(Error::new("conflict", "The remote branch changed during synchronization. Retry with its current state."));
            }
            if let Some(local) = &head {
                if local != remote {
                    let common =
                        git(&p.root, &["merge-base", local, remote])
                            .await
                            .map_err(|_| {
                                Error::new(
                                "conflict",
                                "GitHub and this project have unrelated or divergent histories.",
                            )
                            })?;
                    if common.trim() == local {
                        let _documents = self.documents.lock().await;
                        if git_changes(
                            &git(
                                &p.root,
                                &["status", "--porcelain=v1", "-z", "--untracked-files=all"],
                            )
                            .await?,
                        )
                        .next()
                        .is_some()
                        {
                            return Err(Error::new("conflict", "GitHub is newer. Save your changes separately and resolve them before synchronizing."));
                        }
                        git(&p.root, &["merge", "--ff-only", remote]).await?;
                        head = Some(remote.to_owned());
                    } else if common.trim() != remote {
                        return Err(Error::new("conflict", "GitHub and this project diverged. Resolve the histories before synchronizing."));
                    }
                }
            } else {
                return Err(Error::new("conflict", "Clone the existing GitHub project before synchronizing this new local repository."));
            }
        }
        let checkpoint = {
            let _documents = self.documents.lock().await;
            self.checkpoint(p, branch, head.as_deref()).await?
        };
        let commit = checkpoint.as_deref().or(head.as_deref()).ok_or_else(|| {
            Error::new(
                "git",
                "Save a manuscript before synchronizing an empty repository.",
            )
        })?;
        git(
            &p.root,
            &[
                "-c",
                "remote.origin.mirror=false",
                "push",
                "--no-follow-tags",
                "--recurse-submodules=no",
                push_url,
                &format!("{commit}:{branch_ref}"),
            ],
        )
        .await?;
        let confirmed = git(&p.root, &["ls-remote", "--heads", push_url, &branch_ref]).await?;
        if confirmed.split_whitespace().next() != Some(commit) {
            return Err(Error::new(
                "unknown",
                "GitHub did not confirm this checkpoint. Inspect its branch before retrying.",
            ));
        }
        let mut registry = lock(&self.registry)?;
        if let Some(project) = registry
            .projects
            .iter_mut()
            .find(|project| project.id == p.id)
        {
            for (relative, revision) in &p.pending_revisions {
                if project.pending_revisions.get(relative) == Some(revision) {
                    project.pending.remove(relative);
                    project.pending_revisions.remove(relative);
                }
            }
        }
        self.save_registry(&registry)?;
        Ok(json!({"head":commit,"message":"GitHub confirmed the manuscript checkpoint."}))
    }

    async fn checkpoint(
        &self,
        project: &Project,
        branch: &str,
        old_head: Option<&str>,
    ) -> Result<Option<String>> {
        self.checked_root(project)?;
        let index = git(
            &project.root,
            &["rev-parse", "--path-format=absolute", "--git-path", "index"],
        )
        .await?;
        let index = PathBuf::from(index.trim());
        let index_lock = index.with_file_name("index.lock");
        fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&index_lock)
            .map_err(|_| {
                Error::new(
                    "busy",
                    "Another Git operation owns this project's index. Retry when it finishes.",
                )
            })?;
        let _index_lock = IndexLock(index_lock);
        let current = self.project(&project.id)?;
        let status = git(
            &project.root,
            &[
                "status",
                "--porcelain=v1",
                "-z",
                "--no-renames",
                "--untracked-files=all",
            ],
        )
        .await?;
        let snapshot = tempfile::tempdir()?;
        let mut revisions = BTreeMap::new();
        let mut total = 0usize;
        for record in git_changes(&status) {
            if !matches!(record.get(..2), Some("??" | " M")) {
                return Err(Error::new("conflict", "Resolve staged, renamed, deleted, or conflicting Git changes before synchronization."));
            }
            let relative = record
                .get(3..)
                .ok_or_else(|| Error::new("git", "Invalid Git status response."))?;
            if !current.pending.contains(relative) {
                return Err(Error::new("conflict", "The project has changes from another editor. Review and commit them before syncing."));
            }
            let source_relative = relative
                .strip_suffix(".undertree-review.json")
                .or_else(|| relative.strip_suffix(".import-report.json"))
                .unwrap_or(relative);
            let source = self.path(&current, source_relative, false)?;
            let file = if relative == source_relative {
                source
            } else {
                current.root.join(relative)
            };
            if file.symlink_metadata()?.file_type().is_symlink() || !file.is_file() {
                return Err(Error::new(
                    "path",
                    "Only regular manuscript and review files can be synchronized.",
                ));
            }
            let text = read_text(&file, MAX_TEXT * 8)?;
            let revision = digest(&text);
            if current.pending_revisions.get(relative) != Some(&revision) {
                return Err(Error::new("conflict", "A manuscript or its review metadata changed outside UnderTree. Review and save it before synchronizing."));
            }
            total = total
                .checked_add(text.len())
                .ok_or_else(|| Error::new("limit", "This checkpoint is too large."))?;
            if total > MAX_TEXT * 16 || revisions.len() >= 1000 {
                return Err(Error::new(
                    "limit",
                    "Synchronize fewer than 1,000 files and 32 MB at once.",
                ));
            }
            let destination = snapshot.path().join(relative);
            fs::create_dir_all(
                destination
                    .parent()
                    .ok_or_else(|| Error::new("path", "Invalid checkpoint path."))?,
            )?;
            fs::write(&destination, text)?;
            fs::set_permissions(&destination, fs::metadata(&file)?.permissions())?;
            revisions.insert(relative.to_owned(), revision);
        }
        if revisions.is_empty() {
            return Ok(None);
        }
        let alternate = tempfile::NamedTempFile::new_in(
            index
                .parent()
                .ok_or_else(|| Error::new("git", "The Git index is unavailable."))?,
        )?;
        fs::remove_file(alternate.path())?;
        let initial = old_head.unwrap_or("--empty");
        git_index(
            &project.root,
            &["read-tree", initial],
            Some(alternate.path()),
            None,
        )
        .await?;
        let mut add = vec!["add", "--"];
        add.extend(revisions.keys().map(String::as_str));
        git_index(
            &project.root,
            &add,
            Some(alternate.path()),
            Some(snapshot.path()),
        )
        .await?;
        let tree = git_index(&project.root, &["write-tree"], Some(alternate.path()), None).await?;
        let mut create = vec!["commit-tree", tree.trim()];
        if let Some(head) = old_head {
            create.extend(["-p", head]);
        }
        create.extend(["-m", "UnderTree manuscript review checkpoint"]);
        let commit = git_index(&project.root, &create, Some(alternate.path()), None).await?;
        if git(&project.root, &["branch", "--show-current"])
            .await?
            .trim()
            != branch
        {
            return Err(Error::new(
                "conflict",
                "The current branch changed while synchronizing.",
            ));
        }
        let mut index_bytes = Vec::new();
        fs::File::open(alternate.path())?
            .take(64 * 1024 * 1024 + 1)
            .read_to_end(&mut index_bytes)?;
        if index_bytes.len() > 64 * 1024 * 1024 {
            return Err(Error::new(
                "limit",
                "The Git index exceeds its 64 MB checkpoint limit.",
            ));
        }
        let branch_ref = format!("refs/heads/{branch}");
        let empty = "0".repeat(commit.trim().len());
        git(
            &project.root,
            &[
                "update-ref",
                &branch_ref,
                commit.trim(),
                old_head.unwrap_or(&empty),
            ],
        )
        .await
        .map_err(|_| {
            Error::new(
                "conflict",
                "The branch changed during the checkpoint. The original work is preserved.",
            )
        })?;
        atomic_write(&index, &index_bytes)?;
        Ok(Some(commit.trim().to_owned()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn confines_paths_and_preserves_external_edits() {
        let temporary = tempfile::tempdir().unwrap();
        let root = temporary.path().join("project");
        fs::create_dir(&root).unwrap();
        fs::write(root.join("main.html"), "<p>Hello</p>").unwrap();
        let service = Service::new(temporary.path().join("state")).unwrap();
        let p = service
            .local(Operation::AddProject {
                root: root.to_string_lossy().into(),
            })
            .unwrap();
        let id = p["id"].as_str().unwrap().to_owned();
        assert!(service
            .local(Operation::Open {
                project: id.clone(),
                path: "../main.html".into()
            })
            .is_err());
        let opened = service
            .local(Operation::Open {
                project: id.clone(),
                path: "main.html".into(),
            })
            .unwrap();
        fs::write(root.join("main.html"), "<p>External</p>").unwrap();
        let err = service
            .local(Operation::Save {
                project: id,
                path: "main.html".into(),
                revision: opened["review"]["revision"].as_str().unwrap().into(),
                content: "<p>Mine</p>".into(),
            })
            .unwrap_err();
        assert_eq!(err.code, "stale");
        assert_eq!(
            fs::read_to_string(root.join("main.html")).unwrap(),
            "<p>External</p>"
        );
    }
    #[test]
    fn remote_is_suggestion_only_and_revocable() {
        let temporary = tempfile::tempdir().unwrap();
        let root = temporary.path().join("project");
        fs::create_dir(&root).unwrap();
        fs::write(root.join("main.html"), "<p>Hello</p>").unwrap();
        let service = Service::new(temporary.path().join("state")).unwrap();
        let p = service
            .local(Operation::AddProject {
                root: root.to_string_lossy().into(),
            })
            .unwrap();
        let id = p["id"].as_str().unwrap().to_owned();
        let share = service
            .local(Operation::Share {
                project: id.clone(),
                path: "main.html".into(),
                enabled: true,
            })
            .unwrap();
        let doc = share["documentId"].as_str().unwrap();
        assert!(service.remote("save", json!({})).is_err());
        service.remote("suggest_text",json!({"documentId":doc,"proposal":{"requestId":"1","revision":digest("<p>Hello</p>"),"from":3,"to":8,"quote":"Hello","replacement":"Hi","rationale":"Concise"}})).unwrap();
        assert_eq!(
            fs::read_to_string(root.join("main.html")).unwrap(),
            "<p>Hello</p>"
        );
        assert!(sidecar(&root.join("main.html")).exists());
        service
            .local(Operation::Share {
                project: id,
                path: "main.html".into(),
                enabled: false,
            })
            .unwrap();
        assert!(service
            .remote("read_manuscript", json!({"documentId":doc}))
            .is_err());
    }
    #[test]
    fn journal_recovers_interrupted_acceptance() {
        let temporary = tempfile::tempdir().unwrap();
        let file = temporary.path().join("main.html");
        fs::write(&file, "<p>Hello</p>").unwrap();
        let service = Service::new(temporary.path().join("state")).unwrap();
        let journal = Journal {
            old_revision: digest("<p>Hello</p>"),
            content: "<p>Hi</p>".into(),
            review: Review::new("<p>Hi</p>"),
        };
        fs::write(journal_path(&file), serde_json::to_vec(&journal).unwrap()).unwrap();
        assert_eq!(service.read_document(&file).unwrap().0, "<p>Hi</p>");
        assert!(!journal_path(&file).exists());
    }
    async fn git_fixture() -> (tempfile::TempDir, Arc<Service>, Project, PathBuf) {
        let temporary = tempfile::tempdir().unwrap();
        let root = temporary.path().join("project");
        fs::create_dir(&root).unwrap();
        let remote = temporary.path().join("remote.git");
        git(
            temporary.path(),
            &["init", "--bare", remote.to_str().unwrap()],
        )
        .await
        .unwrap();
        git(&root, &["init", "-b", "main"]).await.unwrap();
        git(&root, &["config", "user.name", "UnderTree Fixture"])
            .await
            .unwrap();
        git(&root, &["config", "user.email", "fixture@example.invalid"])
            .await
            .unwrap();
        git(
            &root,
            &["remote", "add", "origin", remote.to_str().unwrap()],
        )
        .await
        .unwrap();
        fs::write(root.join("main.typ"), "= Manuscript\n\nHello.\n").unwrap();
        fs::write(root.join("other.txt"), "Other editor's file").unwrap();
        git(&root, &["add", "--", "main.typ", "other.txt"])
            .await
            .unwrap();
        git(&root, &["commit", "-m", "Initial manuscript"])
            .await
            .unwrap();
        git(&root, &["push", "origin", "HEAD:refs/heads/main"])
            .await
            .unwrap();
        let service = Service::new(temporary.path().join("state")).unwrap();
        let project: Project = serde_json::from_value(
            service
                .local(Operation::AddProject {
                    root: root.to_string_lossy().into(),
                })
                .unwrap(),
        )
        .unwrap();
        (temporary, service, project, remote)
    }

    async fn sync_fixture(service: &Service, project: &Project) -> Result<Value> {
        let url = git(&project.root, &["remote", "get-url", "origin"]).await?;
        service.sync_remote(project, url.trim(), url.trim()).await
    }

    fn save_fixture(service: &Service, project: &Project, content: &str) -> Project {
        let open = service
            .local(Operation::Open {
                project: project.id.clone(),
                path: "main.typ".into(),
            })
            .unwrap();
        service
            .local(Operation::Save {
                project: project.id.clone(),
                path: "main.typ".into(),
                revision: open["review"]["revision"].as_str().unwrap().into(),
                content: content.into(),
            })
            .unwrap();
        service.project(&project.id).unwrap()
    }

    #[tokio::test]
    async fn checkpoint_commits_only_saved_sources_and_clears_confirmed_pending() {
        let (_temporary, service, project, remote) = git_fixture().await;
        let project = save_fixture(&service, &project, "= Manuscript\n\nHello, world.\n");
        let temporary_source = project.root.join(".undertree-compile-fixture.typ");
        fs::write(&temporary_source, "Immutable compiler snapshot").unwrap();
        let result = sync_fixture(&service, &project).await.unwrap();
        assert_eq!(
            fs::read_to_string(&temporary_source).unwrap(),
            "Immutable compiler snapshot"
        );
        assert!(git(&project.root, &["ls-tree", "--name-only", "HEAD"])
            .await
            .unwrap()
            .lines()
            .all(|name| !name.starts_with(".undertree-compile-")));
        fs::remove_file(&temporary_source).unwrap();
        let head = result["head"].as_str().unwrap();
        assert_eq!(
            git(&remote, &["show", &format!("{head}:main.typ")])
                .await
                .unwrap(),
            "= Manuscript\n\nHello, world.\n"
        );
        let files = git(
            &project.root,
            &["diff-tree", "--no-commit-id", "--name-only", "-r", head],
        )
        .await
        .unwrap();
        assert_eq!(
            files.lines().collect::<Vec<_>>(),
            vec!["main.typ", "main.typ.undertree-review.json"]
        );
        assert!(git(&project.root, &["status", "--porcelain=v1"])
            .await
            .unwrap()
            .is_empty());
        assert!(service.project(&project.id).unwrap().pending.is_empty());
        assert!(!project.root.join(".git/index.lock").exists());
    }

    #[tokio::test]
    async fn sync_rejects_unrelated_staging_and_external_edits_to_pending_files() {
        let (_temporary, service, project, _remote) = git_fixture().await;
        let project = save_fixture(&service, &project, "= Manuscript\n\nSaved edit.\n");
        let original_head = git_head(&project.root).await.unwrap();
        fs::write(project.root.join("other.txt"), "Unrelated staged work").unwrap();
        git(&project.root, &["add", "--", "other.txt"])
            .await
            .unwrap();
        assert_eq!(
            sync_fixture(&service, &project).await.unwrap_err().code,
            "conflict"
        );
        assert_eq!(git_head(&project.root).await.unwrap(), original_head);
        assert_eq!(
            git(&project.root, &["diff", "--cached", "--name-only"])
                .await
                .unwrap()
                .trim(),
            "other.txt"
        );
        git(&project.root, &["reset", "--", "other.txt"])
            .await
            .unwrap();
        git(&project.root, &["checkout", "--", "other.txt"])
            .await
            .unwrap();
        fs::write(project.root.join("main.typ"), "External replacement").unwrap();
        assert_eq!(
            sync_fixture(&service, &project).await.unwrap_err().code,
            "conflict"
        );
        assert_eq!(git_head(&project.root).await.unwrap(), original_head);
        assert_eq!(
            fs::read_to_string(project.root.join("main.typ")).unwrap(),
            "External replacement"
        );
        assert!(!project.root.join(".git/index.lock").exists());
    }

    #[tokio::test]
    async fn sync_rejects_divergence_without_rewriting_local_history() {
        let (temporary, service, project, remote) = git_fixture().await;
        let other = temporary.path().join("other");
        git(
            temporary.path(),
            &[
                "clone",
                "-b",
                "main",
                remote.to_str().unwrap(),
                other.to_str().unwrap(),
            ],
        )
        .await
        .unwrap();
        git(&other, &["config", "user.name", "Other Editor"])
            .await
            .unwrap();
        git(&other, &["config", "user.email", "other@example.invalid"])
            .await
            .unwrap();
        fs::write(other.join("other.txt"), "Remote work").unwrap();
        git(&other, &["add", "--", "other.txt"]).await.unwrap();
        git(&other, &["commit", "-m", "Remote work"]).await.unwrap();
        git(&other, &["push", "origin", "main"]).await.unwrap();
        fs::write(project.root.join("main.typ"), "Local committed work").unwrap();
        git(&project.root, &["add", "--", "main.typ"])
            .await
            .unwrap();
        git(&project.root, &["commit", "-m", "Local work"])
            .await
            .unwrap();
        let head = git_head(&project.root).await.unwrap();
        assert_eq!(
            sync_fixture(&service, &project).await.unwrap_err().code,
            "conflict"
        );
        assert_eq!(git_head(&project.root).await.unwrap(), head);
        assert_eq!(
            fs::read_to_string(project.root.join("main.typ")).unwrap(),
            "Local committed work"
        );
        assert_eq!(
            fs::read_to_string(project.root.join("other.txt")).unwrap(),
            "Other editor's file"
        );
    }

    #[test]
    fn malformed_recovery_is_preserved_without_writing_manuscript() {
        let temporary = tempfile::tempdir().unwrap();
        let file = temporary.path().join("main.typ");
        fs::write(&file, "Original manuscript").unwrap();
        let service = Service::new(temporary.path().join("state")).unwrap();
        let mut review = Review::new("Replacement");
        review.version = 99;
        let journal = Journal {
            old_revision: digest("Original manuscript"),
            content: "Replacement".into(),
            review,
        };
        fs::write(journal_path(&file), serde_json::to_vec(&journal).unwrap()).unwrap();
        assert!(service.read_document(&file).is_err());
        assert_eq!(fs::read_to_string(&file).unwrap(), "Original manuscript");
        assert!(journal_path(&file).exists());
        assert!(!sidecar(&file).exists());
    }
    #[tokio::test]
    async fn sync_creates_first_checkpoint_in_empty_remote() {
        let temporary = tempfile::tempdir().unwrap();
        let root = temporary.path().join("project");
        fs::create_dir(&root).unwrap();
        let remote = temporary.path().join("remote.git");
        git(
            temporary.path(),
            &["init", "--bare", remote.to_str().unwrap()],
        )
        .await
        .unwrap();
        git(&root, &["init", "-b", "main"]).await.unwrap();
        git(&root, &["config", "user.name", "UnderTree Fixture"])
            .await
            .unwrap();
        git(&root, &["config", "user.email", "fixture@example.invalid"])
            .await
            .unwrap();
        git(
            &root,
            &["remote", "add", "origin", remote.to_str().unwrap()],
        )
        .await
        .unwrap();
        let service = Service::new(temporary.path().join("state")).unwrap();
        let project: Project = serde_json::from_value(
            service
                .local(Operation::AddProject {
                    root: root.to_string_lossy().into(),
                })
                .unwrap(),
        )
        .unwrap();
        service
            .local(Operation::Create {
                project: project.id.clone(),
                path: "main.typ".into(),
            })
            .unwrap();
        let project = service.project(&project.id).unwrap();
        let result = sync_fixture(&service, &project).await.unwrap();
        assert_eq!(
            git(&remote, &["rev-parse", "refs/heads/main"])
                .await
                .unwrap()
                .trim(),
            result["head"].as_str().unwrap()
        );
        assert!(git(&project.root, &["status", "--porcelain=v1"])
            .await
            .unwrap()
            .is_empty());
    }
}
