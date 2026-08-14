import assert from "node:assert/strict";
import test from "node:test";

import { createKeyedSerialQueue } from "../../src/keyedSerialQueue.ts";

test("serial queue preserves write order for one key", async () => {
  const enqueue = createKeyedSerialQueue();
  let release;
  const completed = [];
  const first = enqueue("prefs", () => new Promise((resolve) => {
    release = () => {
      completed.push("old");
      resolve();
    };
  }));
  const second = enqueue("prefs", async () => {
    completed.push("new");
  });
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(completed, []);
  release();
  await Promise.all([first, second]);
  assert.deepEqual(completed, ["old", "new"]);
});

test("serial queue does not block independent keys", async () => {
  const enqueue = createKeyedSerialQueue();
  let release;
  const slow = enqueue("prefs", () => new Promise((resolve) => {
    release = resolve;
  }));
  let projectSaved = false;
  await enqueue("projects", async () => {
    projectSaved = true;
  });
  assert.equal(projectSaved, true);
  release();
  await slow;
});
