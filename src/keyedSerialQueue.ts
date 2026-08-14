export function createKeyedSerialQueue() {
  const tails = new Map<string, Promise<unknown>>();

  return function enqueue<T>(key: string, task: () => Promise<T>): Promise<T> {
    const previous = tails.get(key) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(task);
    tails.set(key, next);
    const cleanup = () => {
      if (tails.get(key) === next) tails.delete(key);
    };
    void next.then(cleanup, cleanup);
    return next;
  };
}
