use super::*;
use crate::SourceRequest;

const TEXT: &str = "= Original source\n";
struct Fixture {
    temp: tempfile::TempDir,
    service: Arc<Service>,
    project: Project,
    outer: PathBuf,
    owner: String,
    owner_id: String,
}
impl Fixture {
    fn new() -> Self {
        let temp = tempfile::tempdir().unwrap();
        let outer = temp.path().join("outer");
        let inner = outer.join("nested");
        fs::create_dir_all(&inner).unwrap();
        fs::write(inner.join("main.typ"), TEXT).unwrap();
        let service = Service::new(temp.path().join("state")).unwrap();
        let project = serde_json::from_value(
            service
                .local(Operation::AddProject {
                    root: inner.to_str().unwrap().into(),
                })
                .unwrap(),
        )
        .unwrap();
        let owner_id = service.connect_native_editor("main").unwrap()["ownerId"]
            .as_str()
            .unwrap()
            .to_owned();
        let owner = service.native_editor_owner("main", &owner_id).unwrap();
        Self {
            temp,
            service,
            project,
            outer,
            owner,
            owner_id,
        }
    }
    fn approve_outer(&self) -> String {
        self.service
            .local(Operation::AddProject {
                root: self.outer.to_str().unwrap().into(),
            })
            .unwrap()["id"]
            .as_str()
            .unwrap()
            .to_owned()
    }
    fn begin(&self) -> String {
        self.service
            .begin_native_import_rooted(
                "main",
                &self.owner_id,
                &self.project.id,
                "",
                RootedRoot::observe(&self.project.root).unwrap(),
            )
            .unwrap()["selectionId"]
            .as_str()
            .unwrap()
            .to_owned()
    }
    fn input(&self, name: &str, bytes: &[u8]) -> PathBuf {
        let path = self.temp.path().join(name);
        fs::write(&path, bytes).unwrap();
        path
    }
}

#[tokio::test]
async fn staged_source_alias_refusal_preserves_existing_files_and_releases_own_selection() {
    let f = Fixture::new();
    f.approve_outer();
    let id = f.begin();
    let registry = fs::read(f.service.state.join("projects.json")).unwrap();
    let error = f
        .service
        .stage_native_import(&f.owner, &id, vec![f.input("main.typ", TEXT.as_bytes())])
        .await
        .unwrap_err();
    assert_eq!(error.code, "alias_conflict");
    assert!(!lock(&f.service.file_import)
        .unwrap()
        .selections
        .contains_key(&id));
    assert_eq!(
        fs::read_to_string(f.project.root.join("main.typ")).unwrap(),
        TEXT
    );
    assert_eq!(fs::read_dir(&f.project.root).unwrap().count(), 1);
    assert_eq!(
        fs::read(f.service.state.join("projects.json")).unwrap(),
        registry
    );
    assert!(f.service.documents.try_lock().is_ok());
}

#[tokio::test]
async fn latest_approval_blocks_already_staged_import_before_epoch_or_output_even_with_build_lease()
{
    let f = Fixture::new();
    let id = f.begin();
    f.service
        .stage_native_import(&f.owner, &id, vec![f.input("main.typ", TEXT.as_bytes())])
        .await
        .unwrap();
    let outer = f.approve_outer();
    let compiled = f
        .service
        .compile_typst_native_report(
            "main",
            &f.owner_id,
            SourceRequest {
                operation: Operation::Compile {
                    project: outer.clone(),
                    path: "nested/main.typ".into(),
                    revision: digest(TEXT),
                },
                source_epoch: 0,
                expected_root: Some(RootedRoot::observe(&f.outer).unwrap()),
            },
        )
        .await
        .unwrap();
    assert_eq!(compiled["status"], "succeeded");
    let target = f.project.root.join("main.typ");
    fs::remove_file(&target).unwrap();
    let registry = fs::read(f.service.state.join("projects.json")).unwrap();
    // This retained lease tests admission order; the actual real-child race is a separate probe.
    let build = f.service.compile_lock.clone().lock_owned().await;
    let request = Uuid::new_v4().to_string();
    let action = || ImportOperation::ImportFiles {
        selection_id: id.clone(),
        request_id: request.clone(),
    };
    let result = f
        .service
        .import_as(CallerContext::Local, &f.owner, action())
        .await
        .unwrap();
    assert_eq!(result["status"], "failed");
    assert_eq!(result["error"]["code"], "alias_conflict");
    assert_eq!(
        f.service
            .import_as(CallerContext::Local, &f.owner, action())
            .await
            .unwrap(),
        result
    );
    assert!(!target.exists());
    assert!(!sidecar(&target).exists());
    assert!(!journal_path(&target).exists());
    assert_eq!(
        fs::read(f.service.state.join("projects.json")).unwrap(),
        registry
    );
    assert!(f.service.source_epochs(&f.project.id).unwrap().is_empty());
    assert_eq!(
        f.service
            .source_epochs(&outer)
            .unwrap()
            .get("nested/main.typ"),
        Some(&0)
    );
    {
        let mut book = lock(&f.service.editor).unwrap();
        let paths = vec!["main.typ".to_owned()];
        book.reserve_import(&f.owner, &f.project.id, &paths)
            .unwrap();
        book.release_import(&f.project.id, &paths);
    }
    drop(build);
    let retained = f.service.preview_pdf(&outer, "nested/main.typ").unwrap();
    assert_eq!(retained["base64"], compiled["preview"]["base64"]);
    assert_eq!(retained["current"], false);
}

#[tokio::test]
async fn binary_asset_import_is_not_promoted_to_source_epoch_alias_policy() {
    let f = Fixture::new();
    f.approve_outer();
    let id = f.begin();
    let bytes = [0, 255, 128, 1];
    f.service
        .stage_native_import(&f.owner, &id, vec![f.input("image.png", &bytes)])
        .await
        .unwrap();
    let result = f
        .service
        .import_as(
            CallerContext::Local,
            &f.owner,
            ImportOperation::ImportFiles {
                selection_id: id,
                request_id: Uuid::new_v4().to_string(),
            },
        )
        .await
        .unwrap();
    assert_eq!(result["status"], "committed");
    assert_eq!(result["files"][0]["editable"], false);
    assert_eq!(fs::read(f.project.root.join("image.png")).unwrap(), bytes);
    assert!(f.service.source_epochs(&f.project.id).unwrap().is_empty());
    assert_eq!(
        fs::read_to_string(f.project.root.join("main.typ")).unwrap(),
        TEXT
    );
}
