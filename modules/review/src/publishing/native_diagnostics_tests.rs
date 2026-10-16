//! Synthetic fixtures exercise the real owned supervisor; only the explicitly named pinned
//! compiler case qualifies emitted Typst diagnostics. No synthetic PDF is a renderer claim.
use super::*;
use crate::{Operation, SourceRequest};
use std::fs;
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

fn reply_faults() -> &'static Mutex<BTreeSet<PathBuf>> {
    static FAULTS: OnceLock<Mutex<BTreeSet<PathBuf>>> = OnceLock::new();
    FAULTS.get_or_init(|| Mutex::new(BTreeSet::new()))
}

pub(super) fn before_reply(info: &Path) -> Result<()> {
    if reply_faults().lock().unwrap().remove(info) {
        return Err(publication_unknown());
    }
    Ok(())
}

struct Fixture {
    _temporary: tempfile::TempDir,
    service: Arc<Service>,
    project: String,
    root: PathBuf,
    observed: RootObservation,
    owner: String,
}

impl Fixture {
    fn new(text: &str) -> Self {
        let temporary = tempfile::tempdir().unwrap();
        let root = temporary.path().join("project");
        fs::create_dir(&root).unwrap();
        fs::write(root.join("main.typ"), text).unwrap();
        let service = Service::new(temporary.path().join("state")).unwrap();
        let project = service
            .local(Operation::AddProject {
                root: root.to_str().unwrap().into(),
            })
            .unwrap()["id"]
            .as_str()
            .unwrap()
            .to_owned();
        let owner = service.connect_native_editor("main").unwrap()["ownerId"]
            .as_str()
            .unwrap()
            .to_owned();
        let observed = RootedRoot::observe(&root).unwrap();
        Self {
            _temporary: temporary,
            service,
            project,
            root,
            observed,
            owner,
        }
    }

    fn request(&self) -> SourceRequest {
        SourceRequest {
            operation: Operation::Compile {
                project: self.project.clone(),
                path: "main.typ".into(),
                revision: digest(&fs::read_to_string(self.root.join("main.typ")).unwrap()),
            },
            source_epoch: 0,
            expected_root: Some(self.observed),
        }
    }

    async fn synthetic(&self, script: &str, timeout: Duration) -> Result<Value> {
        let mut command = tokio::process::Command::new("/bin/sh");
        command
            .arg("-c")
            .arg(script)
            .arg("undertree-owned-synthetic-compiler");
        self.with_command(command, timeout).await
    }

    async fn with_command(
        &self,
        command: tokio::process::Command,
        timeout: Duration,
    ) -> Result<Value> {
        self.service
            .compile_typst_admit(
                SourceBinding::new(&self.project, "main.typ", 0)
                    .rooted(Some(self.observed))
                    .guarded(true),
                Some(("main".into(), self.owner.clone())),
                &digest(&fs::read_to_string(self.root.join("main.typ")).unwrap()),
                CompilerInvocation {
                    command,
                    timeout,
                    native_report: true,
                },
            )
            .await
    }
}

#[tokio::test]
async fn native_projection_never_relaxes_operation_owner_root_or_epoch_admission() {
    let fixture = Fixture::new("Native admission");
    for kind in 0..6 {
        let mut request = fixture.request();
        let owner = if kind == 0 { "retired" } else { &fixture.owner };
        if kind == 1 {
            request.expected_root = None;
        }
        if kind == 2 {
            request.expected_root = Some(RootObservation::new(0, 0));
        }
        if kind == 3 {
            request.source_epoch = 1;
        }
        if kind == 4 {
            request.operation = Operation::Projects;
        }
        let window = if kind == 5 { "other" } else { "main" };
        let error = fixture
            .service
            .compile_typst_native_report(window, owner, request)
            .await
            .unwrap_err();
        assert_eq!(
            error.code,
            [
                "stale_session",
                "stale_root",
                "stale_root",
                "stale_document",
                "scope",
                "stale_session"
            ][kind]
        );
        assert!(fixture.service.compile_lock.try_lock().is_ok());
    }
    assert!(!fixture.service.publishing_root().join("pdfs").exists());
}

#[tokio::test]
async fn synthetic_spawn_failure_is_an_admitted_empty_incomplete_report() {
    let fixture = Fixture::new("= Missing compiler\n");
    let missing = fixture._temporary.path().join("not-a-compiler");
    let reply = fixture
        .with_command(
            tokio::process::Command::new(missing),
            Duration::from_secs(1),
        )
        .await
        .unwrap();
    assert_eq!(reply["status"], "failed");
    assert_eq!(reply["error"]["code"], "typst");
    assert_eq!(reply["report"]["captureComplete"], false);
    assert_eq!(reply["report"]["text"], "");
    assert_eq!(reply["report"]["rows"], json!([]));
    assert!(fixture.service.compile_lock.try_lock().is_ok());
}

#[cfg(unix)]
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn synthetic_native_report_rechecks_retired_owner_and_replaced_root_before_publication() {
    for replace_root in [false, true] {
        let fixture = Arc::new(Fixture::new("= Native final guards\n"));
        fixture
            .synthetic(SYNTHETIC_PDF, Duration::from_secs(5))
            .await
            .unwrap();
        let (_, info) = fixture
            .service
            .pdf_paths(&fixture.project, "main.typ")
            .unwrap();
        let old_info = fs::read(&info).unwrap();
        let marker = fixture._temporary.path().join("ready");
        let release = fixture._temporary.path().join("release");
        let script = format!(
            "{SYNTHETIC_PDF}; printf ready > \"$MARKER\"; while [ ! -f \"$RELEASE\" ]; do :; done"
        );
        let mut command = tokio::process::Command::new("/bin/sh");
        command
            .arg("-c")
            .arg(script)
            .arg("synthetic final guard")
            .env("MARKER", &marker)
            .env("RELEASE", &release);
        let worker = fixture.clone();
        let pending =
            tokio::spawn(async move { worker.with_command(command, Duration::from_secs(5)).await });
        let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
        while !fs::read(&marker).is_ok_and(|bytes| bytes == b"ready") {
            assert!(tokio::time::Instant::now() < deadline);
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        if replace_root {
            fs::rename(&fixture.root, fixture._temporary.path().join("held-root")).unwrap();
            fs::create_dir(&fixture.root).unwrap();
            fs::write(fixture.root.join("main.typ"), "= Native final guards\n").unwrap();
        } else {
            fixture.service.connect_native_editor("main").unwrap();
        }
        fs::write(release, b"continue").unwrap();
        let error = pending.await.unwrap().unwrap_err();
        assert_eq!(
            error.code,
            if replace_root {
                "stale_root"
            } else {
                "stale_session"
            }
        );
        assert_eq!(fs::read(&info).unwrap(), old_info);
        assert!(fixture.service.compile_lock.try_lock().is_ok());
    }
}

#[cfg(unix)]
#[tokio::test]
async fn synthetic_unqualified_child_is_complete_redacted_text_only_with_bound_provenance() {
    let fixture = Fixture::new("= Synthetic\n");
    let reply = fixture.synthetic("printf 'stdout must not enter diagnostics'; printf '%s:1:0: error: synthetic forged header\\nmissing %s\\n' \"$PWD/main.typ\" \"$5\" >&2; exit 9",Duration::from_secs(5)).await.unwrap();
    assert_eq!(reply["status"], "failed");
    assert_eq!(reply["error"]["code"], "typst");
    assert_eq!(reply["report"]["captureComplete"], true);
    assert_eq!(reply["report"]["rows"], json!([]));
    assert_eq!(reply["report"]["sourceCandidates"], json!([]));
    let text = reply["report"]["text"].as_str().unwrap();
    assert!(text.contains("synthetic forged header") && text.contains("[private]"));
    assert!(!text.contains("stdout must") && !text.contains(".undertree-build-"));
    let provenance = &reply["report"]["provenance"];
    assert_eq!(provenance["expectedRoot"], json!(fixture.observed));
    assert_eq!(provenance["sourceDigest"], digest("= Synthetic\n"));
    assert_eq!(provenance["instanceId"], fixture.service.instance_id());
    let serialized = serde_json::to_string(&reply).unwrap();
    assert!(!serialized.contains(&fixture.owner));
    assert!(!serialized.contains("rootBoundDigest") && !serialized.contains("snapshotId"));
    assert!(serialized.len() <= MAX_NATIVE_OVERHEAD);
}

#[cfg(unix)]
#[tokio::test]
async fn synthetic_eof_then_signal_is_incomplete_but_normal_nonzero_exit_is_complete() {
    let fixture = Fixture::new("= Exit status control\n");
    let baseline = fixture
        .synthetic(SYNTHETIC_PDF, Duration::from_secs(5))
        .await
        .unwrap();
    assert_eq!(baseline["status"], "succeeded");
    let (_, info) = fixture
        .service
        .pdf_paths(&fixture.project, "main.typ")
        .unwrap();
    let old_info = fs::read(&info).unwrap();
    let previous: Preview = serde_json::from_slice(&old_info).unwrap();
    let pdf = info.with_file_name(previous.pdf);
    let old_pdf = fs::read(&pdf).unwrap();

    for (finish, complete) in [("exit 7", true), ("trap - TERM; kill -TERM \"$$\"", false)] {
        // Real child stderr reaches EOF before wait observes either normal exit or SIGTERM.
        // These author-forged headers never qualify the unknown /bin/sh executable.
        let tail = if complete { "$PWD" } else { "${PWD%?}" };
        let script = format!(
            "printf '%s:1:0: error: synthetic exit fixture\\n%s' \"$PWD/main.typ\" \"{tail}\" >&2; exec 2>&-; {finish}"
        );
        let reply = fixture
            .synthetic(&script, Duration::from_secs(5))
            .await
            .unwrap();
        assert_eq!(reply["status"], "failed");
        assert_eq!(reply["error"]["code"], "typst");
        assert_eq!(reply["report"]["captureComplete"], complete, "{finish}");
        assert_eq!(reply["report"]["truncated"], false);
        assert_eq!(reply["report"]["rows"], json!([]));
        assert_eq!(reply["report"]["sourceCandidates"], json!([]));
        let text = reply["report"]["text"].as_str().unwrap();
        assert!(text.contains("synthetic exit fixture") && text.contains("[private]"));
        assert!(!text.contains(".undertree-build-"));
        assert!(reply.get("preview").is_none());
        assert_eq!(fs::read(&info).unwrap(), old_info);
        assert_eq!(fs::read(&pdf).unwrap(), old_pdf);
        assert!(fixture.service.compile_lock.try_lock().is_ok());
    }
}

#[cfg(unix)]
#[tokio::test]
async fn synthetic_timeout_preserves_confirmed_prefix_and_redacts_cut_root_without_eof() {
    let fixture = Fixture::new("= Timeout\n");
    let reply = fixture
        .synthetic(
            "printf 'confirmed prefix\\n%s' \"${PWD%?}\" >&2; while :; do :; done",
            Duration::from_millis(200),
        )
        .await
        .unwrap();
    assert_eq!(reply["error"]["code"], "timeout");
    assert_eq!(reply["report"]["captureComplete"], false);
    assert_eq!(reply["report"]["rows"], json!([]));
    assert_eq!(reply["report"]["text"], "confirmed prefix\n[private]");
    assert!(fixture.service.compile_lock.try_lock().is_ok());
    assert!(!fs::read_dir(fixture.service.publishing_root())
        .unwrap()
        .any(|entry| entry
            .unwrap()
            .file_name()
            .to_string_lossy()
            .starts_with(".undertree-build-")));
}

#[cfg(unix)]
#[tokio::test]
async fn synthetic_overflow_returns_bounded_incomplete_report_and_reaps_real_writer() {
    let fixture = Fixture::new("= Overflow\n");
    let reply = fixture.synthetic("printf '%s:1:0: error: synthetic\\n' \"$PWD/main.typ\" >&2; i=0; while [ \"$i\" -lt 2049 ]; do printf '%064d' 0 >&2; i=$((i+1)); done; while :; do :; done",Duration::from_secs(5)).await.unwrap();
    assert_eq!(reply["error"]["code"], "limit");
    assert_eq!(reply["report"]["captureComplete"], false);
    assert_eq!(reply["report"]["truncated"], true);
    assert_eq!(reply["report"]["rows"], json!([]));
    assert!(serde_json::to_vec(&reply["report"]).unwrap().len() <= MAX_NATIVE_REPORT);
    assert!(fixture.service.compile_lock.try_lock().is_ok());
}

#[cfg(target_os = "linux")]
#[tokio::test]
async fn dependency_report_overflow_is_incomplete_native_failure_and_keeps_last_good() {
    let fixture = Fixture::new("= Dependency production bound\n");
    fixture
        .synthetic(SYNTHETIC_PDF, Duration::from_secs(5))
        .await
        .unwrap();
    let (_, info) = fixture
        .service
        .pdf_paths(&fixture.project, "main.typ")
        .unwrap();
    let metadata = fs::read(&info).unwrap();
    let previous: Preview = serde_json::from_slice(&metadata).unwrap();
    let pdf = info.with_file_name(previous.pdf);
    let previous_pdf = fs::read(&pdf).unwrap();
    let entries = fs::read_dir(fixture.service.publishing_root())
        .unwrap()
        .map(|entry| entry.unwrap().file_name())
        .collect::<BTreeSet<_>>();
    let prefix = r#"{"inputs":["main.typ"]}"#;
    // The child remains running after the excess byte; only the owned supervisor stops it.
    let script = format!(
        "printf '%s\\n' '%PDF-owned synthetic fixture'; exec 3>\"$9\"; printf '%s' '{prefix}' >&3; printf '%{padding}s' '' >&3; while :; do :; done",
        padding = MAX_DEPENDENCY_LIST + 1 - prefix.len()
    );
    let reply = fixture
        .synthetic(&script, Duration::from_secs(20))
        .await
        .unwrap();
    assert_eq!(reply["status"], "failed");
    assert_eq!(reply["error"]["code"], "limit");
    assert!(reply["error"]["message"]
        .as_str()
        .unwrap()
        .contains("dependency report"));
    assert_eq!(reply["report"]["captureComplete"], false);
    assert_eq!(reply["report"]["rows"], json!([]));
    assert!(reply.get("preview").is_none());
    let deadline = tokio::time::Instant::now() + Duration::from_secs(15);
    loop {
        if let Ok(guard) = fixture.service.compile_lock.try_lock() {
            assert_eq!(fs::read(&info).unwrap(), metadata);
            assert_eq!(fs::read(&pdf).unwrap(), previous_pdf);
            assert_eq!(
                fs::read_dir(fixture.service.publishing_root())
                    .unwrap()
                    .map(|entry| entry.unwrap().file_name())
                    .collect::<BTreeSet<_>>(),
                entries
            );
            drop(guard);
            break;
        }
        assert!(tokio::time::Instant::now() < deadline);
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
}

#[cfg(unix)]
const SYNTHETIC_PDF: &str = "[ \"$5\" = - ] || exit 77; printf '%s\\n' '%PDF-owned synthetic fixture'; printf '%s' '{\"inputs\":[\"main.typ\"]}' > \"$9\"";

// One actual owned child, no descendants. These generated bytes only test the PDF pipe contract.
#[cfg(unix)]
const SYNTHETIC_PDF_STREAM: &str = r#"
import os, sys, time
assert sys.argv[5] == '-'
with open(sys.argv[9], 'w') as deps:
    deps.write('{"inputs":["main.typ"]}')
remaining = int(os.environ['PDF_BYTES'])
header = b'%PDF-'[:remaining]
os.write(1, header)
remaining -= len(header)
block = 0
while remaining:
    chunk = b'x' * min(8192, remaining)
    written = os.write(1, chunk)
    remaining -= written
    if block % 256 == 0:
        os.write(2, b'synthetic concurrent diagnostic\n' + b'd' * 2048 + b'\n')
    block += 1
if 'MARKER' in os.environ:
    with open(os.environ['MARKER'], 'w') as marker:
        marker.write(str(os.getpid()) + '\n' + os.getcwd() + '\n')
    while not os.path.exists(os.environ['RELEASE']):
        time.sleep(0.01)
    os.write(1, b'!')
"#;

#[cfg(unix)]
fn synthetic_stream_command(length: usize) -> tokio::process::Command {
    let mut command = tokio::process::Command::new("/usr/bin/python3");
    command
        .arg("-c")
        .arg(SYNTHETIC_PDF_STREAM)
        .env("PDF_BYTES", length.to_string());
    command
}

#[cfg(unix)]
#[tokio::test]
async fn synthetic_stdout_requires_valid_eof_and_enforces_cap_with_concurrent_stderr() {
    let fixture = Fixture::new("= PDF stdout bounds\n");
    fixture
        .synthetic(SYNTHETIC_PDF, Duration::from_secs(5))
        .await
        .unwrap();
    let (_, info) = fixture
        .service
        .pdf_paths(&fixture.project, "main.typ")
        .unwrap();
    let entries = || {
        fs::read_dir(fixture.service.publishing_root())
            .unwrap()
            .map(|entry| entry.unwrap().file_name())
            .collect::<BTreeSet<_>>()
    };
    let initial_entries = entries();
    for length in [128 * 1024, MAX_PDF, MAX_PDF + 1, 0] {
        let old_info = fs::read(&info).unwrap();
        let previous: Preview = serde_json::from_slice(&old_info).unwrap();
        let old_path = info.with_file_name(previous.pdf);
        let old_pdf = fs::read(&old_path).unwrap();
        let reply = fixture
            .with_command(synthetic_stream_command(length), Duration::from_secs(10))
            .await
            .unwrap();
        if (1..=MAX_PDF).contains(&length) {
            assert_eq!(reply["status"], "succeeded");
            assert_eq!(reply["report"]["captureComplete"], true);
            assert!(reply["report"]["text"]
                .as_str()
                .unwrap()
                .contains("synthetic concurrent diagnostic"));
            let bytes = base64::engine::general_purpose::STANDARD
                .decode(reply["preview"]["base64"].as_str().unwrap())
                .unwrap();
            assert_eq!(bytes.len(), length);
            assert!(bytes.starts_with(b"%PDF-"));
            let installed: Preview = serde_json::from_slice(&fs::read(&info).unwrap()).unwrap();
            assert_eq!(fs::read(info.with_file_name(installed.pdf)).unwrap(), bytes);
        } else {
            assert_eq!(reply["status"], "failed");
            assert_eq!(
                reply["error"]["code"],
                if length == 0 { "typst" } else { "limit" }
            );
            if length > MAX_PDF {
                assert!(reply["error"]["message"]
                    .as_str()
                    .unwrap()
                    .contains("16 MiB"));
                assert_eq!(reply["report"]["captureComplete"], false);
            }
            assert!(reply.get("preview").is_none());
            assert_eq!(fs::read(&info).unwrap(), old_info);
            assert_eq!(fs::read(old_path).unwrap(), old_pdf);
        }
        assert_eq!(reply["report"]["rows"], json!([]));
        assert_eq!(reply["report"]["sourceCandidates"], json!([]));
        assert!(fixture.service.compile_lock.try_lock().is_ok());
        assert_eq!(entries(), initial_entries);
    }
}

#[cfg(unix)]
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn synthetic_stdout_partial_timeout_and_caller_drop_keep_files_and_reap_before_release() {
    for dropped_caller in [false, true] {
        let fixture = Arc::new(Fixture::new("= Held PDF pipe\n"));
        fixture
            .synthetic(SYNTHETIC_PDF, Duration::from_secs(5))
            .await
            .unwrap();
        let (_, info) = fixture
            .service
            .pdf_paths(&fixture.project, "main.typ")
            .unwrap();
        let old_info = fs::read(&info).unwrap();
        let previous: Preview = serde_json::from_slice(&old_info).unwrap();
        let pdf = info.with_file_name(previous.pdf);
        let old_pdf = fs::read(&pdf).unwrap();
        let marker = fixture._temporary.path().join("stream-ready");
        let release = fixture._temporary.path().join("stream-release");
        let length = if dropped_caller { MAX_PDF } else { 32768 };
        let mut command = synthetic_stream_command(length);
        command.env("MARKER", &marker).env("RELEASE", &release);
        let worker = fixture.clone();
        let caller = tokio::spawn(async move {
            worker
                .with_command(
                    command,
                    Duration::from_secs(if dropped_caller { 10 } else { 2 }),
                )
                .await
        });
        let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
        let (pid, stage, output) = loop {
            if let Ok(text) = fs::read_to_string(&marker) {
                let mut lines = text.lines();
                if let (Some(pid), Some(stage)) = (lines.next(), lines.next()) {
                    if text.ends_with('\n') && pid.parse::<u32>().is_ok() {
                        let output = fs::read_dir(fixture.service.publishing_root())
                            .unwrap()
                            .find_map(|entry| {
                                let entry = entry.unwrap();
                                (entry.file_type().unwrap().is_file()
                                    && entry.metadata().unwrap().len() == length as u64)
                                    .then(|| entry.path())
                            });
                        if let Some(output) = output {
                            break (pid.to_owned(), PathBuf::from(stage), output);
                        }
                    }
                }
            }
            assert!(tokio::time::Instant::now() < deadline);
            tokio::time::sleep(Duration::from_millis(5)).await;
        };
        assert!(fixture.service.compile_lock.try_lock().is_err());
        assert!(stage.join("main.typ").is_file());
        assert_eq!(fs::metadata(&output).unwrap().len(), length as u64);
        assert_eq!(
            fs::read(&info).unwrap(),
            old_info,
            "even exact-cap output without EOF must remain private"
        );
        if dropped_caller {
            caller.abort();
            assert!(caller.await.unwrap_err().is_cancelled());
            assert!(fixture.service.compile_lock.try_lock().is_err());
            assert!(output.exists() && stage.exists());
            #[cfg(target_os = "linux")]
            assert!(Path::new("/proc").join(&pid).exists());
            // The admitted worker survives its caller, then rejects the first overflow byte.
            fs::write(&release, b"overflow now").unwrap();
        } else {
            let reply = caller.await.unwrap().unwrap();
            assert_eq!(reply["error"]["code"], "timeout");
            assert_eq!(reply["report"]["captureComplete"], false);
            assert_eq!(reply["report"]["rows"], json!([]));
            assert!(reply.get("preview").is_none());
        }
        loop {
            if let Ok(guard) = fixture.service.compile_lock.try_lock() {
                assert!(!stage.exists() && !output.exists());
                #[cfg(target_os = "linux")]
                assert!(!Path::new("/proc").join(&pid).exists());
                drop(guard);
                break;
            }
            assert!(tokio::time::Instant::now() < deadline);
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        assert_eq!(fs::read(&info).unwrap(), old_info);
        assert_eq!(fs::read(&pdf).unwrap(), old_pdf);
    }
}

#[cfg(unix)]
#[tokio::test]
async fn synthetic_publication_reply_failure_preserves_old_and_installed_pdf_blobs() {
    let fixture = Fixture::new("= Previous synthetic publication\n");
    let baseline = fixture
        .synthetic(SYNTHETIC_PDF, Duration::from_secs(5))
        .await
        .unwrap();
    assert_eq!(baseline["status"], "succeeded");
    let (_, info) = fixture
        .service
        .pdf_paths(&fixture.project, "main.typ")
        .unwrap();
    let old: Preview = serde_json::from_slice(&fs::read(&info).unwrap()).unwrap();
    let old_path = info.with_file_name(&old.pdf);
    let old_bytes = fs::read(&old_path).unwrap();
    reply_faults().lock().unwrap().insert(info.clone());
    let script = SYNTHETIC_PDF.replace("owned synthetic fixture", "different synthetic fixture");
    let result = fixture
        .synthetic(&script, Duration::from_secs(5))
        .await
        .unwrap();
    assert_eq!(result["status"], "outcome_unknown");
    assert_eq!(result["error"]["code"], "outcome_unknown");
    assert!(result.get("preview").is_none());
    let installed: Preview = serde_json::from_slice(&fs::read(&info).unwrap()).unwrap();
    assert_ne!(installed.pdf, old.pdf);
    assert_eq!(fs::read(old_path).unwrap(), old_bytes);
    assert!(fs::read(info.with_file_name(installed.pdf))
        .unwrap()
        .starts_with(b"%PDF-"));
}

#[cfg(unix)]
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn synthetic_dropped_native_caller_keeps_real_child_files_and_exclusion_until_exit() {
    let fixture = Arc::new(Fixture::new("= Cancellation\n"));
    let marker = fixture._temporary.path().join("started");
    let release = fixture._temporary.path().join("release");
    let mut command = tokio::process::Command::new("/bin/sh");
    command.arg("-c").arg("printf '%s\\n%s\\n' \"$$\" \"$PWD\" > \"$MARKER\"; printf 'confirmed native prefix' >&2; while [ ! -f \"$RELEASE\" ]; do :; done; exit 9").arg("synthetic held compiler").env("MARKER",&marker).env("RELEASE",&release);
    let worker = fixture.clone();
    let caller =
        tokio::spawn(async move { worker.with_command(command, Duration::from_secs(5)).await });
    let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
    let (pid, stage) = loop {
        if let Ok(text) = fs::read_to_string(&marker) {
            let mut lines = text.lines();
            if let (Some(pid), Some(stage)) = (lines.next(), lines.next()) {
                if text.ends_with('\n') && pid.parse::<u32>().is_ok() && !stage.is_empty() {
                    break (pid.to_owned(), PathBuf::from(stage));
                }
            }
        }
        assert!(tokio::time::Instant::now() < deadline);
        tokio::time::sleep(Duration::from_millis(5)).await;
    };
    caller.abort();
    assert!(caller.await.unwrap_err().is_cancelled());
    assert!(fixture.service.compile_lock.try_lock().is_err());
    assert!(stage.join("main.typ").is_file());
    #[cfg(target_os = "linux")]
    assert!(Path::new("/proc").join(&pid).exists());
    fs::write(release, b"release").unwrap();
    loop {
        if let Ok(guard) = fixture.service.compile_lock.try_lock() {
            assert!(!stage.exists());
            #[cfg(target_os = "linux")]
            assert!(!Path::new("/proc").join(&pid).exists());
            drop(guard);
            break;
        }
        assert!(tokio::time::Instant::now() < deadline);
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
}

#[tokio::test]
async fn synthetic_copied_inventory_maps_exact_bibliography_digest_and_excludes_unsafe_text() {
    let fixture = Fixture::new("#bibliography(\"refs.bib\")\n");
    fs::write(
        fixture.root.join("refs.bib"),
        "@book{owned, title={Original}}\n",
    )
    .unwrap();
    fs::write(fixture.root.join("invalid.csv"), [255, 0]).unwrap();
    fs::write(fixture.root.join("large.typ"), vec![b'x'; MAX_TEXT + 1]).unwrap();
    let revision = digest(&fs::read_to_string(fixture.root.join("main.typ")).unwrap());
    let snapshot = stage_project(
        &fixture.root,
        fixture.service.publishing_root(),
        "main.typ",
        &revision,
    )
    .unwrap();
    fs::write(
        fixture.root.join("refs.bib"),
        "Ambient bytes must not be reread",
    )
    .unwrap();
    let build = NativeBuild::prepare(
        &fixture.service,
        SourceBinding::new(&fixture.project, "main.typ", 0),
        &revision,
        &snapshot,
        &[],
        &BTreeMap::new(),
        true,
    )
    .unwrap();
    assert_eq!(build.sources.len(), 2);
    let (mut writer, mut reader) = tokio::io::duplex(128);
    use tokio::io::AsyncWriteExt;
    writer
        .write_all(b"refs.bib:1:0: error: synthetic candidate\n")
        .await
        .unwrap();
    writer.shutdown().await.unwrap();
    let mut capture = compiler_capture::StderrCapture::new();
    capture.read(&mut reader).await.unwrap();
    let report = build.report(&capture, true).unwrap();
    assert_eq!(
        report["sourceCandidates"][0]["sourceDigest"],
        digest("@book{owned, title={Original}}\n")
    );
    assert_eq!(
        report["rows"][0]["locationCandidate"]["projectPath"],
        "refs.bib"
    );
    let incomplete = build.report(&capture, false).unwrap();
    assert_eq!(incomplete["sourceCandidates"], json!([]));
    assert_eq!(incomplete["rows"], json!([]));
    fs::write(
        snapshot.root.path().join("refs.bib"),
        "Tampered private bytes",
    )
    .unwrap();
    assert_eq!(
        NativeBuild::prepare(
            &fixture.service,
            SourceBinding::new(&fixture.project, "main.typ", 0),
            &revision,
            &snapshot,
            &[],
            &BTreeMap::new(),
            true
        )
        .err()
        .unwrap()
        .code,
        "stale"
    );
}

#[tokio::test]
async fn synthetic_whole_report_and_reply_bounds_include_provenance_candidates_and_json_escaping() {
    use tokio::io::AsyncWriteExt;
    let fixture = Fixture::new("x");
    let snapshot = stage_project(
        &fixture.root,
        fixture.service.publishing_root(),
        "main.typ",
        &digest("x"),
    )
    .unwrap();
    let build = NativeBuild::prepare(
        &fixture.service,
        SourceBinding::new(&fixture.project, "main.typ", 0),
        &digest("x"),
        &snapshot,
        &[],
        &BTreeMap::new(),
        true,
    )
    .unwrap();
    for message in ["\"".repeat(400), "😀".repeat(150)] {
        let mut bytes = format!("main.typ:1:0: warning: {message}\n")
            .repeat(128)
            .into_bytes();
        bytes.truncate(MAX_DIAGNOSTICS);
        let (mut writer, mut reader) = tokio::io::duplex(MAX_DIAGNOSTICS);
        writer.write_all(&bytes).await.unwrap();
        writer.shutdown().await.unwrap();
        let mut capture = compiler_capture::StderrCapture::new();
        capture.read(&mut reader).await.unwrap();
        let report = build.report(&capture, true).unwrap();
        assert!(serde_json::to_vec(&report).unwrap().len() <= MAX_NATIVE_REPORT);
        assert!(report["rows"].as_array().unwrap().len() <= 128);
        assert!(!report["sourceCandidates"].as_array().unwrap().is_empty());
        assert_eq!(report["provenance"]["sourceDigest"], digest("x"));
        let reply = build
            .reply(Err(Error::new("typst", "Synthetic bounded error")), report)
            .unwrap();
        assert!(serde_json::to_vec(&reply).unwrap().len() <= MAX_NATIVE_OVERHEAD);
    }
}

#[test]
fn synthetic_tool_qualification_refuses_special_link_oversize_and_unknown_executables() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("unknown");
    fs::write(&path, b"synthetic not Typst").unwrap();
    assert!(!qualified_compiler(&mut tokio::process::Command::new(
        &path
    )));
    fs::File::create(&path)
        .unwrap()
        .set_len(64 * 1024 * 1024 + 1)
        .unwrap();
    assert!(!qualified_compiler(&mut tokio::process::Command::new(
        &path
    )));
    #[cfg(unix)]
    {
        let alias = temp.path().join("link");
        std::os::unix::fs::symlink(&path, &alias).unwrap();
        assert!(!qualified_compiler(&mut tokio::process::Command::new(
            alias
        )));
        assert!(!qualified_compiler(&mut tokio::process::Command::new(
            "/dev/null"
        )));
    }
}

#[tokio::test]
async fn pinned_typst_native_success_warnings_and_included_unicode_failure_preserve_last_good() {
    let fixture = Fixture::new("#include \"a/chapter.typ\"\n#include \"b/chapter.typ\"\n");
    for parent in ["a", "b"] {
        fs::create_dir(fixture.root.join(parent)).unwrap();
    }
    fs::write(
        fixture.root.join("a/chapter.typ"),
        "#set text(font: \"UnderTreeMissingDiagnosticFontA\")\nChapter A.\n",
    )
    .unwrap();
    fs::write(
        fixture.root.join("b/chapter.typ"),
        "#set text(font: \"UnderTreeMissingDiagnosticFontB\")\nChapter B.\n",
    )
    .unwrap();
    let mut command = tokio::process::Command::new(
        std::env::var_os("UNDERTREE_TYPST").expect("explicit pinned Typst required"),
    );
    assert!(
        qualified_compiler(&mut command),
        "real test requires the accepted pinned executable"
    );
    let success = fixture
        .service
        .compile_typst_native_report("main", &fixture.owner, fixture.request())
        .await
        .unwrap();
    assert_eq!(success["status"], "succeeded");
    assert_eq!(success["report"]["captureComplete"], true);
    assert!(success["preview"]["base64"]
        .as_str()
        .unwrap()
        .starts_with("JVBER"));
    let candidates = success["report"]["sourceCandidates"].as_array().unwrap();
    for path in ["a/chapter.typ", "b/chapter.typ"] {
        assert!(candidates.iter().any(|row| row["projectPath"] == path));
    }
    let (_, info) = fixture
        .service
        .pdf_paths(&fixture.project, "main.typ")
        .unwrap();
    let old_info = fs::read(&info).unwrap();
    let text = "😀e\u{301}\t#diagnostics_native_missing_symbol\n";
    fs::write(fixture.root.join("a/chapter.typ"), text).unwrap();
    let failed = fixture
        .service
        .compile_typst_native_report("main", &fixture.owner, fixture.request())
        .await
        .unwrap();
    assert_eq!(failed["status"], "failed");
    assert_eq!(failed["report"]["captureComplete"], true);
    let rows = failed["report"]["rows"].as_array().unwrap();
    let point = rows
        .iter()
        .find_map(|row| {
            row.get("locationCandidate")
                .filter(|point| point["projectPath"] == "a/chapter.typ")
        })
        .unwrap();
    let offset = text.find("diagnostics_native_missing_symbol").unwrap();
    assert_eq!(point["sourceDigest"], digest(text));
    assert_eq!(point["byteOffset"], offset);
    assert_eq!(point["utf16Offset"], text[..offset].encode_utf16().count());
    assert_eq!(fs::read(info).unwrap(), old_info);
    assert_eq!(
        fixture
            .service
            .preview_pdf(&fixture.project, "main.typ")
            .unwrap()["base64"],
        success["preview"]["base64"]
    );
    let serialized = serde_json::to_string(&failed).unwrap();
    assert!(
        !serialized.contains(".undertree-build-")
            && !serialized.contains(fixture._temporary.path().to_str().unwrap())
    );
    assert!(serde_json::to_vec(&failed["report"]).unwrap().len() <= MAX_NATIVE_REPORT);
}
