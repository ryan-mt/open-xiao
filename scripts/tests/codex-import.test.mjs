import assert from "node:assert/strict";
import test from "node:test";

import {
  mergeCodexChats,
  removeImportedCodexChats,
} from "../../src/codexImport.ts";

const source = {
  sourceId: "session-1",
  title: "Imported task",
  cwd: "C:\\work\\repo\\",
  modelId: "gpt-5.6-sol",
  messages: [
    { role: "user", content: "Do it", createdAt: 100 },
    { role: "assistant", content: "Done", thinking: "Plan", createdAt: 200 },
  ],
  createdAt: 50,
  updatedAt: 200,
};

test("Codex imports are deterministic and map matching workspaces", () => {
  const result = mergeCodexChats(
    [],
    [source],
    [{ id: "project-1", name: "repo", path: "c:/work/repo", createdAt: 1, updatedAt: 1 }],
  );

  assert.equal(result.added, 1);
  assert.equal(result.updated, 0);
  assert.equal(result.threads[0].id, "codex-session-1");
  assert.equal(result.threads[0].projectId, "project-1");
  assert.equal(result.threads[0].modelId, "gpt-5.6-sol");
  assert.equal(result.threads[0].messages[1].thinking, "Plan");
});

test("Codex re-import updates transcript while preserving local thread state", () => {
  const initial = mergeCodexChats([], [source], []).threads[0];
  const local = {
    ...initial,
    title: "My renamed chat",
    pinned: true,
    projectId: "moved-project",
    modelId: "gpt-5.6-luna",
    archivedAt: 300,
    lastVisitedAt: 250,
  };
  const changed = {
    ...source,
    messages: [...source.messages, { role: "user", content: "One more", createdAt: 400 }],
    updatedAt: 400,
  };
  const result = mergeCodexChats([local], [changed], []);

  assert.equal(result.added, 0);
  assert.equal(result.updated, 1);
  assert.equal(result.threads.length, 1);
  assert.equal(result.threads[0].messages.length, 3);
  assert.equal(result.threads[0].title, "My renamed chat");
  assert.equal(result.threads[0].pinned, true);
  assert.equal(result.threads[0].projectId, "moved-project");
  assert.equal(result.threads[0].modelId, "gpt-5.6-luna");
  assert.equal(result.threads[0].archivedAt, 300);
  assert.equal(result.threads[0].lastVisitedAt, 250);
});

test("unchanged Codex re-import does not duplicate chats", () => {
  const first = mergeCodexChats([], [source], []);
  const second = mergeCodexChats(first.threads, [source, source], []);

  assert.equal(second.added, 0);
  assert.equal(second.updated, 0);
  assert.equal(second.unchanged, 1);
  assert.equal(second.threads.length, 1);
});

test("unimport removes every imported Codex chat and leaves ordinary chats", () => {
  const first = mergeCodexChats([], [source], []).threads[0];
  const second = { ...first, id: "codex-session-2" };
  const ordinaryChat = { ...first, id: "ordinary-chat" };
  const result = removeImportedCodexChats([ordinaryChat, first, second]);

  assert.deepEqual(result.removedIds, ["codex-session-1", "codex-session-2"]);
  assert.deepEqual(
    result.threads.map((thread) => thread.id),
    ["ordinary-chat"],
  );
});
