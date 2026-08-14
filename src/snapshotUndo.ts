import type { Message, ToolCall } from "./types.ts";
import { resolveMessageParts } from "./messageParts.ts";
import type { ReviewFileChange } from "./reviewChanges.ts";
import { isSnapshotMutationTool } from "./review/mutationTools.ts";

export { isSnapshotMutationTool } from "./review/mutationTools.ts";

function walkTools(call: ToolCall, out: ToolCall[]): void {
  out.push(call);
  for (const child of call.children ?? []) {
    walkTools(child, out);
  }
}

/** Tool ids from completed mutation tools in a single message. */
export function mutationToolIdsFromMessage(message: Message): string[] {
  if (message.role !== "assistant") return [];
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const part of resolveMessageParts(message)) {
    if (part.type !== "tool") continue;
    const flat: ToolCall[] = [];
    walkTools(part.call, flat);
    for (const call of flat) {
      if (!isSnapshotMutationTool(call.name)) continue;
      if (call.status !== "done") continue;
      if (!call.id || seen.has(call.id)) continue;
      seen.add(call.id);
      ids.push(call.id);
    }
  }
  return ids;
}

/**
 * Tool ids for undo scope:
 * - `turn`: latest assistant message only
 * - `session`: all assistant messages
 */
export function mutationToolIdsForUndo(
  messages: readonly Message[],
  scope: "turn" | "session",
): string[] {
  if (scope === "session") {
    const ids: string[] = [];
    const seen = new Set<string>();
    for (const m of messages) {
      for (const id of mutationToolIdsFromMessage(m)) {
        if (seen.has(id)) continue;
        seen.add(id);
        ids.push(id);
      }
    }
    return ids;
  }
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== "assistant") continue;
    return mutationToolIdsFromMessage(m);
  }
  return [];
}

/** Unique tool ids from review file rows (turn/session scopes). */
export function toolIdsFromReviewFiles(
  files: readonly ReviewFileChange[],
): string[] {
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const f of files) {
    const id = f.toolId?.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

export type SnapshotInfo = {
  toolId: string;
  streamId: string;
  path: string;
  displayPath: string;
  kind: string;
  createdAt: number;
};

/** Intersect candidate tool ids with snapshots still held for this stream. */
export function filterToolIdsWithSnapshots(
  candidates: readonly string[],
  snapshots: readonly SnapshotInfo[],
): string[] {
  const available = new Set(
    snapshots.map((s) => s.toolId).filter((id) => id.trim().length > 0),
  );
  const out: string[] = [];
  const seen = new Set<string>();
  for (const id of candidates) {
    if (!available.has(id) || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}
