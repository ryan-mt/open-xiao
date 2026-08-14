import assert from "node:assert/strict";
import test from "node:test";

import {
  sanitizeUserFacingContent,
} from "../../src/sanitizeContent.ts";

test("removes channel and recipient protocol transcripts", () => {
  assert.equal(
    sanitizeUserFacingContent(
      "<|channel|>analysis <|recipient|>functions.grep",
    ),
    "",
  );
});
