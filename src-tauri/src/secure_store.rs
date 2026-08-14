//! Authenticated session storage backed by an OS-protected master key.

use crate::paths::atomic_write;
use aes_gcm::{
    aead::{Aead, Generate, KeyInit, Payload},
    Aes256Gcm, Key, Nonce,
};
use keyring::{Entry, Error as KeyringError};
use serde::{de::DeserializeOwned, Serialize};
use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::{AppHandle, Manager};

const MAGIC: &[u8; 8] = b"OXVAULT1";
const NONCE_BYTES: usize = 12;
const KEY_BYTES: usize = 32;
const KEYRING_USER: &str = "session-vault-key-v1";
static STORE_LOCK: Mutex<()> = Mutex::new(());

fn data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|_| "The app credential directory is unavailable.".to_string())?;
    fs::create_dir_all(&dir)
        .map_err(|_| "The app credential directory could not be created.".to_string())?;
    Ok(dir)
}

fn vault_path(app: &AppHandle, slot: &str) -> Result<PathBuf, String> {
    Ok(data_dir(app)?.join(format!("{slot}.vault")))
}

fn aad(app: &AppHandle, slot: &str) -> String {
    format!("{}:{slot}:v1", app.config().identifier)
}

fn keyring_entry(app: &AppHandle) -> Result<Entry, String> {
    Entry::new(&app.config().identifier, KEYRING_USER)
        .map_err(|_| "The operating system credential vault is unavailable.".to_string())
}

fn load_master_key(app: &AppHandle, create: bool) -> Result<Option<Vec<u8>>, String> {
    let entry = keyring_entry(app)?;
    match entry.get_secret() {
        Ok(key) if key.len() == KEY_BYTES => Ok(Some(key)),
        Ok(_) => Err("The session encryption key is invalid. Sign in again.".into()),
        Err(KeyringError::NoEntry) if !create => Ok(None),
        Err(KeyringError::NoEntry) => {
            let key = Key::<Aes256Gcm>::generate().to_vec();
            entry
                .set_secret(&key)
                .map_err(|_| "The session encryption key could not be saved.".to_string())?;
            Ok(Some(key))
        }
        Err(_) => Err("The operating system credential vault is unavailable.".into()),
    }
}

fn seal(plaintext: &[u8], key: &[u8], aad: &[u8]) -> Result<Vec<u8>, String> {
    let cipher = Aes256Gcm::new_from_slice(key)
        .map_err(|_| "The session encryption key is invalid.".to_string())?;
    let nonce = Nonce::generate();
    let ciphertext = cipher
        .encrypt(
            &nonce,
            Payload {
                msg: plaintext,
                aad,
            },
        )
        .map_err(|_| "The session could not be encrypted.".to_string())?;
    let mut envelope = Vec::with_capacity(MAGIC.len() + NONCE_BYTES + ciphertext.len());
    envelope.extend_from_slice(MAGIC);
    envelope.extend_from_slice(&nonce);
    envelope.extend_from_slice(&ciphertext);
    Ok(envelope)
}

fn open(envelope: &[u8], key: &[u8], aad: &[u8]) -> Result<Vec<u8>, String> {
    if envelope.len() < MAGIC.len() + NONCE_BYTES + 16 || &envelope[..MAGIC.len()] != MAGIC {
        return Err("The saved session is not a valid encrypted credential.".into());
    }
    let cipher = Aes256Gcm::new_from_slice(key)
        .map_err(|_| "The session encryption key is invalid.".to_string())?;
    let nonce = Nonce::try_from(&envelope[MAGIC.len()..MAGIC.len() + NONCE_BYTES])
        .map_err(|_| "The saved session nonce is invalid.".to_string())?;
    cipher
        .decrypt(
            &nonce,
            Payload {
                msg: &envelope[MAGIC.len() + NONCE_BYTES..],
                aad,
            },
        )
        .map_err(|_| "The saved session failed integrity verification. Sign in again.".into())
}

#[cfg(unix)]
fn restrict_file_permissions(path: &std::path::Path) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(0o600))
        .map_err(|_| "The encrypted session permissions could not be secured.".to_string())
}

#[cfg(not(unix))]
fn restrict_file_permissions(_path: &std::path::Path) -> Result<(), String> {
    Ok(())
}

pub fn load<T: DeserializeOwned>(app: &AppHandle, slot: &str) -> Result<Option<T>, String> {
    let _guard = STORE_LOCK
        .lock()
        .map_err(|_| "The secure session store is unavailable.".to_string())?;
    let path = vault_path(app, slot)?;
    if !path.exists() {
        return Ok(None);
    }
    let key = load_master_key(app, false)?
        .ok_or_else(|| "The session encryption key is missing. Sign in again.".to_string())?;
    let envelope =
        fs::read(path).map_err(|_| "The encrypted session could not be read.".to_string())?;
    let plaintext = open(&envelope, &key, aad(app, slot).as_bytes())?;
    serde_json::from_slice(&plaintext)
        .map(Some)
        .map_err(|_| "The encrypted session contains invalid data. Sign in again.".to_string())
}

pub fn save<T: Serialize>(app: &AppHandle, slot: &str, value: &T) -> Result<(), String> {
    let _guard = STORE_LOCK
        .lock()
        .map_err(|_| "The secure session store is unavailable.".to_string())?;
    let key = load_master_key(app, true)?
        .ok_or_else(|| "The session encryption key could not be created.".to_string())?;
    let plaintext = serde_json::to_vec(value)
        .map_err(|_| "The session could not be serialized.".to_string())?;
    let envelope = seal(&plaintext, &key, aad(app, slot).as_bytes())?;
    let path = vault_path(app, slot)?;
    atomic_write(&path, &envelope)
        .map_err(|_| "The encrypted session could not be saved.".to_string())?;
    restrict_file_permissions(&path)
}

pub fn clear(app: &AppHandle, slot: &str) -> Result<(), String> {
    let _guard = STORE_LOCK
        .lock()
        .map_err(|_| "The secure session store is unavailable.".to_string())?;
    let path = vault_path(app, slot)?;
    if path.exists() {
        fs::remove_file(path)
            .map_err(|_| "The encrypted session could not be removed.".to_string())?;
    }
    Ok(())
}

pub fn remove_legacy_plaintext(app: &AppHandle, file_name: &str) -> Result<(), String> {
    let _guard = STORE_LOCK
        .lock()
        .map_err(|_| "The secure session store is unavailable.".to_string())?;
    let path = data_dir(app)?.join(file_name);
    if path.exists() {
        fs::remove_file(path)
            .map_err(|_| "An insecure legacy session could not be removed.".to_string())?;
    }
    Ok(())
}

pub fn with_best_effort_cleanup<T>(
    operation: impl FnOnce() -> Result<T, String>,
    cleanup: impl FnOnce() -> Result<(), String>,
) -> Result<T, String> {
    let result = operation();
    let _ = cleanup();
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encrypted_envelope_round_trips_without_plaintext() {
        let key = [7_u8; KEY_BYTES];
        let plaintext = br#"{"refreshToken":"refresh-token-secret"}"#;
        let envelope = seal(plaintext, &key, b"app:xai:v1").unwrap();
        assert!(!envelope
            .windows(b"refresh-token-secret".len())
            .any(|window| window == b"refresh-token-secret"));
        assert_eq!(open(&envelope, &key, b"app:xai:v1").unwrap(), plaintext);
    }

    #[test]
    fn encrypted_envelope_rejects_tampering_and_slot_swaps() {
        let key = [9_u8; KEY_BYTES];
        let mut envelope = seal(b"session", &key, b"app:openai:v1").unwrap();
        let last = envelope.len() - 1;
        envelope[last] ^= 1;
        assert!(open(&envelope, &key, b"app:openai:v1").is_err());

        let envelope = seal(b"session", &key, b"app:openai:v1").unwrap();
        assert!(open(&envelope, &key, b"app:xai:v1").is_err());
    }

    #[test]
    fn legacy_cleanup_is_best_effort_and_the_vault_result_is_authoritative() {
        let loaded = with_best_effort_cleanup(
            || Ok::<_, String>("session"),
            || Err("legacy cleanup failed".into()),
        );
        assert_eq!(loaded.unwrap(), "session");

        let failed = with_best_effort_cleanup::<()>(
            || Err("vault failed".into()),
            || Err("legacy cleanup failed".into()),
        );
        assert_eq!(failed.unwrap_err(), "vault failed");
    }
}
