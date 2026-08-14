import assert from "node:assert/strict";
import test from "node:test";

import {
  sanitizeUserFacingContent,
} from "../../src/sanitizeContent.ts";

test("keeps normal prose that mentions tool protocol field names", () => {
  const prose = "The tool_result field is optional and function_call is legacy.";

  assert.equal(sanitizeUserFacingContent(prose), prose);
});

test("still removes an actual tool protocol dump", () => {
  assert.equal(
    sanitizeUserFacingContent(
      '<tool_call>{"name":"read","arguments":{"path":"README.md"}}</tool_call>',
    ),
    "",
  );
});
