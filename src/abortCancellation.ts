/** Forward one AbortSignal to a backend cancellation callback exactly once. */
export function forwardAbort(
  signal: AbortSignal,
  cancel: () => void | Promise<void>,
): () => void {
  let disposed = false;
  let forwarded = false;
  const onAbort = () => {
    if (disposed || forwarded) return;
    forwarded = true;
    void Promise.resolve(cancel()).catch(() => undefined);
  };
  signal.addEventListener("abort", onAbort, { once: true });
  if (signal.aborted) onAbort();
  return () => {
    disposed = true;
    signal.removeEventListener("abort", onAbort);
  };
}
