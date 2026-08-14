import type { Thread } from "../types";

export function needsOrdinaryThreadForProjectSelection(
  thread: Thread,
  projectId: string | null,
): boolean {
  return Boolean(
    thread.worktreePath &&
    thread.messages.length === 0 &&
    thread.projectId !== projectId,
  );
}

/**
 * Empty drafts follow project selection. A populated Inbox thread may be
 * adopted by a project, but an owned thread never moves between projects.
 */
export function rebindThreadProjectOnSelection(
  thread: Thread,
  projectId: string | null,
  now = Date.now(),
): Thread {
  if (
    thread.worktreePath ||
    thread.projectId === projectId ||
    (thread.messages.length > 0 &&
      (thread.projectId !== null || projectId === null))
  ) {
    return thread;
  }
  return { ...thread, projectId, updatedAt: now };
}
