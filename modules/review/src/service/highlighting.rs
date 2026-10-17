use super::*;
use crate::document::{Action, Rule};

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Marking {
    pub request_id: String,
    pub context_id: String,
    pub revision: String,
    pub color_id: Option<String>,
    pub ranges: Vec<HighlightRange>,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct HighlightRange {
    from: usize,
    to: usize,
    quote: String,
}

fn distinguishable(left: &str, right: &str) -> bool {
    let distance = [1, 3, 5].into_iter().try_fold(0i32, |total, start| {
        let a = i32::from_str_radix(left.get(start..start + 2)?, 16).ok()?;
        let b = i32::from_str_radix(right.get(start..start + 2)?, 16).ok()?;
        Some(total + (a - b) * (a - b))
    });
    distance.is_some_and(|distance| distance >= 1600)
}

impl Service {
    pub(super) fn highlight_remote(
        &self,
        arguments: Value,
        editor: &editor::EditorState,
    ) -> Result<Value> {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        struct Request {
            document_id: String,
            marking: Marking,
        }
        let request: Request = serde_json::from_value(arguments)?;
        let marking = request.marking;
        if marking.request_id.trim().is_empty()
            || marking.request_id.len() > 100
            || marking.request_id.chars().any(char::is_control)
            || marking.ranges.is_empty()
            || marking.ranges.len() > 64
            || serde_json::to_vec(&marking)?.len() > 64_000
        {
            return Err(Error::new(
                "highlight",
                "Use a stable request ID and one bounded batch of at most 64 exact passages.",
            ));
        }
        let id = request.document_id;
        let (project, path, epoch, root) = self.shared_source(&id)?;
        let binding = SourceBinding::new(&project, &path, epoch).rooted(Some(root));
        let fingerprint = digest(&serde_json::to_string(&marking)?);
        if let Some(result) =
            self.replay_highlighting(&id, binding, &marking.request_id, &fingerprint, editor)?
        {
            return Ok(result);
        }
        self.require_review_context(&id, binding, Some(&marking.context_id), editor)?;
        let p = self.project(&project)?;
        let file = self.path(&p, &path, false)?;
        let document = self.held_document(binding, &file, false)?;
        let text = &document.content;
        let mut review = document.review.clone();
        review.check_revision(&marking.revision, text)?;
        if review.markers.len() + marking.ranges.len() > MAX_ITEMS {
            return Err(Error::new("limit", "At most 500 highlights are supported."));
        }
        // Build and validate everything before publishing one adjacent metadata update.
        let mut anchors = Vec::new();
        for range in marking.ranges {
            let anchor = Anchor::new(text, range.from, range.to)?;
            if anchor.quote != range.quote {
                return Err(Error::new(
                    "stale",
                    "A highlighted quote no longer matches the saved manuscript.",
                ));
            }
            if anchors
                .iter()
                .any(|previous: &Anchor| previous.from == anchor.from && previous.to == anchor.to)
            {
                return Err(Error::new(
                    "highlight",
                    "A batch cannot mark the same occurrence twice.",
                ));
            }
            anchors.push(anchor);
        }
        let color_id = if let Some(color_id) = marking.color_id {
            let rule = review.rule(&color_id)?;
            if rule.action != Action::Neutral
                || !rule.prompt.is_empty()
                || rule.access_mode != crate::document::AccessMode::Suggestions
            {
                return Err(Error::new(
                    "highlight",
                    "AI highlighting can reuse only a still-neutral color identity.",
                ));
            }
            color_id
        } else {
            if review.rules.len() >= 24 {
                return Err(Error::new(
                    "limit",
                    "All color slots are in use. Choose a neutral color or free a slot locally.",
                ));
            }
            let colors = [
                "#70a9d8", "#e99863", "#ad90d8", "#71bfce", "#d68ead", "#9fb653", "#7a91d0",
                "#d59bba", "#a0c5cc", "#deb56e", "#b39b73", "#96a7c2", "#ca9b90", "#a2bc9d",
                "#b5a1c8", "#8bb8b4", "#c7a359", "#c1a1a1", "#99ad79", "#c6a6cf", "#a3bcc8",
                "#ceaa7d", "#ada9d1", "#acbba7",
            ];
            let color = colors
                .iter()
                .find(|color| {
                    review
                        .rules
                        .iter()
                        .all(|rule| distinguishable(&rule.color, color))
                })
                .ok_or_else(|| {
                    Error::new(
                        "limit",
                        "No distinguishable unused neutral highlight color is available.",
                    )
                })?;
            let color_id = Uuid::new_v4().to_string();
            review.rules.push(Rule {
                id: color_id.clone(),
                label: format!("Unassigned color {}", review.rules.len() + 1),
                color: (*color).into(),
                action: Action::Neutral,
                prompt: String::new(),
                access_mode: crate::document::AccessMode::Suggestions,
            });
            color_id
        };
        let mut markers = Vec::new();
        for anchor in anchors {
            let marker = Marker {
                id: Uuid::new_v4().to_string(),
                anchor,
                rule: color_id.clone(),
                prompt: String::new(),
            };
            review.markers.push(marker.clone());
            markers.push(marker);
        }
        editor.check_remote_edit(binding, &marking.revision)?;
        self.require_review_context(&id, binding, Some(&marking.context_id), editor)?;
        self.reserve_highlighting(&id, &marking.request_id, &fingerprint)?;
        self.persist_observed(binding, &file, &document, text, &review, None)?;
        #[cfg(test)]
        if let Some(hook) = lock(&self.highlight_after_commit)?.take() {
            hook()?;
        }
        let result = json!({"colorId":color_id,"color":review.rule(&color_id)?.color,"markers":markers,"manuscriptChanged":false,"revision":review.revision});
        self.record_highlighting(
            &id,
            binding,
            &marking.request_id,
            fingerprint,
            result.clone(),
            editor,
        )?;
        Ok(result)
    }
}

#[cfg(test)]
mod tests;
