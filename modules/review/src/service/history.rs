//! Private saved-source History. Native callers own source authority and group completion.
//! Keep one store behind the existing service guard; no source paths are opened here.
pub use crate::RootObservation;
use crate::{Error, Result};
use cap_fs_ext::{DirExt, FollowSymlinks, MetadataExt, OpenOptionsFollowExt, OpenOptionsSyncExt};
use cap_std::fs::{Dir, DirBuilder, OpenOptions};
#[cfg(unix)]
use cap_std::fs::{DirBuilderExt, OpenOptionsExt};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use std::io::{Read, Write};
use std::time::{SystemTime, UNIX_EPOCH};
use uuid::Uuid;

const MAX_TEXT: u64 = 2 * 1024 * 1024;
const MAX_CATALOG: usize = 1024 * 1024;
const STEADY_PAYLOAD: u64 = 119 * 1024 * 1024;
const MAX_TOTAL: u64 = 128 * 1024 * 1024;
const MAX_RECORDS: usize = 4096;
const MAX_BINDINGS: usize = 512;
const MAX_VERSIONS: usize = 32;
const MAX_REPLY: usize = 32 * 1024 * 1024;
const MAX_EPOCH: u64 = 9_007_199_254_740_991;

fn unavailable() -> Error {
    Error::new(
        "history_unavailable",
        "Saved History is unavailable. Its existing files were preserved.",
    )
}
fn quota() -> Error {
    Error::new(
        "history_quota",
        "Saved History has no safe space for another capture. Existing versions were preserved.",
    )
}
fn uncertain() -> Error {
    Error::new("outcome_unknown", "History publication may have completed. Keep the original producer proof and inspect its outcome before retrying.")
}
fn hash(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
fn uuid(value: &str) -> Result<()> {
    if Uuid::parse_str(value).is_ok_and(|id| id.to_string() == value) {
        Ok(())
    } else {
        Err(unavailable())
    }
}
fn digest(value: &str) -> Result<()> {
    if value.len() == 64
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        Ok(())
    } else {
        Err(unavailable())
    }
}
fn now() -> Option<u64> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .ok()
        .and_then(|v| v.as_millis().try_into().ok())
}

mod decimal {
    use serde::{Deserialize, Deserializer, Serializer};
    pub fn serialize<S: Serializer>(
        value: &u64,
        serializer: S,
    ) -> std::result::Result<S::Ok, S::Error> {
        serializer.serialize_str(&value.to_string())
    }
    pub fn deserialize<'de, D: Deserializer<'de>>(
        deserializer: D,
    ) -> std::result::Result<u64, D::Error> {
        let text = String::deserialize(deserializer)?;
        let value: u64 = text.parse().map_err(serde::de::Error::custom)?;
        if text != value.to_string() {
            return Err(serde::de::Error::custom("Noncanonical decimal identifier."));
        }
        Ok(value)
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SourceBinding {
    pub project_id: String,
    pub root: RootObservation,
    pub path: String,
    pub source_epoch: u64,
}

impl SourceBinding {
    fn validate(&self) -> Result<()> {
        uuid(&self.project_id)?;
        if self.source_epoch > MAX_EPOCH {
            return Err(unavailable());
        }
        super::source_path::validate_source_path(&self.path).map_err(|_| unavailable())?;
        Ok(())
    }
}

/// A native observation of a held parent and exact existing entry spelling.
/// Root callers prove confinement, spelling, single-link source and epochs.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SourceSlot(StoredSourceSlot);

#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StoredSourceSlot {
    #[serde(with = "decimal")]
    parent_dev: u64,
    #[serde(with = "decimal")]
    parent_ino: u64,
    basename: String,
}

impl StoredSourceSlot {
    fn validate(&self) -> Result<()> {
        if self.basename.contains('/') {
            return Err(unavailable());
        }
        super::source_path::validate_source_path(&self.basename).map_err(|_| unavailable())?;
        Ok(())
    }

    fn fingerprint(&self) -> Result<String> {
        self.validate()?;
        Ok(hash(&serde_json::to_vec(self)?))
    }
}

impl SourceSlot {
    pub fn from_held_parent(parent: &Dir, actual_entry_basename: &str) -> Result<Self> {
        if !cfg!(any(unix, windows)) {
            return Err(unavailable());
        }
        let metadata = parent.dir_metadata().map_err(|_| unavailable())?;
        let slot = StoredSourceSlot {
            parent_dev: metadata.dev(),
            parent_ino: metadata.ino(),
            basename: actual_entry_basename.into(),
        };
        slot.validate()?;
        Ok(Self(slot))
    }
}

/// Constructed only after the native caller authenticates a real Save/acceptance.
/// Deliberately has no Deserialize implementation.
pub enum NativeCause {
    Save,
    Acceptance { suggestion_id: String },
}

pub struct Capture {
    pub binding: SourceBinding,
    pub slot: SourceSlot,
    pub cause: NativeCause,
    pub old_digest: String,
    pub final_review_digest: String,
    pub prior_review_digest: Option<String>,
    /// Exact producer-specific pending ownership, never the whole Registry.
    pub ownership_digest: String,
    /// Immutable producer identity, not raw pending/committed receipt JSON.
    pub receipt_fingerprint: Option<String>,
    pub captured_at_ms: Option<u64>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VersionSummary {
    pub version_id: String,
    pub namespace_id: String,
    pub source_id: String,
    pub binding: SourceBinding,
    pub sha256: String,
    pub bytes: u64,
    pub sequence: String,
    pub captured_at_ms: Option<u64>,
    pub recorded_at_ms: Option<u64>,
    pub clock_adjusted: bool,
    pub after_recovery: bool,
    pub cause: &'static str,
    pub suggestion_id: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HistoryCursor {
    pub generation: String,
    pub page_kind: String,
    pub project_id: String,
    pub namespace_id: Option<String>,
    pub source_id: Option<String>,
    pub anchor: String,
}

#[derive(Debug, Deserialize)]
#[serde(
    tag = "action",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum HistoryQuery {
    List {
        project_id: String,
        namespace_id: Option<String>,
        observed_root: Option<RootObservation>,
        source_id: Option<String>,
        cursor: Option<HistoryCursor>,
    },
    Read {
        project_id: String,
        namespace_id: String,
        source_id: String,
        version_id: String,
    },
    Compare {
        project_id: String,
        namespace_id: String,
        source_id: String,
        from_version_id: String,
        to_version_id: String,
    },
}

#[derive(Debug, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum HistoryItem {
    Namespace {
        namespace_id: String,
        project_id: String,
        root: RootObservation,
    },
    Source {
        namespace_id: String,
        source_id: String,
        path: String,
        source_epoch: u64,
    },
    Version {
        version: Box<VersionSummary>,
    },
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryPage {
    pub generation: String,
    pub namespace_id: Option<String>,
    pub items: Vec<HistoryItem>,
    pub cursor: Option<HistoryCursor>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedVersion {
    pub version: VersionSummary,
    pub content: String,
}

#[derive(Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangedSpan {
    pub from_utf16: usize,
    pub to_utf16: usize,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Comparison {
    pub from: SavedVersion,
    pub to: SavedVersion,
    pub from_changed: Option<ChangedSpan>,
    pub to_changed: Option<ChangedSpan>,
    pub method: &'static str,
}

#[derive(Debug, Serialize)]
#[serde(tag = "kind", content = "result", rename_all = "snake_case")]
pub enum HistoryReply {
    List(HistoryPage),
    Read(SavedVersion),
    Compare(Box<Comparison>),
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
enum StoredCause {
    Save,
    Acceptance { suggestion_id: String },
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct IntentCore {
    store_id: String,
    admission_generation: u64,
    event_id: String,
    binding: SourceBinding,
    slot_sha256: String,
    cause: StoredCause,
    old_digest: String,
    new_digest: String,
    bytes: u64,
    final_review_digest: String,
    prior_review_digest: Option<String>,
    ownership_digest: String,
    receipt_fingerprint: Option<String>,
    captured_at_ms: Option<u64>,
}

/// A fresh native capture, not a parsed Journal or a renderer-supplied claim.
pub struct NativeIntent {
    core: IntentCore,
    slot: SourceSlot,
    content: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HistoryReference {
    pub event_id: String,
    pub intent_core_sha256: String,
}

impl NativeIntent {
    pub fn reference(&self) -> Result<HistoryReference> {
        Ok(HistoryReference {
            event_id: self.core.event_id.clone(),
            intent_core_sha256: hash(&serde_json::to_vec(&self.core)?),
        })
    }
}

/// Caller has verified these exact applied bytes and pending registry ownership
/// through its retained source capabilities, not by trusting Journal JSON.
pub struct AppliedSource<'a> {
    pub binding: &'a SourceBinding,
    pub slot: &'a SourceSlot,
    pub content: &'a str,
    pub review_bytes: &'a [u8],
    pub ownership_digest: &'a str,
}

/// Supply only AFTER the bound Journal is durably absent and any native receipt
/// is committed. This core never checks project files or invents that evidence.
pub struct ProducerCompletion<'a> {
    pub journal_sha256: &'a str,
    pub committed_receipt_fingerprint: Option<&'a str>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ProducerPhase {
    Unarmed,
    Armed,
    CommittedPinned,
    AbortedPendingMaintenance,
}

/// Private catalog observation, never a native authorization or JSON claim.
#[derive(Clone)]
pub struct ProducerReservation {
    record: Record,
    phase: ProducerPhase,
}

impl ProducerReservation {
    pub fn reference(&self) -> &HistoryReference {
        &self.record.reference
    }

    pub fn binding(&self) -> &SourceBinding {
        &self.record.core.binding
    }

    pub fn journal_sha256(&self) -> &str {
        &self.record.journal_sha256
    }

    pub fn receipt_fingerprint(&self) -> Option<&str> {
        self.record.core.receipt_fingerprint.as_deref()
    }

    pub fn phase(&self) -> ProducerPhase {
        self.phase
    }
}

#[derive(Debug, PartialEq, Eq)]
pub enum AbortDisposition {
    AbortedPendingMaintenance,
    AlreadyAbortedPendingMaintenance,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Namespace {
    id: String,
    project_id: String,
    root: RootObservation,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Source {
    id: String,
    namespace_id: String,
    path: String,
    epoch: u64,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(tag = "stage", rename_all = "snake_case", deny_unknown_fields)]
enum Stage {
    Prepared {
        armed: bool,
    },
    Committed {
        #[serde(with = "decimal")]
        sequence: u64,
        recorded_at_ms: Option<u64>,
        recorded_at_observed: bool,
        after_recovery: bool,
        pinned: bool,
        listed: bool,
    },
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Record {
    core: IntentCore,
    reference: HistoryReference,
    journal_sha256: String,
    source_id: String,
    slot: Option<StoredSourceSlot>,
    state: Stage,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Retired {
    event_id: String,
    sha256: String,
    bytes: u64,
    origin: RetirementOrigin,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
enum RetirementOrigin {
    Retention,
    Unapplied { record: Box<Record> },
}

impl Retired {
    fn unapplied(record: Record) -> Self {
        Self {
            event_id: record.core.event_id.clone(),
            sha256: record.core.new_digest.clone(),
            bytes: record.core.bytes,
            origin: RetirementOrigin::Unapplied {
                record: Box::new(record),
            },
        }
    }
}

impl ProducerReservation {
    fn matches(&self, record: &Record) -> bool {
        self.record.core == record.core
            && self.record.reference == record.reference
            && self.record.journal_sha256 == record.journal_sha256
            && self.record.source_id == record.source_id
            && self.record.slot == record.slot
    }

    pub(super) fn check_caller(&self, binding: &SourceBinding, slot: &SourceSlot) -> Result<()> {
        binding.validate()?;
        if self.record.core.binding != *binding
            || self.record.slot.as_ref() != Some(&slot.0)
            || self.record.core.slot_sha256 != slot.0.fingerprint()?
        {
            return Err(unavailable());
        }
        Ok(())
    }
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Catalog {
    schema: u32,
    store_id: String,
    generation: u64,
    next_sequence: u64,
    namespaces: Vec<Namespace>,
    sources: Vec<Source>,
    records: Vec<Record>,
    retired: Vec<Retired>,
}

pub struct HistoryStore {
    state: Dir,
    directory: Dir,
    blobs: Dir,
    store_id: String,
    #[cfg(test)]
    failure: Option<FailurePoint>,
}

#[cfg(test)]
#[derive(Clone, Copy, PartialEq, Eq)]
enum FailurePoint {
    BeforeCatalogRename,
    AfterCatalogRename,
    AfterBlobPublish,
    BeforeRetiredDelete,
    AfterRetiredDelete,
}

fn regular(directory: &Dir, name: &str, maximum: u64) -> Result<cap_std::fs::File> {
    let mut options = OpenOptions::new();
    options.read(true).follow(FollowSymlinks::No).nonblock(true);
    let file = directory
        .open_with(name, &options)
        .map_err(|_| unavailable())?;
    let m = file.metadata().map_err(|_| unavailable())?;
    let p = directory
        .symlink_metadata(name)
        .map_err(|_| unavailable())?;
    if !m.is_file()
        || !super::source_files::plain_metadata(&m)
        || !super::source_files::plain_metadata(&p)
        || m.nlink() != 1
        || !p.is_file()
        || (m.dev(), m.ino()) != (p.dev(), p.ino())
        || m.len() > maximum
    {
        return Err(unavailable());
    }
    Ok(file)
}

fn read(directory: &Dir, name: &str, maximum: u64) -> Result<Vec<u8>> {
    let mut file = regular(directory, name, maximum)?;
    let before = file.metadata().map_err(|_| unavailable())?;
    let mut bytes = Vec::new();
    (&mut file)
        .take(maximum + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| unavailable())?;
    let after = file.metadata().map_err(|_| unavailable())?;
    let current = directory
        .symlink_metadata(name)
        .map_err(|_| unavailable())?;
    if bytes.len() as u64 > maximum
        || before.len() != bytes.len() as u64
        || after.len() != before.len()
        || !current.is_file()
        || current.nlink() != 1
        || (after.dev(), after.ino()) != (current.dev(), current.ino())
        || before.modified().ok() != after.modified().ok()
    {
        return Err(unavailable());
    }
    Ok(bytes)
}

fn absent(directory: &Dir, name: &str) -> Result<bool> {
    match directory.symlink_metadata(name) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(true),
        Err(_) => Err(unavailable()),
        Ok(_) => Ok(false),
    }
}

fn sync_dir(directory: &Dir) -> Result<()> {
    super::source_files::complete_directory_publication(directory).map_err(|_| uncertain())
}

fn sync_regular(directory: &Dir, name: &str, maximum: u64) -> Result<()> {
    let file = regular(directory, name, maximum)?;
    #[cfg(windows)]
    let file = {
        let before = file.metadata()?;
        let mut options = OpenOptions::new();
        options.read(true).write(true).follow(FollowSymlinks::No);
        let writable = directory
            .open_with(name, &options)
            .map_err(|_| uncertain())?;
        let after = writable.metadata()?;
        if (before.dev(), before.ino()) != (after.dev(), after.ino())
            || !super::source_files::plain_metadata(&after)
            || after.nlink() != 1
            || after.len() > maximum
        {
            return Err(uncertain());
        }
        writable
    };
    file.sync_all().map_err(|_| uncertain())
}
fn create(directory: &Dir, name: &str, bytes: &[u8]) -> Result<()> {
    let mut options = OpenOptions::new();
    options
        .write(true)
        .create_new(true)
        .follow(FollowSymlinks::No);
    #[cfg(windows)]
    options.sync(true);
    #[cfg(unix)]
    options.mode(0o600);
    let mut file = directory
        .open_with(name, &options)
        .map_err(|_| unavailable())?;
    file.write_all(bytes).map_err(|_| uncertain())?;
    file.sync_all().map_err(|_| uncertain())?;
    sync_dir(directory)
}
fn blob_name(id: &str) -> String {
    format!("{id}.utf8")
}

impl IntentCore {
    fn validate(&self) -> Result<()> {
        uuid(&self.store_id)?;
        uuid(&self.event_id)?;
        self.binding.validate()?;
        for value in [
            &self.slot_sha256,
            &self.old_digest,
            &self.new_digest,
            &self.final_review_digest,
            &self.ownership_digest,
        ] {
            digest(value)?;
        }
        for value in [&self.prior_review_digest, &self.receipt_fingerprint]
            .into_iter()
            .flatten()
        {
            digest(value)?;
        }
        if let StoredCause::Acceptance { suggestion_id } = &self.cause {
            uuid(suggestion_id)?;
        }
        if self.old_digest == self.new_digest || self.bytes > MAX_TEXT {
            return Err(unavailable());
        }
        Ok(())
    }
}

impl Catalog {
    fn empty(store_id: String) -> Self {
        Self {
            schema: 3,
            store_id,
            generation: 0,
            next_sequence: 1,
            namespaces: vec![],
            sources: vec![],
            records: vec![],
            retired: vec![],
        }
    }
    fn validate(&self) -> Result<()> {
        uuid(&self.store_id)?;
        if self.schema != 3
            || self.next_sequence == 0
            || self.sources.len() > MAX_BINDINGS
            || self.namespaces.len() > MAX_BINDINGS
            || self.records.len().saturating_add(self.retired.len()) > MAX_RECORDS
        {
            return Err(unavailable());
        }
        let mut ids = BTreeSet::new();
        let mut namespace_keys = BTreeSet::new();
        for n in &self.namespaces {
            uuid(&n.id)?;
            uuid(&n.project_id)?;
            if !ids.insert(&n.id) || !namespace_keys.insert((&n.project_id, n.root.dev, n.root.ino))
            {
                return Err(unavailable());
            }
        }
        let mut source_keys = BTreeSet::new();
        for s in &self.sources {
            uuid(&s.id)?;
            let n = self
                .namespaces
                .iter()
                .find(|n| n.id == s.namespace_id)
                .ok_or_else(unavailable)?;
            SourceBinding {
                project_id: n.project_id.clone(),
                root: n.root,
                path: s.path.clone(),
                source_epoch: s.epoch,
            }
            .validate()?;
            if !ids.insert(&s.id) || !source_keys.insert((&s.namespace_id, &s.path, s.epoch)) {
                return Err(unavailable());
            }
        }
        let mut sequences = BTreeSet::new();
        let mut prepared = BTreeSet::new();
        let mut slots = BTreeSet::new();
        let mut listed: BTreeMap<&str, usize> = BTreeMap::new();
        for r in &self.records {
            self.validate_record(r)?;
            if !ids.insert(&r.core.event_id) {
                return Err(unavailable());
            }
            if r.slot.as_ref().is_some_and(|slot| !slots.insert(slot)) {
                return Err(unavailable());
            }
            match r.state {
                Stage::Prepared { .. } => {
                    if !prepared.insert(&r.source_id) {
                        return Err(unavailable());
                    }
                }
                Stage::Committed {
                    sequence,
                    listed: visible,
                    recorded_at_ms,
                    recorded_at_observed,
                    pinned,
                    ..
                } => {
                    if sequence == 0
                        || sequence >= self.next_sequence
                        || !sequences.insert(sequence)
                        || (!recorded_at_observed && (recorded_at_ms.is_some() || !pinned))
                    {
                        return Err(unavailable());
                    }
                    if pinned && !prepared.insert(&r.source_id) {
                        return Err(unavailable());
                    }
                    if visible {
                        *listed.entry(&r.source_id).or_default() += 1;
                    }
                }
            }
        }
        if listed.values().any(|count| *count > MAX_VERSIONS) {
            return Err(unavailable());
        }
        for r in &self.retired {
            uuid(&r.event_id)?;
            digest(&r.sha256)?;
            if r.bytes > MAX_TEXT || !ids.insert(&r.event_id) {
                return Err(unavailable());
            }
            if let RetirementOrigin::Unapplied { record } = &r.origin {
                self.validate_record(record)?;
                if !matches!(record.state, Stage::Prepared { armed: false })
                    || record.core.event_id != r.event_id
                    || record.core.new_digest != r.sha256
                    || record.core.bytes != r.bytes
                    || !prepared.insert(&record.source_id)
                    || record.slot.as_ref().is_some_and(|slot| !slots.insert(slot))
                {
                    return Err(unavailable());
                }
            }
        }
        Ok(())
    }

    fn validate_record(&self, record: &Record) -> Result<()> {
        record.core.validate()?;
        digest(&record.journal_sha256)?;
        let source = self
            .sources
            .iter()
            .find(|s| s.id == record.source_id)
            .ok_or_else(unavailable)?;
        let namespace = self
            .namespaces
            .iter()
            .find(|n| n.id == source.namespace_id)
            .ok_or_else(unavailable)?;
        if record.core.store_id != self.store_id
            || record.reference.event_id != record.core.event_id
            || record.reference.intent_core_sha256 != hash(&serde_json::to_vec(&record.core)?)
            || record.core.admission_generation >= self.generation
            || record.core.binding.project_id != namespace.project_id
            || record.core.binding.root != namespace.root
            || record.core.binding.path != source.path
            || record.core.binding.source_epoch != source.epoch
        {
            return Err(unavailable());
        }
        match (&record.slot, &record.state) {
            (Some(slot), Stage::Prepared { .. } | Stage::Committed { pinned: true, .. }) => {
                if slot.fingerprint()? != record.core.slot_sha256
                    || record.core.binding.path.rsplit('/').next() != Some(slot.basename.as_str())
                {
                    return Err(unavailable());
                }
            }
            (None, Stage::Committed { pinned: false, .. }) => (),
            _ => return Err(unavailable()),
        }
        Ok(())
    }
    fn payload_bytes(&self) -> u64 {
        self.records
            .iter()
            .map(|r| r.core.bytes)
            .chain(self.retired.iter().map(|r| r.bytes))
            .sum()
    }

    fn reserved_size(&self) -> Result<usize> {
        let mut worst = self.clone();
        worst.generation = u64::MAX;
        worst.next_sequence = u64::MAX;
        let mut abort_growth = 0;
        for record in &mut worst.records {
            let abort_size = if matches!(record.state, Stage::Prepared { armed: false }) {
                Some(serde_json::to_vec(&Retired::unapplied(record.clone()))?.len())
            } else {
                None
            };
            match &mut record.state {
                Stage::Prepared { .. } => {
                    record.state = Stage::Committed {
                        sequence: u64::MAX,
                        recorded_at_ms: Some(u64::MAX),
                        recorded_at_observed: false,
                        after_recovery: false,
                        pinned: false,
                        listed: false,
                    }
                }
                Stage::Committed {
                    pinned,
                    listed,
                    recorded_at_ms,
                    recorded_at_observed,
                    ..
                } => {
                    *pinned = false;
                    *listed = false;
                    if !*recorded_at_observed {
                        *recorded_at_ms = Some(u64::MAX);
                    }
                }
            }
            if let Some(size) = abort_size {
                // Moving an item between arrays may add one comma.
                abort_growth += size.saturating_sub(serde_json::to_vec(record)?.len()) + 1;
            }
        }
        Ok(serde_json::to_vec(&worst)?.len() + abort_growth)
    }

    fn retire(&mut self, ids: &BTreeSet<String>) {
        self.records.retain(|r| {
            if !ids.contains(&r.core.event_id) {
                return true;
            }
            self.retired.push(Retired {
                event_id: r.core.event_id.clone(),
                sha256: r.core.new_digest.clone(),
                bytes: r.core.bytes,
                origin: RetirementOrigin::Retention,
            });
            false
        });
    }

    /// Only plans catalog ownership. Payloads remain charged until explicit GC.
    fn retention(&mut self) -> Result<()> {
        let mut remove = BTreeSet::new();
        for source in &self.sources {
            let mut versions: Vec<_> = self
                .records
                .iter_mut()
                .filter(|r| r.source_id == source.id)
                .filter_map(|r| match r.state {
                    Stage::Committed { sequence, .. } => Some((sequence, r)),
                    Stage::Prepared { .. } => None,
                })
                .collect();
            versions.sort_by_key(|(sequence, _)| std::cmp::Reverse(*sequence));
            for (index, (_, record)) in versions.into_iter().enumerate() {
                if let Stage::Committed { listed, pinned, .. } = &mut record.state {
                    *listed = index < MAX_VERSIONS;
                    if !*listed && !*pinned {
                        remove.insert(record.core.event_id.clone());
                    }
                }
            }
        }
        let mut kept: u64 = self
            .records
            .iter()
            .filter(|r| !remove.contains(&r.core.event_id))
            .map(|r| r.core.bytes)
            .sum();
        let mut candidates: Vec<_> = self
            .records
            .iter()
            .filter(|r| !remove.contains(&r.core.event_id))
            .filter_map(|r| match r.state {
                Stage::Committed {
                    sequence,
                    pinned: false,
                    ..
                } => Some((sequence, r.core.event_id.clone(), r.core.bytes)),
                _ => None,
            })
            .collect();
        candidates.sort_by_key(|(sequence, _, _)| *sequence);
        for (_, id, bytes) in candidates {
            if kept <= STEADY_PAYLOAD {
                break;
            }
            kept -= bytes;
            remove.insert(id);
        }
        if kept > STEADY_PAYLOAD {
            return Err(quota());
        }
        self.retire(&remove);
        Ok(())
    }

    fn summary(&self, record: &Record) -> Result<VersionSummary> {
        let Stage::Committed {
            sequence,
            recorded_at_ms,
            after_recovery,
            ..
        } = record.state
        else {
            return Err(unavailable());
        };
        let source = self
            .sources
            .iter()
            .find(|s| s.id == record.source_id)
            .ok_or_else(unavailable)?;
        let (cause, suggestion_id) = match &record.core.cause {
            StoredCause::Save => ("native_save", None),
            StoredCause::Acceptance { suggestion_id } => {
                ("local_acceptance", Some(suggestion_id.clone()))
            }
        };
        Ok(VersionSummary {
            version_id: record.core.event_id.clone(),
            namespace_id: source.namespace_id.clone(),
            source_id: source.id.clone(),
            binding: record.core.binding.clone(),
            sha256: record.core.new_digest.clone(),
            bytes: record.core.bytes,
            sequence: sequence.to_string(),
            captured_at_ms: record.core.captured_at_ms,
            recorded_at_ms,
            after_recovery,
            clock_adjusted: matches!((record.core.captured_at_ms, recorded_at_ms), (Some(a), Some(b)) if b < a),
            cause,
            suggestion_id,
        })
    }
}

impl HistoryStore {
    /// Pure observation, never adoption of a foreign binding found by its slot.
    pub fn producer_reservation(
        &self,
        binding: &SourceBinding,
        slot: &SourceSlot,
    ) -> Result<Option<ProducerReservation>> {
        binding.validate()?;
        slot.0.validate()?;
        let mut matches = self.producer_reservations()?.into_iter().filter(|r| {
            r.record.core.binding == *binding || r.record.slot.as_ref() == Some(&slot.0)
        });
        let first = matches.next();
        if matches.next().is_some() {
            return Err(unavailable());
        }
        Ok(first)
    }

    /// Bounded private observations for native writer/fast-forward admission.
    pub fn producer_reservations(&self) -> Result<Vec<ProducerReservation>> {
        let catalog = self.load()?.0;
        let mut found = Vec::new();
        for record in &catalog.records {
            let phase = match record.state {
                Stage::Prepared { armed: false } => ProducerPhase::Unarmed,
                Stage::Prepared { armed: true } => ProducerPhase::Armed,
                Stage::Committed { pinned: true, .. } => ProducerPhase::CommittedPinned,
                Stage::Committed { pinned: false, .. } => continue,
            };
            found.push(ProducerReservation {
                record: record.clone(),
                phase,
            });
        }
        for retired in &catalog.retired {
            if let RetirementOrigin::Unapplied { record } = &retired.origin {
                found.push(ProducerReservation {
                    record: record.as_ref().clone(),
                    phase: ProducerPhase::AbortedPendingMaintenance,
                });
            }
        }
        Ok(found)
    }

    /// Root has proved durable exact inert Journal/receipt publication under
    /// its native producer guard. Only confirmed arm permits source effects.
    pub fn arm_source_effects(
        &mut self,
        reservation: &ProducerReservation,
        binding: &SourceBinding,
        slot: &SourceSlot,
        journal: &[u8],
    ) -> Result<()> {
        if journal.len() as u64 > MAX_TEXT * 9 {
            return Err(unavailable());
        }
        reservation.check_caller(binding, slot)?;
        let (mut catalog, previous) = self.load()?;
        let index = catalog
            .records
            .iter()
            .position(|r| reservation.matches(r))
            .ok_or_else(unavailable)?;
        let record = &catalog.records[index];
        if record.journal_sha256 != hash(journal) || !matches!(record.state, Stage::Prepared { .. })
        {
            return Err(unavailable());
        }
        self.resync(record)?;
        if matches!(record.state, Stage::Prepared { armed: false }) {
            catalog.records[index].state = Stage::Prepared { armed: true };
            self.write_catalog(&mut catalog, &previous)?;
        }
        self.resync(&catalog.records[index])
    }

    /// Root holds the native producer guard, fences every old continuation and
    /// proves exact inert Journal/receipt retirement. No source cleanup here.
    pub fn abort_unapplied(
        &mut self,
        reservation: &ProducerReservation,
        binding: &SourceBinding,
        slot: &SourceSlot,
    ) -> Result<AbortDisposition> {
        reservation.check_caller(binding, slot)?;
        let (mut catalog, previous) = self.load()?;
        for retired in &catalog.retired {
            if let RetirementOrigin::Unapplied { record } = &retired.origin {
                if reservation.matches(record) {
                    self.resync_retired(retired)?;
                    return Ok(AbortDisposition::AlreadyAbortedPendingMaintenance);
                }
            }
        }
        let index = catalog
            .records
            .iter()
            .position(|r| reservation.matches(r))
            .ok_or_else(unavailable)?;
        let record = &catalog.records[index];
        if !matches!(record.state, Stage::Prepared { armed: false }) {
            return Err(unavailable());
        }
        let retired = Retired::unapplied(record.clone());
        self.resync_retired(&retired)?;
        catalog.records.remove(index);
        catalog.retired.push(retired);
        self.write_catalog(&mut catalog, &previous)?;
        self.resync_retired(catalog.retired.last().ok_or_else(unavailable)?)?;
        Ok(AbortDisposition::AbortedPendingMaintenance)
    }

    /// Pure capture planning. Fresh IDs are minted here and sealed to this
    /// catalog generation, so a pruned old intent cannot become a new event.
    pub fn capture(&self, capture: Capture, new_content: &str) -> Result<NativeIntent> {
        let catalog = self.load()?.0;
        if new_content.len() as u64 > MAX_TEXT {
            return Err(quota());
        }
        let new_digest = hash(new_content.as_bytes());
        if new_digest == capture.old_digest {
            return Err(Error::new(
                "history_unchanged",
                "Unchanged source does not create a saved version.",
            ));
        }
        if capture.binding.path.rsplit('/').next() != Some(capture.slot.0.basename.as_str()) {
            return Err(unavailable());
        }
        let cause = match capture.cause {
            NativeCause::Save => StoredCause::Save,
            NativeCause::Acceptance { suggestion_id } => StoredCause::Acceptance { suggestion_id },
        };
        let core = IntentCore {
            store_id: self.store_id.clone(),
            admission_generation: catalog.generation,
            event_id: Uuid::new_v4().to_string(),
            binding: capture.binding,
            slot_sha256: capture.slot.0.fingerprint()?,
            cause,
            old_digest: capture.old_digest,
            new_digest,
            bytes: new_content.len() as u64,
            final_review_digest: capture.final_review_digest,
            prior_review_digest: capture.prior_review_digest,
            ownership_digest: capture.ownership_digest,
            receipt_fingerprint: capture.receipt_fingerprint,
            captured_at_ms: capture.captured_at_ms,
        };
        core.validate()?;
        Ok(NativeIntent {
            core,
            slot: capture.slot,
            content: new_content.into(),
        })
    }

    pub fn prepare(&mut self, intent: &NativeIntent, journal: &[u8]) -> Result<HistoryReference> {
        if journal.len() as u64 > MAX_TEXT * 9 {
            return Err(unavailable());
        }
        intent.core.validate()?;
        if intent.core.slot_sha256 != intent.slot.0.fingerprint()?
            || intent.core.binding.path.rsplit('/').next() != Some(intent.slot.0.basename.as_str())
        {
            return Err(unavailable());
        }
        let reference = intent.reference()?;
        let journal_hash = hash(journal);
        let (mut catalog, previous) = self.load()?;
        if intent.core.store_id != self.store_id {
            return Err(unavailable());
        }
        if let Some(record) = catalog
            .records
            .iter()
            .find(|r| r.core.event_id == reference.event_id)
        {
            if record.core != intent.core
                || record.reference != reference
                || record.journal_sha256 != journal_hash
                || record.slot.as_ref() != Some(&intent.slot.0)
                || matches!(record.state, Stage::Committed { pinned: false, .. })
            {
                return Err(unavailable());
            }
        } else {
            if intent.core.admission_generation != catalog.generation
                || catalog
                    .retired
                    .iter()
                    .any(|r| r.event_id == reference.event_id)
            {
                return Err(unavailable());
            }
            if !catalog.retired.is_empty()
                || catalog.payload_bytes() > STEADY_PAYLOAD
                || catalog.records.len() + catalog.retired.len() >= MAX_RECORDS
            {
                return Err(quota());
            }
            if catalog.records.iter().any(|r| {
                (r.core.binding == intent.core.binding || r.slot.as_ref() == Some(&intent.slot.0))
                    && matches!(
                        r.state,
                        Stage::Prepared { .. } | Stage::Committed { pinned: true, .. }
                    )
            }) {
                return Err(Error::new("history_pending", "Resolve the earlier capture or its producer completion for this source before saving another version."));
            }
            let binding = &intent.core.binding;
            let namespace_id = if let Some(n) = catalog
                .namespaces
                .iter()
                .find(|n| n.project_id == binding.project_id && n.root == binding.root)
            {
                n.id.clone()
            } else {
                if catalog.namespaces.len() >= MAX_BINDINGS {
                    return Err(quota());
                }
                let id = Uuid::new_v4().to_string();
                catalog.namespaces.push(Namespace {
                    id: id.clone(),
                    project_id: binding.project_id.clone(),
                    root: binding.root,
                });
                id
            };
            let source_id = if let Some(s) = catalog.sources.iter().find(|s| {
                s.namespace_id == namespace_id
                    && s.path == binding.path
                    && s.epoch == binding.source_epoch
            }) {
                s.id.clone()
            } else {
                if catalog.sources.len() >= MAX_BINDINGS {
                    return Err(quota());
                }
                let id = Uuid::new_v4().to_string();
                catalog.sources.push(Source {
                    id: id.clone(),
                    namespace_id,
                    path: binding.path.clone(),
                    epoch: binding.source_epoch,
                });
                id
            };
            catalog.records.push(Record {
                core: intent.core.clone(),
                reference: reference.clone(),
                journal_sha256: journal_hash,
                source_id,
                slot: Some(intent.slot.0.clone()),
                state: Stage::Prepared { armed: false },
            });
            // Check final retention feasibility before the caller creates a receipt
            // or mutates source; do not prune existing versions during preparation.
            let mut planned = catalog.clone();
            let sequence = planned.next_sequence;
            planned.next_sequence = sequence.checked_add(1).ok_or_else(quota)?;
            planned.records.last_mut().ok_or_else(unavailable)?.state = Stage::Committed {
                sequence,
                recorded_at_ms: None,
                recorded_at_observed: false,
                after_recovery: false,
                pinned: true,
                listed: true,
            };
            planned.retention()?;
            // Admission relies on these exact owned bytes being deletable.
            // Discover corrupt victims before the caller mutates its source.
            for retired in &planned.retired {
                let bytes = read(&self.blobs, &blob_name(&retired.event_id), MAX_TEXT)?;
                if bytes.len() as u64 != retired.bytes || hash(&bytes) != retired.sha256 {
                    return Err(unavailable());
                }
            }
            if planned.reserved_size()? > MAX_CATALOG {
                return Err(quota());
            }
            self.write_catalog(&mut catalog, &previous)?;
        }
        let record = catalog
            .records
            .iter()
            .find(|r| r.core.event_id == reference.event_id)
            .ok_or_else(unavailable)?;
        let name = blob_name(&reference.event_id);
        if absent(&self.blobs, &name)? {
            if !matches!(record.state, Stage::Prepared { armed: false }) {
                return Err(unavailable());
            }
            create(&self.blobs, &name, intent.content.as_bytes())?;
            #[cfg(test)]
            self.fail(FailurePoint::AfterBlobPublish)?;
        }
        self.resync(record)?;
        Ok(reference)
    }

    fn matched<'a>(
        catalog: &'a Catalog,
        reference: &HistoryReference,
        binding: &SourceBinding,
        slot: &SourceSlot,
        journal: &[u8],
    ) -> Result<&'a Record> {
        uuid(&reference.event_id)?;
        digest(&reference.intent_core_sha256)?;
        binding.validate()?;
        if journal.len() as u64 > MAX_TEXT * 9 {
            return Err(unavailable());
        }
        let record = catalog
            .records
            .iter()
            .find(|r| r.reference == *reference)
            .ok_or_else(unavailable)?;
        if record.core.binding != *binding
            || record.slot.as_ref() != Some(&slot.0)
            || record.core.slot_sha256 != slot.0.fingerprint()?
            || record.journal_sha256 != hash(journal)
            || matches!(record.state, Stage::Prepared { armed: false })
            || matches!(record.state, Stage::Committed { pinned: false, .. })
        {
            return Err(unavailable());
        }
        Ok(record)
    }

    /// Verify private proof BEFORE caller recovery/source effects. A legacy or
    /// unknown Journal can never manufacture an event by matching disk bytes.
    pub fn validate_journal(
        &self,
        reference: &HistoryReference,
        binding: &SourceBinding,
        slot: &SourceSlot,
        journal: &[u8],
    ) -> Result<()> {
        let catalog = self.load()?.0;
        let record = Self::matched(&catalog, reference, binding, slot, journal)?;
        self.resync(record)
    }

    /// Native completion retry only, after the caller proved durable Journal
    /// absence. Never promotes an incomplete publication or reapplies sources.
    pub fn validate_committed_applied(
        &self,
        reservation: &ProducerReservation,
        applied: &AppliedSource<'_>,
    ) -> Result<()> {
        reservation.check_caller(applied.binding, applied.slot)?;
        if reservation.phase != ProducerPhase::CommittedPinned
            || !matches!(
                reservation.record.state,
                Stage::Committed {
                    pinned: true,
                    recorded_at_observed: true,
                    ..
                }
            )
        {
            return Err(unavailable());
        }
        let catalog = self.load()?.0;
        let record = catalog
            .records
            .iter()
            .find(|record| reservation.matches(record))
            .ok_or_else(unavailable)?;
        if !matches!(
            record.state,
            Stage::Committed {
                pinned: true,
                recorded_at_observed: true,
                ..
            }
        ) {
            return Err(unavailable());
        }
        Self::check_applied(record, applied)?;
        self.resync(record)
    }

    fn check_applied(record: &Record, applied: &AppliedSource<'_>) -> Result<()> {
        if applied.content.len() as u64 != record.core.bytes
            || applied.review_bytes.len() as u64 > MAX_TEXT * 9
            || hash(applied.content.as_bytes()) != record.core.new_digest
            || hash(applied.review_bytes) != record.core.final_review_digest
            || applied.ownership_digest != record.core.ownership_digest
        {
            return Err(unavailable());
        }
        Ok(())
    }

    pub fn finalize(
        &mut self,
        reference: &HistoryReference,
        applied: &AppliedSource<'_>,
        journal: &[u8],
        after_recovery: bool,
    ) -> Result<VersionSummary> {
        let (mut catalog, previous) = self.load()?;
        let record = Self::matched(&catalog, reference, applied.binding, applied.slot, journal)?;
        Self::check_applied(record, applied)?;
        self.resync(record)?;
        if matches!(record.state, Stage::Prepared { armed: true }) {
            let sequence = catalog.next_sequence;
            catalog.next_sequence = sequence.checked_add(1).ok_or_else(quota)?;
            let record = catalog
                .records
                .iter_mut()
                .find(|r| r.reference == *reference)
                .ok_or_else(unavailable)?;
            record.state = Stage::Committed {
                sequence,
                recorded_at_ms: None,
                recorded_at_observed: false,
                after_recovery,
                pinned: true,
                listed: true,
            };
            catalog.retention()?;
            self.write_catalog(&mut catalog, &previous)?;
        }
        let record = catalog
            .records
            .iter()
            .find(|r| r.reference == *reference)
            .ok_or_else(unavailable)?;
        self.resync(record)?;
        if matches!(
            record.state,
            Stage::Committed {
                recorded_at_observed: false,
                ..
            }
        ) {
            // Sample only after archive durability is confirmed; persist an
            // unavailable observation too so a retry cannot invent a date.
            let previous = read(&self.directory, "catalog.json", MAX_CATALOG as u64)?;
            let record = catalog
                .records
                .iter_mut()
                .find(|r| r.reference == *reference)
                .ok_or_else(unavailable)?;
            if let Stage::Committed {
                recorded_at_ms,
                recorded_at_observed,
                after_recovery: recovered,
                ..
            } = &mut record.state
            {
                *recorded_at_ms = now();
                *recorded_at_observed = true;
                *recovered = after_recovery;
            }
            self.write_catalog(&mut catalog, &previous)?;
        }
        let record = catalog
            .records
            .iter()
            .find(|r| r.reference == *reference)
            .ok_or_else(unavailable)?;
        self.resync(record)?;
        catalog.summary(record)
    }

    /// Caller already proved source/History/receipt completion and durable
    /// Journal absence; failure here means saved with maintenance pending.
    pub fn complete(
        &mut self,
        reference: &HistoryReference,
        binding: &SourceBinding,
        slot: &SourceSlot,
        completion: &ProducerCompletion<'_>,
    ) -> Result<()> {
        let (mut catalog, previous) = self.load()?;
        let record = catalog
            .records
            .iter()
            .find(|r| r.reference == *reference)
            .ok_or_else(unavailable)?;
        if record.core.binding != *binding
            || record.core.slot_sha256 != slot.0.fingerprint()?
            || record.journal_sha256 != completion.journal_sha256
            || record.core.receipt_fingerprint.as_deref()
                != completion.committed_receipt_fingerprint
            || !matches!(
                record.state,
                Stage::Committed {
                    recorded_at_observed: true,
                    ..
                }
            )
        {
            return Err(unavailable());
        }
        self.resync(record)?;
        if matches!(record.state, Stage::Committed { pinned: false, .. }) {
            return Ok(());
        }
        let record = catalog
            .records
            .iter_mut()
            .find(|r| r.reference == *reference)
            .ok_or_else(unavailable)?;
        if let Stage::Committed { pinned, .. } = &mut record.state {
            *pinned = false;
        }
        record.slot = None;
        self.write_catalog(&mut catalog, &previous)
    }

    /// Explicit, private maintenance only. Never synthesize/finalize a capture
    /// or inspect a source Journal here; pins require native completion proof.
    pub fn maintain(&mut self) -> Result<()> {
        let (mut catalog, mut previous) = self.load()?;
        let before = serde_json::to_vec(&catalog)?;
        catalog.retention()?;
        if serde_json::to_vec(&catalog)? != before {
            self.write_catalog(&mut catalog, &previous)?;
            previous = read(&self.directory, "catalog.json", MAX_CATALOG as u64)?;
        }
        while let Some(retired) = catalog.retired.first().cloned() {
            let name = blob_name(&retired.event_id);
            if !absent(&self.blobs, &name)? {
                let bytes = read(&self.blobs, &name, MAX_TEXT)?;
                if bytes.len() as u64 != retired.bytes || hash(&bytes) != retired.sha256 {
                    return Err(unavailable());
                }
                #[cfg(test)]
                self.fail(FailurePoint::BeforeRetiredDelete)?;
                self.blobs.remove_file(&name).map_err(|_| uncertain())?;
                #[cfg(test)]
                self.fail(FailurePoint::AfterRetiredDelete)?;
            }
            // Known absence after an earlier delete is not proof of directory
            // durability; sync again before removing its ownership record.
            sync_dir(&self.blobs)?;
            catalog.retired.remove(0);
            self.write_catalog(&mut catalog, &previous)?;
            previous = read(&self.directory, "catalog.json", MAX_CATALOG as u64)?;
        }
        Ok(())
    }

    pub fn query(&self, query: HistoryQuery) -> Result<HistoryReply> {
        let catalog = self.load()?.0;
        let reply = match query {
            HistoryQuery::List {
                project_id,
                namespace_id,
                observed_root,
                source_id,
                cursor,
            } => HistoryReply::List(self.list(
                &catalog,
                &project_id,
                namespace_id.as_deref(),
                observed_root,
                source_id.as_deref(),
                cursor.as_ref(),
            )?),
            HistoryQuery::Read {
                project_id,
                namespace_id,
                source_id,
                version_id,
            } => HistoryReply::Read(self.saved(
                &catalog,
                &project_id,
                &namespace_id,
                &source_id,
                &version_id,
            )?),
            HistoryQuery::Compare {
                project_id,
                namespace_id,
                source_id,
                from_version_id,
                to_version_id,
            } => {
                let from = self.saved(
                    &catalog,
                    &project_id,
                    &namespace_id,
                    &source_id,
                    &from_version_id,
                )?;
                let to = self.saved(
                    &catalog,
                    &project_id,
                    &namespace_id,
                    &source_id,
                    &to_version_id,
                )?;
                let (from_changed, to_changed) = coarse_comparison(&from.content, &to.content);
                HistoryReply::Compare(Box::new(Comparison {
                    from,
                    to,
                    from_changed,
                    to_changed,
                    method: "coarse_text_comparison",
                }))
            }
        };
        if serde_json::to_vec(&reply)?.len() > MAX_REPLY {
            return Err(Error::new(
                "history_limit",
                "The History reply exceeds its supported size.",
            ));
        }
        Ok(reply)
    }

    fn saved(
        &self,
        catalog: &Catalog,
        project: &str,
        namespace: &str,
        source: &str,
        version: &str,
    ) -> Result<SavedVersion> {
        uuid(project)?;
        uuid(namespace)?;
        uuid(source)?;
        uuid(version)?;
        let n = catalog
            .namespaces
            .iter()
            .find(|n| n.id == namespace && n.project_id == project)
            .ok_or_else(unavailable)?;
        catalog
            .sources
            .iter()
            .find(|s| s.id == source && s.namespace_id == n.id)
            .ok_or_else(unavailable)?;
        let record = catalog
            .records
            .iter()
            .find(|r| {
                r.core.event_id == version
                    && r.source_id == source
                    && matches!(r.state, Stage::Committed { listed: true, .. })
            })
            .ok_or_else(|| {
                Error::new(
                    "history_not_retained",
                    "This saved version is not retained in the selected History source.",
                )
            })?;
        Ok(SavedVersion {
            version: catalog.summary(record)?,
            content: self.payload(record)?,
        })
    }

    fn list(
        &self,
        catalog: &Catalog,
        project: &str,
        namespace: Option<&str>,
        root: Option<RootObservation>,
        source: Option<&str>,
        cursor: Option<&HistoryCursor>,
    ) -> Result<HistoryPage> {
        uuid(project)?;
        if namespace.is_some() && root.is_some() {
            return Err(unavailable());
        }
        if let Some(id) = namespace {
            uuid(id)?;
        }
        if let Some(id) = source {
            uuid(id)?;
        }
        let selected = if let Some(id) = namespace {
            Some(
                catalog
                    .namespaces
                    .iter()
                    .find(|n| n.id == id && n.project_id == project)
                    .ok_or_else(unavailable)?,
            )
        } else if let Some(root) = root {
            catalog
                .namespaces
                .iter()
                .find(|n| n.project_id == project && n.root == root)
        } else {
            None
        };
        if source.is_some() && selected.is_none() {
            return Err(unavailable());
        }
        let namespace_id = selected.map(|n| n.id.clone());
        let page_kind = if source.is_some() {
            "versions"
        } else if namespace.is_some() || root.is_some() {
            "sources"
        } else {
            "namespaces"
        };
        let mut items: Vec<(String, HistoryItem)> = vec![];
        if let (Some(n), Some(source)) = (selected, source) {
            catalog
                .sources
                .iter()
                .find(|s| s.id == source && s.namespace_id == n.id)
                .ok_or_else(unavailable)?;
            for r in catalog.records.iter().filter(|r| r.source_id == source) {
                if let Stage::Committed {
                    sequence,
                    listed: true,
                    ..
                } = r.state
                {
                    items.push((
                        format!("{:020}", u64::MAX - sequence),
                        HistoryItem::Version {
                            version: Box::new(catalog.summary(r)?),
                        },
                    ));
                }
            }
        } else if let Some(n) = selected {
            for s in catalog.sources.iter().filter(|s| s.namespace_id == n.id) {
                if catalog.records.iter().any(|r| {
                    r.source_id == s.id && matches!(r.state, Stage::Committed { listed: true, .. })
                }) {
                    items.push((
                        s.id.clone(),
                        HistoryItem::Source {
                            namespace_id: n.id.clone(),
                            source_id: s.id.clone(),
                            path: s.path.clone(),
                            source_epoch: s.epoch,
                        },
                    ));
                }
            }
        } else if page_kind == "namespaces" {
            for n in catalog
                .namespaces
                .iter()
                .filter(|n| n.project_id == project)
            {
                // Merely prepared reservations are not saved-file history.
                if catalog
                    .sources
                    .iter()
                    .filter(|s| s.namespace_id == n.id)
                    .any(|s| {
                        catalog.records.iter().any(|r| {
                            r.source_id == s.id
                                && matches!(r.state, Stage::Committed { listed: true, .. })
                        })
                    })
                {
                    items.push((
                        n.id.clone(),
                        HistoryItem::Namespace {
                            namespace_id: n.id.clone(),
                            project_id: project.into(),
                            root: n.root,
                        },
                    ));
                }
            }
        }
        items.sort_by(|a, b| a.0.cmp(&b.0));
        if let Some(cursor) = cursor {
            if cursor.generation != catalog.generation.to_string()
                || cursor.project_id != project
                || cursor.namespace_id != namespace_id
                || cursor.source_id.as_deref() != source
                || cursor.page_kind != page_kind
                || cursor.anchor.len() > 64
                || !items.iter().any(|(key, _)| key == &cursor.anchor)
            {
                return Err(Error::new(
                    "history_stale",
                    "The History list changed. Request its first page again.",
                ));
            }
            items.retain(|(key, _)| key > &cursor.anchor);
        }
        let next = if items.len() > 50 {
            Some(HistoryCursor {
                generation: catalog.generation.to_string(),
                page_kind: page_kind.into(),
                project_id: project.into(),
                namespace_id: namespace_id.clone(),
                source_id: source.map(String::from),
                anchor: items[49].0.clone(),
            })
        } else {
            None
        };
        Ok(HistoryPage {
            generation: catalog.generation.to_string(),
            namespace_id,
            items: items.into_iter().take(50).map(|(_, item)| item).collect(),
            cursor: next,
        })
    }
    /// Only a native producer that proved the Registry anchor ABSENT may call
    /// this. Recover only pristine initialization, never a populated store.
    pub fn initialize_unanchored(state: &Dir) -> Result<Uuid> {
        let store_id = if absent(state, "history-v1")? {
            Uuid::new_v4()
        } else {
            let directory = state
                .open_dir_nofollow("history-v1")
                .map_err(|_| unavailable())?;
            if absent(&directory, "catalog.json")? {
                Uuid::new_v4()
            } else {
                let raw = read(&directory, "catalog.json", MAX_CATALOG as u64)?;
                let catalog: Catalog = serde_json::from_slice(&raw).map_err(|_| unavailable())?;
                if catalog.next_sequence != 1 {
                    return Err(unavailable());
                }
                Uuid::parse_str(&catalog.store_id).map_err(|_| unavailable())?
            }
        };
        Self::initialize(state, store_id)?;
        Ok(store_id)
    }

    /// Only an explicit producer may initialize; persist its exact anchor in
    /// the Registry before capture. Queries must use open and never call this.
    pub fn initialize(state: &Dir, store_id: Uuid) -> Result<()> {
        if absent(state, "history-v1")? {
            let mut builder = DirBuilder::new();
            #[cfg(unix)]
            builder.mode(0o700);
            state.create_dir_with("history-v1", &builder)?;
            sync_dir(state)?;
        }
        let directory = state
            .open_dir_nofollow("history-v1")
            .map_err(|_| unavailable())?;
        if absent(&directory, "blobs")? {
            let names = directory.entries()?.collect::<std::io::Result<Vec<_>>>()?;
            if !names.is_empty() {
                return Err(unavailable());
            }
            let mut builder = DirBuilder::new();
            #[cfg(unix)]
            builder.mode(0o700);
            directory.create_dir_with("blobs", &builder)?;
            sync_dir(&directory)?;
        }
        let blobs = directory
            .open_dir_nofollow("blobs")
            .map_err(|_| unavailable())?;
        if blobs.entries()?.next().is_some() {
            return Err(unavailable());
        }
        if absent(&directory, "catalog.json")? {
            let names = directory.entries()?.collect::<std::io::Result<Vec<_>>>()?;
            if names.len() != 1 {
                return Err(unavailable());
            }
            create(
                &directory,
                "catalog.json",
                &serde_json::to_vec(&Catalog::empty(store_id.to_string()))?,
            )?;
        }
        let store = Self::open(state.try_clone()?, Some(store_id))?.ok_or_else(unavailable)?;
        let catalog = store.load()?.0;
        if !catalog.records.is_empty()
            || !catalog.sources.is_empty()
            || !catalog.namespaces.is_empty()
            || !catalog.retired.is_empty()
            || catalog.generation != 0
        {
            return Err(unavailable());
        }
        sync_regular(&directory, "catalog.json", MAX_CATALOG as u64)?;
        sync_dir(&blobs)?;
        sync_dir(&directory)?;
        sync_dir(state)
    }

    /// Pure. An initialized missing store, or a nonempty unanchored directory,
    /// is never reset or adopted. The supplied state capability stays native.
    pub fn open(state: Dir, expected_store_id: Option<Uuid>) -> Result<Option<Self>> {
        if absent(&state, "history-v1")? {
            return if expected_store_id.is_none() {
                Ok(None)
            } else {
                Err(unavailable())
            };
        }
        let store_id = expected_store_id.ok_or_else(unavailable)?.to_string();
        let directory = state
            .open_dir_nofollow("history-v1")
            .map_err(|_| unavailable())?;
        let blobs = directory
            .open_dir_nofollow("blobs")
            .map_err(|_| unavailable())?;
        let store = Self {
            state,
            directory,
            blobs,
            store_id,
            #[cfg(test)]
            failure: None,
        };
        store.load()?;
        Ok(Some(store))
    }

    fn check_directories(&self) -> Result<()> {
        for (held, current) in [
            (&self.directory, self.state.open_dir_nofollow("history-v1")),
            (&self.blobs, self.directory.open_dir_nofollow("blobs")),
        ] {
            let a = held.dir_metadata().map_err(|_| unavailable())?;
            let b = current
                .map_err(|_| unavailable())?
                .dir_metadata()
                .map_err(|_| unavailable())?;
            if (a.dev(), a.ino()) != (b.dev(), b.ino()) {
                return Err(unavailable());
            }
        }
        Ok(())
    }

    fn load(&self) -> Result<(Catalog, Vec<u8>)> {
        self.check_directories()?;
        let raw = read(&self.directory, "catalog.json", MAX_CATALOG as u64)?;
        let catalog: Catalog = serde_json::from_slice(&raw).map_err(|_| unavailable())?;
        catalog.validate()?;
        if catalog.store_id != self.store_id || catalog.reserved_size()? > MAX_CATALOG {
            return Err(unavailable());
        }
        let mut top = BTreeSet::new();
        for entry in self.directory.entries()?.take(4) {
            let e = entry.map_err(|_| unavailable())?;
            top.insert(e.file_name());
        }
        if top
            != ["blobs".into(), "catalog.json".into()]
                .into_iter()
                .collect()
        {
            return Err(unavailable());
        }
        let expected: BTreeMap<_, _> = catalog
            .records
            .iter()
            .map(|r| {
                (
                    blob_name(&r.core.event_id),
                    (
                        r.core.bytes,
                        matches!(r.state, Stage::Prepared { armed: false }),
                    ),
                )
            })
            .chain(
                catalog
                    .retired
                    .iter()
                    .map(|r| (blob_name(&r.event_id), (r.bytes, true))),
            )
            .collect();
        let mut seen = BTreeSet::new();
        let mut actual = raw.len() as u64;
        for entry in self.blobs.entries()?.take(MAX_RECORDS + 1) {
            let e = entry.map_err(|_| unavailable())?;
            let name = e.file_name().into_string().map_err(|_| unavailable())?;
            let (size, _) = expected.get(&name).ok_or_else(unavailable)?;
            let m = self
                .blobs
                .symlink_metadata(&name)
                .map_err(|_| unavailable())?;
            if !m.is_file() || m.nlink() != 1 || m.len() != *size || !seen.insert(name) {
                return Err(unavailable());
            }
            actual = actual.checked_add(m.len()).ok_or_else(unavailable)?;
        }
        if expected
            .iter()
            .any(|(name, (_, optional))| !optional && !seen.contains(name))
            || actual > MAX_TOTAL
            || catalog.payload_bytes() > MAX_TOTAL
        {
            return Err(unavailable());
        }
        self.check_directories()?;
        Ok((catalog, raw))
    }

    fn write_catalog(&mut self, catalog: &mut Catalog, previous: &[u8]) -> Result<()> {
        self.check_directories()?;
        catalog.generation = catalog.generation.checked_add(1).ok_or_else(quota)?;
        catalog.validate()?;
        let bytes = serde_json::to_vec(catalog)?;
        if bytes.len() > MAX_CATALOG
            || catalog.reserved_size()? > MAX_CATALOG
            || catalog.payload_bytes() + previous.len() as u64 + bytes.len() as u64 > MAX_TOTAL
        {
            return Err(quota());
        }
        if read(&self.directory, "catalog.json", MAX_CATALOG as u64)? != previous
            || !absent(&self.directory, "catalog.next")?
        {
            return Err(unavailable());
        }
        create(&self.directory, "catalog.next", &bytes)?;
        #[cfg(test)]
        self.fail(FailurePoint::BeforeCatalogRename)?;
        if read(&self.directory, "catalog.json", MAX_CATALOG as u64)? != previous {
            return Err(unavailable());
        }
        self.check_directories()?;
        self.directory
            .rename("catalog.next", &self.directory, "catalog.json")
            .map_err(|_| uncertain())?;
        #[cfg(windows)]
        sync_regular(&self.directory, "catalog.json", MAX_CATALOG as u64)?;
        #[cfg(test)]
        self.fail(FailurePoint::AfterCatalogRename)?;
        sync_dir(&self.directory)?;
        self.check_directories()
    }

    fn payload(&self, record: &Record) -> Result<String> {
        let bytes = read(&self.blobs, &blob_name(&record.core.event_id), MAX_TEXT)?;
        if bytes.len() as u64 != record.core.bytes || hash(&bytes) != record.core.new_digest {
            return Err(unavailable());
        }
        String::from_utf8(bytes).map_err(|_| unavailable())
    }

    fn resync(&self, record: &Record) -> Result<()> {
        self.payload(record)?;
        sync_regular(&self.blobs, &blob_name(&record.core.event_id), MAX_TEXT)?;
        sync_regular(&self.directory, "catalog.json", MAX_CATALOG as u64)?;
        sync_dir(&self.blobs)?;
        sync_dir(&self.directory)?;
        self.check_directories()
    }

    fn resync_retired(&self, retired: &Retired) -> Result<()> {
        let name = blob_name(&retired.event_id);
        if !absent(&self.blobs, &name)? {
            let bytes = read(&self.blobs, &name, MAX_TEXT)?;
            if bytes.len() as u64 != retired.bytes || hash(&bytes) != retired.sha256 {
                return Err(unavailable());
            }
            sync_regular(&self.blobs, &name, MAX_TEXT)?;
        }
        sync_regular(&self.directory, "catalog.json", MAX_CATALOG as u64)?;
        sync_dir(&self.blobs)?;
        sync_dir(&self.directory)?;
        self.check_directories()
    }

    #[cfg(test)]
    fn fail(&mut self, point: FailurePoint) -> Result<()> {
        if self.failure == Some(point) {
            self.failure = None;
            return Err(uncertain());
        }
        Ok(())
    }
}

fn coarse_comparison(from: &str, to: &str) -> (Option<ChangedSpan>, Option<ChangedSpan>) {
    if from == to {
        return (None, None);
    }
    let mut prefix = 0;
    for (a, b) in from.split_inclusive('\n').zip(to.split_inclusive('\n')) {
        if a != b {
            break;
        }
        prefix += a.len();
    }
    let mut suffix = 0;
    for (a, b) in from[prefix..]
        .split_inclusive('\n')
        .rev()
        .zip(to[prefix..].split_inclusive('\n').rev())
    {
        if a != b {
            break;
        }
        suffix += a.len();
    }
    let start = from[..prefix].encode_utf16().count();
    let old_end = from[..from.len() - suffix].encode_utf16().count();
    let new_end = to[..to.len() - suffix].encode_utf16().count();
    (
        Some(ChangedSpan {
            from_utf16: start,
            to_utf16: old_end,
        }),
        Some(ChangedSpan {
            from_utf16: start,
            to_utf16: new_end,
        }),
    )
}

#[cfg(test)]
mod tests;
