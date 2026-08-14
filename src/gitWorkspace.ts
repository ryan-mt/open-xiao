/** Pure path helpers for thread worktree / project cwd resolution. */

/** Normalize an optional persisted workspace path without trusting stored data. */
export function normalizeWorkspacePath(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/** Effective agent/git cwd: thread worktree if set, else project path. */
export function resolveWorkspacePath(
  projectPath: unknown,
  worktreePath?: unknown,
): string | null {
  return (
    normalizeWorkspacePath(worktreePath) ?? normalizeWorkspacePath(projectPath)
  );
}

/** Never expose an async workspace result after the active path has changed. */
export function workspaceValueForPath<T>(
  value: T,
  valuePath: string | null,
  activePath: string | null,
): T | null {
  return activePath != null && valuePath === activePath ? value : null;
}
