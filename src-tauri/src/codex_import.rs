use chrono::DateTime;
use serde::Serialize;
use serde_json::Value;
use std::fs;
use std::path::{Path, PathBuf};
use walkdir::WalkDir;

const MAX_TRANSCRIPT_BYTES: u64 = 64 * 1024 * 1024;
const MAX_TRANSCRIPT_FILES: usize = 10_000;
const MAX_WALK_ENTRIES: usize = 100_000;
const MAX_TOTAL_BYTES: u64 = 2 * 1024 * 1024 * 1024;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexImportResult {
    threads: Vec<CodexImportThread>,
    scanned_files: usize,
    skipped_files: usize,
    resolved_path: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct CodexImportThread {
    source_id: String,
    title: String,
    cwd: Option<String>,
    model_id: Option<String>,
    messages: Vec<CodexImportMessage>,
    created_at: i64,
    updated_at: i64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct CodexImportMessage {
    role: &'static str,
    content: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    thinking: Option<String>,
    created_at: i64,
}

fn timestamp_ms(value: Option<&Value>) -> Option<i64> {
    DateTime::parse_from_rfc3339(value?.as_str()?)
        .ok()
        .map(|timestamp| timestamp.timestamp_millis())
}

fn append_text(target: &mut String, text: &str) {
    let text = text.trim();
    if text.is_empty() {
        return;
    }
    if !target.is_empty() {
        target.push_str("\n\n");
    }
    target.push_str(text);
}

fn append_message(
    messages: &mut Vec<CodexImportMessage>,
    role: &'static str,
    text: &str,
    created_at: i64,
) {
    let text = text.trim();
    if text.is_empty() {
        return;
    }
    if let Some(last) = messages.last_mut().filter(|message| message.role == role) {
        append_text(&mut last.content, text);
        last.created_at = last.created_at.max(created_at);
        return;
    }
    messages.push(CodexImportMessage {
        role,
        content: text.to_string(),
        thinking: None,
        created_at,
    });
}

fn append_thinking(messages: &mut [CodexImportMessage], pending: &mut String, text: &str) {
    let text = text.trim();
    if text.is_empty() {
        return;
    }
    if let Some(last) = messages
        .last_mut()
        .filter(|message| message.role == "assistant")
    {
        let thinking = last.thinking.get_or_insert_with(String::new);
        append_text(thinking, text);
    } else {
        append_text(pending, text);
    }
}

fn response_text(payload: &Value) -> String {
    let mut text = String::new();
    if let Some(content) = payload.get("content").and_then(Value::as_array) {
        for part in content {
            if matches!(
                part.get("type").and_then(Value::as_str),
                Some("input_text" | "output_text" | "text")
            ) {
                if let Some(value) = part.get("text").and_then(Value::as_str) {
                    append_text(&mut text, value);
                }
            }
        }
    }
    text
}

fn response_reasoning(payload: &Value) -> String {
    let mut text = String::new();
    if let Some(summary) = payload.get("summary").and_then(Value::as_array) {
        for part in summary {
            if let Some(value) = part.get("text").and_then(Value::as_str) {
                append_text(&mut text, value);
            }
        }
    }
    text
}

fn title_from_messages(messages: &[CodexImportMessage]) -> String {
    let title = messages
        .iter()
        .find(|message| message.role == "user")
        .map(|message| {
            message
                .content
                .split_whitespace()
                .collect::<Vec<_>>()
                .join(" ")
        })
        .unwrap_or_else(|| "Imported Codex chat".into());
    title.chars().take(120).collect()
}

fn parse_transcript(path: &Path) -> Result<Option<CodexImportThread>, ()> {
    let metadata = path.metadata().map_err(|_| ())?;
    if metadata.len() == 0 || metadata.len() > MAX_TRANSCRIPT_BYTES {
        return Err(());
    }
    let raw = fs::read_to_string(path).map_err(|_| ())?;
    let mut source_id = None;
    let mut cwd = None;
    let mut model_id = None;
    let mut session_created_at = None;
    let mut event_messages = Vec::new();
    let mut response_messages = Vec::new();
    let mut event_pending_thinking = String::new();
    let mut response_pending_thinking = String::new();

    for line in raw.lines().filter(|line| !line.trim().is_empty()) {
        let Ok(record) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        let created_at = timestamp_ms(record.get("timestamp")).unwrap_or_default();
        let Some(payload) = record.get("payload") else {
            continue;
        };
        match record.get("type").and_then(Value::as_str) {
            Some("session_meta") => {
                if source_id.is_none() {
                    source_id = payload
                        .get("id")
                        .or_else(|| payload.get("session_id"))
                        .and_then(Value::as_str)
                        .map(str::to_string);
                }
                if cwd.is_none() {
                    cwd = payload
                        .get("cwd")
                        .and_then(Value::as_str)
                        .map(str::to_string);
                }
                session_created_at = timestamp_ms(payload.get("timestamp"))
                    .or(session_created_at)
                    .or(Some(created_at));
            }
            Some("turn_context") => {
                if let Some(model) = payload.get("model").and_then(Value::as_str) {
                    model_id = Some(model.to_string());
                }
            }
            Some("event_msg") => match payload.get("type").and_then(Value::as_str) {
                Some("user_message") => {
                    if let Some(message) = payload.get("message").and_then(Value::as_str) {
                        append_message(&mut event_messages, "user", message, created_at);
                    }
                }
                Some("agent_message") => {
                    if let Some(message) = payload.get("message").and_then(Value::as_str) {
                        append_message(&mut event_messages, "assistant", message, created_at);
                        if !event_pending_thinking.is_empty() {
                            if let Some(last) = event_messages.last_mut() {
                                last.thinking = Some(std::mem::take(&mut event_pending_thinking));
                            }
                        }
                    }
                }
                Some("agent_reasoning") => {
                    if let Some(text) = payload.get("text").and_then(Value::as_str) {
                        append_thinking(&mut event_messages, &mut event_pending_thinking, text);
                    }
                }
                _ => {}
            },
            Some("response_item") => match payload.get("type").and_then(Value::as_str) {
                Some("message") => {
                    let role = match payload.get("role").and_then(Value::as_str) {
                        Some("user") => "user",
                        Some("assistant") => "assistant",
                        _ => continue,
                    };
                    append_message(
                        &mut response_messages,
                        role,
                        &response_text(payload),
                        created_at,
                    );
                    if role == "assistant" && !response_pending_thinking.is_empty() {
                        if let Some(last) = response_messages.last_mut() {
                            last.thinking = Some(std::mem::take(&mut response_pending_thinking));
                        }
                    }
                }
                Some("reasoning") => append_thinking(
                    &mut response_messages,
                    &mut response_pending_thinking,
                    &response_reasoning(payload),
                ),
                _ => {}
            },
            _ => {}
        }
    }

    let Some(source_id) = source_id.filter(|id| {
        !id.is_empty()
            && id.len() <= 128
            && id
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
    }) else {
        return Ok(None);
    };
    let event_has_assistant = event_messages
        .iter()
        .any(|message| message.role == "assistant");
    let response_has_assistant = response_messages
        .iter()
        .any(|message| message.role == "assistant");
    let messages = if event_messages.is_empty() || (!event_has_assistant && response_has_assistant)
    {
        response_messages
    } else {
        event_messages
    };
    if !messages.iter().any(|message| message.role == "user") {
        return Ok(None);
    }
    let created_at = session_created_at
        .filter(|timestamp| *timestamp > 0)
        .or_else(|| messages.first().map(|message| message.created_at))
        .unwrap_or_default();
    let updated_at = messages
        .last()
        .map(|message| message.created_at)
        .unwrap_or(created_at)
        .max(created_at);

    Ok(Some(CodexImportThread {
        source_id,
        title: title_from_messages(&messages),
        cwd,
        model_id,
        messages,
        created_at,
        updated_at,
    }))
}

fn codex_sessions_path() -> Option<PathBuf> {
    let root = if let Some(root) = std::env::var_os("CODEX_HOME") {
        PathBuf::from(root)
    } else {
        let home = std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" })?;
        PathBuf::from(home).join(".codex")
    };
    Some(root.join("sessions"))
}

#[tauri::command]
pub async fn codex_import_chats() -> Result<CodexImportResult, String> {
    tauri::async_runtime::spawn_blocking(import_chats)
        .await
        .map_err(|error| format!("Could not import Codex chats: {error}"))?
}

fn import_chats() -> Result<CodexImportResult, String> {
    let root = codex_sessions_path()
        .ok_or_else(|| "Could not resolve the Codex sessions directory.".to_string())?;
    import_chats_from(root)
}

fn import_chats_from(root: PathBuf) -> Result<CodexImportResult, String> {
    if !root.is_dir() {
        return Err(format!(
            "No Codex chats were found at {}.",
            root.to_string_lossy()
        ));
    }

    let mut paths = Vec::new();
    let mut skipped_files = 0;
    for entry in WalkDir::new(&root)
        .follow_links(false)
        .into_iter()
        .take(MAX_WALK_ENTRIES)
    {
        let Ok(entry) = entry else {
            skipped_files += 1;
            continue;
        };
        if entry.file_type().is_file()
            && entry.path().extension().and_then(|value| value.to_str()) == Some("jsonl")
        {
            paths.push(entry.into_path());
        }
    }
    paths.sort_unstable_by(|left, right| right.cmp(left));
    if paths.len() > MAX_TRANSCRIPT_FILES {
        skipped_files += paths.len() - MAX_TRANSCRIPT_FILES;
        paths.truncate(MAX_TRANSCRIPT_FILES);
    }

    let mut total_bytes = 0_u64;
    let mut scanned_files = 0;
    let mut threads = Vec::new();
    for path in paths {
        let Ok(bytes) = path.metadata().map(|metadata| metadata.len()) else {
            skipped_files += 1;
            continue;
        };
        if total_bytes.saturating_add(bytes) > MAX_TOTAL_BYTES {
            skipped_files += 1;
            continue;
        }
        total_bytes += bytes;
        scanned_files += 1;
        match parse_transcript(&path) {
            Ok(Some(thread)) => threads.push(thread),
            Ok(None) | Err(()) => skipped_files += 1,
        }
    }
    threads.sort_unstable_by_key(|thread| std::cmp::Reverse(thread.updated_at));

    Ok(CodexImportResult {
        threads,
        scanned_files,
        skipped_files,
        resolved_path: root.to_string_lossy().into_owned(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_visible_codex_chat_without_duplicate_response_items() {
        let dir =
            std::env::temp_dir().join(format!("open-xiao-codex-import-{}", rand::random::<u64>()));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("rollout.jsonl");
        fs::write(
            &path,
            [
                r#"{"timestamp":"2026-08-14T10:00:00Z","type":"session_meta","payload":{"id":"thread-1","timestamp":"2026-08-14T09:59:00Z","cwd":"C:\\work"}}"#,
                r#"{"timestamp":"2026-08-14T10:00:01Z","type":"turn_context","payload":{"model":"gpt-5.6-sol"}}"#,
                r#"{"timestamp":"2026-08-14T10:00:02Z","type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"injected duplicate"}]}}"#,
                r#"{"timestamp":"2026-08-14T10:00:03Z","type":"event_msg","payload":{"type":"user_message","message":"  Build   this app  "}}"#,
                r#"{"timestamp":"2026-08-14T10:00:04Z","type":"event_msg","payload":{"type":"agent_reasoning","text":"Inspect first"}}"#,
                r#"{"timestamp":"2026-08-14T10:00:05Z","type":"event_msg","payload":{"type":"agent_message","message":"Working"}}"#,
                r#"{"timestamp":"2026-08-14T10:00:06Z","type":"event_msg","payload":{"type":"agent_message","message":"Finished"}}"#,
            ]
            .join("\n"),
        )
        .unwrap();

        let original = fs::read(&path).unwrap();
        let parsed = parse_transcript(&path).unwrap().unwrap();
        assert_eq!(parsed.source_id, "thread-1");
        assert_eq!(parsed.title, "Build this app");
        assert_eq!(parsed.cwd.as_deref(), Some("C:\\work"));
        assert_eq!(parsed.model_id.as_deref(), Some("gpt-5.6-sol"));
        assert_eq!(parsed.messages.len(), 2);
        assert_eq!(parsed.messages[0].content, "Build   this app");
        assert_eq!(parsed.messages[1].content, "Working\n\nFinished");
        assert_eq!(
            parsed.messages[1].thinking.as_deref(),
            Some("Inspect first")
        );
        assert_eq!(fs::read(&path).unwrap(), original);
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn falls_back_to_response_items_for_legacy_transcripts() {
        let dir =
            std::env::temp_dir().join(format!("open-xiao-codex-import-{}", rand::random::<u64>()));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("rollout.jsonl");
        fs::write(
            &path,
            [
                r#"{"timestamp":"2025-01-01T00:00:00Z","type":"session_meta","payload":{"id":"legacy"}}"#,
                r#"{"timestamp":"2025-01-01T00:00:01Z","type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"Hello"}]}}"#,
                r#"{"timestamp":"2025-01-01T00:00:02Z","type":"response_item","payload":{"type":"reasoning","summary":[{"type":"summary_text","text":"Think"}]}}"#,
                r#"{"timestamp":"2025-01-01T00:00:03Z","type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"Hi"}]}}"#,
            ]
            .join("\n"),
        )
        .unwrap();

        let parsed = parse_transcript(&path).unwrap().unwrap();
        assert_eq!(parsed.messages.len(), 2);
        assert_eq!(parsed.messages[1].content, "Hi");
        assert_eq!(parsed.messages[1].thinking.as_deref(), Some("Think"));
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn scans_a_codex_sessions_tree_without_changing_the_source() {
        let dir =
            std::env::temp_dir().join(format!("open-xiao-codex-scan-{}", rand::random::<u64>()));
        let sessions = dir.join("sessions");
        let day = sessions.join("2026").join("08").join("14");
        fs::create_dir_all(&day).unwrap();
        let path = day.join("rollout.jsonl");
        fs::write(
            &path,
            [
                r#"{"timestamp":"2026-08-14T10:00:00Z","type":"session_meta","payload":{"id":"scan-thread"}}"#,
                r#"{"timestamp":"2026-08-14T10:00:01Z","type":"event_msg","payload":{"type":"user_message","message":"Import me"}}"#,
                r#"{"timestamp":"2026-08-14T10:00:02Z","type":"event_msg","payload":{"type":"agent_message","message":"Imported"}}"#,
            ]
            .join("\n"),
        )
        .unwrap();
        let original = fs::read(&path).unwrap();

        let result = import_chats_from(sessions).unwrap();
        assert_eq!(result.scanned_files, 1);
        assert_eq!(result.skipped_files, 0);
        assert_eq!(result.threads.len(), 1);
        assert_eq!(result.threads[0].source_id, "scan-thread");
        assert_eq!(result.threads[0].messages.len(), 2);
        assert_eq!(fs::read(&path).unwrap(), original);
        fs::remove_dir_all(dir).unwrap();
    }
}
