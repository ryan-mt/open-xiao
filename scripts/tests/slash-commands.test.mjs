import assert from "node:assert/strict";
import test from "node:test";

import {
  ACCESS_MODES,
  ALL_MODELS,
  GROK_MODELS,
  THINKING_LEVELS,
} from "../../src/models.ts";
import {
  applySlashMenuSelection,
  buildSlashMenuItems,
  executeSlashInput,
  executeSlashMenuItem,
  findCommand,
  getSlashQuery,
  isSlashDraft,
  parseSlashInput,
  resolveArgOption,
  slashCommandsForModel,
  SLASH_COMMANDS,
} from "../../src/slashCommands.ts";

function mockHandlers(overrides = {}) {
  const calls = {
    newChat: 0,
    model: /** @type {string[]} */ ([]),
    thinking: /** @type {string[]} */ ([]),
    access: /** @type {string[]} */ ([]),
    agent: /** @type {string[]} */ ([]),
    permission: /** @type {string[]} */ ([]),
    review: 0,
    compact: 0,
    undo: 0,
    toggleTheme: 0,
    theme: /** @type {string[]} */ ([]),
    notify: /** @type {Array<{ message: string, kind?: string }>} */ ([]),
  };
  const handlers = {
    modelProvider: "grok",
    newChat: () => {
      calls.newChat += 1;
    },
    setModel: (id) => {
      calls.model.push(id);
    },
    setThinking: (level) => {
      calls.thinking.push(level);
      return level;
    },
    setAccessMode: (mode) => {
      calls.access.push(mode);
    },
    setAgentMode: (mode) => {
      calls.agent.push(mode);
    },
    setPermissionMode: (mode) => {
      calls.permission.push(mode);
    },
    openReview: () => {
      calls.review += 1;
    },
    compact: () => {
      calls.compact += 1;
    },
    undoLastTurn: () => {
      calls.undo += 1;
    },
    toggleTheme: () => {
      calls.toggleTheme += 1;
    },
    setTheme: (mode) => {
      calls.theme.push(mode);
    },
    notify: (message, kind) => {
      calls.notify.push({ message, kind });
    },
    ...overrides,
  };
  return { handlers, calls };
}

test("isSlashDraft only accepts leading slash single-line drafts", () => {
  assert.equal(isSlashDraft("/model"), true);
  assert.equal(isSlashDraft("/"), true);
  assert.equal(isSlashDraft("/model grok"), true);
  assert.equal(isSlashDraft("hello /model"), false);
  assert.equal(isSlashDraft("/model\nmore"), false);
  assert.equal(isSlashDraft(""), false);
  assert.equal(isSlashDraft(" /model"), false);
});

test("getSlashQuery mirrors isSlashDraft body", () => {
  assert.equal(getSlashQuery("/mo"), "mo");
  assert.equal(getSlashQuery("nope"), null);
});

test("parseSlashInput splits name and args", () => {
  assert.deepEqual(parseSlashInput("/Model Grok-4.5"), {
    name: "model",
    nameRaw: "Model",
    args: "Grok-4.5",
  });
  assert.deepEqual(parseSlashInput("/"), {
    name: "",
    nameRaw: "",
    args: "",
  });
  assert.equal(parseSlashInput("plain"), null);
});

test("buildSlashMenuItems lists commands for bare slash", () => {
  const items = buildSlashMenuItems("/");
  assert.ok(items.length >= 6);
  assert.ok(items.every((i) => i.kind === "command"));
  assert.ok(items.some((i) => i.command.name === "model"));
  assert.ok(items.some((i) => i.command.name === "help"));
});

test("buildSlashMenuItems filters by command prefix", () => {
  const items = buildSlashMenuItems("/mo");
  assert.ok(items.length >= 1);
  assert.ok(items.every((i) => i.kind === "command"));
  assert.ok(items.some((i) => i.command.name === "model"));
  assert.ok(!items.some((i) => i.command.name === "plan"));
});

test("buildSlashMenuItems opens arg picker after command + space", () => {
  const items = buildSlashMenuItems("/model ");
  assert.ok(items.length > 0);
  assert.ok(items.every((i) => i.kind === "arg"));
  assert.equal(items.length, ALL_MODELS.length);
});

test("buildSlashMenuItems filters model args", () => {
  const items = buildSlashMenuItems("/model grok-4.5");
  assert.ok(items.some((i) => i.kind === "arg" && i.option.id === "grok-4.5"));
});

test("model-specific slash options keep OpenAI reasoning tiers and unified permissions", () => {
  const commands = slashCommandsForModel("gpt-5.6-sol");
  const thinking = buildSlashMenuItems("/thinking ", commands);
  assert.deepEqual(
    thinking.map((item) => item.option.id),
    ["low", "medium", "high", "xhigh", "max", "ultra"],
  );
  // OpenAI now runs natively (not through a non-interactive CLI), so Ask
  // mode keeps the standard label and approval flow across providers.
  const permission = buildSlashMenuItems("/permission ", commands);
  assert.ok(
    permission.some(
      (item) => item.option.id === "ask" && item.option.label === "Ask",
    ),
  );

  const { handlers, calls } = mockHandlers({ modelProvider: "openai" });
  assert.deepEqual(executeSlashInput("/permission ask", handlers, commands), {
    ok: true,
    clearDraft: true,
  });
  assert.equal(calls.notify.at(-1)?.message, "Permission: Ask");
});

test("alias /clear maps to new", () => {
  const cmd = findCommand(SLASH_COMMANDS, "clear");
  assert.ok(cmd);
  assert.equal(cmd.id, "new");
});

test("resolveArgOption prefers exact id and unique prefix", () => {
  const model = findCommand(SLASH_COMMANDS, "model");
  assert.ok(model);
  const exact = resolveArgOption(model, "grok-4.5");
  assert.equal(exact?.id, "grok-4.5");

  const thinking = findCommand(SLASH_COMMANDS, "thinking");
  assert.ok(thinking);
  assert.equal(resolveArgOption(thinking, "hi")?.id, "high");
  assert.equal(resolveArgOption(thinking, "med")?.id, "medium");
});

test("executeSlashInput runs /new and clears", () => {
  const { handlers, calls } = mockHandlers();
  const result = executeSlashInput("/new", handlers);
  assert.deepEqual(result, { ok: true, clearDraft: true });
  assert.equal(calls.newChat, 1);
});

test("executeSlashInput /clear alias", () => {
  const { handlers, calls } = mockHandlers();
  assert.equal(executeSlashInput("/clear", handlers).ok, true);
  assert.equal(calls.newChat, 1);
});

test("executeSlashInput sets model thinking access", () => {
  const { handlers, calls } = mockHandlers();
  assert.equal(executeSlashInput("/model grok-4.5", handlers).ok, true);
  assert.deepEqual(calls.model, ["grok-4.5"]);

  assert.equal(executeSlashInput("/thinking high", handlers).ok, true);
  assert.deepEqual(calls.thinking, ["high"]);

  assert.equal(executeSlashInput("/access workspace", handlers).ok, true);
  assert.deepEqual(calls.access, ["workspace"]);
});

test("executeSlashInput rejects unknown model and does not apply", () => {
  const { handlers, calls } = mockHandlers();
  const result = executeSlashInput("/model not-a-real-model", handlers);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "bad-args");
  assert.deepEqual(calls.model, []);
  assert.ok(calls.notify.some((n) => n.kind === "error"));
});

test("executeSlashInput incomplete when args required", () => {
  const { handlers } = mockHandlers();
  const result = executeSlashInput("/model", handlers);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "incomplete");
});

test("executeSlashInput /theme bare toggles (argsOptional)", () => {
  const { handlers, calls } = mockHandlers();
  assert.equal(executeSlashInput("/theme", handlers).ok, true);
  assert.equal(calls.toggleTheme, 1);

  assert.equal(executeSlashInput("/theme dark", handlers).ok, true);
  assert.deepEqual(calls.theme, ["dark"]);

  assert.equal(executeSlashInput("/theme inkstone", handlers).ok, true);
  assert.deepEqual(calls.theme, ["dark", "inkstone"]);
});

test("executeSlashInput agent review compact help", () => {
  const { handlers, calls } = mockHandlers();
  assert.equal(executeSlashInput("/agent plan", handlers).ok, true);
  assert.deepEqual(calls.agent, ["plan"]);
  assert.equal(executeSlashInput("/build", handlers).ok, true);
  assert.deepEqual(calls.agent, ["plan", "build"]);
  assert.equal(executeSlashInput("/permission ask", handlers).ok, true);
  assert.deepEqual(calls.permission, ["ask"]);
  assert.equal(executeSlashInput("/undo", handlers).ok, true);
  assert.equal(calls.undo, 1);
  assert.equal(executeSlashInput("/review", handlers).ok, true);
  assert.equal(calls.review, 1);
  assert.equal(executeSlashInput("/diff", handlers).ok, true);
  assert.equal(calls.review, 2);
  assert.equal(executeSlashInput("/compact", handlers).ok, true);
  assert.equal(calls.compact, 1);
  assert.equal(executeSlashInput("/squash", handlers).ok, true);
  assert.equal(calls.compact, 2);
  assert.equal(executeSlashInput("/help", handlers).ok, true);
  assert.ok(calls.notify.some((n) => n.message.includes("/model")));
  assert.ok(calls.notify.some((n) => n.message.includes("/compact")));
});

test("executeSlashInput /compact keeps draft when handler returns false", () => {
  const { handlers, calls } = mockHandlers({
    compact: () => false,
  });
  const result = executeSlashInput("/compact", handlers);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "bad-args");
  assert.equal(calls.compact, 0); // overridden handler; counter unused
});

test("executeSlashInput unknown command", () => {
  const { handlers, calls } = mockHandlers();
  const result = executeSlashInput("/nope", handlers);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "unknown");
  assert.ok(calls.notify.some((n) => n.kind === "error"));
});

test("applySlashMenuSelection expands command with args", () => {
  const items = buildSlashMenuItems("/mo");
  const model = items.find((i) => i.kind === "command" && i.command.name === "model");
  assert.ok(model);
  assert.equal(applySlashMenuSelection(model), "/model ");
});

test("executeSlashMenuItem on command with args is incomplete then expands", () => {
  const { handlers, calls } = mockHandlers();
  const items = buildSlashMenuItems("/model");
  const item = items[0];
  assert.ok(item && item.kind === "command");
  const result = executeSlashMenuItem(item, handlers);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "incomplete");
  assert.equal(calls.model.length, 0);
  assert.equal(applySlashMenuSelection(item), "/model ");
});

test("executeSlashMenuItem runs arg option", () => {
  const { handlers, calls } = mockHandlers();
  const items = buildSlashMenuItems("/thinking ");
  const high = items.find((i) => i.kind === "arg" && i.option.id === "high");
  assert.ok(high);
  assert.equal(executeSlashMenuItem(high, handlers).ok, true);
  assert.deepEqual(calls.thinking, ["high"]);
});

test("registry covers expected v1 commands", () => {
  const names = new Set(SLASH_COMMANDS.map((c) => c.name));
  for (const n of [
    "new",
    "model",
    "thinking",
    "access",
    "agent",
    "build",
    "permission",
    "compact",
    "undo",
    "review",
    "theme",
    "help",
  ]) {
    assert.ok(names.has(n), `missing /${n}`);
  }
  assert.ok(!names.has("plan"), "/plan removed — use /agent plan or footer");
  // Sanity: option catalogs stay in sync with models module
  assert.ok(THINKING_LEVELS.length >= 4);
  assert.ok(ACCESS_MODES.length === 2);
  assert.ok(GROK_MODELS.length >= 1);
  const compact = findCommand(SLASH_COMMANDS, "squash");
  assert.equal(compact?.id, "compact");
});
