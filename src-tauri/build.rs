const COMMANDS: &[&str] = &[
    "choose_project",
    "compile_document",
    "compiler_info",
    "open_document",
    "save_document",
];

fn main() {
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .app_manifest(tauri_build::AppManifest::new().commands(COMMANDS)),
    )
    .expect("failed to prepare the UnderTree Tauri application");
}
