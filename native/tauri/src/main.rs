#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
use std::sync::Arc;
use tauri::Manager;
use tauri_plugin_dialog::DialogExt;
use undertree_review::service::Service;
use undertree_review::{Error, Operation};

#[tauri::command]
async fn review_action(
    state: tauri::State<'_, Arc<Service>>,
    operation: Operation,
) -> std::result::Result<serde_json::Value, Error> {
    state.inner().dispatch(operation).await
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
                    root: root.to_string_lossy().into(),
                })
                .await
        }
        None => Ok(serde_json::Value::Null),
    }
}

fn main() {
    let result = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let state = app.path().app_data_dir()?.join("review");
            app.manage(Service::new(state)?);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![review_action, choose_project])
        .build(tauri::generate_context!());
    match result {
        Ok(app) => app.run(|app, event| {
            if matches!(event, tauri::RunEvent::Exit) {
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
        Err(_) => {
            eprintln!("UnderTree could not start its native window. Check the system WebView installation.");
            std::process::exit(1);
        }
    }
}
