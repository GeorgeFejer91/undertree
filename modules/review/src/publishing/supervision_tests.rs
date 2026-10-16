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

#[cfg(target_os = "linux")]
struct HeldDependencies {
    marker: PathBuf,
    overflow: PathBuf,
    stop: PathBuf,
}

#[cfg(target_os = "linux")]
impl HeldDependencies {
    fn new(root: &Path) -> Self {
        Self {
            marker: root.join("dependency-ready"),
            overflow: root.join("dependency-overflow"),
            stop: root.join("dependency-stop"),
        }
    }

    fn command(&self, length: usize) -> Command {
        let prefix = r#"{"inputs":["main.typ"]}"#;
        assert!(length >= prefix.len());
        // Only shell builtins: the announced process is the producer, with no descendant.
        let script = format!(
            r#"marker="$1"; overflow="$2"; stop="$3"; shift 3
while [ "$#" -gt 1 ] && [ "$1" != --deps ]; do shift; done
[ "$1" = --deps ] || exit 77
exec 3>"$2"
printf '%s' '{prefix}' >&3
printf '%{padding}s' '' >&3
exec 1>&- 2>&-
printf '%s\n%s\n' "$$" "$PWD" > "$marker"
while [ ! -f "$overflow" ]; do :; done
printf '!' >&3
while [ ! -f "$stop" ]; do :; done
exit 19
"#,
            padding = length - prefix.len()
        );
        let mut command = Command::new("/bin/sh");
        command
            .arg("-c")
            .arg(script)
            .arg("undertree-owned-dependency-producer")
            .arg(&self.marker)
            .arg(&self.overflow)
            .arg(&self.stop);
        command
    }

    async fn ready(&self, service: &Service, length: usize) -> (u32, PathBuf, PathBuf) {
        let deadline = tokio::time::Instant::now() + Duration::from_secs(15);
        loop {
            if let Ok(text) = fs::read_to_string(&self.marker) {
                let mut lines = text.lines();
                if let (Some(pid), Some(stage)) = (lines.next(), lines.next()) {
                    if let Ok(pid) = pid.parse::<u32>() {
                        let output =
                            fs::read_dir(service.publishing_root())
                                .unwrap()
                                .find_map(|entry| {
                                    let entry = entry.unwrap();
                                    (entry.file_type().unwrap().is_file()
                                        && entry.metadata().unwrap().len() == length as u64)
                                        .then(|| entry.path())
                                });
                        if text.ends_with('\n') {
                            if let Some(output) = output {
                                assert!(process_exists(pid));
                                return (pid, PathBuf::from(stage), output);
                            }
                        }
                    }
                }
            }
            assert!(tokio::time::Instant::now() < deadline, "the real dependency producer must fill the held private output before its overflow is released");
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    }
}

#[cfg(target_os = "linux")]
impl Drop for HeldDependencies {
    fn drop(&mut self) {
        // A failed assertion must not leave this synthetic producer waiting forever.
        let _ = fs::write(&self.stop, b"stop");
        let _ = fs::write(&self.overflow, b"continue");
    }
}

#[cfg(target_os = "linux")]
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn dependency_overflow_from_live_writer_and_dropped_caller_remains_owned_until_reaped() {
    let compiler = real_compiler();
    for dropped_caller in [false, true] {
        let (temporary, service, project, source) = fixture();
        let baseline = initial_preview(&service, &project, &compiler).await;
        let (_, info) = service.pdf_paths(&project, "main.typ").unwrap();
        let metadata = fs::read(&info).unwrap();
        let old: Preview = serde_json::from_slice(&metadata).unwrap();
        let pdf = info.with_file_name(old.pdf);
        let pdf_bytes = fs::read(&pdf).unwrap();
        let entries = publishing_entries(&service);
        let held = HeldDependencies::new(temporary.path());
        let command = held.command(MAX_DEPENDENCY_LIST);
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
        let (pid, stage, output) = held.ready(&service, MAX_DEPENDENCY_LIST).await;
        assert!(service.compile_lock.try_lock().is_err());
        assert!(stage.join("main.typ").is_file());
        assert_eq!(
            fs::metadata(&output).unwrap().len(),
            MAX_DEPENDENCY_LIST as u64
        );
        assert_eq!(fs::read(&info).unwrap(), metadata);
        assert_eq!(fs::read(&pdf).unwrap(), pdf_bytes);
        if dropped_caller {
            caller.abort();
            assert!(caller.await.unwrap_err().is_cancelled());
            assert!(process_exists(pid));
            assert!(service.compile_lock.try_lock().is_err());
            assert!(output.exists() && stage.exists());
            fs::write(&held.overflow, b"one excess byte").unwrap();
        } else {
            fs::write(&held.overflow, b"one excess byte").unwrap();
            let error = tokio::time::timeout(Duration::from_secs(10), caller)
                .await
                .expect("overflow must stop the live producer before its long compiler timeout")
                .unwrap()
                .unwrap_err();
            assert_eq!(error.code, "limit");
            assert!(error.message.contains("dependency report"));
        }
        released_after_cleanup(&service, pid, &stage).await;
        assert!(!output.exists());
        assert_eq!(fs::read(&info).unwrap(), metadata);
        assert_eq!(fs::read(&pdf).unwrap(), pdf_bytes);
        assert_eq!(
            service.preview_pdf(&project, "main.typ").unwrap()["base64"],
            baseline["base64"]
        );
        assert_eq!(publishing_entries(&service), entries);
        assert_eq!(fs::read(source).unwrap(), INITIAL.as_bytes());
    }
}

#[cfg(target_os = "linux")]
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn partial_and_exact_dependency_report_without_eof_times_out_without_publication() {
    let compiler = real_compiler();
    for length in [32768, MAX_DEPENDENCY_LIST] {
        let (temporary, service, project, source) = fixture();
        initial_preview(&service, &project, &compiler).await;
        let (_, info) = service.pdf_paths(&project, "main.typ").unwrap();
        let metadata = fs::read(&info).unwrap();
        let old: Preview = serde_json::from_slice(&metadata).unwrap();
        let pdf = info.with_file_name(old.pdf);
        let pdf_bytes = fs::read(&pdf).unwrap();
        let entries = publishing_entries(&service);
        let held = HeldDependencies::new(temporary.path());
        let command = held.command(length);
        let worker = service.clone();
        let target = project.clone();
        let caller = tokio::spawn(async move {
            worker
                .compile_typst_with_command(
                    &target,
                    "main.typ",
                    &digest(INITIAL),
                    command,
                    Duration::from_secs(10),
                )
                .await
        });
        let (pid, stage, output) = held.ready(&service, length).await;
        assert!(service.compile_lock.try_lock().is_err());
        assert_eq!(fs::read(&info).unwrap(), metadata);
        let error = caller.await.unwrap().unwrap_err();
        assert_eq!(error.code, "timeout");
        released_after_cleanup(&service, pid, &stage).await;
        assert!(!output.exists());
        assert_eq!(fs::read(&info).unwrap(), metadata);
        assert_eq!(fs::read(&pdf).unwrap(), pdf_bytes);
        assert_eq!(publishing_entries(&service), entries);
        assert_eq!(fs::read(source).unwrap(), INITIAL.as_bytes());
    }
}

#[cfg(target_os = "linux")]
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn dependency_pdf_and_stderr_backpressure_are_drained_concurrently_before_eof() {
    const DEPENDENCY_BYTES: usize = 192 * 1024;
    const PDF_BYTES: usize = 128 * 1024;
    const DIAGNOSTIC_LINE: &str = "three-stream-drain-sentinel\n";
    let compiler = real_compiler();
    let (temporary, service, project, source) = fixture();
    initial_preview(&service, &project, &compiler).await;
    let (_, info) = service.pdf_paths(&project, "main.typ").unwrap();
    let metadata = fs::read(&info).unwrap();
    let old: Preview = serde_json::from_slice(&metadata).unwrap();
    let old_pdf = info.with_file_name(old.pdf);
    let old_pdf_bytes = fs::read(&old_pdf).unwrap();
    let held = HeldDependencies::new(temporary.path());
    let mut command = Command::new("python3");
    command
        .arg("-c")
        .arg(
            r#"import fcntl, os, sys, time
marker, release, stop = sys.argv[1:4]
# Force each real pipe below every output size, without changing production limits.
for fd in (0, 1, 2):
    assert fcntl.fcntl(fd, fcntl.F_SETPIPE_SZ, 4096) <= 4096
dependencies = os.open(sys.argv[sys.argv.index('--deps') + 1],
                       os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
def write_all(fd, data):
    while data:
        data = data[os.write(fd, data):]
prefix = b'{"inputs":["main.typ"]}'
# Opposite the supervisor's PDF/stderr/dependency order: sequential drains deadlock.
write_all(dependencies, prefix + b' ' * (192 * 1024 - len(prefix)))
write_all(2, b'three-stream-drain-sentinel\n' * 1024)
write_all(1, b'%PDF-' + b'P' * (128 * 1024 - 5))
with open(marker, 'w') as output:
    output.write(str(os.getpid()) + '\n' + os.getcwd() + '\n')
while not os.path.exists(release) and not os.path.exists(stop):
    time.sleep(0.005)
if os.path.exists(stop):
    sys.exit(19)
os.close(dependencies)
"#,
        )
        .arg(&held.marker)
        .arg(&held.overflow)
        .arg(&held.stop);
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
    let (pid, stage, dependencies) = held.ready(&service, DEPENDENCY_BYTES).await;
    assert!(service.compile_lock.try_lock().is_err());
    assert!(!caller.is_finished(), "all three streams remain open");
    assert!(stage.join("main.typ").is_file());
    assert_eq!(fs::read(&info).unwrap(), metadata);
    assert_eq!(fs::read(&old_pdf).unwrap(), old_pdf_bytes);
    fs::write(&held.overflow, b"allow actual EOF").unwrap();
    let preview = tokio::time::timeout(Duration::from_secs(15), caller)
        .await
        .expect("three bounded streams must finish after the producer's actual EOF")
        .unwrap()
        .unwrap();
    released_after_cleanup(&service, pid, &stage).await;
    assert!(!dependencies.exists());
    assert_eq!(preview["current"], true);
    let pdf = base64::engine::general_purpose::STANDARD
        .decode(preview["base64"].as_str().unwrap())
        .unwrap();
    assert_eq!(pdf.len(), PDF_BYTES);
    assert!(pdf.starts_with(b"%PDF-"));
    assert_eq!(preview["diagnostics"], DIAGNOSTIC_LINE.repeat(1024));
    assert_eq!(fs::read(source).unwrap(), INITIAL.as_bytes());
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
