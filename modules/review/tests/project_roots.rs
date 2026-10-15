use serde_json::json;
use std::fs;
use std::path::Path;
use undertree_review::document::digest;
use undertree_review::service::Service;
use undertree_review::Operation;

async fn rejects_root_without_mutation(
    service: &std::sync::Arc<Service>,
    project: &str,
    state: &Path,
) {
    let registry = fs::read(state.join("projects.json")).unwrap();
    for operation in [
        Operation::Files {
            project: project.into(),
        },
        Operation::ProjectTree {
            project: project.into(),
        },
        Operation::CreateDirectory {
            project: project.into(),
            path: "denied-folder".into(),
        },
        Operation::GitStatus {
            project: project.into(),
        },
        Operation::BindGithub {
            project: project.into(),
            repository: "example/repository".into(),
            auto_sync: true,
        },
        Operation::Sync {
            project: project.into(),
        },
        Operation::Save {
            project: project.into(),
            path: "main.typ".into(),
            revision: digest("Original."),
            content: "Unauthorized".into(),
        },
    ] {
        let error = service.dispatch(operation).await.unwrap_err();
        assert_eq!(error.code, "path");
        assert!(error.message.contains("Approve its current location again"));
    }
    assert_eq!(fs::read(state.join("projects.json")).unwrap(), registry);
    assert_eq!(service.project(project).err().unwrap().code, "path");
}

#[tokio::test]
async fn moved_or_non_directory_project_roots_fail_before_inventory_and_git_actions() {
    let temporary = tempfile::tempdir().unwrap();
    let root = temporary.path().join("project");
    let moved = temporary.path().join("moved");
    let state = temporary.path().join("state");
    fs::create_dir(&root).unwrap();
    fs::write(root.join("main.typ"), "Original.").unwrap();
    let service = Service::new(state.clone()).unwrap();
    let project = service
        .local(Operation::AddProject {
            root: root.to_string_lossy().into(),
        })
        .unwrap()["id"]
        .as_str()
        .unwrap()
        .to_owned();
    assert_eq!(
        service
            .local(Operation::Files {
                project: project.clone()
            })
            .unwrap(),
        json!(["main.typ"])
    );
    fs::rename(&root, &moved).unwrap();
    rejects_root_without_mutation(&service, &project, &state).await;
    assert_eq!(
        fs::read_to_string(moved.join("main.typ")).unwrap(),
        "Original."
    );
    assert!(!moved.join(".git").exists());
    fs::write(&root, "This is no longer a directory.").unwrap();
    rejects_root_without_mutation(&service, &project, &state).await;
    assert_eq!(
        fs::read_to_string(&root).unwrap(),
        "This is no longer a directory."
    );
    assert!(!moved.join(".git").exists());
    fs::remove_file(&root).unwrap();
    fs::rename(&moved, &root).unwrap();
    assert_eq!(
        service.local(Operation::Files { project }).unwrap(),
        json!(["main.typ"])
    );
}

#[cfg(unix)]
#[tokio::test]
async fn symlink_swapped_roots_cannot_enumerate_or_mutate_an_unapproved_folder() {
    use std::os::unix::fs::symlink;
    let temporary = tempfile::tempdir().unwrap();
    let root = temporary.path().join("project");
    let moved = temporary.path().join("original");
    let outside = temporary.path().join("outside");
    let state = temporary.path().join("state");
    fs::create_dir(&root).unwrap();
    fs::create_dir(&outside).unwrap();
    fs::write(root.join("main.typ"), "Original.").unwrap();
    fs::write(outside.join("main.typ"), "Private outside source.").unwrap();
    fs::write(outside.join("private.typ"), "Private inventory.").unwrap();
    let service = Service::new(state.clone()).unwrap();
    let project = service
        .local(Operation::AddProject {
            root: root.to_string_lossy().into(),
        })
        .unwrap()["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let shared = service
        .local(Operation::Share {
            project: project.clone(),
            path: "main.typ".into(),
            enabled: true,
        })
        .unwrap();
    fs::rename(&root, &moved).unwrap();
    symlink(&outside, &root).unwrap();
    rejects_root_without_mutation(&service, &project, &state).await;
    assert_eq!(
        service
            .remote(
                "read_manuscript",
                json!({"documentId":shared["documentId"]})
            )
            .unwrap_err()
            .code,
        "path"
    );
    assert_eq!(
        fs::read_to_string(outside.join("main.typ")).unwrap(),
        "Private outside source."
    );
    assert_eq!(
        fs::read_to_string(moved.join("main.typ")).unwrap(),
        "Original."
    );
    assert!(!outside.join(".git").exists());
    assert!(!outside.join("main.typ.undertree-review.json").exists());
    fs::remove_file(&root).unwrap();
    fs::rename(&moved, &root).unwrap();
    assert_eq!(
        service
            .remote(
                "read_manuscript",
                json!({"documentId":shared["documentId"]})
            )
            .unwrap()["content"],
        "Original."
    );
}
