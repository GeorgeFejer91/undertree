mod common;
use serde_json::{json, Value};
use std::{fs, path::PathBuf, sync::Arc};
use undertree_review::{
    document::{digest, Anchor, Marker, Review},
    service::Service,
    Operation,
};

const ORIGINAL: &str = "<p>Protected text.</p>";
const NEXT: &str = "<p>Protected text. Added.</p>";

struct Fixture {
    _temp: tempfile::TempDir,
    service: Arc<Service>,
    project: String,
    source: PathBuf,
    metadata: PathBuf,
    pending: PathBuf,
    registry: PathBuf,
    review: Review,
    raw: Vec<u8>,
}

impl Fixture {
    fn new() -> Self {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("project");
        fs::create_dir(&root).unwrap();
        let source = root.join("main.html");
        let metadata = root.join("main.html.undertree-review.json");
        let pending = root.join("main.html.undertree-pending.json");
        fs::write(&source, ORIGINAL).unwrap();
        let mut review = Review::new(ORIGINAL);
        review.markers.push(Marker {
            id: "protected".into(),
            anchor: Anchor::new(ORIGINAL, 3, 12).unwrap(),
            rule: "protect".into(),
            prompt: "Keep this protection.".into(),
        });
        let raw = serde_json::to_vec_pretty(&review).unwrap();
        fs::write(&metadata, &raw).unwrap();
        let state = temp.path().join("state");
        let service = Service::new(state.clone()).unwrap();
        let project = service
            .local(Operation::AddProject {
                root: root.to_str().unwrap().into(),
            })
            .unwrap()["id"]
            .as_str()
            .unwrap()
            .into();
        Self {
            _temp: temp,
            service,
            project,
            source,
            metadata,
            pending,
            registry: state.join("projects.json"),
            review,
            raw,
        }
    }
    fn open(&self) -> undertree_review::Result<Value> {
        self.service.local(Operation::Open {
            project: self.project.clone(),
            path: "main.html".into(),
        })
    }
    fn share(&self, enabled: bool) -> undertree_review::Result<Value> {
        self.service.local(Operation::Share {
            project: self.project.clone(),
            path: "main.html".into(),
            enabled,
            context_shared: true,
            expected_context_scope: common::context_scope(
                &self.service,
                &self.project,
                &"main.html",
            ),
        })
    }
    fn journal(&self, prior: Option<Value>) -> Vec<u8> {
        let mut review = self.review.clone();
        review.reconcile(ORIGINAL, NEXT);
        let mut journal = json!({"old_revision":digest(ORIGINAL),"content":NEXT,"review":review});
        if let Some(prior) = prior {
            journal["prior_review"] = prior;
            journal["ownership"] =
                json!({"project":self.project,"path":"main.html","owns_source":true});
        }
        serde_json::to_vec_pretty(&journal).unwrap()
    }
    fn hash_prior(&self) -> Value {
        json!({"state":"hash","sha256":digest(std::str::from_utf8(&self.raw).unwrap())})
    }
    fn group(&self) -> Vec<Option<Vec<u8>>> {
        [&self.source, &self.metadata, &self.pending, &self.registry]
            .map(|path| fs::read(path).ok())
            .into()
    }
}

#[test]
fn known_policy_loss_denies_local_writes_and_remote_proposals_without_resetting_it() {
    let f = Fixture::new();
    let document = f.share(true).unwrap()["documentId"].clone();
    let scope = common::context_scope(&f.service, &f.project, "main.html").unwrap();
    fs::remove_file(&f.metadata).unwrap();
    let before = f.group();
    for operation in [
        json!({"action":"open"}),
        json!({"action":"review"}),
        json!({"action":"save","revision":digest(ORIGINAL),"content":NEXT}),
        json!({"action":"palette","revision":digest(ORIGINAL),"rules":f.review.rules}),
        json!({"action":"mark","revision":digest(ORIGINAL),"from":3,"to":12,"rule":"protect","prompt":"new"}),
        json!({"action":"reanchor","revision":digest(ORIGINAL),"id":"protected","from":3,"to":12,"quote":"Protected"}),
        json!({"action":"unmark","revision":digest(ORIGINAL),"id":"protected"}),
        json!({"action":"decide","revision":digest(ORIGINAL),"id":"proposal","decision":"accepted"}),
        json!({"action":"share","enabled":true,"contextShared":true,"expectedContextScope":scope}),
    ] {
        let mut operation = operation;
        operation["project"] = json!(f.project);
        operation["path"] = json!("main.html");
        let expected = if operation["action"] == "decide" {
            "pdf_policy" // The project-wide PDF policy guard runs before the active-source guard.
        } else {
            "policy_missing"
        };
        assert_eq!(
            f.service
                .local(serde_json::from_value(operation).unwrap())
                .unwrap_err()
                .code,
            expected
        );
        assert_eq!(f.group(), before);
    }
    for (tool, arguments) in [
        ("read_manuscript", json!({"documentId":document})),
        (
            "suggest_text",
            json!({"documentId":document,"proposal":{"requestId":"proposal","revision":digest(ORIGINAL),"from":3,"to":12,"quote":"Protected","replacement":"Changed","rationale":"Test"}}),
        ),
    ] {
        assert_eq!(
            f.service.remote(tool, arguments).unwrap_err().code,
            "policy_missing"
        );
        assert_eq!(f.group(), before);
    }
    f.share(false).unwrap();
    assert_eq!(
        f.group(),
        before,
        "Restrictive revocation never saves the source."
    );
    assert_eq!(f.share(true).unwrap_err().code, "policy_missing");
    fs::write(
        &f.metadata,
        serde_json::to_vec_pretty(&Review::new(ORIGINAL)).unwrap(),
    )
    .unwrap();
    assert_eq!(
        f.open().unwrap_err().code,
        "policy_missing",
        "A fresh empty policy cannot resolve the recorded loss."
    );
    fs::write(&f.metadata, &f.raw).unwrap();
    let restored = f
        .service
        .local(Operation::Review {
            project: f.project.clone(),
            path: "main.html".into(),
        })
        .unwrap();
    assert_eq!(restored["review"]["markers"][0]["id"], "protected");
    f.share(true).unwrap();
    assert_eq!(fs::read(&f.source).unwrap(), ORIGINAL.as_bytes());
    assert_eq!(fs::read(&f.metadata).unwrap(), f.raw);
}

#[test]
fn corrupt_unknown_or_ambiguous_metadata_preserves_the_entire_recovery_group() {
    for modern in [false, true] {
        for already_written in [false, true] {
            for kind in ["corrupt", "unknown", "changed-valid"] {
                let f = Fixture::new();
                let raw = f.journal(modern.then(|| f.hash_prior()));
                fs::write(&f.pending, &raw).unwrap();
                if already_written {
                    fs::write(&f.source, NEXT).unwrap();
                }
                let changed = match kind {
                    "corrupt" => b"unexpected external bytes".to_vec(),
                    "unknown" => {
                        let mut value = serde_json::to_value(&f.review).unwrap();
                        value["version"] = json!(99);
                        serde_json::to_vec(&value).unwrap()
                    }
                    _ => {
                        let mut review = f.review.clone();
                        review.markers[0].prompt = "External metadata change".into();
                        serde_json::to_vec_pretty(&review).unwrap()
                    }
                };
                fs::write(&f.metadata, changed).unwrap();
                let before = f.group();
                assert_eq!(
                    f.open().unwrap_err().code,
                    "recovery_conflict",
                    "{modern}/{already_written}/{kind}"
                );
                assert_eq!(f.group(), before);
            }
        }
    }
    let f = Fixture::new();
    fs::write(&f.pending, f.journal(None)).unwrap();
    let before = f.group();
    assert_eq!(
        f.open().unwrap_err().code,
        "recovery_conflict",
        "A legacy journal does not own a different valid old sidecar."
    );
    assert_eq!(f.group(), before);
}

#[test]
fn malformed_or_unknown_journal_proofs_refuse_recovery_without_any_file_effect() {
    for kind in [
        "malformed",
        "unknown-field",
        "unknown-proof",
        "invalid-hash",
    ] {
        let f = Fixture::new();
        let mut journal: Value = serde_json::from_slice(&f.journal(Some(f.hash_prior()))).unwrap();
        let bytes = match kind {
            "malformed" => b"{external interrupted JSON".to_vec(),
            "unknown-field" => {
                journal["externalOwnership"] = json!(true);
                serde_json::to_vec(&journal).unwrap()
            }
            "unknown-proof" => {
                journal["prior_review"] = json!({"state":"future"});
                serde_json::to_vec(&journal).unwrap()
            }
            _ => {
                journal["prior_review"] = json!({"state":"hash","sha256":"invalid"});
                serde_json::to_vec(&journal).unwrap()
            }
        };
        fs::write(&f.pending, bytes).unwrap();
        let before = f.group();
        assert_eq!(f.open().unwrap_err().code, "recovery_conflict", "{kind}");
        assert_eq!(f.group(), before);
    }
}

#[test]
fn explicit_ownership_recovers_both_phases_and_unbound_legacy_journals_remain_preserved() {
    for mode in [
        "modern-hash",
        "modern-absent",
        "legacy-absent",
        "legacy-final",
    ] {
        for source_written in [false, true] {
            let f = Fixture::new();
            let prior = match mode {
                "modern-hash" => Some(f.hash_prior()),
                "modern-absent" => Some(json!({"state":"absent"})),
                _ => None,
            };
            let raw = f.journal(prior);
            let journal: Value = serde_json::from_slice(&raw).unwrap();
            let final_review: Review = serde_json::from_value(journal["review"].clone()).unwrap();
            let final_metadata = serde_json::to_vec_pretty(&final_review).unwrap();
            if mode.ends_with("absent") {
                fs::remove_file(&f.metadata).unwrap();
            }
            if mode == "legacy-final" {
                fs::write(&f.metadata, &final_metadata).unwrap();
            }
            if source_written {
                fs::write(&f.source, NEXT).unwrap();
            }
            fs::write(&f.pending, &raw).unwrap();
            if mode.starts_with("legacy") {
                let before = f.group();
                assert_eq!(f.open().unwrap_err().code, "recovery_conflict");
                assert_eq!(f.group(), before);
                let mut bound: Value = serde_json::from_slice(&raw).unwrap();
                bound["ownership"] =
                    json!({"project":f.project,"path":"main.html","owns_source":true});
                fs::write(&f.pending, serde_json::to_vec(&bound).unwrap()).unwrap();
            }
            assert_eq!(
                f.open().unwrap()["content"],
                NEXT,
                "{mode}/{source_written}"
            );
            assert_eq!(fs::read(&f.metadata).unwrap(), final_metadata);
            assert!(!f.pending.exists());
        }
    }
}

#[test]
fn known_missing_policy_blocks_even_a_modern_journal_until_the_exact_original_is_restored() {
    let f = Fixture::new();
    f.open().unwrap();
    fs::write(&f.pending, f.journal(Some(f.hash_prior()))).unwrap();
    fs::remove_file(&f.metadata).unwrap();
    let before = f.group();
    assert_eq!(f.open().unwrap_err().code, "policy_missing");
    assert_eq!(f.group(), before);
    fs::write(&f.metadata, &f.raw).unwrap();
    assert_eq!(f.open().unwrap()["content"], NEXT);
    assert!(!f.pending.exists());
}

#[cfg(unix)]
#[test]
fn an_in_project_parent_alias_cannot_bypass_known_policy_loss() {
    let f = Fixture::new();
    f.open().unwrap();
    let root = f.source.parent().unwrap();
    std::os::unix::fs::symlink(root, root.join("alias")).unwrap();
    fs::remove_file(&f.metadata).unwrap();
    let before = f.group();
    assert_eq!(
        f.service
            .local(Operation::Review {
                project: f.project.clone(),
                path: "alias/main.html".into(),
            })
            .unwrap_err()
            .code,
        "stale"
    );
    assert_eq!(f.group(), before);
    assert_eq!(f.open().unwrap_err().code, "policy_missing");
    assert_eq!(f.group(), before);
    fs::write(&f.metadata, &f.raw).unwrap();
    assert_eq!(f.open().unwrap()["review"]["markers"][0]["id"], "protected");
}
