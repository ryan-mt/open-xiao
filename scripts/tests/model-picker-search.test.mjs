import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { scoreModelPickerSearch } from "../../src/modelPickerSearch.ts";

const modelSelect = readFileSync(
  new URL("../../src/components/ModelSelect.tsx", import.meta.url),
  "utf8",
);

test("model picker search matches provider and upstream model names", () => {
  const model = {
    label: "Claude Opus 4.7",
    provider: "opencode",
    providerTitle: "OpenCode",
    subProvider: "GitHub Copilot",
  };

  assert.notEqual(scoreModelPickerSearch(model, "coplt op"), null);
  assert.equal(scoreModelPickerSearch(model, "gemini"), null);
});

test("model picker search gives favorites a measured ranking boost", () => {
  const favorite = scoreModelPickerSearch(
    {
      label: "Claude Opus 4.7",
      provider: "opencode",
      providerTitle: "OpenCode",
      isFavorite: true,
    },
    "opu",
  );
  const other = scoreModelPickerSearch(
    {
      label: "Opus 4.5",
      provider: "openai",
      providerTitle: "OpenAI",
    },
    "opu",
  );

  assert.notEqual(favorite, null);
  assert.notEqual(other, null);
  assert.ok(favorite < other);
});

test("a provider-locked thread keeps its same-provider Favorites view", () => {
  const favoritesButton = modelSelect.indexOf('aria-label="Favorites"');
  assert.notEqual(favoritesButton, -1, "missing Favorites tab");
  assert.doesNotMatch(
    modelSelect.slice(Math.max(0, favoritesButton - 700), favoritesButton),
    /lockedProvider == null/,
    "provider locking must not remove the Favorites tab",
  );
  assert.match(
    modelSelect,
    /lockedProvider != null &&\s*selectedCatalog !== "favorites" &&\s*selectedCatalog !== lockedProvider/,
    "provider locking must allow Favorites while blocking other providers",
  );
});
