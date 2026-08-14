import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  approvalArgsPreview,
  collectPendingApprovals,
  runApprovalBatch,
} from "../../src/toolApproval.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");

test("collectPendingApprovals finds awaiting tools", () => {
  const messages = [
    {
      id: "u1",
      role: "user",
      content: "edit",
      createdAt: 1,
    },
    {
      id: "a1",
      role: "assistant",
      content: "",
      createdAt: 2,
      parts: [
        {
          type: "tool",
          id: "t1",
          call: {
            id: "t1",
            name: "bash",
            args: JSON.stringify({ command: "ls" }),
            status: "awaiting",
            approvalReason: "Run a shell command",
          },
        },
        {
          type: "tool",
          id: "t2",
          call: {
            id: "t2",
            name: "read",
            args: "{}",
            status: "done",
            result: "ok",
          },
        },
      ],
    },
  ];
  const pending = collectPendingApprovals(messages);
  assert.equal(pending.length, 1);
  assert.equal(pending[0].id, "t1");
  assert.equal(pending[0].name, "bash");
  assert.equal(pending[0].reason, "Run a shell command");
});

test("collectPendingApprovals walks nested children", () => {
  const messages = [
    {
      id: "a1",
      role: "assistant",
      content: "",
      createdAt: 1,
      parts: [
        {
          type: "tool",
          id: "task1",
          call: {
            id: "task1",
            name: "task",
            args: "{}",
            status: "running",
            children: [
              {
                id: "c1",
                name: "write",
                args: JSON.stringify({ path: "a.ts" }),
                status: "awaiting",
                approvalReason: "Create or overwrite a file",
              },
            ],
          },
        },
      ],
    },
  ];
  const pending = collectPendingApprovals(messages);
  assert.equal(pending.length, 1);
  assert.equal(pending[0].id, "c1");
  assert.equal(pending[0].parentId, "task1");
});

test("approvalArgsPreview prefers path and command", () => {
  assert.match(
    approvalArgsPreview(JSON.stringify({ filePath: "src/App.tsx" })),
    /App\.tsx/,
  );
  assert.match(
    approvalArgsPreview(JSON.stringify({ command: "npm test" })),
    /npm test/,
  );
  assert.equal(approvalArgsPreview(""), "");
});

test("bulk approval retains the initiating thread across awaits", async () => {
  let activeThread = "thread-a";
  const calls = [];
  await runApprovalBatch(
    activeThread,
    [{ id: "tool-1" }, { id: "tool-2" }],
    async (threadId, toolId) => {
      calls.push([threadId, toolId]);
      activeThread = "thread-b";
    },
  );

  assert.equal(activeThread, "thread-b");
  assert.deepEqual(calls, [
    ["thread-a", "tool-1"],
    ["thread-a", "tool-2"],
  ]);

  const app = readFileSync(join(root, "src/App.tsx"), "utf8");
  assert.equal((app.match(/runApprovalBatch\(id, pending/g) ?? []).length, 2);
});
