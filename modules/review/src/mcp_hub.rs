use crate::{Error, Result};
use axum::http::{HeaderName, HeaderValue};
use futures_util::StreamExt;
use rmcp::model::{
    CallToolRequestParams, CallToolResponse, ClientConfig, ClientJsonRpcMessage,
    PaginatedRequestParams, ServerJsonRpcMessage,
};
use rmcp::service::{NotificationContext, RunningService};
use rmcp::transport::common::client_side_sse::{BoxedSseResponse, NeverRetry};
use rmcp::transport::streamable_http_client::{
    StreamableHttpClient, StreamableHttpClientTransport, StreamableHttpClientTransportConfig,
    StreamableHttpError, StreamableHttpPostResponse,
};
use rmcp::{ClientHandler, RoleClient, ServiceExt};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::io;
use std::net::IpAddr;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, Weak};
use std::time::Duration;
use tokio::sync::oneshot;
use uuid::Uuid;

const MAX_APPS: usize = 64;
const MAX_TOOLS: usize = 512;
const MAX_CALLS: usize = 128;
const MAX_RESULT: usize = 2 * 1024 * 1024;
const MAX_CACHED_RESULTS: usize = 8 * 1024 * 1024;
const MAX_APP_INSTRUCTIONS: usize = 128 * 1024;
const MAX_WIRE_RESPONSE: usize = MAX_RESULT + 64 * 1024;
const LINK_TIMEOUT: Duration = Duration::from_secs(30);
const CALL_TIMEOUT: Duration = Duration::from_secs(60);

type Upstream = RunningService<RoleClient, UpstreamHandler>;

struct UpstreamHandler {
    invalidated: Arc<AtomicBool>,
    state: Weak<Mutex<HubState>>,
    app_id: String,
}

impl ClientHandler for UpstreamHandler {
    fn get_info(&self) -> ClientConfig {
        ClientConfig::default()
    }

    async fn on_tool_list_changed(&self, _context: NotificationContext<RoleClient>) {
        if self.invalidated.swap(true, Ordering::AcqRel) {
            return;
        }
        let Some(state) = self.state.upgrade() else {
            return;
        };
        let Ok(mut state) = state.lock() else {
            return;
        };
        if let Some(app) = state.apps.get_mut(&self.app_id) {
            app.failed = true;
            if bump_generation(&mut state).is_err() {
                state.enabled = false;
            }
        }
    }
}

fn catalogue_changed(client: &Upstream) -> bool {
    client.service().invalidated.load(Ordering::Acquire)
}

#[derive(Clone, Default)]
pub struct Hub {
    state: Arc<Mutex<HubState>>,
}

#[derive(Default)]
struct HubState {
    enabled: bool,
    generation: u64,
    apps: BTreeMap<String, LinkedApp>,
    pending_links: usize,
    calls: HashMap<String, CachedCall>,
    cached_bytes: usize,
    reserved_bytes: usize,
}

struct LinkedApp {
    id: String,
    label: String,
    endpoint: String,
    client: Arc<Upstream>,
    tools: Vec<FrozenTool>,
    instructions: Option<String>,
    failed: bool,
}

fn instructions_size(instructions: &Option<String>) -> usize {
    instructions
        .as_ref()
        .map_or(0, |instructions| json!(instructions).to_string().len())
}

struct FrozenTool {
    alias: String,
    upstream_name: String,
    catalogue: Value,
}

struct CachedCall {
    fingerprint: String,
    generation: u64,
    outcome: Option<Result<Value>>,
}

struct LinkAttempt {
    state: Arc<Mutex<HubState>>,
}

impl Drop for LinkAttempt {
    fn drop(&mut self) {
        if let Ok(mut state) = self.state.lock() {
            state.pending_links = state.pending_links.saturating_sub(1);
        }
    }
}

fn unavailable() -> Error {
    Error::new("hub", "The gateway is temporarily unavailable.")
}

fn revoked() -> Error {
    Error::new(
        "hub_revoked",
        "Gateway access changed. Refresh the connection before continuing. A call already sent may have completed.",
    )
}

fn unknown_outcome() -> Error {
    Error::new(
        "hub_unknown",
        "The upstream outcome is unknown. This request will not be sent again. Inspect the target app locally before issuing a new request.",
    )
}

fn validate_endpoint(endpoint: &str) -> Result<()> {
    let invalid = || {
        Error::new(
            "hub_endpoint",
            "Use an exact HTTPS endpoint or HTTP endpoint with a literal loopback IP, without credentials, query, fragment, or whitespace.",
        )
    };
    if endpoint.is_empty()
        || endpoint.len() > 4096
        || endpoint.contains(['?', '#', '\\'])
        || endpoint
            .chars()
            .any(|character| character.is_control() || character.is_whitespace())
    {
        return Err(invalid());
    }
    let uri: axum::http::Uri = endpoint.parse().map_err(|_| invalid())?;
    let parsed = reqwest::Url::parse(endpoint).map_err(|_| invalid())?;
    let authority = uri.authority().ok_or_else(invalid)?;
    let host = uri.host().ok_or_else(invalid)?;
    if authority.as_str().contains('@')
        || !parsed.username().is_empty()
        || parsed.password().is_some()
        || parsed.query().is_some()
        || parsed.fragment().is_some()
        || parsed.host_str().is_none()
    {
        return Err(invalid());
    }
    match uri.scheme_str() {
        Some("https") => Ok(()),
        Some("http") => host
            .trim_start_matches('[')
            .trim_end_matches(']')
            .parse::<IpAddr>()
            .ok()
            .filter(IpAddr::is_loopback)
            .map(|_| ())
            .ok_or_else(invalid),
        _ => Err(invalid()),
    }
}

fn bump_generation(state: &mut HubState) -> Result<()> {
    state.generation = state.generation.checked_add(1).ok_or_else(unavailable)?;
    Ok(())
}

fn snapshot(state: &HubState) -> Value {
    json!({
        "enabled": state.enabled,
        "generation": state.generation,
        "apps": state.apps.values().map(|app| json!({
            "id": app.id,
            "label": app.label,
            "toolCount": app.tools.len(),
            "connected": !app.failed && !app.client.is_closed() && !catalogue_changed(&app.client),
        })).collect::<Vec<_>>(),
        "appCount": state.apps.len(),
        "toolCount": state.apps.values().map(|app| app.tools.len()).sum::<usize>(),
        "callCount": state.calls.len(),
    })
}

impl Hub {
    pub fn new() -> Self {
        Self::default()
    }

    fn lock(&self) -> Result<MutexGuard<'_, HubState>> {
        self.state.lock().map_err(|_| unavailable())
    }

    pub fn status(&self) -> Result<Value> {
        let state = self.lock()?;
        Ok(snapshot(&state))
    }

    pub fn connected_apps(&self) -> Result<Vec<Value>> {
        let state = self.lock()?;
        Ok(state.apps.values().map(|app| {
            let mut description = json!({
                "id":app.id,
                "label":app.label,
                "toolCount":app.tools.len(),
                "connected":!app.failed && !app.client.is_closed() && !catalogue_changed(&app.client),
            });
            if let Some(instructions) = &app.instructions {
                description["instructions"] = json!(instructions);
            }
            description
        }).collect())
    }

    pub fn generation(&self) -> Result<u64> {
        let state = self.lock()?;
        if !state.enabled {
            return Err(Error::new(
                "hub_disabled",
                "Enable the gateway locally first.",
            ));
        }
        Ok(state.generation)
    }

    pub fn check_generation(&self, generation: u64) -> Result<()> {
        let state = self.lock()?;
        if !state.enabled || state.generation != generation {
            return Err(revoked());
        }
        Ok(())
    }

    pub fn set_enabled(&self, enabled: bool) -> Result<Value> {
        let mut state = self.lock()?;
        if !enabled {
            bump_generation(&mut state)?;
            state.enabled = false;
            for app in state.apps.values() {
                app.client.cancellation_token().cancel();
            }
            state.apps.clear();
            state.calls.clear();
            state.cached_bytes = 0;
            state.reserved_bytes = 0;
        } else if !state.enabled {
            bump_generation(&mut state)?;
            state.enabled = true;
        }
        Ok(snapshot(&state))
    }

    pub fn revoke(&self) -> Result<()> {
        self.set_enabled(false).map(|_| ())
    }

    pub async fn link(&self, label: &str, endpoint: &str) -> Result<Value> {
        validate_endpoint(endpoint)?;
        if label.trim().is_empty() || label.len() > 100 || label.chars().any(char::is_control) {
            return Err(Error::new(
                "hub_label",
                "Name the linked app using at most 100 bytes.",
            ));
        }
        let generation = {
            let mut state = self.lock()?;
            if !state.enabled {
                return Err(Error::new(
                    "hub_disabled",
                    "Enable the gateway locally first.",
                ));
            }
            if state.apps.len() + state.pending_links >= MAX_APPS {
                return Err(Error::new(
                    "hub_limit",
                    "The gateway supports at most 64 linked apps.",
                ));
            }
            if state.apps.values().any(|app| app.endpoint == endpoint) {
                return Err(Error::new(
                    "hub_duplicate",
                    "This exact endpoint is already linked.",
                ));
            }
            state.pending_links += 1;
            state.generation
        };
        let _attempt = LinkAttempt {
            state: self.state.clone(),
        };
        let id = Uuid::new_v4().simple().to_string();
        let (client, tools, instructions) = tokio::time::timeout(
            LINK_TIMEOUT,
            connect(endpoint, &id, label, Arc::downgrade(&self.state)),
        )
        .await
        .map_err(|_| Error::new("hub_connect", "The app did not finish connecting in time."))??;
        let mut state = self.lock()?;
        if !state.enabled || state.generation != generation {
            client.cancellation_token().cancel();
            return Err(revoked());
        }
        if catalogue_changed(&client) {
            client.cancellation_token().cancel();
            return Err(Error::new(
                "hub_relink",
                "The upstream catalogue changed. Link this app again locally.",
            ));
        }
        let tool_count: usize = state.apps.values().map(|app| app.tools.len()).sum();
        let catalogue_bytes: usize = state
            .apps
            .values()
            .map(|app| {
                instructions_size(&app.instructions)
                    + app
                        .tools
                        .iter()
                        .map(|tool| tool.catalogue.to_string().len())
                        .sum::<usize>()
            })
            .sum();
        if tool_count + tools.len() > MAX_TOOLS
            || catalogue_bytes
                + instructions_size(&instructions)
                + tools
                    .iter()
                    .map(|tool| tool.catalogue.to_string().len())
                    .sum::<usize>()
                > MAX_RESULT
        {
            client.cancellation_token().cancel();
            return Err(Error::new(
                "hub_limit",
                "The gateway catalogue exceeds 512 tools or 2 MiB of metadata.",
            ));
        }
        bump_generation(&mut state)?;
        state.apps.insert(
            id.clone(),
            LinkedApp {
                id: id.clone(),
                label: label.into(),
                endpoint: endpoint.into(),
                client,
                tools,
                instructions,
                failed: false,
            },
        );
        let mut status = snapshot(&state);
        status["linkedAppId"] = json!(id);
        Ok(status)
    }

    pub async fn unlink(&self, id: &str) -> Result<Value> {
        let mut state = self.lock()?;
        let app = state
            .apps
            .remove(id)
            .ok_or_else(|| Error::new("hub_missing", "This linked app no longer exists."))?;
        bump_generation(&mut state)?;
        app.client.cancellation_token().cancel();
        Ok(snapshot(&state))
    }

    pub fn catalogue(&self) -> Result<Vec<Value>> {
        let state = self.lock()?;
        if !state.enabled {
            return Err(Error::new(
                "hub_disabled",
                "Enable the gateway locally first.",
            ));
        }
        Ok(state
            .apps
            .values()
            .filter(|app| !app.failed && !app.client.is_closed() && !catalogue_changed(&app.client))
            .flat_map(|app| app.tools.iter().map(|tool| tool.catalogue.clone()))
            .collect())
    }

    pub async fn call(&self, alias: &str, input: Value) -> Result<Value> {
        let object = input.as_object().ok_or_else(|| {
            Error::new("hub_arguments", "Supply requestId and an arguments object.")
        })?;
        let request_id = object
            .get("requestId")
            .and_then(Value::as_str)
            .filter(|id| {
                !id.trim().is_empty() && id.len() <= 100 && !id.chars().any(char::is_control)
            })
            .ok_or_else(|| {
                Error::new(
                    "hub_arguments",
                    "Supply a stable requestId of at most 100 bytes.",
                )
            })?;
        let arguments = object
            .get("arguments")
            .and_then(Value::as_object)
            .ok_or_else(|| {
                Error::new(
                    "hub_arguments",
                    "Supply the original tool arguments as an object.",
                )
            })?;
        if object.len() != 2 || serde_json::to_vec(&input)?.len() > MAX_RESULT {
            return Err(Error::new(
                "hub_arguments",
                "Use only requestId and bounded tool arguments.",
            ));
        }
        let fingerprint = format!(
            "{:x}",
            Sha256::digest(serde_json::to_vec(&json!([alias, arguments]))?)
        );
        let (client, upstream_name, app_id, generation) = {
            let mut state = self.lock()?;
            if !state.enabled {
                return Err(Error::new(
                    "hub_disabled",
                    "Enable the gateway locally first.",
                ));
            }
            let (app, tool) = state
                .apps
                .values()
                .find_map(|app| {
                    app.tools
                        .iter()
                        .find(|tool| tool.alias == alias)
                        .map(|tool| (app, tool))
                })
                .ok_or_else(|| Error::new("hub_tool", "Choose a currently linked tool alias."))?;
            if catalogue_changed(&app.client) {
                return Err(Error::new(
                    "hub_relink",
                    "The upstream catalogue changed. Link this app again locally.",
                ));
            }
            if let Some(previous) = state.calls.get(request_id) {
                if previous.fingerprint != fingerprint {
                    return Err(Error::new(
                        "hub_duplicate",
                        "This requestId already identifies a different call.",
                    ));
                }
                if previous.generation != state.generation {
                    return Err(revoked());
                }
                return previous.outcome.clone().unwrap_or_else(|| {
                    Err(Error::new("hub_inflight", "This request is already in flight. Reusing its requestId will never send it again."))
                });
            }
            if app.failed || app.client.is_closed() {
                return Err(Error::new(
                    "hub_relink",
                    "Reconnect this app locally before making more calls.",
                ));
            }
            let dispatch = (
                app.client.clone(),
                tool.upstream_name.clone(),
                app.id.clone(),
                state.generation,
            );
            if state.calls.len() >= MAX_CALLS
                || state.cached_bytes + state.reserved_bytes + MAX_RESULT > MAX_CACHED_RESULTS
            {
                return Err(Error::new("hub_limit", "The gateway call or result-cache limit is full. Calls are not evicted or replayed."));
            }
            let generation = state.generation;
            state.calls.insert(
                request_id.into(),
                CachedCall {
                    fingerprint: fingerprint.clone(),
                    generation,
                    outcome: None,
                },
            );
            state.reserved_bytes += MAX_RESULT;
            dispatch
        };
        let state = self.state.clone();
        let request_id = request_id.to_owned();
        let arguments = arguments.clone();
        let (sender, receiver) = oneshot::channel();
        let result_client = client.clone();
        tokio::spawn(async move {
            let still_current = state.lock().is_ok_and(|state| {
                state.enabled
                    && state.generation == generation
                    && state.apps.contains_key(&app_id)
                    && !catalogue_changed(&client)
            });
            let outcome = if still_current {
                let params = CallToolRequestParams::new(upstream_name).with_arguments(arguments);
                match tokio::time::timeout(CALL_TIMEOUT, client.call_tool_once(params)).await {
                    Ok(Ok(CallToolResponse::Complete(result))) => serde_json::to_value(result)
                        .map_err(|_| unknown_outcome())
                        .and_then(|value| {
                            if value.to_string().len() > MAX_RESULT {
                                Err(Error::new("hub_result_limit", "The upstream result exceeds 2 MiB. This request will not be repeated."))
                            } else {
                                Ok(value)
                            }
                        }),
                    _ => {
                        client.cancellation_token().cancel();
                        if let Ok(mut state) = state.lock() {
                            if let Some(app) = state.apps.get_mut(&app_id) {
                                app.failed = true;
                            }
                        }
                        Err(unknown_outcome())
                    }
                }
            } else {
                Err(revoked())
            };
            let delivered = match state.lock() {
                Ok(mut state) => {
                    let outcome = if !state.enabled
                        || state.generation != generation
                        || catalogue_changed(&client)
                    {
                        Err(revoked())
                    } else {
                        outcome
                    };
                    if state.calls.get(&request_id).is_some_and(|cached| {
                        cached.generation == generation && cached.fingerprint == fingerprint
                    }) {
                        state.reserved_bytes = state.reserved_bytes.saturating_sub(MAX_RESULT);
                        state.cached_bytes += match &outcome {
                            Ok(value) => value.to_string().len(),
                            Err(error) => error.code.len() + error.message.len(),
                        };
                        if let Some(cached) = state.calls.get_mut(&request_id) {
                            cached.outcome = Some(outcome.clone());
                        }
                    }
                    outcome
                }
                Err(_) => Err(unavailable()),
            };
            let _ = sender.send(delivered);
        });
        let outcome = receiver.await.map_err(|_| unknown_outcome())?;
        self.check_generation(generation)?;
        if catalogue_changed(&result_client) {
            return Err(revoked());
        }
        outcome
    }
}

async fn connect(
    endpoint: &str,
    id: &str,
    label: &str,
    state: Weak<Mutex<HubState>>,
) -> Result<(Arc<Upstream>, Vec<FrozenTool>, Option<String>)> {
    let mut builder = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .retry(reqwest::retry::never())
        .connect_timeout(Duration::from_secs(10));
    if reqwest::Url::parse(endpoint).is_ok_and(|endpoint| endpoint.scheme() == "http") {
        builder = builder.no_proxy();
    }
    let client = builder
        .build()
        .map_err(|_| Error::new("hub_connect", "The HTTPS client could not be initialized."))?;
    let mut config = StreamableHttpClientTransportConfig::with_uri(endpoint.to_owned())
        .reinit_on_expired_session(false)
        .max_concurrent_requests(1)
        .max_sse_event_size(MAX_WIRE_RESPONSE);
    config.retry_config = Arc::new(NeverRetry::default());
    config.channel_buffer_capacity = 8;
    let transport = StreamableHttpClientTransport::with_client(BoundedHttp { client }, config);
    let handler = UpstreamHandler {
        invalidated: Arc::new(AtomicBool::new(false)),
        state,
        app_id: id.into(),
    };
    let client = Arc::new(handler.serve(transport).await.map_err(|_| {
        Error::new(
            "hub_connect",
            "The upstream MCP handshake failed. Check the endpoint and its local permissions.",
        )
    })?);
    let instructions = client
        .peer_info()
        .and_then(|info| info.instructions.clone());
    if instructions
        .as_ref()
        .is_some_and(|instructions| instructions.len() > MAX_APP_INSTRUCTIONS)
    {
        return Err(Error::new(
            "hub_limit",
            "The upstream app instructions exceed 128 KiB.",
        ));
    }
    let mut tools = Vec::new();
    let mut cursors = HashSet::new();
    let mut names = HashSet::new();
    let mut cursor = None;
    let mut bytes = instructions_size(&instructions);
    for _ in 0..MAX_TOOLS {
        let page = client
            .list_tools(Some(PaginatedRequestParams::default().with_cursor(cursor)))
            .await
            .map_err(|_| {
                Error::new(
                    "hub_catalogue",
                    "The upstream tool catalogue could not be read.",
                )
            })?;
        if catalogue_changed(&client) {
            return Err(Error::new(
                "hub_relink",
                "The upstream catalogue changed. Link this app again locally.",
            ));
        }
        for tool in page.tools {
            if tools.len() >= MAX_TOOLS
                || tool.name.is_empty()
                || tool.name.len() > 256
                || tool.name.chars().any(char::is_control)
                || !names.insert(tool.name.to_string())
            {
                return Err(Error::new(
                    "hub_catalogue",
                    "The upstream catalogue is oversized or has invalid or duplicate tool names.",
                ));
            }
            let alias = format!("app_{id}_{}", tools.len());
            let upstream_name = tool.name.to_string();
            let mut catalogue = serde_json::to_value(tool)?;
            let mut schema = catalogue
                .get("inputSchema")
                .filter(|schema| schema.is_object())
                .cloned()
                .ok_or_else(|| {
                    Error::new(
                        "hub_catalogue",
                        "An upstream tool has no object input schema.",
                    )
                })?;
            if schema.get("$id").is_none() {
                schema["$id"] = json!(format!("urn:undertree:app:{id}:tool:{}", tools.len()));
            }
            catalogue["name"] = json!(alias);
            let title = catalogue
                .get("title")
                .and_then(Value::as_str)
                .unwrap_or(&upstream_name);
            catalogue["title"] = json!(format!("{label}: {title}"));
            catalogue["inputSchema"] = json!({
                "type":"object",
                "properties":{
                    "requestId":{"type":"string","minLength":1,"maxLength":100,"description":"Stable call ID. Reuse only for identical arguments. An uncertain call is never automatically repeated."},
                    "arguments":schema,
                },
                "required":["requestId","arguments"],
                "additionalProperties":false,
            });
            if catalogue.get("_meta").is_none() {
                catalogue["_meta"] = json!({});
            }
            catalogue["_meta"]["undertree/appId"] = json!(id);
            catalogue["_meta"]["undertree/toolName"] = json!(upstream_name);
            bytes += catalogue.to_string().len();
            if bytes > MAX_RESULT {
                return Err(Error::new(
                    "hub_limit",
                    "The upstream catalogue exceeds 2 MiB of metadata.",
                ));
            }
            tools.push(FrozenTool {
                alias,
                upstream_name,
                catalogue,
            });
        }
        cursor = page.next_cursor;
        let Some(next) = &cursor else {
            return Ok((client, tools, instructions));
        };
        if next.len() > 4096 || !cursors.insert(next.clone()) {
            return Err(Error::new(
                "hub_catalogue",
                "The upstream catalogue returned invalid pagination.",
            ));
        }
    }
    Err(Error::new(
        "hub_limit",
        "The upstream catalogue has too many pages.",
    ))
}

#[derive(Clone)]
struct BoundedHttp {
    client: reqwest::Client,
}

fn http_error() -> StreamableHttpError<io::Error> {
    StreamableHttpError::Client(io::Error::other("The upstream HTTP exchange failed."))
}

impl BoundedHttp {
    fn request(
        &self,
        method: reqwest::Method,
        uri: &str,
        session: Option<&str>,
        auth: Option<String>,
        headers: HashMap<HeaderName, HeaderValue>,
    ) -> reqwest::RequestBuilder {
        let get_stream = method == reqwest::Method::GET;
        let mut request = self
            .client
            .request(method, uri)
            .header("accept", "application/json, text/event-stream");
        if !get_stream {
            request = request.timeout(CALL_TIMEOUT);
        }
        if let Some(session) = session {
            request = request.header("mcp-session-id", session);
        }
        if let Some(auth) = auth {
            request = request.bearer_auth(auth);
        }
        for (name, value) in headers {
            request = request.header(name, value);
        }
        request
    }

    fn stream(response: reqwest::Response) -> BoxedSseResponse {
        let chunks = futures_util::stream::try_unfold(
            (response, 0usize),
            |(mut response, total)| async move {
                let Some(chunk) = response
                    .chunk()
                    .await
                    .map_err(|_| io::Error::other("The upstream stream failed."))?
                else {
                    return Ok(None);
                };
                let total = total.saturating_add(chunk.len());
                if total > MAX_WIRE_RESPONSE {
                    return Err(io::Error::other(
                        "The upstream response exceeded its limit.",
                    ));
                }
                Ok(Some((chunk, (response, total))))
            },
        );
        sse_stream::SseStream::from_bytes_stream(chunks).boxed()
    }
}

impl StreamableHttpClient for BoundedHttp {
    type Error = io::Error;

    async fn post_message(
        &self,
        uri: Arc<str>,
        message: ClientJsonRpcMessage,
        session_id: Option<Arc<str>>,
        auth: Option<String>,
        headers: HashMap<HeaderName, HeaderValue>,
    ) -> std::result::Result<StreamableHttpPostResponse, StreamableHttpError<Self::Error>> {
        let expects_response = matches!(message, ClientJsonRpcMessage::Request(_));
        let mut response = self
            .request(
                reqwest::Method::POST,
                &uri,
                session_id.as_deref(),
                auth,
                headers,
            )
            .json(&message)
            .send()
            .await
            .map_err(|_| http_error())?;
        let status = response.status();
        if status == reqwest::StatusCode::NOT_FOUND && session_id.is_some() {
            return Err(StreamableHttpError::SessionExpired);
        }
        if matches!(
            status,
            reqwest::StatusCode::ACCEPTED | reqwest::StatusCode::NO_CONTENT
        ) {
            return Ok(StreamableHttpPostResponse::Accepted);
        }
        if status.is_redirection() {
            return Err(http_error());
        }
        if response
            .content_length()
            .is_some_and(|length| length > MAX_WIRE_RESPONSE as u64)
        {
            return Err(http_error());
        }
        let session = response
            .headers()
            .get("mcp-session-id")
            .and_then(|value| value.to_str().ok())
            .map(str::to_owned);
        let content_type = response
            .headers()
            .get("content-type")
            .and_then(|value| value.to_str().ok())
            .unwrap_or("");
        if status.is_success() && content_type.starts_with("text/event-stream") {
            return Ok(StreamableHttpPostResponse::Sse(
                Self::stream(response),
                session,
            ));
        }
        let is_json = content_type.starts_with("application/json");
        let mut bytes = Vec::new();
        while let Some(chunk) = response.chunk().await.map_err(|_| http_error())? {
            if bytes.len().saturating_add(chunk.len()) > MAX_WIRE_RESPONSE {
                return Err(http_error());
            }
            bytes.extend_from_slice(&chunk);
        }
        if status.is_success() && !expects_response && bytes.is_empty() {
            return Ok(StreamableHttpPostResponse::Accepted);
        }
        if !is_json {
            return Err(http_error());
        }
        match serde_json::from_slice::<ServerJsonRpcMessage>(&bytes) {
            Ok(message) => Ok(StreamableHttpPostResponse::Json(message, session)),
            Err(_) if status.is_success() && !expects_response => {
                Ok(StreamableHttpPostResponse::Accepted)
            }
            Err(_) => Err(http_error()),
        }
    }

    async fn get_stream(
        &self,
        uri: Arc<str>,
        session_id: Option<Arc<str>>,
        last_event_id: Option<String>,
        auth: Option<String>,
        headers: HashMap<HeaderName, HeaderValue>,
    ) -> std::result::Result<BoxedSseResponse, StreamableHttpError<Self::Error>> {
        let mut request = self.request(
            reqwest::Method::GET,
            &uri,
            session_id.as_deref(),
            auth,
            headers,
        );
        if let Some(last_event_id) = last_event_id {
            request = request.header("last-event-id", last_event_id);
        }
        let response = tokio::time::timeout(Duration::from_secs(10), request.send())
            .await
            .map_err(|_| http_error())?
            .map_err(|_| http_error())?;
        if response.status() == reqwest::StatusCode::METHOD_NOT_ALLOWED {
            return Err(StreamableHttpError::ServerDoesNotSupportSse);
        }
        if !response.status().is_success()
            || !response
                .headers()
                .get("content-type")
                .is_some_and(|value| value.as_bytes().starts_with(b"text/event-stream"))
        {
            return Err(http_error());
        }
        Ok(Self::stream(response))
    }

    async fn delete_session(
        &self,
        uri: Arc<str>,
        session_id: Arc<str>,
        auth: Option<String>,
        headers: HashMap<HeaderName, HeaderValue>,
    ) -> std::result::Result<(), StreamableHttpError<Self::Error>> {
        let response = self
            .request(
                reqwest::Method::DELETE,
                &uri,
                Some(&session_id),
                auth,
                headers,
            )
            .send()
            .await
            .map_err(|_| http_error())?;
        if response.status().is_success()
            || matches!(
                response.status(),
                reqwest::StatusCode::METHOD_NOT_ALLOWED | reqwest::StatusCode::NOT_FOUND
            )
        {
            Ok(())
        } else {
            Err(http_error())
        }
    }
}

#[cfg(test)]
#[path = "mcp_hub/tests.rs"]
mod tests;
