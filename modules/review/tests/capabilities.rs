use serde_json::{json, Value};
use std::collections::BTreeSet;
use undertree_review::capabilities::CallerContext;
use undertree_review::service::Service;
use undertree_review::{Operation, LOCAL_OPERATIONS};

#[tokio::test]
async fn discovery_reports_only_implemented_authority_and_changes_instance_on_restart() {
    let temporary = tempfile::tempdir().unwrap();
    let service = Service::new(temporary.path().to_owned()).unwrap();
    let discovery = service.dispatch(Operation::Capabilities).await.unwrap();
    assert_eq!(discovery["contractVersion"], 1);
    assert_eq!(discovery["caller"], "local");
    assert_eq!(discovery["fullControl"]["available"], false);
    assert_eq!(
        discovery["fullControl"]["reason"],
        "unsupported_file_editing"
    );
    assert_eq!(discovery["fullControl"]["sourceEditing"], false);
    assert_eq!(discovery["appControls"]["sourceEditing"], false);
    assert_eq!(discovery["appControls"]["grantRequired"], true);
    assert_eq!(
        discovery["review"]["tools"],
        json!(["list_manuscripts", "read_manuscript", "suggest_text"])
    );
    let actions: BTreeSet<_> = LOCAL_OPERATIONS.iter().map(|entry| entry.action).collect();
    assert_eq!(actions.len(), LOCAL_OPERATIONS.len());
    assert_eq!(
        actions.len(),
        discovery["localOperations"].as_array().unwrap().len()
    );
    for action in ["capabilities", "save", "reanchor", "compile", "import_tex"] {
        assert!(actions.contains(action));
    }
    assert!(!actions.contains("run_cli"));
    assert!(!actions.contains("edit_source"));
    assert!(LOCAL_OPERATIONS
        .iter()
        .any(|entry| entry.action == "save" && entry.mutates));
    assert!(LOCAL_OPERATIONS
        .iter()
        .any(|entry| entry.action == "capabilities" && !entry.mutates));
    assert_eq!(
        service
            .clone()
            .dispatch(Operation::Capabilities)
            .await
            .unwrap()["instanceId"],
        discovery["instanceId"]
    );
    let restarted = Service::new(temporary.path().to_owned()).unwrap();
    assert_ne!(
        restarted.dispatch(Operation::Capabilities).await.unwrap()["instanceId"],
        discovery["instanceId"]
    );
    assert!(!temporary.path().join("projects.json").exists());
    assert!(!temporary.path().join("connection.json").exists());
}

#[tokio::test]
async fn review_context_cannot_call_the_local_registry_or_approve_its_own_root() {
    let temporary = tempfile::tempdir().unwrap();
    let service = Service::new(temporary.path().join("state")).unwrap();
    for operation in [
        Operation::Capabilities,
        Operation::Projects,
        Operation::AddProject {
            root: temporary.path().to_string_lossy().into(),
        },
        Operation::Save {
            project: "not-approved".into(),
            path: "main.typ".into(),
            revision: "stale".into(),
            content: "unauthorized".into(),
        },
    ] {
        assert_eq!(
            service
                .dispatch_as(CallerContext::Review, operation)
                .await
                .unwrap_err()
                .code,
            "scope"
        );
    }
    assert_eq!(
        service
            .capabilities(CallerContext::Review)
            .unwrap_err()
            .code,
        "scope"
    );
    assert_eq!(
        service.dispatch(Operation::Projects).await.unwrap(),
        json!([])
    );
    for tool in [
        "capabilities",
        "add_project",
        "save",
        "compile",
        "accept_suggestion",
    ] {
        assert_eq!(service.remote(tool, json!({})).unwrap_err().code, "scope");
    }
}

#[tokio::test]
async fn named_cli_discovers_the_running_authority_and_reports_invalid_arguments() {
    let temporary = tempfile::tempdir().unwrap();
    let service = Service::new(temporary.path().join("state")).unwrap();
    let expected = service
        .dispatch_as(CallerContext::LocalCli, Operation::Capabilities)
        .await
        .unwrap();
    let token = "test-capabilities-000000000000000000";
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint = format!("http://{}/api/review", listener.local_addr().unwrap());
    let router =
        undertree_review::transport::local_router(service, token.into(), temporary.path().into());
    let server = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
    let output = tokio::process::Command::new(env!("CARGO_BIN_EXE_undertree-review"))
        .arg("capabilities")
        .env("UNDERTREE_REVIEW_ENDPOINT", &endpoint)
        .env("UNDERTREE_REVIEW_TOKEN", token)
        .output()
        .await
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let reply: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(reply["ok"], true);
    assert_eq!(reply["result"], expected);
    let invalid = tokio::process::Command::new(env!("CARGO_BIN_EXE_undertree-review"))
        .args(["capabilities", "unexpected"])
        .env("UNDERTREE_REVIEW_ENDPOINT", &endpoint)
        .env("UNDERTREE_REVIEW_TOKEN", token)
        .output()
        .await
        .unwrap();
    assert!(!invalid.status.success());
    assert!(invalid.stdout.is_empty());
    assert!(String::from_utf8_lossy(&invalid.stderr).contains("takes no arguments"));
    server.abort();
}
