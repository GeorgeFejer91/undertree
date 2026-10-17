use super::*;

#[test]
fn stale_palette_rules_cannot_overwrite_newer_policy_at_the_same_source_revision() {
    let temporary = tempfile::tempdir().unwrap();
    let root = temporary.path().join("project");
    fs::create_dir(&root).unwrap();
    let source = root.join("main.typ");
    let text = "Saved manuscript prose.";
    fs::write(&source, text).unwrap();
    let service = Service::new(temporary.path().join("state")).unwrap();
    let project = service
        .local(Operation::AddProject {
            root: root.to_string_lossy().into(),
        })
        .unwrap()["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let snapshot = service
        .local(Operation::Open {
            project: project.clone(),
            path: "main.typ".into(),
        })
        .unwrap();
    let initial: Vec<crate::document::Rule> =
        serde_json::from_value(snapshot["review"]["rules"].clone()).unwrap();
    let mut current = initial.clone();
    current[0].prompt = "Preserve the terminology exactly.".into();
    current[0].color = "#123456".into();
    service
        .local(Operation::Palette {
            project: project.clone(),
            path: "main.typ".into(),
            revision: digest(text),
            rules: current.clone(),
            expected_rules: Some(initial.clone()),
        })
        .unwrap();
    let before = fs::read(sidecar(&source)).unwrap();
    let mut stale = initial.clone();
    stale[1].label = "Stale dialog change".into();
    let error = service
        .local(Operation::Palette {
            project: project.clone(),
            path: "main.typ".into(),
            revision: digest(text),
            rules: stale,
            expected_rules: Some(initial),
        })
        .unwrap_err();
    assert_eq!(error.code, "conflict");
    assert_eq!(fs::read(&source).unwrap(), text.as_bytes());
    assert_eq!(fs::read(sidecar(&source)).unwrap(), before);
    let mut refreshed = current.clone();
    refreshed[1].label = "Confirmed dialog change".into();
    let result = service
        .local(Operation::Palette {
            project,
            path: "main.typ".into(),
            revision: digest(text),
            rules: refreshed.clone(),
            expected_rules: Some(current),
        })
        .unwrap();
    assert_eq!(result["review"]["rules"], json!(refreshed));
    assert_eq!(fs::read(&source).unwrap(), text.as_bytes());
}
