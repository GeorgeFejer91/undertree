use serde_json::{json, Value};
use std::fs;
use std::path::Path;
use std::sync::Arc;
use undertree_review::capabilities::CallerContext;
use undertree_review::service::Service;
use undertree_review::Operation;

fn approve(root: &Path, state: &Path) -> (Arc<Service>, String) {
    let service = Service::new(state.into()).unwrap();
    let project = service
        .local(Operation::AddProject {
            root: root.to_str().unwrap().into(),
        })
        .unwrap()["id"]
        .as_str()
        .unwrap()
        .to_owned();
    (service, project)
}

fn tree(service: &Service, project: &str) -> Value {
    service
        .local(Operation::ProjectTree {
            project: project.into(),
        })
        .unwrap()
}

#[test]
fn inventory_includes_empty_directories_and_binary_assets_without_opening_or_recovering_them() {
    let temporary = tempfile::tempdir().unwrap();
    let root = temporary.path().join("project");
    fs::create_dir_all(root.join("empty/nested")).unwrap();
    fs::write(root.join("main.typ"), "Source.").unwrap();
    fs::write(root.join("image.png"), [0xff, 0x00, 0xfe]).unwrap();
    fs::write(root.join("font.otf"), [0xff, 0x00]).unwrap();
    fs::write(
        root.join("main.typ.undertree-pending.json"),
        b"preserve pending",
    )
    .unwrap();
    fs::write(
        root.join("main.typ.undertree-review.json"),
        b"preserve corrupt sidecar",
    )
    .unwrap();
    fs::write(root.join("main.typ.import-report.json"), b"preserve report").unwrap();
    for name in [
        ".git",
        "node_modules",
        "For-AI",
        ".undertree-build-temporary",
    ] {
        fs::create_dir(root.join(name)).unwrap();
        fs::write(root.join(name).join("private.typ"), "Excluded.").unwrap();
    }
    let (service, project) = approve(&root, &temporary.path().join("state"));
    let registry = fs::read(temporary.path().join("state/projects.json")).unwrap();
    let result = tree(&service, &project);
    assert_eq!(result["truncated"], false);
    assert_eq!(result["omittedNonUtf8"], 0);
    assert_eq!(
        result["entries"],
        json!([
            {"path":"empty","kind":"directory","editable":false},
            {"path":"empty/nested","kind":"directory","editable":false},
            {"path":"font.otf","kind":"asset","editable":false,"bytes":2},
            {"path":"image.png","kind":"asset","editable":false,"bytes":3},
            {"path":"main.typ","kind":"source","editable":true,"bytes":7}
        ])
    );
    assert_eq!(fs::read(root.join("main.typ")).unwrap(), b"Source.");
    assert_eq!(
        fs::read(root.join("main.typ.undertree-pending.json")).unwrap(),
        b"preserve pending"
    );
    assert_eq!(
        fs::read(root.join("main.typ.undertree-review.json")).unwrap(),
        b"preserve corrupt sidecar"
    );
    assert_eq!(
        fs::read(temporary.path().join("state/projects.json")).unwrap(),
        registry
    );
    assert_eq!(
        service.local(Operation::Files { project }).unwrap(),
        json!(["For-AI/private.typ", "main.typ"])
    );
}

#[test]
fn folder_creation_is_one_leaf_preserves_collisions_and_never_enrolls_git_or_metadata() {
    let temporary = tempfile::tempdir().unwrap();
    let root = temporary.path().join("project");
    fs::create_dir(&root).unwrap();
    let (service, project) = approve(&root, &temporary.path().join("state"));
    let registry = fs::read(temporary.path().join("state/projects.json")).unwrap();
    for path in ["chapters", "chapters/Überblick"] {
        assert_eq!(
            service
                .local(Operation::CreateDirectory {
                    project: project.clone(),
                    path: path.into()
                })
                .unwrap(),
            json!({"project":project,"path":path,"created":true})
        );
    }
    assert!(root.join("chapters/Überblick").is_dir());
    assert_eq!(
        fs::read_dir(root.join("chapters/Überblick"))
            .unwrap()
            .count(),
        0
    );
    for path in ["chapters", "chapters/Überblick"] {
        assert_eq!(
            service
                .local(Operation::CreateDirectory {
                    project: project.clone(),
                    path: path.into()
                })
                .unwrap_err()
                .code,
            "exists"
        );
    }
    fs::write(root.join("occupied"), "Keep this file.").unwrap();
    assert_eq!(
        service
            .local(Operation::CreateDirectory {
                project: project.clone(),
                path: "occupied".into()
            })
            .unwrap_err()
            .code,
        "exists"
    );
    assert_eq!(
        fs::read_to_string(root.join("occupied")).unwrap(),
        "Keep this file."
    );
    for path in [
        "",
        "/outside",
        "../outside",
        "chapters/../outside",
        "chapters//double",
        "chapters/",
        ".git",
        ".hidden",
        "node_modules/new",
        "For-AI/new",
        "C:\\outside",
        "CON",
        "nested/NUL.txt",
        "trailing.",
        "trailing ",
        "file.undertree-review.json",
    ] {
        assert_eq!(
            service
                .local(Operation::CreateDirectory {
                    project: project.clone(),
                    path: path.into()
                })
                .unwrap_err()
                .code,
            "path",
            "{path}"
        );
    }
    assert!(service
        .local(Operation::CreateDirectory {
            project: project.clone(),
            path: "missing/child".into()
        })
        .is_err());
    assert!(!root.join("missing").exists());
    assert!(!root.join(".git").exists());
    assert!(service.project(&project).unwrap().pending.is_empty());
    assert_eq!(
        fs::read(temporary.path().join("state/projects.json")).unwrap(),
        registry
    );
    assert!(service
        .local(Operation::Files {
            project: project.clone()
        })
        .unwrap()
        .as_array()
        .unwrap()
        .is_empty());
    assert_eq!(
        tree(&service, &project)["entries"]
            .as_array()
            .unwrap()
            .len(),
        3
    );
}

#[tokio::test]
async fn only_local_ui_can_inventory_or_create_and_discovery_never_advertises_them_to_cli() {
    let temporary = tempfile::tempdir().unwrap();
    let root = temporary.path().join("project");
    fs::create_dir(&root).unwrap();
    let (service, project) = approve(&root, &temporary.path().join("state"));
    for caller in [CallerContext::LocalCli, CallerContext::Review] {
        for operation in [
            Operation::ProjectTree {
                project: project.clone(),
            },
            Operation::CreateDirectory {
                project: project.clone(),
                path: "denied".into(),
            },
        ] {
            assert_eq!(
                service
                    .dispatch_as(caller, operation)
                    .await
                    .unwrap_err()
                    .code,
                "scope"
            );
        }
    }
    for caller in [CallerContext::Local, CallerContext::LocalCli] {
        let caps = service.capabilities(caller).unwrap();
        for action in ["project_tree", "create_directory"] {
            assert_eq!(
                caps["localOperations"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|entry| entry["action"] == action),
                caller == CallerContext::Local
            );
        }
    }
    for tool in ["project_tree", "create_directory"] {
        assert_eq!(
            service
                .remote(tool, json!({"project":project}))
                .unwrap_err()
                .code,
            "scope"
        );
    }
    assert!(!root.join("denied").exists());
    service
        .dispatch_as(
            CallerContext::Local,
            Operation::CreateDirectory {
                project: project.clone(),
                path: "allowed".into(),
            },
        )
        .await
        .unwrap();
    assert_eq!(
        service
            .dispatch_as(CallerContext::Local, Operation::ProjectTree { project })
            .await
            .unwrap()["entries"][0]["path"],
        "allowed"
    );
}

#[test]
fn over_deep_inventory_reports_partial_without_hiding_the_boundary_directory() {
    let temporary = tempfile::tempdir().unwrap();
    let root = temporary.path().join("project");
    fs::create_dir(&root).unwrap();
    let mut deepest = root.clone();
    for _ in 0..34 {
        deepest.push("d");
        fs::create_dir(&deepest).unwrap();
    }
    fs::write(deepest.join("not-in-inventory.png"), [0xff]).unwrap();
    let (service, project) = approve(&root, &temporary.path().join("state"));
    let result = tree(&service, &project);
    assert_eq!(result["truncated"], true);
    assert_eq!(result["limits"]["maxDepth"], 32);
    assert!(result["entries"]
        .as_array()
        .unwrap()
        .iter()
        .all(|entry| entry["kind"] == "directory"));
    assert_eq!(result["entries"].as_array().unwrap().len(), 32);
}

#[cfg(unix)]
#[test]
fn non_unicode_names_are_counted_once_and_links_never_expose_or_create_outside() {
    use std::ffi::OsStr;
    use std::os::unix::{ffi::OsStrExt, fs::symlink};
    let temporary = tempfile::tempdir().unwrap();
    let root = temporary.path().join("project");
    let outside = temporary.path().join("outside");
    fs::create_dir(&root).unwrap();
    fs::create_dir(&outside).unwrap();
    fs::write(outside.join("private.typ"), "Private.").unwrap();
    symlink(&outside, root.join("linked-directory")).unwrap();
    symlink(outside.join("private.typ"), root.join("linked.typ")).unwrap();
    let bad_directory = root.join(OsStr::from_bytes(b"bad-\xff"));
    fs::create_dir(&bad_directory).unwrap();
    fs::write(
        bad_directory.join("unseen.typ"),
        "Do not count descendants.",
    )
    .unwrap();
    fs::write(root.join(OsStr::from_bytes(b"bad-\xfe.png")), [0xff]).unwrap();
    fs::write(root.join("valid.png"), [0xff, 0xfe]).unwrap();
    let (service, project) = approve(&root, &temporary.path().join("state"));
    let result = tree(&service, &project);
    assert_eq!(result["omittedNonUtf8"], 2);
    assert_eq!(result["truncated"], false);
    assert_eq!(
        result["entries"],
        json!([{"path":"valid.png","kind":"asset","editable":false,"bytes":2}])
    );
    assert!(service
        .local(Operation::CreateDirectory {
            project: project.clone(),
            path: "linked-directory/escape".into()
        })
        .is_err());
    assert_eq!(
        service
            .local(Operation::CreateDirectory {
                project: project.clone(),
                path: "linked-directory".into()
            })
            .unwrap_err()
            .code,
        "exists"
    );
    assert!(!outside.join("escape").exists());
    let moved = temporary.path().join("moved");
    fs::rename(&root, &moved).unwrap();
    symlink(&outside, &root).unwrap();
    for operation in [
        Operation::ProjectTree {
            project: project.clone(),
        },
        Operation::CreateDirectory {
            project,
            path: "escape".into(),
        },
    ] {
        assert_eq!(service.local(operation).unwrap_err().code, "path");
    }
    assert!(!outside.join("escape").exists());
    assert_eq!(
        fs::read_to_string(outside.join("private.typ")).unwrap(),
        "Private."
    );
}
