/** Stable session id from workspace path (client-owned). */
export function terminalSessionIdForCwd(cwd: string): string {
  const raw = cwd.trim().replace(/\\/g, "/").toLowerCase();
  let hash = 2166136261;
  for (let i = 0; i < raw.length; i++) {
    hash ^= raw.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  const hex = (hash >>> 0).toString(16).padStart(8, "0");
  return `term-${hex}`;
}

let terminalIncarnation = 0;

/** Unique id per open so delayed cleanup cannot stop a replacement PTY. */
export function newTerminalSessionIdForCwd(cwd: string): string {
  terminalIncarnation = (terminalIncarnation + 1) >>> 0;
  return `${terminalSessionIdForCwd(cwd)}-${Date.now().toString(36)}-${terminalIncarnation.toString(36)}`;
}

/** Live session id per workspace so hide/show re-attaches to the same PTY. */
const liveTerminalSessionIds = new Map<string, string>();

/**
 * Get the running session id for a workspace, creating one on first use.
 * The id survives panel hide/show and component remounts; the backend keeps
 * the PTY (and its replay buffer) alive under it until stopped.
 */
export function liveTerminalSessionIdForCwd(cwd: string): string {
  const base = terminalSessionIdForCwd(cwd);
  const existing = liveTerminalSessionIds.get(base);
  if (existing) return existing;
  const fresh = newTerminalSessionIdForCwd(cwd);
  liveTerminalSessionIds.set(base, fresh);
  return fresh;
}

/** Drop the live id (kill/restart) so the next attach spawns a fresh PTY. */
export function forgetTerminalSessionForCwd(cwd: string): void {
  liveTerminalSessionIds.delete(terminalSessionIdForCwd(cwd));
}

export function advanceTerminalSequence(
  rendered: number,
  incoming: number,
): number | null {
  if (incoming <= rendered) return null;
  return incoming;
}
