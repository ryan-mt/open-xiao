import { invoke } from "@tauri-apps/api/core";
import { isTauri } from "./lib/isTauri.ts";

export type UsageProvider = "claude" | "codex";
export type UsageResolution = "day" | "hour";
export type UsageSourceStatus = "ok" | "missing" | "partial";
export type UsagePricingStatus = "fresh" | "cached" | "unavailable";

export type UsageTokenTotals = {
  uncachedInputTokens: number;
  cachedInputTokens: number;
  cacheCreationTokens: number;
  outputTokens: number;
  reasoningTokens: number;
};

export type UsageBucket = {
  day: string;
  hourStart?: string;
  provider: UsageProvider;
  model: string;
  totals: UsageTokenTotals;
  costUsd: number;
  cacheSavingsUsd: number;
  costSource: "providerReported" | "modelPriced" | "unpriced" | "mixed";
  records: number;
  providerReportedRecords: number;
  modelPricedRecords: number;
  unpricedRecords: number;
  sessions: number;
};

export type UsageSource = {
  provider: UsageProvider;
  status: UsageSourceStatus;
  resolvedPath: string;
  scannedFiles: number;
  skippedFiles: number;
  malformedRecords: number;
  distinctSessions: number;
  message?: string | null;
};

export type UsageSummary = {
  readAt: string;
  sinceDay: string;
  untilDay: string;
  resolution: UsageResolution;
  sinceTime?: string;
  untilTime?: string;
  buckets: UsageBucket[];
  sources: UsageSource[];
  pricingStatus: UsagePricingStatus;
  pricingSource: string;
  pricingFetchedAt: string | null;
  knownModels: number;
  scanDurationMs: number;
};

export type UsageWindow = {
  resolution: UsageResolution;
  sinceTime?: string;
  untilTime?: string;
};

const HOUR_MS = 60 * 60 * 1_000;

export function makeUsageWindow(
  days: number,
  now = new Date(),
  resolution: UsageResolution = days === 1 ? "hour" : "day",
): UsageWindow {
  if (resolution === "day") return { resolution };
  const untilTimeMs = Math.floor(now.getTime() / 60_000) * 60_000;
  return {
    resolution,
    sinceTime: new Date(untilTimeMs - 24 * HOUR_MS).toISOString(),
    untilTime: new Date(untilTimeMs).toISOString(),
  };
}

export async function getUsageSummary(
  days: number,
  resolution: UsageResolution = days === 1 ? "hour" : "day",
): Promise<UsageSummary> {
  if (!isTauri()) {
    throw new Error("Usage scanning requires the Open Xiao desktop app.");
  }
  const usageWindow = makeUsageWindow(days, new Date(), resolution);
  return invoke<UsageSummary>("usage_summary", {
    days,
    resolution: usageWindow.resolution,
    sinceTime: usageWindow.sinceTime ?? null,
    untilTime: usageWindow.untilTime ?? null,
  });
}
