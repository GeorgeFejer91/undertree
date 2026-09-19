use std::ffi::OsString;
use std::io::{self, Read, Write};
use std::path::{Component, PathBuf};
use std::process::ExitCode;
use std::time::Duration;

use serde::Serialize;

use crate::compiler::{CompileRequest, CompilerAssets};
use crate::error::BoundaryError;
use crate::github::{
    CreateRepositoryRequest, GitHubService, GitHubStatus, LinkProjectRequest, RepositorySummary,
    SaveRulesRequest, SyncAction, SyncProjectRequest,
};
use crate::pdf;
use crate::project::ProjectState;
use crate::remote_control::{RemoteClientError, RemoteFailure, RemoteRequest, RemoteResult};
use crate::review::ReviewProposalOperation;

const HELP: &str = r#"UnderTree native command line

Usage:
  undertree-typst open --project PATH [--source RELATIVE.typ]
  undertree-typst [cli] git status --project PATH [--json]
  undertree-typst [cli] git branches --project PATH [--json]
  undertree-typst [cli] git commit --project PATH --message TEXT [--json]
  undertree-typst [cli] git pull --project PATH [--json]
  undertree-typst [cli] git push --project PATH [--json]
  undertree-typst [cli] git sync --project PATH [--json]
  undertree-typst [cli] convert latex-to-typst --project PATH [--source RELATIVE.tex] [--json]
  undertree-typst [cli] convert markdown-to-typst --project PATH --source RELATIVE.md [--json]
  undertree-typst [cli] convert typst-to-latex --project PATH --path RELATIVE.typ [--json]
  undertree-typst [cli] compile --project PATH --source RELATIVE.typ [--json]
  undertree-typst [cli] pdf export --project PATH --source RELATIVE.typ --output FILE.pdf [--force] [--reveal] [--json]
  undertree-typst [cli] project status --project PATH [--json]
  undertree-typst [cli] project files --project PATH [--category TYPE] [--all] [--json]
  undertree-typst [cli] project refresh --project PATH [--path RELATIVE] [--json]
  undertree-typst [cli] document read --project PATH --path RELATIVE [--json]
  undertree-typst [cli] document save --project PATH --path RELATIVE --expected-digest SHA256 --revision N --stdin [--json]
  undertree-typst [cli] bibliography create --project PATH --path RELATIVE.bib [--json]
  undertree-typst [cli] app status|focus|compile [--timeout SECONDS] [--json]
  undertree-typst [cli] app project open --project PATH [--source RELATIVE.typ] [--discard-unsaved] [--timeout SECONDS] [--json]
  undertree-typst [cli] app project refresh [--discard-unsaved] [--timeout SECONDS] [--json]
  undertree-typst [cli] app document open --path RELATIVE [--discard-unsaved] [--timeout SECONDS] [--json]
  undertree-typst [cli] app document read [--timeout SECONDS] [--json]
  undertree-typst [cli] app document replace --expected-revision N --stdin [--timeout SECONDS] [--json]
  undertree-typst [cli] app document save [--timeout SECONDS] [--json]
  undertree-typst [cli] app agent context [--timeout SECONDS] [--json]
  undertree-typst [cli] app agent replace --expected-revision N --expected-policy-version N --stdin [--timeout SECONDS] [--json]
  undertree-typst [cli] app review context [--timeout SECONDS] [--json]
  undertree-typst [cli] app review propose --mark-id ID --proposal-id ID --operation replace|delete --expected-policy-version N [--rationale TEXT] --stdin [--timeout SECONDS] [--json]
  undertree-typst [cli] app review comment --mark-id ID --comment-id ID [--proposal-id ID] --expected-policy-version N --stdin [--timeout SECONDS] [--json]
  undertree-typst [cli] app bibliography create --path RELATIVE.bib [--discard-unsaved] [--timeout SECONDS] [--json]
  undertree-typst [cli] app pdf export --output FILE.pdf [--force] [--timeout SECONDS] [--json]
  undertree-typst [cli] app pdf reveal [--timeout SECONDS] [--json]
  undertree-typst [cli] app convert typst-to-latex [--timeout SECONDS] [--json]
  undertree-typst [cli] app quit [--discard-unsaved] [--timeout SECONDS] [--json]
  undertree-typst [cli] github login
  undertree-typst [cli] github status [--project PATH] [--json]
  undertree-typst [cli] github doctor --project PATH [--json]
  undertree-typst [cli] github repositories [--json]
  undertree-typst [cli] github create --parent PATH --name NAME [--description TEXT] --private|--public [--json]
  undertree-typst [cli] github link --project PATH --repository OWNER/NAME [--json]
  undertree-typst [cli] github clone --parent PATH --repository OWNER/NAME [--json]
  undertree-typst [cli] github pull --project PATH [--json]
  undertree-typst [cli] github push --project PATH [--json]
  undertree-typst [cli] github sync --project PATH [--json]
  undertree-typst [cli] github commit-and-sync --project PATH --message TEXT [--json]
  undertree-typst [cli] github rules --project PATH --interval 0|5|15|30|60 [--auto-commit|--no-auto-commit] [--json]
  undertree-typst [cli] github unlink --project PATH [--json]
  undertree-typst [cli] github logout [--json]

The CLI uses UnderTree's confined Rust services. The `app` group controls the
running editor through an authenticated, user-local channel and preserves its
dirty/revision guards. No command exposes a shell, arbitrary URL, credential,
or unrestricted filesystem primitive. Run without arguments to open the app.
"#;

#[derive(Default)]
struct Options {
    project: Option<PathBuf>,
    parent: Option<PathBuf>,
    repository: Option<String>,
    source: Option<String>,
    path: Option<String>,
    output: Option<PathBuf>,
    name: Option<String>,
    description: Option<String>,
    message: Option<String>,
    expected_digest: Option<String>,
    revision: Option<u64>,
    expected_revision: Option<u64>,
    expected_policy_version: Option<u64>,
    mark_id: Option<String>,
    proposal_id: Option<String>,
    comment_id: Option<String>,
    operation: Option<String>,
    rationale: Option<String>,
    category: Option<String>,
    interval: Option<u64>,
    timeout: Option<u64>,
    auto_commit: Option<bool>,
    private: Option<bool>,
    all: bool,
    stdin: bool,
    force: bool,
    reveal: bool,
    discard_unsaved: bool,
    json: bool,
}

impl Options {
    fn has_pdf_options(&self) -> bool {
        self.output.is_some() || self.force || self.reveal
    }
}

#[derive(Debug)]
enum CliError {
    Usage(String),
    Boundary(BoundaryError),
    Remote(RemoteFailure),
    Internal(String),
}

impl From<BoundaryError> for CliError {
    fn from(error: BoundaryError) -> Self {
        Self::Boundary(error)
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CliErrorOutput<'a> {
    ok: bool,
    code: &'a str,
    message: &'a str,
    #[serde(skip_serializing_if = "diagnostics_are_empty")]
    diagnostics: &'a [crate::compiler::Diagnostic],
}

fn diagnostics_are_empty(diagnostics: &&[crate::compiler::Diagnostic]) -> bool {
    diagnostics.is_empty()
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DoctorReport {
    ok: bool,
    diagnosis: String,
    recommendations: Vec<String>,
    status: GitHubStatus,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CompileSummary {
    path: String,
    pages: usize,
    warnings: usize,
    elapsed_ms: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PdfExportSummary {
    source: String,
    output: String,
    revision: u64,
    pages: usize,
    warnings: usize,
    elapsed_ms: u64,
    revealed: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ProjectRefreshSummary {
    name: String,
    root: String,
    active_path: String,
    active_digest: String,
    files: usize,
    conversion_created: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct TypstToLatexSummary {
    source: String,
    output: String,
    warnings: usize,
}

pub fn try_run(arguments: Vec<OsString>) -> Option<ExitCode> {
    if arguments.is_empty() {
        return None;
    }

    let mut arguments = arguments;
    if arguments.first().and_then(|value| value.to_str()) == Some("cli") {
        arguments.remove(0);
    }
    if arguments.is_empty() {
        print!("{HELP}");
        return Some(ExitCode::SUCCESS);
    }

    let wants_json = arguments.iter().any(|argument| argument == "--json");
    let result = run(arguments);
    Some(result.map_or_else(
        |error| report_error(&error, wants_json),
        |_| ExitCode::SUCCESS,
    ))
}

pub struct GuiProjectRequest {
    pub root: PathBuf,
    pub preferred: Option<String>,
    pub json: bool,
}

pub fn gui_project_request(arguments: &[OsString]) -> Option<Result<GuiProjectRequest, ExitCode>> {
    if arguments.first().and_then(|argument| argument.to_str()) != Some("open") {
        return None;
    }
    let wants_json = arguments.iter().any(|argument| argument == "--json");
    let result = (|| {
        let options = parse_options(&arguments[1..])?;
        if options.parent.is_some()
            || options.repository.is_some()
            || options.path.is_some()
            || options.name.is_some()
            || options.description.is_some()
            || options.message.is_some()
            || options.expected_digest.is_some()
            || options.revision.is_some()
            || options.expected_revision.is_some()
            || options.expected_policy_version.is_some()
            || options.category.is_some()
            || options.interval.is_some()
            || options.timeout.is_some()
            || options.auto_commit.is_some()
            || options.private.is_some()
            || options.has_pdf_options()
            || options.all
            || options.stdin
            || options.discard_unsaved
        {
            return Err(CliError::Usage(
                "open accepts --project PATH, optional --source RELATIVE.typ, and optional --json."
                    .into(),
            ));
        }
        let root = canonical_required(options.project, "--project")?;
        let preferred = options.source;
        if preferred.as_ref().is_some_and(|source| {
            let path = PathBuf::from(source);
            path.is_absolute()
                || path
                    .components()
                    .any(|component| !matches!(component, Component::Normal(_)))
                || !path
                    .extension()
                    .is_some_and(|extension| extension.eq_ignore_ascii_case("typ"))
        }) {
            return Err(CliError::Usage(
                "open --source must be a relative .typ path.".into(),
            ));
        }
        Ok(GuiProjectRequest {
            root,
            preferred,
            json: options.json,
        })
    })();
    Some(result.map_err(|error| report_error(&error, wants_json)))
}

pub fn try_open_running(project: &GuiProjectRequest) -> Option<ExitCode> {
    if !crate::remote_control::endpoint_exists() {
        return None;
    }
    let request = RemoteRequest::ProjectOpen {
        project: project.root.clone(),
        source: project.preferred.clone(),
        discard_unsaved: false,
    };
    match crate::remote_control::send_request(request, Duration::from_secs(30)) {
        Ok(result) => {
            let result = output(&result, project.json, || human_remote_result(&result));
            Some(result.map_or_else(
                |error| report_error(&error, project.json),
                |_| ExitCode::SUCCESS,
            ))
        }
        Err(RemoteClientError::NotRunning) => None,
        Err(error) => {
            let error = remote_client_error(error);
            Some(report_error(&error, project.json))
        }
    }
}

pub fn forwarded_open_request(arguments: &[String], cwd: &str) -> Option<RemoteRequest> {
    let arguments = arguments.get(1..)?;
    if arguments.first().map(String::as_str) != Some("open") {
        return None;
    }
    let arguments = arguments
        .iter()
        .skip(1)
        .map(OsString::from)
        .collect::<Vec<_>>();
    let options = parse_options(&arguments).ok()?;
    if options.parent.is_some()
        || options.repository.is_some()
        || options.path.is_some()
        || options.name.is_some()
        || options.description.is_some()
        || options.message.is_some()
        || options.expected_digest.is_some()
        || options.revision.is_some()
        || options.expected_revision.is_some()
        || options.expected_policy_version.is_some()
        || options.mark_id.is_some()
        || options.proposal_id.is_some()
        || options.comment_id.is_some()
        || options.operation.is_some()
        || options.rationale.is_some()
        || options.category.is_some()
        || options.interval.is_some()
        || options.timeout.is_some()
        || options.auto_commit.is_some()
        || options.private.is_some()
        || options.has_pdf_options()
        || options.all
        || options.stdin
        || options.discard_unsaved
    {
        return None;
    }
    let mut project = options.project?;
    if project.is_relative() {
        project = PathBuf::from(cwd).join(project);
    }
    let project = project.canonicalize().ok()?;
    if !project.is_dir() {
        return None;
    }
    if let Some(source) = options.source.as_deref()
        && validate_relative_extension(source, "typ", "--source").is_err()
    {
        return None;
    }
    Some(RemoteRequest::ProjectOpen {
        project,
        source: options.source,
        discard_unsaved: false,
    })
}

fn report_error(error: &CliError, wants_json: bool) -> ExitCode {
    let (exit, code, message, diagnostics) = match error {
        CliError::Usage(message) => (2, "invalid_cli_arguments", message.as_str(), &[][..]),
        CliError::Boundary(error) => (
            1,
            error.code,
            error.message.as_str(),
            error.diagnostics.as_slice(),
        ),
        CliError::Remote(error) => (1, error.code.as_str(), error.message.as_str(), &[][..]),
        CliError::Internal(message) => (1, "cli_internal_error", message.as_str(), &[][..]),
    };
    if wants_json {
        let payload = CliErrorOutput {
            ok: false,
            code,
            message,
            diagnostics,
        };
        match serde_json::to_string_pretty(&payload) {
            Ok(payload) => eprintln!("{payload}"),
            Err(_) => eprintln!("{code}: {message}"),
        }
    } else {
        eprintln!("UnderTree error [{code}]: {message}");
        if matches!(error, CliError::Usage(_)) {
            eprintln!("\n{HELP}");
        }
    }
    ExitCode::from(exit)
}

fn run(arguments: Vec<OsString>) -> Result<(), CliError> {
    let command = word(arguments.first(), "command")?;
    if matches!(command.as_str(), "help" | "--help" | "-h") {
        print!("{HELP}");
        return Ok(());
    }
    if matches!(command.as_str(), "version" | "--version" | "-V") {
        println!("UnderTree {}", env!("CARGO_PKG_VERSION"));
        return Ok(());
    }
    if !matches!(
        command.as_str(),
        "github"
            | "git"
            | "convert"
            | "compile"
            | "pdf"
            | "project"
            | "document"
            | "bibliography"
            | "app"
    ) {
        return Err(CliError::Usage(format!(
            "Unknown command '{command}'. Use 'app', 'project', 'document', 'bibliography', 'git', 'convert', 'compile', 'pdf', 'github', or 'help'."
        )));
    }

    crate::git::configure_transport_limits()?;
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .map_err(|_| CliError::Internal("UnderTree could not start its CLI runtime.".into()))?;
    runtime.block_on(async {
        match command.as_str() {
            "github" => run_github(&arguments[1..]).await,
            "git" => run_git(&arguments[1..]).await,
            "convert" => run_convert(&arguments[1..]).await,
            "compile" => run_compile(&arguments[1..]).await,
            "pdf" => run_pdf(&arguments[1..]),
            "project" => run_project(&arguments[1..]),
            "document" => run_document(&arguments[1..]),
            "bibliography" => run_bibliography(&arguments[1..]),
            "app" => run_app(&arguments[1..]),
            _ => unreachable!(),
        }
    })
}

fn run_app(arguments: &[OsString]) -> Result<(), CliError> {
    let group = word(arguments.first(), "application command")?;
    if matches!(group.as_str(), "help" | "--help" | "-h") {
        print!("{HELP}");
        return Ok(());
    }

    let (request, options) = match group.as_str() {
        "status" | "focus" | "compile" | "quit" => {
            let options = parse_options(&arguments[1..])?;
            reject_app_options(&options, AppOptionSet::Simple)?;
            let request = match group.as_str() {
                "status" => RemoteRequest::Status,
                "focus" => RemoteRequest::Focus,
                "compile" => RemoteRequest::Compile,
                _ => RemoteRequest::Quit {
                    discard_unsaved: options.discard_unsaved,
                },
            };
            (request, options)
        }
        "project" => {
            let action = word(arguments.get(1), "application project command")?;
            let options = parse_options(&arguments[2..])?;
            match action.as_str() {
                "open" => {
                    reject_app_options(&options, AppOptionSet::ProjectOpen)?;
                    let project = canonical_required(options.project.clone(), "--project")?;
                    if let Some(source) = options.source.as_deref() {
                        validate_relative_extension(source, "typ", "--source")?;
                    }
                    (
                        RemoteRequest::ProjectOpen {
                            project,
                            source: options.source.clone(),
                            discard_unsaved: options.discard_unsaved,
                        },
                        options,
                    )
                }
                "refresh" => {
                    reject_app_options(&options, AppOptionSet::Simple)?;
                    (
                        RemoteRequest::ProjectRefresh {
                            discard_unsaved: options.discard_unsaved,
                        },
                        options,
                    )
                }
                _ => {
                    return Err(CliError::Usage(format!(
                        "Unknown application project command '{action}'."
                    )));
                }
            }
        }
        "document" => {
            let action = word(arguments.get(1), "application document command")?;
            let options = parse_options(&arguments[2..])?;
            match action.as_str() {
                "open" => {
                    reject_app_options(&options, AppOptionSet::DocumentOpen)?;
                    let path = required_text(options.path.clone(), "--path")?;
                    (
                        RemoteRequest::DocumentOpen {
                            path,
                            discard_unsaved: options.discard_unsaved,
                        },
                        options,
                    )
                }
                "read" => {
                    reject_app_options(&options, AppOptionSet::Simple)?;
                    (RemoteRequest::DocumentRead, options)
                }
                "replace" => {
                    reject_app_options(&options, AppOptionSet::DocumentReplace)?;
                    if !options.stdin {
                        return Err(CliError::Usage(
                            "app document replace requires --stdin.".into(),
                        ));
                    }
                    let expected_revision = options.expected_revision.ok_or_else(|| {
                        CliError::Usage(
                            "app document replace requires --expected-revision N.".into(),
                        )
                    })?;
                    let source = read_stdin_source()?;
                    (
                        RemoteRequest::DocumentReplace {
                            source,
                            expected_revision,
                        },
                        options,
                    )
                }
                "save" => {
                    reject_app_options(&options, AppOptionSet::Simple)?;
                    (RemoteRequest::DocumentSave, options)
                }
                _ => {
                    return Err(CliError::Usage(format!(
                        "Unknown application document command '{action}'."
                    )));
                }
            }
        }
        "agent" => {
            let action = word(arguments.get(1), "application agent command")?;
            let options = parse_options(&arguments[2..])?;
            match action.as_str() {
                "context" => {
                    reject_app_options(&options, AppOptionSet::Simple)?;
                    (RemoteRequest::AgentContext, options)
                }
                "replace" => {
                    reject_app_options(&options, AppOptionSet::AgentReplace)?;
                    if !options.stdin {
                        return Err(CliError::Usage(
                            "app agent replace requires --stdin.".into(),
                        ));
                    }
                    let expected_revision = options.expected_revision.ok_or_else(|| {
                        CliError::Usage("app agent replace requires --expected-revision N.".into())
                    })?;
                    let expected_policy_version =
                        options.expected_policy_version.ok_or_else(|| {
                            CliError::Usage(
                                "app agent replace requires --expected-policy-version N.".into(),
                            )
                        })?;
                    let source = read_stdin_source()?;
                    (
                        RemoteRequest::AgentReplace {
                            source,
                            expected_revision,
                            expected_policy_version,
                        },
                        options,
                    )
                }
                _ => {
                    return Err(CliError::Usage(format!(
                        "Unknown application agent command '{action}'."
                    )));
                }
            }
        }
        "review" => {
            let action = word(arguments.get(1), "application review command")?;
            let options = parse_options(&arguments[2..])?;
            match action.as_str() {
                "context" => {
                    reject_app_options(&options, AppOptionSet::ReviewContext)?;
                    (RemoteRequest::ReviewContext, options)
                }
                "propose" => {
                    reject_app_options(&options, AppOptionSet::ReviewPropose)?;
                    if !options.stdin {
                        return Err(CliError::Usage(
                            "app review propose requires --stdin.".into(),
                        ));
                    }
                    let mark_id = required_text(options.mark_id.clone(), "--mark-id")?;
                    let id = required_text(options.proposal_id.clone(), "--proposal-id")?;
                    let expected_policy_version =
                        options.expected_policy_version.ok_or_else(|| {
                            CliError::Usage(
                                "app review propose requires --expected-policy-version N.".into(),
                            )
                        })?;
                    let operation = match options.operation.as_deref() {
                        Some("replace") => ReviewProposalOperation::Replace,
                        Some("delete") => ReviewProposalOperation::Delete,
                        _ => {
                            return Err(CliError::Usage(
                                "app review propose requires --operation replace|delete.".into(),
                            ));
                        }
                    };
                    let replacement = read_stdin_source()?;
                    if operation == ReviewProposalOperation::Delete && !replacement.is_empty() {
                        return Err(CliError::Usage(
                            "A delete proposal requires empty stdin.".into(),
                        ));
                    }
                    (
                        RemoteRequest::ReviewPropose {
                            id: Some(id),
                            mark_id,
                            operation,
                            replacement,
                            rationale: options.rationale.clone().unwrap_or_default(),
                            expected_policy_version,
                        },
                        options,
                    )
                }
                "comment" => {
                    reject_app_options(&options, AppOptionSet::ReviewComment)?;
                    if !options.stdin {
                        return Err(CliError::Usage(
                            "app review comment requires --stdin.".into(),
                        ));
                    }
                    let mark_id = required_text(options.mark_id.clone(), "--mark-id")?;
                    let id = required_text(options.comment_id.clone(), "--comment-id")?;
                    let expected_policy_version =
                        options.expected_policy_version.ok_or_else(|| {
                            CliError::Usage(
                                "app review comment requires --expected-policy-version N.".into(),
                            )
                        })?;
                    let body = read_stdin_source()?;
                    (
                        RemoteRequest::ReviewComment {
                            id: Some(id),
                            mark_id,
                            proposal_id: options.proposal_id.clone(),
                            body,
                            expected_policy_version,
                        },
                        options,
                    )
                }
                _ => {
                    return Err(CliError::Usage(format!(
                        "Unknown application review command '{action}'."
                    )));
                }
            }
        }
        "bibliography" => {
            let action = word(arguments.get(1), "application bibliography command")?;
            if action != "create" {
                return Err(CliError::Usage(format!(
                    "Unknown application bibliography command '{action}'."
                )));
            }
            let options = parse_options(&arguments[2..])?;
            reject_app_options(&options, AppOptionSet::DocumentOpen)?;
            let path = required_text(options.path.clone(), "--path")?;
            validate_relative_extension(&path, "bib", "--path")?;
            (
                RemoteRequest::BibliographyCreate {
                    path,
                    discard_unsaved: options.discard_unsaved,
                },
                options,
            )
        }
        "pdf" => {
            let action = word(arguments.get(1), "application PDF command")?;
            let options = parse_options(&arguments[2..])?;
            match action.as_str() {
                "export" => {
                    reject_app_options(&options, AppOptionSet::PdfExport)?;
                    let output = canonical_pdf_output(options.output.clone())?;
                    (
                        RemoteRequest::PdfExport {
                            output,
                            overwrite: options.force,
                        },
                        options,
                    )
                }
                "reveal" => {
                    reject_app_options(&options, AppOptionSet::PdfReveal)?;
                    (RemoteRequest::PdfReveal, options)
                }
                _ => {
                    return Err(CliError::Usage(format!(
                        "Unknown application PDF command '{action}'."
                    )));
                }
            }
        }
        "convert" => {
            let action = word(arguments.get(1), "application conversion command")?;
            if action != "typst-to-latex" {
                return Err(CliError::Usage(format!(
                    "Unknown application conversion command '{action}'."
                )));
            }
            let options = parse_options(&arguments[2..])?;
            reject_app_options(&options, AppOptionSet::Simple)?;
            (RemoteRequest::ConvertTypstToLatex, options)
        }
        _ => {
            return Err(CliError::Usage(format!(
                "Unknown application command '{group}'."
            )));
        }
    };

    let timeout = options.timeout.unwrap_or(30);
    if !(1..=120).contains(&timeout) {
        return Err(CliError::Usage(
            "--timeout must be between 1 and 120 seconds.".into(),
        ));
    }
    let result = crate::remote_control::send_request(request, Duration::from_secs(timeout))
        .map_err(remote_client_error)?;
    output(&result, options.json, || human_remote_result(&result))
}

#[derive(Clone, Copy)]
enum AppOptionSet {
    Simple,
    ProjectOpen,
    DocumentOpen,
    DocumentReplace,
    AgentReplace,
    ReviewContext,
    ReviewPropose,
    ReviewComment,
    PdfExport,
    PdfReveal,
}

fn reject_app_options(options: &Options, allowed: AppOptionSet) -> Result<(), CliError> {
    let allows_project = matches!(allowed, AppOptionSet::ProjectOpen);
    let allows_source = matches!(allowed, AppOptionSet::ProjectOpen);
    let allows_path = matches!(allowed, AppOptionSet::DocumentOpen);
    let allows_replace = matches!(
        allowed,
        AppOptionSet::DocumentReplace | AppOptionSet::AgentReplace
    );
    let allows_policy_version = matches!(
        allowed,
        AppOptionSet::AgentReplace | AppOptionSet::ReviewPropose | AppOptionSet::ReviewComment
    );
    let allows_mark_id = matches!(
        allowed,
        AppOptionSet::ReviewPropose | AppOptionSet::ReviewComment
    );
    let allows_proposal_id = matches!(
        allowed,
        AppOptionSet::ReviewPropose | AppOptionSet::ReviewComment
    );
    let allows_comment_id = matches!(allowed, AppOptionSet::ReviewComment);
    let allows_operation = matches!(allowed, AppOptionSet::ReviewPropose);
    let allows_rationale = matches!(allowed, AppOptionSet::ReviewPropose);
    let allows_review_stdin = matches!(
        allowed,
        AppOptionSet::ReviewPropose | AppOptionSet::ReviewComment
    );
    let allows_pdf_export = matches!(allowed, AppOptionSet::PdfExport);
    if (!allows_project && options.project.is_some())
        || options.parent.is_some()
        || options.repository.is_some()
        || (!allows_source && options.source.is_some())
        || (!allows_path && options.path.is_some())
        || options.name.is_some()
        || options.description.is_some()
        || options.message.is_some()
        || options.expected_digest.is_some()
        || options.revision.is_some()
        || (!allows_replace && options.expected_revision.is_some())
        || (!allows_policy_version && options.expected_policy_version.is_some())
        || (!allows_mark_id && options.mark_id.is_some())
        || (!allows_proposal_id && options.proposal_id.is_some())
        || (!allows_comment_id && options.comment_id.is_some())
        || (!allows_operation && options.operation.is_some())
        || (!allows_rationale && options.rationale.is_some())
        || options.category.is_some()
        || options.interval.is_some()
        || options.auto_commit.is_some()
        || options.private.is_some()
        || (!allows_pdf_export && options.output.is_some())
        || options.all
        || (!allows_replace && !allows_review_stdin && options.stdin)
        || (!allows_pdf_export && options.force)
        || options.reveal
        || (matches!(allowed, AppOptionSet::PdfExport | AppOptionSet::PdfReveal)
            && options.discard_unsaved)
    {
        return Err(CliError::Usage(
            "This application command received an unsupported option.".into(),
        ));
    }
    Ok(())
}

fn remote_client_error(error: RemoteClientError) -> CliError {
    match error {
        RemoteClientError::NotRunning => CliError::Remote(RemoteFailure::new(
            "app_not_running",
            "No running UnderTree editor is available for remote control.",
        )),
        RemoteClientError::TimedOut => CliError::Remote(RemoteFailure::new(
            "remote_timeout",
            "The remote-control request timed out; its final outcome is unknown.",
        )),
        RemoteClientError::Failure(error) => CliError::Remote(error),
        RemoteClientError::Protocol => CliError::Remote(RemoteFailure::new(
            "remote_protocol_error",
            "The running UnderTree editor did not complete the authenticated protocol.",
        )),
    }
}

fn human_remote_result(result: &RemoteResult) -> Result<(), CliError> {
    match result {
        RemoteResult::Application { state } => {
            println!(
                "UnderTree: {} · {} · revision {} · {}{}",
                state.project_name,
                state.path.as_deref().unwrap_or("scratch"),
                state.revision,
                if state.dirty { "unsaved" } else { "saved" },
                if state.busy { " · busy" } else { "" }
            );
        }
        RemoteResult::Document { state, source } => {
            println!(
                "{} (revision {}, {})",
                state.path.as_deref().unwrap_or("scratch"),
                state.revision,
                if state.dirty { "unsaved" } else { "saved" }
            );
            print!("{source}");
            if !source.ends_with('\n') {
                println!();
            }
        }
        RemoteResult::AgentDocument {
            state,
            source,
            policy,
        } => {
            let keep = policy
                .annotations
                .iter()
                .filter(|annotation| {
                    annotation.kind == crate::agent_annotations::AgentAnnotationKind::Keep
                })
                .count();
            let revise = policy.annotations.len() - keep;
            println!(
                "{} (editor revision {}, policy version {}, {keep} keep, {revise} revise)",
                state.path.as_deref().unwrap_or("scratch"),
                state.revision,
                policy.policy_version,
            );
            print!("{source}");
            if !source.ends_with('\n') {
                println!();
            }
        }
        RemoteResult::ReviewDocument {
            state,
            source,
            review,
        } => {
            let pending = review
                .proposals
                .iter()
                .filter(|proposal| {
                    proposal.status == crate::review::ReviewProposalStatus::Pending
                })
                .count();
            println!(
                "{} (revision {}, review policy {}, {} mark(s), {} pending suggestion(s))",
                state.path.as_deref().unwrap_or("document"),
                state.revision,
                review.policy_version,
                review.marks.len(),
                pending
            );
            print!("{source}");
            if !source.ends_with('\n') {
                println!();
            }
        }
        RemoteResult::ReviewUpdated { state, review } => {
            let pending = review
                .proposals
                .iter()
                .filter(|proposal| {
                    proposal.status == crate::review::ReviewProposalStatus::Pending
                })
                .count();
            println!(
                "Updated review for {}: policy {}, {} mark(s), {} pending suggestion(s).",
                state.path.as_deref().unwrap_or("document"),
                review.policy_version,
                review.marks.len(),
                pending
            );
        }
        RemoteResult::Saved {
            state,
            conflict_path,
        } => {
            println!(
                "Saved {} at revision {}.",
                state.path.as_deref().unwrap_or("document"),
                state.revision
            );
            if let Some(path) = conflict_path {
                println!("Preserved displaced disk content at {path}.");
            }
        }
        RemoteResult::Compiled {
            state,
            pages,
            warnings,
            elapsed_ms,
        } => println!(
            "Compiled {}: {pages} page(s), {warnings} warning(s), {elapsed_ms} ms (revision {}).",
            state.path.as_deref().unwrap_or("document"),
            state.revision
        ),
        RemoteResult::PdfExported {
            state,
            file_name,
            pages,
            warnings,
            elapsed_ms,
        } => println!(
            "Exported {} as {file_name}: {pages} page(s), {warnings} warning(s), {elapsed_ms} ms (revision {}).",
            state.path.as_deref().unwrap_or("document"),
            state.revision
        ),
        RemoteResult::Converted {
            source,
            output,
            warnings,
            ..
        } => println!("Converted {source} -> {output}; {warnings} warning(s)."),
        RemoteResult::Acknowledged { action } => println!("UnderTree {action} completed."),
    }
    Ok(())
}

fn run_project(arguments: &[OsString]) -> Result<(), CliError> {
    let subcommand = word(arguments.first(), "project command")?;
    if matches!(subcommand.as_str(), "help" | "--help" | "-h") {
        print!("{HELP}");
        return Ok(());
    }
    let options = parse_options(&arguments[1..])?;
    match subcommand.as_str() {
        "status" => {
            reject_project_inspection_options(&options, false)?;
            let root = canonical_required(options.project, "--project")?;
            let inspection = ProjectState::inspect(&root)?;
            output(&inspection, options.json, || {
                println!("Project: {}", inspection.name);
                println!("Root: {}", inspection.root);
                println!(
                    "Files: {} total, {} editable, {} normally visible",
                    inspection.inventory.total,
                    inspection.inventory.editable,
                    inspection.inventory.default_visible
                );
                if let Some(active) = &inspection.active {
                    println!("Default document: {} ({})", active.path, active.digest);
                }
                println!("Lock: {:?}", inspection.lock_state);
                Ok(())
            })
        }
        "files" => {
            reject_project_inspection_options(&options, true)?;
            let root = canonical_required(options.project, "--project")?;
            let inspection = ProjectState::inspect(&root)?;
            let category = options.category.as_deref();
            if let Some(category) = category
                && !matches!(
                    category,
                    "typst"
                        | "bibliography"
                        | "generated-latex"
                        | "latex"
                        | "pdf"
                        | "image"
                        | "other"
                )
            {
                return Err(CliError::Usage(
                    "--category must be typst, bibliography, generated-latex, latex, pdf, image, or other."
                        .into(),
                ));
            }
            let files = inspection
                .files
                .into_iter()
                .filter(|file| options.all || file.default_visible)
                .filter(|file| category.is_none_or(|category| file.category == category))
                .collect::<Vec<_>>();
            output(&files, options.json, || {
                for file in &files {
                    println!("{}\t{}", file.category, file.path);
                }
                Ok(())
            })
        }
        "refresh" => {
            reject_project_refresh_options(&options)?;
            let (_root, projects) = selected_project(options.project)?;
            let snapshot = projects.refresh(options.path.as_deref())?;
            let summary = ProjectRefreshSummary {
                name: snapshot.name,
                root: snapshot.root,
                active_path: snapshot.active.path,
                active_digest: snapshot.active.digest,
                files: snapshot.all_files.len(),
                conversion_created: snapshot
                    .conversion
                    .as_ref()
                    .map_or(0, |conversion| conversion.converted.len()),
            };
            output(&summary, options.json, || {
                println!(
                    "Refreshed {}: {} file(s); active document {}.",
                    summary.name, summary.files, summary.active_path
                );
                if summary.conversion_created > 0 {
                    println!(
                        "Created {} non-destructive Typst conversion draft(s).",
                        summary.conversion_created
                    );
                }
                Ok(())
            })
        }
        _ => Err(CliError::Usage(format!(
            "Unknown project command '{subcommand}'."
        ))),
    }
}

fn run_document(arguments: &[OsString]) -> Result<(), CliError> {
    let subcommand = word(arguments.first(), "document command")?;
    if matches!(subcommand.as_str(), "help" | "--help" | "-h") {
        print!("{HELP}");
        return Ok(());
    }
    let options = parse_options(&arguments[1..])?;
    match subcommand.as_str() {
        "read" => {
            reject_document_options(&options, false)?;
            let path = required_text(options.path, "--path")?;
            let root = canonical_required(options.project, "--project")?;
            let document = ProjectState::read_document(&root, &path)?;
            output(&document, options.json, || {
                print!("{}", document.source);
                if !document.source.ends_with('\n') {
                    println!();
                }
                Ok(())
            })
        }
        "save" => {
            reject_document_options(&options, true)?;
            if !options.stdin {
                return Err(CliError::Usage("document save requires --stdin.".into()));
            }
            let path = required_text(options.path, "--path")?;
            let expected_digest = required_text(options.expected_digest, "--expected-digest")?;
            validate_digest(&expected_digest)?;
            let revision = options
                .revision
                .ok_or_else(|| CliError::Usage("document save requires --revision N.".into()))?;
            let source = read_stdin_source()?;
            let (_root, projects) = selected_project(options.project)?;
            let result = projects.save(crate::project::SaveRequest {
                path: path.clone(),
                source,
                expected_digest,
                revision,
            })?;
            output(&result, options.json, || {
                println!("Saved {path} at revision {}.", result.revision);
                if let Some(conflict) = &result.conflict_path {
                    println!("Preserved displaced disk content at {conflict}.");
                }
                Ok(())
            })
        }
        _ => Err(CliError::Usage(format!(
            "Unknown document command '{subcommand}'."
        ))),
    }
}

fn run_bibliography(arguments: &[OsString]) -> Result<(), CliError> {
    let subcommand = word(arguments.first(), "bibliography command")?;
    if matches!(subcommand.as_str(), "help" | "--help" | "-h") {
        print!("{HELP}");
        return Ok(());
    }
    let options = parse_options(&arguments[1..])?;
    if subcommand != "create" {
        return Err(CliError::Usage(format!(
            "Unknown bibliography command '{subcommand}'."
        )));
    }
    reject_bibliography_options(&options)?;
    let path = required_text(options.path, "--path")?;
    validate_relative_extension(&path, "bib", "--path")?;
    let (_root, projects) = selected_project(options.project)?;
    let result = projects.create_bibliography(&path)?;
    output(&result, options.json, || {
        println!("Created {}.", result.document.path);
        Ok(())
    })
}

fn reject_project_inspection_options(options: &Options, allow_files: bool) -> Result<(), CliError> {
    if options.parent.is_some()
        || options.repository.is_some()
        || options.source.is_some()
        || options.path.is_some()
        || options.name.is_some()
        || options.description.is_some()
        || options.message.is_some()
        || options.expected_digest.is_some()
        || options.revision.is_some()
        || options.expected_revision.is_some()
        || options.expected_policy_version.is_some()
        || (!allow_files && options.category.is_some())
        || options.interval.is_some()
        || options.timeout.is_some()
        || options.auto_commit.is_some()
        || options.private.is_some()
        || options.has_pdf_options()
        || (!allow_files && options.all)
        || options.stdin
        || options.discard_unsaved
    {
        return Err(CliError::Usage(if allow_files {
            "project files accepts --project PATH, optional --category TYPE, --all, and --json."
                .into()
        } else {
            "project status accepts only --project PATH and optional --json.".into()
        }));
    }
    Ok(())
}

fn reject_project_refresh_options(options: &Options) -> Result<(), CliError> {
    if options.parent.is_some()
        || options.repository.is_some()
        || options.source.is_some()
        || options.name.is_some()
        || options.description.is_some()
        || options.message.is_some()
        || options.expected_digest.is_some()
        || options.revision.is_some()
        || options.expected_revision.is_some()
        || options.expected_policy_version.is_some()
        || options.mark_id.is_some()
        || options.proposal_id.is_some()
        || options.comment_id.is_some()
        || options.operation.is_some()
        || options.rationale.is_some()
        || options.category.is_some()
        || options.interval.is_some()
        || options.timeout.is_some()
        || options.auto_commit.is_some()
        || options.private.is_some()
        || options.has_pdf_options()
        || options.all
        || options.stdin
        || options.discard_unsaved
    {
        return Err(CliError::Usage(
            "project refresh accepts --project PATH, optional --path RELATIVE, and --json.".into(),
        ));
    }
    Ok(())
}

fn reject_document_options(options: &Options, save: bool) -> Result<(), CliError> {
    if options.parent.is_some()
        || options.repository.is_some()
        || options.source.is_some()
        || options.name.is_some()
        || options.description.is_some()
        || options.message.is_some()
        || (!save && options.expected_digest.is_some())
        || (!save && options.revision.is_some())
        || options.expected_revision.is_some()
        || options.expected_policy_version.is_some()
        || options.mark_id.is_some()
        || options.proposal_id.is_some()
        || options.comment_id.is_some()
        || options.operation.is_some()
        || options.rationale.is_some()
        || options.category.is_some()
        || options.interval.is_some()
        || options.timeout.is_some()
        || options.auto_commit.is_some()
        || options.private.is_some()
        || options.has_pdf_options()
        || options.all
        || (!save && options.stdin)
        || options.discard_unsaved
    {
        return Err(CliError::Usage(if save {
            "document save accepts --project PATH, --path RELATIVE, --expected-digest SHA256, --revision N, --stdin, and --json."
                .into()
        } else {
            "document read accepts --project PATH, --path RELATIVE, and optional --json.".into()
        }));
    }
    Ok(())
}

fn reject_bibliography_options(options: &Options) -> Result<(), CliError> {
    if options.parent.is_some()
        || options.repository.is_some()
        || options.source.is_some()
        || options.name.is_some()
        || options.description.is_some()
        || options.message.is_some()
        || options.expected_digest.is_some()
        || options.revision.is_some()
        || options.expected_revision.is_some()
        || options.expected_policy_version.is_some()
        || options.mark_id.is_some()
        || options.proposal_id.is_some()
        || options.comment_id.is_some()
        || options.operation.is_some()
        || options.rationale.is_some()
        || options.category.is_some()
        || options.interval.is_some()
        || options.timeout.is_some()
        || options.auto_commit.is_some()
        || options.private.is_some()
        || options.has_pdf_options()
        || options.all
        || options.stdin
        || options.discard_unsaved
    {
        return Err(CliError::Usage(
            "bibliography create accepts --project PATH, --path RELATIVE.bib, and optional --json."
                .into(),
        ));
    }
    Ok(())
}

fn validate_digest(digest: &str) -> Result<(), CliError> {
    if digest.len() == 64 && digest.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        Ok(())
    } else {
        Err(CliError::Usage(
            "--expected-digest must be a 64-character SHA-256 hexadecimal digest.".into(),
        ))
    }
}

fn validate_relative_extension(path: &str, extension: &str, option: &str) -> Result<(), CliError> {
    let path = PathBuf::from(path);
    if path.is_absolute()
        || path
            .components()
            .any(|component| !matches!(component, Component::Normal(_)))
        || !path
            .extension()
            .is_some_and(|value| value.eq_ignore_ascii_case(extension))
    {
        return Err(CliError::Usage(format!(
            "{option} must be a relative .{extension} path."
        )));
    }
    Ok(())
}

fn read_stdin_source() -> Result<String, CliError> {
    const MAX_STDIN_BYTES: u64 = 1024 * 1024;
    let mut bytes = Vec::new();
    io::stdin()
        .lock()
        .take(MAX_STDIN_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| {
            CliError::Internal("UnderTree could not read document source from stdin.".into())
        })?;
    if bytes.len() as u64 > MAX_STDIN_BYTES {
        return Err(CliError::Remote(RemoteFailure::new(
            "document_too_large",
            "Editable documents are limited to 1 MiB.",
        )));
    }
    String::from_utf8(bytes).map_err(|_| {
        CliError::Remote(RemoteFailure::new(
            "document_not_utf8",
            "Editable documents must be valid UTF-8.",
        ))
    })
}

async fn run_compile(arguments: &[OsString]) -> Result<(), CliError> {
    let options = parse_options(arguments)?;
    reject_conversion_options(&options)?;
    if options.path.is_some() {
        return Err(CliError::Usage(
            "compile accepts --source RELATIVE.typ, not --path.".into(),
        ));
    }
    let source = required_text(options.source, "--source")?;
    if !PathBuf::from(&source)
        .extension()
        .is_some_and(|extension| extension.eq_ignore_ascii_case("typ"))
    {
        return Err(CliError::Usage(
            "compile requires a relative .typ --source path.".into(),
        ));
    }
    let (root, projects) = selected_project(options.project)?;
    let document = projects.open(&source)?;
    let result = CompilerAssets::load().compile(
        CompileRequest {
            source: document.source,
            path: Some(document.path.clone()),
            revision: 0,
        },
        Some(root),
    )?;
    let summary = CompileSummary {
        path: document.path,
        pages: result.pages.len(),
        warnings: result.warnings.len(),
        elapsed_ms: result.elapsed_ms,
    };
    output(&summary, options.json, || {
        println!(
            "Compiled {}: {} page(s), {} warning(s), {} ms.",
            summary.path, summary.pages, summary.warnings, summary.elapsed_ms
        );
        Ok(())
    })
}

fn run_pdf(arguments: &[OsString]) -> Result<(), CliError> {
    let subcommand = word(arguments.first(), "PDF command")?;
    if matches!(subcommand.as_str(), "help" | "--help" | "-h") {
        print!("{HELP}");
        return Ok(());
    }
    if subcommand != "export" {
        return Err(CliError::Usage(format!(
            "Unknown PDF command '{subcommand}'."
        )));
    }

    let options = parse_options(&arguments[1..])?;
    reject_pdf_export_options(&options)?;
    let source = required_text(options.source.clone(), "--source")?;
    validate_relative_extension(&source, "typ", "--source")?;
    let output_path = canonical_pdf_output(options.output.clone())?;
    let (root, projects) = selected_project(options.project.clone())?;
    let document = projects.open(&source)?;
    let saved = pdf::export_document(
        &CompilerAssets::load(),
        CompileRequest {
            source: document.source,
            path: Some(document.path.clone()),
            revision: 0,
        },
        Some(root),
        output_path,
        options.force,
    )?;
    let output_path = saved.path.to_string_lossy().into_owned();
    if options.reveal
        && let Err(error) = pdf::reveal_pdf(saved.path.clone())
    {
        return Err(CliError::Boundary(BoundaryError::project(
            error.code,
            format!(
                "The PDF was saved at {output_path}, but UnderTree could not show it in the system file browser."
            ),
        )));
    }
    let summary = PdfExportSummary {
        source: document.path,
        output: output_path,
        revision: saved.result.revision,
        pages: saved.result.pages,
        warnings: saved.result.warnings.len(),
        elapsed_ms: saved.result.elapsed_ms,
        revealed: options.reveal,
    };
    output(&summary, options.json, || {
        println!(
            "Exported {} to {}: {} page(s), {} warning(s), {} ms{}.",
            summary.source,
            summary.output,
            summary.pages,
            summary.warnings,
            summary.elapsed_ms,
            if summary.revealed {
                " · shown in folder"
            } else {
                ""
            }
        );
        Ok(())
    })
}

async fn run_git(arguments: &[OsString]) -> Result<(), CliError> {
    let subcommand = word(arguments.first(), "Git command")?;
    if matches!(subcommand.as_str(), "help" | "--help" | "-h") {
        print!("{HELP}");
        return Ok(());
    }
    let options = parse_options(&arguments[1..])?;
    let service = GitHubService::new();
    match subcommand.as_str() {
        "status" => {
            reject_options_except_project(&options, false)?;
            let root = canonical_required(options.project, "--project")?;
            service.set_editor_dirty(false);
            let status = service.status(Some(root)).await?;
            output(&status, options.json, || human_status(&status))
        }
        "branches" => {
            reject_options_except_project(&options, false)?;
            let (root, _projects) = selected_project(options.project)?;
            let branches = crate::git::local_branches(&root)?;
            output(&branches, options.json, || {
                for branch in &branches {
                    println!(
                        "{}\t{}\t{}",
                        if branch.current { "*" } else { " " },
                        branch.name,
                        branch.oid
                    );
                }
                Ok(())
            })
        }
        "commit" => {
            reject_options_except_project(&options, true)?;
            let message = required_text(options.message, "--message")?;
            let (root, projects) = selected_project(options.project)?;
            let result = with_editor_heartbeat(&service, async {
                service.commit_project(root, projects, message).await
            })
            .await?;
            output(&result, options.json, || {
                println!("{}", result.summary);
                human_status(&result.status)
            })
        }
        "pull" | "push" | "sync" => {
            reject_options_except_project(&options, false)?;
            let (root, projects) = selected_project(options.project)?;
            let action = match subcommand.as_str() {
                "pull" => SyncAction::Pull,
                "push" => SyncAction::Push,
                _ => SyncAction::Sync,
            };
            let result = with_editor_heartbeat(&service, async {
                service
                    .sync_project(
                        root,
                        projects,
                        SyncProjectRequest {
                            action,
                            commit_message: None,
                        },
                    )
                    .await
            })
            .await?;
            output(&result, options.json, || {
                println!("{}", result.summary);
                human_status(&result.status)
            })
        }
        _ => Err(CliError::Usage(format!(
            "Unknown Git command '{subcommand}'."
        ))),
    }
}

async fn run_convert(arguments: &[OsString]) -> Result<(), CliError> {
    let subcommand = word(arguments.first(), "conversion command")?;
    if matches!(subcommand.as_str(), "help" | "--help" | "-h") {
        print!("{HELP}");
        return Ok(());
    }
    let options = parse_options(&arguments[1..])?;
    reject_conversion_options(&options)?;
    match subcommand.as_str() {
        "latex-to-typst" => {
            if options.path.is_some() {
                return Err(CliError::Usage(
                    "latex-to-typst accepts --source RELATIVE.tex, not --path.".into(),
                ));
            }
            if let Some(source) = options.source.as_deref() {
                validate_relative_extension(source, "tex", "--source")?;
            }
            let (root, projects) = selected_project(options.project)?;
            let mut report = {
                let _guard = projects.mutation_guard()?;
                projects.ensure_selected_root(&root)?;
                if let Some(source) = options.source.as_deref() {
                    Some(crate::latex::import_project_tex_file(&root, source)?)
                } else {
                    crate::latex::convert_project_if_needed(&root)?
                }
            };
            if let Some(report) = report.as_mut() {
                crate::latex::validate_generated_typst_drafts(
                    &root,
                    report,
                    &CompilerAssets::load(),
                );
            }
            output(&report, options.json, || {
                if let Some(report) = &report {
                    println!(
                        "Converted {} LaTeX document root(s); {} warning(s); originals preserved.",
                        report.converted.len(),
                        report.warning_count
                    );
                    if let Some(primary) = &report.primary_typst {
                        println!("Primary Typst document: {primary}");
                    }
                    match report.compile_succeeded {
                        Some(true) => println!("Embedded Typst compile validation succeeded."),
                        Some(false) => {
                            println!("Embedded Typst compile validation failed:");
                            for warning in report.warnings.iter().filter(|warning| {
                                matches!(warning.kind.as_str(), "typst-compile" | "typst-warning")
                            }) {
                                println!(
                                    "  {} [{}]: {}",
                                    warning.source, warning.kind, warning.message
                                );
                            }
                        }
                        None => println!("No generated Typst draft was available to validate."),
                    }
                } else {
                    println!("No new LaTeX conversion drafts were needed.");
                }
                Ok(())
            })
        }
        "markdown-to-typst" => {
            if options.path.is_some() {
                return Err(CliError::Usage(
                    "markdown-to-typst accepts --source RELATIVE.md, not --path.".into(),
                ));
            }
            let source = required_text(options.source, "--source")?;
            let (root, projects) = selected_project(options.project)?;
            let report = {
                let _guard = projects.mutation_guard()?;
                projects.ensure_selected_root(&root)?;
                crate::markdown::convert_markdown_file(&root, &source)?
            };
            output(&report, options.json, || {
                println!(
                    "{} {} -> {}; original Markdown preserved.",
                    if report.created {
                        "Converted"
                    } else {
                        "Kept existing"
                    },
                    report.markdown,
                    report.typst
                );
                Ok(())
            })
        }
        "typst-to-latex" => {
            if options.source.is_some() {
                return Err(CliError::Usage(
                    "typst-to-latex accepts --path RELATIVE.typ, not --source.".into(),
                ));
            }
            let path = required_text(options.path, "--path")?;
            validate_relative_extension(&path, "typ", "--path")?;
            let (_root, projects) = selected_project(options.project)?;
            let (_project, report) =
                projects.export_typst_to_latex(&path, &CompilerAssets::load())?;
            let summary = TypstToLatexSummary {
                source: report.source,
                output: report.latex,
                warnings: report.warning_count,
            };
            output(&summary, options.json, || {
                println!(
                    "Converted {} -> {}; {} warning(s).",
                    summary.source, summary.output, summary.warnings
                );
                Ok(())
            })
        }
        _ => Err(CliError::Usage(format!(
            "Unknown conversion command '{subcommand}'."
        ))),
    }
}

async fn run_github(arguments: &[OsString]) -> Result<(), CliError> {
    let subcommand = word(arguments.first(), "GitHub command")?;
    if matches!(subcommand.as_str(), "help" | "--help" | "-h") {
        print!("{HELP}");
        return Ok(());
    }
    let options = parse_options(&arguments[1..])?;
    let service = GitHubService::new();

    match subcommand.as_str() {
        "login" => github_login(&service, &options).await,
        "status" => {
            reject_options_except_project(&options, false)?;
            let status = service.status(canonical_optional(options.project)?).await?;
            output(&status, options.json, || human_status(&status))
        }
        "doctor" => {
            reject_options_except_project(&options, false)?;
            let root = canonical_required(options.project, "--project")?;
            service.set_editor_dirty(false);
            let status = service.status(Some(root)).await?;
            let report = doctor_report(status);
            output(&report, options.json, || human_doctor(&report))
        }
        "repositories" => {
            reject_project_options(&options)?;
            let repositories = service.list_repositories().await?;
            output(&repositories, options.json, || {
                for repository in &repositories {
                    println!(
                        "{}\t{}\t{}\t{}",
                        repository.full_name,
                        if repository.private {
                            "private"
                        } else {
                            "public"
                        },
                        if repository.can_push {
                            "write"
                        } else {
                            "read-only"
                        },
                        repository.default_branch
                    );
                }
                Ok(())
            })
        }
        "create" => {
            reject_github_create_options(&options)?;
            let parent = canonical_required(options.parent, "--parent")?;
            let name = required_text(options.name, "--name")?;
            let private = options.private.ok_or_else(|| {
                CliError::Usage("github create requires --private or --public.".into())
            })?;
            let project = with_editor_heartbeat(&service, async {
                service
                    .create_repository_project(
                        parent,
                        ProjectState::default(),
                        CreateRepositoryRequest {
                            name,
                            description: options.description.unwrap_or_default(),
                            private,
                        },
                    )
                    .await
            })
            .await?;
            let summary = ProjectRefreshSummary {
                name: project.name,
                root: project.root,
                active_path: project.active.path,
                active_digest: project.active.digest,
                files: project.all_files.len(),
                conversion_created: 0,
            };
            output(&summary, options.json, || {
                println!(
                    "Created GitHub project {} at {}.",
                    summary.name, summary.root
                );
                Ok(())
            })
        }
        "link" => {
            reject_github_transport_options(&options, false)?;
            let (root, projects) = selected_project(options.project)?;
            let repository = required_text(options.repository, "--repository")?;
            let repository = resolve_repository(&service, &repository).await?;
            let status = with_editor_heartbeat(&service, async {
                service
                    .link_project(
                        root,
                        projects,
                        LinkProjectRequest {
                            repository: repository.full_name,
                            default_branch: repository.default_branch,
                        },
                    )
                    .await
            })
            .await?;
            output(&status, options.json, || human_status(&status))
        }
        "clone" => {
            reject_github_transport_options(&options, true)?;
            let parent = canonical_required(options.parent, "--parent")?;
            let repository = required_text(options.repository, "--repository")?;
            let repository = resolve_repository(&service, &repository).await?;
            let project = with_editor_heartbeat(&service, async {
                service
                    .clone_project(
                        parent,
                        ProjectState::default(),
                        LinkProjectRequest {
                            repository: repository.full_name,
                            default_branch: repository.default_branch,
                        },
                    )
                    .await
            })
            .await?;
            output(&project, options.json, || {
                println!("Cloned and opened {} at {}", project.name, project.root);
                Ok(())
            })
        }
        "pull" | "push" | "sync" | "commit-and-sync" => {
            reject_github_sync_options(&options, subcommand == "commit-and-sync")?;
            let (root, projects) = selected_project(options.project)?;
            let action = match subcommand.as_str() {
                "pull" => SyncAction::Pull,
                "push" => SyncAction::Push,
                "sync" => SyncAction::Sync,
                _ => SyncAction::CommitAndSync,
            };
            if matches!(action, SyncAction::CommitAndSync) && options.message.is_none() {
                return Err(CliError::Usage(
                    "commit-and-sync requires --message TEXT.".into(),
                ));
            }
            let result = with_editor_heartbeat(&service, async {
                service
                    .sync_project(
                        root,
                        projects,
                        SyncProjectRequest {
                            action,
                            commit_message: options.message,
                        },
                    )
                    .await
            })
            .await?;
            output(&result, options.json, || {
                println!("{}", result.summary);
                human_status(&result.status)
            })
        }
        "rules" => {
            reject_github_rules_options(&options)?;
            let (root, projects) = selected_project(options.project)?;
            let interval = options
                .interval
                .ok_or_else(|| CliError::Usage("rules requires --interval 0|5|15|30|60.".into()))?;
            let current = service.status(Some(root.clone())).await?;
            let auto_commit = options
                .auto_commit
                .or_else(|| current.project.as_ref().map(|project| project.auto_commit));
            let auto_commit = auto_commit.ok_or_else(|| {
                CliError::Usage(
                    "Choose --auto-commit or --no-auto-commit when configuring an unlinked project."
                        .into(),
                )
            })?;
            let status = with_editor_heartbeat(&service, async {
                service
                    .save_project_rules(
                        root,
                        projects,
                        SaveRulesRequest {
                            interval_minutes: interval,
                            auto_commit,
                        },
                    )
                    .await
            })
            .await?;
            output(&status, options.json, || human_status(&status))
        }
        "unlink" => {
            reject_options_except_project(&options, false)?;
            let (root, projects) = selected_project(options.project)?;
            let status = with_editor_heartbeat(&service, async {
                service.unlink_project(root, projects).await
            })
            .await?;
            output(&status, options.json, || {
                println!("Removed the UnderTree GitHub approval; local Git data was preserved.");
                human_status(&status)
            })
        }
        "logout" => {
            reject_project_options(&options)?;
            service.disconnect().await?;
            let status = service.status(None).await?;
            output(&status, options.json, || {
                println!("Removed UnderTree's GitHub session from the credential store.");
                human_status(&status)
            })
        }
        _ => Err(CliError::Usage(format!(
            "Unknown GitHub command '{subcommand}'."
        ))),
    }
}

fn reject_github_create_options(options: &Options) -> Result<(), CliError> {
    if options.project.is_some()
        || options.repository.is_some()
        || options.source.is_some()
        || options.path.is_some()
        || options.message.is_some()
        || options.expected_digest.is_some()
        || options.revision.is_some()
        || options.expected_revision.is_some()
        || options.expected_policy_version.is_some()
        || options.mark_id.is_some()
        || options.proposal_id.is_some()
        || options.comment_id.is_some()
        || options.operation.is_some()
        || options.rationale.is_some()
        || options.category.is_some()
        || options.interval.is_some()
        || options.timeout.is_some()
        || options.auto_commit.is_some()
        || options.has_pdf_options()
        || options.all
        || options.stdin
        || options.discard_unsaved
    {
        return Err(CliError::Usage(
            "github create accepts --parent PATH, --name NAME, optional --description TEXT, exactly one of --private/--public, and --json."
                .into(),
        ));
    }
    Ok(())
}

fn reject_github_transport_options(options: &Options, clone: bool) -> Result<(), CliError> {
    if (clone && options.project.is_some())
        || (!clone && options.parent.is_some())
        || options.source.is_some()
        || options.path.is_some()
        || options.name.is_some()
        || options.description.is_some()
        || options.message.is_some()
        || options.expected_digest.is_some()
        || options.revision.is_some()
        || options.expected_revision.is_some()
        || options.expected_policy_version.is_some()
        || options.mark_id.is_some()
        || options.proposal_id.is_some()
        || options.comment_id.is_some()
        || options.operation.is_some()
        || options.rationale.is_some()
        || options.category.is_some()
        || options.interval.is_some()
        || options.timeout.is_some()
        || options.auto_commit.is_some()
        || options.private.is_some()
        || options.has_pdf_options()
        || options.all
        || options.stdin
        || options.discard_unsaved
    {
        return Err(CliError::Usage(if clone {
            "github clone accepts --parent PATH, --repository OWNER/NAME, and optional --json."
                .into()
        } else {
            "github link accepts --project PATH, --repository OWNER/NAME, and optional --json."
                .into()
        }));
    }
    Ok(())
}

fn reject_github_sync_options(options: &Options, allow_message: bool) -> Result<(), CliError> {
    if options.parent.is_some()
        || options.repository.is_some()
        || options.source.is_some()
        || options.path.is_some()
        || options.name.is_some()
        || options.description.is_some()
        || (!allow_message && options.message.is_some())
        || options.expected_digest.is_some()
        || options.revision.is_some()
        || options.expected_revision.is_some()
        || options.expected_policy_version.is_some()
        || options.mark_id.is_some()
        || options.proposal_id.is_some()
        || options.comment_id.is_some()
        || options.operation.is_some()
        || options.rationale.is_some()
        || options.category.is_some()
        || options.interval.is_some()
        || options.timeout.is_some()
        || options.auto_commit.is_some()
        || options.private.is_some()
        || options.has_pdf_options()
        || options.all
        || options.stdin
        || options.discard_unsaved
    {
        return Err(CliError::Usage(if allow_message {
            "github commit-and-sync accepts --project PATH, --message TEXT, and optional --json."
                .into()
        } else {
            "github pull, push, and sync accept --project PATH and optional --json.".into()
        }));
    }
    Ok(())
}

fn reject_github_rules_options(options: &Options) -> Result<(), CliError> {
    if options.parent.is_some()
        || options.repository.is_some()
        || options.source.is_some()
        || options.path.is_some()
        || options.name.is_some()
        || options.description.is_some()
        || options.message.is_some()
        || options.expected_digest.is_some()
        || options.revision.is_some()
        || options.expected_revision.is_some()
        || options.expected_policy_version.is_some()
        || options.mark_id.is_some()
        || options.proposal_id.is_some()
        || options.comment_id.is_some()
        || options.operation.is_some()
        || options.rationale.is_some()
        || options.category.is_some()
        || options.timeout.is_some()
        || options.private.is_some()
        || options.has_pdf_options()
        || options.all
        || options.stdin
        || options.discard_unsaved
    {
        return Err(CliError::Usage(
            "github rules accepts --project PATH, --interval 0|5|15|30|60, one automatic-commit option, and optional --json."
                .into(),
        ));
    }
    Ok(())
}

async fn github_login(service: &GitHubService, options: &Options) -> Result<(), CliError> {
    reject_project_options(options)?;
    if options.json {
        return Err(CliError::Usage(
            "Interactive GitHub login does not support --json.".into(),
        ));
    }
    let authorization = service.begin_authorization().await?;
    println!("GitHub one-time code: {}", authorization.user_code);
    println!("Open: {}", authorization.verification_uri);
    println!("Waiting for GitHub authorization…");
    io::stdout()
        .flush()
        .map_err(|_| CliError::Internal("UnderTree could not flush CLI output.".into()))?;
    loop {
        tokio::time::sleep(Duration::from_secs(authorization.interval_seconds)).await;
        let poll = service.poll_authorization(authorization.attempt_id).await?;
        if poll.status == "complete" {
            if let Some(account) = poll.account {
                println!("Connected as @{}.", account.login);
            } else {
                println!("GitHub authorization completed.");
            }
            return Ok(());
        }
        if poll.retry_after_seconds > authorization.interval_seconds {
            tokio::time::sleep(Duration::from_secs(
                poll.retry_after_seconds - authorization.interval_seconds,
            ))
            .await;
        }
    }
}

async fn resolve_repository(
    service: &GitHubService,
    name: &str,
) -> Result<RepositorySummary, CliError> {
    service
        .list_repositories()
        .await?
        .into_iter()
        .find(|repository| repository.full_name == name)
        .ok_or_else(|| {
            CliError::Boundary(BoundaryError::github(
                "repository_not_authorized",
                "This repository is not available to the connected GitHub account.",
            ))
        })
}

async fn with_editor_heartbeat<T>(
    service: &GitHubService,
    operation: impl Future<Output = Result<T, BoundaryError>>,
) -> Result<T, BoundaryError> {
    service.set_editor_dirty(false);
    let heartbeat_service = service.clone();
    let heartbeat = tokio::spawn(async move {
        let mut interval = tokio::time::interval(Duration::from_secs(3));
        loop {
            interval.tick().await;
            heartbeat_service.set_editor_dirty(false);
        }
    });
    let result = operation.await;
    heartbeat.abort();
    result
}

fn selected_project(project: Option<PathBuf>) -> Result<(PathBuf, ProjectState), CliError> {
    let project = project.ok_or_else(|| CliError::Usage("Missing --project PATH.".into()))?;
    let projects = ProjectState::default();
    let root = projects.select_for_cli(project)?;
    Ok((root, projects))
}

fn canonical_optional(project: Option<PathBuf>) -> Result<Option<PathBuf>, CliError> {
    project
        .map(|project| canonical_required(Some(project), "--project"))
        .transpose()
}

fn canonical_required(path: Option<PathBuf>, option: &str) -> Result<PathBuf, CliError> {
    let path = path.ok_or_else(|| CliError::Usage(format!("Missing {option} PATH.")))?;
    let canonical = path.canonicalize().map_err(|_| {
        CliError::Boundary(BoundaryError::project(
            "project_unavailable",
            "The selected folder is unavailable.",
        ))
    })?;
    if canonical.is_dir() {
        Ok(canonical)
    } else {
        Err(CliError::Boundary(BoundaryError::project(
            "project_unavailable",
            "The selected path is not a folder.",
        )))
    }
}

fn canonical_pdf_output(value: Option<PathBuf>) -> Result<PathBuf, CliError> {
    let output = value.ok_or_else(|| CliError::Usage("Missing --output FILE.pdf.".into()))?;
    if output.file_name().is_none()
        || !output
            .extension()
            .is_some_and(|extension| extension.eq_ignore_ascii_case("pdf"))
    {
        return Err(CliError::Usage(
            "--output must name a file ending in .pdf.".into(),
        ));
    }
    let absolute = if output.is_absolute() {
        output
    } else {
        std::env::current_dir()
            .map_err(|_| {
                CliError::Internal("UnderTree could not resolve the current folder.".into())
            })?
            .join(output)
    };
    let file_name = absolute
        .file_name()
        .ok_or_else(|| CliError::Usage("--output must name a PDF file.".into()))?
        .to_owned();
    let parent = absolute.parent().ok_or_else(|| {
        CliError::Boundary(BoundaryError::project(
            "pdf_destination_invalid",
            "The PDF output must have an existing local parent folder.",
        ))
    })?;
    let parent = parent.canonicalize().map_err(|_| {
        CliError::Boundary(BoundaryError::project(
            "pdf_destination_invalid",
            "The PDF output folder is unavailable.",
        ))
    })?;
    if !parent.is_dir() {
        return Err(CliError::Boundary(BoundaryError::project(
            "pdf_destination_invalid",
            "The PDF output parent must be a folder.",
        )));
    }
    Ok(parent.join(file_name))
}

fn required_text(value: Option<String>, option: &str) -> Result<String, CliError> {
    value.ok_or_else(|| CliError::Usage(format!("Missing {option} VALUE.")))
}

fn parse_options(arguments: &[OsString]) -> Result<Options, CliError> {
    let mut options = Options::default();
    let mut index = 0usize;
    while index < arguments.len() {
        let option = word(arguments.get(index), "option")?;
        match option.as_str() {
            "--json" => set_once_flag(&mut options.json, "--json")?,
            "--all" => set_once_flag(&mut options.all, "--all")?,
            "--stdin" => set_once_flag(&mut options.stdin, "--stdin")?,
            "--force" => set_once_flag(&mut options.force, "--force")?,
            "--reveal" => set_once_flag(&mut options.reveal, "--reveal")?,
            "--discard-unsaved" => {
                set_once_flag(&mut options.discard_unsaved, "--discard-unsaved")?;
            }
            "--auto-commit" => {
                if options.auto_commit.is_some() {
                    return Err(CliError::Usage(
                        "Choose only one automatic-commit option.".into(),
                    ));
                }
                options.auto_commit = Some(true);
            }
            "--no-auto-commit" => {
                if options.auto_commit.is_some() {
                    return Err(CliError::Usage(
                        "Choose only one automatic-commit option.".into(),
                    ));
                }
                options.auto_commit = Some(false);
            }
            "--private" => {
                if options.private.is_some() {
                    return Err(CliError::Usage(
                        "Choose only one repository visibility option.".into(),
                    ));
                }
                options.private = Some(true);
            }
            "--public" => {
                if options.private.is_some() {
                    return Err(CliError::Usage(
                        "Choose only one repository visibility option.".into(),
                    ));
                }
                options.private = Some(false);
            }
            "--project" => {
                index += 1;
                set_once_path(&mut options.project, arguments.get(index), "--project")?;
            }
            "--parent" => {
                index += 1;
                set_once_path(&mut options.parent, arguments.get(index), "--parent")?;
            }
            "--repository" => {
                index += 1;
                set_once_text(
                    &mut options.repository,
                    arguments.get(index),
                    "--repository",
                )?;
            }
            "--source" => {
                index += 1;
                set_once_text(&mut options.source, arguments.get(index), "--source")?;
            }
            "--path" => {
                index += 1;
                set_once_text(&mut options.path, arguments.get(index), "--path")?;
            }
            "--output" => {
                index += 1;
                set_once_path(&mut options.output, arguments.get(index), "--output")?;
            }
            "--name" => {
                index += 1;
                set_once_text(&mut options.name, arguments.get(index), "--name")?;
            }
            "--description" => {
                index += 1;
                set_once_text(
                    &mut options.description,
                    arguments.get(index),
                    "--description",
                )?;
            }
            "--message" => {
                index += 1;
                set_once_text(&mut options.message, arguments.get(index), "--message")?;
            }
            "--expected-digest" => {
                index += 1;
                set_once_text(
                    &mut options.expected_digest,
                    arguments.get(index),
                    "--expected-digest",
                )?;
            }
            "--revision" => {
                index += 1;
                set_once_u64(&mut options.revision, arguments.get(index), "--revision")?;
            }
            "--expected-revision" => {
                index += 1;
                set_once_u64(
                    &mut options.expected_revision,
                    arguments.get(index),
                    "--expected-revision",
                )?;
            }
            "--expected-policy-version" => {
                index += 1;
                set_once_u64(
                    &mut options.expected_policy_version,
                    arguments.get(index),
                    "--expected-policy-version",
                )?;
            }
            "--mark-id" => {
                index += 1;
                set_once_text(&mut options.mark_id, arguments.get(index), "--mark-id")?;
            }
            "--proposal-id" => {
                index += 1;
                set_once_text(
                    &mut options.proposal_id,
                    arguments.get(index),
                    "--proposal-id",
                )?;
            }
            "--comment-id" => {
                index += 1;
                set_once_text(&mut options.comment_id, arguments.get(index), "--comment-id")?;
            }
            "--operation" => {
                index += 1;
                set_once_text(&mut options.operation, arguments.get(index), "--operation")?;
            }
            "--rationale" => {
                index += 1;
                set_once_text(&mut options.rationale, arguments.get(index), "--rationale")?;
            }
            "--category" => {
                index += 1;
                set_once_text(&mut options.category, arguments.get(index), "--category")?;
            }
            "--interval" => {
                index += 1;
                if options.interval.is_some() {
                    return Err(CliError::Usage("Duplicate --interval option.".into()));
                }
                let value = word(arguments.get(index), "--interval value")?;
                options.interval = Some(value.parse::<u64>().map_err(|_| {
                    CliError::Usage("--interval must be 0, 5, 15, 30, or 60.".into())
                })?);
            }
            "--timeout" => {
                index += 1;
                set_once_u64(&mut options.timeout, arguments.get(index), "--timeout")?;
            }
            _ => return Err(CliError::Usage(format!("Unknown option '{option}'."))),
        }
        index += 1;
    }
    Ok(options)
}

fn set_once_path(
    target: &mut Option<PathBuf>,
    value: Option<&OsString>,
    option: &str,
) -> Result<(), CliError> {
    if target.is_some() {
        return Err(CliError::Usage(format!("Duplicate {option} option.")));
    }
    let value = value.ok_or_else(|| CliError::Usage(format!("Missing value for {option}.")))?;
    *target = Some(PathBuf::from(value));
    Ok(())
}

fn set_once_text(
    target: &mut Option<String>,
    value: Option<&OsString>,
    option: &str,
) -> Result<(), CliError> {
    if target.is_some() {
        return Err(CliError::Usage(format!("Duplicate {option} option.")));
    }
    let value = word(value, &format!("{option} value"))?;
    if value.is_empty() {
        return Err(CliError::Usage(format!("{option} cannot be empty.")));
    }
    *target = Some(value);
    Ok(())
}

fn set_once_u64(
    target: &mut Option<u64>,
    value: Option<&OsString>,
    option: &str,
) -> Result<(), CliError> {
    if target.is_some() {
        return Err(CliError::Usage(format!("Duplicate {option} option.")));
    }
    let value = word(value, &format!("{option} value"))?;
    *target = Some(
        value
            .parse()
            .map_err(|_| CliError::Usage(format!("{option} must be an unsigned integer.")))?,
    );
    Ok(())
}

fn set_once_flag(target: &mut bool, option: &str) -> Result<(), CliError> {
    if *target {
        return Err(CliError::Usage(format!("Duplicate {option} option.")));
    }
    *target = true;
    Ok(())
}

fn word(value: Option<&OsString>, label: &str) -> Result<String, CliError> {
    value
        .and_then(|value| value.to_str())
        .map(str::to_owned)
        .ok_or_else(|| CliError::Usage(format!("Missing or non-Unicode {label}.")))
}

fn reject_project_options(options: &Options) -> Result<(), CliError> {
    if options.project.is_some()
        || options.parent.is_some()
        || options.repository.is_some()
        || options.source.is_some()
        || options.path.is_some()
        || options.name.is_some()
        || options.description.is_some()
        || options.message.is_some()
        || options.expected_digest.is_some()
        || options.revision.is_some()
        || options.expected_revision.is_some()
        || options.expected_policy_version.is_some()
        || options.mark_id.is_some()
        || options.proposal_id.is_some()
        || options.comment_id.is_some()
        || options.operation.is_some()
        || options.rationale.is_some()
        || options.category.is_some()
        || options.interval.is_some()
        || options.timeout.is_some()
        || options.auto_commit.is_some()
        || options.private.is_some()
        || options.has_pdf_options()
        || options.all
        || options.stdin
        || options.discard_unsaved
    {
        Err(CliError::Usage(
            "This command does not accept project or synchronization options.".into(),
        ))
    } else {
        Ok(())
    }
}

fn reject_options_except_project(options: &Options, allow_message: bool) -> Result<(), CliError> {
    if options.parent.is_some()
        || options.repository.is_some()
        || options.source.is_some()
        || options.path.is_some()
        || options.name.is_some()
        || options.description.is_some()
        || (!allow_message && options.message.is_some())
        || options.expected_digest.is_some()
        || options.revision.is_some()
        || options.expected_revision.is_some()
        || options.expected_policy_version.is_some()
        || options.mark_id.is_some()
        || options.proposal_id.is_some()
        || options.comment_id.is_some()
        || options.operation.is_some()
        || options.rationale.is_some()
        || options.category.is_some()
        || options.interval.is_some()
        || options.timeout.is_some()
        || options.auto_commit.is_some()
        || options.private.is_some()
        || options.has_pdf_options()
        || options.all
        || options.stdin
        || options.discard_unsaved
    {
        Err(CliError::Usage(if allow_message {
            "This command accepts only --project PATH, --message TEXT, and optional --json.".into()
        } else {
            "This command accepts only --project PATH and optional --json.".into()
        }))
    } else {
        Ok(())
    }
}

fn reject_conversion_options(options: &Options) -> Result<(), CliError> {
    if options.parent.is_some()
        || options.repository.is_some()
        || options.name.is_some()
        || options.description.is_some()
        || options.message.is_some()
        || options.expected_digest.is_some()
        || options.revision.is_some()
        || options.expected_revision.is_some()
        || options.expected_policy_version.is_some()
        || options.mark_id.is_some()
        || options.proposal_id.is_some()
        || options.comment_id.is_some()
        || options.operation.is_some()
        || options.rationale.is_some()
        || options.category.is_some()
        || options.interval.is_some()
        || options.timeout.is_some()
        || options.auto_commit.is_some()
        || options.private.is_some()
        || options.has_pdf_options()
        || options.all
        || options.stdin
        || options.discard_unsaved
    {
        Err(CliError::Usage(
            "Conversion commands accept --project PATH, one command-specific relative source/path option, and optional --json."
                .into(),
        ))
    } else {
        Ok(())
    }
}

fn reject_pdf_export_options(options: &Options) -> Result<(), CliError> {
    if options.parent.is_some()
        || options.repository.is_some()
        || options.path.is_some()
        || options.name.is_some()
        || options.description.is_some()
        || options.message.is_some()
        || options.expected_digest.is_some()
        || options.revision.is_some()
        || options.expected_revision.is_some()
        || options.expected_policy_version.is_some()
        || options.mark_id.is_some()
        || options.proposal_id.is_some()
        || options.comment_id.is_some()
        || options.operation.is_some()
        || options.rationale.is_some()
        || options.category.is_some()
        || options.interval.is_some()
        || options.timeout.is_some()
        || options.auto_commit.is_some()
        || options.private.is_some()
        || options.all
        || options.stdin
        || options.discard_unsaved
    {
        Err(CliError::Usage(
            "PDF export accepts --project PATH, --source RELATIVE.typ, --output FILE.pdf, optional --force, optional --reveal, and optional --json."
                .into(),
        ))
    } else {
        Ok(())
    }
}

fn doctor_report(status: GitHubStatus) -> DoctorReport {
    let mut recommendations = Vec::new();
    let diagnosis = if !status.auth_configured {
        recommendations
            .push("Install an official UnderTree build with its public OAuth identity.".into());
        "This UnderTree build has no GitHub OAuth identity.".into()
    } else if !status.authenticated {
        recommendations.push("Run 'undertree-typst github login'.".into());
        "No reusable GitHub session is available in the operating-system credential store.".into()
    } else if let Some(project) = status.project.as_ref() {
        if let Some(error) = project.error.as_ref() {
            recommendations
                .push("Resolve the reported repository condition, then rerun doctor.".into());
            format!("The project link is approved, but Git inspection failed: {error}")
        } else if project.dirty && project.ahead == 0 {
            recommendations.push(
                "Run 'undertree-typst git commit --project PATH --message TEXT', then 'undertree-typst git sync --project PATH'."
                    .into(),
            );
            if project.interval_minutes == 0 {
                recommendations.push(
                    "Automatic synchronization is off; configure an interval and opt into automatic commits only if that behavior is desired."
                        .into(),
                );
            }
            format!(
                "The GitHub bridge is valid, but the working tree has {} visible uncommitted change(s). Git sync pushes commits, not uncommitted files.",
                project.changes.len()
            )
        } else if project.behind > 0 {
            recommendations.push("Run 'undertree-typst git sync --project PATH'.".into());
            format!(
                "The local branch is {} commit(s) behind GitHub.",
                project.behind
            )
        } else if project.ahead > 0 {
            recommendations.push("Run 'undertree-typst git push --project PATH'.".into());
            format!(
                "The local branch is {} commit(s) ahead of GitHub.",
                project.ahead
            )
        } else {
            "The GitHub authorization, project approval, repository, and branch are ready to synchronize."
                .into()
        }
    } else {
        recommendations.push(
            "Run 'undertree-typst github link --project PATH --repository OWNER/NAME'.".into(),
        );
        "The folder has no valid UnderTree project approval for the connected GitHub account."
            .into()
    };
    let ok = status.authenticated
        && status
            .project
            .as_ref()
            .is_some_and(|project| project.error.is_none());
    DoctorReport {
        ok,
        diagnosis,
        recommendations,
        status,
    }
}

fn human_doctor(report: &DoctorReport) -> Result<(), CliError> {
    println!("Diagnosis: {}", report.diagnosis);
    for recommendation in &report.recommendations {
        println!("Next: {recommendation}");
    }
    println!();
    human_status(&report.status)
}

fn human_status(status: &GitHubStatus) -> Result<(), CliError> {
    println!(
        "GitHub account: {}",
        status
            .account
            .as_ref()
            .map(|account| format!("@{}", account.login))
            .unwrap_or_else(|| "not connected".into())
    );
    let Some(project) = status.project.as_ref() else {
        println!("Project bridge: not linked or not approved");
        return Ok(());
    };
    println!("Repository: {}", project.repository);
    println!("Branch: {}", project.branch);
    println!(
        "Access: {}",
        if project.can_push {
            "read/write"
        } else {
            "read-only"
        }
    );
    println!("Ahead/behind: {}/{}", project.ahead, project.behind);
    println!(
        "Working tree: {}",
        if project.dirty {
            format!("{} visible change(s)", project.changes.len())
        } else {
            "clean".into()
        }
    );
    println!(
        "Automatic sync: {}{}",
        if project.interval_minutes == 0 {
            "off".into()
        } else {
            format!("every {} minutes", project.interval_minutes)
        },
        if project.auto_commit {
            " with automatic commits"
        } else {
            ""
        }
    );
    if let Some(error) = project.error.as_ref() {
        println!("Repository warning: {error}");
    }
    Ok(())
}

fn output<T: Serialize>(
    value: &T,
    json: bool,
    human: impl FnOnce() -> Result<(), CliError>,
) -> Result<(), CliError> {
    if json {
        let payload = serde_json::to_string_pretty(value)
            .map_err(|_| CliError::Internal("UnderTree could not serialize CLI output.".into()))?;
        println!("{payload}");
        Ok(())
    } else {
        human()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_unicode_project_paths_and_sync_options() {
        let options = parse_options(&[
            OsString::from("--project"),
            OsString::from("C:\\Projekte\\Förderung"),
            OsString::from("--message"),
            OsString::from("Typst conversion drafts"),
            OsString::from("--json"),
        ])
        .expect("valid options should parse");
        assert_eq!(
            options.project,
            Some(PathBuf::from("C:\\Projekte\\Förderung"))
        );
        assert_eq!(options.message.as_deref(), Some("Typst conversion drafts"));
        assert!(options.json);
    }

    #[test]
    fn parses_typed_document_and_remote_options() {
        let options = parse_options(&[
            OsString::from("--path"),
            OsString::from("chapters/intro.typ"),
            OsString::from("--expected-revision"),
            OsString::from("19"),
            OsString::from("--expected-policy-version"),
            OsString::from("7"),
            OsString::from("--stdin"),
            OsString::from("--timeout"),
            OsString::from("45"),
            OsString::from("--mark-id"),
            OsString::from("mark-1"),
            OsString::from("--proposal-id"),
            OsString::from("proposal-1"),
            OsString::from("--operation"),
            OsString::from("replace"),
            OsString::from("--rationale"),
            OsString::from("tighten"),
        ])
        .expect("valid document options");
        assert_eq!(options.path.as_deref(), Some("chapters/intro.typ"));
        assert_eq!(options.expected_revision, Some(19));
        assert_eq!(options.expected_policy_version, Some(7));
        assert!(options.stdin);
        assert_eq!(options.timeout, Some(45));
        assert_eq!(options.mark_id.as_deref(), Some("mark-1"));
        assert_eq!(options.proposal_id.as_deref(), Some("proposal-1"));
        assert_eq!(options.operation.as_deref(), Some("replace"));
        assert_eq!(options.rationale.as_deref(), Some("tighten"));
    }

    #[test]
    fn parses_explicit_pdf_export_options() {
        let options = parse_options(&[
            OsString::from("--output"),
            OsString::from("C:\\Förderung\\Antrag.pdf"),
            OsString::from("--force"),
            OsString::from("--reveal"),
        ])
        .expect("valid PDF options");
        assert_eq!(
            options.output,
            Some(PathBuf::from("C:\\Förderung\\Antrag.pdf"))
        );
        assert!(options.force);
        assert!(options.reveal);
    }

    #[test]
    fn rejects_unknown_duplicate_and_invalid_options() {
        assert!(parse_options(&[OsString::from("--token")]).is_err());
        assert!(
            parse_options(&[
                OsString::from("--project"),
                OsString::from("one"),
                OsString::from("--project"),
                OsString::from("two"),
            ])
            .is_err()
        );
        assert!(parse_options(&[OsString::from("--interval"), OsString::from("never")]).is_err());
        assert!(parse_options(&[OsString::from("--json"), OsString::from("--json")]).is_err());
        assert!(parse_options(&[OsString::from("--private"), OsString::from("--public")]).is_err());
        assert!(
            parse_options(&[
                OsString::from("--output"),
                OsString::from("one.pdf"),
                OsString::from("--output"),
                OsString::from("two.pdf"),
            ])
            .is_err()
        );
        assert!(parse_options(&[OsString::from("--force"), OsString::from("--force")]).is_err());
        assert!(parse_options(&[OsString::from("--reveal"), OsString::from("--reveal")]).is_err());
    }

    #[test]
    fn unrelated_commands_reject_pdf_only_options() {
        let options = parse_options(&[
            OsString::from("--project"),
            OsString::from("writing"),
            OsString::from("--source"),
            OsString::from("main.typ"),
            OsString::from("--output"),
            OsString::from("paper.pdf"),
        ])
        .expect("options should parse before the command allowlist is applied");
        assert!(reject_conversion_options(&options).is_err());

        let options = parse_options(&[
            OsString::from("--project"),
            OsString::from("writing"),
            OsString::from("--force"),
        ])
        .expect("options should parse before the command allowlist is applied");
        assert!(reject_options_except_project(&options, false).is_err());
    }

    #[test]
    fn canonical_pdf_output_requires_an_existing_parent_and_pdf_suffix() {
        let directory = tempfile::tempdir().expect("temporary PDF parent");
        let output = canonical_pdf_output(Some(directory.path().join("paper.pdf")))
            .expect("valid output should resolve");
        assert_eq!(
            output.parent(),
            Some(
                directory
                    .path()
                    .canonicalize()
                    .expect("temporary directory should canonicalize")
                    .as_path()
            )
        );
        assert!(canonical_pdf_output(Some(directory.path().join("paper.txt"))).is_err());
        assert!(
            canonical_pdf_output(Some(directory.path().join("missing").join("paper.pdf"))).is_err()
        );
    }

    #[test]
    fn recognizes_only_a_valid_gui_project_request() {
        let folder = tempfile::tempdir().expect("temporary project");
        let request = gui_project_request(&[
            OsString::from("open"),
            OsString::from("--project"),
            folder.path().as_os_str().to_owned(),
        ])
        .expect("open should be routed to the GUI")
        .expect("valid project should be accepted");
        assert_eq!(
            request.root,
            folder.path().canonicalize().expect("canonical root")
        );
        assert!(request.preferred.is_none());
        assert!(!request.json);

        assert!(gui_project_request(&[OsString::from("github")]).is_none());
        assert!(
            gui_project_request(&[
                OsString::from("open"),
                OsString::from("--project"),
                folder.path().as_os_str().to_owned(),
                OsString::from("--repository"),
                OsString::from("owner/name"),
            ])
            .expect("open should be routed")
            .is_err()
        );
    }

    #[test]
    fn forwarded_open_resolves_relative_projects_against_the_sender_cwd() {
        let folder = tempfile::tempdir().expect("temporary cwd");
        let project = folder.path().join("Writing");
        std::fs::create_dir(&project).expect("project directory");
        let arguments = vec![
            "undertree-typst".into(),
            "open".into(),
            "--project".into(),
            "Writing".into(),
            "--source".into(),
            "draft.typ".into(),
        ];
        let request = forwarded_open_request(
            &arguments,
            folder.path().to_str().expect("Unicode temporary path"),
        )
        .expect("forwarded request");
        assert_eq!(
            request,
            RemoteRequest::ProjectOpen {
                project: project.canonicalize().expect("canonical project"),
                source: Some("draft.typ".into()),
                discard_unsaved: false,
            }
        );
    }

    #[test]
    fn help_keeps_the_fast_native_git_and_conversion_surface_discoverable() {
        for command in [
            "git status",
            "git branches",
            "git commit",
            "git pull",
            "git push",
            "git sync",
            "convert latex-to-typst",
            "convert markdown-to-typst",
            "convert typst-to-latex",
            "compile --project",
            "pdf export --project",
            "app pdf export",
            "app pdf reveal",
            "project status",
            "project files",
            "document read",
            "document save",
            "bibliography create",
            "app document replace",
            "app agent context",
            "app agent replace",
            "app review context",
            "app review propose",
            "app review comment",
            "github create",
            "github unlink",
            "github logout",
        ] {
            assert!(HELP.contains(command), "missing CLI command: {command}");
        }
        assert!(HELP.contains("latex-to-typst --project PATH [--source RELATIVE.tex]"));
    }

    #[test]
    fn validates_cli_latex_conversion_drafts_and_reports_failures() {
        let root = tempfile::tempdir().expect("temporary LaTeX project");
        std::fs::create_dir(root.path().join("nested")).expect("nested source folder");
        std::fs::write(
            root.path().join("nested/selected.tex"),
            "\\documentclass{article}\n\\begin{document}\nSelected.\n\\end{document}\n",
        )
        .expect("selected LaTeX source");
        std::fs::write(
            root.path().join("other.tex"),
            "\\documentclass{article}\n\\begin{document}\nOther.\n\\end{document}\n",
        )
        .expect("unselected LaTeX source");
        let mut selected =
            crate::latex::import_project_tex_file(root.path(), "nested/selected.tex")
                .expect("relative project source should remain confined");
        assert!(root.path().join("nested/selected.typ").is_file());
        assert!(!root.path().join("other.typ").exists());
        crate::latex::validate_generated_typst_drafts(
            root.path(),
            &mut selected,
            &CompilerAssets::load(),
        );
        assert_eq!(
            selected.compile_succeeded,
            Some(true),
            "validation warnings: {:#?}",
            selected.warnings
        );
        let serialized = serde_json::to_value(&selected).expect("serialize conversion report");
        assert_eq!(serialized["compileSucceeded"], true);

        std::fs::write(
            root.path().join("valid.tex"),
            "\\documentclass{article}\n\\begin{document}\nValid.\n\\end{document}\n",
        )
        .expect("valid LaTeX source");
        let mut valid = crate::latex::import_project_tex_file(root.path(), "valid.tex")
            .expect("valid conversion");
        crate::latex::validate_generated_typst_drafts(
            root.path(),
            &mut valid,
            &CompilerAssets::load(),
        );
        assert_eq!(
            valid.compile_succeeded,
            Some(true),
            "validation warnings: {:#?}",
            valid.warnings
        );

        std::fs::write(
            root.path().join("broken.tex"),
            "\\documentclass{article}\n\\begin{document}\nBroken.\n\\end{document}\n",
        )
        .expect("broken fixture LaTeX source");
        std::fs::write(root.path().join("broken.typ"), "*unclosed")
            .expect("broken existing Typst draft");
        let mut broken = crate::latex::import_project_tex_file(root.path(), "broken.tex")
            .expect("existing draft report");
        crate::latex::validate_generated_typst_drafts(
            root.path(),
            &mut broken,
            &CompilerAssets::load(),
        );
        assert_eq!(broken.compile_succeeded, Some(false));
        assert!(
            broken
                .warnings
                .iter()
                .any(|warning| warning.kind == "typst-compile")
        );
        assert_eq!(
            std::fs::read_to_string(root.path().join("broken.typ"))
                .expect("preserved broken draft"),
            "*unclosed"
        );
        for invalid in ["../outside.tex", "valid.typ"] {
            assert!(validate_relative_extension(invalid, "tex", "--source").is_err());
            assert!(crate::latex::import_project_tex_file(root.path(), invalid).is_err());
        }

        std::fs::write(
            root.path().join("valid.undertree-export.tex"),
            "\\documentclass{article}",
        )
        .expect("generated export fixture");
        assert!(
            crate::latex::import_project_tex_file(root.path(), "valid.undertree-export.tex")
                .is_err()
        );

        let outside = tempfile::tempdir().expect("outside source folder");
        std::fs::write(
            outside.path().join("outside.tex"),
            "\\documentclass{article}",
        )
        .expect("outside LaTeX source");
        #[cfg(windows)]
        {
            if std::os::windows::fs::symlink_file(
                outside.path().join("outside.tex"),
                root.path().join("linked.tex"),
            )
            .is_ok()
            {
                assert!(crate::latex::import_project_tex_file(root.path(), "linked.tex").is_err());
            }
            if std::os::windows::fs::symlink_dir(outside.path(), root.path().join("linked-parent"))
                .is_ok()
            {
                assert!(
                    crate::latex::import_project_tex_file(root.path(), "linked-parent/outside.tex")
                        .is_err()
                );
            }
        }
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(
                outside.path().join("outside.tex"),
                root.path().join("linked.tex"),
            )
            .expect("file symlink fixture");
            assert!(crate::latex::import_project_tex_file(root.path(), "linked.tex").is_err());
            std::os::unix::fs::symlink(outside.path(), root.path().join("linked-parent"))
                .expect("directory symlink fixture");
            assert!(
                crate::latex::import_project_tex_file(root.path(), "linked-parent/outside.tex")
                    .is_err()
            );
        }
    }
}
