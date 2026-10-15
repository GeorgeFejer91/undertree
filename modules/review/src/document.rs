use crate::{Error, Result};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use uuid::Uuid;

pub const MAX_TEXT: usize = 2 * 1024 * 1024;
pub const MAX_ITEMS: usize = 500;
const MAX_POLICY_PROMPT: usize = 32_000;

fn valid_color(color: &str) -> bool {
    color.len() == 7 && color.starts_with('#') && color[1..].bytes().all(|b| b.is_ascii_hexdigit())
}

fn valid_digest(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

fn valid_id(value: &str, maximum: usize) -> bool {
    !value.trim().is_empty() && value.len() <= maximum && !value.chars().any(char::is_control)
}

pub fn digest(text: &str) -> String {
    format!("{:x}", Sha256::digest(text.as_bytes()))
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum Action {
    Protect,
    Prompt,
    Reject,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Rule {
    pub id: String,
    pub label: String,
    pub color: String,
    pub action: Action,
    pub prompt: String,
}

impl Rule {
    pub fn validate(&self) -> Result<()> {
        if !valid_id(&self.id, 64)
            || !valid_id(&self.label, 100)
            || self.prompt.len() > 4000
            || !valid_color(&self.color)
        {
            return Err(Error::new(
                "rule",
                "Use a named rule, a hex color, and a prompt shorter than 4,000 bytes.",
            ));
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Anchor {
    pub from: usize,
    pub to: usize,
    pub quote: String,
    pub before: String,
    pub after: String,
    pub stale: bool,
}

fn byte_offset(text: &str, offset: usize) -> Result<usize> {
    let mut units = 0;
    for (byte, character) in text.char_indices() {
        if units == offset {
            return Ok(byte);
        }
        units += character.len_utf16();
        if units > offset {
            break;
        }
    }
    if units == offset {
        Ok(text.len())
    } else {
        Err(Error::new(
            "range",
            "The selection splits a Unicode character or lies outside the manuscript.",
        ))
    }
}

pub fn selected(text: &str, from: usize, to: usize) -> Result<&str> {
    if from >= to {
        return Err(Error::new("range", "Select a nonempty passage."));
    }
    let start = byte_offset(text, from)?;
    let end = byte_offset(text, to)?;
    text.get(start..end)
        .ok_or_else(|| Error::new("range", "Invalid selection."))
}

impl Anchor {
    fn validate(&self) -> Result<()> {
        if self.from >= self.to
            || self.to > MAX_TEXT
            || self.quote.is_empty()
            || self.quote.len() > 32_000
            || self.quote.encode_utf16().count() != self.to - self.from
            || self.before.chars().count() > 48
            || self.after.chars().count() > 48
        {
            return Err(Error::new(
                "format",
                "Invalid review anchor. The sidecar has been preserved.",
            ));
        }
        Ok(())
    }

    pub fn new(text: &str, from: usize, to: usize) -> Result<Self> {
        let quote = selected(text, from, to)?.to_owned();
        if quote.len() > 32_000 {
            return Err(Error::new("range", "Select a passage smaller than 32 KB."));
        }
        let start = byte_offset(text, from)?;
        let end = byte_offset(text, to)?;
        let before: String = text[..start]
            .chars()
            .rev()
            .take(48)
            .collect::<String>()
            .chars()
            .rev()
            .collect();
        let after = text[end..].chars().take(48).collect();
        Ok(Self {
            from,
            to,
            quote,
            before,
            after,
            stale: false,
        })
    }

    pub fn reconcile(&mut self, old: &str, new: &str) {
        // Stale protection remains a blocker until the user reanchors or removes it.
        if self.stale {
            return;
        }
        let mut prefix = old
            .chars()
            .zip(new.chars())
            .take_while(|(a, b)| a == b)
            .map(|(a, _)| a.len_utf16())
            .sum::<usize>();
        prefix = prefix
            .min(old.encode_utf16().count())
            .min(new.encode_utf16().count());
        let suffix = old
            .chars()
            .rev()
            .zip(new.chars().rev())
            .take_while(|(a, b)| a == b)
            .map(|(a, _)| a.len_utf16())
            .sum::<usize>()
            .min(old.encode_utf16().count() - prefix)
            .min(new.encode_utf16().count() - prefix);
        let old_end = old.encode_utf16().count() - suffix;
        let new_end = new.encode_utf16().count() - suffix;
        if self.to <= prefix {
            return;
        }
        if self.from >= old_end {
            let delta = new_end as isize - old_end as isize;
            self.from = self.from.saturating_add_signed(delta);
            self.to = self.to.saturating_add_signed(delta);
            return;
        }
        self.stale = true;
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Marker {
    pub id: String,
    pub anchor: Anchor,
    pub rule: String,
    pub prompt: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum Decision {
    Accepted,
    Rejected,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum Status {
    Pending,
    Accepted,
    Rejected,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Suggestion {
    pub id: String,
    pub request_id: String,
    pub anchor: Anchor,
    pub replacement: String,
    pub rationale: String,
    pub status: Status,
    pub color: String,
    pub prompt: String,
    #[serde(default)]
    pub fingerprint: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Proposal {
    pub request_id: String,
    pub revision: String,
    pub from: usize,
    pub to: usize,
    pub quote: String,
    pub replacement: String,
    pub rationale: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Review {
    pub version: u32,
    pub revision: String,
    pub rules: Vec<Rule>,
    pub markers: Vec<Marker>,
    pub suggestions: Vec<Suggestion>,
}

impl Review {
    pub fn new(text: &str) -> Self {
        Self {
            version: 1,
            revision: digest(text),
            markers: vec![],
            suggestions: vec![],
            rules: vec![
                Rule {
                    id: "protect".into(),
                    label: "Keep unchanged".into(),
                    color: "#74b9a4".into(),
                    action: Action::Protect,
                    prompt: String::new(),
                },
                Rule {
                    id: "snappier".into(),
                    label: "Make snappier".into(),
                    color: "#e5be50".into(),
                    action: Action::Prompt,
                    prompt: "Keep the content and meaning; make the wording snappier.".into(),
                },
                Rule {
                    id: "reject".into(),
                    label: "Reject changes".into(),
                    color: "#d86e6e".into(),
                    action: Action::Reject,
                    prompt: String::new(),
                },
            ],
        }
    }

    pub fn validate(&self) -> Result<()> {
        if self.version != 1
            || !valid_digest(&self.revision)
            || self.markers.len() > MAX_ITEMS
            || self.suggestions.len() > MAX_ITEMS
            || self.rules.is_empty()
            || self.rules.len() > 24
        {
            return Err(Error::new(
                "format",
                "Unsupported or oversized review sidecar. The file has been preserved.",
            ));
        }
        for (index, rule) in self.rules.iter().enumerate() {
            rule.validate()?;
            if self.rules[..index].iter().any(|r| r.id == rule.id) {
                return Err(Error::new("rule", "Rule IDs must be unique."));
            }
        }
        for (index, marker) in self.markers.iter().enumerate() {
            self.rule(&marker.rule)?;
            marker.anchor.validate()?;
            if !valid_id(&marker.id, 100)
                || marker.prompt.len() > 4000
                || self.markers[..index].iter().any(|m| m.id == marker.id)
            {
                return Err(Error::new(
                    "format",
                    "Invalid or duplicate highlight metadata. The sidecar has been preserved.",
                ));
            }
        }
        for (index, suggestion) in self.suggestions.iter().enumerate() {
            suggestion.anchor.validate()?;
            if !valid_id(&suggestion.id, 100)
                || !valid_id(&suggestion.request_id, 100)
                || !valid_color(&suggestion.color)
                || suggestion.replacement.len() > 32_000
                || suggestion.rationale.len() > 4000
                || suggestion.prompt.len() > MAX_POLICY_PROMPT
                || (!suggestion.fingerprint.is_empty() && !valid_digest(&suggestion.fingerprint))
                || self.suggestions[..index]
                    .iter()
                    .any(|s| s.id == suggestion.id || s.request_id == suggestion.request_id)
            {
                return Err(Error::new(
                    "format",
                    "Invalid or duplicate suggestion metadata. The sidecar has been preserved.",
                ));
            }
        }
        if serde_json::to_vec_pretty(self)?.len() > MAX_TEXT * 8 {
            return Err(Error::new(
                "limit",
                "The review sidecar exceeds 16 MB. Remove old suggestions before adding more.",
            ));
        }
        Ok(())
    }

    pub fn validate_for_text(&self, text: &str) -> Result<()> {
        self.validate()?;
        if self.revision != digest(text) {
            return Ok(());
        }
        for anchor in self.markers.iter().map(|m| &m.anchor).chain(
            self.suggestions
                .iter()
                .filter(|s| s.status == Status::Pending)
                .map(|s| &s.anchor),
        ) {
            if !anchor.stale && selected(text, anchor.from, anchor.to)? != anchor.quote {
                return Err(Error::new("format", "A current review anchor does not match its manuscript. The sidecar has been preserved."));
            }
        }
        Ok(())
    }

    pub fn rule(&self, id: &str) -> Result<&Rule> {
        self.rules
            .iter()
            .find(|r| r.id == id)
            .ok_or_else(|| Error::new("rule", "Choose an existing color rule."))
    }

    pub fn check_revision(&self, revision: &str, text: &str) -> Result<()> {
        if self.revision != revision || digest(text) != revision {
            return Err(Error::new(
                "stale",
                "The manuscript changed. Refresh before reviewing this passage.",
            ));
        }
        Ok(())
    }

    pub fn reanchor(
        &mut self,
        text: &str,
        revision: &str,
        id: &str,
        range: std::ops::Range<usize>,
        quote: &str,
    ) -> Result<()> {
        self.check_revision(revision, text)?;
        if quote.len() > 32_000 || !valid_id(id, 100) {
            return Err(Error::new(
                "limit",
                "Use an existing highlight ID and a passage smaller than 32 KB.",
            ));
        }
        let index = self
            .markers
            .iter()
            .position(|marker| marker.id == id)
            .ok_or_else(|| Error::new("missing", "This highlight no longer exists."))?;
        let anchor = Anchor::new(text, range.start, range.end)?;
        if anchor.quote != quote {
            return Err(Error::new(
                "stale",
                "The selected passage does not match the current manuscript.",
            ));
        }
        self.markers[index].anchor = anchor;
        Ok(())
    }

    pub fn reconcile(&mut self, old: &str, new: &str) {
        for marker in &mut self.markers {
            marker.anchor.reconcile(old, new);
        }
        for suggestion in &mut self.suggestions {
            if suggestion.status == Status::Pending {
                suggestion.anchor.reconcile(old, new);
            }
        }
        self.revision = digest(new);
    }

    pub fn invalidate_external(&mut self, text: &str) {
        if self.revision != digest(text) {
            // Without an old source snapshot, guessing could move a protection onto the wrong occurrence.
            for marker in &mut self.markers {
                marker.anchor.stale = true;
            }
            for suggestion in &mut self.suggestions {
                if suggestion.status == Status::Pending {
                    suggestion.anchor.stale = true;
                }
            }
            self.revision = digest(text);
        }
    }

    pub fn policy(&self, from: usize, to: usize) -> Result<(String, String)> {
        let mut color = "#8ba8cc".to_owned();
        let mut prompts = Vec::new();
        for marker in &self.markers {
            let rule = self.rule(&marker.rule)?;
            if marker.anchor.stale && rule.action != Action::Prompt {
                return Err(Error::new("protected", "A protected marker is stale. The user must reanchor or remove it before agent suggestions resume."));
            }
            if marker.anchor.stale || from >= marker.anchor.to || to <= marker.anchor.from {
                continue;
            }
            if rule.action != Action::Prompt {
                return Err(Error::new(
                    "protected",
                    "This passage is marked against agent changes.",
                ));
            }
            color = rule.color.clone();
            for prompt in [&rule.prompt, &marker.prompt] {
                if !prompt.is_empty() && !prompts.contains(prompt) {
                    prompts.push(prompt.clone());
                }
            }
        }
        let prompt = prompts.join("\n");
        if prompt.len() > MAX_POLICY_PROMPT {
            return Err(Error::new("limit", "This passage has more than 32 KB of review instructions. Simplify its highlights first."));
        }
        Ok((color, prompt))
    }

    pub fn propose(&mut self, text: &str, proposal: Proposal) -> Result<Suggestion> {
        self.propose_format(text, proposal, false)
    }

    pub fn propose_format(
        &mut self,
        text: &str,
        proposal: Proposal,
        typst: bool,
    ) -> Result<Suggestion> {
        if !valid_id(&proposal.request_id, 100)
            || proposal.replacement.len() > 32_000
            || proposal.rationale.len() > 4000
        {
            return Err(Error::new(
                "proposal",
                "Use a stable request ID and bounded replacement and explanation.",
            ));
        }
        let fingerprint = digest(&serde_json::to_string(&proposal)?);
        if let Some(previous) = self
            .suggestions
            .iter()
            .find(|s| s.request_id == proposal.request_id)
        {
            if previous.fingerprint == fingerprint {
                return Ok(previous.clone());
            }
            return Err(Error::new(
                "duplicate",
                "That request ID already identifies a different suggestion.",
            ));
        }
        self.check_revision(&proposal.revision, text)?;
        if self.suggestions.len() >= MAX_ITEMS {
            return Err(Error::new(
                "limit",
                "The review has reached its 500-suggestion limit.",
            ));
        }
        let anchor = Anchor::new(text, proposal.from, proposal.to)?;
        if anchor.quote != proposal.quote {
            return Err(Error::new(
                "stale",
                "The quoted passage does not match the manuscript.",
            ));
        }
        let allowed = if typst {
            is_typst_text(text, proposal.from, proposal.to)?
        } else {
            is_html_text(text, proposal.from, proposal.to)?
        };
        if !allowed {
            return Err(Error::new("scope", "Agents may suggest manuscript prose only, not markup, attributes, scripts, styles, Typst code, or equations."));
        }
        let (color, prompt) = self.policy(proposal.from, proposal.to)?;
        let suggestion = Suggestion {
            id: Uuid::new_v4().to_string(),
            request_id: proposal.request_id,
            anchor,
            replacement: proposal.replacement,
            rationale: proposal.rationale,
            status: Status::Pending,
            color,
            prompt,
            fingerprint,
        };
        self.suggestions.push(suggestion.clone());
        Ok(suggestion)
    }

    pub fn decide(
        &mut self,
        text: &str,
        revision: &str,
        id: &str,
        decision: Decision,
    ) -> Result<String> {
        self.decide_format(text, revision, id, decision, false)
    }

    pub fn decide_format(
        &mut self,
        text: &str,
        revision: &str,
        id: &str,
        decision: Decision,
        typst: bool,
    ) -> Result<String> {
        self.check_revision(revision, text)?;
        let index = self
            .suggestions
            .iter()
            .position(|s| s.id == id)
            .ok_or_else(|| Error::new("missing", "Suggestion not found."))?;
        let suggestion = &self.suggestions[index];
        if suggestion.status != Status::Pending {
            return Err(Error::new(
                "decided",
                "This suggestion has already been reviewed.",
            ));
        }
        if decision == Decision::Rejected {
            self.suggestions[index].status = Status::Rejected;
            return Ok(text.to_owned());
        }
        if suggestion.anchor.stale
            || selected(text, suggestion.anchor.from, suggestion.anchor.to)?
                != suggestion.anchor.quote
        {
            return Err(Error::new(
                "stale",
                "The original passage has changed. Ask for a new suggestion.",
            ));
        }
        let allowed = if typst {
            is_typst_text(text, suggestion.anchor.from, suggestion.anchor.to)?
        } else {
            is_html_text(text, suggestion.anchor.from, suggestion.anchor.to)?
        };
        if !allowed {
            return Err(Error::new(
                "scope",
                "This suggestion no longer targets ordinary manuscript prose.",
            ));
        }
        self.policy(suggestion.anchor.from, suggestion.anchor.to)?;
        let start = byte_offset(text, suggestion.anchor.from)?;
        let end = byte_offset(text, suggestion.anchor.to)?;
        let replacement = if typst {
            escape_typst(&suggestion.replacement)
        } else {
            escape_html(&suggestion.replacement)
        };
        let changed = format!("{}{}{}", &text[..start], replacement, &text[end..]);
        if changed.len() > MAX_TEXT {
            return Err(Error::new(
                "limit",
                "The manuscript exceeds the 2 MB limit.",
            ));
        }
        self.suggestions[index].status = Status::Accepted;
        self.reconcile(text, &changed);
        Ok(changed)
    }
}

pub fn escape_html(text: &str) -> String {
    text.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

pub fn is_typst_text(text: &str, from: usize, to: usize) -> Result<bool> {
    use typst_syntax::{LinkedNode, SyntaxKind, SyntaxMode};
    selected(text, from, to)?;
    let start = byte_offset(text, from)?;
    let end = byte_offset(text, to)?;
    let root = typst_syntax::parse(text);
    if !root.errors_and_warnings().0.is_empty() {
        return Ok(false);
    }
    fn allowed(node: LinkedNode<'_>, start: usize, end: usize, covered: &mut usize) -> bool {
        let range = node.range();
        if range.end <= start || range.start >= end {
            return true;
        }
        if node.children().next().is_none() {
            if !matches!(
                node.kind(),
                SyntaxKind::Text | SyntaxKind::Space | SyntaxKind::Parbreak
            ) || node.mode_after() != Some(SyntaxMode::Markup)
            {
                return false;
            }
            *covered += range.end.min(end) - range.start.max(start);
            return true;
        }
        if matches!(
            node.kind(),
            SyntaxKind::Code
                | SyntaxKind::CodeBlock
                | SyntaxKind::Equation
                | SyntaxKind::Math
                | SyntaxKind::Raw
                | SyntaxKind::Str
                | SyntaxKind::LineComment
                | SyntaxKind::BlockComment
        ) {
            return false;
        }
        node.children()
            .all(|child| allowed(child, start, end, covered))
    }
    let mut covered = 0;
    Ok(allowed(LinkedNode::new(&root), start, end, &mut covered) && covered == end - start)
}

pub fn escape_typst(text: &str) -> String {
    let mut result = String::with_capacity(text.len());
    for character in text.chars() {
        if "\\#[]{}*_`$@<>=+-/:~.".contains(character) {
            result.push('\\');
        }
        result.push(character);
    }
    result
}

// A conservative source tokenizer: only a single ordinary text run is agent-editable.
pub fn is_html_text(text: &str, from: usize, to: usize) -> Result<bool> {
    selected(text, from, to)?;
    let start = byte_offset(text, from)?;
    let end = byte_offset(text, to)?;
    let bytes = text.as_bytes();
    let mut cursor = 0;
    let mut raw: Option<String> = None;
    while cursor < bytes.len() {
        if bytes[cursor] == b'<' {
            let tag_start = cursor;
            let mut quote = None;
            cursor += 1;
            if text[tag_start..].starts_with("<!--") {
                let Some(length) = text[cursor..].find("-->") else {
                    return Ok(false);
                };
                cursor += length + 3;
                continue;
            }
            while cursor < bytes.len() {
                let byte = bytes[cursor];
                if let Some(q) = quote {
                    if byte == q {
                        quote = None;
                    }
                } else if byte == b'\'' || byte == b'"' {
                    quote = Some(byte);
                } else if byte == b'>' {
                    break;
                }
                cursor += 1;
            }
            if cursor == bytes.len() {
                return Ok(false);
            }
            let tag = text[tag_start + 1..cursor].trim().to_ascii_lowercase();
            let name = tag
                .split_whitespace()
                .next()
                .unwrap_or("")
                .trim_end_matches('/');
            if let Some(open) = &raw {
                if name.strip_prefix('/') == Some(open.as_str()) {
                    raw = None;
                }
            } else if [
                "script",
                "style",
                "textarea",
                "title",
                "xmp",
                "iframe",
                "noembed",
                "noframes",
                "plaintext",
            ]
            .contains(&name)
            {
                raw = Some(name.to_owned());
            }
            cursor += 1;
        } else {
            let run_start = cursor;
            while cursor < bytes.len() && bytes[cursor] != b'<' {
                cursor += 1;
            }
            if start >= run_start && end <= cursor {
                // Do not split HTML entities: replacing half an entity changes surrounding text.
                let run = &text[run_start..cursor];
                for (offset, _) in run.match_indices('&') {
                    if let Some(length) = run[offset..].find(';') {
                        let a = run_start + offset;
                        let b = a + length + 1;
                        if (start > a && start < b) || (end > a && end < b) {
                            return Ok(false);
                        }
                    }
                }
                return Ok(raw.is_none());
            }
        }
    }
    Ok(false)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn proposal(text: &str, from: usize, to: usize) -> Proposal {
        Proposal {
            request_id: "request-1".into(),
            revision: digest(text),
            from,
            to,
            quote: selected(text, from, to).unwrap().into(),
            replacement: "Better <script>".into(),
            rationale: "Clearer".into(),
        }
    }
    #[test]
    fn suggestions_do_not_edit_and_acceptance_escapes_html() {
        let text = "<p>Hello world</p>";
        let mut review = Review::new(text);
        let s = review.propose(text, proposal(text, 3, 8)).unwrap();
        assert_eq!(review.revision, digest(text));
        assert_eq!(
            review
                .decide(text, &digest(text), &s.id, Decision::Accepted)
                .unwrap(),
            "<p>Better &lt;script&gt; world</p>"
        );
    }
    #[test]
    fn protect_and_reject_override_prompts_and_stale_protection_blocks() {
        let text = "<p>Hello world</p>";
        let mut review = Review::new(text);
        review.markers.push(Marker {
            id: "m".into(),
            anchor: Anchor::new(text, 3, 8).unwrap(),
            rule: "protect".into(),
            prompt: String::new(),
        });
        assert_eq!(
            review.propose(text, proposal(text, 3, 8)).unwrap_err().code,
            "protected"
        );
        review.invalidate_external("<p>Changed world</p>");
        assert_eq!(review.policy(11, 16).unwrap_err().code, "protected");
    }
    #[test]
    fn anchors_shift_for_earlier_edits_and_go_stale_on_overlap() {
        let old = "<p>Hello world</p>";
        let mut a = Anchor::new(old, 9, 14).unwrap();
        a.reconcile(old, "<p>Hi world</p>");
        assert_eq!((a.from, a.to, a.stale), (6, 11, false));
        a.reconcile("<p>Hi world</p>", "<p>Hi earth</p>");
        assert!(a.stale);
    }
    #[test]
    fn utf16_ranges_and_markup_boundaries() {
        assert_eq!(selected("a😀b", 1, 3).unwrap(), "😀");
        assert!(selected("a😀b", 1, 2).is_err());
        assert!(!is_html_text("<p title='x'>Hello</p>", 3, 8).unwrap());
        assert!(!is_html_text("<script>Hello</script>", 8, 13).unwrap());
        assert!(!is_html_text("<p>&amp;</p>", 4, 6).unwrap());
        assert!(is_html_text("<p>😀 &amp;</p>", 3, 11).unwrap());
    }
    #[test]
    fn stale_revision_replay_and_reject() {
        let text = "<p>Hello</p>";
        let mut review = Review::new(text);
        let s = review.propose(text, proposal(text, 3, 8)).unwrap();
        assert_eq!(review.propose(text, proposal(text, 3, 8)).unwrap().id, s.id);
        assert_eq!(
            review
                .decide(text, "wrong", &s.id, Decision::Accepted)
                .unwrap_err()
                .code,
            "stale"
        );
        assert_eq!(
            review
                .decide(text, &digest(text), &s.id, Decision::Rejected)
                .unwrap(),
            text
        );
    }
    #[test]
    fn typst_proposals_cannot_change_code_or_inject_markup() {
        let text = "#set text(size: 11pt)\n\n= Heading\n\nHello world.\n";
        let from = text.find("Hello").unwrap();
        let mut review = Review::new(text);
        assert!(is_typst_text(text, from, from + 11).unwrap());
        assert!(!is_typst_text(text, 5, 9).unwrap());
        let mut p = proposal(text, from, from + 11);
        p.replacement = "#read(\"secret\")".into();
        let s = review.propose_format(text, p, true).unwrap();
        let changed = review
            .decide_format(text, &digest(text), &s.id, Decision::Accepted, true)
            .unwrap();
        assert!(changed.contains("\\#read"));
        assert!(typst_syntax::parse(&changed)
            .errors_and_warnings()
            .0
            .is_empty());
    }

    #[test]
    fn typst_review_rejects_code_whitespace_math_raw_and_invalid_syntax() {
        for (text, needle) in [
            ("#let value = 1", " = "),
            ("#let value = 1 + 2", " + "),
            ("$a + b$", " + "),
            ("`plain`", "plain"),
            ("// plain\nHello", "plain"),
            ("#let value = \"plain\"", "plain"),
        ] {
            let from = text.find(needle).unwrap();
            assert!(
                !is_typst_text(text, from, from + needle.len()).unwrap(),
                "{text}"
            );
        }
        assert!(!is_typst_text("Hello #let x = (", 0, 5).unwrap());
        assert!(is_typst_text("#strong[Hello world]", 8, 19).unwrap());
        assert!(is_typst_text("Plain paragraph.", 0, 16).unwrap());
        assert!(is_typst_text("Hello", 3, 2).is_err());
        let escaped = escape_typst("\n1. Item\n- Item\n#read(\"secret\") $x$ [body]");
        let syntax = typst_syntax::parse(&escaped);
        assert!(syntax.errors_and_warnings().0.is_empty());
        fn contains_code(node: &typst_syntax::SyntaxNode) -> bool {
            matches!(
                node.kind(),
                typst_syntax::SyntaxKind::Hash
                    | typst_syntax::SyntaxKind::Equation
                    | typst_syntax::SyntaxKind::EnumItem
                    | typst_syntax::SyntaxKind::ListItem
            ) || node.children().any(contains_code)
        }
        assert!(!contains_code(&syntax));
    }

    #[test]
    fn html_raw_content_cannot_be_unlocked_by_a_different_closing_tag() {
        let text = "<script>secret</style>still script</script><p>Prose</p>";
        let from = text.find("still").unwrap();
        assert!(!is_html_text(text, from, from + 12).unwrap());
        let from = text.find("Prose").unwrap();
        assert!(is_html_text(text, from, from + 5).unwrap());
    }

    #[test]
    fn sidecar_rejects_forged_current_anchors_duplicates_and_oversized_fields() {
        let text = "Hello world";
        let marker = Marker {
            id: "marker".into(),
            anchor: Anchor::new(text, 0, 5).unwrap(),
            rule: "protect".into(),
            prompt: String::new(),
        };
        let mut review = Review::new(text);
        review.markers.push(marker.clone());
        review.validate_for_text(text).unwrap();
        review.markers[0].anchor.quote = "world".into();
        assert_eq!(review.validate_for_text(text).unwrap_err().code, "format");
        review.markers[0].anchor.stale = true;
        review.validate_for_text(text).unwrap();
        review.markers.push(marker);
        assert_eq!(review.validate().unwrap_err().code, "format");
        review.markers.pop();
        review.markers[0].prompt = "x".repeat(4001);
        assert_eq!(review.validate().unwrap_err().code, "format");
    }

    #[test]
    fn policies_are_deduplicated_and_rechecked_at_acceptance() {
        let text = "<p>Hello world</p>";
        let mut review = Review::new(text);
        for id in ["one", "two"] {
            review.markers.push(Marker {
                id: id.into(),
                anchor: Anchor::new(text, 3, 8).unwrap(),
                rule: "snappier".into(),
                prompt: "Keep terms".into(),
            });
        }
        let instructions = review.policy(3, 8).unwrap().1;
        assert_eq!(instructions.matches("Keep terms").count(), 1);
        assert_eq!(instructions.matches("Keep the content").count(), 1);
        let suggestion = review.propose(text, proposal(text, 3, 8)).unwrap();
        review
            .rules
            .iter_mut()
            .find(|r| r.id == "snappier")
            .unwrap()
            .action = Action::Protect;
        assert_eq!(
            review
                .decide(text, &digest(text), &suggestion.id, Decision::Accepted)
                .unwrap_err()
                .code,
            "protected"
        );
        assert_eq!(review.suggestions[0].status, Status::Pending);
    }
    #[test]
    fn reanchor_preserves_rules_and_prompts_and_only_resolves_the_selected_marker() {
        let original = "<p>Hello world</p>";
        let current = "<p>Changed world</p>";
        let mut review = Review::new(original);
        for id in ["first", "second"] {
            review.markers.push(Marker {
                id: id.into(),
                anchor: Anchor::new(original, 3, 8).unwrap(),
                rule: "protect".into(),
                prompt: "Keep every claim.".into(),
            });
        }
        let rules = serde_json::to_value(&review.rules).unwrap();
        review.invalidate_external(current);
        assert_eq!(
            review
                .propose(current, proposal(current, 11, 16))
                .unwrap_err()
                .code,
            "protected"
        );
        review
            .reanchor(current, &digest(current), "first", 3..10, "Changed")
            .unwrap();
        assert!(!review.markers[0].anchor.stale);
        assert!(review.markers[1].anchor.stale);
        assert_eq!(
            review
                .propose(current, proposal(current, 11, 16))
                .unwrap_err()
                .code,
            "protected"
        );
        review
            .reanchor(current, &digest(current), "second", 3..10, "Changed")
            .unwrap();
        assert_eq!(review.markers.len(), 2);
        for marker in &review.markers {
            assert_eq!(marker.rule, "protect");
            assert_eq!(marker.prompt, "Keep every claim.");
            assert_eq!(marker.anchor.quote, "Changed");
        }
        assert_eq!(serde_json::to_value(&review.rules).unwrap(), rules);
        assert_eq!(
            review
                .propose(current, proposal(current, 3, 10))
                .unwrap_err()
                .code,
            "protected"
        );
        assert!(review.propose(current, proposal(current, 11, 16)).is_ok());
        assert_eq!(review.revision, digest(current));
    }

    #[test]
    fn invalid_reanchor_cannot_clear_stale_protection() {
        let original = "<p>Hello world</p>";
        let current = "<p>😀 world</p>";
        let mut review = Review::new(original);
        review.markers.push(Marker {
            id: "marker".into(),
            anchor: Anchor::new(original, 3, 8).unwrap(),
            rule: "protect".into(),
            prompt: "Preserve meaning.".into(),
        });
        review.invalidate_external(current);
        let before = serde_json::to_value(&review).unwrap();
        let revision = digest(current);
        let oversized = "x".repeat(32_001);
        for (revision, id, range, quote, code) in [
            (digest(original), "marker", 3..5, "😀", "stale"),
            (revision.clone(), "missing", 3..5, "😀", "missing"),
            (revision.clone(), "marker", 3..5, "Wrong", "stale"),
            (revision.clone(), "marker", 3..4, "😀", "range"),
            (revision.clone(), "marker", 3..3, "", "range"),
            (
                revision.clone(),
                "marker",
                usize::MAX - 1..usize::MAX,
                "x",
                "range",
            ),
            (
                revision.clone(),
                "marker",
                3..5,
                oversized.as_str(),
                "limit",
            ),
        ] {
            assert_eq!(
                review
                    .reanchor(current, &revision, id, range, quote)
                    .unwrap_err()
                    .code,
                code
            );
            assert_eq!(serde_json::to_value(&review).unwrap(), before);
        }
        review
            .reanchor(current, &revision, "marker", 3..5, "😀")
            .unwrap();
        assert_eq!(review.markers[0].anchor.quote, "😀");
        assert!(!review.markers[0].anchor.stale);
    }

    #[test]
    fn local_reanchor_keeps_syntax_and_math_scope_without_granting_remote_edits() {
        for (text, range, quote, typst) in [
            ("<p>Hello</p>", 0..3, "<p>", false),
            ("#let x = 1\n\nProse $x + 1$\n", 0..4, "#let", true),
            ("$x + 1$\n", 1..6, "x + 1", true),
        ] {
            let mut review = Review::new(text);
            let mut anchor = Anchor::new(text, range.start, range.end).unwrap();
            anchor.stale = true;
            review.markers.push(Marker {
                id: "marker".into(),
                anchor,
                rule: "snappier".into(),
                prompt: "Keep this syntax.".into(),
            });
            review
                .reanchor(text, &digest(text), "marker", range.clone(), quote)
                .unwrap();
            assert!(!review.markers[0].anchor.stale);
            assert_eq!(review.markers[0].prompt, "Keep this syntax.");
            let request = proposal(text, range.start, range.end);
            assert_eq!(
                review
                    .propose_format(text, request, typst)
                    .unwrap_err()
                    .code,
                "scope"
            );
        }
    }
}
