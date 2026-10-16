//! Native single-source relocation. Accepted intents only roll forward; queries never perform effects.
use super::source_files::{MoveBundle, MoveMember};
use super::*;
use std::time::{SystemTime, UNIX_EPOCH};
use tokio::sync::OwnedMutexGuard;

const MAX_RECORDS: usize = 64;
const MAX_ACTIVE: usize = 2;
const MAX_INTENT: usize = 64 * 1024;
const MAX_CONTROL: usize = 128 * 1024;
const CONTROL: &str = "control.json";
const INITIALIZED: &str = "initialized";
const LEASE: u64 = 5 * 60 * 1000;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MovePrepare {
    pub generation: String,
    pub request_id: String,
    pub project: String,
    pub from: String,
    pub to: String,
    pub source_epoch: u64,
    pub expected_root: RootObservation,
    pub revision: String,
    // Presence is mandatory: null denotes a captured absent sidecar, never today's observation.
    #[serde(deserialize_with = "required_optional_hash")]
    pub sidecar_revision: Option<String>,
}
fn required_optional_hash<'de, D: serde::Deserializer<'de>>(
    d: D,
) -> std::result::Result<Option<String>, D::Error> {
    let value = Option::<String>::deserialize(d)?;
    if value.as_deref().is_some_and(|s| !valid_hash(s)) {
        return Err(serde::de::Error::custom(
            "Use a SHA256 or null sidecarRevision.",
        ));
    }
    Ok(value)
}
#[derive(Debug, Deserialize)]
#[serde(
    tag = "action",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum MoveOperation {
    MoveList {},
    MoveCommit {
        generation: String,
        move_id: String,
        request_id: String,
    },
    MoveStatus {
        generation: String,
        request_id: String,
    },
    MoveCancel {
        generation: String,
        move_id: String,
        request_id: String,
    },
    MoveReconcile {
        generation: String,
        request_id: String,
    },
    MoveRetireTerminal {
        generation: String,
    },
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
enum Status {
    Prepared,
    Cancelled,
    Pending,
    Moved,
    RecoveryRequired,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct GitMember {
    relative: String,
    base_blob_oid: String,
    base_mode: String,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct GitPlan {
    base_ref: Option<String>,
    tracked: Vec<GitMember>,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct OwnedDeletion {
    move_id: String,
    request_id: String,
    absent_epoch: u64,
    expected_root: RootObservation,
    base_ref: String,
    base_blob_oid: String,
    base_mode: String,
    destination: String,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Record {
    version: u32,
    move_id: String,
    owner: String,
    request: MovePrepare,
    bundle: MoveBundle,
    destination_epoch: u64,
    reserved_from: u64,
    reserved_to: u64,
    main_before: String,
    main_document: Option<String>,
    expires_at: u64,
    status: Status,
    git: GitPlan,
    error: Option<Value>,
}
// Version1 compatibility stays typed: generic JSON normalization would silently accept duplicate keys.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct LegacyRequest {
    request_id: String,
    project: String,
    from: String,
    to: String,
    source_epoch: u64,
    expected_root: RootObservation,
    revision: String,
    // Presence is mandatory: null denotes a captured absent sidecar, never today's observation.
    #[serde(deserialize_with = "required_optional_hash")]
    sidecar_revision: Option<String>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct LegacyRecord {
    version: u32,
    move_id: String,
    owner: String,
    request: LegacyRequest,
    bundle: MoveBundle,
    destination_epoch: u64,
    reserved_from: u64,
    reserved_to: u64,
    main_before: String,
    main_document: Option<String>,
    expires_at: u64,
    status: Status,
    git: GitPlan,
    error: Option<Value>,
}

pub(super) struct MoveState {
    generation: String,
    maintenance: Option<Retirement>,
    #[cfg(test)]
    hooks: BTreeMap<u8, Box<dyn FnOnce() -> Result<()> + Send>>,
    records: BTreeMap<String, Record>,
    running: BTreeSet<String>,
}
impl Default for MoveState {
    fn default() -> Self {
        Self {
            generation: "0".into(),
            maintenance: None,
            records: BTreeMap::new(),
            running: BTreeSet::new(),
            #[cfg(test)]
            hooks: BTreeMap::new(),
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RetirementFile {
    name: String,
    bytes: u64,
    sha256: String,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RetirementEntry {
    move_id: String,
    request_id: String,
    files: Vec<RetirementFile>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Retirement {
    next_generation: String,
    entries: Vec<RetirementEntry>,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Initialization {
    version: u32,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(
    tag = "phase",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
enum Control {
    Ready {
        version: u32,
        generation: String,
    },
    Retiring {
        version: u32,
        generation: String,
        retirement: Retirement,
    },
}

enum Claim {
    Run(Box<Record>, Exclusions),
    Finished(Value),
}
struct Exclusions {
    _compile: OwnedMutexGuard<()>,
    _sync: OwnedMutexGuard<()>,
}
fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
fn valid_hash(s: &str) -> bool {
    s.len() == 64
        && s.bytes()
            .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
}
fn uuid(s: &str) -> Result<()> {
    if s.len() != 36 || Uuid::parse_str(s).is_err() {
        return Err(Error::new("format", "Use a UUID request identity."));
    }
    Ok(())
}
fn pending() -> Error {
    Error::new("move_pending","This source or project has an unresolved native Move. Check the same request and explicitly reconcile it before reopening or producing files.")
}
fn conflict() -> Error {
    Error::new("move_unresolved","Move proof does not match the current source group. Every actual file and the original intent were preserved.")
}
fn state_overlap(state: &Path, root: &Path) -> bool {
    root.starts_with(state) || state.starts_with(root)
}
fn state_overlap_error() -> Error {
    Error::new(
        "move_state_overlap",
        "Choose projects outside the application's private state before moving sources.",
    )
}
fn require_separate_move_state(state: &Path, registry: &Registry) -> Result<()> {
    if registry
        .projects
        .iter()
        .any(|p| state_overlap(state, &p.root))
    {
        return Err(state_overlap_error());
    }
    Ok(())
}
fn store(state: &Path) -> PathBuf {
    state.join("file-moves")
}
fn directory(state: &Path, id: &str) -> Result<PathBuf> {
    uuid(id)?;
    Ok(store(state).join(id))
}
fn private_regular(path: &Path, limit: usize) -> Result<Vec<u8>> {
    use cap_fs_ext::{FollowSymlinks, MetadataExt, OpenOptionsFollowExt, OpenOptionsSyncExt};
    type PrivateStamp = (u64, u64, u64, cap_std::time::SystemTime, (i64, i64));
    fn stamp(m: &cap_std::fs::Metadata) -> Result<PrivateStamp> {
        if !m.is_file() || m.nlink() != 1 {
            return Err(conflict());
        }
        #[cfg(unix)]
        let changed = {
            use cap_std::fs::MetadataExt as Unix;
            if Unix::mode(m) & 0o077 != 0 {
                return Err(conflict());
            }
            (Unix::ctime(m), Unix::ctime_nsec(m))
        };
        #[cfg(not(unix))]
        let changed = (0, 0);
        Ok((m.dev(), m.ino(), m.len(), m.modified()?, changed))
    }
    let parent_path = path.parent().ok_or_else(conflict)?;
    let name = path.file_name().ok_or_else(conflict)?;
    let parent = project_tree::open_root(parent_path)?;
    let identity = parent.dir_metadata()?;
    let expected = stamp(&parent.symlink_metadata(name)?)?;
    if expected.2 > limit as u64 {
        return Err(conflict());
    }
    let mut options = cap_std::fs::OpenOptions::new();
    options.read(true).follow(FollowSymlinks::No).nonblock(true);
    let mut file = parent.open_with(name, &options)?;
    if stamp(&file.metadata()?)? != expected {
        return Err(conflict());
    }
    let mut bytes = Vec::new();
    (&mut file).take(limit as u64 + 1).read_to_end(&mut bytes)?;
    let current = project_tree::open_root(parent_path)?.dir_metadata()?;
    if bytes.len() > limit
        || bytes.len() as u64 != expected.2
        || stamp(&file.metadata()?)? != expected
        || stamp(&parent.symlink_metadata(name)?)? != expected
        || (identity.dev(), identity.ino()) != (current.dev(), current.ino())
    {
        return Err(conflict());
    }
    Ok(bytes)
}
fn write_private_new(path: &Path, bytes: &[u8]) -> Result<()> {
    let mut options = fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut f = options.open(path)?;
    f.write_all(bytes)?;
    f.sync_all()?;
    Ok(())
}
fn record_bytes(record: &Record) -> Result<Vec<u8>> {
    let bytes = serde_json::to_vec_pretty(record)?;
    if bytes.len() > MAX_INTENT {
        return Err(Error::new("limit", "The Move receipt exceeds its bound."));
    }
    Ok(bytes)
}
fn save_record(state: &Path, record: &Record) -> Result<()> {
    atomic_write(
        &directory(state, &record.move_id)?.join("intent.json"),
        &record_bytes(record)?,
    )?;
    Ok(())
}
impl MoveState {
    pub(super) fn load(state: &Path, registry: &Registry) -> Result<Self> {
        let root = store(state);
        let metadata = match root.symlink_metadata() {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return Ok(Self::default())
            }
            Err(error) => return Err(error.into()),
            Ok(metadata) => metadata,
        };
        if !metadata.is_dir() || metadata.file_type().is_symlink() {
            return Err(conflict());
        }
        require_separate_move_state(state, registry)?;
        let generation = match read_control(state)? {
            None => "0".to_string(),
            Some(Control::Ready { generation, .. }) => generation,
            Some(Control::Retiring {
                generation,
                retirement,
                ..
            }) => {
                finish_retirement(state, registry, &generation, &retirement, &mut |_| Ok(()))?;
                retirement.next_generation
            }
        };
        let mut result = Self {
            generation,
            ..Self::default()
        };
        let mut active = 0usize;
        let mut pinned = 0u64;
        for entry in fs::read_dir(&root)? {
            let entry = entry?;
            if entry.file_name() == CONTROL || entry.file_name() == INITIALIZED {
                continue;
            }
            if result.records.len() >= MAX_RECORDS {
                return Err(Error::new(
                    "limit",
                    "Inspect the bounded Move receipt store before starting more moves.",
                ));
            }
            let id = entry.file_name().into_string().map_err(|_| conflict())?;
            uuid(&id)?;
            if !entry.file_type()?.is_dir() || entry.file_type()?.is_symlink() {
                return Err(conflict());
            }
            let mut record = decode_record(
                &private_regular(&entry.path().join("intent.json"), MAX_INTENT)?,
                &result.generation,
            )?;
            validate_record(&record, registry)?;
            if record.move_id != id || result.records.contains_key(&record.request.request_id) {
                return Err(conflict());
            }
            let terminal = matches!(record.status, Status::Moved | Status::Cancelled);
            let mut names = BTreeSet::from(["intent.json".to_string()]);
            for proof in &record.bundle.files {
                names.insert(proof.member.blob().into());
            }
            for item in fs::read_dir(entry.path())? {
                let item = item?;
                let name = item.file_name().into_string().map_err(|_| conflict())?;
                if !names.remove(&name) {
                    return Err(conflict());
                }
            }
            if names.contains("intent.json")
                || (!terminal && record.status != Status::Prepared && !names.is_empty())
            {
                return Err(conflict());
            }
            for proof in &record.bundle.files {
                let path = entry.path().join(proof.member.blob());
                if matches!(record.status, Status::Prepared | Status::Cancelled) {
                    if let Ok(metadata) = path.symlink_metadata() {
                        if !metadata.is_file()
                            || metadata.file_type().is_symlink()
                            || metadata.len() > proof.bytes
                        {
                            return Err(conflict());
                        }
                        pinned = pinned.checked_add(metadata.len()).ok_or_else(conflict)?;
                    }
                    continue;
                }
                if terminal && !path.exists() {
                    continue;
                }
                let bytes = private_regular(&path, proof.bytes as usize)?;
                if bytes.len() as u64 != proof.bytes || digest_bytes(&bytes) != proof.sha256 {
                    return Err(conflict());
                }
                pinned = pinned.checked_add(proof.bytes).ok_or_else(conflict)?;
            }
            if record.status == Status::Prepared {
                record.status = Status::Cancelled;
                save_record(state, &record)?;
            }
            if matches!(record.status, Status::Pending | Status::RecoveryRequired) {
                active += 1;
            }
            result
                .records
                .insert(record.request.request_id.clone(), record);
        }
        // Terminal snapshots remain bounded; no unknown/private residue is garbage-collected implicitly.
        if active > MAX_ACTIVE || pinned > 64 * 1024 * 1024 {
            return Err(Error::new(
                "limit",
                "The retained Move proof store exceeds its supported bound.",
            ));
        }
        Ok(result)
    }
    fn active(&self) -> usize {
        self.records
            .values()
            .filter(|r| {
                matches!(
                    r.status,
                    Status::Prepared | Status::Pending | Status::RecoveryRequired
                )
            })
            .count()
    }
}
fn generation_number(value: &str) -> Result<u64> {
    if value.is_empty()
        || value.len() > 20
        || (value.len() > 1 && value.starts_with('0'))
        || !value.bytes().all(|b| b.is_ascii_digit())
    {
        return Err(Error::new(
            "format",
            "Use the exact decimal Move generation returned by discovery.",
        ));
    }
    value
        .parse()
        .map_err(|_| Error::new("format", "The Move generation exceeds its supported bound."))
}
fn require_ready(moves: &MoveState) -> Result<()> {
    if moves.maintenance.is_some() {
        return Err(Error::new("move_maintenance", "Explicit Move receipt retirement is still unresolved. Preserve the same generation and restart to inspect its durable decision."));
    }
    Ok(())
}
fn require_generation(moves: &MoveState, generation: &str) -> Result<()> {
    require_ready(moves)?;
    if moves.generation != generation {
        return Err(Error::new("move_generation_stale", "This Move generation was retired or is unavailable. Discover the current generation; never relabel or automatically replay this old request."));
    }
    Ok(())
}
fn decode_record(bytes: &[u8], generation: &str) -> Result<Record> {
    let record = match serde_json::from_slice::<Record>(bytes) {
        Ok(record) => record,
        Err(primary) if generation == "0" => {
            let legacy: LegacyRecord = serde_json::from_slice(bytes).map_err(|_| primary)?;
            if legacy.version != 1 {
                return Err(conflict());
            }
            let request = MovePrepare {
                generation: "0".into(),
                request_id: legacy.request.request_id,
                project: legacy.request.project,
                from: legacy.request.from,
                to: legacy.request.to,
                source_epoch: legacy.request.source_epoch,
                expected_root: legacy.request.expected_root,
                revision: legacy.request.revision,
                sidecar_revision: legacy.request.sidecar_revision,
            };
            Record {
                version: legacy.version,
                move_id: legacy.move_id,
                owner: legacy.owner,
                request,
                bundle: legacy.bundle,
                destination_epoch: legacy.destination_epoch,
                reserved_from: legacy.reserved_from,
                reserved_to: legacy.reserved_to,
                main_before: legacy.main_before,
                main_document: legacy.main_document,
                expires_at: legacy.expires_at,
                status: legacy.status,
                git: legacy.git,
                error: legacy.error,
            }
        }
        Err(error) => return Err(error.into()),
    };
    if record.request.generation != generation {
        return Err(conflict());
    }
    Ok(record)
}

fn retirement_sync_clear(registry: &Registry) -> Result<()> {
    if registry
        .pending_deletions
        .values()
        .any(|rows| !rows.is_empty())
    {
        return Err(Error::new("move_pending_sync", "Synchronize every retained tracked Move deletion before explicitly retiring its generation. Receipt retirement never runs synchronization."));
    }
    Ok(())
}
fn validate_retirement(generation: &str, retirement: &Retirement) -> Result<()> {
    let next = generation_number(generation)?
        .checked_add(1)
        .ok_or_else(|| {
            Error::new(
                "limit",
                "The durable Move generation is exhausted; private receipts were preserved.",
            )
        })?;
    if generation_number(&retirement.next_generation)? != next
        || retirement.entries.len() > MAX_RECORDS
    {
        return Err(conflict());
    }
    let mut moves = BTreeSet::new();
    let mut requests = BTreeSet::new();
    let mut pinned = 0u64;
    for entry in &retirement.entries {
        uuid(&entry.move_id)?;
        uuid(&entry.request_id)?;
        if !moves.insert(&entry.move_id)
            || !requests.insert(&entry.request_id)
            || entry.files.is_empty()
            || entry.files.len() > 4
            || entry.files.last().map(|f| f.name.as_str()) != Some("intent.json")
        {
            return Err(conflict());
        }
        let mut names = BTreeSet::new();
        for file in &entry.files {
            let limit = match file.name.as_str() {
                "intent.json" => MAX_INTENT,
                "source" => MAX_TEXT,
                "review" | "report" => MAX_TEXT * 8,
                _ => return Err(conflict()),
            };
            if !names.insert(&file.name) || file.bytes > limit as u64 || !valid_hash(&file.sha256) {
                return Err(conflict());
            }
            if file.name != "intent.json" {
                pinned = pinned.checked_add(file.bytes).ok_or_else(conflict)?;
            }
        }
    }
    if pinned > 64 * 1024 * 1024 {
        return Err(conflict());
    }
    Ok(())
}
fn initialized(state: &Path) -> Result<bool> {
    let path = store(state).join(INITIALIZED);
    match path.symlink_metadata() {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(error) => return Err(error.into()),
        Ok(_) => {}
    }
    let marker: Initialization = serde_json::from_slice(&private_regular(&path, 512)?)?;
    if marker.version != 1 {
        return Err(conflict());
    }
    Ok(true)
}
fn initialize_control(state: &Path) -> Result<()> {
    use cap_fs_ext::{FollowSymlinks, OpenOptionsFollowExt, OpenOptionsSyncExt};
    if !initialized(state)? {
        write_private_new(
            &store(state).join(INITIALIZED),
            &serde_json::to_vec(&Initialization { version: 1 })?,
        )?;
    }
    // A readable witness from an interrupted earlier fsync is not yet a durable initialization.
    let parent = project_tree::open_root(&store(state))?;
    let mut options = cap_std::fs::OpenOptions::new();
    options.read(true).follow(FollowSymlinks::No).nonblock(true);
    parent.open_with(INITIALIZED, &options)?.sync_all()?;
    parent.open(".")?.sync_all()?;
    fs::File::open(state)?.sync_all()?;
    Ok(())
}
fn read_control(state: &Path) -> Result<Option<Control>> {
    match store(state).symlink_metadata() {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.into()),
        Ok(_) => private_directory(&store(state))?,
    }
    let witness = initialized(state)?;
    let path = store(state).join(CONTROL);
    match path.symlink_metadata() {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            if witness {
                return Err(conflict());
            }
            return Ok(None);
        }
        Err(error) => return Err(error.into()),
        Ok(_) => {}
    }
    if !witness {
        return Err(conflict());
    }
    let control: Control = serde_json::from_slice(&private_regular(&path, MAX_CONTROL)?)?;
    match &control {
        Control::Ready {
            version,
            generation,
        } => {
            if *version != 1 {
                return Err(conflict());
            }
            generation_number(generation)?;
        }
        Control::Retiring {
            version,
            generation,
            retirement,
        } => {
            if *version != 1 {
                return Err(conflict());
            }
            validate_retirement(generation, retirement)?;
        }
    }
    Ok(Some(control))
}
fn write_control(state: &Path, control: &Control) -> Result<()> {
    if !initialized(state)? {
        return Err(conflict());
    }
    let bytes = serde_json::to_vec_pretty(control)?;
    if bytes.len() > MAX_CONTROL {
        return Err(Error::new(
            "limit",
            "The bounded Move retirement decision is too large.",
        ));
    }
    atomic_write(&store(state).join(CONTROL), &bytes)
}
fn private_directory(path: &Path) -> Result<()> {
    let metadata = path.symlink_metadata()?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Err(conflict());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if metadata.permissions().mode() & 0o077 != 0 {
            return Err(conflict());
        }
    }
    Ok(())
}
fn check_retirement_top(state: &Path, retirement: &Retirement) -> Result<()> {
    let root = store(state);
    private_directory(&root)?;
    let allowed = retirement
        .entries
        .iter()
        .map(|e| e.move_id.as_str())
        .collect::<BTreeSet<_>>();
    for entry in fs::read_dir(root)? {
        let entry = entry?;
        let name = entry.file_name().into_string().map_err(|_| conflict())?;
        if name != CONTROL && name != INITIALIZED && !allowed.contains(name.as_str()) {
            return Err(conflict());
        }
        if name != CONTROL && name != INITIALIZED {
            private_directory(&entry.path())?;
        }
    }
    Ok(())
}
fn check_retirement_entry(
    state: &Path,
    registry: &Registry,
    generation: &str,
    entry: &RetirementEntry,
) -> Result<()> {
    let dir = directory(state, &entry.move_id)?;
    match dir.symlink_metadata() {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error.into()),
        Ok(_) => {}
    }
    private_directory(&dir)?;
    let allowed = entry
        .files
        .iter()
        .map(|f| f.name.as_str())
        .collect::<BTreeSet<_>>();
    for item in fs::read_dir(&dir)? {
        let name = item?.file_name().into_string().map_err(|_| conflict())?;
        if !allowed.contains(name.as_str()) {
            return Err(conflict());
        }
    }
    let mut intent_present = false;
    let mut payload_present = false;
    for file in &entry.files {
        let path = dir.join(&file.name);
        match path.symlink_metadata() {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(error) => return Err(error.into()),
            Ok(_) => {}
        }
        let bytes = private_regular(&path, file.bytes as usize)?;
        if bytes.len() as u64 != file.bytes || digest_bytes(&bytes) != file.sha256 {
            return Err(conflict());
        }
        if file.name == "intent.json" {
            intent_present = true;
            let record = decode_record(&bytes, generation)?;
            validate_record(&record, registry)?;
            if !matches!(record.status, Status::Moved | Status::Cancelled)
                || record.move_id != entry.move_id
                || record.request.request_id != entry.request_id
            {
                return Err(conflict());
            }
            for proof in &record.bundle.files {
                if let Some(saved) = entry.files.iter().find(|f| f.name == proof.member.blob()) {
                    if saved.sha256 != proof.sha256 || saved.bytes != proof.bytes {
                        return Err(conflict());
                    }
                }
            }
            if entry.files.iter().any(|f| {
                f.name != "intent.json"
                    && !record
                        .bundle
                        .files
                        .iter()
                        .any(|p| p.member.blob() == f.name)
            }) {
                return Err(conflict());
            }
        } else {
            payload_present = true;
        }
    }
    if !intent_present && payload_present {
        return Err(conflict());
    }
    Ok(())
}
fn unlink_retirement_file(
    state: &Path,
    entry: &RetirementEntry,
    file: &RetirementFile,
) -> Result<()> {
    use cap_fs_ext::MetadataExt;
    let path = directory(state, &entry.move_id)?;
    let parent = project_tree::open_root(&path)?;
    let identity = parent.dir_metadata()?;
    let before = match parent.symlink_metadata(&file.name) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error.into()),
        Ok(metadata) => metadata,
    };
    let bytes = private_regular(&path.join(&file.name), file.bytes as usize)?;
    let after = parent.symlink_metadata(&file.name)?;
    let current = project_tree::open_root(&path)?.dir_metadata()?;
    if bytes.len() as u64 != file.bytes
        || digest_bytes(&bytes) != file.sha256
        || (before.dev(), before.ino(), before.len(), before.modified()?)
            != (after.dev(), after.ino(), after.len(), after.modified()?)
        || (identity.dev(), identity.ino()) != (current.dev(), current.ino())
        || !after.is_file()
        || after.nlink() != 1
    {
        return Err(conflict());
    }
    #[cfg(unix)]
    {
        use cap_std::fs::MetadataExt as Unix;
        if Unix::mode(&after) & 0o077 != 0
            || (Unix::ctime(&before), Unix::ctime_nsec(&before))
                != (Unix::ctime(&after), Unix::ctime_nsec(&after))
        {
            return Err(conflict());
        }
    }
    parent.remove_file(&file.name)?;
    parent.open(".")?.sync_all()?;
    Ok(())
}
fn require_retiring_control(state: &Path, generation: &str, retirement: &Retirement) -> Result<()> {
    let expected = Control::Retiring {
        version: 1,
        generation: generation.into(),
        retirement: retirement.clone(),
    };
    match read_control(state)? {
        Some(saved) if serde_json::to_vec(&saved)? == serde_json::to_vec(&expected)? => Ok(()),
        _ => Err(conflict()),
    }
}
fn finish_retirement(
    state: &Path,
    registry: &Registry,
    generation: &str,
    retirement: &Retirement,
    boundary: &mut dyn FnMut(u8) -> Result<()>,
) -> Result<()> {
    use cap_fs_ext::MetadataExt;
    require_separate_move_state(state, registry)?;
    retirement_sync_clear(registry)?;
    validate_retirement(generation, retirement)?;
    require_retiring_control(state, generation, retirement)?;
    check_retirement_top(state, retirement)?;
    boundary(30)?;
    // Resume may observe bytes left by an uncertain publish/fsync. Reestablish durability before any unlink.
    initialize_control(state)?;
    write_control(
        state,
        &Control::Retiring {
            version: 1,
            generation: generation.into(),
            retirement: retirement.clone(),
        },
    )?;
    boundary(31)?;
    for entry in &retirement.entries {
        check_retirement_entry(state, registry, generation, entry)?;
    }
    for entry in &retirement.entries {
        let path = directory(state, &entry.move_id)?;
        match path.symlink_metadata() {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(error) => return Err(error.into()),
            Ok(_) => {}
        }
        let child = project_tree::open_root(&path)?;
        let child_identity = child.dir_metadata()?;
        for file in &entry.files {
            unlink_retirement_file(state, entry, file)?;
            boundary(if file.name == "intent.json" { 22 } else { 21 })?;
        }
        let parent = project_tree::open_root(&store(state))?;
        let identity = parent.dir_metadata()?;
        let current = project_tree::open_root(&store(state))?.dir_metadata()?;
        if (identity.dev(), identity.ino()) != (current.dev(), current.ino()) {
            return Err(conflict());
        }
        let current_child = parent.symlink_metadata(&entry.move_id)?;
        if !current_child.is_dir()
            || (current_child.dev(), current_child.ino())
                != (child_identity.dev(), child_identity.ino())
        {
            return Err(conflict());
        }
        parent.remove_dir(&entry.move_id)?;
        parent.open(".")?.sync_all()?;
        boundary(23)?;
    }
    check_retirement_top(state, retirement)?;
    for item in fs::read_dir(store(state))? {
        let name = item?.file_name();
        if name != CONTROL && name != INITIALIZED {
            return Err(conflict());
        }
    }
    boundary(24)?;
    require_retiring_control(state, generation, retirement)?;
    write_control(
        state,
        &Control::Ready {
            version: 1,
            generation: retirement.next_generation.clone(),
        },
    )?;
    boundary(25)?;
    Ok(())
}

fn digest_bytes(bytes: &[u8]) -> String {
    format!("{:x}", <sha2::Sha256 as sha2::Digest>::digest(bytes))
}
fn validate_request(request: &MovePrepare) -> Result<()> {
    generation_number(&request.generation)?;
    uuid(&request.request_id)?;
    uuid(&request.project)?;
    source_path::validate_source_path(&request.from)?;
    source_path::validate_source_path(&request.to)?;
    if request.from == request.to
        || request.from.eq_ignore_ascii_case(&request.to)
        || Path::new(&request.from).extension() != Path::new(&request.to).extension()
        || request.source_epoch > crate::MAX_SOURCE_EPOCH
        || !valid_hash(&request.revision)
        || request
            .sidecar_revision
            .as_deref()
            .is_some_and(|h| !valid_hash(h))
    {
        return Err(Error::new(
            "format",
            "Move one source to a distinct name with the same source extension.",
        ));
    }
    Ok(())
}
fn validate_record(r: &Record, registry: &Registry) -> Result<()> {
    validate_request(&r.request)?;
    uuid(&r.move_id)?;
    if (r.version != 2 && !(r.version == 1 && r.request.generation == "0"))
        || !registry.projects.iter().any(|p| p.id == r.request.project)
        || r.bundle.root != r.request.expected_root
        || r.bundle.from != r.request.from
        || r.bundle.to != r.request.to
        || r.bundle.files.is_empty()
        || r.bundle.files.len() > 3
        || r.bundle.files[0].member != MoveMember::Source
        || r.reserved_from != r.request.source_epoch.checked_add(1).ok_or_else(conflict)?
        || r.reserved_to != r.destination_epoch.checked_add(1).ok_or_else(conflict)?
        || r.reserved_from > crate::MAX_SOURCE_EPOCH
        || r.reserved_to > crate::MAX_SOURCE_EPOCH
    {
        return Err(conflict());
    }
    let mut seen = BTreeSet::new();
    let mut bytes = 0u64;
    for f in &r.bundle.files {
        if !seen.insert(f.member.blob())
            || !valid_hash(&f.sha256)
            || f.mode & 0o7111 != 0
            || f.bytes > 16 * 1024 * 1024
            || (f.member == MoveMember::Source && f.bytes > MAX_TEXT as u64)
        {
            return Err(conflict());
        }
        bytes += f.bytes;
    }
    let order = |m: MoveMember| match m {
        MoveMember::Source => 0,
        MoveMember::Review => 1,
        MoveMember::ImportReport => 2,
    };
    if r.bundle
        .files
        .windows(2)
        .any(|pair| order(pair[0].member) >= order(pair[1].member))
    {
        return Err(conflict());
    }
    if bytes > 32 * 1024 * 1024
        || r.bundle.files[0].sha256 != r.request.revision
        || r.bundle
            .files
            .iter()
            .find(|f| f.member == MoveMember::Review)
            .map(|f| f.sha256.as_str())
            != r.request.sidecar_revision.as_deref()
    {
        return Err(conflict());
    }
    Ok(())
}
fn reply(r: &Record) -> Value {
    json!({"generation":r.request.generation,"moveId":r.move_id,"requestId":r.request.request_id,"project":r.request.project,"from":r.request.from,"to":r.request.to,"expectedRoot":r.request.expected_root,"sourceEpoch":r.request.source_epoch,"destinationEpoch":r.destination_epoch,"reservedSourceEpoch":r.reserved_from,"reservedDestinationEpoch":r.reserved_to,"revision":r.request.revision,"sidecarRevision":r.request.sidecar_revision,"bundle":r.bundle.files,"mainBefore":r.main_before,"mainAfter":if r.main_before==r.request.from {&r.request.to}else{&r.main_before},"mainDocument":r.main_document,"expiresAt":r.expires_at,"status":r.status,"error":r.error})
}
impl Service {
    pub(super) fn move_source_available(&self, project: &str, path: &str) -> Result<()> {
        let book = lock(&self.file_move)?;
        if book.records.values().any(|r| {
            r.request.project == project
                && (r.request.from == path || r.request.to == path)
                && (book.running.contains(&r.request.request_id)
                    || matches!(r.status, Status::Pending | Status::RecoveryRequired))
        }) {
            return Err(pending());
        }
        drop(book);
        if lock(&self.registry)?
            .pending_deletions
            .get(project)
            .is_some_and(|rows| {
                rows.keys()
                    .any(|old| source_identity::pending_source(old) == path)
            })
        {
            return Err(Error::new("move_pending_sync","This old pathname is reserved by an unsynchronized Move deletion. Synchronize that exact ownership before reusing it."));
        }
        Ok(())
    }
    pub(crate) fn move_project_available(&self, project: &str) -> Result<()> {
        let book = lock(&self.file_move)?;
        if book.records.values().any(|r| {
            r.request.project == project
                && (book.running.contains(&r.request.request_id)
                    || matches!(r.status, Status::Pending | Status::RecoveryRequired))
        }) {
            return Err(pending());
        }
        Ok(())
    }
    fn move_exclusions(&self) -> Result<Exclusions> {
        Ok(Exclusions {
            _compile: self.compile_lock.clone().try_lock_owned().map_err(|_| {
                Error::new("busy", "Finish the active compilation before moving files.")
            })?,
            _sync: self.sync_lock.clone().try_lock_owned().map_err(|_| {
                Error::new("busy", "Finish Git synchronization before moving files.")
            })?,
        })
    }
    fn move_groups(&self, r: &Record) -> Result<(Project, SourceGroup, SourceGroup)> {
        require_separate_move_state(&self.state, &*lock(&self.registry)?)?;
        let p = self.project(&r.request.project)?;
        let root = RootedRoot::acquire(&p.root, &r.request.expected_root)?;
        let from = root.source_group(&r.request.from)?;
        let to = root.source_group(&r.request.to)?;
        from.admit_move_filesystem(&to)?;
        let approved = lock(&self.registry)?.projects.clone();
        from.require_unaliased_creation(&p, &approved)?;
        to.require_unaliased_creation(&p, &approved)?;
        Ok((p, from, to))
    }
    fn native_move_generation(&self, window: &str, owner: &str, generation: &str) -> Result<()> {
        let book = lock(&self.editor)?;
        book.check_native_owner(window, owner)?;
        let moves = lock(&self.file_move)?;
        require_generation(&moves, generation)
    }
    pub async fn prepare_native_file_move(
        self: &Arc<Self>,
        window_label: &str,
        owner_id: &str,
        request: MovePrepare,
    ) -> Result<Value> {
        validate_request(&request)?;
        self.native_move_generation(window_label, owner_id, &request.generation)?;
        let (service, window, owner) =
            (self.clone(), window_label.to_string(), owner_id.to_string());
        let tokens = self.move_exclusions()?;
        tokio::task::spawn_blocking(move || {
            let _tokens = tokens;
            {
                let book = lock(&service.editor)?;
                book.check_native_owner(&window, &owner)?;
                require_generation(&*lock(&service.file_move)?, &request.generation)?;
            }
            require_separate_move_state(&service.state, &*lock(&service.registry)?)?;
            service.cleanup_move_store()?;
            let receipts =
                service.capture_move_receipts(&request.project, &request.from, &request.to)?;
            let (p, from, to, destination_epoch, main_before) = {
                let book = lock(&service.editor)?;
                book.check_native_owner(&window, &owner)?;
                let _documents = service
                    .documents
                    .try_lock()
                    .map_err(|_| Error::new("busy", "Another source operation is running."))?;
                service.move_project_available(&request.project)?;
                service.history_preflight_project(&request.project)?;
                book.require_move_closed(&request.project, &request.from, &request.to)?;
                service.move_imports_closed(&request.project, &request.from, &request.to)?;
                service.verify_move_receipts(&receipts)?;
                let p = service.project(&request.project)?;
                let root = RootedRoot::acquire(&p.root, &request.expected_root)?;
                let from = root.source_group(&request.from)?;
                let to = root.source_group(&request.to)?;
                let approved = lock(&service.registry)?.projects.clone();
                from.require_unaliased_creation(&p, &approved)?;
                to.require_unaliased_creation(&p, &approved)?;
                service.require_source_epoch(&p.id, &request.from, request.source_epoch)?;
                let dest = service.source_epoch(&p.id, &request.to)?;
                let main = p.main_document.clone();
                (p, from, to, dest, main)
            };
            let (bundle, blobs) = from.capture_move_bundle(&to)?;
            let r = Record {
                version: 2,
                move_id: Uuid::new_v4().to_string(),
                owner: format!("native:{window}:{owner}"),
                request,
                destination_epoch,
                reserved_from: 0,
                reserved_to: 0,
                main_before,
                main_document: None,
                expires_at: now() + LEASE,
                status: Status::Prepared,
                git: GitPlan::default(),
                error: None,
                bundle,
            };
            let mut r = r;
            r.reserved_from = r.request.source_epoch.checked_add(1).ok_or_else(conflict)?;
            r.reserved_to = r.destination_epoch.checked_add(1).ok_or_else(conflict)?;
            validate_record(&r, &*lock(&service.registry)?)?;
            validate_bundle_policy(&service, &p, &r, &blobs)?;
            service.admit_move_store(r.bundle.files.iter().map(|f| f.bytes).sum())?;
            {
                let moves = lock(&service.file_move)?;
                if moves.records.contains_key(&r.request.request_id) {
                    return Err(Error::new(
                        "conflict",
                        "This requestId already identifies a Move; inspect its existing receipt.",
                    ));
                }
                if moves.records.len() >= MAX_RECORDS {
                    return Err(Error::new(
                        "limit",
                        "All 64 retained Move receipt slots are full. Explicitly retire this generation after every Move is terminal and its tracked deletions are synchronized; completing or inspecting requests alone does not free capacity.",
                    ));
                }
                if moves.active() >= MAX_ACTIVE {
                    return Err(Error::new(
                        "limit",
                        "Two Move requests are active. Cancel an unused preparation or explicitly resolve an accepted Move before preparing another.",
                    ));
                }
            }
            {
                let book = lock(&service.editor)?;
                book.check_native_owner(&window, &owner)?;
                let _documents = service
                    .documents
                    .try_lock()
                    .map_err(|_| Error::new("busy", "Another source operation is running."))?;
                require_separate_move_state(&service.state, &*lock(&service.registry)?)?;
                // AddProject uses the same documents admission and sees this marker before any proof is written.
                let private = store(&service.state);
                if private.exists() {
                    if !private.symlink_metadata()?.is_dir()
                        || private.symlink_metadata()?.file_type().is_symlink()
                    {
                        return Err(conflict());
                    }
                } else {
                    let mut builder = fs::DirBuilder::new();
                    #[cfg(unix)]
                    {
                        use std::os::unix::fs::DirBuilderExt;
                        builder.mode(0o700);
                    }
                    builder.create(&private)?;
                }
            }
            let dir = directory(&service.state, &r.move_id)?;
            fs::create_dir(&dir)?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                fs::set_permissions(&dir, fs::Permissions::from_mode(0o700))?;
            }
            write_private_new(&dir.join("intent.json"), &record_bytes(&r)?)?;
            fs::File::open(&dir)?.sync_all()?;
            fs::File::open(store(&service.state))?.sync_all()?;
            for (proof, bytes) in r.bundle.files.iter().zip(&blobs) {
                write_private_new(&dir.join(proof.member.blob()), bytes)?;
            }
            fs::File::open(&dir)?.sync_all()?;
            #[cfg(test)] service.move_test_boundary(28)?;
            let locations = from.observe_move_bundle(&to, &r.bundle)?;
            let book = lock(&service.editor)?;
            book.check_native_owner(&window, &owner)?;
            let _documents = service
                .documents
                .try_lock()
                .map_err(|_| Error::new("busy", "Another source operation is running."))?;
            service.move_project_available(&p.id)?;
            book.require_move_closed(&p.id, &r.request.from, &r.request.to)?;
            from.verify_move_metadata(&to, &r.bundle, &locations)?;
            let mut moves = lock(&service.file_move)?;
            require_generation(&moves, &r.request.generation)?;
            // Payload IO is complete. Only the bounded metadata publication occurs under the final authority guard.
            save_record(&service.state, &r)?;
            fs::File::open(&dir)?.sync_all()?;
            fs::File::open(store(&service.state))?.sync_all()?;
            let result = reply(&r);
            moves.records.insert(r.request.request_id.clone(), r);
            Ok(result)
        })
        .await
        .map_err(|_| {
            Error::new(
                "outcome_unknown",
                "Move preparation stopped. Inspect the same request before preparing another.",
            )
        })?
    }
    pub async fn file_move_native(
        self: &Arc<Self>,
        window_label: &str,
        owner_id: &str,
        operation: MoveOperation,
    ) -> Result<Value> {
        let (window, owner) = (window_label.to_string(), owner_id.to_string());
        match operation {
            MoveOperation::MoveList {} => {
                let service = self.clone();
                tokio::task::spawn_blocking(move || {
                    let book = lock(&service.editor)?;
                    book.check_native_owner(&window, &owner)?;
                    let moves = lock(&service.file_move)?;
                    require_ready(&moves)?;
                    Ok(json!({"generation":moves.generation,"moves":moves.records.values().map(reply).collect::<Vec<_>>()}))
                })
                .await
                .map_err(|_| conflict())?
            }
            MoveOperation::MoveStatus {
                generation,
                request_id,
            } => {
                generation_number(&generation)?;
                uuid(&request_id)?;
                let service = self.clone();
                tokio::task::spawn_blocking(move || {
                    let book = lock(&service.editor)?;
                    book.check_native_owner(&window, &owner)?;
                    let moves = lock(&service.file_move)?;
                    require_generation(&moves, &generation)?;
                    Ok(moves.records.get(&request_id).map_or_else(|| json!({"generation":generation,"requestId":request_id,"status":"unknown"}), reply))
                })
                .await
                .map_err(|_| conflict())?
            }
            MoveOperation::MoveCancel {
                generation,
                move_id,
                request_id,
            } => {
                generation_number(&generation)?;
                uuid(&move_id)?;
                uuid(&request_id)?;
                let service = self.clone();
                tokio::task::spawn_blocking(move || {
                    let book = lock(&service.editor)?;
                    let actual = book.check_native_owner(&window, &owner)?;
                    let mut moves = lock(&service.file_move)?;
                    require_generation(&moves, &generation)?;
                    if moves.running.contains(&request_id) {
                        return Err(pending());
                    }
                    let r = moves.records.get_mut(&request_id).ok_or_else(|| {
                        Error::new("expired_ticket", "The Move preparation is unavailable.")
                    })?;
                    if r.move_id != move_id || r.owner != actual {
                        return Err(Error::new("scope", "This page did not prepare that Move."));
                    }
                    if !matches!(r.status, Status::Prepared | Status::Cancelled) {
                        return Err(pending());
                    }
                    if r.status == Status::Cancelled {
                        return Ok(reply(r));
                    }
                    r.status = Status::Cancelled;
                    save_record(&service.state, r)?;
                    Ok(reply(r))
                })
                .await
                .map_err(|_| conflict())?
            }
            MoveOperation::MoveCommit {
                generation,
                move_id,
                request_id,
            } => {
                self.start_move(window, owner, generation, request_id, Some(move_id))
                    .await
            }
            MoveOperation::MoveReconcile {
                generation,
                request_id,
            } => {
                self.start_move(window, owner, generation, request_id, None)
                    .await
            }
            MoveOperation::MoveRetireTerminal { generation } => {
                self.retire_native_move_generation(window, owner, generation)
                    .await
            }
        }
    }
    async fn start_move(
        self: &Arc<Self>,
        window: String,
        owner: String,
        generation: String,
        request_id: String,
        move_id: Option<String>,
    ) -> Result<Value> {
        generation_number(&generation)?;
        uuid(&request_id)?;
        if let Some(id) = &move_id {
            uuid(id)?;
        }
        self.native_move_generation(&window, &owner, &generation)?;
        let tokens = self.move_exclusions()?;
        let service = self.clone();
        // Dropping the IPC waiter does not drop the driver or a blocking worker's actual exclusions.
        tokio::spawn(async move {
            let worker=service.clone();let w=window.clone();let o=owner.clone();let id=request_id.clone();
            let claimed=tokio::task::spawn_blocking(move||worker.claim_move(&w,&o,&generation,&id,move_id,tokens)).await.map_err(|_|conflict())??;
            let (r,tokens)=match claimed{Claim::Finished(value)=>return Ok(value),Claim::Run(record,tokens)=>(*record,tokens)};
            let git=if r.status==Status::Prepared{service.capture_move_git(&r).await}else{Ok(r.git.clone())};
            let result=match git {
                Ok(git)=>{let worker=service.clone();tokio::task::spawn_blocking(move||worker.run_move(&window,&owner,r,git,tokens)).await.unwrap_or_else(|_|Err(conflict()))},
                Err(error)=>{drop(tokens);Err(error)}
            };
            let mut book=lock(&service.editor)?;let mut moves=lock(&service.file_move)?;moves.running.remove(&request_id);
            if let Some(record)=moves.records.get_mut(&request_id){if !matches!(record.status,Status::Pending|Status::RecoveryRequired){book.release_move(&record.move_id);if record.status==Status::Prepared && book.check_import_owner(&record.owner).is_err(){record.status=Status::Cancelled;save_record(&service.state,record)?;}}}
            result
        }).await.map_err(|_|Error::new("outcome_unknown","The admitted Move may still be running. Query the same request; do not replay it under a new identity."))?
    }
    fn claim_move(
        &self,
        window: &str,
        owner: &str,
        generation: &str,
        request_id: &str,
        move_id: Option<String>,
        tokens: Exclusions,
    ) -> Result<Claim> {
        self.native_editor_owner(window, owner)?;
        let initial = {
            let moves = lock(&self.file_move)?;
            require_generation(&moves, generation)?;
            moves.records.get(request_id).cloned().ok_or_else(|| {
                Error::new("expired_ticket", "The Move preparation is unavailable.")
            })?
        };
        let receipts = self.capture_move_receipts(
            &initial.request.project,
            &initial.request.from,
            &initial.request.to,
        )?;
        let _app = lock(&self.app_control)?;
        let mut book = lock(&self.editor)?;
        let actual = book.check_native_owner(window, owner)?;
        let _documents = self
            .documents
            .try_lock()
            .map_err(|_| Error::new("busy", "Another source operation is running."))?;
        self.history_preflight_project(&initial.request.project)?;
        self.move_imports_closed(
            &initial.request.project,
            &initial.request.from,
            &initial.request.to,
        )?;
        self.verify_move_receipts(&receipts)?;
        let mut moves = lock(&self.file_move)?;
        require_generation(&moves, generation)?;
        let r = moves
            .records
            .get(request_id)
            .cloned()
            .ok_or_else(conflict)?;
        if move_id.as_ref().is_some_and(|id| *id != r.move_id) {
            return Err(Error::new(
                "conflict",
                "The requestId is bound to a different Move capture.",
            ));
        }
        if r.status == Status::Moved {
            return Ok(Claim::Finished(reply(&r)));
        }
        if moves.running.contains(request_id) {
            return Ok(Claim::Finished(reply(&r)));
        }
        if let Some(id) = move_id {
            if r.move_id != id
                || r.owner != actual
                || r.status != Status::Prepared
                || r.expires_at < now()
            {
                return Err(Error::new(
                    "expired_ticket",
                    "The Move preparation expired, changed or belongs to a retired page.",
                ));
            }
        } else if !matches!(r.status, Status::Pending | Status::RecoveryRequired) {
            return Err(Error::new(
                "scope",
                "Only an accepted intent may be reconciled.",
            ));
        }
        if moves.records.values().any(|other| {
            other.request.project == r.request.project
                && other.request.request_id != request_id
                && (moves.running.contains(&other.request.request_id)
                    || matches!(other.status, Status::Pending | Status::RecoveryRequired))
        }) {
            return Err(pending());
        }
        book.reserve_move(
            &r.move_id,
            &r.request.project,
            &r.request.from,
            &r.request.to,
        )?;
        moves.running.insert(request_id.into());
        Ok(Claim::Run(Box::new(r), tokens))
    }
    fn run_move(
        &self,
        window: &str,
        owner: &str,
        mut r: Record,
        git: GitPlan,
        _tokens: Exclusions,
    ) -> Result<Value> {
        let result = (|| -> Result<Value> {
            #[cfg(test)]
            self.move_test_boundary(0)?;
            let (project, from, to) = self.move_groups(&r)?;
            let locations = from.observe_move_bundle(&to, &r.bundle)?;
            if r.status == Status::Prepared && locations.iter().any(|m| m.moved) {
                return Err(conflict());
            }
            let blobs = r
                .bundle
                .files
                .iter()
                .map(|proof| {
                    let bytes = private_regular(
                        &directory(&self.state, &r.move_id)?.join(proof.member.blob()),
                        proof.bytes as usize,
                    )?;
                    if bytes.len() as u64 != proof.bytes || digest_bytes(&bytes) != proof.sha256 {
                        return Err(conflict());
                    }
                    Ok(bytes)
                })
                .collect::<Result<Vec<_>>>()?;
            if r.status == Status::Prepared {
                validate_bundle_policy(self, &project, &r, &blobs)?;
                let receipts =
                    self.capture_move_receipts(&project.id, &r.request.from, &r.request.to)?;
                let mut app = lock(&self.app_control)?;
                let book = lock(&self.editor)?;
                book.check_native_owner(window, owner)?;
                let _documents = self
                    .documents
                    .try_lock()
                    .map_err(|_| Error::new("busy", "Another source operation is running."))?;
                require_separate_move_state(&self.state, &*lock(&self.registry)?)?;
                self.history_preflight_project(&project.id)?;
                self.verify_move_receipts(&receipts)?;
                from.verify_move_metadata(&to, &r.bundle, &locations)?;
                let approved = lock(&self.registry)?.projects.clone();
                from.require_unaliased_creation(&project, &approved)?;
                to.require_unaliased_creation(&project, &approved)?;
                let registry = lock(&self.registry)?;
                source_identity::require_in(
                    &registry,
                    &project.id,
                    &r.request.from,
                    r.request.source_epoch,
                )?;
                source_identity::require_in(
                    &registry,
                    &project.id,
                    &r.request.to,
                    r.destination_epoch,
                )?;
                drop(registry);
                self.move_tombstone_admission(&r)?;
                r.status = Status::Pending;
                r.git = git;
                save_record(&self.state, &r)?;
                lock(&self.file_move)?
                    .records
                    .insert(r.request.request_id.clone(), r.clone());
                // Accepted authority is one-way. No share or App capability is restored by cancellation/error/reconcile.
                lock(&self.shared)?.retain(|_, (p, path, _, _)| {
                    p != &project.id || (path != &r.request.from && path != &r.request.to)
                });
                app.reset_for_move();
                self.revoke_pdf_exports()?;
            }
            #[cfg(test)]
            self.move_test_boundary(1)?;
            self.reserve_move_epochs(window, owner, &r, &from, &to)?;
            #[cfg(test)]
            self.move_test_boundary(2)?;
            for (index, moved) in locations.iter().map(|entry| entry.moved).enumerate() {
                // Raw bytes are proved outside live mutexes, then short authority+metadata proof brackets one rename.
                let latest = from.observe_move_bundle(&to, &r.bundle)?;
                if latest[index].moved != moved {
                    return Err(conflict());
                }
                {
                    let book = lock(&self.editor)?;
                    book.check_native_owner(window, owner)?;
                    let _documents = self
                        .documents
                        .try_lock()
                        .map_err(|_| Error::new("busy", "Another source operation is running."))?;
                    let registry = lock(&self.registry)?;
                    source_identity::require_in(
                        &registry,
                        &project.id,
                        &r.request.from,
                        r.reserved_from,
                    )?;
                    source_identity::require_in(
                        &registry,
                        &project.id,
                        &r.request.to,
                        r.reserved_to,
                    )?;
                    drop(registry);
                    from.verify_move_metadata(&to, &r.bundle, &latest)?;
                    from.relocate_move_member(&to, &r.bundle, index, moved)?;
                }
                #[cfg(test)]
                self.move_test_boundary(3 + index as u8)?;
            }
            let final_observation = from.observe_move_bundle(&to, &r.bundle)?;
            if final_observation.iter().any(|entry| !entry.moved) {
                return Err(conflict());
            }
            #[cfg(test)]
            self.move_test_boundary(6)?;
            {
                let book = lock(&self.editor)?;
                book.check_native_owner(window, owner)?;
                let _documents = self
                    .documents
                    .try_lock()
                    .map_err(|_| Error::new("busy", "Another source operation is running."))?;
                from.verify_move_metadata(&to, &r.bundle, &final_observation)?;
                r.main_document = Some(self.finish_move_registry(&r)?);
                self.finish_move_policy(
                    &project.root.join(&r.request.from),
                    &project.root.join(&r.request.to),
                    r.request.sidecar_revision.as_deref(),
                )?;
                #[cfg(test)]
                self.move_test_boundary(7)?;
                r.status = Status::Moved;
                r.error = None;
                save_record(&self.state, &r)?;
                lock(&self.file_move)?
                    .records
                    .insert(r.request.request_id.clone(), r.clone());
            }
            Ok(reply(&r))
        })();
        if let Err(error) = &result {
            if matches!(r.status, Status::Pending | Status::RecoveryRequired) {
                r.status = Status::RecoveryRequired;
                r.error = Some(json!({"code":error.code,"message":error.message}));
                let saved = save_record(&self.state, &r);
                lock(&self.file_move)?
                    .records
                    .insert(r.request.request_id.clone(), r.clone());
                if saved.is_err() {
                    return Err(Error::new("outcome_unknown","The Move remains blocked; its terminal receipt could not be made durable. Inspect the same accepted intent."));
                }
                return Ok(reply(&r));
            }
        }
        result
    }
    fn reserve_move_epochs(
        &self,
        window: &str,
        owner: &str,
        r: &Record,
        from: &SourceGroup,
        to: &SourceGroup,
    ) -> Result<()> {
        let book = lock(&self.editor)?;
        book.check_native_owner(window, owner)?;
        let _documents = self
            .documents
            .try_lock()
            .map_err(|_| Error::new("busy", "Another source operation is running."))?;
        from.check_current()?;
        to.check_current()?;
        let mut registry = lock(&self.registry)?;
        let mut next = registry.clone();
        let a = source_identity::epoch_in(&next, &r.request.project, &r.request.from)?;
        let b = source_identity::epoch_in(&next, &r.request.project, &r.request.to)?;
        if a == r.reserved_from && b == r.reserved_to {
            return Ok(());
        }
        if a != r.request.source_epoch || b != r.destination_epoch {
            return Err(conflict());
        }
        source_identity::rotate_reused(&mut next, &r.request.project, &r.request.from, true)?;
        source_identity::rotate_reused(&mut next, &r.request.project, &r.request.to, true)?;
        self.save_move_registry(&mut registry, next)
    }
    fn save_move_registry(&self, registry: &mut Registry, next: Registry) -> Result<()> {
        match self.save_registry(&next) {
            Ok(()) => {
                *registry = next;
                Ok(())
            }
            Err(error) => {
                let installed = read_text(&self.state.join("projects.json"), MAX_TEXT)
                    .ok()
                    .and_then(|s| serde_json::from_str::<Registry>(&s).ok())
                    .and_then(|r| serde_json::to_vec(&r).ok());
                if installed == Some(serde_json::to_vec(&next)?) {
                    *registry = next;
                }
                Err(error)
            }
        }
    }
    fn finish_move_registry(&self, r: &Record) -> Result<String> {
        let mut registry = lock(&self.registry)?;
        let mut next = registry.clone();
        source_identity::require_in(&next, &r.request.project, &r.request.from, r.reserved_from)?;
        source_identity::require_in(&next, &r.request.project, &r.request.to, r.reserved_to)?;
        let mut deletions = next
            .pending_deletions
            .remove(&r.request.project)
            .unwrap_or_default();
        let p = next
            .projects
            .iter_mut()
            .find(|p| p.id == r.request.project)
            .ok_or_else(conflict)?;
        for f in &r.bundle.files {
            let old = format!("{}{}", r.request.from, f.member.suffix());
            let new = format!("{}{}", r.request.to, f.member.suffix());
            if let Some(revision) = p.pending_revisions.get(&old) {
                if revision != &f.sha256 {
                    return Err(conflict());
                }
            }
            p.pending.remove(&old);
            p.pending_revisions.remove(&old);
            p.pending.insert(new.clone());
            p.pending_revisions.insert(new.clone(), f.sha256.clone());
            if let Some(base) = r.git.tracked.iter().find(|m| m.relative == old) {
                let deletion = OwnedDeletion {
                    move_id: r.move_id.clone(),
                    request_id: r.request.request_id.clone(),
                    absent_epoch: r.reserved_from,
                    expected_root: r.request.expected_root,
                    base_ref: r.git.base_ref.clone().ok_or_else(conflict)?,
                    base_blob_oid: base.base_blob_oid.clone(),
                    base_mode: base.base_mode.clone(),
                    destination: new,
                };
                if deletions.get(&old).is_some_and(|old| old != &deletion) {
                    return Err(conflict());
                }
                deletions.insert(old, deletion);
            }
        }
        if p.main_document == r.request.from {
            p.main_document = r.request.to.clone();
        }
        let main = p.main_document.clone();
        if !deletions.is_empty() {
            next.pending_deletions
                .insert(r.request.project.clone(), deletions);
        }
        self.save_move_registry(&mut registry, next)?;
        Ok(main)
    }
    fn move_tombstone_admission(&self, r: &Record) -> Result<()> {
        let registry = lock(&self.registry)?;
        if registry
            .pending_deletions
            .get(&r.request.project)
            .is_some_and(|rows| {
                rows.iter().any(|(path, d)| {
                    source_identity::pending_source(path) == r.request.to
                        || source_identity::pending_source(&d.destination) == r.request.from
                })
            })
        {
            return Err(Error::new("move_pending_sync","Synchronize the earlier tracked Move before relocating its bundle or reusing its old pathname."));
        }
        Ok(())
    }
    async fn capture_move_git(&self, r: &Record) -> Result<GitPlan> {
        let p = self.project(&r.request.project)?;
        if !p.root.join(".git").exists() {
            return Ok(GitPlan::default());
        }
        if Path::new(
            git(&p.root, &["rev-parse", "--show-toplevel"])
                .await?
                .trim(),
        )
        .canonicalize()?
            != p.root
        {
            return Err(Error::new(
                "git",
                "Approve the exact Git root before moving a tracked source.",
            ));
        }
        let head = git_head(&p.root).await?;
        let mut plan = GitPlan {
            base_ref: head.clone(),
            tracked: Vec::new(),
        };
        for f in &r.bundle.files {
            let destination = format!("{}{}", r.request.to, f.member.suffix());
            if !git(&p.root, &["ls-files", "--stage", "-z", "--", &destination])
                .await?
                .is_empty()
                || (if let Some(head) = &head {
                    !git(&p.root, &["ls-tree", "-z", head, "--", &destination])
                        .await?
                        .is_empty()
                } else {
                    false
                })
            {
                return Err(Error::new("conflict","The absent destination is still tracked or staged. Move does not replace that Git identity."));
            }
            let relative = format!("{}{}", r.request.from, f.member.suffix());
            let index = git(&p.root, &["ls-files", "--stage", "-z", "--", &relative]).await?;
            let tree = if let Some(head) = &head {
                git(&p.root, &["ls-tree", "-z", head, "--", &relative]).await?
            } else {
                String::new()
            };
            if tree.is_empty() {
                if !index.is_empty() {
                    return Err(Error::new(
                        "conflict",
                        "Commit or unstage this source before moving it.",
                    ));
                }
                continue;
            }
            let (metadata, name) = tree
                .trim_end_matches('\0')
                .split_once('\t')
                .ok_or_else(conflict)?;
            let mut fields = metadata.split_whitespace();
            let mode = fields.next().ok_or_else(conflict)?;
            let kind = fields.next().ok_or_else(conflict)?;
            let oid = fields.next().ok_or_else(conflict)?;
            if mode != "100644"
                || kind != "blob"
                || name != relative
                || index != format!("{mode} {oid} 0\t{relative}\0")
            {
                return Err(Error::new("conflict","Move preserves the user's index; staged or unsupported source members must be resolved first."));
            }
            plan.tracked.push(GitMember {
                relative,
                base_blob_oid: oid.into(),
                base_mode: mode.into(),
            });
        }
        Ok(plan)
    }
}
fn validate_bundle_policy(
    service: &Service,
    p: &Project,
    r: &Record,
    blobs: &[Vec<u8>],
) -> Result<()> {
    let text = std::str::from_utf8(blobs.first().ok_or_else(conflict)?).map_err(|_| conflict())?;
    let raw = r
        .bundle
        .files
        .iter()
        .position(|f| f.member == MoveMember::Review)
        .map(|i| std::str::from_utf8(&blobs[i]))
        .transpose()
        .map_err(|_| conflict())?;
    service.require_move_policy(&p.root.join(&r.request.from), raw)?;
    if let Some(raw) = raw {
        let review: Review = serde_json::from_str(raw).map_err(|_| conflict())?;
        review.validate_for_text(text).map_err(|_| conflict())?;
    }
    service.check_policy_continuity(&p.root.join(&r.request.to), None)?;
    service.policy_capacity(&[p.root.join(&r.request.to)])?;
    Ok(())
}

impl Service {
    async fn retire_native_move_generation(
        self: &Arc<Self>,
        window: String,
        owner: String,
        generation: String,
    ) -> Result<Value> {
        generation_number(&generation)?;
        self.native_move_generation(&window, &owner, &generation)?;
        let tokens = self.move_exclusions()?;
        let service = self.clone();
        // A started blocking worker keeps the actual exclusions if its IPC waiter disappears.
        tokio::task::spawn_blocking(move || service.retire_move_generation(&window, &owner, &generation, tokens))
            .await.map_err(|_| Error::new("outcome_unknown", "Move receipt retirement may still be running. Keep the same generation and discover its durable result."))?
    }
    fn retirement_admission(
        &self,
        moves: &MoveState,
        generation: &str,
        registry: &Registry,
    ) -> Result<()> {
        require_generation(moves, generation)?;
        if !moves.running.is_empty()
            || moves
                .records
                .values()
                .any(|r| !matches!(r.status, Status::Moved | Status::Cancelled))
        {
            return Err(Error::new("move_pending", "Finish or explicitly cancel every preparation and resolve every accepted Move before retiring its generation."));
        }
        if moves.records.len() > MAX_RECORDS {
            return Err(conflict());
        }
        generation_number(generation)?
            .checked_add(1)
            .ok_or_else(|| {
                Error::new(
                    "limit",
                    "The durable Move generation is exhausted; private receipts were preserved.",
                )
            })?;
        retirement_sync_clear(registry)?;
        require_separate_move_state(&self.state, registry)
    }
    fn capture_retirement(
        &self,
        generation: &str,
        records: &[Record],
        registry: &Registry,
    ) -> Result<Retirement> {
        let next_generation = generation_number(generation)?
            .checked_add(1)
            .ok_or_else(|| {
                Error::new(
                    "limit",
                    "The durable Move generation is exhausted; private receipts were preserved.",
                )
            })?
            .to_string();
        match read_control(&self.state)? {
            None if generation == "0" => {}
            Some(Control::Ready {
                generation: saved, ..
            }) if saved == generation => {}
            _ => return Err(conflict()),
        }
        let mut retirement = Retirement {
            next_generation,
            entries: Vec::new(),
        };
        let root = store(&self.state);
        match root.symlink_metadata() {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound && records.is_empty() => {
                return Ok(retirement)
            }
            Err(error) => return Err(error.into()),
            Ok(_) => private_directory(&root)?,
        }
        for record in records {
            if record.request.generation != generation
                || !matches!(record.status, Status::Moved | Status::Cancelled)
            {
                return Err(conflict());
            }
            let dir = directory(&self.state, &record.move_id)?;
            private_directory(&dir)?;
            let intent = private_regular(&dir.join("intent.json"), MAX_INTENT)?;
            let saved = decode_record(&intent, generation)?;
            validate_record(&saved, registry)?;
            if record_bytes(&saved)? != record_bytes(record)? {
                return Err(conflict());
            }
            let mut files = Vec::new();
            for proof in &record.bundle.files {
                let name = proof.member.blob();
                let path = dir.join(name);
                match path.symlink_metadata() {
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
                    Err(error) => return Err(error.into()),
                    Ok(_) => {}
                }
                let bytes = private_regular(&path, proof.bytes as usize)?;
                if bytes.len() as u64 != proof.bytes || digest_bytes(&bytes) != proof.sha256 {
                    return Err(conflict());
                }
                files.push(RetirementFile {
                    name: name.into(),
                    bytes: proof.bytes,
                    sha256: proof.sha256.clone(),
                });
            }
            files.push(RetirementFile {
                name: "intent.json".into(),
                bytes: intent.len() as u64,
                sha256: digest_bytes(&intent),
            });
            retirement.entries.push(RetirementEntry {
                move_id: record.move_id.clone(),
                request_id: record.request.request_id.clone(),
                files,
            });
        }
        validate_retirement(generation, &retirement)?;
        check_retirement_top(&self.state, &retirement)?;
        for entry in &retirement.entries {
            check_retirement_entry(&self.state, registry, generation, entry)?;
        }
        if serde_json::to_vec_pretty(&Control::Retiring {
            version: 1,
            generation: generation.into(),
            retirement: retirement.clone(),
        })?
        .len()
            > MAX_CONTROL
        {
            return Err(Error::new(
                "limit",
                "The bounded Move retirement decision is too large.",
            ));
        }
        Ok(retirement)
    }
    fn retire_move_generation(
        &self,
        window: &str,
        owner: &str,
        generation: &str,
        _tokens: Exclusions,
    ) -> Result<Value> {
        #[cfg(test)]
        let mut initialization_fault = lock(&self.file_move)?.hooks.remove(&27);
        let (records, registry) = {
            let book = lock(&self.editor)?;
            book.check_native_owner(window, owner)?;
            let _documents = self
                .documents
                .try_lock()
                .map_err(|_| Error::new("busy", "Another source operation is running."))?;
            let moves = lock(&self.file_move)?;
            let registry = lock(&self.registry)?;
            self.retirement_admission(&moves, generation, &registry)?;
            (
                moves.records.values().cloned().collect::<Vec<_>>(),
                registry.clone(),
            )
        };
        let retirement = self.capture_retirement(generation, &records, &registry)?;
        #[cfg(test)]
        self.move_test_boundary(26)?;
        {
            let book = lock(&self.editor)?;
            book.check_native_owner(window, owner)?;
            let _documents = self
                .documents
                .try_lock()
                .map_err(|_| Error::new("busy", "Another source operation is running."))?;
            let mut moves = lock(&self.file_move)?;
            let registry = lock(&self.registry)?;
            self.retirement_admission(&moves, generation, &registry)?;
            if moves.records.len() != records.len()
                || records
                    .iter()
                    .any(|r| !moves.records.contains_key(&r.request.request_id))
            {
                return Err(conflict());
            }
            let root = store(&self.state);
            match root.symlink_metadata() {
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                    let mut builder = fs::DirBuilder::new();
                    #[cfg(unix)]
                    {
                        use std::os::unix::fs::DirBuilderExt;
                        builder.mode(0o700);
                    }
                    builder.create(&root)?;
                    fs::File::open(&self.state)?.sync_all()?;
                }
                Err(error) => return Err(error.into()),
                Ok(_) => private_directory(&root)?,
            }
            check_retirement_top(&self.state, &retirement)?;
            match read_control(&self.state)? {
                None if generation == "0" => {}
                Some(Control::Ready {
                    generation: saved, ..
                }) if saved == generation => {}
                _ => return Err(conflict()),
            }
            moves.maintenance = Some(retirement.clone());
            let publish = (|| {
                initialize_control(&self.state)?;
                #[cfg(test)]
                if let Some(fault) = initialization_fault.take() {
                    fault()?;
                }
                write_control(
                    &self.state,
                    &Control::Retiring {
                        version: 1,
                        generation: generation.into(),
                        retirement: retirement.clone(),
                    },
                )
            })();
            if let Err(error) = publish {
                // Publication or its directory fsync can be uncertain; no mutation may resume under the old generation.
                return Err(Error::new("outcome_unknown", format!("Receipt retirement's durable decision is uncertain ({}). Preserve this generation and restart to inspect its private journal.", error.code)));
            }
        }
        let finish = self.finish_move_retirement(&registry, generation, &retirement);
        if let Err(error) = finish {
            return Err(Error::new("outcome_unknown", format!("Explicit receipt retirement remains fenced ({}). Its known private journal was preserved; restart to inspect the same generation.", error.code)));
        }
        let _book = lock(&self.editor)?;
        let mut moves = lock(&self.file_move)?;
        match read_control(&self.state)? {
            Some(Control::Ready {
                generation: saved, ..
            }) if saved == retirement.next_generation => {}
            _ => return Err(conflict()),
        }
        moves.records.clear();
        moves.running.clear();
        moves.generation.clone_from(&retirement.next_generation);
        moves.maintenance = None;
        Ok(
            json!({"retiredGeneration":generation,"generation":retirement.next_generation,"retiredCount":records.len()}),
        )
    }
    fn finish_move_retirement(
        &self,
        registry: &Registry,
        generation: &str,
        retirement: &Retirement,
    ) -> Result<()> {
        #[cfg(test)]
        self.move_test_boundary(20)?;
        finish_retirement(&self.state, registry, generation, retirement, &mut |step| {
            #[cfg(test)]
            self.move_test_boundary(step)?;
            let _ = step;
            Ok(())
        })
    }
    fn cleanup_move_store(&self) -> Result<()> {
        let records = lock(&self.file_move)?
            .records
            .values()
            .filter(|r| matches!(r.status, Status::Moved | Status::Cancelled))
            .cloned()
            .collect::<Vec<_>>();
        for r in records {
            self.retire_move_blobs(&r)?;
        }
        Ok(())
    }
    fn admit_move_store(&self, reserved: u64) -> Result<()> {
        let root = store(&self.state);
        if !root.exists() {
            return Ok(());
        }
        if !root.symlink_metadata()?.is_dir() || root.symlink_metadata()?.file_type().is_symlink() {
            return Err(conflict());
        }
        let known = lock(&self.file_move)?
            .records
            .values()
            .map(|r| r.move_id.clone())
            .collect::<BTreeSet<_>>();
        let mut bytes = reserved;
        let mut count = 0usize;
        for entry in fs::read_dir(&root)? {
            let entry = entry?;
            if entry.file_name() == CONTROL || entry.file_name() == INITIALIZED {
                read_control(&self.state)?;
                continue;
            }
            if count >= MAX_RECORDS {
                return Err(Error::new("limit", "The bounded Move store is full."));
            }
            count += 1;
            if !entry.file_type()?.is_dir() || entry.file_type()?.is_symlink() {
                return Err(conflict());
            }
            let id = entry.file_name().into_string().map_err(|_| conflict())?;
            uuid(&id)?;
            if !known.contains(&id) {
                return Err(Error::new("move_unresolved","An interrupted private preparation was preserved. Restart to retire its unaccepted ticket before preparing another Move."));
            }
            for (j, file) in fs::read_dir(entry.path())?.enumerate() {
                if j >= 4 {
                    return Err(conflict());
                }
                let file = file?;
                let name = file.file_name().into_string().map_err(|_| conflict())?;
                if !matches!(
                    name.as_str(),
                    "intent.json" | "source" | "review" | "report"
                ) {
                    return Err(conflict());
                }
                let m = file.path().symlink_metadata()?;
                if !m.is_file() || m.file_type().is_symlink() {
                    return Err(conflict());
                }
                if name != "intent.json" {
                    bytes = bytes.checked_add(m.len()).ok_or_else(conflict)?;
                }
            }
        }
        if bytes > 64 * 1024 * 1024 {
            return Err(Error::new("limit","Retained Move payloads and the new snapshot exceed 64 MiB. Unknown residue was preserved."));
        }
        Ok(())
    }
    fn retire_move_blobs(&self, r: &Record) -> Result<()> {
        let dir = directory(&self.state, &r.move_id)?;
        for file in &r.bundle.files {
            let path = dir.join(file.member.blob());
            if !path.exists() {
                continue;
            }
            let bytes = private_regular(&path, file.bytes as usize)?;
            if digest_bytes(&bytes) != file.sha256 {
                return Err(conflict());
            }
            // shortcut: private proof retirement is optimistic against external private-state replacement; source names are never unlinked.
            fs::remove_file(&path)?;
        }
        fs::File::open(dir)?.sync_all()?;
        Ok(())
    }
    pub(super) fn retire_move_preparations(&self, owner: &str) -> Result<()> {
        let mut moves = lock(&self.file_move)?;
        let running = moves.running.clone();
        for r in moves.records.values_mut().filter(|r| {
            r.owner == owner
                && r.status == Status::Prepared
                && !running.contains(&r.request.request_id)
        }) {
            r.status = Status::Cancelled;
            save_record(&self.state, r)?;
        }
        Ok(())
    }
    pub(super) fn move_add_project_allowed(&self, root: &Path) -> Result<()> {
        let moves = lock(&self.file_move)?;
        if state_overlap(&self.state, root) {
            let has_private_state = !moves.records.is_empty()
                || match store(&self.state).symlink_metadata() {
                    Ok(_) => true,
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => false,
                    Err(error) => return Err(error.into()),
                };
            if has_private_state {
                return Err(state_overlap_error());
            }
        }
        let registry = lock(&self.registry)?;
        for r in moves.records.values().filter(|r| {
            moves.running.contains(&r.request.request_id)
                || matches!(r.status, Status::Pending | Status::RecoveryRequired)
        }) {
            let p = registry
                .projects
                .iter()
                .find(|p| p.id == r.request.project)
                .ok_or_else(conflict)?;
            if [p.root.join(&r.request.from), p.root.join(&r.request.to)]
                .iter()
                .any(|path| path.starts_with(root))
            {
                return Err(Error::new("alias_conflict","An unresolved Move reserves this approved source identity. Complete it before approving a covering project."));
            }
        }
        Ok(())
    }
}

pub(super) fn validate_registry_deletions(registry: &Registry) -> Result<()> {
    for (project, rows) in &registry.pending_deletions {
        if !registry.projects.iter().any(|p| p.id == *project) || rows.len() > 1000 {
            return Err(conflict());
        }
        for (path, d) in rows {
            source_path::validate_source_path(source_identity::pending_source(path))?;
            source_path::validate_source_path(source_identity::pending_source(&d.destination))?;
            uuid(&d.move_id)?;
            uuid(&d.request_id)?;
            if d.absent_epoch == 0
                || d.absent_epoch > crate::MAX_SOURCE_EPOCH
                || d.base_mode != "100644"
                || !matches!(d.base_blob_oid.len(), 40 | 64)
                || !d.base_blob_oid.bytes().all(|b| b.is_ascii_hexdigit())
                || d.base_ref.len() != d.base_blob_oid.len()
                || !d.base_ref.bytes().all(|b| b.is_ascii_hexdigit())
            {
                return Err(conflict());
            }
        }
    }
    Ok(())
}
impl Service {
    pub(super) async fn move_checkpoint_deletions(
        &self,
        project: &Project,
        head: Option<&str>,
    ) -> Result<BTreeMap<String, OwnedDeletion>> {
        let rows = lock(&self.registry)?
            .pending_deletions
            .get(&project.id)
            .cloned()
            .unwrap_or_default();
        for (path, d) in &rows {
            self.verify_move_deletion(project, path, d)?;
            let current = if let Some(head) = head {
                git(&project.root, &["ls-tree", "-z", head, "--", path]).await?
            } else {
                String::new()
            };
            let base = format!("{} blob {}\t{}\0", d.base_mode, d.base_blob_oid, path);
            if !current.is_empty() && current != base {
                return Err(Error::new("conflict","The tracked source changed after Move captured its deletion. Saved files and the user's index were preserved."));
            }
            if current.is_empty() {
                let head = head.ok_or_else(conflict)?;
                let (status, _) = git_output(
                    &project.root,
                    &["merge-base", "--is-ancestor", &d.base_ref, head],
                    None,
                    None,
                )
                .await?;
                if !status.success() {
                    return Err(conflict());
                }
            }
        }
        Ok(rows)
    }
    pub(super) fn verify_move_deletion(
        &self,
        project: &Project,
        path: &str,
        d: &OwnedDeletion,
    ) -> Result<()> {
        let r = lock(&self.file_move)?
            .records
            .get(&d.request_id)
            .cloned()
            .ok_or_else(conflict)?;
        if r.status != Status::Moved
            || r.move_id != d.move_id
            || r.request.project != project.id
            || r.request.expected_root != d.expected_root
            || r.reserved_from != d.absent_epoch
            || r.git.base_ref.as_deref() != Some(&d.base_ref)
        {
            return Err(conflict());
        }
        let f = r
            .bundle
            .files
            .iter()
            .find(|f| format!("{}{}", r.request.from, f.member.suffix()) == path)
            .ok_or_else(conflict)?;
        let g = r
            .git
            .tracked
            .iter()
            .find(|g| g.relative == path)
            .ok_or_else(conflict)?;
        if d.destination != format!("{}{}", r.request.to, f.member.suffix())
            || g.base_blob_oid != d.base_blob_oid
            || g.base_mode != d.base_mode
        {
            return Err(conflict());
        }
        let p = self.project(&r.request.project)?;
        let from = RootedRoot::acquire(&p.root, &r.request.expected_root)?
            .source_group(&r.request.from)?;
        let member = match f.member {
            MoveMember::Source => Member::Source,
            MoveMember::Review => Member::Review,
            MoveMember::ImportReport => Member::ImportReport,
        };
        if from
            .read_bytes(
                member,
                if member == Member::Source {
                    MAX_TEXT
                } else {
                    MAX_TEXT * 8
                },
            )?
            .bytes()
            .is_some()
        {
            return Err(conflict());
        }
        let registry = lock(&self.registry)?;
        source_identity::require_in(&registry, &p.id, &r.request.from, r.reserved_from)?;
        source_identity::require_in(&registry, &p.id, &r.request.to, r.reserved_to)?;
        if !p.pending.contains(&d.destination) || !p.pending_revisions.contains_key(&d.destination)
        {
            return Err(conflict());
        }
        Ok(())
    }
}
pub(super) fn deletion_marker(deletion: &OwnedDeletion) -> Result<String> {
    Ok(format!(
        "deleted:{}",
        digest_bytes(&serde_json::to_vec(deletion)?)
    ))
}

#[cfg(test)]
impl Service {
    fn move_test_boundary(&self, point: u8) -> Result<()> {
        let hook = lock(&self.file_move)?.hooks.remove(&point);
        if let Some(hook) = hook {
            hook()?;
        }
        Ok(())
    }
}
#[cfg(all(test, target_os = "linux", target_env = "gnu"))]
mod tests;

impl Service {
    // Native ZIP output can target another approved root; it must not fill a reserved source-group name.
    pub(super) fn move_native_output_available(&self, destination: &Path) -> Result<()> {
        let moves = lock(&self.file_move)?;
        let registry = lock(&self.registry)?;
        for record in moves.records.values().filter(|r| {
            moves.running.contains(&r.request.request_id)
                || matches!(r.status, Status::Pending | Status::RecoveryRequired)
        }) {
            let p = registry
                .projects
                .iter()
                .find(|p| p.id == record.request.project)
                .ok_or_else(conflict)?;
            for path in [&record.request.from, &record.request.to] {
                for suffix in [
                    "",
                    ".undertree-review.json",
                    ".import-report.json",
                    ".undertree-pending.json",
                ] {
                    if p.root.join(format!("{path}{suffix}")) == destination {
                        return Err(pending());
                    }
                }
            }
        }
        for (project, rows) in &registry.pending_deletions {
            let p = registry
                .projects
                .iter()
                .find(|p| p.id == *project)
                .ok_or_else(conflict)?;
            if rows.keys().any(|path| p.root.join(path) == destination) {
                return Err(Error::new(
                    "move_pending_sync",
                    "An owned Move deletion reserves this output name until synchronization.",
                ));
            }
        }
        Ok(())
    }
}
