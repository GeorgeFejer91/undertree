use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, RwLock};

use atomic_write_file::AtomicWriteFile;
use serde::{Deserialize, Serialize};

use crate::compiler::{CompileRequest, CompilerAssets, Diagnostic, PdfCompileOutput};
use crate::error::BoundaryError;

#[derive(Clone, Default)]
pub struct PdfExportState {
    last_export: Arc<RwLock<Option<ExportedPdf>>>,
}

#[derive(Clone)]
struct ExportedPdf {
    path: PathBuf,
    document_path: Option<String>,
    revision: u64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RevealPdfRequest {
    pub document_path: Option<String>,
    pub revision: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PdfExportResult {
    pub revision: u64,
    pub file_name: String,
    pub pages: usize,
    pub warnings: Vec<Diagnostic>,
    pub elapsed_ms: u64,
}

pub(crate) struct SavedPdf {
    pub path: PathBuf,
    pub result: PdfExportResult,
}

impl PdfExportState {
    pub fn remember(
        &self,
        path: PathBuf,
        document_path: Option<String>,
        revision: u64,
    ) -> Result<(), BoundaryError> {
        let mut last_export = self
            .last_export
            .write()
            .map_err(|_| BoundaryError::internal())?;
        *last_export = Some(ExportedPdf {
            path,
            document_path,
            revision,
        });
        Ok(())
    }

    pub fn current_path(&self, request: &RevealPdfRequest) -> Result<PathBuf, BoundaryError> {
        let last_export = self
            .last_export
            .read()
            .map_err(|_| BoundaryError::internal())?;
        let exported = last_export.as_ref().ok_or_else(pdf_location_missing)?;
        if exported.document_path != request.document_path || exported.revision != request.revision
        {
            return Err(pdf_location_missing());
        }
        validate_reveal_path(&exported.path)?;
        Ok(exported.path.clone())
    }
}

impl PdfExportResult {
    pub fn from_compiled(compiled: PdfCompileOutput, file_name: String) -> Self {
        Self {
            revision: compiled.revision,
            file_name,
            pages: compiled.pages,
            warnings: compiled.warnings,
            elapsed_ms: compiled.elapsed_ms,
        }
    }
}

pub(crate) fn export_document(
    compiler: &CompilerAssets,
    request: CompileRequest,
    project_root: Option<PathBuf>,
    destination: PathBuf,
    overwrite: bool,
) -> Result<SavedPdf, BoundaryError> {
    let destination = prepare_destination(destination, overwrite)?;
    let compiled = compiler.compile_pdf(request, project_root)?;
    let (path, file_name) = if overwrite {
        write_pdf(destination, &compiled.bytes)?
    } else {
        write_pdf_noclobber(destination, &compiled.bytes)?
    };
    Ok(SavedPdf {
        path,
        result: PdfExportResult::from_compiled(compiled, file_name),
    })
}

fn prepare_destination(destination: PathBuf, overwrite: bool) -> Result<PathBuf, BoundaryError> {
    let destination = normalize_destination(destination)?;
    if let Ok(metadata) = fs::symlink_metadata(&destination) {
        if !metadata.is_file() || metadata.file_type().is_symlink() {
            return Err(BoundaryError::project(
                "pdf_destination_invalid",
                "Choose a regular PDF file rather than a folder or symbolic link.",
            ));
        }
        if !overwrite {
            return Err(BoundaryError::project(
                "pdf_destination_exists",
                "The PDF destination already exists. Pass --force to replace it.",
            ));
        }
    }
    Ok(destination)
}

pub fn suggested_file_name(document_path: Option<&str>) -> String {
    let stem = document_path
        .and_then(|path| Path::new(path).file_stem())
        .and_then(|stem| stem.to_str())
        .filter(|stem| !stem.trim().is_empty())
        .unwrap_or("undertree-document");
    format!("{stem}.pdf")
}

pub fn write_pdf(destination: PathBuf, bytes: &[u8]) -> Result<(PathBuf, String), BoundaryError> {
    validate_pdf_bytes(bytes)?;

    let destination = normalize_destination(destination)?;
    if let Ok(metadata) = fs::symlink_metadata(&destination)
        && (!metadata.is_file() || metadata.file_type().is_symlink())
    {
        return Err(BoundaryError::project(
            "pdf_destination_invalid",
            "Choose a regular PDF file rather than a folder or symbolic link.",
        ));
    }

    let mut output = AtomicWriteFile::open(&destination).map_err(|_| pdf_write_failed())?;
    output.write_all(bytes).map_err(|_| pdf_write_failed())?;
    output.sync_all().map_err(|_| pdf_write_failed())?;
    output.commit().map_err(|_| pdf_write_failed())?;

    let path = destination.canonicalize().map_err(|_| pdf_write_failed())?;
    let file_name = path
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .ok_or_else(pdf_write_failed)?;
    Ok((path, file_name))
}

fn write_pdf_noclobber(
    destination: PathBuf,
    bytes: &[u8],
) -> Result<(PathBuf, String), BoundaryError> {
    validate_pdf_bytes(bytes)?;
    let destination = normalize_destination(destination)?;
    let parent = destination.parent().ok_or_else(pdf_write_failed)?;
    let mut output = tempfile::NamedTempFile::new_in(parent).map_err(|_| pdf_write_failed())?;
    output.write_all(bytes).map_err(|_| pdf_write_failed())?;
    output
        .as_file()
        .sync_all()
        .map_err(|_| pdf_write_failed())?;
    let persisted = output.persist_noclobber(&destination).map_err(|error| {
        if error.error.kind() == std::io::ErrorKind::AlreadyExists {
            BoundaryError::project(
                "pdf_destination_exists",
                "The PDF destination already exists. Pass --force to replace it.",
            )
        } else {
            pdf_write_failed()
        }
    })?;
    persisted.sync_all().map_err(|_| pdf_write_failed())?;
    let path = destination.canonicalize().map_err(|_| pdf_write_failed())?;
    let file_name = path
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .ok_or_else(pdf_write_failed)?;
    Ok((path, file_name))
}

fn validate_pdf_bytes(bytes: &[u8]) -> Result<(), BoundaryError> {
    if bytes.len() < 5 || !bytes.starts_with(b"%PDF-") {
        return Err(BoundaryError::project(
            "pdf_invalid_output",
            "UnderTree did not produce a valid PDF document.",
        ));
    }
    Ok(())
}

fn normalize_destination(destination: PathBuf) -> Result<PathBuf, BoundaryError> {
    if !destination.is_absolute() || destination.file_name().is_none() {
        return Err(BoundaryError::project(
            "pdf_destination_invalid",
            "Choose a local file location for the PDF.",
        ));
    }
    if !destination
        .extension()
        .is_some_and(|extension| extension.eq_ignore_ascii_case("pdf"))
    {
        return Err(BoundaryError::project(
            "pdf_destination_invalid",
            "The PDF destination must end in .pdf.",
        ));
    }

    let file_name = destination
        .file_name()
        .ok_or_else(|| {
            BoundaryError::project(
                "pdf_destination_invalid",
                "Choose a local file location for the PDF.",
            )
        })?
        .to_owned();
    let parent = destination.parent().ok_or_else(|| {
        BoundaryError::project(
            "pdf_destination_invalid",
            "Choose a local file location for the PDF.",
        )
    })?;
    let parent = parent.canonicalize().map_err(|_| {
        BoundaryError::project(
            "pdf_destination_invalid",
            "The selected PDF folder is no longer available.",
        )
    })?;
    if !parent.is_dir() {
        return Err(BoundaryError::project(
            "pdf_destination_invalid",
            "Choose an existing local folder for the PDF.",
        ));
    }
    Ok(parent.join(file_name))
}

fn validate_reveal_path(path: &Path) -> Result<(), BoundaryError> {
    let metadata = fs::symlink_metadata(path).map_err(|_| pdf_location_missing())?;
    if !metadata.is_file()
        || metadata.file_type().is_symlink()
        || !path
            .extension()
            .is_some_and(|extension| extension.eq_ignore_ascii_case("pdf"))
    {
        return Err(pdf_location_missing());
    }
    let mut file = fs::File::open(path).map_err(|_| pdf_location_missing())?;
    let mut header = [0u8; 5];
    file.read_exact(&mut header)
        .map_err(|_| pdf_location_missing())?;
    if &header != b"%PDF-" {
        return Err(pdf_location_missing());
    }
    Ok(())
}

#[cfg(desktop)]
pub(crate) fn reveal_pdf(path: PathBuf) -> Result<(), BoundaryError> {
    validate_reveal_path(&path)?;
    tauri_plugin_opener::reveal_item_in_dir(path).map_err(|_| {
        BoundaryError::project(
            "pdf_reveal_failed",
            "UnderTree could not show the exported PDF in the system file browser.",
        )
    })
}

#[cfg(mobile)]
pub(crate) fn reveal_pdf(_path: PathBuf) -> Result<(), BoundaryError> {
    Err(BoundaryError::project(
        "unsupported_platform",
        "Showing a PDF in its folder is currently available on desktop.",
    ))
}

fn pdf_location_missing() -> BoundaryError {
    BoundaryError::project(
        "pdf_export_missing",
        "The last exported PDF is no longer available. Export it again to choose a new location.",
    )
}

fn pdf_write_failed() -> BoundaryError {
    BoundaryError::project(
        "pdf_save_failed",
        "UnderTree could not save the PDF at the selected location.",
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn suggests_a_pdf_name_for_project_and_scratch_documents() {
        assert_eq!(
            suggested_file_name(Some("chapters/results.typ")),
            "results.pdf"
        );
        assert_eq!(suggested_file_name(None), "undertree-document.pdf");
    }

    #[test]
    fn writes_pdf_bytes_atomically() {
        let directory = tempfile::tempdir().expect("temporary directory should be available");
        let selected = directory.path().join("paper.pdf");
        let (path, file_name) =
            write_pdf(selected, b"%PDF-1.7\nUnderTree").expect("PDF should be written");

        assert_eq!(file_name, "paper.pdf");
        assert_eq!(
            fs::read(path).expect("PDF should be readable"),
            b"%PDF-1.7\nUnderTree"
        );
    }

    #[test]
    fn rejects_a_destination_that_would_be_silently_retargeted() {
        let directory = tempfile::tempdir().expect("temporary directory should be available");
        let error = write_pdf(directory.path().join("paper.txt"), b"%PDF-1.7\nUnderTree")
            .expect_err("a non-PDF destination must not be renamed behind the caller's back");
        assert_eq!(error.code, "pdf_destination_invalid");
        assert!(!directory.path().join("paper.pdf").exists());
    }

    #[test]
    fn export_preflight_requires_explicit_overwrite() {
        let directory = tempfile::tempdir().expect("temporary directory should be available");
        let destination = directory.path().join("paper.pdf");
        fs::write(&destination, b"%PDF-1.7\nexisting").expect("fixture should be writable");

        let error = prepare_destination(destination.clone(), false)
            .expect_err("an existing artifact requires explicit overwrite authority");
        assert_eq!(error.code, "pdf_destination_exists");
        assert!(prepare_destination(destination, true).is_ok());
    }

    #[test]
    fn no_clobber_commit_preserves_an_existing_artifact() {
        let directory = tempfile::tempdir().expect("temporary directory should be available");
        let destination = directory.path().join("paper.pdf");
        fs::write(&destination, b"%PDF-1.7\nexisting").expect("fixture should be writable");

        let error = write_pdf_noclobber(destination.clone(), b"%PDF-1.7\nreplacement")
            .expect_err("no-clobber mode must fail at commit");
        assert_eq!(error.code, "pdf_destination_exists");
        assert_eq!(
            fs::read(destination).expect("existing PDF should remain readable"),
            b"%PDF-1.7\nexisting"
        );
    }

    #[test]
    fn reveal_state_is_scoped_to_the_exported_document_revision() {
        let directory = tempfile::tempdir().expect("temporary directory should be available");
        let (path, _) = write_pdf(directory.path().join("paper.pdf"), b"%PDF-1.7\nUnderTree")
            .expect("PDF should be written");
        let state = PdfExportState::default();
        state
            .remember(path, Some("main.typ".into()), 7)
            .expect("state should be writable");

        assert!(
            state
                .current_path(&RevealPdfRequest {
                    document_path: Some("main.typ".into()),
                    revision: 7,
                })
                .is_ok()
        );
        let error = state
            .current_path(&RevealPdfRequest {
                document_path: Some("main.typ".into()),
                revision: 8,
            })
            .expect_err("a newer editor revision must not reuse the old location");
        assert_eq!(error.code, "pdf_export_missing");
    }
}
