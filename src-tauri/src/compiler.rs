use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Instant;

use serde::{Deserialize, Serialize};
use typst::World;
use typst::diag::{FileError, FileResult, Severity, SourceDiagnostic, Warned};
use typst::foundations::{Bytes, Datetime};
use typst::syntax::{FileId, RootedPath, Source, VirtualPath, VirtualRoot};
use typst::text::{Font, FontBook};
use typst::utils::LazyHash;
use typst::{Library, LibraryExt, compile};
use typst_layout::PagedDocument;
use typst_svg::SvgOptions;

use crate::error::BoundaryError;

const MAX_SOURCE_BYTES: usize = 1024 * 1024;
const MAX_PAGES: usize = 128;
const MAX_PREVIEW_BYTES: usize = 32 * 1024 * 1024;

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
    pub pages: Vec<String>,
    pub warnings: Vec<Diagnostic>,
    pub elapsed_ms: u64,
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

        let mut total_bytes = 0usize;
        let mut pages = Vec::with_capacity(document.pages().len());
        for page in document.pages() {
            let svg = typst_svg::svg(page, &SvgOptions::default());
            total_bytes = total_bytes.saturating_add(svg.len());
            if total_bytes > MAX_PREVIEW_BYTES {
                return Err(BoundaryError::validation(
                    "The generated preview is larger than 32 MiB.",
                ));
            }
            pages.push(svg);
        }

        Ok(CompileResponse {
            revision: request.revision,
            pages,
            warnings: warnings.iter().map(Diagnostic::from).collect(),
            elapsed_ms: started.elapsed().as_millis().try_into().unwrap_or(u64::MAX),
        })
    }
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
}
