use undertree_review::{service::Service, Operation};

/// Obtain local consent preview through the public authority; no test grant bypass.
pub fn context_scope(service: &Service, project: &str, path: &str) -> Option<String> {
    let preview = service
        .local(Operation::ContextPreview {
            project: project.into(),
            path: path.into(),
        })
        .ok()?;
    preview["scopeId"].as_str().map(str::to_owned)
}
