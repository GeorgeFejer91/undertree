use serde_json::{json, Value};
use std::{fs, sync::Arc};
use undertree_review::{
    document::digest,
    service::{editor::EditorOperation, Service},
    SourceRequest,
};

struct Fixture {
    _temp: tempfile::TempDir,
    service: Arc<Service>,
    project: String,
    root: std::path::PathBuf,
    owner: String,
}
impl Fixture {
    fn new() -> Self {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("project");
        fs::create_dir(&root).unwrap();
        fs::write(root.join("main.typ"), "Original").unwrap();
        let service = Service::new(temp.path().join("state")).unwrap();
        let project = service
            .local(undertree_review::Operation::AddProject {
                root: root.to_str().unwrap().into(),
            })
            .unwrap()["id"]
            .as_str()
            .unwrap()
            .to_owned();
        let owner = service.connect_native_editor("main").unwrap()["ownerId"]
            .as_str()
            .unwrap()
            .to_owned();
        Self {
            _temp: temp,
            service,
            project,
            root,
            owner,
        }
    }
    fn request(&self, mut value: Value) -> SourceRequest {
        value["project"] = json!(self.project);
        serde_json::from_value(value).unwrap()
    }
    async fn native(&self, value: Value) -> undertree_review::Result<Value> {
        self.service
            .dispatch_native_source("main", &self.owner, self.request(value))
            .await
    }
    async fn open(&self) -> Value {
        self.native(json!({"action":"open","path":"main.typ"}))
            .await
            .unwrap()
    }
    fn registry(&self) -> Vec<u8> {
        fs::read(self._temp.path().join("state/projects.json")).unwrap()
    }
    fn bytes(&self) -> Vec<(String, Vec<u8>)> {
        let mut result = fs::read_dir(&self.root)
            .unwrap()
            .map(|e| {
                let e = e.unwrap();
                (
                    e.file_name().to_str().unwrap().into(),
                    fs::read(e.path()).unwrap(),
                )
            })
            .collect::<Vec<_>>();
        result.sort();
        result
    }
}

#[test]
fn raw_expected_root_never_normalizes_duplicates_null_or_noncanonical_numbers() {
    let good = r#"{"action":"open","project":"p","path":"main.typ","expectedRoot":{"dev":"0","ino":"18446744073709551615"}}"#;
    assert!(serde_json::from_str::<SourceRequest>(good).is_ok());
    for root in [
        "null",
        "false",
        r#"{"dev":0,"ino":"1"}"#,
        r#"{"dev":"01","ino":"1"}"#,
        r#"{"dev":"1","ino":"1","ino":"2"}"#,
        r#"{"dev":"1","ino":"1","extra":0}"#,
    ] {
        assert!(serde_json::from_str::<SourceRequest>(&format!(
            r#"{{"action":"open","project":"p","path":"main.typ","expectedRoot":{root}}}"#
        ))
        .is_err());
    }
    assert!(serde_json::from_str::<SourceRequest>(r#"{"action":"open","project":"p","path":"main.typ","expectedRoot":{"dev":"1","ino":"2"},"expectedRoo\u0074":{"dev":"1","ino":"2"}}"#).is_err());
    assert!(serde_json::from_str::<SourceRequest>(r##"{"action":"palette","project":"p","path":"main.typ","revision":"r","expectedRoot":{"dev":"1","ino":"2"},"rules":[{"id":"r","label":"r","color":"#abcdef","action":"protect","prompt":"a","prompt":"b"}]}"##).is_err());
}

#[tokio::test]
async fn native_observation_is_root_bound_but_missing_root_cannot_produce_or_register() {
    let f = Fixture::new();
    let observed = f.open().await;
    let before = f.bytes();
    let registry = f.registry();
    assert!(observed["expectedRoot"]["ino"].as_str().is_some());
    for value in [
        json!({"action":"save","path":"main.typ","revision":digest("Original"),"content":"Changed"}),
        json!({"action":"create","path":"new.typ"}),
        json!({"action":"create_directory","path":"new"}),
        json!({"action":"share","path":"main.typ","enabled":true}),
    ] {
        assert_eq!(f.native(value).await.unwrap_err().code, "stale_root");
        assert_eq!(f.bytes(), before);
        assert_eq!(f.registry(), registry);
    }
    let register:EditorOperation=serde_json::from_value(json!({"action":"editor_register","project":f.project,"path":"main.typ","generation":0,"revision":digest("Original"),"contentDigest":digest("Original"),"dirty":false,"composing":false,"conflict":false})).unwrap();
    assert_eq!(
        f.service
            .editor_native("main", &f.owner, register)
            .await
            .unwrap_err()
            .code,
        "stale_root"
    );
    assert!(!f._temp.path().join("state/editor-saves").exists());
}

#[tokio::test]
async fn same_bytes_replacement_refuses_captured_native_effects_and_old_shared_id() {
    let f = Fixture::new();
    let observed = f.open().await;
    let root = observed["expectedRoot"].clone();
    let old_share = f
        .native(json!({"action":"share","path":"main.typ","enabled":true,"expectedRoot":root}))
        .await
        .unwrap();
    fs::rename(&f.root, f._temp.path().join("old-project")).unwrap();
    fs::create_dir(&f.root).unwrap();
    fs::write(f.root.join("main.typ"), "Original").unwrap();
    let before = f.bytes();
    let registry = f.registry();
    for value in [
        json!({"action":"save","path":"main.typ","revision":digest("Original"),"content":"Changed","expectedRoot":root}),
        json!({"action":"palette","path":"main.typ","revision":digest("Original"),"rules":[],"expectedRoot":root}),
        json!({"action":"open","path":"main.typ","expectedRoot":root}),
        json!({"action":"create","path":"new.typ","expectedRoot":root}),
        json!({"action":"create_directory","path":"new","expectedRoot":root}),
        json!({"action":"set_main_document","path":"main.typ","expectedRoot":root}),
    ] {
        assert_eq!(f.native(value).await.unwrap_err().code, "stale_root");
        assert_eq!(f.bytes(), before);
        assert_eq!(f.registry(), registry);
    }
    assert_eq!(
        f.service
            .remote(
                "read_manuscript",
                json!({"documentId":old_share["documentId"]})
            )
            .unwrap_err()
            .code,
        "scope"
    );
    let new = f.open().await;
    assert_ne!(new["expectedRoot"], root);
    assert_ne!(new["documentId"], observed["documentId"]);
    let new_share=f.native(json!({"action":"share","path":"main.typ","enabled":true,"expectedRoot":new["expectedRoot"]})).await.unwrap();
    assert_ne!(new_share["documentId"], old_share["documentId"]);
    assert_eq!(
        f.service
            .remote(
                "read_manuscript",
                json!({"documentId":old_share["documentId"]})
            )
            .unwrap_err()
            .code,
        "scope"
    );
    assert_eq!(
        f.service
            .remote(
                "read_manuscript",
                json!({"documentId":new_share["documentId"]})
            )
            .unwrap()["content"],
        "Original"
    );
}

#[tokio::test]
async fn native_save_and_directory_echo_exact_root_and_project_wide_residues_fail_before_effects() {
    let f = Fixture::new();
    let root = f.open().await["expectedRoot"].clone();
    let folder = f
        .native(json!({"action":"create_directory","path":"empty","expectedRoot":root}))
        .await
        .unwrap();
    assert_eq!(folder["expectedRoot"], root);
    fs::remove_dir(f.root.join("empty")).unwrap();
    let saved=f.native(json!({"action":"save","path":"main.typ","revision":digest("Original"),"content":"Saved","expectedRoot":root})).await.unwrap();
    assert_eq!(saved["expectedRoot"], root);
    for i in 0..8 {
        fs::write(
            f.root.join(format!(".undertree-compile-unknown-{i}.tmp")),
            b"retained",
        )
        .unwrap();
    }
    let before = f.bytes();
    let registry = f.registry();
    assert_eq!(f.native(json!({"action":"save","path":"main.typ","revision":digest("Saved"),"content":"Other","expectedRoot":root})).await.unwrap_err().code,"limit");
    assert_eq!(f.bytes(), before);
    assert_eq!(f.registry(), registry);
    assert!(!f.root.join("main.typ.undertree-pending.json").exists());
    assert!(!f._temp.path().join("state/editor-saves").exists());
}

#[test]
fn queued_retired_native_owner_is_checked_inside_the_blocking_worker() {
    let f = Fixture::new();
    let rt = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(1)
        .max_blocking_threads(1)
        .enable_all()
        .build()
        .unwrap();
    rt.block_on(async {
        let root=f.open().await["expectedRoot"].clone();
        let (entered_tx,entered_rx)=std::sync::mpsc::channel();let (release_tx,release_rx)=std::sync::mpsc::channel();
        let held=tokio::task::spawn_blocking(move||{entered_tx.send(()).unwrap();release_rx.recv().unwrap();});entered_rx.recv().unwrap();
        let request=f.request(json!({"action":"save","path":"main.typ","revision":digest("Original"),"content":"Old page","expectedRoot":root}));
        let service=f.service.clone();let owner=f.owner.clone();let action=tokio::spawn(async move {service.dispatch_native_source("main",&owner,request).await});
        tokio::task::yield_now().await;f.service.connect_native_editor("main").unwrap();release_tx.send(()).unwrap();held.await.unwrap();
        assert_eq!(action.await.unwrap().unwrap_err().code,"stale_session");assert_eq!(fs::read_to_string(f.root.join("main.typ")).unwrap(),"Original");assert!(!f.root.join("main.typ.undertree-pending.json").exists());
    });
}
