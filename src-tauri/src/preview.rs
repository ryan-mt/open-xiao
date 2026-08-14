//! Isolated native browser surface for HTTP and HTTPS pages.

use crate::paths::require_registered_root;
use base64::Engine;
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::net::{IpAddr, SocketAddr, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;
use tauri::webview::{NewWindowResponse, PageLoadEvent, WebviewBuilder};
use tauri::{AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, Webview, WebviewUrl};
use tauri_plugin_opener::OpenerExt;
use url::{Host, Url};

use crate::agent_tools::{AgentToolImage, AgentToolResult};

const PREVIEW_LABEL: &str = "browser-preview";
const PREVIEW_STATE_EVENT: &str = "preview://state";
const PREVIEW_BLOCKED_EVENT: &str = "preview://blocked-navigation";
const MAX_PREVIEW_CALLBACK_BYTES: usize = 2 * 1024 * 1024;
const MAX_PREVIEW_RESULT_CHARS: usize = 32_000;
const MAX_PREVIEW_RESULT_NODES: usize = 512;
const COMMON_DEV_PORTS: &[u16] = &[
    3000, 3001, 3333, 4173, 4200, 4321, 5000, 5173, 5174, 5175, 5500, 8000, 8080, 8081, 8888, 9000,
];

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewBounds {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}

impl PreviewBounds {
    fn validate(self) -> Result<Self, String> {
        if !self.x.is_finite()
            || !self.y.is_finite()
            || !self.width.is_finite()
            || !self.height.is_finite()
            || self.width < 1.0
            || self.height < 1.0
        {
            return Err("Preview bounds must be finite and have a positive size.".into());
        }
        Ok(self)
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewSnapshot {
    session_id: u64,
    workspace_path: String,
    url: String,
    title: Option<String>,
    loading: bool,
    can_go_back: bool,
    can_go_forward: bool,
    visible: bool,
}

#[derive(Debug)]
pub struct AgentPreviewSnapshot {
    pub text: String,
    pub data_url: String,
    pub mime: String,
    pub label: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewCapture {
    data_url: String,
    mime: String,
    label: String,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct PreviewInteractiveElement {
    tag: String,
    role: Option<String>,
    name: String,
    selector: String,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct PreviewPageMetadata {
    url: String,
    title: String,
    loading: bool,
    visible_text: String,
    interactive_elements: Vec<PreviewInteractiveElement>,
}

#[cfg(windows)]
const PREVIEW_METADATA_SCRIPT: &str = r##"(() => {
  const selectorFor = (element) => {
    if (element.id) return "#" + CSS.escape(element.id.slice(0, 510));
    for (const attribute of ["data-testid", "name"]) {
      const value = element.getAttribute(attribute)?.slice(0, 480);
      if (value) return element.tagName.toLowerCase() + "[" + attribute + "=" + JSON.stringify(value) + "]";
    }
    const parts = [];
    let current = element;
    while (current && current.nodeType === Node.ELEMENT_NODE && parts.length < 8) {
      const parent = current.parentElement;
      const siblings = parent
        ? Array.from(parent.children).filter((child) => child.tagName === current.tagName)
        : [];
      const base = current.tagName.toLowerCase();
      parts.unshift(siblings.length > 1
        ? base + ":nth-of-type(" + (siblings.indexOf(current) + 1) + ")"
        : base);
      current = parent;
    }
    return parts.join(" > ");
  };
  const visible = (element) => {
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0;
  };
  return {
    url: location.href.slice(0, 4096),
    title: (document.title || "").slice(0, 512),
    loading: document.readyState !== "complete",
    visibleText: (document.body?.innerText || "").slice(0, 20000),
    interactiveElements: Array.from(document.querySelectorAll(
      "a[href],button,input,textarea,select,[role],[tabindex]"
    )).filter(visible).slice(0, 150).map((element) => {
      const rect = element.getBoundingClientRect();
      return {
        tag: element.tagName.toLowerCase().slice(0, 64),
        role: element.getAttribute("role")?.slice(0, 64) || null,
        name: (element.getAttribute("aria-label") || element.innerText || element.getAttribute("name") || "").slice(0, 256),
        selector: selectorFor(element).slice(0, 512),
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height
      };
    })
  };
})()"##;

fn parse_preview_callback_json<T: serde::de::DeserializeOwned>(
    result: &str,
    label: &str,
) -> Result<T, String> {
    if result.len() > MAX_PREVIEW_CALLBACK_BYTES {
        return Err(format!(
            "{label} exceeded the {} MB safety limit",
            MAX_PREVIEW_CALLBACK_BYTES / (1024 * 1024)
        ));
    }
    serde_json::from_str(result).map_err(|error| format!("{label} was invalid JSON: {error}"))
}

fn bounded_preview_evaluation(expression: &str) -> String {
    format!(
        r#"(async () => {{
  const value = await (
{expression}
  );
  let remainingChars = {MAX_PREVIEW_RESULT_CHARS};
  let remainingNodes = {MAX_PREVIEW_RESULT_NODES};
  const seen = new WeakSet();
  const takeText = (input) => {{
    const text = String(input);
    const length = Math.min(text.length, remainingChars);
    remainingChars -= length;
    return text.slice(0, length);
  }};
  const project = (input, depth) => {{
    if (input === null || typeof input === "boolean" || typeof input === "number") return input;
    if (typeof input === "string") return takeText(input);
    if (typeof input === "undefined") return "[undefined]";
    if (typeof input === "bigint" || typeof input === "symbol") return takeText(input);
    if (typeof input === "function") return "[function]";
    if (remainingNodes-- <= 0 || depth >= 6) return "[truncated]";
    if (seen.has(input)) return "[circular]";
    seen.add(input);
    if (Array.isArray(input)) {{
      return input.slice(0, 100).map((item) => project(item, depth + 1));
    }}
    const output = {{}};
    let keys;
    try {{
      keys = Object.keys(input).slice(0, 100);
    }} catch (_) {{
      return "[unavailable]";
    }}
    for (const key of keys) {{
      if (remainingChars <= 0 || remainingNodes <= 0) break;
      const boundedKey = takeText(key);
      try {{
        output[boundedKey] = project(input[key], depth + 1);
      }} catch (_) {{
        output[boundedKey] = "[unavailable]";
      }}
    }}
    return output;
  }};
  return project(value, 0);
}})()"#
    )
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscoveredLocalServer {
    port: u16,
    url: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct BlockedNavigation {
    session_id: u64,
    workspace_path: String,
    url: String,
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PreviewAction {
    Back,
    Forward,
    Reload,
}

#[derive(Clone)]
struct HistoryCheckpoint {
    history: Vec<String>,
    history_index: usize,
    snapshot_url: String,
    loading: bool,
}

enum NavigationIntent {
    Push,
    Traverse { target_index: usize },
    Reload { index: usize },
}

struct PendingNavigation {
    intent: NavigationIntent,
    checkpoint: HistoryCheckpoint,
    candidate_url: String,
}

#[derive(Default)]
struct PreviewRuntime {
    generation: u64,
    workspace: Option<PathBuf>,
    snapshot: Option<PreviewSnapshot>,
    approved_origins: HashSet<String>,
    history: Vec<String>,
    history_index: usize,
    pending_navigation: Option<PendingNavigation>,
}

impl PreviewRuntime {
    fn approve_url(&mut self, url: &Url) {
        if let Some(origin) = preview_origin(url) {
            self.approved_origins.insert(origin);
        }
    }

    fn allows_url(&self, url: &Url) -> bool {
        preview_origin(url).is_some_and(|origin| self.approved_origins.contains(&origin))
    }

    fn checkpoint(&self) -> HistoryCheckpoint {
        HistoryCheckpoint {
            history: self.history.clone(),
            history_index: self.history_index,
            snapshot_url: self
                .snapshot
                .as_ref()
                .map(|snapshot| snapshot.url.clone())
                .unwrap_or_default(),
            loading: self
                .snapshot
                .as_ref()
                .is_some_and(|snapshot| snapshot.loading),
        }
    }

    fn begin_push(&mut self, url: &str) {
        self.pending_navigation = Some(PendingNavigation {
            intent: NavigationIntent::Push,
            checkpoint: self.checkpoint(),
            candidate_url: url.to_string(),
        });
        self.set_navigation_snapshot(url, true);
    }

    fn begin_reload(&mut self) {
        let Some(url) = self.history.get(self.history_index).cloned() else {
            return;
        };
        self.pending_navigation = Some(PendingNavigation {
            intent: NavigationIntent::Reload {
                index: self.history_index,
            },
            checkpoint: self.checkpoint(),
            candidate_url: url.clone(),
        });
        self.set_navigation_snapshot(&url, true);
    }

    fn begin_traverse(&mut self, delta: isize) -> bool {
        let next = self.history_index as isize + delta;
        if next < 0 || next >= self.history.len() as isize {
            return false;
        }
        let target_index = next as usize;
        let target_url = self.history[target_index].clone();
        self.pending_navigation = Some(PendingNavigation {
            intent: NavigationIntent::Traverse { target_index },
            checkpoint: self.checkpoint(),
            candidate_url: target_url.clone(),
        });
        self.history_index = target_index;
        self.set_navigation_snapshot(&target_url, true);
        self.sync_history_flags();
        true
    }

    fn observe_navigation(&mut self, url: &str, loading: bool, finished: bool) {
        if self.pending_navigation.is_none() {
            if self
                .history
                .get(self.history_index)
                .is_some_and(|current| current == url)
            {
                self.begin_reload();
            } else {
                self.begin_push(url);
            }
        }
        if let Some(pending) = self.pending_navigation.as_mut() {
            pending.candidate_url = url.to_string();
        }
        self.set_navigation_snapshot(url, loading);
        if finished {
            self.commit_navigation();
        }
    }

    fn commit_navigation(&mut self) {
        let Some(pending) = self.pending_navigation.take() else {
            return;
        };
        let url = pending.candidate_url;
        match pending.intent {
            NavigationIntent::Push => {
                self.history
                    .truncate(pending.checkpoint.history_index.saturating_add(1));
                if self.history.last().is_none_or(|current| current != &url) {
                    self.history.push(url.clone());
                }
                self.history_index = self.history.len().saturating_sub(1);
            }
            NavigationIntent::Traverse { target_index } => {
                if let Some(entry) = self.history.get_mut(target_index) {
                    *entry = url.clone();
                    self.history_index = target_index;
                }
            }
            NavigationIntent::Reload { index } => {
                if let Some(entry) = self.history.get_mut(index) {
                    *entry = url.clone();
                    self.history_index = index;
                }
            }
        }
        self.set_navigation_snapshot(&url, false);
        self.sync_history_flags();
    }

    fn rollback_navigation(&mut self) {
        let Some(pending) = self.pending_navigation.take() else {
            return;
        };
        self.history = pending.checkpoint.history;
        self.history_index = pending.checkpoint.history_index;
        if let Some(snapshot) = self.snapshot.as_mut() {
            snapshot.url = pending.checkpoint.snapshot_url;
            snapshot.loading = pending.checkpoint.loading;
        }
        self.sync_history_flags();
    }

    fn sync_current_url(&mut self, url: &str) {
        if let Some(pending) = self.pending_navigation.as_mut() {
            pending.candidate_url = url.to_string();
            self.set_navigation_snapshot(url, true);
            return;
        }
        if let Some(entry) = self.history.get_mut(self.history_index) {
            *entry = url.to_string();
        }
        self.set_navigation_snapshot(url, false);
        self.sync_history_flags();
    }

    fn set_navigation_snapshot(&mut self, url: &str, loading: bool) {
        if let Some(snapshot) = self.snapshot.as_mut() {
            snapshot.url = url.to_string();
            snapshot.loading = loading;
        }
    }

    fn sync_history_flags(&mut self) {
        if let Some(snapshot) = self.snapshot.as_mut() {
            snapshot.can_go_back = self.history_index > 0;
            snapshot.can_go_forward = self.history_index + 1 < self.history.len();
        }
    }
}

#[derive(Default)]
pub struct PreviewManager {
    lifecycle: Mutex<()>,
    inner: Mutex<PreviewRuntime>,
}

fn lock_runtime(
    manager: &PreviewManager,
) -> Result<std::sync::MutexGuard<'_, PreviewRuntime>, String> {
    manager
        .inner
        .lock()
        .map_err(|_| "Browser preview state is unavailable.".to_string())
}

fn require_main_webview(caller: &Webview) -> Result<(), String> {
    if caller.label() != "main" {
        return Err("Browser preview commands are only available to the main app.".into());
    }
    Ok(())
}

fn normalize_preview_url(raw: &str) -> Result<Url, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err("Enter a URL.".into());
    }
    let candidate = if trimmed.contains("://") {
        trimmed.to_string()
    } else {
        let lower = trimmed.to_ascii_lowercase();
        let loopback = ["localhost", "127.0.0.1", "0.0.0.0", "[::1]", "[::]"]
            .iter()
            .any(|host| {
                lower == *host
                    || lower.starts_with(&format!("{host}:"))
                    || lower.starts_with(&format!("{host}/"))
            });
        format!("{}://{trimmed}", if loopback { "http" } else { "https" })
    };
    let mut url = Url::parse(&candidate).map_err(|_| "Enter a valid URL.".to_string())?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err("Preview URLs must use HTTP or HTTPS.".into());
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err("Preview URLs cannot contain credentials.".into());
    }
    if url.host_str() == Some("0.0.0.0") {
        url.set_host(Some("127.0.0.1"))
            .map_err(|_| "Could not normalize the preview host.".to_string())?;
    } else if matches!(url.host(), Some(Host::Ipv6(address)) if address.is_unspecified()) {
        url.set_host(Some("[::1]"))
            .map_err(|_| "Could not normalize the preview host.".to_string())?;
    }
    Ok(url)
}

fn is_allowed_preview_navigation(url: &Url) -> bool {
    matches!(url.scheme(), "http" | "https")
        && url.username().is_empty()
        && url.password().is_none()
}

fn preview_origin(url: &Url) -> Option<String> {
    is_allowed_preview_navigation(url).then(|| url.origin().ascii_serialization())
}

fn runtime_allows_navigation(app: &AppHandle, generation: u64, url: &Url) -> bool {
    if !is_allowed_preview_navigation(url) {
        return false;
    }
    let manager = app.state::<PreviewManager>();
    manager
        .inner
        .lock()
        .ok()
        .is_some_and(|runtime| runtime.generation == generation && runtime.allows_url(url))
}

fn require_agent_approved_url(app: &AppHandle, workspace: &Path, raw: &str) -> Result<Url, String> {
    let url = normalize_preview_url(raw)?;
    let manager = app.state::<PreviewManager>();
    let runtime = lock_runtime(&manager)?;
    let workspace_matches = runtime
        .workspace
        .as_ref()
        .is_some_and(|active| workspace_identity(active) == workspace_identity(workspace));
    if !workspace_matches || runtime.snapshot.is_none() {
        return Err("No browser preview is open for this workspace".into());
    }
    if !runtime.allows_url(&url) {
        return Err(
            "This preview origin has not been approved. Open it in Browser Preview first.".into(),
        );
    }
    Ok(url)
}

fn workspace_identity(path: &Path) -> String {
    let value = path.to_string_lossy().replace('\\', "/");
    if cfg!(windows) {
        value.to_ascii_lowercase()
    } else {
        value
    }
}

fn emit_snapshot(app: &AppHandle, snapshot: &PreviewSnapshot) {
    let _ = app.emit_to("main", PREVIEW_STATE_EVENT, snapshot.clone());
}

fn update_snapshot(app: &AppHandle, generation: u64, update: impl FnOnce(&mut PreviewRuntime)) {
    let manager = app.state::<PreviewManager>();
    let snapshot = {
        let Ok(mut runtime) = manager.inner.lock() else {
            return;
        };
        if runtime.generation != generation {
            return;
        }
        update(&mut runtime);
        runtime.snapshot.clone()
    };
    if let Some(snapshot) = snapshot {
        emit_snapshot(app, &snapshot);
    }
}

fn current_session(
    app: &AppHandle,
    caller: &Webview,
    workspace_path: &str,
    session_id: u64,
    require_registered: bool,
) -> Result<(Webview, PathBuf), String> {
    require_main_webview(caller)?;
    let workspace = if require_registered {
        require_registered_root(app, workspace_path)?
    } else {
        PathBuf::from(workspace_path.trim())
    };
    let manager = app.state::<PreviewManager>();
    let runtime = lock_runtime(&manager)?;
    let workspace_matches = runtime
        .workspace
        .as_ref()
        .is_some_and(|active| workspace_identity(active) == workspace_identity(&workspace));
    if runtime.generation != session_id || !workspace_matches || runtime.snapshot.is_none() {
        return Err("No browser preview is open for this workspace.".into());
    }
    drop(runtime);
    let Some(webview) = app.get_webview(PREVIEW_LABEL) else {
        let mut runtime = lock_runtime(&manager)?;
        if runtime.generation == session_id {
            runtime.generation = runtime.generation.wrapping_add(1);
            runtime.workspace = None;
            runtime.snapshot = None;
            runtime.approved_origins.clear();
            runtime.history.clear();
            runtime.history_index = 0;
            runtime.pending_navigation = None;
        }
        return Err("The browser preview stopped and can be reopened.".into());
    };
    Ok((webview, workspace))
}

pub(crate) fn close_workspace_if_active(app: &AppHandle, workspace: &Path) {
    let manager = app.state::<PreviewManager>();
    let Ok(_lifecycle) = manager.lifecycle.lock() else {
        return;
    };
    let should_close = {
        let Ok(mut runtime) = manager.inner.lock() else {
            return;
        };
        let matches = runtime
            .workspace
            .as_ref()
            .is_some_and(|active| workspace_identity(active) == workspace_identity(workspace));
        if matches {
            runtime.generation = runtime.generation.wrapping_add(1);
            runtime.workspace = None;
            runtime.snapshot = None;
            runtime.approved_origins.clear();
            runtime.history.clear();
            runtime.history_index = 0;
            runtime.pending_navigation = None;
        }
        matches
    };
    if should_close {
        if let Some(webview) = app.get_webview(PREVIEW_LABEL) {
            let _ = webview.close();
        }
    }
}

fn set_webview_bounds(webview: &Webview, bounds: PreviewBounds) -> Result<(), String> {
    let bounds = bounds.validate()?;
    webview
        .set_position(LogicalPosition::new(bounds.x, bounds.y))
        .map_err(|error| format!("Could not position browser preview: {error}"))?;
    webview
        .set_size(LogicalSize::new(bounds.width, bounds.height))
        .map_err(|error| format!("Could not resize browser preview: {error}"))
}

#[cfg(windows)]
type FinishSender<T> =
    std::sync::Arc<std::sync::Mutex<Option<tokio::sync::oneshot::Sender<Result<T, String>>>>>;

#[cfg(windows)]
fn finish_once<T>(sender: &FinishSender<T>, result: Result<T, String>) {
    if let Ok(mut guard) = sender.lock() {
        if let Some(sender) = guard.take() {
            let _ = sender.send(result);
        }
    }
}

#[cfg(windows)]
unsafe fn read_preview_stream(
    stream: &windows::Win32::System::Com::IStream,
) -> Result<Vec<u8>, String> {
    use windows::Win32::System::Com::{STATFLAG_NONAME, STATSTG, STREAM_SEEK_SET};

    let mut stat: STATSTG = unsafe { std::mem::zeroed() };
    unsafe { stream.Stat(&mut stat, STATFLAG_NONAME) }
        .map_err(|error| format!("Could not size browser preview screenshot: {error}"))?;
    let size = usize::try_from(stat.cbSize)
        .map_err(|_| "Browser preview screenshot is too large".to_string())?;
    if size == 0 || size > 12 * 1024 * 1024 {
        return Err("Browser preview screenshot is empty or exceeds 12 MB".into());
    }
    unsafe { stream.Seek(0, STREAM_SEEK_SET, None) }
        .map_err(|error| format!("Could not rewind browser preview screenshot: {error}"))?;

    let mut bytes = vec![0_u8; size];
    let mut offset = 0_usize;
    while offset < size {
        let chunk = (size - offset).min(u32::MAX as usize) as u32;
        let mut read = 0_u32;
        unsafe { stream.Read(bytes[offset..].as_mut_ptr().cast(), chunk, Some(&mut read)) }
            .ok()
            .map_err(|error| format!("Could not read browser preview screenshot: {error}"))?;
        if read == 0 {
            break;
        }
        offset += read as usize;
    }
    bytes.truncate(offset);
    if bytes.len() < 24 || &bytes[..8] != b"\x89PNG\r\n\x1a\n" {
        return Err("Browser preview did not return a valid PNG screenshot".into());
    }
    Ok(bytes)
}

fn png_dimensions(bytes: &[u8]) -> Result<(u32, u32), String> {
    if bytes.len() < 24 || &bytes[..8] != b"\x89PNG\r\n\x1a\n" {
        return Err("Browser preview did not return a valid PNG screenshot".into());
    }
    let width = u32::from_be_bytes(bytes[16..20].try_into().expect("PNG width bytes"));
    let height = u32::from_be_bytes(bytes[20..24].try_into().expect("PNG height bytes"));
    if width == 0 || height == 0 {
        return Err("Browser preview screenshot has invalid dimensions".into());
    }
    Ok((width, height))
}

#[cfg(windows)]
async fn capture_preview_evidence(
    webview: &Webview,
) -> Result<(PreviewPageMetadata, Vec<u8>), String> {
    use std::sync::{Arc, Mutex};
    use webview2_com::Microsoft::Web::WebView2::Win32::COREWEBVIEW2_CAPTURE_PREVIEW_IMAGE_FORMAT_PNG;
    use webview2_com::{CapturePreviewCompletedHandler, ExecuteScriptCompletedHandler};
    use windows::Win32::Foundation::HGLOBAL;
    use windows::Win32::System::Com::StructuredStorage::CreateStreamOnHGlobal;

    let (metadata_tx, metadata_rx) = tokio::sync::oneshot::channel();
    let (image_tx, image_rx) = tokio::sync::oneshot::channel();
    let metadata_sender = Arc::new(Mutex::new(Some(metadata_tx)));
    let image_sender = Arc::new(Mutex::new(Some(image_tx)));
    let metadata_sender_main = Arc::clone(&metadata_sender);
    let image_sender_main = Arc::clone(&image_sender);

    webview
        .with_webview(move |platform| {
            let core = match unsafe { platform.controller().CoreWebView2() } {
                Ok(core) => core,
                Err(error) => {
                    let message = format!("Could not access browser preview engine: {error}");
                    finish_once(&metadata_sender_main, Err(message.clone()));
                    finish_once(&image_sender_main, Err(message));
                    return;
                }
            };

            let metadata_sender_callback = Arc::clone(&metadata_sender_main);
            let metadata_handler =
                ExecuteScriptCompletedHandler::create(Box::new(move |status, result| {
                    let parsed = status
                        .map_err(|error| format!("Could not inspect browser preview: {error}"))
                        .and_then(|_| {
                            parse_preview_callback_json::<PreviewPageMetadata>(
                                &result,
                                "Browser preview page metadata",
                            )
                        });
                    finish_once(&metadata_sender_callback, parsed);
                    Ok(())
                }));
            let script = windows::core::HSTRING::from(PREVIEW_METADATA_SCRIPT);
            if let Err(error) = unsafe { core.ExecuteScript(&script, &metadata_handler) } {
                finish_once(
                    &metadata_sender_main,
                    Err(format!("Could not inspect browser preview: {error}")),
                );
            }

            let stream = match unsafe { CreateStreamOnHGlobal(HGLOBAL::default(), true) } {
                Ok(stream) => stream,
                Err(error) => {
                    finish_once(
                        &image_sender_main,
                        Err(format!(
                            "Could not allocate browser preview screenshot: {error}"
                        )),
                    );
                    return;
                }
            };
            let callback_stream = stream.clone();
            let image_sender_callback = Arc::clone(&image_sender_main);
            let image_handler = CapturePreviewCompletedHandler::create(Box::new(move |status| {
                let captured = status
                    .map_err(|error| format!("Could not capture browser preview: {error}"))
                    .and_then(|_| unsafe { read_preview_stream(&callback_stream) });
                finish_once(&image_sender_callback, captured);
                Ok(())
            }));
            if let Err(error) = unsafe {
                core.CapturePreview(
                    COREWEBVIEW2_CAPTURE_PREVIEW_IMAGE_FORMAT_PNG,
                    &stream,
                    &image_handler,
                )
            } {
                finish_once(
                    &image_sender_main,
                    Err(format!("Could not capture browser preview: {error}")),
                );
            }
        })
        .map_err(|error| format!("Could not access browser preview: {error}"))?;

    let metadata = tokio::time::timeout(Duration::from_secs(15), metadata_rx)
        .await
        .map_err(|_| "Timed out while inspecting browser preview".to_string())?
        .map_err(|_| "Browser preview inspection stopped unexpectedly".to_string())??;
    let image = tokio::time::timeout(Duration::from_secs(15), image_rx)
        .await
        .map_err(|_| "Timed out while capturing browser preview".to_string())?
        .map_err(|_| "Browser preview capture stopped unexpectedly".to_string())??;
    Ok((metadata, image))
}

#[cfg(not(windows))]
async fn capture_preview_evidence(
    _webview: &Webview,
) -> Result<(PreviewPageMetadata, Vec<u8>), String> {
    Err("Native browser preview snapshots are not supported on this platform yet".into())
}

#[cfg(windows)]
async fn evaluate_preview_script(
    webview: &Webview,
    script: String,
) -> Result<serde_json::Value, String> {
    use std::sync::{Arc, Mutex};
    use webview2_com::ExecuteScriptCompletedHandler;

    let (sender, receiver) = tokio::sync::oneshot::channel();
    let sender = Arc::new(Mutex::new(Some(sender)));
    let sender_main = Arc::clone(&sender);
    webview
        .with_webview(move |platform| {
            let core = match unsafe { platform.controller().CoreWebView2() } {
                Ok(core) => core,
                Err(error) => {
                    finish_once(
                        &sender_main,
                        Err(format!("Could not access browser preview engine: {error}")),
                    );
                    return;
                }
            };
            let sender_callback = Arc::clone(&sender_main);
            let handler = ExecuteScriptCompletedHandler::create(Box::new(move |status, result| {
                let parsed = status
                    .map_err(|error| format!("Could not evaluate browser preview: {error}"))
                    .and_then(|_| {
                        parse_preview_callback_json(&result, "Browser preview script result")
                    });
                finish_once(&sender_callback, parsed);
                Ok(())
            }));
            let script = windows::core::HSTRING::from(script);
            if let Err(error) = unsafe { core.ExecuteScript(&script, &handler) } {
                finish_once(
                    &sender_main,
                    Err(format!("Could not evaluate browser preview: {error}")),
                );
            }
        })
        .map_err(|error| format!("Could not access browser preview: {error}"))?;

    tokio::time::timeout(Duration::from_secs(60), receiver)
        .await
        .map_err(|_| "Timed out while evaluating browser preview".to_string())?
        .map_err(|_| "Browser preview evaluation stopped unexpectedly".to_string())?
}

#[cfg(windows)]
async fn call_preview_devtools(
    webview: &Webview,
    method: &str,
    parameters: serde_json::Value,
) -> Result<serde_json::Value, String> {
    use std::sync::{Arc, Mutex};
    use webview2_com::CallDevToolsProtocolMethodCompletedHandler;

    let method = method.to_string();
    let parameters = serde_json::to_string(&parameters)
        .map_err(|error| format!("Could not serialize browser command: {error}"))?;
    let (sender, receiver) = tokio::sync::oneshot::channel();
    let sender = Arc::new(Mutex::new(Some(sender)));
    let sender_main = Arc::clone(&sender);
    webview
        .with_webview(move |platform| {
            let core = match unsafe { platform.controller().CoreWebView2() } {
                Ok(core) => core,
                Err(error) => {
                    finish_once(
                        &sender_main,
                        Err(format!("Could not access browser preview engine: {error}")),
                    );
                    return;
                }
            };
            let sender_callback = Arc::clone(&sender_main);
            let handler = CallDevToolsProtocolMethodCompletedHandler::create(Box::new(
                move |status, result| {
                    let parsed = status
                        .map_err(|error| format!("Browser automation command failed: {error}"))
                        .and_then(|_| {
                            parse_preview_callback_json(&result, "Browser automation result")
                        });
                    finish_once(&sender_callback, parsed);
                    Ok(())
                },
            ));
            let method = windows::core::HSTRING::from(method);
            let parameters = windows::core::HSTRING::from(parameters);
            if let Err(error) =
                unsafe { core.CallDevToolsProtocolMethod(&method, &parameters, &handler) }
            {
                finish_once(
                    &sender_main,
                    Err(format!("Browser automation command failed: {error}")),
                );
            }
        })
        .map_err(|error| format!("Could not access browser preview: {error}"))?;

    tokio::time::timeout(Duration::from_secs(60), receiver)
        .await
        .map_err(|_| "Timed out while running browser automation".to_string())?
        .map_err(|_| "Browser automation stopped unexpectedly".to_string())?
}

#[cfg(not(windows))]
async fn call_preview_devtools(
    _webview: &Webview,
    _method: &str,
    _parameters: serde_json::Value,
) -> Result<serde_json::Value, String> {
    Err("Browser preview automation is not supported on this platform yet".into())
}

#[cfg(not(windows))]
async fn evaluate_preview_script(
    _webview: &Webview,
    _script: String,
) -> Result<serde_json::Value, String> {
    Err("Browser preview automation is not supported on this platform yet".into())
}

fn agent_preview_webview(app: &AppHandle, workspace: &Path) -> Result<Webview, String> {
    let manager = app.state::<PreviewManager>();
    let runtime = lock_runtime(&manager)?;
    let matches = runtime
        .workspace
        .as_ref()
        .is_some_and(|active| workspace_identity(active) == workspace_identity(workspace));
    let approved = runtime
        .snapshot
        .as_ref()
        .and_then(|snapshot| Url::parse(&snapshot.url).ok())
        .is_some_and(|url| runtime.allows_url(&url));
    if !matches || !approved {
        return Err("No browser preview is open for this workspace".into());
    }
    app.get_webview(PREVIEW_LABEL)
        .ok_or_else(|| "The browser preview stopped and can be reopened".to_string())
}

fn main_webview(app: &AppHandle) -> Result<Webview, String> {
    app.get_webview("main")
        .ok_or_else(|| "The main application window is unavailable".to_string())
}

fn agent_preview_status(app: &AppHandle, workspace: &Path) -> Result<serde_json::Value, String> {
    require_registered_root(app, &workspace.to_string_lossy())?;
    let manager = app.state::<PreviewManager>();
    let runtime = lock_runtime(&manager)?;
    let matches = runtime
        .workspace
        .as_ref()
        .is_some_and(|active| workspace_identity(active) == workspace_identity(workspace));
    let state = if matches {
        runtime.snapshot.clone()
    } else {
        None
    };
    drop(runtime);
    let Some(state) = state else {
        return Ok(serde_json::json!({
            "available": false,
            "visible": false,
            "url": null,
            "title": null,
            "loading": false,
            "viewport": null
        }));
    };
    let webview = app.get_webview(PREVIEW_LABEL);
    let viewport = webview
        .as_ref()
        .and_then(|webview| webview.size().ok())
        .map(|size| serde_json::json!({ "width": size.width, "height": size.height }));
    Ok(serde_json::json!({
        "available": webview.is_some(),
        "visible": state.visible,
        "url": state.url,
        "title": state.title,
        "loading": state.loading,
        "viewport": viewport
    }))
}

fn agent_preview_session_id(app: &AppHandle, workspace: &Path) -> Result<u64, String> {
    let manager = app.state::<PreviewManager>();
    let runtime = lock_runtime(&manager)?;
    let matches = runtime
        .workspace
        .as_ref()
        .is_some_and(|active| workspace_identity(active) == workspace_identity(workspace));
    if !matches {
        return Err("No browser preview is open for this workspace".into());
    }
    runtime
        .snapshot
        .as_ref()
        .map(|snapshot| snapshot.session_id)
        .ok_or_else(|| "Browser preview state is unavailable".to_string())
}

fn required_string(arguments: &serde_json::Value, key: &str) -> Result<String, String> {
    arguments
        .get(key)
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .ok_or_else(|| format!("missing {key}"))
}

fn optional_string(arguments: &serde_json::Value, key: &str) -> Option<String> {
    arguments
        .get(key)
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn action_result(value: serde_json::Value) -> Result<serde_json::Value, String> {
    if value.get("ok").and_then(serde_json::Value::as_bool) == Some(false) {
        return Err(value
            .get("error")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("Browser preview action failed")
            .to_string());
    }
    Ok(value
        .get("value")
        .cloned()
        .unwrap_or(serde_json::Value::Null))
}

fn target_script(selector: Option<&str>, locator: Option<&str>) -> Result<String, String> {
    if selector.is_some() && locator.is_some() {
        return Err("Provide at most one of selector or locator".into());
    }
    let selector = serde_json::to_string(&selector).map_err(|error| error.to_string())?;
    let locator = serde_json::to_string(&locator).map_err(|error| error.to_string())?;
    Ok(format!(
        r#"(() => {{
          const selector = {selector};
          const locator = {locator};
          const visible = (el) => {{
            if (!el) return false;
            const style = getComputedStyle(el);
            const rect = el.getBoundingClientRect();
            return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
          }};
          const byLocator = (raw) => {{
            if (!raw) return null;
            if (raw.startsWith('text=')) {{
              const text = raw.slice(5);
              return Array.from(document.querySelectorAll('body *')).find((el) => visible(el) && (el.innerText || '').trim().includes(text)) || null;
            }}
            const match = raw.match(/^role=([^\\[]+)(?:\\[name=(?:['\"])?(.*?)(?:['\"])?\\])?$/);
            if (match) {{
              const role = match[1].trim();
              const name = match[2];
              return Array.from(document.querySelectorAll('[role],button,a,input,textarea,select')).find((el) => {{
                const implicit = el.matches('button') ? 'button' : el.matches('a[href]') ? 'link' : el.matches('input,textarea') ? 'textbox' : '';
                const actualRole = el.getAttribute('role') || implicit;
                const actualName = (el.getAttribute('aria-label') || el.innerText || el.getAttribute('name') || '').trim();
                return visible(el) && actualRole === role && (name === undefined || actualName === name);
              }}) || null;
            }}
            try {{ return document.querySelector(raw); }} catch {{ return null; }}
          }};
          return selector ? document.querySelector(selector) : byLocator(locator);
        }})()"#
    ))
}

fn wrapped_action(body: &str) -> String {
    format!(
        "(() => {{ try {{ {body} }} catch (error) {{ return {{ok:false,error:String(error?.message || error)}}; }} }})()"
    )
}

async fn wait_until_loaded(
    app: &AppHandle,
    workspace: &Path,
    timeout_ms: u64,
) -> Result<serde_json::Value, String> {
    let deadline = std::time::Instant::now() + Duration::from_millis(timeout_ms);
    loop {
        let status = agent_preview_status(app, workspace)?;
        if status.get("loading").and_then(serde_json::Value::as_bool) == Some(false) {
            return Ok(status);
        }
        if std::time::Instant::now() >= deadline {
            return Err(format!(
                "Timed out after {timeout_ms}ms waiting for the page to load"
            ));
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

pub async fn execute_agent_preview_tool(
    app: &AppHandle,
    workspace: &Path,
    name: &str,
    arguments: serde_json::Value,
) -> Result<AgentToolResult, String> {
    require_registered_root(app, &workspace.to_string_lossy())?;
    let result = match name {
        "preview_status" => agent_preview_status(app, workspace)?,
        "preview_open" => {
            let requested_url = optional_string(&arguments, "url");
            let current = agent_preview_status(app, workspace)?;
            if current
                .get("available")
                .and_then(serde_json::Value::as_bool)
                == Some(true)
            {
                if let Some(url) = requested_url {
                    let url = require_agent_approved_url(app, workspace, &url)?;
                    let caller = main_webview(app)?;
                    let session_id = agent_preview_session_id(app, workspace)?;
                    preview_navigate(
                        app.clone(),
                        caller,
                        workspace.to_string_lossy().to_string(),
                        session_id,
                        url.as_str().to_string(),
                    )?;
                    wait_until_loaded(app, workspace, 15_000).await?
                } else {
                    current
                }
            } else {
                return Err(
                    "Open Browser Preview for this workspace before using preview tools.".into(),
                );
            }
        }
        "preview_navigate" => {
            let caller = main_webview(app)?;
            let url = required_string(&arguments, "url")?;
            let url = require_agent_approved_url(app, workspace, &url)?;
            let readiness =
                optional_string(&arguments, "readiness").unwrap_or_else(|| "load".into());
            if !matches!(readiness.as_str(), "load" | "none") {
                return Err("readiness must be load or none".into());
            }
            let timeout_ms = arguments
                .get("timeoutMs")
                .and_then(serde_json::Value::as_u64)
                .unwrap_or(15_000)
                .clamp(1, 60_000);
            let session_id = agent_preview_session_id(app, workspace)?;
            preview_navigate(
                app.clone(),
                caller,
                workspace.to_string_lossy().to_string(),
                session_id,
                url.as_str().to_string(),
            )?;
            if readiness == "none" {
                agent_preview_status(app, workspace)?
            } else {
                wait_until_loaded(app, workspace, timeout_ms).await?
            }
        }
        "preview_resize" => {
            let width = arguments
                .get("width")
                .and_then(serde_json::Value::as_u64)
                .filter(|value| (240..=3840).contains(value))
                .ok_or_else(|| "width must be between 240 and 3840".to_string())?;
            let height = arguments
                .get("height")
                .and_then(serde_json::Value::as_u64)
                .filter(|value| (240..=2160).contains(value))
                .ok_or_else(|| "height must be between 240 and 2160".to_string())?;
            let webview = agent_preview_webview(app, workspace)?;
            webview
                .set_size(LogicalSize::new(width as f64, height as f64))
                .map_err(|error| format!("Could not resize browser preview: {error}"))?;
            serde_json::json!({ "width": width, "height": height })
        }
        "preview_set_appearance" => {
            let scheme = required_string(&arguments, "colorScheme")?;
            if !matches!(scheme.as_str(), "system" | "light" | "dark") {
                return Err("colorScheme must be system, light, or dark".into());
            }
            let webview = agent_preview_webview(app, workspace)?;
            let value = if scheme == "system" {
                ""
            } else {
                scheme.as_str()
            };
            call_preview_devtools(
                &webview,
                "Emulation.setEmulatedMedia",
                serde_json::json!({
                    "features": [{ "name": "prefers-color-scheme", "value": value }]
                }),
            )
            .await?;
            serde_json::json!({ "colorScheme": scheme })
        }
        "preview_snapshot" => {
            let snapshot = preview_snapshot_for_agent(app, workspace).await?;
            return Ok(AgentToolResult {
                text: snapshot.text,
                image: Some(AgentToolImage {
                    data_url: snapshot.data_url,
                    mime: snapshot.mime,
                    label: snapshot.label,
                }),
            });
        }
        "preview_click" => {
            let selector = optional_string(&arguments, "selector");
            let locator = optional_string(&arguments, "locator");
            let x = arguments.get("x").and_then(serde_json::Value::as_f64);
            let y = arguments.get("y").and_then(serde_json::Value::as_f64);
            if x.is_some() != y.is_some() {
                return Err("Coordinates require both x and y".into());
            }
            let modes = usize::from(selector.is_some())
                + usize::from(locator.is_some())
                + usize::from(x.is_some());
            if modes != 1 {
                return Err("Provide exactly one click target".into());
            }
            let webview = agent_preview_webview(app, workspace)?;
            let body = if let (Some(x), Some(y)) = (x, y) {
                format!("const el=document.elementFromPoint({x},{y}); if(!el) return {{ok:false,error:'No element at coordinates'}}; el.click(); return {{ok:true,value:null}};")
            } else {
                let target = target_script(selector.as_deref(), locator.as_deref())?;
                format!("const el=({target}); if(!el) return {{ok:false,error:'Click target not found'}}; el.scrollIntoView({{block:'center',inline:'center'}}); el.click(); return {{ok:true,value:null}};")
            };
            action_result(evaluate_preview_script(&webview, wrapped_action(&body)).await?)?
        }
        "preview_type" => {
            let text = arguments
                .get("text")
                .and_then(serde_json::Value::as_str)
                .ok_or_else(|| "missing text".to_string())?;
            let selector = optional_string(&arguments, "selector");
            let locator = optional_string(&arguments, "locator");
            let target = target_script(selector.as_deref(), locator.as_deref())?;
            let literal = serde_json::to_string(text).map_err(|error| error.to_string())?;
            let clear = arguments
                .get("clear")
                .and_then(serde_json::Value::as_bool)
                .unwrap_or(false);
            let webview = agent_preview_webview(app, workspace)?;
            let body = format!(
                "const el=({target}) || document.activeElement; if(!el || !('value' in el)) return {{ok:false,error:'Type target is not an input'}}; el.focus(); const next={clear} ? {literal} : String(el.value || '') + {literal}; const setter=Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el),'value')?.set; if(setter) setter.call(el,next); else el.value=next; el.dispatchEvent(new InputEvent('input',{{bubbles:true,inputType:'insertText',data:{literal}}})); el.dispatchEvent(new Event('change',{{bubbles:true}})); return {{ok:true,value:null}};"
            );
            action_result(evaluate_preview_script(&webview, wrapped_action(&body)).await?)?
        }
        "preview_press" => {
            let key = required_string(&arguments, "key")?;
            let modifiers = arguments
                .get("modifiers")
                .and_then(serde_json::Value::as_array)
                .cloned()
                .unwrap_or_default();
            let has = |name: &str| modifiers.iter().any(|value| value.as_str() == Some(name));
            let webview = agent_preview_webview(app, workspace)?;
            let modifiers = u8::from(has("Alt"))
                | (u8::from(has("Control")) << 1)
                | (u8::from(has("Meta")) << 2)
                | (u8::from(has("Shift")) << 3);
            let text = (key.chars().count() == 1).then_some(key.as_str());
            call_preview_devtools(
                &webview,
                "Input.dispatchKeyEvent",
                serde_json::json!({
                    "type": "keyDown",
                    "key": key,
                    "text": text,
                    "modifiers": modifiers
                }),
            )
            .await?;
            call_preview_devtools(
                &webview,
                "Input.dispatchKeyEvent",
                serde_json::json!({
                    "type": "keyUp",
                    "key": key,
                    "modifiers": modifiers
                }),
            )
            .await?;
            serde_json::Value::Null
        }
        "preview_scroll" => {
            let delta_x = arguments
                .get("deltaX")
                .and_then(serde_json::Value::as_f64)
                .unwrap_or(0.0);
            let delta_y = arguments
                .get("deltaY")
                .and_then(serde_json::Value::as_f64)
                .unwrap_or(0.0);
            if delta_x == 0.0 && delta_y == 0.0 {
                return Err("Provide a non-zero deltaX or deltaY".into());
            }
            let selector = optional_string(&arguments, "selector");
            let locator = optional_string(&arguments, "locator");
            let target = target_script(selector.as_deref(), locator.as_deref())?;
            let webview = agent_preview_webview(app, workspace)?;
            let body = format!("const el=({target}); if(({} || {}) && !el) return {{ok:false,error:'Scroll target not found'}}; (el || window).scrollBy({{left:{delta_x},top:{delta_y},behavior:'instant'}}); return {{ok:true,value:null}};", selector.is_some(), locator.is_some());
            action_result(evaluate_preview_script(&webview, wrapped_action(&body)).await?)?
        }
        "preview_evaluate" => {
            let expression = required_string(&arguments, "expression")?;
            if expression.len() > 64_000 {
                return Err("expression exceeds 64000 characters".into());
            }
            let webview = agent_preview_webview(app, workspace)?;
            let response = call_preview_devtools(
                &webview,
                "Runtime.evaluate",
                serde_json::json!({
                    "expression": bounded_preview_evaluation(&expression),
                    "awaitPromise": true,
                    "returnByValue": true,
                    "userGesture": true
                }),
            )
            .await?;
            if let Some(exception) = response.get("exceptionDetails") {
                return Err(exception
                    .pointer("/exception/description")
                    .or_else(|| exception.get("text"))
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or("JavaScript evaluation failed")
                    .to_string());
            }
            response
                .pointer("/result/value")
                .cloned()
                .unwrap_or(serde_json::Value::Null)
        }
        "preview_wait_for" => {
            let selector = optional_string(&arguments, "selector");
            let locator = optional_string(&arguments, "locator");
            let text = optional_string(&arguments, "text");
            let url_includes = optional_string(&arguments, "urlIncludes");
            if selector.is_none() && locator.is_none() && text.is_none() && url_includes.is_none() {
                return Err("Provide at least one wait condition".into());
            }
            let timeout_ms = arguments
                .get("timeoutMs")
                .and_then(serde_json::Value::as_u64)
                .unwrap_or(15_000)
                .clamp(1, 60_000);
            let target = target_script(selector.as_deref(), locator.as_deref())?;
            let text = serde_json::to_string(&text).map_err(|error| error.to_string())?;
            let url_includes =
                serde_json::to_string(&url_includes).map_err(|error| error.to_string())?;
            let webview = agent_preview_webview(app, workspace)?;
            let deadline = std::time::Instant::now() + Duration::from_millis(timeout_ms);
            loop {
                let script = wrapped_action(&format!(
                    "const el=({target}); const text={text}; const urlPart={url_includes}; const matchesElement={} ? Boolean(el) : true; const matchesText=text ? (document.body?.innerText || '').includes(text) : true; const matchesUrl=urlPart ? location.href.includes(urlPart) : true; return {{ok:true,value:matchesElement && matchesText && matchesUrl}};",
                    selector.is_some() || locator.is_some()
                ));
                let matched = action_result(evaluate_preview_script(&webview, script).await?)?
                    .as_bool()
                    .unwrap_or(false);
                if matched {
                    break serde_json::Value::Null;
                }
                if std::time::Instant::now() >= deadline {
                    return Err(format!(
                        "Timed out after {timeout_ms}ms waiting for preview conditions"
                    ));
                }
                tokio::time::sleep(Duration::from_millis(100)).await;
            }
        }
        _ => return Err(format!("Unknown preview tool: {name}")),
    };
    Ok(AgentToolResult {
        text: serde_json::to_string_pretty(&result)
            .map_err(|error| format!("Could not serialize preview result: {error}"))?,
        image: None,
    })
}

pub async fn preview_snapshot_for_agent(
    app: &AppHandle,
    workspace: &Path,
) -> Result<AgentPreviewSnapshot, String> {
    let (state, webview) = {
        let manager = app.state::<PreviewManager>();
        let runtime = lock_runtime(&manager)?;
        let workspace_matches = runtime
            .workspace
            .as_ref()
            .is_some_and(|active| workspace_identity(active) == workspace_identity(workspace));
        if !workspace_matches {
            return Err("No browser preview is open for this workspace".into());
        }
        let state = runtime
            .snapshot
            .clone()
            .ok_or_else(|| "No browser preview is open for this workspace".to_string())?;
        let state_url = Url::parse(&state.url)
            .map_err(|_| "Browser preview has an invalid current URL".to_string())?;
        if !runtime.allows_url(&state_url) {
            return Err("Browser preview origin is not approved for agent access".into());
        }
        let webview = app
            .get_webview(PREVIEW_LABEL)
            .ok_or_else(|| "The browser preview stopped and can be reopened".to_string())?;
        (state, webview)
    };

    let (metadata, png) = capture_preview_evidence(&webview).await?;
    let (width, height) = png_dimensions(&png)?;

    let manager = app.state::<PreviewManager>();
    let current = lock_runtime(&manager)?;
    let still_current = current.generation == state.session_id
        && current
            .workspace
            .as_ref()
            .is_some_and(|active| workspace_identity(active) == workspace_identity(workspace))
        && Url::parse(&metadata.url)
            .ok()
            .is_some_and(|url| current.allows_url(&url));
    if !still_current {
        return Err("Browser preview changed while the snapshot was being captured".into());
    }
    drop(current);

    let payload = serde_json::json!({
        "url": metadata.url,
        "title": metadata.title,
        "loading": metadata.loading,
        "visibleText": metadata.visible_text,
        "interactiveElements": metadata.interactive_elements,
        "consoleEntries": [],
        "networkEntries": [],
        "actionTimeline": [],
        "screenshot": {
            "mimeType": "image/png",
            "width": width,
            "height": height
        }
    });
    let encoded = base64::engine::general_purpose::STANDARD.encode(&png);
    Ok(AgentPreviewSnapshot {
        text: serde_json::to_string_pretty(&payload)
            .map_err(|error| format!("Could not serialize browser preview snapshot: {error}"))?,
        data_url: format!("data:image/png;base64,{encoded}"),
        mime: "image/png".into(),
        label: "browser-preview.png".into(),
    })
}

#[tauri::command]
pub async fn preview_capture(
    app: AppHandle,
    caller: Webview,
    workspace_path: String,
    session_id: u64,
) -> Result<PreviewCapture, String> {
    let (_, workspace) = current_session(&app, &caller, &workspace_path, session_id, true)?;
    let captured = preview_snapshot_for_agent(&app, &workspace).await?;
    Ok(PreviewCapture {
        data_url: captured.data_url,
        mime: captured.mime,
        label: captured.label,
    })
}

#[tauri::command]
pub async fn preview_open(
    app: AppHandle,
    caller: Webview,
    workspace_path: String,
    url: String,
    bounds: PreviewBounds,
) -> Result<PreviewSnapshot, String> {
    require_main_webview(&caller)?;
    let workspace = require_registered_root(&app, &workspace_path)?;
    let url = normalize_preview_url(&url)?;
    let bounds = bounds.validate()?;

    let manager = app.state::<PreviewManager>();
    let _lifecycle = manager
        .lifecycle
        .lock()
        .map_err(|_| "Browser preview lifecycle is unavailable.".to_string())?;
    let reuse = {
        let runtime = lock_runtime(&manager)?;
        runtime.workspace.as_ref() == Some(&workspace)
            && runtime.snapshot.is_some()
            && app.get_webview(PREVIEW_LABEL).is_some()
    };

    if reuse {
        let webview = app
            .get_webview(PREVIEW_LABEL)
            .ok_or_else(|| "The browser preview is not available.".to_string())?;
        set_webview_bounds(&webview, bounds)?;
        webview
            .show()
            .map_err(|error| format!("Could not show browser preview: {error}"))?;
        let should_navigate = {
            let mut runtime = lock_runtime(&manager)?;
            runtime.approve_url(&url);
            let should_navigate = runtime
                .snapshot
                .as_ref()
                .is_none_or(|snapshot| snapshot.url != url.as_str());
            if let Some(snapshot) = runtime.snapshot.as_mut() {
                snapshot.visible = true;
                if should_navigate {
                    snapshot.loading = true;
                }
            }
            should_navigate
        };
        if should_navigate {
            if let Err(error) = webview.navigate(url) {
                let snapshot = {
                    let mut runtime = lock_runtime(&manager)?;
                    if let Some(snapshot) = runtime.snapshot.as_mut() {
                        snapshot.loading = false;
                    }
                    runtime.snapshot.clone()
                };
                if let Some(snapshot) = snapshot {
                    emit_snapshot(&app, &snapshot);
                }
                return Err(format!("Could not navigate browser preview: {error}"));
            }
        }
        let snapshot = lock_runtime(&manager)?
            .snapshot
            .clone()
            .ok_or_else(|| "Browser preview state is unavailable.".to_string())?;
        emit_snapshot(&app, &snapshot);
        return Ok(snapshot);
    }

    let generation = {
        let mut runtime = lock_runtime(&manager)?;
        runtime.generation = runtime.generation.wrapping_add(1);
        runtime.workspace = Some(workspace.clone());
        runtime.approved_origins.clear();
        runtime.approve_url(&url);
        runtime.history = vec![url.as_str().to_string()];
        runtime.history_index = 0;
        runtime.pending_navigation = None;
        runtime.snapshot = Some(PreviewSnapshot {
            session_id: runtime.generation,
            workspace_path: workspace.to_string_lossy().to_string(),
            url: url.as_str().to_string(),
            title: None,
            loading: true,
            can_go_back: false,
            can_go_forward: false,
            visible: true,
        });
        runtime.generation
    };

    if let Some(existing) = app.get_webview(PREVIEW_LABEL) {
        let _ = existing.close();
    }

    let navigation_app = app.clone();
    let page_app = app.clone();
    let title_app = app.clone();
    let popup_app = app.clone();
    let navigation_workspace = workspace.to_string_lossy().to_string();
    let builder = WebviewBuilder::new(PREVIEW_LABEL, WebviewUrl::External(url.clone()))
        .incognito(true)
        .zoom_hotkeys_enabled(true)
        .devtools(cfg!(debug_assertions))
        .on_navigation(move |next_url| {
            if !runtime_allows_navigation(&navigation_app, generation, next_url) {
                let _ = navigation_app.emit_to(
                    "main",
                    PREVIEW_BLOCKED_EVENT,
                    BlockedNavigation {
                        session_id: generation,
                        workspace_path: navigation_workspace.clone(),
                        url: next_url.as_str().to_string(),
                    },
                );
                return false;
            }
            let next = next_url.as_str().to_string();
            update_snapshot(&navigation_app, generation, |runtime| {
                runtime.observe_navigation(&next, true, false);
            });
            true
        })
        .on_page_load(move |_webview, payload| {
            let next = payload.url().as_str().to_string();
            let loading = payload.event() == PageLoadEvent::Started;
            update_snapshot(&page_app, generation, |runtime| {
                runtime.observe_navigation(&next, loading, !loading);
            });
        })
        .on_document_title_changed(move |_webview, title| {
            update_snapshot(&title_app, generation, |runtime| {
                if let Some(snapshot) = runtime.snapshot.as_mut() {
                    snapshot.title = Some(title);
                }
            });
        })
        .on_new_window(move |popup_url, _features| {
            if runtime_allows_navigation(&popup_app, generation, &popup_url) {
                if let Some(webview) = popup_app.get_webview(PREVIEW_LABEL) {
                    let _ = webview.navigate(popup_url);
                }
            }
            NewWindowResponse::Deny
        });

    let window = caller.window();
    if let Err(error) = window.add_child(
        builder,
        LogicalPosition::new(bounds.x, bounds.y),
        LogicalSize::new(bounds.width, bounds.height),
    ) {
        let mut runtime = lock_runtime(&manager)?;
        if runtime.generation == generation {
            runtime.workspace = None;
            runtime.snapshot = None;
            runtime.approved_origins.clear();
            runtime.history.clear();
            runtime.history_index = 0;
            runtime.pending_navigation = None;
        }
        return Err(format!("Could not create browser preview: {error}"));
    }

    let snapshot = lock_runtime(&manager)?
        .snapshot
        .clone()
        .ok_or_else(|| "Browser preview state is unavailable.".to_string())?;
    emit_snapshot(&app, &snapshot);
    Ok(snapshot)
}

#[tauri::command]
pub fn preview_close(
    app: AppHandle,
    caller: Webview,
    workspace_path: String,
    session_id: u64,
) -> Result<(), String> {
    let manager = app.state::<PreviewManager>();
    let _lifecycle = manager
        .lifecycle
        .lock()
        .map_err(|_| "Browser preview lifecycle is unavailable.".to_string())?;
    let (webview, _) = current_session(&app, &caller, &workspace_path, session_id, false)?;
    webview
        .close()
        .map_err(|error| format!("Could not close browser preview: {error}"))?;

    let mut runtime = lock_runtime(&manager)?;
    if runtime.generation == session_id {
        runtime.generation = runtime.generation.wrapping_add(1);
        runtime.workspace = None;
        runtime.snapshot = None;
        runtime.approved_origins.clear();
        runtime.history.clear();
        runtime.history_index = 0;
        runtime.pending_navigation = None;
    }
    Ok(())
}

#[tauri::command]
pub fn preview_state(
    app: AppHandle,
    caller: Webview,
    workspace_path: String,
) -> Result<Option<PreviewSnapshot>, String> {
    require_main_webview(&caller)?;
    let workspace = require_registered_root(&app, &workspace_path)?;
    let manager = app.state::<PreviewManager>();
    let _lifecycle = manager
        .lifecycle
        .lock()
        .map_err(|_| "Browser preview lifecycle is unavailable.".to_string())?;
    let mut runtime = lock_runtime(&manager)?;
    if runtime.workspace.as_ref() != Some(&workspace) {
        return Ok(None);
    }
    if app.get_webview(PREVIEW_LABEL).is_none() {
        runtime.generation = runtime.generation.wrapping_add(1);
        runtime.workspace = None;
        runtime.snapshot = None;
        runtime.approved_origins.clear();
        runtime.history.clear();
        runtime.history_index = 0;
        runtime.pending_navigation = None;
        return Ok(None);
    }
    Ok(runtime.snapshot.clone())
}

#[tauri::command]
pub fn preview_navigate(
    app: AppHandle,
    caller: Webview,
    workspace_path: String,
    session_id: u64,
    url: String,
) -> Result<(), String> {
    let url = normalize_preview_url(&url)?;
    let manager = app.state::<PreviewManager>();
    let _lifecycle = manager
        .lifecycle
        .lock()
        .map_err(|_| "Browser preview lifecycle is unavailable.".to_string())?;
    let (webview, _) = current_session(&app, &caller, &workspace_path, session_id, true)?;
    let loading_snapshot = {
        let mut runtime = lock_runtime(&manager)?;
        runtime.approve_url(&url);
        runtime.begin_push(url.as_str());
        runtime.snapshot.clone()
    };
    if let Some(snapshot) = loading_snapshot {
        emit_snapshot(&app, &snapshot);
    }
    if let Err(error) = webview.navigate(url) {
        let snapshot = {
            let mut runtime = lock_runtime(&manager)?;
            if runtime.generation == session_id {
                runtime.rollback_navigation();
            }
            runtime.snapshot.clone()
        };
        if let Some(snapshot) = snapshot {
            emit_snapshot(&app, &snapshot);
        }
        return Err(format!("Could not navigate browser preview: {error}"));
    }
    Ok(())
}

#[tauri::command]
pub fn preview_sync_state(
    app: AppHandle,
    caller: Webview,
    workspace_path: String,
    session_id: u64,
) -> Result<PreviewSnapshot, String> {
    let manager = app.state::<PreviewManager>();
    let _lifecycle = manager
        .lifecycle
        .lock()
        .map_err(|_| "Browser preview lifecycle is unavailable.".to_string())?;
    let (webview, _) = current_session(&app, &caller, &workspace_path, session_id, true)?;
    let current_url = webview
        .url()
        .map_err(|error| format!("Could not read browser preview state: {error}"))?;
    if !is_allowed_preview_navigation(&current_url) {
        return Err("Browser preview left the allowed HTTP or HTTPS page.".into());
    }
    let current_url = current_url.as_str().to_string();
    let mut runtime = lock_runtime(&manager)?;
    let parsed_url = Url::parse(&current_url)
        .map_err(|_| "Browser preview has an invalid current URL.".to_string())?;
    if !runtime.allows_url(&parsed_url) {
        return Err("Browser preview left the approved origin.".into());
    }
    runtime.sync_current_url(&current_url);
    runtime
        .snapshot
        .clone()
        .ok_or_else(|| "Browser preview state is unavailable.".to_string())
}

#[tauri::command]
pub fn preview_action(
    app: AppHandle,
    caller: Webview,
    workspace_path: String,
    session_id: u64,
    action: PreviewAction,
) -> Result<(), String> {
    let manager = app.state::<PreviewManager>();
    let _lifecycle = manager
        .lifecycle
        .lock()
        .map_err(|_| "Browser preview lifecycle is unavailable.".to_string())?;
    let (webview, _) = current_session(&app, &caller, &workspace_path, session_id, true)?;
    match action {
        PreviewAction::Reload => {
            {
                let mut runtime = lock_runtime(&manager)?;
                runtime.begin_reload();
            }
            if let Err(error) = webview.reload() {
                lock_runtime(&manager)?.rollback_navigation();
                return Err(format!("Could not reload browser preview: {error}"));
            }
            Ok(())
        }
        PreviewAction::Back | PreviewAction::Forward => {
            let delta = if matches!(action, PreviewAction::Back) {
                -1
            } else {
                1
            };
            let moved = {
                let mut runtime = lock_runtime(&manager)?;
                runtime.begin_traverse(delta)
            };
            if !moved {
                return Ok(());
            }
            let script = if delta < 0 {
                "history.back()"
            } else {
                "history.forward()"
            };
            if let Err(error) = webview.eval(script) {
                let mut runtime = lock_runtime(&manager)?;
                runtime.rollback_navigation();
                return Err(format!("Could not move through browser history: {error}"));
            }
            let snapshot = lock_runtime(&manager)?.snapshot.clone();
            if let Some(snapshot) = snapshot {
                emit_snapshot(&app, &snapshot);
            }
            Ok(())
        }
    }
}

#[tauri::command]
pub fn preview_set_bounds(
    app: AppHandle,
    caller: Webview,
    workspace_path: String,
    session_id: u64,
    bounds: PreviewBounds,
) -> Result<(), String> {
    let manager = app.state::<PreviewManager>();
    let _lifecycle = manager
        .lifecycle
        .lock()
        .map_err(|_| "Browser preview lifecycle is unavailable.".to_string())?;
    let (webview, _) = current_session(&app, &caller, &workspace_path, session_id, true)?;
    set_webview_bounds(&webview, bounds)
}

#[tauri::command]
pub fn preview_set_visible(
    app: AppHandle,
    caller: Webview,
    workspace_path: String,
    session_id: u64,
    visible: bool,
) -> Result<(), String> {
    let manager = app.state::<PreviewManager>();
    let _lifecycle = manager
        .lifecycle
        .lock()
        .map_err(|_| "Browser preview lifecycle is unavailable.".to_string())?;
    let (webview, _) = current_session(&app, &caller, &workspace_path, session_id, visible)?;
    if visible {
        webview
            .show()
            .map_err(|error| format!("Could not show browser preview: {error}"))?;
    } else {
        webview
            .hide()
            .map_err(|error| format!("Could not hide browser preview: {error}"))?;
    }
    let (changed, snapshot) = {
        let mut runtime = lock_runtime(&manager)?;
        let mut changed = false;
        if let Some(snapshot) = runtime.snapshot.as_mut() {
            if snapshot.visible != visible {
                snapshot.visible = visible;
                changed = true;
            }
        }
        (changed, runtime.snapshot.clone())
    };
    if changed {
        let snapshot =
            snapshot.ok_or_else(|| "Browser preview state is unavailable.".to_string())?;
        emit_snapshot(&app, &snapshot);
    }
    Ok(())
}

#[tauri::command]
pub fn preview_open_external(
    app: AppHandle,
    caller: Webview,
    workspace_path: String,
    session_id: u64,
    url: String,
) -> Result<(), String> {
    let manager = app.state::<PreviewManager>();
    let _lifecycle = manager
        .lifecycle
        .lock()
        .map_err(|_| "Browser preview lifecycle is unavailable.".to_string())?;
    let _ = current_session(&app, &caller, &workspace_path, session_id, true)?;
    let url = normalize_preview_url(&url)?;
    app.opener()
        .open_url(url.as_str(), None::<&str>)
        .map_err(|error| format!("Could not open preview in the default browser: {error}"))
}

fn discover_ports(ports: &[u16]) -> Vec<DiscoveredLocalServer> {
    ports
        .iter()
        .copied()
        .filter(|port| {
            let address = SocketAddr::new(IpAddr::from([127, 0, 0, 1]), *port);
            TcpStream::connect_timeout(&address, Duration::from_millis(45)).is_ok()
        })
        .map(|port| DiscoveredLocalServer {
            port,
            url: format!("http://localhost:{port}/"),
        })
        .collect()
}

#[tauri::command]
pub async fn preview_discover_servers(
    app: AppHandle,
    caller: Webview,
    workspace_path: String,
) -> Result<Vec<DiscoveredLocalServer>, String> {
    require_main_webview(&caller)?;
    require_registered_root(&app, &workspace_path)?;
    tauri::async_runtime::spawn_blocking(|| discover_ports(COMMON_DEV_PORTS))
        .await
        .map_err(|error| format!("Could not scan local development ports: {error}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::TcpListener;

    #[test]
    fn preview_callbacks_reject_oversized_json_before_deserialization() {
        let oversized = " ".repeat(MAX_PREVIEW_CALLBACK_BYTES + 1);
        let error = parse_preview_callback_json::<serde_json::Value>(
            &oversized,
            "Browser preview test result",
        )
        .unwrap_err();

        assert!(error.contains("safety limit"));
    }

    #[test]
    fn preview_evaluation_projects_results_with_fixed_budgets() {
        let expression = bounded_preview_evaluation("document.body.innerText");

        assert!(expression.contains("document.body.innerText"));
        assert!(expression.contains(&format!("remainingChars = {MAX_PREVIEW_RESULT_CHARS}")));
        assert!(expression.contains(&format!("remainingNodes = {MAX_PREVIEW_RESULT_NODES}")));
        assert!(expression.contains("depth >= 6"));
        assert!(expression.contains("input.slice(0, 100)"));
        assert!(expression.contains("Object.keys(input).slice(0, 100)"));
        assert!(expression.contains("[circular]"));
    }

    #[cfg(windows)]
    #[test]
    fn preview_metadata_caps_every_page_controlled_string() {
        for cap in [
            "location.href.slice(0, 4096)",
            "document.title || \"\").slice(0, 512)",
            "getAttribute(\"role\")?.slice(0, 64)",
            "selectorFor(element).slice(0, 512)",
        ] {
            assert!(PREVIEW_METADATA_SCRIPT.contains(cap), "missing {cap}");
        }
    }

    #[test]
    fn normalizes_preview_urls() {
        assert_eq!(
            normalize_preview_url("localhost:5173").unwrap().as_str(),
            "http://localhost:5173/"
        );
        assert_eq!(
            normalize_preview_url("http://0.0.0.0:3000/path")
                .unwrap()
                .as_str(),
            "http://127.0.0.1:3000/path"
        );
        assert_eq!(
            normalize_preview_url("http://[::]:3000/").unwrap().as_str(),
            "http://[::1]:3000/"
        );
        assert_eq!(
            normalize_preview_url("google.com").unwrap().as_str(),
            "https://google.com/"
        );
        assert_eq!(
            normalize_preview_url("https://example.com/docs")
                .unwrap()
                .as_str(),
            "https://example.com/docs"
        );
        assert!(normalize_preview_url("file:///tmp/index.html").is_err());
        assert!(normalize_preview_url("http://user:secret@localhost:3000").is_err());
    }

    #[test]
    fn preview_navigation_rejects_credentials_and_non_http_schemes() {
        assert!(is_allowed_preview_navigation(
            &Url::parse("https://www.google.com/").unwrap()
        ));
        assert!(!is_allowed_preview_navigation(
            &Url::parse("https://user:secret@example.com/").unwrap()
        ));
        assert!(!is_allowed_preview_navigation(
            &Url::parse("file:///tmp/index.html").unwrap()
        ));
    }

    #[test]
    fn preview_runtime_allows_only_user_approved_origins() {
        let mut runtime = PreviewRuntime::default();
        let approved = Url::parse("http://localhost:3000/start").unwrap();
        runtime.approve_url(&approved);

        assert!(runtime.allows_url(&Url::parse("http://localhost:3000/next").unwrap()));
        assert!(!runtime.allows_url(&Url::parse("http://localhost:3001/").unwrap()));
        assert!(!runtime.allows_url(&Url::parse("http://127.0.0.1:3000/").unwrap()));
        assert!(!runtime.allows_url(&Url::parse("https://example.com/").unwrap()));
    }

    fn preview_runtime() -> PreviewRuntime {
        PreviewRuntime {
            history: vec!["http://localhost:3000/".into()],
            snapshot: Some(PreviewSnapshot {
                session_id: 1,
                workspace_path: "/tmp/project".into(),
                url: "http://localhost:3000/".into(),
                title: None,
                loading: false,
                can_go_back: false,
                can_go_forward: false,
                visible: true,
            }),
            ..Default::default()
        }
    }

    #[test]
    fn redirect_chain_commits_one_history_entry_and_traverses_once() {
        let mut runtime = preview_runtime();
        runtime.begin_push("http://localhost:3000/redirect");
        runtime.observe_navigation("http://localhost:3000/redirect", true, false);
        runtime.observe_navigation("http://localhost:3000/final", true, false);
        runtime.observe_navigation("http://localhost:3000/final", false, true);

        assert_eq!(
            runtime.history,
            [
                "http://localhost:3000/".to_string(),
                "http://localhost:3000/final".to_string()
            ]
        );
        assert_eq!(runtime.history_index, 1);
        assert!(runtime.snapshot.as_ref().unwrap().can_go_back);

        assert!(runtime.begin_traverse(-1));
        runtime.observe_navigation("http://localhost:3000/", true, false);
        runtime.observe_navigation("http://localhost:3000/", false, true);
        assert_eq!(runtime.history_index, 0);
        assert!(!runtime.snapshot.as_ref().unwrap().can_go_back);
        assert!(runtime.snapshot.as_ref().unwrap().can_go_forward);
    }

    #[test]
    fn reload_and_duplicate_callbacks_do_not_append_history() {
        let mut runtime = preview_runtime();
        runtime.begin_reload();
        runtime.observe_navigation("http://localhost:3000/", true, false);
        runtime.observe_navigation("http://localhost:3000/", false, true);
        runtime.observe_navigation("http://localhost:3000/", false, true);

        assert_eq!(runtime.history, ["http://localhost:3000/".to_string()]);
        assert_eq!(runtime.history_index, 0);
    }

    #[test]
    fn failed_navigation_rolls_back_history_and_snapshot() {
        let mut runtime = preview_runtime();
        runtime.begin_push("http://localhost:3000/failing");
        runtime.rollback_navigation();

        assert_eq!(runtime.history, ["http://localhost:3000/".to_string()]);
        let snapshot = runtime.snapshot.unwrap();
        assert_eq!(snapshot.url, "http://localhost:3000/");
        assert!(!snapshot.loading);
    }

    #[test]
    fn sync_replaces_current_url_without_inventing_history() {
        let mut runtime = preview_runtime();
        runtime.sync_current_url("http://localhost:3000/final");

        assert_eq!(runtime.history, ["http://localhost:3000/final".to_string()]);
        assert_eq!(runtime.history_index, 0);
    }

    #[test]
    fn sync_during_pending_push_preserves_the_previous_history_entry() {
        let mut runtime = preview_runtime();
        runtime.begin_push("http://localhost:3000/next");

        runtime.sync_current_url("http://localhost:3000/next");
        runtime.observe_navigation("http://localhost:3000/next", false, true);

        assert_eq!(
            runtime.history,
            [
                "http://localhost:3000/".to_string(),
                "http://localhost:3000/next".to_string()
            ]
        );
        assert_eq!(runtime.history_index, 1);
        assert!(runtime.snapshot.as_ref().unwrap().can_go_back);
    }

    #[test]
    fn workspace_identity_is_case_insensitive_only_on_windows() {
        let upper = workspace_identity(Path::new(r"C:\Users\Me\Project"));
        let slash = workspace_identity(Path::new("C:/Users/Me/Project"));
        assert_eq!(upper, slash);
        if cfg!(windows) {
            assert_eq!(upper, workspace_identity(Path::new("c:/users/me/project")));
        }
    }

    #[test]
    fn discovers_an_open_local_port() {
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        assert_eq!(
            discover_ports(&[port]),
            vec![DiscoveredLocalServer {
                port,
                url: format!("http://localhost:{port}/"),
            }]
        );
    }

    #[test]
    fn snapshot_png_dimensions_reject_invalid_or_empty_images() {
        let mut png = vec![0_u8; 24];
        png[..8].copy_from_slice(b"\x89PNG\r\n\x1a\n");
        png[16..20].copy_from_slice(&1280_u32.to_be_bytes());
        png[20..24].copy_from_slice(&800_u32.to_be_bytes());
        assert_eq!(png_dimensions(&png), Ok((1280, 800)));

        png[16..20].copy_from_slice(&0_u32.to_be_bytes());
        assert!(png_dimensions(&png).is_err());
        assert!(png_dimensions(b"not a png").is_err());
    }
}
