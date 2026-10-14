pub mod document;
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

#[derive(Debug, Deserialize)]
#[serde(tag = "action", rename_all = "snake_case", deny_unknown_fields)]
pub enum Operation {
    Projects,
    AddProject {
        root: String,
    },
    Files {
        project: String,
    },
    Open {
        project: String,
        path: String,
    },
    Create {
        project: String,
        path: String,
    },
    Save {
        project: String,
        path: String,
        revision: String,
        content: String,
    },
    Review {
        project: String,
        path: String,
    },
    Palette {
        project: String,
        path: String,
        revision: String,
        rules: Vec<document::Rule>,
    },
    Mark {
        project: String,
        path: String,
        revision: String,
        from: usize,
        to: usize,
        rule: String,
        prompt: String,
    },
    Unmark {
        project: String,
        path: String,
        revision: String,
        id: String,
    },
    Decide {
        project: String,
        path: String,
        revision: String,
        id: String,
        decision: document::Decision,
    },
    Share {
        project: String,
        path: String,
        enabled: bool,
    },
    Tunnel {
        enabled: bool,
        reservation: String,
        public_url: String,
    },
    Connection,
    GitStatus {
        project: String,
    },
    BindGithub {
        project: String,
        repository: String,
        auto_sync: bool,
    },
    Sync {
        project: String,
    },
    Compile {
        project: String,
        path: String,
        revision: String,
    },
    Pdf {
        project: String,
        path: String,
    },
    ImportTex {
        project: String,
        path: String,
        target: String,
    },
}
