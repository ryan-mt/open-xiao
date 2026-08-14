import assert from "node:assert/strict";
import test from "node:test";

import {
  MAX_TOOL_ONLY_HISTORY_CHARS,
  assistantHistoryPayload,
} from "../../src/assistantApiHistory.ts";

test("completed assistant turns send the final answer, not the tool transcript", () => {
  const transcript = "tool output\n".repeat(10_000);

  assert.equal(
    assistantHistoryPayload("  Finished and verified.  ", transcript),
    "Finished and verified.",
  );
});

test("tool-only turns keep recent work within a bounded payload", () => {
  const short = "read a.ts\nresult: ok";
  assert.equal(assistantHistoryPayload("", short), short);

  const tail = "LATEST_TOOL_RESULT";
  const long = `${"old tool output\n".repeat(4_000)}${tail}`;
  const payload = assistantHistoryPayload("", long);

  assert.ok(payload.length <= MAX_TOOL_ONLY_HISTORY_CHARS);
  assert.match(payload, /Earlier tool activity omitted/);
  assert.ok(payload.endsWith(tail));
});
