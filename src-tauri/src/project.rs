//! Scan a local project folder and build prompt context for the model.

use crate::paths::{
    is_path_within_root, is_sensitive_name, redact_secrets, require_registered_root,
    strip_verbatim_prefix,
};
use base64::Engine;
use regex::Regex;
use serde::Serialize;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use tauri::AppHandle;

const MAX_TREE_ENTRIES: usize = 400;
const MAX_FILE_BYTES: u64 = 48_000;
const MAX_TOTAL_CONTEXT_CHARS: usize = 90_000;
const MAX_DEPTH: usize = 6;
const MAX_SEARCH_DEPTH: usize = 12;
const MAX_SEARCH_SCAN: usize = 8_000;
const MAX_SEARCH_RESULTS: usize = 80;
const MAX_FAVICON_BYTES: u64 = 1_000_000;
const MAX_FILE_PREVIEW_BYTES: u64 = 1_000_000;
const MAX_IMAGE_PREVIEW_BYTES: u64 = 4_000_000;

const FAVICON_CANDIDATES: &[&str] = &[
    "favicon.svg",
    "favicon.ico",
    "favicon.png",
    "public/favicon.svg",
    "public/favicon.ico",
    "public/favicon.png",
    "app/favicon.ico",
    "app/favicon.png",
    "app/icon.svg",
    "app/icon.png",
    "src/favicon.ico",
    "src/favicon.svg",
    "src/app/favicon.ico",
    "src/app/icon.svg",
    "src/app/icon.png",
    "assets/icon.svg",
    "assets/icon.png",
    "assets/logo.svg",
    "assets/logo.png",
];

const ICON_SOURCE_FILES: &[&str] = &[
    "index.html",
    "public/index.html",
    "app/root.tsx",
    "src/root.tsx",
    "src/index.html",
];

const SKIP_DIRS: &[&str] = &[
    "node_modules",
    ".git",
    "target",
    "dist",
    "build",
    ".next",
    ".nuxt",
    ".turbo",
    ".cache",
    "coverage",
    "__pycache__",
    ".venv",
    "venv",
    ".idea",
    ".vscode",
    "out",
    ".svelte-kit",
    "Pods",
    ".gradle",
];

const SKIP_FILE_EXTS: &[&str] = &[
    "png", "jpg", "jpeg", "gif", "webp", "ico", "svg", "mp4", "mp3", "wav", "woff", "woff2", "ttf",
    "eot", "pdf", "zip", "gz", "7z", "rar", "exe", "dll", "so", "dylib", "bin", "map", "lock",
    "wasm",
];

/// Prefer these when auto-picking files to attach.
const PRIORITY_NAMES: &[&str] = &[
    "README.md",
    "readme.md",
    "package.json",
    "Cargo.toml",
    "tsconfig.json",
    "pyproject.toml",
    "go.mod",
    "Gemfile",
    "composer.json",
    "AGENTS.md",
    "src/App.tsx",
    "src/main.tsx",
    "src/main.ts",
    "src/index.ts",
    "src/index.tsx",
    "src-tauri/src/lib.rs",
    "src-tauri/src/main.rs",
    "src-tauri/Cargo.toml",
];

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectContext {
    pub path: String,
    pub name: String,
    pub tree: String,
    pub files: Vec<ProjectFile>,
    pub truncated: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectFile {
    pub relative_path: String,
    pub content: String,
}

/// One hit from composer `@` path autocomplete.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectSearchEntry {
    pub path: String,
    pub name: String,
    pub parent: String,
    pub is_dir: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectFilePreview {
    pub relative_path: String,
    pub contents: Option<String>,
    pub data_url: Option<String>,
    pub byte_length: u64,
    pub truncated: bool,
}

fn is_skip_dir(name: &str) -> bool {
    SKIP_DIRS.iter().any(|s| s.eq_ignore_ascii_case(name))
}

fn is_skip_file(path: &Path) -> bool {
    if let Some(name) = path.file_name().and_then(|n| n.to_str()) {
        if is_sensitive_name(name) {
            return true;
        }
        if name.ends_with(".min.js") || name.ends_with(".min.css") {
            return true;
        }
        if name == "package-lock.json" || name == "pnpm-lock.yaml" || name == "yarn.lock" {
            return true;
        }
    }
    if let Some(ext) = path.extension().and_then(|e| e.to_str()) {
        if SKIP_FILE_EXTS.iter().any(|s| s.eq_ignore_ascii_case(ext)) {
            return true;
        }
    }
    false
}

fn contained_entry(root: &Path, path: &Path) -> Option<PathBuf> {
    let canonical = fs::canonicalize(path).ok()?;
    let normalized_root = strip_verbatim_prefix(root.to_path_buf());
    let canonical = if root == normalized_root {
        strip_verbatim_prefix(canonical)
    } else {
        canonical
    };
    is_path_within_root(root, &canonical).then_some(canonical)
}

fn walk_tree(
    root: &Path,
    dir: &Path,
    depth: usize,
    out: &mut Vec<String>,
    files: &mut Vec<PathBuf>,
) -> Result<(), String> {
    if depth > MAX_DEPTH || out.len() >= MAX_TREE_ENTRIES {
        return Ok(());
    }

    let mut entries: Vec<_> = fs::read_dir(dir)
        .map_err(|e| format!("read_dir {}: {e}", dir.display()))?
        .filter_map(|e| e.ok())
        .collect();
    entries.sort_by_key(|e| {
        let is_dir = e.file_type().map(|t| t.is_dir()).unwrap_or(false);
        (!is_dir, e.file_name().to_string_lossy().to_lowercase())
    });

    for entry in entries {
        if out.len() >= MAX_TREE_ENTRIES {
            out.push("… (tree truncated)".into());
            break;
        }
        let path = entry.path();
        let Some(canonical) = contained_entry(root, &path) else {
            continue;
        };
        let name = entry.file_name().to_string_lossy().to_string();
        // Skip dotfiles/dirs except a small allowlist (never .env / secrets).
        if name.starts_with('.') {
            let allowed = name == ".gitignore"
                || name == ".env.example"
                || name == ".github"
                || name == ".editorconfig";
            if !allowed || is_sensitive_name(&name) {
                continue;
            }
        } else if is_sensitive_name(&name) {
            continue;
        }
        let rel = path
            .strip_prefix(root)
            .unwrap_or(&path)
            .to_string_lossy()
            .replace('\\', "/");
        let indent = "  ".repeat(depth);

        if canonical.is_dir() {
            if is_skip_dir(&name) {
                out.push(format!("{indent}{name}/  (skipped)"));
                continue;
            }
            out.push(format!("{indent}{name}/"));
            walk_tree(root, &canonical, depth + 1, out, files)?;
        } else {
            if is_skip_file(&canonical) {
                continue;
            }
            out.push(format!("{indent}{name}"));
            files.push(canonical);
            let _ = rel;
        }
    }
    Ok(())
}

fn pick_files(root: &Path, all: &[PathBuf]) -> Vec<PathBuf> {
    let mut picked: Vec<PathBuf> = Vec::new();

    for name in PRIORITY_NAMES {
        let p = root.join(name);
        let Some(canonical) = contained_entry(root, &p) else {
            continue;
        };
        if canonical.is_file() && !picked.iter().any(|x| x == &canonical) {
            picked.push(canonical);
        }
    }

    // Also grab a sample of source files under src/
    let mut sources: Vec<_> = all
        .iter()
        .filter(|p| {
            let rel = p
                .strip_prefix(root)
                .map(|r| r.to_string_lossy().replace('\\', "/"))
                .unwrap_or_default();
            let ext = p
                .extension()
                .and_then(|e| e.to_str())
                .unwrap_or("")
                .to_ascii_lowercase();
            matches!(
                ext.as_str(),
                "ts" | "tsx"
                    | "js"
                    | "jsx"
                    | "rs"
                    | "py"
                    | "go"
                    | "java"
                    | "kt"
                    | "swift"
                    | "css"
                    | "scss"
                    | "html"
                    | "vue"
                    | "svelte"
                    | "md"
            ) && (rel.starts_with("src/")
                || rel.starts_with("src-tauri/src/")
                || rel.starts_with("app/")
                || rel.starts_with("lib/")
                || rel.starts_with("packages/"))
        })
        .cloned()
        .collect();
    sources.sort();
    for p in sources {
        if picked.len() >= 24 {
            break;
        }
        if !picked.iter().any(|x| x == &p) {
            picked.push(p);
        }
    }

    picked
}

fn read_file_capped(path: &Path) -> Option<String> {
    let meta = fs::metadata(path).ok()?;
    if !meta.is_file() || meta.len() == 0 || meta.len() > MAX_FILE_BYTES {
        return None;
    }
    let bytes = fs::read(path).ok()?;
    // skip binary-ish
    if bytes.iter().take(512).any(|&b| b == 0) {
        return None;
    }
    let text = String::from_utf8(bytes).ok()?;
    Some(redact_secrets(&text))
}

/// Build context for a canonical registered root (used by IPC + chat system prompt).
pub fn build_project_context(root: &Path) -> Result<ProjectContext, String> {
    let canonical_root =
        fs::canonicalize(root).map_err(|e| format!("canonicalize {}: {e}", root.display()))?;
    let root = canonical_root.as_path();
    let name = root
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| root.display().to_string());

    let mut tree_lines = Vec::new();
    let mut all_files = Vec::new();
    walk_tree(root, root, 0, &mut tree_lines, &mut all_files)?;
    let truncated_tree = tree_lines.len() >= MAX_TREE_ENTRIES;
    let tree = tree_lines.join("\n");

    let picked = pick_files(root, &all_files);
    let mut files = Vec::new();
    let mut total_chars = tree.len();
    let mut truncated = truncated_tree;

    for p in picked {
        if total_chars >= MAX_TOTAL_CONTEXT_CHARS {
            truncated = true;
            break;
        }
        let Some(content) = read_file_capped(&p) else {
            continue;
        };
        let rel = p
            .strip_prefix(root)
            .unwrap_or(&p)
            .to_string_lossy()
            .replace('\\', "/");
        if total_chars + content.len() > MAX_TOTAL_CONTEXT_CHARS {
            truncated = true;
            let remain = MAX_TOTAL_CONTEXT_CHARS.saturating_sub(total_chars);
            if remain < 200 {
                break;
            }
            let slice: String = content.chars().take(remain).collect();
            files.push(ProjectFile {
                relative_path: rel,
                content: format!("{slice}\n… (truncated)"),
            });
            break;
        }
        total_chars += content.len();
        files.push(ProjectFile {
            relative_path: rel,
            content,
        });
    }

    Ok(ProjectContext {
        path: root.display().to_string(),
        name,
        tree,
        files,
        truncated,
    })
}

// System prompt layers live in `crate::prompts` (stable composition API).

#[tauri::command]
pub fn project_context(app: AppHandle, path: String) -> Result<ProjectContext, String> {
    let root = require_registered_root(&app, &path)?;
    build_project_context(&root)
}

/// Fuzzy path search for composer `@file` mentions.
#[tauri::command]
pub fn project_search_entries(
    app: AppHandle,
    path: String,
    query: String,
    limit: Option<usize>,
) -> Result<Vec<ProjectSearchEntry>, String> {
    let root = require_registered_root(&app, &path)?;
    let limit = limit
        .unwrap_or(MAX_SEARCH_RESULTS)
        .clamp(1, MAX_SEARCH_RESULTS);
    search_project_entries(&root, &query, limit)
}

#[tauri::command]
pub fn project_entries(app: AppHandle, path: String) -> Result<Vec<ProjectSearchEntry>, String> {
    let root = require_registered_root(&app, &path)?;
    list_project_entries(&root)
}

#[tauri::command]
pub fn project_read_file(
    app: AppHandle,
    path: String,
    relative_path: String,
) -> Result<ProjectFilePreview, String> {
    let root = require_registered_root(&app, &path)?;
    read_project_file(&root, &relative_path)
}

/// Project logo/favicon for sidebar and palette. Missing or unsafe assets fall back to a folder.
#[tauri::command]
pub fn project_favicon(app: AppHandle, path: String) -> Result<Option<String>, String> {
    let root = require_registered_root(&app, &path)?;
    let Some(icon) = resolve_project_favicon(&root)? else {
        return Ok(None);
    };
    let metadata = fs::metadata(&icon).map_err(|error| format!("favicon metadata: {error}"))?;
    if !metadata.is_file() || metadata.len() == 0 || metadata.len() > MAX_FAVICON_BYTES {
        return Ok(None);
    }
    let bytes = fs::read(&icon).map_err(|error| format!("favicon read: {error}"))?;
    let mime = match icon
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase()
        .as_str()
    {
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "ico" => "image/x-icon",
        _ => return Ok(None),
    };
    Ok(Some(format!(
        "data:{mime};base64,{}",
        base64::engine::general_purpose::STANDARD.encode(bytes)
    )))
}

fn resolve_project_favicon(root: &Path) -> Result<Option<PathBuf>, String> {
    for candidate in FAVICON_CANDIDATES {
        if let Some(path) = safe_project_file(root, candidate) {
            return Ok(Some(path));
        }
    }

    static LINK_TAG: OnceLock<Regex> = OnceLock::new();
    static REL_ICON: OnceLock<Regex> = OnceLock::new();
    static HREF: OnceLock<Regex> = OnceLock::new();
    let link_tag =
        LINK_TAG.get_or_init(|| Regex::new(r#"(?i)<link\b[^>]*>"#).expect("valid link regex"));
    let rel_icon = REL_ICON.get_or_init(|| {
        Regex::new(r#"(?i)\brel\s*=\s*[\"'](?:icon|shortcut icon)[\"']"#).expect("valid rel regex")
    });
    let href = HREF.get_or_init(|| {
        Regex::new(r#"(?i)\bhref\s*=\s*[\"']([^\"'?]+)"#).expect("valid href regex")
    });
    for source in ICON_SOURCE_FILES {
        let Some(source_path) = safe_project_file(root, source) else {
            continue;
        };
        let Ok(text) = fs::read_to_string(source_path) else {
            continue;
        };
        let Some(href) = link_tag
            .find_iter(&text)
            .map(|matched| matched.as_str())
            .find(|tag| rel_icon.is_match(tag))
            .and_then(|tag| href.captures(tag))
            .and_then(|captures| captures.get(1))
            .map(|value| value.as_str().trim_start_matches('/'))
        else {
            continue;
        };
        for candidate in [format!("public/{href}"), href.to_string()] {
            if let Some(path) = safe_project_file(root, &candidate) {
                return Ok(Some(path));
            }
        }
    }
    Ok(None)
}

fn safe_project_file(root: &Path, relative: &str) -> Option<PathBuf> {
    let relative_path = Path::new(relative);
    if relative_path.is_absolute()
        || relative_path
            .components()
            .any(|component| !matches!(component, std::path::Component::Normal(_)))
    {
        return None;
    }
    let candidate = contained_entry(root, &root.join(relative_path))?;
    candidate.is_file().then_some(candidate)
}

fn resolve_project_preview_file(root: &Path, relative: &str) -> Result<PathBuf, String> {
    let relative_path = Path::new(relative);
    if relative.is_empty()
        || relative_path.is_absolute()
        || relative_path.components().any(|component| {
            !matches!(component, std::path::Component::Normal(_))
                || component.as_os_str().to_str().is_none_or(is_sensitive_name)
        })
    {
        return Err("Invalid or sensitive project file path".into());
    }
    let candidate = contained_entry(root, &root.join(relative_path))
        .ok_or_else(|| "Project file is outside the registered workspace".to_string())?;
    candidate
        .is_file()
        .then_some(candidate)
        .ok_or_else(|| "Project file was not found".to_string())
}

fn image_preview_mime(path: &Path) -> Option<&'static str> {
    match path
        .extension()
        .and_then(|extension| extension.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase()
        .as_str()
    {
        "png" => Some("image/png"),
        "jpg" | "jpeg" => Some("image/jpeg"),
        "gif" => Some("image/gif"),
        "webp" => Some("image/webp"),
        "bmp" => Some("image/bmp"),
        _ => None,
    }
}

fn read_project_file(root: &Path, relative: &str) -> Result<ProjectFilePreview, String> {
    let path = resolve_project_preview_file(root, relative)?;
    let metadata = fs::metadata(&path).map_err(|error| format!("file metadata: {error}"))?;
    let byte_length = metadata.len();

    if let Some(mime) = image_preview_mime(&path) {
        if byte_length > MAX_IMAGE_PREVIEW_BYTES {
            return Err(format!(
                "Image is too large to preview ({} bytes; max {MAX_IMAGE_PREVIEW_BYTES})",
                byte_length
            ));
        }
        let bytes = fs::read(&path).map_err(|error| format!("read image: {error}"))?;
        return Ok(ProjectFilePreview {
            relative_path: relative.replace('\\', "/"),
            contents: None,
            data_url: Some(format!(
                "data:{mime};base64,{}",
                base64::engine::general_purpose::STANDARD.encode(bytes)
            )),
            byte_length,
            truncated: false,
        });
    }

    let mut bytes = Vec::with_capacity((byte_length.min(MAX_FILE_PREVIEW_BYTES) + 1) as usize);
    fs::File::open(&path)
        .map_err(|error| format!("open file: {error}"))?
        .take(MAX_FILE_PREVIEW_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| format!("read file: {error}"))?;
    let truncated = bytes.len() as u64 > MAX_FILE_PREVIEW_BYTES;
    if truncated {
        bytes.truncate(MAX_FILE_PREVIEW_BYTES as usize);
    }
    if bytes.contains(&0) {
        return Err("Binary file preview is not supported for this file type".to_string());
    }
    let contents = match String::from_utf8(bytes) {
        Ok(contents) => contents,
        Err(error) if truncated && error.utf8_error().error_len().is_none() => {
            let valid_up_to = error.utf8_error().valid_up_to();
            let mut bytes = error.into_bytes();
            bytes.truncate(valid_up_to);
            String::from_utf8(bytes).map_err(|_| {
                "Binary file preview is not supported for this file type".to_string()
            })?
        }
        Err(_) => return Err("Binary file preview is not supported for this file type".to_string()),
    };
    Ok(ProjectFilePreview {
        relative_path: relative.replace('\\', "/"),
        contents: Some(contents),
        data_url: None,
        byte_length,
        truncated,
    })
}

fn list_project_entries(root: &Path) -> Result<Vec<ProjectSearchEntry>, String> {
    let mut entries = Vec::new();
    walk_search_entries(root, root, 0, &mut entries)?;
    Ok(entries)
}

fn search_project_entries(
    root: &Path,
    query: &str,
    limit: usize,
) -> Result<Vec<ProjectSearchEntry>, String> {
    let entries = list_project_entries(root)?;

    let needle = query.trim().replace('\\', "/").to_ascii_lowercase();
    let mut scored: Vec<(i32, ProjectSearchEntry)> = entries
        .into_iter()
        .filter_map(|entry| score_search_entry(&entry, &needle).map(|score| (score, entry)))
        .collect();

    scored.sort_by(|a, b| {
        b.0.cmp(&a.0)
            .then_with(|| a.1.path.len().cmp(&b.1.path.len()))
            .then_with(|| a.1.path.cmp(&b.1.path))
    });

    Ok(scored.into_iter().take(limit).map(|(_, e)| e).collect())
}

fn walk_search_entries(
    root: &Path,
    dir: &Path,
    depth: usize,
    out: &mut Vec<ProjectSearchEntry>,
) -> Result<(), String> {
    if depth > MAX_SEARCH_DEPTH || out.len() >= MAX_SEARCH_SCAN {
        return Ok(());
    }

    let mut entries: Vec<_> = match fs::read_dir(dir) {
        Ok(rd) => rd.filter_map(|e| e.ok()).collect(),
        Err(_) => return Ok(()),
    };
    entries.sort_by_key(|e| {
        let is_dir = e.file_type().map(|t| t.is_dir()).unwrap_or(false);
        (!is_dir, e.file_name().to_string_lossy().to_lowercase())
    });

    for entry in entries {
        if out.len() >= MAX_SEARCH_SCAN {
            break;
        }
        let path = entry.path();
        let Some(canonical) = contained_entry(root, &path) else {
            continue;
        };
        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with('.') {
            let allowed = name == ".gitignore"
                || name == ".env.example"
                || name == ".github"
                || name == ".editorconfig"
                || name == ".cursor"
                || name == "AGENTS.md";
            if !allowed || is_sensitive_name(&name) {
                continue;
            }
        } else if is_sensitive_name(&name) {
            continue;
        }

        let rel = path
            .strip_prefix(root)
            .unwrap_or(&path)
            .to_string_lossy()
            .replace('\\', "/");
        let parent = rel
            .rsplit_once('/')
            .map(|(p, _)| p.to_string())
            .unwrap_or_default();

        if canonical.is_dir() {
            if is_skip_dir(&name) {
                continue;
            }
            out.push(ProjectSearchEntry {
                path: rel.clone(),
                name: name.clone(),
                parent,
                is_dir: true,
            });
            walk_search_entries(root, &canonical, depth + 1, out)?;
        } else {
            // Include binary/media names in autocomplete (user may still @ them).
            if is_sensitive_name(&name) {
                continue;
            }
            out.push(ProjectSearchEntry {
                path: rel,
                name,
                parent,
                is_dir: false,
            });
        }
    }
    Ok(())
}

fn score_search_entry(entry: &ProjectSearchEntry, needle: &str) -> Option<i32> {
    if needle.is_empty() {
        // Bare `@`: prefer shallow + source-ish paths.
        let depth = entry.path.matches('/').count() as i32;
        let mut score = 100 - depth * 8;
        if !entry.is_dir {
            score += 5;
        }
        let lower = entry.path.to_ascii_lowercase();
        if lower.starts_with("src/")
            || lower.starts_with("src-tauri/")
            || lower.starts_with("app/")
            || lower.starts_with("packages/")
        {
            score += 20;
        }
        if matches!(
            entry.name.as_str(),
            "README.md"
                | "readme.md"
                | "package.json"
                | "Cargo.toml"
                | "AGENTS.md"
                | "App.tsx"
                | "main.tsx"
                | "lib.rs"
        ) {
            score += 40;
        }
        return Some(score);
    }

    let path_l = entry.path.to_ascii_lowercase();
    let name_l = entry.name.to_ascii_lowercase();
    let parent_l = entry.parent.to_ascii_lowercase();

    let mut score = if name_l == *needle {
        1_000
    } else if name_l.starts_with(needle) {
        800 - name_l.len() as i32
    } else if name_l.contains(needle) {
        600 - name_l.find(needle).unwrap_or(0) as i32
    } else if path_l.ends_with(needle) || path_l.contains(&format!("/{needle}")) {
        500
    } else if path_l.contains(needle) {
        400 - path_l.find(needle).unwrap_or(0) as i32 / 4
    } else if parent_l.contains(needle) {
        200
    } else if fuzzy_subsequence(&name_l, needle) {
        120
    } else if fuzzy_subsequence(&path_l, needle) {
        80
    } else {
        return None;
    };

    // Prefer files slightly; shorter paths rank higher when tied later.
    if !entry.is_dir {
        score += 3;
    }
    Some(score)
}

fn fuzzy_subsequence(haystack: &str, needle: &str) -> bool {
    if needle.is_empty() {
        return true;
    }
    let mut it = haystack.chars();
    for nc in needle.chars() {
        loop {
            match it.next() {
                Some(hc) if hc == nc => break,
                Some(_) => continue,
                None => return false,
            }
        }
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_path(label: &str) -> PathBuf {
        let id = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        std::env::temp_dir().join(format!("grok-project-{label}-{id}"))
    }

    #[test]
    fn containment_rejects_external_canonical_paths() {
        let root = temp_path("root");
        let outside = temp_path("outside");
        fs::create_dir_all(root.join("src")).unwrap();
        fs::create_dir_all(&outside).unwrap();

        let root = fs::canonicalize(&root).unwrap();
        assert!(contained_entry(&root, &root.join("src")).is_some());
        assert!(contained_entry(&root, &outside).is_none());

        let _ = fs::remove_dir_all(&root);
        let _ = fs::remove_dir_all(&outside);
    }

    #[test]
    fn project_favicon_prefers_known_assets_and_stays_inside_root() {
        let root = temp_path("favicon");
        fs::create_dir_all(root.join("public/brand")).unwrap();
        fs::write(
            root.join("index.html"),
            r#"<link rel="icon" href="/brand/logo.svg">"#,
        )
        .unwrap();
        fs::write(root.join("public/brand/logo.svg"), "<svg />").unwrap();
        let root = fs::canonicalize(&root).unwrap();

        assert_eq!(
            resolve_project_favicon(&root)
                .unwrap()
                .and_then(|path| path.file_name().map(|name| name.to_owned())),
            Some(std::ffi::OsString::from("logo.svg"))
        );
        assert!(safe_project_file(&root, "../outside.svg").is_none());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn project_file_preview_stays_scoped_and_supports_text_and_images() {
        let root = temp_path("file-preview");
        fs::create_dir_all(root.join("src")).unwrap();
        fs::write(root.join("src/App.tsx"), "export const app = true;\n").unwrap();
        fs::write(root.join("logo.png"), [137, 80, 78, 71]).unwrap();
        fs::write(root.join(".env"), "TOKEN=secret").unwrap();
        let root = fs::canonicalize(&root).unwrap();

        let text = read_project_file(&root, "src/App.tsx").unwrap();
        assert_eq!(text.contents.as_deref(), Some("export const app = true;\n"));
        assert_eq!(text.data_url, None);
        assert!(!text.truncated);

        let image = read_project_file(&root, "logo.png").unwrap();
        assert!(image.contents.is_none());
        assert!(image
            .data_url
            .as_deref()
            .is_some_and(|value| value.starts_with("data:image/png;base64,")));

        assert!(read_project_file(&root, "../outside.txt").is_err());
        assert!(read_project_file(&root, ".env").is_err());

        let entries = list_project_entries(&root).unwrap();
        assert!(entries.iter().any(|entry| entry.path == "src/App.tsx"));
        assert!(!entries.iter().any(|entry| entry.path == ".env"));

        let _ = fs::remove_dir_all(&root);
    }

    #[cfg(windows)]
    #[test]
    fn project_entries_keep_relative_paths_for_registered_windows_roots() {
        let root = temp_path("registered-windows-root");
        fs::create_dir_all(root.join("src/nested")).unwrap();
        fs::write(
            root.join("src/nested/App.tsx"),
            "export const app = true;\n",
        )
        .unwrap();
        let registered_root = crate::paths::canonicalize_dir(&root).unwrap();

        let entries = list_project_entries(&registered_root).unwrap();
        assert!(
            entries
                .iter()
                .any(|entry| entry.path == "src/nested/App.tsx"),
            "nested paths were not relative to the registered root: {entries:?}"
        );

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn truncated_project_file_preview_keeps_complete_utf8_characters() {
        let root = temp_path("file-preview-utf8-boundary");
        fs::create_dir_all(&root).unwrap();
        let mut contents = vec![b'a'; MAX_FILE_PREVIEW_BYTES as usize - 1];
        contents.extend_from_slice("é".as_bytes());
        fs::write(root.join("large.txt"), contents).unwrap();
        let root = fs::canonicalize(&root).unwrap();

        let preview = read_project_file(&root, "large.txt").unwrap();
        let preview_contents = preview.contents.unwrap();
        assert!(preview.truncated);
        assert_eq!(preview_contents.len(), MAX_FILE_PREVIEW_BYTES as usize - 1);
        assert!(preview_contents.bytes().all(|byte| byte == b'a'));

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn project_file_preview_rejects_binary_nul_bytes() {
        let root = temp_path("file-preview-binary");
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join("asset.bin"), [b'a', 0, b'b']).unwrap();
        let root = fs::canonicalize(&root).unwrap();

        let error = read_project_file(&root, "asset.bin").unwrap_err();
        assert_eq!(
            error,
            "Binary file preview is not supported for this file type"
        );

        let _ = fs::remove_dir_all(&root);
    }

    #[cfg(unix)]
    #[test]
    fn project_walk_skips_external_directory_symlinks() {
        use std::os::unix::fs::symlink;

        let root = temp_path("symlink-root");
        let outside = temp_path("symlink-outside");
        fs::create_dir_all(root.join("src")).unwrap();
        fs::create_dir_all(&outside).unwrap();
        fs::write(outside.join("secret.rs"), "external secret").unwrap();
        symlink(&outside, root.join("src").join("linked")).unwrap();
        symlink(outside.join("secret.rs"), root.join("src").join("App.tsx")).unwrap();

        let root = fs::canonicalize(&root).unwrap();
        let context = build_project_context(&root).unwrap();
        let search = search_project_entries(&root, "secret", 20).unwrap();
        assert!(!context.tree.contains("linked"));
        assert!(!context
            .files
            .iter()
            .any(|file| file.content.contains("external secret")));
        assert!(search.is_empty());

        let _ = fs::remove_dir_all(&root);
        let _ = fs::remove_dir_all(&outside);
    }

    #[cfg(windows)]
    #[test]
    fn project_walk_skips_external_directory_junctions() {
        let root = temp_path("junction-root");
        let outside = temp_path("junction-outside");
        let link = root.join("src").join("linked");
        fs::create_dir_all(root.join("src")).unwrap();
        fs::create_dir_all(&outside).unwrap();
        fs::write(outside.join("secret.rs"), "external secret").unwrap();
        let link_arg = link.to_string_lossy().to_string();
        let outside_arg = outside.to_string_lossy().to_string();
        let status = std::process::Command::new("cmd")
            .args(["/C", "mklink", "/J"])
            .arg(&link_arg)
            .arg(&outside_arg)
            .status()
            .unwrap();
        assert!(status.success());

        let root_canonical = fs::canonicalize(&root).unwrap();
        let context = build_project_context(&root_canonical).unwrap();
        let search = search_project_entries(&root_canonical, "secret", 20).unwrap();
        assert!(!context.tree.contains("linked"));
        assert!(!context
            .files
            .iter()
            .any(|file| file.content.contains("external secret")));
        assert!(search.is_empty());

        let _ = fs::remove_dir(&link);
        let _ = fs::remove_dir_all(&root);
        let _ = fs::remove_dir_all(&outside);
    }
}
