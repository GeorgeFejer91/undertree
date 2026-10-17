use super::*;
use std::fs;
use std::path::{Path, PathBuf};

const REVIEW: &[u8] = b"exact saved review bytes\r\n";
const OWNERSHIP: &[u8] = b"exact source and sidecar pending ownership";

struct Fixture {
    temporary: tempfile::TempDir,
    state: PathBuf,
    store_id: Uuid,
    binding: SourceBinding,
    source_parent: Dir,
    slot: SourceSlot,
    store: HistoryStore,
}

impl Fixture {
    fn new() -> Self {
        let temporary = tempfile::tempdir().unwrap();
        let state = temporary.path().join("state");
        fs::create_dir(&state).unwrap();
        let capability = Dir::open_ambient_dir(&state, cap_std::ambient_authority()).unwrap();
        let source_directory = temporary.path().join("sources");
        fs::create_dir(&source_directory).unwrap();
        fs::write(source_directory.join("main.typ"), b"fixture source").unwrap();
        let source_parent =
            Dir::open_ambient_dir(&source_directory, cap_std::ambient_authority()).unwrap();
        let metadata = source_parent.dir_metadata().unwrap();
        let slot = SourceSlot::from_held_parent(&source_parent, "main.typ").unwrap();
        let store_id = Uuid::new_v4();
        HistoryStore::initialize(&capability, store_id).unwrap();
        let store = HistoryStore::open(capability, Some(store_id))
            .unwrap()
            .unwrap();
        Self {
            temporary,
            state,
            store_id,
            source_parent,
            slot,
            binding: SourceBinding {
                project_id: Uuid::new_v4().to_string(),
                root: RootObservation::new(metadata.dev(), metadata.ino()),
                path: "chapters/main.typ".into(),
                source_epoch: 0,
            },
            store,
        }
    }

    fn reopen(&mut self) {
        let capability = Dir::open_ambient_dir(&self.state, cap_std::ambient_authority()).unwrap();
        self.store = HistoryStore::open(capability, Some(self.store_id))
            .unwrap()
            .unwrap();
    }

    fn capture(&self, old: &str, new: &str) -> NativeIntent {
        self.store
            .capture(capture(&self.binding, &self.slot, old), new)
            .unwrap()
    }

    fn slot_for(&self, binding: &SourceBinding) -> SourceSlot {
        let basename = binding.path.rsplit('/').next().unwrap();
        self.source_parent
            .write(basename, b"fixture source")
            .unwrap();
        SourceSlot::from_held_parent(&self.source_parent, basename).unwrap()
    }

    fn blob(&self, reference: &HistoryReference) -> PathBuf {
        self.state
            .join("history-v1/blobs")
            .join(blob_name(&reference.event_id))
    }

    fn catalog(&self) -> Catalog {
        serde_json::from_slice(&fs::read(self.state.join("history-v1/catalog.json")).unwrap())
            .unwrap()
    }
}

fn capture(binding: &SourceBinding, slot: &SourceSlot, old: &str) -> Capture {
    Capture {
        binding: binding.clone(),
        slot: slot.clone(),
        cause: NativeCause::Save,
        old_digest: hash(old.as_bytes()),
        final_review_digest: hash(REVIEW),
        prior_review_digest: Some(hash(b"previous review bytes")),
        ownership_digest: hash(OWNERSHIP),
        receipt_fingerprint: None,
        captured_at_ms: Some(1_700_000_000_000),
    }
}

fn journal(intent: &NativeIntent) -> Vec<u8> {
    serde_json::to_vec(&serde_json::json!({
        "oldRevision": intent.core.old_digest,
        "content": intent.content,
        "history": intent.reference().unwrap(),
    }))
    .unwrap()
}

fn applied<'a>(
    binding: &'a SourceBinding,
    slot: &'a SourceSlot,
    content: &'a str,
    ownership: &'a str,
) -> AppliedSource<'a> {
    AppliedSource {
        binding,
        slot,
        content,
        review_bytes: REVIEW,
        ownership_digest: ownership,
    }
}

fn assert_error<T>(result: Result<T>, expected: &str) {
    match result {
        Err(error) => assert_eq!(error.code, expected, "{}", error.message),
        Ok(_) => panic!("expected {expected}, operation succeeded"),
    }
}

fn complete(
    store: &mut HistoryStore,
    reference: &HistoryReference,
    binding: &SourceBinding,
    slot: &SourceSlot,
    journal: &[u8],
) {
    let journal_sha256 = hash(journal);
    store
        .complete(
            reference,
            binding,
            slot,
            &ProducerCompletion {
                journal_sha256: &journal_sha256,
                committed_receipt_fingerprint: None,
            },
        )
        .unwrap();
}

fn arm(
    store: &mut HistoryStore,
    binding: &SourceBinding,
    slot: &SourceSlot,
    reference: &HistoryReference,
    journal: &[u8],
) {
    let reservation = store.producer_reservation(binding, slot).unwrap().unwrap();
    assert_eq!(reservation.reference(), reference);
    assert_eq!(reservation.binding(), binding);
    assert_eq!(reservation.journal_sha256(), hash(journal));
    store
        .arm_source_effects(&reservation, binding, slot, journal)
        .unwrap();
}

#[derive(Debug, PartialEq, Eq)]
enum DiskEntry {
    Directory,
    File(Vec<u8>),
    Link(PathBuf),
}

fn disk(directory: &Path) -> BTreeMap<PathBuf, DiskEntry> {
    fn visit(base: &Path, directory: &Path, output: &mut BTreeMap<PathBuf, DiskEntry>) {
        for entry in fs::read_dir(directory).unwrap() {
            let path = entry.unwrap().path();
            let metadata = fs::symlink_metadata(&path).unwrap();
            let relative = path.strip_prefix(base).unwrap().to_owned();
            if metadata.file_type().is_symlink() {
                output.insert(relative, DiskEntry::Link(fs::read_link(&path).unwrap()));
            } else if metadata.is_dir() {
                output.insert(relative, DiskEntry::Directory);
                visit(base, &path, output);
            } else {
                output.insert(relative, DiskEntry::File(fs::read(&path).unwrap()));
            }
        }
    }
    let mut output = BTreeMap::new();
    visit(directory, directory, &mut output);
    output
}

fn save(
    store: &mut HistoryStore,
    binding: &SourceBinding,
    slot: &SourceSlot,
    old: &str,
    content: &str,
) -> (NativeIntent, HistoryReference, Vec<u8>, VersionSummary) {
    let intent = store.capture(capture(binding, slot, old), content).unwrap();
    let journal = journal(&intent);
    let reference = store.prepare(&intent, &journal).unwrap();
    arm(store, binding, slot, &reference, &journal);
    let version = store
        .finalize(
            &reference,
            &applied(binding, slot, content, &hash(OWNERSHIP)),
            &journal,
            false,
        )
        .unwrap();
    complete(store, &reference, binding, slot, &journal);
    (intent, reference, journal, version)
}

fn list(
    store: &HistoryStore,
    binding: &SourceBinding,
    namespace_id: Option<&str>,
    source_id: Option<&str>,
    cursor: Option<HistoryCursor>,
) -> Result<HistoryPage> {
    match store.query(HistoryQuery::List {
        project_id: binding.project_id.clone(),
        namespace_id: namespace_id.map(str::to_owned),
        observed_root: None,
        source_id: source_id.map(str::to_owned),
        cursor,
    })? {
        HistoryReply::List(page) => Ok(page),
        _ => panic!("wrong reply kind"),
    }
}

fn read_version(store: &HistoryStore, version: &VersionSummary) -> Result<SavedVersion> {
    match store.query(HistoryQuery::Read {
        project_id: version.binding.project_id.clone(),
        namespace_id: version.namespace_id.clone(),
        source_id: version.source_id.clone(),
        version_id: version.version_id.clone(),
    })? {
        HistoryReply::Read(saved) => Ok(saved),
        _ => panic!("wrong reply kind"),
    }
}

fn compare(store: &HistoryStore, from: &VersionSummary, to: &VersionSummary) -> Result<Comparison> {
    match store.query(HistoryQuery::Compare {
        project_id: from.binding.project_id.clone(),
        namespace_id: from.namespace_id.clone(),
        source_id: from.source_id.clone(),
        from_version_id: from.version_id.clone(),
        to_version_id: to.version_id.clone(),
    })? {
        HistoryReply::Compare(comparison) => Ok(*comparison),
        _ => panic!("wrong reply kind"),
    }
}

#[test]
fn missing_store_observation_is_pure_and_initialization_requires_the_exact_anchor() {
    let temporary = tempfile::tempdir().unwrap();
    let capability = Dir::open_ambient_dir(temporary.path(), cap_std::ambient_authority()).unwrap();
    assert!(HistoryStore::open(capability.try_clone().unwrap(), None)
        .unwrap()
        .is_none());
    assert!(disk(temporary.path()).is_empty());
    let id = Uuid::new_v4();
    assert_error(
        HistoryStore::open(capability.try_clone().unwrap(), Some(id)),
        "history_unavailable",
    );
    assert!(disk(temporary.path()).is_empty());
    HistoryStore::initialize(&capability, id).unwrap();
    let before = disk(temporary.path());
    HistoryStore::initialize(&capability, id).unwrap();
    assert_eq!(disk(temporary.path()), before);
    assert_error(
        HistoryStore::open(capability.try_clone().unwrap(), None),
        "history_unavailable",
    );
    assert_error(
        HistoryStore::open(capability.try_clone().unwrap(), Some(Uuid::new_v4())),
        "history_unavailable",
    );
    assert_eq!(disk(temporary.path()), before);
}

#[test]
fn unanchored_empty_initialization_reuses_its_uuid_after_each_durable_empty_stage() {
    for stage in 0..4 {
        let temporary = tempfile::tempdir().unwrap();
        let state = Dir::open_ambient_dir(temporary.path(), cap_std::ambient_authority()).unwrap();
        let previous_id = if stage == 3 {
            let id = Uuid::new_v4();
            HistoryStore::initialize(&state, id).unwrap();
            Some(id)
        } else {
            if stage >= 1 {
                fs::create_dir(temporary.path().join("history-v1")).unwrap();
                sync_dir(&state).unwrap();
            }
            if stage == 2 {
                fs::create_dir(temporary.path().join("history-v1/blobs")).unwrap();
                sync_dir(&state.open_dir_nofollow("history-v1").unwrap()).unwrap();
            }
            None
        };
        let id = HistoryStore::initialize_unanchored(&state).unwrap();
        if let Some(previous_id) = previous_id {
            assert_eq!(
                id, previous_id,
                "a lost Registry anchor must not mint another UUID"
            );
        }
        let before = disk(temporary.path());
        // Model termination after private durability, before Registry anchor publication.
        drop(state);
        let state = Dir::open_ambient_dir(temporary.path(), cap_std::ambient_authority()).unwrap();
        assert_eq!(HistoryStore::initialize_unanchored(&state).unwrap(), id);
        assert_eq!(disk(temporary.path()), before);
        let store = HistoryStore::open(state.try_clone().unwrap(), Some(id))
            .unwrap()
            .unwrap();
        let catalog = store.load().unwrap().0;
        assert_eq!(catalog.schema, 3);
        assert_eq!(catalog.generation, 0);
        assert_eq!(catalog.next_sequence, 1);
        assert!(catalog.records.is_empty() && catalog.sources.is_empty());
        assert!(catalog.namespaces.is_empty() && catalog.retired.is_empty());
        assert_error(HistoryStore::open(state, None), "history_unavailable");
        assert_eq!(disk(temporary.path()), before);
    }
}

fn assert_unanchored_refuses(state: &Path) {
    let before = disk(state);
    let directory = Dir::open_ambient_dir(state, cap_std::ambient_authority()).unwrap();
    assert_error(
        HistoryStore::initialize_unanchored(&directory),
        "history_unavailable",
    );
    assert_eq!(disk(state), before);
}

#[test]
fn unanchored_initialization_never_adopts_any_valid_catalogue_occupancy_or_advanced_counter() {
    for occupied in [
        "namespace",
        "source",
        "record",
        "retired",
        "generation",
        "sequence",
    ] {
        let mut fixture = Fixture::new();
        let mut catalog = fixture.catalog();
        match occupied {
            "namespace" | "source" => {
                let namespace_id = Uuid::new_v4().to_string();
                catalog.namespaces.push(Namespace {
                    id: namespace_id.clone(),
                    project_id: fixture.binding.project_id.clone(),
                    root: fixture.binding.root,
                });
                if occupied == "source" {
                    catalog.sources.push(Source {
                        id: Uuid::new_v4().to_string(),
                        namespace_id,
                        path: fixture.binding.path.clone(),
                        epoch: 0,
                    });
                }
            }
            "record" => {
                let intent = fixture.capture("old", "saved");
                fixture.store.prepare(&intent, &journal(&intent)).unwrap();
                catalog = fixture.catalog();
            }
            "retired" => catalog.retired.push(Retired {
                event_id: Uuid::new_v4().to_string(),
                sha256: hash(b"retired bytes"),
                bytes: 13,
                origin: RetirementOrigin::Retention,
            }),
            "generation" => catalog.generation = 1,
            "sequence" => catalog.next_sequence = 2,
            _ => unreachable!(),
        }
        catalog.validate().unwrap();
        fs::write(
            fixture.state.join("history-v1/catalog.json"),
            serde_json::to_vec(&catalog).unwrap(),
        )
        .unwrap();
        assert_unanchored_refuses(&fixture.state);
    }
}

#[test]
fn unanchored_initialization_preserves_corrupt_schema_unknown_and_incomplete_evidence() {
    let fixture = Fixture::new();
    let catalog_path = fixture.state.join("history-v1/catalog.json");
    let valid = fs::read(&catalog_path).unwrap();
    let base: serde_json::Value = serde_json::from_slice(&valid).unwrap();
    let mut wrong_schema = base.clone();
    wrong_schema["schema"] = serde_json::json!(2);
    let mut extended = base.clone();
    extended["approved"] = serde_json::json!(true);
    let mut noncanonical_id = base.clone();
    noncanonical_id["storeId"] = serde_json::json!("AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA");
    for bytes in [
        b"{".to_vec(),
        Vec::new(),
        serde_json::to_vec(&wrong_schema).unwrap(),
        serde_json::to_vec(&extended).unwrap(),
        serde_json::to_vec(&noncanonical_id).unwrap(),
    ] {
        fs::write(&catalog_path, bytes).unwrap();
        assert_unanchored_refuses(&fixture.state);
    }
    fs::write(&catalog_path, &valid).unwrap();
    for relative in [
        "history-v1/unknown",
        "history-v1/catalog.next",
        "history-v1/blobs/payload.utf8",
    ] {
        let path = fixture.state.join(relative);
        fs::write(&path, b"preserve these private bytes\r\n").unwrap();
        assert_unanchored_refuses(&fixture.state);
        fs::remove_file(&path).unwrap();
    }
    // Missing-directory recovery represents a restart after the retained store is closed.
    #[cfg(windows)]
    {
        let before = disk(&fixture.state);
        let error = fs::remove_dir(fixture.state.join("history-v1/blobs")).unwrap_err();
        assert!(matches!(error.raw_os_error(), Some(5) | Some(32)));
        assert_eq!(disk(&fixture.state), before);
    }
    drop(fixture.store);
    fs::remove_dir(fixture.state.join("history-v1/blobs")).unwrap();
    assert_unanchored_refuses(&fixture.state);
    fs::remove_file(&catalog_path).unwrap();
    fs::write(
        fixture.state.join("history-v1/unknown"),
        b"partial init evidence",
    )
    .unwrap();
    assert_unanchored_refuses(&fixture.state);
    fs::remove_file(fixture.state.join("history-v1/unknown")).unwrap();
    fs::create_dir(fixture.state.join("history-v1/blobs")).unwrap();
    fs::write(
        fixture.state.join("history-v1/blobs/unknown"),
        b"partial payload",
    )
    .unwrap();
    assert_unanchored_refuses(&fixture.state);
}

#[cfg(unix)]
#[test]
fn unanchored_links_hardlinks_and_nonregular_entries_preserve_targets() {
    use std::os::unix::fs::symlink;
    for target in ["history-v1", "history-v1/blobs", "history-v1/catalog.json"] {
        let fixture = Fixture::new();
        let path = fixture.state.join(target);
        let external = fixture.temporary.path().join("external");
        fs::rename(&path, &external).unwrap();
        symlink(&external, &path).unwrap();
        let before = disk(fixture.temporary.path());
        assert_unanchored_refuses(&fixture.state);
        assert_eq!(disk(fixture.temporary.path()), before);
    }
    let fixture = Fixture::new();
    fs::hard_link(
        fixture.state.join("history-v1/catalog.json"),
        fixture.temporary.path().join("other-owner"),
    )
    .unwrap();
    let before = disk(fixture.temporary.path());
    assert_unanchored_refuses(&fixture.state);
    assert_eq!(disk(fixture.temporary.path()), before);
    for target in ["history-v1", "history-v1/blobs", "history-v1/catalog.json"] {
        let fixture = Fixture::new();
        let path = fixture.state.join(target);
        if path.is_dir() {
            fs::remove_dir_all(&path).unwrap();
            fs::write(path, b"not a directory").unwrap();
        } else {
            fs::remove_file(&path).unwrap();
            fs::create_dir(path).unwrap();
        }
        assert_unanchored_refuses(&fixture.state);
    }
}

#[test]
fn committed_applied_validation_needs_no_journal_and_never_changes_source_or_history_bytes() {
    let mut fixture = Fixture::new();
    let content = "Saved 🧪 e\u{301}\r\nexact source.\r\n";
    let intent = fixture.capture("old", content);
    let journal_bytes = journal(&intent);
    let reference = fixture.store.prepare(&intent, &journal_bytes).unwrap();
    arm(
        &mut fixture.store,
        &fixture.binding,
        &fixture.slot,
        &reference,
        &journal_bytes,
    );
    fixture
        .source_parent
        .write("main.typ", content.as_bytes())
        .unwrap();
    fixture
        .source_parent
        .write("main.typ.undertree-review.json", REVIEW)
        .unwrap();
    fixture
        .source_parent
        .write("pending-ownership.json", OWNERSHIP)
        .unwrap();
    fixture
        .source_parent
        .write("save-journal.json", &journal_bytes)
        .unwrap();
    let version = fixture
        .store
        .finalize(
            &reference,
            &applied(&fixture.binding, &fixture.slot, content, &hash(OWNERSHIP)),
            &journal_bytes,
            true,
        )
        .unwrap();
    let journal_sha256 = hash(&journal_bytes);
    fixture
        .source_parent
        .remove_file("save-journal.json")
        .unwrap();
    sync_dir(&fixture.source_parent).unwrap();
    drop(journal_bytes);
    fixture.reopen();
    let reservation = fixture
        .store
        .producer_reservation(&fixture.binding, &fixture.slot)
        .unwrap()
        .unwrap();
    assert_eq!(reservation.phase(), ProducerPhase::CommittedPinned);
    let saved = fixture.source_parent.read_to_string("main.typ").unwrap();
    let review = fixture
        .source_parent
        .read("main.typ.undertree-review.json")
        .unwrap();
    let ownership = hash(
        &fixture
            .source_parent
            .read("pending-ownership.json")
            .unwrap(),
    );
    let observed = AppliedSource {
        binding: &fixture.binding,
        slot: &fixture.slot,
        content: &saved,
        review_bytes: &review,
        ownership_digest: &ownership,
    };
    let before = disk(fixture.temporary.path());
    fixture
        .store
        .validate_committed_applied(&reservation, &observed)
        .unwrap();
    fixture
        .store
        .validate_committed_applied(&reservation, &observed)
        .unwrap();
    assert_eq!(disk(fixture.temporary.path()), before);
    assert_eq!(
        read_version(&fixture.store, &version).unwrap().content,
        content
    );
    assert!(matches!(
        fixture.catalog().records[0].state,
        Stage::Committed {
            pinned: true,
            recorded_at_observed: true,
            sequence: 1,
            ..
        }
    ));
    fixture
        .store
        .complete(
            &reference,
            &fixture.binding,
            &fixture.slot,
            &ProducerCompletion {
                journal_sha256: &journal_sha256,
                committed_receipt_fingerprint: None,
            },
        )
        .unwrap();
    let before = disk(fixture.temporary.path());
    assert_error(
        fixture
            .store
            .validate_committed_applied(&reservation, &observed),
        "history_unavailable",
    );
    assert_eq!(disk(fixture.temporary.path()), before);
}

#[test]
fn committed_applied_validation_refuses_unarmed_armed_aborted_and_unobserved_publication() {
    for phase in ["unarmed", "armed", "aborted", "unobserved"] {
        let mut fixture = Fixture::new();
        let intent = fixture.capture("old", "saved");
        let journal_bytes = journal(&intent);
        let reference = fixture.store.prepare(&intent, &journal_bytes).unwrap();
        if phase == "armed" || phase == "unobserved" {
            arm(
                &mut fixture.store,
                &fixture.binding,
                &fixture.slot,
                &reference,
                &journal_bytes,
            );
        }
        if phase == "aborted" {
            let reservation = fixture
                .store
                .producer_reservation(&fixture.binding, &fixture.slot)
                .unwrap()
                .unwrap();
            fixture
                .store
                .abort_unapplied(&reservation, &fixture.binding, &fixture.slot)
                .unwrap();
        }
        if phase == "unobserved" {
            fixture.store.failure = Some(FailurePoint::AfterCatalogRename);
            assert_error(
                fixture.store.finalize(
                    &reference,
                    &applied(&fixture.binding, &fixture.slot, "saved", &hash(OWNERSHIP)),
                    &journal_bytes,
                    false,
                ),
                "outcome_unknown",
            );
            fixture.reopen();
        }
        let reservation = fixture
            .store
            .producer_reservation(&fixture.binding, &fixture.slot)
            .unwrap()
            .unwrap();
        let before = disk(&fixture.state);
        assert_error(
            fixture.store.validate_committed_applied(
                &reservation,
                &applied(&fixture.binding, &fixture.slot, "saved", &hash(OWNERSHIP)),
            ),
            "history_unavailable",
        );
        assert_eq!(disk(&fixture.state), before);
        if phase == "unobserved" {
            fixture
                .store
                .finalize(
                    &reference,
                    &applied(&fixture.binding, &fixture.slot, "saved", &hash(OWNERSHIP)),
                    &journal_bytes,
                    true,
                )
                .unwrap();
            let before = disk(&fixture.state);
            assert_error(
                fixture.store.validate_committed_applied(
                    &reservation,
                    &applied(&fixture.binding, &fixture.slot, "saved", &hash(OWNERSHIP)),
                ),
                "history_unavailable",
            );
            assert_eq!(
                disk(&fixture.state),
                before,
                "a stale unobserved reservation must be reloaded"
            );
            let confirmed = fixture
                .store
                .producer_reservation(&fixture.binding, &fixture.slot)
                .unwrap()
                .unwrap();
            fixture
                .store
                .validate_committed_applied(
                    &confirmed,
                    &applied(&fixture.binding, &fixture.slot, "saved", &hash(OWNERSHIP)),
                )
                .unwrap();
            assert_eq!(disk(&fixture.state), before);
        }
    }
}

#[test]
fn committed_applied_validation_rejects_foreign_bindings_slots_and_byte_mismatches() {
    let mut fixture = Fixture::new();
    let content = "saved e\u{301}\r\n";
    let intent = fixture.capture("old", content);
    let journal_bytes = journal(&intent);
    let reference = fixture.store.prepare(&intent, &journal_bytes).unwrap();
    arm(
        &mut fixture.store,
        &fixture.binding,
        &fixture.slot,
        &reference,
        &journal_bytes,
    );
    fixture
        .store
        .finalize(
            &reference,
            &applied(&fixture.binding, &fixture.slot, content, &hash(OWNERSHIP)),
            &journal_bytes,
            false,
        )
        .unwrap();
    let reservation = fixture
        .store
        .producer_reservation(&fixture.binding, &fixture.slot)
        .unwrap()
        .unwrap();
    let foreign = Fixture::new();
    let before = disk(&fixture.state);
    let foreign_before = disk(&foreign.state);
    assert_error(
        foreign.store.validate_committed_applied(
            &reservation,
            &applied(&fixture.binding, &fixture.slot, content, &hash(OWNERSHIP)),
        ),
        "history_unavailable",
    );
    assert_eq!(disk(&foreign.state), foreign_before);
    for change in [
        "project",
        "root",
        "epoch",
        "path",
        "slot",
        "source",
        "review",
        "ownership",
    ] {
        let mut binding = fixture.binding.clone();
        match change {
            "project" => binding.project_id = Uuid::new_v4().to_string(),
            "root" => binding.root.ino ^= 1,
            "epoch" => binding.source_epoch += 1,
            "path" => binding.path = "different.typ".into(),
            _ => (),
        }
        let ownership = if change == "ownership" {
            hash(b"different ownership")
        } else {
            hash(OWNERSHIP)
        };
        let observed = AppliedSource {
            binding: &binding,
            slot: if change == "slot" {
                &foreign.slot
            } else {
                &fixture.slot
            },
            content: if change == "source" {
                "saved e\u{301}\n"
            } else {
                content
            },
            review_bytes: if change == "review" {
                b"exact saved review bytes\n"
            } else {
                REVIEW
            },
            ownership_digest: &ownership,
        };
        assert_error(
            fixture
                .store
                .validate_committed_applied(&reservation, &observed),
            "history_unavailable",
        );
        assert_eq!(disk(&fixture.state), before);
    }
    for field in ["store", "event", "journal", "receipt", "source", "phase"] {
        let mut changed = reservation.clone();
        match field {
            "store" => changed.record.core.store_id = Uuid::new_v4().to_string(),
            "event" => changed.record.reference.event_id = Uuid::new_v4().to_string(),
            "journal" => changed.record.journal_sha256 = hash(b"different journal"),
            "receipt" => changed.record.core.receipt_fingerprint = Some(hash(b"different receipt")),
            "source" => changed.record.source_id = Uuid::new_v4().to_string(),
            "phase" => changed.phase = ProducerPhase::Armed,
            _ => unreachable!(),
        }
        assert_error(
            fixture.store.validate_committed_applied(
                &changed,
                &applied(&fixture.binding, &fixture.slot, content, &hash(OWNERSHIP)),
            ),
            "history_unavailable",
        );
        assert_eq!(disk(&fixture.state), before);
    }
    let mut damaged = content.as_bytes().to_vec();
    damaged[0] ^= 1;
    fs::write(fixture.blob(&reference), damaged).unwrap();
    let before = disk(&fixture.state);
    assert_error(
        fixture.store.validate_committed_applied(
            &reservation,
            &applied(&fixture.binding, &fixture.slot, content, &hash(OWNERSHIP)),
        ),
        "history_unavailable",
    );
    assert_eq!(disk(&fixture.state), before);
}

#[test]
fn native_capture_is_sparse_source_changing_and_does_not_write_before_prepare() {
    let fixture = Fixture::new();
    let before = disk(&fixture.state);
    let first = fixture.capture("old", "new");
    let second = fixture.capture("old", "new");
    assert_ne!(
        first.reference().unwrap().event_id,
        second.reference().unwrap().event_id
    );
    assert_error(
        fixture
            .store
            .capture(capture(&fixture.binding, &fixture.slot, "same"), "same"),
        "history_unchanged",
    );
    assert_error(
        fixture.store.capture(
            capture(&fixture.binding, &fixture.slot, "old"),
            &"x".repeat(MAX_TEXT as usize + 1),
        ),
        "history_quota",
    );
    assert_eq!(disk(&fixture.state), before);
    assert!(fixture.catalog().sources.is_empty());
    assert!(fixture.catalog().records.is_empty());
}

#[test]
fn exact_prepare_retry_and_recovered_finalization_keep_bytes_identity_and_first_sequence() {
    let mut fixture = Fixture::new();
    let content = "= Heading\r\n\r\nA e\u{301} 🧪 passage.\r\n";
    let intent = fixture.capture("older saved words", content);
    let journal = journal(&intent);
    let reference = fixture.store.prepare(&intent, &journal).unwrap();
    arm(
        &mut fixture.store,
        &fixture.binding,
        &fixture.slot,
        &reference,
        &journal,
    );
    let prepared = disk(&fixture.state);
    assert_eq!(fixture.store.prepare(&intent, &journal).unwrap(), reference);
    assert_eq!(disk(&fixture.state), prepared);
    assert_eq!(
        fs::read(fixture.blob(&reference)).unwrap(),
        content.as_bytes()
    );
    fixture.reopen();
    fixture
        .store
        .validate_journal(&reference, &fixture.binding, &fixture.slot, &journal)
        .unwrap();
    let ownership = hash(OWNERSHIP);
    let saved = fixture
        .store
        .finalize(
            &reference,
            &applied(&fixture.binding, &fixture.slot, content, &ownership),
            &journal,
            true,
        )
        .unwrap();
    let serialized = serde_json::to_value(&saved).unwrap();
    let committed = disk(&fixture.state);
    let replay = fixture
        .store
        .finalize(
            &reference,
            &applied(&fixture.binding, &fixture.slot, content, &ownership),
            &journal,
            false,
        )
        .unwrap();
    assert_eq!(serde_json::to_value(replay).unwrap(), serialized);
    assert_eq!(disk(&fixture.state), committed);
    assert!(matches!(
        fixture.catalog().records[0].state,
        Stage::Committed {
            pinned: true,
            after_recovery: true,
            sequence: 1,
            ..
        }
    ));
    complete(
        &mut fixture.store,
        &reference,
        &fixture.binding,
        &fixture.slot,
        &journal,
    );
    let completed = disk(&fixture.state);
    complete(
        &mut fixture.store,
        &reference,
        &fixture.binding,
        &fixture.slot,
        &journal,
    );
    assert_eq!(disk(&fixture.state), completed);
    assert!(matches!(
        fixture.catalog().records[0].state,
        Stage::Committed { pinned: false, .. }
    ));
}

#[test]
fn missing_or_mismatched_private_proof_never_invents_a_recovered_version() {
    let mut fixture = Fixture::new();
    let intent = fixture.capture("old", "new");
    let journal = journal(&intent);
    let reference = intent.reference().unwrap();
    let empty = disk(&fixture.state);
    assert_error(
        fixture
            .store
            .validate_journal(&reference, &fixture.binding, &fixture.slot, &journal),
        "history_unavailable",
    );
    assert_error(
        fixture.store.finalize(
            &reference,
            &applied(&fixture.binding, &fixture.slot, "new", &hash(OWNERSHIP)),
            &journal,
            true,
        ),
        "history_unavailable",
    );
    assert_eq!(disk(&fixture.state), empty);
    fixture.store.prepare(&intent, &journal).unwrap();
    arm(
        &mut fixture.store,
        &fixture.binding,
        &fixture.slot,
        &reference,
        &journal,
    );
    let before = disk(&fixture.state);
    for changed in [
        b"legacy journal without a reference".as_slice(),
        b"another exact journal".as_slice(),
    ] {
        assert_error(
            fixture
                .store
                .validate_journal(&reference, &fixture.binding, &fixture.slot, changed),
            "history_unavailable",
        );
        assert_error(
            fixture.store.finalize(
                &reference,
                &applied(&fixture.binding, &fixture.slot, "new", &hash(OWNERSHIP)),
                changed,
                true,
            ),
            "history_unavailable",
        );
    }
    let mut forged = reference.clone();
    forged.intent_core_sha256 = hash(b"different intent");
    assert_error(
        fixture
            .store
            .validate_journal(&forged, &fixture.binding, &fixture.slot, &journal),
        "history_unavailable",
    );
    assert_error(
        fixture.store.prepare(&intent, b"different journal"),
        "history_unavailable",
    );
    assert_eq!(disk(&fixture.state), before);
    assert!(matches!(
        fixture.catalog().records[0].state,
        Stage::Prepared { .. }
    ));
}

#[test]
fn root_epoch_project_and_applied_group_mismatches_preserve_prepared_evidence() {
    let mut fixture = Fixture::new();
    let intent = fixture.capture("old", "new");
    let journal = journal(&intent);
    let reference = fixture.store.prepare(&intent, &journal).unwrap();
    arm(
        &mut fixture.store,
        &fixture.binding,
        &fixture.slot,
        &reference,
        &journal,
    );
    let before = disk(&fixture.state);
    let mut bindings = Vec::new();
    let mut changed = fixture.binding.clone();
    changed.root.ino += 1;
    bindings.push(changed);
    let mut changed = fixture.binding.clone();
    changed.source_epoch = 1;
    bindings.push(changed);
    let mut changed = fixture.binding.clone();
    changed.project_id = Uuid::new_v4().to_string();
    bindings.push(changed);
    let mut changed = fixture.binding.clone();
    changed.path = "another.typ".into();
    bindings.push(changed);
    for binding in bindings {
        assert_error(
            fixture
                .store
                .validate_journal(&reference, &binding, &fixture.slot, &journal),
            "history_unavailable",
        );
        assert_error(
            fixture.store.finalize(
                &reference,
                &applied(&binding, &fixture.slot, "new", &hash(OWNERSHIP)),
                &journal,
                true,
            ),
            "history_unavailable",
        );
    }
    for content in ["different", "new\r\n"] {
        assert_error(
            fixture.store.finalize(
                &reference,
                &applied(&fixture.binding, &fixture.slot, content, &hash(OWNERSHIP)),
                &journal,
                false,
            ),
            "history_unavailable",
        );
    }
    let ownership = hash(OWNERSHIP);
    let wrong_review = AppliedSource {
        binding: &fixture.binding,
        slot: &fixture.slot,
        content: "new",
        review_bytes: b"different review",
        ownership_digest: &ownership,
    };
    assert_error(
        fixture
            .store
            .finalize(&reference, &wrong_review, &journal, false),
        "history_unavailable",
    );
    assert_error(
        fixture.store.finalize(
            &reference,
            &applied(
                &fixture.binding,
                &fixture.slot,
                "new",
                &hash(b"different ownership"),
            ),
            &journal,
            false,
        ),
        "history_unavailable",
    );
    assert_eq!(disk(&fixture.state), before);
}

#[test]
fn prepared_and_pinned_events_block_the_same_source_until_completion() {
    let mut fixture = Fixture::new();
    let intent = fixture.capture("old", "first");
    let first_journal = journal(&intent);
    let reference = fixture.store.prepare(&intent, &first_journal).unwrap();
    arm(
        &mut fixture.store,
        &fixture.binding,
        &fixture.slot,
        &reference,
        &first_journal,
    );
    let before = disk(&fixture.state);
    let attempted = fixture.capture("first", "second");
    assert_error(
        fixture.store.prepare(&attempted, &journal(&attempted)),
        "history_pending",
    );
    assert_eq!(disk(&fixture.state), before);
    fixture
        .store
        .finalize(
            &reference,
            &applied(&fixture.binding, &fixture.slot, "first", &hash(OWNERSHIP)),
            &first_journal,
            false,
        )
        .unwrap();
    let second = fixture.capture("first", "second");
    assert_error(
        fixture.store.prepare(&second, &journal(&second)),
        "history_pending",
    );
    let mut other_binding = fixture.binding.clone();
    other_binding.path = "independent.typ".into();
    let other_slot = fixture.slot_for(&other_binding);
    let other = fixture
        .store
        .capture(capture(&other_binding, &other_slot, "old"), "independent")
        .unwrap();
    fixture.store.prepare(&other, &journal(&other)).unwrap();
    complete(
        &mut fixture.store,
        &reference,
        &fixture.binding,
        &fixture.slot,
        &first_journal,
    );
    let second = fixture.capture("first", "second");
    let second_journal = journal(&second);
    let second_reference = fixture.store.prepare(&second, &second_journal).unwrap();
    arm(
        &mut fixture.store,
        &fixture.binding,
        &fixture.slot,
        &second_reference,
        &second_journal,
    );
    fixture
        .store
        .finalize(
            &second_reference,
            &applied(&fixture.binding, &fixture.slot, "second", &hash(OWNERSHIP)),
            &second_journal,
            false,
        )
        .unwrap();
    assert_eq!(fixture.catalog().records.len(), 3);
    complete(
        &mut fixture.store,
        &second_reference,
        &fixture.binding,
        &fixture.slot,
        &second_journal,
    );
}

#[test]
fn completion_cannot_promote_prepared_or_accept_a_different_receipt() {
    let mut fixture = Fixture::new();
    let mut capture = capture(&fixture.binding, &fixture.slot, "old");
    capture.receipt_fingerprint = Some(hash(b"native receipt"));
    let intent = fixture.store.capture(capture, "new").unwrap();
    let journal = journal(&intent);
    let reference = fixture.store.prepare(&intent, &journal).unwrap();
    arm(
        &mut fixture.store,
        &fixture.binding,
        &fixture.slot,
        &reference,
        &journal,
    );
    let digest = hash(&journal);
    let receipt = hash(b"native receipt");
    let proof = ProducerCompletion {
        journal_sha256: &digest,
        committed_receipt_fingerprint: Some(&receipt),
    };
    let before = disk(&fixture.state);
    assert_error(
        fixture
            .store
            .complete(&reference, &fixture.binding, &fixture.slot, &proof),
        "history_unavailable",
    );
    assert_eq!(disk(&fixture.state), before);
    fixture
        .store
        .finalize(
            &reference,
            &applied(&fixture.binding, &fixture.slot, "new", &hash(OWNERSHIP)),
            &journal,
            false,
        )
        .unwrap();
    let committed = disk(&fixture.state);
    for fingerprint in [None, Some(hash(b"different receipt"))] {
        assert_error(
            fixture.store.complete(
                &reference,
                &fixture.binding,
                &fixture.slot,
                &ProducerCompletion {
                    journal_sha256: &digest,
                    committed_receipt_fingerprint: fingerprint.as_deref(),
                },
            ),
            "history_unavailable",
        );
    }
    assert_eq!(disk(&fixture.state), committed);
    fixture
        .store
        .complete(&reference, &fixture.binding, &fixture.slot, &proof)
        .unwrap();
}

#[test]
fn a_to_b_to_a_is_two_events_without_an_invented_baseline_or_content_deduplication() {
    let mut fixture = Fixture::new();
    let a = "A\r\n";
    let b = "B e\u{301} 🧪\r\n";
    let (_, first_reference, _, first) =
        save(&mut fixture.store, &fixture.binding, &fixture.slot, a, b);
    let (_, second_reference, _, second) =
        save(&mut fixture.store, &fixture.binding, &fixture.slot, b, a);
    assert_ne!(first_reference.event_id, second_reference.event_id);
    assert_eq!(
        (first.sequence.as_str(), second.sequence.as_str()),
        ("1", "2")
    );
    assert_eq!(first.source_id, second.source_id);
    let before = disk(&fixture.state);
    assert_eq!(read_version(&fixture.store, &first).unwrap().content, b);
    assert_eq!(read_version(&fixture.store, &second).unwrap().content, a);
    let page = list(
        &fixture.store,
        &fixture.binding,
        Some(&first.namespace_id),
        Some(&first.source_id),
        None,
    )
    .unwrap();
    let ids: Vec<_> = page
        .items
        .into_iter()
        .map(|item| match item {
            HistoryItem::Version { version } => version.version_id,
            _ => panic!("expected saved version"),
        })
        .collect();
    assert_eq!(ids, [second.version_id, first.version_id]);
    assert_eq!(fixture.catalog().records.len(), 2);
    assert_eq!(disk(&fixture.state), before);
}

#[test]
fn queries_are_read_only_and_compare_exact_text_with_utf16_complete_line_spans() {
    let mut fixture = Fixture::new();
    let common = "🧪 common\r\n";
    let from = format!("{common}before e\u{301}\r\n<script>literal & text</script>\r\n");
    let to = format!("{common}after 👩🏽‍🔬\r\n<script>literal & text</script>\r\n");
    let (_, _, _, first) = save(
        &mut fixture.store,
        &fixture.binding,
        &fixture.slot,
        "old",
        &from,
    );
    let (_, _, _, second) = save(
        &mut fixture.store,
        &fixture.binding,
        &fixture.slot,
        &from,
        &to,
    );
    let pending = fixture.capture(&to, "not committed");
    fixture.store.prepare(&pending, &journal(&pending)).unwrap();
    let before = disk(&fixture.state);
    let namespaces = list(&fixture.store, &fixture.binding, None, None, None).unwrap();
    assert_eq!(namespaces.items.len(), 1);
    let files = list(
        &fixture.store,
        &fixture.binding,
        Some(&first.namespace_id),
        None,
        None,
    )
    .unwrap();
    assert_eq!(files.items.len(), 1);
    let versions = list(
        &fixture.store,
        &fixture.binding,
        Some(&first.namespace_id),
        Some(&first.source_id),
        None,
    )
    .unwrap();
    assert_eq!(
        versions.items.len(),
        2,
        "a prepared reservation is not a saved version"
    );
    assert_eq!(read_version(&fixture.store, &first).unwrap().content, from);
    let comparison = compare(&fixture.store, &first, &second).unwrap();
    assert_eq!(comparison.method, "coarse_text_comparison");
    assert_eq!(comparison.from.content, from);
    assert_eq!(comparison.to.content, to);
    let start = common.encode_utf16().count();
    assert_eq!(
        comparison.from_changed,
        Some(ChangedSpan {
            from_utf16: start,
            to_utf16: start + "before e\u{301}\r\n".encode_utf16().count()
        })
    );
    assert_eq!(
        comparison.to_changed,
        Some(ChangedSpan {
            from_utf16: start,
            to_utf16: start + "after 👩🏽‍🔬\r\n".encode_utf16().count()
        })
    );
    let same = compare(&fixture.store, &first, &first).unwrap();
    assert_eq!((same.from_changed, same.to_changed), (None, None));
    let mut unknown = first.clone();
    unknown.version_id = Uuid::new_v4().to_string();
    assert_error(
        read_version(&fixture.store, &unknown),
        "history_not_retained",
    );
    let mut wrong_project = first.clone();
    wrong_project.binding.project_id = Uuid::new_v4().to_string();
    assert_error(
        read_version(&fixture.store, &wrong_project),
        "history_unavailable",
    );
    assert_eq!(
        disk(&fixture.state),
        before,
        "list/read/compare and denied queries must not write or collect"
    );
}

#[test]
fn root_project_and_epoch_namespaces_do_not_alias_or_fall_back_to_old_paths() {
    let mut fixture = Fixture::new();
    let (_, _, _, original) = save(
        &mut fixture.store,
        &fixture.binding,
        &fixture.slot,
        "old",
        "original root",
    );
    let mut new_epoch = fixture.binding.clone();
    new_epoch.source_epoch = 1;
    let (_, _, _, epoch) = save(
        &mut fixture.store,
        &new_epoch,
        &fixture.slot,
        "old",
        "new source at same path",
    );
    assert_eq!(original.namespace_id, epoch.namespace_id);
    assert_ne!(original.source_id, epoch.source_id);
    let mut new_root = fixture.binding.clone();
    new_root.root.ino += 1;
    let empty = fixture
        .store
        .query(HistoryQuery::List {
            project_id: new_root.project_id.clone(),
            namespace_id: None,
            observed_root: Some(new_root.root),
            source_id: None,
            cursor: None,
        })
        .unwrap();
    assert!(
        matches!(empty, HistoryReply::List(page) if page.items.is_empty() && page.namespace_id.is_none())
    );
    let (_, _, _, replacement) = save(
        &mut fixture.store,
        &new_root,
        &fixture.slot,
        "old",
        "replacement root",
    );
    assert_ne!(original.namespace_id, replacement.namespace_id);
    let mut nested_project = fixture.binding.clone();
    nested_project.project_id = Uuid::new_v4().to_string();
    let (_, _, _, nested) = save(
        &mut fixture.store,
        &nested_project,
        &fixture.slot,
        "old",
        "separate approved project",
    );
    assert_ne!(original.namespace_id, nested.namespace_id);
    let before = disk(&fixture.state);
    assert_eq!(
        read_version(&fixture.store, &original).unwrap().content,
        "original root"
    );
    assert_error(
        fixture.store.query(HistoryQuery::Read {
            project_id: original.binding.project_id.clone(),
            namespace_id: replacement.namespace_id.clone(),
            source_id: original.source_id.clone(),
            version_id: original.version_id.clone(),
        }),
        "history_unavailable",
    );
    assert_error(
        fixture.store.query(HistoryQuery::Compare {
            project_id: original.binding.project_id.clone(),
            namespace_id: original.namespace_id.clone(),
            source_id: original.source_id.clone(),
            from_version_id: original.version_id.clone(),
            to_version_id: epoch.version_id.clone(),
        }),
        "history_not_retained",
    );
    assert_eq!(disk(&fixture.state), before);
}

#[test]
fn acceptance_records_native_cause_and_suggestion_without_trusting_journal_fields() {
    let mut fixture = Fixture::new();
    let suggestion_id = Uuid::new_v4().to_string();
    let mut native = capture(&fixture.binding, &fixture.slot, "old");
    native.cause = NativeCause::Acceptance {
        suggestion_id: suggestion_id.clone(),
    };
    native.captured_at_ms = Some(u64::MAX);
    let intent = fixture
        .store
        .capture(native, "accepted exact source")
        .unwrap();
    let journal = b"opaque authenticated producer journal; not a renderer cause";
    let reference = fixture.store.prepare(&intent, journal).unwrap();
    arm(
        &mut fixture.store,
        &fixture.binding,
        &fixture.slot,
        &reference,
        journal,
    );
    let version = fixture
        .store
        .finalize(
            &reference,
            &applied(
                &fixture.binding,
                &fixture.slot,
                "accepted exact source",
                &hash(OWNERSHIP),
            ),
            journal,
            false,
        )
        .unwrap();
    assert_eq!(version.cause, "local_acceptance");
    assert_eq!(
        version.suggestion_id.as_deref(),
        Some(suggestion_id.as_str())
    );
    assert_eq!(version.captured_at_ms, Some(u64::MAX));
    assert!(version.clock_adjusted);
    complete(
        &mut fixture.store,
        &reference,
        &fixture.binding,
        &fixture.slot,
        journal,
    );
    assert_eq!(
        read_version(&fixture.store, &version).unwrap().content,
        "accepted exact source"
    );
}

#[test]
fn interrupted_prepare_after_rename_or_payload_publish_retries_the_exact_private_identity() {
    for failure in [
        FailurePoint::AfterCatalogRename,
        FailurePoint::AfterBlobPublish,
    ] {
        let mut fixture = Fixture::new();
        let intent = fixture.capture("old", "new 🧪\r\n");
        let journal = journal(&intent);
        let reference = intent.reference().unwrap();
        fixture.store.failure = Some(failure);
        assert_error(fixture.store.prepare(&intent, &journal), "outcome_unknown");
        assert_eq!(fixture.catalog().records.len(), 1);
        assert!(matches!(
            fixture.catalog().records[0].state,
            Stage::Prepared { .. }
        ));
        assert_eq!(
            fixture.blob(&reference).exists(),
            failure == FailurePoint::AfterBlobPublish
        );
        fixture.reopen();
        let before = disk(&fixture.state);
        assert_error(
            fixture
                .store
                .validate_journal(&reference, &fixture.binding, &fixture.slot, &journal),
            "history_unavailable",
        );
        assert_eq!(disk(&fixture.state), before);
        assert_eq!(fixture.store.prepare(&intent, &journal).unwrap(), reference);
        arm(
            &mut fixture.store,
            &fixture.binding,
            &fixture.slot,
            &reference,
            &journal,
        );
        fixture
            .store
            .validate_journal(&reference, &fixture.binding, &fixture.slot, &journal)
            .unwrap();
        let version = fixture
            .store
            .finalize(
                &reference,
                &applied(
                    &fixture.binding,
                    &fixture.slot,
                    &intent.content,
                    &hash(OWNERSHIP),
                ),
                &journal,
                true,
            )
            .unwrap();
        assert_eq!(version.version_id, reference.event_id);
        assert_eq!(version.sequence, "1");
        assert!(version.after_recovery);
        assert_eq!(fixture.catalog().records.len(), 1);
    }
}

#[test]
fn interrupted_finalize_and_completion_keep_the_first_committed_sequence_and_pin_outcome() {
    let mut fixture = Fixture::new();
    let intent = fixture.capture("old", "new");
    let journal = journal(&intent);
    let reference = fixture.store.prepare(&intent, &journal).unwrap();
    arm(
        &mut fixture.store,
        &fixture.binding,
        &fixture.slot,
        &reference,
        &journal,
    );
    fixture.store.failure = Some(FailurePoint::AfterCatalogRename);
    assert_error(
        fixture.store.finalize(
            &reference,
            &applied(&fixture.binding, &fixture.slot, "new", &hash(OWNERSHIP)),
            &journal,
            false,
        ),
        "outcome_unknown",
    );
    assert!(matches!(
        fixture.catalog().records[0].state,
        Stage::Committed {
            sequence: 1,
            pinned: true,
            after_recovery: false,
            recorded_at_ms: None,
            recorded_at_observed: false,
            ..
        }
    ));
    fixture.reopen();
    fixture
        .store
        .validate_journal(&reference, &fixture.binding, &fixture.slot, &journal)
        .unwrap();
    let version = fixture
        .store
        .finalize(
            &reference,
            &applied(&fixture.binding, &fixture.slot, "new", &hash(OWNERSHIP)),
            &journal,
            true,
        )
        .unwrap();
    assert_eq!(version.sequence, "1");
    assert_eq!(version.captured_at_ms, Some(1_700_000_000_000));
    assert!(
        version.after_recovery,
        "the first confirmed publication happens during recovery"
    );
    assert!(version.recorded_at_ms.is_some());
    let before = disk(&fixture.state);
    let replay = fixture
        .store
        .finalize(
            &reference,
            &applied(&fixture.binding, &fixture.slot, "new", &hash(OWNERSHIP)),
            &journal,
            false,
        )
        .unwrap();
    assert_eq!(
        serde_json::to_value(&replay).unwrap(),
        serde_json::to_value(&version).unwrap()
    );
    assert_eq!(disk(&fixture.state), before);
    fixture.store.failure = Some(FailurePoint::AfterCatalogRename);
    let journal_sha256 = hash(&journal);
    let completion = ProducerCompletion {
        journal_sha256: &journal_sha256,
        committed_receipt_fingerprint: None,
    };
    assert_error(
        fixture
            .store
            .complete(&reference, &fixture.binding, &fixture.slot, &completion),
        "outcome_unknown",
    );
    assert!(matches!(
        fixture.catalog().records[0].state,
        Stage::Committed { pinned: false, .. }
    ));
    fixture.reopen();
    let before = disk(&fixture.state);
    fixture
        .store
        .complete(&reference, &fixture.binding, &fixture.slot, &completion)
        .unwrap();
    assert_eq!(disk(&fixture.state), before);
    assert_eq!(
        read_version(&fixture.store, &version).unwrap().content,
        "new"
    );
}

#[test]
fn interrupted_catalog_before_rename_preserves_unpublished_evidence_and_never_guesses_cleanup() {
    let mut fixture = Fixture::new();
    let intent = fixture.capture("old", "new");
    let journal = journal(&intent);
    let old_catalog = fs::read(fixture.state.join("history-v1/catalog.json")).unwrap();
    fixture.store.failure = Some(FailurePoint::BeforeCatalogRename);
    assert_error(fixture.store.prepare(&intent, &journal), "outcome_unknown");
    assert_eq!(
        fs::read(fixture.state.join("history-v1/catalog.json")).unwrap(),
        old_catalog
    );
    assert!(fixture.state.join("history-v1/catalog.next").is_file());
    assert!(!fixture.blob(&intent.reference().unwrap()).exists());
    let before = disk(&fixture.state);
    let capability = Dir::open_ambient_dir(&fixture.state, cap_std::ambient_authority()).unwrap();
    assert_error(
        HistoryStore::open(capability, Some(fixture.store_id)),
        "history_unavailable",
    );
    assert_error(
        fixture.store.prepare(&intent, &journal),
        "history_unavailable",
    );
    assert_eq!(disk(&fixture.state), before);
}

#[test]
fn retention_keeps_32_versions_and_pruned_native_objects_cannot_reenter_after_cleanup() {
    let mut fixture = Fixture::new();
    let (old_intent, oldest_reference, old_journal, oldest) = save(
        &mut fixture.store,
        &fixture.binding,
        &fixture.slot,
        "baseline",
        "version 0",
    );
    let mut previous = "version 0".to_owned();
    let mut latest = oldest.clone();
    for index in 1..=MAX_VERSIONS {
        let current = format!("version {index}");
        latest = save(
            &mut fixture.store,
            &fixture.binding,
            &fixture.slot,
            &previous,
            &current,
        )
        .3;
        previous = current;
    }
    let catalog = fixture.catalog();
    assert_eq!(catalog.records.len(), MAX_VERSIONS);
    assert_eq!(catalog.retired.len(), 1);
    assert_eq!(catalog.retired[0].event_id, oldest_reference.event_id);
    assert!(
        fixture.blob(&oldest_reference).is_file(),
        "retired payload remains charged until explicit maintenance"
    );
    let before = disk(&fixture.state);
    let page = list(
        &fixture.store,
        &fixture.binding,
        Some(&oldest.namespace_id),
        Some(&oldest.source_id),
        None,
    )
    .unwrap();
    assert_eq!(page.items.len(), MAX_VERSIONS);
    assert!(
        matches!(&page.items[0], HistoryItem::Version { version } if version.version_id == latest.version_id)
    );
    assert_error(
        read_version(&fixture.store, &oldest),
        "history_not_retained",
    );
    assert_error(
        fixture.store.prepare(&old_intent, &old_journal),
        "history_unavailable",
    );
    assert_eq!(disk(&fixture.state), before);
    fixture.store.maintain().unwrap();
    assert!(!fixture.blob(&oldest_reference).exists());
    assert!(fixture.catalog().retired.is_empty());
    let cleaned = disk(&fixture.state);
    fixture.store.maintain().unwrap();
    assert_error(
        fixture.store.prepare(&old_intent, &old_journal),
        "history_unavailable",
    );
    assert_eq!(disk(&fixture.state), cleaned);
}

#[test]
fn retired_payload_deletion_failure_keeps_proof_and_retries_only_the_exact_known_blob() {
    for failure in [
        FailurePoint::BeforeRetiredDelete,
        FailurePoint::AfterRetiredDelete,
    ] {
        let mut fixture = Fixture::new();
        let (_, oldest, _, _) = save(
            &mut fixture.store,
            &fixture.binding,
            &fixture.slot,
            "old",
            "version 0",
        );
        let mut previous = "version 0".to_owned();
        for index in 1..=MAX_VERSIONS {
            let current = format!("version {index}");
            save(
                &mut fixture.store,
                &fixture.binding,
                &fixture.slot,
                &previous,
                &current,
            );
            previous = current;
        }
        let outside = fixture.temporary.path().join("unrelated-saved-source.typ");
        fs::write(&outside, b"never delete this source").unwrap();
        fixture.store.failure = Some(failure);
        assert_error(fixture.store.maintain(), "outcome_unknown");
        assert_eq!(fixture.catalog().retired.len(), 1);
        assert_eq!(
            fixture.blob(&oldest).exists(),
            failure == FailurePoint::BeforeRetiredDelete
        );
        fixture.reopen();
        let before = disk(&fixture.state);
        assert_eq!(
            list(&fixture.store, &fixture.binding, None, None, None)
                .unwrap()
                .items
                .len(),
            1
        );
        assert_eq!(
            disk(&fixture.state),
            before,
            "query must not retry collection"
        );
        fixture.store.maintain().unwrap();
        assert!(fixture.catalog().retired.is_empty());
        assert!(!fixture.blob(&oldest).exists());
        assert_eq!(fs::read(outside).unwrap(), b"never delete this source");
        assert_eq!(fixture.catalog().records.len(), MAX_VERSIONS);
    }
}

fn assert_unavailable_preserves(fixture: &Fixture) {
    let before = disk(&fixture.state);
    let capability = Dir::open_ambient_dir(&fixture.state, cap_std::ambient_authority()).unwrap();
    assert_error(
        HistoryStore::open(capability, Some(fixture.store_id)),
        "history_unavailable",
    );
    assert_error(
        list(&fixture.store, &fixture.binding, None, None, None),
        "history_unavailable",
    );
    assert_eq!(disk(&fixture.state), before);
}

#[test]
fn same_size_corrupt_payload_is_never_returned_or_used_as_recovery_proof() {
    let mut fixture = Fixture::new();
    let intent = fixture.capture("old", "new");
    let journal = journal(&intent);
    let reference = fixture.store.prepare(&intent, &journal).unwrap();
    arm(
        &mut fixture.store,
        &fixture.binding,
        &fixture.slot,
        &reference,
        &journal,
    );
    let version = fixture
        .store
        .finalize(
            &reference,
            &applied(&fixture.binding, &fixture.slot, "new", &hash(OWNERSHIP)),
            &journal,
            false,
        )
        .unwrap();
    fs::write(fixture.blob(&reference), b"bad").unwrap();
    let before = disk(&fixture.state);
    assert_error(
        read_version(&fixture.store, &version),
        "history_unavailable",
    );
    assert_error(
        fixture
            .store
            .validate_journal(&reference, &fixture.binding, &fixture.slot, &journal),
        "history_unavailable",
    );
    assert_error(
        fixture.store.finalize(
            &reference,
            &applied(&fixture.binding, &fixture.slot, "new", &hash(OWNERSHIP)),
            &journal,
            true,
        ),
        "history_unavailable",
    );
    assert_error(
        fixture.store.prepare(&intent, &journal),
        "history_unavailable",
    );
    assert_eq!(disk(&fixture.state), before);
}

#[test]
fn unknown_private_files_and_missing_committed_files_are_preserved_without_reset() {
    for relative in ["history-v1/unrecognized", "history-v1/blobs/unknown.utf8"] {
        let fixture = Fixture::new();
        fs::write(fixture.state.join(relative), b"unowned private evidence").unwrap();
        assert_unavailable_preserves(&fixture);
    }
    for relative in ["history-v1/catalog.json", "history-v1/blobs"] {
        let fixture = Fixture::new();
        let path = fixture.state.join(relative);
        if path.is_dir() {
            #[cfg(windows)]
            {
                let before = disk(&fixture.state);
                let error = fs::remove_dir(&path).unwrap_err();
                assert!(matches!(error.raw_os_error(), Some(5) | Some(32)));
                assert_eq!(disk(&fixture.state), before);
                drop(fixture.store);
                fs::remove_dir(&path).unwrap();
                let before = disk(&fixture.state);
                let capability =
                    Dir::open_ambient_dir(&fixture.state, cap_std::ambient_authority()).unwrap();
                assert_error(
                    HistoryStore::open(capability, Some(fixture.store_id)),
                    "history_unavailable",
                );
                assert_eq!(disk(&fixture.state), before);
                continue;
            }
            #[cfg(not(windows))]
            fs::remove_dir(path).unwrap();
        } else {
            fs::remove_file(path).unwrap();
        }
        assert_unavailable_preserves(&fixture);
    }
    let mut fixture = Fixture::new();
    let (_, reference, _, _) = save(
        &mut fixture.store,
        &fixture.binding,
        &fixture.slot,
        "old",
        "saved",
    );
    fs::remove_file(fixture.blob(&reference)).unwrap();
    assert_unavailable_preserves(&fixture);
    let fixture = Fixture::new();
    #[cfg(windows)]
    {
        let before = disk(&fixture.state);
        let error = fs::rename(
            fixture.state.join("history-v1"),
            fixture.temporary.path().join("displaced-history"),
        )
        .unwrap_err();
        assert!(matches!(error.raw_os_error(), Some(5) | Some(32)));
        assert_eq!(disk(&fixture.state), before);
        drop(fixture.store);
        fs::rename(
            fixture.state.join("history-v1"),
            fixture.temporary.path().join("displaced-history"),
        )
        .unwrap();
        let before = disk(&fixture.state);
        let capability =
            Dir::open_ambient_dir(&fixture.state, cap_std::ambient_authority()).unwrap();
        assert_error(
            HistoryStore::open(capability, Some(fixture.store_id)),
            "history_unavailable",
        );
        assert_eq!(disk(&fixture.state), before);
        assert!(fixture
            .temporary
            .path()
            .join("displaced-history/catalog.json")
            .is_file());
        assert!(!fixture.state.join("history-v1").exists());
    }
    #[cfg(not(windows))]
    {
        fs::rename(
            fixture.state.join("history-v1"),
            fixture.temporary.path().join("displaced-history"),
        )
        .unwrap();
        assert_unavailable_preserves(&fixture);
        assert!(fixture
            .temporary
            .path()
            .join("displaced-history/catalog.json")
            .is_file());
        assert!(!fixture.state.join("history-v1").exists());
    }
}

#[test]
fn hardlinked_catalog_or_blob_is_refused_without_touching_the_other_link() {
    for catalog in [true, false] {
        let mut fixture = Fixture::new();
        let (_, reference, _, _) = save(
            &mut fixture.store,
            &fixture.binding,
            &fixture.slot,
            "old",
            "saved",
        );
        let path = if catalog {
            fixture.state.join("history-v1/catalog.json")
        } else {
            fixture.blob(&reference)
        };
        let external = fixture.temporary.path().join("other-owner");
        fs::hard_link(&path, &external).unwrap();
        let bytes = fs::read(&external).unwrap();
        assert_unavailable_preserves(&fixture);
        assert_eq!(fs::read(external).unwrap(), bytes);
    }
}

#[cfg(unix)]
#[test]
fn symlinked_private_entries_cannot_escape_the_native_state_capability() {
    use std::os::unix::fs::symlink;
    for target in ["catalog", "blob", "directory"] {
        let mut fixture = Fixture::new();
        let (_, reference, _, _) = save(
            &mut fixture.store,
            &fixture.binding,
            &fixture.slot,
            "old",
            "saved",
        );
        let external = fixture.temporary.path().join("external");
        if target == "directory" {
            fs::create_dir(&external).unwrap();
            fs::write(external.join("unowned.typ"), b"external source").unwrap();
            let blobs = fixture.state.join("history-v1/blobs");
            fs::rename(&blobs, fixture.temporary.path().join("original-blobs")).unwrap();
            symlink(&external, blobs).unwrap();
            let outside = disk(&external);
            assert_unavailable_preserves(&fixture);
            assert_eq!(disk(&external), outside);
        } else {
            let path = if target == "catalog" {
                fixture.state.join("history-v1/catalog.json")
            } else {
                fixture.blob(&reference)
            };
            let bytes = fs::read(&path).unwrap();
            fs::write(&external, &bytes).unwrap();
            fs::remove_file(&path).unwrap();
            symlink(&external, path).unwrap();
            assert_unavailable_preserves(&fixture);
            assert_eq!(fs::read(external).unwrap(), bytes);
        }
    }
}

#[test]
fn paginated_lists_have_no_duplicates_and_reject_cross_scope_or_old_generation_cursors() {
    let mut fixture = Fixture::new();
    let mut last = None;
    for index in 0..51 {
        let mut binding = fixture.binding.clone();
        binding.path = format!("chapter-{index}.typ");
        let slot = fixture.slot_for(&binding);
        last = Some(save(&mut fixture.store, &binding, &slot, "old", "saved").3);
    }
    let version = last.unwrap();
    let before = disk(&fixture.state);
    let first = list(
        &fixture.store,
        &fixture.binding,
        Some(&version.namespace_id),
        None,
        None,
    )
    .unwrap();
    assert_eq!(first.items.len(), 50);
    let cursor = first.cursor.unwrap();
    let second = list(
        &fixture.store,
        &fixture.binding,
        Some(&version.namespace_id),
        None,
        Some(cursor.clone()),
    )
    .unwrap();
    assert_eq!(second.items.len(), 1);
    assert!(second.cursor.is_none());
    let mut ids = BTreeSet::new();
    for item in first.items.into_iter().chain(second.items) {
        match item {
            HistoryItem::Source { source_id, .. } => assert!(ids.insert(source_id)),
            _ => panic!("expected source"),
        }
    }
    assert_eq!(ids.len(), 51);
    let mut wrong_project = cursor.clone();
    wrong_project.project_id = Uuid::new_v4().to_string();
    let mut wrong_source = cursor.clone();
    wrong_source.source_id = Some(version.source_id.clone());
    let mut wrong_kind = cursor.clone();
    wrong_kind.page_kind = "versions".into();
    let mut wrong_anchor = cursor.clone();
    wrong_anchor.anchor = Uuid::new_v4().to_string();
    for changed in [wrong_project, wrong_source, wrong_kind, wrong_anchor] {
        assert_error(
            list(
                &fixture.store,
                &fixture.binding,
                Some(&version.namespace_id),
                None,
                Some(changed),
            ),
            "history_stale",
        );
    }
    assert_eq!(disk(&fixture.state), before);
    let mut binding = fixture.binding.clone();
    binding.path = "later.typ".into();
    let slot = fixture.slot_for(&binding);
    save(
        &mut fixture.store,
        &binding,
        &slot,
        "old",
        "later saved content",
    );
    let after = disk(&fixture.state);
    assert_error(
        list(
            &fixture.store,
            &fixture.binding,
            Some(&version.namespace_id),
            None,
            Some(cursor),
        ),
        "history_stale",
    );
    assert_eq!(disk(&fixture.state), after);
}

#[test]
fn payload_quota_refuses_before_publication_and_preserves_every_unresolved_pin() {
    let mut fixture = Fixture::new();
    let content = "x".repeat(MAX_TEXT as usize);
    let ownership = hash(OWNERSHIP);
    let count = STEADY_PAYLOAD / MAX_TEXT;
    let mut first = None;
    for index in 0..count {
        let mut binding = fixture.binding.clone();
        binding.path = format!("pinned-{index}.typ");
        let slot = fixture.slot_for(&binding);
        let intent = fixture
            .store
            .capture(capture(&binding, &slot, "old"), &content)
            .unwrap();
        let journal = journal(&intent);
        let reference = fixture.store.prepare(&intent, &journal).unwrap();
        arm(&mut fixture.store, &binding, &slot, &reference, &journal);
        let version = fixture
            .store
            .finalize(
                &reference,
                &applied(&binding, &slot, &content, &ownership),
                &journal,
                false,
            )
            .unwrap();
        if index == 0 {
            first = Some((reference, journal, binding, slot, version));
        }
    }
    let before_catalog = fs::read(fixture.state.join("history-v1/catalog.json")).unwrap();
    let mut binding = fixture.binding.clone();
    binding.path = "one-too-many.typ".into();
    let slot = fixture.slot_for(&binding);
    let intent = fixture
        .store
        .capture(capture(&binding, &slot, "old"), &content)
        .unwrap();
    let reference = intent.reference().unwrap();
    assert_error(
        fixture.store.prepare(&intent, &journal(&intent)),
        "history_quota",
    );
    assert!(!fixture.blob(&reference).exists());
    assert_eq!(
        fs::read(fixture.state.join("history-v1/catalog.json")).unwrap(),
        before_catalog
    );
    let catalog = fixture.catalog();
    assert_eq!(catalog.records.len() as u64, count);
    assert_eq!(catalog.payload_bytes(), count * MAX_TEXT);
    assert!(catalog.retired.is_empty());
    assert!(catalog
        .records
        .iter()
        .all(|record| matches!(record.state, Stage::Committed { pinned: true, .. })));
    let (reference, journal, binding, slot, version) = first.unwrap();
    fixture
        .store
        .validate_journal(&reference, &binding, &slot, &journal)
        .unwrap();
    assert_eq!(
        read_version(&fixture.store, &version).unwrap().content,
        content
    );
    fixture.store.maintain().unwrap();
    assert_eq!(
        fs::read(fixture.state.join("history-v1/catalog.json")).unwrap(),
        before_catalog,
        "maintenance cannot discard unresolved source groups"
    );
}

#[test]
fn catalog_admission_reserves_future_commit_growth_before_a_native_source_effect() {
    let mut fixture = Fixture::new();
    let ownership = hash(OWNERSHIP);
    let prefix = vec!["a".repeat(240); 16].join("/");
    let mut admitted = 0;
    for index in 0..=MAX_BINDINGS {
        let mut binding = fixture.binding.clone();
        binding.path = format!("{prefix}/chapter-{index}.typ");
        let slot = fixture.slot_for(&binding);
        let intent = fixture
            .store
            .capture(capture(&binding, &slot, "old"), "saved")
            .unwrap();
        let journal = journal(&intent);
        let previous = fs::read(fixture.state.join("history-v1/catalog.json")).unwrap();
        match fixture.store.prepare(&intent, &journal) {
            Ok(reference) => {
                arm(&mut fixture.store, &binding, &slot, &reference, &journal);
                // Once admitted, future timestamps/sequence fields cannot consume unreserved space.
                fixture
                    .store
                    .finalize(
                        &reference,
                        &applied(&binding, &slot, "saved", &ownership),
                        &journal,
                        false,
                    )
                    .unwrap();
                admitted += 1;
                assert!(
                    fs::metadata(fixture.state.join("history-v1/catalog.json"))
                        .unwrap()
                        .len()
                        <= MAX_CATALOG as u64
                );
            }
            Err(error) => {
                assert_eq!(error.code, "history_quota");
                assert_eq!(
                    fs::read(fixture.state.join("history-v1/catalog.json")).unwrap(),
                    previous
                );
                assert!(!fixture.blob(&intent.reference().unwrap()).exists());
                assert!(admitted > 0 && admitted < MAX_BINDINGS);
                return;
            }
        }
    }
    panic!("long source bindings should reach the catalog bound before the binding count");
}

#[test]
fn closed_query_and_binding_limits_are_rejected_without_creating_private_records() {
    let fixture = Fixture::new();
    let before = disk(&fixture.state);
    for path in [
        "../main.typ",
        "hidden/.private.typ",
        "For-AI/draft.typ",
        "node_modules/draft.typ",
        "C:\\draft.typ",
        "draft\n.typ",
        "draft.pdf",
        "",
        "a//draft.typ",
    ] {
        let mut binding = fixture.binding.clone();
        binding.path = path.into();
        assert_error(
            fixture
                .store
                .capture(capture(&binding, &fixture.slot, "old"), "new"),
            "history_unavailable",
        );
    }
    let mut deep = fixture.binding.clone();
    deep.path = format!("{}draft.typ", "dir/".repeat(32));
    assert_error(
        fixture
            .store
            .capture(capture(&deep, &fixture.slot, "old"), "new"),
        "history_unavailable",
    );
    let mut epoch = fixture.binding.clone();
    epoch.source_epoch = MAX_EPOCH + 1;
    assert_error(
        fixture
            .store
            .capture(capture(&epoch, &fixture.slot, "old"), "new"),
        "history_unavailable",
    );
    for value in [
        serde_json::json!({"action":"restore","projectId":fixture.binding.project_id}),
        serde_json::json!({"action":"list","projectId":fixture.binding.project_id,"path":"main.typ"}),
        serde_json::json!({"action":"list","projectId":fixture.binding.project_id,"observedRoot":{"dev":1,"ino":"2"}}),
        serde_json::json!({"action":"list","projectId":fixture.binding.project_id,"observedRoot":{"dev":"01","ino":"2"}}),
    ] {
        assert!(serde_json::from_value::<HistoryQuery>(value).is_err());
    }
    let mut source = serde_json::to_value(&fixture.binding).unwrap();
    source["savedVersion"] = serde_json::json!(Uuid::new_v4().to_string());
    assert!(serde_json::from_value::<SourceBinding>(source).is_err());
    assert_eq!(disk(&fixture.state), before);
}

#[test]
fn exact_structural_catalog_limits_are_observable_and_over_limit_files_are_preserved() {
    for kind in ["sources", "namespaces", "retired"] {
        let fixture = Fixture::new();
        let mut catalog = fixture.catalog();
        // Valid private metadata left after producer cleanup need not have a listed version.
        if kind == "sources" {
            let namespace_id = Uuid::new_v4().to_string();
            catalog.namespaces.push(Namespace {
                id: namespace_id.clone(),
                project_id: fixture.binding.project_id.clone(),
                root: fixture.binding.root,
            });
            for index in 0..MAX_BINDINGS {
                catalog.sources.push(Source {
                    id: Uuid::new_v4().to_string(),
                    namespace_id: namespace_id.clone(),
                    path: format!("chapter-{index}.typ"),
                    epoch: 0,
                });
            }
        } else if kind == "namespaces" {
            for index in 0..MAX_BINDINGS {
                catalog.namespaces.push(Namespace {
                    id: Uuid::new_v4().to_string(),
                    project_id: fixture.binding.project_id.clone(),
                    root: RootObservation {
                        dev: 1,
                        ino: index as u64,
                    },
                });
            }
        } else {
            for _ in 0..MAX_RECORDS {
                catalog.retired.push(Retired {
                    event_id: Uuid::new_v4().to_string(),
                    sha256: hash(b""),
                    bytes: 0,
                    origin: RetirementOrigin::Retention,
                });
            }
        }
        let path = fixture.state.join("history-v1/catalog.json");
        let raw = serde_json::to_vec(&catalog).unwrap();
        assert!(raw.len() <= MAX_CATALOG);
        fs::write(&path, raw).unwrap();
        let before = disk(&fixture.state);
        let capability =
            Dir::open_ambient_dir(&fixture.state, cap_std::ambient_authority()).unwrap();
        assert!(HistoryStore::open(capability, Some(fixture.store_id))
            .unwrap()
            .is_some());
        assert!(list(&fixture.store, &fixture.binding, None, None, None)
            .unwrap()
            .items
            .is_empty());
        assert_eq!(disk(&fixture.state), before);
        if kind == "sources" {
            catalog.sources.push(Source {
                id: Uuid::new_v4().to_string(),
                namespace_id: catalog.namespaces[0].id.clone(),
                path: "over-limit.typ".into(),
                epoch: 0,
            });
        } else if kind == "namespaces" {
            catalog.namespaces.push(Namespace {
                id: Uuid::new_v4().to_string(),
                project_id: fixture.binding.project_id.clone(),
                root: RootObservation { dev: 2, ino: 0 },
            });
        } else {
            catalog.retired.push(Retired {
                event_id: Uuid::new_v4().to_string(),
                sha256: hash(b""),
                bytes: 0,
                origin: RetirementOrigin::Retention,
            });
        }
        fs::write(path, serde_json::to_vec(&catalog).unwrap()).unwrap();
        assert_unavailable_preserves(&fixture);
    }
}

#[test]
fn oversized_malformed_or_extended_catalog_files_are_not_reset_or_partially_adopted() {
    let fixture = Fixture::new();
    let path = fixture.state.join("history-v1/catalog.json");
    let valid = fs::read(&path).unwrap();
    let mut extended: serde_json::Value = serde_json::from_slice(&valid).unwrap();
    extended["remoteSourcePath"] = serde_json::json!("outside.typ");
    let mut wrong_schema: serde_json::Value = serde_json::from_slice(&valid).unwrap();
    wrong_schema["schema"] = serde_json::json!(4);
    for bytes in [
        vec![b' '; MAX_CATALOG + 1],
        b"{incomplete".to_vec(),
        serde_json::to_vec(&extended).unwrap(),
        serde_json::to_vec(&wrong_schema).unwrap(),
    ] {
        fs::write(&path, &bytes).unwrap();
        assert_unavailable_preserves(&fixture);
        assert_eq!(fs::read(&path).unwrap(), bytes);
    }
}

#[test]
fn durably_observed_unavailable_clock_is_not_replaced_on_recovery_or_completion() {
    let mut fixture = Fixture::new();
    let intent = fixture.capture("old", "saved");
    let journal = journal(&intent);
    let reference = fixture.store.prepare(&intent, &journal).unwrap();
    arm(
        &mut fixture.store,
        &fixture.binding,
        &fixture.slot,
        &reference,
        &journal,
    );
    let original = fixture
        .store
        .finalize(
            &reference,
            &applied(&fixture.binding, &fixture.slot, "saved", &hash(OWNERSHIP)),
            &journal,
            false,
        )
        .unwrap();
    let mut catalog = fixture.catalog();
    match &mut catalog.records[0].state {
        Stage::Committed {
            recorded_at_ms,
            recorded_at_observed,
            ..
        } => {
            assert!(*recorded_at_observed);
            // Represent a real committed event whose first retained clock observation was unavailable.
            *recorded_at_ms = None;
        }
        Stage::Prepared { .. } => panic!("the native event must already be committed"),
    }
    fs::write(
        fixture.state.join("history-v1/catalog.json"),
        serde_json::to_vec(&catalog).unwrap(),
    )
    .unwrap();
    fixture.reopen();
    let before = disk(&fixture.state);
    let replay = fixture
        .store
        .finalize(
            &reference,
            &applied(&fixture.binding, &fixture.slot, "saved", &hash(OWNERSHIP)),
            &journal,
            true,
        )
        .unwrap();
    assert_eq!(replay.version_id, original.version_id);
    assert_eq!(replay.sequence, original.sequence);
    assert_eq!(replay.captured_at_ms, original.captured_at_ms);
    assert_eq!(replay.recorded_at_ms, None);
    assert!(!replay.after_recovery);
    assert!(!replay.clock_adjusted);
    assert_eq!(disk(&fixture.state), before);
    complete(
        &mut fixture.store,
        &reference,
        &fixture.binding,
        &fixture.slot,
        &journal,
    );
    assert_eq!(
        read_version(&fixture.store, &replay)
            .unwrap()
            .version
            .recorded_at_ms,
        None
    );
}

#[test]
fn interrupted_clock_observation_publication_keeps_first_retained_confirmation_and_blocks_early_completion(
) {
    let mut fixture = Fixture::new();
    let intent = fixture.capture("old", "saved");
    let journal = journal(&intent);
    let reference = fixture.store.prepare(&intent, &journal).unwrap();
    arm(
        &mut fixture.store,
        &fixture.binding,
        &fixture.slot,
        &reference,
        &journal,
    );
    fixture.store.failure = Some(FailurePoint::AfterCatalogRename);
    assert_error(
        fixture.store.finalize(
            &reference,
            &applied(&fixture.binding, &fixture.slot, "saved", &hash(OWNERSHIP)),
            &journal,
            false,
        ),
        "outcome_unknown",
    );
    fixture.reopen();
    assert!(matches!(
        fixture.catalog().records[0].state,
        Stage::Committed {
            recorded_at_observed: false,
            recorded_at_ms: None,
            pinned: true,
            sequence: 1,
            ..
        }
    ));
    let before = disk(&fixture.state);
    let journal_sha256 = hash(&journal);
    assert_error(
        fixture.store.complete(
            &reference,
            &fixture.binding,
            &fixture.slot,
            &ProducerCompletion {
                journal_sha256: &journal_sha256,
                committed_receipt_fingerprint: None,
            },
        ),
        "history_unavailable",
    );
    assert_eq!(
        disk(&fixture.state),
        before,
        "unconfirmed publication cannot release its completion pin"
    );
    fixture.store.failure = Some(FailurePoint::AfterCatalogRename);
    assert_error(
        fixture.store.finalize(
            &reference,
            &applied(&fixture.binding, &fixture.slot, "saved", &hash(OWNERSHIP)),
            &journal,
            true,
        ),
        "outcome_unknown",
    );
    fixture.reopen();
    let catalog = fixture.catalog();
    assert!(matches!(
        catalog.records[0].state,
        Stage::Committed {
            recorded_at_observed: true,
            recorded_at_ms: Some(_),
            pinned: true,
            sequence: 1,
            after_recovery: true,
            ..
        }
    ));
    let confirmed = catalog.summary(&catalog.records[0]).unwrap();
    let before = disk(&fixture.state);
    let replay = fixture
        .store
        .finalize(
            &reference,
            &applied(&fixture.binding, &fixture.slot, "saved", &hash(OWNERSHIP)),
            &journal,
            false,
        )
        .unwrap();
    assert_eq!(replay.version_id, reference.event_id);
    assert_eq!(replay.sequence, "1");
    assert_eq!(replay.captured_at_ms, Some(1_700_000_000_000));
    assert_eq!(
        serde_json::to_value(&replay).unwrap(),
        serde_json::to_value(&confirmed).unwrap()
    );
    assert_eq!(
        disk(&fixture.state),
        before,
        "a retained confirmation is resynchronized without resampling its clock"
    );
    complete(
        &mut fixture.store,
        &reference,
        &fixture.binding,
        &fixture.slot,
        &journal,
    );
    assert_eq!(
        read_version(&fixture.store, &replay).unwrap().content,
        "saved"
    );
}

#[test]
fn corrupt_retention_victim_blocks_prepare_before_any_new_private_publication() {
    let mut fixture = Fixture::new();
    let (_, oldest_reference, _, _) = save(
        &mut fixture.store,
        &fixture.binding,
        &fixture.slot,
        "baseline",
        "version 0",
    );
    let mut previous = "version 0".to_owned();
    let mut latest = None;
    for index in 1..MAX_VERSIONS {
        let current = format!("version {index}");
        latest = Some(
            save(
                &mut fixture.store,
                &fixture.binding,
                &fixture.slot,
                &previous,
                &current,
            )
            .3,
        );
        previous = current;
    }
    assert_eq!(fixture.catalog().records.len(), MAX_VERSIONS);
    assert!(fixture.catalog().retired.is_empty());
    let victim = fixture.blob(&oldest_reference);
    let original = fs::read(&victim).unwrap();
    let corrupt = b"tampered!";
    assert_eq!(
        original.len(),
        corrupt.len(),
        "the corruption must pass the metadata size check"
    );
    fs::write(&victim, corrupt).unwrap();
    let before = disk(&fixture.state);
    let catalog_before = fs::read(fixture.state.join("history-v1/catalog.json")).unwrap();
    let intent = fixture.capture(&previous, "version 32");
    let reference = intent.reference().unwrap();
    assert_error(
        fixture.store.prepare(&intent, &journal(&intent)),
        "history_unavailable",
    );
    assert_eq!(
        fs::read(fixture.state.join("history-v1/catalog.json")).unwrap(),
        catalog_before
    );
    assert!(!fixture.blob(&reference).exists());
    assert_eq!(fs::read(&victim).unwrap(), corrupt);
    assert_eq!(
        read_version(&fixture.store, &latest.unwrap())
            .unwrap()
            .content,
        previous
    );
    assert_eq!(
        disk(&fixture.state),
        before,
        "admission refusal and a valid saved-version query preserve every private byte"
    );
}

#[test]
fn restarted_unarmed_reservation_lookup_is_pure_and_cannot_authorize_recovery() {
    let mut fixture = Fixture::new();
    let receipt = hash(b"native producer receipt identity");
    let mut native = capture(&fixture.binding, &fixture.slot, "old");
    native.receipt_fingerprint = Some(receipt.clone());
    let intent = fixture
        .store
        .capture(native, "new e\u{301} 🧪\r\n")
        .unwrap();
    let journal = journal(&intent);
    let reference = fixture.store.prepare(&intent, &journal).unwrap();
    fixture.reopen();
    let before = disk(&fixture.state);
    let reservation = fixture
        .store
        .producer_reservation(&fixture.binding, &fixture.slot)
        .unwrap()
        .unwrap();
    assert_eq!(reservation.reference(), &reference);
    assert_eq!(reservation.binding(), &fixture.binding);
    assert_eq!(reservation.journal_sha256(), hash(&journal));
    assert_eq!(reservation.receipt_fingerprint(), Some(receipt.as_str()));
    assert_eq!(reservation.phase(), ProducerPhase::Unarmed);
    assert!(matches!(
        fixture.catalog().records[0].state,
        Stage::Prepared { armed: false }
    ));
    assert_error(
        fixture
            .store
            .validate_journal(&reference, &fixture.binding, &fixture.slot, &journal),
        "history_unavailable",
    );
    assert_error(
        fixture.store.finalize(
            &reference,
            &applied(
                &fixture.binding,
                &fixture.slot,
                &intent.content,
                &hash(OWNERSHIP),
            ),
            &journal,
            true,
        ),
        "history_unavailable",
    );
    for changed in [
        SourceBinding {
            path: "different.typ".into(),
            ..fixture.binding.clone()
        },
        SourceBinding {
            source_epoch: 1,
            ..fixture.binding.clone()
        },
        SourceBinding {
            root: RootObservation {
                dev: fixture.binding.root.dev,
                ino: fixture.binding.root.ino + 1,
            },
            ..fixture.binding.clone()
        },
        SourceBinding {
            project_id: Uuid::new_v4().to_string(),
            ..fixture.binding.clone()
        },
    ] {
        let changed_slot = fixture.slot_for(&changed);
        let found = fixture
            .store
            .producer_reservation(&changed, &changed_slot)
            .unwrap();
        if changed_slot == fixture.slot {
            assert_eq!(
                found.unwrap().binding(),
                &fixture.binding,
                "a slot alias reports its original binding without adopting the caller"
            );
        } else {
            assert!(found.is_none());
        }
    }
    assert!(list(&fixture.store, &fixture.binding, None, None, None)
        .unwrap()
        .items
        .is_empty());
    assert_eq!(fixture.catalog().next_sequence, 1);
    assert_eq!(disk(&fixture.state), before);
}

#[test]
fn arming_rechecks_exact_proof_survives_uncertainty_and_cannot_downgrade_or_abort() {
    let mut fixture = Fixture::new();
    let intent = fixture.capture("old", "saved");
    let journal = journal(&intent);
    let reference = fixture.store.prepare(&intent, &journal).unwrap();
    let reservation = fixture
        .store
        .producer_reservation(&fixture.binding, &fixture.slot)
        .unwrap()
        .unwrap();
    let before = disk(&fixture.state);
    assert_error(
        fixture.store.arm_source_effects(
            &reservation,
            &fixture.binding,
            &fixture.slot,
            b"different journal",
        ),
        "history_unavailable",
    );
    let mut wrong_binding = reservation.clone();
    wrong_binding.record.core.binding.path = "another.typ".into();
    let mut wrong_receipt = reservation.clone();
    wrong_receipt.record.core.receipt_fingerprint = Some(hash(b"another receipt"));
    let mut wrong_store = reservation.clone();
    wrong_store.record.core.store_id = Uuid::new_v4().to_string();
    for changed in [wrong_binding, wrong_receipt, wrong_store] {
        assert_error(
            fixture
                .store
                .arm_source_effects(&changed, &fixture.binding, &fixture.slot, &journal),
            "history_unavailable",
        );
        assert_error(
            fixture
                .store
                .abort_unapplied(&changed, &fixture.binding, &fixture.slot),
            "history_unavailable",
        );
    }
    assert_eq!(disk(&fixture.state), before);
    fixture.store.failure = Some(FailurePoint::AfterCatalogRename);
    assert_error(
        fixture
            .store
            .arm_source_effects(&reservation, &fixture.binding, &fixture.slot, &journal),
        "outcome_unknown",
    );
    fixture.reopen();
    let armed = fixture
        .store
        .producer_reservation(&fixture.binding, &fixture.slot)
        .unwrap()
        .unwrap();
    assert_eq!(armed.phase(), ProducerPhase::Armed);
    assert!(matches!(
        fixture.catalog().records[0].state,
        Stage::Prepared { armed: true }
    ));
    let before = disk(&fixture.state);
    fixture
        .store
        .arm_source_effects(&reservation, &fixture.binding, &fixture.slot, &journal)
        .unwrap();
    fixture
        .store
        .arm_source_effects(&armed, &fixture.binding, &fixture.slot, &journal)
        .unwrap();
    assert_eq!(fixture.store.prepare(&intent, &journal).unwrap(), reference);
    assert_error(
        fixture
            .store
            .abort_unapplied(&reservation, &fixture.binding, &fixture.slot),
        "history_unavailable",
    );
    assert_error(
        fixture
            .store
            .abort_unapplied(&armed, &fixture.binding, &fixture.slot),
        "history_unavailable",
    );
    fixture
        .store
        .validate_journal(&reference, &fixture.binding, &fixture.slot, &journal)
        .unwrap();
    assert_eq!(disk(&fixture.state), before);
    let version = fixture
        .store
        .finalize(
            &reference,
            &applied(&fixture.binding, &fixture.slot, "saved", &hash(OWNERSHIP)),
            &journal,
            false,
        )
        .unwrap();
    let committed = fixture
        .store
        .producer_reservation(&fixture.binding, &fixture.slot)
        .unwrap()
        .unwrap();
    assert_eq!(committed.phase(), ProducerPhase::CommittedPinned);
    let before = disk(&fixture.state);
    assert_error(
        fixture
            .store
            .abort_unapplied(&committed, &fixture.binding, &fixture.slot),
        "history_unavailable",
    );
    assert_eq!(disk(&fixture.state), before);
    complete(
        &mut fixture.store,
        &reference,
        &fixture.binding,
        &fixture.slot,
        &journal,
    );
    assert!(fixture
        .store
        .producer_reservation(&fixture.binding, &fixture.slot)
        .unwrap()
        .is_none());
    let before = disk(&fixture.state);
    assert_error(
        fixture
            .store
            .arm_source_effects(&reservation, &fixture.binding, &fixture.slot, &journal),
        "history_unavailable",
    );
    assert_error(
        fixture
            .store
            .abort_unapplied(&reservation, &fixture.binding, &fixture.slot),
        "history_unavailable",
    );
    assert_eq!(
        read_version(&fixture.store, &version).unwrap().content,
        "saved"
    );
    assert_eq!(disk(&fixture.state), before);
}

#[test]
fn explicit_unarmed_abort_keeps_known_present_or_missing_payload_until_maintenance() {
    for missing_blob in [false, true] {
        let mut fixture = Fixture::new();
        let project = fixture.temporary.path().join("project");
        fs::create_dir(&project).unwrap();
        let old = "old e\u{301} source\r\n";
        fs::write(project.join("main.typ"), old.as_bytes()).unwrap();
        fs::write(
            project.join("main.typ.undertree-review.json"),
            b"previous review bytes",
        )
        .unwrap();
        fs::write(project.join("pending-ownership.json"), OWNERSHIP).unwrap();
        let project_before = disk(&project);
        let intent = fixture.capture(old, "never applied 🧪\r\n");
        let journal_bytes = journal(&intent);
        let reference = intent.reference().unwrap();
        if missing_blob {
            fixture.store.failure = Some(FailurePoint::AfterCatalogRename);
            assert_error(
                fixture.store.prepare(&intent, &journal_bytes),
                "outcome_unknown",
            );
        } else {
            fixture.store.prepare(&intent, &journal_bytes).unwrap();
        }
        fixture.reopen();
        let reservation = fixture
            .store
            .producer_reservation(&fixture.binding, &fixture.slot)
            .unwrap()
            .unwrap();
        assert_eq!(reservation.phase(), ProducerPhase::Unarmed);
        assert_eq!(fixture.blob(&reference).exists(), !missing_blob);
        assert_eq!(
            fixture
                .store
                .abort_unapplied(&reservation, &fixture.binding, &fixture.slot)
                .unwrap(),
            AbortDisposition::AbortedPendingMaintenance
        );
        let catalog = fixture.catalog();
        assert!(catalog.records.is_empty());
        assert_eq!(catalog.next_sequence, 1);
        assert_eq!(catalog.retired.len(), 1);
        assert_eq!(catalog.retired[0].event_id, reference.event_id);
        assert!(
            matches!(&catalog.retired[0].origin, RetirementOrigin::Unapplied { record } if record.reference == reference && matches!(record.state, Stage::Prepared { armed: false }))
        );
        assert_eq!(fixture.blob(&reference).exists(), !missing_blob);
        fixture.reopen();
        let aborted = fixture
            .store
            .producer_reservation(&fixture.binding, &fixture.slot)
            .unwrap()
            .unwrap();
        assert_eq!(aborted.phase(), ProducerPhase::AbortedPendingMaintenance);
        let before = disk(&fixture.state);
        assert_eq!(
            fixture
                .store
                .abort_unapplied(&reservation, &fixture.binding, &fixture.slot)
                .unwrap(),
            AbortDisposition::AlreadyAbortedPendingMaintenance
        );
        assert_eq!(
            fixture
                .store
                .abort_unapplied(&aborted, &fixture.binding, &fixture.slot)
                .unwrap(),
            AbortDisposition::AlreadyAbortedPendingMaintenance
        );
        assert_error(
            fixture.store.arm_source_effects(
                &reservation,
                &fixture.binding,
                &fixture.slot,
                &journal_bytes,
            ),
            "history_unavailable",
        );
        assert_error(
            fixture.store.validate_journal(
                &reference,
                &fixture.binding,
                &fixture.slot,
                &journal_bytes,
            ),
            "history_unavailable",
        );
        assert_error(
            fixture.store.finalize(
                &reference,
                &applied(
                    &fixture.binding,
                    &fixture.slot,
                    &intent.content,
                    &hash(OWNERSHIP),
                ),
                &journal_bytes,
                true,
            ),
            "history_unavailable",
        );
        assert_error(
            fixture.store.prepare(&intent, &journal_bytes),
            "history_unavailable",
        );
        let fresh = fixture.capture(old, "new explicit request");
        assert_error(
            fixture.store.prepare(&fresh, &journal(&fresh)),
            "history_quota",
        );
        assert!(list(&fixture.store, &fixture.binding, None, None, None)
            .unwrap()
            .items
            .is_empty());
        assert_eq!(disk(&fixture.state), before);
        assert_eq!(disk(&project), project_before);
        fixture.store.maintain().unwrap();
        assert!(!fixture.blob(&reference).exists());
        assert!(fixture.catalog().retired.is_empty());
        assert!(fixture
            .store
            .producer_reservation(&fixture.binding, &fixture.slot)
            .unwrap()
            .is_none());
        let before = disk(&fixture.state);
        assert_error(
            fixture
                .store
                .abort_unapplied(&reservation, &fixture.binding, &fixture.slot),
            "history_unavailable",
        );
        assert_error(
            fixture.store.prepare(&intent, &journal_bytes),
            "history_unavailable",
        );
        assert_eq!(disk(&fixture.state), before);
        let fresh = fixture.capture(old, "new explicit request");
        let fresh_journal_bytes = journal(&fresh);
        let fresh_reference = fixture.store.prepare(&fresh, &fresh_journal_bytes).unwrap();
        let before = disk(&fixture.state);
        assert_error(
            fixture.store.arm_source_effects(
                &reservation,
                &fixture.binding,
                &fixture.slot,
                &journal_bytes,
            ),
            "history_unavailable",
        );
        assert_error(
            fixture
                .store
                .abort_unapplied(&reservation, &fixture.binding, &fixture.slot),
            "history_unavailable",
        );
        assert_eq!(disk(&fixture.state), before);
        arm(
            &mut fixture.store,
            &fixture.binding,
            &fixture.slot,
            &fresh_reference,
            &fresh_journal_bytes,
        );
        assert_eq!(
            fixture.catalog().next_sequence,
            1,
            "an aborted event is never a saved baseline"
        );
        assert_eq!(
            fixture
                .store
                .producer_reservation(&fixture.binding, &fixture.slot)
                .unwrap()
                .unwrap()
                .phase(),
            ProducerPhase::Armed
        );
        assert_eq!(disk(&project), project_before);
    }
}

#[test]
fn missing_armed_payload_cannot_be_recreated_by_prepare_or_cancelled_as_unapplied() {
    let mut fixture = Fixture::new();
    let intent = fixture.capture("old", "saved");
    let journal = journal(&intent);
    let reference = fixture.store.prepare(&intent, &journal).unwrap();
    arm(
        &mut fixture.store,
        &fixture.binding,
        &fixture.slot,
        &reference,
        &journal,
    );
    let reservation = fixture
        .store
        .producer_reservation(&fixture.binding, &fixture.slot)
        .unwrap()
        .unwrap();
    fs::remove_file(fixture.blob(&reference)).unwrap();
    assert_unavailable_preserves(&fixture);
    let before = disk(&fixture.state);
    assert_error(
        fixture.store.prepare(&intent, &journal),
        "history_unavailable",
    );
    assert_error(
        fixture
            .store
            .arm_source_effects(&reservation, &fixture.binding, &fixture.slot, &journal),
        "history_unavailable",
    );
    assert_error(
        fixture
            .store
            .abort_unapplied(&reservation, &fixture.binding, &fixture.slot),
        "history_unavailable",
    );
    assert!(!fixture.blob(&reference).exists());
    assert_eq!(disk(&fixture.state), before);
}

#[test]
fn interrupted_abort_preserves_unpublished_evidence_or_retries_the_exact_published_abort() {
    for failure in [
        FailurePoint::BeforeCatalogRename,
        FailurePoint::AfterCatalogRename,
    ] {
        let mut fixture = Fixture::new();
        let intent = fixture.capture("old", "new");
        let journal = journal(&intent);
        let reference = fixture.store.prepare(&intent, &journal).unwrap();
        let reservation = fixture
            .store
            .producer_reservation(&fixture.binding, &fixture.slot)
            .unwrap()
            .unwrap();
        let old_catalog = fs::read(fixture.state.join("history-v1/catalog.json")).unwrap();
        fixture.store.failure = Some(failure);
        assert_error(
            fixture
                .store
                .abort_unapplied(&reservation, &fixture.binding, &fixture.slot),
            "outcome_unknown",
        );
        assert_eq!(fs::read(fixture.blob(&reference)).unwrap(), b"new");
        if failure == FailurePoint::BeforeCatalogRename {
            assert_eq!(
                fs::read(fixture.state.join("history-v1/catalog.json")).unwrap(),
                old_catalog
            );
            assert!(fixture.state.join("history-v1/catalog.next").is_file());
            let before = disk(&fixture.state);
            assert_error(
                fixture
                    .store
                    .producer_reservation(&fixture.binding, &fixture.slot),
                "history_unavailable",
            );
            assert_error(
                fixture
                    .store
                    .abort_unapplied(&reservation, &fixture.binding, &fixture.slot),
                "history_unavailable",
            );
            assert_error(
                fixture.store.arm_source_effects(
                    &reservation,
                    &fixture.binding,
                    &fixture.slot,
                    &journal,
                ),
                "history_unavailable",
            );
            assert_eq!(disk(&fixture.state), before);
        } else {
            fixture.reopen();
            let aborted = fixture
                .store
                .producer_reservation(&fixture.binding, &fixture.slot)
                .unwrap()
                .unwrap();
            assert_eq!(aborted.phase(), ProducerPhase::AbortedPendingMaintenance);
            let before = disk(&fixture.state);
            assert_eq!(
                fixture
                    .store
                    .abort_unapplied(&reservation, &fixture.binding, &fixture.slot)
                    .unwrap(),
                AbortDisposition::AlreadyAbortedPendingMaintenance
            );
            assert_eq!(fixture.catalog().retired.len(), 1);
            assert!(fixture.catalog().records.is_empty());
            assert_error(
                fixture.store.arm_source_effects(
                    &reservation,
                    &fixture.binding,
                    &fixture.slot,
                    &journal,
                ),
                "history_unavailable",
            );
            assert_eq!(disk(&fixture.state), before);
            fixture.store.maintain().unwrap();
            let before = disk(&fixture.state);
            assert_error(
                fixture
                    .store
                    .abort_unapplied(&reservation, &fixture.binding, &fixture.slot),
                "history_unavailable",
            );
            assert_eq!(disk(&fixture.state), before);
        }
    }
}

#[test]
fn corrupt_linked_or_unknown_unapplied_evidence_is_preserved_before_and_after_abort() {
    for aborted in [false, true] {
        for corruption in ["content", "hardlink", "unknown"] {
            let mut fixture = Fixture::new();
            let intent = fixture.capture("old", "new");
            let journal = journal(&intent);
            let reference = fixture.store.prepare(&intent, &journal).unwrap();
            let reservation = fixture
                .store
                .producer_reservation(&fixture.binding, &fixture.slot)
                .unwrap()
                .unwrap();
            if aborted {
                fixture
                    .store
                    .abort_unapplied(&reservation, &fixture.binding, &fixture.slot)
                    .unwrap();
            }
            let external = fixture.temporary.path().join("other-owner");
            fs::write(&external, b"other source").unwrap();
            match corruption {
                "content" => fs::write(fixture.blob(&reference), b"bad").unwrap(),
                "hardlink" => {
                    fs::remove_file(&external).unwrap();
                    fs::hard_link(fixture.blob(&reference), &external).unwrap();
                }
                "unknown" => fs::write(
                    fixture.state.join("history-v1/unowned-data"),
                    b"unowned evidence",
                )
                .unwrap(),
                _ => unreachable!(),
            }
            let external_before = fs::read(&external).unwrap();
            let before = disk(&fixture.state);
            assert_error(
                fixture
                    .store
                    .abort_unapplied(&reservation, &fixture.binding, &fixture.slot),
                "history_unavailable",
            );
            assert_error(
                fixture.store.arm_source_effects(
                    &reservation,
                    &fixture.binding,
                    &fixture.slot,
                    &journal,
                ),
                "history_unavailable",
            );
            if aborted {
                assert_error(fixture.store.maintain(), "history_unavailable");
            }
            assert_eq!(disk(&fixture.state), before);
            assert_eq!(fs::read(&external).unwrap(), external_before);
        }
    }
}

#[cfg(unix)]
#[test]
fn symlinked_unapplied_payload_never_arms_aborts_or_deletes_its_external_target() {
    use std::os::unix::fs::symlink;
    for aborted in [false, true] {
        let mut fixture = Fixture::new();
        let intent = fixture.capture("old", "new");
        let journal = journal(&intent);
        let reference = fixture.store.prepare(&intent, &journal).unwrap();
        let reservation = fixture
            .store
            .producer_reservation(&fixture.binding, &fixture.slot)
            .unwrap()
            .unwrap();
        if aborted {
            fixture
                .store
                .abort_unapplied(&reservation, &fixture.binding, &fixture.slot)
                .unwrap();
        }
        let external = fixture.temporary.path().join("other-owner");
        fs::write(&external, b"new").unwrap();
        fs::remove_file(fixture.blob(&reference)).unwrap();
        symlink(&external, fixture.blob(&reference)).unwrap();
        let before = disk(&fixture.state);
        assert_error(
            fixture
                .store
                .abort_unapplied(&reservation, &fixture.binding, &fixture.slot),
            "history_unavailable",
        );
        assert_error(
            fixture.store.arm_source_effects(
                &reservation,
                &fixture.binding,
                &fixture.slot,
                &journal,
            ),
            "history_unavailable",
        );
        if aborted {
            assert_error(fixture.store.maintain(), "history_unavailable");
        }
        assert_eq!(disk(&fixture.state), before);
        assert_eq!(fs::read(external).unwrap(), b"new");
    }
}

#[test]
fn legacy_schema_or_missing_explicit_effect_phase_is_never_inferred_or_migrated() {
    let mut fixture = Fixture::new();
    let intent = fixture.capture("old", "new");
    let journal = journal(&intent);
    fixture.store.prepare(&intent, &journal).unwrap();
    let reservation = fixture
        .store
        .producer_reservation(&fixture.binding, &fixture.slot)
        .unwrap()
        .unwrap();
    let raw = fs::read(fixture.state.join("history-v1/catalog.json")).unwrap();
    let base: serde_json::Value = serde_json::from_slice(&raw).unwrap();
    assert_eq!(base["schema"], 3);
    let mut legacy = base.clone();
    legacy["schema"] = serde_json::json!(1);
    let mut missing_phase = base.clone();
    missing_phase["records"][0]["state"]
        .as_object_mut()
        .unwrap()
        .remove("armed");
    let mut wrong_type = base.clone();
    wrong_type["records"][0]["state"]["armed"] = serde_json::json!("unarmed");
    for value in [legacy, missing_phase, wrong_type] {
        fs::write(
            fixture.state.join("history-v1/catalog.json"),
            serde_json::to_vec(&value).unwrap(),
        )
        .unwrap();
        assert_unavailable_preserves(&fixture);
        let before = disk(&fixture.state);
        assert_error(
            fixture.store.arm_source_effects(
                &reservation,
                &fixture.binding,
                &fixture.slot,
                &journal,
            ),
            "history_unavailable",
        );
        assert_error(
            fixture
                .store
                .abort_unapplied(&reservation, &fixture.binding, &fixture.slot),
            "history_unavailable",
        );
        assert_eq!(disk(&fixture.state), before);
    }
    fs::write(fixture.state.join("history-v1/catalog.json"), raw).unwrap();
    fixture
        .store
        .abort_unapplied(&reservation, &fixture.binding, &fixture.slot)
        .unwrap();
    let raw = fs::read(fixture.state.join("history-v1/catalog.json")).unwrap();
    let base: serde_json::Value = serde_json::from_slice(&raw).unwrap();
    let mut missing_origin = base.clone();
    missing_origin["retired"][0]
        .as_object_mut()
        .unwrap()
        .remove("origin");
    let mut armed_origin = base.clone();
    armed_origin["retired"][0]["origin"]["record"]["state"]["armed"] = serde_json::json!(true);
    for value in [missing_origin, armed_origin] {
        fs::write(
            fixture.state.join("history-v1/catalog.json"),
            serde_json::to_vec(&value).unwrap(),
        )
        .unwrap();
        assert_unavailable_preserves(&fixture);
    }
}

#[test]
fn catalog_admission_reserves_every_outstanding_unarmed_abort_before_effects() {
    let mut fixture = Fixture::new();
    let prefix = vec!["b".repeat(240); 16].join("/");
    let mut reservations = Vec::new();
    let mut refused = false;
    for index in 0..=MAX_BINDINGS {
        let mut binding = fixture.binding.clone();
        binding.path = format!("{prefix}/chapter-{index}.typ");
        let slot = fixture.slot_for(&binding);
        let intent = fixture
            .store
            .capture(capture(&binding, &slot, "old"), "saved")
            .unwrap();
        let journal = journal(&intent);
        let before = disk(&fixture.state);
        match fixture.store.prepare(&intent, &journal) {
            Ok(reference) => {
                let reservation = fixture
                    .store
                    .producer_reservation(&binding, &slot)
                    .unwrap()
                    .unwrap();
                assert_eq!(reservation.reference(), &reference);
                assert_eq!(reservation.phase(), ProducerPhase::Unarmed);
                reservations.push((reservation, slot));
            }
            Err(error) => {
                assert_eq!(error.code, "history_quota");
                assert_eq!(disk(&fixture.state), before);
                assert!(!fixture.blob(&intent.reference().unwrap()).exists());
                refused = true;
                break;
            }
        }
    }
    assert!(refused && !reservations.is_empty() && reservations.len() < MAX_BINDINGS);
    assert_eq!(fixture.catalog().next_sequence, 1);
    for (reservation, slot) in &reservations {
        assert_eq!(
            fixture
                .store
                .abort_unapplied(reservation, reservation.binding(), slot)
                .unwrap(),
            AbortDisposition::AbortedPendingMaintenance
        );
        assert!(
            fs::metadata(fixture.state.join("history-v1/catalog.json"))
                .unwrap()
                .len()
                <= MAX_CATALOG as u64
        );
    }
    let catalog = fixture.catalog();
    assert!(catalog.records.is_empty());
    assert_eq!(catalog.retired.len(), reservations.len());
    assert!(catalog
        .retired
        .iter()
        .all(|retired| matches!(retired.origin, RetirementOrigin::Unapplied { .. })));
    assert_eq!(catalog.payload_bytes(), reservations.len() as u64 * 5);
    assert_eq!(catalog.next_sequence, 1);
    assert!(list(&fixture.store, &fixture.binding, None, None, None)
        .unwrap()
        .items
        .is_empty());
    fixture.store.maintain().unwrap();
    assert!(fixture.catalog().retired.is_empty());
    for (reservation, slot) in &reservations {
        assert!(!fixture.blob(reservation.reference()).exists());
        assert!(fixture
            .store
            .producer_reservation(reservation.binding(), slot)
            .unwrap()
            .is_none());
    }
}

#[test]
fn source_slot_aliases_report_original_binding_without_authorizing_foreign_producers() {
    let mut fixture = Fixture::new();
    let intent = fixture.capture("old", "saved");
    let journal_bytes = journal(&intent);
    let reference = fixture.store.prepare(&intent, &journal_bytes).unwrap();
    let aliases = [
        SourceBinding {
            project_id: Uuid::new_v4().to_string(),
            ..fixture.binding.clone()
        },
        SourceBinding {
            root: RootObservation {
                dev: fixture.binding.root.dev,
                ino: fixture.binding.root.ino + 1,
            },
            ..fixture.binding.clone()
        },
        SourceBinding {
            path: "another-root/chapters/main.typ".into(),
            ..fixture.binding.clone()
        },
        SourceBinding {
            source_epoch: 1,
            ..fixture.binding.clone()
        },
    ];
    for phase in [
        ProducerPhase::Unarmed,
        ProducerPhase::Armed,
        ProducerPhase::CommittedPinned,
    ] {
        if phase == ProducerPhase::Armed {
            arm(
                &mut fixture.store,
                &fixture.binding,
                &fixture.slot,
                &reference,
                &journal_bytes,
            );
        }
        if phase == ProducerPhase::CommittedPinned {
            fixture
                .store
                .finalize(
                    &reference,
                    &applied(&fixture.binding, &fixture.slot, "saved", &hash(OWNERSHIP)),
                    &journal_bytes,
                    false,
                )
                .unwrap();
        }
        let before = disk(&fixture.state);
        for alias in &aliases {
            let foreign = fixture
                .store
                .producer_reservation(alias, &fixture.slot)
                .unwrap()
                .unwrap();
            assert_eq!(foreign.reference(), &reference);
            assert_eq!(foreign.binding(), &fixture.binding);
            assert_eq!(foreign.phase(), phase);
            let competing = fixture
                .store
                .capture(capture(alias, &fixture.slot, "old"), "competing")
                .unwrap();
            assert_error(
                fixture.store.prepare(&competing, &journal(&competing)),
                "history_pending",
            );
            assert_error(
                fixture
                    .store
                    .arm_source_effects(&foreign, alias, &fixture.slot, &journal_bytes),
                "history_unavailable",
            );
            assert_error(
                fixture
                    .store
                    .abort_unapplied(&foreign, alias, &fixture.slot),
                "history_unavailable",
            );
            assert_error(
                fixture
                    .store
                    .validate_journal(&reference, alias, &fixture.slot, &journal_bytes),
                "history_unavailable",
            );
            assert_error(
                fixture.store.finalize(
                    &reference,
                    &applied(alias, &fixture.slot, "saved", &hash(OWNERSHIP)),
                    &journal_bytes,
                    false,
                ),
                "history_unavailable",
            );
            assert_error(
                fixture.store.complete(
                    &reference,
                    alias,
                    &fixture.slot,
                    &ProducerCompletion {
                        journal_sha256: &hash(&journal_bytes),
                        committed_receipt_fingerprint: None,
                    },
                ),
                "history_unavailable",
            );
        }
        assert_eq!(disk(&fixture.state), before);
    }
    complete(
        &mut fixture.store,
        &reference,
        &fixture.binding,
        &fixture.slot,
        &journal_bytes,
    );
    assert!(fixture.catalog().records[0].slot.is_none());
}

#[test]
fn atomic_source_replacement_keeps_its_slot_but_parent_replacement_never_adopts_pending_authority()
{
    let mut fixture = Fixture::new();
    let intent = fixture.capture("old", "saved");
    let journal_bytes = journal(&intent);
    let reference = fixture.store.prepare(&intent, &journal_bytes).unwrap();
    let old_inode = fixture.source_parent.metadata("main.typ").unwrap().ino();
    fixture
        .source_parent
        .write("replacement.typ", b"atomically replaced source")
        .unwrap();
    fixture
        .source_parent
        .rename("replacement.typ", &fixture.source_parent, "main.typ")
        .unwrap();
    assert_ne!(
        fixture.source_parent.metadata("main.typ").unwrap().ino(),
        old_inode
    );
    let replaced_file_slot =
        SourceSlot::from_held_parent(&fixture.source_parent, "main.typ").unwrap();
    assert_eq!(replaced_file_slot, fixture.slot);
    assert_eq!(
        fixture
            .store
            .producer_reservation(&fixture.binding, &replaced_file_slot)
            .unwrap()
            .unwrap()
            .reference(),
        &reference
    );
    let source_directory = fixture.temporary.path().join("sources");
    #[cfg(windows)]
    {
        let before = disk(&fixture.state);
        let error = fs::rename(
            &source_directory,
            fixture.temporary.path().join("displaced-sources"),
        )
        .unwrap_err();
        assert!(matches!(error.raw_os_error(), Some(5) | Some(32)));
        assert_eq!(
            fixture.source_parent.read("main.typ").unwrap(),
            b"atomically replaced source"
        );
        assert!(!fixture.temporary.path().join("displaced-sources").exists());
        assert_eq!(
            SourceSlot::from_held_parent(&fixture.source_parent, "main.typ").unwrap(),
            fixture.slot
        );
        let competing = fixture.capture("old", "competing");
        assert_error(
            fixture.store.prepare(&competing, &journal(&competing)),
            "history_pending",
        );
        assert_eq!(disk(&fixture.state), before);
    }
    #[cfg(not(windows))]
    {
        fs::rename(
            &source_directory,
            fixture.temporary.path().join("displaced-sources"),
        )
        .unwrap();
        fs::create_dir(&source_directory).unwrap();
        fs::write(
            source_directory.join("main.typ"),
            b"different parent source",
        )
        .unwrap();
        let new_parent =
            Dir::open_ambient_dir(&source_directory, cap_std::ambient_authority()).unwrap();
        let new_slot = SourceSlot::from_held_parent(&new_parent, "main.typ").unwrap();
        assert_ne!(new_slot, fixture.slot);
        let pending = fixture
            .store
            .producer_reservation(&fixture.binding, &new_slot)
            .unwrap()
            .unwrap();
        assert_eq!(
            pending.reference(),
            &reference,
            "the exact binding still fences a replaced parent"
        );
        let before = disk(&fixture.state);
        assert_error(
            fixture
                .store
                .arm_source_effects(&pending, &fixture.binding, &new_slot, &journal_bytes),
            "history_unavailable",
        );
        assert_error(
            fixture
                .store
                .abort_unapplied(&pending, &fixture.binding, &new_slot),
            "history_unavailable",
        );
        assert_error(
            fixture
                .store
                .validate_journal(&reference, &fixture.binding, &new_slot, &journal_bytes),
            "history_unavailable",
        );
        assert_error(
            fixture.store.finalize(
                &reference,
                &applied(&fixture.binding, &new_slot, "saved", &hash(OWNERSHIP)),
                &journal_bytes,
                false,
            ),
            "history_unavailable",
        );
        let competing = fixture
            .store
            .capture(capture(&fixture.binding, &new_slot, "old"), "competing")
            .unwrap();
        assert_error(
            fixture.store.prepare(&competing, &journal(&competing)),
            "history_pending",
        );
        assert_eq!(disk(&fixture.state), before);
        let metadata = new_parent.dir_metadata().unwrap();
        let unrelated = SourceBinding {
            project_id: Uuid::new_v4().to_string(),
            root: RootObservation {
                dev: metadata.dev(),
                ino: metadata.ino(),
            },
            path: "main.typ".into(),
            source_epoch: 0,
        };
        let independent = fixture
            .store
            .capture(capture(&unrelated, &new_slot, "old"), "independent")
            .unwrap();
        fixture
            .store
            .prepare(&independent, &journal(&independent))
            .unwrap();
        let before = disk(&fixture.state);
        assert_error(
            fixture
                .store
                .producer_reservation(&fixture.binding, &new_slot),
            "history_unavailable",
        );
        assert_eq!(fixture.store.producer_reservations().unwrap().len(), 2);
        assert_eq!(
            disk(&fixture.state),
            before,
            "two different hits are ambiguous rather than an alias adoption"
        );
    }
}

#[test]
fn pure_pending_enumeration_releases_full_slots_only_after_complete_or_abort_cleanup() {
    let mut fixture = Fixture::new();
    let mut events = Vec::new();
    for basename in ["main.typ", "armed.typ", "committed.typ", "aborted.typ"] {
        let binding = SourceBinding {
            path: format!("chapters/{basename}"),
            ..fixture.binding.clone()
        };
        let slot = fixture.slot_for(&binding);
        let intent = fixture
            .store
            .capture(capture(&binding, &slot, "old"), "saved")
            .unwrap();
        let journal_bytes = journal(&intent);
        let reference = fixture.store.prepare(&intent, &journal_bytes).unwrap();
        events.push((binding, slot, reference, journal_bytes));
    }
    for index in [1, 2] {
        let (binding, slot, reference, journal_bytes) = &events[index];
        arm(&mut fixture.store, binding, slot, reference, journal_bytes);
    }
    let (binding, slot, reference, journal_bytes) = &events[2];
    let saved = fixture
        .store
        .finalize(
            reference,
            &applied(binding, slot, "saved", &hash(OWNERSHIP)),
            journal_bytes,
            false,
        )
        .unwrap();
    let (aborted_binding, aborted_slot, _, _) = &events[3];
    let aborted = fixture
        .store
        .producer_reservation(aborted_binding, aborted_slot)
        .unwrap()
        .unwrap();
    fixture
        .store
        .abort_unapplied(&aborted, aborted_binding, aborted_slot)
        .unwrap();
    fixture.reopen();
    let before = disk(&fixture.state);
    let pending = fixture.store.producer_reservations().unwrap();
    assert_eq!(pending.len(), 4);
    for (index, expected) in [
        ProducerPhase::Unarmed,
        ProducerPhase::Armed,
        ProducerPhase::CommittedPinned,
        ProducerPhase::AbortedPendingMaintenance,
    ]
    .into_iter()
    .enumerate()
    {
        let found = pending
            .iter()
            .find(|value| value.reference() == &events[index].2)
            .unwrap();
        assert_eq!(found.phase(), expected);
        assert_eq!(found.binding(), &events[index].0);
    }
    assert_eq!(disk(&fixture.state), before);
    let (binding, slot, reference, journal_bytes) = &events[2];
    complete(&mut fixture.store, reference, binding, slot, journal_bytes);
    let catalog = fixture.catalog();
    assert!(catalog
        .records
        .iter()
        .find(|record| record.reference == *reference)
        .unwrap()
        .slot
        .is_none());
    let before = disk(&fixture.state);
    complete(&mut fixture.store, reference, binding, slot, journal_bytes);
    assert_error(
        fixture.store.complete(
            reference,
            binding,
            &fixture.slot,
            &ProducerCompletion {
                journal_sha256: &hash(journal_bytes),
                committed_receipt_fingerprint: None,
            },
        ),
        "history_unavailable",
    );
    assert_eq!(
        read_version(&fixture.store, &saved).unwrap().content,
        "saved"
    );
    let public_version = serde_json::to_value(&saved).unwrap();
    assert!(public_version.get("slot").is_none());
    assert!(public_version.get("slotSha256").is_none());
    assert_eq!(fixture.store.producer_reservations().unwrap().len(), 3);
    assert_eq!(disk(&fixture.state), before);
    fixture.store.maintain().unwrap();
    let before = disk(&fixture.state);
    assert!(fixture
        .store
        .producer_reservation(aborted_binding, aborted_slot)
        .unwrap()
        .is_none());
    assert_eq!(fixture.store.producer_reservations().unwrap().len(), 2);
    assert_error(
        fixture
            .store
            .abort_unapplied(&aborted, aborted_binding, aborted_slot),
        "history_unavailable",
    );
    assert_eq!(disk(&fixture.state), before);
}

#[test]
fn strict_slot_catalog_format_preserves_canonical_identity_and_refuses_unbound_or_legacy_data() {
    let stored = StoredSourceSlot {
        parent_dev: u64::MAX,
        parent_ino: u64::MAX - 1,
        basename: "main.typ".into(),
    };
    let encoded = serde_json::to_value(&stored).unwrap();
    assert_eq!(encoded["parentDev"], "18446744073709551615");
    assert_eq!(encoded["parentIno"], "18446744073709551614");
    assert_eq!(
        serde_json::from_value::<StoredSourceSlot>(encoded).unwrap(),
        stored
    );
    let mut fixture = Fixture::new();
    let intent = fixture.capture("old", "saved");
    let journal_bytes = journal(&intent);
    fixture.store.prepare(&intent, &journal_bytes).unwrap();
    let raw = fs::read(fixture.state.join("history-v1/catalog.json")).unwrap();
    let base: serde_json::Value = serde_json::from_slice(&raw).unwrap();
    assert_eq!(base["schema"], 3);
    let mut old_one = base.clone();
    old_one["schema"] = serde_json::json!(1);
    let mut old_two = base.clone();
    old_two["schema"] = serde_json::json!(2);
    let mut missing = base.clone();
    missing["records"][0]
        .as_object_mut()
        .unwrap()
        .remove("slot");
    let mut null_slot = base.clone();
    null_slot["records"][0]["slot"] = serde_json::Value::Null;
    let mut extra = base.clone();
    extra["records"][0]["slot"]["nativeApproved"] = serde_json::json!(true);
    let mut numeric = base.clone();
    numeric["records"][0]["slot"]["parentDev"] = serde_json::json!(1);
    let mut noncanonical = base.clone();
    noncanonical["records"][0]["slot"]["parentIno"] = serde_json::json!(format!(
        "0{}",
        base["records"][0]["slot"]["parentIno"].as_str().unwrap()
    ));
    let mut mismatched = base.clone();
    mismatched["records"][0]["slot"]["parentIno"] =
        serde_json::json!(if base["records"][0]["slot"]["parentIno"] == "1" {
            "2"
        } else {
            "1"
        });
    let mut slash = base.clone();
    slash["records"][0]["slot"]["basename"] = serde_json::json!("elsewhere/main.typ");
    let mut missing_fingerprint = base.clone();
    missing_fingerprint["records"][0]["core"]
        .as_object_mut()
        .unwrap()
        .remove("slotSha256");
    for invalid in [
        old_one,
        old_two,
        missing,
        null_slot,
        extra,
        numeric,
        noncanonical,
        mismatched,
        slash,
        missing_fingerprint,
    ] {
        fs::write(
            fixture.state.join("history-v1/catalog.json"),
            serde_json::to_vec(&invalid).unwrap(),
        )
        .unwrap();
        assert_unavailable_preserves(&fixture);
        let before = disk(&fixture.state);
        assert_error(fixture.store.producer_reservations(), "history_unavailable");
        assert_eq!(disk(&fixture.state), before);
    }
}

#[test]
fn duplicate_outstanding_slot_records_are_refused_even_when_each_private_fingerprint_matches() {
    let mut fixture = Fixture::new();
    let first = fixture.capture("old", "first");
    fixture.store.prepare(&first, &journal(&first)).unwrap();
    let directory = fixture.temporary.path().join("another-parent");
    fs::create_dir(&directory).unwrap();
    fs::write(directory.join("main.typ"), b"another source").unwrap();
    let parent = Dir::open_ambient_dir(&directory, cap_std::ambient_authority()).unwrap();
    let second_slot = SourceSlot::from_held_parent(&parent, "main.typ").unwrap();
    let metadata = parent.dir_metadata().unwrap();
    let binding = SourceBinding {
        project_id: Uuid::new_v4().to_string(),
        root: RootObservation {
            dev: metadata.dev(),
            ino: metadata.ino(),
        },
        path: "main.typ".into(),
        source_epoch: 0,
    };
    let second = fixture
        .store
        .capture(capture(&binding, &second_slot, "old"), "second")
        .unwrap();
    fixture.store.prepare(&second, &journal(&second)).unwrap();
    assert_eq!(fixture.store.producer_reservations().unwrap().len(), 2);
    let mut catalog = fixture.catalog();
    catalog.records[1].slot = catalog.records[0].slot.clone();
    catalog.records[1].core.slot_sha256 = fixture.slot.0.fingerprint().unwrap();
    catalog.records[1].reference.intent_core_sha256 =
        hash(&serde_json::to_vec(&catalog.records[1].core).unwrap());
    fs::write(
        fixture.state.join("history-v1/catalog.json"),
        serde_json::to_vec(&catalog).unwrap(),
    )
    .unwrap();
    assert_unavailable_preserves(&fixture);
    let before = disk(&fixture.state);
    assert_error(fixture.store.producer_reservations(), "history_unavailable");
    assert_error(
        fixture
            .store
            .producer_reservation(&fixture.binding, &fixture.slot),
        "history_unavailable",
    );
    assert_eq!(disk(&fixture.state), before);
}

#[test]
fn source_slot_and_capture_share_exact_source_path_byte_and_character_boundaries() {
    let fixture = Fixture::new();
    let leaf = format!("{}.typ", "a".repeat(228));
    assert_eq!(leaf.len(), 232);
    let unicode_leaf = format!("{}.typ", "é".repeat(114));
    assert_eq!(unicode_leaf.len(), 232);
    let mut directories = vec!["d".repeat(239); 16];
    directories[0].push('d');
    let max_path = format!("{}/{}", directories.join("/"), leaf);
    assert_eq!(max_path.len(), 4073);
    let valid = vec![
        #[cfg(not(windows))]
        "draft:notes.typ".into(),
        "écriture/🧪.typ".into(),
        leaf.clone(),
        unicode_leaf.clone(),
        format!("{}/main.typ", "d".repeat(255)),
        format!("{}main.typ", "d/".repeat(31)),
        max_path.clone(),
    ];
    let before = disk(&fixture.state);
    for path in valid {
        assert!(super::super::source_path::validate_source_path(&path).is_ok());
        let binding = SourceBinding {
            path,
            ..fixture.binding.clone()
        };
        let slot = fixture.slot_for(&binding);
        fixture
            .store
            .capture(capture(&binding, &slot, "old"), "new")
            .unwrap();
    }
    let mut invalid = vec![
        #[cfg(windows)]
        "draft:notes.typ".into(),
        format!("a{leaf}"),
        format!("a{unicode_leaf}"),
        format!("{}/main.typ", "d".repeat(256)),
        format!("{}main.typ", "d/".repeat(32)),
        format!("d{max_path}"),
        "../main.typ".into(),
        "hidden/.main.typ".into(),
        "For-AI/main.typ".into(),
        "node_modules/main.typ".into(),
        "a\\main.typ".into(),
        "main.pdf".into(),
        "a//main.typ".into(),
        "main\n.typ".into(),
    ];
    for character in [
        '\u{2028}', '\u{2029}', '\u{200e}', '\u{200f}', '\u{202a}', '\u{202b}', '\u{202c}',
        '\u{202d}', '\u{202e}', '\u{2066}', '\u{2067}', '\u{2068}', '\u{2069}', '\u{feff}',
    ] {
        invalid.push(format!("dir{character}/main.typ"));
    }
    for path in invalid {
        assert!(
            super::super::source_path::validate_source_path(&path).is_err(),
            "unexpected eligible path: {path:?}"
        );
        let binding = SourceBinding {
            path,
            ..fixture.binding.clone()
        };
        assert_error(
            fixture
                .store
                .capture(capture(&binding, &fixture.slot, "old"), "new"),
            "history_unavailable",
        );
    }
    for basename in [
        format!("a{leaf}"),
        format!("a{unicode_leaf}"),
        "dir/main.typ".into(),
        "main\u{200e}.typ".into(),
    ] {
        assert_error(
            SourceSlot::from_held_parent(&fixture.source_parent, &basename),
            "history_unavailable",
        );
    }
    assert_eq!(disk(&fixture.state), before);
}

#[test]
fn common_root_wire_preserves_exact_binding_and_query_dtos_and_refuses_invalid_nested_roots() {
    let root: crate::RootObservation = RootObservation::new(0, u64::MAX);
    let root_json = r#"{"dev":"0","ino":"18446744073709551615"}"#;
    assert_eq!(serde_json::to_string(&root).unwrap(), root_json);
    assert_eq!(
        RootObservation::parse("0", "18446744073709551615").unwrap(),
        root
    );
    let binding = SourceBinding {
        project_id: Uuid::nil().to_string(),
        root,
        path: "draft:notes.typ".into(),
        source_epoch: 1,
    };
    let binding_json = format!(
        r#"{{"projectId":"{}","root":{},"path":"draft:notes.typ","sourceEpoch":1}}"#,
        binding.project_id, root_json
    );
    assert_eq!(serde_json::to_string(&binding).unwrap(), binding_json);
    assert_eq!(
        serde_json::from_str::<SourceBinding>(&binding_json).unwrap(),
        binding
    );
    let query_json = format!(
        r#"{{"action":"list","projectId":"{}","namespaceId":null,"observedRoot":{},"sourceId":null,"cursor":null}}"#,
        binding.project_id, root_json
    );
    let HistoryQuery::List { observed_root, .. } = serde_json::from_str(&query_json).unwrap()
    else {
        panic!("Expected the unchanged List DTO");
    };
    assert_eq!(observed_root, Some(root));
    assert_eq!(
        crate::root_observation::optional(&mut serde_json::Deserializer::from_str(root_json))
            .unwrap(),
        Some(root)
    );
    for invalid in [
        r#"{"dev":0,"ino":"1"}"#,
        r#"{"dev":"00","ino":"1"}"#,
        r#"{"dev":"+1","ino":"1"}"#,
        r#"{"dev":"-1","ino":"1"}"#,
        r#"{"dev":" 1","ino":"1"}"#,
        r#"{"dev":"1","ino":"1.0"}"#,
        r#"{"dev":"1","ino":"18446744073709551616"}"#,
        r#"{"dev":"1","ino":"2","extra":0}"#,
        r#"{"dev":"1","dev":"1","ino":"2"}"#,
        r#"{"dev":"1","ino":"2","ino":"2"}"#,
        r#"{"dev":"1"}"#,
    ] {
        assert!(
            serde_json::from_str::<SourceBinding>(&binding_json.replace(root_json, invalid))
                .is_err(),
            "{invalid}"
        );
        assert!(
            serde_json::from_str::<HistoryQuery>(&query_json.replace(root_json, invalid)).is_err(),
            "{invalid}"
        );
        assert!(
            crate::root_observation::optional(&mut serde_json::Deserializer::from_str(invalid))
                .is_err(),
            "{invalid}"
        );
    }
    assert!(
        serde_json::from_str::<SourceBinding>(&binding_json.replace(root_json, "null")).is_err()
    );
    assert!(
        crate::root_observation::optional(&mut serde_json::Deserializer::from_str("null")).is_err()
    );
    let HistoryQuery::List { observed_root, .. } =
        serde_json::from_str(&query_json.replace(root_json, "null")).unwrap()
    else {
        panic!("Expected the unchanged List DTO");
    };
    assert_eq!(observed_root, None);
}

#[test]
fn common_root_invalid_private_catalog_observations_preserve_pending_proof_and_source() {
    let mut fixture = Fixture::new();
    let source_before = fixture.source_parent.read("main.typ").unwrap();
    let intent = fixture.capture("old", "saved");
    let journal_bytes = journal(&intent);
    fixture.store.prepare(&intent, &journal_bytes).unwrap();
    let catalog_path = fixture.state.join("history-v1/catalog.json");
    let valid = fs::read_to_string(&catalog_path).unwrap();
    let encoded_root = serde_json::to_string(&fixture.binding.root).unwrap();
    assert!(valid.matches(&encoded_root).count() >= 2);
    for invalid in [
        "null",
        r#"{"dev":1,"ino":"1"}"#,
        r#"{"dev":"01","ino":"1"}"#,
        r#"{"dev":"1","ino":"2","ino":"2"}"#,
        r#"{"dev":"1","ino":"2","extra":0}"#,
        r#"{"dev":"1","ino":"18446744073709551616"}"#,
    ] {
        fs::write(&catalog_path, valid.replace(&encoded_root, invalid)).unwrap();
        assert_unavailable_preserves(&fixture);
        assert_error(fixture.store.producer_reservations(), "history_unavailable");
        assert_eq!(
            fixture.source_parent.read("main.typ").unwrap(),
            source_before
        );
    }
    fs::write(&catalog_path, valid).unwrap();
    fixture.reopen();
    assert_eq!(
        fixture
            .store
            .producer_reservation(&fixture.binding, &fixture.slot)
            .unwrap()
            .unwrap()
            .phase(),
        ProducerPhase::Unarmed
    );
}
