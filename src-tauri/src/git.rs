//! Local git status / diff / commit / push for project folders.
//! Keeps repository operations small, local, and bounded to registered projects.
//! Also: per-thread worktrees + open-PR via the GitHub CLI.

use crate::paths::{
    is_path_within_root, path_compare_key, register_dir, require_registered_root,
    strip_verbatim_prefix, unregister_dir,
};
use serde::Serialize;
use std::collections::{BTreeMap, BTreeSet};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::mpsc;
use std::thread;
use std::time::{Duration, Instant};
use tauri::AppHandle;

#[cfg(unix)]
use std::os::unix::process::CommandExt;

const DEFAULT_TIMEOUT_MS: u64 = 30_000;
const COMMIT_TIMEOUT_MS: u64 = 120_000;
const PUSH_TIMEOUT_MS: u64 = 180_000;
const WORKTREE_TIMEOUT_MS: u64 = 120_000;
const PR_TIMEOUT_MS: u64 = 120_000;
const MAX_DIFF_CHARS: usize = 400_000;
const MAX_PATCH_PER_FILE: usize = 120_000;
const MAX_STATUS_FILES: usize = 2_000;
const MAX_COMMIT_MESSAGE_CHARS: usize = 10_000;
const MAX_THREAD_ID_CHARS: usize = 64;
const MAX_GIT_REF_CHARS: usize = 512;
const MAX_PROCESS_OUTPUT_BYTES: usize = 4_000_000;
const PIPE_DRAIN_GRACE_MS: u64 = 1_000;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitFileStat {
    pub path: String,
    pub status: String,
    pub insertions: u32,
    pub deletions: u32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitWorkingTree {
    pub files: Vec<GitFileStat>,
    pub insertions: u32,
    pub deletions: u32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitStatus {
    pub is_repo: bool,
    pub root: Option<String>,
    pub branch: Option<String>,
    pub upstream: Option<String>,
    pub is_default_branch: bool,
    pub has_primary_remote: bool,
    pub has_upstream: bool,
    pub ahead_count: u32,
    pub behind_count: u32,
    pub has_working_tree_changes: bool,
    pub working_tree: GitWorkingTree,
    pub detached: bool,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitFileDiff {
    pub path: String,
    pub status: String,
    pub insertions: u32,
    pub deletions: u32,
    pub patch: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitDiffResult {
    pub is_repo: bool,
    pub root: Option<String>,
    pub branch: Option<String>,
    pub files: Vec<GitFileDiff>,
    pub insertions: u32,
    pub deletions: u32,
    pub truncated: bool,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitCommitResult {
    pub committed: bool,
    pub commit_sha: Option<String>,
    pub subject: Option<String>,
    pub skipped_no_changes: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitPushResult {
    pub pushed: bool,
    pub branch: Option<String>,
    pub upstream: Option<String>,
    pub set_upstream: bool,
    pub detail: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitWorktreeResult {
    pub path: String,
    pub branch: String,
    pub warning: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitRef {
    pub name: String,
    pub short_name: String,
    pub kind: String,
    pub current: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitPrResult {
    pub url: String,
    pub created: bool,
}

fn empty_working_tree() -> GitWorkingTree {
    GitWorkingTree {
        files: Vec::new(),
        insertions: 0,
        deletions: 0,
    }
}

fn non_repo_status(error: Option<String>) -> GitStatus {
    GitStatus {
        is_repo: false,
        root: None,
        branch: None,
        upstream: None,
        is_default_branch: false,
        has_primary_remote: false,
        has_upstream: false,
        ahead_count: 0,
        behind_count: 0,
        has_working_tree_changes: false,
        working_tree: empty_working_tree(),
        detached: false,
        error,
    }
}

fn display_path(path: &Path) -> String {
    strip_verbatim_prefix(path.to_path_buf())
        .to_string_lossy()
        .replace('\\', "/")
}

#[derive(Debug)]
struct GitRun {
    exit_code: i32,
    stdout: String,
    stderr: String,
}

fn run_git(cwd: &Path, args: &[&str], timeout_ms: u64) -> Result<GitRun, String> {
    // A repository-configured fsmonitor hook must not turn status/diff into code execution.
    let mut safe_args = Vec::with_capacity(args.len() + 2);
    safe_args.extend(["-c", "core.fsmonitor=false"]);
    safe_args.extend_from_slice(args);
    run_process("git", &safe_args, cwd, timeout_ms)
}

fn is_not_repo_stderr(stderr: &str) -> bool {
    let lower = stderr.to_ascii_lowercase();
    lower.contains("not a git repository")
        || lower.contains("not a git repo")
        || lower.contains("outside repository")
}

fn parse_branch_ab(value: &str) -> (u32, u32) {
    // "+2 -1"
    let mut ahead = 0u32;
    let mut behind = 0u32;
    for part in value.split_whitespace() {
        if let Some(rest) = part.strip_prefix('+') {
            ahead = rest.parse().unwrap_or(0);
        } else if let Some(rest) = part.strip_prefix('-') {
            behind = rest.parse().unwrap_or(0);
        }
    }
    (ahead, behind)
}

fn parse_numstat(stdout: &str) -> BTreeMap<String, (u32, u32)> {
    let mut map = BTreeMap::new();
    let mut records = stdout.split('\0');
    while let Some(record) = records.next() {
        let record = record.trim_end_matches('\r');
        if record.is_empty() {
            continue;
        }
        let mut parts = record.splitn(3, '\t');
        let add_raw = parts.next().unwrap_or("0");
        let del_raw = parts.next().unwrap_or("0");
        let path_raw = parts.next().unwrap_or("");
        let path = if path_raw.is_empty() {
            let _source = records.next().unwrap_or("");
            records.next().unwrap_or("")
        } else {
            path_raw
        };
        if path.is_empty() {
            continue;
        }
        let insertions: u32 = if add_raw == "-" {
            0
        } else {
            add_raw.parse().unwrap_or(0)
        };
        let deletions: u32 = if del_raw == "-" {
            0
        } else {
            del_raw.parse().unwrap_or(0)
        };
        let entry = map.entry(path.to_string()).or_insert((0u32, 0u32));
        entry.0 = entry.0.saturating_add(insertions);
        entry.1 = entry.1.saturating_add(deletions);
    }
    map
}

fn classify_porcelain_xy(xy: &str) -> &'static str {
    let chars: Vec<char> = xy.chars().collect();
    let x = chars.first().copied().unwrap_or(' ');
    let y = chars.get(1).copied().unwrap_or(' ');
    if x == 'A' || y == 'A' {
        return "added";
    }
    if x == 'D' && y == 'D' {
        return "deleted";
    }
    if x == 'D' || y == 'D' {
        return "deleted";
    }
    if x == '?' || y == '?' {
        return "added";
    }
    if x == 'R' || y == 'R' || x == 'C' || y == 'C' {
        return "modified";
    }
    "modified"
}

/// Parse porcelain v2 path from a non-header status line.
fn parse_porcelain_v2_entry(line: &str) -> Option<(String, &'static str)> {
    let line = line.trim_end_matches('\r');
    if line.is_empty() || line.starts_with('#') {
        return None;
    }
    if let Some(rest) = line.strip_prefix("? ") {
        let path = rest.to_string();
        if path.is_empty() {
            return None;
        }
        return Some((path, "added"));
    }
    if let Some(rest) = line.strip_prefix("! ") {
        let path = rest.to_string();
        if path.is_empty() {
            return None;
        }
        return Some((path, "modified"));
    }
    // 1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>
    // 2 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <X><score> <path>\t<path2>
    // u <XY> <sub> <m1> <m2> <m3> <mW> <h1> <h2> <h3> <path>
    if !(line.starts_with("1 ") || line.starts_with("2 ") || line.starts_with("u ")) {
        return None;
    }
    let kind = &line[..1];
    let rest = &line[2..];
    let xy = rest.get(..2).unwrap_or("  ");
    let status = classify_porcelain_xy(xy);

    let fixed_fields = match kind {
        "1" => 7,
        "2" => 8,
        "u" => 9,
        _ => return None,
    };
    let path = rest
        .splitn(fixed_fields + 1, ' ')
        .nth(fixed_fields)?
        .to_string();
    if path.is_empty() {
        None
    } else {
        Some((path, status))
    }
}

fn resolve_project_root(app: &AppHandle, path: &str) -> Result<PathBuf, String> {
    require_registered_root(app, path)
}

fn discover_git_root(cwd: &Path) -> Result<Option<PathBuf>, String> {
    let run = run_git(cwd, &["rev-parse", "--show-toplevel"], DEFAULT_TIMEOUT_MS)?;
    if run.exit_code != 0 {
        if is_not_repo_stderr(&run.stderr) {
            return Ok(None);
        }
        return Err(run.stderr.trim().to_string());
    }
    let raw = run.stdout.trim();
    if raw.is_empty() {
        return Ok(None);
    }
    let p = strip_verbatim_prefix(PathBuf::from(raw));
    Ok(Some(p))
}

fn ensure_repo_under_project(project: &Path, git_root: &Path) -> Result<(), String> {
    // Allow project == repo root, or project nested inside repo, or repo nested inside project.
    let project_k = path_compare_key(project);
    let git_k = path_compare_key(git_root);
    if project_k == git_k {
        return Ok(());
    }
    let project_prefix = if project_k.ends_with('/') {
        project_k.clone()
    } else {
        format!("{project_k}/")
    };
    let git_prefix = if git_k.ends_with('/') {
        git_k.clone()
    } else {
        format!("{git_k}/")
    };
    if git_k.starts_with(&project_prefix) || project_k.starts_with(&git_prefix) {
        return Ok(());
    }
    Err("Git repository is outside the registered project folder".into())
}

fn project_output_prefix(cwd: &Path) -> Result<Option<String>, String> {
    let root = discover_git_root(cwd)?.ok_or_else(|| "Not a git repository".to_string())?;
    let root = strip_verbatim_prefix(
        std::fs::canonicalize(&root)
            .map_err(|e| format!("resolve repository root {}: {e}", root.display()))?,
    );
    let project = strip_verbatim_prefix(
        std::fs::canonicalize(cwd)
            .map_err(|e| format!("resolve project path {}: {e}", cwd.display()))?,
    );
    if path_compare_key(&project) == path_compare_key(&root) {
        return Ok(None);
    }
    let relative = project
        .strip_prefix(&root)
        .map_err(|_| "Registered project is not nested under the Git repository root".to_string())?
        .to_string_lossy()
        .replace('\\', "/");
    Ok(Some(format!("{}/", relative.trim_end_matches('/'))))
}

fn normalize_project_output_path(path: &str, prefix: Option<&str>) -> String {
    let path = path.replace('\\', "/");
    prefix
        .and_then(|prefix| path.strip_prefix(prefix))
        .unwrap_or(&path)
        .to_string()
}

fn remote_exists(cwd: &Path, name: &str) -> bool {
    run_git(cwd, &["remote", "get-url", name], DEFAULT_TIMEOUT_MS)
        .map(|r| r.exit_code == 0 && !r.stdout.trim().is_empty())
        .unwrap_or(false)
}

fn default_branch_name(cwd: &Path) -> Option<String> {
    if let Ok(run) = run_git(
        cwd,
        &["symbolic-ref", "refs/remotes/origin/HEAD"],
        DEFAULT_TIMEOUT_MS,
    ) {
        if run.exit_code == 0 {
            let v = run.stdout.trim().trim_start_matches("refs/remotes/origin/");
            if !v.is_empty() {
                return Some(v.to_string());
            }
        }
    }
    for candidate in ["main", "master"] {
        if let Ok(run) = run_git(
            cwd,
            &[
                "show-ref",
                "--verify",
                "--quiet",
                &format!("refs/heads/{candidate}"),
            ],
            DEFAULT_TIMEOUT_MS,
        ) {
            if run.exit_code == 0 {
                return Some(candidate.to_string());
            }
        }
    }
    None
}

fn empty_tree_oid(cwd: &Path) -> Result<String, String> {
    let run = run_git(cwd, &["mktree"], DEFAULT_TIMEOUT_MS)?;
    if run.exit_code != 0 {
        return Err(format!("git mktree failed: {}", run.stderr.trim()));
    }
    let oid = run.stdout.trim();
    if oid.is_empty() {
        Err("git mktree returned an empty object id".into())
    } else {
        Ok(oid.to_string())
    }
}

fn collect_numstat(cwd: &Path) -> Result<BTreeMap<String, (u32, u32)>, String> {
    let prefix = project_output_prefix(cwd)?;
    let relative_arg = if prefix.is_some() {
        "--relative=."
    } else {
        "--relative"
    };
    let head = run_git(
        cwd,
        &["diff", "HEAD", "--numstat", "-z", relative_arg, "--", "."],
        DEFAULT_TIMEOUT_MS,
    )?;
    if head.exit_code == 0 {
        return Ok(parse_numstat(&head.stdout)
            .into_iter()
            .map(|(path, stats)| {
                (
                    normalize_project_output_path(&path, prefix.as_deref()),
                    stats,
                )
            })
            .collect());
    }
    // Unborn HEAD: compare the current index + worktree directly with the empty tree.
    let empty = empty_tree_oid(cwd)?;
    let run = run_git(
        cwd,
        &["diff", &empty, "--numstat", "-z", relative_arg, "--", "."],
        DEFAULT_TIMEOUT_MS,
    )?;
    if run.exit_code != 0 {
        return Err(run.stderr.trim().to_string());
    }
    Ok(parse_numstat(&run.stdout)
        .into_iter()
        .map(|(path, stats)| {
            (
                normalize_project_output_path(&path, prefix.as_deref()),
                stats,
            )
        })
        .collect())
}

fn build_status(cwd: &Path) -> Result<GitStatus, String> {
    let prefix = project_output_prefix(cwd)?;
    let status_run = run_git(
        cwd,
        &[
            "-c",
            "status.relativePaths=true",
            "status",
            "--porcelain=2",
            "--branch",
            "-z",
            "--untracked-files=all",
            "--",
            ".",
        ],
        DEFAULT_TIMEOUT_MS,
    )?;
    if status_run.exit_code != 0 {
        if is_not_repo_stderr(&status_run.stderr) {
            return Ok(non_repo_status(None));
        }
        return Err(format!("git status failed: {}", status_run.stderr.trim()));
    }

    let mut branch: Option<String> = None;
    let mut upstream: Option<String> = None;
    let mut ahead = 0u32;
    let mut behind = 0u32;
    let mut detached = false;
    let mut path_status: BTreeMap<String, &'static str> = BTreeMap::new();

    for line in status_run.stdout.split('\0') {
        let line = line.trim_end_matches('\r');
        if let Some(rest) = line.strip_prefix("# branch.head ") {
            let v = rest.trim();
            if v.starts_with('(') {
                detached = true;
                branch = None;
            } else if !v.is_empty() {
                branch = Some(v.to_string());
            }
            continue;
        }
        if let Some(rest) = line.strip_prefix("# branch.upstream ") {
            let v = rest.trim();
            if !v.is_empty() {
                upstream = Some(v.to_string());
            }
            continue;
        }
        if let Some(rest) = line.strip_prefix("# branch.ab ") {
            let (a, b) = parse_branch_ab(rest.trim());
            ahead = a;
            behind = b;
            continue;
        }
        if let Some((path, st)) = parse_porcelain_v2_entry(line) {
            if path_status.len() < MAX_STATUS_FILES {
                path_status.insert(normalize_project_output_path(&path, prefix.as_deref()), st);
            }
        }
    }

    let numstat = collect_numstat(cwd).unwrap_or_default();
    let mut files: Vec<GitFileStat> = Vec::new();
    let mut insertions = 0u32;
    let mut deletions = 0u32;
    let mut seen: BTreeSet<String> = BTreeSet::new();

    for (path, (ins, del)) in &numstat {
        seen.insert(path.clone());
        insertions = insertions.saturating_add(*ins);
        deletions = deletions.saturating_add(*del);
        let st = path_status
            .get(path)
            .copied()
            .unwrap_or(if *del == 0 && *ins > 0 {
                "added"
            } else if *ins == 0 && *del > 0 {
                "deleted"
            } else {
                "modified"
            });
        files.push(GitFileStat {
            path: path.clone(),
            status: st.into(),
            insertions: *ins,
            deletions: *del,
        });
    }
    for (path, st) in &path_status {
        if seen.contains(path) {
            continue;
        }
        files.push(GitFileStat {
            path: path.clone(),
            status: (*st).into(),
            insertions: 0,
            deletions: 0,
        });
    }
    files.sort_by(|a, b| a.path.cmp(&b.path));

    let has_primary_remote = remote_exists(cwd, "origin")
        || run_git(cwd, &["remote"], DEFAULT_TIMEOUT_MS)
            .map(|r| r.exit_code == 0 && r.stdout.lines().any(|l| !l.trim().is_empty()))
            .unwrap_or(false);

    let default_branch = default_branch_name(cwd);
    let is_default_branch = match (&branch, &default_branch) {
        (Some(b), Some(d)) => b == d,
        (Some(b), None) => b == "main" || b == "master",
        _ => false,
    };

    // Without upstream, porcelain omits branch.ab — approximate ahead vs origin/default
    // so Push stays available after the first local commit.
    if upstream.is_none() {
        if let Some(b) = branch.as_deref() {
            if let Some(count) = ahead_without_upstream(cwd, b, default_branch.as_deref()) {
                ahead = count;
                behind = 0;
            }
        }
    }

    Ok(GitStatus {
        is_repo: true,
        root: Some(display_path(cwd)),
        branch,
        upstream: upstream.clone(),
        is_default_branch,
        has_primary_remote,
        has_upstream: upstream.is_some(),
        ahead_count: ahead,
        behind_count: behind,
        has_working_tree_changes: !files.is_empty(),
        working_tree: GitWorkingTree {
            files,
            insertions,
            deletions,
        },
        detached,
        error: None,
    })
}

fn ahead_without_upstream(cwd: &Path, branch: &str, default_branch: Option<&str>) -> Option<u32> {
    let candidates: Vec<String> = [
        default_branch.map(|d| format!("origin/{d}")),
        default_branch.map(|d| d.to_string()),
        Some("origin/main".into()),
        Some("origin/master".into()),
        Some("main".into()),
        Some("master".into()),
    ]
    .into_iter()
    .flatten()
    .filter(|c| c != branch)
    .collect();

    for base in candidates {
        let rev = format!("{base}...HEAD");
        if let Ok(run) = run_git(cwd, &["rev-list", "--count", &rev], DEFAULT_TIMEOUT_MS) {
            if run.exit_code == 0 {
                if let Ok(n) = run.stdout.trim().parse::<u32>() {
                    return Some(n);
                }
            }
        }
    }
    // Brand-new branch with only local commits and no merge-base: count commits on HEAD.
    if let Ok(run) = run_git(cwd, &["rev-list", "--count", "HEAD"], DEFAULT_TIMEOUT_MS) {
        if run.exit_code == 0 {
            if let Ok(n) = run.stdout.trim().parse::<u32>() {
                return Some(n.max(1));
            }
        }
    }
    Some(1)
}

fn decode_git_quoted_path(raw: &str) -> Option<String> {
    let bytes = raw.as_bytes();
    if bytes.first().copied()? != b'"' {
        return Some(raw.to_string());
    }
    let mut out = Vec::new();
    let mut i = 1;
    while i < bytes.len() {
        match bytes[i] {
            b'"' => return Some(String::from_utf8_lossy(&out).into_owned()),
            b'\\' => {
                i += 1;
                if i >= bytes.len() {
                    return None;
                }
                if i + 2 < bytes.len()
                    && bytes[i].is_ascii_digit()
                    && bytes[i] <= b'7'
                    && bytes[i + 1].is_ascii_digit()
                    && bytes[i + 1] <= b'7'
                    && bytes[i + 2].is_ascii_digit()
                    && bytes[i + 2] <= b'7'
                {
                    let value =
                        (bytes[i] - b'0') * 64 + (bytes[i + 1] - b'0') * 8 + (bytes[i + 2] - b'0');
                    out.push(value);
                    i += 3;
                    continue;
                }
                out.push(match bytes[i] {
                    b'a' => 0x07,
                    b'b' => 0x08,
                    b't' => b'\t',
                    b'n' => b'\n',
                    b'v' => 0x0b,
                    b'f' => 0x0c,
                    b'r' => b'\r',
                    escaped => escaped,
                });
                i += 1;
            }
            byte => {
                out.push(byte);
                i += 1;
            }
        }
    }
    None
}

fn normalize_diff_path(raw: &str) -> String {
    let decoded = decode_git_quoted_path(raw.trim()).unwrap_or_else(|| raw.trim().to_string());
    decoded
        .strip_prefix("a/")
        .or_else(|| decoded.strip_prefix("b/"))
        .unwrap_or(&decoded)
        .to_string()
}

fn git_quoted_token_len(raw: &str) -> Option<usize> {
    let bytes = raw.as_bytes();
    if bytes.first().copied()? != b'"' {
        return None;
    }
    let mut i = 1;
    while i < bytes.len() {
        match bytes[i] {
            b'"' => return Some(i + 1),
            b'\\' => {
                i += 1;
                if i >= bytes.len() {
                    return None;
                }
                if i + 2 < bytes.len()
                    && matches!(bytes[i], b'0'..=b'7')
                    && matches!(bytes[i + 1], b'0'..=b'7')
                    && matches!(bytes[i + 2], b'0'..=b'7')
                {
                    i += 3;
                } else {
                    i += 1;
                }
            }
            _ => i += 1,
        }
    }
    None
}

fn diff_header_destination(rest: &str) -> String {
    if rest.starts_with('"') {
        let Some(first_end) = git_quoted_token_len(rest) else {
            return normalize_diff_path(rest);
        };
        let second = rest[first_end..].trim_start();
        return normalize_diff_path(second);
    }
    rest.rsplit_once(" b/")
        .map(|(_, path)| path.to_string())
        .unwrap_or_else(|| rest.to_string())
}

fn split_unified_diff_by_file(diff: &str) -> Vec<(String, String)> {
    let mut out: Vec<(String, String)> = Vec::new();
    let mut current_path: Option<String> = None;
    let mut current_body = String::new();

    for line in diff.split_inclusive('\n') {
        let trimmed = line.trim_end_matches(['\r', '\n']);
        if let Some(rest) = trimmed.strip_prefix("diff --git ") {
            if let Some(path) = current_path.take() {
                out.push((path, std::mem::take(&mut current_body)));
            }
            current_path = Some(normalize_diff_path(&diff_header_destination(rest)));
            current_body.push_str(line);
            continue;
        }
        if let Some(rest) = trimmed.strip_prefix("--- ") {
            if rest != "/dev/null" {
                current_path = Some(normalize_diff_path(rest));
            }
        }
        if let Some(rest) = trimmed.strip_prefix("+++ ") {
            if rest != "/dev/null" {
                current_path = Some(normalize_diff_path(rest));
            }
        }
        if current_path.is_none() {
            // orphan body without header — skip until we see a header
            continue;
        }
        current_body.push_str(line);
    }
    if let Some(path) = current_path {
        out.push((path, current_body));
    }
    out
}

fn count_patch_stats(patch: &str) -> (u32, u32) {
    let mut add = 0u32;
    let mut del = 0u32;
    for line in patch.split('\n') {
        if line.starts_with('+') && !line.starts_with("+++") {
            add = add.saturating_add(1);
        } else if line.starts_with('-') && !line.starts_with("---") {
            del = del.saturating_add(1);
        }
    }
    (add, del)
}

fn truncate_chars(s: &str, max: usize) -> (String, bool) {
    if s.chars().count() <= max {
        return (s.to_string(), false);
    }
    let mut out = String::new();
    for (i, ch) in s.chars().enumerate() {
        if i >= max {
            break;
        }
        out.push(ch);
    }
    out.push_str("\n… (diff truncated)");
    (out, true)
}

fn build_diff(cwd: &Path) -> Result<GitDiffResult, String> {
    let prefix = project_output_prefix(cwd)?;
    let relative_arg = if prefix.is_some() {
        "--relative=."
    } else {
        "--relative"
    };
    let status = build_status(cwd)?;
    if !status.is_repo {
        return Ok(GitDiffResult {
            is_repo: false,
            root: None,
            branch: None,
            files: Vec::new(),
            insertions: 0,
            deletions: 0,
            truncated: false,
            error: status.error,
        });
    }

    let mut patches: BTreeMap<String, String> = BTreeMap::new();
    let mut truncated = false;

    // Tracked changes (staged + unstaged) vs HEAD when possible.
    let tracked = run_git(
        cwd,
        &[
            "diff",
            "HEAD",
            "--no-ext-diff",
            "--no-textconv",
            "--no-color",
            "--find-renames",
            relative_arg,
            "--",
            ".",
        ],
        DEFAULT_TIMEOUT_MS,
    );
    let tracked_ok = match tracked {
        Ok(run) if run.exit_code == 0 => {
            let (body, t) = truncate_chars(&run.stdout, MAX_DIFF_CHARS);
            truncated |= t;
            for (path, patch) in split_unified_diff_by_file(&body) {
                if path.is_empty() {
                    continue;
                }
                patches.insert(
                    normalize_project_output_path(&path, prefix.as_deref()),
                    patch,
                );
            }
            true
        }
        Ok(run) if is_not_repo_stderr(&run.stderr) => {
            return Ok(GitDiffResult {
                is_repo: false,
                root: None,
                branch: None,
                files: Vec::new(),
                insertions: 0,
                deletions: 0,
                truncated: false,
                error: None,
            });
        }
        Ok(_) => {
            // Unborn HEAD fallback: compare the current index + worktree once
            // against the empty tree, avoiding staged/unstaged double counting.
            if let Ok(empty) = empty_tree_oid(cwd) {
                if let Ok(run) = run_git(
                    cwd,
                    &[
                        "diff",
                        &empty,
                        "--no-ext-diff",
                        "--no-textconv",
                        "--no-color",
                        "--find-renames",
                        relative_arg,
                        "--",
                        ".",
                    ],
                    DEFAULT_TIMEOUT_MS,
                ) {
                    if run.exit_code == 0 {
                        let (body, t) = truncate_chars(&run.stdout, MAX_DIFF_CHARS);
                        truncated |= t;
                        for (path, patch) in split_unified_diff_by_file(&body) {
                            patches.insert(
                                normalize_project_output_path(&path, prefix.as_deref()),
                                patch,
                            );
                        }
                    }
                }
            }
            true
        }
        Err(e) => return Err(e),
    };
    let _ = tracked_ok;

    // Include untracked files as full-add patches for review completeness.
    for f in &status.working_tree.files {
        if f.status != "added" || patches.contains_key(&f.path) {
            continue;
        }
        // Only pure untracked: try show as /dev/null diff via git diff --no-index
        let file_path = cwd.join(&f.path);
        if !file_path.is_file() {
            // directory untracked: skip content (path still listed via status)
            patches.entry(f.path.clone()).or_insert_with(|| {
                format!(
                    "diff --git a/{} b/{}\nnew file mode 100644\n--- /dev/null\n+++ b/{}\n",
                    f.path, f.path, f.path
                )
            });
            continue;
        }
        let meta = std::fs::metadata(&file_path).ok();
        if meta.as_ref().map(|m| m.len() > 512_000).unwrap_or(true) {
            patches.entry(f.path.clone()).or_insert_with(|| {
                format!(
                    "diff --git a/{} b/{}\nnew file mode 100644\n--- /dev/null\n+++ b/{}\n@@ -0,0 +1 @@\n+… (file too large to preview)\n",
                    f.path, f.path, f.path
                )
            });
            continue;
        }
        // Prefer a manual add preview (portable on Windows; avoids /dev/null quirks).
        if let Ok(content) = std::fs::read_to_string(&file_path) {
            let mut patch = format!(
                "diff --git a/{} b/{}\nnew file mode 100644\n--- /dev/null\n+++ b/{}\n",
                f.path, f.path, f.path
            );
            let lines: Vec<&str> = content.split('\n').collect();
            let limit = 400.min(lines.len());
            patch.push_str(&format!("@@ -0,0 +1,{} @@\n", limit));
            for line in lines.iter().take(limit) {
                patch.push('+');
                patch.push_str(line);
                patch.push('\n');
            }
            if lines.len() > limit {
                patch.push_str(&format!("… {} more lines\n", lines.len() - limit));
                truncated = true;
            }
            patches.insert(f.path.clone(), patch);
        }
    }

    // Ensure every status file appears even without patch body.
    for f in &status.working_tree.files {
        patches.entry(f.path.clone()).or_default();
    }

    let status_map: BTreeMap<_, _> = status
        .working_tree
        .files
        .iter()
        .map(|f| (f.path.clone(), f.clone()))
        .collect();

    let mut files: Vec<GitFileDiff> = Vec::new();
    let mut insertions = 0u32;
    let mut deletions = 0u32;

    for (path, patch) in patches {
        let (ins_p, del_p) = count_patch_stats(&patch);
        let st = status_map.get(&path);
        let insertions_f = st.map(|s| s.insertions).filter(|n| *n > 0).unwrap_or(ins_p);
        let deletions_f = st.map(|s| s.deletions).filter(|n| *n > 0).unwrap_or(del_p);
        let status_s = st.map(|s| s.status.clone()).unwrap_or_else(|| {
            if deletions_f == 0 && insertions_f > 0 {
                "added".into()
            } else if insertions_f == 0 && deletions_f > 0 {
                "deleted".into()
            } else {
                "modified".into()
            }
        });
        insertions = insertions.saturating_add(insertions_f);
        deletions = deletions.saturating_add(deletions_f);
        let (patch_out, t) = truncate_chars(&patch, MAX_PATCH_PER_FILE);
        truncated |= t;
        files.push(GitFileDiff {
            path,
            status: status_s,
            insertions: insertions_f,
            deletions: deletions_f,
            patch: patch_out,
        });
    }
    files.sort_by(|a, b| a.path.cmp(&b.path));

    Ok(GitDiffResult {
        is_repo: true,
        root: status.root,
        branch: status.branch,
        files,
        insertions,
        deletions,
        truncated,
        error: None,
    })
}

fn sanitize_commit_message(raw: &str) -> Result<String, String> {
    let msg = raw.replace("\r\n", "\n").trim().to_string();
    if msg.is_empty() {
        return Err("Commit message is empty".into());
    }
    if msg.chars().count() > MAX_COMMIT_MESSAGE_CHARS {
        return Err(format!(
            "Commit message too long (max {MAX_COMMIT_MESSAGE_CHARS} chars)"
        ));
    }
    // Block option-injection via message starting with -
    if msg.lines().next().unwrap_or("").starts_with('-') {
        return Err("Commit message must not start with '-'".into());
    }
    Ok(msg)
}

fn validate_pathspecs(paths: &[String]) -> Result<Vec<String>, String> {
    let mut out = Vec::new();
    for p in paths {
        let n = p
            .replace('\\', "/")
            .trim()
            .trim_start_matches("./")
            .to_string();
        if n.is_empty() {
            continue;
        }
        // Reject absolute paths, drive-letter forms (C:), and git pathspec
        // magic such as ":(exclude)…" / ":!…" which could silently change what
        // gets staged.
        if n.starts_with('/') || n.starts_with(':') {
            return Err(format!("Absolute or magic pathspecs are not allowed: {p}"));
        }
        if n.contains(':') && n.chars().nth(1) == Some(':') {
            return Err(format!("Absolute pathspecs are not allowed: {p}"));
        }
        if n.split('/').any(|seg| seg == "..") {
            return Err(format!("Pathspec must stay inside the repo: {p}"));
        }
        out.push(n);
    }
    Ok(out)
}

fn do_commit(cwd: &Path, message: &str, paths: &[String]) -> Result<GitCommitResult, String> {
    let msg = sanitize_commit_message(message)?;
    let pathspecs = validate_pathspecs(paths)?;

    // Stage
    if pathspecs.is_empty() {
        let add = run_git(cwd, &["add", "-A", "--", "."], COMMIT_TIMEOUT_MS)?;
        if add.exit_code != 0 {
            return Err(format!("git add failed: {}", add.stderr.trim()));
        }
    } else {
        let mut args = vec!["add".to_string(), "-A".to_string(), "--".to_string()];
        args.extend(pathspecs.iter().cloned());
        let arg_refs: Vec<&str> = args.iter().map(|s| s.as_str()).collect();
        let add = run_git(cwd, &arg_refs, COMMIT_TIMEOUT_MS)?;
        if add.exit_code != 0 {
            return Err(format!("git add failed: {}", add.stderr.trim()));
        }
    }

    // Scope the staged check and the commit to the project paths. Without
    // this, a project nested in a larger repo would commit whatever else is
    // staged anywhere in the repo index.
    let scoped: Vec<String> = if pathspecs.is_empty() {
        vec![".".to_string()]
    } else {
        pathspecs.clone()
    };

    // Anything staged (within the project scope)?
    let mut staged_args = vec![
        "diff".to_string(),
        "--cached".to_string(),
        "--name-only".to_string(),
        "--".to_string(),
    ];
    staged_args.extend(scoped.iter().cloned());
    let staged_arg_refs: Vec<&str> = staged_args.iter().map(|s| s.as_str()).collect();
    let staged = run_git(cwd, &staged_arg_refs, DEFAULT_TIMEOUT_MS)?;
    if staged.exit_code != 0 {
        return Err(format!(
            "git diff --cached failed: {}",
            staged.stderr.trim()
        ));
    }
    if staged.stdout.trim().is_empty() {
        return Ok(GitCommitResult {
            committed: false,
            commit_sha: None,
            subject: None,
            skipped_no_changes: true,
        });
    }

    let mut commit_args = vec![
        "commit".to_string(),
        "--no-status".to_string(),
        "-m".to_string(),
        msg.clone(),
        "--".to_string(),
    ];
    commit_args.extend(scoped.iter().cloned());
    let commit_arg_refs: Vec<&str> = commit_args.iter().map(|s| s.as_str()).collect();
    let commit = run_git(cwd, &commit_arg_refs, COMMIT_TIMEOUT_MS)?;
    if commit.exit_code != 0 {
        return Err(format!(
            "git commit failed: {}",
            commit.stderr.trim().if_empty(&commit.stdout)
        ));
    }

    let sha_run = run_git(cwd, &["rev-parse", "HEAD"], DEFAULT_TIMEOUT_MS)?;
    let sha = if sha_run.exit_code == 0 {
        let s = sha_run.stdout.trim();
        if s.is_empty() {
            None
        } else {
            Some(s.to_string())
        }
    } else {
        None
    };
    let subject = msg.lines().next().map(|s| s.to_string());
    Ok(GitCommitResult {
        committed: true,
        commit_sha: sha,
        subject,
        skipped_no_changes: false,
    })
}

trait IfEmpty {
    fn if_empty<'a>(&'a self, other: &'a str) -> &'a str;
}
impl IfEmpty for str {
    fn if_empty<'a>(&'a self, other: &'a str) -> &'a str {
        if self.trim().is_empty() {
            other
        } else {
            self
        }
    }
}

fn remote_for_push(cwd: &Path, branch: &str) -> Result<String, String> {
    let branch_remote_key = format!("branch.{branch}.remote");
    if let Ok(run) = run_git(
        cwd,
        &["config", "--get", &branch_remote_key],
        DEFAULT_TIMEOUT_MS,
    ) {
        let configured = run.stdout.trim();
        if run.exit_code == 0 && !configured.is_empty() && configured != "." {
            return Ok(configured.to_string());
        }
    }
    if remote_exists(cwd, "origin") {
        return Ok("origin".into());
    }
    let run = run_git(cwd, &["remote"], DEFAULT_TIMEOUT_MS)?;
    run.stdout
        .lines()
        .map(str::trim)
        .find(|remote| !remote.is_empty())
        .map(str::to_string)
        .ok_or_else(|| "No git remote configured".into())
}

fn do_push(cwd: &Path, set_upstream: bool) -> Result<GitPushResult, String> {
    let status = build_status(cwd)?;
    if !status.is_repo {
        return Err("Not a git repository".into());
    }
    let branch = status
        .branch
        .clone()
        .ok_or_else(|| "Detached HEAD — checkout a branch before pushing".to_string())?;
    if status.detached {
        return Err("Detached HEAD — checkout a branch before pushing".into());
    }
    if !status.has_primary_remote {
        return Err("No git remote configured".into());
    }

    let needs_upstream = set_upstream || !status.has_upstream;
    let mut selected_remote = None;
    let run = if needs_upstream {
        let remote = remote_for_push(cwd, &branch)?;
        let result = run_git(cwd, &["push", "-u", &remote, "HEAD"], PUSH_TIMEOUT_MS)?;
        selected_remote = Some(remote);
        result
    } else {
        run_git(cwd, &["push"], PUSH_TIMEOUT_MS)?
    };

    if run.exit_code != 0 {
        let detail = run.stderr.trim().if_empty(run.stdout.trim());
        return Err(format!("git push failed: {detail}"));
    }

    let detail = {
        let s = run.stderr.trim().if_empty(run.stdout.trim());
        if s.is_empty() {
            "Push completed".into()
        } else {
            s.chars().take(500).collect::<String>()
        }
    };

    let upstream_out = status.upstream.clone().unwrap_or_else(|| {
        format!(
            "{}/{branch}",
            selected_remote.as_deref().unwrap_or("origin")
        )
    });

    Ok(GitPushResult {
        pushed: true,
        branch: Some(branch),
        upstream: Some(upstream_out),
        set_upstream: needs_upstream,
        detail,
    })
}

fn with_repo<T>(
    app: &AppHandle,
    path: &str,
    f: impl FnOnce(&Path) -> Result<T, String>,
) -> Result<T, String> {
    let project = resolve_project_root(app, path)?;
    let git_root = match discover_git_root(&project)? {
        Some(r) => r,
        None => return Err("NOT_A_REPO".into()),
    };
    ensure_repo_under_project(&project, &git_root)?;
    // Run commands from the project path (worktree cwd) so status reflects the opened folder.
    // Prefer project if it is inside the repo; otherwise use git root.
    let cwd = if path_compare_key(&project) == path_compare_key(&git_root)
        || path_compare_key(&project).starts_with(&format!("{}/", path_compare_key(&git_root)))
    {
        project
    } else {
        git_root
    };
    f(&cwd)
}

#[derive(Debug, Clone)]
struct RepoPaths {
    root: PathBuf,
    common_dir: PathBuf,
}

#[derive(Debug, Clone)]
struct LinkedWorktree {
    path: PathBuf,
    branch: Option<String>,
}

fn resolve_repo_paths(cwd: &Path) -> Result<RepoPaths, String> {
    let root = discover_git_root(cwd)?.ok_or_else(|| "Not a git repository".to_string())?;
    let root = strip_verbatim_prefix(
        std::fs::canonicalize(&root)
            .map_err(|e| format!("resolve repository root {}: {e}", root.display()))?,
    );
    let common = run_git(
        &root,
        &["rev-parse", "--git-common-dir"],
        DEFAULT_TIMEOUT_MS,
    )?;
    if common.exit_code != 0 {
        return Err(format!(
            "resolve common git directory failed: {}",
            common.stderr.trim().if_empty(common.stdout.trim())
        ));
    }
    let raw = common.stdout.trim();
    if raw.is_empty() {
        return Err("Git returned an empty common directory".into());
    }
    let common_path = PathBuf::from(raw);
    let common_path = if common_path.is_absolute() {
        common_path
    } else {
        root.join(common_path)
    };
    let common_dir = strip_verbatim_prefix(std::fs::canonicalize(&common_path).map_err(|e| {
        format!(
            "resolve common git directory {}: {e}",
            common_path.display()
        )
    })?);
    Ok(RepoPaths { root, common_dir })
}

fn project_relative_to_repo(project: &Path, repo_root: &Path) -> Result<PathBuf, String> {
    let project = strip_verbatim_prefix(
        std::fs::canonicalize(project)
            .map_err(|e| format!("resolve project path {}: {e}", project.display()))?,
    );
    if path_compare_key(&project) == path_compare_key(repo_root) {
        return Ok(PathBuf::new());
    }
    project
        .strip_prefix(repo_root)
        .map(Path::to_path_buf)
        .map_err(|_| "Registered project is not nested under the Git repository root".into())
}

fn mapped_worktree_path(linked_root: &Path, project_relative: &Path) -> PathBuf {
    if project_relative.as_os_str().is_empty() {
        linked_root.to_path_buf()
    } else {
        linked_root.join(project_relative)
    }
}

fn linked_worktree_for_mapped_path(
    project: &Path,
    repo: &RepoPaths,
    candidate: &Path,
    linked: &[LinkedWorktree],
) -> Result<LinkedWorktree, String> {
    let project_relative = project_relative_to_repo(project, &repo.root)?;
    linked
        .iter()
        .find(|entry| {
            path_compare_key(&mapped_worktree_path(&entry.path, &project_relative))
                == path_compare_key(candidate)
        })
        .cloned()
        .ok_or_else(|| "The registered path is not mapped to an actual linked worktree".into())
}

fn validate_thread_id(input: &str) -> Result<String, String> {
    if input.is_empty() {
        return Err("Thread ID is required".into());
    }
    if input != input.trim() {
        return Err("Thread ID must not have leading or trailing whitespace".into());
    }
    if input.chars().count() > MAX_THREAD_ID_CHARS {
        return Err(format!(
            "Thread ID is too long (max {MAX_THREAD_ID_CHARS} characters)"
        ));
    }
    let mut chars = input.chars();
    let first = chars.next().expect("checked non-empty");
    if !first.is_ascii_alphanumeric()
        || !chars.all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_'))
    {
        return Err(
            "Thread ID may contain only ASCII letters, numbers, '-' and '_', and must start with a letter or number"
                .into(),
        );
    }
    Ok(input.to_string())
}

fn current_branch_ref(cwd: &Path) -> Option<String> {
    let run = run_git(
        cwd,
        &["symbolic-ref", "--quiet", "HEAD"],
        DEFAULT_TIMEOUT_MS,
    )
    .ok()?;
    (run.exit_code == 0)
        .then(|| run.stdout.trim().to_string())
        .filter(|name| !name.is_empty())
}

fn list_git_refs(cwd: &Path) -> Result<Vec<GitRef>, String> {
    let run = run_git(
        cwd,
        &[
            "for-each-ref",
            "--format=%(refname)%09%(refname:short)",
            "refs/heads",
            "refs/remotes",
        ],
        DEFAULT_TIMEOUT_MS,
    )?;
    if run.exit_code != 0 {
        return Err(format!(
            "git ref listing failed: {}",
            run.stderr.trim().if_empty(run.stdout.trim())
        ));
    }

    let current = current_branch_ref(cwd);
    let mut refs = run
        .stdout
        .lines()
        .filter_map(|line| {
            let (name, short_name) = line.split_once('\t')?;
            let kind = if name.starts_with("refs/heads/") {
                "local"
            } else if name.starts_with("refs/remotes/") && !name.ends_with("/HEAD") {
                "remote"
            } else {
                return None;
            };
            Some(GitRef {
                name: name.to_string(),
                short_name: short_name.to_string(),
                kind: kind.to_string(),
                current: current.as_deref() == Some(name),
            })
        })
        .collect::<Vec<_>>();
    refs.sort_by(|left, right| {
        right
            .current
            .cmp(&left.current)
            .then_with(|| left.kind.cmp(&right.kind))
            .then_with(|| left.short_name.cmp(&right.short_name))
    });
    Ok(refs)
}

fn validate_worktree_base_ref(cwd: &Path, input: &str) -> Result<String, String> {
    if input.is_empty() || input != input.trim() || input.chars().count() > MAX_GIT_REF_CHARS {
        return Err("Choose a valid local or remote branch ref".into());
    }
    if !(input.starts_with("refs/heads/") || input.starts_with("refs/remotes/"))
        || input.ends_with("/HEAD")
    {
        return Err("Worktree base must be a local or remote branch ref".into());
    }
    let run = run_git(
        cwd,
        &["show-ref", "--verify", "--quiet", input],
        DEFAULT_TIMEOUT_MS,
    )?;
    if run.exit_code != 0 {
        return Err(format!("Worktree base ref is unavailable: {input}"));
    }
    Ok(input.to_string())
}

fn app_worktree_root(common_dir: &Path) -> PathBuf {
    common_dir.join("open-xiao-worktrees")
}

fn list_linked_worktrees(cwd: &Path) -> Result<Vec<LinkedWorktree>, String> {
    let run = run_git(
        cwd,
        &["worktree", "list", "--porcelain", "-z"],
        DEFAULT_TIMEOUT_MS,
    )?;
    if run.exit_code != 0 {
        return Err(format!(
            "git worktree list failed: {}",
            run.stderr.trim().if_empty(run.stdout.trim())
        ));
    }

    let mut entries = Vec::new();
    let mut current_path: Option<PathBuf> = None;
    let mut current_branch: Option<String> = None;
    for field in run.stdout.split('\0').filter(|field| !field.is_empty()) {
        if let Some(raw) = field.strip_prefix("worktree ") {
            if let Some(path) = current_path.take() {
                entries.push(LinkedWorktree {
                    path,
                    branch: current_branch.take(),
                });
            }
            current_path = Some(strip_verbatim_prefix(PathBuf::from(raw)));
        } else if let Some(branch) = field.strip_prefix("branch refs/heads/") {
            current_branch = Some(branch.to_string());
        }
    }
    if let Some(path) = current_path {
        entries.push(LinkedWorktree {
            path,
            branch: current_branch,
        });
    }
    Ok(entries)
}

fn parse_pr_url(text: &str) -> Option<String> {
    for token in text.split_whitespace() {
        let candidate = token.trim_matches(|c| matches!(c, '(' | ')' | '"' | '\'' | ','));
        let Ok(parsed) = url::Url::parse(candidate) else {
            continue;
        };
        if matches!(parsed.scheme(), "http" | "https")
            && parsed.host_str().is_some()
            && parsed.path().contains("/pull/")
        {
            return Some(parsed.to_string());
        }
    }
    None
}

#[derive(Default)]
struct BoundedProcessOutput {
    bytes: Vec<u8>,
    discarded: usize,
}

fn drain_process_pipe<R: Read>(mut pipe: R) -> BoundedProcessOutput {
    let mut output = BoundedProcessOutput::default();
    let mut chunk = [0_u8; 16 * 1024];
    loop {
        match pipe.read(&mut chunk) {
            Ok(0) | Err(_) => break,
            Ok(read) => {
                let remaining = MAX_PROCESS_OUTPUT_BYTES.saturating_sub(output.bytes.len());
                let kept = remaining.min(read);
                output.bytes.extend_from_slice(&chunk[..kept]);
                output.discarded = output.discarded.saturating_add(read - kept);
            }
        }
    }
    output
}

fn receive_process_output(
    receiver: &mpsc::Receiver<BoundedProcessOutput>,
    deadline: Instant,
) -> BoundedProcessOutput {
    let remaining = deadline.saturating_duration_since(Instant::now());
    receiver.recv_timeout(remaining).unwrap_or_default()
}

fn output_string(output: BoundedProcessOutput) -> String {
    let mut text = String::from_utf8_lossy(&output.bytes).into_owned();
    if output.discarded > 0 {
        text.push_str(&format!(
            "\n... ({} output bytes omitted)",
            output.discarded
        ));
    }
    text
}

fn terminate_process_tree(child: &mut std::process::Child) {
    let pid = child.id();
    #[cfg(windows)]
    {
        let _ = Command::new("taskkill")
            .args(["/F", "/T", "/PID", &pid.to_string()])
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status();
    }
    #[cfg(unix)]
    unsafe {
        let _ = libc::kill(-(pid as i32), libc::SIGKILL);
    }
    let _ = child.kill();
    for _ in 0..50 {
        if child.try_wait().ok().flatten().is_some() {
            break;
        }
        thread::sleep(Duration::from_millis(10));
    }
}

fn run_process(
    program: &str,
    args: &[&str],
    cwd: &Path,
    timeout_ms: u64,
) -> Result<GitRun, String> {
    let mut command = Command::new(program);
    command
        .args(args)
        .current_dir(cwd)
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GCM_INTERACTIVE", "never")
        .env("GIT_OPTIONAL_LOCKS", "0")
        .env("GH_PROMPT_DISABLED", "1")
        .env("GH_NO_UPDATE_NOTIFIER", "1")
        .env("NO_COLOR", "1")
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    #[cfg(unix)]
    command.process_group(0);
    let mut child = command.spawn().map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            format!("{program} executable not found on PATH")
        } else {
            format!("spawn {program}: {e}")
        }
    })?;

    let (stdout_tx, stdout_rx) = mpsc::sync_channel(1);
    let (stderr_tx, stderr_rx) = mpsc::sync_channel(1);
    if let Some(stdout) = child.stdout.take() {
        thread::spawn(move || {
            let _ = stdout_tx.send(drain_process_pipe(stdout));
        });
    }
    if let Some(stderr) = child.stderr.take() {
        thread::spawn(move || {
            let _ = stderr_tx.send(drain_process_pipe(stderr));
        });
    }

    let start = Instant::now();
    let timeout = Duration::from_millis(timeout_ms.max(1));
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if start.elapsed() > timeout => {
                terminate_process_tree(&mut child);
                return Err(format!("{program} timed out after {timeout_ms}ms"));
            }
            Ok(None) => thread::sleep(Duration::from_millis(20)),
            Err(e) => {
                terminate_process_tree(&mut child);
                return Err(format!("wait {program}: {e}"));
            }
        }
    };

    let deadline = Instant::now() + Duration::from_millis(PIPE_DRAIN_GRACE_MS);
    let stdout = receive_process_output(&stdout_rx, deadline);
    let stderr = receive_process_output(&stderr_rx, deadline);
    Ok(GitRun {
        exit_code: status.code().unwrap_or(-1),
        stdout: output_string(stdout),
        stderr: output_string(stderr),
    })
}

fn do_create_worktree(
    project: &Path,
    thread_id: &str,
    base_ref: &str,
) -> Result<GitWorktreeResult, String> {
    let thread_id = validate_thread_id(thread_id)?;
    let repo = resolve_repo_paths(project)?;
    let project_relative = project_relative_to_repo(project, &repo.root)?;
    let base_ref = validate_worktree_base_ref(&repo.root, base_ref)?;
    let branch = format!("xiao/{thread_id}");
    let owned_root = app_worktree_root(&repo.common_dir);
    std::fs::create_dir_all(&owned_root).map_err(|e| {
        format!(
            "create app worktree directory {}: {e}",
            owned_root.display()
        )
    })?;
    let worktree_path = owned_root.join(&thread_id);
    if worktree_path.exists() {
        return Err(format!(
            "An Open Xiao worktree already exists for thread '{thread_id}'"
        ));
    }

    let path_arg = worktree_path.to_string_lossy().to_string();
    let branch_ref = format!("refs/heads/{branch}");
    let branch_exists = run_git(
        &repo.root,
        &["show-ref", "--verify", "--quiet", &branch_ref],
        DEFAULT_TIMEOUT_MS,
    )?
    .exit_code
        == 0;
    let args = if branch_exists {
        vec!["worktree", "add", &path_arg, &branch]
    } else {
        vec!["worktree", "add", "-b", &branch, &path_arg, &base_ref]
    };
    let run = run_git(&repo.root, &args, WORKTREE_TIMEOUT_MS)?;
    if run.exit_code != 0 {
        let _ = std::fs::remove_dir(&worktree_path);
        return Err(format!(
            "git worktree add failed: {}",
            run.stderr.trim().if_empty(run.stdout.trim())
        ));
    }

    let worktree_path = strip_verbatim_prefix(
        std::fs::canonicalize(&worktree_path)
            .map_err(|e| format!("resolve created worktree {}: {e}", worktree_path.display()))?,
    );
    let mapped_path = mapped_worktree_path(&worktree_path, &project_relative);
    let mapped_path = match std::fs::canonicalize(&mapped_path) {
        Ok(path) => strip_verbatim_prefix(path),
        Err(error) => {
            let worktree_arg = worktree_path.to_string_lossy().to_string();
            let rollback = run_git(
                &repo.root,
                &["worktree", "remove", &worktree_arg],
                WORKTREE_TIMEOUT_MS,
            );
            let rollback_detail = match rollback {
                Ok(run) if run.exit_code == 0 => String::new(),
                Ok(run) => format!(
                    "; cleanup also failed: {}",
                    run.stderr.trim().if_empty(run.stdout.trim())
                ),
                Err(err) => format!("; cleanup also failed: {err}"),
            };
            return Err(format!(
                "resolve mapped project worktree {}: {error}{rollback_detail}",
                mapped_path.display()
            ));
        }
    };
    Ok(GitWorktreeResult {
        path: display_path(&mapped_path),
        branch,
        warning: None,
    })
}

fn rollback_created_worktree(project: &Path, worktree_path: &Path) -> Result<(), String> {
    let repo = resolve_repo_paths(project)?;
    let candidate = strip_verbatim_prefix(
        std::fs::canonicalize(worktree_path)
            .map_err(|e| format!("resolve worktree {}: {e}", worktree_path.display()))?,
    );
    let linked = list_linked_worktrees(&repo.root)?;
    let entry = linked_worktree_for_mapped_path(project, &repo, &candidate, &linked)?;
    let path_arg = entry.path.to_string_lossy().to_string();
    let run = run_git(
        &repo.root,
        &["worktree", "remove", &path_arg],
        WORKTREE_TIMEOUT_MS,
    )?;
    if run.exit_code != 0 {
        return Err(format!(
            "git worktree rollback failed: {}",
            run.stderr.trim().if_empty(run.stdout.trim())
        ));
    }
    Ok(())
}

fn do_remove_worktree(project: &Path, worktree_path: &Path) -> Result<GitWorktreeResult, String> {
    let repo = resolve_repo_paths(project)?;
    let candidate = strip_verbatim_prefix(
        std::fs::canonicalize(worktree_path)
            .map_err(|e| format!("resolve worktree {}: {e}", worktree_path.display()))?,
    );
    let linked = list_linked_worktrees(&repo.root)?;
    let entry = linked_worktree_for_mapped_path(project, &repo, &candidate, &linked)?;
    let linked_root = strip_verbatim_prefix(
        std::fs::canonicalize(&entry.path)
            .map_err(|e| format!("resolve linked worktree {}: {e}", entry.path.display()))?,
    );
    let main_path = linked.first().map(|entry| &entry.path);

    if path_compare_key(&linked_root) == path_compare_key(&repo.root) {
        return Err("Refusing to remove the source worktree".into());
    }
    if main_path
        .map(|path| path_compare_key(path) == path_compare_key(&linked_root))
        .unwrap_or(false)
    {
        return Err("Refusing to remove the main worktree".into());
    }

    let candidate_repo = resolve_repo_paths(&candidate)?;
    if path_compare_key(&candidate_repo.root) != path_compare_key(&linked_root) {
        return Err("Registered project path does not belong to the mapped linked worktree".into());
    }
    if path_compare_key(&candidate_repo.common_dir) != path_compare_key(&repo.common_dir) {
        return Err("Worktree belongs to a different Git repository".into());
    }

    let owned_root = strip_verbatim_prefix(
        std::fs::canonicalize(app_worktree_root(&repo.common_dir)).map_err(|e| {
            format!(
                "resolve app worktree directory {}: {e}",
                app_worktree_root(&repo.common_dir).display()
            )
        })?,
    );
    if path_compare_key(&linked_root) == path_compare_key(&owned_root)
        || !is_path_within_root(&owned_root, &linked_root)
    {
        return Err("Refusing to remove a worktree outside .git/open-xiao-worktrees".into());
    }

    let branch = entry
        .branch
        .clone()
        .ok_or_else(|| "Refusing to remove a detached worktree".to_string())?;
    let status = run_git(
        &linked_root,
        &["status", "--porcelain", "--untracked-files=all"],
        DEFAULT_TIMEOUT_MS,
    )?;
    if status.exit_code != 0 {
        return Err(format!(
            "git status failed for worktree: {}",
            status.stderr.trim().if_empty(status.stdout.trim())
        ));
    }
    if !status.stdout.trim().is_empty() {
        return Err(
            "Worktree has uncommitted changes. Commit or discard them before removing it.".into(),
        );
    }

    let path_arg = linked_root.to_string_lossy().to_string();
    let remove = run_git(
        &repo.root,
        &["worktree", "remove", &path_arg],
        WORKTREE_TIMEOUT_MS,
    )?;
    if remove.exit_code != 0 {
        return Err(format!(
            "git worktree remove failed: {}",
            remove.stderr.trim().if_empty(remove.stdout.trim())
        ));
    }

    Ok(GitWorktreeResult {
        path: display_path(&candidate),
        branch,
        warning: None,
    })
}

fn validate_pr_preconditions(cwd: &Path) -> Result<String, String> {
    let status = build_status(cwd)?;
    if !status.is_repo {
        return Err("Not a git repository".into());
    }
    if status.detached {
        return Err("Detached HEAD — checkout a branch before opening a PR".into());
    }
    let branch = status
        .branch
        .clone()
        .ok_or_else(|| "Detached HEAD — checkout a branch before opening a PR".to_string())?;
    if status.is_default_branch {
        return Err("Open PR requires a non-default branch".into());
    }

    let remotes = run_git(cwd, &["remote"], DEFAULT_TIMEOUT_MS)?;
    if remotes.exit_code != 0 || !remotes.stdout.lines().any(|line| !line.trim().is_empty()) {
        return Err("No git remote configured. Add a remote before opening a PR.".into());
    }
    if status.upstream.is_none() {
        return Err(
            "Current branch has no upstream. Push it with `git push -u <remote> HEAD` first."
                .into(),
        );
    }

    let ahead = run_git(
        cwd,
        &["rev-list", "--count", "@{upstream}..HEAD"],
        DEFAULT_TIMEOUT_MS,
    )?;
    if ahead.exit_code != 0 {
        return Err(format!(
            "Could not compare the branch with its upstream: {}",
            ahead.stderr.trim().if_empty(ahead.stdout.trim())
        ));
    }
    let unpushed = ahead
        .stdout
        .trim()
        .parse::<u64>()
        .map_err(|_| "Git returned an invalid unpushed commit count".to_string())?;
    if unpushed > 0 {
        return Err(format!(
            "Current branch has {unpushed} unpushed commit(s). Push before opening a PR."
        ));
    }
    Ok(branch)
}

fn is_gh_auth_error(detail: &str) -> bool {
    let lower = detail.to_ascii_lowercase();
    lower.contains("not logged")
        || lower.contains("authenticate")
        || lower.contains("authentication")
        || lower.contains("gh auth login")
        || lower.contains("http 401")
        || lower.contains("bad credentials")
}

fn is_missing_pr_error(detail: &str) -> bool {
    let lower = detail.to_ascii_lowercase();
    lower.contains("no pull requests found")
        || lower.contains("no pull request found")
        || lower.contains("no open pull requests")
        || lower.contains("could not find pull request")
}

fn gh_failure(action: &str, detail: &str) -> String {
    if is_gh_auth_error(detail) {
        format!("GitHub CLI is not authenticated. Run `gh auth login` and try again. ({detail})")
    } else {
        format!("gh {action} failed: {detail}")
    }
}

fn do_open_pr(cwd: &Path) -> Result<GitPrResult, String> {
    validate_pr_preconditions(cwd)?;
    let view = run_process(
        "gh",
        &["pr", "view", "--json", "url", "--jq", ".url"],
        cwd,
        PR_TIMEOUT_MS,
    )?;
    if view.exit_code == 0 {
        return parse_pr_url(&view.stdout)
            .or_else(|| parse_pr_url(&view.stderr))
            .map(|url| GitPrResult {
                url,
                created: false,
            })
            .ok_or_else(|| "gh pr view succeeded but returned no pull request URL".into());
    }

    let detail = view.stderr.trim().if_empty(view.stdout.trim());
    if !is_missing_pr_error(detail) {
        return Err(gh_failure("pr view", detail));
    }

    let create = run_process("gh", &["pr", "create", "--fill"], cwd, PR_TIMEOUT_MS)?;
    if create.exit_code != 0 {
        let detail = create.stderr.trim().if_empty(create.stdout.trim());
        return Err(gh_failure("pr create", detail));
    }
    parse_pr_url(&create.stdout)
        .or_else(|| parse_pr_url(&create.stderr))
        .map(|url| GitPrResult { url, created: true })
        .ok_or_else(|| "gh pr create succeeded but returned no pull request URL".into())
}

#[tauri::command]
pub fn git_status(app: AppHandle, path: String) -> Result<GitStatus, String> {
    match with_repo(&app, &path, build_status) {
        Ok(s) => Ok(s),
        Err(e) if e == "NOT_A_REPO" => Ok(non_repo_status(None)),
        Err(e) => {
            // Soft-fail common cases so UI can show "not a repo" instead of toast spam
            let lower = e.to_ascii_lowercase();
            if lower.contains("not a git") || lower.contains("git executable not found") {
                Ok(non_repo_status(Some(e)))
            } else {
                Err(e)
            }
        }
    }
}

#[tauri::command]
pub fn git_diff(app: AppHandle, path: String) -> Result<GitDiffResult, String> {
    match with_repo(&app, &path, build_diff) {
        Ok(d) => Ok(d),
        Err(e) if e == "NOT_A_REPO" => Ok(GitDiffResult {
            is_repo: false,
            root: None,
            branch: None,
            files: Vec::new(),
            insertions: 0,
            deletions: 0,
            truncated: false,
            error: None,
        }),
        Err(e) => Err(e),
    }
}

#[tauri::command]
pub fn git_commit(
    app: AppHandle,
    path: String,
    message: String,
    paths: Option<Vec<String>>,
) -> Result<GitCommitResult, String> {
    let paths = paths.unwrap_or_default();
    with_repo(&app, &path, |cwd| do_commit(cwd, &message, &paths)).map_err(|e| {
        if e == "NOT_A_REPO" {
            "Not a git repository".into()
        } else {
            e
        }
    })
}

#[tauri::command]
pub fn git_push(
    app: AppHandle,
    path: String,
    set_upstream: Option<bool>,
) -> Result<GitPushResult, String> {
    with_repo(&app, &path, |cwd| {
        do_push(cwd, set_upstream.unwrap_or(false))
    })
    .map_err(|e| {
        if e == "NOT_A_REPO" {
            "Not a git repository".into()
        } else {
            e
        }
    })
}

#[tauri::command]
pub fn git_list_refs(app: AppHandle, path: String) -> Result<Vec<GitRef>, String> {
    with_repo(&app, &path, list_git_refs).map_err(|e| {
        if e == "NOT_A_REPO" {
            "Not a git repository".into()
        } else {
            e
        }
    })
}

/// Create an isolated worktree for a thread under `.git/open-xiao-worktrees/<threadId>`.
/// Registers the worktree path as an allowed tool root.
#[tauri::command]
pub fn git_worktree_create(
    app: AppHandle,
    path: String,
    thread_id: String,
    base_ref: String,
) -> Result<GitWorktreeResult, String> {
    let result = with_repo(&app, &path, |cwd| {
        do_create_worktree(cwd, &thread_id, &base_ref)
    })
    .map_err(|e| {
        if e == "NOT_A_REPO" {
            "Not a git repository".into()
        } else {
            e
        }
    })?;

    let registered = match register_dir(&app, Path::new(&result.path)) {
        Ok(registered) => registered,
        Err(registration_error) => {
            let rollback = with_repo(&app, &path, |cwd| {
                rollback_created_worktree(cwd, Path::new(&result.path))
            });
            return Err(match rollback {
                Ok(()) => format!(
                    "Failed to register the created worktree; creation was rolled back: {registration_error}"
                ),
                Err(rollback_error) => format!(
                    "Failed to register the created worktree ({registration_error}); rollback also failed: {rollback_error}"
                ),
            });
        }
    };
    Ok(GitWorktreeResult {
        path: display_path(&registered),
        branch: result.branch,
        warning: None,
    })
}

fn finish_worktree_removal(
    mut result: GitWorktreeResult,
    unregister_result: Result<(), String>,
) -> GitWorktreeResult {
    result.warning = unregister_result.err().map(|error| {
        format!(
            "Worktree was removed, but its workspace registration could not be cleared: {error}"
        )
    });
    result
}

#[tauri::command]
pub fn git_worktree_remove(
    app: AppHandle,
    path: String,
    worktree_path: String,
) -> Result<GitWorktreeResult, String> {
    resolve_project_root(&app, &path)?;
    let registered_worktree = require_registered_root(&app, &worktree_path)
        .map_err(|e| format!("Worktree is not registered: {e}"))?;
    let result = with_repo(&app, &path, |cwd| {
        do_remove_worktree(cwd, &registered_worktree)
    })
    .map_err(|e| {
        if e == "NOT_A_REPO" {
            "Not a git repository".into()
        } else {
            e
        }
    })?;
    let unregister_result = unregister_dir(&app, &result.path);
    Ok(finish_worktree_removal(result, unregister_result))
}

/// Open (or return existing) GitHub pull request for the current branch.
#[tauri::command]
pub fn git_pr_open(app: AppHandle, path: String) -> Result<GitPrResult, String> {
    with_repo(&app, &path, do_open_pr).map_err(|e| {
        if e == "NOT_A_REPO" {
            "Not a git repository".into()
        } else {
            e
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};

    static NEXT_TEMP_ID: AtomicU64 = AtomicU64::new(1);

    fn temp_dir(label: &str) -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let id = NEXT_TEMP_ID.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!("open-xiao-git-{label}-{nanos}-{id}"));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn git(cwd: &Path, args: &[&str]) -> GitRun {
        run_git(cwd, args, 30_000).expect("git")
    }

    fn run_python(script: &str, timeout_ms: u64) -> Result<GitRun, String> {
        if cfg!(windows) {
            run_process(
                "py",
                &["-3", "-c", script],
                &std::env::temp_dir(),
                timeout_ms,
            )
        } else {
            run_process(
                "python3",
                &["-c", script],
                &std::env::temp_dir(),
                timeout_ms,
            )
        }
    }

    fn init_repo() -> PathBuf {
        let dir = temp_dir("repo");
        let r = git(&dir, &["init"]);
        assert_eq!(r.exit_code, 0, "{}", r.stderr);
        let _ = git(&dir, &["config", "user.email", "test@example.com"]);
        let _ = git(&dir, &["config", "user.name", "Test"]);
        // Ensure main
        let _ = git(&dir, &["checkout", "-b", "main"]);
        fs::write(dir.join("README.md"), "hello\n").unwrap();
        let _ = git(&dir, &["add", "README.md"]);
        let c = git(&dir, &["commit", "-m", "init"]);
        assert_eq!(c.exit_code, 0, "{}", c.stderr);
        dir
    }

    fn init_nested_repo() -> (PathBuf, PathBuf) {
        let dir = init_repo();
        let project = dir.join("project");
        fs::create_dir_all(&project).unwrap();
        fs::write(project.join("inside.txt"), "inside\n").unwrap();
        fs::write(dir.join("sibling.txt"), "sibling\n").unwrap();
        let add = git(&dir, &["add", "project/inside.txt", "sibling.txt"]);
        assert_eq!(add.exit_code, 0, "{}", add.stderr);
        let commit = git(&dir, &["commit", "-m", "add nested project"]);
        assert_eq!(commit.exit_code, 0, "{}", commit.stderr);
        (dir, project)
    }

    fn init_bare_repo() -> PathBuf {
        let dir = temp_dir("bare");
        let init = git(&dir, &["init", "--bare"]);
        assert_eq!(init.exit_code, 0, "{}", init.stderr);
        dir
    }

    #[test]
    fn parse_numstat_basic() {
        let map = parse_numstat("3\t1\tsrc/a.ts\0-\t-\tbin/x.png\0");
        assert_eq!(map.get("src/a.ts"), Some(&(3, 1)));
        assert_eq!(map.get("bin/x.png"), Some(&(0, 0)));
    }

    #[test]
    fn parse_branch_ab_values() {
        assert_eq!(parse_branch_ab("+2 -3"), (2, 3));
        assert_eq!(parse_branch_ab("+0 -0"), (0, 0));
    }

    #[test]
    fn status_and_diff_detect_edits() {
        let dir = init_repo();
        fs::write(dir.join("README.md"), "hello\nworld\n").unwrap();
        fs::write(dir.join("new.txt"), "fresh\n").unwrap();

        let status = build_status(&dir).expect("status");
        assert!(status.is_repo);
        assert_eq!(status.branch.as_deref(), Some("main"));
        assert!(status.has_working_tree_changes);
        assert!(status
            .working_tree
            .files
            .iter()
            .any(|f| f.path == "README.md"));
        assert!(status
            .working_tree
            .files
            .iter()
            .any(|f| f.path == "new.txt"));

        let diff = build_diff(&dir).expect("diff");
        assert!(diff.is_repo);
        assert!(diff
            .files
            .iter()
            .any(|f| f.path == "README.md" && !f.patch.is_empty()));
        assert!(diff.files.iter().any(|f| f.path == "new.txt"));
        assert!(diff.insertions > 0);

        let _ = fs::remove_dir_all(&dir);
    }

    #[cfg(windows)]
    #[test]
    fn status_does_not_execute_repository_fsmonitor_hook() {
        let dir = init_repo();
        let marker = dir.join("fsmonitor-executed.txt");
        let hook = dir.join("malicious-fsmonitor.cmd");
        fs::write(
            &hook,
            format!("@echo off\r\n>\"{}\" echo executed\r\n", marker.display()),
        )
        .unwrap();
        let hook_path = hook.to_string_lossy().replace('\\', "/");
        let configured = git(&dir, &["config", "core.fsmonitor", &hook_path]);
        assert_eq!(configured.exit_code, 0, "{}", configured.stderr);
        assert!(
            !marker.exists(),
            "git config unexpectedly executed fsmonitor"
        );

        let status = build_status(&dir);
        let executed = marker.exists();
        let _ = fs::remove_dir_all(&dir);

        assert!(!executed, "git status executed repository core.fsmonitor");
        assert!(status.is_ok(), "status failed: {status:?}");
    }

    #[cfg(windows)]
    #[test]
    fn diff_does_not_execute_repository_textconv() {
        let dir = init_repo();
        fs::write(dir.join(".gitattributes"), "README.md diff=malicious\n").unwrap();
        let add = git(&dir, &["add", ".gitattributes"]);
        assert_eq!(add.exit_code, 0, "{}", add.stderr);
        let commit = git(&dir, &["commit", "-m", "attributes"]);
        assert_eq!(commit.exit_code, 0, "{}", commit.stderr);

        let marker = dir.join("textconv-executed.txt");
        let hook = dir.join("malicious-textconv.cmd");
        fs::write(
            &hook,
            format!(
                "@echo off\r\n>\"{}\" echo executed\r\ntype \"%~1\"\r\n",
                marker.display()
            ),
        )
        .unwrap();
        let hook_path = hook.to_string_lossy().replace('\\', "/");
        let configured = git(&dir, &["config", "diff.malicious.textconv", &hook_path]);
        assert_eq!(configured.exit_code, 0, "{}", configured.stderr);
        assert!(
            !marker.exists(),
            "git config unexpectedly executed textconv"
        );
        fs::write(dir.join("README.md"), "changed\n").unwrap();

        let status = build_status(&dir);
        assert!(status.is_ok(), "status failed: {status:?}");
        assert!(!marker.exists(), "git status executed repository textconv");
        let diff = build_diff(&dir);
        let executed = marker.exists();
        let _ = fs::remove_dir_all(&dir);

        assert!(!executed, "git diff executed repository textconv");
        assert!(diff.is_ok(), "diff failed: {diff:?}");
    }

    #[test]
    fn nested_project_status_and_diff_exclude_repo_siblings() {
        let (dir, project) = init_nested_repo();
        fs::write(project.join("inside.txt"), "inside changed\n").unwrap();
        fs::write(project.join("untracked.txt"), "project-only marker\n").unwrap();
        fs::write(dir.join("sibling.txt"), "sibling changed\n").unwrap();
        fs::write(dir.join("sibling-untracked.txt"), "sibling-only marker\n").unwrap();

        let status = build_status(&project).expect("nested status");
        let paths: Vec<&str> = status
            .working_tree
            .files
            .iter()
            .map(|file| file.path.as_str())
            .collect();
        assert_eq!(paths, vec!["inside.txt", "untracked.txt"]);
        assert!(paths.iter().all(|path| !path.starts_with("project/")));

        let diff = build_diff(&project).expect("nested diff");
        let diff_paths: Vec<&str> = diff.files.iter().map(|file| file.path.as_str()).collect();
        assert_eq!(diff_paths, vec!["inside.txt", "untracked.txt"]);
        assert!(diff_paths.iter().all(|path| !path.starts_with("project/")));
        let patches = diff
            .files
            .iter()
            .map(|file| file.patch.as_str())
            .collect::<Vec<_>>()
            .join("\n");
        assert!(patches.contains("project-only marker"), "{patches}");
        assert!(!patches.contains("a/project/"), "{patches}");
        assert!(!patches.contains("b/project/"), "{patches}");
        assert!(!patches.contains("sibling-only marker"), "{patches}");
        assert!(!patches.contains("sibling changed"), "{patches}");

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn status_preserves_paths_with_spaces() {
        let dir = init_repo();
        let path = "file with spaces.txt";
        fs::write(dir.join(path), "one\n").unwrap();
        let _ = git(&dir, &["add", "--", path]);
        let commit = git(&dir, &["commit", "-m", "add spaced path"]);
        assert_eq!(commit.exit_code, 0, "{}", commit.stderr);
        fs::write(dir.join(path), "two\n").unwrap();

        let status = build_status(&dir).expect("status");
        let reported_paths: Vec<&str> = status
            .working_tree
            .files
            .iter()
            .map(|file| file.path.as_str())
            .collect();

        assert_eq!(reported_paths, vec![path]);

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn diff_preserves_patch_for_path_with_spaces() {
        let dir = init_repo();
        let path = "file with spaces.txt";
        fs::write(dir.join(path), "one\n").unwrap();
        let _ = git(&dir, &["add", "--", path]);
        let commit = git(&dir, &["commit", "-m", "add spaced path"]);
        assert_eq!(commit.exit_code, 0, "{}", commit.stderr);
        fs::write(dir.join(path), "two\n").unwrap();

        let diff = build_diff(&dir).expect("diff");
        let file = diff
            .files
            .iter()
            .find(|file| file.path == path)
            .expect("file missing from diff");

        assert!(!file.patch.is_empty(), "missing patch for {}", file.path);

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn status_and_diff_preserve_unicode_paths() {
        let dir = init_repo();
        let path = "测试.txt";
        fs::write(dir.join(path), "one\n").unwrap();
        let _ = git(&dir, &["add", "--", path]);
        let commit = git(&dir, &["commit", "-m", "add unicode path"]);
        assert_eq!(commit.exit_code, 0, "{}", commit.stderr);
        fs::write(dir.join(path), "one\ntwo\n").unwrap();

        let status = build_status(&dir).expect("status");
        assert_eq!(status.working_tree.files.len(), 1);
        assert_eq!(status.working_tree.files[0].path, path);
        assert_eq!(status.working_tree.insertions, 1);

        let diff = build_diff(&dir).expect("diff");
        assert_eq!(diff.files.len(), 1);
        assert_eq!(diff.files[0].path, path);
        assert!(!diff.files[0].patch.is_empty());
        assert_eq!(diff.insertions, 1);

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn rename_uses_destination_path_once() {
        let dir = init_repo();
        fs::write(dir.join("old.txt"), "content\n").unwrap();
        let _ = git(&dir, &["add", "old.txt"]);
        let commit = git(&dir, &["commit", "-m", "add old"]);
        assert_eq!(commit.exit_code, 0, "{}", commit.stderr);
        let rename = git(&dir, &["mv", "old.txt", "new.txt"]);
        assert_eq!(rename.exit_code, 0, "{}", rename.stderr);

        let status = build_status(&dir).expect("status");
        assert_eq!(status.working_tree.files.len(), 1);
        assert_eq!(status.working_tree.files[0].path, "new.txt");

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn unborn_status_counts_current_tree_once() {
        let dir = temp_dir("unborn");
        let init = git(&dir, &["init"]);
        assert_eq!(init.exit_code, 0, "{}", init.stderr);
        fs::write(dir.join("new.txt"), "one\n").unwrap();
        let add = git(&dir, &["add", "new.txt"]);
        assert_eq!(add.exit_code, 0, "{}", add.stderr);
        fs::write(dir.join("new.txt"), "one\ntwo\n").unwrap();

        let status = build_status(&dir).expect("status");
        assert_eq!(status.working_tree.files.len(), 1);
        assert_eq!(status.working_tree.files[0].path, "new.txt");
        assert_eq!(status.working_tree.insertions, 2);
        assert_eq!(status.working_tree.deletions, 0);

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn first_push_uses_the_configured_remote() {
        let dir = init_repo();
        let bare = init_bare_repo();
        let bare_path = bare.to_string_lossy().to_string();
        let add_remote = git(&dir, &["remote", "add", "upstream", &bare_path]);
        assert_eq!(add_remote.exit_code, 0, "{}", add_remote.stderr);

        let pushed = do_push(&dir, true).expect("push");
        assert!(pushed.pushed);
        assert_eq!(pushed.upstream.as_deref(), Some("upstream/main"));

        let _ = fs::remove_dir_all(&dir);
        let _ = fs::remove_dir_all(&bare);
    }

    #[test]
    fn commit_stages_and_creates_sha() {
        let dir = init_repo();
        fs::write(dir.join("a.txt"), "a\n").unwrap();
        let result = do_commit(&dir, "add a", &[]).expect("commit");
        assert!(result.committed);
        assert!(result.commit_sha.is_some());
        assert_eq!(result.subject.as_deref(), Some("add a"));

        let status = build_status(&dir).expect("status");
        assert!(!status.has_working_tree_changes);

        let empty = do_commit(&dir, "noop", &[]).expect("noop");
        assert!(empty.skipped_no_changes);
        assert!(!empty.committed);

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn reject_bad_commit_message() {
        assert!(sanitize_commit_message("").is_err());
        assert!(sanitize_commit_message("-m hack").is_err());
        assert!(sanitize_commit_message("ok message").is_ok());
    }

    #[test]
    fn validate_thread_id_accepts_safe_ids() {
        assert!(validate_thread_id("abc123").is_ok());
        assert!(validate_thread_id("a-b_c").is_ok());
        assert!(validate_thread_id("").is_err());
        assert!(validate_thread_id("-bad").is_err());
        assert!(validate_thread_id("../x").is_err());
        assert!(validate_thread_id("a/b").is_err());
        assert!(validate_thread_id(" spaced").is_err());
        assert!(validate_thread_id(&"a".repeat(MAX_THREAD_ID_CHARS + 1)).is_err());
    }

    #[test]
    fn parse_pr_url_from_gh_output() {
        assert_eq!(
            parse_pr_url("https://github.com/acme/app/pull/12\n"),
            Some("https://github.com/acme/app/pull/12".into())
        );
        assert_eq!(
            parse_pr_url("created https://github.example/acme/app/pull/3"),
            Some("https://github.example/acme/app/pull/3".into())
        );
        assert_eq!(parse_pr_url("not a URL"), None);
        assert_eq!(parse_pr_url("https://github.com/acme/app/issues/3"), None);
    }

    #[test]
    fn pr_status_preconditions_use_only_local_git_state() {
        let dir = init_repo();
        let default_error = validate_pr_preconditions(&dir).expect_err("default branch rejected");
        assert!(default_error.contains("non-default"), "{default_error}");

        let remote = init_bare_repo();
        let remote_arg = remote.to_string_lossy().to_string();
        let add_remote = git(&dir, &["remote", "add", "origin", &remote_arg]);
        assert_eq!(add_remote.exit_code, 0, "{}", add_remote.stderr);
        let push_main = git(&dir, &["push", "-u", "origin", "main"]);
        assert_eq!(push_main.exit_code, 0, "{}", push_main.stderr);

        let checkout = git(&dir, &["checkout", "-b", "feature"]);
        assert_eq!(checkout.exit_code, 0, "{}", checkout.stderr);
        let upstream_error =
            validate_pr_preconditions(&dir).expect_err("missing upstream rejected");
        assert!(upstream_error.contains("no upstream"), "{upstream_error}");

        let push_feature = git(&dir, &["push", "-u", "origin", "feature"]);
        assert_eq!(push_feature.exit_code, 0, "{}", push_feature.stderr);
        assert_eq!(
            validate_pr_preconditions(&dir).expect("ready branch"),
            "feature"
        );

        fs::write(dir.join("feature.txt"), "feature\n").unwrap();
        let commit = do_commit(&dir, "feature commit", &[]).expect("local commit");
        assert!(commit.committed);
        let unpushed_error = validate_pr_preconditions(&dir).expect_err("unpushed commit rejected");
        assert!(unpushed_error.contains("unpushed"), "{unpushed_error}");

        let detach = git(&dir, &["checkout", "--detach"]);
        assert_eq!(detach.exit_code, 0, "{}", detach.stderr);
        let detached_error = validate_pr_preconditions(&dir).expect_err("detached rejected");
        assert!(detached_error.contains("Detached HEAD"), "{detached_error}");

        let _ = fs::remove_dir_all(&dir);
        let _ = fs::remove_dir_all(&remote);
    }

    #[test]
    fn pr_status_requires_a_remote_without_network() {
        let dir = init_repo();
        let checkout = git(&dir, &["checkout", "-b", "feature"]);
        assert_eq!(checkout.exit_code, 0, "{}", checkout.stderr);
        let error = validate_pr_preconditions(&dir).expect_err("missing remote rejected");
        assert!(error.contains("No git remote"), "{error}");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn worktree_removal_reports_unregister_failure_without_hiding_success() {
        let result = GitWorktreeResult {
            path: "C:/worktree".into(),
            branch: "xiao/thread-test".into(),
            warning: None,
        };

        let finished = finish_worktree_removal(result, Err("registry unavailable".into()));

        assert_eq!(finished.path, "C:/worktree");
        assert_eq!(finished.branch, "xiao/thread-test");
        assert_eq!(
            finished.warning.as_deref(),
            Some(
                "Worktree was removed, but its workspace registration could not be cleared: registry unavailable"
            )
        );
    }

    #[test]
    fn worktree_create_and_remove_isolates_edits() {
        let dir = init_repo();
        let feature = git(&dir, &["checkout", "-b", "feature/base"]);
        assert_eq!(feature.exit_code, 0, "{}", feature.stderr);
        fs::write(dir.join("BASE.txt"), "feature base\n").unwrap();
        let add = git(&dir, &["add", "BASE.txt"]);
        assert_eq!(add.exit_code, 0, "{}", add.stderr);
        let commit = git(&dir, &["commit", "-m", "feature base"]);
        assert_eq!(commit.exit_code, 0, "{}", commit.stderr);
        let main = git(&dir, &["checkout", "main"]);
        assert_eq!(main.exit_code, 0, "{}", main.stderr);
        let remote_ref = git(
            &dir,
            &["update-ref", "refs/remotes/origin/main", "refs/heads/main"],
        );
        assert_eq!(remote_ref.exit_code, 0, "{}", remote_ref.stderr);
        let remote_head = git(
            &dir,
            &[
                "symbolic-ref",
                "refs/remotes/origin/HEAD",
                "refs/remotes/origin/main",
            ],
        );
        assert_eq!(remote_head.exit_code, 0, "{}", remote_head.stderr);

        let refs = list_git_refs(&dir).expect("list refs");
        assert!(refs.iter().any(|git_ref| {
            git_ref.name == "refs/heads/main"
                && git_ref.short_name == "main"
                && git_ref.kind == "local"
                && git_ref.current
        }));
        assert!(refs.iter().any(|git_ref| {
            git_ref.name == "refs/heads/feature/base"
                && git_ref.short_name == "feature/base"
                && git_ref.kind == "local"
                && !git_ref.current
        }));
        assert!(refs.iter().any(|git_ref| {
            git_ref.name == "refs/remotes/origin/main"
                && git_ref.short_name == "origin/main"
                && git_ref.kind == "remote"
                && !git_ref.current
        }));
        assert!(!refs.iter().any(|git_ref| git_ref.name.ends_with("/HEAD")));

        let wt = do_create_worktree(&dir, "thread-abc1", "refs/heads/feature/base")
            .expect("create worktree");
        assert!(Path::new(&wt.path).is_dir(), "{}", wt.path);
        assert_eq!(wt.branch, "xiao/thread-abc1");
        assert!(Path::new(&wt.path).join("BASE.txt").is_file());
        let repo = resolve_repo_paths(&dir).expect("repo paths");
        assert_eq!(
            path_compare_key(Path::new(&wt.path)),
            path_compare_key(&app_worktree_root(&repo.common_dir).join("thread-abc1"))
        );

        // Edit only in worktree
        let readme = Path::new(&wt.path).join("README.md");
        fs::write(&readme, "worktree only\n").unwrap();

        let main_status = build_status(&dir).expect("main status");
        assert!(
            !main_status.has_working_tree_changes,
            "main tree should stay clean, got {:?}",
            main_status.working_tree.files
        );

        let wt_path = Path::new(&wt.path);
        let wt_status = build_status(wt_path).expect("wt status");
        assert!(wt_status.has_working_tree_changes);
        assert_eq!(wt_status.branch.as_deref(), Some(wt.branch.as_str()));

        let dirty_error = do_remove_worktree(&dir, wt_path).expect_err("dirty removal refused");
        assert!(dirty_error.contains("uncommitted changes"), "{dirty_error}");
        assert!(wt_path.exists());

        let restore = git(wt_path, &["checkout", "--", "README.md"]);
        assert_eq!(restore.exit_code, 0, "{}", restore.stderr);
        let removed = do_remove_worktree(&dir, wt_path).expect("remove");
        assert_eq!(removed.branch, "xiao/thread-abc1");
        assert!(!wt_path.exists());
        let branch = git(
            &dir,
            &["show-ref", "--verify", "refs/heads/xiao/thread-abc1"],
        );
        assert_eq!(
            branch.exit_code, 0,
            "branch should remain: {}",
            branch.stderr
        );

        let recreated =
            do_create_worktree(&dir, "thread-abc1", "refs/heads/main").expect("recreate worktree");
        assert_eq!(recreated.branch, "xiao/thread-abc1");
        do_remove_worktree(&dir, Path::new(&recreated.path)).expect("remove recreated worktree");

        let invalid = do_create_worktree(&dir, "thread-invalid", "HEAD")
            .expect_err("arbitrary revisions must be rejected");
        assert!(invalid.contains("local or remote branch ref"), "{invalid}");

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn nested_project_worktree_maps_path_and_checks_whole_checkout_on_remove() {
        let (dir, project) = init_nested_repo();
        let main_error = do_remove_worktree(&project, &project)
            .expect_err("mapped main project must be protected");
        assert!(
            main_error.contains("source worktree") || main_error.contains("main worktree"),
            "{main_error}"
        );

        let wt = do_create_worktree(&project, "thread-nested1", "refs/heads/main")
            .expect("create nested worktree");
        let mapped = Path::new(&wt.path);
        assert!(mapped.is_dir(), "{}", wt.path);
        assert_eq!(
            mapped.file_name().and_then(|name| name.to_str()),
            Some("project")
        );

        let linked_repo = resolve_repo_paths(mapped).expect("linked repo paths");
        assert_eq!(
            path_compare_key(mapped),
            path_compare_key(&linked_repo.root.join("project"))
        );
        assert_ne!(
            path_compare_key(mapped),
            path_compare_key(&linked_repo.root)
        );

        let linked_sibling = linked_repo.root.join("sibling.txt");
        fs::write(&linked_sibling, "dirty sibling\n").unwrap();
        let dirty_error = do_remove_worktree(&project, mapped)
            .expect_err("dirty sibling outside mapped project must block removal");
        assert!(dirty_error.contains("uncommitted changes"), "{dirty_error}");
        assert!(linked_repo.root.exists());

        let restore = git(&linked_repo.root, &["checkout", "--", "sibling.txt"]);
        assert_eq!(restore.exit_code, 0, "{}", restore.stderr);
        let removed = do_remove_worktree(&project, mapped).expect("remove nested worktree");
        assert_eq!(removed.path, display_path(mapped));
        assert_eq!(removed.branch, "xiao/thread-nested1");
        assert!(!linked_repo.root.exists());

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn commit_from_nested_project_does_not_stage_repo_siblings() {
        let dir = init_repo();
        let project = dir.join("project");
        fs::create_dir_all(&project).unwrap();
        fs::write(project.join("inside.txt"), "inside\n").unwrap();
        fs::write(dir.join("sibling.txt"), "sibling\n").unwrap();

        let result = do_commit(&project, "nested only", &[]).expect("commit nested project");
        assert!(result.committed);
        let staged = git(&dir, &["diff", "--cached", "--name-only"]);
        assert_eq!(staged.exit_code, 0, "{}", staged.stderr);
        assert!(staged.stdout.trim().is_empty(), "{}", staged.stdout);
        let status = git(&dir, &["status", "--porcelain"]);
        assert!(
            status.stdout.contains("?? sibling.txt"),
            "{}",
            status.stdout
        );
        assert!(
            !status.stdout.contains("?? project/inside.txt"),
            "{}",
            status.stdout
        );
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn run_git_drains_large_stdout_without_timeout() {
        // Prove piped wait drains concurrently: a 512KiB writer must finish well
        // under a multi-second timeout (old code deadlocked until timeout).
        use std::process::{Command, Stdio};
        use std::time::Instant;

        let mut child = if cfg!(windows) {
            Command::new("py")
                .args([
                    "-3",
                    "-c",
                    "import sys; sys.stdout.buffer.write(b'x'*512000); sys.stdout.buffer.flush()",
                ])
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .spawn()
                .expect("spawn py")
        } else {
            Command::new("python3")
                .args([
                    "-c",
                    "import sys; sys.stdout.buffer.write(b'x'*512000); sys.stdout.buffer.flush()",
                ])
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .spawn()
                .expect("spawn python3")
        };

        let stdout_pipe = child.stdout.take();
        let stderr_pipe = child.stderr.take();
        let out_handle = std::thread::spawn(move || {
            let mut buf = Vec::new();
            if let Some(mut out) = stdout_pipe {
                let _ = std::io::Read::read_to_end(&mut out, &mut buf);
            }
            buf
        });
        let err_handle = std::thread::spawn(move || {
            let mut buf = Vec::new();
            if let Some(mut err) = stderr_pipe {
                let _ = std::io::Read::read_to_end(&mut err, &mut buf);
            }
            buf
        });

        let start = Instant::now();
        let status = loop {
            match child.try_wait().expect("try_wait") {
                Some(status) => break status,
                None => {
                    assert!(
                        start.elapsed().as_millis() < 4000,
                        "large stdout stalled (pipe deadlock regression)"
                    );
                    std::thread::sleep(std::time::Duration::from_millis(20));
                }
            }
        };
        let stdout = out_handle.join().unwrap();
        let _ = err_handle.join();
        assert!(status.success(), "writer exit {status:?}");
        assert_eq!(stdout.len(), 512000);
        assert!(start.elapsed().as_millis() < 4000);
    }

    #[test]
    fn run_process_caps_captured_output() {
        let script = format!(
            "import sys; sys.stdout.buffer.write(b'x'*{}); sys.stdout.buffer.flush()",
            MAX_PROCESS_OUTPUT_BYTES + 100_000
        );
        let run = run_python(&script, 10_000).expect("run large writer");
        assert_eq!(run.exit_code, 0, "{}", run.stderr);
        assert!(run.stdout.len() <= MAX_PROCESS_OUTPUT_BYTES + 128);
        assert!(run.stdout.contains("output bytes omitted"));
    }

    #[test]
    fn run_process_timeout_does_not_wait_for_descendant_pipe() {
        let start = Instant::now();
        let error = run_python(
            "import subprocess,sys,time; subprocess.Popen([sys.executable,'-c','import time; time.sleep(2)'], stdout=sys.stdout, stderr=sys.stderr); time.sleep(2)",
            100,
        )
        .expect_err("process should time out");
        assert!(error.contains("timed out"), "{error}");
        assert!(start.elapsed() < Duration::from_millis(1_500));
    }

    #[test]
    fn split_diff_files() {
        let raw = "\
diff --git a/a.ts b/a.ts
--- a/a.ts
+++ b/a.ts
@@ -1 +1 @@
-old
+new
diff --git a/b.ts b/b.ts
--- a/b.ts
+++ b/b.ts
@@ -1 +1 @@
-x
+y
";
        let parts = split_unified_diff_by_file(raw);
        assert_eq!(parts.len(), 2);
        assert_eq!(parts[0].0, "a.ts");
        assert_eq!(parts[1].0, "b.ts");
    }

    #[test]
    fn split_diff_decodes_c_quoted_paths() {
        let raw = "diff --git \"a/a\\\" b.txt\" \"b/a\\\" b.txt\"\n\
--- \"a/a\\\" b.txt\"\n\
+++ \"b/a\\\" b.txt\"\n\
@@ -1 +1 @@\n\
-old\n\
+new\n";
        let parts = split_unified_diff_by_file(raw);
        assert_eq!(parts.len(), 1);
        assert_eq!(parts[0].0, "a\" b.txt");
    }
}
