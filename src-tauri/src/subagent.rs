//! Nested agent workers spawned by the parent via the `task` tool.
//!
//! Design notes drawn from the local reference runtimes:
//! - capability boundary is the tool itself (child gets a role-filtered toolset)
//! - depth limit 1: children cannot spawn further children
//! - read-only roles may fan out in parallel; write-capable roles stay serial
//! - parent cancel stops child loops through a shared predicate

use crate::chat::{
    drain_chat_sse_with_idle_timeout, future_or_stop, is_transient_stream_error_msg,
    provider_error_detail, round_stream_out_from_responses, stream_retry_delay,
    with_provider_detail, AccumToolCall, ChatBackend, RoundStreamOut, STREAM_MAX_RETRIES,
};
use crate::permission::{approval_reason, tool_needs_approval};
use crate::prompts::format_subagent_system_prompt;
use crate::provider::ModelProvider;
use crate::tools::{
    canonical_tool_name_pub, execute_tool_with_depth, tool_definitions_for, MutationCapture,
};
use serde::Deserialize;
use serde_json::Value;
use std::collections::HashMap;
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::Semaphore;

const API_BASE: &str = "https://api.x.ai/v1";
const MAX_CHILD_ROUNDS: usize = 10;
const MAX_CHILD_RESULT_CHARS: usize = 24_000;
const MAX_CHILD_TOOL_RESULT_CHARS: usize = 24_000;
const MAX_CHILD_TOOL_CONTEXT_CHARS: usize = 160_000;
const MAX_CHILD_REQUEST_BYTES: usize = 600_000;
const MAX_ACTIVE_SUBAGENTS_PER_PROVIDER: usize = 3;
const STREAM_IDLE_TIMEOUT: Duration = Duration::from_secs(180);

pub type CancelCheck = Arc<dyn Fn() -> bool + Send + Sync>;

/// Returns a fresh access token so long child runs survive token expiry.
pub type TokenRefresher =
    Arc<dyn Fn() -> futures_util::future::BoxFuture<'static, Result<String, String>> + Send + Sync>;

/// Live nested tool progress for the parent `task` row in the UI.
#[derive(Debug, Clone)]
pub enum ChildToolEvent {
    Start {
        parent_id: String,
        id: String,
        name: String,
        args: String,
        awaiting_approval: bool,
        approval_reason: Option<String>,
    },
    Result {
        parent_id: String,
        id: String,
        name: String,
        ok: bool,
        result: String,
    },
}

pub type ChildToolSink = Arc<dyn Fn(ChildToolEvent) + Send + Sync>;

/// Live output chunks from a running tool (currently foreground bash):
/// `(tool_call_id, text_chunk)`. The chat loop forwards these to the UI.
pub type ToolOutputSink = Arc<dyn Fn(String, String, bool) + Send + Sync>;
pub type UsageSink = Arc<dyn Fn(crate::openai::ResponsesUsage) + Send + Sync>;

/// Park until the user approves/denies a nested child tool (Ask mode).
/// Argument is the UI tool id (`parent::child`). Returns true if allowed.
pub type ChildApprovalWait = Arc<
    dyn Fn(String) -> std::pin::Pin<Box<dyn std::future::Future<Output = bool> + Send>>
        + Send
        + Sync,
>;

/// Cap nested progress payloads so the UI stream stays light (model still gets full tool results).
const MAX_CHILD_PROGRESS_CHARS: usize = 2_000;

fn clip_progress(s: &str) -> String {
    let t = s.trim();
    if t.chars().count() <= MAX_CHILD_PROGRESS_CHARS {
        return t.to_string();
    }
    let clipped: String = t.chars().take(MAX_CHILD_PROGRESS_CHARS).collect();
    format!("{clipped}…")
}

/// Keep mutation results intact so Review / live file stats still see full diffs.
fn clip_child_progress_result(tool_name: &str, s: &str) -> String {
    let n = canonical_tool_name_pub(tool_name);
    if matches!(n, "write" | "edit" | "patch" | "delete") {
        return s.to_string();
    }
    clip_progress(s)
}

fn bounded_child_tool_result(text: &str, accumulated_chars: &mut usize) -> String {
    let remaining = MAX_CHILD_TOOL_CONTEXT_CHARS.saturating_sub(*accumulated_chars);
    if remaining == 0 {
        return String::new();
    }

    let original_chars = text.chars().count();
    let limit = remaining.min(MAX_CHILD_TOOL_RESULT_CHARS);
    if original_chars <= limit && original_chars < remaining {
        *accumulated_chars += original_chars;
        return text.to_string();
    }

    let note = format!(
        "\n… (tool output clipped from {original_chars} chars; context budget reached — finish from the evidence already gathered)"
    );
    let note_chars = note.chars().count();
    let result = if note_chars >= limit {
        note.chars().take(limit).collect()
    } else {
        let body: String = text.chars().take(limit - note_chars).collect();
        format!("{body}{note}")
    };
    *accumulated_chars += result.chars().count();
    result
}

fn retain_latest_partial_text(current: &mut String, candidate: String) {
    if !candidate.trim().is_empty() {
        *current = candidate;
    }
}

fn finalize_child_text(current: &mut String, candidate: String) {
    retain_latest_partial_text(current, candidate);
    if current.trim().is_empty() {
        *current = "(Subagent finished with no text output.)".into();
    }
}

fn child_tools_allowed(round: usize, accumulated_tool_chars: usize) -> bool {
    round + 1 < MAX_CHILD_ROUNDS && accumulated_tool_chars < MAX_CHILD_TOOL_CONTEXT_CHARS
}

fn child_request_exceeds_limit(body: &Value) -> bool {
    serde_json::to_vec(body)
        .map(|bytes| bytes.len() > MAX_CHILD_REQUEST_BYTES)
        .unwrap_or(true)
}

fn provider_subagent_semaphore(provider: ModelProvider) -> &'static Semaphore {
    static GROK: Semaphore = Semaphore::const_new(MAX_ACTIVE_SUBAGENTS_PER_PROVIDER);
    static OPENAI: Semaphore = Semaphore::const_new(MAX_ACTIVE_SUBAGENTS_PER_PROVIDER);
    static ANTIGRAVITY: Semaphore = Semaphore::const_new(MAX_ACTIVE_SUBAGENTS_PER_PROVIDER);
    static OPENCODE: Semaphore = Semaphore::const_new(MAX_ACTIVE_SUBAGENTS_PER_PROVIDER);
    match provider {
        ModelProvider::Grok => &GROK,
        ModelProvider::OpenAi => &OPENAI,
        ModelProvider::Antigravity => &ANTIGRAVITY,
        ModelProvider::OpenCode => &OPENCODE,
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SubagentRole {
    Explore,
    Reviewer,
    General,
}

impl SubagentRole {
    pub fn parse(raw: &str) -> Option<Self> {
        match raw.trim().to_ascii_lowercase().as_str() {
            "explore" | "explorer" | "search" => Some(Self::Explore),
            "reviewer" | "review" | "code-review" => Some(Self::Reviewer),
            // OpenCode-style "build"; keep general/builder/worker as aliases.
            "build" | "general" | "builder" | "worker" => Some(Self::General),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Explore => "explore",
            Self::Reviewer => "reviewer",
            // Wire + UI name is "build" (general remains an internal enum variant).
            Self::General => "build",
        }
    }

    pub fn allowed_tools(self) -> &'static [&'static str] {
        match self {
            // Read-only roles: no bash (full shell can mutate despite prompts).
            Self::Explore => &["read", "glob", "grep", "webfetch", "websearch"],
            Self::Reviewer => &["read", "glob", "grep", "webfetch", "websearch"],
            // Write-capable worker, but never nested task / shared todos.
            Self::General => &[
                "read",
                "write",
                "edit",
                "patch",
                "bash",
                "glob",
                "grep",
                "webfetch",
                "websearch",
                "delete",
            ],
        }
    }

    pub fn allows_mutation(self) -> bool {
        matches!(self, Self::General)
    }

    pub fn system_prompt(self) -> &'static str {
        match self {
            Self::Explore => {
                "Your assigned role is explore. Locate files, symbols, and answer codebase questions. \
                 Use only glob/grep/read/webfetch/websearch. Do not edit files or run shell commands. \
                 Return a concise report with paths and the evidence you found. No tool protocol dumps."
            }
            Self::Reviewer => {
                "Your assigned role is reviewer. Inspect diffs and code for bugs, regressions, and missing tests. \
                 Read-only only (glob/grep/read/webfetch/websearch). Do not edit files or run shell commands. \
                 Return findings as short bullets with file references and concrete fixes. \
                 No tool protocol dumps."
            }
            Self::General => {
                "Your assigned role is build. Complete the assigned multi-step unit of work with tools. \
                 You may edit files. Make the smallest complete change, verify when feasible, and return \
                 a concise summary of what changed and what remains. Do not spawn further subagents. \
                 No tool protocol dumps."
            }
        }
    }
}

#[derive(Debug, Clone)]
pub struct SubagentRequest {
    pub description: String,
    pub prompt: String,
    pub role: SubagentRole,
}

#[derive(Clone)]
pub struct SubagentHost {
    pub token: String,
    /// Refreshes the token before each child round; falls back to `token`.
    pub token_refresher: Option<TokenRefresher>,
    /// Which model wire the child rounds speak (matches the parent model).
    pub provider: ModelProvider,
    /// OpenAI only: `chatgpt-account-id` request header value.
    pub account_id: Option<String>,
    pub model: String,
    pub reasoning_effort: Option<String>,
    /// OpenAI only: canonical service tier inherited from the parent turn.
    pub service_tier: Option<String>,
    /// Nesting depth of this agent (0 = top-level chat, 1 = first child).
    pub depth: u32,
    pub cancel: CancelCheck,
    /// Optional sink for nested child tool start/result events (UI only).
    pub child_tools: Option<ChildToolSink>,
    /// When set, mutation/bash child tools park for user approval before run.
    pub approval_wait: Option<ChildApprovalWait>,
    /// Live tool output (foreground bash stdout/stderr chunks) for the UI.
    pub tool_output: Option<ToolOutputSink>,
    /// Official provider usage for each successful OpenAI child round.
    pub usage: Option<UsageSink>,
    /// Provider-neutral application tools available to this agent context.
    pub agent_tools: Option<crate::agent_tools::AgentToolHandler>,
}

fn forward_child_usage(
    provider: ModelProvider,
    usage: Option<crate::openai::ResponsesUsage>,
    sink: Option<&UsageSink>,
) {
    if provider != ModelProvider::OpenAi {
        return;
    }
    if let (Some(usage), Some(sink)) = (usage, sink) {
        sink(usage);
    }
}

#[derive(Debug, Deserialize)]
struct TaskArgs {
    #[serde(default)]
    description: Option<String>,
    #[serde(default)]
    prompt: Option<String>,
    #[serde(alias = "subagent_type", alias = "agent", alias = "type")]
    subagent_type: String,
}

pub fn parse_task_args(arguments: &str) -> Result<SubagentRequest, String> {
    let raw: TaskArgs = if arguments.trim().is_empty() {
        return Err("missing task arguments".into());
    } else {
        serde_json::from_str(arguments).map_err(|e| format!("bad task args: {e}"))?
    };
    let description = raw
        .description
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty());
    let prompt = raw
        .prompt
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .or(description)
        .unwrap_or_default()
        .to_string();
    if prompt.is_empty() {
        return Err("task prompt must not be empty".into());
    }
    let role = SubagentRole::parse(&raw.subagent_type).ok_or_else(|| {
        format!(
            "Unknown subagent_type {:?}. Use explore, reviewer, or build.",
            raw.subagent_type
        )
    })?;
    let description = description
        .unwrap_or("subagent task")
        .chars()
        .take(80)
        .collect::<String>();
    Ok(SubagentRequest {
        description,
        prompt,
        role,
    })
}

/// True when this tool invocation must not race with other file mutations.
pub fn tool_requires_serial(name: &str, arguments: &str) -> bool {
    let n = canonical_tool_name_pub(name);
    if matches!(
        n,
        "edit" | "write" | "delete" | "patch" | "bash" | "question" | "todowrite"
    ) {
        return true;
    }
    if n == "task" {
        return parse_task_args(arguments)
            .map(|r| r.role.allows_mutation())
            .unwrap_or(true);
    }
    false
}

fn format_partial_task_error(error: &str, final_text: &str, completed_tools: &[String]) -> String {
    if final_text.trim().is_empty() && completed_tools.is_empty() {
        return error.to_string();
    }
    let mut partial = Vec::new();
    if !final_text.trim().is_empty() {
        partial.push(format!("Partial report:\n{}", final_text.trim()));
    }
    if !completed_tools.is_empty() {
        partial.push(format!(
            "Processed child tools: {}",
            completed_tools.join(", ")
        ));
    }
    format!(
        "Subagent stopped after partial progress: {error}\n{}",
        partial.join("\n")
    )
}

pub async fn run_task(
    project_root: &Path,
    host: &SubagentHost,
    req: SubagentRequest,
    full_access: bool,
    capture: Option<MutationCapture<'_>>,
    // Parent `task` tool call id — nests live child progress under the UI row.
    parent_tool_id: Option<&str>,
) -> Result<String, String> {
    // Nested spawn is enforced in execute_tool (depth >= 1 denies `task`).
    // `host.depth` is the child's own nesting level for its tool calls.

    let client = shared_http_client()?;
    let root = project_root.to_path_buf();
    let tools = tool_definitions_for(req.role.allowed_tools());
    let mut backend = ChatBackend::new(
        host.provider,
        format_subagent_system_prompt(req.role.system_prompt(), &root, full_access),
        host.account_id.clone(),
    );
    backend.push_user_text(&format!(
        "Task: {}\n\n{}\n\nWhen finished, reply with a concise final report only.",
        req.description, req.prompt
    ));

    let mut final_text = String::new();
    let mut completed_tools = Vec::new();
    let mut child_tool_context_chars = 0;
    let parent_id = parent_tool_id
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string());
    let retry_seed = parent_id
        .as_deref()
        .unwrap_or(req.description.as_str())
        .to_string();

    for round in 0..MAX_CHILD_ROUNDS {
        if (host.cancel)() {
            return Err("Subagent cancelled".into());
        }

        let allow_tools = child_tools_allowed(round, child_tool_context_chars);
        let body = backend.build_body(
            &host.model,
            host.reasoning_effort.as_deref(),
            host.service_tier.as_deref(),
            allow_tools,
            allow_tools.then(|| tools.clone()),
        )?;
        if child_request_exceeds_limit(&body) {
            return Err(format_partial_task_error(
                "The delegated task reached its safe context limit.",
                &final_text,
                &completed_tools,
            ));
        }

        // Refresh each round so long child runs don't die on an expired token.
        let round_token = match &host.token_refresher {
            Some(refresh) => refresh().await.unwrap_or_else(|_| host.token.clone()),
            None => host.token.clone(),
        };
        let permit = future_or_stop(
            provider_subagent_semaphore(host.provider).acquire(),
            host.cancel.as_ref(),
        )
        .await
        .ok_or_else(|| "Subagent cancelled".to_string())?
        .map_err(|_| "Subagent scheduler unavailable".to_string())?;
        let round_result = stream_child_round(
            &client,
            &round_token,
            &body,
            &host.cancel,
            host.provider,
            host.account_id.as_deref(),
            &retry_seed,
        )
        .await;
        drop(permit);
        let mut out = match round_result {
            Ok(out) => out,
            Err(error) => {
                return Err(format_partial_task_error(
                    &error,
                    &final_text,
                    &completed_tools,
                ));
            }
        };
        forward_child_usage(host.provider, out.usage.take(), host.usage.as_ref());
        if (host.cancel)() {
            return Err("Subagent cancelled".into());
        }

        let output_items = std::mem::take(&mut out.output_items);
        let mut tools_acc = ordered_tools(out.tools);
        for (i, t) in tools_acc.iter_mut().enumerate() {
            if t.id.is_empty() {
                t.id = format!("child_call_{i}");
            }
            if t.name.is_empty() {
                t.name = "unknown".into();
            }
        }

        let wants_tools = allow_tools && !tools_acc.is_empty();

        if !wants_tools {
            finalize_child_text(&mut final_text, out.content);
            break;
        }

        backend.record_tool_round(&tools_acc, &output_items);

        // Child tools always serial — nested fan-out is the parent's job.
        for t in &tools_acc {
            if (host.cancel)() {
                return Err("Subagent cancelled".into());
            }
            // Child depth (>=1) so nested `task` is denied; allowlist enforces role.
            // Snapshot under parent tool id when the host captured one.
            let child_capture = capture.map(|c| MutationCapture {
                stream_id: c.stream_id,
                tool_id: c.tool_id,
                snapshots: c.snapshots,
                workspace_root: c.workspace_root,
                full_access: c.full_access,
            });
            let canon = canonical_tool_name_pub(&t.name);
            let needs_ask = host.approval_wait.is_some() && tool_needs_approval(canon);
            let reason = if needs_ask {
                Some(approval_reason(canon).to_string())
            } else {
                None
            };
            let ui_id = parent_id
                .as_ref()
                .map(|pid| nested_child_ui_id(pid, &t.id))
                .unwrap_or_else(|| t.id.clone());
            if let (Some(pid), Some(sink)) = (parent_id.as_ref(), host.child_tools.as_ref()) {
                // Namespace UI child ids under the parent task so parallel
                // explore tasks never collide on model-issued tool_call ids.
                sink(ChildToolEvent::Start {
                    parent_id: pid.clone(),
                    id: ui_id.clone(),
                    name: t.name.clone(),
                    args: clip_progress(&t.arguments),
                    awaiting_approval: needs_ask,
                    approval_reason: reason.clone(),
                });
            }
            if needs_ask {
                let allowed = if let Some(wait) = host.approval_wait.as_ref() {
                    wait(ui_id.clone()).await
                } else {
                    false
                };
                if (host.cancel)() {
                    let content = "Cancelled before tool ran".to_string();
                    if let (Some(pid), Some(sink)) = (parent_id.as_ref(), host.child_tools.as_ref())
                    {
                        sink(ChildToolEvent::Result {
                            parent_id: pid.clone(),
                            id: ui_id.clone(),
                            name: t.name.clone(),
                            ok: false,
                            result: clip_child_progress_result(&t.name, &content),
                        });
                    }
                    completed_tools.push(format!("{} (cancelled)", t.name));
                    let model_content = bounded_child_tool_result(
                        &format!("ERROR: {content}"),
                        &mut child_tool_context_chars,
                    );
                    backend.push_tool_result(t, &model_content, None);
                    continue;
                }
                if !allowed {
                    let content = "Denied by user".to_string();
                    if let (Some(pid), Some(sink)) = (parent_id.as_ref(), host.child_tools.as_ref())
                    {
                        sink(ChildToolEvent::Result {
                            parent_id: pid.clone(),
                            id: ui_id.clone(),
                            name: t.name.clone(),
                            ok: false,
                            result: clip_child_progress_result(&t.name, &content),
                        });
                    }
                    completed_tools.push(format!("{} (denied)", t.name));
                    let model_content = bounded_child_tool_result(
                        &format!("ERROR: {content}"),
                        &mut child_tool_context_chars,
                    );
                    backend.push_tool_result(t, &model_content, None);
                    continue;
                }
            }
            let outcome = execute_tool_with_depth(
                &root,
                &t.name,
                &t.arguments,
                full_access,
                host.depth.max(1),
                None,
                Some(req.role.allowed_tools()),
                child_capture,
                Some(t.id.as_str()),
            )
            .await;
            let ok = outcome.ok;
            let content = if ok {
                outcome.text
            } else {
                format!("ERROR: {}", outcome.text)
            };
            completed_tools.push(format!("{} ({})", t.name, if ok { "ok" } else { "failed" }));
            if let (Some(pid), Some(sink)) = (parent_id.as_ref(), host.child_tools.as_ref()) {
                sink(ChildToolEvent::Result {
                    parent_id: pid.clone(),
                    id: nested_child_ui_id(pid, &t.id),
                    name: t.name.clone(),
                    ok,
                    result: clip_child_progress_result(&t.name, &content),
                });
            }
            let model_content = bounded_child_tool_result(&content, &mut child_tool_context_chars);
            backend.push_tool_result(t, &model_content, None);
        }
        retain_latest_partial_text(&mut final_text, out.content);
    }

    if final_text.trim().is_empty() {
        final_text = "(Subagent exhausted rounds without a final answer.)".into();
    }

    let codename = parent_id
        .as_deref()
        .map(codename_from_seed)
        .unwrap_or_else(|| codename_from_seed(&req.description));
    Ok(format_task_result(
        &req.description,
        req.role.as_str(),
        &codename,
        &final_text,
    ))
}

/// UI-only child tool id: `{parent}::{child}` so parallel tasks never clash.
fn nested_child_ui_id(parent_id: &str, child_id: &str) -> String {
    format!("{parent_id}::{child_id}")
}

/// Deterministic short codename (eager-fox) from a seed — matches frontend hashing.
fn codename_from_seed(seed: &str) -> String {
    const ADJECTIVES: &[&str] = &[
        "eager", "calm", "swift", "brave", "quiet", "bold", "keen", "warm", "cool", "bright",
        "clear", "sharp", "soft", "wild", "steady", "quick", "lucid", "nimble", "solid", "vivid",
    ];
    const NOUNS: &[&str] = &[
        "fox", "owl", "wolf", "hawk", "lynx", "bear", "seal", "kite", "wren", "lark", "pike",
        "moth", "fern", "oak", "ash", "elm", "reef", "dune", "glen", "brook",
    ];
    let mut h: u32 = 2166136261;
    for b in seed.as_bytes() {
        h ^= u32::from(*b);
        h = h.wrapping_mul(16777619);
    }
    let adj = ADJECTIVES[(h as usize) % ADJECTIVES.len()];
    let noun = NOUNS[((h >> 8) as usize) % NOUNS.len()];
    format!("{adj}-{noun}")
}

fn format_task_result(description: &str, role: &str, name: &str, body: &str) -> String {
    let mut text = body.trim().to_string();
    if text.chars().count() > MAX_CHILD_RESULT_CHARS {
        let clipped: String = text.chars().take(MAX_CHILD_RESULT_CHARS).collect();
        text = format!("{clipped}\n… (subagent output truncated)");
    }
    let name_attr = if name.trim().is_empty() {
        String::new()
    } else {
        format!(" name=\"{}\"", name.trim())
    };
    format!(
        "<task role=\"{role}\"{name_attr} state=\"completed\">\n<summary>{description}</summary>\n\
         <task_result>\n{text}\n</task_result>\n</task>"
    )
}

fn ordered_tools(mut map: HashMap<usize, AccumToolCall>) -> Vec<AccumToolCall> {
    let mut keys: Vec<usize> = map.keys().copied().collect();
    keys.sort_unstable();
    keys.into_iter().filter_map(|k| map.remove(&k)).collect()
}

fn shared_http_client() -> Result<reqwest::Client, String> {
    static CLIENT: std::sync::OnceLock<reqwest::Client> = std::sync::OnceLock::new();
    if let Some(c) = CLIENT.get() {
        return Ok(c.clone());
    }
    let built = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(20))
        .pool_max_idle_per_host(4)
        .tcp_nodelay(true)
        .http1_only()
        .user_agent(concat!("GrokDesktop/", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|e| format!("http client: {e}"))?;
    Ok(CLIENT.get_or_init(|| built).clone())
}

fn safe_subagent_http_error(status: u16) -> String {
    match status {
        401 => "Sign in again to continue.".into(),
        402 => "Usage limit reached.".into(),
        403 => "The delegated request is not allowed with the current permissions.".into(),
        408 | 504 => "The delegated request timed out.".into(),
        409 | 425 | 429 => "The service is receiving too many requests.".into(),
        500..=599 => "The model service is temporarily unavailable.".into(),
        _ => "The delegated task could not be completed.".into(),
    }
}

/// Transient child-round failures worth retrying. Stalled streams are
/// excluded — re-running against a silent provider only burns another idle
/// timeout without reviving the round.
fn is_transient_child_error(msg: &str) -> bool {
    let lower = msg.to_ascii_lowercase();
    if lower.contains("stalled") || lower.contains("idle timeout") {
        return false;
    }
    lower.contains("could not reach the model service")
        || lower.contains("was interrupted")
        || lower.contains("too many requests")
        || lower.contains("temporarily unavailable")
        || is_transient_stream_error_msg(msg)
}

fn retry_seed_hash(seed: &str) -> u64 {
    let mut hash = 2166136261_u64;
    for byte in seed.as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(1099511628211);
    }
    hash
}

/// Add a small per-task offset so parallel children do not retry in lockstep.
fn child_stream_retry_delay(retry_index: u32, seed: &str) -> Duration {
    let jitter_ms = retry_seed_hash(seed) % 1_000;
    stream_retry_delay(retry_index) + Duration::from_millis(jitter_ms)
}

/// Retry transient failures of one child round. Provider output stays buffered
/// until a terminal event, so re-running a failed round cannot duplicate tools
/// or visible text.
async fn stream_child_round(
    client: &reqwest::Client,
    token: &str,
    body: &Value,
    cancel: &CancelCheck,
    provider: ModelProvider,
    account_id: Option<&str>,
    retry_seed: &str,
) -> Result<RoundStreamOut, String> {
    let mut last_err = String::new();
    for attempt in 0..=STREAM_MAX_RETRIES {
        let attempt_result = match provider {
            ModelProvider::Grok => stream_child_round_once(client, token, body, cancel).await,
            ModelProvider::OpenAi => {
                stream_child_round_once_openai(token, account_id, body, cancel).await
            }
            ModelProvider::OpenCode => {
                Err("OpenCode child sessions are managed by OpenCode.".into())
            }
            ModelProvider::Antigravity => {
                Err("Antigravity child sessions are managed by Antigravity.".into())
            }
        };
        match attempt_result {
            Ok(out) => return Ok(out),
            Err(err) => {
                last_err = err;
                if attempt < STREAM_MAX_RETRIES && is_transient_child_error(&last_err) {
                    if (cancel)() {
                        return Err("Subagent cancelled".into());
                    }
                    tokio::time::sleep(child_stream_retry_delay(attempt, retry_seed)).await;
                    continue;
                }
                return Err(last_err);
            }
        }
    }
    Err(last_err)
}

async fn stream_child_round_once_openai(
    token: &str,
    account_id: Option<&str>,
    body: &Value,
    cancel: &CancelCheck,
) -> Result<RoundStreamOut, String> {
    let stop = || (cancel)();
    let out = crate::openai::stream_responses_once(token, account_id, body, &stop).await?;
    Ok(round_stream_out_from_responses(out))
}

async fn stream_child_round_once(
    client: &reqwest::Client,
    token: &str,
    body: &Value,
    cancel: &CancelCheck,
) -> Result<RoundStreamOut, String> {
    let request = client
        .post(format!("{API_BASE}/chat/completions"))
        .bearer_auth(token)
        .header("Accept", "text/event-stream")
        .header("Cache-Control", "no-cache")
        .json(body)
        .send();
    let Some(response) = future_or_stop(request, &|| (cancel)()).await else {
        return Ok(RoundStreamOut::default());
    };
    let response = response.map_err(|_| "Could not reach the model service.".to_string())?;

    if !response.status().is_success() {
        let status = response.status().as_u16();
        let detail = provider_error_detail(response).await;
        return Err(with_provider_detail(
            safe_subagent_http_error(status),
            detail,
        ));
    }

    drain_chat_sse_with_idle_timeout(response, &|| (cancel)(), STREAM_IDLE_TIMEOUT).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_roles_and_serial_policy() {
        let req = parse_task_args(
            r#"{"description":"Find auth","prompt":"Where is login?","subagent_type":"explore"}"#,
        )
        .unwrap();
        assert_eq!(req.role, SubagentRole::Explore);
        assert!(!req.role.allows_mutation());
        assert!(!tool_requires_serial(
            "task",
            r#"{"prompt":"x","subagent_type":"explore"}"#
        ));
        assert!(tool_requires_serial(
            "task",
            r#"{"prompt":"x","subagent_type":"build"}"#
        ));
        assert!(tool_requires_serial(
            "task",
            r#"{"prompt":"x","subagent_type":"general"}"#
        ));
        assert!(tool_requires_serial("edit", "{}"));
        assert!(SubagentRole::Explore.allowed_tools().contains(&"grep"));
        assert!(!SubagentRole::Explore.allowed_tools().contains(&"edit"));
        assert!(!SubagentRole::General.allowed_tools().contains(&"task"));
        assert_eq!(SubagentRole::parse("build"), Some(SubagentRole::General));
        assert_eq!(SubagentRole::General.as_str(), "build");
        assert_eq!(nested_child_ui_id("task-1", "call_0"), "task-1::call_0");
        let a = codename_from_seed("task-abc");
        let b = codename_from_seed("task-abc");
        assert_eq!(a, b);
        assert!(a.contains('-'));
        // Locked to frontend `codenameFromSeed` (FNV-1a + word lists).
        assert_eq!(codename_from_seed("task-1"), "solid-wren");
        assert_eq!(codename_from_seed("task-abc"), "bold-wolf");
        assert_eq!(codename_from_seed("call_xyz"), "bold-ash");
        assert_eq!(codename_from_seed("abc-def"), "calm-kite");
    }

    #[test]
    fn rejects_unknown_role_and_empty_prompt() {
        assert!(parse_task_args(r#"{"prompt":"hi","subagent_type":"wizard"}"#).is_err());
        assert!(parse_task_args(r#"{"prompt":"  ","subagent_type":"explore"}"#).is_err());
    }

    #[test]
    fn uses_description_when_prompt_is_missing() {
        let req = parse_task_args(
            r#"{"description":"Read the entire source code","subagent_type":"explore"}"#,
        )
        .unwrap();

        assert_eq!(req.description, "Read the entire source code");
        assert_eq!(req.prompt, "Read the entire source code");
        assert_eq!(req.role, SubagentRole::Explore);
    }

    #[test]
    fn role_prompts_do_not_override_xiao_identity() {
        for role in [
            SubagentRole::Explore,
            SubagentRole::Reviewer,
            SubagentRole::General,
        ] {
            let prompt = role.system_prompt();
            assert!(prompt.contains("assigned role"), "{prompt}");
            assert!(!prompt.contains("You are the"), "{prompt}");
        }
    }

    #[test]
    fn formats_completed_envelope() {
        let out = format_task_result("Find auth", "explore", "eager-fox", "Login is in auth.ts");
        assert!(out.contains("role=\"explore\""));
        assert!(out.contains("name=\"eager-fox\""));
        assert!(out.contains("Find auth"));
        assert!(out.contains("Login is in auth.ts"));
    }

    #[test]
    fn clips_read_progress_but_keeps_mutation_diffs() {
        let long = "x".repeat(MAX_CHILD_PROGRESS_CHARS + 50);
        let clipped = clip_progress(&long);
        assert!(clipped.ends_with('…'));
        assert!(clipped.chars().count() <= MAX_CHILD_PROGRESS_CHARS + 1);

        let edit = format!("Edited src/a.ts (ok)  +3 -1\n+line\n-old\n{}", long);
        let kept = clip_child_progress_result("edit", &edit);
        assert_eq!(kept, edit);
        assert!(clip_child_progress_result("grep", &long).ends_with('…'));
    }

    #[test]
    fn child_tool_results_are_bounded_per_call_and_in_aggregate() {
        let mut accumulated = 0;
        let mut returned_chars = 0;
        let long = "界".repeat(MAX_CHILD_TOOL_RESULT_CHARS + 500);
        let first = bounded_child_tool_result(&long, &mut accumulated);
        returned_chars += first.chars().count();
        assert!(first.chars().count() <= MAX_CHILD_TOOL_RESULT_CHARS);
        assert!(first.contains("tool output clipped"));
        assert!(!first.contains('\u{FFFD}'));

        for _ in 0..20 {
            let next = bounded_child_tool_result(&long, &mut accumulated);
            returned_chars += next.chars().count();
        }
        assert_eq!(accumulated, returned_chars);
        assert!(returned_chars <= MAX_CHILD_TOOL_CONTEXT_CHARS);
        assert!(bounded_child_tool_result("more", &mut accumulated).is_empty());
    }

    #[test]
    fn empty_round_text_does_not_erase_an_earlier_partial_report() {
        let mut partial = "Found the relevant files.".to_string();
        retain_latest_partial_text(&mut partial, String::new());
        assert_eq!(partial, "Found the relevant files.");
        finalize_child_text(&mut partial, String::new());
        assert_eq!(partial, "Found the relevant files.");
        retain_latest_partial_text(&mut partial, "Final evidence.".into());
        assert_eq!(partial, "Final evidence.");

        let mut empty = String::new();
        finalize_child_text(&mut empty, String::new());
        assert_eq!(empty, "(Subagent finished with no text output.)");
    }

    #[test]
    fn context_budget_forces_a_final_round_and_caps_serialized_requests() {
        assert!(child_tools_allowed(0, MAX_CHILD_TOOL_CONTEXT_CHARS - 1));
        assert!(!child_tools_allowed(0, MAX_CHILD_TOOL_CONTEXT_CHARS));
        assert!(!child_tools_allowed(MAX_CHILD_ROUNDS - 1, 0));

        assert!(!child_request_exceeds_limit(
            &serde_json::json!({"input": "small"})
        ));
        assert!(child_request_exceeds_limit(&serde_json::json!({
            "input": "x".repeat(MAX_CHILD_REQUEST_BYTES + 1)
        })));
    }

    #[test]
    fn provider_semaphore_caps_concurrent_subagents_globally() {
        let semaphore = provider_subagent_semaphore(ModelProvider::Grok);
        let permits = (0..MAX_ACTIVE_SUBAGENTS_PER_PROVIDER)
            .map(|_| semaphore.try_acquire().unwrap())
            .collect::<Vec<_>>();
        assert!(semaphore.try_acquire().is_err());
        drop(permits);
        assert!(semaphore.try_acquire().is_ok());
    }

    #[test]
    fn forbidden_child_requests_are_not_reported_as_expired_sessions() {
        assert_eq!(safe_subagent_http_error(401), "Sign in again to continue.");
        assert!(safe_subagent_http_error(403).contains("current permissions"));
    }

    #[test]
    fn later_round_failure_keeps_partial_report_and_tool_progress() {
        let tools = vec!["read (ok)".into(), "grep (failed)".into()];
        let report = format_partial_task_error(
            "Connection to the model service was interrupted.",
            "I found the relevant files.",
            &tools,
        );
        assert!(report.contains("Partial report:"));
        assert!(report.contains("I found the relevant files."));
        assert!(report.contains("read (ok), grep (failed)"));
        assert!(report.contains("Connection to the model service was interrupted."));

        assert_eq!(
            format_partial_task_error("first round failed", "", &[]),
            "first round failed"
        );
    }

    #[test]
    fn idle_child_streams_are_not_retried() {
        assert!(!is_transient_child_error("Subagent stream idle timeout"));
        assert!(!is_transient_child_error(
            "Subagent stream stalled for 180s"
        ));
        assert!(is_transient_child_error(
            "The model service is temporarily unavailable."
        ));
    }

    #[test]
    fn child_retries_are_stable_per_task_but_offset_from_base_delay() {
        let first = child_stream_retry_delay(1, "task-a");
        let same = child_stream_retry_delay(1, "task-a");
        let base = stream_retry_delay(1);
        assert_eq!(first, same);
        assert!(first >= base);
        assert!(first < base + Duration::from_secs(1));
    }

    #[test]
    fn child_tool_sink_receives_start_and_result() {
        use std::sync::Mutex;
        let log: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
        let log2 = Arc::clone(&log);
        let sink: ChildToolSink = Arc::new(move |ev| {
            let mut g = log2.lock().unwrap();
            match ev {
                ChildToolEvent::Start {
                    parent_id,
                    id,
                    name,
                    awaiting_approval,
                    ..
                } => g.push(format!(
                    "start:{parent_id}:{id}:{name}:ask={awaiting_approval}"
                )),
                ChildToolEvent::Result {
                    parent_id,
                    id,
                    name,
                    ok,
                    ..
                } => g.push(format!("result:{parent_id}:{id}:{name}:{ok}")),
            }
        });
        sink(ChildToolEvent::Start {
            parent_id: "task-1".into(),
            id: "c1".into(),
            name: "grep".into(),
            args: r#"{"pattern":"login"}"#.into(),
            awaiting_approval: false,
            approval_reason: None,
        });
        sink(ChildToolEvent::Result {
            parent_id: "task-1".into(),
            id: "c1".into(),
            name: "grep".into(),
            ok: true,
            result: "hit".into(),
        });
        let g = log.lock().unwrap();
        assert_eq!(
            g.as_slice(),
            [
                "start:task-1:c1:grep:ask=false".to_string(),
                "result:task-1:c1:grep:true".to_string()
            ]
        );
    }

    #[test]
    fn forwards_each_openai_child_round_usage_once() {
        use crate::openai::ResponsesUsage;
        use std::sync::Mutex;

        let seen = Arc::new(Mutex::new(Vec::new()));
        let sink_seen = Arc::clone(&seen);
        let sink: UsageSink = Arc::new(move |usage| {
            sink_seen.lock().unwrap().push(usage.total_tokens);
        });

        for usage in [
            ResponsesUsage {
                input_tokens: 3,
                output_tokens: 2,
                total_tokens: 5,
            },
            ResponsesUsage {
                input_tokens: 7,
                output_tokens: 4,
                total_tokens: 11,
            },
        ] {
            forward_child_usage(ModelProvider::OpenAi, Some(usage), Some(&sink));
        }
        forward_child_usage(
            ModelProvider::Grok,
            Some(ResponsesUsage {
                input_tokens: 100,
                output_tokens: 100,
                total_tokens: 200,
            }),
            Some(&sink),
        );
        forward_child_usage(ModelProvider::OpenAi, None, Some(&sink));

        assert_eq!(*seen.lock().unwrap(), vec![5, 11]);
    }

    #[tokio::test]
    async fn explore_role_cannot_edit_files() {
        use std::fs;
        use std::time::{SystemTime, UNIX_EPOCH};

        let mut dir = std::env::temp_dir();
        let n = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        dir.push(format!("grokapp-subagent-allow-{n}"));
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("a.txt"), "keep").unwrap();

        let outcome = execute_tool_with_depth(
            &dir,
            "edit",
            r#"{"filePath":"a.txt","oldString":"keep","newString":"changed"}"#,
            false,
            1,
            None,
            Some(SubagentRole::Explore.allowed_tools()),
            None,
            None,
        )
        .await;
        assert!(!outcome.ok, "{}", outcome.text);
        assert!(
            outcome.text.to_ascii_lowercase().contains("not available"),
            "{}",
            outcome.text
        );
        let body = fs::read_to_string(dir.join("a.txt")).unwrap();
        assert_eq!(body, "keep");
        let _ = fs::remove_dir_all(&dir);
    }
}
