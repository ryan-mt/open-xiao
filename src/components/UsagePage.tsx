import {
  ArrowLeft,
  RefreshCw,
  X,
} from "lucide-react";
import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { getUsageSummary, type UsageProvider, type UsageSummary } from "../usage";
import { safeErrorMessage } from "../lib/userFacingError";
import {
  aggregateUsage,
  buildUsageDayColumns,
  formatRelativeUsageHour,
  formatUsageDay,
  formatUsageDateTime,
  formatUsageHour,
  formatUsagePercent,
  formatUsageTokens,
  formatUsageUsd,
  niceUsageScale,
  USAGE_PROVIDER_LABEL,
  USAGE_PROVIDER_ORDER,
  type UsageHourTotals,
  type UsagePeriodTotals,
} from "../usageData";
import { OpenAILogo } from "./OpenAILogo";
import { ClaudeLogo } from "./ClaudeLogo";
import "./UsagePage.css";

type Props = {
  open: boolean;
  onClose: () => void;
};

type ChartMetric = "cost" | "tokens";
type Breakdown = "model" | "time";

const WINDOW_OPTIONS = [
  { days: 1, label: "Past 24h" },
  { days: 7, label: "7 days" },
  { days: 30, label: "30 days" },
  { days: 90, label: "90 days" },
] as const;

const PROVIDER_COLOR: Record<UsageProvider, string> = {
  codex: "var(--usage-codex)",
  claude: "var(--usage-claude)",
};

export const UsagePage = memo(function UsagePage({ open, onClose }: Props) {
  const [windowDays, setWindowDays] = useState<number>(30);
  const [metric, setMetric] = useState<ChartMetric>("cost");
  const [breakdown, setBreakdown] = useState<Breakdown>("model");
  const [summary, setSummary] = useState<UsageSummary | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestRef = useRef(0);
  const dialogRef = useRef<HTMLDivElement>(null);
  const isPast24Hours = windowDays === 1;

  const loadUsage = useCallback(
    async (preserveCurrent: boolean) => {
      const requestId = ++requestRef.current;
      if (!preserveCurrent) setSummary(null);
      setLoading(true);
      setError(null);
      try {
        const next = await getUsageSummary(
          windowDays,
          isPast24Hours ? "hour" : "day",
        );
        if (requestRef.current === requestId) setSummary(next);
      } catch (reason) {
        if (requestRef.current !== requestId) return;
        setError(safeErrorMessage(reason, "Could not scan provider usage."));
      } finally {
        if (requestRef.current === requestId) setLoading(false);
      }
    },
    [isPast24Hours, windowDays],
  );

  useEffect(() => {
    if (!open) {
      requestRef.current += 1;
      return;
    }
    void loadUsage(false);
  }, [loadUsage, open]);

  useEffect(() => {
    if (!open) return;
    const dialog = dialogRef.current;
    if (!dialog) return;
    const previouslyFocused =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    const focusable = () =>
      Array.from(
        dialog.querySelectorAll<HTMLElement>(
          'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])',
        ),
      ).filter((element) => !element.hasAttribute("hidden"));
    const focusInitial = window.requestAnimationFrame(() => {
      (focusable()[0] ?? dialog).focus();
    });
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onClose();
        return;
      }
      if (event.key !== "Tab") return;
      const items = focusable();
      if (items.length === 0) {
        event.preventDefault();
        dialog.focus();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    const onFocus = (event: FocusEvent) => {
      if (event.target instanceof Node && !dialog.contains(event.target)) {
        (focusable()[0] ?? dialog).focus();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    document.addEventListener("focusin", onFocus, true);
    return () => {
      window.cancelAnimationFrame(focusInitial);
      window.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("focusin", onFocus, true);
      if (previouslyFocused?.isConnected) previouslyFocused.focus();
    };
  }, [onClose, open]);

  const usage = useMemo(
    () => (summary ? aggregateUsage(summary) : null),
    [summary],
  );
  // Keep the source aggregate immutable because the metric toggle reorders it.
  const orderedProviders = useMemo(() => {
    if (!usage) return [];
    return [...usage.providers].sort((a, b) =>
      metric === "cost"
        ? b.costUsd - a.costUsd
        : b.totalTokens - a.totalTokens,
    );
  }, [metric, usage]);

  if (!open) return null;

  const periods: UsagePeriodTotals[] = usage
    ? isPast24Hours
      ? usage.hourly
      : usage.daily
    : [];
  const activePeriods = periods.filter((period) => period.totalTokens > 0).length;
  const periodAverage =
    !usage || activePeriods === 0 ? 0 : usage.totalTokens / activePeriods;
  const observedInput = usage
    ? usage.uncachedInputTokens +
      usage.cachedInputTokens +
      usage.cacheCreationTokens
    : 0;
  const cachedShare =
    !usage || observedInput === 0 ? 0 : usage.cachedInputTokens / observedInput;
  const sourceWarnings =
    summary?.sources.filter((source) => source.status !== "ok") ?? [];
  const recentPeriods = [...periods]
    .filter((period) => period.totalTokens > 0)
    .reverse()
    .slice(0, 8);

  return (
    <div
      ref={dialogRef}
      className="usage-page"
      role="dialog"
      aria-modal="true"
      aria-label="Usage"
      tabIndex={-1}
    >
      <header className="usage-page__topbar">
        <button type="button" className="usage-page__back" onClick={onClose}>
          <ArrowLeft size={16} strokeWidth={1.7} />
          <span>Back</span>
        </button>
        <span className="usage-page__topbar-title">Usage</span>
        <button
          type="button"
          className="usage-page__close"
          onClick={onClose}
          aria-label="Close usage"
        >
          <X size={17} strokeWidth={1.7} />
        </button>
      </header>

      <main className="usage-page__canvas">
        <div className="usage-page__content">
          <header className="usage-page__header">
            <div>
              <span className="usage-page__eyebrow">Open Xiao · local ledger</span>
              <h1>Usage</h1>
              <p>
                {summary
                  ? isPast24Hours && summary.sinceTime && summary.untilTime
                    ? `${formatUsageDateTime(summary.sinceTime)} to ${formatUsageDateTime(summary.untilTime)}`
                    : `${formatUsageDay(summary.sinceDay)} to ${formatUsageDay(summary.untilDay)}`
                  : isPast24Hours
                    ? "Past 24 hours"
                    : `Last ${windowDays} days`}
              </p>
            </div>
            <div className="usage-page__header-actions">
              <SegmentedControl
                value={windowDays}
                options={WINDOW_OPTIONS.map((option) => ({
                  value: option.days,
                  label: option.label,
                }))}
                onChange={setWindowDays}
                label="Usage window"
              />
              <button
                type="button"
                className="usage-page__icon-button"
                onClick={() => void loadUsage(true)}
                disabled={loading}
                aria-label="Refresh usage"
                title="Refresh usage"
              >
                <RefreshCw
                  size={14}
                  strokeWidth={1.7}
                  className={loading ? "is-spinning" : undefined}
                />
              </button>
            </div>
          </header>

          {sourceWarnings.length > 0 || summary?.pricingStatus === "unavailable" ? (
            <div className="usage-page__notice" role="status">
              {sourceWarnings.map((source) => (
                <span key={source.provider}>
                  {USAGE_PROVIDER_LABEL[source.provider]}: {source.message ?? "Usage is partial."}
                </span>
              ))}
              {summary?.pricingStatus === "unavailable" ? (
                <span>Pricing is unavailable. Token totals are still complete for readable sources.</span>
              ) : null}
            </div>
          ) : null}

          {error && summary ? (
            <div className="usage-page__notice" role="alert">
              <strong>Usage could not be refreshed</strong>
              <span>{error} Showing the last loaded data.</span>
            </div>
          ) : null}

          {loading && !summary ? (
            <UsageSkeleton />
          ) : error && !summary ? (
            <div className="usage-page__state usage-page__state--error" role="alert">
              <strong>Usage could not be loaded</strong>
              <span>{error}</span>
              <button type="button" onClick={() => void loadUsage(false)}>
                Try again
              </button>
            </div>
          ) : usage ? (
            <>
              <section className="usage-page__overview" aria-label="Usage overview">
                <div className="usage-page__summary">
                  <div className="usage-page__headline">
                    <span>{metric === "cost" ? "API-equivalent cost" : "Processed tokens"}</span>
                    <strong>
                      {metric === "cost"
                        ? formatUsageUsd(usage.costUsd)
                        : formatUsageTokens(usage.totalTokens)}
                    </strong>
                    <small>
                      {metric === "cost"
                        ? "Estimated at full API rates, not subscription spend."
                        : `${formatUsageTokens(usage.totalTokens)} tokens across ${usage.sessions.toLocaleString()} sessions.`}
                    </small>
                  </div>

                  {orderedProviders.length === 0 ? (
                    <div className="usage-page__empty-inline">
                      No provider activity in this window.
                    </div>
                  ) : (
                    orderedProviders.map((provider) => {
                      const share =
                        metric === "cost" ? provider.costShare : provider.tokenShare;
                      return (
                        <div className="usage-page__provider" key={provider.provider}>
                          <div className="usage-page__provider-row">
                            <span>
                              <ProviderMark provider={provider.provider} />
                              {USAGE_PROVIDER_LABEL[provider.provider]}
                            </span>
                            <strong>
                              {metric === "cost"
                                ? formatUsageUsd(provider.costUsd)
                                : formatUsageTokens(provider.totalTokens)}
                            </strong>
                          </div>
                          <div className="usage-page__provider-track" aria-hidden>
                            <span
                              style={{
                                width: `${Math.max(0, Math.min(100, share * 100))}%`,
                                background: PROVIDER_COLOR[provider.provider],
                              }}
                            />
                          </div>
                          <small>
                            {formatUsagePercent(share)} of {metric}, {formatUsageTokens(provider.totalTokens)} tokens
                          </small>
                        </div>
                      );
                    })
                  )}
                </div>

                <div className="usage-page__chart-column">
                  <div className="usage-page__section-head">
                    <h2>
                      {isPast24Hours ? "Hourly" : "Daily"}{" "}
                      {metric === "cost" ? "cost" : "processed tokens"}
                    </h2>
                    <div className="usage-page__chart-actions">
                      <SegmentedControl
                        value={metric}
                        options={[
                          { value: "cost", label: "Cost" },
                          { value: "tokens", label: "Tokens" },
                        ]}
                        onChange={setMetric}
                        label="Chart metric"
                        compact
                      />
                      <div className="usage-page__legend" aria-label="Chart providers">
                        {USAGE_PROVIDER_ORDER.map((provider) => (
                          <span key={provider}>
                            <ProviderMark provider={provider} />
                            {USAGE_PROVIDER_LABEL[provider]}
                          </span>
                        ))}
                      </div>
                    </div>
                  </div>
                  <UsageChart
                    periods={periods}
                    metric={metric}
                    resolution={isPast24Hours ? "hour" : "day"}
                    referenceTime={summary?.untilTime}
                  />
                </div>
              </section>

              <section className="usage-page__metrics" aria-label="Usage metrics">
                <Metric
                  label="Processed tokens"
                  value={formatUsageTokens(usage.totalTokens)}
                  detail={`${formatUsageTokens(periodAverage)} per active ${isPast24Hours ? "hour" : "day"}`}
                />
                <Metric
                  label="Cached input"
                  value={formatUsageTokens(usage.cachedInputTokens)}
                  detail={`${formatUsagePercent(cachedShare)} of observed input`}
                />
                <Metric
                  label="Uncached input"
                  value={formatUsageTokens(usage.uncachedInputTokens)}
                  detail={`${formatUsageTokens(usage.cacheCreationTokens)} cache writes`}
                />
                <Metric
                  label="Output"
                  value={formatUsageTokens(usage.outputTokens)}
                  detail={`${formatUsageTokens(usage.reasoningTokens)} reasoning tokens`}
                />
                <Metric
                  label="Cache savings"
                  value={formatUsageUsd(usage.cacheSavingsUsd)}
                  detail="Compared with full input rates"
                />
              </section>

              <section className="usage-page__details">
                <div className="usage-page__breakdown">
                  <div className="usage-page__section-head">
                    <h2>Breakdown</h2>
                    <SegmentedControl
                      value={breakdown}
                      options={[
                        { value: "model", label: "Model" },
                        {
                          value: "time",
                          label: isPast24Hours ? "Hour" : "Day",
                        },
                      ]}
                      onChange={setBreakdown}
                      label="Breakdown grouping"
                      compact
                    />
                  </div>
                  <div className="usage-page__table-wrap">
                    {breakdown === "model" ? (
                      <table>
                        <thead>
                          <tr>
                            <th>Model</th>
                            <th>Cost</th>
                            <th>Share</th>
                            <th>Tokens</th>
                          </tr>
                        </thead>
                        <tbody>
                          {usage.models.length === 0 ? (
                            <EmptyTable colSpan={4} />
                          ) : (
                            usage.models.map((model) => (
                              <tr key={`${model.provider}:${model.model}`}>
                                <td>
                                  <span className="usage-page__model">
                                    <ProviderMark provider={model.provider} />
                                    {model.model}
                                  </span>
                                </td>
                                <td>{formatUsageUsd(model.costUsd)}</td>
                                <td>{formatUsagePercent(model.costShare)}</td>
                                <td>{formatUsageTokens(model.totalTokens)}</td>
                              </tr>
                            ))
                          )}
                        </tbody>
                      </table>
                    ) : (
                      <table>
                        <thead>
                          <tr>
                            <th>{isPast24Hours ? "Hour" : "Day"}</th>
                            <th>Codex</th>
                            <th>Claude Code</th>
                            <th>Total</th>
                            <th>Tokens</th>
                          </tr>
                        </thead>
                        <tbody>
                          {recentPeriods.length === 0 ? (
                            <EmptyTable colSpan={5} />
                          ) : (
                            recentPeriods.map((period) => (
                              <tr key={usagePeriodKey(period)}>
                                <td>
                                  {formatUsagePeriod(
                                    period,
                                    summary?.untilTime,
                                  )}
                                </td>
                                <td>{formatUsageUsd(period.byProvider.codex.costUsd)}</td>
                                <td>{formatUsageUsd(period.byProvider.claude.costUsd)}</td>
                                <td>{formatUsageUsd(period.costUsd)}</td>
                                <td>{formatUsageTokens(period.totalTokens)}</td>
                              </tr>
                            ))
                          )}
                        </tbody>
                      </table>
                    )}
                  </div>
                </div>

                <div className="usage-page__quality">
                  <h2>Cost quality</h2>
                  <dl>
                    <QualityRow
                      label="Provider reported"
                      value={formatUsagePercent(usage.costQuality.providerReportedShare)}
                    />
                    <QualityRow
                      label="Model priced"
                      value={formatUsagePercent(usage.costQuality.modelPricedShare)}
                    />
                    <QualityRow
                      label="Unpriced"
                      value={formatUsagePercent(usage.costQuality.unpricedShare)}
                    />
                    <QualityRow
                      label="Scan time"
                      value={`${summary?.scanDurationMs.toLocaleString() ?? 0} ms`}
                    />
                    <QualityRow
                      label="Rate table"
                      value={summary?.pricingStatus ?? "unavailable"}
                    />
                  </dl>
                </div>
              </section>
            </>
          ) : null}
        </div>
      </main>
    </div>
  );
});

function ProviderMark({ provider }: { provider: UsageProvider }) {
  return provider === "codex" ? (
    <span className="usage-page__provider-mark" aria-hidden>
      <OpenAILogo size={13} />
    </span>
  ) : (
    <span className="usage-page__provider-mark" aria-hidden>
      <ClaudeLogo size={13} />
    </span>
  );
}

function SegmentedControl<T extends string | number>({
  value,
  options,
  onChange,
  label,
  compact = false,
}: {
  value: T;
  options: readonly { value: T; label: string }[];
  onChange: (value: T) => void;
  label: string;
  compact?: boolean;
}) {
  return (
    <div
      className={`usage-page__segments${compact ? " is-compact" : ""}`}
      role="group"
      aria-label={label}
    >
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          className={option.value === value ? "is-active" : undefined}
          onClick={() => onChange(option.value)}
          aria-pressed={option.value === value}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

function Metric({
  label,
  value,
  detail,
}: {
  label: string;
  value: string;
  detail: string;
}) {
  return (
    <div className="usage-page__metric">
      <span>{label}</span>
      <strong>{value}</strong>
      <small>{detail}</small>
    </div>
  );
}

function QualityRow({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

function EmptyTable({ colSpan }: { colSpan: number }) {
  return (
    <tr>
      <td className="usage-page__table-empty" colSpan={colSpan}>
        No activity in this window.
      </td>
    </tr>
  );
}

function UsageSkeleton() {
  return (
    <div className="usage-page__loading" role="status">
      <div className="usage-page__loading-copy">
        <RefreshCw size={16} strokeWidth={1.7} className="is-spinning" />
        <div>
          <strong>Scanning local usage</strong>
          <span>
            Reading Codex and Claude Code transcripts on this device. The first
            scan can take longer; later visits reuse an on-device cache.
          </span>
        </div>
      </div>
      <div className="usage-page__skeleton" aria-hidden="true">
        <div />
        <div />
        <div />
      </div>
    </div>
  );
}

function isUsageHour(period: UsagePeriodTotals): period is UsageHourTotals {
  return "hourStart" in period;
}

function usagePeriodKey(period: UsagePeriodTotals): string {
  return isUsageHour(period) ? period.hourStart : period.day;
}

function formatUsagePeriod(
  period: UsagePeriodTotals,
  referenceTime?: string,
): string {
  if (!isUsageHour(period)) return formatUsageDay(period.day);
  return referenceTime
    ? formatRelativeUsageHour(period.hourStart, referenceTime)
    : formatUsageDateTime(period.hourStart);
}

function UsageChart({
  periods,
  metric,
  resolution,
  referenceTime,
}: {
  periods: UsagePeriodTotals[];
  metric: ChartMetric;
  resolution: "day" | "hour";
  referenceTime?: string;
}) {
  const plotRef = useRef<HTMLDivElement>(null);
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);
  const width = 900;
  const height = 220;
  const columns = useMemo(
    () => buildUsageDayColumns(periods, metric),
    [metric, periods],
  );
  const peak = columns.reduce(
    (maximum, column) =>
      column.bands.reduce((inner, band) => Math.max(inner, band.value), maximum),
    0,
  );
  const { max: maximum, ticks } = niceUsageScale(peak, 4);
  const xFor = useCallback(
    (index: number) =>
      periods.length <= 1 ? 0 : (index / (periods.length - 1)) * width,
    [periods.length],
  );
  const yFor = useCallback(
    (value: number) =>
      maximum === 0 ? height : height - (value / maximum) * (height - 8),
    [maximum],
  );
  const series = useMemo(
    () =>
      USAGE_PROVIDER_ORDER.map((provider, providerIndex) => {
        const curve = smoothUsageCurve(
          columns.map((column, index) => ({
            x: xFor(index),
            y: yFor(column.bands[providerIndex]?.value ?? 0),
          })),
        );
        const line = usageCurvePath(curve);
        return {
          provider,
          line,
          area: line ? `${line} L${width},${height} L0,${height} Z` : "",
          total: columns.reduce(
            (sum, column) => sum + (column.bands[providerIndex]?.value ?? 0),
            0,
          ),
        };
      }).sort((a, b) => b.total - a.total),
    [columns, xFor, yFor],
  );
  const hovered = hoverIndex == null ? null : periods[hoverIndex] ?? null;
  const hoveredColumn = hoverIndex == null ? null : columns[hoverIndex] ?? null;
  const format = metric === "cost" ? formatUsageUsd : formatUsageTokens;

  return (
    <div className="usage-page__chart">
      <div className="usage-page__chart-body">
        <div className="usage-page__chart-scale" aria-hidden>
          {ticks.map((tick) => (
            <span key={tick} style={{ top: `${(yFor(tick) / height) * 100}%` }}>
              {tick === 0 ? "0" : format(tick)}
            </span>
          ))}
        </div>
        <div
          ref={plotRef}
          className="usage-page__plot"
          onMouseMove={(event) => {
            const bounds = plotRef.current?.getBoundingClientRect();
            if (!bounds || bounds.width === 0 || periods.length === 0) return;
            const fraction = (event.clientX - bounds.left) / bounds.width;
            setHoverIndex(
              Math.max(
                0,
                Math.min(
                  periods.length - 1,
                  Math.round(fraction * (periods.length - 1)),
                ),
              ),
            );
          }}
          onMouseLeave={() => setHoverIndex(null)}
        >
          <svg
            viewBox={`0 0 ${width} ${height}`}
            preserveAspectRatio="none"
            role="img"
            aria-label={`${resolution === "hour" ? "Hourly" : "Daily"} ${metric} by provider`}
          >
            {ticks.map((tick) => (
              <line
                key={tick}
                x1="0"
                x2={width}
                y1={yFor(tick)}
                y2={yFor(tick)}
                className="usage-page__grid-line"
                vectorEffect="non-scaling-stroke"
              />
            ))}
            {series.map(({ provider, area }) => (
              <path
                key={`${provider}-area`}
                d={area}
                fill={PROVIDER_COLOR[provider]}
                fillOpacity="0.1"
              />
            ))}
            {series.map(({ provider, line }) => (
              <path
                key={`${provider}-line`}
                d={line}
                fill="none"
                stroke={PROVIDER_COLOR[provider]}
                strokeWidth="2"
                vectorEffect="non-scaling-stroke"
              />
            ))}
            {hoverIndex == null ? null : (
              <line
                x1={xFor(hoverIndex)}
                x2={xFor(hoverIndex)}
                y1="8"
                y2={height}
                className="usage-page__hover-line"
                vectorEffect="non-scaling-stroke"
              />
            )}
          </svg>
          {hovered ? (
            <div
              className="usage-page__tooltip"
              style={{
                left: `${periods.length <= 1 ? 0 : ((hoverIndex ?? 0) / (periods.length - 1)) * 100}%`,
                transform:
                  (hoverIndex ?? 0) > periods.length * 0.62
                    ? "translateX(-100%)"
                    : "translateX(0)",
              }}
            >
              <strong>{formatUsagePeriod(hovered, referenceTime)}</strong>
              {USAGE_PROVIDER_ORDER.map((provider) => (
                <span key={provider}>
                  <ProviderMark provider={provider} />
                  {USAGE_PROVIDER_LABEL[provider]}
                  <b>
                    {format(
                      hoveredColumn?.bands.find((band) => band.provider === provider)?.value ?? 0,
                    )}
                  </b>
                </span>
              ))}
              <span className="usage-page__tooltip-total">
                <i />
                Total
                <b>{format(hoveredColumn?.total ?? 0)}</b>
              </span>
            </div>
          ) : null}
        </div>
      </div>
      <div className="usage-page__chart-axis">
        <span>{periods[0] ? formatUsageAxisPeriod(periods[0]) : ""}</span>
        <span>
          {periods.length
            ? formatUsageAxisPeriod(
                periods[Math.floor(periods.length / 2)] ?? periods[0],
              )
            : ""}
        </span>
        <span>
          {periods.length
            ? formatUsageAxisPeriod(periods[periods.length - 1] ?? periods[0])
            : ""}
        </span>
      </div>
    </div>
  );
}

function formatUsageAxisPeriod(period: UsagePeriodTotals | undefined): string {
  if (!period) return "";
  return isUsageHour(period)
    ? formatUsageHour(period.hourStart)
    : formatUsageDay(period.day);
}

type UsagePoint = { x: number; y: number };
type UsageCurveSegment = {
  from: UsagePoint;
  c1: UsagePoint;
  c2: UsagePoint;
  to: UsagePoint;
};

function usageMonotoneTangents(points: readonly UsagePoint[]): readonly number[] {
  if (points.length < 2) return [0];
  const slopes = points.slice(0, -1).map((point, index) => {
    const next = points[index + 1] ?? point;
    const dx = next.x - point.x;
    return dx === 0 ? 0 : (next.y - point.y) / dx;
  });
  const tangents = Array.from({ length: points.length }, () => 0);
  tangents[0] = slopes[0] ?? 0;
  tangents[tangents.length - 1] = slopes[slopes.length - 1] ?? 0;
  for (let index = 1; index < tangents.length - 1; index += 1) {
    const previous = slopes[index - 1] ?? 0;
    const next = slopes[index] ?? 0;
    tangents[index] = previous * next <= 0 ? 0 : (previous + next) / 2;
  }
  for (let index = 0; index < slopes.length; index += 1) {
    const slope = slopes[index] ?? 0;
    if (slope === 0) {
      tangents[index] = 0;
      tangents[index + 1] = 0;
      continue;
    }
    const a = (tangents[index] ?? 0) / slope;
    const b = (tangents[index + 1] ?? 0) / slope;
    const magnitude = a * a + b * b;
    if (magnitude > 9) {
      const scale = 3 / Math.sqrt(magnitude);
      tangents[index] = scale * a * slope;
      tangents[index + 1] = scale * b * slope;
    }
  }
  return tangents;
}

function smoothUsageCurve(points: readonly UsagePoint[]): readonly UsageCurveSegment[] {
  if (points.length < 2) return [];
  const tangents = usageMonotoneTangents(points);
  return points.slice(0, -1).flatMap((from, index) => {
    const to = points[index + 1];
    if (!to) return [];
    const dx = to.x - from.x;
    return [{
      from,
      c1: { x: from.x + dx / 3, y: from.y + ((tangents[index] ?? 0) * dx) / 3 },
      c2: { x: to.x - dx / 3, y: to.y - ((tangents[index + 1] ?? 0) * dx) / 3 },
      to,
    }];
  });
}

function usageCurvePath(segments: readonly UsageCurveSegment[]): string {
  const first = segments[0];
  if (!first) return "";
  let path = `M${first.from.x.toFixed(2)},${first.from.y.toFixed(2)}`;
  for (const segment of segments) {
    path += ` C${segment.c1.x.toFixed(2)},${segment.c1.y.toFixed(2)} ${segment.c2.x.toFixed(2)},${segment.c2.y.toFixed(2)} ${segment.to.x.toFixed(2)},${segment.to.y.toFixed(2)}`;
  }
  return path;
}
