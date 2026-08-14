import assert from "node:assert/strict";
import test from "node:test";

import {
  filterToolIdsWithSnapshots,
  mutationToolIdsForUndo,
  mutationToolIdsFromMessage,
  toolIdsFromReviewFiles,
} from "../../src/snapshotUndo.ts";

function asstWithTools(tools) {
  return {
    id: "a",
    role: "assistant",
    content: "",
    createdAt: 1,
    parts: tools.map((t) => ({
      type: "tool",
      id: t.id,
      call: t,
    })),
  };
}

test("mutationToolIdsFromMessage only done mutations", () => {
  const msg = asstWithTools([
    {
      id: "w1",
      name: "write",
      args: "{}",
      status: "done",
      result: "ok",
    },
    {
      id: "r1",
      name: "read",
      args: "{}",
      status: "done",
      result: "ok",
    },
    {
      id: "e1",
      name: "edit",
      args: "{}",
      status: "running",
    },
    {
      id: "e2",
      name: "edit",
      args: "{}",
      status: "error",
      result: "oldString not found",
    },
  ]);
  assert.deepEqual(mutationToolIdsFromMessage(msg), ["w1"]);
});

test("mutationToolIdsForUndo turn vs session", () => {
  const messages = [
    { id: "u1", role: "user", content: "1", createdAt: 1 },
    asstWithTools([
      { id: "w0", name: "write", args: "{}", status: "done", result: "ok" },
    ]),
    { id: "u2", role: "user", content: "2", createdAt: 2 },
    asstWithTools([
      { id: "e1", name: "edit", args: "{}", status: "done", result: "ok" },
      { id: "w1", name: "write", args: "{}", status: "done", result: "ok" },
    ]),
  ];
  assert.deepEqual(mutationToolIdsForUndo(messages, "turn"), ["e1", "w1"]);
  assert.deepEqual(mutationToolIdsForUndo(messages, "session"), [
    "w0",
    "e1",
    "w1",
  ]);
});

test("turn scope does not reach back past the latest assistant turn", () => {
  const messages = [
    asstWithTools([
      { id: "w0", name: "write", args: "{}", status: "done", result: "ok" },
    ]),
    { id: "u2", role: "user", content: "explain", createdAt: 2 },
    asstWithTools([
      { id: "r1", name: "read", args: "{}", status: "done", result: "ok" },
    ]),
  ];
  assert.deepEqual(mutationToolIdsForUndo(messages, "turn"), []);
  assert.deepEqual(mutationToolIdsForUndo(messages, "session"), ["w0"]);
});

test("filterToolIdsWithSnapshots intersects available snapshots", () => {
  const snaps = [
    {
      toolId: "w1",
      streamId: "s",
      path: "/a",
      displayPath: "a",
      kind: "modified",
      createdAt: 1,
    },
  ];
  assert.deepEqual(filterToolIdsWithSnapshots(["w0", "w1", "w1"], snaps), [
    "w1",
  ]);
});

test("toolIdsFromReviewFiles de-dupes", () => {
  const files = [
    { toolId: "t1", path: "a" },
    { toolId: "t1", path: "b" },
    { toolId: "t2", path: "c" },
    { toolId: "  ", path: "d" },
  ];
  assert.deepEqual(toolIdsFromReviewFiles(files), ["t1", "t2"]);
});
