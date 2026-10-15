use super::*;
use crate::Operation;
use std::fs;
use std::sync::{Mutex, OnceLock};

#[derive(Clone)]
enum Fault {
    Observe,
    AfterInstall,
    PreviewPanic,
    StaleSource(PathBuf),
    PreviewBytes(Option<Vec<u8>>),
}

struct Installed {
    pointer: Vec<u8>,
    pdf: PathBuf,
    bytes: Vec<u8>,
}

struct Entry {
    id: uuid::Uuid,
    fault: Fault,
    installed: Arc<Mutex<Option<Installed>>>,
}

fn faults() -> &'static Mutex<BTreeMap<PathBuf, Entry>> {
    static FAULTS: OnceLock<Mutex<BTreeMap<PathBuf, Entry>>> = OnceLock::new();
    FAULTS.get_or_init(|| Mutex::new(BTreeMap::new()))
}

struct ScopedFault {
    info: PathBuf,
    id: uuid::Uuid,
    installed: Arc<Mutex<Option<Installed>>>,
}

impl ScopedFault {
    fn new(info: &Path, fault: Fault) -> Self {
        let id = uuid::Uuid::new_v4();
        let installed = Arc::new(Mutex::new(None));
        let mut entries = faults().lock().unwrap();
        assert!(
            !entries.contains_key(info),
            "a pointer fault already owns this path"
        );
        entries.insert(
            info.to_owned(),
            Entry {
                id,
                fault,
                installed: installed.clone(),
            },
        );
        Self {
            info: info.to_owned(),
            id,
            installed,
        }
    }

    fn installed(&self) -> Installed {
        self.installed
            .lock()
            .unwrap()
            .take()
            .expect("the real pointer write completed")
    }
}

impl Drop for ScopedFault {
    fn drop(&mut self) {
        let mut entries = faults().lock().unwrap();
        if entries
            .get(&self.info)
            .is_some_and(|entry| entry.id == self.id)
        {
            entries.remove(&self.info);
        }
    }
}

pub(super) fn after_pointer_write(info: &Path, result: Result<()>) -> Result<()> {
    result?;
    let capture = faults()
        .lock()
        .unwrap()
        .get(info)
        .map(|entry| (entry.installed.clone(), entry.fault.clone()));
    if let Some((capture, fault)) = capture {
        let pointer = fs::read(info)?;
        let metadata: Preview = serde_json::from_slice(&pointer)?;
        let pdf = info.with_file_name(&metadata.pdf);
        let bytes = fs::read(&pdf)?;
        *capture.lock().unwrap() = Some(Installed {
            pointer,
            pdf,
            bytes,
        });
        if let Fault::StaleSource(source) = &fault {
            fs::write(source, "Later external source edit.\n")?;
        }
        if matches!(fault, Fault::AfterInstall) {
            return Err(Error::new(
                "io",
                "Injected failure after the real pointer installation.",
            ));
        }
    }
    Ok(())
}

struct RestorePointer {
    info: PathBuf,
    bytes: Vec<u8>,
}

impl Drop for RestorePointer {
    fn drop(&mut self) {
        if atomic_write(&self.info, &self.bytes).is_err() {
            eprintln!("the private pointer fixture could not restore its own installed bytes");
        }
    }
}

pub(super) fn read_preview(info: &Path, read: impl FnOnce() -> Result<Value>) -> Result<Value> {
    let entry = faults().lock().unwrap().remove(info);
    let _restore = match entry.map(|entry| entry.fault) {
        Some(Fault::PreviewPanic) => panic!("Injected final preview worker failure."),
        Some(Fault::PreviewBytes(bytes)) => {
            let restore = RestorePointer {
                info: info.to_owned(),
                bytes: fs::read(info)?,
            };
            if let Some(bytes) = bytes {
                atomic_write(info, &bytes)?;
            } else {
                fs::remove_file(info)?;
            }
            Some(restore)
        }
        _ => None,
    };
    read()
}

struct Fixture {
    _temp: tempfile::TempDir,
    service: Arc<Service>,
    project: String,
    source: PathBuf,
    legacy: PathBuf,
    info: PathBuf,
    old_pdf: PathBuf,
    old_bytes: Vec<u8>,
    old_pointer: Vec<u8>,
}

impl Fixture {
    async fn new(legacy: bool) -> Self {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("project");
        fs::create_dir(&root).unwrap();
        let source = root.join("main.typ");
        fs::write(
            &source,
            "#set document(date: none)\nPrevious publication sentinel.\n",
        )
        .unwrap();
        let service = Service::new(temp.path().join("state")).unwrap();
        let project = service
            .local(Operation::AddProject {
                root: root.to_string_lossy().into_owned(),
            })
            .unwrap()["id"]
            .as_str()
            .unwrap()
            .to_owned();
        let (legacy_path, info) = service.pdf_paths(&project, "main.typ").unwrap();
        let revision = digest(&fs::read_to_string(&source).unwrap());
        let initial = service
            .compile_typst(&project, "main.typ", &revision)
            .await
            .unwrap();
        assert_eq!(initial["current"], true);
        let mut metadata: Preview = serde_json::from_slice(&fs::read(&info).unwrap()).unwrap();
        let mut old_pdf = info.with_file_name(&metadata.pdf);
        let old_bytes = fs::read(&old_pdf).unwrap();
        if legacy {
            fs::write(&legacy_path, &old_bytes).unwrap();
            fs::remove_file(&old_pdf).unwrap();
            metadata.pdf.clear();
            metadata.pdf_hash.clear();
            atomic_write(&info, &serde_json::to_vec(&metadata).unwrap()).unwrap();
            old_pdf = legacy_path.clone();
        }
        let old_pointer = fs::read(&info).unwrap();
        assert!(service.preview_pdf(&project, "main.typ").unwrap()["available"] == true);
        Self {
            _temp: temp,
            service,
            project,
            source,
            legacy: legacy_path,
            info,
            old_pdf,
            old_bytes,
            old_pointer,
        }
    }

    async fn compile(&self, text: &str) -> Result<Value> {
        fs::write(&self.source, text).unwrap();
        self.service
            .compile_typst(&self.project, "main.typ", &digest(text))
            .await
    }
}

fn receipt(case: &str, fixture: &Fixture, installed: &Installed, result: &Result<Value>) {
    let record = json!({
        "case": case,
        "result": result.as_ref().map(|value| json!({"available":value["available"],"revision":value["revision"],"current":value["current"]})).map_err(|error| json!({"code":error.code,"message":error.message})),
        "installedPointerSha256": format!("{:x}", Sha256::digest(&installed.pointer)),
        "pointerUnchangedAfterAttempt": fs::read(&fixture.info).is_ok_and(|bytes| bytes == installed.pointer),
        "previousBlobExists": fixture.old_pdf.is_file(),
        "previousBlobExact": fs::read(&fixture.old_pdf).is_ok_and(|bytes| bytes == fixture.old_bytes),
        "newBlobExists": installed.pdf.is_file(),
        "newBlobExact": fs::read(&installed.pdf).is_ok_and(|bytes| bytes == installed.bytes),
        "newBlobSha256": format!("{:x}", Sha256::digest(&installed.bytes)),
    });
    println!("POINTER_RECEIPT {record}");
    if let Some(root) = std::env::var_os("UNDERTREE_POINTER_EVIDENCE") {
        let directory = PathBuf::from(root).join(case);
        fs::create_dir_all(&directory).unwrap();
        fs::write(
            directory.join("receipt.json"),
            serde_json::to_vec_pretty(&record).unwrap(),
        )
        .unwrap();
        fs::write(directory.join("installed-pointer.json"), &installed.pointer).unwrap();
        fs::write(
            directory.join("previous-pointer.json"),
            &fixture.old_pointer,
        )
        .unwrap();
        fs::write(directory.join("expected-previous.pdf"), &fixture.old_bytes).unwrap();
        fs::write(directory.join("expected-installed.pdf"), &installed.bytes).unwrap();
    }
}

#[tokio::test]
async fn post_install_pointer_error_preserves_referenced_and_previous_pdf() {
    for legacy in [false, true] {
        let fixture = Fixture::new(legacy).await;
        let fault = ScopedFault::new(&fixture.info, Fault::AfterInstall);
        let result = fixture
            .compile(
                "#set document(date: none)\nNew publication after an uncertain pointer write.\n",
            )
            .await;
        let installed = fault.installed();
        receipt(
            if legacy {
                "post-install-legacy"
            } else {
                "post-install"
            },
            &fixture,
            &installed,
            &result,
        );
        assert_eq!(
            fs::read(&fixture.info).unwrap(),
            installed.pointer,
            "never roll back an installed pointer"
        );
        assert!(
            installed.pdf.is_file(),
            "the installed pointer must never reference a deleted PDF"
        );
        assert_eq!(fs::read(&installed.pdf).unwrap(), installed.bytes);
        assert_eq!(fs::read(&fixture.old_pdf).unwrap(), fixture.old_bytes);
        assert_eq!(result.unwrap_err().code, "outcome_unknown");
        assert_eq!(
            fixture
                .service
                .preview_pdf(&fixture.project, "main.typ")
                .unwrap()["current"],
            true
        );
    }
}

#[tokio::test]
async fn final_preview_failure_or_unavailable_preserves_both_blobs() {
    for unavailable in [false, true] {
        let fixture = Fixture::new(false).await;
        let fault = ScopedFault::new(
            &fixture.info,
            Fault::PreviewBytes(if unavailable {
                None
            } else {
                Some(b"{".to_vec())
            }),
        );
        let result = fixture
            .compile(
                "#set document(date: none)\nNew publication before a final preview read failure.\n",
            )
            .await;
        let installed = fault.installed();
        receipt(
            if unavailable {
                "final-unavailable"
            } else {
                "final-format-error"
            },
            &fixture,
            &installed,
            &result,
        );
        assert_eq!(fs::read(&fixture.info).unwrap(), installed.pointer);
        assert_eq!(fs::read(&installed.pdf).unwrap(), installed.bytes);
        assert!(
            fixture.old_pdf.is_file(),
            "final response failure must not delete last-good bytes"
        );
        assert_eq!(fs::read(&fixture.old_pdf).unwrap(), fixture.old_bytes);
        assert_eq!(result.unwrap_err().code, "outcome_unknown");
        assert_eq!(
            fixture
                .service
                .preview_pdf(&fixture.project, "main.typ")
                .unwrap()["current"],
            true
        );
    }
}

#[tokio::test]
async fn final_preview_for_another_attempt_is_not_a_successful_reply() {
    for same_revision in [false, true] {
        let fixture = Fixture::new(false).await;
        let next = "#set document(date: none)\nExpected new publication identity.\n";
        let mut other: Preview = serde_json::from_slice(&fixture.old_pointer).unwrap();
        if same_revision {
            other.revision = digest(next);
        }
        let fault = ScopedFault::new(
            &fixture.info,
            Fault::PreviewBytes(Some(serde_json::to_vec(&other).unwrap())),
        );
        let result = fixture.compile(next).await;
        let installed = fault.installed();
        receipt(
            if same_revision {
                "final-other-pdf"
            } else {
                "final-other-revision"
            },
            &fixture,
            &installed,
            &result,
        );
        assert_eq!(fs::read(&fixture.info).unwrap(), installed.pointer);
        assert_eq!(fs::read(&installed.pdf).unwrap(), installed.bytes);
        assert_eq!(fs::read(&fixture.old_pdf).unwrap(), fixture.old_bytes);
        assert_eq!(result.unwrap_err().code, "outcome_unknown");
    }
}

#[tokio::test]
async fn successful_reply_cleans_old_blobs_and_same_pdf_rebuild_keeps_shared_blob() {
    for legacy in [false, true] {
        let fixture = Fixture::new(legacy).await;
        let next = "#set document(date: none)\nSuccessful replacement publication.\n";
        let fault = ScopedFault::new(&fixture.info, Fault::Observe);
        let result = fixture.compile(next).await;
        let installed = fault.installed();
        receipt(
            if legacy { "success-legacy" } else { "success" },
            &fixture,
            &installed,
            &result,
        );
        let result = result.unwrap();
        assert_eq!(result["available"], true);
        assert_eq!(result["revision"], digest(next));
        assert_eq!(result["current"], true);
        assert!(!fixture.old_pdf.exists());
        assert!(!fixture.legacy.exists());
        assert_eq!(fs::read(&installed.pdf).unwrap(), installed.bytes);
        let repeated = fixture
            .service
            .compile_typst(&fixture.project, "main.typ", &digest(next))
            .await
            .unwrap();
        assert_eq!(repeated["base64"], result["base64"]);
        assert_eq!(fs::read(&installed.pdf).unwrap(), installed.bytes);
    }
}

#[tokio::test]
async fn successful_stale_snapshot_is_retained_and_reported_current_false() {
    let fixture = Fixture::new(false).await;
    let next = "#set document(date: none)\nCompiled snapshot before an external edit.\n";
    let fault = ScopedFault::new(&fixture.info, Fault::StaleSource(fixture.source.clone()));
    let result = fixture.compile(next).await;
    let installed = fault.installed();
    receipt("success-stale", &fixture, &installed, &result);
    let result = result.unwrap();
    assert_eq!(result["available"], true);
    assert_eq!(result["revision"], digest(next));
    assert_eq!(result["current"], false);
    assert_eq!(fs::read(&fixture.info).unwrap(), installed.pointer);
    assert_eq!(fs::read(&installed.pdf).unwrap(), installed.bytes);
    assert!(!fixture.old_pdf.exists());
    assert_eq!(
        fs::read_to_string(&fixture.source).unwrap(),
        "Later external source edit.\n"
    );
}

#[tokio::test]
async fn final_preview_worker_failure_is_uncertain_and_preserves_both_blobs() {
    let fixture = Fixture::new(false).await;
    let fault = ScopedFault::new(&fixture.info, Fault::PreviewPanic);
    let result = fixture
        .compile("#set document(date: none)\nPublication before worker failure.\n")
        .await;
    let installed = fault.installed();
    receipt("final-worker-failure", &fixture, &installed, &result);
    assert_eq!(fs::read(&fixture.info).unwrap(), installed.pointer);
    assert_eq!(fs::read(&installed.pdf).unwrap(), installed.bytes);
    assert_eq!(fs::read(&fixture.old_pdf).unwrap(), fixture.old_bytes);
    assert_eq!(result.unwrap_err().code, "outcome_unknown");
    assert!(fixture
        .service
        .compile_lock
        .clone()
        .try_lock_owned()
        .is_ok());
}
