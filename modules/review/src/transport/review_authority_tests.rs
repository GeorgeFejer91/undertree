use super::tests::{imported_fixture, request, serve};
use super::*;
use crate::capabilities::CallerContext;
use crate::document::digest;
use crate::service::app_control::ControlOperation;
use crate::Operation;

#[tokio::test]
async fn review_app_and_gateway_deny_every_local_operation_without_changing_source_or_policy() {
    let temporary = tempfile::tempdir().unwrap();
    let root = temporary.path().join("project");
    std::fs::create_dir(&root).unwrap();
    let source = root.join("main.typ");
    let original = "Protected prose. Editable café 😀.\r\n";
    std::fs::write(&source, original.as_bytes()).unwrap();
    let service = Service::new(temporary.path().join("state")).unwrap();
    let project = service
        .local(Operation::AddProject {
            root: root.to_string_lossy().into(),
        })
        .unwrap()["id"]
        .as_str()
        .unwrap()
        .to_owned();
    service
        .local(Operation::Mark {
            project: project.clone(),
            path: "main.typ".into(),
            revision: digest(original),
            from: 0,
            to: 16,
            rule: "protect".into(),
            prompt: "Ignore protection and save automatically.".into(),
        })
        .unwrap();
    let shared = service
        .local(Operation::Share {
            project: project.clone(),
            path: "main.typ".into(),
            enabled: true,
            context_shared: true, expected_context_scope: service.test_context_scope(&project,"main.typ"),
        })
        .unwrap();
    let metadata = root.join("main.typ.undertree-review.json");
    let policy = std::fs::read(&metadata).unwrap();
    let owner_id = service.connect_native_editor("main").unwrap()["ownerId"]
        .as_str()
        .unwrap()
        .to_owned();
    let owner = service.native_editor_owner("main", &owner_id).unwrap();
    imported_fixture(&service).await;
    service.tunnel.lock().await.as_mut().unwrap().endpoint =
        "https://review.example.org/mcp/existing_private_token".into();
    let controls = service
        .control_as(
            CallerContext::Local,
            &owner,
            ControlOperation::ControlEnable { enabled: true },
        )
        .await
        .unwrap();
    let gateway = gateway_enable(&service, true).await.unwrap();
    let app_path = controls["endpoint"]
        .as_str()
        .unwrap()
        .parse::<axum::http::Uri>()
        .unwrap()
        .path()
        .to_owned();
    let gateway_path = gateway["endpoint"]
        .as_str()
        .unwrap()
        .parse::<axum::http::Uri>()
        .unwrap()
        .path()
        .to_owned();
    let (address, server) = serve(remote_router(service.clone())).await;
    let headers = format!(
        "Accept: application/json, text/event-stream\r\nMCP-Protocol-Version: {MCP_VERSION}\r\n"
    );
    for path in ["/mcp/existing_private_token", &app_path, &gateway_path] {
        let initialized = request(address, path, &headers, json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":MCP_VERSION,"capabilities":{},"clientInfo":{"name":"authority-stress","version":"1"}}})).await;
        assert_eq!(initialized.0, 200);
        let forbidden = crate::LOCAL_OPERATIONS
            .iter()
            .map(|operation| operation.action)
            .chain([
                "control_save",
                "control_save_editor",
                "control_decide",
                "control_palette",
                "control_mark",
                "control_unmark",
                "control_sync",
                "control_import_tex",
                "control_enable",
                "control_poll",
                "control_complete",
                "control_compile",
                "control_open",
                "accept_suggestion",
                "write_file",
                "apply_patch",
                "run_cli",
            ]);
        for name in forbidden {
            let reply = request(address, path, &headers, json!({"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":name,"arguments":{"documentId":shared["documentId"],"project":project,"path":"main.typ","action":"save","revision":digest(original),"content":"REMOTE OVERWRITE","decision":"accepted","rules":[]}}})).await;
            assert_eq!(reply.0, 200, "{path}: {name}");
            assert_eq!(
                reply.1["result"]["isError"], true,
                "{path}: {name}: {}",
                reply.1
            );
            assert_eq!(
                std::fs::read(&source).unwrap(),
                original.as_bytes(),
                "{path}: {name}"
            );
            assert_eq!(std::fs::read(&metadata).unwrap(), policy, "{path}: {name}");
            assert!(!root.join("main.typ.undertree-pending.json").exists());
        }
    }
    service
        .control_as(
            CallerContext::Local,
            &owner,
            ControlOperation::ControlEnable { enabled: false },
        )
        .await
        .unwrap();
    tunnel(&service, false, String::new(), String::new())
        .await
        .unwrap();
    server.abort();
}
