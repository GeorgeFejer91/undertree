use super::*;
use crate::service::editor::EditorOperation;

fn fixture() -> (tempfile::TempDir, Arc<Service>, Project, String) {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("project");
    fs::create_dir(&root).unwrap();
    let service = Service::new(temp.path().join("state")).unwrap();
    let project = serde_json::from_value(
        service
            .local(Operation::AddProject {
                root: root.to_str().unwrap().into(),
            })
            .unwrap(),
    )
    .unwrap();
    let owner = new_owner(&service);
    (temp, service, project, owner)
}
fn new_owner(service: &Service) -> String {
    let connected = service.connect_native_editor("main").unwrap();
    service
        .native_editor_owner("main", connected["ownerId"].as_str().unwrap())
        .unwrap()
}
async fn prepare(service: &Arc<Service>, owner: &str, project: &Project) -> Value {
    service
        .prepare_native_project_export(owner, &project.id)
        .await
        .unwrap()
}
async fn write(service: &Arc<Service>, owner: &str, info: &Value, path: Option<PathBuf>) -> Value {
    let request = Uuid::new_v4().to_string();
    assert_eq!(
        service
            .begin_native_project_export(owner, info["exportId"].as_str().unwrap(), &request)
            .unwrap()["started"],
        true
    );
    service
        .finish_native_project_export(owner, &request, path)
        .await
        .unwrap()
}
fn archive_bytes(path: &Path, name: &str) -> Vec<u8> {
    let mut archive = zip::ZipArchive::new(fs::File::open(path).unwrap()).unwrap();
    let mut bytes = Vec::new();
    archive
        .by_name(name)
        .unwrap()
        .read_to_end(&mut bytes)
        .unwrap();
    bytes
}

#[tokio::test]
async fn saved_export_preserves_binary_hidden_empty_and_opaque_review_without_saving_dirty_buffers()
{
    let (temp, service, project, owner) = fixture();
    fs::write(project.root.join("main.typ"), "= Saved\n").unwrap();
    fs::write(
        project.root.join("main.typ.undertree-review.json"),
        [255, 0, 129],
    )
    .unwrap();
    fs::write(
        project.root.join("main.typ.import-report.json"),
        "{invalid opaque report",
    )
    .unwrap();
    fs::write(
        project.root.join("orphan.typ.undertree-review.json"),
        "orphan protection",
    )
    .unwrap();
    fs::write(project.root.join(".gitignore"), "build/\n").unwrap();
    fs::write(project.root.join("image.png"), [0, 255, 128, 0]).unwrap();
    fs::create_dir(project.root.join("empty")).unwrap();
    service
        .local(Operation::SetMainDocument {
            project: project.id.clone(),
            path: "main.typ".into(),
        })
        .unwrap();
    service
        .editor(
            &owner,
            EditorOperation::EditorRegister {
                project: project.id.clone(),
                path: "main.typ".into(),
                source_epoch: 0,
                expected_root: None,
                generation: 3,
                revision: digest("= Saved\n"),
                content_digest: digest("unsaved private buffer"),
                dirty: true,
                composing: true,
                conflict: true,
            },
        )
        .await
        .unwrap();
    let registry = fs::read(service.state.join("projects.json")).unwrap();
    let info = prepare(&service, &owner, &service.project(&project.id).unwrap()).await;
    assert_eq!(info["entries"], 7);
    assert_eq!(info["policy"], "saved-only");
    assert!(fs::read_dir(temp.path())
        .unwrap()
        .all(|entry| entry.unwrap().file_name() != "out.zip"));
    let path = temp.path().join("out.zip");
    let result = write(&service, &owner, &info, Some(path.clone())).await;
    assert_eq!(result["status"], "exported");
    assert_eq!(archive_bytes(&path, "main.typ"), b"= Saved\n");
    assert_eq!(archive_bytes(&path, "image.png"), [0, 255, 128, 0]);
    assert_eq!(
        archive_bytes(&path, "main.typ.undertree-review.json"),
        [255, 0, 129]
    );
    assert_eq!(
        archive_bytes(&path, "orphan.typ.undertree-review.json"),
        b"orphan protection"
    );
    assert_eq!(
        archive_bytes(&path, "main.typ.import-report.json"),
        b"{invalid opaque report"
    );
    assert_eq!(archive_bytes(&path, ".gitignore"), b"build/\n");
    let mut archive = zip::ZipArchive::new(fs::File::open(&path).unwrap()).unwrap();
    assert!(archive.by_name("empty/").unwrap().is_dir());
    let comment: Value = serde_json::from_slice(archive.comment()).unwrap();
    assert_eq!(comment["schema"], 1);
    assert_eq!(comment["mainDocument"], "main.typ");
    assert_eq!(comment["snapshotId"], info["snapshotId"]);
    assert_eq!(
        fs::read(service.state.join("projects.json")).unwrap(),
        registry
    );
    assert_eq!(
        fs::read(project.root.join("main.typ")).unwrap(),
        b"= Saved\n"
    );
    let (hash, bytes) = hash_stream(&mut fs::File::open(path).unwrap(), MAX_ZIP, None).unwrap();
    assert_eq!(json!(hash), info["sha256"]);
    assert_eq!(json!(bytes), info["bytes"]);
    assert!(lock(&service.shared).unwrap().is_empty());
}

#[tokio::test]
async fn duplicate_begin_finish_status_and_cancel_barrier_never_replay_output() {
    let (temp, service, project, owner) = fixture();
    fs::write(project.root.join("a.txt"), "saved").unwrap();
    let info = prepare(&service, &owner, &project).await;
    let export = info["exportId"].as_str().unwrap();
    let request = Uuid::new_v4().to_string();
    let first = service
        .begin_native_project_export(&owner, export, &request)
        .unwrap();
    assert_eq!(first["started"], true);
    assert_eq!(first["receipt"]["fileName"], info["fileName"]);
    assert_eq!(
        service
            .begin_native_project_export(&owner, export, &request)
            .unwrap(),
        json!({"started":false,"receipt":first["receipt"]})
    );
    assert_eq!(
        service
            .export_as(
                CallerContext::Local,
                &owner,
                ExportOperation::ExportCancel {
                    export_id: export.into()
                }
            )
            .await
            .unwrap_err()
            .code,
        "busy"
    );
    let result = service
        .finish_native_project_export(&owner, &request, Some(temp.path().join("one.zip")))
        .await
        .unwrap();
    assert_eq!(
        service
            .finish_native_project_export(&owner, &request, Some(temp.path().join("two.zip")))
            .await
            .unwrap(),
        result
    );
    assert!(!temp.path().join("two.zip").exists());
    assert_eq!(
        service
            .export_as(
                CallerContext::Local,
                &owner,
                ExportOperation::ExportStatus {
                    request_id: request
                }
            )
            .await
            .unwrap(),
        result
    );
    let next = prepare(&service, &owner, &project).await;
    let next_id = next["exportId"].as_str().unwrap();
    let delayed = Uuid::new_v4().to_string();
    assert_eq!(
        service
            .export_as(
                CallerContext::Local,
                &owner,
                ExportOperation::ExportStatus {
                    request_id: delayed.clone()
                }
            )
            .await
            .unwrap()["status"],
        "unknown"
    );
    assert_eq!(
        service
            .export_as(
                CallerContext::Local,
                &owner,
                ExportOperation::ExportCancel {
                    export_id: next_id.into()
                }
            )
            .await
            .unwrap()["cancelled"],
        true
    );
    assert_eq!(
        service
            .begin_native_project_export(&owner, next_id, &delayed)
            .unwrap_err()
            .code,
        "expired_ticket"
    );
}

#[tokio::test]
async fn pending_journal_denial_is_read_only_and_no_metadata_is_adopted() {
    for name in [
        "main.typ.undertree-pending.json",
        "orphan.typ.undertree-pending.json",
    ] {
        let (_temp, service, project, owner) = fixture();
        fs::write(project.root.join("main.typ"), "saved").unwrap();
        fs::write(project.root.join(name), b"{unknown pending}").unwrap();
        let registry = fs::read(service.state.join("projects.json")).unwrap();
        assert_eq!(
            service
                .prepare_native_project_export(&owner, &project.id)
                .await
                .unwrap_err()
                .code,
            "busy"
        );
        assert_eq!(
            fs::read(project.root.join(name)).unwrap(),
            b"{unknown pending}"
        );
        assert_eq!(fs::read(project.root.join("main.typ")).unwrap(), b"saved");
        assert!(!project.root.join("main.typ.undertree-review.json").exists());
        assert_eq!(
            fs::read(service.state.join("projects.json")).unwrap(),
            registry
        );
    }
}

#[tokio::test]
async fn private_state_exclusions_are_explicit_and_ordinary_dotfiles_remain() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("project");
    fs::create_dir(&root).unwrap();
    let state = root.join("ordinary-name-private");
    let service = Service::new(state.clone()).unwrap();
    let project: Project = serde_json::from_value(
        service
            .local(Operation::AddProject {
                root: root.to_str().unwrap().into(),
            })
            .unwrap(),
    )
    .unwrap();
    let owner = new_owner(&service);
    for name in [".git", "build", "node_modules", "For-AI"] {
        fs::create_dir(root.join(name)).unwrap();
        fs::write(root.join(name).join("private.txt"), "excluded").unwrap();
    }
    fs::write(root.join(".project-data"), "hidden input").unwrap();
    fs::write(state.join("secret-token"), "never exported").unwrap();
    let info = prepare(&service, &owner, &project).await;
    assert_eq!(info["entries"], 1);
    assert_eq!(info["exclusions"].as_array().unwrap().len(), 5);
    let path = temp.path().join("safe.zip");
    assert_eq!(
        write(&service, &owner, &info, Some(path.clone())).await["status"],
        "exported"
    );
    let archive = zip::ZipArchive::new(fs::File::open(path).unwrap()).unwrap();
    assert_eq!(archive.len(), 1);
}

#[tokio::test]
async fn observed_source_membership_or_bytes_change_fails_instead_of_partial_success() {
    for add in [false, true] {
        let (_temp, service, project, owner) = fixture();
        fs::write(project.root.join("a.txt"), "before").unwrap();
        let path = project.root.join(if add { "new.txt" } else { "a.txt" });
        lock(&service.project_export).unwrap().before_verify = Some(Box::new(move || {
            fs::write(path, "external change").unwrap()
        }));
        assert_eq!(
            service
                .prepare_native_project_export(&owner, &project.id)
                .await
                .unwrap_err()
                .code,
            "stale"
        );
        assert!(lock(&service.project_export).unwrap().tickets.is_empty());
    }
}

#[tokio::test]
async fn root_replacement_destination_collision_and_staged_tamper_preserve_originals() {
    let (temp, service, project, owner) = fixture();
    fs::write(project.root.join("a.txt"), "saved").unwrap();
    let info = prepare(&service, &owner, &project).await;
    let output = temp.path().join("exists.zip");
    fs::write(&output, "existing").unwrap();
    assert_eq!(
        write(&service, &owner, &info, Some(output.clone())).await["status"],
        "failed"
    );
    assert_eq!(fs::read(&output).unwrap(), b"existing");
    let info = prepare(&service, &owner, &project).await;
    {
        let state = lock(&service.project_export).unwrap();
        let archive = state.tickets[info["exportId"].as_str().unwrap()]
            .archive
            .as_ref()
            .unwrap();
        fs::write(archive.directory.path().join("project.zip"), "tampered").unwrap();
    }
    assert_eq!(
        write(
            &service,
            &owner,
            &info,
            Some(temp.path().join("tampered.zip"))
        )
        .await["status"],
        "failed"
    );
    assert!(!temp.path().join("tampered.zip").exists());
    let info = prepare(&service, &owner, &project).await;
    fs::rename(&project.root, temp.path().join("old-project")).unwrap();
    fs::create_dir(&project.root).unwrap();
    assert_eq!(
        write(&service, &owner, &info, Some(temp.path().join("root.zip"))).await["status"],
        "failed"
    );
    assert!(!temp.path().join("root.zip").exists());
}

#[tokio::test]
async fn native_owner_retirement_before_publication_and_pending_dialog_completion_cannot_write() {
    let (temp, service, project, owner) = fixture();
    fs::write(project.root.join("a.txt"), "saved").unwrap();
    let info = prepare(&service, &owner, &project).await;
    let cloned = service.clone();
    lock(&service.project_export).unwrap().before_publish = Some(Box::new(move || {
        new_owner(&cloned);
    }));
    assert_eq!(
        write(
            &service,
            &owner,
            &info,
            Some(temp.path().join("retired.zip"))
        )
        .await["status"],
        "failed"
    );
    assert!(!temp.path().join("retired.zip").exists());
    let owner = new_owner(&service);
    let info = prepare(&service, &owner, &project).await;
    let request = Uuid::new_v4().to_string();
    service
        .begin_native_project_export(&owner, info["exportId"].as_str().unwrap(), &request)
        .unwrap();
    let next_owner = new_owner(&service);
    let _new = prepare(&service, &next_owner, &project).await;
    assert_eq!(
        service
            .finish_native_project_export(&owner, &request, Some(temp.path().join("late.zip")))
            .await
            .unwrap()["status"],
        "failed"
    );
    assert!(!temp.path().join("late.zip").exists());
}

#[tokio::test]
async fn permissions_bounds_roles_expiry_and_picker_cancel_are_truthful() {
    let (temp, service, project, owner) = fixture();
    fs::write(project.root.join("a.txt"), "saved").unwrap();
    for caller in [CallerContext::LocalCli, CallerContext::Review] {
        assert_eq!(
            service
                .export_as(
                    caller,
                    &owner,
                    ExportOperation::ExportStatus {
                        request_id: Uuid::new_v4().to_string()
                    }
                )
                .await
                .unwrap_err()
                .code,
            "scope"
        );
    }
    let a = prepare(&service, &owner, &project).await;
    let b = prepare(&service, &owner, &project).await;
    assert_eq!(
        service
            .prepare_native_project_export(&owner, &project.id)
            .await
            .unwrap_err()
            .code,
        "busy"
    );
    let id = a["exportId"].as_str().unwrap();
    lock(&service.project_export)
        .unwrap()
        .tickets
        .get_mut(id)
        .unwrap()
        .expires = 0;
    assert_eq!(
        service
            .begin_native_project_export(&owner, id, &Uuid::new_v4().to_string())
            .unwrap_err()
            .code,
        "expired_ticket"
    );
    assert_eq!(
        write(&service, &owner, &b, None).await["status"],
        "cancelled"
    );
    assert!(fs::read_dir(temp.path()).unwrap().all(|entry| !entry
        .unwrap()
        .path()
        .extension()
        .is_some_and(|extension| extension == "zip")));
    fs::File::create(project.root.join("too-large.bin"))
        .unwrap()
        .set_len(MAX_INPUT + 1)
        .unwrap();
    assert_eq!(
        service
            .prepare_native_project_export(&owner, &project.id)
            .await
            .unwrap_err()
            .code,
        "limit"
    );
}

#[cfg(unix)]
#[tokio::test]
async fn unix_links_non_unicode_names_and_replaced_destination_parent_are_denied_and_exec_bits_preserved(
) {
    use std::os::unix::{
        ffi::OsStringExt,
        fs::{symlink, PermissionsExt},
    };
    for invalid in [0, 1, 2] {
        let (temp, service, project, owner) = fixture();
        let file = project.root.join("a.txt");
        fs::write(&file, "saved").unwrap();
        match invalid {
            0 => symlink(&file, project.root.join("link.txt")).unwrap(),
            1 => {
                fs::write(
                    project.root.join(std::ffi::OsString::from_vec(vec![255])),
                    [1],
                )
                .unwrap();
            }
            _ => {
                fs::write(project.root.join("A.txt"), "collision").unwrap();
            }
        }
        assert!(service
            .prepare_native_project_export(&owner, &project.id)
            .await
            .is_err());
        drop(temp);
    }
    let (temp, service, project, owner) = fixture();
    let script = project.root.join("run.sh");
    fs::write(&script, "#!/bin/sh\n").unwrap();
    fs::set_permissions(&script, fs::Permissions::from_mode(0o755)).unwrap();
    let info = prepare(&service, &owner, &project).await;
    let path = temp.path().join("exec.zip");
    assert_eq!(
        write(&service, &owner, &info, Some(path.clone())).await["status"],
        "exported"
    );
    let mut archive = zip::ZipArchive::new(fs::File::open(path).unwrap()).unwrap();
    assert_eq!(
        archive.by_name("run.sh").unwrap().unix_mode().unwrap() & 0o777,
        0o755
    );
    let parent = temp.path().join("output");
    fs::create_dir(&parent).unwrap();
    let info = prepare(&service, &owner, &project).await;
    let renamed = temp.path().join("old-output");
    let p = parent.clone();
    let old = renamed.clone();
    lock(&service.project_export).unwrap().before_publish = Some(Box::new(move || {
        fs::rename(&p, old).unwrap();
        fs::create_dir(p).unwrap();
    }));
    assert_eq!(
        write(&service, &owner, &info, Some(parent.join("moved.zip"))).await["status"],
        "failed"
    );
    assert!(!parent.join("moved.zip").exists());
    assert!(fs::read_dir(renamed).unwrap().next().is_none());
}

#[tokio::test]
async fn large_binary_input_uses_whole_project_budget_and_empty_project_exports_without_new_files()
{
    let (temp, service, project, owner) = fixture();
    let info = prepare(&service, &owner, &project).await;
    assert_eq!(info["entries"], 0);
    let empty = temp.path().join("empty.zip");
    assert_eq!(
        write(&service, &owner, &info, Some(empty.clone())).await["status"],
        "exported"
    );
    assert_eq!(
        zip::ZipArchive::new(fs::File::open(empty).unwrap())
            .unwrap()
            .len(),
        0
    );
    let asset = project.root.join("large.bin");
    fs::File::create(&asset)
        .unwrap()
        .set_len(20 * 1024 * 1024)
        .unwrap();
    let info = prepare(&service, &owner, &project).await;
    assert_eq!(info["entries"], 1);
    let output = temp.path().join("large.zip");
    assert_eq!(
        write(&service, &owner, &info, Some(output.clone())).await["status"],
        "exported"
    );
    let mut archive = zip::ZipArchive::new(fs::File::open(output).unwrap()).unwrap();
    assert_eq!(
        archive.by_name("large.bin").unwrap().size(),
        20 * 1024 * 1024
    );
    assert!(!project
        .root
        .join("large.bin.undertree-review.json")
        .exists());
}

#[tokio::test]
async fn all_inventory_budgets_fail_instead_of_silently_truncating_or_losing_regular_assets() {
    let (_temp, service, project, owner) = fixture();
    fs::write(project.root.join("build"), [255, 0]).unwrap();
    let root = project_tree::open_root(&project.root).unwrap();
    for inventory in [
        Inventory {
            visited: MAX_ENTRIES,
            ..Inventory::new()
        },
        Inventory {
            directories: MAX_DIRECTORIES,
            ..Inventory::new()
        },
        Inventory {
            metadata: MAX_METADATA,
            ..Inventory::new()
        },
    ] {
        let mut inventory = inventory;
        assert_eq!(
            inventory
                .walk(&root, &root, "", 0, &project.root, &service.state)
                .unwrap_err()
                .code,
            "limit"
        );
    }
    let info = prepare(&service, &owner, &project).await;
    assert_eq!(info["entries"], 1);
    service
        .export_as(
            CallerContext::Local,
            &owner,
            ExportOperation::ExportCancel {
                export_id: info["exportId"].as_str().unwrap().into(),
            },
        )
        .await
        .unwrap();
    let mut path = project.root.clone();
    for _ in 0..33 {
        path = path.join("a");
        fs::create_dir(&path).unwrap();
    }
    assert!(service
        .prepare_native_project_export(&owner, &project.id)
        .await
        .is_err());
}

#[tokio::test]
async fn destination_appearing_during_copy_is_preserved_and_prepared_bytes_remain_pinned() {
    let (temp, service, project, owner) = fixture();
    fs::write(project.root.join("a.txt"), "captured").unwrap();
    let info = prepare(&service, &owner, &project).await;
    fs::write(project.root.join("a.txt"), "newer saved text").unwrap();
    let output = temp.path().join("pinned.zip");
    assert_eq!(
        write(&service, &owner, &info, Some(output.clone())).await["status"],
        "exported"
    );
    assert_eq!(archive_bytes(&output, "a.txt"), b"captured");
    let info = prepare(&service, &owner, &project).await;
    let output = temp.path().join("collision.zip");
    let cloned = output.clone();
    lock(&service.project_export).unwrap().before_publish = Some(Box::new(move || {
        fs::write(cloned, "external destination").unwrap()
    }));
    assert_eq!(
        write(&service, &owner, &info, Some(output.clone())).await["status"],
        "failed"
    );
    assert_eq!(fs::read(output).unwrap(), b"external destination");
    assert_eq!(
        fs::read(project.root.join("a.txt")).unwrap(),
        b"newer saved text"
    );
}

#[tokio::test]
async fn chosen_unicode_destination_leaf_round_trips_without_exposing_absolute_path() {
    let (temp, service, project, owner) = fixture();
    fs::write(project.root.join("a.txt"), "saved").unwrap();
    let info = prepare(&service, &owner, &project).await;
    let path = temp.path().join("Überarbeitete Fassung.zip");
    let result = write(&service, &owner, &info, Some(path.clone())).await;
    assert_eq!(result["status"], "exported");
    assert_eq!(result["destinationName"], "Überarbeitete Fassung.zip");
    assert_eq!(result["fileName"], info["fileName"]);
    assert!(!result.to_string().contains(temp.path().to_str().unwrap()));
    assert!(path.is_file());
    let info = prepare(&service, &owner, &project).await;
    let invalid = temp.path().join("invalid\\name.zip");
    assert_eq!(
        write(&service, &owner, &info, Some(invalid.clone())).await["status"],
        "failed"
    );
    assert!(!invalid.exists());
}

#[tokio::test]
async fn rooted_export_admission_rejects_retired_owner_and_same_byte_root_replacement_before_effects(
) {
    let (temp, service, project, _) = fixture();
    fs::write(project.root.join("main.typ"), "= Saved").unwrap();
    let connected = service.connect_native_editor("main").unwrap();
    let owner_id = connected["ownerId"].as_str().unwrap();
    let root = source_files::RootedRoot::observe(&project.root).unwrap();
    let before = fs::read(service.state.join("projects.json")).unwrap();
    fs::rename(&project.root, temp.path().join("old-root")).unwrap();
    fs::create_dir(&project.root).unwrap();
    fs::write(project.root.join("main.typ"), "= Saved").unwrap();
    assert_eq!(
        service
            .prepare_native_project_export_rooted("main", owner_id, &project.id, root)
            .await
            .unwrap_err()
            .code,
        "stale_root"
    );
    assert!(lock(&service.project_export).unwrap().tickets.is_empty());
    assert!(fs::read_dir(&service.state).unwrap().all(|entry| !entry
        .unwrap()
        .file_name()
        .to_string_lossy()
        .starts_with(".undertree-export-")));
    let current = source_files::RootedRoot::observe(&project.root).unwrap();
    service.connect_native_editor("main").unwrap();
    assert_eq!(
        service
            .prepare_native_project_export_rooted("main", owner_id, &project.id, current)
            .await
            .unwrap_err()
            .code,
        "stale_session"
    );
    assert!(lock(&service.project_export).unwrap().tickets.is_empty());
    assert_eq!(
        fs::read(service.state.join("projects.json")).unwrap(),
        before
    );
    let connected = service.connect_native_editor("main").unwrap();
    let ready = service
        .prepare_native_project_export_rooted(
            "main",
            connected["ownerId"].as_str().unwrap(),
            &project.id,
            current,
        )
        .await
        .unwrap();
    assert_eq!(ready["expectedRoot"], json!(current));
}
