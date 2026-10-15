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
    let connected = service.connect_native_editor("main").unwrap();
    let owner = service
        .native_editor_owner("main", connected["ownerId"].as_str().unwrap())
        .unwrap();
    (temp, service, project, owner)
}

async fn selection(
    service: &Arc<Service>,
    owner: &str,
    project: &Project,
    parent: &str,
    paths: Vec<PathBuf>,
) -> String {
    let begin = service
        .begin_native_import(owner, &project.id, parent)
        .unwrap();
    let id = begin["selectionId"].as_str().unwrap();
    let ready = service.stage_native_import(owner, id, paths).await.unwrap();
    assert!(ready.to_string().find("sourcePath").is_none());
    id.into()
}

async fn commit(service: &Arc<Service>, owner: &str, id: &str, request: &str) -> Value {
    service
        .import_as(
            CallerContext::Local,
            owner,
            ImportOperation::ImportFiles {
                selection_id: id.into(),
                request_id: request.into(),
            },
        )
        .await
        .unwrap()
}

#[tokio::test]
async fn native_import_captures_exact_sources_assets_and_replays_receipt_without_other_effects() {
    let (temp, service, project, owner) = fixture();
    fs::create_dir(project.root.join("inputs")).unwrap();
    let text = temp.path().join("chapter.typ");
    let image = temp.path().join("picture.png");
    let binary = [0, 255, 128, 10, 13, 0];
    fs::write(&text, "= Imported\n").unwrap();
    fs::write(&image, binary).unwrap();
    let before = service.project(&project.id).unwrap();
    let id = selection(
        &service,
        &owner,
        &project,
        "inputs",
        vec![text.clone(), image],
    )
    .await;
    fs::write(text, "changed after immutable capture").unwrap();
    let request = Uuid::new_v4().to_string();
    let result = commit(&service, &owner, &id, &request).await;
    assert_eq!(result["status"], "committed");
    assert_eq!(result["gitOwnership"], "undertree");
    assert_eq!(
        fs::read(project.root.join("inputs/picture.png")).unwrap(),
        binary
    );
    assert_eq!(
        fs::read_to_string(project.root.join("inputs/chapter.typ")).unwrap(),
        "= Imported\n"
    );
    assert!(project
        .root
        .join("inputs/chapter.typ.undertree-review.json")
        .is_file());
    assert!(!project
        .root
        .join("inputs/picture.png.undertree-review.json")
        .exists());
    let after = service.project(&project.id).unwrap();
    assert_eq!(before.main_document, after.main_document);
    assert_eq!(before.auto_sync, after.auto_sync);
    assert!(lock(&service.shared).unwrap().is_empty());
    assert_eq!(after.pending_revisions["inputs/picture.png"], hash(&binary));
    assert_eq!(
        after.pending_revisions["inputs/chapter.typ"],
        digest("= Imported\n")
    );
    #[cfg(unix)]
    {
        for path in [
            "inputs/chapter.typ",
            "inputs/chapter.typ.undertree-review.json",
            "inputs/picture.png",
        ] {
            assert_eq!(
                cap_fs_ext::MetadataExt::nlink(&fs::metadata(project.root.join(path)).unwrap()),
                1
            );
        }
    }
    assert_eq!(after.pending.len(), 3);
    assert_eq!(commit(&service, &owner, &id, &request).await, result);
    assert_eq!(
        service
            .import_as(
                CallerContext::Local,
                &owner,
                ImportOperation::ImportStatus {
                    request_id: request
                }
            )
            .await
            .unwrap(),
        result
    );
    assert!(service
        .import_as(
            CallerContext::Local,
            &owner,
            ImportOperation::ImportCancel {
                selection_id: id.clone()
            }
        )
        .await
        .is_err());
    assert_eq!(
        service
            .import_as(
                CallerContext::Local,
                &owner,
                ImportOperation::ImportFiles {
                    selection_id: id,
                    request_id: Uuid::new_v4().to_string()
                }
            )
            .await
            .unwrap_err()
            .code,
        "expired_ticket"
    );
}

#[tokio::test]
async fn import_denies_roles_owner_retirement_changed_binding_and_expiry() {
    let (temp, service, project, owner) = fixture();
    let source = temp.path().join("a.png");
    fs::write(&source, [255]).unwrap();
    let id = selection(&service, &owner, &project, "", vec![source.clone()]).await;
    for caller in [CallerContext::Review, CallerContext::LocalCli] {
        assert_eq!(
            service
                .import_as(
                    caller,
                    &owner,
                    ImportOperation::ImportFiles {
                        selection_id: id.clone(),
                        request_id: Uuid::new_v4().to_string()
                    }
                )
                .await
                .unwrap_err()
                .code,
            "scope"
        );
    }
    let request = Uuid::new_v4().to_string();
    lock(&service.file_import)
        .unwrap()
        .selections
        .get_mut(&id)
        .unwrap()
        .expires_at = 0;
    assert_eq!(
        service
            .import_as(
                CallerContext::Local,
                &owner,
                ImportOperation::ImportFiles {
                    selection_id: id,
                    request_id: request
                }
            )
            .await
            .unwrap_err()
            .code,
        "expired_ticket"
    );
    let id = selection(&service, &owner, &project, "", vec![source]).await;
    service.connect_native_editor("main").unwrap();
    assert_eq!(
        service
            .import_as(
                CallerContext::Local,
                &owner,
                ImportOperation::ImportFiles {
                    selection_id: id,
                    request_id: Uuid::new_v4().to_string()
                }
            )
            .await
            .unwrap_err()
            .code,
        "stale_session"
    );
    assert!(!project.root.join("a.png").exists());
}

#[tokio::test]
async fn any_collision_preserves_whole_batch_and_unknown_or_corrupt_adjacent_metadata() {
    for suffix in [
        "",
        ".undertree-review.json",
        ".undertree-pending.json",
        ".import-report.json",
    ] {
        let (temp, service, project, owner) = fixture();
        let a = temp.path().join("a.typ");
        let b = temp.path().join("b.png");
        fs::write(&a, "= Source").unwrap();
        fs::write(&b, [0, 255]).unwrap();
        let id = selection(&service, &owner, &project, "", vec![a, b]).await;
        let collision = project.root.join(format!("b.png{suffix}"));
        fs::write(&collision, [255, 0, 129]).unwrap();
        let registry = fs::read(service.state.join("projects.json")).unwrap();
        let result = commit(&service, &owner, &id, &Uuid::new_v4().to_string()).await;
        assert_eq!(result["status"], "failed");
        assert_eq!(result["error"]["code"], "conflict");
        assert_eq!(fs::read(&collision).unwrap(), [255, 0, 129]);
        assert!(!project.root.join("a.typ").exists());
        assert!(!project.root.join("a.typ.undertree-review.json").exists());
        assert_eq!(
            fs::read(service.state.join("projects.json")).unwrap(),
            registry
        );
        assert!(service.project(&project.id).unwrap().pending.is_empty());
    }
}

#[tokio::test]
async fn registered_missing_destination_buffer_blocks_import_and_reservation_blocks_registration() {
    let (temp, service, project, owner) = fixture();
    fs::write(project.root.join("a.typ"), "old").unwrap();
    service
        .editor(
            &owner,
            EditorOperation::EditorRegister {
                project: project.id.clone(),
                path: "a.typ".into(),
                source_epoch: 0,
                expected_root: None,
                generation: 2,
                revision: digest("old"),
                content_digest: digest("unsaved"),
                dirty: true,
                composing: true,
                conflict: true,
            },
        )
        .await
        .unwrap();
    fs::remove_file(project.root.join("a.typ")).unwrap();
    let source = temp.path().join("a.typ");
    fs::write(&source, "imported").unwrap();
    let id = selection(&service, &owner, &project, "", vec![source]).await;
    let result = commit(&service, &owner, &id, &Uuid::new_v4().to_string()).await;
    assert_eq!(result["error"]["code"], "busy");
    assert!(!project.root.join("a.typ").exists());
    lock(&service.editor)
        .unwrap()
        .reserve_import(&owner, &project.id, &["b.typ".into()])
        .unwrap();
    assert_eq!(
        service
            .editor(
                &owner,
                EditorOperation::EditorRegister {
                    project: project.id.clone(),
                    path: "b.typ".into(),
                    source_epoch: 0,
                    expected_root: None,
                    generation: 0,
                    revision: digest(""),
                    content_digest: digest(""),
                    dirty: false,
                    composing: false,
                    conflict: false
                }
            )
            .await
            .unwrap_err()
            .code,
        "busy"
    );
    lock(&service.editor)
        .unwrap()
        .release_import(&project.id, &["b.typ".into()]);
}

#[tokio::test]
async fn import_limits_names_invalid_text_cancel_and_request_identity_are_bounded() {
    let (temp, service, project, owner) = fixture();
    for name in [
        "../x",
        "hidden/.x",
        ".git",
        "a\\b",
        "CON",
        "a.undertree-review.json",
    ] {
        assert!(service
            .begin_native_import(&owner, &project.id, name)
            .is_err());
    }
    let invalid = temp.path().join("bad.typ");
    fs::write(&invalid, [255]).unwrap();
    let id = service
        .begin_native_import(&owner, &project.id, "")
        .unwrap()["selectionId"]
        .as_str()
        .unwrap()
        .to_owned();
    assert_eq!(
        service
            .stage_native_import(&owner, &id, vec![invalid])
            .await
            .unwrap_err()
            .code,
        "source"
    );
    let big = temp.path().join("big.png");
    fs::File::create(&big)
        .unwrap()
        .set_len(MAX_ASSET as u64 + 1)
        .unwrap();
    let id = service
        .begin_native_import(&owner, &project.id, "")
        .unwrap()["selectionId"]
        .as_str()
        .unwrap()
        .to_owned();
    assert_eq!(
        service
            .stage_native_import(&owner, &id, vec![big])
            .await
            .unwrap_err()
            .code,
        "limit"
    );
    let source = temp.path().join("a.png");
    fs::write(&source, [0, 255]).unwrap();
    let id = selection(&service, &owner, &project, "", vec![source.clone()]).await;
    let other = selection(&service, &owner, &project, "", vec![source]).await;
    assert_eq!(
        service
            .begin_native_import(&owner, &project.id, "")
            .unwrap_err()
            .code,
        "busy"
    );
    let request = Uuid::new_v4().to_string();
    let result = commit(&service, &owner, &id, &request).await;
    assert_eq!(result["status"], "committed");
    assert_eq!(
        service
            .import_as(
                CallerContext::Local,
                &owner,
                ImportOperation::ImportFiles {
                    selection_id: other.clone(),
                    request_id: request
                }
            )
            .await
            .unwrap_err()
            .code,
        "scope"
    );
    assert_eq!(
        service
            .import_as(
                CallerContext::Local,
                &owner,
                ImportOperation::ImportCancel {
                    selection_id: other.clone()
                }
            )
            .await
            .unwrap()["cancelled"],
        true
    );
    assert_eq!(
        service
            .import_as(
                CallerContext::Local,
                &owner,
                ImportOperation::ImportFiles {
                    selection_id: other,
                    request_id: Uuid::new_v4().to_string()
                }
            )
            .await
            .unwrap_err()
            .code,
        "expired_ticket"
    );
    assert_eq!(
        service
            .import_as(
                CallerContext::Local,
                &owner,
                ImportOperation::ImportStatus {
                    request_id: Uuid::new_v4().to_string()
                }
            )
            .await
            .unwrap()["status"],
        "unknown"
    );
}

#[cfg(unix)]
#[tokio::test]
async fn picker_symlinks_non_unicode_names_and_destination_swaps_do_not_mutate_replacements() {
    use std::os::unix::{ffi::OsStringExt, fs::symlink};
    let (temp, service, project, owner) = fixture();
    let source = temp.path().join("a.png");
    fs::write(&source, [0, 255]).unwrap();
    let link = temp.path().join("link.png");
    symlink(&source, &link).unwrap();
    let id = service
        .begin_native_import(&owner, &project.id, "")
        .unwrap()["selectionId"]
        .as_str()
        .unwrap()
        .to_owned();
    assert!(service
        .stage_native_import(&owner, &id, vec![link])
        .await
        .is_err());
    let bad = temp.path().join(std::ffi::OsString::from_vec(vec![
        255, b'.', b'p', b'n', b'g',
    ]));
    fs::write(&bad, [1]).unwrap();
    let id = service
        .begin_native_import(&owner, &project.id, "")
        .unwrap()["selectionId"]
        .as_str()
        .unwrap()
        .to_owned();
    assert_eq!(
        service
            .stage_native_import(&owner, &id, vec![bad])
            .await
            .unwrap_err()
            .code,
        "path"
    );
    fs::create_dir(project.root.join("inputs")).unwrap();
    let id = selection(&service, &owner, &project, "inputs", vec![source.clone()]).await;
    fs::rename(project.root.join("inputs"), project.root.join("old")).unwrap();
    fs::create_dir(project.root.join("inputs")).unwrap();
    assert_eq!(
        commit(&service, &owner, &id, &Uuid::new_v4().to_string()).await["status"],
        "failed"
    );
    assert!(!project.root.join("inputs/a.png").exists());
    assert!(!project.root.join("old/a.png").exists());
    let id = selection(&service, &owner, &project, "", vec![source]).await;
    fs::rename(&project.root, temp.path().join("old-root")).unwrap();
    fs::create_dir(&project.root).unwrap();
    assert_eq!(
        commit(&service, &owner, &id, &Uuid::new_v4().to_string()).await["status"],
        "failed"
    );
    assert!(!project.root.join("a.png").exists());
}

#[tokio::test]
async fn staged_tampering_and_registry_failure_preserve_published_outputs_without_adoption() {
    let (temp, service, project, owner) = fixture();
    let source = temp.path().join("a.typ");
    fs::write(&source, "= Input").unwrap();
    let id = selection(&service, &owner, &project, "", vec![source.clone()]).await;
    {
        let imports = lock(&service.file_import).unwrap();
        let staged = imports.selections[&id].staged.as_ref().unwrap();
        fs::write(staged.0.path().join(&staged.1[0].file_id), "tampered").unwrap();
    }
    assert_eq!(
        commit(&service, &owner, &id, &Uuid::new_v4().to_string()).await["error"]["code"],
        "stale"
    );
    assert!(!project.root.join("a.typ").exists());
    let id = selection(&service, &owner, &project, "", vec![source]).await;
    fs::remove_file(service.state.join("projects.json")).unwrap();
    fs::create_dir(service.state.join("projects.json")).unwrap();
    let result = commit(&service, &owner, &id, &Uuid::new_v4().to_string()).await;
    assert_eq!(result["status"], "outcome_unknown");
    assert_eq!(result["error"]["code"], "outcome_unknown");
    assert_eq!(
        fs::read_to_string(project.root.join("a.typ")).unwrap(),
        "= Input"
    );
    assert!(project.root.join("a.typ.undertree-review.json").is_file());
    assert!(service.project(&project.id).unwrap().pending.is_empty());
}

#[tokio::test]
async fn failed_import_preserves_external_replacement_and_every_published_neighbor() {
    let (temp, service, project, owner) = fixture();
    let source = temp.path().join("a.typ");
    let asset = temp.path().join("b.png");
    let binary = [0, 255, 10, 13];
    fs::write(&source, "= Captured").unwrap();
    fs::write(&asset, binary).unwrap();
    let id = selection(&service, &owner, &project, "", vec![source, asset]).await;
    fs::remove_file(service.state.join("projects.json")).unwrap();
    fs::create_dir(service.state.join("projects.json")).unwrap();
    let (entered, wait_entered) = std::sync::mpsc::channel();
    let (resume, wait_resume) = std::sync::mpsc::channel();
    lock(&service.file_import).unwrap().after_publish = Some(Box::new(move || {
        entered.send(()).unwrap();
        wait_resume
            .recv_timeout(std::time::Duration::from_secs(5))
            .unwrap();
    }));
    let request = Uuid::new_v4().to_string();
    let worker = service.clone();
    let worker_owner = owner.clone();
    let worker_id = id.clone();
    let worker_request = request.clone();
    let thread = std::thread::spawn(move || {
        worker.import_local(
            &worker_owner,
            ImportOperation::ImportFiles {
                selection_id: worker_id,
                request_id: worker_request,
            },
        )
    });
    wait_entered
        .recv_timeout(std::time::Duration::from_secs(5))
        .unwrap();
    let sidecar_bytes = fs::read(project.root.join("a.typ.undertree-review.json")).unwrap();
    let saved_original = temp.path().join("published-original.typ");
    fs::rename(project.root.join("a.typ"), &saved_original).unwrap();
    fs::write(
        project.root.join("a.typ"),
        "External replacement must survive.",
    )
    .unwrap();
    resume.send(()).unwrap();
    let result = thread.join().unwrap().unwrap();
    assert_eq!(result["status"], "outcome_unknown");
    assert_eq!(
        fs::read_to_string(project.root.join("a.typ")).unwrap(),
        "External replacement must survive."
    );
    assert_eq!(fs::read_to_string(saved_original).unwrap(), "= Captured");
    assert_eq!(
        fs::read(project.root.join("a.typ.undertree-review.json")).unwrap(),
        sidecar_bytes
    );
    assert_eq!(fs::read(project.root.join("b.png")).unwrap(), binary);
    assert!(service.project(&project.id).unwrap().pending.is_empty());
    assert_eq!(commit(&service, &owner, &id, &request).await, result);
    assert!(fs::read_dir(&project.root).unwrap().all(|entry| !entry
        .unwrap()
        .file_name()
        .to_string_lossy()
        .starts_with(".undertree-build-import-")));
}

#[tokio::test]
async fn retired_begin_cannot_remove_the_current_pages_staged_selection() {
    let (temp, service, project, owner) = fixture();
    let source = temp.path().join("current.typ");
    fs::write(&source, "= Current page selection").unwrap();
    let (entered, wait_entered) = std::sync::mpsc::channel();
    let (resume, wait_resume) = std::sync::mpsc::channel();
    lock(&service.file_import).unwrap().before_begin_commit = Some(Box::new(move || {
        entered.send(()).unwrap();
        wait_resume
            .recv_timeout(std::time::Duration::from_secs(5))
            .unwrap();
    }));
    let worker = service.clone();
    let worker_project = project.id.clone();
    let thread =
        std::thread::spawn(move || worker.begin_native_import(&owner, &worker_project, ""));
    wait_entered
        .recv_timeout(std::time::Duration::from_secs(5))
        .unwrap();
    let connected = service.connect_native_editor("main").unwrap();
    let current_owner = service
        .native_editor_owner("main", connected["ownerId"].as_str().unwrap())
        .unwrap();
    let current_id = selection(&service, &current_owner, &project, "", vec![source]).await;
    resume.send(()).unwrap();
    assert_eq!(thread.join().unwrap().unwrap_err().code, "stale_session");
    {
        let imports = lock(&service.file_import).unwrap();
        assert_eq!(imports.selections.len(), 1);
        assert_eq!(imports.selections[&current_id].owner, current_owner);
        assert!(imports.selections[&current_id].staged.is_some());
    }
    let result = commit(
        &service,
        &current_owner,
        &current_id,
        &Uuid::new_v4().to_string(),
    )
    .await;
    assert_eq!(result["status"], "committed");
    assert_eq!(
        fs::read_to_string(project.root.join("current.typ")).unwrap(),
        "= Current page selection"
    );
}

#[tokio::test]
async fn binary_checkpoint_is_exact_and_rejects_external_or_changed_assets() {
    let (temp, service, project, owner) = fixture();
    git(&project.root, &["init", "-b", "main"]).await.unwrap();
    git(&project.root, &["config", "user.name", "Import Fixture"])
        .await
        .unwrap();
    git(
        &project.root,
        &["config", "user.email", "fixture@example.invalid"],
    )
    .await
    .unwrap();
    let source = temp.path().join("a.png");
    let bytes = [0, 255, 128, 0, 10];
    fs::write(&source, bytes).unwrap();
    let id = selection(&service, &owner, &project, "", vec![source]).await;
    assert_eq!(
        commit(&service, &owner, &id, &Uuid::new_v4().to_string()).await["status"],
        "committed"
    );
    let current = service.project(&project.id).unwrap();
    fs::write(project.root.join("external.bin"), [255]).unwrap();
    assert_eq!(
        service
            .checkpoint(&current, "main", None)
            .await
            .unwrap_err()
            .code,
        "conflict"
    );
    fs::remove_file(project.root.join("external.bin")).unwrap();
    fs::write(project.root.join("a.png"), [1]).unwrap();
    assert_eq!(
        service
            .checkpoint(&current, "main", None)
            .await
            .unwrap_err()
            .code,
        "conflict"
    );
    fs::write(project.root.join("a.png"), bytes).unwrap();
    let head = service
        .checkpoint(&current, "main", None)
        .await
        .unwrap()
        .0
        .unwrap();
    let output = Command::new("git")
        .args(["show", &format!("{head}:a.png")])
        .current_dir(&project.root)
        .output()
        .await
        .unwrap();
    assert!(output.status.success());
    assert_eq!(output.stdout, bytes);
    assert!(git(&project.root, &["diff", "--cached", "--name-only"])
        .await
        .unwrap()
        .is_empty());
}

#[tokio::test]
async fn retiring_page_during_held_commit_denies_publication_and_releases_all_reservations() {
    let (temp, service, project, owner) = fixture();
    let source = temp.path().join("a.typ");
    fs::write(&source, "= Captured").unwrap();
    let id = selection(&service, &owner, &project, "", vec![source]).await;
    let (entered, wait_entered) = std::sync::mpsc::channel();
    let (resume, wait_resume) = std::sync::mpsc::channel();
    *lock(&service.import_before_publish).unwrap() = Some(Box::new(move || {
        entered.send(()).unwrap();
        wait_resume
            .recv_timeout(std::time::Duration::from_secs(5))
            .unwrap();
    }));
    let worker = service.clone();
    let previous_owner = owner.clone();
    let thread = std::thread::spawn(move || {
        worker.import_local(
            &previous_owner,
            ImportOperation::ImportFiles {
                selection_id: id,
                request_id: Uuid::new_v4().to_string(),
            },
        )
    });
    wait_entered
        .recv_timeout(std::time::Duration::from_secs(5))
        .unwrap();
    service.connect_native_editor("main").unwrap();
    resume.send(()).unwrap();
    let result = thread.join().unwrap().unwrap();
    assert_eq!(result["status"], "failed");
    assert_eq!(result["error"]["code"], "stale_session");
    assert!(fs::read_dir(&project.root).unwrap().next().is_none());
    assert!(service.project(&project.id).unwrap().pending.is_empty());
    let next = service.connect_native_editor("main").unwrap();
    let owner = service
        .native_editor_owner("main", next["ownerId"].as_str().unwrap())
        .unwrap();
    lock(&service.editor)
        .unwrap()
        .reserve_import(&owner, &project.id, &["a.typ".into()])
        .unwrap();
}

#[tokio::test]
async fn delayed_picker_staging_failure_releases_ticket_and_preserves_swapped_destination() {
    let (temp, service, project, owner) = fixture();
    fs::create_dir(project.root.join("inputs")).unwrap();
    let source = temp.path().join("a.png");
    fs::write(&source, [255, 0]).unwrap();
    let id = service
        .begin_native_import(&owner, &project.id, "inputs")
        .unwrap()["selectionId"]
        .as_str()
        .unwrap()
        .to_owned();
    let captured = service.capture_import(std::slice::from_ref(&source));
    fs::rename(project.root.join("inputs"), project.root.join("old")).unwrap();
    fs::create_dir(project.root.join("inputs")).unwrap();
    assert_eq!(
        service
            .finish_import_staging(&owner, &id, captured)
            .unwrap_err()
            .code,
        "path"
    );
    assert!(!lock(&service.file_import)
        .unwrap()
        .selections
        .contains_key(&id));
    let begin = service
        .begin_native_import(&owner, &project.id, "")
        .unwrap();
    service.connect_native_editor("main").unwrap();
    assert_eq!(
        service
            .stage_native_import(&owner, begin["selectionId"].as_str().unwrap(), vec![source])
            .await
            .unwrap_err()
            .code,
        "stale_session"
    );
    assert!(!project.root.join("inputs/a.png").exists());
}

#[tokio::test]
async fn collisions_appearing_after_staging_are_not_adopted_and_batch_bounds_hold() {
    let (temp, service, project, owner) = fixture();
    let source = temp.path().join("a.typ");
    fs::write(&source, "= Captured").unwrap();
    let id = selection(&service, &owner, &project, "", vec![source.clone()]).await;
    let collision = project.root.join("a.typ.undertree-pending.json");
    let clone = collision.clone();
    *lock(&service.import_before_publish).unwrap() =
        Some(Box::new(move || fs::write(clone, [255, 0, 128]).unwrap()));
    let result = commit(&service, &owner, &id, &Uuid::new_v4().to_string()).await;
    assert_eq!(result["error"]["code"], "conflict");
    assert_eq!(fs::read(collision).unwrap(), [255, 0, 128]);
    assert!(!project.root.join("a.typ").exists());
    let id = service
        .begin_native_import(&owner, &project.id, "")
        .unwrap()["selectionId"]
        .as_str()
        .unwrap()
        .to_owned();
    assert_eq!(
        service
            .stage_native_import(&owner, &id, vec![source; MAX_FILES + 1])
            .await
            .unwrap_err()
            .code,
        "limit"
    );
    let id = service
        .begin_native_import(&owner, &project.id, "")
        .unwrap()["selectionId"]
        .as_str()
        .unwrap()
        .to_owned();
    let mut paths = Vec::new();
    for index in 0..3 {
        let path = temp.path().join(format!("big{index}.png"));
        fs::File::create(&path)
            .unwrap()
            .set_len(12 * 1024 * 1024)
            .unwrap();
        paths.push(path);
    }
    assert_eq!(
        service
            .stage_native_import(&owner, &id, paths)
            .await
            .unwrap_err()
            .code,
        "limit"
    );
    assert!(!lock(&service.file_import)
        .unwrap()
        .selections
        .contains_key(&id));
}

#[tokio::test]
async fn unknown_status_then_cancel_prevents_delayed_original_command_from_starting() {
    let (temp, service, project, owner) = fixture();
    let source = temp.path().join("a.png");
    fs::write(&source, [0, 255]).unwrap();
    let id = selection(&service, &owner, &project, "", vec![source]).await;
    let request = Uuid::new_v4().to_string();
    let (resume, wait_resume) = std::sync::mpsc::channel();
    let worker = service.clone();
    let previous_owner = owner.clone();
    let delayed_id = id.clone();
    let delayed_request = request.clone();
    let thread = std::thread::spawn(move || {
        wait_resume
            .recv_timeout(std::time::Duration::from_secs(5))
            .unwrap();
        worker.import_local(
            &previous_owner,
            ImportOperation::ImportFiles {
                selection_id: delayed_id,
                request_id: delayed_request,
            },
        )
    });
    assert_eq!(
        service
            .import_as(
                CallerContext::Local,
                &owner,
                ImportOperation::ImportStatus {
                    request_id: request
                }
            )
            .await
            .unwrap()["status"],
        "unknown"
    );
    assert_eq!(
        service
            .import_as(
                CallerContext::Local,
                &owner,
                ImportOperation::ImportCancel { selection_id: id }
            )
            .await
            .unwrap()["cancelled"],
        true
    );
    resume.send(()).unwrap();
    assert_eq!(thread.join().unwrap().unwrap_err().code, "expired_ticket");
    assert!(fs::read_dir(&project.root).unwrap().next().is_none());
}

#[tokio::test]
async fn staged_import_cannot_cross_retirement_and_fresh_intent_rotates_reused_source() {
    let (temp, service, project, owner) = fixture();
    let input = temp.path().join("main.typ");
    fs::write(&input, "Imported same bytes").unwrap();
    service
        .retire_source_for_test(&project.id, "main.typ")
        .unwrap();
    let old = selection(&service, &owner, &project, "", vec![input.clone()]).await;
    service
        .retire_source_for_test(&project.id, "main.typ")
        .unwrap();
    let before = fs::read(service.state.join("projects.json")).unwrap();
    let denied = commit(&service, &owner, &old, &Uuid::new_v4().to_string()).await;
    assert_eq!(denied["status"], "failed");
    assert_eq!(denied["error"]["code"], "stale_document");
    assert!(!project.root.join("main.typ").exists());
    assert!(!project.root.join("main.typ.undertree-review.json").exists());
    assert_eq!(
        fs::read(service.state.join("projects.json")).unwrap(),
        before
    );
    let fresh = selection(&service, &owner, &project, "", vec![input]).await;
    let imported = commit(&service, &owner, &fresh, &Uuid::new_v4().to_string()).await;
    assert_eq!(imported["status"], "committed");
    assert_eq!(imported["files"][0]["sourceEpoch"], 3);
    assert_eq!(service.source_epoch(&project.id, "main.typ").unwrap(), 3);
    assert_eq!(
        fs::read(project.root.join("main.typ")).unwrap(),
        b"Imported same bytes"
    );
}

#[tokio::test]
async fn reused_import_reserves_all_retired_epochs_before_names_and_preserves_reservation_after_failure(
) {
    for before_publication in [true, false] {
        let (temp, service, project, owner) = fixture();
        let file = project.root.join("main.typ");
        fs::write(&file, "Same bytes").unwrap();
        service
            .retire_source_for_test(&project.id, "main.typ")
            .unwrap();
        let shared = service
            .local_source(SourceRequest {
                operation: Operation::Share {
                    project: project.id.clone(),
                    path: "main.typ".into(),
                    enabled: true,
                },
                source_epoch: 1,
                expected_root: None,
            })
            .unwrap();
        fs::remove_file(&file).unwrap();
        let input = temp.path().join("main.typ");
        fs::write(&input, "Same bytes").unwrap();
        let id = selection(&service, &owner, &project, "", vec![input]).await;
        let config = service.state.join("projects.json");
        let original = fs::read(&config).unwrap();
        let reserved = Arc::new(Mutex::new(None));
        if before_publication {
            fs::remove_file(&config).unwrap();
            fs::create_dir(&config).unwrap();
        } else {
            let config = config.clone();
            let reserved = reserved.clone();
            lock(&service.file_import).unwrap().after_publish = Some(Box::new(move || {
                *reserved.lock().unwrap() = Some(fs::read(&config).unwrap());
                fs::remove_file(&config).unwrap();
                fs::create_dir(&config).unwrap();
            }));
        }
        let result = commit(&service, &owner, &id, &Uuid::new_v4().to_string()).await;
        if before_publication {
            assert_eq!(result["status"], "failed");
            assert!(!file.exists());
            assert!(!sidecar(&file).exists());
            assert_eq!(service.source_epoch(&project.id, "main.typ").unwrap(), 1);
        } else {
            assert_eq!(result["status"], "outcome_unknown");
            assert_eq!(fs::read_to_string(&file).unwrap(), "Same bytes");
            assert_eq!(service.source_epoch(&project.id, "main.typ").unwrap(), 2);
            assert_eq!(
                service
                    .remote(
                        "read_manuscript",
                        json!({"documentId":shared["documentId"]})
                    )
                    .unwrap_err()
                    .code,
                "scope"
            );
            assert_eq!(
                service
                    .local_source(SourceRequest {
                        operation: Operation::Save {
                            project: project.id.clone(),
                            path: "main.typ".into(),
                            revision: digest("Same bytes"),
                            content: "Old caller".into()
                        },
                        source_epoch: 1,
                        expected_root: None
                    })
                    .unwrap_err()
                    .code,
                "stale_document"
            );
            assert!(service.project(&project.id).unwrap().pending.is_empty());
        }
        fs::remove_dir(&config).unwrap();
        fs::write(
            &config,
            if before_publication {
                original
            } else {
                reserved.lock().unwrap().take().unwrap()
            },
        )
        .unwrap();
        let restarted = Service::new(service.state.clone()).unwrap();
        assert_eq!(
            restarted.source_epoch(&project.id, "main.typ").unwrap(),
            if before_publication { 1 } else { 2 }
        );
    }
}

fn output_stages(root: &Path) -> Vec<PathBuf> {
    fs::read_dir(root)
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .filter(|path| {
            path.file_name()
                .unwrap()
                .to_string_lossy()
                .starts_with(".undertree-build-import-")
        })
        .collect()
}

#[tokio::test]
async fn completed_output_tampering_before_or_after_publication_never_acquires_ownership() {
    for after in [false, true] {
        let (temp, service, project, owner) = fixture();
        let source = temp.path().join("a.png");
        fs::write(&source, b"original").unwrap();
        let id = selection(&service, &owner, &project, "", vec![source]).await;
        let root = project.root.clone();
        let hook = Box::new(move || {
            let target = if after {
                root.join("a.png")
            } else {
                output_stages(&root)[0].join("a.png")
            };
            fs::write(target, b"modified").unwrap();
        });
        if after {
            lock(&service.file_import).unwrap().after_publish = Some(hook);
        } else {
            *lock(&service.import_before_publish).unwrap() = Some(hook);
        }
        let before = fs::read(service.state.join("projects.json")).unwrap();
        let result = commit(&service, &owner, &id, &Uuid::new_v4().to_string()).await;
        assert_ne!(result["status"], "committed");
        assert_eq!(
            fs::read(service.state.join("projects.json")).unwrap(),
            before
        );
        assert!(service.project(&project.id).unwrap().pending.is_empty());
        if after {
            assert_eq!(fs::read(project.root.join("a.png")).unwrap(), b"modified");
        } else {
            assert!(!project.root.join("a.png").exists());
        }
        let stages = output_stages(&project.root);
        assert_eq!(stages.len(), 1);
        assert_eq!(fs::read(stages[0].join("a.png")).unwrap(), b"modified");
    }
}

#[cfg(unix)]
#[tokio::test]
async fn cleanup_preserves_unknown_regular_or_symlink_stage_replacements() {
    for link in [false, true] {
        let (temp, service, project, owner) = fixture();
        let source = temp.path().join("a.png");
        let outside = temp.path().join("outside");
        fs::write(&source, b"original").unwrap();
        fs::write(&outside, b"external").unwrap();
        let id = selection(&service, &owner, &project, "", vec![source]).await;
        let root = project.root.clone();
        let external = outside.clone();
        *lock(&service.import_before_publish).unwrap() = Some(Box::new(move || {
            let target = output_stages(&root)[0].join("a.png");
            fs::remove_file(&target).unwrap();
            if link {
                std::os::unix::fs::symlink(external, target).unwrap();
            } else {
                fs::write(target, b"replacement").unwrap();
            }
            fs::write(
                root.join("a.png.undertree-pending.json"),
                b"external collision",
            )
            .unwrap();
        }));
        let result = commit(&service, &owner, &id, &Uuid::new_v4().to_string()).await;
        assert_ne!(result["status"], "committed");
        assert!(!project.root.join("a.png").exists());
        assert!(service.project(&project.id).unwrap().pending.is_empty());
        let stages = output_stages(&project.root);
        assert_eq!(stages.len(), 1);
        let target = stages[0].join("a.png");
        assert_eq!(
            fs::symlink_metadata(&target)
                .unwrap()
                .file_type()
                .is_symlink(),
            link
        );
        assert_eq!(
            fs::read(target).unwrap(),
            if link {
                b"external".as_slice()
            } else {
                b"replacement".as_slice()
            }
        );
        assert_eq!(fs::read(outside).unwrap(), b"external");
    }
}

#[tokio::test]
async fn import_admission_counts_retained_output_groups_across_project_parents() {
    let (temp, service, project, owner) = fixture();
    for parent in ["a", "b"] {
        fs::create_dir(project.root.join(parent)).unwrap();
    }
    for index in 0..8 {
        let path = project
            .root
            .join(if index < 4 { "a" } else { "b" })
            .join(format!(".undertree-build-import-retained-{index}"));
        fs::create_dir(&path).unwrap();
        fs::write(path.join("asset.png"), b"retained").unwrap();
    }
    let source = temp.path().join("a.png");
    fs::write(&source, b"fresh").unwrap();
    let id = selection(&service, &owner, &project, "", vec![source]).await;
    let before = fs::read(service.state.join("projects.json")).unwrap();
    let result = commit(&service, &owner, &id, &Uuid::new_v4().to_string()).await;
    assert_eq!(result["status"], "failed");
    assert_eq!(result["error"]["code"], "limit");
    assert!(output_stages(&project.root).is_empty());
    assert!(!project.root.join("a.png").exists());
    assert_eq!(
        fs::read(service.state.join("projects.json")).unwrap(),
        before
    );
    assert_eq!(output_stages(&project.root.join("a")).len(), 4);
    assert_eq!(output_stages(&project.root.join("b")).len(), 4);
}

#[test]
fn rooted_import_admission_validates_actual_owner_and_captured_root_before_ticket() {
    let (temp, service, project, _) = fixture();
    let connected = service.connect_native_editor("main").unwrap();
    let owner_id = connected["ownerId"].as_str().unwrap();
    let root = source_files::RootedRoot::observe(&project.root).unwrap();
    assert_eq!(
        service
            .begin_native_import_rooted("other", owner_id, &project.id, "", root)
            .unwrap_err()
            .code,
        "stale_session"
    );
    let previous = temp.path().join("old-root");
    fs::rename(&project.root, &previous).unwrap();
    fs::create_dir(&project.root).unwrap();
    assert_eq!(
        service
            .begin_native_import_rooted("main", owner_id, &project.id, "", root)
            .unwrap_err()
            .code,
        "stale_root"
    );
    assert!(lock(&service.file_import).unwrap().selections.is_empty());
    let current = source_files::RootedRoot::observe(&project.root).unwrap();
    service.connect_native_editor("main").unwrap();
    assert_eq!(
        service
            .begin_native_import_rooted("main", owner_id, &project.id, "", current)
            .unwrap_err()
            .code,
        "stale_session"
    );
    assert!(lock(&service.file_import).unwrap().selections.is_empty());
    assert!(fs::read_dir(&project.root).unwrap().next().is_none());
}
