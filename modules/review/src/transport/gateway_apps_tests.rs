use super::tests::{imported_fixture, request, serve};
use super::*;
use axum::response::Response;
use std::sync::atomic::{AtomicUsize, Ordering};

const WIDGET_URI: &str = "ui://secret-tunnel/chat-control-v1.html";
const WIDGET_HTML: &str =
    include_str!("../../../../tests/fixtures/mcp-apps/secret-tunnel-chat-control-v1.html");

#[derive(Default)]
struct AppFixture {
    reads: AtomicUsize,
    calls: AtomicUsize,
}

async fn upstream(State(state): State<Arc<AppFixture>>, Json(message): Json<Value>) -> Response {
    let result = match message["method"].as_str().unwrap_or("") {
        "initialize" => {
            json!({"protocolVersion":MCP_VERSION,"capabilities":{"tools":{},"resources":{}},"serverInfo":{"name":"Secret Tunnel fixture","version":"1"}})
        }
        "notifications/initialized" => return StatusCode::ACCEPTED.into_response(),
        "tools/list" => json!({"tools":[
            {"name":"mcp_request_access","inputSchema":{"type":"object"},"_meta":{"ui":{"resourceUri":WIDGET_URI}}},
            {"name":"mcp_chat_decide","inputSchema":{"type":"object"},"_meta":{"ui":{"visibility":["app"]}}},
            {"name":"mcp_chat_receipt","inputSchema":{"type":"object"},"_meta":{"ui":{"visibility":["app"]}}}
        ]}),
        "resources/read" => {
            state.reads.fetch_add(1, Ordering::SeqCst);
            assert_eq!(message["params"]["uri"], WIDGET_URI);
            json!({"contents":[{"uri":WIDGET_URI,"mimeType":"text/html;profile=mcp-app","text":WIDGET_HTML,
                "_meta":{"ui":{"csp":{"connectDomains":[],"resourceDomains":[]},"prefersBorder":true}}}]})
        }
        "tools/call" => {
            state.calls.fetch_add(1, Ordering::SeqCst);
            json!({"content":[{"type":"text","text":"Fixture receipt"}],
                "structuredContent":{"id":"fixture-receipt","name":message["params"]["name"],"arguments":message["params"]["arguments"]},
                "_meta":{"approval_token":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","details":{"fixture":true}}})
        }
        _ => return StatusCode::METHOD_NOT_ALLOWED.into_response(),
    };
    Json(json!({"jsonrpc":"2.0","id":message["id"],"result":result})).into_response()
}

#[tokio::test]
async fn gateway_http_serves_only_frozen_namespaced_cards_with_current_authority() {
    let state = Arc::new(AppFixture::default());
    let router = Router::new()
        .route("/mcp", post(upstream))
        .with_state(state.clone());
    let (upstream_address, upstream_server) = serve(router).await;
    let temporary = tempfile::tempdir().unwrap();
    let service = Service::new(temporary.path().to_owned()).unwrap();
    imported_fixture(&service).await;
    let (address, server) = serve(imported_router(service.clone())).await;
    let path = "/t/existing_private_token/mcp";
    let headers = format!(
        "Accept: application/json, text/event-stream\r\nMCP-Protocol-Version: {MCP_VERSION}\r\n"
    );
    let initialize = json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":MCP_VERSION,"capabilities":{},"clientInfo":{"name":"app-fixture","version":"1"}}});
    let listing = json!({"jsonrpc":"2.0","id":2,"method":"resources/list"});
    assert_eq!(
        request(address, path, &headers, initialize.clone()).await.1["result"]["capabilities"],
        json!({"tools":{}})
    );
    assert_eq!(
        request(address, path, &headers, listing.clone()).await.1["error"]["code"],
        -32601
    );
    gateway_enable(&service, true).await.unwrap();
    assert_eq!(
        request(address, path, &headers, listing.clone()).await.1["error"]["code"],
        -32000
    );
    assert_eq!(
        request(address, path, &headers, initialize.clone()).await.1["result"]["capabilities"],
        json!({"tools":{},"resources":{}})
    );
    service
        .hub
        .link("Secret Tunnel", &format!("http://{upstream_address}/mcp"))
        .await
        .unwrap();
    let catalogue = request(
        address,
        path,
        &headers,
        json!({"jsonrpc":"2.0","id":3,"method":"tools/list"}),
    )
    .await
    .1;
    let tools = catalogue["result"]["tools"].as_array().unwrap();
    let card = tools
        .iter()
        .find(|tool| tool["_meta"]["undertree/toolName"] == "mcp_request_access")
        .unwrap();
    let decide = tools
        .iter()
        .find(|tool| tool["_meta"]["undertree/toolName"] == "mcp_chat_decide")
        .unwrap();
    assert_eq!(decide["_meta"]["ui"]["visibility"], json!(["app"]));
    let uri = card["_meta"]["ui"]["resourceUri"]
        .as_str()
        .unwrap()
        .to_owned();
    assert_ne!(uri, WIDGET_URI);
    let resources = request(address, path, &headers, listing.clone()).await.1;
    assert_eq!(resources["result"]["resources"][0]["uri"], uri);
    let reading = json!({"jsonrpc":"2.0","id":4,"method":"resources/read","params":{"uri":uri}});
    let read = request(address, path, &headers, reading.clone()).await.1;
    assert_eq!(read["result"]["contents"][0]["uri"], uri);
    assert_eq!(
        read["result"]["contents"][0]["_meta"]["ui"]["csp"],
        json!({"connectDomains":[],"resourceDomains":[]})
    );
    let html = read["result"]["contents"][0]["text"].as_str().unwrap();
    assert!(html.contains(decide["name"].as_str().unwrap()));
    assert!(html.contains("__undertreeSecretTunnelPostMessage"));
    for forbidden in [
        WIDGET_URI,
        "file:///private-source",
        "ui://undertree/another-app/0",
    ] {
        let denied = request(
            address,
            path,
            &headers,
            json!({"jsonrpc":"2.0","id":5,"method":"resources/read","params":{"uri":forbidden}}),
        )
        .await
        .1;
        assert_eq!(denied["error"]["code"], -32602);
        assert!(!denied.to_string().contains("private-source"));
    }
    assert_eq!(
        state.reads.load(Ordering::SeqCst),
        1,
        "Remote reads never fetch arbitrary upstream resources."
    );
    let call = json!({"jsonrpc":"2.0","id":6,"method":"tools/call","params":{"name":card["name"],"arguments":{"requestId":"card-fixture","arguments":{}}}});
    let result = request(address, path, &headers, call).await.1;
    let token = result["result"]["_meta"]["approval_token"]
        .as_str()
        .unwrap();
    assert_eq!(token, "a".repeat(64));
    assert_eq!(
        result["result"]["_meta"]["details"],
        json!({"fixture":true})
    );
    let approval = json!({"jsonrpc":"2.0","id":7,"method":"tools/call","params":{"name":decide["name"],"arguments":{"requestId":"ui-fixture","arguments":{"approval_token":token,"kind":"access","decision":"approve"}}}});
    let approved = request(address, path, &headers, approval.clone()).await.1;
    assert_eq!(
        approved["result"]["structuredContent"]["name"],
        "mcp_chat_decide"
    );
    assert_eq!(
        approved["result"]["structuredContent"]["arguments"]["decision"],
        "approve"
    );
    assert_eq!(request(address, path, &headers, approval).await.1, approved);
    assert_eq!(
        state.calls.load(Ordering::SeqCst),
        2,
        "An identical card decision is never forwarded twice."
    );
    gateway_enable(&service, false).await.unwrap();
    assert_eq!(
        request(address, path, &headers, reading).await.1["error"]["code"],
        -32601
    );
    assert_eq!(
        request(address, path, &headers, initialize).await.1["result"]["capabilities"],
        json!({"tools":{}})
    );
    tunnel(&service, false, String::new(), String::new())
        .await
        .unwrap();
    server.abort();
    upstream_server.abort();
}
