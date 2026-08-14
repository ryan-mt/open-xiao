import type { Thread } from "../types";

export type ThreadStoreSetOpts = {
  /** When false, mutate store + refs only (background stream tokens). */
  notify?: boolean;
  /** Skip rAF and emit listeners immediately (settle / delete / stop). */
  immediate?: boolean;
};

/**
 * External thread store so background-stream token patches can update memory
 * without forcing a full App re-render. Active chat still notifies per frame.
 */
export function createThreadStore(initial: Thread[]) {
  let threads = initial;
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
    getSnapshot: () => threads,
    getVersion: () => version,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    setThreads(
      updater: Thread[] | ((prev: Thread[]) => Thread[]),
      opts?: ThreadStoreSetOpts,
    ) {
      const next =
        typeof updater === "function"
          ? (updater as (prev: Thread[]) => Thread[])(threads)
          : updater;
      if (next === threads) return threads;
      threads = next;
      const shouldNotify = opts?.notify !== false;
      if (!shouldNotify) return threads;
      if (opts?.immediate) {
        if (raf) {
          cancelAnimationFrame(raf);
          raf = 0;
        }
        emit();
      } else {
        scheduleEmit();
      }
      return threads;
    },
    /** Synchronous commit for settle / structural edits. */
    flush() {
      if (raf) {
        cancelAnimationFrame(raf);
        raf = 0;
      }
      if (pendingNotify) emit();
    },
  };
}

export type ThreadStore = ReturnType<typeof createThreadStore>;
