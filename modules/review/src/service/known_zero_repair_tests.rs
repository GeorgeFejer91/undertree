//! Private candidate repair regressions: the original RED evidence is preserved separately.
use super::*;
use crate::capabilities::CallerContext;
use crate::service::{app_control::ControlOperation, editor::EditorOperation};
use crate::SourceRequest;
use std::time::Duration;

const ORIGINAL: &str =
    "#set page(paper: \"a4\")\n#set text(size: 11pt)\n\n= Manuscript\n\nStart writing here.\n";
struct Fixture {
    _temp: tempfile::TempDir,
    service: Arc<Service>,
    project: String,
    file: PathBuf,
    root: RootObservation,
    owner_id: String,
    _old: fs::File,
}
impl Fixture {
    fn new() -> Self {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("project");
        fs::create_dir(&root).unwrap();
        let file = root.join("main.typ");
        fs::write(&file, ORIGINAL).unwrap();
        let old = fs::File::open(&file).unwrap();
        let service = Service::new(temp.path().join("state")).unwrap();
        let project = service
            .local(Operation::AddProject {
                root: root.to_str().unwrap().into(),
            })
            .unwrap()["id"]
            .as_str()
            .unwrap()
            .to_owned();
        let root = RootedRoot::observe(&root).unwrap();
        let connected = service.connect_native_editor("main").unwrap();
        let owner_id = connected["ownerId"].as_str().unwrap().into();
        Self {
            _temp: temp,
            service,
            project,
            file,
            root,
            owner_id,
            _old: old,
        }
    }
    async fn native(&self, operation: Operation) -> Result<Value> {
        self.service
            .dispatch_native_source(
                "main",
                &self.owner_id,
                SourceRequest {
                    operation,
                    source_epoch: 0,
                    expected_root: Some(self.root),
                },
            )
            .await
    }
    async fn editor(&self, input: Value) -> Result<Value> {
        self.service
            .editor_native(
                "main",
                &self.owner_id,
                serde_json::from_value::<EditorOperation>(input).unwrap(),
            )
            .await
    }
    async fn control(&self, input: Value) -> Result<Value> {
        let owner = self
            .service
            .native_editor_owner("main", &self.owner_id)
            .unwrap();
        self.service
            .control_as(
                CallerContext::Local,
                &owner,
                serde_json::from_value::<ControlOperation>(input).unwrap(),
            )
            .await
    }
    async fn recreate(&self) -> Value {
        assert!(!sidecar(&self.file).exists());
        assert!(!journal_path(&self.file).exists());
        fs::remove_file(&self.file).unwrap();
        self.native(Operation::Create {
            project: self.project.clone(),
            path: "main.typ".into(),
        })
        .await
        .unwrap()
    }
    fn observations(&self) -> Value {
        json!({"source":fs::read_to_string(&self.file).unwrap(),"sourceSha256":digest(&fs::read_to_string(&self.file).unwrap()),"sourceInode":std::os::unix::fs::MetadataExt::ino(&fs::metadata(&self.file).unwrap()).to_string(),"originalInode":std::os::unix::fs::MetadataExt::ino(&self._old.metadata().unwrap()).to_string(),"sidecar":fs::read_to_string(sidecar(&self.file)).ok(),"journalExists":journal_path(&self.file).exists(),"registry":serde_json::from_str::<Value>(&fs::read_to_string(self.service.state.join("projects.json")).unwrap()).unwrap(),"sharedCount":lock(&self.service.shared).unwrap().len()})
    }
    fn record(&self, name: &str, value: Value) {
        if let Some(directory) = std::env::var_os("UNDERTREE_ZERO_PROBE_EVIDENCE") {
            fs::write(
                PathBuf::from(directory).join(name),
                serde_json::to_vec_pretty(&value).unwrap(),
            )
            .unwrap();
        }
    }
}
fn observed(result: &Result<Value>) -> Value {
    match result {
        Ok(v) => json!({"ok":true,"result":v}),
        Err(e) => json!({"ok":false,"error":e}),
    }
}

#[tokio::test]
async fn active_share_zero_cannot_read_propose_or_execute_old_app_job_after_create_reuse() {
    let f = Fixture::new();
    let shared = f
        .native(Operation::Share {
            project: f.project.clone(),
            path: "main.typ".into(),
            enabled: true,
        })
        .await
        .unwrap();
    assert_eq!(shared["sourceEpoch"], 0);
    assert!(!sidecar(&f.file).exists());
    let child = Command::new("cat")
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .unwrap();
    let child_pid = child.id().unwrap();
    let (shutdown, _) = tokio::sync::oneshot::channel();
    *f.service.tunnel.lock().await = Some(Tunnel {
        session_id: uuid::Uuid::new_v4(),
        endpoint: "https://fixture.invalid/mcp/review-fixture".into(),
        secret: "synthetic-zero-probe".into(),
        child,
        shutdown,
        mcp_initialized: false,
        last_activity_ms: 0,
        tool_calls: 0,
    });
    f.control(json!({"action":"control_enable","enabled":true}))
        .await
        .unwrap();
    let snapshot = json!({"openDocuments":[{"documentId":shared["documentId"],"revision":digest(ORIGINAL),"dirty":false,"conflict":false,"composing":false}],"activeDocumentId":shared["documentId"],"preview":null,"view":{"filesVisible":true,"editorVisible":true,"previewVisible":false,"reviewVisible":false,"outlineVisible":false,"logsVisible":false},"editor":{"fontSize":12,"wordWrap":true}});
    f.control(json!({"action":"control_poll","snapshot":snapshot}))
        .await
        .unwrap();
    let request = Uuid::new_v4().to_string();
    f.service
        .app_remote(
            "open_manuscript",
            json!({"requestId":request,"documentId":shared["documentId"]}),
        )
        .unwrap();
    let jobs = f
        .control(json!({"action":"control_poll","snapshot":snapshot}))
        .await
        .unwrap();
    let ack = jobs["jobs"][0]["ackToken"].clone();
    assert!(ack.is_string());
    let before = f.observations();
    let created = f.recreate().await;
    let after_create = f.observations();
    let read = f.service.remote(
        "read_manuscript",
        json!({"documentId":shared["documentId"]}),
    );
    let check = f
        .control(json!({"action":"control_check","requestId":request,"ackToken":ack}))
        .await;
    let open = f
        .control(json!({"action":"control_open","requestId":request,"ackToken":ack}))
        .await;
    let after_reads = f.observations();
    let from = ORIGINAL.find("Start writing here.").unwrap();
    let propose=f.service.remote("suggest_text",json!({"documentId":shared["documentId"],"proposal":{"requestId":"old-share-targets-new-occupant","revision":digest(ORIGINAL),"from":from,"to":from+"Start writing here.".len(),"quote":"Start writing here.","replacement":"Old-grant suggestion for replacement occupant.","rationale":"Synthetic security assessment."}}));
    let after_proposal = f.observations();
    let mut tunnel = f.service.tunnel.lock().await.take().unwrap();
    tunnel.child.kill().await.unwrap();
    let exit = tunnel.child.wait().await.unwrap();
    f.record("active-share-zero.json",json!({"before":before,"created":created,"afterCreate":after_create,"oldRead":observed(&read),"oldControlCheck":observed(&check),"oldControlOpen":observed(&open),"afterReads":after_reads,"oldPropose":observed(&propose),"afterProposal":after_proposal,"ownedChildPid":child_pid,"ownedChildWaited":true,"ownedChildExit":exit.code(),"nativeOwnerProof":"actual main-window owner API; ownerId/ack and synthetic bearer omitted"}));
    for denied in [&read, &check, &open, &propose] {
        assert_eq!(denied.as_ref().unwrap_err().code, "scope");
    }
    assert_eq!(created["sourceEpoch"], 1);
    assert_eq!(created["shared"], false);
    assert_eq!(after_create, after_reads);
    assert_eq!(after_create, after_proposal);
    let enrolled = f
        .service
        .dispatch_native_source(
            "main",
            &f.owner_id,
            SourceRequest {
                operation: Operation::Share {
                    project: f.project.clone(),
                    path: "main.typ".into(),
                    enabled: true,
                },
                source_epoch: 1,
                expected_root: Some(f.root),
            },
        )
        .await
        .unwrap();
    assert_ne!(enrolled["documentId"], shared["documentId"]);
    assert_eq!(
        f.service
            .remote(
                "read_manuscript",
                json!({"documentId":shared["documentId"]})
            )
            .unwrap_err()
            .code,
        "scope"
    );
}

#[tokio::test]
async fn queued_registered_editor_zero_cannot_save_recreated_same_byte_occupant() {
    let f = Fixture::new();
    let changed = "Queued editor content from original occupant";
    let registered=f.editor(json!({"action":"editor_register","project":f.project,"path":"main.typ","sourceEpoch":0,"expectedRoot":f.root,"generation":1,"revision":digest(ORIGINAL),"contentDigest":digest(changed),"dirty":true,"composing":false,"conflict":false})).await.unwrap();
    assert_eq!(registered["sourceEpoch"], 0);
    assert!(!sidecar(&f.file).exists());
    let request = Uuid::new_v4().to_string();
    let service = f.service.clone();
    let project = f.project.clone();
    let queued_id = request.clone();
    let waiter = tokio::spawn(async move {
        service
            .dispatch_as(
                CallerContext::LocalCli,
                Operation::SaveEditor {
                    project,
                    path: "main.typ".into(),
                    request_id: queued_id,
                },
            )
            .await
    });
    let mut pending = None;
    for _ in 0..100 {
        let polled = f.editor(json!({"action":"editor_poll"})).await.unwrap();
        if let Some(job) = polled["requests"].as_array().unwrap().first() {
            pending = Some(job.clone());
            break;
        }
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    let pending = pending.expect("real CLI save must queue before external deletion");
    let before = f.observations();
    let created = f.recreate().await;
    let after_create = f.observations();
    let saved=f.editor(json!({"action":"editor_commit","requestId":request,"ticket":pending["ticket"],"sessionId":pending["sessionId"],"generation":1,"revision":digest(ORIGINAL),"content":changed})).await;
    if saved.is_err() {
        f.editor(json!({"action":"editor_unregister","sessionId":pending["sessionId"]}))
            .await
            .unwrap();
    }
    let completion = if saved.is_ok() {
        Some(f.editor(json!({"action":"editor_complete","requestId":request,"ticket":pending["ticket"],"sessionId":pending["sessionId"],"status":"saved","generation":1})).await)
    } else {
        None
    };
    let waiter_result = tokio::time::timeout(Duration::from_secs(2), waiter).await;
    let receipt = f.service.editor_save_receipt(&request);
    let after_save = f.observations();
    f.record("queued-editor-zero.json",json!({"before":before,"registeredEpoch":registered["sourceEpoch"],"registeredRoot":registered["expectedRoot"],"created":created,"afterCreate":after_create,"oldEditorCommit":observed(&saved),"completion":completion.as_ref().map(observed),"cliWaiterCompleted":waiter_result.is_ok(),"receipt":observed(&receipt),"afterSave":after_save,"nativeOwnerProof":"actual main-window register/commit API; ticket/ownerId omitted"}));
    assert_eq!(saved.as_ref().unwrap_err().code, "stale_document");
    assert_eq!(created["sourceEpoch"], 1);
    assert_eq!(after_save["source"], after_create["source"]);
    assert_eq!(after_save["sidecar"], after_create["sidecar"]);
}

#[tokio::test]
async fn genuinely_unobserved_first_create_retains_zero() {
    let f = Fixture::new();
    let before = f.observations();
    let created = f
        .native(Operation::Create {
            project: f.project.clone(),
            path: "fresh.typ".into(),
        })
        .await
        .unwrap();
    f.record(
        "unobserved-first-create.json",
        json!({"before":before,"created":created,"after":f.observations()}),
    );
    assert_eq!(created["sourceEpoch"], 0);
}

#[tokio::test]
async fn explicit_recorded_zero_create_rotates_without_ephemeral_captures() {
    let f = Fixture::new();
    {
        let mut registry = lock(&f.service.registry).unwrap();
        registry
            .source_epochs
            .entry(f.project.clone())
            .or_default()
            .insert("main.typ".into(), 0);
        f.service.save_registry(&registry).unwrap();
    }
    let created = f.recreate().await;
    assert_eq!(created["sourceEpoch"], 1);
    assert_eq!(f.service.source_epoch(&f.project, "main.typ").unwrap(), 1);
}

#[tokio::test]
async fn known_zero_create_reserves_before_names_and_keeps_consumed_one_after_later_failure() {
    for before in [true, false] {
        let f = Fixture::new();
        let shared = f
            .native(Operation::Share {
                project: f.project.clone(),
                path: "main.typ".into(),
                enabled: true,
            })
            .await
            .unwrap();
        let config = f.service.state.join("projects.json");
        let old = fs::read(&config).unwrap();
        let saved = Arc::new(Mutex::new(None));
        if before {
            fs::remove_file(&config).unwrap();
            fs::create_dir(&config).unwrap();
        } else {
            let config = config.clone();
            let saved = saved.clone();
            *lock(&f.service.create_after_publish).unwrap() = Some(Box::new(move || {
                *saved.lock().unwrap() = Some(fs::read(&config)?);
                fs::remove_file(&config)?;
                fs::create_dir(&config)?;
                Ok(())
            }));
        }
        fs::remove_file(&f.file).unwrap();
        let result = f
            .native(Operation::Create {
                project: f.project.clone(),
                path: "main.typ".into(),
            })
            .await;
        assert!(result.is_err());
        if before {
            assert!(!f.file.exists());
            assert!(!sidecar(&f.file).exists());
            assert_eq!(f.service.source_epoch(&f.project, "main.typ").unwrap(), 0);
        } else {
            assert_eq!(result.unwrap_err().code, "outcome_unknown");
            assert_eq!(f.service.source_epoch(&f.project, "main.typ").unwrap(), 1);
            assert_eq!(fs::read_to_string(&f.file).unwrap(), ORIGINAL);
            assert_eq!(
                f.service
                    .remote(
                        "read_manuscript",
                        json!({"documentId":shared["documentId"]})
                    )
                    .unwrap_err()
                    .code,
                "scope"
            );
            assert!(f.service.project(&f.project).unwrap().pending.is_empty());
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
        let restarted = Service::new(f.service.state.clone()).unwrap();
        assert_eq!(
            restarted.source_epoch(&f.project, "main.typ").unwrap(),
            if before { 0 } else { 1 }
        );
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn qualified_legacy_create_retains_editor_guard_and_late_old_registration_cannot_interleave()
{
    let f = Fixture::new();
    f.native(Operation::Share {
        project: f.project.clone(),
        path: "main.typ".into(),
        enabled: true,
    })
    .await
    .unwrap();
    fs::remove_file(&f.file).unwrap();
    let (entered, wait_entered) = std::sync::mpsc::channel();
    let (resume, wait_resume) = std::sync::mpsc::channel();
    *lock(&f.service.create_after_publish).unwrap() = Some(Box::new(move || {
        entered.send(()).unwrap();
        wait_resume.recv_timeout(Duration::from_secs(5)).unwrap();
        Ok(())
    }));
    let service = f.service.clone();
    let project = f.project.clone();
    let worker = std::thread::spawn(move || {
        service.local(Operation::Create {
            project,
            path: "main.typ".into(),
        })
    });
    wait_entered.recv_timeout(Duration::from_secs(5)).unwrap();
    let retained_editor_guard = f.service.editor.try_lock().is_err();
    let service = f.service.clone();
    let project = f.project.clone();
    let owner = f.owner_id.clone();
    let root = f.root;
    let register = tokio::spawn(async move {
        service.editor_native("main",&owner,serde_json::from_value(json!({"action":"editor_register","project":project,"path":"main.typ","sourceEpoch":0,"expectedRoot":root,"generation":0,"revision":digest(ORIGINAL),"contentDigest":digest(ORIGINAL),"dirty":false,"composing":false,"conflict":false})).unwrap()).await
    });
    resume.send(()).unwrap();
    let created = worker.join().unwrap().unwrap();
    let registered = register.await.unwrap();
    assert!(retained_editor_guard);
    assert_eq!(created["sourceEpoch"], 1);
    assert_eq!(registered.unwrap_err().code, "stale_document");
}

#[tokio::test]
async fn tex_import_rotates_known_zero_target_without_rewriting_input() {
    let f = Fixture::new();
    let shared = f
        .native(Operation::Share {
            project: f.project.clone(),
            path: "main.typ".into(),
            enabled: true,
        })
        .await
        .unwrap();
    let input = "\\documentclass{article}\n\\begin{document}\nHello.\n\\end{document}\n";
    fs::write(f.file.parent().unwrap().join("input.tex"), input).unwrap();
    fs::remove_file(&f.file).unwrap();
    let imported = f
        .native(Operation::ImportTex {
            project: f.project.clone(),
            path: "input.tex".into(),
            target: "main.typ".into(),
        })
        .await
        .unwrap();
    assert_eq!(imported["snapshot"]["sourceEpoch"], 1);
    assert_eq!(
        fs::read_to_string(f.file.parent().unwrap().join("input.tex")).unwrap(),
        input
    );
    assert_eq!(
        f.service
            .remote(
                "read_manuscript",
                json!({"documentId":shared["documentId"]})
            )
            .unwrap_err()
            .code,
        "scope"
    );
}
