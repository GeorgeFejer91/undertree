#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
use std::sync::Arc;
use tauri::Manager;
use tauri_plugin_dialog::DialogExt;
use undertree_review::capabilities::CallerContext;
use undertree_review::instance::LocalInstance;
use undertree_review::service::app_control::ControlOperation;
use undertree_review::service::editor::EditorOperation;
use undertree_review::service::file_import::ImportOperation;
use undertree_review::service::project_export::ExportOperation;
use undertree_review::service::{HistoryQuery, HistoryReply, Service};
use undertree_review::word_count_native::{WordCountReply, WordCountRequest, WordCountWorker};
use undertree_review::{Error, Operation, RootObservation, SourceRequest};

#[tauri::command]
async fn review_action(
    window: tauri::WebviewWindow,
    owner_id: String,
    state: tauri::State<'_, Arc<Service>>,
    operation: SourceRequest,
    compile_diagnostics_version: Option<u8>,
) -> std::result::Result<serde_json::Value, Error> {
    if let Some(version) = compile_diagnostics_version {
        if version != 1 {
            return Err(Error::new("format", "Use compiler diagnostics version 1."));
        }
        return state
            .inner()
            .compile_typst_native_report(window.label(), &owner_id, operation)
            .await;
    }
    state
        .inner()
        .dispatch_native_source(window.label(), &owner_id, operation)
        .await
}

#[tauri::command]
async fn word_count_typst_text(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, Arc<Service>>,
    worker: tauri::State<'_, WordCountWorker>,
    request: WordCountRequest,
) -> std::result::Result<WordCountReply, Error> {
    worker.analyze(state.inner(), window.label(), request).await
}

#[tauri::command]
async fn history_query(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, Arc<Service>>,
    owner_id: String,
    query: HistoryQuery,
) -> std::result::Result<HistoryReply, Error> {
    state
        .inner()
        .history_query_native(window.label(), &owner_id, query)
        .await
}

#[tauri::command]
fn editor_connect(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, Arc<Service>>,
) -> std::result::Result<serde_json::Value, Error> {
    if window.label() != "main" {
        return Err(Error::new(
            "forbidden",
            "Editor coordination requires the local UnderTree window.",
        ));
    }
    state.inner().connect_native_editor(window.label())
}

#[tauri::command]
async fn editor_operation(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, Arc<Service>>,
    owner_id: String,
    operation: EditorOperation,
) -> std::result::Result<serde_json::Value, Error> {
    if window.label() != "main" {
        return Err(Error::new(
            "forbidden",
            "Editor coordination requires the local UnderTree window.",
        ));
    }
    state
        .inner()
        .editor_native(window.label(), &owner_id, operation)
        .await
}

#[tauri::command]
async fn control_operation(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, Arc<Service>>,
    owner_id: String,
    operation: ControlOperation,
) -> std::result::Result<serde_json::Value, Error> {
    if window.label() != "main" {
        return Err(Error::new(
            "forbidden",
            "App control coordination requires the local UnderTree window.",
        ));
    }
    let owner = state
        .inner()
        .native_editor_owner(window.label(), &owner_id)?;
    state
        .inner()
        .control_as(CallerContext::Local, &owner, operation)
        .await
}

#[tauri::command]
async fn choose_project(
    app: tauri::AppHandle,
    state: tauri::State<'_, Arc<Service>>,
) -> std::result::Result<serde_json::Value, Error> {
    let folder =
        tauri::async_runtime::spawn_blocking(move || app.dialog().file().blocking_pick_folder())
            .await
            .map_err(|_| Error::new("dialog", "The folder picker stopped."))?;
    match folder {
        Some(folder) => {
            let root = folder
                .into_path()
                .map_err(|_| Error::new("path", "Choose a local project folder."))?;
            state
                .inner()
                .dispatch(Operation::AddProject {
                    root: root
                        .to_str()
                        .ok_or_else(|| {
                            Error::new("path", "Choose a project folder with a Unicode path.")
                        })?
                        .into(),
                })
                .await
        }
        None => Ok(serde_json::Value::Null),
    }
}

#[tauri::command]
async fn import_operation(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, Arc<Service>>,
    owner_id: String,
    operation: ImportOperation,
) -> std::result::Result<serde_json::Value, Error> {
    if window.label() != "main" {
        return Err(Error::new(
            "scope",
            "File import requires the local UnderTree window.",
        ));
    }
    let owner = state
        .inner()
        .native_editor_owner(window.label(), &owner_id)?;
    state
        .inner()
        .import_as(CallerContext::Local, &owner, operation)
        .await
}

#[tauri::command]
async fn choose_import_files(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    state: tauri::State<'_, Arc<Service>>,
    owner_id: String,
    project: String,
    parent: String,
    expected_root: RootObservation,
) -> std::result::Result<serde_json::Value, Error> {
    if window.label() != "main" {
        return Err(Error::new(
            "scope",
            "File import requires the local UnderTree window.",
        ));
    }
    let owner = state
        .inner()
        .native_editor_owner(window.label(), &owner_id)?;
    let service = state.inner().clone();
    let window_label = window.label().to_owned();
    let selection = tauri::async_runtime::spawn_blocking(move || {
        service.begin_native_import_rooted(
            &window_label,
            &owner_id,
            &project,
            &parent,
            expected_root,
        )
    })
    .await
    .map_err(|_| Error::new("import", "The import destination check stopped."))??;
    let selection_id = selection["selectionId"]
        .as_str()
        .ok_or_else(|| Error::new("state", "The import selection could not be prepared."))?
        .to_owned();
    let picked = tauri::async_runtime::spawn_blocking(move || {
        app.dialog()
            .file()
            .set_title("Import files")
            .blocking_pick_files()
    })
    .await;
    let paths = match picked {
        Ok(Some(files)) => files
            .into_iter()
            .map(|file| {
                file.into_path()
                    .map_err(|_| Error::new("path", "Choose regular local files to import."))
            })
            .collect::<std::result::Result<Vec<_>, _>>(),
        Ok(None) => {
            state
                .inner()
                .import_as(
                    CallerContext::Local,
                    &owner,
                    ImportOperation::ImportCancel { selection_id },
                )
                .await?;
            return Ok(serde_json::Value::Null);
        }
        Err(_) => Err(Error::new("dialog", "The import file picker stopped.")),
    };
    match paths {
        Ok(paths) => {
            state
                .inner()
                .stage_native_import(&owner, &selection_id, paths)
                .await
        }
        Err(error) => {
            let _ = state
                .inner()
                .import_as(
                    CallerContext::Local,
                    &owner,
                    ImportOperation::ImportCancel { selection_id },
                )
                .await;
            Err(error)
        }
    }
}

#[tauri::command]
async fn prepare_project_export(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, Arc<Service>>,
    owner_id: String,
    project: String,
    expected_root: RootObservation,
) -> std::result::Result<serde_json::Value, Error> {
    if window.label() != "main" {
        return Err(Error::new(
            "scope",
            "Project export requires the local UnderTree window.",
        ));
    }
    state
        .inner()
        .prepare_native_project_export_rooted(window.label(), &owner_id, &project, expected_root)
        .await
}

#[tauri::command]
async fn project_export_operation(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, Arc<Service>>,
    owner_id: String,
    operation: ExportOperation,
) -> std::result::Result<serde_json::Value, Error> {
    if window.label() != "main" {
        return Err(Error::new(
            "scope",
            "Project export requires the local UnderTree window.",
        ));
    }
    let owner = state
        .inner()
        .native_editor_owner(window.label(), &owner_id)?;
    state
        .inner()
        .export_as(CallerContext::Local, &owner, operation)
        .await
}

#[tauri::command]
async fn choose_project_export_destination(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    state: tauri::State<'_, Arc<Service>>,
    owner_id: String,
    export_id: String,
    request_id: String,
) -> std::result::Result<serde_json::Value, Error> {
    if window.label() != "main" {
        return Err(Error::new(
            "scope",
            "Project export requires the local UnderTree window.",
        ));
    }
    let owner = state
        .inner()
        .native_editor_owner(window.label(), &owner_id)?;
    let service = state.inner().clone();
    let export_owner = owner.clone();
    let export_request = request_id.clone();
    let started = tauri::async_runtime::spawn_blocking(move || {
        service.begin_native_project_export(&export_owner, &export_id, &export_request)
    })
    .await
    .map_err(|_| {
        Error::new(
            "outcome_unknown",
            "The export response was lost. Check its request status.",
        )
    })??;
    if started["started"] != true {
        return Ok(started["receipt"].clone());
    }
    let Some(file_name) = started["receipt"]["fileName"].as_str().map(str::to_owned) else {
        let _ = state
            .inner()
            .finish_native_project_export(&owner, &request_id, None)
            .await;
        return Err(Error::new(
            "state",
            "The export filename could not be prepared.",
        ));
    };
    let picked = tauri::async_runtime::spawn_blocking(move || {
        app.dialog()
            .file()
            .set_title("Export saved project")
            .set_file_name(file_name)
            .add_filter("ZIP archive", &["zip"])
            .blocking_save_file()
    })
    .await;
    match picked {
        Ok(Some(file)) => match file.into_path() {
            Ok(path) => {
                state
                    .inner()
                    .finish_native_project_export(&owner, &request_id, Some(path))
                    .await
            }
            Err(_) => {
                let _ = state
                    .inner()
                    .finish_native_project_export(&owner, &request_id, None)
                    .await;
                Err(Error::new(
                    "path",
                    "Choose a local destination for the project ZIP.",
                ))
            }
        },
        Ok(None) => {
            state
                .inner()
                .finish_native_project_export(&owner, &request_id, None)
                .await
        }
        Err(_) => {
            let _ = state
                .inner()
                .finish_native_project_export(&owner, &request_id, None)
                .await;
            Err(Error::new(
                "dialog",
                "The export destination picker stopped.",
            ))
        }
    }
}

fn main() {
    let result = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let state = app.path().app_data_dir()?.join("review");
            let service = Service::new(state)?;
            let instance = tauri::async_runtime::block_on(LocalInstance::start(service.clone()))?;
            let arguments: Vec<_> = std::env::args_os().skip(1).collect();
            // Explicit local launch consent runs before renderer commands can race setup.
            if let Err(error) = tauri::async_runtime::block_on(
                undertree_review::transport::connect_secret_tunnel_on_startup(&service, &arguments),
            ) {
                eprintln!("UnderTree connection setup failed: {}", error.code);
                app.dialog()
                    .message(error.message)
                    .title("UnderTree connection")
                    .show(|_| {});
            }
            app.manage(instance);
            app.manage(service);
            app.manage(WordCountWorker::default());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            review_action,
            word_count_typst_text,
            history_query,
            editor_connect,
            editor_operation,
            control_operation,
            choose_project,
            choose_import_files,
            import_operation,
            prepare_project_export,
            choose_project_export_destination,
            project_export_operation
        ])
        .build(tauri::generate_context!());
    match result {
        Ok(app) => app.run(|app, event| {
            if matches!(event, tauri::RunEvent::Exit) {
                app.state::<LocalInstance>().stop();
                let service = app.state::<Arc<Service>>().inner().clone();
                tauri::async_runtime::block_on(async {
                    let _ = undertree_review::transport::tunnel(
                        &service,
                        false,
                        String::new(),
                        String::new(),
                    )
                    .await;
                });
            }
        }),
        Err(error) => {
            eprintln!("UnderTree could not start: {error}");
            std::process::exit(1);
        }
    }
}
