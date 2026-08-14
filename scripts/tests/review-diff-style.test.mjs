import assert from "node:assert/strict";
import test from "node:test";

function createStorage() {
  const values = new Map();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
    clear: () => values.clear(),
  };
}

globalThis.localStorage = createStorage();

const { loadReviewDiffStyle, saveReviewDiffStyle } = await import(
  "../../src/reviewChanges.ts"
);

test("review diff style persists across panel remounts", () => {
  localStorage.clear();
  assert.equal(loadReviewDiffStyle(), "unified");

  assert.equal(saveReviewDiffStyle("split"), "split");
  assert.equal(loadReviewDiffStyle(), "split");

  assert.equal(saveReviewDiffStyle("unified"), "unified");
  assert.equal(loadReviewDiffStyle(), "unified");
});

test("invalid persisted review diff style falls back to unified", () => {
  localStorage.setItem("open-xiao:review-diff-style-v1", "sideways");
  assert.equal(loadReviewDiffStyle(), "unified");
});
