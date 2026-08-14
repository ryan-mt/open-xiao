use crate::chat::{StopCheck, StreamEvent, UserInputOption, UserInputQuestion};
#[cfg(windows)]
use crate::child_process::create_kill_on_close_job;
use crate::child_process::{
    bounded_command_output, hidden_command, stop_child, terminate_process_tree,
};
use crate::paths::{redact_secrets, redact_tool_arguments};
use crate::permission::{AgentMode, PermissionMode};
use crate::provider_output::{truncate_provider_output, ProviderLineBuffer};
use futures_util::StreamExt;
use rand::distr::{Alphanumeric, SampleString};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, Weak};
use std::time::{Duration, Instant};
use tauri::{ipc::Channel, AppHandle, Manager};
use tokio::io::{AsyncRead, AsyncReadExt};
use tokio::process::Child;
use tokio::sync::Mutex;

#[cfg(windows)]
use std::os::windows::io::OwnedHandle;

const OPENCODE_MODEL_PREFIX: &str = "opencode::";
const OPENCODE_SERVER_USERNAME: &str = "open-xiao";
const APP_TOOL_MCP_NAME: &str = "open-xiao";
const MINIMUM_OPENCODE_VERSION: &str = "1.14.19";
const LATEST_VERSION_TTL: Duration = Duration::from_secs(60 * 60);
const UPDATE_TIMEOUT: Duration = Duration::from_secs(300);
const COMMAND_TIMEOUT: Duration = Duration::from_secs(15);
const CONTROL_REQUEST_TIMEOUT: Duration = Duration::from_secs(15);
const ABORT_REQUEST_TIMEOUT: Duration = Duration::from_secs(2);
const STARTUP_TIMEOUT: Duration = Duration::from_secs(5);
const EVENT_STREAM_IDLE_TIMEOUT: Duration = Duration::from_secs(10 * 60);
const MAX_SERVER_REPORT_BYTES: usize = 1024;

fn session_permission_rules(
    permission: PermissionMode,
    agent: AgentMode,
    full_access: bool,
) -> Value {
    let mut rules = vec![
        json!({
            "permission": "*",
            "pattern": "*",
            "action": match permission {
                PermissionMode::Auto => "allow",
                PermissionMode::Ask => "ask",
            }
        }),
        json!({
            "permission": "question",
            "pattern": "*",
            "action": "allow"
        }),
    ];
    if agent == AgentMode::Plan {
        // OpenCode merges session rules after agent defaults and the last match wins.
        // Keep Plan's hard denies after the session-wide Auto/Ask rule.
        for denied in ["edit", "bash", "task", "external_directory"] {
            rules.push(json!({
                "permission": denied,
                "pattern": "*",
                "action": "deny"
            }));
        }
        for tool in crate::agent_tools::TOOL_NAMES
            .iter()
            .filter(|tool| !AgentMode::Plan.allowed_tools().contains(tool))
        {
            // OpenCode exposes MCP tools as `<sanitized-server>_<tool>` permissions.
            rules.push(json!({
                "permission": format!("{APP_TOOL_MCP_NAME}_{tool}"),
                "pattern": "*",
                "action": "deny"
            }));
        }
    } else if !full_access {
        // Keep Workspace's external-directory boundary after the session-wide rule.
        rules.push(json!({
            "permission": "external_directory",
            "pattern": "*",
            "action": "deny"
        }));
    }
    Value::Array(rules)
}

fn server_args() -> Vec<String> {
    vec![
        "serve".into(),
        "--pure".into(),
        "--hostname".into(),
        "127.0.0.1".into(),
        "--port".into(),
        "0".into(),
    ]
}

fn server_command(password: &str) -> tokio::process::Command {
    let mut command = hidden_command("opencode");
    command
        .args(server_args())
        .current_dir(std::env::temp_dir())
        .env("OPENCODE_CONFIG_CONTENT", "{}")
        .env("OPENCODE_SERVER_USERNAME", OPENCODE_SERVER_USERNAME)
        .env("OPENCODE_SERVER_PASSWORD", password)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    command
}

fn parse_server_base_url(line: &str) -> Result<String, String> {
    let raw = line
        .trim()
        .strip_prefix("opencode server listening on ")
        .ok_or_else(|| "OpenCode did not report its bound server endpoint.".to_string())?;
    let url = url::Url::parse(raw)
        .map_err(|_| "OpenCode reported an invalid server endpoint.".to_string())?;
    let port = url
        .port()
        .filter(|port| *port != 0)
        .ok_or_else(|| "OpenCode reported a server endpoint without a bound port.".to_string())?;
    if url.scheme() != "http"
        || url.host_str() != Some("127.0.0.1")
        || !url.username().is_empty()
        || url.password().is_some()
        || url.path() != "/"
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err("OpenCode reported an unsafe server endpoint.".into());
    }
    Ok(format!("http://127.0.0.1:{port}"))
}

async fn read_server_base_url<R: AsyncRead + Unpin>(stdout: &mut R) -> Result<String, String> {
    let mut bytes = Vec::with_capacity(128);
    loop {
        if bytes.len() >= MAX_SERVER_REPORT_BYTES {
            return Err("OpenCode server endpoint report was too large.".into());
        }
        let mut byte = [0_u8; 1];
        let read = stdout
            .read(&mut byte)
            .await
            .map_err(|error| format!("Could not read OpenCode server endpoint: {error}"))?;
        if read == 0 {
            return Err("OpenCode exited before reporting its server endpoint.".into());
        }
        if byte[0] == b'\n' {
            break;
        }
        bytes.push(byte[0]);
    }
    let line = std::str::from_utf8(&bytes)
        .map_err(|_| "OpenCode reported a non-UTF-8 server endpoint.".to_string())?;
    parse_server_base_url(line)
}

struct OpenCodeRuntime {
    child: Child,
    base_url: String,
    password: String,
    stdout_drain: tokio::task::JoinHandle<()>,
    #[cfg(windows)]
    job: OwnedHandle,
}

impl OpenCodeRuntime {
    fn access(&self) -> RuntimeAccess {
        RuntimeAccess {
            base_url: self.base_url.clone(),
            password: self.password.clone(),
        }
    }
}

#[derive(Clone)]
struct RuntimeAccess {
    base_url: String,
    password: String,
}

impl Drop for OpenCodeRuntime {
    fn drop(&mut self) {
        terminate_process_tree(
            &self.child,
            #[cfg(windows)]
            &self.job,
        );
        let _ = self.child.start_kill();
        self.stdout_drain.abort();
    }
}

#[derive(Clone)]
struct SessionBinding {
    session_id: String,
    directory: String,
}

#[derive(Clone)]
struct ApprovalBinding {
    request_id: String,
    directory: String,
}

#[derive(Clone)]
struct QuestionBinding {
    stream_id: String,
    directory: String,
    question_count: usize,
}

pub struct OpenCodeState {
    http: reqwest::Client,
    runtime: Mutex<Option<OpenCodeRuntime>>,
    sessions: Mutex<HashMap<String, SessionBinding>>,
    approvals: Mutex<HashMap<(String, String), ApprovalBinding>>,
    questions: Mutex<HashMap<String, QuestionBinding>>,
    stream_locks: Mutex<HashMap<String, Weak<Mutex<()>>>>,
    latest_version: Mutex<Option<(Instant, String)>>,
    update_lock: Mutex<()>,
}

impl Default for OpenCodeState {
    fn default() -> Self {
        let http = reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(3))
            .pool_idle_timeout(Duration::from_secs(90))
            .tcp_keepalive(Duration::from_secs(30))
            .build()
            .unwrap_or_else(|_| reqwest::Client::new());
        Self {
            http,
            runtime: Mutex::new(None),
            sessions: Mutex::new(HashMap::new()),
            approvals: Mutex::new(HashMap::new()),
            questions: Mutex::new(HashMap::new()),
            stream_locks: Mutex::new(HashMap::new()),
            latest_version: Mutex::new(None),
            update_lock: Mutex::new(()),
        }
    }
}

struct OpenCodeRequest<'a> {
    state: &'a OpenCodeState,
    access: &'a RuntimeAccess,
    request: reqwest::RequestBuilder,
}

impl OpenCodeRequest<'_> {
    fn query<T: Serialize + ?Sized>(mut self, query: &T) -> Self {
        self.request = self.request.query(query);
        self
    }

    fn json<T: Serialize + ?Sized>(mut self, value: &T) -> Self {
        self.request = self.request.json(value);
        self
    }

    fn timeout(mut self, timeout: Duration) -> Self {
        self.request = self.request.timeout(timeout);
        self
    }

    async fn send(self) -> Result<reqwest::Response, String> {
        self.state.validate_runtime_access(self.access).await?;
        let response = self
            .request
            .send()
            .await
            .map_err(|error| error.to_string())?;
        self.state.validate_runtime_access(self.access).await?;
        Ok(response)
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenCodeModel {
    id: String,
    name: String,
    upstream_provider: String,
    upstream_provider_name: String,
    context_window: Option<u64>,
    variants: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenCodeStatus {
    installed: bool,
    ready: bool,
    version: Option<String>,
    latest_version: Option<String>,
    update_available: bool,
    connected_providers: Vec<String>,
    models: Vec<OpenCodeModel>,
    checked_at: u64,
    message: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenCodeUpdateResult {
    status: OpenCodeStatus,
    output: String,
}

#[derive(Debug, Deserialize)]
struct ProviderList {
    #[serde(default)]
    connected: Vec<String>,
    #[serde(default)]
    all: Vec<UpstreamProvider>,
}

#[derive(Debug, Deserialize)]
struct UpstreamProvider {
    id: String,
    name: String,
    #[serde(default)]
    models: HashMap<String, UpstreamModel>,
}

#[derive(Debug, Deserialize)]
struct UpstreamModel {
    id: String,
    name: String,
    #[serde(default)]
    variants: HashMap<String, Value>,
    #[serde(default)]
    limit: ModelLimit,
    #[serde(default)]
    capabilities: ModelCapabilities,
}

#[derive(Debug, Default, Deserialize)]
struct ModelLimit {
    context: Option<u64>,
}

#[derive(Debug, Default, Deserialize)]
struct ModelCapabilities {
    #[serde(default)]
    output: ModelOutputCapabilities,
}

#[derive(Debug, Default, Deserialize)]
struct ModelOutputCapabilities {
    #[serde(default)]
    text: bool,
}

#[derive(Debug, Deserialize)]
struct SessionRecord {
    id: String,
    title: String,
}

fn now_millis() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

async fn command_output(
    program: &str,
    args: &[&str],
    deadline: Duration,
    label: &str,
) -> Result<std::process::Output, String> {
    bounded_command_output(Path::new(program), args, deadline, label).await
}

fn output_text(output: &std::process::Output) -> String {
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    match (stdout.is_empty(), stderr.is_empty()) {
        (false, false) => format!("{stdout}\n{stderr}"),
        (false, true) => stdout,
        (true, false) => stderr,
        (true, true) => String::new(),
    }
}

fn normalize_version(raw: &str) -> Option<String> {
    let candidate = raw
        .lines()
        .map(str::trim)
        .find(|line| line.chars().any(|ch| ch.is_ascii_digit()))?
        .trim_start_matches('v');
    let version: String = candidate
        .chars()
        .take_while(|ch| ch.is_ascii_digit() || *ch == '.' || *ch == '-')
        .collect();
    (!version.is_empty()).then_some(version)
}

fn semver_parts(version: &str) -> Vec<u64> {
    version
        .split(['.', '-'])
        .take(3)
        .map(|part| part.parse::<u64>().unwrap_or(0))
        .collect()
}

fn newer_version(installed: &str, latest: &str) -> bool {
    let mut current = semver_parts(installed);
    let mut available = semver_parts(latest);
    current.resize(3, 0);
    available.resize(3, 0);
    available > current
}

fn update_method(path: &Path) -> Option<&'static str> {
    let normalized = path
        .to_string_lossy()
        .replace('\\', "/")
        .to_ascii_lowercase();
    if normalized.contains("/.bun/") {
        Some("bun")
    } else if normalized.contains("/scoop/") {
        Some("scoop")
    } else if normalized.contains("/chocolatey/") {
        Some("choco")
    } else if normalized.contains("/pnpm/") {
        Some("pnpm")
    } else if normalized.contains("/npm/") || normalized.contains("/node_modules/") {
        Some("npm")
    } else {
        None
    }
}

async fn opencode_path() -> Result<PathBuf, String> {
    #[cfg(windows)]
    let output = command_output(
        "where.exe",
        &["opencode"],
        COMMAND_TIMEOUT,
        "OpenCode path check",
    )
    .await?;
    #[cfg(not(windows))]
    let output = command_output(
        "which",
        &["opencode"],
        COMMAND_TIMEOUT,
        "OpenCode path check",
    )
    .await?;
    if !output.status.success() {
        return Err("OpenCode CLI (`opencode`) is not installed or not on PATH.".into());
    }
    String::from_utf8_lossy(&output.stdout)
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .map(PathBuf::from)
        .ok_or_else(|| "OpenCode CLI path could not be resolved.".into())
}

async fn installed_version() -> Result<String, String> {
    let output = command_output(
        "opencode",
        &["--version"],
        COMMAND_TIMEOUT,
        "OpenCode version check",
    )
    .await?;
    if !output.status.success() {
        return Err(format!(
            "OpenCode version check failed: {}",
            output_text(&output)
        ));
    }
    normalize_version(&output_text(&output))
        .ok_or_else(|| "OpenCode returned an unreadable version.".into())
}

async fn fetch_latest_version() -> Option<String> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(4))
        .build()
        .ok()?;
    let response = client
        .get("https://registry.npmjs.org/opencode-ai/latest")
        .send()
        .await
        .ok()?
        .error_for_status()
        .ok()?;
    let value = response.json::<Value>().await.ok()?;
    value.get("version")?.as_str().and_then(normalize_version)
}

impl OpenCodeState {
    async fn register_approval(
        &self,
        stream_id: &str,
        tool_id: String,
        request_id: String,
        directory: String,
    ) {
        self.approvals.lock().await.insert(
            (stream_id.to_string(), tool_id),
            ApprovalBinding {
                request_id,
                directory,
            },
        );
    }
    async fn clear_replied_approval(&self, stream_id: &str, request_id: &str) {
        self.approvals
            .lock()
            .await
            .retain(|(owner_stream, _), binding| {
                owner_stream != stream_id || binding.request_id != request_id
            });
    }

    async fn clear_approvals_for_stream(&self, stream_id: &str) {
        self.approvals
            .lock()
            .await
            .retain(|(owner_stream, _), _| owner_stream != stream_id);
    }

    fn authenticated_get(&self, access: &RuntimeAccess, url: String) -> reqwest::RequestBuilder {
        self.http
            .get(url)
            .basic_auth(OPENCODE_SERVER_USERNAME, Some(&access.password))
    }

    fn get<'a>(&'a self, access: &'a RuntimeAccess, url: String) -> OpenCodeRequest<'a> {
        OpenCodeRequest {
            state: self,
            access,
            request: self.authenticated_get(access, url),
        }
    }

    fn post<'a>(&'a self, access: &'a RuntimeAccess, url: String) -> OpenCodeRequest<'a> {
        OpenCodeRequest {
            state: self,
            access,
            request: self
                .http
                .post(url)
                .basic_auth(OPENCODE_SERVER_USERNAME, Some(&access.password)),
        }
    }

    fn patch<'a>(&'a self, access: &'a RuntimeAccess, url: String) -> OpenCodeRequest<'a> {
        OpenCodeRequest {
            state: self,
            access,
            request: self
                .http
                .patch(url)
                .basic_auth(OPENCODE_SERVER_USERNAME, Some(&access.password)),
        }
    }

    async fn stream_lock(&self, stream_id: &str) -> Arc<Mutex<()>> {
        let mut locks = self.stream_locks.lock().await;
        locks.retain(|_, lock| lock.strong_count() > 0);
        if let Some(lock) = locks.get(stream_id).and_then(Weak::upgrade) {
            return lock;
        }
        let lock = Arc::new(Mutex::new(()));
        locks.insert(stream_id.to_string(), Arc::downgrade(&lock));
        lock
    }

    async fn latest_version(&self) -> Option<String> {
        if let Some((checked_at, version)) = self.latest_version.lock().await.as_ref() {
            if checked_at.elapsed() < LATEST_VERSION_TTL {
                return Some(version.clone());
            }
        }

        let version = fetch_latest_version().await?;
        *self.latest_version.lock().await = Some((Instant::now(), version.clone()));
        Some(version)
    }

    async fn endpoint_is_ready(&self, access: &RuntimeAccess) -> bool {
        self.authenticated_get(access, format!("{}/global/health", access.base_url))
            .timeout(Duration::from_millis(500))
            .send()
            .await
            .map(|response| response.status().is_success())
            .unwrap_or(false)
    }

    async fn validate_runtime_access(&self, access: &RuntimeAccess) -> Result<(), String> {
        let mut runtime = self.runtime.lock().await;
        let current = runtime
            .as_mut()
            .ok_or_else(|| "OpenCode runtime is no longer available.".to_string())?;
        if current.base_url != access.base_url || current.password != access.password {
            return Err("OpenCode runtime ownership changed during the request.".into());
        }
        if current
            .child
            .try_wait()
            .map_err(|error| format!("OpenCode process status: {error}"))?
            .is_some()
        {
            return Err("OpenCode runtime exited during the request.".into());
        }
        Ok(())
    }

    async fn ensure_runtime(&self) -> Result<RuntimeAccess, String> {
        let mut runtime = self.runtime.lock().await;
        if let Some(current) = runtime.as_mut() {
            let alive_before = current
                .child
                .try_wait()
                .map_err(|error| format!("OpenCode process status: {error}"))?
                .is_none();
            let access = current.access();
            let ready = alive_before && self.endpoint_is_ready(&access).await;
            let alive_after = ready
                && current
                    .child
                    .try_wait()
                    .map_err(|error| format!("OpenCode process status: {error}"))?
                    .is_none();
            if ready && alive_after {
                return Ok(access);
            }
            let _ = current.child.start_kill();
            *runtime = None;
        }

        let password = Alphanumeric.sample_string(&mut rand::rng(), 48);
        let mut command = server_command(&password);
        let mut child = command
            .spawn()
            .map_err(|error| format!("Could not start OpenCode server: {error}"))?;
        #[cfg(windows)]
        let job = match create_kill_on_close_job(&child) {
            Ok(job) => job,
            Err(error) => {
                let _ = child.kill().await;
                return Err(format!(
                    "Could not contain the OpenCode process tree: {error}"
                ));
            }
        };
        let mut stdout = match child.stdout.take() {
            Some(stdout) => stdout,
            None => {
                stop_child(
                    &mut child,
                    #[cfg(windows)]
                    &job,
                )
                .await;
                return Err("Could not read the OpenCode server endpoint.".into());
            }
        };
        let base_url =
            match tokio::time::timeout(STARTUP_TIMEOUT, read_server_base_url(&mut stdout)).await {
                Ok(Ok(base_url)) => base_url,
                Ok(Err(error)) => {
                    stop_child(
                        &mut child,
                        #[cfg(windows)]
                        &job,
                    )
                    .await;
                    return Err(error);
                }
                Err(_) => {
                    stop_child(
                        &mut child,
                        #[cfg(windows)]
                        &job,
                    )
                    .await;
                    return Err(
                        "OpenCode did not report its server endpoint within 5 seconds.".into(),
                    );
                }
            };
        let stdout_drain = tokio::spawn(async move {
            let mut sink = tokio::io::sink();
            let _ = tokio::io::copy(&mut stdout, &mut sink).await;
        });

        let access = RuntimeAccess {
            base_url: base_url.clone(),
            password,
        };
        for _ in 0..50 {
            if child
                .try_wait()
                .map_err(|error| format!("OpenCode process status: {error}"))?
                .is_some()
            {
                stdout_drain.abort();
                return Err("OpenCode server exited during startup.".into());
            }
            let ready = self.endpoint_is_ready(&access).await;
            let alive_after = child
                .try_wait()
                .map_err(|error| format!("OpenCode process status: {error}"))?
                .is_none();
            if ready && alive_after {
                *runtime = Some(OpenCodeRuntime {
                    child,
                    base_url: base_url.clone(),
                    password: access.password.clone(),
                    stdout_drain,
                    #[cfg(windows)]
                    job,
                });
                return Ok(access);
            }
            if !alive_after {
                stdout_drain.abort();
                return Err("OpenCode server exited during startup.".into());
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        stdout_drain.abort();
        stop_child(
            &mut child,
            #[cfg(windows)]
            &job,
        )
        .await;
        Err("OpenCode server did not become ready within 5 seconds.".into())
    }

    async fn stop_runtime(&self) {
        if let Some(mut runtime) = self.runtime.lock().await.take() {
            stop_child(
                &mut runtime.child,
                #[cfg(windows)]
                &runtime.job,
            )
            .await;
        }
        self.sessions.lock().await.clear();
        self.approvals.lock().await.clear();
        self.questions.lock().await.clear();
    }

    async fn status(&self, project_path: Option<String>) -> OpenCodeStatus {
        let checked_at = now_millis();
        let version = match installed_version().await {
            Ok(version) => version,
            Err(message) => {
                return OpenCodeStatus {
                    installed: false,
                    ready: false,
                    version: None,
                    latest_version: None,
                    update_available: false,
                    connected_providers: Vec::new(),
                    models: Vec::new(),
                    checked_at,
                    message,
                }
            }
        };
        let latest = self.latest_version().await;
        let below_minimum = newer_version(&version, MINIMUM_OPENCODE_VERSION);
        let update_available = below_minimum
            || latest
                .as_deref()
                .map(|candidate| newer_version(&version, candidate))
                .unwrap_or(false);
        if below_minimum {
            return OpenCodeStatus {
                installed: true,
                ready: false,
                version: Some(version),
                latest_version: latest,
                update_available,
                connected_providers: Vec::new(),
                models: Vec::new(),
                checked_at,
                message: format!(
                    "OpenCode {MINIMUM_OPENCODE_VERSION} or newer is required. Update OpenCode to continue."
                ),
            };
        }
        let runtime = match self.ensure_runtime().await {
            Ok(runtime) => runtime,
            Err(message) => {
                return OpenCodeStatus {
                    installed: true,
                    ready: false,
                    version: Some(version),
                    latest_version: latest,
                    update_available,
                    connected_providers: Vec::new(),
                    models: Vec::new(),
                    checked_at,
                    message,
                }
            }
        };
        let directory = project_path
            .filter(|path| !path.trim().is_empty())
            .unwrap_or_else(|| ".".into());
        let response = self
            .get(&runtime, format!("{}/provider", runtime.base_url))
            .query(&[("directory", directory.as_str())])
            .timeout(CONTROL_REQUEST_TIMEOUT)
            .send()
            .await;
        let inventory = match response {
            Ok(response) => match response.error_for_status() {
                Ok(response) => response
                    .json::<ProviderList>()
                    .await
                    .map_err(|error| error.to_string()),
                Err(error) => Err(error.to_string()),
            },
            Err(error) => Err(error),
        };
        let inventory = match inventory {
            Ok(inventory) => inventory,
            Err(error) => {
                return OpenCodeStatus {
                    installed: true,
                    ready: false,
                    version: Some(version),
                    latest_version: latest,
                    update_available,
                    connected_providers: Vec::new(),
                    models: Vec::new(),
                    checked_at,
                    message: format!("OpenCode provider inventory failed: {error}"),
                }
            }
        };
        let connected: HashSet<&str> = inventory.connected.iter().map(String::as_str).collect();
        let mut provider_names = Vec::new();
        let mut models = Vec::new();
        for provider in inventory.all {
            if !connected.contains(provider.id.as_str()) {
                continue;
            }
            provider_names.push(provider.name.clone());
            for model in provider.models.into_values() {
                if !model.capabilities.output.text {
                    continue;
                }
                let mut variants: Vec<String> = model
                    .variants
                    .keys()
                    .filter_map(|variant| match variant.as_str() {
                        "none" | "off" => Some("off".into()),
                        "low" | "medium" | "high" | "xhigh" | "max" | "ultra" => {
                            Some(variant.clone())
                        }
                        _ => None,
                    })
                    .collect();
                variants.sort();
                variants.dedup();
                models.push(OpenCodeModel {
                    id: format!("{}/{}", provider.id, model.id),
                    name: model.name,
                    upstream_provider: provider.id.clone(),
                    upstream_provider_name: provider.name.clone(),
                    context_window: model.limit.context,
                    variants,
                });
            }
        }
        provider_names.sort();
        models.sort_by_key(|model| model.name.to_lowercase());
        let count = provider_names.len();
        OpenCodeStatus {
            installed: true,
            ready: count > 0 && !models.is_empty(),
            version: Some(version),
            latest_version: latest,
            update_available,
            connected_providers: provider_names,
            models,
            checked_at,
            message: if count == 0 {
                "OpenCode is available, but it did not report any connected upstream providers."
                    .into()
            } else {
                format!(
                    "{count} upstream provider{} connected through OpenCode.",
                    if count == 1 { "" } else { "s" }
                )
            },
        }
    }

    #[allow(clippy::too_many_arguments)]
    async fn session_for(
        &self,
        runtime: &RuntimeAccess,
        stream_id: &str,
        directory: &str,
        model_provider: &str,
        model_id: &str,
        full_access: bool,
        permission: PermissionMode,
        agent: AgentMode,
    ) -> Result<String, String> {
        let permission_rules = session_permission_rules(permission, agent, full_access);
        let cached_binding = self.sessions.lock().await.get(stream_id).cloned();
        if let Some(binding) = cached_binding {
            if binding.directory == directory {
                let response = self
                    .patch(
                        runtime,
                        format!("{}/session/{}", runtime.base_url, binding.session_id),
                    )
                    .query(&[("directory", directory)])
                    .json(&json!({ "permission": permission_rules }))
                    .timeout(CONTROL_REQUEST_TIMEOUT)
                    .send()
                    .await
                    .map_err(|error| format!("OpenCode session update failed: {error}"))?;
                if response.status() == reqwest::StatusCode::NOT_FOUND {
                    self.sessions.lock().await.remove(stream_id);
                } else {
                    response
                        .error_for_status()
                        .map_err(|error| format!("OpenCode session update failed: {error}"))?;
                    return Ok(binding.session_id);
                }
            }
        }
        let title = format!("Open Xiao - {stream_id}");
        let sessions = self
            .get(runtime, format!("{}/session", runtime.base_url))
            .query(&[
                ("directory", directory),
                ("search", title.as_str()),
                ("limit", "20"),
            ])
            .timeout(CONTROL_REQUEST_TIMEOUT)
            .send()
            .await
            .map_err(|error| format!("OpenCode session lookup failed: {error}"))?
            .error_for_status()
            .map_err(|error| format!("OpenCode session lookup failed: {error}"))?
            .json::<Vec<SessionRecord>>()
            .await
            .map_err(|error| format!("OpenCode session lookup was unreadable: {error}"))?;
        let session_id = if let Some(existing) =
            sessions.into_iter().find(|item| item.title == title)
        {
            self.patch(
                runtime,
                format!("{}/session/{}", runtime.base_url, existing.id),
            )
            .query(&[("directory", directory)])
            .json(&json!({ "permission": permission_rules }))
            .timeout(CONTROL_REQUEST_TIMEOUT)
            .send()
            .await
            .map_err(|error| format!("OpenCode session update failed: {error}"))?
            .error_for_status()
            .map_err(|error| format!("OpenCode session update failed: {error}"))?;
            existing.id
        } else {
            let body = json!({
                "title": title,
                "agent": match agent { AgentMode::Plan => "plan", AgentMode::Build => "build" },
                "model": { "id": model_id, "providerID": model_provider },
                "permission": permission_rules
            });
            let value = self
                .post(runtime, format!("{}/session", runtime.base_url))
                .query(&[("directory", directory)])
                .json(&body)
                .timeout(CONTROL_REQUEST_TIMEOUT)
                .send()
                .await
                .map_err(|error| format!("OpenCode session creation failed: {error}"))?
                .error_for_status()
                .map_err(|error| format!("OpenCode session creation failed: {error}"))?
                .json::<Value>()
                .await
                .map_err(|error| format!("OpenCode session response was unreadable: {error}"))?;
            value
                .get("id")
                .and_then(Value::as_str)
                .map(str::to_string)
                .ok_or_else(|| "OpenCode did not return a session id.".to_string())?
        };
        self.sessions.lock().await.insert(
            stream_id.to_string(),
            SessionBinding {
                session_id: session_id.clone(),
                directory: directory.to_string(),
            },
        );
        Ok(session_id)
    }

    async fn reply_permission(
        &self,
        stream_id: &str,
        tool_id: &str,
        reply: &str,
    ) -> Result<bool, String> {
        let key = (stream_id.to_string(), tool_id.to_string());
        let binding = self.approvals.lock().await.get(&key).cloned();
        let Some(binding) = binding else {
            return Ok(false);
        };
        let runtime = self.ensure_runtime().await?;
        self.post(
            &runtime,
            format!(
                "{}/permission/{}/reply",
                runtime.base_url, binding.request_id
            ),
        )
        .query(&[("directory", binding.directory.as_str())])
        .json(&json!({ "reply": reply }))
        .timeout(CONTROL_REQUEST_TIMEOUT)
        .send()
        .await
        .map_err(|error| format!("OpenCode permission reply failed: {error}"))?
        .error_for_status()
        .map_err(|error| format!("OpenCode permission reply failed: {error}"))?;
        let mut approvals = self.approvals.lock().await;
        if approvals.get(&key).is_some_and(|current| {
            current.request_id == binding.request_id && current.directory == binding.directory
        }) {
            approvals.remove(&key);
        }
        Ok(true)
    }

    async fn reply_question(
        &self,
        stream_id: &str,
        request_id: &str,
        answers: &[Vec<String>],
    ) -> Result<bool, String> {
        let binding = self.questions.lock().await.get(request_id).cloned();
        let Some(binding) = binding else {
            return Ok(false);
        };
        if binding.stream_id != stream_id {
            return Ok(false);
        }
        if answers.len() != binding.question_count {
            return Err(format!(
                "OpenCode expected {} answer set(s), received {}.",
                binding.question_count,
                answers.len()
            ));
        }
        let runtime = self.ensure_runtime().await?;
        self.post(
            &runtime,
            format!("{}/question/{request_id}/reply", runtime.base_url),
        )
        .query(&[("directory", binding.directory.as_str())])
        .json(&json!({ "answers": answers }))
        .timeout(CONTROL_REQUEST_TIMEOUT)
        .send()
        .await
        .map_err(|error| format!("OpenCode question reply failed: {error}"))?
        .error_for_status()
        .map_err(|error| format!("OpenCode question reply failed: {error}"))?;
        self.questions.lock().await.remove(request_id);
        Ok(true)
    }

    async fn reject_question(&self, stream_id: &str, request_id: &str) -> Result<bool, String> {
        let binding = self.questions.lock().await.get(request_id).cloned();
        let Some(binding) = binding else {
            return Ok(false);
        };
        if binding.stream_id != stream_id {
            return Ok(false);
        }
        let runtime = self.ensure_runtime().await?;
        self.post(
            &runtime,
            format!("{}/question/{request_id}/reject", runtime.base_url),
        )
        .query(&[("directory", binding.directory.as_str())])
        .timeout(CONTROL_REQUEST_TIMEOUT)
        .send()
        .await
        .map_err(|error| format!("OpenCode question rejection failed: {error}"))?
        .error_for_status()
        .map_err(|error| format!("OpenCode question rejection failed: {error}"))?;
        self.questions.lock().await.remove(request_id);
        Ok(true)
    }
}

#[tauri::command]
pub async fn opencode_status(
    state: tauri::State<'_, OpenCodeState>,
    project_path: Option<String>,
) -> Result<OpenCodeStatus, String> {
    Ok(state.status(project_path).await)
}

#[tauri::command]
pub async fn opencode_update(
    state: tauri::State<'_, OpenCodeState>,
    project_path: Option<String>,
) -> Result<OpenCodeUpdateResult, String> {
    let _guard = state.update_lock.lock().await;
    let path = opencode_path().await?;
    state.stop_runtime().await;
    let mut args = vec!["upgrade"];
    if let Some(method) = update_method(&path) {
        args.extend(["--method", method]);
    }
    let output = command_output("opencode", &args, UPDATE_TIMEOUT, "OpenCode update").await?;
    let text = output_text(&output);
    if !output.status.success() {
        return Err(format!("OpenCode update failed: {text}"));
    }
    let status = state.status(project_path).await;
    if status.update_available {
        return Err(format!(
            "OpenCode update finished, but version {} is still behind {}.\n{}",
            status.version.as_deref().unwrap_or("unknown"),
            status.latest_version.as_deref().unwrap_or("latest"),
            text
        ));
    }
    Ok(OpenCodeUpdateResult {
        status,
        output: text.chars().take(10_000).collect(),
    })
}

pub async fn approve_tool(
    state: &OpenCodeState,
    stream_id: &str,
    tool_id: &str,
) -> Result<bool, String> {
    state.reply_permission(stream_id, tool_id, "once").await
}

pub async fn deny_tool(
    state: &OpenCodeState,
    stream_id: &str,
    tool_id: &str,
) -> Result<bool, String> {
    state.reply_permission(stream_id, tool_id, "reject").await
}

pub async fn answer_question(
    state: &OpenCodeState,
    stream_id: &str,
    request_id: &str,
    answers: &[Vec<String>],
) -> Result<bool, String> {
    state.reply_question(stream_id, request_id, answers).await
}

pub async fn reject_question(
    state: &OpenCodeState,
    stream_id: &str,
    request_id: &str,
) -> Result<bool, String> {
    state.reject_question(stream_id, request_id).await
}

pub async fn clear_questions_for_stream(state: &OpenCodeState, stream_id: &str) {
    state
        .questions
        .lock()
        .await
        .retain(|_, binding| binding.stream_id != stream_id);
}

fn event_session_id(event: &Value) -> Option<&str> {
    event
        .pointer("/properties/sessionID")
        .and_then(Value::as_str)
        .or_else(|| {
            event
                .pointer("/properties/part/sessionID")
                .and_then(Value::as_str)
        })
}

fn value_text(value: &Value) -> String {
    value
        .as_str()
        .map(str::to_string)
        .unwrap_or_else(|| value.to_string())
}

fn event_request_id(event: &Value) -> Option<&str> {
    event
        .pointer("/properties/id")
        .and_then(Value::as_str)
        .or_else(|| {
            event
                .pointer("/properties/requestID")
                .and_then(Value::as_str)
        })
        .filter(|value| !value.trim().is_empty())
}

fn question_request(event: &Value) -> Option<(String, Vec<UserInputQuestion>)> {
    let request_id = event_request_id(event)?.to_string();
    let raw_questions = event.pointer("/properties/questions")?.as_array()?;
    let mut questions = Vec::with_capacity(raw_questions.len());
    for raw in raw_questions {
        let header = raw.get("header")?.as_str()?.trim();
        let question = raw.get("question")?.as_str()?.trim();
        if header.is_empty() || question.is_empty() {
            return None;
        }
        let options = raw
            .get("options")
            .and_then(Value::as_array)
            .map(|items| {
                items
                    .iter()
                    .filter_map(|option| {
                        let label = option.get("label")?.as_str()?.trim();
                        if label.is_empty() {
                            return None;
                        }
                        Some(UserInputOption {
                            label: label.to_string(),
                            description: option
                                .get("description")
                                .and_then(Value::as_str)
                                .unwrap_or_default()
                                .trim()
                                .to_string(),
                        })
                    })
                    .collect()
            })
            .unwrap_or_default();
        questions.push(UserInputQuestion {
            header: header.to_string(),
            question: question.to_string(),
            options,
            multiple: raw
                .get("multiple")
                .and_then(Value::as_bool)
                .unwrap_or(false),
            custom: raw.get("custom").and_then(Value::as_bool).unwrap_or(true),
        });
    }
    if questions.is_empty() {
        return None;
    }
    Some((request_id, questions))
}

#[derive(Clone, Debug, Eq, PartialEq)]
enum OpenCodeEventRoute {
    Root,
    Child { parent_tool_id: String },
    Ignore,
}

#[derive(Default)]
struct OpenCodeEventRouter {
    child_parent_tools: HashMap<String, String>,
}

impl OpenCodeEventRouter {
    fn route(&mut self, root_session_id: &str, event: &Value) -> OpenCodeEventRoute {
        let Some(event_session_id) = event_session_id(event) else {
            return OpenCodeEventRoute::Ignore;
        };
        let route = if event_session_id == root_session_id {
            OpenCodeEventRoute::Root
        } else if let Some(parent_tool_id) = self.child_parent_tools.get(event_session_id) {
            OpenCodeEventRoute::Child {
                parent_tool_id: parent_tool_id.clone(),
            }
        } else {
            OpenCodeEventRoute::Ignore
        };

        let part = &event["properties"]["part"];
        if event.get("type").and_then(Value::as_str) == Some("message.part.updated")
            && part.get("type").and_then(Value::as_str) == Some("tool")
            && part.get("tool").and_then(Value::as_str) == Some("task")
            && part
                .pointer("/state/metadata/parentSessionId")
                .and_then(Value::as_str)
                == Some(event_session_id)
        {
            let child_session_id = part
                .pointer("/state/metadata/sessionId")
                .and_then(Value::as_str)
                .filter(|value| !value.is_empty());
            let call_id = part
                .get("callID")
                .and_then(Value::as_str)
                .or_else(|| part.get("id").and_then(Value::as_str))
                .filter(|value| !value.is_empty());
            if let (Some(child_session_id), Some(call_id)) = (child_session_id, call_id) {
                let task_tool_id = match &route {
                    OpenCodeEventRoute::Root => call_id.to_string(),
                    OpenCodeEventRoute::Child { parent_tool_id } => {
                        format!("{parent_tool_id}::{call_id}")
                    }
                    OpenCodeEventRoute::Ignore => return route,
                };
                self.child_parent_tools
                    .insert(child_session_id.to_string(), task_tool_id);
            }
        }

        route
    }

    #[cfg(test)]
    fn tool_events(
        &mut self,
        root_session_id: &str,
        event: &Value,
        started_tools: &mut HashSet<String>,
        finished_tools: &mut HashSet<String>,
    ) -> Vec<StreamEvent> {
        let route = self.route(root_session_id, event);
        Self::tool_events_for_route(event, route, started_tools, finished_tools)
    }

    fn tool_events_for_route(
        event: &Value,
        route: OpenCodeEventRoute,
        started_tools: &mut HashSet<String>,
        finished_tools: &mut HashSet<String>,
    ) -> Vec<StreamEvent> {
        let part = &event["properties"]["part"];
        if event.get("type").and_then(Value::as_str) != Some("message.part.updated")
            || part.get("type").and_then(Value::as_str) != Some("tool")
            || route == OpenCodeEventRoute::Ignore
        {
            return Vec::new();
        }

        let part_id = part.get("id").and_then(Value::as_str).unwrap_or("");
        let call_id = part
            .get("callID")
            .and_then(Value::as_str)
            .unwrap_or(part_id);
        if call_id.is_empty() {
            return Vec::new();
        }
        let (tool_id, parent_id) = match route {
            OpenCodeEventRoute::Root => (call_id.to_string(), None),
            OpenCodeEventRoute::Child { parent_tool_id } => {
                (format!("{parent_tool_id}::{call_id}"), Some(parent_tool_id))
            }
            OpenCodeEventRoute::Ignore => return Vec::new(),
        };
        let tool = part.get("tool").and_then(Value::as_str).unwrap_or("tool");
        let status = part
            .pointer("/state/status")
            .and_then(Value::as_str)
            .unwrap_or("");
        let mut events = Vec::new();
        if matches!(status, "pending" | "running" | "completed" | "error")
            && started_tools.insert(tool_id.clone())
        {
            let args = part
                .pointer("/state/input")
                .map(value_text)
                .unwrap_or_else(|| "{}".into());
            events.push(StreamEvent::ToolStart {
                id: tool_id.clone(),
                name: tool.to_string(),
                args: truncate_provider_output(&redact_tool_arguments(&args)),
                awaiting_approval: false,
                approval_reason: None,
                parent_id: parent_id.clone(),
            });
        }
        if matches!(status, "completed" | "error") && finished_tools.insert(tool_id.clone()) {
            let ok = status == "completed";
            let result = if ok {
                part.pointer("/state/output")
            } else {
                part.pointer("/state/error")
            }
            .map(value_text)
            .unwrap_or_default();
            events.push(StreamEvent::ToolResult {
                id: tool_id,
                name: tool.to_string(),
                ok,
                result: truncate_provider_output(&redact_secrets(&result)),
                parent_id,
                image_url: None,
            });
        }
        events
    }
}

fn prompt_body(
    model_provider: &str,
    model_id: &str,
    prompt: &str,
    system: &str,
    reasoning_effort: Option<&str>,
    agent: AgentMode,
) -> Value {
    let mut body = json!({
        "model": { "providerID": model_provider, "modelID": model_id },
        "agent": match agent { AgentMode::Plan => "plan", AgentMode::Build => "build" },
        "system": system,
        "parts": [{ "type": "text", "text": prompt }]
    });
    if let Some(variant) = reasoning_effort.filter(|value| *value != "off") {
        body["variant"] = Value::String(variant.to_string());
    }
    body
}

fn agent_tool_mcp_config(connection: crate::agent_tools::AgentToolMcpConnection) -> Value {
    json!({
        "name": APP_TOOL_MCP_NAME,
        "config": {
            "type": "remote",
            "url": connection.endpoint,
            "headers": { "Authorization": connection.authorization },
            "enabled": true
        }
    })
}

async fn abort_session(
    state: &OpenCodeState,
    runtime: &RuntimeAccess,
    session_id: &str,
    directory: &str,
) {
    let _ = state
        .post(
            runtime,
            format!("{}/session/{session_id}/abort", runtime.base_url),
        )
        .query(&[("directory", directory)])
        .timeout(ABORT_REQUEST_TIMEOUT)
        .send()
        .await;
}

enum OpenCodeSessionExit {
    Completed,
    Cancelled,
    Failed(String),
}

enum OpenCodeEventItem<T> {
    Chunk(T),
    Cancelled,
    Failed(String),
}

async fn next_open_code_event_item<S, T, E>(
    stream: &mut S,
    stop: StopCheck<'_>,
    idle_timeout: Duration,
) -> OpenCodeEventItem<T>
where
    S: futures_util::Stream<Item = Result<T, E>> + Unpin,
    E: std::fmt::Display,
{
    let deadline = Instant::now() + idle_timeout;
    loop {
        if stop() {
            return OpenCodeEventItem::Cancelled;
        }
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return OpenCodeEventItem::Failed("OpenCode event stream stalled.".into());
        }
        match tokio::time::timeout(remaining.min(Duration::from_millis(100)), stream.next()).await {
            Err(_) => continue,
            Ok(Some(Ok(chunk))) => return OpenCodeEventItem::Chunk(chunk),
            Ok(Some(Err(error))) => {
                if stop() {
                    return OpenCodeEventItem::Cancelled;
                }
                return OpenCodeEventItem::Failed(format!("OpenCode event stream failed: {error}"));
            }
            Ok(None) => {
                if stop() {
                    return OpenCodeEventItem::Cancelled;
                }
                return OpenCodeEventItem::Failed(
                    "OpenCode event stream ended before the session became idle.".into(),
                );
            }
        }
    }
}

async fn finish_session_stream(
    state: &OpenCodeState,
    runtime: &RuntimeAccess,
    session_id: &str,
    directory: &str,
    exit: OpenCodeSessionExit,
) -> Result<(), String> {
    match exit {
        OpenCodeSessionExit::Completed => Ok(()),
        OpenCodeSessionExit::Cancelled => {
            abort_session(state, runtime, session_id, directory).await;
            Ok(())
        }
        OpenCodeSessionExit::Failed(error) => {
            abort_session(state, runtime, session_id, directory).await;
            Err(error)
        }
    }
}

#[allow(clippy::too_many_arguments)]
pub async fn stream_chat(
    app: &AppHandle,
    state: &OpenCodeState,
    stream_id: &str,
    raw_model: &str,
    prompt: &str,
    system: &str,
    enable_app_tools: bool,
    reasoning_effort: Option<&str>,
    directory: &Path,
    full_access: bool,
    permission: PermissionMode,
    agent: AgentMode,
    on_chunk: &Channel<StreamEvent>,
    stop: StopCheck<'_>,
) -> Result<(), String> {
    if stop() {
        return Ok(());
    }
    let stream_lock = state.stream_lock(stream_id).await;
    let _stream_guard = stream_lock.lock().await;
    state.clear_approvals_for_stream(stream_id).await;
    if stop() {
        return Ok(());
    }
    let model_slug = raw_model
        .trim()
        .strip_prefix(OPENCODE_MODEL_PREFIX)
        .ok_or_else(|| "Invalid OpenCode model id.".to_string())?;
    let (model_provider, model_id) = model_slug
        .split_once('/')
        .filter(|(provider, model)| !provider.is_empty() && !model.is_empty())
        .ok_or_else(|| "OpenCode model must use provider/model format.".to_string())?;
    let directory = directory.to_string_lossy().to_string();
    let runtime = state.ensure_runtime().await?;
    if stop() {
        return Ok(());
    }
    if enable_app_tools {
        let connection = app
            .state::<crate::agent_tools::AgentToolMcpState>()
            .connection_for(Path::new(&directory))?;
        state
            .post(&runtime, format!("{}/mcp", runtime.base_url))
            .query(&[("directory", directory.as_str())])
            .json(&agent_tool_mcp_config(connection))
            .timeout(CONTROL_REQUEST_TIMEOUT)
            .send()
            .await
            .map_err(|error| format!("Could not connect application tools to OpenCode: {error}"))?
            .error_for_status()
            .map_err(|error| format!("Could not connect application tools to OpenCode: {error}"))?;
        if stop() {
            return Ok(());
        }
    }
    let session_id = state
        .session_for(
            &runtime,
            stream_id,
            &directory,
            model_provider,
            model_id,
            full_access,
            permission,
            agent,
        )
        .await?;
    if stop() {
        abort_session(state, &runtime, &session_id, &directory).await;
        return Ok(());
    }
    let response = state
        .get(&runtime, format!("{}/event", runtime.base_url))
        .query(&[("directory", directory.as_str())])
        .send()
        .await
        .map_err(|error| format!("OpenCode event stream failed: {error}"))?
        .error_for_status()
        .map_err(|error| format!("OpenCode event stream failed: {error}"))?;
    if stop() {
        abort_session(state, &runtime, &session_id, &directory).await;
        return Ok(());
    }
    let body = prompt_body(
        model_provider,
        model_id,
        prompt,
        system,
        reasoning_effort,
        agent,
    );
    let prompt_result = state
        .post(
            &runtime,
            format!("{}/session/{session_id}/prompt_async", runtime.base_url),
        )
        .query(&[("directory", directory.as_str())])
        .json(&body)
        .timeout(CONTROL_REQUEST_TIMEOUT)
        .send()
        .await;
    let prompt_result = match prompt_result {
        Ok(response) => response
            .error_for_status()
            .map(|_| ())
            .map_err(|error| format!("OpenCode prompt failed: {error}")),
        Err(error) => Err(format!("OpenCode prompt failed: {error}")),
    };
    if let Err(error) = prompt_result {
        return finish_session_stream(
            state,
            &runtime,
            &session_id,
            &directory,
            OpenCodeSessionExit::Failed(error),
        )
        .await;
    }
    if stop() {
        return finish_session_stream(
            state,
            &runtime,
            &session_id,
            &directory,
            OpenCodeSessionExit::Cancelled,
        )
        .await;
    }

    let mut stream = response.bytes_stream();
    let mut event_lines = ProviderLineBuffer::default();
    let mut part_types: HashMap<String, String> = HashMap::new();
    let mut started_tools = HashSet::new();
    let mut finished_tools = HashSet::new();
    let mut event_router = OpenCodeEventRouter::default();
    let exit = 'events: loop {
        let chunk =
            match next_open_code_event_item(&mut stream, stop, EVENT_STREAM_IDLE_TIMEOUT).await {
                OpenCodeEventItem::Chunk(chunk) => chunk,
                OpenCodeEventItem::Cancelled => break OpenCodeSessionExit::Cancelled,
                OpenCodeEventItem::Failed(error) => break OpenCodeSessionExit::Failed(error),
            };
        let lines = match event_lines.push(&chunk) {
            Ok(lines) => lines,
            Err(error) => {
                break OpenCodeSessionExit::Failed(format!(
                    "OpenCode event stream rejected: {error}"
                ));
            }
        };
        for line in lines {
            let Some(data) = line.strip_prefix("data:") else {
                continue;
            };
            let event: Value = match serde_json::from_str(data.trim()) {
                Ok(event) => event,
                Err(_) => continue,
            };
            let route = event_router.route(&session_id, &event);
            if route == OpenCodeEventRoute::Ignore {
                continue;
            }
            let is_root_event = route == OpenCodeEventRoute::Root;
            let event_type = event.get("type").and_then(Value::as_str).unwrap_or("");
            match event_type {
                "message.part.updated" => {
                    let part = &event["properties"]["part"];
                    let part_id = part.get("id").and_then(Value::as_str).unwrap_or("");
                    let part_type = part.get("type").and_then(Value::as_str).unwrap_or("");
                    if is_root_event && !part_id.is_empty() && !part_type.is_empty() {
                        part_types.insert(part_id.to_string(), part_type.to_string());
                    }
                    for tool_event in OpenCodeEventRouter::tool_events_for_route(
                        &event,
                        route.clone(),
                        &mut started_tools,
                        &mut finished_tools,
                    ) {
                        let _ = on_chunk.send(tool_event);
                    }
                }
                "message.part.delta" => {
                    if !is_root_event {
                        continue;
                    }
                    let properties = &event["properties"];
                    let part_id = properties
                        .get("partID")
                        .and_then(Value::as_str)
                        .unwrap_or("");
                    let delta = properties
                        .get("delta")
                        .and_then(Value::as_str)
                        .unwrap_or("");
                    if delta.is_empty() {
                        continue;
                    }
                    match part_types.get(part_id).map(String::as_str) {
                        Some("reasoning") => {
                            let _ = on_chunk.send(StreamEvent::Thinking {
                                text: truncate_provider_output(delta),
                            });
                        }
                        Some("text") => {
                            let _ = on_chunk.send(StreamEvent::Content {
                                text: truncate_provider_output(delta),
                            });
                        }
                        _ => {}
                    }
                }
                "permission.asked" => {
                    let properties = &event["properties"];
                    let Some(request_id) = event_request_id(&event) else {
                        continue;
                    };
                    let call_id = properties
                        .pointer("/tool/callID")
                        .and_then(Value::as_str)
                        .filter(|value| !value.is_empty());
                    let local_tool_id = call_id
                        .map(str::to_string)
                        .unwrap_or_else(|| format!("opencode:{request_id}"));
                    let (tool_id, parent_id) = match &route {
                        OpenCodeEventRoute::Root => (local_tool_id, None),
                        OpenCodeEventRoute::Child { parent_tool_id } => (
                            format!("{parent_tool_id}::{local_tool_id}"),
                            Some(parent_tool_id.clone()),
                        ),
                        OpenCodeEventRoute::Ignore => continue,
                    };
                    state
                        .register_approval(
                            stream_id,
                            tool_id.clone(),
                            request_id.to_string(),
                            directory.clone(),
                        )
                        .await;
                    let name = properties
                        .get("permission")
                        .and_then(Value::as_str)
                        .unwrap_or("permission");
                    let args = properties
                        .get("patterns")
                        .map(value_text)
                        .unwrap_or_else(|| "[]".into());
                    let _ = on_chunk.send(StreamEvent::ToolStart {
                        id: tool_id,
                        name: name.to_string(),
                        args: redact_tool_arguments(&args),
                        awaiting_approval: true,
                        approval_reason: Some(format!("OpenCode requests {name} permission")),
                        parent_id,
                    });
                }
                "permission.replied" => {
                    if let Some(request_id) = event
                        .pointer("/properties/requestID")
                        .and_then(Value::as_str)
                    {
                        state.clear_replied_approval(stream_id, request_id).await;
                    }
                }
                "question.asked" => {
                    let Some((request_id, questions)) = question_request(&event) else {
                        continue;
                    };
                    state.questions.lock().await.insert(
                        request_id.clone(),
                        QuestionBinding {
                            stream_id: stream_id.to_string(),
                            directory: directory.clone(),
                            question_count: questions.len(),
                        },
                    );
                    let _ = on_chunk.send(StreamEvent::UserInputRequested {
                        request_id,
                        questions,
                    });
                }
                "question.replied" | "question.rejected" => {
                    if let Some(request_id) = event
                        .pointer("/properties/requestID")
                        .and_then(Value::as_str)
                    {
                        state.questions.lock().await.remove(request_id);
                        let _ = on_chunk.send(StreamEvent::UserInputResolved {
                            request_id: request_id.to_string(),
                        });
                    }
                }
                "session.error" if is_root_event => {
                    let error = event
                        .pointer("/properties/error/data/message")
                        .or_else(|| event.pointer("/properties/error/name"))
                        .map(value_text)
                        .unwrap_or_else(|| "OpenCode session failed.".into());
                    break 'events OpenCodeSessionExit::Failed(error);
                }
                "session.idle" if is_root_event => break 'events OpenCodeSessionExit::Completed,
                "session.status"
                    if is_root_event
                        && event
                            .pointer("/properties/status/type")
                            .and_then(Value::as_str)
                            == Some("idle") =>
                {
                    break 'events OpenCodeSessionExit::Completed
                }
                _ => {}
            }
        }
    };
    state.clear_approvals_for_stream(stream_id).await;
    finish_session_stream(state, &runtime, &session_id, &directory, exit).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn same_stream_setup_is_serialized_until_the_owner_releases_it() {
        use std::sync::atomic::{AtomicBool, Ordering};

        let state = OpenCodeState::default();
        let first = state.stream_lock("thread-1").await;
        let second = state.stream_lock("thread-1").await;
        let other = state.stream_lock("thread-2").await;
        assert!(Arc::ptr_eq(&first, &second));
        assert!(!Arc::ptr_eq(&first, &other));

        let first_guard = first.lock().await;
        let entered = Arc::new(AtomicBool::new(false));
        let entered_task = Arc::clone(&entered);
        let task = tokio::spawn(async move {
            let _guard = second.lock().await;
            entered_task.store(true, Ordering::SeqCst);
        });
        tokio::time::sleep(Duration::from_millis(25)).await;
        assert!(!entered.load(Ordering::SeqCst));
        drop(first_guard);
        task.await.unwrap();
        assert!(entered.load(Ordering::SeqCst));
    }

    #[test]
    fn server_runs_in_pure_mode_with_an_os_assigned_port() {
        let args = server_args();
        assert!(args.iter().any(|arg| arg == "--pure"));
        let port = args
            .iter()
            .position(|arg| arg == "--port")
            .and_then(|index| args.get(index + 1));
        assert_eq!(port.map(String::as_str), Some("0"));
    }

    #[test]
    fn server_does_not_inherit_the_host_launchers_working_directory() {
        let command = server_command("test-password");
        assert_eq!(
            command.as_std().get_current_dir(),
            Some(std::env::temp_dir().as_path())
        );
    }

    #[tokio::test]
    async fn runtime_http_client_authenticates_every_request() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind test server");
        let address = listener.local_addr().expect("test server address");
        let request = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.expect("accept request");
            let mut bytes = vec![0_u8; 4096];
            let read = socket.read(&mut bytes).await.expect("read request");
            socket
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
                .await
                .expect("write response");
            String::from_utf8_lossy(&bytes[..read]).into_owned()
        });

        let state = OpenCodeState::default();
        let access = RuntimeAccess {
            base_url: format!("http://{address}"),
            password: "test-password".into(),
        };
        state
            .authenticated_get(&access, format!("http://{address}/health"))
            .send()
            .await
            .expect("send authenticated request");
        let request = request.await.expect("join test server");

        assert!(
            request
                .to_ascii_lowercase()
                .contains("\r\nauthorization: basic "),
            "request did not contain Basic authentication: {request}"
        );
    }

    #[tokio::test]
    async fn nonterminal_event_stream_exit_posts_session_abort() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind fake OpenCode endpoint");
        let address = listener.local_addr().expect("fake endpoint address");
        let server = tokio::spawn(async move {
            let mut requests = Vec::new();
            for response in [
                b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
                    .as_slice(),
                b"HTTP/1.1 200 OK\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
                    .as_slice(),
            ] {
                let (mut socket, _) =
                    tokio::time::timeout(Duration::from_secs(2), listener.accept())
                        .await
                        .expect("OpenCode request timeout")
                        .expect("accept OpenCode request");
                let mut bytes = vec![0_u8; 4096];
                let read = socket.read(&mut bytes).await.expect("read OpenCode request");
                requests.push(String::from_utf8_lossy(&bytes[..read]).into_owned());
                socket
                    .write_all(response)
                    .await
                    .expect("write OpenCode response");
            }
            requests
        });

        let executable = std::env::current_exe().expect("test executable");
        let mut command = hidden_command(&executable);
        command
            .args([
                "--ignored",
                "--exact",
                "opencode::tests::hold_runtime_process_for_parent_test",
                "--nocapture",
            ])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .kill_on_drop(true);
        let child = command.spawn().expect("spawn runtime owner");
        #[cfg(windows)]
        let job = create_kill_on_close_job(&child).expect("contain runtime owner");

        let access = RuntimeAccess {
            base_url: format!("http://{address}"),
            password: "abort-test-password".into(),
        };
        let state = OpenCodeState::default();
        *state.runtime.lock().await = Some(OpenCodeRuntime {
            child,
            base_url: access.base_url.clone(),
            password: access.password.clone(),
            stdout_drain: tokio::spawn(async {}),
            #[cfg(windows)]
            job,
        });

        let response = state
            .get(&access, format!("{}/event", access.base_url))
            .send()
            .await
            .expect("open local event stream")
            .error_for_status()
            .expect("local event stream status");
        let mut event_stream = response.bytes_stream();
        let exit = match next_open_code_event_item(
            &mut event_stream,
            &|| false,
            EVENT_STREAM_IDLE_TIMEOUT,
        )
        .await
        {
            OpenCodeEventItem::Failed(error) => OpenCodeSessionExit::Failed(error),
            _ => panic!("clean event-stream EOF must be a nonterminal failure"),
        };
        let error = finish_session_stream(&state, &access, "session-eof", "C:/workspace", exit)
            .await
            .expect_err("nonterminal stream exit must remain an error");
        let requests = server.await.expect("join fake OpenCode endpoint");
        state.stop_runtime().await;

        assert!(error.contains("ended before the session became idle"));
        assert!(
            requests[0].starts_with("GET /event HTTP/1.1"),
            "event stream was not opened: {}",
            requests[0]
        );
        assert!(
            requests[1]
                .starts_with("POST /session/session-eof/abort?directory=C%3A%2Fworkspace HTTP/1.1"),
            "abort endpoint was not called: {}",
            requests[1]
        );
    }

    #[tokio::test]
    async fn silent_event_stream_expires_at_its_idle_deadline() {
        let mut stream = futures_util::stream::pending::<Result<Vec<u8>, String>>();
        let started = Instant::now();
        let item =
            next_open_code_event_item(&mut stream, &|| false, Duration::from_millis(20)).await;

        assert!(matches!(
            item,
            OpenCodeEventItem::Failed(error) if error.contains("stalled")
        ));
        assert!(started.elapsed() < Duration::from_secs(1));
    }

    #[tokio::test]
    async fn child_reported_endpoint_bypasses_preexisting_loopback_impersonator() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};

        let impersonator = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind impersonator");
        let impersonator_address = impersonator.local_addr().expect("impersonator address");
        let intended = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind intended child endpoint");
        let intended_address = intended.local_addr().expect("intended child address");
        let intended_request = tokio::spawn(async move {
            let (mut socket, _) = intended.accept().await.expect("accept intended probe");
            let mut bytes = vec![0_u8; 4096];
            let read = socket.read(&mut bytes).await.expect("read intended probe");
            socket
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
                .await
                .expect("write intended response");
            String::from_utf8_lossy(&bytes[..read]).into_owned()
        });

        let (mut report_reader, mut report_writer) = tokio::io::duplex(256);
        report_writer
            .write_all(
                format!("opencode server listening on http://{intended_address}\n").as_bytes(),
            )
            .await
            .expect("write child endpoint report");
        drop(report_writer);

        let base_url = read_server_base_url(&mut report_reader)
            .await
            .expect("read child-owned endpoint");
        assert_eq!(base_url, format!("http://{intended_address}"));
        assert_ne!(base_url, format!("http://{impersonator_address}"));

        let state = OpenCodeState::default();
        let access = RuntimeAccess {
            base_url,
            password: "test-password".into(),
        };
        assert!(state.endpoint_is_ready(&access).await);
        let request = intended_request.await.expect("join intended server");
        assert!(request
            .to_ascii_lowercase()
            .contains("authorization: basic "));
        assert!(
            tokio::time::timeout(Duration::from_millis(100), impersonator.accept())
                .await
                .is_err(),
            "the pre-existing loopback impersonator received a startup probe"
        );
    }

    #[test]
    #[ignore]
    fn hold_runtime_process_for_parent_test() {
        std::thread::sleep(Duration::from_secs(60));
    }

    #[tokio::test]
    async fn post_health_port_reuse_cannot_impersonate_runtime() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        use tokio::io::{AsyncReadExt, AsyncWriteExt};

        let legitimate = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind legitimate runtime endpoint");
        let address = legitimate.local_addr().expect("legitimate address");
        let legitimate_probe = tokio::spawn(async move {
            let (mut socket, _) = legitimate.accept().await.expect("accept health probe");
            let mut request = vec![0_u8; 4096];
            let _ = socket.read(&mut request).await.expect("read health probe");
            socket
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
                .await
                .expect("write health response");
        });

        let executable = std::env::current_exe().expect("test executable");
        let mut command = hidden_command(&executable);
        command
            .args([
                "--ignored",
                "--exact",
                "opencode::tests::hold_runtime_process_for_parent_test",
                "--nocapture",
            ])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .kill_on_drop(true);
        let child = command.spawn().expect("spawn runtime owner");
        #[cfg(windows)]
        let job = create_kill_on_close_job(&child).expect("contain runtime owner");

        let base_url = format!("http://{address}");
        let password = "port-reuse-test-password".to_string();
        let state = OpenCodeState::default();
        *state.runtime.lock().await = Some(OpenCodeRuntime {
            child,
            base_url: base_url.clone(),
            password: password.clone(),
            stdout_drain: tokio::spawn(async {}),
            #[cfg(windows)]
            job,
        });
        let access = RuntimeAccess { base_url, password };
        assert!(state.endpoint_is_ready(&access).await);
        legitimate_probe
            .await
            .expect("join legitimate health server");

        {
            let mut runtime = state.runtime.lock().await;
            runtime
                .as_mut()
                .expect("stored runtime")
                .child
                .kill()
                .await
                .expect("stop legitimate runtime owner");
        }

        let attacker = tokio::net::TcpListener::bind(address)
            .await
            .expect("attacker rebinds released runtime port");
        let observed = Arc::new(AtomicUsize::new(0));
        let observed_server = Arc::clone(&observed);
        let attacker_server = tokio::spawn(async move {
            for body in ["[]", r#"{"id":"attacker-session"}"#] {
                let accepted =
                    tokio::time::timeout(Duration::from_millis(500), attacker.accept()).await;
                let Ok(Ok((mut socket, _))) = accepted else {
                    return;
                };
                let mut request = vec![0_u8; 8192];
                let read = socket.read(&mut request).await.expect("read stale request");
                if String::from_utf8_lossy(&request[..read])
                    .to_ascii_lowercase()
                    .contains("\r\nauthorization: basic ")
                {
                    observed_server.fetch_add(1, Ordering::SeqCst);
                }
                socket
                    .write_all(
                        format!(
                            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                            body.len()
                        )
                        .as_bytes(),
                    )
                    .await
                    .expect("write forged runtime response");
            }
        });

        let result = state
            .session_for(
                &access,
                "stream-port-reuse",
                "C:/workspace",
                "provider",
                "model",
                false,
                PermissionMode::Ask,
                AgentMode::Build,
            )
            .await;
        attacker_server.await.expect("join attacker server");
        state.stop_runtime().await;

        assert!(result.is_err(), "stale endpoint returned {result:?}");
        assert_eq!(
            observed.load(Ordering::SeqCst),
            0,
            "stale endpoint received authenticated runtime requests"
        );
    }

    #[tokio::test]
    async fn stale_cached_session_is_replaced_after_runtime_loss() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind replacement runtime endpoint");
        let address = listener.local_addr().expect("replacement address");
        let requests = Arc::new(Mutex::new(Vec::new()));
        let server_requests = Arc::clone(&requests);
        let server = tokio::spawn(async move {
            for _ in 0..3 {
                let accepted =
                    tokio::time::timeout(Duration::from_millis(500), listener.accept()).await;
                let Ok(Ok((mut socket, _))) = accepted else {
                    break;
                };
                let mut request = vec![0_u8; 8192];
                let read = socket.read(&mut request).await.expect("read request");
                let request = String::from_utf8_lossy(&request[..read]);
                let request_line = request.lines().next().unwrap_or_default().to_string();
                server_requests.lock().await.push(request_line.clone());
                let (status, body) = if request_line.starts_with("PATCH /session/stale-session") {
                    ("404 Not Found", "")
                } else if request_line.starts_with("GET /session?") {
                    ("200 OK", "[]")
                } else if request_line.starts_with("POST /session?") {
                    ("200 OK", r#"{"id":"replacement-session"}"#)
                } else {
                    ("500 Internal Server Error", "")
                };
                socket
                    .write_all(
                        format!(
                            "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                            body.len()
                        )
                        .as_bytes(),
                    )
                    .await
                    .expect("write replacement response");
            }
        });

        let executable = std::env::current_exe().expect("test executable");
        let mut command = hidden_command(&executable);
        command
            .args([
                "--ignored",
                "--exact",
                "opencode::tests::hold_runtime_process_for_parent_test",
                "--nocapture",
            ])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .kill_on_drop(true);
        let child = command.spawn().expect("spawn replacement runtime owner");
        #[cfg(windows)]
        let job = create_kill_on_close_job(&child).expect("contain replacement runtime owner");

        let access = RuntimeAccess {
            base_url: format!("http://{address}"),
            password: "replacement-runtime-password".into(),
        };
        let state = OpenCodeState::default();
        *state.runtime.lock().await = Some(OpenCodeRuntime {
            child,
            base_url: access.base_url.clone(),
            password: access.password.clone(),
            stdout_drain: tokio::spawn(async {}),
            #[cfg(windows)]
            job,
        });
        state.sessions.lock().await.insert(
            "stream-after-restart".into(),
            SessionBinding {
                session_id: "stale-session".into(),
                directory: "C:/workspace".into(),
            },
        );

        let result = state
            .session_for(
                &access,
                "stream-after-restart",
                "C:/workspace",
                "provider",
                "model",
                false,
                PermissionMode::Ask,
                AgentMode::Build,
            )
            .await;
        let _ = server.await;
        state.stop_runtime().await;

        assert_eq!(result.as_deref(), Ok("replacement-session"));
        assert_eq!(
            requests.lock().await.as_slice(),
            [
                "PATCH /session/stale-session?directory=C%3A%2Fworkspace HTTP/1.1",
                "GET /session?directory=C%3A%2Fworkspace&search=Open+Xiao+-+stream-after-restart&limit=20 HTTP/1.1",
                "POST /session?directory=C%3A%2Fworkspace HTTP/1.1",
            ]
        );
    }

    #[test]
    fn forged_or_stale_server_endpoint_reports_are_rejected() {
        for report in [
            "opencode server listening on http://127.0.0.1:0",
            "opencode server listening on http://localhost:4096",
            "opencode server listening on https://127.0.0.1:4096",
            "opencode server listening on http://user@127.0.0.1:4096",
            "opencode server listening on http://127.0.0.1:4096/stale",
            "stale server listening on http://127.0.0.1:4096",
        ] {
            assert!(parse_server_base_url(report).is_err(), "{report}");
        }
    }

    #[tokio::test]
    async fn duplicate_tool_ids_are_retained_for_each_requesting_stream() {
        let state = OpenCodeState::default();
        state
            .register_approval(
                "stream-a",
                "shared-tool".into(),
                "request-a".into(),
                "C:/workspace-a".into(),
            )
            .await;
        state
            .register_approval(
                "stream-b",
                "shared-tool".into(),
                "request-b".into(),
                "C:/workspace-b".into(),
            )
            .await;

        let approvals = state.approvals.lock().await;
        let request_ids = approvals
            .values()
            .map(|binding| binding.request_id.as_str())
            .collect::<HashSet<_>>();
        assert_eq!(approvals.len(), 2);
        assert_eq!(request_ids, HashSet::from(["request-a", "request-b"]));
    }

    #[tokio::test]
    async fn approve_cannot_consume_another_streams_binding() {
        let state = OpenCodeState::default();
        state
            .register_approval(
                "owner-stream",
                "shared-tool".into(),
                "owner-request".into(),
                "C:/owner-workspace".into(),
            )
            .await;

        assert!(!approve_tool(&state, "other-stream", "shared-tool")
            .await
            .expect("wrong-stream approval lookup"));
        let approvals = state.approvals.lock().await;
        assert_eq!(approvals.len(), 1);
        assert_eq!(
            approvals
                .get(&("owner-stream".into(), "shared-tool".into()))
                .map(|binding| binding.request_id.as_str()),
            Some("owner-request")
        );
    }

    #[tokio::test]
    async fn deny_cannot_consume_another_streams_binding() {
        let state = OpenCodeState::default();
        state
            .register_approval(
                "owner-stream",
                "shared-tool".into(),
                "owner-request".into(),
                "C:/owner-workspace".into(),
            )
            .await;

        assert!(!deny_tool(&state, "other-stream", "shared-tool")
            .await
            .expect("wrong-stream denial lookup"));
        let approvals = state.approvals.lock().await;
        assert_eq!(approvals.len(), 1);
        assert_eq!(
            approvals
                .get(&("owner-stream".into(), "shared-tool".into()))
                .map(|binding| binding.request_id.as_str()),
            Some("owner-request")
        );
    }

    #[tokio::test]
    async fn replied_event_cannot_consume_another_streams_binding() {
        let state = OpenCodeState::default();
        state
            .register_approval(
                "stream-a",
                "shared-tool".into(),
                "shared-request".into(),
                "C:/workspace-a".into(),
            )
            .await;
        state
            .register_approval(
                "stream-b",
                "shared-tool".into(),
                "shared-request".into(),
                "C:/workspace-b".into(),
            )
            .await;

        state
            .clear_replied_approval("stream-a", "shared-request")
            .await;

        let approvals = state.approvals.lock().await;
        assert_eq!(approvals.len(), 1);
        assert_eq!(
            approvals
                .get(&("stream-b".into(), "shared-tool".into()))
                .map(|binding| binding.directory.as_str()),
            Some("C:/workspace-b")
        );
    }

    #[tokio::test]
    async fn stream_cleanup_removes_only_its_approval_bindings() {
        let state = OpenCodeState::default();
        for (stream, request) in [("stream-a", "request-a"), ("stream-b", "request-b")] {
            state
                .register_approval(
                    stream,
                    "shared-tool".into(),
                    request.into(),
                    format!("C:/{stream}"),
                )
                .await;
        }

        state.clear_approvals_for_stream("stream-a").await;

        let approvals = state.approvals.lock().await;
        assert_eq!(approvals.len(), 1);
        assert!(approvals.contains_key(&("stream-b".into(), "shared-tool".into())));
    }

    #[test]
    fn detects_newer_semver_without_lexical_ordering() {
        assert!(newer_version("1.9.9", "1.10.0"));
        assert!(!newer_version("1.18.14", "1.18.14"));
        assert!(!newer_version("2.0.0", "1.99.0"));
    }

    #[test]
    fn resolves_known_update_methods_from_binary_path() {
        assert_eq!(
            update_method(Path::new(r"C:\Users\x\.bun\bin\opencode.exe")),
            Some("bun")
        );
        assert_eq!(
            update_method(Path::new(r"C:\Users\x\scoop\shims\opencode.exe")),
            Some("scoop")
        );
        assert_eq!(update_method(Path::new(r"C:\tools\opencode.exe")), None);
    }

    #[test]
    fn parses_version_noise() {
        assert_eq!(normalize_version("v1.18.14\n"), Some("1.18.14".into()));
    }

    #[test]
    fn parses_question_events_from_supported_opencode_shapes() {
        for id_property in [json!({ "id": "req_1" }), json!({ "requestID": "req_1" })] {
            let mut properties = id_property;
            properties["questions"] = json!([{
                "header": "Runtime",
                "question": "Which runtime should Xiao use?",
                "options": [{ "label": "OpenCode", "description": "Use the CLI runtime" }],
                "multiple": false,
                "custom": true
            }]);
            let event = json!({ "type": "question.asked", "properties": properties });
            let (request_id, questions) = question_request(&event).expect("question request");
            assert_eq!(request_id, "req_1");
            assert_eq!(questions.len(), 1);
            assert_eq!(questions[0].options[0].label, "OpenCode");
        }
    }

    #[test]
    fn prompt_keeps_the_complete_opencode_tool_catalog_enabled() {
        let body = prompt_body(
            "openai",
            "gpt-5.6",
            "fix the tests",
            "shared provider-neutral system prompt",
            Some("high"),
            AgentMode::Build,
        );
        assert!(
            body.get("tools").is_none(),
            "per-turn tool overrides must not hide OpenCode or MCP tools: {body}"
        );
        assert_eq!(body["variant"], "high");
        assert_eq!(body["system"], "shared provider-neutral system prompt");
    }

    #[test]
    fn plan_auto_permissions_end_with_read_only_denies() {
        let rules = session_permission_rules(PermissionMode::Auto, AgentMode::Plan, true);
        let rules = rules.as_array().unwrap();
        assert_eq!(rules[0]["permission"], "*");
        assert_eq!(rules[0]["action"], "allow");
        for permission in ["edit", "bash", "task", "external_directory"] {
            let rule = rules
                .iter()
                .rev()
                .find(|rule| rule["permission"] == permission)
                .unwrap();
            assert_eq!(rule["action"], "deny", "{permission}");
        }
        for tool in [
            "preview_open",
            "preview_navigate",
            "preview_resize",
            "preview_set_appearance",
            "preview_click",
            "preview_type",
            "preview_press",
            "preview_scroll",
            "preview_evaluate",
        ] {
            let permission = format!("{APP_TOOL_MCP_NAME}_{tool}");
            let rule = rules
                .iter()
                .rev()
                .find(|rule| rule["permission"] == permission)
                .unwrap();
            assert_eq!(rule["action"], "deny", "{permission}");
        }
    }

    #[test]
    fn workspace_build_auto_permissions_deny_external_directory() {
        let rules = session_permission_rules(PermissionMode::Auto, AgentMode::Build, false);
        let rules = rules.as_array().unwrap();
        let external_directory = rules
            .iter()
            .rev()
            .find(|rule| rule["permission"] == "external_directory")
            .expect("Workspace access must override the wildcard Auto rule");
        assert_eq!(external_directory["action"], "deny");
    }

    #[test]
    fn workspace_build_ask_permissions_deny_external_directory() {
        let rules = session_permission_rules(PermissionMode::Ask, AgentMode::Build, false);
        let rules = rules.as_array().unwrap();
        let external_directory = rules
            .iter()
            .rev()
            .find(|rule| rule["permission"] == "external_directory")
            .expect("Workspace access must override the wildcard Ask rule");
        assert_eq!(external_directory["action"], "deny");
    }

    #[test]
    fn full_access_build_auto_permissions_remain_automatic() {
        let rules = session_permission_rules(PermissionMode::Auto, AgentMode::Build, true);
        let rules = rules.as_array().unwrap();
        assert_eq!(rules.len(), 2);
        assert_eq!(rules[0]["permission"], "*");
        assert_eq!(rules[0]["action"], "allow");
    }

    #[test]
    fn application_tools_use_one_model_independent_mcp_adapter() {
        let payload = agent_tool_mcp_config(crate::agent_tools::AgentToolMcpConnection {
            endpoint: "http://127.0.0.1:1234/mcp".into(),
            authorization: "Bearer workspace-token".into(),
        });
        assert_eq!(payload["name"], "open-xiao");
        assert_eq!(payload["config"]["type"], "remote");
        assert_eq!(payload["config"]["url"], "http://127.0.0.1:1234/mcp");
        assert_eq!(
            payload["config"]["headers"]["Authorization"],
            "Bearer workspace-token"
        );
        assert!(payload.get("model").is_none());
        assert!(payload.get("provider").is_none());
    }

    #[test]
    fn routes_child_tool_activity_under_the_parent_task() {
        let mut router = OpenCodeEventRouter::default();
        let mut started_tools = HashSet::new();
        let mut finished_tools = HashSet::new();
        let task = json!({
            "type": "message.part.updated",
            "properties": {
                "part": {
                    "id": "part_task",
                    "sessionID": "root_session",
                    "type": "tool",
                    "callID": "task_1",
                    "tool": "task",
                    "state": {
                        "status": "running",
                        "input": { "description": "Review the auth module" },
                        "metadata": {
                            "parentSessionId": "root_session",
                            "sessionId": "child_session"
                        }
                    }
                }
            }
        });
        let task_events = router.tool_events(
            "root_session",
            &task,
            &mut started_tools,
            &mut finished_tools,
        );
        assert_eq!(task_events.len(), 1);

        let child_running = json!({
            "type": "message.part.updated",
            "properties": {
                "part": {
                    "id": "part_read",
                    "sessionID": "child_session",
                    "type": "tool",
                    "callID": "read_1",
                    "tool": "read",
                    "state": {
                        "status": "running",
                        "input": { "filePath": "src/auth.ts" }
                    }
                }
            }
        });
        let running_events = router.tool_events(
            "root_session",
            &child_running,
            &mut started_tools,
            &mut finished_tools,
        );
        assert_eq!(
            serde_json::to_value(&running_events[0]).expect("serialize tool start"),
            json!({
                "kind": "tool_start",
                "id": "task_1::read_1",
                "name": "read",
                "args": "{\"filePath\":\"src/auth.ts\"}",
                "awaitingApproval": false,
                "parentId": "task_1"
            })
        );

        let mut child_completed = child_running;
        child_completed["properties"]["part"]["state"] = json!({
            "status": "completed",
            "input": { "filePath": "src/auth.ts" },
            "output": "export function login() {}"
        });
        let completed_events = router.tool_events(
            "root_session",
            &child_completed,
            &mut started_tools,
            &mut finished_tools,
        );
        assert_eq!(
            serde_json::to_value(&completed_events[0]).expect("serialize tool result"),
            json!({
                "kind": "tool_result",
                "id": "task_1::read_1",
                "name": "read",
                "ok": true,
                "result": "export function login() {}",
                "parentId": "task_1"
            })
        );
    }

    #[test]
    fn provider_tool_results_are_bounded_before_channel_delivery() {
        let mut router = OpenCodeEventRouter::default();
        let mut started_tools = HashSet::new();
        let mut finished_tools = HashSet::new();
        let output = format!("HEAD{}TAIL", "x".repeat(240_000));
        let events = router.tool_events(
            "root_session",
            &json!({
                "type": "message.part.updated",
                "properties": {
                    "part": {
                        "sessionID": "root_session",
                        "type": "tool",
                        "callID": "read_oversized",
                        "tool": "read",
                        "state": { "status": "completed", "output": output }
                    }
                }
            }),
            &mut started_tools,
            &mut finished_tools,
        );
        let result = events
            .iter()
            .find_map(|event| match event {
                StreamEvent::ToolResult { result, .. } => Some(result),
                _ => None,
            })
            .expect("tool result");

        assert!(result.len() <= 120_000, "{} bytes", result.len());
        assert!(result.contains("output trimmed"), "{result}");
        assert!(result.ends_with("TAIL"));
    }

    #[test]
    fn child_session_lifecycle_cannot_finish_the_root_stream() {
        let mut router = OpenCodeEventRouter::default();
        let task = json!({
            "type": "message.part.updated",
            "properties": {
                "part": {
                    "sessionID": "root_session",
                    "type": "tool",
                    "callID": "task_1",
                    "tool": "task",
                    "state": {
                        "status": "running",
                        "metadata": {
                            "parentSessionId": "root_session",
                            "sessionId": "child_session"
                        }
                    }
                }
            }
        });
        assert_eq!(
            router.route("root_session", &task),
            OpenCodeEventRoute::Root
        );
        assert_eq!(
            router.route(
                "root_session",
                &json!({
                    "type": "session.idle",
                    "properties": { "sessionID": "child_session" }
                }),
            ),
            OpenCodeEventRoute::Child {
                parent_tool_id: "task_1".into()
            }
        );
        assert_eq!(
            router.route(
                "root_session",
                &json!({
                    "type": "session.idle",
                    "properties": { "sessionID": "unrelated_session" }
                }),
            ),
            OpenCodeEventRoute::Ignore
        );
    }

    #[tokio::test]
    #[ignore = "requires a local OpenCode installation"]
    async fn live_runtime_uses_child_reported_endpoint() {
        let state = OpenCodeState::default();
        let runtime = state
            .ensure_runtime()
            .await
            .expect("start OpenCode runtime");
        let url = url::Url::parse(&runtime.base_url).expect("runtime URL");
        assert_eq!(url.scheme(), "http");
        assert_eq!(url.host_str(), Some("127.0.0.1"));
        assert!(url.port().is_some_and(|port| port != 0));
        let mut runtime = state.runtime.lock().await;
        assert!(runtime
            .as_mut()
            .expect("stored OpenCode runtime")
            .child
            .try_wait()
            .expect("runtime process status")
            .is_none());
        drop(runtime);
        state.stop_runtime().await;
    }

    #[tokio::test]
    #[ignore = "requires a local OpenCode installation and connected providers"]
    async fn live_status_reads_connected_opencode_inventory() {
        let state = OpenCodeState::default();
        let status = state.status(None).await;
        assert!(status.installed, "{}", status.message);
        assert!(status.ready, "{}", status.message);
        assert!(!status.models.is_empty());
        let runtime = state
            .runtime
            .lock()
            .await
            .as_ref()
            .map(OpenCodeRuntime::access)
            .expect("OpenCode runtime");
        state.stop_runtime().await;
        let stopped = state
            .authenticated_get(&runtime, format!("{}/global/health", runtime.base_url))
            .timeout(Duration::from_secs(1))
            .send()
            .await
            .is_err();
        assert!(
            stopped,
            "OpenCode runtime still accepted requests after stop"
        );
    }
}
