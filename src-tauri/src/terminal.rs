//! Interactive PTY sessions for the in-app terminal panel.

use crate::paths::require_registered_root;
use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::thread;
use tauri::{AppHandle, Emitter, State};

#[cfg(windows)]
use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
#[cfg(windows)]
use windows_sys::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
    SetInformationJobObject, TerminateJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
    JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
};

#[cfg(not(windows))]
use portable_pty::ChildKiller;

const MIN_COLS: u16 = 20;
const MIN_ROWS: u16 = 4;
const MAX_REPLAY_BYTES: usize = 256 * 1024;
/// One read per PTY output event. Larger chunks mean fewer IPC events under
/// heavy output (build logs, `cat`), which keeps the renderer smooth.
const READ_CHUNK_BYTES: usize = 64 * 1024;

#[cfg(windows)]
fn powershell_startup_command() -> &'static str {
    r#"[Console]::InputEncoding=[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; $global:__GrokOriginalPrompt=$function:prompt; function global:prompt { $value=& $global:__GrokOriginalPrompt; "$([char]27)]133;A$([char]7)$value$([char]27)]133;B$([char]7)" }"#
}

#[cfg(windows)]
type TerminalKiller = OwnedHandle;
#[cfg(not(windows))]
struct TerminalKiller {
    shell: Box<dyn ChildKiller + Send + Sync>,
    shell_process_group: i32,
}

struct TerminalSession {
    cwd: PathBuf,
    shell: String,
    master: Mutex<Box<dyn MasterPty + Send>>,
    writer: Mutex<Box<dyn Write + Send>>,
    killer: Mutex<TerminalKiller>,
    output: Mutex<TerminalReplay>,
}

struct SessionStore {
    entries: Mutex<HashMap<String, Arc<TerminalSession>>>,
}

impl Default for SessionStore {
    fn default() -> Self {
        Self {
            entries: Mutex::new(HashMap::new()),
        }
    }
}

#[derive(Default)]
struct TerminalReplay {
    data: String,
    sequence: u64,
}

#[derive(Default)]
pub struct TerminalManager {
    sessions: Arc<SessionStore>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalStartResult {
    pub session_id: String,
    pub shell: String,
    pub replay: String,
    pub replay_sequence: u64,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TerminalOutput {
    session_id: String,
    data: String,
    sequence: u64,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TerminalExit {
    session_id: String,
    exit_code: Option<u32>,
    error: Option<String>,
}

#[derive(Default)]
struct Utf8StreamDecoder {
    pending: Vec<u8>,
}

impl Utf8StreamDecoder {
    fn push(&mut self, bytes: &[u8]) -> String {
        self.pending.extend_from_slice(bytes);
        self.decode(false)
    }

    fn finish(&mut self) -> String {
        self.decode(true)
    }

    fn decode(&mut self, finish: bool) -> String {
        let bytes = std::mem::take(&mut self.pending);
        let mut remaining = bytes.as_slice();
        let mut output = String::new();
        loop {
            match std::str::from_utf8(remaining) {
                Ok(text) => {
                    output.push_str(text);
                    break;
                }
                Err(error) => {
                    let valid = error.valid_up_to();
                    output.push_str(std::str::from_utf8(&remaining[..valid]).unwrap_or_default());
                    remaining = &remaining[valid..];
                    match error.error_len() {
                        Some(length) => {
                            output.push('\u{FFFD}');
                            remaining = &remaining[length..];
                            if remaining.is_empty() {
                                break;
                            }
                        }
                        None => {
                            if finish {
                                output.push('\u{FFFD}');
                            } else {
                                self.pending.extend_from_slice(remaining);
                            }
                            break;
                        }
                    }
                }
            }
        }
        output
    }
}

impl TerminalManager {
    fn start(
        &self,
        app: AppHandle,
        session_id: String,
        cwd: PathBuf,
        cols: u16,
        rows: u16,
    ) -> Result<TerminalStartResult, String> {
        validate_session_id(&session_id)?;
        if !cwd.is_dir() {
            return Err("The terminal workspace is not a directory.".to_owned());
        }

        {
            let entries = self.sessions.entries.lock().map_err(|e| e.to_string())?;
            if let Some(existing) = entries.get(&session_id) {
                validate_terminal_workspace(&existing.cwd, &cwd)?;
                // Re-attach: the panel may have resized while detached; bring
                // the PTY to the requested size before replaying output.
                if let Ok(master) = existing.master.lock() {
                    let _ = master.resize(pty_size(cols, rows));
                }
                let replay = existing.output.lock().map_err(|e| e.to_string())?;
                return Ok(TerminalStartResult {
                    session_id,
                    shell: existing.shell.clone(),
                    replay: replay.data.clone(),
                    replay_sequence: replay.sequence,
                });
            }
        }

        let shell_path = resolve_default_shell()?;
        let shell_display = shell_path.display().to_string();
        let pair = native_pty_system()
            .openpty(pty_size(cols, rows))
            .map_err(|e| e.to_string())?;

        let mut command = CommandBuilder::new(&shell_path);
        command.cwd(&cwd);
        command.env("TERM", "xterm-256color");
        command.env("COLORTERM", "truecolor");
        #[cfg(windows)]
        {
            // Prefer UTF-8 for ConPTY-hosted shells when possible.
            command.env("LC_ALL", "C.UTF-8");
            command.env("LANG", "C.UTF-8");
            if shell_is_powershell(&shell_path) {
                // LC_ALL/LANG mean nothing to PowerShell; force the console
                // encodings so non-ASCII output arrives as UTF-8 instead of the
                // OEM codepage (which reads as mojibake through the UTF-8
                // decoder). Harmless on pwsh 7, required for Windows PowerShell.
                command.arg("-NoLogo");
                command.arg("-NoExit");
                command.arg("-Command");
                command.arg(powershell_startup_command());
            } else if shell_is_cmd(&shell_path) {
                // cmd.exe ignores LC_ALL/LANG; switch its console code page.
                command.arg("/K");
                command.arg("chcp 65001 >nul");
            }
        }
        #[cfg(not(windows))]
        {
            if shell_is_login_shell(&shell_path) {
                command.arg("-l");
            }
        }

        let mut child = pair
            .slave
            .spawn_command(command)
            .map_err(|e| e.to_string())?;
        drop(pair.slave);

        let killer = match create_terminal_killer(pair.master.as_ref(), child.as_ref()) {
            Ok(killer) => killer,
            Err(error) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(error);
            }
        };

        let reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
        let writer = pair.master.take_writer().map_err(|e| e.to_string())?;
        let session = Arc::new(TerminalSession {
            cwd,
            shell: shell_display.clone(),
            master: Mutex::new(pair.master),
            writer: Mutex::new(writer),
            killer: Mutex::new(killer),
            output: Mutex::new(TerminalReplay::default()),
        });

        {
            let mut entries = self.sessions.entries.lock().map_err(|e| e.to_string())?;
            if entries.contains_key(&session_id) {
                // Race: another start won — kill ours and return existing replay.
                if let (Ok(master), Ok(mut killer)) = (session.master.lock(), session.killer.lock())
                {
                    let _ = kill_terminal(&mut killer, master.as_ref());
                }
                let existing = entries.get(&session_id).expect("checked contains");
                validate_terminal_workspace(&existing.cwd, &session.cwd)?;
                let replay = existing.output.lock().map_err(|e| e.to_string())?;
                return Ok(TerminalStartResult {
                    session_id,
                    shell: existing.shell.clone(),
                    replay: replay.data.clone(),
                    replay_sequence: replay.sequence,
                });
            }
            entries.insert(session_id.clone(), Arc::clone(&session));
        }

        let mut child = child;
        let output_app = app.clone();
        let output_session_id = session_id.clone();
        let output_session = Arc::clone(&session);
        let output_sessions = Arc::clone(&self.sessions);
        let output_handle = thread::spawn(move || {
            let mut buffer = vec![0_u8; READ_CHUNK_BYTES];
            let mut decoder = Utf8StreamDecoder::default();
            let mut reader = reader;
            loop {
                match reader.read(&mut buffer) {
                    Ok(0) => break,
                    Ok(read) => {
                        let data = decoder.push(&buffer[..read]);
                        if data.is_empty() {
                            continue;
                        }
                        let Some(output) = emit_output_if_current(
                            &output_sessions,
                            &output_session_id,
                            &output_session,
                            data,
                        ) else {
                            break;
                        };
                        let _ = output_app.emit("terminal://output", output);
                    }
                    Err(_) => break,
                }
            }
            let data = decoder.finish();
            if !data.is_empty() {
                if let Some(output) = emit_output_if_current(
                    &output_sessions,
                    &output_session_id,
                    &output_session,
                    data,
                ) {
                    let _ = output_app.emit("terminal://output", output);
                }
            }
        });

        let sessions = Arc::clone(&self.sessions);
        let exit_session_id = session_id.clone();
        let exit_session = Arc::clone(&session);
        thread::spawn(move || {
            let result = child.wait();
            let _ = output_handle.join();
            let should_emit = finish_session(&sessions, &exit_session_id, &exit_session);
            let (exit_code, error) = match result {
                Ok(status) => (Some(status.exit_code()), None),
                Err(error) => (None, Some(error.to_string())),
            };
            if should_emit {
                let _ = app.emit(
                    "terminal://exit",
                    TerminalExit {
                        session_id: exit_session_id,
                        exit_code,
                        error,
                    },
                );
            }
        });

        Ok(TerminalStartResult {
            session_id,
            shell: shell_display,
            replay: String::new(),
            replay_sequence: 0,
        })
    }

    fn write(&self, session_id: &str, data: &str) -> Result<(), String> {
        let session = self.session(session_id)?;
        let mut writer = session.writer.lock().map_err(|e| e.to_string())?;
        writer
            .write_all(data.as_bytes())
            .and_then(|_| writer.flush())
            .map_err(|e| e.to_string())
    }

    fn resize(&self, session_id: &str, cols: u16, rows: u16) -> Result<(), String> {
        let session = self.session(session_id)?;
        let master = session.master.lock().map_err(|e| e.to_string())?;
        master
            .resize(pty_size(cols, rows))
            .map_err(|e| e.to_string())
    }

    fn stop(&self, session_id: &str) -> Result<(), String> {
        let session = self
            .sessions
            .entries
            .lock()
            .map_err(|e| e.to_string())?
            .get(session_id)
            .cloned();
        if let Some(session) = session {
            let master = session.master.lock().map_err(|e| e.to_string())?;
            let mut killer = session.killer.lock().map_err(|e| e.to_string())?;
            kill_terminal(&mut killer, master.as_ref())?;
            drop(killer);
            drop(master);
        }
        Ok(())
    }

    fn session(&self, session_id: &str) -> Result<Arc<TerminalSession>, String> {
        self.sessions
            .entries
            .lock()
            .map_err(|e| e.to_string())?
            .get(session_id)
            .cloned()
            .ok_or_else(|| "The terminal session is no longer running.".to_owned())
    }
}

fn validate_terminal_workspace(existing: &Path, requested: &Path) -> Result<(), String> {
    if existing == requested {
        Ok(())
    } else {
        Err("This terminal session is bound to a different workspace path.".to_owned())
    }
}

impl Drop for TerminalManager {
    fn drop(&mut self) {
        if let Ok(mut sessions) = self.sessions.entries.lock() {
            for (_, session) in sessions.drain() {
                if let (Ok(master), Ok(mut killer)) = (session.master.lock(), session.killer.lock())
                {
                    let _ = kill_terminal(&mut killer, master.as_ref());
                }
            }
        }
    }
}

fn emit_output_if_current(
    store: &SessionStore,
    session_id: &str,
    session: &Arc<TerminalSession>,
    data: String,
) -> Option<TerminalOutput> {
    let entries = store.entries.lock().ok()?;
    let current = entries.get(session_id)?;
    if !Arc::ptr_eq(current, session) {
        return None;
    }
    let sequence = record_terminal_output(&session.output, &data);
    Some(TerminalOutput {
        session_id: session_id.to_owned(),
        data,
        sequence,
    })
}

fn finish_session(store: &SessionStore, session_id: &str, session: &Arc<TerminalSession>) -> bool {
    let Ok(mut entries) = store.entries.lock() else {
        return true;
    };
    match entries.get(session_id) {
        Some(current) if Arc::ptr_eq(current, session) => {
            entries.remove(session_id);
            true
        }
        Some(_) => false,
        None => true,
    }
}

fn record_terminal_output(output: &Mutex<TerminalReplay>, data: &str) -> u64 {
    let Ok(mut replay) = output.lock() else {
        return 0;
    };
    replay.sequence = replay.sequence.saturating_add(1);
    replay.data.push_str(data);
    if replay.data.len() > MAX_REPLAY_BYTES {
        let mut keep_from = replay.data.len() - MAX_REPLAY_BYTES;
        while !replay.data.is_char_boundary(keep_from) {
            keep_from += 1;
        }
        replay.data.drain(..keep_from);
    }
    replay.sequence
}

fn resolve_default_shell() -> Result<PathBuf, String> {
    #[cfg(windows)]
    {
        for name in ["pwsh.exe", "pwsh", "powershell.exe", "powershell"] {
            if let Some(p) = which_on_path(name) {
                return Ok(p);
            }
        }
        if let Ok(system_root) = std::env::var("SystemRoot") {
            let ps = PathBuf::from(&system_root)
                .join("System32")
                .join("WindowsPowerShell")
                .join("v1.0")
                .join("powershell.exe");
            if ps.is_file() {
                return Ok(ps);
            }
        }
        if let Ok(comspec) = std::env::var("ComSpec") {
            let p = PathBuf::from(comspec);
            if p.is_file() {
                return Ok(p);
            }
        }
        Err("No system shell is available (pwsh/powershell/cmd).".to_owned())
    }
    #[cfg(not(windows))]
    {
        if let Ok(shell) = std::env::var("SHELL") {
            let p = PathBuf::from(&shell);
            if p.is_file() {
                return Ok(p);
            }
        }
        for candidate in ["/bin/zsh", "/bin/bash", "/bin/sh"] {
            let p = PathBuf::from(candidate);
            if p.is_file() {
                return Ok(p);
            }
        }
        Err("No system shell is available.".to_owned())
    }
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
fn shell_is_powershell(path: &Path) -> bool {
    path.file_name()
        .and_then(|n| n.to_str())
        .map(|n| {
            let lower = n.to_ascii_lowercase();
            lower == "pwsh.exe"
                || lower == "pwsh"
                || lower == "powershell.exe"
                || lower == "powershell"
        })
        .unwrap_or(false)
}

#[cfg(windows)]
fn shell_is_cmd(path: &Path) -> bool {
    path.file_name()
        .and_then(|n| n.to_str())
        .map(|n| {
            let lower = n.to_ascii_lowercase();
            lower == "cmd.exe" || lower == "cmd"
        })
        .unwrap_or(false)
}

#[cfg(not(windows))]
fn shell_is_login_shell(path: &Path) -> bool {
    path.file_name()
        .and_then(|n| n.to_str())
        .map(|n| matches!(n, "bash" | "zsh" | "sh" | "fish"))
        .unwrap_or(false)
}

#[cfg(windows)]
fn create_terminal_killer(
    _master: &dyn MasterPty,
    child: &dyn portable_pty::Child,
) -> Result<TerminalKiller, String> {
    let process = child
        .as_raw_handle()
        .ok_or_else(|| "The terminal process handle is unavailable.".to_owned())?;
    let raw_job = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
    if raw_job.is_null() {
        return Err(std::io::Error::last_os_error().to_string());
    }
    let job = unsafe { OwnedHandle::from_raw_handle(raw_job) };
    let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
    limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    if unsafe {
        SetInformationJobObject(
            job.as_raw_handle(),
            JobObjectExtendedLimitInformation,
            &limits as *const _ as *const std::ffi::c_void,
            std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
        )
    } == 0
    {
        return Err(std::io::Error::last_os_error().to_string());
    }
    if unsafe { AssignProcessToJobObject(job.as_raw_handle(), process) } == 0 {
        return Err(std::io::Error::last_os_error().to_string());
    }
    Ok(job)
}

#[cfg(not(windows))]
fn create_terminal_killer(
    master: &dyn MasterPty,
    child: &dyn portable_pty::Child,
) -> Result<TerminalKiller, String> {
    let shell_process_group = master
        .process_group_leader()
        .ok_or_else(|| "The terminal process group is unavailable.".to_owned())?;
    Ok(TerminalKiller {
        shell: child.clone_killer(),
        shell_process_group,
    })
}

#[cfg(windows)]
fn kill_terminal(killer: &mut TerminalKiller, _master: &dyn MasterPty) -> Result<(), String> {
    if unsafe { TerminateJobObject(killer.as_raw_handle(), 1) } == 0 {
        Err(std::io::Error::last_os_error().to_string())
    } else {
        Ok(())
    }
}

#[cfg(not(windows))]
fn kill_terminal(killer: &mut TerminalKiller, master: &dyn MasterPty) -> Result<(), String> {
    let mut foreground_error = None;
    if let Some(foreground) = master.process_group_leader() {
        if foreground != killer.shell_process_group
            && unsafe { libc::kill(-foreground, libc::SIGKILL) } != 0
        {
            let error = std::io::Error::last_os_error();
            if error.raw_os_error() != Some(libc::ESRCH) {
                foreground_error = Some(error.to_string());
            }
        }
    }
    killer.shell.kill().map_err(|e| e.to_string())?;
    if let Some(error) = foreground_error {
        return Err(error);
    }
    Ok(())
}

fn pty_size(cols: u16, rows: u16) -> PtySize {
    PtySize {
        cols: cols.max(MIN_COLS),
        rows: rows.max(MIN_ROWS),
        pixel_width: 0,
        pixel_height: 0,
    }
}

fn validate_session_id(session_id: &str) -> Result<(), String> {
    if session_id.len() > 64
        || session_id.is_empty()
        || !session_id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        return Err("Invalid terminal session id.".to_owned());
    }
    Ok(())
}

#[tauri::command]
pub fn terminal_start(
    app: AppHandle,
    manager: State<'_, TerminalManager>,
    session_id: String,
    cwd: String,
    cols: u16,
    rows: u16,
) -> Result<TerminalStartResult, String> {
    let root = require_registered_root(&app, &cwd)?;
    manager.start(app, session_id, root, cols, rows)
}

#[tauri::command]
pub fn terminal_write(
    manager: State<'_, TerminalManager>,
    session_id: String,
    data: String,
) -> Result<(), String> {
    if data.len() > 65_536 {
        return Err("Terminal write exceeds 64 KiB.".to_owned());
    }
    manager.write(&session_id, &data)
}

#[tauri::command]
pub fn terminal_resize(
    manager: State<'_, TerminalManager>,
    session_id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    manager.resize(&session_id, cols, rows)
}

#[tauri::command]
pub fn terminal_stop(
    manager: State<'_, TerminalManager>,
    session_id: String,
) -> Result<(), String> {
    manager.stop(&session_id)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn terminal_sizes_have_safe_minimums() {
        let size = pty_size(0, 0);
        assert_eq!(size.cols, MIN_COLS);
        assert_eq!(size.rows, MIN_ROWS);
    }

    #[test]
    fn terminal_session_ids_are_restricted() {
        assert!(validate_session_id("term-1").is_ok());
        assert!(validate_session_id("ws_abc-1").is_ok());
        assert!(validate_session_id("../term").is_err());
        assert!(validate_session_id("").is_err());
    }

    #[test]
    fn terminal_race_winner_must_match_requested_workspace() {
        assert!(validate_terminal_workspace(Path::new("one"), Path::new("one")).is_ok());
        assert!(validate_terminal_workspace(Path::new("one"), Path::new("two")).is_err());
    }

    #[test]
    fn utf8_decoder_handles_split_multibyte() {
        let mut dec = Utf8StreamDecoder::default();
        // € is e2 82 ac
        let a = dec.push(&[0xe2]);
        assert!(a.is_empty());
        let b = dec.push(&[0x82, 0xac]);
        assert_eq!(b, "€");
    }

    #[cfg(windows)]
    #[test]
    fn powershell_profiles_remain_enabled_and_prompt_gets_shell_marker() {
        let command = powershell_startup_command();
        assert!(command.contains("$function:prompt"));
        assert!(command.contains("]133;A"));
        assert!(command.contains("]133;B"));
    }
}
