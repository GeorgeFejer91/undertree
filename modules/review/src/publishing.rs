use crate::document::{digest, MAX_TEXT};
use crate::service::source_files::RootedRoot;
use crate::service::{atomic_write, Service, SourceBinding};
use crate::{Error, Result, RootObservation};
use base64::Engine;
use cap_fs_ext::{DirExt, FollowSymlinks, OpenOptionsFollowExt, OpenOptionsSyncExt};
use cap_std::fs::{Dir, File, OpenOptions};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;
use tokio::io::AsyncWriteExt;
mod compiler_capture;
pub(crate) mod diagnostics;
mod pdf_spool;

const MAX_PDF: usize = 16 * 1024 * 1024;
const MAX_DIAGNOSTICS: usize = 64 * 1024;
const MAX_PREVIEW_INFO: usize = 1024 * 1024;
const MAX_DEPENDENCY_LIST: usize = 256 * 1024;
const MAX_DEPENDENCIES: usize = 1000;
const MAX_INPUT_BYTES: u64 = 128 * 1024 * 1024;
const MAX_INVENTORY_FILES: usize = 20_000;
const MAX_INVENTORY_DIRECTORIES: usize = 2000;
const MAX_NATIVE_REPORT: usize = 128 * 1024;
const MAX_NATIVE_OVERHEAD: usize = 256 * 1024;
const QUALIFIED_TYPST: &str = "29273eaa04f6d00edd0c2bec578f565fc9c65be856bfbffc894567c68ed0b237";

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Dependency {
    path: String,
    revision: String,
    #[serde(default)]
    source_epoch: u64,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Preview {
    #[serde(default)]
    compiler_capture_version: u8,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    expected_root: Option<RootObservation>,
    revision: String,
    #[serde(default)]
    source_epoch: u64,
    #[serde(default)]
    pdf: String,
    #[serde(default)]
    pdf_hash: String,
    #[serde(default)]
    dependencies: Option<Vec<Dependency>>,
    #[serde(default)]
    inputs_stable: bool,
    #[serde(default)]
    external_dependency_count: usize,
    #[serde(default)]
    diagnostics: String,
}

#[derive(Deserialize)]
struct CompilerDependencies {
    inputs: Vec<String>,
}

#[derive(Clone, PartialEq, Eq)]
struct FileStamp {
    length: u64,
    modified: Option<cap_std::time::SystemTime>,
}

fn is_font(path: &str) -> bool {
    Path::new(path)
        .extension()
        .and_then(|s| s.to_str())
        .is_some_and(|extension| {
            ["ttf", "otf", "ttc", "otc"].contains(&extension.to_ascii_lowercase().as_str())
        })
}

fn reserved_input_component(name: &std::ffi::OsStr) -> bool {
    let text = name.to_string_lossy();
    #[cfg(windows)]
    let text = text.trim_end_matches([' ', '.']).to_ascii_lowercase();
    #[cfg(windows)]
    let reserved = [".git", "node_modules", "for-ai"];
    #[cfg(not(windows))]
    let reserved = [".git", "node_modules", "For-AI"];
    reserved.contains(&text.as_ref())
        || text.starts_with(".undertree-compile-")
        || text.starts_with(".undertree-build-")
}

fn input_path(relative: &str) -> Result<&Path> {
    let path = Path::new(relative);
    if relative.len() > 4096
        || path.as_os_str().is_empty()
        || path.components().any(|component| {
            !matches!(component, Component::Normal(_))
                || reserved_input_component(component.as_os_str())
        })
    {
        return Err(Error::new("path", "Invalid Typst project dependency path."));
    }
    let canonical = path
        .components()
        .map(|component| component.as_os_str().to_string_lossy())
        .collect::<Vec<_>>()
        .join("/");
    if canonical != relative.replace(std::path::MAIN_SEPARATOR, "/") {
        return Err(Error::new("path", "Invalid Typst project dependency path."));
    }
    Ok(path)
}

// Open every component without following links, including the approved root itself.
fn project_directory(root: &Path) -> Result<Dir> {
    let anchor = root
        .ancestors()
        .last()
        .ok_or_else(|| Error::new("path", "The approved project root is invalid."))?;
    let mut directory = Dir::open_ambient_dir(anchor, cap_std::ambient_authority())?;
    for component in root
        .strip_prefix(anchor)
        .map_err(|_| Error::new("path", "The approved project root is invalid."))?
        .components()
    {
        let Component::Normal(name) = component else {
            return Err(Error::new("path", "The approved project root is invalid."));
        };
        directory = directory.open_dir_nofollow(name)
            .map_err(|_| Error::new("path", "The approved project folder moved or became a link. Approve its current location again."))?;
    }
    Ok(directory)
}

fn open_input(root: &Dir, relative: &str) -> Result<File> {
    let path = input_path(relative)?;
    let mut directory = root.try_clone()?;
    for component in path.parent().unwrap_or_else(|| Path::new("")).components() {
        directory = directory
            .open_dir_nofollow(component.as_os_str())
            .map_err(|_| {
                Error::new(
                    "path",
                    "Linked Typst inputs and inputs outside the project are not allowed.",
                )
            })?;
    }
    let mut options = OpenOptions::new();
    options.read(true).follow(FollowSymlinks::No).nonblock(true);
    let file = directory
        .open_with(path.file_name().unwrap_or_default(), &options)
        .map_err(|_| {
            Error::new(
                "path",
                "Only regular, unlinked Typst project inputs can be read.",
            )
        })?;
    if !file.metadata()?.is_file() {
        return Err(Error::new(
            "path",
            "Typst inputs must be regular project files.",
        ));
    }
    Ok(file)
}

fn read_input(root: &Dir, relative: &str, maximum: usize) -> Result<Vec<u8>> {
    let mut bytes = Vec::new();
    open_input(root, relative)?
        .take(maximum as u64 + 1)
        .read_to_end(&mut bytes)?;
    if bytes.len() > maximum {
        return Err(Error::new(
            "limit",
            "The manuscript exceeds its supported size limit.",
        ));
    }
    Ok(bytes)
}

fn project_inventory(root: &Dir) -> Result<BTreeSet<String>> {
    fn walk(
        directory: &Dir,
        prefix: &Path,
        depth: usize,
        directories: &mut usize,
        entries: &mut usize,
        files: &mut BTreeSet<String>,
    ) -> Result<()> {
        *directories += 1;
        if depth > 32 || *directories > MAX_INVENTORY_DIRECTORIES {
            return Err(Error::new("limit", "The Typst project exceeds 2000 directories or 32 directory levels. The last good PDF is preserved."));
        }
        for entry in directory.entries()? {
            *entries += 1;
            if *entries > MAX_INVENTORY_FILES {
                return Err(Error::new(
                    "limit",
                    "The Typst project exceeds 20000 entries. The last good PDF is preserved.",
                ));
            }
            let entry = entry?;
            let name = entry.file_name();
            if reserved_input_component(&name) {
                continue;
            }
            let kind = entry.file_type()?;
            if kind.is_symlink() {
                continue;
            }
            let path = prefix.join(&name);
            if kind.is_dir() {
                let child = directory.open_dir_nofollow(&name)
                    .map_err(|_| Error::new("path", "A project directory changed or became a link while preparing Typst inputs."))?;
                walk(&child, &path, depth + 1, directories, entries, files)?;
            } else if kind.is_file() {
                let relative = path
                    .to_str()
                    .ok_or_else(|| Error::new("path", "Typst input paths must be valid UTF-8."))?
                    .replace(std::path::MAIN_SEPARATOR, "/");
                input_path(&relative)?;
                files.insert(relative);
            }
        }
        Ok(())
    }
    let mut files = BTreeSet::new();
    walk(root, Path::new(""), 0, &mut 0, &mut 0, &mut files)?;
    Ok(files)
}

fn file_stamp(file: &File) -> Result<FileStamp> {
    let metadata = file.metadata()?;
    Ok(FileStamp {
        length: metadata.len(),
        modified: metadata.modified().ok(),
    })
}

fn copy_input(
    mut file: File,
    mut output: Option<&mut std::fs::File>,
    remaining: &mut u64,
) -> Result<(String, bool)> {
    let before = file_stamp(&file)?;
    if before.length > *remaining {
        return Err(staging_limit());
    }
    let mut hasher = Sha256::new();
    let mut buffer = [0u8; 64 * 1024];
    let mut bytes = 0;
    loop {
        let read = file.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        bytes += read as u64;
        if bytes > *remaining {
            return Err(staging_limit());
        }
        hasher.update(&buffer[..read]);
        if let Some(output) = output.as_mut() {
            output.write_all(&buffer[..read])?;
        }
    }
    *remaining -= bytes;
    let after = file_stamp(&file)?;
    Ok((
        format!("{:x}", hasher.finalize()),
        before == after && bytes == after.length,
    ))
}

fn staging_limit() -> Error {
    Error::new("limit", "The complete regular-file Typst project exceeds the 128 MB staging/verification limit. The last good PDF is preserved.")
}

fn hash_input(root: &Dir, relative: &str, remaining: &mut u64) -> Result<(String, bool)> {
    copy_input(open_input(root, relative)?, None, remaining)
}

struct StagedProject {
    original: Arc<RootedRoot>,
    root: tempfile::TempDir,
    inputs: BTreeMap<String, String>,
}

#[cfg(test)]
fn stage_project(root: &Path, state: &Path, source: &str, revision: &str) -> Result<StagedProject> {
    let observed = RootedRoot::observe(root)?;
    stage_project_rooted(
        RootedRoot::acquire(root, &observed)?,
        state,
        source,
        revision,
    )
}

fn stage_project_rooted(
    original: Arc<RootedRoot>,
    state: &Path,
    source: &str,
    revision: &str,
) -> Result<StagedProject> {
    let source = source.replace(std::path::MAIN_SEPARATOR, "/");
    input_path(&source)?;
    let directory = original.directory()?;
    if original.has_pending(&source)? {
        return Err(Error::new(
            "busy",
            "Resolve the pending save before compiling this source.",
        ));
    }
    let source_bytes = read_input(&directory, &source, MAX_TEXT)?;
    let text = std::str::from_utf8(&source_bytes)
        .map_err(|_| Error::new("source", "The manuscript is not valid UTF-8 text."))?;
    if digest(text) != revision {
        return Err(Error::new(
            "stale",
            "Save the current source before compiling.",
        ));
    }
    let mut paths = project_inventory(&directory)?;
    paths.insert(source.clone());
    let snapshot = tempfile::Builder::new()
        .prefix(".undertree-build-")
        .tempdir_in(state.canonicalize()?)?;
    let mut remaining = MAX_INPUT_BYTES;
    let mut inputs = BTreeMap::new();
    for relative in paths {
        let destination = snapshot.path().join(input_path(&relative)?);
        std::fs::create_dir_all(destination.parent().unwrap_or_else(|| snapshot.path()))?;
        let mut output = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&destination)?;
        let hash = if relative == source {
            if source_bytes.len() as u64 > remaining {
                return Err(staging_limit());
            }
            remaining -= source_bytes.len() as u64;
            output.write_all(&source_bytes)?;
            revision.to_owned()
        } else {
            copy_input(
                open_input(&directory, &relative)?,
                Some(&mut output),
                &mut remaining,
            )?
            .0
        };
        inputs.insert(relative, hash);
    }
    original.check_current()?;
    Ok(StagedProject {
        original,
        root: snapshot,
        inputs,
    })
}

fn dependencies_current(root: &Path, preview: &Preview) -> bool {
    let Some(dependencies) = &preview.dependencies else {
        return false;
    };
    if !preview.inputs_stable
        || preview.external_dependency_count != 0
        || dependencies.is_empty()
        || dependencies.len() > MAX_DEPENDENCIES
    {
        return false;
    }
    let Ok(expected) = preview
        .expected_root
        .map_or_else(|| RootedRoot::observe(root), Ok)
    else {
        return false;
    };
    let Ok(held) = RootedRoot::acquire(root, &expected) else {
        return false;
    };
    let Ok(directory) = held.directory() else {
        return false;
    };
    let Ok(inventory) = project_inventory(&directory) else {
        return false;
    };
    let fonts: BTreeSet<_> = inventory.iter().filter(|path| is_font(path)).collect();
    let recorded_fonts: BTreeSet<_> = dependencies
        .iter()
        .map(|dependency| &dependency.path)
        .filter(|path| is_font(path))
        .collect();
    if fonts != recorded_fonts {
        return false;
    }
    let mut remaining = MAX_INPUT_BYTES;
    dependencies.iter().all(|dependency| {
        hash_input(&directory, &dependency.path, &mut remaining)
            .is_ok_and(|(revision, stable)| stable && revision == dependency.revision)
    }) && held.check_current().is_ok()
}

fn diagnostics(
    bytes: &[u8],
    snapshot: &Path,
    source: &Path,
    root: &Path,
    relative: &str,
) -> String {
    String::from_utf8_lossy(bytes)
        .replace(snapshot.to_string_lossy().as_ref(), relative)
        .replace(
            snapshot
                .file_name()
                .unwrap_or_default()
                .to_string_lossy()
                .as_ref(),
            source
                .file_name()
                .unwrap_or_default()
                .to_string_lossy()
                .as_ref(),
        )
        .replace(root.to_string_lossy().as_ref(), "[project]")
}

fn preview_filename(legacy: &Path, preview: &Preview) -> Option<String> {
    let valid =
        |digest: &str| digest.len() == 64 && digest.bytes().all(|byte| byte.is_ascii_hexdigit());
    if !valid(&preview.revision) || (!preview.pdf_hash.is_empty() && !valid(&preview.pdf_hash)) {
        return None;
    }
    let version = if preview.pdf_hash.is_empty() {
        &preview.revision
    } else {
        &preview.pdf_hash
    };
    Some(format!(
        "{}-{version}.pdf",
        legacy.file_stem()?.to_string_lossy()
    ))
}

fn read_limited(path: &Path, maximum: usize) -> Result<Vec<u8>> {
    if !std::fs::symlink_metadata(path)?.is_file() {
        return Err(Error::new(
            "path",
            "Only regular source and preview files can be read.",
        ));
    }
    let mut bytes = Vec::new();
    std::fs::File::open(path)?
        .take(maximum as u64 + 1)
        .read_to_end(&mut bytes)?;
    if bytes.len() > maximum {
        return Err(Error::new(
            "limit",
            "The source or preview exceeds its supported size limit.",
        ));
    }
    Ok(bytes)
}

fn publication_unknown() -> Error {
    Error::new(
        "outcome_unknown",
        "PDF publication could not be confirmed. Existing preview files were preserved.",
    )
}

// Qualification observes one bounded regular executable. Re-execution by pathname remains
// optimistic against simultaneous same-user replacement; it is not a permanent tool identity.
fn qualified_compiler(command: &mut tokio::process::Command) -> bool {
    let program = command.as_std().get_program();
    let path = Path::new(program);
    let candidates = if path.is_absolute() {
        vec![path.to_owned()]
    } else if path.components().count() == 1 {
        std::env::var_os("PATH")
            .map(|paths| {
                std::env::split_paths(&paths)
                    .map(|dir| dir.join(path))
                    .collect()
            })
            .unwrap_or_default()
    } else {
        Vec::new()
    };
    for path in candidates {
        let qualify = || -> Result<bool> {
            if !path.is_absolute() {
                return Ok(false);
            }
            let directory = project_directory(path.parent().ok_or_else(publication_unknown)?)?;
            let name = path.file_name().ok_or_else(publication_unknown)?;
            let mut options = OpenOptions::new();
            options.read(true).follow(FollowSymlinks::No).nonblock(true);
            let mut file = directory.open_with(name, &options)?;
            let before = file.metadata()?;
            if !before.is_file() || before.len() > 64 * 1024 * 1024 {
                return Ok(false);
            }
            let mut hash = Sha256::new();
            let mut bytes = 0;
            let mut chunk = [0; 64 * 1024];
            loop {
                let count = file.read(&mut chunk)?;
                if count == 0 {
                    break;
                }
                bytes += count;
                if bytes > 64 * 1024 * 1024 {
                    return Ok(false);
                }
                hash.update(&chunk[..count]);
            }
            use cap_fs_ext::MetadataExt;
            let same = |after: &cap_std::fs::Metadata| {
                before.dev() == after.dev()
                    && before.ino() == after.ino()
                    && before.len() == after.len()
                    && before.modified().ok() == after.modified().ok()
                    && after.is_file()
            };
            Ok(bytes as u64 == before.len()
                && same(&file.metadata()?)
                && same(&directory.symlink_metadata(name)?)
                && format!("{:x}", hash.finalize()) == QUALIFIED_TYPST)
        };
        if qualify().unwrap_or(false) {
            // Execute the exact absolute spelling that was hashed, rather than resolving PATH again.
            let original = std::mem::replace(command, tokio::process::Command::new(&path));
            command.args(original.as_std().get_args());
            for (key, value) in original.as_std().get_envs() {
                if let Some(value) = value {
                    command.env(key, value);
                } else {
                    command.env_remove(key);
                }
            }
            return true;
        }
        // PATH lookup must not qualify a later executable after the first runnable entry.
        if path.is_file() {
            break;
        }
    }
    false
}

struct CopiedDiagnosticSource {
    path: String,
    text: String,
    digest: String,
    epoch: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct NativeBuildProvenance {
    project: String,
    expected_root: RootObservation,
    path: String,
    source_epoch: u64,
    source_digest: String,
    main_revision: String,
    native_build_id: String,
    instance_id: String,
}

struct NativeBuild {
    provenance: NativeBuildProvenance,
    original: Arc<RootedRoot>,
    staged_root: PathBuf,
    private_roots: Vec<PathBuf>,
    sources: Vec<CopiedDiagnosticSource>,
    qualified: bool,
}

struct CompilerInvocation {
    command: tokio::process::Command,
    timeout: std::time::Duration,
    native_report: bool,
}

impl NativeBuild {
    fn prepare(
        service: &Service,
        binding: SourceBinding<'_>,
        revision: &str,
        snapshot: &StagedProject,
        private_paths: &[&Path],
        epochs: &BTreeMap<String, u64>,
        qualified: bool,
    ) -> Result<Self> {
        let mut sources = Vec::new();
        let directory = project_directory(snapshot.root.path())?;
        let mut total = 0u64;
        if qualified {
            for (path, expected) in &snapshot.inputs {
                if !diagnostics::editable_path(path) {
                    continue;
                }
                let mut file = open_input(&directory, path)?;
                let before = file.metadata()?;
                if before.len() > MAX_TEXT as u64 {
                    continue;
                }
                use cap_fs_ext::MetadataExt;
                if before.nlink() != 1 {
                    return Err(Error::new("stale", "A copied diagnostic source changed."));
                }
                let mut bytes = Vec::new();
                (&mut file)
                    .take(MAX_TEXT as u64 + 1)
                    .read_to_end(&mut bytes)?;
                total += bytes.len() as u64;
                if total > MAX_INPUT_BYTES {
                    return Err(staging_limit());
                }
                let after = file.metadata()?;
                let named = open_input(&directory, path)?.metadata()?;
                if bytes.len() > MAX_TEXT
                    || format!("{:x}", Sha256::digest(&bytes)) != *expected
                    || before.dev() != after.dev()
                    || before.ino() != after.ino()
                    || after.dev() != named.dev()
                    || after.ino() != named.ino()
                    || after.nlink() != 1
                    || named.nlink() != 1
                    || before.len() != bytes.len() as u64
                    || after.len() != before.len()
                    || before.modified().ok() != after.modified().ok()
                {
                    return Err(Error::new("stale", "A copied diagnostic source changed."));
                }
                if let Ok(text) = String::from_utf8(bytes) {
                    sources.push(CopiedDiagnosticSource {
                        path: path.clone(),
                        text,
                        digest: expected.clone(),
                        epoch: epochs.get(path).copied().unwrap_or(0),
                    });
                }
            }
        }
        let mut private_roots: Vec<_> = private_paths
            .iter()
            .map(|path| path.to_path_buf())
            .collect();
        private_roots.push(service.project(binding.project)?.root);
        for key in [
            "HOME",
            "USERPROFILE",
            "XDG_DATA_HOME",
            "XDG_CACHE_HOME",
            "TYPST_PACKAGE_PATH",
            "TYPST_PACKAGE_CACHE_PATH",
        ] {
            if let Some(path) = std::env::var_os(key)
                .map(PathBuf::from)
                .filter(|path| path.is_absolute())
            {
                private_roots.push(path);
            }
        }
        Ok(Self {
            provenance: NativeBuildProvenance {
                project: binding.project.into(),
                expected_root: snapshot.original.observation(),
                path: binding.path.into(),
                source_epoch: binding.epoch,
                source_digest: revision.into(),
                main_revision: revision.into(),
                native_build_id: uuid::Uuid::new_v4().to_string(),
                instance_id: service.instance_id().to_owned(),
            },
            original: snapshot.original.clone(),
            staged_root: snapshot.root.path().to_owned(),
            private_roots,
            sources,
            qualified,
        })
    }

    fn report(&self, capture: &compiler_capture::StderrCapture, complete: bool) -> Result<Value> {
        let sources: Vec<_> = self
            .sources
            .iter()
            .map(|source| diagnostics::StagedSource {
                project_path: &source.path,
                text: &source.text,
                source_digest: &source.digest,
            })
            .collect();
        let private: Vec<_> = self.private_roots.iter().map(PathBuf::as_path).collect();
        let mut normalized = diagnostics::normalize(
            capture.bytes(),
            complete,
            &diagnostics::DiagnosticContext {
                staged_root: &self.staged_root,
                compiler_cwd: &self.staged_root,
                sources: &sources,
                private_roots: &private,
            },
        );
        if !self.qualified {
            normalized.rows.clear();
        }
        loop {
            let paths: BTreeSet<_> = normalized
                .rows
                .iter()
                .filter_map(|row| {
                    row.location_candidate
                        .as_ref()
                        .map(|point| point.project_path.as_str())
                })
                .collect();
            let candidates: Vec<_> = self.sources.iter().filter(|source| paths.contains(source.path.as_str())).map(|source| {
                json!({"projectPath":source.path,"sourceDigest":source.digest,"sourceEpoch":source.epoch})
            }).collect();
            let report = json!({"captureComplete":normalized.capture_complete,"truncated":normalized.truncated,
                "text":normalized.text,"rows":normalized.rows,"sourceCandidates":candidates,"provenance":self.provenance});
            if serde_json::to_vec(&report)?.len() <= MAX_NATIVE_REPORT {
                return Ok(report);
            }
            normalized.truncated = true;
            if normalized.rows.pop().is_none() {
                if normalized.text.is_empty() {
                    return Err(Error::new(
                        "limit",
                        "The native compile report exceeds its bound.",
                    ));
                }
                let mut end = normalized.text.len() / 2;
                while !normalized.text.is_char_boundary(end) {
                    end -= 1;
                }
                normalized.text.truncate(end);
            }
        }
    }

    fn require_delivery(&self, service: &Service, report: &Value) -> Result<()> {
        self.original.check_current()?;
        service.require_source_epoch(
            &self.provenance.project,
            &self.provenance.path,
            self.provenance.source_epoch,
        )?;
        for source in &self.sources {
            if report["sourceCandidates"]
                .as_array()
                .is_some_and(|rows| rows.iter().any(|row| row["projectPath"] == source.path))
            {
                service.require_source_epoch(
                    &self.provenance.project,
                    &source.path,
                    source.epoch,
                )?;
            }
        }
        self.original.check_current()
    }

    fn reply(&self, result: Result<Value>, report: Value) -> Result<Value> {
        let reply = match result {
            Ok(preview) => {
                json!({"compileDiagnosticsVersion":1,"status":"succeeded","report":report,"preview":preview})
            }
            Err(error) => {
                json!({"compileDiagnosticsVersion":1,"status":if error.code == "outcome_unknown" {"outcome_unknown"} else {"failed"},"report":report,"error":error})
            }
        };
        let encoded_pdf = reply["preview"]["base64"].as_str().map_or(0, str::len);
        let serialized = serde_json::to_vec(&reply)?;
        if serialized.len().saturating_sub(encoded_pdf) > MAX_NATIVE_OVERHEAD {
            return Err(Error::new(
                "limit",
                "The native compile reply exceeds its non-PDF bound.",
            ));
        }
        Ok(reply)
    }
}

impl Service {
    /// Native Compile projection only. Reply selection never substitutes for source authority.
    pub async fn compile_typst_native_report(
        self: &Arc<Self>,
        window_label: &str,
        owner_id: &str,
        request: crate::SourceRequest,
    ) -> Result<Value> {
        let crate::Operation::Compile {
            project,
            path,
            revision,
        } = request.operation
        else {
            return Err(Error::new(
                "scope",
                "Native compiler reports accept only Compile.",
            ));
        };
        let root = request.expected_root.ok_or_else(|| {
            Error::new("stale_root", "Capture the project folder before compiling.")
        })?;
        let owner = (window_label.to_owned(), owner_id.to_owned());
        let (service, admission_owner, key, source) =
            (self.clone(), owner.clone(), project.clone(), path.clone());
        let epoch = request.source_epoch;
        tokio::task::spawn_blocking(move || {
            let _authority = service.source_effect_guard(Some(&admission_owner))?;
            service.require_source_epoch(&key, &source, epoch)?;
            RootedRoot::acquire(&service.project(&key)?.root, &root)?;
            Ok::<_, Error>(())
        })
        .await
        .map_err(|_| Error::new("state", "Native compile admission stopped."))??;
        let executable = std::env::var_os("UNDERTREE_TYPST").unwrap_or_else(|| "typst".into());
        self.compile_typst_admit(
            SourceBinding::new(&project, &path, epoch)
                .rooted(Some(root))
                .guarded(true),
            Some(owner),
            &revision,
            CompilerInvocation {
                command: tokio::process::Command::new(executable),
                timeout: std::time::Duration::from_secs(45),
                native_report: true,
            },
        )
        .await
    }

    async fn native_compile_failure(
        self: &Arc<Self>,
        build: Arc<NativeBuild>,
        owner: Option<(String, String)>,
        capture: compiler_capture::StderrCapture,
        complete: bool,
        error: Error,
    ) -> Result<Value> {
        let service = self.clone();
        tokio::task::spawn_blocking(move || {
            let report = build.report(&capture, complete)?;
            let _authority = service.source_effect_guard(owner.as_ref())?;
            build.require_delivery(&service, &report)?;
            build.reply(Err(error), report)
        })
        .await
        .map_err(|_| publication_unknown())?
    }

    fn pdf_paths(&self, project: &str, path: &str) -> Result<(PathBuf, PathBuf)> {
        let project_info = self.project(project)?;
        let relative = input_path(path)?;
        if relative
            .extension()
            .and_then(|extension| extension.to_str())
            != Some("typ")
            || relative
                .components()
                .any(|component| component.as_os_str().to_string_lossy().starts_with('.'))
        {
            return Err(Error::new(
                "path",
                "Choose a Typst source inside this project.",
            ));
        }
        project_directory(&project_info.root)?;
        let root = self.publishing_root().join("pdfs");
        std::fs::create_dir_all(&root)?;
        let id = digest(&format!("{project}:{path}"));
        Ok((
            root.join(format!("{id}.pdf")),
            root.join(format!("{id}.json")),
        ))
    }

    pub fn preview_pdf(&self, project: &str, path: &str) -> Result<Value> {
        let (legacy_pdf, info) = self.pdf_paths(project, path)?;
        if !info.exists() {
            return Ok(json!({"available":false}));
        }
        for _ in 0..2 {
            let metadata: Preview =
                serde_json::from_slice(&read_limited(&info, MAX_PREVIEW_INFO)?)?;
            let expected = preview_filename(&legacy_pdf, &metadata);
            if expected.is_none()
                || (!metadata.pdf.is_empty() && Some(&metadata.pdf) != expected.as_ref())
            {
                return Err(Error::new(
                    "format",
                    "The saved PDF preview metadata is invalid. Compile again to recover.",
                ));
            }
            let pdf = if metadata.pdf.is_empty() {
                legacy_pdf.clone()
            } else {
                legacy_pdf.with_file_name(&metadata.pdf)
            };
            // A completed build may replace the pointer between these two reads.
            if !pdf.exists() {
                continue;
            }
            let bytes = read_limited(&pdf, MAX_PDF)?;
            if !metadata.pdf_hash.is_empty()
                && metadata.pdf_hash != format!("{:x}", Sha256::digest(&bytes))
            {
                return Err(Error::new(
                    "format",
                    "The saved PDF preview changed unexpectedly. Compile again to recover.",
                ));
            }
            let project_info = self.project(project)?;
            let observed = metadata
                .expected_root
                .map_or_else(|| RootedRoot::observe(&project_info.root), Ok)?;
            let held = RootedRoot::acquire(&project_info.root, &observed).ok();
            let source_matches = held
                .as_ref()
                .ok_or_else(|| {
                    Error::new("stale_root", "The PDF belongs to another project folder.")
                })
                .and_then(|held| held.directory())
                .and_then(|directory| read_input(&directory, path, MAX_TEXT))
                .is_ok_and(|bytes| format!("{:x}", Sha256::digest(&bytes)) == metadata.revision);
            let epochs = self.source_epochs(project)?;
            let identity_matches = epochs.get(path).copied().unwrap_or(0) == metadata.source_epoch
                && metadata.dependencies.as_ref().is_some_and(|dependencies| {
                    dependencies.iter().all(|dependency| {
                        epochs.get(&dependency.path).copied().unwrap_or(0)
                            == dependency.source_epoch
                    })
                });
            let root_matches = held
                .as_ref()
                .is_some_and(|held| held.check_current().is_ok());
            let current = metadata.compiler_capture_version == 1
                && root_matches
                && source_matches
                && identity_matches
                && dependencies_current(&project_info.root, &metadata);
            let mut result = json!({"available":true,"base64":base64::engine::general_purpose::STANDARD.encode(bytes),"revision":metadata.revision,"sourceEpoch":metadata.source_epoch,"expectedRoot":metadata.expected_root,"current":current,
                "diagnostics":metadata.diagnostics,"dependencyCount":metadata.dependencies.as_ref().map_or(0, Vec::len),
                "dependencyCoverage":"project","externalDependencyCount":metadata.external_dependency_count});
            if metadata.expected_root.is_none() {
                result.as_object_mut().unwrap().remove("expectedRoot");
            }
            return Ok(result);
        }
        Ok(json!({"available":false}))
    }

    /// Once admitted, a build stays supervised and may publish even if its caller is dropped.
    pub async fn compile_typst(
        self: &Arc<Self>,
        project: &str,
        path: &str,
        revision: &str,
    ) -> Result<Value> {
        self.compile_typst_bound(project, path, revision, 0).await
    }

    pub(crate) async fn compile_typst_bound(
        self: &Arc<Self>,
        project: &str,
        path: &str,
        revision: &str,
        source_epoch: u64,
    ) -> Result<Value> {
        self.compile_typst_rooted(project, path, revision, source_epoch, None, None)
            .await
    }

    pub(crate) async fn compile_typst_rooted(
        self: &Arc<Self>,
        project: &str,
        path: &str,
        revision: &str,
        source_epoch: u64,
        root: Option<RootObservation>,
        owner: Option<(String, String)>,
    ) -> Result<Value> {
        let executable = std::env::var_os("UNDERTREE_TYPST").unwrap_or_else(|| "typst".into());
        self.compile_typst_with_owner(
            SourceBinding::new(project, path, source_epoch)
                .rooted(root)
                .guarded(owner.is_some()),
            owner,
            revision,
            tokio::process::Command::new(executable),
            std::time::Duration::from_secs(45),
        )
        .await
    }

    #[cfg(test)]
    async fn compile_typst_with_command(
        self: &Arc<Self>,
        project: &str,
        path: &str,
        revision: &str,
        compiler: tokio::process::Command,
        timeout: std::time::Duration,
    ) -> Result<Value> {
        self.compile_typst_with_owner(
            SourceBinding::new(project, path, 0),
            None,
            revision,
            compiler,
            timeout,
        )
        .await
    }

    #[cfg(test)]
    async fn compile_typst_with_binding(
        self: &Arc<Self>,
        binding: SourceBinding<'_>,
        revision: &str,
        compiler: tokio::process::Command,
        timeout: std::time::Duration,
    ) -> Result<Value> {
        self.compile_typst_with_owner(binding, None, revision, compiler, timeout)
            .await
    }

    async fn compile_typst_with_owner(
        self: &Arc<Self>,
        binding: SourceBinding<'_>,
        owner: Option<(String, String)>,
        revision: &str,
        compiler: tokio::process::Command,
        timeout: std::time::Duration,
    ) -> Result<Value> {
        self.compile_typst_admit(
            binding,
            owner,
            revision,
            CompilerInvocation {
                command: compiler,
                timeout,
                native_report: false,
            },
        )
        .await
    }

    async fn compile_typst_admit(
        self: &Arc<Self>,
        binding: SourceBinding<'_>,
        owner: Option<(String, String)>,
        revision: &str,
        invocation: CompilerInvocation,
    ) -> Result<Value> {
        let compile_guard = self.compile_lock.clone().try_lock_owned().map_err(|_| {
            Error::new(
                "busy",
                "A Typst compilation is already running; editing remains available.",
            )
        })?;
        let service = self.clone();
        let project = binding.project.to_owned();
        let path = binding.path.to_owned();
        let source_epoch = binding.epoch;
        let expected_root = binding.root;
        let native = binding.guarded;
        let revision = revision.to_owned();
        // A dropped caller loses its result, not ownership of the admitted build.
        tokio::spawn(async move {
            service
                .compile_typst_owned(
                    SourceBinding::new(&project, &path, source_epoch)
                        .rooted(expected_root)
                        .guarded(native),
                    owner,
                    &revision,
                    compile_guard,
                    invocation,
                )
                .await
        })
        .await
        .map_err(|_| Error::new("state", "Typst supervision stopped unexpectedly."))?
    }

    async fn compile_typst_owned(
        self: &Arc<Self>,
        binding: SourceBinding<'_>,
        owner: Option<(String, String)>,
        revision: &str,
        compile_guard: tokio::sync::OwnedMutexGuard<()>,
        invocation: CompilerInvocation,
    ) -> Result<Value> {
        let CompilerInvocation {
            mut command,
            timeout,
            native_report,
        } = invocation;
        let SourceBinding {
            project,
            path,
            epoch: source_epoch,
            root: expected_root,
            guarded: _,
        } = binding;
        let service = self.clone();
        let project_key = project.to_owned();
        let source_path = path.to_owned();
        let source_revision = revision.to_owned();
        let stage_owner = owner.clone();
        let (
            source,
            snapshot,
            temporary,
            pdf_output,
            dependency_list,
            legacy_pdf,
            info,
            previous,
            captured_epochs,
            native,
            mut compiler,
            compile_guard,
        ) = tokio::task::spawn_blocking(move || {
            let project = project_key.as_str();
            let path = source_path.as_str();
            let revision = source_revision.as_str();
            let _authority = if stage_owner.is_some() {
                Some(service.source_effect_guard(stage_owner.as_ref())?)
            } else {
                None
            };
            let captured_epochs = service.capture_source_epochs(project, path, source_epoch)?;
            let project_info = service.project(project)?;
            let source = service.path(&project_info, path, false)?;
            if source.extension().and_then(|s| s.to_str()) != Some("typ") {
                return Err(Error::new("source", "Choose a Typst source to compile."));
            }
            let (legacy_pdf, info) = service.pdf_paths(project, path)?;
            let previous = read_limited(&info, MAX_PREVIEW_INFO)
                .ok()
                .and_then(|bytes| serde_json::from_slice::<Preview>(&bytes).ok());
            let root = expected_root.map_or_else(|| RootedRoot::observe(&project_info.root), Ok)?;
            let held_root = RootedRoot::acquire(&project_info.root, &root)?;
            // Bulk private copying/hashing must not hold the editor's native-owner mutex.
            drop(_authority);
            let snapshot =
                stage_project_rooted(held_root, service.publishing_root(), path, revision)?;
            let temporary = tempfile::NamedTempFile::new_in(service.publishing_root())?;
            let pdf_output = temporary.as_file().try_clone()?;
            let dependency_list = tempfile::NamedTempFile::new_in(service.publishing_root())?;
            let native = if native_report {
                if stage_owner.is_none() || expected_root.is_none() {
                    return Err(Error::new(
                        "scope",
                        "Native compile reports require a captured owner and project folder.",
                    ));
                }
                let qualified = qualified_compiler(&mut command);
                Some(Arc::new(NativeBuild::prepare(
                    &service,
                    SourceBinding::new(project, path, source_epoch)
                        .rooted(expected_root)
                        .guarded(true),
                    revision,
                    &snapshot,
                    &[
                        temporary.path(),
                        dependency_list.path(),
                        service.publishing_root(),
                    ],
                    &captured_epochs,
                    qualified,
                )?))
            } else {
                None
            };
            {
                let _authority = service.source_effect_guard(stage_owner.as_ref())?;
                snapshot.original.check_current()?;
                service.require_source_epoch(project, path, source_epoch)?;
                service.record_compiler_source_capture(
                    project,
                    &captured_epochs,
                    &snapshot.inputs,
                )?;
                snapshot.original.check_current()?;
            }
            Ok::<_, Error>((
                source,
                snapshot,
                temporary,
                pdf_output,
                dependency_list,
                legacy_pdf,
                info,
                previous,
                captured_epochs,
                native,
                command,
                compile_guard,
            ))
        })
        .await
        .map_err(|_| Error::new("state", "Typst input preparation stopped unexpectedly."))??;
        let staged_source = snapshot.root.path().join(path);
        if native.as_ref().is_some_and(|build| build.qualified) {
            compiler.arg("--color").arg("never");
        }
        compiler
            .arg("compile")
            .arg("--root")
            .arg(snapshot.root.path())
            .arg(&staged_source)
            .arg("-")
            .arg("--format")
            .arg("pdf")
            .arg("--deps")
            .arg(dependency_list.path())
            .arg("--deps-format")
            .arg("json")
            .arg("--font-path")
            .arg(snapshot.root.path());
        if native.as_ref().is_some_and(|build| build.qualified) {
            compiler.arg("--diagnostic-format").arg("short");
        }
        let spawned = compiler
            // Typst 0.15's downloader respects these variables; port zero refuses downloads.
            .envs([
                ("HTTP_PROXY", "http://127.0.0.1:0"),
                ("HTTPS_PROXY", "http://127.0.0.1:0"),
                ("ALL_PROXY", "http://127.0.0.1:0"),
                ("http_proxy", "http://127.0.0.1:0"),
                ("https_proxy", "http://127.0.0.1:0"),
                ("all_proxy", "http://127.0.0.1:0"),
                ("NO_PROXY", ""),
                ("no_proxy", ""),
            ])
            .current_dir(snapshot.root.path())
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .spawn();
        let mut child = match spawned {
            Ok(child) => child,
            Err(_) => {
                let error = Error::new("typst", "Install Typst or set UNDERTREE_TYPST to its executable. No LaTeX installation is needed.");
                return if let Some(build) = native {
                    self.native_compile_failure(
                        build,
                        owner,
                        compiler_capture::StderrCapture::new(),
                        false,
                        error,
                    )
                    .await
                } else {
                    Err(error)
                };
            }
        };
        let mut pdf_output = tokio::fs::File::from_std(pdf_output);
        let mut capture = compiler_capture::StderrCapture::new();
        let mut normal_wait = false;
        let work =
            async {
                let mut stderr = child.stderr.take().ok_or_else(|| {
                    Error::new("typst", "The compiler did not provide diagnostics.")
                })?;
                let mut stdout = child.stdout.take().ok_or_else(|| {
                    Error::new("typst", "The compiler did not provide a PDF stream.")
                })?;
                tokio::try_join!(
                    pdf_spool::spool(&mut stdout, &mut pdf_output),
                    capture.read(&mut stderr)
                )?;
                let status = child.wait().await?;
                normal_wait = status.code().is_some();
                if status.success() {
                    Ok(())
                } else {
                    Err(Error::new("typst", ""))
                }
            };
        let result = tokio::time::timeout(timeout, work)
            .await
            .unwrap_or_else(|_| {
                Err(Error::new(
                    "timeout",
                    "Typst took too long. The last good PDF is preserved.",
                ))
            });
        let complete = normal_wait && capture.eof() && !capture.clipped() && !capture.read_failed();
        match result {
            Ok(()) => (),
            Err(error) => {
                // Take native report context before transferring all private files to the reaper.
                let native = native.clone();
                let message_paths = (
                    staged_source.clone(),
                    source.clone(),
                    snapshot.root.path().to_owned(),
                );
                let reap_deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(3);
                let cleanup = tokio::spawn(async move {
                    // Retain exclusion and private files until the child is actually reaped.
                    let _compile = compile_guard;
                    let _files = (snapshot, temporary, dependency_list);
                    let mut pdf_output = pdf_output;
                    let _ = child.start_kill();
                    // The earlier wait may have failed after consuming platform wait state.
                    // Poll directly; never release ownership without a confirmed exit/reap.
                    loop {
                        if matches!(child.try_wait(), Ok(Some(_))) {
                            break;
                        }
                        let _ = child.start_kill();
                        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
                    }
                    // A cancelled Tokio file write may still be running; keep files/lease owned.
                    let _ = pdf_output.flush().await;
                    drop(pdf_output);
                });
                // No diagnostics formatting precedes the owned reaper's admission.
                let error = if error.code == "typst" && error.message.is_empty() {
                    if String::from_utf8_lossy(capture.bytes())
                        .contains("failed to download package")
                    {
                        Error::new("offline", "This manuscript needs a Typst package that is not available locally. Prepare its packages outside UnderTree, then compile again. The last good preview is preserved.")
                    } else if native.is_some() {
                        Error::new(
                            "typst",
                            "Typst compilation failed. The last good PDF is preserved.",
                        )
                    } else {
                        let message = diagnostics(
                            capture.bytes(),
                            &message_paths.0,
                            &message_paths.1,
                            &message_paths.2,
                            path,
                        );
                        Error::new(
                            "typst",
                            format!(
                                "Typst compilation failed. Last good preview preserved.\n{message}"
                            ),
                        )
                    }
                } else {
                    error
                };
                let reply = if let Some(build) = native {
                    self.native_compile_failure(build, owner, capture, complete, error)
                        .await
                } else {
                    Err(error)
                };
                // A slow reap stays owned after this response deadline; dropping a handle detaches.
                let _ = tokio::time::timeout_at(reap_deadline, cleanup).await;
                return reply;
            }
        }
        drop(pdf_output);
        let diagnostics = diagnostics(
            capture.bytes(),
            &staged_source,
            &source,
            snapshot.root.path(),
            path,
        );
        let report = if let Some(build) = native.clone() {
            Some(
                tokio::task::spawn_blocking(move || build.report(&capture, complete))
                    .await
                    .map_err(|_| publication_unknown())??,
            )
        } else {
            None
        };
        let service = self.clone();
        let project_key = project.to_owned();
        let source_path = path.to_owned();
        let source_revision = revision.to_owned();
        let delivery_native = native.clone();
        let delivery_report = report.clone();
        let delivery_owner = owner.clone();
        let published = tokio::task::spawn_blocking(move || {
            // Publication continues after request cancellation, so it must retain build ownership.
            let _compile = compile_guard;
            let (snapshot, temporary, dependency_list) = (snapshot, temporary, dependency_list);
            let project = project_key.as_str();
            let path = source_path.as_str();
            let revision = source_revision.as_str();
            let diagnostics = report.as_ref().and_then(|report| report["text"].as_str()).map_or(diagnostics, str::to_owned);
            let reported: CompilerDependencies =
                serde_json::from_slice(&read_limited(dependency_list.path(), MAX_DEPENDENCY_LIST)?)?;
            if reported.inputs.len() > MAX_DEPENDENCIES {
                return Err(Error::new(
                    "limit",
                    "Typst has more than 1000 inputs. The last good PDF is preserved.",
                ));
            }
            let mut paths = BTreeSet::new();
            let mut external_dependency_count = 0;
            for input in reported.inputs {
                let input = Path::new(&input);
                let relative = if input.is_absolute() {
                    if !input.starts_with(snapshot.root.path()) {
                        // Explicit package-cache inputs are a separate trusted compiler boundary.
                        external_dependency_count += 1;
                        continue;
                    }
                    input.strip_prefix(snapshot.root.path()).map_err(|_| Error::new("path", "Invalid staged Typst dependency."))?
                } else { input };
                let relative = relative.to_str().ok_or_else(|| Error::new("path", "Typst input paths must be valid UTF-8."))?
                    .replace(std::path::MAIN_SEPARATOR, "/");
                input_path(&relative)?;
                if !snapshot.inputs.contains_key(&relative) {
                    return Err(Error::new("path", "Typst reported an input outside its prepared project. The last good PDF is preserved."));
                }
                paths.insert(relative);
            }
            paths.insert(path.replace(std::path::MAIN_SEPARATOR, "/"));
            paths.extend(snapshot.inputs.keys().filter(|path| is_font(path)).cloned());
            if paths.len() > MAX_DEPENDENCIES {
                return Err(Error::new("limit", "Typst has more than 1000 project inputs. The last good PDF is preserved."));
            }
            let dependencies = paths.iter().map(|path| {
                let revision = snapshot.inputs.get(path).cloned().ok_or_else(|| Error::new("path", "Typst reported an input outside its prepared project."))?;
                Ok(Dependency { revision, path: path.clone(), source_epoch: captured_epochs.get(path).copied().unwrap_or(0) })
            }).collect::<Result<Vec<_>>>()?;
            let pdf_bytes = read_limited(temporary.path(), MAX_PDF)?;
            if !pdf_bytes.starts_with(b"%PDF-") {
                return Err(Error::new(
                    "typst",
                    "Typst did not produce a valid PDF. The last good preview is preserved.",
                ));
            }
            let pdf_hash = format!("{:x}", Sha256::digest(&pdf_bytes));
            let pdf = legacy_pdf.with_file_name(format!(
                "{}-{pdf_hash}.pdf",
                legacy_pdf.file_stem().unwrap_or_default().to_string_lossy()
            ));
            let metadata = Preview {
                compiler_capture_version: 1,
                expected_root: Some(snapshot.original.observation()),
                revision: revision.to_owned(),
                source_epoch,
                pdf: pdf
                    .file_name()
                    .unwrap_or_default()
                    .to_string_lossy()
                    .into_owned(),
                pdf_hash,
                dependencies: Some(dependencies),
                inputs_stable: true,
                external_dependency_count,
                diagnostics,
            };
            let metadata_bytes = serde_json::to_vec(&metadata)?;
            if metadata_bytes.len() > MAX_PREVIEW_INFO {
                return Err(Error::new(
                    "limit",
                    "Typst preview metadata exceeds 1 MB. The last good PDF is preserved.",
                ));
            }
            let _authority = service.source_effect_guard(owner.as_ref())?;
            snapshot.original.check_current()?;
            if snapshot.original.has_pending(path)? { return Err(Error::new("busy", "A pending save appeared during compilation. The last good PDF was preserved.")); }
            service.require_source_epochs(project, &captured_epochs, &paths)?;
            if let (Some(build), Some(report)) = (&native, &report) {
                build.require_delivery(&service, report)?;
            }
            atomic_write(&pdf, &pdf_bytes)?;
            let pointer_write = atomic_write(&info, &metadata_bytes);
            #[cfg(test)]
            let pointer_write = pointer_tests::after_pointer_write(&info, pointer_write);
            if pointer_write.is_err() {
                // The pointer may already be installed when its directory sync fails.
                return Err(publication_unknown());
            }
            #[cfg(test)]
            let preview = pointer_tests::read_preview(&info, || service.preview_pdf(project, path));
            #[cfg(not(test))]
            let preview = service.preview_pdf(project, path);
            let preview = preview.map_err(|_| publication_unknown())?;
            if preview["available"] != true
                || preview["revision"].as_str() != Some(revision)
                || preview["sourceEpoch"].as_u64() != Some(source_epoch)
                || !preview["base64"].as_str().is_some_and(|encoded| {
                    encoded == base64::engine::general_purpose::STANDARD.encode(&pdf_bytes)
                })
            {
                return Err(publication_unknown());
            }
            snapshot.original.check_current().map_err(|_|publication_unknown())?;
            service.require_source_epochs(project, &captured_epochs, &paths).map_err(|_|publication_unknown())?;
            let reply = if let (Some(build), Some(report)) = (&native, report) {
                build.require_delivery(&service, &report).map_err(|_| publication_unknown())?;
                #[cfg(test)]
                native_diagnostics_tests::before_reply(&info)?;
                // Serialize the full bounded projected reply before retiring any previous blob.
                build.reply(Ok(preview), report).map_err(|_| publication_unknown())?
            } else { preview };
            // Retire old blobs only after this attempt's complete reply is available.
            if let Some(old) = previous {
                if preview_filename(&legacy_pdf, &old).as_ref() == Some(&old.pdf)
                    && old.pdf != metadata.pdf
                {
                    let _ = std::fs::remove_file(pdf.with_file_name(old.pdf));
                }
            }
            let _ = std::fs::remove_file(legacy_pdf);
            Ok(reply)
        })
        .await
        .unwrap_or_else(|_| Err(publication_unknown()));
        match (published, delivery_native, delivery_report) {
            (Err(error), Some(build), Some(report)) => {
                let service = self.clone();
                tokio::task::spawn_blocking(move || {
                    let _authority = service.source_effect_guard(delivery_owner.as_ref())?;
                    build.require_delivery(&service, &report)?;
                    build.reply(Err(error), report)
                })
                .await
                .map_err(|_| publication_unknown())?
            }
            (result, _, _) => result,
        }
    }
}

#[cfg(test)]
mod supervision_tests;

#[cfg(test)]
mod pointer_tests;

#[cfg(test)]
mod native_diagnostics_tests;

#[cfg(test)]
mod epoch_tests;

#[cfg(test)]
mod capture_tests;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn staged_project_pins_main_nested_sources_assets_and_fonts() {
        let root = tempfile::tempdir().unwrap();
        let state = tempfile::tempdir().unwrap();
        std::fs::create_dir(root.path().join("chapters")).unwrap();
        std::fs::create_dir(root.path().join("fonts")).unwrap();
        let main = "#include \"chapters/part.typ\"\n";
        std::fs::write(root.path().join("main.typ"), main).unwrap();
        std::fs::write(root.path().join("chapters/part.typ"), "Original chapter.").unwrap();
        std::fs::write(root.path().join("figure.bin"), [0, 128, 255]).unwrap();
        std::fs::write(root.path().join("fonts/custom.ttf"), "project font bytes").unwrap();
        let snapshot = stage_project(
            &root.path().canonicalize().unwrap(),
            state.path(),
            "main.typ",
            &digest(main),
        )
        .unwrap();
        std::fs::write(root.path().join("main.typ"), "A newer main.").unwrap();
        std::fs::write(root.path().join("chapters/part.typ"), "A newer chapter.").unwrap();
        assert_eq!(
            std::fs::read(snapshot.root.path().join("main.typ")).unwrap(),
            main.as_bytes()
        );
        assert_eq!(
            std::fs::read_to_string(snapshot.root.path().join("chapters/part.typ")).unwrap(),
            "Original chapter."
        );
        assert_eq!(
            std::fs::read(snapshot.root.path().join("figure.bin")).unwrap(),
            [0, 128, 255]
        );
        assert_eq!(
            snapshot.inputs["chapters/part.typ"],
            digest("Original chapter.")
        );
        assert_eq!(
            snapshot.inputs["fonts/custom.ttf"],
            digest("project font bytes")
        );
        let staged_path = snapshot.root.path().to_owned();
        drop(snapshot);
        assert!(
            !staged_path.exists(),
            "owned build staging is cleaned when the build finishes"
        );
        assert_eq!(
            stage_project(
                &root.path().canonicalize().unwrap(),
                state.path(),
                "main.typ",
                &digest(main)
            )
            .err()
            .unwrap()
            .code,
            "stale"
        );
        assert_eq!(std::fs::read_dir(state.path()).unwrap().count(), 0);
    }

    #[test]
    fn invalid_main_paths_are_rejected_before_reading_or_staging() {
        let root = tempfile::tempdir().unwrap();
        let state = tempfile::tempdir().unwrap();
        let mut sources = Vec::new();
        for name in ["For-AI", "node_modules", ".git", ".undertree-build-old"] {
            std::fs::create_dir(root.path().join(name)).unwrap();
            std::fs::write(root.path().join(name).join("main.typ"), [255, 254]).unwrap();
            sources.push(format!("{name}/main.typ"));
        }
        std::fs::create_dir(root.path().join("chapters")).unwrap();
        std::fs::write(root.path().join("chapters/main.typ"), [255, 254]).unwrap();
        sources.extend(
            [
                "chapters//main.typ",
                "chapters/./main.typ",
                "chapters/main.typ/",
            ]
            .map(str::to_owned),
        );
        for source in &sources {
            assert_eq!(
                stage_project(
                    &root.path().canonicalize().unwrap(),
                    state.path(),
                    source,
                    &digest("Unused source revision.")
                )
                .err()
                .unwrap()
                .code,
                "path",
                "invalid source path must be rejected before UTF-8 decoding"
            );
        }
        assert_eq!(std::fs::read_dir(state.path()).unwrap().count(), 0);
        let service = Service::new(state.path().to_owned()).unwrap();
        let project = service
            .local(Operation::AddProject {
                root: root.path().to_string_lossy().into(),
            })
            .unwrap()["id"]
            .as_str()
            .unwrap()
            .to_owned();
        sources.push("nested/node_modules/main.typ".to_owned());
        for source in &sources {
            assert_eq!(
                service.preview_pdf(&project, source).unwrap_err().code,
                "path"
            );
        }
        #[cfg(windows)]
        for source in [
            "for-ai/main.typ",
            "NODE_MODULES/main.typ",
            "For-AI./main.typ",
        ] {
            assert_eq!(
                service.preview_pdf(&project, source).unwrap_err().code,
                "path"
            );
            assert!(input_path(source).is_err());
        }
        #[cfg(not(windows))]
        for source in [
            "for-ai/main.typ",
            "NODE_MODULES/main.typ",
            "For-AI./main.typ",
        ] {
            assert!(input_path(source).is_ok(), "preserve case-sensitive names");
        }
    }

    #[cfg(unix)]
    #[test]
    fn staging_omits_links_reserved_directories_and_old_build_residue() {
        let root = tempfile::tempdir().unwrap();
        let state = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        std::fs::write(root.path().join("main.typ"), "Safe source.").unwrap();
        std::fs::write(outside.path().join("private.txt"), "outside marker").unwrap();
        std::os::unix::fs::symlink(
            outside.path().join("private.txt"),
            root.path().join("linked.txt"),
        )
        .unwrap();
        std::os::unix::fs::symlink(outside.path(), root.path().join("linked-dir")).unwrap();
        for name in [
            ".git",
            "node_modules",
            "For-AI",
            ".undertree-build-residue",
            ".undertree-compile-residue",
        ] {
            std::fs::create_dir(root.path().join(name)).unwrap();
            std::fs::write(
                root.path().join(name).join("ignored.txt"),
                "excluded marker",
            )
            .unwrap();
        }
        let snapshot = stage_project(
            &root.path().canonicalize().unwrap(),
            state.path(),
            "main.typ",
            &digest("Safe source."),
        )
        .unwrap();
        assert_eq!(
            snapshot
                .inputs
                .keys()
                .map(String::as_str)
                .collect::<Vec<_>>(),
            ["main.typ"]
        );
        assert_eq!(std::fs::read_dir(snapshot.root.path()).unwrap().count(), 1);
    }

    #[test]
    fn staging_rejects_oversized_unused_inputs_without_leaving_a_partial_snapshot() {
        let root = tempfile::tempdir().unwrap();
        let state = tempfile::tempdir().unwrap();
        std::fs::write(root.path().join("main.typ"), "Hello.").unwrap();
        let unused = std::fs::File::create(root.path().join("unused.bin")).unwrap();
        unused.set_len(MAX_INPUT_BYTES + 1).unwrap();
        assert_eq!(
            stage_project(
                &root.path().canonicalize().unwrap(),
                state.path(),
                "main.typ",
                &digest("Hello.")
            )
            .err()
            .unwrap()
            .code,
            "limit"
        );
        assert_eq!(std::fs::read_dir(state.path()).unwrap().count(), 0);
    }

    #[cfg(unix)]
    #[test]
    fn rooted_reads_reject_an_ancestor_replaced_after_inventory() {
        let root = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        std::fs::create_dir(root.path().join("chapters")).unwrap();
        std::fs::write(root.path().join("chapters/part.typ"), "Allowed source.").unwrap();
        std::fs::write(outside.path().join("part.typ"), "outside marker").unwrap();
        let directory = project_directory(&root.path().canonicalize().unwrap()).unwrap();
        assert!(project_inventory(&directory)
            .unwrap()
            .contains("chapters/part.typ"));
        std::fs::rename(root.path().join("chapters"), root.path().join("original")).unwrap();
        std::os::unix::fs::symlink(outside.path(), root.path().join("chapters")).unwrap();
        assert_eq!(
            read_input(&directory, "chapters/part.typ", MAX_TEXT)
                .unwrap_err()
                .code,
            "path"
        );
        assert_eq!(
            project_directory(&root.path().join("chapters"))
                .err()
                .unwrap()
                .code,
            "path"
        );
    }

    #[test]
    fn preview_freshness_tracks_binary_inputs_and_new_project_fonts() {
        let root = tempfile::tempdir().unwrap();
        std::fs::write(root.path().join("main.typ"), "Hello.").unwrap();
        std::fs::write(root.path().join("figure.png"), [0, 128, 255]).unwrap();
        let mut remaining = MAX_INPUT_BYTES;
        let directory = project_directory(&root.path().canonicalize().unwrap()).unwrap();
        let image_revision = hash_input(&directory, "figure.png", &mut remaining)
            .unwrap()
            .0;
        let preview: Preview = serde_json::from_value(json!({
            "revision":digest("Hello."),"inputs_stable":true,
            "dependencies":[{"path":"main.typ","revision":digest("Hello.")},{"path":"figure.png","revision":image_revision}]
        })).unwrap();
        assert!(dependencies_current(root.path(), &preview));
        std::fs::write(root.path().join("figure.png"), [0, 128, 254]).unwrap();
        assert!(!dependencies_current(root.path(), &preview));
        std::fs::write(root.path().join("figure.png"), [0, 128, 255]).unwrap();
        assert!(dependencies_current(root.path(), &preview));
        std::fs::write(root.path().join("uploaded.ttf"), "font fixture bytes").unwrap();
        assert!(!dependencies_current(root.path(), &preview));
    }

    #[test]
    fn legacy_and_unverified_package_previews_fail_closed() {
        let root = tempfile::tempdir().unwrap();
        std::fs::write(root.path().join("main.typ"), "Hello.").unwrap();
        let mut preview: Preview =
            serde_json::from_value(json!({"revision":digest("Hello.")})).unwrap();
        assert!(!dependencies_current(root.path(), &preview));
        preview.dependencies = Some(vec![Dependency {
            source_epoch: 0,
            path: "main.typ".into(),
            revision: digest("Hello."),
        }]);
        preview.inputs_stable = true;
        assert!(dependencies_current(root.path(), &preview));
        preview.external_dependency_count = 1;
        assert!(!dependencies_current(root.path(), &preview));
        preview.external_dependency_count = 0;
        preview.inputs_stable = false;
        assert!(!dependencies_current(root.path(), &preview));
    }

    #[test]
    fn dependency_hashing_enforces_a_combined_byte_budget() {
        let file = tempfile::NamedTempFile::new().unwrap();
        std::fs::write(file.path(), b"abcd").unwrap();
        let directory =
            project_directory(&file.path().parent().unwrap().canonicalize().unwrap()).unwrap();
        let relative = file.path().file_name().unwrap().to_str().unwrap();
        let mut remaining = 5;
        assert_eq!(
            hash_input(&directory, relative, &mut remaining).unwrap().0,
            digest("abcd")
        );
        assert_eq!(remaining, 1);
        assert_eq!(
            hash_input(&directory, relative, &mut remaining)
                .err()
                .unwrap()
                .code,
            "limit"
        );
    }

    #[cfg(unix)]
    #[test]
    fn dependency_paths_refuse_linked_parents_and_escape() {
        let root = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        std::fs::write(outside.path().join("part.typ"), "private input").unwrap();
        std::os::unix::fs::symlink(outside.path(), root.path().join("linked")).unwrap();
        let directory = project_directory(&root.path().canonicalize().unwrap()).unwrap();
        assert_eq!(
            open_input(&directory, "linked/part.typ").unwrap_err().code,
            "path"
        );
        assert_eq!(
            open_input(&directory, "../part.typ").unwrap_err().code,
            "path"
        );
    }

    #[test]
    fn legacy_preview_remains_available_without_claiming_freshness() {
        let root = tempfile::tempdir().unwrap();
        let state = tempfile::tempdir().unwrap();
        let text = "Hello.";
        std::fs::write(root.path().join("main.typ"), text).unwrap();
        let service = Service::new(state.path().to_owned()).unwrap();
        let project = service
            .local(Operation::AddProject {
                root: root.path().to_string_lossy().into(),
            })
            .unwrap()["id"]
            .as_str()
            .unwrap()
            .to_owned();
        let (pdf, metadata) = service.pdf_paths(&project, "main.typ").unwrap();
        std::fs::write(pdf, b"%PDF-legacy").unwrap();
        std::fs::write(
            metadata,
            serde_json::to_vec(&json!({"revision":digest(text)})).unwrap(),
        )
        .unwrap();
        let preview = service.preview_pdf(&project, "main.typ").unwrap();
        assert_eq!(preview["available"], true);
        assert_eq!(preview["current"], false);
        assert_eq!(preview["dependencyCount"], 0);
        std::fs::remove_file(root.path().join("main.typ")).unwrap();
        assert_eq!(
            service.preview_pdf(&project, "main.typ").unwrap()["available"],
            true
        );
        std::fs::write(root.path().join("main.typ"), [255, 254]).unwrap();
        assert_eq!(
            service.preview_pdf(&project, "main.typ").unwrap()["current"],
            false
        );
        #[cfg(unix)]
        {
            let outside = tempfile::NamedTempFile::new().unwrap();
            std::fs::write(outside.path(), "outside source marker").unwrap();
            std::fs::remove_file(root.path().join("main.typ")).unwrap();
            std::os::unix::fs::symlink(outside.path(), root.path().join("main.typ")).unwrap();
            let linked = service.preview_pdf(&project, "main.typ").unwrap();
            assert_eq!(linked["available"], true);
            assert_eq!(linked["current"], false);
            assert_eq!(linked["base64"], preview["base64"]);
        }
    }

    #[test]
    fn pdf_names_bind_output_bytes_independently_of_main_source() {
        let mut first: Preview = serde_json::from_value(
            json!({"revision":digest("same main source"),"pdf_hash":digest("first pdf")}),
        )
        .unwrap();
        let first_name = preview_filename(Path::new("document.pdf"), &first).unwrap();
        first.pdf_hash = digest("second pdf after include edit");
        assert_ne!(
            first_name,
            preview_filename(Path::new("document.pdf"), &first).unwrap()
        );
    }
    #[cfg(unix)]
    #[test]
    fn preview_reads_refuse_linked_files() {
        let temporary = tempfile::tempdir().unwrap();
        let source = temporary.path().join("source.pdf");
        let linked = temporary.path().join("linked.pdf");
        std::fs::write(&source, b"private source").unwrap();
        std::os::unix::fs::symlink(&source, &linked).unwrap();
        assert_eq!(read_limited(&linked, MAX_PDF).unwrap_err().code, "path");
    }
    use crate::Operation;

    #[tokio::test]
    async fn real_typst_preserves_last_good_preview_and_relative_imports() {
        if std::env::var_os("UNDERTREE_TYPST").is_none() {
            return;
        }
        let root = tempfile::tempdir().unwrap();
        let state = tempfile::tempdir().unwrap();
        std::fs::create_dir(root.path().join("chapters")).unwrap();
        let included = "#set text(font: \"UnderTree unavailable font fixture\")\nIncluded prose.";
        std::fs::write(root.path().join("chapters/part.typ"), included).unwrap();
        let text = "= Hello\n\n#include \"part.typ\"\n";
        std::fs::write(root.path().join("chapters/main.typ"), text).unwrap();
        let service = Service::new(state.path().to_owned()).unwrap();
        let project = service
            .local(Operation::AddProject {
                root: root.path().to_string_lossy().into(),
            })
            .unwrap()["id"]
            .as_str()
            .unwrap()
            .to_owned();
        let first = service
            .compile_typst(&project, "chapters/main.typ", &digest(text))
            .await
            .unwrap();
        assert_eq!(first["current"], true);
        assert_eq!(first["dependencyCount"], 2);
        assert!(first["diagnostics"]
            .as_str()
            .unwrap()
            .contains("unknown font family"));
        assert!(!first["diagnostics"]
            .as_str()
            .unwrap()
            .contains(".undertree-compile-"));
        assert!(base64::engine::general_purpose::STANDARD
            .decode(first["base64"].as_str().unwrap())
            .unwrap()
            .starts_with(b"%PDF-"));
        std::fs::write(root.path().join("chapters/part.typ"), "New included prose.").unwrap();
        let changed = service.preview_pdf(&project, "chapters/main.typ").unwrap();
        assert_eq!(changed["revision"], first["revision"]);
        assert_eq!(changed["base64"], first["base64"]);
        assert_eq!(changed["current"], false);
        std::fs::write(root.path().join("chapters/part.typ"), included).unwrap();
        assert_eq!(
            service.preview_pdf(&project, "chapters/main.typ").unwrap()["current"],
            true
        );
        let missing_package = "#import \"@preview/undertree-offline-unavailable:0.0.1\": *\nHello.";
        std::fs::write(root.path().join("chapters/main.typ"), missing_package).unwrap();
        let started = std::time::Instant::now();
        assert_eq!(
            service
                .compile_typst(&project, "chapters/main.typ", &digest(missing_package))
                .await
                .unwrap_err()
                .code,
            "offline"
        );
        assert!(started.elapsed() < std::time::Duration::from_secs(5));
        assert_eq!(
            service.preview_pdf(&project, "chapters/main.typ").unwrap()["base64"],
            first["base64"]
        );
        let broken = "#unknown-function()";
        std::fs::write(root.path().join("chapters/main.typ"), broken).unwrap();
        assert_eq!(
            service
                .compile_typst(&project, "chapters/main.typ", &digest(broken))
                .await
                .unwrap_err()
                .code,
            "typst"
        );
        let preserved = service.preview_pdf(&project, "chapters/main.typ").unwrap();
        assert_eq!(preserved["revision"], digest(text));
        assert_eq!(preserved["base64"], first["base64"]);
        assert_eq!(preserved["current"], false);
        assert_eq!(
            service
                .compile_typst(&project, "chapters/main.typ", &digest(text))
                .await
                .unwrap_err()
                .code,
            "stale"
        );
        let imported = crate::tex_import::convert("\\section{Results}A \\textbf{strong effect}.\\begin{itemize}\\item First\\item Second\\end{itemize} $$x^2$$").unwrap();
        std::fs::write(root.path().join("chapters/main.typ"), &imported.content).unwrap();
        let compiled_import = service
            .compile_typst(&project, "chapters/main.typ", &digest(&imported.content))
            .await
            .unwrap();
        assert_eq!(compiled_import["current"], true);
        assert_eq!(
            std::fs::read_dir(state.path().join("pdfs"))
                .unwrap()
                .count(),
            2
        );
        assert!(!std::fs::read_dir(root.path().join("chapters"))
            .unwrap()
            .any(|entry| entry
                .unwrap()
                .file_name()
                .to_string_lossy()
                .starts_with(".undertree-compile-")));
    }

    #[test]
    fn bounded_reads_reject_large_data_before_decoding() {
        let file = tempfile::NamedTempFile::new().unwrap();
        std::fs::write(file.path(), vec![b'x'; 33]).unwrap();
        assert_eq!(read_limited(file.path(), 32).unwrap_err().code, "limit");
        assert_eq!(read_limited(file.path(), 33).unwrap().len(), 33);
    }
}

#[cfg(test)]
mod root_tests;
