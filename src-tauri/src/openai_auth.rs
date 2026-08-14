//! OpenAI / ChatGPT OAuth — native device-code flow (no Codex CLI).
//!
//! Mirrors the official Codex login dance against `auth.openai.com`:
//! request a device user code, poll for the authorization code, exchange it
//! with PKCE, then keep the session fresh with refresh tokens. Tokens stay in
//! this app's own data directory.

use crate::auth::{
    begin_login_attempt, cancel_login_before_commit, commit_login_if_active, finish_login_attempt,
    DeviceCodeEvent,
};
use base64::Engine;
use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, State};

const CLIENT_ID: &str = "app_EMoamEEZ73f0CkXaXp7hrann";
const ISSUER: &str = "https://auth.openai.com";
const CODEX_USAGE_URL: &str = "https://chatgpt.com/backend-api/wham/usage";
const REFRESH_SKEW_SECS: u64 = 5 * 60;
const DEFAULT_TOKEN_LIFETIME_SECS: u64 = 3600;
const DEVICE_LOGIN_TIMEOUT: Duration = Duration::from_secs(15 * 60);
/// Default when the token endpoint response carries no interval.
const DEFAULT_POLL_INTERVAL_SECS: u64 = 5;
const SESSION_SLOT: &str = "openai-auth";
const LEGACY_SESSION_FILE: &str = "openai-auth.json";

pub struct OpenAIAuthState {
    pub login_in_progress: AtomicBool,
    pub login_cancellable: AtomicBool,
    pub login_cancel: AtomicBool,
    pub login_commit_lock: Mutex<()>,
    /// Held across the full refresh HTTP + disk write (single-flight).
    pub refresh_lock: tokio::sync::Mutex<()>,
}

impl OpenAIAuthState {
    pub fn new() -> Self {
        Self {
            login_in_progress: AtomicBool::new(false),
            login_cancellable: AtomicBool::new(false),
            login_cancel: AtomicBool::new(false),
            login_commit_lock: Mutex::new(()),
            refresh_lock: tokio::sync::Mutex::new(()),
        }
    }
}

impl Default for OpenAIAuthState {
    fn default() -> Self {
        Self::new()
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenAISession {
    pub id_token: String,
    pub access_token: String,
    pub refresh_token: String,
    /// unix ms when the access token should be treated as expired (skew-adjusted)
    pub expires_at: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub email: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub plan: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub account_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenAIAuthStatus {
    pub signed_in: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub email: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub plan: Option<String>,
    pub login_in_progress: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CodexUsageStatus {
    pub primary: Option<CodexUsageWindow>,
    pub secondary: Option<CodexUsageWindow>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CodexUsageWindow {
    pub used_percent: f64,
    pub window_minutes: Option<u64>,
    pub resets_at: Option<u64>,
}

#[derive(Debug, Deserialize)]
struct CodexUsagePayload {
    #[serde(default)]
    rate_limit: Option<CodexRateLimit>,
}

#[derive(Debug, Deserialize)]
struct CodexRateLimit {
    #[serde(default)]
    primary_window: Option<CodexUsageWindowPayload>,
    #[serde(default)]
    secondary_window: Option<CodexUsageWindowPayload>,
}

#[derive(Debug, Deserialize)]
struct CodexUsageWindowPayload {
    used_percent: f64,
    #[serde(default)]
    limit_window_seconds: Option<u64>,
    #[serde(default)]
    reset_at: Option<u64>,
}

impl From<CodexUsageWindowPayload> for CodexUsageWindow {
    fn from(value: CodexUsageWindowPayload) -> Self {
        Self {
            used_percent: value.used_percent.clamp(0.0, 100.0),
            window_minutes: value
                .limit_window_seconds
                .filter(|seconds| *seconds > 0)
                .map(|seconds| seconds.saturating_add(59) / 60),
            resets_at: value.reset_at.filter(|timestamp| *timestamp > 0),
        }
    }
}

#[derive(Debug, Deserialize)]
struct UserCodeResp {
    device_auth_id: String,
    #[serde(alias = "usercode")]
    user_code: String,
    #[serde(default, deserialize_with = "deserialize_interval")]
    interval: Option<u64>,
}

fn deserialize_interval<'de, D>(deserializer: D) -> Result<Option<u64>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    // The endpoint returns the interval as a JSON string.
    let value: Option<serde_json::Value> = Option::deserialize(deserializer)?;
    match value {
        None | Some(serde_json::Value::Null) => Ok(None),
        Some(serde_json::Value::String(s)) => s
            .trim()
            .parse::<u64>()
            .map(Some)
            .map_err(serde::de::Error::custom),
        Some(serde_json::Value::Number(n)) => Ok(n.as_u64()),
        Some(_) => Err(serde::de::Error::custom("unexpected interval")),
    }
}

#[derive(Debug, Deserialize)]
struct CodeSuccessResp {
    authorization_code: String,
    /// Registered server-side; the exchange only needs the verifier.
    #[serde(rename = "code_challenge")]
    _code_challenge: String,
    code_verifier: String,
}

#[derive(Debug, Deserialize)]
struct TokenResponse {
    #[serde(default)]
    id_token: Option<String>,
    access_token: String,
    refresh_token: String,
}

#[derive(Debug, Serialize)]
struct RefreshRequest {
    client_id: &'static str,
    grant_type: &'static str,
    refresh_token: String,
}

#[derive(Debug, PartialEq, Eq)]
enum RefreshFailure {
    InvalidSession,
    Temporary(String),
}

impl RefreshFailure {
    fn invalidates_session(&self) -> bool {
        matches!(self, Self::InvalidSession)
    }

    fn message(&self) -> &str {
        match self {
            Self::InvalidSession => "Your OpenAI session expired. Sign in again.",
            Self::Temporary(message) => message,
        }
    }
}

fn clear_session_if_invalid(
    failure: &RefreshFailure,
    clear: impl FnOnce() -> Result<(), String>,
) -> Result<bool, String> {
    if !failure.invalidates_session() {
        return Ok(false);
    }
    clear()?;
    Ok(true)
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn load_session(app: &AppHandle) -> Result<Option<OpenAISession>, String> {
    crate::secure_store::with_best_effort_cleanup(
        || crate::secure_store::load(app, SESSION_SLOT),
        || crate::secure_store::remove_legacy_plaintext(app, LEGACY_SESSION_FILE),
    )
}

fn save_session(app: &AppHandle, session: &OpenAISession) -> Result<(), String> {
    crate::secure_store::with_best_effort_cleanup(
        || crate::secure_store::save(app, SESSION_SLOT, session),
        || crate::secure_store::remove_legacy_plaintext(app, LEGACY_SESSION_FILE),
    )
}

fn clear_session(app: &AppHandle) -> Result<(), String> {
    crate::secure_store::with_best_effort_cleanup(
        || crate::secure_store::clear(app, SESSION_SLOT),
        || crate::secure_store::remove_legacy_plaintext(app, LEGACY_SESSION_FILE),
    )
}

async fn clear_session_for_logout(
    refresh_lock: &tokio::sync::Mutex<()>,
    load: impl FnOnce() -> Result<Option<OpenAISession>, String>,
    clear: impl FnOnce() -> Result<(), String>,
) -> Result<Option<OpenAISession>, String> {
    let _guard = refresh_lock.lock().await;
    let session = load().ok().flatten();
    clear()?;
    Ok(session)
}

async fn clear_session_if_current(
    refresh_lock: &tokio::sync::Mutex<()>,
    expected_access_token: &str,
    load: impl FnOnce() -> Result<Option<OpenAISession>, String>,
    clear: impl FnOnce() -> Result<(), String>,
) -> Result<bool, String> {
    let _guard = refresh_lock.lock().await;
    let Some(current) = load()? else {
        return Ok(false);
    };
    if current.access_token != expected_access_token {
        return Ok(false);
    }
    clear()?;
    Ok(true)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum CodexUsageFailure {
    InvalidSession,
    AccessDenied,
    Temporary,
}

fn classify_codex_usage_status(status: u16) -> CodexUsageFailure {
    match status {
        401 => CodexUsageFailure::InvalidSession,
        403 => CodexUsageFailure::AccessDenied,
        _ => CodexUsageFailure::Temporary,
    }
}

fn status_dto(session: Option<&OpenAISession>, login_in_progress: bool) -> OpenAIAuthStatus {
    match session {
        Some(s) => OpenAIAuthStatus {
            signed_in: true,
            email: s.email.clone(),
            plan: s.plan.clone(),
            login_in_progress,
        },
        None => OpenAIAuthStatus {
            signed_in: false,
            email: None,
            plan: None,
            login_in_progress,
        },
    }
}

fn decode_jwt_payload(token: &str) -> Option<serde_json::Value> {
    use base64::engine::general_purpose::URL_SAFE_NO_PAD;
    let payload = token.split('.').nth(1)?;
    let bytes = URL_SAFE_NO_PAD.decode(payload).ok()?;
    serde_json::from_slice(&bytes).ok()
}

fn jwt_exp_ms(token: &str) -> Option<u64> {
    let claims = decode_jwt_payload(token)?;
    let exp = claims.get("exp")?.as_i64().filter(|e| *e > 0)?;
    Some((exp as u64).saturating_mul(1000))
}

/// OpenAI id_token claims: email at top level or under
/// `https://api.openai.com/profile`; account/plan under
/// `https://api.openai.com/auth`.
fn parse_id_token_claims(id_token: &str) -> (Option<String>, Option<String>, Option<String>) {
    let Some(claims) = decode_jwt_payload(id_token) else {
        return (None, None, None);
    };
    let email = claims
        .get("email")
        .and_then(|v| v.as_str())
        .map(str::to_string)
        .or_else(|| {
            claims
                .get("https://api.openai.com/profile")
                .and_then(|p| p.get("email"))
                .and_then(|v| v.as_str())
                .map(str::to_string)
        });
    let auth = claims.get("https://api.openai.com/auth");
    let plan = auth
        .and_then(|a| a.get("chatgpt_plan_type"))
        .and_then(|v| v.as_str())
        .map(normalize_plan);
    let account_id = auth
        .and_then(|a| a.get("chatgpt_account_id"))
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .map(str::to_string);
    (email, plan, account_id)
}

fn normalize_plan(raw: &str) -> String {
    let compact = raw.trim().to_ascii_lowercase();
    match compact.as_str() {
        "plus" => return "Plus".into(),
        "pro" => return "Pro".into(),
        "free" => return "Free".into(),
        "business" => return "Business".into(),
        "enterprise" => return "Enterprise".into(),
        "edu" => return "Edu".into(),
        _ => {}
    }
    raw.split(['_', '-'])
        .filter(|p| !p.is_empty())
        .map(|p| {
            let mut c = p.chars();
            match c.next() {
                None => String::new(),
                Some(f) => f.to_uppercase().collect::<String>() + c.as_str(),
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

fn session_from_tokens(
    tokens: TokenResponse,
    id_token_fallback: Option<&str>,
) -> Result<OpenAISession, String> {
    let id_token = tokens
        .id_token
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| id_token_fallback.unwrap_or_default().to_string());
    if id_token.is_empty() {
        return Err("OpenAI sign-in returned no id token.".into());
    }
    let (email, plan, account_id) = parse_id_token_claims(&id_token);
    let expires_at = jwt_exp_ms(&tokens.access_token)
        .map(|exp| exp.saturating_sub(REFRESH_SKEW_SECS * 1000))
        .unwrap_or_else(|| now_ms() + (DEFAULT_TOKEN_LIFETIME_SECS - REFRESH_SKEW_SECS) * 1000);
    Ok(OpenAISession {
        id_token,
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token,
        expires_at,
        email,
        plan,
        account_id,
    })
}

fn oauth_http_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(30))
        .timeout(Duration::from_secs(60))
        .http1_only()
        .user_agent(concat!("GrokDesktop/", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|e| format!("http client: {e}"))
}

async fn post_json_raw(url: &str, body: &impl Serialize) -> Result<(u16, String), String> {
    let client = oauth_http_client()?;
    let resp = client
        .post(url)
        .header("Accept", "application/json")
        .json(body)
        .send()
        .await
        .map_err(|_| "Could not reach OpenAI sign-in.".to_string())?;
    let status = resp.status().as_u16();
    let body = resp
        .text()
        .await
        .map_err(|_| "OpenAI sign-in returned an invalid response.".to_string())?;
    Ok((status, body))
}

fn parse_device_code_response(status: u16, body: &str) -> Result<UserCodeResp, String> {
    if status == 404 {
        return Err("Device code sign-in is not available for OpenAI right now.".into());
    }
    if status >= 400 {
        return Err("OpenAI sign-in could not be started.".into());
    }
    serde_json::from_str(body)
        .map_err(|_| "OpenAI sign-in returned an invalid response.".to_string())
}

async fn request_device_code(cancel: &AtomicBool) -> Result<(String, String, u64), String> {
    if cancel.load(Ordering::SeqCst) {
        return Err("Login cancelled".into());
    }
    let url = format!("{ISSUER}/api/accounts/deviceauth/usercode");
    let (status, body) =
        post_json_raw(&url, &serde_json::json!({ "client_id": CLIENT_ID })).await?;
    crate::auth::ensure_login_active(cancel)?;
    let body = parse_device_code_response(status, &body)?;
    let interval = body
        .interval
        .filter(|v| *v > 0)
        .unwrap_or(DEFAULT_POLL_INTERVAL_SECS);
    Ok((body.device_auth_id, body.user_code, interval))
}

/// Parse a device poll response after checking its status. Pending responses do
/// not carry the success schema and must not be deserialized as one.
fn parse_device_poll_response(status: u16, body: &str) -> Result<Option<CodeSuccessResp>, String> {
    if matches!(status, 403 | 404) {
        return Ok(None);
    }
    if status >= 400 {
        return Err(format!(
            "OpenAI sign-in failed (status {status}). Try again."
        ));
    }
    serde_json::from_str(body)
        .map(Some)
        .map_err(|_| "OpenAI sign-in returned an invalid response.".to_string())
}

/// Poll until OpenAI hands back the authorization code (403/404 = pending).
async fn poll_device_code(
    device_auth_id: &str,
    user_code: &str,
    mut interval_secs: u64,
    cancel: &AtomicBool,
) -> Result<CodeSuccessResp, String> {
    let url = format!("{ISSUER}/api/accounts/deviceauth/token");
    let deadline = tokio::time::Instant::now() + DEVICE_LOGIN_TIMEOUT;

    loop {
        if cancel.load(Ordering::SeqCst) {
            return Err("Login cancelled".into());
        }
        if tokio::time::Instant::now() >= deadline {
            return Err("OpenAI sign-in timed out.".into());
        }
        tokio::time::sleep(Duration::from_secs(interval_secs)).await;
        if cancel.load(Ordering::SeqCst) {
            return Err("Login cancelled".into());
        }

        let payload = serde_json::json!({
            "device_auth_id": device_auth_id,
            "user_code": user_code,
        });
        let result = post_json_raw(&url, &payload).await;
        crate::auth::ensure_login_active(cancel)?;
        match result {
            Ok((status, body)) => match parse_device_poll_response(status, &body)? {
                Some(code) => return Ok(code),
                None => continue,
            },
            Err(_) => {
                // Transient network hiccup — keep polling until deadline.
                interval_secs = interval_secs.saturating_add(1).min(15);
                continue;
            }
        }
    }
}

async fn exchange_code_for_tokens(code: &CodeSuccessResp) -> Result<TokenResponse, String> {
    let client = oauth_http_client()?;
    let redirect_uri = format!("{ISSUER}/deviceauth/callback");
    let resp = client
        .post(format!("{ISSUER}/oauth/token"))
        .header("Content-Type", "application/x-www-form-urlencoded")
        .body(format!(
            "grant_type=authorization_code&code={}&redirect_uri={}&client_id={}&code_verifier={}",
            urlencoding_encode(&code.authorization_code),
            urlencoding_encode(&redirect_uri),
            urlencoding_encode(CLIENT_ID),
            urlencoding_encode(&code.code_verifier),
        ))
        .send()
        .await
        .map_err(|_| "Could not reach OpenAI sign-in.".to_string())?;
    let status = resp.status().as_u16();
    let body = resp
        .text()
        .await
        .map_err(|_| "OpenAI sign-in returned an invalid response.".to_string())?;
    parse_token_exchange_response(status, &body)
}

fn parse_token_exchange_response(status: u16, body: &str) -> Result<TokenResponse, String> {
    if status >= 400 {
        return Err("OpenAI sign-in could not be completed.".into());
    }
    serde_json::from_str(body)
        .map_err(|_| "OpenAI sign-in returned an invalid response.".to_string())
}

/// Minimal percent-encoding for application/x-www-form-urlencoded bodies.
fn urlencoding_encode(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for byte in value.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(byte as char)
            }
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}

fn parse_refresh_response(status: u16, body: &str) -> Result<TokenResponse, RefreshFailure> {
    if status == 429 || status >= 500 {
        return Err(RefreshFailure::Temporary(
            "Could not refresh your OpenAI session right now.".into(),
        ));
    }
    if status >= 400 {
        let error = serde_json::from_str::<serde_json::Value>(body)
            .ok()
            .and_then(|value| value.get("error")?.as_str().map(str::to_string));
        return Err(if error.as_deref() == Some("invalid_grant") {
            RefreshFailure::InvalidSession
        } else {
            RefreshFailure::Temporary("Could not refresh your OpenAI session right now.".into())
        });
    }
    serde_json::from_str(body).map_err(|_| {
        RefreshFailure::Temporary("OpenAI returned an invalid refresh response.".into())
    })
}

async fn refresh_access(refresh_token: &str) -> Result<TokenResponse, RefreshFailure> {
    let (status, body) = post_json_raw(
        &format!("{ISSUER}/oauth/token"),
        &RefreshRequest {
            client_id: CLIENT_ID,
            grant_type: "refresh_token",
            refresh_token: refresh_token.to_string(),
        },
    )
    .await
    .map_err(RefreshFailure::Temporary)?;
    parse_refresh_response(status, &body)
}

async fn ensure_fresh(app: &AppHandle, auth: &OpenAIAuthState) -> Result<OpenAISession, String> {
    let Some(session) = load_session(app)? else {
        return Err("Not signed in to OpenAI".into());
    };
    if session.expires_at > now_ms() {
        return Ok(session);
    }

    // Single-flight: hold the lock across HTTP refresh + disk write.
    let _guard = auth.refresh_lock.lock().await;

    let session = load_session(app)?.ok_or_else(|| "Not signed in to OpenAI".to_string())?;
    if session.expires_at > now_ms() {
        return Ok(session);
    }

    match refresh_access(&session.refresh_token).await {
        Ok(tokens) => {
            let mut next = session_from_tokens(tokens, Some(&session.id_token))?;
            if next.email.is_none() {
                next.email = session.email.clone();
            }
            if next.plan.is_none() {
                next.plan = session.plan.clone();
            }
            if next.account_id.is_none() {
                next.account_id = session.account_id.clone();
            }
            save_session(app, &next)?;
            Ok(next)
        }
        Err(e) => {
            if clear_session_if_invalid(&e, || clear_session(app))? {
                let status = status_dto(None, auth.login_in_progress.load(Ordering::SeqCst));
                let _ = app.emit("openai-auth://status", &status);
            }
            Err(e.message().to_string())
        }
    }
}

pub async fn get_openai_access_token(
    app: &AppHandle,
    auth: &OpenAIAuthState,
) -> Result<String, String> {
    Ok(ensure_fresh(app, auth).await?.access_token)
}

/// Account id for the `chatgpt-account-id` request header, when known.
pub async fn get_openai_account_id(app: &AppHandle, auth: &OpenAIAuthState) -> Option<String> {
    ensure_fresh(app, auth).await.ok()?.account_id
}

fn validate_verification_uri(raw: &str) -> Result<String, String> {
    let url = url::Url::parse(raw).map_err(|_| "Untrusted verification URI".to_string())?;
    if url.scheme() != "https" {
        return Err("Untrusted verification URI".into());
    }
    let host = url.host_str().unwrap_or("");
    if host != "openai.com"
        && !host.ends_with(".openai.com")
        && host != "chatgpt.com"
        && !host.ends_with(".chatgpt.com")
    {
        return Err("Untrusted verification host".into());
    }
    Ok(url.into())
}

#[tauri::command]
pub async fn openai_auth_status(
    app: AppHandle,
    state: State<'_, OpenAIAuthState>,
) -> Result<OpenAIAuthStatus, String> {
    let login_in_progress = state.login_in_progress.load(Ordering::SeqCst);
    let session = load_session(&app)?;
    Ok(status_dto(session.as_ref(), login_in_progress))
}

#[tauri::command]
pub async fn openai_codex_usage(
    app: AppHandle,
    state: State<'_, OpenAIAuthState>,
) -> Result<CodexUsageStatus, String> {
    let session = ensure_fresh(&app, &state).await?;
    let client = oauth_http_client()?;
    let mut request = client
        .get(CODEX_USAGE_URL)
        .bearer_auth(&session.access_token)
        .header("Accept", "application/json")
        .header("Cache-Control", "no-cache, no-store");
    if let Some(account_id) = session.account_id.as_deref() {
        request = request.header("ChatGPT-Account-ID", account_id);
    }
    let response = request
        .send()
        .await
        .map_err(|_| "Could not load Codex usage right now.".to_string())?;
    if !response.status().is_success() {
        return Err(
            match classify_codex_usage_status(response.status().as_u16()) {
                CodexUsageFailure::InvalidSession => {
                    if clear_session_if_current(
                        &state.refresh_lock,
                        &session.access_token,
                        || load_session(&app),
                        || clear_session(&app),
                    )
                    .await?
                    {
                        let status =
                            status_dto(None, state.login_in_progress.load(Ordering::SeqCst));
                        let _ = app.emit("openai-auth://status", &status);
                    }
                    "Your OpenAI session expired. Sign in again.".into()
                }
                CodexUsageFailure::AccessDenied => {
                    "OpenAI denied access to Codex usage data for this account.".into()
                }
                CodexUsageFailure::Temporary => "Could not load Codex usage right now.".into(),
            },
        );
    }
    let payload: CodexUsagePayload = response
        .json()
        .await
        .map_err(|_| "OpenAI returned invalid Codex usage data.".to_string())?;
    let Some(rate_limit) = payload.rate_limit else {
        return Ok(CodexUsageStatus {
            primary: None,
            secondary: None,
        });
    };
    Ok(CodexUsageStatus {
        primary: rate_limit.primary_window.map(CodexUsageWindow::from),
        secondary: rate_limit.secondary_window.map(CodexUsageWindow::from),
    })
}

#[tauri::command]
pub async fn openai_auth_login(
    app: AppHandle,
    state: State<'_, OpenAIAuthState>,
) -> Result<OpenAIAuthStatus, String> {
    begin_login_attempt(
        &state.login_in_progress,
        &state.login_cancellable,
        &state.login_cancel,
        &state.login_commit_lock,
        "OpenAI login already in progress",
    )?;

    let result = async {
        let (device_auth_id, user_code, interval) =
            request_device_code(&state.login_cancel).await?;
        let verification_uri = validate_verification_uri(&format!("{ISSUER}/codex/device"))?;
        let _ = app.emit(
            "openai-auth://device-code",
            DeviceCodeEvent {
                user_code: user_code.clone(),
                verification_uri: verification_uri.clone(),
                expires_in_seconds: DEVICE_LOGIN_TIMEOUT.as_secs(),
                interval_seconds: interval,
            },
        );
        let _ = tauri_plugin_opener::open_url(&verification_uri, None::<&str>);

        let code =
            poll_device_code(&device_auth_id, &user_code, interval, &state.login_cancel).await?;
        crate::auth::ensure_login_active(&state.login_cancel)?;
        let tokens = exchange_code_for_tokens(&code).await?;
        crate::auth::ensure_login_active(&state.login_cancel)?;
        let session = session_from_tokens(tokens, None)?;
        let _refresh_guard = state.refresh_lock.lock().await;
        commit_login_if_active(&state.login_cancel, &state.login_commit_lock, || {
            save_session(&app, &session)?;
            state.login_cancellable.store(false, Ordering::SeqCst);
            let status = status_dto(Some(&session), false);
            let _ = app.emit("openai-auth://status", &status);
            Ok(status)
        })
    }
    .await;

    finish_login_attempt(
        &state.login_in_progress,
        &state.login_cancellable,
        &state.login_cancel,
        &state.login_commit_lock,
    );
    result
}

#[tauri::command]
pub fn openai_auth_cancel_login(state: State<'_, OpenAIAuthState>) -> bool {
    cancel_login_before_commit(
        &state.login_cancellable,
        &state.login_cancel,
        &state.login_commit_lock,
    )
}

#[tauri::command]
pub async fn openai_auth_logout(
    app: AppHandle,
    state: State<'_, OpenAIAuthState>,
) -> Result<OpenAIAuthStatus, String> {
    let session = clear_session_for_logout(
        &state.refresh_lock,
        || load_session(&app),
        || clear_session(&app),
    )
    .await?;
    // Best-effort revoke; local sign-out proceeds regardless.
    if let Some(session) = session.as_ref() {
        let client = oauth_http_client().ok();
        if let Some(client) = client {
            let _ = client
                .post(format!("{ISSUER}/oauth/revoke"))
                .json(&serde_json::json!({
                    "client_id": CLIENT_ID,
                    "token": session.refresh_token,
                }))
                .send()
                .await;
        }
    }
    let login_in_progress = state.login_in_progress.load(Ordering::SeqCst);
    let status = status_dto(None, login_in_progress);
    let _ = app.emit("openai-auth://status", &status);
    Ok(status)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;
    use std::sync::{Arc, Mutex as StdMutex};

    fn b64url(payload: &serde_json::Value) -> String {
        use base64::engine::general_purpose::URL_SAFE_NO_PAD;
        URL_SAFE_NO_PAD.encode(payload.to_string().as_bytes())
    }

    fn fake_jwt(payload: &serde_json::Value) -> String {
        format!("header.{}.sig", b64url(payload))
    }

    #[test]
    fn classifies_codex_usage_auth_and_access_failures_separately() {
        assert_eq!(
            classify_codex_usage_status(401),
            CodexUsageFailure::InvalidSession
        );
        assert_eq!(
            classify_codex_usage_status(403),
            CodexUsageFailure::AccessDenied
        );
        assert_eq!(
            classify_codex_usage_status(500),
            CodexUsageFailure::Temporary
        );
    }

    #[test]
    fn cancelled_openai_login_cannot_commit_a_session() {
        let state = OpenAIAuthState::new();
        state.login_in_progress.store(true, Ordering::SeqCst);
        state.login_cancellable.store(true, Ordering::SeqCst);
        let saved = Cell::new(false);

        assert!(cancel_login_before_commit(
            &state.login_cancellable,
            &state.login_cancel,
            &state.login_commit_lock
        ));
        assert!(
            commit_login_if_active(&state.login_cancel, &state.login_commit_lock, || {
                saved.set(true);
                Ok(())
            })
            .is_err()
        );
        assert!(!saved.get());
    }

    #[tokio::test]
    async fn damaged_session_load_does_not_block_successful_local_logout() {
        let refresh_lock = tokio::sync::Mutex::new(());
        let cleared = Cell::new(false);
        let session = clear_session_for_logout(
            &refresh_lock,
            || Err::<Option<OpenAISession>, _>("damaged vault".into()),
            || {
                cleared.set(true);
                Ok(())
            },
        )
        .await
        .unwrap();

        assert!(session.is_none());
        assert!(cleared.get());
    }

    #[tokio::test]
    async fn local_logout_reports_clear_failures() {
        let refresh_lock = tokio::sync::Mutex::new(());
        let result =
            clear_session_for_logout(&refresh_lock, || Ok(None), || Err("clear failed".into()))
                .await;

        assert_eq!(result.unwrap_err(), "clear failed");
    }

    #[tokio::test]
    async fn logout_clears_after_an_in_flight_refresh_write() {
        let refresh_lock = Arc::new(tokio::sync::Mutex::new(()));
        let stored = Arc::new(StdMutex::new(Some("old")));
        let (refresh_started_tx, refresh_started_rx) = tokio::sync::oneshot::channel();
        let (release_refresh_tx, release_refresh_rx) = tokio::sync::oneshot::channel();

        let refresh = {
            let refresh_lock = Arc::clone(&refresh_lock);
            let stored = Arc::clone(&stored);
            tokio::spawn(async move {
                let _guard = refresh_lock.lock().await;
                refresh_started_tx.send(()).unwrap();
                release_refresh_rx.await.unwrap();
                *stored.lock().unwrap() = Some("refreshed");
            })
        };
        refresh_started_rx.await.unwrap();

        let logout = {
            let refresh_lock = Arc::clone(&refresh_lock);
            let stored = Arc::clone(&stored);
            tokio::spawn(async move {
                clear_session_for_logout(
                    &refresh_lock,
                    || Ok(None),
                    || {
                        *stored.lock().unwrap() = None;
                        Ok(())
                    },
                )
                .await
            })
        };

        release_refresh_tx.send(()).unwrap();
        refresh.await.unwrap();
        logout.await.unwrap().unwrap();
        assert_eq!(*stored.lock().unwrap(), None);
    }

    #[tokio::test]
    async fn stale_usage_failure_does_not_clear_a_new_session() {
        let refresh_lock = tokio::sync::Mutex::new(());
        let current = OpenAISession {
            id_token: "new-id".into(),
            access_token: "new-access".into(),
            refresh_token: "new-refresh".into(),
            expires_at: 1,
            email: None,
            plan: None,
            account_id: None,
        };
        let cleared = Cell::new(false);

        let did_clear = clear_session_if_current(
            &refresh_lock,
            "old-access",
            || Ok(Some(current)),
            || {
                cleared.set(true);
                Ok(())
            },
        )
        .await
        .unwrap();

        assert!(!did_clear);
        assert!(!cleared.get());
    }

    #[test]
    fn device_poll_checks_status_before_success_body() {
        assert!(parse_device_poll_response(403, "{}").unwrap().is_none());
        assert!(parse_device_poll_response(404, "not json")
            .unwrap()
            .is_none());
        assert_eq!(
            parse_device_poll_response(400, "{}").unwrap_err(),
            "OpenAI sign-in failed (status 400). Try again."
        );

        let code = parse_device_poll_response(
            200,
            r#"{"authorization_code":"code","code_challenge":"challenge","code_verifier":"verifier"}"#,
        )
        .unwrap()
        .unwrap();
        assert_eq!(code.authorization_code, "code");
    }

    #[test]
    fn device_start_and_exchange_check_status_before_success_body() {
        assert_eq!(
            parse_device_code_response(404, "not json").unwrap_err(),
            "Device code sign-in is not available for OpenAI right now."
        );
        assert_eq!(
            parse_device_code_response(500, "not json").unwrap_err(),
            "OpenAI sign-in could not be started."
        );
        assert_eq!(
            parse_token_exchange_response(400, "not json").unwrap_err(),
            "OpenAI sign-in could not be completed."
        );

        let tokens = parse_token_exchange_response(
            200,
            r#"{"access_token":"access","refresh_token":"refresh"}"#,
        )
        .unwrap();
        assert_eq!(tokens.access_token, "access");
    }

    #[test]
    fn only_invalid_grant_invalidates_openai_session() {
        for error in [
            parse_refresh_response(500, r#"{"error":"invalid_grant"}"#).unwrap_err(),
            parse_refresh_response(429, "{}").unwrap_err(),
            parse_refresh_response(200, "not json").unwrap_err(),
            parse_refresh_response(400, r#"{"error":"temporarily_unavailable"}"#).unwrap_err(),
        ] {
            assert!(!error.invalidates_session());
        }

        let invalid_grant =
            parse_refresh_response(400, r#"{"error":"invalid_grant"}"#).unwrap_err();
        assert!(invalid_grant.invalidates_session());
    }

    #[test]
    fn refresh_failure_clears_only_invalid_sessions_and_reports_clear_errors() {
        let cleared = Cell::new(false);
        let temporary = RefreshFailure::Temporary("retry".into());
        assert!(!clear_session_if_invalid(&temporary, || {
            cleared.set(true);
            Ok(())
        })
        .unwrap());
        assert!(!cleared.get());

        assert!(
            clear_session_if_invalid(&RefreshFailure::InvalidSession, || {
                cleared.set(true);
                Ok(())
            })
            .unwrap()
        );
        assert!(cleared.get());
        assert_eq!(
            clear_session_if_invalid(&RefreshFailure::InvalidSession, || {
                Err("clear failed".into())
            })
            .unwrap_err(),
            "clear failed"
        );
    }

    #[test]
    fn parses_id_token_claims() {
        let jwt = fake_jwt(&serde_json::json!({
            "email": "user@example.com",
            "https://api.openai.com/auth": {
                "chatgpt_plan_type": "plus",
                "chatgpt_account_id": "acc-123",
                "chatgpt_user_id": "user-1"
            }
        }));
        let (email, plan, account) = parse_id_token_claims(&jwt);
        assert_eq!(email.as_deref(), Some("user@example.com"));
        assert_eq!(plan.as_deref(), Some("Plus"));
        assert_eq!(account.as_deref(), Some("acc-123"));
    }

    #[test]
    fn falls_back_to_profile_email() {
        let jwt = fake_jwt(&serde_json::json!({
            "https://api.openai.com/profile": { "email": "p@example.com" },
            "https://api.openai.com/auth": { "chatgpt_plan_type": "free" }
        }));
        let (email, plan, account) = parse_id_token_claims(&jwt);
        assert_eq!(email.as_deref(), Some("p@example.com"));
        assert_eq!(plan.as_deref(), Some("Free"));
        assert!(account.is_none());
    }

    #[test]
    fn session_expiry_follows_access_token_exp() {
        let exp = (now_ms() / 1000) + 7200;
        let tokens = TokenResponse {
            id_token: Some(fake_jwt(&serde_json::json!({
                "https://api.openai.com/auth": { "chatgpt_plan_type": "pro" }
            }))),
            access_token: fake_jwt(&serde_json::json!({ "exp": exp })),
            refresh_token: "refresh".into(),
        };
        let session = session_from_tokens(tokens, None).unwrap();
        assert_eq!(session.expires_at, exp * 1000 - REFRESH_SKEW_SECS * 1000);
        assert_eq!(session.plan.as_deref(), Some("Pro"));
    }

    #[test]
    fn interval_deserializes_from_string_or_number() {
        let parsed: UserCodeResp =
            serde_json::from_str(r#"{"device_auth_id":"d","user_code":"ABCD","interval":"7"}"#)
                .unwrap();
        assert_eq!(parsed.interval, Some(7));
        let parsed: UserCodeResp =
            serde_json::from_str(r#"{"device_auth_id":"d","usercode":"WXYZ","interval":3}"#)
                .unwrap();
        assert_eq!(parsed.user_code, "WXYZ");
        assert_eq!(parsed.interval, Some(3));
    }

    #[test]
    fn plan_normalization_covers_known_tiers() {
        assert_eq!(normalize_plan("plus"), "Plus");
        assert_eq!(normalize_plan("BUSINESS"), "Business");
        assert_eq!(normalize_plan("team_pro"), "Team Pro");
    }

    #[test]
    fn form_encoding_round_trips_specials() {
        assert_eq!(urlencoding_encode("a b+c/d=e"), "a%20b%2Bc%2Fd%3De");
    }

    #[test]
    fn codex_usage_payload_is_sparse_and_bounded() {
        let payload: CodexUsagePayload = serde_json::from_value(serde_json::json!({
            "plan_type": "pro",
            "rate_limit": {
                "primary_window": {
                    "used_percent": 112.5,
                    "limit_window_seconds": 18_000,
                    "reset_at": 1_775_000_000
                },
                "secondary_window": null
            }
        }))
        .unwrap();
        let rate_limit = payload.rate_limit.unwrap();
        let primary = CodexUsageWindow::from(rate_limit.primary_window.unwrap());

        assert_eq!(primary.used_percent, 100.0);
        assert_eq!(primary.window_minutes, Some(300));
        assert_eq!(primary.resets_at, Some(1_775_000_000));
        assert!(rate_limit.secondary_window.is_none());
    }

    #[test]
    fn codex_usage_payload_accepts_missing_limits() {
        let payload: CodexUsagePayload = serde_json::from_str(r#"{"plan_type":"plus"}"#).unwrap();
        assert!(payload.rate_limit.is_none());
    }
}
