mod agent_annotations;
mod cli;
mod commands;
mod compiler;
mod error;
mod git;
mod github;
mod latex;
mod markdown;
mod pdf;
mod project;
mod remote_control;
mod review;

use tauri::Manager;

pub fn entrypoint() -> std::process::ExitCode {
    let arguments: Vec<_> = std::env::args_os().skip(1).collect();
    if let Some(project) = cli::gui_project_request(&arguments) {
        return match project {
            Ok(project) => {
                if let Some(exit_code) = cli::try_open_running(&project) {
                    return exit_code;
                }
                match run_with_project(Some(project)) {
                    Ok(()) => std::process::ExitCode::SUCCESS,
                    Err(error) => {
                        eprintln!("UnderTree error [{}]: {}", error.code, error.message);
                        std::process::ExitCode::FAILURE
                    }
                }
            }
            Err(exit_code) => exit_code,
        };
    }
    if let Some(exit_code) = cli::try_run(arguments) {
        exit_code
    } else {
        run();
        std::process::ExitCode::SUCCESS
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    run_with_project(None).expect("UnderTree failed to start");
}

fn run_with_project(
    startup_project: Option<cli::GuiProjectRequest>,
) -> Result<(), error::BoundaryError> {
    git::configure_transport_limits().expect("UnderTree failed to configure Git transport limits");
    let projects = project::ProjectState::default();
    let agent_annotations = agent_annotations::AgentAnnotationService::default();
    let github = github::GitHubService::new();
    let remote_control = remote_control::RemoteControlState::default();
    let review = review::ReviewService::default();
    let scheduler_projects = projects.clone();
    let setup_projects = projects.clone();
    let scheduler_github = github.clone();
    let setup_remote_control = remote_control.clone();
    let mut builder = tauri::Builder::default();
    #[cfg(desktop)]
    {
        // This must be the first registered plugin so credential refreshes and
        // project mutations cannot race in two UnderTree processes.
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, arguments, cwd| {
            if let Some(request) = cli::forwarded_open_request(&arguments, &cwd) {
                app.state::<remote_control::RemoteControlState>()
                    .enqueue_forwarded(app, request);
            }
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        }));
    }
    let app = builder
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(compiler::CompilerAssets::load())
        .manage(pdf::PdfExportState::default())
        .manage(projects)
        .manage(agent_annotations)
        .manage(github)
        .manage(remote_control)
        .manage(review)
        .setup(move |app| {
            let recent_projects_path = app
                .path()
                .app_config_dir()
                .map_err(|error| std::io::Error::other(error.to_string()))?
                .join("recent-projects.json");
            setup_projects
                .configure_recent_projects(recent_projects_path)
                .map_err(|error| std::io::Error::other(error.message))?;
            if let Some(project) = startup_project {
                setup_projects
                    .select_with_preferred(project.root, project.preferred.as_deref())
                    .map_err(|error| std::io::Error::other(error.message))?;
            }
            let remote_server = remote_control::start_server(
                app.handle().clone(),
                setup_remote_control,
                app.path()
                    .app_config_dir()
                    .map_err(|error| std::io::Error::other(error.to_string()))?,
            )
            .map_err(|error| std::io::Error::other(error.message))?;
            app.manage(remote_server);
            scheduler_github.start_scheduler(app.handle().clone(), scheduler_projects.clone());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::agent_annotations,
            commands::bibliography_entries,
            commands::choose_project,
            commands::compile_document,
            commands::compiler_info,
            commands::current_project,
            commands::create_bibliography,
            commands::export_pdf,
            commands::export_typst_to_latex,
            commands::github_begin_auth,
            commands::github_copy_device_code,
            commands::github_clone_repository,
            commands::github_create_repository,
            commands::github_disconnect,
            commands::github_link_project,
            commands::github_list_repositories,
            commands::github_open_auth_page,
            commands::github_poll_auth,
            commands::github_save_rules,
            commands::github_set_editor_dirty,
            commands::github_status,
            commands::github_sync_project,
            commands::github_unlink_project,
            commands::import_latex_project,
            commands::open_document,
            commands::open_recent_project,
            commands::recent_projects,
            commands::refresh_project,
            commands::review_state,
            commands::review_upsert_mark,
            commands::review_remove_mark,
            commands::review_create_proposal,
            commands::review_add_comment,
            commands::review_decide,
            commands::reveal_exported_pdf,
            commands::save_document,
            commands::set_agent_annotations,
            remote_control::remote_control_claim,
            remote_control::remote_control_complete,
            remote_control::remote_control_export_pdf,
            remote_control::remote_control_open_project,
            remote_control::remote_control_prepare_agent_replace,
            remote_control::remote_control_reveal_pdf,
            remote_control::remote_control_ready
        ])
        .build(tauri::generate_context!())
        .map_err(|_| error::BoundaryError::internal())?;
    app.run(|app, event| {
        if matches!(event, tauri::RunEvent::Exit)
            && let Some(server) = app.try_state::<remote_control::RemoteControlServer>()
        {
            server.shutdown();
        }
    });
    Ok(())
}
