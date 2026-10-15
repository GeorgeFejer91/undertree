use serde_json::{json, Value};
use std::path::Path;
use std::sync::Arc;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use undertree_review::instance::{LocalConnection, LocalInstance};
use undertree_review::service::Service;
use undertree_review::Operation;

async fn request(
    connection: &LocalConnection,
    path: &str,
    token: &str,
    instance: &str,
    extra: &str,
    body: Value,
) -> (u16, Value) {
    let address = connection
        .endpoint()
        .strip_prefix("http://")
        .unwrap()
        .split('/')
        .next()
        .unwrap();
    let mut stream = tokio::net::TcpStream::connect(address).await.unwrap();
    let body = body.to_string();
    let headers = format!("POST {path} HTTP/1.1\r\nHost: {address}\r\nAuthorization: Bearer {token}\r\nX-UnderTree-Instance: {instance}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n{extra}\r\n{body}", body.len());
    stream.write_all(headers.as_bytes()).await.unwrap();
    let mut response = Vec::new();
    tokio::time::timeout(
        std::time::Duration::from_secs(5),
        stream.read_to_end(&mut response),
    )
    .await
    .unwrap()
    .unwrap();
    let response = String::from_utf8(response).unwrap();
    let (headers, body) = response.split_once("\r\n\r\n").unwrap();
    (
        headers.split_whitespace().nth(1).unwrap().parse().unwrap(),
        serde_json::from_str(body).unwrap_or(Value::Null),
    )
}

async fn call(connection: &LocalConnection, body: Value) -> (u16, Value) {
    request(
        connection,
        "/api/review",
        connection.token(),
        connection.instance_id(),
        "",
        body,
    )
    .await
}

async fn cli(state: &Path) -> std::process::Output {
    tokio::process::Command::new(env!("CARGO_BIN_EXE_undertree-review"))
        .arg("capabilities")
        .env_remove("UNDERTREE_REVIEW_ENDPOINT")
        .env_remove("UNDERTREE_REVIEW_TOKEN")
        .env("UNDERTREE_REVIEW_STATE", state)
        .output()
        .await
        .unwrap()
}

#[tokio::test]
async fn instance_cli_uses_one_authority_and_is_read_only_without_a_session_barrier() {
    let temporary = tempfile::tempdir().unwrap();
    let state = temporary.path().join("state");
    let service = Service::new(state.clone()).unwrap();
    let instance = LocalInstance::start(service.clone()).await.unwrap();
    let connection = LocalConnection::discover(&state).unwrap();
    let project_dir = temporary.path().join("project");
    std::fs::create_dir(&project_dir).unwrap();
    std::fs::write(project_dir.join("main.typ"), "Original manuscript.").unwrap();
    let project = service
        .local(Operation::AddProject {
            root: project_dir.to_string_lossy().into(),
        })
        .unwrap();
    let (status, reply) = call(&connection, json!({"action":"projects"})).await;
    assert_eq!(status, 200);
    assert_eq!(reply["result"], json!([project]));
    let output = cli(&state).await;
    assert!(output.status.success(), "CLI discovery failed");
    assert!(!String::from_utf8_lossy(&output.stdout).contains(connection.token()));
    assert!(!String::from_utf8_lossy(&output.stderr).contains(connection.token()));
    let discovery: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(discovery["result"]["instanceId"], connection.instance_id());
    assert_eq!(discovery["result"]["caller"], "local_cli");
    assert_eq!(discovery["result"]["access"]["readOnly"], false);
    assert!(discovery["result"]["localOperations"]
        .as_array()
        .unwrap()
        .iter()
        .all(|operation| operation["mutates"] == false || operation["action"] == "save_editor"));
    let (status, reply) = call(&connection, json!({"action":"save","project":project["id"],"path":"main.typ","revision":"stale","content":"Overwrite"})).await;
    assert_eq!(status, 400);
    assert_eq!(reply["error"]["code"], "unsupported_capability");
    assert_eq!(
        std::fs::read_to_string(project_dir.join("main.typ")).unwrap(),
        "Original manuscript."
    );
    for path in ["/", "/health", "/manuscript.html", "/mcp/secret"] {
        assert_eq!(
            request(
                &connection,
                path,
                connection.token(),
                connection.instance_id(),
                "",
                json!({})
            )
            .await
            .0,
            404
        );
    }
    assert_eq!(
        request(
            &connection,
            "/api/review",
            "wrong",
            connection.instance_id(),
            "",
            json!({"action":"projects"})
        )
        .await
        .0,
        401
    );
    let (status, reply) = request(
        &connection,
        "/api/review",
        connection.token(),
        "previous-instance",
        "",
        json!({"action":"projects"}),
    )
    .await;
    assert_eq!(status, 409);
    assert_eq!(reply["error"]["code"], "stale_instance");
    assert_eq!(
        request(
            &connection,
            "/api/review",
            connection.token(),
            connection.instance_id(),
            "Origin: http://127.0.0.1\r\n",
            json!({"action":"projects"})
        )
        .await
        .0,
        403
    );
    instance.stop();
    assert!(!state.join("cli/instance.json").exists());
    assert!(LocalConnection::discover(&state).is_err());
    assert!(!cli(&state).await.status.success());
}

#[tokio::test]
async fn duplicate_hosts_stale_descriptors_and_restarts_do_not_restore_credentials() {
    let temporary = tempfile::tempdir().unwrap();
    let service = Service::new(temporary.path().to_owned()).unwrap();
    let instance = LocalInstance::start(service.clone()).await.unwrap();
    let old = LocalConnection::discover(temporary.path()).unwrap();
    let descriptor = std::fs::read(temporary.path().join("cli/instance.json")).unwrap();
    let duplicate = Service::new(temporary.path().to_owned()).unwrap();
    assert!(
        matches!(LocalInstance::start(duplicate).await, Err(error) if error.code == "instance_running")
    );
    assert_eq!(
        LocalConnection::discover(temporary.path())
            .unwrap()
            .instance_id(),
        old.instance_id()
    );
    instance.stop();
    std::fs::write(temporary.path().join("cli/instance.json"), descriptor).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(
            temporary.path().join("cli/instance.json"),
            std::fs::Permissions::from_mode(0o600),
        )
        .unwrap();
    }
    assert!(LocalConnection::discover(temporary.path()).is_err());
    let restarted = LocalInstance::start(Service::new(temporary.path().to_owned()).unwrap())
        .await
        .unwrap();
    let current = LocalConnection::discover(temporary.path()).unwrap();
    assert_ne!(current.instance_id(), old.instance_id());
    assert_ne!(current.token(), old.token());
    assert_eq!(
        request(
            &current,
            "/api/review",
            old.token(),
            old.instance_id(),
            "",
            json!({"action":"projects"})
        )
        .await
        .0,
        401
    );
    assert_eq!(
        request(
            &current,
            "/api/review",
            current.token(),
            old.instance_id(),
            "",
            json!({"action":"projects"})
        )
        .await
        .0,
        409
    );
    drop(instance);
    assert!(LocalConnection::discover(temporary.path()).is_ok());
    drop(restarted);
    assert!(LocalConnection::discover(temporary.path()).is_err());
}

#[tokio::test]
async fn process_death_releases_the_host_lock_and_stale_descriptor_is_unusable() {
    let temporary = tempfile::tempdir().unwrap();
    let mut child = tokio::process::Command::new(env!("CARGO_BIN_EXE_undertree-review"))
        .env("UNDERTREE_REVIEW_STATE", temporary.path())
        .env(
            "UNDERTREE_REVIEW_TOKEN",
            "headless-fixture-token-000000000000000000",
        )
        .env("UNDERTREE_REVIEW_PORT", "0")
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .unwrap();
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(5);
    let old = loop {
        if let Ok(connection) = LocalConnection::discover(temporary.path()) {
            break connection;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "Headless authority did not publish its descriptor"
        );
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    };
    child.kill().await.unwrap();
    child.wait().await.unwrap();
    assert!(temporary.path().join("cli/instance.json").exists());
    assert!(LocalConnection::discover(temporary.path()).is_err());
    let instance = LocalInstance::start(Service::new(temporary.path().to_owned()).unwrap())
        .await
        .unwrap();
    let current = LocalConnection::discover(temporary.path()).unwrap();
    assert_ne!(current.instance_id(), old.instance_id());
    assert_eq!(
        call(&current, json!({"action":"capabilities"})).await.0,
        200
    );
    drop(instance);
}

#[cfg(unix)]
#[tokio::test]
async fn discovery_refuses_links_and_world_readable_credentials() {
    use std::os::unix::fs::{symlink, PermissionsExt};
    let temporary = tempfile::tempdir().unwrap();
    let service = Service::new(temporary.path().join("state")).unwrap();
    std::fs::create_dir(temporary.path().join("outside")).unwrap();
    symlink(
        temporary.path().join("outside"),
        service.publishing_root().join("cli"),
    )
    .unwrap();
    assert!(LocalInstance::start(Arc::clone(&service)).await.is_err());
    std::fs::remove_file(service.publishing_root().join("cli")).unwrap();
    let instance = LocalInstance::start(service.clone()).await.unwrap();
    let descriptor = service.publishing_root().join("cli/instance.json");
    assert_eq!(
        std::fs::metadata(&descriptor).unwrap().permissions().mode() & 0o077,
        0
    );
    std::fs::set_permissions(&descriptor, std::fs::Permissions::from_mode(0o644)).unwrap();
    assert!(LocalConnection::discover(service.publishing_root()).is_err());
    // Restore permissions so the owner can remove its descriptor on shutdown.
    std::fs::set_permissions(&descriptor, std::fs::Permissions::from_mode(0o600)).unwrap();
    instance.stop();
}

#[tokio::test]
async fn stopping_an_instance_does_not_remove_a_replaced_descriptor() {
    let temporary = tempfile::tempdir().unwrap();
    let service = Service::new(temporary.path().to_owned()).unwrap();
    let instance = LocalInstance::start(service).await.unwrap();
    let path = temporary.path().join("cli/instance.json");
    let mut replacement: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    replacement["token"] = json!("0".repeat(64));
    let bytes = serde_json::to_vec(&replacement).unwrap();
    std::fs::write(&path, &bytes).unwrap();
    instance.stop();
    assert_eq!(std::fs::read(&path).unwrap(), bytes);
    assert!(LocalConnection::discover(temporary.path()).is_err());
}
