import type { GitRef } from "./git";

export function filterGitRefs(
  refs: readonly GitRef[],
  query: string,
): GitRef[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [...refs];
  return refs.filter((gitRef) =>
    gitRef.shortName.toLowerCase().includes(needle),
  );
}

export function resolveWorktreeBaseRef(
  refs: readonly GitRef[],
  preferred: string | null | undefined,
): string | null {
  if (preferred && refs.some((gitRef) => gitRef.name === preferred)) {
    return preferred;
  }
  return refs.find((gitRef) => gitRef.current)?.name ?? null;
}
