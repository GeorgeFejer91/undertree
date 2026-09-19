#[cfg(test)]
use std::collections::BTreeSet;
use std::fmt::Write as _;
use std::fs;
use std::io::Write;
use std::path::{Component, Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use atomic_write_file::AtomicWriteFile;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::error::BoundaryError;

pub const REVIEW_SCHEMA_VERSION: u32 = 1;

const REVIEW_FILE: &str = "paper.json";
const REVIEW_TRANSACTION_FILE: &str = "review-transaction.json";
const MAX_SOURCE_BYTES: usize = 1024 * 1024;
const MAX_REVIEW_BYTES: u64 = 4 * 1024 * 1024;
const MAX_TRANSACTION_BYTES: u64 = 6 * 1024 * 1024;
const MAX_MARKS: usize = 512;
const MAX_PROPOSALS: usize = 1024;
const MAX_COMMENTS: usize = 2048;
const MAX_TEXT_BYTES: usize = 1024 * 1024;
const MAX_NOTE_CHARS: usize = 2_000;
const MAX_RATIONALE_CHARS: usize = 4_000;
const MAX_ID_CHARS: usize = 80;
const CONTEXT_CHARS: usize = 48;

#[derive(Clone, Default)]
pub struct ReviewService {
    lock: Arc<Mutex<()>>,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum ReviewMarkKind {
    Keep,
    LightEdit,
    Rework,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum ReviewProposalOperation {
    Replace,
    Delete,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum ReviewProposalStatus {
    Pending,
    Accepted,
    Rejected,
    Superseded,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum ReviewActor {
    Human,
    Ai,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum ReviewDecision {
    Accept,
    Reject,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReviewAnchor {
    pub start_byte: usize,
    pub end_byte: usize,
    pub exact: String,
    pub prefix: String,
    pub suffix: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReviewMark {
    pub id: String,
    pub kind: ReviewMarkKind,
    pub anchor: ReviewAnchor,
    #[serde(default)]
    pub note: Option<String>,
    #[serde(default)]
    pub stale: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReviewProposal {
    pub id: String,
    pub mark_id: String,
    pub operation: ReviewProposalOperation,
    pub replacement: String,
    pub rationale: String,
    pub actor: ReviewActor,
    pub status: ReviewProposalStatus,
    pub base_source_digest: String,
    pub created_at_ms: u64,
    #[serde(default)]
    pub resolved_at_ms: Option<u64>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReviewComment {
    pub id: String,
    #[serde(default)]
    pub mark_id: Option<String>,
    #[serde(default)]
    pub proposal_id: Option<String>,
    pub body: String,
    pub actor: ReviewActor,
    pub created_at_ms: u64,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ReviewProject {
    schema_version: u32,
    generation: u64,
    policy_version: u64,
    document: String,
    bibliography: String,
    source_digest: String,
    bibliography_digest: String,
    marks: Vec<ReviewMark>,
    proposals: Vec<ReviewProposal>,
    comments: Vec<ReviewComment>,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ReviewState {
    pub schema_version: u32,
    pub generation: u64,
    pub policy_version: u64,
    pub document: String,
    pub bibliography: String,
    pub source_digest: String,
    pub current_source_digest: String,
    pub bibliography_digest: String,
    pub in_sync: bool,
    pub marks: Vec<ReviewMark>,
    pub proposals: Vec<ReviewProposal>,
    pub comments: Vec<ReviewComment>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReviewMarkRequest {
    pub path: String,
    pub source: String,
    pub expected_digest: String,
    pub expected_policy_version: u64,
    #[serde(default)]
    pub id: Option<String>,
    pub kind: ReviewMarkKind,
    pub start_byte: usize,
    pub end_byte: usize,
    pub visible_text: String,
    #[serde(default)]
    pub note: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReviewRemoveMarkRequest {
    pub path: String,
    pub source: String,
    pub expected_digest: String,
    pub expected_policy_version: u64,
    pub id: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReviewProposalRequest {
    pub path: String,
    pub source: String,
    pub expected_digest: String,
    pub expected_policy_version: u64,
    #[serde(default)]
    pub id: Option<String>,
    pub mark_id: String,
    pub operation: ReviewProposalOperation,
    #[serde(default)]
    pub replacement: String,
    #[serde(default)]
    pub rationale: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReviewCommentRequest {
    pub path: String,
    pub source: String,
    pub expected_digest: String,
    pub expected_policy_version: u64,
    #[serde(default)]
    pub id: Option<String>,
    #[serde(default)]
    pub mark_id: Option<String>,
    #[serde(default)]
    pub proposal_id: Option<String>,
    pub body: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReviewDecisionRequest {
    pub path: String,
    pub source: String,
    pub expected_digest: String,
    pub expected_policy_version: u64,
    pub proposal_id: String,
    pub decision: ReviewDecision,
    #[serde(default)]
    pub feedback: Option<String>,
    pub revision: u64,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ReviewDecisionResult {
    pub revision: u64,
    pub source: String,
    pub digest: String,
    pub changed_source: bool,
    pub state: ReviewState,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ReviewTransaction {
    version: u32,
    source_path: String,
    old_source_digest: String,
    new_source: String,
    new_source_digest: String,
    old_review_digest: Option<String>,
    new_review: String,
    new_review_digest: String,
}

impl ReviewProject {
    fn new(path: &str, source: &str, bibliography_digest: String) -> Self {
        Self {
            schema_version: REVIEW_SCHEMA_VERSION,
            generation: 0,
            policy_version: 0,
            document: path.to_owned(),
            bibliography: "paper.bib".to_owned(),
            source_digest: digest(source.as_bytes()),
            bibliography_digest,
            marks: Vec::new(),
            proposals: Vec::new(),
            comments: Vec::new(),
        }
    }
}

impl ReviewService {
    pub fn state(
        &self,
        root: &Path,
        path: &str,
        source: &str,
    ) -> Result<ReviewState, BoundaryError> {
        validate_source(source)?;
        let root = validate_root(root)?;
        let path = validate_document_path(path)?;
        let _guard = self.lock.lock().map_err(|_| BoundaryError::internal())?;
        recover_transaction(&root)?;
        let bibliography_digest = bibliography_digest(&root)?;
        let mut project = load_project(&root)?
            .unwrap_or_else(|| ReviewProject::new(path, source, bibliography_digest.clone()));
        validate_project_identity(&project, path)?;

        let source_digest = digest(source.as_bytes());
        let source_is_saved =
            saved_source_digest(&root, path).ok().as_deref() == Some(&source_digest);
        if project.source_digest != source_digest && source_is_saved {
            if rebase_marks(source, &mut project.marks).is_ok() {
                supersede_pending(&mut project.proposals);
                project.source_digest = source_digest.clone();
                project.bibliography_digest = bibliography_digest.clone();
                project.generation = next_version(project.generation)?;
                project.policy_version = next_version(project.policy_version)?;
                write_project(&root, &project)?;
            }
        }
        if project.bibliography_digest != bibliography_digest {
            supersede_pending(&mut project.proposals);
            project.bibliography_digest = bibliography_digest;
            project.generation = next_version(project.generation)?;
            write_project(&root, &project)?;
        }

        Ok(materialize_state(project, source))
    }

    pub fn upsert_mark(
        &self,
        root: &Path,
        request: ReviewMarkRequest,
    ) -> Result<ReviewState, BoundaryError> {
        validate_source(&request.source)?;
        let root = validate_root(root)?;
        let path = validate_document_path(&request.path)?;
        let _guard = self.lock.lock().map_err(|_| BoundaryError::internal())?;
        recover_transaction(&root)?;
        ensure_saved_source(&root, path, &request.source, &request.expected_digest)?;

        let bibliography_digest = bibliography_digest(&root)?;
        let mut project = load_project(&root)?
            .unwrap_or_else(|| {
                ReviewProject::new(path, &request.source, bibliography_digest.clone())
            });
        validate_project_identity(&project, path)?;
        reconcile_saved_source(&root, path, &request.source, &mut project)?;
        reconcile_bibliography(&root, &mut project)?;
        if request.expected_policy_version != project.policy_version {
            return Err(stale_policy(project.policy_version));
        }

        let note = normalize_optional_text(request.note, MAX_NOTE_CHARS, "review_note_too_large")?;
        let anchor = anchor_from_visible_selection(
            &request.source,
            request.start_byte,
            request.end_byte,
            &request.visible_text,
        )?;
        let id = normalize_or_generate_id(request.id, "mark", project.generation)?;
        let mark = ReviewMark {
            id: id.clone(),
            kind: request.kind,
            anchor,
            note,
            stale: false,
        };
        if let Some(existing) = project.marks.iter_mut().find(|mark| mark.id == id) {
            *existing = mark;
        } else {
            if project.marks.len() >= MAX_MARKS {
                return Err(review_error(
                    "review_mark_limit",
                    "This project has reached the review-mark limit.",
                ));
            }
            project.marks.push(mark);
        }
        validate_mark_overlaps(&project.marks)?;
        project.marks.sort_by_key(|mark| (mark.anchor.start_byte, mark.anchor.end_byte));
        project.bibliography_digest = bibliography_digest;
        project.generation = next_version(project.generation)?;
        project.policy_version = next_version(project.policy_version)?;
        write_project(&root, &project)?;
        Ok(materialize_state(project, &request.source))
    }

    pub fn remove_mark(
        &self,
        root: &Path,
        request: ReviewRemoveMarkRequest,
    ) -> Result<ReviewState, BoundaryError> {
        validate_source(&request.source)?;
        validate_id(&request.id)?;
        let root = validate_root(root)?;
        let path = validate_document_path(&request.path)?;
        let _guard = self.lock.lock().map_err(|_| BoundaryError::internal())?;
        recover_transaction(&root)?;
        ensure_saved_source(&root, path, &request.source, &request.expected_digest)?;
        let mut project = load_project(&root)?.ok_or_else(|| {
            review_error("review_mark_missing", "The review mark no longer exists.")
        })?;
        validate_project_identity(&project, path)?;
        if request.expected_policy_version != project.policy_version {
            return Err(stale_policy(project.policy_version));
        }
        project.marks.retain(|mark| mark.id != request.id);
        project.proposals.iter_mut().for_each(|proposal| {
            if proposal.mark_id == request.id && proposal.status == ReviewProposalStatus::Pending {
                proposal.status = ReviewProposalStatus::Superseded;
                proposal.resolved_at_ms = Some(now_ms());
            }
        });
        if rebase_marks(&request.source, &mut project.marks).is_ok() {
            project.source_digest = digest(request.source.as_bytes());
        }
        project.generation = next_version(project.generation)?;
        project.policy_version = next_version(project.policy_version)?;
        write_project(&root, &project)?;
        Ok(materialize_state(project, &request.source))
    }

    pub fn create_proposal(
        &self,
        root: &Path,
        request: ReviewProposalRequest,
        actor: ReviewActor,
    ) -> Result<ReviewState, BoundaryError> {
        validate_source(&request.source)?;
        let root = validate_root(root)?;
        let path = validate_document_path(&request.path)?;
        validate_id(&request.mark_id)?;
        let _guard = self.lock.lock().map_err(|_| BoundaryError::internal())?;
        recover_transaction(&root)?;
        ensure_saved_source(&root, path, &request.source, &request.expected_digest)?;

        let mut project = load_project(&root)?.ok_or_else(|| {
            review_error(
                "review_metadata_missing",
                "Create a review mark before proposing an edit.",
            )
        })?;
        validate_project_identity(&project, path)?;
        reconcile_saved_source(&root, path, &request.source, &mut project)?;
        reconcile_bibliography(&root, &mut project)?;
        if request.expected_policy_version != project.policy_version {
            return Err(stale_policy(project.policy_version));
        }
        let mark = project
            .marks
            .iter()
            .find(|mark| mark.id == request.mark_id)
            .ok_or_else(|| review_error("review_mark_missing", "The review mark no longer exists."))?
            .clone();
        if mark.kind == ReviewMarkKind::Keep {
            return Err(review_error(
                "review_mark_protected",
                "Protected text cannot receive a replacement proposal.",
            ));
        }
        if mark.stale {
            return Err(review_error(
                "review_mark_stale",
                "This review mark no longer maps safely to the current source.",
            ));
        }

        let replacement = normalize_text(
            request.replacement,
            MAX_TEXT_BYTES,
            "review_proposal_too_large",
        )?;
        if request.operation == ReviewProposalOperation::Delete && !replacement.is_empty() {
            return Err(review_error(
                "review_proposal_invalid",
                "A delete proposal cannot also contain replacement text.",
            ));
        }
        if request.operation == ReviewProposalOperation::Replace && replacement.is_empty() {
            return Err(review_error(
                "review_proposal_invalid",
                "A replacement proposal needs replacement text.",
            ));
        }
        if mark.kind == ReviewMarkKind::LightEdit {
            if request.operation == ReviewProposalOperation::Delete {
                return Err(review_error(
                    "review_light_edit_delete",
                    "A Light edit mark cannot be deleted. Change the mark to Rework first.",
                ));
            }
            validate_light_edit(&mark.anchor.exact, &replacement)?;
        }
        let rationale = normalize_text(
            request.rationale,
            MAX_RATIONALE_CHARS,
            "review_rationale_too_large",
        )?;
        if project.proposals.len() >= MAX_PROPOSALS {
            return Err(review_error(
                "review_proposal_limit",
                "This project has reached the proposal-history limit.",
            ));
        }
        let id = normalize_or_generate_id(request.id, "proposal", project.generation)?;
        if let Some(existing) = project.proposals.iter().find(|proposal| proposal.id == id) {
            if existing.mark_id == mark.id
                && existing.operation == request.operation
                && existing.replacement == replacement
                && existing.rationale == rationale
                && existing.actor == actor
            {
                return Ok(materialize_state(project, &request.source));
            }
            return Err(review_error(
                "review_proposal_id_conflict",
                "This proposal identifier already belongs to different review content.",
            ));
        }
        project.proposals.push(ReviewProposal {
            id,
            mark_id: mark.id,
            operation: request.operation,
            replacement,
            rationale,
            actor,
            status: ReviewProposalStatus::Pending,
            base_source_digest: project.source_digest.clone(),
            created_at_ms: now_ms(),
            resolved_at_ms: None,
        });
        project.generation = next_version(project.generation)?;
        write_project(&root, &project)?;
        Ok(materialize_state(project, &request.source))
    }

    pub fn add_comment(
        &self,
        root: &Path,
        request: ReviewCommentRequest,
        actor: ReviewActor,
    ) -> Result<ReviewState, BoundaryError> {
        validate_source(&request.source)?;
        let root = validate_root(root)?;
        let path = validate_document_path(&request.path)?;
        let _guard = self.lock.lock().map_err(|_| BoundaryError::internal())?;
        recover_transaction(&root)?;
        ensure_saved_source(&root, path, &request.source, &request.expected_digest)?;
        let mut project = load_project(&root)?.ok_or_else(|| {
            review_error(
                "review_metadata_missing",
                "Create a review mark before adding review comments.",
            )
        })?;
        validate_project_identity(&project, path)?;
        reconcile_saved_source(&root, path, &request.source, &mut project)?;
        reconcile_bibliography(&root, &mut project)?;
        if request.expected_policy_version != project.policy_version {
            return Err(stale_policy(project.policy_version));
        }
        if let Some(mark_id) = request.mark_id.as_deref() {
            validate_id(mark_id)?;
            if !project.marks.iter().any(|mark| mark.id == mark_id) {
                return Err(review_error("review_mark_missing", "The review mark no longer exists."));
            }
        }
        if let Some(proposal_id) = request.proposal_id.as_deref() {
            validate_id(proposal_id)?;
            if !project.proposals.iter().any(|proposal| proposal.id == proposal_id) {
                return Err(review_error(
                    "review_proposal_missing",
                    "The review proposal no longer exists.",
                ));
            }
        }
        if project.comments.len() >= MAX_COMMENTS {
            return Err(review_error(
                "review_comment_limit",
                "This project has reached the review-comment limit.",
            ));
        }
        let body = normalize_text(request.body, MAX_NOTE_CHARS, "review_comment_too_large")?;
        if body.trim().is_empty() {
            return Err(review_error(
                "review_comment_empty",
                "A review comment cannot be empty.",
            ));
        }
        let id = normalize_or_generate_id(request.id, "comment", project.generation)?;
        if let Some(existing) = project.comments.iter().find(|comment| comment.id == id) {
            if existing.mark_id == request.mark_id
                && existing.proposal_id == request.proposal_id
                && existing.body == body
                && existing.actor == actor
            {
                return Ok(materialize_state(project, &request.source));
            }
            return Err(review_error(
                "review_comment_id_conflict",
                "This comment identifier already belongs to different review content.",
            ));
        }
        project.comments.push(ReviewComment {
            id,
            mark_id: request.mark_id,
            proposal_id: request.proposal_id,
            body,
            actor,
            created_at_ms: now_ms(),
        });
        project.generation = next_version(project.generation)?;
        write_project(&root, &project)?;
        Ok(materialize_state(project, &request.source))
    }

    pub fn decide(
        &self,
        root: &Path,
        request: ReviewDecisionRequest,
    ) -> Result<ReviewDecisionResult, BoundaryError> {
        validate_source(&request.source)?;
        validate_id(&request.proposal_id)?;
        let root = validate_root(root)?;
        let path = validate_document_path(&request.path)?;
        let _guard = self.lock.lock().map_err(|_| BoundaryError::internal())?;
        recover_transaction(&root)?;
        ensure_saved_source(&root, path, &request.source, &request.expected_digest)?;

        let old_review_digest = review_digest(&root)?;
        let mut project = load_project(&root)?.ok_or_else(|| {
            review_error("review_proposal_missing", "The review proposal no longer exists.")
        })?;
        validate_project_identity(&project, path)?;
        reconcile_saved_source(&root, path, &request.source, &mut project)?;
        reconcile_bibliography(&root, &mut project)?;
        if request.expected_policy_version != project.policy_version {
            return Err(stale_policy(project.policy_version));
        }
        let proposal_index = project
            .proposals
            .iter()
            .position(|proposal| proposal.id == request.proposal_id)
            .ok_or_else(|| {
                review_error(
                    "review_proposal_missing",
                    "The review proposal no longer exists.",
                )
            })?;
        if project.proposals[proposal_index].status != ReviewProposalStatus::Pending {
            return Err(review_error(
                "review_proposal_resolved",
                "This proposal has already been resolved.",
            ));
        }

        if request.decision == ReviewDecision::Reject {
            project.proposals[proposal_index].status = ReviewProposalStatus::Rejected;
            project.proposals[proposal_index].resolved_at_ms = Some(now_ms());
            if let Some(feedback) = normalize_optional_text(
                request.feedback,
                MAX_NOTE_CHARS,
                "review_comment_too_large",
            )? {
                if project.comments.len() >= MAX_COMMENTS {
                    return Err(review_error(
                        "review_comment_limit",
                        "This project has reached the review-comment limit.",
                    ));
                }
                project.comments.push(ReviewComment {
                    id: generate_id("comment", project.generation),
                    mark_id: Some(project.proposals[proposal_index].mark_id.clone()),
                    proposal_id: Some(project.proposals[proposal_index].id.clone()),
                    body: feedback,
                    actor: ReviewActor::Human,
                    created_at_ms: now_ms(),
                });
            }
            project.generation = next_version(project.generation)?;
            write_project(&root, &project)?;
            let state = materialize_state(project, &request.source);
            return Ok(ReviewDecisionResult {
                revision: request.revision,
                source: request.source,
                digest: request.expected_digest,
                changed_source: false,
                state,
            });
        }

        let proposal = project.proposals[proposal_index].clone();
        if proposal.base_source_digest != project.source_digest {
            return Err(review_error(
                "review_proposal_stale",
                "The manuscript changed after this proposal was created.",
            ));
        }
        let mark_index = project
            .marks
            .iter()
            .position(|mark| mark.id == proposal.mark_id)
            .ok_or_else(|| {
                review_error(
                    "review_mark_missing",
                    "The target review mark no longer exists.",
                )
            })?;
        let mark = project.marks[mark_index].clone();
        if request
            .source
            .get(mark.anchor.start_byte..mark.anchor.end_byte)
            != Some(mark.anchor.exact.as_str())
        {
            return Err(review_error(
                "review_mark_stale",
                "The target review mark no longer matches the manuscript.",
            ));
        }
        if mark.kind == ReviewMarkKind::Keep {
            return Err(review_error(
                "review_mark_protected",
                "Protected text cannot be accepted as an edit.",
            ));
        }

        let insert = match proposal.operation {
            ReviewProposalOperation::Replace => proposal.replacement.clone(),
            ReviewProposalOperation::Delete => String::new(),
        };
        if mark.kind == ReviewMarkKind::LightEdit {
            validate_light_edit(&mark.anchor.exact, &insert)?;
        }

        let mut new_source = String::with_capacity(
            request.source.len() - (mark.anchor.end_byte - mark.anchor.start_byte) + insert.len(),
        );
        new_source.push_str(&request.source[..mark.anchor.start_byte]);
        new_source.push_str(&insert);
        new_source.push_str(&request.source[mark.anchor.end_byte..]);
        validate_source(&new_source)?;

        project.proposals[proposal_index].status = ReviewProposalStatus::Accepted;
        project.proposals[proposal_index].resolved_at_ms = Some(now_ms());
        project.marks.remove(mark_index);
        supersede_pending_except(&mut project.proposals, &proposal.id);
        let delta = insert.len() as isize - (mark.anchor.end_byte - mark.anchor.start_byte) as isize;
        shift_marks_after(
            &mut project.marks,
            mark.anchor.end_byte,
            delta,
            &new_source,
        )?;
        project.source_digest = digest(new_source.as_bytes());
        project.bibliography_digest = bibliography_digest(&root)?;
        project.generation = next_version(project.generation)?;
        project.policy_version = next_version(project.policy_version)?;

        write_acceptance_transaction(
            &root,
            path,
            &request.expected_digest,
            old_review_digest,
            &new_source,
            &project,
        )?;
        let new_digest = digest(new_source.as_bytes());
        let state = materialize_state(project, &new_source);
        Ok(ReviewDecisionResult {
            revision: request.revision,
            source: new_source,
            digest: new_digest,
            changed_source: true,
            state,
        })
    }
}

pub fn create_compact_project_files(root: &Path, title: &str) -> Result<(), BoundaryError> {
    if !root.is_dir() {
        return Err(review_error(
            "project_create_failed",
            "The new UnderTree project folder is unavailable.",
        ));
    }
    for name in ["paper.typ", "paper.bib", REVIEW_FILE] {
        if root.join(name).exists() {
            return Err(review_error(
                "project_create_failed",
                "The new project destination already contains UnderTree writing files.",
            ));
        }
    }
    let safe_title = title.replace(['\r', '\n', '\0'], " ").trim().to_owned();
    let source = format!(
        "#set page(paper: \"a4\", margin: 2.2cm)\n#set text(size: 11pt)\n\n= {safe_title}\n\nStart writing here.\n"
    );
    let bib = "% UnderTree bibliography\n";
    atomic_write(&root.join("paper.typ"), source.as_bytes()).map_err(|_| {
        review_error(
            "project_create_failed",
            "UnderTree could not create paper.typ safely.",
        )
    })?;
    atomic_write(&root.join("paper.bib"), bib.as_bytes()).map_err(|_| {
        review_error(
            "project_create_failed",
            "UnderTree could not create paper.bib safely.",
        )
    })?;
    let project = ReviewProject::new("paper.typ", &source, digest(bib.as_bytes()));
    write_project(root, &project)
}

fn materialize_state(mut project: ReviewProject, source: &str) -> ReviewState {
    for mark in &mut project.marks {
        mark.stale = source
            .get(mark.anchor.start_byte..mark.anchor.end_byte)
            != Some(mark.anchor.exact.as_str());
    }
    let current_source_digest = digest(source.as_bytes());
    ReviewState {
        schema_version: project.schema_version,
        generation: project.generation,
        policy_version: project.policy_version,
        document: project.document,
        bibliography: project.bibliography,
        source_digest: project.source_digest.clone(),
        current_source_digest: current_source_digest.clone(),
        bibliography_digest: project.bibliography_digest,
        in_sync: project.source_digest == current_source_digest
            && project.marks.iter().all(|mark| !mark.stale),
        marks: project.marks,
        proposals: project.proposals,
        comments: project.comments,
    }
}

fn validate_project_identity(project: &ReviewProject, path: &str) -> Result<(), BoundaryError> {
    if project.schema_version != REVIEW_SCHEMA_VERSION {
        return Err(review_error(
            "review_schema_unsupported",
            "This paper.json uses an unsupported UnderTree review schema.",
        ));
    }
    if project.document != path {
        return Err(review_error(
            "review_document_mismatch",
            "This paper.json belongs to a different manuscript file.",
        ));
    }
    Ok(())
}

fn reconcile_saved_source(
    root: &Path,
    path: &str,
    source: &str,
    project: &mut ReviewProject,
) -> Result<(), BoundaryError> {
    let current = digest(source.as_bytes());
    if project.source_digest == current {
        return Ok(());
    }
    ensure_saved_source(root, path, source, &current)?;
    rebase_marks(source, &mut project.marks)?;
    supersede_pending(&mut project.proposals);
    project.source_digest = current;
    project.bibliography_digest = bibliography_digest(root)?;
    project.generation = next_version(project.generation)?;
    project.policy_version = next_version(project.policy_version)?;
    Ok(())
}

fn anchor_from_visible_selection(
    source: &str,
    start: usize,
    end: usize,
    visible_text: &str,
) -> Result<ReviewAnchor, BoundaryError> {
    if start >= end
        || end > source.len()
        || !source.is_char_boundary(start)
        || !source.is_char_boundary(end)
    {
        return Err(review_error(
            "review_selection_invalid",
            "Select a non-empty rendered prose range that maps to valid source text.",
        ));
    }
    let exact = &source[start..end];
    if normalize_visible(exact) != normalize_visible(visible_text) {
        return Err(review_error(
            "review_selection_ambiguous",
            "This PDF selection does not map cleanly to one source-text range.",
        ));
    }
    Ok(ReviewAnchor {
        start_byte: start,
        end_byte: end,
        exact: exact.to_owned(),
        prefix: context_prefix(&source[..start]),
        suffix: context_suffix(&source[end..]),
    })
}

fn rebase_marks(source: &str, marks: &mut [ReviewMark]) -> Result<(), BoundaryError> {
    for mark in marks.iter_mut() {
        if source
            .get(mark.anchor.start_byte..mark.anchor.end_byte)
            == Some(mark.anchor.exact.as_str())
        {
            mark.stale = false;
            continue;
        }
        let mut matches = source
            .match_indices(&mark.anchor.exact)
            .map(|(index, _)| index)
            .collect::<Vec<_>>();
        if matches.is_empty() {
            return Err(review_error(
                "review_mark_stale",
                "A review mark cannot be anchored safely after the manuscript changed.",
            ));
        }
        if matches.len() > 1 {
            matches.retain(|start| {
                let end = *start + mark.anchor.exact.len();
                source[..*start].ends_with(&mark.anchor.prefix)
                    && source[end..].starts_with(&mark.anchor.suffix)
            });
        }
        if matches.len() != 1 {
            return Err(review_error(
                "review_mark_ambiguous",
                "A review mark now matches more than one manuscript location.",
            ));
        }
        let start = matches[0];
        mark.anchor.start_byte = start;
        mark.anchor.end_byte = start + mark.anchor.exact.len();
        mark.anchor.prefix = context_prefix(&source[..start]);
        mark.anchor.suffix = context_suffix(&source[mark.anchor.end_byte..]);
        mark.stale = false;
    }
    validate_mark_overlaps(marks)
}

fn validate_mark_overlaps(marks: &[ReviewMark]) -> Result<(), BoundaryError> {
    let mut ranges = marks
        .iter()
        .map(|mark| (mark.anchor.start_byte, mark.anchor.end_byte, mark.id.as_str()))
        .collect::<Vec<_>>();
    ranges.sort_by_key(|(start, end, _)| (*start, *end));
    for pair in ranges.windows(2) {
        if pair[1].0 < pair[0].1 {
            return Err(review_error(
                "review_mark_overlap",
                "Review marks cannot overlap. Split or remove the existing mark first.",
            ));
        }
    }
    Ok(())
}

fn shift_marks_after(
    marks: &mut [ReviewMark],
    replaced_end: usize,
    delta: isize,
    new_source: &str,
) -> Result<(), BoundaryError> {
    for mark in marks.iter_mut() {
        if mark.anchor.start_byte >= replaced_end {
            mark.anchor.start_byte = shift_offset(mark.anchor.start_byte, delta)?;
            mark.anchor.end_byte = shift_offset(mark.anchor.end_byte, delta)?;
        }
        if new_source
            .get(mark.anchor.start_byte..mark.anchor.end_byte)
            != Some(mark.anchor.exact.as_str())
        {
            return Err(review_error(
                "review_mark_stale",
                "Another review mark could not be preserved while accepting this proposal.",
            ));
        }
        mark.anchor.prefix = context_prefix(&new_source[..mark.anchor.start_byte]);
        mark.anchor.suffix = context_suffix(&new_source[mark.anchor.end_byte..]);
        mark.stale = false;
    }
    validate_mark_overlaps(marks)
}

fn shift_offset(value: usize, delta: isize) -> Result<usize, BoundaryError> {
    if delta >= 0 {
        value
            .checked_add(delta as usize)
            .ok_or_else(BoundaryError::internal)
    } else {
        value
            .checked_sub(delta.unsigned_abs())
            .ok_or_else(BoundaryError::internal)
    }
}

fn validate_light_edit(original: &str, replacement: &str) -> Result<(), BoundaryError> {
    if citation_tokens(original) != citation_tokens(replacement) {
        return Err(review_error(
            "review_citation_changed",
            "A Light edit must preserve every citation key. Use Rework for citation changes.",
        ));
    }
    if numeric_tokens(original) != numeric_tokens(replacement) {
        return Err(review_error(
            "review_number_changed",
            "A Light edit must preserve numerical values. Use Rework for substantive changes.",
        ));
    }
    Ok(())
}

fn citation_tokens(text: &str) -> Vec<String> {
    let mut tokens = Vec::new();
    let chars = text.char_indices().collect::<Vec<_>>();
    let mut index = 0;
    while index < chars.len() {
        if chars[index].1 != '@' {
            index += 1;
            continue;
        }
        let start = chars[index].0;
        let mut end = start + 1;
        index += 1;
        while index < chars.len() {
            let character = chars[index].1;
            if character.is_alphanumeric() || matches!(character, '_' | '-' | ':' | '.') {
                end = chars[index].0 + character.len_utf8();
                index += 1;
            } else {
                break;
            }
        }
        if end > start + 1 {
            tokens.push(text[start..end].to_owned());
        }
    }
    tokens.sort();
    tokens
}

fn numeric_tokens(text: &str) -> Vec<String> {
    let mut tokens = Vec::new();
    let mut current = String::new();
    for character in text.chars() {
        if character.is_ascii_digit()
            || (!current.is_empty() && matches!(character, '.' | ',' | '%' | '−' | '-'))
        {
            current.push(character);
        } else if !current.is_empty() {
            let token = current.trim_end_matches(['.', ',', '-', '−']).to_owned();
            if !token.is_empty() {
                tokens.push(token);
            }
            current.clear();
        }
    }
    if !current.is_empty() {
        let token = current.trim_end_matches(['.', ',', '-', '−']).to_owned();
        if !token.is_empty() {
            tokens.push(token);
        }
    }
    tokens.sort();
    tokens
}

fn reconcile_bibliography(
    root: &Path,
    project: &mut ReviewProject,
) -> Result<(), BoundaryError> {
    let current = bibliography_digest(root)?;
    if project.bibliography_digest != current {
        supersede_pending(&mut project.proposals);
        project.bibliography_digest = current;
        project.generation = next_version(project.generation)?;
    }
    Ok(())
}

fn supersede_pending(proposals: &mut [ReviewProposal]) {
    for proposal in proposals {
        if proposal.status == ReviewProposalStatus::Pending {
            proposal.status = ReviewProposalStatus::Superseded;
            proposal.resolved_at_ms = Some(now_ms());
        }
    }
}

fn supersede_pending_except(proposals: &mut [ReviewProposal], accepted_id: &str) {
    for proposal in proposals {
        if proposal.id != accepted_id && proposal.status == ReviewProposalStatus::Pending {
            proposal.status = ReviewProposalStatus::Superseded;
            proposal.resolved_at_ms = Some(now_ms());
        }
    }
}

fn normalize_visible(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn context_prefix(text: &str) -> String {
    let chars = text.chars().rev().take(CONTEXT_CHARS).collect::<Vec<_>>();
    chars.into_iter().rev().collect()
}

fn context_suffix(text: &str) -> String {
    text.chars().take(CONTEXT_CHARS).collect()
}

fn validate_source(source: &str) -> Result<(), BoundaryError> {
    if source.len() > MAX_SOURCE_BYTES {
        return Err(review_error(
            "review_source_too_large",
            "Reviewable manuscripts are limited to 1 MiB of Typst source.",
        ));
    }
    if source.contains('\0') {
        return Err(review_error(
            "review_source_invalid",
            "Typst source cannot contain a null character.",
        ));
    }
    Ok(())
}

fn normalize_text(
    value: String,
    max_bytes: usize,
    code: &'static str,
) -> Result<String, BoundaryError> {
    if value.len() > max_bytes || value.contains('\0') {
        return Err(review_error(code, "Review text exceeds its bounded size."));
    }
    Ok(value)
}

fn normalize_optional_text(
    value: Option<String>,
    max_chars: usize,
    code: &'static str,
) -> Result<Option<String>, BoundaryError> {
    let Some(value) = value else {
        return Ok(None);
    };
    if value.chars().count() > max_chars || value.contains('\0') {
        return Err(review_error(code, "Review text exceeds its bounded size."));
    }
    let trimmed = value.trim().to_owned();
    Ok((!trimmed.is_empty()).then_some(trimmed))
}

fn validate_id(id: &str) -> Result<(), BoundaryError> {
    if id.is_empty()
        || id.chars().count() > MAX_ID_CHARS
        || !id.chars().all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '-' | '_' | '.')
        })
    {
        return Err(review_error(
            "review_id_invalid",
            "Review identifiers must use short ASCII letters, numbers, dots, underscores, or hyphens.",
        ));
    }
    Ok(())
}

fn normalize_or_generate_id(
    id: Option<String>,
    prefix: &str,
    generation: u64,
) -> Result<String, BoundaryError> {
    if let Some(id) = id {
        validate_id(&id)?;
        Ok(id)
    } else {
        Ok(generate_id(prefix, generation))
    }
}

fn generate_id(prefix: &str, generation: u64) -> String {
    format!("{prefix}-{}-{}", now_ms(), generation.saturating_add(1))
}

fn validate_root(root: &Path) -> Result<PathBuf, BoundaryError> {
    let canonical = root.canonicalize().map_err(|_| {
        review_error("review_project_unavailable", "The selected project is unavailable.")
    })?;
    if !canonical.is_dir() {
        return Err(review_error(
            "review_project_unavailable",
            "The selected project is unavailable.",
        ));
    }
    Ok(canonical)
}

fn validate_document_path(path: &str) -> Result<&str, BoundaryError> {
    let relative = Path::new(path);
    if relative.is_absolute()
        || relative
            .components()
            .any(|component| !matches!(component, Component::Normal(_)))
        || !relative
            .extension()
            .is_some_and(|extension| extension.eq_ignore_ascii_case("typ"))
    {
        return Err(review_error(
            "review_path_denied",
            "Review targets must be relative Typst files inside the selected project.",
        ));
    }
    Ok(path)
}

fn ensure_saved_source(
    root: &Path,
    path: &str,
    source: &str,
    expected_digest: &str,
) -> Result<(), BoundaryError> {
    let source_digest = digest(source.as_bytes());
    if source_digest != expected_digest {
        return Err(review_error(
            "review_source_unsaved",
            "Save the current manuscript before changing review metadata.",
        ));
    }
    let saved = saved_source_digest(root, path)?;
    if saved != expected_digest {
        return Err(review_error(
            "review_source_changed",
            "The manuscript changed on disk. Refresh before changing review metadata.",
        ));
    }
    Ok(())
}

fn saved_source_digest(root: &Path, path: &str) -> Result<String, BoundaryError> {
    let path = validate_document_path(path)?;
    let absolute = root.join(path).canonicalize().map_err(|_| {
        review_error("review_document_unavailable", "The manuscript file is unavailable.")
    })?;
    if !absolute.starts_with(root) || !absolute.is_file() {
        return Err(review_error(
            "review_path_denied",
            "The manuscript must remain inside the selected project.",
        ));
    }
    let bytes = fs::read(absolute).map_err(|_| {
        review_error("review_document_unavailable", "The manuscript file could not be read.")
    })?;
    if bytes.len() > MAX_SOURCE_BYTES {
        return Err(review_error(
            "review_source_too_large",
            "Reviewable manuscripts are limited to 1 MiB of Typst source.",
        ));
    }
    Ok(digest(&bytes))
}

fn bibliography_digest(root: &Path) -> Result<String, BoundaryError> {
    let path = root.join("paper.bib");
    if !path.exists() {
        return Ok(String::new());
    }
    let metadata = fs::symlink_metadata(&path).map_err(|_| BoundaryError::internal())?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(review_error(
            "review_bibliography_invalid",
            "paper.bib must be a regular file inside the project.",
        ));
    }
    let bytes = fs::read(path).map_err(|_| {
        review_error("review_bibliography_invalid", "paper.bib could not be read.")
    })?;
    if bytes.len() > MAX_SOURCE_BYTES {
        return Err(review_error(
            "review_bibliography_invalid",
            "paper.bib is larger than the supported bibliography limit.",
        ));
    }
    Ok(digest(&bytes))
}

fn load_project(root: &Path) -> Result<Option<ReviewProject>, BoundaryError> {
    let path = root.join(REVIEW_FILE);
    if !path.exists() {
        return Ok(None);
    }
    let metadata = fs::symlink_metadata(&path).map_err(|_| BoundaryError::internal())?;
    if metadata.file_type().is_symlink()
        || !metadata.is_file()
        || metadata.len() > MAX_TRANSACTION_BYTES
    {
        return Err(review_error(
            "review_metadata_invalid",
            "paper.json must be a bounded regular file.",
        ));
    }
    let bytes = fs::read(path).map_err(|_| {
        review_error("review_metadata_invalid", "paper.json could not be read.")
    })?;
    let project: ReviewProject = serde_json::from_slice(&bytes).map_err(|_| {
        review_error(
            "review_metadata_invalid",
            "paper.json is not valid UnderTree review metadata.",
        )
    })?;
    if project.schema_version != REVIEW_SCHEMA_VERSION {
        return Err(review_error(
            "review_schema_unsupported",
            "paper.json uses an unsupported UnderTree review schema.",
        ));
    }
    if project.marks.len() > MAX_MARKS
        || project.proposals.len() > MAX_PROPOSALS
        || project.comments.len() > MAX_COMMENTS
    {
        return Err(review_error(
            "review_metadata_invalid",
            "paper.json exceeds UnderTree's bounded review limits.",
        ));
    }
    Ok(Some(project))
}

fn write_project(root: &Path, project: &ReviewProject) -> Result<(), BoundaryError> {
    let bytes = serde_json::to_vec_pretty(project).map_err(|_| BoundaryError::internal())?;
    if bytes.len() as u64 > MAX_REVIEW_BYTES {
        return Err(review_error(
            "review_metadata_too_large",
            "paper.json exceeds the 4 MiB review metadata limit.",
        ));
    }
    atomic_write(&root.join(REVIEW_FILE), &bytes).map_err(|_| {
        review_error("review_save_failed", "paper.json could not be saved safely.")
    })
}

fn review_digest(root: &Path) -> Result<Option<String>, BoundaryError> {
    let path = root.join(REVIEW_FILE);
    if !path.exists() {
        return Ok(None);
    }
    let bytes = fs::read(path).map_err(|_| BoundaryError::internal())?;
    Ok(Some(digest(&bytes)))
}

fn write_acceptance_transaction(
    root: &Path,
    source_path: &str,
    old_source_digest: &str,
    old_review_digest: Option<String>,
    new_source: &str,
    project: &ReviewProject,
) -> Result<(), BoundaryError> {
    let current_source_digest = saved_source_digest(root, source_path)?;
    if current_source_digest != old_source_digest {
        return Err(review_error(
            "review_source_changed",
            "The manuscript changed before the accepted proposal could be applied.",
        ));
    }
    if review_digest(root)? != old_review_digest {
        return Err(review_error(
            "review_metadata_changed",
            "paper.json changed before the accepted proposal could be applied.",
        ));
    }
    let new_review = String::from_utf8(
        serde_json::to_vec_pretty(project).map_err(|_| BoundaryError::internal())?,
    )
    .map_err(|_| BoundaryError::internal())?;
    if new_review.len() as u64 > MAX_REVIEW_BYTES {
        return Err(review_error(
            "review_metadata_too_large",
            "paper.json exceeds the 4 MiB review metadata limit.",
        ));
    }
    let transaction = ReviewTransaction {
        version: 1,
        source_path: source_path.to_owned(),
        old_source_digest: old_source_digest.to_owned(),
        new_source: new_source.to_owned(),
        new_source_digest: digest(new_source.as_bytes()),
        old_review_digest,
        new_review_digest: digest(new_review.as_bytes()),
        new_review,
    };
    let transaction_bytes =
        serde_json::to_vec_pretty(&transaction).map_err(|_| BoundaryError::internal())?;
    if transaction_bytes.len() as u64 > MAX_TRANSACTION_BYTES {
        return Err(review_error(
            "review_transaction_too_large",
            "The accepted review transaction exceeds its bounded recovery limit.",
        ));
    }
    let private = ensure_private_state(root)?;
    let journal = private.join(REVIEW_TRANSACTION_FILE);
    atomic_write(&journal, &transaction_bytes).map_err(|_| {
        review_error(
            "review_transaction_failed",
            "UnderTree could not journal the accepted proposal safely.",
        )
    })?;
    atomic_write(&root.join(source_path), new_source.as_bytes()).map_err(|_| {
        review_error(
            "review_transaction_failed",
            "UnderTree could not save the accepted manuscript safely.",
        )
    })?;
    atomic_write(&root.join(REVIEW_FILE), transaction.new_review.as_bytes()).map_err(|_| {
        review_error(
            "review_transaction_failed",
            "UnderTree could not save the accepted review state safely.",
        )
    })?;
    fs::remove_file(&journal).map_err(|_| {
        review_error(
            "review_transaction_failed",
            "The accepted proposal was saved but its recovery journal could not be cleared.",
        )
    })?;
    Ok(())
}

fn recover_transaction(root: &Path) -> Result<(), BoundaryError> {
    let journal = root.join(".undertree").join(REVIEW_TRANSACTION_FILE);
    if !journal.exists() {
        return Ok(());
    }
    let metadata = fs::symlink_metadata(&journal).map_err(|_| BoundaryError::internal())?;
    if metadata.file_type().is_symlink() || !metadata.is_file() || metadata.len() > MAX_REVIEW_BYTES {
        return Err(review_error(
            "review_transaction_invalid",
            "The pending review recovery journal is invalid.",
        ));
    }
    let bytes = fs::read(&journal).map_err(|_| BoundaryError::internal())?;
    let transaction: ReviewTransaction = serde_json::from_slice(&bytes).map_err(|_| {
        review_error(
            "review_transaction_invalid",
            "The pending review recovery journal is invalid.",
        )
    })?;
    if transaction.version != 1 {
        return Err(review_error(
            "review_transaction_invalid",
            "The pending review recovery journal uses an unsupported version.",
        ));
    }
    let source_path = validate_document_path(&transaction.source_path)?;
    let source_digest = saved_source_digest(root, source_path)?;
    if source_digest != transaction.old_source_digest
        && source_digest != transaction.new_source_digest
    {
        return Err(review_error(
            "review_transaction_conflict",
            "The manuscript changed outside UnderTree during review recovery.",
        ));
    }
    let current_review = review_digest(root)?;
    let expected_new = Some(transaction.new_review_digest.clone());
    if current_review != transaction.old_review_digest && current_review != expected_new {
        return Err(review_error(
            "review_transaction_conflict",
            "paper.json changed outside UnderTree during review recovery.",
        ));
    }
    if source_digest != transaction.new_source_digest {
        atomic_write(&root.join(source_path), transaction.new_source.as_bytes()).map_err(|_| {
            review_error(
                "review_transaction_failed",
                "UnderTree could not recover the accepted manuscript.",
            )
        })?;
    }
    if current_review != expected_new {
        atomic_write(&root.join(REVIEW_FILE), transaction.new_review.as_bytes()).map_err(|_| {
            review_error(
                "review_transaction_failed",
                "UnderTree could not recover paper.json.",
            )
        })?;
    }
    fs::remove_file(journal).map_err(|_| BoundaryError::internal())?;
    Ok(())
}

fn ensure_private_state(root: &Path) -> Result<PathBuf, BoundaryError> {
    let directory = root.join(".undertree");
    fs::create_dir_all(&directory).map_err(|_| {
        review_error(
            "review_state_unavailable",
            "UnderTree could not create its private review recovery state.",
        )
    })?;
    let canonical = directory.canonicalize().map_err(|_| BoundaryError::internal())?;
    if canonical != directory {
        return Err(review_error(
            "review_state_invalid",
            "The private UnderTree state path is unsafe.",
        ));
    }
    Ok(canonical)
}

fn atomic_write(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let mut file = AtomicWriteFile::open(path)?;
    file.write_all(bytes)?;
    file.sync_all()?;
    file.commit()
}

fn next_version(value: u64) -> Result<u64, BoundaryError> {
    value.checked_add(1).ok_or_else(|| {
        review_error(
            "review_version_exhausted",
            "The review generation counter cannot be advanced.",
        )
    })
}

fn digest(bytes: &[u8]) -> String {
    let hash = Sha256::digest(bytes);
    let mut output = String::with_capacity(hash.len() * 2);
    for byte in hash {
        write!(&mut output, "{byte:02x}").expect("writing to a String is infallible");
    }
    output
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .ok()
        .and_then(|duration| u64::try_from(duration.as_millis()).ok())
        .unwrap_or(0)
}

fn stale_policy(current: u64) -> BoundaryError {
    review_error(
        "stale_review_policy",
        format!("The review policy changed. Reload policy version {current} before editing it."),
    )
}

fn review_error(code: &'static str, message: impl Into<String>) -> BoundaryError {
    BoundaryError::project(code, message)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temporary_project(label: &str) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock")
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "undertree-review-{label}-{}-{nonce}",
            std::process::id()
        ));
        fs::create_dir_all(&root).expect("root");
        root
    }

    fn setup(root: &Path, source: &str) -> String {
        fs::write(root.join("paper.typ"), source).expect("paper");
        fs::write(root.join("paper.bib"), "% bib\n").expect("bib");
        digest(source.as_bytes())
    }

    #[test]
    fn creates_and_restores_a_portable_mark() {
        let root = temporary_project("mark");
        let source = "Alpha beta gamma.";
        let saved = setup(&root, source);
        let service = ReviewService::default();
        let state = service
            .upsert_mark(
                &root,
                ReviewMarkRequest {
                    path: "paper.typ".into(),
                    source: source.into(),
                    expected_digest: saved,
                    expected_policy_version: 0,
                    id: Some("mark-a".into()),
                    kind: ReviewMarkKind::LightEdit,
                    start_byte: 6,
                    end_byte: 10,
                    visible_text: "beta".into(),
                    note: Some("tighten".into()),
                },
            )
            .expect("mark");
        assert_eq!(state.marks.len(), 1);
        assert!(root.join("paper.json").is_file());
        assert!(state.in_sync);
        let restored = service.state(&root, "paper.typ", source).expect("restore");
        assert_eq!(restored.marks[0].anchor.exact, "beta");
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn light_edit_preserves_citations_and_numbers() {
        assert!(validate_light_edit("At 12 ms @smith2024", "At @smith2024, latency was 12 ms.").is_ok());
        assert!(validate_light_edit("At 12 ms @smith2024", "At 13 ms @smith2024").is_err());
        assert!(validate_light_edit("At 12 ms @smith2024", "At 12 ms @other").is_err());
    }

    #[test]
    fn accepting_a_proposal_changes_source_only_after_decision() {
        let root = temporary_project("accept");
        let source = "This is very very long.";
        let saved = setup(&root, source);
        let service = ReviewService::default();
        let state = service
            .upsert_mark(
                &root,
                ReviewMarkRequest {
                    path: "paper.typ".into(),
                    source: source.into(),
                    expected_digest: saved.clone(),
                    expected_policy_version: 0,
                    id: Some("mark-a".into()),
                    kind: ReviewMarkKind::Rework,
                    start_byte: 8,
                    end_byte: 17,
                    visible_text: "very very".into(),
                    note: None,
                },
            )
            .expect("mark");
        let state = service
            .create_proposal(
                &root,
                ReviewProposalRequest {
                    path: "paper.typ".into(),
                    source: source.into(),
                    expected_digest: saved.clone(),
                    expected_policy_version: state.policy_version,
                    id: Some("proposal-a".into()),
                    mark_id: "mark-a".into(),
                    operation: ReviewProposalOperation::Replace,
                    replacement: "quite".into(),
                    rationale: "shorter".into(),
                },
                ReviewActor::Ai,
            )
            .expect("proposal");
        assert_eq!(fs::read_to_string(root.join("paper.typ")).unwrap(), source);
        let result = service
            .decide(
                &root,
                ReviewDecisionRequest {
                    path: "paper.typ".into(),
                    source: source.into(),
                    expected_digest: saved,
                    expected_policy_version: state.policy_version,
                    proposal_id: "proposal-a".into(),
                    decision: ReviewDecision::Accept,
                    feedback: None,
                    revision: 7,
                },
            )
            .expect("accept");
        assert_eq!(result.source, "This is quite long.");
        assert_eq!(
            fs::read_to_string(root.join("paper.typ")).unwrap(),
            "This is quite long."
        );
        assert!(result.changed_source);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn compact_project_is_three_shared_files() {
        let root = temporary_project("compact");
        create_compact_project_files(&root, "My Paper").expect("create");
        assert!(root.join("paper.typ").is_file());
        assert!(root.join("paper.bib").is_file());
        assert!(root.join("paper.json").is_file());
        let names = fs::read_dir(&root)
            .unwrap()
            .flatten()
            .map(|entry| entry.file_name().to_string_lossy().into_owned())
            .collect::<BTreeSet<_>>();
        assert_eq!(
            names,
            ["paper.bib", "paper.json", "paper.typ"]
                .into_iter()
                .map(str::to_owned)
                .collect()
        );
        let _ = fs::remove_dir_all(root);
    }
}
