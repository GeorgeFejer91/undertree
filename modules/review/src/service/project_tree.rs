use super::*;
use cap_fs_ext::{DirExt, MetadataExt};
use cap_std::fs::{Dir, Metadata};

mod typst_sources;

pub(super) fn context_paths(
    root: &Arc<RootedRoot>,
    project: &Project,
    active: &str,
) -> Result<(String, BTreeSet<String>)> {
    if active.ends_with(".typ") {
        let main = if project.main_document.is_empty() {
            active
        } else {
            &project.main_document
        };
        let (main, paths) = typst_sources::discover_context(root, main).complete_paths()?;
        if !paths.contains(active) {
            return Err(Error::new("context_scope", "The active source is outside the selected main manuscript. Choose its main document locally."));
        }
        Ok((main, paths))
    } else if active.ends_with(".html") || active.ends_with(".htm") {
        Ok((active.into(), BTreeSet::from([active.into()])))
    } else {
        Err(Error::new(
            "context_incomplete",
            "Complete review context is supported for Typst and self-contained HTML sources.",
        ))
    }
}

#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
struct Limits {
    max_depth: usize,
    max_entries: usize,
    max_directories: usize,
    max_path_bytes: usize,
    max_response_bytes: usize,
}

const LIMITS: Limits = Limits {
    max_depth: 32,
    max_entries: 20_000,
    max_directories: 2000,
    max_path_bytes: 4096,
    max_response_bytes: 4 * 1024 * 1024,
};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct TreeEntry {
    path: String,
    kind: &'static str,
    editable: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    source_epoch: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    bytes: Option<u64>,
}

struct Inventory {
    entries: Vec<TreeEntry>,
    visited: usize,
    directories: usize,
    response_bytes: usize,
    truncated: bool,
    omitted_non_utf8: usize,
    limits: Limits,
}

fn changed() -> Error {
    Error::new("path", "The project folder changed while this operation was running. Refresh or approve its current location again.")
}

fn same_directory(first: &Metadata, second: &Metadata) -> bool {
    first.dev() == second.dev() && first.ino() == second.ino()
}

pub(super) fn open_root(root: &Path) -> Result<Dir> {
    let anchor = root.ancestors().last().ok_or_else(changed)?;
    let mut directory = Dir::open_ambient_dir(anchor, cap_std::ambient_authority())?;
    for component in root
        .strip_prefix(anchor)
        .map_err(|_| changed())?
        .components()
    {
        let Component::Normal(name) = component else {
            return Err(changed());
        };
        if !super::source_files::plain_metadata(&directory.symlink_metadata(name)?) {
            return Err(changed());
        }
        directory = directory.open_dir_nofollow(name).map_err(|_| changed())?;
        if !super::source_files::plain_metadata(&directory.dir_metadata()?) {
            return Err(changed());
        }
    }
    Ok(directory)
}

pub(super) fn root_identity(root: &Path) -> Result<(u64, u64)> {
    let metadata = open_root(root)?.dir_metadata()?;
    Ok((metadata.dev(), metadata.ino()))
}

pub(super) fn open_directory(root: &Dir, relative: &str) -> Result<Dir> {
    let mut directory = root.try_clone()?;
    if !relative.is_empty() {
        for name in relative.split('/') {
            if !super::source_files::plain_metadata(&directory.symlink_metadata(name)?) {
                return Err(changed());
            }
            directory = directory.open_dir_nofollow(name).map_err(|_| changed())?;
            if !super::source_files::plain_metadata(&directory.dir_metadata()?) {
                return Err(changed());
            }
        }
    }
    Ok(directory)
}

fn excluded(name: &str) -> bool {
    let reserved = if cfg!(windows) {
        name.eq_ignore_ascii_case("node_modules") || name.eq_ignore_ascii_case("For-AI")
    } else {
        matches!(name, "node_modules" | "For-AI")
    };
    name.starts_with('.')
        || reserved
        || [
            ".undertree-review.json",
            ".undertree-pending.json",
            ".import-report.json",
        ]
        .iter()
        .any(|suffix| name.ends_with(suffix))
}

impl Inventory {
    fn new(limits: Limits) -> Self {
        Self {
            entries: Vec::new(),
            visited: 0,
            directories: 0,
            response_bytes: 1024, // Reserve the bounded envelope and project ID.
            truncated: false,
            omitted_non_utf8: 0,
            limits,
        }
    }

    fn walk(&mut self, root: &Dir, directory: &Dir, prefix: &str, depth: usize) -> Result<()> {
        if depth > self.limits.max_depth || self.directories >= self.limits.max_directories {
            self.truncated = true;
            return Ok(());
        }
        self.directories += 1;
        let remaining = self.limits.max_entries.saturating_sub(self.visited);
        let mut entries = directory
            .entries()?
            .take(remaining + 1)
            .collect::<std::io::Result<Vec<_>>>()?;
        if entries.len() > remaining {
            self.truncated = true;
            entries.truncate(remaining);
        }
        self.visited += entries.len();
        entries.sort_by_key(|entry| entry.file_name());
        for entry in entries {
            let name = entry.file_name();
            let Some(name) = name.to_str() else {
                // Count the encountered entry, not unseen descendants of an omitted directory.
                self.omitted_non_utf8 += 1;
                continue;
            };
            if excluded(name) {
                continue;
            }
            let kind = entry.file_type()?;
            if !kind.is_dir() && !kind.is_file() {
                continue;
            }
            if kind.is_dir()
                && (depth >= self.limits.max_depth
                    || self.directories >= self.limits.max_directories)
            {
                self.truncated = true;
                continue;
            }
            let metadata = directory.symlink_metadata(name)?;
            if kind.is_dir() != metadata.is_dir() || kind.is_file() != metadata.is_file() {
                return Err(changed());
            }
            let path = if prefix.is_empty() {
                name.to_owned()
            } else {
                format!("{prefix}/{name}")
            };
            if path.len() > self.limits.max_path_bytes {
                self.truncated = true;
                continue;
            }
            let editable = kind.is_file() && editable_source(Path::new(&path));
            let node = TreeEntry {
                path: path.clone(),
                source_epoch: editable.then_some(0),
                kind: if kind.is_dir() {
                    "directory"
                } else if editable {
                    "source"
                } else {
                    "asset"
                },
                editable,
                bytes: kind
                    .is_file()
                    .then_some(metadata.len())
                    .filter(|size| *size <= 9_007_199_254_740_991),
            };
            let size = serde_json::to_vec(&node)?.len() + 1;
            if self.response_bytes + size > self.limits.max_response_bytes {
                self.truncated = true;
                break;
            }
            self.response_bytes += size;
            self.entries.push(node);
            if kind.is_dir() {
                let child = directory.open_dir_nofollow(name).map_err(|_| changed())?;
                if !same_directory(&metadata, &child.dir_metadata()?) {
                    return Err(changed());
                }
                self.walk(root, &child, &path, depth + 1)?;
            }
        }
        if !same_directory(
            &directory.dir_metadata()?,
            &open_directory(root, prefix)?.dir_metadata()?,
        ) {
            return Err(changed());
        }
        Ok(())
    }
}

pub(super) fn directory_path(relative: &str) -> Result<(&str, &str)> {
    if relative.is_empty() || relative.len() > LIMITS.max_path_bytes {
        return Err(Error::new(
            "path",
            "Choose a folder path shorter than 4097 bytes inside the project.",
        ));
    }
    let components: Vec<_> = relative.split('/').collect();
    if components.len() > LIMITS.max_depth
        || components.iter().any(|name| {
            let stem = name.split('.').next().unwrap_or("").to_ascii_uppercase();
            let device = matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
                || stem
                    .strip_prefix("COM")
                    .or_else(|| stem.strip_prefix("LPT"))
                    .is_some_and(|digit| {
                        digit.len() == 1 && matches!(digit.as_bytes()[0], b'1'..=b'9')
                    });
            name.is_empty()
                || name.len() > 255
                || excluded(name)
                || device
                || name.ends_with([' ', '.'])
                || name
                    .chars()
                    .any(|c| c.is_control() || "\\<>:\"|?*".contains(c))
        })
    {
        return Err(Error::new("path", "Choose a normal folder name inside the project; hidden, reserved and parent paths are unavailable."));
    }
    Ok(relative.rsplit_once('/').unwrap_or(("", relative)))
}

impl Service {
    fn check_tree_root(&self, project: &Project, root: &Dir) -> Result<()> {
        self.checked_root(project)?;
        if !same_directory(
            &root.dir_metadata()?,
            &open_root(&project.root)?.dir_metadata()?,
        ) {
            return Err(changed());
        }
        Ok(())
    }

    pub(super) fn project_tree_rooted(
        &self,
        project: &str,
        expected: Option<RootObservation>,
    ) -> Result<Value> {
        let approved = self.project(project)?;
        let observation = expected.map_or_else(|| RootedRoot::observe(&approved.root), Ok)?;
        let held = RootedRoot::acquire(&approved.root, &observation)?;
        let root = held.directory()?;
        let mut inventory = Inventory::new(Limits {
            max_response_bytes: LIMITS.max_response_bytes - 12 * 1024,
            ..LIMITS
        });
        inventory.walk(&root, &root, "", 0)?;
        let compiled =
            self.current_typst_dependency_paths(project, &approved.main_document, observation);
        let mut typst_sources = compiled
            .and_then(|paths| typst_sources::from_compiler(&held, &approved.main_document, paths))
            .unwrap_or_else(|| typst_sources::discover(&held, &approved.main_document));
        self.check_tree_root(&approved, &root)?;
        let registry = lock(&self.registry)?;
        for entry in &mut inventory.entries {
            if entry.editable {
                entry.source_epoch =
                    Some(source_identity::epoch_in(&registry, project, &entry.path)?);
            }
        }
        let mut value = json!({"project":project,"entries":inventory.entries,"truncated":inventory.truncated,
            "omittedNonUtf8":inventory.omitted_non_utf8,"limits":LIMITS,"expectedRoot":observation});
        let available = LIMITS
            .max_response_bytes
            .saturating_sub(serde_json::to_vec(&value)?.len() + 16);
        typst_sources.fit_budget(available)?;
        value["typstSources"] = serde_json::to_value(typst_sources)?;
        if serde_json::to_vec(&value)?.len() > LIMITS.max_response_bytes {
            return Err(Error::new(
                "limit",
                "The project tree exceeds its bounded response size.",
            ));
        }
        Ok(value)
    }

    pub(super) fn create_directory_rooted(
        &self,
        project: &str,
        path: &str,
        expected: Option<RootObservation>,
    ) -> Result<Value> {
        let (parent_path, name) = directory_path(path)?;
        let approved = self.project(project)?;
        let observation = expected.map_or_else(|| RootedRoot::observe(&approved.root), Ok)?;
        let held = RootedRoot::acquire(&approved.root, &observation)?;
        let root = held.directory()?;
        let parent = open_directory(&root, parent_path)?;
        self.check_tree_root(&approved, &root)?;
        let parent_identity = parent.dir_metadata()?;
        if !same_directory(
            &parent_identity,
            &open_directory(&root, parent_path)?.dir_metadata()?,
        ) {
            return Err(changed());
        }
        held.check_current()?;
        parent.create_dir(name).map_err(|error| {
            if error.kind() == std::io::ErrorKind::AlreadyExists {
                Error::new(
                    "exists",
                    "A file or folder already has this name. Refresh the project tree.",
                )
            } else {
                Error::from(error)
            }
        })?;
        // A concurrent external rename cannot be atomic with mkdir; never remove a replacement.
        let verify = || -> Result<()> {
            #[cfg(unix)]
            parent.open(".")?.sync_all()?;
            held.check_current()?;
            self.check_tree_root(&approved, &root)?;
            if !same_directory(
                &parent_identity,
                &open_directory(&root, parent_path)?.dir_metadata()?,
            ) {
                return Err(changed());
            }
            Ok(())
        };
        verify().map_err(|_| Error::new("outcome_unknown", "The folder was created, but its location or durability could not be confirmed. Refresh the project tree before retrying."))?;
        Ok(json!({"project":project,"path":path,"created":true,"expectedRoot":observation}))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn all_inventory_budgets_report_partial_without_exceeding_their_output_bound() {
        let temporary = tempfile::tempdir().unwrap();
        fs::create_dir(temporary.path().join("a")).unwrap();
        fs::write(temporary.path().join("a/child.png"), [0xff]).unwrap();
        fs::write(temporary.path().join("b.png"), [0xff]).unwrap();
        fs::write(temporary.path().join("long-name.png"), [0xff]).unwrap();
        let root = open_root(temporary.path()).unwrap();
        for limits in [
            Limits {
                max_entries: 1,
                ..LIMITS
            },
            Limits {
                max_directories: 1,
                ..LIMITS
            },
            Limits {
                max_path_bytes: 3,
                ..LIMITS
            },
            Limits {
                max_response_bytes: 1030,
                ..LIMITS
            },
        ] {
            let mut inventory = Inventory::new(limits);
            inventory.walk(&root, &root, "", 0).unwrap();
            assert!(inventory.truncated);
            assert!(inventory.visited <= limits.max_entries);
            assert!(inventory.directories <= limits.max_directories);
            assert!(inventory.response_bytes <= limits.max_response_bytes);
            assert!(inventory
                .entries
                .iter()
                .all(|entry| entry.path.len() <= limits.max_path_bytes));
        }
    }

    #[test]
    fn held_root_detects_same_path_replacement_and_never_addresses_its_replacement() {
        let temporary = tempfile::tempdir().unwrap();
        let root_path = temporary.path().join("project");
        fs::create_dir(&root_path).unwrap();
        let service = Service::new(temporary.path().join("state")).unwrap();
        let id = service
            .local(Operation::AddProject {
                root: root_path.to_str().unwrap().into(),
            })
            .unwrap()["id"]
            .as_str()
            .unwrap()
            .to_owned();
        let approved = service.project(&id).unwrap();
        let root = open_root(&approved.root).unwrap();
        #[cfg(windows)]
        {
            let before = root.dir_metadata().unwrap();
            let error = fs::rename(&root_path, temporary.path().join("moved")).unwrap_err();
            assert!(matches!(error.raw_os_error(), Some(5) | Some(32)));
            let after = root.dir_metadata().unwrap();
            assert_eq!((after.dev(), after.ino()), (before.dev(), before.ino()));
            service.check_tree_root(&approved, &root).unwrap();
            root.create_dir("held-handle-only").unwrap();
            assert!(root_path.join("held-handle-only").is_dir());
            assert!(!temporary.path().join("moved").exists());
        }
        #[cfg(not(windows))]
        {
            fs::rename(&root_path, temporary.path().join("moved")).unwrap();
            fs::create_dir(&root_path).unwrap();
            assert_eq!(
                service.check_tree_root(&approved, &root).unwrap_err().code,
                "path"
            );
            root.create_dir("held-handle-only").unwrap();
            assert!(!root_path.join("held-handle-only").exists());
            assert!(temporary.path().join("moved/held-handle-only").is_dir());
        }
    }
}
