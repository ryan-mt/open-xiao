import assert from "node:assert/strict";
import test from "node:test";

import {
  MAX_VISIBLE_WORK_LOG_ENTRIES,
  compactTimelineGroups,
} from "../../src/messageParts.ts";

const tool = (id) => ({
  id,
  name: "read",
  args: "{}",
  status: "done",
});

test("an interleaved live work run keeps only its newest entry visible", () => {
  const result = compactTimelineGroups([
    { kind: "thinking", key: "thinking-1", text: "Inspecting" },
    { kind: "tools", key: "tools-1", calls: [tool("tool-1"), tool("tool-2")] },
    { kind: "thinking", key: "thinking-2", text: "Checking" },
    { kind: "tools", key: "tools-2", calls: [tool("tool-3")] },
  ]);

  assert.equal(MAX_VISIBLE_WORK_LOG_ENTRIES, 1);
  assert.deepEqual(result.map((group) => group.kind), ["tools", "work-toggle"]);
  assert.deepEqual(result[0].calls.map((call) => call.id), ["tool-3"]);
  assert.equal(result[1].hiddenCount, 4);
  assert.equal(result[1].onlyTools, false);
  assert.equal(result[1].expanded, false);
});

test("expanding a compact work run restores its chronological groups", () => {
  const result = compactTimelineGroups(
    [
      { kind: "thinking", key: "thinking-1", text: "Inspecting" },
      { kind: "tools", key: "tools-1", calls: [tool("tool-1"), tool("tool-2")] },
      { kind: "tools", key: "tools-2", calls: [tool("tool-3")] },
    ],
    true,
  );

  assert.deepEqual(result.map((group) => group.kind), [
    "thinking",
    "tools",
    "tools",
    "work-toggle",
  ]);
  assert.equal(result.at(-1).hiddenCount, 3);
  assert.equal(result.at(-1).expanded, true);
});

test("assistant text separates independently compacted work runs", () => {
  const result = compactTimelineGroups([
    { kind: "tools", key: "tools-a", calls: [tool("tool-1"), tool("tool-2")] },
    { kind: "text", key: "text-1", text: "Checkpoint" },
    { kind: "thinking", key: "thinking-b", text: "Continuing" },
    { kind: "tools", key: "tools-b", calls: [tool("tool-3")] },
  ]);

  assert.deepEqual(result.map((group) => group.kind), [
    "tools",
    "work-toggle",
    "text",
    "tools",
    "work-toggle",
  ]);
  assert.equal(result[1].hiddenCount, 1);
  assert.equal(result[4].hiddenCount, 1);
});

test("active tools stay visible even when they are older than the newest entry", () => {
  const active = { ...tool("tool-running"), status: "running" };
  const result = compactTimelineGroups([
    {
      kind: "tools",
      key: "tools-live",
      calls: [active, tool("tool-hidden"), tool("tool-newest")],
    },
  ]);

  assert.deepEqual(result.map((group) => group.kind), ["tools", "work-toggle"]);
  assert.deepEqual(result[0].calls.map((call) => call.id), [
    "tool-running",
    "tool-newest",
  ]);
  assert.equal(result[1].hiddenCount, 1);
});

test("a caller can preserve a folded plan while compacting other work", () => {
  const plan = { ...tool("plan"), name: "todowrite" };
  const result = compactTimelineGroups(
    [
      {
        kind: "tools",
        key: "tools-live",
        calls: [plan, tool("read-hidden"), tool("read-newest")],
      },
    ],
    false,
    1,
    (call) => call.name === "todowrite",
  );

  assert.deepEqual(result[0].calls.map((call) => call.id), ["plan", "read-newest"]);
  assert.equal(result[1].hiddenCount, 1);
});
