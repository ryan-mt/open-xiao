use crate::db::DbState;
use chrono::{Datelike, Local, LocalResult, NaiveDate, NaiveTime, TimeZone};
use rand::Rng;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager, State};

const POLL_INTERVAL_SECONDS: u64 = 5;
const MIN_INTERVAL_MINUTES: u32 = 1;
const MAX_TEXT_CHARS: usize = 100_000;
const FIXED_TIME_GRACE_MS: i64 = 10 * 60_000;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum AutomationSchedule {
    Interval {
        every_minutes: u32,
    },
    FixedTime {
        time_of_day: String,
        weekdays: Vec<u32>,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AutomationTask {
    pub id: String,
    pub title: String,
    pub prompt: String,
    pub enabled: bool,
    pub schedule: AutomationSchedule,
    pub project_id: String,
    pub model_id: String,
    pub access_mode: String,
    pub permission_mode: String,
    pub agent_mode: String,
    pub created_at: i64,
    pub updated_at: i64,
    pub next_run_at: Option<i64>,
    pub last_run_at: Option<i64>,
    pub last_run_status: String,
    pub last_error: Option<String>,
    pub last_thread_id: Option<String>,
    pub run_count: u32,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AutomationUpsertInput {
    pub id: Option<String>,
    pub title: String,
    pub prompt: String,
    pub enabled: bool,
    pub schedule: AutomationSchedule,
    pub project_id: String,
    pub model_id: String,
    pub access_mode: String,
    pub permission_mode: String,
    pub agent_mode: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AutomationDueEvent {
    pub task_id: String,
    pub title: String,
    pub prompt: String,
    pub project_id: String,
    pub model_id: String,
    pub access_mode: String,
    pub permission_mode: String,
    pub agent_mode: String,
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or(0)
}

fn validate_text(value: &str, label: &str) -> Result<String, String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Err(format!("{label} is required"));
    }
    if trimmed.chars().count() > MAX_TEXT_CHARS {
        return Err(format!("{label} is too long"));
    }
    Ok(trimmed.to_string())
}

fn validate_schedule(schedule: &AutomationSchedule) -> Result<(), String> {
    match schedule {
        AutomationSchedule::Interval { every_minutes } => {
            if *every_minutes < MIN_INTERVAL_MINUTES {
                return Err("Interval must be at least one minute".into());
            }
        }
        AutomationSchedule::FixedTime {
            time_of_day,
            weekdays,
        } => {
            NaiveTime::parse_from_str(time_of_day, "%H:%M")
                .map_err(|_| "Time must use 24-hour HH:MM format".to_string())?;
            if weekdays.iter().any(|day| *day > 6) {
                return Err("Weekdays must be between 0 and 6".into());
            }
        }
    }
    Ok(())
}

fn validate_choice(value: &str, allowed: &[&str], label: &str) -> Result<String, String> {
    if allowed.contains(&value) {
        Ok(value.to_string())
    } else {
        Err(format!("Unsupported {label}"))
    }
}

fn next_run_at(schedule: &AutomationSchedule, from_ms: i64) -> Result<i64, String> {
    match schedule {
        AutomationSchedule::Interval { every_minutes } => {
            Ok(from_ms.saturating_add((*every_minutes as i64).saturating_mul(60_000)))
        }
        AutomationSchedule::FixedTime {
            time_of_day,
            weekdays,
        } => {
            let time = NaiveTime::parse_from_str(time_of_day, "%H:%M")
                .map_err(|_| "Invalid fixed time".to_string())?;
            let from = Local
                .timestamp_millis_opt(from_ms)
                .single()
                .unwrap_or_else(Local::now);
            let selected: std::collections::HashSet<u32> = weekdays.iter().copied().collect();
            for offset in 0..=7 {
                let date: NaiveDate = from.date_naive() + chrono::Duration::days(offset);
                let weekday = date.weekday().num_days_from_sunday();
                if !selected.is_empty() && !selected.contains(&weekday) {
                    continue;
                }
                let naive = date.and_time(time);
                let candidate = match Local.from_local_datetime(&naive) {
                    LocalResult::Single(value) => value,
                    LocalResult::Ambiguous(first, _) => first,
                    LocalResult::None => continue,
                };
                if candidate.timestamp_millis() > from_ms {
                    return Ok(candidate.timestamp_millis());
                }
            }
            Err("Could not calculate the next fixed-time run".into())
        }
    }
}

fn new_id() -> String {
    let random: u64 = rand::rng().random();
    format!("automation-{:x}-{random:x}", now_ms())
}

fn map_task(row: &rusqlite::Row<'_>) -> rusqlite::Result<AutomationTask> {
    let schedule_json: String = row.get(4)?;
    let schedule = serde_json::from_str(&schedule_json).map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(
            schedule_json.len(),
            rusqlite::types::Type::Text,
            Box::new(error),
        )
    })?;
    Ok(AutomationTask {
        id: row.get(0)?,
        title: row.get(1)?,
        prompt: row.get(2)?,
        enabled: row.get::<_, i64>(3)? != 0,
        schedule,
        project_id: row.get(5)?,
        model_id: row.get(6)?,
        access_mode: row.get(7)?,
        permission_mode: row.get(8)?,
        agent_mode: row.get(9)?,
        created_at: row.get(10)?,
        updated_at: row.get(11)?,
        next_run_at: row.get(12)?,
        last_run_at: row.get(13)?,
        last_run_status: row.get(14)?,
        last_error: row.get(15)?,
        last_thread_id: row.get(16)?,
        run_count: row.get::<_, i64>(17)?.max(0) as u32,
    })
}

fn read_task(conn: &Connection, id: &str) -> Result<Option<AutomationTask>, String> {
    conn.query_row(
        "SELECT id, title, prompt, enabled, schedule_json, project_id, model_id,
                access_mode, permission_mode, agent_mode, created_at, updated_at,
                next_run_at, last_run_at, last_run_status, last_error,
                last_thread_id, run_count
         FROM automation_tasks WHERE id = ?1",
        params![id],
        map_task,
    )
    .optional()
    .map_err(|error| format!("read automation: {error}"))
}

fn list_tasks(conn: &Connection) -> Result<Vec<AutomationTask>, String> {
    let mut statement = conn
        .prepare(
            "SELECT id, title, prompt, enabled, schedule_json, project_id, model_id,
                    access_mode, permission_mode, agent_mode, created_at, updated_at,
                    next_run_at, last_run_at, last_run_status, last_error,
                    last_thread_id, run_count
             FROM automation_tasks ORDER BY updated_at DESC, id ASC",
        )
        .map_err(|error| format!("prepare automations: {error}"))?;
    let tasks = statement
        .query_map([], map_task)
        .map_err(|error| format!("query automations: {error}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("decode automation: {error}"))?;
    Ok(tasks)
}

fn event_for(task: &AutomationTask) -> AutomationDueEvent {
    AutomationDueEvent {
        task_id: task.id.clone(),
        title: task.title.clone(),
        prompt: task.prompt.clone(),
        project_id: task.project_id.clone(),
        model_id: task.model_id.clone(),
        access_mode: task.access_mode.clone(),
        permission_mode: task.permission_mode.clone(),
        agent_mode: task.agent_mode.clone(),
    }
}

fn missed_fixed_time(task: &AutomationTask, now: i64) -> bool {
    matches!(task.schedule, AutomationSchedule::FixedTime { .. })
        && task
            .next_run_at
            .is_some_and(|due| now.saturating_sub(due) > FIXED_TIME_GRACE_MS)
}

fn reserve_task(conn: &Connection, id: &str, require_due: bool) -> Result<AutomationTask, String> {
    let now = now_ms();
    let task = read_task(conn, id)?.ok_or_else(|| "Automation not found".to_string())?;
    if task.last_run_status == "running" {
        return Err("Automation is already running".into());
    }
    if require_due && (!task.enabled || task.next_run_at.is_none_or(|due| due > now)) {
        return Err("Automation is not due".into());
    }
    let next = if task.enabled {
        Some(next_run_at(&task.schedule, now)?)
    } else {
        None
    };
    let changed = conn
        .execute(
            "UPDATE automation_tasks
             SET last_run_status = 'running', last_run_at = ?2, last_error = NULL,
                 next_run_at = ?3, updated_at = ?2
             WHERE id = ?1 AND last_run_status != 'running'",
            params![id, now, next],
        )
        .map_err(|error| format!("reserve automation: {error}"))?;
    if changed == 0 {
        return Err("Automation is already running".into());
    }
    read_task(conn, id)?.ok_or_else(|| "Automation not found after reserve".to_string())
}

fn fail_reserved_task(conn: &Connection, id: &str, message: &str) -> Result<(), String> {
    conn.execute(
        "UPDATE automation_tasks
         SET last_run_status = 'failed', last_error = ?2,
             run_count = run_count + 1, updated_at = ?3
         WHERE id = ?1 AND last_run_status = 'running'",
        params![
            id,
            message.chars().take(2_000).collect::<String>(),
            now_ms()
        ],
    )
    .map_err(|error| format!("release automation: {error}"))?;
    Ok(())
}

#[tauri::command]
pub fn automation_list(state: State<'_, DbState>) -> Result<Vec<AutomationTask>, String> {
    let conn = state.0.lock().map_err(|_| "database lock poisoned")?;
    list_tasks(&conn)
}

#[tauri::command]
pub fn automation_upsert(
    state: State<'_, DbState>,
    input: AutomationUpsertInput,
) -> Result<AutomationTask, String> {
    let title = validate_text(&input.title, "Name")?;
    let prompt = validate_text(&input.prompt, "Prompt")?;
    let project_id = validate_text(&input.project_id, "Project")?;
    let model_id = validate_text(&input.model_id, "Model")?;
    validate_schedule(&input.schedule)?;
    let access_mode = validate_choice(&input.access_mode, &["workspace", "full"], "access mode")?;
    let permission_mode =
        validate_choice(&input.permission_mode, &["auto", "ask"], "permission mode")?;
    let agent_mode = validate_choice(&input.agent_mode, &["plan", "build"], "agent mode")?;
    let now = now_ms();
    let id = input.id.unwrap_or_else(new_id);
    let conn = state.0.lock().map_err(|_| "database lock poisoned")?;
    let existing = read_task(&conn, &id)?;
    if existing
        .as_ref()
        .is_some_and(|task| task.last_run_status == "running")
    {
        return Err("Cannot edit an automation while it is running".into());
    }
    let schedule_json = serde_json::to_string(&input.schedule)
        .map_err(|error| format!("encode schedule: {error}"))?;
    let next = if input.enabled {
        Some(next_run_at(&input.schedule, now)?)
    } else {
        None
    };
    conn.execute(
        "INSERT INTO automation_tasks (
            id, title, prompt, enabled, schedule_json, project_id, model_id,
            access_mode, permission_mode, agent_mode, created_at, updated_at,
            next_run_at, last_run_at, last_run_status, last_error,
            last_thread_id, run_count
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13,
                   ?14, ?15, ?16, ?17, ?18)
         ON CONFLICT(id) DO UPDATE SET
            title = excluded.title, prompt = excluded.prompt, enabled = excluded.enabled,
            schedule_json = excluded.schedule_json, project_id = excluded.project_id,
            model_id = excluded.model_id, access_mode = excluded.access_mode,
            permission_mode = excluded.permission_mode, agent_mode = excluded.agent_mode,
            updated_at = excluded.updated_at, next_run_at = excluded.next_run_at",
        params![
            id,
            title,
            prompt,
            input.enabled as i64,
            schedule_json,
            project_id,
            model_id,
            access_mode,
            permission_mode,
            agent_mode,
            existing.as_ref().map_or(now, |task| task.created_at),
            now,
            next,
            existing.as_ref().and_then(|task| task.last_run_at),
            existing
                .as_ref()
                .map_or("never", |task| task.last_run_status.as_str()),
            existing
                .as_ref()
                .and_then(|task| task.last_error.as_deref()),
            existing
                .as_ref()
                .and_then(|task| task.last_thread_id.as_deref()),
            existing.as_ref().map_or(0, |task| task.run_count),
        ],
    )
    .map_err(|error| format!("save automation: {error}"))?;
    read_task(&conn, &id)?.ok_or_else(|| "Automation was not saved".to_string())
}

#[tauri::command]
pub fn automation_set_enabled(
    state: State<'_, DbState>,
    id: String,
    enabled: bool,
) -> Result<AutomationTask, String> {
    let conn = state.0.lock().map_err(|_| "database lock poisoned")?;
    let task = read_task(&conn, &id)?.ok_or_else(|| "Automation not found".to_string())?;
    if task.last_run_status == "running" {
        return Err("Cannot pause an automation while it is running".into());
    }
    let now = now_ms();
    let next = if enabled {
        Some(next_run_at(&task.schedule, now)?)
    } else {
        None
    };
    conn.execute(
        "UPDATE automation_tasks SET enabled = ?2, next_run_at = ?3, updated_at = ?4 WHERE id = ?1",
        params![id, enabled as i64, next, now],
    )
    .map_err(|error| format!("update automation: {error}"))?;
    read_task(&conn, &id)?.ok_or_else(|| "Automation not found after update".to_string())
}

#[tauri::command]
pub fn automation_delete(state: State<'_, DbState>, id: String) -> Result<(), String> {
    let conn = state.0.lock().map_err(|_| "database lock poisoned")?;
    let task = read_task(&conn, &id)?.ok_or_else(|| "Automation not found".to_string())?;
    if task.last_run_status == "running" {
        return Err("Cannot delete an automation while it is running".into());
    }
    conn.execute("DELETE FROM automation_tasks WHERE id = ?1", params![id])
        .map_err(|error| format!("delete automation: {error}"))?;
    Ok(())
}

#[tauri::command]
pub fn automation_run_now(
    app: AppHandle,
    state: State<'_, DbState>,
    id: String,
) -> Result<AutomationTask, String> {
    let task = {
        let conn = state.0.lock().map_err(|_| "database lock poisoned")?;
        reserve_task(&conn, &id, false)?
    };
    if let Err(error) = app.emit("automation://due", event_for(&task)) {
        let message = format!("Could not dispatch automation: {error}");
        let conn = state.0.lock().map_err(|_| "database lock poisoned")?;
        fail_reserved_task(&conn, &task.id, &message)?;
        return Err(message);
    }
    Ok(task)
}

#[tauri::command]
pub fn automation_record_run(
    state: State<'_, DbState>,
    id: String,
    succeeded: bool,
    error: Option<String>,
    thread_id: Option<String>,
) -> Result<AutomationTask, String> {
    let conn = state.0.lock().map_err(|_| "database lock poisoned")?;
    let task = read_task(&conn, &id)?.ok_or_else(|| "Automation not found".to_string())?;
    if task.last_run_status != "running" {
        return Err("Automation has no active run".into());
    }
    let status = if succeeded { "succeeded" } else { "failed" };
    let clean_error = error.map(|value| value.chars().take(2_000).collect::<String>());
    conn.execute(
        "UPDATE automation_tasks
         SET last_run_status = ?2, last_error = ?3, last_thread_id = ?4,
             run_count = run_count + 1, updated_at = ?5
         WHERE id = ?1 AND last_run_status = 'running'",
        params![id, status, clean_error, thread_id, now_ms()],
    )
    .map_err(|db_error| format!("record automation run: {db_error}"))?;
    read_task(&conn, &id)?.ok_or_else(|| "Automation not found after run".to_string())
}

pub fn start_scheduler(app: AppHandle) {
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_secs(POLL_INTERVAL_SECONDS));
        loop {
            let events = (|| -> Result<Vec<AutomationDueEvent>, String> {
                let state = app.state::<DbState>();
                let conn = state.0.lock().map_err(|_| "database lock poisoned")?;
                let now = now_ms();
                let mut statement = conn
                    .prepare(
                        "SELECT id FROM automation_tasks
                         WHERE enabled = 1 AND next_run_at IS NOT NULL
                           AND next_run_at <= ?1 AND last_run_status != 'running'
                         ORDER BY next_run_at ASC LIMIT 16",
                    )
                    .map_err(|error| format!("prepare due automations: {error}"))?;
                let ids = statement
                    .query_map(params![now], |row| row.get::<_, String>(0))
                    .map_err(|error| format!("query due automations: {error}"))?
                    .collect::<Result<Vec<_>, _>>()
                    .map_err(|error| format!("decode due automations: {error}"))?;
                drop(statement);
                let mut events = Vec::with_capacity(ids.len());
                for id in ids {
                    if let Some(task) = read_task(&conn, &id)? {
                        if missed_fixed_time(&task, now) {
                            let next = next_run_at(&task.schedule, now)?;
                            conn.execute(
                                "UPDATE automation_tasks SET next_run_at = ?2, updated_at = ?3 WHERE id = ?1",
                                params![id, next, now],
                            )
                            .map_err(|error| format!("reschedule missed automation: {error}"))?;
                            continue;
                        }
                    }
                    match reserve_task(&conn, &id, true) {
                        Ok(task) => events.push(event_for(&task)),
                        Err(error) if error == "Automation is not due" => {}
                        Err(error) => eprintln!("automation scheduler: {error}"),
                    }
                }
                Ok(events)
            })();
            match events {
                Ok(events) => {
                    for event in events {
                        if let Err(error) = app.emit("automation://due", &event) {
                            eprintln!("automation scheduler emit: {error}");
                            if let Ok(conn) = app.state::<DbState>().0.lock() {
                                let _ = fail_reserved_task(
                                    &conn,
                                    &event.task_id,
                                    &format!("Could not dispatch automation: {error}"),
                                );
                            }
                        }
                    }
                }
                Err(error) => eprintln!("automation scheduler: {error}"),
            }
            std::thread::sleep(std::time::Duration::from_secs(POLL_INTERVAL_SECONDS));
        }
    });
}

pub fn recover_interrupted_runs(conn: &Connection) -> Result<(), String> {
    conn.execute(
        "UPDATE automation_tasks
         SET last_run_status = 'failed',
             last_error = 'Run was interrupted when Open Xiao stopped.',
             run_count = run_count + 1,
             updated_at = ?1
         WHERE last_run_status = 'running'",
        params![now_ms()],
    )
    .map_err(|error| format!("recover automations: {error}"))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_invalid_schedule_values() {
        assert!(validate_schedule(&AutomationSchedule::Interval { every_minutes: 0 }).is_err());
        assert!(validate_schedule(&AutomationSchedule::FixedTime {
            time_of_day: "25:00".into(),
            weekdays: vec![],
        })
        .is_err());
    }

    #[test]
    fn interval_schedule_advances_from_reference_time() {
        assert_eq!(
            next_run_at(&AutomationSchedule::Interval { every_minutes: 5 }, 1_000).unwrap(),
            301_000
        );
    }

    #[test]
    fn only_fixed_time_runs_expire_after_the_grace_window() {
        let base = AutomationTask {
            id: "task".into(),
            title: "Task".into(),
            prompt: "Run".into(),
            enabled: true,
            schedule: AutomationSchedule::FixedTime {
                time_of_day: "09:00".into(),
                weekdays: vec![],
            },
            project_id: "project".into(),
            model_id: "model".into(),
            access_mode: "workspace".into(),
            permission_mode: "ask".into(),
            agent_mode: "build".into(),
            created_at: 0,
            updated_at: 0,
            next_run_at: Some(1_000),
            last_run_at: None,
            last_run_status: "never".into(),
            last_error: None,
            last_thread_id: None,
            run_count: 0,
        };
        assert!(missed_fixed_time(&base, 1_000 + FIXED_TIME_GRACE_MS + 1));
        assert!(!missed_fixed_time(
            &AutomationTask {
                schedule: AutomationSchedule::Interval { every_minutes: 5 },
                ..base
            },
            1_000 + FIXED_TIME_GRACE_MS + 1
        ));
    }
}
