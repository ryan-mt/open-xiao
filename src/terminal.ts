import { invoke } from "@tauri-apps/api/core";
import { isTauri } from "./lib/isTauri";
import { clampTerminalHeight, TERMINAL_HEIGHT_DEFAULT } from "./terminalHeight";

export {
  advanceTerminalSequence,
  forgetTerminalSessionForCwd,
  liveTerminalSessionIdForCwd,
  terminalSessionIdForCwd,
} from "./terminalId";

export type TerminalStartResult = {
  sessionId: string;
  shell: string;
  replay: string;
  replaySequence: number;
};

export type TerminalOutputEvent = {
  sessionId: string;
  data: string;
  sequence: number;
};

export type TerminalExitEvent = {
  sessionId: string;
  exitCode: number | null;
  error: string | null;
};

export async function terminalStart(
  sessionId: string,
  cwd: string,
  cols: number,
  rows: number,
): Promise<TerminalStartResult> {
  if (!isTauri()) {
    throw new Error("Interactive terminal requires the desktop app");
  }
  return invoke<TerminalStartResult>("terminal_start", {
    sessionId,
    cwd,
    cols,
    rows,
  });
}

export async function terminalWrite(
  sessionId: string,
  data: string,
): Promise<void> {
  if (!isTauri()) return;
  await invoke("terminal_write", { sessionId, data });
}

export async function terminalResize(
  sessionId: string,
  cols: number,
  rows: number,
): Promise<void> {
  if (!isTauri()) return;
  await invoke("terminal_resize", { sessionId, cols, rows });
}

export async function terminalStop(sessionId: string): Promise<void> {
  if (!isTauri()) return;
  await invoke("terminal_stop", { sessionId });
}

const HEIGHT_KEY = "grok-terminal-height";

export {
  clampTerminalHeight,
  TERMINAL_COLLAPSE_THRESHOLD,
  TERMINAL_HEIGHT_DEFAULT,
  TERMINAL_HEIGHT_MAX_VH,
  TERMINAL_HEIGHT_MIN,
} from "./terminalHeight";

export function loadTerminalHeight(): number {
  try {
    const raw = localStorage.getItem(HEIGHT_KEY);
    if (!raw) return TERMINAL_HEIGHT_DEFAULT;
    return clampTerminalHeight(Number(raw), window.innerHeight);
  } catch {
    return TERMINAL_HEIGHT_DEFAULT;
  }
}

export function saveTerminalHeight(px: number): void {
  try {
    localStorage.setItem(HEIGHT_KEY, String(Math.round(px)));
  } catch {
    /* ignore */
  }
}

/** True when keyboard focus is inside the terminal panel (xterm owns keys). */
export function isTerminalFocusedElement(el: Element | null | undefined): boolean {
  return el != null && el.closest('[data-terminal-panel="true"]') != null;
}
