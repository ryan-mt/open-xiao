import assert from "node:assert/strict";
import test from "node:test";
import {
  canClearStashedComposer,
  isCurrentComposerOwner,
} from "../../src/composerOwnership.ts";

test("async composer work keeps ownership only for the same tab and epoch", () => {
  const owner = { activeId: "thread-a", epoch: 4 };
  assert.equal(isCurrentComposerOwner(owner, "thread-a", 4), true);
  assert.equal(isCurrentComposerOwner(owner, "thread-b", 4), false);
  assert.equal(isCurrentComposerOwner(owner, "thread-a", 5), false);
});

test("delayed stash clears only the exact captured draft and attachments", () => {
  const base = {
    owner: { activeId: "thread-a", epoch: 4 },
    activeId: "thread-a",
    epoch: 4,
    capturedDraft: "ship it",
    currentDraft: "ship it",
    capturedAttachmentIds: ["one", "two"],
    currentAttachmentIds: ["one", "two"],
  };
  assert.equal(canClearStashedComposer(base), true);
  assert.equal(
    canClearStashedComposer({ ...base, currentDraft: "new draft" }),
    false,
  );
  assert.equal(
    canClearStashedComposer({
      ...base,
      currentAttachmentIds: ["one", "three"],
    }),
    false,
  );
  assert.equal(canClearStashedComposer({ ...base, epoch: 5 }), false);
});
