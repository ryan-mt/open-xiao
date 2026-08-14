import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  buildChangedFilesTree,
  selectChangedFilePreview,
  shouldAutoExpandChangedFiles,
  summarizeChangedFileScopes,
  summarizeChangedFiles,
} from "../../src/changedFiles.ts";
import { collectMessageReviewFileChanges } from "../../src/reviewChanges.ts";

function file(path, additions, deletions) {
  return {
    path,
    displayPath: path,
    status: "modified",
    additions,
    deletions,
    header: path,
    lines: [],
    toolName: "edit",
    toolId: path,
    messageId: "assistant-1",
  };
}

test("changed-files tree compacts directories and aggregates exact stats", () => {
  const files = [
    file("src/components/App.tsx", 12, 3),
    file("src/components/Sidebar.tsx", 6, 2),
    file("scripts/tests/thread.test.mjs", 88, 0),
  ];
  assert.deepEqual(summarizeChangedFiles(files), {
    additions: 106,
    deletions: 5,
  });
  const tree = buildChangedFilesTree(files);
  assert.equal(tree[0].kind, "directory");
  assert.equal(tree[0].name, "scripts/tests");
  assert.deepEqual(tree[0].stat, { additions: 88, deletions: 0 });
  assert.equal(tree[1].name, "src/components");
  assert.deepEqual(tree[1].stat, { additions: 18, deletions: 5 });
});

test("latest small changes auto-expand while large or older receipts stay compact", () => {
  assert.equal(shouldAutoExpandChangedFiles([file("src/a.ts", 10, 2)], true), true);
  assert.equal(shouldAutoExpandChangedFiles([file("src/a.ts", 199, 2)], true), false);
  assert.equal(shouldAutoExpandChangedFiles([file("src/a.ts", 10, 2)], false), false);
});

test("compact preview represents distinct scopes before filling remaining slots", () => {
  const files = [
    file("src/App.tsx", 1, 0),
    file("src/Sidebar.tsx", 1, 0),
    file("scripts/test.mjs", 1, 0),
    file("README.md", 1, 0),
  ];
  assert.deepEqual(summarizeChangedFileScopes(files), [
    { label: "src", fileCount: 2 },
    { label: "scripts", fileCount: 1 },
    { label: "root", fileCount: 1 },
  ]);
  assert.deepEqual(
    selectChangedFilePreview(files).map((entry) => entry.path),
    ["src/App.tsx", "scripts/test.mjs", "README.md"],
  );
});

test("turn receipt derives only successful mutation tools from that assistant message", () => {
  const message = {
    id: "assistant-1",
    role: "assistant",
    content: "Done",
    createdAt: 1,
    parts: [
      {
        type: "tool",
        id: "edit-1",
        call: {
          id: "edit-1",
          name: "edit",
          args: JSON.stringify({
            filePath: "src/App.tsx",
            oldString: "old",
            newString: "new",
          }),
          result: "Edited src/App.tsx  +1 -1\n-old\n+new",
          status: "done",
        },
      },
      {
        type: "tool",
        id: "read-1",
        call: {
          id: "read-1",
          name: "read",
          args: JSON.stringify({ filePath: "src/App.tsx" }),
          result: "1|new",
          status: "done",
        },
      },
    ],
  };
  const changes = collectMessageReviewFileChanges(message);
  assert.equal(changes.length, 1);
  assert.equal(changes[0].path, "src/App.tsx");
  assert.equal(changes[0].additions, 1);
  assert.equal(changes[0].deletions, 1);
});

test("changed-files actions collapse from their own width instead of the window width", () => {
  const styles = readFileSync(new URL("../../src/styles.css", import.meta.url), "utf8");

  assert.match(styles, /\.changed-files\s*\{[^}]*container-type:\s*inline-size/s);
  assert.match(styles, /@container\s*\(max-width:\s*24rem\)/);
});
