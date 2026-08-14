import assert from "node:assert/strict";
import test from "node:test";

import { resolveSidebarV2Status } from "../../src/components/Sidebar.logic.ts";
import { resolveThreadAttentionById } from "../../src/threadAttention.ts";

test("a live approval request marks its thread as needing attention", () => {
  const threads = [{ id: "thread-1", messages: [] }];
  const overlays = new Map([
    [
      "thread-1",
      {
        assistantId: "assistant-1",
        message: {
          id: "assistant-1",
          role: "assistant",
          content: "",
          createdAt: 1,
          parts: [
            {
              type: "tool",
              id: "part-1",
              call: {
                id: "tool-1",
                name: "bash",
                args: "{}",
                status: "awaiting",
              },
            },
          ],
        },
      },
    ],
  ]);

  const attention = resolveThreadAttentionById(threads, overlays, {});

  assert.equal(attention.get("thread-1"), "approval");
});

test("a pending question marks its thread as needing an answer", () => {
  const threads = [{ id: "thread-1", messages: [] }];
  const pendingInput = {
    "thread-1": {
      requestId: "request-1",
      questions: [
        {
          header: "Choice",
          question: "Which option?",
          options: [],
          multiple: false,
          custom: true,
        },
      ],
    },
  };

  const attention = resolveThreadAttentionById(
    threads,
    new Map(),
    pendingInput,
  );

  assert.equal(attention.get("thread-1"), "input");
});

test("attention outranks working and failed sidebar states", () => {
  assert.equal(
    resolveSidebarV2Status({
      attention: "approval",
      working: true,
      lastError: { message: "older failure" },
    }),
    "approval",
  );
});
