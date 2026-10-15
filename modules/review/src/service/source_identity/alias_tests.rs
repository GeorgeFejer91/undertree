use super::*;
use crate::SourceRequest;

const TEXT: &str =
    "#set page(paper: \"a4\")\n#set text(size: 11pt)\n\n= Manuscript\n\nStart writing here.\n";

fn approve(service: &Service, root: &Path) -> Project {
    serde_json::from_value(
        service
            .local(Operation::AddProject {
                root: root.to_str().unwrap().into(),
            })
            .unwrap(),
    )
    .unwrap()
}

#[tokio::test]
async fn captured_outer_source_refuses_native_and_legacy_nested_create_without_consuming_identity()
{
    let temp = tempfile::tempdir().unwrap();
    let outer = temp.path().join("outer");
    let inner = outer.join("nested");
    fs::create_dir_all(&inner).unwrap();
    let file = inner.join("main.typ");
    fs::write(&file, TEXT).unwrap();
    let service = Service::new(temp.path().join("state")).unwrap();
    let a = approve(&service, &outer);
    let b = approve(&service, &inner);
    let owner = service.connect_native_editor("main").unwrap()["ownerId"]
        .as_str()
        .unwrap()
        .to_owned();
    let compiled = service
        .compile_typst_native_report(
            "main",
            &owner,
            SourceRequest {
                operation: Operation::Compile {
                    project: a.id.clone(),
                    path: "nested/main.typ".into(),
                    revision: digest(TEXT),
                },
                source_epoch: 0,
                expected_root: Some(RootedRoot::observe(&outer).unwrap()),
            },
        )
        .await
        .unwrap();
    assert_eq!(compiled["status"], "succeeded");
    assert_eq!(compiled["preview"]["current"], true);
    assert_eq!(
        service.source_epochs(&a.id).unwrap().get("nested/main.typ"),
        Some(&0)
    );
    assert!(service.source_epochs(&b.id).unwrap().is_empty());
    fs::remove_file(&file).unwrap();
    let registry = fs::read(service.state.join("projects.json")).unwrap();
    let request = || Operation::Create {
        project: b.id.clone(),
        path: "main.typ".into(),
    };
    assert_eq!(
        service
            .dispatch_native_source(
                "main",
                &owner,
                SourceRequest {
                    operation: request(),
                    source_epoch: 0,
                    expected_root: Some(RootedRoot::observe(&inner).unwrap()),
                }
            )
            .await
            .unwrap_err()
            .code,
        "alias_conflict"
    );
    assert_eq!(service.local(request()).unwrap_err().code, "alias_conflict");
    assert!(!file.exists());
    assert!(!sidecar(&file).exists());
    assert!(!journal_path(&file).exists());
    assert_eq!(
        fs::read(service.state.join("projects.json")).unwrap(),
        registry
    );
    assert!(service.source_epochs(&b.id).unwrap().is_empty());
    let retained = service.preview_pdf(&a.id, "nested/main.typ").unwrap();
    assert_eq!(retained["base64"], compiled["preview"]["base64"]);
    assert_eq!(retained["current"], false);
    // Another destination in the outer project is not aliased by the nested approval.
    assert_eq!(
        service
            .local(Operation::Create {
                project: a.id.clone(),
                path: "outside.typ".into()
            })
            .unwrap()["sourceEpoch"],
        0
    );
}

#[tokio::test]
async fn native_and_legacy_tex_import_share_the_destination_alias_refusal() {
    let temp = tempfile::tempdir().unwrap();
    let outer = temp.path().join("outer");
    let inner = outer.join("nested");
    fs::create_dir_all(&inner).unwrap();
    let file = inner.join("original.tex");
    const TEX: &str = "\\section{Title}\nOriginal text.\n";
    fs::write(&file, TEX).unwrap();
    let service = Service::new(temp.path().join("state")).unwrap();
    let _a = approve(&service, &outer);
    let b = approve(&service, &inner);
    let owner = service.connect_native_editor("main").unwrap()["ownerId"]
        .as_str()
        .unwrap()
        .to_owned();
    let registry = fs::read(service.state.join("projects.json")).unwrap();
    let operation = || Operation::ImportTex {
        project: b.id.clone(),
        path: "original.tex".into(),
        target: "converted.typ".into(),
    };
    assert_eq!(
        service
            .dispatch_native_source(
                "main",
                &owner,
                SourceRequest {
                    operation: operation(),
                    source_epoch: 0,
                    expected_root: Some(RootedRoot::observe(&inner).unwrap())
                }
            )
            .await
            .unwrap_err()
            .code,
        "alias_conflict"
    );
    assert_eq!(
        service.local(operation()).unwrap_err().code,
        "alias_conflict"
    );
    assert_eq!(fs::read_to_string(&file).unwrap(), TEX);
    assert!(!sidecar(&file).exists());
    assert_eq!(fs::read_dir(&inner).unwrap().count(), 1);
    assert_eq!(
        fs::read(service.state.join("projects.json")).unwrap(),
        registry
    );
    assert!(service.source_epochs(&b.id).unwrap().is_empty());
}

#[test]
fn unaliased_first_create_keeps_zero_and_an_unrelated_approval_does_not_freeze_it() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("project");
    let other = temp.path().join("project-other");
    fs::create_dir(&root).unwrap();
    fs::create_dir(&other).unwrap();
    let service = Service::new(temp.path().join("state")).unwrap();
    let project = approve(&service, &root);
    approve(&service, &other);
    let created = service
        .local(Operation::Create {
            project: project.id.clone(),
            path: "new.typ".into(),
        })
        .unwrap();
    assert_eq!(created["sourceEpoch"], 0);
    assert!(!service
        .source_epochs(&project.id)
        .unwrap()
        .contains_key("new.typ"));
}
