import assert from "node:assert/strict";
import test from "node:test";

import { formatCompactDiffCount } from "../../src/reviewChanges.ts";

test("diff counts stay exact below 1K and compact larger values", () => {
  assert.equal(formatCompactDiffCount(999), "999");
  assert.equal(formatCompactDiffCount(1_000), "1K");
  assert.equal(formatCompactDiffCount(3_030), "3K");
  assert.equal(formatCompactDiffCount(12_582), "12.6K");
  assert.equal(formatCompactDiffCount(1_250_000), "1.3M");
  assert.equal(formatCompactDiffCount(1_000_000_000), "1B");
});
