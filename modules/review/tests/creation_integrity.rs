use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use undertree_review::service::Service;
use undertree_review::Operation;

const ORIGINAL: &str =
    "\\begin{document}\\section{Original}Preserve this TeX source.\\end{document}";
const SUFFIXES: [&str; 3] = [
    ".undertree-review.json",
    ".undertree-pending.json",
    ".import-report.json",
];

struct Fixture {
    _temporary: tempfile::TempDir,
    root: PathBuf,
    state: PathBuf,
    service: Arc<Service>,
    project: String,
}

impl Fixture {
    fn new() -> Self {
        let temporary = tempfile::tempdir().unwrap();
        let root = temporary.path().join("project");
        let state = temporary.path().join("state");
        fs::create_dir(&root).unwrap();
        fs::write(root.join("original.tex"), ORIGINAL).unwrap();
        let service = Service::new(state.clone()).unwrap();
        let project = service
            .local(Operation::AddProject {
                root: root.to_string_lossy().into(),
            })
            .unwrap()["id"]
            .as_str()
            .unwrap()
            .to_owned();
        Self {
            _temporary: temporary,
            root,
            state,
            service,
            project,
        }
    }

    fn operation(&self, import: bool) -> Operation {
        if import {
            Operation::ImportTex {
                project: self.project.clone(),
                path: "original.tex".into(),
                target: "new.typ".into(),
            }
        } else {
            Operation::Create {
                project: self.project.clone(),
                path: "new.typ".into(),
            }
        }
    }

    fn output(&self, suffix: &str) -> PathBuf {
        self.root.join(format!("new.typ{suffix}"))
    }

    fn assert_unowned(&self) {
        let project = self.service.project(&self.project).unwrap();
        assert!(project.pending.is_empty());
        assert!(project.pending_revisions.is_empty());
        assert_eq!(
            fs::read_to_string(self.root.join("original.tex")).unwrap(),
            ORIGINAL
        );
    }

    fn assert_no_other_outputs(&self, preserved: Option<&Path>) {
        for output in std::iter::once(self.output(""))
            .chain(SUFFIXES.iter().map(|suffix| self.output(suffix)))
        {
            if preserved != Some(output.as_path()) {
                assert!(
                    fs::symlink_metadata(&output).is_err(),
                    "Failed creation left a partial artifact"
                );
            }
        }
    }

    fn retry_and_check(&self, import: bool) {
        let result = self.service.local(self.operation(import)).unwrap();
        let snapshot = if import { &result["snapshot"] } else { &result };
        assert_eq!(snapshot["path"], "new.typ");
        assert!(self.output("").is_file());
        assert!(self.output(".undertree-review.json").is_file());
        assert!(!self.output(".undertree-pending.json").exists());
        assert_eq!(self.output(".import-report.json").is_file(), import);
        let project = self.service.project(&self.project).unwrap();
        assert!(project.pending.contains("new.typ"));
        assert!(project.pending.contains("new.typ.undertree-review.json"));
        assert_eq!(
            project.pending.contains("new.typ.import-report.json"),
            import
        );
        assert!(!project.pending.contains("original.tex"));
        assert_eq!(
            fs::read_to_string(self.root.join("original.tex")).unwrap(),
            ORIGINAL
        );
    }
}

#[test]
fn orphan_or_corrupt_metadata_is_preserved_before_any_source_is_created() {
    for import in [false, true] {
        for suffix in SUFFIXES {
            for bytes in [
                b"{corrupt metadata".as_slice(),
                b"{\"version\":999,\"future\":true}".as_slice(),
            ] {
                let fixture = Fixture::new();
                let orphan = fixture.output(suffix);
                fs::write(&orphan, bytes).unwrap();
                let registry = fs::read(fixture.state.join("projects.json")).unwrap();
                assert!(
                    fixture.service.local(fixture.operation(import)).is_err(),
                    "Creation silently adopted an orphan artifact"
                );
                assert_eq!(fs::read(&orphan).unwrap(), bytes);
                assert_eq!(
                    fs::read(fixture.state.join("projects.json")).unwrap(),
                    registry
                );
                fixture.assert_no_other_outputs(Some(&orphan));
                fixture.assert_unowned();
                fs::remove_file(orphan).unwrap();
                fixture.retry_and_check(import);
            }
        }
    }
}

#[test]
fn existing_source_collisions_never_add_metadata_or_adopt_external_content() {
    for import in [false, true] {
        let fixture = Fixture::new();
        fs::write(fixture.output(""), "External target content.").unwrap();
        let registry = fs::read(fixture.state.join("projects.json")).unwrap();
        assert!(fixture.service.local(fixture.operation(import)).is_err());
        assert_eq!(
            fs::read_to_string(fixture.output("")).unwrap(),
            "External target content."
        );
        assert_eq!(
            fs::read(fixture.state.join("projects.json")).unwrap(),
            registry
        );
        fixture.assert_no_other_outputs(Some(&fixture.output("")));
        fixture.assert_unowned();
    }
}

#[test]
fn nonregular_metadata_paths_fail_without_a_partial_source_or_review_file() {
    for import in [false, true] {
        for suffix in SUFFIXES {
            let fixture = Fixture::new();
            let blocked = fixture.output(suffix);
            fs::create_dir(&blocked).unwrap();
            fs::write(
                blocked.join("preserved.txt"),
                "Existing directory contents.",
            )
            .unwrap();
            assert!(fixture.service.local(fixture.operation(import)).is_err());
            assert_eq!(
                fs::read_to_string(blocked.join("preserved.txt")).unwrap(),
                "Existing directory contents."
            );
            fixture.assert_no_other_outputs(Some(&blocked));
            fixture.assert_unowned();
            fs::remove_dir_all(&blocked).unwrap();
            fixture.retry_and_check(import);
        }
    }
}

#[cfg(unix)]
#[test]
fn linked_or_dangling_metadata_is_never_overwritten_and_leaves_no_partial_source() {
    use std::os::unix::fs::symlink;
    for import in [false, true] {
        for suffix in SUFFIXES {
            for dangling in [false, true] {
                let fixture = Fixture::new();
                let outside = fixture._temporary.path().join("outside.json");
                if !dangling {
                    fs::write(&outside, "Private external metadata.").unwrap();
                }
                let link = fixture.output(suffix);
                symlink(&outside, &link).unwrap();
                assert!(fixture.service.local(fixture.operation(import)).is_err());
                assert!(fs::symlink_metadata(&link)
                    .unwrap()
                    .file_type()
                    .is_symlink());
                if dangling {
                    assert!(!outside.exists());
                } else {
                    assert_eq!(
                        fs::read_to_string(&outside).unwrap(),
                        "Private external metadata."
                    );
                }
                fixture.assert_no_other_outputs(Some(&link));
                fixture.assert_unowned();
            }
        }
    }
}

#[test]
fn registry_failure_preserves_published_outputs_and_requires_explicit_local_resolution() {
    for import in [false, true] {
        let fixture = Fixture::new();
        let registry_path = fixture.state.join("projects.json");
        let registry = fs::read(&registry_path).unwrap();
        fs::remove_file(&registry_path).unwrap();
        fs::create_dir(&registry_path).unwrap();
        assert_eq!(
            fixture
                .service
                .local(fixture.operation(import))
                .unwrap_err()
                .code,
            "outcome_unknown"
        );
        let source = fs::read(fixture.output("")).unwrap();
        let review = fs::read(fixture.output(".undertree-review.json")).unwrap();
        let report = import.then(|| fs::read(fixture.output(".import-report.json")).unwrap());
        fixture.assert_unowned();
        assert!(registry_path.is_dir());
        fs::remove_dir(&registry_path).unwrap();
        fs::write(&registry_path, registry).unwrap();
        assert_eq!(
            fixture
                .service
                .local(fixture.operation(import))
                .unwrap_err()
                .code,
            "conflict"
        );
        assert_eq!(fs::read(fixture.output("")).unwrap(), source);
        assert_eq!(
            fs::read(fixture.output(".undertree-review.json")).unwrap(),
            review
        );
        if let Some(report) = report {
            assert_eq!(
                fs::read(fixture.output(".import-report.json")).unwrap(),
                report
            );
        }
        // Only the fixture performs an explicit local cleanup after inspecting the
        // preserved files; the failed operation never deletes a published path.
        fs::remove_file(fixture.output("")).unwrap();
        fs::remove_file(fixture.output(".undertree-review.json")).unwrap();
        if import {
            fs::remove_file(fixture.output(".import-report.json")).unwrap();
        }
        fixture.retry_and_check(import);
    }
}
