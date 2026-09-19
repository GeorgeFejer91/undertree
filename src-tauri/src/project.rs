use std::collections::{BTreeMap, HashSet};
use std::fmt::Write as _;
use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::{Component, Path, PathBuf};
use std::sync::{Arc, Mutex, RwLock};
use std::time::{SystemTime, UNIX_EPOCH};

use atomic_write_file::AtomicWriteFile;
use biblatex::{Bibliography, ChunksExt, Entry};
use fs2::FileExt;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::compiler::{CompileRequest, CompilerAssets};
use crate::error::BoundaryError;
use crate::latex::{self, ConversionReport, TypstToLatexReport};

const MAX_SOURCE_BYTES: u64 = 1024 * 1024;
const MAX_BIBLIOGRAPHY_FILES: usize = 64;
const MAX_BIBLIOGRAPHY_ENTRIES: usize = 12_000;
const MAX_BIBLIOGRAPHY_FIELD_CHARS: usize = 2_000;
const MAX_BIBLIOGRAPHY_INDEX_BYTES: usize = 16 * 1024 * 1024;
const MAX_BIBLIOGRAPHY_ISSUES: usize = 256;
const MAX_CITATION_KEY_CHARS: usize = 256;
const MAX_PROJECT_ENTRIES: usize = 50_000;
const MAX_SCAN_DEPTH: usize = 32;
const MAX_RECENT_PROJECTS: usize = 50;
const MAX_RECENT_PROJECTS_BYTES: u64 = 1024 * 1024;
const RECENT_PROJECTS_VERSION: u32 = 1;

#[derive(Clone, Default)]
pub struct ProjectState {
    root: Arc<RwLock<Option<PathBuf>>>,
    save_lock: Arc<Mutex<()>>,
    lease: Arc<Mutex<Option<ProjectLease>>>,
    initial_active_path: Arc<Mutex<Option<String>>>,
    recent_projects: Arc<RwLock<Vec<RecentProject>>>,
    recent_projects_path: Arc<RwLock<Option<PathBuf>>>,
}

#[derive(Debug)]
struct ProjectLease {
    _file: File,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RecentProject {
    pub name: String,
    pub root: String,
    pub parent: String,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct RecentProjectsFile {
    version: u32,
    projects: Vec<RecentProject>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectSnapshot {
    pub name: String,
    pub root: String,
    pub files: Vec<String>,
    pub all_files: Vec<ProjectFileEntry>,
    pub active: DocumentData,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub conversion: Option<ConversionReport>,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProjectFileEntry {
    pub path: String,
    pub category: String,
    pub editable: bool,
    pub default_visible: bool,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProjectInspection {
    pub name: String,
    pub root: String,
    pub files: Vec<ProjectFileEntry>,
    pub inventory: ProjectInventoryInspection,
    pub active: Option<DocumentInspection>,
    pub conversion: ProjectConversionInspection,
    pub lock_state: ProjectLockState,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProjectInventoryInspection {
    pub total: usize,
    pub editable: usize,
    pub default_visible: usize,
    pub categories: BTreeMap<String, usize>,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProjectConversionInspection {
    pub latex_sources: usize,
    pub latex_sources_with_typst_companion: usize,
    pub markdown_sources: usize,
    pub markdown_sources_with_typst_companion: usize,
    pub generated_latex_exports: usize,
}

/// An advisory instant-in-time lock probe. `Available` is not a lease, and
/// `Unavailable` means inspection would require creating or trusting state.
#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) enum ProjectLockState {
    Available,
    InUse,
    Unavailable,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DocumentInspection {
    pub path: String,
    pub digest: String,
    pub bytes: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentData {
    pub path: String,
    pub source: String,
    pub digest: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveRequest {
    pub path: String,
    pub source: String,
    pub expected_digest: String,
    pub revision: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveResponse {
    pub revision: u64,
    pub digest: String,
    pub conflict_path: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateFileResponse {
    pub files: Vec<String>,
    pub all_files: Vec<ProjectFileEntry>,
    pub document: DocumentData,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BibliographyEntrySummary {
    pub key: String,
    pub title: String,
    pub authors: String,
    pub year: String,
    pub venue: String,
    pub doi: String,
    pub source_path: String,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BibliographyIssue {
    pub source_path: String,
    pub message: String,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BibliographyIndex {
    pub entries: Vec<BibliographyEntrySummary>,
    pub issues: Vec<BibliographyIssue>,
}

impl ProjectState {
    pub fn configure_recent_projects(&self, path: PathBuf) -> Result<(), BoundaryError> {
        let projects = read_recent_projects(&path)?;
        *self
            .recent_projects_path
            .write()
            .map_err(|_| BoundaryError::internal())? = Some(path);
        *self
            .recent_projects
            .write()
            .map_err(|_| BoundaryError::internal())? = projects;

        if let Some(root) = self.root()? {
            self.remember_project(&root)?;
        }
        Ok(())
    }

    pub fn recent_projects(&self) -> Result<Vec<RecentProject>, BoundaryError> {
        self.recent_projects
            .read()
            .map(|projects| projects.clone())
            .map_err(|_| BoundaryError::internal())
    }

    pub fn select_recent(&self, requested_root: &str) -> Result<ProjectSnapshot, BoundaryError> {
        let selected = self
            .recent_projects
            .read()
            .map_err(|_| BoundaryError::internal())?
            .iter()
            .find(|project| project.root == requested_root)
            .map(|project| PathBuf::from(&project.root))
            .ok_or_else(|| {
                BoundaryError::project(
                    "project_not_remembered",
                    "Choose a project that UnderTree previously opened.",
                )
            })?;
        self.select(selected)
    }

    pub fn select(&self, selected: PathBuf) -> Result<ProjectSnapshot, BoundaryError> {
        self.select_with_conversion(selected, None, None)
    }

    pub(crate) fn select_with_preferred(
        &self,
        selected: PathBuf,
        preferred: Option<&str>,
    ) -> Result<ProjectSnapshot, BoundaryError> {
        let project = self.select_with_conversion(selected, preferred, None)?;
        *self
            .initial_active_path
            .lock()
            .map_err(|_| BoundaryError::internal())? =
            preferred.map(|_| project.active.path.clone());
        Ok(project)
    }

    pub(crate) fn select_imported(
        &self,
        selected: PathBuf,
        preferred: Option<&str>,
        conversion: ConversionReport,
    ) -> Result<ProjectSnapshot, BoundaryError> {
        self.select_with_conversion(selected, preferred, Some(conversion))
    }

    fn select_with_conversion(
        &self,
        selected: PathBuf,
        preferred: Option<&str>,
        supplied_conversion: Option<ConversionReport>,
    ) -> Result<ProjectSnapshot, BoundaryError> {
        let _mutation_guard = self.mutation_guard()?;
        let root = selected.canonicalize().map_err(|_| {
            BoundaryError::project("project_unavailable", "The selected folder is unavailable.")
        })?;
        if !root.is_dir() {
            return Err(BoundaryError::project(
                "project_unavailable",
                "The selected path is not a folder.",
            ));
        }
        let lease = self.new_lease_for_root(&root)?;

        let conversion = match supplied_conversion {
            Some(conversion) => Some(conversion),
            None => latex::convert_project_if_needed(&root)?,
        };
        let (files, all_files) = scan_project_inventory(&root)?;
        let preferred = preferred.or_else(|| {
            conversion
                .as_ref()
                .and_then(|report| report.primary_typst.as_deref())
        });
        let active_path = choose_active_path(&files, preferred)?;

        let active = read_document_at(&root, &active_path)?;
        let name = root
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("Typst project")
            .to_owned();

        self.remember_project(&root)?;
        self.install_selected_root(root.clone(), lease)?;

        Ok(ProjectSnapshot {
            name,
            root: root.to_string_lossy().into_owned(),
            files,
            all_files,
            active,
            conversion,
        })
    }

    pub fn refresh(&self, preferred: Option<&str>) -> Result<ProjectSnapshot, BoundaryError> {
        let _mutation_guard = self.mutation_guard()?;
        let root = self.selected_root()?;
        let canonical_root = root.canonicalize().map_err(|_| {
            BoundaryError::project("project_unavailable", "The selected folder is unavailable.")
        })?;
        if canonical_root != root || !canonical_root.is_dir() {
            return Err(BoundaryError::project(
                "project_unavailable",
                "The selected project folder is no longer available at its approved location.",
            ));
        }

        let conversion = latex::convert_project_if_needed(&root)?;
        let (files, all_files) = scan_project_inventory(&root)?;
        let preferred = preferred.or_else(|| {
            conversion
                .as_ref()
                .and_then(|report| report.primary_typst.as_deref())
        });
        let active_path = choose_active_path(&files, preferred)?;
        let active = read_document_at(&root, &active_path)?;
        let name = root
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("Typst project")
            .to_owned();

        Ok(ProjectSnapshot {
            name,
            root: root.to_string_lossy().into_owned(),
            files,
            all_files,
            active,
            conversion,
        })
    }

    pub fn root(&self) -> Result<Option<PathBuf>, BoundaryError> {
        self.root
            .read()
            .map(|root| root.clone())
            .map_err(|_| BoundaryError::internal())
    }

    pub(crate) fn take_initial_active_path(&self) -> Result<Option<String>, BoundaryError> {
        self.initial_active_path
            .lock()
            .map(|mut path| path.take())
            .map_err(|_| BoundaryError::internal())
    }

    /// Inspects an explicit project path without selecting it, acquiring its
    /// lease, creating `.undertree`, or running automatic conversion.
    pub(crate) fn inspect(selected: &Path) -> Result<ProjectInspection, BoundaryError> {
        let root = canonical_project_directory(selected)?;
        let (editable_files, files) = scan_project_inventory(&root)?;
        let active = choose_active_path(&editable_files, None)
            .ok()
            .map(|path| inspect_document_at(&root, &path))
            .transpose()?;
        let inventory = inspect_inventory(&files);
        let conversion = inspect_conversion(&files);
        let lock_state = inspect_project_lock(&root);
        let name = root
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("Typst project")
            .to_owned();

        Ok(ProjectInspection {
            name,
            root: root.to_string_lossy().into_owned(),
            files,
            inventory,
            active,
            conversion,
            lock_state,
        })
    }

    /// Reads only the metadata needed to identify an editable document at an
    /// explicit project path. The project remains unselected and unleased.
    pub(crate) fn inspect_document(
        selected: &Path,
        relative: &str,
    ) -> Result<DocumentInspection, BoundaryError> {
        let root = canonical_project_directory(selected)?;
        inspect_document_at(&root, relative)
    }

    /// Reads a confined editable document without selecting or leasing the
    /// project. This is the on-disk view; a running editor may have a newer
    /// unsaved overlay available through the authenticated app CLI group.
    pub(crate) fn read_document(
        selected: &Path,
        relative: &str,
    ) -> Result<DocumentData, BoundaryError> {
        let _inspection = Self::inspect_document(selected, relative)?;
        let root = canonical_project_directory(selected)?;
        read_document_at(&root, relative)
    }

    pub(crate) fn select_for_cli(&self, selected: PathBuf) -> Result<PathBuf, BoundaryError> {
        let _mutation_guard = self.mutation_guard()?;
        let root = canonical_project_directory(&selected)?;
        let lease = self.new_lease_for_root(&root)?;
        self.install_selected_root(root.clone(), lease)?;
        Ok(root)
    }

    pub fn open(&self, relative: &str) -> Result<DocumentData, BoundaryError> {
        let root = self.selected_root()?;
        read_document_at(&root, relative)
    }

    pub fn bibliography_entries(&self) -> Result<BibliographyIndex, BoundaryError> {
        let root = self.selected_root()?;
        bibliography_index_at(&root)
    }

    pub fn create_bibliography(&self, relative: &str) -> Result<CreateFileResponse, BoundaryError> {
        let _save_guard = self.mutation_guard()?;
        let root = self.selected_root()?;
        let relative = validate_relative_bibliography_path(relative)?;
        let parent = relative.parent().unwrap_or_else(|| Path::new(""));
        let canonical_parent = root.join(parent).canonicalize().map_err(|_| {
            BoundaryError::project(
                "folder_unavailable",
                "The destination folder is unavailable.",
            )
        })?;
        if !canonical_parent.starts_with(&root) || !canonical_parent.is_dir() {
            return Err(BoundaryError::project(
                "path_denied",
                "The bibliography must remain inside the selected project.",
            ));
        }

        let file_name = relative.file_name().ok_or_else(|| {
            BoundaryError::project("path_denied", "A bibliography file name is required.")
        })?;
        let path = canonical_parent.join(file_name);
        let file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)
            .map_err(|error| {
                if error.kind() == std::io::ErrorKind::AlreadyExists {
                    BoundaryError::project(
                        "document_exists",
                        "A file with that name already exists.",
                    )
                } else {
                    BoundaryError::project(
                        "create_failed",
                        "The bibliography file could not be created.",
                    )
                }
            })?;
        file.sync_all().map_err(|_| {
            BoundaryError::project(
                "create_failed",
                "The bibliography file could not be created safely.",
            )
        })?;

        let relative = relative.to_str().ok_or_else(|| {
            BoundaryError::project(
                "unsupported_path",
                "The bibliography path must use Unicode characters.",
            )
        })?;
        let (files, all_files) = scan_project_inventory(&root)?;
        Ok(CreateFileResponse {
            files,
            all_files,
            document: read_document_at(&root, relative)?,
        })
    }

    pub fn export_typst_to_latex(
        &self,
        relative: &str,
        compiler: &CompilerAssets,
    ) -> Result<(ProjectSnapshot, TypstToLatexReport), BoundaryError> {
        let _save_guard = self.mutation_guard()?;
        let root = self.selected_root()?;
        if !Path::new(relative)
            .extension()
            .is_some_and(|extension| extension.eq_ignore_ascii_case("typ"))
        {
            return Err(BoundaryError::project(
                "typst_document_required",
                "Open a .typ document before exporting it to LaTeX.",
            ));
        }

        let document = read_document_at(&root, relative)?;
        compiler.compile(
            CompileRequest {
                source: document.source.clone(),
                path: Some(document.path.clone()),
                revision: 0,
            },
            Some(root.clone()),
        )?;

        let report = latex::export_typst_document(&root, &document.path, &document.source)?;
        let (files, all_files) = scan_project_inventory(&root)?;
        let active = read_document_at(&root, &report.latex)?;
        let name = root
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("Typst project")
            .to_owned();
        Ok((
            ProjectSnapshot {
                name,
                root: root.to_string_lossy().into_owned(),
                files,
                all_files,
                active,
                conversion: None,
            },
            report,
        ))
    }

    pub fn save(&self, request: SaveRequest) -> Result<SaveResponse, BoundaryError> {
        if request.source.len() as u64 > MAX_SOURCE_BYTES {
            return Err(BoundaryError::project(
                "document_too_large",
                "Editable documents are limited to 1 MiB.",
            ));
        }

        let _save_guard = self.mutation_guard()?;

        let root = self.selected_root()?;
        let path = resolve_existing_document(&root, &request.path)?;
        let metadata = path.metadata().map_err(|_| {
            BoundaryError::project(
                "document_unavailable",
                "The document could not be inspected.",
            )
        })?;
        if metadata.len() > MAX_SOURCE_BYTES {
            return Err(BoundaryError::project(
                "document_too_large",
                "The on-disk document is larger than 1 MiB.",
            ));
        }
        let disk = fs::read(&path).map_err(|_| {
            BoundaryError::project("document_unavailable", "The document could not be read.")
        })?;
        let disk_digest = digest(&disk);
        let conflict_path = if disk_digest != request.expected_digest {
            Some(preserve_conflict(&root, &path, &disk)?)
        } else {
            None
        };

        atomic_write(&path, request.source.as_bytes()).map_err(|_| {
            BoundaryError::project("save_failed", "The document could not be saved atomically.")
        })?;

        Ok(SaveResponse {
            revision: request.revision,
            digest: digest(request.source.as_bytes()),
            conflict_path,
        })
    }

    pub(crate) fn mutation_guard(&self) -> Result<std::sync::MutexGuard<'_, ()>, BoundaryError> {
        self.save_lock.lock().map_err(|_| BoundaryError::internal())
    }

    pub(crate) fn ensure_selected_root(&self, expected: &Path) -> Result<(), BoundaryError> {
        if self.selected_root()? == expected {
            Ok(())
        } else {
            Err(BoundaryError::project(
                "project_changed",
                "The selected project changed before the operation started. Try again.",
            ))
        }
    }

    fn selected_root(&self) -> Result<PathBuf, BoundaryError> {
        self.root()?.ok_or_else(|| {
            BoundaryError::project("project_required", "Choose a Typst project first.")
        })
    }

    fn install_selected_root(
        &self,
        root: PathBuf,
        lease: Option<ProjectLease>,
    ) -> Result<(), BoundaryError> {
        let mut root_slot = self.root.write().map_err(|_| BoundaryError::internal())?;
        let mut lease_slot = self.lease.lock().map_err(|_| BoundaryError::internal())?;
        *root_slot = Some(root);
        if let Some(lease) = lease {
            *lease_slot = Some(lease);
        }
        Ok(())
    }

    fn new_lease_for_root(&self, root: &Path) -> Result<Option<ProjectLease>, BoundaryError> {
        let already_selected = self
            .root
            .read()
            .map_err(|_| BoundaryError::internal())?
            .as_deref()
            == Some(root);
        let lease_present = self
            .lease
            .lock()
            .map_err(|_| BoundaryError::internal())?
            .is_some();
        if already_selected && lease_present {
            Ok(None)
        } else {
            acquire_project_lease(root).map(Some)
        }
    }

    fn remember_project(&self, root: &Path) -> Result<(), BoundaryError> {
        let Some(path) = self
            .recent_projects_path
            .read()
            .map_err(|_| BoundaryError::internal())?
            .clone()
        else {
            return Ok(());
        };

        let project = recent_project(root);
        let mut projects = self.recent_projects()?;
        projects.retain(|candidate| candidate.root != project.root);
        projects.insert(0, project);
        projects.truncate(MAX_RECENT_PROJECTS);
        write_recent_projects(&path, &projects)?;
        *self
            .recent_projects
            .write()
            .map_err(|_| BoundaryError::internal())? = projects;
        Ok(())
    }
}

fn recent_project(root: &Path) -> RecentProject {
    RecentProject {
        name: root
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("Typst project")
            .to_owned(),
        root: root.to_string_lossy().into_owned(),
        parent: root
            .parent()
            .map(|parent| parent.to_string_lossy().into_owned())
            .unwrap_or_default(),
    }
}

fn read_recent_projects(path: &Path) -> Result<Vec<RecentProject>, BoundaryError> {
    let metadata = match path.metadata() {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(_) => return Err(recent_projects_error()),
    };
    if !metadata.is_file() || metadata.len() > MAX_RECENT_PROJECTS_BYTES {
        return Err(recent_projects_error());
    }
    let bytes = fs::read(path).map_err(|_| recent_projects_error())?;
    let stored: RecentProjectsFile =
        serde_json::from_slice(&bytes).map_err(|_| recent_projects_error())?;
    if stored.version != RECENT_PROJECTS_VERSION {
        return Ok(Vec::new());
    }

    let mut projects = Vec::new();
    for project in stored.projects {
        if project.root.is_empty()
            || projects
                .iter()
                .any(|candidate: &RecentProject| candidate.root == project.root)
        {
            continue;
        }
        projects.push(project);
        if projects.len() == MAX_RECENT_PROJECTS {
            break;
        }
    }
    Ok(projects)
}

fn write_recent_projects(path: &Path, projects: &[RecentProject]) -> Result<(), BoundaryError> {
    let parent = path.parent().ok_or_else(recent_projects_error)?;
    fs::create_dir_all(parent).map_err(|_| recent_projects_error())?;
    let bytes = serde_json::to_vec_pretty(&RecentProjectsFile {
        version: RECENT_PROJECTS_VERSION,
        projects: projects.to_vec(),
    })
    .map_err(|_| recent_projects_error())?;
    atomic_write(path, &bytes).map_err(|_| recent_projects_error())
}

fn recent_projects_error() -> BoundaryError {
    BoundaryError::project(
        "recent_projects_unavailable",
        "UnderTree could not update its remembered project list.",
    )
}

fn canonical_project_directory(selected: &Path) -> Result<PathBuf, BoundaryError> {
    let root = selected.canonicalize().map_err(|_| {
        BoundaryError::project("project_unavailable", "The selected folder is unavailable.")
    })?;
    if !root.is_dir() {
        return Err(BoundaryError::project(
            "project_unavailable",
            "The selected path is not a folder.",
        ));
    }
    Ok(root)
}

fn inspect_project_lock(root: &Path) -> ProjectLockState {
    let state_directory = root.join(".undertree");
    let Ok(state_metadata) = fs::symlink_metadata(&state_directory) else {
        return ProjectLockState::Unavailable;
    };
    if state_metadata.file_type().is_symlink() || !state_metadata.is_dir() {
        return ProjectLockState::Unavailable;
    }
    if state_directory.canonicalize().ok().as_deref() != Some(state_directory.as_path()) {
        return ProjectLockState::Unavailable;
    }

    let lock_path = state_directory.join("project.lock");
    let Ok(lock_metadata) = fs::symlink_metadata(&lock_path) else {
        return ProjectLockState::Unavailable;
    };
    if lock_metadata.file_type().is_symlink() || !lock_metadata.is_file() {
        return ProjectLockState::Unavailable;
    }
    let Ok(file) = OpenOptions::new().read(true).write(true).open(lock_path) else {
        return ProjectLockState::Unavailable;
    };

    match file.try_lock_exclusive() {
        Ok(()) => {
            if FileExt::unlock(&file).is_ok() {
                ProjectLockState::Available
            } else {
                ProjectLockState::Unavailable
            }
        }
        Err(error) if error.kind() == fs2::lock_contended_error().kind() => ProjectLockState::InUse,
        Err(_) => ProjectLockState::Unavailable,
    }
}

fn acquire_project_lease(root: &Path) -> Result<ProjectLease, BoundaryError> {
    let state_directory = root.join(".undertree");
    match fs::symlink_metadata(&state_directory) {
        Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_dir() => {
            return Err(BoundaryError::project(
                "project_state_invalid",
                "The project's private UnderTree state folder is unsafe.",
            ));
        }
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            fs::create_dir(&state_directory).map_err(|_| {
                BoundaryError::project(
                    "project_state_unavailable",
                    "UnderTree could not create its private project state folder.",
                )
            })?;
        }
        Err(_) => {
            return Err(BoundaryError::project(
                "project_state_unavailable",
                "UnderTree could not inspect its private project state folder.",
            ));
        }
    }
    let canonical_state = state_directory.canonicalize().map_err(|_| {
        BoundaryError::project(
            "project_state_unavailable",
            "UnderTree could not inspect its private project state folder.",
        )
    })?;
    if canonical_state != root.join(".undertree") {
        return Err(BoundaryError::project(
            "project_state_invalid",
            "The project's private UnderTree state folder is unsafe.",
        ));
    }

    let lock_path = canonical_state.join("project.lock");
    if let Ok(metadata) = fs::symlink_metadata(&lock_path)
        && (metadata.file_type().is_symlink() || !metadata.is_file())
    {
        return Err(BoundaryError::project(
            "project_state_invalid",
            "The project's UnderTree lock file is unsafe.",
        ));
    }
    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(lock_path)
        .map_err(|_| {
            BoundaryError::project(
                "project_state_unavailable",
                "UnderTree could not open the project operation lock.",
            )
        })?;
    FileExt::try_lock_exclusive(&file).map_err(|_| {
        BoundaryError::project(
            "project_in_use",
            "This project is already open in another UnderTree window or CLI command.",
        )
    })?;
    Ok(ProjectLease { _file: file })
}

fn choose_active_path(files: &[String], preferred: Option<&str>) -> Result<String, BoundaryError> {
    preferred
        .and_then(|preferred| files.iter().find(|path| path.as_str() == preferred))
        .or_else(|| {
            files
                .iter()
                .find(|path| path.eq_ignore_ascii_case("paper.typ"))
        })
        .or_else(|| {
            files
                .iter()
                .find(|path| path.eq_ignore_ascii_case("main.typ"))
        })
        .or_else(|| {
            files
                .iter()
                .find(|path| path.to_lowercase().ends_with(".typ"))
        })
        .cloned()
        .ok_or_else(|| {
            BoundaryError::project(
                "project_empty",
                "The selected folder does not contain a .typ document.",
            )
        })
}

fn scan_project_inventory(
    root: &Path,
) -> Result<(Vec<String>, Vec<ProjectFileEntry>), BoundaryError> {
    let mut all_files = Vec::new();
    let mut pending = vec![(root.to_path_buf(), 0usize)];
    let mut visited = 0usize;

    while let Some((directory, depth)) = pending.pop() {
        if depth > MAX_SCAN_DEPTH {
            continue;
        }

        let entries = fs::read_dir(&directory).map_err(|_| {
            BoundaryError::project(
                "project_unavailable",
                "The project folder could not be scanned.",
            )
        })?;

        for entry in entries {
            visited += 1;
            if visited > MAX_PROJECT_ENTRIES {
                return Err(BoundaryError::project(
                    "project_too_large",
                    "The project inventory is limited to 50,000 entries.",
                ));
            }

            let entry = entry.map_err(|_| {
                BoundaryError::project("project_unavailable", "A project entry could not be read.")
            })?;
            let path = entry.path();
            let file_type = entry.file_type().map_err(|_| {
                BoundaryError::project(
                    "project_unavailable",
                    "A project entry could not be inspected.",
                )
            })?;

            if file_type.is_symlink() {
                continue;
            }
            if file_type.is_dir() {
                let name = entry.file_name();
                if matches!(
                    name.to_str(),
                    Some(".git" | ".undertree" | "node_modules" | "target")
                ) {
                    continue;
                }
                pending.push((path, depth + 1));
            } else if file_type.is_file() {
                let relative = path
                    .strip_prefix(root)
                    .map_err(|_| BoundaryError::internal())?;
                let Some(relative) = relative.to_str() else {
                    if is_editable_extension(&path) {
                        return Err(BoundaryError::project(
                            "unsupported_path",
                            "The project contains a non-Unicode editable path.",
                        ));
                    }
                    continue;
                };
                all_files.push(project_file_entry(relative.replace('\\', "/"), &path));
            }
        }
    }

    all_files.sort_by_key(|entry| entry.path.to_lowercase());
    let files = all_files
        .iter()
        .filter(|entry| entry.editable)
        .map(|entry| entry.path.clone())
        .collect();
    Ok((files, all_files))
}

fn bibliography_index_at(root: &Path) -> Result<BibliographyIndex, BoundaryError> {
    let (_, inventory) = scan_project_inventory(root)?;
    let bibliography_files = inventory
        .into_iter()
        .filter(|file| file.category == "bibliography")
        .collect::<Vec<_>>();
    if bibliography_files.len() > MAX_BIBLIOGRAPHY_FILES {
        return Err(BoundaryError::project(
            "bibliography_too_large",
            "Citation recommendations support up to 64 bibliography files per project.",
        ));
    }

    let mut entries = Vec::new();
    let mut issues = Vec::new();
    let mut seen_keys = HashSet::new();
    let mut index_bytes = 0usize;

    for file in bibliography_files {
        let document = read_document_at(root, &file.path)?;
        let bibliography = match Bibliography::parse(&document.source) {
            Ok(bibliography) => bibliography,
            Err(_) => {
                push_bibliography_issue(&mut issues, BibliographyIssue {
                    source_path: file.path,
                    message: "This bibliography could not be parsed, so its citations are not in recommendations."
                        .to_owned(),
                });
                continue;
            }
        };

        for entry in bibliography.iter() {
            if entries.len() >= MAX_BIBLIOGRAPHY_ENTRIES {
                return Err(BoundaryError::project(
                    "bibliography_too_large",
                    "Citation recommendations support up to 12,000 bibliography entries per project.",
                ));
            }
            if entry.key.is_empty()
                || entry.key.chars().count() > MAX_CITATION_KEY_CHARS
                || entry.key.chars().any(char::is_control)
            {
                push_bibliography_issue(&mut issues, BibliographyIssue {
                    source_path: file.path.clone(),
                    message: "A citation with an empty, oversized, or control-character key was excluded from recommendations."
                        .to_owned(),
                });
                continue;
            }
            if !seen_keys.insert(entry.key.clone()) {
                push_bibliography_issue(
                    &mut issues,
                    BibliographyIssue {
                        source_path: file.path.clone(),
                        message: format!(
                            "Duplicate citation key '{}' was ignored; the first project entry remains active.",
                            truncate_bibliography_text(&entry.key)
                        ),
                    },
                );
                continue;
            }
            let summary = summarize_bibliography_entry(entry, &file.path);
            index_bytes = index_bytes.saturating_add(bibliography_summary_bytes(&summary));
            if index_bytes > MAX_BIBLIOGRAPHY_INDEX_BYTES {
                return Err(BoundaryError::project(
                    "bibliography_too_large",
                    "Citation recommendation metadata is limited to 16 MiB per project.",
                ));
            }
            entries.push(summary);
        }
    }

    entries.sort_by_cached_key(|entry| (entry.key.to_lowercase(), entry.key.clone()));
    Ok(BibliographyIndex { entries, issues })
}

fn push_bibliography_issue(issues: &mut Vec<BibliographyIssue>, issue: BibliographyIssue) {
    if issues.len() < MAX_BIBLIOGRAPHY_ISSUES {
        issues.push(issue);
    }
}

fn bibliography_summary_bytes(summary: &BibliographyEntrySummary) -> usize {
    summary
        .key
        .len()
        .saturating_add(summary.title.len())
        .saturating_add(summary.authors.len())
        .saturating_add(summary.year.len())
        .saturating_add(summary.venue.len())
        .saturating_add(summary.doi.len())
        .saturating_add(summary.source_path.len())
}

fn summarize_bibliography_entry(entry: &Entry, source_path: &str) -> BibliographyEntrySummary {
    let authors = entry
        .author()
        .map(|authors| {
            authors
                .iter()
                .map(ToString::to_string)
                .collect::<Vec<_>>()
                .join("; ")
        })
        .unwrap_or_else(|_| bibliography_field(entry, &["author"]));
    let raw_date = bibliography_field(entry, &["year", "date"]);
    let year = raw_date
        .split(|character: char| !character.is_ascii_digit())
        .find(|part| part.len() == 4)
        .unwrap_or(&raw_date)
        .to_owned();

    BibliographyEntrySummary {
        key: entry.key.clone(),
        title: bibliography_field(entry, &["title", "maintitle", "booktitle"]),
        authors: truncate_bibliography_text(&authors),
        year: truncate_bibliography_text(&year),
        venue: bibliography_field(
            entry,
            &[
                "journaltitle",
                "journal",
                "booktitle",
                "publisher",
                "organization",
                "institution",
            ],
        ),
        doi: bibliography_field(entry, &["doi"]),
        source_path: source_path.to_owned(),
    }
}

fn bibliography_field(entry: &Entry, candidates: &[&str]) -> String {
    candidates
        .iter()
        .find_map(|candidate| entry.get(candidate))
        .map(ChunksExt::format_verbatim)
        .map(|value| truncate_bibliography_text(&value))
        .unwrap_or_default()
}

fn truncate_bibliography_text(value: &str) -> String {
    let collapsed = value.split_whitespace().collect::<Vec<_>>().join(" ");
    let mut characters = collapsed.chars();
    let mut truncated = characters
        .by_ref()
        .take(MAX_BIBLIOGRAPHY_FIELD_CHARS)
        .collect::<String>();
    if characters.next().is_some() {
        truncated.push('…');
    }
    truncated
}

fn inspect_inventory(files: &[ProjectFileEntry]) -> ProjectInventoryInspection {
    let mut categories = BTreeMap::new();
    let mut editable = 0usize;
    let mut default_visible = 0usize;
    for file in files {
        *categories.entry(file.category.clone()).or_insert(0) += 1;
        if file.editable {
            editable += 1;
        }
        if file.default_visible {
            default_visible += 1;
        }
    }
    ProjectInventoryInspection {
        total: files.len(),
        editable,
        default_visible,
        categories,
    }
}

fn inspect_conversion(files: &[ProjectFileEntry]) -> ProjectConversionInspection {
    let normalized_paths = files
        .iter()
        .map(|file| file.path.to_lowercase())
        .collect::<HashSet<_>>();
    let mut inspection = ProjectConversionInspection {
        latex_sources: 0,
        latex_sources_with_typst_companion: 0,
        markdown_sources: 0,
        markdown_sources_with_typst_companion: 0,
        generated_latex_exports: 0,
    };

    for file in files {
        if file.category == "latex" {
            inspection.latex_sources += 1;
            if typst_companion(&file.path)
                .is_some_and(|companion| normalized_paths.contains(&companion))
            {
                inspection.latex_sources_with_typst_companion += 1;
            }
        } else if file.category == "generated-latex" {
            inspection.generated_latex_exports += 1;
        } else if Path::new(&file.path)
            .extension()
            .is_some_and(|extension| extension.eq_ignore_ascii_case("md"))
        {
            inspection.markdown_sources += 1;
            if typst_companion(&file.path)
                .is_some_and(|companion| normalized_paths.contains(&companion))
            {
                inspection.markdown_sources_with_typst_companion += 1;
            }
        }
    }
    inspection
}

fn typst_companion(relative: &str) -> Option<String> {
    Path::new(relative)
        .with_extension("typ")
        .to_str()
        .map(|path| path.replace('\\', "/").to_lowercase())
}

fn project_file_entry(path: String, absolute: &Path) -> ProjectFileEntry {
    let (category, editable, default_visible) = if absolute
        .extension()
        .is_some_and(|extension| extension.eq_ignore_ascii_case("typ"))
    {
        ("typst", true, true)
    } else if absolute
        .extension()
        .is_some_and(|extension| extension.eq_ignore_ascii_case("bib"))
    {
        ("bibliography", true, true)
    } else if absolute.file_name().is_some_and(|name| name.eq_ignore_ascii_case("paper.json")) {
        ("review", false, true)
    } else if latex::is_undertree_latex_export(absolute) {
        ("generated-latex", true, true)
    } else if absolute
        .extension()
        .is_some_and(|extension| extension.eq_ignore_ascii_case("tex"))
    {
        ("latex", false, false)
    } else if absolute
        .extension()
        .is_some_and(|extension| extension.eq_ignore_ascii_case("pdf"))
    {
        ("pdf", false, false)
    } else if is_image_extension(absolute) {
        ("image", false, false)
    } else {
        ("other", false, false)
    };

    ProjectFileEntry {
        path,
        category: category.to_owned(),
        editable,
        default_visible,
    }
}

fn is_image_extension(path: &Path) -> bool {
    path.extension().is_some_and(|extension| {
        [
            "png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "tif", "tiff", "avif", "heic",
        ]
        .iter()
        .any(|candidate| extension.eq_ignore_ascii_case(candidate))
    })
}

fn inspect_document_at(root: &Path, relative: &str) -> Result<DocumentInspection, BoundaryError> {
    let document = read_document_at(root, relative)?;
    let bytes = document
        .source
        .len()
        .try_into()
        .map_err(|_| BoundaryError::internal())?;
    Ok(DocumentInspection {
        path: document.path,
        digest: document.digest,
        bytes,
    })
}

fn read_document_at(root: &Path, relative: &str) -> Result<DocumentData, BoundaryError> {
    let path = resolve_existing_document(root, relative)?;
    let metadata = path.metadata().map_err(|_| {
        BoundaryError::project(
            "document_unavailable",
            "The document could not be inspected.",
        )
    })?;
    if metadata.len() > MAX_SOURCE_BYTES {
        return Err(BoundaryError::project(
            "document_too_large",
            "Editable documents are limited to 1 MiB.",
        ));
    }

    let bytes = fs::read(&path).map_err(|_| {
        BoundaryError::project("document_unavailable", "The document could not be read.")
    })?;
    let source = String::from_utf8(bytes.clone())
        .map_err(|_| BoundaryError::project("document_encoding", "Documents must use UTF-8."))?;

    Ok(DocumentData {
        path: relative.replace('\\', "/"),
        source,
        digest: digest(&bytes),
    })
}

fn resolve_existing_document(root: &Path, relative: &str) -> Result<PathBuf, BoundaryError> {
    let relative = validate_relative_document_path(relative)?;
    let path = root.join(relative).canonicalize().map_err(|_| {
        BoundaryError::project(
            "document_unavailable",
            "The selected document is unavailable.",
        )
    })?;
    if !path.starts_with(root) || !path.is_file() {
        return Err(BoundaryError::project(
            "path_denied",
            "The document must remain inside the selected project.",
        ));
    }
    Ok(path)
}

fn validate_relative_document_path(relative: &str) -> Result<&Path, BoundaryError> {
    let path = Path::new(relative);
    if path.is_absolute()
        || path
            .components()
            .any(|component| !matches!(component, Component::Normal(_)))
        || !is_editable_extension(path)
    {
        return Err(BoundaryError::project(
            "path_denied",
            "Only relative .typ, .bib, and UnderTree-generated LaTeX export paths inside the selected project are allowed.",
        ));
    }
    Ok(path)
}

fn validate_relative_bibliography_path(relative: &str) -> Result<&Path, BoundaryError> {
    let path = validate_relative_document_path(relative)?;
    if !path
        .extension()
        .is_some_and(|extension| extension.eq_ignore_ascii_case("bib"))
    {
        return Err(BoundaryError::project(
            "path_denied",
            "New bibliography files must use the .bib extension.",
        ));
    }
    Ok(path)
}

fn is_editable_extension(path: &Path) -> bool {
    path.extension().is_some_and(|extension| {
        extension.eq_ignore_ascii_case("typ")
            || extension.eq_ignore_ascii_case("bib")
            || latex::is_undertree_latex_export(path)
    })
}

fn preserve_conflict(root: &Path, document: &Path, bytes: &[u8]) -> Result<String, BoundaryError> {
    let directory = root.join(".undertree").join("conflicts");
    fs::create_dir_all(&directory).map_err(|_| {
        BoundaryError::project(
            "conflict_preservation_failed",
            "The external version could not be preserved.",
        )
    })?;

    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| BoundaryError::internal())?
        .as_millis();
    let file_name = document
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("document.typ");
    let conflict = directory.join(format!("{timestamp}-{file_name}"));
    atomic_write(&conflict, bytes).map_err(|_| {
        BoundaryError::project(
            "conflict_preservation_failed",
            "The external version could not be preserved.",
        )
    })?;

    conflict
        .strip_prefix(root)
        .ok()
        .and_then(|path| path.to_str())
        .map(|path| path.replace('\\', "/"))
        .ok_or_else(BoundaryError::internal)
}

fn atomic_write(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let mut file = AtomicWriteFile::open(path)?;
    file.write_all(bytes)?;
    file.sync_all()?;
    file.commit()
}

fn digest(bytes: &[u8]) -> String {
    let hash = Sha256::digest(bytes);
    let mut output = String::with_capacity(hash.len() * 2);
    for byte in hash {
        write!(&mut output, "{byte:02x}").expect("writing to a string is infallible");
    }
    output
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temporary_project(label: &str) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system clock should follow Unix epoch")
            .as_nanos();
        std::env::temp_dir().join(format!("undertree-{label}-{}-{nonce}", std::process::id()))
    }

    #[test]
    fn accepts_only_relative_editable_paths() {
        assert!(validate_relative_document_path("chapters/intro.typ").is_ok());
        assert!(validate_relative_document_path("references.bib").is_ok());
        assert!(validate_relative_document_path("paper.json").is_err());
        assert!(validate_relative_document_path("main.undertree-export.tex").is_ok());
        assert!(validate_relative_document_path("main.undertree-export-2.tex").is_ok());
        assert!(validate_relative_document_path("../secret.typ").is_err());
        assert!(validate_relative_document_path("C:\\secret.typ").is_err());
        assert!(validate_relative_document_path("original.tex").is_err());
        assert!(validate_relative_document_path("notes.txt").is_err());
        assert!(validate_relative_bibliography_path("references.bib").is_ok());
        assert!(validate_relative_bibliography_path("main.typ").is_err());
    }

    #[test]
    fn digest_is_stable_and_content_sensitive() {
        assert_eq!(digest(b"hello"), digest(b"hello"));
        assert_ne!(digest(b"hello"), digest(b"Hello"));
    }

    #[test]
    fn remembers_projects_and_parent_folders_across_state_instances() {
        let base = temporary_project("recent-projects");
        let first_root = base.join("first-paper");
        let second_root = base.join("second-paper");
        fs::create_dir_all(&first_root).expect("first project should be created");
        fs::create_dir_all(&second_root).expect("second project should be created");
        fs::write(first_root.join("main.typ"), "= First")
            .expect("first document should be written");
        fs::write(second_root.join("main.typ"), "= Second")
            .expect("second document should be written");
        let history_path = base.join("settings").join("recent-projects.json");

        let state = ProjectState::default();
        state
            .configure_recent_projects(history_path.clone())
            .expect("history should be configured");
        state
            .select(first_root.clone())
            .expect("first project should open");
        state
            .select(second_root.clone())
            .expect("second project should open");
        drop(state);

        let restored = ProjectState::default();
        restored
            .configure_recent_projects(history_path)
            .expect("history should reload");
        let recent = restored
            .recent_projects()
            .expect("history should be readable");
        assert_eq!(recent.len(), 2);
        assert_eq!(recent[0].name, "second-paper");
        assert_eq!(recent[1].name, "first-paper");
        assert_eq!(
            PathBuf::from(&recent[0].parent),
            base.canonicalize().unwrap()
        );
        assert_eq!(
            restored
                .select_recent(&recent[1].root)
                .expect("a remembered project should reopen")
                .name,
            "first-paper"
        );
        assert_eq!(
            restored
                .select_recent(&second_root.join("not-remembered").to_string_lossy())
                .expect_err("an arbitrary frontend path must not gain approval")
                .code,
            "project_not_remembered"
        );

        drop(restored);
        fs::remove_dir_all(base).expect("test projects should be removed");
    }

    #[test]
    fn project_lease_serializes_desktop_and_cli_owners() {
        let root = temporary_project("project-lease");
        fs::create_dir_all(&root).expect("test project should be created");

        let first = ProjectState::default();
        first
            .select_for_cli(root.clone())
            .expect("first owner should acquire the project lease");
        first
            .select_for_cli(root.clone())
            .expect("the current owner should be able to reselect its project");
        let second = ProjectState::default();
        let error = second
            .select_for_cli(root.clone())
            .expect_err("a second owner must not mutate the same project");
        assert_eq!(error.code, "project_in_use");

        drop(first);
        second
            .select_for_cli(root.clone())
            .expect("the lease should release when its owner exits");
        drop(second);
        fs::remove_dir_all(root).expect("test project should be removed");
    }

    #[test]
    fn preserves_a_cold_start_preference_for_one_current_project_restore() {
        let root = temporary_project("initial-active-path");
        fs::create_dir_all(&root).expect("test project should be created");
        fs::write(root.join("main.typ"), "= Main").expect("main document should be written");
        fs::write(root.join("chapter.typ"), "= Chapter")
            .expect("preferred document should be written");

        let state = ProjectState::default();
        let selected = state
            .select_with_preferred(root.clone(), Some("chapter.typ"))
            .expect("preferred project document should be selected");
        assert_eq!(selected.active.path, "chapter.typ");
        assert_eq!(
            state
                .take_initial_active_path()
                .expect("initial path should be available")
                .as_deref(),
            Some("chapter.typ")
        );
        assert_eq!(
            state
                .take_initial_active_path()
                .expect("initial path should be one-shot"),
            None
        );
        assert_eq!(
            state
                .refresh(None)
                .expect("ordinary refresh should keep its default selection behavior")
                .active
                .path,
            "main.typ"
        );

        drop(state);
        fs::remove_dir_all(root).expect("test project should be removed");
    }

    #[test]
    fn inspects_a_project_without_conversion_or_private_state_creation() {
        let root = temporary_project("project-inspection");
        fs::create_dir_all(&root).expect("test project should be created");
        fs::write(root.join("main.typ"), "= Inspection").expect("main document should be written");
        fs::write(root.join("references.bib"), "@book{inspection}")
            .expect("bibliography should be written");
        fs::write(root.join("legacy.tex"), "\\documentclass{article}")
            .expect("LaTeX source should be written");
        fs::write(root.join("legacy.typ"), "= Preserved companion")
            .expect("Typst companion should be written");
        fs::write(root.join("pending.tex"), "\\documentclass{article}")
            .expect("pending LaTeX source should be written");
        fs::write(root.join("proposal.md"), "# Proposal")
            .expect("Markdown source should be written");
        fs::write(root.join("proposal.typ"), "= Proposal")
            .expect("Markdown companion should be written");
        fs::write(root.join("notes.md"), "# Notes")
            .expect("unconverted Markdown should be written");
        fs::write(
            root.join("main.undertree-export.tex"),
            "\\documentclass{article}",
        )
        .expect("generated LaTeX should be written");

        assert!(!root.join(".undertree").exists());
        let inspection = ProjectState::inspect(&root).expect("project should be inspected");

        assert!(!root.join(".undertree").exists());
        assert!(!root.join("pending.typ").exists());
        assert!(!root.join("notes.typ").exists());
        assert_eq!(inspection.lock_state, ProjectLockState::Unavailable);
        assert_eq!(inspection.inventory.total, 9);
        assert_eq!(inspection.inventory.editable, 5);
        assert_eq!(inspection.inventory.default_visible, 5);
        assert_eq!(inspection.inventory.categories.get("typst"), Some(&3));
        assert_eq!(
            inspection.inventory.categories.get("bibliography"),
            Some(&1)
        );
        assert_eq!(inspection.inventory.categories.get("latex"), Some(&2));
        assert_eq!(
            inspection.inventory.categories.get("generated-latex"),
            Some(&1)
        );
        assert_eq!(inspection.inventory.categories.get("other"), Some(&2));
        assert_eq!(inspection.conversion.latex_sources, 2);
        assert_eq!(inspection.conversion.latex_sources_with_typst_companion, 1);
        assert_eq!(inspection.conversion.markdown_sources, 2);
        assert_eq!(
            inspection.conversion.markdown_sources_with_typst_companion,
            1
        );
        assert_eq!(inspection.conversion.generated_latex_exports, 1);
        assert_eq!(
            inspection
                .active
                .as_ref()
                .map(|document| document.path.as_str()),
            Some("main.typ")
        );

        let document = ProjectState::inspect_document(&root, "main.typ")
            .expect("editable document metadata should be inspected");
        assert_eq!(document.path, "main.typ");
        assert_eq!(document.bytes, "= Inspection".len() as u64);
        assert_eq!(document.digest, digest(b"= Inspection"));
        assert_eq!(
            ProjectState::inspect_document(&root, "legacy.tex")
                .expect_err("preserved LaTeX must remain outside document inspection")
                .code,
            "path_denied"
        );

        fs::remove_dir_all(root).expect("test project should be removed");
    }

    #[test]
    fn probes_only_an_existing_safe_project_lock() {
        let root = temporary_project("project-lock-inspection");
        let state_directory = root.join(".undertree");
        fs::create_dir_all(&state_directory).expect("project state should be created");
        fs::write(root.join("main.typ"), "= Lock inspection")
            .expect("main document should be written");
        let lock_path = state_directory.join("project.lock");
        fs::write(&lock_path, "unchanged lock contents").expect("lock file should be written");

        assert_eq!(
            ProjectState::inspect(&root)
                .expect("unlocked project should be inspected")
                .lock_state,
            ProjectLockState::Available
        );

        let owner = ProjectState::default();
        owner
            .select_for_cli(root.clone())
            .expect("project lease should be acquired");
        assert_eq!(
            ProjectState::inspect(&root)
                .expect("locked project should remain inspectable")
                .lock_state,
            ProjectLockState::InUse
        );
        drop(owner);

        assert_eq!(
            ProjectState::inspect(&root)
                .expect("released project should be inspected")
                .lock_state,
            ProjectLockState::Available
        );
        assert_eq!(
            fs::read_to_string(&lock_path).expect("lock file should remain readable"),
            "unchanged lock contents"
        );

        fs::remove_dir_all(root).expect("test project should be removed");
    }

    #[test]
    fn inventories_editable_files_and_preserves_external_save_conflicts() {
        let root = temporary_project("project-policy");
        fs::create_dir_all(root.join("chapters")).expect("test project should be created");
        fs::write(root.join("main.typ"), "= Original").expect("main document should be written");
        fs::write(root.join("chapters").join("one.typ"), "Chapter")
            .expect("nested document should be written");
        fs::write(root.join("references.bib"), "@book{tree, title={Tree}}")
            .expect("bibliography should be written");
        fs::write(
            root.join("main.undertree-export.tex"),
            "\\documentclass{article}",
        )
        .expect("generated LaTeX export should be written");
        fs::write(root.join("legacy.tex"), "preserved original")
            .expect("original LaTeX should be written");
        fs::write(root.join("compiled.pdf"), b"%PDF-1.7").expect("PDF asset should be written");
        fs::write(root.join("figure.png"), b"not decoded by inventory")
            .expect("image asset should be written");
        fs::write(root.join("journal.cls"), "formatting support")
            .expect("formatting support should be written");
        fs::write(root.join("ignored.txt"), "not Typst").expect("other file should be written");

        let (initial_inventory, all_files) =
            scan_project_inventory(&root).expect("project should be inventoried");
        assert!(
            initial_inventory.contains(&"main.undertree-export.tex".to_owned()),
            "UnderTree-generated LaTeX exports should be editable"
        );
        assert!(
            !initial_inventory.contains(&"legacy.tex".to_owned()),
            "preserved original LaTeX should remain hidden"
        );
        let entry = |path: &str| {
            all_files
                .iter()
                .find(|entry| entry.path == path)
                .unwrap_or_else(|| panic!("missing inventory entry: {path}"))
        };
        assert_eq!(entry("main.typ").category, "typst");
        assert!(entry("main.typ").editable);
        assert!(entry("main.typ").default_visible);
        assert_eq!(
            entry("main.undertree-export.tex").category,
            "generated-latex"
        );
        assert_eq!(entry("legacy.tex").category, "latex");
        assert!(!entry("legacy.tex").editable);
        assert!(!entry("legacy.tex").default_visible);
        assert_eq!(entry("compiled.pdf").category, "pdf");
        assert_eq!(entry("figure.png").category, "image");
        assert_eq!(entry("journal.cls").category, "other");
        fs::remove_file(root.join("legacy.tex")).expect("remove inventory-only original");

        let state = ProjectState::default();
        let snapshot = state
            .select(root.clone())
            .expect("valid project should be selected");
        assert_eq!(
            snapshot.files,
            [
                "chapters/one.typ",
                "main.typ",
                "main.undertree-export.tex",
                "references.bib"
            ]
        );
        assert!(
            snapshot
                .all_files
                .iter()
                .any(|entry| entry.path == "compiled.pdf")
        );
        assert!(
            snapshot
                .all_files
                .iter()
                .any(|entry| entry.path == "figure.png")
        );

        fs::write(root.join("main.typ"), "= External edit")
            .expect("external edit should be written");
        let response = state
            .save(SaveRequest {
                path: "main.typ".into(),
                source: "= Editor edit".into(),
                expected_digest: snapshot.active.digest,
                revision: 9,
            })
            .expect("editor snapshot should save with a recovery copy");

        assert_eq!(response.revision, 9);
        assert_eq!(
            fs::read_to_string(root.join("main.typ")).expect("saved source should be readable"),
            "= Editor edit"
        );
        let conflict = response
            .conflict_path
            .expect("external content should be preserved");
        assert_eq!(
            fs::read_to_string(root.join(conflict)).expect("conflict copy should be readable"),
            "= External edit"
        );

        fs::remove_dir_all(root).expect("test project should be removed");
    }

    #[test]
    fn creates_opens_and_saves_a_confined_bibliography() {
        let root = temporary_project("bibliography-policy");
        fs::create_dir_all(root.join("sources")).expect("test project should be created");
        fs::write(root.join("main.typ"), "= Bibliography test")
            .expect("main document should be written");

        let state = ProjectState::default();
        state
            .select(root.clone())
            .expect("valid project should be selected");
        let created = state
            .create_bibliography("sources/references.bib")
            .expect("bibliography should be created");
        assert_eq!(created.document.path, "sources/references.bib");
        assert_eq!(created.files, ["main.typ", "sources/references.bib"]);
        assert_eq!(
            created
                .all_files
                .iter()
                .find(|entry| entry.path == "sources/references.bib")
                .map(|entry| entry.category.as_str()),
            Some("bibliography")
        );
        assert!(state.create_bibliography("sources/references.bib").is_err());
        assert!(state.create_bibliography("../outside.bib").is_err());

        state
            .save(SaveRequest {
                path: created.document.path,
                source: "@article{under-tree, title={UnderTree}}".into(),
                expected_digest: created.document.digest,
                revision: 4,
            })
            .expect("bibliography should save");
        assert_eq!(
            fs::read_to_string(root.join("sources").join("references.bib"))
                .expect("bibliography should be readable"),
            "@article{under-tree, title={UnderTree}}"
        );

        fs::remove_dir_all(root).expect("test project should be removed");
    }

    #[test]
    fn indexes_bibliography_metadata_for_local_citation_recommendations() {
        let root = temporary_project("bibliography-index");
        fs::create_dir_all(root.join("sources")).expect("test project should be created");
        fs::write(root.join("main.typ"), "= Bibliography index")
            .expect("main document should be written");
        fs::write(
            root.join("references.bib"),
            r#"@article{fejer2025heart,
  author = {George Fejer and Ana Example},
  title = {Your Heart Does Not Lie},
  date = {2025-04},
  journaltitle = {Journal of Cardiac Cognition},
  doi = {10.1000/heart}
}"#,
        )
        .expect("bibliography should be written");
        fs::write(
            root.join("sources").join("more.bib"),
            r#"@book{another-work,
  author = {Morgan Reader},
  title = {Remembering Only Part of a Title},
  year = {2024},
  publisher = {UnderTree Press}
}"#,
        )
        .expect("second bibliography should be written");

        let state = ProjectState::default();
        state
            .select(root.clone())
            .expect("valid project should be selected");
        let index = state
            .bibliography_entries()
            .expect("bibliographies should be indexed");

        assert!(index.issues.is_empty());
        assert_eq!(index.entries.len(), 2);
        let heart = index
            .entries
            .iter()
            .find(|entry| entry.key == "fejer2025heart")
            .expect("heart citation should be present");
        assert_eq!(heart.authors, "George Fejer; Ana Example");
        assert_eq!(heart.title, "Your Heart Does Not Lie");
        assert_eq!(heart.year, "2025");
        assert_eq!(heart.venue, "Journal of Cardiac Cognition");
        assert_eq!(heart.doi, "10.1000/heart");
        assert_eq!(heart.source_path, "references.bib");

        fs::remove_dir_all(root).expect("test project should be removed");
    }

    #[test]
    fn keeps_valid_recommendations_when_another_bibliography_is_invalid_or_duplicate() {
        let root = temporary_project("bibliography-index-issues");
        fs::create_dir_all(&root).expect("test project should be created");
        fs::write(root.join("main.typ"), "= Bibliography issues")
            .expect("main document should be written");
        fs::write(
            root.join("a-valid.bib"),
            "@article{shared-key, title={First title}}",
        )
        .expect("valid bibliography should be written");
        fs::write(
            root.join("b-duplicate.bib"),
            "@article{shared-key, title={Duplicate title}}",
        )
        .expect("duplicate bibliography should be written");
        fs::write(
            root.join("c-invalid.bib"),
            "@article{broken, title={Missing close}",
        )
        .expect("invalid bibliography should be written");

        let state = ProjectState::default();
        state
            .select(root.clone())
            .expect("valid project should be selected");
        let index = state
            .bibliography_entries()
            .expect("valid recommendations should survive local bibliography issues");

        assert_eq!(index.entries.len(), 1);
        assert_eq!(index.entries[0].title, "First title");
        assert_eq!(index.issues.len(), 2);
        assert!(
            index
                .issues
                .iter()
                .any(|issue| issue.source_path == "b-duplicate.bib")
        );
        assert!(
            index
                .issues
                .iter()
                .any(|issue| issue.source_path == "c-invalid.bib")
        );

        fs::remove_dir_all(root).expect("test project should be removed");
    }

    #[test]
    fn compile_validates_and_opens_a_non_destructive_latex_export() {
        let root = temporary_project("typst-latex-export");
        fs::create_dir_all(&root).expect("test project should be created");
        let source = "= Submission title\n\nA *reviewable* result with $x^2$.\n";
        fs::write(root.join("main.typ"), source).expect("Typst source should be written");

        let state = ProjectState::default();
        state
            .select(root.clone())
            .expect("valid project should be selected");
        let compiler = CompilerAssets::load();
        let (project, report) = state
            .export_typst_to_latex("main.typ", &compiler)
            .expect("compile-valid Typst should export");

        assert_eq!(report.source, "main.typ");
        assert_eq!(report.latex, "main.undertree-export.tex");
        assert!(report.source_compiled);
        assert!(report.original_preserved);
        assert_eq!(project.active.path, report.latex);
        assert!(project.files.contains(&report.latex));
        assert!(
            project
                .all_files
                .iter()
                .any(|entry| entry.path == report.latex && entry.category == "generated-latex")
        );
        assert_eq!(fs::read_to_string(root.join("main.typ")).unwrap(), source);
        assert!(
            fs::read_to_string(root.join(&report.latex))
                .unwrap()
                .contains("\\documentclass[11pt]{article}")
        );

        fs::remove_dir_all(root).expect("test project should be removed");
    }

    #[test]
    fn refuses_to_export_broken_typst_without_creating_latex() {
        let root = temporary_project("broken-typst-latex-export");
        fs::create_dir_all(&root).expect("test project should be created");
        fs::write(root.join("main.typ"), "#let broken = (")
            .expect("broken Typst source should be written");

        let state = ProjectState::default();
        state
            .select(root.clone())
            .expect("project inventory should still open");
        let error = state
            .export_typst_to_latex("main.typ", &CompilerAssets::load())
            .expect_err("broken Typst must not export");

        assert_eq!(error.code, "compile_failed");
        assert!(!root.join("main.undertree-export.tex").exists());
        assert_eq!(
            fs::read_to_string(root.join("main.typ")).unwrap(),
            "#let broken = ("
        );

        fs::remove_dir_all(root).expect("test project should be removed");
    }

    #[test]
    fn refreshes_the_selected_project_from_external_disk_changes() {
        let root = temporary_project("refresh-policy");
        fs::create_dir_all(&root).expect("test project should be created");
        fs::write(root.join("main.typ"), "= Original").expect("main document should be written");
        fs::write(root.join("references.bib"), "@book{original}")
            .expect("bibliography should be written");

        let state = ProjectState::default();
        state
            .select(root.clone())
            .expect("valid project should be selected");
        fs::write(root.join("references.bib"), "@book{external}")
            .expect("external bibliography edit should be written");
        fs::write(root.join("chapter.typ"), "= New chapter")
            .expect("external document should be written");

        let refreshed = state
            .refresh(Some("references.bib"))
            .expect("the approved project should refresh");
        assert_eq!(
            refreshed.files,
            ["chapter.typ", "main.typ", "references.bib"]
        );
        assert_eq!(refreshed.active.path, "references.bib");
        assert_eq!(refreshed.active.source, "@book{external}");

        fs::remove_dir_all(root).expect("test project should be removed");
    }
}
