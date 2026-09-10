use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Component, Path};

use serde::Serialize;

use crate::error::BoundaryError;

const MAX_MARKDOWN_BYTES: u64 = 1024 * 1024;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MarkdownConversionReport {
    pub markdown: String,
    pub typst: String,
    pub created: bool,
    pub original_preserved: bool,
}

/// Creates one editable Typst sibling from a Markdown source. The Markdown
/// source is read-only and an existing Typst sibling is never overwritten.
pub fn convert_markdown_file(
    root: &Path,
    relative: &str,
) -> Result<MarkdownConversionReport, BoundaryError> {
    let root = root.canonicalize().map_err(|_| unavailable())?;
    if !root.is_dir() {
        return Err(unavailable());
    }
    let relative_path = Path::new(relative);
    if relative_path.is_absolute()
        || relative_path
            .components()
            .any(|component| !matches!(component, Component::Normal(_)))
        || !relative_path
            .extension()
            .is_some_and(|extension| extension.eq_ignore_ascii_case("md"))
    {
        return Err(BoundaryError::project(
            "markdown_invalid_source",
            "Choose a relative .md document inside the selected project.",
        ));
    }
    let source = root
        .join(relative_path)
        .canonicalize()
        .map_err(|_| unavailable())?;
    if !source.starts_with(&root) || !source.is_file() {
        return Err(BoundaryError::project(
            "path_denied",
            "The Markdown document must remain inside the selected project.",
        ));
    }
    let metadata = source.metadata().map_err(|_| unavailable())?;
    if metadata.len() > MAX_MARKDOWN_BYTES {
        return Err(BoundaryError::project(
            "document_too_large",
            "Markdown-to-Typst conversion is limited to 1 MiB per document.",
        ));
    }
    let markdown = fs::read_to_string(&source).map_err(|_| {
        BoundaryError::project(
            "markdown_encoding",
            "The Markdown document must be valid UTF-8; its original bytes were not changed.",
        )
    })?;
    let destination = source.with_extension("typ");
    let destination_relative = destination
        .strip_prefix(&root)
        .ok()
        .and_then(Path::to_str)
        .ok_or_else(BoundaryError::internal)?
        .replace('\\', "/");
    let markdown_relative = relative_path
        .to_str()
        .ok_or_else(BoundaryError::internal)?
        .replace('\\', "/");
    if destination.exists() {
        return Ok(MarkdownConversionReport {
            markdown: markdown_relative,
            typst: destination_relative,
            created: false,
            original_preserved: true,
        });
    }

    let typst = markdown_to_typst(&markdown, &markdown_relative);
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&destination)
        .map_err(|_| {
            BoundaryError::project(
                "conversion_write_failed",
                "UnderTree could not create the Typst companion without replacing an existing file.",
            )
        })?;
    file.write_all(typst.as_bytes()).map_err(|_| {
        BoundaryError::project(
            "conversion_write_failed",
            "UnderTree could not write the Typst companion safely.",
        )
    })?;
    file.sync_all().map_err(|_| {
        BoundaryError::project(
            "conversion_write_failed",
            "UnderTree could not finish writing the Typst companion safely.",
        )
    })?;
    Ok(MarkdownConversionReport {
        markdown: markdown_relative,
        typst: destination_relative,
        created: true,
        original_preserved: true,
    })
}

fn markdown_to_typst(markdown: &str, source: &str) -> String {
    let mut output = format!(
        "// UnderTree Markdown conversion draft — review before publication.\n// Original Markdown preserved at: {source}\n#set page(paper: \"a4\", margin: 24mm)\n#set text(size: 10.5pt)\n#set heading(numbering: \"1.\")\n\n"
    );
    let mut in_comment = false;
    let mut in_fence = false;
    let mut fence = String::new();
    for line in markdown.lines() {
        let trimmed = line.trim();
        if in_comment {
            if trimmed.contains("-->") {
                in_comment = false;
            }
            continue;
        }
        if trimmed.starts_with("<!--") {
            if !trimmed.contains("-->") {
                in_comment = true;
            }
            continue;
        }
        if let Some(language) = trimmed.strip_prefix("```") {
            if in_fence {
                output.push_str("```\n");
                in_fence = false;
                fence.clear();
            } else {
                fence = language.trim().to_owned();
                output.push_str("```");
                output.push_str(&fence);
                output.push('\n');
                in_fence = true;
            }
            continue;
        }
        if in_fence {
            output.push_str(line);
            output.push('\n');
            continue;
        }
        if trimmed == "---" || trimmed == "***" {
            output.push_str("#line(length: 100%)\n");
            continue;
        }
        if let Some((level, heading)) = markdown_heading(line) {
            output.push_str(&"=".repeat(level));
            output.push(' ');
            output.push_str(&inline_markup(heading));
            output.push('\n');
            continue;
        }
        if let Some(rest) = line.strip_prefix("> ") {
            output.push_str("#quote(block: true)[");
            output.push_str(&inline_markup(rest));
            output.push_str("]\n");
            continue;
        }
        let (prefix, content) = if let Some(rest) = line.strip_prefix("- ") {
            ("- ", rest)
        } else if let Some(rest) = line.strip_prefix("* ") {
            ("- ", rest)
        } else if numbered_item(line).is_some() {
            ("+ ", numbered_item(line).unwrap_or_default())
        } else {
            ("", line)
        };
        output.push_str(prefix);
        output.push_str(&inline_markup(content));
        output.push('\n');
    }
    if in_fence {
        output.push_str("```\n");
    }
    output
}

fn markdown_heading(line: &str) -> Option<(usize, &str)> {
    let hashes = line
        .chars()
        .take_while(|character| *character == '#')
        .count();
    (1..=6)
        .contains(&hashes)
        .then(|| {
            line.get(hashes..)?
                .strip_prefix(' ')
                .map(|text| (hashes, text))
        })
        .flatten()
}

fn numbered_item(line: &str) -> Option<&str> {
    let (number, rest) = line.split_once(". ")?;
    (!number.is_empty() && number.chars().all(|character| character.is_ascii_digit()))
        .then_some(rest)
}

fn inline_markup(line: &str) -> String {
    let mut output = String::with_capacity(line.len());
    let mut chars = line.chars().peekable();
    let mut in_code = false;
    while let Some(character) = chars.next() {
        if character == '`' {
            in_code = !in_code;
            output.push(character);
            continue;
        }
        if !in_code && character == '*' && chars.peek() == Some(&'*') {
            chars.next();
            output.push('*');
            continue;
        }
        if !in_code && character == '#' {
            output.push_str("\\#");
        } else if !in_code && character == '$' {
            output.push_str("\\$");
        } else if !in_code && character == '[' {
            output.push_str("\\[");
        } else if !in_code && character == ']' {
            output.push_str("\\]");
        } else if !in_code && character == '|' {
            output.push_str("\\|");
        } else {
            output.push(character);
        }
    }
    output
}

fn unavailable() -> BoundaryError {
    BoundaryError::project(
        "markdown_unavailable",
        "The selected Markdown document is unavailable.",
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn creates_a_typst_sibling_once_and_preserves_markdown() {
        let folder = tempfile::tempdir().expect("temporary project");
        let source = folder.path().join("proposal.md");
        fs::write(&source, "# Title\n\n**Status:** ready\n\n- One\n").expect("source");
        let report = convert_markdown_file(folder.path(), "proposal.md").expect("conversion");
        assert!(report.created);
        assert_eq!(
            fs::read_to_string(&source).expect("preserved source"),
            "# Title\n\n**Status:** ready\n\n- One\n"
        );
        let typst = fs::read_to_string(folder.path().join("proposal.typ")).expect("typst");
        assert!(typst.contains("= Title"));
        assert!(typst.contains("*Status:* ready"));
        assert!(
            !convert_markdown_file(folder.path(), "proposal.md")
                .expect("second conversion")
                .created
        );
    }
}
