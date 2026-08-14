import test from "node:test";
import assert from "node:assert/strict";
import { createRafStreamBatcher } from "../../src/streamBatch.ts";

// One pending frame at a time (the batcher only schedules when idle).
let scheduled = null;
globalThis.requestAnimationFrame = (cb) => {
  scheduled = cb;
  return 1;
};
globalThis.cancelAnimationFrame = () => {
  scheduled = null;
};
function runFrame() {
  const cb = scheduled;
  scheduled = null;
  if (cb) cb();
}

test("rAF batch preserves tool_result → content arrival order", () => {
  const events = [];
  const batcher = createRafStreamBatcher({
    onChunk: (text) => events.push({ kind: "content", text }),
    onToolResult: (t) => events.push({ kind: "result", id: t.id }),
  });

  batcher.onToolResult({ id: "t1", name: "bash", ok: true, result: "done" });
  batcher.onChunk("Hello ");
  batcher.onChunk("world");
  batcher.flush();

  assert.deepEqual(events, [
    { kind: "result", id: "t1" },
    { kind: "content", text: "Hello world" },
  ]);
});

test("rAF batch keeps content → tool → content interleaving", () => {
  const events = [];
  const batcher = createRafStreamBatcher({
    onChunk: (text) => events.push({ kind: "content", text }),
    onToolStart: (t) => events.push({ kind: "start", id: t.id }),
  });

  batcher.onChunk("before ");
  batcher.onToolStart({ id: "t1", name: "grep", args: "{}" });
  batcher.onChunk("after");
  batcher.flush();

  assert.deepEqual(events, [
    { kind: "content", text: "before " },
    { kind: "start", id: "t1" },
    { kind: "content", text: "after" },
  ]);
});

test("adjacent deltas still merge into one commit per frame", () => {
  const events = [];
  const batcher = createRafStreamBatcher({
    onChunk: (text) => events.push(text),
  });

  batcher.onChunk("a");
  batcher.onChunk("b");
  batcher.onChunk("c");
  runFrame();

  assert.deepEqual(events, ["abc"]);
});

test("tool_output chunks merge per tool and keep order with results", () => {
  const events = [];
  const batcher = createRafStreamBatcher({
    onToolOutput: (t) =>
      events.push({ kind: "output", id: t.id, text: t.text }),
    onToolResult: (t) => events.push({ kind: "result", id: t.id }),
  });

  batcher.onToolOutput({ id: "t1", text: "line1\n" });
  batcher.onToolOutput({ id: "t1", text: "line2\n" });
  batcher.onToolResult({ id: "t1", name: "bash", ok: true, result: "exit: 0" });
  batcher.flush();

  assert.deepEqual(events, [
    { kind: "output", id: "t1", text: "line1\nline2\n" },
    { kind: "result", id: "t1" },
  ]);
});

test("tool_output replacement snapshots keep only the newest cumulative value", () => {
  const events = [];
  const batcher = createRafStreamBatcher({
    onToolOutput: (t) => events.push(t),
  });

  batcher.onToolOutput({ id: "t1", text: "line1\n", replace: true });
  batcher.onToolOutput({ id: "t1", text: "line1\nline2\n", replace: true });
  batcher.flush();

  assert.deepEqual(events, [
    { id: "t1", text: "line1\nline2\n", replace: true },
  ]);
});
