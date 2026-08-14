//! Open a registered project folder in OS tools (Explorer, Terminal, Git Bash, WSL).

use crate::paths::require_registered_root;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::process::Command;
use tauri::AppHandle;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum OpenInTarget {
    Explorer,
    Terminal,
    GitBash,
    Wsl,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenInOption {
    pub id: OpenInTarget,
    pub label: String,
    pub available: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenInOptions {
    pub path: String,
    pub options: Vec<OpenInOption>,
}

fn which_on_path(name: &str) -> Option<PathBuf> {
    let Ok(path_var) = std::env::var("PATH") else {
        return None;
    };
    let exts: Vec<String> = if cfg!(windows) {
        std::env::var_os("PATHEXT")
            .map(|v| {
                v.to_string_lossy()
                    .split(';')
                    .filter(|s| !s.is_empty())
                    .map(|s| s.to_string())
                    .collect()
            })
            .unwrap_or_else(|| vec![".EXE".into(), ".CMD".into(), ".BAT".into()])
    } else {
        vec![String::new()]
    };

    for dir in std::env::split_paths(&path_var) {
        if cfg!(windows) {
            for ext in &exts {
                let candidate = if name.contains('.') {
                    dir.join(name)
                } else {
                    dir.join(format!("{name}{ext}"))
                };
                if candidate.is_file() {
                    return Some(candidate);
                }
            }
        } else {
            let candidate = dir.join(name);
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    None
}

#[cfg(windows)]
fn git_bash_candidates() -> Vec<PathBuf> {
    let mut out = Vec::new();
    if let Some(git) = which_on_path("git") {
        // .../Git/cmd/git.exe -> .../Git/git-bash.exe
        if let Some(cmd_dir) = git.parent() {
            if let Some(git_root) = cmd_dir.parent() {
                out.push(git_root.join("git-bash.exe"));
                out.push(git_root.join("bin").join("bash.exe"));
            }
        }
    }
    if let Ok(pf) = std::env::var("ProgramFiles") {
        out.push(PathBuf::from(pf).join("Git").join("git-bash.exe"));
    }
    if let Ok(pf86) = std::env::var("ProgramFiles(x86)") {
        out.push(PathBuf::from(pf86).join("Git").join("git-bash.exe"));
    }
    if let Ok(local) = std::env::var("LOCALAPPDATA") {
        out.push(
            PathBuf::from(local)
                .join("Programs")
                .join("Git")
                .join("git-bash.exe"),
        );
    }
    out
}

#[cfg(not(windows))]
fn git_bash_candidates() -> Vec<PathBuf> {
    Vec::new()
}

fn find_git_bash() -> Option<PathBuf> {
    git_bash_candidates()
        .into_iter()
        .find(|path| path.is_file())
}

fn terminal_available() -> bool {
    if cfg!(windows) {
        which_on_path("wt").is_some()
            || which_on_path("powershell").is_some()
            || which_on_path("pwsh").is_some()
            || which_on_path("cmd").is_some()
    } else {
        which_on_path("x-terminal-emulator").is_some()
            || which_on_path("gnome-terminal").is_some()
            || which_on_path("konsole").is_some()
            || which_on_path("xterm").is_some()
            || which_on_path("open").is_some() // macOS
    }
}

fn wsl_available() -> bool {
    if !cfg!(windows) {
        return false;
    }
    let Some(wsl) = which_on_path("wsl") else {
        return false;
    };
    // `wsl -l` fails when WSL is not installed.
    let mut cmd = Command::new(wsl);
    cmd.args(["-l", "-q"]);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    match cmd.output() {
        Ok(out) => out.status.success(),
        Err(_) => false,
    }
}

fn explorer_available() -> bool {
    if cfg!(windows) {
        which_on_path("explorer").is_some() || Path::new(r"C:\Windows\explorer.exe").is_file()
    } else if cfg!(target_os = "macos") {
        which_on_path("open").is_some()
    } else {
        which_on_path("xdg-open").is_some()
    }
}

fn build_options(root: &Path) -> OpenInOptions {
    let mut options = vec![
        OpenInOption {
            id: OpenInTarget::Explorer,
            label: if cfg!(target_os = "macos") {
                "Finder".into()
            } else if cfg!(windows) {
                "File Explorer".into()
            } else {
                "File Manager".into()
            },
            available: explorer_available(),
        },
        OpenInOption {
            id: OpenInTarget::Terminal,
            label: "Terminal".into(),
            available: terminal_available(),
        },
    ];

    if cfg!(windows) {
        options.push(OpenInOption {
            id: OpenInTarget::GitBash,
            label: "Git Bash".into(),
            available: find_git_bash().is_some(),
        });
        options.push(OpenInOption {
            id: OpenInTarget::Wsl,
            label: "WSL".into(),
            available: wsl_available(),
        });
    }

    OpenInOptions {
        path: root.to_string_lossy().to_string(),
        options,
    }
}

fn spawn_detached(mut cmd: Command) -> Result<(), String> {
    cmd.stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());
    cmd.spawn()
        .map(|_| ())
        .map_err(|e| format!("spawn failed: {e}"))
}

#[cfg(windows)]
fn open_explorer(root: &Path) -> Result<(), String> {
    let explorer = which_on_path("explorer").unwrap_or_else(|| PathBuf::from("explorer"));
    // `explorer <path>` opens the folder. Avoid `/select,` for directory roots.
    let mut cmd = Command::new(explorer);
    cmd.arg(root.as_os_str());
    spawn_detached(cmd)
}

#[cfg(target_os = "macos")]
fn open_explorer(root: &Path) -> Result<(), String> {
    let mut cmd = Command::new("open");
    cmd.arg(root.as_os_str());
    spawn_detached(cmd)
}

#[cfg(all(unix, not(target_os = "macos")))]
fn open_explorer(root: &Path) -> Result<(), String> {
    let mut cmd = Command::new("xdg-open");
    cmd.arg(root.as_os_str());
    spawn_detached(cmd)
}

#[cfg(windows)]
fn cmd_terminal_command(cmd_exe: PathBuf, root: &Path) -> Command {
    let mut cmd = Command::new(cmd_exe);
    cmd.arg("/K");
    cmd.current_dir(root);
    cmd
}

#[cfg(windows)]
fn open_terminal(root: &Path) -> Result<(), String> {
    if let Some(wt) = which_on_path("wt") {
        let mut cmd = Command::new(wt);
        cmd.args(["-d"]);
        cmd.arg(root.as_os_str());
        return spawn_detached(cmd);
    }
    if let Some(pwsh) = which_on_path("pwsh").or_else(|| which_on_path("powershell")) {
        let mut cmd = Command::new(pwsh);
        // Prefer -WorkingDirectory so path chars (e.g. ') never enter a -Command string.
        cmd.args(["-NoExit", "-WorkingDirectory"]);
        cmd.arg(root.as_os_str());
        return spawn_detached(cmd);
    }
    let cmd_exe = which_on_path("cmd").unwrap_or_else(|| PathBuf::from("cmd"));
    spawn_detached(cmd_terminal_command(cmd_exe, root))
}

#[cfg(target_os = "macos")]
fn open_terminal(root: &Path) -> Result<(), String> {
    let mut cmd = Command::new("open");
    cmd.args(["-a", "Terminal"]);
    cmd.arg(root.as_os_str());
    spawn_detached(cmd)
}

#[cfg(all(unix, not(target_os = "macos")))]
fn open_terminal(root: &Path) -> Result<(), String> {
    let path = root.to_string_lossy().to_string();
    let candidates: &[(&str, &[&str])] = &[
        ("x-terminal-emulator", &["--working-directory"]),
        ("gnome-terminal", &["--working-directory"]),
        ("konsole", &["--workdir"]),
        ("xterm", &["-e", "bash", "-lc"]),
    ];
    for (bin, args) in candidates {
        if which_on_path(bin).is_none() {
            continue;
        }
        let mut cmd = Command::new(bin);
        if *bin == "xterm" {
            cmd.args(args.iter().copied());
            cmd.arg(format!("cd {} && exec bash", shell_single_quote(&path)));
        } else {
            cmd.args(args.iter().copied());
            cmd.arg(&path);
        }
        return spawn_detached(cmd);
    }
    Err("No terminal emulator found".into())
}

#[cfg(unix)]
fn shell_single_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\"'\"'"))
}

#[cfg(windows)]
fn open_git_bash(root: &Path) -> Result<(), String> {
    let bash = find_git_bash().ok_or_else(|| "Git Bash not found".to_string())?;
    let is_git_bash = bash
        .file_name()
        .and_then(|n| n.to_str())
        .is_some_and(|n| n.eq_ignore_ascii_case("git-bash.exe"));
    let mut cmd = Command::new(&bash);
    // Prefer --cd= for git-bash.exe; bash.exe falls back to working_directory.
    if is_git_bash {
        cmd.arg(format!("--cd={}", root.display()));
    } else {
        cmd.current_dir(root);
    }
    spawn_detached(cmd)
}

#[cfg(not(windows))]
fn open_git_bash(_root: &Path) -> Result<(), String> {
    Err("Git Bash is only available on Windows".into())
}

#[cfg(windows)]
fn open_wsl(root: &Path) -> Result<(), String> {
    let wsl = which_on_path("wsl").ok_or_else(|| "WSL not found".to_string())?;
    let mut cmd = Command::new(wsl);
    // wsl --cd accepts Windows paths on modern WSL.
    cmd.args(["--cd"]);
    cmd.arg(root.as_os_str());
    spawn_detached(cmd)
}

#[cfg(not(windows))]
fn open_wsl(_root: &Path) -> Result<(), String> {
    Err("WSL is only available on Windows".into())
}

fn open_target(root: &Path, target: OpenInTarget) -> Result<(), String> {
    match target {
        OpenInTarget::Explorer => open_explorer(root),
        OpenInTarget::Terminal => open_terminal(root),
        OpenInTarget::GitBash => open_git_bash(root),
        OpenInTarget::Wsl => open_wsl(root),
    }
}

#[tauri::command]
pub fn project_open_in_options(app: AppHandle, path: String) -> Result<OpenInOptions, String> {
    let root = require_registered_root(&app, &path)?;
    Ok(build_options(&root))
}

#[tauri::command]
pub fn project_open_in(app: AppHandle, path: String, target: OpenInTarget) -> Result<(), String> {
    let root = require_registered_root(&app, &path)?;
    let opts = build_options(&root);
    let available = opts
        .options
        .iter()
        .find(|o| o.id == target)
        .map(|o| o.available)
        .unwrap_or(false);
    if !available {
        return Err(match target {
            OpenInTarget::Explorer => "File explorer is not available".into(),
            OpenInTarget::Terminal => "Terminal is not available".into(),
            OpenInTarget::GitBash => "Git Bash is not available".into(),
            OpenInTarget::Wsl => "WSL is not available".into(),
        });
    }
    open_target(&root, target)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn options_include_core_targets() {
        let opts = build_options(Path::new("."));
        let ids: Vec<_> = opts.options.iter().map(|o| o.id).collect();
        assert!(ids.contains(&OpenInTarget::Explorer));
        assert!(ids.contains(&OpenInTarget::Terminal));
        if cfg!(windows) {
            assert!(ids.contains(&OpenInTarget::GitBash));
            assert!(ids.contains(&OpenInTarget::Wsl));
        }
    }

    #[test]
    fn target_serde_roundtrip_names() {
        let raw = serde_json::to_string(&OpenInTarget::GitBash).unwrap();
        assert_eq!(raw, "\"gitBash\"");
        let back: OpenInTarget = serde_json::from_str(&raw).unwrap();
        assert_eq!(back, OpenInTarget::GitBash);
    }

    #[cfg(windows)]
    #[test]
    fn cmd_terminal_uses_process_cwd_without_command_text() {
        let root = Path::new(r"C:\safe & echo injected");
        let command = cmd_terminal_command(PathBuf::from("cmd.exe"), root);
        let args: Vec<_> = command.get_args().collect();
        assert_eq!(args, vec![std::ffi::OsStr::new("/K")]);
        assert_eq!(command.get_current_dir(), Some(root));
    }
}
