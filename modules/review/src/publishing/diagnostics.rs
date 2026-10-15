//! Pure normalization of bounded Typst short output. Locations are untrusted candidates:
//! the caller must bind supervised build provenance and current source state separately.
use crate::document::{digest, MAX_TEXT};
use serde::Serialize;
use std::collections::BTreeMap;
use std::path::{Component, Path, PathBuf};

const MAX_STDERR: usize = 64 * 1024;
const MAX_ROWS: usize = 128;
const MAX_REPORT: usize = 128 * 1024;
const MAX_TEXT_JSON: usize = 64 * 1024;

/// Native-owned copied sources, never inventory derived from diagnostic text.
pub(crate) struct StagedSource<'a> {
    pub project_path: &'a str,
    pub text: &'a str,
    pub source_digest: &'a str,
}

/// Roots/cwd must be canonical absolute paths supplied by the native build owner.
/// This pure module cannot prove filesystem identity, absence of links or compiler origin.
pub(crate) struct DiagnosticContext<'a> {
    pub staged_root: &'a Path,
    pub compiler_cwd: &'a Path,
    pub sources: &'a [StagedSource<'a>],
    pub private_roots: &'a [&'a Path],
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DiagnosticReport {
    pub text: String,
    pub rows: Vec<PrimaryDiagnostic>,
    pub truncated: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PrimaryDiagnostic {
    pub severity: Severity,
    pub message: String,
    pub location_candidate: Option<SourceLocationCandidate>,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub(crate) enum Severity {
    Error,
    Warning,
}

/// A checked position in supplied snapshot bytes, not a navigation ticket or proof
/// that a header was compiler-generated. In particular, a forged valid header can match.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SourceLocationCandidate {
    pub project_path: String,
    pub source_digest: String,
    pub line1: usize,
    pub column_scalar0: usize,
    pub byte_offset: usize,
    pub utf16_offset: usize,
}

struct Header<'a> {
    severity: Severity,
    message: &'a str,
    location: Option<(&'a str, usize, usize)>,
}

fn unsafe_character(character: char) -> bool {
    character.is_control()
        || matches!(character, '\u{2028}' | '\u{2029}' | '\u{200e}' | '\u{200f}'
            | '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{2069}' | '\u{feff}')
}

fn absolute_root(path: &Path) -> bool {
    path.is_absolute()
        && path
            .to_str()
            .is_some_and(|text| text.len() <= 4096 && !text.chars().any(unsafe_character))
        && path
            .components()
            .all(|part| !matches!(part, Component::CurDir | Component::ParentDir))
        && path.components().collect::<PathBuf>().as_os_str() == path.as_os_str()
}

fn editable_path(relative: &str) -> bool {
    // Match the closed editable-source set and hidden/metadata rules of Service::path.
    let Ok(path) = super::input_path(relative) else {
        return false;
    };
    !relative.contains('\\')
        && !relative.chars().any(unsafe_character)
        && !relative.starts_with('@')
        && !path
            .components()
            .any(|part| part.as_os_str().to_string_lossy().starts_with('.'))
        && ![
            ".undertree-review.json",
            ".undertree-pending.json",
            ".import-report.json",
        ]
        .iter()
        .any(|suffix| relative.ends_with(suffix))
        && path
            .extension()
            .and_then(|part| part.to_str())
            .is_some_and(|extension| {
                [
                    "html", "htm", "typ", "css", "md", "txt", "tex", "bib", "yaml", "yml", "json",
                    "csv", "tsv", "xml", "svg",
                ]
                .contains(&extension)
            })
}

fn relative_alias(cwd: &Path, source: &Path) -> Option<PathBuf> {
    let from: Vec<_> = cwd.components().collect();
    let to: Vec<_> = source.components().collect();
    let shared = from
        .iter()
        .zip(&to)
        .take_while(|(left, right)| left == right)
        .count();
    if shared == 0 {
        return None;
    }
    let mut alias = PathBuf::new();
    for _ in &from[shared..] {
        alias.push("..");
    }
    alias.extend(&to[shared..]);
    Some(alias)
}

fn source_aliases(context: &DiagnosticContext<'_>) -> BTreeMap<String, Option<usize>> {
    let mut aliases = BTreeMap::new();
    if context.sources.len() > super::MAX_INVENTORY_FILES {
        return aliases;
    }
    for (index, source) in context.sources.iter().enumerate() {
        if !editable_path(source.project_path) {
            continue;
        }
        let absolute = context.staged_root.join(source.project_path);
        for path in [
            Some(absolute.clone()),
            relative_alias(context.compiler_cwd, &absolute),
        ]
        .into_iter()
        .flatten()
        {
            let Some(spelling) = path.to_str() else {
                continue;
            };
            // Only inventory-derived spellings; never resolve/canonicalize a supplied header.
            let mut spellings = vec![spelling.to_owned()];
            if cfg!(windows) {
                let slash = spelling.replace('\\', "/");
                if slash != spelling {
                    spellings.push(slash);
                }
            }
            for spelling in spellings {
                aliases
                    .entry(spelling)
                    .and_modify(|entry| *entry = None)
                    .or_insert(Some(index));
            }
        }
    }
    aliases
}

fn number(value: &str) -> Option<usize> {
    if value.is_empty()
        || (value.len() > 1 && value.starts_with('0'))
        || !value.bytes().all(|byte| byte.is_ascii_digit())
    {
        return None;
    }
    value.parse().ok()
}

fn header(line: &str) -> Option<Header<'_>> {
    let mut parsed = [
        ("error: ", Severity::Error),
        ("warning: ", Severity::Warning),
    ]
    .into_iter()
    .find_map(|(prefix, severity)| {
        line.strip_prefix(prefix).map(|message| Header {
            severity,
            message,
            location: None,
        })
    });
    for (delimiter, severity) in [
        (": error: ", Severity::Error),
        (": warning: ", Severity::Warning),
    ] {
        for (offset, _) in line.match_indices(delimiter) {
            let prefix = &line[..offset];
            let Some((prefix, column)) = prefix.rsplit_once(':') else {
                continue;
            };
            let Some((path, line_number)) = prefix.rsplit_once(':') else {
                continue;
            };
            let Some((line_number, column)) = number(line_number).zip(number(column)) else {
                continue;
            };
            if path.is_empty() || line_number == 0 {
                continue;
            }
            if parsed.is_some() {
                return None;
            }
            parsed = Some(Header {
                severity,
                message: &line[offset + delimiter.len()..],
                location: Some((path, line_number, column)),
            });
        }
    }
    parsed
}

fn point(text: &str, line1: usize, column0: usize) -> Option<(usize, usize)> {
    let mut characters = text.char_indices().peekable();
    let (mut line, mut column, mut utf16) = (1, 0, 0);
    while let Some((byte, character)) = characters.next() {
        if (line, column) == (line1, column0) {
            return Some((byte, utf16));
        }
        utf16 += character.len_utf16();
        if matches!(
            character,
            '\r' | '\n' | '\u{b}' | '\u{c}' | '\u{85}' | '\u{2028}' | '\u{2029}'
        ) {
            if character == '\r' && characters.peek().is_some_and(|(_, next)| *next == '\n') {
                characters.next();
                utf16 += 1;
            }
            if line == line1 {
                return None;
            }
            line += 1;
            column = 0;
        } else {
            column += 1;
        }
    }
    ((line, column) == (line1, column0)).then_some((text.len(), utf16))
}

fn redaction_roots(context: &DiagnosticContext<'_>) -> Option<Vec<String>> {
    if !absolute_root(context.staged_root)
        || !absolute_root(context.compiler_cwd)
        || context.private_roots.len() > 128
    {
        return None;
    }
    let mut roots = Vec::new();
    for path in [context.staged_root, context.compiler_cwd]
        .into_iter()
        .chain(context.private_roots.iter().copied())
    {
        if path.as_os_str().is_empty() {
            continue;
        }
        if !absolute_root(path) {
            return None;
        }
        let text = path.to_str()?;
        roots.push(text.to_owned());
        if cfg!(windows) {
            roots.push(text.replace('\\', "/"));
        }
    }
    roots.sort_by_key(|root| std::cmp::Reverse(root.len()));
    roots.dedup();
    Some(roots)
}

fn redact(bytes: &[u8], roots: &[String], cut: bool) -> String {
    let mut safe = Vec::with_capacity(bytes.len());
    let mut cursor = 0;
    while cursor < bytes.len() {
        let rest = &bytes[cursor..];
        if cut && roots.iter().any(|root| root.as_bytes().starts_with(rest)) {
            // Input cap may cut even inside a UTF-8 private root: redact bytes before decoding.
            // A partial longer root also takes precedence over a complete parent root.
            safe.extend_from_slice(b"[private]");
            break;
        } else if let Some(root) = roots.iter().find(|root| rest.starts_with(root.as_bytes())) {
            safe.extend_from_slice(b"[private]");
            cursor += root.len();
        } else {
            safe.push(bytes[cursor]);
            cursor += 1;
        }
    }
    let mut text = String::new();
    for character in String::from_utf8_lossy(&safe).chars() {
        if unsafe_character(character) && !matches!(character, '\n' | '\r' | '\t') {
            use std::fmt::Write;
            let _ = write!(text, "\\u{{{:x}}}", character as u32);
        } else {
            text.push(character);
        }
    }
    text
}

fn serialized_size(value: &impl Serialize) -> usize {
    serde_json::to_vec(value).map_or(usize::MAX, |bytes| bytes.len())
}

/// Never opens files, starts a compiler, authenticates a header or grants navigation.
pub(crate) fn normalize(stderr: &[u8], context: &DiagnosticContext<'_>) -> DiagnosticReport {
    let Some(roots) = redaction_roots(context) else {
        return DiagnosticReport {
            text: "Compiler diagnostics omitted: invalid private path context.".into(),
            rows: Vec::new(),
            truncated: true,
        };
    };
    let input_cut = stderr.len() > MAX_STDERR;
    let bytes = &stderr[..stderr.len().min(MAX_STDERR)];
    let mut report = DiagnosticReport {
        text: redact(bytes, &roots, input_cut),
        rows: Vec::new(),
        truncated: input_cut,
    };
    // Reserve half the actual JSON budget for structured rows; escaping can expand text.
    while serialized_size(&report.text) > MAX_TEXT_JSON {
        let mut end = report.text.len() / 2;
        while !report.text.is_char_boundary(end) {
            end -= 1;
        }
        report.text.truncate(end);
        report.truncated = true;
    }
    let parse_length = if input_cut && bytes.last() != Some(&b'\n') {
        bytes
            .iter()
            .rposition(|byte| *byte == b'\n')
            .map_or(0, |index| index + 1)
    } else {
        bytes.len()
    };
    let aliases = source_aliases(context);
    let mut verified = BTreeMap::new();
    for raw in bytes[..parse_length].split(|byte| *byte == b'\n') {
        let Ok(line) = std::str::from_utf8(raw) else {
            continue;
        };
        let Some(parsed) = header(line.strip_suffix('\r').unwrap_or(line)) else {
            continue;
        };
        if report.rows.len() == MAX_ROWS {
            report.truncated = true;
            break;
        }
        let location_candidate = parsed.location.and_then(|(path, line1, column_scalar0)| {
            if path.chars().any(unsafe_character) || path.starts_with('@') {
                return None;
            }
            let index = (*aliases.get(path)?)?;
            let source = &context.sources[index];
            if source.text.len() > MAX_TEXT {
                return None;
            }
            if !*verified
                .entry(index)
                .or_insert_with(|| digest(source.text) == source.source_digest)
            {
                return None;
            }
            let (byte_offset, utf16_offset) = point(source.text, line1, column_scalar0)?;
            Some(SourceLocationCandidate {
                project_path: source.project_path.into(),
                source_digest: source.source_digest.into(),
                line1,
                column_scalar0,
                byte_offset,
                utf16_offset,
            })
        });
        report.rows.push(PrimaryDiagnostic {
            severity: parsed.severity,
            message: redact(parsed.message.as_bytes(), &roots, false),
            location_candidate,
        });
        if serialized_size(&report) > MAX_REPORT {
            report.rows.pop();
            report.truncated = true;
            break;
        }
    }
    report
}

#[cfg(test)]
mod tests {
    use super::*;

    fn root() -> &'static Path {
        Path::new(if cfg!(windows) {
            r"C:\private\stage"
        } else {
            "/private/stage"
        })
    }

    fn run(log: &[u8], files: &[(&str, &str)]) -> DiagnosticReport {
        let hashes: Vec<_> = files.iter().map(|(_, text)| digest(text)).collect();
        let sources: Vec<_> = files
            .iter()
            .zip(&hashes)
            .map(|((path, text), hash)| StagedSource {
                project_path: path,
                text,
                source_digest: hash,
            })
            .collect();
        normalize(
            log,
            &DiagnosticContext {
                staged_root: root(),
                compiler_cwd: root(),
                sources: &sources,
                private_roots: &[],
            },
        )
    }

    fn location(report: &DiagnosticReport) -> &SourceLocationCandidate {
        report.rows[0].location_candidate.as_ref().unwrap()
    }

    // Tiny owned text/log samples from the sealed Typst0.15.1 corpus; no personal paths.
    #[test]
    fn observed_zero_column_and_identifier_after_hash_are_preserved() {
        let raw = run(
            b"main.typ:1:0: error: unclosed raw text\n",
            &[("main.typ", "`")],
        );
        assert_eq!(
            (location(&raw).line1, location(&raw).column_scalar0),
            (1, 0)
        );
        assert_eq!(
            (location(&raw).byte_offset, location(&raw).utf16_offset),
            (0, 0)
        );
        let identifier = run(
            b"main.typ:1:1: error: unknown variable: diagnostics_missing_symbol\n",
            &[("main.typ", "#diagnostics_missing_symbol\n")],
        );
        assert_eq!(
            (
                location(&identifier).byte_offset,
                location(&identifier).utf16_offset
            ),
            (1, 1)
        );
        assert!(!identifier.truncated);
        assert_eq!(identifier.rows[0].severity, Severity::Error);
    }

    #[test]
    fn observed_astral_combining_and_tabs_map_to_original_byte_and_utf16_offsets() {
        for (text, column, byte, utf16) in [
            ("💛 #diagnostics_missing_symbol\n", 3, 6, 4),
            ("e\u{301} #diagnostics_missing_symbol\n", 4, 5, 4),
            ("\t\t#diagnostics_missing_symbol\n", 3, 3, 3),
        ] {
            let log = format!(
                "main.typ:1:{column}: error: unknown variable: diagnostics_missing_symbol\n"
            );
            let result = run(log.as_bytes(), &[("main.typ", text)]);
            assert_eq!(
                (
                    location(&result).column_scalar0,
                    location(&result).byte_offset,
                    location(&result).utf16_offset
                ),
                (column, byte, utf16)
            );
        }
        let text = "First line.\r\n💛e\u{301}\t#diagnostics_missing_symbol\r\n";
        let result = run(
            b"main.typ:2:5: error: unknown variable: diagnostics_missing_symbol\n",
            &[("main.typ", text)],
        );
        let expected_byte = text.find("diagnostics_missing_symbol").unwrap();
        assert_eq!(location(&result).byte_offset, expected_byte);
        assert_eq!(
            location(&result).utf16_offset,
            text[..expected_byte].encode_utf16().count()
        );
    }

    #[test]
    fn observed_all_eight_typst_newlines_and_mixed_sequence_map_without_normalization() {
        for newline in [
            "\n", "\r", "\r\n", "\u{b}", "\u{c}", "\u{85}", "\u{2028}", "\u{2029}",
        ] {
            let text = format!("Before.{newline}💛\t#diagnostics_missing_symbol");
            let report = run(
                b"main.typ:2:3: error: unknown variable: diagnostics_missing_symbol\n",
                &[("main.typ", &text)],
            );
            let byte = text.find("diagnostics_missing_symbol").unwrap();
            assert_eq!(
                (
                    location(&report).byte_offset,
                    location(&report).utf16_offset
                ),
                (byte, text[..byte].encode_utf16().count())
            );
        }
        let text = "One.\r\nTwo.\u{85}Three.\u{2028}Four.\u{2029}\t#diagnostics_missing_symbol";
        let report = run(
            b"main.typ:5:2: error: unknown variable: diagnostics_missing_symbol\n",
            &[("main.typ", text)],
        );
        assert_eq!(
            location(&report).byte_offset,
            text.find("diagnostics_missing_symbol").unwrap()
        );
    }

    #[test]
    fn observed_eof_anchor_is_before_trailing_crlf_and_out_of_bounds_is_not_clamped() {
        for text in ["#let value =", "#let value =\r\n"] {
            let report = run(
                b"main.typ:1:12: error: expected expression\n",
                &[("main.typ", text)],
            );
            assert_eq!(
                (
                    location(&report).byte_offset,
                    location(&report).utf16_offset
                ),
                (12, 12)
            );
        }
        for header in [
            "main.typ:1:13: error: synthetic",
            "main.typ:3:0: error: synthetic",
        ] {
            let report = run(header.as_bytes(), &[("main.typ", "#let value =\r\n")]);
            assert!(report.rows[0].location_candidate.is_none());
        }
        assert_eq!(point("", 1, 0), Some((0, 0)));
        assert_eq!(point("a\r\n", 2, 0), Some((3, 3)));
    }

    #[test]
    fn observed_same_basename_errors_and_warnings_keep_exact_project_identity() {
        let files = [
            ("entry/main.typ", "#include \"../left/main.typ\""),
            ("left/main.typ", "#set text(font: \"missing\")"),
            ("right/main.typ", "#set text(font: \"missing\")"),
        ];
        let report = run(b"left/main.typ:1:16: warning: unknown font family: missing\nright/main.typ:1:16: warning: unknown font family: missing\n", &files);
        assert_eq!(report.rows.len(), 2);
        for (row, path) in report.rows.iter().zip(["left/main.typ", "right/main.typ"]) {
            assert_eq!(row.severity, Severity::Warning);
            assert_eq!(row.location_candidate.as_ref().unwrap().project_path, path);
            assert_eq!(
                row.location_candidate.as_ref().unwrap().source_digest,
                digest(files[1].1)
            );
        }
        let basename = run(b"main.typ:1:1: error: synthetic basename\n", &files);
        assert!(basename.rows[0].location_candidate.is_none());
        for path in ["left/main.typ", "right/main.typ"] {
            let log = format!("{path}:1:1: error: unknown variable: diagnostics_missing_symbol\n");
            assert_eq!(location(&run(log.as_bytes(), &files)).project_path, path);
        }
    }

    #[test]
    fn observed_unicode_main_and_chapter_warning_positions_are_scalar_zero() {
        let source = "Before.\r\n💛e\u{301}\t#set text(font: \"UnderTree Diagnostics Deliberately Missing Font\")\r\nWarning sentinel.";
        for path in ["main.typ", "chapter/main.typ"] {
            let log = format!("{path}:2:20: warning: unknown font family: undertree diagnostics deliberately missing font\n");
            let report = run(log.as_bytes(), &[(path, source)]);
            assert_eq!(report.rows[0].severity, Severity::Warning);
            assert_eq!(
                (
                    location(&report).byte_offset,
                    location(&report).utf16_offset
                ),
                (33, 30)
            );
        }
    }

    #[cfg(unix)]
    #[test]
    fn observed_linux_colon_and_space_names_match_exactly_without_left_splitting() {
        for name in ["main:7:12.typ", "chapter:7:12.typ", "chapter notes.typ"] {
            let log = format!("{name}:1:1: error: unknown variable: diagnostics_missing_symbol\n");
            assert_eq!(
                location(&run(
                    log.as_bytes(),
                    &[(name, "#diagnostics_missing_symbol")]
                ))
                .project_path,
                name
            );
        }
    }

    #[test]
    fn observed_cwd_relative_spelling_is_bound_to_explicit_staged_root() {
        let hash = digest("#bad");
        let sources = [StagedSource {
            project_path: "main.typ",
            text: "#bad",
            source_digest: &hash,
        }];
        let cwd = root().parent().unwrap().join("tmp");
        let context = DiagnosticContext {
            staged_root: root(),
            compiler_cwd: &cwd,
            sources: &sources,
            private_roots: &[],
        };
        let correct = normalize(
            b"../stage/main.typ:1:1: error: synthetic cwd binding\n",
            &context,
        );
        assert_eq!(location(&correct).project_path, "main.typ");
        let wrong = normalize(b"main.typ:1:1: error: synthetic wrong cwd\n", &context);
        assert!(wrong.rows[0].location_candidate.is_none());
        let absolute = format!(
            "{}:1:1: error: synthetic absolute inventory binding\n",
            root().join("main.typ").display()
        );
        assert_eq!(
            location(&normalize(absolute.as_bytes(), &context)).project_path,
            "main.typ"
        );
        let noncanonical = normalize(
            b"../stage/unused/../main.typ:1:1: error: synthetic alias\n",
            &context,
        );
        assert!(noncanonical.rows[0].location_candidate.is_none());
        let private_cwd = format!("opaque cwd: {}", cwd.display());
        assert_eq!(
            normalize(private_cwd.as_bytes(), &context).text,
            "opaque cwd: [private]"
        );
    }

    #[test]
    fn source_digest_mismatch_and_duplicate_inventory_identity_suppress_candidates() {
        let good = digest("#bad");
        let sources = [StagedSource {
            project_path: "main.typ",
            text: "#changed",
            source_digest: &good,
        }];
        let context = DiagnosticContext {
            staged_root: root(),
            compiler_cwd: root(),
            sources: &sources,
            private_roots: &[],
        };
        assert!(
            normalize(b"main.typ:1:1: error: synthetic\n", &context).rows[0]
                .location_candidate
                .is_none()
        );
        let duplicate = run(
            b"main.typ:1:1: error: synthetic\n",
            &[("main.typ", "#one"), ("main.typ", "#two")],
        );
        assert!(duplicate.rows[0].location_candidate.is_none());
    }

    #[test]
    fn packages_external_reserved_hidden_assets_and_controls_never_become_project_candidates() {
        for path in [
            "@local/sample:0.1.0/main.typ",
            "../outside.typ",
            "/external/main.typ",
            ".git/main.typ",
            "node_modules/main.typ",
            "For-AI/main.typ",
            ".undertree-build-secret/main.typ",
            "hidden/.private/main.typ",
            "main.typ.undertree-review.json",
            "main.typ.undertree-pending.json",
            "main.typ.import-report.json",
            "asset.png",
            "chapter\tname.typ",
            "chapter\u{2028}name.typ",
            "chapter\u{202e}name.typ",
            "C:\\private\\main.typ",
        ] {
            let log = format!("{path}:1:0: error: synthetic ineligible\n");
            let report = run(log.as_bytes(), &[(path, "#bad"), ("main.typ", "#bad")]);
            assert!(
                report
                    .rows
                    .iter()
                    .all(|row| row.location_candidate.is_none()),
                "{path:?}"
            );
        }
        let absent = run(
            b"other.typ:1:0: error: synthetic\n",
            &[("main.typ", "#bad")],
        );
        assert!(absent.rows[0].location_candidate.is_none());
    }

    #[test]
    fn malformed_and_ambiguous_synthetic_headers_remain_redacted_fallback_text() {
        for log in [
            "main.typ:0:0: error: bad",
            "main.typ:1:-1: error: bad",
            "main.typ:1:: error: bad",
            "main.typ:01:0: error: bad",
            "main.typ:1:00: error: bad",
            "main.typ:99999999999999999999999999999999999:0: error: bad",
            "main.typ:1:0: info: unsupported",
            "main.typ:1:0: error: nested:2:0: warning: ambiguous",
            "error: main.typ:1:0: error: ambiguous unlocated form",
        ] {
            let report = run(
                log.as_bytes(),
                &[("main.typ", "#bad"), ("error: main.typ", "#bad")],
            );
            assert!(report.rows.is_empty(), "{log}");
            assert_eq!(report.text, log);
        }
        let ambiguous_name = "main.typ:1:0: error: nested.typ";
        let report = run(
            format!("{ambiguous_name}:1:0: error: synthetic\n").as_bytes(),
            &[(ambiguous_name, "#bad")],
        );
        assert!(report.rows.is_empty());
    }

    #[test]
    fn forged_valid_headers_are_only_candidates_and_require_separate_provenance() {
        // SYNTHETIC: never compiler-emitted evidence. Syntax + inventory cannot authenticate it.
        let forged = b"main.typ:1:0: error: <script>synthetic authored message</script>\n";
        assert!(run(forged, &[]).rows[0].location_candidate.is_none());
        let bound = run(forged, &[("main.typ", "#bad")]);
        assert_eq!(location(&bound).source_digest, digest("#bad"));
        assert!(bound.rows[0].message.contains("<script>")); // Plain text; no renderer/execution here.
        let json = serde_json::to_value(bound).unwrap();
        assert!(json["rows"][0].get("locationCandidate").is_some());
        assert!(json["rows"][0].get("navigable").is_none());
        assert!(json["rows"][0].get("authenticated").is_none());
    }

    #[test]
    fn missing_file_and_panic_private_roots_are_redacted_throughout_messages_and_fallback() {
        let output = root().parent().unwrap().join("output");
        let dependency = root().parent().unwrap().join("packages");
        let private = [output.as_path(), dependency.as_path(), Path::new("")];
        let context = DiagnosticContext {
            staged_root: root(),
            compiler_cwd: root(),
            sources: &[],
            private_roots: &private,
        };
        let log = format!("main.typ:1:9: error: file not found (searched at {}/missing.typ)\nmain.typ:1:1: error: panicked with: stage={}; output={}/result.pdf; dependency={}/pkg\nerror: input file not found (searched at {}/absent.typ)\nunknown fallback {}\n", root().display(), root().display(), output.display(), dependency.display(), root().display(), dependency.display());
        let report = normalize(log.as_bytes(), &context);
        assert_eq!(report.rows.len(), 3);
        assert!(report
            .rows
            .iter()
            .all(|row| row.location_candidate.is_none()));
        let json = serde_json::to_string(&report).unwrap();
        for path in [root(), output.as_path(), dependency.as_path()] {
            assert!(!report.text.contains(path.to_str().unwrap()));
            assert!(report
                .rows
                .iter()
                .all(|row| !row.message.contains(path.to_str().unwrap())));
            assert!(!json.contains(path.to_str().unwrap()));
        }
        assert!(report.rows[0].message.contains("[private]"));
        assert!(report.rows[1].message.matches("[private]").count() >= 3);
        assert!(report.text.contains("unknown fallback [private]"));
    }

    #[test]
    fn input_cut_cannot_turn_a_partial_line_into_a_candidate_or_leak_private_root_prefix() {
        let mut bytes = vec![b'x'; MAX_STDERR - 4];
        bytes.extend_from_slice(b"\nmai");
        bytes.extend_from_slice(b"n.typ:1:0: error: synthetic beyond cap\n");
        let report = run(&bytes, &[("main.typ", "#bad")]);
        assert!(report.truncated && report.rows.is_empty());
        let prefix = root().to_str().unwrap().as_bytes();
        let retained = prefix.len() - 2;
        let mut cut_root = vec![b'x'; MAX_STDERR - retained];
        cut_root.extend_from_slice(prefix);
        cut_root.extend_from_slice(b"/missing.typ");
        let context = DiagnosticContext {
            staged_root: root(),
            compiler_cwd: root(),
            sources: &[],
            private_roots: &[],
        };
        let safe = redact(
            &cut_root[..MAX_STDERR],
            &redaction_roots(&context).unwrap(),
            true,
        );
        assert!(safe.ends_with("[private]"));
        assert!(!safe.contains(std::str::from_utf8(&prefix[..retained]).unwrap()));
        assert!(normalize(&cut_root, &context).truncated);
        let unicode_root = root().join("💛-stage");
        let pattern = unicode_root.to_str().unwrap();
        let retained = pattern.find('💛').unwrap() + 2; // Cut inside the4-byte scalar.
        let mut bytes = vec![b'x'; MAX_STDERR - retained];
        bytes.extend_from_slice(pattern.as_bytes());
        let unicode_context = DiagnosticContext {
            staged_root: &unicode_root,
            compiler_cwd: &unicode_root,
            sources: &[],
            private_roots: &[],
        };
        let safe = redact(
            &bytes[..MAX_STDERR],
            &redaction_roots(&unicode_context).unwrap(),
            true,
        );
        assert!(safe.ends_with("[private]"));
        assert!(!safe.contains(root().to_str().unwrap()));
    }

    #[test]
    fn invalid_utf8_and_ansi_stay_safe_text_without_replacement_character_path_binding() {
        let report = run(
            b"main.typ:1:0: error: invalid \xff\n",
            &[("main.typ", "#bad")],
        );
        assert!(report.rows.is_empty());
        assert!(report.text.contains('\u{fffd}'));
        let ansi = run(
            b"\x1b[31mmain.typ:1:0: error: synthetic\x1b[0m\n",
            &[("main.typ", "#bad")],
        );
        assert!(ansi.rows[0].location_candidate.is_none());
        assert!(!ansi.text.contains('\x1b'));
        assert!(ansi.text.contains("\\u{1b}"));
    }

    #[test]
    fn capped_child_private_root_is_fully_redacted_even_when_parent_root_also_matches() {
        let child = root().join("child-stage-secret");
        let pattern = child.to_str().unwrap();
        let retained = pattern.len() - 3;
        let mut bytes = vec![b'x'; MAX_STDERR - retained];
        bytes.extend_from_slice(pattern.as_bytes());
        bytes.extend_from_slice(b"/missing.typ");
        let private = [root()];
        let context = DiagnosticContext {
            staged_root: &child,
            compiler_cwd: &child,
            sources: &[],
            private_roots: &private,
        };
        let report = normalize(&bytes, &context);
        assert!(report.truncated);
        assert!(report.text.ends_with("[private]"));
        assert!(!report.text.contains("child-stage"));
    }

    #[test]
    fn row_and_actual_serialized_report_limits_are_independent_of_json_expansion() {
        let log = "main.typ:1:0: error: synthetic\n".repeat(MAX_ROWS + 1);
        let report = run(log.as_bytes(), &[("main.typ", "#bad")]);
        assert_eq!(report.rows.len(), MAX_ROWS);
        assert!(report.truncated);
        assert!(serde_json::to_vec(&report).unwrap().len() <= MAX_REPORT);
        for input in [
            vec![0; MAX_STDERR],
            vec![b'"'; MAX_STDERR],
            vec![0xff; MAX_STDERR + 2],
        ] {
            let bounded = run(&input, &[]);
            assert!(bounded.truncated);
            assert!(serde_json::to_vec(&bounded).unwrap().len() <= MAX_REPORT);
        }
        let message = "\\\"".repeat(10_000);
        let log = format!("main.typ:1:0: error: {message}\n").repeat(3);
        let report = run(log.as_bytes(), &[("main.typ", "#bad")]);
        assert!(report.truncated);
        assert!(!report.rows.is_empty() && report.rows.len() < 3);
        assert!(serde_json::to_vec(&report).unwrap().len() <= MAX_REPORT);
    }

    #[test]
    fn unrecognized_and_unlocated_output_is_retained_and_invalid_root_context_fails_closed() {
        let log = b"opaque compiler text\nerror: input unavailable\nwarning: unlocated warning\n";
        let result = run(log, &[]);
        assert_eq!(result.text.as_bytes(), log);
        assert_eq!(result.rows.len(), 2);
        assert!(result
            .rows
            .iter()
            .all(|row| row.location_candidate.is_none()));
        let invalid = DiagnosticContext {
            staged_root: Path::new("relative"),
            compiler_cwd: root(),
            sources: &[],
            private_roots: &[],
        };
        let result = normalize(root().to_str().unwrap().as_bytes(), &invalid);
        assert!(result.truncated && result.rows.is_empty());
        assert!(!result.text.contains(root().to_str().unwrap()));
        let empty = run(b"", &[]);
        assert_eq!(
            empty,
            DiagnosticReport {
                text: String::new(),
                rows: Vec::new(),
                truncated: false
            }
        );
    }
}
