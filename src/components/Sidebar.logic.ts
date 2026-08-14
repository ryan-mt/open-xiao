/** Pure Sidebar V2 helpers adapted to the Open Xiao Thread model. */

import type { ThreadAttentionKind } from "../threadAttention.ts";

export const SETTLED_TAIL_INITIAL_COUNT = 10;
export const SETTLED_TAIL_PAGE_COUNT = 25;
export const DEFAULT_AUTO_SETTLE_AFTER_DAYS = 14;

export type SidebarV2Status =
  | ThreadAttentionKind
  | "working"
  | "failed"
  | "ready";

/** A new chat remains a local draft until its first message is submitted. */
export function isSidebarThreadVisible(thread: {
  messages: readonly unknown[];
}): boolean {
  return thread.messages.length > 0;
}

export function syncSidebarProjectScope(
  currentScope: string,
  activeProjectId: string | null,
  projectIds: readonly string[],
): string {
  if (currentScope === "all" || currentScope === "inbox") {
    return currentScope;
  }
  if (activeProjectId && projectIds.includes(activeProjectId)) {
    return activeProjectId;
  }
  if (
    currentScope !== "all" &&
    currentScope !== "inbox" &&
    !projectIds.includes(currentScope)
  ) {
    return "all";
  }
  return currentScope;
}

export type ThreadLifecycleInput = {
  id: string;
  createdAt: number;
  updatedAt: number;
  settledAt?: number | null;
  snoozedUntil?: number | null;
  wokeAt?: number | null;
  lastVisitedAt?: number | null;
  lastError?: unknown;
  pinned?: boolean;
};

export function parseTimestampMs(
  value: number | string | null | undefined,
): number {
  if (value == null) return 0;
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? 0 : parsed;
}

/** Snooze outranks settled: active shelf only when wake time is still ahead. */
export function effectiveSnoozed(
  thread: Pick<ThreadLifecycleInput, "snoozedUntil">,
  nowMs: number,
): boolean {
  const until = thread.snoozedUntil;
  return until != null && until > nowMs;
}

/**
 * Settled = explicit stamp, or auto-settle after inactivity.
 * Pinned threads never auto-settle (still can be explicitly settled).
 */
export function effectiveSettled(
  thread: Pick<
    ThreadLifecycleInput,
    "settledAt" | "updatedAt" | "pinned" | "snoozedUntil"
  >,
  opts: {
    nowMs: number;
    autoSettleAfterDays: number;
    working?: boolean;
  },
): boolean {
  if (opts.working) return false;
  if (effectiveSnoozed(thread, opts.nowMs)) return false;
  if (thread.settledAt != null) return true;
  if (thread.pinned) return false;
  const days = opts.autoSettleAfterDays;
  if (!Number.isFinite(days) || days <= 0) return false;
  const windowMs = days * 86_400_000;
  return opts.nowMs - thread.updatedAt >= windowMs;
}

export type SidebarThreadBucket = "active" | "snoozed" | "settled";

export function resolveSidebarThreadBucket(
  thread: ThreadLifecycleInput,
  opts: {
    nowMs: number;
    autoSettleAfterDays: number;
    working: boolean;
    needsAttention: boolean;
  },
): SidebarThreadBucket {
  if (opts.needsAttention) return "active";
  if (effectiveSnoozed(thread, opts.nowMs)) return "snoozed";
  if (effectiveSettled(thread, opts)) return "settled";
  return "active";
}

export function wakeThreadForAttention<T extends ThreadLifecycleInput>(
  thread: T,
  nowMs: number,
): T {
  if (thread.settledAt == null && thread.snoozedUntil == null) return thread;
  return {
    ...thread,
    settledAt: null,
    snoozedUntil: null,
    wokeAt: nowMs,
    updatedAt: nowMs,
  };
}

export function canSnooze(
  thread: Pick<ThreadLifecycleInput, "snoozedUntil">,
  opts: { nowMs: number; working: boolean; needsAttention: boolean },
): boolean {
  if (!canSettle(opts)) return false;
  return !effectiveSnoozed(thread, opts.nowMs);
}

export function canSettle(opts: {
  working: boolean;
  needsAttention: boolean;
}): boolean {
  return !opts.working && !opts.needsAttention;
}

export function resolveSidebarV2Status(input: {
  attention?: ThreadAttentionKind | null;
  working: boolean;
  lastError?: unknown;
}): SidebarV2Status {
  if (input.attention) return input.attention;
  if (input.working) return "working";
  if (input.lastError) return "failed";
  return "ready";
}

/** Unread completion: last assistant message after last visit. */
export function hasUnseenCompletion(input: {
  lastAssistantAt: number | null;
  lastVisitedAt?: number | null;
  working: boolean;
}): boolean {
  if (input.working) return false;
  if (input.lastAssistantAt == null) return false;
  if (input.lastVisitedAt == null) return false;
  return input.lastAssistantAt > input.lastVisitedAt;
}

export function isWokeVisible(input: {
  wokeAt?: number | null;
  lastVisitedAt?: number | null;
}): boolean {
  if (input.wokeAt == null) return false;
  if (input.lastVisitedAt == null) return true;
  return input.lastVisitedAt < input.wokeAt;
}

/** Active list: pinned first, then creation order (newest first; activity does not reorder). */
export function sortThreadsForSidebarV2<
  T extends { id: string; createdAt: number; pinned?: boolean },
>(threads: readonly T[]): T[] {
  return [...threads].sort((a, b) => {
    const pinDiff = Number(Boolean(b.pinned)) - Number(Boolean(a.pinned));
    if (pinDiff) return pinDiff;
    return b.createdAt - a.createdAt || a.id.localeCompare(b.id);
  });
}

export function resolveSettledTimestampMs(
  thread: Pick<ThreadLifecycleInput, "settledAt" | "updatedAt">,
): number {
  if (thread.settledAt != null) return thread.settledAt;
  return thread.updatedAt;
}

export function sortSettledThreadsForSidebarV2<
  T extends { id: string; settledAt?: number | null; updatedAt: number },
>(threads: readonly T[]): T[] {
  return [...threads].sort((a, b) => {
    const diff = resolveSettledTimestampMs(b) - resolveSettledTimestampMs(a);
    return diff || a.id.localeCompare(b.id);
  });
}

export function sortSnoozedThreadsForSidebarV2<
  T extends { id: string; snoozedUntil?: number | null },
>(threads: readonly T[]): T[] {
  return [...threads].sort((a, b) => {
    const diff = (a.snoozedUntil ?? 0) - (b.snoozedUntil ?? 0);
    return diff || a.id.localeCompare(b.id);
  });
}

/**
 * Compact working-time label for sidebar cards.
 * Under 1 minute: live seconds. From 1 minute on: whole minutes only
 * (seconds still tick internally but stay off the UI). Hours drop minutes
 * when exact.
 */
export function formatWorkingDurationLabel(elapsedMs: number): string {
  const totalSeconds = Number.isFinite(elapsedMs)
    ? Math.max(0, Math.floor(elapsedMs / 1000))
    : 0;
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) {
    return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  }
  if (minutes > 0) {
    return `${minutes}m`;
  }
  return `${seconds}s`;
}

export function isTrailingDoubleClick(detail: number): boolean {
  return detail > 1;
}

export function resolveAdjacentThreadId<T>(input: {
  threadIds: readonly T[];
  currentThreadId: T | null;
  direction: "previous" | "next";
}): T | null {
  const { threadIds, currentThreadId, direction } = input;
  if (threadIds.length === 0) return null;
  if (currentThreadId === null) {
    return direction === "previous"
      ? (threadIds[threadIds.length - 1] ?? null)
      : (threadIds[0] ?? null);
  }
  const currentIndex = threadIds.indexOf(currentThreadId);
  if (currentIndex === -1) return null;
  if (direction === "previous") {
    return currentIndex > 0 ? (threadIds[currentIndex - 1] ?? null) : null;
  }
  return currentIndex < threadIds.length - 1
    ? (threadIds[currentIndex + 1] ?? null)
    : null;
}

/** After parking the open thread, jump to next active card or null. */
export function planForwardThreadId(input: {
  orderedActiveIds: readonly string[];
  currentId: string;
  parkingIds?: ReadonlySet<string>;
}): string | null {
  const { orderedActiveIds, currentId, parkingIds } = input;
  const idx = orderedActiveIds.indexOf(currentId);
  if (idx === -1) return null;
  const rotated = [
    ...orderedActiveIds.slice(idx + 1),
    ...orderedActiveIds.slice(0, idx),
  ];
  return rotated.find((id) => id !== currentId && !parkingIds?.has(id)) ?? null;
}
