import type { Message, ToolCall } from "./types";
import { resolveMessageParts } from "./messageParts";
import { parseJsonObject } from "./lib/parseJsonObject";
import { isFileMutationTool } from "./review/mutationTools";
import { parseToolResultHeaderStats } from "./reviewChanges";

export type LiveFileChangeSummary = {
  fileCount: number;
  additions: number;
  deletions: number;
};

function toolPath(call: ToolCall): string {
  const args = parseJsonObject(call.args);
  const raw =
    typeof args.filePath === "string"
      ? args.filePath
      : typeof args.file_path === "string"
        ? args.file_path
        : typeof args.path === "string"
          ? args.path
          : "";
  if (raw.trim()) return raw.replace(/\\/g, "/");

  const first = (call.result ?? "").split("\n")[0] ?? "";
  // Path may contain spaces, so capture lazily up to the trailing suffix:
  // an optional "(label)", then optional "+N -M"/"+N" stats, then end of line.
  const m = first.match(
    /^(?:Created|Wrote|Edited|Deleted)\s+(.*?)(?:\s+\([^)]*\))?(?:\s+\+\d+(?:\s+-\d+)?)?\s*$/i,
  );
  return m ? m[1].replace(/\\/g, "/") : "";
}

function countLines(text: string): number {
  if (!text) return 0;
  const n = text.replace(/\r\n/g, "\n");
  if (!n) return 0;
  // Match UI diff counting: trailing empty segment from final newline is still a line.
  return n.split("\n").length;
}

function statsFromArgs(call: ToolCall): {
  additions: number;
  deletions: number;
} | null {
  const args = parseJsonObject(call.args);
  const n = call.name.toLowerCase();
  if (
    n === "edit" ||
    n === "edit_file" ||
    n === "str_replace" ||
    n === "apply_patch"
  ) {
    const oldS =
      typeof args.oldString === "string"
        ? args.oldString
        : typeof args.old_string === "string"
          ? args.old_string
          : "";
    const newS =
      typeof args.newString === "string"
        ? args.newString
        : typeof args.new_string === "string"
          ? args.new_string
          : "";
    if (!oldS && !newS) return null;
    return { additions: countLines(newS), deletions: countLines(oldS) };
  }
  if (n === "write" || n === "write_file") {
    const content = typeof args.content === "string" ? args.content : "";
    if (!content) return null;
    return { additions: countLines(content), deletions: 0 };
  }
  return null;
}

function callStats(call: ToolCall): { additions: number; deletions: number } {
  if (call.status === "error") return { additions: 0, deletions: 0 };
  // Header is authoritative — backend already counted full file churn.
  const header = parseToolResultHeaderStats(call.result);
  if (header) return header;
  // While streaming / before result lands, fall back to args payload.
  return statsFromArgs(call) ?? { additions: 0, deletions: 0 };
}

/** Aggregate unique files + line stats for the latest user turn (Codex-style pill). */
export function projectLiveFileChanges(
  messages: readonly Message[],
): LiveFileChangeSummary | null {
  let turnStart = -1;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i].role === "user") {
      turnStart = i;
      break;
    }
  }
  if (turnStart < 0) return null;

  const files = new Map<string, { additions: number; deletions: number }>();

  const visit = (call: ToolCall) => {
    if (isFileMutationTool(call.name) && call.status !== "error") {
      const path = toolPath(call);
      if (path) {
        const stats = callStats(call);
        if (!stats.additions && !stats.deletions && call.status === "running") {
          // Still running with no measurable args yet — count the file once.
          if (!files.has(path)) files.set(path, { additions: 0, deletions: 0 });
        } else {
          const prev = files.get(path) ?? { additions: 0, deletions: 0 };
          files.set(path, {
            additions: prev.additions + stats.additions,
            deletions: prev.deletions + stats.deletions,
          });
        }
      }
    }
    for (const child of call.children ?? []) visit(child);
  };

  for (const msg of messages.slice(turnStart + 1)) {
    if (msg.role !== "assistant") continue;
    for (const part of resolveMessageParts(msg)) {
      if (part.type !== "tool") continue;
      visit(part.call);
    }
  }

  if (files.size === 0) return null;

  let additions = 0;
  let deletions = 0;
  for (const f of files.values()) {
    additions += f.additions;
    deletions += f.deletions;
  }
  return { fileCount: files.size, additions, deletions };
}
