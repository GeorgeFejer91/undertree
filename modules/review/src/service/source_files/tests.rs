use super::*;
use std::collections::BTreeMap;

#[cfg(unix)]
#[test]
fn creation_aliases_use_exact_held_parent_and_leaf_without_requiring_present_source() {
    let temp = tempfile::tempdir().unwrap();
    let outer = temp.path().join("outer");
    let inner = outer.join("nested");
    let unrelated = temp.path().join("outside");
    std::fs::create_dir_all(&inner).unwrap();
    std::fs::create_dir(&unrelated).unwrap();
    let project = |root: &Path| crate::service::Project {
        id: uuid::Uuid::new_v4().to_string(),
        name: "fixture".into(),
        root: root.into(),
        repository: String::new(),
        auto_sync: false,
        main_document: String::new(),
        pending: Default::default(),
        pending_revisions: Default::default(),
    };
    let a = project(&outer);
    let b = project(&inner);
    let c = project(&unrelated);
    let held = RootedRoot::acquire(&outer, &RootedRoot::observe(&outer).unwrap()).unwrap();
    let group = held.source_group("nested/new.typ").unwrap();
    assert!(group
        .read_bytes(Member::Source, SLOT_LIMIT)
        .unwrap()
        .bytes()
        .is_none());
    let approved = vec![a.clone(), b.clone(), c];
    assert_eq!(
        error_code(group.require_unaliased_creation(&a, &approved)),
        "alias_conflict"
    );
    let reverse = RootedRoot::acquire(&inner, &RootedRoot::observe(&inner).unwrap())
        .unwrap()
        .source_group("new.typ")
        .unwrap();
    assert_eq!(
        error_code(reverse.require_unaliased_creation(&b, &approved)),
        "alias_conflict"
    );
    held.source_group("unrelated.typ")
        .unwrap()
        .require_unaliased_creation(&a, &approved)
        .unwrap();
    let actual_parent = project_tree::open_root(&inner).unwrap();
    group.require_import_parent(&actual_parent).unwrap();
    let wrong_parent = project_tree::open_root(&unrelated).unwrap();
    assert_eq!(
        error_code(group.require_import_parent(&wrong_parent)),
        "stale"
    );
    std::fs::rename(&inner, outer.join("retained-parent")).unwrap();
    std::fs::create_dir(&inner).unwrap();
    assert_eq!(
        error_code(group.require_unaliased_creation(&a, &approved)),
        "stale"
    );
    assert_eq!(
        error_code(group.require_import_parent(&actual_parent)),
        "stale"
    );
    assert_eq!(std::fs::read_dir(&inner).unwrap().count(), 0);
    std::fs::rename(&outer, temp.path().join("retained-root")).unwrap();
    std::fs::create_dir(&outer).unwrap();
    assert_eq!(
        error_code(group.require_unaliased_creation(&a, &approved)),
        "stale_root"
    );
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub(super) enum Point {
    BeforeCreate,
    BeforeFinalCheck,
    AfterFinalCheck,
    AfterRename,
    BeforeReadOpen,
    AfterRead,
    BeforeJournalSync,
}

type Callback = Box<dyn FnOnce(&SourceGroup, &str) -> Result<()> + Send>;

#[derive(Default)]
pub(super) struct Hooks {
    callbacks: BTreeMap<Point, Callback>,
}

pub(super) fn run(group: &SourceGroup, point: Point, temporary: &str) -> Result<()> {
    let callback = group
        .hooks
        .lock()
        .map_err(|_| Error::new("state", "The source-group test hook was poisoned."))?
        .callbacks
        .remove(&point);
    // Callbacks may inspect/install hooks. Never invoke them under the group's mutex.
    match callback {
        Some(callback) => callback(group, temporary),
        None => Ok(()),
    }
}

fn install(
    group: &SourceGroup,
    point: Point,
    callback: impl FnOnce(&SourceGroup, &str) -> Result<()> + Send + 'static,
) {
    let previous = group
        .hooks
        .lock()
        .unwrap()
        .callbacks
        .insert(point, Box::new(callback));
    assert!(
        previous.is_none(),
        "a hook already owns this group and phase"
    );
}

fn error_code<T>(result: Result<T>) -> &'static str {
    match result {
        Err(error) => error.code,
        Ok(_) => panic!("the operation unexpectedly succeeded"),
    }
}

#[test]
fn filesystem_observations_require_canonical_decimal_strings_and_strict_wire_fields() {
    for value in ["0", "1", "18446744073709551615"] {
        let observed = RootObservation::parse(value, value).unwrap();
        let wire = serde_json::to_value(observed).unwrap();
        assert_eq!(wire, serde_json::json!({"dev": value, "ino": value}));
        assert_eq!(
            serde_json::from_value::<RootObservation>(wire).unwrap(),
            observed
        );
    }
    for invalid in [
        "",
        "00",
        "01",
        "+1",
        "-1",
        " 1",
        "1 ",
        "1\n",
        "1.0",
        "1e2",
        "１２",
        "18446744073709551616",
    ] {
        assert_eq!(error_code(RootObservation::parse(invalid, "1")), "format");
        assert_eq!(error_code(RootObservation::parse("1", invalid)), "format");
        assert!(serde_json::from_value::<RootObservation>(
            serde_json::json!({"dev": invalid, "ino": "1"})
        )
        .is_err());
    }
    for invalid in [
        r#"{"dev":1,"ino":"2"}"#,
        r#"{"dev":"1","ino":2}"#,
        r#"{"dev":"1","ino":"2","extra":0}"#,
        r#"{"dev":"1","dev":"1","ino":"2"}"#,
        r#"{"dev":"1"}"#,
        r#"{"dev":null,"ino":"2"}"#,
    ] {
        assert!(
            serde_json::from_str::<RootObservation>(invalid).is_err(),
            "{invalid}"
        );
    }
}

#[test]
fn source_path_is_canonical_bounded_and_cannot_select_adjacent_metadata() {
    for invalid in [
        "",
        "/main.typ",
        "../main.typ",
        "./main.typ",
        "a//main.typ",
        "a/./main.typ",
        "a/../main.typ",
        "a\\main.typ",
        ".hidden/main.typ",
        "a/.main.typ",
        ".git/main.typ",
        "For-AI/main.typ",
        "node_modules/main.typ",
        "main.bin",
        "main.typ.undertree-review.json",
        "main.typ.undertree-pending.json",
        "main.typ.import-report.json",
        "a\n/main.typ",
        "a\u{2028}/main.typ",
        "a\u{202e}/main.typ",
    ] {
        assert_eq!(
            error_code(super::super::source_path::validate_source_path(invalid)),
            "path",
            "{invalid:?}"
        );
    }
    assert_eq!(
        super::super::source_path::validate_source_path("main.typ").unwrap(),
        ("", "main.typ")
    );
    assert_eq!(
        super::super::source_path::validate_source_path("chapters/a b:c.typ").unwrap(),
        ("chapters", "a b:c.typ")
    );
    assert_eq!(
        super::super::source_path::validate_source_path("chapters/notes.bib").unwrap(),
        ("chapters", "notes.bib")
    );
    let too_deep = format!("{}main.typ", "a/".repeat(32));
    assert_eq!(
        error_code(super::super::source_path::validate_source_path(&too_deep)),
        "path"
    );
    assert!(super::super::source_path::validate_source_path(&format!(
        "{}main.typ",
        "a/".repeat(31)
    ))
    .is_ok());
    let no_metadata_space = format!("{}.typ", "a".repeat(236));
    assert_eq!(
        error_code(super::super::source_path::validate_source_path(
            &no_metadata_space
        )),
        "path"
    );
    let parent = format!("{}/", "a".repeat(240)).repeat(16);
    let no_relative_metadata_space = format!("{parent}{}.typ", "b".repeat(220));
    assert!(no_relative_metadata_space.len() < 4096);
    assert_eq!(
        error_code(super::super::source_path::validate_source_path(
            &no_relative_metadata_space
        )),
        "path"
    );
    assert_eq!(
        error_code(super::super::source_path::validate_source_path(&format!(
            "{}main.typ",
            "a/".repeat(2050)
        ))),
        "path"
    );
}

#[cfg(unix)]
mod unix {
    use super::*;
    use std::fs;
    use std::os::unix::fs::{symlink, PermissionsExt};
    use std::os::unix::net::UnixListener;
    use std::sync::Mutex;

    const OLD: &[u8] = b"Original source.\n";
    const NEXT: &[u8] = b"Replacement source.\n";
    const OUTSIDE: &[u8] = b"Outside sentinel: never overwrite.\n";
    const R1: &[u8] = b"New directory occupant: preserve.\n";
    const LIMIT: usize = 1024;

    struct Fixture {
        _temporary: tempfile::TempDir,
        base: PathBuf,
        project: PathBuf,
        parent: PathBuf,
        outside: PathBuf,
        root: Arc<RootedRoot>,
        group: SourceGroup,
    }

    impl Fixture {
        fn new() -> Self {
            let temporary = tempfile::tempdir().unwrap();
            let base = temporary.path().canonicalize().unwrap();
            let project = base.join("project");
            let parent = project.join("chapters");
            let outside = base.join("outside");
            fs::create_dir_all(&parent).unwrap();
            fs::create_dir(&outside).unwrap();
            fs::write(parent.join("main.typ"), OLD).unwrap();
            fs::write(outside.join("main.typ"), OUTSIDE).unwrap();
            let observed = RootedRoot::observe(&project).unwrap();
            let root = RootedRoot::acquire(&project, &observed).unwrap();
            let group = root.source_group("chapters/main.typ").unwrap();
            Self {
                _temporary: temporary,
                base,
                project,
                parent,
                outside,
                root,
                group,
            }
        }

        fn leaf(&self, member: Member) -> PathBuf {
            self.parent.join(self.group.name(member))
        }

        fn outside_unchanged(&self) {
            assert_eq!(fs::read(self.outside.join("main.typ")).unwrap(), OUTSIDE);
            assert_eq!(fs::read_dir(&self.outside).unwrap().count(), 1);
        }

        fn no_staging_files(&self) {
            assert!(!fs::read_dir(&self.parent).unwrap().any(|entry| {
                entry
                    .unwrap()
                    .file_name()
                    .to_string_lossy()
                    .starts_with(".undertree-compile-")
            }));
        }
    }

    fn durable(result: Result<ReplaceOutcome>) -> Expectation {
        match result.unwrap() {
            ReplaceOutcome::Durable(expected) => expected,
            unexpected => panic!("replacement was not durable: {unexpected:?}"),
        }
    }

    fn uncertain(
        result: Result<ReplaceOutcome>,
        publication: bool,
    ) -> (TemporaryObservation, Error) {
        match result.unwrap() {
            ReplaceOutcome::Uncertain {
                publication_may_have_happened,
                temporary,
                error,
            } => {
                assert_eq!(publication_may_have_happened, publication);
                assert!(temporary.name.starts_with(".undertree-compile-"));
                assert!(temporary.name.ends_with(".tmp"));
                assert_eq!(Path::new(&temporary.name).components().count(), 1);
                assert!(temporary.identity.is_some());
                (temporary, error)
            }
            unexpected => panic!("replacement was not uncertain: {unexpected:?}"),
        }
    }

    #[test]
    fn nested_members_read_absence_and_replace_with_bound_observations() {
        let fixture = Fixture::new();
        fixture.group.check_current().unwrap();
        let source = fixture.group.read_utf8(Member::Source, LIMIT).unwrap();
        assert_eq!(source.bytes(), Some(OLD));
        assert_eq!(source.text().unwrap(), Some("Original source.\n"));
        for (member, bytes) in [
            (Member::Source, NEXT),
            (Member::Review, b"{\"review\":1}".as_slice()),
            (Member::Journal, b"{\"journal\":1}".as_slice()),
        ] {
            let entry = fixture.group.read_utf8(member, LIMIT).unwrap();
            if member != Member::Source {
                assert_eq!(entry.bytes(), None);
                assert_eq!(entry.text().unwrap(), None);
            }
            let installed =
                durable(
                    fixture
                        .group
                        .replace(member, entry.expectation(), bytes, LIMIT, &[]),
                );
            let reread = fixture.group.read_utf8(member, LIMIT).unwrap();
            assert_eq!(reread.bytes(), Some(bytes));
            assert_eq!(reread.expectation(), &installed);
            assert_eq!(fs::read(fixture.leaf(member)).unwrap(), bytes);
            assert_eq!(installed.binding.member, member);
            assert_eq!(installed.binding.relative, "chapters/main.typ");
        }
        fixture.no_staging_files();
        fixture.outside_unchanged();
    }

    #[test]
    fn new_entries_are_private_and_replacement_keeps_only_ordinary_permission_bits() {
        let fixture = Fixture::new();
        for member in [Member::Source, Member::Review, Member::Journal] {
            if member == Member::Source {
                fs::remove_file(fixture.leaf(member)).unwrap();
            }
            let absent = fixture.group.read_bytes(member, LIMIT).unwrap();
            durable(
                fixture
                    .group
                    .replace(member, absent.expectation(), NEXT, LIMIT, &[]),
            );
            assert_eq!(
                fs::metadata(fixture.leaf(member))
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o7777,
                0o600
            );
            fs::set_permissions(fixture.leaf(member), fs::Permissions::from_mode(0o6754)).unwrap();
            let previous = fixture.group.read_bytes(member, LIMIT).unwrap();
            durable(
                fixture
                    .group
                    .replace(member, previous.expectation(), OLD, LIMIT, &[]),
            );
            assert_eq!(
                fs::metadata(fixture.leaf(member))
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o7777,
                0o754
            );
        }
    }

    #[test]
    fn expectations_cannot_cross_members_paths_roots_or_later_occupants() {
        let fixture = Fixture::new();
        let source = fixture.group.read_bytes(Member::Source, LIMIT).unwrap();
        assert_eq!(
            error_code(fixture.group.replace(
                Member::Review,
                source.expectation(),
                NEXT,
                LIMIT,
                &[]
            )),
            "scope"
        );
        fs::write(fixture.parent.join("other.typ"), OLD).unwrap();
        let other = fixture.root.source_group("chapters/other.typ").unwrap();
        assert_eq!(
            error_code(other.replace(Member::Source, source.expectation(), NEXT, LIMIT, &[])),
            "scope"
        );
        let separate = Fixture::new();
        assert_eq!(
            error_code(separate.group.replace(
                Member::Source,
                source.expectation(),
                NEXT,
                LIMIT,
                &[]
            )),
            "scope"
        );
        let absent = fixture.group.read_bytes(Member::Journal, LIMIT).unwrap();
        fs::write(fixture.leaf(Member::Journal), b"External new journal.").unwrap();
        assert_eq!(
            error_code(fixture.group.replace(
                Member::Journal,
                absent.expectation(),
                NEXT,
                LIMIT,
                &[]
            )),
            "stale"
        );
        fs::rename(
            fixture.leaf(Member::Source),
            fixture.parent.join("original-held.typ"),
        )
        .unwrap();
        fs::write(fixture.leaf(Member::Source), OLD).unwrap();
        assert_eq!(
            error_code(fixture.group.replace(
                Member::Source,
                source.expectation(),
                NEXT,
                LIMIT,
                &[]
            )),
            "stale"
        );
        assert_eq!(fs::read(fixture.leaf(Member::Source)).unwrap(), OLD);
        assert_eq!(
            fs::read(fixture.leaf(Member::Journal)).unwrap(),
            b"External new journal."
        );
        fixture.no_staging_files();
    }

    #[test]
    fn reads_are_bounded_and_utf8_validation_does_not_reinterpret_bytes() {
        let fixture = Fixture::new();
        fs::write(fixture.leaf(Member::Source), [0xff, 0xfe, 0x00]).unwrap();
        let binary = fixture.group.read_bytes(Member::Source, 3).unwrap();
        assert_eq!(binary.bytes(), Some([0xff, 0xfe, 0x00].as_slice()));
        assert_eq!(error_code(binary.text()), "format");
        assert_eq!(
            error_code(fixture.group.read_utf8(Member::Source, 3)),
            "format"
        );
        assert_eq!(
            error_code(fixture.group.read_bytes(Member::Source, 2)),
            "limit"
        );
        assert_eq!(
            error_code(fixture.group.replace(
                Member::Source,
                binary.expectation(),
                b"four",
                3,
                &[]
            )),
            "limit"
        );
        for member in [Member::Source, Member::Review, Member::Journal] {
            assert_eq!(
                error_code(fixture.group.read_bytes(member, member.maximum() + 1)),
                "limit"
            );
            let path = fixture.leaf(member);
            fs::File::create(&path)
                .unwrap()
                .set_len(member.maximum() as u64 + 1)
                .unwrap();
            assert_eq!(
                error_code(fixture.group.read_bytes(member, member.maximum())),
                "limit"
            );
        }
        fixture.no_staging_files();
    }

    #[test]
    fn root_replacement_before_acquisition_or_operation_refuses_without_effects() {
        let fixture = Fixture::new();
        let observation = RootedRoot::observe(&fixture.project).unwrap();
        let expected = fixture.group.read_bytes(Member::Source, LIMIT).unwrap();
        let retired = fixture.base.join("retired-project");
        fs::rename(&fixture.project, &retired).unwrap();
        fs::create_dir_all(fixture.project.join("chapters")).unwrap();
        fs::write(fixture.project.join("chapters/main.typ"), R1).unwrap();
        assert_eq!(
            error_code(RootedRoot::acquire(&fixture.project, &observation)),
            "stale_root"
        );
        assert_eq!(error_code(fixture.group.check_current()), "stale_root");
        assert_eq!(
            error_code(fixture.group.read_bytes(Member::Source, LIMIT)),
            "stale_root"
        );
        assert_eq!(
            error_code(fixture.group.replace(
                Member::Source,
                expected.expectation(),
                NEXT,
                LIMIT,
                &[]
            )),
            "stale_root"
        );
        assert_eq!(fs::read(retired.join("chapters/main.typ")).unwrap(), OLD);
        assert_eq!(
            fs::read(fixture.project.join("chapters/main.typ")).unwrap(),
            R1
        );
        assert_eq!(fs::read_dir(retired.join("chapters")).unwrap().count(), 1);
        fixture.outside_unchanged();
    }

    #[test]
    fn parent_replacement_before_operation_and_symlinked_acquisition_refuse() {
        let fixture = Fixture::new();
        let expected = fixture.group.read_bytes(Member::Source, LIMIT).unwrap();
        let retired = fixture.project.join("retired-chapters");
        fs::rename(&fixture.parent, &retired).unwrap();
        symlink(&fixture.outside, &fixture.parent).unwrap();
        assert_eq!(error_code(fixture.group.check_current()), "stale");
        assert_eq!(
            error_code(fixture.group.replace(
                Member::Source,
                expected.expectation(),
                NEXT,
                LIMIT,
                &[]
            )),
            "stale"
        );
        assert_eq!(
            error_code(fixture.root.source_group("chapters/main.typ")),
            "stale"
        );
        let root_link = fixture.base.join("root-link");
        symlink(&fixture.project, &root_link).unwrap();
        assert!(RootedRoot::observe(&root_link).is_err());
        assert!(RootedRoot::acquire(&root_link, &fixture.root.expected).is_err());
        assert_eq!(fs::read(retired.join("main.typ")).unwrap(), OLD);
        assert_eq!(fs::read_dir(&retired).unwrap().count(), 1);
        fixture.outside_unchanged();
    }

    #[test]
    fn identical_byte_leaf_replacement_during_read_is_not_adopted() {
        let fixture = Fixture::new();
        let source = fixture.leaf(Member::Source);
        let backup = fixture.parent.join("original-open-file.typ");
        let replacement = source.clone();
        install(
            &fixture.group,
            Point::AfterRead,
            move |group, member_name| {
                assert_eq!(member_name, "main.typ");
                assert!(group.hooks.try_lock().is_ok());
                fs::rename(&replacement, &backup)?;
                fs::write(&replacement, OLD)?;
                Ok(())
            },
        );
        assert_eq!(
            error_code(fixture.group.read_bytes(Member::Source, LIMIT)),
            "stale"
        );
        assert_eq!(fs::read(source).unwrap(), OLD);
        assert_eq!(
            fs::read(fixture.parent.join("original-open-file.typ")).unwrap(),
            OLD
        );
        assert_eq!(
            fixture
                .group
                .read_bytes(Member::Source, LIMIT)
                .unwrap()
                .bytes(),
            Some(OLD)
        );
    }

    #[test]
    fn regular_leaf_swapped_to_fifo_before_open_refuses_without_waiting_for_a_writer() {
        use std::sync::mpsc::{self, RecvTimeoutError};
        use std::time::Duration;

        let fixture = Fixture::new();
        let waiting_fifo = fixture.parent.join("prepared-fifo");
        let status = std::process::Command::new("mkfifo")
            .arg(&waiting_fifo)
            .status()
            .unwrap();
        assert!(
            status.success(),
            "the owned FIFO fixture could not be created"
        );
        let source = fixture.leaf(Member::Source);
        let old_source = fixture.parent.join("original-before-fifo.typ");
        let moved_source = source.clone();
        let moved_backup = old_source.clone();
        let group = Arc::new(fixture.root.source_group("chapters/main.typ").unwrap());
        install(&group, Point::BeforeReadOpen, move |_, name| {
            assert_eq!(name, "main.typ");
            fs::rename(&moved_source, &moved_backup)?;
            fs::rename(&waiting_fifo, &moved_source)?;
            Ok(())
        });
        let reader_group = group.clone();
        let (send, receive) = mpsc::channel();
        let reader = std::thread::spawn(move || {
            let _ = send.send(reader_group.read_bytes(Member::Source, LIMIT));
        });
        let (result, timed_out) = match receive.recv_timeout(Duration::from_secs(5)) {
            Ok(result) => (result, false),
            Err(RecvTimeoutError::Disconnected) => {
                reader.join().unwrap();
                panic!("the owned reader ended without reporting its result");
            }
            Err(RecvTimeoutError::Timeout) => {
                // An O_RDWR nonblocking keeper includes a writer endpoint and cannot itself
                // wait for a peer. It also releases a delayed reader that reaches open later.
                // No bytes are written: this is cleanup for a missing-O_NONBLOCK regression.
                let mut unblock = OpenOptions::new();
                unblock
                    .read(true)
                    .write(true)
                    .nonblock(true)
                    .follow(FollowSymlinks::No);
                let keeper = group.parent.open_with("main.typ", &unblock).unwrap();
                let result = receive
                    .recv_timeout(Duration::from_secs(5))
                    .expect("the owned FIFO reader did not stop after its writer endpoint opened");
                drop(keeper);
                (result, true)
            }
        };
        reader.join().unwrap();
        assert_eq!(error_code(result), "stale");
        use std::os::unix::fs::FileTypeExt;
        assert!(fs::symlink_metadata(&source).unwrap().file_type().is_fifo());
        assert_eq!(fs::read(old_source).unwrap(), OLD);
        fixture.no_staging_files();
        fixture.outside_unchanged();
        assert!(
            !timed_out,
            "a raced FIFO open waited for a writer; the read must use O_NONBLOCK"
        );
    }

    #[test]
    fn symlink_leaf_swap_before_final_check_preserves_outside_and_unknown_leaf() {
        let fixture = Fixture::new();
        let expected = fixture.group.read_bytes(Member::Source, LIMIT).unwrap();
        let leaf = fixture.leaf(Member::Source);
        let replacement = leaf.clone();
        let backup = fixture.parent.join("saved-source.typ");
        let outside = fixture.outside.join("main.typ");
        install(&fixture.group, Point::BeforeFinalCheck, move |_, _| {
            fs::rename(&replacement, &backup)?;
            symlink(&outside, &replacement)?;
            Ok(())
        });
        let (temporary, error) = uncertain(
            fixture
                .group
                .replace(Member::Source, expected.expectation(), NEXT, LIMIT, &[]),
            false,
        );
        assert_eq!(error.code, "stale");
        assert!(fs::symlink_metadata(leaf).unwrap().file_type().is_symlink());
        assert_eq!(
            fs::read(fixture.parent.join("saved-source.typ")).unwrap(),
            OLD
        );
        assert_eq!(
            fs::read(fixture.parent.join(&temporary.name)).unwrap(),
            NEXT
        );
        fixture.outside_unchanged();
    }

    #[test]
    fn parent_symlink_swap_before_final_check_retains_staging_in_original_parent() {
        let fixture = Fixture::new();
        let expected = fixture.group.read_bytes(Member::Source, LIMIT).unwrap();
        let retired = fixture.project.join("retired-chapters");
        let old_parent = fixture.parent.clone();
        let destination = retired.clone();
        let outside = fixture.outside.clone();
        install(&fixture.group, Point::BeforeFinalCheck, move |_, _| {
            fs::rename(&old_parent, &destination)?;
            symlink(&outside, &old_parent)?;
            Ok(())
        });
        let (temporary, error) = uncertain(
            fixture
                .group
                .replace(Member::Source, expected.expectation(), NEXT, LIMIT, &[]),
            false,
        );
        assert_eq!(error.code, "stale");
        assert_eq!(fs::read(retired.join("main.typ")).unwrap(), OLD);
        assert_eq!(fs::read(retired.join(&temporary.name)).unwrap(), NEXT);
        fixture.outside_unchanged();
    }

    #[test]
    fn temporary_symlink_identity_swap_and_same_length_tampering_are_not_published_or_deleted() {
        for attack in 0..3 {
            let fixture = Fixture::new();
            let expected = fixture.group.read_bytes(Member::Source, LIMIT).unwrap();
            let parent = fixture.parent.clone();
            let outside = fixture.outside.join("main.typ");
            install(
                &fixture.group,
                Point::BeforeFinalCheck,
                move |_, temporary| {
                    let staged = parent.join(temporary);
                    if attack == 2 {
                        fs::write(&staged, vec![b'X'; NEXT.len()])?;
                    } else {
                        fs::rename(&staged, parent.join("held-original-temporary"))?;
                        if attack == 0 {
                            symlink(&outside, &staged)?;
                        } else {
                            fs::write(&staged, NEXT)?;
                        }
                    }
                    Ok(())
                },
            );
            let (temporary, _) = uncertain(
                fixture
                    .group
                    .replace(Member::Source, expected.expectation(), NEXT, LIMIT, &[]),
                false,
            );
            assert_eq!(fs::read(fixture.leaf(Member::Source)).unwrap(), OLD);
            let staged = fixture.parent.join(&temporary.name);
            if attack == 0 {
                assert!(fs::symlink_metadata(&staged)
                    .unwrap()
                    .file_type()
                    .is_symlink());
            } else if attack == 1 {
                assert_eq!(fs::read(&staged).unwrap(), NEXT);
                let named = observed(
                    &fixture
                        .group
                        .parent
                        .symlink_metadata(&temporary.name)
                        .unwrap(),
                );
                assert_ne!(Some(named), temporary.identity);
            } else {
                assert_eq!(fs::read(&staged).unwrap(), vec![b'X'; NEXT.len()]);
            }
            if attack != 2 {
                let held = fixture.parent.join("held-original-temporary");
                assert_eq!(fs::read(held).unwrap(), NEXT);
            }
            fixture.outside_unchanged();
        }
    }

    #[test]
    fn root_or_parent_swap_after_final_check_writes_only_the_retained_directory() {
        for swap_root in [false, true] {
            for link_outside in [false, true] {
                let fixture = Fixture::new();
                let expected = fixture.group.read_bytes(Member::Source, LIMIT).unwrap();
                let original = if swap_root {
                    fixture.project.clone()
                } else {
                    fixture.parent.clone()
                };
                let retired = fixture.base.join("retired-object");
                let retained_parent = if swap_root {
                    retired.join("chapters")
                } else {
                    retired.clone()
                };
                let original_hook = original.clone();
                let retired_hook = retired.clone();
                let outside = fixture.outside.clone();
                install(&fixture.group, Point::AfterFinalCheck, move |_, _| {
                    fs::rename(&original_hook, &retired_hook)?;
                    if link_outside {
                        symlink(&outside, &original_hook)?;
                    } else {
                        let new_parent = if swap_root {
                            original_hook.join("chapters")
                        } else {
                            original_hook.clone()
                        };
                        fs::create_dir_all(&new_parent)?;
                        fs::write(new_parent.join("main.typ"), R1)?;
                    }
                    Ok(())
                });
                let (temporary, error) = uncertain(
                    fixture
                        .group
                        .replace(Member::Source, expected.expectation(), NEXT, LIMIT, &[]),
                    true,
                );
                assert_eq!(error.code, "outcome_unknown");
                assert_eq!(fs::read(retained_parent.join("main.typ")).unwrap(), NEXT);
                assert!(!retained_parent.join(&temporary.name).exists());
                if !link_outside {
                    let new_parent = if swap_root {
                        original.join("chapters")
                    } else {
                        original
                    };
                    assert_eq!(fs::read(new_parent.join("main.typ")).unwrap(), R1);
                    assert_eq!(fs::read_dir(new_parent).unwrap().count(), 1);
                }
                fixture.outside_unchanged();
            }
        }
    }

    #[test]
    fn injected_post_rename_failure_preserves_installed_output_without_rollback() {
        let fixture = Fixture::new();
        let expected = fixture.group.read_bytes(Member::Source, LIMIT).unwrap();
        install(&fixture.group, Point::AfterRename, |group, temporary| {
            assert!(group.hooks.try_lock().is_ok());
            assert!(group
                .parent
                .symlink_metadata(temporary)
                .is_err_and(|error| error.kind() == std::io::ErrorKind::NotFound));
            Err(Error::new(
                "io",
                "Injected post-rename directory-sync-like failure.",
            ))
        });
        let (temporary, error) = uncertain(
            fixture
                .group
                .replace(Member::Source, expected.expectation(), NEXT, LIMIT, &[]),
            true,
        );
        assert_eq!(error.code, "outcome_unknown");
        assert_eq!(fs::read(fixture.leaf(Member::Source)).unwrap(), NEXT);
        assert!(!fixture.parent.join(temporary.name).exists());
        let installed = fixture.group.read_bytes(Member::Source, LIMIT).unwrap();
        assert_eq!(
            installed
                .expectation()
                .file
                .as_ref()
                .map(|(stamp, _)| &stamp.identity),
            temporary.identity.as_ref()
        );
        fixture.outside_unchanged();
    }

    #[test]
    fn installed_permission_change_after_rename_is_uncertain_and_never_rolled_back() {
        let fixture = Fixture::new();
        let expected = fixture.group.read_bytes(Member::Source, LIMIT).unwrap();
        let source = fixture.leaf(Member::Source);
        install(&fixture.group, Point::AfterRename, move |_, _| {
            fs::set_permissions(&source, fs::Permissions::from_mode(0o4755))?;
            Ok(())
        });
        let (temporary, error) = uncertain(
            fixture
                .group
                .replace(Member::Source, expected.expectation(), NEXT, LIMIT, &[]),
            true,
        );
        assert_eq!(error.code, "outcome_unknown");
        assert_eq!(fs::read(fixture.leaf(Member::Source)).unwrap(), NEXT);
        assert_eq!(
            fs::metadata(fixture.leaf(Member::Source))
                .unwrap()
                .permissions()
                .mode()
                & 0o7777,
            0o4755
        );
        assert!(!fixture.parent.join(temporary.name).exists());
        fixture.outside_unchanged();
    }

    #[test]
    fn create_new_collision_preserves_the_unknown_temporary_and_source() {
        let fixture = Fixture::new();
        let expected = fixture.group.read_bytes(Member::Source, LIMIT).unwrap();
        let captured = Arc::new(Mutex::new(None));
        let callback_capture = captured.clone();
        let parent = fixture.parent.clone();
        install(&fixture.group, Point::BeforeCreate, move |_, name| {
            fs::write(parent.join(name), b"Unknown colliding object.")?;
            *callback_capture.lock().unwrap() = Some(name.to_owned());
            Ok(())
        });
        assert_eq!(
            error_code(fixture.group.replace(
                Member::Source,
                expected.expectation(),
                NEXT,
                LIMIT,
                &[]
            )),
            "io"
        );
        let name = captured.lock().unwrap().take().unwrap();
        assert_eq!(
            fs::read(fixture.parent.join(name)).unwrap(),
            b"Unknown colliding object."
        );
        assert_eq!(fs::read(fixture.leaf(Member::Source)).unwrap(), OLD);
        fixture.outside_unchanged();
    }

    #[test]
    fn per_group_callbacks_are_one_shot_and_run_without_the_hook_mutex() {
        let fixture = Fixture::new();
        let expected = fixture.group.read_bytes(Member::Source, LIMIT).unwrap();
        let calls = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let first = calls.clone();
        install(&fixture.group, Point::BeforeCreate, move |group, _| {
            assert!(group.hooks.try_lock().is_ok());
            first.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            let second = first.clone();
            install(group, Point::BeforeFinalCheck, move |group, _| {
                assert!(group.hooks.try_lock().is_ok());
                second.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                Ok(())
            });
            Ok(())
        });
        let next = durable(fixture.group.replace(
            Member::Source,
            expected.expectation(),
            NEXT,
            LIMIT,
            &[],
        ));
        durable(
            fixture
                .group
                .replace(Member::Source, &next, OLD, LIMIT, &[]),
        );
        assert_eq!(calls.load(std::sync::atomic::Ordering::SeqCst), 2);
        assert!(fixture.group.hooks.lock().unwrap().callbacks.is_empty());
    }

    #[test]
    fn symlink_directory_fifo_socket_and_hardlink_members_refuse_without_reading_targets() {
        for member in [Member::Source, Member::Review, Member::Journal] {
            let fixture = Fixture::new();
            let leaf = fixture.leaf(member);
            if leaf.exists() {
                fs::remove_file(&leaf).unwrap();
            }
            let absent = fixture.group.read_bytes(member, LIMIT).unwrap();
            symlink(fixture.outside.join("main.typ"), &leaf).unwrap();
            assert_eq!(error_code(fixture.group.read_bytes(member, LIMIT)), "stale");
            assert_eq!(
                error_code(
                    fixture
                        .group
                        .replace(member, absent.expectation(), NEXT, LIMIT, &[])
                ),
                "stale"
            );
            assert!(fs::symlink_metadata(&leaf)
                .unwrap()
                .file_type()
                .is_symlink());
            fixture.no_staging_files();
            fixture.outside_unchanged();
        }
        for kind in 0..4 {
            let fixture = Fixture::new();
            let leaf = fixture.leaf(Member::Source);
            fs::remove_file(&leaf).unwrap();
            let absent = fixture.group.read_bytes(Member::Source, LIMIT).unwrap();
            let mut listener = None;
            match kind {
                0 => fs::create_dir(&leaf).unwrap(),
                1 => {
                    let status = std::process::Command::new("mkfifo")
                        .arg(&leaf)
                        .status()
                        .unwrap();
                    assert!(
                        status.success(),
                        "the owned FIFO fixture could not be created"
                    );
                }
                2 => {
                    // Linux's socket-address limit also applies to long private TMPDIRs.
                    // Bind the same owned entry through its retained parent descriptor.
                    #[cfg(target_os = "linux")]
                    let address = {
                        use std::os::fd::AsRawFd;
                        PathBuf::from(format!(
                            "/proc/self/fd/{}/main.typ",
                            fixture.group.parent.as_raw_fd()
                        ))
                    };
                    #[cfg(not(target_os = "linux"))]
                    let address = leaf.clone();
                    listener = Some(UnixListener::bind(address).unwrap());
                    use std::os::unix::fs::FileTypeExt;
                    assert!(fs::symlink_metadata(&leaf).unwrap().file_type().is_socket());
                }
                3 => {
                    fs::write(&leaf, OLD).unwrap();
                    fs::hard_link(&leaf, fixture.outside.join("hardlink.typ")).unwrap();
                }
                _ => unreachable!(),
            }
            assert_eq!(
                error_code(fixture.group.read_bytes(Member::Source, LIMIT)),
                "stale"
            );
            assert_eq!(
                error_code(fixture.group.replace(
                    Member::Source,
                    absent.expectation(),
                    NEXT,
                    LIMIT,
                    &[]
                )),
                "stale"
            );
            fixture.no_staging_files();
            if kind == 3 {
                assert_eq!(fs::read(&leaf).unwrap(), OLD);
                assert_eq!(fs::read(fixture.outside.join("hardlink.typ")).unwrap(), OLD);
                assert_eq!(fs::read(fixture.outside.join("main.typ")).unwrap(), OUTSIDE);
            } else {
                fixture.outside_unchanged();
            }
            drop(listener);
        }
    }
}

#[cfg(unix)]
#[test]
fn project_wide_residue_admission_counts_all_parents_bytes_and_unknown_links_without_cleanup() {
    use std::fs;
    use std::os::unix::fs::symlink;
    let temporary = tempfile::tempdir().unwrap();
    let root = temporary.path().join("project");
    fs::create_dir(&root).unwrap();
    fs::create_dir(root.join("a")).unwrap();
    fs::create_dir(root.join("b")).unwrap();
    fs::write(root.join("main.typ"), b"Original").unwrap();
    let held = RootedRoot::acquire(&root, &RootedRoot::observe(&root).unwrap()).unwrap();
    for index in 0..8 {
        let parent = if index < 4 { "a" } else { "b" };
        fs::write(
            root.join(parent)
                .join(format!(".undertree-compile-unknown-{index}.tmp")),
            b"retained",
        )
        .unwrap();
    }
    assert_eq!(error_code(held.admit_staging(&[1])), "limit");
    assert_eq!(fs::read_dir(root.join("a")).unwrap().count(), 4);
    assert_eq!(fs::read_dir(root.join("b")).unwrap().count(), 4);
    for parent in ["a", "b"] {
        for entry in fs::read_dir(root.join(parent)).unwrap() {
            fs::remove_file(entry.unwrap().path()).unwrap();
        }
    }
    let oversized = root.join("a/.undertree-compile-large.tmp");
    fs::File::create(&oversized)
        .unwrap()
        .set_len(64 * 1024 * 1024)
        .unwrap();
    assert_eq!(error_code(held.admit_staging(&[1])), "limit");
    assert_eq!(fs::metadata(&oversized).unwrap().len(), 64 * 1024 * 1024);
    fs::remove_file(&oversized).unwrap();
    let outside = temporary.path().join("outside");
    fs::write(&outside, b"Outside sentinel").unwrap();
    symlink(&outside, &oversized).unwrap();
    assert_eq!(error_code(held.admit_staging(&[1])), "limit");
    assert!(fs::symlink_metadata(&oversized)
        .unwrap()
        .file_type()
        .is_symlink());
    assert_eq!(fs::read(outside).unwrap(), b"Outside sentinel");
    assert_eq!(fs::read(root.join("main.typ")).unwrap(), b"Original");
}

#[cfg(unix)]
#[test]
fn import_residue_bytes_and_unknown_flat_members_share_the_existing_project_budget() {
    use std::fs;
    let temporary = tempfile::tempdir().unwrap();
    let path = temporary.path().join("project");
    fs::create_dir(&path).unwrap();
    let root = RootedRoot::acquire(&path, &RootedRoot::observe(&path).unwrap()).unwrap();
    for name in [".undertree-build-import-a", ".undertree-build-import-b"] {
        let dir = path.join(name);
        fs::create_dir(&dir).unwrap();
        fs::File::create(dir.join("image.png"))
            .unwrap()
            .set_len(32 * 1024 * 1024)
            .unwrap();
    }
    assert_eq!(error_code(root.admit_import_staging(1)), "limit");
    assert_eq!(error_code(root.admit_staging(&[1])), "limit");
    for name in [".undertree-build-import-a", ".undertree-build-import-b"] {
        let file = path.join(name).join("image.png");
        assert_eq!(fs::metadata(&file).unwrap().len(), 32 * 1024 * 1024);
        fs::remove_file(file).unwrap();
    }
    let member = path.join(".undertree-build-import-a/unknown");
    fs::create_dir(&member).unwrap();
    assert_eq!(error_code(root.admit_import_staging(1)), "limit");
    assert!(member.is_dir());
    fs::remove_dir(&member).unwrap();
    let outside = temporary.path().join("outside");
    fs::write(&outside, b"outside").unwrap();
    std::os::unix::fs::symlink(&outside, &member).unwrap();
    assert_eq!(error_code(root.admit_import_staging(1)), "limit");
    assert!(fs::symlink_metadata(member)
        .unwrap()
        .file_type()
        .is_symlink());
    assert_eq!(fs::read(outside).unwrap(), b"outside");
}

#[cfg(unix)]
const SLOT_LIMIT: usize = 1024;

#[cfg(unix)]
#[test]
fn history_source_slot_proves_nested_exact_spelling_and_survives_fresh_atomic_source_reads() {
    use std::fs;
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("project");
    fs::create_dir_all(path.join("Chapters/Überblick")).unwrap();
    fs::write(path.join("Chapters/Überblick/main.typ"), b"Old").unwrap();
    let root = RootedRoot::acquire(&path, &RootedRoot::observe(&path).unwrap()).unwrap();
    let group = root.source_group("Chapters/Überblick/main.typ").unwrap();
    let before = group.read_bytes(Member::Source, SLOT_LIMIT).unwrap();
    let first = group.history_source_slot(&before).unwrap();
    assert_eq!(
        first,
        super::super::history::SourceSlot::from_held_parent(&group.parent, "main.typ").unwrap()
    );
    fs::write(path.join("Chapters/Überblick/replacement"), b"New").unwrap();
    fs::rename(
        path.join("Chapters/Überblick/replacement"),
        path.join("Chapters/Überblick/main.typ"),
    )
    .unwrap();
    assert_eq!(error_code(group.history_source_slot(&before)), "stale");
    let fresh = group.read_bytes(Member::Source, SLOT_LIMIT).unwrap();
    assert_eq!(group.history_source_slot(&fresh).unwrap(), first);
    fs::rename(
        path.join("Chapters/Überblick"),
        path.join("Chapters/retired"),
    )
    .unwrap();
    fs::create_dir(path.join("Chapters/Überblick")).unwrap();
    fs::write(path.join("Chapters/Überblick/main.typ"), b"New").unwrap();
    assert_eq!(error_code(group.history_source_slot(&fresh)), "stale");
}

#[cfg(unix)]
#[test]
fn history_source_slot_refuses_wrong_member_group_absence_links_and_root_replacement() {
    use std::fs;
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("project");
    fs::create_dir(&path).unwrap();
    fs::write(path.join("main.typ"), b"Same").unwrap();
    fs::write(path.join("other.typ"), b"Same").unwrap();
    fs::write(path.join("main.typ.undertree-review.json"), b"{}").unwrap();
    let root = RootedRoot::acquire(&path, &RootedRoot::observe(&path).unwrap()).unwrap();
    let group = root.source_group("main.typ").unwrap();
    let source = group.read_bytes(Member::Source, SLOT_LIMIT).unwrap();
    let review = group.read_bytes(Member::Review, SLOT_LIMIT).unwrap();
    assert_eq!(error_code(group.history_source_slot(&review)), "scope");
    let other = root.source_group("other.typ").unwrap();
    assert_eq!(error_code(other.history_source_slot(&source)), "scope");
    let absent = root.source_group("missing.typ").unwrap();
    assert_eq!(
        error_code(
            absent.history_source_slot(&absent.read_bytes(Member::Source, SLOT_LIMIT).unwrap())
        ),
        "stale"
    );
    fs::hard_link(path.join("main.typ"), path.join("alias.typ")).unwrap();
    assert_eq!(error_code(group.history_source_slot(&source)), "stale");
    fs::remove_file(path.join("alias.typ")).unwrap();
    let fresh = group.read_bytes(Member::Source, SLOT_LIMIT).unwrap();
    fs::rename(path.join("main.typ"), path.join("original.typ")).unwrap();
    std::os::unix::fs::symlink(path.join("original.typ"), path.join("main.typ")).unwrap();
    assert_eq!(error_code(group.history_source_slot(&fresh)), "stale");
    fs::remove_file(path.join("main.typ")).unwrap();
    fs::rename(path.join("original.typ"), path.join("main.typ")).unwrap();
    let fresh = group.read_bytes(Member::Source, SLOT_LIMIT).unwrap();
    fs::rename(&path, temp.path().join("old-root")).unwrap();
    fs::create_dir(&path).unwrap();
    fs::write(path.join("main.typ"), b"Same").unwrap();
    assert_eq!(error_code(group.history_source_slot(&fresh)), "stale_root");
}

#[cfg(unix)]
#[test]
fn history_source_slot_entry_budget_is_total_across_parent_component_and_leaf_scans() {
    use std::fs;
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("project");
    fs::create_dir_all(path.join("nested")).unwrap();
    fs::write(path.join("nested/main.typ"), b"Source").unwrap();
    for index in 0..10_000 {
        fs::write(path.join(format!("ordinary-{index}")), b"").unwrap();
        fs::write(path.join("nested").join(format!("ordinary-{index}")), b"").unwrap();
    }
    let root = RootedRoot::acquire(&path, &RootedRoot::observe(&path).unwrap()).unwrap();
    let group = root.source_group("nested/main.typ").unwrap();
    let source = group.read_bytes(Member::Source, SLOT_LIMIT).unwrap();
    assert_eq!(error_code(group.history_source_slot(&source)), "limit");
    assert_eq!(fs::read(path.join("nested/main.typ")).unwrap(), b"Source");
    assert_eq!(fs::read_dir(&path).unwrap().count(), 10_001);
    assert_eq!(fs::read_dir(path.join("nested")).unwrap().count(), 10_001);
}

#[cfg(unix)]
#[test]
fn journal_retirement_requires_fresh_absence_and_syncs_before_confirming_after_uncertainty() {
    use std::fs;
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("project");
    fs::create_dir(&path).unwrap();
    fs::write(path.join("main.typ"), b"Source preserved").unwrap();
    fs::write(
        path.join("main.typ.undertree-review.json"),
        b"Opaque policy preserved",
    )
    .unwrap();
    fs::write(
        path.join("main.typ.undertree-pending.json"),
        b"Exact pending intent",
    )
    .unwrap();
    let root = RootedRoot::acquire(&path, &RootedRoot::observe(&path).unwrap()).unwrap();
    let group = root.source_group("main.typ").unwrap();
    let pending = group.read_bytes(Member::Journal, SLOT_LIMIT).unwrap();
    install(&group, Point::BeforeJournalSync, |_, _| {
        Err(Error::new(
            "io",
            "Injected parent sync failure after unlink",
        ))
    });
    assert_eq!(
        error_code(group.retire_journal(pending.expectation())),
        "outcome_unknown"
    );
    assert!(!path.join("main.typ.undertree-pending.json").exists());
    assert_eq!(
        error_code(group.retire_journal(pending.expectation())),
        "stale"
    );
    let absent = group.read_bytes(Member::Journal, SLOT_LIMIT).unwrap();
    assert!(absent.bytes().is_none());
    group.retire_journal(absent.expectation()).unwrap();
    assert_eq!(
        fs::read(path.join("main.typ")).unwrap(),
        b"Source preserved"
    );
    assert_eq!(
        fs::read(path.join("main.typ.undertree-review.json")).unwrap(),
        b"Opaque policy preserved"
    );
    fs::write(
        path.join("main.typ.undertree-pending.json"),
        b"Unknown replacement",
    )
    .unwrap();
    assert_eq!(
        error_code(group.retire_journal(absent.expectation())),
        "stale"
    );
    assert_eq!(
        fs::read(path.join("main.typ.undertree-pending.json")).unwrap(),
        b"Unknown replacement"
    );
    let source = group.read_bytes(Member::Source, SLOT_LIMIT).unwrap();
    assert_eq!(
        error_code(group.retire_journal(source.expectation())),
        "scope"
    );
}

#[cfg(unix)]
#[test]
fn absent_journal_confirmation_preserves_new_intent_and_denies_other_group_or_retargeted_parent() {
    use std::fs;
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("project");
    fs::create_dir_all(path.join("nested")).unwrap();
    fs::write(path.join("nested/main.typ"), b"Source").unwrap();
    fs::write(path.join("nested/other.typ"), b"Other").unwrap();
    let root = RootedRoot::acquire(&path, &RootedRoot::observe(&path).unwrap()).unwrap();
    let group = root.source_group("nested/main.typ").unwrap();
    let absent = group.read_bytes(Member::Journal, SLOT_LIMIT).unwrap();
    let other = root.source_group("nested/other.typ").unwrap();
    assert_eq!(
        error_code(other.retire_journal(absent.expectation())),
        "scope"
    );
    install(&group, Point::BeforeJournalSync, |group, _| {
        let mut create = options();
        create.write(true).create_new(true);
        group
            .parent
            .open_with(group.name(Member::Journal), &create)?
            .write_all(b"New independent intent")?;
        Ok(())
    });
    assert_eq!(
        error_code(group.retire_journal(absent.expectation())),
        "outcome_unknown"
    );
    assert_eq!(
        fs::read(path.join("nested/main.typ.undertree-pending.json")).unwrap(),
        b"New independent intent"
    );
    fs::remove_file(path.join("nested/main.typ.undertree-pending.json")).unwrap();
    let absent = group.read_bytes(Member::Journal, SLOT_LIMIT).unwrap();
    fs::rename(path.join("nested"), path.join("old-parent")).unwrap();
    fs::create_dir(path.join("nested")).unwrap();
    fs::write(
        path.join("nested/main.typ.undertree-pending.json"),
        b"Replacement parent intent",
    )
    .unwrap();
    assert_eq!(
        error_code(group.retire_journal(absent.expectation())),
        "stale"
    );
    assert_eq!(
        fs::read(path.join("nested/main.typ.undertree-pending.json")).unwrap(),
        b"Replacement parent intent"
    );
}
