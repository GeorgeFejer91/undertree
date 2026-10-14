use std::path::PathBuf;
use undertree_review::{Operation, Result};

#[tokio::main]
async fn main() -> Result<()> {
    let args: Vec<_> = std::env::args().skip(1).collect();
    if args.first().map(String::as_str) == Some("call") {
        let endpoint = std::env::var("UNDERTREE_REVIEW_ENDPOINT")
            .unwrap_or_else(|_| "http://127.0.0.1:37372/api/review".into());
        let parsed = endpoint.parse::<axum::http::Uri>().map_err(|_| {
            undertree_review::Error::new(
                "endpoint",
                "The local CLI accepts a loopback endpoint only.",
            )
        })?;
        if endpoint.contains('#')
            || parsed.scheme_str() != Some("http")
            || parsed.host() != Some("127.0.0.1")
            || parsed.port_u16().is_none()
            || parsed.path() != "/api/review"
            || parsed.query().is_some()
            || parsed
                .authority()
                .is_some_and(|authority| authority.as_str().contains('@'))
        {
            return Err(undertree_review::Error::new(
                "endpoint",
                "The local CLI accepts a loopback review endpoint only.",
            ));
        }
        let token = std::env::var("UNDERTREE_REVIEW_TOKEN").map_err(|_| {
            undertree_review::Error::new(
                "token",
                "Set UNDERTREE_REVIEW_TOKEN for the running local service.",
            )
        })?;
        if token.len() < 32
            || token.len() > 256
            || !token
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || b"-_".contains(&byte))
        {
            return Err(undertree_review::Error::new(
                "token",
                "Use a random session token of 32 to 256 letters, digits, hyphens or underscores.",
            ));
        }
        let request = args.get(1).ok_or_else(|| {
            undertree_review::Error::new("request", "Supply a JSON product operation.")
        })?;
        let _: Operation = serde_json::from_str(request)?;
        let mut child = tokio::process::Command::new("curl")
            .args([
                "--silent",
                "--show-error",
                "--fail-with-body",
                "--max-time",
                "35",
                "--proxy",
                "",
                "--proto",
                "=http",
                "--config",
                "-",
            ])
            .stdin(std::process::Stdio::piped())
            .kill_on_drop(true)
            .spawn()?;
        use tokio::io::AsyncWriteExt;
        let config = format!("url = {}\nheader = {}\nheader = \"Content-Type: application/json\"\nrequest = \"POST\"\ndata = {}\n",serde_json::to_string(&endpoint)?,serde_json::to_string(&format!("Authorization: Bearer {token}"))?,serde_json::to_string(request)?);
        if let Some(mut stdin) = child.stdin.take() {
            stdin.write_all(config.as_bytes()).await?;
        }
        if !tokio::time::timeout(std::time::Duration::from_secs(40), child.wait())
            .await
            .map_err(|_| undertree_review::Error::new("timeout", "The local request timed out."))??
            .success()
        {
            return Err(undertree_review::Error::new(
                "connection",
                "The local service did not respond.",
            ));
        }
        return Ok(());
    }
    let state = std::env::var_os("UNDERTREE_REVIEW_STATE")
        .map(PathBuf::from)
        .unwrap_or_else(|| std::env::temp_dir().join("undertree-review"));
    let token = std::env::var("UNDERTREE_REVIEW_TOKEN").map_err(|_| {
        undertree_review::Error::new(
            "token",
            "Set a random UNDERTREE_REVIEW_TOKEN to run the browser test adapter.",
        )
    })?;
    if token.len() < 32
        || token.len() > 256
        || !token
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"-_".contains(&byte))
    {
        return Err(undertree_review::Error::new(
            "token",
            "Use a random session token of 32 to 256 letters, digits, hyphens or underscores.",
        ));
    }
    let port = std::env::var("UNDERTREE_REVIEW_PORT")
        .unwrap_or_else(|_| "37372".into())
        .parse::<u16>()
        .map_err(|_| undertree_review::Error::new("port", "Invalid loopback port."))?;
    let assets = std::env::var_os("UNDERTREE_REVIEW_ASSETS")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("dist"));
    let service = undertree_review::service::Service::new(state)?;
    let listener = tokio::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, port)).await?;
    println!(
        "UnderTree native review adapter listening on 127.0.0.1:{}",
        listener.local_addr()?.port()
    );
    let shutdown_service = service.clone();
    axum::serve(
        listener,
        undertree_review::transport::local_router(service, token, assets),
    )
    .with_graceful_shutdown(async move {
        let _ = tokio::signal::ctrl_c().await;
        let _ = undertree_review::transport::tunnel(
            &shutdown_service,
            false,
            String::new(),
            String::new(),
        )
        .await;
    })
    .await?;
    Ok(())
}
