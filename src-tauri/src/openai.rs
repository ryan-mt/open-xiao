//! Direct OpenAI Responses API client for ChatGPT-auth sessions.
//!
//! This replaces the old Codex CLI wrapper: the app builds Responses input
//! items itself, streams SSE events, and runs tool calls through the shared
//! agent loop in `chat.rs`.

use crate::chat::{
    future_or_stop, is_transient_stream_error_msg, next_stream_item_or_stop, provider_error_detail,
    stream_retry_delay, with_provider_detail, ChatContent, ChatMessageIn, ContentPart, StreamWait,
    STREAM_MAX_RETRIES,
};
use crate::provider_output::ProviderLineBuffer;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::time::{Duration, Instant};

/// ChatGPT-auth Codex surface (mirrors codex-rs `CHATGPT_CODEX_BASE_URL`).
const RESPONSES_URL: &str = "https://chatgpt.com/backend-api/codex/responses";
/// "No bytes on the wire" idle budget for one streaming turn.
const STREAM_IDLE_TIMEOUT: Duration = Duration::from_secs(600);

/// One completed model turn as seen by the agent loop.
#[derive(Default, Clone)]
pub(crate) struct ResponsesTurnOut {
    pub content: String,
    pub reasoning_summary: String,
    /// Completed `function_call` items, in output order.
    pub tools: Vec<ResponsesToolCall>,
    /// Completed output items (message / reasoning / function_call) to append
    /// to the next request's input so multi-turn context — including encrypted
    /// reasoning — survives.
    pub output_items: Vec<Value>,
    pub response_id: Option<String>,
    pub usage: Option<ResponsesUsage>,
    /// True once `response.completed` or `response.incomplete` arrived.
    pub finished: bool,
}

#[derive(Default, Clone, Copy)]
pub(crate) struct ResponsesUsage {
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub total_tokens: u64,
}

#[derive(Default, Clone)]
pub(crate) struct ResponsesToolCall {
    /// Item id (`fc_…`) — stable UI identity for the tool row.
    pub id: String,
    /// `call_id` (`call_…`) — what `function_call_output` must reference.
    pub call_id: String,
    pub name: String,
    pub arguments: String,
}

/// Wire value for `reasoning.effort`. "ultra" is normalized to "max"
/// (codex-rs does the same before sending).
pub(crate) fn openai_reasoning_effort(raw: Option<&str>) -> Result<Option<&'static str>, String> {
    match raw.map(str::trim).filter(|v| !v.is_empty()) {
        None | Some("off") | Some("none") => Ok(None),
        Some(v) if v.eq_ignore_ascii_case("minimal") => Ok(Some("minimal")),
        Some(v) if v.eq_ignore_ascii_case("low") => Ok(Some("low")),
        Some(v) if v.eq_ignore_ascii_case("medium") => Ok(Some("medium")),
        Some(v) if v.eq_ignore_ascii_case("high") => Ok(Some("high")),
        Some(v) if v.eq_ignore_ascii_case("xhigh") => Ok(Some("xhigh")),
        Some(v) if v.eq_ignore_ascii_case("max") => Ok(Some("max")),
        Some(v) if v.eq_ignore_ascii_case("ultra") => Ok(Some("max")),
        Some(_) => Err("Unsupported OpenAI reasoning effort".into()),
    }
}

pub(crate) fn validate_chatgpt_codex_model(model: &str) -> Result<(), String> {
    let model = model.trim();
    if matches!(model, "gpt-5.6-sol" | "gpt-5.6-terra" | "gpt-5.6-luna") {
        return Ok(());
    }
    Err(format!(
        "Model {model} is not available through OpenAI ChatGPT/Codex sign-in. Choose a supported OpenAI model."
    ))
}

/// Canonical Fast-mode wire value. The static frontend catalog currently
/// exposes only these models; reject stale or forged unsupported selections
/// rather than silently charging for or downgrading an unintended tier.
pub(crate) fn openai_service_tier(
    model: &str,
    raw: Option<&str>,
) -> Result<Option<&'static str>, String> {
    let Some(tier) = raw.map(str::trim).filter(|value| !value.is_empty()) else {
        return Ok(None);
    };
    if tier.eq_ignore_ascii_case("default") || tier.eq_ignore_ascii_case("standard") {
        return Ok(None);
    }
    if !tier.eq_ignore_ascii_case("fast") && !tier.eq_ignore_ascii_case("priority") {
        return Err("Unsupported OpenAI service tier".into());
    }
    if !matches!(
        model.trim(),
        "gpt-5.6-sol" | "gpt-5.6-terra" | "gpt-5.6-luna"
    ) {
        return Err(format!("Fast mode is not supported by model {model}"));
    }
    Ok(Some("priority"))
}

/// Conversational state in Responses-API shape (`input` items).
#[derive(Default, Clone)]
pub(crate) struct OpenAiHistory {
    input: Vec<Value>,
}

impl OpenAiHistory {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn input(&self) -> &[Value] {
        &self.input
    }

    /// Client messages from the webview: only user/assistant turns (validated
    /// upstream by `sanitize_client_messages`).
    pub fn push_client_messages(&mut self, messages: Vec<ChatMessageIn>) {
        for message in messages {
            let role = if message.role == "assistant" {
                "assistant"
            } else {
                "user"
            };
            let content = match message.content {
                Some(ChatContent::Text(text)) => {
                    if text.trim().is_empty() {
                        Vec::new()
                    } else {
                        vec![message_text_part(role, &text)]
                    }
                }
                Some(ChatContent::Parts(parts)) => parts
                    .into_iter()
                    .filter_map(|part| match part {
                        ContentPart::Text { text } => {
                            if text.trim().is_empty() {
                                None
                            } else {
                                Some(message_text_part(role, &text))
                            }
                        }
                        ContentPart::ImageUrl { image_url } if role == "user" => Some(json!({
                            "type": "input_image",
                            "image_url": image_url.url,
                        })),
                        ContentPart::ImageUrl { .. } => None,
                    })
                    .collect(),
                None => Vec::new(),
            };
            if content.is_empty() {
                continue;
            }
            self.input.push(json!({
                "type": "message",
                "role": role,
                "content": content,
            }));
        }
    }

    /// System reminders / nudges ride as user messages in Responses input.
    pub fn push_user_text(&mut self, text: &str) {
        self.input.push(json!({
            "type": "message",
            "role": "user",
            "content": [text_part(text)],
        }));
    }

    /// Append the completed output items of one assistant turn.
    pub fn push_output_items(&mut self, items: Vec<Value>) {
        self.input.extend(items);
    }

    /// Append a tool result for one executed function call.
    pub fn push_tool_output(&mut self, call_id: &str, output: &str, image: Option<&str>) {
        self.input.push(json!({
            "type": "function_call_output",
            "call_id": call_id,
            "output": output,
        }));
        // Tool outputs cannot carry images; send the image as a follow-up
        // user item (same trick the Grok path uses).
        if let Some(url) = image {
            self.input.push(json!({
                "type": "message",
                "role": "user",
                "content": [
                    text_part("[Image file read by the read tool]"),
                    json!({ "type": "input_image", "image_url": url }),
                ],
            }));
        }
    }
}

fn text_part(text: &str) -> Value {
    json!({ "type": "input_text", "text": text })
}

fn message_text_part(role: &str, text: &str) -> Value {
    let kind = if role == "assistant" {
        "output_text"
    } else {
        "input_text"
    };
    json!({ "type": kind, "text": text })
}

pub(crate) fn build_request_body(
    model: &str,
    instructions: Option<&str>,
    history: &OpenAiHistory,
    effort: Option<&'static str>,
    service_tier: Option<&str>,
    allow_tools: bool,
    tool_definitions: Option<Value>,
) -> Value {
    let mut body = json!({
        "model": model,
        "input": history.input(),
        "stream": true,
        "store": false,
        // Keep encrypted reasoning so multi-turn context stays coherent.
        "include": ["reasoning.encrypted_content"],
    });
    if let Some(instructions) = instructions.filter(|s| !s.is_empty()) {
        body["instructions"] = json!(instructions);
    }
    if let Some(effort) = effort {
        // summary:"auto" mirrors codex's default so reasoning summaries
        // reach the Thinking channel.
        body["reasoning"] = json!({ "effort": effort, "summary": "auto" });
    }
    if let Some(service_tier) = service_tier {
        body["service_tier"] = json!(service_tier);
    }
    if allow_tools {
        if let Some(tools) = tool_definitions {
            body["tools"] = tools;
            body["tool_choice"] = json!("auto");
            body["parallel_tool_calls"] = json!(true);
        }
    }
    body
}

/// The shared tool catalog is chat-completions shaped (`name` nested under
/// `function`); the Responses API wants flat function tools, and rejects the
/// body when `name` is missing. `strict:false` — the catalog schemas predate
/// strict-mode constraints (optional params, loose `required`).
pub(crate) fn responses_tool_definitions(chat_completions_tools: &Value) -> Value {
    let Some(items) = chat_completions_tools.as_array() else {
        return chat_completions_tools.clone();
    };
    Value::Array(
        items
            .iter()
            .map(|tool| {
                let function = tool.get("function").unwrap_or(tool);
                let mut flat = serde_json::Map::new();
                flat.insert("type".into(), json!("function"));
                if let Some(name) = function.get("name") {
                    flat.insert("name".into(), name.clone());
                }
                if let Some(description) = function.get("description") {
                    flat.insert("description".into(), description.clone());
                }
                flat.insert(
                    "parameters".into(),
                    function
                        .get("parameters")
                        .cloned()
                        .unwrap_or_else(|| json!({ "type": "object", "properties": {} })),
                );
                flat.insert("strict".into(), json!(false));
                Value::Object(flat)
            })
            .collect(),
    )
}

/// Shared pooled client (HTTP/1.1, no whole-request timeout — SSE idles).
fn shared_responses_client() -> Result<reqwest::Client, String> {
    static CLIENT: std::sync::OnceLock<reqwest::Client> = std::sync::OnceLock::new();
    if let Some(c) = CLIENT.get() {
        return Ok(c.clone());
    }
    let built = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(20))
        .pool_idle_timeout(Duration::from_secs(90))
        .pool_max_idle_per_host(4)
        .tcp_nodelay(true)
        .tcp_keepalive(Duration::from_secs(30))
        .http1_only()
        .user_agent(concat!("GrokDesktop/", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|e| format!("http client: {e}"))?;
    Ok(CLIENT.get_or_init(|| built).clone())
}

async fn post_responses(
    client: &reqwest::Client,
    token: &str,
    account_id: Option<&str>,
    body: &Value,
    should_stop: &(dyn Fn() -> bool + Send + Sync),
) -> Result<Option<reqwest::Response>, String> {
    const MAX_ATTEMPTS: u32 = 3;
    let mut last_err = String::new();

    for attempt in 1..=MAX_ATTEMPTS {
        let mut request = client
            .post(RESPONSES_URL)
            .bearer_auth(token)
            .header("Accept", "text/event-stream")
            .header("Cache-Control", "no-cache")
            .json(body);
        if let Some(account_id) = account_id {
            // Same header literal codex-rs sends (case-insensitive on the
            // wire, kept identical for server-side compatibility checks).
            request = request.header("ChatGPT-Account-ID", account_id);
        }
        let Some(result) = future_or_stop(request.send(), should_stop).await else {
            return Ok(None);
        };
        match result {
            Ok(response) => {
                if matches!(
                    response.status().as_u16(),
                    408 | 409 | 425 | 429 | 500 | 502 | 503 | 504 | 524
                ) && attempt < MAX_ATTEMPTS
                {
                    let status = response.status().as_u16();
                    last_err = safe_responses_http_error(status);
                    if !wait_for_retry(should_stop, Duration::from_millis(400 * u64::from(attempt)))
                        .await
                    {
                        return Ok(None);
                    }
                    continue;
                }
                return Ok(Some(response));
            }
            Err(err) => {
                last_err = format!("OpenAI request: {err}");
                if attempt < MAX_ATTEMPTS {
                    if !wait_for_retry(should_stop, Duration::from_millis(400 * u64::from(attempt)))
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

fn safe_responses_http_error(status: u16) -> String {
    // Wording must stay clear of the frontend connectivity keywords
    // ("request failed", "timed out", ...): a rejected body is a client
    // error, not a dropped connection.
    match status {
        401 | 403 => "Sign in to OpenAI again to continue.".into(),
        402 => "OpenAI usage limit reached.".into(),
        408 | 504 => "The OpenAI request timed out.".into(),
        409 | 425 | 429 => "OpenAI is receiving too many requests.".into(),
        500..=599 => "The OpenAI service is temporarily unavailable.".into(),
        _ => format!("The OpenAI service could not accept this request (status {status})."),
    }
}

/// One POST + drain attempt (no reconnect policy).
pub(crate) async fn stream_responses_once(
    token: &str,
    account_id: Option<&str>,
    body: &Value,
    should_stop: &(dyn Fn() -> bool + Send + Sync),
) -> Result<ResponsesTurnOut, String> {
    let client = shared_responses_client()?;
    let Some(response) = post_responses(&client, token, account_id, body, should_stop).await?
    else {
        return Ok(ResponsesTurnOut::default());
    };

    if should_stop() {
        return Ok(ResponsesTurnOut::default());
    }

    if !response.status().is_success() {
        let status = response.status().as_u16();
        let detail = provider_error_detail(response, should_stop).await;
        return Err(with_provider_detail(
            safe_responses_http_error(status),
            detail,
        ));
    }

    drain_responses_sse(response, should_stop).await
}

/// POST + drain with retry when the body dies mid-stream (same posture as
/// the Grok path).
pub(crate) async fn stream_responses_round(
    token: &str,
    account_id: Option<&str>,
    body: &Value,
    should_stop: &(dyn Fn() -> bool + Send + Sync),
) -> Result<ResponsesTurnOut, String> {
    let mut last_err = String::new();

    for attempt in 0..=STREAM_MAX_RETRIES {
        if should_stop() {
            return Ok(ResponsesTurnOut::default());
        }

        match stream_responses_once(token, account_id, body, should_stop).await {
            Ok(out) => return Ok(out),
            Err(err) => {
                last_err = err;
                if attempt < STREAM_MAX_RETRIES && is_transient_stream_error_msg(&last_err) {
                    if !wait_for_retry(should_stop, stream_retry_delay(attempt)).await {
                        return Ok(ResponsesTurnOut::default());
                    }
                    continue;
                }
                if is_transient_stream_error_msg(&last_err) {
                    return Err(format!(
                        "OpenAI stream failed after {STREAM_MAX_RETRIES} automatic reconnect attempts: {last_err}"
                    ));
                }
                return Err(last_err);
            }
        }
    }

    Err(last_err)
}

async fn wait_for_retry(should_stop: &(dyn Fn() -> bool + Send + Sync), delay: Duration) -> bool {
    let deadline = Instant::now() + delay;
    loop {
        if should_stop() {
            return false;
        }
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return true;
        }
        tokio::time::sleep(remaining.min(Duration::from_millis(100))).await;
    }
}

/// Drain one Responses SSE stream. Normal success requires an explicit
/// `response.completed` or `response.incomplete` event; cancellation returns
/// the partial turn only so the caller can discard it without a provider error.
async fn drain_responses_sse(
    response: reqwest::Response,
    should_stop: &(dyn Fn() -> bool + Send + Sync),
) -> Result<ResponsesTurnOut, String> {
    let mut line_buffer = ProviderLineBuffer::default();
    let mut stream = response.bytes_stream();
    let mut out = ResponsesTurnOut::default();
    let mut event_name = String::new();
    let mut last_progress = Instant::now();
    // In-flight function calls keyed by item id (args arrive as deltas).
    let mut pending_calls: HashMap<String, ResponsesToolCall> = HashMap::new();

    'byte_stream: loop {
        if should_stop() {
            return Ok(out);
        }
        let elapsed = last_progress.elapsed();
        if elapsed >= STREAM_IDLE_TIMEOUT {
            if should_stop() {
                return Ok(out);
            }
            return Err(format!(
                "Stream stalled: no OpenAI events for {} seconds.",
                STREAM_IDLE_TIMEOUT.as_secs()
            ));
        }
        let wait = STREAM_IDLE_TIMEOUT.saturating_sub(elapsed);
        let item = match next_stream_item_or_stop(&mut stream, should_stop, wait).await {
            StreamWait::Item(Some(item)) => item,
            StreamWait::Item(None) => break,
            StreamWait::Cancelled => return Ok(out),
            StreamWait::TimedOut => {
                if should_stop() {
                    return Ok(out);
                }
                return Err(format!(
                    "Stream stalled: no OpenAI events for {} seconds.",
                    STREAM_IDLE_TIMEOUT.as_secs()
                ));
            }
        };
        let bytes = match item {
            Ok(b) => b,
            Err(e) => {
                if should_stop() {
                    return Ok(out);
                }
                return Err(format!("OpenAI stream read: {e}"));
            }
        };
        // Connection alive — reset idle before parsing anything.
        last_progress = Instant::now();
        if bytes.is_empty() {
            continue;
        }
        let lines = match line_buffer.push(&bytes) {
            Ok(lines) => lines,
            Err(_) if should_stop() => return Ok(out),
            Err(error) => return Err(error),
        };
        for line in lines {
            let terminal = match apply_responses_sse_line(
                &mut out,
                &mut pending_calls,
                &mut event_name,
                &line,
            ) {
                Ok(terminal) => terminal,
                Err(_) if should_stop() => return Ok(out),
                Err(error) => return Err(error),
            };
            if terminal {
                break 'byte_stream;
            }
        }
    }

    let lines = match line_buffer.finish() {
        Ok(lines) => lines,
        Err(_) if should_stop() => return Ok(out),
        Err(error) => return Err(error),
    };
    for line in lines {
        let terminal =
            match apply_responses_sse_line(&mut out, &mut pending_calls, &mut event_name, &line) {
                Ok(terminal) => terminal,
                Err(_) if should_stop() => return Ok(out),
                Err(error) => return Err(error),
            };
        if terminal {
            break;
        }
    }

    if out.finished {
        finalize_pending(&mut out, pending_calls);
        Ok(out)
    } else if should_stop() {
        Ok(out)
    } else {
        Err("OpenAI stream ended without a terminal response event.".into())
    }
}

fn apply_responses_sse_line(
    out: &mut ResponsesTurnOut,
    pending_calls: &mut HashMap<String, ResponsesToolCall>,
    event_name: &mut String,
    line: &str,
) -> Result<bool, String> {
    if line.is_empty() {
        // Event boundary — an `event:` with no `data:` is a ping.
        event_name.clear();
        return Ok(false);
    }
    if let Some(name) = line.strip_prefix("event:") {
        *event_name = name.trim().to_string();
        return Ok(false);
    }
    let Some(data) = line.strip_prefix("data:").map(str::trim) else {
        return Ok(false);
    };
    if data.is_empty() || data == "[DONE]" {
        return Ok(false);
    }
    let Ok(payload) = serde_json::from_str::<Value>(data) else {
        return Ok(false);
    };
    // Some providers send data-only lines; the event name then rides inside
    // the payload as `type`.
    let effective_name = if event_name.is_empty() {
        payload
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or_default()
    } else {
        event_name.as_str()
    };
    apply_event(out, pending_calls, effective_name, &payload)
}

/// Handle one SSE event. Ok(true) = terminal success, Err = terminal failure.
fn apply_event(
    out: &mut ResponsesTurnOut,
    pending_calls: &mut HashMap<String, ResponsesToolCall>,
    event_name: &str,
    payload: &Value,
) -> Result<bool, String> {
    match event_name {
        "response.output_item.added" => {
            if let Some(item) = payload.get("item") {
                if item.get("type").and_then(Value::as_str) == Some("function_call") {
                    let id = item_string(item, "id");
                    let call = ResponsesToolCall {
                        id: id.clone(),
                        call_id: item_string(item, "call_id"),
                        name: item_string(item, "name"),
                        arguments: item_string(item, "arguments"),
                    };
                    if !id.is_empty() {
                        pending_calls.insert(id, call);
                    }
                }
            }
        }
        "response.output_text.delta" | "response.refusal.delta" => {
            if let Some(delta) = payload.get("delta").and_then(Value::as_str) {
                out.content.push_str(delta);
            }
        }
        "response.reasoning_summary_text.delta" => {
            if let Some(delta) = payload.get("delta").and_then(Value::as_str) {
                out.reasoning_summary.push_str(delta);
            }
        }
        "response.function_call_arguments.delta" => {
            if let Some(delta) = payload.get("delta").and_then(Value::as_str) {
                let item_id = payload.get("item_id").and_then(Value::as_str).unwrap_or("");
                if let Some(call) = pending_calls.get_mut(item_id) {
                    call.arguments.push_str(delta);
                }
            }
        }
        "response.output_item.done" => {
            if let Some(item) = payload.get("item") {
                match item.get("type").and_then(Value::as_str) {
                    Some("function_call") => {
                        let id = item_string(item, "id");
                        let call = pending_calls
                            .remove(&id)
                            .map(|mut c| {
                                // The done item carries the authoritative arguments.
                                let args = item_string(item, "arguments");
                                if !args.is_empty() {
                                    c.arguments = args;
                                }
                                if c.call_id.is_empty() {
                                    c.call_id = item_string(item, "call_id");
                                }
                                if c.name.is_empty() {
                                    c.name = item_string(item, "name");
                                }
                                c
                            })
                            .unwrap_or_else(|| ResponsesToolCall {
                                id,
                                call_id: item_string(item, "call_id"),
                                name: item_string(item, "name"),
                                arguments: item_string(item, "arguments"),
                            });
                        out.tools.push(call);
                        out.output_items.push(item.clone());
                    }
                    Some("message") | Some("reasoning") => {
                        out.output_items.push(item.clone());
                    }
                    _ => {}
                }
            }
        }
        "response.completed" => {
            out.response_id = payload
                .pointer("/response/id")
                .and_then(Value::as_str)
                .map(str::to_string);
            if let Some(status) = payload.pointer("/response/status").and_then(Value::as_str) {
                if status == "failed" {
                    let detail = payload
                        .pointer("/response/error/message")
                        .and_then(Value::as_str)
                        .unwrap_or("OpenAI response failed");
                    return Err(detail.to_string());
                }
            }
            if let Some(total_tokens) = payload
                .pointer("/response/usage/total_tokens")
                .and_then(Value::as_u64)
            {
                out.usage = Some(ResponsesUsage {
                    input_tokens: payload
                        .pointer("/response/usage/input_tokens")
                        .and_then(Value::as_u64)
                        .unwrap_or(0),
                    output_tokens: payload
                        .pointer("/response/usage/output_tokens")
                        .and_then(Value::as_u64)
                        .unwrap_or(0),
                    total_tokens,
                });
            }
            out.finished = true;
            return Ok(true);
        }
        "response.failed" => {
            let detail = payload
                .pointer("/response/error/message")
                .and_then(Value::as_str)
                .unwrap_or("OpenAI response failed");
            return Err(detail.to_string());
        }
        "response.incomplete" => {
            // Treat as terminal; whatever arrived is the turn's payload.
            out.finished = true;
            return Ok(true);
        }
        "error" => {
            let detail = payload
                .pointer("/error/message")
                .or_else(|| payload.get("message"))
                .and_then(Value::as_str)
                .unwrap_or("OpenAI stream error");
            return Err(detail.to_string());
        }
        _ => {}
    }
    Ok(false)
}

fn finalize_pending(out: &mut ResponsesTurnOut, pending_calls: HashMap<String, ResponsesToolCall>) {
    if pending_calls.is_empty() {
        return;
    }
    let mut calls: Vec<ResponsesToolCall> = pending_calls.into_values().collect();
    calls.sort_by(|a, b| a.id.cmp(&b.id));
    for call in calls {
        out.output_items.push(json!({
            "type": "function_call",
            "id": call.id,
            "call_id": call.call_id,
            "name": call.name,
            "arguments": call.arguments,
        }));
        out.tools.push(call);
    }
}

fn item_string(item: &Value, key: &str) -> String {
    item.get(key)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::provider_output::MAX_PROVIDER_EVENT_BYTES;

    fn sse(events: &[(&str, &str)]) -> String {
        let mut out = String::new();
        for (name, data) in events {
            out.push_str(&format!("event: {name}\ndata: {data}\n\n"));
        }
        out
    }

    #[test]
    fn effort_mapping_normalizes_ultra() {
        assert_eq!(openai_reasoning_effort(None), Ok(None));
        assert_eq!(openai_reasoning_effort(Some("off")), Ok(None));
        assert_eq!(openai_reasoning_effort(Some("low")), Ok(Some("low")));
        assert_eq!(openai_reasoning_effort(Some("xhigh")), Ok(Some("xhigh")));
        assert_eq!(openai_reasoning_effort(Some("ultra")), Ok(Some("max")));
        assert!(openai_reasoning_effort(Some("bogus")).is_err());
    }

    #[test]
    fn fast_mode_maps_only_supported_models_to_priority() {
        assert_eq!(openai_service_tier("gpt-5.6-sol", None), Ok(None));
        assert_eq!(
            openai_service_tier("gpt-5.6-sol", Some("fast")),
            Ok(Some("priority"))
        );
        assert_eq!(
            openai_service_tier("gpt-5.6-terra", Some("priority")),
            Ok(Some("priority"))
        );
        assert!(openai_service_tier("gpt-daybreak-blue-latest", Some("priority")).is_err());
        assert!(openai_service_tier("grok-4.5", Some("priority")).is_err());
        assert!(openai_service_tier("gpt-5.6-sol", Some("flex")).is_err());
    }

    #[test]
    fn chatgpt_codex_rejects_models_outside_its_catalog() {
        assert_eq!(validate_chatgpt_codex_model("gpt-5.6-sol"), Ok(()));
        assert!(validate_chatgpt_codex_model("gpt-daybreak-blue-latest")
            .unwrap_err()
            .contains("not available through OpenAI ChatGPT/Codex sign-in"));
    }

    #[test]
    fn request_body_shape() {
        let mut history = OpenAiHistory::new();
        history.push_user_text("hello");
        let body = build_request_body(
            "gpt-5.6-sol",
            Some("system prompt"),
            &history,
            Some("medium"),
            Some("priority"),
            true,
            Some(json!([{"type":"function","name":"read"}])),
        );
        assert_eq!(body["model"], "gpt-5.6-sol");
        assert_eq!(body["stream"], true);
        assert_eq!(body["store"], false);
        assert_eq!(body["instructions"], "system prompt");
        assert_eq!(body["reasoning"]["effort"], "medium");
        assert_eq!(body["reasoning"]["summary"], "auto");
        assert_eq!(body["service_tier"], "priority");
        assert_eq!(body["tool_choice"], "auto");
        assert_eq!(body["include"][0], "reasoning.encrypted_content");
        assert_eq!(body["input"][0]["type"], "message");
        assert_eq!(body["input"][0]["role"], "user");
        assert_eq!(body["input"][0]["content"][0]["type"], "input_text");
    }

    #[test]
    fn standard_request_omits_service_tier() {
        let mut history = OpenAiHistory::new();
        history.push_user_text("hello");
        let body = build_request_body("gpt-5.6-sol", None, &history, None, None, false, None);
        assert!(body.get("service_tier").is_none());
    }

    #[test]
    fn history_tracks_tool_outputs_and_images() {
        let mut history = OpenAiHistory::new();
        history.push_tool_output("call_1", "ok", None);
        history.push_tool_output("call_2", "ok", Some("data:image/png;base64,AAA"));
        assert_eq!(history.input()[0]["type"], "function_call_output");
        assert_eq!(history.input()[0]["call_id"], "call_1");
        assert_eq!(history.input()[1]["type"], "function_call_output");
        assert_eq!(history.input()[2]["type"], "message");
        assert_eq!(history.input()[2]["content"][1]["type"], "input_image");
    }

    #[test]
    fn client_messages_become_input_items() {
        let mut history = OpenAiHistory::new();
        history.push_client_messages(vec![
            ChatMessageIn {
                role: "user".into(),
                content: Some(ChatContent::Text("hi".into())),
                tool_calls: None,
                tool_call_id: None,
                name: None,
            },
            ChatMessageIn {
                role: "user".into(),
                content: Some(ChatContent::Parts(vec![ContentPart::ImageUrl {
                    image_url: crate::chat::ImageUrlPart {
                        url: "data:image/png;base64,AAA".into(),
                    },
                }])),
                tool_calls: None,
                tool_call_id: None,
                name: None,
            },
        ]);
        assert_eq!(history.input()[0]["role"], "user");
        assert_eq!(history.input()[1]["role"], "user");
        assert_eq!(history.input()[1]["content"][0]["type"], "input_image");
    }

    #[test]
    fn client_message_text_parts_match_responses_roles() {
        let mut history = OpenAiHistory::new();
        history.push_client_messages(vec![
            ChatMessageIn {
                role: "user".into(),
                content: Some(ChatContent::Text("question".into())),
                tool_calls: None,
                tool_call_id: None,
                name: None,
            },
            ChatMessageIn {
                role: "assistant".into(),
                content: Some(ChatContent::Text("answer".into())),
                tool_calls: None,
                tool_call_id: None,
                name: None,
            },
        ]);

        assert_eq!(history.input()[0]["content"][0]["type"], "input_text");
        assert_eq!(history.input()[1]["content"][0]["type"], "output_text");
    }

    #[test]
    fn assistant_images_are_not_sent_as_responses_output_content() {
        let mut history = OpenAiHistory::new();
        history.push_client_messages(vec![ChatMessageIn {
            role: "assistant".into(),
            content: Some(ChatContent::Parts(vec![
                ContentPart::Text {
                    text: "answer".into(),
                },
                ContentPart::ImageUrl {
                    image_url: crate::chat::ImageUrlPart {
                        url: "data:image/png;base64,AAA".into(),
                    },
                },
            ])),
            tool_calls: None,
            tool_call_id: None,
            name: None,
        }]);

        let content = history.input()[0]["content"].as_array().unwrap();
        assert_eq!(content.len(), 1);
        assert_eq!(content[0]["type"], "output_text");
    }

    #[test]
    fn empty_client_messages_are_not_sent_to_responses() {
        let mut history = OpenAiHistory::new();
        history.push_client_messages(vec![
            ChatMessageIn {
                role: "assistant".into(),
                content: Some(ChatContent::Text("   ".into())),
                tool_calls: None,
                tool_call_id: None,
                name: None,
            },
            ChatMessageIn {
                role: "user".into(),
                content: Some(ChatContent::Parts(vec![ContentPart::Text {
                    text: "\n".into(),
                }])),
                tool_calls: None,
                tool_call_id: None,
                name: None,
            },
        ]);

        assert!(history.input().is_empty());
    }

    #[tokio::test]
    async fn terminal_stream_failure_is_not_hidden_by_partial_text() {
        use std::io::{Read, Write};

        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let body = concat!(
            "event: response.output_text.delta\n",
            "data: {\"delta\":\"partial\"}\n\n",
            "event: response.failed\n",
            "data: {\"response\":{\"error\":{\"message\":\"quota exhausted\"}}}\n\n"
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
        let error = match drain_responses_sse(response, &|| false).await {
            Ok(_) => panic!("terminal provider failure must remain an error"),
            Err(error) => error,
        };
        server.join().unwrap();

        assert_eq!(error, "quota exhausted");
    }

    #[tokio::test]
    async fn responses_stream_rejects_clean_eof_without_terminal_event() {
        use std::io::{Read, Write};

        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let body = concat!(
            "event: response.output_item.added\n",
            "data: {\"item\":{\"type\":\"function_call\",\"id\":\"fc_1\",\"call_id\":\"call_1\",\"name\":\"read\",\"arguments\":\"\"}}\n\n",
            "event: response.function_call_arguments.delta\n",
            "data: {\"item_id\":\"fc_1\",\"delta\":\"{\\\"path\\\":\"}\n\n"
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
        let error = match drain_responses_sse(response, &|| false).await {
            Ok(_) => panic!("partial function calls require a terminal event"),
            Err(error) => error,
        };
        server.join().unwrap();

        assert!(error.contains("without a terminal"), "{error}");
    }

    #[test]
    fn response_incomplete_remains_an_explicit_terminal_event() {
        let mut out = ResponsesTurnOut::default();
        let mut pending = HashMap::new();
        let payload = json!({ "response": { "status": "incomplete" } });

        let terminal = apply_event(&mut out, &mut pending, "response.incomplete", &payload)
            .expect("explicit incomplete event");

        assert!(terminal);
        assert!(out.finished);
    }

    #[tokio::test]
    async fn responses_stream_cancellation_does_not_require_terminal_event() {
        use std::io::{Read, Write};

        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let body = "event: response.output_text.delta\ndata: {\"delta\":\"partial\"}\n\n";
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
        let out = drain_responses_sse(response, &|| true)
            .await
            .expect("cancellation is not a provider failure");
        server.join().unwrap();

        assert!(!out.finished);
        assert!(out.content.is_empty());
        assert!(out.tools.is_empty());
    }

    #[tokio::test]
    async fn responses_stream_rejects_an_oversized_provider_event() {
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
        let error = match drain_responses_sse(response, &|| false).await {
            Ok(_) => panic!("oversized provider event must fail closed"),
            Err(error) => error,
        };
        server.join().unwrap();

        assert!(error.contains("Provider event exceeded"), "{error}");
    }

    #[tokio::test]
    async fn responses_stream_accepts_many_small_events_within_the_byte_budget() {
        use std::io::{Read, Write};

        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let mut body = String::new();
        // Three lines per event reproduces the former 4,096-line cutoff while
        // the complete stream remains far below the byte budget.
        for _ in 0..1_400 {
            body.push_str("event: response.output_text.delta\ndata: {\"delta\":\"x\"}\n\n");
        }
        body.push_str(
            "event: response.completed\ndata: {\"response\":{\"status\":\"completed\"}}\n\n",
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
        let out = drain_responses_sse(response, &|| false).await.unwrap();
        server.join().unwrap();

        assert!(out.finished);
        assert_eq!(out.content.len(), 1_400);
    }

    #[test]
    fn parses_full_tool_call_lifecycle() {
        let mut out = ResponsesTurnOut::default();
        let mut pending = HashMap::new();

        let events = sse(&[
            (
                "response.output_item.added",
                r#"{"item":{"type":"function_call","id":"fc_1","call_id":"call_1","name":"read","arguments":""}}"#,
            ),
            (
                "response.function_call_arguments.delta",
                r#"{"item_id":"fc_1","delta":"{\"path\":"}"#,
            ),
            (
                "response.function_call_arguments.delta",
                r#"{"item_id":"fc_1","delta":"\"a.rs\"}"}"#,
            ),
            (
                "response.output_item.done",
                r#"{"item":{"type":"function_call","id":"fc_1","call_id":"call_1","name":"read","arguments":"{\"path\":\"a.rs\"}"}}"#,
            ),
        ]);

        for chunk in events.split("\n\n") {
            if chunk.is_empty() {
                continue;
            }
            let mut name = "";
            let mut data = "";
            for line in chunk.lines() {
                if let Some(n) = line.strip_prefix("event: ") {
                    name = n;
                }
                if let Some(d) = line.strip_prefix("data: ") {
                    data = d;
                }
            }
            let payload: Value = serde_json::from_str(data).unwrap();
            apply_event(&mut out, &mut pending, name, &payload).unwrap();
        }

        assert_eq!(out.tools.len(), 1);
        assert_eq!(out.tools[0].call_id, "call_1");
        assert_eq!(out.tools[0].arguments, r#"{"path":"a.rs"}"#);
        assert_eq!(out.output_items.len(), 1);
    }

    #[test]
    fn parses_text_and_completion() {
        let mut out = ResponsesTurnOut::default();
        let mut pending = HashMap::new();
        let events = [
            ("response.output_text.delta", r#"{"delta":"Hello"}"#),
            ("response.output_text.delta", r#"{"delta":" world"}"#),
            (
                "response.output_item.done",
                r#"{"item":{"type":"reasoning","id":"rs_1","summary":[]}}"#,
            ),
            (
                "response.completed",
                r#"{"response":{"id":"resp_1","status":"completed","usage":{"input_tokens":120,"output_tokens":34,"total_tokens":154}}}"#,
            ),
        ];
        let mut terminal = false;
        for (name, data) in events {
            let payload: Value = serde_json::from_str(data).unwrap();
            terminal = apply_event(&mut out, &mut pending, name, &payload).unwrap();
        }
        assert!(terminal);
        assert!(out.finished);
        assert_eq!(out.content, "Hello world");
        assert_eq!(out.response_id.as_deref(), Some("resp_1"));
        let usage = out.usage.expect("official response usage");
        assert_eq!(usage.input_tokens, 120);
        assert_eq!(usage.output_tokens, 34);
        assert_eq!(usage.total_tokens, 154);
        assert_eq!(out.output_items.len(), 1);
    }

    #[test]
    fn parses_refusal_delta_as_visible_content() {
        let mut out = ResponsesTurnOut::default();
        let mut pending = HashMap::new();
        let payload: Value =
            serde_json::from_str(r#"{"delta":"I cannot help with that."}"#).unwrap();

        apply_event(&mut out, &mut pending, "response.refusal.delta", &payload).unwrap();

        assert_eq!(out.content, "I cannot help with that.");
    }

    #[test]
    fn responses_tools_are_flat_and_complete() {
        let converted = responses_tool_definitions(&crate::tools::tool_definitions());
        let items = converted.as_array().expect("tool array");
        let names: Vec<&str> = items
            .iter()
            .map(|t| t.get("name").and_then(Value::as_str).unwrap_or_default())
            .collect();

        // The full shared catalog must reach the Responses API — no tool
        // may drop out when the app talks to OpenAI models.
        let mut expected_tools = vec![
            "read",
            "write",
            "edit",
            "patch",
            "delete",
            "glob",
            "grep",
            "bash",
            "webfetch",
            "websearch",
            "question",
            "todowrite",
            "task",
        ];
        expected_tools.extend_from_slice(crate::agent_tools::TOOL_NAMES);
        assert_eq!(items.len(), expected_tools.len());
        for expected in expected_tools {
            assert!(names.contains(&expected), "missing tool: {expected}");
        }

        for tool in items {
            assert_eq!(tool["type"], "function");
            assert!(
                tool.get("function").is_none(),
                "no chat-completions nesting"
            );
            assert!(tool["name"].as_str().is_some_and(|s| !s.is_empty()));
            assert!(tool["description"].as_str().is_some_and(|s| !s.is_empty()));
            assert_eq!(tool["parameters"]["type"], "object");
            assert_eq!(tool["strict"], false);
        }
    }

    #[test]
    fn rejected_body_wording_stays_out_of_connectivity_bucket() {
        // The frontend classifier maps "request failed"/"timed out"/
        // "connection" to the connectivity category; a rejected body (4xx)
        // must not read as a dropped connection.
        for status in [400u16, 404, 405, 413, 422] {
            let msg = safe_responses_http_error(status).to_ascii_lowercase();
            assert!(!msg.contains("request failed"), "{status}: {msg}");
            assert!(!msg.contains("timed out"), "{status}: {msg}");
            assert!(!msg.contains("connection"), "{status}: {msg}");
        }
        assert!(safe_responses_http_error(429).contains("too many requests"));
        assert!(safe_responses_http_error(503).contains("temporarily unavailable"));
    }
}
