//! Test fixtures exercise the same local preview/consent path as the editor.
use super::*;

impl Service {
    pub(crate) fn test_context_scope(&self, project: &str, path: &str) -> Option<String> {
        let preview = self
            .local_source(crate::SourceRequest {
                operation: Operation::ContextPreview {
                    project: project.into(),
                    path: path.into(),
                },
                source_epoch: self.source_epoch(project, path).ok()?,
                expected_root: None,
            })
            .ok()?;
        preview["scopeId"].as_str().map(str::to_owned)
    }
}
