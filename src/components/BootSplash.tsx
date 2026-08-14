import { useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  BOOT_EXIT_MS,
  BOOT_HOLD_MS,
  BOOT_MAX_WAIT_MS,
  remainingBootHold,
} from "../bootSplashTiming";
import { isTauri } from "../lib/isTauri";
import {
  APP_BASE_NAME,
  APP_DISPLAY_NAME,
  APP_ENVIRONMENT_LABEL,
  APP_FAVICON_SRC,
} from "../branding";

type Props = {
  /** True once durable store hydrate has committed into React state. */
  ready: boolean;
  /** Minimum time the full-shell opening remains visible before settling. */
  minMs?: number;
  /** Exit length; keep in sync with `.boot-splash` CSS `--boot-exit-ms`. */
  exitMs?: number;
  /** Starts the workspace reveal in the same frame as the splash exit. */
  onExitStart?: () => void;
};

function prefersReducedMotion(): boolean {
  if (typeof window === "undefined" || !window.matchMedia) return false;
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/**
 * Xiao signature reveal: the real app shell is visible from the first paint,
 * then its sidebar, workspace, and floating chrome settle together. Unmounts
 * after exit so it never intercepts input.
 */
export function BootSplash({
  ready,
  minMs = BOOT_HOLD_MS,
  exitMs = BOOT_EXIT_MS,
  onExitStart,
}: Props) {
  const [firstPaintAt, setFirstPaintAt] = useState<number | null>(null);
  const [phase, setPhase] = useState<"in" | "out" | "gone">("in");
  const reduced = prefersReducedMotion();
  const holdMs = reduced ? 0 : minMs;
  const fadeMs = reduced ? 0 : exitMs;
  useEffect(() => {
    let cancelled = false;
    const markVisible = () => {
      if (cancelled) return;
      setFirstPaintAt((current) =>
        current ??
        (typeof performance !== "undefined" ? performance.now() : Date.now()),
      );
    };
    window.addEventListener("focus", markVisible);
    const frame = window.requestAnimationFrame(() => {
      // First paint is local and must not wait on a window-manager or IPC call.
      markVisible();
      if (!isTauri()) return;
      void getCurrentWindow().show().catch(() => {
        // Rust-side delayed show remains the last-resort recovery path.
      });
    });
    return () => {
      cancelled = true;
      window.cancelAnimationFrame(frame);
      window.removeEventListener("focus", markVisible);
    };
  }, []);

  useEffect(() => {
    if (firstPaintAt === null || phase !== "in") return;

    const now =
      typeof performance !== "undefined" ? performance.now() : Date.now();
    const elapsed = Math.max(0, now - firstPaintAt);
    // Storage should not make the entire app unusable. If hydration is still
    // pending, reveal the shell after a bounded wait while writes stay gated.
    const wait = ready
      ? remainingBootHold(firstPaintAt, now, holdMs)
      : Math.max(0, (reduced ? 0 : BOOT_MAX_WAIT_MS) - elapsed);

    const startExit = window.setTimeout(() => {
      onExitStart?.();
      setPhase("out");
    }, wait);
    return () => window.clearTimeout(startExit);
  }, [ready, firstPaintAt, phase, holdMs, onExitStart, reduced]);

  useEffect(() => {
    if (phase !== "out") return;
    const done = window.setTimeout(() => setPhase("gone"), fadeMs);
    return () => window.clearTimeout(done);
  }, [phase, fadeMs]);

  if (phase === "gone") return null;

  return (
    <div
      className={`boot-splash${phase === "out" ? " is-exiting" : ""}`}
      role="status"
      aria-live="polite"
      aria-busy={phase === "in"}
      aria-label={phase === "in" ? `Starting ${APP_DISPLAY_NAME}` : undefined}
    >
      <div className="boot-splash__identity" aria-hidden>
        <img className="boot-splash__mark" src={APP_FAVICON_SRC} alt="" />
        <span className="boot-splash__identity-copy">
          <span className="boot-splash__identity-name">{APP_BASE_NAME}</span>
          <span className="boot-splash__identity-stage">
            {APP_ENVIRONMENT_LABEL}
          </span>
        </span>
      </div>
    </div>
  );
}
