//! Only fixed source-group members may be relocated, never an arbitrary path.
use super::*;
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(in super::super) enum MoveMember {
    Source,
    Review,
    ImportReport,
}
impl MoveMember {
    fn member(self) -> Member {
        match self {
            Self::Source => Member::Source,
            Self::Review => Member::Review,
            Self::ImportReport => Member::ImportReport,
        }
    }
    pub(in super::super) fn suffix(self) -> &'static str {
        self.member().suffix()
    }
    pub(in super::super) fn blob(self) -> &'static str {
        match self {
            Self::Source => "source",
            Self::Review => "review",
            Self::ImportReport => "report",
        }
    }
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(in super::super) struct MoveFile {
    pub member: MoveMember,
    pub identity: RootObservation,
    pub bytes: u64,
    pub sha256: String,
    pub mode: u32,
    pub changed: (i64, i64),
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(in super::super) struct MoveBundle {
    pub root: RootObservation,
    pub from_parent: RootObservation,
    pub to_parent: RootObservation,
    pub from: String,
    pub to: String,
    pub files: Vec<MoveFile>,
}
pub(in super::super) struct MoveLocation {
    pub moved: bool,
    stamp: Stamp,
}

fn unresolved() -> Error {
    Error::new("move_unresolved", "The accepted move cannot prove the original files' location. Every actual name and the original intent were preserved.")
}
fn sha(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
fn regular(metadata: &Metadata, proof: &MoveFile) -> Result<()> {
    let current = stamp(metadata)?;
    if current.identity != proof.identity
        || current.bytes != proof.bytes
        || current.mode != proof.mode
        || current.mode & 0o7111 != 0
    {
        return Err(unresolved());
    }
    Ok(())
}
impl SourceGroup {
    pub(in super::super) fn admit_move_filesystem(&self, destination: &Self) -> Result<()> {
        self.check_current()?;
        destination.check_current()?;
        if self.observation() != destination.observation()
            || self.parent_identity.dev != destination.parent_identity.dev
        {
            return Err(Error::new(
                "unsupported",
                "Move requires one qualified local filesystem.",
            ));
        }
        #[cfg(all(target_os = "linux", target_env = "gnu"))]
        {
            for parent in [&self.parent, &destination.parent] {
                let filesystem =
                    nix::sys::statfs::fstatfs(parent).map_err(|_| unsupported_move_fs())?;
                if filesystem.filesystem_type() != nix::sys::statfs::FsType(0xEF53) {
                    return Err(unsupported_move_fs());
                }
                require_ext4_mount(parent)?;
            }
            Ok(())
        }
        #[cfg(not(all(target_os = "linux", target_env = "gnu")))]
        Err(Error::new(
            "unsupported",
            "This first Move implementation supports qualified ext4 filesystems on Linux GNU only.",
        ))
    }
    pub(in super::super) fn capture_move_bundle(
        &self,
        destination: &Self,
    ) -> Result<(MoveBundle, Vec<Vec<u8>>)> {
        self.admit_move_filesystem(destination)?;
        for group in [self, destination] {
            if group
                .read_bytes(Member::Journal, Member::Journal.maximum())?
                .bytes()
                .is_some()
            {
                return Err(Error::new(
                    "recovery_conflict",
                    "Resolve the source group's pending save before moving it.",
                ));
            }
        }
        let mut files = Vec::new();
        let mut blobs = Vec::new();
        let mut total = 0usize;
        for member in [
            MoveMember::Source,
            MoveMember::Review,
            MoveMember::ImportReport,
        ] {
            if destination
                .read_bytes(member.member(), member.member().maximum())?
                .bytes()
                .is_some()
            {
                return Err(Error::new(
                    "exists",
                    "A destination source-group name already exists.",
                ));
            }
            let entry = self.read_bytes(member.member(), member.member().maximum())?;
            let Some(bytes) = entry.bytes() else {
                if member == MoveMember::Source {
                    return Err(unresolved());
                }
                continue;
            };
            let (stamp, _) = entry.expectation.file.as_ref().ok_or_else(unresolved)?;
            if stamp.mode & 0o7111 != 0 {
                return Err(Error::new(
                    "unsupported",
                    "Move currently accepts ordinary non-executable source-group files only.",
                ));
            }
            total = total.checked_add(bytes.len()).ok_or_else(unresolved)?;
            if total > 32 * 1024 * 1024 {
                return Err(Error::new(
                    "limit",
                    "The complete Move bundle exceeds 32 MiB.",
                ));
            }
            files.push(MoveFile {
                member,
                identity: stamp.identity,
                bytes: stamp.bytes,
                sha256: sha(bytes),
                mode: stamp.mode,
                changed: stamp.changed,
            });
            blobs.push(bytes.to_vec());
        }
        self.check_current()?;
        destination.check_current()?;
        Ok((
            MoveBundle {
                root: self.observation(),
                from_parent: self.parent_identity,
                to_parent: destination.parent_identity,
                from: self.relative.clone(),
                to: destination.relative.clone(),
                files,
            },
            blobs,
        ))
    }
    fn check_move_binding(&self, destination: &Self, bundle: &MoveBundle) -> Result<()> {
        self.admit_move_filesystem(destination)?;
        if bundle.root != self.observation()
            || bundle.from != self.relative
            || bundle.to != destination.relative
            || bundle.from_parent != self.parent_identity
            || bundle.to_parent != destination.parent_identity
            || bundle.files.is_empty()
            || bundle.files.len() > 3
            || bundle.files[0].member != MoveMember::Source
        {
            return Err(unresolved());
        }
        Ok(())
    }
    /// Metadata-only final check; hashes were observed outside live mutexes.
    pub(in super::super) fn verify_move_metadata(
        &self,
        destination: &Self,
        bundle: &MoveBundle,
        locations: &[MoveLocation],
    ) -> Result<()> {
        self.check_move_binding(destination, bundle)?;
        if locations.len() != bundle.files.len() {
            return Err(unresolved());
        }
        for group in [self, destination] {
            if !group
                .parent
                .symlink_metadata(group.name(Member::Journal))
                .is_err_and(|e| e.kind() == std::io::ErrorKind::NotFound)
            {
                return Err(unresolved());
            }
        }
        for member in [
            MoveMember::Source,
            MoveMember::Review,
            MoveMember::ImportReport,
        ] {
            let original = self.parent.symlink_metadata(self.name(member.member()));
            let target = destination
                .parent
                .symlink_metadata(destination.name(member.member()));
            let absent = |r: &std::io::Result<Metadata>| {
                r.as_ref()
                    .is_err_and(|e| e.kind() == std::io::ErrorKind::NotFound)
            };
            if let Some(index) = bundle.files.iter().position(|f| f.member == member) {
                let proof = &bundle.files[index];
                let (present, missing) = if locations[index].moved {
                    (&target, &original)
                } else {
                    (&original, &target)
                };
                if !absent(missing) {
                    return Err(unresolved());
                }
                let metadata = present.as_ref().map_err(|_| unresolved())?;
                regular(metadata, proof)?;
                if stamp(metadata)? != locations[index].stamp
                    || (!locations[index].moved && stamp(metadata)?.changed != proof.changed)
                {
                    return Err(unresolved());
                }
            } else if !absent(&original) || !absent(&target) {
                return Err(unresolved());
            }
        }
        self.check_move_binding(destination, bundle)
    }
    /// Full byte proof outside live editor/document locks. Each member is exclusively at one original slot.
    pub(in super::super) fn observe_move_bundle(
        &self,
        destination: &Self,
        bundle: &MoveBundle,
    ) -> Result<Vec<MoveLocation>> {
        self.check_move_binding(destination, bundle)?;
        for group in [self, destination] {
            if group
                .read_bytes(Member::Journal, Member::Journal.maximum())?
                .bytes()
                .is_some()
            {
                return Err(unresolved());
            }
        }
        let mut locations = Vec::new();
        for member in [
            MoveMember::Source,
            MoveMember::Review,
            MoveMember::ImportReport,
        ] {
            let from = self.read_bytes(member.member(), member.member().maximum())?;
            let to = destination.read_bytes(member.member(), member.member().maximum())?;
            match bundle.files.iter().find(|file| file.member == member) {
                Some(proof) => {
                    let (entry, moved) = match (from.bytes(), to.bytes()) {
                        (Some(_), None) => (from, false),
                        (None, Some(_)) => (to, true),
                        _ => return Err(unresolved()),
                    };
                    let (stamp, _) = entry.expectation.file.as_ref().ok_or_else(unresolved)?;
                    if stamp.identity != proof.identity
                        || stamp.bytes != proof.bytes
                        || stamp.mode != proof.mode
                        || sha(entry.bytes().ok_or_else(unresolved)?) != proof.sha256
                    {
                        return Err(unresolved());
                    }
                    locations.push(MoveLocation {
                        moved,
                        stamp: stamp.clone(),
                    });
                }
                None if from.bytes().is_none() && to.bytes().is_none() => (),
                None => return Err(unresolved()),
            }
        }
        self.check_move_binding(destination, bundle)?;
        Ok(locations)
    }
    /// Optimistic metadata check, atomic no-clobber relocation, then directory durability. It is not source CAS.
    pub(in super::super) fn relocate_move_member(
        &self,
        destination: &Self,
        bundle: &MoveBundle,
        index: usize,
        moved: bool,
    ) -> Result<()> {
        self.check_move_binding(destination, bundle)?;
        let proof = bundle.files.get(index).ok_or_else(unresolved)?;
        let name = self.name(proof.member.member());
        let target = destination.name(proof.member.member());
        let absent = |group: &Self, name: &str| -> Result<()> {
            if !group
                .parent
                .symlink_metadata(name)
                .is_err_and(|e| e.kind() == std::io::ErrorKind::NotFound)
            {
                return Err(unresolved());
            }
            Ok(())
        };
        if moved {
            absent(self, &name)?;
            regular(&destination.parent.symlink_metadata(&target)?, proof)?;
        } else {
            let metadata = self.parent.symlink_metadata(&name)?;
            regular(&metadata, proof)?;
            if stamp(&metadata)?.changed != proof.changed {
                return Err(unresolved());
            }
            absent(destination, &target)?;
            #[cfg(all(target_os = "linux", target_env = "gnu"))]
            nix::fcntl::renameat2(
                &self.parent,
                name.as_str(),
                &destination.parent,
                target.as_str(),
                nix::fcntl::RenameFlags::RENAME_NOREPLACE,
            )
            .map_err(|_| unresolved())?;
            #[cfg(not(all(target_os = "linux", target_env = "gnu")))]
            return Err(Error::new(
                "unsupported",
                "Atomic no-replace relocation is unsupported on this platform.",
            ));
        }
        self.parent.open(".")?.sync_all()?;
        destination.parent.open(".")?.sync_all()?;
        absent(self, &name)?;
        regular(&destination.parent.symlink_metadata(&target)?, proof)?;
        self.check_move_binding(destination, bundle)
    }
}

#[cfg(all(target_os = "linux", target_env = "gnu"))]
fn unsupported_move_fs() -> Error {
    Error::new("unsupported","The actual retained Move parents must identify one qualified ext4 mount on Linux GNU. No files were moved.")
}
#[cfg(all(target_os = "linux", target_env = "gnu"))]
fn selected_ext4_mount(fdinfo: &[u8], mountinfo: &[u8]) -> Result<()> {
    fn id(bytes: &[u8]) -> Option<u64> {
        let value = std::str::from_utf8(bytes).ok()?;
        value.parse::<u64>().ok().filter(|n| n.to_string() == value)
    }
    let mut selected = None;
    for line in fdinfo.split(|b| *b == b'\n') {
        if let Some(value) = line.strip_prefix(b"mnt_id:") {
            let words = value
                .split(|b| b.is_ascii_whitespace())
                .filter(|s| !s.is_empty())
                .collect::<Vec<_>>();
            if selected.is_some() || words.len() != 1 {
                return Err(unsupported_move_fs());
            }
            selected = Some(id(words[0]).ok_or_else(unsupported_move_fs)?);
        }
    }
    let selected = selected.ok_or_else(unsupported_move_fs)?;
    let mut found = false;
    for line in mountinfo.split(|b| *b == b'\n') {
        let first = line.split(|b| *b == b' ').next().unwrap_or_default();
        if id(first) != Some(selected) {
            continue;
        }
        if found {
            return Err(unsupported_move_fs());
        }
        found = true;
        let separator = line
            .windows(3)
            .position(|bytes| bytes == b" - ")
            .ok_or_else(unsupported_move_fs)?;
        if line[..separator].split(|b| *b == b' ').count() < 6 {
            return Err(unsupported_move_fs());
        }
        let fields = line[separator + 3..]
            .split(|b| *b == b' ')
            .collect::<Vec<_>>();
        if fields.len() != 3 || fields[0] != b"ext4" || fields[1].is_empty() || fields[2].is_empty()
        {
            return Err(unsupported_move_fs());
        }
    }
    if !found {
        return Err(unsupported_move_fs());
    }
    Ok(())
}
#[cfg(all(target_os = "linux", target_env = "gnu"))]
fn require_ext4_mount(parent: &Dir) -> Result<()> {
    use std::os::fd::AsRawFd;
    fn read(path: &Path, limit: usize) -> Result<Vec<u8>> {
        let mut bytes = Vec::new();
        std::fs::File::open(path)
            .map_err(|_| unsupported_move_fs())?
            .take(limit as u64 + 1)
            .read_to_end(&mut bytes)
            .map_err(|_| unsupported_move_fs())?;
        if bytes.len() > limit {
            return Err(unsupported_move_fs());
        }
        Ok(bytes)
    }
    let info = read(
        Path::new(&format!("/proc/self/fdinfo/{}", parent.as_raw_fd())),
        4096,
    )?;
    let mounts = read(Path::new("/proc/self/mountinfo"), 1024 * 1024)?;
    selected_ext4_mount(&info, &mounts)
}
#[cfg(all(test, target_os = "linux", target_env = "gnu"))]
mod move_mount_tests {
    use super::*;
    #[test]
    fn mount_admission_selects_exact_retained_fd_mount_and_refuses_ambiguity() {
        let info = b"pos:\t0\nflags:\t0100000\nmnt_id:\t42\n";
        let mounted =
            b"41 1 8:1 / /other rw - ext4 /dev/a rw\n42 1 8:2 / /selected rw - ext4 /dev/b rw\n";
        selected_ext4_mount(info, mounted).unwrap();
        for bad in [
            b"41 1 8:1 / /other rw - ext4 /dev/a rw\n42 1 0:2 / /selected rw - tmpfs tmpfs rw\n"
                .as_slice(),
            b"42 1 8:2 / /a rw - ext4 /dev/b rw\n42 1 8:2 / /b rw - ext4 /dev/b rw\n",
            b"41 1 8:1 / /other rw - ext4 /dev/a rw\n",
            b"42 - ext4 /dev/b rw\n",
        ] {
            assert_eq!(
                selected_ext4_mount(info, bad).unwrap_err().code,
                "unsupported"
            );
        }
        assert!(selected_ext4_mount(b"mnt_id: 42\nmnt_id: 42\n", mounted).is_err());
        assert!(selected_ext4_mount(b"mnt_id: 042\n", mounted).is_err());
    }
}
