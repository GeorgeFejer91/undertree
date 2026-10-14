use crate::document::{escape_typst, MAX_TEXT};
use crate::{Error, Result};
use serde::Serialize;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportResult {
    pub content: String,
    pub warnings: Vec<String>,
    pub exact_formatting: bool,
}

struct Parser<'a> {
    source: &'a str,
    cursor: usize,
    warnings: Vec<String>,
    depth: usize,
}

impl Parser<'_> {
    fn group(&mut self, open: char, close: char) -> Option<String> {
        let original = self.cursor;
        while self.source[self.cursor..].starts_with(char::is_whitespace) {
            self.cursor += self.source[self.cursor..].chars().next()?.len_utf8();
        }
        if !self.source[self.cursor..].starts_with(open) {
            self.cursor = original;
            return None;
        }
        self.cursor += open.len_utf8();
        let start = self.cursor;
        let mut nesting = 1;
        let mut escaped = false;
        for (offset, character) in self.source[start..].char_indices() {
            if escaped {
                escaped = false;
                continue;
            }
            if character == '\\' {
                escaped = true;
                continue;
            }
            if character == open {
                nesting += 1;
            }
            if character == close {
                nesting -= 1;
                if nesting == 0 {
                    self.cursor = start + offset + character.len_utf8();
                    return Some(self.source[start..start + offset].into());
                }
            }
        }
        self.cursor = original;
        None
    }

    fn warning(&mut self, text: String) {
        if self.warnings.contains(&text) {
            return;
        }
        if self.warnings.len() < 100 {
            self.warnings.push(text);
        } else {
            self.warnings[99] = "Additional unsupported constructs were omitted from this report; inspect the preserved original TeX file.".into();
        }
    }

    fn nested(&mut self, source: &str) -> String {
        if self.depth >= 20 {
            self.warning("Nesting deeper than 20 levels was preserved as raw text.".into());
            return raw(source);
        }
        let mut parser = Parser {
            source,
            cursor: 0,
            warnings: vec![],
            depth: self.depth + 1,
        };
        let text = parser.convert();
        for warning in parser.warnings {
            self.warning(warning);
        }
        text
    }

    fn through(&mut self, delimiter: &str) {
        while self.cursor < self.source.len() {
            if self.source[self.cursor..].starts_with(delimiter) {
                self.cursor += delimiter.len();
                return;
            }
            let character = self.source[self.cursor..].chars().next().unwrap_or('\0');
            self.cursor += character.len_utf8();
            if character == '\\' {
                if let Some(next) = self.source[self.cursor..].chars().next() {
                    self.cursor += next.len_utf8();
                }
            }
        }
        self.warning("An unterminated TeX construct was preserved as raw text.".into());
    }

    fn environment(&mut self, name: &str) {
        let begin = format!("\\begin{{{name}}}");
        let end = format!("\\end{{{name}}}");
        let mut nesting = 1;
        while self.cursor < self.source.len() {
            if self.source[self.cursor..].starts_with(&begin) {
                nesting += 1;
                self.cursor += begin.len();
            } else if self.source[self.cursor..].starts_with(&end) {
                nesting -= 1;
                self.cursor += end.len();
                if nesting == 0 {
                    return;
                }
            } else {
                self.cursor += self.source[self.cursor..]
                    .chars()
                    .next()
                    .unwrap_or('\0')
                    .len_utf8();
            }
        }
        self.warning(format!("Environment {name} had no matching end and was preserved through the end of the source."));
    }

    fn convert(&mut self) -> String {
        let mut result = String::new();
        let mut lists = Vec::new();
        while self.cursor < self.source.len() {
            let character = self.source[self.cursor..].chars().next().unwrap_or('\0');
            self.cursor += character.len_utf8();
            match character {
                '%' => {
                    if let Some(length) = self.source[self.cursor..].find('\n') {
                        self.cursor += length + 1;
                    } else {
                        self.cursor = self.source.len();
                    }
                }
                '{' => {
                    self.cursor -= 1;
                    if let Some(text) = self.group('{', '}') {
                        result.push_str(&self.nested(&text));
                    } else {
                        self.warning("An unmatched TeX group was preserved as raw text.".into());
                        result.push_str(&raw(&self.source[self.cursor..]));
                        self.cursor = self.source.len();
                    }
                }
                '$' => {
                    let start = self.cursor - 1;
                    let delimiter = if self.source[self.cursor..].starts_with('$') {
                        self.cursor += 1;
                        "$$"
                    } else {
                        "$"
                    };
                    self.through(delimiter);
                    self.warning("TeX math was preserved as raw text; translate and verify its Typst math syntax manually.".into());
                    result.push_str(&raw(&self.source[start..self.cursor]));
                }
                '~' => result.push('\u{a0}'),
                '\\' => {
                    let start = self.cursor - 1;
                    while self.cursor < self.source.len()
                        && self.source.as_bytes()[self.cursor].is_ascii_alphabetic()
                    {
                        self.cursor += 1;
                    }
                    if self.cursor == start + 1 {
                        if let Some(symbol) = self.source[self.cursor..].chars().next() {
                            self.cursor += symbol.len_utf8();
                            match symbol {
                                '\\' => result.push_str("#linebreak()\n"),
                                '(' | '[' => {
                                    self.through(if symbol == '(' { "\\)" } else { "\\]" });
                                    self.warning("TeX math was preserved as raw text; translate and verify its Typst math syntax manually.".into());
                                    result.push_str(&raw(&self.source[start..self.cursor]));
                                }
                                '%' | '$' | '{' | '}' | '_' | '&' | '#' | ' ' => {
                                    result.push_str(&escape_typst(&symbol.to_string()))
                                }
                                _ => {
                                    let _ = self.group('{', '}');
                                    self.warning(format!("Control symbol \\{symbol} was preserved as raw TeX; verify its meaning manually."));
                                    result.push_str(&raw(&self.source[start..self.cursor]));
                                }
                            }
                        } else {
                            result.push_str(&raw("\\"));
                            self.warning("A trailing backslash was preserved as raw text.".into());
                        }
                        continue;
                    }
                    let name = &self.source[start + 1..self.cursor];
                    if self.source[self.cursor..].starts_with('*') {
                        self.cursor += 1;
                    }
                    if name == "verb" {
                        if let Some(delimiter) = self.source[self.cursor..]
                            .chars()
                            .next()
                            .filter(|c| !c.is_whitespace())
                        {
                            self.cursor += delimiter.len_utf8();
                            if let Some(length) = self.source[self.cursor..].find(delimiter) {
                                self.cursor += length + delimiter.len_utf8();
                            } else {
                                self.cursor = self.source.len();
                            }
                        }
                        result.push_str(&raw(&self.source[start..self.cursor]));
                        self.warning("TeX verbatim commands were preserved as raw TeX.".into());
                        continue;
                    }
                    let optional = self.group('[', ']');
                    match name {
                        "section" | "subsection" | "subsubsection" | "chapter" => {
                            if let Some(title) = self.group('{', '}') {
                                let level = match name {
                                    "subsection" => 2,
                                    "subsubsection" => 3,
                                    _ => 1,
                                };
                                result.push_str(&format!(
                                    "\n\n{} {}\n\n",
                                    "=".repeat(level),
                                    self.nested(&title)
                                ));
                                if optional.is_some() {
                                    self.warning(
                                        "Optional short heading titles were omitted.".into(),
                                    );
                                }
                                continue;
                            }
                        }
                        "textbf" | "textit" | "emph" | "underline" | "texttt" => {
                            if let Some(text) = self.group('{', '}') {
                                let function = match name {
                                    "textbf" => "strong",
                                    "underline" => "underline",
                                    "texttt" => "raw",
                                    _ => "emph",
                                };
                                if function == "raw" {
                                    result.push_str(&raw(&text));
                                } else {
                                    result
                                        .push_str(&format!("#{function}[{}]", self.nested(&text)));
                                }
                                continue;
                            }
                        }
                        "begin" => {
                            if let Some(environment) = self.group('{', '}') {
                                match environment.as_str() {
                                    "document" => {}
                                    "itemize" | "enumerate" => {
                                        lists.push(if environment == "itemize" {
                                            '-'
                                        } else {
                                            '+'
                                        });
                                        result.push('\n');
                                    }
                                    _ => {
                                        self.environment(&environment);
                                        self.warning(format!("Environment {environment} was preserved as raw TeX; its layout requires manual translation."));
                                        result.push_str(&format!(
                                            "\n\n{}\n\n",
                                            raw(&self.source[start..self.cursor])
                                        ));
                                    }
                                }
                                continue;
                            }
                        }
                        "end" => {
                            if let Some(environment) = self.group('{', '}') {
                                let expected = match environment.as_str() {
                                    "itemize" => Some('-'),
                                    "enumerate" => Some('+'),
                                    _ => None,
                                };
                                if environment == "document" {
                                    continue;
                                }
                                if expected.is_some() && lists.last().copied() == expected {
                                    lists.pop();
                                    result.push('\n');
                                    continue;
                                }
                                self.warning(format!("Unmatched environment end {environment} was preserved as raw TeX."));
                            }
                        }
                        "item" => {
                            if let Some(marker) = lists.last() {
                                result.push_str(&format!(
                                    "\n{}{marker} ",
                                    "  ".repeat(lists.len() - 1)
                                ));
                                if let Some(label) = optional {
                                    result.push_str(&self.nested(&label));
                                    result.push(' ');
                                    self.warning("Custom list labels were retained as prose; their layout may differ.".into());
                                }
                                while self.source[self.cursor..].starts_with(char::is_whitespace) {
                                    self.cursor += self.source[self.cursor..]
                                        .chars()
                                        .next()
                                        .unwrap_or('\0')
                                        .len_utf8();
                                }
                                continue;
                            }
                        }
                        "par" => {
                            result.push_str("\n\n");
                            continue;
                        }
                        "newline" | "linebreak" => {
                            result.push_str("#linebreak()\n");
                            continue;
                        }
                        "newpage" | "clearpage" => {
                            result.push_str("\n#pagebreak()\n");
                            continue;
                        }
                        "footnote" => {
                            if let Some(text) = self.group('{', '}') {
                                result.push_str(&format!("#footnote[{}]", self.nested(&text)));
                                continue;
                            }
                        }
                        _ => while self.group('{', '}').is_some() {},
                    }
                    self.warning(format!("Command \\{name} was preserved as raw TeX; verify its meaning and formatting manually."));
                    result.push_str(&raw(&self.source[start..self.cursor]));
                }
                _ => result.push_str(&escape_typst(&character.to_string())),
            }
        }
        if !lists.is_empty() {
            self.warning(
                "One or more TeX lists had no matching end; verify their structure manually."
                    .into(),
            );
        }
        result
    }
}

fn raw(source: &str) -> String {
    let mut literal = String::from("\"");
    for character in source.chars() {
        match character {
            '"' => literal.push_str("\\\""),
            '\\' => literal.push_str("\\\\"),
            '\n' => literal.push_str("\\n"),
            '\r' => literal.push_str("\\r"),
            '\t' => literal.push_str("\\t"),
            c if c.is_control() => literal.push_str(&format!("\\u{{{:x}}}", c as u32)),
            c => literal.push(c),
        }
    }
    literal.push('"');
    format!("#raw({literal})")
}

fn body(source: &str) -> (&str, bool) {
    let mut parser = Parser {
        source,
        cursor: 0,
        warnings: vec![],
        depth: 0,
    };
    let mut start = None;
    let mut nesting: usize = 0;
    while parser.cursor < source.len() {
        let character = source[parser.cursor..].chars().next().unwrap_or('\0');
        parser.cursor += character.len_utf8();
        match character {
            '%' => {
                parser.cursor += source[parser.cursor..]
                    .find('\n')
                    .unwrap_or(source.len() - parser.cursor);
            }
            '{' => nesting += 1,
            '}' => nesting = nesting.saturating_sub(1),
            '\\' => {
                let command_start = parser.cursor;
                while parser.cursor < source.len()
                    && source.as_bytes()[parser.cursor].is_ascii_alphabetic()
                {
                    parser.cursor += 1;
                }
                let name = &source[command_start..parser.cursor];
                if nesting == 0 && matches!(name, "begin" | "end") {
                    if parser.group('{', '}').as_deref() == Some("document") {
                        if name == "begin" && start.is_none() {
                            start = Some(parser.cursor);
                        } else if name == "end" {
                            if let Some(start) = start {
                                return (&source[start..command_start - 1], true);
                            }
                        }
                    }
                } else if name.is_empty() {
                    if let Some(symbol) = source[parser.cursor..].chars().next() {
                        parser.cursor += symbol.len_utf8();
                    }
                }
            }
            _ => {}
        }
    }
    match start {
        Some(start) => (&source[start..], false),
        None => (source, true),
    }
}

pub fn convert(source: &str) -> Result<ImportResult> {
    if source.len() > MAX_TEXT {
        return Err(Error::new("limit", "TeX import exceeds 2 MB."));
    }
    let (body, terminated) = body(source);
    let mut parser = Parser { source: body, cursor: 0, warnings: vec!["This is a best-effort import. Document classes, packages, custom macros, margins, fonts, bibliography and spacing may differ. The original .tex file is preserved.".into()], depth: 0 };
    if !terminated {
        parser.warning("The document environment had no matching end.".into());
    }
    let content = format!("// Imported by UnderTree. See the import report before relying on formatting.\n#set page(paper: \"a4\")\n#set text(size: 11pt)\n\n{}\n", parser.convert());
    if content.len() > MAX_TEXT {
        return Err(Error::new(
            "limit",
            "The converted Typst source exceeds 2 MB. Import a smaller manuscript section.",
        ));
    }
    Ok(ImportResult {
        content,
        warnings: parser.warnings,
        exact_formatting: false,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn valid(result: &ImportResult) {
        assert!(
            typst_syntax::parse(&result.content)
                .errors_and_warnings()
                .0
                .is_empty(),
            "{}",
            result.content
        );
    }

    #[test]
    fn imports_supported_structure_and_flags_unsupported_content() {
        let input = "\\documentclass{article}\\begin{document}\\section{Results}A \\textbf{strong \\emph{effect}}.\\begin{itemize}\\item One\\item Two\\end{itemize}\\custom{keep me} $x^2$\\end{document}";
        let result = convert(input).unwrap();
        assert!(result.content.contains("= Results"));
        assert!(result.content.contains("#strong[strong #emph[effect]]"));
        assert!(result.content.contains("- One"));
        assert!(result.content.contains("keep me"));
        assert!(result.warnings.iter().any(|s| s.contains("custom")));
        assert!(result.warnings.iter().any(|s| s.contains("math")));
        assert!(!result.exact_formatting);
        valid(&result);
    }

    #[test]
    fn import_never_emits_executable_tex_commands() {
        let result = convert("\\write18{rm -rf x} \\textbf{#read(\"secret\")}").unwrap();
        assert!(!result.content.contains("[#read"));
        assert!(result.content.contains("write"));
        valid(&result);
    }

    #[test]
    fn preserves_whole_math_verbatim_unknown_environments_and_malformed_commands() {
        let source = "$$a \\text{cost \\$5}$$ \\[x+y\\] \\(z\\) \\verb|#read(\"x\")| \\begin{figure}outer\\begin{figure}inner\\end{figure}tail\\end{figure} \\textbf";
        let result = convert(source).unwrap();
        assert!(result.content.contains("$$a"));
        assert!(result.content.contains("cost"));
        assert!(result.content.contains("tail"));
        assert!(result.content.contains("\\\\textbf"));
        assert!(result.content.contains("\\\\verb"));
        assert_eq!(result.content.matches("#raw(").count(), 6);
        valid(&result);
    }

    #[test]
    fn ignores_document_markers_in_comments_and_converts_groups_and_nested_lists() {
        let source = "% \\begin{document}fake\\end{document}\n\\documentclass{article}\\begin {document}{Real}~text.\\begin{itemize}\\item Outer\\begin{enumerate}\\item Inner\\end{enumerate}\\item Last\\end{itemize}\\end {document}";
        let result = convert(source).unwrap();
        assert!(!result.content.contains("fake"));
        assert!(result.content.contains("Real\u{a0}text"));
        assert!(result.content.contains("  + Inner"));
        assert!(result.content.contains("- Last"));
        valid(&result);
    }

    #[test]
    fn unsupported_tex_with_control_characters_remains_valid_typst() {
        let result = convert("\\custom{a\u{0}\u{8}\u{c}雪}").unwrap();
        assert!(result.content.contains("\\u{0}"));
        valid(&result);
    }
}
