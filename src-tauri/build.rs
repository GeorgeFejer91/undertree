const COMMANDS: &[&str] = &[
    "agent_annotations",
    "bibliography_entries",
    "choose_project",
    "compile_document",
    "compiler_info",
    "current_project",
    "create_bibliography",
    "export_pdf",
    "export_typst_to_latex",
    "github_begin_auth",
    "github_copy_device_code",
    "github_clone_repository",
    "github_create_repository",
    "github_disconnect",
    "github_link_project",
    "github_list_repositories",
    "github_open_auth_page",
    "github_poll_auth",
    "github_save_rules",
    "github_set_editor_dirty",
    "github_status",
    "github_sync_project",
    "github_unlink_project",
    "import_latex_project",
    "open_document",
    "open_recent_project",
    "recent_projects",
    "refresh_project",
    "reveal_exported_pdf",
    "remote_control_claim",
    "remote_control_complete",
    "remote_control_export_pdf",
    "remote_control_open_project",
    "remote_control_prepare_agent_replace",
    "remote_control_reveal_pdf",
    "remote_control_ready",
    "save_document",
    "set_agent_annotations",
];

fn main() {
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .app_manifest(tauri_build::AppManifest::new().commands(COMMANDS)),
    )
    .expect("failed to prepare the UnderTree Tauri application");
}
