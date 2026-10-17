use crate::{Error, Result};
use std::path::Path;
use tokio::process::Command;

#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) enum PublicationEngine {
    Typst,
    Latex,
}

impl PublicationEngine {
    pub(super) fn for_source(path: &str) -> Result<Self> {
        match Path::new(path)
            .extension()
            .and_then(|extension| extension.to_str())
        {
            Some("typ") => Ok(Self::Typst),
            Some("tex") => Ok(Self::Latex),
            _ => Err(Error::new(
                "source",
                "Choose a Typst or LaTeX source to compile.",
            )),
        }
    }

    pub(super) fn command(self) -> Result<Command> {
        let executable = match self {
            Self::Typst => std::env::var_os("UNDERTREE_TYPST").unwrap_or_else(|| "typst".into()),
            Self::Latex => match std::env::var_os("UNDERTREE_LATEX_WORKER") {
                Some(path) => path,
                None => std::env::current_exe()?
                    .with_file_name(if cfg!(windows) {
                        "undertree-latex.exe"
                    } else {
                        "undertree-latex"
                    })
                    .into_os_string(),
            },
        };
        Ok(Command::new(executable))
    }

    pub(super) fn prepare(
        self,
        compiler: &mut Command,
        root: &Path,
        input: &str,
        dependencies: &Path,
        qualified: bool,
    ) {
        match self {
            Self::Typst => {
                if qualified {
                    compiler.args(["--color", "never"]);
                }
                compiler
                    .arg("compile")
                    .arg("--root")
                    .arg(root)
                    .arg(root.join(input))
                    .arg("-")
                    .args(["--format", "pdf", "--deps"])
                    .arg(dependencies)
                    .args(["--deps-format", "json", "--font-path"])
                    .arg(root);
                if qualified {
                    compiler.args(["--diagnostic-format", "short"]);
                }
            }
            Self::Latex => {
                compiler
                    .arg("compile")
                    .arg("--root")
                    .arg(root)
                    .arg("--input")
                    .arg(input)
                    .arg("--deps")
                    .arg(dependencies);
            }
        }
    }

    pub(super) fn name(self) -> &'static str {
        match self {
            Self::Typst => "Typst",
            Self::Latex => "LaTeX",
        }
    }

    pub(super) fn code(self) -> &'static str {
        match self {
            Self::Typst => "typst",
            Self::Latex => "latex",
        }
    }

    pub(super) fn unavailable(self) -> Error {
        match self {
            Self::Typst => Error::new("typst", "Install Typst or set UNDERTREE_TYPST to its executable. No LaTeX installation is needed."),
            Self::Latex => Error::new("latex", "The UnderTree LaTeX worker is unavailable. Install the complete UnderTree package or set UNDERTREE_LATEX_WORKER. The last good PDF is preserved."),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn publication_formats_do_not_admit_bibliographies_or_import_targets() {
        assert!(matches!(
            PublicationEngine::for_source("chapters/main.typ"),
            Ok(PublicationEngine::Typst)
        ));
        assert!(matches!(
            PublicationEngine::for_source("chapters/main.tex"),
            Ok(PublicationEngine::Latex)
        ));
        for path in [
            "refs.bib",
            "main.html",
            "main.tex.typ.bak",
            "main.tex/notes",
        ] {
            assert!(PublicationEngine::for_source(path).is_err(), "{path}");
        }
    }
}
