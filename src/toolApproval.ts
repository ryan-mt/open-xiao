import type { Message, ToolCall } from "./types.ts";
import { resolveMessageParts } from "./messageParts.ts";

export type PendingApproval = {
  id: string;
  name: string;
  args: string;
  reason?: string;
  /** Parent task id when nested (rare for Ask mode today). */
  parentId?: string;
};

export async function runApprovalBatch(
  threadId: string,
  items: readonly Pick<PendingApproval, "id">[],
  resolve: (threadId: string, toolId: string) => Promise<void>,
): Promise<void> {
  for (const item of items) {
    await resolve(threadId, item.id);
  }
}

/** Collect tools waiting for user approval (Ask mode). */
export function collectPendingApprovals(
  messages: readonly Message[],
): PendingApproval[] {
  const out: PendingApproval[] = [];
  for (const m of messages) {
    if (m.role !== "assistant") continue;
    for (const part of resolveMessageParts(m)) {
      if (part.type !== "tool") continue;
      collectFromCall(part.call, undefined, out);
    }
  }
  return out;
}

function collectFromCall(
  call: ToolCall,
  parentId: string | undefined,
  out: PendingApproval[],
): void {
  if (call.status === "awaiting") {
    out.push({
      id: call.id,
      name: call.name,
      args: call.args,
      reason: call.approvalReason,
      parentId,
    });
  }
  for (const child of call.children ?? []) {
    collectFromCall(child, call.id, out);
  }
}

/** Short preview of tool args for the approval dock. */
export function approvalArgsPreview(args: string, max = 120): string {
  const t = (args ?? "").trim().replace(/\s+/g, " ");
  if (!t) return "";
  try {
    const o = JSON.parse(t) as Record<string, unknown>;
    const path =
      (typeof o.filePath === "string" && o.filePath) ||
      (typeof o.file_path === "string" && o.file_path) ||
      (typeof o.path === "string" && o.path) ||
      (typeof o.command === "string" && o.command) ||
      (typeof o.cmd === "string" && o.cmd) ||
      "";
    if (path.trim()) {
      const p = path.trim();
      return p.length > max ? `${p.slice(0, max)}…` : p;
    }
  } catch {
    /* use raw */
  }
  return t.length > max ? `${t.slice(0, max)}…` : t;
}
