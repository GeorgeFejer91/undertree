use super::*;

struct Fixture {
    _temp: tempfile::TempDir,
    service: Arc<Service>,
    project: String,
    document: String,
    source: PathBuf,
    text: String,
}
impl Fixture {
    fn new() -> Self {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("project");
        fs::create_dir(&root).unwrap();
        let source = root.join("main.typ");
        let text = "Café 😀 (A, 2020) and (B, 2021).".to_owned();
        fs::write(&source, &text).unwrap();
        let service = Service::new(temp.path().join("state")).unwrap();
        let project = service
            .local(Operation::AddProject {
                root: root.to_string_lossy().into(),
            })
            .unwrap()["id"]
            .as_str()
            .unwrap()
            .to_owned();
        service
            .local(Operation::Open {
                project: project.clone(),
                path: "main.typ".into(),
            })
            .unwrap();
        let document = service
            .local(Operation::Share {
                project: project.clone(),
                path: "main.typ".into(),
                enabled: true,
                context_shared: true,
                expected_context_scope: service.test_context_scope(&project, "main.typ"),
            })
            .unwrap()["documentId"]
            .as_str()
            .unwrap()
            .to_owned();
        Self {
            _temp: temp,
            service,
            project,
            document,
            source,
            text,
        }
    }
    fn request(&self, id: &str) -> Value {
        let read = self
            .service
            .remote("read_manuscript", json!({"documentId":self.document}))
            .unwrap();
        json!({"documentId":self.document,"marking":{"requestId":id,"contextId":read["contextId"],"revision":digest(&self.text),"ranges":[{"from":8,"to":17,"quote":"(A, 2020)"},{"from":22,"to":31,"quote":"(B, 2021)"}]}})
    }
}

#[test]
fn neutral_batch_is_atomic_idempotent_and_grants_no_edit_permission() {
    let f = Fixture::new();
    let mut invalid = f.request("bad");
    invalid["marking"]["ranges"][1]["quote"] = json!("forged");
    let before = fs::read(sidecar(&f.source)).ok();
    assert_eq!(
        f.service
            .remote("highlight_text", invalid)
            .unwrap_err()
            .code,
        "stale"
    );
    assert_eq!(before, fs::read(sidecar(&f.source)).ok());
    let request = f.request("citations");
    let result = f.service.remote("highlight_text", request.clone()).unwrap();
    assert_eq!(result["markers"].as_array().unwrap().len(), 2);
    assert_eq!(fs::read_to_string(&f.source).unwrap(), f.text);
    let metadata = fs::read(sidecar(&f.source)).unwrap();
    assert_eq!(
        f.service.remote("highlight_text", request.clone()).unwrap(),
        result
    );
    assert_eq!(metadata, fs::read(sidecar(&f.source)).unwrap());
    let mut changed = request;
    changed["marking"]["ranges"][0]["quote"] = json!("changed");
    assert_eq!(
        f.service
            .remote("highlight_text", changed)
            .unwrap_err()
            .code,
        "duplicate"
    );
    let read = f
        .service
        .remote("read_manuscript", json!({"documentId":f.document}))
        .unwrap();
    let neutral = read["review"]["rules"]
        .as_array()
        .unwrap()
        .iter()
        .find(|rule| rule["id"] == result["colorId"])
        .unwrap();
    assert_eq!(neutral["action"], "neutral");
    assert_eq!(neutral["prompt"], "");
    assert_eq!(f.service.remote("suggest_text", json!({"documentId":f.document,"proposal":{"requestId":"no-permission","contextId":read["contextId"],"revision":digest(&f.text),"from":8,"to":17,"quote":"(A, 2020)","replacement":"Other","rationale":""}})).unwrap_err().code,"highlight_required");
    let reopened = Service::new(f._temp.path().join("reopened-state")).unwrap();
    let project = reopened
        .local(Operation::AddProject {
            root: f.source.parent().unwrap().to_string_lossy().into(),
        })
        .unwrap()["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let snapshot = reopened
        .local(Operation::Open {
            project,
            path: "main.typ".into(),
        })
        .unwrap();
    assert_eq!(snapshot["review"]["markers"], read["review"]["markers"]);
}

#[test]
fn marking_denies_policy_payloads_rule_reuse_stale_context_unicode_and_revocation() {
    let f = Fixture::new();
    for field in ["prompt", "action", "accessMode", "rules"] {
        let mut request = f.request(field);
        request["marking"][field] = json!("direct");
        assert!(f.service.remote("highlight_text", request).is_err());
    }
    let mut request = f.request("rule-reuse");
    request["marking"]["colorId"] = json!("protect");
    assert_eq!(
        f.service
            .remote("highlight_text", request)
            .unwrap_err()
            .code,
        "highlight"
    );
    let mut request = f.request("surrogate");
    request["marking"]["ranges"] = json!([{"from":6,"to":7,"quote":"x"}]);
    assert_eq!(
        f.service
            .remote("highlight_text", request)
            .unwrap_err()
            .code,
        "range"
    );
    let stale = f.request("stale");
    let first = f
        .service
        .remote("highlight_text", f.request("first"))
        .unwrap();
    assert_eq!(
        f.service.remote("highlight_text", stale).unwrap_err().code,
        "context_stale"
    );
    let mut request = f.request("reuse");
    request["marking"]["colorId"] = first["colorId"].clone();
    let replay = request.clone();
    f.service.remote("highlight_text", request).unwrap();
    let mut review: Review = serde_json::from_value(
        f.service
            .local(Operation::Review {
                project: f.project.clone(),
                path: "main.typ".into(),
            })
            .unwrap()["review"]
            .clone(),
    )
    .unwrap();
    let expected = review.rules.clone();
    review
        .rules
        .iter_mut()
        .find(|rule| rule.id == first["colorId"])
        .unwrap()
        .action = Action::Protect;
    f.service
        .local(Operation::Palette {
            project: f.project.clone(),
            path: "main.typ".into(),
            revision: digest(&f.text),
            rules: review.rules,
            expected_rules: Some(expected),
        })
        .unwrap();
    assert_eq!(
        f.service
            .remote("highlight_text", replay.clone())
            .unwrap_err()
            .code,
        "context_stale"
    );
    f.service
        .local(Operation::Share {
            project: f.project,
            path: "main.typ".into(),
            enabled: false,
            context_shared: false,
            expected_context_scope: None,
        })
        .unwrap();
    assert!(f.service.remote("highlight_text", replay).is_err());
}

#[test]
fn native_protected_rewrites_apply_accept_reanchor_and_recheck_local_policy() {
    for direct in [false, true] {
        let f = Fixture::new();
        let colored = f
            .service
            .remote("highlight_text", f.request("citations"))
            .unwrap();
        let mut review: Review = serde_json::from_value(
            f.service
                .local(Operation::Review {
                    project: f.project.clone(),
                    path: "main.typ".into(),
                })
                .unwrap()["review"]
                .clone(),
        )
        .unwrap();
        let expected = review.rules.clone();
        review
            .rules
            .iter_mut()
            .find(|rule| rule.id == colored["colorId"])
            .unwrap()
            .action = Action::Protect;
        if direct {
            review.rules[1].access_mode = crate::document::AccessMode::Direct;
        }
        f.service
            .local(Operation::Palette {
                project: f.project.clone(),
                path: "main.typ".into(),
                revision: digest(&f.text),
                rules: review.rules,
                expected_rules: Some(expected),
            })
            .unwrap();
        f.service
            .local(Operation::Mark {
                project: f.project.clone(),
                path: "main.typ".into(),
                revision: digest(&f.text),
                from: 0,
                to: f.text.encode_utf16().count(),
                rule: "snappier".into(),
                prompt: String::new(),
            })
            .unwrap();
        let read = f
            .service
            .remote("read_manuscript", json!({"documentId":f.document}))
            .unwrap();
        let proposal = json!({"documentId":f.document,"proposal":{"requestId":"rewrite","contextId":read["contextId"],"revision":digest(&f.text),"from":0,"to":f.text.encode_utf16().count(),"quote":f.text,"replacement":"","replacementParts":[{"protectedId":colored["markers"][1]["id"]},{"text":" then "},{"protectedId":colored["markers"][0]["id"]}],"rationale":"Reorder preserved citations."}});
        let result = f.service.remote("suggest_text", proposal).unwrap();
        assert_eq!(result["manuscriptChanged"], direct);
        let changed = "(B, 2021) then (A, 2020)";
        if !direct {
            assert_eq!(fs::read_to_string(&f.source).unwrap(), f.text);
            let id = result["suggestion"]["id"].as_str().unwrap().to_owned();
            let restarted = Service::new(f._temp.path().join("state")).unwrap();
            assert!(restarted
                .remote("read_manuscript", json!({"documentId":f.document}))
                .is_err());
            restarted
                .local(Operation::Decide {
                    project: f.project.clone(),
                    path: "main.typ".into(),
                    revision: digest(&f.text),
                    id,
                    decision: crate::document::Decision::Accepted,
                })
                .unwrap();
        }
        assert_eq!(fs::read_to_string(&f.source).unwrap(), changed);
        let reopened: Review = serde_json::from_value(
            f.service
                .local(Operation::Review {
                    project: f.project.clone(),
                    path: "main.typ".into(),
                })
                .unwrap()["review"]
                .clone(),
        )
        .unwrap();
        reopened.validate_for_text(changed).unwrap();
        for marker in colored["markers"].as_array().unwrap() {
            let current = reopened
                .markers
                .iter()
                .find(|current| current.id == marker["id"])
                .unwrap();
            assert!(!current.anchor.stale);
            assert_eq!(current.anchor.quote, marker["anchor"]["quote"]);
            assert_eq!(current.rule, colored["colorId"]);
        }
    }
}

#[tokio::test]
async fn complete_context_draft_ime_conflict_guards_block_highlighting_without_saving() {
    use crate::service::editor::EditorOperation;
    for (dirty, composing, conflict) in [
        (true, false, false),
        (false, true, false),
        (false, false, true),
    ] {
        let f = Fixture::new();
        let request = f.request("guarded");
        let owner = f.service.connect_native_editor("main").unwrap()["ownerId"]
            .as_str()
            .unwrap()
            .to_owned();
        let owner = f.service.native_editor_owner("main", &owner).unwrap();
        f.service
            .editor(
                &owner,
                EditorOperation::EditorRegister {
                    project: f.project.clone(),
                    path: "main.typ".into(),
                    source_epoch: 0,
                    expected_root: None,
                    generation: 1,
                    revision: digest(&f.text),
                    content_digest: digest(&f.text),
                    dirty,
                    composing,
                    conflict,
                },
            )
            .await
            .unwrap();
        assert_eq!(
            f.service
                .remote("highlight_text", request)
                .unwrap_err()
                .code,
            "context_draft"
        );
        assert_eq!(fs::read_to_string(&f.source).unwrap(), f.text);
        assert!(!sidecar(&f.source).exists());
    }
}

#[test]
fn postcommit_receipt_failure_keeps_the_request_reserved_and_cannot_duplicate_marking() {
    let f = Fixture::new();
    let request = f.request("uncertain");
    *lock(&f.service.highlight_after_commit).unwrap() = Some(Box::new(|| {
        Err(Error::new(
            "outcome_unknown",
            "Injected lost acknowledgement after commit.",
        ))
    }));
    assert_eq!(
        f.service
            .remote("highlight_text", request.clone())
            .unwrap_err()
            .code,
        "outcome_unknown"
    );
    assert_eq!(
        f.service
            .remote("highlight_text", request)
            .unwrap_err()
            .code,
        "outcome_unknown"
    );
    let fresh = f.request("uncertain");
    assert_eq!(
        f.service.remote("highlight_text", fresh).unwrap_err().code,
        "duplicate"
    );
    let read = f
        .service
        .remote("read_manuscript", json!({"documentId":f.document}))
        .unwrap();
    assert_eq!(read["review"]["markers"].as_array().unwrap().len(), 2);
    assert_eq!(fs::read_to_string(&f.source).unwrap(), f.text);
}
