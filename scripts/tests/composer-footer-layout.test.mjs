import assert from "node:assert/strict";
import test from "node:test";

import { shouldUseCompactComposerFooter } from "../../src/components/composerFooterLayout.ts";

test("desktop and split-view composers keep every control label visible", () => {
  assert.equal(shouldUseCompactComposerFooter(768), false);
  assert.equal(shouldUseCompactComposerFooter(648), false);
});

test("only a truly narrow composer compacts its control labels", () => {
  assert.equal(shouldUseCompactComposerFooter(620), false);
  assert.equal(shouldUseCompactComposerFooter(619), true);
});

test("a normal wide action does not force the desktop footer into compact mode", () => {
  assert.equal(
    shouldUseCompactComposerFooter(768, { hasWideActions: true }),
    false,
  );
});
