use super::*;
use sha2::Digest;
use std::sync::OnceLock;

fn sync_faults() -> &'static Mutex<BTreeSet<PathBuf>> {
    static FAULTS: OnceLock<Mutex<BTreeSet<PathBuf>>> = OnceLock::new();
    FAULTS.get_or_init(|| Mutex::new(BTreeSet::new()))
}

pub(super) fn after_registry_write(path: &Path, result: Result<()>) -> Result<()> {
    if sync_faults().lock().unwrap().remove(path) {
        result?;
        return Err(Error::new(
            "io",
            "Synthetic installed registry sync failure.",
        ));
    }
    result
}

struct Fixture {
    temp: tempfile::TempDir,
    service: Arc<Service>,
    project: String,
    root: PathBuf,
    owner: (String, String),
}

impl Fixture {
    fn new() -> Self {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("project");
        fs::create_dir(&root).unwrap();
        fs::write(root.join("main.typ"), "#include \"chapter.typ\"\n").unwrap();
        fs::write(root.join("chapter.typ"), "= Chapter\n").unwrap();
        fs::write(root.join("image.png"), [0, 255, 128]).unwrap();
        let service = Service::new(temp.path().join("state")).unwrap();
        let project = service
            .local(Operation::AddProject {
                root: root.to_str().unwrap().into(),
            })
            .unwrap()["id"]
            .as_str()
            .unwrap()
            .to_owned();
        let owner_id = service.connect_native_editor("main").unwrap()["ownerId"]
            .as_str()
            .unwrap()
            .to_owned();
        Self {
            temp,
            service,
            project,
            root,
            owner: ("main".into(), owner_id),
        }
    }

    fn inputs(&self) -> BTreeMap<String, String> {
        ["main.typ", "chapter.typ", "image.png"]
            .into_iter()
            .map(|path| {
                let bytes = fs::read(self.root.join(path)).unwrap();
                (
                    path.to_owned(),
                    format!("{:x}", sha2::Sha256::digest(bytes)),
                )
            })
            .collect()
    }

    fn registry_path(&self) -> PathBuf {
        self.temp.path().join("state/projects.json")
    }

    fn record(
        &self,
        captured: &BTreeMap<String, u64>,
        inputs: &BTreeMap<String, String>,
    ) -> Result<()> {
        let _authority = self.service.source_effect_guard(Some(&self.owner))?;
        let observed = source_files::RootedRoot::observe(&self.root)?;
        let held = source_files::RootedRoot::acquire(&self.root, &observed)?;
        held.check_current()?;
        self.service
            .record_compiler_source_capture(&self.project, captured, inputs)?;
        held.check_current()
    }
}

#[test]
fn compiler_capture_records_only_editable_candidates_without_changing_other_state() {
    let f = Fixture::new();
    let before = f.inputs();
    fs::create_dir(f.root.join(".git")).unwrap();
    let index = f.root.join(".git/index");
    fs::write(&index, b"unrelated index bytes").unwrap();
    let mut inputs = before.clone();
    inputs.insert(
        "main.typ.undertree-review.json".into(),
        digest("opaque review"),
    );
    inputs.insert(
        "main.typ.import-report.json".into(),
        digest("opaque report"),
    );
    inputs.insert("notes.md".into(), digest("staged notes"));
    let original = {
        let mut registry = lock(&f.service.registry).unwrap();
        registry
            .source_epochs
            .entry(f.project.clone())
            .or_default()
            .insert("chapter.typ".into(), 7);
        registry
            .projects
            .iter_mut()
            .find(|p| p.id == f.project)
            .unwrap()
            .pending_revisions
            .insert("unrelated.typ".into(), digest("unrelated"));
        f.service.save_registry(&registry).unwrap();
        registry.clone()
    };
    let captured = f.service.source_epochs(&f.project).unwrap();
    f.record(&captured, &inputs).unwrap();
    let mut expected = original;
    let paths = expected.source_epochs.entry(f.project.clone()).or_default();
    paths.insert("main.typ".into(), 0);
    paths.insert("notes.md".into(), 0);
    assert_eq!(
        serde_json::to_value(&*lock(&f.service.registry).unwrap()).unwrap(),
        serde_json::to_value(&expected).unwrap()
    );
    assert_eq!(
        fs::read(f.registry_path()).unwrap(),
        serde_json::to_vec_pretty(&expected).unwrap()
    );
    assert_eq!(f.inputs(), before);
    assert_eq!(fs::read(index).unwrap(), b"unrelated index bytes");
    assert!(!sidecar(&f.root.join("main.typ")).exists());
    assert!(!journal_path(&f.root.join("main.typ")).exists());
    let saved = fs::read(f.registry_path()).unwrap();
    f.record(&captured, &inputs).unwrap();
    assert_eq!(fs::read(f.registry_path()).unwrap(), saved);
}

#[test]
fn stale_malformed_unsafe_and_oversized_capture_do_not_install_partial_keys() {
    let f = Fixture::new();
    let original = fs::read(f.registry_path()).unwrap();
    let initial = serde_json::to_value(&*lock(&f.service.registry).unwrap()).unwrap();
    for (captured, inputs, code) in [
        (
            BTreeMap::from([("main.typ".into(), 1)]),
            f.inputs(),
            "stale_document",
        ),
        (
            BTreeMap::from([("main.typ".into(), MAX_SOURCE_EPOCH + 1)]),
            f.inputs(),
            "stale_document",
        ),
        (
            BTreeMap::new(),
            BTreeMap::from([("../main.typ".into(), digest("bad"))]),
            "path",
        ),
        (
            BTreeMap::new(),
            (0..20_001)
                .map(|i| (format!("{i}.typ"), digest("input")))
                .collect(),
            "limit",
        ),
        (
            BTreeMap::new(),
            (0..15_000)
                .map(|i| (format!("{}-{i}.typ", "x".repeat(150)), digest("input")))
                .collect(),
            "limit",
        ),
    ] {
        assert_eq!(f.record(&captured, &inputs).unwrap_err().code, code);
        assert_eq!(fs::read(f.registry_path()).unwrap(), original);
        assert_eq!(
            serde_json::to_value(&*lock(&f.service.registry).unwrap()).unwrap(),
            initial
        );
    }
    let _authority = f.service.source_effect_guard(Some(&f.owner)).unwrap();
    assert_eq!(
        f.service
            .record_compiler_source_capture("not-approved", &BTreeMap::new(), &BTreeMap::new())
            .unwrap_err()
            .code,
        "stale_document"
    );
}

#[test]
fn registry_failure_without_install_leaves_keys_and_source_unchanged() {
    let f = Fixture::new();
    let original = fs::read(f.registry_path()).unwrap();
    let inputs = f.inputs();
    fs::remove_file(f.registry_path()).unwrap();
    fs::create_dir(f.registry_path()).unwrap();
    assert!(f.record(&BTreeMap::new(), &inputs).is_err());
    assert!(f.service.source_epochs(&f.project).unwrap().is_empty());
    assert_eq!(f.inputs(), inputs);
    fs::remove_dir(f.registry_path()).unwrap();
    fs::write(f.registry_path(), original).unwrap();
    assert!(Service::new(f.temp.path().join("state"))
        .unwrap()
        .source_epochs(&f.project)
        .unwrap()
        .is_empty());
}

#[tokio::test]
async fn installed_uncertainty_returns_error_but_retains_recorded_zero_after_restart_and_reuse() {
    let f = Fixture::new();
    let inputs = f.inputs();
    sync_faults().lock().unwrap().insert(f.registry_path());
    assert_eq!(f.record(&BTreeMap::new(), &inputs).unwrap_err().code, "io");
    assert_eq!(
        f.service.source_epochs(&f.project).unwrap(),
        BTreeMap::from([("chapter.typ".into(), 0), ("main.typ".into(), 0)])
    );
    let restarted = Service::new(f.temp.path().join("state")).unwrap();
    assert_eq!(
        restarted.source_epochs(&f.project).unwrap(),
        f.service.source_epochs(&f.project).unwrap()
    );
    let owner = restarted.connect_native_editor("main").unwrap()["ownerId"]
        .as_str()
        .unwrap()
        .to_owned();
    fs::remove_file(f.root.join("chapter.typ")).unwrap();
    let value = restarted
        .dispatch_native_source(
            "main",
            &owner,
            crate::SourceRequest {
                operation: Operation::Create {
                    project: f.project.clone(),
                    path: "chapter.typ".into(),
                },
                source_epoch: 0,
                expected_root: Some(source_files::RootedRoot::observe(&f.root).unwrap()),
            },
        )
        .await
        .unwrap();
    assert_eq!(value["sourceEpoch"], 1);
    let fresh = restarted
        .dispatch_native_source(
            "main",
            &owner,
            crate::SourceRequest {
                operation: Operation::Create {
                    project: f.project.clone(),
                    path: "genuinely-new.typ".into(),
                },
                source_epoch: 0,
                expected_root: Some(source_files::RootedRoot::observe(&f.root).unwrap()),
            },
        )
        .await
        .unwrap();
    assert_eq!(fresh["sourceEpoch"], 0);
}

#[cfg(unix)]
#[tokio::test]
async fn actual_native_compile_capture_retires_stored_pdf_and_late_zero_request_on_same_byte_reuse()
{
    use std::os::unix::fs::MetadataExt;
    const CONTENT: &str =
        "#set page(paper: \"a4\")\n#set text(size: 11pt)\n\n= Manuscript\n\nStart writing here.\n";
    let f = Fixture::new();
    fs::write(f.root.join("main.typ"), CONTENT).unwrap();
    let original = fs::File::open(f.root.join("main.typ")).unwrap();
    let root = source_files::RootedRoot::observe(&f.root).unwrap();
    let request = || crate::SourceRequest {
        operation: Operation::Compile {
            project: f.project.clone(),
            path: "main.typ".into(),
            revision: digest(CONTENT),
        },
        source_epoch: 0,
        expected_root: Some(root),
    };
    assert!(f.service.source_epochs(&f.project).unwrap().is_empty());
    let compiled = f
        .service
        .compile_typst_native_report(&f.owner.0, &f.owner.1, request())
        .await
        .unwrap();
    assert_eq!(compiled["status"], "succeeded");
    assert_eq!(compiled["preview"]["current"], true);
    assert_eq!(compiled["preview"]["sourceEpoch"], 0);
    assert_eq!(
        f.service.source_epochs(&f.project).unwrap().get("main.typ"),
        Some(&0)
    );
    assert!(!sidecar(&f.root.join("main.typ")).exists());
    fs::remove_file(f.root.join("main.typ")).unwrap();
    let created = f
        .service
        .dispatch_native_source(
            &f.owner.0,
            &f.owner.1,
            crate::SourceRequest {
                operation: Operation::Create {
                    project: f.project.clone(),
                    path: "main.typ".into(),
                },
                source_epoch: 0,
                expected_root: Some(root),
            },
        )
        .await
        .unwrap();
    assert_eq!(created["sourceEpoch"], 1);
    assert_eq!(
        fs::read_to_string(f.root.join("main.typ")).unwrap(),
        CONTENT
    );
    assert_ne!(
        original.metadata().unwrap().ino(),
        fs::metadata(f.root.join("main.typ")).unwrap().ino()
    );
    let retained = f.service.preview_pdf(&f.project, "main.typ").unwrap();
    assert_eq!(retained["available"], true);
    assert_eq!(retained["current"], false);
    assert_eq!(retained["base64"], compiled["preview"]["base64"]);
    let registry = fs::read(f.registry_path()).unwrap();
    let policy = fs::read(sidecar(&f.root.join("main.typ"))).unwrap();
    assert_eq!(
        f.service
            .compile_typst_native_report(&f.owner.0, &f.owner.1, request())
            .await
            .unwrap_err()
            .code,
        "stale_document"
    );
    assert_eq!(fs::read(f.registry_path()).unwrap(), registry);
    assert_eq!(fs::read(sidecar(&f.root.join("main.typ"))).unwrap(), policy);
    assert_eq!(
        fs::read_to_string(f.root.join("main.typ")).unwrap(),
        CONTENT
    );
    assert!(!journal_path(&f.root.join("main.typ")).exists());
}
