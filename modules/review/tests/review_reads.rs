use serde_json::json;
use std::fs;
use undertree_review::document::{digest, Review};
use undertree_review::service::Service;
use undertree_review::Operation;

#[tokio::test]
async fn review_refresh_never_recovers_adopts_or_creates_metadata_but_explicit_open_recovers() {
    let temporary = tempfile::tempdir().unwrap();
    let root = temporary.path().join("project");
    let state = temporary.path().join("state");
    fs::create_dir(&root).unwrap();
    let original = "Original saved source.";
    let next = "Recovered saved source.";
    fs::write(root.join("main.typ"), original).unwrap();
    let service = Service::new(state.clone()).unwrap();
    let project = service
        .local(Operation::AddProject {
            root: root.to_str().unwrap().into(),
        })
        .unwrap()["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let registry = fs::read(state.join("projects.json")).unwrap();
    let read = service
        .dispatch(Operation::Review {
            project: project.clone(),
            path: "main.typ".into(),
        })
        .await
        .unwrap();
    assert_eq!(read["content"], original);
    let sidecar = root.join("main.typ.undertree-review.json");
    assert!(!sidecar.exists());
    let review = serde_json::to_vec(&Review::new(original)).unwrap();
    fs::write(&sidecar, &review).unwrap();
    fs::write(root.join("main.typ"), "External source change.").unwrap();
    let external = service
        .dispatch(Operation::Review {
            project: project.clone(),
            path: "main.typ".into(),
        })
        .await
        .unwrap();
    assert_eq!(external["content"], "External source change.");
    assert_eq!(fs::read(&sidecar).unwrap(), review);
    assert_eq!(fs::read(state.join("projects.json")).unwrap(), registry);
    fs::write(root.join("main.typ"), original).unwrap();
    let pending = root.join("main.typ.undertree-pending.json");
    let journal = serde_json::to_vec(
        &json!({"old_revision":digest(original),"content":next,"review":Review::new(next)}),
    )
    .unwrap();
    fs::write(&pending, &journal).unwrap();
    assert_eq!(
        service
            .dispatch(Operation::Review {
                project: project.clone(),
                path: "main.typ".into()
            })
            .await
            .unwrap_err()
            .code,
        "busy"
    );
    assert_eq!(
        fs::read(root.join("main.typ")).unwrap(),
        original.as_bytes()
    );
    assert_eq!(fs::read(&sidecar).unwrap(), review);
    assert_eq!(fs::read(&pending).unwrap(), journal);
    assert_eq!(fs::read(state.join("projects.json")).unwrap(), registry);
    assert_eq!(
        service
            .dispatch(Operation::Open {
                project: project.clone(),
                path: "main.typ".into()
            })
            .await
            .unwrap_err()
            .code,
        "recovery_conflict"
    );
    assert_eq!(fs::read(&sidecar).unwrap(), review);
    assert_eq!(fs::read(&pending).unwrap(), journal);
    let modern_journal = serde_json::to_vec(
        &json!({"old_revision":digest(original),"content":next,"review":Review::new(next),
        "prior_review":{"state":"hash","sha256":digest(std::str::from_utf8(&review).unwrap())},
        "ownership":{"project":project,"path":"main.typ","owns_source":true}}),
    )
    .unwrap();
    fs::write(&pending, modern_journal).unwrap();
    let recovered = service
        .dispatch(Operation::Open {
            project: project.clone(),
            path: "main.typ".into(),
        })
        .await
        .unwrap();
    assert_eq!(recovered["content"], next);
    assert_eq!(fs::read_to_string(root.join("main.typ")).unwrap(), next);
    assert!(!pending.exists());
    assert_eq!(
        serde_json::from_slice::<Review>(&fs::read(&sidecar).unwrap())
            .unwrap()
            .revision,
        digest(next)
    );
    let recovered = service.project(&project).unwrap();
    assert_eq!(recovered.pending_revisions["main.typ"], digest(next));
    assert_eq!(
        recovered.pending_revisions["main.typ.undertree-review.json"],
        digest(&fs::read_to_string(sidecar).unwrap())
    );
}
