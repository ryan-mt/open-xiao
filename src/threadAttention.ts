import { applyStreamOverlay, type StreamOverlayEntry } from "./streamOverlay.ts";
import { collectPendingApprovals } from "./toolApproval.ts";
import type { Message } from "./types.ts";
import type { UserInputRequest } from "./userInput.ts";

export type ThreadAttentionKind = "approval" | "input";

type AttentionThread = {
  id: string;
  messages: Message[];
};

export function resolveThreadAttentionById(
  threads: readonly AttentionThread[],
  overlays: ReadonlyMap<string, StreamOverlayEntry>,
  pendingUserInputByThread: Readonly<
    Record<string, UserInputRequest | null | undefined>
  >,
): Map<string, ThreadAttentionKind> {
  const attentionById = new Map<string, ThreadAttentionKind>();
  for (const thread of threads) {
    if (pendingUserInputByThread[thread.id]) {
      attentionById.set(thread.id, "input");
      continue;
    }
    const messages = applyStreamOverlay(
      thread.messages,
      overlays.get(thread.id),
    );
    if (collectPendingApprovals(messages).length > 0) {
      attentionById.set(thread.id, "approval");
    }
  }
  return attentionById;
}
