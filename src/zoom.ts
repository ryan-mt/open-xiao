import { isTauri } from "./lib/isTauri";

const KEY = "grok-zoom-v1";
const MIN = 0.5;
const MAX = 2.5;
const STEP = 0.1;
const DEFAULT = 1;

function clamp(n: number): number {
  return Math.min(MAX, Math.max(MIN, Math.round(n * 100) / 100));
}

export function loadZoom(): number {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return DEFAULT;
    const n = Number(raw);
    if (!Number.isFinite(n)) return DEFAULT;
    return clamp(n);
  } catch {
    return DEFAULT;
  }
}

function saveZoom(factor: number) {
  try {
    localStorage.setItem(KEY, String(factor));
  } catch {
    /* ignore */
  }
}

async function setNativeZoom(factor: number): Promise<void> {
  if (!isTauri()) {
    document.documentElement.style.zoom = String(factor);
    return;
  }
  try {
    const { getCurrentWebview } = await import("@tauri-apps/api/webview");
    await getCurrentWebview().setZoom(factor);
  } catch {
    document.documentElement.style.zoom = String(factor);
  }
}

let current = loadZoom();

export function getZoom(): number {
  return current;
}

export async function applyZoom(factor: number): Promise<number> {
  current = clamp(factor);
  saveZoom(current);
  await setNativeZoom(current);
  return current;
}

export async function zoomIn(): Promise<number> {
  return applyZoom(current + STEP);
}

export async function zoomOut(): Promise<number> {
  return applyZoom(current - STEP);
}

export async function zoomReset(): Promise<number> {
  return applyZoom(DEFAULT);
}

/** Wire Ctrl/Cmd + − / = / 0. Returns cleanup. */
export function installZoomHotkeys(): () => void {
  void applyZoom(current);

  const onKeyDown = (e: KeyboardEvent) => {
    if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
    const key = e.key;
    if (key === "=" || key === "+") {
      e.preventDefault();
      void zoomIn();
      return;
    }
    if (key === "-" || key === "_") {
      e.preventDefault();
      void zoomOut();
      return;
    }
    if (key === "0") {
      e.preventDefault();
      void zoomReset();
    }
  };

  window.addEventListener("keydown", onKeyDown, { capture: true });
  return () => window.removeEventListener("keydown", onKeyDown, { capture: true });
}
