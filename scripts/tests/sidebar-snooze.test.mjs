import assert from "node:assert/strict";
import test from "node:test";

import { resolveSnoozePresets } from "../../src/components/Sidebar.snooze.ts";

test("snooze presets include a fixed three-hour choice", () => {
  const now = new Date(2026, 7, 12, 10, 15);
  const presets = resolveSnoozePresets(now);

  assert.deepEqual(
    presets.map((preset) => preset.id),
    ["hour", "three-hours", "evening", "tomorrow", "next-week"],
  );
  assert.equal(
    presets.find((preset) => preset.id === "three-hours")?.snoozedUntil,
    now.getTime() + 3 * 60 * 60 * 1_000,
  );
});
