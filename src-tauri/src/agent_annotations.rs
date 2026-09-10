use std::collections::{BTreeMap, HashSet};
use std::fmt::Write as _;
use std::fs;
use std::io::Write;
use std::path::{Component, Path, PathBuf};
use std::sync::{Arc, Mutex};

use atomic_write_file::AtomicWriteFile;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::error::BoundaryError;

pub const AGENT_EDITING_PROTOCOL_VERSION: u32 = 1;

const STORE_VERSION: u32 = 1;
const STORE_FILE: &str = "agent-editing.json";
const MAX_STORE_BYTES: u64 = 1024 * 1024;
const MAX_SOURCE_BYTES: usize = 1024 * 1024;
const MAX_DOCUMENTS: usize = 512;
const MAX_ANNOTATIONS: usize = 512;
const MAX_ANNOTATION_BYTES: usize = 128 * 1024;
const MAX_NOTE_CHARS: usize = 1_000;

#[derive(Clone, Default)]
pub struct AgentAnnotationService {
    lock: Arc<Mutex<()>>,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum AgentAnnotationKind {
    Keep,
    Revise,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum AgentEditingScope {
    UnprotectedText,
    ReviseOnly,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentAnnotationInput {
    pub id: String,
    pub kind: AgentAnnotationKind,
    pub start_byte: usize,
    pub end_byte: usize,
    #[serde(default)]
    pub note: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentAnnotation {
    pub id: String,
    pub kind: AgentAnnotationKind,
    pub start_byte: usize,
    pub end_byte: usize,
    pub start_line: usize,
    pub end_line: usize,
    pub selected_text: String,
    pub note: Option<String>,
    pub stale: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentEditingPolicy {
    pub protocol_version: u32,
    pub policy_version: u64,
    pub path: String,
    pub source_digest: String,
    pub in_sync: bool,
    pub scope: AgentEditingScope,
    pub annotations: Vec<AgentAnnotation>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReplaceAnnotationsRequest {
    pub path: String,
    pub source: String,
    pub expected_policy_version: u64,
    pub annotations: Vec<AgentAnnotationInput>,
}

#[derive(Debug)]
pub struct PrepareAgentReplacementRequest {
    pub path: String,
    pub current_source: String,
    pub replacement_source: String,
    pub expected_policy_version: Option<u64>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AgentEditingStore {
    version: u32,
    documents: BTreeMap<String, StoredDocumentPolicy>,
}

impl Default for AgentEditingStore {
    fn default() -> Self {
        Self {
            version: STORE_VERSION,
            documents: BTreeMap::new(),
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StoredDocumentPolicy {
    policy_version: u64,
    source_digest: String,
    annotations: Vec<StoredAnnotation>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StoredAnnotation {
    id: String,
    kind: AgentAnnotationKind,
    start_byte: usize,
    end_byte: usize,
    selected_text: String,
    #[serde(default)]
    note: Option<String>,
}

impl AgentAnnotationService {
    pub fn policy(
        &self,
        root: &Path,
        path: &str,
        source: &str,
    ) -> Result<AgentEditingPolicy, BoundaryError> {
        validate_source(source)?;
        let root = validate_root(root)?;
        let path = validate_document_path(&root, path)?;
        let _guard = self.lock.lock().map_err(|_| BoundaryError::internal())?;
        let store = read_store(&root)?;
        Ok(materialize_policy(
            &path,
            source,
            store.documents.get(&path),
        ))
    }

    pub fn replace(
        &self,
        root: &Path,
        request: ReplaceAnnotationsRequest,
    ) -> Result<AgentEditingPolicy, BoundaryError> {
        validate_source(&request.source)?;
        let root = validate_root(root)?;
        let path = validate_document_path(&root, &request.path)?;
        let _guard = self.lock.lock().map_err(|_| BoundaryError::internal())?;
        let mut store = read_store(&root)?;
        let current_version = store
            .documents
            .get(&path)
            .map_or(0, |document| document.policy_version);
        if request.expected_policy_version != current_version {
            return Err(stale_policy_error(current_version));
        }

        let annotations = normalize_inputs(&request.source, request.annotations)?;
        let next_version = current_version.checked_add(1).ok_or_else(|| {
            BoundaryError::project(
                "agent_policy_exhausted",
                "The annotation policy version cannot be advanced.",
            )
        })?;
        let stored = StoredDocumentPolicy {
            policy_version: next_version,
            source_digest: source_digest(&request.source),
            annotations,
        };
        if !store.documents.contains_key(&path) && store.documents.len() >= MAX_DOCUMENTS {
            return Err(BoundaryError::project(
                "agent_policy_limit",
                "This project has reached the annotation-policy document limit.",
            ));
        }
        store.documents.insert(path.clone(), stored.clone());
        write_store(&root, &store)?;
        Ok(materialize_policy(&path, &request.source, Some(&stored)))
    }

    pub fn prepare_replacement(
        &self,
        root: &Path,
        request: PrepareAgentReplacementRequest,
    ) -> Result<AgentEditingPolicy, BoundaryError> {
        validate_source(&request.current_source)?;
        validate_source(&request.replacement_source)?;
        let root = validate_root(root)?;
        let path = validate_document_path(&root, &request.path)?;
        let _guard = self.lock.lock().map_err(|_| BoundaryError::internal())?;
        let mut store = read_store(&root)?;
        let stored = store.documents.get(&path).cloned();
        let current_version = stored.as_ref().map_or(0, |policy| policy.policy_version);
        if let Some(expected) = request.expected_policy_version
            && expected != current_version
        {
            return Err(stale_policy_error(current_version));
        }

        let policy = materialize_policy(&path, &request.current_source, stored.as_ref());
        if !policy.annotations.is_empty() && !policy.in_sync {
            return Err(BoundaryError::project(
                "agent_annotations_stale",
                "The AI editing marks no longer match this editor source. Review or remove the stale marks before an agent edit.",
            ));
        }
        if policy.annotations.iter().any(|annotation| annotation.stale) {
            return Err(BoundaryError::project(
                "agent_annotation_anchor_stale",
                "At least one AI editing mark cannot be anchored safely in the current source.",
            ));
        }

        enforce_replacement_policy(
            &request.current_source,
            &request.replacement_source,
            &policy.annotations,
        )?;

        let mut cursor = 0;
        let mut next_annotations = Vec::new();
        for annotation in policy
            .annotations
            .iter()
            .filter(|annotation| annotation.kind == AgentAnnotationKind::Keep)
        {
            let relative = request.replacement_source[cursor..]
                .find(&annotation.selected_text)
                .ok_or_else(protected_text_changed)?;
            let start_byte = cursor + relative;
            let end_byte = start_byte + annotation.selected_text.len();
            cursor = end_byte;
            next_annotations.push(StoredAnnotation {
                id: annotation.id.clone(),
                kind: annotation.kind,
                start_byte,
                end_byte,
                selected_text: annotation.selected_text.clone(),
                note: annotation.note.clone(),
            });
        }

        let next_version = current_version.checked_add(1).ok_or_else(|| {
            BoundaryError::project(
                "agent_policy_exhausted",
                "The annotation policy version cannot be advanced.",
            )
        })?;
        let next = StoredDocumentPolicy {
            policy_version: next_version,
            source_digest: source_digest(&request.replacement_source),
            annotations: next_annotations,
        };
        if !store.documents.contains_key(&path) && store.documents.len() >= MAX_DOCUMENTS {
            return Err(BoundaryError::project(
                "agent_policy_limit",
                "This project has reached the annotation-policy document limit.",
            ));
        }
        store.documents.insert(path.clone(), next.clone());
        write_store(&root, &store)?;
        Ok(materialize_policy(
            &path,
            &request.replacement_source,
            Some(&next),
        ))
    }
}

impl AgentEditingPolicy {
    pub(crate) fn validate_remote(&self, source: &str) -> bool {
        if self.protocol_version != AGENT_EDITING_PROTOCOL_VERSION
            || self.path.is_empty()
            || self.path.len() > 4096
            || self.source_digest != source_digest(source)
            || self.annotations.len() > MAX_ANNOTATIONS
        {
            return false;
        }
        let mut ids = HashSet::new();
        let mut previous_end = 0;
        for annotation in &self.annotations {
            if !valid_id(&annotation.id)
                || !ids.insert(annotation.id.as_str())
                || annotation.start_byte < previous_end
                || annotation.start_byte >= annotation.end_byte
                || annotation.end_byte > source.len()
                || !source.is_char_boundary(annotation.start_byte)
                || !source.is_char_boundary(annotation.end_byte)
                || annotation.selected_text.len() > MAX_ANNOTATION_BYTES
                || (!annotation.stale
                    && source[annotation.start_byte..annotation.end_byte]
                        != annotation.selected_text)
            {
                return false;
            }
            previous_end = annotation.end_byte;
        }
        true
    }
}

pub fn source_digest(source: &str) -> String {
    let hash = Sha256::digest(source.as_bytes());
    let mut output = String::with_capacity(hash.len() * 2);
    for byte in hash {
        write!(&mut output, "{byte:02x}").expect("writing to a string is infallible");
    }
    output
}

fn materialize_policy(
    path: &str,
    source: &str,
    stored: Option<&StoredDocumentPolicy>,
) -> AgentEditingPolicy {
    let current_digest = source_digest(source);
    let policy_version = stored.map_or(0, |policy| policy.policy_version);
    let stored_digest_matches = stored.is_none_or(|policy| policy.source_digest == current_digest);
    let mut annotations = stored
        .map(|policy| {
            policy
                .annotations
                .iter()
                .map(|annotation| materialize_annotation(source, annotation))
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    annotations.sort_by_key(|annotation| (annotation.start_byte, annotation.end_byte));
    let anchored = annotations.iter().all(|annotation| !annotation.stale);
    let scope = if annotations
        .iter()
        .any(|annotation| annotation.kind == AgentAnnotationKind::Revise)
    {
        AgentEditingScope::ReviseOnly
    } else {
        AgentEditingScope::UnprotectedText
    };
    AgentEditingPolicy {
        protocol_version: AGENT_EDITING_PROTOCOL_VERSION,
        policy_version,
        path: path.to_owned(),
        source_digest: current_digest,
        in_sync: stored_digest_matches && anchored,
        scope,
        annotations,
    }
}

fn materialize_annotation(source: &str, stored: &StoredAnnotation) -> AgentAnnotation {
    let direct_match = stored.start_byte < stored.end_byte
        && stored.end_byte <= source.len()
        && source.is_char_boundary(stored.start_byte)
        && source.is_char_boundary(stored.end_byte)
        && source[stored.start_byte..stored.end_byte] == stored.selected_text;
    let (start_byte, end_byte, stale) = if direct_match {
        (stored.start_byte, stored.end_byte, false)
    } else if let Some(start) = unique_occurrence(source, &stored.selected_text) {
        (start, start + stored.selected_text.len(), false)
    } else {
        (
            stored.start_byte.min(source.len()),
            stored.end_byte.min(source.len()),
            true,
        )
    };
    let safe_start = char_boundary_at_or_before(source, start_byte);
    let safe_end = char_boundary_at_or_before(source, end_byte).max(safe_start);
    AgentAnnotation {
        id: stored.id.clone(),
        kind: stored.kind,
        start_byte,
        end_byte,
        start_line: line_number(source, safe_start),
        end_line: line_number(source, safe_end),
        selected_text: stored.selected_text.clone(),
        note: stored.note.clone(),
        stale,
    }
}

fn normalize_inputs(
    source: &str,
    mut inputs: Vec<AgentAnnotationInput>,
) -> Result<Vec<StoredAnnotation>, BoundaryError> {
    if inputs.len() > MAX_ANNOTATIONS {
        return Err(BoundaryError::project(
            "agent_annotation_limit",
            "A document can have at most 512 AI editing marks.",
        ));
    }
    inputs.sort_by_key(|annotation| (annotation.start_byte, annotation.end_byte));
    let mut ids = HashSet::new();
    let mut previous_end = 0;
    let mut output = Vec::with_capacity(inputs.len());
    for input in inputs {
        if !valid_id(&input.id) || !ids.insert(input.id.clone()) {
            return Err(BoundaryError::project(
                "invalid_agent_annotation",
                "AI editing marks need unique bounded identifiers.",
            ));
        }
        if input.start_byte < previous_end {
            return Err(BoundaryError::project(
                "agent_annotations_overlap",
                "AI editing marks cannot overlap. Split or remove the existing mark first.",
            ));
        }
        if input.start_byte >= input.end_byte
            || input.end_byte > source.len()
            || !source.is_char_boundary(input.start_byte)
            || !source.is_char_boundary(input.end_byte)
        {
            return Err(BoundaryError::project(
                "invalid_agent_annotation_range",
                "An AI editing mark must select a non-empty UTF-8 range in the current source.",
            ));
        }
        let selected_text = &source[input.start_byte..input.end_byte];
        if selected_text.len() > MAX_ANNOTATION_BYTES {
            return Err(BoundaryError::project(
                "agent_annotation_too_large",
                "One AI editing mark can cover at most 128 KiB of source.",
            ));
        }
        let note = normalize_note(input.note)?;
        previous_end = input.end_byte;
        output.push(StoredAnnotation {
            id: input.id,
            kind: input.kind,
            start_byte: input.start_byte,
            end_byte: input.end_byte,
            selected_text: selected_text.to_owned(),
            note,
        });
    }
    Ok(output)
}

fn enforce_replacement_policy(
    current: &str,
    replacement: &str,
    annotations: &[AgentAnnotation],
) -> Result<(), BoundaryError> {
    let revise = annotations
        .iter()
        .filter(|annotation| annotation.kind == AgentAnnotationKind::Revise)
        .collect::<Vec<_>>();
    if !revise.is_empty() {
        enforce_revise_only(current, replacement, &revise)?;
        return Ok(());
    }

    let mut candidate_cursor = 0;
    for annotation in annotations
        .iter()
        .filter(|annotation| annotation.kind == AgentAnnotationKind::Keep)
    {
        let Some(relative) = replacement[candidate_cursor..].find(&annotation.selected_text) else {
            return Err(protected_text_changed());
        };
        candidate_cursor += relative + annotation.selected_text.len();
    }
    Ok(())
}

fn enforce_revise_only(
    current: &str,
    replacement: &str,
    revise: &[&AgentAnnotation],
) -> Result<(), BoundaryError> {
    let first = revise[0];
    let prefix = &current[..first.start_byte];
    if !replacement.starts_with(prefix) {
        return Err(outside_revise_changed());
    }
    let mut candidate_cursor = prefix.len();
    for (index, annotation) in revise.iter().enumerate() {
        let immutable_end = revise
            .get(index + 1)
            .map_or(current.len(), |next| next.start_byte);
        let immutable = &current[annotation.end_byte..immutable_end];
        if index + 1 == revise.len() {
            if !replacement[candidate_cursor..].ends_with(immutable) {
                return Err(outside_revise_changed());
            }
            candidate_cursor = replacement.len();
        } else if let Some(relative) = replacement[candidate_cursor..].find(immutable) {
            candidate_cursor += relative + immutable.len();
        } else {
            return Err(outside_revise_changed());
        }
    }
    if candidate_cursor != replacement.len() {
        return Err(outside_revise_changed());
    }
    Ok(())
}

fn unique_occurrence(source: &str, selected: &str) -> Option<usize> {
    if selected.is_empty() {
        return None;
    }
    let first = source.find(selected)?;
    if source[first + selected.len()..].contains(selected) {
        None
    } else {
        Some(first)
    }
}

fn line_number(source: &str, byte: usize) -> usize {
    source[..char_boundary_at_or_before(source, byte)]
        .bytes()
        .filter(|value| *value == b'\n')
        .count()
        + 1
}

fn char_boundary_at_or_before(source: &str, byte: usize) -> usize {
    let mut boundary = byte.min(source.len());
    while boundary > 0 && !source.is_char_boundary(boundary) {
        boundary -= 1;
    }
    boundary
}

fn normalize_note(note: Option<String>) -> Result<Option<String>, BoundaryError> {
    let Some(note) = note else {
        return Ok(None);
    };
    let note = note.trim();
    if note.is_empty() {
        return Ok(None);
    }
    if note.chars().count() > MAX_NOTE_CHARS
        || note
            .chars()
            .any(|character| character == '\0' || character == '\r' || character == '\n')
    {
        return Err(BoundaryError::project(
            "invalid_agent_annotation_note",
            "Annotation notes must be one line and at most 1,000 characters.",
        ));
    }
    Ok(Some(note.to_owned()))
}

fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 80
        && id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
}

fn validate_source(source: &str) -> Result<(), BoundaryError> {
    if source.len() > MAX_SOURCE_BYTES {
        return Err(BoundaryError::project(
            "document_too_large",
            "Editable documents are limited to 1 MiB.",
        ));
    }
    if source.contains('\0') {
        return Err(BoundaryError::project(
            "invalid_source",
            "Document source cannot contain NUL bytes.",
        ));
    }
    Ok(())
}

fn validate_root(root: &Path) -> Result<PathBuf, BoundaryError> {
    let canonical = root.canonicalize().map_err(|_| {
        BoundaryError::project(
            "project_unavailable",
            "The selected project is unavailable.",
        )
    })?;
    if canonical != root || !canonical.is_dir() {
        return Err(BoundaryError::project(
            "project_unavailable",
            "The selected project is no longer available at its approved location.",
        ));
    }
    Ok(canonical)
}

fn validate_document_path(root: &Path, value: &str) -> Result<String, BoundaryError> {
    let relative = Path::new(value);
    if value.is_empty()
        || relative.is_absolute()
        || relative
            .components()
            .any(|component| !matches!(component, Component::Normal(_)))
        || !relative
            .extension()
            .is_some_and(|extension| extension.eq_ignore_ascii_case("typ"))
    {
        return Err(BoundaryError::project(
            "typst_document_required",
            "AI editing marks require a relative .typ document inside the selected project.",
        ));
    }
    let candidate = root.join(relative).canonicalize().map_err(|_| {
        BoundaryError::project(
            "document_unavailable",
            "The marked Typst document is unavailable.",
        )
    })?;
    if !candidate.starts_with(root) || !candidate.is_file() {
        return Err(BoundaryError::project(
            "path_denied",
            "AI editing marks must remain inside the selected project.",
        ));
    }
    relative
        .to_str()
        .map(|path| path.replace('\\', "/"))
        .ok_or_else(|| {
            BoundaryError::project(
                "unsupported_path",
                "AI editing marks require a Unicode Typst path.",
            )
        })
}

fn store_path(root: &Path) -> Result<PathBuf, BoundaryError> {
    let directory = root.join(".undertree");
    match fs::symlink_metadata(&directory) {
        Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_dir() => {
            return Err(metadata_error());
        }
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            fs::create_dir(&directory).map_err(|_| metadata_error())?;
        }
        Err(_) => return Err(metadata_error()),
    }
    let canonical = directory.canonicalize().map_err(|_| metadata_error())?;
    if canonical != directory || !canonical.starts_with(root) {
        return Err(metadata_error());
    }
    Ok(canonical.join(STORE_FILE))
}

fn read_store(root: &Path) -> Result<AgentEditingStore, BoundaryError> {
    let path = store_path(root)?;
    let metadata = match fs::symlink_metadata(&path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(AgentEditingStore::default());
        }
        Err(_) => return Err(metadata_error()),
    };
    if metadata.file_type().is_symlink() || !metadata.is_file() || metadata.len() > MAX_STORE_BYTES
    {
        return Err(metadata_error());
    }
    let bytes = fs::read(&path).map_err(|_| metadata_error())?;
    let store: AgentEditingStore = serde_json::from_slice(&bytes).map_err(|_| metadata_error())?;
    if store.version != STORE_VERSION
        || store.documents.len() > MAX_DOCUMENTS
        || store
            .documents
            .values()
            .any(|policy| !valid_stored_policy(policy))
    {
        return Err(metadata_error());
    }
    Ok(store)
}

fn valid_stored_policy(policy: &StoredDocumentPolicy) -> bool {
    if policy.annotations.len() > MAX_ANNOTATIONS
        || policy.source_digest.len() != 64
        || !policy
            .source_digest
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit())
    {
        return false;
    }
    let mut ids = HashSet::new();
    let mut previous_end = 0;
    policy.annotations.iter().all(|annotation| {
        let note_valid = annotation.note.as_deref().is_none_or(|note| {
            !note.is_empty()
                && note.chars().count() <= MAX_NOTE_CHARS
                && !note
                    .chars()
                    .any(|character| matches!(character, '\0' | '\r' | '\n'))
        });
        let valid = valid_id(&annotation.id)
            && ids.insert(annotation.id.as_str())
            && annotation.start_byte >= previous_end
            && annotation.start_byte < annotation.end_byte
            && annotation.selected_text.len() <= MAX_ANNOTATION_BYTES
            && !annotation.selected_text.is_empty()
            && note_valid;
        previous_end = annotation.end_byte;
        valid
    })
}

fn write_store(root: &Path, store: &AgentEditingStore) -> Result<(), BoundaryError> {
    let path = store_path(root)?;
    if let Ok(metadata) = fs::symlink_metadata(&path)
        && (metadata.file_type().is_symlink() || !metadata.is_file())
    {
        return Err(metadata_error());
    }
    let bytes = serde_json::to_vec_pretty(store).map_err(|_| BoundaryError::internal())?;
    if bytes.len() as u64 > MAX_STORE_BYTES {
        return Err(BoundaryError::project(
            "agent_policy_too_large",
            "The project's AI editing metadata exceeds 1 MiB.",
        ));
    }
    let mut file = AtomicWriteFile::open(&path).map_err(|_| metadata_error())?;
    file.write_all(&bytes).map_err(|_| metadata_error())?;
    file.sync_all().map_err(|_| metadata_error())?;
    file.commit().map_err(|_| metadata_error())
}

fn stale_policy_error(current: u64) -> BoundaryError {
    BoundaryError::project(
        "stale_agent_policy",
        format!(
            "The AI editing policy changed. Read policy version {current} and retry against the current editor source."
        ),
    )
}

fn protected_text_changed() -> BoundaryError {
    BoundaryError::project(
        "protected_text_changed",
        "The proposed agent edit changes or removes text marked Keep.",
    )
}

fn outside_revise_changed() -> BoundaryError {
    BoundaryError::project(
        "outside_revise_scope",
        "Revise marks are active, so the agent may change only the amber marked ranges.",
    )
}

fn metadata_error() -> BoundaryError {
    BoundaryError::project(
        "agent_metadata_unavailable",
        "UnderTree could not safely read or write the project's AI editing metadata.",
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Barrier;
    use std::thread;

    fn project(source: &str) -> (tempfile::TempDir, PathBuf) {
        let directory = tempfile::tempdir().expect("temporary annotation project");
        fs::write(directory.path().join("main.typ"), source).expect("write Typst fixture");
        let root = directory
            .path()
            .canonicalize()
            .expect("canonical fixture root");
        (directory, root)
    }

    fn mark(
        id: &str,
        kind: AgentAnnotationKind,
        source: &str,
        selected: &str,
    ) -> AgentAnnotationInput {
        let start_byte = source.find(selected).expect("selected fixture text");
        AgentAnnotationInput {
            id: id.into(),
            kind,
            start_byte,
            end_byte: start_byte + selected.len(),
            note: None,
        }
    }

    #[derive(Debug)]
    struct MockAgentStressReport {
        racing_attackers: usize,
        racing_scope_rejections: usize,
        racing_stale_rejections: usize,
        protected_rejections: usize,
        stale_rejections: usize,
        final_policy_version: u64,
    }

    fn run_mock_agent_stress(
        racing_attackers: usize,
        concurrent_protected_attackers: usize,
        sequential_protected_attempts: usize,
        stale_attempts: usize,
    ) -> MockAgentStressReport {
        let source = "LOCKED HEADER\n\nRewrite this draft.\n\nLOCKED FOOTER\n";
        let allowed_source = "LOCKED HEADER\n\nApproved agent revision.\n\nLOCKED FOOTER\n";
        let (_directory, root) = project(source);
        let service = AgentAnnotationService::default();
        service
            .replace(
                &root,
                ReplaceAnnotationsRequest {
                    path: "main.typ".into(),
                    source: source.into(),
                    expected_policy_version: 0,
                    annotations: vec![
                        mark(
                            "keep-header",
                            AgentAnnotationKind::Keep,
                            source,
                            "LOCKED HEADER",
                        ),
                        mark(
                            "revise-body",
                            AgentAnnotationKind::Revise,
                            source,
                            "Rewrite this draft.",
                        ),
                        mark(
                            "keep-footer",
                            AgentAnnotationKind::Keep,
                            source,
                            "LOCKED FOOTER",
                        ),
                    ],
                },
            )
            .expect("arm Keep and Revise policy");

        let race_barrier = Arc::new(Barrier::new(racing_attackers + 2));
        let mut race_handles = Vec::with_capacity(racing_attackers + 1);
        for agent_id in 0..=racing_attackers {
            let service = service.clone();
            let root = root.clone();
            let race_barrier = Arc::clone(&race_barrier);
            let replacement_source = if agent_id == 0 {
                allowed_source.to_owned()
            } else {
                match agent_id % 4 {
                    0 => source.replace("LOCKED HEADER", "AGENT OVERWROTE HEADER"),
                    1 => source.replace("LOCKED FOOTER", "AGENT OVERWROTE FOOTER"),
                    2 => allowed_source.replace("LOCKED HEADER", "AGENT OVERWROTE HEADER"),
                    _ => "An agent replaced the complete protected document.\n".into(),
                }
            };
            race_handles.push(thread::spawn(move || {
                race_barrier.wait();
                let result = service
                    .prepare_replacement(
                        &root,
                        PrepareAgentReplacementRequest {
                            path: "main.typ".into(),
                            current_source: source.into(),
                            replacement_source,
                            expected_policy_version: Some(1),
                        },
                    )
                    .map(|policy| policy.policy_version)
                    .map_err(|error| error.code);
                (agent_id == 0, result)
            }));
        }
        race_barrier.wait();

        let mut racing_scope_rejections = 0;
        let mut racing_stale_rejections = 0;
        for handle in race_handles {
            let (is_permitted_agent, result) = handle.join().expect("mock racing agent joined");
            if is_permitted_agent {
                assert_eq!(
                    result.expect("the in-scope agent must eventually commit"),
                    2
                );
                continue;
            }
            match result {
                Err("outside_revise_scope") => racing_scope_rejections += 1,
                Err("stale_agent_policy") => racing_stale_rejections += 1,
                Err(code) => panic!("unexpected racing-agent rejection: {code}"),
                Ok(version) => {
                    panic!("forbidden racing agent advanced the policy to version {version}")
                }
            }
        }
        assert_eq!(
            racing_scope_rejections + racing_stale_rejections,
            racing_attackers,
            "every forbidden racing agent must be rejected"
        );

        fs::write(root.join("main.typ"), allowed_source).expect("apply permitted editor source");
        let committed = service
            .policy(&root, "main.typ", allowed_source)
            .expect("read policy after permitted agent commit");
        assert_eq!(committed.policy_version, 2);
        assert!(committed.in_sync);
        assert_eq!(committed.annotations.len(), 2);
        assert!(
            committed
                .annotations
                .iter()
                .all(|annotation| annotation.kind == AgentAnnotationKind::Keep),
            "Revise marks must be consumed while Keep marks survive"
        );

        let protected_barrier = Arc::new(Barrier::new(concurrent_protected_attackers + 1));
        let mut protected_handles = Vec::with_capacity(concurrent_protected_attackers);
        for agent_id in 0..concurrent_protected_attackers {
            let service = service.clone();
            let root = root.clone();
            let protected_barrier = Arc::clone(&protected_barrier);
            let replacement_source = match agent_id % 3 {
                0 => allowed_source.replace("LOCKED HEADER", "MUTATED HEADER"),
                1 => allowed_source.replace("LOCKED FOOTER", "MUTATED FOOTER"),
                _ => "Both protected anchors were deleted.\n".into(),
            };
            protected_handles.push(thread::spawn(move || {
                protected_barrier.wait();
                service
                    .prepare_replacement(
                        &root,
                        PrepareAgentReplacementRequest {
                            path: "main.typ".into(),
                            current_source: allowed_source.into(),
                            replacement_source,
                            expected_policy_version: Some(2),
                        },
                    )
                    .map(|policy| policy.policy_version)
                    .map_err(|error| error.code)
            }));
        }
        protected_barrier.wait();

        let mut protected_rejections = 0;
        for handle in protected_handles {
            match handle.join().expect("mock protected-text attacker joined") {
                Err("protected_text_changed") => protected_rejections += 1,
                Err(code) => panic!("unexpected protected-text rejection: {code}"),
                Ok(version) => {
                    panic!("protected-text attacker advanced the policy to version {version}")
                }
            }
        }

        for attempt in 0..sequential_protected_attempts {
            let replacement_source = if attempt % 2 == 0 {
                allowed_source.replace("LOCKED HEADER", "MUTATED HEADER")
            } else {
                allowed_source.replace("LOCKED FOOTER", "MUTATED FOOTER")
            };
            let error = service
                .prepare_replacement(
                    &root,
                    PrepareAgentReplacementRequest {
                        path: "main.typ".into(),
                        current_source: allowed_source.into(),
                        replacement_source,
                        expected_policy_version: Some(2),
                    },
                )
                .expect_err("protected-text barrage must fail closed");
            assert_eq!(error.code, "protected_text_changed");
            protected_rejections += 1;
        }

        let stale_candidate = allowed_source.replace(
            "Approved agent revision.",
            "A harmless edit proposed from a stale policy snapshot.",
        );
        let mut stale_rejections = 0;
        for _ in 0..stale_attempts {
            let error = service
                .prepare_replacement(
                    &root,
                    PrepareAgentReplacementRequest {
                        path: "main.typ".into(),
                        current_source: allowed_source.into(),
                        replacement_source: stale_candidate.clone(),
                        expected_policy_version: Some(1),
                    },
                )
                .expect_err("stale mock agent must fail closed");
            assert_eq!(error.code, "stale_agent_policy");
            stale_rejections += 1;
        }

        let final_policy = service
            .policy(&root, "main.typ", allowed_source)
            .expect("read final stress-test policy");
        assert_eq!(final_policy.policy_version, 2);
        assert!(final_policy.in_sync);
        assert_eq!(final_policy.annotations, committed.annotations);
        assert_eq!(
            fs::read_to_string(root.join("main.typ")).expect("read protected test document"),
            allowed_source,
            "rejected agents must not alter the accepted document on disk"
        );

        MockAgentStressReport {
            racing_attackers,
            racing_scope_rejections,
            racing_stale_rejections,
            protected_rejections,
            stale_rejections,
            final_policy_version: final_policy.policy_version,
        }
    }

    #[test]
    fn persists_unicode_byte_anchors_and_increments_policy_versions() {
        let source = "= Résumé\n\nKeep 🌳 this paragraph.\n";
        let (_directory, root) = project(source);
        let service = AgentAnnotationService::default();
        let policy = service
            .replace(
                &root,
                ReplaceAnnotationsRequest {
                    path: "main.typ".into(),
                    source: source.into(),
                    expected_policy_version: 0,
                    annotations: vec![mark(
                        "keep-tree",
                        AgentAnnotationKind::Keep,
                        source,
                        "Keep 🌳 this paragraph.",
                    )],
                },
            )
            .expect("persist policy");
        assert_eq!(policy.policy_version, 1);
        assert!(policy.in_sync);
        assert_eq!(
            policy.annotations[0].selected_text,
            "Keep 🌳 this paragraph."
        );
        assert_eq!(
            service
                .policy(&root, "main.typ", source)
                .expect("reload policy"),
            policy
        );
    }

    #[test]
    fn keep_marks_reject_agent_rewrites_but_allow_other_text_to_change() {
        let source = "Intro.\n\nThis paragraph is final.\n\nDraft ending.\n";
        let (_directory, root) = project(source);
        let service = AgentAnnotationService::default();
        service
            .replace(
                &root,
                ReplaceAnnotationsRequest {
                    path: "main.typ".into(),
                    source: source.into(),
                    expected_policy_version: 0,
                    annotations: vec![mark(
                        "keep-final",
                        AgentAnnotationKind::Keep,
                        source,
                        "This paragraph is final.",
                    )],
                },
            )
            .expect("persist keep mark");

        let error = service
            .prepare_replacement(
                &root,
                PrepareAgentReplacementRequest {
                    path: "main.typ".into(),
                    current_source: source.into(),
                    replacement_source:
                        "Intro.\n\nThis paragraph was rewritten.\n\nBetter ending.\n".into(),
                    expected_policy_version: Some(1),
                },
            )
            .expect_err("protected rewrite must fail");
        assert_eq!(error.code, "protected_text_changed");

        let allowed = source.replace("Draft ending.", "A much better ending.");
        let policy = service
            .prepare_replacement(
                &root,
                PrepareAgentReplacementRequest {
                    path: "main.typ".into(),
                    current_source: source.into(),
                    replacement_source: allowed,
                    expected_policy_version: Some(1),
                },
            )
            .expect("unprotected edit should pass");
        assert_eq!(policy.policy_version, 2);
        assert_eq!(policy.annotations.len(), 1);
    }

    #[test]
    fn revise_marks_are_the_only_agent_writable_ranges_and_are_consumed() {
        let source = "Fixed opening.\n\nRewrite this draft.\n\nFixed ending.\n";
        let (_directory, root) = project(source);
        let service = AgentAnnotationService::default();
        service
            .replace(
                &root,
                ReplaceAnnotationsRequest {
                    path: "main.typ".into(),
                    source: source.into(),
                    expected_policy_version: 0,
                    annotations: vec![mark(
                        "revise-draft",
                        AgentAnnotationKind::Revise,
                        source,
                        "Rewrite this draft.",
                    )],
                },
            )
            .expect("persist revise mark");

        let outside = service
            .prepare_replacement(
                &root,
                PrepareAgentReplacementRequest {
                    path: "main.typ".into(),
                    current_source: source.into(),
                    replacement_source: "Changed opening.\n\nImproved draft.\n\nFixed ending.\n"
                        .into(),
                    expected_policy_version: Some(1),
                },
            )
            .expect_err("outside-scope edit must fail");
        assert_eq!(outside.code, "outside_revise_scope");

        let policy = service
            .prepare_replacement(
                &root,
                PrepareAgentReplacementRequest {
                    path: "main.typ".into(),
                    current_source: source.into(),
                    replacement_source: "Fixed opening.\n\nImproved draft.\n\nFixed ending.\n"
                        .into(),
                    expected_policy_version: Some(1),
                },
            )
            .expect("in-scope edit should pass");
        assert_eq!(policy.policy_version, 2);
        assert!(
            policy.annotations.is_empty(),
            "revise requests are consumed"
        );
    }

    #[test]
    fn rejects_stale_versions_overlaps_and_stale_source_snapshots() {
        let source = "Alpha beta gamma.";
        let (_directory, root) = project(source);
        let service = AgentAnnotationService::default();
        let overlap = service
            .replace(
                &root,
                ReplaceAnnotationsRequest {
                    path: "main.typ".into(),
                    source: source.into(),
                    expected_policy_version: 0,
                    annotations: vec![
                        mark("one", AgentAnnotationKind::Keep, source, "Alpha beta"),
                        mark("two", AgentAnnotationKind::Revise, source, "beta gamma"),
                    ],
                },
            )
            .expect_err("overlap must fail");
        assert_eq!(overlap.code, "agent_annotations_overlap");

        service
            .replace(
                &root,
                ReplaceAnnotationsRequest {
                    path: "main.typ".into(),
                    source: source.into(),
                    expected_policy_version: 0,
                    annotations: vec![mark("keep", AgentAnnotationKind::Keep, source, "Alpha")],
                },
            )
            .expect("initial policy");
        let stale = service
            .replace(
                &root,
                ReplaceAnnotationsRequest {
                    path: "main.typ".into(),
                    source: source.into(),
                    expected_policy_version: 0,
                    annotations: Vec::new(),
                },
            )
            .expect_err("stale policy must fail");
        assert_eq!(stale.code, "stale_agent_policy");

        let stale_source = service
            .prepare_replacement(
                &root,
                PrepareAgentReplacementRequest {
                    path: "main.typ".into(),
                    current_source: "Completely different.".into(),
                    replacement_source: "Another version.".into(),
                    expected_policy_version: Some(1),
                },
            )
            .expect_err("source-policy mismatch must fail");
        assert_eq!(stale_source.code, "agent_annotations_stale");
    }

    #[test]
    fn concurrent_mock_agents_cannot_bypass_native_editing_policy() {
        let report = run_mock_agent_stress(15, 16, 128, 64);
        assert_eq!(report.racing_attackers, 15);
        assert_eq!(
            report.racing_scope_rejections + report.racing_stale_rejections,
            report.racing_attackers
        );
        assert_eq!(report.protected_rejections, 144);
        assert_eq!(report.stale_rejections, 64);
        assert_eq!(report.final_policy_version, 2);
    }

    #[test]
    #[ignore = "explicit high-volume mock-agent policy stress test"]
    fn stress_mock_agents_cannot_bypass_native_editing_policy() {
        let report = run_mock_agent_stress(127, 128, 5_000, 1_000);
        eprintln!(
            "mock-agent stress: 1 permitted commit; {} racing attacks rejected ({} by scope, {} as stale); {} protected-text attacks rejected; {} stale-policy attacks rejected; final policy version {}",
            report.racing_attackers,
            report.racing_scope_rejections,
            report.racing_stale_rejections,
            report.protected_rejections,
            report.stale_rejections,
            report.final_policy_version,
        );
        assert_eq!(report.racing_attackers, 127);
        assert_eq!(report.protected_rejections, 5_128);
        assert_eq!(report.stale_rejections, 1_000);
        assert_eq!(report.final_policy_version, 2);
    }
}
