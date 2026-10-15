use serde_json::json;
use undertree_review::capabilities::CallerContext;
use undertree_review::service::Service;
use undertree_review::Operation;

#[tokio::test]
async fn main_document_is_persisted_validated_and_local_only() {
    let root = tempfile::tempdir().unwrap();
    let state = tempfile::tempdir().unwrap();
    std::fs::create_dir(root.path().join("chapters")).unwrap();
    std::fs::write(root.path().join("chapters/main.typ"), "= Main\n").unwrap();
    std::fs::write(
        root.path().join("refs.bib"),
        "@book{example,title={Example}}",
    )
    .unwrap();
    let service = Service::new(state.path().to_owned()).unwrap();
    let added = service
        .local(Operation::AddProject {
            root: root.path().to_string_lossy().into_owned(),
        })
        .unwrap();
    let project = added["id"].as_str().unwrap().to_owned();
    assert_eq!(added["mainDocument"], "");
    let set_main = |path: &str| Operation::SetMainDocument {
        project: project.clone(),
        path: path.into(),
    };
    let saved = service
        .dispatch(set_main("chapters/main.typ"))
        .await
        .unwrap();
    assert_eq!(saved["mainDocument"], "chapters/main.typ");
    assert_eq!(
        Service::new(state.path().to_owned())
            .unwrap()
            .project(&project)
            .unwrap()
            .main_document,
        "chapters/main.typ"
    );
    for path in ["refs.bib", "../outside.typ", "missing.typ"] {
        assert!(service.dispatch(set_main(path)).await.is_err());
        assert_eq!(
            service.project(&project).unwrap().main_document,
            "chapters/main.typ"
        );
    }
    assert_eq!(
        service
            .dispatch_as(CallerContext::Review, set_main(""))
            .await
            .unwrap_err()
            .code,
        "scope"
    );
    assert_eq!(
        service
            .remote("set_main_document", json!({"project":project,"path":""}))
            .unwrap_err()
            .code,
        "scope"
    );
    assert_eq!(
        service.project(&project).unwrap().main_document,
        "chapters/main.typ"
    );
    // A failed settings write must not change the in-memory build target.
    std::fs::remove_file(state.path().join("projects.json")).unwrap();
    std::fs::create_dir(state.path().join("projects.json")).unwrap();
    assert!(service.dispatch(set_main("")).await.is_err());
    assert_eq!(
        service.project(&project).unwrap().main_document,
        "chapters/main.typ"
    );
    std::fs::remove_dir(state.path().join("projects.json")).unwrap();
    assert_eq!(
        service.dispatch(set_main("")).await.unwrap()["mainDocument"],
        ""
    );
}

#[test]
fn bibliography_and_data_are_editable_without_exposing_internal_metadata() {
    let root = tempfile::tempdir().unwrap();
    let state = tempfile::tempdir().unwrap();
    let service = Service::new(state.path().to_owned()).unwrap();
    let added = service
        .local(Operation::AddProject {
            root: root.path().to_string_lossy().into_owned(),
        })
        .unwrap();
    let project = added["id"].as_str().unwrap().to_owned();
    for (path, text) in [
        ("references.bib", "@book{example,title={Example}}"),
        ("data.yaml", "value: 42"),
        ("data.json", "{\"value\":42}"),
        ("values.csv", "a,b\n1,2\n"),
        ("diagram.svg", "<svg xmlns=\"http://www.w3.org/2000/svg\"/>"),
    ] {
        let created = service
            .local(Operation::Create {
                project: project.clone(),
                path: path.into(),
            })
            .unwrap();
        assert_eq!(created["content"], "");
        let saved = service
            .local(Operation::Save {
                project: project.clone(),
                path: path.into(),
                revision: created["review"]["revision"].as_str().unwrap().into(),
                content: text.into(),
            })
            .unwrap();
        assert_eq!(saved["content"], text);
    }
    let files = service
        .local(Operation::Files {
            project: project.clone(),
        })
        .unwrap();
    assert_eq!(files.as_array().unwrap().len(), 5);
    for path in [
        "references.bib.undertree-review.json",
        "references.bib.undertree-pending.json",
        "main.typ.import-report.json",
    ] {
        assert_eq!(
            service
                .local(Operation::Create {
                    project: project.clone(),
                    path: path.into()
                })
                .unwrap_err()
                .code,
            "path"
        );
    }
    assert!(service
        .local(Operation::Open {
            project,
            path: "../data.json".into()
        })
        .is_err());
}

#[test]
fn old_projects_default_to_selected_document_compilation() {
    let root = tempfile::tempdir().unwrap();
    let state = tempfile::tempdir().unwrap();
    std::fs::write(
        state.path().join("projects.json"),
        serde_json::to_vec(&json!({"projects":[{"id":"old","name":"Old","root":root.path()}]}))
            .unwrap(),
    )
    .unwrap();
    assert_eq!(
        Service::new(state.path().to_owned())
            .unwrap()
            .project("old")
            .unwrap()
            .main_document,
        ""
    );
}
