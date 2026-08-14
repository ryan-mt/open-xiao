import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { Terminal, type ITheme } from "@xterm/xterm";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from "react";
import "@xterm/xterm/css/xterm.css";
import {
  appendTerminalOutputTail,
  DISABLE_TERMINAL_INPUT_MODES,
  RESET_STALE_TERMINAL_INPUT_MODES,
  shouldResetTerminalInputModes,
} from "../terminalInputModes";
import { createAsyncCleanupGuard } from "../asyncCleanup";
import { isMacPlatform } from "../lib/isMac";
import { isTauri } from "../lib/isTauri";
import { safeErrorMessage } from "../lib/userFacingError";
import {
  clampTerminalHeight,
  isTerminalFocusedElement,
  loadTerminalHeight,
  saveTerminalHeight,
  TERMINAL_COLLAPSE_THRESHOLD,
  terminalResize,
  terminalStart,
  terminalStop,
  terminalWrite,
  type TerminalExitEvent,
  type TerminalOutputEvent,
} from "../terminal";
import {
  advanceTerminalSequence,
  forgetTerminalSessionForCwd,
  liveTerminalSessionIdForCwd,
} from "../terminalId";
import { usePresence } from "../usePresence";

type Props = {
  open: boolean;
  cwd: string | null;
  onClose: () => void;
  onOpenExternal?: () => void;
};

type Status = "idle" | "starting" | "ready" | "exited" | "error";

/** Trailing throttle for PTY resize IPC so drags stay smooth. */
const PTY_RESIZE_THROTTLE_MS = 120;

function readTerminalTheme(): ITheme {
  const styles = getComputedStyle(document.documentElement);
  const token = (name: string, fallback: string) => {
    const v = styles.getPropertyValue(name).trim();
    return v || fallback;
  };
  const bg = token("--card", "#18181b");
  const fg = token("--foreground", "#fafafa");
  const muted = token("--muted-foreground", "#a1a1aa");
  const border = token("--border", "#3f3f46");
  return {
    background: bg,
    foreground: fg,
    cursor: fg,
    cursorAccent: bg,
    selectionBackground: border,
    black: "#09090b",
    red: "#f87171",
    green: "#4ade80",
    yellow: "#facc15",
    blue: "#60a5fa",
    magenta: "#c084fc",
    cyan: "#22d3ee",
    white: fg,
    brightBlack: muted,
    brightRed: "#fca5a5",
    brightGreen: "#86efac",
    brightYellow: "#fde047",
    brightBlue: "#93c5fd",
    brightMagenta: "#d8b4fe",
    brightCyan: "#67e8f9",
    brightWhite: "#ffffff",
  };
}

function readTerminalFont(): { fontFamily: string; fontSize: number } {
  const styles = getComputedStyle(document.documentElement);
  const fontFamily =
    styles.getPropertyValue("--font-terminal").trim() ||
    '"Cascadia Code", "SF Mono", "JetBrains Mono", Consolas, monospace';
  const parsedSize = Number.parseFloat(
    styles.getPropertyValue("--font-size-terminal"),
  );
  return {
    fontFamily,
    fontSize: Number.isFinite(parsedSize) ? parsedSize : 12,
  };
}

export function TerminalPanel({ open, cwd, onClose, onOpenExternal }: Props) {
  const { visible } = usePresence(open, 220);
  // Once opened, the panel stays mounted while hidden: the PTY keeps running
  // and its output keeps flowing into xterm, so re-open is instant (desktop
  // drawer behavior).
  const [everOpened, setEverOpened] = useState(false);
  useEffect(() => {
    if (open) setEverOpened(true);
  }, [open]);

  const [height, setHeight] = useState(loadTerminalHeight);
  const [status, setStatus] = useState<Status>("idle");
  const [error, setError] = useState<string | null>(null);
  const [exitCode, setExitCode] = useState<number | null>(null);
  const [resizing, setResizing] = useState(false);
  // Bumped by restart actions to re-run the attach effect with a fresh id.
  const [epoch, setEpoch] = useState(0);

  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const outputTailRef = useRef("");
  const fitRef = useRef<FitAddon | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  const lastPtySizeRef = useRef<{
    sessionId: string;
    cols: number;
    rows: number;
  } | null>(null);
  const fitRafRef = useRef(0);
  const resizeTimerRef = useRef(0);
  const pendingResizeRef = useRef<{
    sessionId: string;
    cols: number;
    rows: number;
  } | null>(null);
  const heightRef = useRef(height);
  heightRef.current = height;
  const cwdRef = useRef(cwd);
  cwdRef.current = cwd;
  const visibleRef = useRef(visible);
  visibleRef.current = visible;
  const resizeDrag = useRef<{
    pointerId: number;
    startY: number;
    startH: number;
  } | null>(null);

  const sendResize = useCallback(
    (sessionId: string, cols: number, rows: number) => {
      if (resizeTimerRef.current) {
        pendingResizeRef.current = { sessionId, cols, rows };
        return;
      }
      void terminalResize(sessionId, cols, rows).catch(() => undefined);
      resizeTimerRef.current = window.setTimeout(() => {
        resizeTimerRef.current = 0;
        const pending = pendingResizeRef.current;
        pendingResizeRef.current = null;
        if (pending && pending.sessionId === sessionIdRef.current) {
          void terminalResize(
            pending.sessionId,
            pending.cols,
            pending.rows,
          ).catch(() => undefined);
        }
      }, PTY_RESIZE_THROTTLE_MS);
    },
    [],
  );

  const fit = useCallback(() => {
    const term = termRef.current;
    const fitAddon = fitRef.current;
    const host = hostRef.current;
    if (!term || !fitAddon || !host) return;
    if (host.clientWidth < 8 || host.clientHeight < 8) return;
    try {
      fitAddon.fit();
      const sid = sessionIdRef.current;
      if (sid && term.cols > 0 && term.rows > 0) {
        const last = lastPtySizeRef.current;
        if (
          last?.sessionId === sid &&
          last.cols === term.cols &&
          last.rows === term.rows
        ) {
          return;
        }
        lastPtySizeRef.current = {
          sessionId: sid,
          cols: term.cols,
          rows: term.rows,
        };
        sendResize(sid, term.cols, term.rows);
      }
    } catch {
      /* retry on next frame */
    }
  }, [sendResize]);

  const scheduleFit = useCallback(() => {
    if (fitRafRef.current) return;
    fitRafRef.current = requestAnimationFrame(() => {
      fitRafRef.current = 0;
      fit();
    });
  }, [fit]);

  // Mount xterm once while present; dispose only on component unmount.
  useEffect(() => {
    if (!everOpened) return;
    const host = hostRef.current;
    if (!host) return;

    const terminalFont = readTerminalFont();
    const term = new Terminal({
      allowTransparency: false,
      convertEol: false,
      cursorBlink: true,
      cursorStyle: "bar",
      fontFamily: terminalFont.fontFamily,
      fontSize: terminalFont.fontSize,
      lineHeight: 1,
      scrollback: 10000,
      theme: readTerminalTheme(),
    });
    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(host);
    try {
      const webglAddon = new WebglAddon();
      webglAddon.onContextLoss(() => webglAddon.dispose());
      term.loadAddon(webglAddon);
    } catch {
      // DOM rendering remains available when WebGL is unavailable.
    }
    termRef.current = term;
    fitRef.current = fitAddon;

    const themeObs = new MutationObserver(() => {
      term.options.theme = readTerminalTheme();
      const font = readTerminalFont();
      term.options.fontFamily = font.fontFamily;
      term.options.fontSize = font.fontSize;
      scheduleFit();
    });
    themeObs.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class", "data-theme", "style"],
    });

    const ro = new ResizeObserver(scheduleFit);
    ro.observe(host);

    return () => {
      themeObs.disconnect();
      ro.disconnect();
      if (fitRafRef.current) {
        cancelAnimationFrame(fitRafRef.current);
        fitRafRef.current = 0;
      }
      if (resizeTimerRef.current) {
        window.clearTimeout(resizeTimerRef.current);
        resizeTimerRef.current = 0;
      }
      pendingResizeRef.current = null;
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
  }, [everOpened, scheduleFit]);

  // Attach to the workspace PTY (spawn on first use, re-attach with replay
  // afterwards). Runs while mounted — including when hidden — so output is
  // never lost between hide and show.
  useEffect(() => {
    if (!everOpened) return;
    const term = termRef.current;
    if (!term) return;

    const cwdNow = cwdRef.current;
    if (!cwdNow?.trim() || !isTauri()) {
      setStatus("idle");
      setError(null);
      sessionIdRef.current = null;
      return;
    }

    const cleanupGuard = createAsyncCleanupGuard();
    let renderedSequence = 0;
    let started = false;
    let exited = false;
    const pending: TerminalOutputEvent[] = [];
    const sessionId = liveTerminalSessionIdForCwd(cwdNow);
    const sessionCwd = cwdNow;
    sessionIdRef.current = sessionId;

    const renderOutput = (data: string) => {
      outputTailRef.current = appendTerminalOutputTail(
        outputTailRef.current,
        data,
      );
      term.write(data);
    };

    const dataSub = term.onData((data) => {
      const sid = sessionIdRef.current;
      if (!sid || exited) return;
      if (shouldResetTerminalInputModes(outputTailRef.current, data)) {
        term.write(RESET_STALE_TERMINAL_INPUT_MODES);
        return;
      }
      void terminalWrite(sid, data).catch((err) => {
        if (!cleanupGuard.disposed && !exited) {
          setStatus("error");
          setError(safeErrorMessage(err, "Could not write to the terminal."));
        }
      });
    });

    setStatus("starting");
    setError(null);
    setExitCode(null);
    outputTailRef.current = "";
    term.reset();

    const run = async () => {
      try {
        const outputUnlisten: UnlistenFn = await listen<TerminalOutputEvent>(
          "terminal://output",
          (ev) => {
            if (cleanupGuard.disposed || ev.payload.sessionId !== sessionId)
              return;
            if (!started) {
              pending.push(ev.payload);
              return;
            }
            const next = advanceTerminalSequence(
              renderedSequence,
              ev.payload.sequence,
            );
            if (next == null) return;
            renderedSequence = next;
            renderOutput(ev.payload.data);
          },
        );
        cleanupGuard.add(outputUnlisten);
        if (cleanupGuard.disposed) return;
        const exitUnlisten: UnlistenFn = await listen<TerminalExitEvent>(
          "terminal://exit",
          (ev) => {
            if (ev.payload.sessionId !== sessionId) return;
            if (cleanupGuard.disposed) return;
            exited = true;
            if (sessionIdRef.current === sessionId) sessionIdRef.current = null;
            setStatus("exited");
            setExitCode(ev.payload.exitCode ?? null);
            term.write(DISABLE_TERMINAL_INPUT_MODES);
            const code =
              ev.payload.exitCode != null ? ` code ${ev.payload.exitCode}` : "";
            term.writeln(`\r\n[terminal] exited${code}`);
          },
        );
        cleanupGuard.add(exitUnlisten);
        if (cleanupGuard.disposed) return;

        await new Promise<void>((r) => requestAnimationFrame(() => r()));
        if (cleanupGuard.disposed) return;
        fit();
        const cols = Math.max(term.cols || 80, 20);
        const rows = Math.max(term.rows || 24, 4);

        const result = await terminalStart(sessionId, cwdNow, cols, rows);
        if (cleanupGuard.disposed) {
          void terminalStop(sessionId).catch(() => undefined);
          return;
        }
        if (exited || sessionIdRef.current !== sessionId) {
          void terminalStop(sessionId).catch(() => undefined);
          return;
        }
        if (result.replay) {
          term.reset();
          outputTailRef.current = "";
          renderOutput(result.replay);
          renderedSequence = result.replaySequence;
        }
        started = true;
        for (const chunk of pending) {
          const next = advanceTerminalSequence(
            renderedSequence,
            chunk.sequence,
          );
          if (next == null) continue;
          renderedSequence = next;
          renderOutput(chunk.data);
        }
        pending.length = 0;
        setStatus("ready");
        fit();
        if (visibleRef.current) term.focus();
      } catch (err) {
        if (cleanupGuard.disposed) return;
        setStatus("error");
        setError(safeErrorMessage(err, "Could not start the terminal."));
      }
    };

    void run();

    return () => {
      cleanupGuard.dispose();
      dataSub.dispose();
      if (sessionIdRef.current === sessionId) {
        sessionIdRef.current = null;
      }
      lastPtySizeRef.current = null;
      // Keep the PTY alive across hide/show and remounts; only stop it when
      // the workspace changed (the next attach owns a different session).
      if (cwdRef.current !== sessionCwd) {
        forgetTerminalSessionForCwd(sessionCwd);
        void terminalStop(sessionId).catch(() => undefined);
      }
    };
  }, [everOpened, cwd, epoch, fit]);

  // Focus + fit when opening.
  useEffect(() => {
    if (!visible) return;
    const id = requestAnimationFrame(() => {
      fit();
      termRef.current?.focus();
    });
    return () => cancelAnimationFrame(id);
  }, [visible, height, fit]);

  // Re-clamp the saved height when the window shrinks.
  useEffect(() => {
    if (!everOpened) return;
    const onWindowResize = () => {
      setHeight((h) => {
        const clamped = clampTerminalHeight(h, window.innerHeight);
        return clamped === h ? h : clamped;
      });
    };
    window.addEventListener("resize", onWindowResize);
    return () => window.removeEventListener("resize", onWindowResize);
  }, [everOpened]);

  // Clear the screen with familiar terminal shortcuts — but only
  // while the terminal owns focus; capture phase beats the app-level handler.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target instanceof Element ? e.target : null;
      if (!isTerminalFocusedElement(target)) return;
      const key = e.key.toLowerCase();
      const mac = isMacPlatform();
      const isClear =
        (e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey && key === "l") ||
        (mac &&
          e.metaKey &&
          !e.ctrlKey &&
          !e.altKey &&
          !e.shiftKey &&
          key === "k");
      if (isClear) {
        e.preventDefault();
        e.stopPropagation();
        const term = termRef.current;
        if (term) {
          term.write(DISABLE_TERMINAL_INPUT_MODES);
          term.clear();
        }
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  const restart = useCallback(() => {
    const cwdNow = cwdRef.current;
    if (!cwdNow?.trim() || !isTauri()) return;
    const sid = sessionIdRef.current ?? liveTerminalSessionIdForCwd(cwdNow);
    // Fresh incarnation id so the dying session's exit event cannot be
    // mistaken for the replacement's.
    forgetTerminalSessionForCwd(cwdNow);
    void terminalStop(sid).catch(() => undefined);
    setEpoch((n) => n + 1);
  }, []);

  const killSession = useCallback(() => {
    const sid = sessionIdRef.current;
    if (!sid) return;
    void terminalStop(sid).catch(() => undefined);
  }, []);

  const clearTerminal = useCallback(() => {
    const term = termRef.current;
    if (!term) return;
    term.write(DISABLE_TERMINAL_INPUT_MODES);
    term.clear();
    if (visibleRef.current) term.focus();
  }, []);

  const refocus = useCallback(() => {
    if (visibleRef.current) termRef.current?.focus();
  }, []);

  const onResizePointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    resizeDrag.current = {
      pointerId: e.pointerId,
      startY: e.clientY,
      startH: heightRef.current,
    };
    setResizing(true);
  };

  const onResizePointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const drag = resizeDrag.current;
    if (!drag || drag.pointerId !== e.pointerId) return;
    const raw = drag.startH + (drag.startY - e.clientY);
    // opencode-style: dragging the drawer below the threshold closes it.
    if (raw < TERMINAL_COLLAPSE_THRESHOLD) {
      resizeDrag.current = null;
      setResizing(false);
      try {
        e.currentTarget.releasePointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }
      onClose();
      return;
    }
    setHeight(clampTerminalHeight(raw, window.innerHeight));
  };

  const onResizePointerUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    const drag = resizeDrag.current;
    if (!drag || drag.pointerId !== e.pointerId) return;
    resizeDrag.current = null;
    setResizing(false);
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
    saveTerminalHeight(heightRef.current);
  };

  if (!everOpened) return null;

  const cwdOk = Boolean(cwd?.trim());
  const tauriOk = isTauri();
  const usable = cwdOk && tauriOk;
  const sessionActive = status === "ready" || status === "starting";
  const style = {
    "--terminal-panel-height": `${height}px`,
  } as CSSProperties;

  return (
    <div
      className={`terminal-panel${visible ? " is-open" : ""}${resizing ? " is-resizing" : ""}`}
      style={style}
      data-terminal-panel="true"
      data-state={visible ? "open" : "closed"}
      role="region"
      aria-label="Terminal"
      aria-hidden={!visible}
    >
      <div
        className="terminal-panel__resizer"
        onPointerDown={onResizePointerDown}
        onPointerMove={onResizePointerMove}
        onPointerUp={onResizePointerUp}
        onPointerCancel={onResizePointerUp}
        role="separator"
        aria-orientation="horizontal"
        aria-label="Resize terminal"
      />
      <div className="terminal-panel__body">
        <div ref={hostRef} className="terminal-panel__xterm" />
        <div className="terminal-panel__toolbar">
          <div className="terminal-panel__group">
            <button
              type="button"
              className="terminal-panel__btn"
              aria-label="New terminal"
              title="New terminal (restart)"
              disabled={!usable}
              onClick={() => {
                restart();
                refocus();
              }}
            >
              <PlusIcon />
            </button>
            <button
              type="button"
              className="terminal-panel__btn"
              aria-label="Clear terminal"
              title="Clear terminal and reset input modes (Ctrl+L)"
              disabled={!usable}
              onClick={clearTerminal}
            >
              <EraserIcon />
            </button>
            {onOpenExternal ? (
              <button
                type="button"
                className="terminal-panel__btn"
                aria-label="Open external terminal"
                title="Open external terminal"
                onClick={() => {
                  onOpenExternal();
                  refocus();
                }}
              >
                <ExternalIcon />
              </button>
            ) : null}
            <button
              type="button"
              className="terminal-panel__btn"
              aria-label="Kill terminal session"
              title="Kill terminal session"
              disabled={!sessionActive}
              onClick={() => {
                killSession();
                refocus();
              }}
            >
              <TrashIcon />
            </button>
            <button
              type="button"
              className="terminal-panel__btn"
              aria-label="Hide terminal"
              title="Hide terminal (session keeps running)"
              onClick={onClose}
            >
              <ChevronDownIcon />
            </button>
          </div>
        </div>

        {!usable ? (
          <div className="terminal-panel__overlay" role="status">
            <div className="terminal-panel__overlay-card">
              <p>
                {!cwdOk
                  ? "Open a project to use the terminal."
                  : "Interactive terminal is available in the desktop app."}
              </p>
            </div>
          </div>
        ) : status === "exited" ? (
          <div className="terminal-panel__overlay is-passive" role="status">
            <div className="terminal-panel__overlay-card">
              <p>
                Terminal exited
                {exitCode != null ? ` with code ${exitCode}` : ""}
              </p>
              <button
                type="button"
                className="terminal-panel__overlay-btn"
                onClick={() => {
                  restart();
                  refocus();
                }}
              >
                Restart terminal
              </button>
            </div>
          </div>
        ) : status === "error" && error ? (
          <div className="terminal-panel__overlay" role="alert">
            <div className="terminal-panel__overlay-card">
              <p>{error}</p>
              <button
                type="button"
                className="terminal-panel__overlay-btn"
                onClick={() => {
                  restart();
                  refocus();
                }}
              >
                Retry
              </button>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function PlusIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M12 5v14M5 12h14"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
      />
    </svg>
  );
}

function EraserIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M21 21H8a2 2 0 0 1-1.42-.587l-3.994-3.999a2 2 0 0 1 0-2.828l10-10a2 2 0 0 1 2.829 0l5.999 6a2 2 0 0 1 0 2.828L12.834 21"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="m5.082 11.09 8.828 8.828"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function TrashIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M3 6h18"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
      />
      <path
        d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M10 11v6M14 11v6"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
      />
    </svg>
  );
}

function ChevronDownIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="m6 9 6 6 6-6"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function ExternalIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M14 5h5v5M19 5l-9 9"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M11 5H6.5A2.5 2.5 0 0 0 4 7.5v10A2.5 2.5 0 0 0 6.5 20h10a2.5 2.5 0 0 0 2.5-2.5V13"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
