//! Explicit native-only import of the existing Secret Tunnel bearer URL.
use super::{validate_settings, ConnectionSettings};
use crate::{Error, Result};
use cap_fs_ext::{DirExt, FollowSymlinks, MetadataExt, OpenOptionsFollowExt, OpenOptionsSyncExt};
use cap_std::fs::{Dir, OpenOptions};
use serde::Deserialize;
use std::io::Read;
use std::path::{Path, PathBuf};

const FILE: &str = "secret-tunnel-connector.json";
const MAX_BYTES: u64 = 8192;

// Deliberately not Serialize or Debug: never include native credentials in UI config/errors.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Connector {
    version: u32,
    reservation: String,
    public_url: String,
    pub(super) public_path_token: String,
    pub(super) zrok_home: Option<PathBuf>,
}

impl Connector {
    pub(super) fn configure_command(&self, command: &mut tokio::process::Command) {
        if let Some(home) = &self.zrok_home {
            // zrok v2.0.4 resolves .zrok2 via os.UserHomeDir; it has no ZROK2_HOME override.
            #[cfg(unix)]
            command.env("HOME", home);
            #[cfg(windows)]
            command.env("USERPROFILE", home);
        }
    }
}

fn invalid() -> Error {
    Error::new("connector", "The private Secret Tunnel import is invalid or does not match this connection setup. Reimport it before starting.")
}

pub(super) fn present(state: &Path) -> bool {
    std::fs::symlink_metadata(state.join(FILE)).is_ok()
}

fn private(metadata: &cap_std::fs::Metadata) -> bool {
    #[cfg(unix)]
    {
        use cap_std::fs::PermissionsExt;
        metadata.permissions().mode() & 0o077 == 0
    }
    #[cfg(not(unix))]
    {
        let _ = metadata;
        true
    }
}

pub(super) fn load(state: &Path, settings: &ConnectionSettings) -> Result<Option<Connector>> {
    let directory =
        Dir::open_ambient_dir(state, cap_std::ambient_authority()).map_err(|_| invalid())?;
    match directory.symlink_metadata(FILE) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err(invalid()),
        Ok(metadata) if !metadata.is_file() => return Err(invalid()),
        Ok(_) => (),
    }
    let mut options = OpenOptions::new();
    options.read(true).follow(FollowSymlinks::No).nonblock(true);
    let mut file = directory.open_with(FILE, &options).map_err(|_| invalid())?;
    let before = file.metadata().map_err(|_| invalid())?;
    if !before.is_file() || before.nlink() != 1 || before.len() > MAX_BYTES || !private(&before) {
        return Err(invalid());
    }
    let mut bytes = Vec::new();
    (&mut file)
        .take(MAX_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| invalid())?;
    let after = file.metadata().map_err(|_| invalid())?;
    let current = directory.symlink_metadata(FILE).map_err(|_| invalid())?;
    if bytes.len() as u64 != before.len()
        || bytes.len() as u64 > MAX_BYTES
        || after.len() != before.len()
        || before.modified().ok() != after.modified().ok()
        || !current.is_file()
        || current.nlink() != 1
        || !private(&current)
        || (before.dev(), before.ino()) != (current.dev(), current.ino())
    {
        return Err(invalid());
    }
    let connector: Connector = serde_json::from_slice(&bytes).map_err(|_| invalid())?;
    let validated =
        validate_settings(&connector.reservation, &connector.public_url).map_err(|_| invalid())?;
    if connector.version != 1
        || validated.reservation != settings.reservation
        || validated.public_url != settings.public_url
        || connector.public_url != validated.public_url
        || !(8..=64).contains(&connector.public_path_token.len())
        || !connector
            .public_path_token
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
    {
        return Err(invalid());
    }
    if let Some(home) = &connector.zrok_home {
        // Imported activation lives in a dedicated native-state child, never the source CLI store.
        if !home.is_absolute() || home.parent() != Some(state) {
            return Err(invalid());
        }
        let name = home.file_name().ok_or_else(invalid)?;
        let home = directory.open_dir_nofollow(name).map_err(|_| invalid())?;
        if !private(&home.dir_metadata().map_err(|_| invalid())?) {
            return Err(invalid());
        }
        let activation = home.open_dir_nofollow(".zrok2").map_err(|_| invalid())?;
        if !private(&activation.dir_metadata().map_err(|_| invalid())?) {
            return Err(invalid());
        }
    }
    Ok(Some(connector))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn profile() -> serde_json::Value {
        json!({"version":1,"reservation":"existing-name","publicUrl":"https://existing-name.shares.zrok.io","publicPathToken":"existing_private_token"})
    }
    fn write(state: &Path, value: &[u8]) {
        let path = state.join(FILE);
        std::fs::write(&path, value).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600)).unwrap();
        }
    }
    fn settings() -> ConnectionSettings {
        validate_settings("existing-name", "https://existing-name.shares.zrok.io").unwrap()
    }
    #[test]
    fn private_profile_requires_exact_setup_and_bounded_strict_content() {
        let temp = tempfile::tempdir().unwrap();
        assert!(load(temp.path(), &settings()).unwrap().is_none());
        write(temp.path(), &serde_json::to_vec(&profile()).unwrap());
        let connector = load(temp.path(), &settings()).unwrap().unwrap();
        assert_eq!(connector.public_path_token, "existing_private_token");
        for (field, value) in [
            ("version", json!(2)),
            ("reservation", json!("other-name")),
            ("publicUrl", json!("https://other.example")),
            ("publicPathToken", json!("too-short".repeat(9))),
            ("publicPathToken", json!("traverse/secret")),
            ("grant", json!(true)),
            ("zrokHome", json!("relative")),
        ] {
            let mut invalid = profile();
            invalid[field] = value;
            write(temp.path(), &serde_json::to_vec(&invalid).unwrap());
            assert!(load(temp.path(), &settings()).is_err(), "{field}");
        }
        for bytes in [b"{malformed".to_vec(), vec![b' '; MAX_BYTES as usize + 1]] {
            write(temp.path(), &bytes);
            assert!(load(temp.path(), &settings()).is_err());
        }
    }

    #[cfg(unix)]
    #[test]
    fn links_and_public_permissions_are_refused_without_following() {
        use std::os::unix::fs::{symlink, PermissionsExt};
        let temp = tempfile::tempdir().unwrap();
        write(temp.path(), &serde_json::to_vec(&profile()).unwrap());
        let file = temp.path().join(FILE);
        std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o644)).unwrap();
        assert!(load(temp.path(), &settings()).is_err());
        std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o600)).unwrap();
        let original = temp.path().join("original");
        std::fs::rename(&file, &original).unwrap();
        symlink(&original, &file).unwrap();
        assert!(load(temp.path(), &settings()).is_err());
        std::fs::remove_file(&file).unwrap();
        std::fs::hard_link(&original, &file).unwrap();
        assert!(load(temp.path(), &settings()).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn dedicated_zrok_home_must_be_private_native_child_without_symlink() {
        use std::os::unix::fs::{symlink, PermissionsExt};
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path().join("zrok-home-fixture");
        std::fs::create_dir(&home).unwrap();
        std::fs::set_permissions(&home, std::fs::Permissions::from_mode(0o700)).unwrap();
        let activation = home.join(".zrok2");
        std::fs::create_dir(&activation).unwrap();
        std::fs::set_permissions(&activation, std::fs::Permissions::from_mode(0o700)).unwrap();
        let mut value = profile();
        value["zrokHome"] = json!(home);
        write(temp.path(), &serde_json::to_vec(&value).unwrap());
        assert!(load(temp.path(), &settings()).is_ok());
        std::fs::set_permissions(&activation, std::fs::Permissions::from_mode(0o755)).unwrap();
        assert!(load(temp.path(), &settings()).is_err());
        std::fs::set_permissions(&activation, std::fs::Permissions::from_mode(0o700)).unwrap();
        std::fs::set_permissions(&home, std::fs::Permissions::from_mode(0o755)).unwrap();
        assert!(load(temp.path(), &settings()).is_err());
        std::fs::set_permissions(&home, std::fs::Permissions::from_mode(0o700)).unwrap();
        std::fs::remove_dir(&activation).unwrap();
        symlink(temp.path(), &activation).unwrap();
        assert!(load(temp.path(), &settings()).is_err());
        std::fs::remove_file(&activation).unwrap();
        std::fs::remove_dir(&home).unwrap();
        symlink(temp.path(), &home).unwrap();
        assert!(load(temp.path(), &settings()).is_err());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn imported_activation_uses_only_the_owned_childs_home() {
        use std::os::unix::fs::PermissionsExt;
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path().join("zrok-home-fixture");
        let activation = home.join(".zrok2");
        std::fs::create_dir_all(&activation).unwrap();
        for path in [&home, &activation] {
            std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700)).unwrap();
        }
        std::fs::write(activation.join("metadata.json"), "fixture-activation").unwrap();
        let mut value = profile();
        value["zrokHome"] = json!(home);
        write(temp.path(), &serde_json::to_vec(&value).unwrap());
        let connector = load(temp.path(), &settings()).unwrap().unwrap();
        let parent_home = std::env::var_os("HOME");
        let mut command = tokio::process::Command::new("sh");
        command.args(["-c", "cat \"$HOME/.zrok2/metadata.json\""]);
        connector.configure_command(&mut command);
        let result = command.output().await.unwrap();
        assert!(result.status.success());
        assert_eq!(result.stdout, b"fixture-activation");
        assert_eq!(std::env::var_os("HOME"), parent_home);
    }
}
