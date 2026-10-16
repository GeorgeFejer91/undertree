//! Retire only the controller share created for this process's reserved loopback listener.
use crate::{Error, Result};
use serde::Deserialize;
use std::{ffi::OsString, path::PathBuf, process::Stdio, time::Duration};
use tokio::{io::AsyncReadExt, process::Command};

const MAX_OUTPUT: u64 = 256 * 1024;
const COMMAND_TIMEOUT: Duration = Duration::from_secs(10);

pub(crate) struct OwnedShare {
    executable: OsString,
    home: Option<PathBuf>,
    target: String,
    host: String,
    environment: String,
    identity: Option<Identity>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::OnceLock;
    use tokio::net::TcpListener;

    fn fixture() -> tempfile::TempDir {
        static BINARY: OnceLock<(tempfile::TempDir, PathBuf)> = OnceLock::new();
        let (_, compiled) = BINARY.get_or_init(|| {
            let root = tempfile::tempdir().unwrap();
            let binary = root.path().join(if cfg!(windows) {
                "zrok-fixture.exe"
            } else {
                "zrok-fixture"
            });
            let mut command = std::process::Command::new("rustc");
            command.args(["--edition=2021", "-o"]).arg(&binary).arg(
                PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../tests/zrok-owned-fixture.rs"),
            );
            #[cfg(windows)]
            {
                use std::os::windows::process::CommandExt;
                command.creation_flags(0x08000000);
            }
            let result = command.output().unwrap();
            assert!(
                result.status.success(),
                "{}",
                String::from_utf8_lossy(&result.stderr)
            );
            (root, binary)
        });
        let root = tempfile::tempdir().unwrap();
        std::fs::copy(compiled, root.path().join(compiled.file_name().unwrap())).unwrap();
        root
    }

    async fn prepared(root: &tempfile::TempDir) -> (OwnedShare, TcpListener) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let target = format!("http://{}", listener.local_addr().unwrap());
        let executable = root.path().join(if cfg!(windows) {
            "zrok-fixture.exe"
        } else {
            "zrok-fixture"
        });
        let home = root.path().join("private-home");
        std::fs::create_dir_all(home.join(".zrok2")).unwrap();
        std::fs::write(
            home.join(".zrok2/environment.json"),
            r#"{"ziti_identity":"fixture-enrollment"}"#,
        )
        .unwrap();
        let owned = OwnedShare::prepare(
            executable.into(),
            Some(home),
            target,
            "https://owned-name.shares.zrok.io",
        )
        .await
        .unwrap();
        (owned, listener)
    }

    async fn launch(owned: &mut OwnedShare) -> tokio::process::Child {
        let mut child = owned
            .command()
            .args([
                "share",
                "public",
                &owned.target,
                "-n",
                "public:owned-name",
                "--headless",
                "--force-local",
            ])
            .kill_on_drop(true)
            .spawn()
            .unwrap();
        for _ in 0..50 {
            if owned.discover().await.unwrap() {
                return child;
            }
            assert!(child.try_wait().unwrap().is_none());
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        panic!("Fixture did not create its share");
    }

    fn foreign(target: &str) -> String {
        serde_json::json!({"shareToken":"foreign-token", "envZId":"other-enrollment", "target":target,
            "frontendEndpoints":["foreign-name.shares.zrok.io"], "shareMode":"public", "backendMode":"proxy"}).to_string()
    }

    #[tokio::test]
    async fn hard_stop_retires_exact_share_and_reconnects_without_touching_foreign_share() {
        let root = fixture();
        let foreign = foreign("http://127.0.0.1:1");
        std::fs::write(root.path().join("controller.jsonl"), &foreign).unwrap();
        let (mut owned, _listener) = prepared(&root).await;
        let home = root.path().join("private-home");
        owned.home = Some(home.clone());
        let parent_home = std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" });
        let mut child = launch(&mut owned).await;
        assert_eq!(
            std::fs::read_to_string(root.path().join("child-home")).unwrap(),
            home.to_string_lossy()
        );
        assert_eq!(
            std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" }),
            parent_home
        );
        child.kill().await.unwrap();
        owned.retire().await.unwrap();
        assert_eq!(
            std::fs::read_to_string(root.path().join("controller.jsonl")).unwrap(),
            foreign
        );
        let (mut next, _next_listener) = prepared(&root).await;
        let mut child = launch(&mut next).await;
        child.kill().await.unwrap();
        next.retire().await.unwrap();
        assert_eq!(
            std::fs::read_to_string(root.path().join("controller.jsonl")).unwrap(),
            foreign
        );
    }

    #[tokio::test]
    async fn changed_owner_or_replacement_cannot_be_deleted() {
        let root = fixture();
        let (mut owned, _listener) = prepared(&root).await;
        let mut child = launch(&mut owned).await;
        child.kill().await.unwrap();
        let original = std::fs::read_to_string(root.path().join("controller.jsonl")).unwrap();
        let changed = original.replace("fixture-enrollment", "foreign-enrollment");
        std::fs::write(root.path().join("controller.jsonl"), &changed).unwrap();
        assert_eq!(owned.retire().await.unwrap_err().code, "tunnel_cleanup");
        assert_eq!(
            std::fs::read_to_string(root.path().join("controller.jsonl")).unwrap(),
            changed
        );
        assert!(!root.path().join("deleted").exists());
        let replacement = changed.replace(
            &owned.identity.as_ref().unwrap().share_token,
            "replacement-token",
        );
        std::fs::write(root.path().join("controller.jsonl"), &replacement).unwrap();
        owned.retire().await.unwrap();
        assert_eq!(
            std::fs::read_to_string(root.path().join("controller.jsonl")).unwrap(),
            replacement
        );
        assert!(!root.path().join("deleted").exists());
    }

    #[tokio::test]
    async fn uncertain_delete_requires_absence_and_remains_retryable() {
        let root = fixture();
        let (mut owned, _listener) = prepared(&root).await;
        let mut child = launch(&mut owned).await;
        child.kill().await.unwrap();
        for mode in [
            "delete-fails",
            "delete-no-effect",
            "list-malformed",
            "list-oversized",
        ] {
            std::fs::write(root.path().join("mode"), mode).unwrap();
            assert_eq!(
                owned.retire().await.unwrap_err().code,
                "tunnel_cleanup",
                "{mode}"
            );
            assert!(
                !std::fs::read_to_string(root.path().join("controller.jsonl"))
                    .unwrap()
                    .trim()
                    .is_empty()
            );
        }
        std::fs::remove_file(root.path().join("mode")).unwrap();
        owned.retire().await.unwrap();
        assert!(
            std::fs::read_to_string(root.path().join("controller.jsonl"))
                .unwrap()
                .trim()
                .is_empty()
        );
    }

    #[tokio::test]
    async fn another_enrollment_is_never_adopted_even_at_the_expected_target_and_name() {
        let root = fixture();
        let (mut owned, _listener) = prepared(&root).await;
        let record = foreign(&owned.target).replace("foreign-name", "owned-name");
        std::fs::write(root.path().join("controller.jsonl"), &record).unwrap();
        assert_eq!(owned.discover().await.unwrap_err().code, "tunnel_cleanup");
        assert_eq!(owned.retire().await.unwrap_err().code, "tunnel_cleanup");
        assert!(owned.identity.is_none());
        assert!(!root.path().join("deleted").exists());
        assert_eq!(
            std::fs::read_to_string(root.path().join("controller.jsonl")).unwrap(),
            record
        );
        assert!(OwnedShare::prepare(
            owned.executable.clone(),
            owned.home.clone(),
            owned.target.clone(),
            "https://owned-name.shares.zrok.io"
        )
        .await
        .is_err());
        assert_eq!(
            std::fs::read_to_string(root.path().join("controller.jsonl")).unwrap(),
            record
        );
    }

    #[tokio::test]
    async fn failed_start_only_retires_a_new_record_for_its_reserved_target() {
        let root = fixture();
        let (mut owned, _listener) = prepared(&root).await;
        std::fs::write(root.path().join("mode"), "share-exits").unwrap();
        let mut child = launch(&mut owned).await;
        child.wait().await.unwrap();
        // Model failure before startup discovery: the pending record still belongs to this target.
        owned.identity = None;
        owned.retire().await.unwrap();
        assert!(
            std::fs::read_to_string(root.path().join("controller.jsonl"))
                .unwrap()
                .trim()
                .is_empty()
        );
        owned.identity = None;
        std::fs::write(root.path().join("controller.jsonl"), foreign(&owned.target)).unwrap();
        assert_eq!(owned.retire().await.unwrap_err().code, "tunnel_cleanup");
    }
}

#[derive(Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct Identity {
    share_token: String,
    #[serde(rename = "envZId")]
    environment: String,
    target: String,
    frontend_endpoints: Vec<String>,
    share_mode: String,
    backend_mode: String,
}

#[derive(Deserialize)]
struct Listing {
    shares: Vec<Identity>,
}

pub(super) fn uncertain() -> Error {
    Error::new("tunnel_cleanup", "Access was revoked, but removal of this session's zrok share could not be verified. Retry Stop before reconnecting; no other share will be removed.")
}

fn enrollment_identity(home: &std::path::Path) -> Result<String> {
    use cap_fs_ext::{
        DirExt, FollowSymlinks, MetadataExt, OpenOptionsFollowExt, OpenOptionsSyncExt,
    };
    use cap_std::fs::{Dir, OpenOptions};
    use std::io::Read;
    #[derive(Deserialize)]
    struct Enrollment {
        ziti_identity: String,
    }
    let home =
        Dir::open_ambient_dir(home, cap_std::ambient_authority()).map_err(|_| uncertain())?;
    let activation = home.open_dir_nofollow(".zrok2").map_err(|_| uncertain())?;
    let mut options = OpenOptions::new();
    options.read(true).follow(FollowSymlinks::No).nonblock(true);
    let file = activation
        .open_with("environment.json", &options)
        .map_err(|_| uncertain())?;
    let metadata = file.metadata().map_err(|_| uncertain())?;
    if !metadata.is_file() || metadata.nlink() != 1 || metadata.len() > 1024 * 1024 {
        return Err(uncertain());
    }
    let mut bytes = Vec::new();
    file.take(1024 * 1024 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| uncertain())?;
    if bytes.len() > 1024 * 1024 {
        return Err(uncertain());
    }
    // Deserialize only the identity. Tokens and other credentials never leave native memory.
    let enrollment: Enrollment = serde_json::from_slice(&bytes).map_err(|_| uncertain())?;
    if enrollment.ziti_identity.is_empty()
        || enrollment.ziti_identity.len() > 128
        || !enrollment
            .ziti_identity
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"-_.".contains(&byte))
    {
        return Err(uncertain());
    }
    Ok(enrollment.ziti_identity)
}

impl OwnedShare {
    pub(super) async fn prepare(
        executable: OsString,
        home: Option<PathBuf>,
        target: String,
        public_url: &str,
    ) -> Result<Self> {
        let host = public_url
            .parse::<axum::http::Uri>()
            .ok()
            .and_then(|uri| {
                uri.authority()
                    .map(|authority| authority.as_str().to_owned())
            })
            .ok_or_else(uncertain)?;
        let home = home
            .or_else(|| {
                std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" })
                    .map(PathBuf::from)
            })
            .ok_or_else(uncertain)?;
        let enrollment_home = home.clone();
        let environment =
            tokio::task::spawn_blocking(move || enrollment_identity(&enrollment_home))
                .await
                .map_err(|_| uncertain())??;
        let owned = Self {
            executable,
            home: Some(home),
            target,
            host,
            environment,
            identity: None,
        };
        // The bound listener keeps this ephemeral port reserved until cleanup is verified.
        // A pre-existing controller record is never adopted, even with our name or enrollment.
        if !owned.list().await?.is_empty() {
            return Err(Error::new("tunnel", "This loopback target already has a zrok share. No existing share was changed; retry with a new session."));
        }
        Ok(owned)
    }

    pub(super) fn command(&self) -> Command {
        let mut command = Command::new(&self.executable);
        #[cfg(windows)]
        command.creation_flags(0x08000000);
        if let Some(home) = &self.home {
            #[cfg(unix)]
            command.env("HOME", home);
            #[cfg(windows)]
            command.env("USERPROFILE", home);
        }
        command
    }

    async fn run(&self, args: &[&str]) -> Result<Vec<u8>> {
        let mut command = self.command();
        let mut child = command
            .args(args)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true)
            .spawn()
            .map_err(|_| uncertain())?;
        let stdout = child.stdout.take().ok_or_else(uncertain)?;
        let result = tokio::time::timeout(COMMAND_TIMEOUT, async {
            let mut bytes = Vec::new();
            stdout
                .take(MAX_OUTPUT + 1)
                .read_to_end(&mut bytes)
                .await
                .map_err(|_| uncertain())?;
            if bytes.len() as u64 > MAX_OUTPUT {
                return Err(uncertain());
            }
            if !child.wait().await.map_err(|_| uncertain())?.success() {
                return Err(uncertain());
            }
            Ok(bytes)
        })
        .await
        .map_err(|_| uncertain())
        .and_then(|result| result);
        if result.is_err() {
            let _ = child.start_kill();
            let _ = tokio::time::timeout(Duration::from_secs(3), child.wait()).await;
        }
        result
    }

    async fn list_filter(&self, filter: &str, value: &str) -> Result<Vec<Identity>> {
        let bytes = self
            .run(&["list", "shares", "--json", filter, value])
            .await?;
        let listing: Listing = serde_json::from_slice(&bytes).map_err(|_| uncertain())?;
        Ok(listing.shares)
    }

    async fn list(&self) -> Result<Vec<Identity>> {
        // The CLI filter is a substring search; enforce exact target identity locally.
        Ok(self
            .list_filter("--target", &self.target)
            .await?
            .into_iter()
            .filter(|share| {
                share.target == self.target
                    || share.target == self.target.trim_start_matches("http://")
            })
            .collect())
    }

    async fn token_records(&self, token: &str) -> Result<Vec<Identity>> {
        Ok(self
            .list_filter("--share-token", token)
            .await?
            .into_iter()
            .filter(|identity| identity.share_token == token)
            .collect())
    }

    fn valid(&self, identity: &Identity) -> bool {
        let identifier = |value: &str| {
            !value.is_empty()
                && value.len() <= 128
                && value
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || b"-_.".contains(&byte))
        };
        identifier(&identity.share_token)
            && identifier(&identity.environment)
            && identity.environment == self.environment
            && identity.share_mode == "public"
            && identity.backend_mode == "proxy"
            && identity.frontend_endpoints.len() == 1
            && identity.frontend_endpoints.iter().all(|endpoint| {
                endpoint
                    .trim_start_matches("https://")
                    .trim_end_matches('/')
                    == self.host
            })
    }

    pub(super) async fn discover(&mut self) -> Result<bool> {
        let mut shares = self.list().await?;
        if shares.is_empty() {
            return Ok(false);
        }
        if shares.len() != 1 {
            return Err(uncertain());
        }
        let identity = shares.pop().ok_or_else(uncertain)?;
        if !self.valid(&identity) {
            return Err(uncertain());
        }
        if self
            .identity
            .as_ref()
            .is_some_and(|previous| previous != &identity)
        {
            return Err(uncertain());
        }
        self.identity = Some(identity);
        Ok(true)
    }

    pub(super) async fn retire(&mut self) -> Result<()> {
        if self.identity.is_none() && !self.discover().await? {
            return Ok(());
        }
        let identity = self.identity.as_ref().ok_or_else(uncertain)?;
        let shares = self.token_records(&identity.share_token).await?;
        let Some(current) = shares
            .iter()
            .find(|share| share.share_token == identity.share_token)
        else {
            // Our share disappeared; a replacement belonging to someone else is left alone.
            return Ok(());
        };
        if shares.len() != 1 || current != identity || !self.valid(current) {
            return Err(uncertain());
        }
        // Never delete by name. Pin both the exact share token and its recorded owner environment.
        let result = self
            .run(&[
                "delete",
                "share",
                &identity.share_token,
                "--envzid",
                &identity.environment,
            ])
            .await;
        let remaining = self.token_records(&identity.share_token).await?;
        if remaining
            .iter()
            .any(|share| share.share_token == identity.share_token)
        {
            return Err(uncertain());
        }
        // A lost delete reply is resolved by the independent absence check.
        let _ = result;
        Ok(())
    }
}
