use std::path::PathBuf;
use undertree_review::{Error, Operation, Result};

const MAX_RESPONSE: u64 = 32 * 1024 * 1024;
const HELP: &str = concat!(
    "UnderTree local manuscript CLI v",
    env!("CARGO_PKG_VERSION"),
    "

Usage: undertree-review <command>

Read commands (JSON results from the running authority):
  capabilities                  Show available actions and access limits
  projects                      List approved projects
  files <project>               List editable project files
  read <project> <path>         Read the saved source and review metadata
  review <project> <path>       Read the saved review context
  connection                    Show connection status
  git-status <project>          Inspect the approved project's Git state
  pdf-info <project> <path>     Show saved PDF metadata without PDF bytes
  save <project> <path>         Save the live editor buffer through its queue
  save-receipt <requestId>      Inspect a durable editor-save result

  help, --help                  Show this help without connecting
  call <json>                   Developer compatibility: typed local operation
  serve                         Start the explicit headless browser adapter

Commands discover the running desktop using UNDERTREE_REVIEW_STATE or its
platform app-data folder. They never start another authority. Explicit legacy
UNDERTREE_REVIEW_ENDPOINT / UNDERTREE_REVIEW_TOKEN configuration is supported.
Save requires an open, responsive editor and accepts no replacement text.
Other discovered CLI mutations remain unavailable; headless save never writes.
Headless serve (also legacy no-argument startup) requires a session token.
"
);

enum CliCommand {
    Help,
    Serve,
    Request { json: String, metadata_only: bool },
}

fn parse_command(args: &[String]) -> Result<CliCommand> {
    let Some(command) = args.first().map(String::as_str) else {
        return Ok(CliCommand::Serve);
    };
    let (arity, usage) = match command {
        "help" | "--help" | "serve" | "capabilities" | "projects" | "connection" => (0, command),
        "files" => (1, "files <project>"),
        "git-status" => (1, "git-status <project>"),
        "read" => (2, "read <project> <path>"),
        "review" => (2, "review <project> <path>"),
        "pdf-info" => (2, "pdf-info <project> <path>"),
        "save" => (2, "save <project> <path>"),
        "save-receipt" => (1, "save-receipt <requestId>"),
        "call" => (1, "call <json>"),
        _ => {
            return Err(Error::new(
                "command",
                "Unknown command. Run undertree-review --help for supported local commands.",
            ))
        }
    };
    if args.len() != arity + 1 {
        return Err(Error::new(
            "arguments",
            if arity == 0 {
                format!("The {command} command takes no arguments.")
            } else {
                format!("Usage: undertree-review {usage}")
            },
        ));
    }
    match command {
        "help" | "--help" => return Ok(CliCommand::Help),
        "serve" => return Ok(CliCommand::Serve),
        "call" => {
            let _: Operation = serde_json::from_str(&args[1])?;
            return Ok(CliCommand::Request {
                json: args[1].clone(),
                metadata_only: false,
            });
        }
        _ => (),
    }
    use serde_json::json;
    let request = match command {
        "capabilities" | "projects" | "connection" => json!({"action": command}),
        "files" => json!({"action":"files","project":args[1]}),
        "git-status" => json!({"action":"git_status","project":args[1]}),
        "read" => json!({"action":"open","project":args[1],"path":args[2]}),
        "review" => json!({"action":"review","project":args[1],"path":args[2]}),
        "pdf-info" => json!({"action":"pdf","project":args[1],"path":args[2]}),
        "save" => {
            json!({"action":"save_editor","project":args[1],"path":args[2],"requestId":uuid::Uuid::new_v4().to_string()})
        }
        "save-receipt" => {
            if uuid::Uuid::parse_str(&args[1]).is_err() {
                return Err(Error::new(
                    "arguments",
                    "Use the UUID requestId printed by a save result.",
                ));
            }
            json!({"action":"save_receipt","requestId":args[1]})
        }
        _ => return Err(Error::new("command", "Unsupported local command.")),
    };
    Ok(CliCommand::Request {
        json: request.to_string(),
        metadata_only: command == "pdf-info",
    })
}

#[tokio::main]
async fn main() -> Result<()> {
    let args: Vec<_> = std::env::args().skip(1).collect();
    match parse_command(&args)? {
        CliCommand::Help => {
            print!("{HELP}");
            Ok(())
        }
        CliCommand::Request {
            json,
            metadata_only,
        } => {
            let request: serde_json::Value = serde_json::from_str(&json)?;
            if request["action"] == "save_editor" {
                eprintln!("{}", serde_json::json!({"requestId":request["requestId"]}));
            }
            call(&json, metadata_only).await
        }
        CliCommand::Serve => serve().await,
    }
}

async fn call(request: &str, metadata_only: bool) -> Result<()> {
    let discovered = if std::env::var_os("UNDERTREE_REVIEW_ENDPOINT").is_none()
        && std::env::var_os("UNDERTREE_REVIEW_TOKEN").is_none()
    {
        let state = std::env::var_os("UNDERTREE_REVIEW_STATE")
            .map(PathBuf::from)
            .map(Ok)
            .unwrap_or_else(undertree_review::instance::default_state_dir)?;
        Some(undertree_review::instance::LocalConnection::discover(
            &state,
        )?)
    } else {
        None
    };
    let endpoint = discovered
        .as_ref()
        .map(|connection| connection.endpoint().to_owned())
        .unwrap_or_else(|| {
            std::env::var("UNDERTREE_REVIEW_ENDPOINT")
                .unwrap_or_else(|_| "http://127.0.0.1:37372/api/review".into())
        });
    undertree_review::instance::validate_endpoint(&endpoint)?;
    let token = discovered
        .as_ref()
        .map(|connection| connection.token().to_owned())
        .map(Ok)
        .unwrap_or_else(|| std::env::var("UNDERTREE_REVIEW_TOKEN"))
        .map_err(|_| {
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
    let mut child = tokio::process::Command::new("curl")
        .args([
            "--disable",
            "--silent",
            "--show-error",
            "--fail-with-body",
            "--max-time",
            "55",
            "--proxy",
            "",
            "--proto",
            "=http",
            "--config",
            "-",
        ])
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .kill_on_drop(true)
        .spawn()?;
    use tokio::io::AsyncWriteExt;
    let mut config = format!("url = {}\nheader = {}\nheader = \"Content-Type: application/json\"\nheader = \"X-UnderTree-Caller: local_cli\"\nrequest = \"POST\"\ndata = {}\n",serde_json::to_string(&endpoint)?,serde_json::to_string(&format!("Authorization: Bearer {token}"))?,serde_json::to_string(request)?);
    if let Some(connection) = discovered {
        config.push_str(&format!(
            "header = {}\n",
            serde_json::to_string(&format!(
                "X-UnderTree-Instance: {}",
                connection.instance_id()
            ))?
        ));
    }
    if let Some(mut stdin) = child.stdin.take() {
        stdin.write_all(config.as_bytes()).await?;
    }
    use tokio::io::AsyncReadExt;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| Error::new("connection", "The local response stream is unavailable."))?;
    let work = async {
        let mut bytes = Vec::new();
        stdout
            .take(MAX_RESPONSE + 1)
            .read_to_end(&mut bytes)
            .await?;
        if bytes.len() as u64 > MAX_RESPONSE {
            return Err(Error::new(
                "limit",
                "The local response exceeds the 32 MB CLI limit.",
            ));
        }
        Ok((child.wait().await?, bytes))
    };
    let result = tokio::time::timeout(std::time::Duration::from_secs(60), work).await;
    let (status, mut bytes) = match result {
        Ok(Ok(response)) => response,
        result => {
            let _ = child.start_kill();
            let _ = child.wait().await;
            return Err(match result {
                Ok(Err(error)) => error,
                _ => Error::new("timeout", "The local request timed out."),
            });
        }
    };
    if metadata_only {
        let mut response: serde_json::Value = serde_json::from_slice(&bytes)?;
        if let Some(result) = response
            .get_mut("result")
            .and_then(serde_json::Value::as_object_mut)
        {
            result.remove("base64");
        }
        bytes = serde_json::to_vec(&response)?;
    }
    use std::io::Write;
    std::io::stdout().write_all(&bytes)?;
    if !bytes.ends_with(b"\n") {
        std::io::stdout().write_all(b"\n")?;
    }
    let rejected = serde_json::from_slice::<serde_json::Value>(&bytes)
        .ok()
        .is_some_and(|value| {
            matches!(
                value["result"]["status"].as_str(),
                Some("pending" | "rejected")
            )
        });
    if !status.success() || rejected {
        return Err(Error::new(
            "connection",
            "The local service rejected or could not complete this request.",
        ));
    }
    Ok(())
}

async fn serve() -> Result<()> {
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
    let instance = undertree_review::instance::LocalInstance::start(service.clone()).await?;
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
        instance.stop();
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
