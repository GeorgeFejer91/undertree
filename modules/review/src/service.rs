use crate::capabilities::{CallerContext, CONTRACT_VERSION};
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

pub mod app_control;
pub mod editor;
pub mod file_import;
mod journal_ownership;
pub(crate) mod pdf_exports;
mod policy_continuity;
pub mod project_export;
mod project_tree;

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
    pub main_document: String,
    #[serde(default)]
    pub pending: BTreeSet<String>,
    #[serde(default)]
    pub pending_revisions: BTreeMap<String, String>,
}

#[derive(Clone, Default, Serialize, Deserialize)]
struct Registry {
    projects: Vec<Project>,
}

pub struct Service {
    instance_id: String,
    state: PathBuf,
    registry: Mutex<Registry>,
    documents: tokio::sync::Mutex<()>,
    pub shared: Mutex<BTreeMap<String, (String, String)>>,
    pub tunnel: tokio::sync::Mutex<Option<Tunnel>>,
    pub sync_lock: tokio::sync::Mutex<()>,
    pub compile_lock: Arc<tokio::sync::Mutex<()>>,
    connection_settings: Mutex<crate::transport::ConnectionSettings>,
    editor: Mutex<editor::EditorState>,
    file_import: Mutex<file_import::ImportState>,
    import_capture: Mutex<()>,
    project_export: Mutex<project_export::ExportState>,
    export_capture: Mutex<()>,
    #[cfg(test)]
    import_before_publish: Mutex<Option<Box<dyn FnOnce() + Send>>>,
    #[cfg(test)]
    fail_after_journal: Mutex<bool>,
    #[cfg(test)]
    create_after_publish: Mutex<Option<PublicationHook>>,
    app_control: Mutex<app_control::AppControlState>,
    pdf_exports: Mutex<pdf_exports::PdfExportState>,
    policy_continuity: Mutex<policy_continuity::PolicyContinuity>,
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
#[serde(deny_unknown_fields)]
struct Journal {
    old_revision: String,
    content: String,
    review: Review,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    editor_receipt: Option<editor::SaveReceipt>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    prior_review: Option<policy_continuity::ReviewObservation>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    ownership: Option<journal_ownership::JournalOwnership>,
}

#[cfg(test)]
type PublicationHook = Box<dyn FnOnce() -> Result<()> + Send>;

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

fn editable_source(path: &Path) -> bool {
    let name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("");
    ![
        ".undertree-review.json",
        ".undertree-pending.json",
        ".import-report.json",
    ]
    .iter()
    .any(|suffix| name.ends_with(suffix))
        && [
            "html", "htm", "typ", "css", "md", "txt", "tex", "bib", "yaml", "yml", "json", "csv",
            "tsv", "xml", "svg",
        ]
        .contains(
            &path
                .extension()
                .and_then(|extension| extension.to_str())
                .unwrap_or(""),
        )
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
            instance_id: Uuid::new_v4().to_string(),
            state,
            registry: Mutex::new(registry),
            documents: tokio::sync::Mutex::new(()),
            shared: Mutex::new(BTreeMap::new()),
            tunnel: tokio::sync::Mutex::new(None),
            sync_lock: tokio::sync::Mutex::new(()),
            compile_lock: Arc::new(tokio::sync::Mutex::new(())),
            connection_settings: Mutex::new(settings),
            editor: Mutex::new(editor::EditorState::default()),
            file_import: Mutex::new(file_import::ImportState::default()),
            import_capture: Mutex::new(()),
            project_export: Mutex::new(project_export::ExportState::default()),
            export_capture: Mutex::new(()),
            #[cfg(test)]
            import_before_publish: Mutex::new(None),
            #[cfg(test)]
            fail_after_journal: Mutex::new(false),
            #[cfg(test)]
            create_after_publish: Mutex::new(None),
            app_control: Mutex::new(app_control::AppControlState::default()),
            pdf_exports: Mutex::new(pdf_exports::PdfExportState::default()),
            policy_continuity: Mutex::new(policy_continuity::PolicyContinuity::default()),
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
        let project = lock(&self.registry)?
            .projects
            .iter()
            .find(|p| p.id == id)
            .cloned()
            .ok_or_else(|| Error::new("project", "Choose an approved project."))?;
        self.checked_root(&project)?;
        Ok(project)
    }

    pub fn path(&self, project: &Project, relative: &str, create: bool) -> Result<PathBuf> {
        self.checked_root(project)?;
        let relative = Path::new(relative);
        if relative.as_os_str().is_empty()
            || relative
                .components()
                .any(|c| !matches!(c, Component::Normal(_)))
            || relative
                .components()
                .any(|c| c.as_os_str().to_string_lossy().starts_with('.'))
            || !editable_source(relative)
        {
            return Err(Error::new(
                "path",
                "Choose an editable source, bibliography, or data file inside this project.",
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

    fn read_document(
        &self,
        project: &Project,
        relative: &str,
        path: &Path,
    ) -> Result<(String, Review)> {
        let pending = journal_path(path);
        if pending.exists() {
            let journal_raw =
                read_text(&pending, MAX_TEXT * 9).map_err(|_| policy_continuity::conflict())?;
            let journal: Journal =
                serde_json::from_str(&journal_raw).map_err(|_| policy_continuity::conflict())?;
            journal
                .review
                .validate_for_text(&journal.content)
                .map_err(|_| policy_continuity::conflict())?;
            if journal.content.len() > MAX_TEXT
                || journal.review.revision != digest(&journal.content)
                || journal.old_revision.len() != 64
                || !journal.old_revision.bytes().all(|b| b.is_ascii_hexdigit())
            {
                return Err(policy_continuity::conflict());
            }
            let ownership = self.journal_ownership(project, relative, path, &journal)?;
            let current = read_text(path, MAX_TEXT)?;
            if digest(&current) != journal.old_revision && current != journal.content {
                return Err(Error::new("conflict", "A pending save conflicts with external edits. Both versions have been retained; resolve the pending JSON file first."));
            }
            let metadata_raw = self.raw_review(path)?;
            let final_review = serde_json::to_string_pretty(&journal.review)?;
            self.recovery_policy(
                path,
                &current,
                metadata_raw.as_deref(),
                journal.prior_review.as_ref(),
                &final_review,
            )?;
            self.unchanged_policy(path, metadata_raw.as_deref())?;
            if read_text(path, MAX_TEXT)? != current
                || fs::read(&pending)? != journal_raw.as_bytes()
            {
                return Err(policy_continuity::conflict());
            }
            if current != journal.content {
                atomic_write(path, journal.content.as_bytes())?;
            }
            self.unchanged_policy(path, metadata_raw.as_deref())?;
            atomic_write(&sidecar(path), final_review.as_bytes())?;
            self.observe_policy(path, Some(&final_review))?;
            self.finish_journal_ownership(&ownership, path, &journal.content, &final_review)?;
            if let Some(receipt) = journal.editor_receipt {
                self.write_committed_receipt(&receipt)?;
            }
            if fs::read(&pending)? != journal_raw.as_bytes() {
                return Err(policy_continuity::conflict());
            }
            fs::remove_file(pending)?;
        }
        self.read_document_without_recovery(path)
    }

    fn read_document_without_recovery(&self, path: &Path) -> Result<(String, Review)> {
        match fs::symlink_metadata(journal_path(path)) {
            Ok(_) => {
                return Err(Error::new(
                    "busy",
                    "Resolve the pending local save before inspecting this document.",
                ))
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => (),
            Err(error) => return Err(error.into()),
        }
        let content = read_text(path, MAX_TEXT)?;
        let raw = self.raw_review(path)?;
        let mut review = self.validated_review(path, &content, raw.as_deref())?;
        review.invalidate_external(&content);
        Ok((content, review))
    }

    fn persist(
        &self,
        project: &str,
        relative: &str,
        path: &Path,
        previous: Option<&str>,
        content: &str,
        review: &Review,
    ) -> Result<()> {
        self.persist_with_receipt(project, relative, path, previous, content, review, None)
    }

    #[allow(clippy::too_many_arguments)]
    fn persist_with_receipt(
        &self,
        project: &str,
        relative: &str,
        path: &Path,
        previous: Option<&str>,
        content: &str,
        review: &Review,
        receipt: Option<&editor::SaveReceipt>,
    ) -> Result<()> {
        // None is reserved for a source just written with create_new by Create or Import.
        let owns_source = previous.is_none_or(|old| old != content);
        let old = previous.unwrap_or(content);
        let ownership = journal_ownership::JournalOwnership {
            project: project.into(),
            path: relative.into(),
            owns_source,
        };
        self.validate_save_ownership(&ownership, path)?;
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
        let mut written_journal = None;
        if journal_path(path).symlink_metadata().is_ok() {
            return Err(Error::new(
                "busy",
                "A pending save appeared before persistence. Its bytes have been preserved.",
            ));
        }
        let prior_raw = self.raw_review(path)?;
        let prior_review = self.captured_policy(path, prior_raw.as_deref())?;
        self.policy_capacity(&[path.to_path_buf()])?;
        if content != old || receipt.is_some() {
            let journal = Journal {
                old_revision: digest(old),
                content: content.to_owned(),
                review: review.clone(),
                editor_receipt: receipt.cloned(),
                prior_review: Some(prior_review),
                ownership: Some(ownership.clone()),
            };
            self.journal_ownership(&self.project(project)?, relative, path, &journal)?;
            let bytes = serde_json::to_vec_pretty(&journal)?;
            atomic_write(&journal_path(path), &bytes)?;
            written_journal = Some(bytes);
            #[cfg(test)]
            if std::mem::take(&mut *lock(&self.fail_after_journal)?) {
                return Err(Error::new(
                    "io",
                    "Injected interruption after the save intent.",
                ));
            }
            if content != old {
                self.unchanged_policy(path, prior_raw.as_deref())?;
                atomic_write(path, content.as_bytes())?;
            }
        }
        self.unchanged_policy(path, prior_raw.as_deref())?;
        atomic_write(&sidecar(path), review_json.as_bytes())?;
        self.observe_policy(path, Some(&review_json))?;
        self.finish_journal_ownership(&ownership, path, content, &review_json)?;
        if let Some(receipt) = receipt {
            self.write_committed_receipt(receipt)?;
        }
        if let Some(bytes) = written_journal {
            if fs::read(journal_path(path))? != bytes {
                return Err(Error::new(
                    "conflict",
                    "A different pending save appeared. It has been preserved.",
                ));
            }
            fs::remove_file(journal_path(path))?;
        }
        Ok(())
    }

    fn create_document(
        &self,
        project: &Project,
        relative: &str,
        path: &Path,
        content: &str,
        report: Option<&str>,
    ) -> Result<Value> {
        self.check_policy_continuity(path, self.raw_review(path)?.as_deref())?;
        self.policy_capacity(&[path.to_path_buf()])?;
        let report_path = PathBuf::from(format!("{}.import-report.json", path.to_string_lossy()));
        for artifact in [
            path.to_path_buf(),
            sidecar(path),
            journal_path(path),
            report_path.clone(),
        ] {
            match fs::symlink_metadata(artifact) {
                Ok(_) => return Err(Error::new("conflict", "The destination or its adjacent metadata already exists. Choose a new filename or preserve and resolve those files first.")),
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => (),
                Err(error) => return Err(error.into()),
            }
        }
        if content.len() > MAX_TEXT || report.is_some_and(|report| report.len() > MAX_TEXT * 8) {
            return Err(Error::new(
                "limit",
                "The new source or import report exceeds its supported size limit.",
            ));
        }
        let review = Review::new(content);
        review.validate_for_text(content)?;
        let mut outputs = vec![
            (relative.to_owned(), path.to_path_buf(), content.to_owned()),
            (
                format!("{relative}.undertree-review.json"),
                sidecar(path),
                serde_json::to_string_pretty(&review)?,
            ),
        ];
        if let Some(report) = report {
            outputs.push((
                format!("{relative}.import-report.json"),
                report_path,
                report.to_owned(),
            ));
        }
        let parent = path
            .parent()
            .ok_or_else(|| Error::new("path", "The new source has no project directory."))?;
        let mut staged = Vec::new();
        for (relative, destination, content) in &outputs {
            let mut temporary = tempfile::NamedTempFile::new_in(parent)?;
            temporary.write_all(content.as_bytes())?;
            temporary.as_file().sync_all()?;
            staged.push((relative, destination, content, temporary));
        }
        let mut registry = lock(&self.registry)?;
        let mut next = registry.clone();
        let registered = next
            .projects
            .iter_mut()
            .find(|entry| entry.id == project.id)
            .ok_or_else(|| Error::new("project", "Project unavailable."))?;
        for (relative, _, content) in &outputs {
            registered.pending.insert(relative.clone());
            registered
                .pending_revisions
                .insert(relative.clone(), digest(content));
        }
        let registry_json = serde_json::to_string_pretty(&next)?;
        if registry_json.len() > MAX_TEXT {
            return Err(Error::new(
                "limit",
                "The project registry exceeds its supported size limit.",
            ));
        }
        let mut created = Vec::new();
        let mut registry_attempted = false;
        let result = (|| -> Result<()> {
            for (_, destination, content, temporary) in staged {
                temporary.persist_noclobber(destination).map_err(|error| {
                    if error.error.kind() == std::io::ErrorKind::AlreadyExists {
                        Error::new("conflict", "A destination appeared while creating the document. Existing files have been preserved.")
                    } else { Error::from(error.error) }
                })?;
                created.push((destination.as_path(), content.as_str()));
                #[cfg(test)]
                if let Some(hook) = lock(&self.create_after_publish)?.take() {
                    hook()?;
                }
            }
            #[cfg(unix)]
            fs::File::open(parent)?.sync_all()?;
            registry_attempted = true;
            self.save_registry(&next)
        })();
        if let Err(error) = result {
            // A registry rename may succeed before its directory sync fails; retain a consistent result.
            if registry_attempted
                && read_text(&self.state.join("projects.json"), MAX_TEXT)
                    .is_ok_and(|current| current == registry_json)
            {
                *registry = next;
                return Err(Error::new("outcome_unknown", "The new document exists, but durable creation could not be confirmed. Inspect it before retrying."));
            }
            return Err(if !created.is_empty() {
                Error::new("outcome_unknown", "Creation stopped after publishing files. Published and externally changed files were preserved; inspect the destination before retrying.")
            } else {
                error
            });
        }
        *registry = next;
        drop(registry);
        self.snapshot(project, relative, path)
    }

    fn snapshot(&self, project: &Project, relative: &str, path: &Path) -> Result<Value> {
        let (content, review) = self.read_document(project, relative, path)?;
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
            Operation::Capabilities => self.capabilities(CallerContext::Local),
            Operation::SaveEditor { .. } | Operation::SaveReceipt { .. } => Err(Error::new(
                "scope",
                "Use the asynchronous editor-session action dispatcher.",
            )),
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
                    main_document: String::new(),
                    pending: BTreeSet::new(),
                    pending_revisions: BTreeMap::new(),
                };
                registry.projects.push(project.clone());
                self.save_registry(&registry)?;
                Ok(json!(project))
            }
            Operation::SetMainDocument { project, path } => {
                let approved = self.project(&project)?;
                if !path.is_empty() {
                    let file = self.path(&approved, &path, false)?;
                    if file.extension().and_then(|extension| extension.to_str()) != Some("typ") {
                        return Err(Error::new(
                            "source",
                            "Choose an existing Typst main document.",
                        ));
                    }
                    read_text(&file, MAX_TEXT)?;
                }
                let mut registry = lock(&self.registry)?;
                let mut next = registry.clone();
                let updated = next
                    .projects
                    .iter_mut()
                    .find(|entry| entry.id == project)
                    .ok_or_else(|| Error::new("project", "Choose an approved project."))?;
                updated.main_document = path;
                let result = json!(updated);
                self.save_registry(&next)?;
                *registry = next;
                Ok(result)
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
                        } else if kind.is_file() && editable_source(&path) {
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
            Operation::ProjectTree { project } => self.project_tree(&project),
            Operation::CreateDirectory { project, path } => self.create_directory(&project, &path),
            Operation::Open { project, path } => {
                let project = self.project(&project)?;
                self.snapshot(&project, &path, &self.path(&project, &path, false)?)
            }
            Operation::Review { project, path } => {
                let project = self.project(&project)?;
                let file = self.path(&project, &path, false)?;
                let (content, review) = self.read_document_without_recovery(&file)?;
                let id = digest(&format!("{}:{path}", project.id));
                let shared = lock(&self.shared)?.contains_key(&id);
                Ok(
                    json!({"documentId":id,"path":path,"content":content,"review":review,"shared":shared}),
                )
            }
            Operation::Create { project, path } => {
                let p = self.project(&project)?;
                let file = self.path(&p, &path, true)?;
                let content = if path.ends_with(".typ") {
                    "#set page(paper: \"a4\")\n#set text(size: 11pt)\n\n= Manuscript\n\nStart writing here.\n"
                } else if path.ends_with(".html") || path.ends_with(".htm") {
                    "<!doctype html>\n<html lang=\"en\">\n<head><meta charset=\"UTF-8\"><title>Manuscript</title></head>\n<body>\n<h1>Manuscript</h1>\n<p>Start writing here.</p>\n</body>\n</html>\n"
                } else {
                    ""
                };
                self.create_document(&p, &path, &file, content, None)
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
                let report_json = serde_json::to_string_pretty(&converted)?;
                let snapshot = self.create_document(
                    &p,
                    &target,
                    &destination,
                    &converted.content,
                    Some(&report_json),
                )?;
                Ok(
                    json!({"snapshot":snapshot,"warnings":converted.warnings,"exactFormatting":false}),
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
                let (old, mut review) = self.read_document(&p, &path, &file)?;
                review.check_revision(&revision, &old)?;
                review.reconcile(&old, &content);
                self.persist(&project, &path, &file, Some(&old), &content, &review)?;
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
                let (text, mut review) = self.read_document(&p, &path, &file)?;
                review.check_revision(&revision, &text)?;
                review.rules = rules;
                self.persist(&project, &path, &file, Some(&text), &text, &review)?;
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
                let (text, mut review) = self.read_document(&p, &path, &file)?;
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
                self.persist(&project, &path, &file, Some(&text), &text, &review)?;
                self.snapshot(&p, &path, &file)
            }
            Operation::Reanchor {
                project,
                path,
                revision,
                id,
                from,
                to,
                quote,
            } => {
                let p = self.project(&project)?;
                let file = self.path(&p, &path, false)?;
                let (text, mut review) = self.read_document(&p, &path, &file)?;
                review.reanchor(&text, &revision, &id, from..to, &quote)?;
                self.persist(&project, &path, &file, Some(&text), &text, &review)?;
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
                let (text, mut review) = self.read_document(&p, &path, &file)?;
                review.check_revision(&revision, &text)?;
                review.markers.retain(|m| m.id != id);
                self.persist(&project, &path, &file, Some(&text), &text, &review)?;
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
                let (text, mut review) = self.read_document(&p, &path, &file)?;
                let changed = review.decide_format(
                    &text,
                    &revision,
                    &id,
                    decision,
                    path.ends_with(".typ"),
                )?;
                self.persist(&project, &path, &file, Some(&text), &changed, &review)?;
                self.snapshot(&p, &path, &file)
            }
            Operation::Share {
                project,
                path,
                enabled,
            } => {
                let id = digest(&format!("{project}:{path}"));
                if !enabled {
                    lock(&self.shared)?.remove(&id);
                    self.revoke_app_controls()?;
                    return Ok(json!({"documentId":id,"shared":false}));
                }
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
                // Enrollment cannot interpret lost or corrupt existing policy as an empty review.
                self.read_document_without_recovery(&file)?;
                let mut shared = lock(&self.shared)?;
                if shared.len() >= 20 {
                    return Err(Error::new(
                        "limit",
                        "At most 20 manuscripts can be shared in one session.",
                    ));
                }
                shared.insert(id.clone(), (project, path));
                drop(shared);
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
                    let (text, mut review) = self.read_document_without_recovery(&file)?;
                    let suggestion =
                        review.propose_format(&text, proposal, path.ends_with(".typ"))?;
                    self.persist(&project, &path, &file, Some(&text), &text, &review)?;
                    Ok(json!({"suggestion":suggestion,"manuscriptChanged":false}))
                } else {
                    let (content, review) = self.read_document_without_recovery(&file)?;
                    Ok(
                        json!({"documentId":id,"path":path,"content":content,"review":review,"shared":true}),
                    )
                }
            }
            _ => Err(Error::new(
                "scope",
                "Agents can only list shared manuscripts, read them, and submit suggestions.",
            )),
        }
    }

    pub(crate) fn instance_id(&self) -> &str {
        &self.instance_id
    }

    pub fn capabilities(&self, caller: CallerContext) -> Result<Value> {
        if caller == CallerContext::Review {
            return Err(Error::new("scope", "Use the three granted Review tools."));
        }
        let review_tools: Vec<_> = crate::transport::tool_catalogue()
            .as_array()
            .ok_or_else(|| Error::new("state", "The review catalogue is unavailable."))?
            .iter()
            .filter_map(|tool| tool["name"].as_str().map(str::to_owned))
            .collect();
        let operations: Vec<_> = crate::LOCAL_OPERATIONS
            .iter()
            .filter(|operation| {
                caller != CallerContext::LocalCli
                    || (!matches!(operation.action, "project_tree" | "create_directory")
                        && (!operation.mutates || operation.action == "save_editor"))
            })
            .collect();
        Ok(json!({
            "contractVersion": CONTRACT_VERSION,
            "instanceId": self.instance_id,
            "caller": caller,
            "localOperations": operations,
            "access": {"readOnly":false,"editorSaveRequires":["live_registered_ui","document_session_barrier"],"otherCliMutations":false},
            "review": {
                "available": true,
                "requires": ["active_connection", "private_review_capability", "explicit_manuscript_share"],
                "tools": review_tools
            },
            "fullControl": {
                "available": false,
                "reason": "unsupported_file_editing",
                "sourceEditing": false
            },
            "appControls": {
                "supported":true,"grantRequired":true,"reviewSeparate":true,"sourceEditing":false,
                "tools":app_control::tool_catalogue().as_array().map(|tools|tools.iter().filter_map(|tool|tool["name"].as_str()).collect::<Vec<_>>())
            }
        }))
    }

    pub async fn dispatch(self: &Arc<Self>, operation: Operation) -> Result<Value> {
        self.dispatch_as(CallerContext::Local, operation).await
    }

    pub async fn dispatch_as(
        self: &Arc<Self>,
        caller: CallerContext,
        operation: Operation,
    ) -> Result<Value> {
        if caller == CallerContext::Review {
            return Err(Error::new(
                "scope",
                "Review authority cannot invoke local product operations.",
            ));
        }
        if caller != CallerContext::Local
            && matches!(
                operation,
                Operation::ProjectTree { .. } | Operation::CreateDirectory { .. }
            )
        {
            return Err(Error::new(
                "scope",
                "Project tree and folder creation require the authenticated local UI.",
            ));
        }
        if caller == CallerContext::LocalCli
            && operation.mutates()
            && !matches!(operation, Operation::SaveEditor { .. })
        {
            return Err(Error::new("unsupported_capability", "The local CLI can only save a registered editor buffer; other mutations are unavailable."));
        }
        match operation {
            Operation::Capabilities => self.capabilities(caller),
            Operation::ProjectTree { project } => {
                let service = self.clone();
                tokio::task::spawn_blocking(move || service.project_tree(&project))
                    .await
                    .map_err(|_| {
                        Error::new("state", "The project inventory stopped unexpectedly.")
                    })?
            }
            Operation::SaveEditor {
                project,
                path,
                request_id,
            } => self.request_editor_save(&project, &path, &request_id).await,
            Operation::SaveReceipt { request_id } => self.editor_save_receipt(&request_id),
            Operation::Tunnel {
                enabled,
                reservation,
                public_url,
            } => crate::transport::tunnel(self, enabled, reservation, public_url).await,
            Operation::Connection => {
                let mut value = crate::transport::connection(self).await?;
                if caller == CallerContext::LocalCli {
                    if let Some(control) =
                        value.get_mut("appControls").and_then(Value::as_object_mut)
                    {
                        control.remove("endpoint");
                        control.remove("pdfExport");
                    }
                }
                Ok(value)
            }
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
            Operation::Pdf { project, path } => {
                let service = self.clone();
                tokio::task::spawn_blocking(move || service.preview_pdf(&project, &path))
                    .await
                    .map_err(|_| Error::new("state", "PDF verification stopped unexpectedly."))?
            }
            Operation::Open { project, path } if caller == CallerContext::LocalCli => {
                let service = self.clone();
                tokio::task::spawn_blocking(move || {
                    service.local(Operation::Review { project, path })
                })
                .await
                .map_err(|_| {
                    Error::new(
                        "state",
                        "The read-only CLI inspection stopped unexpectedly.",
                    )
                })?
            }
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
        if !project
            .root
            .canonicalize()
            .is_ok_and(|root| root == project.root && root.is_dir())
        {
            return Err(Error::new(
                "path",
                "The approved project folder moved or became a link. Approve its current location again.",
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
        let remote = git(&p.root, &["remote", "get-url", "--all", "origin"]).await?;
        if remote.lines().count() != 1
            || (remote.trim() != expected_url
                && remote.trim() != format!("git@github.com:{}.git", p.repository))
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
        // Execute the configured remote so Git applies URL rewrites once, as get-url did.
        self.sync_remote(&p, "origin", "origin").await
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
                        if !self.project(&p.id)?.pending.is_empty()
                            || git_changes(
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
                        git(&p.root, &["merge", "--ff-only", "--no-overwrite-ignore", remote])
                            .await
                            .map_err(|_| Error::new("conflict", "The incoming update could not be applied safely. Inspect local files, including ignored files, before synchronizing."))?;
                        head = Some(remote.to_owned());
                    } else if common.trim() != remote {
                        return Err(Error::new("conflict", "GitHub and this project diverged. Resolve the histories before synchronizing."));
                    }
                }
            } else {
                return Err(Error::new("conflict", "Clone the existing GitHub project before synchronizing this new local repository."));
            }
        }
        let (checkpoint, published_revisions) = {
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
            for (relative, revision) in &published_revisions {
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
    ) -> Result<(Option<String>, BTreeMap<String, String>)> {
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
        }
        // Status omits ignored/clean files; every owned pending entry needs publication proof.
        for relative in &current.pending {
            let (bytes, permissions) = self.owned_checkpoint_input(&current, relative)?;
            let revision = format!("{:x}", <sha2::Sha256 as sha2::Digest>::digest(&bytes));
            if current.pending_revisions.get(relative) != Some(&revision) {
                return Err(Error::new("conflict", "A manuscript or its review metadata changed outside UnderTree. Review and save it before synchronizing."));
            }
            let (ignored, _) = git_output(
                &project.root,
                // check-ignore already takes literal names and rejects pathspec magic.
                &[
                    "--no-literal-pathspecs",
                    "check-ignore",
                    "--quiet",
                    "--",
                    relative,
                ],
                None,
                None,
            )
            .await?;
            if ignored.success() {
                return Err(Error::new("conflict", "An UnderTree-owned pending file is ignored by Git. Review the ignore rules before synchronizing; pending work has been kept."));
            }
            if ignored.code() != Some(1) {
                return Err(Error::new("git", "Could not check Git ignore rules."));
            }
            total = total
                .checked_add(bytes.len())
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
            fs::write(&destination, bytes)?;
            fs::set_permissions(&destination, permissions)?;
            revisions.insert(relative.to_owned(), revision);
        }
        if revisions.is_empty() {
            return Ok((None, revisions));
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
        let mut modes = BTreeMap::new();
        for relative in revisions.keys() {
            let original = git_index(
                &project.root,
                &["ls-files", "--stage", "-z", "--", relative],
                Some(alternate.path()),
                None,
            )
            .await?;
            let mode = if original.is_empty() {
                "100644"
            } else {
                let mode = original.split(' ').next().unwrap_or_default();
                if !matches!(mode, "100644" | "100755")
                    || original.matches('\0').count() != 1
                    || !original.ends_with(&format!(" 0\t{relative}\0"))
                {
                    return Err(Error::new("conflict", "A pending file has an unsupported Git mode. Resolve it locally before synchronizing."));
                }
                mode
            };
            modes.insert(relative, mode.to_owned());
        }
        let mut add = vec!["add", "--"];
        add.extend(revisions.keys().map(String::as_str));
        git_index(
            &project.root,
            &add,
            Some(alternate.path()),
            Some(snapshot.path()),
        )
        .await?;
        for relative in revisions.keys() {
            let raw = git(
                &project.root,
                &[
                    "hash-object",
                    "--no-filters",
                    "--",
                    snapshot.path().join(relative).to_str().ok_or_else(|| {
                        Error::new("path", "The checkpoint path is not valid Unicode.")
                    })?,
                ],
            )
            .await?;
            let staged = git_index(
                &project.root,
                &["ls-files", "--stage", "-z", "--", relative],
                Some(alternate.path()),
                None,
            )
            .await?;
            let expected = format!("{} {} 0\t{}\0", modes[relative], raw.trim(), relative);
            if staged != expected {
                return Err(Error::new("conflict", "Git transformed a pending file, changed its executable mode or omitted it from the checkpoint. Review mode, line-ending and filter settings before synchronizing; saved bytes and pending work have been kept."));
            }
        }
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
        Ok((Some(commit.trim().to_owned()), revisions))
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
        let project: Project = serde_json::from_value(
            service
                .local(Operation::AddProject {
                    root: temporary.path().to_str().unwrap().into(),
                })
                .unwrap(),
        )
        .unwrap();
        let mut journal = Journal {
            old_revision: digest("<p>Hello</p>"),
            content: "<p>Hi</p>".into(),
            review: Review::new("<p>Hi</p>"),
            editor_receipt: None,
            prior_review: None,
            ownership: None,
        };
        fs::write(journal_path(&file), serde_json::to_vec(&journal).unwrap()).unwrap();
        assert_eq!(
            service
                .read_document(&project, "main.html", &file)
                .unwrap_err()
                .code,
            "recovery_conflict"
        );
        assert_eq!(fs::read_to_string(&file).unwrap(), "<p>Hello</p>");
        journal.ownership = Some(journal_ownership::JournalOwnership {
            project: project.id.clone(),
            path: "main.html".into(),
            owns_source: true,
        });
        fs::write(journal_path(&file), serde_json::to_vec(&journal).unwrap()).unwrap();
        assert_eq!(
            service
                .read_document(&project, "main.html", &file)
                .unwrap()
                .0,
            "<p>Hi</p>"
        );
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
    async fn checkpoint_refuses_line_ending_and_clean_filter_transforms_without_losing_ownership() {
        for transform in ["crlf", "filter"] {
            let (_temporary, service, project, remote) = git_fixture().await;
            let content = if transform == "crlf" {
                git(&project.root, &["config", "core.autocrlf", "true"])
                    .await
                    .unwrap();
                "= Manuscript\r\n\r\nSaved CRLF text.\r\n"
            } else {
                fs::write(
                    project.root.join(".gitattributes"),
                    "main.typ filter=undertree\n",
                )
                .unwrap();
                git(&project.root, &["add", "--", ".gitattributes"])
                    .await
                    .unwrap();
                git(&project.root, &["commit", "-m", "Configure clean filter"])
                    .await
                    .unwrap();
                git(&project.root, &["push", "origin", "main"])
                    .await
                    .unwrap();
                git(
                    &project.root,
                    &["config", "filter.undertree.clean", "git stripspace"],
                )
                .await
                .unwrap();
                "= Manuscript\n\nSaved text with trailing spaces.   \n\n\n"
            };
            let project = save_fixture(&service, &project, content);
            let head = git_head(&project.root).await.unwrap();
            let remote_head = git(&remote, &["rev-parse", "refs/heads/main"])
                .await
                .unwrap();
            let index = fs::read(project.root.join(".git/index")).unwrap();
            let metadata = fs::read(sidecar(&project.root.join("main.typ"))).unwrap();
            let error = sync_fixture(&service, &project).await.unwrap_err();
            assert_eq!(error.code, "conflict", "{transform}");
            assert!(
                error.message.contains("transformed"),
                "{transform}: {}",
                error.message
            );
            assert_eq!(git_head(&project.root).await.unwrap(), head);
            assert_eq!(
                git(&remote, &["rev-parse", "refs/heads/main"])
                    .await
                    .unwrap(),
                remote_head
            );
            assert_eq!(fs::read(project.root.join(".git/index")).unwrap(), index);
            assert_eq!(
                fs::read(project.root.join("main.typ")).unwrap(),
                content.as_bytes()
            );
            assert_eq!(
                fs::read(sidecar(&project.root.join("main.typ"))).unwrap(),
                metadata
            );
            assert_eq!(
                service.project(&project.id).unwrap().pending_revisions,
                project.pending_revisions
            );
            assert!(!project.root.join(".git/index.lock").exists());
        }
    }

    #[tokio::test]
    async fn checkpoint_refuses_ignored_owned_entries_and_preserves_pending_and_index() {
        let (_temporary, service, project, remote) = git_fixture().await;
        fs::write(project.root.join(".gitignore"), "ignored.typ*\n").unwrap();
        git(&project.root, &["add", "--", ".gitignore"])
            .await
            .unwrap();
        git(&project.root, &["commit", "-m", "Ignore selected outputs"])
            .await
            .unwrap();
        git(&project.root, &["push", "origin", "main"])
            .await
            .unwrap();
        service
            .local(Operation::Create {
                project: project.id.clone(),
                path: "ignored.typ".into(),
            })
            .unwrap();
        let current = service.project(&project.id).unwrap();
        let head = git_head(&project.root).await.unwrap();
        let remote_head = git(&remote, &["rev-parse", "refs/heads/main"])
            .await
            .unwrap();
        let index = fs::read(project.root.join(".git/index")).unwrap();
        assert!(git(&project.root, &["status", "--porcelain=v1"])
            .await
            .unwrap()
            .is_empty());
        let error = sync_fixture(&service, &current).await.unwrap_err();
        assert_eq!(error.code, "conflict");
        assert!(error.message.contains("ignored"));
        assert_eq!(
            service.project(&project.id).unwrap().pending_revisions,
            current.pending_revisions
        );
        assert_eq!(git_head(&project.root).await.unwrap(), head);
        assert_eq!(
            git(&remote, &["rev-parse", "refs/heads/main"])
                .await
                .unwrap(),
            remote_head
        );
        assert_eq!(fs::read(project.root.join(".git/index")).unwrap(), index);
        assert!(!project.root.join(".git/index.lock").exists());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn checkpoint_refuses_external_executable_mode_changes() {
        use std::os::unix::fs::PermissionsExt;
        for kind in ["tracked", "new", "tracked_executable"] {
            let (_temporary, service, project, remote) = git_fixture().await;
            git(&project.root, &["config", "core.fileMode", "true"])
                .await
                .unwrap();
            if kind == "tracked_executable" {
                fs::set_permissions(
                    project.root.join("main.typ"),
                    fs::Permissions::from_mode(0o755),
                )
                .unwrap();
                git(&project.root, &["add", "--", "main.typ"])
                    .await
                    .unwrap();
                git(
                    &project.root,
                    &["commit", "-m", "Existing executable source"],
                )
                .await
                .unwrap();
                git(&project.root, &["push", "origin", "main"])
                    .await
                    .unwrap();
            }
            let path = if kind == "new" { "new.typ" } else { "main.typ" };
            let current = if kind == "new" {
                service
                    .local(Operation::Create {
                        project: project.id.clone(),
                        path: path.into(),
                    })
                    .unwrap();
                service.project(&project.id).unwrap()
            } else {
                save_fixture(&service, &project, "= Saved manuscript\n\nOwned bytes.\n")
            };
            let original_mode = if kind == "tracked_executable" {
                0o755
            } else {
                0o644
            };
            let changed_mode = if kind == "tracked_executable" {
                0o644
            } else {
                0o755
            };
            let file = project.root.join(path);
            let source = fs::read(&file).unwrap();
            let metadata = fs::read(sidecar(&file)).unwrap();
            let head = git_head(&project.root).await.unwrap();
            let index = fs::read(project.root.join(".git/index")).unwrap();
            fs::set_permissions(&file, fs::Permissions::from_mode(changed_mode)).unwrap();
            let error = sync_fixture(&service, &current).await.unwrap_err();
            assert_eq!(error.code, "conflict", "{kind}");
            assert!(error.message.contains("mode"), "{kind}: {}", error.message);
            assert_eq!(fs::read(&file).unwrap(), source);
            assert_eq!(fs::read(sidecar(&file)).unwrap(), metadata);
            assert_eq!(
                fs::metadata(&file).unwrap().permissions().mode() & 0o777,
                changed_mode
            );
            assert_eq!(git_head(&project.root).await.unwrap(), head);
            assert_eq!(
                git(&remote, &["rev-parse", "refs/heads/main"])
                    .await
                    .unwrap()
                    .trim(),
                head.as_deref().unwrap()
            );
            assert_eq!(fs::read(project.root.join(".git/index")).unwrap(), index);
            assert_eq!(
                service.project(&project.id).unwrap().pending_revisions,
                current.pending_revisions
            );
            assert!(!project.root.join(".git/index.lock").exists());
            fs::set_permissions(&file, fs::Permissions::from_mode(original_mode)).unwrap();
            sync_fixture(&service, &current).await.unwrap();
            let tree = git(&remote, &["ls-tree", "refs/heads/main", "--", path])
                .await
                .unwrap();
            assert!(tree.starts_with(if kind == "tracked_executable" {
                "100755 "
            } else {
                "100644 "
            }));
            assert!(service.project(&project.id).unwrap().pending.is_empty());
        }
    }

    #[tokio::test]
    async fn incoming_fast_forward_preserves_ignored_files_and_owned_pending_work() {
        for kind in ["owned", "external", "clean"] {
            let (temporary, service, project, remote) = git_fixture().await;
            fs::write(project.root.join(".gitignore"), "ignored.typ*\n").unwrap();
            git(&project.root, &["add", "--", ".gitignore"])
                .await
                .unwrap();
            git(&project.root, &["commit", "-m", "Ignore local source"])
                .await
                .unwrap();
            git(&project.root, &["push", "origin", "main"])
                .await
                .unwrap();
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
            fs::write(other.join("ignored.typ"), "Incoming source\n").unwrap();
            git(&other, &["add", "-f", "--", "ignored.typ"])
                .await
                .unwrap();
            git(&other, &["commit", "-m", "New remote source"])
                .await
                .unwrap();
            git(&other, &["push", "origin", "main"]).await.unwrap();
            let file = project.root.join("ignored.typ");
            if kind == "owned" {
                service
                    .local(Operation::Create {
                        project: project.id.clone(),
                        path: "ignored.typ".into(),
                    })
                    .unwrap();
            } else if kind == "external" {
                fs::write(&file, "External ignored source\n").unwrap();
            }
            let current = service.project(&project.id).unwrap();
            let head = git_head(&project.root).await.unwrap();
            let index = fs::read(project.root.join(".git/index")).unwrap();
            let source = fs::read(&file).ok();
            let metadata = fs::read(sidecar(&file)).ok();
            assert!(git(&project.root, &["status", "--porcelain=v1"])
                .await
                .unwrap()
                .is_empty());
            let result = sync_fixture(&service, &current).await;
            if kind == "clean" {
                result.unwrap();
                assert_eq!(fs::read_to_string(&file).unwrap(), "Incoming source\n");
                assert_eq!(
                    git_head(&project.root).await.unwrap().unwrap(),
                    git(&remote, &["rev-parse", "refs/heads/main"])
                        .await
                        .unwrap()
                        .trim()
                );
            } else {
                assert!(result.is_err(), "{kind}");
                assert_eq!(fs::read(&file).ok(), source, "{kind}");
                assert_eq!(fs::read(sidecar(&file)).ok(), metadata, "{kind}");
                assert_eq!(git_head(&project.root).await.unwrap(), head, "{kind}");
                assert_eq!(
                    fs::read(project.root.join(".git/index")).unwrap(),
                    index,
                    "{kind}"
                );
                assert_eq!(
                    service.project(&project.id).unwrap().pending_revisions,
                    current.pending_revisions
                );
            }
        }
    }

    #[tokio::test]
    async fn checkpoint_clears_only_the_actual_captured_publication_not_an_older_project_snapshot()
    {
        let (_temporary, service, stale, remote) = git_fixture().await;
        let saved = save_fixture(&service, &stale, "= Manuscript\n\nNewest captured input.\n");
        let result = sync_fixture(&service, &stale).await.unwrap();
        assert!(service.project(&stale.id).unwrap().pending.is_empty());
        assert_eq!(
            git(
                &remote,
                &[
                    "show",
                    &format!("{}:main.typ", result["head"].as_str().unwrap())
                ]
            )
            .await
            .unwrap(),
            "= Manuscript\n\nNewest captured input.\n"
        );
        assert!(!saved.pending_revisions.is_empty());
    }

    #[tokio::test]
    async fn sync_does_not_expand_validated_urls_again_into_an_unintended_destination() {
        let (_temporary, service, project, remote) = git_fixture().await;
        let project = save_fixture(
            &service,
            &project,
            "= Manuscript\n\nPrivate pending work.\n",
        );
        let canonical = "https://github.com/fixture/repository.git";
        let alias = "undertree-fixture:repository";
        git(&project.root, &["remote", "set-url", "origin", alias])
            .await
            .unwrap();
        git(
            &project.root,
            &["config", &format!("url.{canonical}.insteadOf"), alias],
        )
        .await
        .unwrap();
        git(
            &project.root,
            &[
                "config",
                &format!("url.{}.insteadOf", remote.to_str().unwrap()),
                canonical,
            ],
        )
        .await
        .unwrap();
        git(&project.root, &["config", "protocol.https.allow", "never"])
            .await
            .unwrap();
        service
            .bind_github(&project.id, "fixture/repository", false)
            .await
            .unwrap();
        let head = git_head(&project.root).await.unwrap();
        let remote_head = git(&remote, &["rev-parse", "refs/heads/main"])
            .await
            .unwrap();
        assert_eq!(
            git(&project.root, &["remote", "get-url", "origin"])
                .await
                .unwrap()
                .trim(),
            canonical
        );
        assert_eq!(service.sync(&project.id).await.unwrap_err().code, "git");
        assert_eq!(git_head(&project.root).await.unwrap(), head);
        assert_eq!(
            git(&remote, &["rev-parse", "refs/heads/main"])
                .await
                .unwrap(),
            remote_head
        );
        assert_eq!(
            service.project(&project.id).unwrap().pending_revisions,
            project.pending_revisions
        );
        assert_eq!(
            git(&project.root, &["config", "remote.origin.url"])
                .await
                .unwrap()
                .trim(),
            alias
        );
    }

    #[tokio::test]
    async fn configured_remote_push_expands_pushinsteadof_only_once() {
        let (_temporary, service, project, remote) = git_fixture().await;
        let project = save_fixture(&service, &project, "= Manuscript\n\nPending push.\n");
        let canonical = "https://github.com/fixture/repository.git";
        let alias = "undertree-fixture:repository";
        git(&project.root, &["remote", "set-url", "origin", alias])
            .await
            .unwrap();
        git(
            &project.root,
            &[
                "config",
                &format!("url.{}.insteadOf", remote.to_str().unwrap()),
                alias,
            ],
        )
        .await
        .unwrap();
        git(
            &project.root,
            &["config", &format!("url.{canonical}.pushInsteadOf"), alias],
        )
        .await
        .unwrap();
        git(
            &project.root,
            &[
                "config",
                &format!("url.{}.pushInsteadOf", remote.to_str().unwrap()),
                canonical,
            ],
        )
        .await
        .unwrap();
        git(&project.root, &["config", "protocol.https.allow", "never"])
            .await
            .unwrap();
        assert_eq!(
            git(&project.root, &["remote", "get-url", "--push", "origin"])
                .await
                .unwrap()
                .trim(),
            canonical
        );
        let remote_head = git(&remote, &["rev-parse", "refs/heads/main"])
            .await
            .unwrap();
        assert_eq!(
            service
                .sync_remote(&project, "origin", "origin")
                .await
                .unwrap_err()
                .code,
            "git"
        );
        assert_eq!(
            git(&remote, &["rev-parse", "refs/heads/main"])
                .await
                .unwrap(),
            remote_head
        );
        assert_eq!(
            service.project(&project.id).unwrap().pending_revisions,
            project.pending_revisions
        );
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
        let project: Project = serde_json::from_value(
            service
                .local(Operation::AddProject {
                    root: temporary.path().to_str().unwrap().into(),
                })
                .unwrap(),
        )
        .unwrap();
        let mut review = Review::new("Replacement");
        review.version = 99;
        let journal = Journal {
            old_revision: digest("Original manuscript"),
            content: "Replacement".into(),
            review,
            editor_receipt: None,
            prior_review: None,
            ownership: None,
        };
        fs::write(journal_path(&file), serde_json::to_vec(&journal).unwrap()).unwrap();
        assert!(service.read_document(&project, "main.typ", &file).is_err());
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
    #[test]
    fn local_reanchor_persists_without_source_changes_and_resumes_scoped_review() {
        for (filename, original, current, old_from, old_to, from, to, world_from, world_to) in [
            (
                "main.html",
                "<p>Hello world</p>",
                "<p>😀 Changed world</p>",
                3,
                8,
                6,
                13,
                14,
                19,
            ),
            (
                "main.typ",
                "Hello world.\n",
                "😀 Changed world.\n",
                0,
                5,
                3,
                10,
                11,
                16,
            ),
        ] {
            let temporary = tempfile::tempdir().unwrap();
            let root = temporary.path().join("project");
            fs::create_dir(&root).unwrap();
            let file = root.join(filename);
            fs::write(&file, original).unwrap();
            let service = Service::new(temporary.path().join("state")).unwrap();
            let project = service
                .local(Operation::AddProject {
                    root: root.to_string_lossy().into(),
                })
                .unwrap();
            let project = project["id"].as_str().unwrap().to_owned();
            let marked = service
                .local(Operation::Mark {
                    project: project.clone(),
                    path: filename.into(),
                    revision: digest(original),
                    from: old_from,
                    to: old_to,
                    rule: "protect".into(),
                    prompt: "Retain every scientific claim.".into(),
                })
                .unwrap();
            let id = marked["review"]["markers"][0]["id"]
                .as_str()
                .unwrap()
                .to_owned();
            let saved = service
                .local(Operation::Save {
                    project: project.clone(),
                    path: filename.into(),
                    revision: digest(original),
                    content: current.into(),
                })
                .unwrap();
            assert_eq!(saved["review"]["markers"][0]["anchor"]["stale"], true);
            let shared = service
                .local(Operation::Share {
                    project: project.clone(),
                    path: filename.into(),
                    enabled: true,
                })
                .unwrap();
            let document_id = shared["documentId"].as_str().unwrap();
            let request = json!({"documentId":document_id,"proposal":{"requestId":"after-reanchor","revision":digest(current),"from":world_from,"to":world_to,"quote":"world","replacement":"reader","rationale":"Clearer wording."}});
            assert_eq!(
                service
                    .remote("suggest_text", request.clone())
                    .unwrap_err()
                    .code,
                "protected"
            );
            let original_modified = fs::metadata(&file).unwrap().modified().unwrap();
            let before_sidecar = fs::read(sidecar(&file)).unwrap();
            assert_eq!(
                service
                    .local(Operation::Reanchor {
                        project: project.clone(),
                        path: filename.into(),
                        revision: digest(current),
                        id: id.clone(),
                        from,
                        to,
                        quote: "Wrong selection".into()
                    })
                    .unwrap_err()
                    .code,
                "stale"
            );
            assert_eq!(fs::read(sidecar(&file)).unwrap(), before_sidecar);
            let updated = service
                .local(Operation::Reanchor {
                    project: project.clone(),
                    path: filename.into(),
                    revision: digest(current),
                    id: id.clone(),
                    from,
                    to,
                    quote: "Changed".into(),
                })
                .unwrap();
            assert_eq!(updated["review"]["rules"], saved["review"]["rules"]);
            assert_eq!(updated["review"]["markers"].as_array().unwrap().len(), 1);
            let marker = &updated["review"]["markers"][0];
            assert_eq!(marker["id"], id);
            assert_eq!(marker["rule"], "protect");
            assert_eq!(marker["prompt"], "Retain every scientific claim.");
            assert_eq!(marker["anchor"]["stale"], false);
            assert_eq!(marker["anchor"]["quote"], "Changed");
            assert_eq!(updated["review"]["revision"], digest(current));
            assert_eq!(service.remote("reanchor",json!({"documentId":document_id,"id":id,"from":from,"to":to,"quote":"Changed"})).unwrap_err().code,"scope");
            assert!(service.remote("suggest_text", request).is_ok());
            assert_eq!(fs::read_to_string(&file).unwrap(), current);
            assert_eq!(
                fs::metadata(&file).unwrap().modified().unwrap(),
                original_modified
            );
            assert!(service
                .project(&project)
                .unwrap()
                .pending
                .contains(&format!("{filename}.undertree-review.json")));
            assert!(!journal_path(&file).exists());
            let reopened = service
                .local(Operation::Open {
                    project,
                    path: filename.into(),
                })
                .unwrap();
            assert_eq!(reopened["review"]["markers"][0], *marker);
        }
    }

    #[test]
    fn reanchor_json_requires_quote_and_cannot_replace_policy_fields() {
        let valid = json!({"action":"reanchor","project":"project","path":"main.typ","revision":digest("Text"),"id":"marker","from":0,"to":4,"quote":"Text"});
        assert!(matches!(
            serde_json::from_value::<Operation>(valid.clone()).unwrap(),
            Operation::Reanchor { .. }
        ));
        for field in ["rule", "prompt", "color"] {
            let mut request = valid.clone();
            request[field] = json!("changed");
            assert!(serde_json::from_value::<Operation>(request).is_err());
        }
        let mut missing_quote = valid.clone();
        missing_quote.as_object_mut().unwrap().remove("quote");
        assert!(serde_json::from_value::<Operation>(missing_quote).is_err());
        for invalid in [json!(-1), json!(0.5), json!("0")] {
            let mut request = valid.clone();
            request["from"] = invalid;
            assert!(serde_json::from_value::<Operation>(request).is_err());
        }
    }
    #[tokio::test]
    async fn metadata_writes_do_not_adopt_external_changes_to_pending_sources() {
        let (_temporary, service, project, _) = git_fixture().await;
        let owned = "= Manuscript\n\nUnderTree's saved text.\n";
        let project = save_fixture(&service, &project, owned);
        let prior_revision = project.pending_revisions["main.typ"].clone();
        let prior_head = git_head(&project.root).await.unwrap();
        let external = "= Manuscript\n\nExternal paragraph.\n";
        fs::write(project.root.join("main.typ"), external).unwrap();
        let from = external.find("External").unwrap();
        let marked = service
            .local(Operation::Mark {
                project: project.id.clone(),
                path: "main.typ".into(),
                revision: digest(external),
                from,
                to: from + 8,
                rule: "snappier".into(),
                prompt: "Retain meaning.".into(),
            })
            .unwrap();
        let marker = marked["review"]["markers"][0]["id"]
            .as_str()
            .unwrap()
            .to_owned();
        let assert_owner = || {
            let current = service.project(&project.id).unwrap();
            assert!(current.pending.contains("main.typ"));
            assert_eq!(current.pending_revisions["main.typ"], prior_revision);
            assert_ne!(current.pending_revisions["main.typ"], digest(external));
        };
        assert_owner();
        let shared = service
            .local(Operation::Share {
                project: project.id.clone(),
                path: "main.typ".into(),
                enabled: true,
            })
            .unwrap();
        let from = external.find("paragraph").unwrap();
        let suggestion = service.remote("suggest_text",json!({"documentId":shared["documentId"],"proposal":{"requestId":"external-review","revision":digest(external),"from":from,"to":from+9,"quote":"paragraph","replacement":"passage","rationale":"Clearer wording."}})).unwrap();
        assert_owner();
        let rules = serde_json::from_value(marked["review"]["rules"].clone()).unwrap();
        service
            .local(Operation::Palette {
                project: project.id.clone(),
                path: "main.typ".into(),
                revision: digest(external),
                rules,
            })
            .unwrap();
        assert_owner();
        service
            .local(Operation::Reanchor {
                project: project.id.clone(),
                path: "main.typ".into(),
                revision: digest(external),
                id: marker.clone(),
                from,
                to: from + 9,
                quote: "paragraph".into(),
            })
            .unwrap();
        assert_owner();
        service
            .local(Operation::Unmark {
                project: project.id.clone(),
                path: "main.typ".into(),
                revision: digest(external),
                id: marker,
            })
            .unwrap();
        assert_owner();
        service
            .local(Operation::Decide {
                project: project.id.clone(),
                path: "main.typ".into(),
                revision: digest(external),
                id: suggestion["suggestion"]["id"].as_str().unwrap().into(),
                decision: crate::document::Decision::Rejected,
            })
            .unwrap();
        assert_owner();
        service
            .local(Operation::Save {
                project: project.id.clone(),
                path: "main.typ".into(),
                revision: digest(external),
                content: external.into(),
            })
            .unwrap();
        assert_owner();
        let project = service.project(&project.id).unwrap();
        assert_eq!(
            sync_fixture(&service, &project).await.unwrap_err().code,
            "conflict"
        );
        assert_eq!(git_head(&project.root).await.unwrap(), prior_head);
        assert_eq!(
            fs::read_to_string(project.root.join("main.typ")).unwrap(),
            external
        );
        assert!(!project.root.join(".git/index.lock").exists());
    }

    #[tokio::test]
    async fn clean_source_highlights_checkpoint_only_the_sidecar_and_leave_external_sources_unowned(
    ) {
        let (_temporary, service, project, remote) = git_fixture().await;
        let text = fs::read_to_string(project.root.join("main.typ")).unwrap();
        let from = text.find("Hello").unwrap();
        service
            .local(Operation::Mark {
                project: project.id.clone(),
                path: "main.typ".into(),
                revision: digest(&text),
                from,
                to: from + 5,
                rule: "snappier".into(),
                prompt: "Keep the claim.".into(),
            })
            .unwrap();
        let project = service.project(&project.id).unwrap();
        assert!(!project.pending.contains("main.typ"));
        assert!(!project.pending_revisions.contains_key("main.typ"));
        let result = sync_fixture(&service, &project).await.unwrap();
        let head = result["head"].as_str().unwrap();
        let changed = git(
            &project.root,
            &["diff-tree", "--no-commit-id", "--name-only", "-r", head],
        )
        .await
        .unwrap();
        assert_eq!(changed.trim(), "main.typ.undertree-review.json");
        assert_eq!(
            git(&remote, &["show", &format!("{head}:main.typ")])
                .await
                .unwrap(),
            text
        );
        assert!(git(&project.root, &["status", "--porcelain=v1"])
            .await
            .unwrap()
            .is_empty());
        let external = "= Manuscript\n\nExternal editor's content.\n";
        fs::write(project.root.join("main.typ"), external).unwrap();
        let snapshot = service
            .local(Operation::Open {
                project: project.id.clone(),
                path: "main.typ".into(),
            })
            .unwrap();
        let rules = serde_json::from_value(snapshot["review"]["rules"].clone()).unwrap();
        service
            .local(Operation::Palette {
                project: project.id.clone(),
                path: "main.typ".into(),
                revision: digest(external),
                rules,
            })
            .unwrap();
        let project = service.project(&project.id).unwrap();
        assert!(!project.pending.contains("main.typ"));
        assert!(!project.pending_revisions.contains_key("main.typ"));
        assert_eq!(
            sync_fixture(&service, &project).await.unwrap_err().code,
            "conflict"
        );
        assert_eq!(
            git(&project.root, &["rev-parse", "HEAD"])
                .await
                .unwrap()
                .trim(),
            head
        );
        assert_eq!(
            fs::read_to_string(project.root.join("main.typ")).unwrap(),
            external
        );
    }

    #[tokio::test]
    async fn create_and_tex_import_explicitly_own_their_new_sources() {
        let (_temporary, service, project, remote) = git_fixture().await;
        let tex = "\\begin{document}\\section{Result}Some text.\\end{document}";
        fs::write(project.root.join("original.tex"), tex).unwrap();
        git(&project.root, &["add", "--", "original.tex"])
            .await
            .unwrap();
        git(&project.root, &["commit", "-m", "Original import fixture"])
            .await
            .unwrap();
        git(&project.root, &["push", "origin", "HEAD:refs/heads/main"])
            .await
            .unwrap();
        service
            .local(Operation::Create {
                project: project.id.clone(),
                path: "created.typ".into(),
            })
            .unwrap();
        service
            .local(Operation::ImportTex {
                project: project.id.clone(),
                path: "original.tex".into(),
                target: "converted.typ".into(),
            })
            .unwrap();
        let project = service.project(&project.id).unwrap();
        let expected: BTreeSet<String> = [
            "created.typ",
            "created.typ.undertree-review.json",
            "converted.typ",
            "converted.typ.undertree-review.json",
            "converted.typ.import-report.json",
        ]
        .into_iter()
        .map(String::from)
        .collect();
        assert_eq!(project.pending, expected);
        for relative in &expected {
            assert_eq!(
                project.pending_revisions[relative],
                digest(&fs::read_to_string(project.root.join(relative)).unwrap())
            );
        }
        assert!(!project.pending.contains("original.tex"));
        assert_eq!(
            fs::read_to_string(project.root.join("original.tex")).unwrap(),
            tex
        );
        let result = sync_fixture(&service, &project).await.unwrap();
        let head = result["head"].as_str().unwrap();
        let changed: BTreeSet<String> = git(
            &project.root,
            &["diff-tree", "--no-commit-id", "--name-only", "-r", head],
        )
        .await
        .unwrap()
        .lines()
        .map(String::from)
        .collect();
        assert_eq!(changed, expected);
        assert_eq!(
            git(&remote, &["show", &format!("{head}:original.tex")])
                .await
                .unwrap(),
            tex
        );
        assert!(git(&project.root, &["status", "--porcelain=v1"])
            .await
            .unwrap()
            .is_empty());
    }
}
