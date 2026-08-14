import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../../", import.meta.url);

function createStorage() {
  const values = new Map();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
    clear: () => values.clear(),
  };
}

function createRoot() {
  const classes = new Set();
  return {
    classList: {
      contains: (name) => classes.has(name),
      toggle: (name, force) => {
        if (force) classes.add(name);
        else classes.delete(name);
      },
    },
    dataset: {},
    style: {},
  };
}

globalThis.localStorage = createStorage();
globalThis.window = {
  matchMedia: () => ({ matches: false }),
};
globalThis.document = { documentElement: createRoot() };

const themeModule = await import("../../src/theme.ts");
const {
  THEME_CATALOG,
  applyTheme,
  loadTheme,
  resolveTheme,
  saveTheme,
} = themeModule;

const expectedIds = [
  "system",
  "light",
  "dark",
  "mineral-paper",
  "inkstone",
  "ember-ledger",
  "night-orchard",
  "salt-lake",
  "moss-negative",
  "oxide-terminal",
  "blue-hour",
  "cinder-bloom",
  "lichen-field",
  "deep-sea-silt",
  "clay-negative",
  "sodium-vapor",
  "aster-static",
  "bog-copper",
  "glacier-algae",
  "petrol-bloom",
  "chalk-plum",
  "redshift-mono",
  "brine-lilac",
  "phosphor-dust",
];

test("theme catalog exposes every built-in and authored theme", () => {
  assert.deepEqual(
    THEME_CATALOG.map((theme) => theme.id),
    expectedIds,
  );
  assert.equal(new Set(THEME_CATALOG.map((theme) => theme.name)).size, 24);
  assert.ok(
    THEME_CATALOG.every(
      (theme) =>
        theme.description &&
        theme.preview.background &&
        theme.preview.surface &&
        theme.preview.foreground &&
        theme.preview.accent,
    ),
  );
});

test("custom themes persist and invalid stored values fall back to system", () => {
  localStorage.clear();
  saveTheme("ember-ledger");
  assert.equal(loadTheme(), "ember-ledger");

  localStorage.setItem("grok-theme-v1", "not-a-theme");
  assert.equal(loadTheme(), "system");
});

test("custom theme appearance and DOM state stay aligned", async () => {
  document.documentElement = createRoot();
  await applyTheme("inkstone");
  assert.equal(document.documentElement.dataset.theme, "inkstone");
  assert.equal(document.documentElement.style.colorScheme, "dark");
  assert.equal(document.documentElement.style.background, "#0e1413");
  assert.equal(document.documentElement.classList.contains("dark"), true);
  assert.equal(resolveTheme("inkstone"), "dark");

  await applyTheme("mineral-paper");
  assert.equal(document.documentElement.dataset.theme, "mineral-paper");
  assert.equal(document.documentElement.style.colorScheme, "light");
  assert.equal(document.documentElement.style.background, "#edf1f2");
  assert.equal(document.documentElement.classList.contains("dark"), false);
  assert.equal(resolveTheme("mineral-paper"), "light");
});

test("bootstrap and CSS include every authored theme before React starts", async () => {
  const [html, css] = await Promise.all([
    readFile(new URL("index.html", root), "utf8"),
    readFile(new URL("src/styles.css", root), "utf8"),
  ]);

  for (const id of expectedIds.slice(3)) {
    assert.ok(html.includes(id), `bootstrap missing ${id}`);
    assert.ok(
      css.includes(`html[data-theme="${id}"]`),
      `CSS palette missing ${id}`,
    );
  }
});
