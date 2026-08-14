import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  DEFAULT_KEYBINDINGS,
  KEYBINDING_COMMANDS,
  keybindingConflictLabels,
  keybindingFromKeyboardEvent,
  isDefaultKeybinding,
  normalizeStoredKeybindings,
  resolveShortcutCommand,
  updateKeybinding,
} from "../../src/keybindings/index.ts";

const styles = readFileSync(
  new URL("../../src/styles.css", import.meta.url),
  "utf8",
);
const keybindingsPage = readFileSync(
  new URL("../../src/components/keybindings/KeybindingsPage.tsx", import.meta.url),
  "utf8",
);
const keybindingCapture = readFileSync(
  new URL("../../src/components/keybindings/KeybindingCapture.tsx", import.meta.url),
  "utf8",
);
const keybindingRow = readFileSync(
  new URL("../../src/components/keybindings/KeybindingRow.tsx", import.meta.url),
  "utf8",
);
const settingsModal = readFileSync(
  new URL("../../src/components/SettingsModal.tsx", import.meta.url),
  "utf8",
);

function braceDepthAt(source, index) {
  let depth = 0;
  for (let cursor = 0; cursor < index; cursor += 1) {
    if (source[cursor] === "{") depth += 1;
    if (source[cursor] === "}") depth -= 1;
  }
  return depth;
}

const ctrl = (key) => ({
  key,
  code: key === "`" ? "Backquote" : `Key${key.toUpperCase()}`,
  metaKey: false,
  ctrlKey: true,
  shiftKey: false,
  altKey: false,
});

test("default shortcuts resolve on Windows/Linux modifier semantics", () => {
  assert.equal(
    resolveShortcutCommand(ctrl("k"), DEFAULT_KEYBINDINGS, {
      terminalFocus: false,
      previewOpen: false,
      modelPickerOpen: false,
    }),
    "commandPalette.toggle",
  );
  assert.equal(
    resolveShortcutCommand(ctrl("n"), DEFAULT_KEYBINDINGS, {
      terminalFocus: true,
      previewOpen: false,
      modelPickerOpen: false,
    }),
    null,
  );
  assert.equal(
    resolveShortcutCommand(
      { ...ctrl("`"), key: "`" },
      DEFAULT_KEYBINDINGS,
      { terminalFocus: true, previewOpen: false, modelPickerOpen: false },
    ),
    "terminal.toggle",
  );
});

test("context-specific model and thread jump bindings stay distinct", () => {
  assert.equal(
    resolveShortcutCommand(ctrl("1"), DEFAULT_KEYBINDINGS, {
      terminalFocus: false,
      previewOpen: false,
      modelPickerOpen: false,
    }),
    "thread.jump.1",
  );
  assert.equal(
    resolveShortcutCommand(ctrl("1"), DEFAULT_KEYBINDINGS, {
      terminalFocus: false,
      previewOpen: false,
      modelPickerOpen: true,
    }),
    "modelPicker.jump.1",
  );
});

test("shortcuts follow physical letter and digit keys across keyboard layouts", () => {
  const context = {
    terminalFocus: false,
    previewOpen: false,
    modelPickerOpen: false,
  };

  assert.equal(
    resolveShortcutCommand(
      { ...ctrl("&"), code: "Digit1" },
      DEFAULT_KEYBINDINGS,
      context,
      "Win32",
    ),
    "thread.jump.1",
  );
  assert.equal(
    resolveShortcutCommand(
      { ...ctrl("л"), code: "KeyK" },
      DEFAULT_KEYBINDINGS,
      context,
      "Win32",
    ),
    "commandPalette.toggle",
  );
});

test("recording produces portable shortcuts and ignores plain text", () => {
  assert.equal(keybindingFromKeyboardEvent(ctrl("s")), "mod+s");
  assert.equal(
    keybindingFromKeyboardEvent({
      key: "Escape",
      code: "Escape",
      metaKey: false,
      ctrlKey: false,
      shiftKey: false,
      altKey: false,
    }),
    "escape",
  );
  assert.equal(
    keybindingFromKeyboardEvent({
      key: "s",
      code: "KeyS",
      metaKey: false,
      ctrlKey: false,
      shiftKey: false,
      altKey: false,
    }),
    null,
  );
});

test("stored keybindings are normalized and updates keep the full catalog", () => {
  const normalized = normalizeStoredKeybindings([
    { command: "commandPalette.toggle", key: "mod+shift+p" },
    { command: "unknown.command", key: "mod+x" },
    { command: "filePicker.toggle", key: "not a shortcut" },
  ]);
  assert.equal(normalized.length, KEYBINDING_COMMANDS.length);
  assert.deepEqual(
    normalized.find((binding) => binding.command === "commandPalette.toggle"),
    { command: "commandPalette.toggle", key: "mod+shift+p" },
  );
  assert.deepEqual(
    normalized.find((binding) => binding.command === "filePicker.toggle"),
    DEFAULT_KEYBINDINGS.find((binding) => binding.command === "filePicker.toggle"),
  );

  const updated = updateKeybinding(
    normalized,
    "filePicker.toggle",
    "mod+shift+o",
    "!terminalFocus",
  );
  assert.deepEqual(
    updated.find((binding) => binding.command === "filePicker.toggle"),
    {
      command: "filePicker.toggle",
      key: "mod+shift+o",
      when: "!terminalFocus",
    },
  );
});

test("an intentionally unassigned command is still at its default", () => {
  assert.equal(
    isDefaultKeybinding({ command: "chat.newWorktree", key: "" }),
    true,
  );
  assert.equal(
    isDefaultKeybinding({ command: "chat.newWorktree", key: "mod+shift+n" }),
    false,
  );
});

test("the page reports overlapping shortcuts without flagging disjoint contexts", () => {
  const bindings = [
    { command: "commandPalette.toggle", key: "mod+k", when: "!terminalFocus" },
    { command: "filePicker.toggle", key: "mod+k", when: "!terminalFocus" },
    { command: "terminal.toggle", key: "mod+k", when: "terminalFocus" },
  ];
  assert.deepEqual(
    keybindingConflictLabels(
      "commandPalette.toggle",
      "mod+k",
      "!terminalFocus",
      bindings,
    ),
    ["File Picker: Toggle"],
  );
});

test("keybinding layout styles apply at desktop widths", () => {
  const rootRule = styles.indexOf(".keybindings-page {");
  const rowRule = styles.indexOf(".keybindings-page__row {");

  assert.notEqual(rootRule, -1);
  assert.notEqual(rowRule, -1);
  assert.equal(
    braceDepthAt(styles, rootRule),
    0,
    "base keybinding styles must not be trapped inside a media query",
  );
  assert.equal(braceDepthAt(styles, rowRule), 0);

  const row = styles.slice(rowRule, styles.indexOf("}", rowRule) + 1);
  assert.match(row, /min-width:\s*42\.5rem/);
  assert.match(
    row,
    /grid-template-columns:\s*minmax\(11\.875rem,\s*1\.1fr\)\s*minmax\(13\.75rem,\s*0\.85fr\)\s*minmax\(13\.125rem,\s*1fr\)\s*3\.75rem/,
  );
});

test("the keybindings page follows the compact T3 header and row controls", () => {
  assert.match(keybindingsPage, /aria-label="Search keybindings"/);
  assert.match(keybindingsPage, /className="keybindings-page__count"/);
  assert.match(keybindingsPage, /label="Add keybinding"/);
  assert.match(keybindingsPage, /<FileJson aria-hidden \/>/);
  assert.match(keybindingsPage, /keybindings-page__browser-note/);
  assert.doesNotMatch(keybindingsPage, /keybindings-page__note/);
  assert.match(keybindingCapture, /keybindings-page__edit-label/);
  assert.match(keybindingRow, /keybindings-page__actions-trigger/);
});

test("screen-reader labels do not expand every keybinding row", () => {
  const ruleStart = styles.indexOf(".sr-only {");
  assert.notEqual(ruleStart, -1, "the shared sr-only utility must exist");
  assert.equal(braceDepthAt(styles, ruleStart), 0);

  const rule = styles.slice(ruleStart, styles.indexOf("}", ruleStart) + 1);
  assert.match(rule, /position:\s*absolute/);
  assert.match(rule, /clip:/);
});

test("settings use the wider content rail at the native minimum window width", () => {
  assert.match(
    styles,
    /@media \(max-width: 900px\) \{\s*\.settings-v2 \{\s*grid-template-columns:\s*9\.5rem 1fr;/,
  );
});

test("the filtered result count uses singular grammar for one binding", () => {
  assert.match(
    keybindingsPage,
    /count === 1 \? "binding" : "bindings"/,
  );
});

test("Escape cancels shortcut capture before the settings dialog dismisses", () => {
  assert.match(keybindingCapture, /event\.stopPropagation\(\)/);
  assert.match(settingsModal, /window\.addEventListener\("keydown", onKey\);/);
  assert.doesNotMatch(
    settingsModal,
    /window\.addEventListener\("keydown", onKey, true\);/,
  );
});
