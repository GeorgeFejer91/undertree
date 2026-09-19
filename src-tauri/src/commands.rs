use serde::Serialize;
use tauri::{AppHandle, Emitter, State};
use tauri_plugin_clipboard_manager::ClipboardExt;
use tauri_plugin_dialog::DialogExt;

use crate::agent_annotations::{
    AgentAnnotationService, AgentEditingPolicy, ReplaceAnnotationsRequest,
};
use crate::compiler::{CompileRequest, CompileResponse, CompilerAssets};
use crate::error::BoundaryError;
use crate::github::{
    AuthorizationPoll, CreateRepositoryRequest, DeviceAuthorization, GitHubService, GitHubStatus,
    LinkProjectRequest, RepositorySummary, SaveRulesRequest, SyncProjectRequest, SyncResult,
};
use crate::latex::{self, ConversionReport, TypstToLatexReport};
use crate::pdf::{self, PdfExportResult, PdfExportState, RevealPdfRequest};
use crate::review::{
    ReviewActor, ReviewCommentRequest, ReviewDecisionRequest, ReviewDecisionResult,
    ReviewMarkRequest, ReviewProposalRequest, ReviewRemoveMarkRequest, ReviewService, ReviewState,
};
use crate::project::{
    BibliographyIndex, CreateFileResponse, DocumentData, ProjectSnapshot, ProjectState,
    RecentProject, SaveRequest, SaveResponse,
};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LatexImportResult {
    project: ProjectSnapshot,
    report: ConversionReport,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TypstToLatexExportResult {
    project: ProjectSnapshot,
    report: TypstToLatexReport,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CompilerInfo {
    engine: &'static str,
    engine_version: &'static str,
    mode: &'static str,
}


#[tauri::command]
pub async fn review_state(
    reviews: State<'_, ReviewService>,
    projects: State<'_, ProjectState>,
    path: String,
    source: String,
) -> Result<ReviewState, BoundaryError> {
    let root = projects.root()?.ok_or_else(|| {
        BoundaryError::project("project_required", "Choose a Typst project first.")
    })?;
    let reviews = reviews.inner().clone();
    tauri::async_runtime::spawn_blocking(move || reviews.state(&root, &path, &source))
        .await
        .map_err(|_| BoundaryError::internal())?
}

#[tauri::command]
pub async fn review_upsert_mark(
    reviews: State<'_, ReviewService>,
    projects: State<'_, ProjectState>,
    request: ReviewMarkRequest,
) -> Result<ReviewState, BoundaryError> {
    let root = projects.root()?.ok_or_else(|| {
        BoundaryError::project("project_required", "Choose a Typst project first.")
    })?;
    let reviews = reviews.inner().clone();
    tauri::async_runtime::spawn_blocking(move || reviews.upsert_mark(&root, request))
        .await
        .map_err(|_| BoundaryError::internal())?
}

#[tauri::command]
pub async fn review_remove_mark(
    reviews: State<'_, ReviewService>,
    projects: State<'_, ProjectState>,
    request: ReviewRemoveMarkRequest,
) -> Result<ReviewState, BoundaryError> {
    let root = projects.root()?.ok_or_else(|| {
        BoundaryError::project("project_required", "Choose a Typst project first.")
    })?;
    let reviews = reviews.inner().clone();
    tauri::async_runtime::spawn_blocking(move || reviews.remove_mark(&root, request))
        .await
        .map_err(|_| BoundaryError::internal())?
}

#[tauri::command]
pub async fn review_create_proposal(
    reviews: State<'_, ReviewService>,
    projects: State<'_, ProjectState>,
    request: ReviewProposalRequest,
    actor: Option<ReviewActor>,
) -> Result<ReviewState, BoundaryError> {
    let root = projects.root()?.ok_or_else(|| {
        BoundaryError::project("project_required", "Choose a Typst project first.")
    })?;
    let reviews = reviews.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        reviews.create_proposal(&root, request, actor.unwrap_or(ReviewActor::Human))
    })
    .await
    .map_err(|_| BoundaryError::internal())?
}

#[tauri::command]
pub async fn review_add_comment(
    reviews: State<'_, ReviewService>,
    projects: State<'_, ProjectState>,
    request: ReviewCommentRequest,
    actor: Option<ReviewActor>,
) -> Result<ReviewState, BoundaryError> {
    let root = projects.root()?.ok_or_else(|| {
        BoundaryError::project("project_required", "Choose a Typst project first.")
    })?;
    let reviews = reviews.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        reviews.add_comment(&root, request, actor.unwrap_or(ReviewActor::Human))
    })
    .await
    .map_err(|_| BoundaryError::internal())?
}

#[tauri::command]
pub async fn review_decide(
    reviews: State<'_, ReviewService>,
    projects: State<'_, ProjectState>,
    request: ReviewDecisionRequest,
) -> Result<ReviewDecisionResult, BoundaryError> {
    let root = projects.root()?.ok_or_else(|| {
        BoundaryError::project("project_required", "Choose a Typst project first.")
    })?;
    let reviews = reviews.inner().clone();
    tauri::async_runtime::spawn_blocking(move || reviews.decide(&root, request))
        .await
        .map_err(|_| BoundaryError::internal())?
}

#[tauri::command]
pub async fn current_project(
    state: State<'_, ProjectState>,
) -> Result<Option<ProjectSnapshot>, BoundaryError> {
    if state.root()?.is_none() {
        return Ok(None);
    }
    let preferred = state.take_initial_active_path()?;
    let projects = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || projects.refresh(preferred.as_deref()).map(Some))
        .await
        .map_err(|_| BoundaryError::internal())?
}

#[tauri::command]
pub fn recent_projects(
    state: State<'_, ProjectState>,
) -> Result<Vec<RecentProject>, BoundaryError> {
    state.recent_projects()
}

#[tauri::command]
pub async fn open_recent_project(
    state: State<'_, ProjectState>,
    root: String,
) -> Result<ProjectSnapshot, BoundaryError> {
    let projects = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || projects.select_recent(&root))
        .await
        .map_err(|_| BoundaryError::internal())?
}

#[tauri::command]
pub async fn compile_document(
    state: State<'_, CompilerAssets>,
    projects: State<'_, ProjectState>,
    request: CompileRequest,
) -> Result<CompileResponse, BoundaryError> {
    let assets = state.inner().clone();
    let project_root = if request.path.is_some() {
        projects.root()?
    } else {
        None
    };
    tauri::async_runtime::spawn_blocking(move || assets.compile(request, project_root))
        .await
        .map_err(|_| BoundaryError::internal())?
}

#[tauri::command]
pub async fn export_pdf(
    app: AppHandle,
    compiler: State<'_, CompilerAssets>,
    projects: State<'_, ProjectState>,
    exports: State<'_, PdfExportState>,
    request: CompileRequest,
) -> Result<Option<PdfExportResult>, BoundaryError> {
    #[cfg(mobile)]
    {
        let _ = (app, compiler, projects, exports, request);
        return Err(BoundaryError::project(
            "unsupported_platform",
            "PDF export is currently available on desktop.",
        ));
    }

    #[cfg(desktop)]
    {
        let suggested_name = pdf::suggested_file_name(request.path.as_deref());
        let document_path = request.path.clone();
        let project_root = if request.path.is_some() {
            projects.root()?
        } else {
            None
        };
        let selected = tauri::async_runtime::spawn_blocking(move || {
            app.dialog()
                .file()
                .set_title("Save the current UnderTree document as PDF")
                .set_file_name(suggested_name)
                .add_filter("PDF document", &["pdf"])
                .blocking_save_file()
                .map(|path| {
                    path.into_path().map_err(|_| {
                        BoundaryError::project(
                            "unsupported_path",
                            "The selected PDF path is not available on this platform.",
                        )
                    })
                })
                .transpose()
        })
        .await
        .map_err(|_| BoundaryError::internal())??;
        let Some(destination) = selected else {
            return Ok(None);
        };

        let compiler = compiler.inner().clone();
        let exports = exports.inner().clone();
        tauri::async_runtime::spawn_blocking(move || {
            // The native dialog owns overwrite confirmation. Requiring a .pdf
            // suffix prevents a platform dialog from silently retargeting the
            // confirmed destination after it closes.
            let saved = pdf::export_document(&compiler, request, project_root, destination, true)?;
            exports.remember(saved.path, document_path, saved.result.revision)?;
            Ok(Some(saved.result))
        })
        .await
        .map_err(|_| BoundaryError::internal())?
    }
}

#[tauri::command]
pub async fn reveal_exported_pdf(
    exports: State<'_, PdfExportState>,
    request: RevealPdfRequest,
) -> Result<(), BoundaryError> {
    #[cfg(mobile)]
    {
        let _ = (exports, request);
        return Err(BoundaryError::project(
            "unsupported_platform",
            "Showing an exported PDF in its folder is currently available on desktop.",
        ));
    }

    #[cfg(desktop)]
    {
        let exports = exports.inner().clone();
        tauri::async_runtime::spawn_blocking(move || {
            let path = exports.current_path(&request)?;
            pdf::reveal_pdf(path)
        })
        .await
        .map_err(|_| BoundaryError::internal())?
    }
}

#[tauri::command]
pub async fn choose_project(
    app: AppHandle,
    state: State<'_, ProjectState>,
) -> Result<Option<ProjectSnapshot>, BoundaryError> {
    #[cfg(mobile)]
    {
        let _ = (app, state);
        return Err(BoundaryError::project(
            "unsupported_platform",
            "Folder projects are currently available on desktop.",
        ));
    }

    #[cfg(desktop)]
    {
        let projects = state.inner().clone();
        tauri::async_runtime::spawn_blocking(move || {
            let selected = app
                .dialog()
                .file()
                .set_title("Choose an UnderTree Typst project")
                .blocking_pick_folder();
            selected
                .map(|path| {
                    path.into_path().map_err(|_| {
                        BoundaryError::project(
                            "unsupported_path",
                            "The selected folder path is not available on this platform.",
                        )
                    })
                })
                .transpose()?
                .map(|path| projects.select(path))
                .transpose()
        })
        .await
        .map_err(|_| BoundaryError::internal())?
    }
}

#[tauri::command]
pub async fn import_latex_project(
    app: AppHandle,
    state: State<'_, ProjectState>,
    compiler: State<'_, CompilerAssets>,
) -> Result<Option<LatexImportResult>, BoundaryError> {
    #[cfg(mobile)]
    {
        let _ = (app, state, compiler);
        return Err(BoundaryError::project(
            "unsupported_platform",
            "LaTeX and Overleaf ZIP import is currently available on desktop.",
        ));
    }

    #[cfg(desktop)]
    {
        let current_root = state.root()?;
        let selection = tauri::async_runtime::spawn_blocking(move || {
            let source = app
                .dialog()
                .file()
                .set_title("Import a LaTeX document or Overleaf ZIP")
                .add_filter("LaTeX and Overleaf projects", &["tex", "zip"])
                .blocking_pick_file();
            let source = source
                .map(|path| {
                    path.into_path().map_err(|_| {
                        BoundaryError::project(
                            "unsupported_path",
                            "The selected import path is not available on this platform.",
                        )
                    })
                })
                .transpose()?;
            let Some(source) = source else {
                return Ok(None);
            };
            let destination = if source
                .extension()
                .is_some_and(|extension| extension.eq_ignore_ascii_case("zip"))
            {
                app.dialog()
                    .file()
                    .set_title("Choose where UnderTree should create the imported project")
                    .blocking_pick_folder()
                    .map(|path| {
                        path.into_path().map_err(|_| {
                            BoundaryError::project(
                                "unsupported_path",
                                "The selected destination is not available on this platform.",
                            )
                        })
                    })
                    .transpose()?
            } else {
                None
            };
            if source
                .extension()
                .is_some_and(|extension| extension.eq_ignore_ascii_case("zip"))
                && destination.is_none()
            {
                return Ok(None);
            }
            Ok(Some((source, destination)))
        })
        .await
        .map_err(|_| BoundaryError::internal())??;
        let Some((source, destination)) = selection else {
            return Ok(None);
        };

        let projects = state.inner().clone();
        let compiler = compiler.inner().clone();
        tauri::async_runtime::spawn_blocking(move || {
            let (root, mut report) = if source
                .extension()
                .is_some_and(|extension| extension.eq_ignore_ascii_case("tex"))
            {
                latex::import_tex_file(&source, current_root.as_deref())?
            } else if source
                .extension()
                .is_some_and(|extension| extension.eq_ignore_ascii_case("zip"))
            {
                latex::import_overleaf_zip(
                    &source,
                    destination.as_deref().ok_or_else(BoundaryError::internal)?,
                )?
            } else {
                return Err(BoundaryError::project(
                    "latex_invalid_source",
                    "Choose a .tex document or an Overleaf .zip archive.",
                ));
            };
            latex::validate_generated_typst_drafts(&root, &mut report, &compiler);
            let project =
                projects.select_imported(root, report.primary_typst.as_deref(), report.clone())?;
            Ok(Some(LatexImportResult { project, report }))
        })
        .await
        .map_err(|_| BoundaryError::internal())?
    }
}

#[tauri::command]
pub async fn export_typst_to_latex(
    state: State<'_, ProjectState>,
    compiler: State<'_, CompilerAssets>,
    path: String,
) -> Result<TypstToLatexExportResult, BoundaryError> {
    #[cfg(mobile)]
    {
        let _ = (state, compiler, path);
        return Err(BoundaryError::project(
            "unsupported_platform",
            "Typst-to-LaTeX export is currently available on desktop.",
        ));
    }

    #[cfg(desktop)]
    {
        let projects = state.inner().clone();
        let compiler = compiler.inner().clone();
        tauri::async_runtime::spawn_blocking(move || {
            let (project, report) = projects.export_typst_to_latex(&path, &compiler)?;
            Ok(TypstToLatexExportResult { project, report })
        })
        .await
        .map_err(|_| BoundaryError::internal())?
    }
}

#[tauri::command]
pub async fn open_document(
    state: State<'_, ProjectState>,
    path: String,
) -> Result<DocumentData, BoundaryError> {
    let projects = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || projects.open(&path))
        .await
        .map_err(|_| BoundaryError::internal())?
}

#[tauri::command]
pub async fn refresh_project(
    state: State<'_, ProjectState>,
    preferred_path: Option<String>,
) -> Result<ProjectSnapshot, BoundaryError> {
    let projects = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || projects.refresh(preferred_path.as_deref()))
        .await
        .map_err(|_| BoundaryError::internal())?
}

#[tauri::command]
pub async fn create_bibliography(
    state: State<'_, ProjectState>,
    path: String,
) -> Result<CreateFileResponse, BoundaryError> {
    let projects = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || projects.create_bibliography(&path))
        .await
        .map_err(|_| BoundaryError::internal())?
}

#[tauri::command]
pub async fn bibliography_entries(
    state: State<'_, ProjectState>,
) -> Result<BibliographyIndex, BoundaryError> {
    let projects = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || projects.bibliography_entries())
        .await
        .map_err(|_| BoundaryError::internal())?
}

#[tauri::command]
pub async fn agent_annotations(
    annotations: State<'_, AgentAnnotationService>,
    projects: State<'_, ProjectState>,
    path: String,
    source: String,
) -> Result<AgentEditingPolicy, BoundaryError> {
    let root = projects.root()?.ok_or_else(|| {
        BoundaryError::project("project_required", "Choose a Typst project first.")
    })?;
    let annotations = annotations.inner().clone();
    tauri::async_runtime::spawn_blocking(move || annotations.policy(&root, &path, &source))
        .await
        .map_err(|_| BoundaryError::internal())?
}

#[tauri::command]
pub async fn set_agent_annotations(
    annotations: State<'_, AgentAnnotationService>,
    projects: State<'_, ProjectState>,
    request: ReplaceAnnotationsRequest,
) -> Result<AgentEditingPolicy, BoundaryError> {
    let root = projects.root()?.ok_or_else(|| {
        BoundaryError::project("project_required", "Choose a Typst project first.")
    })?;
    let annotations = annotations.inner().clone();
    tauri::async_runtime::spawn_blocking(move || annotations.replace(&root, request))
        .await
        .map_err(|_| BoundaryError::internal())?
}

#[tauri::command]
pub async fn save_document(
    state: State<'_, ProjectState>,
    request: SaveRequest,
) -> Result<SaveResponse, BoundaryError> {
    let projects = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || projects.save(request))
        .await
        .map_err(|_| BoundaryError::internal())?
}

#[tauri::command]
pub fn compiler_info() -> CompilerInfo {
    CompilerInfo {
        engine: "Typst",
        engine_version: "0.15.1",
        mode: "embedded-rust",
    }
}

#[tauri::command]
pub async fn github_status(
    github: State<'_, GitHubService>,
    projects: State<'_, ProjectState>,
) -> Result<GitHubStatus, BoundaryError> {
    github.status(projects.root()?).await
}

#[tauri::command]
pub async fn github_begin_auth(
    github: State<'_, GitHubService>,
) -> Result<DeviceAuthorization, BoundaryError> {
    github.begin_authorization().await
}

#[tauri::command]
pub async fn github_copy_device_code(
    app: AppHandle,
    github: State<'_, GitHubService>,
    attempt_id: u64,
) -> Result<(), BoundaryError> {
    let code = github.pending_authorization_code(attempt_id).await?;
    app.clipboard().write_text(code).map_err(|_| {
        BoundaryError::project(
            "clipboard_write_failed",
            "UnderTree could not copy the GitHub code. Select and copy the visible code manually.",
        )
    })
}

#[tauri::command]
pub async fn github_open_auth_page(
    github: State<'_, GitHubService>,
    attempt_id: u64,
) -> Result<(), BoundaryError> {
    let _ = github.pending_authorization_code(attempt_id).await?;
    tauri_plugin_opener::open_url("https://github.com/login/device", None::<&str>).map_err(|_| {
        BoundaryError::project(
            "browser_open_failed",
            "UnderTree could not open GitHub's sign-in page in the system browser.",
        )
    })
}

#[tauri::command]
pub async fn github_poll_auth(
    github: State<'_, GitHubService>,
    attempt_id: u64,
) -> Result<AuthorizationPoll, BoundaryError> {
    github.poll_authorization(attempt_id).await
}

#[tauri::command]
pub async fn github_list_repositories(
    github: State<'_, GitHubService>,
) -> Result<Vec<RepositorySummary>, BoundaryError> {
    github.list_repositories().await
}

#[tauri::command]
pub async fn github_create_repository(
    app: AppHandle,
    github: State<'_, GitHubService>,
    projects: State<'_, ProjectState>,
    request: CreateRepositoryRequest,
) -> Result<Option<ProjectSnapshot>, BoundaryError> {
    #[cfg(mobile)]
    {
        let _ = (app, github, projects, request);
        return Err(BoundaryError::project(
            "unsupported_platform",
            "Local GitHub project creation is currently available on desktop.",
        ));
    }

    #[cfg(desktop)]
    {
        let dialog_app = app.clone();
        let selected = tauri::async_runtime::spawn_blocking(move || {
            dialog_app
                .dialog()
                .file()
                .set_title("Choose where UnderTree should create the local project folder")
                .blocking_pick_folder()
                .map(|path| {
                    path.into_path().map_err(|_| {
                        BoundaryError::project(
                            "unsupported_path",
                            "The selected folder path is not available on this platform.",
                        )
                    })
                })
                .transpose()
        })
        .await
        .map_err(|_| BoundaryError::internal())??;
        let Some(destination_parent) = selected else {
            return Ok(None);
        };
        let _ = app.emit(
            "github-clone-state",
            "Parent folder selected. UnderTree is securely fetching and checking out the repository…",
        );
        github
            .create_repository_project(destination_parent, projects.inner().clone(), request)
            .await
            .map(Some)
    }
}

#[tauri::command]
pub async fn github_link_project(
    github: State<'_, GitHubService>,
    projects: State<'_, ProjectState>,
    request: LinkProjectRequest,
) -> Result<GitHubStatus, BoundaryError> {
    github
        .link_project(
            selected_project_root(&projects)?,
            projects.inner().clone(),
            request,
        )
        .await
}

#[tauri::command]
pub async fn github_clone_repository(
    app: AppHandle,
    github: State<'_, GitHubService>,
    projects: State<'_, ProjectState>,
    request: LinkProjectRequest,
) -> Result<Option<ProjectSnapshot>, BoundaryError> {
    #[cfg(mobile)]
    {
        let _ = (app, github, projects, request);
        return Err(BoundaryError::project(
            "unsupported_platform",
            "Local GitHub repository copies are currently available on desktop.",
        ));
    }

    #[cfg(desktop)]
    {
        let selected = tauri::async_runtime::spawn_blocking(move || {
            app.dialog()
                .file()
                .set_title("Choose where UnderTree should store the local repository copy")
                .blocking_pick_folder()
                .map(|path| {
                    path.into_path().map_err(|_| {
                        BoundaryError::project(
                            "unsupported_path",
                            "The selected folder path is not available on this platform.",
                        )
                    })
                })
                .transpose()
        })
        .await
        .map_err(|_| BoundaryError::internal())??;
        let Some(destination_parent) = selected else {
            return Ok(None);
        };
        github
            .clone_project(destination_parent, projects.inner().clone(), request)
            .await
            .map(Some)
    }
}

#[tauri::command]
pub async fn github_save_rules(
    github: State<'_, GitHubService>,
    projects: State<'_, ProjectState>,
    request: SaveRulesRequest,
) -> Result<GitHubStatus, BoundaryError> {
    github
        .save_project_rules(
            selected_project_root(&projects)?,
            projects.inner().clone(),
            request,
        )
        .await
}

#[tauri::command]
pub async fn github_sync_project(
    github: State<'_, GitHubService>,
    projects: State<'_, ProjectState>,
    request: SyncProjectRequest,
) -> Result<SyncResult, BoundaryError> {
    github
        .sync_project(
            selected_project_root(&projects)?,
            projects.inner().clone(),
            request,
        )
        .await
}

#[tauri::command]
pub async fn github_unlink_project(
    github: State<'_, GitHubService>,
    projects: State<'_, ProjectState>,
) -> Result<GitHubStatus, BoundaryError> {
    github
        .unlink_project(selected_project_root(&projects)?, projects.inner().clone())
        .await
}

#[tauri::command]
pub async fn github_disconnect(
    github: State<'_, GitHubService>,
) -> Result<GitHubStatus, BoundaryError> {
    github.disconnect().await?;
    github.status(None).await
}

#[tauri::command]
pub fn github_set_editor_dirty(github: State<'_, GitHubService>, dirty: bool) {
    github.set_editor_dirty(dirty);
}

fn selected_project_root(projects: &ProjectState) -> Result<std::path::PathBuf, BoundaryError> {
    projects
        .root()?
        .ok_or_else(|| BoundaryError::project("project_required", "Choose a Typst project first."))
}
