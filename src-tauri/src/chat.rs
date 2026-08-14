use crate::auth::{get_access_token, AuthState};
use crate::openai_auth::{self, OpenAIAuthState};
use crate::paths::{redact_secrets, redact_tool_arguments, require_registered_root};
use crate::permission::{approval_reason, tool_needs_approval, AgentMode, PermissionMode};
use crate::project::build_project_context;
use crate::prompts::{
    format_cli_system_prompt, format_general_system_prompt, format_project_fallback_prompt,
    format_system_prompt, MAX_STEPS_REMINDER, PROGRESS_CHECK_REMINDER, TOOL_FAILURE_NUDGE,
    TOOL_PROTOCOL_NUDGE,
};
use crate::provider::{provider_of_model, ModelProvider};
use crate::provider_output::ProviderLineBuffer;
use crate::snapshot::SnapshotState;
use crate::subagent::{tool_requires_serial, SubagentHost};
use crate::tools::{
    canonical_tool_name_pub, execute_tool_with_depth, tool_definitions_for, MutationCapture,
    ToolOutcome,
};
use futures_util::{Stream, StreamExt};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet, VecDeque};
use std::future::Future;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};
use tauri::{AppHandle, State};
use tokio::sync::oneshot;

const API_BASE: &str = "https://api.x.ai/v1";
const MAX_AGENT_ROUNDS: usize = 24;
/// Soft checkpoints so multi-step coding does not wander for a dozen rounds.
const AGENT_PROGRESS_CHECK_ROUNDS: &[usize] = &[6, 12, 18];
/// SuperGrok Heavy can sit silent for minutes while reasoning before the first
/// delta. Idle is "no bytes on the wire", not wall-clock think time alone.
const STREAM_IDLE_TIMEOUT: Duration = Duration::from_secs(600);
pub(crate) const STREAM_MAX_RETRIES: u32 = 5;
const STREAM_RETRY_BASE_DELAY: Duration = Duration::from_secs(2);
/// Same tool signature this many times in a row forces a final answer.
const DOOM_LOOP_LIMIT: usize = 3;
/// Same tool *name* thrashing (args changing slightly) also forces final.
const DOOM_LOOP_NAME_LIMIT: usize = 5;
/// Keep read-only subagent fan-out below provider concurrency/rate-limit bursts.
const MAX_PARALLEL_SUBAGENTS: usize = 3;

const MAX_PENDING_CANCELLATIONS: usize = 256;
const STREAM_CANCEL_POLL_INTERVAL: Duration = Duration::from_millis(50);

/// Per-request cancel flag. Multiple chats can stream in parallel.
struct LiveStream {
    request_id: String,
    cancelled: AtomicBool,
    /// Bumped if the same stream_id is reused so a stale loop exits.
    generation: AtomicU64,
}

#[derive(Default)]
struct StreamRegistry {
    live: HashMap<String, Arc<LiveStream>>,
    cancelled_before_begin: HashSet<(String, String)>,
    cancellation_order: VecDeque<(String, String)>,
}

impl StreamRegistry {
    fn remember_cancellation(&mut self, stream_id: &str, request_id: &str) {
        let key = (stream_id.to_string(), request_id.to_string());
        if self.cancelled_before_begin.insert(key.clone()) {
            self.cancellation_order.push_back(key);
        }
        while self.cancellation_order.len() > MAX_PENDING_CANCELLATIONS {
            if let Some(oldest) = self.cancellation_order.pop_front() {
                self.cancelled_before_begin.remove(&oldest);
            }
        }
    }

    fn take_cancellation(&mut self, stream_id: &str, request_id: &str) -> bool {
        let key = (stream_id.to_string(), request_id.to_string());
        if !self.cancelled_before_begin.remove(&key) {
            return false;
        }
        self.cancellation_order.retain(|item| item != &key);
        true
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ApprovalDecision {
    Allow,
    Deny,
}

/// One parked tool waiting for the user (Ask permission mode).
struct PendingApproval {
    tx: oneshot::Sender<ApprovalDecision>,
}

#[derive(Debug)]
enum UserInputDecision {
    Answer(Vec<Vec<String>>),
    Reject,
}

struct PendingUserInput {
    tx: oneshot::Sender<UserInputDecision>,
}

/// Registry of in-flight chat streams keyed by client stream id (thread id).
pub struct StreamControl {
    streams: Mutex<StreamRegistry>,
    /// `(stream_id, tool_id)` → oneshot for approve/deny.
    pending: Mutex<HashMap<(String, String), PendingApproval>>,
    pending_user_input: Mutex<HashMap<(String, String), PendingUserInput>>,
}

impl StreamControl {
    pub fn new() -> Self {
        Self {
            streams: Mutex::new(StreamRegistry::default()),
            pending: Mutex::new(HashMap::new()),
            pending_user_input: Mutex::new(HashMap::new()),
        }
    }

    fn begin(&self, stream_id: &str, request_id: &str) -> (Arc<LiveStream>, u64) {
        let mut registry = self.streams.lock().expect("stream map");
        if let Some(existing) = registry.live.get(stream_id) {
            existing.cancelled.store(true, Ordering::SeqCst);
            let _ = existing.generation.fetch_add(1, Ordering::SeqCst);
        }
        let cancelled = registry.take_cancellation(stream_id, request_id);
        let live = Arc::new(LiveStream {
            request_id: request_id.to_string(),
            cancelled: AtomicBool::new(cancelled),
            generation: AtomicU64::new(1),
        });
        registry
            .live
            .insert(stream_id.to_string(), Arc::clone(&live));
        drop(registry);
        // Drop any leftover approvals from a previous generation of this stream.
        self.clear_pending_for_stream(stream_id);
        (live, 1)
    }

    fn end(&self, stream_id: &str, completed: &Arc<LiveStream>) {
        let mut registry = self.streams.lock().expect("stream map");
        let drop_entry = registry
            .live
            .get(stream_id)
            .map(|current| Arc::ptr_eq(current, completed))
            .unwrap_or(false);
        if !drop_entry {
            return;
        }
        registry.live.remove(stream_id);
        drop(registry);
        self.clear_pending_for_stream(stream_id);
    }

    fn cancel(&self, stream_id: &str, request_id: &str) {
        let should_clear_approvals = {
            let mut registry = self.streams.lock().expect("stream map");
            let matching = registry
                .live
                .get(stream_id)
                .filter(|live| live.request_id == request_id)
                .cloned();
            if let Some(live) = matching {
                live.cancelled.store(true, Ordering::SeqCst);
                true
            } else {
                registry.remember_cancellation(stream_id, request_id);
                false
            }
        };
        if should_clear_approvals {
            self.clear_pending_for_stream(stream_id);
        }
    }

    fn clear_pending_for_stream(&self, stream_id: &str) {
        let mut pending = self.pending.lock().expect("pending map");
        let keys: Vec<(String, String)> = pending
            .keys()
            .filter(|(s, _)| s == stream_id)
            .cloned()
            .collect();
        for key in keys {
            if let Some(p) = pending.remove(&key) {
                let _ = p.tx.send(ApprovalDecision::Deny);
            }
        }
        drop(pending);

        let mut pending_user_input = self
            .pending_user_input
            .lock()
            .expect("pending user input map");
        let keys: Vec<(String, String)> = pending_user_input
            .keys()
            .filter(|(s, _)| s == stream_id)
            .cloned()
            .collect();
        for key in keys {
            if let Some(p) = pending_user_input.remove(&key) {
                let _ = p.tx.send(UserInputDecision::Reject);
            }
        }
    }

    pub(crate) fn register_approval(
        &self,
        stream_id: &str,
        tool_id: &str,
    ) -> Result<oneshot::Receiver<ApprovalDecision>, String> {
        let (tx, rx) = oneshot::channel();
        let mut pending = self.pending.lock().expect("pending map");
        let key = (stream_id.to_string(), tool_id.to_string());
        if pending.contains_key(&key) {
            return Err("Approval already pending for this tool".into());
        }
        pending.insert(key, PendingApproval { tx });
        Ok(rx)
    }

    fn resolve_approval(
        &self,
        stream_id: &str,
        tool_id: &str,
        decision: ApprovalDecision,
    ) -> Result<(), String> {
        let mut pending = self.pending.lock().expect("pending map");
        let key = (stream_id.to_string(), tool_id.to_string());
        match pending.remove(&key) {
            Some(p) => {
                let _ = p.tx.send(decision);
                Ok(())
            }
            None => Err("No pending approval for this tool".into()),
        }
    }

    fn register_user_input(
        &self,
        stream_id: &str,
        request_id: &str,
    ) -> Result<oneshot::Receiver<UserInputDecision>, String> {
        let (tx, rx) = oneshot::channel();
        let mut pending = self
            .pending_user_input
            .lock()
            .expect("pending user input map");
        let key = (stream_id.to_string(), request_id.to_string());
        if pending.contains_key(&key) {
            return Err("User input is already pending for this request".into());
        }
        pending.insert(key, PendingUserInput { tx });
        Ok(rx)
    }

    fn resolve_user_input(
        &self,
        stream_id: &str,
        request_id: &str,
        decision: UserInputDecision,
    ) -> Result<(), String> {
        let mut pending = self
            .pending_user_input
            .lock()
            .expect("pending user input map");
        let key = (stream_id.to_string(), request_id.to_string());
        match pending.remove(&key) {
            Some(p) => {
                let _ = p.tx.send(decision);
                Ok(())
            }
            None => Err("No pending user-input request".into()),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ImageUrlPart {
    pub url: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum ContentPart {
    #[serde(rename = "text")]
    Text { text: String },
    #[serde(rename = "image_url")]
    ImageUrl { image_url: ImageUrlPart },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(untagged)]
pub enum ChatContent {
    Text(String),
    Parts(Vec<ContentPart>),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FunctionCallIn {
    pub name: String,
    pub arguments: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolCallIn {
    pub id: String,
    #[serde(rename = "type", default = "default_type")]
    pub kind: String,
    pub function: FunctionCallIn,
}

fn default_type() -> String {
    "function".into()
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct UserInputOption {
    pub label: String,
    pub description: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct UserInputQuestion {
    pub header: String,
    pub question: String,
    #[serde(default)]
    pub options: Vec<UserInputOption>,
    #[serde(default)]
    pub multiple: bool,
    #[serde(default = "default_true")]
    pub custom: bool,
}

fn default_true() -> bool {
    true
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatMessageIn {
    pub role: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub content: Option<ChatContent>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_calls: Option<Vec<ToolCallIn>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_call_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind")]
pub enum StreamEvent {
    #[serde(rename = "content")]
    Content { text: String },
    #[serde(rename = "thinking")]
    Thinking { text: String },
    /// Field names are camelCase for the webview (`awaitingApproval`, `parentId`, …).
    /// `rename_all` on the enum only renames variants — put it on each struct variant.
    #[serde(rename = "tool_start", rename_all = "camelCase")]
    ToolStart {
        id: String,
        name: String,
        args: String,
        /// When true the tool is parked until the user approves (Ask mode).
        #[serde(default)]
        awaiting_approval: bool,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        approval_reason: Option<String>,
        /// When set, this tool is a nested child of a parent `task` tool call.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        parent_id: Option<String>,
    },
    #[serde(rename = "tool_result", rename_all = "camelCase")]
    ToolResult {
        id: String,
        name: String,
        ok: bool,
        result: String,
        /// When set, this tool is a nested child of a parent `task` tool call.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        parent_id: Option<String>,
        /// Image data URL produced by a multimodal read (UI preview only —
        /// the model receives it as a vision content part in history).
        #[serde(default, skip_serializing_if = "Option::is_none")]
        image_url: Option<String>,
    },
    /// Incremental output from a running tool (foreground bash stdout/stderr).
    #[serde(rename = "tool_output", rename_all = "camelCase")]
    ToolOutput {
        id: String,
        text: String,
        replace: bool,
    },
    #[serde(rename = "user_input_requested", rename_all = "camelCase")]
    UserInputRequested {
        request_id: String,
        questions: Vec<UserInputQuestion>,
    },
    #[serde(rename = "user_input_resolved", rename_all = "camelCase")]
    UserInputResolved { request_id: String },
    #[serde(rename = "usage", rename_all = "camelCase")]
    Usage {
        input_tokens: u64,
        output_tokens: u64,
        total_tokens: u64,
    },
}

#[derive(Debug, Deserialize)]
struct StreamChunk {
    #[serde(default)]
    choices: Vec<StreamChoice>,
}

#[derive(Debug, Deserialize)]
struct StreamChoice {
    #[serde(default)]
    delta: StreamDelta,
    #[serde(default)]
    finish_reason: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
struct StreamDelta {
    #[serde(default)]
    content: Option<String>,
    #[serde(default)]
    reasoning_content: Option<String>,
    #[serde(default)]
    reasoning: Option<String>,
    #[serde(default)]
    tool_calls: Option<Vec<ToolCallDelta>>,
}

#[derive(Debug, Default, Deserialize)]
struct ToolCallDelta {
    #[serde(default)]
    index: usize,
    #[serde(default)]
    id: Option<String>,
    #[serde(default)]
    function: Option<ToolFnDelta>,
}

#[derive(Debug, Default, Deserialize)]
struct ToolFnDelta {
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    arguments: Option<String>,
}

#[derive(Debug, Default, Clone)]
pub(crate) struct AccumToolCall {
    pub id: String,
    /// Responses API `call_id` (what `function_call_output` references).
    /// Chat-completions providers leave this empty and reuse `id`.
    pub call_id: String,
    pub name: String,
    pub arguments: String,
}

fn should_stop(live: &LiveStream, my_gen: u64) -> bool {
    live.cancelled.load(Ordering::SeqCst) || live.generation.load(Ordering::SeqCst) != my_gen
}

/// Cancel predicate shared by every streaming layer.
pub(crate) type StopCheck<'a> = &'a (dyn Fn() -> bool + Send + Sync);

pub(crate) enum StreamWait<T> {
    Item(Option<T>),
    Cancelled,
    TimedOut,
}

pub(crate) async fn next_stream_item_or_stop<S>(
    stream: &mut S,
    stop: StopCheck<'_>,
    wait: Duration,
) -> StreamWait<S::Item>
where
    S: Stream + Unpin,
{
    let deadline = Instant::now() + wait;
    loop {
        if stop() {
            return StreamWait::Cancelled;
        }
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return StreamWait::TimedOut;
        }
        match tokio::time::timeout(remaining.min(STREAM_CANCEL_POLL_INTERVAL), stream.next()).await
        {
            Ok(item) => return StreamWait::Item(item),
            Err(_) => continue,
        }
    }
}

pub(crate) async fn future_or_stop<F>(future: F, stop: StopCheck<'_>) -> Option<F::Output>
where
    F: Future,
{
    tokio::pin!(future);
    loop {
        if stop() {
            return None;
        }
        match tokio::time::timeout(STREAM_CANCEL_POLL_INTERVAL, &mut future).await {
            Ok(output) => return Some(output),
            Err(_) => continue,
        }
    }
}

/// True when assistant "content" is mostly internal process dump (not a real answer).
fn is_process_monologue(text: &str) -> bool {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return false;
    }
    // Real answers usually include code fences or substantial structure.
    if trimmed.contains("```") {
        return false;
    }
    let markers = [
        "i'll inspect",
        "i'll edit",
        "i'll update",
        "i'll replace",
        "i'll add",
        "i'll fix",
        "i'll implement",
        "i will inspect",
        "i will edit",
        "i will implement",
        "implementing now",
        "implementing the",
        "making the edit",
        "making the change",
        "applying the",
        "applying patch",
        "updating files",
        "updating the",
        "editing files",
        "writing the code",
        "coding it",
        "next i'll",
        "next i will",
        "let me inspect",
        "let me edit",
        "let me update",
        "let me check",
        "here is what i will",
        "i'm going to edit",
        "i am going to edit",
        "proceeding with",
        "applying changes",
        "patching now",
        "doing the edit",
        "starting the edit",
    ];
    let lines: Vec<&str> = trimmed
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .collect();
    if lines.is_empty() {
        return false;
    }
    let hits = lines
        .iter()
        .filter(|line| {
            let lower = line.to_ascii_lowercase();
            markers.iter().any(|m| lower.contains(m))
        })
        .count();
    // ≥30% monologue lines, or short all-monologue blurb.
    hits * 10 >= lines.len() * 3 || (lines.len() <= 6 && hits >= 2)
}

fn strip_monologue_lines(text: &str) -> String {
    let markers = [
        "i'll inspect",
        "i'll edit",
        "i'll update",
        "i'll replace",
        "i'll implement",
        "implementing now",
        "making the edit",
        "applying the",
        "updating files",
        "next i'll",
        "let me inspect",
        "let me edit",
        "let me update",
        "here is what i will",
        "proceeding with",
        "i'm going to edit",
    ];
    text.lines()
        .filter(|line| {
            let t = line.trim();
            if t.is_empty() {
                return true;
            }
            let lower = t.to_ascii_lowercase();
            !markers.iter().any(|m| lower.contains(m))
        })
        .collect::<Vec<_>>()
        .join("\n")
        .trim()
        .to_string()
}

/// "functions.<tool>" followed by "(" or a "key=" argument is a protocol
/// call; plain prose such as "functions.php handles routing." must NOT match.
fn looks_like_functions_call(lower: &str) -> bool {
    let Some(rest) = lower.strip_prefix("functions.") else {
        return false;
    };
    let name_end = rest
        .find(|c: char| !(c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_'))
        .unwrap_or(rest.len());
    if name_end == 0 {
        return false;
    }
    let after = rest[name_end..].trim_start();
    if after.starts_with('(') {
        return true;
    }
    // "key=" argument; the key must start with a lowercase letter or '_'.
    let first = after.as_bytes().first().copied().unwrap_or(0);
    if !(first.is_ascii_lowercase() || first == b'_') {
        return false;
    }
    let key_end = after
        .find(|c: char| !(c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_'))
        .unwrap_or(after.len());
    after[key_end..].trim_start().starts_with('=')
}

/// Detect model text containing internal tool-call protocol or transcripts.
fn contains_tool_protocol(text: &str) -> bool {
    let lower = text.to_ascii_lowercase();

    fn starts_with_protocol_field(line: &str, field: &str) -> bool {
        let Some(rest) = line.strip_prefix(field) else {
            return false;
        };
        let rest = rest.trim_start();
        rest.is_empty()
            || matches!(
                rest.chars().next(),
                Some(':') | Some('=') | Some('{') | Some('[')
            )
    }

    fn is_tool_protocol_line(line: &str) -> bool {
        let lower = line.trim().to_ascii_lowercase();
        if lower.is_empty() {
            return false;
        }
        if lower.starts_with("assistant to=")
            || lower.starts_with("analysis to=")
            || lower.starts_with("commentary to=")
            || lower.starts_with("to=functions")
            || lower.starts_with("recipient=functions.")
            || looks_like_functions_call(&lower)
            || ((lower.starts_with("assistant ")
                || lower.starts_with("analysis ")
                || lower.starts_with("commentary "))
                && lower.contains("functions."))
        {
            return true;
        }
        if (lower.starts_with("invoke tool ") || lower.starts_with("invoking tool "))
            && (lower.contains(" path ")
                || lower.contains(" filepath")
                || lower.contains(" arguments")
                || lower.contains(" command "))
        {
            return true;
        }
        [
            "recipient_name",
            "tool_call",
            "tool_result",
            "tool_use",
            "tool_request",
            "function_call",
            "call_tool",
            "run_tool",
        ]
        .iter()
        .any(|field| starts_with_protocol_field(&lower, field))
    }

    let markers = [
        "[tool",
        "<tool",
        "</tool",
        "<function",
        "</function",
        "<parameter",
        "</parameter",
        "<|recipient|>",
        "<|channel|>",
        "<|tool",
    ];
    if markers.iter().any(|marker| lower.contains(marker)) {
        return true;
    }
    if lower.lines().any(is_tool_protocol_line) {
        return true;
    }

    // Compact dumps: `tool grep · path …` / `[tool read · filePath …]`
    if lower.contains('·')
        && (lower.contains(" path ")
            || lower.contains(" filepath ")
            || lower.contains(" pattern ")
            || lower.contains(" offset ")
            || lower.contains(" command ")
            || lower.contains(" filepath")
            || lower.contains("·path")
            || lower.contains("·filepath")
            || lower.contains("·pattern"))
        && (lower.contains("tool ")
            || lower.contains("[tool")
            || lower.contains("grep")
            || lower.contains("read")
            || lower.contains("edit")
            || lower.contains("bash")
            || lower.contains("glob")
            || lower.contains("write"))
    {
        return true;
    }

    // Multi-tool dump lines: `tool grep · path …`
    if lower.lines().any(|line| {
        let t = line.trim_start();
        t.starts_with("tool ")
            && (t.contains('·')
                || t.contains(" path ")
                || t.contains(" filepath ")
                || t.contains(" pattern "))
    }) {
        return true;
    }

    let compact: String = lower.chars().filter(|c| !c.is_whitespace()).collect();
    if compact.contains("\"type\":\"function\"")
        && compact.contains("\"name\":")
        && (compact.contains("\"arguments\":") || compact.contains("\"parameters\":"))
    {
        return true;
    }
    if compact.contains("\"tool_calls\":[") || compact.contains("\"function_call\":{") {
        return true;
    }
    // Bare tool-call JSON envelopes.
    if (compact.contains("\"tool_calls\"") || compact.contains("\"function_call\""))
        && (compact.contains("\"name\":") || compact.contains("\"arguments\":"))
    {
        return true;
    }
    false
}

/// Remove known tool-protocol blocks; leftover prose may still be shown.
fn strip_tool_protocol(text: &str) -> String {
    let mut out = text.to_string();

    // Bracket dumps: [tool …] (may nest poorly; non-greedy until ]).
    while let Some(start) = find_ci(&out, "[tool") {
        let rest = &out[start..];
        let end = rest.find(']').map(|i| start + i + 1).unwrap_or(out.len());
        out.replace_range(start..end, " ");
    }

    // XML-ish tool / function envelopes (including self-closing-ish garbage).
    for (open, close) in [
        ("<tool_call", "</tool_call>"),
        ("<tool_use", "</tool_use>"),
        ("<tool", "</tool>"),
        ("<function_call", "</function_call>"),
        ("<function", "</function>"),
        ("<parameter", "</parameter>"),
    ] {
        while let Some(start) = find_ci(&out, open) {
            let after_open = start + open.len();
            let end = find_ci(&out[after_open..], close)
                .map(|i| after_open + i + close.len())
                .or_else(|| out[after_open..].find('>').map(|i| after_open + i + 1))
                .unwrap_or(out.len());
            out.replace_range(start..end, " ");
        }
    }

    // Channel / recipient control tokens.
    for token in [
        "<|recipient|>",
        "<|channel|>",
        "<|tool_call_begin|>",
        "<|tool_call_end|>",
        "<|tool_calls_section_begin|>",
        "<|tool_calls_section_end|>",
    ] {
        while let Some(i) = find_ci(&out, token) {
            let end = i + token.len();
            out.replace_range(i..end, " ");
        }
    }

    // Drop whole lines that are clearly protocol / transcript.
    let cleaned: String = out
        .lines()
        .filter(|line| {
            let lower = line.trim().to_ascii_lowercase();
            if lower.is_empty() {
                return true;
            }
            if lower.starts_with("assistant to=")
                || lower.starts_with("analysis to=")
                || lower.starts_with("commentary to=")
                || lower.starts_with("to=functions")
                || lower.starts_with("recipient=")
                || lower.starts_with("recipient_name")
                || lower.starts_with("tool_call")
                || lower.starts_with("function_call")
                || lower.starts_with("call tool")
                || lower.starts_with("invoke tool")
                || looks_like_functions_call(&lower)
                || (lower.starts_with("tool ") && lower.contains('·'))
                || (lower.starts_with("args:") && lower.len() < 400)
                || (lower.starts_with("result:") && lower.contains("[tool"))
            {
                return false;
            }
            !contains_tool_protocol(line)
        })
        .collect::<Vec<_>>()
        .join("\n");

    // Collapse leftover blank runs.
    let mut collapsed = String::new();
    let mut blank = false;
    for line in cleaned.lines() {
        if line.trim().is_empty() {
            if !blank && !collapsed.is_empty() {
                collapsed.push('\n');
            }
            blank = true;
        } else {
            if !collapsed.is_empty() && !collapsed.ends_with('\n') {
                collapsed.push('\n');
            }
            collapsed.push_str(line.trim_end());
            blank = false;
        }
    }
    collapsed.trim().to_string()
}

fn find_ci(hay: &str, needle: &str) -> Option<usize> {
    hay.to_ascii_lowercase().find(&needle.to_ascii_lowercase())
}

/// Final user-facing text only — never emit tool protocol or process dumps.
fn sanitize_user_facing_content(text: &str) -> String {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return String::new();
    }
    // Always strip protocol first so mixed "prose + dump" cannot leak.
    let without_protocol = if contains_tool_protocol(trimmed) {
        strip_tool_protocol(trimmed)
    } else {
        trimmed.to_string()
    };
    let without_protocol = without_protocol.trim();
    if without_protocol.is_empty() || contains_tool_protocol(without_protocol) {
        return String::new();
    }
    if is_process_monologue(without_protocol) {
        let stripped = strip_monologue_lines(without_protocol);
        if stripped.is_empty()
            || is_process_monologue(&stripped)
            || contains_tool_protocol(&stripped)
        {
            return String::new();
        }
        return stripped;
    }
    let stripped = strip_monologue_lines(without_protocol);
    if contains_tool_protocol(&stripped) {
        return String::new();
    }
    stripped
}

/// Thinking channel: allow short rationale, never tool protocol.
fn sanitize_thinking_content(text: &str) -> String {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return String::new();
    }
    if contains_tool_protocol(trimmed) {
        let stripped = strip_tool_protocol(trimmed);
        if stripped.is_empty() || contains_tool_protocol(&stripped) {
            return String::new();
        }
        return stripped;
    }
    trimmed.to_string()
}

fn tool_batch_signature(tools: &[AccumToolCall]) -> String {
    let mut parts: Vec<String> = tools
        .iter()
        .map(|t| format!("{}:{}", t.name, t.arguments.trim()))
        .collect();
    parts.sort();
    parts.join("||")
}

fn format_reqwest_error(err: &reqwest::Error) -> String {
    let mut parts = vec![err.to_string()];
    let mut source = std::error::Error::source(err);
    while let Some(s) = source {
        parts.push(s.to_string());
        source = s.source();
    }
    parts.join(" → ")
}

fn is_transient_reqwest_error(err: &reqwest::Error) -> bool {
    err.is_connect()
        || err.is_timeout()
        || err.is_request()
        || err.is_body()
        || err.is_decode()
        || err
            .status()
            .map(|s| is_transient_http_status(s.as_u16()))
            .unwrap_or(false)
}

fn is_transient_http_status(status: u16) -> bool {
    matches!(status, 408 | 409 | 425 | 429 | 500 | 502 | 503 | 504 | 524)
}

fn safe_chat_http_error(status: u16) -> String {
    match status {
        401 => "Sign in again to continue.".into(),
        402 => "Usage limit reached.".into(),
        403 => "The request is not allowed with the current permissions.".into(),
        408 | 504 => "The request timed out.".into(),
        409 | 425 | 429 => "The service is receiving too many requests.".into(),
        500..=599 => "The model service is temporarily unavailable.".into(),
        _ => "The model could not accept this request.".into(),
    }
}

/// Extract a safe, actionable detail from a provider error body
/// (e.g. `{"error":{"message":"context length exceeded"}}`). Reads a bounded
/// prefix only, and redacts anything secret-shaped before returning.
pub(crate) async fn provider_error_detail(
    response: reqwest::Response,
    stop: StopCheck<'_>,
) -> Option<String> {
    const MAX_DETAIL_BYTES: usize = 8 * 1024;
    const ERROR_BODY_IDLE_TIMEOUT: Duration = Duration::from_secs(5);
    let mut bytes = Vec::new();
    let mut stream = response.bytes_stream();
    loop {
        let item = match next_stream_item_or_stop(&mut stream, stop, ERROR_BODY_IDLE_TIMEOUT).await
        {
            StreamWait::Item(Some(item)) => item,
            StreamWait::Item(None) | StreamWait::Cancelled | StreamWait::TimedOut => break,
        };
        let Ok(chunk) = item else {
            break;
        };
        let take = MAX_DETAIL_BYTES
            .saturating_sub(bytes.len())
            .min(chunk.len());
        if take == 0 {
            break;
        }
        bytes.extend_from_slice(&chunk[..take]);
        if bytes.len() >= MAX_DETAIL_BYTES {
            break;
        }
    }
    let text = String::from_utf8_lossy(&bytes);
    let value: Value = serde_json::from_str(&text).ok()?;
    let msg = value
        .pointer("/error/message")
        .and_then(Value::as_str)
        .or_else(|| value.pointer("/message").and_then(Value::as_str))?;
    let msg = redact_secrets(msg.trim());
    let msg = msg.trim();
    if msg.is_empty() {
        return None;
    }
    Some(msg.chars().take(240).collect())
}

/// Append a provider-supplied detail to a generic status message, if present.
pub(crate) fn with_provider_detail(base: String, detail: Option<String>) -> String {
    match detail {
        Some(d) if !d.is_empty() => format!("{base} Provider said: {d}"),
        _ => base,
    }
}

/// Body/stream failures from reqwest often surface as "error decoding response body".
pub(crate) fn is_transient_stream_error_msg(msg: &str) -> bool {
    let lower = msg.to_ascii_lowercase();
    lower.contains("stream stalled")
        || lower.contains("error decoding response body")
        || lower.contains("network error")
        || lower.contains("connection error")
        || lower.contains("connection lost")
        || lower.contains("connection reset")
        || lower.contains("connection abort")
        || lower.contains("broken pipe")
        || lower.contains("connection closed")
        || lower.contains("unexpected eof")
        || lower.contains("incomplete message")
        || lower.contains("timed out")
        || lower.contains("timeout")
        || lower.contains("error sending request")
        || lower.contains("fetch failed")
        || lower.contains("socket hang up")
        || lower.contains("terminated")
        || lower.contains("stream ended without")
        || lower.contains("connection refused")
        || lower.contains("dns error")
        || lower.contains("reset without closing")
}

fn stream_idle_remaining(
    last_progress: Instant,
    now: Instant,
    limit: Duration,
) -> Option<Duration> {
    limit
        .checked_sub(now.saturating_duration_since(last_progress))
        .filter(|remaining| !remaining.is_zero())
}

pub(crate) fn stream_retry_delay(retry_index: u32) -> Duration {
    STREAM_RETRY_BASE_DELAY.saturating_mul(2_u32.saturating_pow(retry_index))
}

fn should_request_progress_check(round: usize, tools_enabled: bool, force_final: bool) -> bool {
    tools_enabled && !force_final && AGENT_PROGRESS_CHECK_ROUNDS.contains(&round)
}

async fn wait_for_stream_retry(stop: StopCheck<'_>, delay: Duration) -> bool {
    let deadline = Instant::now() + delay;
    loop {
        if stop() {
            return false;
        }
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return true;
        }
        tokio::time::sleep(remaining.min(Duration::from_millis(100))).await;
    }
}

fn build_http_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(20))
        // No whole-request timeout: reasoning SSE + multi-minute tool rounds
        // idle between tokens. User cancel goes through StreamControl.
        .pool_idle_timeout(std::time::Duration::from_secs(90))
        .pool_max_idle_per_host(4)
        .tcp_nodelay(true)
        .tcp_keepalive(std::time::Duration::from_secs(30))
        // SSE chat streams are more reliable on HTTP/1.1 with this stack.
        .http1_only()
        .user_agent(concat!("GrokDesktop/", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|e| format!("http client: {e}"))
}

/// Reuse one pooled client across agent rounds and parallel chats.
fn shared_http_client() -> Result<reqwest::Client, String> {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    if let Some(c) = CLIENT.get() {
        return Ok(c.clone());
    }
    let built = build_http_client()?;
    Ok(CLIENT.get_or_init(|| built).clone())
}

async fn post_chat_completions(
    client: &reqwest::Client,
    token: &str,
    body: &Value,
    stop: StopCheck<'_>,
) -> Result<Option<reqwest::Response>, String> {
    const MAX_ATTEMPTS: u32 = 3;
    let mut last_err = String::new();

    for attempt in 1..=MAX_ATTEMPTS {
        let request = client
            .post(format!("{API_BASE}/chat/completions"))
            .bearer_auth(token)
            .header("Accept", "text/event-stream")
            .header("Cache-Control", "no-cache")
            .json(body)
            .send();
        let Some(result) = future_or_stop(request, stop).await else {
            return Ok(None);
        };
        match result {
            Ok(response) => {
                // Retry transient HTTP statuses with a fresh connection.
                if matches!(
                    response.status().as_u16(),
                    408 | 409 | 425 | 429 | 500 | 502 | 503 | 504 | 524
                ) && attempt < MAX_ATTEMPTS
                {
                    let status = response.status().as_u16();
                    last_err = safe_chat_http_error(status);
                    if !wait_for_stream_retry(stop, Duration::from_millis(400 * u64::from(attempt)))
                        .await
                    {
                        return Ok(None);
                    }
                    continue;
                }
                return Ok(Some(response));
            }
            Err(err) => {
                last_err = format!("chat request: {}", format_reqwest_error(&err));
                if attempt < MAX_ATTEMPTS && is_transient_reqwest_error(&err) {
                    if !wait_for_stream_retry(stop, Duration::from_millis(400 * u64::from(attempt)))
                        .await
                    {
                        return Ok(None);
                    }
                    continue;
                }
                return Err(last_err);
            }
        }
    }

    Err(last_err)
}

#[derive(Default, Clone)]
pub(crate) struct RoundStreamOut {
    pub content: String,
    pub reasoning: String,
    pub tools: HashMap<usize, AccumToolCall>,
    pub finish_reason: Option<String>,
    /// Kept false while reasoning is buffered for whole-message sanitization.
    pub thinking_emitted_live: bool,
    /// Responses API only: completed output items (message / reasoning /
    /// function_call) to append to the next turn's input. Empty for Grok.
    pub output_items: Vec<Value>,
    pub usage: Option<crate::openai::ResponsesUsage>,
}

/// Drain one chat-completion SSE response into accumulated content / tools / thinking.
/// A normal result requires the provider's terminal `[DONE]` marker. Cancellation
/// remains a successful stop so callers can discard the partial turn cleanly.
async fn drain_chat_sse(
    response: reqwest::Response,
    stop: StopCheck<'_>,
) -> Result<RoundStreamOut, String> {
    drain_chat_sse_with_idle_timeout(response, stop, STREAM_IDLE_TIMEOUT).await
}

pub(crate) async fn drain_chat_sse_with_idle_timeout(
    response: reqwest::Response,
    stop: StopCheck<'_>,
    idle_timeout: Duration,
) -> Result<RoundStreamOut, String> {
    let mut line_buffer = ProviderLineBuffer::default();
    let mut stream = response.bytes_stream();
    let mut out = RoundStreamOut::default();
    let mut terminal = false;
    // Any on-wire bytes count as liveness (SSE comments, role-only deltas, pings).
    let mut last_progress = Instant::now();

    'byte_stream: loop {
        if stop() {
            return Ok(out);
        }
        let Some(wait) = stream_idle_remaining(last_progress, Instant::now(), idle_timeout) else {
            if stop() {
                return Ok(out);
            }
            return Err(format!(
                "Stream stalled: no model events for {} seconds.",
                idle_timeout.as_secs()
            ));
        };
        let item = match next_stream_item_or_stop(&mut stream, stop, wait).await {
            StreamWait::Item(Some(item)) => item,
            StreamWait::Item(None) => break,
            StreamWait::Cancelled => return Ok(out),
            StreamWait::TimedOut => {
                if stop() {
                    return Ok(out);
                }
                return Err(format!(
                    "Stream stalled: no model events for {} seconds.",
                    idle_timeout.as_secs()
                ));
            }
        };
        let bytes = match item {
            Ok(b) => b,
            Err(e) => {
                if stop() {
                    return Ok(out);
                }
                return Err(format!("stream read: {}", format_reqwest_error(&e)));
            }
        };
        // Connection is alive — reset idle even before a parseable model event.
        last_progress = Instant::now();
        if bytes.is_empty() {
            continue;
        }
        let lines = match line_buffer.push(&bytes) {
            Ok(lines) => lines,
            Err(_) if stop() => return Ok(out),
            Err(error) => return Err(error),
        };
        for line in lines {
            if apply_chat_sse_line(&mut out, &line) {
                terminal = true;
                break 'byte_stream;
            }
        }
    }

    if !terminal {
        let lines = match line_buffer.finish() {
            Ok(lines) => lines,
            Err(_) if stop() => return Ok(out),
            Err(error) => return Err(error),
        };
        for line in lines {
            if apply_chat_sse_line(&mut out, &line) {
                terminal = true;
                break;
            }
        }
    }

    if terminal || stop() {
        Ok(out)
    } else {
        Err("Chat stream ended without a terminal [DONE] marker.".into())
    }
}

fn apply_chat_sse_line(out: &mut RoundStreamOut, line: &str) -> bool {
    let Some(data) = line.strip_prefix("data:").map(str::trim) else {
        return false;
    };
    if data.is_empty() {
        return false;
    }
    if data == "[DONE]" {
        return true;
    }
    let Ok(chunk) = serde_json::from_str::<StreamChunk>(data) else {
        return false;
    };
    for choice in chunk.choices {
        if let Some(fr) = choice.finish_reason {
            out.finish_reason = Some(fr);
        }
        if let Some(text) = choice.delta.reasoning_content.or(choice.delta.reasoning) {
            if !text.is_empty() {
                out.reasoning.push_str(&text);
            }
        }
        if let Some(text) = choice.delta.content {
            if !text.is_empty() {
                out.content.push_str(&text);
            }
        }
        if let Some(tcs) = choice.delta.tool_calls {
            for tc in tcs {
                let entry = out.tools.entry(tc.index).or_default();
                if let Some(id) = tc.id {
                    if !id.is_empty() {
                        entry.id = id;
                    }
                }
                if let Some(f) = tc.function {
                    if let Some(n) = f.name {
                        if !n.is_empty() {
                            entry.name = n;
                        }
                    }
                    if let Some(a) = f.arguments {
                        entry.arguments.push_str(&a);
                    }
                }
            }
        }
    }
    false
}

/// POST + drain with retry when the TCP/TLS body dies mid-stream (common on long reasoning).
async fn stream_chat_round(
    client: &reqwest::Client,
    token: &str,
    body: &Value,
    stop: StopCheck<'_>,
) -> Result<RoundStreamOut, String> {
    let mut last_err = String::new();

    for attempt in 0..=STREAM_MAX_RETRIES {
        if stop() {
            return Ok(RoundStreamOut::default());
        }

        // Final reconnect favors a quick completion over another long silent
        // reasoning phase. Earlier attempts preserve the user's chosen effort.
        let mut fallback_body = body.clone();
        if attempt == STREAM_MAX_RETRIES {
            if let Some(object) = fallback_body.as_object_mut() {
                object.remove("reasoning_effort");
            }
        }
        let request_body = if attempt == STREAM_MAX_RETRIES {
            &fallback_body
        } else {
            body
        };

        let response = match post_chat_completions(client, token, request_body, stop).await {
            Ok(Some(response)) => response,
            Ok(None) => return Ok(RoundStreamOut::default()),
            Err(err) => {
                last_err = err;
                if attempt < STREAM_MAX_RETRIES && is_transient_stream_error_msg(&last_err) {
                    if !wait_for_stream_retry(stop, stream_retry_delay(attempt)).await {
                        return Ok(RoundStreamOut::default());
                    }
                    continue;
                }
                return Err(last_err);
            }
        };

        if stop() {
            return Ok(RoundStreamOut::default());
        }

        if !response.status().is_success() {
            let status = response.status().as_u16();
            if attempt < STREAM_MAX_RETRIES && is_transient_http_status(status) {
                last_err = safe_chat_http_error(status);
                if !wait_for_stream_retry(stop, stream_retry_delay(attempt)).await {
                    return Ok(RoundStreamOut::default());
                }
                continue;
            }
            // Non-retryable: surface the provider's own reason when available.
            let detail = provider_error_detail(response, stop).await;
            return Err(with_provider_detail(safe_chat_http_error(status), detail));
        }

        match drain_chat_sse(response, stop).await {
            Ok(out) => return Ok(out),
            Err(err) => {
                last_err = err;
                // Empty stream + transient body error → full request retry.
                if attempt < STREAM_MAX_RETRIES && is_transient_stream_error_msg(&last_err) {
                    if !wait_for_stream_retry(stop, stream_retry_delay(attempt)).await {
                        return Ok(RoundStreamOut::default());
                    }
                    continue;
                }
                if is_transient_stream_error_msg(&last_err) {
                    return Err(format!(
                        "Chat stream failed after {STREAM_MAX_RETRIES} automatic reconnect attempts: {last_err}"
                    ));
                }
                return Err(last_err);
            }
        }
    }

    Err(last_err)
}

/// Provider-specific wire layer for one agent conversation. The loop above
/// stays provider-neutral; history shape and request/response encoding live
/// here.
pub(crate) enum ChatBackend {
    Grok {
        history: Vec<Value>,
    },
    OpenAi {
        history: crate::openai::OpenAiHistory,
        instructions: String,
        account_id: Option<String>,
    },
}

impl ChatBackend {
    pub fn new(provider: ModelProvider, system_prompt: String, account_id: Option<String>) -> Self {
        match provider {
            ModelProvider::Grok => {
                let history = vec![json!({ "role": "system", "content": system_prompt })];
                ChatBackend::Grok { history }
            }
            ModelProvider::OpenAi => ChatBackend::OpenAi {
                history: crate::openai::OpenAiHistory::new(),
                instructions: system_prompt,
                account_id,
            },
            ModelProvider::OpenCode | ModelProvider::Antigravity => {
                unreachable!("CLI providers own their agent loops and do not use ChatBackend")
            }
        }
    }

    pub fn push_client_messages(&mut self, messages: Vec<ChatMessageIn>) -> Result<(), String> {
        match self {
            ChatBackend::Grok { history } => {
                for m in messages {
                    history.push(message_to_json(m));
                }
            }
            ChatBackend::OpenAi { history, .. } => history.push_client_messages(messages),
        }
        Ok(())
    }

    pub fn push_user_text(&mut self, text: &str) {
        match self {
            ChatBackend::Grok { history } => {
                history.push(json!({ "role": "user", "content": text }));
            }
            ChatBackend::OpenAi { history, .. } => history.push_user_text(text),
        }
    }

    /// Grok quirk: after an empty/monologue final answer, mark the empty
    /// assistant turn and ask once more without tools.
    pub fn push_empty_final_retry_hint(&mut self) {
        match self {
            ChatBackend::Grok { history } => {
                history.push(json!({
                    "role": "assistant",
                    "content": Value::Null,
                }));
                history.push(json!({
                    "role": "user",
                    "content": MAX_STEPS_REMINDER,
                }));
            }
            ChatBackend::OpenAi { history, .. } => history.push_user_text(MAX_STEPS_REMINDER),
        }
    }

    /// Record the assistant side of a tool round into the wire history.
    /// `output_items` carries the Responses API completed items (empty for
    /// chat-completions providers).
    pub fn record_tool_round(&mut self, tools: &[AccumToolCall], output_items: &[Value]) {
        match self {
            ChatBackend::Grok { history } => {
                let tool_calls_json: Vec<Value> = tools
                    .iter()
                    .map(|t| {
                        json!({
                            "id": t.id,
                            "type": "function",
                            "function": {
                                "name": t.name,
                                "arguments": t.arguments,
                            }
                        })
                    })
                    .collect();
                history.push(json!({
                    "role": "assistant",
                    "content": Value::Null,
                    "tool_calls": tool_calls_json,
                }));
            }
            ChatBackend::OpenAi { history, .. } => {
                history.push_output_items(output_items.to_vec());
            }
        }
    }

    /// Record one executed tool result (and optional image) into the wire
    /// history.
    pub fn push_tool_result(
        &mut self,
        tool: &AccumToolCall,
        text: &str,
        image: Option<&crate::tools::ToolImage>,
    ) {
        match self {
            ChatBackend::Grok { history } => {
                history.push(json!({
                    "role": "tool",
                    "tool_call_id": tool.id,
                    "content": text,
                }));
                // Multimodal read: the tool message keeps the text note; the
                // image itself rides a follow-up user turn as a vision part
                // (chat-completions tool results cannot carry images).
                if let Some(img) = image {
                    history.push(json!({
                        "role": "user",
                        "content": [
                            {
                                "type": "text",
                                "text": format!(
                                    "[Image file read by the read tool: {} ({})]",
                                    img.label, img.mime
                                )
                            },
                            {
                                "type": "image_url",
                                "image_url": { "url": img.data_url }
                            }
                        ],
                    }));
                }
            }
            ChatBackend::OpenAi { history, .. } => {
                let call_id = if tool.call_id.is_empty() {
                    tool.id.as_str()
                } else {
                    tool.call_id.as_str()
                };
                history.push_tool_output(call_id, text, image.map(|img| img.data_url.as_str()));
            }
        }
    }

    /// One model round: build the provider body, stream it, accumulate
    /// (with the provider's reconnect policy).
    #[allow(clippy::too_many_arguments)]
    pub async fn stream_round(
        &mut self,
        client: &reqwest::Client,
        token: &str,
        model: &str,
        effort: Option<&str>,
        service_tier: Option<&str>,
        allow_tools: bool,
        tool_definitions: Option<Value>,
        stop: StopCheck<'_>,
    ) -> Result<RoundStreamOut, String> {
        let account_id = match self {
            ChatBackend::OpenAi { account_id, .. } => account_id.clone(),
            ChatBackend::Grok { .. } => None,
        };
        let body = self.build_body(model, effort, service_tier, allow_tools, tool_definitions)?;
        match self {
            ChatBackend::Grok { .. } => stream_chat_round(client, token, &body, stop).await,
            ChatBackend::OpenAi { .. } => {
                let out = crate::openai::stream_responses_round(
                    token,
                    account_id.as_deref(),
                    &body,
                    stop,
                )
                .await?;
                Ok(round_stream_out_from_responses(out))
            }
        }
    }

    /// Build one request body from the current history (subagent rounds own
    /// their own single-attempt streaming + retry policy).
    pub fn build_body(
        &self,
        model: &str,
        effort: Option<&str>,
        service_tier: Option<&str>,
        allow_tools: bool,
        tool_definitions: Option<Value>,
    ) -> Result<Value, String> {
        match self {
            ChatBackend::Grok { history } => {
                if service_tier.is_some() {
                    return Err("Fast mode is only available for supported OpenAI models".into());
                }
                let mut body = json!({
                    "model": model,
                    "stream": true,
                    "messages": history,
                });
                if let Some(e) = effort.map(str::trim).map(str::to_ascii_lowercase) {
                    if !e.is_empty() && e != "off" {
                        body["reasoning_effort"] = json!(e);
                    }
                }
                if allow_tools {
                    if let Some(tools) = tool_definitions {
                        body["tools"] = tools;
                        body["tool_choice"] = json!("auto");
                    }
                }
                Ok(body)
            }
            ChatBackend::OpenAi {
                history,
                instructions,
                ..
            } => {
                crate::openai::validate_chatgpt_codex_model(model)?;
                let effort_wire = crate::openai::openai_reasoning_effort(effort)?;
                let service_tier_wire = crate::openai::openai_service_tier(model, service_tier)?;
                Ok(crate::openai::build_request_body(
                    model,
                    Some(instructions),
                    history,
                    effort_wire,
                    service_tier_wire,
                    allow_tools,
                    tool_definitions
                        .as_ref()
                        .map(crate::openai::responses_tool_definitions),
                ))
            }
        }
    }
}

pub(crate) fn round_stream_out_from_responses(
    out: crate::openai::ResponsesTurnOut,
) -> RoundStreamOut {
    let mut tools = HashMap::new();
    for (index, call) in out.tools.into_iter().enumerate() {
        tools.insert(
            index,
            AccumToolCall {
                id: if call.id.is_empty() {
                    call.call_id.clone()
                } else {
                    call.id
                },
                call_id: call.call_id,
                name: call.name,
                arguments: call.arguments,
            },
        );
    }
    let finish_reason = if tools.is_empty() {
        Some("stop".to_string())
    } else {
        Some("tool_calls".to_string())
    };
    RoundStreamOut {
        content: out.content,
        reasoning: out.reasoning_summary,
        tools,
        finish_reason,
        thinking_emitted_live: false,
        output_items: out.output_items,
        usage: out.usage,
    }
}

#[derive(Deserialize)]
struct UserInputArgs {
    questions: Vec<UserInputQuestion>,
}

fn parse_user_input_questions(arguments: &str) -> Result<Vec<UserInputQuestion>, String> {
    let mut parsed: UserInputArgs = serde_json::from_str(arguments)
        .map_err(|error| format!("invalid question arguments: {error}"))?;
    if !(1..=3).contains(&parsed.questions.len()) {
        return Err("question requires between 1 and 3 questions".into());
    }
    for question in &mut parsed.questions {
        question.header = question.header.trim().to_string();
        question.question = question.question.trim().to_string();
        if question.header.is_empty() || question.question.is_empty() {
            return Err("each question requires a header and question".into());
        }
        question.options.retain_mut(|option| {
            option.label = option.label.trim().to_string();
            option.description = option.description.trim().to_string();
            !option.label.is_empty()
        });
        if question.options.is_empty() && !question.custom {
            return Err("a question without options must allow a custom answer".into());
        }
    }
    Ok(parsed.questions)
}

async fn run_user_input_tool(
    ctrl: &StreamControl,
    stream_id: &str,
    request_id: &str,
    arguments: &str,
    on_chunk: &tauri::ipc::Channel<StreamEvent>,
) -> ToolOutcome {
    let questions = match parse_user_input_questions(arguments) {
        Ok(questions) => questions,
        Err(error) => return err_outcome_chat(error),
    };
    let rx = match ctrl.register_user_input(stream_id, request_id) {
        Ok(rx) => rx,
        Err(error) => return err_outcome_chat(error),
    };
    if on_chunk
        .send(StreamEvent::UserInputRequested {
            request_id: request_id.to_string(),
            questions,
        })
        .is_err()
    {
        let _ = ctrl.resolve_user_input(stream_id, request_id, UserInputDecision::Reject);
        return err_outcome_chat("Could not present the question to the user".into());
    }
    let decision = rx.await.unwrap_or(UserInputDecision::Reject);
    let _ = on_chunk.send(StreamEvent::UserInputResolved {
        request_id: request_id.to_string(),
    });
    match decision {
        UserInputDecision::Answer(answers) => ToolOutcome {
            ok: true,
            text: json!({ "answers": answers }).to_string(),
            image: None,
        },
        UserInputDecision::Reject => err_outcome_chat("Denied by user".into()),
    }
}

#[tauri::command]
pub fn chat_cancel(ctrl: State<'_, Arc<StreamControl>>, stream_id: String, request_id: String) {
    ctrl.cancel(stream_id.trim(), request_id.trim());
}

#[tauri::command]
pub async fn chat_user_input_reply(
    ctrl: State<'_, Arc<StreamControl>>,
    opencode_state: State<'_, crate::opencode::OpenCodeState>,
    stream_id: String,
    request_id: String,
    answers: Vec<Vec<String>>,
) -> Result<(), String> {
    let sid = stream_id.trim();
    let rid = request_id.trim();
    if sid.is_empty() || rid.is_empty() {
        return Err("stream_id and request_id required".into());
    }
    let normalized: Vec<Vec<String>> = answers
        .into_iter()
        .map(|items| {
            items
                .into_iter()
                .map(|item| item.trim().to_string())
                .filter(|item| !item.is_empty())
                .collect()
        })
        .collect();
    if crate::opencode::answer_question(opencode_state.inner(), sid, rid, &normalized).await? {
        return Ok(());
    }
    ctrl.resolve_user_input(sid, rid, UserInputDecision::Answer(normalized))
}

#[tauri::command]
pub async fn chat_user_input_reject(
    ctrl: State<'_, Arc<StreamControl>>,
    opencode_state: State<'_, crate::opencode::OpenCodeState>,
    stream_id: String,
    request_id: String,
) -> Result<(), String> {
    let sid = stream_id.trim();
    let rid = request_id.trim();
    if sid.is_empty() || rid.is_empty() {
        return Err("stream_id and request_id required".into());
    }
    if crate::opencode::reject_question(opencode_state.inner(), sid, rid).await? {
        return Ok(());
    }
    ctrl.resolve_user_input(sid, rid, UserInputDecision::Reject)
}

#[tauri::command]
pub async fn chat_tool_approve(
    ctrl: State<'_, Arc<StreamControl>>,
    opencode_state: State<'_, crate::opencode::OpenCodeState>,
    stream_id: String,
    tool_id: String,
) -> Result<(), String> {
    let sid = stream_id.trim();
    let tid = tool_id.trim();
    if sid.is_empty() || tid.is_empty() {
        return Err("stream_id and tool_id required".into());
    }
    if crate::opencode::approve_tool(opencode_state.inner(), sid, tid).await? {
        return Ok(());
    }
    ctrl.resolve_approval(sid, tid, ApprovalDecision::Allow)
}

#[tauri::command]
pub async fn chat_tool_deny(
    ctrl: State<'_, Arc<StreamControl>>,
    opencode_state: State<'_, crate::opencode::OpenCodeState>,
    stream_id: String,
    tool_id: String,
) -> Result<(), String> {
    let sid = stream_id.trim();
    let tid = tool_id.trim();
    if sid.is_empty() || tid.is_empty() {
        return Err("stream_id and tool_id required".into());
    }
    if crate::opencode::deny_tool(opencode_state.inner(), sid, tid).await? {
        return Ok(());
    }
    ctrl.resolve_approval(sid, tid, ApprovalDecision::Deny)
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn chat_stream(
    app: AppHandle,
    state: State<'_, AuthState>,
    openai_state: State<'_, OpenAIAuthState>,
    antigravity_state: State<'_, crate::antigravity::AntigravityState>,
    opencode_state: State<'_, crate::opencode::OpenCodeState>,
    ctrl: State<'_, Arc<StreamControl>>,
    snapshots: State<'_, Arc<SnapshotState>>,
    stream_id: String,
    request_id: String,
    messages: Vec<ChatMessageIn>,
    model: String,
    reasoning_effort: Option<String>,
    service_tier: Option<String>,
    project_path: Option<String>,
    access_mode: Option<String>,
    permission_mode: Option<String>,
    agent_mode: Option<String>,
    on_chunk: tauri::ipc::Channel<StreamEvent>,
) -> Result<(), String> {
    let stream_id = {
        let trimmed = stream_id.trim();
        if trimmed.is_empty() {
            return Err("stream_id required".into());
        }
        trimmed.to_string()
    };
    let request_id = {
        let trimmed = request_id.trim();
        if trimmed.is_empty() {
            return Err("request_id required".into());
        }
        trimmed.to_string()
    };

    let full_access = access_mode
        .as_deref()
        .map(|s| s.eq_ignore_ascii_case("full"))
        .unwrap_or(false);
    let permission = PermissionMode::parse(permission_mode.as_deref())?;
    let agent = AgentMode::parse(agent_mode.as_deref())?;

    let ctrl = Arc::clone(ctrl.inner());
    let (live, my_gen) = ctrl.begin(&stream_id, &request_id);

    let result = run_chat_stream(
        app,
        state,
        openai_state.inner(),
        antigravity_state.inner(),
        opencode_state.inner(),
        Arc::clone(&ctrl),
        snapshots.inner(),
        Arc::clone(&live),
        my_gen,
        stream_id.clone(),
        messages,
        model,
        reasoning_effort,
        service_tier,
        project_path,
        full_access,
        permission,
        agent,
        on_chunk,
    )
    .await;

    ctrl.end(&stream_id, &live);
    result
}

fn cli_working_directory(
    provider: ModelProvider,
    project_root: Option<&Path>,
) -> Result<PathBuf, String> {
    project_root
        .map(Path::to_path_buf)
        .ok_or_else(|| match provider {
            ModelProvider::OpenCode => {
                "OpenCode requires a registered project before it can run.".to_string()
            }
            ModelProvider::Antigravity => {
                "Antigravity requires a registered project before it can run.".to_string()
            }
            _ => "This provider requires a registered project before it can run.".to_string(),
        })
}

#[allow(clippy::too_many_arguments)]
async fn run_chat_stream(
    app: AppHandle,
    state: State<'_, AuthState>,
    openai_state: &OpenAIAuthState,
    antigravity_state: &crate::antigravity::AntigravityState,
    opencode_state: &crate::opencode::OpenCodeState,
    ctrl: Arc<StreamControl>,
    snapshots: &SnapshotState,
    live: Arc<LiveStream>,
    my_gen: u64,
    stream_id: String,
    messages: Vec<ChatMessageIn>,
    model: String,
    reasoning_effort: Option<String>,
    service_tier: Option<String>,
    project_path: Option<String>,
    full_access: bool,
    permission: PermissionMode,
    agent: AgentMode,
    on_chunk: tauri::ipc::Channel<StreamEvent>,
) -> Result<(), String> {
    let client = shared_http_client()?;

    // Unregistered paths simply disable tools — do not fail the whole chat.
    let project_root: Option<PathBuf> = match project_path.as_deref() {
        Some(p) if !p.trim().is_empty() => require_registered_root(&app, p).ok(),
        _ => None,
    };
    let tools_enabled = project_root.is_some();

    let provider = provider_of_model(&model);
    if provider == ModelProvider::OpenAi {
        crate::openai::validate_chatgpt_codex_model(&model)?;
    }
    let messages = sanitize_client_messages(messages)?;
    let system = if provider == ModelProvider::Antigravity {
        format_cli_system_prompt(project_root.as_deref(), full_access, agent)
    } else if let Some(ref root) = project_root {
        match build_project_context(root) {
            Ok(ctx) => format_system_prompt(&ctx, full_access, agent, permission),
            Err(e) => format_project_fallback_prompt(
                &root.display().to_string(),
                &e,
                full_access,
                agent,
                permission,
            ),
        }
    } else {
        format_general_system_prompt()
    };

    if provider == ModelProvider::OpenCode {
        let prompt = messages
            .iter()
            .rev()
            .find(|message| message.role.eq_ignore_ascii_case("user"))
            .and_then(|message| message.content.as_ref())
            .map(|content| match content {
                ChatContent::Text(text) => text.clone(),
                ChatContent::Parts(parts) => parts
                    .iter()
                    .filter_map(|part| match part {
                        ContentPart::Text { text } => Some(text.as_str()),
                        ContentPart::ImageUrl { .. } => None,
                    })
                    .collect::<Vec<_>>()
                    .join("\n"),
            })
            .filter(|text| !text.trim().is_empty())
            .ok_or_else(|| "OpenCode requires a user message.".to_string())?;
        let directory = cli_working_directory(provider, project_root.as_deref())?;
        let stop_closure = || should_stop(&live, my_gen);
        let result = crate::opencode::stream_chat(
            &app,
            opencode_state,
            &stream_id,
            &model,
            &prompt,
            &system,
            tools_enabled,
            reasoning_effort.as_deref(),
            &directory,
            full_access,
            permission,
            agent,
            &on_chunk,
            &stop_closure,
        )
        .await;
        crate::opencode::clear_questions_for_stream(opencode_state, &stream_id).await;
        return result;
    }

    if provider == ModelProvider::Antigravity {
        let prompt = messages
            .iter()
            .rev()
            .find(|message| message.role.eq_ignore_ascii_case("user"))
            .and_then(|message| message.content.as_ref())
            .map(|content| match content {
                ChatContent::Text(text) => text.clone(),
                ChatContent::Parts(parts) => parts
                    .iter()
                    .filter_map(|part| match part {
                        ContentPart::Text { text } => Some(text.as_str()),
                        ContentPart::ImageUrl { .. } => None,
                    })
                    .collect::<Vec<_>>()
                    .join("\n"),
            })
            .filter(|text| !text.trim().is_empty())
            .ok_or_else(|| "Antigravity requires a user message.".to_string())?;
        let directory = cli_working_directory(provider, project_root.as_deref())?;
        let stop_closure = || should_stop(&live, my_gen);
        return crate::antigravity::stream_chat(
            antigravity_state,
            &stream_id,
            &model,
            &prompt,
            &system,
            &directory,
            full_access,
            permission,
            agent,
            &on_chunk,
            &stop_closure,
        )
        .await;
    }

    let account_id = if provider == ModelProvider::OpenAi {
        openai_auth::get_openai_account_id(&app, openai_state).await
    } else {
        None
    };
    let mut backend = ChatBackend::new(provider, system, account_id.clone());
    backend.push_client_messages(messages)?;

    let allowed_tools = agent.allowed_tools();

    // Stop identical tool batches / name thrashing from spinning forever.
    let mut recent_tool_sigs: Vec<String> = Vec::new();
    let mut recent_tool_names: Vec<String> = Vec::new();
    let mut force_final = false;
    let mut tool_protocol_leak_retries: u32 = 0;

    for round in 0..MAX_AGENT_ROUNDS {
        if should_stop(&live, my_gen) {
            return Ok(());
        }

        // Refresh each round so long tool loops don't die on an expired token.
        let token = match provider {
            ModelProvider::Grok => get_access_token(&app, state.inner()).await?,
            ModelProvider::OpenAi => {
                openai_auth::get_openai_access_token(&app, openai_state).await?
            }
            ModelProvider::OpenCode | ModelProvider::Antigravity => {
                unreachable!("CLI providers are routed before native chat")
            }
        };
        if should_stop(&live, my_gen) {
            return Ok(());
        }

        if should_request_progress_check(round, tools_enabled, force_final) {
            backend.push_user_text(PROGRESS_CHECK_REMINDER);
        }

        // Last round / doom-loop: force a final answer without tools.
        let allow_tools = tools_enabled && !force_final && round + 1 < MAX_AGENT_ROUNDS;

        if !allow_tools && tools_enabled {
            // Max-steps reminder for a text-only final turn.
            backend.push_user_text(MAX_STEPS_REMINDER);
        }

        let tool_definitions = if allow_tools {
            Some(tool_definitions_for(allowed_tools))
        } else {
            None
        };

        // Content is buffered until the round ends so tool-round monologue
        // never lands in chat. Retries on mid-stream body drops.
        let stop_closure = || should_stop(&live, my_gen);
        let stop: StopCheck<'_> = &stop_closure;
        let mut round_out = backend
            .stream_round(
                &client,
                &token,
                &model,
                reasoning_effort.as_deref(),
                service_tier.as_deref(),
                allow_tools,
                tool_definitions,
                stop,
            )
            .await?;

        if let Some(usage) = round_out.usage {
            on_chunk
                .send(StreamEvent::Usage {
                    input_tokens: usage.input_tokens,
                    output_tokens: usage.output_tokens,
                    total_tokens: usage.total_tokens,
                })
                .map_err(|e| format!("emit: {e}"))?;
        }

        if should_stop(&live, my_gen) {
            return Ok(());
        }

        let content_acc = round_out.content;
        let reasoning_acc = round_out.reasoning;
        let mut tool_acc = round_out.tools;
        let finish_reason = round_out.finish_reason;
        let thinking_emitted_live = round_out.thinking_emitted_live;
        let output_items = std::mem::take(&mut round_out.output_items);

        // Fallback only when live emit never fired (e.g. all chunks filtered).
        // Avoid double-emitting the full blob after progressive deltas.
        if !thinking_emitted_live {
            let thinking_face = sanitize_thinking_content(&reasoning_acc);
            if !thinking_face.is_empty() {
                on_chunk
                    .send(StreamEvent::Thinking {
                        text: thinking_face,
                    })
                    .map_err(|e| format!("emit: {e}"))?;
            }
        }

        let mut indices: Vec<usize> = tool_acc.keys().copied().collect();
        indices.sort_unstable();
        let mut tools: Vec<AccumToolCall> = indices
            .into_iter()
            .filter_map(|i| tool_acc.remove(&i))
            .collect();

        for (i, t) in tools.iter_mut().enumerate() {
            if t.id.is_empty() {
                t.id = format!("call_{i}");
            }
            if t.name.is_empty() {
                t.name = "unknown".into();
            }
        }

        let wants_tools =
            finish_reason.as_deref() == Some("tool_calls") || (!tools.is_empty() && allow_tools);

        // Final answer path.
        if !wants_tools || !allow_tools || tools.is_empty() {
            if provider == ModelProvider::OpenAi {
                // OpenAI models emit clean assistant text — no leak filters.
                let face = content_acc.trim().to_string();
                if !face.is_empty() {
                    on_chunk
                        .send(StreamEvent::Content { text: face })
                        .map_err(|e| format!("emit: {e}"))?;
                }
                return Ok(());
            }

            // Grok path: only sanitized assistant_text reaches the UI.
            let leaked_tool_protocol = contains_tool_protocol(&content_acc);
            let face = sanitize_user_facing_content(&content_acc);
            if !face.is_empty() {
                on_chunk
                    .send(StreamEvent::Content { text: face })
                    .map_err(|e| format!("emit: {e}"))?;
            } else if leaked_tool_protocol && tool_protocol_leak_retries < 2 {
                tool_protocol_leak_retries += 1;
                // Never store the leaked dump in history — nudge only.
                backend.push_user_text(TOOL_PROTOCOL_NUDGE);
                continue;
            } else if tools_enabled && round > 0 {
                // Tools ran earlier but the model returned empty/monologue-only
                // final text — ask once more without tools.
                // Never feed tool-protocol dumps back into the model context.
                backend.push_empty_final_retry_hint();
                let token = get_access_token(&app, state.inner()).await?;
                if should_stop(&live, my_gen) {
                    return Ok(());
                }
                let retry_out = backend
                    .stream_round(
                        &client,
                        &token,
                        &model,
                        reasoning_effort.as_deref(),
                        service_tier.as_deref(),
                        false,
                        None,
                        stop,
                    )
                    .await?;
                if !retry_out.thinking_emitted_live {
                    let think = sanitize_thinking_content(&retry_out.reasoning);
                    if !think.is_empty() {
                        let _ = on_chunk.send(StreamEvent::Thinking { text: think });
                    }
                }
                let retry_face = sanitize_user_facing_content(&retry_out.content);
                if !retry_face.is_empty() {
                    on_chunk
                        .send(StreamEvent::Content { text: retry_face })
                        .map_err(|e| format!("emit: {e}"))?;
                }
            }
            return Ok(());
        }

        // Tool path: content never becomes chat. Keep history content null.
        // Do not park tool-protocol or monologue under thinking either.
        backend.record_tool_round(&tools, &output_items);

        let sig = tool_batch_signature(&tools);
        recent_tool_sigs.push(sig.clone());
        let identical_streak = recent_tool_sigs
            .iter()
            .rev()
            .take_while(|s| **s == sig)
            .count();
        if identical_streak >= DOOM_LOOP_LIMIT {
            force_final = true;
        }

        // Name-level thrash: same tool repeatedly with slightly different args.
        let name_sig = tools
            .iter()
            .map(|t| t.name.to_ascii_lowercase())
            .collect::<Vec<_>>()
            .join("|");
        recent_tool_names.push(name_sig.clone());
        let name_streak = recent_tool_names
            .iter()
            .rev()
            .take_while(|s| **s == name_sig)
            .count();
        if name_streak >= DOOM_LOOP_NAME_LIMIT {
            force_final = true;
        }

        let root = project_root.as_ref().unwrap().clone();
        let mut mutation_failed = false;

        // Ask mode or any mutation → serial so approvals and file writes stay ordered.
        let any_needs_approval = permission == PermissionMode::Ask
            && tools
                .iter()
                .any(|t| tool_needs_approval(canonical_tool_name_pub(&t.name)));
        let any_serial = any_needs_approval
            || tools
                .iter()
                .any(|t| tool_requires_serial(&t.name, &t.arguments));
        let progress_chunk = on_chunk.clone();
        let child_approval: Option<crate::subagent::ChildApprovalWait> =
            if permission == PermissionMode::Ask {
                let ctrl_a = Arc::clone(&ctrl);
                let sid = stream_id.clone();
                Some(Arc::new(move |tool_id: String| {
                    let ctrl_a = Arc::clone(&ctrl_a);
                    let sid = sid.clone();
                    Box::pin(async move {
                        let rx = match ctrl_a.register_approval(&sid, &tool_id) {
                            Ok(rx) => rx,
                            Err(_) => return false,
                        };
                        matches!(rx.await, Ok(ApprovalDecision::Allow))
                    })
                }))
            } else {
                None
            };
        let host = SubagentHost {
            token: token.clone(),
            token_refresher: {
                let app = app.clone();
                Some(Arc::new(move || {
                    let app = app.clone();
                    Box::pin(async move {
                        use tauri::Manager;
                        match provider {
                            ModelProvider::Grok => {
                                let auth = app.state::<AuthState>();
                                get_access_token(&app, &auth).await
                            }
                            ModelProvider::OpenAi => {
                                let auth = app.state::<OpenAIAuthState>();
                                openai_auth::get_openai_access_token(&app, &auth).await
                            }
                            ModelProvider::OpenCode => {
                                Err("OpenCode subagents are managed by OpenCode.".into())
                            }
                            ModelProvider::Antigravity => {
                                Err("Antigravity subagents are managed by Antigravity.".into())
                            }
                        }
                    })
                }))
            },
            provider,
            account_id: account_id.clone(),
            model: model.clone(),
            reasoning_effort: reasoning_effort.clone(),
            service_tier: service_tier.clone(),
            depth: 0,
            cancel: {
                let live = Arc::clone(&live);
                let gen = my_gen;
                Arc::new(move || should_stop(&live, gen))
            },
            child_tools: Some(Arc::new(move |ev| {
                use crate::subagent::ChildToolEvent;
                match ev {
                    ChildToolEvent::Start {
                        parent_id,
                        id,
                        name,
                        args,
                        awaiting_approval,
                        approval_reason,
                    } => {
                        let _ = progress_chunk.send(StreamEvent::ToolStart {
                            id,
                            name,
                            args: redact_tool_arguments(&args),
                            awaiting_approval,
                            approval_reason,
                            parent_id: Some(parent_id),
                        });
                    }
                    ChildToolEvent::Result {
                        parent_id,
                        id,
                        name,
                        ok,
                        result,
                    } => {
                        let _ = progress_chunk.send(StreamEvent::ToolResult {
                            id,
                            name,
                            ok,
                            result,
                            parent_id: Some(parent_id),
                            image_url: None,
                        });
                    }
                }
            })),
            approval_wait: child_approval,
            tool_output: {
                let progress_chunk = on_chunk.clone();
                Some(Arc::new(
                    move |tool_id: String, text: String, replace: bool| {
                        let _ = progress_chunk.send(StreamEvent::ToolOutput {
                            id: tool_id,
                            text,
                            replace,
                        });
                    },
                ))
            },
            usage: {
                let progress_chunk = on_chunk.clone();
                Some(Arc::new(move |usage: crate::openai::ResponsesUsage| {
                    let _ = progress_chunk.send(StreamEvent::Usage {
                        input_tokens: usage.input_tokens,
                        output_tokens: usage.output_tokens,
                        total_tokens: usage.total_tokens,
                    });
                }))
            },
            agent_tools: {
                let tool_app = app.clone();
                let tool_workspace = root.clone();
                Some(Arc::new(move |name: String, arguments: Value| {
                    let tool_app = tool_app.clone();
                    let tool_workspace = tool_workspace.clone();
                    Box::pin(async move {
                        crate::agent_tools::execute(&tool_app, &tool_workspace, &name, arguments)
                            .await
                    })
                        as futures_util::future::BoxFuture<
                            'static,
                            Result<crate::agent_tools::AgentToolResult, String>,
                        >
                }))
            },
        };

        // Always serial when approvals are involved; otherwise keep parallel reads.
        let mut ordered: Vec<(AccumToolCall, ToolOutcome)> = Vec::with_capacity(tools.len());

        if tools.len() <= 1 || any_serial {
            for t in &tools {
                if should_stop(&live, my_gen) {
                    return Ok(());
                }
                let canon = canonical_tool_name_pub(&t.name);
                let needs_ask = permission == PermissionMode::Ask && tool_needs_approval(canon);
                let reason = if needs_ask {
                    Some(approval_reason(canon).to_string())
                } else {
                    None
                };
                on_chunk
                    .send(StreamEvent::ToolStart {
                        id: t.id.clone(),
                        name: t.name.clone(),
                        args: redact_tool_arguments(&t.arguments),
                        awaiting_approval: needs_ask,
                        approval_reason: reason,
                        parent_id: None,
                    })
                    .map_err(|e| format!("emit: {e}"))?;

                if needs_ask {
                    let rx = match ctrl.register_approval(&stream_id, &t.id) {
                        Ok(rx) => rx,
                        Err(e) => {
                            ordered.push((t.clone(), err_outcome_chat(e)));
                            continue;
                        }
                    };
                    // Park until approve/deny or cancel (deny on clear).
                    let decision = match rx.await {
                        Ok(d) => d,
                        Err(_) => ApprovalDecision::Deny,
                    };
                    if should_stop(&live, my_gen) {
                        ordered.push((
                            t.clone(),
                            err_outcome_chat("Cancelled before tool ran".into()),
                        ));
                        continue;
                    }
                    if decision == ApprovalDecision::Deny {
                        ordered.push((t.clone(), err_outcome_chat("Denied by user".into())));
                        continue;
                    }
                }

                let outcome = if canon == "question" {
                    run_user_input_tool(ctrl.as_ref(), &stream_id, &t.id, &t.arguments, &on_chunk)
                        .await
                } else {
                    let capture = MutationCapture {
                        stream_id: &stream_id,
                        tool_id: &t.id,
                        snapshots,
                        workspace_root: &root,
                        full_access,
                    };
                    execute_tool_with_depth(
                        &root,
                        &t.name,
                        &t.arguments,
                        full_access,
                        0,
                        Some(&host),
                        Some(allowed_tools),
                        Some(capture),
                        Some(t.id.as_str()),
                    )
                    .await
                };
                ordered.push((t.clone(), outcome));
            }
        } else {
            // Pure parallel path: emit all starts, then fan out (no approvals).
            for t in &tools {
                if should_stop(&live, my_gen) {
                    return Ok(());
                }
                on_chunk
                    .send(StreamEvent::ToolStart {
                        id: t.id.clone(),
                        name: t.name.clone(),
                        args: redact_tool_arguments(&t.arguments),
                        awaiting_approval: false,
                        approval_reason: None,
                        parent_id: None,
                    })
                    .map_err(|e| format!("emit: {e}"))?;
            }
            let parallel_limit = parallel_tool_limit(&tools);
            let allowed_tools = allowed_tools.to_vec();
            let futs = tools.iter().cloned().enumerate().map(|(index, tool)| {
                let root = root.clone();
                let host = host.clone();
                let allowed_tools = allowed_tools.clone();
                // SnapshotState is behind managed Arc-like state — use raw pointer via
                // shared reference only on serial path. Parallel pure-reads don't mutate.
                async move {
                    let outcome = execute_tool_with_depth(
                        &root,
                        &tool.name,
                        &tool.arguments,
                        full_access,
                        0,
                        Some(&host),
                        Some(allowed_tools.as_slice()),
                        None,
                        Some(tool.id.as_str()),
                    )
                    .await;
                    (index, tool, outcome)
                }
            });
            let mut completed = futures_util::stream::iter(futs)
                .buffer_unordered(parallel_limit)
                .collect::<Vec<_>>()
                .await;
            // Preserve the model's tool-call order when feeding results back.
            completed.sort_unstable_by_key(|(index, _, _)| *index);
            ordered = completed
                .into_iter()
                .map(|(_, tool, outcome)| (tool, outcome))
                .collect();
            if should_stop(&live, my_gen) {
                return Ok(());
            }
        }

        for (tool, outcome) in ordered {
            if should_stop(&live, my_gen) {
                return Ok(());
            }
            if !outcome.ok && is_mutation_tool(&tool.name) {
                mutation_failed = true;
            }
            let image_url = outcome.image.as_ref().map(|img| img.data_url.clone());
            on_chunk
                .send(StreamEvent::ToolResult {
                    id: tool.id.clone(),
                    name: tool.name.clone(),
                    ok: outcome.ok,
                    result: outcome.text.clone(),
                    parent_id: None,
                    image_url,
                })
                .map_err(|e| format!("emit: {e}"))?;
            backend.push_tool_result(&tool, &outcome.text, outcome.image.as_ref());
        }

        // After a failed edit/write, steer the next round back to tools
        // instead of a chat-only "here's the patch" surrender.
        if mutation_failed && !force_final {
            backend.push_user_text(TOOL_FAILURE_NUDGE);
        }
    }

    // Exhausted agent rounds with no final content emit — give a last text-only try.
    if tools_enabled && !should_stop(&live, my_gen) {
        backend.push_user_text(MAX_STEPS_REMINDER);
        let token = match provider {
            ModelProvider::Grok => get_access_token(&app, state.inner()).await?,
            ModelProvider::OpenAi => {
                openai_auth::get_openai_access_token(&app, openai_state).await?
            }
            ModelProvider::OpenCode | ModelProvider::Antigravity => {
                unreachable!("CLI providers are routed before native chat")
            }
        };
        if should_stop(&live, my_gen) {
            return Ok(());
        }
        let stop_closure = || should_stop(&live, my_gen);
        let stop: StopCheck<'_> = &stop_closure;
        let tail_out = backend
            .stream_round(
                &client,
                &token,
                &model,
                reasoning_effort.as_deref(),
                service_tier.as_deref(),
                false,
                None,
                stop,
            )
            .await?;
        if let Some(usage) = tail_out.usage {
            on_chunk
                .send(StreamEvent::Usage {
                    input_tokens: usage.input_tokens,
                    output_tokens: usage.output_tokens,
                    total_tokens: usage.total_tokens,
                })
                .map_err(|e| format!("emit: {e}"))?;
        }
        if !tail_out.thinking_emitted_live {
            let think = sanitize_thinking_content(&tail_out.reasoning);
            if !think.is_empty() {
                let _ = on_chunk.send(StreamEvent::Thinking { text: think });
            }
        }
        let face = if provider == ModelProvider::OpenAi {
            tail_out.content.trim().to_string()
        } else {
            sanitize_user_facing_content(&tail_out.content)
        };
        if !face.is_empty() {
            on_chunk
                .send(StreamEvent::Content { text: face })
                .map_err(|e| format!("emit: {e}"))?;
        }
    }

    Ok(())
}

fn parallel_tool_limit(tools: &[AccumToolCall]) -> usize {
    if tools
        .iter()
        .any(|tool| canonical_tool_name_pub(&tool.name) == "task")
    {
        MAX_PARALLEL_SUBAGENTS.min(tools.len())
    } else {
        tools.len()
    }
}

fn is_mutation_tool(name: &str) -> bool {
    matches!(
        canonical_tool_name_pub(name),
        "edit" | "write" | "delete" | "patch"
    )
}

fn err_outcome_chat(text: String) -> ToolOutcome {
    ToolOutcome {
        ok: false,
        text,
        image: None,
    }
}

/// Only user/assistant turns from the client. System/tool roles are server-owned.
fn sanitize_client_messages(messages: Vec<ChatMessageIn>) -> Result<Vec<ChatMessageIn>, String> {
    const MAX_MESSAGES: usize = 2_000;
    const MAX_PARTS_PER_MESSAGE: usize = 256;
    const MAX_IMAGES: usize = 20;
    const MAX_TEXT_BYTES: usize = 8 * 1024 * 1024;
    const MAX_IMAGE_URL_BYTES: usize = 48 * 1024 * 1024;

    if messages.len() > MAX_MESSAGES {
        return Err("Conversation has too many messages".into());
    }
    let mut out = Vec::with_capacity(messages.len());
    let mut total_text_bytes = 0_usize;
    let mut total_image_url_bytes = 0_usize;
    let mut image_count = 0_usize;
    for mut m in messages {
        match m.role.as_str() {
            "user" | "assistant" => {
                m.tool_calls = None;
                m.tool_call_id = None;
                m.name = None;
                // Cap image data URLs / text size from client.
                if let Some(ChatContent::Parts(parts)) = m.content.as_mut() {
                    if parts.len() > MAX_PARTS_PER_MESSAGE {
                        return Err("Message has too many parts".into());
                    }
                    let mut text_len = 0_usize;
                    for part in parts.iter_mut() {
                        match part {
                            ContentPart::Text { text } => {
                                text_len = text_len.saturating_add(text.len());
                                total_text_bytes = total_text_bytes.saturating_add(text.len());
                                if text_len > 400_000 {
                                    return Err("Message too large".into());
                                }
                                if total_text_bytes > MAX_TEXT_BYTES {
                                    return Err("Conversation text is too large".into());
                                }
                            }
                            ContentPart::ImageUrl { image_url } => {
                                if image_url.url.len() > 12_000_000 {
                                    return Err("Image attachment too large".into());
                                }
                                image_count = image_count.saturating_add(1);
                                total_image_url_bytes =
                                    total_image_url_bytes.saturating_add(image_url.url.len());
                                if image_count > MAX_IMAGES
                                    || total_image_url_bytes > MAX_IMAGE_URL_BYTES
                                {
                                    return Err(
                                        "Conversation has too many image attachments".into()
                                    );
                                }
                                if !(image_url.url.starts_with("data:image/")
                                    || image_url.url.starts_with("https://"))
                                {
                                    return Err("Unsupported image URL".into());
                                }
                            }
                        }
                    }
                }
                if let Some(ChatContent::Text(s)) = m.content.as_ref() {
                    if s.len() > 400_000 {
                        return Err("Message too large".into());
                    }
                    total_text_bytes = total_text_bytes.saturating_add(s.len());
                    if total_text_bytes > MAX_TEXT_BYTES {
                        return Err("Conversation text is too large".into());
                    }
                }
                out.push(m);
            }
            other => {
                return Err(format!("Invalid message role from client: {other}"));
            }
        }
    }
    Ok(out)
}

fn message_to_json(m: ChatMessageIn) -> Value {
    let mut v = json!({ "role": m.role });
    if let Some(c) = m.content {
        v["content"] = match c {
            ChatContent::Text(s) => json!(s),
            ChatContent::Parts(parts) => serde_json::to_value(parts).unwrap_or(Value::Null),
        };
    } else {
        v["content"] = json!("");
    }
    v
}

#[cfg(test)]
mod stream_event_tests {
    use super::{
        cli_working_directory, drain_chat_sse, provider_error_detail, redact_tool_arguments,
        sanitize_client_messages, ChatContent, ChatMessageIn, ContentPart, StreamEvent,
        UserInputOption, UserInputQuestion,
    };
    use crate::provider::ModelProvider;
    use crate::provider_output::MAX_PROVIDER_EVENT_BYTES;

    #[tokio::test]
    async fn native_chat_stream_rejects_an_oversized_provider_event() {
        use std::io::{Read, Write};

        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let body = format!("data: {}\n\n", "x".repeat(MAX_PROVIDER_EVENT_BYTES));
        let server = std::thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            let mut request = [0_u8; 2048];
            let _ = socket.read(&mut request).unwrap();
            write!(
                socket,
                "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                body.len(),
                body
            )
            .unwrap();
        });

        let response = reqwest::Client::new()
            .get(format!("http://{address}"))
            .send()
            .await
            .unwrap();
        let error = match drain_chat_sse(response, &|| false).await {
            Ok(_) => panic!("oversized provider event must fail closed"),
            Err(error) => error,
        };
        server.join().unwrap();

        assert!(error.contains("Provider event exceeded"), "{error}");
    }

    #[tokio::test]
    async fn native_chat_stream_rejects_clean_eof_without_done_marker() {
        use std::io::{Read, Write};

        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let body = "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"call_1\",\"function\":{\"name\":\"read\",\"arguments\":\"{\\\"path\\\":\"}}]}}]}\n\n";
        let server = std::thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            let mut request = [0_u8; 2048];
            let _ = socket.read(&mut request).unwrap();
            write!(
                socket,
                "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                body.len(),
                body
            )
            .unwrap();
        });

        let response = reqwest::Client::new()
            .get(format!("http://{address}"))
            .send()
            .await
            .unwrap();
        let error = match drain_chat_sse(response, &|| false).await {
            Ok(_) => panic!("partial tool calls require a terminal marker"),
            Err(error) => error,
        };
        server.join().unwrap();

        assert!(error.contains("without a terminal"), "{error}");
    }

    #[tokio::test]
    async fn native_chat_stream_accepts_explicit_done_marker() {
        use std::io::{Read, Write};

        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let body = concat!(
            "data: {\"choices\":[{\"delta\":{\"content\":\"complete\"},\"finish_reason\":\"stop\"}]}\n\n",
            "data: [DONE]\n\n"
        );
        let server = std::thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            let mut request = [0_u8; 2048];
            let _ = socket.read(&mut request).unwrap();
            write!(
                socket,
                "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                body.len(),
                body
            )
            .unwrap();
        });

        let response = reqwest::Client::new()
            .get(format!("http://{address}"))
            .send()
            .await
            .unwrap();
        let out = drain_chat_sse(response, &|| false).await.unwrap();
        server.join().unwrap();

        assert_eq!(out.content, "complete");
        assert_eq!(out.finish_reason.as_deref(), Some("stop"));
    }

    #[tokio::test]
    async fn native_chat_stream_cancellation_does_not_require_done_marker() {
        use std::io::{Read, Write};

        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let body = "data: {\"choices\":[{\"delta\":{\"content\":\"partial\"}}]}\n\n";
        let server = std::thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            let mut request = [0_u8; 2048];
            let _ = socket.read(&mut request).unwrap();
            write!(
                socket,
                "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                body.len(),
                body
            )
            .unwrap();
        });

        let response = reqwest::Client::new()
            .get(format!("http://{address}"))
            .send()
            .await
            .unwrap();
        let out = drain_chat_sse(response, &|| true)
            .await
            .expect("cancellation is not a provider failure");
        server.join().unwrap();

        assert!(out.content.is_empty());
        assert!(out.tools.is_empty());
    }

    #[tokio::test]
    async fn provider_error_detail_stops_without_waiting_for_the_body() {
        use std::io::{Read, Write};

        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = std::thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            let mut request = [0_u8; 2048];
            let _ = socket.read(&mut request).unwrap();
            socket
                .write_all(
                    b"HTTP/1.1 400 Bad Request\r\nContent-Type: application/json\r\nContent-Length: 100\r\n\r\n",
                )
                .unwrap();
            socket.flush().unwrap();
            std::thread::sleep(std::time::Duration::from_millis(200));
        });

        let response = reqwest::Client::new()
            .get(format!("http://{address}"))
            .send()
            .await
            .unwrap();
        assert!(provider_error_detail(response, &|| true).await.is_none());
        server.join().unwrap();
    }

    #[test]
    fn cli_providers_fail_closed_without_a_registered_project() {
        for provider in [ModelProvider::OpenCode, ModelProvider::Antigravity] {
            let error = cli_working_directory(provider, None)
                .expect_err("CLI providers must not fall back to the process working directory");
            assert!(error.contains("registered project"), "{error}");
        }
    }

    #[test]
    fn client_message_parts_enforce_text_limit() {
        let result = sanitize_client_messages(vec![ChatMessageIn {
            role: "user".into(),
            content: Some(ChatContent::Parts(vec![ContentPart::Text {
                text: "x".repeat(400_001),
            }])),
            tool_calls: None,
            tool_call_id: None,
            name: None,
        }]);

        assert_eq!(result.unwrap_err(), "Message too large");
    }

    #[test]
    fn client_messages_enforce_aggregate_limits() {
        let message = || ChatMessageIn {
            role: "user".into(),
            content: Some(ChatContent::Text("x".repeat(400_000))),
            tool_calls: None,
            tool_call_id: None,
            name: None,
        };
        let text_result = sanitize_client_messages((0..21).map(|_| message()).collect());
        assert_eq!(text_result.unwrap_err(), "Conversation text is too large");

        let count_result = sanitize_client_messages(
            (0..2_001)
                .map(|_| ChatMessageIn {
                    role: "assistant".into(),
                    content: Some(ChatContent::Text(String::new())),
                    tool_calls: None,
                    tool_call_id: None,
                    name: None,
                })
                .collect(),
        );
        assert_eq!(
            count_result.unwrap_err(),
            "Conversation has too many messages"
        );
    }

    #[test]
    fn tool_events_serialize_parent_id_as_camel_case() {
        let start = StreamEvent::ToolStart {
            id: "c1".into(),
            name: "grep".into(),
            args: "{}".into(),
            awaiting_approval: false,
            approval_reason: None,
            parent_id: Some("task-1".into()),
        };
        let v = serde_json::to_value(&start).unwrap();
        assert_eq!(v["kind"], "tool_start");
        assert_eq!(v["parentId"], "task-1");
        assert_eq!(v["id"], "c1");

        let result = StreamEvent::ToolResult {
            id: "c1".into(),
            name: "grep".into(),
            ok: true,
            result: "hit".into(),
            parent_id: Some("task-1".into()),
            image_url: None,
        };
        let v = serde_json::to_value(&result).unwrap();
        assert_eq!(v["kind"], "tool_result");
        assert_eq!(v["parentId"], "task-1");
        assert_eq!(v["ok"], true);
    }

    #[test]
    fn top_level_tool_events_omit_null_parent_id() {
        let start = StreamEvent::ToolStart {
            id: "t1".into(),
            name: "task".into(),
            args: "{}".into(),
            awaiting_approval: true,
            approval_reason: Some("Spawn".into()),
            parent_id: None,
        };
        let raw = serde_json::to_string(&start).unwrap();
        assert!(!raw.contains("parentId"));
        assert!(raw.contains("awaitingApproval"));
    }

    #[test]
    fn user_input_events_serialize_the_frontend_contract() {
        let requested = StreamEvent::UserInputRequested {
            request_id: "question-1".into(),
            questions: vec![UserInputQuestion {
                header: "Runtime".into(),
                question: "Which runtime?".into(),
                options: vec![UserInputOption {
                    label: "OpenCode".into(),
                    description: "Use the CLI runtime".into(),
                }],
                multiple: false,
                custom: true,
            }],
        };
        let value = serde_json::to_value(requested).unwrap();
        assert_eq!(value["kind"], "user_input_requested");
        assert_eq!(value["requestId"], "question-1");
        assert_eq!(value["questions"][0]["options"][0]["label"], "OpenCode");

        let resolved = serde_json::to_value(StreamEvent::UserInputResolved {
            request_id: "question-1".into(),
        })
        .unwrap();
        assert_eq!(resolved["kind"], "user_input_resolved");
        assert_eq!(resolved["requestId"], "question-1");
    }

    #[test]
    fn tool_start_arguments_are_redacted_without_changing_execution_input() {
        let raw = r#"{"path":"src/main.rs","id_token":"identity-secret"}"#;
        let displayed = redact_tool_arguments(raw);
        let start = StreamEvent::ToolStart {
            id: "t1".into(),
            name: "read".into(),
            args: displayed,
            awaiting_approval: false,
            approval_reason: None,
            parent_id: None,
        };
        let serialized = serde_json::to_string(&start).unwrap();
        assert!(serialized.contains("src/main.rs"), "{serialized}");
        assert!(!serialized.contains("identity-secret"), "{serialized}");
        assert!(raw.contains("identity-secret"));
    }
}

#[cfg(test)]
mod provider_backend_tests {
    use super::{AccumToolCall, ChatBackend};
    use crate::provider::ModelProvider;
    use serde_json::{json, Value};
    use std::collections::BTreeMap;

    fn normalized_tool_contracts(body: &Value) -> BTreeMap<String, Value> {
        body["tools"]
            .as_array()
            .expect("tool array")
            .iter()
            .map(|tool| {
                let function = tool.get("function").unwrap_or(tool);
                let name = function["name"].as_str().expect("tool name").to_string();
                let contract = json!({
                    "description": function["description"],
                    "parameters": function["parameters"],
                });
                (name, contract)
            })
            .collect()
    }

    #[test]
    fn provider_backends_receive_the_same_shared_tool_contracts() {
        let tools = crate::tools::tool_definitions();
        let expected_count = tools.as_array().expect("tool definitions").len();
        let grok = ChatBackend::new(ModelProvider::Grok, "system".into(), None);
        let openai = ChatBackend::new(ModelProvider::OpenAi, "system".into(), None);

        let grok_body = grok
            .build_body("grok-4.5", Some("medium"), None, true, Some(tools.clone()))
            .expect("Grok body");
        let openai_body = openai
            .build_body(
                "gpt-5.6-sol",
                Some("medium"),
                None,
                true,
                Some(tools.clone()),
            )
            .expect("OpenAI body");

        let grok_contracts = normalized_tool_contracts(&grok_body);
        let openai_contracts = normalized_tool_contracts(&openai_body);
        assert_eq!(grok_contracts.len(), expected_count);
        assert_eq!(grok_contracts, openai_contracts);
        assert_eq!(grok_body["tool_choice"], "auto");
        assert_eq!(openai_body["tool_choice"], "auto");

        for body in [
            grok.build_body("grok-4.5", None, None, false, Some(tools.clone()))
                .expect("Grok final body"),
            openai
                .build_body("gpt-5.6-sol", None, None, false, Some(tools))
                .expect("OpenAI final body"),
        ] {
            assert!(body.get("tools").is_none());
            assert!(body.get("tool_choice").is_none());
        }
    }

    #[test]
    fn openai_backend_rejects_daybreak_before_network_access() {
        let openai = ChatBackend::new(ModelProvider::OpenAi, "system".into(), None);
        let error = openai
            .build_body("gpt-daybreak-blue-latest", Some("max"), None, false, None)
            .expect_err("Daybreak is not available through ChatGPT/Codex sign-in");
        assert!(error.contains("not available through OpenAI ChatGPT/Codex sign-in"));
    }

    #[test]
    fn provider_backends_preserve_tool_call_and_result_linkage() {
        let tool = AccumToolCall {
            id: "fc_1".into(),
            call_id: "call_1".into(),
            name: "read".into(),
            arguments: r#"{"filePath":"src/main.rs"}"#.into(),
        };
        let output_item = json!({
            "type": "function_call",
            "id": tool.id,
            "call_id": tool.call_id,
            "name": tool.name,
            "arguments": tool.arguments,
        });

        let mut grok = ChatBackend::new(ModelProvider::Grok, "system".into(), None);
        grok.record_tool_round(std::slice::from_ref(&tool), &[]);
        grok.push_tool_result(&tool, "file contents", None);
        let grok_body = grok
            .build_body("grok-4.5", None, None, false, None)
            .expect("Grok body");
        let messages = grok_body["messages"].as_array().expect("messages");
        assert_eq!(messages[1]["tool_calls"][0]["id"], "fc_1");
        assert_eq!(messages[1]["tool_calls"][0]["function"]["name"], "read");
        assert_eq!(messages[2]["tool_call_id"], "fc_1");
        assert_eq!(messages[2]["content"], "file contents");

        let mut openai = ChatBackend::new(ModelProvider::OpenAi, "system".into(), None);
        openai.record_tool_round(std::slice::from_ref(&tool), &[output_item]);
        openai.push_tool_result(&tool, "file contents", None);
        let openai_body = openai
            .build_body("gpt-5.6-sol", None, None, false, None)
            .expect("OpenAI body");
        let input = openai_body["input"].as_array().expect("input");
        assert_eq!(input[0]["type"], "function_call");
        assert_eq!(input[0]["call_id"], "call_1");
        assert_eq!(input[0]["name"], "read");
        assert_eq!(input[1]["type"], "function_call_output");
        assert_eq!(input[1]["call_id"], "call_1");
        assert_eq!(input[1]["output"], "file contents");
    }
}

#[cfg(test)]
mod monologue_tests {
    use super::{
        contains_tool_protocol, is_process_monologue, is_transient_http_status,
        is_transient_stream_error_msg, next_stream_item_or_stop, parallel_tool_limit,
        parse_user_input_questions, sanitize_user_facing_content, should_request_progress_check,
        should_stop, stream_idle_remaining, stream_retry_delay, strip_monologue_lines,
        AccumToolCall, StreamControl, StreamWait, UserInputDecision, AGENT_PROGRESS_CHECK_ROUNDS,
        MAX_AGENT_ROUNDS, MAX_PARALLEL_SUBAGENTS, MAX_PENDING_CANCELLATIONS, STREAM_IDLE_TIMEOUT,
    };
    use futures_util::stream;
    use std::sync::atomic::Ordering;
    use std::sync::Arc;
    use std::time::{Duration, Instant};

    #[test]
    fn stream_idle_deadline_expires_without_progress() {
        let started = Instant::now();
        let limit = Duration::from_secs(60);

        assert_eq!(
            stream_idle_remaining(started, started + Duration::from_secs(15), limit),
            Some(Duration::from_secs(45))
        );
        assert_eq!(
            stream_idle_remaining(started, started + Duration::from_secs(60), limit),
            None
        );
        assert!(is_transient_stream_error_msg(
            "Stream stalled: no model events for 600 seconds."
        ));
        assert!(is_transient_stream_error_msg(
            "Stream stalled: no model events for 60 seconds."
        ));
        assert_eq!(STREAM_IDLE_TIMEOUT, Duration::from_secs(600));
        assert_eq!(stream_retry_delay(0), Duration::from_secs(2));
        assert_eq!(stream_retry_delay(1), Duration::from_secs(4));
        assert_eq!(stream_retry_delay(2), Duration::from_secs(8));
        assert!(is_transient_http_status(409));
        assert!(is_transient_http_status(524));
        assert!(!is_transient_http_status(401));
    }

    #[test]
    fn parallel_task_batches_are_bounded_but_plain_reads_stay_parallel() {
        let task_tools = vec![
            AccumToolCall {
                name: "task".into(),
                ..Default::default()
            };
            7
        ];
        assert_eq!(parallel_tool_limit(&task_tools), MAX_PARALLEL_SUBAGENTS);

        let read_tools = vec![
            AccumToolCall {
                name: "read".into(),
                ..Default::default()
            };
            7
        ];
        assert_eq!(parallel_tool_limit(&read_tools), read_tools.len());
    }

    #[test]
    fn parses_structured_user_input_for_native_providers() {
        let questions = parse_user_input_questions(
            r#"{"questions":[{"header":"Runtime","question":"Which runtime?","options":[{"label":"OpenCode","description":"Use the CLI runtime"}],"multiple":false,"custom":true}]}"#,
        )
        .expect("question arguments");
        assert_eq!(questions.len(), 1);
        assert_eq!(questions[0].header, "Runtime");
        assert_eq!(questions[0].options[0].label, "OpenCode");
        assert!(questions[0].custom);
    }

    #[test]
    fn agent_round_policy_checks_progress_before_the_hard_limit() {
        assert_eq!(AGENT_PROGRESS_CHECK_ROUNDS, &[6, 12, 18]);
        assert_eq!(MAX_AGENT_ROUNDS, 24);
        assert!(*AGENT_PROGRESS_CHECK_ROUNDS.last().unwrap() + 1 < MAX_AGENT_ROUNDS);

        assert!(!should_request_progress_check(5, true, false));
        assert!(should_request_progress_check(6, true, false));
        assert!(!should_request_progress_check(7, true, false));
        assert!(should_request_progress_check(12, true, false));
        assert!(should_request_progress_check(18, true, false));
        assert!(!should_request_progress_check(12, false, false));
        assert!(!should_request_progress_check(12, true, true));
    }

    #[test]
    fn stale_stream_end_does_not_unregister_replacement() {
        let ctrl = StreamControl::new();
        let (first, _first_gen) = ctrl.begin("thread-1", "request-1");
        let (replacement, _replacement_gen) = ctrl.begin("thread-1", "request-2");

        ctrl.end("thread-1", &first);
        ctrl.cancel("thread-1", "request-2");

        assert!(replacement.cancelled.load(Ordering::SeqCst));
    }

    #[test]
    fn cancel_before_begin_is_consumed_by_the_matching_request() {
        let ctrl = StreamControl::new();
        ctrl.cancel("thread-1", "request-1");

        let (live, generation) = ctrl.begin("thread-1", "request-1");

        assert!(should_stop(&live, generation));
    }

    #[test]
    fn stale_cancel_does_not_stop_a_replacement_request() {
        let ctrl = StreamControl::new();
        let (_first, _first_generation) = ctrl.begin("thread-1", "request-1");
        let (replacement, replacement_generation) = ctrl.begin("thread-1", "request-2");

        ctrl.cancel("thread-1", "request-1");

        assert!(!should_stop(&replacement, replacement_generation));
    }

    #[test]
    fn pending_cancellations_are_bounded() {
        let ctrl = StreamControl::new();
        for index in 0..(MAX_PENDING_CANCELLATIONS + 10) {
            ctrl.cancel("thread-1", &format!("request-{index}"));
        }

        let registry = ctrl.streams.lock().expect("stream map");
        assert_eq!(
            registry.cancelled_before_begin.len(),
            MAX_PENDING_CANCELLATIONS
        );
        assert_eq!(registry.cancellation_order.len(), MAX_PENDING_CANCELLATIONS);
        assert!(!registry
            .cancelled_before_begin
            .contains(&("thread-1".into(), "request-0".into())));
    }

    #[tokio::test]
    async fn pending_stream_wait_returns_promptly_after_cancellation() {
        let cancelled = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let stop_flag = Arc::clone(&cancelled);
        let mut pending = stream::pending::<u8>();
        let waiter = tokio::spawn(async move {
            let stop = || stop_flag.load(Ordering::SeqCst);
            next_stream_item_or_stop(&mut pending, &stop, Duration::from_secs(60)).await
        });

        tokio::time::sleep(Duration::from_millis(10)).await;
        cancelled.store(true, Ordering::SeqCst);
        let result = tokio::time::timeout(Duration::from_millis(250), waiter)
            .await
            .expect("cancelled stream wait should return promptly")
            .expect("wait task");

        assert!(matches!(result, StreamWait::Cancelled));
    }

    #[test]
    fn stale_stream_end_does_not_force_deny_replacement_approvals() {
        use super::ApprovalDecision;
        use tokio::sync::oneshot::error::TryRecvError;

        let ctrl = StreamControl::new();
        let (first, _first_gen) = ctrl.begin("thread-1", "request-1");
        let (_replacement, _replacement_gen) = ctrl.begin("thread-1", "request-2");

        // The replacement stream parks an approval for its own tool.
        let mut rx = ctrl
            .register_approval("thread-1", "tool-1")
            .expect("approval registers");

        // The superseded stream unwinds later; it must not deny the
        // replacement's pending approval.
        ctrl.end("thread-1", &first);
        assert!(matches!(rx.try_recv(), Err(TryRecvError::Empty)));

        // The owning stream still clears its own approvals on end.
        ctrl.end("thread-1", &_replacement);
        assert!(matches!(rx.try_recv(), Ok(ApprovalDecision::Deny)));
    }

    #[test]
    fn cancelling_a_stream_rejects_its_pending_user_input() {
        let ctrl = StreamControl::new();
        let (_live, _generation) = ctrl.begin("thread-1", "request-1");
        let mut rx = ctrl
            .register_user_input("thread-1", "question-1")
            .expect("question registers");

        ctrl.cancel("thread-1", "request-1");

        assert!(matches!(rx.try_recv(), Ok(UserInputDecision::Reject)));
    }

    #[test]
    fn detects_implement_loop() {
        let dump = "I'll inspect the sidebar.\nI'll edit Sidebar.tsx.\nImplementing now.\nMaking the edit.\nUpdating files.";
        assert!(is_process_monologue(dump));
        assert!(sanitize_user_facing_content(dump).is_empty());
    }

    #[test]
    fn drops_compact_tool_transcript_dump() {
        let dump = "[tool grep · path C:\\work\\src\\MessageList.tsx · pattern AssistantTurn|MessageList] [tool read · filePath C:\\work\\src\\MessageList.tsx · offset 330 · limit 150]";

        assert!(contains_tool_protocol(dump));
        assert!(sanitize_user_facing_content(dump).is_empty());
    }

    #[test]
    fn drops_other_tool_protocol_formats() {
        let dumps = [
            "<tool_call>{\"name\":\"read\",\"arguments\":{}}</tool_call>",
            "assistant to=functions.read filePath=/tmp/a",
            "<|channel|>analysis <|recipient|>functions.grep",
            "{\"tool_calls\":[{\"type\":\"function\"}]}",
            "{\"type\":\"function\",\"name\":\"read\",\"arguments\":\"{}\"}",
            "tool grep · path C:\\work\\a.ts · pattern Foo",
            "functions.edit path=src/a.ts",
            "invoke tool read with filePath src/a.ts",
        ];

        for dump in dumps {
            assert!(contains_tool_protocol(dump), "missed: {dump}");
            assert!(
                sanitize_user_facing_content(dump).is_empty(),
                "leaked: {dump}"
            );
        }
    }

    #[test]
    fn strips_protocol_keeps_real_prose() {
        let mixed = "Fixed the stall timeout.\n\n[tool grep · path src/a.ts · pattern foo]\n\nRestart the app.";
        assert!(contains_tool_protocol(mixed));
        let out = sanitize_user_facing_content(mixed);
        assert!(out.contains("Fixed the stall timeout"), "out={out}");
        assert!(out.contains("Restart the app"), "out={out}");
        assert!(!out.to_ascii_lowercase().contains("[tool"), "out={out}");
        assert!(!contains_tool_protocol(&out), "out={out}");
    }

    #[test]
    fn keeps_prose_that_mentions_protocol_field_names() {
        let prose = "The tool_result field is optional and function_call is legacy.";

        assert!(!contains_tool_protocol(prose));
        assert_eq!(sanitize_user_facing_content(prose), prose);
    }

    #[test]
    fn thinking_drops_protocol_dumps() {
        use super::sanitize_thinking_content;
        let dump = "[tool read · filePath src/a.ts · offset 1 · limit 20]";
        assert!(sanitize_thinking_content(dump).is_empty());
        let mixed = "Checking auth flow.\n[tool grep · path src · pattern login]";
        let out = sanitize_thinking_content(mixed);
        assert!(out.contains("Checking auth flow"), "out={out}");
        assert!(!out.contains("[tool"), "out={out}");
    }

    #[test]
    fn keeps_real_answer_with_code() {
        let ans =
            "Update `auth.plan` as follows:\n\n```rs\nplan: None,\n```\n\nThen restart the app.";
        assert!(!is_process_monologue(ans));
        assert!(sanitize_user_facing_content(ans).contains("auth.plan"));
        assert!(!contains_tool_protocol(ans));
    }

    #[test]
    fn strips_mixed_monologue_lines() {
        let mixed = "I'll edit the file now.\n\nUse Profile > Sign out.\n\nImplementing now.";
        let out = strip_monologue_lines(mixed);
        assert!(out.contains("Profile"));
        assert!(!out.to_ascii_lowercase().contains("implementing"));
    }
}
