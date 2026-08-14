import { invoke } from "@tauri-apps/api/core";
import { isImportedCodexThread } from "./codexImportedThreads.ts";
import { isTauri } from "./lib/isTauri.ts";
import { isKnownModelId, OPENAI_MODELS } from "./models.ts";
import type { Message, Project, Thread } from "./types.ts";

export type CodexImportMessage = {
  role: "user" | "assistant";
  content: string;
  thinking?: string;
  createdAt: number;
};

export type CodexImportThread = {
  sourceId: string;
  title: string;
  cwd?: string | null;
  modelId?: string | null;
  messages: CodexImportMessage[];
  createdAt: number;
  updatedAt: number;
};

export type CodexImportResult = {
  threads: CodexImportThread[];
  scannedFiles: number;
  skippedFiles: number;
  resolvedPath: string;
};

export type CodexMergeResult = {
  threads: Thread[];
  added: number;
  updated: number;
  unchanged: number;
};

export type CodexUnimportResult = {
  threads: Thread[];
  removedIds: string[];
};

export async function importCodexChats(): Promise<CodexImportResult> {
  if (!isTauri()) {
    throw new Error("Codex chat import is available in the desktop app.");
  }
  return invoke<CodexImportResult>("codex_import_chats");
}

export function removeImportedCodexChats(
  current: readonly Thread[],
): CodexUnimportResult {
  const removedIds: string[] = [];
  const threads = current.filter((thread) => {
    if (!isImportedCodexThread(thread)) return true;
    removedIds.push(thread.id);
    return false;
  });
  return { threads, removedIds };
}

function comparablePath(path: string): string {
  const normalized = path.trim().replace(/\\/g, "/").replace(/\/+$/, "");
  return /^[a-z]:\//i.test(normalized) ? normalized.toLowerCase() : normalized;
}

function projectIdForCwd(
  cwd: string | null | undefined,
  projects: readonly Project[],
): string | null {
  if (!cwd?.trim()) return null;
  const target = comparablePath(cwd);
  return (
    projects.find((project) => comparablePath(project.path) === target)?.id ?? null
  );
}

function importedMessages(sourceId: string, messages: CodexImportMessage[]): Message[] {
  return messages.map((message, index) => ({
    id: `codex-${sourceId}-message-${index}`,
    role: message.role,
    content: message.content,
    ...(message.thinking?.trim() ? { thinking: message.thinking } : {}),
    createdAt: message.createdAt,
  }));
}

function sameImportedContent(left: Thread, right: Thread): boolean {
  return (
    left.title === right.title &&
    left.projectId === right.projectId &&
    left.modelId === right.modelId &&
    left.createdAt === right.createdAt &&
    left.updatedAt === right.updatedAt &&
    JSON.stringify(left.messages) === JSON.stringify(right.messages)
  );
}

export function mergeCodexChats(
  current: readonly Thread[],
  imported: readonly CodexImportThread[],
  projects: readonly Project[],
  fallbackOpenAIModelId = OPENAI_MODELS[0].id,
): CodexMergeResult {
  const existingById = new Map(current.map((thread) => [thread.id, thread]));
  const incomingById = new Map<string, Thread>();
  let added = 0;
  let updated = 0;
  let unchanged = 0;

  for (const source of imported) {
    const id = `codex-${source.sourceId}`;
    if (incomingById.has(id)) continue;
    const existing = existingById.get(id);
    const importedModelId =
      source.modelId && isKnownModelId(source.modelId)
        ? source.modelId
        : fallbackOpenAIModelId;
    const next: Thread = {
      ...(existing ?? {}),
      id,
      title: existing?.title ?? source.title,
      messages: importedMessages(source.sourceId, source.messages),
      createdAt: source.createdAt,
      updatedAt: source.updatedAt,
      pinned: existing?.pinned ?? false,
      projectId: existing
        ? existing.projectId
        : projectIdForCwd(source.cwd, projects),
      modelId: existing?.modelId ?? importedModelId,
      settledAt: existing?.settledAt ?? source.updatedAt,
      snoozedUntil: existing?.snoozedUntil ?? null,
      wokeAt: existing?.wokeAt ?? null,
      lastVisitedAt: existing?.lastVisitedAt ?? null,
      lastError: existing?.lastError ?? null,
      archivedAt: existing?.archivedAt ?? null,
      worktreePath: existing?.worktreePath ?? null,
      worktreeBranch: existing?.worktreeBranch ?? null,
    };
    incomingById.set(id, next);
    if (!existing) added += 1;
    else if (sameImportedContent(existing, next)) unchanged += 1;
    else updated += 1;
  }

  const untouched = current.filter((thread) => !incomingById.has(thread.id));
  const incoming = [...incomingById.values()].sort(
    (left, right) => right.updatedAt - left.updatedAt,
  );
  return { threads: [...incoming, ...untouched], added, updated, unchanged };
}
