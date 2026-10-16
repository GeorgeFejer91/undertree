use super::*;

#[tokio::test]
async fn app_views_are_namespaced_frozen_and_keep_private_metadata_and_visibility() {
    let hub = Hub::new();
    hub.set_enabled(true).unwrap();
    let (endpoint, state, task) = fixture("Secret Tunnel", 9).await;
    let first = hub.link("First", &endpoint).await.unwrap()["linkedAppId"]
        .as_str()
        .unwrap()
        .to_owned();
    let second = hub
        .link("Second", &format!("{endpoint}/second"))
        .await
        .unwrap()["linkedAppId"]
        .as_str()
        .unwrap()
        .to_owned();
    let tools = hub.catalogue().unwrap();
    let first_tool = tools
        .iter()
        .find(|tool| {
            tool["_meta"]["undertree/appId"] == first
                && tool["_meta"]["undertree/toolName"] == "mcp_request_access"
        })
        .unwrap();
    let uri = first_tool["_meta"]["ui"]["resourceUri"].as_str().unwrap();
    assert_eq!(first_tool["_meta"]["ui/resourceUri"], uri);
    assert!(uri.starts_with(&format!("ui://undertree/{first}/")));
    assert_eq!(first_tool["_meta"]["fixture"], "preserved");
    let result = hub.read_ui_resource(uri).unwrap();
    assert_eq!(result["contents"][0]["uri"], uri);
    assert_eq!(
        result["contents"][0]["_meta"]["fixture"],
        "resource-preserved"
    );
    assert_eq!(result["_meta"]["fixture"], "result-resource-preserved");
    assert_eq!(
        result["contents"][0]["_meta"]["ui"]["csp"],
        json!({"connectDomains":[],"resourceDomains":[]})
    );
    let html = result["contents"][0]["text"].as_str().unwrap();
    assert!(html.starts_with("<!doctype html>"));
    for tool_name in ["mcp_chat_decide", "mcp_chat_receipt"] {
        let name = alias(&hub, &first, tool_name);
        assert!(html.contains(&name));
        assert_eq!(
            tools.iter().find(|tool| tool["name"] == name).unwrap()["_meta"]["ui"]["visibility"],
            json!(["app"])
        );
        assert!(!html.contains(&alias(&hub, &second, tool_name)));
    }
    assert_eq!(hub.resource_catalogue().unwrap().len(), 2);
    assert_eq!(state.resource_reads.load(Ordering::SeqCst), 2);
    state.mode.store(10, Ordering::SeqCst);
    assert_eq!(
        hub.read_ui_resource(uri).unwrap(),
        result,
        "Reads serve the frozen link contents, not changed upstream content."
    );
    assert_eq!(state.resource_reads.load(Ordering::SeqCst), 2);
    for forbidden in [
        "ui://secret-tunnel/chat-control-v1.html",
        "file:///private-source",
        "https://private.invalid",
    ] {
        assert_eq!(
            hub.read_ui_resource(forbidden).unwrap_err().code,
            "hub_resource"
        );
    }
    hub.unlink(&first).await.unwrap();
    assert!(hub.read_ui_resource(uri).is_err());
    assert_eq!(hub.resource_catalogue().unwrap().len(), 1);
    hub.set_enabled(false).unwrap();
    assert!(hub.resource_catalogue().is_err());
    task.abort();
}

#[tokio::test]
async fn app_views_reject_oversize_unreferenced_blob_and_non_app_card_controls() {
    for mode in [10, 11, 12, 13, 15, 17] {
        let hub = Hub::new();
        hub.set_enabled(true).unwrap();
        let (endpoint, state, task) = fixture("Unsupported", mode).await;
        let error = hub.link("Unsupported", &endpoint).await.unwrap_err();
        assert_eq!(error.code, "hub_resource", "mode {mode}");
        assert!(!error.message.contains("private-source"));
        assert_eq!(hub.status().unwrap()["appCount"], 0);
        assert!(hub.resource_catalogue().unwrap().is_empty());
        if mode == 12 {
            assert_eq!(state.resource_reads.load(Ordering::SeqCst), 0);
        }
        task.abort();
    }
}

#[tokio::test]
async fn resource_change_notification_revokes_frozen_cards_and_tool_aliases() {
    let hub = Hub::new();
    hub.set_enabled(true).unwrap();
    let (endpoint, state, task) = fixture("Changing", 14).await;
    let app = hub.link("Changing", &endpoint).await.unwrap()["linkedAppId"]
        .as_str()
        .unwrap()
        .to_owned();
    let uri = hub.resource_catalogue().unwrap()[0]["uri"]
        .as_str()
        .unwrap()
        .to_owned();
    let generation = hub.generation().unwrap();
    state.started.acquire().await.unwrap().forget();
    state.finish.add_permits(1);
    wait_for_catalogue_change(&hub, &app).await;
    assert!(hub.check_generation(generation).is_err());
    assert!(hub.catalogue().unwrap().is_empty());
    assert!(hub.resource_catalogue().unwrap().is_empty());
    assert!(hub.read_ui_resource(&uri).is_err());
    task.abort();
}

#[tokio::test]
async fn disabling_during_resource_freeze_cannot_commit_a_late_ui_grant() {
    let hub = Hub::new();
    hub.set_enabled(true).unwrap();
    let (endpoint, state, task) = fixture("Late UI", 16).await;
    let worker = hub.clone();
    let pending = tokio::spawn(async move { worker.link("Late UI", &endpoint).await });
    state.started.acquire().await.unwrap().forget();
    hub.set_enabled(false).unwrap();
    state.finish.add_permits(1);
    assert_eq!(pending.await.unwrap().unwrap_err().code, "hub_revoked");
    assert_eq!(hub.status().unwrap()["appCount"], 0);
    task.abort();
}

#[tokio::test]
async fn frozen_cards_bound_the_aggregate_without_evicting_existing_apps() {
    let hub = Hub::new();
    hub.set_enabled(true).unwrap();
    let (endpoint, state, task) = fixture("Bounded", 9).await;
    let mut count = 0;
    loop {
        match hub.link("Bounded", &format!("{endpoint}/{count}")).await {
            Ok(_) => count += 1,
            Err(error) => {
                assert_eq!(error.code, "hub_limit");
                break;
            }
        }
        assert!(count <= 32);
    }
    assert!(count > 0);
    assert_eq!(hub.resource_catalogue().unwrap().len(), count);
    assert_eq!(hub.status().unwrap()["appCount"], count);
    assert_eq!(state.resource_reads.load(Ordering::SeqCst), count + 1);
    task.abort();
}
