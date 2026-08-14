//! Local SQLite store for app profile + activity streaks.

use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::{AppHandle, Manager, State};

const DB_FILE: &str = "open-xiao.db";

pub struct DbState(pub Mutex<Connection>);

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Profile {
    pub id: i64,
    pub name: String,
    pub avatar_data_url: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DayCount {
    pub date: String,
    pub count: i64,
    pub token_count: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileStats {
    pub current_streak: i64,
    pub longest_streak: i64,
    pub total_active_days: i64,
    pub total_messages: i64,
    pub total_openai_tokens: i64,
    pub days: Vec<DayCount>,
}

fn db_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app data dir: {e}"))?;
    fs::create_dir_all(&dir).map_err(|e| format!("create app data: {e}"))?;
    Ok(dir.join(DB_FILE))
}

pub fn open_db(app: &AppHandle) -> Result<Connection, String> {
    let path = db_path(app)?;
    let conn = Connection::open(path).map_err(|e| format!("open sqlite: {e}"))?;
    conn.execute_batch(
        "
        PRAGMA journal_mode = WAL;
        PRAGMA foreign_keys = ON;
        CREATE TABLE IF NOT EXISTS profile (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            name TEXT NOT NULL,
            avatar_data_url TEXT,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS activity_day (
            day TEXT PRIMARY KEY,
            count INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS openai_token_day (
            day TEXT PRIMARY KEY,
            token_count INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS kv_store (
            key TEXT PRIMARY KEY NOT NULL,
            value TEXT NOT NULL,
            updated_at INTEGER NOT NULL
        );
        ",
    )
    .map_err(|e| format!("migrate sqlite: {e}"))?;
    Ok(conn)
}

fn now_ms() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn today_utc() -> String {
    let ms = now_ms();
    let days = ms.div_euclid(86_400_000);
    civil_ymd(days)
}

/// Days since Unix epoch → YYYY-MM-DD (proleptic Gregorian, UTC).
fn civil_ymd(days: i64) -> String {
    // Algorithm from civil_from_days (Howard Hinnant)
    let z = days + 719468;
    let era = if z >= 0 { z } else { z - 146096 } / 146097;
    let doe = (z - era * 146097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    format!("{y:04}-{m:02}-{d:02}")
}

fn map_profile(row: &rusqlite::Row<'_>) -> rusqlite::Result<Profile> {
    Ok(Profile {
        id: row.get(0)?,
        name: row.get(1)?,
        avatar_data_url: row.get(2)?,
        created_at: row.get(3)?,
        updated_at: row.get(4)?,
    })
}

fn read_profile(conn: &Connection) -> Result<Option<Profile>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id, name, avatar_data_url, created_at, updated_at FROM profile WHERE id = 1",
        )
        .map_err(|e| format!("prepare profile: {e}"))?;
    let mut rows = stmt.query([]).map_err(|e| format!("query profile: {e}"))?;
    match rows.next().map_err(|e| format!("row profile: {e}"))? {
        Some(row) => Ok(Some(map_profile(row).map_err(|e| e.to_string())?)),
        None => Ok(None),
    }
}

fn compute_stats(
    conn: &Connection,
    days_back: i64,
    local_today: Option<&str>,
) -> Result<ProfileStats, String> {
    let days_back = days_back.clamp(30, 400);
    let today = local_today
        .filter(|day| ymd_to_days(day).is_some())
        .map(str::to_string)
        .unwrap_or_else(today_utc);
    let today_days = ymd_to_days(&today).unwrap_or(0);
    let start_days = today_days - (days_back - 1);
    let start = civil_ymd(start_days);

    let mut stmt = conn
        .prepare(
            "SELECT day, count FROM activity_day WHERE day >= ?1 AND day <= ?2 ORDER BY day ASC",
        )
        .map_err(|e| format!("prepare activity: {e}"))?;
    let rows = stmt
        .query_map(params![start, today], |row| {
            Ok(DayCount {
                date: row.get(0)?,
                count: row.get(1)?,
                token_count: 0,
            })
        })
        .map_err(|e| format!("query activity: {e}"))?;

    let mut map = std::collections::HashMap::<String, i64>::new();
    for r in rows {
        let d = r.map_err(|e| format!("activity row: {e}"))?;
        map.insert(d.date, d.count);
    }

    let mut token_stmt = conn
        .prepare(
            "SELECT day, token_count FROM openai_token_day WHERE day >= ?1 AND day <= ?2 ORDER BY day ASC",
        )
        .map_err(|e| format!("prepare token activity: {e}"))?;
    let token_rows = token_stmt
        .query_map(params![start, today], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
        })
        .map_err(|e| format!("query token activity: {e}"))?;
    let mut token_map = std::collections::HashMap::<String, i64>::new();
    for row in token_rows {
        let (day, token_count) = row.map_err(|e| format!("token activity row: {e}"))?;
        token_map.insert(day, token_count);
    }

    let mut days = Vec::with_capacity(days_back as usize);
    let mut total_active_days: i64 = 0;
    for i in 0..days_back {
        let d = civil_ymd(start_days + i);
        let count = *map.get(&d).unwrap_or(&0);
        let token_count = *token_map.get(&d).unwrap_or(&0);
        if count > 0 || token_count > 0 {
            total_active_days += 1;
        }
        days.push(DayCount {
            date: d,
            count,
            token_count,
        });
    }

    let mut all_stmt = conn
        .prepare(
            "SELECT day FROM activity_day WHERE count > 0 AND day <= ?1
             UNION
             SELECT day FROM openai_token_day WHERE token_count > 0 AND day <= ?1
             ORDER BY day DESC",
        )
        .map_err(|e| format!("prepare streak: {e}"))?;
    let active: Vec<String> = all_stmt
        .query_map(params![today], |row| row.get(0))
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .collect();

    let active_set: std::collections::HashSet<String> = active.iter().cloned().collect();

    let mut current_streak = 0i64;
    let mut cursor = today_days;
    if !active_set.contains(&civil_ymd(cursor)) {
        cursor -= 1;
    }
    loop {
        let key = civil_ymd(cursor);
        if active_set.contains(&key) {
            current_streak += 1;
            cursor -= 1;
        } else {
            break;
        }
    }

    let mut longest_streak = 0i64;
    let mut run = 0i64;
    let mut prev: Option<i64> = None;
    let mut sorted: Vec<i64> = active.iter().filter_map(|d| ymd_to_days(d)).collect();
    sorted.sort_unstable();
    sorted.dedup();
    for day in sorted {
        if let Some(p) = prev {
            if day == p + 1 {
                run += 1;
            } else {
                run = 1;
            }
        } else {
            run = 1;
        }
        longest_streak = longest_streak.max(run);
        prev = Some(day);
    }

    let total_messages = map.values().sum();
    let total_openai_tokens = token_map.values().sum();

    Ok(ProfileStats {
        current_streak,
        longest_streak,
        total_active_days,
        total_messages,
        total_openai_tokens,
        days,
    })
}

fn ymd_to_days(ymd: &str) -> Option<i64> {
    let mut parts = ymd.split('-');
    let y: i64 = parts.next()?.parse().ok()?;
    let m: u32 = parts.next()?.parse().ok()?;
    let d: u32 = parts.next()?.parse().ok()?;
    if parts.next().is_some() || !(1..=12).contains(&m) {
        return None;
    }
    let leap = y % 4 == 0 && (y % 100 != 0 || y % 400 == 0);
    let max_day = match m {
        2 if leap => 29,
        2 => 28,
        4 | 6 | 9 | 11 => 30,
        _ => 31,
    };
    if !(1..=max_day).contains(&d) {
        return None;
    }
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = (y - era * 400) as u64;
    let mp = if m > 2 { m - 3 } else { m + 9 };
    let doy = (153 * mp as u64 + 2) / 5 + d as u64 - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    Some(era * 146097 + doe as i64 - 719468)
}

fn validate_name(name: &str) -> Result<String, String> {
    let t = name.trim();
    if t.is_empty() {
        return Err("Name is required".into());
    }
    if t.chars().count() > 64 {
        return Err("Name is too long (max 64)".into());
    }
    Ok(t.to_string())
}

fn validate_avatar(avatar: &Option<String>) -> Result<Option<String>, String> {
    match avatar {
        None => Ok(None),
        Some(s) if s.is_empty() => Ok(None),
        Some(s) => {
            if s.len() > 2_500_000 {
                return Err("Avatar is too large".into());
            }
            if !s.starts_with("data:image/") {
                return Err("Avatar must be an image data URL".into());
            }
            Ok(Some(s.clone()))
        }
    }
}

fn validate_day(day: &str) -> Result<String, String> {
    let t = day.trim();
    if t.len() != 10 || ymd_to_days(t).is_none() {
        return Err("Invalid day (expected YYYY-MM-DD)".into());
    }
    Ok(t.to_string())
}

#[tauri::command]
pub fn profile_get(db: State<'_, DbState>) -> Result<Option<Profile>, String> {
    let conn = db.0.lock().map_err(|_| "db lock poisoned".to_string())?;
    read_profile(&conn)
}

#[tauri::command]
pub fn profile_create(db: State<'_, DbState>, name: String) -> Result<Profile, String> {
    let name = validate_name(&name)?;
    let conn = db.0.lock().map_err(|_| "db lock poisoned".to_string())?;
    if read_profile(&conn)?.is_some() {
        return Err("Profile already exists".into());
    }
    let ts = now_ms();
    conn.execute(
        "INSERT INTO profile (id, name, avatar_data_url, created_at, updated_at) VALUES (1, ?1, NULL, ?2, ?2)",
        params![name, ts],
    )
    .map_err(|e| format!("create profile: {e}"))?;
    read_profile(&conn)?.ok_or_else(|| "profile missing after create".into())
}

#[tauri::command]
pub fn profile_update(
    db: State<'_, DbState>,
    name: Option<String>,
    avatar_data_url: Option<String>,
    clear_avatar: Option<bool>,
) -> Result<Profile, String> {
    let conn = db.0.lock().map_err(|_| "db lock poisoned".to_string())?;
    let mut p = read_profile(&conn)?.ok_or_else(|| "No profile yet".to_string())?;
    if let Some(n) = name {
        p.name = validate_name(&n)?;
    }
    if clear_avatar.unwrap_or(false) {
        p.avatar_data_url = None;
    } else if let Some(a) = avatar_data_url {
        p.avatar_data_url = validate_avatar(&Some(a))?;
    }
    let ts = now_ms();
    conn.execute(
        "UPDATE profile SET name = ?1, avatar_data_url = ?2, updated_at = ?3 WHERE id = 1",
        params![p.name, p.avatar_data_url, ts],
    )
    .map_err(|e| format!("update profile: {e}"))?;
    read_profile(&conn)?.ok_or_else(|| "profile missing after update".into())
}

#[tauri::command]
pub fn profile_stats(
    db: State<'_, DbState>,
    days: Option<i64>,
    today: Option<String>,
) -> Result<ProfileStats, String> {
    let today = today.map(|day| validate_day(&day)).transpose()?;
    let conn = db.0.lock().map_err(|_| "db lock poisoned".to_string())?;
    compute_stats(&conn, days.unwrap_or(371), today.as_deref())
}

#[tauri::command]
pub fn profile_record_activity(
    db: State<'_, DbState>,
    day: Option<String>,
    amount: Option<i64>,
) -> Result<(), String> {
    let day = match day {
        Some(d) => validate_day(&d)?,
        None => today_utc(),
    };
    let amount = amount.unwrap_or(1).clamp(1, 100);
    let conn = db.0.lock().map_err(|_| "db lock poisoned".to_string())?;
    conn.execute(
        "INSERT INTO activity_day (day, count) VALUES (?1, ?2)
         ON CONFLICT(day) DO UPDATE SET count = count + excluded.count",
        params![day, amount],
    )
    .map_err(|e| format!("record activity: {e}"))?;
    Ok(())
}

#[tauri::command]
pub fn profile_record_openai_tokens(
    db: State<'_, DbState>,
    day: Option<String>,
    amount: i64,
) -> Result<(), String> {
    let day = match day {
        Some(day) => validate_day(&day)?,
        None => today_utc(),
    };
    let amount = amount.clamp(1, 1_000_000_000);
    let conn = db.0.lock().map_err(|_| "db lock poisoned".to_string())?;
    conn.execute(
        "INSERT INTO openai_token_day (day, token_count) VALUES (?1, ?2)
         ON CONFLICT(day) DO UPDATE SET token_count = token_count + excluded.token_count",
        params![day, amount],
    )
    .map_err(|e| format!("record OpenAI token activity: {e}"))?;
    Ok(())
}

fn validate_kv_key(key: &str) -> Result<String, String> {
    let t = key.trim();
    if t.is_empty() {
        return Err("Key is required".into());
    }
    if t.len() > 128 {
        return Err("Key is too long".into());
    }
    if !t
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.')
    {
        return Err("Key has invalid characters".into());
    }
    Ok(t.to_string())
}

/// Read a JSON blob from durable app storage (survives restarts).
#[tauri::command]
pub fn kv_get(db: State<'_, DbState>, key: String) -> Result<Option<String>, String> {
    let key = validate_kv_key(&key)?;
    let conn = db.0.lock().map_err(|_| "db lock poisoned".to_string())?;
    let mut stmt = conn
        .prepare("SELECT value FROM kv_store WHERE key = ?1")
        .map_err(|e| format!("prepare kv_get: {e}"))?;
    let mut rows = stmt
        .query(params![key])
        .map_err(|e| format!("query kv_get: {e}"))?;
    match rows.next().map_err(|e| format!("row kv_get: {e}"))? {
        Some(row) => Ok(Some(row.get::<_, String>(0).map_err(|e| e.to_string())?)),
        None => Ok(None),
    }
}

/// Upsert a JSON blob into durable app storage.
#[tauri::command]
pub fn kv_set(db: State<'_, DbState>, key: String, value: String) -> Result<(), String> {
    let key = validate_kv_key(&key)?;
    if value.len() > 48_000_000 {
        return Err("Value is too large".into());
    }
    let conn = db.0.lock().map_err(|_| "db lock poisoned".to_string())?;
    let ts = now_ms();
    conn.execute(
        "INSERT INTO kv_store (key, value, updated_at) VALUES (?1, ?2, ?3)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
        params![key, value, ts],
    )
    .map_err(|e| format!("kv_set: {e}"))?;
    Ok(())
}

/// Remove a key from durable app storage.
#[tauri::command]
pub fn kv_remove(db: State<'_, DbState>, key: String) -> Result<(), String> {
    let key = validate_kv_key(&key)?;
    let conn = db.0.lock().map_err(|_| "db lock poisoned".to_string())?;
    conn.execute("DELETE FROM kv_store WHERE key = ?1", params![key])
        .map_err(|e| format!("kv_remove: {e}"))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn profile_stats_end_on_supplied_local_today() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE activity_day (
                day TEXT PRIMARY KEY,
                count INTEGER NOT NULL DEFAULT 0
            );
            CREATE TABLE openai_token_day (
                day TEXT PRIMARY KEY,
                token_count INTEGER NOT NULL DEFAULT 0
            );",
        )
        .unwrap();
        let stats = compute_stats(&conn, 30, Some("2026-03-10")).unwrap();
        assert_eq!(
            stats.days.last().map(|day| day.date.as_str()),
            Some("2026-03-10")
        );
    }

    #[test]
    fn profile_stats_without_local_today_excludes_future_records() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE activity_day (day TEXT PRIMARY KEY, count INTEGER NOT NULL);
             CREATE TABLE openai_token_day (day TEXT PRIMARY KEY, token_count INTEGER NOT NULL);
             INSERT INTO activity_day VALUES ('9999-12-31', 7);
             INSERT INTO openai_token_day VALUES ('9999-12-31', 9000);",
        )
        .unwrap();

        let stats = compute_stats(&conn, 30, None).unwrap();

        assert_eq!(stats.total_messages, 0);
        assert_eq!(stats.total_openai_tokens, 0);
        assert!(stats.days.iter().all(|day| day.date != "9999-12-31"));
    }

    #[test]
    fn profile_stats_keeps_messages_and_openai_tokens_separate() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE activity_day (day TEXT PRIMARY KEY, count INTEGER NOT NULL);
             CREATE TABLE openai_token_day (day TEXT PRIMARY KEY, token_count INTEGER NOT NULL);
             INSERT INTO activity_day VALUES ('2026-03-09', 2);
             INSERT INTO openai_token_day VALUES ('2026-03-10', 1234);",
        )
        .unwrap();
        let stats = compute_stats(&conn, 30, Some("2026-03-10")).unwrap();
        assert_eq!(stats.total_messages, 2);
        assert_eq!(stats.total_openai_tokens, 1234);
        assert_eq!(stats.total_active_days, 2);
        assert_eq!(stats.days.last().map(|day| day.token_count), Some(1234));
    }

    #[test]
    fn profile_totals_match_window_while_streaks_keep_past_history() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE activity_day (day TEXT PRIMARY KEY, count INTEGER NOT NULL);
             CREATE TABLE openai_token_day (day TEXT PRIMARY KEY, token_count INTEGER NOT NULL);
             INSERT INTO activity_day VALUES
               ('2024-01-01', 1), ('2024-01-02', 1), ('2024-01-03', 1), ('2024-01-04', 1),
               ('2024-02-29', 2), ('2024-03-01', 3),
               ('2024-03-02', 99), ('2024-03-03', 99), ('2024-03-04', 99),
               ('2024-03-05', 99), ('2024-03-06', 99);
             INSERT INTO openai_token_day VALUES ('2024-02-28', 7), ('2024-03-02', 999);",
        )
        .unwrap();

        let stats = compute_stats(&conn, 30, Some("2024-03-01")).unwrap();
        assert_eq!(stats.total_messages, 5);
        assert_eq!(stats.total_openai_tokens, 7);
        assert_eq!(stats.total_active_days, 3);
        assert_eq!(stats.current_streak, 3);
        assert_eq!(stats.longest_streak, 4);
        assert_eq!(stats.days[28].date, "2024-02-29");
        assert_eq!(
            stats.days.last().map(|day| day.date.as_str()),
            Some("2024-03-01")
        );
    }

    #[test]
    fn validate_day_rejects_impossible_calendar_dates() {
        assert!(validate_day("2024-02-29").is_ok());
        assert!(validate_day("2025-02-29").is_err());
        assert!(validate_day("2025-02-31").is_err());
        assert!(validate_day("2025-04-31").is_err());
    }
}
