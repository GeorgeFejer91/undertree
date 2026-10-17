use super::*;
use crate::capabilities::CallerContext;
use crate::service::app_control::ControlOperation;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

struct Fixture {
    _temp: tempfile::TempDir,
    service: Arc<Service>,
    project: String,
    document: String,
    owner: String,
}

impl Fixture {
    async fn new() -> Self {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("project");
        fs::create_dir(&root).unwrap();
        fs::write(root.join("main.typ"), "Saved.").unwrap();
        let service = Service::new(temp.path().join("state")).unwrap();
        let project = service
            .local(Operation::AddProject {
                root: root.to_str().unwrap().into(),
            })
            .unwrap()["id"]
            .as_str()
            .unwrap()
            .to_owned();
        let document = service
            .local(Operation::Share {
                project: project.clone(),
                path: "main.typ".into(),
                enabled: true,
                context_shared: true,
                expected_context_scope: service.test_context_scope(&project, "main.typ"),
            })
            .unwrap()["documentId"]
            .as_str()
            .unwrap()
            .to_owned();
        let page = service.connect_native_editor("main").unwrap();
        let owner = service
            .native_editor_owner("main", page["ownerId"].as_str().unwrap())
            .unwrap();
        // Only a live, stdin-held child is needed; use the host's native reader.
        let reader = if cfg!(windows) {
            PathBuf::from(std::env::var_os("SystemRoot").expect("Windows system directory"))
                .join("System32/more.com")
        } else {
            PathBuf::from("cat")
        };
        let child = Command::new(reader)
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::null())
            .kill_on_drop(true)
            .spawn()
            .unwrap();
        let (shutdown, _) = tokio::sync::oneshot::channel();
        *service.tunnel.lock().await = Some(Tunnel {
            session_id: uuid::Uuid::new_v4(),
            endpoint: "https://review.example.org/mcp/test-review".into(),
            secret: "test-review".into(),
            child,
            owned_share: None,
            shutdown,
            mcp_initialized: false,
            last_activity_ms: 0,
            tool_calls: 0,
        });
        let fixture = Self {
            _temp: temp,
            service,
            project,
            document,
            owner,
        };
        fixture
            .ui(json!({"action":"control_enable","enabled":true}))
            .await
            .unwrap();
        fixture.poll().await;
        fixture
    }

    async fn ui(&self, input: Value) -> Result<Value> {
        self.service
            .control_as(
                CallerContext::Local,
                &self.owner,
                serde_json::from_value(input).unwrap(),
            )
            .await
    }
    async fn poll(&self) {
        self.ui(json!({"action":"control_poll","snapshot":{
            "openDocuments":[{"documentId":self.document,"revision":digest("Saved."),"dirty":false,"conflict":false,"composing":false}],
            "activeDocumentId":self.document,"preview":null,
            "view":{"filesVisible":true,"editorVisible":true,"previewVisible":true,"reviewVisible":false,"outlineVisible":false,"logsVisible":false},
            "editor":{"fontSize":12,"wordWrap":true}}})).await.unwrap();
    }
    async fn permit(&self, enabled: bool) {
        let status = self.service.app_control_status().unwrap();
        let generation = status["generation"].clone();
        let export_generation = status["pdfExport"]["generation"].clone();
        self.ui(json!({"action":"control_pdf_export","enabled":enabled,"generation":generation,"exportGeneration":export_generation,"projects":if enabled{vec![self.project.clone()]}else{vec![]}})).await.unwrap();
    }
    fn write_pdf(&self, path: &str, bytes: &[u8]) -> (String, Value) {
        let project = self.service.project(&self.project).unwrap();
        fs::write(project.root.join(path), "Saved.").unwrap();
        self.service
            .local(Operation::SetMainDocument {
                project: self.project.clone(),
                path: path.into(),
            })
            .unwrap();
        let id = self
            .service
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
            .to_owned();
        let stem = digest(&format!("{}:{path}", self.project));
        let sha = format!("{:x}", Sha256::digest(bytes));
        let filename = format!("{stem}-{sha}.pdf");
        let cache = self.service.state.join("pdfs");
        fs::create_dir_all(&cache).unwrap();
        fs::write(cache.join(&filename), bytes).unwrap();
        fs::write(cache.join(format!("{stem}.json")),serde_json::to_vec(&json!({"compiler_capture_version":1,"expected_root":RootedRoot::observe(&project.root).unwrap(),"revision":digest("Saved."),"pdf":filename,"pdf_hash":sha,
            "dependencies":[{"path":path,"revision":digest("Saved.")}],"inputs_stable":true,"external_dependency_count":0,"diagnostics":""})).unwrap()).unwrap();
        assert_eq!(
            self.service.preview_pdf(&self.project, path).unwrap()["current"],
            true
        );
        let info = json!({"documentId":id,"revision":digest("Saved."),"artifactId":digest(&base64::engine::general_purpose::STANDARD.encode(bytes))});
        (id, info)
    }
    fn download(&self, input: Value) -> Result<Value> {
        self.service.app_remote("get_pdf_download", input)
    }
    fn secret(download: &Value) -> String {
        download["downloadUrl"]
            .as_str()
            .unwrap()
            .split("/artifacts/pdf/")
            .nth(1)
            .unwrap()
            .split('/')
            .next()
            .unwrap()
            .into()
    }
}

async fn http(
    address: std::net::SocketAddr,
    method: &str,
    path: &str,
    origin: bool,
    payload: Option<Value>,
) -> (u16, Vec<u8>, String) {
    let body = payload.map(|value| value.to_string()).unwrap_or_default();
    let mut stream = tokio::net::TcpStream::connect(address).await.unwrap();
    let request=format!("{method} {path} HTTP/1.1\r\nHost: {address}\r\nConnection: close\r\nAccept: application/json, text/event-stream\r\nMCP-Protocol-Version: 2025-06-18\r\nContent-Type: application/json\r\nContent-Length: {}\r\n{}\r\n{body}",body.len(),if origin{"Origin: https://untrusted.example\r\n"}else{""});
    stream.write_all(request.as_bytes()).await.unwrap();
    let mut response = Vec::new();
    stream
        .take((MAX_PDF + 64 * 1024) as u64)
        .read_to_end(&mut response)
        .await
        .unwrap();
    let split = response
        .windows(4)
        .position(|bytes| bytes == b"\r\n\r\n")
        .unwrap();
    let headers = String::from_utf8(response[..split].to_vec()).unwrap();
    let status = headers.split_whitespace().nth(1).unwrap().parse().unwrap();
    (status, response[split + 4..].to_vec(), headers)
}

#[tokio::test]
async fn standing_export_is_separate_local_generation_bound_permission_with_fixed_roots() {
    let fixture = Fixture::new().await;
    let (_, input) = fixture.write_pdf("main.typ", b"%PDF-first");
    let initial = fixture.service.app_control_status().unwrap();
    assert_eq!(initial["pdfExport"]["enabled"], false);
    assert_eq!(
        initial["pdfExport"]["eligibleProjects"][0]["sharedCount"],
        1
    );
    assert!(fixture
        .service
        .app_remote("list_manuscripts", json!({}))
        .unwrap()[0]
        .get("savedPdf")
        .is_none());
    assert_eq!(fixture.download(input.clone()).unwrap_err().code, "scope");
    for caller in [CallerContext::LocalCli, CallerContext::Review] {
        let operation:ControlOperation=serde_json::from_value(json!({"action":"control_pdf_export","enabled":true,"projects":[fixture.project],"generation":initial["generation"],"exportGeneration":initial["pdfExport"]["generation"]})).unwrap();
        assert_eq!(
            fixture
                .service
                .control_as(caller, &fixture.owner, operation)
                .await
                .unwrap_err()
                .code,
            "scope"
        );
    }
    fixture.permit(true).await;
    let info = fixture
        .service
        .app_remote("list_manuscripts", json!({}))
        .unwrap();
    assert_eq!(info[0]["savedPdf"]["available"], true);
    assert!(info
        .to_string()
        .find(fixture._temp.path().to_str().unwrap())
        .is_none());
    let other = fixture._temp.path().join("other");
    fs::create_dir(&other).unwrap();
    fs::write(other.join("main.typ"), "Other.").unwrap();
    let project = fixture
        .service
        .local(Operation::AddProject {
            root: other.to_str().unwrap().into(),
        })
        .unwrap()["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let doc = fixture
        .service
        .local(Operation::Share {
            project: project.clone(),
            path: "main.typ".into(),
            enabled: true,
            context_shared: true,
            expected_context_scope: fixture.service.test_context_scope(&project, "main.typ"),
        })
        .unwrap()["documentId"]
        .as_str()
        .unwrap()
        .to_owned();
    let list = fixture
        .service
        .app_remote("list_manuscripts", json!({}))
        .unwrap();
    assert!(list
        .as_array()
        .unwrap()
        .iter()
        .find(|item| item["documentId"] == doc)
        .unwrap()
        .get("savedPdf")
        .is_none());
    let old_generation = initial["generation"].clone();
    fixture
        .ui(json!({"action":"control_enable","enabled":false}))
        .await
        .unwrap();
    fixture
        .ui(json!({"action":"control_enable","enabled":true}))
        .await
        .unwrap();
    fixture.poll().await;
    for enabled in [true, false] {
        assert_eq!(fixture.ui(json!({"action":"control_pdf_export","enabled":enabled,"generation":old_generation,"exportGeneration":initial["pdfExport"]["generation"],"projects":if enabled{vec![fixture.project.clone()]}else{vec![]}})).await.unwrap_err().code,"scope");
    }
    assert_eq!(
        fixture.service.app_control_status().unwrap()["pdfExport"]["enabled"],
        false
    );
    assert_eq!(fixture.download(input).unwrap_err().code, "scope");
}

#[tokio::test]
async fn historical_pdf_without_compiler_capture_marker_cannot_mint_an_export_ticket() {
    let fixture = Fixture::new().await;
    let pdf = b"%PDF-historical";
    let (_, input) = fixture.write_pdf("main.typ", pdf);
    fixture.permit(true).await;
    let metadata = fixture.service.state.join("pdfs").join(format!(
        "{}.json",
        digest(&format!("{}:main.typ", fixture.project))
    ));
    let mut pointer: Value = serde_json::from_slice(&fs::read(&metadata).unwrap()).unwrap();
    let pdf_path = metadata.with_file_name(pointer["pdf"].as_str().unwrap());
    pointer
        .as_object_mut()
        .unwrap()
        .remove("compiler_capture_version");
    let pointer_bytes = serde_json::to_vec(&pointer).unwrap();
    fs::write(&metadata, &pointer_bytes).unwrap();
    let registry = fs::read(fixture.service.state.join("projects.json")).unwrap();
    let project = fixture.service.project(&fixture.project).unwrap();

    let preview = fixture
        .service
        .preview_pdf(&fixture.project, "main.typ")
        .unwrap();
    assert_eq!(preview["available"], true);
    assert_eq!(preview["current"], false);
    assert_eq!(preview["sourceEpoch"], 0);
    assert_eq!(fixture.download(input).unwrap_err().code, "stale");
    let list = fixture
        .service
        .app_remote("list_manuscripts", json!({}))
        .unwrap();
    assert_eq!(
        list[0]["savedPdf"],
        json!({"available":false,"code":"stale"})
    );
    assert!(lock(&fixture.service.pdf_exports)
        .unwrap()
        .tickets
        .is_empty());
    assert_eq!(fs::read(&metadata).unwrap(), pointer_bytes);
    assert_eq!(fs::read(pdf_path).unwrap(), pdf);
    assert_eq!(fs::read(project.root.join("main.typ")).unwrap(), b"Saved.");
    assert!(!project.root.join("main.typ.undertree-review.json").exists());
    assert!(!project
        .root
        .join("main.typ.undertree-pending.json")
        .exists());
    assert_eq!(
        fs::read(fixture.service.state.join("projects.json")).unwrap(),
        registry
    );
}

#[tokio::test]
async fn package_cache_inputs_have_a_scope_error_instead_of_an_unfixable_rebuild_prompt() {
    let fixture = Fixture::new().await;
    let (_, input) = fixture.write_pdf("main.typ", b"%PDF-external-package");
    fixture.permit(true).await;
    let metadata = fixture.service.state.join("pdfs").join(format!(
        "{}.json",
        digest(&format!("{}:main.typ", fixture.project))
    ));
    let mut value: Value = serde_json::from_slice(&fs::read(&metadata).unwrap()).unwrap();
    value["external_dependency_count"] = json!(1);
    fs::write(metadata, serde_json::to_vec(&value).unwrap()).unwrap();
    let error = fixture.download(input).unwrap_err();
    assert_eq!(error.code, "unsupported_scope");
    assert!(!error
        .message
        .to_ascii_lowercase()
        .contains("build explicitly"));
    let list = fixture
        .service
        .app_remote("list_manuscripts", json!({}))
        .unwrap();
    assert_eq!(
        list[0]["savedPdf"],
        json!({"available":false,"code":"unavailable","reason":"external_dependencies"})
    );
}

#[tokio::test]
async fn stale_permission_requests_cannot_reorder_roots_or_reenable_after_off_on_off() {
    let fixture = Fixture::new().await;
    let initial = fixture.service.app_control_status().unwrap();
    let delayed = json!({"action":"control_pdf_export","enabled":true,"generation":initial["generation"],
        "exportGeneration":initial["pdfExport"]["generation"],"projects":[fixture.project]});
    fixture.permit(true).await;
    let current = fixture.service.app_control_status().unwrap();
    assert_ne!(
        current["pdfExport"]["generation"],
        initial["pdfExport"]["generation"]
    );
    assert_eq!(fixture.ui(delayed.clone()).await.unwrap_err().code, "scope");
    let delayed_disable = json!({"action":"control_pdf_export","enabled":false,"generation":current["generation"],
        "exportGeneration":current["pdfExport"]["generation"],"projects":[]});
    fixture.permit(false).await;
    fixture.permit(true).await;
    assert_eq!(fixture.ui(delayed_disable).await.unwrap_err().code, "scope");
    assert_eq!(
        fixture.service.app_control_status().unwrap()["pdfExport"]["enabled"],
        true
    );
    fixture.permit(false).await;
    assert_eq!(fixture.ui(delayed).await.unwrap_err().code, "scope");
    assert_eq!(
        fixture.service.app_control_status().unwrap()["pdfExport"]["enabled"],
        false
    );
}

#[tokio::test]
async fn actual_http_exports_exact_pinned_bytes_without_source_changes_or_artifact_fallback() {
    let fixture = Fixture::new().await;
    let first = b"%PDF-first-immutable\n";
    let (_, input) = fixture.write_pdf("main.typ", first);
    fixture.permit(true).await;
    let source = fixture
        .service
        .project(&fixture.project)
        .unwrap()
        .root
        .join("main.typ");
    let source_bytes = fs::read(&source).unwrap();
    let registry = fs::read(fixture.service.state.join("projects.json")).unwrap();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let router = crate::transport::remote_router(fixture.service.clone());
    let server = tokio::spawn(async move {
        axum::serve(listener, router).await.unwrap();
    });
    let endpoint = fixture.service.app_control_status().unwrap()["endpoint"]
        .as_str()
        .unwrap()
        .to_owned();
    let path = endpoint
        .parse::<axum::http::Uri>()
        .unwrap()
        .path()
        .to_owned();
    let (_,body,_)=http(address,"POST",&path,false,Some(json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","clientInfo":{"name":"pdf-test","version":"1"},"capabilities":{}}}))).await;
    assert!(serde_json::from_slice::<Value>(&body)
        .unwrap()
        .get("result")
        .is_some());
    fixture.poll().await;
    let (status,body,_)=http(address,"POST",&path,false,Some(json!({"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"get_pdf_download","arguments":input}}))).await;
    assert_eq!(status, 200);
    let result: Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(result["result"]["isError"], false, "{result}");
    assert_eq!(result["result"]["content"][1]["type"], "resource_link");
    let download = &result["result"]["structuredContent"]["result"];
    let route = download["downloadUrl"]
        .as_str()
        .unwrap()
        .parse::<axum::http::Uri>()
        .unwrap()
        .path()
        .to_owned();
    fixture.write_pdf("main.typ", b"%PDF-second-same-source\n");
    let old_pdf = fixture.service.state.join("pdfs").join(format!(
        "{}-{}.pdf",
        digest(&format!("{}:main.typ", fixture.project)),
        download["sha256"].as_str().unwrap()
    ));
    fs::remove_file(old_pdf).unwrap();
    assert_eq!(fixture.download(input).unwrap_err().code, "stale");
    let (status, body, headers) = http(address, "GET", &route, false, None).await;
    assert_eq!(status, 200);
    assert_eq!(body, first);
    assert!(headers
        .to_ascii_lowercase()
        .contains("content-type: application/pdf"));
    assert!(headers
        .to_ascii_lowercase()
        .contains("cache-control: no-store"));
    assert_eq!(format!("{:x}", Sha256::digest(&body)), download["sha256"]);
    let permits = (0..MAX_AUTH_WORKERS)
        .map(|_| fixture.service.pdf_download_worker().unwrap())
        .collect::<Vec<_>>();
    assert_eq!(http(address, "HEAD", &route, false, None).await.0, 429);
    drop(permits);
    let (status, body, _) = http(address, "HEAD", &route, false, None).await;
    assert_eq!(status, 200);
    assert!(body.is_empty());
    assert_eq!(http(address, "GET", &route, true, None).await.0, 403);
    assert_eq!(
        http(
            address,
            "GET",
            "/artifacts/pdf/not-a-ticket/document.pdf",
            false,
            None
        )
        .await
        .0,
        404
    );
    assert_eq!(
        http(address, "POST", &route, false, Some(json!({})))
            .await
            .0,
        405
    );
    fixture.permit(false).await;
    assert_eq!(http(address, "GET", &route, false, None).await.0, 404);
    assert_eq!(fs::read(source).unwrap(), source_bytes);
    assert_eq!(
        fs::read(fixture.service.state.join("projects.json")).unwrap(),
        registry
    );
    assert!(!fixture
        .service
        .project(&fixture.project)
        .unwrap()
        .root
        .join("main.typ.undertree-review.json")
        .exists());
    server.abort();
}

#[tokio::test]
async fn tickets_bound_concurrency_expiry_memory_and_chunk_revocation_without_blocking_ui() {
    let fixture = Fixture::new().await;
    let bytes = vec![b'x'; CHUNK * 3];
    let mut pdf = b"%PDF-".to_vec();
    pdf.extend(bytes);
    let (_, input) = fixture.write_pdf("main.typ", &pdf);
    fixture.permit(true).await;
    let download = fixture.download(input.clone()).unwrap();
    let secret = Fixture::secret(&download);
    let (_, first) = fixture.service.pdf_download(&secret, false).unwrap();
    let mut first = first.unwrap();
    let (_, second) = fixture.service.pdf_download(&secret, false).unwrap();
    assert_eq!(
        fixture
            .service
            .pdf_download(&secret, false)
            .err()
            .unwrap()
            .code,
        "busy"
    );
    let chunk = std::future::poll_fn(|cx| Pin::new(&mut first).poll_next(cx))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(chunk.len(), CHUNK);
    let work = lock(&fixture.service.pdf_exports).unwrap().work.clone();
    let (ready_tx, ready_rx) = std::sync::mpsc::channel();
    let (release_tx, release_rx) = std::sync::mpsc::channel();
    let holder = std::thread::spawn(move || {
        let _held = work.lock().unwrap();
        ready_tx.send(()).unwrap();
        let _ = release_rx.recv();
    });
    ready_rx.recv().unwrap();
    assert_eq!(fixture.download(input.clone()).unwrap_err().code, "busy");
    tokio::time::timeout(Duration::from_secs(1), fixture.poll())
        .await
        .unwrap();
    release_tx.send(()).unwrap();
    holder.join().unwrap();
    fixture.permit(false).await;
    assert!(
        std::future::poll_fn(|cx| Pin::new(&mut first).poll_next(cx))
            .await
            .unwrap()
            .is_err()
    );
    assert_eq!(
        lock(&fixture.service.pdf_exports)
            .unwrap()
            .budget
            .load(Ordering::Acquire),
        pdf.len()
    );
    drop(first);
    drop(second);
    assert_eq!(
        lock(&fixture.service.pdf_exports)
            .unwrap()
            .budget
            .load(Ordering::Acquire),
        0
    );
    fixture.permit(true).await;
    let next = fixture.download(input.clone()).unwrap();
    let next_secret = Fixture::secret(&next);
    lock(&fixture.service.pdf_exports)
        .unwrap()
        .tickets
        .get_mut(&next_secret)
        .unwrap()
        .expires = Instant::now() - Duration::from_secs(1);
    assert!(fixture.service.pdf_download(&next_secret, false).is_err());
    fixture.permit(false).await;
    fixture.permit(true).await;
    for i in 0..MAX_TICKETS {
        let (_, input) = fixture.write_pdf(&format!("file{i}.typ"), b"%PDF-bounded");
        fixture.poll().await; // Match the real UI's live heartbeat during bounded file preparation.
        fixture.download(input).unwrap();
    }
    assert_eq!(fixture.download(input).unwrap_err().code, "limit");
}

#[tokio::test]
async fn pending_save_root_replacement_owner_rotation_and_unshare_revoke_export_authority() {
    let fixture = Fixture::new().await;
    let (_, input) = fixture.write_pdf("main.typ", b"%PDF-owned");
    fixture.permit(true).await;
    let download = fixture.download(input.clone()).unwrap();
    let secret = Fixture::secret(&download);
    let project = fixture.service.project(&fixture.project).unwrap();
    let pending = project.root.join("main.typ.undertree-pending.json");
    fs::write(&pending, "preserve invalid journal").unwrap();
    assert_eq!(fixture.download(input.clone()).unwrap_err().code, "busy");
    assert!(fixture.service.pdf_download(&secret, false).is_err());
    assert_eq!(
        fs::read_to_string(&pending).unwrap(),
        "preserve invalid journal"
    );
    fs::remove_file(pending).unwrap();
    let moved = fixture._temp.path().join("original-root");
    fs::rename(&project.root, &moved).unwrap();
    fs::create_dir(&project.root).unwrap();
    fs::write(project.root.join("main.typ"), "Saved.").unwrap();
    assert_eq!(fixture.download(input.clone()).unwrap_err().code, "scope");
    assert!(fixture.service.pdf_download(&secret, false).is_err());
    assert!(fixture.service.app_control_status().is_ok());
    fs::remove_dir_all(&project.root).unwrap();
    fs::rename(&moved, &project.root).unwrap();
    fixture
        .service
        .local(Operation::Share {
            project: fixture.project.clone(),
            path: "main.typ".into(),
            enabled: false,
            context_shared: false,
            expected_context_scope: None,
        })
        .unwrap();
    fixture
        .service
        .local(Operation::Share {
            project: fixture.project.clone(),
            path: "main.typ".into(),
            enabled: true,
            context_shared: true,
            expected_context_scope: fixture
                .service
                .test_context_scope(&fixture.project, "main.typ"),
        })
        .unwrap();
    assert!(fixture.service.pdf_download(&secret, false).is_err());
    fixture
        .ui(json!({"action":"control_enable","enabled":true}))
        .await
        .unwrap();
    fixture.poll().await;
    fixture.permit(true).await;
    let new = fixture.download(input).unwrap();
    let new_secret = Fixture::secret(&new);
    fixture.service.connect_native_editor("main").unwrap();
    assert!(fixture.service.pdf_download(&new_secret, false).is_err());
}

#[tokio::test]
async fn downloaded_ticket_and_stream_keep_enrollment_epoch_after_same_path_reenrollment() {
    let fixture = Fixture::new().await;
    let mut bytes = b"%PDF-".to_vec();
    bytes.extend(vec![b'x'; CHUNK * 2]);
    let (_, input) = fixture.write_pdf("main.typ", &bytes);
    fixture.permit(true).await;
    let download = fixture.download(input.clone()).unwrap();
    let secret = Fixture::secret(&download);
    let (_, stream) = fixture.service.pdf_download(&secret, false).unwrap();
    let mut stream = stream.unwrap();
    assert!(
        std::future::poll_fn(|cx| Pin::new(&mut stream).poll_next(cx))
            .await
            .unwrap()
            .is_ok()
    );
    fixture
        .service
        .retire_source_for_test(&fixture.project, "main.typ")
        .unwrap();
    assert!(fixture.service.pdf_download(&secret, true).is_err());
    assert!(
        std::future::poll_fn(|cx| Pin::new(&mut stream).poll_next(cx))
            .await
            .unwrap()
            .is_err()
    );
    let enrolled = fixture
        .service
        .local_source(crate::SourceRequest {
            operation: Operation::Share {
                project: fixture.project.clone(),
                path: "main.typ".into(),
                enabled: true,
                context_shared: true,
                expected_context_scope: fixture
                    .service
                    .test_context_scope(&fixture.project, "main.typ"),
            },
            source_epoch: 1,
            expected_root: None,
        })
        .unwrap();
    assert_ne!(enrolled["documentId"], fixture.document);
    assert!(fixture.service.pdf_download(&secret, true).is_err());
    assert_eq!(fixture.download(input).unwrap_err().code, "scope");
    let project = fixture.service.project(&fixture.project).unwrap();
    assert_eq!(fs::read(project.root.join("main.typ")).unwrap(), b"Saved.");
    assert!(!project.root.join("main.typ.undertree-review.json").exists());
}
