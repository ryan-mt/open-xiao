import {
  isKnownModelId,
  providerOf,
  storedModelDisplay,
  type ModelProvider,
  type PermissionMode,
} from "./models.ts";
import type { Thread } from "./types.ts";

export function threadModelId(thread: Thread | null | undefined): string | null {
  const id = thread?.modelId?.trim();
  return id && isKnownModelId(id) ? id : null;
}

/** A provider becomes immutable after the first user turn is added. */
export function lockedProviderForThread(
  thread: Thread | null | undefined,
): ModelProvider | null {
  if (!thread || thread.messages.length === 0) return null;
  const id = threadModelId(thread);
  return id ? providerOf(id) : null;
}

export function canSelectModelForThread(
  thread: Thread | null | undefined,
  nextModelId: string,
): boolean {
  const lockedProvider = lockedProviderForThread(thread);
  return lockedProvider == null || lockedProvider === providerOf(nextModelId);
}

export function modelPermissionConflict(
  nextModelId: string,
  permissionMode: PermissionMode,
): string | null {
  return storedModelDisplay(nextModelId)?.provider === "antigravity" &&
    permissionMode === "ask"
    ? "Antigravity does not support Ask. Choose Auto permission before switching."
    : null;
}

/** Bind legacy/unowned threads to the selected model before the first send. */
export function modelIdForThreadSend(
  thread: Thread | null | undefined,
  selectedModelId: string,
): string {
  return threadModelId(thread) ?? selectedModelId;
}
