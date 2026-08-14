import assert from "node:assert/strict";
import test from "node:test";

import {
  canSelectModelForThread,
  lockedProviderForThread,
  modelIdForThreadSend,
  modelPermissionConflict,
  threadModelId,
} from "../../src/threadModel.ts";

const thread = (modelId, messages = []) => ({
  id: "thread-1",
  title: "Thread",
  messages,
  modelId,
  createdAt: 1,
  updatedAt: 1,
  projectId: null,
});

test("empty threads may switch providers", () => {
  const value = thread("grok-4.5");
  assert.equal(lockedProviderForThread(value), null);
  assert.equal(canSelectModelForThread(value, "gpt-5.6-sol"), true);
});

test("Antigravity selection never lowers Ask permission implicitly", () => {
  assert.match(
    modelPermissionConflict("antigravity::gemini-3.6-flash-low", "ask"),
    /does not support Ask/i,
  );
  assert.equal(
    modelPermissionConflict("antigravity::gemini-3.6-flash-low", "auto"),
    null,
  );
  assert.equal(modelPermissionConflict("grok-4.5", "ask"), null);
});

test("working threads may switch models only inside their provider", () => {
  const value = thread("gpt-5.6-sol", [{ role: "user", content: "hi" }]);
  assert.equal(lockedProviderForThread(value), "openai");
  assert.equal(canSelectModelForThread(value, "gpt-5.6-terra"), true);
  assert.equal(canSelectModelForThread(value, "grok-4.5"), false);
});

test("legacy or invalid model ids remain unlocked until the next send binds them", () => {
  const value = thread("missing", [{ role: "user", content: "hi" }]);
  assert.equal(threadModelId(value), null);
  assert.equal(lockedProviderForThread(value), null);
  assert.equal(modelIdForThreadSend(value, "gpt-5.6-sol"), "gpt-5.6-sol");
});

test("valid thread ownership wins over the current global selection", () => {
  const value = thread("grok-4.5", [{ role: "user", content: "hi" }]);
  assert.equal(modelIdForThreadSend(value, "gpt-5.6-sol"), "grok-4.5");
});
