//! xAI SuperGrok / X Premium OAuth — device-code flow
//! Mirrors earendil-works/pi `packages/ai/src/auth/oauth/xai.ts`

use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, State};

const CLIENT_ID: &str = "b1a00492-073a-47ea-816f-4c329264a828";
const SCOPE: &str = "openid profile email offline_access grok-cli:access api:access";
const DEVICE_CODE_URL: &str = "https://auth.x.ai/oauth2/device/code";
const TOKEN_URL: &str = "https://auth.x.ai/oauth2/token";
const DEVICE_GRANT: &str = "urn:ietf:params:oauth:grant-type:device_code";
const REFERRER: &str = "grokapp";
const REFRESH_SKEW_SECS: u64 = 5 * 60;
const DEFAULT_TOKEN_LIFETIME_SECS: u64 = 3600;
const DEFAULT_POLL_INTERVAL_SECS: u64 = 5;
const MIN_POLL_INTERVAL_SECS: u64 = 1;
const SLOW_DOWN_BUMP_SECS: u64 = 5;
const SESSION_SLOT: &str = "xai-auth";
const LEGACY_SESSION_FILE: &str = "auth.json";

pub struct AuthState {
    pub login_in_progress: AtomicBool,
    pub login_cancellable: AtomicBool,
    pub login_cancel: AtomicBool,
    pub login_commit_lock: Mutex<()>,
    /// Held across the full refresh HTTP + disk write (single-flight).
    pub refresh_lock: tokio::sync::Mutex<()>,
}

impl AuthState {
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

pub(crate) fn ensure_login_active(cancel: &AtomicBool) -> Result<(), String> {
    if cancel.load(Ordering::SeqCst) {
        Err("Login cancelled".into())
    } else {
        Ok(())
    }
}

pub(crate) fn commit_login_if_active<T>(
    cancel: &AtomicBool,
    commit_lock: &Mutex<()>,
    commit: impl FnOnce() -> Result<T, String>,
) -> Result<T, String> {
    let _guard = commit_lock
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    ensure_login_active(cancel)?;
    commit()
}

pub(crate) fn begin_login_attempt(
    in_progress: &AtomicBool,
    cancellable: &AtomicBool,
    cancel: &AtomicBool,
    commit_lock: &Mutex<()>,
    already_running: &str,
) -> Result<(), String> {
    let _guard = commit_lock
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    in_progress
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .map_err(|_| already_running.to_string())?;
    cancel.store(false, Ordering::SeqCst);
    cancellable.store(true, Ordering::SeqCst);
    Ok(())
}

pub(crate) fn finish_login_attempt(
    in_progress: &AtomicBool,
    cancellable: &AtomicBool,
    cancel: &AtomicBool,
    commit_lock: &Mutex<()>,
) {
    let _guard = commit_lock
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    cancellable.store(false, Ordering::SeqCst);
    cancel.store(false, Ordering::SeqCst);
    in_progress.store(false, Ordering::SeqCst);
}

pub(crate) fn cancel_login_before_commit(
    cancellable: &AtomicBool,
    cancel: &AtomicBool,
    commit_lock: &Mutex<()>,
) -> bool {
    let _guard = commit_lock
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let active = cancellable.load(Ordering::SeqCst);
    if active {
        cancel.store(true, Ordering::SeqCst);
    }
    active
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthSession {
    pub access_token: String,
    pub refresh_token: String,
    /// unix ms when access token should be treated as expired (already skew-adjusted)
    pub expires_at: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub email: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub plan: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthStatus {
    pub signed_in: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub email: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub plan: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expires_at: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceCodeEvent {
    pub user_code: String,
    pub verification_uri: String,
    pub expires_in_seconds: u64,
    pub interval_seconds: u64,
}

#[derive(Debug, Deserialize)]
struct TokenBody {
    access_token: Option<String>,
    refresh_token: Option<String>,
    expires_in: Option<u64>,
    error: Option<String>,
    id_token: Option<String>,
}

#[derive(Debug, Deserialize)]
struct DeviceBody {
    device_code: Option<String>,
    user_code: Option<String>,
    verification_uri: Option<String>,
    verification_uri_complete: Option<String>,
    expires_in: Option<u64>,
    interval: Option<u64>,
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
            Self::InvalidSession => "Your xAI session expired. Sign in again.",
            Self::Temporary(message) => message,
        }
    }
}

fn clear_session_if_invalid(
    failure: &RefreshFailure,
    clear: impl FnOnce() -> Result<(), String>,
) -> Result<(), String> {
    if failure.invalidates_session() {
        clear()?;
    }
    Ok(())
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn load_session(app: &AppHandle) -> Result<Option<AuthSession>, String> {
    crate::secure_store::with_best_effort_cleanup(
        || crate::secure_store::load(app, SESSION_SLOT),
        || crate::secure_store::remove_legacy_plaintext(app, LEGACY_SESSION_FILE),
    )
}

fn save_session(app: &AppHandle, session: &AuthSession) -> Result<(), String> {
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
    clear: impl FnOnce() -> Result<(), String>,
) -> Result<(), String> {
    let _guard = refresh_lock.lock().await;
    clear()
}

fn status_dto(session: Option<&AuthSession>) -> AuthStatus {
    match session {
        Some(s) => {
            let mut plan = s.plan.clone();
            // Re-decode access token so upgraded plans show without re-login.
            if plan.is_none() || plan.as_deref() == Some("SuperGrok") {
                if let Some(claims) = decode_jwt_payload(&s.access_token) {
                    if let Some(p) = plan_from_claims(&claims) {
                        plan = Some(p);
                    }
                }
            }
            AuthStatus {
                signed_in: true,
                email: s.email.clone(),
                name: s.name.clone(),
                plan,
                expires_at: Some(s.expires_at),
            }
        }
        None => AuthStatus {
            signed_in: false,
            email: None,
            name: None,
            plan: None,
            expires_at: None,
        },
    }
}

fn require_str(v: Option<String>, _field: &str) -> Result<String, String> {
    v.filter(|s| !s.is_empty())
        .ok_or_else(|| "xAI sign-in returned an incomplete response.".to_string())
}

fn validate_https_uri(raw: &str) -> Result<String, String> {
    let url = url::Url::parse(raw).map_err(|_| "Untrusted verification URI".to_string())?;
    if url.scheme() != "https" {
        return Err("Untrusted verification URI".into());
    }
    let host = url.host_str().unwrap_or("");
    if host != "auth.x.ai" && !host.ends_with(".x.ai") {
        return Err("Untrusted verification host".into());
    }
    Ok(url.into())
}

fn decode_jwt_payload(token: &str) -> Option<serde_json::Value> {
    use base64::engine::general_purpose::URL_SAFE_NO_PAD;
    use base64::Engine;
    let payload = token.split('.').nth(1)?;
    let bytes = URL_SAFE_NO_PAD.decode(payload).ok()?;
    serde_json::from_slice(&bytes).ok()
}

/// xAI JWT `tier` claim is a small integer (not a plan name string).
fn plan_from_numeric_tier(n: i64) -> Option<String> {
    Some(
        match n {
            0 => "Free",
            1 => "SuperGrok",
            2 => "X Basic",
            3 => "X Premium",
            4 => "X Premium+",
            5 => "SuperGrok Heavy",
            6 => "SuperGrok Lite",
            _ => return None,
        }
        .into(),
    )
}

pub fn normalize_plan(raw: &str) -> String {
    let s = raw.trim();
    let lower = s.to_ascii_lowercase().replace(['_', '-'], " ");
    let compact: String = lower.chars().filter(|c| !c.is_whitespace()).collect();

    // Strip common enum prefixes: SUBSCRIPTION_TIER_SUPERGROK_HEAVY, etc.
    let compact = compact
        .strip_prefix("subscriptiontier")
        .unwrap_or(&compact)
        .to_string();

    if compact.contains("supergrokheavy")
        || compact.contains("grokheavy")
        || compact.contains("supergrokpro")
        || (compact.contains("heavy") && compact.contains("supergrok"))
        || compact == "heavy"
    {
        return "SuperGrok Heavy".into();
    }
    if compact.contains("supergroklite") || compact == "lite" {
        return "SuperGrok Lite".into();
    }
    if compact.contains("supergrok") {
        return "SuperGrok".into();
    }
    if compact.contains("xpremiumplus") || compact.contains("premiumplus") {
        return "X Premium+".into();
    }
    if compact.contains("xpremium") || lower.contains("x premium") {
        return "X Premium".into();
    }
    if compact.contains("xbasic") {
        return "X Basic".into();
    }
    if compact.contains("premium") {
        return "Premium".into();
    }
    if compact.contains("pro") && !compact.contains("project") {
        return "Pro".into();
    }
    if compact.contains("free") || compact.contains("basic") {
        return "Free".into();
    }

    s.split(|c: char| c == '_' || c == '-' || c.is_whitespace())
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

fn claim_as_plan(v: &serde_json::Value) -> Option<String> {
    if let Some(s) = v.as_str().filter(|s| !s.is_empty()) {
        if let Ok(n) = s.trim().parse::<i64>() {
            if let Some(p) = plan_from_numeric_tier(n) {
                return Some(p);
            }
        }
        return Some(normalize_plan(s));
    }
    if let Some(n) = v.as_i64().or_else(|| v.as_u64().map(|u| u as i64)) {
        return plan_from_numeric_tier(n);
    }
    if let Some(b) = v.as_bool() {
        return if b { Some("SuperGrok".into()) } else { None };
    }
    if let Some(arr) = v.as_array() {
        let mut best: Option<String> = None;
        for item in arr {
            if let Some(p) = claim_as_plan(item) {
                if p.contains("Heavy") {
                    return Some(p);
                }
                if best.as_deref() != Some("SuperGrok Heavy") {
                    best = Some(p);
                }
            }
        }
        return best;
    }
    if let Some(obj) = v.as_object() {
        for key in [
            "name",
            "plan",
            "type",
            "tier",
            "subscriptionTier",
            "subscription_tier",
            "product",
            "label",
            "sku",
        ] {
            if let Some(p) = obj.get(key).and_then(claim_as_plan) {
                return Some(p);
            }
        }
    }
    None
}

fn plan_from_claims(claims: &serde_json::Value) -> Option<String> {
    const KEYS: &[&str] = &[
        "plan",
        "plan_name",
        "planName",
        "subscription",
        "subscription_type",
        "subscriptionType",
        "subscription_tier",
        "subscriptionTier",
        "tier",
        "product",
        "product_name",
        "package",
        "sku",
        "grok_plan",
        "grokPlan",
        "xai_plan",
        "xaiPlan",
        "entitlement",
        "entitlements",
    ];
    for key in KEYS {
        if let Some(v) = claims.get(*key) {
            if let Some(p) = claim_as_plan(v) {
                return Some(p);
            }
        }
    }
    for flag in [
        "is_supergrok_heavy",
        "supergrok_heavy",
        "isSuperGrokHeavy",
        "is_supergrok",
        "supergrok",
        "isSuperGrok",
    ] {
        if claims.get(flag).and_then(|v| v.as_bool()) == Some(true) {
            return Some(if flag.to_ascii_lowercase().contains("heavy") {
                "SuperGrok Heavy".into()
            } else {
                "SuperGrok".into()
            });
        }
    }
    for key in ["https://auth.x.ai/claims", "xai", "grok", "user", "data"] {
        if let Some(nested) = claims.get(key) {
            if let Some(p) = plan_from_claims(nested) {
                return Some(p);
            }
        }
    }
    None
}

fn enrich_plan_from_token(session: &mut AuthSession, token: Option<&str>) {
    let Some(token) = token else { return };
    if session.plan.as_deref() == Some("SuperGrok Heavy") {
        return;
    }
    let Some(claims) = decode_jwt_payload(token) else {
        return;
    };
    if let Some(p) = plan_from_claims(&claims) {
        // Prefer Heavy over plain SuperGrok.
        if session.plan.as_deref() == Some("SuperGrok") && p == "SuperGrok" {
            return;
        }
        if session.plan.is_none()
            || p.contains("Heavy")
            || session.plan.as_deref() == Some("SuperGrok")
        {
            session.plan = Some(p);
        }
    }
}

fn enrich_identity(session: &mut AuthSession, id_token: Option<&str>) {
    let Some(id_token) = id_token else { return };
    let Some(claims) = decode_jwt_payload(id_token) else {
        return;
    };
    if session.email.is_none() {
        session.email = claims
            .get("email")
            .and_then(|v| v.as_str())
            .map(str::to_string);
    }
    if session.name.is_none() {
        session.name = claims
            .get("name")
            .and_then(|v| v.as_str())
            .map(str::to_string)
            .or_else(|| {
                let g = claims.get("given_name").and_then(|v| v.as_str());
                let f = claims.get("family_name").and_then(|v| v.as_str());
                match (g, f) {
                    (Some(a), Some(b)) => Some(format!("{a} {b}")),
                    (Some(a), None) => Some(a.to_string()),
                    _ => None,
                }
            });
    }
    if session.plan.is_none() {
        if let Some(p) = plan_from_claims(&claims) {
            session.plan = Some(p);
        }
    }
}

async fn fetch_plan_from_api(access_token: &str) -> Option<String> {
    let client = oauth_http_client().ok()?;
    // cli-chat-proxy is the OAuth subscription surface; api.x.ai /v1/me has no plan.
    let urls = [
        "https://cli-chat-proxy.grok.com/v1/user?include=subscription",
        "https://api.x.ai/v1/me",
        "https://api.x.ai/v1/api-key",
    ];
    for url in urls {
        let mut req = client
            .get(url)
            .bearer_auth(access_token)
            .header("Accept", "application/json");
        if url.contains("cli-chat-proxy.grok.com") {
            req = req
                .header("X-XAI-Token-Auth", "xai-grok-cli")
                .header("x-grok-client-version", "0.2.111")
                .header("x-grok-client-identifier", "grok-shell")
                .header("x-grok-client-mode", "headless");
        }
        let Ok(resp) = req.send().await else {
            continue;
        };
        if !resp.status().is_success() {
            continue;
        }
        let Ok(v) = resp.json::<serde_json::Value>().await else {
            continue;
        };
        if let Some(p) = plan_from_claims(&v) {
            return Some(p);
        }
        for path in [
            "/subscriptionTier",
            "/subscription_tier",
            "/user/subscriptionTier",
            "/user/plan",
            "/subscription/plan",
            "/data/plan",
            "/team/plan",
            "/plan",
        ] {
            if let Some(node) = v.pointer(path) {
                if let Some(p) = claim_as_plan(node) {
                    return Some(p);
                }
            }
        }
    }
    None
}

async fn finalize_session(mut session: AuthSession) -> AuthSession {
    let access = session.access_token.clone();
    enrich_plan_from_token(&mut session, Some(&access));
    if session.plan.is_none() {
        if let Some(p) = fetch_plan_from_api(&access).await {
            session.plan = Some(p);
        }
    }
    session
}

fn credentials_from_token(
    body: TokenBody,
    previous_refresh: Option<String>,
) -> Result<AuthSession, String> {
    if let Some(err) = body.error.as_deref() {
        return Err(match err {
            "access_denied" | "authorization_denied" => "xAI sign-in was denied.".to_string(),
            "expired_token" | "invalid_grant" => {
                "xAI sign-in expired. Please try again.".to_string()
            }
            _ => "xAI sign-in could not be completed.".to_string(),
        });
    }
    let access = require_str(body.access_token, "access_token")?;
    let refresh = match body.refresh_token {
        Some(r) if !r.is_empty() => r,
        _ => previous_refresh
            .ok_or_else(|| "xAI sign-in returned an incomplete response.".to_string())?,
    };
    let lifetime = body
        .expires_in
        .filter(|v| *v > 0)
        .unwrap_or(DEFAULT_TOKEN_LIFETIME_SECS);
    let expires_at = now_ms()
        + lifetime
            .saturating_mul(1000)
            .saturating_sub(REFRESH_SKEW_SECS * 1000);

    let mut session = AuthSession {
        access_token: access,
        refresh_token: refresh,
        expires_at,
        email: None,
        name: None,
        plan: None,
    };
    enrich_identity(&mut session, body.id_token.as_deref());
    let access = session.access_token.clone();
    enrich_plan_from_token(&mut session, Some(&access));
    Ok(session)
}

fn oauth_http_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(30))
        .timeout(std::time::Duration::from_secs(60))
        .http1_only()
        .user_agent(concat!("GrokDesktop/", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|e| format!("http client: {e}"))
}

async fn post_form(url: &str, fields: &[(&str, &str)]) -> Result<(u16, TokenBody), String> {
    let (status, body) = post_form_raw(url, fields).await?;
    let body = serde_json::from_str(&body)
        .map_err(|_| "xAI sign-in returned an invalid response.".to_string())?;
    Ok((status, body))
}

async fn post_form_raw(url: &str, fields: &[(&str, &str)]) -> Result<(u16, String), String> {
    let client = oauth_http_client()?;
    let resp = client
        .post(url)
        .header("Accept", "application/json")
        .form(fields)
        .send()
        .await
        .map_err(|_| "Could not reach xAI sign-in.".to_string())?;
    let status = resp.status().as_u16();
    let body = resp
        .text()
        .await
        .map_err(|_| "xAI sign-in returned an invalid response.".to_string())?;
    Ok((status, body))
}

async fn post_device_form(url: &str, fields: &[(&str, &str)]) -> Result<(u16, DeviceBody), String> {
    let client = oauth_http_client()?;
    let resp = client
        .post(url)
        .header("Accept", "application/json")
        .form(fields)
        .send()
        .await
        .map_err(|_| "Could not reach xAI sign-in.".to_string())?;
    let status = resp.status().as_u16();
    let body: DeviceBody = resp
        .json()
        .await
        .map_err(|_| "xAI sign-in returned an invalid response.".to_string())?;
    Ok((status, body))
}

async fn request_device_code() -> Result<(String, DeviceCodeEvent), String> {
    let (status, body) = post_device_form(
        DEVICE_CODE_URL,
        &[
            ("client_id", CLIENT_ID),
            ("scope", SCOPE),
            ("referrer", REFERRER),
        ],
    )
    .await?;

    if status >= 400 {
        return Err("xAI sign-in could not be started.".into());
    }

    let device_code = require_str(body.device_code, "device_code")?;
    let user_code = require_str(body.user_code, "user_code")?;
    let verification_uri =
        if let Some(complete) = body.verification_uri_complete.filter(|s| !s.is_empty()) {
            validate_https_uri(&complete)?
        } else {
            validate_https_uri(&require_str(body.verification_uri, "verification_uri")?)?
        };
    let expires_in = body
        .expires_in
        .filter(|v| *v > 0)
        .ok_or_else(|| "Invalid xAI OAuth response field: expires_in".to_string())?;
    let interval = body
        .interval
        .filter(|v| *v > 0)
        .unwrap_or(DEFAULT_POLL_INTERVAL_SECS)
        .max(MIN_POLL_INTERVAL_SECS);

    Ok((
        device_code,
        DeviceCodeEvent {
            user_code,
            verification_uri,
            expires_in_seconds: expires_in,
            interval_seconds: interval,
        },
    ))
}

async fn poll_device_tokens(
    device_code: &str,
    mut interval_secs: u64,
    expires_in_secs: u64,
    cancel: &AtomicBool,
) -> Result<AuthSession, String> {
    // pi: wait before first poll (RFC 8628)
    tokio::time::sleep(Duration::from_secs(interval_secs)).await;

    let deadline = tokio::time::Instant::now() + Duration::from_secs(expires_in_secs);
    let mut slow_downs = 0u32;

    loop {
        if cancel.load(Ordering::SeqCst) {
            return Err("Login cancelled".into());
        }
        if tokio::time::Instant::now() >= deadline {
            return Err(if slow_downs > 0 {
                "Device flow timed out after slow_down responses".into()
            } else {
                "Device flow timed out".into()
            });
        }

        let (status, body) = post_form(
            TOKEN_URL,
            &[
                ("grant_type", DEVICE_GRANT),
                ("client_id", CLIENT_ID),
                ("device_code", device_code),
            ],
        )
        .await?;
        ensure_login_active(cancel)?;

        if status < 400 {
            return credentials_from_token(body, None);
        }

        match body.error.as_deref() {
            Some("authorization_pending") => {
                tokio::time::sleep(Duration::from_secs(interval_secs)).await;
            }
            Some("slow_down") => {
                slow_downs += 1;
                interval_secs = interval_secs.saturating_add(SLOW_DOWN_BUMP_SECS);
                tokio::time::sleep(Duration::from_secs(interval_secs)).await;
            }
            Some("access_denied") | Some("authorization_denied") => {
                return Err("xAI device authorization was denied".into());
            }
            Some("expired_token") => return Err("xAI device code expired".into()),
            _ => return Err("xAI sign-in could not be completed.".into()),
        }
    }
}

fn parse_refresh_response(
    status: u16,
    body: &str,
    refresh_token: &str,
) -> Result<AuthSession, RefreshFailure> {
    if status == 429 || status >= 500 {
        return Err(RefreshFailure::Temporary(
            "Could not refresh your xAI session right now.".into(),
        ));
    }
    let body: TokenBody = serde_json::from_str(body).map_err(|_| {
        RefreshFailure::Temporary("xAI returned an invalid refresh response.".into())
    })?;
    if status >= 400 || body.error.is_some() {
        return Err(match body.error.as_deref() {
            Some("invalid_grant" | "expired_token") => RefreshFailure::InvalidSession,
            _ => RefreshFailure::Temporary("Could not refresh your xAI session right now.".into()),
        });
    }
    credentials_from_token(body, Some(refresh_token.to_string())).map_err(RefreshFailure::Temporary)
}

async fn refresh_access(refresh_token: &str) -> Result<AuthSession, RefreshFailure> {
    let (status, body) = post_form_raw(
        TOKEN_URL,
        &[
            ("grant_type", "refresh_token"),
            ("client_id", CLIENT_ID),
            ("refresh_token", refresh_token),
        ],
    )
    .await
    .map_err(RefreshFailure::Temporary)?;
    parse_refresh_response(status, &body, refresh_token)
}

async fn ensure_fresh(app: &AppHandle, auth: &AuthState) -> Result<AuthSession, String> {
    let Some(session) = load_session(app)? else {
        return Err("Not signed in".into());
    };
    if session.expires_at > now_ms() {
        return Ok(session);
    }

    // Single-flight: hold tokio mutex across HTTP refresh + disk write.
    let _guard = auth.refresh_lock.lock().await;

    let session = load_session(app)?.ok_or_else(|| "Not signed in".to_string())?;
    if session.expires_at > now_ms() {
        return Ok(session);
    }

    let refresh_token = session.refresh_token.clone();
    let email = session.email.clone();
    let name = session.name.clone();
    let plan = session.plan.clone();

    match refresh_access(&refresh_token).await {
        Ok(mut next) => {
            if next.email.is_none() {
                next.email = email;
            }
            if next.name.is_none() {
                next.name = name;
            }
            if next.plan.is_none() {
                next.plan = plan;
            }
            next = finalize_session(next).await;
            save_session(app, &next)?;
            Ok(next)
        }
        Err(e) => {
            clear_session_if_invalid(&e, || clear_session(app))?;
            Err(e.message().to_string())
        }
    }
}

pub async fn get_access_token(app: &AppHandle, auth: &AuthState) -> Result<String, String> {
    Ok(ensure_fresh(app, auth).await?.access_token)
}

#[tauri::command]
pub async fn auth_status(app: AppHandle) -> Result<AuthStatus, String> {
    let Some(mut session) = load_session(&app)? else {
        return Ok(status_dto(None));
    };
    let before = session.plan.clone();
    let access = session.access_token.clone();
    enrich_plan_from_token(&mut session, Some(&access));
    if session.plan.is_none() {
        if let Some(p) = fetch_plan_from_api(&access).await {
            session.plan = Some(p);
        }
    }
    if session.plan != before {
        let _ = save_session(&app, &session);
    }
    Ok(status_dto(Some(&session)))
}

#[tauri::command]
pub async fn auth_login(app: AppHandle, state: State<'_, AuthState>) -> Result<AuthStatus, String> {
    begin_login_attempt(
        &state.login_in_progress,
        &state.login_cancellable,
        &state.login_cancel,
        &state.login_commit_lock,
        "Login already in progress",
    )?;

    let result = async {
        let (device_code, event) = request_device_code().await?;
        ensure_login_active(&state.login_cancel)?;
        let _ = app.emit("auth://device-code", &event);
        let _ = tauri_plugin_opener::open_url(&event.verification_uri, None::<&str>);

        let session = poll_device_tokens(
            &device_code,
            event.interval_seconds,
            event.expires_in_seconds,
            &state.login_cancel,
        )
        .await?;
        ensure_login_active(&state.login_cancel)?;
        let session = finalize_session(session).await;
        ensure_login_active(&state.login_cancel)?;
        commit_login_if_active(&state.login_cancel, &state.login_commit_lock, || {
            save_session(&app, &session)?;
            state.login_cancellable.store(false, Ordering::SeqCst);
            let status = status_dto(Some(&session));
            let _ = app.emit("auth://status", &status);
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
pub fn auth_cancel_login(state: State<'_, AuthState>) {
    cancel_login_before_commit(
        &state.login_cancellable,
        &state.login_cancel,
        &state.login_commit_lock,
    );
}

#[tauri::command]
pub async fn auth_logout(
    app: AppHandle,
    state: State<'_, AuthState>,
) -> Result<AuthStatus, String> {
    clear_session_for_logout(&state.refresh_lock, || clear_session(&app)).await?;
    let status = status_dto(None);
    let _ = app.emit("auth://status", &status);
    Ok(status)
}

#[cfg(test)]
mod plan_tests {
    use super::*;
    use serde_json::json;
    use std::cell::Cell;
    use std::sync::{Arc, Mutex as StdMutex};

    #[test]
    fn only_terminal_oauth_errors_invalidate_xai_session() {
        for error in [
            parse_refresh_response(500, r#"{"error":"invalid_grant"}"#, "refresh").unwrap_err(),
            parse_refresh_response(429, "{}", "refresh").unwrap_err(),
            parse_refresh_response(200, "not json", "refresh").unwrap_err(),
            parse_refresh_response(400, r#"{"error":"temporarily_unavailable"}"#, "refresh")
                .unwrap_err(),
        ] {
            assert!(!error.invalidates_session());
        }

        for error_name in ["invalid_grant", "expired_token"] {
            let body = format!(r#"{{"error":"{error_name}"}}"#);
            let error = parse_refresh_response(400, &body, "refresh").unwrap_err();
            assert!(error.invalidates_session());
        }
    }

    #[test]
    fn cancelled_login_cannot_commit_a_session() {
        let cancellable = AtomicBool::new(true);
        let cancelled = AtomicBool::new(false);
        let commit_lock = std::sync::Mutex::new(());
        let saved = Cell::new(false);

        assert!(cancel_login_before_commit(
            &cancellable,
            &cancelled,
            &commit_lock
        ));
        assert_eq!(
            commit_login_if_active(&cancelled, &commit_lock, || {
                saved.set(true);
                Ok(())
            })
            .unwrap_err(),
            "Login cancelled"
        );
        assert!(!saved.get());
    }

    #[test]
    fn committed_login_is_no_longer_reported_as_cancellable() {
        let in_progress = AtomicBool::new(false);
        let cancellable = AtomicBool::new(false);
        let cancelled = AtomicBool::new(true);
        let commit_lock = std::sync::Mutex::new(());

        begin_login_attempt(
            &in_progress,
            &cancellable,
            &cancelled,
            &commit_lock,
            "already running",
        )
        .unwrap();

        commit_login_if_active(&cancelled, &commit_lock, || {
            cancellable.store(false, Ordering::SeqCst);
            Ok(())
        })
        .unwrap();

        assert!(!cancel_login_before_commit(
            &cancellable,
            &cancelled,
            &commit_lock
        ));
        assert!(in_progress.load(Ordering::SeqCst));
        assert!(!cancelled.load(Ordering::SeqCst));

        finish_login_attempt(&in_progress, &cancellable, &cancelled, &commit_lock);
        assert!(!in_progress.load(Ordering::SeqCst));
    }

    #[test]
    fn refresh_failure_clears_only_invalid_sessions_and_reports_clear_errors() {
        let cleared = Cell::new(false);
        clear_session_if_invalid(&RefreshFailure::Temporary("retry".into()), || {
            cleared.set(true);
            Ok(())
        })
        .unwrap();
        assert!(!cleared.get());

        clear_session_if_invalid(&RefreshFailure::InvalidSession, || {
            cleared.set(true);
            Ok(())
        })
        .unwrap();
        assert!(cleared.get());
        assert_eq!(
            clear_session_if_invalid(&RefreshFailure::InvalidSession, || {
                Err("clear failed".into())
            })
            .unwrap_err(),
            "clear failed"
        );
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
                clear_session_for_logout(&refresh_lock, || {
                    *stored.lock().unwrap() = None;
                    Ok(())
                })
                .await
            })
        };

        release_refresh_tx.send(()).unwrap();
        refresh.await.unwrap();
        logout.await.unwrap().unwrap();
        assert_eq!(*stored.lock().unwrap(), None);
    }

    #[test]
    fn normalizes_supergrok_heavy_variants() {
        assert_eq!(normalize_plan("supergrok_heavy"), "SuperGrok Heavy");
        assert_eq!(normalize_plan("SuperGrok Heavy"), "SuperGrok Heavy");
        assert_eq!(normalize_plan("GROK-HEAVY"), "SuperGrok Heavy");
        assert_eq!(normalize_plan("heavy"), "SuperGrok Heavy");
    }

    #[test]
    fn normalizes_supergrok_and_free() {
        assert_eq!(normalize_plan("supergrok"), "SuperGrok");
        assert_eq!(normalize_plan("free"), "Free");
        assert_eq!(normalize_plan("basic"), "Free");
    }

    #[test]
    fn plan_from_nested_claims() {
        let claims = json!({
            "subscription": { "plan": "supergrok_heavy" }
        });
        assert_eq!(
            plan_from_claims(&claims).as_deref(),
            Some("SuperGrok Heavy")
        );
    }

    #[test]
    fn plan_from_boolean_flag() {
        let claims = json!({ "is_supergrok_heavy": true });
        assert_eq!(
            plan_from_claims(&claims).as_deref(),
            Some("SuperGrok Heavy")
        );
    }

    #[test]
    fn plan_from_jwt_numeric_tier() {
        // Live xAI access tokens carry tier as an int (5 = SuperGrok Heavy).
        let claims = json!({ "tier": 5, "scope": "openid profile email" });
        assert_eq!(
            plan_from_claims(&claims).as_deref(),
            Some("SuperGrok Heavy")
        );
        assert_eq!(
            plan_from_claims(&json!({ "tier": 1 })).as_deref(),
            Some("SuperGrok")
        );
        assert_eq!(
            plan_from_claims(&json!({ "tier": 0 })).as_deref(),
            Some("Free")
        );
    }

    #[test]
    fn normalizes_cli_proxy_subscription_tier() {
        assert_eq!(normalize_plan("SuperGrokPro"), "SuperGrok Heavy");
        assert_eq!(
            normalize_plan("SUBSCRIPTION_TIER_SUPERGROK_HEAVY"),
            "SuperGrok Heavy"
        );
        assert_eq!(
            plan_from_claims(&json!({ "subscriptionTier": "SuperGrokPro" })).as_deref(),
            Some("SuperGrok Heavy")
        );
    }
}
