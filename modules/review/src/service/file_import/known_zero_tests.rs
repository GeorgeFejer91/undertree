use super::*;

async fn prepared() -> (
    tempfile::TempDir,
    Arc<Service>,
    String,
    String,
    String,
    String,
    PathBuf,
) {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("project");
    fs::create_dir(&root).unwrap();
    let file = root.join("main.typ");
    fs::write(&file, "Same bytes").unwrap();
    let service = Service::new(temp.path().join("state")).unwrap();
    let project = service
        .local(Operation::AddProject {
            root: root.to_str().unwrap().into(),
        })
        .unwrap()["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let shared = service
        .local(Operation::Share {
            project: project.clone(),
            path: "main.typ".into(),
            enabled: true,
        })
        .unwrap()["documentId"]
        .as_str()
        .unwrap()
        .to_owned();
    let connected = service.connect_native_editor("main").unwrap();
    let owner = service
        .native_editor_owner("main", connected["ownerId"].as_str().unwrap())
        .unwrap();
    let input = temp.path().join("main.typ");
    fs::write(&input, "Same bytes").unwrap();
    let id = service
        .begin_native_import_rooted(
            "main",
            connected["ownerId"].as_str().unwrap(),
            &project,
            "",
            RootedRoot::observe(&root).unwrap(),
        )
        .unwrap()["selectionId"]
        .as_str()
        .unwrap()
        .to_owned();
    service
        .stage_native_import(&owner, &id, vec![input])
        .await
        .unwrap();
    fs::remove_file(&file).unwrap();
    (temp, service, project, owner, id, shared, file)
}
async fn run(service: &Arc<Service>, owner: &str, id: &str) -> Value {
    service
        .import_as(
            CallerContext::Local,
            owner,
            ImportOperation::ImportFiles {
                selection_id: id.into(),
                request_id: Uuid::new_v4().to_string(),
            },
        )
        .await
        .unwrap()
}

#[tokio::test]
async fn shared_zero_import_consumes_one_without_relabeling_old_grant() {
    let (_temp, service, project, owner, id, shared, file) = prepared().await;
    let result = run(&service, &owner, &id).await;
    assert_eq!(result["status"], "committed");
    assert_eq!(result["files"][0]["sourceEpoch"], 1);
    assert_eq!(service.source_epoch(&project, "main.typ").unwrap(), 1);
    assert_eq!(
        service
            .remote("read_manuscript", json!({"documentId":shared}))
            .unwrap_err()
            .code,
        "scope"
    );
    assert_eq!(fs::read(&file).unwrap(), b"Same bytes");
    assert_eq!(
        service
            .local(Operation::Review {
                project: project.clone(),
                path: "main.typ".into()
            })
            .unwrap()["shared"],
        false
    );
}

#[tokio::test]
async fn shared_zero_import_reservation_failure_creates_no_names_and_later_failure_preserves_one() {
    for before in [true, false] {
        let (_temp, service, project, owner, id, shared, file) = prepared().await;
        let config = service.state.join("projects.json");
        let old = fs::read(&config).unwrap();
        let saved = Arc::new(Mutex::new(None));
        if before {
            fs::remove_file(&config).unwrap();
            fs::create_dir(&config).unwrap();
        } else {
            let config = config.clone();
            let saved = saved.clone();
            lock(&service.file_import).unwrap().after_publish = Some(Box::new(move || {
                *saved.lock().unwrap() = Some(fs::read(&config).unwrap());
                fs::remove_file(&config).unwrap();
                fs::create_dir(&config).unwrap();
            }));
        }
        let result = run(&service, &owner, &id).await;
        if before {
            assert_eq!(result["status"], "failed");
            assert!(!file.exists());
            assert!(!sidecar(&file).exists());
            assert_eq!(service.source_epoch(&project, "main.typ").unwrap(), 0);
        } else {
            assert_eq!(result["status"], "outcome_unknown");
            assert_eq!(service.source_epoch(&project, "main.typ").unwrap(), 1);
            assert_eq!(fs::read(&file).unwrap(), b"Same bytes");
            assert_eq!(
                service
                    .remote("read_manuscript", json!({"documentId":shared}))
                    .unwrap_err()
                    .code,
                "scope"
            );
            assert!(service.project(&project).unwrap().pending.is_empty());
        }
        fs::remove_dir(&config).unwrap();
        fs::write(
            &config,
            if before {
                old
            } else {
                saved.lock().unwrap().take().unwrap()
            },
        )
        .unwrap();
        let restarted = Service::new(service.state.clone()).unwrap();
        assert_eq!(
            restarted.source_epoch(&project, "main.typ").unwrap(),
            if before { 0 } else { 1 }
        );
    }
}

#[tokio::test]
async fn explicitly_recorded_zero_import_rotates_after_ephemeral_share_is_revoked() {
    let (_temp, service, project, owner, id, _shared, file) = prepared().await;
    service
        .local(Operation::Share {
            project: project.clone(),
            path: "main.typ".into(),
            enabled: false,
        })
        .unwrap();
    {
        let mut registry = lock(&service.registry).unwrap();
        registry
            .source_epochs
            .entry(project.clone())
            .or_default()
            .insert("main.typ".into(), 0);
        service.save_registry(&registry).unwrap();
    }
    assert_eq!(
        run(&service, &owner, &id).await["files"][0]["sourceEpoch"],
        1
    );
    assert_eq!(fs::read(file).unwrap(), b"Same bytes");
}
