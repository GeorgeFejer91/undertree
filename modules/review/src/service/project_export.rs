//! Native-only immutable saved-project archives. No editor save, recovery or compilation.
use super::*;
use cap_fs_ext::{FollowSymlinks, MetadataExt, OpenOptionsFollowExt, OpenOptionsSyncExt};
use cap_std::fs::{Dir, OpenOptions};
use sha2::{Digest, Sha256};
use std::time::{SystemTime, UNIX_EPOCH};
use zip::{write::SimpleFileOptions, CompressionMethod, ZipWriter};

const MAX_INPUT: u64 = 128 * 1024 * 1024;
const MAX_ZIP: u64 = MAX_INPUT + 16 * 1024 * 1024;
const MAX_METADATA: usize = 4 * 1024 * 1024;
const MAX_ENTRIES: usize = 20_000;
const MAX_DIRECTORIES: usize = 2000;
const MAX_RECEIPTS: usize = 64;
const LEASE_MS: u64 = 300_000;

#[derive(Debug, Deserialize)]
#[serde(
    tag = "action",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum ExportOperation {
    ExportStatus { request_id: String },
    ExportCancel { export_id: String },
}

struct Archive {
    directory: tempfile::TempDir,
    info: Value,
    root: PathBuf,
    root_id: (u64, u64),
}
struct Ticket {
    owner: String,
    expires: u64,
    archive: Option<Archive>,
}
struct Request {
    owner: String,
    export_id: String,
    receipt: Value,
    archive: Option<Archive>,
    writing: bool,
}
#[derive(Default)]
pub(super) struct ExportState {
    tickets: BTreeMap<String, Ticket>,
    requests: BTreeMap<String, Request>,
    history: std::collections::VecDeque<String>,
    #[cfg(test)]
    before_verify: Option<Box<dyn FnOnce() + Send>>,
    #[cfg(test)]
    before_publish: Option<Box<dyn FnOnce() + Send>>,
}

#[derive(Clone, PartialEq, Eq)]
struct Observation {
    directory: bool,
    id: (u64, u64),
    bytes: u64,
    modified: Option<cap_std::time::SystemTime>,
    mode: u32,
}
struct Inventory {
    entries: BTreeMap<String, Observation>,
    exclusions: Vec<Value>,
    directories: usize,
    visited: usize,
    metadata: usize,
}

fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
fn id(metadata: &cap_std::fs::Metadata) -> (u64, u64) {
    (metadata.dev(), metadata.ino())
}
fn stale() -> Error {
    Error::new(
        "stale",
        "The saved project changed during export. Prepare a new saved snapshot.",
    )
}
fn expired() -> Error {
    Error::new("expired_ticket","This prepared export expired, was cancelled or was consumed. Check its request before preparing another.")
}
fn options() -> OpenOptions {
    let mut value = OpenOptions::new();
    value.read(true).follow(FollowSymlinks::No).nonblock(true);
    value
}
fn zip_error(_: zip::result::ZipError) -> Error {
    Error::new(
        "archive",
        "The project ZIP could not be created. Original files were preserved.",
    )
}
fn validate_request_id(value: &str) -> Result<()> {
    if value.len() != 36 || Uuid::parse_str(value).is_err() {
        return Err(Error::new("format", "Use a UUID requestId for an export."));
    }
    Ok(())
}
fn file_mode(metadata: &cap_std::fs::Metadata) -> u32 {
    #[cfg(unix)]
    {
        use cap_std::fs::PermissionsExt;
        metadata.permissions().mode() & 0o777
    }
    #[cfg(not(unix))]
    {
        if metadata.is_dir() {
            0o755
        } else {
            0o644
        }
    }
}

fn export_path(path: &str) -> Result<()> {
    if path.len() > 4096
        || path.split('/').count() > 32
        || path.split('/').any(|name| {
            let stem = name.split('.').next().unwrap_or("").to_ascii_uppercase();
            name.is_empty()
                || name == "."
                || name == ".."
                || name.len() > 255
                || name.ends_with([' ', '.'])
                || name
                    .chars()
                    .any(|c| c.is_control() || "\\<>:\"|?*".contains(c))
                || matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
                || stem
                    .strip_prefix("COM")
                    .or_else(|| stem.strip_prefix("LPT"))
                    .is_some_and(|n| n.len() == 1 && matches!(n.as_bytes()[0], b'1'..=b'9'))
        })
    {
        return Err(Error::new(
            "path",
            "The project contains a filename that cannot be exported portably.",
        ));
    }
    Ok(())
}

fn excluded(name: &str) -> Option<&'static str> {
    if [
        ".git",
        "build",
        "target",
        "dist",
        "node_modules",
        "For-AI",
        ".cache",
    ]
    .iter()
    .any(|reserved| name.eq_ignore_ascii_case(reserved))
    {
        return Some("runtime_or_control_directory");
    }
    if name.starts_with(".undertree-build-")
        || name.starts_with(".undertree-compile-")
        || name.starts_with(".undertree-import-")
    {
        return Some("compiler_or_transfer_temporary");
    }
    None
}

impl Inventory {
    fn new() -> Self {
        Self {
            entries: BTreeMap::new(),
            exclusions: Vec::new(),
            directories: 0,
            visited: 0,
            metadata: 0,
        }
    }
    fn walk(
        &mut self,
        root: &Dir,
        directory: &Dir,
        prefix: &str,
        depth: usize,
        project: &Path,
        state: &Path,
    ) -> Result<()> {
        self.directories += 1;
        if depth > 32 || self.directories > MAX_DIRECTORIES {
            return Err(Error::new(
                "limit",
                "Export supports at most 32 folder levels and 2,000 directories.",
            ));
        }
        let directory_id = id(&directory.dir_metadata()?);
        let remaining = MAX_ENTRIES.saturating_sub(self.visited);
        let entries = directory
            .entries()?
            .take(remaining + 1)
            .collect::<std::io::Result<Vec<_>>>()?;
        if entries.len() > remaining {
            return Err(Error::new(
                "limit",
                "Export supports at most 20,000 project entries.",
            ));
        }
        self.visited += entries.len();
        let mut names = BTreeSet::new();
        for entry in entries {
            let name = entry.file_name();
            let name = name.to_str().ok_or_else(|| {
                Error::new(
                    "path",
                    "Project export requires Unicode filenames; no files were omitted.",
                )
            })?;
            let path = if prefix.is_empty() {
                name.into()
            } else {
                format!("{prefix}/{name}")
            };
            self.metadata = self
                .metadata
                .checked_add(path.len() + 256)
                .ok_or_else(stale)?;
            if self.metadata > MAX_METADATA {
                return Err(Error::new(
                    "limit",
                    "Project export filename metadata exceeds 4 MiB.",
                ));
            }
            // The actual native state subtree is private even if a broad parent was approved.
            let kind = entry.file_type()?;
            let reason = if project.join(&path) == state {
                Some("private_application_state")
            } else {
                excluded(name).filter(|reason| {
                    *reason != "runtime_or_control_directory"
                        || kind.is_dir()
                        || kind.is_symlink()
                        || name.eq_ignore_ascii_case(".git")
                })
            };
            if let Some(reason) = reason {
                self.exclusions.push(json!({"path":path,"reason":reason}));
                continue;
            }
            export_path(&path)?;
            if !names.insert(name.to_lowercase()) {
                return Err(Error::new("conflict","Project names collide on portable filesystems. No partial archive was exported."));
            }
            if name
                .to_ascii_lowercase()
                .ends_with(".undertree-pending.json")
            {
                return Err(Error::new(
                    "busy",
                    "Resolve pending local save journals before exporting the saved project.",
                ));
            }
            let metadata = directory.symlink_metadata(name)?;
            if !metadata.is_dir() && !metadata.is_file() {
                return Err(Error::new(
                    "path",
                    "Links and special files cannot be included in the saved-project archive.",
                ));
            }
            let observation = Observation {
                directory: metadata.is_dir(),
                id: id(&metadata),
                bytes: metadata.len(),
                modified: metadata.modified().ok(),
                mode: file_mode(&metadata),
            };
            self.entries.insert(path.clone(), observation);
            if metadata.is_dir() {
                let child = project_tree::open_directory(directory, name)?;
                if id(&child.dir_metadata()?) != id(&metadata) {
                    return Err(stale());
                }
                self.walk(root, &child, &path, depth + 1, project, state)?;
            }
        }
        if id(&project_tree::open_directory(root, prefix)?.dir_metadata()?) != directory_id {
            return Err(stale());
        }
        self.exclusions
            .sort_by(|a, b| a["path"].as_str().cmp(&b["path"].as_str()));
        Ok(())
    }
}

fn read_entry(
    root: &Dir,
    path: &str,
    expected: &Observation,
    remaining: &mut u64,
    mut output: Option<&mut dyn Write>,
) -> Result<String> {
    let (parent, name) = path.rsplit_once('/').unwrap_or(("", path));
    let directory = project_tree::open_directory(root, parent)?;
    let mut file = directory.open_with(name, &options())?;
    let before = file.metadata()?;
    if !before.is_file()
        || id(&before) != expected.id
        || before.len() != expected.bytes
        || before.modified().ok() != expected.modified
        || file_mode(&before) != expected.mode
    {
        return Err(stale());
    }
    if before.len() > *remaining {
        return Err(Error::new(
            "limit",
            "Saved project inputs exceed the 128 MiB export limit.",
        ));
    }
    let mut hash = Sha256::new();
    let mut bytes = 0;
    let mut chunk = [0u8; 64 * 1024];
    loop {
        let size = file.read(&mut chunk)?;
        if size == 0 {
            break;
        }
        bytes += size as u64;
        if bytes > *remaining {
            return Err(Error::new("limit", "Saved project inputs exceed 128 MiB."));
        }
        hash.update(&chunk[..size]);
        if let Some(output) = output.as_mut() {
            output.write_all(&chunk[..size])?;
        }
    }
    let after = file.metadata()?;
    let current = directory.symlink_metadata(name)?;
    if bytes != expected.bytes
        || id(&current) != expected.id
        || !current.is_file()
        || id(&after) != expected.id
        || after.len() != before.len()
        || after.modified().ok() != before.modified().ok()
        || file_mode(&after) != expected.mode
    {
        return Err(stale());
    }
    *remaining -= bytes;
    Ok(format!("{:x}", hash.finalize()))
}

impl Service {
    fn export_owner(&self, owner: &str) -> Result<()> {
        if !owner.starts_with("native:main:") {
            return Err(Error::new(
                "scope",
                "Saved-project export requires the native desktop window.",
            ));
        }
        self.assert_editor_owner(owner)
    }
    fn reap_exports(state: &mut ExportState, owner: &str) {
        state
            .tickets
            .retain(|_, ticket| ticket.owner == owner && ticket.expires > now());
        for request in state
            .requests
            .values_mut()
            .filter(|request| request.owner != owner && request.archive.is_some())
        {
            request.archive = None;
            request.receipt["status"] = json!("failed");
            request.receipt["error"] = json!(Error::new(
                "stale_session",
                "The desktop page was retired before export completed."
            ));
        }
    }
    pub async fn prepare_native_project_export(
        self: &Arc<Self>,
        owner: &str,
        project: &str,
    ) -> Result<Value> {
        self.export_owner(owner)?;
        let approved = self.project(project)?;
        let export_id = Uuid::new_v4().to_string();
        {
            let mut state = lock(&self.project_export)?;
            Self::reap_exports(&mut state, owner);
            if state.tickets.len()
                + state
                    .requests
                    .values()
                    .filter(|request| request.receipt["status"] == "pending")
                    .count()
                >= 2
            {
                return Err(Error::new(
                    "busy",
                    "Finish or cancel an existing project export first.",
                ));
            }
            state.tickets.insert(
                export_id.clone(),
                Ticket {
                    owner: owner.into(),
                    expires: now() + LEASE_MS,
                    archive: None,
                },
            );
        }
        let service = self.clone();
        let owner = owner.to_owned();
        tokio::task::spawn_blocking(move || {
            let result = service.capture_project_export(&approved, &export_id);
            let editors = lock(&service.editor)?;
            let authority = editors.check_import_owner(&owner);
            let mut state = lock(&service.project_export)?;
            if let Err(error) = authority {
                state.tickets.remove(&export_id);
                return Err(error);
            }
            match result {
                Ok(archive) => {
                    let ticket = state.tickets.get_mut(&export_id).ok_or_else(expired)?;
                    if ticket.owner != owner || ticket.expires <= now() {
                        state.tickets.remove(&export_id);
                        return Err(expired());
                    }
                    ticket.expires = archive.info["expiresAt"].as_u64().unwrap();
                    let result = archive.info.clone();
                    ticket.archive = Some(archive);
                    Ok(result)
                }
                Err(error) => {
                    state.tickets.remove(&export_id);
                    Err(error)
                }
            }
        })
        .await
        .map_err(|_| {
            Error::new(
                "outcome_unknown",
                "Project archive preparation stopped; no destination file was written.",
            )
        })?
    }

    fn capture_project_export(&self, project: &Project, export_id: &str) -> Result<Archive> {
        let _worker = self
            .export_capture
            .try_lock()
            .map_err(|_| Error::new("busy", "Another saved project is being captured."))?;
        let root = project_tree::open_root(&project.root)?;
        let root_id = id(&root.dir_metadata()?);
        let private = self.state.canonicalize()?;
        if project.root.starts_with(&private) {
            return Err(Error::new(
                "scope",
                "Application state cannot be exported as a source project.",
            ));
        }
        let mut inventory = Inventory::new();
        inventory.walk(&root, &root, "", 0, &project.root, &private)?;
        let directory = tempfile::Builder::new()
            .prefix(".undertree-export-")
            .tempdir_in(&private)?;
        let file = fs::OpenOptions::new()
            .read(true)
            .write(true)
            .create_new(true)
            .open(directory.path().join("project.zip"))?;
        let mut writer = ZipWriter::new(file);
        let file_options = SimpleFileOptions::default()
            .compression_method(CompressionMethod::Stored)
            .unix_permissions(0o644);
        let mut remaining = MAX_INPUT;
        let mut manifest = Vec::new();
        let mut hashes = BTreeMap::new();
        for (path, observation) in &inventory.entries {
            if observation.directory {
                writer
                    .add_directory(
                        format!("{path}/"),
                        file_options.unix_permissions(observation.mode),
                    )
                    .map_err(zip_error)?;
                manifest.push(json!({"path":path,"kind":"directory","mode":observation.mode}));
            } else {
                writer
                    .start_file(path, file_options.unix_permissions(observation.mode))
                    .map_err(zip_error)?;
                let hash = read_entry(&root, path, observation, &mut remaining, Some(&mut writer))?;
                manifest.push(json!({"path":path,"kind":"file","bytes":observation.bytes,"sha256":hash,"mode":observation.mode}));
                hashes.insert(path.clone(), hash);
            }
        }
        let manifest = serde_json::to_vec(&manifest)?;
        if manifest.len() > MAX_METADATA {
            return Err(Error::new(
                "limit",
                "The saved-project manifest exceeds 4 MiB.",
            ));
        }
        let snapshot_id = format!("{:x}", Sha256::digest(&manifest));
        let main = if project.main_document.is_empty() {
            Value::Null
        } else {
            json!(project.main_document)
        };
        if let Some(main) = main.as_str() {
            export_path(main)?;
            if !inventory
                .entries
                .get(main)
                .is_some_and(|entry| !entry.directory)
            {
                return Err(Error::new(
                    "path",
                    "The saved main document is unavailable in this export.",
                ));
            }
        }
        let comment = serde_json::to_string(
            &json!({"schema":1,"kind":"undertree-saved-project","mainDocument":main,"snapshotId":snapshot_id}),
        )?;
        if comment.len() > 8192 {
            return Err(Error::new(
                "limit",
                "The project export comment exceeds 8 KiB.",
            ));
        }
        writer.set_comment(comment).map_err(zip_error)?;
        let mut archive = writer.finish().map_err(zip_error)?;
        archive.sync_all()?;
        let size = archive.metadata()?.len();
        if size > MAX_ZIP {
            return Err(Error::new(
                "limit",
                "The ZIP exceeds its 144 MiB output limit.",
            ));
        }
        #[cfg(test)]
        if let Some(hook) = lock(&self.project_export)?.before_verify.take() {
            hook();
        }
        let mut after = Inventory::new();
        after.walk(&root, &root, "", 0, &project.root, &private)?;
        if inventory.entries != after.entries
            || inventory.exclusions != after.exclusions
            || project_tree::root_identity(&project.root)? != root_id
        {
            return Err(stale());
        }
        let mut remaining = MAX_INPUT;
        for (path, hash) in &hashes {
            if read_entry(&root, path, &inventory.entries[path], &mut remaining, None)? != *hash {
                return Err(stale());
            }
        }
        self.checked_root(project)?;
        if project_tree::root_identity(&project.root)? != root_id {
            return Err(stale());
        }
        use std::io::{Seek, SeekFrom};
        archive.seek(SeekFrom::Start(0))?;
        let sha = hash_stream(&mut archive, MAX_ZIP, None)?.0;
        let name = format!(
            "{}-saved-{}.zip",
            safe_name(&project.name),
            &snapshot_id[..12]
        );
        let info = json!({"exportId":export_id,"project":project.id,"snapshotId":snapshot_id,"sha256":sha,"bytes":size,"entries":inventory.entries.len(),
            "fileCount":hashes.len(),"directoryCount":inventory.entries.len()-hashes.len(),"mainDocument":main,"policy":"saved-only",
            "exclusions":inventory.exclusions,"expiresAt":now()+LEASE_MS,"fileName":name});
        Ok(Archive {
            directory,
            info,
            root: project.root.clone(),
            root_id,
        })
    }

    pub fn begin_native_project_export(
        &self,
        owner: &str,
        export_id: &str,
        request_id: &str,
    ) -> Result<Value> {
        validate_request_id(request_id)?;
        if !owner.starts_with("native:main:") {
            return Err(Error::new(
                "scope",
                "Project export requires the native desktop.",
            ));
        }
        let editors = lock(&self.editor)?;
        editors.check_import_owner(owner)?;
        let mut state = lock(&self.project_export)?;
        Self::reap_exports(&mut state, owner);
        if let Some(request) = state.requests.get(request_id) {
            if request.owner != owner || request.export_id != export_id {
                return Err(Error::new(
                    "scope",
                    "This requestId is already bound to another export.",
                ));
            }
            return Ok(json!({"started":false,"receipt":request.receipt}));
        }
        let ticket = state.tickets.get(export_id).ok_or_else(expired)?;
        if ticket.owner != owner {
            return Err(Error::new(
                "scope",
                "This archive belongs to another desktop page.",
            ));
        }
        if ticket.archive.is_none() {
            return Err(Error::new("busy", "Archive preparation has not finished."));
        }
        if state.requests.len() >= MAX_RECEIPTS {
            let index = state.history.iter().position(|key| {
                state
                    .requests
                    .get(key)
                    .is_some_and(|request| request.receipt["status"] != "pending")
            });
            let Some(index) = index else {
                return Err(Error::new("busy", "Too many exports are pending."));
            };
            if let Some(key) = state.history.remove(index) {
                state.requests.remove(&key);
            }
        }
        let archive = state.tickets.remove(export_id).unwrap().archive.unwrap();
        let mut receipt = archive.info.clone();
        receipt.as_object_mut().unwrap().remove("exclusions");
        receipt["requestId"] = json!(request_id);
        receipt["status"] = json!("pending");
        state.requests.insert(
            request_id.into(),
            Request {
                owner: owner.into(),
                export_id: export_id.into(),
                receipt: receipt.clone(),
                archive: Some(archive),
                writing: false,
            },
        );
        state.history.push_back(request_id.into());
        Ok(json!({"started":true,"receipt":receipt}))
    }

    pub async fn finish_native_project_export(
        self: &Arc<Self>,
        owner: &str,
        request_id: &str,
        destination: Option<PathBuf>,
    ) -> Result<Value> {
        validate_request_id(request_id)?;
        let archive = {
            let mut state = lock(&self.project_export)?;
            let request = state.requests.get_mut(request_id).ok_or_else(expired)?;
            if request.owner != owner {
                return Err(Error::new(
                    "scope",
                    "This export belongs to another desktop page.",
                ));
            }
            if request.writing || request.receipt["status"] != "pending" {
                return Ok(request.receipt.clone());
            }
            request.writing = true;
            request.archive.take().ok_or_else(expired)?
        };
        let service = self.clone();
        let owner = owner.to_owned();
        let request_id = request_id.to_owned();
        tokio::task::spawn_blocking(move || {
            let result=service.export_owner(&owner).and_then(|()| match destination {Some(path)=>service.write_project_export(&owner,&archive,&path).map(|name|("exported",Some(name))),None=>Ok(("cancelled",None))});
            let mut state=lock(&service.project_export)?;let request=state.requests.get_mut(&request_id).ok_or_else(expired)?;
            request.writing=false;
            match result {Ok((status,name))=>{request.receipt["status"]=json!(status);if let Some(name)=name{request.receipt["destinationName"]=json!(name);}},Err(error)=>{request.receipt["status"]=json!(if error.code=="outcome_unknown"{"outcome_unknown"}else{"failed"});request.receipt["error"]=json!(error);}}
            Ok(request.receipt.clone())
        }).await.map_err(|_|Error::new("outcome_unknown","The export acknowledgement was lost. Check the existing request; do not retry its write."))?
    }

    fn write_project_export(
        &self,
        owner: &str,
        archive: &Archive,
        destination: &Path,
    ) -> Result<String> {
        if !destination.is_absolute() {
            return Err(Error::new(
                "path",
                "Choose an absolute destination through the native Save dialog.",
            ));
        }
        let parent_path = destination.parent().ok_or_else(stale)?;
        let name = destination.file_name().ok_or_else(stale)?;
        let destination_name = name
            .to_str()
            .ok_or_else(|| Error::new("path", "Choose a Unicode export filename."))?
            .to_owned();
        export_path(&destination_name)?;
        if destination.starts_with(&archive.root)
            || destination.starts_with(self.state.canonicalize()?)
        {
            return Err(Error::new(
                "path",
                "Save the ZIP outside the source project and application state.",
            ));
        }
        let parent = project_tree::open_root(parent_path)?;
        let parent_id = id(&parent.dir_metadata()?);
        match parent.symlink_metadata(name) {
            Ok(_) => {
                return Err(Error::new(
                    "conflict",
                    "The export destination already exists. Choose a new filename.",
                ))
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => (),
            Err(error) => return Err(error.into()),
        }
        self.check_export_root(archive)?;
        let temporary = format!(".undertree-export-{}.tmp", Uuid::new_v4());
        let mut options = OpenOptions::new();
        options
            .write(true)
            .read(true)
            .create_new(true)
            .follow(FollowSymlinks::No);
        let mut output = parent.open_with(&temporary, &options)?;
        let output_id = id(&output.metadata()?);
        #[cfg(unix)]
        {
            use cap_std::fs::PermissionsExt;
            output.set_permissions(cap_std::fs::Permissions::from_mode(0o600))?;
        }
        let result = (|| -> Result<()> {
            let mut input = fs::File::open(archive.directory.path().join("project.zip"))?;
            let (hash, bytes) = hash_stream(&mut input, MAX_ZIP, Some(&mut output))?;
            if json!(hash) != archive.info["sha256"] || json!(bytes) != archive.info["bytes"] {
                return Err(stale());
            }
            output.sync_all()?;
            #[cfg(test)]
            if let Some(hook) = lock(&self.project_export)?.before_publish.take() {
                hook();
            }
            self.export_owner(owner)?;
            use std::io::{Seek, SeekFrom};
            output.seek(SeekFrom::Start(0))?;
            let (written_hash, written_bytes) = hash_stream(&mut output, MAX_ZIP, None)?;
            if json!(written_hash) != archive.info["sha256"]
                || json!(written_bytes) != archive.info["bytes"]
            {
                return Err(stale());
            }
            let editors = lock(&self.editor)?;
            editors.check_import_owner(owner)?;
            self.check_export_root(archive)?;
            if id(&project_tree::open_root(parent_path)?.dir_metadata()?) != parent_id {
                return Err(stale());
            }
            parent.hard_link(&temporary,&parent,name).map_err(|error|if error.kind()==std::io::ErrorKind::AlreadyExists{Error::new("conflict","A destination appeared while exporting. Existing bytes were preserved.")}else{error.into()})?;
            let durable = (|| -> Result<()> {
                #[cfg(unix)]
                parent.open(".")?.sync_all()?;
                if id(&project_tree::open_root(parent_path)?.dir_metadata()?) != parent_id
                    || id(&parent.symlink_metadata(name)?) != output_id
                {
                    return Err(stale());
                }
                Ok(())
            })();
            durable.map_err(|_|Error::new("outcome_unknown","The ZIP was created, but its location or durability could not be confirmed. Inspect the chosen destination before retrying."))
        })();
        if parent
            .symlink_metadata(&temporary)
            .is_ok_and(|metadata| id(&metadata) == output_id)
        {
            if parent.remove_file(&temporary).is_err() {
                return Err(Error::new("outcome_unknown","Export temporary-file cleanup was not confirmed. Inspect the chosen folder before retrying."));
            }
        } else {
            return Err(Error::new(
                "outcome_unknown",
                "The export temporary file changed unexpectedly. Inspect the chosen folder.",
            ));
        }
        result.map(|()| destination_name)
    }

    fn check_export_root(&self, archive: &Archive) -> Result<()> {
        let project = self.project(archive.info["project"].as_str().ok_or_else(stale)?)?;
        if project.root != archive.root
            || project_tree::root_identity(&archive.root)? != archive.root_id
        {
            return Err(stale());
        }
        Ok(())
    }

    pub async fn export_as(
        self: &Arc<Self>,
        caller: CallerContext,
        owner: &str,
        operation: ExportOperation,
    ) -> Result<Value> {
        if caller != CallerContext::Local {
            return Err(Error::new(
                "scope",
                "Saved-project export is native UI only.",
            ));
        }
        self.export_owner(owner)?;
        let mut state = lock(&self.project_export)?;
        match operation {
            ExportOperation::ExportStatus { request_id } => {
                validate_request_id(&request_id)?;
                match state.requests.get(&request_id) {
                    Some(request) if request.owner == owner => Ok(request.receipt.clone()),
                    Some(_) => Err(Error::new(
                        "scope",
                        "This receipt belongs to another native page.",
                    )),
                    None => Ok(json!({"requestId":request_id,"status":"unknown"})),
                }
            }
            ExportOperation::ExportCancel { export_id } => {
                if state
                    .requests
                    .values()
                    .any(|request| request.export_id == export_id)
                {
                    return Err(Error::new(
                        "busy",
                        "This export has already started. Check its existing request.",
                    ));
                }
                if state
                    .tickets
                    .get(&export_id)
                    .is_some_and(|ticket| ticket.owner != owner)
                {
                    return Err(Error::new(
                        "scope",
                        "This export belongs to another native page.",
                    ));
                }
                state.tickets.remove(&export_id);
                Ok(json!({"exportId":export_id,"cancelled":true}))
            }
        }
    }
}

fn safe_name(value: &str) -> String {
    let name: String = value
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_'))
        .take(80)
        .collect();
    if name.is_empty() {
        "project".into()
    } else {
        name
    }
}
fn hash_stream(
    input: &mut impl Read,
    maximum: u64,
    mut output: Option<&mut dyn Write>,
) -> Result<(String, u64)> {
    let mut hasher = Sha256::new();
    let mut total = 0;
    let mut chunk = [0u8; 64 * 1024];
    loop {
        let size = input.read(&mut chunk)?;
        if size == 0 {
            break;
        }
        total += size as u64;
        if total > maximum {
            return Err(Error::new(
                "limit",
                "The export archive exceeds its byte limit.",
            ));
        }
        hasher.update(&chunk[..size]);
        if let Some(output) = output.as_mut() {
            output.write_all(&chunk[..size])?;
        }
    }
    Ok((format!("{:x}", hasher.finalize()), total))
}

#[cfg(test)]
mod tests;
