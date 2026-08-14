import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  readConfirmDialogState,
  requestConfirmDialog,
  resetConfirmDialogForTests,
  respondToConfirmDialog,
} from "../../src/confirmDialog.ts";

test("themed confirmations serialize concurrent requests", async () => {
  resetConfirmDialogForTests();
  const first = requestConfirmDialog("Delete this worktree?", {
    variant: "destructive",
  });
  const second = requestConfirmDialog("Replace the current draft?");

  assert.deepEqual(readConfirmDialogState(), {
    status: "confirming",
    message: "Delete this worktree?",
    variant: "destructive",
  });
  respondToConfirmDialog(false);
  assert.equal(await first, false);
  assert.deepEqual(readConfirmDialogState(), {
    status: "confirming",
    message: "Replace the current draft?",
    variant: "default",
  });
  respondToConfirmDialog(true);
  assert.equal(await second, true);
  assert.deepEqual(readConfirmDialogState(), { status: "idle" });
});

test("reset safely cancels active and queued confirmations", async () => {
  resetConfirmDialogForTests();
  const active = requestConfirmDialog("First?");
  const queued = requestConfirmDialog("Second?");

  resetConfirmDialogForTests();

  assert.deepEqual(await Promise.all([active, queued]), [false, false]);
  assert.deepEqual(readConfirmDialogState(), { status: "idle" });
});

test("app confirmations use the themed host instead of blocking browser dialogs", () => {
  const app = readFileSync(new URL("../../src/App.tsx", import.meta.url), "utf8");

  assert.doesNotMatch(app, /window\.confirm/);
  assert.match(app, /<ConfirmDialogHost \/>/);
  assert.match(app, /requestConfirmDialog\(/);
});
