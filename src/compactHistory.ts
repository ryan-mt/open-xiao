import {
  estimateMessageTokens,
  estimateTokens,
  SYSTEM_PROMPT_OVERHEAD,
  contextUsage,
} from "./contextMeter.ts";
import { createId, type Message, type Thread } from "./types.ts";

/**
 * After `/compact`, aim for this fraction of the model context window.
 * 60% (not 80%): leaves headroom for the next user turn, tool rounds,
 * and server system prompt growth without immediately re-filling the meter.
 */
export const COMPACT_TARGET_RATIO = 0.6;

/** Always try to keep at least this many newest messages when anything is dropped. */
export const COMPACT_MIN_TAIL_MESSAGES = 4;

/** Hard cap on the folded summary payload (chars). */
export const COMPACT_SUMMARY_MAX_CHARS = 12_000;

/** Per-message excerpt inside the summary. */
const SUMMARY_EXCERPT_CHARS = 480;

const SUMMARY_HEADER =
  "[Compacted conversation summary — earlier turns were folded to free context. " +
  "Use this as background only; prefer the recent messages below for current work.]";

export type CompactHistoryResult = {
  messages: Message[];
  changed: boolean;
  reason?: "empty" | "already-compact" | "nothing-to-fold";
  beforeTokens: number;
  afterTokens: number;
  limit: number;
  droppedCount: number;
  keptTailCount: number;
};

export function applyCompactionIfCurrent(
  thread: Thread,
  sourceMessages: readonly Message[],
  compactedMessages: Message[],
  now = Date.now(),
): Thread {
  if (thread.messages !== sourceMessages) return thread;
  return { ...thread, messages: compactedMessages, updatedAt: now };
}

function messagePlainText(m: Message): string {
  const raw = (m.content || "").trim();
  if (raw) return raw;
  // Tool-only / thinking-only turns: brief placeholder so the fold still notes them.
  const tools = m.toolCalls?.length ?? 0;
  if (m.role === "assistant" && tools > 0) {
    const names = (m.toolCalls ?? [])
      .map((t) => (t.name || "tool").trim())
      .filter(Boolean)
      .slice(0, 6);
    const unique = [...new Set(names)];
    return `(tool-only turn: ${unique.join(", ") || "tools"})`;
  }
  if (m.thinking?.trim()) {
    return "(reasoning-only turn)";
  }
  return "";
}

function clipExcerpt(text: string, max = SUMMARY_EXCERPT_CHARS): string {
  const t = text.replace(/\s+/g, " ").trim();
  if (t.length <= max) return t;
  return `${t.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

/**
 * Deterministic local summary — no model call. Keeps a readable transcript
 * of dropped turns so the agent retains goals/decisions without full bulk.
 */
export function buildCompactSummary(dropped: Message[]): string {
  return buildCompactSummaryWithBudget(
    dropped,
    SUMMARY_EXCERPT_CHARS,
    COMPACT_SUMMARY_MAX_CHARS,
  );
}

function buildCompactSummaryWithBudget(
  dropped: Message[],
  requestedExcerptChars: number,
  maxChars: number,
): string {
  const entries: Array<{ label: string; body: string }> = [];
  for (const m of dropped) {
    if (m.role !== "user" && m.role !== "assistant") continue;
    const body = messagePlainText(m);
    if (!body) continue;
    const label = m.role === "user" ? "User" : "Assistant";
    entries.push({ label, body });
  }
  if (entries.length === 0) {
    return `${SUMMARY_HEADER}\n\n(${dropped.length} earlier message${dropped.length === 1 ? "" : "s"} omitted; no text content.)`.slice(
      0,
      maxChars,
    );
  }

  const footer = `Folded ${dropped.length} message${dropped.length === 1 ? "" : "s"} (${entries.length} with text).`;
  const labelsLength = entries.reduce(
    (sum, entry, index) =>
      sum + `${index + 1}. ${entry.label}: `.length + 1,
    0,
  );
  const fixedLength =
    SUMMARY_HEADER.length + 2 + labelsLength + 1 + footer.length;
  const excerptBudget = Math.max(1, maxChars - fixedLength);
  const excerptChars = Math.max(
    1,
    Math.min(
      requestedExcerptChars,
      Math.floor(excerptBudget / entries.length),
    ),
  );
  const lines = [SUMMARY_HEADER, ""];
  entries.forEach((entry, index) => {
    lines.push(
      `${index + 1}. ${entry.label}: ${clipExcerpt(entry.body, excerptChars)}`,
    );
  });
  lines.push("", footer);
  return lines.join("\n").trim().slice(0, maxChars);
}

function stripHeavyAssistantFields(m: Message): Message {
  if (m.role !== "assistant") return m;
  const content = (m.content || "").trim();
  // Keep final answer only — drops thinking/tools/parts that bloat the meter
  // and are already omitted from API history when content exists.
  if (!content && (m.toolCalls?.length || m.thinking || m.parts?.length)) {
    // Preserve a minimal tool-only marker so alternation/context isn't empty.
    const marker = messagePlainText(m) || "(earlier tool work)";
    return {
      id: m.id,
      role: "assistant",
      content: marker,
      createdAt: m.createdAt,
      durationMs: m.durationMs,
    };
  }
  if (!m.thinking && !m.toolCalls?.length && !m.parts?.length) return m;
  return {
    id: m.id,
    role: "assistant",
    content: m.content || "",
    attachments: m.attachments,
    createdAt: m.createdAt,
    durationMs: m.durationMs,
  };
}

/**
 * Choose the newest tail that fits `tailBudget` tokens, with a minimum length
 * when the thread is long enough.
 */
export function selectTailMessages(
  messages: Message[],
  tailBudget: number,
  minTail = COMPACT_MIN_TAIL_MESSAGES,
): Message[] {
  if (messages.length === 0) return [];
  const tail: Message[] = [];
  let used = 0;

  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    const cost = estimateMessageTokens(m);
    if (tail.length === 0) {
      tail.unshift(m);
      used += cost;
      continue;
    }
    // Once we have the minimum tail, stop when the next older message won't fit.
    if (tail.length >= minTail && used + cost > tailBudget) break;
    // Below minimum: keep pulling unless a single add would wildly exceed
    // (2× budget) — still prefer continuity on short threads.
    if (tail.length < minTail && used + cost > tailBudget * 2 && tail.length >= 2) {
      break;
    }
    if (tail.length >= minTail && used + cost > tailBudget) break;
    tail.unshift(m);
    used += cost;
  }

  return tail;
}

function usageFor(messages: Message[], modelId: string) {
  return contextUsage(messages, modelId, "");
}

/**
 * Fold older thread messages into one summary user message and keep a recent
 * tail so estimated context lands near {@link COMPACT_TARGET_RATIO}.
 *
 * Pure / local — does not call the model. Safe to run only when the thread
 * is not streaming (caller enforces).
 */
export function compactMessages(
  messages: Message[],
  modelId: string,
  opts?: { targetRatio?: number },
): CompactHistoryResult {
  const targetRatio = opts?.targetRatio ?? COMPACT_TARGET_RATIO;
  const before = usageFor(messages, modelId);
  const empty: CompactHistoryResult = {
    messages,
    changed: false,
    beforeTokens: before.used,
    afterTokens: before.used,
    limit: before.limit,
    droppedCount: 0,
    keptTailCount: messages.length,
  };

  if (messages.length === 0) {
    return { ...empty, reason: "empty" };
  }

  const targetTokens = Math.max(
    1,
    Math.floor(before.limit * Math.min(0.95, Math.max(0.2, targetRatio))),
  );

  // Soft prune: strip tools/thinking from all but the newest assistant when
  // already under target — still useful and counts as a real compact.
  if (before.used <= targetTokens) {
    const pruned = softPruneMessages(messages);
    const after = usageFor(pruned, modelId);
    if (after.used < before.used - 32) {
      return {
        messages: pruned,
        changed: true,
        beforeTokens: before.used,
        afterTokens: after.used,
        limit: before.limit,
        droppedCount: 0,
        keptTailCount: pruned.length,
      };
    }
    return { ...empty, reason: "already-compact" };
  }

  const summaryReserve = Math.min(
    estimateTokens("x".repeat(Math.min(COMPACT_SUMMARY_MAX_CHARS, 8_000))) + 32,
    Math.floor(targetTokens * 0.2),
    4_000,
  );
  const tailBudget = Math.max(
    512,
    targetTokens - SYSTEM_PROMPT_OVERHEAD - summaryReserve,
  );

  let tail = selectTailMessages(messages, tailBudget);
  // Ensure we actually drop something when over budget.
  if (tail.length >= messages.length) {
    // Tail selection kept everything — force a smaller tail.
    const forceMin = Math.min(
      COMPACT_MIN_TAIL_MESSAGES,
      Math.max(2, messages.length - 1),
    );
    tail = messages.slice(-forceMin);
  }
  if (tail.length >= messages.length) {
    const pruned = softPruneMessages(messages);
    const after = usageFor(pruned, modelId);
    if (after.used < before.used - 32) {
      return {
        messages: pruned,
        changed: true,
        beforeTokens: before.used,
        afterTokens: after.used,
        limit: before.limit,
        droppedCount: 0,
        keptTailCount: pruned.length,
      };
    }
    return { ...empty, reason: "nothing-to-fold" };
  }

  const dropped = messages.slice(0, messages.length - tail.length);
  // Lighten tail assistants except the newest message (may still be in-progress UI).
  const lightTail = tail.map((m, idx) => {
    const isNewest = idx === tail.length - 1;
    if (isNewest) return m;
    return stripHeavyAssistantFields(m);
  });

  let summaryExcerptChars = SUMMARY_EXCERPT_CHARS;
  const releasedTail: Message[] = [];
  const composeSummaryText = () => {
    const releasedLines = releasedTail
      .map((message) => {
        const excerpt = clipExcerpt(messagePlainText(message), 320);
        if (!excerpt) return "";
        const label = message.role === "user" ? "User" : "Assistant";
        return `+ ${label}: ${excerpt}`;
      })
      .filter(Boolean);
    const suffix =
      releasedLines.length > 0
        ? `\n\nRecent messages folded under additional pressure:\n${releasedLines.join("\n")}`
        : "";
    const baseLimit = Math.max(0, COMPACT_SUMMARY_MAX_CHARS - suffix.length);
    const base = buildCompactSummaryWithBudget(
      dropped,
      summaryExcerptChars,
      baseLimit,
    );
    return `${base}${suffix}`;
  };
  let summaryText = composeSummaryText();
  let summaryMsg: Message = {
    id: createId(),
    role: "user",
    content: summaryText,
    createdAt: dropped[0]?.createdAt ?? Date.now(),
  };

  // If summary + tail still over target, shrink summary then drop more tail from the front.
  let next = [summaryMsg, ...lightTail];
  let after = usageFor(next, modelId);
  let guard = 0;
  while (after.used > targetTokens && guard < 12) {
    guard += 1;
    if (summaryExcerptChars > 16) {
      summaryExcerptChars = Math.max(
        16,
        Math.floor(summaryExcerptChars * 0.7),
      );
      summaryText = composeSummaryText();
      summaryMsg = { ...summaryMsg, content: summaryText };
      next = [summaryMsg, ...lightTail];
      after = usageFor(next, modelId);
      continue;
    }
    if (lightTail.length > 2) {
      const released = lightTail.shift()!;
      releasedTail.push(released);
      summaryText = composeSummaryText();
      summaryMsg = { ...summaryMsg, content: summaryText };
      next = [summaryMsg, ...lightTail];
      after = usageFor(next, modelId);
      continue;
    }
    break;
  }

  // Dropped count = original length - tail kept (summary is new).
  const droppedCount = messages.length - lightTail.length;
  if (droppedCount <= 0 && after.used >= before.used - 32) {
    return { ...empty, reason: "nothing-to-fold" };
  }

  return {
    messages: next,
    changed: true,
    beforeTokens: before.used,
    afterTokens: after.used,
    limit: before.limit,
    droppedCount,
    keptTailCount: lightTail.length,
  };
}

/** Strip heavy fields from older assistant turns; keep newest message intact. */
function softPruneMessages(messages: Message[]): Message[] {
  if (messages.length === 0) return messages;
  return messages.map((m, idx) => {
    if (idx === messages.length - 1) return m;
    return stripHeavyAssistantFields(m);
  });
}

export function formatCompactResultToast(result: CompactHistoryResult): string {
  const fmt = (n: number) => {
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}m`;
    if (n >= 10_000) return `${Math.round(n / 1_000)}k`;
    if (n >= 1_000) return `${(n / 1_000).toFixed(1).replace(/\.0$/, "")}k`;
    return `${Math.round(n)}`;
  };
  const pct = (used: number, limit: number) =>
    limit > 0 ? `${Math.round((used / limit) * 100)}%` : "?";

  if (!result.changed) {
    if (result.reason === "empty") return "Nothing to compact";
    return `Already compact (${pct(result.beforeTokens, result.limit)} of context)`;
  }
  if (result.droppedCount > 0) {
    return (
      `Compacted ${result.droppedCount} message${result.droppedCount === 1 ? "" : "s"} · ` +
      `${fmt(result.beforeTokens)} → ${fmt(result.afterTokens)} ` +
      `(${pct(result.afterTokens, result.limit)} of context)`
    );
  }
  return (
    `Pruned tool/thinking bulk · ${fmt(result.beforeTokens)} → ${fmt(result.afterTokens)} ` +
    `(${pct(result.afterTokens, result.limit)} of context)`
  );
}
