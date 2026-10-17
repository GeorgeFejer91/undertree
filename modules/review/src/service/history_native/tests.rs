use super::*;
use crate::service::editor::{BufferResult, EditorOperation};
use crate::service::history::{self, HistoryItem, VersionSummary};
use crate::service::{HistoryQuery, HistoryReply, Project, Service};
use crate::{Operation, Result, SourceRequest};
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;

struct Fixture {
    temporary: tempfile::TempDir,
    service: Arc<Service>,
    project: Project,
    file: PathBuf,
    owner: String,
    root: crate::RootObservation,
}

impl Fixture {
    fn new(content: &str) -> Self {
        let temporary = tempfile::tempdir().unwrap();
        let root = temporary.path().join("project");
        fs::create_dir(&root).unwrap();
        let file = root.join("main.typ");
        fs::write(&file, content).unwrap();
        let service = Service::new(temporary.path().join("state")).unwrap();
        let project: Project = serde_json::from_value(
            service
                .local(Operation::AddProject {
                    root: root.to_string_lossy().into_owned(),
                })
                .unwrap(),
        )
        .unwrap();
        let file = project.root.join("main.typ");
        let owner = service.connect_native_editor("main").unwrap()["ownerId"]
            .as_str()
            .unwrap()
            .to_owned();
        let observed = crate::service::source_files::RootedRoot::observe(&project.root).unwrap();
        Self {
            temporary,
            service,
            project,
            file,
            owner,
            root: observed,
        }
    }

    async fn native(&self, operation: Operation) -> Result<serde_json::Value> {
        self.service
            .dispatch_native_source(
                "main",
                &self.owner,
                SourceRequest {
                    operation,
                    source_epoch: 0,
                    expected_root: Some(self.root),
                },
            )
            .await
    }

    async fn save(&self, old: &str, content: &str) -> serde_json::Value {
        self.native(Operation::Save {
            project: self.project.id.clone(),
            path: "main.typ".into(),
            revision: crate::document::digest(old),
            content: content.into(),
        })
        .await
        .unwrap()
    }

    async fn query(&self, query: HistoryQuery) -> Result<HistoryReply> {
        self.service
            .history_query_native("main", &self.owner, query)
            .await
    }

    fn list_query(&self, namespace_id: Option<String>, source_id: Option<String>) -> HistoryQuery {
        HistoryQuery::List {
            project_id: self.project.id.clone(),
            namespace_id,
            observed_root: None,
            source_id,
            cursor: None,
        }
    }

    async fn versions(&self) -> Vec<VersionSummary> {
        let reply = match self.query(self.list_query(None, None)).await {
            Ok(reply) => reply,
            Err(error) if error.code == "history_not_initialized" => return Vec::new(),
            Err(error) => panic!("History query failed: {} {}", error.code, error.message),
        };
        let HistoryReply::List(namespaces) = reply else {
            panic!("expected namespace list")
        };
        if namespaces.items.is_empty() {
            return Vec::new();
        }
        assert_eq!(namespaces.items.len(), 1);
        let HistoryItem::Namespace { namespace_id, .. } = &namespaces.items[0] else {
            panic!("expected namespace")
        };
        let HistoryReply::List(sources) = self
            .query(self.list_query(Some(namespace_id.clone()), None))
            .await
            .unwrap()
        else {
            panic!("expected source list")
        };
        assert_eq!(sources.items.len(), 1);
        let HistoryItem::Source {
            source_id, path, ..
        } = &sources.items[0]
        else {
            panic!("expected source")
        };
        assert_eq!(path, "main.typ");
        let HistoryReply::List(versions) = self
            .query(self.list_query(Some(namespace_id.clone()), Some(source_id.clone())))
            .await
            .unwrap()
        else {
            panic!("expected version list")
        };
        versions
            .items
            .into_iter()
            .map(|item| match item {
                HistoryItem::Version { version } => *version,
                _ => panic!("expected saved version"),
            })
            .collect()
    }

    async fn read_version(&self, version: &VersionSummary) -> history::SavedVersion {
        match self
            .query(HistoryQuery::Read {
                project_id: version.binding.project_id.clone(),
                namespace_id: version.namespace_id.clone(),
                source_id: version.source_id.clone(),
                version_id: version.version_id.clone(),
            })
            .await
            .unwrap()
        {
            HistoryReply::Read(saved) => saved,
            _ => panic!("expected saved content"),
        }
    }

    async fn share(&self) -> String {
        self.native(Operation::Share {
            project: self.project.id.clone(),
            path: "main.typ".into(),
            enabled: true,
            context_shared: true,
            expected_context_scope: self
                .service
                .test_context_scope(&self.project.id, "main.typ"),
        })
        .await
        .unwrap()["documentId"]
            .as_str()
            .unwrap()
            .to_owned()
    }

    fn restart(&mut self) {
        self.service = Service::new(self.service.state.clone()).unwrap();
        self.owner = self.service.connect_native_editor("main").unwrap()["ownerId"]
            .as_str()
            .unwrap()
            .to_owned();
    }

    fn core(&self) -> history::HistoryStore {
        let id = crate::service::lock(&self.service.registry)
            .unwrap()
            .history_store_id
            .clone()
            .unwrap();
        let directory =
            cap_std::fs::Dir::open_ambient_dir(&self.service.state, cap_std::ambient_authority())
                .unwrap();
        history::HistoryStore::open(directory, Some(uuid::Uuid::parse_str(&id).unwrap()))
            .unwrap()
            .unwrap()
    }

    fn source_context(
        &self,
    ) -> (
        crate::service::source_files::SourceGroup,
        history::SourceBinding,
        history::SourceSlot,
    ) {
        let group = self
            .service
            .acquire_group(
                crate::service::SourceBinding::new(&self.project.id, "main.typ", 0)
                    .rooted(Some(self.root)),
            )
            .unwrap();
        let source = group
            .read_utf8(
                crate::service::source_files::Member::Source,
                crate::document::MAX_TEXT,
            )
            .unwrap();
        let slot = group.history_source_slot(&source).unwrap();
        let binding = history::SourceBinding {
            project_id: self.project.id.clone(),
            root: self.root,
            path: "main.typ".into(),
            source_epoch: 0,
        };
        (group, binding, slot)
    }

    fn proposal(
        &self,
        document_id: &str,
        text: &str,
        replacement: &str,
        request: &str,
    ) -> Result<serde_json::Value> {
        self.service.remote("suggest_text", serde_json::json!({
            "documentId": document_id,
            "proposal": {"requestId":request,"contextId":self.service.remote("read_manuscript",serde_json::json!({"documentId":document_id}))?["contextId"],"revision":crate::document::digest(text),"from":0,"to":text.encode_utf16().count(),"quote":text,"replacement":replacement,"rationale":"Native History fixture"}
        }))
    }
}

#[derive(Debug, PartialEq, Eq)]
enum Entry {
    Directory,
    File(Vec<u8>),
    Symlink(PathBuf),
}

fn snapshot(directory: &Path) -> BTreeMap<PathBuf, Entry> {
    fn visit(base: &Path, directory: &Path, entries: &mut BTreeMap<PathBuf, Entry>) {
        for entry in fs::read_dir(directory).unwrap() {
            let path = entry.unwrap().path();
            let metadata = fs::symlink_metadata(&path).unwrap();
            let relative = path.strip_prefix(base).unwrap().to_owned();
            if metadata.file_type().is_symlink() {
                entries.insert(relative, Entry::Symlink(fs::read_link(path).unwrap()));
            } else if metadata.is_dir() {
                entries.insert(relative, Entry::Directory);
                visit(base, &path, entries);
            } else {
                entries.insert(relative, Entry::File(fs::read(path).unwrap()));
            }
        }
    }
    let mut entries = BTreeMap::new();
    visit(directory, directory, &mut entries);
    entries
}

fn assert_code<T>(result: Result<T>, code: &str) {
    match result {
        Err(error) => assert_eq!(error.code, code, "{}", error.message),
        Ok(_) => panic!("expected {code}"),
    }
}

#[tokio::test]
async fn native_save_records_exact_a_b_a_without_git_or_an_invented_initial_version() {
    let fixture = Fixture::new("A e\u{301} 🧪\r\n");
    assert!(!fixture.project.root.join(".git").exists());
    assert!(fixture.versions().await.is_empty());
    assert!(!fixture.service.state.join("history-v1").exists());
    let a = "A e\u{301} 🧪\r\n";
    let b = "B 👩🏽‍🔬\r\n";
    fixture.save(a, b).await;
    fixture.save(b, a).await;
    let versions = fixture.versions().await;
    assert_eq!(versions.len(), 2);
    assert_eq!(
        (versions[0].sequence.as_str(), versions[1].sequence.as_str()),
        ("2", "1")
    );
    assert_ne!(versions[0].version_id, versions[1].version_id);
    assert_eq!(versions[0].cause, "native_save");
    assert_eq!(versions[1].cause, "native_save");
    assert_eq!(fixture.read_version(&versions[0]).await.content, a);
    assert_eq!(fixture.read_version(&versions[1]).await.content, b);
    assert_eq!(fs::read(&fixture.file).unwrap(), a.as_bytes());
    let before = snapshot(&fixture.service.state.join("history-v1"));
    fixture.save(a, a).await;
    assert_eq!(
        fixture.versions().await.len(),
        2,
        "unchanged Save has no History event"
    );
    assert_eq!(fs::read(&fixture.file).unwrap(), a.as_bytes());
    assert_eq!(snapshot(&fixture.service.state.join("history-v1")), before);
}

#[tokio::test]
async fn native_history_queries_are_pure_before_initialization_and_reject_owners_and_path_authority(
) {
    let fixture = Fixture::new("Original");
    let before = snapshot(fixture.temporary.path());
    assert_code(
        fixture.query(fixture.list_query(None, None)).await,
        "history_not_initialized",
    );
    assert!(fixture.versions().await.is_empty());
    assert!(!fixture.service.state.join("history-v1").exists());
    assert!(fixture
        .service
        .history_query_native("main", "invented-owner", fixture.list_query(None, None))
        .await
        .is_err());
    assert!(fixture
        .service
        .history_query_native("other", &fixture.owner, fixture.list_query(None, None))
        .await
        .is_err());
    assert!(fixture
        .query(HistoryQuery::Read {
            project_id: fixture.project.id.clone(),
            namespace_id: uuid::Uuid::new_v4().to_string(),
            source_id: uuid::Uuid::new_v4().to_string(),
            version_id: uuid::Uuid::new_v4().to_string()
        })
        .await
        .is_err());
    for raw in [
        serde_json::json!({"action":"list","projectId":fixture.project.id,"path":"main.typ"}),
        serde_json::json!({"action":"list","projectId":fixture.project.id,"native":true}),
        serde_json::json!({"action":"restore","projectId":fixture.project.id}),
    ] {
        assert!(serde_json::from_value::<HistoryQuery>(raw).is_err());
    }
    assert!(serde_json::from_value::<Operation>(
        serde_json::json!({"action":"history_list","project":fixture.project.id})
    )
    .is_err());
    assert_code(
        fixture
            .service
            .remote("history_list", serde_json::json!({})),
        "scope",
    );
    assert_eq!(snapshot(fixture.temporary.path()), before);
}

#[tokio::test]
async fn native_acceptance_is_captured_while_metadata_rejection_and_legacy_save_are_excluded() {
    let fixture = Fixture::new("Original");
    fixture
        .native(Operation::Mark {
            project: fixture.project.id.clone(),
            path: "main.typ".into(),
            revision: crate::document::digest("Original"),
            from: 0,
            to: 8,
            rule: "snappier".into(),
            prompt: String::new(),
        })
        .await
        .unwrap();
    let document_id = fixture.share().await;
    let suggestion = fixture
        .proposal(&document_id, "Original", "Accepted", "native-acceptance")
        .unwrap();
    assert!(fixture.versions().await.is_empty());
    let accepted_id = suggestion["suggestion"]["id"].as_str().unwrap().to_owned();
    fixture
        .native(Operation::Decide {
            project: fixture.project.id.clone(),
            path: "main.typ".into(),
            revision: crate::document::digest("Original"),
            id: accepted_id.clone(),
            decision: crate::document::Decision::Accepted,
        })
        .await
        .unwrap();
    let versions = fixture.versions().await;
    assert_eq!(versions.len(), 1);
    assert_eq!(versions[0].cause, "local_acceptance");
    assert_eq!(
        versions[0].suggestion_id.as_deref(),
        Some(accepted_id.as_str())
    );
    assert_eq!(fixture.read_version(&versions[0]).await.content, "Accepted");
    fixture
        .native(Operation::Mark {
            project: fixture.project.id.clone(),
            path: "main.typ".into(),
            revision: crate::document::digest("Accepted"),
            from: 0,
            to: 8,
            rule: "snappier".into(),
            prompt: String::new(),
        })
        .await
        .unwrap();
    let suggestion = fixture
        .proposal(&document_id, "Accepted", "Rejected", "native-rejection")
        .unwrap();
    fixture
        .native(Operation::Decide {
            project: fixture.project.id.clone(),
            path: "main.typ".into(),
            revision: crate::document::digest("Accepted"),
            id: suggestion["suggestion"]["id"].as_str().unwrap().into(),
            decision: crate::document::Decision::Rejected,
        })
        .await
        .unwrap();
    let review: crate::document::Review =
        serde_json::from_slice(&fs::read(crate::service::sidecar(&fixture.file)).unwrap()).unwrap();
    fixture
        .native(Operation::Palette {
            project: fixture.project.id.clone(),
            path: "main.typ".into(),
            revision: crate::document::digest("Accepted"),
            rules: review.rules,
            expected_rules: None,
        })
        .await
        .unwrap();
    assert_eq!(fixture.versions().await.len(), 1);
    fixture
        .service
        .local(Operation::Save {
            project: fixture.project.id.clone(),
            path: "main.typ".into(),
            revision: crate::document::digest("Accepted"),
            content: "Legacy save".into(),
        })
        .unwrap();
    assert_eq!(fixture.versions().await.len(), 1);
    assert_eq!(fs::read_to_string(&fixture.file).unwrap(), "Legacy save");
}

async fn editor_operation(
    fixture: &Fixture,
    browser: Option<&str>,
    operation: EditorOperation,
) -> Result<serde_json::Value> {
    if let Some(owner) = browser {
        fixture.service.editor(owner, operation).await
    } else {
        fixture
            .service
            .editor_native("main", &fixture.owner, operation)
            .await
    }
}

#[tokio::test]
async fn cli_save_qualifies_only_when_the_actual_editor_commit_has_native_origin() {
    for native in [false, true] {
        let fixture = Fixture::new("Original");
        let browser = if native {
            None
        } else {
            let id = fixture.service.connect_browser_editor().unwrap()["ownerId"]
                .as_str()
                .unwrap()
                .to_owned();
            Some(fixture.service.browser_editor_owner(&id).unwrap())
        };
        let content = if native {
            "Native CLI save"
        } else {
            "Browser CLI save"
        };
        let registration = editor_operation(
            &fixture,
            browser.as_deref(),
            EditorOperation::EditorRegister {
                project: fixture.project.id.clone(),
                path: "main.typ".into(),
                source_epoch: 0,
                expected_root: Some(fixture.root),
                generation: 1,
                revision: crate::document::digest("Original"),
                content_digest: crate::document::digest(content),
                dirty: true,
                composing: false,
                conflict: false,
            },
        )
        .await
        .unwrap();
        let session_id = registration["sessionId"].as_str().unwrap().to_owned();
        let request_id = uuid::Uuid::new_v4().to_string();
        let service = fixture.service.clone();
        let operation = Operation::SaveEditor {
            project: fixture.project.id.clone(),
            path: "main.typ".into(),
            request_id: request_id.clone(),
        };
        let requested = tokio::spawn(async move { service.dispatch(operation).await });
        let pending = tokio::time::timeout(std::time::Duration::from_secs(3), async {
            loop {
                let polled =
                    editor_operation(&fixture, browser.as_deref(), EditorOperation::EditorPoll {})
                        .await
                        .unwrap();
                if let Some(request) = polled["requests"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .find(|entry| entry["requestId"] == request_id)
                {
                    break request.clone();
                }
                tokio::time::sleep(std::time::Duration::from_millis(5)).await;
            }
        })
        .await
        .expect("actual CLI save request must reach its registered editor");
        assert_eq!(pending["sessionId"], session_id);
        let ticket = pending["ticket"].as_str().unwrap().to_owned();
        let committed = editor_operation(
            &fixture,
            browser.as_deref(),
            EditorOperation::EditorCommit {
                request_id: request_id.clone(),
                ticket: ticket.clone(),
                session_id: session_id.clone(),
                generation: 1,
                revision: crate::document::digest("Original"),
                content: content.into(),
            },
        )
        .await
        .unwrap();
        assert_eq!(committed["receipt"]["status"], "committed");
        editor_operation(
            &fixture,
            browser.as_deref(),
            EditorOperation::EditorComplete {
                request_id,
                ticket,
                session_id,
                status: BufferResult::Saved,
                generation: 1,
            },
        )
        .await
        .unwrap();
        let receipt = tokio::time::timeout(std::time::Duration::from_secs(3), requested)
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        assert_eq!(receipt["status"], "committed");
        assert_eq!(fs::read_to_string(&fixture.file).unwrap(), content);
        let versions = fixture.versions().await;
        assert_eq!(versions.len(), usize::from(native));
        if native {
            assert_eq!(versions[0].cause, "native_save");
            assert_eq!(fixture.read_version(&versions[0]).await.content, content);
        } else {
            assert!(!fixture.service.state.join("history-v1").exists());
        }
    }
}

#[tokio::test]
async fn initialized_queries_ignore_current_source_corruption_and_pending_recovery_intents() {
    let fixture = Fixture::new("Original");
    fixture.save("Original", "Saved 🧪\r\n").await;
    let version = fixture.versions().await.remove(0);
    fs::write(&fixture.file, "External newer source").unwrap();
    fs::write(crate::service::sidecar(&fixture.file), b"{broken review").unwrap();
    fs::write(
        crate::service::journal_path(&fixture.file),
        b"{unresolved journal",
    )
    .unwrap();
    let before = snapshot(fixture.temporary.path());
    assert_eq!(fixture.read_version(&version).await.content, "Saved 🧪\r\n");
    let compared = fixture
        .query(HistoryQuery::Compare {
            project_id: fixture.project.id.clone(),
            namespace_id: version.namespace_id.clone(),
            source_id: version.source_id.clone(),
            from_version_id: version.version_id.clone(),
            to_version_id: version.version_id.clone(),
        })
        .await
        .unwrap();
    assert!(
        matches!(compared, HistoryReply::Compare(comparison) if comparison.from_changed.is_none() && comparison.to_changed.is_none())
    );
    assert!(fixture
        .query(HistoryQuery::Read {
            project_id: uuid::Uuid::new_v4().to_string(),
            namespace_id: version.namespace_id.clone(),
            source_id: version.source_id.clone(),
            version_id: version.version_id.clone()
        })
        .await
        .is_err());
    assert!(fixture
        .query(HistoryQuery::Read {
            project_id: fixture.project.id.clone(),
            namespace_id: version.namespace_id.clone(),
            source_id: version.source_id.clone(),
            version_id: uuid::Uuid::new_v4().to_string()
        })
        .await
        .is_err());
    assert_eq!(snapshot(fixture.temporary.path()), before);
}

#[tokio::test]
async fn initialized_missing_or_corrupt_history_refuses_native_save_without_resetting_evidence() {
    for damage in ["missing-store", "catalog", "missing-blob"] {
        let fixture = Fixture::new("Original");
        fixture.save("Original", "Saved").await;
        assert_eq!(fixture.versions().await.len(), 1);
        let history = fixture.service.state.join("history-v1");
        match damage {
            "missing-store" => fs::rename(
                &history,
                fixture.temporary.path().join("preserved-history-evidence"),
            )
            .unwrap(),
            "catalog" => fs::write(history.join("catalog.json"), b"{broken archive").unwrap(),
            "missing-blob" => {
                let blob = fs::read_dir(history.join("blobs"))
                    .unwrap()
                    .next()
                    .unwrap()
                    .unwrap()
                    .path();
                fs::remove_file(blob).unwrap();
            }
            _ => unreachable!(),
        }
        let before = snapshot(fixture.temporary.path());
        assert!(fixture.query(fixture.list_query(None, None)).await.is_err());
        assert!(fixture
            .native(Operation::Save {
                project: fixture.project.id.clone(),
                path: "main.typ".into(),
                revision: crate::document::digest("Saved"),
                content: "Unsaved newer draft".into()
            })
            .await
            .is_err());
        assert_eq!(snapshot(fixture.temporary.path()), before);
        assert_eq!(fs::read_to_string(&fixture.file).unwrap(), "Saved");
    }
}

async fn interrupted_native_save(fixture: &Fixture) -> (Journal, Vec<u8>) {
    *crate::service::lock(&fixture.service.fail_after_journal).unwrap() = true;
    assert!(fixture
        .native(Operation::Save {
            project: fixture.project.id.clone(),
            path: "main.typ".into(),
            revision: crate::document::digest("Original"),
            content: "Captured".into()
        })
        .await
        .is_err());
    assert_eq!(fs::read_to_string(&fixture.file).unwrap(), "Original");
    let bytes = fs::read(crate::service::journal_path(&fixture.file)).unwrap();
    let journal: Journal = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(journal.content, "Captured");
    assert!(
        journal.history.is_some(),
        "only a real native Save creates this private-bound intent"
    );
    (journal, bytes)
}

#[tokio::test]
async fn restarted_inert_native_journal_requires_explicit_native_resume_and_keeps_event_identity() {
    let mut fixture = Fixture::new("Original");
    let (journal, _) = interrupted_native_save(&fixture).await;
    let reference = journal.history.unwrap();
    fixture.restart();
    let (_group, binding, slot) = fixture.source_context();
    assert_eq!(
        fixture
            .core()
            .producer_reservation(&binding, &slot)
            .unwrap()
            .unwrap()
            .phase(),
        history::ProducerPhase::Unarmed
    );
    let before = snapshot(fixture.temporary.path());
    assert!(fixture
        .service
        .local(Operation::Open {
            project: fixture.project.id.clone(),
            path: "main.typ".into()
        })
        .is_err());
    assert!(fixture.versions().await.is_empty());
    assert_eq!(snapshot(fixture.temporary.path()), before);
    fixture
        .native(Operation::Open {
            project: fixture.project.id.clone(),
            path: "main.typ".into(),
        })
        .await
        .unwrap();
    assert_eq!(fs::read_to_string(&fixture.file).unwrap(), "Captured");
    assert!(!crate::service::journal_path(&fixture.file).exists());
    let versions = fixture.versions().await;
    assert_eq!(versions.len(), 1);
    assert_eq!(versions[0].version_id, reference.event_id);
    assert_eq!(versions[0].cause, "native_save");
    assert!(versions[0].after_recovery);
    assert!(fixture
        .core()
        .producer_reservation(&binding, &slot)
        .unwrap()
        .is_none());
    let before = snapshot(fixture.temporary.path());
    fixture
        .native(Operation::Open {
            project: fixture.project.id.clone(),
            path: "main.typ".into(),
        })
        .await
        .unwrap();
    assert_eq!(fixture.versions().await[0].version_id, reference.event_id);
    assert_eq!(snapshot(fixture.temporary.path()), before);
}

#[tokio::test]
async fn stripped_history_field_cannot_turn_an_outstanding_native_intent_into_legacy_recovery() {
    let fixture = Fixture::new("Original");
    interrupted_native_save(&fixture).await;
    let path = crate::service::journal_path(&fixture.file);
    let mut value: serde_json::Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    value.as_object_mut().unwrap().remove("history");
    fs::write(&path, serde_json::to_vec_pretty(&value).unwrap()).unwrap();
    let before = snapshot(fixture.temporary.path());
    assert!(fixture
        .service
        .local(Operation::Open {
            project: fixture.project.id.clone(),
            path: "main.typ".into()
        })
        .is_err());
    assert!(fixture
        .native(Operation::Open {
            project: fixture.project.id.clone(),
            path: "main.typ".into()
        })
        .await
        .is_err());
    assert_eq!(snapshot(fixture.temporary.path()), before);
    assert_eq!(fs::read_to_string(&fixture.file).unwrap(), "Original");
    let (_group, binding, slot) = fixture.source_context();
    assert_eq!(
        fixture
            .core()
            .producer_reservation(&binding, &slot)
            .unwrap()
            .unwrap()
            .phase(),
        history::ProducerPhase::Unarmed
    );
}

#[tokio::test]
async fn exact_armed_native_journal_recovers_without_creating_another_native_event() {
    let mut fixture = Fixture::new("Original");
    let (journal, bytes) = interrupted_native_save(&fixture).await;
    let reference = journal.history.unwrap();
    let (_group, binding, slot) = fixture.source_context();
    let mut core = fixture.core();
    let reservation = core.producer_reservation(&binding, &slot).unwrap().unwrap();
    core.arm_source_effects(&reservation, &binding, &slot, &bytes)
        .unwrap();
    fixture.restart();
    fixture
        .service
        .local(Operation::Open {
            project: fixture.project.id.clone(),
            path: "main.typ".into(),
        })
        .unwrap();
    assert_eq!(fs::read_to_string(&fixture.file).unwrap(), "Captured");
    assert!(!crate::service::journal_path(&fixture.file).exists());
    let versions = fixture.versions().await;
    assert_eq!(versions.len(), 1);
    assert_eq!(versions[0].version_id, reference.event_id);
    assert!(versions[0].after_recovery);
    assert!(fixture
        .core()
        .producer_reservation(&binding, &slot)
        .unwrap()
        .is_none());
}

#[tokio::test]
async fn committed_native_history_cleans_only_verified_completion_and_never_replays_newer_source() {
    use crate::service::source_files::Member;
    for journal_present in [false, true] {
        for external_edit in [false, true] {
            let fixture = Fixture::new("Original");
            let (journal, bytes) = interrupted_native_save(&fixture).await;
            let reference = journal.history.as_ref().unwrap();
            let (group, binding, slot) = fixture.source_context();
            let core = fixture.core();
            let reservation = core.producer_reservation(&binding, &slot).unwrap().unwrap();
            let mut producer = Service::history_existing_producer(
                core,
                binding.clone(),
                slot.clone(),
                reservation,
            );
            producer.arm(&bytes).unwrap();
            let source = group
                .read_utf8(Member::Source, crate::document::MAX_TEXT)
                .unwrap();
            let metadata = group
                .read_utf8(Member::Review, crate::document::MAX_TEXT * 8)
                .unwrap();
            let pending = group
                .read_bytes(Member::Journal, crate::document::MAX_TEXT * 9)
                .unwrap();
            let new_source = replaced(
                group
                    .replace(
                        Member::Source,
                        source.expectation(),
                        journal.content.as_bytes(),
                        crate::document::MAX_TEXT,
                        &[
                            (Member::Review, metadata.expectation()),
                            (Member::Journal, pending.expectation()),
                        ],
                    )
                    .unwrap(),
            )
            .unwrap();
            let review_json = serde_json::to_string_pretty(&journal.review).unwrap();
            replaced(
                group
                    .replace(
                        Member::Review,
                        metadata.expectation(),
                        review_json.as_bytes(),
                        crate::document::MAX_TEXT * 8,
                        &[
                            (Member::Source, &new_source),
                            (Member::Journal, pending.expectation()),
                        ],
                    )
                    .unwrap(),
            )
            .unwrap();
            fixture
                .service
                .observe_policy(&fixture.file, Some(&review_json))
                .unwrap();
            let ownership = journal.ownership.as_ref().unwrap();
            fixture
                .service
                .finish_journal_ownership_rooted(
                    ownership,
                    &fixture.file,
                    &journal.content,
                    &review_json,
                    &group,
                )
                .unwrap();
            producer
                .finalize(&fixture.service, &group, &bytes, false)
                .unwrap();
            assert_eq!(
                fixture
                    .core()
                    .producer_reservation(&binding, &slot)
                    .unwrap()
                    .unwrap()
                    .phase(),
                history::ProducerPhase::CommittedPinned
            );
            if !journal_present {
                group.retire_journal(pending.expectation()).unwrap();
            }
            if external_edit {
                fs::write(&fixture.file, "External newer source").unwrap();
            }
            let before = snapshot(fixture.temporary.path());
            let source_identity = fs::metadata(&fixture.file).unwrap();
            let result = fixture
                .native(Operation::Open {
                    project: fixture.project.id.clone(),
                    path: "main.typ".into(),
                })
                .await;
            if external_edit {
                assert!(result.is_err());
                assert_eq!(snapshot(fixture.temporary.path()), before);
                assert_eq!(
                    fs::read_to_string(&fixture.file).unwrap(),
                    "External newer source"
                );
                assert_eq!(
                    fixture
                        .core()
                        .producer_reservation(&binding, &slot)
                        .unwrap()
                        .unwrap()
                        .phase(),
                    history::ProducerPhase::CommittedPinned
                );
            } else {
                result.unwrap();
                assert_eq!(fs::read_to_string(&fixture.file).unwrap(), "Captured");
                assert_eq!(
                    fs::metadata(&fixture.file).unwrap().modified().unwrap(),
                    source_identity.modified().unwrap()
                );
                #[cfg(unix)]
                {
                    use std::os::unix::fs::MetadataExt;
                    let after = fs::metadata(&fixture.file).unwrap();
                    assert_eq!(
                        (after.dev(), after.ino()),
                        (source_identity.dev(), source_identity.ino()),
                        "completion cleanup must not replace the source entry"
                    );
                }
                assert!(!crate::service::journal_path(&fixture.file).exists());
                assert!(fixture
                    .core()
                    .producer_reservation(&binding, &slot)
                    .unwrap()
                    .is_none());
            }
            let versions = fixture.versions().await;
            assert_eq!(versions.len(), 1);
            assert_eq!(versions[0].version_id, reference.event_id);
            assert!(
                !versions[0].after_recovery,
                "completion cannot relabel an already confirmed archive event"
            );
            assert_eq!(fixture.read_version(&versions[0]).await.content, "Captured");
        }
    }
}

#[tokio::test]
async fn physical_project_alias_and_new_epoch_cannot_bypass_unarmed_metadata_write_fences() {
    let fixture = Fixture::new("Original");
    let nested = fixture.project.root.join("nested");
    fs::create_dir(&nested).unwrap();
    fs::write(nested.join("main.typ"), "Nested original").unwrap();
    fixture
        .service
        .local(Operation::SetMainDocument {
            project: fixture.project.id.clone(),
            path: "nested/main.typ".into(),
        })
        .unwrap();
    fixture
        .native(Operation::Mark {
            project: fixture.project.id.clone(),
            path: "nested/main.typ".into(),
            revision: crate::document::digest("Nested original"),
            from: 0,
            to: 15,
            rule: "snappier".into(),
            prompt: String::new(),
        })
        .await
        .unwrap();
    let parent_grant = fixture
        .native(Operation::Share {
            project: fixture.project.id.clone(),
            path: "nested/main.typ".into(),
            enabled: true,
            context_shared: true,
            expected_context_scope: fixture
                .service
                .test_context_scope(&fixture.project.id, "nested/main.typ"),
        })
        .await
        .unwrap()["documentId"]
        .as_str()
        .unwrap()
        .to_owned();
    let child: Project = serde_json::from_value(
        fixture
            .service
            .local(Operation::AddProject {
                root: nested.to_string_lossy().into_owned(),
            })
            .unwrap(),
    )
    .unwrap();
    let child_root = crate::service::source_files::RootedRoot::observe(&child.root).unwrap();
    let child_grant = fixture
        .service
        .dispatch_native_source(
            "main",
            &fixture.owner,
            SourceRequest {
                operation: Operation::Share {
                    project: child.id.clone(),
                    path: "main.typ".into(),
                    enabled: true,
                    context_shared: true,
                    expected_context_scope: fixture
                        .service
                        .test_context_scope(&child.id, "main.typ"),
                },
                source_epoch: 0,
                expected_root: Some(child_root),
            },
        )
        .await
        .unwrap()["documentId"]
        .as_str()
        .unwrap()
        .to_owned();
    *crate::service::lock(&fixture.service.fail_after_journal).unwrap() = true;
    assert!(fixture
        .native(Operation::Save {
            project: fixture.project.id.clone(),
            path: "nested/main.typ".into(),
            revision: crate::document::digest("Nested original"),
            content: "Unapplied nested draft".into()
        })
        .await
        .is_err());
    {
        let identity = ("main".to_owned(), fixture.owner.clone());
        let _guard = fixture
            .service
            .source_effect_guard(Some(&identity))
            .unwrap();
        let group = fixture
            .service
            .acquire_group(
                crate::service::SourceBinding::new(&fixture.project.id, "nested/main.typ", 0)
                    .rooted(Some(fixture.root)),
            )
            .unwrap();
        let journal = group
            .read_bytes(
                crate::service::source_files::Member::Journal,
                crate::document::MAX_TEXT * 9,
            )
            .unwrap();
        group.retire_journal(journal.expectation()).unwrap();
    }
    let before = snapshot(fixture.temporary.path());
    for grant in [&parent_grant, &child_grant] {
        assert_code(
            fixture.proposal(
                grant,
                "Nested original",
                "Remote bypass",
                "pending-slot-alias",
            ),
            "busy",
        );
    }
    assert!(fixture
        .service
        .local(Operation::Save {
            project: child.id.clone(),
            path: "main.typ".into(),
            revision: crate::document::digest("Nested original"),
            content: "Legacy alias bypass".into()
        })
        .is_err());
    assert_eq!(snapshot(fixture.temporary.path()), before);
    {
        let mut registry = crate::service::lock(&fixture.service.registry).unwrap();
        registry
            .source_epochs
            .entry(child.id.clone())
            .or_default()
            .insert("main.typ".into(), 1);
        fixture.service.save_registry(&registry).unwrap();
    }
    let before = snapshot(fixture.temporary.path());
    assert_code(
        fixture.service.local_source(SourceRequest {
            operation: Operation::Mark {
                project: child.id.clone(),
                path: "main.typ".into(),
                revision: crate::document::digest("Nested original"),
                from: 0,
                to: 6,
                rule: "protect".into(),
                prompt: String::new(),
            },
            source_epoch: 1,
            expected_root: Some(child_root),
        }),
        "busy",
    );
    assert_eq!(snapshot(fixture.temporary.path()), before);
    assert_eq!(
        fs::read_to_string(nested.join("main.typ")).unwrap(),
        "Nested original"
    );
}

#[tokio::test]
async fn replaced_project_root_cannot_resume_an_old_native_history_operation() {
    let fixture = Fixture::new("Original");
    interrupted_native_save(&fixture).await;
    fs::rename(
        &fixture.project.root,
        fixture.temporary.path().join("original-project"),
    )
    .unwrap();
    fs::create_dir(&fixture.project.root).unwrap();
    fs::write(&fixture.file, "Replacement root source").unwrap();
    let before = snapshot(fixture.temporary.path());
    assert_code(
        fixture
            .native(Operation::Open {
                project: fixture.project.id.clone(),
                path: "main.typ".into(),
            })
            .await,
        "stale_root",
    );
    assert!(fixture
        .native(Operation::Save {
            project: fixture.project.id.clone(),
            path: "main.typ".into(),
            revision: crate::document::digest("Replacement root source"),
            content: "Old callback write".into()
        })
        .await
        .is_err());
    assert_eq!(snapshot(fixture.temporary.path()), before);
    assert_eq!(
        fs::read_to_string(fixture.temporary.path().join("original-project/main.typ")).unwrap(),
        "Original"
    );
    assert_eq!(
        fs::read_to_string(&fixture.file).unwrap(),
        "Replacement root source"
    );
}

#[tokio::test]
async fn legacy_approved_app_state_overlap_refuses_history_before_any_source_or_archive_write() {
    let fixture = Fixture::new("Original");
    {
        let mut registry = crate::service::lock(&fixture.service.registry).unwrap();
        let mut overlapping = fixture.project.clone();
        overlapping.id = uuid::Uuid::new_v4().to_string();
        overlapping.root = fixture.temporary.path().canonicalize().unwrap();
        registry.projects.push(overlapping);
        fixture.service.save_registry(&registry).unwrap();
    }
    let before = snapshot(fixture.temporary.path());
    assert_code(
        fixture.query(fixture.list_query(None, None)).await,
        "history_state_overlap",
    );
    assert_code(
        fixture
            .native(Operation::Save {
                project: fixture.project.id.clone(),
                path: "main.typ".into(),
                revision: crate::document::digest("Original"),
                content: "Unsaved overlapping draft".into(),
            })
            .await,
        "history_state_overlap",
    );
    assert_eq!(snapshot(fixture.temporary.path()), before);
    assert!(!fixture.service.state.join("history-v1").exists());
    assert_eq!(fs::read_to_string(&fixture.file).unwrap(), "Original");
}

#[tokio::test]
async fn only_authentic_native_save_finishes_pristine_unanchored_initialization_with_the_same_uuid()
{
    let fixture = Fixture::new("Original");
    let directory =
        cap_std::fs::Dir::open_ambient_dir(&fixture.service.state, cap_std::ambient_authority())
            .unwrap();
    let id = uuid::Uuid::new_v4();
    history::HistoryStore::initialize(&directory, id).unwrap();
    assert!(crate::service::lock(&fixture.service.registry)
        .unwrap()
        .history_store_id
        .is_none());
    let before = snapshot(fixture.temporary.path());
    assert_code(
        fixture.query(fixture.list_query(None, None)).await,
        "history_unavailable",
    );
    assert!(crate::service::lock(&fixture.service.registry)
        .unwrap()
        .history_store_id
        .is_none());
    assert_eq!(snapshot(fixture.temporary.path()), before);
    fixture
        .save("Original", "Captured after initialization crash")
        .await;
    {
        let registry = crate::service::lock(&fixture.service.registry).unwrap();
        assert_eq!(
            registry.history_store_id.as_deref(),
            Some(id.to_string().as_str())
        );
        assert_eq!(
            registry
                .source_epochs
                .get(&fixture.project.id)
                .and_then(|paths| paths.get("main.typ")),
            Some(&0),
            "native capture persists epoch zero before later lifecycle reuse"
        );
    }
    let versions = fixture.versions().await;
    assert_eq!(versions.len(), 1);
    assert_eq!(
        fixture.read_version(&versions[0]).await.content,
        "Captured after initialization crash"
    );
    assert_eq!(
        fs::read_to_string(&fixture.file).unwrap(),
        "Captured after initialization crash"
    );
}

#[tokio::test]
async fn native_archive_queries_work_after_the_entire_approved_project_root_is_moved_or_removed() {
    for removed in [false, true] {
        let fixture = Fixture::new("Original");
        fixture.save("Original", "Archived 🧪\r\n").await;
        let version = fixture.versions().await.remove(0);
        if removed {
            fs::remove_dir_all(&fixture.project.root).unwrap();
        } else {
            fs::rename(
                &fixture.project.root,
                fixture.temporary.path().join("detached-project"),
            )
            .unwrap();
        }
        assert!(!fixture.project.root.exists());
        let before = snapshot(fixture.temporary.path());
        let versions = fixture.versions().await;
        assert_eq!(versions.len(), 1);
        assert_eq!(versions[0].version_id, version.version_id);
        assert_eq!(
            fixture.read_version(&version).await.content,
            "Archived 🧪\r\n"
        );
        let comparison = fixture
            .query(HistoryQuery::Compare {
                project_id: fixture.project.id.clone(),
                namespace_id: version.namespace_id.clone(),
                source_id: version.source_id.clone(),
                from_version_id: version.version_id.clone(),
                to_version_id: version.version_id.clone(),
            })
            .await
            .unwrap();
        assert!(
            matches!(comparison, HistoryReply::Compare(comparison) if comparison.from.content == "Archived 🧪\r\n" && comparison.to.content == comparison.from.content && comparison.from_changed.is_none() && comparison.to_changed.is_none())
        );
        assert_eq!(snapshot(fixture.temporary.path()), before);
        assert!(!fixture.project.root.exists());
    }
}

fn retire_inert_fixture_journal(fixture: &Fixture) {
    let identity = ("main".to_owned(), fixture.owner.clone());
    let _guard = fixture
        .service
        .source_effect_guard(Some(&identity))
        .unwrap();
    let (group, binding, slot) = fixture.source_context();
    assert_eq!(
        fixture
            .core()
            .producer_reservation(&binding, &slot)
            .unwrap()
            .unwrap()
            .phase(),
        history::ProducerPhase::Unarmed
    );
    let journal = group
        .read_bytes(
            crate::service::source_files::Member::Journal,
            crate::document::MAX_TEXT * 9,
        )
        .unwrap();
    group.retire_journal(journal.expectation()).unwrap();
}

#[tokio::test]
async fn incoming_git_fast_forward_stops_at_private_pending_before_head_index_source_or_registry_effects(
) {
    let fixture = Fixture::new("Original");
    let remote = fixture.temporary.path().join("remote.git");
    let peer = fixture.temporary.path().join("peer");
    git(
        fixture.temporary.path(),
        &["init", "--bare", remote.to_str().unwrap()],
    )
    .await
    .unwrap();
    git(&fixture.project.root, &["init", "-b", "main"])
        .await
        .unwrap();
    git(
        &fixture.project.root,
        &["config", "user.name", "UnderTree History fixture"],
    )
    .await
    .unwrap();
    git(
        &fixture.project.root,
        &["config", "user.email", "history@example.invalid"],
    )
    .await
    .unwrap();
    git(
        &fixture.project.root,
        &["remote", "add", "origin", remote.to_str().unwrap()],
    )
    .await
    .unwrap();
    git(&fixture.project.root, &["add", "--", "main.typ"])
        .await
        .unwrap();
    git(&fixture.project.root, &["commit", "-m", "Initial source"])
        .await
        .unwrap();
    git(&fixture.project.root, &["push", "origin", "main"])
        .await
        .unwrap();
    git(
        fixture.temporary.path(),
        &[
            "clone",
            "--branch",
            "main",
            remote.to_str().unwrap(),
            peer.to_str().unwrap(),
        ],
    )
    .await
    .unwrap();
    git(&peer, &["config", "user.name", "UnderTree remote fixture"])
        .await
        .unwrap();
    git(&peer, &["config", "user.email", "remote@example.invalid"])
        .await
        .unwrap();
    fs::write(peer.join("main.typ"), "Incoming remote source").unwrap();
    git(&peer, &["add", "--", "main.typ"]).await.unwrap();
    git(&peer, &["commit", "-m", "Incoming source change"])
        .await
        .unwrap();
    git(&peer, &["push", "origin", "main"]).await.unwrap();
    interrupted_native_save(&fixture).await;
    retire_inert_fixture_journal(&fixture);
    let approved = fixture.service.project(&fixture.project.id).unwrap();
    assert!(approved.pending.is_empty());
    assert!(approved.pending_revisions.is_empty());
    assert_eq!(
        git(
            &approved.root,
            &["status", "--porcelain=v1", "-z", "--untracked-files=all"]
        )
        .await
        .unwrap(),
        ""
    );
    let head_before = git(&approved.root, &["rev-parse", "HEAD"]).await.unwrap();
    let remote_head = git(&peer, &["rev-parse", "HEAD"]).await.unwrap();
    assert_ne!(head_before, remote_head);
    assert_eq!(
        git(
            &peer,
            &["merge-base", head_before.trim(), remote_head.trim()]
        )
        .await
        .unwrap(),
        head_before,
        "the incoming branch is an actual fast-forward"
    );
    let index_before = fs::read(approved.root.join(".git/index")).unwrap();
    let source_before = fs::read(&fixture.file).unwrap();
    let state_before = snapshot(&fixture.service.state);
    assert_code(
        fixture
            .service
            .sync_remote(
                &approved,
                remote.to_str().unwrap(),
                remote.to_str().unwrap(),
            )
            .await,
        "busy",
    );
    assert_eq!(
        git(&approved.root, &["rev-parse", "HEAD"]).await.unwrap(),
        head_before
    );
    assert_eq!(
        fs::read(approved.root.join(".git/index")).unwrap(),
        index_before
    );
    assert_eq!(fs::read(&fixture.file).unwrap(), source_before);
    assert_eq!(snapshot(&fixture.service.state), state_before);
    let pending = fixture.core().producer_reservations().unwrap();
    assert_eq!(pending.len(), 1);
    assert_eq!(pending[0].phase(), history::ProducerPhase::Unarmed);
    assert!(fixture
        .service
        .project(&fixture.project.id)
        .unwrap()
        .pending
        .is_empty());
}

#[tokio::test]
async fn create_absent_entry_is_blocked_without_epochs_or_outputs_even_after_pending_parent_moves()
{
    for moved_parent in [false, true] {
        let fixture = Fixture::new("Original");
        let destination = fixture.temporary.path().join("independent-project");
        fs::create_dir(&destination).unwrap();
        let independent: Project = serde_json::from_value(
            fixture
                .service
                .local(Operation::AddProject {
                    root: destination.to_string_lossy().into_owned(),
                })
                .unwrap(),
        )
        .unwrap();
        let independent_root =
            crate::service::source_files::RootedRoot::observe(&independent.root).unwrap();
        interrupted_native_save(&fixture).await;
        retire_inert_fixture_journal(&fixture);
        let (target, expected_root, source) = if moved_parent {
            fs::rename(&fixture.project.root, destination.join("moved-parent")).unwrap();
            (
                &independent,
                independent_root,
                destination.join("moved-parent/main.typ"),
            )
        } else {
            (&fixture.project, fixture.root, fixture.file.clone())
        };
        let before = snapshot(fixture.temporary.path());
        let epochs_before = crate::service::lock(&fixture.service.registry)
            .unwrap()
            .source_epochs
            .clone();
        assert_code(
            fixture
                .service
                .dispatch_native_source(
                    "main",
                    &fixture.owner,
                    SourceRequest {
                        operation: Operation::Create {
                            project: target.id.clone(),
                            path: "absent.typ".into(),
                        },
                        source_epoch: 0,
                        expected_root: Some(expected_root),
                    },
                )
                .await,
            "busy",
        );
        assert_eq!(snapshot(fixture.temporary.path()), before);
        assert_eq!(
            crate::service::lock(&fixture.service.registry)
                .unwrap()
                .source_epochs,
            epochs_before
        );
        assert!(!target.root.join("absent.typ").exists());
        assert!(!crate::service::sidecar(&target.root.join("absent.typ")).exists());
        assert!(!crate::service::journal_path(&target.root.join("absent.typ")).exists());
        assert_eq!(fs::read_to_string(source).unwrap(), "Original");
        let pending = fixture.core().producer_reservations().unwrap();
        assert_eq!(pending.len(), 1);
        assert_eq!(pending[0].binding().project_id, fixture.project.id);
        assert_eq!(pending[0].phase(), history::ProducerPhase::Unarmed);
    }
}

#[cfg(unix)]
#[tokio::test]
async fn permission_denied_autosave_preserves_dirty_session_and_allows_one_native_cli_save_after_restore(
) {
    use std::os::unix::fs::PermissionsExt;

    struct RestorePermissions {
        directory: PathBuf,
        original: fs::Permissions,
    }
    impl RestorePermissions {
        fn restore(&self) {
            fs::set_permissions(&self.directory, self.original.clone()).unwrap();
        }
    }
    impl Drop for RestorePermissions {
        fn drop(&mut self) {
            let _ = fs::set_permissions(&self.directory, self.original.clone());
        }
    }

    let fixture = Fixture::new("Original");
    let content = "Dirty e\u{301} 🧪\r\n";
    let generation = 7;
    let registration = editor_operation(
        &fixture,
        None,
        EditorOperation::EditorRegister {
            project: fixture.project.id.clone(),
            path: "main.typ".into(),
            source_epoch: 0,
            expected_root: Some(fixture.root),
            generation,
            revision: crate::document::digest("Original"),
            content_digest: crate::document::digest(content),
            dirty: true,
            composing: false,
            conflict: false,
        },
    )
    .await
    .unwrap();
    let session_id = registration["sessionId"].as_str().unwrap().to_owned();
    assert_code(fixture.service.assert_clean_editor_buffers(), "busy");
    let project_before = snapshot(&fixture.project.root);
    let permissions = RestorePermissions {
        directory: fixture.project.root.clone(),
        original: fs::metadata(&fixture.project.root).unwrap().permissions(),
    };
    fs::set_permissions(&fixture.project.root, fs::Permissions::from_mode(0o555)).unwrap();
    assert_eq!(
        fs::metadata(&fixture.project.root)
            .unwrap()
            .permissions()
            .mode()
            & 0o777,
        0o555
    );
    assert_code(
        fixture
            .native(Operation::Save {
                project: fixture.project.id.clone(),
                path: "main.typ".into(),
                revision: crate::document::digest("Original"),
                content: content.into(),
            })
            .await,
        "io",
    );
    assert!(!crate::service::journal_path(&fixture.file).exists());
    assert!(!crate::service::sidecar(&fixture.file).exists());
    assert_eq!(snapshot(&fixture.project.root), project_before);
    assert_eq!(fs::read_to_string(&fixture.file).unwrap(), "Original");
    assert!(
        fixture.versions().await.is_empty(),
        "a refused autosave is never a saved History version"
    );
    assert_code(fixture.service.assert_clean_editor_buffers(), "busy");
    permissions.restore();
    if fixture.service.state.join("history-v1").exists() {
        assert!(
            fixture.core().producer_reservations().unwrap().is_empty(),
            "a proven pre-Journal IO refusal must not strand an unarmed native producer"
        );
    }

    let request_id = uuid::Uuid::new_v4().to_string();
    let service = fixture.service.clone();
    let operation = Operation::SaveEditor {
        project: fixture.project.id.clone(),
        path: "main.typ".into(),
        request_id: request_id.clone(),
    };
    let requested = tokio::spawn(async move { service.dispatch(operation).await });
    let pending = tokio::time::timeout(std::time::Duration::from_secs(3), async {
        loop {
            let polled = editor_operation(&fixture, None, EditorOperation::EditorPoll {})
                .await
                .unwrap();
            if let Some(request) = polled["requests"]
                .as_array()
                .unwrap()
                .iter()
                .find(|entry| entry["requestId"] == request_id)
            {
                break request.clone();
            }
            tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        }
    })
    .await
    .expect("the same native editor session must receive the later CLI save");
    assert_eq!(
        pending["sessionId"], session_id,
        "the permission failure must not replace the dirty session"
    );
    let ticket = pending["ticket"].as_str().unwrap().to_owned();
    let commit = || EditorOperation::EditorCommit {
        request_id: request_id.clone(),
        ticket: ticket.clone(),
        session_id: session_id.clone(),
        generation,
        revision: crate::document::digest("Original"),
        content: content.into(),
    };
    let saved = editor_operation(&fixture, None, commit()).await.unwrap();
    assert_eq!(saved["receipt"]["status"], "committed");
    assert_eq!(saved["receipt"]["requestId"], request_id);
    let versions = fixture.versions().await;
    assert_eq!(versions.len(), 1);
    let version_id = versions[0].version_id.clone();
    assert_eq!(versions[0].cause, "native_save");
    assert_eq!(fixture.read_version(&versions[0]).await.content, content);
    editor_operation(&fixture, None, commit()).await.unwrap();
    assert_eq!(fixture.versions().await.len(), 1);
    assert_eq!(fixture.versions().await[0].version_id, version_id);
    editor_operation(
        &fixture,
        None,
        EditorOperation::EditorComplete {
            request_id,
            ticket,
            session_id,
            status: BufferResult::Saved,
            generation,
        },
    )
    .await
    .unwrap();
    let receipt = tokio::time::timeout(std::time::Duration::from_secs(3), requested)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    assert_eq!(receipt["status"], "committed");
    assert_eq!(fs::read_to_string(&fixture.file).unwrap(), content);
    assert!(!crate::service::journal_path(&fixture.file).exists());
    assert!(fixture.core().producer_reservations().unwrap().is_empty());
}

#[tokio::test]
async fn persisted_history_epoch_zero_survives_restart_and_recreation_advances_without_adopting_old_history(
) {
    let mut fixture = Fixture::new("Original");
    assert!(!fixture.project.root.join(".git").exists());
    let saved_zero = "Saved epoch zero e\u{301} 🧪\r\n";
    fixture.save("Original", saved_zero).await;
    let original = fixture.versions().await.remove(0);
    assert_eq!(original.binding.source_epoch, 0);
    fixture.restart();
    {
        let registry = crate::service::lock(&fixture.service.registry).unwrap();
        assert_eq!(registry.source_epochs.get(&fixture.project.id).and_then(|paths| paths.get("main.typ")), Some(&0), "the actual native capture durably recorded zero rather than relying on a missing-entry default");
    }
    assert_eq!(fixture.read_version(&original).await.content, saved_zero);
    fs::remove_file(&fixture.file).unwrap();
    fs::remove_file(crate::service::sidecar(&fixture.file)).unwrap();
    let archive_before = snapshot(&fixture.service.state.join("history-v1"));
    let created = fixture
        .native(Operation::Create {
            project: fixture.project.id.clone(),
            path: "main.typ".into(),
        })
        .await
        .unwrap();
    assert_eq!(created["sourceEpoch"], 1);
    assert_eq!(
        fixture
            .service
            .source_epoch(&fixture.project.id, "main.typ")
            .unwrap(),
        1
    );
    let fresh = created["content"].as_str().unwrap();
    assert_ne!(fresh, saved_zero);
    assert!(fresh.contains("Start writing here."));
    assert_eq!(fs::read_to_string(&fixture.file).unwrap(), fresh);
    assert_eq!(
        created["review"]["revision"],
        crate::document::digest(fresh)
    );
    let versions = fixture.versions().await;
    assert_eq!(
        versions.len(),
        1,
        "Create has no saved-History baseline or inherited lineage"
    );
    assert_eq!(versions[0].version_id, original.version_id);
    assert_eq!(versions[0].source_id, original.source_id);
    assert_eq!(versions[0].binding.source_epoch, 0);
    let read = fixture.read_version(&original).await;
    assert_eq!(read.content, saved_zero);
    assert_eq!(read.version.version_id, original.version_id);
    assert_eq!(read.version.binding.source_epoch, 0);
    assert_eq!(
        snapshot(&fixture.service.state.join("history-v1")),
        archive_before
    );
    assert!(!fixture.project.root.join(".git").exists());
}

#[tokio::test]
async fn initialized_history_refuses_new_overlapping_project_approvals_but_keeps_equal_and_independent_approvals(
) {
    let fixture = Fixture::new("Original");
    fixture.save("Original", "Saved").await;
    let independent = fixture.temporary.path().join("state-neighbor");
    fs::create_dir(&independent).unwrap();
    let before = snapshot(fixture.temporary.path());
    let registry_before =
        serde_json::to_vec(&*crate::service::lock(&fixture.service.registry).unwrap()).unwrap();
    let source_before = snapshot(&fixture.project.root);
    let archive_before = snapshot(&fixture.service.state.join("history-v1"));
    for root in [
        fixture.temporary.path().to_owned(),
        fixture.service.state.clone(),
        fixture.service.state.join("history-v1/blobs"),
    ] {
        assert_code(
            fixture.service.local(Operation::AddProject {
                root: root.to_string_lossy().into_owned(),
            }),
            "history_state_overlap",
        );
        assert_eq!(snapshot(fixture.temporary.path()), before);
        assert_eq!(
            serde_json::to_vec(&*crate::service::lock(&fixture.service.registry).unwrap()).unwrap(),
            registry_before
        );
    }
    let equal = fixture
        .service
        .local(Operation::AddProject {
            root: fixture.project.root.to_string_lossy().into_owned(),
        })
        .unwrap();
    assert_eq!(equal["id"], fixture.project.id);
    assert_eq!(
        crate::service::lock(&fixture.service.registry)
            .unwrap()
            .projects
            .len(),
        1
    );
    assert_eq!(
        serde_json::to_vec(&*crate::service::lock(&fixture.service.registry).unwrap()).unwrap(),
        registry_before
    );
    assert_eq!(snapshot(fixture.temporary.path()), before);
    let approved: Project = serde_json::from_value(
        fixture
            .service
            .local(Operation::AddProject {
                root: independent.to_string_lossy().into_owned(),
            })
            .unwrap(),
    )
    .unwrap();
    assert_ne!(approved.id, fixture.project.id);
    assert_eq!(approved.root, independent.canonicalize().unwrap());
    assert_eq!(approved.name, "state-neighbor");
    assert_eq!(
        crate::service::lock(&fixture.service.registry)
            .unwrap()
            .projects
            .len(),
        2
    );
    assert_eq!(snapshot(&fixture.project.root), source_before);
    assert_eq!(
        snapshot(&fixture.service.state.join("history-v1")),
        archive_before
    );
}
