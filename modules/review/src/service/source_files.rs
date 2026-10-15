//! Private source-group capabilities. Observations are optimistic, not filesystem transactions.
use super::project_tree;
use crate::RootObservation;
use crate::{Error, Result};
use cap_fs_ext::{DirExt, FollowSymlinks, MetadataExt, OpenOptionsFollowExt, OpenOptionsSyncExt};
#[cfg(unix)]
use cap_std::fs::Permissions;
use cap_std::fs::{Dir, Metadata, OpenOptions};
use sha2::{Digest, Sha256};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Component, Path, PathBuf};
use std::sync::Arc;

fn observed(metadata: &Metadata) -> RootObservation {
    RootObservation::new(MetadataExt::dev(metadata), MetadataExt::ino(metadata))
}

pub(crate) struct RootedRoot {
    directory: Dir,
    path: PathBuf,
    expected: RootObservation,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Member {
    Source,
    Review,
    Journal,
    ImportReport,
}

impl Member {
    fn suffix(self) -> &'static str {
        match self {
            Self::Source => "",
            Self::Review => ".undertree-review.json",
            Self::Journal => ".undertree-pending.json",
            Self::ImportReport => ".import-report.json",
        }
    }

    fn maximum(self) -> usize {
        crate::document::MAX_TEXT
            * match self {
                Self::Source => 1,
                Self::Review | Self::ImportReport => 8,
                Self::Journal => 9,
            }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct Stamp {
    identity: RootObservation,
    bytes: u64,
    modified: cap_std::time::SystemTime,
    changed: (i64, i64),
    mode: u32,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct Binding {
    root: RootObservation,
    parent: RootObservation,
    relative: String,
    member: Member,
}

/// Minted only by a checked read. It is not permission or an atomic compare-and-swap token.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct Expectation {
    binding: Binding,
    limit: usize,
    file: Option<(Stamp, [u8; 32])>,
}

#[derive(Debug)]
pub(super) struct ReadEntry {
    expectation: Expectation,
    bytes: Option<Vec<u8>>,
}

impl ReadEntry {
    pub(super) fn bytes(&self) -> Option<&[u8]> {
        self.bytes.as_deref()
    }
    pub(super) fn expectation(&self) -> &Expectation {
        &self.expectation
    }
    pub(super) fn text(&self) -> Result<Option<&str>> {
        self.bytes()
            .map(std::str::from_utf8)
            .transpose()
            .map_err(|_| Error::new("format", "The source-group file is not valid UTF-8."))
    }
}

/// A retained staging observation, never permission to unlink the current entry at this name.
#[derive(Debug)]
pub(super) struct TemporaryObservation {
    pub(super) name: String,
    pub(super) identity: Option<RootObservation>,
}

#[derive(Debug)]
pub(super) enum ReplaceOutcome {
    Durable(Expectation),
    Uncertain {
        publication_may_have_happened: bool,
        temporary: TemporaryObservation,
        error: Error,
    },
}

pub(super) struct SourceGroup {
    root: Arc<RootedRoot>,
    parent: Dir,
    parent_relative: String,
    parent_identity: RootObservation,
    relative: String,
    name: String,
    #[cfg(test)]
    hooks: std::sync::Mutex<tests::Hooks>,
}

fn stale_root() -> Error {
    Error::new(
        "stale_root",
        "The captured project folder changed or cannot be verified. Files were preserved.",
    )
}

fn changed() -> Error {
    Error::new(
        "stale",
        "The source-group entry changed or cannot be verified. Files were preserved.",
    )
}

fn supported() -> Result<()> {
    if cfg!(unix) {
        Ok(())
    } else {
        Err(Error::new(
            "unsupported",
            "Rooted source-group effects require a qualified Unix filesystem.",
        ))
    }
}

fn root_path(path: &Path) -> Result<()> {
    if !path.is_absolute()
        || path.components().collect::<PathBuf>().as_os_str() != path.as_os_str()
        || path
            .components()
            .any(|part| matches!(part, Component::CurDir | Component::ParentDir))
    {
        return Err(stale_root());
    }
    Ok(())
}

#[cfg(unix)]
fn unix_details(metadata: &Metadata) -> Result<(u32, (i64, i64))> {
    use cap_std::fs::MetadataExt as Unix;
    Ok((
        Unix::mode(metadata) & 0o7777,
        (Unix::ctime(metadata), Unix::ctime_nsec(metadata)),
    ))
}
#[cfg(not(unix))]
fn unix_details(_: &Metadata) -> Result<(u32, (i64, i64))> {
    supported()?;
    Err(changed())
}

fn stamp(metadata: &Metadata) -> Result<Stamp> {
    if !metadata.is_file() || MetadataExt::nlink(metadata) != 1 {
        return Err(changed());
    }
    let (mode, changed) = unix_details(metadata)?;
    Ok(Stamp {
        identity: observed(metadata),
        bytes: metadata.len(),
        modified: metadata.modified()?,
        changed,
        mode,
    })
}

fn options() -> OpenOptions {
    let mut options = OpenOptions::new();
    options.read(true).follow(FollowSymlinks::No).nonblock(true);
    options
}

fn limit(member: Member, bytes: usize) -> Result<()> {
    if bytes > member.maximum() {
        return Err(Error::new(
            "limit",
            "The source-group byte limit exceeds its supported bound.",
        ));
    }
    Ok(())
}

impl RootedRoot {
    pub(crate) fn observe(path: &Path) -> Result<RootObservation> {
        supported()?;
        root_path(path)?;
        Ok(observed(&project_tree::open_root(path)?.dir_metadata()?))
    }

    pub(crate) fn acquire(path: &Path, expected: &RootObservation) -> Result<Arc<Self>> {
        supported()?;
        root_path(path)?;
        let directory = project_tree::open_root(path).map_err(|_| stale_root())?;
        if observed(&directory.dir_metadata()?) != *expected {
            return Err(stale_root());
        }
        let root = Arc::new(Self {
            directory,
            path: path.to_owned(),
            expected: *expected,
        });
        root.check_current()?;
        Ok(root)
    }

    pub(crate) fn check_current(&self) -> Result<()> {
        if observed(&self.directory.dir_metadata()?) != self.expected
            || Self::observe(&self.path).map_err(|_| stale_root())? != self.expected
        {
            return Err(stale_root());
        }
        Ok(())
    }

    pub(crate) fn observation(&self) -> RootObservation {
        self.expected
    }
    pub(crate) fn directory(&self) -> Result<Dir> {
        self.check_current()?;
        Ok(self.directory.try_clone()?)
    }

    fn admit_staging(&self, sizes: &[usize]) -> Result<()> {
        let bytes = sizes
            .iter()
            .try_fold(0usize, |total, size| total.checked_add(*size))
            .ok_or_else(|| Error::new("limit", "Staging reservation overflow."))?;
        if sizes.len() > 3 || bytes > 36 * 1024 * 1024 {
            return Err(Error::new(
                "limit",
                "The source-group staging reservation exceeds its transaction bound.",
            ));
        }
        self.admit_staging_units(sizes.len(), bytes as u64)
    }

    pub(super) fn admit_import_staging(&self, bytes: usize) -> Result<()> {
        if bytes > 32 * 1024 * 1024 {
            return Err(Error::new("limit", "The complete import exceeds 32 MiB."));
        }
        self.admit_staging_units(1, bytes as u64)
    }

    fn admit_staging_units(&self, units: usize, reserved: u64) -> Result<()> {
        const BYTES: u64 = 64 * 1024 * 1024;
        fn unknown() -> Error {
            Error::new(
                "limit",
                "An unknown staging entry needs local inspection. It was preserved.",
            )
        }
        fn count_entry(entries: &mut usize) -> Result<()> {
            *entries += 1;
            if *entries > 20_000 {
                return Err(Error::new(
                    "limit",
                    "The source staging inventory exceeds 20000 entries.",
                ));
            }
            Ok(())
        }
        fn regular(metadata: &Metadata) -> Result<()> {
            if !metadata.is_file()
                || metadata.file_type().is_symlink()
                || MetadataExt::nlink(metadata) != 1
            {
                return Err(unknown());
            }
            Ok(())
        }
        fn walk(
            dir: &Dir,
            depth: usize,
            entries: &mut usize,
            dirs: &mut usize,
            count: &mut usize,
            bytes: &mut u64,
        ) -> Result<()> {
            *dirs += 1;
            if depth > 32 || *dirs > 2000 {
                return Err(Error::new(
                    "limit",
                    "Inspect the bounded project staging inventory before saving.",
                ));
            }
            for entry in dir.entries()? {
                count_entry(entries)?;
                let entry = entry?;
                let name = entry.file_name();
                let metadata = dir.symlink_metadata(&name)?;
                if name.to_string_lossy().starts_with(".undertree-compile-") {
                    regular(&metadata)?;
                    *count += 1;
                    *bytes = bytes.checked_add(metadata.len()).ok_or_else(unknown)?;
                } else if name
                    .to_string_lossy()
                    .starts_with(".undertree-build-import-")
                {
                    if !metadata.is_dir() || metadata.file_type().is_symlink() {
                        return Err(unknown());
                    }
                    let child = dir.open_dir_nofollow(&name).map_err(|_| unknown())?;
                    if observed(&metadata) != observed(&child.dir_metadata()?) {
                        return Err(changed());
                    }
                    *dirs += 1;
                    if *dirs > 2000 {
                        return Err(unknown());
                    }
                    *count += 1;
                    for (index, item) in child.entries()?.enumerate() {
                        count_entry(entries)?;
                        if index >= 64 {
                            return Err(unknown());
                        }
                        let item = item?;
                        let item_meta = child.symlink_metadata(item.file_name())?;
                        regular(&item_meta)?;
                        *bytes = bytes.checked_add(item_meta.len()).ok_or_else(unknown)?;
                    }
                    if observed(&metadata) != observed(&dir.symlink_metadata(&name)?) {
                        return Err(changed());
                    }
                } else if metadata.is_dir()
                    && !name.to_string_lossy().starts_with('.')
                    && name != "For-AI"
                    && name != "node_modules"
                {
                    let child = dir.open_dir_nofollow(&name).map_err(|_| changed())?;
                    if observed(&metadata) != observed(&child.dir_metadata()?) {
                        return Err(changed());
                    }
                    walk(&child, depth + 1, entries, dirs, count, bytes)?;
                    if observed(&metadata) != observed(&dir.symlink_metadata(&name)?) {
                        return Err(changed());
                    }
                }
                if *count > 8 || *bytes > BYTES {
                    return Err(Error::new("limit", "Retained project staging exceeds eight units or 64 MiB. Inspect it locally; no files were removed."));
                }
            }
            Ok(())
        }
        self.check_current()?;
        let (mut entries, mut dirs, mut count, mut bytes) = (0, 0, 0, 0);
        walk(
            &self.directory,
            0,
            &mut entries,
            &mut dirs,
            &mut count,
            &mut bytes,
        )?;
        if count + units > 8 || bytes + reserved > BYTES {
            return Err(Error::new("limit", "There is insufficient bounded staging space for this operation. Existing files were preserved."));
        }
        self.check_current()
    }

    pub(crate) fn has_pending(self: &Arc<Self>, relative: &str) -> Result<bool> {
        Ok(self
            .source_group(relative)?
            .read_bytes(Member::Journal, Member::Journal.maximum())?
            .bytes()
            .is_some())
    }

    pub(super) fn source_group(self: &Arc<Self>, relative: &str) -> Result<SourceGroup> {
        let (parent_relative, name) = super::source_path::validate_source_path(relative)?;
        self.check_current()?;
        let parent = project_tree::open_directory(&self.directory, parent_relative)
            .map_err(|_| changed())?;
        let parent_identity = observed(&parent.dir_metadata()?);
        let group = SourceGroup {
            root: self.clone(),
            parent,
            parent_relative: parent_relative.into(),
            parent_identity,
            relative: relative.into(),
            name: name.into(),
            #[cfg(test)]
            hooks: Default::default(),
        };
        group.check_current()?;
        Ok(group)
    }
}

impl SourceGroup {
    pub(super) fn require_import_parent(&self, parent: &Dir) -> Result<()> {
        self.check_current()?;
        if observed(&parent.dir_metadata()?) != self.parent_identity {
            return Err(changed());
        }
        self.check_current()
    }

    pub(super) fn require_unaliased_creation(
        &self,
        project: &super::Project,
        approved: &[super::Project],
    ) -> Result<()> {
        let refusal = || {
            Error::new("alias_conflict", "This source destination is covered by another approved project. Choose a destination with one project identity.")
        };
        self.check_current()?;
        if project.root != self.root.path
            || !approved
                .iter()
                .any(|p| p.id == project.id && p.root == project.root)
            || approved.len() > 100
        {
            return Err(refusal());
        }
        let absolute = project.root.join(&self.relative);
        for other in approved.iter().filter(|other| other.id != project.id) {
            let nominated = absolute.strip_prefix(&other.root).ok();
            let root = match RootedRoot::observe(&other.root) {
                Ok(root) => root,
                Err(_) if nominated.is_some() => return Err(refusal()),
                Err(_) => continue,
            };
            // shortcut: canonical/equal-root nominations, not arbitrary bind-mount topology.
            let relative = match nominated {
                Some(relative) => relative.to_str().ok_or_else(refusal)?,
                None if root == self.root.observation() => self.relative.as_str(),
                None => continue,
            };
            let alternate = RootedRoot::acquire(&other.root, &root)
                .and_then(|root| root.source_group(relative))
                .map_err(|_| refusal())?;
            self.check_current()?;
            alternate.check_current().map_err(|_| refusal())?;
            if alternate.parent_identity == self.parent_identity && alternate.name == self.name {
                return Err(refusal());
            }
            // A nominated canonical slot with a different parent cannot be proved safe.
            return Err(changed());
        }
        self.check_current()
    }

    pub(super) fn check_current(&self) -> Result<()> {
        self.root.check_current()?;
        let current = project_tree::open_directory(&self.root.directory, &self.parent_relative)
            .map_err(|_| changed())?;
        if observed(&current.dir_metadata()?) != self.parent_identity
            || observed(&self.parent.dir_metadata()?) != self.parent_identity
        {
            return Err(changed());
        }
        self.root.check_current()
    }

    pub(super) fn observation(&self) -> RootObservation {
        self.root.observation()
    }
    pub(super) fn admit_staging(&self, sizes: &[usize]) -> Result<()> {
        self.root.admit_staging(sizes)
    }

    fn binding(&self, member: Member) -> Binding {
        Binding {
            root: self.root.expected,
            parent: self.parent_identity,
            relative: self.relative.clone(),
            member,
        }
    }

    fn name(&self, member: Member) -> String {
        format!("{}{}", self.name, member.suffix())
    }

    pub(super) fn read_bytes(&self, member: Member, maximum: usize) -> Result<ReadEntry> {
        limit(member, maximum)?;
        self.check_current()?;
        let name = self.name(member);
        let first = match self.parent.symlink_metadata(&name) {
            Ok(metadata) => stamp(&metadata)?,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                self.check_current()?;
                if !self
                    .parent
                    .symlink_metadata(&name)
                    .is_err_and(|error| error.kind() == std::io::ErrorKind::NotFound)
                {
                    return Err(changed());
                }
                return Ok(ReadEntry {
                    expectation: Expectation {
                        binding: self.binding(member),
                        limit: maximum,
                        file: None,
                    },
                    bytes: None,
                });
            }
            Err(error) => return Err(error.into()),
        };
        if first.bytes > maximum as u64 {
            return Err(Error::new(
                "limit",
                "The source-group file exceeds its byte limit.",
            ));
        }
        #[cfg(test)]
        tests::run(self, tests::Point::BeforeReadOpen, &name)?;
        let mut file = self.parent.open_with(&name, &options())?;
        if stamp(&file.metadata()?)? != first {
            return Err(changed());
        }
        let mut bytes = Vec::new();
        bytes.try_reserve(first.bytes as usize).map_err(|_| {
            Error::new(
                "limit",
                "The bounded source-group read could not reserve memory.",
            )
        })?;
        (&mut file)
            .take(maximum as u64 + 1)
            .read_to_end(&mut bytes)?;
        if bytes.len() > maximum {
            return Err(Error::new(
                "limit",
                "The source-group file exceeds its byte limit.",
            ));
        }
        #[cfg(test)]
        tests::run(self, tests::Point::AfterRead, &name)?;
        if bytes.len() as u64 != first.bytes
            || stamp(&file.metadata()?)? != first
            || stamp(&self.parent.symlink_metadata(&name)?)? != first
        {
            return Err(changed());
        }
        self.check_current()?;
        Ok(ReadEntry {
            expectation: Expectation {
                binding: self.binding(member),
                limit: maximum,
                file: Some((first, Sha256::digest(&bytes).into())),
            },
            bytes: Some(bytes),
        })
    }

    pub(super) fn read_utf8(&self, member: Member, maximum: usize) -> Result<ReadEntry> {
        let entry = self.read_bytes(member, maximum)?;
        entry.text()?;
        Ok(entry)
    }

    fn require(&self, member: Member, expected: &Expectation) -> Result<()> {
        if expected.binding != self.binding(member) {
            return Err(Error::new(
                "scope",
                "The observation belongs to another source-group member.",
            ));
        }
        if self.read_bytes(member, expected.limit)?.expectation != *expected {
            return Err(changed());
        }
        Ok(())
    }

    /// Optimistic replace, not conditional rename: an external writer can replace the leaf after
    /// the final check. Rename replaces that entry without following it; held parents never retarget.
    pub(super) fn verify(&self, member: Member, expected: &Expectation) -> Result<()> {
        self.require(member, expected)
    }

    /// A slot identifies this exact held directory entry; it is not native producer authority.
    pub(super) fn history_source_slot(
        &self,
        source: &ReadEntry,
    ) -> Result<super::history::SourceSlot> {
        if source.bytes().is_none() {
            return Err(changed());
        }
        self.verify(Member::Source, source.expectation())?;
        self.check_current()?;
        let mut directory = self.root.directory()?;
        let mut inspected = 0;
        let mut parts = self.relative.split('/').peekable();
        while let Some(part) = parts.next() {
            let mut exact = false;
            for entry in directory.entries()? {
                inspected += 1;
                if inspected > 20_000 {
                    return Err(Error::new(
                        "limit",
                        "The exact source-slot spelling check exceeds 20000 directory entries.",
                    ));
                }
                if entry?.file_name() == std::ffi::OsStr::new(part) {
                    exact = true;
                }
            }
            if !exact {
                return Err(changed());
            }
            let entry = directory.symlink_metadata(part)?;
            if parts.peek().is_some() {
                if !entry.is_dir() || entry.file_type().is_symlink() {
                    return Err(changed());
                }
                let child = directory.open_dir_nofollow(part).map_err(|_| changed())?;
                if observed(&entry) != observed(&child.dir_metadata()?) {
                    return Err(changed());
                }
                directory = child;
            } else if observed(&directory.dir_metadata()?) != self.parent_identity
                || stamp(&entry)? != source.expectation.file.as_ref().ok_or_else(changed)?.0
            {
                return Err(changed());
            }
        }
        self.verify(Member::Source, source.expectation())?;
        self.check_current()?;
        super::history::SourceSlot::from_held_parent(&self.parent, &self.name)
    }

    pub(super) fn create_new(
        &self,
        outputs: &[(Member, &[u8])],
        reserve_epoch: impl FnOnce() -> Result<()>,
        #[cfg(test)] mut hook: Option<super::PublicationHook>,
    ) -> Result<()> {
        if outputs.is_empty()
            || outputs.len() > 3
            || outputs.iter().any(|(member, _)| *member == Member::Journal)
        {
            return Err(Error::new(
                "format",
                "Use only the fixed new source, review and import report outputs.",
            ));
        }
        let mut checked = Vec::new();
        for (member, bytes) in outputs {
            limit(*member, bytes.len())?;
            let entry = self.read_bytes(*member, member.maximum())?;
            if entry.bytes().is_some() {
                return Err(Error::new(
                    "conflict",
                    "The destination or its metadata already exists. It was preserved.",
                ));
            }
            checked.push(entry);
        }
        if self
            .read_bytes(Member::Journal, Member::Journal.maximum())?
            .bytes()
            .is_some()
        {
            return Err(Error::new(
                "conflict",
                "A pending save already owns the new destination.",
            ));
        }
        self.admit_staging(
            &outputs
                .iter()
                .map(|(_, bytes)| bytes.len())
                .collect::<Vec<_>>(),
        )?;
        let mut staged = Vec::new();
        let mut published = false;
        let result = (|| -> Result<()> {
            for ((member, bytes), expected) in outputs.iter().zip(&checked) {
                self.require(*member, expected.expectation())?;
                let name = format!(".undertree-compile-{}.tmp", uuid::Uuid::new_v4());
                let mut create = options();
                create.write(true).create_new(true);
                #[cfg(unix)]
                {
                    use cap_std::fs::OpenOptionsExt;
                    create.mode(0o600);
                }
                let mut file = self.parent.open_with(&name, &create)?;
                file.write_all(bytes)?;
                file.sync_all()?;
                let metadata = file.metadata()?;
                let identity = observed(&metadata);
                if !metadata.is_file()
                    || MetadataExt::nlink(&metadata) != 1
                    || observed(&self.parent.symlink_metadata(&name)?) != identity
                {
                    return Err(changed());
                }
                file.seek(SeekFrom::Start(0))?;
                let mut actual = Vec::new();
                file.take(bytes.len() as u64 + 1).read_to_end(&mut actual)?;
                if actual != *bytes {
                    return Err(changed());
                }
                staged.push((name, identity));
            }
            self.check_current()?;
            for ((member, _), expected) in outputs.iter().zip(&checked) {
                self.require(*member, expected.expectation())?;
            }
            reserve_epoch()?;
            self.check_current()?;
            for (((member, bytes), expected), (name, identity)) in
                outputs.iter().zip(&checked).zip(&staged)
            {
                self.require(*member, expected.expectation())?;
                self.check_current()?;
                self.parent
                    .hard_link(name, &self.parent, self.name(*member))?;
                published = true;
                if observed(&self.parent.symlink_metadata(self.name(*member))?) != *identity
                    || observed(&self.parent.symlink_metadata(name)?) != *identity
                {
                    return Err(changed());
                }
                self.check_current()?;
                // shortcut: exact staging check/unlink is optimistic against external writers, as journal retirement is.
                self.parent.remove_file(name)?;
                self.parent.open(".")?.sync_all()?;
                let installed = self.read_bytes(*member, member.maximum())?;
                if installed.bytes() != Some(*bytes) {
                    return Err(changed());
                }
                #[cfg(test)]
                if let Some(hook) = hook.take() {
                    hook()?;
                }
            }
            self.check_current()
        })();
        result.map_err(|error| if published { Error::new("outcome_unknown", "Creation stopped after publication. Complete outputs and staging were preserved; inspect the destination before retrying.") } else { error })
    }

    pub(super) fn retire_journal(&self, expected: &Expectation) -> Result<()> {
        self.require(Member::Journal, expected)?;
        self.check_current()?;
        if expected.file.is_some() {
            // shortcut: external replacement between this check and unlink is not atomic; stronger CAS needs a platform primitive.
            self.parent.remove_file(self.name(Member::Journal)).map_err(|_| Error::new("outcome_unknown", "Pending-save retirement could not be confirmed. Inspect the preserved save before retrying."))?;
        }
        let verified = (|| -> Result<()> {
            #[cfg(test)]
            tests::run(
                self,
                tests::Point::BeforeJournalSync,
                &self.name(Member::Journal),
            )?;
            self.parent.open(".")?.sync_all()?;
            if self
                .read_bytes(Member::Journal, Member::Journal.maximum())?
                .bytes()
                .is_some()
            {
                return Err(changed());
            }
            self.check_current()
        })();
        verified.map_err(|_| Error::new("outcome_unknown", "The save completed, but pending-save retirement is uncertain. Inspect it before retrying."))
    }

    pub(super) fn replace(
        &self,
        member: Member,
        expected: &Expectation,
        bytes: &[u8],
        maximum: usize,
        guards: &[(Member, &Expectation)],
    ) -> Result<ReplaceOutcome> {
        limit(member, maximum)?;
        if bytes.len() > maximum {
            return Err(Error::new(
                "limit",
                "The replacement exceeds its byte limit.",
            ));
        }
        self.require(member, expected)?;
        for (member, expected) in guards {
            self.require(*member, expected)?;
        }
        let name = format!(".undertree-compile-{}.tmp", uuid::Uuid::new_v4());
        #[cfg(test)]
        tests::run(self, tests::Point::BeforeCreate, &name)?;
        let mut create = options();
        create.write(true).create_new(true);
        #[cfg(unix)]
        {
            use cap_std::fs::OpenOptionsExt;
            create.mode(0o600);
        }
        let mut file = self.parent.open_with(&name, &create)?;
        let identity = file.metadata().ok().map(|metadata| observed(&metadata));
        let temporary = TemporaryObservation {
            name: name.clone(),
            identity,
        };
        let intended_mode = expected
            .file
            .as_ref()
            .map_or(0o600, |(stamp, _)| stamp.mode & 0o777);
        let staged = (|| -> Result<()> {
            let initial = stamp(&file.metadata()?)?;
            if stamp(&self.parent.symlink_metadata(&name)?)? != initial {
                return Err(changed());
            }
            file.write_all(bytes)?;
            #[cfg(unix)]
            {
                use cap_std::fs::PermissionsExt;
                file.set_permissions(Permissions::from_mode(intended_mode))?;
            }
            file.sync_all()?;
            let synced = stamp(&file.metadata()?)?;
            if synced.mode != intended_mode {
                return Err(changed());
            }
            #[cfg(test)]
            tests::run(self, tests::Point::BeforeFinalCheck, &name)?;
            self.require(member, expected)?;
            for (member, expected) in guards {
                self.require(*member, expected)?;
            }
            let current = stamp(&file.metadata()?)?;
            if current != synced
                || Some(&current.identity) != identity.as_ref()
                || current.bytes != bytes.len() as u64
                || stamp(&self.parent.symlink_metadata(&name)?)? != current
            {
                return Err(changed());
            }
            file.seek(SeekFrom::Start(0))?;
            let mut remaining = bytes;
            let mut chunk = [0; 64 * 1024];
            while !remaining.is_empty() {
                let size = remaining.len().min(chunk.len());
                file.read_exact(&mut chunk[..size])?;
                if chunk[..size] != remaining[..size] {
                    return Err(changed());
                }
                remaining = &remaining[size..];
            }
            if stamp(&file.metadata()?)? != current
                || stamp(&self.parent.symlink_metadata(&name)?)? != current
            {
                return Err(changed());
            }
            self.check_current()?;
            Ok(())
        })();
        if let Err(error) = staged {
            return Ok(ReplaceOutcome::Uncertain {
                publication_may_have_happened: false,
                temporary,
                error,
            });
        }
        let published = (|| -> Result<Expectation> {
            #[cfg(test)]
            tests::run(self, tests::Point::AfterFinalCheck, &name)?;
            self.parent.rename(&name, &self.parent, self.name(member))?;
            #[cfg(test)]
            tests::run(self, tests::Point::AfterRename, &name)?;
            self.parent.open(".")?.sync_all()?;
            let installed = self.read_bytes(member, maximum)?;
            if installed.bytes() != Some(bytes)
                || installed
                    .expectation
                    .file
                    .as_ref()
                    .is_none_or(|(stamp, _)| {
                        Some(&stamp.identity) != identity.as_ref() || stamp.mode != intended_mode
                    })
            {
                return Err(changed());
            }
            self.check_current()?;
            Ok(installed.expectation)
        })();
        match published {
            Ok(observation) => Ok(ReplaceOutcome::Durable(observation)),
            Err(_) => Ok(ReplaceOutcome::Uncertain { publication_may_have_happened: true, temporary,
                error: Error::new("outcome_unknown", "The source-group replacement may be installed. Files were preserved; do not retry automatically.") }),
        }
    }
}

#[cfg(test)]
mod tests;
