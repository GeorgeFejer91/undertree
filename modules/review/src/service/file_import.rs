//! Native-picker imports. No file paths or byte payloads are accepted over an application API.
use super::*;
use cap_fs_ext::{DirExt, FollowSymlinks, MetadataExt, OpenOptionsFollowExt, OpenOptionsSyncExt};
use cap_std::fs::{Dir, OpenOptions};
use sha2::{Digest, Sha256};
use std::time::{SystemTime, UNIX_EPOCH};

const MAX_FILES: usize = 32;
const MAX_ASSET: usize = 16 * 1024 * 1024;
const MAX_TOTAL: usize = 32 * 1024 * 1024;
const MAX_SELECTIONS: usize = 2;
const MAX_RECEIPTS: usize = 64;
const LEASE_MS: u64 = 5 * 60 * 1000;

#[derive(Debug, Deserialize)]
#[serde(
    tag = "action",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum ImportOperation {
    ImportFiles {
        selection_id: String,
        request_id: String,
    },
    ImportStatus {
        request_id: String,
    },
    ImportCancel {
        selection_id: String,
    },
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Input {
    file_id: String,
    name: String,
    kind: &'static str,
    editable: bool,
    bytes: usize,
    sha256: String,
}

struct Selection {
    owner: String,
    project: Project,
    parent_path: String,
    root: Dir,
    parent: Dir,
    root_id: (u64, u64),
    parent_id: (u64, u64),
    expires_at: u64,
    staging: bool,
    staged: Option<(tempfile::TempDir, Vec<Input>)>,
}

struct Receipt {
    owner: String,
    selection: String,
    result: Value,
}

#[derive(Default)]
pub(super) struct ImportState {
    selections: BTreeMap<String, Selection>,
    receipts: BTreeMap<String, Receipt>,
    history: std::collections::VecDeque<String>,
    #[cfg(test)]
    before_begin_commit: Option<Box<dyn FnOnce() + Send>>,
    #[cfg(test)]
    after_publish: Option<Box<dyn FnOnce() + Send>>,
}

fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn identity(metadata: &cap_std::fs::Metadata) -> (u64, u64) {
    (metadata.dev(), metadata.ino())
}

fn changed() -> Error {
    Error::new(
        "path",
        "The import destination changed. Choose the project and folder again.",
    )
}

fn expired() -> Error {
    Error::new("expired_ticket", "The staged import expired or was consumed. Inspect the project before choosing files again.")
}

fn check_request(id: &str) -> Result<()> {
    if id.len() != 36 || Uuid::parse_str(id).is_err() {
        return Err(Error::new("format", "Use a UUID requestId for an import."));
    }
    Ok(())
}

fn options() -> OpenOptions {
    let mut options = OpenOptions::new();
    options.read(true).follow(FollowSymlinks::No).nonblock(true);
    options
}

fn relative(parent: &str, name: &str) -> String {
    if parent.is_empty() {
        name.into()
    } else {
        format!("{parent}/{name}")
    }
}

fn hash(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn preflight(selection: &Selection, inputs: &[Input], published: bool) -> Result<()> {
    for input in inputs {
        for suffix in [
            "",
            ".undertree-review.json",
            ".undertree-pending.json",
            ".import-report.json",
        ] {
            if published
                && (suffix.is_empty() || (input.editable && suffix == ".undertree-review.json"))
            {
                continue;
            }
            match selection.parent.symlink_metadata(format!("{}{suffix}",input.name)) {
                Ok(_) => return Err(Error::new("conflict", "A destination or its adjacent metadata already exists. Existing files were preserved.")),
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => (),
                Err(error) => return Err(error.into()),
            }
        }
    }
    Ok(())
}

fn read_regular(
    directory: &Dir,
    name: &str,
    maximum: usize,
) -> Result<(Vec<u8>, cap_std::fs::Metadata)> {
    let mut file = directory.open_with(name, &options())?;
    let before = file.metadata()?;
    if !before.is_file() {
        return Err(Error::new(
            "path",
            "Select ordinary files without symbolic links.",
        ));
    }
    let mut bytes = Vec::new();
    (&mut file)
        .take(maximum as u64 + 1)
        .read_to_end(&mut bytes)?;
    if bytes.len() > maximum {
        return Err(Error::new(
            "limit",
            "An import exceeds its supported file or batch size.",
        ));
    }
    let after = file.metadata()?;
    let current = directory.symlink_metadata(name)?;
    if identity(&before) != identity(&after)
        || identity(&after) != identity(&current)
        || !current.is_file()
        || before.len() != after.len()
        || after.len() != bytes.len() as u64
        || before.modified().ok() != after.modified().ok()
    {
        return Err(Error::new(
            "stale",
            "A selected file changed while it was being captured. Choose it again.",
        ));
    }
    Ok((bytes, after))
}

impl Service {
    fn import_owner(&self, owner: &str) -> Result<()> {
        if !owner.starts_with("native:main:") {
            return Err(Error::new(
                "scope",
                "File import requires the local desktop window.",
            ));
        }
        self.assert_editor_owner(owner)
    }

    fn check_import_destination(&self, selection: &Selection) -> Result<()> {
        let current = self.project(&selection.project.id)?;
        if current.root != selection.project.root {
            return Err(changed());
        }
        self.check_import_location(selection)
    }

    fn check_import_location(&self, selection: &Selection) -> Result<()> {
        self.checked_root(&selection.project)?;
        if project_tree::root_identity(&selection.project.root)? != selection.root_id
            || identity(&selection.root.dir_metadata()?) != selection.root_id
            || identity(&selection.parent.dir_metadata()?) != selection.parent_id
            || identity(
                &project_tree::open_directory(&selection.root, &selection.parent_path)?
                    .dir_metadata()?,
            ) != selection.parent_id
        {
            return Err(changed());
        }
        Ok(())
    }

    /// Called before opening the platform picker; paths cannot be retargeted afterward.
    pub fn begin_native_import(&self, owner: &str, project: &str, parent: &str) -> Result<Value> {
        self.import_owner(owner)?;
        if !parent.is_empty() {
            project_tree::directory_path(parent)?;
        }
        let approved = self.project(project)?;
        let root = project_tree::open_root(&approved.root)?;
        let directory = project_tree::open_directory(&root, parent)?;
        let root_id = identity(&root.dir_metadata()?);
        let parent_id = identity(&directory.dir_metadata()?);
        let selection = Selection {
            owner: owner.into(),
            project: approved,
            parent_path: parent.into(),
            root,
            parent: directory,
            root_id,
            parent_id,
            expires_at: now() + LEASE_MS,
            staging: false,
            staged: None,
        };
        self.check_import_destination(&selection)?;
        #[cfg(test)]
        {
            let hook = lock(&self.file_import)?.before_begin_commit.take();
            if let Some(hook) = hook {
                hook();
            }
        }
        let editors = lock(&self.editor)?;
        editors.check_import_owner(owner)?;
        let mut imports = lock(&self.file_import)?;
        imports.selections.retain(|_, selection| {
            selection.owner == owner && (selection.staging || selection.expires_at > now())
        });
        if imports.selections.len() >= MAX_SELECTIONS {
            return Err(Error::new(
                "busy",
                "Finish or cancel an existing import before choosing more files.",
            ));
        }
        let id = Uuid::new_v4().to_string();
        imports.selections.insert(id.clone(), selection);
        Ok(json!({"selectionId":id}))
    }

    /// Only the native adapter passes picker paths; no application DTO contains a source path.
    pub async fn stage_native_import(
        self: &Arc<Self>,
        owner: &str,
        selection_id: &str,
        paths: Vec<PathBuf>,
    ) -> Result<Value> {
        self.import_owner(owner)?;
        if paths.is_empty() || paths.len() > MAX_FILES {
            let mut imports = lock(&self.file_import)?;
            if imports
                .selections
                .get(selection_id)
                .is_some_and(|selection| selection.owner == owner && !selection.staging)
            {
                imports.selections.remove(selection_id);
            }
            return Err(Error::new("limit", "Choose between 1 and 32 files."));
        }
        {
            let mut imports = lock(&self.file_import)?;
            let selection = imports
                .selections
                .get_mut(selection_id)
                .ok_or_else(expired)?;
            if selection.owner != owner {
                return Err(Error::new(
                    "scope",
                    "This import belongs to another desktop page.",
                ));
            }
            if selection.expires_at <= now() {
                return Err(expired());
            }
            if selection.staging || selection.staged.is_some() {
                return Err(Error::new(
                    "busy",
                    "This selection has already been staged.",
                ));
            }
            self.check_import_destination(selection)?;
            selection.staging = true;
        }
        let service = self.clone();
        let owner = owner.to_owned();
        let id = selection_id.to_owned();
        tokio::task::spawn_blocking(move || {
            let result = service.capture_import(&paths);
            service.finish_import_staging(&owner, &id, result)
        })
        .await
        .map_err(|_| {
            Error::new(
                "outcome_unknown",
                "File staging stopped. Cancel this selection before choosing again.",
            )
        })?
    }

    fn finish_import_staging(
        &self,
        owner: &str,
        id: &str,
        result: Result<(tempfile::TempDir, Vec<Input>)>,
    ) -> Result<Value> {
        if let Err(error) = self.import_owner(owner) {
            lock(&self.file_import)?.selections.remove(id);
            return Err(error);
        }
        let mut imports = lock(&self.file_import)?;
        let selection = imports.selections.get_mut(id).ok_or_else(expired)?;
        if selection.owner != owner || selection.expires_at <= now() {
            imports.selections.remove(id);
            return Err(expired());
        }
        match result {
            Ok((directory, files)) => {
                let validate = || -> Result<()> {
                    self.check_import_destination(selection)?;
                    for file in &files {
                        project_tree::directory_path(&relative(
                            &selection.parent_path,
                            &file.name,
                        ))?;
                    }
                    Ok(())
                };
                if let Err(error) = validate() {
                    imports.selections.remove(id);
                    return Err(error);
                }
                let value = json!({"selectionId":id,"project":selection.project.id,"parent":selection.parent_path,
                        "files":files,"expiresAt":selection.expires_at});
                selection.staging = false;
                selection.staged = Some((directory, files));
                Ok(value)
            }
            Err(error) => {
                imports.selections.remove(id);
                Err(error)
            }
        }
    }

    fn capture_import(&self, paths: &[PathBuf]) -> Result<(tempfile::TempDir, Vec<Input>)> {
        let _worker = self
            .import_capture
            .try_lock()
            .map_err(|_| Error::new("busy", "Another native file selection is being captured."))?;
        let directory = tempfile::Builder::new()
            .prefix(".undertree-import-")
            .tempdir_in(&self.state)?;
        let mut inputs = Vec::new();
        let mut names = BTreeSet::new();
        let mut total = 0;
        for path in paths {
            if !path.is_absolute() {
                return Err(Error::new(
                    "path",
                    "Choose local files through the native picker.",
                ));
            }
            let name = path
                .file_name()
                .and_then(|name| name.to_str())
                .ok_or_else(|| Error::new("path", "Imported filenames must be Unicode."))?;
            project_tree::directory_path(name)?;
            if name.len() + ".undertree-review.json".len() > 255 {
                return Err(Error::new(
                    "path",
                    "Use a shorter filename so its review metadata also fits.",
                ));
            }
            if !names.insert(name.to_lowercase()) {
                return Err(Error::new(
                    "conflict",
                    "Selected filenames collide. Choose distinct names before importing.",
                ));
            }
            let parent = project_tree::open_root(path.parent().ok_or_else(changed)?)?;
            let editable = editable_source(Path::new(name));
            let (bytes, _) =
                read_regular(&parent, name, if editable { MAX_TEXT } else { MAX_ASSET })?;
            if editable {
                std::str::from_utf8(&bytes).map_err(|_| {
                    Error::new(
                        "source",
                        "An editable source must contain valid UTF-8 text.",
                    )
                })?;
            }
            total += bytes.len();
            if editable {
                total +=
                    serde_json::to_vec_pretty(&Review::new(std::str::from_utf8(&bytes).unwrap()))?
                        .len();
            }
            if total > MAX_TOTAL {
                return Err(Error::new(
                    "limit",
                    "The complete import including review data exceeds 32 MiB.",
                ));
            }
            let id = Uuid::new_v4().to_string();
            let mut file = fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(directory.path().join(&id))?;
            file.write_all(&bytes)?;
            file.sync_all()?;
            inputs.push(Input {
                file_id: id,
                name: name.into(),
                kind: if editable { "source" } else { "asset" },
                editable,
                bytes: bytes.len(),
                sha256: hash(&bytes),
            });
        }
        Ok((directory, inputs))
    }

    pub async fn import_as(
        self: &Arc<Self>,
        caller: CallerContext,
        owner: &str,
        operation: ImportOperation,
    ) -> Result<Value> {
        if caller != CallerContext::Local {
            return Err(Error::new(
                "scope",
                "File import is available only to the local desktop UI.",
            ));
        }
        self.import_owner(owner)?;
        let service = self.clone();
        let owner = owner.to_owned();
        tokio::task::spawn_blocking(move || service.import_local(&owner,operation)).await
            .map_err(|_| Error::new("outcome_unknown", "The import response was lost. Check its request status before taking further action."))?
    }

    fn import_local(&self, owner: &str, operation: ImportOperation) -> Result<Value> {
        self.import_owner(owner)?;
        match operation {
            ImportOperation::ImportStatus { request_id } => {
                check_request(&request_id)?;
                let imports = lock(&self.file_import)?;
                match imports.receipts.get(&request_id) {
                    Some(receipt) if receipt.owner == owner => Ok(receipt.result.clone()),
                    Some(_) => Err(Error::new(
                        "scope",
                        "This import receipt belongs to another desktop page.",
                    )),
                    None => Ok(json!({"requestId":request_id,"status":"unknown"})),
                }
            }
            ImportOperation::ImportCancel { selection_id } => {
                let mut imports = lock(&self.file_import)?;
                if imports
                    .receipts
                    .values()
                    .any(|receipt| receipt.selection == selection_id)
                {
                    return Err(Error::new(
                        "busy",
                        "This import has already started; check its receipt instead of cancelling.",
                    ));
                }
                if imports
                    .selections
                    .get(&selection_id)
                    .is_some_and(|selection| selection.owner != owner)
                {
                    return Err(Error::new(
                        "scope",
                        "This selection belongs to another desktop page.",
                    ));
                }
                imports.selections.remove(&selection_id);
                Ok(json!({"selectionId":selection_id,"cancelled":true}))
            }
            ImportOperation::ImportFiles {
                selection_id,
                request_id,
            } => {
                check_request(&request_id)?;
                let selection = {
                    let mut imports = lock(&self.file_import)?;
                    if let Some(receipt) = imports.receipts.get(&request_id) {
                        if receipt.owner != owner || receipt.selection != selection_id {
                            return Err(Error::new(
                                "scope",
                                "This requestId is already bound to a different import.",
                            ));
                        }
                        return Ok(receipt.result.clone());
                    }
                    let selection = imports.selections.get(&selection_id).ok_or_else(expired)?;
                    if selection.owner != owner {
                        return Err(Error::new(
                            "scope",
                            "This import belongs to another desktop page.",
                        ));
                    }
                    if selection.expires_at <= now() {
                        return Err(expired());
                    }
                    if selection.staging || selection.staged.is_none() {
                        return Err(Error::new(
                            "busy",
                            "Finish staging the selected files before importing.",
                        ));
                    }
                    if imports.receipts.len() >= MAX_RECEIPTS {
                        let oldest = imports.history.iter().position(|id| {
                            imports
                                .receipts
                                .get(id)
                                .is_some_and(|r| r.result["status"] != "pending")
                        });
                        let Some(index) = oldest else {
                            return Err(Error::new(
                                "busy",
                                "Too many import operations are running.",
                            ));
                        };
                        if let Some(id) = imports.history.remove(index) {
                            imports.receipts.remove(&id);
                        }
                    }
                    let selection = imports.selections.remove(&selection_id).unwrap();
                    imports.receipts.insert(request_id.clone(),Receipt {owner:owner.into(),selection:selection_id,
                        result:json!({"requestId":request_id,"status":"pending","project":selection.project.id,"parent":selection.parent_path})});
                    imports.history.push_back(request_id.clone());
                    selection
                };
                let paths: Vec<_> = selection
                    .staged
                    .as_ref()
                    .unwrap()
                    .1
                    .iter()
                    .map(|file| relative(&selection.parent_path, &file.name))
                    .collect();
                let result = (|| {
                    let mut editors = lock(&self.editor)?;
                    editors.reserve_import(owner, &selection.project.id, &paths)?;
                    let documents = self.documents.try_lock();
                    if documents.is_err() {
                        editors.release_import(&selection.project.id, &paths);
                        return Err(Error::new(
                            "busy",
                            "Another document operation is running. No files were imported.",
                        ));
                    }
                    drop(editors);
                    let result = self.commit_import(&selection, &request_id);
                    lock(&self.editor)?.release_import(&selection.project.id, &paths);
                    drop(documents);
                    result
                })();
                let value = match result {
                    Ok(value) => value,
                    Err(error) => {
                        json!({"requestId":request_id,"status":if error.code == "outcome_unknown" {"outcome_unknown"} else {"failed"},
                        "project":selection.project.id,"parent":selection.parent_path,"error":error})
                    }
                };
                lock(&self.file_import)?
                    .receipts
                    .get_mut(&request_id)
                    .unwrap()
                    .result = value.clone();
                Ok(value)
            }
        }
    }

    fn commit_import(&self, selection: &Selection, request_id: &str) -> Result<Value> {
        self.check_import_destination(selection)?;
        let (staged, inputs) = selection.staged.as_ref().ok_or_else(expired)?;
        let input_dir = Dir::open_ambient_dir(staged.path(), cap_std::ambient_authority())?;
        preflight(selection, inputs, false)?;
        let policy_paths: Vec<_> = inputs
            .iter()
            .filter(|input| input.editable)
            .map(|input| {
                selection
                    .project
                    .root
                    .join(relative(&selection.parent_path, &input.name))
            })
            .collect();
        self.policy_capacity(&policy_paths)?;
        for path in &policy_paths {
            self.check_policy_continuity(path, self.raw_review(path)?.as_deref())?;
        }
        let temporary = format!(".undertree-build-import-{}", Uuid::new_v4());
        selection.parent.create_dir(&temporary)?;
        let output_dir = selection.parent.open_dir_nofollow(&temporary)?;
        let output_id = identity(&output_dir.dir_metadata()?);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            output_dir
                .open(".")?
                .into_std()
                .set_permissions(fs::Permissions::from_mode(0o700))?;
        }
        let mut outputs: Vec<(String, String, (u64, u64))> = Vec::new();
        let mut created = Vec::new();
        let mut accepted_policies = Vec::new();
        let result = (|| -> Result<Value> {
            let mut total = 0;
            for input in inputs {
                let (bytes, _) = read_regular(
                    &input_dir,
                    &input.file_id,
                    if input.editable { MAX_TEXT } else { MAX_ASSET },
                )?;
                if bytes.len() != input.bytes || hash(&bytes) != input.sha256 {
                    return Err(Error::new(
                        "stale",
                        "The staged import changed. Choose the files again.",
                    ));
                }
                let mut values = vec![(input.name.clone(), bytes)];
                if input.editable {
                    let text = std::str::from_utf8(&values[0].1)
                        .map_err(|_| Error::new("source", "The staged source is not UTF-8."))?;
                    let review = serde_json::to_string_pretty(&Review::new(text))?;
                    accepted_policies.push((
                        selection
                            .project
                            .root
                            .join(relative(&selection.parent_path, &input.name)),
                        review.clone(),
                    ));
                    values.push((
                        format!("{}.undertree-review.json", input.name),
                        review.into_bytes(),
                    ));
                }
                for (name, bytes) in values {
                    total += bytes.len();
                    if total > MAX_TOTAL {
                        return Err(Error::new("limit", "The complete import exceeds 32 MiB."));
                    }
                    let mut options = OpenOptions::new();
                    options
                        .write(true)
                        .create_new(true)
                        .follow(FollowSymlinks::No);
                    let mut file = output_dir.open_with(&name, &options)?;
                    let revision = hash(&bytes);
                    outputs.push((name.clone(), revision.clone(), identity(&file.metadata()?)));
                    file.write_all(&bytes)?;
                    file.sync_all()?;
                }
            }
            // Native page retirement and new registrations cannot interleave with publication.
            // This follows editor callbacks' editor -> registry lock order. Bulk copying is done.
            #[cfg(test)]
            if let Some(hook) = lock(&self.import_before_publish)?.take() {
                hook();
            }
            let editors = lock(&self.editor)?;
            editors.check_import_owner(&selection.owner)?;
            if selection.expires_at <= now() {
                return Err(expired());
            }
            let mut registry = lock(&self.registry)?;
            let mut next = registry.clone();
            let registered = next
                .projects
                .iter_mut()
                .find(|project| project.id == selection.project.id)
                .ok_or_else(changed)?;
            let main = registered.main_document.clone();
            for (name, revision, _) in &outputs {
                let path = relative(&selection.parent_path, name);
                registered.pending.insert(path.clone());
                registered.pending_revisions.insert(path, revision.clone());
            }
            let expected_registry = serde_json::to_string_pretty(&next)?;
            if expected_registry.len() > MAX_TEXT {
                return Err(Error::new(
                    "limit",
                    "The project registry exceeds its supported size.",
                ));
            }
            self.check_import_location(selection)?;
            preflight(selection, inputs, false)?;
            for (name, _, id) in &outputs {
                output_dir.hard_link(name,&selection.parent,name).map_err(|error| {
                    if error.kind() == std::io::ErrorKind::AlreadyExists {Error::new("conflict", "A destination appeared during import. Existing files were preserved.")} else {error.into()}
                })?;
                created.push(name.clone());
                if identity(&selection.parent.symlink_metadata(name)?) != *id {
                    return Err(changed());
                }
            }
            #[cfg(test)]
            {
                let hook = lock(&self.file_import)?.after_publish.take();
                if let Some(hook) = hook {
                    hook();
                }
            }
            #[cfg(unix)]
            selection.parent.open(".")?.sync_all()?;
            self.check_import_location(selection)?;
            preflight(selection, inputs, true)?;
            if let Err(error) = self.save_registry(&next) {
                if read_text(&self.state.join("projects.json"), MAX_TEXT)
                    .is_ok_and(|text| text == expected_registry)
                {
                    *registry = next;
                    return Err(Error::new("outcome_unknown", "Imported files exist, but their durable creation could not be confirmed. Inspect the project before retrying."));
                }
                return Err(error);
            }
            *registry = next;
            for (path, raw) in &accepted_policies {
                self.observe_policy(path, Some(raw))?;
            }
            Ok(
                json!({"requestId":request_id,"status":"committed","project":selection.project.id,"parent":selection.parent_path,
                "files":inputs.iter().map(|file| json!({"path":relative(&selection.parent_path,&file.name),"kind":file.kind,
                    "editable":file.editable,"bytes":file.bytes,"sha256":file.sha256})).collect::<Vec<_>>(),"mainDocument":main,"gitOwnership":"undertree"}),
            )
        })();
        let result = match result {
            // A pathname can be replaced between checking its identity and unlinking it.
            Err(_) if !created.is_empty() => Err(Error::new("outcome_unknown", "Import could not be confirmed after files were published. Published files were preserved; inspect the destination and receipt before retrying.")),
            other => other,
        };
        let mut cleanup_failed = false;
        for (name, _, _) in &outputs {
            cleanup_failed |= output_dir.remove_file(name).is_err();
        }
        if selection
            .parent
            .symlink_metadata(&temporary)
            .is_ok_and(|metadata| identity(&metadata) == output_id)
        {
            cleanup_failed |= selection.parent.remove_dir(&temporary).is_err();
        } else {
            cleanup_failed = true;
        }
        if cleanup_failed {
            return Err(Error::new("outcome_unknown", "The import finished, but temporary-file cleanup could not be confirmed. Inspect the destination and receipt before retrying."));
        }
        result
    }

    /// Checkpoint only explicitly owned regular bytes, including binary imported assets.
    pub(super) fn owned_checkpoint_input(
        &self,
        project: &Project,
        relative: &str,
    ) -> Result<(Vec<u8>, fs::Permissions)> {
        let source = relative
            .strip_suffix(".undertree-review.json")
            .or_else(|| relative.strip_suffix(".import-report.json"))
            .unwrap_or(relative);
        project_tree::directory_path(source)?;
        let (parent, name) = relative.rsplit_once('/').unwrap_or(("", relative));
        let root = project_tree::open_root(&project.root)?;
        let root_id = identity(&root.dir_metadata()?);
        let directory = project_tree::open_directory(&root, parent)?;
        let directory_id = identity(&directory.dir_metadata()?);
        let (bytes, metadata) = read_regular(&directory, name, MAX_ASSET)?;
        let file = directory.open_with(name, &options())?;
        if identity(&file.metadata()?) != identity(&metadata) {
            return Err(changed());
        }
        let permissions = file.into_std().metadata()?.permissions();
        if project_tree::root_identity(&project.root)? != root_id
            || identity(&project_tree::open_directory(&root, parent)?.dir_metadata()?)
                != directory_id
        {
            return Err(changed());
        }
        Ok((bytes, permissions))
    }
}

#[cfg(test)]
mod tests;
