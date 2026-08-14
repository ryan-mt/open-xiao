use chrono::{DateTime, Days, Local, NaiveDate, TimeZone, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{BTreeMap, HashMap, HashSet};
use std::fs::{self, File};
use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant, UNIX_EPOCH};
use tauri::{AppHandle, Manager};
use walkdir::WalkDir;

const LITELLM_RATES_URL: &str =
    "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";
const RATE_TTL: Duration = Duration::from_secs(24 * 60 * 60);
const MAX_WINDOW_DAYS: u16 = 90;
const HOUR_MS: i64 = 60 * 60 * 1_000;
const MAX_HOURLY_WINDOW_MS: i64 = 24 * HOUR_MS;
const MTIME_SLACK: Duration = Duration::from_secs(36 * 60 * 60);
const SCAN_CACHE_FILE: &str = "usage-scan-cache.json";
const RATE_CACHE_FILE: &str = "usage-model-rates.json";
const SCAN_CACHE_VERSION: u8 = 2;
const SCAN_CACHE_RETENTION: Duration = Duration::from_secs(90 * 24 * 60 * 60);
const TRANSCRIPT_BUFFER_BYTES: usize = 256 * 1024;
const MAX_SCAN_CACHE_BYTES: usize = 32 * 1024 * 1024;
const MAX_SCAN_CACHE_FILES: usize = 20_000;
const MAX_SCAN_CACHE_RECORDS: usize = 500_000;
const MAX_TRANSCRIPT_BYTES_PER_FILE: u64 = 64 * 1024 * 1024;
const MAX_TRANSCRIPT_LINE_BYTES: usize = 1024 * 1024;
const MAX_TRANSCRIPT_RECORDS_PER_FILE: usize = 50_000;
const MAX_USAGE_WALK_ENTRIES: usize = 100_000;
const MAX_USAGE_TRANSCRIPT_FILES: usize = 10_000;
const MAX_USAGE_BYTES_PER_SOURCE: u64 = 256 * 1024 * 1024;
const MAX_USAGE_RECORDS_PER_SOURCE: usize = 250_000;

#[derive(Clone, Copy)]
struct TranscriptLimits {
    max_bytes: u64,
    max_line_bytes: usize,
    max_records: usize,
}

const TRANSCRIPT_LIMITS: TranscriptLimits = TranscriptLimits {
    max_bytes: MAX_TRANSCRIPT_BYTES_PER_FILE,
    max_line_bytes: MAX_TRANSCRIPT_LINE_BYTES,
    max_records: MAX_TRANSCRIPT_RECORDS_PER_FILE,
};

#[derive(Debug, Eq, PartialEq)]
enum BoundedLineRead {
    Eof,
    Complete,
    Oversized,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, Hash, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(rename_all = "lowercase")]
enum UsageProvider {
    Claude,
    Codex,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
enum UsageResolution {
    Day,
    Hour,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageTokenTotals {
    uncached_input_tokens: u64,
    cached_input_tokens: u64,
    cache_creation_tokens: u64,
    output_tokens: u64,
    reasoning_tokens: u64,
}

impl UsageTokenTotals {
    fn add(&mut self, other: Self) {
        self.uncached_input_tokens = self
            .uncached_input_tokens
            .saturating_add(other.uncached_input_tokens);
        self.cached_input_tokens = self
            .cached_input_tokens
            .saturating_add(other.cached_input_tokens);
        self.cache_creation_tokens = self
            .cache_creation_tokens
            .saturating_add(other.cache_creation_tokens);
        self.output_tokens = self.output_tokens.saturating_add(other.output_tokens);
        self.reasoning_tokens = self.reasoning_tokens.saturating_add(other.reasoning_tokens);
    }

    fn total(self) -> u64 {
        self.uncached_input_tokens
            .saturating_add(self.cached_input_tokens)
            .saturating_add(self.cache_creation_tokens)
            .saturating_add(self.output_tokens)
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageBucket {
    day: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    hour_start: Option<String>,
    provider: UsageProvider,
    model: String,
    totals: UsageTokenTotals,
    cost_usd: f64,
    cache_savings_usd: f64,
    cost_source: &'static str,
    records: u64,
    provider_reported_records: u64,
    model_priced_records: u64,
    unpriced_records: u64,
    sessions: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageSource {
    provider: UsageProvider,
    status: &'static str,
    resolved_path: String,
    scanned_files: u64,
    skipped_files: u64,
    malformed_records: u64,
    distinct_sessions: u64,
    message: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageSummary {
    read_at: String,
    since_day: String,
    until_day: String,
    resolution: UsageResolution,
    #[serde(skip_serializing_if = "Option::is_none")]
    since_time: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    until_time: Option<String>,
    buckets: Vec<UsageBucket>,
    sources: Vec<UsageSource>,
    pricing_status: &'static str,
    pricing_source: &'static str,
    pricing_fetched_at: Option<String>,
    known_models: usize,
    scan_duration_ms: u64,
}

#[derive(Clone, Copy, Debug)]
struct ModelRate {
    input: f64,
    output: f64,
    cache_read: f64,
    cache_creation: f64,
}

type RateTable = HashMap<String, ModelRate>;

#[derive(Clone)]
struct RateSnapshot {
    rates: RateTable,
    status: &'static str,
    fetched_at_ms: Option<i64>,
}

struct RateCache {
    rates: RateTable,
    fetched_at_ms: i64,
    status: &'static str,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct RateCacheDocument {
    fetched_at_ms: i64,
    document: Value,
}

static RATE_CACHE: OnceLock<tokio::sync::Mutex<Option<RateCache>>> = OnceLock::new();

#[derive(Clone, Debug, Deserialize, Serialize)]
struct UsageRecord {
    provider: UsageProvider,
    timestamp_ms: i64,
    model: String,
    session_id: String,
    totals: UsageTokenTotals,
    reported_cost_usd: Option<f64>,
    dedupe_key: Option<String>,
}

#[derive(Debug, Deserialize, Serialize)]
struct CachedTranscript {
    size: u64,
    modified_ms: u64,
    provider: UsageProvider,
    malformed_records: u64,
    records: Vec<UsageRecord>,
}

type ScanCache = HashMap<String, CachedTranscript>;

#[derive(Deserialize)]
struct ScanCacheDocument {
    version: u8,
    #[serde(default)]
    files: ScanCache,
}

#[derive(Serialize)]
struct ScanCacheView<'a> {
    version: u8,
    files: &'a ScanCache,
}

struct FileRecords<'a> {
    records: &'a [UsageRecord],
    malformed_records: u64,
    cache_hit: bool,
}

static SCAN_CACHE: OnceLock<Mutex<Option<ScanCache>>> = OnceLock::new();

#[derive(Default)]
struct CodexScanState {
    model: String,
    session_id: String,
    last_usage_signature: Option<String>,
}

#[derive(Default)]
struct MutableBucket {
    totals: UsageTokenTotals,
    cost_usd: f64,
    cache_savings_usd: f64,
    records: u64,
    unpriced_records: u64,
    provider_reported_records: u64,
    model_priced_records: u64,
    sessions: HashSet<String>,
}

struct UsageAggregator<'a> {
    since_day: NaiveDate,
    until_day: NaiveDate,
    hourly_window: Option<(i64, i64)>,
    rates: &'a RateTable,
    keyed_records: HashMap<String, UsageRecord>,
    unkeyed_records: Vec<UsageRecord>,
}

fn should_replace_usage_record(current: &UsageRecord, candidate: &UsageRecord) -> bool {
    let current_output = current.totals.output_tokens;
    let candidate_output = candidate.totals.output_tokens;
    if candidate_output != current_output {
        return candidate_output > current_output;
    }

    let current_total = current.totals.total();
    let candidate_total = candidate.totals.total();
    if candidate_total != current_total {
        return candidate_total > current_total;
    }

    let current_cached = current
        .totals
        .cached_input_tokens
        .saturating_add(current.totals.cache_creation_tokens);
    let candidate_cached = candidate
        .totals
        .cached_input_tokens
        .saturating_add(candidate.totals.cache_creation_tokens);
    if candidate_cached != current_cached {
        return candidate_cached > current_cached;
    }

    let current_reported = current.reported_cost_usd.filter(|value| value.is_finite());
    let candidate_reported = candidate
        .reported_cost_usd
        .filter(|value| value.is_finite());
    match (current_reported, candidate_reported) {
        (None, Some(_)) => return true,
        (Some(_), None) => return false,
        (Some(current_cost), Some(candidate_cost)) if candidate_cost != current_cost => {
            return candidate_cost > current_cost;
        }
        _ => {}
    }

    candidate.timestamp_ms > current.timestamp_ms
}

fn hourly_window_days(
    since_time_ms: i64,
    until_time_ms: i64,
) -> Result<(NaiveDate, NaiveDate), String> {
    let duration_ms = until_time_ms.saturating_sub(since_time_ms);
    if duration_ms <= 0 || duration_ms > MAX_HOURLY_WINDOW_MS {
        return Err(
            "Hourly usage window must be greater than zero and at most 24 hours.".to_string(),
        );
    }
    let since_day = DateTime::from_timestamp_millis(since_time_ms)
        .map(|value| value.with_timezone(&Local).date_naive())
        .ok_or_else(|| "Hourly usage start is outside the supported date range.".to_string())?;
    let until_day = DateTime::from_timestamp_millis(until_time_ms.saturating_sub(1))
        .map(|value| value.with_timezone(&Local).date_naive())
        .ok_or_else(|| "Hourly usage end is outside the supported date range.".to_string())?;
    Ok((since_day, until_day))
}

impl<'a> UsageAggregator<'a> {
    fn new(since_day: NaiveDate, until_day: NaiveDate, rates: &'a RateTable) -> Self {
        Self {
            since_day,
            until_day,
            hourly_window: None,
            rates,
            keyed_records: HashMap::new(),
            unkeyed_records: Vec::new(),
        }
    }

    fn hourly(
        since_time_ms: i64,
        until_time_ms: i64,
        rates: &'a RateTable,
    ) -> Result<Self, String> {
        let (since_day, until_day) = hourly_window_days(since_time_ms, until_time_ms)?;
        Ok(Self {
            since_day,
            until_day,
            hourly_window: Some((since_time_ms, until_time_ms)),
            rates,
            keyed_records: HashMap::new(),
            unkeyed_records: Vec::new(),
        })
    }

    fn add(&mut self, record: &UsageRecord) {
        if let Some(key) = &record.dedupe_key {
            let replace = self
                .keyed_records
                .get(key)
                .is_none_or(|current| should_replace_usage_record(current, record));
            if replace {
                self.keyed_records.insert(key.clone(), record.clone());
            }
        } else {
            self.unkeyed_records.push(record.clone());
        }
    }

    fn selected_records(&self) -> impl Iterator<Item = &UsageRecord> {
        self.keyed_records
            .values()
            .chain(self.unkeyed_records.iter())
    }

    fn record_day(&self, record: &UsageRecord) -> Option<NaiveDate> {
        DateTime::from_timestamp_millis(record.timestamp_ms)
            .map(|timestamp| timestamp.with_timezone(&Local).date_naive())
    }

    fn is_in_window(&self, day: NaiveDate) -> bool {
        day >= self.since_day && day <= self.until_day
    }

    fn record_is_in_window(&self, record: &UsageRecord) -> bool {
        if let Some((since_time_ms, until_time_ms)) = self.hourly_window {
            return record.timestamp_ms >= since_time_ms && record.timestamp_ms < until_time_ms;
        }
        self.record_day(record)
            .is_some_and(|day| self.is_in_window(day))
    }

    fn record_hour_start(&self, record: &UsageRecord) -> Option<i64> {
        let (since_time_ms, _) = self.hourly_window?;
        Some(since_time_ms + ((record.timestamp_ms - since_time_ms) / HOUR_MS) * HOUR_MS)
    }

    fn distinct_sessions(&self, provider: UsageProvider) -> usize {
        self.selected_records()
            .filter(|record| {
                record.provider == provider
                    && !record.session_id.is_empty()
                    && self.record_is_in_window(record)
            })
            .map(|record| record.session_id.as_str())
            .collect::<HashSet<_>>()
            .len()
    }

    fn finish(&self) -> Vec<UsageBucket> {
        let mut buckets =
            BTreeMap::<(NaiveDate, Option<i64>, UsageProvider, String), MutableBucket>::new();
        for record in self.selected_records() {
            let Some(day) = self.record_day(record) else {
                continue;
            };
            if !self.record_is_in_window(record) {
                continue;
            }
            let hour_start = self.record_hour_start(record);

            let priced = price_usage(
                self.rates,
                &record.model,
                record.totals,
                record.reported_cost_usd,
            );
            let cache_savings = cache_savings_usd(self.rates, &record.model, record.totals);
            let bucket = buckets
                .entry((day, hour_start, record.provider, record.model.clone()))
                .or_default();
            bucket.totals.add(record.totals);
            bucket.cost_usd += priced.cost_usd;
            bucket.cache_savings_usd += cache_savings;
            bucket.records = bucket.records.saturating_add(1);
            match priced.source {
                "unpriced" => bucket.unpriced_records = bucket.unpriced_records.saturating_add(1),
                "providerReported" => {
                    bucket.provider_reported_records =
                        bucket.provider_reported_records.saturating_add(1)
                }
                "modelPriced" => {
                    bucket.model_priced_records = bucket.model_priced_records.saturating_add(1)
                }
                _ => {}
            }
            if !record.session_id.is_empty() {
                bucket.sessions.insert(record.session_id.clone());
            }
        }

        buckets
            .into_iter()
            .map(|((day, hour_start, provider, model), bucket)| {
                debug_assert_eq!(
                    bucket.records,
                    bucket.provider_reported_records
                        + bucket.model_priced_records
                        + bucket.unpriced_records
                );
                let cost_source = if bucket.unpriced_records == bucket.records {
                    "unpriced"
                } else if bucket.provider_reported_records == bucket.records {
                    "providerReported"
                } else if bucket.model_priced_records == bucket.records {
                    "modelPriced"
                } else {
                    "mixed"
                };
                UsageBucket {
                    day: day.format("%Y-%m-%d").to_string(),
                    hour_start: hour_start
                        .and_then(DateTime::from_timestamp_millis)
                        .map(|value| value.to_rfc3339_opts(chrono::SecondsFormat::Millis, true)),
                    provider,
                    model,
                    totals: bucket.totals,
                    cost_usd: bucket.cost_usd,
                    cache_savings_usd: bucket.cache_savings_usd,
                    cost_source,
                    records: bucket.records,
                    provider_reported_records: bucket.provider_reported_records,
                    model_priced_records: bucket.model_priced_records,
                    unpriced_records: bucket.unpriced_records,
                    sessions: bucket.sessions.len() as u64,
                }
            })
            .collect()
    }
}

struct PricedUsage {
    cost_usd: f64,
    source: &'static str,
}

fn normalized_model_name(model: &str) -> String {
    model
        .trim()
        .rsplit('/')
        .next()
        .unwrap_or_default()
        .to_ascii_lowercase()
}

fn rate_key_priority(model: &str) -> u8 {
    let normalized = model.trim().to_ascii_lowercase();
    if !normalized.contains('/') {
        3
    } else if normalized.starts_with("openai/") || normalized.starts_with("anthropic/") {
        2
    } else {
        1
    }
}

fn parse_rate_table(document: &Value) -> RateTable {
    let mut rates = HashMap::new();
    let mut priorities = HashMap::<String, u8>::new();
    let Some(entries) = document.as_object() else {
        return rates;
    };
    for (model, raw) in entries {
        let Some(entry) = raw.as_object() else {
            continue;
        };
        let Some(input) = entry.get("input_cost_per_token").and_then(Value::as_f64) else {
            continue;
        };
        let Some(output) = entry.get("output_cost_per_token").and_then(Value::as_f64) else {
            continue;
        };
        let key = normalized_model_name(model);
        let priority = rate_key_priority(model);
        let should_replace = priorities
            .get(&key)
            .is_none_or(|current| priority > *current);
        if should_replace {
            rates.insert(
                key.clone(),
                ModelRate {
                    input,
                    output,
                    cache_read: entry
                        .get("cache_read_input_token_cost")
                        .and_then(Value::as_f64)
                        .unwrap_or(input),
                    cache_creation: entry
                        .get("cache_creation_input_token_cost")
                        .and_then(Value::as_f64)
                        .unwrap_or(input),
                },
            );
            priorities.insert(key, priority);
        }
    }
    rates
}

fn lookup_rate<'a>(rates: &'a RateTable, model: &str) -> Option<&'a ModelRate> {
    let normalized = normalized_model_name(model);
    if matches!(
        normalized.as_str(),
        "" | "<synthetic>" | "synthetic" | "opus" | "sonnet" | "haiku" | "fable"
    ) {
        return None;
    }
    rates.get(&normalized)
}

fn price_usage(
    rates: &RateTable,
    model: &str,
    totals: UsageTokenTotals,
    reported_cost_usd: Option<f64>,
) -> PricedUsage {
    if let Some(cost) = reported_cost_usd.filter(|value| value.is_finite()) {
        return PricedUsage {
            cost_usd: cost,
            source: "providerReported",
        };
    }
    let Some(rate) = lookup_rate(rates, model) else {
        return PricedUsage {
            cost_usd: 0.0,
            source: "unpriced",
        };
    };
    PricedUsage {
        cost_usd: totals.uncached_input_tokens as f64 * rate.input
            + totals.cached_input_tokens as f64 * rate.cache_read
            + totals.cache_creation_tokens as f64 * rate.cache_creation
            + totals.output_tokens as f64 * rate.output,
        source: "modelPriced",
    }
}

fn cache_savings_usd(rates: &RateTable, model: &str, totals: UsageTokenTotals) -> f64 {
    let Some(rate) = lookup_rate(rates, model) else {
        return 0.0;
    };
    totals.cached_input_tokens as f64 * (rate.input - rate.cache_read)
}

fn load_rate_cache(path: &Path) -> Option<RateCache> {
    let raw = fs::read_to_string(path).ok()?;
    let document = serde_json::from_str::<RateCacheDocument>(&raw).ok()?;
    let rates = parse_rate_table(&document.document);
    (!rates.is_empty()).then_some(RateCache {
        rates,
        fetched_at_ms: document.fetched_at_ms,
        status: "cached",
    })
}

fn save_rate_cache(path: &Path, fetched_at_ms: i64, document: Value) -> Result<(), String> {
    let bytes = serde_json::to_vec(&RateCacheDocument {
        fetched_at_ms,
        document,
    })
    .map_err(|error| format!("Could not serialize the usage rate cache: {error}"))?;
    crate::paths::atomic_write(path, &bytes)
        .map_err(|error| format!("Could not save the usage rate cache: {error}"))
}

fn stale_rate_snapshot(cached: &mut Option<RateCache>) -> RateSnapshot {
    if let Some(entry) = cached.as_mut() {
        entry.status = "cached";
        return RateSnapshot {
            rates: entry.rates.clone(),
            status: "cached",
            fetched_at_ms: Some(entry.fetched_at_ms),
        };
    }
    RateSnapshot {
        rates: HashMap::new(),
        status: "unavailable",
        fetched_at_ms: None,
    }
}

async fn load_rates(cache_path: &Path) -> RateSnapshot {
    let cache = RATE_CACHE.get_or_init(|| tokio::sync::Mutex::new(None));
    let mut cached = cache.lock().await;
    let now_ms = Utc::now().timestamp_millis();
    if cached.is_none() {
        *cached = load_rate_cache(cache_path);
    }
    if let Some(entry) = cached.as_ref() {
        if now_ms.saturating_sub(entry.fetched_at_ms) < RATE_TTL.as_millis() as i64 {
            return RateSnapshot {
                rates: entry.rates.clone(),
                status: entry.status,
                fetched_at_ms: Some(entry.fetched_at_ms),
            };
        }
    }

    let fetched = reqwest::Client::new()
        .get(LITELLM_RATES_URL)
        .timeout(Duration::from_secs(10))
        .send()
        .await
        .ok()
        .and_then(|response| response.error_for_status().ok());
    if let Some(response) = fetched {
        if let Ok(document) = response.json::<Value>().await {
            let rates = parse_rate_table(&document);
            if !rates.is_empty() {
                let _ = save_rate_cache(cache_path, now_ms, document);
                *cached = Some(RateCache {
                    rates: rates.clone(),
                    fetched_at_ms: now_ms,
                    status: "fresh",
                });
                return RateSnapshot {
                    rates,
                    status: "fresh",
                    fetched_at_ms: Some(now_ms),
                };
            }
        }
    }

    stale_rate_snapshot(&mut cached)
}

fn json_u64(value: Option<&Value>) -> u64 {
    value
        .and_then(Value::as_f64)
        .filter(|number| number.is_finite() && *number > 0.0)
        .map(|number| number.trunc().min(u64::MAX as f64) as u64)
        .unwrap_or(0)
}

fn parse_timestamp_ms(value: Option<&Value>) -> Option<i64> {
    let raw = value?.as_str()?;
    DateTime::parse_from_rfc3339(raw)
        .ok()
        .map(|timestamp| timestamp.timestamp_millis())
}

fn parse_claude_line(line: &str) -> Result<Option<UsageRecord>, ()> {
    let record: Value = serde_json::from_str(line).map_err(|_| ())?;
    if record.get("type").and_then(Value::as_str) != Some("assistant") {
        return Ok(None);
    }
    let Some(message) = record.get("message").and_then(Value::as_object) else {
        return Ok(None);
    };
    let Some(usage) = message.get("usage").and_then(Value::as_object) else {
        return Ok(None);
    };
    let Some(timestamp_ms) = parse_timestamp_ms(record.get("timestamp")) else {
        return Ok(None);
    };
    let Some(model) = message.get("model").and_then(Value::as_str) else {
        return Ok(None);
    };
    if model.is_empty()
        || matches!(
            normalized_model_name(model).as_str(),
            "<synthetic>" | "synthetic"
        )
    {
        return Ok(None);
    }
    let totals = UsageTokenTotals {
        uncached_input_tokens: json_u64(usage.get("input_tokens")),
        cached_input_tokens: json_u64(usage.get("cache_read_input_tokens")),
        cache_creation_tokens: json_u64(usage.get("cache_creation_input_tokens")),
        output_tokens: json_u64(usage.get("output_tokens")),
        reasoning_tokens: 0,
    };
    if totals.total() == 0 {
        return Ok(None);
    }
    let message_id = message.get("id").and_then(Value::as_str);
    let request_id = record.get("requestId").and_then(Value::as_str);
    let dedupe_key = match (message_id, request_id) {
        (None, None) => None,
        (message_id, request_id) => Some(format!(
            "{}:{}",
            message_id.unwrap_or_default(),
            request_id.unwrap_or_default()
        )),
    };
    Ok(Some(UsageRecord {
        provider: UsageProvider::Claude,
        timestamp_ms,
        model: model.to_string(),
        session_id: record
            .get("sessionId")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        totals,
        reported_cost_usd: record.get("costUSD").and_then(Value::as_f64),
        dedupe_key,
    }))
}

fn parse_codex_line(line: &str, state: &mut CodexScanState) -> Result<Option<UsageRecord>, ()> {
    let record: Value = serde_json::from_str(line).map_err(|_| ())?;
    let Some(payload) = record.get("payload").and_then(Value::as_object) else {
        return Ok(None);
    };
    match record.get("type").and_then(Value::as_str) {
        Some("session_meta") => {
            if let Some(id) = payload
                .get("id")
                .or_else(|| payload.get("session_id"))
                .and_then(Value::as_str)
            {
                state.session_id = id.to_string();
            }
            return Ok(None);
        }
        Some("turn_context") => {
            state.last_usage_signature = None;
            if let Some(model) = payload.get("model").and_then(Value::as_str) {
                state.model = model.to_string();
            }
            return Ok(None);
        }
        _ => {}
    }
    if payload.get("type").and_then(Value::as_str) != Some("token_count") {
        return Ok(None);
    }
    let Some(last) = payload
        .get("info")
        .and_then(Value::as_object)
        .and_then(|info| info.get("last_token_usage"))
        .and_then(Value::as_object)
    else {
        return Ok(None);
    };
    let Some(timestamp_ms) = parse_timestamp_ms(record.get("timestamp")) else {
        return Ok(None);
    };
    if state.model.is_empty() {
        return Ok(None);
    }
    let signature = serde_json::to_string(last).map_err(|_| ())?;
    if state.last_usage_signature.as_deref() == Some(signature.as_str()) {
        return Ok(None);
    }
    state.last_usage_signature = Some(signature);

    let input_tokens = json_u64(last.get("input_tokens"));
    let cached_input_tokens = json_u64(last.get("cached_input_tokens"));
    let cache_creation_tokens = json_u64(last.get("cache_write_input_tokens"));
    let output_tokens = json_u64(last.get("output_tokens"));
    let totals = UsageTokenTotals {
        uncached_input_tokens: input_tokens
            .saturating_sub(cached_input_tokens)
            .saturating_sub(cache_creation_tokens),
        cached_input_tokens,
        cache_creation_tokens,
        output_tokens,
        reasoning_tokens: json_u64(last.get("reasoning_output_tokens")).min(output_tokens),
    };
    if totals.total() == 0 {
        return Ok(None);
    }
    Ok(Some(UsageRecord {
        provider: UsageProvider::Codex,
        timestamp_ms,
        model: state.model.clone(),
        session_id: state.session_id.clone(),
        totals,
        reported_cost_usd: None,
        dedupe_key: None,
    }))
}

fn home_dir() -> Option<PathBuf> {
    std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" }).map(PathBuf::from)
}

fn source_paths() -> Vec<(UsageProvider, PathBuf)> {
    let home = home_dir().unwrap_or_default();
    let claude_home = std::env::var_os("CLAUDE_CONFIG_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| home.join(".claude"));
    let codex_home = std::env::var_os("CODEX_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| home.join(".codex"));
    vec![
        (UsageProvider::Claude, claude_home.join("projects")),
        (UsageProvider::Codex, codex_home.join("sessions")),
    ]
}

fn file_modified_ms(path: &Path) -> Option<u128> {
    path.metadata()
        .ok()?
        .modified()
        .ok()?
        .duration_since(UNIX_EPOCH)
        .ok()
        .map(|duration| duration.as_millis())
}

fn usage_cache_paths(app: &AppHandle) -> Result<(PathBuf, PathBuf), String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("Could not resolve the app data directory: {error}"))?;
    fs::create_dir_all(&dir)
        .map_err(|error| format!("Could not create the app data directory: {error}"))?;
    Ok((dir.join(SCAN_CACHE_FILE), dir.join(RATE_CACHE_FILE)))
}

fn load_scan_cache(path: &Path) -> ScanCache {
    let Ok(file) = File::open(path) else {
        return ScanCache::default();
    };
    let Ok(metadata) = file.metadata() else {
        return ScanCache::default();
    };
    if metadata.len() > MAX_SCAN_CACHE_BYTES as u64 {
        return ScanCache::default();
    }
    let mut raw = Vec::with_capacity(metadata.len() as usize);
    if file
        .take(MAX_SCAN_CACHE_BYTES as u64 + 1)
        .read_to_end(&mut raw)
        .is_err()
        || raw.len() > MAX_SCAN_CACHE_BYTES
    {
        return ScanCache::default();
    }
    let Ok(mut document) = serde_json::from_slice::<ScanCacheDocument>(&raw) else {
        return ScanCache::default();
    };
    if document.version != SCAN_CACHE_VERSION || document.files.len() > MAX_SCAN_CACHE_FILES {
        return ScanCache::default();
    }
    let mut total_records = 0_usize;
    for entry in document.files.values_mut() {
        entry.records = dedupe_within_file(std::mem::take(&mut entry.records));
        if entry.records.len() > MAX_TRANSCRIPT_RECORDS_PER_FILE {
            return ScanCache::default();
        }
        total_records = total_records.saturating_add(entry.records.len());
        if total_records > MAX_SCAN_CACHE_RECORDS {
            return ScanCache::default();
        }
    }
    document.files
}

fn save_scan_cache(path: &Path, cache: &ScanCache) -> Result<(), String> {
    if cache.len() > MAX_SCAN_CACHE_FILES
        || cache
            .values()
            .any(|entry| entry.records.len() > MAX_TRANSCRIPT_RECORDS_PER_FILE)
        || cache
            .values()
            .try_fold(0_usize, |total, entry| {
                total.checked_add(entry.records.len())
            })
            .is_none_or(|total| total > MAX_SCAN_CACHE_RECORDS)
    {
        return Err("Usage scan cache exceeds its safety limit".into());
    }
    let bytes = serde_json::to_vec(&ScanCacheView {
        version: SCAN_CACHE_VERSION,
        files: cache,
    })
    .map_err(|error| format!("Could not serialize the usage scan cache: {error}"))?;
    if bytes.len() > MAX_SCAN_CACHE_BYTES {
        return Err("Usage scan cache exceeds its safety limit".into());
    }
    crate::paths::atomic_write(path, &bytes)
        .map_err(|error| format!("Could not save the usage scan cache: {error}"))
}

fn read_bounded_line<R: BufRead>(
    reader: &mut R,
    line: &mut Vec<u8>,
    max_bytes: usize,
) -> std::io::Result<BoundedLineRead> {
    line.clear();
    let mut read_any = false;
    let mut oversized = false;
    loop {
        let buffer = reader.fill_buf()?;
        if buffer.is_empty() {
            return Ok(if !read_any {
                BoundedLineRead::Eof
            } else if oversized {
                BoundedLineRead::Oversized
            } else {
                BoundedLineRead::Complete
            });
        }
        read_any = true;
        let newline = buffer.iter().position(|byte| *byte == b'\n');
        let consumed = newline.map_or(buffer.len(), |index| index + 1);
        if !oversized {
            let kept = consumed.min(max_bytes.saturating_sub(line.len()));
            line.extend_from_slice(&buffer[..kept]);
            oversized = kept < consumed;
        }
        reader.consume(consumed);
        if newline.is_some() {
            return Ok(if oversized {
                BoundedLineRead::Oversized
            } else {
                BoundedLineRead::Complete
            });
        }
    }
}

fn parse_transcript_records(
    provider: UsageProvider,
    path: &Path,
) -> Result<(Vec<UsageRecord>, u64), ()> {
    parse_transcript_records_with_limits(provider, path, TRANSCRIPT_LIMITS)
}

fn parse_transcript_records_with_limits(
    provider: UsageProvider,
    path: &Path,
    limits: TranscriptLimits,
) -> Result<(Vec<UsageRecord>, u64), ()> {
    let file = File::open(path).map_err(|_| ())?;
    let truncated = file.metadata().map_err(|_| ())?.len() > limits.max_bytes;
    let mut reader = BufReader::with_capacity(TRANSCRIPT_BUFFER_BYTES, file.take(limits.max_bytes));
    let mut line = Vec::new();
    let mut records = Vec::new();
    let mut malformed_records = 0_u64;
    let mut codex_state = CodexScanState::default();

    loop {
        match read_bounded_line(&mut reader, &mut line, limits.max_line_bytes).map_err(|_| ())? {
            BoundedLineRead::Eof => break,
            BoundedLineRead::Oversized => {
                malformed_records = malformed_records.saturating_add(1);
                continue;
            }
            BoundedLineRead::Complete => {}
        }
        let Ok(line) = std::str::from_utf8(&line) else {
            malformed_records = malformed_records.saturating_add(1);
            continue;
        };
        let parsed = match provider {
            UsageProvider::Claude => {
                if !line.contains("\"usage\"") {
                    continue;
                }
                parse_claude_line(line)
            }
            UsageProvider::Codex => {
                if !line.contains("\"token_count\"")
                    && !line.contains("\"turn_context\"")
                    && !line.contains("\"session_meta\"")
                {
                    continue;
                }
                parse_codex_line(line, &mut codex_state)
            }
        };
        match parsed {
            Ok(Some(record)) if records.len() < limits.max_records => records.push(record),
            Ok(Some(_)) => {
                malformed_records = malformed_records.saturating_add(1);
                break;
            }
            Ok(None) => {}
            Err(()) => malformed_records = malformed_records.saturating_add(1),
        }
    }

    if truncated {
        malformed_records = malformed_records.saturating_add(1);
    }

    Ok((records, malformed_records))
}

fn dedupe_within_file(records: Vec<UsageRecord>) -> Vec<UsageRecord> {
    let mut keyed = HashMap::<String, UsageRecord>::new();
    let mut unkeyed = Vec::new();
    for record in records {
        if let Some(key) = &record.dedupe_key {
            let replace = keyed
                .get(key)
                .is_none_or(|current| should_replace_usage_record(current, &record));
            if replace {
                keyed.insert(key.clone(), record);
            }
        } else {
            unkeyed.push(record);
        }
    }
    keyed.into_values().chain(unkeyed).collect()
}

fn read_file_records<'a>(
    provider: UsageProvider,
    path: &Path,
    cache: &'a mut ScanCache,
) -> Result<FileRecords<'a>, ()> {
    let metadata = path.metadata().map_err(|_| ())?;
    let modified_ms = metadata
        .modified()
        .map_err(|_| ())?
        .duration_since(UNIX_EPOCH)
        .map_err(|_| ())?
        .as_millis()
        .min(u128::from(u64::MAX)) as u64;
    let size = metadata.len();
    let key = path.to_string_lossy().to_string();
    let cache_hit = cache.get(&key).is_some_and(|entry| {
        entry.size == size && entry.modified_ms == modified_ms && entry.provider == provider
    });

    if !cache_hit {
        let (records, malformed_records) = parse_transcript_records(provider, path)?;
        cache.insert(
            key.clone(),
            CachedTranscript {
                size,
                modified_ms,
                provider,
                malformed_records,
                records: dedupe_within_file(records),
            },
        );
    }

    let entry = cache.get(&key).ok_or(())?;
    Ok(FileRecords {
        records: &entry.records,
        malformed_records: entry.malformed_records,
        cache_hit,
    })
}

fn scan_source(
    provider: UsageProvider,
    root: &Path,
    since_mtime_ms: u128,
    aggregator: &mut UsageAggregator<'_>,
    cache: &mut ScanCache,
    cache_dirty: &mut bool,
    live_paths: &mut HashSet<String>,
) -> UsageSource {
    let resolved_path = root.to_string_lossy().to_string();
    if !root.is_dir() {
        return UsageSource {
            provider,
            status: "missing",
            resolved_path,
            scanned_files: 0,
            skipped_files: 0,
            malformed_records: 0,
            distinct_sessions: 0,
            message: Some("No transcript directory was found.".into()),
        };
    }

    let mut scanned_files = 0_u64;
    let mut skipped_files = 0_u64;
    let mut malformed_records = 0_u64;
    let mut walk_failed = false;
    let mut read_failed = false;
    let mut safety_limit_reached = false;
    let mut transcript_files = 0_usize;
    let mut transcript_bytes = 0_u64;
    let mut aggregated_records = 0_usize;

    for (walked_entries, entry) in WalkDir::new(root)
        .follow_links(false)
        .into_iter()
        .enumerate()
    {
        if walked_entries >= MAX_USAGE_WALK_ENTRIES {
            safety_limit_reached = true;
            break;
        }
        let entry = match entry {
            Ok(entry) => entry,
            Err(_) => {
                walk_failed = true;
                continue;
            }
        };
        if !entry.file_type().is_file()
            || entry.path().extension().and_then(|value| value.to_str()) != Some("jsonl")
        {
            continue;
        }
        if file_modified_ms(entry.path()).is_some_and(|value| value < since_mtime_ms) {
            continue;
        }
        if transcript_files >= MAX_USAGE_TRANSCRIPT_FILES {
            safety_limit_reached = true;
            break;
        }
        let file_bytes = entry
            .metadata()
            .map(|metadata| metadata.len().min(MAX_TRANSCRIPT_BYTES_PER_FILE))
            .unwrap_or(0);
        if transcript_bytes.saturating_add(file_bytes) > MAX_USAGE_BYTES_PER_SOURCE {
            safety_limit_reached = true;
            break;
        }
        transcript_files += 1;
        transcript_bytes = transcript_bytes.saturating_add(file_bytes);
        live_paths.insert(entry.path().to_string_lossy().to_string());
        let Ok(file_records) = read_file_records(provider, entry.path(), cache) else {
            skipped_files = skipped_files.saturating_add(1);
            read_failed = true;
            continue;
        };
        *cache_dirty |= !file_records.cache_hit;
        malformed_records = malformed_records.saturating_add(file_records.malformed_records);
        if file_records.records.is_empty() {
            skipped_files = skipped_files.saturating_add(1);
            continue;
        }
        scanned_files = scanned_files.saturating_add(1);
        let remaining_records = MAX_USAGE_RECORDS_PER_SOURCE.saturating_sub(aggregated_records);
        let accepted_records = file_records.records.len().min(remaining_records);
        for record in file_records.records.iter().take(accepted_records) {
            aggregator.add(record);
        }
        aggregated_records = aggregated_records.saturating_add(accepted_records);
        if accepted_records < file_records.records.len() {
            safety_limit_reached = true;
            break;
        }
    }

    let partial = walk_failed || read_failed || safety_limit_reached || malformed_records > 0;
    let message = if safety_limit_reached {
        Some("Usage scan stopped at its safety limit; results are partial.".into())
    } else if walk_failed || read_failed {
        Some("Some transcript files could not be read.".into())
    } else if malformed_records > 0 {
        Some("Some transcript records could not be parsed.".into())
    } else {
        None
    };
    UsageSource {
        provider,
        status: if partial { "partial" } else { "ok" },
        resolved_path,
        scanned_files,
        skipped_files,
        malformed_records,
        distinct_sessions: 0,
        message,
    }
}

fn path_is_under(path: &str, root: &Path) -> bool {
    Path::new(path).starts_with(root)
}

fn prune_scan_cache(
    cache: &mut ScanCache,
    live_paths: &HashSet<String>,
    walked_roots: &[PathBuf],
    window_start_ms: u64,
    retention_cutoff_ms: u64,
) -> usize {
    let before = cache.len();
    cache.retain(|path, entry| {
        if entry.modified_ms < retention_cutoff_ms {
            return false;
        }
        let was_walked = walked_roots.iter().any(|root| path_is_under(path, root));
        let should_have_been_seen = entry.modified_ms >= window_start_ms;
        !was_walked || !should_have_been_seen || live_paths.contains(path)
    });
    before.saturating_sub(cache.len())
}

fn enforce_scan_cache_limits(cache: &mut ScanCache, max_files: usize, max_records: usize) -> usize {
    let before = cache.len();
    let mut entries = cache
        .iter()
        .map(|(path, entry)| (path.clone(), entry.modified_ms, entry.records.len()))
        .collect::<Vec<_>>();
    entries.sort_by(|left, right| right.1.cmp(&left.1).then_with(|| left.0.cmp(&right.0)));
    let mut retained = HashSet::new();
    let mut retained_records = 0_usize;
    for (path, _, records) in entries {
        let next_records = retained_records.saturating_add(records);
        if retained.len() >= max_files
            || records > MAX_TRANSCRIPT_RECORDS_PER_FILE
            || next_records > max_records
        {
            continue;
        }
        retained_records = next_records;
        retained.insert(path);
    }
    cache.retain(|path, _| retained.contains(path));
    before.saturating_sub(cache.len())
}

fn scan_usage(
    days: u16,
    resolution: Option<String>,
    since_time: Option<String>,
    until_time: Option<String>,
    rate_snapshot: RateSnapshot,
    cache_path: &Path,
) -> Result<UsageSummary, String> {
    if days == 0 || days > MAX_WINDOW_DAYS {
        return Err(format!(
            "Usage window must be between 1 and {MAX_WINDOW_DAYS} days."
        ));
    }
    let started = Instant::now();
    let resolution = match resolution.as_deref().unwrap_or("day") {
        "day" => UsageResolution::Day,
        "hour" => UsageResolution::Hour,
        other => return Err(format!("Unsupported usage resolution '{other}'.")),
    };
    let (since_day, until_day, exact_window) = match resolution {
        UsageResolution::Day => {
            let until_day = Local::now().date_naive();
            let since_day = until_day
                .checked_sub_days(Days::new(u64::from(days - 1)))
                .ok_or_else(|| "Could not calculate the usage window.".to_string())?;
            (since_day, until_day, None)
        }
        UsageResolution::Hour => {
            let parse_bound = |value: Option<String>, label: &str| {
                let value = value
                    .ok_or_else(|| format!("Hourly usage requires a valid {label} instant."))?;
                DateTime::parse_from_rfc3339(&value)
                    .map(|instant| instant.timestamp_millis())
                    .map_err(|_| format!("Hourly usage {label} is not a valid instant."))
            };
            let since_time_ms = parse_bound(since_time, "sinceTime")?;
            let until_time_ms = parse_bound(until_time, "untilTime")?;
            let (since_day, until_day) = hourly_window_days(since_time_ms, until_time_ms)?;
            (since_day, until_day, Some((since_time_ms, until_time_ms)))
        }
    };
    let window_start_ms = exact_window
        .map(|(since_time_ms, _)| since_time_ms)
        .unwrap_or_else(|| {
            since_day
                .and_hms_opt(0, 0, 0)
                .and_then(|value| {
                    Local
                        .from_local_datetime(&value)
                        .single()
                        .map(|value| value.timestamp_millis())
                })
                .unwrap_or(0)
        });
    let since_mtime_ms = window_start_ms
        .saturating_sub(MTIME_SLACK.as_millis() as i64)
        .max(0) as u128;
    let mut aggregator = match exact_window {
        Some((since_time_ms, until_time_ms)) => {
            UsageAggregator::hourly(since_time_ms, until_time_ms, &rate_snapshot.rates)?
        }
        None => UsageAggregator::new(since_day, until_day, &rate_snapshot.rates),
    };
    let cache_store = SCAN_CACHE.get_or_init(|| Mutex::new(None));
    let mut cache_guard = cache_store
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let cache = cache_guard.get_or_insert_with(|| load_scan_cache(cache_path));
    let mut cache_dirty = false;
    let paths = source_paths();
    let walked_roots = paths
        .iter()
        .filter_map(|(_, path)| path.is_dir().then_some(path.clone()))
        .collect::<Vec<_>>();
    let mut live_paths = HashSet::new();
    let mut sources: Vec<UsageSource> = paths
        .into_iter()
        .map(|(provider, path)| {
            scan_source(
                provider,
                &path,
                since_mtime_ms,
                &mut aggregator,
                cache,
                &mut cache_dirty,
                &mut live_paths,
            )
        })
        .collect();
    let buckets = aggregator.finish();
    for source in &mut sources {
        source.distinct_sessions = aggregator.distinct_sessions(source.provider) as u64;
    }
    let retention_cutoff_ms = Utc::now()
        .timestamp_millis()
        .saturating_sub(SCAN_CACHE_RETENTION.as_millis() as i64)
        .max(0) as u64;
    let window_start_ms = since_mtime_ms.min(u128::from(u64::MAX)) as u64;
    cache_dirty |= prune_scan_cache(
        cache,
        &live_paths,
        &walked_roots,
        window_start_ms,
        retention_cutoff_ms,
    ) > 0;
    cache_dirty |=
        enforce_scan_cache_limits(cache, MAX_SCAN_CACHE_FILES, MAX_SCAN_CACHE_RECORDS) > 0;
    if cache_dirty {
        let _ = save_scan_cache(cache_path, cache);
    }
    Ok(UsageSummary {
        read_at: Utc::now().to_rfc3339(),
        since_day: since_day.format("%Y-%m-%d").to_string(),
        until_day: until_day.format("%Y-%m-%d").to_string(),
        resolution,
        since_time: exact_window.and_then(|(value, _)| {
            DateTime::from_timestamp_millis(value)
                .map(|instant| instant.to_rfc3339_opts(chrono::SecondsFormat::Millis, true))
        }),
        until_time: exact_window.and_then(|(_, value)| {
            DateTime::from_timestamp_millis(value)
                .map(|instant| instant.to_rfc3339_opts(chrono::SecondsFormat::Millis, true))
        }),
        buckets,
        sources,
        pricing_status: rate_snapshot.status,
        pricing_source: LITELLM_RATES_URL,
        pricing_fetched_at: rate_snapshot
            .fetched_at_ms
            .and_then(DateTime::from_timestamp_millis)
            .map(|value| value.to_rfc3339()),
        known_models: rate_snapshot.rates.len(),
        scan_duration_ms: started.elapsed().as_millis().min(u128::from(u64::MAX)) as u64,
    })
}

#[tauri::command]
pub async fn usage_summary(
    app: AppHandle,
    days: u16,
    resolution: Option<String>,
    since_time: Option<String>,
    until_time: Option<String>,
) -> Result<UsageSummary, String> {
    let (cache_path, rates_cache_path) = usage_cache_paths(&app)?;
    let rates = load_rates(&rates_cache_path).await;
    tauri::async_runtime::spawn_blocking(move || {
        scan_usage(days, resolution, since_time, until_time, rates, &cache_path)
    })
    .await
    .map_err(|error| format!("Usage scan failed: {error}"))?
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::fs;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::sync::Mutex;

    static ENV_LOCK: Mutex<()> = Mutex::new(());
    static NEXT_TEMP_DIR: AtomicU64 = AtomicU64::new(1);

    fn local_timestamp_ms(day: NaiveDate) -> i64 {
        Local
            .from_local_datetime(&day.and_hms_opt(12, 0, 0).unwrap())
            .single()
            .unwrap()
            .timestamp_millis()
    }

    #[test]
    fn claude_records_dedupe_and_keep_cache_categories_disjoint() {
        let line = json!({
            "type": "assistant",
            "timestamp": "2026-08-08T12:00:00Z",
            "sessionId": "session-1",
            "requestId": "request-1",
            "costUSD": 0.25,
            "message": {
                "id": "message-1",
                "model": "claude-opus-4-1",
                "usage": {
                    "input_tokens": 10,
                    "cache_read_input_tokens": 20,
                    "cache_creation_input_tokens": 30,
                    "output_tokens": 40
                }
            }
        })
        .to_string();
        let first = parse_claude_line(&line).unwrap().unwrap();
        assert_eq!(first.totals.total(), 100);
        assert_eq!(first.dedupe_key.as_deref(), Some("message-1:request-1"));
        assert_eq!(first.reported_cost_usd, Some(0.25));
    }

    #[test]
    fn claude_ignores_synthetic_and_zero_usage_rows() {
        let synthetic = json!({
            "type": "assistant",
            "timestamp": "2026-08-08T12:00:00Z",
            "message": {
                "id": "synthetic-1",
                "model": "<synthetic>",
                "usage": { "output_tokens": 1 }
            }
        })
        .to_string();
        let zero = json!({
            "type": "assistant",
            "timestamp": "2026-08-08T12:00:00Z",
            "message": {
                "id": "zero-1",
                "model": "claude-test",
                "usage": {}
            }
        })
        .to_string();

        assert!(parse_claude_line(&synthetic).unwrap().is_none());
        assert!(parse_claude_line(&zero).unwrap().is_none());
    }

    #[test]
    fn codex_uses_last_usage_delta_and_drops_consecutive_duplicates() {
        let mut state = CodexScanState::default();
        let session = json!({"type":"session_meta","payload":{"id":"session-2"}}).to_string();
        let context = json!({"type":"turn_context","payload":{"model":"gpt-5.6"}}).to_string();
        let event = json!({
            "timestamp":"2026-08-08T12:00:00Z",
            "type":"event_msg",
            "payload":{"type":"token_count","info":{"last_token_usage":{
                "input_tokens":100,
                "cached_input_tokens":60,
                "output_tokens":20,
                "reasoning_output_tokens":5
            }}}
        })
        .to_string();
        assert!(parse_codex_line(&session, &mut state).unwrap().is_none());
        assert!(parse_codex_line(&context, &mut state).unwrap().is_none());
        let parsed = parse_codex_line(&event, &mut state).unwrap().unwrap();
        assert_eq!(parsed.session_id, "session-2");
        assert_eq!(parsed.totals.uncached_input_tokens, 40);
        assert_eq!(parsed.totals.cached_input_tokens, 60);
        assert_eq!(parsed.totals.output_tokens, 20);
        assert_eq!(parsed.totals.reasoning_tokens, 5);
        assert!(parse_codex_line(&event, &mut state).unwrap().is_none());
    }

    #[test]
    fn codex_counts_identical_usage_in_separate_turns() {
        let mut state = CodexScanState::default();
        let context = json!({"type":"turn_context","payload":{"model":"gpt-5.6"}}).to_string();
        let event = json!({
            "timestamp":"2026-08-08T12:00:00Z",
            "type":"event_msg",
            "payload":{"type":"token_count","info":{"last_token_usage":{
                "input_tokens":100,
                "cached_input_tokens":60,
                "output_tokens":20,
                "reasoning_output_tokens":5
            }}}
        })
        .to_string();

        assert!(parse_codex_line(&context, &mut state).unwrap().is_none());
        assert!(parse_codex_line(&event, &mut state).unwrap().is_some());
        assert!(parse_codex_line(&context, &mut state).unwrap().is_none());
        assert!(parse_codex_line(&event, &mut state).unwrap().is_some());
    }

    #[test]
    fn pricing_uses_cache_rate_and_does_not_double_charge_reasoning() {
        let mut rates = RateTable::new();
        rates.insert(
            "gpt-5.6".into(),
            ModelRate {
                input: 0.01,
                output: 0.02,
                cache_read: 0.001,
                cache_creation: 0.01,
            },
        );
        let totals = UsageTokenTotals {
            uncached_input_tokens: 10,
            cached_input_tokens: 20,
            cache_creation_tokens: 0,
            output_tokens: 30,
            reasoning_tokens: 25,
        };
        let priced = price_usage(&rates, "openai/gpt-5.6", totals, None);
        assert_eq!(priced.source, "modelPriced");
        assert!((priced.cost_usd - 0.72).abs() < f64::EPSILON);
        assert!((cache_savings_usd(&rates, "gpt-5.6", totals) - 0.18).abs() < f64::EPSILON);
    }

    #[test]
    fn rate_table_requires_complete_input_and_output_pricing() {
        let rates = parse_rate_table(&json!({
            "openai/gpt-5.6": {
                "input_cost_per_token": 0.01,
                "output_cost_per_token": 0.02,
                "cache_read_input_token_cost": 0.001
            },
            "broken": { "input_cost_per_token": 0.01 }
        }));
        assert_eq!(rates.len(), 1);
        assert!(rates.contains_key("gpt-5.6"));
    }

    #[test]
    fn canonical_rate_wins_over_namespaced_aliases() {
        let rates = parse_rate_table(&json!({
            "replicate/openai/gpt-5": {
                "input_cost_per_token": 0.01,
                "output_cost_per_token": 0.02
            },
            "gpt-5": {
                "input_cost_per_token": 0.001,
                "output_cost_per_token": 0.002,
                "cache_read_input_token_cost": 0.0001
            }
        }));
        let priced = price_usage(
            &rates,
            "openai/gpt-5",
            UsageTokenTotals {
                cached_input_tokens: 1,
                ..UsageTokenTotals::default()
            },
            None,
        );

        assert!((priced.cost_usd - 0.0001).abs() < f64::EPSILON);
    }

    #[test]
    fn durable_rate_cache_restores_the_litellm_document() {
        let root = std::env::temp_dir().join(format!(
            "grokapp-usage-rates-{}-{}",
            std::process::id(),
            NEXT_TEMP_DIR.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(&root).unwrap();
        let path = root.join(RATE_CACHE_FILE);
        let document = json!({
            "openai/gpt-fixture": {
                "input_cost_per_token": 0.01,
                "output_cost_per_token": 0.02
            }
        });

        save_rate_cache(&path, 1234, document).unwrap();
        let restored = load_rate_cache(&path).unwrap();
        let _ = fs::remove_dir_all(&root);

        assert_eq!(restored.fetched_at_ms, 1234);
        assert_eq!(restored.status, "cached");
        assert!(restored.rates.contains_key("gpt-fixture"));
    }

    #[test]
    fn source_paths_follow_provider_home_overrides() {
        let _guard = ENV_LOCK.lock().unwrap();
        let old_codex = std::env::var_os("CODEX_HOME");
        let old_claude = std::env::var_os("CLAUDE_CONFIG_DIR");
        std::env::set_var("CODEX_HOME", "C:/codex-home");
        std::env::set_var("CLAUDE_CONFIG_DIR", "C:/claude-home");
        let paths = source_paths();
        if let Some(value) = old_codex {
            std::env::set_var("CODEX_HOME", value);
        } else {
            std::env::remove_var("CODEX_HOME");
        }
        if let Some(value) = old_claude {
            std::env::set_var("CLAUDE_CONFIG_DIR", value);
        } else {
            std::env::remove_var("CLAUDE_CONFIG_DIR");
        }
        assert_eq!(paths[0].0, UsageProvider::Claude);
        assert!(paths[0].1.ends_with("claude-home/projects"));
        assert_eq!(paths[1].0, UsageProvider::Codex);
        assert!(paths[1].1.ends_with("codex-home/sessions"));
    }

    #[test]
    fn scanner_reads_a_codex_transcript_end_to_end() {
        let root = std::env::temp_dir().join(format!(
            "grokapp-usage-{}-{}",
            std::process::id(),
            NEXT_TEMP_DIR.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(&root).unwrap();
        let timestamp = Utc::now().to_rfc3339();
        let transcript = [
            json!({"type":"session_meta","payload":{"id":"fixture-session"}}).to_string(),
            json!({"type":"turn_context","payload":{"model":"gpt-fixture"}}).to_string(),
            json!({
                "timestamp":timestamp,
                "type":"event_msg",
                "payload":{"type":"token_count","info":{"last_token_usage":{
                    "input_tokens":50,
                    "cached_input_tokens":20,
                    "output_tokens":10
                }}}
            })
            .to_string(),
        ]
        .join("\n");
        fs::write(root.join("rollout.jsonl"), transcript).unwrap();

        let today = Local::now().date_naive();
        let rates = RateTable::new();
        let mut aggregator = UsageAggregator::new(today, today, &rates);
        let mut cache = ScanCache::default();
        let mut cache_dirty = false;
        let mut live_paths = HashSet::new();
        let source = scan_source(
            UsageProvider::Codex,
            &root,
            0,
            &mut aggregator,
            &mut cache,
            &mut cache_dirty,
            &mut live_paths,
        );
        let buckets = aggregator.finish();
        let _ = fs::remove_dir_all(&root);

        assert_eq!(source.status, "ok");
        assert_eq!(source.scanned_files, 1);
        assert_eq!(aggregator.distinct_sessions(UsageProvider::Codex), 1);
        assert_eq!(buckets.len(), 1);
        assert_eq!(buckets[0].totals.uncached_input_tokens, 30);
        assert_eq!(buckets[0].totals.cached_input_tokens, 20);
        assert_eq!(buckets[0].totals.output_tokens, 10);
    }

    #[test]
    fn scanner_marks_malformed_usage_records_as_partial() {
        let root = std::env::temp_dir().join(format!(
            "grokapp-usage-malformed-{}-{}",
            std::process::id(),
            NEXT_TEMP_DIR.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join("broken.jsonl"), "{\"usage\":").unwrap();

        let today = Local::now().date_naive();
        let rates = RateTable::new();
        let mut aggregator = UsageAggregator::new(today, today, &rates);
        let mut cache = ScanCache::default();
        let mut cache_dirty = false;
        let mut live_paths = HashSet::new();
        let source = scan_source(
            UsageProvider::Claude,
            &root,
            0,
            &mut aggregator,
            &mut cache,
            &mut cache_dirty,
            &mut live_paths,
        );
        let _ = fs::remove_dir_all(&root);

        assert_eq!(source.status, "partial");
        assert_eq!(source.malformed_records, 1);
    }

    #[test]
    fn transcript_parser_skips_an_oversized_line_and_salvages_later_usage() {
        let root = std::env::temp_dir().join(format!(
            "grokapp-usage-line-limit-{}-{}",
            std::process::id(),
            NEXT_TEMP_DIR.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(&root).unwrap();
        let path = root.join("rollout.jsonl");
        let mut transcript = vec![b'x'; 1_025];
        transcript.push(b'\n');
        for line in [
            json!({"type":"session_meta","payload":{"id":"fixture-session"}}).to_string(),
            json!({"type":"turn_context","payload":{"model":"gpt-fixture"}}).to_string(),
            json!({
                "timestamp":Utc::now().to_rfc3339(),
                "type":"event_msg",
                "payload":{"type":"token_count","info":{"last_token_usage":{
                    "input_tokens":50,
                    "cached_input_tokens":20,
                    "output_tokens":10
                }}}
            })
            .to_string(),
        ] {
            transcript.extend_from_slice(line.as_bytes());
            transcript.push(b'\n');
        }
        fs::write(&path, transcript).unwrap();

        let parsed = parse_transcript_records_with_limits(
            UsageProvider::Codex,
            &path,
            TranscriptLimits {
                max_bytes: 16 * 1024,
                max_line_bytes: 1_024,
                max_records: 10,
            },
        )
        .unwrap();
        let _ = fs::remove_dir_all(&root);

        assert_eq!(parsed.0.len(), 1);
        assert_eq!(parsed.1, 1);
    }

    #[test]
    fn transcript_parser_stops_at_its_record_budget() {
        let root = std::env::temp_dir().join(format!(
            "grokapp-usage-record-limit-{}-{}",
            std::process::id(),
            NEXT_TEMP_DIR.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(&root).unwrap();
        let path = root.join("rollout.jsonl");
        let event = || {
            json!({
                "timestamp":Utc::now().to_rfc3339(),
                "type":"event_msg",
                "payload":{"type":"token_count","info":{"last_token_usage":{
                    "input_tokens":50,
                    "cached_input_tokens":20,
                    "output_tokens":10
                }}}
            })
            .to_string()
        };
        fs::write(
            &path,
            [
                json!({"type":"session_meta","payload":{"id":"fixture-session"}}).to_string(),
                json!({"type":"turn_context","payload":{"model":"gpt-fixture"}}).to_string(),
                event(),
                json!({"type":"turn_context","payload":{"model":"gpt-fixture"}}).to_string(),
                event(),
            ]
            .join("\n"),
        )
        .unwrap();

        let parsed = parse_transcript_records_with_limits(
            UsageProvider::Codex,
            &path,
            TranscriptLimits {
                max_bytes: 16 * 1024,
                max_line_bytes: 1_024,
                max_records: 1,
            },
        )
        .unwrap();
        let _ = fs::remove_dir_all(&root);

        assert_eq!(parsed.0.len(), 1);
        assert_eq!(parsed.1, 1);
    }

    #[test]
    fn claude_duplicate_selection_is_order_independent_and_keeps_one_whole_record() {
        let preliminary = UsageRecord {
            provider: UsageProvider::Claude,
            timestamp_ms: 1,
            model: "claude-test".into(),
            session_id: "session".into(),
            totals: UsageTokenTotals {
                uncached_input_tokens: 100,
                ..UsageTokenTotals::default()
            },
            reported_cost_usd: None,
            dedupe_key: Some("message:request".into()),
        };
        let final_record = UsageRecord {
            timestamp_ms: 2,
            totals: UsageTokenTotals {
                uncached_input_tokens: 1,
                cached_input_tokens: 20,
                output_tokens: 5,
                ..UsageTokenTotals::default()
            },
            reported_cost_usd: Some(0.25),
            ..preliminary.clone()
        };

        for records in [
            vec![preliminary.clone(), final_record.clone()],
            vec![final_record.clone(), preliminary.clone()],
        ] {
            let kept = dedupe_within_file(records);
            assert_eq!(kept.len(), 1);
            assert_eq!(kept[0].totals.uncached_input_tokens, 1);
            assert_eq!(kept[0].totals.cached_input_tokens, 20);
            assert_eq!(kept[0].totals.output_tokens, 5);
            assert_eq!(kept[0].reported_cost_usd, Some(0.25));
        }
    }

    #[test]
    fn global_dedupe_prefers_in_window_final_record() {
        let today = Local::now().date_naive();
        let outside_timestamp = local_timestamp_ms(today.checked_sub_days(Days::new(1)).unwrap());
        let inside_timestamp = local_timestamp_ms(today);
        let preliminary = UsageRecord {
            provider: UsageProvider::Claude,
            timestamp_ms: outside_timestamp,
            model: "claude-test".into(),
            session_id: "session".into(),
            totals: UsageTokenTotals {
                output_tokens: 1,
                ..UsageTokenTotals::default()
            },
            reported_cost_usd: None,
            dedupe_key: Some("message:request".into()),
        };
        let final_record = UsageRecord {
            timestamp_ms: inside_timestamp,
            totals: UsageTokenTotals {
                output_tokens: 9,
                ..UsageTokenTotals::default()
            },
            ..preliminary.clone()
        };
        let rates = RateTable::new();
        let mut aggregator = UsageAggregator::new(today, today, &rates);
        aggregator.add(&preliminary);
        aggregator.add(&final_record);
        let buckets = aggregator.finish();

        assert_eq!(buckets.len(), 1);
        assert_eq!(buckets[0].records, 1);
        assert_eq!(buckets[0].totals.output_tokens, 9);
    }

    #[test]
    fn hourly_usage_uses_exact_rolling_bounds_and_fixed_bucket_starts() {
        let since_ms = DateTime::parse_from_rfc3339("2026-08-11T17:42:00.000Z")
            .unwrap()
            .timestamp_millis();
        let until_ms = DateTime::parse_from_rfc3339("2026-08-12T17:42:00.000Z")
            .unwrap()
            .timestamp_millis();
        let record = |timestamp: &str, key: &str| UsageRecord {
            provider: UsageProvider::Codex,
            timestamp_ms: DateTime::parse_from_rfc3339(timestamp)
                .unwrap()
                .timestamp_millis(),
            model: "gpt-test".into(),
            session_id: key.into(),
            totals: UsageTokenTotals {
                output_tokens: 1,
                ..UsageTokenTotals::default()
            },
            reported_cost_usd: None,
            dedupe_key: Some(key.into()),
        };
        let rates = RateTable::new();
        let mut aggregator = UsageAggregator::hourly(since_ms, until_ms, &rates).unwrap();
        aggregator.add(&record("2026-08-11T17:41:59.999Z", "before"));
        aggregator.add(&record("2026-08-11T17:42:00.000Z", "start"));
        aggregator.add(&record("2026-08-12T16:44:00.000Z", "last"));
        aggregator.add(&record("2026-08-12T17:42:00.000Z", "after"));

        let buckets = aggregator.finish();

        assert_eq!(buckets.len(), 2);
        assert_eq!(
            buckets[0].hour_start.as_deref(),
            Some("2026-08-11T17:42:00.000Z")
        );
        assert_eq!(
            buckets[1].hour_start.as_deref(),
            Some("2026-08-12T16:42:00.000Z")
        );
        assert_eq!(aggregator.distinct_sessions(UsageProvider::Codex), 2);
    }

    #[test]
    fn mixed_pricing_bucket_exposes_exact_source_counts() {
        let today = Local::now().date_naive();
        let timestamp_ms = local_timestamp_ms(today);
        let mut rates = RateTable::new();
        rates.insert(
            "claude-test".into(),
            ModelRate {
                input: 0.01,
                output: 0.02,
                cache_read: 0.001,
                cache_creation: 0.01,
            },
        );
        let record = |key: &str, cost: Option<f64>, model: &str| UsageRecord {
            provider: UsageProvider::Claude,
            timestamp_ms,
            model: model.into(),
            session_id: "session".into(),
            totals: UsageTokenTotals {
                output_tokens: 1,
                ..UsageTokenTotals::default()
            },
            reported_cost_usd: cost,
            dedupe_key: Some(key.into()),
        };
        let mut aggregator = UsageAggregator::new(today, today, &rates);
        aggregator.add(&record("reported", Some(0.25), "claude-test"));
        aggregator.add(&record("model", None, "claude-test"));
        aggregator.add(&record("unknown", None, "unknown-model"));
        let buckets = aggregator.finish();

        let priced = buckets
            .iter()
            .find(|bucket| bucket.model == "claude-test")
            .unwrap();
        assert_eq!(priced.records, 2);
        assert_eq!(priced.provider_reported_records, 1);
        assert_eq!(priced.model_priced_records, 1);
        assert_eq!(priced.unpriced_records, 0);
        assert_eq!(priced.cost_source, "mixed");
        let unpriced = buckets
            .iter()
            .find(|bucket| bucket.model == "unknown-model")
            .unwrap();
        assert_eq!(unpriced.unpriced_records, 1);
    }

    #[test]
    fn stale_rate_snapshot_downgrades_retained_fresh_cache() {
        let mut cached = Some(RateCache {
            rates: HashMap::new(),
            fetched_at_ms: 1234,
            status: "fresh",
        });
        let snapshot = stale_rate_snapshot(&mut cached);

        assert_eq!(snapshot.status, "cached");
        assert_eq!(snapshot.fetched_at_ms, Some(1234));
        assert_eq!(cached.as_ref().unwrap().status, "cached");
    }

    #[test]
    fn old_scan_cache_version_is_rejected() {
        let root = std::env::temp_dir().join(format!(
            "grokapp-usage-old-cache-{}-{}",
            std::process::id(),
            NEXT_TEMP_DIR.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(&root).unwrap();
        let path = root.join(SCAN_CACHE_FILE);
        fs::write(&path, r#"{"version":1,"files":{}}"#).unwrap();

        assert!(load_scan_cache(&path).is_empty());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn oversized_scan_cache_is_rejected_before_reading_it() {
        let root = std::env::temp_dir().join(format!(
            "grokapp-usage-large-cache-{}-{}",
            std::process::id(),
            NEXT_TEMP_DIR.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(&root).unwrap();
        let path = root.join(SCAN_CACHE_FILE);
        let file = File::create(&path).unwrap();
        file.set_len(MAX_SCAN_CACHE_BYTES as u64 + 1).unwrap();
        drop(file);

        assert!(load_scan_cache(&path).is_empty());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn scan_cache_prunes_deleted_in_window_files_but_keeps_unwalked_roots() {
        let walked = PathBuf::from("C:/usage/claude");
        let deleted = walked.join("deleted.jsonl").to_string_lossy().to_string();
        let unwalked = "C:/usage/codex/kept.jsonl".to_string();
        let entry = |modified_ms| CachedTranscript {
            size: 1,
            modified_ms,
            provider: UsageProvider::Claude,
            malformed_records: 0,
            records: Vec::new(),
        };
        let mut cache = HashMap::from([
            (deleted.clone(), entry(5_000)),
            (unwalked.clone(), entry(5_000)),
        ]);

        let removed = prune_scan_cache(&mut cache, &HashSet::new(), &[walked], 4_000, 1_000);

        assert_eq!(removed, 1);
        assert!(!cache.contains_key(&deleted));
        assert!(cache.contains_key(&unwalked));
    }

    #[test]
    fn scan_cache_limits_keep_the_newest_complete_entries() {
        let entry = |modified_ms| CachedTranscript {
            size: 1,
            modified_ms,
            provider: UsageProvider::Claude,
            malformed_records: 0,
            records: vec![UsageRecord {
                provider: UsageProvider::Claude,
                timestamp_ms: 1,
                model: "test".into(),
                session_id: format!("session-{modified_ms}"),
                totals: UsageTokenTotals::default(),
                reported_cost_usd: None,
                dedupe_key: None,
            }],
        };
        let mut cache = HashMap::from([
            ("old".into(), entry(1)),
            ("middle".into(), entry(2)),
            ("new".into(), entry(3)),
        ]);

        let removed = enforce_scan_cache_limits(&mut cache, 2, 2);

        assert_eq!(removed, 1);
        assert!(!cache.contains_key("old"));
        assert!(cache.contains_key("middle"));
        assert!(cache.contains_key("new"));
    }

    #[test]
    fn durable_scan_cache_reuses_an_unchanged_transcript() {
        let root = std::env::temp_dir().join(format!(
            "grokapp-usage-cache-{}-{}",
            std::process::id(),
            NEXT_TEMP_DIR.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(&root).unwrap();
        let transcript_path = root.join("rollout.jsonl");
        let cache_path = root.join("usage-scan-cache.json");
        let transcript = [
            json!({"type":"session_meta","payload":{"id":"fixture-session"}}).to_string(),
            json!({"type":"turn_context","payload":{"model":"gpt-fixture"}}).to_string(),
            json!({
                "timestamp":Utc::now().to_rfc3339(),
                "type":"event_msg",
                "payload":{"type":"token_count","info":{"last_token_usage":{
                    "input_tokens":50,
                    "cached_input_tokens":20,
                    "output_tokens":10
                }}}
            })
            .to_string(),
        ]
        .join("\n");
        fs::write(&transcript_path, transcript).unwrap();

        let mut cache = ScanCache::default();
        let first = read_file_records(UsageProvider::Codex, &transcript_path, &mut cache).unwrap();
        assert!(!first.cache_hit);
        assert_eq!(first.records.len(), 1);
        save_scan_cache(&cache_path, &cache).unwrap();

        let mut reloaded = load_scan_cache(&cache_path);
        let second =
            read_file_records(UsageProvider::Codex, &transcript_path, &mut reloaded).unwrap();
        let _ = fs::remove_dir_all(&root);

        assert!(second.cache_hit);
        assert_eq!(second.records.len(), 1);
    }
}
