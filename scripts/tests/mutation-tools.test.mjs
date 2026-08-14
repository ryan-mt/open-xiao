import assert from "node:assert/strict";
import test from "node:test";

import {
  isEditTool,
  isFileMutationTool,
  isSnapshotMutationTool,
  isWriteTool,
} from "../../src/review/mutationTools.ts";
import { parseJsonObject } from "../../src/lib/parseJsonObject.ts";
import {
  followUpAfterInterrupt,
  stripFollowUpInterruptNote,
} from "../../src/chat/followUpInterrupt.ts";

test("mutation tool classification", () => {
  assert.equal(isFileMutationTool("write"), true);
  assert.equal(isFileMutationTool("WRITE_FILE"), true);
  assert.equal(isFileMutationTool("bash"), false);
  assert.equal(isWriteTool("write_file"), true);
  assert.equal(isEditTool("str_replace"), true);
  assert.equal(isSnapshotMutationTool("delete_file"), true);
  assert.equal(isFileMutationTool("delete_file"), false);
  // Codex-style multi-file patch is a mutation (undo + stats) but not an edit.
  assert.equal(isFileMutationTool("patch"), true);
  assert.equal(isFileMutationTool("apply_patch"), true);
  assert.equal(isFileMutationTool("applypatch"), true);
  assert.equal(isSnapshotMutationTool("patch"), true);
  assert.equal(isSnapshotMutationTool("applypatch"), true);
  assert.equal(isEditTool("applypatch"), true);
  assert.equal(isEditTool("patch"), false);
});

test("parseJsonObject", () => {
  assert.deepEqual(parseJsonObject('{"a":1}'), { a: 1 });
  assert.deepEqual(parseJsonObject(""), {});
  assert.deepEqual(parseJsonObject("not-json"), {});
  assert.deepEqual(parseJsonObject("[1,2]"), {});
});

test("follow-up interrupt note strip/wrap", () => {
  const wrapped = followUpAfterInterrupt("hello");
  assert.match(wrapped, /Follow-up sent while/);
  assert.match(wrapped, /hello$/);
  assert.equal(stripFollowUpInterruptNote(wrapped), "hello");
  assert.equal(stripFollowUpInterruptNote("plain"), "plain");
});
