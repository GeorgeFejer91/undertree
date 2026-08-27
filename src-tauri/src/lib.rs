mod commands;
mod compiler;
mod error;
mod project;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(compiler::CompilerAssets::load())
        .manage(project::ProjectState::default())
        .invoke_handler(tauri::generate_handler![
            commands::choose_project,
            commands::compile_document,
            commands::compiler_info,
            commands::open_document,
            commands::save_document
        ])
        .run(tauri::generate_context!())
        .expect("UnderTree failed to start");
}
