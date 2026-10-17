use super::*;
use std::collections::{BTreeMap, BTreeSet};
pub(super) const MAX_RECEIPT_BYTES: usize = 512 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MarkerPosition {
    pub id: String,
    pub rule: String,
    pub anchor: Anchor,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PreservationReceipt {
    from_revision: String,
    to_revision: String,
    before_policy: String,
    after_policy: String,
    before: Vec<MarkerPosition>,
    after: Vec<MarkerPosition>,
}

impl PreservationReceipt {
    pub(super) fn validate(&self) -> Result<()> {
        if [
            &self.from_revision,
            &self.to_revision,
            &self.before_policy,
            &self.after_policy,
        ]
        .iter()
        .any(|value| !valid_digest(value))
            || self.before.len() != self.after.len()
            || self.before.len() > MAX_ITEMS
        {
            return Err(Error::new(
                "format",
                "Invalid native preservation receipt. The sidecar was preserved.",
            ));
        }
        let mut ids = BTreeSet::new();
        for (before, after) in self.before.iter().zip(&self.after) {
            before.anchor.validate()?;
            after.anchor.validate()?;
            if !valid_id(&before.id, 100)
                || !valid_id(&before.rule, 64)
                || before.id != after.id
                || before.rule != after.rule
                || !ids.insert(&before.id)
            {
                return Err(Error::new(
                    "format",
                    "Invalid native marker identity in preservation receipt.",
                ));
            }
        }
        Ok(())
    }
}

pub(super) struct Reconstruction {
    pub raw: String,
    pub display: String,
    // Original marker identity -> replacement-relative UTF-16 start.
    moves: BTreeMap<String, usize>,
}

pub(super) fn validate_parts(parts: &[ReplacementPart]) -> Result<()> {
    if parts.is_empty() || parts.len() > 128 || serde_json::to_vec(parts)?.len() > 64_000 {
        return Err(Error::new(
            "preservation",
            "Use at most 128 bounded replacement parts.",
        ));
    }
    for part in parts {
        match part {
            ReplacementPart::Text(value) if value.text.len() <= 32_000 => {}
            ReplacementPart::Protected(value) if valid_id(&value.protected_id, 100) => {}
            _ => {
                return Err(Error::new(
                    "preservation",
                    "Invalid protected reference or replacement text.",
                ))
            }
        }
    }
    Ok(())
}

impl Review {
    pub(super) fn preservation_positions(&self) -> Vec<MarkerPosition> {
        self.markers
            .iter()
            .map(|marker| MarkerPosition {
                id: marker.id.clone(),
                rule: marker.rule.clone(),
                anchor: marker.anchor.clone(),
            })
            .collect()
    }

    pub(super) fn record_preservation(
        &mut self,
        old: &str,
        new: &str,
        before: Vec<MarkerPosition>,
        before_policy: String,
    ) -> Result<()> {
        if old == new {
            return Ok(());
        }
        let after = self.preservation_positions();
        let positions: Vec<_> = before
            .into_iter()
            .zip(after)
            .filter(|(before, after)| before.anchor != after.anchor)
            .collect();
        let (before, after) = positions.into_iter().unzip();
        let receipt = PreservationReceipt {
            from_revision: digest(old),
            to_revision: digest(new),
            before_policy,
            after_policy: self.preservation_policy()?,
            before,
            after,
        };
        receipt.validate()?;
        if serde_json::to_vec(&vec![&receipt])?.len() > MAX_RECEIPT_BYTES {
            return Err(Error::new("limit", "This protected rewrite exceeds the native Undo mapping bound. Reduce its highlight scope first."));
        }
        self.preservations.push(receipt);
        // Older than 32 mappings or 512 KiB fails closed through ordinary stale-anchor handling.
        while self.preservations.len() > 32
            || serde_json::to_vec(&self.preservations)?.len() > MAX_RECEIPT_BYTES
        {
            self.preservations.remove(0);
        }
        Ok(())
    }

    pub(super) fn preservation_transition(
        &self,
        old: &str,
        new: &str,
    ) -> Option<Vec<MarkerPosition>> {
        if self.preservations.is_empty() || old == new {
            return None;
        }
        let (from, to) = (digest(old), digest(new));
        if !self.preservations.iter().any(|receipt| {
            (receipt.to_revision == from && receipt.from_revision == to)
                || (receipt.from_revision == from && receipt.to_revision == to)
        }) {
            return None;
        }
        let policy = self.preservation_policy().ok()?;
        let positions = self.preservations.iter().rev().find_map(|receipt| {
            if receipt.to_revision == from
                && receipt.from_revision == to
                && receipt.after_policy == policy
            {
                Some(&receipt.before)
            } else if receipt.from_revision == from
                && receipt.to_revision == to
                && receipt.before_policy == policy
            {
                Some(&receipt.after)
            } else {
                None
            }
        })?;
        if positions.iter().any(|position| {
            !self
                .markers
                .iter()
                .any(|marker| marker.id == position.id && marker.rule == position.rule)
                || (!position.anchor.stale
                    && selected(new, position.anchor.from, position.anchor.to).ok()
                        != Some(position.anchor.quote.as_str()))
        }) {
            return None;
        }
        Some(positions.clone())
    }

    pub(super) fn protected_prose_scope(
        &self,
        text: &str,
        from: usize,
        to: usize,
        typst: bool,
    ) -> Result<bool> {
        let mut units: Vec<_> = self
            .markers
            .iter()
            .filter(|marker| {
                marker.anchor.from < to
                    && marker.anchor.to > from
                    && self.rules.iter().any(|rule| {
                        rule.id == marker.rule
                            && matches!(rule.action, Action::Protect | Action::Reject)
                    })
            })
            .collect();
        units.sort_by_key(|marker| marker.anchor.from);
        let mut cursor = from;
        for marker in units {
            if marker.anchor.stale || marker.anchor.from < cursor || marker.anchor.to > to {
                return Ok(false);
            }
            if !typst && !is_html_text(text, marker.anchor.from, marker.anchor.to)? {
                return Ok(false);
            }
            if cursor < marker.anchor.from
                && !(if typst {
                    is_typst_text(text, cursor, marker.anchor.from)?
                } else {
                    is_html_text(text, cursor, marker.anchor.from)?
                })
            {
                return Ok(false);
            }
            cursor = marker.anchor.to;
        }
        Ok(cursor == to
            || if typst {
                is_typst_text(text, cursor, to)?
            } else {
                is_html_text(text, cursor, to)?
            })
    }

    pub(super) fn preservation_policy(&self) -> Result<String> {
        Ok(digest(&serde_json::to_string(
            &serde_json::json!({"rules":self.rules,"markers":self.markers,"pdfAnnotations":self.pdf_annotations}),
        )?))
    }

    pub(super) fn reconstruct(
        &self,
        text: &str,
        from: usize,
        to: usize,
        parts: &[ReplacementPart],
        typst: bool,
    ) -> Result<Reconstruction> {
        validate_parts(parts)?;
        let mut units = Vec::new();
        for marker in &self.markers {
            if !matches!(
                self.rule(&marker.rule)?.action,
                Action::Protect | Action::Reject
            ) {
                continue;
            }
            if marker.anchor.stale {
                return Err(Error::new(
                    "protected",
                    "Reanchor stale protection locally before rewriting.",
                ));
            }
            if marker.anchor.from >= to || marker.anchor.to <= from {
                continue;
            }
            if marker.anchor.from < from
                || marker.anchor.to > to
                || selected(text, marker.anchor.from, marker.anchor.to)? != marker.anchor.quote
            {
                return Err(Error::new(
                    "protected",
                    "A rewrite must contain each current protected unit completely.",
                ));
            }
            units.push(marker);
        }
        units.sort_by_key(|marker| marker.anchor.from);
        if units.is_empty()
            || units
                .windows(2)
                .any(|pair| pair[0].anchor.to > pair[1].anchor.from)
        {
            return Err(Error::new("protected", "Protected references require distinct, nonoverlapping native units. Resolve conflicting protection locally."));
        }
        let mut seen = BTreeSet::new();
        let mut result = Reconstruction {
            raw: String::new(),
            display: String::new(),
            moves: BTreeMap::new(),
        };
        for part in parts {
            match part {
                ReplacementPart::Text(value) => {
                    result.display.push_str(&value.text);
                    result.raw.push_str(&if typst {
                        escape_typst(&value.text)
                    } else {
                        escape_html(&value.text)
                    });
                }
                ReplacementPart::Protected(value) => {
                    let marker = units
                        .iter()
                        .find(|marker| marker.id == value.protected_id)
                        .ok_or_else(|| {
                            Error::new(
                                "preservation",
                                "A protected identity is unknown or outside this rewrite.",
                            )
                        })?;
                    if !seen.insert(&value.protected_id) {
                        return Err(Error::new(
                            "preservation",
                            "A protected identity must occur exactly once.",
                        ));
                    }
                    result.moves.insert(
                        value.protected_id.clone(),
                        result.raw.encode_utf16().count(),
                    );
                    result.raw.push_str(&marker.anchor.quote);
                    result.display.push_str(&marker.anchor.quote);
                }
            }
            if result.raw.len() > 32_000 || result.display.len() > 32_000 {
                return Err(Error::new(
                    "limit",
                    "The reconstructed replacement exceeds 32 KB.",
                ));
            }
        }
        if seen.len() != units.len() {
            return Err(Error::new(
                "preservation",
                "Every protected unit must occur exactly once in the replacement.",
            ));
        }
        // A crossing overlay cannot be moved without guessing which new prose it covers.
        for marker in &self.markers {
            if marker.anchor.stale || (marker.anchor.from <= from && marker.anchor.to >= to) {
                continue;
            }
            if units.iter().any(|unit| {
                marker.anchor.from < unit.anchor.to
                    && marker.anchor.to > unit.anchor.from
                    && !(marker.anchor.from >= unit.anchor.from
                        && marker.anchor.to <= unit.anchor.to)
            }) {
                return Err(Error::new("preservation", "An overlapping marker crosses a protected-unit boundary. Resolve it locally before moving that unit."));
            }
        }
        Ok(result)
    }

    pub(super) fn preserved_anchors(
        &self,
        _old: &str,
        changed: &str,
        from: usize,
        to: usize,
        reconstruction: &Reconstruction,
    ) -> Result<Vec<(String, Anchor)>> {
        let mut anchors = Vec::new();
        for marker in &self.markers {
            if marker.anchor.stale {
                continue;
            }
            let range = if marker.anchor.from <= from && marker.anchor.to >= to {
                Some((
                    marker.anchor.from,
                    marker.anchor.to - (to - from) + reconstruction.raw.encode_utf16().count(),
                ))
            } else {
                reconstruction.moves.iter().find_map(|(id, relative)| {
                    let unit = self.markers.iter().find(|unit| &unit.id == id)?;
                    (marker.anchor.from >= unit.anchor.from && marker.anchor.to <= unit.anchor.to)
                        .then(|| {
                            (
                                from + relative + marker.anchor.from - unit.anchor.from,
                                from + relative + marker.anchor.to - unit.anchor.from,
                            )
                        })
                })
            };
            if let Some((start, end)) = range {
                let anchor = Anchor::new(changed, start, end)?;
                if matches!(
                    self.rule(&marker.rule)?.action,
                    Action::Protect | Action::Reject
                ) && anchor.quote != marker.anchor.quote
                {
                    return Err(Error::new(
                        "protected",
                        "Native reconstruction changed protected text.",
                    ));
                }
                anchors.push((marker.id.clone(), anchor));
            }
        }
        Ok(anchors)
    }
}
