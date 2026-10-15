use super::*;
use crate::Operation;
use std::fs;
use std::time::Duration;

const MAIN: &str = "#include \"chapter.typ\"\n";

fn fixture() -> (tempfile::TempDir, Arc<Service>, String) {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("project");
    fs::create_dir(&root).unwrap();
    fs::write(root.join("main.typ"), MAIN).unwrap();
    fs::write(root.join("chapter.typ"), "Same included text.\n").unwrap();
    fs::write(root.join("unrelated.typ"), "Unused text.\n").unwrap();
    let service = Service::new(temp.path().join("state")).unwrap();
    let project = service
        .local(Operation::AddProject {
            root: root.to_str().unwrap().into(),
        })
        .unwrap()["id"]
        .as_str()
        .unwrap()
        .into();
    (temp, service, project)
}

#[tokio::test]
async fn actual_typst_main_and_dependency_epochs_preserve_sparse_currentness() {
    let (_temp, service, project) = fixture();
    service
        .retire_source_for_test(&project, "main.typ")
        .unwrap();
    let first = service
        .compile_typst_bound(&project, "main.typ", &digest(MAIN), 1)
        .await
        .unwrap();
    assert_eq!(first["sourceEpoch"], 1);
    assert_eq!(first["current"], true);
    service
        .retire_source_for_test(&project, "unrelated.typ")
        .unwrap();
    assert_eq!(
        service.preview_pdf(&project, "main.typ").unwrap()["current"],
        true
    );
    service
        .retire_source_for_test(&project, "chapter.typ")
        .unwrap();
    let stale = service.preview_pdf(&project, "main.typ").unwrap();
    assert_eq!(stale["current"], false);
    assert_eq!(stale["revision"], digest(MAIN));
    assert_eq!(stale["sourceEpoch"], 1);
    let rebuilt = service
        .compile_typst_bound(&project, "main.typ", &digest(MAIN), 1)
        .await
        .unwrap();
    assert_eq!(rebuilt["current"], true);
    let (_, info) = service.pdf_paths(&project, "main.typ").unwrap();
    let metadata: Preview = serde_json::from_slice(&fs::read(info).unwrap()).unwrap();
    assert_eq!(metadata.source_epoch, 1);
    assert!(metadata
        .dependencies
        .unwrap()
        .iter()
        .any(|input| input.path == "chapter.typ" && input.source_epoch == 1));
    service
        .retire_source_for_test(&project, "main.typ")
        .unwrap();
    assert_eq!(
        service.preview_pdf(&project, "main.typ").unwrap()["current"],
        false
    );
    assert_eq!(
        service
            .compile_typst_bound(&project, "main.typ", &digest(MAIN), 1)
            .await
            .unwrap_err()
            .code,
        "stale_document"
    );
}

#[cfg(unix)]
#[tokio::test]
async fn stale_main_is_denied_before_staging_or_compiler_spawn() {
    let (temp, service, project) = fixture();
    service
        .retire_source_for_test(&project, "main.typ")
        .unwrap();
    let marker = temp.path().join("must-not-run");
    let mut compiler = tokio::process::Command::new("/bin/sh");
    compiler
        .args(["-c", "printf invoked > \"$1\"", "epoch-fixture"])
        .arg(&marker);
    assert_eq!(
        service
            .compile_typst_with_binding(
                SourceBinding::new(&project, "main.typ", 0),
                &digest(MAIN),
                compiler,
                Duration::from_secs(3)
            )
            .await
            .unwrap_err()
            .code,
        "stale_document"
    );
    assert!(!marker.exists());
    assert!(!service.publishing_root().join("pdfs").exists());
}

#[cfg(unix)]
#[tokio::test]
async fn held_actual_compiler_cannot_publish_after_dependency_identity_changes() {
    let (temp, service, project) = fixture();
    service
        .compile_typst_bound(&project, "main.typ", &digest(MAIN), 0)
        .await
        .unwrap();
    let (legacy, info) = service.pdf_paths(&project, "main.typ").unwrap();
    let before = fs::read(&info).unwrap();
    let metadata: Preview = serde_json::from_slice(&before).unwrap();
    let pdf = legacy.with_file_name(metadata.pdf);
    let pdf_before = fs::read(&pdf).unwrap();
    let ready = temp.path().join("ready");
    let release = temp.path().join("release");
    let script = temp.path().join("hold.sh");
    fs::write(&script,"compiler=\"$1\"\nready=\"$2\"\nrelease=\"$3\"\nshift 3\n\"$compiler\" \"$@\" || exit $?\nprintf ready > \"$ready\"\nwhile [ ! -f \"$release\" ]; do sleep 0.01; done\n").unwrap();
    let mut compiler = tokio::process::Command::new("/bin/sh");
    compiler
        .arg(script)
        .arg(std::env::var_os("UNDERTREE_TYPST").unwrap_or_else(|| "typst".into()))
        .arg(&ready)
        .arg(&release);
    let worker = service.clone();
    let key = project.clone();
    let pending = tokio::spawn(async move {
        worker
            .compile_typst_with_binding(
                SourceBinding::new(&key, "main.typ", 0),
                &digest(MAIN),
                compiler,
                Duration::from_secs(10),
            )
            .await
    });
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    while !ready.exists() {
        assert!(
            tokio::time::Instant::now() < deadline,
            "Actual Typst must finish its private staged inputs."
        );
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert!(service.compile_lock.try_lock().is_err());
    // Test-only retirement bypasses production's retained compile exclusion to prove the final check.
    service
        .retire_source_for_test(&project, "chapter.typ")
        .unwrap();
    fs::write(release, "continue").unwrap();
    let error = pending.await.unwrap().unwrap_err();
    assert_eq!(error.code, "stale_document");
    assert_eq!(fs::read(info).unwrap(), before);
    assert_eq!(fs::read(pdf).unwrap(), pdf_before);
    assert_eq!(
        service.preview_pdf(&project, "main.typ").unwrap()["current"],
        false
    );
    assert!(service.compile_lock.try_lock().is_ok());
}
