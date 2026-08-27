use serde::Serialize;
use tauri::{AppHandle, State};
use tauri_plugin_dialog::DialogExt;

use crate::compiler::{CompileRequest, CompileResponse, CompilerAssets};
use crate::error::BoundaryError;
use crate::project::{DocumentData, ProjectSnapshot, ProjectState, SaveRequest, SaveResponse};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CompilerInfo {
    engine: &'static str,
    engine_version: &'static str,
    mode: &'static str,
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
