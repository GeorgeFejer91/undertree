use std::fmt::Write as _;
use std::fs;
use std::io::Write;
use std::path::{Component, Path, PathBuf};
use std::sync::{Arc, Mutex, RwLock};
use std::time::{SystemTime, UNIX_EPOCH};

use atomic_write_file::AtomicWriteFile;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::error::BoundaryError;

const MAX_SOURCE_BYTES: u64 = 1024 * 1024;
const MAX_PROJECT_ENTRIES: usize = 10_000;
const MAX_SCAN_DEPTH: usize = 32;

#[derive(Clone, Default)]
pub struct ProjectState {
    root: Arc<RwLock<Option<PathBuf>>>,
    save_lock: Arc<Mutex<()>>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectSnapshot {
    pub name: String,
    pub root: String,
    pub files: Vec<String>,
    pub active: DocumentData,
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

impl ProjectState {
    pub fn select(&self, selected: PathBuf) -> Result<ProjectSnapshot, BoundaryError> {
        let root = selected.canonicalize().map_err(|_| {
            BoundaryError::project("project_unavailable", "The selected folder is unavailable.")
        })?;
        if !root.is_dir() {
            return Err(BoundaryError::project(
                "project_unavailable",
                "The selected path is not a folder.",
            ));
        }

        let files = scan_typst_files(&root)?;
        let active_path = files
            .iter()
            .find(|path| path.eq_ignore_ascii_case("main.typ"))
            .or_else(|| files.first())
            .ok_or_else(|| {
                BoundaryError::project(
                    "project_empty",
                    "The selected folder does not contain a .typ document.",
                )
            })?
            .clone();

        let active = read_document_at(&root, &active_path)?;
        let name = root
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("Typst project")
            .to_owned();

        *self.root.write().map_err(|_| BoundaryError::internal())? = Some(root.clone());

        Ok(ProjectSnapshot {
            name,
            root: root.to_string_lossy().into_owned(),
            files,
            active,
        })
    }

    pub fn root(&self) -> Result<Option<PathBuf>, BoundaryError> {
        self.root
            .read()
            .map(|root| root.clone())
            .map_err(|_| BoundaryError::internal())
    }

    pub fn open(&self, relative: &str) -> Result<DocumentData, BoundaryError> {
        let root = self.selected_root()?;
        read_document_at(&root, relative)
    }

    pub fn save(&self, request: SaveRequest) -> Result<SaveResponse, BoundaryError> {
        if request.source.len() as u64 > MAX_SOURCE_BYTES {
            return Err(BoundaryError::project(
                "document_too_large",
                "Typst documents are limited to 1 MiB.",
            ));
        }

        let _save_guard = self
            .save_lock
            .lock()
            .map_err(|_| BoundaryError::internal())?;

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
                "The on-disk Typst document is larger than 1 MiB.",
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

    fn selected_root(&self) -> Result<PathBuf, BoundaryError> {
        self.root()?.ok_or_else(|| {
            BoundaryError::project("project_required", "Choose a Typst project first.")
        })
    }
}

fn scan_typst_files(root: &Path) -> Result<Vec<String>, BoundaryError> {
    let mut files = Vec::new();
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
                    "The project inventory is limited to 10,000 entries.",
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
            } else if file_type.is_file()
                && path
                    .extension()
                    .is_some_and(|extension| extension.eq_ignore_ascii_case("typ"))
            {
                let relative = path
                    .strip_prefix(root)
                    .map_err(|_| BoundaryError::internal())?;
                let relative = relative.to_str().ok_or_else(|| {
                    BoundaryError::project(
                        "unsupported_path",
                        "The project contains a non-Unicode .typ path.",
                    )
                })?;
                files.push(relative.replace('\\', "/"));
            }
        }
    }

    files.sort_by_key(|path| path.to_lowercase());
    Ok(files)
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
            "Typst documents are limited to 1 MiB.",
        ));
    }

    let bytes = fs::read(&path).map_err(|_| {
        BoundaryError::project("document_unavailable", "The document could not be read.")
    })?;
    let source = String::from_utf8(bytes.clone())
        .map_err(|_| BoundaryError::project("document_encoding", "Typst source must use UTF-8."))?;

    Ok(DocumentData {
        path: relative.replace('\\', "/"),
        source,
        digest: digest(&bytes),
    })
}

fn resolve_existing_document(root: &Path, relative: &str) -> Result<PathBuf, BoundaryError> {
    let relative = validate_relative_typst_path(relative)?;
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

fn validate_relative_typst_path(relative: &str) -> Result<&Path, BoundaryError> {
    let path = Path::new(relative);
    if path.is_absolute()
        || path
            .components()
            .any(|component| !matches!(component, Component::Normal(_)))
        || !path
            .extension()
            .is_some_and(|extension| extension.eq_ignore_ascii_case("typ"))
    {
        return Err(BoundaryError::project(
            "path_denied",
            "Only relative .typ paths inside the selected project are allowed.",
        ));
    }
    Ok(path)
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
    fn accepts_only_relative_typst_paths() {
        assert!(validate_relative_typst_path("chapters/intro.typ").is_ok());
        assert!(validate_relative_typst_path("../secret.typ").is_err());
        assert!(validate_relative_typst_path("C:\\secret.typ").is_err());
        assert!(validate_relative_typst_path("notes.txt").is_err());
    }

    #[test]
    fn digest_is_stable_and_content_sensitive() {
        assert_eq!(digest(b"hello"), digest(b"hello"));
        assert_ne!(digest(b"hello"), digest(b"Hello"));
    }

    #[test]
    fn inventories_typst_files_and_preserves_external_save_conflicts() {
        let root = temporary_project("project-policy");
        fs::create_dir_all(root.join("chapters")).expect("test project should be created");
        fs::write(root.join("main.typ"), "= Original").expect("main document should be written");
        fs::write(root.join("chapters").join("one.typ"), "Chapter")
            .expect("nested document should be written");
        fs::write(root.join("ignored.txt"), "not Typst").expect("other file should be written");

        let state = ProjectState::default();
        let snapshot = state
            .select(root.clone())
            .expect("valid project should be selected");
        assert_eq!(snapshot.files, ["chapters/one.typ", "main.typ"]);

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
}
