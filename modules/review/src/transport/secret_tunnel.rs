//! Explicit native launch intent, never an IPC, CLI or remote operation.
use super::{connector, gateway, start_tunnel};
use crate::service::Service;
use crate::{Error, Result};
use serde_json::Value;
use std::ffi::OsString;
use std::sync::Arc;
use std::time::Duration;
use uuid::Uuid;

const BACKEND: &str = "http://127.0.0.1:8792";
const FLAG: &str = "--connect-secret-tunnel";

fn unavailable() -> Error {
    Error::new("secret_tunnel_startup", "Secret Tunnel could not be connected. Start its local backend, import its connection profile, and retry the explicit connection launch. Any new UnderTree connection was stopped; existing connections were preserved.")
}

fn requested(args: &[OsString]) -> Result<bool> {
    match args {
        [] => Ok(false),
        [flag] if flag == FLAG => Ok(true),
        _ => Err(Error::new(
            "startup_arguments",
            "Use no launch arguments, or only --connect-secret-tunnel.",
        )),
    }
}

/// Called only by the trusted desktop setup, before renderer IPC is available.
/// Consent and links last for this process; no shares or App controls are granted.
pub async fn connect_secret_tunnel_on_startup(
    service: &Arc<Service>,
    args: &[OsString],
) -> Result<()> {
    if !requested(args)? {
        return Ok(());
    }
    connect(service).await.map_err(|_| unavailable())
}

async fn connect(service: &Arc<Service>) -> Result<()> {
    // Refuse even a retained dead session; this action never replaces existing state.
    if service.tunnel.lock().await.is_some() {
        return Err(unavailable());
    }
    let settings = service.connection_settings()?;
    let state = service.state_dir().to_owned();
    let imported_settings = settings.clone();
    let imported = tokio::task::spawn_blocking(move || connector::load(&state, &imported_settings))
        .await
        .map_err(|_| unavailable())??
        .ok_or_else(unavailable)?;
    if imported.zrok_home.is_none() {
        return Err(unavailable());
    }
    verify_backend(BACKEND).await?;
    start_tunnel(
        service,
        true,
        settings.reservation,
        settings.public_url,
        true,
    )
    .await?;
    let (session_id, secret) = {
        let current = service.tunnel.lock().await;
        let active = current.as_ref().ok_or_else(unavailable)?;
        (active.session_id, active.secret.clone())
    };
    // Bind routing and cleanup to the actual child after the second import validation.
    let endpoint = format!("{BACKEND}/t/{secret}/mcp");
    finish_connection(service, session_id, &secret, &endpoint).await
}

async fn verify_backend(origin: &str) -> Result<()> {
    let client = reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .retry(reqwest::retry::never())
        .timeout(Duration::from_secs(5))
        .build()
        .map_err(|_| unavailable())?;
    let mut response = client
        .get(format!("{origin}/health"))
        .send()
        .await
        .map_err(|_| unavailable())?;
    if !response.status().is_success() {
        return Err(unavailable());
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| unavailable())? {
        if bytes.len() + chunk.len() > 1024 {
            return Err(unavailable());
        }
        bytes.extend_from_slice(&chunk);
    }
    let health: Value = serde_json::from_slice(&bytes).map_err(|_| unavailable())?;
    if health["ok"] != true || health["name"] != "secret-tunnel-v6-mcp" {
        return Err(unavailable());
    }
    Ok(())
}

async fn finish_connection(
    service: &Arc<Service>,
    session_id: Uuid,
    secret: &str,
    endpoint: &str,
) -> Result<()> {
    let result = async {
        gateway::gateway_enable(service, true).await?;
        let linked = gateway::gateway_link(service, "Secret Tunnel", endpoint).await?;
        if linked["enabled"] != true
            || !linked["apps"].as_array().is_some_and(|apps| {
                apps.iter()
                    .any(|app| app["label"] == "Secret Tunnel" && app["connected"] == true)
            })
        {
            return Err(unavailable());
        }
        Ok(())
    }
    .await;
    if result.is_err() {
        rollback(service, session_id, secret).await?;
    }
    result
}

async fn rollback(service: &Arc<Service>, session_id: Uuid, secret: &str) -> Result<()> {
    let mut current = service.tunnel.lock().await;
    if !current
        .as_ref()
        .is_some_and(|active| active.session_id == session_id && active.secret == secret)
    {
        return Ok(());
    }
    // Revoke under the same ownership lock. Never stop a replacement session.
    super::retire_tunnel(service, &mut current, false).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{
        http::StatusCode,
        response::IntoResponse,
        routing::{get, post},
        Json, Router,
    };
    use serde_json::json;

    fn empty_service() -> (tempfile::TempDir, Arc<Service>) {
        let state = tempfile::tempdir().unwrap();
        let service = Service::new(state.path().to_owned()).unwrap();
        (state, service)
    }

    fn assert_no_grants(service: &Service) {
        assert!(service.shared.lock().unwrap().is_empty());
        assert_eq!(service.app_control_status().unwrap()["enabled"], false);
    }

    async fn backend(health: Value, successful_mcp: bool) -> (String, tokio::task::JoinHandle<()>) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let router = Router::new()
            .route("/health", get(move || { let health = health.clone(); async { Json(health) } }))
            .route("/t/existing_private_token/mcp", post(move |Json(request): Json<Value>| async move {
                if !successful_mcp { return StatusCode::SERVICE_UNAVAILABLE.into_response(); }
                let result = match request["method"].as_str().unwrap_or("") {
                    "initialize" => json!({"protocolVersion":"2025-06-18","capabilities":{"tools":{}},"serverInfo":{"name":"secret-tunnel-v6-mcp","version":"1"}}),
                    "notifications/initialized" => return StatusCode::ACCEPTED.into_response(),
                    "tools/list" => json!({"tools":[{"name":"secret_tunnel_status","inputSchema":{"type":"object"}}]}),
                    _ => return StatusCode::BAD_REQUEST.into_response(),
                };
                Json(json!({"jsonrpc":"2.0","id":request["id"],"result":result})).into_response()
            }));
        let task = tokio::spawn(async move {
            axum::serve(listener, router).await.unwrap();
        });
        (origin, task)
    }

    #[tokio::test]
    async fn ordinary_launch_does_nothing_and_explicit_launch_requires_import() {
        let (_state, service) = empty_service();
        connect_secret_tunnel_on_startup(&service, &[])
            .await
            .unwrap();
        assert!(service.tunnel.lock().await.is_none());
        assert_eq!(service.hub.status().unwrap()["enabled"], false);
        let error = connect_secret_tunnel_on_startup(&service, &[FLAG.into()])
            .await
            .unwrap_err();
        assert_eq!(error.code, "secret_tunnel_startup");
        assert!(service.tunnel.lock().await.is_none());
        assert_no_grants(&service);
    }

    #[tokio::test]
    async fn public_profile_without_dedicated_imported_enrollment_is_refused() {
        let (_state, service) = empty_service();
        service
            .save_connection_settings(
                super::super::validate_settings(
                    "existing-name",
                    "https://existing-name.shares.zrok.io",
                )
                .unwrap(),
            )
            .unwrap();
        let path = service.state_dir().join("secret-tunnel-connector.json");
        std::fs::write(&path, serde_json::to_vec(&json!({"version":1,"reservation":"existing-name","publicUrl":"https://existing-name.shares.zrok.io","publicPathToken":"existing_private_token"})).unwrap()).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600)).unwrap();
        }
        assert_eq!(
            connect_secret_tunnel_on_startup(&service, &[FLAG.into()])
                .await
                .unwrap_err()
                .code,
            "secret_tunnel_startup"
        );
        assert!(service.tunnel.lock().await.is_none());
        assert_eq!(service.hub.status().unwrap()["enabled"], false);
        assert_no_grants(&service);
    }

    #[test]
    fn launch_accepts_only_exact_flag_once_without_values() {
        assert!(requested(&[FLAG.into()]).unwrap());
        for args in [
            vec!["--connect-secret-tunnel=1".into()],
            vec![FLAG.into(), FLAG.into()],
            vec![FLAG.into(), "http://untrusted.example".into()],
        ] {
            assert_eq!(requested(&args).unwrap_err().code, "startup_arguments");
        }
    }

    #[tokio::test]
    async fn startup_refuses_existing_session_without_replacing_or_enabling_it() {
        let (_state, service) = empty_service();
        super::super::tests::imported_fixture(&service).await;
        let id = service.tunnel.lock().await.as_ref().unwrap().session_id;
        assert!(connect_secret_tunnel_on_startup(&service, &[FLAG.into()])
            .await
            .is_err());
        assert_eq!(service.tunnel.lock().await.as_ref().unwrap().session_id, id);
        assert_eq!(service.hub.status().unwrap()["enabled"], false);
        assert_no_grants(&service);
        rollback(&service, id, "existing_private_token")
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn backend_identity_and_size_are_checked_before_connection() {
        for health in [
            json!({"ok":true,"name":"another-server"}),
            json!({"ok":false,"name":"secret-tunnel-v6-mcp"}),
            json!({"ok":true,"name":"secret-tunnel-v6-mcp","oversized":"x".repeat(1025)}),
        ] {
            let (origin, task) = backend(health, false).await;
            assert_eq!(
                verify_backend(&origin).await.unwrap_err().code,
                "secret_tunnel_startup"
            );
            task.abort();
        }
    }

    #[tokio::test]
    async fn known_backend_link_failure_stops_new_child_and_revokes_gateway() {
        let (_state, service) = empty_service();
        let (origin, task) = backend(json!({"ok":true,"name":"secret-tunnel-v6-mcp"}), false).await;
        verify_backend(&origin).await.unwrap();
        super::super::tests::imported_fixture(&service).await;
        let id = service.tunnel.lock().await.as_ref().unwrap().session_id;
        assert!(finish_connection(
            &service,
            id,
            "existing_private_token",
            &format!("{origin}/t/existing_private_token/mcp")
        )
        .await
        .is_err());
        assert!(service.tunnel.lock().await.is_none());
        assert_eq!(service.hub.status().unwrap()["enabled"], false);
        assert_eq!(service.hub.status().unwrap()["appCount"], 0);
        assert_no_grants(&service);
        task.abort();
    }

    #[tokio::test]
    async fn new_child_reaped_before_gateway_enable_is_still_cleaned_up() {
        let (_state, service) = empty_service();
        super::super::tests::imported_fixture(&service).await;
        let id = service.tunnel.lock().await.as_ref().unwrap().session_id;
        {
            let mut current = service.tunnel.lock().await;
            let active = current.as_mut().unwrap();
            active.child.kill().await.unwrap();
            active.child.wait().await.unwrap();
        }
        assert!(finish_connection(
            &service,
            id,
            "existing_private_token",
            "http://127.0.0.1:1/t/existing_private_token/mcp"
        )
        .await
        .is_err());
        assert!(service.tunnel.lock().await.is_none());
        assert_eq!(service.hub.status().unwrap()["enabled"], false);
        assert_no_grants(&service);
    }

    #[tokio::test]
    async fn successful_link_has_no_manuscript_or_app_control_grants() {
        let (_state, service) = empty_service();
        let (origin, task) = backend(json!({"ok":true,"name":"secret-tunnel-v6-mcp"}), true).await;
        verify_backend(&origin).await.unwrap();
        super::super::tests::imported_fixture(&service).await;
        let id = service.tunnel.lock().await.as_ref().unwrap().session_id;
        finish_connection(
            &service,
            id,
            "existing_private_token",
            &format!("{origin}/t/existing_private_token/mcp"),
        )
        .await
        .unwrap();
        let status = gateway::gateway_status(&service).await.unwrap();
        assert_eq!(status["enabled"], true);
        assert_eq!(status["appCount"], 1);
        assert_eq!(status["tools"].as_array().unwrap().len(), 6);
        assert_no_grants(&service);
        rollback(&service, id, "existing_private_token")
            .await
            .unwrap();
        task.abort();
    }

    #[tokio::test]
    async fn rollback_does_not_stop_a_different_session_or_secret() {
        let (_state, service) = empty_service();
        super::super::tests::imported_fixture(&service).await;
        let id = service.tunnel.lock().await.as_ref().unwrap().session_id;
        rollback(&service, Uuid::new_v4(), "existing_private_token")
            .await
            .unwrap();
        rollback(&service, id, "different_private_token")
            .await
            .unwrap();
        let mut active = service.tunnel.lock().await;
        assert!(active.as_mut().unwrap().child.try_wait().unwrap().is_none());
        drop(active);
        rollback(&service, id, "existing_private_token")
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn rollback_preserves_replacement_using_same_imported_secret() {
        let (_state, service) = empty_service();
        super::super::tests::imported_fixture(&service).await;
        let original = service.tunnel.lock().await.as_ref().unwrap().session_id;
        super::super::tests::imported_fixture(&service).await;
        let replacement = service.tunnel.lock().await.as_ref().unwrap().session_id;
        assert_ne!(original, replacement);
        rollback(&service, original, "existing_private_token")
            .await
            .unwrap();
        assert_eq!(
            service.tunnel.lock().await.as_ref().unwrap().session_id,
            replacement
        );
        rollback(&service, replacement, "existing_private_token")
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn actual_start_refuses_missing_import_without_spawning_or_grants() {
        let (_state, service) = empty_service();
        assert_eq!(
            start_tunnel(
                &service,
                true,
                "existing-name".into(),
                "https://existing-name.shares.zrok.io".into(),
                true
            )
            .await
            .unwrap_err()
            .code,
            "connector"
        );
        assert!(service.tunnel.lock().await.is_none());
        assert_eq!(service.hub.status().unwrap()["enabled"], false);
        assert_no_grants(&service);
    }

    #[tokio::test]
    async fn child_dying_during_discovery_is_failure_and_cleans_up() {
        let (_state, service) = empty_service();
        super::super::tests::imported_fixture(&service).await;
        let id = service.tunnel.lock().await.as_ref().unwrap().session_id;
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let endpoint = format!("http://{}/mcp", listener.local_addr().unwrap());
        let exiting = service.clone();
        let router = Router::new().route("/mcp", post(move |Json(request): Json<Value>| {
            let service = exiting.clone();
            async move {
                let result = match request["method"].as_str().unwrap_or("") {
                    "initialize" => json!({"protocolVersion":"2025-06-18","capabilities":{"tools":{}},"serverInfo":{"name":"secret-tunnel-v6-mcp","version":"1"}}),
                    "notifications/initialized" => return StatusCode::ACCEPTED.into_response(),
                    "tools/list" => {
                        let mut current = service.tunnel.lock().await;
                        let active = current.as_mut().unwrap();
                        active.child.kill().await.unwrap();
                        active.child.wait().await.unwrap();
                        json!({"tools":[{"name":"secret_tunnel_status","inputSchema":{"type":"object"}}]})
                    },
                    _ => return StatusCode::BAD_REQUEST.into_response(),
                };
                Json(json!({"jsonrpc":"2.0","id":request["id"],"result":result})).into_response()
            }
        }));
        let task = tokio::spawn(async move {
            axum::serve(listener, router).await.unwrap();
        });
        assert!(
            finish_connection(&service, id, "existing_private_token", &endpoint)
                .await
                .is_err()
        );
        assert!(service.tunnel.lock().await.is_none());
        assert_eq!(service.hub.status().unwrap()["enabled"], false);
        assert_no_grants(&service);
        task.abort();
    }
}
