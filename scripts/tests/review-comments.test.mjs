import assert from "node:assert/strict";
import test from "node:test";

import { annotateReviewDiffLines } from "../../src/reviewChanges.ts";
import {
  appendReviewComments,
  buildReviewCommentSelection,
  serializeReviewComment,
} from "../../src/reviewComments.ts";

function gitFile(patch) {
  const lines = patch.split("\n").map((raw) => {
    if (raw.startsWith("@@") || raw.startsWith("diff --git") || raw.startsWith("---") || raw.startsWith("+++")) {
      return { kind: "meta", code: raw, raw };
    }
    if (raw.startsWith("+")) return { kind: "add", code: raw.slice(1), raw };
    if (raw.startsWith("-")) return { kind: "del", code: raw.slice(1), raw };
    return { kind: "ctx", code: raw.slice(1), raw };
  });
  return {
    path: "src/components/Sidebar.tsx",
    displayPath: "src/components/Sidebar.tsx",
    status: "modified",
    additions: 4,
    deletions: 0,
    header: "src/components/Sidebar.tsx",
    lines: annotateReviewDiffLines(lines),
    toolName: "git",
    toolId: "git:sidebar",
    messageId: "turn-1",
  };
}

test("single added line becomes +line chip label and exact review XML", () => {
  const file = gitFile([
    "diff --git a/src/components/Sidebar.tsx b/src/components/Sidebar.tsx",
    "--- a/src/components/Sidebar.tsx",
    "+++ b/src/components/Sidebar.tsx",
    "@@ -17,0 +18,1 @@",
    '+import { GrokLogo } from "./GrokLogo";',
  ].join("\n"));
  const selection = buildReviewCommentSelection(file, 4, 4);
  assert.deepEqual(selection, {
    filePath: "src/components/Sidebar.tsx",
    startIndex: 0,
    endIndex: 0,
    rangeLabel: "+18",
    diff: '@@ -17,0 +18,1 @@\n+import { GrokLogo } from "./GrokLogo";',
  });

  const xml = serializeReviewComment({
    ...selection,
    id: "comment-1",
    threadId: "thread-1",
    sectionId: "turn:019fd908-667c-7980-937c-09500216b020",
    sectionTitle: "Turn 3",
    body: "hi",
  });
  assert.equal(
    xml,
    '<review_comment sectionId="turn:019fd908-667c-7980-937c-09500216b020" sectionTitle="Turn 3" filePath="src/components/Sidebar.tsx" startIndex="0" endIndex="0" rangeLabel="+18">\nhi\n```diff\n@@ -17,0 +18,1 @@\n+import { GrokLogo } from "./GrokLogo";\n```\n</review_comment>',
  );
});

test("dragged range uses selectable indices and line-number range", () => {
  const code = Array.from({ length: 13 }, (_, index) => ` line ${index + 11}`);
  code[3] = "+line 14 added";
  const file = gitFile(
    [
      "diff --git a/src/components/Sidebar.tsx b/src/components/Sidebar.tsx",
      "--- a/src/components/Sidebar.tsx",
      "+++ b/src/components/Sidebar.tsx",
      "@@ -11,12 +11,13 @@",
      ...code,
    ].join("\n"),
  );
  const selection = buildReviewCommentSelection(file, 4, 16);
  assert.equal(selection.startIndex, 0);
  assert.equal(selection.endIndex, 12);
  assert.equal(selection.rangeLabel, "11 to 23");
  assert.match(selection.diff, /^@@ -11,12 \+11,13 @@\n line 11/);
  assert.match(selection.diff, /\n\+line 14 added\n/);
  assert.match(appendReviewComments("Please fix this", [{
    ...selection,
    id: "comment-2",
    threadId: "thread-1",
    sectionId: "turn:2",
    sectionTitle: "Turn 2",
    body: "Keep the imports together",
  }]), /^Please fix this\n\n<review_comment /);
});
