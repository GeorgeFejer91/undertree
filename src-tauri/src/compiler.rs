use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Instant;

use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64};
use hayro::hayro_interpret::InterpreterSettings;
use hayro::hayro_syntax::Pdf;
use hayro::vello_cpu::color::palette::css::WHITE;
use hayro::{RenderCache, RenderSettings, render};
use serde::{Deserialize, Serialize};
use typst::World;
use typst::diag::{FileError, FileResult, Severity, SourceDiagnostic, Warned};
use typst::foundations::{Bytes, Datetime};
use typst::layout::{Abs, Frame, FrameItem, Point, Transform};
use typst::syntax::{FileId, RootedPath, Source, VirtualPath, VirtualRoot};
use typst::text::{Font, FontBook, TextItem};
use typst::utils::LazyHash;
use typst::{Library, LibraryExt, compile};
use typst_layout::PagedDocument;

use crate::error::BoundaryError;

const MAX_SOURCE_BYTES: usize = 1024 * 1024;
const MAX_PAGES: usize = 128;
const MAX_PREVIEW_BYTES: usize = 48 * 1024 * 1024;
const PDF_PREVIEW_SCALE: f32 = 1.35;
const MAX_PDF_BYTES: usize = 64 * 1024 * 1024;
const MAX_PREVIEW_TEXT_RUNS: usize = 100_000;
const MAX_PREVIEW_TEXT_BYTES: usize = 4 * 1024 * 1024;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompileRequest {
    pub source: String,
    pub path: Option<String>,
    pub revision: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CompileResponse {
    pub revision: u64,
    pub preview_format: &'static str,
    pub pages: Vec<String>,
    pub text_pages: Vec<PreviewTextPage>,
    pub warnings: Vec<Diagnostic>,
    pub elapsed_ms: u64,
}

pub(crate) struct PdfCompileOutput {
    pub revision: u64,
    pub pages: usize,
    pub bytes: Vec<u8>,
    pub warnings: Vec<Diagnostic>,
    pub elapsed_ms: u64,
}

/// A bounded selectable-text companion for one SVG preview page. Coordinates
/// use Typst points so the WebView can scale them with the page image.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewTextPage {
    pub width: f64,
    pub height: f64,
    pub runs: Vec<PreviewTextRun>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewTextRun {
    pub text: String,
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    pub source_path: Option<String>,
    pub source_start_byte: Option<usize>,
    pub source_end_byte: Option<usize>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Diagnostic {
    pub severity: &'static str,
    pub message: String,
    pub hints: Vec<String>,
}

#[derive(Clone)]
pub struct CompilerAssets {
    library: Arc<LazyHash<Library>>,
    book: Arc<LazyHash<FontBook>>,
    fonts: Arc<Vec<Font>>,
}

impl CompilerAssets {
    pub fn load() -> Self {
        let embedded: Vec<_> = typst_kit::fonts::embedded().collect();
        let book = FontBook::from_infos(embedded.iter().map(|(_, info)| info.clone()));
        let fonts = embedded.into_iter().map(|(font, _)| font).collect();

        Self {
            library: Arc::new(LazyHash::new(Library::builder().build())),
            book: Arc::new(LazyHash::new(book)),
            fonts: Arc::new(fonts),
        }
    }

    pub fn compile(
        &self,
        request: CompileRequest,
        project_root: Option<PathBuf>,
    ) -> Result<CompileResponse, BoundaryError> {
        validate_source(&request.source)?;

        let started = Instant::now();
        let source_path = request.path.clone();
        let world = DocumentWorld::new(self, request.source, project_root, request.path)?;
        let Warned { output, warnings } = compile::<PagedDocument>(&world);
        let document = output.map_err(|errors| {
            BoundaryError::compilation(errors.iter().map(Diagnostic::from).collect())
        })?;

        if document.pages().len() > MAX_PAGES {
            return Err(BoundaryError::validation(format!(
                "The preview is limited to {MAX_PAGES} pages."
            )));
        }

        let pdf_bytes = typst_pdf::pdf(&document, &typst_pdf::PdfOptions::default())
            .map_err(|errors| {
                BoundaryError::compilation(errors.iter().map(Diagnostic::from).collect())
            })?;
        if pdf_bytes.len() > MAX_PDF_BYTES {
            return Err(BoundaryError::validation(
                "The generated PDF is larger than 64 MiB.",
            ));
        }
        let pages = render_pdf_preview(&pdf_bytes)?;

        let mut text_pages = Vec::with_capacity(document.pages().len());
        let mut total_text_runs = 0usize;
        let mut total_text_bytes = 0usize;
        for page in document.pages() {
            let text_page = preview_text_page(
                &page.frame,
                &world.source,
                source_path.as_deref(),
            );
            total_text_runs = total_text_runs.saturating_add(text_page.runs.len());
            total_text_bytes = total_text_bytes.saturating_add(
                text_page
                    .runs
                    .iter()
                    .map(|run| run.text.len())
                    .sum::<usize>(),
            );
            if total_text_runs > MAX_PREVIEW_TEXT_RUNS || total_text_bytes > MAX_PREVIEW_TEXT_BYTES
            {
                return Err(BoundaryError::validation(
                    "The selectable preview text layer exceeds its safety limit.",
                ));
            }
            text_pages.push(text_page);
        }

        Ok(CompileResponse {
            revision: request.revision,
            preview_format: "pdf-raster",
            pages,
            text_pages,
            warnings: warnings.iter().map(Diagnostic::from).collect(),
            elapsed_ms: started.elapsed().as_millis().try_into().unwrap_or(u64::MAX),
        })
    }

    pub(crate) fn compile_pdf(
        &self,
        request: CompileRequest,
        project_root: Option<PathBuf>,
    ) -> Result<PdfCompileOutput, BoundaryError> {
        validate_source(&request.source)?;
        let started = Instant::now();
        let world = DocumentWorld::new(self, request.source, project_root, request.path)?;
        let Warned { output, warnings } = compile::<PagedDocument>(&world);
        let document = output.map_err(|errors| {
            BoundaryError::compilation(errors.iter().map(Diagnostic::from).collect())
        })?;
        let pages = document.pages().len();
        if pages > MAX_PAGES {
            return Err(BoundaryError::validation(format!(
                "PDF export is limited to {MAX_PAGES} pages."
            )));
        }
        let bytes =
            typst_pdf::pdf(&document, &typst_pdf::PdfOptions::default()).map_err(|errors| {
                BoundaryError::compilation(errors.iter().map(Diagnostic::from).collect())
            })?;
        if bytes.len() > MAX_PDF_BYTES {
            return Err(BoundaryError::validation(
                "The generated PDF is larger than 64 MiB.",
            ));
        }
        Ok(PdfCompileOutput {
            revision: request.revision,
            pages,
            bytes,
            warnings: warnings.iter().map(Diagnostic::from).collect(),
            elapsed_ms: started.elapsed().as_millis().try_into().unwrap_or(u64::MAX),
        })
    }
}
fn render_pdf_preview(bytes: &[u8]) -> Result<Vec<String>, BoundaryError> {
    let pdf = Pdf::new(bytes.to_vec()).ok_or_else(|| {
        BoundaryError::validation("UnderTree could not reopen its generated PDF for preview.")
    })?;
    let cache = RenderCache::new();
    let interpreter = InterpreterSettings::default();
    let settings = RenderSettings {
        x_scale: PDF_PREVIEW_SCALE,
        y_scale: PDF_PREVIEW_SCALE,
        bg_color: WHITE,
        ..Default::default()
    };
    let mut total = 0usize;
    let mut pages = Vec::with_capacity(pdf.pages().len());
    for page in pdf.pages() {
        let png = render(page, &cache, &interpreter, &settings)
            .into_png()
            .map_err(|_| BoundaryError::validation("The generated PDF page could not be rendered."))?;
        total = total.saturating_add(png.len());
        if total > MAX_PREVIEW_BYTES {
            return Err(BoundaryError::validation(
                "The generated PDF preview is larger than 48 MiB.",
            ));
        }
        pages.push(format!("data:image/png;base64,{}", BASE64.encode(png)));
    }
    Ok(pages)
}

fn preview_text_page(
    frame: &Frame,
    source: &Source,
    source_path: Option<&str>,
) -> PreviewTextPage {
    let mut runs = Vec::new();
    collect_preview_text(
        frame,
        Transform::identity(),
        source,
        source_path,
        &mut runs,
    );
    runs.sort_by(|left, right| {
        left.y
            .total_cmp(&right.y)
            .then_with(|| left.x.total_cmp(&right.x))
    });
    PreviewTextPage {
        width: frame.width().to_pt(),
        height: frame.height().to_pt(),
        runs,
    }
}

fn collect_preview_text(
    frame: &Frame,
    transform: Transform,
    source: &Source,
    source_path: Option<&str>,
    output: &mut Vec<PreviewTextRun>,
) {
    for (position, item) in frame.items() {
        match item {
            FrameItem::Text(text) if !text.text.is_empty() => {
                let font_size = text.size.to_pt().max(1.0);
                let width = text.width().to_pt().max(font_size * 0.25);
                let local_min = Point::new(position.x, position.y - Abs::pt(font_size * 0.9));
                let local_max = Point::new(
                    position.x + Abs::pt(width),
                    position.y + Abs::pt(font_size * 0.3),
                );
                let corners = [
                    local_min,
                    Point::new(local_max.x, local_min.y),
                    Point::new(local_min.x, local_max.y),
                    local_max,
                ]
                .map(|point| point.transform(transform));
                let min_x = corners
                    .iter()
                    .map(|point| point.x.to_pt())
                    .fold(f64::INFINITY, f64::min);
                let min_y = corners
                    .iter()
                    .map(|point| point.y.to_pt())
                    .fold(f64::INFINITY, f64::min);
                let max_x = corners
                    .iter()
                    .map(|point| point.x.to_pt())
                    .fold(f64::NEG_INFINITY, f64::max);
                let max_y = corners
                    .iter()
                    .map(|point| point.y.to_pt())
                    .fold(f64::NEG_INFINITY, f64::max);
                if min_x.is_finite() && min_y.is_finite() && max_x > min_x && max_y > min_y {
                    let mapped = text_item_source_range(text, source);
                    output.push(PreviewTextRun {
                        text: text.text.to_string(),
                        x: min_x,
                        y: min_y,
                        width: max_x - min_x,
                        height: max_y - min_y,
                        source_path: mapped.and(source_path).map(str::to_owned),
                        source_start_byte: mapped.map(|range| range.0),
                        source_end_byte: mapped.map(|range| range.1),
                    });
                }
            }
            FrameItem::Group(group) => {
                let local =
                    Transform::translate(position.x, position.y).pre_concat(group.transform);
                collect_preview_text(
                    &group.frame,
                    transform.pre_concat(local),
                    source,
                    source_path,
                    output,
                );
            }
            _ => {}
        }
    }
}

fn text_item_source_range(text: &TextItem, source: &Source) -> Option<(usize, usize)> {
    let mut first = None;
    let mut end = 0usize;
    for glyph in &text.glyphs {
        let glyph_text = text.text.as_str().get(glyph.range())?;
        if glyph_text.is_empty() {
            continue;
        }
        let (span, span_offset) = glyph.span;
        if span.id() != Some(source.id()) {
            return None;
        }
        let node = source.find(span)?;
        let start = node.range().start.checked_add(span_offset as usize)?;
        let stop = start.checked_add(glyph_text.len())?;
        if source.text().get(start..stop)? != glyph_text {
            return None;
        }
        if first.is_none() {
            first = Some(start);
        }
        end = stop.max(end);
    }
    let start = first?;
    let source_text = source.text().get(start..end)?;
    if normalize_preview_text(source_text) != normalize_preview_text(text.text.as_str()) {
        return None;
    }
    Some((start, end))
}

fn normalize_preview_text(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn validate_source(source: &str) -> Result<(), BoundaryError> {
    if source.len() > MAX_SOURCE_BYTES {
        return Err(BoundaryError::validation(
            "The in-memory source is limited to 1 MiB.",
        ));
    }
    if source.contains('\0') {
        return Err(BoundaryError::validation(
            "Typst source cannot contain a null character.",
        ));
    }
    Ok(())
}

impl From<&SourceDiagnostic> for Diagnostic {
    fn from(value: &SourceDiagnostic) -> Self {
        Self {
            severity: match value.severity {
                Severity::Error => "error",
                Severity::Warning => "warning",
            },
            message: value.message.to_string(),
            hints: value.hints.iter().map(|hint| hint.v.to_string()).collect(),
        }
    }
}

struct DocumentWorld {
    library: Arc<LazyHash<Library>>,
    book: Arc<LazyHash<FontBook>>,
    fonts: Arc<Vec<Font>>,
    source: Source,
    bytes: Bytes,
    root: Option<PathBuf>,
    files: Mutex<HashMap<FileId, CachedFile>>,
    time: typst_kit::datetime::Time,
}

impl DocumentWorld {
    fn new(
        assets: &CompilerAssets,
        text: String,
        root: Option<PathBuf>,
        relative: Option<String>,
    ) -> Result<Self, BoundaryError> {
        let bytes = Bytes::from_string(text.clone());
        let source = match (&root, relative) {
            (Some(_), Some(relative)) => {
                let vpath = VirtualPath::new(&relative).map_err(|_| {
                    BoundaryError::project(
                        "path_denied",
                        "The compiled document path must remain inside the selected project.",
                    )
                })?;
                let id = FileId::new(RootedPath::new(VirtualRoot::Project, vpath));
                Source::new(id, text)
            }
            (None, None) => Source::detached(text),
            _ => {
                return Err(BoundaryError::project(
                    "project_required",
                    "Choose a project before compiling a project document.",
                ));
            }
        };

        Ok(Self {
            library: Arc::clone(&assets.library),
            book: Arc::clone(&assets.book),
            fonts: Arc::clone(&assets.fonts),
            source,
            bytes,
            root,
            files: Mutex::new(HashMap::new()),
            time: typst_kit::datetime::Time::system(),
        })
    }

    fn load(&self, id: FileId) -> FileResult<CachedFile> {
        if id == self.source.id() {
            return Ok(CachedFile {
                bytes: self.bytes.clone(),
                source: Some(self.source.clone()),
            });
        }

        if let Some(cached) = self
            .files
            .lock()
            .map_err(|_| FileError::Other(Some("file cache unavailable".into())))?
            .get(&id)
            .cloned()
        {
            return Ok(cached);
        }

        if id.root() != &VirtualRoot::Project {
            return Err(FileError::AccessDenied);
        }
        let root = self.root.as_ref().ok_or(FileError::AccessDenied)?;
        let realized = id.vpath().realize(root).map_err(FileError::Realize)?;
        let canonical = realized
            .canonicalize()
            .map_err(|error| FileError::from_io(error, &realized))?;
        if !canonical.starts_with(root) || !canonical.is_file() {
            return Err(FileError::AccessDenied);
        }

        let metadata = canonical
            .metadata()
            .map_err(|error| FileError::from_io(error, &canonical))?;
        if metadata.len() > 16 * 1024 * 1024 {
            return Err(FileError::Other(Some(
                "project asset exceeds 16 MiB".into(),
            )));
        }

        let data = fs::read(&canonical).map_err(|error| FileError::from_io(error, &canonical))?;
        let bytes = Bytes::new(data);
        let source = if id.vpath().extension() == Some("typ") {
            let text = bytes.as_str().map_err(|_| FileError::InvalidUtf8)?;
            Some(Source::new(id, text.to_owned()))
        } else {
            None
        };
        let loaded = CachedFile { bytes, source };
        self.files
            .lock()
            .map_err(|_| FileError::Other(Some("file cache unavailable".into())))?
            .insert(id, loaded.clone());
        Ok(loaded)
    }
}

#[derive(Clone)]
struct CachedFile {
    bytes: Bytes,
    source: Option<Source>,
}

impl World for DocumentWorld {
    fn library(&self) -> &LazyHash<Library> {
        &self.library
    }

    fn book(&self) -> &LazyHash<FontBook> {
        &self.book
    }

    fn main(&self) -> FileId {
        self.source.id()
    }

    fn source(&self, id: FileId) -> FileResult<Source> {
        self.load(id)?.source.ok_or(FileError::NotSource)
    }

    fn file(&self, id: FileId) -> FileResult<Bytes> {
        Ok(self.load(id)?.bytes)
    }

    fn font(&self, index: usize) -> Option<Font> {
        self.fonts.get(index).cloned()
    }

    fn today(&self, offset: Option<typst::foundations::Duration>) -> Option<Datetime> {
        self.time.today(offset)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temporary_project(label: &str) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system clock should follow Unix epoch")
            .as_nanos();
        std::env::temp_dir().join(format!(
            "undertree-compiler-{label}-{}-{nonce}",
            std::process::id()
        ))
    }

    #[test]
    fn compiles_a_typst_document_to_svg() {
        let result = CompilerAssets::load()
            .compile(
                CompileRequest {
                    source: "= UnderTree\n\nHello from *Typst*.".into(),
                    path: None,
                    revision: 7,
                },
                None,
            )
            .expect("valid Typst source should compile");

        assert_eq!(result.revision, 7);
        assert_eq!(result.pages.len(), 1);
        assert!(result.pages[0].starts_with("<svg"));
        assert_eq!(result.text_pages.len(), 1);
        assert!(result.text_pages[0].width > 0.0);
        assert!(result.text_pages[0].height > 0.0);
        assert!(
            result.text_pages[0]
                .runs
                .iter()
                .any(|run| run.text.contains("UnderTree"))
        );
    }

    #[test]
    fn rejects_invalid_typst_source_with_safe_diagnostics() {
        let error = CompilerAssets::load()
            .compile(
                CompileRequest {
                    source: "#let broken =".into(),
                    path: None,
                    revision: 1,
                },
                None,
            )
            .expect_err("invalid Typst source should fail");

        assert_eq!(error.code, "compile_failed");
        assert!(!error.diagnostics.is_empty());
    }

    #[test]
    fn rejects_oversized_source_before_compilation() {
        let error = CompilerAssets::load()
            .compile(
                CompileRequest {
                    source: "x".repeat(MAX_SOURCE_BYTES + 1),
                    path: None,
                    revision: 1,
                },
                None,
            )
            .expect_err("oversized source should fail validation");

        assert_eq!(error.code, "invalid_source");
    }

    #[test]
    fn compiles_a_typst_document_to_bounded_pdf_bytes() {
        let result = CompilerAssets::load()
            .compile_pdf(
                CompileRequest {
                    source: "= UnderTree\n\nPortable PDF export.".into(),
                    path: None,
                    revision: 11,
                },
                None,
            )
            .expect("valid Typst source should export to PDF");

        assert_eq!(result.revision, 11);
        assert_eq!(result.pages, 1);
        assert!(result.bytes.starts_with(b"%PDF-"));
        assert!(result.bytes.len() <= MAX_PDF_BYTES);
    }

    #[test]
    fn compiles_a_project_document_with_a_bibtex_bibliography() {
        let root = temporary_project("bibtex");
        fs::create_dir_all(&root).expect("test project should be created");
        fs::write(
            root.join("references.bib"),
            "@article{under-tree, author={Oak, Ada}, title={Under the Tree}, journal={Forest Studies}, year={2026}}",
        )
        .expect("bibliography should be written");
        let root = root
            .canonicalize()
            .expect("test project should be canonicalized");

        let result = CompilerAssets::load()
            .compile(
                CompileRequest {
                    source: "UnderTree supports citations @under-tree.\n\n#bibliography(\"references.bib\")".into(),
                    path: Some("main.typ".into()),
                    revision: 8,
                },
                Some(root.clone()),
            )
            .expect("BibTeX bibliography should compile");

        assert_eq!(result.revision, 8);
        assert_eq!(result.pages.len(), 1);
        fs::remove_dir_all(root).expect("test project should be removed");
    }

    #[test]
    #[ignore = "requires UNDERTREE_TYPST_SOURCE and UNDERTREE_TYPST_PDF_OUTPUT"]
    fn renders_external_typst_document_to_pdf_for_fidelity_review() {
        let source_path = PathBuf::from(
            std::env::var("UNDERTREE_TYPST_SOURCE")
                .expect("set UNDERTREE_TYPST_SOURCE to a generated .typ document"),
        );
        let output_path = PathBuf::from(
            std::env::var("UNDERTREE_TYPST_PDF_OUTPUT")
                .expect("set UNDERTREE_TYPST_PDF_OUTPUT to the QA PDF path"),
        );
        let project_root = std::env::var("UNDERTREE_TYPST_PROJECT_ROOT")
            .map(PathBuf::from)
            .unwrap_or_else(|_| {
                source_path
                    .parent()
                    .expect("source should have a parent")
                    .to_path_buf()
            })
            .canonicalize()
            .expect("project root should be available");
        let source_path = source_path
            .canonicalize()
            .expect("Typst source should be available");
        assert!(source_path.starts_with(&project_root));
        let relative = source_path
            .strip_prefix(&project_root)
            .expect("source should be within project root")
            .to_string_lossy()
            .replace('\\', "/");
        let source = fs::read_to_string(&source_path).expect("Typst source should be UTF-8");
        let pdf = CompilerAssets::load()
            .compile_pdf(
                CompileRequest {
                    source,
                    path: Some(relative),
                    revision: 0,
                },
                Some(project_root),
            )
            .unwrap_or_else(|error| {
                panic!(
                    "Typst PDF generation failed: {} ({:?})",
                    error.message, error.diagnostics
                )
            });
        fs::write(&output_path, pdf.bytes).expect("QA PDF should be written");
        println!("Typst QA PDF: {}", output_path.display());
    }
}
