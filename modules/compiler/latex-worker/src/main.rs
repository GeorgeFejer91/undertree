// SPDX-License-Identifier: GPL-2.0-or-later
use cap_fs_ext::{DirExt, FollowSymlinks, OpenOptionsFollowExt, OpenOptionsSyncExt};
use cap_std::fs::{Dir, OpenOptions};
use std::{
    cell::{Cell, RefCell},
    collections::{BTreeMap, BTreeSet},
    fmt::Arguments,
    io::{Cursor, Read, Write},
    path::{Component, Path, PathBuf},
    rc::Rc,
};
use tectonic::driver::ProcessingSessionBuilder;
use tectonic_bundles::Bundle;
use tectonic_errors::{
    anyhow::{anyhow, bail, Context},
    Error, Result,
};
use tectonic_io_base::{digest::DigestData, InputHandle, InputOrigin, IoProvider, OpenResult};
use tectonic_status_base::{MessageKind, StatusBackend};

const MAX_INPUT: usize = 16 * 1024 * 1024;
const MAX_TOTAL: usize = 128 * 1024 * 1024;
const MAX_FILES: usize = 2048;
const MAX_PDF: usize = 16 * 1024 * 1024;
const CACHE_GUIDANCE: &str = "Offline LaTeX resources are unavailable. Place a prepared latex-resources folder beside UnderTree, or set UNDERTREE_TECTONIC_CACHE to a prepared local Tectonic cache.";
type Used = Rc<RefCell<BTreeSet<PathBuf>>>;
type Denied = Rc<Cell<bool>>;

fn ordinary_component(name: &std::ffi::OsStr) -> bool {
    let name = name.to_string_lossy();
    let stem = name.split('.').next().unwrap_or("").to_ascii_uppercase();
    let device = matches!(
        stem.as_str(),
        "CON" | "PRN" | "AUX" | "NUL" | "CONIN$" | "CONOUT$"
    ) || matches!(
        stem.strip_prefix("COM")
            .or_else(|| stem.strip_prefix("LPT")),
        Some("1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "¹" | "²" | "³")
    );
    !device && !name.ends_with([' ', '.'])
}

fn normalized(base: &Path, name: &str) -> Result<PathBuf> {
    if name.is_empty()
        || name.len() > 4096
        || name.contains(['\\', ':', '\0'])
        || name.starts_with('/')
    {
        bail!("LaTeX input must remain inside the project.");
    }
    let mut out = base.to_path_buf();
    for component in Path::new(name).components() {
        match component {
            Component::Normal(part) if ordinary_component(part) => out.push(part),
            Component::CurDir => (),
            Component::ParentDir if out.pop() => (),
            _ => bail!("LaTeX input must remain inside the project."),
        }
    }
    Ok(out)
}

fn logical_font_map(base: &Path, name: &str) -> bool {
    let Some((font, mapping)) = name.split_once(':') else {
        return false;
    };
    // A drive prefix never denotes a font resource, even if the suffix matches.
    if (font.len() == 1 && font.as_bytes()[0].is_ascii_alphabetic())
        || normalized(base, font).is_err()
    {
        return false;
    }
    let Some((index, kind)) = mapping.split_once('-') else {
        return false;
    };
    !index.is_empty()
        && index.bytes().all(|c| c.is_ascii_digit())
        && index.parse::<u32>().is_ok()
        && matches!(kind, "0-GID" | "1-GID" | "UCS32-Add")
}

#[cfg(not(target_os = "macos"))]
fn disable_system_fonts() -> Result<()> {
    use std::ffi::{c_int, c_void};
    extern "C" {
        fn FcConfigCreate() -> *mut c_void;
        fn FcConfigSetCurrent(config: *mut c_void) -> c_int;
        fn FcConfigDestroy(config: *mut c_void);
    }
    // SAFETY: Before engine initialization this single-threaded worker installs
    // a newly owned, empty Fontconfig config. SetCurrent retains its own ref;
    // Destroy releases our caller ref exactly once on success or failure.
    let installed = unsafe {
        let config = FcConfigCreate();
        if config.is_null() {
            bail!("Could not initialize confined font access.");
        }
        let installed = FcConfigSetCurrent(config) != 0;
        FcConfigDestroy(config);
        installed
    };
    if !installed {
        bail!("Could not initialize confined font access.");
    }
    Ok(())
}

fn open_directory(path: &Path) -> Result<Dir> {
    if !path.is_absolute() {
        bail!("A private absolute project root is required.");
    }
    let anchor = path
        .ancestors()
        .last()
        .ok_or_else(|| anyhow!("Invalid project root."))?;
    let mut directory = Dir::open_ambient_dir(anchor, cap_std::ambient_authority())?;
    for component in path.strip_prefix(anchor)?.components() {
        let Component::Normal(name) = component else {
            bail!("Invalid project root.");
        };
        directory = directory.open_dir_nofollow(name)?;
    }
    Ok(directory)
}

struct ProjectIo {
    directory: Dir,
    absolute: PathBuf,
    base: PathBuf,
    bytes: BTreeMap<PathBuf, Vec<u8>>,
    total: usize,
    used: Used,
    denied: Denied,
}

impl ProjectIo {
    fn read(&mut self, relative: &Path) -> Result<Option<Vec<u8>>> {
        if let Some(bytes) = self.bytes.get(relative) {
            return Ok(Some(bytes.clone()));
        }
        let mut directory = self.directory.try_clone()?;
        for component in relative
            .parent()
            .unwrap_or_else(|| Path::new(""))
            .components()
        {
            directory = match directory.open_dir_nofollow(component.as_os_str()) {
                Ok(dir) => dir,
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
                Err(e)
                    if e.kind() == std::io::ErrorKind::NotADirectory
                        && directory.symlink_metadata(component.as_os_str()).is_ok_and(
                            |metadata| metadata.is_file() && !metadata.file_type().is_symlink(),
                        ) =>
                {
                    return Ok(None)
                }
                Err(_) => bail!("Linked or inaccessible LaTeX project inputs are not allowed."),
            };
        }
        let mut options = OpenOptions::new();
        options.read(true).follow(FollowSymlinks::No).nonblock(true);
        let file = match directory.open_with(relative.file_name().unwrap_or_default(), &options) {
            Ok(file) => file,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(_) => bail!("Linked or inaccessible LaTeX project inputs are not allowed."),
        };
        if !file.metadata()?.is_file() {
            return Ok(None);
        }
        let mut bytes = Vec::new();
        file.take(MAX_INPUT as u64 + 1).read_to_end(&mut bytes)?;
        if bytes.len() > MAX_INPUT
            || self.total + bytes.len() > MAX_TOTAL
            || self.bytes.len() >= MAX_FILES
        {
            bail!("LaTeX project input limit exceeded.");
        }
        self.total += bytes.len();
        self.used.borrow_mut().insert(self.absolute.join(relative));
        self.bytes.insert(relative.to_path_buf(), bytes.clone());
        Ok(Some(bytes))
    }
}

impl IoProvider for ProjectIo {
    fn input_open_name(
        &mut self,
        name: &str,
        _status: &mut dyn StatusBackend,
    ) -> OpenResult<InputHandle> {
        // PDF I/O synthesizes these cache keys, then generates the map in memory.
        // They are never filesystem names: do not attempt an ADS or bundle read.
        if logical_font_map(&self.base, name) {
            return OpenResult::NotAvailable;
        }
        let relative = match normalized(&self.base, name) {
            Ok(path) => path,
            Err(error) => {
                self.denied.set(true);
                return OpenResult::Err(error);
            }
        };
        match self.read(&relative) {
            Ok(Some(bytes)) => OpenResult::Ok(InputHandle::new(
                name,
                Cursor::new(bytes),
                InputOrigin::Filesystem,
            )),
            Ok(None) => OpenResult::NotAvailable,
            Err(error) => {
                self.denied.set(true);
                OpenResult::Err(error)
            }
        }
    }
}

// Bundle paths are logical resource names; never expose ambient paths back to TeX.
struct OfflineBundle {
    inner: Box<dyn Bundle>,
    project_base: PathBuf,
    denied: Denied,
}
impl IoProvider for OfflineBundle {
    fn input_open_name(
        &mut self,
        name: &str,
        status: &mut dyn StatusBackend,
    ) -> OpenResult<InputHandle> {
        if logical_font_map(&self.project_base, name) {
            return OpenResult::NotAvailable;
        }
        if let Err(error) = normalized(Path::new(""), name) {
            // A valid project-relative parent path has already been checked by
            // ProjectIo. It is not a bundle resource, even when it is absent.
            if normalized(&self.project_base, name).is_ok() {
                return OpenResult::NotAvailable;
            }
            self.denied.set(true);
            return OpenResult::Err(error);
        }
        self.inner.input_open_name(name, status)
    }
}
impl Bundle for OfflineBundle {
    fn get_digest(&mut self) -> Result<DigestData> {
        self.inner.get_digest()
    }
    fn all_files(&self) -> Vec<String> {
        self.inner.all_files()
    }
}

struct Diagnostics(usize);
impl Diagnostics {
    fn write(&mut self, bytes: &[u8]) {
        let take = bytes.len().min(48 * 1024 - self.0);
        if take > 0 {
            let _ = std::io::stderr().write_all(&bytes[..take]);
            self.0 += take;
        }
    }
}
impl StatusBackend for Diagnostics {
    fn report(&mut self, kind: MessageKind, args: Arguments, error: Option<&Error>) {
        if kind == MessageKind::Note {
            return;
        }
        self.write(format!("{args}\n").as_bytes());
        if let Some(error) = error {
            self.write(format!("{error:#}\n").as_bytes());
        }
    }
    fn dump_error_logs(&mut self, output: &[u8]) {
        let start = output.len().saturating_sub(48 * 1024 - self.0);
        self.write(&output[start..]);
    }
}

fn compile(root: PathBuf, input: String, deps: PathBuf, status: &mut Diagnostics) -> Result<()> {
    if cfg!(target_os = "macos") {
        bail!("Confined LaTeX compilation is unavailable on macOS until native font access is qualified.");
    }
    let relative = normalized(Path::new(""), &input)?;
    if relative.extension().and_then(|x| x.to_str()) != Some("tex") {
        bail!("Choose a .tex main document.");
    }
    if !deps.is_absolute() || deps.starts_with(&root) {
        bail!("Dependency output must be outside the project.");
    }
    let used = Used::default();
    let denied = Denied::default();
    let mut project = ProjectIo {
        directory: open_directory(&root)?,
        absolute: root.clone(),
        base: relative
            .parent()
            .unwrap_or_else(|| Path::new(""))
            .to_path_buf(),
        bytes: BTreeMap::new(),
        total: 0,
        used: used.clone(),
        denied: denied.clone(),
    };
    let source = project
        .read(&relative)?
        .ok_or_else(|| anyhow!("The LaTeX main document is unavailable."))?;
    let input_name = relative
        .file_name()
        .and_then(|x| x.to_str())
        .ok_or_else(|| anyhow!("Invalid main document filename."))?;
    let cache = std::env::var_os("UNDERTREE_TECTONIC_CACHE")
        .or_else(|| std::env::var_os("TECTONIC_CACHE_DIR"))
        .map(PathBuf::from)
        .or_else(|| {
            std::env::current_exe()
                .ok()?
                .parent()
                .map(|p| p.join("latex-resources"))
        })
        .context(CACHE_GUIDANCE)?;
    if !cache.is_absolute() || !cache.is_dir() {
        bail!("{CACHE_GUIDANCE}");
    }
    let mut bundle = tectonic_bundles::detect_bundle(
        tectonic_bundles::get_fallback_bundle_url(tectonic::FORMAT_SERIAL),
        true,
        Some(cache.join("bundles")),
    )
    .context(CACHE_GUIDANCE)?
    .context(CACHE_GUIDANCE)?;
    let digest = bundle.get_digest()?.to_string();
    let index = cache.join("bundles/data").join(format!("{digest}.index"));
    if !index.is_file() {
        bail!("{CACHE_GUIDANCE}");
    }
    // The format cache also belongs to this external resource identity, even
    // when a document does not open any additional bundle package or font.
    used.borrow_mut().insert(index);
    // Install an empty native config before Tectonic can initialize discovery.
    // Explicit project and bundle font files still go through confined I/O.
    #[cfg(not(target_os = "macos"))]
    disable_system_fonts()?;
    std::env::set_var("TECTONIC_UNTRUSTED_MODE", "1");
    let mut builder = ProcessingSessionBuilder::default();
    builder
        .primary_input_buffer(&source)
        .tex_input_name(input_name)
        .filesystem_root(&root)
        .format_name("latex")
        .project_io(Box::new(project))
        .bundle(Box::new(OfflineBundle {
            inner: bundle,
            project_base: relative
                .parent()
                .unwrap_or_else(|| Path::new(""))
                .to_path_buf(),
            denied: denied.clone(),
        }))
        .format_cache_path(cache.join("formats"))
        .do_not_write_output_files()
        .print_stdout(false)
        .shell_escape_disabled();
    let mut session = builder.create(status)?;
    session.run(status)?;
    if denied.get() {
        bail!("The LaTeX document requested an input outside its permitted project or resource files.");
    }
    let mut outputs = session.into_file_data();
    let pdf_name = Path::new(input_name)
        .with_extension("pdf")
        .to_string_lossy()
        .into_owned();
    let pdf = outputs
        .remove(&pdf_name)
        .context("The LaTeX build did not produce a PDF.")?
        .data;
    if pdf.len() > MAX_PDF || !pdf.starts_with(b"%PDF-") {
        bail!("The LaTeX PDF output is invalid or too large.");
    }
    let inputs: Vec<_> = used
        .borrow()
        .iter()
        .map(|p| p.to_string_lossy().into_owned())
        .collect();
    let parent = deps.parent().context("Invalid dependency output path.")?;
    let directory = open_directory(parent)?;
    let mut options = OpenOptions::new();
    options
        .write(true)
        .truncate(true)
        .follow(FollowSymlinks::No)
        .nonblock(true);
    let mut output = directory.open_with(deps.file_name().unwrap_or_default(), &options)?;
    if !output.metadata()?.is_file() {
        bail!("Dependency output must be a regular private file.");
    }
    serde_json::to_writer(&mut output, &serde_json::json!({"inputs": inputs}))?;
    std::io::stdout().lock().write_all(&pdf)?;
    Ok(())
}

fn run(status: &mut Diagnostics) -> Result<()> {
    let mut args = std::env::args().skip(1);
    if args.next().as_deref() != Some("compile") {
        bail!("Expected compile --root PATH --input FILE.tex --deps PATH.");
    }
    let mut values = BTreeMap::new();
    while let Some(flag) = args.next() {
        if !["--root", "--input", "--deps"].contains(&flag.as_str()) || values.contains_key(&flag) {
            bail!("Invalid compile arguments.");
        }
        values.insert(flag, args.next().context("Missing compile argument.")?);
    }
    if values.len() != 3 {
        bail!("Missing compile arguments.");
    }
    compile(
        PathBuf::from(&values["--root"]),
        values["--input"].clone(),
        PathBuf::from(&values["--deps"]),
        status,
    )
}

fn main() {
    let mut status = Diagnostics(0);
    if let Err(error) = run(&mut status) {
        status.write(format!("LaTeX build failed: {error:#}\n").as_bytes());
        std::process::exit(1);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn paths_resolve_within_project_and_deny_windows_escapes() {
        assert_eq!(
            normalized(Path::new("manuscript"), "../shared.tex").unwrap(),
            PathBuf::from("shared.tex")
        );
        for name in [
            "../../outside.tex",
            "C:/secret.tex",
            "C:secret.tex",
            "//server/share",
            "\\\\server\\share",
            "/secret.tex",
            "NUL.tex",
            "COM1",
            "LPT¹.txt",
            "alias.tex.",
            "main.tex:hidden",
        ] {
            assert!(normalized(Path::new("manuscript"), name).is_err(), "{name}");
        }
        assert!(logical_font_map(Path::new(""), "fonts/owned.otf:0-0-GID"));
        assert!(logical_font_map(
            Path::new(""),
            "lmroman10-regular:0-UCS32-Add"
        ));
        for name in [
            "C:0-0-GID",
            "font.otf:hidden",
            "C:/outside.otf:0-0-GID",
            "../outside:0-UCS32-Add",
        ] {
            assert!(!logical_font_map(Path::new(""), name));
        }
    }
    #[test]
    fn project_inputs_are_snapshotted_and_writes_are_unavailable() {
        let root = tempfile::tempdir().unwrap();
        std::fs::write(root.path().join("main.tex"), b"original").unwrap();
        let mut io = ProjectIo {
            directory: open_directory(root.path()).unwrap(),
            absolute: root.path().to_owned(),
            base: PathBuf::new(),
            bytes: BTreeMap::new(),
            total: 0,
            used: Used::default(),
            denied: Denied::default(),
        };
        assert_eq!(
            io.read(Path::new("main.tex")).unwrap().unwrap(),
            b"original"
        );
        std::fs::write(root.path().join("main.tex"), b"changed").unwrap();
        assert_eq!(
            io.read(Path::new("main.tex")).unwrap().unwrap(),
            b"original"
        );
        assert!(matches!(
            io.output_open_name("source.tex"),
            OpenResult::NotAvailable
        ));
        assert_eq!(io.used.borrow().len(), 1);
        assert!(io.read(Path::new("main.tex/rsrc")).unwrap().is_none());
    }

    #[test]
    fn denied_probes_remain_visible_when_an_engine_ignores_the_error() {
        let root = tempfile::tempdir().unwrap();
        let mut io = ProjectIo {
            directory: open_directory(root.path()).unwrap(),
            absolute: root.path().to_owned(),
            base: PathBuf::new(),
            bytes: BTreeMap::new(),
            total: 0,
            used: Used::default(),
            denied: Denied::default(),
        };
        assert!(matches!(
            io.input_open_name(
                "../outside.tex",
                &mut tectonic_status_base::NoopStatusBackend {}
            ),
            OpenResult::Err(_)
        ));
        assert!(io.denied.get());
        assert!(io.used.borrow().is_empty());
    }

    #[test]
    fn oversized_input_does_not_become_a_successful_dependency() {
        let root = tempfile::tempdir().unwrap();
        std::fs::File::create(root.path().join("large.tex"))
            .unwrap()
            .set_len(MAX_INPUT as u64 + 1)
            .unwrap();
        let mut io = ProjectIo {
            directory: open_directory(root.path()).unwrap(),
            absolute: root.path().to_owned(),
            base: PathBuf::new(),
            bytes: BTreeMap::new(),
            total: 0,
            used: Used::default(),
            denied: Denied::default(),
        };
        assert!(io.read(Path::new("large.tex")).is_err());
        assert!(io.used.borrow().is_empty());
        assert!(io.bytes.is_empty());
    }
}
