use super::*;
use rmcp::model::{ReadResourceRequestParams, ReadResourceResponse};

pub(super) const UI_MIME: &str = "text/html;profile=mcp-app";
pub(super) const MAX_RESOURCES: usize = 32;
const MAX_HTML: usize = 512 * 1024;
const SECRET_TUNNEL_WIDGET: &str = "ui://secret-tunnel/chat-control-v1.html";
const SECRET_TUNNEL_WIDGET_SHA256: &str =
    "7e35bfaad18493b22beaf10653863c1548082d03507dda8f29f3aa19bf06f78d";
const RESOURCE_POINTERS: [&str; 3] = [
    "/_meta/ui/resourceUri",
    "/_meta/ui~1resourceUri",
    "/_meta/openai~1outputTemplate",
];

pub(super) struct FrozenResource {
    alias: String,
    catalogue: Value,
    result: Value,
}

pub(super) fn size(resources: &[FrozenResource]) -> usize {
    resources
        .iter()
        .map(|resource| resource.catalogue.to_string().len() + resource.result.to_string().len())
        .sum()
}

fn invalid_resource() -> Error {
    Error::new("hub_resource", "This gateway supports only the reviewed Secret Tunnel chat-control-v1 UI resource. Relink the app locally after reviewing its UI.")
}

impl Hub {
    pub fn resource_catalogue(&self) -> Result<Vec<Value>> {
        let state = self.lock()?;
        if !state.enabled {
            return Err(revoked());
        }
        Ok(state
            .apps
            .values()
            .filter(|app| !app.failed && !app.client.is_closed() && !catalogue_changed(&app.client))
            .flat_map(|app| {
                app.resources
                    .iter()
                    .map(|resource| resource.catalogue.clone())
            })
            .collect())
    }

    pub fn read_ui_resource(&self, uri: &str) -> Result<Value> {
        let state = self.lock()?;
        if !state.enabled {
            return Err(revoked());
        }
        let (app, resource) = state
            .apps
            .values()
            .find_map(|app| {
                app.resources
                    .iter()
                    .find(|resource| resource.alias == uri)
                    .map(|resource| (app, resource))
            })
            .ok_or_else(invalid_resource)?;
        if app.failed || app.client.is_closed() || catalogue_changed(&app.client) {
            return Err(revoked());
        }
        Ok(resource.result.clone())
    }
}

pub(super) async fn freeze(
    client: &Upstream,
    id: &str,
    label: &str,
    tools: &mut [FrozenTool],
    mut bytes: usize,
) -> Result<Vec<FrozenResource>> {
    let mut uris = BTreeMap::new();
    for tool in tools.iter() {
        for pointer in RESOURCE_POINTERS {
            if let Some(uri) = tool.catalogue.pointer(pointer) {
                let uri = uri
                    .as_str()
                    .filter(|uri| {
                        *uri == SECRET_TUNNEL_WIDGET
                            && uri.len() <= 4096
                            && !uri.chars().any(|character| {
                                character.is_control() || character.is_whitespace()
                            })
                    })
                    .ok_or_else(invalid_resource)?;
                if !uris.contains_key(uri) {
                    if uris.len() >= MAX_RESOURCES {
                        return Err(invalid_resource());
                    }
                    uris.insert(
                        uri.to_owned(),
                        format!("ui://undertree/{id}/{}", uris.len()),
                    );
                }
            }
        }
    }
    let mut resources = Vec::new();
    for (uri, alias) in &uris {
        let ReadResourceResponse::Complete(result) = client
            .read_resource_once(ReadResourceRequestParams::new(uri))
            .await
            .map_err(|_| invalid_resource())?
        else {
            return Err(invalid_resource());
        };
        if catalogue_changed(client) {
            return Err(revoked());
        }
        let mut result = serde_json::to_value(result)?;
        let contents = result
            .get_mut("contents")
            .and_then(Value::as_array_mut)
            .filter(|contents| contents.len() == 1)
            .ok_or_else(invalid_resource)?;
        let content = &mut contents[0];
        if content["uri"] != *uri || content["mimeType"] != UI_MIME || content.get("blob").is_some()
        {
            return Err(invalid_resource());
        }
        let text = content
            .get("text")
            .and_then(Value::as_str)
            .filter(|text| text.len() <= MAX_HTML)
            .ok_or_else(invalid_resource)?;
        let adapted = secret_tunnel_bridge(text, tools)?;
        if adapted.len() > MAX_HTML {
            return Err(invalid_resource());
        }
        content["text"] = json!(adapted);
        content["uri"] = json!(alias);
        let mut catalogue =
            json!({"uri":alias,"name":format!("{label}: app view"),"mimeType":UI_MIME});
        if let Some(meta) = content.get("_meta") {
            catalogue["_meta"] = meta.clone();
        }
        bytes += result.to_string().len() + catalogue.to_string().len();
        if bytes > MAX_RESULT {
            return Err(invalid_resource());
        }
        resources.push(FrozenResource {
            alias: alias.clone(),
            catalogue,
            result,
        });
    }
    for tool in tools {
        for pointer in RESOURCE_POINTERS {
            if let Some(uri) = tool.catalogue.pointer_mut(pointer) {
                let alias = uris
                    .get(uri.as_str().ok_or_else(invalid_resource)?)
                    .ok_or_else(invalid_resource)?;
                *uri = json!(alias);
            }
        }
    }
    Ok(resources)
}

fn secret_tunnel_bridge(html: &str, tools: &[FrozenTool]) -> Result<String> {
    // The URI is app-provided; only these reviewed bytes may receive the alias bridge.
    if format!("{:x}", Sha256::digest(html.as_bytes())) != SECRET_TUNNEL_WIDGET_SHA256 {
        return Err(invalid_resource());
    }
    let mut aliases = BTreeMap::new();
    for name in ["mcp_chat_decide", "mcp_chat_receipt"] {
        let tool = tools
            .iter()
            .find(|tool| {
                tool.upstream_name == name
                    && tool.catalogue.pointer("/_meta/ui/visibility") == Some(&json!(["app"]))
            })
            .ok_or_else(invalid_resource)?;
        aliases.insert(name, &tool.alias);
    }
    let channel = "window.parent.postMessage(";
    if html.matches(channel).count() != 2 || html.contains("__undertreeSecretTunnelPostMessage") {
        return Err(invalid_resource());
    }
    let aliases = serde_json::to_string(&aliases)?
        .replace('<', "\\u003c")
        .replace('>', "\\u003e")
        .replace('&', "\\u0026");
    let bridge = include_str!("secret-tunnel-bridge.js")
        .replace("__UNDERTREE_SECRET_TUNNEL_ALIASES__", &aliases);
    let rewritten = html.replace(channel, "window.__undertreeSecretTunnelPostMessage(");
    let insertion = rewritten.find("<script").ok_or_else(invalid_resource)?;
    Ok(format!(
        "{}<script>{bridge}</script>{}",
        &rewritten[..insertion],
        &rewritten[insertion..]
    ))
}
