/** Panel height bounds + clamp (pure, testable without DOM/Tauri).
 *  Default 280; max 60vh + drag-below-50px collapse keep the terminal usable;
 *  top-strip drag resize follows familiar desktop terminal behavior. */

export const TERMINAL_HEIGHT_DEFAULT = 280;
export const TERMINAL_HEIGHT_MIN = 160;
export const TERMINAL_HEIGHT_MAX_VH = 0.6;
export const TERMINAL_COLLAPSE_THRESHOLD = 50;

/** Clamp a panel height into [min, viewport * maxVh]; invalid input → default. */
export function clampTerminalHeight(px: number, viewportHeight: number): number {
  if (!Number.isFinite(px)) return TERMINAL_HEIGHT_DEFAULT;
  const max = Math.max(TERMINAL_HEIGHT_MIN, viewportHeight * TERMINAL_HEIGHT_MAX_VH);
  return Math.round(Math.min(Math.max(px, TERMINAL_HEIGHT_MIN), max));
}
