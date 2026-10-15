//! Sparse project-specific lifecycle identities. Missing entries are legacy epoch zero.
use super::*;
use crate::MAX_SOURCE_EPOCH;

#[derive(Clone, Copy)]
pub(crate) struct SourceBinding<'a> {
    pub project: &'a str,
    pub path: &'a str,
    pub epoch: u64,
    pub root: Option<crate::RootObservation>,
    pub guarded: bool,
}
impl<'a> SourceBinding<'a> {
    pub(crate) fn new(project: &'a str, path: &'a str, epoch: u64) -> Self {
        Self {
            project,
            path,
            epoch,
            root: None,
            guarded: false,
        }
    }
    pub(crate) fn rooted(mut self, root: Option<crate::RootObservation>) -> Self {
        self.root = root;
        self
    }
    pub(crate) fn guarded(mut self, guarded: bool) -> Self {
        self.guarded = guarded;
        self
    }
}

pub(super) fn document_id(project: &str, path: &str, epoch: u64) -> String {
    if epoch == 0 {
        digest(&format!("{project}:{path}"))
    } else {
        digest(&format!(
            "undertree-document-v1\0{project}\0{path}\0{epoch}"
        ))
    }
}

pub(super) fn rooted_document_id(
    project: &str,
    path: &str,
    epoch: u64,
    root: RootObservation,
) -> String {
    digest(&format!(
        "undertree-document-root-v1\0{project}\0{path}\0{epoch}\0{}\0{}",
        root.dev, root.ino
    ))
}

pub(super) fn binding_document_id(binding: SourceBinding<'_>, observed: RootObservation) -> String {
    if binding.root.is_some() || binding.guarded {
        rooted_document_id(binding.project, binding.path, binding.epoch, observed)
    } else {
        document_id(binding.project, binding.path, binding.epoch)
    }
}

pub(super) fn stale() -> Error {
    Error::new("stale_document", "This source identity was retired. Reopen its current project entry; retained edits have not been saved.")
}

fn valid_path(path: &str) -> bool {
    !path.is_empty()
        && path.len() <= 4096
        && !path.contains('\\')
        && Path::new(path)
            .components()
            .all(|part| matches!(part, Component::Normal(_)))
        && Path::new(path)
            .components()
            .map(|part| part.as_os_str().to_string_lossy())
            .collect::<Vec<_>>()
            .join("/")
            == path
}

pub(super) fn validate(registry: &Registry) -> Result<()> {
    for (project, paths) in &registry.source_epochs {
        if !registry.projects.iter().any(|entry| &entry.id == project)
            || paths
                .iter()
                .any(|(path, epoch)| !valid_path(path) || *epoch > MAX_SOURCE_EPOCH)
        {
            return Err(Error::new(
                "format",
                "The saved source identities are invalid; their data was preserved.",
            ));
        }
    }
    Ok(())
}

pub(super) fn epoch_in(registry: &Registry, project: &str, path: &str) -> Result<u64> {
    if !valid_path(path) || !registry.projects.iter().any(|entry| entry.id == project) {
        return Err(Error::new(
            "path",
            "Choose a canonical source path in an approved project.",
        ));
    }
    let epoch = registry
        .source_epochs
        .get(project)
        .and_then(|paths| paths.get(path))
        .copied()
        .unwrap_or(0);
    if epoch > MAX_SOURCE_EPOCH {
        return Err(stale());
    }
    Ok(epoch)
}

pub(super) fn require_in(
    registry: &Registry,
    project: &str,
    path: &str,
    expected: u64,
) -> Result<()> {
    if expected > MAX_SOURCE_EPOCH || epoch_in(registry, project, path)? != expected {
        return Err(stale());
    }
    Ok(())
}

pub(super) fn rotate_reused(
    registry: &mut Registry,
    project: &str,
    path: &str,
    known_zero_binding: bool,
) -> Result<u64> {
    let epoch = epoch_in(registry, project, path)?;
    if epoch == 0
        && !known_zero_binding
        && !registry
            .source_epochs
            .get(project)
            .is_some_and(|paths| paths.contains_key(path))
    {
        return Ok(0);
    }
    let next = epoch
        .checked_add(1)
        .filter(|epoch| *epoch <= MAX_SOURCE_EPOCH)
        .ok_or_else(|| Error::new("limit", "This source identity cannot be reused again."))?;
    registry
        .source_epochs
        .entry(project.into())
        .or_default()
        .insert(path.into(), next);
    Ok(next)
}

pub(super) fn pending_source(path: &str) -> &str {
    path.strip_suffix(".undertree-review.json")
        .or_else(|| path.strip_suffix(".import-report.json"))
        .unwrap_or(path)
}

impl Service {
    pub(super) fn require_unaliased_source_creation(
        &self,
        project: &Project,
        group: &SourceGroup,
    ) -> Result<()> {
        let projects = lock(&self.registry)?.projects.clone();
        group.require_unaliased_creation(project, &projects)
    }

    // Caller retains editor -> documents, before taking Registry.
    pub(super) fn has_known_zero_binding(
        &self,
        book: &editor::EditorState,
        project: &str,
        path: &str,
    ) -> Result<bool> {
        Ok(book.has_source_binding(project, path, 0)
            || lock(&self.shared)?
                .values()
                .any(|(p, source, epoch, _)| p == project && source == path && *epoch == 0))
    }

    pub(crate) fn source_epoch(&self, project: &str, path: &str) -> Result<u64> {
        epoch_in(&*lock(&self.registry)?, project, path)
    }

    pub(crate) fn require_source_epoch(
        &self,
        project: &str,
        path: &str,
        expected: u64,
    ) -> Result<()> {
        require_in(&*lock(&self.registry)?, project, path, expected)
    }

    pub(crate) fn source_epochs(&self, project: &str) -> Result<BTreeMap<String, u64>> {
        let registry = lock(&self.registry)?;
        if !registry.projects.iter().any(|entry| entry.id == project) {
            return Err(stale());
        }
        Ok(registry
            .source_epochs
            .get(project)
            .cloned()
            .unwrap_or_default())
    }

    pub(crate) fn capture_source_epochs(
        &self,
        project: &str,
        path: &str,
        expected: u64,
    ) -> Result<BTreeMap<String, u64>> {
        let registry = lock(&self.registry)?;
        require_in(&registry, project, path, expected)?;
        Ok(registry
            .source_epochs
            .get(project)
            .cloned()
            .unwrap_or_default())
    }

    pub(crate) fn require_source_epochs(
        &self,
        project: &str,
        captured: &BTreeMap<String, u64>,
        paths: &BTreeSet<String>,
    ) -> Result<()> {
        let registry = lock(&self.registry)?;
        for path in paths {
            require_in(
                &registry,
                project,
                path,
                captured.get(path).copied().unwrap_or(0),
            )?;
        }
        Ok(())
    }

    // Caller retains the effect guard (native editor -> documents; legacy documents) before spawn.
    pub(crate) fn record_compiler_source_capture(
        &self,
        project: &str,
        captured_epochs: &BTreeMap<String, u64>,
        staged_inputs: &BTreeMap<String, String>,
    ) -> Result<()> {
        if staged_inputs.len() > 20_000 {
            return Err(Error::new(
                "limit",
                "The staged compiler inventory exceeds its bound.",
            ));
        }
        let mut registry = lock(&self.registry)?;
        if !registry.projects.iter().any(|entry| entry.id == project) {
            return Err(stale());
        }
        let mut next = registry.clone();
        let mut changed = false;
        for path in staged_inputs
            .keys()
            .filter(|path| editable_source(Path::new(path)))
        {
            let captured = captured_epochs.get(path).copied().unwrap_or(0);
            require_in(&next, project, path, captured)?;
            if captured == 0 {
                let paths = next.source_epochs.entry(project.into()).or_default();
                if !paths.contains_key(path) {
                    paths.insert(path.clone(), 0);
                    changed = true;
                }
            }
        }
        if !changed {
            return Ok(());
        }
        let expected = serde_json::to_string_pretty(&next)?;
        if expected.len() > MAX_TEXT {
            return Err(Error::new(
                "limit",
                "The compiler source identities exceed the registry bound.",
            ));
        }
        let written = self.save_registry(&next);
        #[cfg(test)]
        let written =
            compile_capture_tests::after_registry_write(&self.state.join("projects.json"), written);
        if let Err(error) = written {
            // An installed reservation still fences reuse even when its final sync reports failure.
            if read_text(&self.state.join("projects.json"), MAX_TEXT)
                .is_ok_and(|actual| actual == expected)
            {
                *registry = next;
            }
            return Err(error);
        }
        *registry = next;
        Ok(())
    }

    pub(super) fn check_source_request(&self, request: &crate::SourceRequest) -> Result<()> {
        if request.source_epoch > MAX_SOURCE_EPOCH {
            return Err(stale());
        }
        if request.operation.requires_source_epoch() {
            let (project, path) = request.operation.source_target().unwrap();
            self.require_source_epoch(project, path, request.source_epoch)?;
            let approved = self.project(project)?;
            let file = self.path(&approved, path, false)?;
            if file.canonicalize()? != file {
                return Err(Error::new(
                    "path",
                    "Use the canonical unlinked project-relative source path.",
                ));
            }
            // Reject linked ancestors at admission. Effects retain their existing optimistic checks.
            let root = project_tree::open_root(&approved.root)?;
            let parent = path.rsplit_once('/').map_or("", |(parent, _)| parent);
            project_tree::open_directory(&root, parent)?;
        }
        Ok(())
    }
}

#[cfg(test)]
mod compile_capture_tests;

#[cfg(all(test, unix))]
mod alias_tests;

#[cfg(test)]
impl Service {
    pub(crate) fn retire_source_for_test(&self, project: &str, path: &str) -> Result<u64> {
        let _documents = self
            .documents
            .try_lock()
            .map_err(|_| Error::new("busy", "Test document transition is busy."))?;
        let mut registry = lock(&self.registry)?;
        let mut next = registry.clone();
        let epoch = epoch_in(&next, project, path)?
            .checked_add(1)
            .filter(|epoch| *epoch <= MAX_SOURCE_EPOCH)
            .ok_or_else(|| Error::new("limit", "Source identity exhausted."))?;
        next.source_epochs
            .entry(project.into())
            .or_default()
            .insert(path.into(), epoch);
        self.save_registry(&next)?;
        *registry = next;
        Ok(epoch)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{document::Decision, SourceRequest};

    fn fixture() -> (tempfile::TempDir, Arc<Service>, Project, PathBuf) {
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
        (temp, service, project, file)
    }
    fn bound(operation: Operation, epoch: u64) -> SourceRequest {
        SourceRequest {
            operation,
            source_epoch: epoch,
            expected_root: None,
        }
    }

    #[tokio::test]
    async fn same_bytes_do_not_authorize_retired_mutation_recovery_or_registration() {
        let (_temp, service, project, file) = fixture();
        let initial = service
            .local(Operation::Open {
                project: project.id.clone(),
                path: "main.typ".into(),
            })
            .unwrap();
        assert_eq!(initial["sourceEpoch"], 0);
        assert!(initial["sidecarRevision"].is_null());
        service
            .retire_source_for_test(&project.id, "main.typ")
            .unwrap();
        let registry = fs::read(service.state.join("projects.json")).unwrap();
        let project_id = project.id.as_str();
        for request in [
            json!({"action":"open","project":project_id,"path":"main.typ"}),
            json!({"action":"save","project":project_id,"path":"main.typ","revision":digest("Original"),"content":"Changed"}),
            json!({"action":"palette","project":project_id,"path":"main.typ","revision":digest("Original"),"rules":[]}),
            json!({"action":"mark","project":project_id,"path":"main.typ","revision":digest("Original"),"from":0,"to":8,"rule":"r","prompt":""}),
            json!({"action":"unmark","project":project_id,"path":"main.typ","revision":digest("Original"),"id":"r"}),
            json!({"action":"reanchor","project":project_id,"path":"main.typ","revision":digest("Original"),"id":"r","from":0,"to":8,"quote":"Original"}),
            json!({"action":"decide","project":project_id,"path":"main.typ","revision":digest("Original"),"id":"r","decision":Decision::Accepted}),
            json!({"action":"share","project":project_id,"path":"main.typ","enabled":true}),
            json!({"action":"set_main_document","project":project_id,"path":"main.typ"}),
        ] {
            assert_eq!(
                service
                    .local_source(serde_json::from_value(request).unwrap())
                    .unwrap_err()
                    .code,
                "stale_document"
            );
            assert_eq!(fs::read(&file).unwrap(), b"Original");
            assert!(!sidecar(&file).exists());
            assert!(!journal_path(&file).exists());
            assert_eq!(
                fs::read(service.state.join("projects.json")).unwrap(),
                registry
            );
        }
        let registration = |epoch| {
            serde_json::from_value(json!({"action":"editor_register","project":project_id,"path":"main.typ","sourceEpoch":epoch,
            "generation":0,"revision":digest("Original"),"contentDigest":digest("Original"),"dirty":false,"composing":false,"conflict":false})).unwrap()
        };
        assert_eq!(
            service
                .editor("native:main", registration(0))
                .await
                .unwrap_err()
                .code,
            "stale_document"
        );
        assert!(service.editor("native:main", registration(1)).await.is_ok());
        service
            .local(Operation::Share {
                project: project.id.clone(),
                path: "main.typ".into(),
                enabled: false,
            })
            .unwrap();
        service
            .local(Operation::SetMainDocument {
                project: project.id.clone(),
                path: String::new(),
            })
            .unwrap();
        let observed = service
            .local(Operation::Review {
                project: project.id.clone(),
                path: "main.typ".into(),
            })
            .unwrap();
        assert_eq!(observed["sourceEpoch"], 1);
        let tree = service
            .local(Operation::ProjectTree {
                project: project.id.clone(),
            })
            .unwrap();
        assert_eq!(tree["entries"][0]["sourceEpoch"], 1);
        assert!(tree["entries"][0].get("source_epoch").is_none());
        let saved = service
            .local_source(bound(
                Operation::Save {
                    project: project.id.clone(),
                    path: "main.typ".into(),
                    revision: digest("Original"),
                    content: "Changed".into(),
                },
                1,
            ))
            .unwrap();
        assert_eq!(saved["sourceEpoch"], 1);
        assert_eq!(
            saved["sidecarRevision"],
            digest(&fs::read_to_string(sidecar(&file)).unwrap())
        );
    }

    #[test]
    fn equal_approval_retains_identity_new_namespace_is_zero_and_restart_preserves_it() {
        let (temp, service, project, _file) = fixture();
        service
            .retire_source_for_test(&project.id, "main.typ")
            .unwrap();
        let equal = service
            .local(Operation::AddProject {
                root: project.root.to_str().unwrap().into(),
            })
            .unwrap();
        assert_eq!(equal["id"], project.id);
        assert_eq!(service.source_epoch(&project.id, "main.typ").unwrap(), 1);
        let outer: Project = serde_json::from_value(
            service
                .local(Operation::AddProject {
                    root: temp.path().to_str().unwrap().into(),
                })
                .unwrap(),
        )
        .unwrap();
        assert_ne!(outer.id, project.id);
        assert_eq!(
            service.source_epoch(&outer.id, "project/main.typ").unwrap(),
            0
        );
        drop(service);
        let restarted = Service::new(temp.path().join("state")).unwrap();
        assert_eq!(restarted.source_epoch(&project.id, "main.typ").unwrap(), 1);
        assert_eq!(
            restarted
                .source_epoch(&outer.id, "project/main.typ")
                .unwrap(),
            0
        );
    }

    #[test]
    fn explicit_creation_reuses_retired_slot_without_resetting_old_authority() {
        let (_temp, service, project, file) = fixture();
        service
            .retire_source_for_test(&project.id, "main.typ")
            .unwrap();
        fs::remove_file(&file).unwrap();
        let created = service
            .local(Operation::Create {
                project: project.id.clone(),
                path: "main.typ".into(),
            })
            .unwrap();
        assert_eq!(created["sourceEpoch"], 2);
        let bytes = fs::read(&file).unwrap();
        assert_eq!(
            service
                .local_source(bound(
                    Operation::Save {
                        project: project.id.clone(),
                        path: "main.typ".into(),
                        revision: created["review"]["revision"].as_str().unwrap().into(),
                        content: "stale".into()
                    },
                    1
                ))
                .unwrap_err()
                .code,
            "stale_document"
        );
        assert_eq!(fs::read(&file).unwrap(), bytes);
    }

    #[test]
    fn old_journal_does_not_recover_under_a_new_observation() {
        let (_temp, service, project, file) = fixture();
        *lock(&service.fail_after_journal).unwrap() = true;
        service
            .local(Operation::Save {
                project: project.id.clone(),
                path: "main.typ".into(),
                revision: digest("Original"),
                content: "Captured".into(),
            })
            .unwrap_err();
        let journal = fs::read(journal_path(&file)).unwrap();
        assert_eq!(
            serde_json::from_slice::<Value>(&journal).unwrap()["ownership"]["source_epoch"],
            0
        );
        service
            .retire_source_for_test(&project.id, "main.typ")
            .unwrap();
        assert_eq!(
            service
                .local_source(bound(
                    Operation::Open {
                        project: project.id.clone(),
                        path: "main.typ".into()
                    },
                    1
                ))
                .unwrap_err()
                .code,
            "recovery_conflict"
        );
        assert_eq!(fs::read(&file).unwrap(), b"Original");
        assert!(!sidecar(&file).exists());
        assert_eq!(fs::read(journal_path(&file)).unwrap(), journal);
    }
    #[test]
    fn exhausted_and_oversized_identity_state_refuses_before_creation() {
        let (_temp, service, project, file) = fixture();
        fs::remove_file(&file).unwrap();
        {
            let mut registry = lock(&service.registry).unwrap();
            registry
                .source_epochs
                .entry(project.id.clone())
                .or_default()
                .insert("main.typ".into(), MAX_SOURCE_EPOCH);
            service.save_registry(&registry).unwrap();
        }
        let before = fs::read(service.state.join("projects.json")).unwrap();
        assert_eq!(
            service
                .local(Operation::Create {
                    project: project.id.clone(),
                    path: "main.typ".into()
                })
                .unwrap_err()
                .code,
            "limit"
        );
        assert!(!file.exists());
        assert!(!sidecar(&file).exists());
        assert_eq!(
            fs::read(service.state.join("projects.json")).unwrap(),
            before
        );
        let mut registry = lock(&service.registry).unwrap().clone();
        let paths = registry
            .source_epochs
            .entry(project.id.clone())
            .or_default();
        for index in 0..30_000 {
            paths.insert(format!("{}-{index}.typ", "x".repeat(70)), 1);
        }
        assert_eq!(service.save_registry(&registry).unwrap_err().code, "limit");
        assert_eq!(
            fs::read(service.state.join("projects.json")).unwrap(),
            before
        );
    }

    #[cfg(unix)]
    #[test]
    fn linked_parent_spelling_cannot_create_a_second_zero_epoch_authority() {
        use std::os::unix::fs::symlink;
        let (_temp, service, project, _file) = fixture();
        fs::create_dir(project.root.join("real")).unwrap();
        fs::write(project.root.join("real/chapter.typ"), "Same text").unwrap();
        symlink(project.root.join("real"), project.root.join("alias")).unwrap();
        service
            .retire_source_for_test(&project.id, "real/chapter.typ")
            .unwrap();
        let error = service
            .local(Operation::Save {
                project: project.id.clone(),
                path: "alias/chapter.typ".into(),
                revision: digest("Same text"),
                content: "replacement".into(),
            })
            .unwrap_err();
        assert_eq!(error.code, "path");
        assert_eq!(
            fs::read(project.root.join("real/chapter.typ")).unwrap(),
            b"Same text"
        );
        assert!(!project
            .root
            .join("real/chapter.typ.undertree-review.json")
            .exists());
    }
    #[test]
    fn sparse_compile_binding_checks_actual_dependencies_without_staling_unrelated_paths() {
        let (_temp, service, project, _file) = fixture();
        let captured = service
            .capture_source_epochs(&project.id, "main.typ", 0)
            .unwrap();
        let dependencies = BTreeSet::from([
            "main.typ".into(),
            "chapters/included.typ".into(),
            "fonts/local.otf".into(),
        ]);
        service
            .retire_source_for_test(&project.id, "unrelated.typ")
            .unwrap();
        service
            .require_source_epochs(&project.id, &captured, &dependencies)
            .unwrap();
        service
            .retire_source_for_test(&project.id, "chapters/included.typ")
            .unwrap();
        assert_eq!(service.source_epoch(&project.id, "main.typ").unwrap(), 0);
        assert_eq!(
            service
                .require_source_epochs(&project.id, &captured, &dependencies)
                .unwrap_err()
                .code,
            "stale_document"
        );
        let fresh = service
            .capture_source_epochs(&project.id, "main.typ", 0)
            .unwrap();
        service
            .require_source_epochs(&project.id, &fresh, &dependencies)
            .unwrap();
        service
            .retire_source_for_test(&project.id, "fonts/local.otf")
            .unwrap();
        assert_eq!(
            service
                .require_source_epochs(&project.id, &fresh, &dependencies)
                .unwrap_err()
                .code,
            "stale_document"
        );
    }
    #[test]
    fn shared_enrollment_never_relabels_retired_identity_or_revives_its_old_id() {
        let (_temp, service, project, file) = fixture();
        let original = service
            .local(Operation::Open {
                project: project.id.clone(),
                path: "main.typ".into(),
            })
            .unwrap();
        let first = service
            .local(Operation::Share {
                project: project.id.clone(),
                path: "main.typ".into(),
                enabled: true,
            })
            .unwrap();
        let old_id = first["documentId"].as_str().unwrap();
        assert_eq!(old_id, original["documentId"].as_str().unwrap());
        assert_eq!(old_id, digest(&format!("{}:main.typ", project.id)));
        service
            .retire_source_for_test(&project.id, "main.typ")
            .unwrap();
        service
            .retire_source_for_test(&project.id, "main.typ")
            .unwrap();
        let registry = fs::read(service.state.join("projects.json")).unwrap();
        let proposal = json!({"requestId":Uuid::new_v4().to_string(),"revision":digest("Original"),"from":0,"to":8,"quote":"Original","replacement":"Updated","rationale":"Clearer"});
        for (tool, args) in [
            ("read_manuscript", json!({"documentId":old_id})),
            (
                "suggest_text",
                json!({"documentId":old_id,"proposal":proposal.clone()}),
            ),
        ] {
            assert_eq!(service.remote(tool, args).unwrap_err().code, "scope");
            assert_eq!(fs::read(&file).unwrap(), b"Original");
            assert!(!sidecar(&file).exists());
            assert!(!journal_path(&file).exists());
            assert_eq!(
                fs::read(service.state.join("projects.json")).unwrap(),
                registry
            );
        }
        assert_eq!(
            service.remote("list_manuscripts", json!({})).unwrap(),
            json!([])
        );
        assert_eq!(service.shared_manuscripts().unwrap(), json!([]));
        let observed = service
            .local(Operation::Review {
                project: project.id.clone(),
                path: "main.typ".into(),
            })
            .unwrap();
        assert_eq!(observed["shared"], false);
        assert_ne!(observed["documentId"], first["documentId"]);
        let enrolled = service
            .local_source(bound(
                Operation::Share {
                    project: project.id.clone(),
                    path: "main.typ".into(),
                    enabled: true,
                },
                2,
            ))
            .unwrap();
        assert_eq!(enrolled["documentId"], observed["documentId"]);
        assert_eq!(enrolled["sourceEpoch"], 2);
        assert_eq!(
            service
                .remote("read_manuscript", json!({"documentId":old_id}))
                .unwrap_err()
                .code,
            "scope"
        );
        let new_id = enrolled["documentId"].as_str().unwrap();
        assert_eq!(
            service
                .remote("read_manuscript", json!({"documentId":new_id}))
                .unwrap()["content"],
            "Original"
        );
        service
            .remote(
                "suggest_text",
                json!({"documentId":new_id,"proposal":proposal}),
            )
            .unwrap();
        assert_eq!(fs::read(&file).unwrap(), b"Original");
        assert_eq!(service.shared_manuscripts().unwrap()[0]["sourceEpoch"], 2);
        // Restriction revokes every historic enrollment for this path without a current precondition.
        service
            .local(Operation::Share {
                project: project.id.clone(),
                path: "main.typ".into(),
                enabled: false,
            })
            .unwrap();
        assert!(lock(&service.shared).unwrap().is_empty());
        assert_eq!(
            service
                .remote("read_manuscript", json!({"documentId":new_id}))
                .unwrap_err()
                .code,
            "scope"
        );
    }
}
