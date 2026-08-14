import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export type BrowserPreviewBounds = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type BrowserPreviewSnapshot = {
  sessionId: number;
  workspacePath: string;
  url: string;
  title: string | null;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  visible: boolean;
};

export type DiscoveredLocalServer = {
  port: number;
  url: string;
};

export type BrowserPreviewAction = "back" | "forward" | "reload";

export type BrowserPreviewCapture = {
  dataUrl: string;
  mime: string;
  label: string;
};

const LOOPBACK_PREFIX =
  /^(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\])(?::|\/|$)/i;

export function clampBrowserPreviewPanelWidth(
  width: number,
  containerWidth: number,
): number {
  const minimum = 360;
  const maximum = Math.max(minimum, containerWidth - minimum);
  return Math.min(maximum, Math.max(minimum, width));
}

export function isCurrentBrowserPreviewSession(
  snapshot: BrowserPreviewSnapshot | null,
  event: Pick<BrowserPreviewSnapshot, "sessionId" | "workspacePath">,
): boolean {
  return (
    snapshot?.sessionId === event.sessionId &&
    snapshot.workspacePath === event.workspacePath
  );
}

export function isCurrentBrowserPreviewRequest(
  requestEpoch: number,
  currentEpoch: number,
  requestWorkspace: string,
  currentWorkspace: string | null,
): boolean {
  return requestEpoch === currentEpoch && requestWorkspace === currentWorkspace;
}

export function isCurrentBrowserPreviewAction(
  requestEpoch: number,
  currentEpoch: number,
  snapshot: BrowserPreviewSnapshot | null,
  workspacePath: string,
  sessionId: number,
): boolean {
  return (
    requestEpoch === currentEpoch &&
    snapshot?.workspacePath === workspacePath &&
    snapshot.sessionId === sessionId
  );
}

export function createBrowserPreviewLifecycleQueue() {
  let tail: Promise<void> = Promise.resolve();
  return {
    run<T>(task: () => Promise<T>): Promise<T> {
      const request = tail.then(task);
      tail = request.then(
        () => undefined,
        () => undefined,
      );
      return request;
    },
    async drain(): Promise<void> {
      for (;;) {
        const pending = tail;
        await pending;
        if (pending === tail) return;
      }
    },
  };
}

export function createBrowserPreviewPollGate() {
  let pending: Promise<void> | null = null;
  return {
    run(task: () => Promise<void>): Promise<void> | null {
      if (pending) return null;
      const request = Promise.resolve().then(task);
      pending = request;
      const clear = () => {
        if (pending === request) pending = null;
      };
      void request.then(clear, clear);
      return request;
    },
  };
}

export function normalizeBrowserPreviewUrl(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) throw new Error("Enter a URL.");
  const candidate = trimmed.includes("://")
    ? trimmed
    : `${LOOPBACK_PREFIX.test(trimmed) ? "http" : "https"}://${trimmed}`;
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    throw new Error("Enter a valid URL.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Preview URLs must use HTTP or HTTPS.");
  }
  if (url.username || url.password) {
    throw new Error("Preview URLs cannot contain credentials.");
  }
  const host = url.hostname
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "")
    .toLowerCase();
  if (host === "0.0.0.0") url.hostname = "127.0.0.1";
  if (host === "::") url.hostname = "[::1]";
  return url.toString();
}

export function browserPreviewBounds(
  element: Element,
): BrowserPreviewBounds | null {
  const rect = element.getBoundingClientRect();
  if (rect.width < 1 || rect.height < 1) return null;
  return {
    x: Math.max(0, rect.left),
    y: Math.max(0, rect.top),
    width: Math.max(1, rect.width),
    height: Math.max(1, rect.height),
  };
}

export function onBrowserPreviewBoundsReady(
  element: Element,
  handler: (bounds: BrowserPreviewBounds) => void,
): () => void {
  let settled = false;
  const observer = new ResizeObserver(() => notify());
  const notify = () => {
    if (settled) return;
    const bounds = browserPreviewBounds(element);
    if (!bounds) return;
    settled = true;
    observer.disconnect();
    handler(bounds);
  };
  observer.observe(element);
  notify();
  return () => {
    settled = true;
    observer.disconnect();
  };
}

export function openBrowserPreview(
  workspacePath: string,
  url: string,
  bounds: BrowserPreviewBounds,
): Promise<BrowserPreviewSnapshot> {
  return invoke("preview_open", { workspacePath, url, bounds });
}

export function closeBrowserPreview(
  workspacePath: string,
  sessionId: number,
): Promise<void> {
  return invoke("preview_close", { workspacePath, sessionId });
}

export function getBrowserPreviewState(
  workspacePath: string,
): Promise<BrowserPreviewSnapshot | null> {
  return invoke("preview_state", { workspacePath });
}

export function navigateBrowserPreview(
  workspacePath: string,
  sessionId: number,
  url: string,
): Promise<void> {
  return invoke("preview_navigate", { workspacePath, sessionId, url });
}

export function syncBrowserPreviewState(
  workspacePath: string,
  sessionId: number,
): Promise<BrowserPreviewSnapshot> {
  return invoke("preview_sync_state", { workspacePath, sessionId });
}

export function runBrowserPreviewAction(
  workspacePath: string,
  sessionId: number,
  action: BrowserPreviewAction,
): Promise<void> {
  return invoke("preview_action", { workspacePath, sessionId, action });
}

export function setBrowserPreviewBounds(
  workspacePath: string,
  sessionId: number,
  bounds: BrowserPreviewBounds,
): Promise<void> {
  return invoke("preview_set_bounds", { workspacePath, sessionId, bounds });
}

export function setBrowserPreviewVisible(
  workspacePath: string,
  sessionId: number,
  visible: boolean,
): Promise<void> {
  return invoke("preview_set_visible", { workspacePath, sessionId, visible });
}

export function openBrowserPreviewExternal(
  workspacePath: string,
  sessionId: number,
  url: string,
): Promise<void> {
  return invoke("preview_open_external", { workspacePath, sessionId, url });
}

export function captureBrowserPreview(
  workspacePath: string,
  sessionId: number,
): Promise<BrowserPreviewCapture> {
  return invoke("preview_capture", { workspacePath, sessionId });
}

export function discoverLocalServers(
  workspacePath: string,
): Promise<DiscoveredLocalServer[]> {
  return invoke("preview_discover_servers", { workspacePath });
}

export function onBrowserPreviewState(
  handler: (snapshot: BrowserPreviewSnapshot) => void,
): Promise<UnlistenFn> {
  return listen<BrowserPreviewSnapshot>("preview://state", (event) => {
    handler(event.payload);
  });
}

export function onBrowserPreviewBlocked(
  handler: (event: { sessionId: number; workspacePath: string }) => void,
): Promise<UnlistenFn> {
  return listen<{ sessionId: number; workspacePath: string }>(
    "preview://blocked-navigation",
    (event) => handler(event.payload),
  );
}
