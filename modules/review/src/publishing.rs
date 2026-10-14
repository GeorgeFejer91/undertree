use crate::document::{digest, MAX_TEXT};
use crate::service::{atomic_write, Service};
use crate::{Error, Result};
use base64::Engine;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use tokio::io::AsyncReadExt;

const MAX_PDF: usize = 16 * 1024 * 1024;
const MAX_DIAGNOSTICS: usize = 64 * 1024;

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Preview {
    revision: String,
    #[serde(default)]
    pdf: String,
}

fn read_limited(path: &Path, maximum: usize) -> Result<Vec<u8>> {
    if !std::fs::symlink_metadata(path)?.is_file() {
        return Err(Error::new(
            "path",
            "Only regular source and preview files can be read.",
        ));
    }
    let mut bytes = Vec::new();
    std::fs::File::open(path)?
        .take(maximum as u64 + 1)
        .read_to_end(&mut bytes)?;
    if bytes.len() > maximum {
        return Err(Error::new(
            "limit",
            "The source or preview exceeds its supported size limit.",
        ));
    }
    Ok(bytes)
}

impl Service {
    fn pdf_paths(&self, project: &str, path: &str) -> Result<(PathBuf, PathBuf)> {
        let project_info = self.project(project)?;
        self.path(&project_info, path, false)?;
        let root = self.publishing_root().join("pdfs");
        std::fs::create_dir_all(&root)?;
        let id = digest(&format!("{project}:{path}"));
        Ok((
            root.join(format!("{id}.pdf")),
            root.join(format!("{id}.json")),
        ))
    }

    pub fn preview_pdf(&self, project: &str, path: &str) -> Result<Value> {
        let (legacy_pdf, info) = self.pdf_paths(project, path)?;
        if !info.exists() {
            return Ok(json!({"available":false}));
        }
        for _ in 0..2 {
            let metadata: Preview = serde_json::from_slice(&read_limited(&info, 1024)?)?;
            let expected = format!(
                "{}-{}.pdf",
                legacy_pdf.file_stem().unwrap_or_default().to_string_lossy(),
                metadata.revision
            );
            if metadata.revision.len() != 64
                || !metadata.revision.bytes().all(|b| b.is_ascii_hexdigit())
                || (!metadata.pdf.is_empty() && metadata.pdf != expected)
            {
                return Err(Error::new(
                    "format",
                    "The saved PDF preview metadata is invalid. Compile again to recover.",
                ));
            }
            let pdf = if metadata.pdf.is_empty() {
                legacy_pdf.clone()
            } else {
                legacy_pdf.with_file_name(&metadata.pdf)
            };
            // A completed build may replace the pointer between these two reads.
            if !pdf.exists() {
                continue;
            }
            let bytes = read_limited(&pdf, MAX_PDF)?;
            let project_info = self.project(project)?;
            let source = read_limited(&self.path(&project_info, path, false)?, MAX_TEXT)?;
            let text = std::str::from_utf8(&source)
                .map_err(|_| Error::new("source", "The manuscript is not valid UTF-8 text."))?;
            return Ok(
                json!({"available":true,"base64":base64::engine::general_purpose::STANDARD.encode(bytes),"revision":metadata.revision,"current":metadata.revision == digest(text)}),
            );
        }
        Ok(json!({"available":false}))
    }

    pub async fn compile_typst(&self, project: &str, path: &str, revision: &str) -> Result<Value> {
        let _compile = self.compile_lock.try_lock().map_err(|_| {
            Error::new(
                "busy",
                "A Typst compilation is already running; editing remains available.",
            )
        })?;
        let project_info = self.project(project)?;
        let source = self.path(&project_info, path, false)?;
        if source.extension().and_then(|s| s.to_str()) != Some("typ") {
            return Err(Error::new("source", "Choose a Typst source to compile."));
        }
        let bytes = read_limited(&source, MAX_TEXT)?;
        let text = std::str::from_utf8(&bytes)
            .map_err(|_| Error::new("source", "The manuscript is not valid UTF-8 text."))?;
        if digest(text) != revision {
            return Err(Error::new(
                "stale",
                "Save the current source before compiling.",
            ));
        }
        let parent = source
            .parent()
            .ok_or_else(|| Error::new("path", "The source has no project directory."))?;
        // A sibling snapshot preserves relative imports and compiles exactly the saved revision.
        let mut snapshot = tempfile::Builder::new()
            .prefix(".undertree-compile-")
            .suffix(".typ")
            .tempfile_in(parent)?;
        snapshot.write_all(&bytes)?;
        snapshot.flush()?;
        let (legacy_pdf, info) = self.pdf_paths(project, path)?;
        let temporary = tempfile::NamedTempFile::new_in(self.publishing_root())?;
        let executable = std::env::var_os("UNDERTREE_TYPST").unwrap_or_else(|| "typst".into());
        let mut child = tokio::process::Command::new(executable)
            .arg("compile").arg("--root").arg(&project_info.root).arg(snapshot.path()).arg(temporary.path()).arg("--format").arg("pdf")
            // Typst 0.15's downloader respects these variables; port zero refuses downloads.
            .envs([("HTTP_PROXY", "http://127.0.0.1:0"), ("HTTPS_PROXY", "http://127.0.0.1:0"), ("ALL_PROXY", "http://127.0.0.1:0"),
                ("http_proxy", "http://127.0.0.1:0"), ("https_proxy", "http://127.0.0.1:0"), ("all_proxy", "http://127.0.0.1:0"), ("NO_PROXY", ""), ("no_proxy", "")])
            .current_dir(&project_info.root).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::piped()).kill_on_drop(true).spawn()
            .map_err(|_| Error::new("typst", "Install Typst or set UNDERTREE_TYPST to its executable. No LaTeX installation is needed."))?;
        let stderr = child
            .stderr
            .take()
            .ok_or_else(|| Error::new("typst", "The compiler did not provide diagnostics."))?;
        let work = async {
            let mut diagnostic = Vec::new();
            stderr
                .take(MAX_DIAGNOSTICS as u64 + 1)
                .read_to_end(&mut diagnostic)
                .await?;
            if diagnostic.len() > MAX_DIAGNOSTICS {
                return Err(Error::new(
                    "limit",
                    "Typst diagnostics exceeded 64 KB. The last good PDF is preserved.",
                ));
            }
            if !child.wait().await?.success() {
                let message = String::from_utf8_lossy(&diagnostic)
                    .replace(snapshot.path().to_string_lossy().as_ref(), path)
                    .replace(
                        snapshot
                            .path()
                            .file_name()
                            .unwrap_or_default()
                            .to_string_lossy()
                            .as_ref(),
                        source
                            .file_name()
                            .unwrap_or_default()
                            .to_string_lossy()
                            .as_ref(),
                    )
                    .replace(project_info.root.to_string_lossy().as_ref(), "[project]");
                if message.contains("failed to download package") {
                    return Err(Error::new("offline", "This manuscript needs a Typst package that is not available locally. Prepare its packages outside UnderTree, then compile again. The last good preview is preserved."));
                }
                return Err(Error::new(
                    "typst",
                    format!("Typst compilation failed. Last good preview preserved.\n{message}"),
                ));
            }
            Ok(())
        };
        let result = tokio::time::timeout(std::time::Duration::from_secs(45), work)
            .await
            .unwrap_or_else(|_| {
                Err(Error::new(
                    "timeout",
                    "Typst took too long. The last good PDF is preserved.",
                ))
            });
        if let Err(error) = result {
            let _ = tokio::time::timeout(std::time::Duration::from_secs(3), child.kill()).await;
            return Err(error);
        }
        let pdf_bytes = read_limited(temporary.path(), MAX_PDF)?;
        if !pdf_bytes.starts_with(b"%PDF-") {
            return Err(Error::new(
                "typst",
                "Typst did not produce a valid PDF. The last good preview is preserved.",
            ));
        }
        let pdf = legacy_pdf.with_file_name(format!(
            "{}-{revision}.pdf",
            legacy_pdf.file_stem().unwrap_or_default().to_string_lossy()
        ));
        let previous = read_limited(&info, 1024)
            .ok()
            .and_then(|bytes| serde_json::from_slice::<Preview>(&bytes).ok());
        atomic_write(&pdf, &pdf_bytes)?;
        let metadata = Preview {
            revision: revision.to_owned(),
            pdf: pdf
                .file_name()
                .unwrap_or_default()
                .to_string_lossy()
                .into_owned(),
        };
        if let Err(error) = atomic_write(&info, &serde_json::to_vec(&metadata)?) {
            if previous.as_ref().is_none_or(|old| old.pdf != metadata.pdf) {
                let _ = std::fs::remove_file(&pdf);
            }
            return Err(error);
        }
        if let Some(old) = previous {
            let expected = format!(
                "{}-{}.pdf",
                legacy_pdf.file_stem().unwrap_or_default().to_string_lossy(),
                old.revision
            );
            if old.revision.len() == 64
                && old.revision.bytes().all(|b| b.is_ascii_hexdigit())
                && old.pdf == expected
                && old.pdf != metadata.pdf
            {
                let _ = std::fs::remove_file(pdf.with_file_name(old.pdf));
            }
        }
        let _ = std::fs::remove_file(legacy_pdf);
        self.preview_pdf(project, path)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(unix)]
    #[test]
    fn preview_reads_refuse_linked_files() {
        let temporary = tempfile::tempdir().unwrap();
        let source = temporary.path().join("source.pdf");
        let linked = temporary.path().join("linked.pdf");
        std::fs::write(&source, b"private source").unwrap();
        std::os::unix::fs::symlink(&source, &linked).unwrap();
        assert_eq!(read_limited(&linked, MAX_PDF).unwrap_err().code, "path");
    }
    use crate::Operation;

    #[tokio::test]
    async fn real_typst_preserves_last_good_preview_and_relative_imports() {
        if std::env::var_os("UNDERTREE_TYPST").is_none() {
            return;
        }
        let root = tempfile::tempdir().unwrap();
        let state = tempfile::tempdir().unwrap();
        std::fs::create_dir(root.path().join("chapters")).unwrap();
        std::fs::write(root.path().join("chapters/part.typ"), "Included prose.").unwrap();
        let text = "= Hello\n\n#include \"part.typ\"\n";
        std::fs::write(root.path().join("chapters/main.typ"), text).unwrap();
        let service = Service::new(state.path().to_owned()).unwrap();
        let project = service
            .local(Operation::AddProject {
                root: root.path().to_string_lossy().into(),
            })
            .unwrap()["id"]
            .as_str()
            .unwrap()
            .to_owned();
        let first = service
            .compile_typst(&project, "chapters/main.typ", &digest(text))
            .await
            .unwrap();
        assert_eq!(first["current"], true);
        assert!(base64::engine::general_purpose::STANDARD
            .decode(first["base64"].as_str().unwrap())
            .unwrap()
            .starts_with(b"%PDF-"));
        let missing_package = "#import \"@preview/undertree-offline-unavailable:0.0.1\": *\nHello.";
        std::fs::write(root.path().join("chapters/main.typ"), missing_package).unwrap();
        let started = std::time::Instant::now();
        assert_eq!(
            service
                .compile_typst(&project, "chapters/main.typ", &digest(missing_package))
                .await
                .unwrap_err()
                .code,
            "offline"
        );
        assert!(started.elapsed() < std::time::Duration::from_secs(5));
        assert_eq!(
            service.preview_pdf(&project, "chapters/main.typ").unwrap()["base64"],
            first["base64"]
        );
        let broken = "#unknown-function()";
        std::fs::write(root.path().join("chapters/main.typ"), broken).unwrap();
        assert_eq!(
            service
                .compile_typst(&project, "chapters/main.typ", &digest(broken))
                .await
                .unwrap_err()
                .code,
            "typst"
        );
        let preserved = service.preview_pdf(&project, "chapters/main.typ").unwrap();
        assert_eq!(preserved["revision"], digest(text));
        assert_eq!(preserved["base64"], first["base64"]);
        assert_eq!(preserved["current"], false);
        assert_eq!(
            service
                .compile_typst(&project, "chapters/main.typ", &digest(text))
                .await
                .unwrap_err()
                .code,
            "stale"
        );
        let imported = crate::tex_import::convert("\\section{Results}A \\textbf{strong effect}.\\begin{itemize}\\item First\\item Second\\end{itemize} $$x^2$$").unwrap();
        std::fs::write(root.path().join("chapters/main.typ"), &imported.content).unwrap();
        let compiled_import = service
            .compile_typst(&project, "chapters/main.typ", &digest(&imported.content))
            .await
            .unwrap();
        assert_eq!(compiled_import["current"], true);
        assert_eq!(
            std::fs::read_dir(state.path().join("pdfs"))
                .unwrap()
                .count(),
            2
        );
        assert!(!std::fs::read_dir(root.path().join("chapters"))
            .unwrap()
            .any(|entry| entry
                .unwrap()
                .file_name()
                .to_string_lossy()
                .starts_with(".undertree-compile-")));
    }

    #[test]
    fn bounded_reads_reject_large_data_before_decoding() {
        let file = tempfile::NamedTempFile::new().unwrap();
        std::fs::write(file.path(), vec![b'x'; 33]).unwrap();
        assert_eq!(read_limited(file.path(), 32).unwrap_err().code, "limit");
        assert_eq!(read_limited(file.path(), 33).unwrap().len(), 33);
    }
}
