import {
  createId,
  type Message,
  type MessagePart,
  type ToolCall,
  type ToolCallStatus,
} from "./types.ts";
import { assistantHistoryPayload } from "./assistantApiHistory.ts";
import { redactSensitiveValues } from "./lib/userFacingError.ts";

/** Keep the compact work log focused on the newest entry plus active work. */
export const MAX_VISIBLE_WORK_LOG_ENTRIES = 1;

/** Rebuild ordered parts from legacy flat fields (old threads). */
export function legacyPartsFromMessage(m: Message): MessagePart[] {
  const parts: MessagePart[] = [];
  if (m.thinking?.trim()) {
    parts.push({
      type: "thinking",
      id: `${m.id}-thinking`,
      text: m.thinking,
    });
  }
  for (const call of m.toolCalls ?? []) {
    parts.push({ type: "tool", id: call.id, call });
  }
  if (m.content) {
    parts.push({ type: "text", id: `${m.id}-text`, text: m.content });
  }
  return parts;
}

/** Prefer stored parts; fall back to legacy flat fields. */
export function resolveMessageParts(m: Message): MessagePart[] {
  if (m.parts && m.parts.length > 0) return m.parts;
  return legacyPartsFromMessage(m);
}

/**
 * Compact assistant payload for the next API turn. Completed turns use their
 * final answer; interrupted tool-only turns retain a bounded recent transcript
 * so Send-now / queue follow-ups can continue unfinished work.
 */
export function assistantContentForApi(m: Message): string {
  const parts = resolveMessageParts(m);
  const blocks: string[] = [];
  let textBuf = "";
  const flushText = () => {
    const t = textBuf.trim();
    if (t) blocks.push(t);
    textBuf = "";
  };

  for (const p of parts) {
    if (p.type === "text") {
      textBuf += p.text;
      continue;
    }
    if (p.type === "thinking") continue;
    if (p.type !== "tool") continue;
    flushText();
    const call = p.call;
    const name = (call.name || "tool").trim() || "tool";
    let args = (call.args || "").trim();
    if (args.length > 1200) args = `${args.slice(0, 1200)}…`;
    let result = (call.result || "").trim();
    if (result.length > 4000) result = `${result.slice(0, 4000)}…`;
    const status =
      call.status === "running" || call.status === "awaiting"
        ? call.status
        : call.status === "error" || call.status === "denied"
          ? call.status
          : "done";
    const lines = [`[tool ${name} · ${status}]`];
    if (args) lines.push(`args: ${args}`);
    if (result) lines.push(`result:\n${result}`);
    else if (status === "running" || status === "awaiting") {
      lines.push(
        status === "awaiting"
          ? "result: (waiting for user approval)"
          : "result: (interrupted before tool finished)",
      );
    }
    blocks.push(lines.join("\n"));
  }
  flushText();

  const joined = blocks.join("\n\n").trim();
  return assistantHistoryPayload(m.content || "", joined);
}

/** Keep content / thinking / toolCalls in sync for preview, API, meter. */
export function withSyncedDerived(m: Message): Message {
  const parts = m.parts ?? [];
  if (parts.length === 0) {
    return {
      ...m,
      content: m.content ?? "",
      thinking: m.thinking,
      toolCalls: m.toolCalls,
    };
  }

  let content = "";
  const thinkingChunks: string[] = [];
  const toolCalls: ToolCall[] = [];

  for (const p of parts) {
    if (p.type === "text") content += p.text;
    else if (p.type === "thinking") thinkingChunks.push(p.text);
    else toolCalls.push(p.call);
  }

  const thinking = thinkingChunks.join("\n\n").trim();
  return {
    ...m,
    content,
    thinking: thinking || undefined,
    toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
  };
}

export function appendThinkingPart(m: Message, chunk: string): Message {
  if (!chunk) return m;
  const parts = [...(m.parts ?? [])];
  const last = parts[parts.length - 1];
  if (last?.type === "thinking") {
    parts[parts.length - 1] = { ...last, text: last.text + chunk };
  } else {
    parts.push({ type: "thinking", id: createId(), text: chunk });
  }
  return withSyncedDerived({ ...m, parts });
}

export function appendTextPart(m: Message, chunk: string): Message {
  if (!chunk) return m;
  const parts = [...(m.parts ?? [])];
  const last = parts[parts.length - 1];
  if (last?.type === "text") {
    parts[parts.length - 1] = { ...last, text: last.text + chunk };
  } else {
    parts.push({ type: "text", id: createId(), text: chunk });
  }
  return withSyncedDerived({ ...m, parts });
}

function upsertChildTool(
  parent: ToolCall,
  child: ToolCall,
  mode: "start" | "result",
): ToolCall {
  const kids = [...(parent.children ?? [])];
  const cidx = kids.findIndex((c) => c.id === child.id);
  if (cidx >= 0) {
    const prev = kids[cidx];
    if (mode === "start") {
      const locked =
        prev.status === "done" ||
        prev.status === "error" ||
        prev.status === "denied";
      kids[cidx] = {
        ...prev,
        name: child.name || prev.name,
        args: child.args || prev.args,
        status: locked ? prev.status : child.status,
      };
    } else {
      kids[cidx] = {
        ...prev,
        name: child.name || prev.name,
        result: child.result,
        status: child.status,
      };
    }
  } else {
    kids.push(child);
  }
  return { ...parent, children: kids };
}

export function upsertToolStartPart(
  m: Message,
  tool: {
    id: string;
    name: string;
    args: string;
    awaitingApproval?: boolean;
    approvalReason?: string;
    /** Nest under a parent `task` tool when set. */
    parentId?: string;
  },
): Message {
  const parts = [...(m.parts ?? [])];
  const nextStatus: ToolCallStatus = tool.awaitingApproval
    ? "awaiting"
    : "running";
  const parentId = tool.parentId?.trim();

  if (parentId) {
    const pidx = parts.findIndex(
      (p) => p.type === "tool" && p.call.id === parentId,
    );
    if (pidx >= 0) {
      const prev = parts[pidx];
      if (prev.type !== "tool") return m;
      parts[pidx] = {
        type: "tool",
        id: prev.id,
        call: upsertChildTool(
          prev.call,
          {
            id: tool.id,
            name: tool.name,
            args: tool.args,
            status: nextStatus,
            approvalReason: tool.approvalReason,
          },
          "start",
        ),
      };
      return withSyncedDerived({ ...m, parts });
    }
    // Parent not found yet — fall through as top-level so progress is not lost.
  }

  const idx = parts.findIndex(
    (p) => p.type === "tool" && p.call.id === tool.id,
  );
  if (idx >= 0) {
    const prev = parts[idx];
    if (prev.type !== "tool") return m;
    const locked =
      prev.call.status === "done" ||
      prev.call.status === "error" ||
      prev.call.status === "denied";
    parts[idx] = {
      type: "tool",
      id: tool.id,
      call: {
        ...prev.call,
        name: tool.name || prev.call.name,
        args: tool.args || prev.call.args,
        status: locked ? prev.call.status : nextStatus,
        approvalReason: tool.approvalReason ?? prev.call.approvalReason,
      },
    };
  } else {
    parts.push({
      type: "tool",
      id: tool.id,
      call: {
        id: tool.id,
        name: tool.name,
        args: tool.args,
        status: nextStatus,
        approvalReason: tool.approvalReason,
      },
    });
  }
  return withSyncedDerived({ ...m, parts });
}

function markCallRunning(call: ToolCall, toolId: string): ToolCall | null {
  if (call.id === toolId && call.status === "awaiting") {
    return { ...call, status: "running" };
  }
  if (!call.children?.length) return null;
  let changed = false;
  const children = call.children.map((child) => {
    const next = markCallRunning(child, toolId);
    if (next) {
      changed = true;
      return next;
    }
    return child;
  });
  return changed ? { ...call, children } : null;
}

/** Mark an awaiting tool as running after the user approves (incl. nested). */
export function markToolRunning(m: Message, toolId: string): Message {
  const parts = [...(m.parts ?? [])];
  let changed = false;
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if (p.type !== "tool") continue;
    const next = markCallRunning(p.call, toolId);
    if (next) {
      parts[i] = { ...p, call: next };
      changed = true;
      break;
    }
  }
  if (!changed) return m;
  return withSyncedDerived({ ...m, parts });
}

export function upsertToolResultPart(
  m: Message,
  tool: {
    id: string;
    name: string;
    ok: boolean;
    result: string;
    /** Nest under a parent `task` tool when set. */
    parentId?: string;
    /** Image data URL from a multimodal read, when any. */
    imageUrl?: string;
  },
): Message {
  const result = boundToolOutput(tool.result);
  const parts = [...(m.parts ?? [])];
  const denied = !tool.ok && /denied by user/i.test(result);
  const status: ToolCallStatus = tool.ok ? "done" : denied ? "denied" : "error";
  const parentId = tool.parentId?.trim();

  if (parentId) {
    const pidx = parts.findIndex(
      (p) => p.type === "tool" && p.call.id === parentId,
    );
    if (pidx >= 0) {
      const prev = parts[pidx];
      if (prev.type !== "tool") return m;
      parts[pidx] = {
        type: "tool",
        id: prev.id,
        call: upsertChildTool(
          prev.call,
          {
            id: tool.id,
            name: tool.name,
            args: "",
            result,
            status,
          },
          "result",
        ),
      };
      return withSyncedDerived({ ...m, parts });
    }
  }

  const idx = parts.findIndex(
    (p) => p.type === "tool" && p.call.id === tool.id,
  );
  if (idx < 0) {
    parts.push({
      type: "tool",
      id: tool.id,
      call: {
        id: tool.id,
        name: tool.name,
        args: "",
        result,
        status,
        imageUrl: tool.imageUrl,
      },
    });
  } else {
    const prev = parts[idx];
    if (prev.type !== "tool") return m;
    // Close any still-open nested children when the parent task settles.
    let children = prev.call.children;
    if (children?.some((c) => isOpenToolStatus(c.status))) {
      const settleReason = tool.ok
        ? "Subagent finished"
        : result || "Subagent failed";
      children = children.map((c) => {
        const r = finalizeCallTree(c, settleReason, tool.ok ? "done" : status);
        return r.call;
      });
    }
    parts[idx] = {
      type: "tool",
      id: tool.id,
      call: {
        ...prev.call,
        name: tool.name || prev.call.name,
        result,
        status,
        children,
        imageUrl: tool.imageUrl ?? prev.call.imageUrl,
      },
    };
  }
  return withSyncedDerived({ ...m, parts });
}

/** Persisted and live provider tool output cap, measured as UTF-8 bytes. */
export const MAX_PROVIDER_OUTPUT_BYTES = 120_000;
const OUTPUT_TRUNCATION_MARKER = "... (earlier output trimmed)\n";
const OUTPUT_ENCODER = new TextEncoder();
const OUTPUT_DECODER = new TextDecoder();
const OUTPUT_TAIL_BYTES =
  MAX_PROVIDER_OUTPUT_BYTES -
  OUTPUT_ENCODER.encode(OUTPUT_TRUNCATION_MARKER).byteLength;

function boundToolOutput(text: string): string {
  const redacted = redactSensitiveValues(text);
  const bytes = OUTPUT_ENCODER.encode(redacted);
  if (bytes.byteLength <= MAX_PROVIDER_OUTPUT_BYTES) return redacted;

  let start = bytes.byteLength - OUTPUT_TAIL_BYTES;
  while (start < bytes.byteLength && (bytes[start] & 0xc0) === 0x80) {
    start += 1;
  }
  return `${OUTPUT_TRUNCATION_MARKER}${OUTPUT_DECODER.decode(bytes.subarray(start))}`;
}

function appendToolOutput(
  call: ToolCall,
  toolId: string,
  text: string,
  replace: boolean,
): { call: ToolCall; changed: boolean } {
  if (call.id === toolId) {
    if (call.status !== "running" && call.status !== "awaiting") {
      return { call, changed: false };
    }
    const result = boundToolOutput(replace ? text : (call.result ?? "") + text);
    return { call: { ...call, result }, changed: true };
  }
  if (!call.children?.length) return { call, changed: false };
  let changed = false;
  const children = call.children.map((child) => {
    const next = appendToolOutput(child, toolId, text, replace);
    changed ||= next.changed;
    return next.call;
  });
  return changed ? { call: { ...call, children }, changed } : { call, changed };
}

/** Append incremental output to a still-running tool (foreground bash). */
export function upsertToolOutputPart(
  m: Message,
  tool: { id: string; text: string; replace?: boolean },
): Message {
  if (!tool.text) return m;
  const parts = [...(m.parts ?? [])];
  let changed = false;
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];
    if (part.type !== "tool") continue;
    const next = appendToolOutput(
      part.call,
      tool.id,
      tool.text,
      tool.replace === true,
    );
    if (!next.changed) continue;
    parts[index] = { ...part, call: next.call };
    changed = true;
    break;
  }
  return changed ? withSyncedDerived({ ...m, parts }) : m;
}

function isOpenToolStatus(status: ToolCallStatus): boolean {
  return status === "running" || status === "awaiting";
}

function finalizeCallTree(
  call: ToolCall,
  reason: string,
  status: ToolCallStatus,
): { call: ToolCall; changed: boolean } {
  let changed = false;
  let children = call.children;
  if (children?.length) {
    const nextKids = children.map((c) => {
      const r = finalizeCallTree(c, reason, status);
      if (r.changed) changed = true;
      return r.call;
    });
    if (changed) children = nextKids;
  }
  if (isOpenToolStatus(call.status)) {
    changed = true;
    return {
      call: {
        ...call,
        status,
        result: call.result ?? reason,
        children,
      },
      changed,
    };
  }
  if (changed) {
    return { call: { ...call, children }, changed };
  }
  return { call, changed: false };
}

/** Mark in-flight tools finished when the stream dies mid-tool. */
export function finalizeRunningTools(
  m: Message,
  reason = "Stopped before tool finished",
  status: ToolCallStatus = "error",
): Message {
  const parts = m.parts ?? [];
  if (parts.length === 0) {
    const tools = m.toolCalls;
    if (!tools) return m;
    let changed = false;
    const next = tools.map((t) => {
      const r = finalizeCallTree(t, reason, status);
      if (r.changed) changed = true;
      return r.call;
    });
    if (!changed) return m;
    return { ...m, toolCalls: next };
  }
  let changed = false;
  const next = parts.map((p) => {
    if (p.type !== "tool") return p;
    const r = finalizeCallTree(p.call, reason, status);
    if (!r.changed) return p;
    changed = true;
    return { ...p, call: r.call };
  });
  if (!changed) return m;
  return withSyncedDerived({ ...m, parts: next });
}

/** True when the assistant turn produced nothing the user can see. */
export function isEmptyAssistantTurn(m: Message): boolean {
  const parts = resolveMessageParts(m);
  if (parts.length === 0) return !m.content.trim();
  return !parts.some((p) => {
    if (p.type === "text") return !!p.text.trim();
    if (p.type === "thinking") return !!p.text.trim();
    if (p.type === "tool") return true;
    return false;
  });
}

export type TimelineGroup =
  | { kind: "thinking"; key: string; text: string }
  | { kind: "text"; key: string; text: string }
  | { kind: "tools"; key: string; calls: ToolCall[] };

export type TimelineRenderGroup =
  | TimelineGroup
  | {
      kind: "work-toggle";
      key: string;
      hiddenCount: number;
      onlyTools: boolean;
      expanded: boolean;
    };

/** Collapse consecutive same-kind parts for rendering. */
export function groupMessageParts(parts: MessagePart[]): TimelineGroup[] {
  const groups: TimelineGroup[] = [];
  for (const p of parts) {
    const last = groups[groups.length - 1];
    if (p.type === "tool") {
      if (last?.kind === "tools") {
        last.calls.push(p.call);
      } else {
        groups.push({ kind: "tools", key: `tools-${p.id}`, calls: [p.call] });
      }
      continue;
    }
    if (p.type === "thinking") {
      if (last?.kind === "thinking") {
        last.text += p.text;
      } else {
        groups.push({ kind: "thinking", key: p.id, text: p.text });
      }
      continue;
    }
    if (last?.kind === "text") {
      last.text += p.text;
    } else {
      groups.push({ kind: "text", key: p.id, text: p.text });
    }
  }
  return groups;
}

type WorkEntry =
  | { kind: "thinking"; groupKey: string; text: string }
  | { kind: "tool"; groupKey: string; call: ToolCall };

function compactWorkRun(
  run: TimelineGroup[],
  expanded: boolean,
  maxVisible: number,
  keepToolVisible?: (call: ToolCall) => boolean,
): TimelineRenderGroup[] {
  const entries: WorkEntry[] = [];
  for (const group of run) {
    if (group.kind === "thinking") {
      entries.push({
        kind: "thinking",
        groupKey: group.key,
        text: group.text,
      });
    } else if (group.kind === "tools") {
      for (const call of group.calls) {
        entries.push({ kind: "tool", groupKey: group.key, call });
      }
    }
  }
  const tailStart = Math.max(0, entries.length - maxVisible);
  const visibleIndexes = new Set<number>();
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    const activeTool =
      entry?.kind === "tool" &&
      (entry.call.status === "running" || entry.call.status === "awaiting");
    const preservedTool =
      entry?.kind === "tool" && keepToolVisible?.(entry.call) === true;
    if (index >= tailStart || activeTool || preservedTool) visibleIndexes.add(index);
  }
  const hiddenCount = entries.length - visibleIndexes.size;
  if (hiddenCount === 0) return run;

  const rendered: TimelineRenderGroup[] = [];
  if (expanded) {
    rendered.push(...run);
  } else {
    for (let index = 0; index < entries.length; index += 1) {
      if (!visibleIndexes.has(index)) continue;
      const entry = entries[index];
      if (!entry) continue;
      if (entry.kind === "thinking") {
        rendered.push({
          kind: "thinking",
          key: entry.groupKey,
          text: entry.text,
        });
        continue;
      }
      const previous = rendered[rendered.length - 1];
      if (previous?.kind === "tools" && previous.key === entry.groupKey) {
        previous.calls.push(entry.call);
      } else {
        rendered.push({
          kind: "tools",
          key: entry.groupKey,
          calls: [entry.call],
        });
      }
    }
  }
  rendered.push({
    kind: "work-toggle",
    key: `work-toggle:${run[0]?.key ?? "work"}`,
    hiddenCount,
    onlyTools: entries.every((entry) => entry.kind === "tool"),
    expanded,
  });
  return rendered;
}

/** Compact each uninterrupted thinking/tool run without moving assistant text. */
export function compactTimelineGroups(
  groups: TimelineGroup[],
  expanded = false,
  maxVisible = MAX_VISIBLE_WORK_LOG_ENTRIES,
  keepToolVisible?: (call: ToolCall) => boolean,
): TimelineRenderGroup[] {
  const limit = Math.max(1, Math.floor(maxVisible));
  const rendered: TimelineRenderGroup[] = [];
  let workRun: TimelineGroup[] = [];
  const flushWorkRun = () => {
    if (workRun.length === 0) return;
    rendered.push(
      ...compactWorkRun(workRun, expanded, limit, keepToolVisible),
    );
    workRun = [];
  };

  for (const group of groups) {
    if (group.kind === "text") {
      flushWorkRun();
      rendered.push(group);
    } else {
      workRun.push(group);
    }
  }
  flushWorkRun();
  return rendered;
}
