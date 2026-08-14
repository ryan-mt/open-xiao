import assert from "node:assert/strict";
import test from "node:test";
import { forkThreadAtMessage, getForkedThreadTitle } from "../../src/app/threadFork.ts";

function sourceThread() {
  return {
    id: "thread-source",
    title: "Investigate auth",
    projectId: "project-1",
    modelId: "grok-4",
    createdAt: 1,
    updatedAt: 2,
    pinned: true,
    settledAt: 3,
    archivedAt: 4,
    lastError: { title: "Failed", message: "Nope", category: "unknown" },
    worktreePath: null,
    worktreeBranch: null,
    messages: [
      {
        id: "user-1",
        role: "user",
        content: "first",
        createdAt: 10,
        attachments: [{ id: "attachment-1", name: "a.png", mime: "image/png", dataUrl: "data:x" }],
      },
      {
        id: "assistant-1",
        role: "assistant",
        content: "answer",
        createdAt: 11,
        toolCalls: [{ id: "tool-1", name: "read", args: "{}", status: "done" }],
        parts: [{ type: "tool", id: "part-1", call: { id: "tool-1", name: "read", args: "{}", status: "done" } }],
      },
      { id: "user-2", role: "user", content: "branch here", createdAt: 12 },
      { id: "assistant-2", role: "assistant", content: "later", createdAt: 13 },
    ],
  };
}

test("fork keeps only history before the selected user message", () => {
  const source = sourceThread();
  const fork = forkThreadAtMessage(source, "user-2");
  assert.ok(fork);
  assert.deepEqual(fork.messages.map((message) => message.content), ["first", "answer"]);
  assert.deepEqual(source.messages.map((message) => message.content), [
    "first",
    "answer",
    "branch here",
    "later",
  ]);
  assert.equal(fork.projectId, source.projectId);
  assert.equal(fork.modelId, source.modelId);
  assert.equal(fork.title, "Investigate auth (fork #1)");
  assert.equal(fork.pinned, false);
  assert.equal(fork.archivedAt, null);
  assert.equal(fork.lastError, null);
});

test("fork assigns fresh ids throughout copied history", () => {
  const source = sourceThread();
  const fork = forkThreadAtMessage(source, "user-2");
  assert.ok(fork);
  assert.notEqual(fork.id, source.id);
  assert.notEqual(fork.messages[0].id, source.messages[0].id);
  assert.notEqual(fork.messages[0].attachments[0].id, source.messages[0].attachments[0].id);
  assert.notEqual(fork.messages[1].toolCalls[0].id, source.messages[1].toolCalls[0].id);
  assert.equal(fork.messages[1].parts[0].call.id, fork.messages[1].toolCalls[0].id);
  assert.notEqual(fork.messages[1].parts[0].id, source.messages[1].parts[0].id);
});

test("fork title increments and invalid boundaries are rejected", () => {
  assert.equal(getForkedThreadTitle("Chat (fork #4)"), "Chat (fork #5)");
  assert.equal(getForkedThreadTitle(""), "New chat (fork #1)");
  assert.equal(forkThreadAtMessage(sourceThread(), "assistant-1"), null);
  assert.equal(forkThreadAtMessage(sourceThread(), "missing"), null);
});

test("worktree fork does not share worktree ownership", () => {
  const source = {
    ...sourceThread(),
    worktreePath: "C:/project/.worktrees/chat",
    worktreeBranch: "xiao/source",
  };
  const fork = forkThreadAtMessage(source, "user-2");
  assert.ok(fork);
  assert.equal(fork.worktreePath, null);
  assert.equal(fork.worktreeBranch, null);
  assert.equal(source.worktreePath, "C:/project/.worktrees/chat");
});
