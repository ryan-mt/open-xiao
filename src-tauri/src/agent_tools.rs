//! Provider-neutral agent tools and their protocol adapters.

use crate::paths::redact_secrets;
use axum::Router;
use futures_util::future::BoxFuture;
use rand::distr::{Alphanumeric, SampleString};
use rmcp::{
    model::{
        CallToolRequestParams, CallToolResponse, CallToolResult, ContentBlock, ListToolsResult,
        PaginatedRequestParams, ServerCapabilities, ServerInfo, Tool, ToolAnnotations,
    },
    service::RequestContext,
    transport::streamable_http_server::{
        session::local::LocalSessionManager, StreamableHttpServerConfig, StreamableHttpService,
    },
    ErrorData as McpError, RoleServer, ServerHandler,
};
use serde_json::{json, Map, Value};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use tauri::AppHandle;
use tokio_util::sync::CancellationToken;

pub const TOOL_NAMES: &[&str] = &[
    "preview_status",
    "preview_open",
    "preview_navigate",
    "preview_resize",
    "preview_set_appearance",
    "preview_snapshot",
    "preview_click",
    "preview_type",
    "preview_press",
    "preview_scroll",
    "preview_evaluate",
    "preview_wait_for",
];

#[derive(Debug, Clone)]
pub struct AgentToolImage {
    pub data_url: String,
    pub mime: String,
    pub label: String,
}

#[derive(Debug, Clone)]
pub struct AgentToolResult {
    pub text: String,
    pub image: Option<AgentToolImage>,
}

pub type AgentToolHandler =
    Arc<dyn Fn(String, Value) -> BoxFuture<'static, Result<AgentToolResult, String>> + Send + Sync>;

#[derive(Clone)]
struct AgentToolSpec {
    name: &'static str,
    title: &'static str,
    description: &'static str,
    schema: Map<String, Value>,
    read_only: bool,
    idempotent: bool,
    destructive: bool,
}

fn object_schema(properties: Value, required: &[&str]) -> Map<String, Value> {
    let mut schema = json!({
        "type": "object",
        "properties": properties,
        "additionalProperties": false
    });
    if !required.is_empty() {
        schema["required"] = json!(required);
    }
    schema.as_object().expect("object schema").clone()
}

fn specs() -> Vec<AgentToolSpec> {
    let empty = || object_schema(json!({}), &[]);
    vec![
        AgentToolSpec {
            name: "preview_status",
            title: "Get preview status",
            description: "Report whether this workspace has an automation-capable browser preview, including its URL, title, visibility, loading state, and viewport size.",
            schema: empty(),
            read_only: true,
            idempotent: true,
            destructive: false,
        },
        AgentToolSpec {
            name: "preview_open",
            title: "Open browser preview",
            description: "Reuse a workspace browser preview that the user already opened. An optional URL may be supplied only when its origin was approved in Browser Preview.",
            schema: object_schema(json!({
                "url": { "type": "string", "description": "Optional HTTP(S) URL or host such as localhost:5173." }
            }), &[]),
            read_only: false,
            idempotent: false,
            destructive: false,
        },
        AgentToolSpec {
            name: "preview_navigate",
            title: "Navigate browser preview",
            description: "Navigate the workspace browser preview within an origin the user already approved, and optionally wait until loading finishes.",
            schema: object_schema(json!({
                "url": { "type": "string", "description": "HTTP(S) URL or host such as localhost:5173." },
                "readiness": { "type": "string", "enum": ["load", "none"], "description": "Wait for page loading to finish (default load), or return immediately." },
                "timeoutMs": { "type": "integer", "minimum": 1, "maximum": 60000 }
            }), &["url"]),
            read_only: false,
            idempotent: false,
            destructive: false,
        },
        AgentToolSpec {
            name: "preview_resize",
            title: "Resize browser viewport",
            description: "Set the browser preview viewport to exact CSS-pixel dimensions.",
            schema: object_schema(json!({
                "width": { "type": "integer", "minimum": 240, "maximum": 3840 },
                "height": { "type": "integer", "minimum": 240, "maximum": 2160 }
            }), &["width", "height"]),
            read_only: false,
            idempotent: true,
            destructive: false,
        },
        AgentToolSpec {
            name: "preview_set_appearance",
            title: "Set preview appearance",
            description: "Emulate the page color scheme as system, light, or dark without changing the application theme.",
            schema: object_schema(json!({
                "colorScheme": { "type": "string", "enum": ["system", "light", "dark"] }
            }), &["colorScheme"]),
            read_only: false,
            idempotent: true,
            destructive: false,
        },
        AgentToolSpec {
            name: "preview_snapshot",
            title: "Inspect browser page",
            description: "Inspect the current page before interacting. Returns page state, visible text, semantic interactive elements, and a PNG screenshot.",
            schema: empty(),
            read_only: true,
            idempotent: true,
            destructive: false,
        },
        AgentToolSpec {
            name: "preview_click",
            title: "Click preview page",
            description: "Click exactly one target using a CSS selector, semantic locator, or viewport-relative x/y coordinates. Use preview_snapshot first.",
            schema: object_schema(json!({
                "selector": { "type": "string", "description": "CSS selector." },
                "locator": { "type": "string", "description": "Semantic locator such as role=button[name='Send'] or text=Continue." },
                "x": { "type": "number" },
                "y": { "type": "number" }
            }), &[]),
            read_only: false,
            idempotent: false,
            destructive: true,
        },
        AgentToolSpec {
            name: "preview_type",
            title: "Type into preview page",
            description: "Insert literal text into a selector/locator target, or the currently focused element. Set clear=true to replace existing text.",
            schema: object_schema(json!({
                "text": { "type": "string" },
                "selector": { "type": "string" },
                "locator": { "type": "string" },
                "clear": { "type": "boolean" }
            }), &["text"]),
            read_only: false,
            idempotent: false,
            destructive: true,
        },
        AgentToolSpec {
            name: "preview_press",
            title: "Press key in preview page",
            description: "Press one keyboard key in the focused page element, with optional Alt, Control, Meta, or Shift modifiers.",
            schema: object_schema(json!({
                "key": { "type": "string" },
                "modifiers": { "type": "array", "items": { "type": "string", "enum": ["Alt", "Control", "Meta", "Shift"] } }
            }), &["key"]),
            read_only: false,
            idempotent: false,
            destructive: true,
        },
        AgentToolSpec {
            name: "preview_scroll",
            title: "Scroll preview page",
            description: "Scroll the viewport or a CSS/semantic target. Positive deltaY scrolls down and positive deltaX scrolls right.",
            schema: object_schema(json!({
                "deltaX": { "type": "number" },
                "deltaY": { "type": "number" },
                "selector": { "type": "string" },
                "locator": { "type": "string" }
            }), &[]),
            read_only: false,
            idempotent: false,
            destructive: false,
        },
        AgentToolSpec {
            name: "preview_evaluate",
            title: "Evaluate JavaScript in preview",
            description: "Evaluate a JavaScript expression in the page main frame and return a serializable result. Prefer snapshots and semantic actions for normal interaction.",
            schema: object_schema(json!({
                "expression": { "type": "string", "maxLength": 64000 }
            }), &["expression"]),
            read_only: false,
            idempotent: false,
            destructive: true,
        },
        AgentToolSpec {
            name: "preview_wait_for",
            title: "Wait for preview page condition",
            description: "Wait until all supplied selector, locator, visible-text, and URL conditions match.",
            schema: object_schema(json!({
                "selector": { "type": "string" },
                "locator": { "type": "string" },
                "text": { "type": "string" },
                "urlIncludes": { "type": "string" },
                "timeoutMs": { "type": "integer", "minimum": 1, "maximum": 60000 }
            }), &[]),
            read_only: true,
            idempotent: true,
            destructive: false,
        },
    ]
}

pub fn canonical_name(name: &str) -> Option<&'static str> {
    let normalized = name.trim().to_ascii_lowercase();
    if normalized == "browser_snapshot" {
        return Some("preview_snapshot");
    }
    TOOL_NAMES.iter().copied().find(|item| *item == normalized)
}

pub fn native_definitions() -> Vec<Value> {
    specs()
        .into_iter()
        .map(|spec| {
            json!({
                "type": "function",
                "function": {
                    "name": spec.name,
                    "description": spec.description,
                    "parameters": Value::Object(spec.schema)
                }
            })
        })
        .collect()
}

fn mcp_definitions() -> Vec<Tool> {
    specs()
        .into_iter()
        .map(|spec| {
            let annotations = ToolAnnotations::with_title(spec.title)
                .read_only(spec.read_only)
                .idempotent(spec.idempotent)
                .destructive(spec.destructive)
                .open_world(true);
            let mut tool = Tool::new(spec.name, spec.description, spec.schema);
            tool.annotations = Some(annotations);
            tool
        })
        .collect()
}

pub async fn execute(
    app: &AppHandle,
    workspace: &Path,
    name: &str,
    arguments: Value,
) -> Result<AgentToolResult, String> {
    let name = canonical_name(name).ok_or_else(|| format!("Unknown agent tool: {name}"))?;
    match crate::preview::execute_agent_preview_tool(app, workspace, name, arguments).await {
        Ok(mut result) => {
            result.text = sanitize_agent_output(&result.text);
            Ok(result)
        }
        Err(error) => Err(sanitize_agent_output(&error)),
    }
}

const MAX_AGENT_TOOL_TEXT_CHARS: usize = 80_000;

fn sanitize_agent_output(text: &str) -> String {
    let redacted = redact_secrets(text);
    if redacted.chars().count() <= MAX_AGENT_TOOL_TEXT_CHARS {
        redacted
    } else {
        redacted.chars().take(MAX_AGENT_TOOL_TEXT_CHARS).collect()
    }
}

#[derive(Clone)]
pub struct AgentToolMcpState {
    endpoint: String,
    workspaces_by_token: Arc<Mutex<HashMap<String, PathBuf>>>,
    tokens_by_workspace: Arc<Mutex<HashMap<PathBuf, String>>>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AgentToolMcpConnection {
    pub endpoint: String,
    pub authorization: String,
}

impl AgentToolMcpState {
    pub fn connection_for(&self, workspace: &Path) -> Result<AgentToolMcpConnection, String> {
        let workspace = workspace
            .canonicalize()
            .map_err(|error| format!("Could not resolve tool workspace: {error}"))?;
        let mut tokens_by_workspace = self
            .tokens_by_workspace
            .lock()
            .map_err(|_| "Agent tool credentials are unavailable".to_string())?;
        let token = if let Some(token) = tokens_by_workspace.get(&workspace) {
            token.clone()
        } else {
            let mut rng = rand::rng();
            let token = Alphanumeric.sample_string(&mut rng, 48);
            tokens_by_workspace.insert(workspace.clone(), token.clone());
            self.workspaces_by_token
                .lock()
                .map_err(|_| "Agent tool credentials are unavailable".to_string())?
                .insert(token.clone(), workspace);
            token
        };
        Ok(AgentToolMcpConnection {
            endpoint: self.endpoint.clone(),
            authorization: format!("Bearer {token}"),
        })
    }

    fn workspace_for_request(
        &self,
        context: &RequestContext<RoleServer>,
    ) -> Result<PathBuf, McpError> {
        let parts = context
            .extensions
            .get::<axum::http::request::Parts>()
            .ok_or_else(|| McpError::invalid_request("Missing HTTP request context", None))?;
        let header = parts
            .headers
            .get(axum::http::header::AUTHORIZATION)
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.strip_prefix("Bearer "))
            .ok_or_else(|| McpError::invalid_request("Missing agent tool authorization", None))?;
        self.workspaces_by_token
            .lock()
            .map_err(|_| McpError::internal_error("Agent tool credentials are unavailable", None))?
            .get(header)
            .cloned()
            .ok_or_else(|| McpError::invalid_request("Invalid agent tool authorization", None))
    }
}

#[derive(Clone)]
struct AgentToolMcpServer {
    app: AppHandle,
    state: AgentToolMcpState,
}

impl ServerHandler for AgentToolMcpServer {
    fn get_info(&self) -> ServerInfo {
        ServerInfo::new(ServerCapabilities::builder().enable_tools().build())
            .with_instructions("Workspace-scoped tools supplied by the desktop application.")
    }

    async fn list_tools(
        &self,
        _request: Option<PaginatedRequestParams>,
        context: RequestContext<RoleServer>,
    ) -> Result<ListToolsResult, McpError> {
        self.state.workspace_for_request(&context)?;
        Ok(ListToolsResult::with_all_items(mcp_definitions()))
    }

    async fn call_tool(
        &self,
        request: CallToolRequestParams,
        context: RequestContext<RoleServer>,
    ) -> Result<CallToolResponse, McpError> {
        let workspace = self.state.workspace_for_request(&context)?;
        let arguments = Value::Object(request.arguments.unwrap_or_default());
        let result = execute(&self.app, &workspace, &request.name, arguments).await;
        let response = match result {
            Ok(result) => {
                let mut content = vec![ContentBlock::text(result.text)];
                if let Some(image) = result.image {
                    let data = image
                        .data_url
                        .split_once(',')
                        .map(|(_, data)| data)
                        .unwrap_or(image.data_url.as_str());
                    content.push(ContentBlock::image(data, image.mime));
                }
                CallToolResult::success(content)
            }
            Err(error) => CallToolResult::error(vec![ContentBlock::text(error)]),
        };
        Ok(response.into())
    }
}

pub fn start_mcp_server(app: AppHandle) -> Result<AgentToolMcpState, String> {
    let listener = std::net::TcpListener::bind("127.0.0.1:0")
        .map_err(|error| format!("Could not bind the agent tool server: {error}"))?;
    listener
        .set_nonblocking(true)
        .map_err(|error| format!("Could not configure the agent tool server: {error}"))?;
    let address = listener
        .local_addr()
        .map_err(|error| format!("Could not inspect the agent tool server: {error}"))?;
    let cancellation = CancellationToken::new();
    let state = AgentToolMcpState {
        endpoint: format!("http://{address}/mcp"),
        workspaces_by_token: Arc::new(Mutex::new(HashMap::new())),
        tokens_by_workspace: Arc::new(Mutex::new(HashMap::new())),
    };
    let server = AgentToolMcpServer {
        app,
        state: state.clone(),
    };
    tauri::async_runtime::spawn(async move {
        let listener = match tokio::net::TcpListener::from_std(listener) {
            Ok(listener) => listener,
            Err(_) => return,
        };
        let service: StreamableHttpService<AgentToolMcpServer, LocalSessionManager> =
            StreamableHttpService::new(
                move || Ok(server.clone()),
                Default::default(),
                StreamableHttpServerConfig::default()
                    .with_sse_keep_alive(None)
                    .with_cancellation_token(cancellation.child_token()),
            );
        let router = Router::new().nest_service("/mcp", service);
        let _ = axum::serve(listener, router)
            .with_graceful_shutdown(cancellation.cancelled_owned())
            .await;
    });
    Ok(state)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn native_and_mcp_adapters_expose_the_same_registry() {
        let native: Vec<String> = native_definitions()
            .iter()
            .filter_map(|definition| {
                definition
                    .pointer("/function/name")
                    .and_then(Value::as_str)
                    .map(str::to_string)
            })
            .collect();
        let mcp: Vec<String> = mcp_definitions()
            .iter()
            .map(|definition| definition.name.to_string())
            .collect();
        assert_eq!(native, mcp);
        assert_eq!(native, TOOL_NAMES);
    }

    #[test]
    fn preview_aliases_are_provider_independent() {
        assert_eq!(canonical_name("browser_snapshot"), Some("preview_snapshot"));
        assert_eq!(canonical_name("PREVIEW_EVALUATE"), Some("preview_evaluate"));
        assert_eq!(canonical_name("unknown"), None);
    }

    #[test]
    fn mcp_credentials_are_stable_and_workspace_scoped() {
        let unique = format!(
            "grokapp-agent-tools-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        );
        let base = std::env::temp_dir().join(unique);
        let first = base.join("first");
        let second = base.join("second");
        std::fs::create_dir_all(&first).unwrap();
        std::fs::create_dir_all(&second).unwrap();
        let state = AgentToolMcpState {
            endpoint: "http://127.0.0.1:1/mcp".into(),
            workspaces_by_token: Arc::new(Mutex::new(HashMap::new())),
            tokens_by_workspace: Arc::new(Mutex::new(HashMap::new())),
        };

        let first_connection = state.connection_for(&first).unwrap();
        assert_eq!(first_connection, state.connection_for(&first).unwrap());
        assert_ne!(first_connection, state.connection_for(&second).unwrap());
        assert!(first_connection.authorization.starts_with("Bearer "));
        assert!(!first_connection
            .authorization
            .contains(first.to_string_lossy().as_ref()));

        std::fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn agent_tool_text_is_redacted_and_bounded() {
        let secret = format!("sk-{}", "a".repeat(32));
        let input = format!(
            "OPENAI_API_KEY={secret} https://example.test/?access_token=query-secret {}",
            "x".repeat(MAX_AGENT_TOOL_TEXT_CHARS + 10)
        );
        let output = sanitize_agent_output(&input);
        assert!(!output.contains(&secret), "{output}");
        assert!(!output.contains("query-secret"), "{output}");
        assert!(output.contains("[REDACTED]"), "{output}");
        assert!(output.chars().count() <= MAX_AGENT_TOOL_TEXT_CHARS);
    }
}
