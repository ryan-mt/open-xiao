import type {
  UsageBucket,
  UsageProvider,
  UsageSummary,
  UsageTokenTotals,
} from "./usage";

export const USAGE_PROVIDER_ORDER: readonly UsageProvider[] = [
  "codex",
  "claude",
];

export const USAGE_PROVIDER_LABEL: Record<UsageProvider, string> = {
  codex: "Codex",
  claude: "Claude Code",
};

const EMPTY_TOTALS: UsageTokenTotals = {
  uncachedInputTokens: 0,
  cachedInputTokens: 0,
  cacheCreationTokens: 0,
  outputTokens: 0,
  reasoningTokens: 0,
};

export type UsageProviderTotals = UsageTokenTotals & {
  provider: UsageProvider;
  totalTokens: number;
  costUsd: number;
  cacheSavingsUsd: number;
  records: number;
  sessions: number;
  tokenShare: number;
  costShare: number;
};

export type UsageModelTotals = UsageTokenTotals & {
  provider: UsageProvider;
  model: string;
  totalTokens: number;
  costUsd: number;
  records: number;
  sessions: number;
  tokenShare: number;
  costShare: number;
};

export type UsageDayTotals = UsageTokenTotals & {
  day: string;
  totalTokens: number;
  costUsd: number;
  byProvider: Record<UsageProvider, { totalTokens: number; costUsd: number }>;
};

export type UsageHourTotals = UsageTokenTotals & {
  day: string;
  hourStart: string;
  totalTokens: number;
  costUsd: number;
  byProvider: Record<UsageProvider, { totalTokens: number; costUsd: number }>;
};

export type UsagePeriodTotals = UsageDayTotals | UsageHourTotals;

export type UsageChartMetric = "cost" | "tokens";

export type UsageDayColumn = {
  bands: readonly { provider: UsageProvider; value: number }[];
  total: number;
};

export type AggregatedUsage = UsageTokenTotals & {
  totalTokens: number;
  costUsd: number;
  cacheSavingsUsd: number;
  records: number;
  sessions: number;
  providers: UsageProviderTotals[];
  models: UsageModelTotals[];
  daily: UsageDayTotals[];
  hourly: UsageHourTotals[];
  costQuality: {
    providerReportedShare: number;
    modelPricedShare: number;
    unpricedShare: number;
  };
};

function totalTokens(totals: UsageTokenTotals): number {
  return (
    totals.uncachedInputTokens +
    totals.cachedInputTokens +
    totals.cacheCreationTokens +
    totals.outputTokens
  );
}

function addTotals(target: UsageTokenTotals, source: UsageTokenTotals): void {
  target.uncachedInputTokens += source.uncachedInputTokens;
  target.cachedInputTokens += source.cachedInputTokens;
  target.cacheCreationTokens += source.cacheCreationTokens;
  target.outputTokens += source.outputTokens;
  target.reasoningTokens += source.reasoningTokens;
}

function makeProvider(provider: UsageProvider): UsageProviderTotals {
  return {
    ...EMPTY_TOTALS,
    provider,
    totalTokens: 0,
    costUsd: 0,
    cacheSavingsUsd: 0,
    records: 0,
    sessions: 0,
    tokenShare: 0,
    costShare: 0,
  };
}

function makeDay(day: string): UsageDayTotals {
  return {
    ...EMPTY_TOTALS,
    day,
    totalTokens: 0,
    costUsd: 0,
    byProvider: {
      codex: { totalTokens: 0, costUsd: 0 },
      claude: { totalTokens: 0, costUsd: 0 },
    },
  };
}

function localDayKey(instant: string): string {
  const date = new Date(instant);
  if (Number.isNaN(date.getTime())) return instant.slice(0, 10);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function makeHour(hourStart: string): UsageHourTotals {
  return {
    ...EMPTY_TOTALS,
    day: localDayKey(hourStart),
    hourStart,
    totalTokens: 0,
    costUsd: 0,
    byProvider: {
      codex: { totalTokens: 0, costUsd: 0 },
      claude: { totalTokens: 0, costUsd: 0 },
    },
  };
}

export function enumerateUsageDays(sinceDay: string, untilDay: string): string[] {
  const start = Date.parse(`${sinceDay}T00:00:00Z`);
  const end = Date.parse(`${untilDay}T00:00:00Z`);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end) return [];
  const days: string[] = [];
  for (let time = start; time <= end; time += 86_400_000) {
    days.push(new Date(time).toISOString().slice(0, 10));
  }
  return days;
}

export function enumerateUsageHours(
  sinceTime: string,
  untilTime: string,
): string[] {
  const start = Date.parse(sinceTime);
  const end = Date.parse(untilTime);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start >= end) return [];
  const hours: string[] = [];
  for (let time = start; time < end; time += 60 * 60 * 1_000) {
    hours.push(new Date(time).toISOString());
  }
  return hours;
}

/** T3's readable 1/2/5 scale, always rounded above the plotted peak. */
export function niceUsageScale(
  peak: number,
  count: number,
): { max: number; ticks: readonly number[] } {
  if (peak <= 0) return { max: 0, ticks: [0] };

  const rawStep = peak / count;
  const magnitude = 10 ** Math.floor(Math.log10(rawStep));
  const normalized = rawStep / magnitude;
  const step =
    (normalized > 5 ? 10 : normalized > 2 ? 5 : normalized > 1 ? 2 : 1) *
    magnitude;
  const max = Math.ceil(peak / step) * step;
  const ticks: number[] = [];
  for (let value = 0; value <= max + step * 1e-6; value += step) {
    ticks.push(value);
  }
  return { max, ticks };
}

/** Provider values stay absolute and share zero; they are not stacked. */
export function buildUsageDayColumns(
  daily: readonly UsagePeriodTotals[],
  metric: UsageChartMetric,
): readonly UsageDayColumn[] {
  return daily.map((day) => {
    const bands = USAGE_PROVIDER_ORDER.map((provider) => ({
      provider,
      value:
        metric === "tokens"
          ? day.byProvider[provider].totalTokens
          : day.byProvider[provider].costUsd,
    }));
    return { bands, total: bands.reduce((sum, band) => sum + band.value, 0) };
  });
}

export function aggregateUsage(summary: UsageSummary): AggregatedUsage {
  const aggregate: AggregatedUsage = {
    ...EMPTY_TOTALS,
    totalTokens: 0,
    costUsd: 0,
    cacheSavingsUsd: 0,
    records: 0,
    sessions: summary.sources.reduce(
      (total, source) => total + source.distinctSessions,
      0,
    ),
    providers: [],
    models: [],
    daily: [],
    hourly: [],
    costQuality: {
      providerReportedShare: 0,
      modelPricedShare: 0,
      unpricedShare: 0,
    },
  };
  const providers = new Map(
    USAGE_PROVIDER_ORDER.map((provider) => [provider, makeProvider(provider)]),
  );
  const models = new Map<string, UsageModelTotals>();
  const daily = new Map(
    enumerateUsageDays(summary.sinceDay, summary.untilDay).map((day) => [
      day,
      makeDay(day),
    ]),
  );
  const hourly = new Map(
    summary.sinceTime && summary.untilTime
      ? enumerateUsageHours(summary.sinceTime, summary.untilTime).map(
          (hourStart) => [hourStart, makeHour(hourStart)] as const,
        )
      : [],
  );
  let providerReportedRecords = 0;
  let modelPricedRecords = 0;
  let unpricedRecords = 0;

  for (const bucket of summary.buckets) {
    const bucketTokens = totalTokens(bucket.totals);
    addTotals(aggregate, bucket.totals);
    aggregate.totalTokens += bucketTokens;
    aggregate.costUsd += bucket.costUsd;
    aggregate.cacheSavingsUsd += bucket.cacheSavingsUsd;
    aggregate.records += bucket.records;
    providerReportedRecords += bucket.providerReportedRecords;
    modelPricedRecords += bucket.modelPricedRecords;
    unpricedRecords += bucket.unpricedRecords;

    const provider = providers.get(bucket.provider) ?? makeProvider(bucket.provider);
    addTotals(provider, bucket.totals);
    provider.totalTokens += bucketTokens;
    provider.costUsd += bucket.costUsd;
    provider.cacheSavingsUsd += bucket.cacheSavingsUsd;
    provider.records += bucket.records;
    provider.sessions += bucket.sessions;
    providers.set(bucket.provider, provider);

    const modelKey = `${bucket.provider}:${bucket.model}`;
    const model = models.get(modelKey) ?? {
      ...EMPTY_TOTALS,
      provider: bucket.provider,
      model: bucket.model,
      totalTokens: 0,
      costUsd: 0,
      records: 0,
      sessions: 0,
      tokenShare: 0,
      costShare: 0,
    };
    addTotals(model, bucket.totals);
    model.totalTokens += bucketTokens;
    model.costUsd += bucket.costUsd;
    model.records += bucket.records;
    model.sessions += bucket.sessions;
    models.set(modelKey, model);

    const day = daily.get(bucket.day) ?? makeDay(bucket.day);
    addTotals(day, bucket.totals);
    day.totalTokens += bucketTokens;
    day.costUsd += bucket.costUsd;
    day.byProvider[bucket.provider].totalTokens += bucketTokens;
    day.byProvider[bucket.provider].costUsd += bucket.costUsd;
    daily.set(bucket.day, day);

    if (bucket.hourStart) {
      const hour = hourly.get(bucket.hourStart) ?? makeHour(bucket.hourStart);
      hour.day = bucket.day;
      addTotals(hour, bucket.totals);
      hour.totalTokens += bucketTokens;
      hour.costUsd += bucket.costUsd;
      hour.byProvider[bucket.provider].totalTokens += bucketTokens;
      hour.byProvider[bucket.provider].costUsd += bucket.costUsd;
      hourly.set(bucket.hourStart, hour);
    }
  }

  aggregate.providers = [...providers.values()]
    .filter((provider) => provider.records > 0)
    .map((provider) => ({
      ...provider,
      tokenShare:
        aggregate.totalTokens === 0
          ? 0
          : provider.totalTokens / aggregate.totalTokens,
      costShare:
        aggregate.costUsd === 0 ? 0 : provider.costUsd / aggregate.costUsd,
    }));
  aggregate.models = [...models.values()]
    .map((model) => ({
      ...model,
      tokenShare:
        aggregate.totalTokens === 0
          ? 0
          : model.totalTokens / aggregate.totalTokens,
      costShare:
        aggregate.costUsd === 0 ? 0 : model.costUsd / aggregate.costUsd,
    }))
    .sort(
      (a, b) => b.costUsd - a.costUsd || b.totalTokens - a.totalTokens,
    );
  aggregate.daily = [...daily.values()].sort((a, b) =>
    a.day.localeCompare(b.day),
  );
  aggregate.hourly = [...hourly.values()].sort((a, b) =>
    a.hourStart.localeCompare(b.hourStart),
  );
  const qualityRecords =
    providerReportedRecords + modelPricedRecords + unpricedRecords;
  if (qualityRecords > 0) {
    aggregate.costQuality = {
      providerReportedShare: providerReportedRecords / qualityRecords,
      modelPricedShare: modelPricedRecords / qualityRecords,
      unpricedShare: unpricedRecords / qualityRecords,
    };
  }
  return aggregate;
}

export function formatUsageTokens(value: number): string {
  return new Intl.NumberFormat(undefined, {
    notation: value >= 1_000 ? "compact" : "standard",
    maximumFractionDigits: 1,
  }).format(value);
}

export function formatUsageUsd(value: number): string {
  if (value > 0 && value < 0.01) return "<$0.01";
  const fractionDigits = value >= 100 ? 0 : 2;
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  }).format(value);
}

export function formatUsagePercent(value: number): string {
  return new Intl.NumberFormat(undefined, {
    style: "percent",
    maximumFractionDigits: 1,
  }).format(value);
}

export function formatUsageDay(day: string): string {
  const date = new Date(`${day}T12:00:00Z`);
  if (Number.isNaN(date.getTime())) return day;
  return date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

export function formatUsageHour(hourStart: string): string {
  const date = new Date(hourStart);
  if (Number.isNaN(date.getTime())) return hourStart;
  return date.toLocaleTimeString(undefined, { hour: "numeric" });
}

export function formatUsageDateTime(instant: string): string {
  const date = new Date(instant);
  if (Number.isNaN(date.getTime())) return instant;
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
  });
}

export function formatRelativeUsageHour(
  hourStart: string,
  relativeTo: string,
): string {
  const instant = new Date(hourStart);
  const reference = new Date(relativeTo);
  if (Number.isNaN(instant.getTime()) || Number.isNaN(reference.getTime())) {
    return formatUsageDateTime(hourStart);
  }
  const dayOrdinal = (date: Date) =>
    Date.UTC(date.getFullYear(), date.getMonth(), date.getDate());
  const calendarDaysAgo = Math.round(
    (dayOrdinal(reference) - dayOrdinal(instant)) / 86_400_000,
  );
  const hour = formatUsageHour(hourStart);
  if (calendarDaysAgo === 0) return `${hour} today`;
  if (calendarDaysAgo === 1) return `${hour} yesterday`;
  return formatUsageDateTime(hourStart);
}

export function usageBucketTokens(bucket: UsageBucket): number {
  return totalTokens(bucket.totals);
}
