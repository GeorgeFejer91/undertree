use super::*;
use crate::service::editor::EditorOperation;
use std::os::unix::fs::{MetadataExt, PermissionsExt};

struct Fixture {
    temp: tempfile::TempDir,
    service: Arc<Service>,
    project: Project,
    owner: String,
    root: RootObservation,
    source: Vec<u8>,
    review: Vec<u8>,
    report: Vec<u8>,
}
impl Fixture {
    fn new() -> Self {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("project");
        fs::create_dir(&path).unwrap();
        let source = b"Hello #emph[world]\n".to_vec();
        let review =
            serde_json::to_vec_pretty(&Review::new(std::str::from_utf8(&source).unwrap())).unwrap();
        let report = b"\xffopaque report\0".to_vec();
        fs::write(path.join("main.typ"), &source).unwrap();
        fs::write(sidecar(&path.join("main.typ")), &review).unwrap();
        fs::write(path.join("main.typ.import-report.json"), &report).unwrap();
        let service = Service::new(temp.path().join("state")).unwrap();
        let added = service
            .local(Operation::AddProject {
                root: path.to_str().unwrap().into(),
            })
            .unwrap();
        let project = service.project(added["id"].as_str().unwrap()).unwrap();
        let root = RootedRoot::observe(&path).unwrap();
        let owner = service.connect_native_editor("main").unwrap()["ownerId"]
            .as_str()
            .unwrap()
            .to_owned();
        service
            .local_source_context(
                SourceRequest {
                    operation: Operation::SetMainDocument {
                        project: project.id.clone(),
                        path: "main.typ".into(),
                    },
                    source_epoch: 0,
                    expected_root: Some(root),
                },
                Some(("main", &owner)),
            )
            .unwrap();
        Self {
            temp,
            service,
            project,
            owner,
            root,
            source,
            review,
            report,
        }
    }
    fn request(&self, from: &str, to: &str) -> MovePrepare {
        MovePrepare {
            generation: lock(&self.service.file_move).unwrap().generation.clone(),
            request_id: Uuid::new_v4().to_string(),
            project: self.project.id.clone(),
            from: from.into(),
            to: to.into(),
            source_epoch: self.service.source_epoch(&self.project.id, from).unwrap(),
            expected_root: self.root,
            revision: digest_bytes(&self.source),
            sidecar_revision: Some(digest_bytes(&self.review)),
        }
    }
    async fn prepare(&self, request: MovePrepare) -> Value {
        self.service
            .prepare_native_file_move("main", &self.owner, request)
            .await
            .unwrap()
    }
    async fn commit(&self, prepared: &Value) -> Value {
        self.service
            .file_move_native(
                "main",
                &self.owner,
                MoveOperation::MoveCommit {
                    generation: prepared["generation"].as_str().unwrap().into(),
                    move_id: prepared["moveId"].as_str().unwrap().into(),
                    request_id: prepared["requestId"].as_str().unwrap().into(),
                },
            )
            .await
            .unwrap()
    }
    fn original(&self) {
        assert_eq!(
            fs::read(self.project.root.join("main.typ")).unwrap(),
            self.source
        );
        assert_eq!(
            fs::read(sidecar(&self.project.root.join("main.typ"))).unwrap(),
            self.review
        );
        assert_eq!(
            fs::read(self.project.root.join("main.typ.import-report.json")).unwrap(),
            self.report
        );
    }
    fn hook(&self, point: u8, hook: impl FnOnce() -> Result<()> + Send + 'static) {
        lock(&self.service.file_move)
            .unwrap()
            .hooks
            .insert(point, Box::new(hook));
    }
    async fn interrupted(&self, point: u8) -> Value {
        let prepared = self.prepare(self.request("main.typ", "moved.typ")).await;
        self.hook(point, || {
            Err(Error::new("io", "finite injected interruption"))
        });
        let receipt = self.commit(&prepared).await;
        assert_eq!(receipt["status"], "recovery_required");
        receipt
    }
    fn restart(&self) -> (Arc<Service>, String) {
        let service = Service::new(self.temp.path().join("state")).unwrap();
        let owner = service.connect_native_editor("main").unwrap()["ownerId"]
            .as_str()
            .unwrap()
            .to_owned();
        (service, owner)
    }
}

async fn listed(service: &Arc<Service>, owner: &str) -> Value {
    service
        .file_move_native("main", owner, MoveOperation::MoveList {})
        .await
        .unwrap()
}

#[test]
fn strict_move_wire_rejects_missing_null_unsafe_and_unknown_capture_fields() {
    let fixture = Fixture::new();
    let request = serde_json::to_value(fixture.request("main.typ", "moved.typ")).unwrap();
    assert!(serde_json::from_value::<MovePrepare>(request.clone()).is_ok());
    for bad in [Value::Null, json!("0"), json!(false), json!(-1), json!(0.5)] {
        let mut value = request.clone();
        value["sourceEpoch"] = bad;
        assert!(serde_json::from_value::<MovePrepare>(value).is_err());
    }
    let mut unsafe_epoch = request.clone();
    unsafe_epoch["sourceEpoch"] = json!(9_007_199_254_740_992u64);
    assert_eq!(
        validate_request(&serde_json::from_value::<MovePrepare>(unsafe_epoch).unwrap())
            .unwrap_err()
            .code,
        "format"
    );
    for field in ["generation", "expectedRoot", "sidecarRevision", "requestId"] {
        let mut value = request.clone();
        value.as_object_mut().unwrap().remove(field);
        assert!(
            serde_json::from_value::<MovePrepare>(value).is_err(),
            "{field}"
        );
    }
    let mut value = request.clone();
    value["unexpected"] = json!(true);
    assert!(serde_json::from_value::<MovePrepare>(value).is_err());
    assert!(serde_json::from_str::<MovePrepare>(&format!(
        "{{\"sourceEpoch\":0,{}",
        serde_json::to_string(&request)
            .unwrap()
            .trim_start_matches('{')
    ))
    .is_err());
    assert!(serde_json::from_value::<MoveOperation>(json!({"action":"move_list"})).is_ok());
    for extra in ["requestId", "moveId", "project", "unexpected"] {
        let mut value = json!({"action":"move_list"});
        value[extra] = json!(Uuid::new_v4().to_string());
        assert!(
            serde_json::from_value::<MoveOperation>(value).is_err(),
            "{extra}"
        );
    }
    fixture.original();
}

#[tokio::test]
async fn native_list_is_owner_bound_and_preserves_empty_prepared_and_terminal_receipts() {
    let f = Fixture::new();
    let before = directory_bytes(f.temp.path());
    assert_eq!(
        listed(&f.service, &f.owner).await,
        json!({"generation":"0","moves":[]})
    );
    assert_eq!(directory_bytes(f.temp.path()), before);

    let prepared = f.prepare(f.request("main.typ", "moved.typ")).await;
    let before = directory_bytes(f.temp.path());
    assert_eq!(
        listed(&f.service, &f.owner).await,
        json!({"generation":"0","moves":[prepared]})
    );
    for (window, owner) in [("other", f.owner.as_str()), ("main", "unknown-owner")] {
        assert!(f
            .service
            .file_move_native(window, owner, MoveOperation::MoveList {})
            .await
            .is_err());
    }
    assert_eq!(directory_bytes(f.temp.path()), before);

    let cancelled = f
        .service
        .file_move_native(
            "main",
            &f.owner,
            MoveOperation::MoveCancel {
                generation: "0".into(),
                move_id: prepared["moveId"].as_str().unwrap().into(),
                request_id: prepared["requestId"].as_str().unwrap().into(),
            },
        )
        .await
        .unwrap();
    let owner = f.service.connect_native_editor("main").unwrap()["ownerId"]
        .as_str()
        .unwrap()
        .to_owned();
    let before = directory_bytes(f.temp.path());
    assert!(f
        .service
        .file_move_native("main", &f.owner, MoveOperation::MoveList {})
        .await
        .is_err());
    let list = listed(&f.service, &owner).await;
    assert_eq!(list, json!({"generation":"0","moves":[cancelled]}));
    for key in ["owner", "git", "content", "blob"] {
        assert!(list["moves"][0].get(key).is_none());
    }
    assert_eq!(listed(&f.service, &owner).await, list);
    assert_eq!(directory_bytes(f.temp.path()), before);
    assert_eq!(
        f.service.source_epoch(&f.project.id, "main.typ").unwrap(),
        0
    );
    f.original();
}

#[tokio::test]
async fn genuine_active_and_cumulative_terminal_capacity_refusals_give_distinct_truthful_guidance()
{
    let active = Fixture::new();
    active
        .prepare(active.request("main.typ", "first.typ"))
        .await;
    active
        .prepare(active.request("main.typ", "second.typ"))
        .await;
    let before = directory_bytes(active.temp.path());
    let error = active
        .service
        .prepare_native_file_move(
            "main",
            &active.owner,
            active.request("main.typ", "third.typ"),
        )
        .await
        .unwrap_err();
    assert_eq!(error.code, "limit");
    assert!(error.message.contains("Two Move requests are active"));
    assert_eq!(directory_bytes(active.temp.path()), before);
    active.original();

    let terminal = Fixture::new();
    let mut ids = Vec::new();
    for _ in 0..MAX_RECORDS {
        let prepared = terminal
            .prepare(terminal.request("main.typ", "moved.typ"))
            .await;
        let request_id = prepared["requestId"].as_str().unwrap().to_owned();
        terminal
            .service
            .file_move_native(
                "main",
                &terminal.owner,
                MoveOperation::MoveCancel {
                    generation: "0".into(),
                    move_id: prepared["moveId"].as_str().unwrap().into(),
                    request_id: request_id.clone(),
                },
            )
            .await
            .unwrap();
        ids.push(request_id);
    }
    // Existing cleanup retires payloads only, and deliberately leaves all genuine receipts.
    terminal.service.cleanup_move_store().unwrap();
    let before = directory_bytes(terminal.temp.path());
    let list = listed(&terminal.service, &terminal.owner).await;
    let moves = list["moves"].as_array().unwrap();
    assert_eq!(moves.len(), MAX_RECORDS);
    assert!(moves.iter().all(|record| record["status"] == "cancelled"));
    ids.sort();
    assert_eq!(
        moves
            .iter()
            .map(|record| record["requestId"].as_str().unwrap().to_owned())
            .collect::<Vec<_>>(),
        ids
    );
    let error = terminal
        .service
        .prepare_native_file_move(
            "main",
            &terminal.owner,
            terminal.request("main.typ", "moved.typ"),
        )
        .await
        .unwrap_err();
    assert_eq!(error.code, "limit");
    assert!(error.message.contains("64 retained Move receipt slots"));
    assert!(error.message.contains("does not free capacity"));
    assert_eq!(listed(&terminal.service, &terminal.owner).await, list);
    assert_eq!(directory_bytes(terminal.temp.path()), before);
    terminal.original();
    let collateral_before = collateral(&terminal);
    assert_eq!(
        retire_generation(&terminal.service, &terminal.owner, "0")
            .await
            .unwrap()["retiredCount"],
        MAX_RECORDS
    );
    assert_eq!(collateral(&terminal), collateral_before);
    let next = terminal
        .prepare(terminal.request("main.typ", "moved.typ"))
        .await;
    assert_eq!(next["generation"], "1");
    cancel_prepared(&terminal, &next).await;
    assert_eq!(
        retire_generation(&terminal.service, &terminal.owner, "1")
            .await
            .unwrap()["generation"],
        "2"
    );
    assert_eq!(
        fs::read_dir(store(&terminal.service.state))
            .unwrap()
            .count(),
        2
    );
    assert!(
        fs::metadata(store(&terminal.service.state).join(CONTROL))
            .unwrap()
            .len()
            <= MAX_CONTROL as u64
    );
}

#[tokio::test]
async fn native_move_preserves_exact_group_inode_mode_main_and_retires_captured_authority() {
    let f = Fixture::new();
    let before = fs::metadata(f.project.root.join("main.typ")).unwrap();
    let old = f
        .service
        .local_source_context(
            SourceRequest {
                operation: Operation::Share {
                    project: f.project.id.clone(),
                    path: "main.typ".into(),
                    enabled: true,
                },
                source_epoch: 0,
                expected_root: Some(f.root),
            },
            Some(("main", &f.owner)),
        )
        .unwrap();
    let id = old["documentId"].as_str().unwrap();
    let registry = fs::read(f.temp.path().join("state/projects.json")).unwrap();
    let p = f.prepare(f.request("main.typ", "moved.typ")).await;
    f.original();
    assert_eq!(
        fs::read(f.temp.path().join("state/projects.json")).unwrap(),
        registry
    );
    let r = f.commit(&p).await;
    assert_eq!(r["status"], "moved");
    assert_eq!(r["mainDocument"], "moved.typ");
    assert!(!f.project.root.join("main.typ").exists());
    assert_eq!(
        fs::read(f.project.root.join("moved.typ")).unwrap(),
        f.source
    );
    assert_eq!(
        fs::read(sidecar(&f.project.root.join("moved.typ"))).unwrap(),
        f.review
    );
    assert_eq!(
        fs::read(f.project.root.join("moved.typ.import-report.json")).unwrap(),
        f.report
    );
    let after = fs::metadata(f.project.root.join("moved.typ")).unwrap();
    assert_eq!(
        (before.dev(), before.ino(), before.mode(), before.nlink()),
        (after.dev(), after.ino(), after.mode(), after.nlink())
    );
    assert_eq!(after.nlink(), 1);
    assert_eq!(
        f.service.source_epoch(&f.project.id, "main.typ").unwrap(),
        1
    );
    assert_eq!(
        f.service.source_epoch(&f.project.id, "moved.typ").unwrap(),
        1
    );
    assert!(f.service.shared_source(id).is_err());
    let save = f
        .service
        .local_source_context(
            SourceRequest {
                operation: Operation::Save {
                    project: f.project.id.clone(),
                    path: "main.typ".into(),
                    revision: digest_bytes(&f.source),
                    content: "late".into(),
                },
                source_epoch: 0,
                expected_root: Some(f.root),
            },
            Some(("main", &f.owner)),
        )
        .unwrap_err();
    assert_eq!(save.code, "stale_document");
    assert!(!f.project.root.join("main.typ").exists());
    let again = f.commit(&p).await;
    assert_eq!(again, r);
    assert_eq!(
        f.service.project(&f.project.id).unwrap().main_document,
        "moved.typ"
    );
}

#[tokio::test]
async fn preparation_cancel_is_pure_and_bars_delayed_commit() {
    let f = Fixture::new();
    let before = fs::read(f.temp.path().join("state/projects.json")).unwrap();
    let p = f.prepare(f.request("main.typ", "moved.typ")).await;
    let cancelled = f
        .service
        .file_move_native(
            "main",
            &f.owner,
            MoveOperation::MoveCancel {
                generation: "0".into(),
                move_id: p["moveId"].as_str().unwrap().into(),
                request_id: p["requestId"].as_str().unwrap().into(),
            },
        )
        .await
        .unwrap();
    assert_eq!(cancelled["status"], "cancelled");
    assert_eq!(
        f.service
            .file_move_native(
                "main",
                &f.owner,
                MoveOperation::MoveCommit {
                    generation: "0".into(),
                    move_id: p["moveId"].as_str().unwrap().into(),
                    request_id: p["requestId"].as_str().unwrap().into()
                }
            )
            .await
            .unwrap_err()
            .code,
        "expired_ticket"
    );
    f.original();
    assert_eq!(
        fs::read(f.temp.path().join("state/projects.json")).unwrap(),
        before
    );
    assert!(!f.project.root.join("moved.typ").exists());
}

#[tokio::test]
async fn closed_path_admission_rejects_actual_registered_session_and_queued_save() {
    let f = Fixture::new();
    let operation:EditorOperation=serde_json::from_value(json!({"action":"editor_register","project":f.project.id,"path":"main.typ","sourceEpoch":0,"expectedRoot":f.root,"generation":0,"revision":digest_bytes(&f.source),"contentDigest":digest_bytes(&f.source),"dirty":false,"composing":false,"conflict":false})).unwrap();
    let registered = f
        .service
        .editor_native("main", &f.owner, operation)
        .await
        .unwrap();
    assert_eq!(
        f.service
            .prepare_native_file_move("main", &f.owner, f.request("main.typ", "moved.typ"))
            .await
            .unwrap_err()
            .code,
        "busy"
    );
    let owner = f.service.native_editor_owner("main", &f.owner).unwrap();
    let id = Uuid::new_v4().to_string();
    let saving = {
        let service = f.service.clone();
        let project = f.project.id.clone();
        let id = id.clone();
        tokio::spawn(async move { service.request_editor_save(&project, "main.typ", &id).await })
    };
    for _ in 0..100 {
        if lock(&f.service.editor)
            .unwrap()
            .has_source_binding(&f.project.id, "main.typ", 0)
        {
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
    // A queued request is independently tested by the editor's reservation unit below; no save is performed by Move.
    assert_eq!(
        f.service
            .prepare_native_file_move("main", &f.owner, f.request("main.typ", "moved.typ"))
            .await
            .unwrap_err()
            .code,
        "busy"
    );
    let unregister: EditorOperation = serde_json::from_value(
        json!({"action":"editor_unregister","sessionId":registered["sessionId"]}),
    )
    .unwrap();
    f.service.editor(&owner, unregister).await.unwrap();
    let _ = saving.await.unwrap();
    f.original();
}

#[tokio::test]
async fn accepted_faults_restart_block_all_producers_and_explicitly_reconcile_roll_forward() {
    for point in [1, 2, 3, 4, 5, 6, 7] {
        let f = Fixture::new();
        let r = f.interrupted(point).await;
        assert_eq!(
            f.service
                .move_source_available(&f.project.id, "main.typ")
                .unwrap_err()
                .code,
            "move_pending"
        );
        assert_eq!(
            f.service
                .move_source_available(&f.project.id, "moved.typ")
                .unwrap_err()
                .code,
            "move_pending"
        );
        assert_eq!(
            f.service
                .sync_remote(&f.project, "invalid", "invalid")
                .await
                .unwrap_err()
                .code,
            "move_pending"
        );
        assert_eq!(
            f.service
                .create_directory_rooted(&f.project.id, "new", Some(f.root))
                .unwrap_err()
                .code,
            "move_pending"
        );
        assert_eq!(
            f.service
                .compile_typst_rooted(
                    &f.project.id,
                    "main.typ",
                    &digest_bytes(&f.source),
                    f.service.source_epoch(&f.project.id, "main.typ").unwrap(),
                    Some(f.root),
                    None
                )
                .await
                .unwrap_err()
                .code,
            "move_pending"
        );
        let (service, owner) = f.restart();
        let before = directory_bytes(f.temp.path());
        // This fresh page has no frontend UUID storage; discover the durable request first.
        let discovery = listed(&service, &owner).await;
        let records = discovery["moves"].as_array().unwrap();
        assert_eq!(records.len(), 1);
        let id = records[0]["requestId"].as_str().unwrap().to_owned();
        assert_eq!(records[0]["requestId"], r["requestId"]);
        assert_eq!(records[0]["status"], "recovery_required");
        assert_eq!(directory_bytes(f.temp.path()), before);
        let status = service
            .file_move_native(
                "main",
                &owner,
                MoveOperation::MoveStatus {
                    generation: "0".into(),
                    request_id: id.clone(),
                },
            )
            .await
            .unwrap();
        assert_eq!(status["status"], "recovery_required");
        assert_eq!(
            service
                .move_project_available(&f.project.id)
                .unwrap_err()
                .code,
            "move_pending"
        );
        let done = service
            .file_move_native(
                "main",
                &owner,
                MoveOperation::MoveReconcile {
                    generation: "0".into(),
                    request_id: id,
                },
            )
            .await
            .unwrap();
        assert_eq!(done["status"], "moved", "point{point}:{done}");
        let before = directory_bytes(f.temp.path());
        assert_eq!(
            listed(&service, &owner).await,
            json!({"generation":"0","moves":[done]})
        );
        assert_eq!(directory_bytes(f.temp.path()), before);
        assert_eq!(
            fs::read(f.project.root.join("moved.typ")).unwrap(),
            f.source
        );
        assert!(!f.project.root.join("main.typ").exists());
        assert_eq!(service.source_epoch(&f.project.id, "main.typ").unwrap(), 1);
        assert!(service.compile_lock.clone().try_lock_owned().is_ok());
        assert!(service.sync_lock.clone().try_lock_owned().is_ok());
    }
}

#[tokio::test]
async fn external_replacement_after_one_member_preserves_every_actual_name_and_intent() {
    let f = Fixture::new();
    let r = f.interrupted(3).await;
    fs::rename(
        f.project.root.join("moved.typ"),
        f.project.root.join("kept-original.typ"),
    )
    .unwrap();
    fs::write(f.project.root.join("moved.typ"), b"replacement").unwrap();
    let id = r["requestId"].as_str().unwrap();
    let intent = directory(&f.service.state, r["moveId"].as_str().unwrap())
        .unwrap()
        .join("intent.json");
    let (service, owner) = f.restart();
    let receipt = service
        .file_move_native(
            "main",
            &owner,
            MoveOperation::MoveReconcile {
                generation: "0".into(),
                request_id: id.into(),
            },
        )
        .await
        .unwrap();
    assert_eq!(receipt["status"], "recovery_required");
    assert_eq!(
        fs::read(f.project.root.join("moved.typ")).unwrap(),
        b"replacement"
    );
    assert_eq!(
        fs::read(f.project.root.join("kept-original.typ")).unwrap(),
        f.source
    );
    assert_eq!(
        fs::read(sidecar(&f.project.root.join("main.typ"))).unwrap(),
        f.review
    );
    assert!(intent.exists());
}

#[tokio::test]
async fn registry_reservation_failure_has_no_names_and_retry_consumes_epoch_once() {
    let f = Fixture::new();
    let p = f.prepare(f.request("main.typ", "moved.typ")).await;
    let config = f.service.state.join("projects.json");
    let saved = fs::read(&config).unwrap();
    let blocked = config.clone();
    f.hook(1, move || {
        fs::remove_file(&blocked)?;
        fs::create_dir(&blocked)?;
        Ok(())
    });
    let receipt = f.commit(&p).await;
    assert_eq!(receipt["status"], "recovery_required");
    f.original();
    assert!(!f.project.root.join("moved.typ").exists());
    assert_eq!(
        f.service.source_epoch(&f.project.id, "main.typ").unwrap(),
        0
    );
    fs::remove_dir(&config).unwrap();
    fs::write(&config, saved).unwrap();
    let done = f
        .service
        .file_move_native(
            "main",
            &f.owner,
            MoveOperation::MoveReconcile {
                generation: "0".into(),
                request_id: p["requestId"].as_str().unwrap().into(),
            },
        )
        .await
        .unwrap();
    assert_eq!(done["status"], "moved");
    assert_eq!(
        f.service.source_epoch(&f.project.id, "main.typ").unwrap(),
        1
    );
}

#[tokio::test]
async fn untracked_pending_addition_can_move_again_without_tombstone_graph() {
    let f = Fixture::new();
    let first = f.prepare(f.request("main.typ", "b.typ")).await;
    assert_eq!(f.commit(&first).await["status"], "moved");
    let second = f.prepare(f.request("b.typ", "c.typ")).await;
    assert_eq!(f.commit(&second).await["status"], "moved");
    let project = f.service.project(&f.project.id).unwrap();
    assert!(project.pending.contains("c.typ"));
    assert!(!project.pending.contains("b.typ"));
    assert!(!project.pending.contains("main.typ"));
    assert_eq!(project.pending_revisions["c.typ"], digest_bytes(&f.source));
    assert!(lock(&f.service.registry)
        .unwrap()
        .pending_deletions
        .is_empty());
}

#[tokio::test]
async fn pending_journal_corrupt_policy_collision_and_executable_members_fail_before_acceptance() {
    for kind in 0..4 {
        let f = Fixture::new();
        let before = fs::read(f.service.state.join("projects.json")).unwrap();
        match kind {
            0 => fs::write(journal_path(&f.project.root.join("main.typ")), b"pending").unwrap(),
            1 => fs::write(sidecar(&f.project.root.join("main.typ")), b"corrupt").unwrap(),
            2 => fs::write(f.project.root.join("moved.typ"), b"existing").unwrap(),
            _ => fs::set_permissions(
                f.project.root.join("main.typ"),
                fs::Permissions::from_mode(0o755),
            )
            .unwrap(),
        }
        assert!(f
            .service
            .prepare_native_file_move("main", &f.owner, f.request("main.typ", "moved.typ"))
            .await
            .is_err());
        assert_eq!(fs::read(f.project.root.join("main.typ")).unwrap(), f.source);
        assert_eq!(
            fs::read(f.service.state.join("projects.json")).unwrap(),
            before
        );
        assert!(lock(&f.service.file_move).unwrap().records.is_empty());
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn dropped_waiter_retains_actual_exclusions_without_holding_live_editor_documents() {
    for (point, expected_status) in [(0, "prepared"), (1, "pending")] {
        let f = Fixture::new();
        let p = f.prepare(f.request("main.typ", "moved.typ")).await;
        let (arrived, ready) = tokio::sync::oneshot::channel();
        let (release, waiting) = std::sync::mpsc::channel();
        f.hook(point, move || {
            arrived.send(()).unwrap();
            waiting.recv().unwrap();
            Ok(())
        });
        let caller = {
            let service = f.service.clone();
            let owner = f.owner.clone();
            let p = p.clone();
            tokio::spawn(async move {
                service
                    .file_move_native(
                        "main",
                        &owner,
                        MoveOperation::MoveCommit {
                            generation: p["generation"].as_str().unwrap().into(),
                            move_id: p["moveId"].as_str().unwrap().into(),
                            request_id: p["requestId"].as_str().unwrap().into(),
                        },
                    )
                    .await
            })
        };
        ready.await.unwrap();
        caller.abort();
        assert!(f.service.compile_lock.clone().try_lock_owned().is_err());
        assert!(f.service.sync_lock.clone().try_lock_owned().is_err());
        assert!(f.service.editor.try_lock().is_ok());
        assert!(f.service.documents.try_lock().is_ok());
        assert_eq!(
            f.service
                .move_source_available(&f.project.id, "main.typ")
                .unwrap_err()
                .code,
            "move_pending"
        );
        // Running holds exclusions before acceptance; observational replies retain the durable phase.
        let before = directory_bytes(f.temp.path());
        let discovery = listed(&f.service, &f.owner).await;
        assert_eq!(discovery["moves"].as_array().unwrap().len(), 1);
        assert_eq!(discovery["moves"][0]["requestId"], p["requestId"]);
        assert_eq!(discovery["moves"][0]["status"], expected_status);
        let status = f
            .service
            .file_move_native(
                "main",
                &f.owner,
                MoveOperation::MoveStatus {
                    generation: p["generation"].as_str().unwrap().into(),
                    request_id: p["requestId"].as_str().unwrap().into(),
                },
            )
            .await
            .unwrap();
        assert_eq!(status, discovery["moves"][0]);
        let intent = directory(&f.service.state, p["moveId"].as_str().unwrap())
            .unwrap()
            .join("intent.json");
        let durable: Record = serde_json::from_slice(&fs::read(intent).unwrap()).unwrap();
        assert_eq!(reply(&durable), status);
        assert_eq!(directory_bytes(f.temp.path()), before);
        f.original();
        assert!(!f.project.root.join("moved.typ").exists());
        assert_eq!(
            f.service.project(&f.project.id).unwrap().main_document,
            "main.typ"
        );
        for path in ["main.typ", "moved.typ"] {
            assert_eq!(f.service.source_epoch(&f.project.id, path).unwrap(), 0);
        }
        assert!(f.service.compile_lock.clone().try_lock_owned().is_err());
        assert!(f.service.sync_lock.clone().try_lock_owned().is_err());
        release.send(()).unwrap();
        let id = p["requestId"].as_str().unwrap();
        let mut finished = false;
        for _ in 0..200 {
            let status = f
                .service
                .file_move_native(
                    "main",
                    &f.owner,
                    MoveOperation::MoveStatus {
                        generation: p["generation"].as_str().unwrap().into(),
                        request_id: id.into(),
                    },
                )
                .await
                .unwrap();
            if status["status"] == "moved"
                && f.service.compile_lock.clone().try_lock_owned().is_ok()
                && f.service.sync_lock.clone().try_lock_owned().is_ok()
            {
                finished = true;
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
        assert!(finished);
        assert_eq!(
            fs::read(f.project.root.join("moved.typ")).unwrap(),
            f.source
        );
        assert_eq!(
            fs::read(sidecar(&f.project.root.join("moved.typ"))).unwrap(),
            f.review
        );
        assert_eq!(
            fs::read(f.project.root.join("moved.typ.import-report.json")).unwrap(),
            f.report
        );
        for path in [
            "main.typ",
            "main.typ.undertree-review.json",
            "main.typ.import-report.json",
        ] {
            assert!(!f.project.root.join(path).exists());
        }
        assert_eq!(
            f.service.project(&f.project.id).unwrap().main_document,
            "moved.typ"
        );
        assert!(f.service.compile_lock.clone().try_lock_owned().is_ok());
        assert!(f.service.sync_lock.clone().try_lock_owned().is_ok());
    }
}

#[tokio::test]
async fn page_retirement_before_acceptance_preserves_group_after_acceptance_requires_reconcile() {
    for point in [0, 1] {
        let f = Fixture::new();
        let p = f.prepare(f.request("main.typ", "moved.typ")).await;
        let service = f.service.clone();
        f.hook(point, move || {
            service.connect_native_editor("main")?;
            Ok(())
        });
        let result = f
            .service
            .file_move_native(
                "main",
                &f.owner,
                MoveOperation::MoveCommit {
                    generation: "0".into(),
                    move_id: p["moveId"].as_str().unwrap().into(),
                    request_id: p["requestId"].as_str().unwrap().into(),
                },
            )
            .await;
        if point == 0 {
            assert_eq!(result.unwrap_err().code, "stale_session");
            f.original();
            assert_eq!(
                f.service.source_epoch(&f.project.id, "main.typ").unwrap(),
                0
            );
        } else {
            assert_eq!(result.unwrap()["status"], "recovery_required");
            f.original();
            assert!(f.service.move_project_available(&f.project.id).is_err());
        }
    }
}

#[tokio::test]
async fn tracked_move_preserves_user_index_then_checkpoints_only_owned_deletions_and_refuses_relocation_until_sync(
) {
    let f = Fixture::new();
    git(&f.project.root, &["init", "-b", "main"]).await.unwrap();
    git(&f.project.root, &["config", "user.name", "Move test"])
        .await
        .unwrap();
    git(
        &f.project.root,
        &["config", "user.email", "move@example.invalid"],
    )
    .await
    .unwrap();
    git(
        &f.project.root,
        &[
            "add",
            "--",
            "main.typ",
            "main.typ.undertree-review.json",
            "main.typ.import-report.json",
        ],
    )
    .await
    .unwrap();
    git(&f.project.root, &["commit", "-m", "base"])
        .await
        .unwrap();
    let old_head = git_head(&f.project.root).await.unwrap().unwrap();
    let original_index = fs::read(f.project.root.join(".git/index")).unwrap();
    let p = f.prepare(f.request("main.typ", "moved.typ")).await;
    assert_eq!(f.commit(&p).await["status"], "moved");
    assert_eq!(
        fs::read(f.project.root.join(".git/index")).unwrap(),
        original_index
    );
    let pending = lock(&f.service.registry).unwrap().pending_deletions[&f.project.id].clone();
    assert_eq!(pending.len(), 3);
    let second = f.prepare(f.request("moved.typ", "next.typ")).await;
    let error = f
        .service
        .file_move_native(
            "main",
            &f.owner,
            MoveOperation::MoveCommit {
                generation: "0".into(),
                move_id: second["moveId"].as_str().unwrap().into(),
                request_id: second["requestId"].as_str().unwrap().into(),
            },
        )
        .await
        .unwrap_err();
    assert_eq!(error.code, "move_pending_sync");
    assert_eq!(
        f.service.source_epoch(&f.project.id, "moved.typ").unwrap(),
        1
    );
    assert!(!f.project.root.join("next.typ").exists());
    let reuse = f
        .service
        .local_source_context(
            SourceRequest {
                operation: Operation::Create {
                    project: f.project.id.clone(),
                    path: "main.typ".into(),
                },
                source_epoch: 0,
                expected_root: Some(f.root),
            },
            Some(("main", &f.owner)),
        )
        .unwrap_err();
    assert_eq!(reuse.code, "move_pending_sync");
    let _documents = f.service.documents.lock().await;
    let (commit, revisions) = f
        .service
        .checkpoint(
            &f.service.project(&f.project.id).unwrap(),
            "main",
            Some(&old_head),
        )
        .await
        .unwrap();
    assert!(commit.is_some());
    assert!(revisions["main.typ"].starts_with("deleted:"));
    assert_eq!(revisions["moved.typ"], digest_bytes(&f.source));
    assert!(git(&f.project.root, &["cat-file", "-e", "HEAD:main.typ"])
        .await
        .is_err());
    assert_eq!(
        git(&f.project.root, &["show", "HEAD:moved.typ"])
            .await
            .unwrap()
            .as_bytes(),
        f.source
    );
    assert_eq!(
        lock(&f.service.registry).unwrap().pending_deletions[&f.project.id],
        pending
    );
}

#[tokio::test]
async fn changed_native_root_and_late_destination_collision_cannot_redirect_move() {
    for root_swap in [true, false] {
        let f = Fixture::new();
        let p = f.prepare(f.request("main.typ", "moved.typ")).await;
        let before = fs::read(f.service.state.join("projects.json")).unwrap();
        if root_swap {
            fs::rename(&f.project.root, f.temp.path().join("kept-root")).unwrap();
            fs::create_dir(&f.project.root).unwrap();
            fs::write(f.project.root.join("main.typ"), &f.source).unwrap();
            fs::write(sidecar(&f.project.root.join("main.typ")), &f.review).unwrap();
            fs::write(
                f.project.root.join("main.typ.import-report.json"),
                &f.report,
            )
            .unwrap();
        } else {
            fs::write(f.project.root.join("moved.typ"), b"external destination").unwrap();
        }
        assert!(f
            .service
            .file_move_native(
                "main",
                &f.owner,
                MoveOperation::MoveCommit {
                    generation: "0".into(),
                    move_id: p["moveId"].as_str().unwrap().into(),
                    request_id: p["requestId"].as_str().unwrap().into()
                }
            )
            .await
            .is_err());
        f.original();
        assert_eq!(
            fs::read(f.service.state.join("projects.json")).unwrap(),
            before
        );
        if root_swap {
            assert!(!f.project.root.join("moved.typ").exists());
            assert_eq!(
                fs::read(f.temp.path().join("kept-root/main.typ")).unwrap(),
                f.source
            );
        } else {
            assert_eq!(
                fs::read(f.project.root.join("moved.typ")).unwrap(),
                b"external destination"
            );
        }
    }
}

#[tokio::test]
async fn explicit_main_clear_during_bulk_phase_is_preserved_in_receipt_and_registry() {
    let f = Fixture::new();
    let p = f.prepare(f.request("main.typ", "moved.typ")).await;
    let service = f.service.clone();
    let project = f.project.id.clone();
    f.hook(0, move || {
        service.local(Operation::SetMainDocument {
            project,
            path: String::new(),
        })?;
        Ok(())
    });
    let receipt = f.commit(&p).await;
    assert_eq!(receipt["status"], "moved");
    assert_eq!(receipt["mainDocument"], "");
    assert_eq!(f.service.project(&f.project.id).unwrap().main_document, "");
}

#[tokio::test]
async fn equal_length_in_place_edits_after_final_read_never_commit_stale_byte_ownership() {
    for review in [false, true] {
        let f = Fixture::new();
        let p = f.prepare(f.request("main.typ", "moved.typ")).await;
        let path = if review {
            sidecar(&f.project.root.join("moved.typ"))
        } else {
            f.project.root.join("moved.typ")
        };
        let replacement = if review {
            vec![b'X'; f.review.len()]
        } else {
            vec![b'Z'; f.source.len()]
        };
        let expected = replacement.clone();
        let service = f.service.clone();
        let registry = Arc::new(Mutex::new(None));
        let captured = registry.clone();
        f.hook(6, move || {
            *captured.lock().unwrap() = Some(fs::read(service.state.join("projects.json"))?);
            let before = fs::metadata(&path)?;
            fs::write(&path, replacement)?;
            let after = fs::metadata(&path)?;
            assert_eq!(
                (before.ino(), before.len(), before.mode()),
                (after.ino(), after.len(), after.mode())
            );
            Ok(())
        });
        let receipt = f.commit(&p).await;
        assert_eq!(receipt["status"], "recovery_required");
        assert_eq!(
            fs::read(f.service.state.join("projects.json")).unwrap(),
            registry.lock().unwrap().clone().unwrap()
        );
        assert!(f.service.project(&f.project.id).unwrap().pending.is_empty());
        let actual = if review {
            sidecar(&f.project.root.join("moved.typ"))
        } else {
            f.project.root.join("moved.typ")
        };
        assert_eq!(fs::read(actual).unwrap(), expected);
        assert!(directory(&f.service.state, p["moveId"].as_str().unwrap())
            .unwrap()
            .join("intent.json")
            .exists());
        assert!(f.service.move_project_available(&f.project.id).is_err());
    }
}

#[tokio::test]
async fn corrupt_or_short_private_report_refuses_before_acceptance_and_preserves_unknown_proof() {
    for short in [false, true] {
        let f = Fixture::new();
        let p = f.prepare(f.request("main.typ", "moved.typ")).await;
        let path = directory(&f.service.state, p["moveId"].as_str().unwrap())
            .unwrap()
            .join("report");
        let unknown = vec![
            b'?';
            if short {
                f.report.len() - 1
            } else {
                f.report.len()
            }
        ];
        fs::write(&path, &unknown).unwrap();
        let before = fs::read(f.service.state.join("projects.json")).unwrap();
        let old = f
            .service
            .local_source_context(
                SourceRequest {
                    operation: Operation::Share {
                        project: f.project.id.clone(),
                        path: "main.typ".into(),
                        enabled: true,
                    },
                    source_epoch: 0,
                    expected_root: Some(f.root),
                },
                Some(("main", &f.owner)),
            )
            .unwrap();
        let error = f
            .service
            .file_move_native(
                "main",
                &f.owner,
                MoveOperation::MoveCommit {
                    generation: "0".into(),
                    move_id: p["moveId"].as_str().unwrap().into(),
                    request_id: p["requestId"].as_str().unwrap().into(),
                },
            )
            .await
            .unwrap_err();
        assert_eq!(error.code, "move_unresolved");
        f.original();
        assert_eq!(fs::read(&path).unwrap(), unknown);
        assert_eq!(
            fs::read(f.service.state.join("projects.json")).unwrap(),
            before
        );
        assert!(f
            .service
            .shared_source(old["documentId"].as_str().unwrap())
            .is_ok());
        assert!(!f.project.root.join("moved.typ").exists());
    }
}

#[tokio::test]
async fn dangling_private_store_cannot_make_accepted_barriers_appear_uninitialized() {
    let f = Fixture::new();
    f.interrupted(3).await;
    let preserved = f.temp.path().join("kept-move-proofs");
    fs::rename(store(&f.service.state), &preserved).unwrap();
    std::os::unix::fs::symlink(f.temp.path().join("nonexistent"), store(&f.service.state)).unwrap();
    let error = match Service::new(f.service.state.clone()) {
        Ok(_) => panic!("accepted barriers disappeared"),
        Err(error) => error,
    };
    assert_eq!(error.code, "move_unresolved");
    assert!(preserved.is_dir());
    assert_eq!(
        fs::read(f.project.root.join("moved.typ")).unwrap(),
        f.source
    );
    assert_eq!(
        fs::read(sidecar(&f.project.root.join("main.typ"))).unwrap(),
        f.review
    );
}

#[tokio::test]
async fn combined_owned_write_delete_ceiling_refuses_before_alternate_staging_and_preserves_every_owner(
) {
    let f = Fixture::new();
    fs::remove_file(f.project.root.join("main.typ.import-report.json")).unwrap();
    git(&f.project.root, &["init", "-b", "main"]).await.unwrap();
    git(&f.project.root, &["config", "user.name", "Move test"])
        .await
        .unwrap();
    git(
        &f.project.root,
        &["config", "user.email", "move@example.invalid"],
    )
    .await
    .unwrap();
    git(
        &f.project.root,
        &["add", "--", "main.typ", "main.typ.undertree-review.json"],
    )
    .await
    .unwrap();
    git(&f.project.root, &["commit", "-m", "base"])
        .await
        .unwrap();
    let p = f.prepare(f.request("main.typ", "moved.typ")).await;
    assert_eq!(f.commit(&p).await["status"], "moved");
    {
        let mut registry = lock(&f.service.registry).unwrap();
        let project = registry
            .projects
            .iter_mut()
            .find(|p| p.id == f.project.id)
            .unwrap();
        for n in 0..997 {
            let path = format!("owned-{n}.txt");
            fs::write(project.root.join(&path), b"w").unwrap();
            project.pending.insert(path.clone());
            project.pending_revisions.insert(path, digest("w"));
        }
        f.service.save_registry(&registry).unwrap();
    }
    let project = f.service.project(&f.project.id).unwrap();
    assert_eq!(project.pending.len(), 999);
    assert_eq!(
        lock(&f.service.registry).unwrap().pending_deletions[&f.project.id].len(),
        2
    );
    let before = fs::read(f.service.state.join("projects.json")).unwrap();
    let index = fs::read(f.project.root.join(".git/index")).unwrap();
    let head = git_head(&f.project.root).await.unwrap().unwrap();
    let _documents = f.service.documents.lock().await;
    let error = f
        .service
        .checkpoint(&project, "main", Some(&head))
        .await
        .unwrap_err();
    assert_eq!(error.code, "limit");
    assert_eq!(fs::read(f.project.root.join(".git/index")).unwrap(), index);
    assert_eq!(git_head(&f.project.root).await.unwrap().unwrap(), head);
    assert_eq!(
        fs::read(f.service.state.join("projects.json")).unwrap(),
        before
    );
    assert!(!f.project.root.join(".git/index.lock").exists());
    assert_eq!(f.service.project(&f.project.id).unwrap().pending.len(), 999);
    assert_eq!(
        lock(&f.service.registry).unwrap().pending_deletions[&f.project.id].len(),
        2
    );
}

#[tokio::test]
async fn unsafe_integer_epoch_fails_actual_prepare_before_private_or_project_effects() {
    let f = Fixture::new();
    let mut request = f.request("main.typ", "moved.typ");
    request.source_epoch = crate::MAX_SOURCE_EPOCH + 1;
    let before = fs::read(f.service.state.join("projects.json")).unwrap();
    assert_eq!(
        f.service
            .prepare_native_file_move("main", &f.owner, request)
            .await
            .unwrap_err()
            .code,
        "format"
    );
    assert!(!store(&f.service.state).exists());
    assert_eq!(
        fs::read(f.service.state.join("projects.json")).unwrap(),
        before
    );
    f.original();
}

#[tokio::test]
async fn known_missing_policy_requires_explicit_exact_review_restore_before_move_acceptance() {
    let f = Fixture::new();
    f.service
        .local(Operation::Review {
            project: f.project.id.clone(),
            path: "main.typ".into(),
        })
        .unwrap();
    let path = sidecar(&f.project.root.join("main.typ"));
    fs::remove_file(&path).unwrap();
    assert_eq!(
        f.service
            .local(Operation::Review {
                project: f.project.id.clone(),
                path: "main.typ".into()
            })
            .unwrap_err()
            .code,
        "policy_missing"
    );
    let before = fs::read(f.service.state.join("projects.json")).unwrap();
    fs::write(&path, &f.review).unwrap();
    let error = f
        .service
        .prepare_native_file_move("main", &f.owner, f.request("main.typ", "moved.typ"))
        .await
        .unwrap_err();
    assert_eq!(error.code, "policy_missing");
    assert_eq!(
        fs::read(f.service.state.join("projects.json")).unwrap(),
        before
    );
    f.original();
    assert!(!f.project.root.join("moved.typ").exists());
    assert!(lock(&f.service.file_move).unwrap().records.is_empty());
    let mut changed: Review = serde_json::from_slice(&f.review).unwrap();
    changed.rules[0].label = "changed externally".into();
    fs::write(&path, serde_json::to_vec(&changed).unwrap()).unwrap();
    assert!(f
        .service
        .prepare_native_file_move("main", &f.owner, f.request("main.typ", "moved.typ"))
        .await
        .is_err());
    assert_eq!(
        fs::read(f.service.state.join("projects.json")).unwrap(),
        before
    );
    fs::write(&path, &f.review).unwrap();
    f.service
        .local(Operation::Review {
            project: f.project.id.clone(),
            path: "main.typ".into(),
        })
        .unwrap();
    let p = f.prepare(f.request("main.typ", "moved.typ")).await;
    assert_eq!(f.commit(&p).await["status"], "moved");
    assert_eq!(
        fs::read(sidecar(&f.project.root.join("moved.typ"))).unwrap(),
        f.review
    );
}

#[tokio::test]
async fn changed_capture_id_cannot_receive_prepared_completed_or_restarted_success() {
    let f = Fixture::new();
    let p = f.prepare(f.request("main.typ", "moved.typ")).await;
    let wrong = Uuid::new_v4().to_string();
    assert_eq!(
        f.service
            .file_move_native(
                "main",
                &f.owner,
                MoveOperation::MoveCommit {
                    generation: "0".into(),
                    move_id: wrong.clone(),
                    request_id: p["requestId"].as_str().unwrap().into()
                }
            )
            .await
            .unwrap_err()
            .code,
        "conflict"
    );
    f.original();
    assert_eq!(f.commit(&p).await["status"], "moved");
    let registry = fs::read(f.service.state.join("projects.json")).unwrap();
    let intent = directory(&f.service.state, p["moveId"].as_str().unwrap())
        .unwrap()
        .join("intent.json");
    let bytes = fs::read(&intent).unwrap();
    assert_eq!(
        f.service
            .file_move_native(
                "main",
                &f.owner,
                MoveOperation::MoveCommit {
                    generation: "0".into(),
                    move_id: wrong.clone(),
                    request_id: p["requestId"].as_str().unwrap().into()
                }
            )
            .await
            .unwrap_err()
            .code,
        "conflict"
    );
    let (service, owner) = f.restart();
    assert_eq!(
        service
            .file_move_native(
                "main",
                &owner,
                MoveOperation::MoveCommit {
                    generation: "0".into(),
                    move_id: wrong,
                    request_id: p["requestId"].as_str().unwrap().into()
                }
            )
            .await
            .unwrap_err()
            .code,
        "conflict"
    );
    assert_eq!(fs::read(&intent).unwrap(), bytes);
    assert_eq!(
        fs::read(f.service.state.join("projects.json")).unwrap(),
        registry
    );
    assert_eq!(
        fs::read(f.project.root.join("moved.typ")).unwrap(),
        f.source
    );
}

fn directory_bytes(root: &Path) -> BTreeMap<PathBuf, Vec<u8>> {
    fn visit(root: &Path, path: &Path, out: &mut BTreeMap<PathBuf, Vec<u8>>) {
        for entry in fs::read_dir(path).unwrap() {
            let entry = entry.unwrap();
            if entry.file_type().unwrap().is_dir() {
                visit(root, &entry.path(), out);
            } else {
                out.insert(
                    entry.path().strip_prefix(root).unwrap().into(),
                    fs::read(entry.path()).unwrap(),
                );
            }
        }
    }
    let mut out = BTreeMap::new();
    visit(root, root, &mut out);
    out
}
async fn history_versions(f: &Fixture) -> Vec<history::VersionSummary> {
    use history::HistoryItem;
    async fn list(
        f: &Fixture,
        namespace_id: Option<String>,
        source_id: Option<String>,
    ) -> history::HistoryPage {
        let HistoryReply::List(page) = f
            .service
            .history_query_native(
                "main",
                &f.owner,
                HistoryQuery::List {
                    project_id: f.project.id.clone(),
                    namespace_id,
                    observed_root: None,
                    source_id,
                    cursor: None,
                },
            )
            .await
            .unwrap()
        else {
            panic!("History List expected")
        };
        assert!(page.cursor.is_none());
        page
    }
    let mut versions = Vec::new();
    for item in list(f, None, None).await.items {
        let HistoryItem::Namespace { namespace_id, .. } = item else {
            panic!("namespace expected")
        };
        for source in list(f, Some(namespace_id.clone()), None).await.items {
            let HistoryItem::Source { source_id, .. } = source else {
                panic!("source expected")
            };
            for version in list(f, Some(namespace_id.clone()), Some(source_id))
                .await
                .items
            {
                let HistoryItem::Version { version } = version else {
                    panic!("version expected")
                };
                versions.push(*version);
            }
        }
    }
    versions
}
async fn history_read(f: &Fixture, version: &history::VersionSummary) -> Value {
    serde_json::to_value(
        f.service
            .history_query_native(
                "main",
                &f.owner,
                HistoryQuery::Read {
                    project_id: version.binding.project_id.clone(),
                    namespace_id: version.namespace_id.clone(),
                    source_id: version.source_id.clone(),
                    version_id: version.version_id.clone(),
                },
            )
            .await
            .unwrap(),
    )
    .unwrap()
}

#[tokio::test]
async fn actual_unarmed_native_history_producer_blocks_move_even_after_exact_journal_retirement() {
    let f = Fixture::new();
    *lock(&f.service.fail_after_journal).unwrap() = true;
    assert!(f
        .service
        .dispatch_native_source(
            "main",
            &f.owner,
            SourceRequest {
                operation: Operation::Save {
                    project: f.project.id.clone(),
                    path: "main.typ".into(),
                    revision: digest_bytes(&f.source),
                    content: "Captured by genuine native producer".into()
                },
                source_epoch: 0,
                expected_root: Some(f.root)
            }
        )
        .await
        .is_err());
    let group = RootedRoot::acquire(&f.project.root, &f.root)
        .unwrap()
        .source_group("main.typ")
        .unwrap();
    let journal = group.read_bytes(Member::Journal, MAX_TEXT * 9).unwrap();
    let native: Journal = serde_json::from_slice(journal.bytes().unwrap()).unwrap();
    assert!(native.history.is_some());
    {
        let book = lock(&f.service.editor).unwrap();
        book.check_native_owner("main", &f.owner).unwrap();
        let _documents = f.service.documents.try_lock().unwrap();
        group.retire_journal(journal.expectation()).unwrap();
    }
    let anchor = history_native::anchor(&lock(&f.service.registry).unwrap()).unwrap();
    let core =
        history::HistoryStore::open(project_tree::open_root(&f.service.state).unwrap(), anchor)
            .unwrap()
            .unwrap();
    let reservations = core.producer_reservations().unwrap();
    assert_eq!(reservations.len(), 1);
    assert_eq!(reservations[0].phase(), history::ProducerPhase::Unarmed);
    let reference = serde_json::to_value(reservations[0].reference()).unwrap();
    let before = directory_bytes(f.temp.path());
    assert_eq!(
        f.service
            .prepare_native_file_move("main", &f.owner, f.request("main.typ", "moved.typ"))
            .await
            .unwrap_err()
            .code,
        "busy"
    );
    assert_eq!(directory_bytes(f.temp.path()), before);
    assert_eq!(
        serde_json::to_value(core.producer_reservations().unwrap()[0].reference()).unwrap(),
        reference
    );
    f.original();
    assert!(!f.project.root.join("moved.typ").exists());
    assert!(!store(&f.service.state).exists());
}

#[tokio::test]
async fn completed_history_keeps_old_exact_binding_and_new_destination_save_starts_new_source_lineage(
) {
    let mut f = Fixture::new();
    let content = "Genuine native saved content before Move\n";
    f.service
        .dispatch_native_source(
            "main",
            &f.owner,
            SourceRequest {
                operation: Operation::Save {
                    project: f.project.id.clone(),
                    path: "main.typ".into(),
                    revision: digest_bytes(&f.source),
                    content: content.into(),
                },
                source_epoch: 0,
                expected_root: Some(f.root),
            },
        )
        .await
        .unwrap();
    f.source = content.as_bytes().to_vec();
    f.review = fs::read(sidecar(&f.project.root.join("main.typ"))).unwrap();
    let before = history_versions(&f).await;
    assert_eq!(before.len(), 1);
    assert_eq!(before[0].binding.path, "main.typ");
    assert_eq!(before[0].binding.source_epoch, 0);
    assert_eq!(before[0].cause, "native_save");
    let saved = history_read(&f, &before[0]).await;
    let private = directory_bytes(&f.service.state.join("history-v1"));
    let p = f.prepare(f.request("main.typ", "moved.typ")).await;
    assert_eq!(f.commit(&p).await["status"], "moved");
    assert_eq!(
        directory_bytes(&f.service.state.join("history-v1")),
        private
    );
    let after = history_versions(&f).await;
    assert_eq!(after.len(), 1);
    assert_eq!(
        serde_json::to_value(&after).unwrap(),
        serde_json::to_value(&before).unwrap()
    );
    assert_eq!(history_read(&f, &before[0]).await, saved);
    let snapshot = f
        .service
        .dispatch_native_source(
            "main",
            &f.owner,
            SourceRequest {
                operation: Operation::Open {
                    project: f.project.id.clone(),
                    path: "moved.typ".into(),
                },
                source_epoch: 1,
                expected_root: Some(f.root),
            },
        )
        .await
        .unwrap();
    assert_eq!(snapshot["sourceEpoch"], 1);
    f.service
        .dispatch_native_source(
            "main",
            &f.owner,
            SourceRequest {
                operation: Operation::Save {
                    project: f.project.id.clone(),
                    path: "moved.typ".into(),
                    revision: digest(content),
                    content: "Native destination saved after Move\n".into(),
                },
                source_epoch: 1,
                expected_root: Some(f.root),
            },
        )
        .await
        .unwrap();
    let versions = history_versions(&f).await;
    assert_eq!(versions.len(), 2);
    let new = versions
        .iter()
        .find(|v| v.binding.path == "moved.typ")
        .unwrap();
    assert_eq!(new.binding.source_epoch, 1);
    assert_eq!(new.binding.root, f.root);
    assert_eq!(new.binding.project_id, f.project.id);
    assert_ne!(new.source_id, before[0].source_id);
    assert_eq!(new.cause, "native_save");
    assert_eq!(history_read(&f, &before[0]).await, saved);
    f.service
        .local_source_context(
            SourceRequest {
                operation: Operation::Share {
                    project: f.project.id.clone(),
                    path: "moved.typ".into(),
                    enabled: true,
                },
                source_epoch: 1,
                expected_root: Some(f.root),
            },
            Some(("main", &f.owner)),
        )
        .unwrap();
    let grants = lock(&f.service.shared).unwrap().clone();
    let collateral_before = collateral(&f);
    let versions_before = serde_json::to_value(history_versions(&f).await).unwrap();
    retire_generation(&f.service, &f.owner, "0").await.unwrap();
    assert_eq!(collateral(&f), collateral_before);
    assert_eq!(lock(&f.service.shared).unwrap().clone(), grants);
    assert_eq!(
        serde_json::to_value(history_versions(&f).await).unwrap(),
        versions_before
    );
    assert_eq!(history_read(&f, &before[0]).await, saved);
}

#[tokio::test]
async fn state_overlap_before_first_history_refuses_move_without_private_or_project_changes() {
    let mut admitted = Vec::new();
    for separate_approval in [false, true] {
        let temp = tempfile::tempdir().unwrap();
        let state_parent = temp.path().join("state-parent");
        fs::create_dir(&state_parent).unwrap();
        let state = state_parent.join("private");
        let root = if separate_approval {
            temp.path().join("project")
        } else {
            state_parent.clone()
        };
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join("main.typ"), "Saved source before first History").unwrap();
        let service = Service::new(state).unwrap();
        let added = service
            .local(Operation::AddProject {
                root: root.to_str().unwrap().into(),
            })
            .unwrap();
        if separate_approval {
            service
                .local(Operation::AddProject {
                    root: state_parent.to_str().unwrap().into(),
                })
                .unwrap();
        }
        assert!(lock(&service.registry).unwrap().history_store_id.is_none());
        let owner = service.connect_native_editor("main").unwrap()["ownerId"]
            .as_str()
            .unwrap()
            .to_owned();
        let before = directory_bytes(temp.path());
        let result = service
            .prepare_native_file_move(
                "main",
                &owner,
                MovePrepare {
                    generation: "0".into(),
                    request_id: Uuid::new_v4().to_string(),
                    project: added["id"].as_str().unwrap().into(),
                    from: "main.typ".into(),
                    to: "moved.typ".into(),
                    source_epoch: 0,
                    expected_root: RootedRoot::observe(&root).unwrap(),
                    revision: digest("Saved source before first History"),
                    sidecar_revision: None,
                },
            )
            .await;
        match result {
            Ok(_) => admitted.push(separate_approval),
            Err(error) => {
                assert_eq!(error.code, "move_state_overlap");
                assert!(!store(&service.state).exists());
                assert_eq!(directory_bytes(temp.path()), before);
                assert!(lock(&service.registry).unwrap().history_store_id.is_none());
                assert_eq!(
                    retire_generation(&service, &owner, "0")
                        .await
                        .unwrap_err()
                        .code,
                    "move_state_overlap"
                );
                assert!(!store(&service.state).exists());
                assert_eq!(directory_bytes(temp.path()), before);
            }
        }
    }
    assert!(
        admitted.is_empty(),
        "Move admitted private-state overlap before History; separate approved root cases: {admitted:?}"
    );
}

#[tokio::test]
async fn late_overlapping_project_approval_preserves_prepared_accepted_and_completed_move_proofs() {
    let mut admitted = Vec::new();
    for status in [
        "empty_marker",
        "retired_generation",
        "prepared",
        "recovery_required",
        "moved",
    ] {
        let f = Fixture::new();
        if status == "empty_marker" {
            fs::create_dir(store(&f.service.state)).unwrap();
            fs::set_permissions(store(&f.service.state), fs::Permissions::from_mode(0o700))
                .unwrap();
        } else if status == "retired_generation" {
            retire_generation(&f.service, &f.owner, "0").await.unwrap();
        } else {
            let prepared = f.prepare(f.request("main.typ", "moved.typ")).await;
            if status == "recovery_required" {
                f.hook(1, || Err(Error::new("io", "finite accepted interruption")));
            }
            if status != "prepared" {
                assert_eq!(f.commit(&prepared).await["status"], status);
            }
        }
        assert!(lock(&f.service.registry)
            .unwrap()
            .history_store_id
            .is_none());
        let before = directory_bytes(f.temp.path());
        let result = f.service.local(Operation::AddProject {
            root: f.service.state.to_str().unwrap().into(),
        });
        match result {
            Ok(_) => admitted.push(status),
            Err(error) => {
                assert_eq!(error.code, "move_state_overlap");
                assert_eq!(directory_bytes(f.temp.path()), before);
            }
        }
    }
    assert!(
        admitted.is_empty(),
        "AddProject exposed existing Move proofs in states {admitted:?}"
    );
}

#[tokio::test]
async fn startup_overlap_refusal_preserves_genuine_prepared_intent_before_cancellation() {
    let f = Fixture::new();
    let prepared = f.prepare(f.request("main.typ", "moved.typ")).await;
    let intent = directory(&f.service.state, prepared["moveId"].as_str().unwrap())
        .unwrap()
        .join("intent.json");
    let original_intent = fs::read(&intent).unwrap();
    assert_eq!(
        serde_json::from_slice::<Value>(&original_intent).unwrap()["status"],
        "prepared"
    );
    // Model a valid approval persisted by the earlier implementation, which admitted private-state roots.
    let mut registry = lock(&f.service.registry).unwrap().clone();
    assert!(registry.history_store_id.is_none());
    let mut overlapping = f.project.clone();
    overlapping.id = Uuid::new_v4().to_string();
    overlapping.root = f.service.state.clone();
    overlapping.name = "Legacy overlapping approval".into();
    overlapping.main_document.clear();
    overlapping.pending.clear();
    overlapping.pending_revisions.clear();
    registry.projects.push(overlapping);
    fs::write(
        f.service.state.join("projects.json"),
        serde_json::to_vec_pretty(&registry).unwrap(),
    )
    .unwrap();
    let before = directory_bytes(f.temp.path());
    let error = match Service::new(f.service.state.clone()) {
        Ok(_) => panic!("startup accepted a project exposing existing private Move proof"),
        Err(error) => error,
    };
    assert_eq!(error.code, "move_state_overlap");
    assert_eq!(fs::read(intent).unwrap(), original_intent);
    assert_eq!(directory_bytes(f.temp.path()), before);
}

async fn retire_generation(service: &Arc<Service>, owner: &str, generation: &str) -> Result<Value> {
    service
        .file_move_native(
            "main",
            owner,
            MoveOperation::MoveRetireTerminal {
                generation: generation.into(),
            },
        )
        .await
}
async fn cancel_prepared(f: &Fixture, prepared: &Value) -> Value {
    f.service
        .file_move_native(
            "main",
            &f.owner,
            MoveOperation::MoveCancel {
                generation: prepared["generation"].as_str().unwrap().into(),
                move_id: prepared["moveId"].as_str().unwrap().into(),
                request_id: prepared["requestId"].as_str().unwrap().into(),
            },
        )
        .await
        .unwrap()
}
fn collateral(f: &Fixture) -> BTreeMap<PathBuf, Vec<u8>> {
    directory_bytes(f.temp.path())
        .into_iter()
        .filter(|(p, _)| !p.starts_with("state/file-moves"))
        .collect()
}

#[tokio::test]
async fn generation_wire_and_empty_retirement_fence_every_old_callback_without_source_effects() {
    let f = Fixture::new();
    let original = directory_bytes(f.temp.path());
    assert_eq!(
        listed(&f.service, &f.owner).await,
        json!({"generation":"0","moves":[]})
    );
    assert_eq!(directory_bytes(f.temp.path()), original);
    let old = f.request("main.typ", "moved.typ");
    let id = old.request_id.clone();
    let move_id = Uuid::new_v4().to_string();
    for generation in [
        "",
        "00",
        "+0",
        "-1",
        " 0",
        "0 ",
        "0.0",
        "18446744073709551616",
    ] {
        let mut bad = old.clone();
        bad.generation = generation.into();
        assert_eq!(
            f.service
                .prepare_native_file_move("main", &f.owner, bad)
                .await
                .unwrap_err()
                .code,
            "format"
        );
    }
    for action in [
        "move_commit",
        "move_status",
        "move_cancel",
        "move_reconcile",
        "move_retire_terminal",
    ] {
        let mut value = json!({"action":action,"generation":"0"});
        if action != "move_retire_terminal" {
            value["requestId"] = json!(id);
        }
        if action == "move_commit" || action == "move_cancel" {
            value["moveId"] = json!(move_id);
        }
        assert!(serde_json::from_value::<MoveOperation>(value.clone()).is_ok());
        for bad in [json!(0), Value::Null, json!(false)] {
            let mut bad_value = value.clone();
            bad_value["generation"] = bad;
            assert!(serde_json::from_value::<MoveOperation>(bad_value).is_err());
        }
        let mut missing = value.clone();
        missing.as_object_mut().unwrap().remove("generation");
        assert!(serde_json::from_value::<MoveOperation>(missing).is_err());
        value["unexpected"] = json!(true);
        assert!(serde_json::from_value::<MoveOperation>(value).is_err());
    }
    assert_eq!(generation_number("18446744073709551615").unwrap(), u64::MAX);
    assert_eq!(directory_bytes(f.temp.path()), original);
    let before = collateral(&f);
    assert_eq!(
        retire_generation(&f.service, &f.owner, "0").await.unwrap(),
        json!({"retiredGeneration":"0","generation":"1","retiredCount":0})
    );
    assert_eq!(collateral(&f), before);
    assert_eq!(
        listed(&f.service, &f.owner).await,
        json!({"generation":"1","moves":[]})
    );
    assert_eq!(fs::read_dir(store(&f.service.state)).unwrap().count(), 2);
    assert_eq!(
        f.service
            .prepare_native_file_move("main", &f.owner, old.clone())
            .await
            .unwrap_err()
            .code,
        "move_generation_stale"
    );
    let operations = [
        MoveOperation::MoveStatus {
            generation: "0".into(),
            request_id: id.clone(),
        },
        MoveOperation::MoveCommit {
            generation: "0".into(),
            move_id: move_id.clone(),
            request_id: id.clone(),
        },
        MoveOperation::MoveCancel {
            generation: "0".into(),
            move_id,
            request_id: id.clone(),
        },
        MoveOperation::MoveReconcile {
            generation: "0".into(),
            request_id: id.clone(),
        },
        MoveOperation::MoveRetireTerminal {
            generation: "0".into(),
        },
    ];
    let before = directory_bytes(f.temp.path());
    for operation in operations {
        assert_eq!(
            f.service
                .file_move_native("main", &f.owner, operation)
                .await
                .unwrap_err()
                .code,
            "move_generation_stale"
        );
    }
    assert_eq!(directory_bytes(f.temp.path()), before);
    let mut fresh = old;
    fresh.generation = "1".into();
    let prepared = f.prepare(fresh).await;
    assert_eq!(prepared["requestId"], id);
    assert_eq!(prepared["generation"], "1");
    assert_eq!(
        f.service
            .file_move_native(
                "main",
                &f.owner,
                MoveOperation::MoveStatus {
                    generation: "0".into(),
                    request_id: id
                }
            )
            .await
            .unwrap_err()
            .code,
        "move_generation_stale"
    );
    let (service, owner) = f.restart();
    assert_eq!(listed(&service, &owner).await["generation"], "1");
    assert_eq!(
        listed(&service, &owner).await["moves"][0]["status"],
        "cancelled"
    );
    retire_generation(&service, &owner, "1").await.unwrap();
    let mut reused = f.request("main.typ", "moved.typ");
    reused.generation = "2".into();
    reused.request_id = prepared["requestId"].as_str().unwrap().into();
    let fresh = service
        .prepare_native_file_move("main", &owner, reused)
        .await
        .unwrap();
    assert_eq!(fresh["requestId"], prepared["requestId"]);
    assert_ne!(fresh["moveId"], prepared["moveId"]);
    let before = directory_bytes(f.temp.path());
    for operation in [
        MoveOperation::MoveStatus {
            generation: "1".into(),
            request_id: prepared["requestId"].as_str().unwrap().into(),
        },
        MoveOperation::MoveCommit {
            generation: "1".into(),
            move_id: prepared["moveId"].as_str().unwrap().into(),
            request_id: prepared["requestId"].as_str().unwrap().into(),
        },
        MoveOperation::MoveCancel {
            generation: "1".into(),
            move_id: prepared["moveId"].as_str().unwrap().into(),
            request_id: prepared["requestId"].as_str().unwrap().into(),
        },
        MoveOperation::MoveReconcile {
            generation: "1".into(),
            request_id: prepared["requestId"].as_str().unwrap().into(),
        },
    ] {
        assert_eq!(
            service
                .file_move_native("main", &owner, operation)
                .await
                .unwrap_err()
                .code,
            "move_generation_stale"
        );
    }
    assert_eq!(directory_bytes(f.temp.path()), before);
    f.original();
}

#[tokio::test]
async fn permanent_initialization_witness_prevents_missing_control_generation_reset() {
    for damage in [
        "missing_control",
        "missing_witness",
        "bad_control",
        "bad_witness",
        "linked_control",
        "linked_witness",
        "hard_control",
        "hard_witness",
        "unknown",
    ] {
        let f = Fixture::new();
        let old = f.request("main.typ", "moved.typ");
        retire_generation(&f.service, &f.owner, "0").await.unwrap();
        let root = store(&f.service.state);
        let name = if damage.ends_with("witness") {
            INITIALIZED
        } else {
            CONTROL
        };
        let path = root.join(name);
        match damage {
            "missing_control" | "missing_witness" => fs::remove_file(&path).unwrap(),
            "bad_control" | "bad_witness" => {
                fs::write(&path, b"{\"version\":1,\"unexpected\":true}").unwrap()
            }
            "linked_control" | "linked_witness" => {
                let target = f.temp.path().join("kept-control");
                fs::rename(&path, &target).unwrap();
                std::os::unix::fs::symlink(&target, &path).unwrap();
            }
            "hard_control" | "hard_witness" => {
                fs::hard_link(&path, f.temp.path().join("linked-control")).unwrap()
            }
            "unknown" => fs::write(root.join("unrecognized"), b"preserve").unwrap(),
            _ => unreachable!(),
        }
        let before = directory_bytes(f.temp.path());
        assert!(Service::new(f.service.state.clone()).is_err(), "{damage}");
        assert_eq!(directory_bytes(f.temp.path()), before, "{damage}");
        assert_eq!(
            f.service
                .prepare_native_file_move("main", &f.owner, old)
                .await
                .unwrap_err()
                .code,
            "move_generation_stale"
        );
        f.original();
    }
}

#[tokio::test]
async fn interrupted_first_witness_install_fails_closed_without_reset_or_source_effects() {
    let f = Fixture::new();
    let before = collateral(&f);
    f.hook(27, || {
        Err(Error::new("io", "cut after first durable witness"))
    });
    assert_eq!(
        retire_generation(&f.service, &f.owner, "0")
            .await
            .unwrap_err()
            .code,
        "outcome_unknown"
    );
    assert!(store(&f.service.state).join(INITIALIZED).is_file());
    assert!(!store(&f.service.state).join(CONTROL).exists());
    assert_eq!(
        f.service
            .file_move_native("main", &f.owner, MoveOperation::MoveList {})
            .await
            .unwrap_err()
            .code,
        "move_maintenance"
    );
    assert!(Service::new(f.service.state.clone()).is_err());
    assert_eq!(collateral(&f), before);
    f.original();
}

#[tokio::test]
async fn terminal_retirement_crash_cuts_resume_only_authorized_private_cleanup() {
    for point in [20, 30, 31, 21, 22, 23, 24, 25] {
        let f = Fixture::new();
        let prepared = f.prepare(f.request("main.typ", "moved.typ")).await;
        cancel_prepared(&f, &prepared).await;
        let before = collateral(&f);
        f.hook(point, || {
            Err(Error::new("io", "finite retirement crash cut"))
        });
        assert_eq!(
            retire_generation(&f.service, &f.owner, "0")
                .await
                .unwrap_err()
                .code,
            "outcome_unknown",
            "{point}"
        );
        assert_eq!(
            f.service
                .file_move_native("main", &f.owner, MoveOperation::MoveList {})
                .await
                .unwrap_err()
                .code,
            "move_maintenance"
        );
        let (service, owner) = f.restart();
        assert_eq!(
            listed(&service, &owner).await,
            json!({"generation":"1","moves":[]}),
            "{point}"
        );
        assert_eq!(fs::read_dir(store(&service.state)).unwrap().count(), 2);
        assert_eq!(collateral(&f), before, "{point}");
        f.original();
    }
}

#[tokio::test]
async fn retirement_refuses_unknown_or_replaced_private_bytes() {
    for damage in [
        "unknown_root",
        "unknown_child",
        "changed_proof",
        "proof_symlink",
        "proof_hardlink",
    ] {
        let f = Fixture::new();
        let prepared = f.prepare(f.request("main.typ", "moved.typ")).await;
        cancel_prepared(&f, &prepared).await;
        let dir = directory(&f.service.state, prepared["moveId"].as_str().unwrap()).unwrap();
        let generation = "0".to_string();
        match damage {
            "unknown_root" => fs::write(store(&f.service.state).join("unknown"), b"keep").unwrap(),
            "unknown_child" => fs::write(dir.join("unknown"), b"keep").unwrap(),
            "changed_proof" => fs::write(dir.join("source"), b"changed").unwrap(),
            "proof_symlink" => {
                fs::remove_file(dir.join("source")).unwrap();
                std::os::unix::fs::symlink(f.project.root.join("main.typ"), dir.join("source"))
                    .unwrap();
            }
            "proof_hardlink" => {
                fs::hard_link(dir.join("source"), f.temp.path().join("kept-proof")).unwrap()
            }
            _ => unreachable!(),
        }
        let before = directory_bytes(f.temp.path());
        assert!(
            retire_generation(&f.service, &f.owner, &generation)
                .await
                .is_err(),
            "{damage}"
        );
        assert_eq!(directory_bytes(f.temp.path()), before, "{damage}");
        assert!(!store(&f.service.state).join(INITIALIZED).exists());
        f.original();
    }
}

#[tokio::test]
async fn retirement_journal_unknown_residue_is_preserved_on_restart() {
    for damage in ["unknown", "changed_proof", "changed_intent"] {
        let f = Fixture::new();
        let prepared = f.prepare(f.request("main.typ", "moved.typ")).await;
        cancel_prepared(&f, &prepared).await;
        f.hook(20, || {
            Err(Error::new("io", "hold explicit journal before cleanup"))
        });
        assert_eq!(
            retire_generation(&f.service, &f.owner, "0")
                .await
                .unwrap_err()
                .code,
            "outcome_unknown"
        );
        let dir = directory(&f.service.state, prepared["moveId"].as_str().unwrap()).unwrap();
        match damage {
            "unknown" => fs::write(dir.join("unrecognized"), b"keep").unwrap(),
            "changed_proof" => fs::write(dir.join("source"), b"keep changed bytes").unwrap(),
            "changed_intent" => fs::write(dir.join("intent.json"), b"{}").unwrap(),
            _ => unreachable!(),
        }
        let before = directory_bytes(f.temp.path());
        assert!(Service::new(f.service.state.clone()).is_err(), "{damage}");
        assert_eq!(directory_bytes(f.temp.path()), before, "{damage}");
        f.original();
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn unlisted_prepare_worker_blocks_rotation_even_after_its_waiter_is_dropped() {
    let f = Fixture::new();
    let request = f.request("main.typ", "moved.typ");
    let id = request.request_id.clone();
    let (arrived, ready) = tokio::sync::oneshot::channel();
    let (release, waiting) = std::sync::mpsc::channel();
    let (done, finished) = tokio::sync::oneshot::channel();
    f.hook(28, move || {
        arrived.send(()).unwrap();
        waiting.recv().unwrap();
        done.send(()).unwrap();
        Ok(())
    });
    let caller = {
        let service = f.service.clone();
        let owner = f.owner.clone();
        tokio::spawn(async move {
            service
                .prepare_native_file_move("main", &owner, request)
                .await
        })
    };
    ready.await.unwrap();
    caller.abort();
    assert_eq!(
        listed(&f.service, &f.owner).await,
        json!({"generation":"0","moves":[]})
    );
    assert_eq!(
        f.service
            .file_move_native(
                "main",
                &f.owner,
                MoveOperation::MoveStatus {
                    generation: "0".into(),
                    request_id: id.clone()
                }
            )
            .await
            .unwrap()["status"],
        "unknown"
    );
    assert_eq!(
        retire_generation(&f.service, &f.owner, "0")
            .await
            .unwrap_err()
            .code,
        "busy"
    );
    assert!(f.service.compile_lock.clone().try_lock_owned().is_err());
    assert!(f.service.sync_lock.clone().try_lock_owned().is_err());
    release.send(()).unwrap();
    finished.await.unwrap();
    let mut published = None;
    for _ in 0..200 {
        let list = listed(&f.service, &f.owner).await;
        if let Some(first) = list["moves"].as_array().unwrap().first() {
            published = Some(first.clone());
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
    let prepared = published.expect("real worker publishes after held proof boundary");
    for _ in 0..200 {
        if f.service.compile_lock.clone().try_lock_owned().is_ok()
            && f.service.sync_lock.clone().try_lock_owned().is_ok()
        {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
    assert_eq!(
        retire_generation(&f.service, &f.owner, "0")
            .await
            .unwrap_err()
            .code,
        "move_pending"
    );
    cancel_prepared(&f, &prepared).await;
    retire_generation(&f.service, &f.owner, "0").await.unwrap();
    f.original();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn retirement_page_and_waiter_lifetimes_follow_the_durable_native_decision() {
    let f = Fixture::new();
    let service = f.service.clone();
    f.hook(26, move || {
        service.connect_native_editor("main")?;
        Ok(())
    });
    assert_eq!(
        retire_generation(&f.service, &f.owner, "0")
            .await
            .unwrap_err()
            .code,
        "stale_session"
    );
    assert!(!store(&f.service.state).exists());
    f.original();

    let f = Fixture::new();
    let before = collateral(&f);
    let (arrived, ready) = tokio::sync::oneshot::channel();
    let (release, waiting) = std::sync::mpsc::channel();
    f.hook(20, move || {
        arrived.send(()).unwrap();
        waiting.recv().unwrap();
        Ok(())
    });
    let caller = {
        let service = f.service.clone();
        let owner = f.owner.clone();
        tokio::spawn(async move { retire_generation(&service, &owner, "0").await })
    };
    ready.await.unwrap();
    caller.abort();
    let owner = f.service.connect_native_editor("main").unwrap()["ownerId"]
        .as_str()
        .unwrap()
        .to_owned();
    assert!(f.service.compile_lock.clone().try_lock_owned().is_err());
    assert!(f.service.sync_lock.clone().try_lock_owned().is_err());
    assert_eq!(
        f.service
            .file_move_native("main", &owner, MoveOperation::MoveList {})
            .await
            .unwrap_err()
            .code,
        "move_maintenance"
    );
    release.send(()).unwrap();
    let mut finished = false;
    for _ in 0..200 {
        match f
            .service
            .file_move_native("main", &owner, MoveOperation::MoveList {})
            .await
        {
            Ok(list) => {
                assert_eq!(list, json!({"generation":"1","moves":[]}));
                finished = true;
                break;
            }
            Err(error) => assert_eq!(error.code, "move_maintenance"),
        };
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
    assert!(finished);
    assert_eq!(collateral(&f), before);
    f.original();
}

#[tokio::test]
async fn active_or_accepted_receipts_and_busy_producers_cannot_be_retired() {
    let f = Fixture::new();
    let prepared = f.prepare(f.request("main.typ", "moved.typ")).await;
    for expired in [false, true] {
        if expired {
            let mut moves = lock(&f.service.file_move).unwrap();
            let r = moves
                .records
                .get_mut(prepared["requestId"].as_str().unwrap())
                .unwrap();
            r.expires_at = 0;
            save_record(&f.service.state, r).unwrap();
        }
        let before = directory_bytes(f.temp.path());
        assert_eq!(
            retire_generation(&f.service, &f.owner, "0")
                .await
                .unwrap_err()
                .code,
            "move_pending"
        );
        assert_eq!(directory_bytes(f.temp.path()), before);
    }
    let f = Fixture::new();
    f.interrupted(1).await;
    let before = directory_bytes(f.temp.path());
    assert_eq!(
        retire_generation(&f.service, &f.owner, "0")
            .await
            .unwrap_err()
            .code,
        "move_pending"
    );
    assert_eq!(directory_bytes(f.temp.path()), before);
    assert!(f.service.move_project_available(&f.project.id).is_err());
    let f = Fixture::new();
    let before = directory_bytes(f.temp.path());
    let compile = f.service.compile_lock.clone().lock_owned().await;
    assert_eq!(
        retire_generation(&f.service, &f.owner, "0")
            .await
            .unwrap_err()
            .code,
        "busy"
    );
    drop(compile);
    let sync = f.service.sync_lock.clone().lock_owned().await;
    assert_eq!(
        retire_generation(&f.service, &f.owner, "0")
            .await
            .unwrap_err()
            .code,
        "busy"
    );
    drop(sync);
    assert_eq!(directory_bytes(f.temp.path()), before);
    f.original();
}

#[tokio::test]
async fn persisted_generation_exhaustion_refuses_before_any_retirement_write() {
    let f = Fixture::new();
    retire_generation(&f.service, &f.owner, "0").await.unwrap();
    write_control(
        &f.service.state,
        &Control::Ready {
            version: 1,
            generation: u64::MAX.to_string(),
        },
    )
    .unwrap();
    let (service, owner) = f.restart();
    let before = directory_bytes(f.temp.path());
    assert_eq!(
        listed(&service, &owner).await["generation"],
        u64::MAX.to_string()
    );
    assert_eq!(
        retire_generation(&service, &owner, &u64::MAX.to_string())
            .await
            .unwrap_err()
            .code,
        "limit"
    );
    assert_eq!(directory_bytes(f.temp.path()), before);
    f.original();
}

#[tokio::test]
async fn legacy_zero_generation_loader_preserves_accepted_bytes_and_never_defaults_public_requests()
{
    for status in ["prepared", "cancelled", "moved", "recovery_required"] {
        let f = Fixture::new();
        let prepared = f.prepare(f.request("main.typ", "moved.typ")).await;
        match status {
            "cancelled" => {
                cancel_prepared(&f, &prepared).await;
            }
            "moved" => {
                f.commit(&prepared).await;
            }
            "recovery_required" => {
                f.hook(1, || {
                    Err(Error::new("io", "actual accepted legacy fixture"))
                });
                f.commit(&prepared).await;
            }
            _ => {}
        }
        let path = directory(&f.service.state, prepared["moveId"].as_str().unwrap())
            .unwrap()
            .join("intent.json");
        let mut legacy: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        legacy["version"] = json!(1);
        legacy["request"]
            .as_object_mut()
            .unwrap()
            .remove("generation");
        atomic_write(&path, &serde_json::to_vec_pretty(&legacy).unwrap()).unwrap();
        assert!(serde_json::from_value::<MovePrepare>(legacy["request"].clone()).is_err());
        let raw = fs::read(&path).unwrap();
        let (service, owner) = f.restart();
        let before = directory_bytes(f.temp.path());
        let list = listed(&service, &owner).await;
        assert_eq!(list["generation"], "0");
        assert_eq!(list["moves"][0]["generation"], "0");
        assert_eq!(
            list["moves"][0]["status"],
            if status == "prepared" {
                "cancelled"
            } else {
                status
            }
        );
        if status != "prepared" {
            assert_eq!(fs::read(&path).unwrap(), raw);
        }
        assert_eq!(directory_bytes(f.temp.path()), before);
        assert!(!store(&service.state).join(INITIALIZED).exists());
        if status == "recovery_required" {
            assert_eq!(
                service
                    .file_move_native(
                        "main",
                        &owner,
                        MoveOperation::MoveReconcile {
                            generation: "0".into(),
                            request_id: prepared["requestId"].as_str().unwrap().into()
                        }
                    )
                    .await
                    .unwrap()["status"],
                "moved"
            );
        }
    }
    for nonzero_control in [false, true] {
        let f = Fixture::new();
        let prepared = f.prepare(f.request("main.typ", "moved.typ")).await;
        cancel_prepared(&f, &prepared).await;
        let path = directory(&f.service.state, prepared["moveId"].as_str().unwrap())
            .unwrap()
            .join("intent.json");
        let mut record: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        if nonzero_control {
            record["version"] = json!(1);
            record["request"]
                .as_object_mut()
                .unwrap()
                .remove("generation");
            initialize_control(&f.service.state).unwrap();
            write_control(
                &f.service.state,
                &Control::Ready {
                    version: 1,
                    generation: "1".into(),
                },
            )
            .unwrap();
        } else {
            record["request"]["generation"] = json!("1");
        }
        atomic_write(&path, &serde_json::to_vec_pretty(&record).unwrap()).unwrap();
        let before = directory_bytes(f.temp.path());
        assert!(Service::new(f.service.state.clone()).is_err());
        assert_eq!(directory_bytes(f.temp.path()), before);
        f.original();
    }
}

#[tokio::test]
async fn actual_tracked_move_receipt_stays_pinned_until_explicit_confirmed_sync() {
    let f = Fixture::new();
    let remote = f.temp.path().join("remote.git");
    git(f.temp.path(), &["init", "--bare", remote.to_str().unwrap()])
        .await
        .unwrap();
    git(&f.project.root, &["init", "-b", "main"]).await.unwrap();
    git(&f.project.root, &["config", "user.name", "Move test"])
        .await
        .unwrap();
    git(
        &f.project.root,
        &["config", "user.email", "move@example.invalid"],
    )
    .await
    .unwrap();
    git(
        &f.project.root,
        &[
            "add",
            "--",
            "main.typ",
            "main.typ.undertree-review.json",
            "main.typ.import-report.json",
        ],
    )
    .await
    .unwrap();
    git(&f.project.root, &["commit", "-m", "base"])
        .await
        .unwrap();
    git(
        &f.project.root,
        &["push", remote.to_str().unwrap(), "HEAD:refs/heads/main"],
    )
    .await
    .unwrap();
    let prepared = f.prepare(f.request("main.typ", "moved.typ")).await;
    assert_eq!(f.commit(&prepared).await["status"], "moved");
    let pending = lock(&f.service.registry).unwrap().pending_deletions[&f.project.id].clone();
    assert_eq!(pending.len(), 3);
    let before = directory_bytes(f.temp.path());
    assert_eq!(
        retire_generation(&f.service, &f.owner, "0")
            .await
            .unwrap_err()
            .code,
        "move_pending_sync"
    );
    assert_eq!(directory_bytes(f.temp.path()), before);
    let project = f.service.project(&f.project.id).unwrap();
    {
        let _sync = f.service.sync_lock.clone().lock_owned().await;
        assert!(f
            .service
            .sync_remote(
                &project,
                f.temp.path().join("absent.git").to_str().unwrap(),
                remote.to_str().unwrap()
            )
            .await
            .is_err());
    }
    assert_eq!(
        lock(&f.service.registry).unwrap().pending_deletions[&f.project.id],
        pending
    );
    assert_eq!(
        retire_generation(&f.service, &f.owner, "0")
            .await
            .unwrap_err()
            .code,
        "move_pending_sync"
    );
    assert!(f
        .service
        .move_source_available(&f.project.id, "main.typ")
        .is_err());
    {
        let _sync = f.service.sync_lock.clone().lock_owned().await;
        f.service
            .sync_remote(&project, remote.to_str().unwrap(), remote.to_str().unwrap())
            .await
            .unwrap();
    }
    assert!(lock(&f.service.registry)
        .unwrap()
        .pending_deletions
        .values()
        .all(|rows| rows.is_empty()));
    let before = collateral(&f);
    let index = fs::read(f.project.root.join(".git/index")).unwrap();
    let registry = fs::read(f.service.state.join("projects.json")).unwrap();
    assert_eq!(
        retire_generation(&f.service, &f.owner, "0").await.unwrap()["retiredCount"],
        1
    );
    assert_eq!(collateral(&f), before);
    assert_eq!(fs::read(f.project.root.join(".git/index")).unwrap(), index);
    assert_eq!(
        fs::read(f.service.state.join("projects.json")).unwrap(),
        registry
    );
    assert_eq!(
        fs::read(f.project.root.join("moved.typ")).unwrap(),
        f.source
    );
    assert!(!f.project.root.join("main.typ").exists());
    assert_eq!(
        f.service.source_epoch(&f.project.id, "main.typ").unwrap(),
        1
    );
    assert_eq!(
        f.service.source_epoch(&f.project.id, "moved.typ").unwrap(),
        1
    );
}

#[tokio::test]
async fn legacy_admission_never_normalizes_duplicate_private_authority_fields() {
    for legacy in [false, true] {
        let f = Fixture::new();
        let prepared = f.prepare(f.request("main.typ", "moved.typ")).await;
        cancel_prepared(&f, &prepared).await;
        let path = directory(&f.service.state, prepared["moveId"].as_str().unwrap())
            .unwrap()
            .join("intent.json");
        let mut value: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        if legacy {
            value["version"] = json!(1);
            value["request"]
                .as_object_mut()
                .unwrap()
                .remove("generation");
        }
        let raw = serde_json::to_string(&value).unwrap();
        let duplicate = format!("{{\"status\":\"cancelled\",{}", raw.trim_start_matches('{'));
        atomic_write(&path, duplicate.as_bytes()).unwrap();
        let before = directory_bytes(f.temp.path());
        assert!(
            Service::new(f.service.state.clone()).is_err(),
            "legacy{legacy}"
        );
        assert_eq!(directory_bytes(f.temp.path()), before);
        f.original();
    }
}
