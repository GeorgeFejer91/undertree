use super::*;
use crate::service::editor::EditorOperation;
use std::time::Instant;

struct Fixture {
    _temp: tempfile::TempDir,
    service: Arc<Service>,
    project: String,
    document: String,
    owner_id: String,
    owner: String,
    source: PathBuf,
}

impl Fixture {
    fn new() -> Self {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("project");
        fs::create_dir(&root).unwrap();
        let source = root.join("main.html");
        fs::write(&source, "<p>Original prose.</p>").unwrap();
        let service = Service::new(temp.path().join("state")).unwrap();
        let project: String = service
            .local(Operation::AddProject {
                root: root.to_string_lossy().into(),
            })
            .unwrap()["id"]
            .as_str()
            .unwrap()
            .into();
        service
            .local(Operation::Mark {
                project: project.clone(),
                path: "main.html".into(),
                revision: digest("<p>Original prose.</p>"),
                from: 3,
                to: 18,
                rule: "snappier".into(),
                prompt: String::new(),
            })
            .unwrap();
        let document = service
            .local(Operation::Share {
                project: project.clone(),
                path: "main.html".into(),
                enabled: true,
                context_shared: true,
                expected_context_scope: service.test_context_scope(&project, "main.html"),
            })
            .unwrap()["documentId"]
            .as_str()
            .unwrap()
            .into();
        let owner_id = service.connect_native_editor("main").unwrap()["ownerId"]
            .as_str()
            .unwrap()
            .to_owned();
        let owner = service.native_editor_owner("main", &owner_id).unwrap();
        Self {
            _temp: temp,
            service,
            project,
            document,
            owner_id,
            owner,
            source,
        }
    }
    fn proposal(&self, request: &str, quote: &str) -> Result<Value> {
        self.service.remote("suggest_text",json!({"documentId":self.document,"proposal":{"requestId":request,"contextId":self.service.remote("read_manuscript",json!({"documentId":self.document}))?["contextId"],"revision":digest("<p>Original prose.</p>"),"from":3,"to":18,"quote":quote,"replacement":"Clearer prose.","rationale":"Clarity."}}))
    }
    async fn cursor(&self) -> Value {
        self.service
            .editor_native(
                "main",
                &self.owner_id,
                EditorOperation::ReviewChanges {
                    after: None,
                    wait_ms: 0,
                },
            )
            .await
            .unwrap()
    }
    async fn queued(&self, after: String) -> tokio::task::JoinHandle<Result<Value>> {
        let service = self.service.clone();
        let owner = self.owner_id.clone();
        let wait = tokio::spawn(async move {
            service
                .editor_native(
                    "main",
                    &owner,
                    EditorOperation::ReviewChanges {
                        after: Some(after),
                        wait_ms: 25_000,
                    },
                )
                .await
        });
        let deadline = Instant::now() + Duration::from_secs(3);
        while self.service.review_changes.waiters.available_permits() == 4 {
            assert!(
                Instant::now() < deadline,
                "The local wait did not subscribe."
            );
            tokio::task::yield_now().await;
        }
        wait
    }
}

#[tokio::test]
async fn successful_remote_suggestion_wakes_a_local_owner_after_persistence_without_changing_source(
) {
    let fixture = Fixture::new();
    let cursor = fixture.cursor().await;
    let wait = fixture
        .queued(cursor["sequence"].as_str().unwrap().into())
        .await;
    assert!(
        fixture.service.documents.try_lock().is_ok(),
        "A notification wait must not hold document authority."
    );
    let source = fs::read(&fixture.source).unwrap();
    let started = Instant::now();
    let proposed = fixture
        .proposal("wake-after-persist", "Original prose.")
        .unwrap();
    let reply = tokio::time::timeout(Duration::from_secs(3), wait)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    assert_eq!(reply["changed"], true);
    assert_ne!(reply["sequence"], cursor["sequence"]);
    assert_eq!(reply["instanceId"], fixture.service.instance_id());
    assert_eq!(reply.as_object().unwrap().len(), 3);
    let snapshot = fixture
        .service
        .local(Operation::Review {
            project: fixture.project.clone(),
            path: "main.html".into(),
        })
        .unwrap();
    assert_eq!(
        snapshot["review"]["suggestions"][0]["id"],
        proposed["suggestion"]["id"]
    );
    assert_eq!(snapshot["review"]["suggestions"][0]["status"], "pending");
    assert_eq!(fs::read(&fixture.source).unwrap(), source);
    println!(
        "review_change_timing={}",
        json!({"persistToObservationMs":started.elapsed().as_secs_f64()*1000.0,"waitDeadlineMs":25000,"originalSourceUnchanged":true,"pendingVisible":true})
    );
}

#[tokio::test]
async fn denied_proposals_do_not_signal_and_missed_or_coalesced_changes_remain_observable() {
    let fixture = Fixture::new();
    let cursor = fixture.cursor().await;
    assert!(fixture.proposal("denied", "Wrong exact quote").is_err());
    let unchanged = fixture
        .service
        .wait_review_changes(
            &fixture.owner,
            Some(cursor["sequence"].as_str().unwrap().into()),
            5,
        )
        .await
        .unwrap();
    assert_eq!(unchanged["changed"], false);
    fixture.proposal("first", "Original prose.").unwrap();
    fixture.proposal("second", "Original prose.").unwrap();
    let latest = fixture
        .service
        .wait_review_changes(
            &fixture.owner,
            Some(cursor["sequence"].as_str().unwrap().into()),
            25_000,
        )
        .await
        .unwrap();
    assert_eq!(latest["changed"], true);
    assert_eq!(
        latest["sequence"].as_str().unwrap().parse::<u64>().unwrap(),
        cursor["sequence"].as_str().unwrap().parse::<u64>().unwrap() + 2
    );
    let before = latest["sequence"].as_str().unwrap();
    fixture
        .service
        .local(Operation::Mark {
            project: fixture.project.clone(),
            path: "main.html".into(),
            revision: digest("<p>Original prose.</p>"),
            from: 3,
            to: 18,
            rule: "protect".into(),
            prompt: "".into(),
        })
        .unwrap();
    assert_eq!(
        fixture
            .service
            .wait_review_changes(&fixture.owner, Some(before.into()), 0)
            .await
            .unwrap()["changed"],
        true
    );
}

#[tokio::test]
async fn review_change_waits_are_bounded_and_native_page_retirement_is_checked_after_wake() {
    let fixture = Fixture::new();
    let cursor = fixture.cursor().await["sequence"]
        .as_str()
        .unwrap()
        .to_owned();
    let mut tasks = Vec::new();
    for expected in (0..4).rev() {
        let service = fixture.service.clone();
        let owner = fixture.owner.clone();
        let after = cursor.clone();
        tasks.push(tokio::spawn(async move {
            service
                .wait_review_changes(&owner, Some(after), 25_000)
                .await
        }));
        let deadline = Instant::now() + Duration::from_secs(3);
        while fixture.service.review_changes.waiters.available_permits() != expected {
            assert!(Instant::now() < deadline);
            tokio::task::yield_now().await;
        }
    }
    assert_eq!(
        fixture
            .service
            .wait_review_changes(&fixture.owner, Some(cursor), 1)
            .await
            .unwrap_err()
            .code,
        "busy"
    );
    fixture.service.connect_native_editor("main").unwrap();
    for task in tasks {
        assert_eq!(task.await.unwrap().unwrap_err().code, "stale_session");
    }
    assert_eq!(
        fixture.service.review_changes.waiters.available_permits(),
        4
    );
}

#[tokio::test]
async fn review_change_cursor_and_owner_validation_never_expand_the_operation_catalogues() {
    let fixture = Fixture::new();
    for after in ["", "01", "-1", "18446744073709551616"] {
        assert_eq!(
            fixture
                .service
                .wait_review_changes(&fixture.owner, Some(after.into()), 0)
                .await
                .unwrap_err()
                .code,
            "format"
        );
    }
    assert_eq!(
        fixture
            .service
            .wait_review_changes(&fixture.owner, None, 25_001)
            .await
            .unwrap_err()
            .code,
        "format"
    );
    assert_eq!(
        fixture
            .service
            .wait_review_changes("native:main:forged", None, 0)
            .await
            .unwrap_err()
            .code,
        "stale_session"
    );
    for action in ["review_changes", "editor_operation"] {
        assert_eq!(
            fixture
                .service
                .remote(action, json!({"after":null}))
                .unwrap_err()
                .code,
            "scope"
        );
        assert!(
            serde_json::from_value::<Operation>(json!({"action":action,"after":null})).is_err()
        );
    }
    assert!(serde_json::from_value::<EditorOperation>(
        json!({"action":"review_changes","after":null,"write":"source"})
    )
    .is_err());
}
