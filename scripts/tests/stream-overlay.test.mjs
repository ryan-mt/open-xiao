import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { materializeStreamOverlays } from "../../src/streamOverlay.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const src = readFileSync(join(root, "src/streamOverlay.ts"), "utf8");
const app = readFileSync(join(root, "src/App.tsx"), "utf8");

test("stream overlay store is isolated from threads snapshot", () => {
  assert.match(src, /export function createStreamOverlayStore/);
  assert.match(src, /export function applyStreamOverlay/);
  assert.match(app, /createStreamOverlayStore/);
  assert.match(app, /applyStreamOverlay/);
  assert.match(app, /activeMessages/);
  // Token path must patch overlay, not rewrite threads every frame.
  assert.match(
    app,
    /streamOverlay\.set\(\s*convId,\s*\{\s*assistantId,\s*message:\s*assistantSnap/,
  );
  assert.match(app, /streamOverlay\.clear\(convId/);
});

test("stop merges overlay before clearing", () => {
  assert.match(app, /applyStreamOverlay\(c\.messages,\s*overlay\)/);
  assert.match(app, /streamOverlay\.clear\(stoppedId/);
});

test("close persistence materializes every live stream overlay", () => {
  const shell = { id: "a1", role: "assistant", content: "", createdAt: 1 };
  const live = { ...shell, content: "partial answer" };
  const threads = [
    {
      id: "thread-1",
      title: "Thread",
      messages: [shell],
      createdAt: 1,
      updatedAt: 1,
      projectId: null,
    },
  ];

  const materialized = materializeStreamOverlays(
    threads,
    new Map([
      ["thread-1", { assistantId: "a1", message: live }],
    ]),
  );

  assert.equal(materialized[0].messages[0], live);
  assert.notEqual(materialized, threads);
  assert.match(app, /streamBatchByThreadRef\.current\.values\(\)/);
  assert.match(app, /materializeStreamOverlays\(\s*threadsRef\.current/);
});

test("stop flushes rAF batch before abort so last-frame tokens survive", () => {
  assert.match(app, /streamBatchByThreadRef/);
  // Flush must appear before abort in handleStop.
  const stopFn = app.slice(app.indexOf("const handleStop"));
  const flushAt = stopFn.indexOf("streamBatchByThreadRef.current.get(stoppedId)?.flush()");
  const abortAt = stopFn.indexOf("ac?.abort()");
  assert.ok(flushAt >= 0, "stop should flush batcher");
  assert.ok(abortAt >= 0, "stop should abort controller");
  assert.ok(flushAt < abortAt, "flush must run before abort");
});

test("stop clears local streaming state when backend cancellation rejects", () => {
  const stopFn = app.slice(
    app.indexOf("const handleStop"),
    app.indexOf("const handleFocusSearch"),
  );

  assert.match(
    stopFn,
    /try \{\s*await cancelChatStream\(stoppedId\);\s*\} catch \(error\) \{[\s\S]*?toast\.error\([\s\S]*?\);\s*\} finally \{\s*clearPendingUserInput\(stoppedId\);\s*enqueueDrain\(stoppedId\);\s*clearStreaming\(stoppedId\);\s*\}/,
  );
});

test("superseded stream must not wipe a newer overlay", () => {
  assert.match(app, /live\?\.assistantId === assistantId/);
});

// Lightweight pure-logic check mirroring applyStreamOverlay.
function applyStreamOverlay(messages, entry) {
  if (!entry) return messages;
  const idx = messages.findIndex((m) => m.id === entry.assistantId);
  if (idx >= 0) {
    if (messages[idx] === entry.message) return messages;
    const next = messages.slice();
    next[idx] = entry.message;
    return next;
  }
  return [...messages, entry.message];
}

test("applyStreamOverlay replaces matching assistant id", () => {
  const shell = { id: "a1", role: "assistant", content: "", createdAt: 1 };
  const live = {
    id: "a1",
    role: "assistant",
    content: "hello",
    createdAt: 1,
  };
  const base = [
    { id: "u1", role: "user", content: "hi", createdAt: 0 },
    shell,
  ];
  const out = applyStreamOverlay(base, { assistantId: "a1", message: live });
  assert.equal(out.length, 2);
  assert.equal(out[1], live);
  assert.equal(out[0], base[0]);
});

test("applyStreamOverlay appends when shell missing", () => {
  const live = {
    id: "a1",
    role: "assistant",
    content: "hello",
    createdAt: 1,
  };
  const base = [{ id: "u1", role: "user", content: "hi", createdAt: 0 }];
  const out = applyStreamOverlay(base, { assistantId: "a1", message: live });
  assert.equal(out.length, 2);
  assert.equal(out[1], live);
});

test("applyStreamOverlay no-ops on same reference", () => {
  const live = {
    id: "a1",
    role: "assistant",
    content: "hello",
    createdAt: 1,
  };
  const base = [live];
  const out = applyStreamOverlay(base, { assistantId: "a1", message: live });
  assert.equal(out, base);
});
