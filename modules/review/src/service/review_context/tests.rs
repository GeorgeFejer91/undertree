use super::*;
use crate::document::{AccessMode, Action, Decision, Proposal};
use crate::service::editor::EditorOperation;

struct Fixture {
    _temp: tempfile::TempDir,
    service: Arc<Service>,
    project: String,
    root: PathBuf,
    path: String,
    text: String,
    document: String,
}

impl Fixture {
    fn new(text: &str) -> Self {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("project");
        fs::create_dir(&root).unwrap();
        fs::write(root.join("main.typ"), text).unwrap();
        let service = Service::new(temp.path().join("state")).unwrap();
        let project = service
            .local(Operation::AddProject {
                root: root.to_string_lossy().into(),
            })
            .unwrap()["id"]
            .as_str()
            .unwrap()
            .into();
        Self {
            _temp: temp,
            service,
            project,
            root,
            path: "main.typ".into(),
            text: text.into(),
            document: String::new(),
        }
    }
    fn preview(&self) -> Result<Value> {
        self.service.local(Operation::ContextPreview {
            project: self.project.clone(),
            path: self.path.clone(),
        })
    }
    fn share(&mut self) {
        let scope = self.preview().unwrap()["scopeId"]
            .as_str()
            .unwrap()
            .to_owned();
        self.document = self
            .service
            .local(Operation::Share {
                project: self.project.clone(),
                path: self.path.clone(),
                enabled: true,
                context_shared: true,
                expected_context_scope: Some(scope),
            })
            .unwrap()["documentId"]
            .as_str()
            .unwrap()
            .into();
    }
    fn mark(&self, from: usize, to: usize, rule: &str) -> Value {
        self.service
            .local(Operation::Mark {
                project: self.project.clone(),
                path: self.path.clone(),
                revision: digest(&self.text),
                from,
                to,
                rule: rule.into(),
                prompt: String::new(),
            })
            .unwrap()
    }
    fn read(&self) -> Result<Value> {
        self.service
            .remote("read_manuscript", json!({"documentId":self.document}))
    }
    fn request(&self, token: Option<&str>, from: usize, to: usize, id: &str) -> Value {
        json!({"documentId":self.document,"proposal":{"requestId":id,"contextId":token,"revision":digest(&self.text),"from":from,"to":to,"quote":crate::document::selected(&self.text,from,to).unwrap(),"replacement":"Clear wording","rationale":"Follow every prompt."}})
    }
    fn rules(&self) -> Vec<crate::document::Rule> {
        serde_json::from_value(
            self.service
                .local(Operation::Review {
                    project: self.project.clone(),
                    path: self.path.clone(),
                })
                .unwrap()["review"]["rules"]
                .clone(),
        )
        .unwrap()
    }
}

#[test]
fn complete_read_is_native_required_for_both_modes_and_replay_has_no_second_effect() {
    for direct in [false, true] {
        let mut f = Fixture::new("Marked passage. Unmarked context.");
        if direct {
            let mut rules = f.rules();
            let initial = rules.clone();
            rules[1].access_mode = AccessMode::Direct;
            f.service
                .local(Operation::Palette {
                    project: f.project.clone(),
                    path: f.path.clone(),
                    revision: digest(&f.text),
                    rules,
                    expected_rules: Some(initial),
                })
                .unwrap();
        }
        f.mark(0, 15, "snappier");
        f.share();
        assert_eq!(
            f.service
                .remote("suggest_text", f.request(None, 0, 15, "no-read"))
                .unwrap_err()
                .code,
            "context_required"
        );
        assert_eq!(
            f.service
                .remote("suggest_text", f.request(Some("forged"), 0, 15, "forged"))
                .unwrap_err()
                .code,
            "context_required"
        );
        let read = f.read().unwrap();
        assert_eq!(read["context"]["complete"], true);
        assert_eq!(read["snapshot"], "saved");
        let request = f.request(read["contextId"].as_str(), 0, 15, "valid");
        let result = f.service.remote("suggest_text", request.clone()).unwrap();
        assert_eq!(result["manuscriptChanged"], direct);
        let bytes = fs::read(f.root.join(&f.path)).unwrap();
        assert_eq!(
            f.service.remote("suggest_text", request).unwrap()["manuscriptChanged"],
            false
        );
        assert_eq!(fs::read(f.root.join(&f.path)).unwrap(), bytes);
    }
}

#[test]
fn complete_context_contains_main_chapters_and_literal_citation_inputs_only() {
    let mut f = Fixture::new(
        "= Main\n#include \"chapter.typ\"\n#bibliography(\"refs.bib\", style: \"custom.csl\")\n",
    );
    fs::write(f.root.join("chapter.typ"), "Chapter prose.").unwrap();
    fs::write(
        f.root.join("refs.bib"),
        "@book{ref,title={Context reference},year={2026}}\n",
    )
    .unwrap();
    fs::write(
        f.root.join("custom.csl"),
        "<style>Literal bibliography context</style>",
    )
    .unwrap();
    fs::write(f.root.join("private.typ"), "UNRELATED PRIVATE MANUSCRIPT").unwrap();
    f.service
        .local(Operation::SetMainDocument {
            project: f.project.clone(),
            path: "main.typ".into(),
        })
        .unwrap();
    f.path = "chapter.typ".into();
    f.text = "Chapter prose.".into();
    f.mark(0, 14, "snappier");
    let preview = f.preview().unwrap();
    let names: Vec<_> = preview["files"]
        .as_array()
        .unwrap()
        .iter()
        .map(|file| file["path"].as_str().unwrap())
        .collect();
    assert_eq!(
        names,
        vec!["chapter.typ", "custom.csl", "main.typ", "refs.bib"]
    );
    f.share();
    let read = f.read().unwrap();
    assert!(!read.to_string().contains("UNRELATED PRIVATE MANUSCRIPT"));
    assert_eq!(read["context"]["main"], "main.typ");
    assert_eq!(read["context"]["files"].as_array().unwrap().len(), 4);
    assert!(read["context"]["files"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|file| file["path"] != "chapter.typ")
        .all(|file| file["editable"] == false));
    assert!(read.to_string().contains("Context reference"));
}

#[test]
fn source_policy_and_share_changes_invalidate_previous_read_receipts() {
    for change in ["source", "policy", "share"] {
        let mut f = Fixture::new("Marked passage. Other context.");
        f.mark(0, 15, "snappier");
        f.share();
        let read = f.read().unwrap();
        let request = f.request(read["contextId"].as_str(), 0, 15, "stale-context");
        match change {
            "source" => {
                fs::write(f.root.join(&f.path), "Marked passage. Changed context.").unwrap()
            }
            "policy" => {
                let mut rules = f.rules();
                let initial = rules.clone();
                rules[1].prompt = "New local wording policy".into();
                f.service
                    .local(Operation::Palette {
                        project: f.project.clone(),
                        path: f.path.clone(),
                        revision: digest(&f.text),
                        rules,
                        expected_rules: Some(initial),
                    })
                    .unwrap();
            }
            _ => {
                f.service
                    .local(Operation::Share {
                        project: f.project.clone(),
                        path: f.path.clone(),
                        enabled: false,
                        context_shared: false,
                        expected_context_scope: None,
                    })
                    .unwrap();
                f.share();
            }
        }
        let error = f.service.remote("suggest_text", request).unwrap_err();
        assert!(
            matches!(error.code, "context_stale" | "context_required"),
            "{}",
            error.code
        );
    }
}

#[test]
fn new_dependency_paths_need_new_local_consent_and_failed_share_preserves_old_grant() {
    let mut f = Fixture::new("#include \"a.typ\"\nMarked passage.");
    fs::write(f.root.join("a.typ"), "First context").unwrap();
    fs::write(f.root.join("b.typ"), "NEW PRIVATE CONTEXT").unwrap();
    f.share();
    let old_generation = lock(&f.service.review_context).unwrap().grants[&f.document]
        .generation
        .clone();
    fs::write(
        f.root.join("main.typ"),
        "#include \"a.typ\"\n#include \"b.typ\"\nMarked passage.",
    )
    .unwrap();
    assert_eq!(f.read().unwrap_err().code, "context_scope");
    let preview = f.preview().unwrap();
    let source = f.root.join("main.typ");
    *lock(&f.service.share_before_commit).unwrap() = Some(Box::new(move || {
        fs::write(&source, "Changed after consent capture.")?;
        Ok(())
    }));
    let result = f.service.local(Operation::Share {
        project: f.project.clone(),
        path: f.path.clone(),
        enabled: true,
        context_shared: true,
        expected_context_scope: preview["scopeId"].as_str().map(str::to_owned),
    });
    assert!(result.is_err());
    let state = lock(&f.service.review_context).unwrap();
    let grant = &state.grants[&f.document];
    assert_eq!(grant.generation, old_generation);
    assert!(!grant.paths.contains("b.typ"));
    drop(state);
    assert!(f
        .service
        .current_shared()
        .unwrap()
        .contains_key(&f.document));
}

#[test]
fn dependency_change_between_discovery_and_source_capture_cannot_claim_complete_context() {
    let f = Fixture::new("Original main prose.");
    fs::write(f.root.join("chapter.typ"), "Previously omitted chapter.").unwrap();
    let source = f.root.join("main.typ");
    *lock(&f.service.context_after_discovery).unwrap() = Some(Box::new(move || {
        fs::write(source, "#include \"chapter.typ\"\nChanged main prose.")?;
        Ok(())
    }));
    assert_eq!(f.preview().unwrap_err().code, "context_scope");
    assert!(lock(&f.service.review_context).unwrap().grants.is_empty());
    assert!(lock(&f.service.review_context).unwrap().receipts.is_empty());
    let preview = f.preview().unwrap();
    assert_eq!(preview["files"].as_array().unwrap().len(), 2);
}

#[tokio::test]
async fn unsaved_chapter_is_never_presented_as_complete_saved_active_context() {
    let mut f = Fixture::new("#include \"chapter.typ\"\nMarked prose.");
    fs::write(f.root.join("chapter.typ"), "Saved chapter").unwrap();
    f.share();
    let owner = f.service.connect_native_editor("main").unwrap()["ownerId"]
        .as_str()
        .unwrap()
        .to_owned();
    let snapshot = f
        .service
        .local(Operation::Review {
            project: f.project.clone(),
            path: "chapter.typ".into(),
        })
        .unwrap();
    f.service
        .editor_native(
            "main",
            &owner,
            EditorOperation::EditorRegister {
                project: f.project.clone(),
                path: "chapter.typ".into(),
                source_epoch: 0,
                expected_root: serde_json::from_value(snapshot["expectedRoot"].clone()).unwrap(),
                generation: 1,
                revision: digest("Saved chapter"),
                content_digest: digest("Unsaved current chapter"),
                dirty: true,
                composing: false,
                conflict: false,
            },
        )
        .await
        .unwrap();
    assert_eq!(f.read().unwrap_err().code, "context_draft");
    assert_eq!(
        fs::read_to_string(f.root.join("chapter.typ")).unwrap(),
        "Saved chapter"
    );
}

#[test]
fn shared_ranges_and_default_rules_are_executable_contracts_at_both_permission_layers() {
    let contract: Value =
        serde_json::from_str(include_str!("../../../selective-editor-contract.json")).unwrap();
    assert_eq!(json!(Review::new("").rules), contract["defaultRules"]);
    for case in contract["rangeCases"].as_array().unwrap() {
        let text = case["text"].as_str().unwrap();
        let mut review = Review::new(text);
        for (index, mark) in case["marks"].as_array().unwrap().iter().enumerate() {
            let id = format!("rule{index}");
            let mut rule = review.rules[1].clone();
            rule.id = id.clone();
            rule.action = serde_json::from_value(mark["action"].clone()).unwrap();
            if rule.action == Action::Neutral {
                rule.prompt.clear();
            }
            rule.access_mode = serde_json::from_value(mark["accessMode"].clone()).unwrap();
            review.rules.push(rule);
            review.markers.push(Marker {
                id: format!("mark{index}"),
                rule: id,
                prompt: String::new(),
                anchor: Anchor::new(
                    text,
                    mark["from"].as_u64().unwrap() as usize,
                    mark["to"].as_u64().unwrap() as usize,
                )
                .unwrap(),
            });
        }
        let p = &case["proposal"];
        let proposal = Proposal {
            context_id: None,
            request_id: case["id"].as_str().unwrap().into(),
            revision: digest(text),
            from: p["from"].as_u64().unwrap() as usize,
            to: p["to"].as_u64().unwrap() as usize,
            quote: p["quote"].as_str().unwrap().into(),
            replacement: p["replacement"].as_str().unwrap().into(),
            replacement_parts: None,
            rationale: String::new(),
        };
        let result = review.propose_format(text, proposal, true);
        if case["result"] == "denied" {
            assert!(result.is_err(), "{}", case["id"]);
            continue;
        }
        let suggestion = result.unwrap();
        assert_eq!(
            review
                .allows_direct(suggestion.anchor.from, suggestion.anchor.to)
                .unwrap(),
            case["result"] == "applied"
        );
        assert!(review
            .decide_format(
                text,
                &digest(text),
                &suggestion.id,
                Decision::Accepted,
                true
            )
            .is_ok());
    }
}

#[test]
fn unmarked_suggestions_gaps_and_local_acceptance_after_highlight_removal_are_denied() {
    let mut f = Fixture::new("First gap Second");
    f.mark(0, 5, "snappier");
    f.mark(10, 16, "snappier");
    f.share();
    let read = f.read().unwrap();
    for (from, to) in [(0, 6), (5, 9), (0, 16)] {
        assert_eq!(
            f.service
                .remote(
                    "suggest_text",
                    f.request(
                        read["contextId"].as_str(),
                        from,
                        to,
                        &format!("gap-{from}-{to}")
                    )
                )
                .unwrap_err()
                .code,
            "highlight_required"
        );
    }
    let result = f
        .service
        .remote(
            "suggest_text",
            f.request(read["contextId"].as_str(), 0, 5, "pending"),
        )
        .unwrap();
    let current = f
        .service
        .local(Operation::Review {
            project: f.project.clone(),
            path: f.path.clone(),
        })
        .unwrap();
    f.service
        .local(Operation::Unmark {
            project: f.project.clone(),
            path: f.path.clone(),
            revision: digest(&f.text),
            id: current["review"]["markers"][0]["id"]
                .as_str()
                .unwrap()
                .into(),
        })
        .unwrap();
    assert_eq!(
        f.service
            .local(Operation::Decide {
                project: f.project.clone(),
                path: f.path.clone(),
                revision: digest(&f.text),
                id: result["suggestion"]["id"].as_str().unwrap().into(),
                decision: Decision::Accepted
            })
            .unwrap_err()
            .code,
        "highlight_required"
    );
    assert_eq!(fs::read_to_string(f.root.join(&f.path)).unwrap(), f.text);
}

#[test]
fn unresolved_context_and_escaped_wire_overflow_never_issue_complete_read_tokens() {
    for text in [
        "#let f=\"chapter.typ\"\n#include f",
        "#import \"@preview/example:0.1.0\": *",
        "#let loader=read\n#loader(\"secret.txt\")",
        "#eval(\"include private\")",
        "#std.at(\"read\")(\"private.txt\")",
    ] {
        let f = Fixture::new(text);
        assert_eq!(f.preview().unwrap_err().code, "context_incomplete");
    }
    let mut f = Fixture::new(&"Plain \\\" quotation. ".repeat(45000));
    f.share();
    assert_eq!(f.read().unwrap_err().code, "context_limit");
    assert!(lock(&f.service.review_context).unwrap().receipts.is_empty());
}
