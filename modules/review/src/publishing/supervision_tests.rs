#![cfg(unix)]

use super::*;
use crate::Operation;
use std::ffi::OsString;
use std::fs;
use std::time::Duration;
use tokio::process::Command;

const INITIAL: &str = "Baseline publication sentinel.\n";

fn real_compiler() -> OsString {
    std::env::var_os("UNDERTREE_TYPST")
        .expect("real compiler supervision requires an explicit UNDERTREE_TYPST executable")
}

fn fixture() -> (tempfile::TempDir, Arc<Service>, String, PathBuf) {
    let temporary = tempfile::tempdir().unwrap();
    let root = temporary.path().join("project");
    fs::create_dir(&root).unwrap();
    let source = root.join("main.typ");
    fs::write(&source, INITIAL).unwrap();
    fs::write(root.join("chapter.typ"), "Included supervision sentinel.").unwrap();
    let service = Service::new(temporary.path().join("state")).unwrap();
    let project = service
        .local(Operation::AddProject {
            root: root.to_string_lossy().into_owned(),
        })
        .unwrap()["id"]
        .as_str()
        .unwrap()
        .to_owned();
    (temporary, service, project, source)
}

struct HeldCompiler {
    started: PathBuf,
    release: PathBuf,
}

impl HeldCompiler {
    fn new(root: &Path) -> Self {
        Self {
            started: root.join("compiler-started"),
            release: root.join("compiler-release"),
        }
    }

    fn command(&self, finish: &str) -> Command {
        let script = format!(
            "printf '%s\\n%s\\n' \"$$\" \"$PWD\" > \"$1\"\n\
             while [ ! -f \"$2\" ]; do :; done\n{finish}"
        );
        let mut command = Command::new("/bin/sh");
        command
            .arg("-c")
            .arg(script)
            .arg("undertree-supervision-fixture")
            .arg(&self.started)
            .arg(&self.release);
        command
    }

    async fn started(&self) -> (u32, PathBuf) {
        let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
        loop {
            if let Ok(marker) = fs::read_to_string(&self.started) {
                let mut lines = marker.lines();
                if let (Some(pid), Some(directory)) = (lines.next(), lines.next()) {
                    if let Ok(pid) = pid.parse::<u32>() {
                        let directory = PathBuf::from(directory);
                        if marker.ends_with('\n') {
                            return (pid, directory);
                        }
                    }
                }
            }
            assert!(
                tokio::time::Instant::now() < deadline,
                "the actual compiler child must announce its PID and staging directory"
            );
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }

    fn release(&self) {
        fs::write(&self.release, b"continue").unwrap();
    }
}

impl Drop for HeldCompiler {
    fn drop(&mut self) {
        // Assertion failures must not leave the fixture's child spinning forever.
        let _ = fs::write(&self.release, b"continue");
    }
}

#[cfg(target_os = "linux")]
fn process_exists(pid: u32) -> bool {
    Path::new("/proc").join(pid.to_string()).exists()
}

#[cfg(not(target_os = "linux"))]
fn process_exists(pid: u32) -> bool {
    std::process::Command::new("/bin/sh")
        .args(["-c", "kill -0 \"$1\" 2>/dev/null", "process-probe"])
        .arg(pid.to_string())
        .status()
        .unwrap()
        .success()
}

fn publishing_entries(service: &Service) -> Vec<PathBuf> {
    fn walk(root: &Path, directory: &Path, entries: &mut Vec<PathBuf>) {
        for entry in fs::read_dir(directory).unwrap() {
            let entry = entry.unwrap();
            entries.push(entry.path().strip_prefix(root).unwrap().to_owned());
            if entry.file_type().unwrap().is_dir() {
                walk(root, &entry.path(), entries);
            }
        }
    }
    let mut entries = Vec::new();
    walk(
        service.publishing_root(),
        service.publishing_root(),
        &mut entries,
    );
    entries.sort();
    entries
}

async fn released_after_cleanup(service: &Arc<Service>, pid: u32, staging: &Path) {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(15);
    loop {
        if let Ok(guard) = service.compile_lock.clone().try_lock_owned() {
            assert!(
                !process_exists(pid),
                "build ownership outlives child reaping"
            );
            assert!(
                !staging.exists(),
                "build ownership outlives removal of its input snapshot"
            );
            let residue = fs::read_dir(service.publishing_root())
                .unwrap()
                .any(|entry| {
                    entry
                        .unwrap()
                        .file_name()
                        .to_string_lossy()
                        .starts_with(".undertree-build-")
                });
            assert!(!residue, "the completed build leaves no owned staging root");
            drop(guard);
            return;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "the supervisor must eventually reap its child and release build ownership"
        );
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
}

async fn initial_preview(service: &Arc<Service>, project: &str, compiler: &OsString) -> Value {
    service
        .compile_typst_with_command(
            project,
            "main.typ",
            &digest(INITIAL),
            Command::new(compiler),
            Duration::from_secs(30),
        )
        .await
        .unwrap()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn cancelled_caller_leaves_success_or_failure_supervised_until_reaped() {
    let compiler = real_compiler();
    for successful in [true, false] {
        let (temporary, service, project, source) = fixture();
        let baseline = initial_preview(&service, &project, &compiler).await;
        let (_, metadata_path) = service.pdf_paths(&project, "main.typ").unwrap();
        let metadata_before = fs::read(&metadata_path).unwrap();
        let entries_before = publishing_entries(&service);
        let next = if successful {
            "#include \"chapter.typ\"\nSuccessful supervised publication sentinel.\n"
        } else {
            "#unknown-supervision-function()\n"
        };
        fs::write(&source, next).unwrap();
        let held = HeldCompiler::new(temporary.path());
        let mut command = held.command("compiler=$3\nshift 3\nexec \"$compiler\" \"$@\"");
        command.arg(&compiler);
        let worker = service.clone();
        let target = project.clone();
        let caller = tokio::spawn(async move {
            worker
                .compile_typst_with_command(
                    &target,
                    "main.typ",
                    &digest(next),
                    command,
                    Duration::from_secs(30),
                )
                .await
        });
        let (pid, staging) = held.started().await;
        assert_eq!(fs::read(staging.join("main.typ")).unwrap(), next.as_bytes());
        caller.abort();
        assert!(caller.await.unwrap_err().is_cancelled());
        assert!(
            process_exists(pid),
            "dropping the caller does not kill the admitted child"
        );
        assert!(
            staging.is_dir(),
            "the admitted child retains its private inputs"
        );
        let error = service
            .compile_typst_with_command(
                &project,
                "main.typ",
                &digest(next),
                Command::new(&compiler),
                Duration::from_secs(1),
            )
            .await
            .unwrap_err();
        assert_eq!(
            error.code, "busy",
            "the admitted build keeps its global slot"
        );
        let reader = service.clone();
        let target = project.clone();
        let snapshot = tokio::time::timeout(
            Duration::from_secs(2),
            tokio::task::spawn_blocking(move || {
                reader.local(Operation::Review {
                    project: target,
                    path: "main.typ".into(),
                })
            }),
        )
        .await
        .expect("saved-source inspection remains responsive during compilation")
        .unwrap()
        .unwrap();
        assert_eq!(snapshot["content"], next);
        held.release();
        released_after_cleanup(&service, pid, &staging).await;
        let preview = service.preview_pdf(&project, "main.typ").unwrap();
        if successful {
            assert_eq!(preview["current"], true);
            assert_eq!(preview["revision"], digest(next));
            assert_ne!(preview["base64"], baseline["base64"]);
            let bytes = base64::engine::general_purpose::STANDARD
                .decode(preview["base64"].as_str().unwrap())
                .unwrap();
            assert!(bytes.starts_with(b"%PDF-"));
            assert!(bytes.windows(5).any(|part| part == b"%%EOF"));
            let metadata: Value =
                serde_json::from_slice(&fs::read(&metadata_path).unwrap()).unwrap();
            assert_eq!(metadata["revision"], digest(next));
            assert_eq!(
                metadata["pdf_hash"],
                format!("{:x}", Sha256::digest(&bytes))
            );
            let previous: Value = serde_json::from_slice(&metadata_before).unwrap();
            let pdf_directory = metadata_path
                .parent()
                .unwrap()
                .strip_prefix(service.publishing_root())
                .unwrap();
            let previous_pdf = pdf_directory.join(previous["pdf"].as_str().unwrap());
            let next_pdf = pdf_directory.join(metadata["pdf"].as_str().unwrap());
            let mut expected_entries: Vec<_> = entries_before
                .into_iter()
                .map(|path| {
                    if path == previous_pdf {
                        next_pdf.clone()
                    } else {
                        path
                    }
                })
                .collect();
            expected_entries.sort();
            assert_eq!(publishing_entries(&service), expected_entries);
        } else {
            assert_eq!(preview["current"], false);
            assert_eq!(preview["base64"], baseline["base64"]);
            assert_eq!(preview["revision"], baseline["revision"]);
            assert_eq!(fs::read(&metadata_path).unwrap(), metadata_before);
            assert_eq!(publishing_entries(&service), entries_before);
        }
        assert_eq!(fs::read(&source).unwrap(), next.as_bytes());
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn short_deadline_reaps_child_and_preserves_last_good_bytes_and_metadata() {
    let compiler = real_compiler();
    let (temporary, service, project, source) = fixture();
    let baseline = initial_preview(&service, &project, &compiler).await;
    let (_, metadata_path) = service.pdf_paths(&project, "main.typ").unwrap();
    let metadata_before = fs::read(&metadata_path).unwrap();
    let entries_before = publishing_entries(&service);
    let held = HeldCompiler::new(temporary.path());
    let command = held.command("exit 9");
    let worker = service.clone();
    let target = project.clone();
    let caller = tokio::spawn(async move {
        worker
            .compile_typst_with_command(
                &target,
                "main.typ",
                &digest(INITIAL),
                command,
                Duration::from_secs(1),
            )
            .await
    });
    let (pid, staging) = held.started().await;
    let error = tokio::time::timeout(Duration::from_secs(5), caller)
        .await
        .expect("the short deadline plus bounded reap response finishes promptly")
        .unwrap()
        .unwrap_err();
    assert_eq!(error.code, "timeout");
    assert!(error.message.contains("last good") || error.message.contains("last-good"));
    released_after_cleanup(&service, pid, &staging).await;
    assert_eq!(
        service.preview_pdf(&project, "main.typ").unwrap()["base64"],
        baseline["base64"]
    );
    assert_eq!(fs::read(metadata_path).unwrap(), metadata_before);
    assert_eq!(publishing_entries(&service), entries_before);
    assert_eq!(fs::read(source).unwrap(), INITIAL.as_bytes());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn diagnostic_limit_reaps_writer_and_preserves_last_good_bytes_and_metadata() {
    let compiler = real_compiler();
    let (temporary, service, project, source) = fixture();
    let baseline = initial_preview(&service, &project, &compiler).await;
    let (_, metadata_path) = service.pdf_paths(&project, "main.typ").unwrap();
    let metadata_before = fs::read(&metadata_path).unwrap();
    let entries_before = publishing_entries(&service);
    let held = HeldCompiler::new(temporary.path());
    let command = held.command(
        "i=0\nwhile [ \"$i\" -lt 2049 ]; do printf '%064d' 0 >&2; i=$((i + 1)); done\nexit 9",
    );
    let worker = service.clone();
    let target = project.clone();
    let caller = tokio::spawn(async move {
        worker
            .compile_typst_with_command(
                &target,
                "main.typ",
                &digest(INITIAL),
                command,
                Duration::from_secs(30),
            )
            .await
    });
    let (pid, staging) = held.started().await;
    held.release();
    let error = tokio::time::timeout(Duration::from_secs(5), caller)
        .await
        .expect("bounded diagnostics stop the real writer promptly")
        .unwrap()
        .unwrap_err();
    assert_eq!(error.code, "limit");
    assert!(error.message.contains("64"));
    released_after_cleanup(&service, pid, &staging).await;
    assert_eq!(
        service.preview_pdf(&project, "main.typ").unwrap()["base64"],
        baseline["base64"]
    );
    assert_eq!(fs::read(metadata_path).unwrap(), metadata_before);
    assert_eq!(publishing_entries(&service), entries_before);
    assert_eq!(fs::read(source).unwrap(), INITIAL.as_bytes());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn spawn_failure_releases_admission_and_removes_all_temporary_files() {
    let compiler = real_compiler();
    let (temporary, service, project, source) = fixture();
    let baseline = initial_preview(&service, &project, &compiler).await;
    let (_, metadata_path) = service.pdf_paths(&project, "main.typ").unwrap();
    let metadata_before = fs::read(&metadata_path).unwrap();
    let entries_before = publishing_entries(&service);
    let missing = temporary.path().join("no-such-compiler");
    let error = service
        .compile_typst_with_command(
            &project,
            "main.typ",
            &digest(INITIAL),
            Command::new(&missing),
            Duration::from_secs(1),
        )
        .await
        .unwrap_err();
    assert_eq!(error.code, "typst");
    let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
    loop {
        if let Ok(guard) = service.compile_lock.clone().try_lock_owned() {
            assert_eq!(publishing_entries(&service), entries_before);
            drop(guard);
            break;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "spawn failure must release its admitted build slot after cleanup"
        );
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    let preview = service.preview_pdf(&project, "main.typ").unwrap();
    assert_eq!(preview["current"], true);
    assert_eq!(preview["base64"], baseline["base64"]);
    assert_eq!(fs::read(metadata_path).unwrap(), metadata_before);
    assert_eq!(fs::read(source).unwrap(), INITIAL.as_bytes());
    assert!(!missing.exists());
}
