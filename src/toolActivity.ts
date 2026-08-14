/** Provider-neutral tool lifecycle groups for stable activity presentation. */
export type ToolActivityKind =
  | "command"
  | "read"
  | "file_change"
  | "search"
  | "task"
  | "mcp"
  | "image"
  | "todo"
  | "other";

function normalizedToolName(name: string): string {
  return name.trim().toLowerCase().replace(/[\s./-]+/g, "_");
}

/** Classify native, OpenCode, Codex, and ACP-style tool names for stable UI. */
export function toolActivityKind(name: string): ToolActivityKind {
  const normalized = normalizedToolName(name);
  const compact = normalized.replace(/_/g, "");

  if (
    normalized === "command_execution" ||
    normalized === "execute" ||
    normalized === "terminal" ||
    compact.includes("bash") ||
    compact.includes("shell") ||
    compact.includes("command")
  ) {
    return "command";
  }
  if (compact.includes("todo") || normalized === "update_plan") {
    return "todo";
  }
  if (
    normalized === "file_change" ||
    compact.includes("write") ||
    compact.includes("edit") ||
    compact.includes("patch") ||
    compact.includes("replace") ||
    compact.includes("delete") ||
    compact.includes("move")
  ) {
    return "file_change";
  }
  if (
    normalized === "collab_agent_tool_call" ||
    compact === "task" ||
    compact === "agent" ||
    compact.includes("subagent") ||
    compact.includes("subtask")
  ) {
    return "task";
  }
  if (normalized === "mcp_tool_call" || compact.includes("mcp")) {
    return "mcp";
  }
  if (normalized === "image_view" || compact.includes("image")) {
    return "image";
  }
  if (
    normalized === "web_search" ||
    compact.includes("search") ||
    compact.includes("grep") ||
    compact.includes("glob") ||
    compact.includes("find") ||
    compact.includes("fetch")
  ) {
    return "search";
  }
  if (
    normalized === "file_read" ||
    compact.includes("read") ||
    compact.includes("list") ||
    compact === "ls"
  ) {
    return "read";
  }
  return "other";
}
