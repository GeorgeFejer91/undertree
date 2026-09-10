use serde::Serialize;

use crate::compiler::Diagnostic;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BoundaryError {
    pub code: &'static str,
    pub message: String,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub diagnostics: Vec<Diagnostic>,
}

impl BoundaryError {
    pub fn validation(message: impl Into<String>) -> Self {
        Self {
            code: "invalid_source",
            message: message.into(),
            diagnostics: Vec::new(),
        }
    }

    pub fn compilation(diagnostics: Vec<Diagnostic>) -> Self {
        Self {
            code: "compile_failed",
            message: "Typst could not compile the current document.".into(),
            diagnostics,
        }
    }

    pub fn internal() -> Self {
        Self {
            code: "internal_error",
            message: "UnderTree could not complete the operation.".into(),
            diagnostics: Vec::new(),
        }
    }

    pub fn project(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            diagnostics: Vec::new(),
        }
    }

    pub fn github(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            diagnostics: Vec::new(),
        }
    }
}
