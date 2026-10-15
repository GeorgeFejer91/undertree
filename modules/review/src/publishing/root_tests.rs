use super::*;
use crate::Operation;
use std::{fs, time::Duration};

#[cfg(unix)]
#[tokio::test]
async fn actual_compiler_keeps_original_root_and_native_owner_until_final_publication() {
    for replace_root in [true, false] {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("project");
        fs::create_dir(&root).unwrap();
        const TEXT: &str = "= Rooted source\n";
        fs::write(root.join("main.typ"), TEXT).unwrap();
        let service = Service::new(temp.path().join("state")).unwrap();
        let project = service
            .local(Operation::AddProject {
                root: root.to_str().unwrap().into(),
            })
            .unwrap()["id"]
            .as_str()
            .unwrap()
            .to_owned();
        let expected = RootedRoot::observe(&root).unwrap();
        let original = service
            .compile_typst_rooted(&project, "main.typ", &digest(TEXT), 0, Some(expected), None)
            .await
            .unwrap();
        assert_eq!(original["expectedRoot"], json!(expected));
        assert_eq!(original["current"], true);
        let (legacy, info) = service.pdf_paths(&project, "main.typ").unwrap();
        let old_info = fs::read(&info).unwrap();
        let metadata: Preview = serde_json::from_slice(&old_info).unwrap();
        let pdf = legacy.with_file_name(metadata.pdf);
        let old_pdf = fs::read(&pdf).unwrap();
        let owner = service.connect_native_editor("main").unwrap()["ownerId"]
            .as_str()
            .unwrap()
            .to_owned();
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
                .compile_typst_with_owner(
                    SourceBinding::new(&key, "main.typ", 0)
                        .rooted(Some(expected))
                        .guarded(true),
                    Some(("main".into(), owner)),
                    &digest(TEXT),
                    compiler,
                    Duration::from_secs(10),
                )
                .await
        });
        let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
        while !ready.exists() {
            assert!(tokio::time::Instant::now() < deadline);
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        assert!(service.compile_lock.try_lock().is_err());
        if replace_root {
            fs::rename(&root, temp.path().join("retained-root")).unwrap();
            fs::create_dir(&root).unwrap();
            fs::write(root.join("main.typ"), TEXT).unwrap();
        } else {
            service.connect_native_editor("main").unwrap();
        }
        fs::write(release, "continue").unwrap();
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
        assert_eq!(fs::read(pdf).unwrap(), old_pdf);
        assert_eq!(
            service.preview_pdf(&project, "main.typ").unwrap()["current"],
            !replace_root
        );
        assert!(service.compile_lock.try_lock().is_ok());
    }
}
