import type { Message, ToolCall } from "./types.ts";
import { resolveMessageParts } from "./messageParts.ts";
import { parseJsonObject } from "./lib/parseJsonObject.ts";
import {
  isEditTool,
  isFileMutationTool,
  isWriteTool,
} from "./review/mutationTools.ts";

export type ReviewScope = "turn" | "session" | "git";
export type ReviewDiffStyle = "unified" | "split";

const REVIEW_DIFF_STYLE_STORAGE_KEY = "open-xiao:review-diff-style-v1";

export function loadReviewDiffStyle(): ReviewDiffStyle {
  try {
    const stored = localStorage.getItem(REVIEW_DIFF_STYLE_STORAGE_KEY);
    if (stored === "unified" || stored === "split") return stored;
  } catch {
    /* keep the default when storage is unavailable */
  }
  return "unified";
}

export function saveReviewDiffStyle(
  style: ReviewDiffStyle,
): ReviewDiffStyle {
  try {
    localStorage.setItem(REVIEW_DIFF_STYLE_STORAGE_KEY, style);
  } catch {
    /* the current session can still use the selected style */
  }
  return style;
}

export type ReviewFileStatus = "added" | "modified" | "deleted";

export type ReviewDiffLine = {
  kind: "add" | "del" | "ctx" | "meta";
  code: string;
  /** Exact unified-diff line, including its prefix when available. */
  raw?: string;
  oldLine?: number | null;
  newLine?: number | null;
  hunkHeader?: string | null;
};

export type ReviewFileChange = {
  /** Normalized path key (forward slashes). */
  path: string;
  /** Short display path. */
  displayPath: string;
  status: ReviewFileStatus;
  additions: number;
  deletions: number;
  header: string;
  lines: ReviewDiffLine[];
  toolName: string;
  toolId: string;
  messageId: string;
};

export type ReviewChangesSummary = {
  fileCount: number;
  additions: number;
  deletions: number;
};

export function normalizeReviewPath(raw: string): string {
  return raw.replace(/\\/g, "/").replace(/^\.?\//, "").trim();
}

export function shortReviewPath(p: string): string {
  if (!p) return p;
  const norm = normalizeReviewPath(p);
  const markers = ["/src/", "/src-tauri/", "/scripts/", "/public/"];
  const lower = norm.toLowerCase();
  for (const m of markers) {
    const idx = lower.lastIndexOf(m);
    if (idx >= 0) return norm.slice(idx + 1);
  }
  const parts = norm.split("/").filter(Boolean);
  if (parts.length > 4) return parts.slice(-3).join("/");
  return norm;
}

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
  if (raw.trim()) return normalizeReviewPath(raw);

  const first = (call.result ?? "").split("\n")[0] ?? "";
  // Path may contain spaces, so capture lazily up to the trailing suffix:
  // an optional "(label)", then optional "+N -M"/"+N" stats, then end of line.
  const m = first.match(
    /^(?:Created|Wrote|Edited|Deleted)\s+(.*?)(?:\s+\([^)]*\))?(?:\s+\+\d+(?:\s+-\d+)?)?\s*$/i,
  );
  return m ? normalizeReviewPath(m[1]) : "";
}

/**
 * Backend mutation tool results stamp true line churn on the first line:
 *   "Edited path (label)  +417 -127"
 *   "Wrote path  +60 -2"
 *   "Created path  +10"
 *   "No change written to path  +0 -0"
 * Diff bodies are intentionally truncated for UI — never re-count from the body.
 *
 * Must NOT match arbitrary file contents (e.g. Read tool output lines like
 * "     1|… +0 -0 …" or source that happens to contain "+N -M").
 */
export function parseToolResultHeaderStats(
  result: string | undefined | null,
): { additions: number; deletions: number } | null {
  if (!result) return null;
  const first = (result.replace(/\r\n/g, "\n").split("\n")[0] ?? "").trim();
  if (!first) return null;

  // Only accept known write/edit result headers from tools.rs.
  if (
    !/^(?:Created|Wrote|Edited|Deleted|No change written to)\b/i.test(first)
  ) {
    return null;
  }

  const both = first.match(/\+(\d+)\s+-(\d+)\s*$/);
  if (both) {
    return { additions: Number(both[1]), deletions: Number(both[2]) };
  }
  // Created / add-only writes: trailing "+12"
  const addOnly = first.match(/\+(\d+)\s*$/);
  if (addOnly) {
    return { additions: Number(addOnly[1]), deletions: 0 };
  }
  if (/\(no line changes\)/i.test(first)) {
    return { additions: 0, deletions: 0 };
  }
  return null;
}

function isDiffMetaLine(line: string): boolean {
  const t = line.trim();
  return (
    t === "…" ||
    t === "..." ||
    t.startsWith("@@") ||
    t.startsWith("---") ||
    t.startsWith("+++") ||
    /^diff --git /.test(t)
  );
}

function isDiffAddLine(line: string): boolean {
  return line.startsWith("+") && !line.startsWith("+++");
}

function isDiffDelLine(line: string): boolean {
  return line.startsWith("-") && !line.startsWith("---");
}

export function annotateReviewDiffLines(
  lines: readonly ReviewDiffLine[],
): ReviewDiffLine[] {
  let oldLine = 1;
  let newLine = 1;
  let hunkHeader: string | null = null;
  let hasHunk = false;

  return lines.map((line) => {
    if (line.kind === "meta") {
      const header = line.code.trim();
      const match = header.match(/^@@\s+-(\d+)(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@/);
      if (match) {
        oldLine = Number(match[1]);
        newLine = Number(match[2]);
        hunkHeader = header;
        hasHunk = true;
      }
      return {
        ...line,
        raw: line.raw ?? line.code,
        oldLine: null,
        newLine: null,
        hunkHeader,
      };
    }

    const currentOld = line.kind === "add" ? null : oldLine;
    const currentNew = line.kind === "del" ? null : newLine;
    const annotated: ReviewDiffLine = {
      ...line,
      raw:
        line.raw ??
        `${line.kind === "add" ? "+" : line.kind === "del" ? "-" : " "}${line.code}`,
      oldLine: currentOld,
      newLine: currentNew,
      hunkHeader: hasHunk ? hunkHeader : null,
    };
    if (line.kind !== "add") oldLine += 1;
    if (line.kind !== "del") newLine += 1;
    return annotated;
  });
}

function parseDiffBodyLines(bodyLines: string[]): ReviewDiffLine[] {
  return annotateReviewDiffLines(bodyLines.map((text) => {
    if (isDiffMetaLine(text)) {
      return {
        kind: "meta" as const,
        code: text.replace(/^[+\- ]/, ""),
        raw: text,
      };
    }
    if (isDiffAddLine(text)) return { kind: "add" as const, code: text.slice(1), raw: text };
    if (isDiffDelLine(text)) return { kind: "del" as const, code: text.slice(1), raw: text };
    if (text.startsWith(" ")) return { kind: "ctx" as const, code: text.slice(1), raw: text };
    return { kind: "ctx" as const, code: text, raw: ` ${text}` };
  }));
}

function linesAsDiff(
  kind: "add" | "del",
  text: string,
  limit = 400,
): ReviewDiffLine[] {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const slice = lines.slice(0, limit);
  const out: ReviewDiffLine[] = slice.map((l) => ({
    kind,
    code: l,
    raw: `${kind === "add" ? "+" : "-"}${l}`,
  }));
  if (lines.length > limit) {
    out.push({ kind: "meta", code: `… ${lines.length - limit} more lines` });
  }
  return annotateReviewDiffLines(out);
}

function diffFromArgs(
  call: ToolCall,
): { header: string; lines: ReviewDiffLine[] } | null {
  if (!call.args?.trim()) return null;
  const args = parseJsonObject(call.args);
  const path = toolPath(call);
  if (isEditTool(call.name)) {
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
    return {
      header: path || "Edit",
      lines: [...linesAsDiff("del", oldS), ...linesAsDiff("add", newS)],
    };
  }
  if (isWriteTool(call.name)) {
    const content = typeof args.content === "string" ? args.content : "";
    if (!content) return null;
    return {
      header: path || "Write",
      lines: linesAsDiff("add", content),
    };
  }
  return null;
}

function buildDiffView(
  call: ToolCall,
): { header: string; lines: ReviewDiffLine[] } | null {
  if (call.status === "error") return null;
  const resultRaw = call.result ?? "";
  const result = resultRaw.trim();
  const argsDiff = diffFromArgs(call);
  const headerStats = parseToolResultHeaderStats(resultRaw);

  if (result) {
    const lines = resultRaw.replace(/\r\n/g, "\n").split("\n");
    const header = (lines[0] ?? "").trim();
    const bodyLines = lines.slice(1);
    const hasDiff = bodyLines.some(
      (l) =>
        isDiffAddLine(l) ||
        isDiffDelLine(l) ||
        isDiffMetaLine(l) ||
        l.trim() === "…" ||
        l.trim() === "...",
    );
    if (hasDiff) {
      const parsed = parseDiffBodyLines(bodyLines);
      // If the snippet was truncated, keep header truth in a meta footer.
      if (
        headerStats &&
        bodyLines.some((l) => {
          const t = l.trim();
          return t === "…" || t === "..." || t.startsWith("…");
        })
      ) {
        const bodyCount = countLineStats(parsed);
        const missingAdds = Math.max(
          0,
          headerStats.additions - bodyCount.additions,
        );
        const missingDels = Math.max(
          0,
          headerStats.deletions - bodyCount.deletions,
        );
        if (missingAdds > 0 || missingDels > 0) {
          const bits: string[] = [];
          if (missingAdds) bits.push(`+${missingAdds}`);
          if (missingDels) bits.push(`-${missingDels}`);
          parsed.push({
            kind: "meta",
            code: `… truncated preview · full change ${bits.join(" ")}`,
          });
        }
      }
      return {
        header: header || argsDiff?.header || "Diff",
        lines: parsed,
      };
    }
  }
  if (argsDiff) {
    const header =
      (result ? result.split("\n")[0]?.trim() : "") || argsDiff.header;
    return { header, lines: argsDiff.lines };
  }
  // Header-only success (e.g. no-op / empty snippet) — still list the file.
  if (headerStats && result) {
    return {
      header: result.split("\n")[0]?.trim() || toolPath(call) || "Change",
      lines: [
        {
          kind: "meta",
          code:
            headerStats.additions || headerStats.deletions
              ? `+${headerStats.additions} -${headerStats.deletions}`
              : "No line changes",
        },
      ],
    };
  }
  return null;
}

function countLineStats(lines: ReviewDiffLine[]): {
  additions: number;
  deletions: number;
} {
  let additions = 0;
  let deletions = 0;
  for (const line of lines) {
    if (line.kind === "add") additions += 1;
    else if (line.kind === "del") deletions += 1;
  }
  return { additions, deletions };
}

/** Prefer backend header stats; fall back to visible diff / args only if needed. */
function resolveChangeStats(
  call: ToolCall,
  lines: ReviewDiffLine[],
): { additions: number; deletions: number } {
  const fromHeader = parseToolResultHeaderStats(call.result);
  if (fromHeader) return fromHeader;
  const fromLines = countLineStats(lines);
  if (fromLines.additions || fromLines.deletions) return fromLines;
  const argsDiff = diffFromArgs(call);
  if (argsDiff) return countLineStats(argsDiff.lines);
  return { additions: 0, deletions: 0 };
}

function inferStatus(
  call: ToolCall,
  stats: { additions: number; deletions: number },
): ReviewFileStatus {
  const n = call.name.toLowerCase();
  if (n === "write" || n === "write_file") {
    // Fresh write with only additions → added; otherwise modified.
    if (stats.deletions === 0 && stats.additions > 0) return "added";
  }
  if (stats.additions === 0 && stats.deletions > 0) return "deleted";
  if (stats.deletions === 0 && stats.additions > 0 && isWriteTool(call.name)) {
    return "added";
  }
  return "modified";
}

function fileChangeFromCall(
  call: ToolCall,
  messageId: string,
): ReviewFileChange | null {
  if (!isFileMutationTool(call.name)) return null;
  if (call.status === "error") return null;
  const path = toolPath(call);
  if (!path) return null;
  const view = buildDiffView(call);
  const headerStats = parseToolResultHeaderStats(call.result);
  if (!view || view.lines.length === 0) {
    // Running write/edit: show the path as soon as we know it.
    if (call.status === "running") {
      return {
        path,
        displayPath: shortReviewPath(path),
        status: isWriteTool(call.name) ? "added" : "modified",
        additions: 0,
        deletions: 0,
        header: path,
        lines: [{ kind: "meta", code: "Writing…" }],
        toolName: call.name,
        toolId: call.id,
        messageId,
      };
    }
    // Done but only header stats (no expandable body).
    if (headerStats) {
      return {
        path,
        displayPath: shortReviewPath(path),
        status: inferStatus(call, headerStats),
        additions: headerStats.additions,
        deletions: headerStats.deletions,
        header: (call.result ?? "").split("\n")[0]?.trim() || path,
        lines: [
          {
            kind: "meta",
            code: `+${headerStats.additions} -${headerStats.deletions}`,
          },
        ],
        toolName: call.name,
        toolId: call.id,
        messageId,
      };
    }
    return null;
  }
  const stats = resolveChangeStats(call, view.lines);
  return {
    path,
    displayPath: shortReviewPath(path),
    status: inferStatus(call, stats),
    additions: stats.additions,
    deletions: stats.deletions,
    header: view.header,
    lines: view.lines,
    toolName: call.name,
    toolId: call.id,
    messageId,
  };
}

function mergeReviewChange(
  byPath: Map<string, ReviewFileChange>,
  change: ReviewFileChange,
) {
  const previous = byPath.get(change.path);
  if (!previous) {
    byPath.set(change.path, change);
    return;
  }
  byPath.set(change.path, {
    ...change,
    additions: previous.additions + change.additions,
    deletions: previous.deletions + change.deletions,
    status:
      previous.status === "added" && change.status !== "deleted"
        ? "added"
        : change.status === "deleted" && previous.status === "added"
          ? "modified"
          : change.status === "deleted"
            ? "deleted"
            : previous.status === "deleted" && change.status === "added"
              ? "modified"
              : change.status,
  });
}

export function collectMessageReviewFileChanges(
  message: Message,
): ReviewFileChange[] {
  if (message.role !== "assistant") return [];
  const byPath = new Map<string, ReviewFileChange>();
  const visit = (call: ToolCall) => {
    const change = fileChangeFromCall(call, message.id);
    if (change) mergeReviewChange(byPath, change);
    for (const child of call.children ?? []) visit(child);
  };
  for (const part of resolveMessageParts(message)) {
    if (part.type === "tool") visit(part.call);
  }
  return Array.from(byPath.values()).sort((left, right) =>
    left.path.localeCompare(right.path, undefined, {
      numeric: true,
      sensitivity: "base",
    }),
  );
}

/** Latest user message index, or -1. */
function lastUserIndex(messages: readonly Message[]): number {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i].role === "user") return i;
  }
  return -1;
}

/**
 * Collect file mutations for review.
 * - turn: after the latest user message only (OpenCode "last turn")
 * - session: whole thread (unique path keeps the latest successful edit)
 */
export function collectReviewFileChanges(
  messages: readonly Message[],
  scope: ReviewScope = "turn",
): ReviewFileChange[] {
  // Working-tree diffs come from the git backend, not chat tool calls.
  if (scope === "git") return [];

  let start = 0;
  if (scope === "turn") {
    const u = lastUserIndex(messages);
    if (u < 0) return [];
    start = u + 1;
  }

  // path → change (later edits win for session; turn accumulates chronologically last-win too)
  const byPath = new Map<string, ReviewFileChange>();

  const visit = (call: ToolCall, messageId: string) => {
    const change = fileChangeFromCall(call, messageId);
    if (change) mergeReviewChange(byPath, change);
    for (const child of call.children ?? []) visit(child, messageId);
  };

  for (const msg of messages.slice(start)) {
    if (msg.role !== "assistant") continue;
    for (const part of resolveMessageParts(msg)) {
      if (part.type !== "tool") continue;
      visit(part.call, msg.id);
    }
  }

  return Array.from(byPath.values()).sort((a, b) =>
    a.path.localeCompare(b.path, undefined, {
      numeric: true,
      sensitivity: "base",
    }),
  );
}

export function summarizeReviewChanges(
  files: readonly ReviewFileChange[],
): ReviewChangesSummary {
  let additions = 0;
  let deletions = 0;
  for (const f of files) {
    additions += f.additions;
    deletions += f.deletions;
  }
  return { fileCount: files.length, additions, deletions };
}

export function filterReviewFiles(
  files: readonly ReviewFileChange[],
  query: string,
): ReviewFileChange[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...files];
  return files.filter(
    (f) =>
      f.path.toLowerCase().includes(q) ||
      f.displayPath.toLowerCase().includes(q),
  );
}

const compactDiffCountFormatter = new Intl.NumberFormat("en-US", {
  notation: "compact",
  maximumFractionDigits: 1,
});

export function formatCompactDiffCount(value: number): string {
  return compactDiffCountFormatter.format(value);
}

export function fileNameOf(path: string): string {
  const parts = normalizeReviewPath(path).split("/").filter(Boolean);
  return parts[parts.length - 1] || path;
}

export function dirNameOf(path: string): string {
  const parts = normalizeReviewPath(path).split("/").filter(Boolean);
  if (parts.length <= 1) return "";
  return parts.slice(0, -1).join("/");
}
