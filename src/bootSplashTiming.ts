export const BOOT_HOLD_MS = 3000;
export const BOOT_EXIT_MS = 1000;
/** Never keep the whole application behind the splash if storage is slow. */
export const BOOT_MAX_WAIT_MS = 8000;

export function remainingBootHold(
  visibleAt: number,
  now: number,
  holdMs: number,
): number {
  return Math.max(0, holdMs - (now - visibleAt));
}
