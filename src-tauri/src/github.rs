use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use atomic_write_file::AtomicWriteFile;
use reqwest::{Client, Response};
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter};
use tokio::sync::{Mutex, OwnedMutexGuard};
use zeroize::{Zeroize, Zeroizing};

use crate::error::BoundaryError;
use crate::git::{self, CommitIdentity, GitChange, GitSnapshot};
use crate::project::{ProjectSnapshot, ProjectState};

const API_ROOT: &str = "https://api.github.com";
const DEVICE_CODE_URL: &str = "https://github.com/login/device/code";
const DEVICE_LOGIN_URL: &str = "https://github.com/login/device";
const TOKEN_URL: &str = "https://github.com/login/oauth/access_token";
const API_VERSION: &str = "2026-03-10";
// Public identifier for UnderTree's publisher-owned OAuth App. This identifies
// the Device Flow client; it is not a credential and cannot authenticate the
// app. Never add a client secret to a distributed native build.
const UNDERTREE_GITHUB_CLIENT_ID: &str = "Ov23ctI0XuS7MKywUeOf";
const OAUTH_SCOPES: &str = "repo offline_access";
const KEYRING_SERVICE: &str = "io.github.georgefejer91.UnderTree.github";
const KEYRING_ACCOUNT: &str = "github-session";
const APPROVAL_KEYRING_SERVICE: &str = "io.github.georgefejer91.UnderTree.github-project";
const APPROVAL_VERSION: u8 = 2;
const SETTINGS_VERSION: u8 = 1;
const SETTINGS_FILE: &str = "github-sync.json";
const MAX_API_RESPONSE_BYTES: usize = 2 * 1024 * 1024;
const MAX_REPOSITORIES: usize = 10_000;
const SCHEDULER_TICK_SECONDS: u64 = 30;
const EDITOR_STATE_LEASE_SECONDS: u64 = 10;
const ALLOWED_INTERVALS: [u64; 5] = [0, 5, 15, 30, 60];

#[derive(Clone)]
pub struct GitHubService {
    client: Option<Client>,
    app_identity: Option<GitHubAppIdentity>,
    pending: Arc<Mutex<Option<PendingAuthorization>>>,
    authorization_generation: Arc<AtomicU64>,
    session: Arc<Mutex<SessionCache>>,
    credential_gate: Arc<Mutex<()>>,
    refresh_gate: Arc<Mutex<()>>,
    busy: Arc<AtomicBool>,
    editor_dirty: Arc<AtomicBool>,
    editor_state_updated_at: Arc<AtomicU64>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct GitHubAppIdentity {
    client_id: String,
}

#[derive(Default)]
struct SessionCache {
    loaded: bool,
    session: Option<Session>,
}

struct PendingAuthorization {
    generation: u64,
    device_code: Zeroizing<String>,
    user_code: String,
    expires_at: u64,
    interval_seconds: u64,
    next_poll_at: u64,
}

#[derive(Clone)]
struct Session {
    app_client_id: String,
    access_token: Zeroizing<String>,
    refresh_token: Option<Zeroizing<String>>,
    expires_at: Option<u64>,
    refresh_expires_at: Option<u64>,
    account: Option<AccountSummary>,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct SessionRecord {
    #[serde(default)]
    app_client_id: String,
    access_token: String,
    refresh_token: Option<String>,
    expires_at: Option<u64>,
    refresh_expires_at: Option<u64>,
    account: Option<AccountSummary>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProjectRules {
    version: u8,
    repository: String,
    branch: String,
    #[serde(default)]
    can_push: bool,
    interval_minutes: u64,
    auto_commit: bool,
    last_attempt_at: Option<u64>,
    last_sync_at: Option<u64>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProjectApproval {
    version: u8,
    root_fingerprint: String,
    client_id: String,
    account_id: u64,
    repository: String,
    branch: String,
    can_push: bool,
}

#[derive(Clone, Debug)]
struct ApprovalContext {
    client_id: String,
    account: AccountSummary,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountSummary {
    pub login: String,
    pub name: Option<String>,
    pub id: u64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitHubStatus {
    pub auth_configured: bool,
    pub authenticated: bool,
    pub account: Option<AccountSummary>,
    pub authorization_pending: bool,
    pub project_selected: bool,
    pub busy: bool,
    pub project: Option<ProjectGitStatus>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectGitStatus {
    pub repository: String,
    pub branch: String,
    pub can_push: bool,
    pub interval_minutes: u64,
    pub auto_commit: bool,
    pub last_sync_at: Option<u64>,
    pub ahead: usize,
    pub behind: usize,
    pub dirty: bool,
    pub changes: Vec<GitChange>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceAuthorization {
    pub attempt_id: u64,
    pub user_code: String,
    pub verification_uri: String,
    pub expires_in_seconds: u64,
    pub interval_seconds: u64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthorizationPoll {
    pub status: &'static str,
    pub retry_after_seconds: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub account: Option<AccountSummary>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepositorySummary {
    pub full_name: String,
    pub private: bool,
    pub default_branch: String,
    pub can_push: bool,
    pub created_at: String,
    pub owned_by_user: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LinkProjectRequest {
    pub repository: String,
    pub default_branch: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateRepositoryRequest {
    pub name: String,
    pub description: String,
    pub private: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveRulesRequest {
    pub interval_minutes: u64,
    pub auto_commit: bool,
}

#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SyncAction {
    Pull,
    Push,
    Sync,
    CommitAndSync,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncProjectRequest {
    pub action: SyncAction,
    pub commit_message: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncResult {
    pub summary: String,
    pub status: GitHubStatus,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SchedulerEvent {
    ok: bool,
    message: String,
    project_root: String,
}

#[derive(Deserialize)]
struct DeviceCodeResponse {
    device_code: String,
    user_code: String,
    verification_uri: String,
    expires_in: u64,
    interval: u64,
}

#[derive(Deserialize)]
struct TokenResponse {
    access_token: Option<String>,
    expires_in: Option<u64>,
    refresh_token: Option<String>,
    refresh_token_expires_in: Option<u64>,
    scope: Option<String>,
    error: Option<String>,
}

#[derive(Deserialize)]
struct UserResponse {
    login: String,
    id: u64,
    name: Option<String>,
}

#[derive(Deserialize)]
struct ApiRepository {
    full_name: String,
    private: bool,
    default_branch: String,
    created_at: String,
    permissions: Option<ApiRepositoryPermissions>,
    owner: Option<ApiRepositoryOwner>,
}

#[derive(Deserialize)]
struct ApiRepositoryOwner {
    id: u64,
}

#[derive(Serialize)]
struct CreateRepositoryBody<'a> {
    name: &'a str,
    description: &'a str,
    private: bool,
    auto_init: bool,
}

#[derive(Deserialize)]
struct ApiRepositoryPermissions {
    push: bool,
}

struct BusyGuard {
    busy: Arc<AtomicBool>,
}

impl Drop for BusyGuard {
    fn drop(&mut self) {
        self.busy.store(false, Ordering::Release);
    }
}

impl GitHubService {
    pub fn new() -> Self {
        Self::with_identity(bundled_app_identity())
    }

    fn with_identity(app_identity: Option<GitHubAppIdentity>) -> Self {
        let client = Client::builder()
            .user_agent(concat!("UnderTree/", env!("CARGO_PKG_VERSION")))
            .connect_timeout(Duration::from_secs(15))
            .timeout(Duration::from_secs(45))
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .ok();
        Self {
            client,
            app_identity,
            pending: Arc::new(Mutex::new(None)),
            authorization_generation: Arc::new(AtomicU64::new(0)),
            session: Arc::new(Mutex::new(SessionCache::default())),
            credential_gate: Arc::new(Mutex::new(())),
            refresh_gate: Arc::new(Mutex::new(())),
            busy: Arc::new(AtomicBool::new(false)),
            editor_dirty: Arc::new(AtomicBool::new(true)),
            editor_state_updated_at: Arc::new(AtomicU64::new(0)),
        }
    }

    fn client_id(&self) -> Option<&str> {
        self.app_identity
            .as_ref()
            .map(|identity| identity.client_id.as_str())
    }

    async fn cached_approval_context(&self) -> Result<Option<ApprovalContext>, BoundaryError> {
        self.ensure_session_loaded().await?;
        let Some(client_id) = self.client_id().map(str::to_owned) else {
            return Ok(None);
        };
        let account = self
            .session
            .lock()
            .await
            .session
            .as_ref()
            .and_then(|session| session.account.clone());
        Ok(account.map(|account| ApprovalContext { client_id, account }))
    }

    async fn approval_credentials(
        &self,
    ) -> Result<
        (
            Zeroizing<String>,
            CommitIdentity,
            ApprovalContext,
            OwnedMutexGuard<()>,
        ),
        BoundaryError,
    > {
        let (token, _, session_guard) = self.sync_credentials(false).await?;
        let account = self.refresh_account_for_token(&token).await?;
        let identity = commit_identity_from_account(account.clone());
        let context = ApprovalContext {
            client_id: self
                .client_id()
                .map(str::to_owned)
                .ok_or_else(BoundaryError::internal)?,
            account,
        };
        Ok((token, identity, context, session_guard))
    }

    pub fn set_editor_dirty(&self, dirty: bool) {
        self.editor_dirty.store(dirty, Ordering::Release);
        self.editor_state_updated_at
            .store(unix_time(), Ordering::Release);
    }

    fn editor_state_is_clean(&self) -> bool {
        editor_state_is_clean(&self.editor_dirty, &self.editor_state_updated_at)
    }

    pub async fn status(
        &self,
        project_root: Option<PathBuf>,
    ) -> Result<GitHubStatus, BoundaryError> {
        self.ensure_session_loaded().await?;
        let (authenticated, account) = {
            let session = self.session.lock().await;
            (
                session.session.is_some(),
                session
                    .session
                    .as_ref()
                    .and_then(|session| session.account.clone()),
            )
        };
        let authorization_pending = self.pending.lock().await.is_some();
        let editor_dirty = self.editor_dirty.load(Ordering::Acquire);
        let approval_context = account.as_ref().and_then(|account| {
            self.client_id().map(|client_id| ApprovalContext {
                client_id: client_id.to_owned(),
                account: account.clone(),
            })
        });
        let project = if let Some(root) = project_root.as_ref() {
            let root = root.clone();
            tauri::async_runtime::spawn_blocking(move || {
                project_status(&root, editor_dirty, approval_context.as_ref())
            })
            .await
            .map_err(|_| BoundaryError::internal())??
        } else {
            None
        };

        let configured = self.app_identity.is_some();
        Ok(GitHubStatus {
            auth_configured: configured,
            authenticated,
            account,
            authorization_pending,
            project_selected: project_root.is_some(),
            busy: self.busy.load(Ordering::Acquire),
            project,
        })
    }

    pub async fn begin_authorization(&self) -> Result<DeviceAuthorization, BoundaryError> {
        let generation = {
            let mut pending = self.pending.lock().await;
            let generation = self
                .authorization_generation
                .fetch_add(1, Ordering::AcqRel)
                .wrapping_add(1);
            *pending = None;
            generation
        };
        let client_id = self.client_id().map(str::to_owned).ok_or_else(|| {
            github_error(
                "github_app_unconfigured",
                "GitHub connection is unavailable in this UnderTree build. Install an official build or contact its distributor.",
            )
        })?;
        let client = self.client()?;
        let response = client
            .post(DEVICE_CODE_URL)
            .header("Accept", "application/json")
            .form(&[("client_id", client_id.as_str()), ("scope", OAUTH_SCOPES)])
            .send()
            .await
            .map_err(|_| network_error())?;
        let payload: DeviceCodeResponse = parse_response(response).await?;
        validate_device_response(&payload)?;
        let now = unix_time();
        let mut pending = self.pending.lock().await;
        if self.authorization_generation.load(Ordering::Acquire) != generation {
            return Err(authorization_superseded());
        }
        *pending = Some(PendingAuthorization {
            generation,
            device_code: Zeroizing::new(payload.device_code),
            user_code: payload.user_code.clone(),
            expires_at: now.saturating_add(payload.expires_in),
            interval_seconds: payload.interval,
            next_poll_at: now.saturating_add(payload.interval),
        });
        Ok(DeviceAuthorization {
            attempt_id: generation,
            user_code: payload.user_code,
            verification_uri: DEVICE_LOGIN_URL.to_owned(),
            expires_in_seconds: payload.expires_in,
            interval_seconds: payload.interval,
        })
    }

    pub async fn pending_authorization_code(
        &self,
        attempt_id: u64,
    ) -> Result<String, BoundaryError> {
        if self.authorization_generation.load(Ordering::Acquire) != attempt_id {
            return Err(authorization_superseded());
        }
        let now = unix_time();
        let pending = self.pending.lock().await;
        let authorization = pending
            .as_ref()
            .filter(|authorization| authorization.generation == attempt_id)
            .ok_or_else(|| {
                github_error("authorization_missing", "Start GitHub authorization again.")
            })?;
        if now >= authorization.expires_at {
            return Err(github_error(
                "authorization_expired",
                "The GitHub code expired. Start authorization again.",
            ));
        }
        Ok(authorization.user_code.clone())
    }

    pub async fn poll_authorization(
        &self,
        attempt_id: u64,
    ) -> Result<AuthorizationPoll, BoundaryError> {
        if self.authorization_generation.load(Ordering::Acquire) != attempt_id {
            return Err(authorization_superseded());
        }
        let client_id = self.client_id().map(str::to_owned).ok_or_else(|| {
            github_error(
                "github_app_unconfigured",
                "GitHub connection is unavailable in this UnderTree build. Install an official build or contact its distributor.",
            )
        })?;
        let now = unix_time();
        let (generation, device_code, interval_seconds) = {
            let mut pending = self.pending.lock().await;
            let authorization = pending
                .as_mut()
                .filter(|authorization| authorization.generation == attempt_id)
                .ok_or_else(|| {
                    github_error("authorization_missing", "Start GitHub authorization again.")
                })?;
            if now >= authorization.expires_at {
                *pending = None;
                return Err(github_error(
                    "authorization_expired",
                    "The GitHub code expired. Start authorization again.",
                ));
            }
            if now < authorization.next_poll_at {
                return Ok(AuthorizationPoll {
                    status: "pending",
                    retry_after_seconds: authorization.next_poll_at - now,
                    account: None,
                });
            }
            authorization.next_poll_at = now.saturating_add(authorization.interval_seconds);
            (
                authorization.generation,
                authorization.device_code.clone(),
                authorization.interval_seconds,
            )
        };

        let client = self.client()?;
        let response = client
            .post(TOKEN_URL)
            .header("Accept", "application/json")
            .form(&[
                ("client_id", client_id.as_str()),
                ("device_code", device_code.as_str()),
                ("grant_type", "urn:ietf:params:oauth:grant-type:device_code"),
            ])
            .send()
            .await
            .map_err(|_| network_error())?;
        let payload: TokenResponse = parse_response(response).await?;
        if !self.authorization_is_current(generation).await {
            return Err(authorization_superseded());
        }
        if let Some(error) = payload.error.as_deref() {
            return self
                .handle_authorization_error(error, interval_seconds, generation)
                .await;
        }
        validate_oauth_scope(payload.scope.as_deref())?;
        let access_token = secure_token(payload.access_token, "authorization_invalid")?;
        let now = unix_time();
        let mut session = Session {
            app_client_id: client_id,
            access_token,
            refresh_token: optional_secure_token(payload.refresh_token, "authorization_invalid")?,
            expires_at: payload
                .expires_in
                .map(|seconds| now.saturating_add(seconds)),
            refresh_expires_at: payload
                .refresh_token_expires_in
                .map(|seconds| now.saturating_add(seconds)),
            account: None,
        };
        session.account = Some(self.fetch_account(&session.access_token).await?);
        let mut pending = self.pending.lock().await;
        if self.authorization_generation.load(Ordering::Acquire) != generation
            || pending
                .as_ref()
                .is_none_or(|authorization| authorization.generation != generation)
        {
            return Err(authorization_superseded());
        }
        let _refresh_guard = self.refresh_gate.lock().await;
        self.store_session(session.clone()).await?;
        *pending = None;
        Ok(AuthorizationPoll {
            status: "complete",
            retry_after_seconds: 0,
            account: session.account,
        })
    }

    pub async fn list_repositories(&self) -> Result<Vec<RepositorySummary>, BoundaryError> {
        let (token, _, _session_guard) = self.sync_credentials(false).await?;
        let account = self.refresh_account_for_token(&token).await?;
        self.list_repositories_with_token(&token, account.id).await
    }

    async fn list_repositories_with_token(
        &self,
        token: &str,
        account_id: u64,
    ) -> Result<Vec<RepositorySummary>, BoundaryError> {
        let mut repositories = Vec::new();
        let final_probe_page = MAX_REPOSITORIES / 100 + 1;
        for page in 1..=final_probe_page {
            let path = format!(
                "/user/repos?affiliation=owner,collaborator,organization_member&sort=full_name&direction=asc&per_page=100&page={page}"
            );
            let response: Vec<ApiRepository> = self.api_get(token, &path).await?;
            let count = response.len();
            if page == final_probe_page && count != 0 {
                return Err(github_error(
                    "too_many_repositories",
                    "This GitHub account exposes more than 10,000 repositories. Narrow the account access before using UnderTree.",
                ));
            }
            for repository in response {
                git::validate_repository_name(&repository.full_name)?;
                git::validate_branch_name(&repository.default_branch)?;
                validate_github_timestamp(&repository.created_at)?;
                let owned_by_user = repository
                    .owner
                    .as_ref()
                    .is_some_and(|owner| owner.id == account_id);
                repositories.push(RepositorySummary {
                    full_name: repository.full_name,
                    private: repository.private,
                    default_branch: repository.default_branch,
                    can_push: repository
                        .permissions
                        .is_some_and(|permissions| permissions.push),
                    created_at: repository.created_at,
                    owned_by_user,
                });
            }
            if count < 100 {
                break;
            }
        }
        repositories.sort_by(|left, right| left.full_name.cmp(&right.full_name));
        repositories.dedup_by(|left, right| left.full_name == right.full_name);
        if !self.session_token_is_current(token).await {
            return Err(github_error(
                "github_session_changed",
                "The GitHub account changed while repositories were loading. Try again.",
            ));
        }
        Ok(repositories)
    }

    pub async fn create_repository_project(
        &self,
        destination_parent: PathBuf,
        projects: ProjectState,
        request: CreateRepositoryRequest,
    ) -> Result<ProjectSnapshot, BoundaryError> {
        let _busy_guard = self.acquire_busy()?;
        let name = request.name.trim().to_owned();
        let description = request.description.trim().to_owned();
        git::validate_new_repository_name(&name)?;
        if description.chars().count() > 350
            || description.chars().any(|character| character.is_control())
        {
            return Err(github_error(
                "invalid_repository_description",
                "Keep the repository description to 350 characters without line breaks or control characters.",
            ));
        }

        let preflight_parent = destination_parent.clone();
        let preflight_name = name.clone();
        tauri::async_runtime::spawn_blocking(move || {
            git::preflight_new_project_destination(&preflight_parent, &preflight_name)
        })
        .await
        .map_err(|_| BoundaryError::internal())??;

        let (token, identity, approval_context, session_guard) =
            self.approval_credentials().await?;
        let account = approval_context.account.clone();
        let body = CreateRepositoryBody {
            name: &name,
            description: &description,
            private: request.private,
            auto_init: false,
        };
        let repository: ApiRepository = self.api_post(&token, "/user/repos", &body).await?;
        git::validate_repository_name(&repository.full_name)?;
        git::validate_branch_name(&repository.default_branch)?;
        let (_, returned_name) = repository
            .full_name
            .split_once('/')
            .ok_or_else(BoundaryError::internal)?;
        if repository.owner.as_ref().map(|owner| owner.id) != Some(account.id)
            || !returned_name.eq_ignore_ascii_case(&name)
        {
            return Err(github_error(
                "github_response_invalid",
                "GitHub created a repository outside the expected account or with an unexpected name.",
            ));
        }

        let rules = ProjectRules {
            version: SETTINGS_VERSION,
            repository: repository.full_name.clone(),
            branch: repository.default_branch.clone(),
            can_push: true,
            interval_minutes: 0,
            auto_commit: false,
            last_attempt_at: None,
            last_sync_at: None,
        };
        let operation_parent = destination_parent;
        let operation_repository = repository.full_name;
        let operation_branch = repository.default_branch;
        let operation_projects = projects;
        let project = tauri::async_runtime::spawn_blocking(move || {
            let root = git::create_repository_project(
                &operation_parent,
                &operation_repository,
                &operation_branch,
                &token,
                &identity,
            )
            .map_err(|error| {
                BoundaryError::github(
                    error.code,
                    format!(
                        "GitHub repository {operation_repository} was created, but its local project could not be completed: {}",
                        error.message
                    ),
                )
            })?;
            save_rules(&root, &rules)?;
            save_project_approval(&root, &rules, &approval_context)?;
            operation_projects.select(root)
        })
        .await
        .map_err(|_| BoundaryError::internal())??;
        drop(session_guard);
        Ok(project)
    }

    pub async fn link_project(
        &self,
        root: PathBuf,
        projects: ProjectState,
        request: LinkProjectRequest,
    ) -> Result<GitHubStatus, BoundaryError> {
        let guard = self.acquire_busy()?;
        let (token, _, approval_context, session_guard) = self.approval_credentials().await?;
        git::validate_repository_name(&request.repository)?;
        git::validate_branch_name(&request.default_branch)?;
        let repository = self
            .list_repositories_with_token(&token, approval_context.account.id)
            .await?
            .into_iter()
            .find(|repository| repository.full_name == request.repository)
            .ok_or_else(|| {
                github_error(
                    "repository_not_authorized",
                    "This repository is not available to the connected GitHub account.",
                )
            })?;
        let rules = ProjectRules {
            version: SETTINGS_VERSION,
            repository: repository.full_name,
            branch: repository.default_branch,
            can_push: repository.can_push,
            interval_minutes: 0,
            auto_commit: false,
            last_attempt_at: None,
            last_sync_at: None,
        };
        let operation_root = root.clone();
        let operation_rules = rules.clone();
        let operation_projects = projects;
        tauri::async_runtime::spawn_blocking(move || {
            let _project_guard = operation_projects.mutation_guard()?;
            operation_projects.ensure_selected_root(&operation_root)?;
            git::link_repository(
                &operation_root,
                &operation_rules.repository,
                &operation_rules.branch,
            )?;
            save_rules(&operation_root, &operation_rules)?;
            save_project_approval(&operation_root, &operation_rules, &approval_context)
        })
        .await
        .map_err(|_| BoundaryError::internal())??;
        drop(session_guard);
        drop(guard);
        self.status(Some(root)).await
    }

    pub async fn clone_project(
        &self,
        destination_parent: PathBuf,
        projects: ProjectState,
        request: LinkProjectRequest,
    ) -> Result<ProjectSnapshot, BoundaryError> {
        let _busy_guard = self.acquire_busy()?;
        let (token, _, approval_context, session_guard) = self.approval_credentials().await?;
        git::validate_repository_name(&request.repository)?;
        git::validate_branch_name(&request.default_branch)?;
        let repository = self
            .list_repositories_with_token(&token, approval_context.account.id)
            .await?
            .into_iter()
            .find(|repository| repository.full_name == request.repository)
            .ok_or_else(|| {
                github_error(
                    "repository_not_authorized",
                    "This repository is not available to the connected GitHub account.",
                )
            })?;
        let rules = ProjectRules {
            version: SETTINGS_VERSION,
            repository: repository.full_name,
            branch: repository.default_branch,
            can_push: repository.can_push,
            interval_minutes: 0,
            auto_commit: false,
            last_attempt_at: None,
            last_sync_at: None,
        };
        let cloned_rules = rules.clone();
        let cloned_projects = projects.clone();
        let project = tauri::async_runtime::spawn_blocking(move || {
            let root = git::clone_repository(
                &destination_parent,
                &cloned_rules.repository,
                &cloned_rules.branch,
                &token,
            )?;
            save_rules(&root, &cloned_rules)?;
            save_project_approval(&root, &cloned_rules, &approval_context)?;
            cloned_projects.select(root).map_err(|error| {
                if error.code == "project_empty" {
                    github_error(
                        "cloned_project_empty",
                        "The repository was cloned locally, but it has no .typ document for UnderTree to open.",
                    )
                } else {
                    error
                }
            })
        })
        .await
        .map_err(|_| BoundaryError::internal())??;
        drop(session_guard);
        Ok(project)
    }

    pub async fn save_project_rules(
        &self,
        root: PathBuf,
        projects: ProjectState,
        request: SaveRulesRequest,
    ) -> Result<GitHubStatus, BoundaryError> {
        let guard = self.acquire_busy()?;
        let (token, _, approval_context, session_guard) = self.approval_credentials().await?;
        drop(token);
        validate_interval(request.interval_minutes)?;
        let operation_root = root.clone();
        let operation_projects = projects;
        tauri::async_runtime::spawn_blocking(move || {
            let _project_guard = operation_projects.mutation_guard()?;
            operation_projects.ensure_selected_root(&operation_root)?;
            let mut rules = load_rules(&operation_root)?.ok_or_else(|| {
                github_error(
                    "project_not_connected",
                    "Connect this project to a GitHub repository first.",
                )
            })?;
            require_project_approval(&operation_root, &rules, &approval_context)?;
            if request.auto_commit && !rules.can_push {
                return Err(github_error(
                    "repository_read_only",
                    "Automatic commits require push access to this GitHub repository.",
                ));
            }
            rules.interval_minutes = request.interval_minutes;
            rules.auto_commit = request.auto_commit;
            save_rules(&operation_root, &rules)
        })
        .await
        .map_err(|_| BoundaryError::internal())??;
        drop(session_guard);
        drop(guard);
        self.status(Some(root)).await
    }

    pub async fn unlink_project(
        &self,
        root: PathBuf,
        projects: ProjectState,
    ) -> Result<GitHubStatus, BoundaryError> {
        let guard = self.acquire_busy()?;
        let operation_root = root.clone();
        tauri::async_runtime::spawn_blocking(move || {
            let _project_guard = projects.mutation_guard()?;
            projects.ensure_selected_root(&operation_root)?;
            remove_project_approval(&operation_root)?;
            remove_rules(&operation_root)
        })
        .await
        .map_err(|_| BoundaryError::internal())??;
        drop(guard);
        self.status(Some(root)).await
    }

    pub async fn disconnect(&self) -> Result<(), BoundaryError> {
        let _busy_guard = self.acquire_busy()?;
        {
            let mut pending = self.pending.lock().await;
            self.authorization_generation.fetch_add(1, Ordering::AcqRel);
            *pending = None;
        }
        let _refresh_guard = self.refresh_gate.lock().await;
        let _credential_guard = self.credential_gate.lock().await;
        let result = tauri::async_runtime::spawn_blocking(delete_stored_session)
            .await
            .map_err(|_| BoundaryError::internal())?;
        result?;
        let mut session = self.session.lock().await;
        session.loaded = true;
        session.session = None;
        Ok(())
    }

    pub async fn sync_project(
        &self,
        root: PathBuf,
        projects: ProjectState,
        request: SyncProjectRequest,
    ) -> Result<SyncResult, BoundaryError> {
        let guard = self.acquire_busy()?;
        if !self.editor_state_is_clean() {
            return Err(github_error(
                "unsaved_editor",
                "Save the active document before synchronizing with GitHub.",
            ));
        }
        let summary = self
            .perform_sync(
                root.clone(),
                projects,
                request.action,
                request.commit_message,
                false,
            )
            .await?;
        drop(guard);
        let status = self.status(Some(root)).await?;
        Ok(SyncResult { summary, status })
    }

    /// Creates one local commit through UnderTree's validated Git boundary.
    /// This is intentionally separate from synchronization so scripts can
    /// compose `git commit` and `git sync` without invoking an external CLI.
    pub async fn commit_project(
        &self,
        root: PathBuf,
        projects: ProjectState,
        message: String,
    ) -> Result<SyncResult, BoundaryError> {
        let guard = self.acquire_busy()?;
        if !self.editor_state_is_clean() {
            return Err(github_error(
                "unsaved_editor",
                "Save the active document before creating a Git commit.",
            ));
        }
        let approval_context = self.cached_approval_context().await?.ok_or_else(|| {
            github_error(
                "github_auth_required",
                "Connect a GitHub account before committing this approved project.",
            )
        })?;
        let identity = commit_identity_from_account(approval_context.account.clone());
        let operation_root = root.clone();
        let committed = tauri::async_runtime::spawn_blocking(move || {
            let _project_guard = projects.mutation_guard()?;
            projects.ensure_selected_root(&operation_root)?;
            let rules = load_rules(&operation_root)?.ok_or_else(|| {
                github_error(
                    "project_not_connected",
                    "Connect this project to a GitHub repository first.",
                )
            })?;
            require_project_approval(&operation_root, &rules, &approval_context)?;
            git::commit_all(&operation_root, &rules.branch, &message, &identity)
        })
        .await
        .map_err(|_| BoundaryError::internal())??;
        drop(guard);
        let status = self.status(Some(root)).await?;
        Ok(SyncResult {
            summary: if committed {
                "Created local commit.".into()
            } else {
                "No local changes to commit.".into()
            },
            status,
        })
    }

    pub fn start_scheduler(&self, app: AppHandle, projects: ProjectState) {
        let service = self.clone();
        tauri::async_runtime::spawn(async move {
            loop {
                tokio::time::sleep(Duration::from_secs(SCHEDULER_TICK_SECONDS)).await;
                if !service.editor_state_is_clean() || service.busy.load(Ordering::Acquire) {
                    continue;
                }
                let root = match projects.root() {
                    Ok(Some(root)) => root,
                    _ => continue,
                };
                let approval_context = match service.cached_approval_context().await {
                    Ok(Some(context)) => context,
                    _ => continue,
                };
                let due_root = root.clone();
                let due = tauri::async_runtime::spawn_blocking(move || {
                    sync_is_due(&due_root, &approval_context)
                })
                .await
                .ok()
                .and_then(Result::ok)
                .unwrap_or(false);
                if !due {
                    continue;
                }
                let guard = match service.acquire_busy() {
                    Ok(guard) => guard,
                    Err(_) => continue,
                };
                let event_root = root.to_string_lossy().into_owned();
                let result = service
                    .perform_sync(root, projects.clone(), SyncAction::Sync, None, true)
                    .await;
                drop(guard);
                let event = match result {
                    Ok(message) => SchedulerEvent {
                        ok: true,
                        message,
                        project_root: event_root,
                    },
                    Err(error) => SchedulerEvent {
                        ok: false,
                        message: error.message,
                        project_root: event_root,
                    },
                };
                let _ = app.emit("github-sync-state", event);
            }
        });
    }

    async fn perform_sync(
        &self,
        root: PathBuf,
        projects: ProjectState,
        action: SyncAction,
        commit_message: Option<String>,
        scheduled: bool,
    ) -> Result<String, BoundaryError> {
        let now = unix_time();
        if scheduled {
            let cached_context = self.cached_approval_context().await?.ok_or_else(|| {
                github_error(
                    "github_auth_required",
                    "Connect a GitHub account before using repository synchronization.",
                )
            })?;
            let attempt_root = root.clone();
            let attempt_projects = projects.clone();
            tauri::async_runtime::spawn_blocking(move || {
                let _project_guard = attempt_projects.mutation_guard()?;
                attempt_projects.ensure_selected_root(&attempt_root)?;
                let mut rules = load_rules(&attempt_root)?.ok_or_else(|| {
                    github_error(
                        "project_not_connected",
                        "Connect this project to a GitHub repository first.",
                    )
                })?;
                require_project_approval(&attempt_root, &rules, &cached_context)?;
                if rules.interval_minutes == 0 {
                    return Err(github_error(
                        "automatic_sync_disabled",
                        "Automatic GitHub synchronization is disabled for this project.",
                    ));
                }
                rules.last_attempt_at = Some(now);
                save_rules(&attempt_root, &rules)
            })
            .await
            .map_err(|_| BoundaryError::internal())??;
        }

        let (token, identity, approval_context, session_guard) =
            self.approval_credentials().await?;
        let rules_root = root.clone();
        let rules_projects = projects.clone();
        let rules = tauri::async_runtime::spawn_blocking(move || {
            let _project_guard = rules_projects.mutation_guard()?;
            rules_projects.ensure_selected_root(&rules_root)?;
            let mut rules = load_rules(&rules_root)?.ok_or_else(|| {
                github_error(
                    "project_not_connected",
                    "Connect this project to a GitHub repository first.",
                )
            })?;
            require_project_approval(&rules_root, &rules, &approval_context)?;
            if scheduled && rules.interval_minutes == 0 {
                return Err(github_error(
                    "automatic_sync_disabled",
                    "Automatic GitHub synchronization is disabled for this project.",
                ));
            }
            if !scheduled {
                rules.last_attempt_at = Some(now);
                save_rules(&rules_root, &rules)?;
            }
            Ok::<_, BoundaryError>(rules)
        })
        .await
        .map_err(|_| BoundaryError::internal())??;

        let should_commit =
            matches!(action, SyncAction::CommitAndSync) || (scheduled && rules.auto_commit);
        if should_commit && !rules.can_push {
            return Err(github_error(
                "repository_read_only",
                "This GitHub repository is read-only. Pull is available, but commits and pushes require write access.",
            ));
        }
        let operation_root = root.clone();
        let mut operation_rules = rules;
        let operation_projects = projects;
        let editor_dirty = self.editor_dirty.clone();
        let editor_state_updated_at = self.editor_state_updated_at.clone();
        let message = commit_message.unwrap_or_else(|| format!("UnderTree automatic sync {now}"));
        let summary = tauri::async_runtime::spawn_blocking(move || {
            let _project_guard = operation_projects.mutation_guard()?;
            operation_projects.ensure_selected_root(&operation_root)?;
            if !editor_state_is_clean(&editor_dirty, &editor_state_updated_at) {
                return Err(github_error(
                    "unsaved_editor",
                    "Save the active document before synchronizing with GitHub.",
                ));
            }
            let mut steps: Vec<String> = Vec::new();
            if should_commit
                && git::commit_all(
                    &operation_root,
                    &operation_rules.branch,
                    &message,
                    &identity,
                )?
            {
                steps.push("committed local changes".into());
            }
            let snapshot = git::snapshot(&operation_root, &operation_rules.branch)?;
            require_committed_sync_input(action, snapshot.dirty)?;
            match action {
                SyncAction::Pull => {
                    let outcome = git::fetch_and_fast_forward(
                        &operation_root,
                        &operation_rules.repository,
                        &operation_rules.branch,
                        &token,
                        git::DivergencePolicy {
                            merge_identity: Some(&identity),
                            publish_safety_branch: operation_rules.can_push,
                            safety_timestamp: now,
                        },
                        || !editor_state_is_clean(&editor_dirty, &editor_state_updated_at),
                    )?;
                    if let Some(branch) = outcome.safety_branch {
                        steps.push(if outcome.safety_branch_published {
                            format!("published GitHub safety branch {branch}")
                        } else {
                            format!("created local safety branch {branch}")
                        });
                    }
                    if outcome.updated {
                        steps.push("pulled GitHub changes".into());
                    } else {
                        steps.push("already up to date".into());
                    }
                }
                SyncAction::Push => {
                    if !operation_rules.can_push {
                        return Err(github_error(
                            "repository_read_only",
                            "This GitHub repository is read-only. Pull is available, but push requires write access.",
                        ));
                    }
                    if !editor_state_is_clean(&editor_dirty, &editor_state_updated_at) {
                        return Err(github_error(
                            "unsaved_editor",
                            "Save the active document before synchronizing with GitHub.",
                        ));
                    }
                    git::preflight_push_remote(
                        &operation_root,
                        &operation_rules.repository,
                        &operation_rules.branch,
                        &token,
                        now,
                        || !editor_state_is_clean(&editor_dirty, &editor_state_updated_at),
                    )?;
                    git::push(
                        &operation_root,
                        &operation_rules.repository,
                        &operation_rules.branch,
                        &token,
                    )?;
                    steps.push("pushed local commits".into());
                }
                SyncAction::Sync | SyncAction::CommitAndSync => {
                    let outcome = git::fetch_and_fast_forward(
                        &operation_root,
                        &operation_rules.repository,
                        &operation_rules.branch,
                        &token,
                        git::DivergencePolicy {
                            merge_identity: Some(&identity),
                            publish_safety_branch: operation_rules.can_push,
                            safety_timestamp: now,
                        },
                        || !editor_state_is_clean(&editor_dirty, &editor_state_updated_at),
                    )?;
                    if let Some(branch) = outcome.safety_branch {
                        steps.push(if outcome.safety_branch_published {
                            format!("published GitHub safety branch {branch}")
                        } else {
                            format!("created local safety branch {branch}")
                        });
                    }
                    if outcome.updated {
                        steps.push("pulled GitHub changes".into());
                    }
                    if operation_rules.can_push {
                        if !editor_state_is_clean(&editor_dirty, &editor_state_updated_at) {
                            return Err(github_error(
                                "unsaved_editor",
                                "Save the active document before synchronizing with GitHub.",
                            ));
                        }
                        git::push(
                            &operation_root,
                            &operation_rules.repository,
                            &operation_rules.branch,
                            &token,
                        )?;
                        steps.push("pushed local commits".into());
                    }
                }
            }
            operation_rules.last_sync_at = Some(unix_time());
            save_rules(&operation_root, &operation_rules)?;
            Ok::<_, BoundaryError>(if steps.is_empty() {
                "GitHub is already up to date.".to_owned()
            } else {
                format!("GitHub sync completed: {}.", steps.join(", "))
            })
        })
        .await
        .map_err(|_| BoundaryError::internal())??;
        drop(session_guard);
        Ok(summary)
    }

    async fn handle_authorization_error(
        &self,
        error: &str,
        interval_seconds: u64,
        generation: u64,
    ) -> Result<AuthorizationPoll, BoundaryError> {
        match error {
            "authorization_pending" => Ok(AuthorizationPoll {
                status: "pending",
                retry_after_seconds: interval_seconds,
                account: None,
            }),
            "slow_down" => {
                let mut pending = self.pending.lock().await;
                if let Some(pending) = pending
                    .as_mut()
                    .filter(|pending| pending.generation == generation)
                {
                    pending.interval_seconds = pending.interval_seconds.saturating_add(5).min(60);
                    pending.next_poll_at = unix_time().saturating_add(pending.interval_seconds);
                    Ok(AuthorizationPoll {
                        status: "pending",
                        retry_after_seconds: pending.interval_seconds,
                        account: None,
                    })
                } else {
                    Err(github_error(
                        "authorization_missing",
                        "Start GitHub authorization again.",
                    ))
                }
            }
            "expired_token" => {
                self.clear_authorization(generation).await;
                Err(github_error(
                    "authorization_expired",
                    "The GitHub code expired. Start authorization again.",
                ))
            }
            "access_denied" => {
                self.clear_authorization(generation).await;
                Err(github_error(
                    "authorization_denied",
                    "GitHub authorization was cancelled.",
                ))
            }
            "device_flow_disabled" => {
                self.clear_authorization(generation).await;
                Err(github_error(
                    "device_flow_disabled",
                    "Device Flow is not enabled for the configured UnderTree OAuth App.",
                ))
            }
            _ => {
                self.clear_authorization(generation).await;
                Err(github_error(
                    "authorization_failed",
                    "GitHub could not authorize UnderTree. Start the connection again.",
                ))
            }
        }
    }

    async fn authorization_is_current(&self, generation: u64) -> bool {
        self.authorization_generation.load(Ordering::Acquire) == generation
            && self
                .pending
                .lock()
                .await
                .as_ref()
                .is_some_and(|pending| pending.generation == generation)
    }

    async fn clear_authorization(&self, generation: u64) {
        let mut pending = self.pending.lock().await;
        if pending
            .as_ref()
            .is_some_and(|pending| pending.generation == generation)
        {
            *pending = None;
        }
    }

    async fn ensure_session_loaded(&self) -> Result<(), BoundaryError> {
        {
            let cache = self.session.lock().await;
            if cache.loaded {
                return Ok(());
            }
        }
        let _credential_guard = self.credential_gate.lock().await;
        let mut cache = self.session.lock().await;
        if cache.loaded {
            return Ok(());
        }
        let Some(expected_client_id) = self.client_id().map(str::to_owned) else {
            cache.session = None;
            cache.loaded = true;
            return Ok(());
        };
        let stored =
            tauri::async_runtime::spawn_blocking(move || load_stored_session(&expected_client_id))
                .await
                .map_err(|_| BoundaryError::internal())??;
        cache.session = stored;
        cache.loaded = true;
        Ok(())
    }

    async fn access_token(&self) -> Result<Zeroizing<String>, BoundaryError> {
        self.ensure_session_loaded().await?;
        let needs_refresh = {
            let cache = self.session.lock().await;
            let session = cache.session.as_ref().ok_or_else(|| {
                github_error(
                    "github_auth_required",
                    "Connect a GitHub account before using repository synchronization.",
                )
            })?;
            session
                .expires_at
                .is_some_and(|expires_at| expires_at <= unix_time().saturating_add(60))
        };
        if needs_refresh {
            self.refresh_session().await?;
        }
        let cache = self.session.lock().await;
        cache
            .session
            .as_ref()
            .map(|session| session.access_token.clone())
            .ok_or_else(|| {
                github_error(
                    "github_auth_required",
                    "Connect a GitHub account before using repository synchronization.",
                )
            })
    }

    async fn refresh_session(&self) -> Result<(), BoundaryError> {
        let _refresh_guard = self.refresh_gate.lock().await;
        self.ensure_session_loaded().await?;
        {
            let cache = self.session.lock().await;
            let session = cache.session.as_ref().ok_or_else(|| {
                github_error(
                    "github_auth_required",
                    "Connect a GitHub account before using repository synchronization.",
                )
            })?;
            if session
                .expires_at
                .is_none_or(|expires_at| expires_at > unix_time().saturating_add(60))
            {
                return Ok(());
            }
        }
        let (refresh_token, refresh_expires_at, session_client_id) = {
            let cache = self.session.lock().await;
            let session = cache.session.as_ref().ok_or_else(|| {
                github_error(
                    "github_auth_required",
                    "Connect a GitHub account before using repository synchronization.",
                )
            })?;
            (
                session.refresh_token.clone(),
                session.refresh_expires_at,
                session.app_client_id.clone(),
            )
        };
        let refresh_token = refresh_token.ok_or_else(|| {
            github_error(
                "github_session_expired",
                "The GitHub session expired. Connect the account again.",
            )
        })?;
        if refresh_expires_at.is_some_and(|expires_at| expires_at <= unix_time()) {
            return Err(github_error(
                "github_session_expired",
                "The GitHub session expired. Connect the account again.",
            ));
        }
        let client_id = self.client_id().map(str::to_owned).ok_or_else(|| {
            github_error(
                "github_app_unconfigured",
                "GitHub connection is unavailable in this UnderTree build. Install an official build or contact its distributor.",
            )
        })?;
        if session_client_id != client_id {
            return Err(github_error(
                "github_session_changed",
                "UnderTree's GitHub identity changed. Disconnect and authorize the account again.",
            ));
        }
        let response = self
            .client()?
            .post(TOKEN_URL)
            .header("Accept", "application/json")
            .form(&[
                ("client_id", client_id.as_str()),
                ("grant_type", "refresh_token"),
                ("refresh_token", refresh_token.as_str()),
            ])
            .send()
            .await
            .map_err(|_| network_error())?;
        let payload: TokenResponse = parse_response(response).await?;
        if payload.error.is_some() {
            return Err(github_error(
                "github_session_expired",
                "The GitHub session expired. Connect the account again.",
            ));
        }
        validate_oauth_scope(payload.scope.as_deref())?;
        let cache = self.session.lock().await;
        let current = cache.session.as_ref().ok_or_else(|| {
            github_error(
                "github_auth_required",
                "Connect a GitHub account before using repository synchronization.",
            )
        })?;
        if current.app_client_id != client_id {
            return Err(github_error(
                "github_session_changed",
                "UnderTree's GitHub identity changed. Disconnect and authorize the account again.",
            ));
        }
        let updated = rotated_session(payload, current, unix_time())?;
        drop(cache);
        // Persist GitHub's rotated token pair before any secondary request.
        // A transient /user failure must not strand the app with an already
        // invalidated refresh token.
        let refreshed_token = updated.access_token.clone();
        self.store_session(updated).await?;
        self.refresh_account_for_token(&refreshed_token)
            .await
            .map(|_| ())
    }

    async fn sync_credentials(
        &self,
        need_identity: bool,
    ) -> Result<
        (
            Zeroizing<String>,
            Option<CommitIdentity>,
            OwnedMutexGuard<()>,
        ),
        BoundaryError,
    > {
        self.ensure_session_loaded().await?;
        let _ = self.access_token().await?;
        let refresh_guard = self.refresh_gate.clone().lock_owned().await;
        let (token, mut account) = {
            let cache = self.session.lock().await;
            let session = cache.session.as_ref().ok_or_else(|| {
                github_error(
                    "github_auth_required",
                    "Connect a GitHub account before using repository synchronization.",
                )
            })?;
            (session.access_token.clone(), session.account.clone())
        };
        if need_identity && account.is_none() {
            let fetched_account = self.fetch_account(&token).await?;
            let updated = {
                let mut cache = self.session.lock().await;
                let session = cache.session.as_mut().ok_or_else(|| {
                    github_error(
                        "github_auth_required",
                        "Connect a GitHub account before using repository synchronization.",
                    )
                })?;
                if session.access_token.as_str() != token.as_str() {
                    return Err(github_error(
                        "github_session_changed",
                        "The GitHub account changed during synchronization. Try again.",
                    ));
                }
                session.account = Some(fetched_account.clone());
                session.clone()
            };
            self.store_session(updated).await?;
            account = Some(fetched_account);
        }
        let identity = if need_identity {
            account.map(commit_identity_from_account)
        } else {
            None
        };
        Ok((token, identity, refresh_guard))
    }

    async fn fetch_account(&self, token: &str) -> Result<AccountSummary, BoundaryError> {
        let response: UserResponse = self.api_get(token, "/user").await?;
        if response.login.is_empty()
            || response.login.len() > 100
            || !response
                .login
                .chars()
                .all(|character| character.is_ascii_alphanumeric() || character == '-')
        {
            return Err(github_error(
                "github_account_invalid",
                "GitHub returned an invalid account identity.",
            ));
        }
        Ok(AccountSummary {
            login: response.login,
            name: response
                .name
                .filter(|name| !name.trim().is_empty() && name.len() <= 200),
            id: response.id,
        })
    }

    async fn refresh_account_for_token(
        &self,
        token: &str,
    ) -> Result<AccountSummary, BoundaryError> {
        let fetched = self.fetch_account(token).await?;
        let updated = {
            let mut cache = self.session.lock().await;
            let session = cache.session.as_mut().ok_or_else(|| {
                github_error(
                    "github_auth_required",
                    "Connect a GitHub account before using repository synchronization.",
                )
            })?;
            if session.access_token.as_str() != token {
                return Err(github_error(
                    "github_session_changed",
                    "The GitHub account changed during synchronization. Try again.",
                ));
            }
            if session
                .account
                .as_ref()
                .is_some_and(|account| account.id != fetched.id)
            {
                return Err(github_error(
                    "github_session_changed",
                    "GitHub returned a different account for the active session. Connect the account again.",
                ));
            }
            if session
                .account
                .as_ref()
                .is_some_and(|account| account == &fetched)
            {
                None
            } else {
                session.account = Some(fetched.clone());
                Some(session.clone())
            }
        };
        if let Some(updated) = updated {
            self.store_session(updated).await?;
        }
        Ok(fetched)
    }

    async fn session_token_is_current(&self, token: &str) -> bool {
        self.session
            .lock()
            .await
            .session
            .as_ref()
            .is_some_and(|session| session.access_token.as_str() == token)
    }

    async fn api_get<T: DeserializeOwned>(
        &self,
        token: &str,
        path: &str,
    ) -> Result<T, BoundaryError> {
        if !path.starts_with('/') || path.contains("//") || path.len() > 512 {
            return Err(BoundaryError::internal());
        }
        let response = self
            .client()?
            .get(format!("{API_ROOT}{path}"))
            .header("Accept", "application/vnd.github+json")
            .header("Authorization", format!("Bearer {token}"))
            .header("X-GitHub-Api-Version", API_VERSION)
            .send()
            .await
            .map_err(|_| network_error())?;
        parse_response(response).await
    }

    async fn api_post<T: DeserializeOwned, B: Serialize>(
        &self,
        token: &str,
        path: &str,
        body: &B,
    ) -> Result<T, BoundaryError> {
        if !path.starts_with('/') || path.contains("//") || path.len() > 512 {
            return Err(BoundaryError::internal());
        }
        let response = self
            .client()?
            .post(format!("{API_ROOT}{path}"))
            .header("Accept", "application/vnd.github+json")
            .header("Authorization", format!("Bearer {token}"))
            .header("X-GitHub-Api-Version", API_VERSION)
            .json(body)
            .send()
            .await
            .map_err(|_| network_error())?;
        parse_response(response).await
    }

    async fn store_session(&self, session: Session) -> Result<(), BoundaryError> {
        if self.client_id() != Some(session.app_client_id.as_str()) {
            return Err(github_error(
                "github_session_changed",
                "UnderTree's GitHub identity changed. Authorize the account again.",
            ));
        }
        let _credential_guard = self.credential_gate.lock().await;
        let record = session_record(&session);
        tauri::async_runtime::spawn_blocking(move || save_stored_session(record))
            .await
            .map_err(|_| BoundaryError::internal())??;
        let mut cache = self.session.lock().await;
        cache.loaded = true;
        cache.session = Some(session);
        Ok(())
    }

    fn acquire_busy(&self) -> Result<BusyGuard, BoundaryError> {
        self.busy
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .map_err(|_| {
                github_error(
                    "github_busy",
                    "Another GitHub operation is already running for this project.",
                )
            })?;
        Ok(BusyGuard {
            busy: self.busy.clone(),
        })
    }

    fn client(&self) -> Result<&Client, BoundaryError> {
        self.client.as_ref().ok_or_else(|| {
            github_error(
                "network_unavailable",
                "UnderTree could not initialize its secure GitHub network client.",
            )
        })
    }
}

fn require_committed_sync_input(action: SyncAction, dirty: bool) -> Result<(), BoundaryError> {
    if matches!(action, SyncAction::Sync) && dirty {
        Err(github_error(
            "uncommitted_changes",
            "This project has uncommitted local files. Enter a commit message and use Commit & Sync so GitHub can receive them.",
        ))
    } else {
        Ok(())
    }
}

fn commit_identity_from_account(account: AccountSummary) -> CommitIdentity {
    let name = account
        .name
        .filter(|name| !name.trim().is_empty())
        .unwrap_or_else(|| account.login.clone());
    CommitIdentity {
        name,
        email: format!("{}+{}@users.noreply.github.com", account.id, account.login),
    }
}

fn project_status(
    root: &Path,
    editor_dirty: bool,
    approval_context: Option<&ApprovalContext>,
) -> Result<Option<ProjectGitStatus>, BoundaryError> {
    let Some(rules) = load_rules(root)? else {
        return Ok(None);
    };
    let Some(approval_context) = approval_context else {
        return Ok(None);
    };
    if !project_approval_matches(root, &rules, approval_context)? {
        return Ok(None);
    }
    match git::snapshot(root, &rules.branch) {
        Ok(GitSnapshot {
            branch,
            ahead,
            behind,
            dirty,
            changes,
        }) => Ok(Some(ProjectGitStatus {
            repository: rules.repository,
            branch,
            can_push: rules.can_push,
            interval_minutes: rules.interval_minutes,
            auto_commit: rules.auto_commit,
            last_sync_at: rules.last_sync_at,
            ahead,
            behind,
            dirty: dirty || editor_dirty,
            changes,
            error: None,
        })),
        Err(error) => Ok(Some(ProjectGitStatus {
            repository: rules.repository,
            branch: rules.branch,
            can_push: rules.can_push,
            interval_minutes: rules.interval_minutes,
            auto_commit: rules.auto_commit,
            last_sync_at: rules.last_sync_at,
            ahead: 0,
            behind: 0,
            dirty: editor_dirty,
            changes: Vec::new(),
            error: Some(error.message),
        })),
    }
}

fn sync_is_due(root: &Path, approval_context: &ApprovalContext) -> Result<bool, BoundaryError> {
    let Some(rules) = load_rules(root)? else {
        return Ok(false);
    };
    if !project_approval_matches(root, &rules, approval_context)? {
        return Ok(false);
    }
    if rules.interval_minutes == 0 {
        return Ok(false);
    }
    let interval_seconds = rules.interval_minutes.saturating_mul(60);
    Ok(rules
        .last_attempt_at
        .is_none_or(|attempt| unix_time().saturating_sub(attempt) >= interval_seconds))
}

fn expected_project_approval(
    root: &Path,
    rules: &ProjectRules,
    context: &ApprovalContext,
) -> Result<ProjectApproval, BoundaryError> {
    Ok(ProjectApproval {
        version: APPROVAL_VERSION,
        root_fingerprint: project_root_fingerprint(root)?,
        client_id: context.client_id.clone(),
        account_id: context.account.id,
        repository: rules.repository.clone(),
        branch: rules.branch.clone(),
        can_push: rules.can_push,
    })
}

fn project_approval_matches(
    root: &Path,
    rules: &ProjectRules,
    context: &ApprovalContext,
) -> Result<bool, BoundaryError> {
    let expected = expected_project_approval(root, rules, context)?;
    let entry = project_approval_entry(&expected.root_fingerprint)?;
    let stored = match entry.get_password() {
        Ok(stored) => Zeroizing::new(stored),
        Err(keyring::Error::NoEntry) => return Ok(false),
        Err(_) => return Err(approval_store_error()),
    };
    let actual: ProjectApproval = match serde_json::from_str(&stored) {
        Ok(approval) => approval,
        Err(_) => {
            delete_project_approval_entry(&entry)?;
            return Ok(false);
        }
    };
    if actual == expected {
        Ok(true)
    } else {
        delete_project_approval_entry(&entry)?;
        Ok(false)
    }
}

fn require_project_approval(
    root: &Path,
    rules: &ProjectRules,
    context: &ApprovalContext,
) -> Result<(), BoundaryError> {
    if project_approval_matches(root, rules, context)? {
        Ok(())
    } else {
        Err(github_error(
            "project_sync_not_approved",
            "Choose this repository with Link current project before UnderTree can synchronize this local folder.",
        ))
    }
}

fn save_project_approval(
    root: &Path,
    rules: &ProjectRules,
    context: &ApprovalContext,
) -> Result<(), BoundaryError> {
    let approval = expected_project_approval(root, rules, context)?;
    let entry = project_approval_entry(&approval.root_fingerprint)?;
    let serialized =
        Zeroizing::new(serde_json::to_string(&approval).map_err(|_| BoundaryError::internal())?);
    entry
        .set_password(&serialized)
        .map_err(|_| approval_store_error())
}

fn remove_project_approval(root: &Path) -> Result<(), BoundaryError> {
    let fingerprint = project_root_fingerprint(root)?;
    let entry = project_approval_entry(&fingerprint)?;
    delete_project_approval_entry(&entry)
}

fn project_approval_entry(fingerprint: &str) -> Result<keyring::Entry, BoundaryError> {
    keyring::Entry::new(APPROVAL_KEYRING_SERVICE, &format!("project-{fingerprint}"))
        .map_err(|_| approval_store_error())
}

fn delete_project_approval_entry(entry: &keyring::Entry) -> Result<(), BoundaryError> {
    match entry.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(_) => Err(approval_store_error()),
    }
}

fn project_root_fingerprint(root: &Path) -> Result<String, BoundaryError> {
    let canonical = root.canonicalize().map_err(|_| {
        github_error(
            "project_unavailable",
            "The selected project folder is unavailable.",
        )
    })?;
    if !canonical.is_dir() {
        return Err(github_error(
            "project_unavailable",
            "The selected project folder is unavailable.",
        ));
    }
    let mut hasher = Sha256::new();
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        for unit in canonical.as_os_str().encode_wide() {
            hasher.update(unit.to_le_bytes());
        }
    }
    #[cfg(unix)]
    {
        use std::os::unix::ffi::OsStrExt;
        hasher.update(canonical.as_os_str().as_bytes());
    }
    #[cfg(not(any(windows, unix)))]
    hasher.update(canonical.to_string_lossy().as_bytes());
    hasher.update([0]);
    hasher.update(git::project_directory_identity(&canonical)?.as_bytes());
    Ok(hasher
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<Vec<_>>()
        .join(""))
}

fn approval_store_error() -> BoundaryError {
    github_error(
        "project_approval_store_unavailable",
        "The operating-system credential store could not verify this project's GitHub approval.",
    )
}

fn load_rules(root: &Path) -> Result<Option<ProjectRules>, BoundaryError> {
    let path = settings_path(root)?;
    let metadata = match fs::symlink_metadata(&path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err(settings_error()),
    };
    if metadata.file_type().is_symlink() || !metadata.is_file() || metadata.len() > 64 * 1024 {
        return Err(settings_error());
    }
    let bytes = fs::read(&path).map_err(|_| settings_error())?;
    let rules: ProjectRules = serde_json::from_slice(&bytes).map_err(|_| settings_error())?;
    validate_rules(&rules)?;
    Ok(Some(rules))
}

fn save_rules(root: &Path, rules: &ProjectRules) -> Result<(), BoundaryError> {
    validate_rules(rules)?;
    let path = settings_path(root)?;
    let parent = path.parent().ok_or_else(BoundaryError::internal)?;
    ensure_settings_directory(root, parent)?;
    let bytes = serde_json::to_vec_pretty(rules).map_err(|_| BoundaryError::internal())?;
    let mut file = AtomicWriteFile::open(&path).map_err(|_| settings_error())?;
    file.write_all(&bytes).map_err(|_| settings_error())?;
    file.sync_all().map_err(|_| settings_error())?;
    file.commit().map_err(|_| settings_error())
}

fn remove_rules(root: &Path) -> Result<(), BoundaryError> {
    let path = settings_path(root)?;
    match fs::symlink_metadata(&path) {
        Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_file() => {
            Err(settings_error())
        }
        Ok(_) => fs::remove_file(path).map_err(|_| settings_error()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(_) => Err(settings_error()),
    }
}

fn settings_path(root: &Path) -> Result<PathBuf, BoundaryError> {
    let canonical_root = root.canonicalize().map_err(|_| {
        github_error(
            "project_unavailable",
            "The selected project folder is unavailable.",
        )
    })?;
    if !canonical_root.is_dir() {
        return Err(github_error(
            "project_unavailable",
            "The selected project folder is unavailable.",
        ));
    }
    let directory = canonical_root.join(".undertree");
    match fs::symlink_metadata(&directory) {
        Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_dir() => {
            return Err(settings_error());
        }
        Ok(_) => {
            let canonical_directory = directory.canonicalize().map_err(|_| settings_error())?;
            if canonical_directory != directory {
                return Err(settings_error());
            }
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(_) => return Err(settings_error()),
    }
    Ok(directory.join(SETTINGS_FILE))
}

fn ensure_settings_directory(root: &Path, directory: &Path) -> Result<(), BoundaryError> {
    match fs::symlink_metadata(directory) {
        Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_dir() => {
            return Err(settings_error());
        }
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            fs::create_dir(directory).map_err(|_| settings_error())?;
        }
        Err(_) => return Err(settings_error()),
    }
    let canonical_root = root.canonicalize().map_err(|_| settings_error())?;
    let canonical_directory = directory.canonicalize().map_err(|_| settings_error())?;
    if canonical_directory != canonical_root.join(".undertree") {
        return Err(settings_error());
    }
    Ok(())
}

fn validate_rules(rules: &ProjectRules) -> Result<(), BoundaryError> {
    if rules.version != SETTINGS_VERSION {
        return Err(github_error(
            "sync_settings_version",
            "This project's GitHub synchronization settings need migration.",
        ));
    }
    git::validate_repository_name(&rules.repository)?;
    git::validate_branch_name(&rules.branch)?;
    validate_interval(rules.interval_minutes)
}

fn validate_interval(interval: u64) -> Result<(), BoundaryError> {
    if ALLOWED_INTERVALS.contains(&interval) {
        Ok(())
    } else {
        Err(github_error(
            "invalid_sync_interval",
            "Choose Off, 5, 15, 30, or 60 minutes for automatic synchronization.",
        ))
    }
}

fn validate_device_response(response: &DeviceCodeResponse) -> Result<(), BoundaryError> {
    if response.device_code.is_empty()
        || response.device_code.len() > 512
        || response.user_code.len() != 9
        || response.user_code.as_bytes().get(4) != Some(&b'-')
        || !response
            .user_code
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || character == '-')
        || response.verification_uri != DEVICE_LOGIN_URL
        || !(60..=1800).contains(&response.expires_in)
        || !(1..=60).contains(&response.interval)
    {
        return Err(github_error(
            "authorization_invalid",
            "GitHub returned an invalid device authorization response.",
        ));
    }
    Ok(())
}

fn validate_github_timestamp(timestamp: &str) -> Result<(), BoundaryError> {
    if timestamp.is_empty()
        || timestamp.len() > 64
        || !timestamp.is_ascii()
        || timestamp.chars().any(char::is_control)
    {
        return Err(github_error(
            "github_response_invalid",
            "GitHub returned invalid repository metadata.",
        ));
    }
    Ok(())
}

async fn parse_response<T: DeserializeOwned>(mut response: Response) -> Result<T, BoundaryError> {
    let status = response.status();
    if response
        .content_length()
        .is_some_and(|length| length > MAX_API_RESPONSE_BYTES as u64)
    {
        return Err(github_error(
            "github_response_too_large",
            "GitHub returned more data than UnderTree accepts.",
        ));
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| network_error())? {
        let next_length = bytes
            .len()
            .checked_add(chunk.len())
            .ok_or_else(BoundaryError::internal)?;
        if next_length > MAX_API_RESPONSE_BYTES {
            return Err(github_error(
                "github_response_too_large",
                "GitHub returned more data than UnderTree accepts.",
            ));
        }
        bytes.extend_from_slice(&chunk);
    }
    if !status.is_success() {
        return Err(if status == reqwest::StatusCode::UNAUTHORIZED {
            github_error(
                "github_session_expired",
                "The GitHub session is no longer valid. Connect the account again.",
            )
        } else if status == reqwest::StatusCode::FORBIDDEN {
            github_error(
                "github_permission_denied",
                "GitHub denied this operation. Check the connected account, organization OAuth policy, and repository permission.",
            )
        } else if status == reqwest::StatusCode::UNPROCESSABLE_ENTITY {
            github_error(
                "github_validation_failed",
                "GitHub rejected the requested repository values. The name may already exist or be unavailable.",
            )
        } else {
            network_error()
        });
    }
    serde_json::from_slice(&bytes).map_err(|_| {
        github_error(
            "github_response_invalid",
            "GitHub returned a response UnderTree could not understand.",
        )
    })
}

fn session_record(session: &Session) -> SessionRecord {
    SessionRecord {
        app_client_id: session.app_client_id.clone(),
        access_token: session.access_token.to_string(),
        refresh_token: session
            .refresh_token
            .as_ref()
            .map(|token| token.to_string()),
        expires_at: session.expires_at,
        refresh_expires_at: session.refresh_expires_at,
        account: session.account.clone(),
    }
}

fn load_stored_session(expected_client_id: &str) -> Result<Option<Session>, BoundaryError> {
    let entry = keyring::Entry::new(KEYRING_SERVICE, KEYRING_ACCOUNT).map_err(|_| {
        github_error(
            "credential_store_unavailable",
            "The operating-system credential store is unavailable.",
        )
    })?;
    let stored = match entry.get_password() {
        Ok(stored) => Zeroizing::new(stored),
        Err(keyring::Error::NoEntry) => return Ok(None),
        Err(_) => {
            return Err(github_error(
                "credential_store_unavailable",
                "The operating-system credential store is unavailable.",
            ));
        }
    };
    let mut record: SessionRecord = match serde_json::from_str(&stored) {
        Ok(record) => record,
        Err(_) => {
            delete_invalid_session_entry(&entry)?;
            return Ok(None);
        }
    };
    if record.app_client_id != expected_client_id {
        clear_session_record(&mut record);
        match entry.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => return Ok(None),
            Err(_) => {
                return Err(github_error(
                    "credential_store_unavailable",
                    "The operating-system credential store could not remove an outdated GitHub session.",
                ));
            }
        }
    }
    if !valid_token_value(&record.access_token)
        || record
            .refresh_token
            .as_ref()
            .is_some_and(|token| !valid_token_value(token))
    {
        clear_session_record(&mut record);
        delete_invalid_session_entry(&entry)?;
        return Ok(None);
    }
    Ok(Some(Session {
        app_client_id: record.app_client_id,
        access_token: Zeroizing::new(record.access_token),
        refresh_token: record.refresh_token.map(Zeroizing::new),
        expires_at: record.expires_at,
        refresh_expires_at: record.refresh_expires_at,
        account: record.account,
    }))
}

fn save_stored_session(mut record: SessionRecord) -> Result<(), BoundaryError> {
    let serialized = serde_json::to_string(&record);
    clear_session_record(&mut record);
    let serialized = Zeroizing::new(serialized.map_err(|_| BoundaryError::internal())?);
    let entry = keyring::Entry::new(KEYRING_SERVICE, KEYRING_ACCOUNT).map_err(|_| {
        github_error(
            "credential_store_unavailable",
            "The operating-system credential store is unavailable.",
        )
    })?;
    entry.set_password(&serialized).map_err(|_| {
        github_error(
            "credential_store_unavailable",
            "The operating-system credential store could not save the GitHub session.",
        )
    })
}

fn secure_token(
    value: Option<String>,
    error_code: &'static str,
) -> Result<Zeroizing<String>, BoundaryError> {
    let mut value = value.ok_or_else(|| credential_response_error(error_code))?;
    if !valid_token_value(&value) {
        value.zeroize();
        return Err(credential_response_error(error_code));
    }
    Ok(Zeroizing::new(value))
}

fn rotated_session(
    payload: TokenResponse,
    current: &Session,
    now: u64,
) -> Result<Session, BoundaryError> {
    let expires_in = payload
        .expires_in
        .filter(|seconds| *seconds > 0)
        .ok_or_else(|| credential_response_error("github_session_expired"))?;
    let refresh_expires_in = payload
        .refresh_token_expires_in
        .filter(|seconds| *seconds > 0)
        .ok_or_else(|| credential_response_error("github_session_expired"))?;
    Ok(Session {
        app_client_id: current.app_client_id.clone(),
        access_token: secure_token(payload.access_token, "github_session_expired")?,
        // GitHub rotates this pair. Falling back to the old refresh token would
        // persist a credential that GitHub has already invalidated.
        refresh_token: Some(secure_token(
            payload.refresh_token,
            "github_session_expired",
        )?),
        expires_at: Some(now.saturating_add(expires_in)),
        refresh_expires_at: Some(now.saturating_add(refresh_expires_in)),
        account: current.account.clone(),
    })
}

fn optional_secure_token(
    value: Option<String>,
    error_code: &'static str,
) -> Result<Option<Zeroizing<String>>, BoundaryError> {
    value
        .map(|value| secure_token(Some(value), error_code))
        .transpose()
}

fn valid_token_value(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 1024
        && value.chars().all(|character| character.is_ascii_graphic())
}

fn credential_response_error(code: &'static str) -> BoundaryError {
    if code == "github_session_expired" {
        github_error(
            "github_session_expired",
            "The GitHub session expired. Connect the account again.",
        )
    } else {
        github_error(
            "authorization_invalid",
            "GitHub returned an incomplete authorization response.",
        )
    }
}

fn clear_session_record(record: &mut SessionRecord) {
    record.access_token.zeroize();
    if let Some(refresh_token) = record.refresh_token.as_mut() {
        refresh_token.zeroize();
    }
}

fn delete_stored_session() -> Result<(), BoundaryError> {
    let entry = keyring::Entry::new(KEYRING_SERVICE, KEYRING_ACCOUNT).map_err(|_| {
        github_error(
            "credential_store_unavailable",
            "The operating-system credential store is unavailable.",
        )
    })?;
    match entry.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(_) => Err(github_error(
            "credential_store_unavailable",
            "The operating-system credential store could not remove the GitHub session.",
        )),
    }
}

fn delete_invalid_session_entry(entry: &keyring::Entry) -> Result<(), BoundaryError> {
    match entry.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(_) => Err(github_error(
            "credential_store_unavailable",
            "The operating-system credential store could not remove an invalid GitHub session.",
        )),
    }
}

fn valid_client_id(value: &str) -> bool {
    let lowered = value.to_ascii_lowercase();
    let token_prefixes = ["ghp_", "gho_", "ghu_", "ghs_", "ghr_", "github_pat_"];
    !value.is_empty()
        && value.len() <= 128
        && !value.chars().all(|character| character.is_ascii_digit())
        && !(value.len() == 40 && value.chars().all(|character| character.is_ascii_hexdigit()))
        && !token_prefixes
            .iter()
            .any(|prefix| lowered.starts_with(prefix))
        && value.chars().all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '.' | '_' | '-')
        })
}

fn oauth_identity(client_id: Option<&str>) -> Option<GitHubAppIdentity> {
    let client_id = client_id?.trim();
    valid_client_id(client_id).then(|| GitHubAppIdentity {
        client_id: client_id.to_owned(),
    })
}

fn bundled_app_identity() -> Option<GitHubAppIdentity> {
    oauth_identity(Some(UNDERTREE_GITHUB_CLIENT_ID))
}

fn validate_oauth_scope(scope: Option<&str>) -> Result<(), BoundaryError> {
    if scope
        .unwrap_or_default()
        .split([',', ' '])
        .any(|scope| scope == "repo")
    {
        Ok(())
    } else {
        Err(github_error(
            "github_scope_denied",
            "UnderTree needs GitHub repository access to list, create, pull, and push your repositories. Authorize the requested repository access to continue.",
        ))
    }
}

fn editor_state_is_clean(dirty: &AtomicBool, updated_at: &AtomicU64) -> bool {
    let now = unix_time();
    let updated_at = updated_at.load(Ordering::Acquire);

    !dirty.load(Ordering::Acquire)
        && updated_at != 0
        && now >= updated_at
        && now - updated_at <= EDITOR_STATE_LEASE_SECONDS
}

fn unix_time() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

fn github_error(code: &'static str, message: &'static str) -> BoundaryError {
    BoundaryError::github(code, message)
}

fn network_error() -> BoundaryError {
    github_error(
        "github_network_error",
        "UnderTree could not reach GitHub. Check the network and try again.",
    )
}

fn authorization_superseded() -> BoundaryError {
    github_error(
        "authorization_superseded",
        "A newer GitHub authorization request replaced this one.",
    )
}

fn settings_error() -> BoundaryError {
    github_error(
        "sync_settings_unavailable",
        "UnderTree could not read or update this project's GitHub synchronization settings.",
    )
}

#[cfg(test)]
mod tests {
    use std::time::{SystemTime, UNIX_EPOCH};

    use super::*;

    fn temporary_directory(name: &str) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time")
            .as_nanos();
        let path = std::env::temp_dir().join(format!("undertree-github-{name}-{nonce}"));
        fs::create_dir_all(&path).expect("create test directory");
        path
    }

    fn app_identity(client_id: &str) -> GitHubAppIdentity {
        GitHubAppIdentity {
            client_id: client_id.into(),
        }
    }

    #[test]
    fn validates_bundled_public_identity_without_accepting_tokens_or_urls() {
        assert_eq!(
            oauth_identity(Some("Ov23ctAbCdEf01234567")),
            Some(app_identity("Ov23ctAbCdEf01234567"))
        );
        for invalid in [
            "",
            "ghp_example",
            "GITHUB_PAT_example",
            "https://github.com/apps/example",
            "client id",
            "clïent",
            "12345678",
            "0123456789abcdef0123456789abcdef01234567",
        ] {
            assert!(
                !valid_client_id(invalid),
                "accepted invalid client ID shape"
            );
        }
    }

    #[test]
    fn accepts_only_a_valid_public_oauth_identity() {
        assert_eq!(
            oauth_identity(Some("  OvManaged  ")),
            Some(app_identity("OvManaged"))
        );
        assert!(oauth_identity(None).is_none());
        assert!(oauth_identity(Some("ghp_not-a-client-id")).is_none());
    }

    #[test]
    fn production_build_contains_the_official_public_identity() {
        assert_eq!(
            bundled_app_identity(),
            Some(app_identity("Ov23ctI0XuS7MKywUeOf"))
        );
    }

    #[test]
    fn ordinary_sync_refuses_to_misreport_uncommitted_files_as_synchronized() {
        let error = require_committed_sync_input(SyncAction::Sync, true)
            .expect_err("ordinary sync must not claim uncommitted files were pushed");
        assert_eq!(error.code, "uncommitted_changes");
        assert!(require_committed_sync_input(SyncAction::Sync, false).is_ok());
        assert!(require_committed_sync_input(SyncAction::CommitAndSync, true).is_ok());
        assert!(require_committed_sync_input(SyncAction::Push, true).is_ok());
    }

    #[test]
    fn pending_authorization_exposes_only_the_matching_unexpired_public_code() {
        let service = GitHubService::with_identity(Some(app_identity("OvPendingTest")));
        service.authorization_generation.store(7, Ordering::Release);
        tauri::async_runtime::block_on(async {
            *service.pending.lock().await = Some(PendingAuthorization {
                generation: 7,
                device_code: Zeroizing::new("secret-device-code".into()),
                user_code: "ABCD-1234".into(),
                expires_at: unix_time().saturating_add(60),
                interval_seconds: 5,
                next_poll_at: unix_time().saturating_add(5),
            });
            assert_eq!(
                service
                    .pending_authorization_code(7)
                    .await
                    .expect("matching public code"),
                "ABCD-1234"
            );
            assert!(service.pending_authorization_code(6).await.is_err());
        });
    }

    #[test]
    #[ignore = "requires a live GitHub authorization stored by UnderTree"]
    fn live_account_lists_accessible_repositories_without_exposing_credentials() {
        let service = GitHubService::new();
        let repositories = tauri::async_runtime::block_on(service.list_repositories())
            .expect("UnderTree should list repositories for its stored GitHub authorization");
        assert!(
            !repositories.is_empty(),
            "the connected GitHub account should expose at least one repository"
        );
        let writable = repositories
            .iter()
            .filter(|repository| repository.can_push)
            .count();
        let grant_candidates = repositories
            .iter()
            .filter(|repository| repository.full_name.to_ascii_lowercase().contains("grant"))
            .map(|repository| repository.full_name.as_str())
            .collect::<Vec<_>>();
        println!(
            "UnderTree listed {} repositories ({} writable); grant candidates: {}",
            repositories.len(),
            writable,
            if grant_candidates.is_empty() {
                "none".to_owned()
            } else {
                grant_candidates.join(", ")
            }
        );
    }

    #[test]
    #[ignore = "requires explicit UNDERTREE_LIVE_REPOSITORY and UNDERTREE_LIVE_CLONE_PARENT"]
    fn live_clone_uses_undertree_service_and_opens_the_local_project() {
        git::configure_transport_limits().expect("configure native Git transport");
        let repository_name = std::env::var("UNDERTREE_LIVE_REPOSITORY")
            .expect("set UNDERTREE_LIVE_REPOSITORY to owner/repository");
        let destination_parent = PathBuf::from(
            std::env::var_os("UNDERTREE_LIVE_CLONE_PARENT")
                .expect("set UNDERTREE_LIVE_CLONE_PARENT to an existing or creatable folder"),
        );
        fs::create_dir_all(&destination_parent).expect("create clone parent");
        let service = GitHubService::new();
        let projects = ProjectState::default();
        let snapshot = tauri::async_runtime::block_on(async {
            let repository = service
                .list_repositories()
                .await
                .expect("list repositories")
                .into_iter()
                .find(|repository| repository.full_name == repository_name)
                .expect("requested repository should be accessible");
            service
                .clone_project(
                    destination_parent,
                    projects,
                    LinkProjectRequest {
                        repository: repository.full_name,
                        default_branch: repository.default_branch,
                    },
                )
                .await
                .expect("clone and open repository through UnderTree")
        });
        println!(
            "UnderTree cloned and opened {} with {} editable files; active document: {}",
            snapshot.root,
            snapshot.files.len(),
            snapshot.active.path
        );
    }

    #[test]
    #[ignore = "requires explicit UNDERTREE_LIVE_PROJECT_ROOT and its stored UnderTree approval"]
    fn live_project_pulls_and_pushes_through_undertree_without_remote_changes() {
        git::configure_transport_limits().expect("configure native Git transport");
        let root = PathBuf::from(
            std::env::var_os("UNDERTREE_LIVE_PROJECT_ROOT")
                .expect("set UNDERTREE_LIVE_PROJECT_ROOT to a linked UnderTree clone"),
        );
        let service = GitHubService::new();
        service.set_editor_dirty(false);
        let projects = ProjectState::default();
        projects.select(root.clone()).expect("open cloned project");
        let root = projects
            .root()
            .expect("read selected root")
            .expect("project remains selected");
        let (pull, push) = tauri::async_runtime::block_on(async {
            let pull = service
                .sync_project(
                    root.clone(),
                    projects.clone(),
                    SyncProjectRequest {
                        action: SyncAction::Pull,
                        commit_message: None,
                    },
                )
                .await
                .expect("pull through UnderTree");
            service.set_editor_dirty(false);
            let push = service
                .sync_project(
                    root,
                    projects,
                    SyncProjectRequest {
                        action: SyncAction::Push,
                        commit_message: None,
                    },
                )
                .await
                .expect("no-op push through UnderTree");
            (pull, push)
        });
        println!("{} {}", pull.summary, push.summary);
    }

    #[test]
    fn requires_repository_scope_from_oauth_authorization() {
        assert!(validate_oauth_scope(Some("repo")).is_ok());
        assert!(validate_oauth_scope(Some("read:user,repo")).is_ok());
        assert!(validate_oauth_scope(Some("offline_access repo")).is_ok());
        assert!(validate_oauth_scope(Some("read:user")).is_err());
        assert!(validate_oauth_scope(None).is_err());
    }

    #[test]
    fn refresh_requires_and_stores_the_complete_rotated_token_pair() {
        let current = Session {
            app_client_id: UNDERTREE_GITHUB_CLIENT_ID.into(),
            access_token: Zeroizing::new("old-access".into()),
            refresh_token: Some(Zeroizing::new("old-refresh".into())),
            expires_at: Some(1),
            refresh_expires_at: Some(2),
            account: Some(AccountSummary {
                login: "octocat".into(),
                name: None,
                id: 1,
            }),
        };
        let payload = TokenResponse {
            access_token: Some("new-access".into()),
            expires_in: Some(3600),
            refresh_token: Some("new-refresh".into()),
            refresh_token_expires_in: Some(86_400),
            scope: Some("repo offline_access".into()),
            error: None,
        };
        let rotated = rotated_session(payload, &current, 100).expect("complete rotation");
        assert_eq!(rotated.access_token.as_str(), "new-access");
        assert_eq!(
            rotated
                .refresh_token
                .as_ref()
                .expect("rotated refresh token")
                .as_str(),
            "new-refresh"
        );
        assert_eq!(rotated.expires_at, Some(3700));
        assert_eq!(rotated.refresh_expires_at, Some(86_500));

        for incomplete in [
            TokenResponse {
                access_token: None,
                expires_in: Some(3600),
                refresh_token: Some("new-refresh".into()),
                refresh_token_expires_in: Some(86_400),
                scope: None,
                error: None,
            },
            TokenResponse {
                access_token: Some("new-access".into()),
                expires_in: Some(3600),
                refresh_token: None,
                refresh_token_expires_in: Some(86_400),
                scope: None,
                error: None,
            },
            TokenResponse {
                access_token: Some("new-access".into()),
                expires_in: Some(0),
                refresh_token: Some("new-refresh".into()),
                refresh_token_expires_in: Some(86_400),
                scope: None,
                error: None,
            },
        ] {
            assert!(rotated_session(incomplete, &current, 100).is_err());
        }
    }

    #[test]
    fn round_trips_project_rules_inside_undertree_directory() {
        let root = temporary_directory("rules");
        let rules = ProjectRules {
            version: SETTINGS_VERSION,
            repository: "octocat/hello-world".into(),
            branch: "main".into(),
            can_push: true,
            interval_minutes: 15,
            auto_commit: true,
            last_attempt_at: Some(10),
            last_sync_at: Some(9),
        };
        save_rules(&root, &rules).expect("save rules");
        let loaded = load_rules(&root).expect("load rules").expect("rules exist");
        assert_eq!(loaded.repository, rules.repository);
        assert_eq!(loaded.interval_minutes, 15);
        assert!(loaded.auto_commit);
        remove_rules(&root).expect("remove rules");
        assert!(load_rules(&root).expect("load removed rules").is_none());
        fs::remove_dir_all(root).expect("remove test directory");
    }

    #[test]
    fn rejects_unapproved_intervals() {
        assert!(validate_interval(5).is_ok());
        assert!(validate_interval(7).is_err());
    }

    #[test]
    fn project_approval_is_bound_to_root_account_client_repository_and_branch() {
        let first = temporary_directory("approval-first");
        let second = temporary_directory("approval-second");
        let rules = ProjectRules {
            version: SETTINGS_VERSION,
            repository: "octocat/hello-world".into(),
            branch: "main".into(),
            can_push: true,
            interval_minutes: 5,
            auto_commit: true,
            last_attempt_at: None,
            last_sync_at: None,
        };
        let context = ApprovalContext {
            client_id: UNDERTREE_GITHUB_CLIENT_ID.into(),
            account: AccountSummary {
                login: "octocat".into(),
                name: None,
                id: 1,
            },
        };
        let approval = expected_project_approval(&first, &rules, &context).expect("approval");
        let other_root =
            expected_project_approval(&second, &rules, &context).expect("other approval");
        assert_ne!(approval.root_fingerprint, other_root.root_fingerprint);
        assert_eq!(approval.client_id, UNDERTREE_GITHUB_CLIENT_ID);
        assert_eq!(approval.account_id, 1);
        assert_eq!(approval.repository, "octocat/hello-world");
        assert_eq!(approval.branch, "main");

        let renamed_context = ApprovalContext {
            client_id: UNDERTREE_GITHUB_CLIENT_ID.into(),
            account: AccountSummary {
                login: "renamed-octocat".into(),
                name: None,
                id: 1,
            },
        };
        let renamed = expected_project_approval(&first, &rules, &renamed_context)
            .expect("approval after account rename");
        assert_eq!(approval, renamed, "a login rename must preserve approval");

        fs::remove_dir_all(first).expect("remove first test directory");
        fs::remove_dir_all(second).expect("remove second test directory");
    }

    #[test]
    fn project_approval_does_not_survive_folder_replacement_at_same_path() {
        let parent = temporary_directory("approval-replacement");
        let project = parent.join("project");
        let displaced = parent.join("displaced-original");
        fs::create_dir(&project).expect("create original project");
        let original = project_root_fingerprint(&project).expect("original fingerprint");

        fs::rename(&project, &displaced).expect("move original project aside");
        fs::create_dir(&project).expect("create replacement project");
        let replacement = project_root_fingerprint(&project).expect("replacement fingerprint");
        assert_ne!(
            original, replacement,
            "a new directory at the same path must not inherit approval"
        );

        fs::remove_dir_all(parent).expect("remove replacement test directory");
    }

    #[test]
    fn editor_state_lease_fails_closed() {
        let dirty = AtomicBool::new(true);
        let updated_at = AtomicU64::new(unix_time());
        assert!(!editor_state_is_clean(&dirty, &updated_at));

        dirty.store(false, Ordering::Release);
        assert!(editor_state_is_clean(&dirty, &updated_at));

        updated_at.store(
            unix_time().saturating_sub(EDITOR_STATE_LEASE_SECONDS + 1),
            Ordering::Release,
        );
        assert!(!editor_state_is_clean(&dirty, &updated_at));

        updated_at.store(unix_time().saturating_add(1), Ordering::Release);
        assert!(!editor_state_is_clean(&dirty, &updated_at));
    }

    #[cfg(unix)]
    #[test]
    fn refuses_settings_through_a_symlinked_undertree_directory() {
        use std::os::unix::fs::symlink;

        let root = temporary_directory("settings-symlink-root");
        let outside = temporary_directory("settings-symlink-outside");
        let outside_settings = outside.join(SETTINGS_FILE);
        fs::write(&outside_settings, b"outside").expect("write outside sentinel");
        symlink(&outside, root.join(".undertree")).expect("create settings symlink");

        assert!(load_rules(&root).is_err());
        assert!(remove_rules(&root).is_err());
        assert_eq!(
            fs::read(&outside_settings).expect("read outside sentinel"),
            b"outside"
        );

        fs::remove_file(root.join(".undertree")).expect("remove settings symlink");
        fs::remove_dir_all(root).expect("remove root");
        fs::remove_dir_all(outside).expect("remove outside directory");
    }
}
