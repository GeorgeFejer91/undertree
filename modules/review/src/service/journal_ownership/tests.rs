use super::*;

struct Fixture {
    _temp: tempfile::TempDir,
    service: Arc<Service>,
    project: Project,
    file: PathBuf,
}

impl Fixture {
    fn new() -> Self {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("project");
        fs::create_dir(&root).unwrap();
        let file = root.join("main.typ");
        fs::write(&file, "Original").unwrap();
        let service = Service::new(temp.path().join("state")).unwrap();
        let project = serde_json::from_value(
            service
                .local(Operation::AddProject {
                    root: root.to_str().unwrap().into(),
                })
                .unwrap(),
        )
        .unwrap();
        Self {
            _temp: temp,
            service,
            project,
            file,
        }
    }
    fn journal(&self, content: &str) -> Journal {
        Journal {
            old_revision: digest("Original"),
            content: content.into(),
            review: Review::new(content),
            prior_review: Some(policy_continuity::ReviewObservation::Absent),
            editor_receipt: None,
            ownership: Some(JournalOwnership {
                project: self.project.id.clone(),
                path: "main.typ".into(),
                owns_source: content != "Original",
            }),
        }
    }
    fn write(&self, journal: &Journal) -> Vec<u8> {
        let bytes = serde_json::to_vec_pretty(journal).unwrap();
        fs::write(journal_path(&self.file), &bytes).unwrap();
        bytes
    }
    fn open(&self) -> Result<Value> {
        self.service.local(Operation::Open {
            project: self.project.id.clone(),
            path: "main.typ".into(),
        })
    }
    fn group(&self) -> Vec<Option<Vec<u8>>> {
        [
            &self.file,
            &sidecar(&self.file),
            &journal_path(&self.file),
            &self.service.state.join("projects.json"),
        ]
        .map(|path| fs::read(path).ok())
        .into()
    }
    fn receipt(&self, content: &str) -> editor::SaveReceipt {
        serde_json::from_value(json!({"protocolVersion":1,"requestId":Uuid::new_v4().to_string(),"instanceId":self.service.instance_id,"project":self.project.id,"path":"main.typ","sessionId":Uuid::new_v4().to_string(),"status":"pending","savedGeneration":3,"savedRevision":digest(content),"bufferStatus":"unconfirmed","error":null,"commitFingerprint":digest("capture")})).unwrap()
    }
    fn store_receipt(&self, value: &Value) -> (PathBuf, Vec<u8>) {
        let directory = self.service.state.join("editor-saves");
        fs::create_dir_all(&directory).unwrap();
        let path = directory.join(format!("{}.json", value["requestId"].as_str().unwrap()));
        let raw = serde_json::to_vec(value).unwrap();
        fs::write(&path, &raw).unwrap();
        (path, raw)
    }
}

#[test]
fn legacy_ordinary_journals_without_project_provenance_are_never_adopted() {
    for content in ["Original", "Next"] {
        let f = Fixture::new();
        let mut journal = f.journal(content);
        journal.ownership = None;
        f.write(&journal);
        let before = f.group();
        assert_eq!(f.open().unwrap_err().code, "recovery_conflict");
        assert_eq!(f.group(), before);
    }
}

#[test]
fn wrong_project_path_or_source_claim_preserves_every_file_before_recovery() {
    for kind in [
        "overlapping-project",
        "path",
        "false-source",
        "true-clean",
        "unknown-field",
    ] {
        let f = Fixture::new();
        let mut journal = f.journal(if kind == "true-clean" {
            "Original"
        } else {
            "Next"
        });
        match kind {
            "overlapping-project" => {
                let outer: Project = serde_json::from_value(
                    f.service
                        .local(Operation::AddProject {
                            root: f._temp.path().to_str().unwrap().into(),
                        })
                        .unwrap(),
                )
                .unwrap();
                journal.ownership = Some(JournalOwnership {
                    project: outer.id,
                    path: "project/main.typ".into(),
                    owns_source: true,
                });
            }
            "path" => journal.ownership.as_mut().unwrap().path = "other.typ".into(),
            "false-source" => journal.ownership.as_mut().unwrap().owns_source = false,
            "true-clean" => journal.ownership.as_mut().unwrap().owns_source = true,
            _ => (),
        }
        if kind == "unknown-field" {
            let mut value = serde_json::to_value(&journal).unwrap();
            value["ownership"]["foreign"] = json!(true);
            fs::write(journal_path(&f.file), serde_json::to_vec(&value).unwrap()).unwrap();
        } else {
            f.write(&journal);
        }
        let before = f.group();
        assert_eq!(f.open().unwrap_err().code, "recovery_conflict", "{kind}");
        assert_eq!(f.group(), before, "{kind}");
    }
}

#[test]
fn registry_failure_retains_journal_and_memory_then_retry_completes_exact_ownership_once() {
    let f = Fixture::new();
    let mut registry = lock(&f.service.registry).unwrap();
    let entry = registry
        .projects
        .iter_mut()
        .find(|p| p.id == f.project.id)
        .unwrap();
    entry.pending.insert("unrelated.bin".into());
    entry
        .pending_revisions
        .insert("unrelated.bin".into(), digest("untouched"));
    f.service.save_registry(&registry).unwrap();
    drop(registry);
    let journal = f.journal("Next");
    let pending = f.write(&journal);
    let registry_path = f.service.state.join("projects.json");
    let old = fs::read(&registry_path).unwrap();
    fs::remove_file(&registry_path).unwrap();
    fs::create_dir(&registry_path).unwrap();
    assert!(f.open().is_err());
    assert_eq!(fs::read_to_string(&f.file).unwrap(), "Next");
    assert_eq!(fs::read(journal_path(&f.file)).unwrap(), pending);
    let memory = f.service.project(&f.project.id).unwrap();
    assert_eq!(memory.pending_revisions.len(), 1);
    assert_eq!(
        memory.pending_revisions["unrelated.bin"],
        digest("untouched")
    );
    fs::remove_dir(&registry_path).unwrap();
    fs::write(&registry_path, old).unwrap();
    assert_eq!(f.open().unwrap()["content"], "Next");
    assert!(!journal_path(&f.file).exists());
    let memory = f.service.project(&f.project.id).unwrap();
    assert_eq!(memory.pending_revisions.len(), 3);
    assert_eq!(memory.pending_revisions["main.typ"], digest("Next"));
    assert_eq!(
        memory.pending_revisions["main.typ.undertree-review.json"],
        digest(&fs::read_to_string(sidecar(&f.file)).unwrap())
    );
    assert_eq!(
        memory.pending_revisions["unrelated.bin"],
        digest("untouched")
    );
    let completed = fs::read(&registry_path).unwrap();
    f.open().unwrap();
    assert_eq!(fs::read(registry_path).unwrap(), completed);
}

#[test]
fn actual_save_registry_failure_retains_generated_proof_and_unpublished_memory() {
    let f = Fixture::new();
    let registry_path = f.service.state.join("projects.json");
    let old = fs::read(&registry_path).unwrap();
    fs::remove_file(&registry_path).unwrap();
    fs::create_dir(&registry_path).unwrap();
    assert!(f
        .service
        .local(Operation::Save {
            project: f.project.id.clone(),
            path: "main.typ".into(),
            revision: digest("Original"),
            content: "Next".into()
        })
        .is_err());
    assert_eq!(fs::read_to_string(&f.file).unwrap(), "Next");
    let journal_raw = fs::read(journal_path(&f.file)).unwrap();
    let journal: Value = serde_json::from_slice(&journal_raw).unwrap();
    assert_eq!(
        journal["ownership"],
        json!({"project":f.project.id,"path":"main.typ","owns_source":true})
    );
    assert!(f.service.project(&f.project.id).unwrap().pending.is_empty());
    fs::remove_dir(&registry_path).unwrap();
    fs::write(&registry_path, old).unwrap();
    assert_eq!(f.open().unwrap()["content"], "Next");
    assert_eq!(
        f.service.project(&f.project.id).unwrap().pending_revisions["main.typ"],
        digest("Next")
    );
    assert!(!journal_path(&f.file).exists());
}

#[tokio::test]
async fn clean_editor_recovery_tracks_metadata_only_and_preserves_user_index() {
    for legacy in [false, true] {
        let f = Fixture::new();
        git(&f.project.root, &["init", "-b", "main"]).await.unwrap();
        fs::write(f.project.root.join("user.txt"), "User staging").unwrap();
        git(&f.project.root, &["add", "--", "user.txt"])
            .await
            .unwrap();
        let index = fs::read(f.project.root.join(".git/index")).unwrap();
        let mut journal = f.journal("Original");
        let receipt = f.receipt("Original");
        journal.editor_receipt = Some(receipt.clone());
        if legacy {
            journal.ownership = None;
        }
        let receipt_value = serde_json::to_value(&receipt).unwrap();
        let request_id = receipt_value["requestId"].as_str().unwrap();
        let receipts = f.service.state.join("editor-saves");
        fs::create_dir_all(&receipts).unwrap();
        fs::write(
            receipts.join(format!("{request_id}.json")),
            serde_json::to_vec_pretty(&receipt).unwrap(),
        )
        .unwrap();
        f.write(&journal);
        assert_eq!(f.open().unwrap()["content"], "Original");
        let project = f.service.project(&f.project.id).unwrap();
        assert!(!project.pending.contains("main.typ"));
        assert!(!project.pending_revisions.contains_key("main.typ"));
        assert_eq!(project.pending_revisions.len(), 1);
        assert!(project.pending.contains("main.typ.undertree-review.json"));
        assert_eq!(fs::read(f.project.root.join(".git/index")).unwrap(), index);
        assert_eq!(
            f.service.editor_save_receipt(request_id).unwrap()["status"],
            "committed"
        );
    }
}

#[test]
fn inconsistent_editor_receipt_binding_is_refused_before_mutation() {
    let f = Fixture::new();
    let mut journal = f.journal("Next");
    let mut receipt = f.receipt("Next");
    receipt.path = "other.typ".into();
    journal.editor_receipt = Some(receipt);
    f.write(&journal);
    let before = f.group();
    assert_eq!(f.open().unwrap_err().code, "recovery_conflict");
    assert_eq!(f.group(), before);
}

#[test]
fn absent_or_mismatched_durable_receipt_slots_preserve_files_registry_and_existing_receipt() {
    for legacy in [false, true] {
        for kind in [
            "absent",
            "project",
            "path",
            "instanceId",
            "sessionId",
            "savedGeneration",
            "savedRevision",
            "commitFingerprint",
            "rejected",
            "error",
        ] {
            let f = Fixture::new();
            let mut journal = f.journal("Next");
            let receipt = f.receipt("Next");
            journal.editor_receipt = Some(receipt.clone());
            if legacy {
                journal.ownership = None;
            }
            let mut current = serde_json::to_value(&receipt).unwrap();
            match kind {
                "project" | "path" => current[kind] = json!("other"),
                "instanceId" | "sessionId" => current[kind] = json!(Uuid::new_v4().to_string()),
                "savedGeneration" => current[kind] = json!(4),
                "savedRevision" | "commitFingerprint" => current[kind] = json!(digest("other")),
                "rejected" => current["status"] = json!("rejected"),
                "error" => current["error"] = json!({"code":"rejected","message":"Other request"}),
                _ => (),
            }
            let slot = if kind == "absent" {
                None
            } else {
                Some(f.store_receipt(&current))
            };
            f.write(&journal);
            let before = f.group();
            assert_eq!(
                f.open().unwrap_err().code,
                "recovery_conflict",
                "{legacy}/{kind}"
            );
            assert_eq!(f.group(), before, "{legacy}/{kind}");
            if let Some((path, raw)) = slot {
                assert_eq!(fs::read(path).unwrap(), raw);
            }
        }
    }
}

#[test]
fn proven_committed_receipt_retry_preserves_exact_buffer_confirmation_bytes() {
    for legacy in [false, true] {
        for buffer in ["saved", "newer_buffer"] {
            let f = Fixture::new();
            let mut journal = f.journal("Next");
            let receipt = f.receipt("Next");
            journal.editor_receipt = Some(receipt.clone());
            if legacy {
                journal.ownership = None;
            }
            let mut current = serde_json::to_value(&receipt).unwrap();
            current["status"] = json!("committed");
            current["bufferStatus"] = json!(buffer);
            let (slot, raw) = f.store_receipt(&current);
            fs::write(&f.file, "Next").unwrap();
            fs::write(
                sidecar(&f.file),
                serde_json::to_vec_pretty(&journal.review).unwrap(),
            )
            .unwrap();
            f.write(&journal);
            assert_eq!(f.open().unwrap()["content"], "Next");
            assert_eq!(fs::read(slot).unwrap(), raw);
            assert!(!journal_path(&f.file).exists());
            assert_eq!(
                f.service.project(&f.project.id).unwrap().pending_revisions["main.typ"],
                digest("Next")
            );
        }
    }
}

#[test]
fn editor_registry_failure_keeps_pending_receipt_until_exact_retry_completes() {
    let f = Fixture::new();
    let mut journal = f.journal("Next");
    let receipt = f.receipt("Next");
    journal.editor_receipt = Some(receipt.clone());
    let (slot, raw) = f.store_receipt(&serde_json::to_value(&receipt).unwrap());
    let pending = f.write(&journal);
    let registry = f.service.state.join("projects.json");
    let before = fs::read(&registry).unwrap();
    fs::remove_file(&registry).unwrap();
    fs::create_dir(&registry).unwrap();
    assert!(f.open().is_err());
    assert_eq!(fs::read(&slot).unwrap(), raw);
    assert_eq!(fs::read(journal_path(&f.file)).unwrap(), pending);
    assert!(f.service.project(&f.project.id).unwrap().pending.is_empty());
    fs::remove_dir(&registry).unwrap();
    fs::write(&registry, before).unwrap();
    f.open().unwrap();
    let completed: Value = serde_json::from_slice(&fs::read(slot).unwrap()).unwrap();
    assert_eq!(completed["status"], "committed");
    assert!(!journal_path(&f.file).exists());
}

#[test]
fn create_and_tex_import_preserve_external_replacement_after_first_publication() {
    for import in [false, true] {
        let f = Fixture::new();
        fs::write(
            f.project.root.join("input.tex"),
            "\\begin{document}Text\\end{document}",
        )
        .unwrap();
        let target = f.project.root.join("new.typ");
        let replaced = target.clone();
        *lock(&f.service.create_after_publish).unwrap() = Some(Box::new(move || {
            fs::remove_file(&replaced)?;
            fs::write(&replaced, "External replacement")?;
            Err(Error::new(
                "io",
                "Injected failure after published source replacement.",
            ))
        }));
        let registry = fs::read(f.service.state.join("projects.json")).unwrap();
        let op = if import {
            Operation::ImportTex {
                project: f.project.id.clone(),
                path: "input.tex".into(),
                target: "new.typ".into(),
            }
        } else {
            Operation::Create {
                project: f.project.id.clone(),
                path: "new.typ".into(),
            }
        };
        assert_eq!(f.service.local(op).unwrap_err().code, "outcome_unknown");
        assert_eq!(fs::read_to_string(&target).unwrap(), "External replacement");
        assert!(!sidecar(&target).exists());
        assert!(
            !PathBuf::from(format!("{}.import-report.json", target.to_str().unwrap())).exists()
        );
        assert_eq!(
            fs::read(f.service.state.join("projects.json")).unwrap(),
            registry
        );
        assert!(f.service.project(&f.project.id).unwrap().pending.is_empty());
    }
}
