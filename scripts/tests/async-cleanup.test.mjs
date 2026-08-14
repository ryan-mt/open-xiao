import assert from "node:assert/strict";
import test from "node:test";
import { createAsyncCleanupGuard } from "../../src/asyncCleanup.ts";

test("async cleanup guard disposes registered and late resources once", () => {
  const calls = [];
  const guard = createAsyncCleanupGuard();

  guard.add(() => calls.push("registered"));
  guard.dispose();
  guard.add(() => calls.push("late"));
  guard.dispose();

  assert.deepEqual(calls, ["registered", "late"]);
  assert.equal(guard.disposed, true);
});
