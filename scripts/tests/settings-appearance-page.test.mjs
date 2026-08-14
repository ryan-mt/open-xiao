import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const read = (path) => readFileSync(join(root, path), "utf8");

test("settings exposes the complete appearance page", () => {
  const settings = read("src/components/SettingsModal.tsx");
  const appearance = read("src/components/settings/AppearancePage.tsx");

  assert.match(settings, /Appearance/);
  assert.match(settings, /<AppearancePage/);
  assert.match(appearance, /Color scheme/);
  assert.match(appearance, /Glass opacity/);
  assert.match(appearance, /Typography/);
  assert.match(appearance, /Interface font/);
  assert.match(appearance, /Monospace font/);
  assert.match(appearance, /role="switch"/);
  assert.match(appearance, /type="range"/);
  assert.match(appearance, /appearance-scheme-grid/);
  assert.match(appearance, /appearance-theme-grid/);
});

test("appearance page follows the compact three-column desktop reference", () => {
  const styles = read("src/styles.css");
  const page = styles.match(
    /\.appearance-page \{(?<rules>[\s\S]*?)\n\}/,
  )?.groups?.rules;
  const schemes = styles.match(
    /\.appearance-scheme-grid \{(?<rules>[\s\S]*?)\n\}/,
  )?.groups?.rules;
  const themes = styles.match(
    /\.appearance-theme-grid \{(?<rules>[\s\S]*?)\n\}/,
  )?.groups?.rules;

  assert.ok(page);
  assert.match(page, /max-width: 56rem;/);
  assert.ok(schemes);
  assert.match(schemes, /grid-template-columns: repeat\(3, minmax\(0, 1fr\)\);/);
  assert.ok(themes);
  assert.match(themes, /grid-template-columns: repeat\(3, minmax\(0, 1fr\)\);/);
});

test("typography preferences reach real code and composer surfaces", () => {
  const styles = read("src/styles.css");

  assert.match(
    styles,
    /\.composer__input \{[\s\S]*?font-family: var\(--font-composer\);[\s\S]*?font-size: var\(--font-size-prompt\);[\s\S]*?\}/,
  );
  assert.match(
    styles,
    /\.chat-md__code pre \{[\s\S]*?font-family: var\(--font-mono[^;]*;[\s\S]*?font-size: var\(--font-size-code\);[\s\S]*?\}/,
  );
  assert.match(
    styles,
    /\.file-preview-panel__code-scroll \{[\s\S]*?font-family: var\(--font-mono[^;]*;[\s\S]*?font-size: var\(--font-size-code\);[\s\S]*?\}/,
  );
});
