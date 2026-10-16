//! Session-only non-content MCP authority and its private UI adapter.
use super::*;
use crate::control::{AppCommand, ControlBridge, UiOutcome, WindowState, WorkspaceSnapshot};
use subtle::ConstantTimeEq;

const CONTROL_CHECK_WAIT: std::time::Duration = std::time::Duration::from_secs(2);

#[derive(Debug, Deserialize)]
#[serde(
    tag = "action",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum ControlOperation {
    ControlEnable {
        enabled: bool,
    },
    ControlPdfExport {
        enabled: bool,
        projects: Vec<String>,
        generation: String,
        export_generation: String,
    },
    ControlPoll {
        snapshot: WorkspaceSnapshot,
    },
    ControlCheck {
        request_id: String,
        ack_token: String,
    },
    ControlComplete {
        request_id: String,
        ack_token: String,
        outcome: UiOutcome,
    },
    ControlCompile {
        request_id: String,
        ack_token: String,
    },
    ControlOpen {
        request_id: String,
        ack_token: String,
    },
}

struct Grant {
    secret: String,
    endpoint: String,
    tunnel_binding: String,
    owner: String,
    initialized: bool,
    tool_calls: u64,
}
#[derive(Clone)]
struct Binding {
    command: AppCommand,
    document: Option<String>,
    root: Option<RootObservation>,
    compile_started: bool,
    compile_result: Option<Value>,
    compile_error: Option<Error>,
    compile_pdf_hash: Option<String>,
}
pub(super) struct AppControlState {
    bridge: ControlBridge,
    generation: String,
    grant: Option<Grant>,
    bindings: BTreeMap<String, Binding>,
}
impl Default for AppControlState {
    fn default() -> Self {
        Self {
            bridge: ControlBridge::new(),
            generation: Uuid::new_v4().to_string(),
            grant: None,
            bindings: BTreeMap::new(),
        }
    }
}

fn requires_clean(command: &AppCommand) -> bool {
    matches!(
        command,
        AppCommand::OpenManuscript { .. }
            | AppCommand::CompileManuscript { .. }
            | AppCommand::SetWindowState {
                state: WindowState::Close
            }
    )
}

fn active_tunnel(current: &mut Option<Tunnel>) -> Option<&mut Tunnel> {
    let active = current.as_mut()?;
    if active.child.try_wait().is_ok_and(|status| status.is_none()) {
        Some(active)
    } else {
        None
    }
}

impl Service {
    pub async fn control_as(
        self: &Arc<Self>,
        caller: CallerContext,
        owner: &str,
        operation: ControlOperation,
    ) -> Result<Value> {
        if caller != CallerContext::Local {
            return Err(Error::new(
                "scope",
                "App control enrollment and callbacks require the authenticated local UI.",
            ));
        }
        self.assert_editor_owner(owner)?;
        match operation {
            ControlOperation::ControlPdfExport {
                enabled,
                projects,
                generation,
                export_generation,
            } => {
                let service = self.clone();
                let owner = owner.to_owned();
                tokio::task::spawn_blocking(move || {
                    service.set_pdf_export_permission(
                        &owner,
                        &generation,
                        &export_generation,
                        enabled,
                        projects,
                    )
                })
                .await
                .map_err(|_| {
                    Error::new(
                        "state",
                        "The local PDF export permission could not be confirmed.",
                    )
                })
                .and_then(|result| result)?;
                self.app_control_status()
            }
            ControlOperation::ControlEnable { enabled } => {
                let mut tunnel = self.tunnel.lock().await;
                self.assert_editor_owner(owner)?;
                if !enabled {
                    self.revoke_app_controls()?;
                    return self.app_control_status();
                }
                let active = active_tunnel(&mut tunnel).ok_or_else(|| {
                    Error::new(
                        "tunnel",
                        "Start the Review connection before enabling session App controls.",
                    )
                })?;
                if active.text_only_connector()
                    && !crate::transport::gateway_active(self, &active.secret)
                {
                    return Err(Error::new(
                        "scope",
                        "Enable the app gateway before allowing controls through this imported connection.",
                    ));
                }
                let origin = active
                    .endpoint
                    .parse::<axum::http::Uri>()
                    .ok()
                    .and_then(|url| {
                        url.authority()
                            .map(|authority| format!("https://{authority}"))
                    })
                    .ok_or_else(|| {
                        Error::new("state", "The active public origin is unavailable.")
                    })?;
                let mut state = lock(&self.app_control)?;
                *state = AppControlState::default();
                self.revoke_pdf_exports()?;
                let secret = format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple());
                state.grant = Some(Grant {
                    endpoint: format!("{origin}/mcp/control/{secret}"),
                    secret,
                    tunnel_binding: digest(&active.secret),
                    owner: owner.into(),
                    initialized: false,
                    tool_calls: 0,
                });
                drop(state);
                self.app_control_status()
            }
            ControlOperation::ControlCompile {
                request_id,
                ack_token,
            } => {
                let (project, path, source_epoch, root, revision, generation, previous) = {
                    let mut tunnel = self.tunnel.lock().await;
                    let active = active_tunnel(&mut tunnel).ok_or_else(|| {
                        Error::new("scope", "The app control session has stopped.")
                    })?;
                    let mut state = lock(&self.app_control)?;
                    self.check_control_owner(&state, owner, &active.secret)?;
                    let binding =
                        self.authorized_control_binding(&state, &request_id, &ack_token)?;
                    let AppCommand::CompileManuscript {
                        document_id,
                        revision,
                    } = &binding.command
                    else {
                        return Err(Error::new(
                            "scope",
                            "This UI command does not authorize a build.",
                        ));
                    };
                    let (project, path, _) = self.control_document(document_id)?;
                    let (_, _, source_epoch, root) = self.shared_source(document_id)?;
                    if let Some(error) = binding.compile_error {
                        return Err(error);
                    }
                    if binding.compile_started && binding.compile_result.is_none() {
                        return Err(Error::new("outcome_unknown","This native build was already started. Inspect its result before another request."));
                    }
                    let previous = binding.compile_result.is_some();
                    state
                        .bindings
                        .get_mut(&request_id)
                        .ok_or_else(|| Error::new("scope", "The build request is unavailable."))?
                        .compile_started = true;
                    (
                        project.id,
                        path,
                        source_epoch,
                        root,
                        revision.clone(),
                        state.generation.clone(),
                        previous,
                    )
                };
                let work = if previous {
                    self.preview_pdf(&project, &path)
                } else {
                    self.compile_typst_rooted(
                        &project,
                        &path,
                        &revision,
                        source_epoch,
                        Some(root),
                        None,
                    )
                    .await
                };
                let mut state = lock(&self.app_control)?;
                if state.generation != generation || state.grant.is_none() {
                    return Err(Error::new("scope","The app control grant was revoked during compilation. Its output remains local."));
                }
                self.assert_editor_owner(owner)?;
                let captured = state
                    .bindings
                    .get(&request_id)
                    .ok_or_else(|| Error::new("scope", "The build request is unavailable."))?;
                if let Some(document) = &captured.document {
                    self.control_document(document)?;
                }
                let binding = state
                    .bindings
                    .get_mut(&request_id)
                    .ok_or_else(|| Error::new("scope", "The build request is unavailable."))?;
                let result = match work {
                    Ok(result) => result,
                    Err(error) => {
                        binding.compile_error = Some(error.clone());
                        return Err(error);
                    }
                };
                if result["revision"].as_str() != Some(revision.as_str())
                    || result["sourceEpoch"].as_u64().unwrap_or(0) != source_epoch
                    || result.get("expectedRoot") != Some(&json!(root))
                {
                    return Err(Error::new(
                        "stale",
                        "The recorded build artifact is no longer available at its saved revision.",
                    ));
                }
                let pdf_hash = digest(result["base64"].as_str().ok_or_else(|| {
                    Error::new("outcome_unknown", "The recorded build has no PDF bytes.")
                })?);
                if binding
                    .compile_pdf_hash
                    .as_ref()
                    .is_some_and(|previous| previous != &pdf_hash)
                {
                    return Err(Error::new("stale","The original build artifact was replaced. Inspect its receipt before requesting a new build."));
                }
                binding.compile_pdf_hash = Some(pdf_hash.clone());
                binding.compile_result = Some(
                    json!({"available":result["available"],"revision":result["revision"],"current":result["current"],"artifactId":pdf_hash}),
                );
                Ok(result)
            }
            operation => {
                let service = self.clone();
                let owner = owner.to_owned();
                tokio::task::spawn_blocking(move||service.control_ui(&owner,operation)).await
                    .map_err(|_|Error::new("outcome_unknown","The local control acknowledgement was lost; inspect the command result."))?
            }
        }
    }

    fn check_control_owner(
        &self,
        state: &AppControlState,
        owner: &str,
        tunnel_secret: &str,
    ) -> Result<()> {
        self.assert_editor_owner(owner)?;
        if state
            .grant
            .as_ref()
            .is_none_or(|g| g.owner != owner || g.tunnel_binding != digest(tunnel_secret))
        {
            return Err(Error::new(
                "scope",
                "App controls are disabled, revoked, or owned by a different UI page.",
            ));
        }
        Ok(())
    }

    fn control_ui(&self, owner: &str, operation: ControlOperation) -> Result<Value> {
        self.assert_editor_owner(owner)?;
        // control_as runs this callback on spawn_blocking. Wait only for the
        // read-only authority check; never retry a UI effect or another busy error.
        // No App/editor/document lock is held while waiting for the same tunnel.
        let mut tunnel = if matches!(&operation, ControlOperation::ControlCheck { .. }) {
            tokio::runtime::Handle::current()
                .block_on(async {
                    tokio::time::timeout(CONTROL_CHECK_WAIT, self.tunnel.lock()).await
                })
                .map_err(|_| Error::new("outcome_unknown", "Connection authority could not be confirmed within two seconds. Inspect the existing request before further action."))?
        } else {
            self.tunnel.try_lock().map_err(|_| {
                Error::new("busy", "The connection is processing another operation.")
            })?
        };
        let active = active_tunnel(&mut tunnel);
        let mut state = lock(&self.app_control)?;
        if state
            .grant
            .as_ref()
            .is_some_and(|g| self.assert_editor_owner(&g.owner).is_err())
            || (state.grant.is_some()
                && active.as_ref().is_none_or(|t| {
                    state
                        .grant
                        .as_ref()
                        .is_none_or(|g| g.tunnel_binding != digest(&t.secret))
                }))
        {
            *state = AppControlState::default();
        }
        match operation {
            ControlOperation::ControlPoll { snapshot } => {
                if let Some(active) = active.as_ref() {
                    if state.grant.is_some() {
                        self.check_control_owner(&state, owner, &active.secret)?;
                    }
                }
                let jobs = state.bridge.publish(snapshot)?;
                Ok(
                    json!({"enabled":state.grant.is_some(),"generation":state.generation,"jobs":jobs}),
                )
            }
            ControlOperation::ControlCheck {
                request_id,
                ack_token,
            } => {
                self.check_control_owner(
                    &state,
                    owner,
                    &active
                        .ok_or_else(|| Error::new("scope", "The connection stopped."))?
                        .secret,
                )?;
                self.authorized_control_binding(&state, &request_id, &ack_token)?;
                Ok(json!({"authorized":true,"generation":state.generation}))
            }
            ControlOperation::ControlComplete {
                request_id,
                ack_token,
                outcome,
            } => {
                self.check_control_owner(
                    &state,
                    owner,
                    &active
                        .ok_or_else(|| Error::new("scope", "The connection stopped."))?
                        .secret,
                )?;
                let binding = state
                    .bindings
                    .get(&request_id)
                    .ok_or_else(|| Error::new("scope", "This command is unavailable."))?;
                if matches!(binding.command, AppCommand::CompileManuscript { .. })
                    && matches!(outcome, UiOutcome::Applied { .. })
                    && binding.compile_result.is_none()
                {
                    return Err(Error::new(
                        "outcome_unknown",
                        "The native build has no confirmed result to acknowledge.",
                    ));
                }
                if let Some(id) = &binding.document {
                    self.control_document(id)?;
                }
                let receipt = state.bridge.complete(&request_id, &ack_token, outcome)?;
                self.project_control_receipt(&state, &request_id, receipt)
            }
            ControlOperation::ControlOpen {
                request_id,
                ack_token,
            } => {
                self.check_control_owner(
                    &state,
                    owner,
                    &active
                        .ok_or_else(|| Error::new("scope", "The connection stopped."))?
                        .secret,
                )?;
                let binding = self.authorized_control_binding(&state, &request_id, &ack_token)?;
                let AppCommand::OpenManuscript { document_id } = binding.command else {
                    return Err(Error::new(
                        "scope",
                        "This UI command does not authorize opening a manuscript.",
                    ));
                };
                let _documents = self
                    .documents
                    .try_lock()
                    .map_err(|_| Error::new("busy", "A document operation is running."))?;
                self.read_control_snapshot(&document_id)
            }
            _ => Err(Error::new(
                "scope",
                "Use the asynchronous native app control adapter.",
            )),
        }
    }

    fn control_document(&self, id: &str) -> Result<(Project, String, PathBuf)> {
        let (project, path, _, _) = self.shared_source(id)?;
        let approved = self.project(&project)?;
        let file = self.path(&approved, &path, false)?;
        Ok((approved, path, file))
    }

    fn check_control_scope(&self, binding: &Binding) -> Result<()> {
        if let Some(id) = &binding.document {
            self.control_document(id)?;
            if binding.root != Some(self.shared_source(id)?.3) {
                return Err(Error::new(
                    "scope",
                    "This app job belongs to another project folder.",
                ));
            }
        }
        if requires_clean(&binding.command) {
            self.assert_clean_editor_buffers()?;
        }
        if let AppCommand::OpenManuscript { document_id } = &binding.command {
            let (_, _, file) = self.control_document(document_id)?;
            if journal_path(&file).exists() {
                return Err(Error::new(
                    "busy",
                    "Resolve the pending local save before opening this manuscript remotely.",
                ));
            }
        }
        if let AppCommand::SelectPassage {
            document_id,
            revision,
            from,
            to,
            quote,
        } = &binding.command
        {
            let (_, _, file) = self.control_document(document_id)?;
            let content = read_text(&file, MAX_TEXT)?;
            if journal_path(&file).exists()
                || digest(&content) != *revision
                || crate::document::selected(&content, *from, *to)? != quote.as_str()
            {
                return Err(Error::new(
                    "stale",
                    "The saved passage no longer matches its exact revision and quote.",
                ));
            }
        }
        if let AppCommand::CompileManuscript {
            document_id,
            revision,
        } = &binding.command
        {
            let (_, _, file) = self.control_document(document_id)?;
            if journal_path(&file).exists() || digest(&read_text(&file, MAX_TEXT)?) != *revision {
                return Err(Error::new(
                    "stale",
                    "The build requires the exact saved source revision.",
                ));
            }
        }
        Ok(())
    }

    fn authorized_control_binding(
        &self,
        state: &AppControlState,
        id: &str,
        token: &str,
    ) -> Result<Binding> {
        state.bridge.authorize(id, token)?;
        let binding = state
            .bindings
            .get(id)
            .ok_or_else(|| Error::new("scope", "The app command is unavailable."))?
            .clone();
        self.check_control_scope(&binding)?;
        Ok(binding)
    }

    fn project_control_receipt(
        &self,
        state: &AppControlState,
        id: &str,
        receipt: Value,
    ) -> Result<Value> {
        let binding = state
            .bindings
            .get(id)
            .ok_or_else(|| Error::new("scope", "The app command is unavailable."))?;
        if let Some(id) = &binding.document {
            self.control_document(id)?;
        }
        let status = receipt["state"].as_str().unwrap_or("outcome_unknown");
        let mut result = json!({"requestId":id,"generation":state.generation,"state":status});
        if status == "applied" {
            result["result"] = binding
                .compile_result
                .clone()
                .unwrap_or_else(|| json!({"applied":true}));
            if matches!(
                binding.command,
                AppCommand::SetWindowState {
                    state: WindowState::Close
                }
            ) {
                result["result"] = json!({"state":"close_requested"});
            }
        }
        if status == "rejected" {
            result["code"] = json!(receipt["code"]
                .as_str()
                .filter(|code| matches!(
                    *code,
                    "busy"
                        | "stale"
                        | "scope"
                        | "unavailable"
                        | "arguments"
                        | "conflict"
                        | "limit"
                        | "outcome_unknown"
                        | "io"
                        | "typst"
                        | "path"
                        | "state"
                ))
                .unwrap_or("unavailable"));
            result["message"] = json!("The local UI rejected this app control.");
        }
        if let Some(document) = &binding.document {
            result["documentId"] = json!(document);
        }
        Ok(result)
    }

    pub(crate) fn revoke_app_controls(&self) -> Result<()> {
        let mut state = lock(&self.app_control)?;
        *state = AppControlState::default();
        self.revoke_pdf_exports()?;
        Ok(())
    }

    pub(crate) fn app_control_status(&self) -> Result<Value> {
        let mut state = lock(&self.app_control)?;
        if state
            .grant
            .as_ref()
            .is_some_and(|g| self.assert_editor_owner(&g.owner).is_err())
        {
            *state = AppControlState::default();
        }
        let grant = state.grant.as_ref();
        let mut result = json!({"enabled":grant.is_some(),"endpoint":grant.map(|g|g.endpoint.as_str()).unwrap_or(""),"generation":state.generation,"tools":tool_catalogue(),"mcpInitialized":grant.is_some_and(|g|g.initialized),"toolCalls":grant.map_or(0,|g|g.tool_calls)});
        drop(state);
        result["pdfExport"] = self.pdf_export_status()?;
        Ok(result)
    }

    pub(super) fn pdf_app_authority(
        &self,
        require_live_ui: bool,
    ) -> Result<(String, String, String)> {
        let state = lock(&self.app_control)?;
        let grant = state
            .grant
            .as_ref()
            .ok_or_else(|| Error::new("scope", "App controls are disabled."))?;
        self.assert_editor_owner(&grant.owner)?;
        if require_live_ui {
            state.bridge.workspace()?;
        }
        let origin = grant
            .endpoint
            .rsplit_once("/mcp/control/")
            .map(|(origin, _)| origin)
            .ok_or_else(|| Error::new("state", "The App origin is unavailable."))?;
        Ok((
            state.generation.clone(),
            grant.owner.clone(),
            origin.to_owned(),
        ))
    }

    pub(super) fn pdf_permission_guard(
        &self,
        owner: &str,
        generation: &str,
        live_ui: bool,
    ) -> Result<std::sync::MutexGuard<'_, AppControlState>> {
        let state = lock(&self.app_control)?;
        self.assert_editor_owner(owner)?;
        if state.generation != generation
            || state
                .grant
                .as_ref()
                .is_none_or(|grant| grant.owner != owner)
        {
            return Err(Error::new(
                "scope",
                "The App grant changed before PDF permission could be applied.",
            ));
        }
        if live_ui {
            state.bridge.workspace()?;
        }
        Ok(state)
    }

    pub(crate) fn app_control_authenticate(
        &self,
        secret: &str,
        tunnel_secret: &str,
    ) -> Result<bool> {
        let mut state = lock(&self.app_control)?;
        if state
            .grant
            .as_ref()
            .is_some_and(|g| self.assert_editor_owner(&g.owner).is_err())
        {
            *state = AppControlState::default();
        }
        Ok(state.grant.as_ref().is_some_and(|g| {
            g.secret.len() == secret.len()
                && bool::from(g.secret.as_bytes().ct_eq(secret.as_bytes()))
                && g.tunnel_binding == digest(tunnel_secret)
        }))
    }
    pub(crate) fn app_control_initialized(&self) -> Result<bool> {
        Ok(lock(&self.app_control)?
            .grant
            .as_ref()
            .is_some_and(|g| g.initialized))
    }
    pub(crate) fn app_control_initialize(&self) -> Result<()> {
        if let Some(grant) = lock(&self.app_control)?.grant.as_mut() {
            grant.initialized = true;
        }
        Ok(())
    }
    pub(crate) fn app_control_count_call(&self) -> Result<()> {
        if let Some(grant) = lock(&self.app_control)?.grant.as_mut() {
            grant.tool_calls = grant.tool_calls.saturating_add(1);
        }
        Ok(())
    }

    pub(crate) fn app_remote(&self, name: &str, arguments: Value) -> Result<Value> {
        if matches!(name, "list_manuscripts" | "get_pdf_download") {
            return self.pdf_remote(name, arguments);
        }
        let mut state = lock(&self.app_control)?;
        let grant = state
            .grant
            .as_ref()
            .ok_or_else(|| Error::new("scope", "App controls are disabled."))?;
        self.assert_editor_owner(&grant.owner)?;
        let no_arguments = || -> Result<()> {
            if arguments.as_object().is_none_or(|a| !a.is_empty()) {
                return Err(Error::new("arguments", "This tool takes no arguments."));
            }
            Ok(())
        };
        match name {
            "list_manuscripts" => {
                no_arguments()?;
                let shared = self.current_shared()?;
                let mut manuscripts = Vec::new();
                for (id, _) in shared {
                    let (_, path, _) = self.control_document(&id)?;
                    manuscripts.push(json!({"documentId":id,"path":path}));
                }
                Ok(json!(manuscripts))
            }
            "read_manuscript" => {
                #[derive(Deserialize)]
                #[serde(rename_all = "camelCase", deny_unknown_fields)]
                struct Read {
                    document_id: String,
                }
                let input: Read = serde_json::from_value(arguments)?;
                let _documents = self
                    .documents
                    .try_lock()
                    .map_err(|_| Error::new("busy", "A local document operation is running."))?;
                let mut value = self.read_control_snapshot(&input.document_id)?;
                if let Some(object) = value.as_object_mut() {
                    object.remove("sourceEpoch");
                    object.remove("expectedRoot");
                    object.remove("sidecarRevision");
                }
                Ok(value)
            }
            "get_workspace" => {
                no_arguments()?;
                let mut value = state.bridge.workspace()?;
                let shared = self.current_shared()?;
                for id in shared.keys() {
                    self.control_document(id)?;
                }
                if let Some(documents) = value["workspace"]["openDocuments"].as_array_mut() {
                    documents.retain(|d| {
                        d["documentId"]
                            .as_str()
                            .is_some_and(|id| shared.contains_key(id))
                    });
                }
                if value["workspace"]["activeDocumentId"]
                    .as_str()
                    .is_none_or(|id| !shared.contains_key(id))
                {
                    value["workspace"]["activeDocumentId"] = Value::Null;
                    value["workspace"]["preview"] = Value::Null;
                }
                value["generation"] = json!(state.generation);
                Ok(value)
            }
            "get_control_result" => {
                #[derive(Deserialize)]
                #[serde(rename_all = "camelCase", deny_unknown_fields)]
                struct Read {
                    request_id: String,
                }
                let input: Read = serde_json::from_value(arguments)?;
                let result = state.bridge.result(&input.request_id)?;
                self.project_control_receipt(&state, &input.request_id, result)
            }
            name if command_name(name) => {
                let mut input = arguments
                    .as_object()
                    .cloned()
                    .ok_or_else(|| Error::new("arguments", "Use an app command object."))?;
                let id = input
                    .remove("requestId")
                    .and_then(|v| v.as_str().map(str::to_owned))
                    .ok_or_else(|| {
                        Error::new("arguments", "Use a stable requestId for an app command.")
                    })?;
                if input.contains_key("kind") {
                    return Err(Error::new(
                        "arguments",
                        "The tool name chooses the fixed app command.",
                    ));
                }
                input.insert("kind".into(), json!(name));
                let command: AppCommand = serde_json::from_value(Value::Object(input))?;
                let document = match &command {
                    AppCommand::OpenManuscript { document_id }
                    | AppCommand::SelectPassage { document_id, .. }
                    | AppCommand::CompileManuscript { document_id, .. } => {
                        Some(document_id.clone())
                    }
                    AppCommand::SetPreviewView { .. } => state.bridge.workspace()?["workspace"]
                        ["activeDocumentId"]
                        .as_str()
                        .map(str::to_owned),
                    _ => None,
                };
                if matches!(command, AppCommand::SetPreviewView { .. }) && document.is_none() {
                    return Err(Error::new(
                        "scope",
                        "Only an explicitly shared active manuscript preview can be controlled.",
                    ));
                }
                let root = document
                    .as_ref()
                    .map(|id| self.shared_source(id).map(|source| source.3))
                    .transpose()?;
                let binding = Binding {
                    root,
                    command: command.clone(),
                    document,
                    compile_started: false,
                    compile_result: None,
                    compile_error: None,
                    compile_pdf_hash: None,
                };
                self.check_control_scope(&binding)?;
                let result = state.bridge.enqueue(&id, command)?;
                state.bindings.entry(id.clone()).or_insert(binding);
                self.project_control_receipt(&state, &id, result)
            }
            _ => Err(Error::new(
                "scope",
                "This App endpoint supports only its named non-content tools.",
            )),
        }
    }

    fn read_control_snapshot(&self, id: &str) -> Result<Value> {
        let (project, path, source_epoch, root) = self.shared_source(id)?;
        let approved = self.project(&project)?;
        let file = approved.root.join(&path);
        let mut snapshot = self.snapshot_binding(
            SourceBinding::new(&project, &path, source_epoch).rooted(Some(root)),
            &file,
            false,
        )?;
        snapshot["documentId"] = json!(id);
        snapshot["shared"] = json!(true);
        Ok(snapshot)
    }
}

fn command_name(name: &str) -> bool {
    matches!(
        name,
        "open_manuscript"
            | "select_passage"
            | "set_workspace_view"
            | "set_editor_preferences"
            | "set_preview_view"
            | "set_window_state"
            | "compile_manuscript"
    )
}

pub(crate) fn tool_catalogue() -> Value {
    fn tool(
        name: &str,
        description: &str,
        properties: Value,
        required: Value,
        read_only: bool,
    ) -> Value {
        json!({"name":name,"description":description,"inputSchema":{"type":"object","properties":properties,"required":required,"additionalProperties":false},"annotations":{"readOnlyHint":read_only,"openWorldHint":false}})
    }
    let id = json!({"type":"string","minLength":1,"maxLength":128});
    let revision = id.clone();
    let boolean = json!({"type":"boolean"});
    let request = json!({"type":"string","minLength":1,"maxLength":100});
    let mut tools = json!([
        tool("list_manuscripts","List only manuscripts explicitly shared for this session.",json!({}),json!([]),true),
        tool("read_manuscript","Read a shared saved manuscript and its review context without changing files.",json!({"documentId":id}),json!(["documentId"]),true),
        tool("get_workspace","Inspect shared document IDs and bounded workspace presentation state; unshared buffers remain private.",json!({}),json!([]),true),
        tool("get_control_result","Inspect one command receipt; never replay an uncertain UI effect automatically.",json!({"requestId":request}),json!(["requestId"]),true),
        tool("open_manuscript","Open a shared manuscript only when every local buffer is clean; never saves or discards.",json!({"requestId":request,"documentId":id}),json!(["requestId","documentId"]),false),
        tool("select_passage","Select an exact UTF-16 quote in the active shared saved revision without editing it.",json!({"requestId":request,"documentId":id,"revision":revision,"from":{"type":"integer","minimum":0},"to":{"type":"integer","minimum":1},"quote":{"type":"string","maxLength":32000}}),json!(["requestId","documentId","revision","from","to","quote"]),false),
        tool("set_workspace_view","Change only named pane visibility settings; keep editor or preview visible.",json!({"requestId":request,"filesVisible":boolean,"editorVisible":boolean,"previewVisible":boolean,"reviewVisible":boolean,"outlineVisible":boolean,"logsVisible":boolean}),json!(["requestId"]),false),
        tool("set_editor_preferences","Change display font size or word wrap without modifying document content.",json!({"requestId":request,"fontSize":{"type":"integer","minimum":10,"maximum":28},"wordWrap":boolean}),json!(["requestId"]),false),
        tool("set_preview_view","Change only an explicitly shared active PDF view; use a valid page, 10–400% zoom, or fit width.",json!({"requestId":request,"page":{"type":"integer","minimum":1},"zoomPercent":{"type":"integer","minimum":10,"maximum":400},"fitWidth":boolean}),json!(["requestId"]),false),
        tool("set_window_state","Request a fixed native window action. Close requires clean buffers and acknowledgement before teardown.",json!({"requestId":request,"state":{"type":"string","enum":["minimize","maximize","restore","focus","close"]}}),json!(["requestId","state"]),false),
        tool("compile_manuscript","Build the exact shared saved Typst revision through the fixed compiler; never flush editor buffers.",json!({"requestId":request,"documentId":id,"revision":revision}),json!(["requestId","documentId","revision"]),false)
    ]);
    tools
        .as_array_mut()
        .expect("fixed tool list")
        .push(super::pdf_exports::tool_descriptor());
    tools
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::control::{DocumentState, EditorPreferences, PreviewState, WorkspaceView};

    struct Fixture {
        _temp: tempfile::TempDir,
        service: Arc<Service>,
        project: String,
        id: String,
        owner: String,
        file: PathBuf,
    }
    impl Fixture {
        async fn new() -> Self {
            let temp = tempfile::tempdir().unwrap();
            let root = temp.path().join("project");
            fs::create_dir(&root).unwrap();
            let file = root.join("main.typ");
            fs::write(&file, "= Saved\n\nHello.\n").unwrap();
            let service = Service::new(temp.path().join("state")).unwrap();
            let project = service
                .local(Operation::AddProject {
                    root: root.to_string_lossy().into(),
                })
                .unwrap()["id"]
                .as_str()
                .unwrap()
                .to_owned();
            let id = service
                .local(Operation::Share {
                    project: project.clone(),
                    path: "main.typ".into(),
                    enabled: true,
                })
                .unwrap()["documentId"]
                .as_str()
                .unwrap()
                .to_owned();
            let connect = service.connect_native_editor("main").unwrap();
            let owner = service
                .native_editor_owner("main", connect["ownerId"].as_str().unwrap())
                .unwrap();
            let child = Command::new("cat")
                .stdin(std::process::Stdio::piped())
                .stdout(std::process::Stdio::null())
                .kill_on_drop(true)
                .spawn()
                .unwrap();
            let (shutdown, _) = tokio::sync::oneshot::channel();
            *service.tunnel.lock().await = Some(Tunnel {
                session_id: uuid::Uuid::new_v4(),
                endpoint: "https://review.example.org/mcp/review-fixture".into(),
                secret: "review-fixture".into(),
                child,
                shutdown,
                mcp_initialized: false,
                last_activity_ms: 0,
                tool_calls: 0,
            });
            let fixture = Self {
                _temp: temp,
                service,
                project,
                id,
                owner,
                file,
            };
            fixture
                .ui(json!({"action":"control_enable","enabled":true}))
                .await
                .unwrap();
            fixture.poll().await;
            fixture
        }
        fn snapshot(&self) -> WorkspaceSnapshot {
            WorkspaceSnapshot {
                open_documents: vec![
                    DocumentState {
                        document_id: self.id.clone(),
                        revision: digest("= Saved\n\nHello.\n"),
                        dirty: false,
                        conflict: false,
                        composing: false,
                    },
                    DocumentState {
                        document_id: "unshared-private-id".into(),
                        revision: "unshared-revision".into(),
                        dirty: false,
                        conflict: false,
                        composing: false,
                    },
                ],
                active_document_id: Some(self.id.clone()),
                preview: Some(PreviewState {
                    page: 1,
                    pages: 2,
                    zoom_percent: 100,
                }),
                view: WorkspaceView {
                    files_visible: true,
                    editor_visible: true,
                    preview_visible: true,
                    review_visible: true,
                    outline_visible: false,
                    logs_visible: false,
                },
                editor: EditorPreferences {
                    font_size: 12,
                    word_wrap: true,
                },
            }
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
        async fn poll(&self) -> Value {
            self.ui(json!({"action":"control_poll","snapshot":self.snapshot()}))
                .await
                .unwrap()
        }
        fn pending(&self) -> Vec<u8> {
            let journal = Journal {
                old_revision: digest("= Saved\n\nHello.\n"),
                content: "Pending replacement".into(),
                review: Review::new("Pending replacement"),
                editor_receipt: None,
                history: None,
                prior_review: None,
                ownership: None,
            };
            let bytes = serde_json::to_vec(&journal).unwrap();
            fs::write(journal_path(&self.file), &bytes).unwrap();
            bytes
        }
    }

    #[tokio::test]
    async fn queued_document_job_never_rebinds_to_reenrolled_same_path() {
        let fixture = Fixture::new().await;
        let request = Uuid::new_v4().to_string();
        fixture
            .service
            .app_remote(
                "open_manuscript",
                json!({"requestId":request,"documentId":fixture.id}),
            )
            .unwrap();
        let jobs = fixture.poll().await;
        let ack = jobs["jobs"][0]["ackToken"].as_str().unwrap();
        let source = fs::read(&fixture.file).unwrap();
        fixture
            .service
            .retire_source_for_test(&fixture.project, "main.typ")
            .unwrap();
        for action in ["control_check", "control_open"] {
            assert_eq!(
                fixture
                    .ui(json!({"action":action,"requestId":request,"ackToken":ack}))
                    .await
                    .unwrap_err()
                    .code,
                "scope"
            );
        }
        let enrolled = fixture
            .service
            .local_source(crate::SourceRequest {
                operation: Operation::Share {
                    project: fixture.project.clone(),
                    path: "main.typ".into(),
                    enabled: true,
                },
                source_epoch: 1,
                expected_root: None,
            })
            .unwrap();
        assert_ne!(enrolled["documentId"], fixture.id);
        for action in ["control_check", "control_open"] {
            assert_eq!(
                fixture
                    .ui(json!({"action":action,"requestId":request,"ackToken":ack}))
                    .await
                    .unwrap_err()
                    .code,
                "scope"
            );
        }
        let snapshot = fixture
            .service
            .read_control_snapshot(enrolled["documentId"].as_str().unwrap())
            .unwrap();
        assert_eq!(snapshot["sourceEpoch"], 1);
        assert!(snapshot["sidecarRevision"].is_null());
        assert_eq!(fs::read(&fixture.file).unwrap(), source);
        assert!(!sidecar(&fixture.file).exists());
        assert!(!journal_path(&fixture.file).exists());
    }

    #[tokio::test]
    async fn positive_epoch_app_compile_and_replay_verify_the_captured_artifact_identity() {
        let mut fixture = Fixture::new().await;
        fixture
            .service
            .retire_source_for_test(&fixture.project, "main.typ")
            .unwrap();
        let enrolled = fixture
            .service
            .local_source(crate::SourceRequest {
                operation: Operation::Share {
                    project: fixture.project.clone(),
                    path: "main.typ".into(),
                    enabled: true,
                },
                source_epoch: 1,
                expected_root: None,
            })
            .unwrap();
        fixture.id = enrolled["documentId"].as_str().unwrap().into();
        fixture.poll().await;
        let request = Uuid::new_v4().to_string();
        fixture.service.app_remote("compile_manuscript",json!({"requestId":request,"documentId":fixture.id,"revision":digest("= Saved\n\nHello.\n")})).unwrap();
        let jobs = fixture.poll().await;
        let ack = jobs["jobs"][0]["ackToken"].as_str().unwrap();
        let source = fs::read(&fixture.file).unwrap();
        let result = fixture
            .ui(json!({"action":"control_compile","requestId":request,"ackToken":ack}))
            .await
            .unwrap();
        assert_eq!(result["sourceEpoch"], 1);
        assert_eq!(result["current"], true);
        let info = fixture.service.state.join("pdfs").join(format!(
            "{}.json",
            digest(&format!("{}:main.typ", fixture.project))
        ));
        let mut metadata: Value = serde_json::from_slice(&fs::read(&info).unwrap()).unwrap();
        metadata["source_epoch"] = json!(2);
        fs::write(&info, serde_json::to_vec(&metadata).unwrap()).unwrap();
        assert_eq!(
            fixture
                .ui(json!({"action":"control_compile","requestId":request,"ackToken":ack}))
                .await
                .unwrap_err()
                .code,
            "stale"
        );
        assert_eq!(fs::read(&fixture.file).unwrap(), source);
        assert!(!sidecar(&fixture.file).exists());
    }

    #[tokio::test]
    async fn callbacks_and_grants_are_ui_only_and_page_epoch_bound() {
        let fixture = Fixture::new().await;
        for caller in [CallerContext::LocalCli, CallerContext::Review] {
            for input in [
                json!({"action":"control_enable","enabled":true}),
                json!({"action":"control_poll","snapshot":fixture.snapshot()}),
                json!({"action":"control_check","requestId":"job","ackToken":"forged"}),
                json!({"action":"control_complete","requestId":"job","ackToken":"forged","outcome":{"state":"applied","result":{}}}),
                json!({"action":"control_compile","requestId":"job","ackToken":"forged"}),
                json!({"action":"control_open","requestId":"job","ackToken":"forged"}),
            ] {
                assert_eq!(
                    fixture
                        .service
                        .control_as(
                            caller,
                            &fixture.owner,
                            serde_json::from_value(input).unwrap()
                        )
                        .await
                        .unwrap_err()
                        .code,
                    "scope"
                );
            }
        }
        fixture.service.connect_native_editor("main").unwrap();
        assert_eq!(
            fixture.poll_stale().await.unwrap_err().code,
            "stale_session"
        );
        assert_eq!(
            fixture.service.app_control_status().unwrap()["enabled"],
            false
        );
        assert_eq!(
            fs::read_to_string(&fixture.file).unwrap(),
            "= Saved\n\nHello.\n"
        );
    }
    impl Fixture {
        async fn poll_stale(&self) -> Result<Value> {
            self.ui(json!({"action":"control_poll","snapshot":self.snapshot()}))
                .await
        }
    }

    #[tokio::test]
    async fn workspace_and_generic_acknowledgements_never_disclose_unshared_data() {
        let fixture = Fixture::new().await;
        let mut snapshot = fixture.snapshot();
        snapshot.active_document_id = Some("unshared-private-id".into());
        fixture
            .ui(json!({"action":"control_poll","snapshot":snapshot}))
            .await
            .unwrap();
        let workspace = fixture
            .service
            .app_remote("get_workspace", json!({}))
            .unwrap();
        assert!(!workspace.to_string().contains("unshared"));
        assert!(workspace["workspace"]["preview"].is_null());
        assert!(workspace["workspace"]["activeDocumentId"].is_null());
        assert_eq!(
            fixture
                .service
                .app_remote("set_preview_view", json!({"requestId":"preview","page":2}))
                .unwrap_err()
                .code,
            "scope"
        );
        fixture
            .service
            .app_remote(
                "set_editor_preferences",
                json!({"requestId":"preferences","fontSize":16}),
            )
            .unwrap();
        let poll = fixture.poll().await;
        let token = poll["jobs"][0]["ackToken"].as_str().unwrap();
        fixture
            .ui(json!({"action":"control_check","requestId":"preferences","ackToken":token}))
            .await
            .unwrap();
        let receipt=fixture.ui(json!({"action":"control_complete","requestId":"preferences","ackToken":token,"outcome":{"state":"applied","result":{"workspace":snapshot,"path":"/private/not-shared","secret":"do-not-return"}}})).await.unwrap();
        for private in ["unshared", "/private", "do-not-return", token] {
            assert!(!receipt.to_string().contains(private));
        }
        let remote = fixture
            .service
            .app_remote("get_control_result", json!({"requestId":"preferences"}))
            .unwrap();
        assert_eq!(remote["result"], json!({"applied":true}));
        assert!(fixture
            .service
            .app_remote(
                "open_manuscript",
                json!({"requestId":"private","documentId":"unshared-private-id"})
            )
            .is_err());
        fixture
            .ui(json!({"action":"control_enable","enabled":false}))
            .await
            .unwrap();
        assert!(fixture
            .service
            .app_remote("get_control_result", json!({"requestId":"preferences"}))
            .is_err());
    }

    #[tokio::test]
    async fn app_and_review_reads_never_recover_pending_journals_or_create_sidecars() {
        let fixture = Fixture::new().await;
        for read in [
            fixture
                .service
                .app_remote("read_manuscript", json!({"documentId":fixture.id})),
            fixture
                .service
                .remote("read_manuscript", json!({"documentId":fixture.id})),
        ] {
            assert!(read.is_ok());
            assert!(!sidecar(&fixture.file).exists());
        }
        let sidecar_bytes = serde_json::to_vec(&Review::new("= Saved\n\nHello.\n")).unwrap();
        fs::write(sidecar(&fixture.file), &sidecar_bytes).unwrap();
        let bytes = fixture.pending();
        let proposal = json!({"documentId":fixture.id,"proposal":{"requestId":"pending-proposal","revision":digest("= Saved\n\nHello.\n"),"from":9,"to":14,"quote":"Hello","replacement":"Hi","rationale":"Shorter"}});
        for result in [
            fixture
                .service
                .app_remote("read_manuscript", json!({"documentId":fixture.id})),
            fixture
                .service
                .remote("read_manuscript", json!({"documentId":fixture.id})),
            fixture.service.remote("suggest_text", proposal),
        ] {
            assert_eq!(result.unwrap_err().code, "busy");
        }
        for name in ["open_manuscript", "compile_manuscript"] {
            let mut arguments = json!({"requestId":name,"documentId":fixture.id});
            if name == "compile_manuscript" {
                arguments["revision"] = json!(digest("= Saved\n\nHello.\n"));
            }
            assert!(matches!(
                fixture
                    .service
                    .app_remote(name, arguments)
                    .unwrap_err()
                    .code,
                "busy" | "stale"
            ));
        }
        assert_eq!(
            fs::read_to_string(&fixture.file).unwrap(),
            "= Saved\n\nHello.\n"
        );
        assert_eq!(fs::read(sidecar(&fixture.file)).unwrap(), sidecar_bytes);
        let unchanged = Review::new("= Saved\n\nHello.\n");
        assert_eq!(
            fixture
                .service
                .persist(
                    &fixture.project,
                    "main.typ",
                    &fixture.file,
                    Some("= Saved\n\nHello.\n"),
                    "= Saved\n\nHello.\n",
                    &unchanged
                )
                .unwrap_err()
                .code,
            "busy"
        );
        assert_eq!(fs::read(sidecar(&fixture.file)).unwrap(), sidecar_bytes);
        assert_eq!(fs::read(journal_path(&fixture.file)).unwrap(), bytes);
        assert_eq!(
            fixture
                .service
                .local(Operation::Open {
                    project: fixture.project.clone(),
                    path: "main.typ".into(),
                })
                .unwrap_err()
                .code,
            "recovery_conflict",
            "A legacy journal cannot replace a different observed sidecar."
        );
        assert_eq!(fs::read(sidecar(&fixture.file)).unwrap(), sidecar_bytes);
        assert_eq!(fs::read(journal_path(&fixture.file)).unwrap(), bytes);
        let mut journal: Journal = serde_json::from_slice(&bytes).unwrap();
        journal.prior_review = Some(policy_continuity::ReviewObservation::of(Some(
            std::str::from_utf8(&sidecar_bytes).unwrap(),
        )));
        journal.ownership = Some(journal_ownership::JournalOwnership {
            project: fixture.project.clone(),
            path: "main.typ".into(),
            source_epoch: 0,
            expected_root: None,
            owns_source: true,
        });
        fs::write(
            journal_path(&fixture.file),
            serde_json::to_vec_pretty(&journal).unwrap(),
        )
        .unwrap();
        let recovered = fixture
            .service
            .local(Operation::Open {
                project: fixture.project.clone(),
                path: "main.typ".into(),
            })
            .unwrap();
        assert_eq!(recovered["content"], "Pending replacement");
    }

    #[tokio::test]
    async fn pending_journal_between_dequeue_and_native_open_or_compile_is_preserved() {
        for tool in ["open_manuscript", "compile_manuscript"] {
            let fixture = Fixture::new().await;
            let mut arguments = json!({"requestId":"bound","documentId":fixture.id});
            if tool == "compile_manuscript" {
                arguments["revision"] = json!(digest("= Saved\n\nHello.\n"));
            }
            fixture.service.app_remote(tool, arguments).unwrap();
            let poll = fixture.poll().await;
            let token = poll["jobs"][0]["ackToken"].as_str().unwrap();
            let bytes = fixture.pending();
            let action = if tool == "open_manuscript" {
                "control_open"
            } else {
                "control_compile"
            };
            assert!(fixture
                .ui(json!({"action":action,"requestId":"bound","ackToken":token}))
                .await
                .is_err());
            assert_eq!(
                fs::read_to_string(&fixture.file).unwrap(),
                "= Saved\n\nHello.\n"
            );
            assert!(!sidecar(&fixture.file).exists());
            assert_eq!(fs::read(journal_path(&fixture.file)).unwrap(), bytes);
        }
    }

    #[tokio::test]
    async fn read_only_open_returns_snapshot_without_metadata_adoption() {
        let fixture = Fixture::new().await;
        fixture
            .service
            .app_remote(
                "open_manuscript",
                json!({"requestId":"open","documentId":fixture.id}),
            )
            .unwrap();
        let poll = fixture.poll().await;
        let token = poll["jobs"][0]["ackToken"].as_str().unwrap();
        let opened = fixture
            .ui(json!({"action":"control_open","requestId":"open","ackToken":token}))
            .await
            .unwrap();
        assert_eq!(opened["content"], "= Saved\n\nHello.\n");
        assert!(!sidecar(&fixture.file).exists());
        assert!(fixture
            .ui(json!({"action":"control_compile","requestId":"open","ackToken":token}))
            .await
            .is_err());
        fixture
            .service
            .local(Operation::Share {
                project: fixture.project.clone(),
                path: "main.typ".into(),
                enabled: false,
            })
            .unwrap();
        assert!(fixture
            .ui(json!({"action":"control_check","requestId":"open","ackToken":token}))
            .await
            .is_err());
        assert!(fixture
            .service
            .app_remote("get_control_result", json!({"requestId":"open"}))
            .is_err());
    }

    #[tokio::test]
    async fn native_compile_replay_never_rebuilds_or_returns_a_replaced_artifact() {
        if std::env::var_os("UNDERTREE_TYPST").is_none() {
            return;
        }
        let fixture = Fixture::new().await;
        let source = "#let title = read(\"data.txt\")\n#title\n";
        fs::write(&fixture.file, source).unwrap();
        let data = fixture.file.parent().unwrap().join("data.txt");
        fs::write(&data, "First artifact").unwrap();
        let revision = digest(source);
        let mut snapshot = fixture.snapshot();
        snapshot.open_documents[0].revision = revision.clone();
        fixture
            .ui(json!({"action":"control_poll","snapshot":snapshot}))
            .await
            .unwrap();
        fixture
            .service
            .app_remote(
                "compile_manuscript",
                json!({"requestId":"build","documentId":fixture.id,"revision":revision}),
            )
            .unwrap();
        let poll = fixture
            .ui(json!({"action":"control_poll","snapshot":snapshot}))
            .await
            .unwrap();
        let token = poll["jobs"][0]["ackToken"].as_str().unwrap();
        let operation = || json!({"action":"control_compile","requestId":"build","ackToken":token});
        let first = fixture.ui(operation()).await.unwrap();
        assert_eq!(first["available"], true);
        assert!(!sidecar(&fixture.file).exists());
        fn files(path: &Path) -> BTreeMap<PathBuf, (String, std::time::SystemTime)> {
            let mut result = BTreeMap::new();
            for entry in fs::read_dir(path).unwrap() {
                let entry = entry.unwrap();
                if entry.file_type().unwrap().is_dir() {
                    result.extend(files(&entry.path()));
                } else {
                    let bytes = fs::read(entry.path()).unwrap();
                    result.insert(
                        entry.path(),
                        (
                            digest(&String::from_utf8_lossy(&bytes)),
                            entry.metadata().unwrap().modified().unwrap(),
                        ),
                    );
                }
            }
            result
        }
        let before = files(fixture.service.publishing_root());
        let replay = fixture.ui(operation()).await.unwrap();
        assert_eq!(replay["base64"], first["base64"]);
        assert_eq!(before, files(fixture.service.publishing_root()));
        fs::write(&data, "Second artifact").unwrap();
        let replaced = fixture
            .service
            .compile_typst(&fixture.project, "main.typ", &revision)
            .await
            .unwrap();
        assert_ne!(replaced["base64"], first["base64"]);
        assert_eq!(fixture.ui(operation()).await.unwrap_err().code, "stale");
        fixture.ui(json!({"action":"control_complete","requestId":"build","ackToken":token,"outcome":{"state":"applied","result":{"base64":"must-not-leak"}}})).await.unwrap();
        let receipt = fixture
            .service
            .app_remote("get_control_result", json!({"requestId":"build"}))
            .unwrap();
        assert_eq!(
            receipt["result"]["artifactId"],
            digest(first["base64"].as_str().unwrap())
        );
        assert!(receipt["result"].get("base64").is_none());
        assert_eq!(fs::read_to_string(&fixture.file).unwrap(), source);
        assert!(!sidecar(&fixture.file).exists());
    }

    #[tokio::test]
    async fn unshare_then_reshare_cannot_restore_old_app_jobs_or_capability() {
        let fixture = Fixture::new().await;
        let previous = fixture.service.app_control_status().unwrap();
        fixture
            .service
            .app_remote(
                "open_manuscript",
                json!({"requestId":"old-open","documentId":fixture.id}),
            )
            .unwrap();
        let poll = fixture.poll().await;
        let token = poll["jobs"][0]["ackToken"].as_str().unwrap();
        fixture
            .service
            .local(Operation::Share {
                project: fixture.project.clone(),
                path: "main.typ".into(),
                enabled: false,
            })
            .unwrap();
        let reshared = fixture
            .service
            .local(Operation::Share {
                project: fixture.project.clone(),
                path: "main.typ".into(),
                enabled: true,
            })
            .unwrap();
        assert_eq!(reshared["documentId"], fixture.id);
        for action in ["control_check", "control_open"] {
            assert_eq!(
                fixture
                    .ui(json!({"action":action,"requestId":"old-open","ackToken":token}))
                    .await
                    .unwrap_err()
                    .code,
                "scope"
            );
        }
        assert_eq!(
            fixture.service.app_control_status().unwrap()["enabled"],
            false
        );
        let next = fixture
            .ui(json!({"action":"control_enable","enabled":true}))
            .await
            .unwrap();
        assert_ne!(next["endpoint"], previous["endpoint"]);
        assert_ne!(next["generation"], previous["generation"]);
        fixture.poll().await;
        for action in ["control_check", "control_open"] {
            assert!(fixture
                .ui(json!({"action":action,"requestId":"old-open","ackToken":token}))
                .await
                .is_err());
        }
        assert!(fixture
            .service
            .app_remote("get_control_result", json!({"requestId":"old-open"}))
            .is_err());
        assert_eq!(
            fs::read_to_string(&fixture.file).unwrap(),
            "= Saved\n\nHello.\n"
        );
        assert!(!sidecar(&fixture.file).exists());
    }

    async fn focus_job(fixture: &Fixture) -> String {
        fixture
            .service
            .app_remote(
                "set_window_state",
                json!({"requestId":"focus-contention","state":"focus"}),
            )
            .unwrap();
        fixture.poll().await["jobs"][0]["ackToken"]
            .as_str()
            .unwrap()
            .into()
    }

    fn spawn_check(fixture: &Fixture, token: &str) -> tokio::task::JoinHandle<Result<Value>> {
        let service = fixture.service.clone();
        let owner = fixture.owner.clone();
        let token = token.to_owned();
        tokio::spawn(async move {
            service
                .control_as(
                    CallerContext::Local,
                    &owner,
                    ControlOperation::ControlCheck {
                        request_id: "focus-contention".into(),
                        ack_token: token,
                    },
                )
                .await
        })
    }

    #[tokio::test]
    async fn held_tunnel_before_first_and_final_check_waits_without_repeating_effect() {
        let fixture = Fixture::new().await;
        let token = focus_job(&fixture).await;
        let mut effects = 0;
        for final_check in [false, true] {
            let held = fixture.service.tunnel.lock().await;
            let mut checking = spawn_check(&fixture, &token);
            // This timer running on the same current-thread runtime proves the wait is off-loop.
            assert!(
                tokio::time::timeout(std::time::Duration::from_millis(50), &mut checking)
                    .await
                    .is_err()
            );
            assert_eq!(effects, usize::from(final_check));
            drop(held);
            assert_eq!(checking.await.unwrap().unwrap()["authorized"], true);
            if !final_check {
                effects += 1;
            }
        }
        let receipt=fixture.ui(json!({"action":"control_complete","requestId":"focus-contention","ackToken":token,"outcome":{"state":"applied","result":{"state":"focused"}}})).await.unwrap();
        assert_eq!(receipt["state"], "applied");
        assert_eq!(effects, 1);
        assert_eq!(
            fixture
                .service
                .app_remote(
                    "get_control_result",
                    json!({"requestId":"focus-contention"})
                )
                .unwrap()["state"],
            "applied"
        );
        assert_eq!(
            fs::read_to_string(&fixture.file).unwrap(),
            "= Saved\n\nHello.\n"
        );
        assert!(!sidecar(&fixture.file).exists());
    }

    #[tokio::test]
    async fn revocation_while_first_or_final_check_waits_never_returns_authorized() {
        for after_effect in [false, true] {
            let fixture = Fixture::new().await;
            let token = focus_job(&fixture).await;
            let mut effects = 0;
            if after_effect {
                assert_eq!(
                    spawn_check(&fixture, &token).await.unwrap().unwrap()["authorized"],
                    true
                );
                effects += 1;
            }
            let held = fixture.service.tunnel.lock().await;
            let mut checking = spawn_check(&fixture, &token);
            assert!(
                tokio::time::timeout(std::time::Duration::from_millis(50), &mut checking)
                    .await
                    .is_err()
            );
            fixture.service.revoke_app_controls().unwrap();
            drop(held);
            assert_eq!(checking.await.unwrap().unwrap_err().code, "scope");
            assert_eq!(effects, usize::from(after_effect));
            assert!(fixture
                .service
                .app_remote(
                    "get_control_result",
                    json!({"requestId":"focus-contention"})
                )
                .is_err());
            assert_eq!(
                fixture.service.app_control_status().unwrap()["enabled"],
                false
            );
        }
    }

    #[tokio::test]
    async fn tunnel_check_wait_is_finite_and_does_not_claim_an_applied_outcome() {
        let fixture = Fixture::new().await;
        let token = focus_job(&fixture).await;
        let held = fixture.service.tunnel.lock().await;
        let result = tokio::time::timeout(
            CONTROL_CHECK_WAIT + std::time::Duration::from_secs(3),
            spawn_check(&fixture, &token),
        )
        .await
        .unwrap()
        .unwrap();
        assert_eq!(result.unwrap_err().code, "outcome_unknown");
        assert_ne!(
            fixture
                .service
                .app_remote(
                    "get_control_result",
                    json!({"requestId":"focus-contention"})
                )
                .unwrap()["state"],
            "applied"
        );
        drop(held);
        assert_eq!(
            spawn_check(&fixture, &token).await.unwrap().unwrap()["authorized"],
            true
        );
    }
}
