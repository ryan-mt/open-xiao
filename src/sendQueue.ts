import type { ImageAttachment } from "./types";
import { createId } from "./types";
import type { ReviewComment } from "./reviewComments";

export type QueuedSend = {
  id: string;
  threadId: string;
  text: string;
  /** Hidden provider payload when UI text has structured context chips. */
  apiText?: string;
  reviewComments?: ReviewComment[];
  attachments: ImageAttachment[];
  createdAt: number;
};

export function createQueuedSend(
  threadId: string,
  text: string,
  attachments: ImageAttachment[],
  apiText?: string,
  reviewComments?: readonly ReviewComment[],
): QueuedSend {
  return {
    id: createId(),
    threadId,
    text: text.trim(),
    apiText: apiText?.trim() || undefined,
    reviewComments: reviewComments?.length ? [...reviewComments] : undefined,
    attachments: [...attachments],
    createdAt: Date.now(),
  };
}

export function queueForThread(
  queue: QueuedSend[],
  threadId: string,
): QueuedSend[] {
  return queue.filter((q) => q.threadId === threadId);
}

export function removeQueued(queue: QueuedSend[], id: string): QueuedSend[] {
  return queue.filter((q) => q.id !== id);
}

export function takeNextForThread(
  queue: QueuedSend[],
  threadId: string,
): { next: QueuedSend | null; rest: QueuedSend[] } {
  const idx = queue.findIndex((q) => q.threadId === threadId);
  if (idx < 0) return { next: null, rest: queue };
  const next = queue[idx];
  const rest = [...queue.slice(0, idx), ...queue.slice(idx + 1)];
  return { next, rest };
}
