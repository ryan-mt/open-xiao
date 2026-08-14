export function createAsyncCleanupGuard() {
  let disposed = false;
  const cleanups: Array<() => void> = [];

  return {
    add(cleanup: () => void) {
      if (disposed) cleanup();
      else cleanups.push(cleanup);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const cleanup of cleanups.splice(0)) cleanup();
    },
    get disposed() {
      return disposed;
    },
  };
}
