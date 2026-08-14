import assert from "node:assert/strict";
import test from "node:test";

import { forwardAbort } from "../../src/abortCancellation.ts";

test("forwardAbort cancels the backend once when the signal aborts", async () => {
  const controller = new AbortController();
  let calls = 0;
  const dispose = forwardAbort(controller.signal, () => {
    calls += 1;
  });
  controller.abort();
  controller.abort();
  await Promise.resolve();
  assert.equal(calls, 1);
  dispose();
});

test("forwardAbort handles an already-aborted signal", async () => {
  const controller = new AbortController();
  controller.abort();
  let calls = 0;
  forwardAbort(controller.signal, () => {
    calls += 1;
  });
  await Promise.resolve();
  assert.equal(calls, 1);
});
