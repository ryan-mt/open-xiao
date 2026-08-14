import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../../", import.meta.url);

async function readSource(path) {
  return readFile(new URL(path, root), "utf8");
}

function zIndexFor(source, selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = source.match(
    new RegExp(`${escaped}\\s*\\{[^}]*z-index:\\s*(\\d+)`, "s"),
  );
  assert.ok(match, `missing z-index for ${selector}`);
  return Number(match[1]);
}

test("auth dialog stays above settings and Escape dismisses it first", async () => {
  const [styles, picker, settings, sidebar, app, dispatcher] = await Promise.all([
    readSource("src/styles.css"),
    readSource("src/components/auth/SignInProviderModal.tsx"),
    readSource("src/components/SettingsModal.tsx"),
    readSource("src/components/Sidebar.tsx"),
    readSource("src/App.tsx"),
    readSource("src/app/keybindingDispatcher.ts"),
  ]);

  assert.ok(
    zIndexFor(styles, ".auth-modal") > zIndexFor(styles, ".settings-backdrop"),
  );
  assert.match(picker, /GrokLogo/);
  assert.match(picker, /OpenAILogo/);
  assert.match(picker, /aria-label="Sign in"/);
  assert.match(sidebar, /onOpenSignIn/);
  assert.doesNotMatch(sidebar, /Sign in with SuperGrok/);
  assert.doesNotMatch(sidebar, /Sign in with OpenAI/);
  assert.match(settings, /inert=\{blocked\}/);
  assert.match(settings, /aria-hidden=\{blocked \|\| undefined\}/);
  assert.match(app, /blocked=\{authModalProvider != null \|\| signInPickerOpen\}/);
  assert.match(dispatcher, /if \(current\.blocked\) return/);
  assert.match(app, /captureAuthReturnFocus\(\)/);
  assert.equal(
    app.match(/returnFocusRef=\{authReturnFocusRef\}/g)?.length,
    2,
  );
});

test("logout failures produce provider-specific feedback", async () => {
  const app = await readSource("src/App.tsx");
  assert.match(app, /Could not sign out of Grok\. Try again\./);
  assert.match(app, /Could not sign out of OpenAI\. Try again\./);
});
