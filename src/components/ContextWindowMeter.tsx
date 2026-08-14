import { useEffect, useId, useRef, useState } from "react";

function formatTokens(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "0";
  if (value < 1_000) return `${Math.round(value)}`;
  if (value < 10_000) return `${(value / 1_000).toFixed(1).replace(/\.0$/, "")}k`;
  if (value < 1_000_000) return `${Math.round(value / 1_000)}k`;
  return `${(value / 1_000_000).toFixed(1).replace(/\.0$/, "")}m`;
}

function formatPercentage(value: number | null): string | null {
  if (value === null || !Number.isFinite(value)) return null;
  if (value < 10) return `${value.toFixed(1).replace(/\.0$/, "")}%`;
  return `${Math.round(value)}%`;
}

export type ContextWindowUsage = {
  usedTokens: number;
  maxTokens: number | null;
  usedPercentage: number | null;
};

export function ContextWindowMeter(props: {
  usage: ContextWindowUsage;
  className?: string;
}) {
  const { usage } = props;
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const tipId = useId();

  const usedPercentage = formatPercentage(usage.usedPercentage);
  const normalizedPercentage = Math.max(
    0,
    Math.min(100, usage.usedPercentage ?? 0),
  );
  const radius = 9.75;
  const circumference = 2 * Math.PI * radius;
  const dashOffset =
    circumference - (normalizedPercentage / 100) * circumference;
  const isOverloaded = normalizedPercentage > 90;
  const usageColor = isOverloaded
    ? "var(--color-red-500)"
    : "color-mix(in srgb, var(--muted-foreground) 72%, transparent)";

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    // Capture so Escape closes the popover before App's window handler runs.
    window.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [open]);

  const label =
    usage.maxTokens != null && usedPercentage
      ? `Context window ${usedPercentage} used`
      : `Context window ${formatTokens(usage.usedTokens)} tokens used`;

  return (
    <div
      ref={rootRef}
      className={`ctx-meter${props.className ? ` ${props.className}` : ""}${open ? " is-open" : ""}`}
    >
      <button
        type="button"
        className="ctx-meter__btn"
        aria-label={label}
        aria-describedby={open ? tipId : undefined}
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onPointerDown={(e) => {
          // Keep composer textarea focus.
          e.preventDefault();
        }}
      >
        <span className="ctx-meter__ring" aria-hidden>
          <svg viewBox="0 0 24 24" className="ctx-meter__svg">
            <circle
              cx="12"
              cy="12"
              r={radius}
              fill="none"
              stroke="color-mix(in srgb, var(--muted-foreground) 24%, transparent)"
              strokeWidth="3"
            />
            <circle
              cx="12"
              cy="12"
              r={radius}
              fill="none"
              stroke={usageColor}
              strokeWidth="3"
              strokeLinecap="round"
              strokeDasharray={circumference}
              strokeDashoffset={dashOffset}
              className="ctx-meter__arc"
            />
          </svg>
        </span>
      </button>

      {open ? (
        <div id={tipId} role="tooltip" className="ctx-meter__tip">
          <div className="ctx-meter__tip-row">
            <div className="ctx-meter__tip-title">Context Window</div>
            {usage.maxTokens != null && usedPercentage ? (
              <div className="ctx-meter__tip-meta">
                <span>{usedPercentage}</span>
                <span className="ctx-meter__tip-dot">·</span>
                <span>
                  {formatTokens(usage.usedTokens)}/
                  {formatTokens(usage.maxTokens)}
                </span>
              </div>
            ) : (
              <div className="ctx-meter__tip-meta">
                {formatTokens(usage.usedTokens)}
              </div>
            )}
          </div>
          {usage.maxTokens != null ? (
            <div
              className="ctx-meter__bar"
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(normalizedPercentage)}
              aria-label="Context window usage"
            >
              <div
                className="ctx-meter__bar-fill"
                style={{
                  width: `${normalizedPercentage}%`,
                  backgroundColor: usageColor,
                }}
              />
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
