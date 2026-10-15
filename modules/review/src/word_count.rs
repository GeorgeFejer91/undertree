//! Pure literal-source text for local word-count estimates, never Typst evaluation.
//!
//! Literal content in unused definitions/branches is included once. Generated
//! strings, repetitions, includes, references and rendered output are unresolved.
use crate::{Error, Result};
use serde::Serialize;
use typst_syntax::{ast, SyntaxKind, SyntaxNode};

pub const MAX_WORD_COUNT_TEXT: usize = 2 * 1024 * 1024;

#[derive(Debug, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum LiteralUnavailableReason {
    IncompleteSyntax,
    LiteralLimit,
}

#[derive(Debug, PartialEq, Serialize)]
#[serde(
    tag = "status",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum LiteralText {
    Ready {
        literal_text: String,
    },
    Unavailable {
        reason_code: LiteralUnavailableReason,
        reason: &'static str,
    },
}

impl LiteralText {
    fn unavailable(reason_code: LiteralUnavailableReason) -> Self {
        let reason = match reason_code {
            LiteralUnavailableReason::IncompleteSyntax => {
                "The Typst source contains incomplete or invalid syntax."
            }
            LiteralUnavailableReason::LiteralLimit => {
                "The literal text exceeds the supported 2 MiB limit."
            }
        };
        Self::Unavailable {
            reason_code,
            reason,
        }
    }
}

struct LiteralBuffer(String);

impl LiteralBuffer {
    fn push(&mut self, text: &str) -> bool {
        if self.0.len().saturating_add(text.len()) > MAX_WORD_COUNT_TEXT {
            return false;
        }
        self.0.push_str(text);
        true
    }

    fn character(&mut self, character: char) -> bool {
        self.push(character.encode_utf8(&mut [0; 4]))
    }

    fn separator(&mut self) -> bool {
        if self
            .0
            .chars()
            .next_back()
            .is_some_and(|last| !last.is_whitespace())
        {
            self.push(" ")
        } else {
            true
        }
    }
}

struct Frame<'a> {
    children: std::slice::Iter<'a, SyntaxNode>,
    markup: bool,
    separator_after: bool,
}

/// Extract bounded literal markup from one supplied source snapshot.
///
/// Inline strong/emphasis preserve continuity. Content arguments and omitted
/// opaque expressions separate runs; generic call display semantics are not
/// evaluated. Neither source bytes nor external files are changed or loaded.
pub fn collect_typst_literal(source: &str) -> Result<LiteralText> {
    if source.len() > MAX_WORD_COUNT_TEXT {
        return Err(Error::new("limit", "The word-count source exceeds 2 MiB."));
    }
    let root = typst_syntax::parse(source);
    if root.diagnosis().errors {
        return Ok(LiteralText::unavailable(
            LiteralUnavailableReason::IncompleteSyntax,
        ));
    }
    let mut literal = LiteralBuffer(String::with_capacity(source.len()));
    let mut frames = vec![Frame {
        children: root.children(),
        markup: true,
        separator_after: false,
    }];
    while let Some(frame) = frames.last_mut() {
        let Some(node) = frame.children.next() else {
            let separator = frame.separator_after;
            frames.pop();
            if separator && !literal.separator() {
                return Ok(LiteralText::unavailable(
                    LiteralUnavailableReason::LiteralLimit,
                ));
            }
            continue;
        };
        let markup = frame.markup;
        let mut descend = None;
        let fits = match node.kind() {
            SyntaxKind::Text
            | SyntaxKind::Space
            | SyntaxKind::Parbreak
            | SyntaxKind::SmartQuote
            | SyntaxKind::Link
                if markup =>
            {
                literal.push(node.leaf_text())
            }
            SyntaxKind::Linebreak if markup => literal.push("\n"),
            SyntaxKind::Escape if markup => node
                .cast::<ast::Escape>()
                .is_some_and(|escape| literal.character(escape.get())),
            SyntaxKind::Shorthand if markup => node
                .cast::<ast::Shorthand>()
                .is_some_and(|shorthand| literal.character(shorthand.get())),
            SyntaxKind::Raw
            | SyntaxKind::Equation
            | SyntaxKind::Math
            | SyntaxKind::LineComment
            | SyntaxKind::BlockComment
            | SyntaxKind::Shebang => literal.separator(),
            SyntaxKind::Markup => {
                descend = Some((true, !markup));
                markup || literal.separator()
            }
            SyntaxKind::Strong | SyntaxKind::Emph if markup => {
                descend = Some((true, false));
                true
            }
            SyntaxKind::Heading
            | SyntaxKind::ListItem
            | SyntaxKind::EnumItem
            | SyntaxKind::TermItem
                if markup =>
            {
                descend = Some((true, true));
                literal.separator()
            }
            SyntaxKind::Hash
            | SyntaxKind::Star
            | SyntaxKind::Underscore
            | SyntaxKind::HeadingMarker
            | SyntaxKind::ListMarker
            | SyntaxKind::EnumMarker
            | SyntaxKind::TermMarker => true,
            SyntaxKind::Colon if markup => literal.separator(),
            _ => {
                // Code containers may contain literal Markup/ContentBlock nodes.
                // Their identifiers, strings, whitespace and numeric leaves do not.
                if node.children().next().is_some() {
                    descend = Some((false, true));
                }
                !markup || literal.separator()
            }
        };
        if !fits {
            return Ok(LiteralText::unavailable(
                LiteralUnavailableReason::LiteralLimit,
            ));
        }
        if let Some((markup, separator_after)) = descend {
            frames.push(Frame {
                children: node.children(),
                markup,
                separator_after,
            });
        }
    }
    Ok(LiteralText::Ready {
        literal_text: literal.0,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn literal(source: &str) -> String {
        match collect_typst_literal(source).unwrap() {
            LiteralText::Ready { literal_text } => literal_text,
            other => panic!("Expected literal text, got {other:?} for {source:?}"),
        }
    }

    #[test]
    fn headings_inline_markup_quotes_and_unicode_remain_literal() {
        assert_eq!(
            literal("= Heading\nHello *world*.")
                .split_whitespace()
                .collect::<Vec<_>>(),
            ["Heading", "Hello", "world."]
        );
        assert_eq!(
            literal(r"*under*\u{74}ree _canopy_").trim(),
            "undertree canopy"
        );
        assert_eq!(literal("one\"two\"three"), "one\"two\"three");
        assert_eq!(
            literal("cafe\u{301} 漢字 🦀\r\nnext"),
            "cafe\u{301} 漢字 🦀\r\nnext"
        );
        assert_eq!(
            literal(r"escaped\#mark\u{1F980}~tail-?end"),
            "escaped#mark🦀\u{a0}tail\u{ad}end"
        );
    }

    #[test]
    fn literal_call_arguments_captions_and_table_cells_are_found_once() {
        assert_eq!(literal("#strong[Body]").trim(), "Body");
        assert_eq!(
            literal("#figure(image(\"asset.png\"), caption: [Short caption])").trim(),
            "Short caption"
        );
        assert_eq!(
            literal("#table(columns: 2, [first], [second])").trim(),
            "first second"
        );
        assert_eq!(
            literal("#{ let unused = [Unused literal]; unused }").trim(),
            "Unused literal"
        );
        assert_eq!(
            literal("- First\n- Second\n+ Third\n/ Term: Definition")
                .split_whitespace()
                .collect::<Vec<_>>(),
            ["First", "Second", "Third", "Term", "Definition"]
        );
    }

    #[test]
    fn opaque_regions_do_not_inflate_or_fuse_surrounding_prose() {
        for opaque in [
            "`raw words`",
            "$ x + y $",
            "/* comment words */",
            "#42",
            "#\"generated string words\"",
            "#image(\"private-path.png\", width: 12pt)",
        ] {
            assert_eq!(
                literal(&format!("left{opaque} right"))
                    .split_whitespace()
                    .collect::<Vec<_>>(),
                ["left", "right"],
                "{opaque}"
            );
        }
        assert_eq!(
            literal("before// hidden words\nafter")
                .split_whitespace()
                .collect::<Vec<_>>(),
            ["before", "after"]
        );
    }

    #[test]
    fn unused_literals_and_loop_bodies_count_once_without_resolving_external_content() {
        let source = "#let unused = [Unused literal]\n#\"generated words\"\n#for i in range(3000) [Loop literal]\n#include \"not-present.typ\"\n#import \"@preview/not-installed:0.1.0\": *\n@reference\n#bibliography(\"absent.bib\")\nVisible prose.";
        assert_eq!(
            literal(source).split_whitespace().collect::<Vec<_>>(),
            ["Unused", "literal", "Loop", "literal", "Visible", "prose."]
        );
        assert_eq!(
            literal("#if false [Hidden literal] else [Other literal]")
                .split_whitespace()
                .collect::<Vec<_>>(),
            ["Hidden", "literal", "Other", "literal"]
        );
    }

    #[test]
    fn incomplete_syntax_is_unavailable_instead_of_a_successful_zero() {
        for source in ["#strong[", "#let x = (", "$unclosed", "`unclosed"] {
            assert!(
                matches!(
                    collect_typst_literal(source).unwrap(),
                    LiteralText::Unavailable {
                        reason_code: LiteralUnavailableReason::IncompleteSyntax,
                        ..
                    }
                ),
                "{source}"
            );
        }
        assert_eq!(literal(""), "");
        assert_eq!(literal("#let unused = 1").trim(), "");
        // The pinned lexer accepts a block comment ending at EOF without a
        // diagnostic, so the collector follows that grammar and omits it.
        assert_eq!(literal("before/* comment through EOF").trim(), "before");
        let deep = format!("{}text{}", "#[".repeat(2000), "]".repeat(2000));
        assert!(matches!(
            collect_typst_literal(&deep).unwrap(),
            LiteralText::Unavailable {
                reason_code: LiteralUnavailableReason::IncompleteSyntax,
                ..
            }
        ));
    }

    #[test]
    fn input_and_decoded_output_have_independent_byte_limits() {
        let source = "x".repeat(MAX_WORD_COUNT_TEXT);
        assert_eq!(literal(&source), source);
        assert_eq!(
            collect_typst_literal(&(source + "x")).unwrap_err().code,
            "limit"
        );
        let expanded = "~".repeat(MAX_WORD_COUNT_TEXT / 2 + 1);
        assert!(expanded.len() < MAX_WORD_COUNT_TEXT);
        assert!(matches!(
            collect_typst_literal(&expanded).unwrap(),
            LiteralText::Unavailable {
                reason_code: LiteralUnavailableReason::LiteralLimit,
                ..
            }
        ));
    }

    #[test]
    fn wire_outcomes_are_finite_and_exclude_partial_literal_text_on_failure() {
        assert_eq!(
            serde_json::to_value(collect_typst_literal("Body").unwrap()).unwrap(),
            serde_json::json!({"status":"ready","literalText":"Body"})
        );
        let unavailable = serde_json::to_value(collect_typst_literal("#strong[").unwrap()).unwrap();
        assert_eq!(unavailable["status"], "unavailable");
        assert_eq!(unavailable["reasonCode"], "incomplete_syntax");
        assert!(unavailable.get("literalText").is_none());
    }
}
