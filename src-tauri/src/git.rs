use std::fs;
use std::fs::OpenOptions;
use std::io::{self, Write};
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

use atomic_write_file::AtomicWriteFile;
use git2::build::CheckoutBuilder;
use git2::{
    BranchType, Cred, FetchOptions, IndexAddOption, PushOptions, RemoteCallbacks, Repository,
    RepositoryInitOptions, RepositoryOpenFlags, RepositoryState, Status, StatusOptions,
    TreeWalkMode, TreeWalkResult,
};
use serde::Serialize;

use crate::error::BoundaryError;
use crate::review;

const MAX_CHANGED_PATHS: usize = 10_000;
const MAX_VISIBLE_CHANGES: usize = 200;
const MAX_LOCAL_BRANCHES: usize = 512;
const MAX_TRANSFER_OBJECTS: usize = 1_000_000;
const MAX_TRANSFER_BYTES: usize = 2 * 1024 * 1024 * 1024;
const MAX_TRANSFER_TIME: Duration = Duration::from_secs(5 * 60);
const MAX_CHECKOUT_PATHS: usize = 100_000;
const MAX_CHECKOUT_BYTES: usize = 2 * 1024 * 1024 * 1024;
const SERVER_CONNECT_TIMEOUT_MILLISECONDS: i32 = 15_000;
const SERVER_TIMEOUT_MILLISECONDS: i32 = 60_000;
const MAX_GIT_METADATA_ENTRIES: usize = MAX_TRANSFER_OBJECTS + MAX_CHANGED_PATHS + 1_024;
const MAX_LOCAL_GIT_CONFIG_BYTES: u64 = 1024 * 1024;
const REMOTE_NAME: &str = "origin";
static CLONE_DIRECTORY_NONCE: AtomicU64 = AtomicU64::new(0);

pub fn configure_transport_limits() -> Result<(), BoundaryError> {
    // SAFETY: these libgit2 options are process-wide. UnderTree configures them
    // once before starting the single desktop instance or any Git operation.
    unsafe {
        git2::opts::set_server_connect_timeout_in_milliseconds(SERVER_CONNECT_TIMEOUT_MILLISECONDS)
            .map_err(|_| git_operation_failed())?;
        git2::opts::set_server_timeout_in_milliseconds(SERVER_TIMEOUT_MILLISECONDS)
            .map_err(|_| git_operation_failed())?;
    }
    Ok(())
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitChange {
    pub path: String,
    pub status: &'static str,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitSnapshot {
    pub branch: String,
    pub ahead: usize,
    pub behind: usize,
    pub dirty: bool,
    pub changes: Vec<GitChange>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitBranch {
    pub name: String,
    pub oid: String,
    pub current: bool,
}

#[derive(Clone, Debug)]
pub struct FetchOutcome {
    pub updated: bool,
    pub safety_branch: Option<String>,
    pub safety_branch_published: bool,
}

#[derive(Clone, Copy, Debug)]
pub struct DivergencePolicy<'a> {
    pub merge_identity: Option<&'a CommitIdentity>,
    pub publish_safety_branch: bool,
    pub safety_timestamp: u64,
}

#[derive(Clone, Debug)]
pub struct CommitIdentity {
    pub name: String,
    pub email: String,
}

/// Lists bounded local branch metadata for the native CLI. This deliberately
/// exposes no repository paths, remotes, credentials, or generic Git escape
/// hatch.
pub fn local_branches(root: &Path) -> Result<Vec<GitBranch>, BoundaryError> {
    let repository = open_repository(root)?;
    ensure_idle_repository(&repository)?;
    let mut branches = Vec::new();
    for candidate in repository
        .branches(Some(BranchType::Local))
        .map_err(|_| git_operation_failed())?
        .take(MAX_LOCAL_BRANCHES)
    {
        let (branch, _) = candidate.map_err(|_| git_operation_failed())?;
        let Some(name) = branch.name().map_err(|_| git_operation_failed())? else {
            continue;
        };
        let Some(oid) = branch.get().target() else {
            continue;
        };
        branches.push(GitBranch {
            name: name.to_owned(),
            oid: oid.to_string(),
            current: branch.is_head(),
        });
    }
    branches.sort_by(|left, right| left.name.cmp(&right.name));
    Ok(branches)
}

pub fn validate_repository_name(value: &str) -> Result<(), BoundaryError> {
    if value.is_empty() || value.len() > 201 {
        return Err(github_error(
            "invalid_repository",
            "Choose a valid GitHub repository.",
        ));
    }
    let mut parts = value.split('/');
    let owner = parts.next().unwrap_or_default();
    let repository = parts.next().unwrap_or_default();
    if parts.next().is_some()
        || !valid_repository_component(owner)
        || !valid_repository_component(repository)
    {
        return Err(github_error(
            "invalid_repository",
            "Choose a valid GitHub repository.",
        ));
    }
    Ok(())
}

pub fn validate_new_repository_name(value: &str) -> Result<(), BoundaryError> {
    if valid_repository_component(value) && !value.ends_with(".git") {
        Ok(())
    } else {
        Err(github_error(
            "invalid_repository_name",
            "Use 1–100 letters, numbers, periods, hyphens, or underscores for the new repository name; do not end it with .git.",
        ))
    }
}

pub fn preflight_new_project_destination(
    destination_parent: &Path,
    repository_name: &str,
) -> Result<PathBuf, BoundaryError> {
    validate_new_repository_name(repository_name)?;
    let parent = destination_parent.canonicalize().map_err(|_| {
        github_error(
            "project_destination_unavailable",
            "The selected local storage folder is unavailable.",
        )
    })?;
    if !parent.is_dir() {
        return Err(github_error(
            "project_destination_unavailable",
            "Choose a folder for the new local project.",
        ));
    }
    let target = parent.join(repository_name);
    ensure_clone_target_absent(&target)?;
    Ok(target)
}

pub fn validate_branch_name(value: &str) -> Result<(), BoundaryError> {
    if value.is_empty()
        || value.len() > 255
        || value.starts_with('.')
        || value.ends_with('.')
        || value.ends_with('/')
        || value.ends_with(".lock")
        || value.contains("..")
        || value.contains("@{")
        || value.chars().any(|character| {
            character.is_control()
                || character.is_whitespace()
                || matches!(character, '~' | '^' | ':' | '?' | '*' | '[' | '\\')
        })
        || value
            .split('/')
            .any(|component| component.is_empty() || component.starts_with('.'))
    {
        return Err(github_error(
            "invalid_branch",
            "The repository default branch is not supported.",
        ));
    }
    Ok(())
}

pub fn remote_url(repository: &str) -> Result<String, BoundaryError> {
    validate_repository_name(repository)?;
    Ok(format!("https://github.com/{repository}.git"))
}

pub fn link_repository(
    root: &Path,
    repository: &str,
    branch: &str,
) -> Result<GitSnapshot, BoundaryError> {
    validate_branch_name(branch)?;
    let url = remote_url(repository)?;
    let repository_handle = open_or_initialize_repository(root)?;
    authorize_repository(root, &repository_handle)?;

    // Reject a checked-out branch mismatch before changing origin, push URLs,
    // excludes, or any other repository state.
    let needs_branch_configuration = match repository_handle.head() {
        Ok(head) => {
            if !head.is_branch() || head.shorthand().ok() != Some(branch) {
                return Err(github_error(
                    "branch_mismatch",
                    "Check out the repository's configured GitHub branch before linking this local folder.",
                ));
            }
            false
        }
        Err(error)
            if matches!(
                error.code(),
                git2::ErrorCode::UnbornBranch | git2::ErrorCode::NotFound
            ) =>
        {
            true
        }
        Err(_) => return Err(git_operation_failed()),
    };

    let remote_exists = match repository_handle.find_remote(REMOTE_NAME) {
        Ok(remote) => {
            if remote.url().ok() != Some(url.as_str()) {
                return Err(github_error(
                    "remote_mismatch",
                    "This local repository already has a different origin. Choose its matching GitHub repository.",
                ));
            }
            true
        }
        Err(error) if error.code() == git2::ErrorCode::NotFound => false,
        Err(_) => return Err(git_operation_failed()),
    };
    let has_push_url = remote_exists
        && repository_handle
            .find_remote(REMOTE_NAME)
            .ok()
            .and_then(|remote| remote.pushurl().ok().flatten().map(str::to_owned))
            .is_some();

    // Complete all fallible repository validation before changing HEAD or
    // remotes. The local exclude is a safe project-only hygiene mutation.
    collect_statuses(&repository_handle)?;
    configure_platform_checkout(&repository_handle)?;
    ensure_local_excludes(root, &repository_handle)?;
    if needs_branch_configuration {
        repository_handle
            .set_head(&format!("refs/heads/{branch}"))
            .map_err(|_| {
                BoundaryError::github(
                    "branch_configuration_failed",
                    "UnderTree could not prepare the repository branch.",
                )
            })?;
    }
    if !remote_exists {
        repository_handle.remote(REMOTE_NAME, &url).map_err(|_| {
            github_error(
                "remote_configuration_failed",
                "UnderTree could not connect this project to the selected repository.",
            )
        })?;
    }
    if has_push_url {
        repository_handle
            .remote_set_pushurl(REMOTE_NAME, None)
            .map_err(|_| {
                BoundaryError::github(
                    "remote_configuration_failed",
                    "UnderTree could not secure this project's GitHub push destination.",
                )
            })?;
    }

    snapshot(root, branch)
}

pub fn clone_repository(
    destination_parent: &Path,
    repository: &str,
    branch: &str,
    token: &str,
) -> Result<PathBuf, BoundaryError> {
    validate_repository_name(repository)?;
    validate_branch_name(branch)?;
    let parent = destination_parent.canonicalize().map_err(|_| {
        github_error(
            "clone_destination_unavailable",
            "The selected local storage folder is unavailable.",
        )
    })?;
    if !parent.is_dir() {
        return Err(github_error(
            "clone_destination_unavailable",
            "Choose a folder for the local repository copy.",
        ));
    }
    let repository_name = repository
        .rsplit_once('/')
        .map(|(_, name)| name)
        .ok_or_else(|| github_error("invalid_repository", "Choose a valid GitHub repository."))?;
    let target = parent.join(repository_name);
    ensure_clone_target_absent(&target)?;
    let staging = OwnedCloneDirectory::create(&parent)?;

    let url = remote_url(repository)?;
    let cloned = Repository::init(staging.path()).map_err(|_| {
        github_error(
            "clone_failed",
            "UnderTree could not create the local GitHub repository copy.",
        )
    })?;
    configure_platform_checkout(&cloned)?;
    authorize_repository(staging.path(), &cloned)?;
    cloned.remote(REMOTE_NAME, &url).map_err(|_| {
        github_error(
            "clone_failed",
            "UnderTree could not configure the cloned GitHub repository.",
        )
    })?;
    validate_remote(&cloned, repository)?;
    fetch(&cloned, branch, token, &url, &|| false)?;
    let remote_reference = cloned
        .find_reference(&format!("refs/remotes/{REMOTE_NAME}/{branch}"))
        .map_err(|_| {
            github_error(
                "clone_failed",
                "GitHub did not provide the selected repository branch.",
            )
        })?;
    let remote_id = remote_reference.target().ok_or_else(git_operation_failed)?;
    validate_checkout_commit(&cloned, remote_id)?;
    let remote_object = cloned
        .find_object(remote_id, Some(git2::ObjectType::Commit))
        .map_err(|_| git_operation_failed())?;
    cloned
        .reference(
            &format!("refs/heads/{branch}"),
            remote_id,
            false,
            "UnderTree clone",
        )
        .map_err(|_| git_operation_failed())?;
    cloned
        .set_head(&format!("refs/heads/{branch}"))
        .map_err(|_| git_operation_failed())?;
    let mut checkout = safe_checkout_builder();
    cloned
        .checkout_tree(&remote_object, Some(&mut checkout))
        .map_err(|_error| {
            #[cfg(test)]
            eprintln!(
                "libgit2 checkout diagnostic: class={:?} code={:?} message={}",
                _error.class(),
                _error.code(),
                _error.message()
            );
            checkout_failed()
        })?;
    drop(remote_object);
    drop(remote_reference);
    authorize_repository(staging.path(), &cloned)?;
    head_commit_for_branch(&cloned, branch)?;
    ensure_local_excludes(staging.path(), &cloned)?;
    drop(cloned);
    staging.promote(&target)?;
    let canonical_target = target.canonicalize().map_err(|_| {
        github_error(
            "clone_failed",
            "The cloned repository folder is unavailable.",
        )
    })?;
    if canonical_target.parent() != Some(parent.as_path()) {
        return Err(github_error(
            "clone_failed",
            "The cloned repository folder moved outside the selected local storage folder.",
        ));
    }
    Ok(canonical_target)
}

pub fn create_repository_project(
    destination_parent: &Path,
    repository: &str,
    branch: &str,
    token: &str,
    identity: &CommitIdentity,
) -> Result<PathBuf, BoundaryError> {
    validate_repository_name(repository)?;
    validate_branch_name(branch)?;
    let repository_name = repository
        .rsplit_once('/')
        .map(|(_, name)| name)
        .ok_or_else(|| github_error("invalid_repository", "Choose a valid GitHub repository."))?;
    let target = preflight_new_project_destination(destination_parent, repository_name)?;
    let parent = target.parent().ok_or_else(BoundaryError::internal)?;
    let staging = OwnedCloneDirectory::create(parent)?;

    review::create_compact_project_files(staging.path(), repository_name)?;

    link_repository(staging.path(), repository, branch)?;
    if !commit_all(
        staging.path(),
        branch,
        "Create UnderTree Typst project",
        identity,
    )? {
        return Err(github_error(
            "project_create_failed",
            "UnderTree could not create the initial local commit.",
        ));
    }
    push(staging.path(), repository, branch, token)?;
    staging.promote(&target)?;
    target.canonicalize().map_err(|_| {
        github_error(
            "project_create_failed",
            "The new local project folder is unavailable.",
        )
    })
}

pub fn snapshot(root: &Path, configured_branch: &str) -> Result<GitSnapshot, BoundaryError> {
    validate_branch_name(configured_branch)?;
    let repository = open_repository(root)?;
    let branch = current_branch(&repository).unwrap_or_else(|| configured_branch.to_owned());
    let statuses = collect_statuses(&repository)?;
    let dirty = !statuses.is_empty();
    let changes = statuses
        .into_iter()
        .take(MAX_VISIBLE_CHANGES)
        .filter_map(|(path, status)| {
            path.to_str().map(|path| GitChange {
                path: path.replace('\\', "/"),
                status: status_label(status),
            })
        })
        .collect();
    let (ahead, behind) = ahead_behind(&repository, &branch);

    Ok(GitSnapshot {
        branch,
        ahead,
        behind,
        dirty,
        changes,
    })
}

pub fn commit_all(
    root: &Path,
    branch: &str,
    message: &str,
    identity: &CommitIdentity,
) -> Result<bool, BoundaryError> {
    validate_branch_name(branch)?;
    let message = message.trim();
    if message.is_empty() || message.chars().count() > 200 || message.contains('\0') {
        return Err(github_error(
            "invalid_commit_message",
            "Enter a commit message between 1 and 200 characters.",
        ));
    }
    if identity.name.trim().is_empty()
        || identity.name.len() > 200
        || identity.email.trim().is_empty()
        || identity.email.len() > 254
    {
        return Err(github_error(
            "invalid_commit_identity",
            "GitHub did not provide a usable commit identity.",
        ));
    }

    let repository = open_repository(root)?;
    ensure_idle_repository(&repository)?;
    let parent = head_commit_for_branch(&repository, branch)?;
    let statuses = collect_statuses(&repository)?;
    if statuses.is_empty() {
        return Ok(false);
    }

    let mut index = repository.index().map_err(|_| git_operation_failed())?;
    if index.has_conflicts() {
        return Err(github_error(
            "merge_conflict",
            "Resolve the repository conflicts before creating a commit.",
        ));
    }
    let mut filter =
        |path: &Path, _matched: &[u8]| -> i32 { if is_undertree_internal(path) { 1 } else { 0 } };
    index
        .add_all(["*"].iter(), IndexAddOption::DEFAULT, Some(&mut filter))
        .map_err(|_| git_operation_failed())?;
    index.write().map_err(|_| git_operation_failed())?;
    let tree_id = index.write_tree().map_err(|_| git_operation_failed())?;
    let tree = repository
        .find_tree(tree_id)
        .map_err(|_| git_operation_failed())?;

    if parent
        .as_ref()
        .is_some_and(|parent| parent.tree_id() == tree_id)
    {
        return Ok(false);
    }
    let signature = git2::Signature::now(identity.name.trim(), identity.email.trim())
        .map_err(|_| git_operation_failed())?;
    let parents = parent.iter().collect::<Vec<_>>();
    repository
        .commit(
            Some(&format!("refs/heads/{branch}")),
            &signature,
            &signature,
            message,
            &tree,
            &parents,
        )
        .map_err(|_| git_operation_failed())?;
    repository
        .set_head(&format!("refs/heads/{branch}"))
        .map_err(|_| git_operation_failed())?;
    Ok(true)
}

pub fn fetch_and_fast_forward<F>(
    root: &Path,
    expected_repository: &str,
    branch: &str,
    token: &str,
    divergence: DivergencePolicy<'_>,
    should_abort: F,
) -> Result<FetchOutcome, BoundaryError>
where
    F: Fn() -> bool,
{
    validate_branch_name(branch)?;
    let repository = open_repository(root)?;
    ensure_idle_repository(&repository)?;
    head_commit_for_branch(&repository, branch)?;
    let expected_url = validate_remote(&repository, expected_repository)?;
    fetch(&repository, branch, token, &expected_url, &should_abort)?;
    if should_abort() {
        return Err(unsaved_editor_error());
    }

    let remote_reference =
        match repository.find_reference(&format!("refs/remotes/{REMOTE_NAME}/{branch}")) {
            Ok(reference) => reference,
            Err(_) => {
                return Ok(FetchOutcome {
                    updated: false,
                    safety_branch: None,
                    safety_branch_published: false,
                });
            }
        };
    let remote_id = remote_reference.target().ok_or_else(git_operation_failed)?;
    validate_checkout_commit(&repository, remote_id)?;
    let local_reference_name = format!("refs/heads/{branch}");
    let local_reference = match repository.find_reference(&local_reference_name) {
        Ok(reference) => reference,
        Err(_) => {
            if !collect_statuses(&repository)?.is_empty() {
                return Err(BoundaryError::github(
                    "remote_not_empty",
                    "The selected remote already has files. Open a clone of that repository instead of linking this non-empty folder.",
                ));
            }
            if should_abort() {
                return Err(unsaved_editor_error());
            }
            let remote_object = repository
                .find_object(remote_id, Some(git2::ObjectType::Commit))
                .map_err(|_| git_operation_failed())?;
            let mut checkout = safe_checkout_builder();
            repository
                .checkout_tree(&remote_object, Some(&mut checkout))
                .map_err(|_| checkout_failed())?;
            repository
                .reference(
                    &local_reference_name,
                    remote_id,
                    false,
                    "UnderTree initial fast-forward",
                )
                .map_err(|_| git_operation_failed())?;
            return Ok(FetchOutcome {
                updated: true,
                safety_branch: None,
                safety_branch_published: false,
            });
        }
    };
    let local_id = local_reference.target().ok_or_else(git_operation_failed)?;
    let (ahead, behind) = repository
        .graph_ahead_behind(local_id, remote_id)
        .map_err(|_| git_operation_failed())?;
    if behind == 0 {
        return Ok(FetchOutcome {
            updated: false,
            safety_branch: None,
            safety_branch_published: false,
        });
    }
    if !collect_statuses(&repository)?.is_empty() {
        return Err(github_error(
            "working_tree_dirty",
            "Commit or discard local changes before pulling from GitHub.",
        ));
    }
    if should_abort() {
        return Err(unsaved_editor_error());
    }
    if ahead > 0 {
        let identity = divergence.merge_identity.ok_or_else(|| {
            BoundaryError::github(
                "merge_required",
                "Local and GitHub histories have diverged. Use Sync so UnderTree can reconcile them safely.",
            )
        })?;
        let safety_branch =
            create_safety_branch(&repository, local_id, divergence.safety_timestamp)?;
        let safety_branch_published = if divergence.publish_safety_branch {
            push_named_branch(
                &repository,
                &expected_url,
                &safety_branch,
                token,
            )
            .map_err(|_| {
                BoundaryError::github(
                    "safety_branch_push_failed",
                    format!(
                        "UnderTree preserved local commits on branch {safety_branch}, but could not publish that safety branch to GitHub. Synchronization stopped before merging."
                    ),
                )
            })?;
            true
        } else {
            false
        };
        if let Err(error) = merge_remote_commits(
            &repository,
            &local_reference_name,
            local_id,
            remote_id,
            branch,
            identity,
            &should_abort,
        ) {
            if error.code == "merge_conflict" {
                return Err(BoundaryError::github(
                    "merge_conflict",
                    format!(
                        "Local and GitHub commits conflict. UnderTree left {branch} unchanged and preserved the local tip on safety branch {safety_branch}."
                    ),
                ));
            }
            return Err(error);
        }
        return Ok(FetchOutcome {
            updated: true,
            safety_branch: Some(safety_branch),
            safety_branch_published,
        });
    }

    let mut local_reference = repository
        .find_reference(&local_reference_name)
        .map_err(|_| git_operation_failed())?;
    let remote_object = repository
        .find_object(remote_id, Some(git2::ObjectType::Commit))
        .map_err(|_| git_operation_failed())?;
    let local_object = repository
        .find_object(local_id, Some(git2::ObjectType::Commit))
        .map_err(|_| git_operation_failed())?;
    let mut checkout = safe_checkout_builder();
    repository
        .checkout_tree(&remote_object, Some(&mut checkout))
        .map_err(|_| checkout_failed())?;
    if should_abort() {
        rollback_checkout(&repository, &local_object);
        return Err(unsaved_editor_error());
    }
    if local_reference
        .set_target(remote_id, "UnderTree fast-forward from GitHub")
        .is_err()
    {
        rollback_checkout(&repository, &local_object);
        return Err(git_operation_failed());
    }
    Ok(FetchOutcome {
        updated: true,
        safety_branch: None,
        safety_branch_published: false,
    })
}

/// Fetches GitHub before a push and refuses to race a newer remote tip. If
/// both histories contain unique commits, the local tip is preserved on a
/// published safety branch before the operation stops and asks for Sync.
pub fn preflight_push_remote<F>(
    root: &Path,
    expected_repository: &str,
    branch: &str,
    token: &str,
    safety_timestamp: u64,
    should_abort: F,
) -> Result<(), BoundaryError>
where
    F: Fn() -> bool,
{
    validate_branch_name(branch)?;
    let repository = open_repository(root)?;
    ensure_idle_repository(&repository)?;
    let local_commit = head_commit_for_branch(&repository, branch)?.ok_or_else(|| {
        github_error(
            "commit_required",
            "Create a commit before pushing this project to GitHub.",
        )
    })?;
    if !collect_statuses(&repository)?.is_empty() {
        return Err(BoundaryError::github(
            "working_tree_dirty",
            "Commit local changes before pushing this project to GitHub.",
        ));
    }
    let expected_url = validate_remote(&repository, expected_repository)?;
    fetch(&repository, branch, token, &expected_url, &should_abort)?;
    if should_abort() {
        return Err(unsaved_editor_error());
    }
    let remote_id = repository
        .find_reference(&format!("refs/remotes/{REMOTE_NAME}/{branch}"))
        .ok()
        .and_then(|reference| reference.target());
    let Some(remote_id) = remote_id else {
        return Ok(());
    };
    let (ahead, behind) = repository
        .graph_ahead_behind(local_commit.id(), remote_id)
        .map_err(|_| git_operation_failed())?;
    if behind == 0 {
        return Ok(());
    }
    if ahead > 0 {
        let safety_branch = create_safety_branch(&repository, local_commit.id(), safety_timestamp)?;
        push_named_branch(&repository, &expected_url, &safety_branch, token).map_err(|_| {
            BoundaryError::github(
                "safety_branch_push_failed",
                format!(
                    "UnderTree preserved local commits on branch {safety_branch}, but could not publish that safety branch to GitHub. Push stopped without changing GitHub's main branch."
                ),
            )
        })?;
        return Err(BoundaryError::github(
            "remote_diverged",
            format!(
                "GitHub and local commits diverged. UnderTree published safety branch {safety_branch} and stopped the push. Use Sync to reconcile the histories."
            ),
        ));
    }
    Err(github_error(
        "remote_ahead",
        "GitHub has newer commits. Push stopped without changing either history; use Pull or Sync first.",
    ))
}

pub fn push(
    root: &Path,
    expected_repository: &str,
    branch: &str,
    token: &str,
) -> Result<bool, BoundaryError> {
    validate_branch_name(branch)?;
    let repository = open_repository(root)?;
    ensure_idle_repository(&repository)?;
    let expected_url = validate_remote(&repository, expected_repository)?;
    let head = repository.head().map_err(|_| {
        github_error(
            "commit_required",
            "Create a commit before pushing this project to GitHub.",
        )
    })?;
    let head_branch = head.shorthand().map_err(|_| {
        github_error(
            "detached_head",
            "Check out a local branch before pushing to GitHub.",
        )
    })?;
    if head_branch != branch {
        return Err(github_error(
            "branch_mismatch",
            "The current branch does not match this project's GitHub rule.",
        ));
    }
    preflight_push_pack(&repository, branch)?;

    let mut remote = repository
        .find_remote(REMOTE_NAME)
        .map_err(|_| git_operation_failed())?;
    let mut callbacks = credential_callbacks(token, &expected_url, None);
    callbacks.push_update_reference(|_reference, status| {
        if status.is_some() {
            Err(git2::Error::from_str("GitHub rejected the update"))
        } else {
            Ok(())
        }
    });
    let mut options = PushOptions::new();
    options.remote_callbacks(callbacks);
    let refspec = format!("refs/heads/{branch}:refs/heads/{branch}");
    remote
        .push(&[refspec.as_str()], Some(&mut options))
        .map_err(|_| {
            github_error(
                "push_failed",
                "GitHub rejected the push. Fetch the latest branch and check your repository permissions.",
            )
        })?;
    Ok(true)
}

fn create_safety_branch(
    repository: &Repository,
    local_id: git2::Oid,
    timestamp: u64,
) -> Result<String, BoundaryError> {
    let commit = repository
        .find_commit(local_id)
        .map_err(|_| git_operation_failed())?;
    let oid = local_id.to_string();
    let short_oid = &oid[..12];
    for suffix in 0..100u8 {
        let name = if suffix == 0 {
            format!("undertree-safety/{timestamp}-{short_oid}")
        } else {
            format!("undertree-safety/{timestamp}-{short_oid}-{suffix}")
        };
        validate_branch_name(&name)?;
        match repository.find_branch(&name, BranchType::Local) {
            Ok(existing) => {
                if existing.get().target() == Some(local_id) {
                    return Ok(name);
                }
            }
            Err(error) if error.code() == git2::ErrorCode::NotFound => {
                repository
                    .branch(&name, &commit, false)
                    .map_err(|_| git_operation_failed())?;
                return Ok(name);
            }
            Err(_) => return Err(git_operation_failed()),
        }
    }
    Err(github_error(
        "safety_branch_failed",
        "UnderTree could not allocate a unique safety branch. Synchronization stopped without changing the project branch.",
    ))
}

fn push_named_branch(
    repository: &Repository,
    expected_url: &str,
    branch: &str,
    token: &str,
) -> Result<(), BoundaryError> {
    validate_branch_name(branch)?;
    preflight_push_pack(repository, branch)?;
    let mut remote = repository
        .find_remote(REMOTE_NAME)
        .map_err(|_| git_operation_failed())?;
    let mut callbacks = credential_callbacks(token, expected_url, None);
    callbacks.push_update_reference(|_reference, status| {
        if status.is_some() {
            Err(git2::Error::from_str("GitHub rejected the safety branch"))
        } else {
            Ok(())
        }
    });
    let mut options = PushOptions::new();
    options.remote_callbacks(callbacks);
    let refspec = format!("refs/heads/{branch}:refs/heads/{branch}");
    remote
        .push(&[refspec.as_str()], Some(&mut options))
        .map_err(|_| git_operation_failed())
}

fn preflight_push_pack(
    repository: &Repository,
    branch: &str,
) -> Result<(usize, usize), BoundaryError> {
    let local_id = repository
        .refname_to_id(&format!("refs/heads/{branch}"))
        .map_err(|_| git_operation_failed())?;
    let mut walk = repository.revwalk().map_err(|_| git_operation_failed())?;
    walk.set_sorting(git2::Sort::TOPOLOGICAL | git2::Sort::TIME)
        .map_err(|_| git_operation_failed())?;
    walk.push(local_id).map_err(|_| git_operation_failed())?;
    // Measure the complete reachable history. A local remote-tracking ref is
    // untrusted and may not match what GitHub will advertise during push.

    let started = Instant::now();
    let limit_hit = std::rc::Rc::new(std::cell::Cell::new(false));
    let progress_limit_hit = std::rc::Rc::clone(&limit_hit);
    let mut builder = repository
        .packbuilder()
        .map_err(|_| git_operation_failed())?;
    builder
        .set_progress_callback(move |_stage, current, total| {
            let allowed =
                transfer_within_limits(started, usize::max(current as usize, total as usize), 0);
            if !allowed {
                progress_limit_hit.set(true);
            }
            allowed
        })
        .map_err(|_| git_operation_failed())?;
    if builder.insert_walk(&mut walk).is_err() {
        return Err(if limit_hit.get() {
            push_pack_limit_error()
        } else {
            git_operation_failed()
        });
    }
    let objects = builder.object_count();
    if !transfer_within_limits(started, objects, 0) {
        return Err(push_pack_limit_error());
    }
    if objects == 0 {
        return Ok((0, 0));
    }

    let mut bytes = 0usize;
    let mut foreach_limit_hit = false;
    let result = builder.foreach(|chunk| {
        bytes = bytes.saturating_add(chunk.len());
        let allowed = transfer_within_limits(started, objects, bytes);
        if !allowed {
            foreach_limit_hit = true;
        }
        allowed
    });
    if foreach_limit_hit || limit_hit.get() || !transfer_within_limits(started, objects, bytes) {
        return Err(push_pack_limit_error());
    }
    result.map_err(|_| git_operation_failed())?;
    Ok((objects, bytes))
}

fn push_pack_limit_error() -> BoundaryError {
    github_error(
        "push_too_large",
        "The outgoing Git update is too large to send safely in one synchronization.",
    )
}

fn fetch(
    repository: &Repository,
    branch: &str,
    token: &str,
    expected_url: &str,
    should_abort: &dyn Fn() -> bool,
) -> Result<(), BoundaryError> {
    let mut remote = repository
        .remote_anonymous(expected_url)
        .map_err(|_| git_operation_failed())?;
    let mut options = FetchOptions::new();
    options.remote_callbacks(credential_callbacks(
        token,
        expected_url,
        Some(should_abort),
    ));
    options.download_tags(git2::AutotagOption::None);
    let refspec = format!("+refs/heads/{branch}:refs/remotes/{REMOTE_NAME}/{branch}");
    remote
        .fetch(
            &[refspec.as_str()],
            Some(&mut options),
            Some("UnderTree sync"),
        )
        .map_err(|_error| {
            #[cfg(test)]
            eprintln!(
                "libgit2 fetch diagnostic: class={:?} code={:?} message={}",
                _error.class(),
                _error.code(),
                _error.message()
            );
            github_error(
                "fetch_failed",
                "UnderTree could not fetch the repository from GitHub.",
            )
        })
}

fn credential_callbacks<'callback>(
    token: &'callback str,
    expected_url: &'callback str,
    should_abort: Option<&'callback dyn Fn() -> bool>,
) -> RemoteCallbacks<'callback> {
    let mut callbacks = RemoteCallbacks::new();
    callbacks.credentials(move |url, _username, _allowed| {
        if url != expected_url {
            return Err(git2::Error::from_str(
                "UnderTree refused to send GitHub credentials to an unexpected host",
            ));
        }
        Cred::userpass_plaintext("x-access-token", token)
    });
    // Do not install a certificate callback. libgit2's Windows TLS backend
    // validates against the native certificate store and fails closed by
    // default. A callback would replace that decision and can accidentally
    // reject certificates that the operating system has already validated.
    let started = Instant::now();
    let transfer_abort = should_abort;
    callbacks.transfer_progress(move |progress| {
        transfer_within_limits(started, progress.total_objects(), progress.received_bytes())
            && !transfer_abort.is_some_and(|should_abort| should_abort())
    });
    let sideband_started = started;
    callbacks.sideband_progress(move |_message| {
        sideband_started.elapsed() <= MAX_TRANSFER_TIME
            && !should_abort.is_some_and(|should_abort| should_abort())
    });
    callbacks
}

fn transfer_within_limits(started: Instant, objects: usize, bytes: usize) -> bool {
    started.elapsed() <= MAX_TRANSFER_TIME
        && objects <= MAX_TRANSFER_OBJECTS
        && bytes <= MAX_TRANSFER_BYTES
}

fn validate_remote(
    repository: &Repository,
    expected_repository: &str,
) -> Result<String, BoundaryError> {
    let expected = remote_url(expected_repository)?;
    let remote = repository.find_remote(REMOTE_NAME).map_err(|_| {
        github_error(
            "remote_missing",
            "This project is no longer connected to a GitHub remote.",
        )
    })?;
    let push_url = remote.pushurl().map_err(|_| git_operation_failed())?;
    if remote.url().ok() != Some(expected.as_str())
        || push_url.is_some_and(|url| url != expected.as_str())
    {
        return Err(github_error(
            "remote_changed",
            "The Git remote changed outside UnderTree. Reconnect the project before sending credentials.",
        ));
    }
    Ok(expected)
}

fn head_commit_for_branch<'repository>(
    repository: &'repository Repository,
    branch: &str,
) -> Result<Option<git2::Commit<'repository>>, BoundaryError> {
    match repository.head() {
        Ok(head) => {
            if !head.is_branch() {
                return Err(github_error(
                    "detached_head",
                    "Check out the configured project branch before synchronizing.",
                ));
            }
            let head_branch = head.shorthand().map_err(|_| git_operation_failed())?;
            if head_branch != branch {
                return Err(github_error(
                    "branch_mismatch",
                    "The current branch does not match this project's GitHub rule.",
                ));
            }
            Ok(Some(
                head.peel_to_commit().map_err(|_| git_operation_failed())?,
            ))
        }
        Err(error) if error.code() == git2::ErrorCode::UnbornBranch => {
            let expected = format!("refs/heads/{branch}");
            let head = repository
                .find_reference("HEAD")
                .map_err(|_| git_operation_failed())?;
            if head.symbolic_target().ok().flatten() != Some(expected.as_str()) {
                return Err(github_error(
                    "branch_mismatch",
                    "The current branch does not match this project's GitHub rule.",
                ));
            }
            Ok(None)
        }
        Err(_) => Err(git_operation_failed()),
    }
}

fn rollback_checkout(repository: &Repository, object: &git2::Object<'_>) {
    let mut checkout = safe_checkout_builder();
    let _ = repository.checkout_tree(object, Some(&mut checkout));
}

fn safe_checkout_builder() -> CheckoutBuilder<'static> {
    let mut checkout = CheckoutBuilder::new();
    checkout.safe().overwrite_ignored(false);
    checkout
}

fn merge_remote_commits<F>(
    repository: &Repository,
    local_reference_name: &str,
    local_id: git2::Oid,
    remote_id: git2::Oid,
    branch: &str,
    identity: &CommitIdentity,
    should_abort: &F,
) -> Result<(), BoundaryError>
where
    F: Fn() -> bool,
{
    let local_commit = repository
        .find_commit(local_id)
        .map_err(|_| git_operation_failed())?;
    let remote_commit = repository
        .find_commit(remote_id)
        .map_err(|_| git_operation_failed())?;
    let mut merge_index = repository
        .merge_commits(&local_commit, &remote_commit, None)
        .map_err(|_| git_operation_failed())?;
    if merge_index.has_conflicts() {
        return Err(github_error(
            "merge_conflict",
            "Local and GitHub commits conflict. Reconcile the conflicting files before synchronizing again.",
        ));
    }
    let tree_id = merge_index
        .write_tree_to(repository)
        .map_err(|_| git_operation_failed())?;
    let tree = repository
        .find_tree(tree_id)
        .map_err(|_| git_operation_failed())?;
    let local_object = local_commit.as_object();
    let merge_object = tree.as_object();
    if should_abort() {
        return Err(unsaved_editor_error());
    }
    let mut checkout = safe_checkout_builder();
    repository
        .checkout_tree(merge_object, Some(&mut checkout))
        .map_err(|_| checkout_failed())?;
    if should_abort() {
        rollback_checkout(repository, local_object);
        return Err(unsaved_editor_error());
    }
    let signature = git2::Signature::now(identity.name.trim(), identity.email.trim())
        .map_err(|_| git_operation_failed())?;
    let message = format!("Merge GitHub changes into {branch}");
    if repository
        .commit(
            Some(local_reference_name),
            &signature,
            &signature,
            &message,
            &tree,
            &[&local_commit, &remote_commit],
        )
        .is_err()
    {
        rollback_checkout(repository, local_object);
        return Err(git_operation_failed());
    }
    Ok(())
}

fn open_or_initialize_repository(root: &Path) -> Result<Repository, BoundaryError> {
    match fs::symlink_metadata(root.join(".git")) {
        Ok(_) => open_existing_repository(root),
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            let mut options = RepositoryInitOptions::new();
            options.no_reinit(true);
            Repository::init_opts(root, &options).map_err(|_| {
                github_error(
                    "git_initialization_failed",
                    "UnderTree could not initialize Git for this project.",
                )
            })
        }
        Err(_) => Err(git_operation_failed()),
    }
}

fn configure_platform_checkout(repository: &Repository) -> Result<(), BoundaryError> {
    #[cfg(windows)]
    {
        let mut config = repository.config().map_err(|_| git_operation_failed())?;
        config
            .set_bool("core.longpaths", true)
            .map_err(|_| git_operation_failed())?;
    }
    #[cfg(not(windows))]
    let _ = repository;
    Ok(())
}

fn open_repository(root: &Path) -> Result<Repository, BoundaryError> {
    let repository = open_existing_repository(root)?;
    authorize_repository(root, &repository)?;
    Ok(repository)
}

fn open_existing_repository(root: &Path) -> Result<Repository, BoundaryError> {
    preflight_repository_git_directory(root)?;
    Repository::open_ext(
        root,
        RepositoryOpenFlags::NO_SEARCH,
        &[] as &[&std::ffi::OsStr],
    )
    .map_err(|_| {
        github_error(
            "repository_unavailable",
            "Existing Git metadata could not be opened safely.",
        )
    })
}

fn preflight_repository_git_directory(root: &Path) -> Result<(), BoundaryError> {
    let canonical_root = root.canonicalize().map_err(|_| {
        github_error(
            "project_unavailable",
            "The selected project folder is unavailable.",
        )
    })?;
    let git_entry = root.join(".git");
    let metadata = fs::symlink_metadata(&git_entry).map_err(|_| {
        github_error(
            "repository_unavailable",
            "The selected project is not connected to Git yet.",
        )
    })?;
    if metadata_is_link_or_reparse(&metadata) || !metadata.is_dir() {
        return Err(github_error(
            "repository_denied",
            "Linked or redirected Git metadata is not supported.",
        ));
    }
    let canonical_git_entry = git_entry
        .canonicalize()
        .map_err(|_| git_operation_failed())?;
    if canonical_git_entry.parent() != Some(canonical_root.as_path()) {
        return Err(github_error(
            "repository_denied",
            "Git metadata must remain inside the selected project folder.",
        ));
    }
    preflight_local_git_config(&canonical_git_entry.join("config"))?;
    preflight_local_git_config(&canonical_git_entry.join("config.worktree"))
}

fn authorize_repository(root: &Path, repository: &Repository) -> Result<(), BoundaryError> {
    if repository.is_bare() {
        return Err(github_error(
            "repository_denied",
            "Bare Git repositories cannot be edited in UnderTree.",
        ));
    }
    let canonical_root = root.canonicalize().map_err(|_| {
        github_error(
            "project_unavailable",
            "The selected project folder is unavailable.",
        )
    })?;
    let workdir = repository.workdir().ok_or_else(|| {
        github_error(
            "repository_denied",
            "The repository does not have a local working folder.",
        )
    })?;
    let canonical_workdir = workdir.canonicalize().map_err(|_| git_operation_failed())?;
    let canonical_git_dir = repository
        .path()
        .canonicalize()
        .map_err(|_| git_operation_failed())?;
    let canonical_common_dir = repository
        .commondir()
        .canonicalize()
        .map_err(|_| git_operation_failed())?;
    let git_entry = root.join(".git");
    let git_entry_metadata = fs::symlink_metadata(&git_entry).map_err(|_| {
        github_error(
            "repository_denied",
            "Git metadata must remain inside the selected project folder.",
        )
    })?;
    if metadata_is_link_or_reparse(&git_entry_metadata) || !git_entry_metadata.is_dir() {
        return Err(github_error(
            "repository_denied",
            "Linked or redirected Git metadata is not supported.",
        ));
    }
    let canonical_git_entry = git_entry
        .canonicalize()
        .map_err(|_| git_operation_failed())?;
    if canonical_workdir != canonical_root
        || !canonical_git_dir.starts_with(&canonical_root)
        || canonical_git_entry != canonical_git_dir
        || canonical_common_dir != canonical_git_dir
    {
        return Err(github_error(
            "repository_denied",
            "Git metadata must remain inside the selected project folder.",
        ));
    }

    let alternates = canonical_common_dir.join("objects/info/alternates");
    match fs::symlink_metadata(&alternates) {
        Ok(_) => {
            return Err(github_error(
                "repository_denied",
                "Git object alternates outside this project are not supported.",
            ));
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(_) => return Err(git_operation_failed()),
    }

    let mut inspected_entries = 0;
    for relative in ["objects", "refs", "logs", "info"] {
        validate_git_metadata_tree(
            &canonical_common_dir.join(relative),
            &canonical_common_dir,
            &mut inspected_entries,
        )?;
    }
    for relative in [
        "config",
        "config.worktree",
        "index",
        "packed-refs",
        "HEAD",
        "FETCH_HEAD",
        "ORIG_HEAD",
        "MERGE_HEAD",
        "MERGE_MSG",
        "MERGE_MODE",
        "SQUASH_MSG",
        "shallow",
    ] {
        validate_git_metadata_tree(
            &canonical_common_dir.join(relative),
            &canonical_common_dir,
            &mut inspected_entries,
        )?;
    }
    preflight_local_git_config(&canonical_common_dir.join("config"))?;
    preflight_local_git_config(&canonical_common_dir.join("config.worktree"))?;
    reject_tracked_undertree(repository)
}

fn validate_git_metadata_tree(
    root: &Path,
    canonical_git_dir: &Path,
    inspected_entries: &mut usize,
) -> Result<(), BoundaryError> {
    let mut pending = vec![root.to_path_buf()];
    while let Some(path) = pending.pop() {
        let metadata = match fs::symlink_metadata(&path) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == io::ErrorKind::NotFound => continue,
            Err(_) => return Err(git_operation_failed()),
        };
        *inspected_entries = inspected_entries.saturating_add(1);
        if *inspected_entries > MAX_GIT_METADATA_ENTRIES {
            return Err(github_error(
                "repository_denied",
                "This repository has too much Git metadata to validate safely.",
            ));
        }
        if metadata_is_link_or_reparse(&metadata) {
            return Err(github_error(
                "repository_denied",
                "Git metadata links and redirected paths are not supported.",
            ));
        }
        let canonical = path.canonicalize().map_err(|_| git_operation_failed())?;
        if !canonical.starts_with(canonical_git_dir) {
            return Err(github_error(
                "repository_denied",
                "Git metadata must remain inside the selected project folder.",
            ));
        }
        if metadata.is_dir() {
            let entries = fs::read_dir(&path).map_err(|_| git_operation_failed())?;
            for entry in entries {
                pending.push(entry.map_err(|_| git_operation_failed())?.path());
            }
        } else if !metadata.is_file() {
            return Err(github_error(
                "repository_denied",
                "Special files in Git metadata are not supported.",
            ));
        }
    }
    Ok(())
}

fn metadata_is_link_or_reparse(metadata: &fs::Metadata) -> bool {
    if metadata.file_type().is_symlink() {
        return true;
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;

        const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x0400;
        metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
    }
    #[cfg(not(windows))]
    {
        false
    }
}

fn preflight_local_git_config(config_path: &Path) -> Result<(), BoundaryError> {
    let metadata = match fs::symlink_metadata(config_path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(_) => return Err(git_operation_failed()),
    };
    if metadata_is_link_or_reparse(&metadata)
        || !metadata.is_file()
        || metadata.len() > MAX_LOCAL_GIT_CONFIG_BYTES
    {
        return Err(invalid_local_git_config());
    }
    let contents = fs::read(config_path).map_err(|_| invalid_local_git_config())?;
    if contents.len() as u64 > MAX_LOCAL_GIT_CONFIG_BYTES {
        return Err(invalid_local_git_config());
    }
    validate_local_git_config_contents(&contents)
}

fn validate_local_git_config_contents(contents: &[u8]) -> Result<(), BoundaryError> {
    if contents.contains(&0) {
        return Err(invalid_local_git_config());
    }
    let text = std::str::from_utf8(contents).map_err(|_| invalid_local_git_config())?;
    let text = text.strip_prefix('\u{feff}').unwrap_or(text);
    let mut current_section: Option<String> = None;
    for raw_line in text.split('\n') {
        let raw_line = raw_line.strip_suffix('\r').unwrap_or(raw_line);
        if raw_line.contains('\r') {
            return Err(invalid_local_git_config());
        }
        let line = raw_line.trim_matches(|character: char| character.is_ascii_whitespace());
        if line.is_empty() || line.starts_with('#') || line.starts_with(';') {
            continue;
        }
        if line.starts_with('[') {
            current_section = Some(validate_local_git_config_section(line)?);
        } else {
            validate_local_git_config_variable(line, current_section.as_deref())?;
        }
    }
    Ok(())
}

fn validate_local_git_config_section(line: &str) -> Result<String, BoundaryError> {
    let bytes = line.as_bytes();
    let mut quoted = false;
    let mut escaped = false;
    let mut closing = None;
    for (index, byte) in bytes.iter().copied().enumerate().skip(1) {
        if escaped {
            if !matches!(byte, b'\\' | b'"') {
                return Err(invalid_local_git_config());
            }
            escaped = false;
        } else if byte == b'\\' && quoted {
            escaped = true;
        } else if byte == b'"' {
            quoted = !quoted;
        } else if byte == b']' && !quoted {
            closing = Some(index);
            break;
        }
    }
    if escaped || quoted {
        return Err(invalid_local_git_config());
    }
    let closing = closing.ok_or_else(invalid_local_git_config)?;
    let trailing =
        line[closing + 1..].trim_matches(|character: char| character.is_ascii_whitespace());
    if !trailing.is_empty() && !trailing.starts_with('#') && !trailing.starts_with(';') {
        return Err(invalid_local_git_config());
    }
    let section = line[1..closing].trim_matches(|character: char| character.is_ascii_whitespace());
    let name_end = section
        .find(|character: char| character.is_ascii_whitespace() || character == '"')
        .unwrap_or(section.len());
    let name = &section[..name_end];
    if name.is_empty()
        || !name
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'.'))
    {
        return Err(invalid_local_git_config());
    }
    let normalized_name = name.to_ascii_lowercase();
    let base_name = normalized_name.split('.').next().unwrap_or_default();
    if matches!(base_name, "include" | "includeif") {
        return Err(external_config_include_error());
    }
    if matches!(base_name, "http" | "https" | "url" | "credential") {
        return Err(transport_config_override_error());
    }

    let subsection =
        section[name_end..].trim_matches(|character: char| character.is_ascii_whitespace());
    if !subsection.is_empty()
        && !(subsection.starts_with('"') && subsection.ends_with('"') && subsection.len() >= 2)
    {
        return Err(invalid_local_git_config());
    }
    Ok(base_name.to_owned())
}

fn validate_local_git_config_variable(
    line: &str,
    current_section: Option<&str>,
) -> Result<(), BoundaryError> {
    let key_end = line
        .find(|character: char| character.is_ascii_whitespace() || character == '=')
        .unwrap_or(line.len());
    let key = &line[..key_end];
    if key.is_empty()
        || !key.as_bytes()[0].is_ascii_alphabetic()
        || !key
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'.'))
    {
        return Err(invalid_local_git_config());
    }
    let normalized_key = key.to_ascii_lowercase();
    if normalized_key == "include.path"
        || (normalized_key.starts_with("includeif.") && normalized_key.ends_with(".path"))
    {
        return Err(external_config_include_error());
    }
    let section = current_section.ok_or_else(invalid_local_git_config)?;
    if (section == "remote"
        && matches!(
            normalized_key.as_str(),
            "proxy" | "proxyauthmethod" | "uploadpack" | "receivepack"
        ))
        || (section == "core"
            && matches!(
                normalized_key.as_str(),
                "gitproxy" | "sshcommand" | "askpass"
            ))
    {
        return Err(transport_config_override_error());
    }
    let remainder =
        line[key_end..].trim_start_matches(|character: char| character.is_ascii_whitespace());
    let value = if let Some(value) = remainder.strip_prefix('=') {
        value.trim_start_matches(|character: char| character.is_ascii_whitespace())
    } else if remainder.is_empty() || remainder.starts_with('#') || remainder.starts_with(';') {
        return Ok(());
    } else {
        return Err(invalid_local_git_config());
    };
    validate_local_git_config_value(value)
}

fn validate_local_git_config_value(value: &str) -> Result<(), BoundaryError> {
    let mut quoted = false;
    let mut escaped = false;
    for byte in value.bytes() {
        if escaped {
            if !matches!(byte, b'n' | b't' | b'b' | b'\\' | b'"') {
                return Err(invalid_local_git_config());
            }
            escaped = false;
        } else if byte == b'\\' {
            escaped = true;
        } else if byte == b'"' {
            quoted = !quoted;
        } else if !quoted && matches!(byte, b'#' | b';') {
            break;
        } else if byte.is_ascii_control() && byte != b'\t' {
            return Err(invalid_local_git_config());
        }
    }
    if escaped || quoted {
        return Err(invalid_local_git_config());
    }
    Ok(())
}

fn invalid_local_git_config() -> BoundaryError {
    github_error(
        "repository_denied",
        "The local Git configuration is invalid or too large to validate safely.",
    )
}

fn external_config_include_error() -> BoundaryError {
    github_error(
        "repository_denied",
        "External Git configuration includes are not supported.",
    )
}

fn transport_config_override_error() -> BoundaryError {
    github_error(
        "repository_denied",
        "Repository-local Git transport, credential, proxy, and TLS overrides are not supported.",
    )
}

fn reject_tracked_undertree(repository: &Repository) -> Result<(), BoundaryError> {
    let index = repository.index().map_err(|_| git_operation_failed())?;
    if index
        .iter()
        .any(|entry| is_undertree_index_path(&entry.path))
    {
        return Err(tracked_undertree_error());
    }

    match repository.head() {
        Ok(head) => {
            let commit = head.peel_to_commit().map_err(|_| git_operation_failed())?;
            reject_undertree_in_commit(repository, commit.id())?;
        }
        Err(error)
            if matches!(
                error.code(),
                git2::ErrorCode::UnbornBranch | git2::ErrorCode::NotFound
            ) => {}
        Err(_) => return Err(git_operation_failed()),
    }
    Ok(())
}

fn reject_undertree_in_commit(
    repository: &Repository,
    commit_id: git2::Oid,
) -> Result<(), BoundaryError> {
    let commit = repository
        .find_commit(commit_id)
        .map_err(|_| git_operation_failed())?;
    let tree = commit.tree().map_err(|_| git_operation_failed())?;
    if tree
        .iter()
        .any(|entry| entry.name_bytes().eq_ignore_ascii_case(b".undertree"))
    {
        return Err(tracked_undertree_error());
    }
    Ok(())
}

fn validate_checkout_commit(
    repository: &Repository,
    commit_id: git2::Oid,
) -> Result<(), BoundaryError> {
    reject_undertree_in_commit(repository, commit_id)?;
    let commit = repository
        .find_commit(commit_id)
        .map_err(|_| git_operation_failed())?;
    let tree = commit.tree().map_err(|_| git_operation_failed())?;
    let odb = repository.odb().map_err(|_| git_operation_failed())?;
    let mut paths = 0usize;
    let mut bytes = 0usize;
    let mut failure = None;
    tree.walk(TreeWalkMode::PreOrder, |parent, entry| {
        paths = paths.saturating_add(1);
        if paths > MAX_CHECKOUT_PATHS
            || parent.len().saturating_add(entry.name_bytes().len()) > 32 * 1024
        {
            failure = Some(checkout_limit_error());
            return TreeWalkResult::Abort;
        }
        if entry.kind() == Some(git2::ObjectType::Blob) {
            match odb.read_header(entry.id()) {
                Ok((size, git2::ObjectType::Blob)) => {
                    bytes = bytes.saturating_add(size);
                    if bytes > MAX_CHECKOUT_BYTES {
                        failure = Some(checkout_limit_error());
                        return TreeWalkResult::Abort;
                    }
                }
                _ => {
                    failure = Some(git_operation_failed());
                    return TreeWalkResult::Abort;
                }
            }
        }
        TreeWalkResult::Ok
    })
    .map_err(|_| failure.take().unwrap_or_else(git_operation_failed))?;
    if let Some(error) = failure {
        return Err(error);
    }
    Ok(())
}

fn checkout_limit_error() -> BoundaryError {
    github_error(
        "checkout_too_large",
        "This repository would create too many files or too much expanded data for one safe UnderTree checkout.",
    )
}

fn is_undertree_index_path(path: &[u8]) -> bool {
    path.split(|byte| matches!(*byte, b'/' | b'\\'))
        .next()
        .is_some_and(|component| component.eq_ignore_ascii_case(b".undertree"))
}

fn tracked_undertree_error() -> BoundaryError {
    github_error(
        "repository_denied",
        "Repositories that track UnderTree's private .undertree folder cannot be synchronized.",
    )
}

fn ensure_local_excludes(root: &Path, repository: &Repository) -> Result<(), BoundaryError> {
    authorize_repository(root, repository)?;
    let common = repository
        .commondir()
        .canonicalize()
        .map_err(|_| git_operation_failed())?;
    let info = common.join("info");
    match fs::symlink_metadata(&info) {
        Ok(metadata) if metadata_is_link_or_reparse(&metadata) || !metadata.is_dir() => {
            return Err(github_error(
                "repository_denied",
                "Git metadata links outside the selected project are not supported.",
            ));
        }
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            fs::create_dir(&info).map_err(|_| git_operation_failed())?;
        }
        Err(_) => return Err(git_operation_failed()),
    }
    let canonical_info = info.canonicalize().map_err(|_| git_operation_failed())?;
    let canonical_root = root.canonicalize().map_err(|_| git_operation_failed())?;
    if !canonical_info.starts_with(canonical_root) {
        return Err(github_error(
            "repository_denied",
            "Git metadata must remain inside the selected project folder.",
        ));
    }

    let exclude = info.join("exclude");
    let mut contents = match fs::symlink_metadata(&exclude) {
        Ok(metadata)
            if metadata_is_link_or_reparse(&metadata)
                || !metadata.is_file()
                || metadata.len() > 64 * 1024 =>
        {
            return Err(github_error(
                "repository_denied",
                "The local Git exclude file is not safe to update.",
            ));
        }
        Ok(_) => fs::read(&exclude).map_err(|_| git_operation_failed())?,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Vec::new(),
        Err(_) => return Err(git_operation_failed()),
    };
    if String::from_utf8_lossy(&contents)
        .lines()
        .any(|line| matches!(line.trim(), ".undertree" | ".undertree/"))
    {
        return Ok(());
    }
    if !contents.is_empty() && !contents.ends_with(b"\n") {
        contents.push(b'\n');
    }
    contents.extend_from_slice(b".undertree/\n");
    let mut file = AtomicWriteFile::open(&exclude).map_err(|_| git_operation_failed())?;
    file.write_all(&contents)
        .map_err(|_| git_operation_failed())?;
    file.sync_all().map_err(|_| git_operation_failed())?;
    file.commit().map_err(|_| git_operation_failed())
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct DirectoryIdentity {
    #[cfg(unix)]
    device: u64,
    #[cfg(unix)]
    inode: u64,
    #[cfg(windows)]
    volume_serial_number: u32,
    #[cfg(windows)]
    file_index: u64,
}

fn directory_identity(path: &Path, metadata: &fs::Metadata) -> Option<DirectoryIdentity> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;

        let _ = path;
        Some(DirectoryIdentity {
            device: metadata.dev(),
            inode: metadata.ino(),
        })
    }
    #[cfg(windows)]
    {
        use std::ffi::c_void;
        use std::os::windows::fs::OpenOptionsExt;
        use std::os::windows::io::AsRawHandle;

        const FILE_FLAG_BACKUP_SEMANTICS: u32 = 0x0200_0000;
        const FILE_FLAG_OPEN_REPARSE_POINT: u32 = 0x0020_0000;

        #[repr(C)]
        struct FileTime {
            low: u32,
            high: u32,
        }

        #[repr(C)]
        struct ByHandleFileInformation {
            file_attributes: u32,
            creation_time: FileTime,
            last_access_time: FileTime,
            last_write_time: FileTime,
            volume_serial_number: u32,
            file_size_high: u32,
            file_size_low: u32,
            number_of_links: u32,
            file_index_high: u32,
            file_index_low: u32,
        }

        unsafe extern "system" {
            fn GetFileInformationByHandle(
                file: *mut c_void,
                information: *mut ByHandleFileInformation,
            ) -> i32;
        }

        let _ = metadata;
        let file = fs::OpenOptions::new()
            .read(true)
            .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT)
            .open(path)
            .ok()?;
        let mut information = std::mem::MaybeUninit::<ByHandleFileInformation>::uninit();
        // SAFETY: the handle is valid for this call and the output points to writable storage.
        if unsafe { GetFileInformationByHandle(file.as_raw_handle(), information.as_mut_ptr()) }
            == 0
        {
            return None;
        }
        // SAFETY: GetFileInformationByHandle succeeded and initialized the entire structure.
        let information = unsafe { information.assume_init() };

        Some(DirectoryIdentity {
            volume_serial_number: information.volume_serial_number,
            file_index: (u64::from(information.file_index_high) << 32)
                | u64::from(information.file_index_low),
        })
    }
    #[cfg(not(any(unix, windows)))]
    {
        let _ = (path, metadata);
        None
    }
}

pub(crate) fn project_directory_identity(root: &Path) -> Result<String, BoundaryError> {
    let canonical = root.canonicalize().map_err(|_| {
        github_error(
            "project_unavailable",
            "The selected project folder is unavailable.",
        )
    })?;
    let metadata = fs::symlink_metadata(&canonical).map_err(|_| {
        github_error(
            "project_unavailable",
            "The selected project folder is unavailable.",
        )
    })?;
    if metadata_is_link_or_reparse(&metadata) || !metadata.is_dir() {
        return Err(github_error(
            "project_unavailable",
            "The selected project folder is unavailable.",
        ));
    }
    let identity = directory_identity(&canonical, &metadata).ok_or_else(|| {
        github_error(
            "project_unavailable",
            "UnderTree could not securely identify the selected project folder.",
        )
    })?;
    #[cfg(unix)]
    return Ok(format!("unix:{}:{}", identity.device, identity.inode));
    #[cfg(windows)]
    return Ok(format!(
        "windows:{}:{}",
        identity.volume_serial_number, identity.file_index
    ));
    #[cfg(not(any(unix, windows)))]
    Err(github_error(
        "project_unavailable",
        "UnderTree cannot securely identify project folders on this platform.",
    ))
}

struct OwnedCloneDirectory {
    parent: PathBuf,
    path: Option<PathBuf>,
    identity: DirectoryIdentity,
}

impl OwnedCloneDirectory {
    fn create(parent: &Path) -> Result<Self, BoundaryError> {
        let canonical_parent = parent.canonicalize().map_err(|_| {
            github_error(
                "clone_destination_unavailable",
                "The selected local storage folder is unavailable.",
            )
        })?;
        if canonical_parent != parent || !canonical_parent.is_dir() {
            return Err(github_error(
                "clone_destination_unavailable",
                "Choose a stable folder for the local repository copy.",
            ));
        }

        for _ in 0..128 {
            let sequence = CLONE_DIRECTORY_NONCE.fetch_add(1, Ordering::Relaxed);
            let path =
                canonical_parent.join(format!(".ut-clone-{:x}-{sequence:x}", std::process::id()));
            match fs::create_dir(&path) {
                Ok(()) => {
                    let metadata = fs::symlink_metadata(&path).map_err(|_| {
                        github_error(
                            "clone_destination_unavailable",
                            "UnderTree could not validate its temporary clone folder.",
                        )
                    })?;
                    let Some(identity) = directory_identity(&path, &metadata) else {
                        let _ = fs::remove_dir(&path);
                        return Err(github_error(
                            "clone_destination_unavailable",
                            "UnderTree could not identify its temporary clone folder safely.",
                        ));
                    };
                    let owned = Self {
                        parent: canonical_parent.clone(),
                        path: Some(path),
                        identity,
                    };
                    let created = owned
                        .path()
                        .canonicalize()
                        .map_err(|_| git_operation_failed())?;
                    if created.parent() != Some(canonical_parent.as_path()) {
                        return Err(github_error(
                            "clone_destination_unavailable",
                            "UnderTree could not create a confined temporary clone folder.",
                        ));
                    }
                    return Ok(owned);
                }
                Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
                Err(_) => {
                    return Err(github_error(
                        "clone_destination_unavailable",
                        "UnderTree could not create a temporary clone folder in the selected location.",
                    ));
                }
            }
        }
        Err(github_error(
            "clone_destination_unavailable",
            "UnderTree could not reserve a temporary clone folder in the selected location.",
        ))
    }

    fn path(&self) -> &Path {
        self.path
            .as_deref()
            .expect("owned clone directory is active")
    }

    fn promote(mut self, target: &Path) -> Result<(), BoundaryError> {
        if target.parent() != Some(self.parent.as_path()) {
            return Err(github_error(
                "clone_destination_unavailable",
                "The cloned repository target is outside the selected location.",
            ));
        }
        if !self.owns_current_path() {
            return Err(github_error(
                "clone_failed",
                "The temporary clone folder changed before it could be finalized.",
            ));
        }
        ensure_clone_target_absent(target)?;
        match rename_directory_noreplace(self.path(), target) {
            Ok(()) => {
                self.path = None;
                Ok(())
            }
            Err(_) => {
                if fs::symlink_metadata(target).is_ok() {
                    Err(github_error(
                        "clone_destination_exists",
                        "A file or folder with this repository name already exists in the selected location.",
                    ))
                } else {
                    Err(github_error(
                        "clone_failed",
                        "UnderTree could not finalize the local GitHub repository copy.",
                    ))
                }
            }
        }
    }

    fn owns_current_path(&self) -> bool {
        let Some(path) = self.path.as_deref() else {
            return false;
        };
        if path.parent() != Some(self.parent.as_path()) {
            return false;
        }
        let Ok(metadata) = fs::symlink_metadata(path) else {
            return false;
        };
        if metadata_is_link_or_reparse(&metadata)
            || !metadata.is_dir()
            || directory_identity(path, &metadata) != Some(self.identity)
        {
            return false;
        }
        path.canonicalize()
            .is_ok_and(|canonical| canonical.parent() == Some(self.parent.as_path()))
    }
}

impl Drop for OwnedCloneDirectory {
    fn drop(&mut self) {
        let Some(path) = self.path.take() else {
            return;
        };
        let Ok(metadata) = fs::symlink_metadata(&path) else {
            return;
        };
        if path.parent() != Some(self.parent.as_path())
            || metadata_is_link_or_reparse(&metadata)
            || !metadata.is_dir()
            || directory_identity(&path, &metadata) != Some(self.identity)
        {
            return;
        }
        let Ok(canonical_path) = path.canonicalize() else {
            return;
        };
        if canonical_path.parent() == Some(self.parent.as_path()) {
            let _ = fs::remove_dir_all(canonical_path);
        }
    }
}

fn ensure_clone_target_absent(target: &Path) -> Result<(), BoundaryError> {
    match fs::symlink_metadata(target) {
        Ok(_) => Err(github_error(
            "clone_destination_exists",
            "A file or folder with this repository name already exists in the selected location.",
        )),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(_) => Err(github_error(
            "clone_destination_unavailable",
            "UnderTree could not inspect the selected local storage folder.",
        )),
    }
}

#[cfg(windows)]
fn rename_directory_noreplace(source: &Path, target: &Path) -> io::Result<()> {
    // MoveFileExW, used by std on Windows, fails when the destination exists.
    fs::rename(source, target)
}

#[cfg(any(target_os = "linux", target_os = "android"))]
fn rename_directory_noreplace(source: &Path, target: &Path) -> io::Result<()> {
    use std::ffi::CString;
    use std::os::raw::{c_char, c_int, c_uint};
    use std::os::unix::ffi::OsStrExt;

    const AT_FDCWD: c_int = -100;
    const RENAME_NOREPLACE: c_uint = 1;
    unsafe extern "C" {
        fn renameat2(
            olddirfd: c_int,
            oldpath: *const c_char,
            newdirfd: c_int,
            newpath: *const c_char,
            flags: c_uint,
        ) -> c_int;
    }

    let source = CString::new(source.as_os_str().as_bytes())
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "path contains NUL"))?;
    let target = CString::new(target.as_os_str().as_bytes())
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "path contains NUL"))?;
    // SAFETY: both C strings remain alive for the call and point to valid, NUL-terminated paths.
    let result = unsafe {
        renameat2(
            AT_FDCWD,
            source.as_ptr(),
            AT_FDCWD,
            target.as_ptr(),
            RENAME_NOREPLACE,
        )
    };
    if result == 0 {
        Ok(())
    } else {
        Err(io::Error::last_os_error())
    }
}

#[cfg(any(target_os = "macos", target_os = "ios"))]
fn rename_directory_noreplace(source: &Path, target: &Path) -> io::Result<()> {
    use std::ffi::CString;
    use std::os::raw::{c_char, c_int, c_uint};
    use std::os::unix::ffi::OsStrExt;

    const RENAME_EXCL: c_uint = 0x0000_0004;
    unsafe extern "C" {
        fn renamex_np(oldpath: *const c_char, newpath: *const c_char, flags: c_uint) -> c_int;
    }

    let source = CString::new(source.as_os_str().as_bytes())
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "path contains NUL"))?;
    let target = CString::new(target.as_os_str().as_bytes())
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "path contains NUL"))?;
    // SAFETY: both C strings remain alive for the call and point to valid, NUL-terminated paths.
    let result = unsafe { renamex_np(source.as_ptr(), target.as_ptr(), RENAME_EXCL) };
    if result == 0 {
        Ok(())
    } else {
        Err(io::Error::last_os_error())
    }
}

#[cfg(all(
    unix,
    not(any(
        target_os = "linux",
        target_os = "android",
        target_os = "macos",
        target_os = "ios"
    ))
))]
fn rename_directory_noreplace(_source: &Path, _target: &Path) -> io::Result<()> {
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "atomic no-replace rename is unavailable on this platform",
    ))
}

#[cfg(not(any(unix, windows)))]
fn rename_directory_noreplace(_source: &Path, _target: &Path) -> io::Result<()> {
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "atomic no-replace rename is unavailable on this platform",
    ))
}

fn ensure_idle_repository(repository: &Repository) -> Result<(), BoundaryError> {
    if repository.state() != RepositoryState::Clean {
        return Err(github_error(
            "git_operation_in_progress",
            "Finish the current Git merge, rebase, or other operation before synchronizing.",
        ));
    }
    Ok(())
}

fn collect_statuses(
    repository: &Repository,
) -> Result<Vec<(std::path::PathBuf, Status)>, BoundaryError> {
    let mut options = StatusOptions::new();
    options
        .include_untracked(true)
        .recurse_untracked_dirs(true)
        .include_ignored(false)
        .renames_head_to_index(true)
        .renames_index_to_workdir(true);
    let statuses = repository
        .statuses(Some(&mut options))
        .map_err(|_| git_operation_failed())?;
    if statuses.len() > MAX_CHANGED_PATHS {
        return Err(github_error(
            "too_many_changes",
            "This project has too many changed paths to synchronize safely in one operation.",
        ));
    }
    Ok(statuses
        .iter()
        .filter_map(|entry| {
            let path = entry.path_bytes();
            if path.is_empty() {
                None
            } else {
                Some((bytes_to_path(path), entry.status()))
            }
        })
        .filter(|(path, _)| !is_undertree_internal(path))
        .collect())
}

#[cfg(unix)]
fn bytes_to_path(bytes: &[u8]) -> std::path::PathBuf {
    use std::os::unix::ffi::OsStrExt;
    std::ffi::OsStr::from_bytes(bytes).into()
}

#[cfg(not(unix))]
fn bytes_to_path(bytes: &[u8]) -> std::path::PathBuf {
    String::from_utf8_lossy(bytes).into_owned().into()
}

fn ahead_behind(repository: &Repository, branch: &str) -> (usize, usize) {
    let local = repository
        .find_branch(branch, BranchType::Local)
        .ok()
        .and_then(|branch| branch.get().target());
    let remote = repository
        .find_reference(&format!("refs/remotes/{REMOTE_NAME}/{branch}"))
        .ok()
        .and_then(|reference| reference.target());
    match (local, remote) {
        (Some(local), Some(remote)) => repository
            .graph_ahead_behind(local, remote)
            .unwrap_or((0, 0)),
        _ => (0, 0),
    }
}

fn current_branch(repository: &Repository) -> Option<String> {
    repository
        .head()
        .ok()
        .filter(|head| head.is_branch())
        .and_then(|head| head.shorthand().ok().map(str::to_owned))
}

fn status_label(status: Status) -> &'static str {
    if status.is_conflicted() {
        "conflict"
    } else if status.intersects(Status::WT_DELETED | Status::INDEX_DELETED) {
        "deleted"
    } else if status.intersects(Status::WT_RENAMED | Status::INDEX_RENAMED) {
        "renamed"
    } else if status.intersects(Status::WT_NEW | Status::INDEX_NEW) {
        "new"
    } else if status.intersects(Status::WT_TYPECHANGE | Status::INDEX_TYPECHANGE) {
        "type changed"
    } else {
        "modified"
    }
}

fn valid_repository_component(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 100
        && value != "."
        && value != ".."
        && value.chars().all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '-' | '_' | '.')
        })
}

fn is_undertree_internal(path: &Path) -> bool {
    matches!(
        path.components().next(),
        Some(Component::Normal(component))
            if component.to_string_lossy().eq_ignore_ascii_case(".undertree")
    )
}

fn github_error(code: &'static str, message: &'static str) -> BoundaryError {
    BoundaryError::github(code, message)
}

fn git_operation_failed() -> BoundaryError {
    github_error(
        "git_operation_failed",
        "UnderTree could not complete the local Git operation.",
    )
}

fn checkout_failed() -> BoundaryError {
    github_error(
        "checkout_failed",
        "GitHub was fetched, but the working folder could not be updated safely.",
    )
}

fn unsaved_editor_error() -> BoundaryError {
    github_error(
        "unsaved_editor",
        "Save the active document before synchronizing with GitHub.",
    )
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::time::{SystemTime, UNIX_EPOCH};

    use super::*;

    fn temporary_directory(name: &str) -> std::path::PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time")
            .as_nanos();
        let path = std::env::temp_dir().join(format!("undertree-git-{name}-{nonce}"));
        fs::create_dir_all(&path).expect("create test directory");
        path
    }

    #[test]
    fn validates_github_repository_names_and_branches() {
        assert!(validate_repository_name("octocat/hello-world").is_ok());
        assert!(validate_repository_name("missing-owner").is_err());
        assert!(validate_repository_name("owner/repo/extra").is_err());
        assert!(validate_repository_name("owner/repo?token=secret").is_err());
        assert!(validate_branch_name("feature/github-sync").is_ok());
        assert!(validate_branch_name("../escape").is_err());
        assert!(validate_branch_name("main.lock").is_err());
        assert!(validate_new_repository_name("new_typst-project.2026").is_ok());
        assert!(validate_new_repository_name("owner/repository").is_err());
        assert!(validate_new_repository_name("repository.git").is_err());
        assert!(is_undertree_internal(Path::new(".UnderTree/secret")));
    }

    #[test]
    fn rejects_external_worktree_config_before_opening_libgit2() {
        let root = temporary_directory("external-worktree-config");
        let repository = Repository::init(&root).expect("initialize repository");
        drop(repository);
        fs::write(
            root.join(".git").join("config.worktree"),
            "[include]\npath = C:/outside/undertree-config\n",
        )
        .expect("write unsafe worktree config");

        let error = match open_repository(&root) {
            Ok(_) => panic!("external config.worktree include must be rejected before open"),
            Err(error) => error,
        };
        assert_eq!(error.code, "repository_denied");

        fs::remove_dir_all(root).expect("remove test directory");
    }

    #[test]
    fn does_not_reinitialize_existing_corrupt_git_metadata() {
        let root = temporary_directory("corrupt-git");
        let git_dir = root.join(".git");
        fs::create_dir(&git_dir).expect("create corrupt Git directory");
        let sentinel = git_dir.join("owner-data");
        fs::write(&sentinel, "must remain untouched").expect("write sentinel");

        let error = link_repository(&root, "octocat/hello-world", "main")
            .expect_err("corrupt existing Git metadata must be rejected");
        assert_eq!(error.code, "repository_unavailable");
        assert_eq!(
            fs::read_to_string(&sentinel).expect("read preserved sentinel"),
            "must remain untouched"
        );
        assert!(!git_dir.join("HEAD").exists());

        fs::remove_dir_all(root).expect("remove test directory");
    }

    #[test]
    fn linking_a_nested_folder_does_not_open_its_ancestor_repository() {
        let ancestor = temporary_directory("ancestor-repository");
        let ancestor_repository =
            Repository::init(&ancestor).expect("initialize ancestor repository");
        let child = ancestor.join("selected-child");
        fs::create_dir(&child).expect("create selected child folder");
        fs::write(child.join("main.typ"), "= Child").expect("write child source");

        link_repository(&child, "octocat/hello-world", "main")
            .expect("link selected folder as its own repository");
        let child_repository = open_repository(&child).expect("open child repository");
        assert_eq!(
            child_repository
                .workdir()
                .expect("child workdir")
                .canonicalize()
                .expect("canonical child workdir"),
            child.canonicalize().expect("canonical child path")
        );

        drop(child_repository);
        drop(ancestor_repository);
        fs::remove_dir_all(ancestor).expect("remove test directory");
    }

    #[test]
    fn linking_refuses_an_existing_checkout_on_a_different_branch() {
        let root = temporary_directory("link-branch-mismatch");
        fs::write(root.join("main.typ"), "= Main").expect("write main source");
        let repository = Repository::init(&root).expect("initialize repository");
        repository
            .set_head("refs/heads/feature")
            .expect("select feature branch");
        let identity = CommitIdentity {
            name: "UnderTree Test".into(),
            email: "undertree@example.invalid".into(),
        };
        drop(repository);
        commit_all(&root, "feature", "Initial feature", &identity).expect("commit feature");
        let config_path = root.join(".git").join("config");
        let config_before = fs::read(&config_path).expect("read config before rejected link");

        let error = link_repository(&root, "octocat/hello-world", "main")
            .expect_err("link must not silently accept the wrong checked-out branch");
        assert_eq!(error.code, "branch_mismatch");
        assert_eq!(
            fs::read(&config_path).expect("read config after rejected link"),
            config_before,
            "a rejected link must not mutate Git configuration"
        );
        let repository = open_repository(&root).expect("reopen repository");
        assert!(repository.find_remote(REMOTE_NAME).is_err());

        fs::remove_dir_all(root).expect("remove test directory");
    }

    #[test]
    fn rejected_unborn_link_does_not_change_head_or_remote_configuration() {
        let root = temporary_directory("unborn-link-rollback");
        fs::write(root.join("main.typ"), "= Main").expect("write source");
        let repository = Repository::init(&root).expect("initialize repository");
        repository
            .remote("origin", "https://github.com/octocat/different.git")
            .expect("configure different origin");
        let head_reference = repository.find_reference("HEAD").expect("read unborn HEAD");
        let head_before = head_reference
            .symbolic_target()
            .expect("read symbolic unborn HEAD")
            .expect("symbolic unborn HEAD")
            .to_string();
        drop(head_reference);
        drop(repository);
        let config_path = root.join(".git").join("config");
        let config_before = fs::read(&config_path).expect("read config before rejected link");

        let error = link_repository(&root, "octocat/hello-world", "main")
            .expect_err("different origin must reject the link");
        assert_eq!(error.code, "remote_mismatch");

        let repository = open_repository(&root).expect("reopen repository");
        assert_eq!(
            repository
                .find_reference("HEAD")
                .expect("read HEAD after rejection")
                .symbolic_target()
                .expect("read symbolic HEAD after rejection")
                .expect("symbolic HEAD after rejection"),
            head_before.as_str()
        );
        assert_eq!(
            fs::read(&config_path).expect("read config after rejected link"),
            config_before
        );

        fs::remove_dir_all(root).expect("remove test directory");
    }

    #[test]
    fn clone_promotion_never_replaces_an_existing_target() {
        let parent = temporary_directory("clone-promotion");
        let canonical_parent = parent.canonicalize().expect("canonicalize clone parent");
        let staging =
            OwnedCloneDirectory::create(&canonical_parent).expect("create owned staging folder");
        let staging_path = staging.path().to_path_buf();
        fs::write(staging.path().join("cloned-data"), "clone").expect("write staged clone");

        let target = canonical_parent.join("hello-world");
        fs::create_dir(&target).expect("create racing target");
        let sentinel = target.join("owner-data");
        fs::write(&sentinel, "must remain untouched").expect("write target sentinel");

        let error = staging
            .promote(&target)
            .expect_err("promotion must not replace a target created during clone");
        assert_eq!(error.code, "clone_destination_exists");
        assert_eq!(
            fs::read_to_string(&sentinel).expect("read target sentinel"),
            "must remain untouched"
        );
        assert!(!staging_path.exists());

        fs::remove_dir_all(parent).expect("remove test directory");
    }

    #[test]
    fn clone_cleanup_does_not_delete_a_replaced_staging_path() {
        let parent = temporary_directory("clone-cleanup-identity");
        let canonical_parent = parent.canonicalize().expect("canonicalize clone parent");
        let staging =
            OwnedCloneDirectory::create(&canonical_parent).expect("create owned staging folder");
        let staging_path = staging.path().to_path_buf();
        fs::remove_dir(&staging_path).expect("remove original empty staging folder");
        fs::create_dir(&staging_path).expect("replace staging folder");
        let sentinel = staging_path.join("replacement-owner-data");
        fs::write(&sentinel, "must remain untouched").expect("write replacement sentinel");

        drop(staging);
        assert_eq!(
            fs::read_to_string(&sentinel).expect("read replacement sentinel"),
            "must remain untouched"
        );

        fs::remove_dir_all(parent).expect("remove test directory");
    }

    #[test]
    fn rejects_object_alternates() {
        let root = temporary_directory("alternates");
        let external = temporary_directory("external-objects");
        let repository = Repository::init(&root).expect("initialize repository");
        let alternates = root.join(".git/objects/info/alternates");
        fs::write(&alternates, external.to_string_lossy().as_bytes())
            .expect("write object alternate");

        let error = authorize_repository(&root, &repository)
            .expect_err("object alternates must be rejected");
        assert_eq!(error.code, "repository_denied");

        drop(repository);
        fs::remove_dir_all(root).expect("remove test repository");
        fs::remove_dir_all(external).expect("remove external object directory");
    }

    #[test]
    fn rejects_external_local_config_includes() {
        let root = temporary_directory("config-include");
        let external = temporary_directory("external-config");
        let included_config = external.join("included.gitconfig");
        fs::write(&included_config, "[user]\n\tname = Outside\n").expect("write included config");
        let repository = Repository::init(&root).expect("initialize repository");
        let mut config =
            git2::Config::open(&root.join(".git/config")).expect("open repository-local config");
        config
            .set_str("include.path", &included_config.to_string_lossy())
            .expect("configure external include");
        drop(config);

        let error = authorize_repository(&root, &repository)
            .expect_err("external Git config includes must be rejected");
        assert_eq!(error.code, "repository_denied");

        drop(repository);
        fs::remove_dir_all(root).expect("remove test repository");
        fs::remove_dir_all(external).expect("remove external config directory");
    }

    #[test]
    fn rejects_invalid_and_oversized_local_git_configs_before_opening() {
        let invalid_root = temporary_directory("invalid-config");
        let invalid_repository =
            Repository::init(&invalid_root).expect("initialize invalid-config repository");
        drop(invalid_repository);
        fs::write(invalid_root.join(".git/config"), "[core\n\tbare = false\n")
            .expect("write invalid config");
        let invalid_error = match open_repository(&invalid_root) {
            Ok(_) => panic!("invalid config must be rejected"),
            Err(error) => error,
        };
        assert_eq!(invalid_error.code, "repository_denied");

        let oversized_root = temporary_directory("oversized-config");
        let oversized_repository =
            Repository::init(&oversized_root).expect("initialize oversized-config repository");
        drop(oversized_repository);
        fs::write(
            oversized_root.join(".git/config"),
            vec![b' '; MAX_LOCAL_GIT_CONFIG_BYTES as usize + 1],
        )
        .expect("write oversized config");
        let oversized_error = match open_repository(&oversized_root) {
            Ok(_) => panic!("oversized config must be rejected"),
            Err(error) => error,
        };
        assert_eq!(oversized_error.code, "repository_denied");

        fs::remove_dir_all(invalid_root).expect("remove invalid-config repository");
        fs::remove_dir_all(oversized_root).expect("remove oversized-config repository");
    }

    #[test]
    fn raw_config_preflight_rejects_dotted_include_keys() {
        let error = validate_local_git_config_contents(
            b"[core]\n\trepositoryformatversion = 0\ninclude.path = ../outside\n",
        )
        .expect_err("dotted include key must be rejected");
        assert_eq!(error.code, "repository_denied");
    }

    #[test]
    fn raw_config_preflight_rejects_transport_and_credential_overrides() {
        for contents in [
            "[http]\n\tsslVerify = false\n",
            "[http \"https://github.com\"]\n\tproxy = http://127.0.0.1:8080\n",
            "[url \"https://attacker.invalid/\"]\n\tinsteadOf = https://github.com/\n",
            "[credential]\n\thelper = malicious-helper\n",
            "[remote \"origin\"]\n\tproxy = http://127.0.0.1:8080\n",
        ] {
            let error = validate_local_git_config_contents(contents.as_bytes())
                .expect_err("repository-local transport overrides must be rejected");
            assert_eq!(error.code, "repository_denied");
        }
    }

    #[test]
    fn rejects_a_tracked_undertree_tree_even_without_an_index() {
        let root = temporary_directory("tracked-undertree");
        let repository = Repository::init(&root).expect("initialize repository");
        fs::create_dir(root.join(".undertree")).expect("create private state directory");
        fs::write(root.join(".undertree/github-sync.json"), "{}")
            .expect("write tracked private state");
        let signature =
            git2::Signature::now("UnderTree Test", "undertree-test@users.noreply.github.com")
                .expect("create signature");
        {
            let mut index = repository.index().expect("open index");
            index
                .add_path(Path::new(".undertree/github-sync.json"))
                .expect("stage private state");
            index.write().expect("write index");
            let tree_id = index.write_tree().expect("write tree");
            let tree = repository.find_tree(tree_id).expect("find tree");
            repository
                .commit(
                    Some("refs/heads/main"),
                    &signature,
                    &signature,
                    "Track private state",
                    &tree,
                    &[],
                )
                .expect("commit private state");
        }
        repository
            .set_head("refs/heads/main")
            .expect("select main branch");
        drop(repository);
        fs::remove_file(root.join(".git/index")).expect("remove index to isolate tree guard");

        let error = match open_repository(&root) {
            Ok(_) => panic!("a committed private UnderTree path must be rejected"),
            Err(error) => error,
        };
        assert_eq!(error.code, "repository_denied");

        fs::remove_dir_all(root).expect("remove test repository");
    }

    #[cfg(unix)]
    #[test]
    fn rejects_nested_git_metadata_symlinks() {
        use std::os::unix::fs::symlink;

        let root = temporary_directory("nested-metadata-link");
        let external = temporary_directory("external-metadata");
        let repository = Repository::init(&root).expect("initialize repository");
        symlink(&external, root.join(".git/objects/linked"))
            .expect("create nested metadata symlink");

        let error = authorize_repository(&root, &repository)
            .expect_err("nested Git metadata links must be rejected");
        assert_eq!(error.code, "repository_denied");

        drop(repository);
        fs::remove_dir_all(root).expect("remove test repository");
        fs::remove_dir_all(external).expect("remove external metadata directory");
    }

    #[test]
    fn commit_message_limit_counts_characters_instead_of_utf8_bytes() {
        let root = temporary_directory("unicode-message");
        fs::write(root.join("main.typ"), "= Hello").expect("write source");
        link_repository(&root, "octocat/hello-world", "main").expect("link repository");
        let identity = CommitIdentity {
            name: "UnderTree Test".into(),
            email: "undertree-test@users.noreply.github.com".into(),
        };

        assert!(
            commit_all(&root, "main", &"é".repeat(200), &identity)
                .expect("200 Unicode characters are valid")
        );
        fs::write(root.join("main.typ"), "= Changed").expect("edit source");
        let error = commit_all(&root, "main", &"é".repeat(201), &identity)
            .expect_err("201 Unicode characters must be rejected");
        assert_eq!(error.code, "invalid_commit_message");

        fs::remove_dir_all(root).expect("remove test directory");
    }

    #[test]
    fn push_pack_preflight_does_not_trust_remote_tracking_refs() {
        let root = temporary_directory("push-pack-preflight");
        fs::write(root.join("main.typ"), "= Base").expect("write base source");
        link_repository(&root, "octocat/hello-world", "main").expect("link repository");
        let identity = CommitIdentity {
            name: "UnderTree Test".into(),
            email: "undertree-test@users.noreply.github.com".into(),
        };
        commit_all(&root, "main", "Base", &identity).expect("commit base");
        let repository = open_repository(&root).expect("open base repository");
        let base_id = repository
            .refname_to_id("refs/heads/main")
            .expect("read base id");
        repository
            .reference(
                "refs/remotes/origin/main",
                base_id,
                true,
                "test origin baseline",
            )
            .expect("record origin baseline");
        drop(repository);

        fs::write(root.join("main.typ"), "= Ahead").expect("write ahead source");
        commit_all(&root, "main", "Ahead", &identity).expect("commit ahead change");
        let repository = open_repository(&root).expect("open ahead repository");
        let (objects, bytes) =
            preflight_push_pack(&repository, "main").expect("preflight outgoing pack");
        assert!(objects > 0);
        assert!(bytes > 0);
        assert!(transfer_within_limits(Instant::now(), objects, bytes));

        let head_id = repository
            .refname_to_id("refs/heads/main")
            .expect("read head id");
        repository
            .reference(
                "refs/remotes/origin/main",
                head_id,
                true,
                "test origin caught up",
            )
            .expect("advance origin baseline");
        let (forged_objects, forged_bytes) = preflight_push_pack(&repository, "main")
            .expect("preflight with forged caught-up origin");
        assert!(forged_objects > 0);
        assert!(forged_bytes > 0);

        drop(repository);
        fs::remove_dir_all(root).expect("remove test directory");
    }

    #[test]
    fn transfer_limit_helper_bounds_time_objects_and_bytes() {
        let started = Instant::now();
        assert!(transfer_within_limits(
            started,
            MAX_TRANSFER_OBJECTS,
            MAX_TRANSFER_BYTES
        ));
        assert!(!transfer_within_limits(
            started,
            MAX_TRANSFER_OBJECTS + 1,
            0
        ));
        assert!(!transfer_within_limits(started, 0, MAX_TRANSFER_BYTES + 1));
        let expired = started
            .checked_sub(MAX_TRANSFER_TIME + Duration::from_secs(1))
            .expect("construct expired start time");
        assert!(!transfer_within_limits(expired, 0, 0));
    }

    #[test]
    fn initializes_confined_repository_and_commits_changes() {
        let root = temporary_directory("commit");
        fs::write(root.join("main.typ"), "= Hello").expect("write source");
        let linked =
            link_repository(&root, "octocat/hello-world", "main").expect("link repository");
        assert!(linked.dirty);
        assert!(
            fs::read_to_string(root.join(".git/info/exclude"))
                .expect("read local excludes")
                .lines()
                .any(|line| line.trim() == ".undertree/")
        );

        let created = commit_all(
            &root,
            "main",
            "Initial UnderTree snapshot",
            &CommitIdentity {
                name: "UnderTree Test".into(),
                email: "undertree-test@users.noreply.github.com".into(),
            },
        )
        .expect("commit project");
        assert!(created);
        assert!(!snapshot(&root, "main").expect("snapshot").dirty);

        fs::remove_dir_all(root).expect("remove test directory");
    }

    #[test]
    fn rejects_a_different_configured_push_destination() {
        let root = temporary_directory("push-url");
        fs::write(root.join("main.typ"), "= Hello").expect("write source");
        link_repository(&root, "octocat/hello-world", "main").expect("link repository");
        let repository = Repository::open(&root).expect("open repository");
        repository
            .remote_set_pushurl(
                REMOTE_NAME,
                Some("https://github.com/octocat/different.git"),
            )
            .expect("configure a different push URL");

        let error = validate_remote(&repository, "octocat/hello-world")
            .expect_err("push URL mismatch must be rejected");
        assert_eq!(error.code, "remote_changed");

        drop(repository);
        fs::remove_dir_all(root).expect("remove test directory");
    }

    #[test]
    fn safe_checkout_does_not_overwrite_a_locally_ignored_file() {
        let root = temporary_directory("ignored-checkout");
        let repository = Repository::init(&root).expect("initialize repository");
        fs::write(root.join(".gitignore"), "private.env\n").expect("write ignore rule");
        fs::write(root.join("main.typ"), "= Base").expect("write base source");

        let signature =
            git2::Signature::now("UnderTree Test", "undertree-test@users.noreply.github.com")
                .expect("create signature");
        let base_id = {
            let mut index = repository.index().expect("open base index");
            index
                .add_all(["*"].iter(), IndexAddOption::DEFAULT, None)
                .expect("stage base files");
            index.write().expect("write base index");
            let tree_id = index.write_tree().expect("write base tree");
            let tree = repository.find_tree(tree_id).expect("find base tree");
            repository
                .commit(
                    Some("refs/heads/main"),
                    &signature,
                    &signature,
                    "Base",
                    &tree,
                    &[],
                )
                .expect("commit base")
        };
        repository
            .set_head("refs/heads/main")
            .expect("select main branch");
        let base = repository.find_commit(base_id).expect("find base commit");

        fs::write(root.join("private.env"), "remote tracked value").expect("write remote version");
        let remote_id = {
            let mut index = repository.index().expect("open remote index");
            index
                .add_path(Path::new("private.env"))
                .expect("stage ignored file explicitly");
            index.write().expect("write remote index");
            let tree_id = index.write_tree().expect("write remote tree");
            let tree = repository.find_tree(tree_id).expect("find remote tree");
            repository
                .commit(
                    Some("refs/heads/remote"),
                    &signature,
                    &signature,
                    "Track ignored path remotely",
                    &tree,
                    &[&base],
                )
                .expect("commit remote version")
        };

        repository
            .reset(base.as_object(), git2::ResetType::Hard, None)
            .expect("restore local baseline");
        fs::write(root.join("private.env"), "local secret").expect("write local ignored file");
        let remote = repository
            .find_commit(remote_id)
            .expect("find remote commit");
        let mut checkout = safe_checkout_builder();
        repository
            .checkout_tree(remote.as_object(), Some(&mut checkout))
            .expect_err("checkout must refuse to overwrite an ignored file");
        assert_eq!(
            fs::read_to_string(root.join("private.env")).expect("read preserved ignored file"),
            "local secret"
        );

        drop(remote);
        drop(base);
        drop(repository);
        fs::remove_dir_all(root).expect("remove test directory");
    }

    #[test]
    fn refuses_to_commit_head_content_to_a_different_configured_branch() {
        let root = temporary_directory("branch-mismatch");
        fs::write(root.join("main.typ"), "= Main").expect("write source");
        link_repository(&root, "octocat/hello-world", "main").expect("link repository");
        let identity = CommitIdentity {
            name: "UnderTree Test".into(),
            email: "undertree-test@users.noreply.github.com".into(),
        };
        commit_all(&root, "main", "Initial main", &identity).expect("commit main");

        let repository = Repository::open(&root).expect("open repository");
        let main_id = repository
            .find_reference("refs/heads/main")
            .expect("main reference")
            .target()
            .expect("main target");
        let main_commit = repository.find_commit(main_id).expect("main commit");
        repository
            .branch("feature", &main_commit, false)
            .expect("create feature branch");
        repository
            .set_head("refs/heads/feature")
            .expect("select feature branch");
        drop(main_commit);
        drop(repository);
        fs::write(root.join("main.typ"), "= Feature").expect("edit feature");

        let error = commit_all(&root, "main", "Must not rewrite main", &identity)
            .expect_err("branch mismatch must be rejected");
        assert_eq!(error.code, "branch_mismatch");
        let repository = Repository::open(&root).expect("reopen repository");
        assert_eq!(
            repository
                .find_reference("refs/heads/main")
                .expect("main reference")
                .target(),
            Some(main_id)
        );

        drop(repository);
        fs::remove_dir_all(root).expect("remove test directory");
    }

    #[test]
    fn merges_non_conflicting_local_and_remote_commits_without_switching_branches() {
        let root = temporary_directory("merge");
        fs::write(root.join("main.typ"), "= Base").expect("write source");
        link_repository(&root, "octocat/hello-world", "main").expect("link repository");
        let identity = CommitIdentity {
            name: "UnderTree Test".into(),
            email: "undertree-test@users.noreply.github.com".into(),
        };
        commit_all(&root, "main", "Base", &identity).expect("commit base");

        let repository = Repository::open(&root).expect("open repository");
        let base = repository
            .head()
            .expect("main head")
            .peel_to_commit()
            .expect("base commit");
        repository
            .branch("remote", &base, false)
            .expect("create remote branch");
        repository
            .set_head("refs/heads/remote")
            .expect("select remote branch");
        let mut checkout = CheckoutBuilder::new();
        checkout.force();
        repository
            .checkout_head(Some(&mut checkout))
            .expect("checkout remote branch");
        drop(base);
        drop(repository);
        fs::write(root.join("remote.typ"), "= Remote").expect("write remote source");
        commit_all(&root, "remote", "Remote edit", &identity).expect("commit remote edit");
        let repository = Repository::open(&root).expect("open remote branch");
        let remote_id = repository
            .head()
            .expect("remote head")
            .target()
            .expect("remote commit id");
        repository
            .set_head("refs/heads/main")
            .expect("select main branch");
        let mut checkout = CheckoutBuilder::new();
        checkout.force();
        repository
            .checkout_head(Some(&mut checkout))
            .expect("checkout main branch");
        drop(repository);
        fs::write(root.join("local.typ"), "= Local").expect("write local source");
        commit_all(&root, "main", "Local edit", &identity).expect("commit local edit");

        let repository = Repository::open(&root).expect("open diverged repository");
        let local_id = repository
            .head()
            .expect("local head")
            .target()
            .expect("local commit id");
        merge_remote_commits(
            &repository,
            "refs/heads/main",
            local_id,
            remote_id,
            "main",
            &identity,
            &|| false,
        )
        .expect("merge non-conflicting commits");
        let merged = repository
            .head()
            .expect("merged head")
            .peel_to_commit()
            .expect("merge commit");
        assert_eq!(merged.parent_count(), 2);
        assert_eq!(
            fs::read_to_string(root.join("local.typ")).expect("read local file"),
            "= Local"
        );
        assert_eq!(
            fs::read_to_string(root.join("remote.typ")).expect("read remote file"),
            "= Remote"
        );

        drop(merged);
        drop(repository);
        fs::remove_dir_all(root).expect("remove test directory");
    }

    #[test]
    fn safety_branch_preserves_the_local_tip_without_switching_branches() {
        let root = temporary_directory("safety-branch");
        fs::write(root.join("main.typ"), "= Local work").expect("write source");
        link_repository(&root, "octocat/hello-world", "main").expect("link repository");
        let identity = CommitIdentity {
            name: "UnderTree Test".into(),
            email: "undertree-test@users.noreply.github.com".into(),
        };
        commit_all(&root, "main", "Local work", &identity).expect("commit local work");

        let repository = Repository::open(&root).expect("open repository");
        let local_id = repository
            .head()
            .expect("main head")
            .target()
            .expect("main commit id");
        let name = create_safety_branch(&repository, local_id, 1_787_961_084)
            .expect("create safety branch");
        assert!(name.starts_with("undertree-safety/1787961084-"));
        assert_eq!(
            repository
                .find_branch(&name, BranchType::Local)
                .expect("safety branch")
                .get()
                .target(),
            Some(local_id)
        );
        assert_eq!(current_branch(&repository).as_deref(), Some("main"));
        assert_eq!(
            create_safety_branch(&repository, local_id, 1_787_961_084)
                .expect("reuse matching safety branch"),
            name
        );

        drop(repository);
        fs::remove_dir_all(root).expect("remove test directory");
    }
}
