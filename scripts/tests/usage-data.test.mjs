import assert from "node:assert/strict";
import test from "node:test";

import { getUsageSummary, makeUsageWindow } from "../../src/usage.ts";

import {
  aggregateUsage,
  buildUsageDayColumns,
  enumerateUsageDays,
  enumerateUsageHours,
  formatRelativeUsageHour,
  formatUsageTokens,
  formatUsageUsd,
  niceUsageScale,
  usageBucketTokens,
} from "../../src/usageData.ts";

function summary(buckets, overrides = {}) {
  return {
    readAt: "2026-08-08T12:00:00Z",
    sinceDay: "2026-08-07",
    untilDay: "2026-08-08",
    buckets,
    sources: [
      {
        provider: "codex",
        status: "ok",
        resolvedPath: "C:/Users/test/.codex/sessions",
        scannedFiles: 1,
        skippedFiles: 0,
        malformedRecords: 0,
        distinctSessions: 1,
      },
    ],
    pricingStatus: "fresh",
    pricingSource: "test",
    pricingFetchedAt: "2026-08-08T12:00:00Z",
    knownModels: 1,
    scanDurationMs: 2,
    ...overrides,
  };
}

test("usage aggregation keeps reasoning inside output tokens", () => {
  const bucket = {
    day: "2026-08-08",
    provider: "codex",
    model: "gpt-5.6",
    totals: {
      uncachedInputTokens: 40,
      cachedInputTokens: 60,
      cacheCreationTokens: 0,
      outputTokens: 20,
      reasoningTokens: 5,
    },
    costUsd: 1.25,
    cacheSavingsUsd: 0.5,
    costSource: "modelPriced",
    records: 1,
    providerReportedRecords: 0,
    modelPricedRecords: 1,
    unpricedRecords: 0,
    sessions: 1,
  };
  assert.equal(usageBucketTokens(bucket), 120);
  const usage = aggregateUsage(summary([bucket]));
  assert.equal(usage.totalTokens, 120);
  assert.equal(usage.reasoningTokens, 5);
  assert.equal(usage.sessions, 1);
  assert.equal(usage.daily.length, 2);
  assert.equal(usage.daily[0].totalTokens, 0);
  assert.equal(usage.providers[0].tokenShare, 1);
});

test("usage quality shares use exact mixed pricing counters", () => {
  const usage = aggregateUsage(
    summary([
      {
        day: "2026-08-08",
        provider: "codex",
        model: "gpt-5.6",
        totals: {
          uncachedInputTokens: 0,
          cachedInputTokens: 0,
          cacheCreationTokens: 0,
          outputTokens: 3,
          reasoningTokens: 0,
        },
        costUsd: 3,
        cacheSavingsUsd: 0,
        costSource: "mixed",
        records: 3,
        providerReportedRecords: 1,
        modelPricedRecords: 1,
        unpricedRecords: 1,
        sessions: 1,
      },
    ]),
  );
  assert.equal(usage.costQuality.providerReportedShare, 1 / 3);
  assert.equal(usage.costQuality.modelPricedShare, 1 / 3);
  assert.equal(usage.costQuality.unpricedShare, 1 / 3);
});

test("usage windows enumerate inclusive calendar days", () => {
  assert.deepEqual(enumerateUsageDays("2026-08-06", "2026-08-08"), [
    "2026-08-06",
    "2026-08-07",
    "2026-08-08",
  ]);
  assert.deepEqual(enumerateUsageDays("bad", "2026-08-08"), []);
});

test("past-24-hour windows are minute-aligned and enumerate 24 fixed buckets", () => {
  const window = makeUsageWindow(
    1,
    new Date("2026-08-12T17:42:38.123Z"),
    "hour",
  );

  assert.equal(window.sinceTime, "2026-08-11T17:42:00.000Z");
  assert.equal(window.untilTime, "2026-08-12T17:42:00.000Z");
  const hours = enumerateUsageHours(window.sinceTime, window.untilTime);
  assert.equal(hours.length, 24);
  assert.equal(hours[0], window.sinceTime);
  assert.equal(hours.at(-1), "2026-08-12T16:42:00.000Z");
});

test("hourly aggregation fills empty periods without losing the daily rollup", () => {
  const sinceTime = "2026-08-11T17:42:00.000Z";
  const untilTime = "2026-08-12T17:42:00.000Z";
  const usage = aggregateUsage(
    summary(
      [
        {
          day: "2026-08-12",
          hourStart: "2026-08-12T16:42:00.000Z",
          provider: "codex",
          model: "gpt-5.6",
          totals: {
            uncachedInputTokens: 10,
            cachedInputTokens: 0,
            cacheCreationTokens: 0,
            outputTokens: 5,
            reasoningTokens: 0,
          },
          costUsd: 1,
          cacheSavingsUsd: 0,
          costSource: "modelPriced",
          records: 1,
          providerReportedRecords: 0,
          modelPricedRecords: 1,
          unpricedRecords: 0,
          sessions: 1,
        },
      ],
      {
        resolution: "hour",
        sinceTime,
        untilTime,
      },
    ),
  );

  assert.equal(usage.hourly.length, 24);
  assert.equal(usage.hourly[0].totalTokens, 0);
  assert.equal(usage.hourly.at(-1).totalTokens, 15);
  assert.equal(usage.daily.find((day) => day.day === "2026-08-12").totalTokens, 15);
  assert.match(formatRelativeUsageHour(usage.hourly.at(-1).hourStart, untilTime), /today/i);
});

test("large usage counts stay compact", () => {
  assert.match(formatUsageTokens(12_400), /12[.,]4K/i);
});

test("large USD totals use a valid integer currency format", () => {
  assert.doesNotThrow(() => formatUsageUsd(125));
  assert.match(formatUsageUsd(125), /125/);
});

test("usage chart scale rounds above the peak on readable 1/2/5 steps", () => {
  for (const peak of [1122.71, 999, 1, 0.04, 1_400_000_000]) {
    const { max, ticks } = niceUsageScale(peak, 4);
    assert.ok(max >= peak);
    assert.equal(ticks[0], 0);
    assert.equal(ticks.at(-1), max);
  }
});

test("usage chart keeps provider series absolute rather than stacked", () => {
  const daily = [
    {
      day: "2026-08-08",
      uncachedInputTokens: 0,
      cachedInputTokens: 0,
      cacheCreationTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      totalTokens: 300,
      costUsd: 30,
      byProvider: {
        codex: { costUsd: 10, totalTokens: 100 },
        claude: { costUsd: 20, totalTokens: 200 },
      },
    },
  ];
  assert.deepEqual(buildUsageDayColumns(daily, "cost")[0], {
    bands: [
      { provider: "codex", value: 10 },
      { provider: "claude", value: 20 },
    ],
    total: 30,
  });
});

test("usage scanning reports a clear desktop-only error outside Tauri", async () => {
  await assert.rejects(
    () => getUsageSummary(30),
    /Usage scanning requires the Open Xiao desktop app/,
  );
});
