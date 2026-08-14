import assert from "node:assert/strict";
import test from "node:test";

import {
  sanitizeUserFacingContent,
} from "../../src/sanitizeContent.ts";

test("removes bare tool call JSON envelopes", () => {
  assert.equal(
    sanitizeUserFacingContent('{"tool_calls":[{"type":"function"}]}'),
    "",
  );
});
