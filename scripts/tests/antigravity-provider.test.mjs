import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      if (specifier.startsWith(".") && !/\.[a-z]+$/i.test(specifier)) {
        return nextResolve(`${specifier}.ts`, context);
      }
      throw error;
    }
  },
});

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const read = (path) => readFileSync(join(root, path), "utf8");

test("Antigravity provider uses the supported CLI contract", () => {
  const backend = read("src-tauri/src/antigravity.rs");
  const frontend = read("src/antigravity.ts");

  assert.match(backend, /MINIMUM_ANTIGRAVITY_VERSION: &str = "1\.1\.8"/);
  assert.match(backend, /"--output-format"\.into\(\),\s*"stream-json"\.into\(\)/);
  assert.match(backend, /"--conversation"\.into\(\), conversation_id\.into\(\)/);
  assert.match(backend, /"--new-project"\.into\(\)/);
  assert.match(backend, /"--dangerously-skip-permissions"\.into\(\)/);
  assert.match(backend, /args\.push\("--sandbox"\.into\(\)\)/);
  assert.match(backend, /cannot relay interactive approvals/);
  assert.match(frontend, /invoke<AntigravityStatus>\("antigravity_status"\)/);
  assert.match(frontend, /id: `antigravity::\$\{model\.id\}`/);
});

test("Antigravity appears as a distinct provider with honest headless limits", () => {
  const app = read("src/App.tsx");
  const page = read("src/components/ProvidersPage.tsx");
  const picker = read("src/components/ModelSelect.tsx");

  assert.match(app, /antigravityStatus=\{antigravityStatus\}/);
  assert.match(app, /activeModelProvider === "antigravity"/);
  assert.match(app, /onUsage: \(usage\) => \{\s*if \(streamProvider !== "openai"\) return;/);
  assert.match(page, /<strong>Antigravity<\/strong>/);
  assert.match(page, /Credentials remain in Google Antigravity CLI/);
  assert.match(page, /Ask mode is unavailable/);
  assert.match(picker, /model\?\.provider !== "antigravity" \|\| p\.id !== "ask"/);
});

test("Antigravity uses the product logo from T3 Code", () => {
  const logo = read("src/components/AntigravityLogo.tsx");

  assert.match(logo, /ANTIGRAVITY_ICON_DATA_URL/);
  assert.match(logo, /data:image\/png;base64,/);
  assert.match(logo, /viewBox="0 0 128 128"/);
  assert.doesNotMatch(logo, /lucide-react|<Orbit/);
});

test("Antigravity exposes every Gemini 3.7 Flash effort from agy", async () => {
  const { antigravityModelsForCatalog } = await import(
    `../../src/antigravity.ts?gemini37=${Date.now()}`
  );
  const models = antigravityModelsForCatalog([
    { id: "gemini-3.7-flash-high", name: "Gemini 3.7 Flash (High)" },
    { id: "gemini-3.7-flash-medium", name: "Gemini 3.7 Flash (Medium)" },
    { id: "gemini-3.7-flash-low", name: "Gemini 3.7 Flash (Low)" },
  ]);

  assert.deepEqual(
    models.map((model) => model.id),
    [
      "antigravity::gemini-3.7-flash-high",
      "antigravity::gemini-3.7-flash-medium",
      "antigravity::gemini-3.7-flash-low",
    ],
  );
  assert.ok(models.every((model) => model.badge === "New"));
});
