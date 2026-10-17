use super::*;
use crate::document::{AccessMode, Action, Status};
use crate::service::editor::EditorOperation;

struct Fixture {
    _temp: tempfile::TempDir,
    service: Arc<Service>,
    project: String,
    document: String,
    path: String,
    source: PathBuf,
    text: String,
    from: usize,
}

impl Fixture {
    fn new(typst: bool) -> Self {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("project");
        fs::create_dir(&root).unwrap();
        let path = if typst { "main.typ" } else { "main.html" }.to_owned();
        let text = if typst {
            "Original prose."
        } else {
            "<p>Original prose.</p>"
        }
        .to_owned();
        let from = if typst { 0 } else { 3 };
        let source = root.join(&path);
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
        let document = service
            .local(Operation::Share {
                project: project.clone(),
                path: path.clone(),
                enabled: true,
                context_shared: true,
                expected_context_scope: Some(
                    service
                        .local(Operation::ContextPreview {
                            project: project.clone(),
                            path: path.clone(),
                        })
                        .unwrap()["scopeId"]
                        .as_str()
                        .unwrap()
                        .into(),
                ),
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
            path,
            source,
            text,
            from,
        }
    }

    fn palette(&self, mode: AccessMode) {
        let mut review = self.review();
        let initial = review.rules.clone();
        review.rules[1].access_mode = mode;
        self.service
            .local(Operation::Palette {
                project: self.project.clone(),
                path: self.path.clone(),
                revision: digest(&self.text),
                rules: review.rules,
                expected_rules: Some(initial),
            })
            .unwrap();
    }

    fn mark(&self, rule: &str, from: usize, to: usize) {
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
            .unwrap();
    }

    fn review(&self) -> Review {
        serde_json::from_value(
            self.service
                .local(Operation::Review {
                    project: self.project.clone(),
                    path: self.path.clone(),
                })
                .unwrap()["review"]
                .clone(),
        )
        .unwrap()
    }

    fn raw_proposal(&self, request: &str, from: usize, to: usize, replacement: &str) -> Value {
        json!({"documentId":self.document,"proposal":{"requestId":request,"revision":digest(&self.text),"from":from,"to":to,"quote":crate::document::selected(&self.text,from,to).unwrap(),"replacement":replacement,"rationale":"Follow the marked prompt."}})
    }

    fn proposal(&self, request: &str, from: usize, to: usize, replacement: &str) -> Value {
        let read = self
            .service
            .remote("read_manuscript", json!({"documentId":self.document}))
            .unwrap();
        let mut proposal = self.raw_proposal(request, from, to, replacement);
        proposal["proposal"]["contextId"] = read["contextId"].clone();
        proposal
    }

    fn submit(&self, request: &str) -> Result<Value> {
        let read = self
            .service
            .remote("read_manuscript", json!({"documentId":self.document}))?;
        let mut proposal = self.raw_proposal(request, self.from, self.from + 15, "Clearer prose.");
        proposal["proposal"]["contextId"] = read["contextId"].clone();
        self.service.remote("suggest_text", proposal)
    }
}

#[test]
fn default_and_legacy_palettes_keep_suggestion_access() {
    let fixture = Fixture::new(false);
    let mut legacy = json!(fixture.review());
    for rule in legacy["rules"].as_array_mut().unwrap() {
        rule.as_object_mut().unwrap().remove("accessMode");
    }
    let review: Review = serde_json::from_value(legacy).unwrap();
    assert!(review
        .rules
        .iter()
        .all(|rule| rule.access_mode == AccessMode::Suggestions));
    fixture.mark("snappier", 3, 18);
    let result = fixture.submit("default").unwrap();
    assert_eq!(result["manuscriptChanged"], false);
    assert_eq!(fs::read_to_string(&fixture.source).unwrap(), fixture.text);
    assert_eq!(fixture.review().suggestions[0].status, Status::Pending);
}

#[test]
fn direct_edits_are_bounded_escaped_recorded_and_idempotent_in_both_formats() {
    for typst in [false, true] {
        let fixture = Fixture::new(typst);
        fixture.palette(AccessMode::Direct);
        fixture.mark("snappier", fixture.from, fixture.from + 15);
        let replacement = "A <clear> #passage.";
        let request = fixture.proposal("direct", fixture.from, fixture.from + 15, replacement);
        let result = fixture
            .service
            .remote("suggest_text", request.clone())
            .unwrap();
        assert_eq!(result["manuscriptChanged"], true);
        assert_eq!(result["suggestion"]["status"], "accepted");
        let changed = fs::read_to_string(&fixture.source).unwrap();
        let escaped = if typst {
            crate::document::escape_typst(replacement)
        } else {
            format!("<p>{}</p>", crate::document::escape_html(replacement))
        };
        assert_eq!(changed, escaped);
        assert_eq!(result["revision"], digest(&changed));
        let snapshot = fixture
            .service
            .local(Operation::Review {
                project: fixture.project.clone(),
                path: fixture.path.clone(),
            })
            .unwrap();
        assert_eq!(
            snapshot["directEdit"],
            json!({"fromRevision":digest(&fixture.text),"toRevision":digest(&changed)})
        );
        assert!(fixture
            .service
            .remote("read_manuscript", json!({"documentId":fixture.document}))
            .unwrap()
            .get("directEdit")
            .is_none());
        let before = fs::read(sidecar(&fixture.source)).unwrap();
        let replay = fixture.service.remote("suggest_text", request).unwrap();
        assert_eq!(replay["manuscriptChanged"], false);
        assert_eq!(replay["suggestion"]["status"], "accepted");
        assert_eq!(fs::read_to_string(&fixture.source).unwrap(), changed);
        assert_eq!(fs::read(sidecar(&fixture.source)).unwrap(), before);
        assert!(fixture.review().markers[0].anchor.stale);
    }
}

#[test]
fn direct_prompt_can_delete_while_discard_still_requires_approval() {
    for discard in [false, true] {
        let fixture = Fixture::new(false);
        fixture.palette(AccessMode::Direct);
        fixture.mark("snappier", 3, 18);
        if discard {
            fixture.mark("discard", 3, 18);
        }
        let result = fixture
            .service
            .remote("suggest_text", fixture.proposal("delete", 3, 18, ""))
            .unwrap();
        assert_eq!(result["manuscriptChanged"], !discard);
        assert_eq!(
            fs::read_to_string(&fixture.source).unwrap(),
            if discard {
                fixture.text.as_str()
            } else {
                "<p></p>"
            }
        );
        assert_eq!(
            result["suggestion"]["status"],
            if discard { "pending" } else { "accepted" }
        );
    }
}

#[test]
fn direct_requires_complete_coverage_and_suggestion_overlap_wins() {
    let fixture = Fixture::new(true);
    fixture.palette(AccessMode::Direct);
    fixture.mark("snappier", 0, 5);
    assert_eq!(
        fixture.submit("gap").unwrap_err().code,
        "highlight_required"
    );
    fixture.mark("snappier", 5, 15);
    assert_eq!(
        fixture.submit("covered").unwrap()["manuscriptChanged"],
        true
    );

    let fixture = Fixture::new(true);
    fixture.palette(AccessMode::Direct);
    let mut review = fixture.review();
    let initial = review.rules.clone();
    let mut suggestion_rule = review.rules[1].clone();
    suggestion_rule.id = "suggest-only".into();
    suggestion_rule.access_mode = AccessMode::Suggestions;
    review.rules.push(suggestion_rule);
    fixture
        .service
        .local(Operation::Palette {
            project: fixture.project.clone(),
            path: fixture.path.clone(),
            revision: digest(&fixture.text),
            rules: review.rules,
            expected_rules: Some(initial),
        })
        .unwrap();
    fixture.mark("snappier", 0, 15);
    fixture.mark("suggest-only", 5, 8);
    assert_eq!(
        fixture.submit("overlap").unwrap()["manuscriptChanged"],
        false
    );
    assert_eq!(fs::read_to_string(&fixture.source).unwrap(), fixture.text);
}

#[test]
fn denied_stale_and_markup_requests_preserve_source_and_metadata() {
    for rule in ["protect", "reject", "discard"] {
        let fixture = Fixture::new(false);
        fixture.palette(AccessMode::Direct);
        fixture.mark("snappier", 3, 18);
        fixture.mark(rule, 3, 18);
        let before = fs::read(sidecar(&fixture.source)).unwrap();
        assert!(fixture.submit(rule).is_err());
        assert_eq!(fs::read_to_string(&fixture.source).unwrap(), fixture.text);
        assert_eq!(fs::read(sidecar(&fixture.source)).unwrap(), before);
    }
    let fixture = Fixture::new(false);
    fixture.palette(AccessMode::Direct);
    fixture.mark("snappier", 3, 18);
    let before = fs::read(sidecar(&fixture.source)).unwrap();
    let mut stale = fixture.proposal("stale", 3, 18, "Other");
    stale["proposal"]["revision"] = json!(digest("old"));
    assert_eq!(
        fixture
            .service
            .remote("suggest_text", stale)
            .unwrap_err()
            .code,
        "stale"
    );
    assert_eq!(
        fixture
            .service
            .remote("suggest_text", fixture.proposal("markup", 0, 3, "Other"))
            .unwrap_err()
            .code,
        "scope"
    );
    let mut quote = fixture.proposal("quote", 3, 18, "Other");
    quote["proposal"]["quote"] = json!("Wrong quote");
    assert_eq!(
        fixture
            .service
            .remote("suggest_text", quote)
            .unwrap_err()
            .code,
        "stale"
    );
    assert_eq!(fs::read_to_string(&fixture.source).unwrap(), fixture.text);
    assert_eq!(fs::read(sidecar(&fixture.source)).unwrap(), before);
}

#[test]
fn existing_pending_request_cannot_upgrade_to_direct_and_remote_cannot_choose_mode() {
    let fixture = Fixture::new(true);
    fixture.mark("snappier", 0, 15);
    let original = fixture.proposal("existing", 0, 15, "Clearer prose.");
    fixture
        .service
        .remote("suggest_text", original.clone())
        .unwrap();
    fixture.palette(AccessMode::Direct);
    assert_eq!(
        fixture.service.remote("suggest_text", original).unwrap()["manuscriptChanged"],
        false
    );
    let mut request = fixture.proposal("remote-mode", 0, 15, "Other");
    request["proposal"]["accessMode"] = json!("direct");
    assert!(fixture.service.remote("suggest_text", request).is_err());
    assert_eq!(fs::read_to_string(&fixture.source).unwrap(), fixture.text);
    for action in [Action::Protect, Action::Reject, Action::Discard] {
        let mut rule = fixture.review().rules[1].clone();
        rule.action = action;
        assert!(rule.validate().is_err());
    }
}

#[tokio::test]
async fn registered_dirty_composing_conflicted_or_old_buffers_block_direct_writes() {
    for (dirty, composing, conflict, old) in [
        (true, false, false, false),
        (false, true, false, false),
        (false, false, true, false),
        (false, false, false, true),
    ] {
        let fixture = Fixture::new(true);
        fixture.palette(AccessMode::Direct);
        fixture.mark("snappier", 0, 15);
        let owner = fixture.service.connect_native_editor("main").unwrap()["ownerId"]
            .as_str()
            .unwrap()
            .to_owned();
        let snapshot = fixture
            .service
            .local(Operation::Review {
                project: fixture.project.clone(),
                path: fixture.path.clone(),
            })
            .unwrap();
        fixture
            .service
            .editor_native(
                "main",
                &owner,
                EditorOperation::EditorRegister {
                    project: fixture.project.clone(),
                    path: fixture.path.clone(),
                    source_epoch: 0,
                    expected_root: serde_json::from_value(snapshot["expectedRoot"].clone())
                        .unwrap(),
                    generation: 0,
                    revision: if old {
                        digest("older")
                    } else {
                        digest(&fixture.text)
                    },
                    content_digest: digest(&fixture.text),
                    dirty,
                    composing,
                    conflict,
                },
            )
            .await
            .unwrap();
        let before = fs::read(sidecar(&fixture.source)).unwrap();
        assert_eq!(fixture.submit("dirty").unwrap_err().code, "context_draft");
        assert_eq!(fs::read_to_string(&fixture.source).unwrap(), fixture.text);
        assert_eq!(fs::read(sidecar(&fixture.source)).unwrap(), before);
    }
}
