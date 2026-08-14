import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  activityMonthLabels,
  rollingActivityStats,
} from "../../src/profileActivity.ts";

test("activity month labels never share a heatmap week", () => {
  const labels = activityMonthLabels(
    [
      { date: "2026-07-30" },
      { date: "2026-07-31" },
      { date: "2026-08-01" },
      { date: "2026-08-02" },
    ],
    3,
  );

  assert.deepEqual(labels, [{ label: "Aug", col: 0 }]);
});

test("rolling totals exclude old and future records while streaks keep past history", () => {
  const stats = rollingActivityStats(
    {
      "2024-02-27": 5,
      "2024-02-29": 2,
      "2024-03-01": 3,
      "2024-03-02": 99,
    },
    {
      "2024-02-28": 7,
      "2024-03-02": 999,
    },
    3,
    new Date("2024-03-01T12:00:00"),
  );

  assert.deepEqual(
    stats.days.map((day) => day.date),
    ["2024-02-28", "2024-02-29", "2024-03-01"],
  );
  assert.equal(stats.totalMessages, 5);
  assert.equal(stats.totalOpenAITokens, 7);
  assert.equal(stats.totalActiveDays, 3);
  assert.equal(stats.currentStreak, 4);
  assert.equal(stats.longestStreak, 4);
});

test("Grok activity records accepted user messages, not retry or regenerate streams", async () => {
  const app = await readFile(
    new URL("../../src/App.tsx", import.meta.url),
    "utf8",
  );
  const runStream = app.slice(
    app.indexOf("const runStream = async"),
    app.indexOf("const handleSendPayload = async"),
  );
  const acceptedMessage = app.slice(
    app.indexOf("const handleSendPayload = async"),
    app.indexOf("const handleSend = async"),
  );

  assert.doesNotMatch(runStream, /recordActivity\(1\)/);
  assert.match(
    acceptedMessage,
    /target\.provider === "grok"[\s\S]*recordActivity\(1\)/,
  );
});

test("profile backdrops stay dark in every theme", async () => {
  const styles = await readFile(
    new URL("../../src/styles.css", import.meta.url),
    "utf8",
  );
  const profileBackdrop = styles.slice(
    styles.indexOf(".profile-backdrop {"),
    styles.indexOf("}", styles.indexOf(".profile-backdrop {")),
  );
  const createBackdrop = styles.slice(
    styles.indexOf(".profile-create-backdrop {"),
    styles.indexOf("}", styles.indexOf(".profile-create-backdrop {")),
  );

  assert.match(profileBackdrop, /background: rgb\(0 0 0 \/ 42%\)/);
  assert.match(createBackdrop, /background: rgb\(0 0 0 \/ 48%\)/);
  assert.doesNotMatch(profileBackdrop, /var\(--foreground\)/);
  assert.doesNotMatch(createBackdrop, /var\(--foreground\)/);
});
