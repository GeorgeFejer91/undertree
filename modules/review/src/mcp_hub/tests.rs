use super::*;
use axum::extract::State;
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::{routing::post, Json, Router};
use std::sync::atomic::{AtomicUsize, Ordering};
use tokio::sync::Semaphore;

struct Fixture {
    label: String,
    instructions: Option<String>,
    calls: AtomicUsize,
    initializations: AtomicUsize,
    listings: AtomicUsize,
    mode: AtomicUsize,
    started: Semaphore,
    finish: Semaphore,
}

async fn response(
    State(state): State<Arc<Fixture>>,
    headers: HeaderMap,
    Json(request): Json<Value>,
) -> Response {
    let id = request.get("id").cloned().unwrap_or(Value::Null);
    let method = request.get("method").and_then(Value::as_str).unwrap_or("");
    let result = match method {
        "initialize" => {
            state.initializations.fetch_add(1, Ordering::SeqCst);
            let mut information = json!({
                "protocolVersion":"2025-06-18",
                "capabilities":{"tools":{}},
                "serverInfo":{"name":"hub-fixture","version":"1"},
            });
            if let Some(instructions) = &state.instructions {
                information["instructions"] = json!(instructions);
            }
            return (
                [("mcp-session-id", "fixture-session")],
                Json(json!({"jsonrpc":"2.0","id":id,"result":information})),
            )
                .into_response();
        }
        "notifications/initialized" => return StatusCode::ACCEPTED.into_response(),
        "tools/list" => {
            state.listings.fetch_add(1, Ordering::SeqCst);
            if state.mode.load(Ordering::SeqCst) == 6 && state.listings.load(Ordering::SeqCst) == 1
            {
                state.started.add_permits(1);
                state.finish.acquire().await.unwrap().forget();
            }
            if headers
                .get("mcp-session-id")
                .and_then(|value| value.to_str().ok())
                != Some("fixture-session")
            {
                return StatusCode::BAD_REQUEST.into_response();
            }
            if request["params"]["cursor"] == "second" {
                json!({"tools":[{
                    "name":"set_state",
                    "title":"Set state",
                    "description":"Change fixture state.",
                    "inputSchema":{
                        "type":"object",
                        "$defs":{"state":{"type":"string"}},
                        "properties":{"state":{"$ref":"#/$defs/state"}},
                        "required":["state"],
                    },
                    "outputSchema":{"type":"object"},
                    "_meta":{"fixture":"preserved"},
                }]})
            } else {
                json!({"tools":[{
                    "name":"read_state",
                    "title":"Read state",
                    "inputSchema":{"$id":"urn:fixture:original","type":"object","properties":{}},
                    "annotations":{"readOnlyHint":true},
                }],"nextCursor":"second"})
            }
        }
        "tools/call" => {
            state.calls.fetch_add(1, Ordering::SeqCst);
            match state.mode.load(Ordering::SeqCst) {
                2 => return StatusCode::NOT_FOUND.into_response(),
                3 => {
                    state.started.add_permits(1);
                    state.finish.acquire().await.unwrap().forget();
                }
                4 => return Json(json!({"jsonrpc":"2.0","id":id,"result":{
                    "content":[{"type":"text","text":"oversized-private-token".repeat(MAX_WIRE_RESPONSE / 10)}],
                }})).into_response(),
                5 => return (StatusCode::INTERNAL_SERVER_ERROR, "https://private.invalid/secret-token Bearer private-token").into_response(),
                _ => {}
            }
            json!({
                "content":[{"type":"text","text":state.label}],
                "structuredContent":{"app":state.label,"name":request["params"]["name"],"arguments":request["params"]["arguments"]},
                "isError":false,
                "_meta":{"fixture":"result-preserved"},
            })
        }
        _ => return StatusCode::ACCEPTED.into_response(),
    };
    let message = json!({"jsonrpc":"2.0","id":id,"result":result});
    if state.mode.load(Ordering::SeqCst) == 7 && method == "tools/call" {
        let notification = futures_util::stream::once(async {
            Ok::<_, io::Error>("event: message\ndata: {\"jsonrpc\":\"2.0\",\"method\":\"notifications/tools/list_changed\"}\n\n".to_owned())
        });
        let result = futures_util::stream::once(async move {
            state.finish.acquire().await.unwrap().forget();
            Ok::<_, io::Error>(format!("event: message\ndata: {message}\n\n"))
        });
        return (
            [("content-type", "text/event-stream")],
            axum::body::Body::from_stream(notification.chain(result)),
        )
            .into_response();
    }
    if state.mode.load(Ordering::SeqCst) == 1 {
        (
            [("content-type", "text/event-stream")],
            format!("event: message\ndata: {message}\n\n"),
        )
            .into_response()
    } else {
        Json(message).into_response()
    }
}

async fn events(State(state): State<Arc<Fixture>>) -> Response {
    if state.mode.load(Ordering::SeqCst) != 8 {
        return StatusCode::METHOD_NOT_ALLOWED.into_response();
    }
    state.started.add_permits(1);
    let notification = futures_util::stream::once(async move {
        state.finish.acquire().await.unwrap().forget();
        Ok::<_, io::Error>("event: message\ndata: {\"jsonrpc\":\"2.0\",\"method\":\"notifications/tools/list_changed\"}\n\n".to_owned())
    });
    (
        [("content-type", "text/event-stream")],
        axum::body::Body::from_stream(notification.chain(futures_util::stream::pending::<
            std::result::Result<String, io::Error>,
        >())),
    )
        .into_response()
}

async fn fixture(label: &str, mode: usize) -> (String, Arc<Fixture>, tokio::task::JoinHandle<()>) {
    fixture_with_instructions(label, mode, None).await
}

async fn fixture_with_instructions(
    label: &str,
    mode: usize,
    instructions: Option<String>,
) -> (String, Arc<Fixture>, tokio::task::JoinHandle<()>) {
    let state = Arc::new(Fixture {
        label: label.into(),
        instructions,
        calls: AtomicUsize::new(0),
        initializations: AtomicUsize::new(0),
        listings: AtomicUsize::new(0),
        mode: AtomicUsize::new(mode),
        started: Semaphore::new(0),
        finish: Semaphore::new(0),
    });
    let router = Router::new()
        .route(
            "/mcp/private-fixture-token",
            post(response)
                .get(events)
                .delete(|| async { StatusCode::NO_CONTENT }),
        )
        .with_state(state.clone());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint = format!(
        "http://{}/mcp/private-fixture-token",
        listener.local_addr().unwrap()
    );
    let task = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
    (endpoint, state, task)
}

fn alias(hub: &Hub, app: &str, name: &str) -> String {
    hub.catalogue()
        .unwrap()
        .iter()
        .find(|tool| {
            tool["_meta"]["undertree/appId"] == app && tool["_meta"]["undertree/toolName"] == name
        })
        .unwrap()["name"]
        .as_str()
        .unwrap()
        .into()
}

async fn wait_for_catalogue_change(hub: &Hub, app: &str) {
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let changed = {
                let state = hub.lock().unwrap();
                catalogue_changed(&state.apps.get(app).unwrap().client)
            };
            if changed {
                return;
            }
            tokio::time::sleep(Duration::from_millis(1)).await;
        }
    })
    .await
    .unwrap();
}

#[test]
fn endpoint_validation_requires_https_or_literal_loopback_and_omits_secrets() {
    for endpoint in [
        "https://example.invalid/mcp/secret-token",
        "https://example.invalid:443/mcp",
        "http://127.0.0.1:8123/mcp",
        "http://127.4.3.2/mcp",
        "http://[::1]:8123/mcp",
    ] {
        validate_endpoint(endpoint).unwrap();
    }
    for endpoint in [
        "http://localhost/mcp",
        "http://example.invalid/mcp",
        "http://127.1/mcp",
        "http://2130706433/mcp",
        "http://[::ffff:127.0.0.1]/mcp",
        "file:///private/secret-token",
        "https://user:secret-token@example.invalid/mcp",
        "https://example.invalid/mcp?secret-token=value",
        "https://example.invalid/mcp#secret-token",
        "https://example.invalid\\@private.invalid/mcp",
        " https://example.invalid/mcp",
    ] {
        let error = validate_endpoint(endpoint).unwrap_err();
        assert_eq!(error.code, "hub_endpoint", "{endpoint}");
        assert!(!error.message.contains("secret-token"));
    }
}

#[tokio::test]
async fn disabled_hub_rejects_links_and_calls_without_network() {
    let hub = Hub::new();
    assert_eq!(hub.status().unwrap()["enabled"], false);
    assert_eq!(
        hub.link("App", "http://127.0.0.1:9/mcp")
            .await
            .unwrap_err()
            .code,
        "hub_disabled"
    );
    assert_eq!(hub.catalogue().unwrap_err().code, "hub_disabled");
    assert_eq!(
        hub.call("app_missing", json!({"requestId":"one","arguments":{}}))
            .await
            .unwrap_err()
            .code,
        "hub_disabled"
    );
}

#[tokio::test]
async fn upstream_redirects_are_refused_without_following_or_reflecting_tokens() {
    let hub = Hub::new();
    hub.set_enabled(true).unwrap();
    let (target, state, target_task) = fixture("Destination", 0).await;
    let router = Router::new().route(
        "/redirect",
        post(move || {
            let target = target.clone();
            async move { (StatusCode::FOUND, [("location", target)]) }
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint = format!("http://{}/redirect", listener.local_addr().unwrap());
    let redirect_task = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
    let error = hub.link("Redirect", &endpoint).await.unwrap_err();
    assert_eq!(error.code, "hub_connect");
    assert!(!error.message.contains("private-fixture-token"));
    assert_eq!(state.initializations.load(Ordering::SeqCst), 0);
    assert_eq!(hub.status().unwrap()["appCount"], 0);
    assert_eq!(hub.lock().unwrap().pending_links, 0);
    hub.revoke().unwrap();
    redirect_task.abort();
    target_task.abort();
}

#[tokio::test]
async fn a_late_native_link_cannot_prime_a_replaced_gateway_session() {
    let hub = Hub::new();
    hub.set_enabled(true).unwrap();
    let (endpoint, state, server_task) = fixture("Late", 6).await;
    let link_hub = hub.clone();
    let link = tokio::spawn(async move { link_hub.link("Late", &endpoint).await });
    tokio::time::timeout(Duration::from_secs(5), state.started.acquire())
        .await
        .unwrap()
        .unwrap()
        .forget();
    hub.set_enabled(false).unwrap();
    hub.set_enabled(true).unwrap();
    state.finish.add_permits(1);
    assert_eq!(
        tokio::time::timeout(Duration::from_secs(5), link)
            .await
            .unwrap()
            .unwrap()
            .unwrap_err()
            .code,
        "hub_revoked"
    );
    assert_eq!(hub.status().unwrap()["appCount"], 0);
    assert_eq!(state.calls.load(Ordering::SeqCst), 0);
    hub.revoke().unwrap();
    server_task.abort();
}

#[tokio::test]
async fn upstream_instructions_are_frozen_scoped_context_including_failed_apps() {
    let hub = Hub::new();
    hub.set_enabled(true).unwrap();
    let instructions = "Fixture workflow: ask for the current saved state before proposing a change. Custom app System Prompt: preserve the user's terminology.";
    let (endpoint, state, task) =
        fixture_with_instructions("Context", 1, Some(instructions.into())).await;
    let app = hub.link("Context", &endpoint).await.unwrap()["linkedAppId"]
        .as_str()
        .unwrap()
        .to_owned();
    let alias = alias(&hub, &app, "read_state");
    let connected = hub.connected_apps().unwrap();
    assert_eq!(connected[0]["id"], app);
    assert_eq!(connected[0]["label"], "Context");
    assert_eq!(connected[0]["toolCount"], 2);
    assert_eq!(connected[0]["instructions"], instructions);
    assert_eq!(connected[0]["connected"], true);
    assert!(hub.status().unwrap()["apps"][0]
        .get("instructions")
        .is_none());
    assert!(!hub
        .catalogue()
        .unwrap()
        .iter()
        .any(|tool| tool.to_string().contains(instructions)));
    state.mode.store(2, Ordering::SeqCst);
    assert_eq!(
        hub.call(&alias, json!({"requestId":"expired","arguments":{}}))
            .await
            .unwrap_err()
            .code,
        "hub_unknown"
    );
    assert_eq!(hub.connected_apps().unwrap()[0]["connected"], false);
    assert_eq!(
        hub.connected_apps().unwrap()[0]["instructions"],
        instructions
    );
    hub.revoke().unwrap();
    assert!(hub.connected_apps().unwrap().is_empty());
    task.abort();
}

#[tokio::test]
async fn upstream_instruction_limits_reject_instead_of_truncating_per_app_or_aggregate() {
    let hub = Hub::new();
    hub.set_enabled(true).unwrap();
    let (oversized, state, oversized_task) = fixture_with_instructions(
        "Oversized context",
        0,
        Some("x".repeat(MAX_APP_INSTRUCTIONS + 1)),
    )
    .await;
    assert_eq!(
        hub.link("Oversized context", &oversized)
            .await
            .unwrap_err()
            .code,
        "hub_limit"
    );
    assert_eq!(hub.status().unwrap()["appCount"], 0);
    assert_eq!(state.listings.load(Ordering::SeqCst), 0);
    let mut tasks = vec![oversized_task];
    let instructions = "\0".repeat(MAX_APP_INSTRUCTIONS);
    for index in 0..3 {
        let label = format!("Bounded context {index}");
        let (endpoint, _, task) =
            fixture_with_instructions(&label, 0, Some(instructions.clone())).await;
        tasks.push(task);
        let result = hub.link(&label, &endpoint).await;
        if index < 2 {
            result.unwrap();
        } else {
            assert_eq!(result.unwrap_err().code, "hub_limit");
        }
    }
    assert_eq!(hub.status().unwrap()["appCount"], 2);
    let connected = hub.connected_apps().unwrap();
    assert!(connected
        .iter()
        .all(|app| app["instructions"].as_str().unwrap().len() == MAX_APP_INSTRUCTIONS));
    assert!(serde_json::to_vec(&connected).unwrap().len() < MAX_RESULT);
    hub.revoke().unwrap();
    for task in tasks {
        task.abort();
    }
}

#[tokio::test]
async fn frozen_paginated_catalogues_route_distinct_aliases_and_cache_original_results() {
    let hub = Hub::new();
    hub.set_enabled(true).unwrap();
    let (first_url, first, first_task) = fixture("First", 0).await;
    let (second_url, second, second_task) = fixture("Second", 1).await;
    let first_id = hub.link("First", &first_url).await.unwrap()["linkedAppId"]
        .as_str()
        .unwrap()
        .to_owned();
    let second_id = hub.link("Second", &second_url).await.unwrap()["linkedAppId"]
        .as_str()
        .unwrap()
        .to_owned();
    assert_eq!(first.listings.load(Ordering::SeqCst), 2);
    assert_eq!(second.listings.load(Ordering::SeqCst), 2);
    let catalogue = hub.catalogue().unwrap();
    assert!(hub
        .connected_apps()
        .unwrap()
        .iter()
        .all(|app| app.get("instructions").is_none()));
    assert_eq!(catalogue.len(), 4);
    let names: HashSet<_> = catalogue
        .iter()
        .map(|tool| tool["name"].as_str().unwrap())
        .collect();
    assert_eq!(names.len(), 4);
    assert!(names.iter().all(|name| name.len() <= 64));
    assert!(!hub
        .status()
        .unwrap()
        .to_string()
        .contains("private-fixture-token"));
    assert!(!catalogue
        .iter()
        .any(|tool| tool.to_string().contains("private-fixture-token")));
    let set = catalogue
        .iter()
        .find(|tool| tool["_meta"]["undertree/toolName"] == "set_state")
        .unwrap();
    assert_eq!(
        set["inputSchema"]["properties"]["arguments"]["$defs"]["state"]["type"],
        "string"
    );
    assert_eq!(
        set["inputSchema"]["properties"]["arguments"]["properties"]["state"]["$ref"],
        "#/$defs/state"
    );
    assert!(set["inputSchema"]["properties"]["arguments"]["$id"]
        .as_str()
        .unwrap()
        .starts_with("urn:undertree:app:"));
    assert_eq!(set["_meta"]["fixture"], "preserved");
    assert_eq!(set["outputSchema"], json!({"type":"object"}));
    let read = catalogue
        .iter()
        .find(|tool| tool["_meta"]["undertree/toolName"] == "read_state")
        .unwrap();
    assert_eq!(
        read["inputSchema"]["properties"]["arguments"]["$id"],
        "urn:fixture:original"
    );
    assert_eq!(read["annotations"]["readOnlyHint"], true);
    let first_alias = alias(&hub, &first_id, "set_state");
    let input = json!({"requestId":"first-write","arguments":{"state":"saved"}});
    let result = hub.call(&first_alias, input.clone()).await.unwrap();
    assert_eq!(
        result["structuredContent"],
        json!({"app":"First","name":"set_state","arguments":{"state":"saved"}})
    );
    assert_eq!(result["_meta"]["fixture"], "result-preserved");
    assert_eq!(hub.call(&first_alias, input).await.unwrap(), result);
    assert_eq!(first.calls.load(Ordering::SeqCst), 1);
    assert_eq!(
        hub.call(
            &first_alias,
            json!({"requestId":"first-write","arguments":{"state":"different"}})
        )
        .await
        .unwrap_err()
        .code,
        "hub_duplicate"
    );
    assert_eq!(first.calls.load(Ordering::SeqCst), 1);
    let second_alias = alias(&hub, &second_id, "read_state");
    assert_eq!(
        hub.call(
            &second_alias,
            json!({"requestId":"second-read","arguments":{}})
        )
        .await
        .unwrap()["structuredContent"]["app"],
        "Second"
    );
    assert_eq!(second.calls.load(Ordering::SeqCst), 1);
    assert_eq!(first.listings.load(Ordering::SeqCst), 2);
    hub.revoke().unwrap();
    first_task.abort();
    second_task.abort();
}

#[tokio::test]
async fn tool_list_change_on_stateful_sse_revokes_frozen_aliases_and_late_results() {
    let hub = Hub::new();
    hub.set_enabled(true).unwrap();
    let (endpoint, state, task) = fixture("Changing", 1).await;
    let app = hub.link("Changing", &endpoint).await.unwrap()["linkedAppId"]
        .as_str()
        .unwrap()
        .to_owned();
    let alias = alias(&hub, &app, "read_state");
    let previous = json!({"requestId":"previous","arguments":{}});
    hub.call(&alias, previous.clone()).await.unwrap();
    let generation = hub.generation().unwrap();
    state.mode.store(7, Ordering::SeqCst);
    let call_hub = hub.clone();
    let call_alias = alias.clone();
    let call = tokio::spawn(async move {
        call_hub
            .call(&call_alias, json!({"requestId":"changing","arguments":{}}))
            .await
    });
    wait_for_catalogue_change(&hub, &app).await;
    assert!(hub.catalogue().unwrap().is_empty());
    assert_eq!(hub.status().unwrap()["apps"][0]["connected"], false);
    assert_eq!(
        hub.check_generation(generation).unwrap_err().code,
        "hub_revoked"
    );
    assert_eq!(
        hub.call(&alias, previous).await.unwrap_err().code,
        "hub_relink"
    );
    assert_eq!(
        hub.call(&alias, json!({"requestId":"new","arguments":{}}))
            .await
            .unwrap_err()
            .code,
        "hub_relink"
    );
    state.finish.add_permits(1);
    assert_eq!(
        tokio::time::timeout(Duration::from_secs(5), call)
            .await
            .unwrap()
            .unwrap()
            .unwrap_err()
            .code,
        "hub_revoked"
    );
    assert_eq!(state.calls.load(Ordering::SeqCst), 2);
    assert_eq!(state.initializations.load(Ordering::SeqCst), 1);
    assert_eq!(state.listings.load(Ordering::SeqCst), 2);
    hub.revoke().unwrap();
    task.abort();
}

#[tokio::test]
async fn idle_stateful_sse_tool_list_changes_require_explicit_local_relink() {
    let hub = Hub::new();
    hub.set_enabled(true).unwrap();
    let (endpoint, state, task) = fixture("Idle changing", 8).await;
    let app = hub.link("Idle changing", &endpoint).await.unwrap()["linkedAppId"]
        .as_str()
        .unwrap()
        .to_owned();
    let alias = alias(&hub, &app, "set_state");
    tokio::time::timeout(Duration::from_secs(5), state.started.acquire())
        .await
        .unwrap()
        .unwrap()
        .forget();
    state.finish.add_permits(1);
    wait_for_catalogue_change(&hub, &app).await;
    assert!(hub.catalogue().unwrap().is_empty());
    assert_eq!(
        hub.call(
            &alias,
            json!({"requestId":"blocked","arguments":{"state":"new"}})
        )
        .await
        .unwrap_err()
        .code,
        "hub_relink"
    );
    assert_eq!(state.calls.load(Ordering::SeqCst), 0);
    assert_eq!(state.initializations.load(Ordering::SeqCst), 1);
    assert_eq!(state.listings.load(Ordering::SeqCst), 2);
    hub.revoke().unwrap();
    task.abort();
}

#[tokio::test]
async fn session_expiry_is_not_reinitialized_or_replayed_and_errors_are_cached() {
    let hub = Hub::new();
    hub.set_enabled(true).unwrap();
    let (endpoint, state, task) = fixture("Expired", 0).await;
    let app = hub.link("Expired", &endpoint).await.unwrap()["linkedAppId"]
        .as_str()
        .unwrap()
        .to_owned();
    let alias = alias(&hub, &app, "set_state");
    state.mode.store(2, Ordering::SeqCst);
    let input = json!({"requestId":"uncertain","arguments":{"state":"changed"}});
    assert_eq!(
        hub.call(&alias, input.clone()).await.unwrap_err().code,
        "hub_unknown"
    );
    assert_eq!(
        hub.call(&alias, input).await.unwrap_err().code,
        "hub_unknown"
    );
    assert_eq!(state.calls.load(Ordering::SeqCst), 1);
    assert_eq!(state.initializations.load(Ordering::SeqCst), 1);
    assert_eq!(
        hub.call(&alias, json!({"requestId":"new","arguments":{}}))
            .await
            .unwrap_err()
            .code,
        "hub_relink"
    );
    assert_eq!(state.calls.load(Ordering::SeqCst), 1);
    hub.revoke().unwrap();
    task.abort();
}

#[tokio::test]
async fn revocation_discards_late_results_and_clears_all_session_links() {
    let hub = Hub::new();
    hub.set_enabled(true).unwrap();
    let (endpoint, state, task) = fixture("Blocked", 0).await;
    let app = hub.link("Blocked", &endpoint).await.unwrap()["linkedAppId"]
        .as_str()
        .unwrap()
        .to_owned();
    let alias = alias(&hub, &app, "set_state");
    state.mode.store(3, Ordering::SeqCst);
    let call_hub = hub.clone();
    let call_alias = alias.clone();
    let call = tokio::spawn(async move {
        call_hub
            .call(
                &call_alias,
                json!({"requestId":"blocked","arguments":{"state":"changed"}}),
            )
            .await
    });
    tokio::time::timeout(Duration::from_secs(5), state.started.acquire())
        .await
        .unwrap()
        .unwrap()
        .forget();
    let generation = hub.generation().unwrap();
    assert_eq!(
        hub.call(
            &alias,
            json!({"requestId":"blocked","arguments":{"state":"changed"}})
        )
        .await
        .unwrap_err()
        .code,
        "hub_inflight"
    );
    hub.set_enabled(false).unwrap();
    state.finish.add_permits(1);
    assert_eq!(
        tokio::time::timeout(Duration::from_secs(5), call)
            .await
            .unwrap()
            .unwrap()
            .unwrap_err()
            .code,
        "hub_revoked"
    );
    assert_eq!(
        hub.check_generation(generation).unwrap_err().code,
        "hub_revoked"
    );
    assert_eq!(hub.status().unwrap()["appCount"], 0);
    assert_eq!(hub.status().unwrap()["callCount"], 0);
    hub.set_enabled(true).unwrap();
    assert!(hub.catalogue().unwrap().is_empty());
    assert_eq!(
        hub.call(
            &alias,
            json!({"requestId":"blocked","arguments":{"state":"changed"}})
        )
        .await
        .unwrap_err()
        .code,
        "hub_tool"
    );
    assert_eq!(state.calls.load(Ordering::SeqCst), 1);
    hub.revoke().unwrap();
    task.abort();
}

#[tokio::test]
async fn oversized_and_http_error_bodies_are_bounded_and_never_exposed_or_replayed() {
    for mode in [4, 5] {
        let hub = Hub::new();
        hub.set_enabled(true).unwrap();
        let (endpoint, state, task) = fixture("Error", 0).await;
        let app = hub.link("Error", &endpoint).await.unwrap()["linkedAppId"]
            .as_str()
            .unwrap()
            .to_owned();
        let alias = alias(&hub, &app, "read_state");
        state.mode.store(mode, Ordering::SeqCst);
        let input = json!({"requestId":"error","arguments":{}});
        let error = hub.call(&alias, input.clone()).await.unwrap_err();
        assert_eq!(error.code, "hub_unknown");
        assert!(!error.message.contains("private-token"));
        assert!(!error.message.contains("private.invalid"));
        assert!(!error.message.contains("oversized-private-token"));
        assert_eq!(
            hub.call(&alias, input).await.unwrap_err().code,
            "hub_unknown"
        );
        assert_eq!(state.calls.load(Ordering::SeqCst), 1);
        hub.revoke().unwrap();
        task.abort();
    }
}

#[tokio::test]
async fn call_limits_reject_before_dispatch_without_evicting_previous_requests() {
    let hub = Hub::new();
    hub.set_enabled(true).unwrap();
    let (endpoint, fixture, task) = fixture("Limited", 0).await;
    let app = hub.link("Limited", &endpoint).await.unwrap()["linkedAppId"]
        .as_str()
        .unwrap()
        .to_owned();
    let alias = alias(&hub, &app, "read_state");
    {
        let mut state = hub.lock().unwrap();
        state.reserved_bytes = MAX_CACHED_RESULTS;
    }
    assert_eq!(
        hub.call(&alias, json!({"requestId":"limited","arguments":{}}))
            .await
            .unwrap_err()
            .code,
        "hub_limit"
    );
    {
        let mut state = hub.lock().unwrap();
        state.reserved_bytes = 0;
        let generation = state.generation;
        for index in 0..MAX_CALLS {
            state.calls.insert(
                format!("cached-{index}"),
                CachedCall {
                    fingerprint: "retained".into(),
                    generation,
                    outcome: Some(Err(unknown_outcome())),
                },
            );
        }
    }
    assert_eq!(
        hub.call(&alias, json!({"requestId":"limited","arguments":{}}))
            .await
            .unwrap_err()
            .code,
        "hub_limit"
    );
    assert_eq!(hub.status().unwrap()["callCount"], MAX_CALLS);
    assert_eq!(fixture.calls.load(Ordering::SeqCst), 0);
    hub.revoke().unwrap();
    task.abort();
}
