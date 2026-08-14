//! Project root allowlist + shared path sensitivity checks.

use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, MutexGuard, OnceLock};
use tauri::{AppHandle, Manager};

#[cfg(windows)]
use std::os::windows::ffi::OsStrExt;
#[cfg(windows)]
use windows_sys::Win32::Storage::FileSystem::{
    MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
};

const REGISTRY_FILE: &str = "project_roots.json";
static REGISTRY_LOCK: Mutex<()> = Mutex::new(());
static NEXT_REGISTRY_WRITE: AtomicU64 = AtomicU64::new(1);

#[derive(Debug, Default, Serialize, Deserialize)]
struct RootRegistry {
    #[serde(default)]
    roots: Vec<String>,
}

fn registry_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app data dir: {e}"))?;
    fs::create_dir_all(&dir).map_err(|e| format!("create app data: {e}"))?;
    Ok(dir.join(REGISTRY_FILE))
}

fn load_registry(app: &AppHandle) -> Result<RootRegistry, String> {
    let path = registry_path(app)?;
    if !path.exists() {
        return Ok(RootRegistry::default());
    }
    let raw = fs::read_to_string(&path).map_err(|e| format!("read project roots: {e}"))?;
    serde_json::from_str(&raw).map_err(|e| format!("parse project roots: {e}"))
}

fn save_registry(app: &AppHandle, reg: &RootRegistry) -> Result<(), String> {
    let path = registry_path(app)?;
    let raw = serde_json::to_string(reg).map_err(|e| format!("serialize roots: {e}"))?;
    atomic_write(&path, raw.as_bytes()).map_err(|e| format!("write project roots: {e}"))
}

pub(crate) fn atomic_write(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let parent = path.parent().ok_or_else(|| {
        std::io::Error::new(std::io::ErrorKind::InvalidInput, "path has no parent")
    })?;
    let name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("registry");
    let mut temporary = None;
    for _ in 0..16 {
        let id = NEXT_REGISTRY_WRITE.fetch_add(1, Ordering::Relaxed);
        let candidate = parent.join(format!(".{name}.{}.{}.tmp", std::process::id(), id));
        match fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&candidate)
        {
            Ok(file) => {
                temporary = Some((candidate, file));
                break;
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(error),
        }
    }
    let (temporary_path, mut file) = temporary.ok_or_else(|| {
        std::io::Error::new(
            std::io::ErrorKind::AlreadyExists,
            "could not create a unique registry temp file",
        )
    })?;
    let result = (|| {
        file.write_all(bytes)?;
        file.sync_all()?;
        drop(file);
        replace_file(&temporary_path, path)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary_path);
    }
    result
}

#[cfg(not(windows))]
fn replace_file(from: &Path, to: &Path) -> std::io::Result<()> {
    fs::rename(from, to)
}

#[cfg(windows)]
fn replace_file(from: &Path, to: &Path) -> std::io::Result<()> {
    let from_wide: Vec<u16> = from.as_os_str().encode_wide().chain(Some(0)).collect();
    let to_wide: Vec<u16> = to.as_os_str().encode_wide().chain(Some(0)).collect();
    if unsafe {
        MoveFileExW(
            from_wide.as_ptr(),
            to_wide.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    } == 0
    {
        Err(std::io::Error::last_os_error())
    } else {
        Ok(())
    }
}

fn lock_registry() -> Result<MutexGuard<'static, ()>, String> {
    REGISTRY_LOCK
        .lock()
        .map_err(|_| "Project root registry lock is poisoned".to_string())
}

/// Canonicalize and normalize path for stable comparisons (Windows `\\?\` prefix).
pub fn canonicalize_dir(path: &Path) -> Result<PathBuf, String> {
    if !path.is_dir() {
        return Err(format!("Not a directory: {}", path.display()));
    }
    let canon = fs::canonicalize(path).map_err(|e| format!("{}: {e}", path.display()))?;
    Ok(strip_verbatim_prefix(canon))
}

/// Drop Win32 `\\?\` / `\\?\UNC\` so absolute paths compare equal across APIs.
pub fn strip_verbatim_prefix(path: PathBuf) -> PathBuf {
    let s = path.to_string_lossy();
    #[cfg(windows)]
    {
        if let Some(rest) = s.strip_prefix(r"\\?\UNC\") {
            return PathBuf::from(format!(r"\\{rest}"));
        }
        if let Some(rest) = s.strip_prefix(r"\\?\") {
            return PathBuf::from(rest);
        }
    }
    let _ = s;
    path
}

/// Stable path compare key (slash-normalized, lowercased on Windows).
pub fn path_compare_key(path: &Path) -> String {
    path_key(&strip_verbatim_prefix(path.to_path_buf()))
}

/// True if `child` is `root` or a path under `root` (Windows-safe).
pub fn is_path_within_root(root: &Path, child: &Path) -> bool {
    let root_k = path_compare_key(root);
    let child_k = path_compare_key(child);
    if child_k == root_k {
        return true;
    }
    let prefix = if root_k.ends_with('/') {
        root_k
    } else {
        format!("{root_k}/")
    };
    child_k.starts_with(&prefix)
}

pub fn path_key(path: &Path) -> String {
    let mut s = path.to_string_lossy().replace('\\', "/");
    while s.ends_with('/') && s.len() > 1 {
        s.pop();
    }
    // Windows drive letters — compare case-insensitively via lowercase key
    if cfg!(windows) {
        s = s.to_ascii_lowercase();
    }
    s
}

/// Block env/credential-like names from agent tools and project scans.
pub fn is_sensitive_name(name: &str) -> bool {
    if cfg!(windows) && name.contains(':') {
        return true;
    }
    let normalized = if cfg!(windows) {
        name.trim_end_matches([' ', '.'])
    } else {
        name
    };
    let lower = normalized.to_ascii_lowercase();
    if lower == ".env" || (lower.starts_with(".env.") && lower != ".env.example") {
        return true;
    }
    if matches!(
        lower.as_str(),
        "auth.json" | "auth.vault" | "openai-auth.json" | "openai-auth.vault"
    ) || lower.ends_with("-auth.json")
        || lower.ends_with("-auth.vault")
        || lower.ends_with("_auth.json")
        || lower.ends_with("_auth.vault")
    {
        return true;
    }
    if lower.contains("secret")
        && (lower.ends_with(".json")
            || lower.ends_with(".yml")
            || lower.ends_with(".yaml")
            || lower.ends_with(".toml")
            || lower.ends_with(".env")
            || lower.ends_with(".ts")
            || lower.ends_with(".js"))
    {
        return true;
    }
    matches!(
        lower.as_str(),
        ".npmrc"
            | ".pypirc"
            | "credentials"
            | "credentials.json"
            | "service-account.json"
            | "id_rsa"
            | "id_dsa"
            | "id_ecdsa"
            | "id_ed25519"
            | "secrets.json"
            | "secret.json"
            | ".netrc"
            | "netrc"
            | "appsettings.production.json"
            | "appsettings.development.json"
            | "docker-compose.override.yml"
            | "docker-compose.override.yaml"
            | ".git-credentials"
            | "kubeconfig"
            | ".kubeconfig"
    ) || lower.ends_with(".pem")
        || lower.ends_with(".key")
        || lower.ends_with(".p12")
        || lower.ends_with(".pfx")
        || lower.ends_with(".keystore")
        || lower.ends_with(".jks")
        || lower.ends_with(".ppk")
        || lower.ends_with(".kdbx")
        || lower.ends_with(".kdb")
        || lower.ends_with("_rsa")
        || lower.ends_with("_ed25519")
        || lower.ends_with(".mobileprovision")
}

/// Redact common secret-looking spans before tool/API output leaves the host.
pub fn redact_secrets(text: &str) -> String {
    static SECRET_PATTERNS: OnceLock<Vec<Regex>> = OnceLock::new();
    let patterns = SECRET_PATTERNS.get_or_init(|| {
        vec![
            Regex::new(r"(?i)\bsk-[A-Za-z0-9_-]{8,}\b").expect("sk token regex"),
            Regex::new(r"(?i)\b(?:ghp_|github_pat_)[A-Za-z0-9_-]{8,}\b")
                .expect("github token regex"),
            Regex::new(r"(?i)((?:bearer|basic)\s+)[A-Za-z0-9._~+/=-]+")
                .expect("authorization regex"),
            Regex::new(
                r"\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{8,}\b",
            )
            .expect("jwt regex"),
            Regex::new(
                r#"(?i)(["']?(?:[a-z0-9]+[_-])*(?:access[_-]?token|refresh[_-]?token|id[_-]?token|api[_-]?key|client[_-]?secret|token|secret|signature|password|cookie|authorization)["']?\s*[:=]\s*["']?)[^"'\s,}]+"#,
            )
            .expect("named secret regex"),
            Regex::new(
                r"(?i)([?&](?:token|key|api_key|access_token|refresh_token|id_token|code|secret|signature)=)[^&#\s]+",
            )
            .expect("query secret regex"),
        ]
    });
    patterns
        .iter()
        .fold(redact_private_key_blocks(text), |value, pattern| {
            pattern.replace_all(&value, "${1}[REDACTED]").into_owned()
        })
}

/// Redact tool arguments while preserving valid JSON for the webview when possible.
pub fn redact_tool_arguments(text: &str) -> String {
    let Ok(mut value) = serde_json::from_str::<Value>(text) else {
        return redact_secrets(text);
    };
    redact_json_secrets(&mut value);
    serde_json::to_string(&value).unwrap_or_else(|_| redact_secrets(text))
}

fn redact_json_secrets(value: &mut Value) {
    match value {
        Value::Object(object) => {
            for (key, value) in object {
                if is_sensitive_key(key) {
                    *value = Value::String("[REDACTED]".into());
                } else {
                    redact_json_secrets(value);
                }
            }
        }
        Value::Array(values) => {
            for value in values {
                redact_json_secrets(value);
            }
        }
        Value::String(text) => *text = redact_secrets(text),
        _ => {}
    }
}

fn is_sensitive_key(key: &str) -> bool {
    let normalized: String = key
        .chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .flat_map(char::to_lowercase)
        .collect();
    matches!(
        normalized.as_str(),
        "token" | "secret" | "signature" | "authorization" | "password" | "cookie" | "privatekey"
    ) || normalized.ends_with("accesstoken")
        || normalized.ends_with("refreshtoken")
        || normalized.ends_with("idtoken")
        || normalized.ends_with("apikey")
        || normalized.ends_with("clientsecret")
}

fn redact_private_key_blocks(text: &str) -> String {
    let lower = text.to_ascii_lowercase();
    let mut out = String::with_capacity(text.len());
    let mut idx = 0;
    while let Some(rel) = lower[idx..].find("-----begin") {
        let start = idx + rel;
        out.push_str(&text[idx..start]);
        let from_lower = &lower[start..];
        // Only inspect this PEM header line — never the rest of the document —
        // so a later "private key" mention cannot redact CERTIFICATE/PUBLIC KEY.
        let header_end = from_lower.find('\n').unwrap_or(from_lower.len()).min(120);
        let header = &from_lower[..header_end];
        let is_key = header.contains("private key");
        if is_key {
            if let Some(end_rel) = from_lower.find("-----end") {
                let after_end = &from_lower[end_rel + 8..];
                if let Some(close) = after_end.find("-----") {
                    let end = start + end_rel + 8 + close + 5;
                    out.push_str("[REDACTED_PRIVATE_KEY]");
                    idx = end.min(text.len());
                    continue;
                }
            }
        }
        // Not a private key or malformed — keep begin marker and continue.
        out.push_str(&text[start..start + "-----begin".len().min(text.len() - start)]);
        idx = start + "-----begin".len();
    }
    out.push_str(&text[idx..]);
    out
}

#[cfg(test)]
mod tests {
    use super::{
        atomic_write, redact_private_key_blocks, redact_secrets, redact_tool_arguments,
        RootRegistry, NEXT_REGISTRY_WRITE,
    };
    use std::fs;
    use std::sync::atomic::Ordering;

    fn pem_begin(kind: &str) -> String {
        format!("-----BEGIN {kind}-----")
    }

    fn pem_end(kind: &str) -> String {
        format!("-----END {kind}-----")
    }

    #[test]
    fn redacts_real_private_key_pem() {
        // kind split avoids accidental fixture rewriting by secret scanners
        let kind = format!("{} {}", "RSA", "PRIVATE KEY");
        let raw = format!(
            "{}\nSECRET_MATERIAL\n{}\n",
            pem_begin(&kind),
            pem_end(&kind)
        );
        let out = redact_private_key_blocks(&raw);
        assert!(out.contains("[REDACTED_PRIVATE_KEY]"), "{out}");
        assert!(!out.contains("SECRET_MATERIAL"), "{out}");
        assert!(!out.contains("BEGIN RSA PRIVATE KEY"), "{out}");
    }

    #[test]
    fn keeps_certificate_when_prose_mentions_private_key() {
        let kind = "CERTIFICATE";
        let raw = format!(
            "{}\nMIIBcertDATA\n{}\nafter private key docs\n",
            pem_begin(kind),
            pem_end(kind)
        );
        let out = redact_private_key_blocks(&raw);
        assert!(out.contains("MIIBcertDATA"), "{out}");
        assert!(out.contains("BEGIN CERTIFICATE"), "{out}");
        assert!(!out.contains("[REDACTED_PRIVATE_KEY]"), "{out}");
    }

    #[test]
    fn keeps_public_key_when_private_key_follows() {
        let pub_kind = format!("{} {}", "PUBLIC", "KEY");
        let priv_kind = format!("{} {}", "PRIVATE", "KEY");
        let raw = format!(
            "{}\nPUBDATA\n{}\n{}\nSECRET\n{}\n",
            pem_begin(&pub_kind),
            pem_end(&pub_kind),
            pem_begin(&priv_kind),
            pem_end(&priv_kind)
        );
        let out = redact_private_key_blocks(&raw);
        assert!(out.contains("PUBDATA"), "{out}");
        assert!(out.contains("BEGIN PUBLIC KEY"), "{out}");
        assert!(out.contains("[REDACTED_PRIVATE_KEY]"), "{out}");
        assert!(!out.contains("SECRET"), "{out}");
    }

    #[test]
    fn redact_secrets_still_strips_token_prefixes() {
        let rest = "abcdefghijklmnopqrstuvwxyz12";
        let sk = format!("sk-{rest}");
        let ghp = format!("ghp_{rest}");
        let raw = format!("token {sk} and {ghp}");
        let out = redact_secrets(&raw);
        assert!(out.contains("[REDACTED]"), "{out}");
        assert!(!out.contains(&sk), "{out}");
        assert!(!out.contains(&ghp), "{out}");
    }

    #[test]
    fn redact_tool_arguments_preserves_json_and_removes_named_secrets() {
        let raw = r#"{"path":"src/main.rs","token":"plain-token","signature":"plain-signature","id_token":"identity-secret","env":{"OPENAI_API_KEY":"api-secret"},"command":"curl https://example.test?access_token=query-secret"}"#;
        let out = redact_tool_arguments(raw);
        let value: serde_json::Value = serde_json::from_str(&out).unwrap();
        assert_eq!(value["path"], "src/main.rs");
        assert_eq!(value["token"], "[REDACTED]");
        assert_eq!(value["signature"], "[REDACTED]");
        assert_eq!(value["id_token"], "[REDACTED]");
        assert_eq!(value["env"]["OPENAI_API_KEY"], "[REDACTED]");
        assert!(!out.contains("identity-secret"), "{out}");
        assert!(!out.contains("api-secret"), "{out}");
        assert!(!out.contains("query-secret"), "{out}");
    }

    #[test]
    fn provider_auth_session_files_are_sensitive() {
        for name in [
            "auth.json",
            "openai-auth.json",
            "xai-auth.json",
            "xai_auth.json",
            "openai-auth.vault",
        ] {
            assert!(super::is_sensitive_name(name), "{name} was not blocked");
        }
    }

    #[cfg(windows)]
    #[test]
    fn windows_aliases_of_sensitive_files_are_sensitive() {
        for name in [
            ".env::$DATA",
            "auth.json::$DATA",
            "openai-auth.json:backup",
            "auth.json.",
            "auth.json ",
        ] {
            assert!(super::is_sensitive_name(name), "{name} was not blocked");
        }
        assert!(!super::is_sensitive_name("src-main.rs"));
    }

    #[test]
    fn atomic_write_replaces_registry_without_leaving_temp_files() {
        let dir = std::env::temp_dir().join(format!(
            "grokapp-registry-{}-{}",
            std::process::id(),
            NEXT_REGISTRY_WRITE.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("project_roots.json");
        fs::write(&path, br#"{"roots":["old"]}"#).unwrap();
        atomic_write(&path, br#"{"roots":["new"]}"#).unwrap();
        let registry: RootRegistry =
            serde_json::from_slice(&fs::read(&path).unwrap()).expect("valid registry json");
        assert_eq!(registry.roots, vec!["new"]);
        assert_eq!(fs::read_dir(&dir).unwrap().count(), 1);
        let _ = fs::remove_dir_all(&dir);
    }
}

/// Canonicalize `path` and add it to the project-root allowlist.
pub fn register_dir(app: &AppHandle, path: &Path) -> Result<PathBuf, String> {
    let root = canonicalize_dir(path)?;
    let key = path_key(&root);
    let _guard = lock_registry()?;
    let mut reg = load_registry(app)?;
    if !reg.roots.iter().any(|r| r == &key) {
        reg.roots.push(key);
        save_registry(app, &reg)?;
    }
    Ok(root)
}

/// Remove a path from the allowlist (best-effort if the folder is already gone).
pub fn unregister_dir(app: &AppHandle, path: &str) -> Result<(), String> {
    let trimmed = path.trim();
    crate::preview::close_workspace_if_active(app, Path::new(trimmed));
    let key = if let Ok(root) = canonicalize_dir(Path::new(trimmed)) {
        path_key(&root)
    } else {
        let mut s = trimmed.replace('\\', "/");
        if cfg!(windows) {
            s = s.to_ascii_lowercase();
        }
        while s.ends_with('/') && s.len() > 1 {
            s.pop();
        }
        s
    };
    let _guard = lock_registry()?;
    let mut reg = load_registry(app)?;
    let before = reg.roots.len();
    reg.roots.retain(|r| r != &key);
    if reg.roots.len() != before {
        save_registry(app, &reg)?;
    }
    Ok(())
}

#[tauri::command]
pub fn project_register(app: AppHandle, path: String) -> Result<String, String> {
    let root = register_dir(&app, Path::new(path.trim()))?;
    Ok(root.to_string_lossy().to_string())
}

#[tauri::command]
pub fn project_unregister(app: AppHandle, path: String) -> Result<(), String> {
    unregister_dir(&app, &path)
}

/// Returns canonical root if `path` is a registered project directory.
pub fn require_registered_root(app: &AppHandle, path: &str) -> Result<PathBuf, String> {
    let root = canonicalize_dir(Path::new(path.trim()))?;
    let key = path_key(&root);
    let _guard = lock_registry()?;
    let reg = load_registry(app)?;
    if !reg.roots.iter().any(|r| r == &key) {
        return Err("Project folder is not registered. Add it via the app first.".into());
    }
    Ok(root)
}
