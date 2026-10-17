use super::*;
use crate::document::{Decision, PdfSegment};

struct Fixture {
    temp: tempfile::TempDir,
    service: Arc<Service>,
    project: String,
    root: PathBuf,
    identity: String,
}

impl Fixture {
    async fn new() -> Self {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("project");
        fs::create_dir(&root).unwrap();
        fs::write(root.join("main.typ"), "#include \"section.typ\"\n").unwrap();
        fs::write(root.join("section.typ"), "Included academic prose.\n").unwrap();
        fs::write(root.join("notes.html"), "<p>Other editable prose.</p>").unwrap();
        let service = Service::new(temp.path().join("state")).unwrap();
        let project = service
            .local(Operation::AddProject {
                root: root.to_string_lossy().into(),
            })
            .unwrap()["id"]
            .as_str()
            .unwrap()
            .to_owned();
        let built = service
            .compile_typst(&project, "main.typ", &digest("#include \"section.typ\"\n"))
            .await
            .unwrap();
        let identity = built["pdfHash"].as_str().unwrap().to_owned();
        Self {
            temp,
            service,
            project,
            root,
            identity,
        }
    }

    fn mark(&self, rule: &str) -> Result<Value> {
        self.service.local(Operation::PdfMark {
            project: self.project.clone(),
            path: "notes.html".into(),
            revision: digest("<p>Other editable prose.</p>"),
            identity: self.identity.clone(),
            pdf_path: "main.typ".into(),
            segments: vec![PdfSegment {
                page: 1,
                from: 0,
                to: 24,
                quote: "Included academic prose.".into(),
            }],
            rule: rule.into(),
            prompt: "PRIVATE PDF EXCERPT INSTRUCTION".into(),
            source_from: None,
            source_to: None,
        })
    }

    fn share(&self, path: &str) -> String {
        self.service
            .local(Operation::Share {
                project: self.project.clone(),
                path: path.into(),
                enabled: true,
                context_shared: true,
                expected_context_scope: self.service.test_context_scope(&self.project, path),
            })
            .unwrap()["documentId"]
            .as_str()
            .unwrap()
            .to_owned()
    }

    fn mark_source(&self) {
        self.service
            .local(Operation::Mark {
                project: self.project.clone(),
                path: "section.typ".into(),
                revision: digest("Included academic prose.\n"),
                from: 0,
                to: 24,
                rule: "snappier".into(),
                prompt: String::new(),
            })
            .unwrap();
    }

    fn propose(&self, document: &str, request: &str) -> Result<Value> {
        self.service.remote("suggest_text", json!({"documentId":document,"proposal":{
            "requestId":request,"contextId":self.service.remote("read_manuscript",json!({"documentId":document}))?["contextId"],"revision":digest("Included academic prose.\n"),"from":0,"to":24,
            "quote":"Included academic prose.","replacement":"Precise academic prose.","rationale":"Clarify wording."
        }}))
    }
}

fn source_proposal(
    service: &Service,
    document: &str,
    request: &str,
    source: &str,
    quote: &str,
) -> Result<Value> {
    let byte = source.find(quote).unwrap();
    let from = source[..byte].encode_utf16().count();
    service.remote("suggest_text", json!({"documentId":document,"proposal":{
        "requestId":request,"contextId":service.remote("read_manuscript",json!({"documentId":document}))?["contextId"],"revision":digest(source),"from":from,"to":from+quote.encode_utf16().count(),
        "quote":quote,"replacement":"A concise alternative","rationale":"Follow the marked passage instructions."
    }}))
}

fn linked_mark(
    fixture: &Fixture,
    source: &str,
    quote: &str,
    rule: &str,
    prompt: &str,
) -> Result<Value> {
    let byte = source.find(quote).unwrap();
    let from = source[..byte].encode_utf16().count();
    fixture.service.local(Operation::PdfMark {
        project: fixture.project.clone(),
        path: "section.typ".into(),
        revision: digest(source),
        identity: fixture.identity.clone(),
        pdf_path: "main.typ".into(),
        segments: vec![PdfSegment {
            page: 1,
            from: 0,
            to: quote.encode_utf16().count(),
            quote: quote.into(),
        }],
        rule: rule.into(),
        prompt: prompt.into(),
        source_from: Some(from),
        source_to: Some(from + quote.encode_utf16().count()),
    })
}

#[tokio::test]
async fn exact_pdf_source_links_propagate_custom_prompts_and_removal_preserves_other_markers() {
    let fixture = Fixture::new().await;
    let source = "Included academic prose.\n";
    let before = fs::read(fixture.root.join("section.typ")).unwrap();
    let marked = linked_mark(
        &fixture,
        source,
        "Included academic prose.",
        "snappier",
        "Preserve the sample size; shorten the sentence to at most twelve words.",
    )
    .unwrap();
    let annotation = &marked["review"]["pdfAnnotations"][0];
    let linked_id = annotation["sourceMarkerId"].as_str().unwrap();
    assert_eq!(marked["review"]["markers"][0]["id"], linked_id);
    fixture
        .service
        .local(Operation::Mark {
            project: fixture.project.clone(),
            path: "section.typ".into(),
            revision: digest(source),
            from: 0,
            to: 8,
            rule: "snappier".into(),
            prompt: "Independent source instruction.".into(),
        })
        .unwrap();
    let document = fixture.share("section.typ");
    let read = fixture
        .service
        .remote("read_manuscript", json!({"documentId":document}))
        .unwrap();
    assert!(read["review"].get("pdfAnnotations").is_none());
    assert!(read["review"]["markers"]
        .to_string()
        .contains("sample size"));
    let proposed = fixture.propose(&document, "linked-prompt").unwrap();
    assert!(proposed["suggestion"]["prompt"]
        .as_str()
        .unwrap()
        .contains("at most twelve words"));
    assert!(proposed["suggestion"]["prompt"]
        .as_str()
        .unwrap()
        .contains("Independent source instruction"));
    assert_eq!(fs::read(fixture.root.join("section.typ")).unwrap(), before);
    let removed = fixture
        .service
        .local(Operation::PdfUnmark {
            project: fixture.project.clone(),
            path: "section.typ".into(),
            revision: digest(source),
            id: annotation["id"].as_str().unwrap().into(),
        })
        .unwrap();
    assert!(removed["review"].get("pdfAnnotations").is_none());
    assert_eq!(removed["review"]["markers"].as_array().unwrap().len(), 1);
    assert_ne!(removed["review"]["markers"][0]["id"], linked_id);
    assert_eq!(fs::read(fixture.root.join("section.typ")).unwrap(), before);
}

#[tokio::test]
async fn linked_pdf_protection_is_scoped_but_missing_or_stale_links_reblock_the_project() {
    for damage in ["missing", "stale"] {
        let fixture = Fixture::new().await;
        let source = "Included academic prose.\n";
        let marked =
            linked_mark(&fixture, source, "Included academic prose.", "protect", "").unwrap();
        let document = fixture.share("section.typ");
        assert_eq!(
            fixture
                .propose(&document, "protected-source-link")
                .unwrap_err()
                .code,
            "protected"
        );
        fixture
            .service
            .local(Operation::Mark {
                project: fixture.project.clone(),
                path: "notes.html".into(),
                revision: digest("<p>Other editable prose.</p>"),
                from: 3,
                to: 24,
                rule: "snappier".into(),
                prompt: String::new(),
            })
            .unwrap();
        let other = fixture.share("notes.html");
        assert!(source_proposal(
            &fixture.service,
            &other,
            "unrelated-allowed",
            "<p>Other editable prose.</p>",
            "Other editable prose."
        )
        .is_ok());
        let list = fixture
            .service
            .local(Operation::PdfAnnotations {
                project: fixture.project.clone(),
                path: "main.typ".into(),
                identity: fixture.identity.clone(),
            })
            .unwrap();
        assert_eq!(list["annotations"][0]["sourceLinked"], true);
        if damage == "missing" {
            fixture
                .service
                .local(Operation::Unmark {
                    project: fixture.project.clone(),
                    path: "section.typ".into(),
                    revision: digest(source),
                    id: marked["review"]["pdfAnnotations"][0]["sourceMarkerId"]
                        .as_str()
                        .unwrap()
                        .into(),
                })
                .unwrap();
        } else {
            fixture
                .service
                .local(Operation::Save {
                    project: fixture.project.clone(),
                    path: "section.typ".into(),
                    revision: digest(source),
                    content: "Changed academic prose.\n".into(),
                })
                .unwrap();
        }
        assert_eq!(
            source_proposal(
                &fixture.service,
                &other,
                "invalid-link-blocks-project",
                "<p>Other editable prose.</p>",
                "Other editable prose."
            )
            .unwrap_err()
            .code,
            "protected_pdf"
        );
        let list = fixture
            .service
            .local(Operation::PdfAnnotations {
                project: fixture.project.clone(),
                path: "main.typ".into(),
                identity: fixture.identity.clone(),
            })
            .unwrap();
        assert_eq!(list["annotations"][0]["sourceLinked"], false);
    }
}

#[tokio::test]
async fn printed_math_keeps_a_pdf_mark_without_claiming_a_source_prose_link() {
    let mut fixture = Fixture::new().await;
    let source = "$x$ Plain prose.\n";
    fs::write(fixture.root.join("section.typ"), source).unwrap();
    let built = fixture
        .service
        .compile_typst(
            &fixture.project,
            "main.typ",
            &digest("#include \"section.typ\"\n"),
        )
        .await
        .unwrap();
    fixture.identity = built["pdfHash"].as_str().unwrap().into();
    let before = fs::read(fixture.root.join("section.typ")).unwrap();
    let marked = linked_mark(&fixture, source, "x", "protect", "").unwrap();
    assert!(marked["review"]["markers"].as_array().unwrap().is_empty());
    assert!(marked["review"]["pdfAnnotations"][0]
        .get("sourceMarkerId")
        .is_none());
    assert_eq!(fs::read(fixture.root.join("section.typ")).unwrap(), before);
    let other = fixture.share("notes.html");
    assert_eq!(
        source_proposal(
            &fixture.service,
            &other,
            "math-remains-project-protected",
            "<p>Other editable prose.</p>",
            "Other editable prose."
        )
        .unwrap_err()
        .code,
        "protected_pdf"
    );
}

#[tokio::test]
async fn malformed_optional_source_links_never_create_partial_source_markers_or_pdf_annotations() {
    let fixture = Fixture::new().await;
    let source = "Included academic prose.\n";
    let base = json!({"action":"pdf_mark","project":fixture.project,"path":"section.typ","revision":digest(source),"identity":fixture.identity,"pdfPath":"main.typ","segments":[{"page":1,"from":0,"to":24,"quote":"Included academic prose."}],"rule":"snappier","prompt":""});
    let before = fs::read(fixture.root.join("section.typ")).unwrap();
    let metadata = sidecar(&fixture.root.join("section.typ"));
    for overrides in [
        json!({"sourceFrom":0}),
        json!({"sourceFrom":1,"sourceTo":24}),
        json!({"sourceFrom":0,"sourceTo":99999}),
        json!({"sourceMarkerId":"chosen-by-client"}),
    ] {
        let mut operation = base.clone();
        for (key, value) in overrides.as_object().unwrap() {
            operation[key] = value.clone();
        }
        let result = serde_json::from_value::<Operation>(operation)
            .map_err(Error::from)
            .and_then(|operation| fixture.service.local(operation));
        assert!(result.is_err());
        assert_eq!(fs::read(fixture.root.join("section.typ")).unwrap(), before);
        assert!(!metadata.exists());
    }
}

#[tokio::test]
async fn hidden_annotation_owners_are_rejected_and_restored_hidden_policy_cannot_bypass_a_restart()
{
    let mut fixture = Fixture::new().await;
    fs::create_dir(fixture.root.join(".chapters")).unwrap();
    fs::write(
        fixture.root.join(".chapters/notes.html"),
        "<p>Other editable prose.</p>",
    )
    .unwrap();
    fs::create_dir(fixture.root.join(".ordinary-config")).unwrap();
    fs::write(fixture.root.join(".ordinary-config/settings.json"), "{}").unwrap();
    let hidden = Operation::PdfMark {
        project: fixture.project.clone(),
        path: ".chapters/notes.html".into(),
        revision: digest("<p>Other editable prose.</p>"),
        identity: fixture.identity.clone(),
        pdf_path: "main.typ".into(),
        segments: vec![PdfSegment {
            page: 1,
            from: 0,
            to: 1,
            quote: "x".into(),
        }],
        rule: "protect".into(),
        prompt: "".into(),
        source_from: None,
        source_to: None,
    };
    assert_eq!(fixture.service.local(hidden).unwrap_err().code, "path");
    fixture.mark_source();
    let doc = fixture.share("section.typ");
    assert!(fixture
        .propose(&doc, "ordinary-dotfiles-do-not-block")
        .is_ok());
    fixture.mark("protect").unwrap();
    fs::rename(
        sidecar(&fixture.root.join("notes.html")),
        sidecar(&fixture.root.join(".chapters/notes.html")),
    )
    .unwrap();
    fixture.service = Service::new(fixture.temp.path().join("state")).unwrap();
    let doc = fixture.share("section.typ");
    assert_eq!(
        fixture
            .propose(&doc, "hidden-restored-restriction")
            .unwrap_err()
            .code,
        "pdf_policy"
    );
    assert_eq!(
        fs::read_to_string(fixture.root.join(".chapters/notes.html")).unwrap(),
        "<p>Other editable prose.</p>"
    );
}

#[tokio::test]
async fn pdf_annotations_are_private_persistent_positional_context_without_source_changes() {
    let mut fixture = Fixture::new().await;
    let before = ["main.typ", "section.typ", "notes.html"]
        .map(|path| fs::read(fixture.root.join(path)).unwrap());
    let marked = fixture.mark("snappier").unwrap();
    assert!(marked["review"]["markers"].as_array().unwrap().is_empty());
    assert_eq!(
        marked["review"]["pdfAnnotations"][0]["identity"],
        fixture.identity
    );
    let remote = fixture
        .service
        .remote(
            "read_manuscript",
            json!({"documentId":fixture.share("notes.html")}),
        )
        .unwrap();
    assert!(remote["review"].get("pdfAnnotations").is_none());
    assert!(!remote.to_string().contains("PRIVATE PDF EXCERPT"));
    assert!(!remote.to_string().contains("Included academic prose."));
    let mut app_projection = marked.clone();
    redact(&mut app_projection);
    assert!(app_projection["review"].get("pdfAnnotations").is_none());
    fixture.service = Service::new(fixture.temp.path().join("state")).unwrap();
    let listed = fixture
        .service
        .local(Operation::PdfAnnotations {
            project: fixture.project.clone(),
            path: "main.typ".into(),
            identity: fixture.identity.clone(),
        })
        .unwrap();
    assert_eq!(listed["annotations"].as_array().unwrap().len(), 1);
    assert_eq!(listed["annotations"][0]["ownerPath"], "notes.html");
    assert_eq!(
        listed["annotations"][0]["segments"][0]["quote"],
        "Included academic prose."
    );
    for (index, path) in ["main.typ", "section.typ", "notes.html"].iter().enumerate() {
        assert_eq!(fs::read(fixture.root.join(path)).unwrap(), before[index]);
    }
    fixture.mark_source();
    let doc = fixture.share("section.typ");
    assert!(fixture
        .propose(&doc, "unlinked-prompt-does-not-claim-source-binding")
        .is_ok());
}

#[tokio::test]
async fn restrictive_pdf_annotations_block_all_project_proposals_and_acceptance_after_restart_or_rebuild(
) {
    for rule in ["protect", "reject", "discard"] {
        let mut fixture = Fixture::new().await;
        fixture.mark_source();
        let doc = fixture.share("section.typ");
        let pending = fixture.propose(&doc, "before-protection").unwrap();
        let marked = fixture.mark(rule).unwrap();
        let id = marked["review"]["pdfAnnotations"][0]["id"]
            .as_str()
            .unwrap()
            .to_owned();
        let original = fs::read(fixture.root.join("section.typ")).unwrap();
        assert_eq!(
            fixture.propose(&doc, "after-protection").unwrap_err().code,
            "protected_pdf"
        );
        let decide = || Operation::Decide {
            project: fixture.project.clone(),
            path: "section.typ".into(),
            revision: digest("Included academic prose.\n"),
            id: pending["suggestion"]["id"].as_str().unwrap().into(),
            decision: Decision::Accepted,
        };
        assert_eq!(
            fixture.service.local(decide()).unwrap_err().code,
            "protected_pdf"
        );
        fixture.service = Service::new(fixture.temp.path().join("state")).unwrap();
        let doc = fixture.share("section.typ");
        assert_eq!(
            fixture.propose(&doc, "restarted").unwrap_err().code,
            "protected_pdf"
        );
        let rebuilt_main = "New PDF output.\n#include \"section.typ\"\n";
        fs::write(fixture.root.join("main.typ"), rebuilt_main).unwrap();
        fixture
            .service
            .compile_typst(&fixture.project, "main.typ", &digest(rebuilt_main))
            .await
            .unwrap();
        assert_eq!(
            fixture.propose(&doc, "rebuilt").unwrap_err().code,
            "protected_pdf"
        );
        assert_eq!(
            fs::read(fixture.root.join("section.typ")).unwrap(),
            original
        );
        fixture
            .service
            .local(Operation::PdfUnmark {
                project: fixture.project.clone(),
                path: "notes.html".into(),
                revision: digest("<p>Other editable prose.</p>"),
                id,
            })
            .unwrap();
        assert!(fixture.propose(&doc, "explicitly-removed").is_ok());
        fixture.service.local(decide()).unwrap();
        assert_eq!(
            fs::read_to_string(fixture.root.join("section.typ")).unwrap(),
            "Precise academic prose\\.\n"
        );
    }
}

#[tokio::test]
async fn pdf_annotation_identity_is_verified_but_source_current_is_not_required() {
    let mut fixture = Fixture::new().await;
    fs::write(
        fixture.root.join("section.typ"),
        "Changed included prose.\n",
    )
    .unwrap();
    assert_eq!(
        fixture
            .service
            .preview_pdf(&fixture.project, "main.typ")
            .unwrap()["current"],
        false
    );
    fixture.mark("snappier").unwrap();
    let source = fs::read(fixture.root.join("notes.html")).unwrap();
    let metadata = fs::read(sidecar(&fixture.root.join("notes.html"))).unwrap();
    fixture.identity = "0".repeat(64);
    assert_eq!(fixture.mark("protect").unwrap_err().code, "stale_pdf");
    assert_eq!(fs::read(fixture.root.join("notes.html")).unwrap(), source);
    assert_eq!(
        fs::read(sidecar(&fixture.root.join("notes.html"))).unwrap(),
        metadata
    );
}

#[tokio::test]
async fn corrupt_pending_missing_and_orphan_pdf_policy_fail_closed_without_recovery() {
    let fixture = Fixture::new().await;
    let doc = fixture.share("section.typ");
    fixture.mark("protect").unwrap();
    fs::remove_file(fixture.root.join("notes.html")).unwrap();
    assert_eq!(
        fixture.propose(&doc, "orphan-policy").unwrap_err().code,
        "protected_pdf"
    );
    let metadata = sidecar(&fixture.root.join("notes.html"));
    let good = fs::read(&metadata).unwrap();
    fs::write(&metadata, "{corrupt").unwrap();
    assert_eq!(
        fixture.propose(&doc, "corrupt-policy").unwrap_err().code,
        "pdf_policy"
    );
    assert_eq!(fs::read_to_string(&metadata).unwrap(), "{corrupt");
    fs::write(&metadata, &good).unwrap();
    fs::write(journal_path(&fixture.root.join("notes.html")), "{pending").unwrap();
    assert_eq!(
        fixture.propose(&doc, "pending-policy").unwrap_err().code,
        "pdf_policy"
    );
    assert_eq!(
        fs::read_to_string(journal_path(&fixture.root.join("notes.html"))).unwrap(),
        "{pending"
    );
    fs::remove_file(journal_path(&fixture.root.join("notes.html"))).unwrap();
    fs::remove_file(&metadata).unwrap();
    assert_eq!(
        fixture
            .propose(&doc, "missing-known-policy")
            .unwrap_err()
            .code,
        "pdf_policy"
    );
    assert!(!metadata.exists());
}

#[test]
fn pdf_annotation_schema_rejects_malformed_coordinates_and_unknown_nested_authority() {
    let valid = json!({"id":"annotation","identity":"a".repeat(64),"pdfPath":"main.typ","segments":[{"page":1,"from":0,"to":2,"quote":"😀"}],"rule":"protect","prompt":""});
    serde_json::from_value::<PdfAnnotation>(valid.clone())
        .unwrap()
        .validate()
        .unwrap();
    for bad in [
        json!({"page":0,"from":0,"to":1,"quote":"a"}),
        json!({"page":1,"from":0,"to":1,"quote":"😀"}),
        json!({"page":1,"from":2,"to":1,"quote":"a"}),
        json!({"page":1,"from":0,"to":2,"quote":"😀","action":"save"}),
    ] {
        let mut value = valid.clone();
        value["segments"] = json!([bad]);
        assert!(serde_json::from_value::<PdfAnnotation>(value)
            .and_then(|annotation| annotation.validate().map_err(serde::de::Error::custom))
            .is_err());
    }
    let legacy = serde_json::to_value(Review::new("Source.")).unwrap();
    assert!(legacy.get("pdfAnnotations").is_none());
    assert!(serde_json::from_value::<Review>(legacy)
        .unwrap()
        .pdf_annotations
        .is_empty());
}

#[tokio::test]
async fn local_cli_and_remote_catalogues_cannot_access_pdf_annotation_actions_or_private_context() {
    let fixture = Fixture::new().await;
    let capabilities = fixture
        .service
        .capabilities(CallerContext::LocalCli)
        .unwrap();
    assert!(!capabilities["localOperations"]
        .as_array()
        .unwrap()
        .iter()
        .any(|operation| operation["action"] == "pdf_annotations"));
    for operation in [
        Operation::PdfAnnotations {
            project: fixture.project.clone(),
            path: "main.typ".into(),
            identity: fixture.identity.clone(),
        },
        Operation::PdfUnmark {
            project: fixture.project.clone(),
            path: "notes.html".into(),
            revision: digest("<p>Other editable prose.</p>"),
            id: "anything".into(),
        },
    ] {
        assert!(fixture
            .service
            .dispatch_as(CallerContext::LocalCli, operation)
            .await
            .is_err());
    }
    for action in [
        "pdf_mark",
        "pdf_unmark",
        "pdf_annotations",
        "control_pdf_mark",
        "control_pdf_annotations",
    ] {
        assert_eq!(
            fixture.service.remote(action, json!({})).unwrap_err().code,
            "scope"
        );
    }
}
