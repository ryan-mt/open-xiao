import assert from "node:assert/strict";
import test from "node:test";

import {
  findSendTargetProject,
  resolveSendTarget,
} from "../../src/app/sendTarget.ts";
import { configureOpenCodeModels } from "../../src/models.ts";

function thread(overrides = {}) {
  return {
    id: "thread-1",
    title: "Thread",
    messages: [],
    modelId: "grok-4.5",
    createdAt: 1,
    updatedAt: 1,
    projectId: null,
    ...overrides,
  };
}

test("existing target keeps its projectless scope and provider", () => {
  const existing = thread({ modelId: "gpt-5.6-sol", projectId: null });
  const target = resolveSendTarget(
    [existing],
    existing.id,
    "active-project",
    "grok-4.5",
  );

  assert.equal(target?.existing, existing);
  assert.equal(target?.projectId, null);
  assert.equal(target?.modelId, "gpt-5.6-sol");
  assert.equal(target?.provider, "openai");
});

test("existing target keeps its own project instead of the active project", () => {
  const existing = thread({ projectId: "target-project" });
  const target = resolveSendTarget(
    [existing],
    existing.id,
    "active-project",
    "gpt-5.6-sol",
  );

  assert.equal(target?.projectId, "target-project");
  assert.equal(target?.modelId, "grok-4.5");
  assert.equal(target?.provider, "grok");
});

test("unloaded dynamic catalogs keep persisted provider ownership", () => {
  configureOpenCodeModels([]);
  for (const [modelId, provider] of [
    ["opencode::openai/gpt-x", "opencode"],
    ["antigravity::gemini-x", "antigravity"],
  ]) {
    const existing = thread({
      modelId,
      messages: [{ id: "u1", role: "user", content: "hi", createdAt: 1 }],
    });
    const target = resolveSendTarget(
      [existing],
      existing.id,
      "active-project",
      "grok-4.5",
    );

    assert.equal(target?.modelId, modelId);
    assert.equal(target?.provider, provider);
  }
});

test("only a new target inherits the active project and model", () => {
  const target = resolveSendTarget(
    [],
    null,
    "active-project",
    "gpt-5.6-terra",
  );

  assert.equal(target?.existing, null);
  assert.equal(target?.projectId, "active-project");
  assert.equal(target?.modelId, "gpt-5.6-terra");
  assert.equal(target?.provider, "openai");
});

test("missing targets are rejected while retired models bind to the selected model", () => {
  assert.equal(
    resolveSendTarget([], "missing", "active-project", "grok-4.5"),
    null,
  );
  const target = resolveSendTarget(
    [thread({ modelId: "retired-model", projectId: null })],
    "thread-1",
    "active-project",
    "gpt-5.6-sol",
  );

  assert.equal(target?.projectId, null);
  assert.equal(target?.modelId, "gpt-5.6-sol");
  assert.equal(target?.provider, "openai");
});

test("project lookup never falls back for a projectless existing target", () => {
  const target = resolveSendTarget(
    [thread({ projectId: null })],
    "thread-1",
    "active-project",
    "grok-4.5",
  );
  assert.ok(target);
  assert.equal(
    findSendTargetProject(
      [{ id: "active-project", name: "Active", path: "C:/active" }],
      target,
    ),
    null,
  );
});
