//! Publisher integration for the authentic staged-source reservation and private pointer marker.
use super::*;
use crate::Operation;
use std::{fs, time::Duration};

const MAIN: &str = "#include \"chapters/chapter.typ\"\n";

fn fixture() -> (tempfile::TempDir, Arc<Service>, String, PathBuf) {
    let temporary = tempfile::tempdir().unwrap();
    let root = temporary.path().join("project");
    fs::create_dir_all(root.join("chapters")).unwrap();
    fs::write(root.join("main.typ"), MAIN).unwrap();
    fs::write(root.join("chapters/chapter.typ"), "= Captured chapter\n").unwrap();
    fs::write(root.join("unused.typ"), "Unused but captured source.\n").unwrap();
    fs::write(root.join("asset.bin"), [0, 255, 128]).unwrap();
    let service = Service::new(temporary.path().join("state")).unwrap();
    let project = service
        .local(Operation::AddProject {
            root: root.to_str().unwrap().into(),
        })
        .unwrap()["id"]
        .as_str()
        .unwrap()
        .to_owned();
    (temporary, service, project, root)
}

#[cfg(unix)]
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn first_held_native_build_records_zero_and_blocks_reuse_until_stale_pdf_is_saved() {
    use std::os::unix::fs::MetadataExt;
    const CREATED: &str =
        "#set page(paper: \"a4\")\n#set text(size: 11pt)\n\n= Manuscript\n\nStart writing here.\n";
    let (temporary, service, project, root) = fixture();
    let source = root.join("main.typ");
    fs::write(&source, CREATED).unwrap();
    let original = fs::File::open(&source).unwrap();
    let observed = RootedRoot::observe(&root).unwrap();
    let owner = service.connect_native_editor("main").unwrap()["ownerId"]
        .as_str()
        .unwrap()
        .to_owned();
    assert!(service.source_epochs(&project).unwrap().is_empty());
    assert_eq!(
        service.preview_pdf(&project, "main.typ").unwrap()["available"],
        false
    );
    let (_, info) = service.pdf_paths(&project, "main.typ").unwrap();
    assert_eq!(fs::read_dir(info.parent().unwrap()).unwrap().count(), 0);
    let registry_path = temporary.path().join("state/projects.json");
    let ready = temporary.path().join("first-build-ready.json");
    let release = temporary.path().join("release-first-build");
    // An assertion failure must also release this owned fixture's held compiler.
    struct ReleaseOnDrop(PathBuf);
    impl Drop for ReleaseOnDrop {
        fn drop(&mut self) {
            let _ = fs::write(&self.0, b"release");
        }
    }
    let _release_on_drop = ReleaseOnDrop(release.clone());
    // No synthetic output: assert durable capture BEFORE the real compiler, then hold its wrapper.
    let script = r#"
import os, sys, json, subprocess, time
with open(os.environ['REGISTRY']) as f:
    before = json.load(f)['sourceEpochs'][os.environ['PROJECT']]['main.typ']
assert before == 0
assert not os.path.exists(os.environ['INFO'])
result = subprocess.run([os.environ['REAL_TYPST']] + sys.argv[1:])
if result.returncode:
    sys.exit(result.returncode)
with open(sys.argv[9]) as f:
    dependencies = json.load(f)['inputs']
assert any(path.endswith('main.typ') for path in dependencies)
with open(os.environ['READY'], 'w') as f:
    json.dump({'beforeChildEpoch': before, 'stage': os.getcwd(), 'compilerFinished': True}, f)
while not os.path.exists(os.environ['RELEASE']):
    time.sleep(0.01)
"#;
    let mut command = tokio::process::Command::new("/usr/bin/python3");
    command
        .arg("-c")
        .arg(script)
        .env("REGISTRY", &registry_path)
        .env("PROJECT", &project)
        .env("INFO", &info)
        .env("READY", &ready)
        .env("RELEASE", &release)
        .env("REAL_TYPST", std::env::var_os("UNDERTREE_TYPST").unwrap());
    let worker = service.clone();
    let key = project.clone();
    let compile_owner = owner.clone();
    let caller = tokio::spawn(async move {
        worker
            .compile_typst_admit(
                SourceBinding::new(&key, "main.typ", 0)
                    .rooted(Some(observed))
                    .guarded(true),
                Some(("main".into(), compile_owner)),
                &digest(CREATED),
                CompilerInvocation {
                    command,
                    timeout: Duration::from_secs(30),
                    native_report: false,
                },
            )
            .await
    });
    let deadline = tokio::time::Instant::now() + Duration::from_secs(20);
    let stage = loop {
        if let Ok(bytes) = fs::read(&ready) {
            if let Ok(value) = serde_json::from_slice::<Value>(&bytes) {
                assert_eq!(value["beforeChildEpoch"], 0);
                assert_eq!(value["compilerFinished"], true);
                break PathBuf::from(value["stage"].as_str().unwrap());
            }
        }
        assert!(tokio::time::Instant::now() < deadline);
        tokio::time::sleep(Duration::from_millis(10)).await;
    };
    assert!(service.compile_lock.try_lock().is_err());
    assert_eq!(fs::read_to_string(stage.join("main.typ")).unwrap(), CREATED);
    let registry = fs::read(&registry_path).unwrap();
    let recorded: Value = serde_json::from_slice(&registry).unwrap();
    assert_eq!(recorded["sourceEpochs"][&project]["main.typ"], 0);
    assert_eq!(
        service.source_epochs(&project).unwrap().get("main.typ"),
        Some(&0)
    );
    assert!(!info.exists());
    fs::remove_file(&source).unwrap();
    let create = || crate::SourceRequest {
        operation: Operation::Create {
            project: project.clone(),
            path: "main.typ".into(),
        },
        source_epoch: 0,
        expected_root: Some(observed),
    };
    let denied = service
        .dispatch_native_source("main", &owner, create())
        .await
        .unwrap_err();
    assert_eq!(denied.code, "busy");
    assert_eq!(
        denied.message,
        "A build owns this retired source path. Retry creation after it completes."
    );
    for path in [
        &source,
        &root.join("main.typ.undertree-review.json"),
        &root.join("main.typ.undertree-pending.json"),
    ] {
        assert!(!path.exists());
    }
    assert_eq!(fs::read(&registry_path).unwrap(), registry);
    assert!(!info.exists());
    fs::write(&release, b"release").unwrap();
    let saved = tokio::time::timeout(Duration::from_secs(15), caller)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    assert_eq!(saved["available"], true);
    assert_eq!(saved["current"], false);
    assert_eq!(saved["sourceEpoch"], 0);
    assert!(!source.exists());
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(saved["base64"].as_str().unwrap())
        .unwrap();
    assert!(bytes.starts_with(b"%PDF-") && bytes.windows(5).any(|part| part == b"%%EOF"));
    assert!(service.compile_lock.try_lock().is_ok());
    assert!(!stage.exists());
    let saved_info = fs::read(&info).unwrap();
    let created = service
        .dispatch_native_source("main", &owner, create())
        .await
        .unwrap();
    assert_eq!(created["sourceEpoch"], 1);
    assert_eq!(fs::read_to_string(&source).unwrap(), CREATED);
    assert_ne!(
        original.metadata().unwrap().ino(),
        fs::metadata(&source).unwrap().ino()
    );
    let retained = service.preview_pdf(&project, "main.typ").unwrap();
    assert_eq!(retained["current"], false);
    assert_eq!(retained["base64"], saved["base64"]);
    let error = service
        .compile_typst_native_report(
            "main",
            &owner,
            crate::SourceRequest {
                operation: Operation::Compile {
                    project: project.clone(),
                    path: "main.typ".into(),
                    revision: digest(CREATED),
                },
                source_epoch: 0,
                expected_root: Some(observed),
            },
        )
        .await
        .unwrap_err();
    assert_eq!(error.code, "stale_document");
    assert_eq!(fs::read(&info).unwrap(), saved_info);
    assert_eq!(fs::read_to_string(&source).unwrap(), CREATED);
}

#[cfg(unix)]
#[tokio::test]
async fn actual_pinned_child_observes_durable_staged_editable_capture_before_start() {
    let (temporary, service, project, _root) = fixture();
    assert!(service.source_epochs(&project).unwrap().is_empty());
    let state = temporary.path().join("state");
    let registry_before: Value =
        serde_json::from_slice(&fs::read(state.join("projects.json")).unwrap()).unwrap();
    let observed = temporary.path().join("child-observed.json");
    // The same owned process proves the actual durable state, then execs the pinned compiler once.
    let script = r#"
import os, sys, json
with open(os.environ['REGISTRY']) as f:
    registry = json.load(f)
paths = registry['sourceEpochs'][os.environ['PROJECT']]
assert paths == {'main.typ': 0, 'chapters/chapter.typ': 0, 'unused.typ': 0}, paths
with open(os.environ['OBSERVED'], 'w') as f:
    json.dump(paths, f)
compiler = os.environ['REAL_TYPST']
os.execv(compiler, [compiler] + sys.argv[1:])
"#;
    let mut compiler = tokio::process::Command::new("/usr/bin/python3");
    compiler
        .arg("-c")
        .arg(script)
        .env("REGISTRY", state.join("projects.json"))
        .env("PROJECT", &project)
        .env("OBSERVED", &observed)
        .env("REAL_TYPST", std::env::var_os("UNDERTREE_TYPST").unwrap());
    let preview = service
        .compile_typst_with_command(
            &project,
            "main.typ",
            &digest(MAIN),
            compiler,
            Duration::from_secs(15),
        )
        .await
        .unwrap();
    assert_eq!(preview["current"], true);
    let recorded: Value = serde_json::from_slice(&fs::read(observed).unwrap()).unwrap();
    assert_eq!(
        recorded,
        json!({"main.typ":0,"chapters/chapter.typ":0,"unused.typ":0})
    );
    let registry_after: Value =
        serde_json::from_slice(&fs::read(state.join("projects.json")).unwrap()).unwrap();
    assert_eq!(registry_after["projects"], registry_before["projects"]);
    let restarted = Service::new(state).unwrap();
    assert_eq!(
        serde_json::to_value(restarted.source_epochs(&project).unwrap()).unwrap(),
        recorded
    );
    assert_eq!(
        restarted.preview_pdf(&project, "main.typ").unwrap()["current"],
        true
    );
    assert!(preview.get("compiler_capture_version").is_none());
}

#[tokio::test]
async fn legacy_pointer_stays_last_good_and_stale_even_with_recorded_zero_until_new_compile() {
    let (temporary, service, project, root) = fixture();
    let fresh = service
        .compile_typst(&project, "main.typ", &digest(MAIN))
        .await
        .unwrap();
    assert_eq!(fresh["current"], true);
    assert_eq!(
        service.source_epochs(&project).unwrap().get("main.typ"),
        Some(&0)
    );
    let (_, info) = service.pdf_paths(&project, "main.typ").unwrap();
    let produced: Value = serde_json::from_slice(&fs::read(&info).unwrap()).unwrap();
    assert_eq!(produced["compiler_capture_version"], 1);
    let pdf = info.with_file_name(produced["pdf"].as_str().unwrap());
    let pdf_bytes = fs::read(&pdf).unwrap();
    let registry = fs::read(temporary.path().join("state/projects.json")).unwrap();
    for version in [None, Some(json!(0)), Some(json!(2))] {
        let mut historical = produced.clone();
        historical
            .as_object_mut()
            .unwrap()
            .remove("compiler_capture_version");
        if let Some(version) = version {
            historical["compiler_capture_version"] = version;
        }
        let bytes = serde_json::to_vec(&historical).unwrap();
        fs::write(&info, &bytes).unwrap();
        let retained = service.preview_pdf(&project, "main.typ").unwrap();
        assert_eq!(retained["available"], true);
        assert_eq!(retained["current"], false);
        assert_eq!(retained["base64"], fresh["base64"]);
        assert!(retained.get("compiler_capture_version").is_none());
        assert_eq!(fs::read(&info).unwrap(), bytes);
        assert_eq!(fs::read(&pdf).unwrap(), pdf_bytes);
        assert_eq!(
            fs::read(temporary.path().join("state/projects.json")).unwrap(),
            registry
        );
        let restarted = Service::new(temporary.path().join("state")).unwrap();
        assert_eq!(
            restarted.preview_pdf(&project, "main.typ").unwrap()["current"],
            false
        );
    }
    for version in [json!("1"), json!(true), json!(-1), json!(256), Value::Null] {
        let mut malformed = produced.clone();
        malformed["compiler_capture_version"] = version;
        let bytes = serde_json::to_vec(&malformed).unwrap();
        fs::write(&info, &bytes).unwrap();
        assert!(service.preview_pdf(&project, "main.typ").is_err());
        assert_eq!(fs::read(&info).unwrap(), bytes);
        assert_eq!(fs::read(&pdf).unwrap(), pdf_bytes);
    }
    let mut historical = produced;
    historical
        .as_object_mut()
        .unwrap()
        .remove("compiler_capture_version");
    fs::write(&info, serde_json::to_vec(&historical).unwrap()).unwrap();
    let rebuilt = service
        .compile_typst(&project, "main.typ", &digest(MAIN))
        .await
        .unwrap();
    assert_eq!(rebuilt["current"], true);
    assert_eq!(rebuilt["sourceEpoch"], 0);
    assert!(rebuilt.get("compiler_capture_version").is_none());
    let installed: Value = serde_json::from_slice(&fs::read(&info).unwrap()).unwrap();
    assert_eq!(installed["compiler_capture_version"], 1);
    assert_eq!(fs::read_to_string(root.join("main.typ")).unwrap(), MAIN);
}

#[cfg(unix)]
#[tokio::test]
async fn failed_capture_reservation_never_spawns_or_changes_last_good() {
    let (temporary, service, project, root) = fixture();
    let previous = service
        .compile_typst(&project, "main.typ", &digest(MAIN))
        .await
        .unwrap();
    let (_, info) = service.pdf_paths(&project, "main.typ").unwrap();
    let previous_info = fs::read(&info).unwrap();
    let metadata: Preview = serde_json::from_slice(&previous_info).unwrap();
    let pdf = info.with_file_name(metadata.pdf);
    let previous_pdf = fs::read(&pdf).unwrap();
    fs::write(
        root.join("new-unused.typ"),
        "Must be reserved before any child.\n",
    )
    .unwrap();
    let registry_path = temporary.path().join("state/projects.json");
    let registry = fs::read(&registry_path).unwrap();
    fs::remove_file(&registry_path).unwrap();
    fs::create_dir(&registry_path).unwrap();
    let marker = temporary.path().join("must-not-start");
    let mut compiler = tokio::process::Command::new("/bin/sh");
    compiler
        .args([
            "-c",
            "printf started > \"$MARKER\"; exit 99",
            "capture-refusal",
        ])
        .env("MARKER", &marker);
    let error = service
        .compile_typst_with_command(
            &project,
            "main.typ",
            &digest(MAIN),
            compiler,
            Duration::from_secs(2),
        )
        .await
        .unwrap_err();
    assert_eq!(error.code, "io");
    assert!(!marker.exists());
    assert_eq!(fs::read(&info).unwrap(), previous_info);
    assert_eq!(fs::read(&pdf).unwrap(), previous_pdf);
    assert!(!service
        .source_epochs(&project)
        .unwrap()
        .contains_key("new-unused.typ"));
    assert!(service.compile_lock.try_lock().is_ok());
    fs::remove_dir(&registry_path).unwrap();
    fs::write(&registry_path, &registry).unwrap();
    let restarted = Service::new(temporary.path().join("state")).unwrap();
    assert!(!restarted
        .source_epochs(&project)
        .unwrap()
        .contains_key("new-unused.typ"));
    assert_eq!(
        restarted.preview_pdf(&project, "main.typ").unwrap()["base64"],
        previous["base64"]
    );
}
