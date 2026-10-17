use super::*;
use crate::document::{is_html_text, is_typst_text, selected, Action, PdfAnnotation};
use cap_fs_ext::{DirExt, MetadataExt};
use cap_std::fs::Dir;

const MAX_POLICY_BYTES: usize = 64 * 1024 * 1024;

fn unresolved() -> Error {
    Error::new("pdf_policy", "The project's PDF review policy cannot be verified. Resolve incomplete, missing or invalid review data locally before submitting or accepting source suggestions.")
}

pub(super) fn redact(value: &mut Value) {
    if let Some(review) = value.get_mut("review").and_then(Value::as_object_mut) {
        review.remove("pdfAnnotations");
    }
}

pub(super) struct PdfPolicy {
    held: Arc<RootedRoot>,
    observations: Vec<(SourceGroup, ReadEntry, ReadEntry, Option<ReadEntry>)>,
    reviews: Vec<(String, Review, Option<String>)>,
}

impl PdfPolicy {
    pub(super) fn check(&self) -> Result<()> {
        self.held.check_current().map_err(|_| unresolved())?;
        for (group, review, journal, source) in &self.observations {
            group
                .verify(Member::Review, review.expectation())
                .map_err(|_| unresolved())?;
            group
                .verify(Member::Journal, journal.expectation())
                .map_err(|_| unresolved())?;
            if let Some(source) = source {
                group
                    .verify(Member::Source, source.expectation())
                    .map_err(|_| unresolved())?;
            }
        }
        Ok(())
    }
}

fn linked_source_current(
    path: &str,
    review: &Review,
    annotation: &PdfAnnotation,
    source: Option<&str>,
) -> bool {
    let Some(source) = source else {
        return false;
    };
    let Some(id) = &annotation.source_marker_id else {
        return false;
    };
    let Some(marker) = review.markers.iter().find(|marker| &marker.id == id) else {
        return false;
    };
    if marker.rule != annotation.rule
        || marker.prompt != annotation.prompt
        || marker.anchor.stale
        || review.revision != digest(source)
        || annotation.segments.len() != 1
        || marker.anchor.quote != annotation.segments[0].quote
        || selected(source, marker.anchor.from, marker.anchor.to).ok()
            != Some(marker.anchor.quote.as_str())
    {
        return false;
    }
    if path.ends_with(".typ") {
        is_typst_text(source, marker.anchor.from, marker.anchor.to)
    } else {
        is_html_text(source, marker.anchor.from, marker.anchor.to)
    }
    .unwrap_or(false)
}

struct Inventory {
    entries: usize,
    directories: usize,
    sources: BTreeSet<String>,
    native_state: Option<String>,
}

impl Inventory {
    fn walk(&mut self, root: &Dir, directory: &Dir, prefix: &str, depth: usize) -> Result<()> {
        if depth > 32 || self.directories >= 2000 {
            return Err(unresolved());
        }
        self.directories += 1;
        for entry in directory.entries().map_err(|_| unresolved())? {
            self.entries += 1;
            if self.entries > 20_000 {
                return Err(unresolved());
            }
            let entry = entry.map_err(|_| unresolved())?;
            let name = entry.file_name();
            let name = name.to_str().ok_or_else(unresolved)?;
            if matches!(name, ".git" | "node_modules" | "For-AI")
                || (cfg!(windows)
                    && (name.eq_ignore_ascii_case(".git")
                        || name.eq_ignore_ascii_case("node_modules")
                        || name.eq_ignore_ascii_case("For-AI")))
            {
                continue;
            }
            let metadata = directory.symlink_metadata(name).map_err(|_| unresolved())?;
            if !source_files::plain_metadata(&metadata) {
                return Err(unresolved());
            }
            let path = if prefix.is_empty() {
                name.to_owned()
            } else {
                format!("{prefix}/{name}")
            };
            if self.native_state.as_deref() == Some(path.as_str()) {
                continue;
            }
            if path.len() > 4096 {
                return Err(unresolved());
            }
            if metadata.is_dir() {
                let child = directory
                    .open_dir_nofollow(name)
                    .map_err(|_| unresolved())?;
                let opened = child.dir_metadata().map_err(|_| unresolved())?;
                if metadata.dev() != opened.dev() || metadata.ino() != opened.ino() {
                    return Err(unresolved());
                }
                self.walk(root, &child, &path, depth + 1)?;
            } else if metadata.is_file() {
                let source = [".undertree-review.json", ".undertree-pending.json"]
                    .iter()
                    .find_map(|suffix| {
                        let split = path.len().checked_sub(suffix.len())?;
                        let tail = path.get(split..)?;
                        (tail == *suffix || (cfg!(windows) && tail.eq_ignore_ascii_case(suffix)))
                            .then(|| &path[..split])
                    })
                    .unwrap_or(&path);
                if editable_source(Path::new(source)) {
                    if source_path::validate_source_path(source).is_err() {
                        if source != path {
                            return Err(unresolved());
                        }
                        continue;
                    }
                    self.sources.insert(source.to_owned());
                }
            }
        }
        let current = project_tree::open_directory(root, prefix)
            .map_err(|_| unresolved())?
            .dir_metadata()
            .map_err(|_| unresolved())?;
        let opened = directory.dir_metadata().map_err(|_| unresolved())?;
        if current.dev() != opened.dev() || current.ino() != opened.ino() {
            return Err(unresolved());
        }
        Ok(())
    }
}

impl Service {
    fn scan_pdf_annotations(
        &self,
        project: &Project,
        expected: Option<RootObservation>,
    ) -> Result<PdfPolicy> {
        let observation = expected.map_or_else(|| RootedRoot::observe(&project.root), Ok)?;
        let held = RootedRoot::acquire(&project.root, &observation)?;
        let directory = held.directory()?;
        let mut inventory = Inventory {
            entries: 0,
            directories: 0,
            sources: BTreeSet::new(),
            native_state: self
                .state
                .strip_prefix(&project.root)
                .ok()
                .and_then(Path::to_str)
                .map(|path| path.replace('\\', "/")),
        };
        inventory.walk(&directory, &directory, "", 0)?;
        for path in lock(&self.policy_continuity)?.known_paths() {
            if let Ok(relative) = path.strip_prefix(&project.root) {
                let relative = relative.to_str().ok_or_else(unresolved)?.replace('\\', "/");
                inventory.sources.insert(relative);
            }
        }
        if inventory.sources.len() > 20_000 {
            return Err(unresolved());
        }
        let mut result = PdfPolicy {
            held,
            observations: Vec::new(),
            reviews: Vec::new(),
        };
        let mut bytes = 0usize;
        for relative in inventory.sources {
            let group = result
                .held
                .source_group(&relative)
                .map_err(|_| unresolved())?;
            let journal = group
                .read_bytes(Member::Journal, MAX_TEXT * 9)
                .map_err(|_| unresolved())?;
            if journal.bytes().is_some() {
                return Err(unresolved());
            }
            let raw = group
                .read_utf8(Member::Review, MAX_TEXT * 8)
                .map_err(|_| unresolved())?;
            let text = raw.text().map_err(|_| unresolved())?;
            self.check_policy_continuity(&project.root.join(&relative), text)
                .map_err(|_| unresolved())?;
            let mut source_read = None;
            if let Some(text) = text {
                bytes = bytes.saturating_add(text.len());
                if bytes > MAX_POLICY_BYTES {
                    return Err(unresolved());
                }
                let review: Review = serde_json::from_str(text).map_err(|_| unresolved())?;
                review.validate().map_err(|_| unresolved())?;
                let source = if review
                    .pdf_annotations
                    .iter()
                    .any(|annotation| annotation.source_marker_id.is_some())
                {
                    let entry = group
                        .read_utf8(Member::Source, MAX_TEXT)
                        .map_err(|_| unresolved())?;
                    let content = entry.text().map_err(|_| unresolved())?.map(str::to_owned);
                    bytes = bytes.saturating_add(content.as_ref().map_or(0, String::len));
                    if bytes > MAX_POLICY_BYTES {
                        return Err(unresolved());
                    }
                    source_read = Some(entry);
                    content
                } else {
                    None
                };
                self.observe_policy(&project.root.join(&relative), Some(text))
                    .map_err(|_| unresolved())?;
                result.reviews.push((relative, review, source));
            }
            result.observations.push((group, raw, journal, source_read));
        }
        result.check()?;
        Ok(result)
    }

    pub(super) fn pdf_annotation_policy(
        &self,
        project: &Project,
        expected: Option<RootObservation>,
    ) -> Result<PdfPolicy> {
        let policy = self.scan_pdf_annotations(project, expected)?;
        for (owner, review, source) in &policy.reviews {
            for annotation in &review.pdf_annotations {
                if !matches!(
                    review.rule(&annotation.rule)?.action,
                    Action::Prompt | Action::Neutral
                ) && !linked_source_current(owner, review, annotation, source.as_deref())
                {
                    return Err(Error::new("protected_pdf", "An unlinked PDF annotation protects this project. Remove or resolve it locally before submitting or accepting source suggestions."));
                }
            }
        }
        Ok(policy)
    }

    pub(super) fn mark_pdf_annotation(
        &self,
        binding: SourceBinding<'_>,
        revision: &str,
        mut annotation: PdfAnnotation,
        source_range: (Option<usize>, Option<usize>),
    ) -> Result<Value> {
        annotation.validate()?;
        let project = self.project(binding.project)?;
        let path = self.path(&project, binding.path, false)?;
        let document = self.held_document(binding, &path, false)?;
        let text = document.content.clone();
        let mut review = document.review.clone();
        review.check_revision(revision, &text)?;
        review.rule(&annotation.rule)?;
        if review.pdf_annotations.len() >= MAX_ITEMS {
            return Err(Error::new(
                "limit",
                "At most 500 PDF annotations are supported per review file.",
            ));
        }
        let pdf = self.preview_pdf(binding.project, &annotation.pdf_path)?;
        if pdf["available"] != true
            || pdf["pdfHash"].as_str() != Some(annotation.identity.as_str())
            || pdf["expectedRoot"] != json!(document.group.observation())
        {
            return Err(Error::new("stale_pdf", "The displayed PDF artifact changed. Select the passage again in its current preview."));
        }
        let epoch = pdf["sourceEpoch"].as_u64().ok_or_else(|| {
            Error::new(
                "stale_pdf",
                "The PDF source identity is unavailable. Compile again.",
            )
        })?;
        self.require_source_epoch(binding.project, &annotation.pdf_path, epoch)?;
        match source_range {
            (None, None) => (),
            (Some(from), Some(to)) => {
                let anchor = Anchor::new(&text, from, to)?;
                if annotation.segments.len() != 1
                    || anchor.quote != annotation.segments[0].quote
                    || text.find(&anchor.quote) != text.rfind(&anchor.quote)
                {
                    return Err(Error::new("source_link", "The PDF passage does not identify one exact passage in this saved source. Keep it as an unlinked PDF annotation."));
                }
                let prose = if binding.path.ends_with(".typ") {
                    is_typst_text(&text, from, to)
                } else {
                    is_html_text(&text, from, to)
                }?;
                if prose {
                    if review.markers.len() >= MAX_ITEMS {
                        return Err(Error::new(
                            "limit",
                            "At most 500 source highlights are supported.",
                        ));
                    }
                    let marker = Marker {
                        id: Uuid::new_v4().to_string(),
                        anchor,
                        rule: annotation.rule.clone(),
                        prompt: annotation.prompt.clone(),
                    };
                    annotation.source_marker_id = Some(marker.id.clone());
                    review.markers.push(marker);
                }
            }
            _ => {
                return Err(Error::new(
                    "source_link",
                    "Supply both saved-source offsets, or leave this PDF annotation unlinked.",
                ))
            }
        }
        review.pdf_annotations.push(annotation);
        self.persist_observed(binding, &path, &document, &text, &review, None)?;
        self.snapshot_binding(binding, &path, false)
    }

    pub(super) fn unmark_pdf_annotation(
        &self,
        binding: SourceBinding<'_>,
        revision: &str,
        id: &str,
    ) -> Result<Value> {
        let project = self.project(binding.project)?;
        let path = self.path(&project, binding.path, false)?;
        let document = self.held_document(binding, &path, false)?;
        let text = document.content.clone();
        let mut review = document.review.clone();
        review.check_revision(revision, &text)?;
        if !review
            .pdf_annotations
            .iter()
            .any(|annotation| annotation.id == id)
        {
            return Err(Error::new(
                "missing",
                "This PDF annotation no longer exists.",
            ));
        }
        let linked = review
            .pdf_annotations
            .iter()
            .find(|annotation| annotation.id == id)
            .and_then(|annotation| annotation.source_marker_id.clone());
        review
            .pdf_annotations
            .retain(|annotation| annotation.id != id);
        if let Some(linked) = linked {
            review.markers.retain(|marker| marker.id != linked);
        }
        self.persist_observed(binding, &path, &document, &text, &review, None)?;
        self.snapshot_binding(binding, &path, false)
    }

    pub(super) fn local_pdf_annotations(
        &self,
        project: &str,
        pdf_path: &str,
        identity: &str,
        expected: Option<RootObservation>,
    ) -> Result<Value> {
        if identity.len() != 64 || !identity.bytes().all(|value| value.is_ascii_hexdigit()) {
            return Err(Error::new(
                "format",
                "Use the displayed PDF's SHA-256 identity.",
            ));
        }
        let approved = self.project(project)?;
        self.path(&approved, pdf_path, false)?;
        let scan = self.scan_pdf_annotations(&approved, expected)?;
        let mut annotations = Vec::new();
        for (owner, review, source) in &scan.reviews {
            for annotation in &review.pdf_annotations {
                if annotation.pdf_path != pdf_path || annotation.identity != identity {
                    continue;
                }
                let rule = review.rule(&annotation.rule)?;
                let mut value = json!(annotation);
                value["ownerPath"] = json!(owner);
                value["ownerSourceEpoch"] = json!(self.source_epoch(project, owner)?);
                value["color"] = json!(rule.color);
                value["label"] = json!(rule.label);
                value["action"] = json!(rule.action);
                value["sourceLinked"] = json!(linked_source_current(
                    owner,
                    review,
                    annotation,
                    source.as_deref()
                ));
                annotations.push(value);
                if annotations.len() > 500 {
                    return Err(Error::new(
                        "limit",
                        "The PDF has more than 500 annotations. Manage its review files locally.",
                    ));
                }
            }
        }
        let value = json!({"identity":identity,"pdfPath":pdf_path,"annotations":annotations});
        if serde_json::to_vec(&value)?.len() > MAX_TEXT * 8 {
            return Err(Error::new("limit", "PDF annotation context exceeds 16 MB."));
        }
        scan.check()?;
        Ok(value)
    }
}

#[cfg(test)]
mod tests;
