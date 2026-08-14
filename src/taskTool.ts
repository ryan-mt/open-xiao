import type { ToolCall } from "./types";

/** Canonical + alias names for the subagent spawn tool. */
export function isTaskToolName(name: string): boolean {
  const n = name.trim().toLowerCase();
  return n === "task" || n === "spawn_subagent" || n === "agent";
}

/** Canonical roles (UI + wire). `general` still parses as `build`. */
export type TaskRole = "explore" | "reviewer" | "build";

export function parseTaskRole(raw: unknown): TaskRole | null {
  if (typeof raw !== "string") return null;
  switch (raw.trim().toLowerCase()) {
    case "explore":
    case "explorer":
    case "search":
      return "explore";
    case "reviewer":
    case "review":
    case "code-review":
      return "reviewer";
    case "build":
    case "general":
    case "builder":
    case "worker":
      return "build";
    default:
      return null;
  }
}

export function taskRoleLabel(role: TaskRole | null | undefined): string {
  switch (role) {
    case "explore":
      return "Explore";
    case "reviewer":
      return "Reviewer";
    case "build":
      return "Build";
    default:
      return "Agent";
  }
}

/** CSS modifier class for a role (legacy `general` maps to build). */
export function taskRoleClass(role: TaskRole | null | undefined): string {
  if (role === "explore") return "is-task-role-explore";
  if (role === "reviewer") return "is-task-role-reviewer";
  if (role === "build") return "is-task-role-build";
  return "is-task-role-build";
}

const CODENAME_ADJECTIVES = [
  "eager",
  "calm",
  "swift",
  "brave",
  "quiet",
  "bold",
  "keen",
  "warm",
  "cool",
  "bright",
  "clear",
  "sharp",
  "soft",
  "wild",
  "steady",
  "quick",
  "lucid",
  "nimble",
  "solid",
  "vivid",
] as const;

const CODENAME_NOUNS = [
  "fox",
  "owl",
  "wolf",
  "hawk",
  "lynx",
  "bear",
  "seal",
  "kite",
  "wren",
  "lark",
  "pike",
  "moth",
  "fern",
  "oak",
  "ash",
  "elm",
  "reef",
  "dune",
  "glen",
  "brook",
] as const;

/** FNV-1a 32-bit — must match Rust `codename_from_seed` in subagent.rs. */
function fnv1a32(seed: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i += 1) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * Deterministic instance codename from a seed (usually the parent task tool id).
 * Stable across reload; unique enough across concurrent tasks.
 */
export function codenameFromSeed(seed: string): string {
  const s = (seed || "task").trim() || "task";
  const h = fnv1a32(s);
  const adj = CODENAME_ADJECTIVES[h % CODENAME_ADJECTIVES.length];
  const noun = CODENAME_NOUNS[(h >>> 8) % CODENAME_NOUNS.length];
  return `${adj}-${noun}`;
}

export type ParsedTaskArgs = {
  description: string;
  prompt: string;
  role: TaskRole | null;
  roleRaw: string;
};

function parseJsonObject(raw: string): Record<string, unknown> {
  try {
    const o = JSON.parse(raw || "{}");
    return o && typeof o === "object" && !Array.isArray(o)
      ? (o as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

export function parseTaskArgs(args: string): ParsedTaskArgs {
  const o = parseJsonObject(args);
  const description =
    typeof o.description === "string" ? o.description.trim() : "";
  const prompt = typeof o.prompt === "string" ? o.prompt.trim() : "";
  const roleRaw =
    typeof o.subagent_type === "string"
      ? o.subagent_type
      : typeof o.agent === "string"
        ? o.agent
        : typeof o.type === "string"
          ? o.type
          : "";
  return {
    description: description || prompt,
    prompt: prompt || description,
    role: parseTaskRole(roleRaw),
    roleRaw: roleRaw.trim(),
  };
}

export type ParsedTaskResult = {
  role: TaskRole | null;
  /** Instance codename from envelope (`name="eager-fox"`). */
  name: string;
  state: "completed" | "error" | "running" | string;
  summary: string;
  body: string;
};

/**
 * Parse backend `<task role name state>…</task>` envelope (and plain text fallback).
 */
export function parseTaskResult(
  result: string | undefined | null,
): ParsedTaskResult | null {
  if (!result) return null;
  const raw = result.trim();
  if (!raw) return null;

  const open = raw.match(/<task\b([^>]*)>([\s\S]*?)<\/task>/i);
  if (open) {
    const attrs = open[1] ?? "";
    const inner = open[2] ?? "";
    const roleM = attrs.match(/\brole\s*=\s*"([^"]*)"/i);
    const nameM = attrs.match(/\bname\s*=\s*"([^"]*)"/i);
    const stateM = attrs.match(/\bstate\s*=\s*"([^"]*)"/i);
    const summaryM = inner.match(/<summary>([\s\S]*?)<\/summary>/i);
    const bodyM =
      inner.match(/<task_result>([\s\S]*?)<\/task_result>/i) ??
      inner.match(/<task_error>([\s\S]*?)<\/task_error>/i);
    const summary = (summaryM?.[1] ?? "").trim();
    let body = (bodyM?.[1] ?? "").trim();
    if (!body) {
      body = inner
        .replace(/<summary>[\s\S]*?<\/summary>/i, "")
        .replace(/<\/?task_result>/gi, "")
        .replace(/<\/?task_error>/gi, "")
        .trim();
    }
    return {
      role: parseTaskRole(roleM?.[1]),
      name: (nameM?.[1] ?? "").trim(),
      state: (stateM?.[1] ?? "completed").trim() || "completed",
      summary,
      body: body || raw,
    };
  }

  return {
    role: null,
    name: "",
    state: "completed",
    summary: "",
    body: raw,
  };
}

/** Instance codename for a task tool call (envelope name, else id hash). */
export function taskInstanceName(call: ToolCall): string {
  const parsed = parseTaskResult(call.result);
  if (parsed?.name) return parsed.name;
  return codenameFromSeed(call.id || "task");
}

/** Collapsed subtitle while a task runs: latest nested tool, else description. */
export function taskLiveDetail(
  call: ToolCall,
  childPresentation: (c: ToolCall) => { title: string; detail: string },
): string {
  const args = parseTaskArgs(call.args);
  const children = call.children ?? [];
  if (children.length > 0) {
    const active =
      [...children].reverse().find((c) => c.status === "running") ??
      children[children.length - 1];
    if (active) {
      const { title, detail } = childPresentation(active);
      const line = detail ? `${title} · ${detail}` : title;
      if (line.trim()) return line;
    }
  }
  if (call.status === "running" || call.status === "awaiting") {
    return args.description || "Working…";
  }
  const parsed = parseTaskResult(call.result);
  if (parsed?.summary) return parsed.summary;
  return args.description;
}

export function taskPresentation(
  call: ToolCall,
  childPresentation: (c: ToolCall) => { title: string; detail: string },
): {
  title: string;
  detail: string;
  role: TaskRole | null;
  codename: string;
} {
  const args = parseTaskArgs(call.args);
  const parsed = parseTaskResult(call.result);
  const role = args.role ?? parsed?.role ?? null;
  const title = taskRoleLabel(role);
  const detail = taskLiveDetail(call, childPresentation);
  const codename = taskInstanceName(call);
  return { title, detail, role, codename };
}
