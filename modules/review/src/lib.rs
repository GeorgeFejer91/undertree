pub mod capabilities;
pub mod control;
pub mod document;
pub mod instance;
pub mod publishing;
pub mod service;
pub mod tex_import;
pub mod transport;

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
    Palette {
        project: String,
        path: String,
        revision: String,
        rules: Vec<document::Rule>,
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
    } => ("share", "connection", true),
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
