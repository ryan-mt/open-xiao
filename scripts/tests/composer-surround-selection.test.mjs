import assert from "node:assert/strict";
import test from "node:test";

import { surroundComposerSelection } from "../../src/composerSelection.ts";

test("surroundComposerSelection wraps selected text and keeps the inner selection", () => {
  const first = surroundComposerSelection("selected", 0, "selected".length, "(");

  assert.deepEqual(first, {
    value: "(selected)",
    selectionStart: 1,
    selectionEnd: 9,
  });

  assert.ok(first);
  assert.deepEqual(
    surroundComposerSelection(
      first.value,
      first.selectionStart,
      first.selectionEnd,
      "[",
    ),
    {
      value: "([selected])",
      selectionStart: 2,
      selectionEnd: 10,
    },
  );
});

test("surroundComposerSelection leaves collapsed and unsupported input unchanged", () => {
  assert.equal(surroundComposerSelection("selected", 8, 8, "("), null);
  assert.equal(surroundComposerSelection("selected", 0, 8, "a"), null);
});

test("surroundComposerSelection supports symmetric and option-produced pairs", () => {
  assert.deepEqual(surroundComposerSelection("backward", 0, 8, "*"), {
    value: "*backward*",
    selectionStart: 1,
    selectionEnd: 9,
  });
  assert.deepEqual(surroundComposerSelection("quoted", 0, 6, "«"), {
    value: "«quoted»",
    selectionStart: 1,
    selectionEnd: 7,
  });
});

test("surroundComposerSelection preserves text around a partial selection", () => {
  assert.deepEqual(surroundComposerSelection("say this now", 4, 8, "`"), {
    value: "say `this` now",
    selectionStart: 5,
    selectionEnd: 9,
  });
});
