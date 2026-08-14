import type { Message, Thread } from "./types";

export type StreamOverlayEntry = {
  assistantId: string;
  message: Message;
};

/**
 * Live assistant payloads for in-flight streams, kept outside the threads
 * snapshot so token patches do not rewrite the global thread list identity
 * (Sidebar / Settings / palette stay idle while the open chat paints).
 */
export function createStreamOverlayStore() {
  let byThread = new Map<string, StreamOverlayEntry>();
  let version = 0;
  let raf = 0;
  let pendingNotify = false;
  const listeners = new Set<() => void>();

  const emit = () => {
    pendingNotify = false;
    version += 1;
    for (const l of listeners) l();
  };

  const scheduleEmit = () => {
    pendingNotify = true;
    if (raf) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      if (pendingNotify) emit();
    });
  };

  return {
    getSnapshot: () => byThread,
    getVersion: () => version,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    get(threadId: string): StreamOverlayEntry | undefined {
      return byThread.get(threadId);
    },
    /**
     * Replace the live assistant message for a thread.
     * `notify: false` keeps background agents off the React tree.
     */
    set(
      threadId: string,
      entry: StreamOverlayEntry,
      opts?: { notify?: boolean; immediate?: boolean },
    ) {
      const prev = byThread.get(threadId);
      if (
        prev &&
        prev.assistantId === entry.assistantId &&
        prev.message === entry.message
      ) {
        return;
      }
      const next = new Map(byThread);
      next.set(threadId, entry);
      byThread = next;
      if (opts?.notify === false) return;
      if (opts?.immediate) {
        if (raf) {
          cancelAnimationFrame(raf);
          raf = 0;
        }
        emit();
      } else {
        scheduleEmit();
      }
    },
    clear(threadId: string, opts?: { notify?: boolean; immediate?: boolean }) {
      if (!byThread.has(threadId)) return;
      const next = new Map(byThread);
      next.delete(threadId);
      byThread = next;
      if (opts?.notify === false) return;
      if (opts?.immediate) {
        if (raf) {
          cancelAnimationFrame(raf);
          raf = 0;
        }
        emit();
      } else {
        scheduleEmit();
      }
    },
    flush() {
      if (raf) {
        cancelAnimationFrame(raf);
        raf = 0;
      }
      if (pendingNotify) emit();
    },
  };
}

export type StreamOverlayStore = ReturnType<typeof createStreamOverlayStore>;

/** Merge a live overlay assistant message into a thread's messages for display. */
export function applyStreamOverlay(
  messages: Message[],
  entry: StreamOverlayEntry | undefined | null,
): Message[] {
  if (!entry) return messages;
  const idx = messages.findIndex((m) => m.id === entry.assistantId);
  if (idx >= 0) {
    if (messages[idx] === entry.message) return messages;
    const next = messages.slice();
    next[idx] = entry.message;
    return next;
  }
  return [...messages, entry.message];
}

/** Materialize every in-flight assistant before persisting threads on hide/close. */
export function materializeStreamOverlays(
  threads: Thread[],
  overlays: ReadonlyMap<string, StreamOverlayEntry>,
): Thread[] {
  let changed = false;
  const next = threads.map((thread) => {
    const messages = applyStreamOverlay(thread.messages, overlays.get(thread.id));
    if (messages === thread.messages) return thread;
    changed = true;
    return { ...thread, messages };
  });
  return changed ? next : threads;
}
