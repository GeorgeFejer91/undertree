use serde_json::{json, Value};
use std::fs;
use std::path::Path;
use std::sync::Arc;
use undertree_review::capabilities::CallerContext;
use undertree_review::document::{digest, Anchor, Marker, Review};
use undertree_review::instance::LocalInstance;
use undertree_review::service::Service;
use undertree_review::Operation;

async fn command(state: &Path, args: &[&str]) -> std::process::Output {
    tokio::process::Command::new(env!("CARGO_BIN_EXE_undertree-review"))
        .args(args)
        .env_remove("UNDERTREE_REVIEW_ENDPOINT")
        .env_remove("UNDERTREE_REVIEW_TOKEN")
        .env("UNDERTREE_REVIEW_STATE", state)
        .output()
        .await
        .unwrap()
}

async fn result(state: &Path, args: &[&str]) -> Value {
    let output = command(state, args).await;
    assert!(
        output.status.success(),
        "Named local command failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let reply: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(reply["ok"], true);
    reply["result"].clone()
}

#[tokio::test]
async fn help_and_invalid_commands_do_not_start_a_host_or_require_credentials() {
    let temporary = tempfile::tempdir().unwrap();
    let state = temporary.path().join("never-created");
    for args in [["help"], ["--help"]] {
        let output = command(&state, &args).await;
        assert!(output.status.success());
        let help = String::from_utf8(output.stdout).unwrap();
        assert!(help.contains(env!("CARGO_PKG_VERSION")));
        for name in [
            "capabilities",
            "projects",
            "files <project>",
            "read <project> <path>",
            "review <project> <path>",
            "connection",
            "git-status",
            "pdf-info",
            "serve",
            "call <json>",
        ] {
            assert!(help.contains(name));
        }
        assert!(!state.exists());
    }
    for args in [
        vec!["unknown"],
        vec!["serve", "unexpected"],
        vec!["capabilities", "extra"],
        vec!["projects", "extra"],
        vec!["connection", "extra"],
        vec!["files"],
        vec!["files", "project", "extra"],
        vec!["read", "project"],
        vec!["review", "project", "path", "extra"],
        vec!["git-status"],
        vec!["pdf-info", "project"],
        vec!["call"],
        vec!["call", "not-json"],
        vec!["call", "{\"action\":\"projects\"}", "extra"],
    ] {
        let output = tokio::process::Command::new(env!("CARGO_BIN_EXE_undertree-review"))
            .args(args)
            .env("UNDERTREE_REVIEW_STATE", &state)
            .env("UNDERTREE_REVIEW_ENDPOINT", "https://invalid.invalid/")
            .env("UNDERTREE_REVIEW_TOKEN", "invalid")
            .output()
            .await
            .unwrap();
        assert!(!output.status.success());
        assert!(output.stdout.is_empty());
        let error = String::from_utf8(output.stderr).unwrap();
        assert!(
            error.contains("code: \"command\"")
                || error.contains("code: \"arguments\"")
                || error.contains("code: \"format\""),
            "Unexpected validation boundary: {error}"
        );
        assert!(!state.exists());
    }
    let output = command(&state, &["projects"]).await;
    assert!(!output.status.success());
    assert!(String::from_utf8_lossy(&output.stderr).contains("instance_unavailable"));
    assert!(!state.exists());
}

#[tokio::test]
async fn all_named_reads_use_the_running_authority_without_source_or_registry_mutation() {
    let temporary = tempfile::tempdir().unwrap();
    let root = temporary.path().join("project");
    let state = temporary.path().join("state");
    fs::create_dir(&root).unwrap();
    let filename = "chapter α.typ";
    let content = "= Manuscript\n\nExact saved source.\n";
    fs::write(root.join(filename), content).unwrap();
    assert!(tokio::process::Command::new("git")
        .args(["init", "--quiet", "--initial-branch=main"])
        .arg(&root)
        .status()
        .await
        .unwrap()
        .success());
    let service = Service::new(state.clone()).unwrap();
    let added = service
        .local(Operation::AddProject {
            root: root.to_string_lossy().into(),
        })
        .unwrap();
    let project = added["id"].as_str().unwrap();
    let registry_before = fs::read(state.join("projects.json")).unwrap();
    let instance = LocalInstance::start(Arc::clone(&service)).await.unwrap();
    assert_eq!(result(&state, &["projects"]).await, json!([added]));
    assert_eq!(result(&state, &["files", project]).await, json!([filename]));
    for name in ["read", "review"] {
        let read = result(&state, &[name, project, filename]).await;
        assert_eq!(read["content"], content);
        assert_eq!(read["review"]["revision"], digest(content));
    }
    assert_eq!(result(&state, &["connection"]).await["running"], false);
    assert_eq!(
        result(&state, &["git-status", project]).await["branch"],
        "main"
    );
    assert_eq!(
        result(&state, &["pdf-info", project, filename]).await["available"],
        false
    );
    assert_eq!(
        result(&state, &["call", r#"{"action":"projects"}"#]).await,
        json!([added])
    );
    assert_eq!(fs::read_to_string(root.join(filename)).unwrap(), content);
    assert_eq!(
        fs::read(state.join("projects.json")).unwrap(),
        registry_before
    );
    assert!(!root
        .join(format!("{filename}.undertree-review.json"))
        .exists());
    let denied = command(&state, &["read", project, "../outside.typ"]).await;
    assert!(!denied.status.success());
    let denial: Value = serde_json::from_slice(&denied.stdout).unwrap();
    assert_eq!(denial["error"]["code"], "path");
    instance.stop();
    let unavailable = command(&state, &["read", project, filename]).await;
    assert!(!unavailable.status.success());
    assert!(String::from_utf8_lossy(&unavailable.stderr).contains("instance_unavailable"));
}

#[tokio::test]
async fn cli_read_preserves_external_policy_and_pending_journal_while_native_open_can_recover() {
    let temporary = tempfile::tempdir().unwrap();
    let root = temporary.path().join("project");
    let state = temporary.path().join("state");
    fs::create_dir(&root).unwrap();
    let original = "Keep this saved manuscript.";
    let external = "Externally edited manuscript.";
    let recovered = "Explicitly recovered native manuscript.";
    let source = root.join("main.typ");
    let sidecar = root.join("main.typ.undertree-review.json");
    let pending = root.join("main.typ.undertree-pending.json");
    fs::write(&source, original).unwrap();
    let mut review = Review::new(original);
    review.markers.push(Marker {
        id: "protected".into(),
        anchor: Anchor::new(original, 0, 4).unwrap(),
        rule: "protect".into(),
        prompt: "Keep the original protection.".into(),
    });
    let policy = serde_json::to_vec_pretty(&review).unwrap();
    fs::write(&sidecar, &policy).unwrap();
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
    let instance = LocalInstance::start(service.clone()).await.unwrap();
    fs::write(&source, external).unwrap();
    let observed = result(&state, &["read", &project, "main.typ"]).await;
    assert_eq!(observed["content"], external);
    assert_eq!(observed["review"]["revision"], digest(external));
    assert_eq!(observed["review"]["markers"][0]["anchor"]["stale"], true);
    assert_eq!(fs::read(&source).unwrap(), external.as_bytes());
    assert_eq!(fs::read(&sidecar).unwrap(), policy);
    assert_eq!(fs::read(state.join("projects.json")).unwrap(), registry);
    fs::write(&source, original).unwrap();
    let journal=serde_json::to_vec(&json!({"old_revision":digest(original),"content":recovered,"review":Review::new(recovered)})).unwrap();
    fs::write(&pending, &journal).unwrap();
    for args in [
        vec!["read".to_owned(), project.clone(), "main.typ".into()],
        vec![
            "call".into(),
            json!({"action":"open","project":project,"path":"main.typ"}).to_string(),
        ],
    ] {
        let args: Vec<_> = args.iter().map(String::as_str).collect();
        let response = command(&state, &args).await;
        assert!(!response.status.success());
        let error: Value = serde_json::from_slice(&response.stdout).unwrap();
        assert_eq!(error["error"]["code"], "busy");
        assert_eq!(fs::read(&source).unwrap(), original.as_bytes());
        assert_eq!(fs::read(&sidecar).unwrap(), policy);
        assert_eq!(fs::read(&pending).unwrap(), journal);
        assert_eq!(fs::read(state.join("projects.json")).unwrap(), registry);
    }
    assert_eq!(
        service
            .dispatch_as(
                CallerContext::LocalCli,
                Operation::Open {
                    project: project.clone(),
                    path: "main.typ".into()
                }
            )
            .await
            .unwrap_err()
            .code,
        "busy"
    );
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
    assert_eq!(fs::read(&source).unwrap(), original.as_bytes());
    assert_eq!(fs::read(&sidecar).unwrap(), policy);
    assert_eq!(fs::read(&pending).unwrap(), journal);
    let mut recovered_review = review.clone();
    recovered_review.reconcile(original, recovered);
    let modern_journal = serde_json::to_vec(
        &json!({"old_revision":digest(original),"content":recovered,"review":recovered_review,
        "prior_review":{"state":"hash","sha256":digest(std::str::from_utf8(&policy).unwrap())},
        "ownership":{"project":project,"path":"main.typ","owns_source":true}}),
    )
    .unwrap();
    fs::write(&pending, modern_journal).unwrap();
    let native = service
        .dispatch(Operation::Open {
            project,
            path: "main.typ".into(),
        })
        .await
        .unwrap();
    assert_eq!(native["content"], recovered);
    assert_eq!(fs::read(&source).unwrap(), recovered.as_bytes());
    assert!(!pending.exists());
    assert_eq!(
        serde_json::from_slice::<Review>(&fs::read(sidecar).unwrap())
            .unwrap()
            .revision,
        digest(recovered)
    );
    instance.stop();
}

#[tokio::test]
async fn pdf_info_reports_real_artifact_metadata_without_pdf_payload() {
    if std::env::var_os("UNDERTREE_TYPST").is_none() {
        return;
    }
    let root = tempfile::tempdir().unwrap();
    let state = tempfile::tempdir().unwrap();
    let content = "= PDF information\n\nVerified native compiler output.\n";
    fs::write(root.path().join("main.typ"), content).unwrap();
    let service = Service::new(state.path().into()).unwrap();
    let project = service
        .local(Operation::AddProject {
            root: root.path().to_string_lossy().into(),
        })
        .unwrap()["id"]
        .as_str()
        .unwrap()
        .to_owned();
    service
        .dispatch(Operation::Compile {
            project: project.clone(),
            path: "main.typ".into(),
            revision: digest(content),
        })
        .await
        .unwrap();
    let instance = LocalInstance::start(service).await.unwrap();
    let info = result(state.path(), &["pdf-info", &project, "main.typ"]).await;
    assert_eq!(info["available"], true);
    assert_eq!(info["current"], true);
    assert_eq!(info["revision"], digest(content));
    assert!(info.get("base64").is_none());
    assert_eq!(
        fs::read_to_string(root.path().join("main.typ")).unwrap(),
        content
    );
    drop(instance);
}

#[tokio::test]
async fn user_curl_configuration_cannot_add_a_second_destination() {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let temporary = tempfile::tempdir().unwrap();
    let service = Service::new(temporary.path().join("state")).unwrap();
    let token = "isolated-cli-test-token-000000000000000";
    let intended = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint = format!("http://{}/api/review", intended.local_addr().unwrap());
    let router =
        undertree_review::transport::local_router(service, token.into(), temporary.path().into());
    let intended_server = tokio::spawn(async move { axum::serve(intended, router).await.unwrap() });
    let unintended = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let other_url = format!("http://{}/api/review", unintended.local_addr().unwrap());
    let config = temporary.path().join("curl-home");
    fs::create_dir(&config).unwrap();
    fs::write(config.join(".curlrc"), format!("url = \"{other_url}\"\n")).unwrap();
    // Windows curl uses _curlrc; both names exercise the same private synthetic fixture.
    fs::write(config.join("_curlrc"), format!("url = \"{other_url}\"\n")).unwrap();
    let contacted = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let observed = contacted.clone();
    let unexpected_server = tokio::spawn(async move {
        let (mut stream, _) = unintended.accept().await.unwrap();
        observed.store(true, std::sync::atomic::Ordering::Release);
        let mut request = [0u8; 8192];
        let _ = stream.read(&mut request).await;
        let body = b"{\"ok\":true,\"result\":[]}";
        let response = format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", body.len());
        let _ = stream.write_all(response.as_bytes()).await;
        let _ = stream.write_all(body).await;
    });
    let output = tokio::process::Command::new(env!("CARGO_BIN_EXE_undertree-review"))
        .arg("projects")
        .env("UNDERTREE_REVIEW_ENDPOINT", endpoint)
        .env("UNDERTREE_REVIEW_TOKEN", token)
        .env("CURL_HOME", config)
        .output()
        .await
        .unwrap();
    assert!(output.status.success());
    assert_eq!(
        serde_json::from_slice::<Value>(&output.stdout).unwrap(),
        json!({"ok":true,"result":[]})
    );
    assert!(
        !contacted.load(std::sync::atomic::Ordering::Acquire),
        "User curl configuration added an unintended destination"
    );
    unexpected_server.abort();
    intended_server.abort();
}
