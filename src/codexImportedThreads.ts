import type { Thread } from "./types.ts";

export function isImportedCodexThread(thread: Pick<Thread, "id">): boolean {
  return /^codex-[A-Za-z0-9_-]{1,128}$/.test(thread.id);
}
