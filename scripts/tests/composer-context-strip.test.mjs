import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../../", import.meta.url);

test("workspace and branch strip sits below both composers", async () => {
  const [app, strip, picker, styles] = await Promise.all([
    readFile(new URL("src/App.tsx", root), "utf8"),
    readFile(new URL("src/components/ComposerContextStrip.tsx", root), "utf8"),
    readFile(new URL("src/components/ComposerBranchPicker.tsx", root), "utf8"),
    readFile(new URL("src/styles.css", root), "utf8"),
  ]);

  assert.equal(app.match(/<ComposerContextStrip/g)?.length, 2);
  assert.match(strip, /ComposerBranchPicker/);
  assert.match(strip, /"Local checkout"/);
  assert.match(picker, /Search refs\.\.\./);
  assert.match(picker, /filterGitRefs/);
  assert.match(picker, /onSelectBaseRef/);
  assert.match(picker, />base</);
  assert.match(picker, />current</);
  assert.match(picker, /onRefreshBranch/);
  assert.match(strip, /onCreateWorktree/);
  assert.match(
    styles,
    /\.composer-context-strip\s*{[\s\S]*width: calc\(100% - 2\.75rem\)/,
  );
  assert.match(styles, /margin: -1rem auto 0/);
  assert.match(
    styles,
    /\.composer-context-strip::before\s*{[\s\S]*mask-image: linear-gradient/,
  );
});

test("open context menus paint above composer status pills", async () => {
  const styles = await readFile(new URL("src/styles.css", root), "utf8");

  assert.match(
    styles,
    /\.composer-context-strip:has\(\.composer-context-strip__menu\)\s*{\s*z-index: 6;/,
  );
});
