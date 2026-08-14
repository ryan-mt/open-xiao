import type { UserFacingError } from "./lib/userFacingError";

export type StreamErrorDismissals = ReadonlyMap<string, string>;

function streamErrorFingerprint(error: UserFacingError): string {
  return JSON.stringify([
    error.category,
    error.title,
    error.message,
    error.detail ?? null,
    error.provider ?? null,
    error.retryable,
    error.action,
  ]);
}

export function visibleStreamError(
  dismissals: StreamErrorDismissals,
  threadId: string | null,
  error: UserFacingError | null,
): UserFacingError | null {
  if (!threadId || !error) return error;
  return dismissals.get(threadId) === streamErrorFingerprint(error)
    ? null
    : error;
}

export function dismissStreamError(
  dismissals: StreamErrorDismissals,
  threadId: string,
  error: UserFacingError,
): StreamErrorDismissals {
  const fingerprint = streamErrorFingerprint(error);
  if (dismissals.get(threadId) === fingerprint) return dismissals;
  const next = new Map(dismissals);
  next.set(threadId, fingerprint);
  return next;
}

export function clearStreamErrorDismissal(
  dismissals: StreamErrorDismissals,
  threadId: string,
): StreamErrorDismissals {
  if (!dismissals.has(threadId)) return dismissals;
  const next = new Map(dismissals);
  next.delete(threadId);
  return next;
}
