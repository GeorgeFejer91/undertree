//! One canonical editable-source grammar for held IO and private source bindings.
use crate::{Error, Result};
use std::path::Path;

pub(super) fn validate_source_path(relative: &str) -> Result<(&str, &str)> {
    if relative.is_empty() || relative.len() > 4096 || relative.split('/').count() > 32
        || relative.split('/').any(|part| part.is_empty() || part.starts_with('.') || part.len() > 255
            || matches!(part, "node_modules" | "For-AI")
            || part.chars().any(|c| c.is_control() || c == '\\' || matches!(c, '\u{2028}' | '\u{2029}' | '\u{200e}' | '\u{200f}' | '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{2069}' | '\u{feff}')))
        || !super::editable_source(Path::new(relative))
    { return Err(Error::new("path", "Choose a canonical editable source path inside the project.")); }
    let (parent, name) = relative.rsplit_once('/').unwrap_or(("", relative));
    if name.len() + ".undertree-pending.json".len() > 255
        || relative.len() + ".undertree-pending.json".len() > 4096
    {
        return Err(Error::new(
            "path",
            "The source path leaves no bounded space for its adjacent metadata.",
        ));
    }
    Ok((parent, name))
}
