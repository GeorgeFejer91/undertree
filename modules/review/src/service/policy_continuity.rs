//! Current-Service observations prevent deleted policy from becoming an implicit reset.
use super::*;

const MAX_WITNESSES: usize = 4096;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "state", rename_all = "snake_case", deny_unknown_fields)]
pub(super) enum ReviewObservation {
    Absent,
    Hash { sha256: String },
}

impl ReviewObservation {
    pub(super) fn of(raw: Option<&str>) -> Self {
        raw.map_or(Self::Absent, |raw| Self::Hash {
            sha256: digest(raw),
        })
    }

    pub(super) fn validate(&self) -> Result<()> {
        if let Self::Hash { sha256 } = self {
            if sha256.len() != 64 || !sha256.bytes().all(|byte| byte.is_ascii_hexdigit()) {
                return Err(conflict());
            }
        }
        Ok(())
    }
}

struct Witness {
    hash: String,
    missing: bool,
}

#[derive(Default)]
pub(super) struct PolicyContinuity {
    witnessed: BTreeMap<PathBuf, Witness>,
}

fn missing() -> Error {
    Error::new("policy_missing", "Previously observed review data is missing or has not been restored exactly. Your source and pending save are preserved. Restore the original review file, then explicitly refresh; sharing changes do not reset this protection.")
}

pub(super) fn conflict() -> Error {
    Error::new("recovery_conflict", "Review data conflicts with the interrupted or captured save. The source, review file and pending save have been preserved. Resolve those files locally before retrying.")
}

fn key(path: &Path) -> Result<PathBuf> {
    if !path.is_absolute()
        || path
            .components()
            .any(|part| matches!(part, Component::ParentDir | Component::CurDir))
    {
        return Err(conflict());
    }
    Ok(path.to_path_buf())
}

impl Service {
    pub(super) fn raw_review(&self, path: &Path) -> Result<Option<String>> {
        Ok(self
            .legacy_group(path)?
            .read_utf8(Member::Review, MAX_TEXT * 8)?
            .text()?
            .map(str::to_owned))
    }

    // Does not create a witness. Failed no-clobber creation/import must remain retryable.
    pub(super) fn policy_capacity(&self, paths: &[PathBuf]) -> Result<()> {
        let paths: BTreeSet<_> = paths.iter().map(|path| key(path)).collect::<Result<_>>()?;
        let book = lock(&self.policy_continuity)?;
        let additional: BTreeSet<_> = paths
            .iter()
            .filter(|path| !book.witnessed.contains_key(*path))
            .collect();
        if book.witnessed.len() + additional.len() > MAX_WITNESSES {
            return Err(Error::new("limit", "The bounded review-policy observation store is full. Existing policy knowledge was retained; restart UnderTree after closing its connections before observing more review files."));
        }
        Ok(())
    }

    pub(super) fn check_policy_continuity(&self, path: &Path, raw: Option<&str>) -> Result<()> {
        let path = key(path)?;
        let mut book = lock(&self.policy_continuity)?;
        if let Some(witness) = book.witnessed.get_mut(&path) {
            let Some(raw) = raw else {
                witness.missing = true;
                return Err(missing());
            };
            if witness.missing && witness.hash != digest(raw) {
                return Err(missing());
            }
        }
        Ok(())
    }

    // Call only after validating an observation or completing an accepted native effect.
    pub(super) fn observe_policy(&self, path: &Path, raw: Option<&str>) -> Result<()> {
        self.check_policy_continuity(path, raw)?;
        let Some(raw) = raw else {
            return Ok(());
        };
        let path = key(path)?;
        let mut book = lock(&self.policy_continuity)?;
        if !book.witnessed.contains_key(&path) && book.witnessed.len() == MAX_WITNESSES {
            return Err(Error::new("limit", "The bounded review-policy observation store is full. Existing policy knowledge was retained; restart UnderTree after closing its connections before observing more review files."));
        }
        book.witnessed.insert(
            path,
            Witness {
                hash: digest(raw),
                missing: false,
            },
        );
        Ok(())
    }

    pub(super) fn validated_review(
        &self,
        path: &Path,
        content: &str,
        raw: Option<&str>,
    ) -> Result<Review> {
        self.check_policy_continuity(path, raw)?;
        let review = match raw {
            Some(raw) => serde_json::from_str::<Review>(raw).map_err(|_| conflict())?,
            None => Review::new(content),
        };
        review.validate_for_text(content).map_err(|_| conflict())?;
        self.observe_policy(path, raw)?;
        Ok(review)
    }

    // The document guard keeps other native observations from replacing this captured witness.
    pub(super) fn captured_policy(
        &self,
        path: &Path,
        raw: Option<&str>,
    ) -> Result<ReviewObservation> {
        self.check_policy_continuity(path, raw)?;
        let path = key(path)?;
        let book = lock(&self.policy_continuity)?;
        let expected = book
            .witnessed
            .get(&path)
            .map(|witness| witness.hash.as_str());
        if raw.map(digest).as_deref() != expected {
            return Err(conflict());
        }
        Ok(ReviewObservation::of(raw))
    }

    pub(super) fn recovery_policy(
        &self,
        path: &Path,
        content: &str,
        raw: Option<&str>,
        prior: Option<&ReviewObservation>,
        final_raw: &str,
    ) -> Result<()> {
        self.check_policy_continuity(path, raw)?;
        if let Some(raw) = raw {
            let review: Review = serde_json::from_str(raw).map_err(|_| conflict())?;
            review.validate_for_text(content).map_err(|_| conflict())?;
        }
        if let Some(prior) = prior {
            prior.validate()?;
            if &ReviewObservation::of(raw) != prior && raw != Some(final_raw) {
                return Err(conflict());
            }
        } else if raw.is_some() && raw != Some(final_raw) {
            // Legacy journals cannot prove ownership of a different existing sidecar.
            return Err(conflict());
        }
        self.policy_capacity(&[path.to_path_buf()])?;
        self.observe_policy(path, raw)
    }
}

impl Service {
    pub(super) fn finish_move_policy(
        &self,
        from: &Path,
        to: &Path,
        hash: Option<&str>,
    ) -> Result<()> {
        let from = key(from)?;
        let to = key(to)?;
        let mut book = lock(&self.policy_continuity)?;
        if book
            .witnessed
            .get(&from)
            .is_some_and(|w| w.missing || Some(w.hash.as_str()) != hash)
            || book
                .witnessed
                .get(&to)
                .is_some_and(|w| w.missing || Some(w.hash.as_str()) != hash)
        {
            return Err(conflict());
        }
        if let Some(hash) = hash {
            if !book.witnessed.contains_key(&to) && book.witnessed.len() == MAX_WITNESSES {
                return Err(Error::new(
                    "limit",
                    "The policy witness store is full; Move remains blocked.",
                ));
            }
            book.witnessed.insert(
                to,
                Witness {
                    hash: hash.into(),
                    missing: false,
                },
            );
        }
        book.witnessed.remove(&from);
        Ok(())
    }
}

impl Service {
    // Move is not a policy-refresh/adoption route. Exact restored bytes still require explicit Review first.
    pub(super) fn require_move_policy(&self, path: &Path, raw: Option<&str>) -> Result<()> {
        self.check_policy_continuity(path, raw)?;
        if lock(&self.policy_continuity)?
            .witnessed
            .get(&key(path)?)
            .is_some_and(|w| w.missing)
        {
            return Err(missing());
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn full_witness_store_retains_known_loss_and_denies_new_observation() {
        let temp = tempfile::tempdir().unwrap();
        let service = Service::new(temp.path().join("state")).unwrap();
        for index in 0..MAX_WITNESSES {
            service
                .observe_policy(&temp.path().join(index.to_string()), Some("known"))
                .unwrap();
        }
        let known = temp.path().join("0");
        assert_eq!(
            service
                .check_policy_continuity(&known, None)
                .unwrap_err()
                .code,
            "policy_missing"
        );
        assert_eq!(
            service
                .observe_policy(&temp.path().join("new"), Some("new"))
                .unwrap_err()
                .code,
            "limit"
        );
        assert_eq!(
            service
                .observe_policy(&known, Some("replacement"))
                .unwrap_err()
                .code,
            "policy_missing"
        );
        service.observe_policy(&known, Some("known")).unwrap();
        assert_eq!(
            lock(&service.policy_continuity).unwrap().witnessed.len(),
            MAX_WITNESSES
        );
    }

    #[test]
    fn native_save_records_exact_prior_metadata_before_source_mutation() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("project");
        fs::create_dir(&root).unwrap();
        let file = root.join("main.typ");
        fs::write(&file, "Original").unwrap();
        let raw = serde_json::to_string_pretty(&Review::new("Original")).unwrap();
        fs::write(sidecar(&file), &raw).unwrap();
        let service = Service::new(temp.path().join("state")).unwrap();
        let project = service
            .local(Operation::AddProject {
                root: root.to_str().unwrap().into(),
            })
            .unwrap()["id"]
            .as_str()
            .unwrap()
            .to_owned();
        *lock(&service.fail_after_journal).unwrap() = true;
        assert_eq!(
            service
                .local(Operation::Save {
                    project: project.clone(),
                    path: "main.typ".into(),
                    revision: digest("Original"),
                    content: "Next".into()
                })
                .unwrap_err()
                .code,
            "outcome_unknown"
        );
        assert_eq!(fs::read_to_string(&file).unwrap(), "Original");
        assert_eq!(fs::read_to_string(sidecar(&file)).unwrap(), raw);
        let journal: Value =
            serde_json::from_slice(&fs::read(journal_path(&file)).unwrap()).unwrap();
        assert_eq!(
            journal["prior_review"],
            json!({"state":"hash","sha256":digest(&raw)})
        );
        assert_eq!(
            journal["ownership"],
            json!({"project":project,"path":"main.typ","source_epoch":0,"expected_root":RootedRoot::observe(file.parent().unwrap()).unwrap(),"owns_source":true})
        );
        let pending = fs::read(journal_path(&file)).unwrap();
        let registry = fs::read(service.state.join("projects.json")).unwrap();
        fs::write(sidecar(&file), "external corrupt metadata").unwrap();
        assert_eq!(
            service
                .local(Operation::Open {
                    project: project.clone(),
                    path: "main.typ".into(),
                })
                .unwrap_err()
                .code,
            "recovery_conflict"
        );
        assert_eq!(fs::read_to_string(&file).unwrap(), "Original");
        assert_eq!(
            fs::read_to_string(sidecar(&file)).unwrap(),
            "external corrupt metadata"
        );
        assert_eq!(fs::read(journal_path(&file)).unwrap(), pending);
        assert_eq!(
            fs::read(service.state.join("projects.json")).unwrap(),
            registry
        );
        fs::write(sidecar(&file), &raw).unwrap();
        assert_eq!(
            service
                .local(Operation::Open {
                    project: project.clone(),
                    path: "main.typ".into()
                })
                .unwrap()["content"],
            "Next"
        );
        assert!(!journal_path(&file).exists());
        // Record the exact producer/recovery phases for byte-level qualification.
        let after = fs::read_to_string(service.state.join("projects.json")).unwrap();
        let before: Value = serde_json::from_slice(&registry).unwrap();
        let after_value: Value = serde_json::from_str(&after).unwrap();
        assert_eq!(
            after_value["projects"][0]["pendingRevisions"]["main.typ"],
            digest("Next")
        );
        assert_eq!(
            after_value["projects"][0]["pendingRevisions"]["main.typ.undertree-review.json"],
            digest(&fs::read_to_string(sidecar(&file)).unwrap())
        );
        println!(
            "producer_recovery_evidence={}",
            json!({
                "sourceBefore":digest("Original"),"sourceAfter":digest("Next"),
                "priorSidecar":digest(&raw),
                "finalSidecar":digest(&fs::read_to_string(sidecar(&file)).unwrap()),
                "journal":digest(std::str::from_utf8(&pending).unwrap()),
                "journalRemoved":!journal_path(&file).exists(),
                "registryBefore":digest(std::str::from_utf8(&registry).unwrap()),
                "registryAfter":digest(&after),
                "pendingBefore":before["projects"][0]["pending"],
                "pendingAfter":after_value["projects"][0]["pending"],
                "pendingRevisionsBefore":before["projects"][0]["pendingRevisions"],
                "pendingRevisionsAfter":after_value["projects"][0]["pendingRevisions"]
            })
        );
    }
}
