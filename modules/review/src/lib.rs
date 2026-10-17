pub mod capabilities;
pub mod control;
pub mod document;
pub mod instance;
pub mod mcp_hub;
pub mod publishing;
mod root_observation;
pub use root_observation::RootObservation;
pub mod service;
pub mod tex_import;
pub mod transport;
pub mod word_count;
pub mod word_count_native;

use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Clone)]
pub struct Error {
    pub code: &'static str,
    pub message: String,
}

impl Error {
    pub fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}
impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.message)
    }
}
impl std::error::Error for Error {}
impl From<std::io::Error> for Error {
    fn from(_: std::io::Error) -> Self {
        Self::new(
            "io",
            "The local file or program is unavailable. Check permissions and installation.",
        )
    }
}
impl From<serde_json::Error> for Error {
    fn from(_: serde_json::Error) -> Self {
        Self::new(
            "format",
            "The review file or request is not valid JSON. It has been preserved.",
        )
    }
}
pub type Result<T> = std::result::Result<T, Error>;

pub const MAX_SOURCE_EPOCH: u64 = 9_007_199_254_740_991;

/// A captured source identity; it never grants a caller additional authority.
#[derive(Debug)]
pub struct SourceRequest {
    pub operation: Operation,
    pub source_epoch: u64,
    pub expected_root: Option<RootObservation>,
}

impl From<Operation> for SourceRequest {
    fn from(operation: Operation) -> Self {
        Self {
            operation,
            source_epoch: 0,
            expected_root: None,
        }
    }
}

impl<'de> Deserialize<'de> for SourceRequest {
    fn deserialize<D: serde::Deserializer<'de>>(
        deserializer: D,
    ) -> std::result::Result<Self, D::Error> {
        struct RequestVisitor;
        impl<'de> serde::de::Visitor<'de> for RequestVisitor {
            type Value = SourceRequest;
            fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                formatter.write_str("a typed product operation with a captured source epoch")
            }
            fn visit_map<M: serde::de::MapAccess<'de>>(
                self,
                mut map: M,
            ) -> std::result::Result<Self::Value, M::Error> {
                use serde::de::Error;
                let mut names = std::collections::BTreeSet::new();
                let mut epoch = None;
                let mut root = None;
                let mut operation = String::from("{");
                while let Some(name) = map.next_key::<String>()? {
                    if names.len() >= 16 {
                        return Err(M::Error::custom("Too many product operation fields."));
                    }
                    if !names.insert(name.clone()) {
                        return Err(M::Error::custom("Duplicate product operation field."));
                    }
                    let raw = map.next_value::<Box<serde_json::value::RawValue>>()?;
                    if name == "sourceEpoch" {
                        let value: u64 =
                            serde_json::from_str(raw.get()).map_err(M::Error::custom)?;
                        if value > MAX_SOURCE_EPOCH {
                            return Err(M::Error::custom(
                                "Source epoch exceeds its supported range.",
                            ));
                        }
                        epoch = Some(value);
                    } else if name == "expectedRoot" {
                        root = Some(
                            serde_json::from_str::<RootObservation>(raw.get())
                                .map_err(M::Error::custom)?,
                        );
                    } else {
                        if operation.len() > 1 {
                            operation.push(',');
                        }
                        operation
                            .push_str(&serde_json::to_string(&name).map_err(M::Error::custom)?);
                        operation.push(':');
                        operation.push_str(raw.get());
                    }
                }
                operation.push('}');
                // Preserve raw nested JSON so Operation's strict nested serde validation still runs.
                let operation: Operation =
                    serde_json::from_str(&operation).map_err(M::Error::custom)?;
                if matches!(
                    operation,
                    Operation::Capabilities
                        | Operation::Projects
                        | Operation::Connection
                        | Operation::HubStatus
                ) && names.len() != 1
                {
                    return Err(M::Error::custom("This operation takes no extra fields."));
                }
                if epoch.is_some() && operation.source_target().is_none() {
                    return Err(M::Error::custom(
                        "This operation has no source epoch precondition.",
                    ));
                }
                if root.is_some()
                    && operation.source_target().is_none()
                    && !matches!(
                        operation,
                        Operation::ProjectTree { .. }
                            | Operation::Create { .. }
                            | Operation::CreateDirectory { .. }
                    )
                {
                    return Err(M::Error::custom(
                        "This operation has no project root precondition.",
                    ));
                }
                Ok(SourceRequest {
                    operation,
                    source_epoch: epoch.unwrap_or(0),
                    expected_root: root,
                })
            }
        }
        deserializer.deserialize_map(RequestVisitor)
    }
}

// One declaration supplies the local JSON contract and its discoverable capability inventory.
macro_rules! operations {
    ($($variant:ident $({ $($(#[$field_meta:meta])* $field:ident: $kind:ty),* $(,)? })? =>
        ($action:literal, $group:literal, $mutates:literal)),* $(,)?) => {
        #[derive(Debug, Deserialize)]
        #[serde(tag = "action", deny_unknown_fields)]
        pub enum Operation {
            $(#[serde(rename = $action)]
              $variant $({ $($(#[$field_meta])* $field: $kind),* })?),*
        }

        impl Operation {
            pub fn mutates(&self) -> bool {
                match self {
                    $(Self::$variant $({ $($field: _),* })? => $mutates),*
                }
            }
        }

        pub const LOCAL_OPERATIONS: &[capabilities::OperationCapability] = &[
            $(capabilities::OperationCapability {
                action: $action, group: $group, mutates: $mutates,
            }),*
        ];
    };
}

operations! {
    Capabilities => ("capabilities", "discovery", false),
    Projects => ("projects", "projects", false),
    AddProject {
        root: String,
    } => ("add_project", "project_access", true),
    SetMainDocument {
        project: String,
        path: String,
    } => ("set_main_document", "publishing", true),
    Files {
        project: String,
    } => ("files", "files", false),
    ProjectTree {
        project: String,
    } => ("project_tree", "files", false),
    CreateDirectory {
        project: String,
        path: String,
    } => ("create_directory", "files", true),
    Open {
        project: String,
        path: String,
    } => ("open", "documents", false),
    Create {
        project: String,
        path: String,
    } => ("create", "files", true),
    Save {
        project: String,
        path: String,
        revision: String,
        content: String,
    } => ("save", "documents", true),
    SaveEditor {
        project: String,
        path: String,
        #[serde(rename = "requestId")]
        request_id: String,
    } => ("save_editor", "editor_sessions", true),
    SaveReceipt {
        #[serde(rename = "requestId")]
        request_id: String,
    } => ("save_receipt", "editor_sessions", false),
    Review {
        project: String,
        path: String,
    } => ("review", "review", false),
    HubStatus => ("hub_status", "connections", false),
    HubEnable {
        enabled: bool,
    } => ("hub_enable", "connections", true),
    HubLink {
        label: String,
        url: String,
    } => ("hub_link", "connections", true),
    HubUnlink {
        id: String,
    } => ("hub_unlink", "connections", true),
    Palette {
        project: String,
        path: String,
        revision: String,
        rules: Vec<document::Rule>,
        #[serde(rename = "expectedRules", default)]
        expected_rules: Option<Vec<document::Rule>>,
    } => ("palette", "review_policy", true),
    Mark {
        project: String,
        path: String,
        revision: String,
        from: usize,
        to: usize,
        rule: String,
        prompt: String,
    } => ("mark", "review_policy", true),
    Reanchor {
        project: String,
        path: String,
        revision: String,
        id: String,
        from: usize,
        to: usize,
        quote: String,
    } => ("reanchor", "review_policy", true),
    PdfMark {
        project: String,
        path: String,
        revision: String,
        identity: String,
        #[serde(rename = "pdfPath")]
        pdf_path: String,
        segments: Vec<document::PdfSegment>,
        rule: String,
        prompt: String,
        #[serde(rename = "sourceFrom", default)]
        source_from: Option<usize>,
        #[serde(rename = "sourceTo", default)]
        source_to: Option<usize>,
    } => ("pdf_mark", "review_policy", true),
    PdfAnnotations {
        project: String,
        path: String,
        identity: String,
    } => ("pdf_annotations", "review_policy", false),
    PdfUnmark {
        project: String,
        path: String,
        revision: String,
        id: String,
    } => ("pdf_unmark", "review_policy", true),
    Unmark {
        project: String,
        path: String,
        revision: String,
        id: String,
    } => ("unmark", "review_policy", true),
    Decide {
        project: String,
        path: String,
        revision: String,
        id: String,
        decision: document::Decision,
    } => ("decide", "review_decisions", true),
    Share {
        project: String,
        path: String,
        enabled: bool,
        #[serde(default, rename = "contextShared")]
        context_shared: bool,
        #[serde(default, rename = "expectedContextScope")]
        expected_context_scope: Option<String>,
    } => ("share", "connection", true),
    ContextPreview {
        project: String,
        path: String,
    } => ("context_preview", "review_context", false),
    Tunnel {
        enabled: bool,
        reservation: String,
        public_url: String,
    } => ("tunnel", "connection", true),
    Connection => ("connection", "connection", false),
    GitStatus {
        project: String,
    } => ("git_status", "synchronization", false),
    BindGithub {
        project: String,
        repository: String,
        auto_sync: bool,
    } => ("bind_github", "synchronization", true),
    Sync {
        project: String,
    } => ("sync", "synchronization", true),
    Compile {
        project: String,
        path: String,
        revision: String,
    } => ("compile", "publishing", true),
    Pdf {
        project: String,
        path: String,
    } => ("pdf", "publishing", false),
    ImportTex {
        project: String,
        path: String,
        target: String,
    } => ("import_tex", "files", true),
}

impl Operation {
    pub(crate) fn source_target(&self) -> Option<(&str, &str)> {
        match self {
            Self::Open { project, path }
            | Self::Review { project, path }
            | Self::Save { project, path, .. }
            | Self::Palette { project, path, .. }
            | Self::Mark { project, path, .. }
            | Self::PdfMark { project, path, .. }
            | Self::PdfUnmark { project, path, .. }
            | Self::PdfAnnotations { project, path, .. }
            | Self::Unmark { project, path, .. }
            | Self::Reanchor { project, path, .. }
            | Self::Decide { project, path, .. }
            | Self::Share { project, path, .. }
            | Self::ContextPreview { project, path, .. }
            | Self::Compile { project, path, .. }
            | Self::Pdf { project, path }
            | Self::ImportTex { project, path, .. } => Some((project, path)),
            Self::SetMainDocument { project, path } if !path.is_empty() => Some((project, path)),
            _ => None,
        }
    }

    pub(crate) fn requires_source_epoch(&self) -> bool {
        self.source_target().is_some()
            && !matches!(
                self,
                Self::Review { .. }
                    | Self::Pdf { .. }
                    | Self::PdfAnnotations { .. }
                    | Self::Share { enabled: false, .. }
            )
    }
}

#[cfg(test)]
mod source_request_tests {
    use super::*;

    #[test]
    fn share_context_consent_uses_the_actual_camel_case_local_wire_contract() {
        let request: SourceRequest = serde_json::from_str(r#"{"action":"share","project":"p","path":"main.typ","enabled":true,"contextShared":true,"expectedContextScope":"reviewed-scope","sourceEpoch":0}"#).unwrap();
        assert!(matches!(&request.operation, Operation::Share { context_shared: true, expected_context_scope: Some(scope), .. } if scope == "reviewed-scope"));
        assert!(serde_json::from_str::<SourceRequest>(r#"{"action":"share","project":"p","path":"main.typ","enabled":true,"context_shared":true,"expected_context_scope":"reviewed-scope"}"#).is_err());
    }

    #[test]
    fn source_request_keeps_legacy_zero_and_accepts_exact_bounded_epochs() {
        let request: SourceRequest =
            serde_json::from_str(r#"{"action":"open","project":"p","path":"main.typ"}"#).unwrap();
        assert_eq!(request.source_epoch, 0);
        let request: SourceRequest = serde_json::from_str(
            r#"{"sourceEpoch":9007199254740991,"action":"open","project":"p","path":"main.typ"}"#,
        )
        .unwrap();
        assert_eq!(request.source_epoch, MAX_SOURCE_EPOCH);
        assert!(serde_json::from_str::<SourceRequest>(r#"{"action":"capabilities"}"#).is_ok());
    }

    #[test]
    fn source_request_rejects_malformed_outer_and_nested_json_without_value_normalization() {
        for epoch in [
            "null",
            "-1",
            "0.0",
            "1e0",
            "true",
            "\"1\"",
            "9007199254740992",
            "18446744073709551616",
        ] {
            assert!(
                serde_json::from_str::<SourceRequest>(&format!(
                    r#"{{"action":"open","project":"p","path":"main.typ","sourceEpoch":{epoch}}}"#
                ))
                .is_err(),
                "{epoch}"
            );
        }
        for request in [
            r#"{"action":"open","project":"p","path":"main.typ","sourceEpoch":0,"sourceEpoch":1}"#,
            r#"{"action":"open","project":"p","path":"main.typ","sourceEpoch":0,"sourceEpo\u0063h":1}"#,
            r#"{"action":"open","project":"p","project":"q","path":"main.typ"}"#,
            r#"{"action":"open","project":"p","path":"main.typ","unexpected":0}"#,
            r#"{"action":"capabilities","unexpected":0}"#,
            r#"{"action":"projects","sourceEpoch":0}"#,
            r#"{"action":"create","project":"p","path":"main.typ","sourceEpoch":0}"#,
            r##"{"action":"palette","project":"p","path":"main.typ","revision":"r","rules":[{"id":"r","label":"r","color":"#abcdef","action":"protect","prompt":"a","prompt":"b"}],"sourceEpoch":1}"##,
            r##"{"action":"palette","project":"p","path":"main.typ","revision":"r","rules":[{"id":"r","label":"r","color":"#abcdef","action":"protect","prompt":"a","unexpected":true}],"sourceEpoch":1}"##,
        ] {
            assert!(
                serde_json::from_str::<SourceRequest>(request).is_err(),
                "{request}"
            );
        }
    }
}
