//! Private process discovery for local clients; never mounted on the public MCP listener.
use crate::service::Service;
use crate::{Error, Result};
use serde::{Deserialize, Serialize};
use std::fs::{self, File, OpenOptions, TryLockError};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use uuid::Uuid;

const INSTANCE_FILE: &str = "instance.json";
const LOCK_FILE: &str = "authority.lock";

pub fn default_state_dir() -> Result<PathBuf> {
    #[cfg(not(target_os = "windows"))]
    let home = || std::env::var_os("HOME").map(PathBuf::from);
    #[cfg(target_os = "windows")]
    let base = std::env::var_os("APPDATA").map(PathBuf::from);
    #[cfg(target_os = "macos")]
    let base = home().map(|path| path.join("Library/Application Support"));
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    let base = std::env::var_os("XDG_DATA_HOME")
        .filter(|path| !path.is_empty())
        .map(PathBuf::from)
        .or_else(|| home().map(|path| path.join(".local/share")));
    base.filter(|path| path.is_absolute())
        .map(|path| path.join("io.github.georgefejer91.UnderTree/review"))
        .ok_or_else(|| {
            Error::new(
                "state",
                "Set UNDERTREE_REVIEW_STATE to the desktop review state folder.",
            )
        })
}

pub fn validate_endpoint(endpoint: &str) -> Result<()> {
    let parsed = endpoint.parse::<axum::http::Uri>().map_err(|_| {
        Error::new(
            "endpoint",
            "The local CLI accepts a loopback review endpoint only.",
        )
    })?;
    if endpoint.len() > 256
        || endpoint.contains('#')
        || parsed.scheme_str() != Some("http")
        || parsed.host() != Some("127.0.0.1")
        || parsed.port_u16().is_none_or(|port| port == 0)
        || parsed.path() != "/api/review"
        || parsed.query().is_some()
        || parsed
            .authority()
            .is_some_and(|authority| authority.as_str().contains('@'))
    {
        return Err(Error::new(
            "endpoint",
            "The local CLI accepts a loopback review endpoint only.",
        ));
    }
    Ok(())
}

fn unavailable() -> Error {
    Error::new("instance_unavailable", "No running UnderTree authority was found. Open UnderTree or specify its local state folder.")
}

fn private_directory(state: &Path, create: bool) -> Result<PathBuf> {
    let directory = state.join("cli");
    if create && !directory.exists() {
        let mut builder = fs::DirBuilder::new();
        #[cfg(unix)]
        {
            use std::os::unix::fs::DirBuilderExt;
            builder.mode(0o700);
        }
        match builder.create(&directory) {
            Ok(()) => (),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => (),
            Err(error) => return Err(error.into()),
        }
    }
    let metadata = fs::symlink_metadata(&directory).map_err(|_| unavailable())?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Err(Error::new(
            "state",
            "The local authority directory must be a private regular directory.",
        ));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if metadata.permissions().mode() & 0o077 != 0 {
            return Err(Error::new(
                "state",
                "The local authority directory must be accessible only to its owner.",
            ));
        }
    }
    Ok(directory)
}

fn open_lock(directory: &Path, create: bool) -> Result<File> {
    let path = directory.join(LOCK_FILE);
    if fs::symlink_metadata(&path).is_ok_and(|m| !m.is_file() || m.file_type().is_symlink()) {
        return Err(Error::new(
            "state",
            "Linked authority lock files are not allowed.",
        ));
    }
    let mut options = OpenOptions::new();
    options.read(true).write(true).create(create);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options.open(path).map_err(|_| unavailable())
}

// No Debug implementation: this local file contains the session credential.
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LocalConnection {
    contract_version: u32,
    instance_id: String,
    endpoint: String,
    token: String,
}

impl LocalConnection {
    fn read(directory: &Path) -> Result<Self> {
        let path = directory.join(INSTANCE_FILE);
        let metadata = fs::symlink_metadata(&path).map_err(|_| unavailable())?;
        if !metadata.is_file() || metadata.file_type().is_symlink() || metadata.len() > 4096 {
            return Err(unavailable());
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            if metadata.permissions().mode() & 0o077 != 0 {
                return Err(unavailable());
            }
        }
        let mut bytes = Vec::new();
        File::open(path)?.take(4097).read_to_end(&mut bytes)?;
        if bytes.len() > 4096 {
            return Err(unavailable());
        }
        let connection: Self = serde_json::from_slice(&bytes).map_err(|_| unavailable())?;
        if connection.contract_version != crate::capabilities::CONTRACT_VERSION
            || Uuid::parse_str(&connection.instance_id).is_err()
            || connection.token.len() != 64
            || !connection
                .token
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit())
        {
            return Err(unavailable());
        }
        validate_endpoint(&connection.endpoint)?;
        Ok(connection)
    }

    pub fn discover(state: &Path) -> Result<Self> {
        let directory = private_directory(state, false)?;
        let lock = open_lock(&directory, false)?;
        match lock.try_lock() {
            Err(TryLockError::WouldBlock) => Self::read(&directory),
            _ => Err(unavailable()),
        }
    }

    pub fn endpoint(&self) -> &str {
        &self.endpoint
    }
    pub fn token(&self) -> &str {
        &self.token
    }
    pub fn instance_id(&self) -> &str {
        &self.instance_id
    }
}

struct RunningInstance {
    directory: PathBuf,
    instance_id: String,
    token: String,
    _lock: File,
    active: Arc<AtomicBool>,
    task: tokio::task::JoinHandle<()>,
}

pub struct LocalInstance {
    running: Mutex<Option<RunningInstance>>,
}

impl LocalInstance {
    pub async fn start(service: Arc<Service>) -> Result<Self> {
        let directory = private_directory(service.publishing_root(), true)?;
        let lock = open_lock(&directory, true)?;
        lock.try_lock().map_err(|error| match error {
            TryLockError::WouldBlock => Error::new(
                "instance_running",
                "UnderTree is already using this state folder. Connect to the running instance.",
            ),
            _ => Error::new("state", "The local authority lock is unavailable."),
        })?;
        let descriptor = directory.join(INSTANCE_FILE);
        if fs::symlink_metadata(&descriptor)
            .is_ok_and(|m| !m.is_file() || m.file_type().is_symlink())
        {
            return Err(Error::new(
                "state",
                "Linked instance descriptors are not allowed.",
            ));
        }
        let listener = tokio::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0)).await?;
        let connection = LocalConnection {
            contract_version: crate::capabilities::CONTRACT_VERSION,
            instance_id: service.instance_id().into(),
            endpoint: format!("http://{}/api/review", listener.local_addr()?),
            token: format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple()),
        };
        let active = Arc::new(AtomicBool::new(true));
        let router = crate::transport::cli_router(
            service,
            connection.token.clone(),
            connection.instance_id.clone(),
            active.clone(),
        );
        let mut temporary = tempfile::NamedTempFile::new_in(&directory)?;
        temporary.write_all(&serde_json::to_vec(&connection)?)?;
        temporary.as_file().sync_all()?;
        temporary.persist(&descriptor).map_err(|_| {
            Error::new(
                "state",
                "Could not publish the private instance descriptor.",
            )
        })?;
        let task = tokio::spawn(async move {
            let _ = axum::serve(listener, router).await;
        });
        Ok(Self {
            running: Mutex::new(Some(RunningInstance {
                directory,
                instance_id: connection.instance_id,
                token: connection.token,
                _lock: lock,
                active,
                task,
            })),
        })
    }

    pub fn stop(&self) {
        if let Ok(mut running) = self.running.lock() {
            if let Some(instance) = running.take() {
                instance.active.store(false, Ordering::Release);
                instance.task.abort();
                if LocalConnection::read(&instance.directory).is_ok_and(|connection| {
                    connection.instance_id == instance.instance_id
                        && crate::transport::same_secret(&connection.token, &instance.token)
                }) {
                    let _ = fs::remove_file(instance.directory.join(INSTANCE_FILE));
                }
            }
        }
    }
}

impl Drop for LocalInstance {
    fn drop(&mut self) {
        self.stop();
    }
}
