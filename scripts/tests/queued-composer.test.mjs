import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { queuedComposerDraft } from "../../src/app/queuedComposer.ts";
import { appendReviewComments } from "../../src/reviewComments.ts";

const comment = {
  id: "comment-1",
  threadId: "thread-1",
  sectionId: "turn:1",
  sectionTitle: "Turn 1",
  filePath: "src/App.tsx",
  startIndex: 0,
  endIndex: 0,
  rangeLabel: "+1",
  diff: "@@ -0,0 +1 @@\n+const value = true;",
  body: "Keep this name",
};

const appSource = readFileSync(
  new URL("../../src/App.tsx", import.meta.url),
  "utf8",
);

test("editing a comment-only queue item restores an empty raw draft", () => {
  const comments = [comment];
  const apiText = appendReviewComments("", comments);
  const item = {
    id: "queue-1",
    threadId: "thread-1",
    text: comment.body,
    apiText,
    reviewComments: comments,
    attachments: [],
    createdAt: 1,
  };

  const draft = queuedComposerDraft(item);

  assert.equal(draft, "");
  assert.equal(appendReviewComments(draft, comments), apiText);
});

test("editing a queue item confirms replacement of unsent review comments", () => {
  const handler = appSource.slice(
    appSource.indexOf("const handleEditQueued"),
    appSource.indexOf("const handleSendNowQueued"),
  );

  assert.match(handler, /const pendingComments = activeReviewComments\.length/);
  assert.match(
    handler,
    /pendingText \|\| pendingAtts > 0 \|\| pendingComments > 0/,
  );
  assert.match(
    handler,
    /Replace the current draft, attachments, and review comments with this queued message\?/,
  );
});
