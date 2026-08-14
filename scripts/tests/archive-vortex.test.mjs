import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const css = readFileSync(join(root, "src/styles.css"), "utf8");
const app = readFileSync(join(root, "src/App.tsx"), "utf8");

test("archive suck beats boot-wake specificity on sidebar and inset", () => {
  // Boot wake uses .shell.is-booted > .sidebar-v2 — archive must pair is-booted.
  assert.match(
    css,
    /\.shell\.is-booted\.is-archiving-all\s*>\s*\.sidebar-v2/,
  );
  assert.match(css, /\.shell\.is-booted\.is-archiving-all\s*>\s*\.inset/);
  // Overlay path must beat boot-wake-overlay's triple :not().
  assert.match(
    css,
    /\.shell\.is-booted\.is-archiving-all[\s\S]*?:not\(\.archive-vortex\)/,
  );
  assert.match(css, /archive-shell-suck/);
  assert.match(css, /archive-shell-suck-rail/);
});

test("vortex sits above settings and keeps shell sucking", () => {
  assert.match(css, /\.archive-vortex\s*\{[^}]*z-index:\s*700/s);
  assert.match(app, /archive-vortex/);
  // Settings stays open during the effect so it is sucked with the shell.
  const archiveFn = app.slice(
    app.indexOf("const handleArchiveAll"),
    app.indexOf("const handlePin"),
  );
  assert.match(archiveFn, /setArchivingAll\(true\)/);
  // Close settings only after the effect settles, not immediately.
  assert.match(archiveFn, /setSettingsOpen\(false\)/);
  const firstClose = archiveFn.indexOf("setSettingsOpen(false)");
  const setTrue = archiveFn.indexOf("setArchivingAll(true)");
  assert.ok(firstClose > setTrue, "settings should close after archiving starts");
  // Immediate close right after setArchivingAll(true) would kill the exclusive feel.
  const between = archiveFn.slice(setTrue, setTrue + 280);
  assert.doesNotMatch(between, /setArchivingAll\(true\);\s*setSettingsOpen\(false\)/);
});
