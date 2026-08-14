import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  clampBrowserPreviewPanelWidth,
  createBrowserPreviewLifecycleQueue,
  createBrowserPreviewPollGate,
  isCurrentBrowserPreviewAction,
  isCurrentBrowserPreviewRequest,
  isCurrentBrowserPreviewSession,
  normalizeBrowserPreviewUrl,
  onBrowserPreviewBoundsReady,
} from "../../src/browserPreview.ts";

const panelSource = readFileSync(
  new URL("../../src/components/BrowserPreviewPanel.tsx", import.meta.url),
  "utf8",
);
const appSource = readFileSync(
  new URL("../../src/App.tsx", import.meta.url),
  "utf8",
);

test("browser preview waits for non-zero panel bounds before auto-open", () => {
  const originalResizeObserver = globalThis.ResizeObserver;
  let callback;
  let disconnected = false;
  globalThis.ResizeObserver = class {
    constructor(next) {
      callback = next;
    }
    observe() {}
    disconnect() {
      disconnected = true;
    }
  };
  let rect = { left: 10, top: 20, width: 0, height: 400 };
  const element = { getBoundingClientRect: () => rect };
  const received = [];
  try {
    onBrowserPreviewBoundsReady(element, (bounds) => received.push(bounds));
    assert.deepEqual(received, []);
    rect = { left: 10, top: 20, width: 540, height: 400 };
    callback();
    assert.deepEqual(received, [{ x: 10, y: 20, width: 540, height: 400 }]);
    assert.equal(disconnected, true);
  } finally {
    if (originalResizeObserver === undefined) {
      Reflect.deleteProperty(globalThis, "ResizeObserver");
    } else {
      globalThis.ResizeObserver = originalResizeObserver;
    }
  }
});

test("browser preview panel width preserves the adjacent workspace", () => {
  assert.equal(clampBrowserPreviewPanelWidth(540, 1200), 540);
  assert.equal(clampBrowserPreviewPanelWidth(1000, 1000), 640);
  assert.equal(clampBrowserPreviewPanelWidth(1000, 900), 540);
  assert.equal(clampBrowserPreviewPanelWidth(200, 1000), 360);
  assert.equal(clampBrowserPreviewPanelWidth(540, 500), 360);
});

test("browser preview normalizes localhost inputs", () => {
  assert.equal(
    normalizeBrowserPreviewUrl("localhost:5173"),
    "http://localhost:5173/",
  );
  assert.equal(
    normalizeBrowserPreviewUrl("http://0.0.0.0:3000/app?q=1"),
    "http://127.0.0.1:3000/app?q=1",
  );
  assert.equal(
    normalizeBrowserPreviewUrl("https://ui.localhost:4173"),
    "https://ui.localhost:4173/",
  );
  assert.equal(
    normalizeBrowserPreviewUrl("http://[::]:3000"),
    "http://[::1]:3000/",
  );
});

test("browser preview supports public HTTP and HTTPS URLs", () => {
  assert.equal(normalizeBrowserPreviewUrl("google.com"), "https://google.com/");
  assert.equal(
    normalizeBrowserPreviewUrl("https://example.com/docs?q=preview"),
    "https://example.com/docs?q=preview",
  );
  assert.equal(
    normalizeBrowserPreviewUrl("http://example.com"),
    "http://example.com/",
  );
});

test("browser preview rejects unsupported and unsafe URLs", () => {
  assert.throws(
    () => normalizeBrowserPreviewUrl("file:///tmp/index.html"),
    /HTTP/,
  );
  assert.throws(
    () => normalizeBrowserPreviewUrl("http://user:secret@localhost:3000"),
    /credentials/,
  );
  assert.throws(() => normalizeBrowserPreviewUrl(""), /Enter/);
});

test("browser preview drops stale requests and events", () => {
  const snapshot = { sessionId: 7, workspacePath: "C:/project" };
  assert.equal(isCurrentBrowserPreviewSession(snapshot, snapshot), true);
  assert.equal(
    isCurrentBrowserPreviewSession(snapshot, {
      sessionId: 6,
      workspacePath: "C:/project",
    }),
    false,
  );
  assert.equal(
    isCurrentBrowserPreviewSession(snapshot, {
      sessionId: 7,
      workspacePath: "C:/other",
    }),
    false,
  );
  assert.equal(
    isCurrentBrowserPreviewRequest(3, 3, "C:/project", "C:/project"),
    true,
  );
  assert.equal(
    isCurrentBrowserPreviewRequest(3, 4, "C:/project", "C:/project"),
    false,
  );
  assert.equal(
    isCurrentBrowserPreviewRequest(3, 3, "C:/project", "C:/other"),
    false,
  );
  const fullSnapshot = {
    sessionId: 7,
    workspacePath: "C:/project",
    url: "http://localhost/",
    title: null,
    loading: false,
    canGoBack: false,
    canGoForward: false,
    visible: true,
  };
  assert.equal(
    isCurrentBrowserPreviewAction(3, 3, fullSnapshot, "C:/project", 7),
    true,
  );
  assert.equal(
    isCurrentBrowserPreviewAction(3, 4, fullSnapshot, "C:/project", 7),
    false,
  );
  assert.equal(
    isCurrentBrowserPreviewAction(3, 3, fullSnapshot, "C:/project", 8),
    false,
  );
});

test("browser preview serializes state polls across effect lifetimes", async () => {
  const gate = createBrowserPreviewPollGate();
  let releaseFirst;
  const first = gate.run(
    () =>
      new Promise((resolve) => {
        releaseFirst = resolve;
      }),
  );
  assert.ok(first);
  assert.equal(gate.run(async () => undefined), null);
  await Promise.resolve();
  releaseFirst();
  await first;
  await Promise.resolve();
  assert.ok(gate.run(async () => undefined));
  assert.match(panelSource, /const pollGateRef = useRef/);
  assert.match(panelSource, /void pollGate\.run\(async \(\) =>/);
});

test("browser preview waits for queued hides before reopening", async () => {
  const queue = createBrowserPreviewLifecycleQueue();
  const order = [];
  let releaseHide;
  const hide = queue.run(
    () =>
      new Promise((resolve) => {
        order.push("hide-start");
        releaseHide = () => {
          order.push("hide-end");
          resolve();
        };
      }),
  );
  const open = queue.run(async () => {
    order.push("open");
  });

  await Promise.resolve();
  assert.deepEqual(order, ["hide-start"]);
  releaseHide();
  await Promise.all([hide, open, queue.drain()]);
  assert.deepEqual(order, ["hide-start", "hide-end", "open"]);
  assert.match(
    panelSource,
    /createBrowserPreviewLifecycleQueue\(\)/,
  );
  assert.match(
    panelSource,
    /await waitForVisibilityQueue\(\);\s*if \(\s*!isCurrentBrowserPreviewRequest/,
  );
  assert.match(
    panelSource,
    /requestEpochRef\.current \+= 1;\s*snapshotRef\.current = null;\s*setSnapshot\(null\);[\s\S]*?queueVisibility\(workspacePath, sessionId, false\)/,
  );
});

test("usage suppresses the native browser preview without closing its session", () => {
  assert.match(
    appSource,
    /<BrowserPreviewPanel[\s\S]*?suppressed=\{[\s\S]*?usageOpen[\s\S]*?\}/,
  );
  assert.match(panelSource, /const nativeSuppressed =\s*\n\s*suppressed/);
  assert.match(panelSource, /queueVisibility\([\s\S]*?false/);
});

test("every aria modal suppresses the native browser preview", () => {
  assert.match(
    panelSource,
    /document\.querySelector\('\[aria-modal="true"\]'\)/,
  );
  assert.doesNotMatch(
    panelSource,
    /document\.querySelector\('\[role="dialog"\]\[aria-modal="true"\]'\)/,
  );
});

test("stale opens are closed and close invalidates ownership before awaiting", () => {
  assert.match(
    panelSource,
    /if \(\s*!isCurrentBrowserPreviewRequest\([\s\S]*?await closeBrowserPreview\(targetWorkspace, next\.sessionId\)/,
  );
  assert.match(
    panelSource,
    /const closeTab = async \(\) => \{\s*const requestEpoch = \+\+requestEpochRef\.current;\s*const current/,
  );
  assert.match(
    panelSource,
    /await closeBrowserPreview\(current\.workspacePath, current\.sessionId\);[\s\S]*?!isCurrentBrowserPreviewAction\([\s\S]*?requestEpoch/,
  );
  assert.match(
    panelSource,
    /catch \(cause\) \{\s*if \(\s*isCurrentBrowserPreviewAction\(/,
  );
});

test("stale captures cannot publish into another browser session", () => {
  assert.match(panelSource, /captureEpochRef\.current \+= 1;[\s\S]*?setCapturing\(false\)/);
  assert.match(
    panelSource,
    /const captureEpoch = \+\+captureEpochRef\.current;[\s\S]*?captureEpoch !== captureEpochRef\.current/,
  );
  assert.match(
    panelSource,
    /catch \(cause\) \{\s*if \(\s*captureEpoch === captureEpochRef\.current &&\s*isCurrentBrowserPreviewSession/,
  );
});
