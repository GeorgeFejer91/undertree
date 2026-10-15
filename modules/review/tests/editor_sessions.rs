use serde_json::{json, Value};
use std::{fs, sync::Arc, time::Duration};
use undertree_review::{
    capabilities::CallerContext,
    document::digest,
    service::{editor::EditorOperation, Service},
    Operation,
};

struct Fixture {
    _temp: tempfile::TempDir,
    service: Arc<Service>,
    project: String,
    file: std::path::PathBuf,
}
impl Fixture {
    fn new() -> Self {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("project");
        fs::create_dir(&root).unwrap();
        let file = root.join("main.typ");
        fs::write(&file, "Original source").unwrap();
        let service = Service::new(temp.path().join("state")).unwrap();
        let project = service
            .local(Operation::AddProject {
                root: root.to_string_lossy().into(),
            })
            .unwrap()["id"]
            .as_str()
            .unwrap()
            .to_owned();
        Self {
            _temp: temp,
            service,
            project,
            file,
        }
    }
    async fn editor(&self, owner: &str, request: Value) -> undertree_review::Result<Value> {
        self.service
            .editor(
                owner,
                serde_json::from_value::<EditorOperation>(request).unwrap(),
            )
            .await
    }
    async fn register(&self, owner: &str, content: &str, generation: u64) -> String {
        self.editor(owner,json!({"action":"editor_register","project":self.project,"path":"main.typ","generation":generation,"revision":digest("Original source"),"contentDigest":digest(content),"dirty":content!="Original source","composing":false,"conflict":false})).await.unwrap()["sessionId"].as_str().unwrap().into()
    }
    async fn update(
        &self,
        owner: &str,
        session: &str,
        content: &str,
        generation: u64,
        composing: bool,
    ) -> undertree_review::Result<Value> {
        self.editor(owner,json!({"action":"editor_update","sessionId":session,"generation":generation,"revision":digest("Original source"),"contentDigest":digest(content),"dirty":true,"composing":composing,"conflict":false})).await
    }
    async fn pending(
        &self,
        owner: &str,
        id: &str,
    ) -> (
        tokio::task::JoinHandle<undertree_review::Result<Value>>,
        Value,
    ) {
        let service = self.service.clone();
        let project = self.project.clone();
        let id = id.to_owned();
        let task = tokio::spawn(async move {
            service
                .dispatch_as(
                    CallerContext::LocalCli,
                    Operation::SaveEditor {
                        project,
                        path: "main.typ".into(),
                        request_id: id,
                    },
                )
                .await
        });
        for _ in 0..100 {
            let poll = self
                .editor(owner, json!({"action":"editor_poll"}))
                .await
                .unwrap();
            if let Some(request) = poll["requests"].as_array().unwrap().first() {
                return (task, request.clone());
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        panic!("editor request was not queued")
    }
    async fn commit(
        &self,
        owner: &str,
        request: &Value,
        content: &str,
        generation: u64,
    ) -> undertree_review::Result<Value> {
        self.editor(owner,json!({"action":"editor_commit","requestId":request["requestId"],"ticket":request["ticket"],"sessionId":request["sessionId"],"generation":generation,"revision":digest("Original source"),"content":content})).await
    }
    async fn complete(&self, owner: &str, request: &Value, status: &str, generation: u64) -> Value {
        self.editor(owner,json!({"action":"editor_complete","requestId":request["requestId"],"ticket":request["ticket"],"sessionId":request["sessionId"],"status":status,"generation":generation})).await.unwrap()
    }
}

#[tokio::test]
async fn headless_and_raw_cli_mutations_are_denied_in_the_service() {
    let fixture = Fixture::new();
    let error = fixture
        .service
        .dispatch_as(
            CallerContext::LocalCli,
            Operation::SaveEditor {
                project: fixture.project.clone(),
                path: "main.typ".into(),
                request_id: uuid::Uuid::new_v4().to_string(),
            },
        )
        .await
        .unwrap_err();
    assert_eq!(error.code, "ui_unavailable");
    let error = fixture
        .service
        .dispatch_as(
            CallerContext::LocalCli,
            Operation::Save {
                project: fixture.project.clone(),
                path: "main.typ".into(),
                revision: digest("Original source"),
                content: "Injected".into(),
            },
        )
        .await
        .unwrap_err();
    assert_eq!(error.code, "unsupported_capability");
    assert_eq!(
        fs::read_to_string(&fixture.file).unwrap(),
        "Original source"
    );
    let capabilities = fixture
        .service
        .capabilities(CallerContext::LocalCli)
        .unwrap();
    assert_eq!(capabilities["caller"], "local_cli");
    assert!(capabilities["localOperations"]
        .as_array()
        .unwrap()
        .iter()
        .all(|op| op["mutates"] == false || op["action"] == "save_editor"));
    assert!(fixture
        .service
        .dispatch_as(
            CallerContext::Review,
            Operation::SaveEditor {
                project: fixture.project,
                path: "main.typ".into(),
                request_id: uuid::Uuid::new_v4().to_string()
            }
        )
        .await
        .is_err());
}

#[tokio::test]
async fn commit_is_durable_replay_does_not_write_and_newer_buffer_is_preserved() {
    let fixture = Fixture::new();
    let owner = "native:main";
    let session = fixture.register(owner, "Captured source", 1).await;
    let id = uuid::Uuid::new_v4().to_string();
    let (task, request) = fixture.pending(owner, &id).await;
    let saved = fixture
        .commit(owner, &request, "Captured source", 1)
        .await
        .unwrap();
    assert_eq!(saved["receipt"]["status"], "committed");
    assert_eq!(saved["receipt"]["savedGeneration"], 1);
    let modified = fs::metadata(&fixture.file).unwrap().modified().unwrap();
    tokio::time::sleep(Duration::from_millis(20)).await;
    fixture
        .commit(owner, &request, "Captured source", 1)
        .await
        .unwrap();
    assert_eq!(
        fs::metadata(&fixture.file).unwrap().modified().unwrap(),
        modified
    );
    assert_eq!(
        fixture
            .commit(owner, &request, "Different payload", 1)
            .await
            .unwrap_err()
            .code,
        "request_reused"
    );
    fixture
        .update(owner, &session, "Newer typing", 2, true)
        .await
        .unwrap();
    let result = fixture.complete(owner, &request, "newer_buffer", 2).await;
    assert_eq!(result["status"], "committed");
    assert_eq!(result["bufferStatus"], "newer_buffer");
    let cli_result = task.await.unwrap().unwrap();
    assert!(matches!(
        cli_result["bufferStatus"].as_str(),
        Some("newer_buffer" | "unconfirmed")
    ));
    let confirmed = fixture
        .service
        .dispatch_as(
            CallerContext::LocalCli,
            Operation::SaveReceipt {
                request_id: id.clone(),
            },
        )
        .await
        .unwrap();
    assert_eq!(confirmed["bufferStatus"], "newer_buffer");
    assert_eq!(
        fs::read_to_string(&fixture.file).unwrap(),
        "Captured source"
    );
    let replay = fixture
        .service
        .dispatch_as(
            CallerContext::LocalCli,
            Operation::SaveEditor {
                project: fixture.project.clone(),
                path: "main.typ".into(),
                request_id: id.clone(),
            },
        )
        .await
        .unwrap();
    assert_eq!(replay["savedRevision"], digest("Captured source"));
    let restarted = Service::new(fixture._temp.path().join("state")).unwrap();
    let receipt = restarted
        .dispatch_as(
            CallerContext::LocalCli,
            Operation::SaveReceipt { request_id: id },
        )
        .await
        .unwrap();
    assert_eq!(receipt["status"], "committed");
}

#[tokio::test]
async fn lost_renderer_ack_keeps_a_committed_unconfirmed_receipt() {
    let fixture = Fixture::new();
    let owner = "native:main";
    fixture.register(owner, "Captured source", 1).await;
    let id = uuid::Uuid::new_v4().to_string();
    let (task, request) = fixture.pending(owner, &id).await;
    fixture
        .commit(owner, &request, "Captured source", 1)
        .await
        .unwrap();
    let receipt = tokio::time::timeout(Duration::from_secs(2), task)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    assert_eq!(receipt["status"], "committed");
    assert_eq!(receipt["bufferStatus"], "unconfirmed");
    assert_eq!(
        fs::read_to_string(&fixture.file).unwrap(),
        "Captured source"
    );
}

#[tokio::test]
async fn clean_buffers_verify_disk_and_external_changes_never_get_overwritten() {
    let fixture = Fixture::new();
    let owner = "native:main";
    fixture.register(owner, "Original source", 0).await;
    let id = uuid::Uuid::new_v4().to_string();
    let (task, request) = fixture.pending(owner, &id).await;
    fs::write(&fixture.file, "External source").unwrap();
    assert_eq!(
        fixture
            .commit(owner, &request, "Original source", 0)
            .await
            .unwrap_err()
            .code,
        "stale"
    );
    fixture.complete(owner, &request, "stale_buffer", 0).await;
    assert_eq!(task.await.unwrap().unwrap()["status"], "rejected");
    assert_eq!(
        fs::read_to_string(&fixture.file).unwrap(),
        "External source"
    );
    let fresh = Fixture::new();
    fresh.register(owner, "Original source", 0).await;
    let id = uuid::Uuid::new_v4().to_string();
    let (task, request) = fresh.pending(owner, &id).await;
    let modified = fs::metadata(&fresh.file).unwrap().modified().unwrap();
    let result = fresh
        .commit(owner, &request, "Original source", 0)
        .await
        .unwrap();
    assert_eq!(
        result["receipt"]["savedRevision"],
        digest("Original source")
    );
    assert_eq!(
        fs::metadata(&fresh.file).unwrap().modified().unwrap(),
        modified
    );
    fresh.complete(owner, &request, "saved", 0).await;
    assert_eq!(task.await.unwrap().unwrap()["bufferStatus"], "saved");
}

#[tokio::test]
async fn generations_composition_and_window_ownership_gate_commit() {
    let fixture = Fixture::new();
    let owner = "native:main";
    let session = fixture.register(owner, "Captured source", 1).await;
    assert_eq!(
        fixture
            .update(owner, &session, "Different", 1, false)
            .await
            .unwrap_err()
            .code,
        "stale_buffer"
    );
    assert_eq!(
        fixture
            .update("native:other", &session, "Captured source", 1, false)
            .await
            .unwrap_err()
            .code,
        "stale_session"
    );
    let id = uuid::Uuid::new_v4().to_string();
    let (task, request) = fixture.pending(owner, &id).await;
    assert_eq!(
        fixture
            .commit("native:other", &request, "Captured source", 1)
            .await
            .unwrap_err()
            .code,
        "scope"
    );
    fixture
        .update(owner, &session, "Captured source", 1, true)
        .await
        .unwrap();
    assert_eq!(
        fixture
            .commit(owner, &request, "Captured source", 1)
            .await
            .unwrap_err()
            .code,
        "busy"
    );
    fixture
        .update(owner, &session, "Later source", 2, false)
        .await
        .unwrap();
    assert_eq!(
        fixture
            .commit(owner, &request, "Captured source", 1)
            .await
            .unwrap_err()
            .code,
        "stale_buffer"
    );
    fixture.complete(owner, &request, "busy", 2).await;
    assert_eq!(task.await.unwrap().unwrap()["status"], "rejected");
    assert_eq!(
        fs::read_to_string(&fixture.file).unwrap(),
        "Original source"
    );
}

#[tokio::test]
async fn reload_rotates_session_and_late_ticket_cannot_act_on_replacement() {
    let fixture = Fixture::new();
    let owner = "native:main";
    let first = fixture.register(owner, "Captured source", 1).await;
    let id = uuid::Uuid::new_v4().to_string();
    let (task, request) = fixture.pending(owner, &id).await;
    let second = fixture.register(owner, "Replacement source", 0).await;
    assert_ne!(first, second);
    assert_eq!(
        fixture
            .commit(owner, &request, "Captured source", 1)
            .await
            .unwrap_err()
            .code,
        "expired_ticket"
    );
    assert_eq!(task.await.unwrap().unwrap()["status"], "rejected");
    assert_eq!(
        fs::read_to_string(&fixture.file).unwrap(),
        "Original source"
    );
}

#[tokio::test]
async fn duplicate_owners_and_parallel_requests_are_denied_without_mutation() {
    let fixture = Fixture::new();
    let owner = "native:main";
    fixture.register(owner, "Captured source", 1).await;
    let duplicate=fixture.editor("native:other",json!({"action":"editor_register","project":fixture.project,"path":"main.typ","generation":0,"revision":digest("Original source"),"contentDigest":digest("Original source"),"dirty":false,"composing":false,"conflict":false})).await.unwrap_err();
    assert_eq!(duplicate.code, "busy");
    let id = uuid::Uuid::new_v4().to_string();
    let (task, request) = fixture.pending(owner, &id).await;
    let duplicate = fixture
        .service
        .dispatch_as(
            CallerContext::LocalCli,
            Operation::SaveEditor {
                project: fixture.project.clone(),
                path: "main.typ".into(),
                request_id: uuid::Uuid::new_v4().to_string(),
            },
        )
        .await
        .unwrap_err();
    assert_eq!(duplicate.code, "busy");
    fixture.complete(owner, &request, "busy", 1).await;
    task.await.unwrap().unwrap();
    assert_eq!(
        fs::read_to_string(&fixture.file).unwrap(),
        "Original source"
    );
}

#[tokio::test]
async fn named_cli_save_uses_running_authority_and_receipt_without_source_arguments() {
    let fixture = Fixture::new();
    let owner = "native:main";
    let instance = undertree_review::instance::LocalInstance::start(fixture.service.clone())
        .await
        .unwrap();
    let state = fixture._temp.path().join("state");
    let headless = tokio::process::Command::new(env!("CARGO_BIN_EXE_undertree-review"))
        .args(["save", &fixture.project, "main.typ"])
        .env("UNDERTREE_REVIEW_STATE", &state)
        .env_remove("UNDERTREE_REVIEW_TOKEN")
        .env_remove("UNDERTREE_REVIEW_ENDPOINT")
        .output()
        .await
        .unwrap();
    assert!(!headless.status.success());
    let denied: Value = serde_json::from_slice(&headless.stdout).unwrap();
    assert_eq!(denied["error"]["code"], "ui_unavailable");
    fixture.register(owner, "From live buffer", 4).await;
    let child = tokio::process::Command::new(env!("CARGO_BIN_EXE_undertree-review"))
        .args(["save", &fixture.project, "main.typ"])
        .env("UNDERTREE_REVIEW_STATE", &state)
        .env_remove("UNDERTREE_REVIEW_TOKEN")
        .env_remove("UNDERTREE_REVIEW_ENDPOINT")
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .unwrap();
    let request = loop {
        let poll = fixture
            .editor(owner, json!({"action":"editor_poll"}))
            .await
            .unwrap();
        if let Some(request) = poll["requests"].as_array().unwrap().first() {
            break request.clone();
        }
        tokio::time::sleep(Duration::from_millis(5)).await;
    };
    fixture
        .commit(owner, &request, "From live buffer", 4)
        .await
        .unwrap();
    fixture.complete(owner, &request, "saved", 4).await;
    let output = child.wait_with_output().await.unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let result: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(result["result"]["status"], "committed");
    assert_eq!(result["result"]["savedGeneration"], 4);
    let id = request["requestId"].as_str().unwrap();
    assert!(String::from_utf8_lossy(&output.stderr).contains(id));
    let receipt = tokio::process::Command::new(env!("CARGO_BIN_EXE_undertree-review"))
        .args(["save-receipt", id])
        .env("UNDERTREE_REVIEW_STATE", &state)
        .env_remove("UNDERTREE_REVIEW_TOKEN")
        .env_remove("UNDERTREE_REVIEW_ENDPOINT")
        .output()
        .await
        .unwrap();
    assert!(receipt.status.success());
    let receipt: Value = serde_json::from_slice(&receipt.stdout).unwrap();
    assert_eq!(
        receipt["result"]["savedRevision"],
        digest("From live buffer")
    );
    assert_eq!(
        fs::read_to_string(&fixture.file).unwrap(),
        "From live buffer"
    );
    instance.stop();
}
