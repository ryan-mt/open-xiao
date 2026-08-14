import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../../", import.meta.url);

test("keyboard focus does not draw section-sized outlines", async () => {
  const styles = await readFile(new URL("src/styles.css", root), "utf8");

  assert.match(
    styles,
    /:where\([\s\S]*\[tabindex\][\s\S]*\):focus-visible\s*\{\s*outline: none !important;/,
  );
  assert.match(
    styles,
    /\.composer__shell:has\(\.composer__input:focus\) \.composer__surface::after\s*\{\s*border-color: var\(--composer-outline\);/,
  );

  for (const selector of [
    "appearance-theme-card:has(input:focus-visible)",
    "ctx-meter__btn:focus-visible",
    "streak__cell:focus-visible",
    "browser-preview-panel__server:focus-visible",
  ]) {
    const selectorPattern = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const rule = styles.match(
      new RegExp(`\\.${selectorPattern}\\s*\\{[^}]*\\}`, "s"),
    )?.[0];
    assert.ok(rule, `missing focus rule for ${selector}`);
    assert.doesNotMatch(rule, /outline\s*:|box-shadow\s*:/);
  }
});

test("settings controls keep visible keyboard focus feedback", async () => {
  const styles = await readFile(new URL("src/styles.css", root), "utf8");

  for (const selector of [
    "settings-dialog__icon-btn:focus-visible",
    "settings-v2__nav-item:focus-visible",
    "settings-v2__btn:focus-visible",
    "settings-v2__switch:focus-visible",
    "keybindings-page__header-action:focus-visible",
    "keybindings-page__actions-trigger:focus-visible",
  ]) {
    const selectorPattern = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const rule = styles.match(
      new RegExp(`\\.${selectorPattern}(?:,[^{]+)?\\s*\\{[^}]*\\}`, "s"),
    )?.[0];
    assert.ok(rule, `missing focus rule for ${selector}`);
    assert.match(rule, /background\s*:|box-shadow\s*:|border-color\s*:/);
  }
});
