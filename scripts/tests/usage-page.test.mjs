import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(
  new URL("../../src/components/UsagePage.tsx", import.meta.url),
  "utf8",
);

test("usage keeps stale data visible but reports refresh failures", () => {
  assert.match(source, /error && summary \?/);
  assert.match(source, /role="alert"/);
  assert.match(source, /Showing the last loaded data/);
  assert.match(source, /error && !summary \?/);
  assert.match(source, /safeErrorMessage\(reason, "Could not scan provider usage\."\)/);
});

test("cached input share includes cache-creation input", () => {
  assert.match(
    source,
    /usage\.uncachedInputTokens \+\s*usage\.cachedInputTokens \+\s*usage\.cacheCreationTokens/,
  );
});
