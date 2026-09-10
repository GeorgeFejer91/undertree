use std::cmp::Reverse;
use std::collections::HashSet;
use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Write};
use std::panic::{self, AssertUnwindSafe};
use std::path::{Component, Path, PathBuf};

use serde::Serialize;
use tempfile::{Builder as TempBuilder, NamedTempFile};
use tylax::{
    L2TOptions, T2LOptions, latex_to_typst_with_diagnostics_options,
    typst_to_latex_with_diagnostics,
};
use zip::ZipArchive;

use crate::compiler::{CompileRequest, CompilerAssets};
use crate::error::BoundaryError;

const ENGINE: &str = "Tylax 0.3.7";
const MAX_ARCHIVE_BYTES: u64 = 512 * 1024 * 1024;
const MAX_ARCHIVE_ENTRIES: usize = 20_000;
const MAX_ARCHIVE_FILE_BYTES: u64 = 128 * 1024 * 1024;
const MAX_ARCHIVE_EXPANDED_BYTES: u64 = 1024 * 1024 * 1024;
const MAX_PROJECT_ENTRIES: usize = 50_000;
const MAX_TEX_FILES: usize = 512;
const MAX_TEX_SOURCE_BYTES: u64 = 1024 * 1024;
const MAX_EXPANDED_TEX_BYTES: usize = 1024 * 1024;
const MAX_SHIELDED_TEX_BYTES: usize = 8 * 1024 * 1024;
const MAX_SCAN_DEPTH: usize = 32;
const MAX_INCLUDE_DEPTH: usize = 24;
const MAX_REPORTED_WARNINGS: usize = 200;
const MAX_REPORTED_SKIPS: usize = 200;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversionReport {
    pub engine: &'static str,
    pub source: String,
    pub project_root: String,
    pub converted: Vec<ConvertedFile>,
    pub skipped: Vec<SkippedFile>,
    pub warnings: Vec<ConversionWarning>,
    pub warning_count: usize,
    pub preserved_entries: usize,
    pub primary_typst: Option<String>,
    pub needs_review: bool,
    pub compile_succeeded: Option<bool>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConvertedFile {
    pub latex: String,
    pub typst: String,
    pub expanded_includes: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkippedFile {
    pub latex: String,
    pub reason: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversionWarning {
    pub source: String,
    pub kind: String,
    pub message: String,
    pub location: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TypstToLatexReport {
    pub engine: &'static str,
    pub source: String,
    pub latex: String,
    pub warnings: Vec<ConversionWarning>,
    pub warning_count: usize,
    pub source_compiled: bool,
    pub original_preserved: bool,
    pub needs_review: bool,
}

impl ConversionReport {
    fn new(source: String, root: &Path, preserved_entries: usize) -> Self {
        Self {
            engine: ENGINE,
            source,
            project_root: root.to_string_lossy().into_owned(),
            converted: Vec::new(),
            skipped: Vec::new(),
            warnings: Vec::new(),
            warning_count: 0,
            preserved_entries,
            primary_typst: None,
            needs_review: false,
            compile_succeeded: None,
        }
    }

    pub(crate) fn warn(
        &mut self,
        source: &str,
        kind: impl Into<String>,
        message: impl Into<String>,
        location: Option<String>,
    ) {
        self.warning_count = self.warning_count.saturating_add(1);
        if self.warnings.len() < MAX_REPORTED_WARNINGS {
            self.warnings.push(ConversionWarning {
                source: source.to_owned(),
                kind: kind.into(),
                message: message.into(),
                location,
            });
        }
        self.needs_review = true;
    }

    fn skip(&mut self, latex: String, reason: impl Into<String>) {
        if self.skipped.len() < MAX_REPORTED_SKIPS {
            self.skipped.push(SkippedFile {
                latex,
                reason: reason.into(),
            });
        }
    }
}

/// Converts high-confidence LaTeX document roots below an already approved folder.
/// Existing files are never overwritten, and archive assets are never removed.
pub fn convert_project_if_needed(root: &Path) -> Result<Option<ConversionReport>, BoundaryError> {
    let root = canonical_directory(root)?;
    let candidates = discover_tex_files(&root)?;
    if candidates.is_empty() {
        return Ok(None);
    }

    let (roots, incompatible_sources) = choose_document_roots(&root, &candidates)?;
    if roots.is_empty() && incompatible_sources.is_empty() {
        return Ok(None);
    }

    let source = root
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("LaTeX project")
        .to_owned();
    let mut report = ConversionReport::new(source, &root, candidates.len());
    for path in incompatible_sources {
        let relative = normalized_relative(&root, &path)?;
        report.warn(
            &relative,
            "source-encoding",
            "This legacy LaTeX source is not UTF-8 and was skipped; the original file remains unchanged.",
            None,
        );
        report.skip(
            relative,
            "The legacy LaTeX source is not UTF-8; its original bytes were preserved.",
        );
    }
    convert_roots(&root, roots, &mut report)?;

    if report.converted.is_empty() && report.warning_count == 0 && report.skipped.is_empty() {
        Ok(None)
    } else {
        Ok(Some(report))
    }
}

pub(crate) fn validate_generated_typst_drafts(
    root: &Path,
    report: &mut ConversionReport,
    compiler: &CompilerAssets,
) {
    let mut validation_paths = report
        .converted
        .iter()
        .map(|converted| converted.typst.clone())
        .collect::<Vec<_>>();
    if validation_paths.is_empty() {
        validation_paths.extend(report.primary_typst.iter().cloned());
    }
    validation_paths.sort_unstable();
    validation_paths.dedup();

    let mut all_compiled = !validation_paths.is_empty();
    for relative in validation_paths {
        let generated = match read_generated_typst_for_validation(root, &relative) {
            Ok(generated) => generated,
            Err(_) => {
                all_compiled = false;
                report.warn(
                    &relative,
                    "typst-compile",
                    "The generated Typst draft could not be read for validation.",
                    None,
                );
                continue;
            }
        };
        match compiler.compile(
            CompileRequest {
                source: generated,
                path: Some(relative.clone()),
                revision: 0,
            },
            Some(root.to_path_buf()),
        ) {
            Ok(result) => {
                for diagnostic in result.warnings {
                    report.warn(
                        &relative,
                        "typst-warning",
                        diagnostic.message,
                        diagnostic.hints.first().cloned(),
                    );
                }
            }
            Err(error) => {
                all_compiled = false;
                if error.diagnostics.is_empty() {
                    report.warn(&relative, "typst-compile", error.message, None);
                } else {
                    for diagnostic in error.diagnostics {
                        report.warn(
                            &relative,
                            "typst-compile",
                            diagnostic.message,
                            diagnostic.hints.first().cloned(),
                        );
                    }
                }
            }
        }
    }
    if !report.converted.is_empty() || report.primary_typst.is_some() {
        report.compile_succeeded = Some(all_compiled);
    }
}

fn read_generated_typst_for_validation(
    root: &Path,
    relative: &str,
) -> Result<String, BoundaryError> {
    let root = canonical_directory(root)?;
    let relative_path = Path::new(relative);
    if relative_path.is_absolute()
        || relative_path
            .components()
            .any(|component| !matches!(component, Component::Normal(_)))
        || !has_extension(relative_path, "typ")
    {
        return Err(BoundaryError::project(
            "path_denied",
            "Generated Typst validation is confined to the selected project.",
        ));
    }

    let mut candidate = root.clone();
    for component in relative_path.components() {
        let Component::Normal(name) = component else {
            return Err(BoundaryError::project(
                "path_denied",
                "Generated Typst validation is confined to the selected project.",
            ));
        };
        candidate.push(name);
        let metadata = fs::symlink_metadata(&candidate).map_err(|_| {
            BoundaryError::project(
                "document_unavailable",
                "The generated Typst draft is unavailable.",
            )
        })?;
        if metadata.file_type().is_symlink() {
            return Err(BoundaryError::project(
                "path_denied",
                "Symlinked Typst drafts cannot be validated.",
            ));
        }
    }

    let canonical = candidate.canonicalize().map_err(|_| {
        BoundaryError::project(
            "document_unavailable",
            "The generated Typst draft is unavailable.",
        )
    })?;
    if !canonical.starts_with(&root) || !canonical.is_file() {
        return Err(BoundaryError::project(
            "path_denied",
            "Generated Typst validation is confined to the selected project.",
        ));
    }
    let metadata = canonical
        .metadata()
        .map_err(|_| BoundaryError::internal())?;
    if metadata.len() > MAX_TEX_SOURCE_BYTES {
        return Err(BoundaryError::project(
            "document_too_large",
            "Generated Typst validation is limited to 1 MiB per document.",
        ));
    }
    fs::read_to_string(canonical).map_err(|_| {
        BoundaryError::project(
            "document_encoding",
            "Generated Typst drafts must use UTF-8.",
        )
    })
}

/// Imports one selected `.tex` file in place, preserving it byte-for-byte.
pub fn import_tex_file(
    path: &Path,
    approved_project_root: Option<&Path>,
) -> Result<(PathBuf, ConversionReport), BoundaryError> {
    let source = path.canonicalize().map_err(|_| {
        BoundaryError::project(
            "latex_unavailable",
            "The selected LaTeX file is unavailable.",
        )
    })?;
    if !source.is_file() || !has_extension(&source, "tex") {
        return Err(BoundaryError::project(
            "latex_invalid_source",
            "Choose a .tex document or an Overleaf .zip archive.",
        ));
    }
    let parent = canonical_directory(source.parent().ok_or_else(BoundaryError::internal)?)?;
    let root = match approved_project_root {
        Some(root) => {
            let root = canonical_directory(root)?;
            if source.starts_with(&root) {
                root
            } else {
                parent
            }
        }
        None => parent,
    };
    if !source.starts_with(&root) {
        return Err(BoundaryError::project(
            "path_denied",
            "The selected LaTeX document must remain inside its project folder.",
        ));
    }

    let relative = normalized_relative(&root, &source)?;
    let mut report = ConversionReport::new(relative.clone(), &root, 1);
    convert_roots(&root, vec![source], &mut report)?;
    Ok((root, report))
}

/// Converts one project-relative `.tex` source without the external-file
/// fallback used by the desktop file picker. Every path component must be a
/// real entry inside the approved project; symlinks and private/generated
/// metadata paths are rejected.
pub(crate) fn import_project_tex_file(
    root: &Path,
    relative: &str,
) -> Result<ConversionReport, BoundaryError> {
    let root = canonical_directory(root)?;
    let relative_path = Path::new(relative);
    if relative_path.is_absolute()
        || relative_path
            .components()
            .any(|component| !matches!(component, Component::Normal(_)))
        || !has_extension(relative_path, "tex")
        || is_undertree_latex_export(relative_path)
    {
        return Err(BoundaryError::project(
            "path_denied",
            "Choose a relative, original .tex source inside the selected project.",
        ));
    }

    let mut candidate = root.clone();
    for component in relative_path.components() {
        let Component::Normal(name) = component else {
            return Err(BoundaryError::project(
                "path_denied",
                "The LaTeX source must remain inside the selected project.",
            ));
        };
        if should_skip_directory(name) {
            return Err(BoundaryError::project(
                "path_denied",
                "Private metadata and build folders cannot be conversion sources.",
            ));
        }
        candidate.push(name);
        let metadata = fs::symlink_metadata(&candidate).map_err(|_| {
            BoundaryError::project(
                "latex_unavailable",
                "The selected LaTeX file is unavailable.",
            )
        })?;
        if metadata.file_type().is_symlink() {
            return Err(BoundaryError::project(
                "path_denied",
                "Symlinked LaTeX sources are not allowed.",
            ));
        }
    }

    let source = candidate.canonicalize().map_err(|_| {
        BoundaryError::project(
            "latex_unavailable",
            "The selected LaTeX file is unavailable.",
        )
    })?;
    if !source.starts_with(&root) || !source.is_file() || !has_extension(&source, "tex") {
        return Err(BoundaryError::project(
            "path_denied",
            "The LaTeX source must remain inside the selected project.",
        ));
    }

    let normalized = normalized_relative(&root, &source)?;
    let mut report = ConversionReport::new(normalized, &root, 1);
    convert_roots(&root, vec![source], &mut report)?;
    Ok(report)
}

/// Converts one already validated Typst document to a new, editable LaTeX
/// sibling. The Typst source and every existing LaTeX file remain untouched.
pub(crate) fn export_typst_document(
    root: &Path,
    relative: &str,
    source: &str,
) -> Result<TypstToLatexReport, BoundaryError> {
    let root = canonical_directory(root)?;
    if source.len() as u64 > MAX_TEX_SOURCE_BYTES {
        return Err(BoundaryError::project(
            "document_too_large",
            "Typst-to-LaTeX conversion is limited to 1 MiB per document.",
        ));
    }

    let relative_path = Path::new(relative);
    if relative_path.is_absolute()
        || relative_path
            .components()
            .any(|component| !matches!(component, Component::Normal(_)))
        || !has_extension(relative_path, "typ")
    {
        return Err(BoundaryError::project(
            "path_denied",
            "Only a relative .typ document inside the selected project can be exported.",
        ));
    }

    let parent_relative = relative_path.parent().unwrap_or_else(|| Path::new(""));
    let parent = root.join(parent_relative).canonicalize().map_err(|_| {
        BoundaryError::project(
            "folder_unavailable",
            "The Typst document folder is unavailable.",
        )
    })?;
    if !parent.starts_with(&root) || !parent.is_dir() {
        return Err(BoundaryError::project(
            "path_denied",
            "The LaTeX export must remain inside the selected project.",
        ));
    }

    let stem = relative_path
        .file_stem()
        .and_then(|stem| stem.to_str())
        .ok_or_else(|| {
            BoundaryError::project(
                "unsupported_path",
                "The Typst file name must use Unicode characters.",
            )
        })?;
    let mut output_path = None;
    for version in 1..=999usize {
        let name = if version == 1 {
            format!("{stem}.undertree-export.tex")
        } else {
            format!("{stem}.undertree-export-{version}.tex")
        };
        let candidate = parent.join(name);
        if !candidate.exists() {
            output_path = Some(candidate);
            break;
        }
    }
    let output_path = output_path.ok_or_else(|| {
        BoundaryError::project(
            "too_many_exports",
            "This document already has 999 preserved LaTeX export drafts.",
        )
    })?;
    let output_relative = normalized_relative(&root, &output_path)?;

    let options = T2LOptions::full_document();
    let conversion = panic::catch_unwind(AssertUnwindSafe(|| {
        typst_to_latex_with_diagnostics(source, &options)
    }))
    .map_err(|_| {
        BoundaryError::project(
            "typst_latex_converter_failed",
            "The Typst-to-LaTeX converter failed safely; the Typst original was preserved.",
        )
    })?;

    let mut warning_count = conversion.warnings.len();
    let mut warnings = conversion
        .warnings
        .into_iter()
        .take(MAX_REPORTED_WARNINGS)
        .map(|warning| ConversionWarning {
            source: relative.replace('\\', "/"),
            kind: warning.kind.to_string(),
            message: warning.message,
            location: warning
                .span
                .map(|span| format!("bytes {}..{}", span.start, span.end)),
        })
        .collect::<Vec<_>>();
    let mut warn = |kind: &str, message: &str| {
        warning_count = warning_count.saturating_add(1);
        if warnings.len() < MAX_REPORTED_WARNINGS {
            warnings.push(ConversionWarning {
                source: relative.replace('\\', "/"),
                kind: kind.to_owned(),
                message: message.to_owned(),
                location: None,
            });
        }
    };
    if source.contains("#import") || source.contains("#include") {
        warn(
            "typst-import-review",
            "Typst imports/includes can contain document logic that a standalone LaTeX export cannot reproduce automatically; compare the expanded content.",
        );
    }
    if source.contains("#show") || source.contains("#set") {
        warn(
            "typst-style-review",
            "Typst show/set rules do not map one-to-one to LaTeX; apply the target journal class and inspect typography and layout.",
        );
    }
    if source.contains("#bibliography") || source.contains("@") {
        warn(
            "bibliography-review",
            "Verify every citation, bibliography database path, and the journal's required BibTeX or biblatex style in the exported LaTeX project.",
        );
    }
    warn(
        "journal-template-review",
        "This is a complete article-class LaTeX draft, not a claim of journal readiness. Apply the journal's official class/template and compile it with the journal's required TeX toolchain before submission.",
    );

    let mut output = conversion.output;
    let layout_repairs = restore_basic_latex_layout_from_typst(&mut output, source);
    if layout_repairs > 0 {
        warn(
            "typst-layout-restored",
            "UnderTree restored simple Typst font-size, heading-numbering, page-numbering, or table-flow defaults in the LaTeX draft; verify them against the Typst rendering.",
        );
    }
    if !output.contains("\\documentclass")
        || !output.contains("\\begin{document}")
        || !output.contains("\\end{document}")
    {
        return Err(BoundaryError::project(
            "typst_latex_incomplete",
            "The converter did not produce a complete LaTeX document; no export was written.",
        ));
    }
    let header = format!(
        "% UnderTree Typst-to-LaTeX conversion draft — review before submission.\n% Original Typst preserved at: {}\n% Converted locally with {ENGINE}; no external process or network service was used.\n\n",
        relative.replace('\\', "/")
    );
    output.insert_str(0, &header);
    if output.len() > MAX_TEX_SOURCE_BYTES as usize {
        return Err(BoundaryError::project(
            "converted_document_too_large",
            "The generated LaTeX draft exceeds the 1 MiB editor limit.",
        ));
    }
    atomic_create_new(&output_path, output.as_bytes())?;

    Ok(TypstToLatexReport {
        engine: ENGINE,
        source: relative.replace('\\', "/"),
        latex: output_relative,
        warnings,
        warning_count,
        source_compiled: true,
        original_preserved: true,
        needs_review: true,
    })
}

fn restore_basic_latex_layout_from_typst(output: &mut String, source: &str) -> usize {
    let mut repaired = 0usize;
    let font_size = simple_typst_text_size(source).unwrap_or(11);
    let class = "\\documentclass{article}";
    if output.contains(class) {
        *output = output.replacen(
            class,
            &format!("\\documentclass[{font_size}pt]{{article}}"),
            1,
        );
        repaired = repaired.saturating_add(1);
    }

    let class_end = format!("\\documentclass[{font_size}pt]{{article}}\n");
    if output.contains(&class_end) {
        let mut defaults = String::new();
        if !source.contains("heading(numbering:")
            && !source.contains("heading(numbering :")
            && !output.contains("\\setcounter{secnumdepth}")
        {
            defaults.push_str("\\setcounter{secnumdepth}{0}\n");
            repaired = repaired.saturating_add(1);
        }
        if !source.contains("page(numbering:")
            && !source.contains("page(numbering :")
            && !output.contains("\\pagestyle")
        {
            defaults.push_str("\\pagestyle{empty}\n");
            repaired = repaired.saturating_add(1);
        }
        if !source.contains("first-line-indent") && !output.contains("\\setlength{\\parindent}") {
            defaults.push_str("\\setlength{\\parindent}{0pt}\n");
            repaired = repaired.saturating_add(1);
        }
        if !defaults.is_empty() {
            *output = output.replacen(&class_end, &(class_end.clone() + &defaults), 1);
        }
    }

    let table_end = "\\end{tabular}\n\n";
    let table_count = output.matches(table_end).count();
    if table_count > 0 {
        *output = output.replace(table_end, "\\end{tabular}\n\\par\\medskip\n\n");
        repaired = repaired.saturating_add(table_count);
    }
    repaired
}

fn simple_typst_text_size(source: &str) -> Option<u8> {
    for marker in ["#set text(", "#set text ("] {
        let Some(start) = source.find(marker) else {
            continue;
        };
        let rest = &source[start + marker.len()..];
        let arguments = rest
            .split_once(')')
            .map_or(rest, |(arguments, _)| arguments);
        let Some((_, value)) = arguments.split_once("size:") else {
            continue;
        };
        let digits = value
            .trim_start()
            .chars()
            .take_while(|character| character.is_ascii_digit())
            .collect::<String>();
        let Ok(size) = digits.parse::<u8>() else {
            continue;
        };
        if (8..=12).contains(&size) && value.trim_start()[digits.len()..].starts_with("pt") {
            return Some(size);
        }
    }
    None
}

/// Extracts an Overleaf ZIP to a new sibling project folder, then adds Typst drafts.
pub fn import_overleaf_zip(
    archive_path: &Path,
    destination_parent: &Path,
) -> Result<(PathBuf, ConversionReport), BoundaryError> {
    let archive_path = archive_path.canonicalize().map_err(|_| {
        BoundaryError::project(
            "archive_unavailable",
            "The selected archive is unavailable.",
        )
    })?;
    if !archive_path.is_file() || !has_extension(&archive_path, "zip") {
        return Err(BoundaryError::project(
            "archive_invalid",
            "Choose an Overleaf ZIP archive.",
        ));
    }
    if archive_path
        .metadata()
        .map_err(|_| BoundaryError::internal())?
        .len()
        > MAX_ARCHIVE_BYTES
    {
        return Err(BoundaryError::project(
            "archive_too_large",
            "Overleaf archives are limited to 512 MiB.",
        ));
    }

    let parent = canonical_directory(destination_parent)?;
    let stem = archive_path
        .file_stem()
        .and_then(|stem| stem.to_str())
        .map(sanitize_project_name)
        .filter(|stem| !stem.is_empty())
        .unwrap_or_else(|| "overleaf-project".to_owned());
    let target = available_project_target(&parent, &stem)?;
    let staging = TempBuilder::new()
        .prefix(".undertree-overleaf-")
        .tempdir_in(&parent)
        .map_err(|_| {
            BoundaryError::project(
                "archive_extract_failed",
                "UnderTree could not reserve a safe archive staging folder.",
            )
        })?;
    let staging_root = staging
        .path()
        .canonicalize()
        .map_err(|_| BoundaryError::internal())?;
    if !staging_root.starts_with(&parent) {
        return Err(BoundaryError::project(
            "path_denied",
            "The archive staging folder moved outside the selected destination.",
        ));
    }

    let preserved_entries = extract_archive(&archive_path, &staging_root)?;
    let project_root = collapse_single_archive_root(&staging_root)?;
    let converted = convert_project_if_needed(&project_root)?;
    let source_name = archive_path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("Overleaf archive")
        .to_owned();

    fs::rename(&project_root, &target).map_err(|_| {
        BoundaryError::project(
            "archive_promote_failed",
            "The extracted project could not be moved into its final folder without overwriting data.",
        )
    })?;
    let target = target.canonicalize().map_err(|_| {
        BoundaryError::project(
            "archive_promote_failed",
            "The imported project folder could not be validated after extraction.",
        )
    })?;

    let mut report = converted
        .unwrap_or_else(|| ConversionReport::new(source_name.clone(), &target, preserved_entries));
    report.source = source_name;
    report.project_root = target.to_string_lossy().into_owned();
    report.preserved_entries = preserved_entries;
    Ok((target, report))
}

fn canonical_directory(path: &Path) -> Result<PathBuf, BoundaryError> {
    let path = path.canonicalize().map_err(|_| {
        BoundaryError::project("project_unavailable", "The selected folder is unavailable.")
    })?;
    if !path.is_dir() {
        return Err(BoundaryError::project(
            "project_unavailable",
            "The selected path is not a folder.",
        ));
    }
    Ok(path)
}

fn discover_tex_files(root: &Path) -> Result<Vec<PathBuf>, BoundaryError> {
    let mut files = Vec::new();
    let mut pending = vec![(root.to_path_buf(), 0usize)];
    let mut visited = 0usize;

    while let Some((directory, depth)) = pending.pop() {
        if depth > MAX_SCAN_DEPTH {
            continue;
        }
        let mut entries = fs::read_dir(&directory)
            .map_err(|_| {
                BoundaryError::project(
                    "project_unavailable",
                    "The LaTeX project folder could not be scanned.",
                )
            })?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|_| BoundaryError::internal())?;
        entries.sort_by_key(|entry| entry.file_name().to_string_lossy().to_lowercase());

        for entry in entries.into_iter().rev() {
            visited = visited.saturating_add(1);
            if visited > MAX_PROJECT_ENTRIES {
                return Err(BoundaryError::project(
                    "latex_project_too_large",
                    "Automatic LaTeX discovery is limited to 50,000 project entries. Import a specific .tex file or a smaller project folder.",
                ));
            }
            let file_type = entry.file_type().map_err(|_| BoundaryError::internal())?;
            if file_type.is_symlink() {
                continue;
            }
            if file_type.is_dir() {
                if should_skip_directory(&entry.file_name()) {
                    continue;
                }
                pending.push((entry.path(), depth + 1));
            } else if file_type.is_file()
                && has_extension(&entry.path(), "tex")
                && !is_undertree_latex_export(&entry.path())
            {
                if files.len() >= MAX_TEX_FILES {
                    return Err(BoundaryError::project(
                        "too_many_latex_documents",
                        "Automatic conversion is limited to 512 LaTeX files. Import a specific .tex document or a smaller project folder.",
                    ));
                }
                files.push(entry.path());
            }
        }
    }

    files.sort_by_key(|path| {
        path.strip_prefix(root)
            .unwrap_or(path)
            .to_string_lossy()
            .to_lowercase()
    });
    Ok(files)
}

pub(crate) fn is_undertree_latex_export(path: &Path) -> bool {
    path.file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| {
            let name = name.to_ascii_lowercase();
            name.ends_with(".tex") && name.contains(".undertree-export")
        })
}

fn choose_document_roots(
    root: &Path,
    candidates: &[PathBuf],
) -> Result<(Vec<PathBuf>, Vec<PathBuf>), BoundaryError> {
    let mut roots = Vec::new();
    let mut directed_roots = Vec::new();
    let mut compatible_candidates = Vec::new();
    let mut incompatible_sources = Vec::new();
    for candidate in candidates {
        let metadata = candidate
            .metadata()
            .map_err(|_| BoundaryError::internal())?;
        if metadata.len() > MAX_TEX_SOURCE_BYTES {
            continue;
        }
        let source = match fs::read_to_string(candidate) {
            Ok(source) => source,
            Err(error) if error.kind() == io::ErrorKind::InvalidData => {
                incompatible_sources.push(candidate.clone());
                continue;
            }
            Err(_) => return Err(BoundaryError::internal()),
        };
        compatible_candidates.push(candidate.clone());
        if source.contains("\\documentclass") && source.contains("\\begin{document}") {
            roots.push(candidate.clone());
        }
        if let Some(target) = tex_root_directive(&source)
            && let Some(parent) = candidate.parent()
            && let Some(path) = resolve_include(parent, root, &target)?
            && !directed_roots.contains(&path)
        {
            directed_roots.push(path);
        }
    }
    for directed in directed_roots {
        if !roots.contains(&directed) {
            roots.push(directed);
        }
    }
    if roots.is_empty() && compatible_candidates.len() == 1 {
        roots.push(compatible_candidates[0].clone());
    }
    let recent = recent_commit_tex_paths(root);
    roots.sort_by_key(|path| document_root_score(root, path, &recent));
    Ok((roots, incompatible_sources))
}

fn document_root_score(
    root: &Path,
    path: &Path,
    recent: &HashSet<String>,
) -> (u8, u8, Reverse<u16>, usize, String) {
    let relative = path.strip_prefix(root).unwrap_or(path);
    let normalized = relative.to_string_lossy().replace('\\', "/");
    let is_main = !path
        .file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| name.eq_ignore_ascii_case("main.tex"));
    let is_recent = !recent.contains(&normalized.to_lowercase());
    let year = relative
        .components()
        .filter_map(|component| component.as_os_str().to_str())
        .filter_map(|component| component.parse::<u16>().ok())
        .filter(|year| (1900..=2200).contains(year))
        .max()
        .unwrap_or(0);
    (
        u8::from(is_main),
        u8::from(is_recent),
        Reverse(year),
        relative.components().count(),
        normalized.to_lowercase(),
    )
}

fn recent_commit_tex_paths(root: &Path) -> HashSet<String> {
    let mut paths = HashSet::new();
    let Ok(repository) = git2::Repository::open(root) else {
        return paths;
    };
    let Ok(head) = repository.head().and_then(|head| head.peel_to_commit()) else {
        return paths;
    };
    let Ok(tree) = head.tree() else {
        return paths;
    };
    let parent_tree = head.parent(0).ok().and_then(|parent| parent.tree().ok());
    let Ok(diff) = repository.diff_tree_to_tree(parent_tree.as_ref(), Some(&tree), None) else {
        return paths;
    };
    for delta in diff.deltas().take(MAX_TEX_FILES) {
        let Some(path) = delta.new_file().path().or_else(|| delta.old_file().path()) else {
            continue;
        };
        if has_extension(path, "tex") {
            paths.insert(path.to_string_lossy().replace('\\', "/").to_lowercase());
        }
    }
    paths
}

fn convert_roots(
    root: &Path,
    roots: Vec<PathBuf>,
    report: &mut ConversionReport,
) -> Result<(), BoundaryError> {
    for source_path in roots {
        let relative = normalized_relative(root, &source_path)?;
        let output_path = source_path.with_extension("typ");
        let output_relative = normalized_relative(root, &output_path)?;
        if output_path.exists() {
            report.skip(
                relative,
                "A sibling .typ file already exists; it was not overwritten.",
            );
            if report.primary_typst.is_none() {
                report.primary_typst = Some(output_relative);
            }
            continue;
        }

        let source = match read_bounded_tex(&source_path) {
            Ok(source) => source,
            Err(error) => {
                report.warn(&relative, "source-unreadable", error.message.clone(), None);
                report.skip(relative, error.message);
                continue;
            }
        };
        let mut include_stack = vec![source_path.clone()];
        let mut expanded_count = 0usize;
        let mut expanded_bytes = source.len();
        let expanded = expand_includes(
            &source,
            source_path.parent().ok_or_else(BoundaryError::internal)?,
            root,
            &mut include_stack,
            &mut expanded_count,
            &mut expanded_bytes,
            report,
            &relative,
        )?;
        let (normalized, normalized_accents) = normalize_common_latex_text(&expanded);
        if normalized_accents > 0 {
            report.warn(
                &relative,
                "text-accents-normalized",
                format!(
                    "UnderTree normalized {normalized_accents} common LaTeX text accent or quote command(s) to Unicode before conversion."
                ),
                None,
            );
        }
        let bibliography_paths = bibliography_paths(&normalized);
        add_preflight_warnings(&normalized, report, &relative);
        let (converter_input, unicode_markers) = shield_unicode_for_table_conversion(&normalized)?;
        if !unicode_markers.is_empty() {
            report.warn(
                &relative,
                "unicode-table-guard",
                "UnderTree safely shielded Unicode while converting a multirow table, then restored it in the Typst draft.",
                None,
            );
        }
        let options = L2TOptions {
            // Tylax strict mode can discard the arguments of unknown macros. In
            // non-strict mode it comments the macro while retaining its content.
            non_strict: true,
            ..L2TOptions::default()
        };
        let conversion = match panic::catch_unwind(AssertUnwindSafe(|| {
            latex_to_typst_with_diagnostics_options(&converter_input, options)
        })) {
            Ok(conversion) => conversion,
            Err(_) => {
                report.warn(
                    &relative,
                    "converter-panic-contained",
                    "The converter rejected this document internally. UnderTree contained the failure and preserved the original for manual review.",
                    None,
                );
                report.skip(
                    relative,
                    "The converter failed internally; the original LaTeX source was preserved.",
                );
                continue;
            }
        };

        for warning in conversion.warnings {
            report.warn(
                &relative,
                warning.kind.to_string(),
                warning.message,
                warning.location,
            );
        }

        let mut output = conversion.output;
        let missing_unicode = restore_unicode_markers(&mut output, &unicode_markers);
        if missing_unicode > 0 {
            report.warn(
                &relative,
                "unicode-table-review",
                format!(
                    "{missing_unicode} guarded Unicode character(s) were inside content the converter omitted; compare this draft with the preserved LaTeX original."
                ),
                None,
            );
        }
        let repaired_headings = repair_starred_headings(&mut output);
        if repaired_headings > 0 {
            report.warn(
                &relative,
                "starred-heading-repaired",
                format!(
                    "UnderTree repaired {repaired_headings} malformed starred heading(s) emitted by the converter. Verify their levels against the LaTeX original."
                ),
                None,
            );
        }
        let repaired_columns = repair_multicols_blocks(&mut output);
        if repaired_columns > 0 {
            report.warn(
                &relative,
                "multicols-repaired",
                format!(
                    "UnderTree translated {repaired_columns} multicols block(s) to Typst columns; verify column balancing and page breaks."
                ),
                None,
            );
        }
        let repaired_dimensions = remove_literal_dimension_artifacts(&mut output);
        if repaired_dimensions > 0 {
            report.warn(
                &relative,
                "dimension-artifacts-removed",
                format!(
                    "UnderTree removed {repaired_dimensions} literal LaTeX width artifact(s) emitted by the converter; verify the affected layout."
                ),
                None,
            );
        }
        let repaired_boundaries = repair_concatenated_markup_boundaries(&mut output);
        if repaired_boundaries > 0 {
            report.warn(
                &relative,
                "markup-boundaries-repaired",
                format!(
                    "UnderTree restored {repaired_boundaries} missing argument boundary/boundaries after converter-generated Typst emphasis."
                ),
                None,
            );
        }
        let repaired_at_signs = repair_literal_at_signs_in_markup(&mut output, &normalized);
        if repaired_at_signs > 0 {
            report.warn(
                &relative,
                "literal-at-signs-repaired",
                format!(
                    "UnderTree escaped {repaired_at_signs} literal @ sign(s) that the converter emitted as Typst references."
                ),
                None,
            );
        }
        restore_basic_document_layout(&mut output, &normalized, report, &relative);
        restore_html_color_definitions(&mut output, &normalized, report, &relative);
        append_missing_bibliographies(&mut output, &bibliography_paths, report, &relative);
        let header = format!(
            "// UnderTree conversion draft — review before publication.\n// Original LaTeX preserved at: {relative}\n// Converted locally with {ENGINE}; no external process or network service was used.\n\n"
        );
        output.insert_str(0, &header);
        if output.len() > MAX_TEX_SOURCE_BYTES as usize {
            return Err(BoundaryError::project(
                "converted_document_too_large",
                format!("The converted draft for {relative} exceeds the 1 MiB editor limit."),
            ));
        }
        atomic_create_new(&output_path, output.as_bytes())?;

        if report.primary_typst.is_none() {
            report.primary_typst = Some(output_relative.clone());
        }
        report.converted.push(ConvertedFile {
            latex: relative,
            typst: output_relative,
            expanded_includes: expanded_count,
        });
    }
    Ok(())
}

fn shield_unicode_for_table_conversion(
    source: &str,
) -> Result<(String, Vec<(String, char)>), BoundaryError> {
    if !source.contains("\\multirow") || source.is_ascii() {
        return Ok((source.to_owned(), Vec::new()));
    }
    let mut prefix = "UNDERTREEUNICODEPLACEHOLDER".to_owned();
    while source.contains(&prefix) {
        prefix.push('X');
    }
    let unicode_count = source
        .chars()
        .filter(|character| !character.is_ascii())
        .count();
    let estimated = source
        .len()
        .saturating_add(unicode_count.saturating_mul(prefix.len() + 12));
    if estimated > MAX_SHIELDED_TEX_BYTES {
        return Err(BoundaryError::project(
            "latex_unicode_guard_too_large",
            "A Unicode multirow document exceeded the 8 MiB guarded-conversion limit; its original was preserved.",
        ));
    }

    let mut shielded = String::with_capacity(estimated);
    let mut markers = Vec::with_capacity(unicode_count);
    for character in source.chars() {
        if character.is_ascii() {
            shielded.push(character);
        } else {
            let marker = format!("{prefix}{:08}X", markers.len());
            shielded.push_str(&marker);
            markers.push((marker, character));
        }
    }
    Ok((shielded, markers))
}

fn restore_unicode_markers(output: &mut String, markers: &[(String, char)]) -> usize {
    let mut missing = 0usize;
    for (marker, character) in markers {
        if output.contains(marker) {
            *output = output.replace(marker, &character.to_string());
        } else {
            missing = missing.saturating_add(1);
        }
    }
    missing
}

#[allow(clippy::too_many_arguments)]
fn expand_includes(
    source: &str,
    current_directory: &Path,
    root: &Path,
    stack: &mut Vec<PathBuf>,
    expanded_count: &mut usize,
    expanded_bytes: &mut usize,
    report: &mut ConversionReport,
    report_source: &str,
) -> Result<String, BoundaryError> {
    if stack.len() > MAX_INCLUDE_DEPTH {
        report.warn(
            report_source,
            "include-depth",
            "A nested include exceeded the 24-file depth limit and was left for manual review.",
            None,
        );
        return Ok(source.to_owned());
    }

    let mut output = String::with_capacity(source.len());
    let mut cursor = 0usize;
    while let Some(include) = next_include(source, cursor) {
        output.push_str(&source[cursor..include.start]);
        if line_is_commented(source, include.start)
            || position_is_in_literal_environment(source, include.start)
        {
            output.push_str(&source[include.start..include.end]);
            cursor = include.end;
            continue;
        }

        let Some(path) = resolve_include(current_directory, root, &include.target)? else {
            report.warn(
                report_source,
                "include-unresolved",
                format!(
                    "Could not safely resolve \\{}{{{}}}; it remains in the conversion draft.",
                    include.command, include.target
                ),
                Some(include.target.clone()),
            );
            output.push_str(&source[include.start..include.end]);
            cursor = include.end;
            continue;
        };
        if stack.contains(&path) {
            report.warn(
                report_source,
                "include-cycle",
                format!("Skipped a recursive include of {}.", include.target),
                Some(include.target.clone()),
            );
            cursor = include.end;
            continue;
        }

        let included_source = match read_bounded_tex(&path) {
            Ok(source) => source,
            Err(error) => {
                report.warn(
                    report_source,
                    "include-unreadable",
                    format!(
                        "Could not convert included source {}: {} The include remains in the draft.",
                        include.target, error.message
                    ),
                    Some(include.target.clone()),
                );
                output.push_str(&source[include.start..include.end]);
                cursor = include.end;
                continue;
            }
        };
        let included = if include.command.starts_with("subfile") {
            if let Some(body) = latex_document_body(&included_source) {
                report.warn(
                    report_source,
                    "subfile-preamble-removed",
                    format!(
                        "UnderTree expanded only the document body of subfile {} and left its standalone preamble out of the parent draft.",
                        include.target
                    ),
                    Some(include.target.clone()),
                );
                body.to_owned()
            } else {
                included_source
            }
        } else {
            included_source
        };
        if expanded_bytes.saturating_add(included.len()) > MAX_EXPANDED_TEX_BYTES {
            report.warn(
                report_source,
                "include-budget",
                "Combined included LaTeX exceeded the 1 MiB conversion budget; the remaining include was left for manual review.",
                Some(include.target.clone()),
            );
            output.push_str(&source[include.start..include.end]);
            cursor = include.end;
            continue;
        }

        *expanded_bytes += included.len();
        *expanded_count = expanded_count.saturating_add(1);
        stack.push(path.clone());
        let nested = expand_includes(
            &included,
            path.parent().ok_or_else(BoundaryError::internal)?,
            root,
            stack,
            expanded_count,
            expanded_bytes,
            report,
            report_source,
        )?;
        stack.pop();
        output.push_str("\n% UnderTree expanded a confined LaTeX include.\n");
        output.push_str(&nested);
        output.push_str("\n% End UnderTree include expansion.\n");
        cursor = include.end;
    }
    output.push_str(&source[cursor..]);
    Ok(output)
}

struct IncludeMatch {
    start: usize,
    end: usize,
    command: &'static str,
    target: String,
}

fn next_include(source: &str, from: usize) -> Option<IncludeMatch> {
    let mut search = from;
    while search < source.len() {
        let (offset, command) = ["input", "include", "subfileinclude", "subfile"]
            .into_iter()
            .filter_map(|command| {
                source[search..]
                    .find(&format!("\\{command}"))
                    .map(|offset| (offset, command))
            })
            .min_by_key(|(offset, _)| *offset)?;
        let start = search + offset;
        let after_command = start + command.len() + 1;
        if source[after_command..]
            .chars()
            .next()
            .is_some_and(|character| character.is_ascii_alphabetic())
        {
            search = after_command;
            continue;
        }
        let mut brace = after_command;
        while source
            .as_bytes()
            .get(brace)
            .is_some_and(u8::is_ascii_whitespace)
        {
            brace += 1;
        }
        if source.as_bytes().get(brace) != Some(&b'{') {
            search = after_command;
            continue;
        }
        let content_start = brace + 1;
        let close = source[content_start..].find('}')? + content_start;
        let target = source[content_start..close].trim();
        if target.is_empty() || target.contains(['{', '}']) {
            search = close + 1;
            continue;
        }
        return Some(IncludeMatch {
            start,
            end: close + 1,
            command,
            target: target.to_owned(),
        });
    }
    None
}

fn position_is_in_literal_environment(source: &str, position: usize) -> bool {
    let prefix = &source[..position];
    [
        "verbatim",
        "verbatim*",
        "Verbatim",
        "lstlisting",
        "minted",
        "comment",
        "filecontents",
        "filecontents*",
    ]
    .into_iter()
    .any(|environment| {
        let begin = format!("\\begin{{{environment}}}");
        let end = format!("\\end{{{environment}}}");
        match (prefix.rfind(&begin), prefix.rfind(&end)) {
            (Some(begin), Some(end)) => begin > end,
            (Some(_), None) => true,
            _ => false,
        }
    })
}

fn latex_document_body(source: &str) -> Option<&str> {
    let begin = "\\begin{document}";
    let end = "\\end{document}";
    let body_start = source.find(begin)? + begin.len();
    let body_end = source[body_start..].rfind(end)? + body_start;
    Some(&source[body_start..body_end])
}

fn tex_root_directive(source: &str) -> Option<String> {
    source.lines().take(50).find_map(|line| {
        let line = line.trim();
        let directive = line.strip_prefix('%')?.trim();
        let directive = directive.strip_prefix("!TeX")?.trim();
        let (key, value) = directive.split_once('=')?;
        if !key.trim().eq_ignore_ascii_case("root") {
            return None;
        }
        let value = value.trim();
        (!value.is_empty()).then(|| value.to_owned())
    })
}

fn add_preflight_warnings(source: &str, report: &mut ConversionReport, relative: &str) {
    let checks = [
        (
            "\\begin{thebibliography}",
            "inline-bibliography-review",
            "Inline thebibliography entries need manual review; UnderTree only restores external .bib declarations automatically.",
        ),
        (
            "\\begin{tikzpicture}",
            "tikz-review",
            "TikZ conversion is experimental and may require a manual CeTZ rewrite.",
        ),
        (
            "\\begin{tikzcd}",
            "tikz-review",
            "TikZ diagram conversion is experimental and needs visual review.",
        ),
        (
            "\\SI{",
            "siunitx-review",
            "siunitx values can be lost by current converters; compare every converted quantity with the LaTeX original.",
        ),
        (
            "\\si{",
            "siunitx-review",
            "siunitx units can be lost by current converters; compare every converted quantity with the LaTeX original.",
        ),
        (
            "\\import{",
            "import-review",
            "The two-part \\import command is not expanded automatically; verify the generated draft and convert that dependency separately if needed.",
        ),
        (
            "\\subimport{",
            "import-review",
            "The two-part \\subimport command is not expanded automatically; verify the generated draft and convert that dependency separately if needed.",
        ),
        (
            "\\includeonly{",
            "includeonly-review",
            "The project uses \\includeonly; UnderTree converts a complete draft, so verify which included chapters should remain active.",
        ),
        (
            "\\displaystyle",
            "display-math-review",
            "Current converters can render \\displaystyle as literal text; compare the affected equations with the LaTeX original.",
        ),
        (
            "\\\\[",
            "matrix-row-spacing-review",
            "Optional LaTeX row spacing can become an extra matrix cell; inspect converted matrices and aligned equations.",
        ),
        (
            "\\begin{minipage}",
            "minipage-review",
            "LaTeX minipages use layout semantics that do not map directly to Typst; verify widths, alignment, and adjacent content.",
        ),
        (
            "\\newcolumntype",
            "custom-table-columns-review",
            "Custom LaTeX table column types need visual review after conversion.",
        ),
    ];
    let mut warned_kinds = HashSet::new();
    for (needle, kind, message) in checks {
        if source.contains(needle) && warned_kinds.insert(kind) {
            report.warn(relative, kind, message, None);
        }
    }
    if (source.contains("\\begin{align}") || source.contains("\\begin{align*}"))
        && source.matches("\\label{").count() > 1
        && warned_kinds.insert("align-label-review")
    {
        report.warn(
            relative,
            "align-label-review",
            "Multiple labels inside an align environment can shift between rows; verify every converted equation reference.",
            None,
        );
    }
    for environment in ["itemize", "enumerate"] {
        if source.matches(&format!("\\begin{{{environment}}}")).count() > 1
            && warned_kinds.insert("nested-list-review")
        {
            report.warn(
                relative,
                "nested-list-review",
                "Nested LaTeX lists can be flattened by current converters; compare list hierarchy with the original.",
                None,
            );
        }
    }
}

fn normalize_common_latex_text(source: &str) -> (String, usize) {
    // Tylax currently drops a number of classic TeX text accents. Normalize a
    // conservative, explicit set before conversion so names and prose survive
    // without attempting to interpret arbitrary TeX macros.
    const REPLACEMENTS: &[(&str, &str)] = &[
        ("\\\"{a}", "ä"),
        ("\\\"{o}", "ö"),
        ("\\\"{u}", "ü"),
        ("\\\"{A}", "Ä"),
        ("\\\"{O}", "Ö"),
        ("\\\"{U}", "Ü"),
        ("\\\"a", "ä"),
        ("\\\"o", "ö"),
        ("\\\"u", "ü"),
        ("\\\"A", "Ä"),
        ("\\\"O", "Ö"),
        ("\\\"U", "Ü"),
        ("\\'{e}", "é"),
        ("\\'{a}", "á"),
        ("\\'{i}", "í"),
        ("\\'{o}", "ó"),
        ("\\'{u}", "ú"),
        ("\\'e", "é"),
        ("\\'a", "á"),
        ("\\'i", "í"),
        ("\\'o", "ó"),
        ("\\'u", "ú"),
        ("\\`{e}", "è"),
        ("\\`{a}", "à"),
        ("\\`{i}", "ì"),
        ("\\`{o}", "ò"),
        ("\\`{u}", "ù"),
        ("\\~{n}", "ñ"),
        ("\\~n", "ñ"),
        ("\\c{c}", "ç"),
        ("{\\ss}", "ß"),
        ("\\ss{}", "ß"),
        ("\\glqq{}", "„"),
        ("\\grqq{}", "“"),
        ("\\glqq", "„"),
        ("\\grqq", "“"),
    ];
    let mut output = source.to_owned();
    let mut count = 0usize;
    for (from, to) in REPLACEMENTS {
        let occurrences = output.matches(from).count();
        if occurrences > 0 {
            output = output.replace(from, to);
            count = count.saturating_add(occurrences);
        }
    }
    (output, count)
}

fn repair_multicols_blocks(output: &mut String) -> usize {
    const BEGIN: &str = "/* Begin multicols */";
    const END: &str = "/* End multicols */";
    let mut repaired = 0usize;
    while let Some(start) = output.find(BEGIN) {
        let content_start = start + BEGIN.len();
        let Some(relative_end) = output[content_start..].find(END) else {
            break;
        };
        let end = content_start + relative_end;
        let block = output[content_start..end].trim();
        let mut lines = block.lines();
        let Some(first) = lines.next() else {
            break;
        };
        let Ok(columns) = first.trim().parse::<usize>() else {
            break;
        };
        if !(2..=8).contains(&columns) {
            break;
        }
        let content = lines.collect::<Vec<_>>().join("\n");
        let dense_checklist =
            content.matches("$square$").count() >= 3 && content.matches("#v(2pt)").count() >= 3;
        let replacement = if dense_checklist {
            let items = content
                .split("#v(2pt)")
                .map(str::trim)
                .filter(|item| !item.is_empty())
                .collect::<Vec<_>>();
            let split = items.len().div_ceil(2);
            let stack_items = |items: &[&str]| {
                items
                    .iter()
                    .map(|item| format!("  [{item}]"))
                    .collect::<Vec<_>>()
                    .join(",\n")
            };
            let left = stack_items(&items[..split]);
            let right = stack_items(&items[split..]);
            let tracks = "1fr, ".repeat(columns);
            format!(
                "#grid(columns: ({tracks}), gutter: 1em,\n  [#stack(spacing: 6.5pt,\n{left},\n  )],\n  [#stack(spacing: 6.5pt,\n{right},\n  )],\n)"
            )
        } else {
            format!("#columns({columns}, gutter: 1em)[\n{content}\n]")
        };
        output.replace_range(start..end + END.len(), &replacement);
        repaired = repaired.saturating_add(1);
    }
    repaired
}

fn remove_literal_dimension_artifacts(output: &mut String) -> usize {
    const MARKERS: &[&str] = &[
        "/* \\columnwidth */",
        "/* \\textwidth */",
        "/* \\linewidth */",
    ];
    let mut removed = 0usize;
    for marker in MARKERS {
        let mut search = 0usize;
        while let Some(offset) = output[search..].find(marker) {
            let marker_start = search + offset;
            let mut number_start = marker_start;
            while number_start > 0 && output.as_bytes()[number_start - 1].is_ascii_digit()
                || number_start > 0 && output.as_bytes()[number_start - 1] == b'.'
            {
                number_start -= 1;
            }
            let numeric = &output[number_start..marker_start];
            let valid_fraction = numeric
                .parse::<f32>()
                .is_ok_and(|value| (0.0..=1.0).contains(&value));
            if !valid_fraction {
                search = marker_start + marker.len();
                continue;
            }
            let has_alignment_prefix = number_start > 0
                && matches!(output.as_bytes()[number_start - 1], b'c' | b'r' | b't');
            if has_alignment_prefix {
                number_start -= 1;
            }
            let allowed_boundary = has_alignment_prefix
                || number_start == 0
                || output.as_bytes()[number_start - 1].is_ascii_whitespace()
                || matches!(output.as_bytes()[number_start - 1], b'[' | b'(');
            if !allowed_boundary {
                search = marker_start + marker.len();
                continue;
            }
            output.replace_range(number_start..marker_start + marker.len(), "");
            removed = removed.saturating_add(1);
            search = number_start;
        }
    }
    let ragged = "/* \\RaggedRight */";
    let ragged_count = output.matches(ragged).count();
    if ragged_count > 0 {
        *output = output.replace(ragged, "");
        removed = removed.saturating_add(ragged_count);
    }
    removed
}

fn repair_concatenated_markup_boundaries(output: &mut String) -> usize {
    // In non-strict mode, Tylax preserves the arguments of unknown LaTeX
    // macros but can concatenate adjacent arguments. For example,
    // `\cvitem{October \textbf{2019}}{Gave ...}` becomes
    // `October *2019*Gave ...`. Typst then treats the opening `*` as unclosed
    // because a closing emphasis delimiter cannot touch the following word.
    // Only repair parser-confirmed unclosed emphasis delimiters with this exact
    // shape; balanced markup, math, code, raw text, and strings are untouched.
    let parsed = typst::syntax::Source::detached(output.clone());
    let mut stack = vec![typst::syntax::LinkedNode::new(parsed.root())];
    let mut error_delimiters = Vec::new();
    while let Some(node) = stack.pop() {
        if node.kind() == typst::syntax::SyntaxKind::Error
            && output
                .get(node.range())
                .is_some_and(|text| matches!(text, "*" | "_"))
        {
            error_delimiters.push(node.offset());
        }
        stack.extend(node.children());
    }

    let bytes = output.as_bytes();
    let mut insertions = Vec::new();
    for error in error_delimiters {
        let Some(delimiter) = bytes.get(error).copied() else {
            continue;
        };
        let line_start = bytes[..error]
            .iter()
            .rposition(|byte| *byte == b'\n')
            .map_or(0, |position| position + 1);
        let line_end = bytes[error + 1..]
            .iter()
            .position(|byte| *byte == b'\n')
            .map_or(bytes.len(), |offset| error + 1 + offset);
        let previous = (line_start..error)
            .rev()
            .find(|position| bytes[*position] == delimiter && !byte_is_escaped(bytes, *position));
        let next = (error + 1..line_end)
            .find(|position| bytes[*position] == delimiter && !byte_is_escaped(bytes, *position));

        let candidates = [(Some(error), next), (previous, Some(error))];
        for (opening, closing) in candidates {
            let (Some(opening), Some(closing)) = (opening, closing) else {
                continue;
            };
            if !markup_pair_needs_boundary(output, opening, closing) {
                continue;
            }
            if output[..opening]
                .chars()
                .next_back()
                .is_some_and(char::is_alphanumeric)
            {
                insertions.push(opening);
            }
            if output[closing + 1..]
                .chars()
                .next()
                .is_some_and(char::is_alphanumeric)
            {
                insertions.push(closing + 1);
            }
            break;
        }
    }

    insertions.sort_unstable();
    insertions.dedup();
    for offset in insertions.iter().rev() {
        output.insert(*offset, ' ');
    }
    insertions.len()
}

fn markup_pair_needs_boundary(source: &str, opening: usize, closing: usize) -> bool {
    if opening >= closing {
        return false;
    }
    let inner_starts_with_word = source[opening + 1..closing]
        .chars()
        .next()
        .is_some_and(char::is_alphanumeric);
    let inner_ends_with_word = source[opening + 1..closing]
        .chars()
        .next_back()
        .is_some_and(char::is_alphanumeric);
    let touches_word_before = source[..opening]
        .chars()
        .next_back()
        .is_some_and(char::is_alphanumeric);
    let touches_word_after = source[closing + 1..]
        .chars()
        .next()
        .is_some_and(char::is_alphanumeric);
    inner_starts_with_word && inner_ends_with_word && (touches_word_before || touches_word_after)
}

fn byte_is_escaped(bytes: &[u8], position: usize) -> bool {
    let mut cursor = position;
    let mut backslashes = 0usize;
    while cursor > 0 && bytes[cursor - 1] == b'\\' {
        cursor -= 1;
        backslashes = backslashes.saturating_add(1);
    }
    backslashes % 2 == 1
}

fn repair_literal_at_signs_in_markup(output: &mut String, latex: &str) -> usize {
    // In Typst markup, `@target` is a reference. Tylax currently copies the
    // visible text of LaTeX email and social links verbatim, so an address such
    // as `name@example.org` becomes text followed by a reference. Inspect the
    // parsed tree and require the exact marker to occur literally in the LaTeX
    // source: strings, code, raw text, math, citations, and `\ref` output must
    // remain untouched.
    let parsed = typst::syntax::Source::detached(output.clone());
    let mut stack = vec![typst::syntax::LinkedNode::new(parsed.root())];
    let mut offsets = Vec::new();
    while let Some(node) = stack.pop() {
        if node.kind() == typst::syntax::SyntaxKind::RefMarker {
            let range = node.range();
            if output
                .get(range.clone())
                .is_some_and(|marker| latex.contains(marker))
            {
                offsets.push(range.start);
            }
        }
        stack.extend(node.children());
    }

    offsets.sort_unstable();
    offsets.dedup();
    for offset in offsets.iter().rev() {
        output.insert(*offset, '\\');
    }
    offsets.len()
}

fn restore_basic_document_layout(
    output: &mut String,
    latex: &str,
    report: &mut ConversionReport,
    relative: &str,
) {
    let mut settings = String::new();
    if let Some(size) = document_class_font_size(latex) {
        settings.push_str(&format!("#set text(size: {size})\n"));
    }
    if let Some(margin) = geometry_margin(latex) {
        settings.push_str(&format!("#set page(margin: {margin})\n"));
    }
    if latex.contains("\\pagestyle{empty}") {
        settings.push_str("#set page(numbering: none)\n");
    }
    if settings.is_empty() {
        return;
    }
    settings.push('\n');
    output.insert_str(0, &settings);
    report.warn(
        relative,
        "basic-layout-restored",
        "UnderTree restored supported document font-size, margin, or page-numbering settings; verify the remaining template layout.",
        None,
    );
}

fn document_class_font_size(source: &str) -> Option<&'static str> {
    let start = source.find("\\documentclass[")? + "\\documentclass[".len();
    let end = source[start..].find(']')? + start;
    source[start..end]
        .split(',')
        .map(str::trim)
        .find_map(|option| match option {
            "8pt" => Some("8pt"),
            "9pt" => Some("9pt"),
            "10pt" => Some("10pt"),
            "11pt" => Some("11pt"),
            "12pt" => Some("12pt"),
            _ => None,
        })
}

fn geometry_margin(source: &str) -> Option<&str> {
    source.lines().find_map(|line| {
        let package = line.find("\\usepackage[")? + "\\usepackage[".len();
        let end = line[package..].find("]{geometry}")? + package;
        line[package..end]
            .split(',')
            .map(str::trim)
            .find_map(|option| {
                let value = option.strip_prefix("margin=")?.trim();
                let split = value
                    .find(|character: char| !character.is_ascii_digit() && character != '.')?;
                let (number, unit) = value.split_at(split);
                let valid_number = number.parse::<f32>().is_ok_and(|number| number > 0.0);
                let valid_unit = matches!(unit, "pt" | "mm" | "cm" | "in");
                (valid_number && valid_unit).then_some(value)
            })
    })
}

fn repair_starred_headings(output: &mut String) -> usize {
    let had_trailing_newline = output.ends_with('\n');
    let lines = output.lines().collect::<Vec<_>>();
    let mut repaired = Vec::with_capacity(lines.len());
    let mut count = 0usize;
    let mut index = 0usize;
    while index < lines.len() {
        let line = lines[index];
        let trimmed = line.trim_start();
        let marker_length = trimmed.bytes().take_while(|byte| *byte == b'=').count();
        let malformed = (1..=6).contains(&marker_length)
            && trimmed[marker_length..].trim() == "*"
            && lines
                .get(index + 1)
                .is_some_and(|next| !next.trim().is_empty());
        if malformed {
            let indentation = &line[..line.len() - trimmed.len()];
            repaired.push(format!(
                "{indentation}{} {}",
                "=".repeat(marker_length),
                lines[index + 1].trim()
            ));
            count = count.saturating_add(1);
            index += 2;
        } else {
            repaired.push(line.to_owned());
            index += 1;
        }
    }
    *output = repaired.join("\n");
    if had_trailing_newline {
        output.push('\n');
    }
    count
}

fn restore_html_color_definitions(
    output: &mut String,
    latex: &str,
    report: &mut ConversionReport,
    relative: &str,
) {
    let colors = latex_html_colors(latex);
    if colors.is_empty() {
        return;
    }
    let mut definitions = String::from(
        "// UnderTree restored safe HTML color declarations omitted by the converter.\n",
    );
    for (name, value) in &colors {
        definitions.push_str(&format!("#let {name} = rgb(\"#{value}\")\n"));
    }
    definitions.push('\n');
    output.insert_str(0, &definitions);
    report.warn(
        relative,
        "color-definitions-restored",
        format!(
            "UnderTree restored {} HTML color declaration(s). Compare custom color use with the LaTeX original.",
            colors.len()
        ),
        None,
    );
}

fn latex_html_colors(source: &str) -> Vec<(String, String)> {
    let needle = "\\definecolor";
    let mut colors = Vec::new();
    let mut cursor = 0usize;
    while let Some(offset) = source[cursor..].find(needle) {
        let start = cursor + offset;
        cursor = start + needle.len();
        if line_is_commented(source, start) || position_is_in_literal_environment(source, start) {
            continue;
        }
        let Some((name, after_name)) = simple_braced_argument(source, cursor) else {
            continue;
        };
        let Some((model, after_model)) = simple_braced_argument(source, after_name) else {
            cursor = after_name;
            continue;
        };
        let Some((value, after_value)) = simple_braced_argument(source, after_model) else {
            cursor = after_model;
            continue;
        };
        cursor = after_value;
        let name = name.trim();
        let value = value.trim();
        let valid_name = name
            .bytes()
            .next()
            .is_some_and(|byte| byte.is_ascii_alphabetic() || byte == b'_')
            && name
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_');
        let valid_value = matches!(value.len(), 3 | 4 | 6 | 8)
            && value.bytes().all(|byte| byte.is_ascii_hexdigit());
        if model.trim().eq_ignore_ascii_case("HTML")
            && valid_name
            && valid_value
            && !colors.iter().any(|(existing, _)| existing == name)
        {
            colors.push((name.to_owned(), value.to_ascii_uppercase()));
        }
    }
    colors
}

fn simple_braced_argument(source: &str, mut cursor: usize) -> Option<(&str, usize)> {
    while source
        .as_bytes()
        .get(cursor)
        .is_some_and(u8::is_ascii_whitespace)
    {
        cursor += 1;
    }
    if source.as_bytes().get(cursor) != Some(&b'{') {
        return None;
    }
    let start = cursor + 1;
    let close = source[start..].find('}')? + start;
    let value = &source[start..close];
    (!value.contains(['{', '}'])).then_some((value, close + 1))
}

fn line_is_commented(source: &str, position: usize) -> bool {
    let line_start = source[..position].rfind('\n').map_or(0, |index| index + 1);
    let prefix = &source[line_start..position];
    for (index, _) in prefix.match_indices('%') {
        let preceding_slashes = prefix[..index]
            .chars()
            .rev()
            .take_while(|character| *character == '\\')
            .count();
        if preceding_slashes % 2 == 0 {
            return true;
        }
    }
    false
}

fn resolve_include(
    current_directory: &Path,
    root: &Path,
    target: &str,
) -> Result<Option<PathBuf>, BoundaryError> {
    let relative = Path::new(target);
    if relative.is_absolute()
        || relative
            .components()
            .any(|component| matches!(component, Component::Prefix(_) | Component::RootDir))
    {
        return Ok(None);
    }
    let mut candidate = current_directory.join(relative);
    if candidate.extension().is_none() {
        candidate.set_extension("tex");
    }
    let Ok(candidate) = candidate.canonicalize() else {
        return Ok(None);
    };
    if !candidate.starts_with(root) || !candidate.is_file() || !has_extension(&candidate, "tex") {
        return Ok(None);
    }
    let metadata = fs::symlink_metadata(&candidate).map_err(|_| BoundaryError::internal())?;
    if metadata.file_type().is_symlink() {
        return Ok(None);
    }
    Ok(Some(candidate))
}

fn bibliography_paths(source: &str) -> Vec<String> {
    let mut paths = Vec::new();
    for command in ["addbibresource", "bibliography"] {
        let needle = format!("\\{command}");
        let mut cursor = 0usize;
        while let Some(offset) = source[cursor..].find(&needle) {
            let start = cursor + offset;
            let mut brace = start + needle.len();
            while source
                .as_bytes()
                .get(brace)
                .is_some_and(u8::is_ascii_whitespace)
            {
                brace += 1;
            }
            if source.as_bytes().get(brace) == Some(&b'[') {
                let Some(close_option) = source[brace + 1..].find(']') else {
                    break;
                };
                brace += close_option + 2;
                while source
                    .as_bytes()
                    .get(brace)
                    .is_some_and(u8::is_ascii_whitespace)
                {
                    brace += 1;
                }
            }
            if source.as_bytes().get(brace) != Some(&b'{') {
                cursor = brace;
                continue;
            }
            let Some(close_offset) = source[brace + 1..].find('}') else {
                break;
            };
            let close = brace + 1 + close_offset;
            if !line_is_commented(source, start)
                && !position_is_in_literal_environment(source, start)
            {
                for raw in source[brace + 1..close].split(',') {
                    let raw = raw.trim().replace('\\', "/");
                    if raw.is_empty() {
                        continue;
                    }
                    let mut path = PathBuf::from(raw);
                    if command == "bibliography" && path.extension().is_none() {
                        path.set_extension("bib");
                    }
                    if !path.is_absolute()
                        && path
                            .components()
                            .all(|component| matches!(component, Component::Normal(_)))
                    {
                        let normalized = path.to_string_lossy().replace('\\', "/");
                        if !paths.contains(&normalized) {
                            paths.push(normalized);
                        }
                    }
                }
            }
            cursor = close + 1;
        }
    }
    paths
}

fn append_missing_bibliographies(
    output: &mut String,
    paths: &[String],
    report: &mut ConversionReport,
    source: &str,
) {
    if paths.is_empty() || output.contains("#bibliography(") {
        return;
    }
    output.push_str(
        "\n\n// UnderTree restored bibliography declarations omitted by the converter.\n",
    );
    for path in paths {
        let escaped = path.replace('"', "\\\"");
        output.push_str(&format!("#bibliography(\"{escaped}\")\n"));
    }
    report.warn(
        source,
        "bibliography-restored",
        "UnderTree restored a bibliography declaration. Verify citation styling and placement.",
        None,
    );
}

fn read_bounded_tex(path: &Path) -> Result<String, BoundaryError> {
    let metadata = path.metadata().map_err(|_| {
        BoundaryError::project("latex_unavailable", "A LaTeX document is unavailable.")
    })?;
    if metadata.len() > MAX_TEX_SOURCE_BYTES {
        return Err(BoundaryError::project(
            "latex_document_too_large",
            "Individual LaTeX documents are limited to 1 MiB.",
        ));
    }
    fs::read_to_string(path).map_err(|_| {
        BoundaryError::project(
            "latex_encoding",
            "LaTeX documents must use UTF-8 for automatic conversion.",
        )
    })
}

fn atomic_create_new(path: &Path, bytes: &[u8]) -> Result<(), BoundaryError> {
    let parent = path.parent().ok_or_else(BoundaryError::internal)?;
    let mut temporary = NamedTempFile::new_in(parent).map_err(|_| {
        BoundaryError::project(
            "conversion_write_failed",
            "UnderTree could not create a temporary conversion draft.",
        )
    })?;
    temporary
        .write_all(bytes)
        .map_err(|_| BoundaryError::internal())?;
    temporary
        .as_file()
        .sync_all()
        .map_err(|_| BoundaryError::internal())?;
    temporary.persist_noclobber(path).map_err(|error| {
        if error.error.kind() == io::ErrorKind::AlreadyExists {
            BoundaryError::project(
                "converted_document_exists",
                "A Typst file appeared during conversion, so UnderTree left it untouched.",
            )
        } else {
            BoundaryError::project(
                "conversion_write_failed",
                "The converted Typst draft could not be saved safely.",
            )
        }
    })?;
    Ok(())
}

fn extract_archive(archive_path: &Path, staging: &Path) -> Result<usize, BoundaryError> {
    let file = File::open(archive_path).map_err(|_| BoundaryError::internal())?;
    let mut archive = ZipArchive::new(file).map_err(|_| {
        BoundaryError::project(
            "archive_invalid",
            "The selected file is not a readable ZIP archive.",
        )
    })?;
    if archive.len() > MAX_ARCHIVE_ENTRIES {
        return Err(BoundaryError::project(
            "archive_too_many_entries",
            "Overleaf archives are limited to 20,000 entries.",
        ));
    }

    let mut declared_expanded = 0u64;
    let mut actual_expanded = 0u64;
    let mut seen = HashSet::new();
    for index in 0..archive.len() {
        let mut entry = archive.by_index(index).map_err(|_| {
            BoundaryError::project(
                "archive_invalid",
                "The ZIP archive contains an unreadable entry.",
            )
        })?;
        if entry.size() > MAX_ARCHIVE_FILE_BYTES {
            return Err(BoundaryError::project(
                "archive_entry_too_large",
                "A file in the archive exceeds the 128 MiB per-file limit.",
            ));
        }
        declared_expanded = declared_expanded.saturating_add(entry.size());
        if declared_expanded > MAX_ARCHIVE_EXPANDED_BYTES {
            return Err(BoundaryError::project(
                "archive_expands_too_large",
                "The extracted archive would exceed the 1 GiB limit.",
            ));
        }
        if entry.encrypted() {
            return Err(BoundaryError::project(
                "archive_encrypted",
                "Encrypted archive entries are not supported.",
            ));
        }
        if entry.unix_mode().is_some_and(|mode| {
            let kind = mode & 0o170_000;
            kind != 0 && kind != 0o040_000 && kind != 0o100_000
        }) {
            return Err(BoundaryError::project(
                "archive_special_file_denied",
                "Links and special files are not allowed in imported archives.",
            ));
        }
        let relative = entry.enclosed_name().ok_or_else(|| {
            BoundaryError::project(
                "archive_path_denied",
                "The archive contains a path outside its project folder.",
            )
        })?;
        if relative.as_os_str().is_empty()
            || relative.components().count() > MAX_SCAN_DEPTH
            || relative.to_string_lossy().len() > 512
            || !archive_path_is_allowed(&relative)
        {
            return Err(BoundaryError::project(
                "archive_path_denied",
                "The archive contains an unsupported or overly deep path.",
            ));
        }
        let key = relative.to_string_lossy().replace('\\', "/").to_lowercase();
        if !seen.insert(key) {
            return Err(BoundaryError::project(
                "archive_duplicate_path",
                "The archive contains duplicate file paths and was not extracted.",
            ));
        }
        let output = staging.join(relative);
        if !output.starts_with(staging) {
            return Err(BoundaryError::project(
                "archive_path_denied",
                "The archive contains a path outside its project folder.",
            ));
        }
        if entry.is_dir() {
            fs::create_dir_all(&output).map_err(|_| BoundaryError::internal())?;
            continue;
        }
        let parent = output.parent().ok_or_else(BoundaryError::internal)?;
        fs::create_dir_all(parent).map_err(|_| BoundaryError::internal())?;
        let canonical_parent = parent
            .canonicalize()
            .map_err(|_| BoundaryError::internal())?;
        if !canonical_parent.starts_with(staging) {
            return Err(BoundaryError::project(
                "archive_path_denied",
                "An archive entry escaped its temporary project folder.",
            ));
        }
        let mut destination = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&output)
            .map_err(|_| {
                BoundaryError::project(
                    "archive_extract_failed",
                    "An archive file could not be created without overwriting data.",
                )
            })?;
        let copied = io::copy(
            &mut entry.by_ref().take(MAX_ARCHIVE_FILE_BYTES + 1),
            &mut destination,
        )
        .map_err(|_| BoundaryError::internal())?;
        if copied != entry.size() || copied > MAX_ARCHIVE_FILE_BYTES {
            return Err(BoundaryError::project(
                "archive_entry_invalid",
                "An archive entry did not match its declared size.",
            ));
        }
        actual_expanded = actual_expanded.saturating_add(copied);
        if actual_expanded > MAX_ARCHIVE_EXPANDED_BYTES {
            return Err(BoundaryError::project(
                "archive_expands_too_large",
                "The extracted archive exceeded the 1 GiB limit.",
            ));
        }
        destination
            .sync_all()
            .map_err(|_| BoundaryError::internal())?;
    }
    Ok(archive.len())
}

fn archive_path_is_allowed(path: &Path) -> bool {
    path.components().all(|component| {
        let Component::Normal(name) = component else {
            return false;
        };
        let Some(name) = name.to_str() else {
            return false;
        };
        if name.is_empty()
            || name.ends_with([' ', '.'])
            || name.contains(':')
            || name.eq_ignore_ascii_case(".git")
            || name.eq_ignore_ascii_case(".undertree")
        {
            return false;
        }
        let stem = name
            .split('.')
            .next()
            .unwrap_or(name)
            .trim_end_matches([' ', '.']);
        !matches!(
            stem.to_ascii_uppercase().as_str(),
            "CON"
                | "PRN"
                | "AUX"
                | "NUL"
                | "COM1"
                | "COM2"
                | "COM3"
                | "COM4"
                | "COM5"
                | "COM6"
                | "COM7"
                | "COM8"
                | "COM9"
                | "LPT1"
                | "LPT2"
                | "LPT3"
                | "LPT4"
                | "LPT5"
                | "LPT6"
                | "LPT7"
                | "LPT8"
                | "LPT9"
        )
    })
}

fn collapse_single_archive_root(staging: &Path) -> Result<PathBuf, BoundaryError> {
    let mut entries = fs::read_dir(staging)
        .map_err(|_| BoundaryError::internal())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| BoundaryError::internal())?;
    if entries.len() == 1 {
        let entry = entries.pop().expect("one archive entry exists");
        let file_type = entry.file_type().map_err(|_| BoundaryError::internal())?;
        if file_type.is_dir() && !file_type.is_symlink() {
            return entry
                .path()
                .canonicalize()
                .map_err(|_| BoundaryError::internal());
        }
    }
    Ok(staging.to_path_buf())
}

fn available_project_target(parent: &Path, stem: &str) -> Result<PathBuf, BoundaryError> {
    for suffix in 0..100u8 {
        let name = if suffix == 0 {
            format!("{stem}-typst")
        } else {
            format!("{stem}-typst-{}", suffix + 1)
        };
        let target = parent.join(name);
        match fs::symlink_metadata(&target) {
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(target),
            Ok(_) => continue,
            Err(_) => {
                return Err(BoundaryError::project(
                    "archive_destination_unavailable",
                    "UnderTree could not inspect the archive destination.",
                ));
            }
        }
    }
    Err(BoundaryError::project(
        "archive_destination_exists",
        "Choose another destination because matching imported project folders already exist.",
    ))
}

fn sanitize_project_name(name: &str) -> String {
    let mut output = String::with_capacity(name.len());
    for character in name.chars().take(80) {
        if character.is_alphanumeric() || matches!(character, '-' | '_' | ' ') {
            output.push(character);
        } else {
            output.push('-');
        }
    }
    output.trim_matches([' ', '.', '-']).to_owned()
}

fn should_skip_directory(name: &std::ffi::OsStr) -> bool {
    matches!(
        name.to_str(),
        Some(".git" | ".undertree" | "node_modules" | "target")
    )
}

fn normalized_relative(root: &Path, path: &Path) -> Result<String, BoundaryError> {
    path.strip_prefix(root)
        .ok()
        .and_then(|path| path.to_str())
        .map(|path| path.replace('\\', "/"))
        .ok_or_else(|| {
            BoundaryError::project(
                "unsupported_path",
                "LaTeX and Typst project paths must use Unicode characters.",
            )
        })
}

fn has_extension(path: &Path, expected: &str) -> bool {
    path.extension()
        .is_some_and(|extension| extension.eq_ignore_ascii_case(expected))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::compiler::{CompileRequest, CompilerAssets};
    use std::time::{SystemTime, UNIX_EPOCH};
    use zip::ZipWriter;
    use zip::write::SimpleFileOptions;

    fn temporary_directory(label: &str) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system clock should follow Unix epoch")
            .as_nanos();
        std::env::temp_dir().join(format!(
            "undertree-latex-{label}-{}-{nonce}",
            std::process::id()
        ))
    }

    fn write_zip(path: &Path, entries: &[(&str, &[u8])]) {
        let file = File::create(path).expect("create ZIP fixture");
        let mut archive = ZipWriter::new(file);
        for (name, bytes) in entries {
            archive
                .start_file(*name, SimpleFileOptions::default())
                .expect("start ZIP fixture entry");
            archive.write_all(bytes).expect("write ZIP fixture entry");
        }
        archive.finish().expect("finish ZIP fixture");
    }

    #[test]
    fn converts_a_document_without_touching_its_latex_source() {
        let root = temporary_directory("preserves-source");
        fs::create_dir_all(&root).expect("create project");
        let latex = "\\documentclass{article}\n\\begin{document}\n\\section{Hello}\nWorld $x^2$\n\\end{document}\n";
        fs::write(root.join("main.tex"), latex).expect("write LaTeX");

        let report = convert_project_if_needed(&root)
            .expect("conversion should succeed")
            .expect("report should be returned");
        assert_eq!(report.converted.len(), 1);
        assert_eq!(report.primary_typst.as_deref(), Some("main.typ"));
        assert_eq!(fs::read_to_string(root.join("main.tex")).unwrap(), latex);
        assert!(
            fs::read_to_string(root.join("main.typ"))
                .unwrap()
                .contains("= Hello")
        );

        let second = convert_project_if_needed(&root)
            .expect("repeated conversion should be safe")
            .expect("skip report should be returned");
        assert!(second.converted.is_empty());
        assert_eq!(second.skipped.len(), 1);
        fs::remove_dir_all(root).expect("remove test project");
    }

    #[test]
    fn exports_versioned_latex_drafts_without_touching_typst_or_reimporting_them() {
        let root = temporary_directory("typst-to-latex");
        fs::create_dir_all(&root).expect("create project");
        let typst = "= Introduction\n\nHello, *world*! $x^2$\n";
        fs::write(root.join("main.typ"), typst).expect("write Typst source");

        let first = export_typst_document(&root, "main.typ", typst)
            .expect("first LaTeX export should succeed");
        assert_eq!(first.latex, "main.undertree-export.tex");
        assert!(first.original_preserved);
        assert!(first.source_compiled);
        assert!(first.needs_review);
        let first_output =
            fs::read_to_string(root.join(&first.latex)).expect("read first LaTeX export");
        assert!(first_output.contains("\\documentclass[11pt]{article}"));
        assert!(first_output.contains("\\setcounter{secnumdepth}{0}"));
        assert!(first_output.contains("\\pagestyle{empty}"));
        assert!(first_output.contains("\\begin{document}"));
        assert!(first_output.contains("\\textbf{world}"));
        assert!(first_output.contains("\\end{document}"));

        let second = export_typst_document(&root, "main.typ", typst)
            .expect("second LaTeX export should preserve the first");
        assert_eq!(second.latex, "main.undertree-export-2.tex");
        assert_eq!(fs::read_to_string(root.join("main.typ")).unwrap(), typst);
        assert!(root.join(&first.latex).is_file());
        assert!(root.join(&second.latex).is_file());
        assert!(discover_tex_files(&root).unwrap().is_empty());

        fs::remove_dir_all(root).expect("remove test project");
    }

    #[test]
    fn restores_simple_typst_defaults_without_overriding_explicit_numbering() {
        let mut defaults =
            "\\documentclass{article}\n\\begin{document}\n\\end{tabular}\n\nText\n\\end{document}"
                .to_owned();
        assert_eq!(
            restore_basic_latex_layout_from_typst(&mut defaults, "= Heading"),
            5
        );
        assert!(defaults.contains("\\documentclass[11pt]{article}"));
        assert!(defaults.contains("\\setcounter{secnumdepth}{0}"));
        assert!(defaults.contains("\\pagestyle{empty}"));
        assert!(defaults.contains("\\setlength{\\parindent}{0pt}"));
        assert!(defaults.contains("\\end{tabular}\n\\par\\medskip"));

        let mut explicit =
            "\\documentclass{article}\n\\begin{document}\nText\n\\end{document}".to_owned();
        restore_basic_latex_layout_from_typst(
            &mut explicit,
            "#set text(size: 12pt)\n#set heading(numbering: \"1.\")\n#set page(numbering: \"1\")",
        );
        assert!(explicit.contains("\\documentclass[12pt]{article}"));
        assert!(!explicit.contains("\\setcounter{secnumdepth}{0}"));
        assert!(!explicit.contains("\\pagestyle{empty}"));
    }

    #[test]
    #[ignore = "requires UNDERTREE_TYPST_LATEX_FIXTURE to name a disposable .typ document"]
    fn exports_external_typst_fixture_without_mutating_its_source() {
        let source_path = std::env::var_os("UNDERTREE_TYPST_LATEX_FIXTURE")
            .map(PathBuf::from)
            .expect("set UNDERTREE_TYPST_LATEX_FIXTURE to a disposable .typ document")
            .canonicalize()
            .expect("fixture should be available");
        let root = source_path
            .parent()
            .expect("fixture should have a parent")
            .canonicalize()
            .expect("fixture parent should be available");
        let relative = normalized_relative(&root, &source_path).expect("relative fixture path");
        let original = fs::read(&source_path).expect("read original Typst fixture");
        let source = String::from_utf8(original.clone()).expect("fixture should be UTF-8");

        CompilerAssets::load()
            .compile(
                CompileRequest {
                    source: source.clone(),
                    path: Some(relative.clone()),
                    revision: 1,
                },
                Some(root.clone()),
            )
            .expect("fixture should compile before reverse conversion");
        let report = export_typst_document(&root, &relative, &source)
            .expect("fixture should export without overwriting anything");

        assert_eq!(fs::read(&source_path).unwrap(), original);
        println!(
            "Typst-to-LaTeX QA export: {} ({} warning(s))",
            root.join(&report.latex).display(),
            report.warning_count
        );
    }

    #[test]
    fn skips_non_utf8_legacy_sources_without_blocking_other_conversions() {
        let root = temporary_directory("legacy-encoding");
        fs::create_dir_all(&root).expect("create project");
        let latex =
            b"\\documentclass{article}\n\\begin{document}\nValid document\n\\end{document}\n";
        fs::write(root.join("main.tex"), latex).expect("write UTF-8 source");
        let legacy = [
            b'\\', b'd', b'o', b'c', b'u', b'm', b'e', b'n', b't', b'c', b'l', b'a', b's', b's',
            b'{', b'a', b'r', b't', b'i', b'c', b'l', b'e', b'}', b'\n', 0xff,
        ];
        fs::write(root.join("legacy.tex"), legacy).expect("write legacy source bytes");

        let report = convert_project_if_needed(&root)
            .expect("compatible sources should still convert")
            .expect("conversion report");
        assert!(root.join("main.typ").is_file());
        assert!(!root.join("legacy.typ").exists());
        assert!(
            report
                .skipped
                .iter()
                .any(|skipped| skipped.latex == "legacy.tex")
        );
        assert_eq!(fs::read(root.join("legacy.tex")).unwrap(), legacy);
        fs::remove_dir_all(root).expect("remove test project");
    }

    #[test]
    fn expands_only_confined_includes_and_restores_bibliography() {
        let root = temporary_directory("includes");
        fs::create_dir_all(root.join("chapters")).expect("create project");
        fs::write(root.join("chapters/intro.tex"), "Included chapter.")
            .expect("write included source");
        fs::write(root.join("refs.bib"), "@book{tree,title={Tree}}").expect("write bibliography");
        fs::write(
            root.join("main.tex"),
            "\\documentclass{article}\n\\begin{document}\n\\input{chapters/intro}\n\\cite{tree}\n\\bibliography{refs}\n\\end{document}",
        )
        .expect("write main source");

        let report = convert_project_if_needed(&root)
            .expect("conversion should succeed")
            .expect("report should be returned");
        assert_eq!(report.converted[0].expanded_includes, 1);
        let typst = fs::read_to_string(root.join("main.typ")).expect("read Typst");
        assert!(typst.contains("Included chapter"));
        assert!(typst.contains("#bibliography(\"refs.bib\")"));
        assert!(root.join("main.tex").exists());
        assert!(root.join("chapters/intro.tex").exists());
        assert!(root.join("refs.bib").exists());

        let canonical_root = root
            .canonicalize()
            .expect("canonicalize conversion fixture");
        CompilerAssets::load()
            .compile(
                CompileRequest {
                    source: typst,
                    path: Some("main.typ".into()),
                    revision: 1,
                },
                Some(canonical_root),
            )
            .expect("the guarded conversion fixture should compile with embedded Typst");
        fs::remove_dir_all(root).expect("remove test project");
    }

    #[test]
    fn imports_an_overleaf_archive_without_changing_the_archive_or_assets() {
        let parent = temporary_directory("overleaf");
        fs::create_dir_all(&parent).expect("create import parent");
        let archive = parent.join("paper.zip");
        let latex = b"\\documentclass{article}\n\\begin{document}Archive project\\end{document}";
        let asset = b"unchanged image bytes";
        write_zip(
            &archive,
            &[
                ("paper/main.tex", latex),
                ("paper/images/figure.dat", asset),
            ],
        );
        let archive_before = fs::read(&archive).expect("read original archive");

        let (project, report) =
            import_overleaf_zip(&archive, &parent).expect("import Overleaf archive");
        assert_eq!(fs::read(&archive).unwrap(), archive_before);
        assert_eq!(fs::read(project.join("main.tex")).unwrap(), latex);
        assert_eq!(fs::read(project.join("images/figure.dat")).unwrap(), asset);
        assert!(project.join("main.typ").is_file());
        assert_eq!(report.preserved_entries, 2);

        fs::remove_dir_all(parent).expect("remove test import");
    }

    #[test]
    fn rejects_archive_traversal_and_reserved_metadata_folders() {
        let parent = temporary_directory("archive-denied");
        fs::create_dir_all(&parent).expect("create import parent");
        let traversal = parent.join("traversal.zip");
        write_zip(&traversal, &[("../outside.tex", b"escape")]);
        let error = import_overleaf_zip(&traversal, &parent)
            .expect_err("archive traversal must be rejected");
        assert_eq!(error.code, "archive_path_denied");
        assert!(!parent.join("outside.tex").exists());

        let metadata = parent.join("metadata.zip");
        write_zip(&metadata, &[(".git/config", b"not a repository")]);
        let error = import_overleaf_zip(&metadata, &parent)
            .expect_err("archive metadata folders must be rejected");
        assert_eq!(error.code, "archive_path_denied");
        fs::remove_dir_all(parent).expect("remove denied archive fixtures");
    }

    #[test]
    fn rejects_archive_escape_paths() {
        assert!(
            Path::new("../escape.tex")
                .components()
                .any(|component| !matches!(component, Component::Normal(_)))
        );
        assert!(
            Path::new("project/main.tex")
                .components()
                .all(|component| matches!(component, Component::Normal(_)))
        );
    }

    #[test]
    fn include_parser_does_not_treat_includegraphics_as_an_include() {
        let source = "\\includegraphics{figure.png}\n\\input {chapter}";
        let found = next_include(source, 0).expect("input should be found");
        assert_eq!(found.command, "input");
        assert_eq!(found.target, "chapter");
    }

    #[test]
    fn expands_subfiles_but_not_commands_shown_in_literal_code() {
        let root = temporary_directory("subfiles");
        fs::create_dir_all(root.join("chapters")).expect("create project");
        fs::write(
            root.join("chapters/body.tex"),
            "\\documentclass[../main.tex]{subfiles}\nSHOULD_NOT_INLINE_PREAMBLE\n\\begin{document}\nSubfile body.\n\\end{document}",
        )
        .expect("write subfile");
        fs::write(
            root.join("main.tex"),
            "\\documentclass{article}\n\\begin{document}\n\\begin{verbatim}\n\\input{missing}\n\\end{verbatim}\n\\subfile{chapters/body}\n\\end{document}",
        )
        .expect("write main source");

        let report = convert_project_if_needed(&root)
            .expect("conversion should succeed")
            .expect("report should be returned");
        assert_eq!(report.converted[0].expanded_includes, 1);
        assert!(!report.warnings.iter().any(|warning| {
            warning.kind == "include-unresolved" && warning.location.as_deref() == Some("missing")
        }));
        assert!(
            fs::read_to_string(root.join("main.typ"))
                .unwrap()
                .contains("Subfile body")
        );
        assert!(
            !fs::read_to_string(root.join("main.typ"))
                .unwrap()
                .contains("SHOULD_NOT_INLINE_PREAMBLE")
        );
        assert!(
            report
                .warnings
                .iter()
                .any(|warning| warning.kind == "subfile-preamble-removed")
        );
        fs::remove_dir_all(root).expect("remove subfile fixture");
    }

    #[test]
    fn recognizes_literal_environments_and_optional_bibliography_arguments() {
        for environment in [
            "verbatim",
            "verbatim*",
            "Verbatim",
            "lstlisting",
            "minted",
            "comment",
            "filecontents",
            "filecontents*",
        ] {
            let source =
                format!("\\begin{{{environment}}}\n\\input{{example}}\n\\end{{{environment}}}");
            let position = source.find("\\input").unwrap();
            assert!(position_is_in_literal_environment(&source, position));
        }
        assert_eq!(
            bibliography_paths("\\addbibresource[location=local]{references/library.bib}"),
            vec!["references/library.bib"]
        );
    }

    #[test]
    fn repairs_the_known_starred_heading_delimiter_output() {
        let mut output = "Intro\n==== *\nAims and hypotheses\nBody\n".to_owned();
        assert_eq!(repair_starred_headings(&mut output), 1);
        assert_eq!(output, "Intro\n==== Aims and hypotheses\nBody\n");
    }

    #[test]
    fn normalizes_common_text_accents_before_conversion() {
        let (normalized, count) = normalize_common_latex_text(
            "G\\\"aste, J\\\"org Morr\\'e, anschlie{\\ss}end, \\glqq Titel\\grqq{}",
        );
        assert_eq!(normalized, "Gäste, Jörg Morré, anschließend, „ Titel“");
        assert_eq!(count, 6);
    }

    #[test]
    fn repairs_supported_page_and_multicolumn_layout_artifacts() {
        let latex = "\\documentclass[a4paper,10pt]{article}\n\\usepackage[margin=1.4cm]{geometry}\n\\pagestyle{empty}\n\\begin{document}";
        let mut output = "/* Begin multicols */\n2\n$square$#h(0.6em)t0.92/* \\columnwidth *//* \\RaggedRight */ Ada\n#v(2pt)\n$square$ Bob\n#v(2pt)\n$square$ Cy\n#v(2pt)\n/* End multicols */".to_owned();
        assert_eq!(repair_multicols_blocks(&mut output), 1);
        assert_eq!(remove_literal_dimension_artifacts(&mut output), 2);
        let mut report = ConversionReport::new("main.tex".to_owned(), Path::new("project"), 1);
        restore_basic_document_layout(&mut output, latex, &mut report, "main.tex");
        assert!(output.contains("#set text(size: 10pt)"));
        assert!(output.contains("#set page(margin: 1.4cm)"));
        assert!(output.contains("#set page(numbering: none)"));
        assert!(output.contains("#grid(columns: (1fr, 1fr, )"));
        assert!(!output.contains("columnwidth"));
        CompilerAssets::load()
            .compile(
                CompileRequest {
                    source: output,
                    path: None,
                    revision: 1,
                },
                None,
            )
            .expect("the supported layout repairs should produce compilable Typst");
    }

    #[test]
    fn repairs_literal_at_signs_and_concatenated_unknown_macro_arguments() {
        let root = temporary_directory("visible-email");
        fs::create_dir_all(&root).expect("create project");
        let latex = "\\documentclass{article}\n\\usepackage{hyperref}\n\\begin{document}\n\\section{Topic}\n\\label{topic}\nSee \\ref{topic}.\n\\href{mailto:person+cv@example.org}{person+cv@example.org}\n\\href{https://social.example/Person}{: @Person}\n\\cvitem{October \\textbf{2019}}{Gave a lecture.}\n\n\\cvitem{2026}{\\textbf{ELES Project}: Award.}\n\\end{document}\n";
        fs::write(root.join("main.tex"), latex).expect("write LaTeX source");

        let report = convert_project_if_needed(&root)
            .expect("conversion should succeed")
            .expect("conversion report should be returned");
        let typst = fs::read_to_string(root.join("main.typ")).expect("read Typst draft");
        assert!(
            typst.contains("#link(\"mailto:person+cv@example.org\")[person+cv\\@example.org]"),
            "visible email should be escaped without changing the mailto target: {typst}"
        );
        assert!(
            report
                .warnings
                .iter()
                .any(|warning| warning.kind == "literal-at-signs-repaired")
        );
        assert!(typst.contains(r#"#link("https://social.example/Person")[: \@Person]"#));
        assert!(
            typst.contains("@topic"),
            "real LaTeX references must remain active"
        );
        assert!(
            typst.contains("/* \\cvitem */October *2019* Gave a lecture."),
            "unknown macro arguments should have a compilable boundary: {typst}"
        );
        assert!(
            typst.contains("/* \\cvitem */2026 *ELES Project*: Award."),
            "unknown macro arguments should have a boundary before emphasis: {typst}"
        );
        assert!(
            report
                .warnings
                .iter()
                .any(|warning| warning.kind == "markup-boundaries-repaired")
        );

        let unchanged = "#let address = \"person@example.org\"\n`raw@example.org`";
        let mut unchanged_output = unchanged.to_owned();
        assert_eq!(
            repair_literal_at_signs_in_markup(&mut unchanged_output, "person@example.org"),
            0
        );
        assert_eq!(unchanged_output, unchanged);

        let valid_markup = "*strong* text\n#let value = \"*quoted*word\"\n// *comment*word\n`raw_word`\n_cv-generated";
        let mut valid_output = valid_markup.to_owned();
        assert_eq!(repair_concatenated_markup_boundaries(&mut valid_output), 0);
        assert_eq!(valid_output, valid_markup);

        CompilerAssets::load()
            .compile(
                CompileRequest {
                    source: typst,
                    path: Some("main.typ".into()),
                    revision: 1,
                },
                Some(root.canonicalize().expect("canonicalize project")),
            )
            .expect("the repaired email conversion should compile with embedded Typst");
        fs::remove_dir_all(root).expect("remove test project");
    }

    #[test]
    fn restores_safe_html_colors_as_compilable_typst_bindings() {
        let latex =
            "\\definecolor{LightBlue}{HTML}{eef4f9}\n\\definecolor{unsafe-name}{HTML}{000000}";
        assert_eq!(
            latex_html_colors(latex),
            vec![("LightBlue".to_owned(), "EEF4F9".to_owned())]
        );
        let mut output = "#box(fill: LightBlue)[Status]".to_owned();
        let mut report = ConversionReport::new("main.tex".to_owned(), Path::new("project"), 1);
        restore_html_color_definitions(&mut output, latex, &mut report, "main.tex");
        CompilerAssets::load()
            .compile(
                CompileRequest {
                    source: output,
                    path: None,
                    revision: 1,
                },
                None,
            )
            .expect("restored HTML color bindings should compile");
    }

    #[test]
    fn understands_tex_root_directives_and_known_lossy_constructs() {
        assert_eq!(
            tex_root_directive("% !TeX root = ../main.tex\nChapter"),
            Some("../main.tex".to_owned())
        );
        let root = Path::new("project");
        let mut report = ConversionReport::new("main.tex".to_owned(), root, 1);
        add_preflight_warnings(
            "\\begin{thebibliography}{9}\\end{thebibliography}\\begin{tikzpicture}\\end{tikzpicture}\\SI{4}{m}\\begin{minipage}{1cm}x\\end{minipage}\\newcolumntype{P}{l}",
            &mut report,
            "main.tex",
        );
        assert!(
            report
                .warnings
                .iter()
                .any(|warning| warning.kind == "inline-bibliography-review")
        );
        assert!(
            report
                .warnings
                .iter()
                .any(|warning| warning.kind == "tikz-review")
        );
        assert!(
            report
                .warnings
                .iter()
                .any(|warning| warning.kind == "siunitx-review")
        );
        assert!(
            report
                .warnings
                .iter()
                .any(|warning| warning.kind == "minipage-review")
        );
        assert!(
            report
                .warnings
                .iter()
                .any(|warning| warning.kind == "custom-table-columns-review")
        );
    }

    #[test]
    fn prioritizes_main_then_recent_commit_then_newest_year() {
        let root = Path::new("project");
        let main = root.join("paper/main.tex");
        let recent = root.join("applications/2026/new.tex");
        let older = root.join("applications/2025/old.tex");
        let mut changed = HashSet::new();
        changed.insert("applications/2026/new.tex".to_owned());

        assert!(
            document_root_score(root, &main, &changed)
                < document_root_score(root, &recent, &changed)
        );
        assert!(
            document_root_score(root, &recent, &changed)
                < document_root_score(root, &older, &changed)
        );
    }

    #[test]
    fn contains_the_known_unicode_multirow_converter_panic() {
        let root = temporary_directory("panic-containment");
        fs::create_dir_all(&root).expect("create panic fixture");
        fs::write(
            root.join("main.tex"),
            "\\documentclass{article}\n\\usepackage{multirow}\n\\begin{document}\n\\begin{tabular}{ll}\n\\multirow{2}{*}{Guc katı} & A \\\\\n+            & B \\\\\n+            \\end{tabular}\n\\end{document}",
        )
        .expect("write panic fixture");

        let result = convert_project_if_needed(&root);
        let report = result
            .expect("the Unicode guard should contain the upstream multirow panic")
            .expect("the guarded document should produce a report");
        assert!(root.join("main.tex").is_file());
        assert!(root.join("main.typ").is_file());
        assert!(
            fs::read_to_string(root.join("main.typ"))
                .unwrap()
                .contains("katı")
        );
        assert!(
            report
                .warnings
                .iter()
                .any(|warning| warning.kind == "unicode-table-guard")
        );
        fs::remove_dir_all(root).expect("remove panic fixture");
    }

    #[test]
    #[ignore = "requires UNDERTREE_LATEX_FIXTURE to name a disposable external project"]
    fn converts_external_latex_project_fixture_without_mutating_tex_sources() {
        let root = std::env::var_os("UNDERTREE_LATEX_FIXTURE")
            .map(PathBuf::from)
            .expect("set UNDERTREE_LATEX_FIXTURE to a disposable project clone");
        let root = canonical_directory(&root).expect("fixture project should be available");
        let originals = discover_tex_files(&root)
            .expect("discover fixture LaTeX")
            .into_iter()
            .map(|path| {
                let bytes = fs::read(&path).expect("read original fixture source");
                (path, bytes)
            })
            .collect::<Vec<_>>();

        let report = convert_project_if_needed(&root)
            .expect("external fixture conversion should be safely contained")
            .expect("the fixture should contain convertible LaTeX roots");
        for (path, bytes) in &originals {
            assert_eq!(
                fs::read(path).expect("re-read fixture source"),
                *bytes,
                "conversion changed original LaTeX at {}",
                path.display()
            );
        }
        assert!(
            !report.converted.is_empty() || !report.skipped.is_empty(),
            "the fixture should produce or safely skip Typst drafts"
        );

        let compile_succeeded = report.primary_typst.as_deref().is_some_and(|relative| {
            let source = fs::read_to_string(root.join(relative)).expect("read primary Typst draft");
            let parsed = typst::syntax::Source::detached(source.clone());
            let (syntax_errors, _) = parsed.root().errors_and_warnings();
            for diagnostic in syntax_errors.iter().take(20) {
                let range = match diagnostic.span.get() {
                    typst::syntax::DiagSpanKind::Number { num, sub_range, .. } => {
                        parsed.range(num, sub_range)
                    }
                    typst::syntax::DiagSpanKind::Range { range, .. } => Some(range),
                    typst::syntax::DiagSpanKind::Detached => None,
                };
                let line = range
                    .as_ref()
                    .map(|range| source[..range.start].lines().count())
                    .unwrap_or(0);
                println!(
                    "primary syntax diagnostic at line {line}: {}",
                    diagnostic.message
                );
            }
            match CompilerAssets::load().compile(
                CompileRequest {
                    source,
                    path: Some(relative.to_owned()),
                    revision: 1,
                },
                Some(root.clone()),
            ) {
                Ok(_) => true,
                Err(error) => {
                    for diagnostic in error.diagnostics.iter().take(20) {
                        println!("primary compile diagnostic: {}", diagnostic.message);
                    }
                    false
                }
            }
        });
        println!(
            "external fixture: {} LaTeX source(s), {} new draft(s), {} skipped, {} warning(s), primary compile succeeded: {compile_succeeded}",
            originals.len(),
            report.converted.len(),
            report.skipped.len(),
            report.warning_count,
        );
    }
}
