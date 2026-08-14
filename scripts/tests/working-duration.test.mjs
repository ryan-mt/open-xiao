import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const src = readFileSync(
  join(root, "src/components/Sidebar.logic.ts"),
  "utf8",
);
const messageListSrc = readFileSync(
  join(root, "src/components/MessageList.tsx"),
  "utf8",
);

/**
 * Mirror of formatWorkingDurationLabel — kept in sync by asserting source shape
 * and evaluating the pure math path here without a TS loader.
 */
function formatWorkingDurationLabel(elapsedMs) {
  const totalSeconds = Number.isFinite(elapsedMs)
    ? Math.max(0, Math.floor(elapsedMs / 1000))
    : 0;
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) {
    return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  }
  if (minutes > 0) {
    return `${minutes}m`;
  }
  return `${seconds}s`;
}

test("working duration source shows seconds then minutes-only", () => {
  assert.match(src, /export function formatWorkingDurationLabel/);
  assert.match(src, /return `\$\{seconds\}s`;/);
  assert.match(src, /return `\$\{minutes\}m`;/);
  assert.doesNotMatch(src, /\$\{minutes\}m \$\{seconds\}s/);
});

test("message list live working clock matches seconds-then-minutes-only", () => {
  assert.match(messageListSrc, /function formatWorkingClock/);
  assert.match(messageListSrc, /return `\$\{seconds\}s`;/);
  assert.match(messageListSrc, /if \(minutes > 0\) return `\$\{minutes\}m`;/);
  assert.doesNotMatch(
    messageListSrc,
    /return seconds > 0 \? `\$\{minutes\}m \$\{seconds\}s`/,
  );
});

test("working duration progresses 0s…59s → 1m → 1h", () => {
  assert.equal(formatWorkingDurationLabel(0), "0s");
  assert.equal(formatWorkingDurationLabel(1_000), "1s");
  assert.equal(formatWorkingDurationLabel(59_000), "59s");
  assert.equal(formatWorkingDurationLabel(59_999), "59s");
  assert.equal(formatWorkingDurationLabel(60_000), "1m");
  // Past a minute: UI stays on whole minutes (no trailing seconds).
  assert.equal(formatWorkingDurationLabel(2 * 60_000 + 52_000), "2m");
  assert.equal(formatWorkingDurationLabel(3 * 60_000 + 3_000), "3m");
  assert.equal(formatWorkingDurationLabel(60 * 60_000), "1h");
  assert.equal(formatWorkingDurationLabel(65 * 60_000), "1h 5m");
});
