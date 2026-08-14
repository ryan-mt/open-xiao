import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  GROK_MODELS,
  OPENAI_MODELS,
  availableModelCatalogs,
  configureAntigravityModels,
  configureOpenCodeModels,
  configureProviderModels,
  getModel,
  isKnownModelId,
  providerOf,
  reconcileAvailableModelId,
  supportsFastMode,
} from "../../src/models.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const read = (path) => readFileSync(join(root, path), "utf8");

test("signed-out providers disappear and their selected model falls back", () => {
  const availability = { grok: false, openai: true };

  assert.deepEqual(
    availableModelCatalogs(availability).map((catalog) => catalog.provider),
    ["openai"],
  );
  assert.equal(
    reconcileAvailableModelId(GROK_MODELS[0].id, availability),
    OPENAI_MODELS[0].id,
  );
});

test("provider model availability is symmetric", () => {
  const availability = { grok: true, openai: false };

  assert.deepEqual(
    availableModelCatalogs(availability).map((catalog) => catalog.provider),
    ["grok"],
  );
  assert.equal(
    reconcileAvailableModelId(OPENAI_MODELS[0].id, availability),
    GROK_MODELS[0].id,
  );
});

test("no authenticated provider exposes no stale model", () => {
  const availability = { grok: false, openai: false };

  assert.deepEqual(availableModelCatalogs(availability), []);
  assert.equal(
    reconcileAvailableModelId(GROK_MODELS[0].id, availability),
    null,
  );
});

test("an available selected model is retained", () => {
  const availability = { grok: true, openai: true };

  assert.equal(
    reconcileAvailableModelId(OPENAI_MODELS[1].id, availability),
    OPENAI_MODELS[1].id,
  );
});

test("dynamic provider identity survives an unloaded catalog", () => {
  configureOpenCodeModels([]);
  configureAntigravityModels([]);

  assert.equal(isKnownModelId("opencode::openai/gpt-x"), true);
  assert.equal(providerOf("opencode::openai/gpt-x"), "opencode");
  assert.equal(isKnownModelId("antigravity::gemini-x"), true);
  assert.equal(providerOf("antigravity::gemini-x"), "antigravity");
  assert.equal(getModel("opencode::openai/gpt-x").provider, "opencode");
  assert.equal(getModel("antigravity::gemini-x").provider, "antigravity");
  assert.equal(getModel("antigravity::gemini-x").context, "—");
  assert.equal(isKnownModelId("opencode::"), false);
  assert.equal(isKnownModelId("antigravity::"), false);
  const availability = {
    grok: true,
    openai: true,
    antigravity: true,
    opencode: true,
  };
  assert.equal(
    reconcileAvailableModelId("opencode::openai/gpt-x", availability),
    "opencode::openai/gpt-x",
  );
});

test("fast mode is limited to the supported OpenAI catalog", () => {
  for (const id of ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"]) {
    assert.equal(supportsFastMode(id), true);
  }
  assert.equal(supportsFastMode("gpt-daybreak-blue-latest"), false);
  assert.ok(GROK_MODELS.every((model) => !supportsFastMode(model.id)));
  assert.equal(supportsFastMode("unknown-model"), false);
});

test("ChatGPT OpenAI catalog excludes unsupported Daybreak access", () => {
  assert.deepEqual(
    OPENAI_MODELS.map((model) => model.id),
    ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"],
  );
  assert.equal(isKnownModelId("gpt-daybreak-blue-latest"), false);
});

test("unsupported Fast mode is visibly inactive for standard OpenAI models", () => {
  const picker = read("src/components/ModelSelect.tsx");

  assert.match(
    picker,
    /const fastModeAvailable =\s*model\?\.provider === "openai" && model\.fastMode === true/,
  );
  assert.match(picker, /const effectiveFastMode = fastModeAvailable && fastMode/);
  assert.match(picker, /<ZapIcon filled=\{effectiveFastMode\}/);
  assert.match(picker, /aria-checked=\{effectiveFastMode\}/);
  assert.match(picker, /disabled=\{!fastModeAvailable\}/);
  assert.match(picker, /title=\{itemModel\.description\}/);
  assert.match(picker, /const fastModeHelp = fastModeAvailable/);
  assert.match(picker, /title=\{fastModeHelp\}/);
  assert.match(picker, /does not support Fast mode/);
});

test("connected OpenCode models join the catalog without shadowing native models", () => {
  configureOpenCodeModels([
    {
      id: "opencode::openai/gpt-5.6-sol",
      label: "GPT-5.6 Sol",
      description: "OpenAI via OpenCode",
      provider: "opencode",
      thinking: true,
      defaultThinking: "medium",
      supportedThinking: ["low", "medium", "high"],
      context: "500k",
    },
  ]);
  const availability = {
    grok: true,
    openai: true,
    antigravity: false,
    opencode: true,
  };

  assert.deepEqual(
    availableModelCatalogs(availability).map((catalog) => catalog.provider),
    ["grok", "openai", "opencode"],
  );
  assert.equal(
    reconcileAvailableModelId("opencode::openai/gpt-5.6-sol", availability),
    "opencode::openai/gpt-5.6-sol",
  );

  configureOpenCodeModels([]);
});

test("Antigravity models keep a separate CLI-backed catalog", () => {
  configureAntigravityModels([
    {
      id: "antigravity::gemini-3.6-flash-low",
      label: "Gemini 3.6 Flash (Low)",
      description: "Google Antigravity CLI",
      provider: "antigravity",
      thinking: false,
      defaultThinking: "off",
      supportedThinking: ["off"],
      context: "—",
    },
  ]);
  const availability = {
    grok: true,
    openai: true,
    antigravity: true,
    opencode: false,
  };

  assert.deepEqual(
    availableModelCatalogs(availability).map((catalog) => catalog.provider),
    ["grok", "openai", "antigravity"],
  );
  assert.equal(
    reconcileAvailableModelId(
      "antigravity::gemini-3.6-flash-low",
      availability,
    ),
    "antigravity::gemini-3.6-flash-low",
  );

  configureAntigravityModels([]);
});

test("new runtime and upstream providers create catalogs from inventory", () => {
  configureProviderModels("future-runtime", [
    {
      id: "future-model",
      label: "Future Model",
      description: "Discovered model",
      provider: "future-runtime",
      thinking: false,
      defaultThinking: "off",
      supportedThinking: ["off"],
      context: "128k",
    },
  ]);
  configureOpenCodeModels([
    {
      id: "opencode::anthropic/claude",
      label: "Claude",
      description: "Anthropic via OpenCode",
      provider: "opencode",
      subProvider: "Anthropic",
      subProviderId: "anthropic",
      thinking: true,
      defaultThinking: "medium",
      supportedThinking: ["low", "medium", "high"],
      context: "200k",
    },
    {
      id: "opencode::google/gemini",
      label: "Gemini",
      description: "Google via OpenCode",
      provider: "opencode",
      subProvider: "Google",
      subProviderId: "google",
      thinking: true,
      defaultThinking: "medium",
      supportedThinking: ["low", "medium", "high"],
      context: "1M",
    },
  ]);

  const catalogs = availableModelCatalogs({
    grok: false,
    openai: false,
    antigravity: false,
    opencode: true,
  });
  assert.deepEqual(
    catalogs.map((catalog) => [catalog.id, catalog.title]),
    [
      ["opencode:anthropic", "Anthropic"],
      ["opencode:google", "Google"],
      ["future-runtime", "Future Runtime"],
    ],
  );

  configureProviderModels("future-runtime", []);
  configureOpenCodeModels([]);
});

test("provider availability is wired through App, Composer, and ModelSelect", () => {
  const app = read("src/App.tsx");
  const composer = read("src/components/Composer.tsx");
  const modelSelect = read("src/components/ModelSelect.tsx");

  assert.match(
    app,
    /reconcileAvailableModelId\(\s*modelId,\s*modelSelectionAvailability,\s*\)/,
  );
  assert.match(app, /providerAvailability=\{modelSelectionAvailability\}/g);
  assert.match(composer, /providerAvailability=\{providerAvailability\}/);
  assert.match(
    modelSelect,
    /availableModelCatalogs\(providerAvailability\)/,
  );
  assert.match(
    app,
    /availableModelCatalogs\(modelSelectionAvailability\)\.flatMap/,
  );
  assert.doesNotMatch(
    app,
    /model\.provider === "grok" \|\| model\.provider === "openai"/,
  );
});
