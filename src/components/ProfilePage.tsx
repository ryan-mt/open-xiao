import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import {
  getCodexUsage,
  type AuthStatus,
  type CodexUsageStatus,
  type CodexUsageWindow,
  type OpenAIAuthStatus,
} from "../auth";
import { formatPlanLabel } from "../planLabel";
import {
  createProfile,
  fileToAvatarDataUrl,
  getProfile,
  getProfileStats,
  type ProfileStats,
  type UserProfile,
  updateProfile,
} from "../profile";
import { GrokLogo } from "./GrokLogo";
import { AppLogo } from "./AppLogo";
import { OpenAILogo } from "./OpenAILogo";
import {
  normalizeCodexUsageError,
  safeErrorMessage,
  type UserFacingError,
} from "../lib/userFacingError";
import { activityMonthLabels, formatActivityTokens } from "../profileActivity";

type Props = {
  open: boolean;
  auth: AuthStatus;
  authBusy?: boolean;
  openaiAuth: OpenAIAuthStatus;
  openaiAuthBusy?: boolean;
  onClose: () => void;
  onProfileChange?: (p: UserProfile | null) => void;
  onLogin?: () => void;
  onLogout?: () => void;
  onOpenAILogin?: () => void;
  onOpenAILogout?: () => void;
};

const WEEKDAYS = ["", "Mon", "", "Wed", "", "Fri", ""];

function levelForCount(count: number, max: number): number {
  if (count <= 0) return 0;
  if (max <= 1) return 4;
  const t = count / max;
  if (t > 0.75) return 4;
  if (t > 0.5) return 3;
  if (t > 0.25) return 2;
  return 1;
}

/** Align activity days to weeks starting Monday (GitHub-style). */
function buildHeatmapGrid(days: ProfileStats["days"]) {
  if (days.length === 0) {
    return {
      cells: [] as {
        date: string;
        count: number;
        tokenCount: number;
        level: number;
      }[],
      weeks: 0,
      padFront: 0,
    };
  }
  const maxMessages = Math.max(1, ...days.map((d) => d.count));
  const maxTokens = Math.max(1, ...days.map((d) => d.tokenCount));
  const first = new Date(days[0].date + "T12:00:00");
  const jsDay = first.getDay();
  const monIndex = (jsDay + 6) % 7;
  const pad: {
    date: string;
    count: number;
    tokenCount: number;
    level: number;
  }[] = [];
  for (let i = 0; i < monIndex; i++) {
    pad.push({ date: "", count: 0, tokenCount: 0, level: -1 });
  }
  const cells = [
    ...pad,
    ...days.map((d) => ({
      date: d.date,
      count: d.count,
      tokenCount: d.tokenCount,
      level: Math.max(
        levelForCount(d.count, maxMessages),
        levelForCount(d.tokenCount, maxTokens),
      ),
    })),
  ];
  const weeks = Math.ceil(cells.length / 7);
  return { cells, weeks, padFront: monIndex };
}

function plural(n: number, one: string, many = `${one}s`) {
  return n === 1 ? one : many;
}

function formatJoined(ts: number): string {
  try {
    return new Date(ts).toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
      year: "numeric",
    });
  } catch {
    return "";
  }
}

function formatDayLabel(ymd: string): string {
  if (!ymd) return "";
  try {
    return new Date(ymd + "T12:00:00").toLocaleDateString(undefined, {
      weekday: "short",
      month: "short",
      day: "numeric",
      year: "numeric",
    });
  } catch {
    return ymd;
  }
}

function usageWindowLabel(
  windowMinutes: number | null | undefined,
  fallback: string,
): string {
  if (windowMinutes === 300) return "5-hour limit";
  if (windowMinutes === 1_440) return "Daily limit";
  if (windowMinutes === 10_080) return "Weekly limit";
  if (windowMinutes === 43_200 || windowMinutes === 44_640) {
    return "Monthly limit";
  }
  return fallback;
}

function usageResetLabel(resetsAt: number | null | undefined): string {
  if (!resetsAt) return "Reset time unavailable";
  const date = new Date(resetsAt * 1000);
  if (Number.isNaN(date.getTime())) return "Reset time unavailable";
  return `Resets ${date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  })}`;
}

function clampTooltipPosition(x: number, y: number) {
  if (typeof window === "undefined") return { x, y };
  const pad = 10;
  const approxW = 160;
  const approxH = 52;
  const nx = Math.min(
    Math.max(x, pad + approxW / 2),
    window.innerWidth - pad - approxW / 2,
  );
  // Prefer above the cell; if near the top edge, drop below.
  let ny = y;
  if (y - approxH - 12 < pad) {
    ny = y + approxH + 22;
  }
  return { x: nx, y: ny };
}

export const ProfilePage = memo(function ProfilePage({
  open,
  auth,
  authBusy,
  openaiAuth,
  openaiAuthBusy,
  onClose,
  onProfileChange,
  onLogin,
  onLogout,
  onOpenAILogin,
  onOpenAILogout,
}: Props) {
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [stats, setStats] = useState<ProfileStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [codexUsage, setCodexUsage] = useState<CodexUsageStatus | null>(null);
  const [codexUsageLoading, setCodexUsageLoading] = useState(false);
  const [codexUsageError, setCodexUsageError] =
    useState<UserFacingError | null>(null);
  const [codexUsageUpdatedAt, setCodexUsageUpdatedAt] = useState<number | null>(
    null,
  );
  const codexUsageRequestRef = useRef(0);
  const codexUsageInFlightRef = useRef<number | null>(null);

  const [createOpen, setCreateOpen] = useState(false);
  const [createName, setCreateName] = useState("");
  const [editingName, setEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState("");
  const [hoverCell, setHoverCell] = useState<{
    date: string;
    count: number;
    tokenCount: number;
    x: number;
    y: number;
  } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    setEditingName(false);
    setHoverCell(null);
    void (async () => {
      try {
        const [p, s] = await Promise.all([getProfile(), getProfileStats(371)]);
        if (cancelled) return;
        setProfile(p);
        setStats(s);
        setCreateOpen(!p);
        if (p) setNameDraft(p.name);
        else setCreateName(auth.name?.trim() || "");
      } catch (e) {
        if (!cancelled) {
          setError(safeErrorMessage(e, "Could not load the local profile."));
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, auth.name]);

  const refreshCodexUsage = useCallback(async () => {
    if (codexUsageInFlightRef.current != null) return;
    const requestId = ++codexUsageRequestRef.current;
    codexUsageInFlightRef.current = requestId;
    setCodexUsageLoading(true);
    setCodexUsageError(null);
    try {
      const usage = await getCodexUsage();
      if (codexUsageRequestRef.current === requestId) {
        setCodexUsage(usage);
        setCodexUsageUpdatedAt(Date.now());
      }
    } catch (error) {
      if (codexUsageRequestRef.current === requestId) {
        setCodexUsageError(normalizeCodexUsageError(error));
      }
    } finally {
      if (codexUsageRequestRef.current === requestId) {
        setCodexUsageLoading(false);
      }
      if (codexUsageInFlightRef.current === requestId) {
        codexUsageInFlightRef.current = null;
      }
    }
  }, []);

  useEffect(() => {
    if (!open || !openaiAuth.signedIn) {
      codexUsageRequestRef.current += 1;
      codexUsageInFlightRef.current = null;
      setCodexUsage(null);
      setCodexUsageLoading(false);
      setCodexUsageError(null);
      setCodexUsageUpdatedAt(null);
      return;
    }
    void refreshCodexUsage();
    const interval = window.setInterval(() => {
      void refreshCodexUsage();
    }, 30_000);
    return () => {
      window.clearInterval(interval);
      codexUsageRequestRef.current += 1;
      codexUsageInFlightRef.current = null;
    };
  }, [open, openaiAuth.signedIn, refreshCodexUsage]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        if (createOpen && !profile) return;
        if (createOpen && profile) {
          setCreateOpen(false);
          return;
        }
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose, createOpen, profile]);

  const grid = useMemo(
    () => buildHeatmapGrid(stats?.days ?? []),
    [stats?.days],
  );
  const labels = useMemo(
    () => activityMonthLabels(stats?.days ?? [], grid.padFront),
    [stats?.days, grid.padFront],
  );
  // All hooks must stay above the `if (!open)` return — opening profile
  // used to crash with a blank screen (hooks order change).
  const handleCreate = useCallback(async () => {
    const name = createName.trim();
    if (!name || busy) return;
    setBusy(true);
    setError(null);
    try {
      const p = await createProfile(name);
      setProfile(p);
      setCreateOpen(false);
      setNameDraft(p.name);
      onProfileChange?.(p);
      const s = await getProfileStats(371);
      setStats(s);
    } catch (e) {
      setError(safeErrorMessage(e, "Could not save the local profile."));
    } finally {
      setBusy(false);
    }
  }, [busy, createName, onProfileChange]);

  const commitName = useCallback(async () => {
    if (!profile) return;
    const name = nameDraft.trim();
    setEditingName(false);
    if (!name || name === profile.name) {
      setNameDraft(profile.name);
      return;
    }
    setBusy(true);
    try {
      const p = await updateProfile({ name });
      setProfile(p);
      onProfileChange?.(p);
    } catch (e) {
      setError(safeErrorMessage(e, "Could not update the profile name."));
      setNameDraft(profile.name);
    } finally {
      setBusy(false);
    }
  }, [nameDraft, onProfileChange, profile]);

  const handleAvatar = useCallback(
    async (file: File | null) => {
      if (!file || !profile) return;
      setBusy(true);
      setError(null);
      try {
        const dataUrl = await fileToAvatarDataUrl(file);
        const p = await updateProfile({ avatarDataUrl: dataUrl });
        setProfile(p);
        onProfileChange?.(p);
      } catch (e) {
        setError(safeErrorMessage(e, "Could not create the local profile."));
      } finally {
        setBusy(false);
      }
    },
    [onProfileChange, profile],
  );

  const clearAvatar = useCallback(async () => {
    if (!profile?.avatarDataUrl) return;
    setBusy(true);
    try {
      const p = await updateProfile({ clearAvatar: true });
      setProfile(p);
      onProfileChange?.(p);
    } catch (e) {
      setError(safeErrorMessage(e, "Could not remove the profile photo."));
    } finally {
      setBusy(false);
    }
  }, [onProfileChange, profile]);

  if (!open) return null;

  const displayName =
    profile?.name || auth.name || auth.email || "Your profile";
  const initial = (displayName.trim().charAt(0) || "G").toUpperCase();
  const yearMessages = stats?.totalMessages ?? 0;
  const yearTokens = stats?.totalOpenAITokens ?? 0;
  const hasActivity = (stats?.totalActiveDays ?? 0) > 0;
  const streak = stats?.currentStreak ?? 0;

  return (
    <div
      className="profile-backdrop"
      role="presentation"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && profile) onClose();
      }}
    >
      <div
        className="profile-page"
        role="dialog"
        aria-modal="true"
        aria-label="Profile"
      >
        <header className="profile-page__top">
          <button
            type="button"
            className="profile-page__back"
            onClick={onClose}
            disabled={!profile && createOpen}
            title="Back"
          >
            <BackIcon />
            <span>Back</span>
          </button>
          <div className="profile-page__heading-wrap">
            <h1 className="profile-page__heading">Profile</h1>
            <span className="profile-page__heading-sub">Local identity</span>
          </div>
          <button
            type="button"
            className="profile-page__close"
            onClick={onClose}
            disabled={!profile && createOpen}
            aria-label="Close profile"
            title="Close"
          >
            <CloseIcon />
          </button>
        </header>

        {loading ? (
          <div className="profile-page__state">
            <span className="profile-page__spinner" aria-hidden />
            Loading profile…
          </div>
        ) : (
          <div className="profile-page__body" ref={bodyRef}>
            {error ? (
              <div className="profile-page__error" role="alert">
                {error}
              </div>
            ) : null}

            {!profile ? (
              <div className="profile-empty">
                <div className="profile-empty__mark">
                  <AppLogo size={36} />
                </div>
                <h2 className="profile-empty__title">Create your profile</h2>
                <p className="profile-empty__copy">
                  A local identity for your name, avatar, and activity streak —
                  stored only on this device.
                </p>
                <button
                  type="button"
                  className="profile-btn profile-btn--primary"
                  onClick={() => {
                    setCreateName(auth.name?.trim() || "");
                    setCreateOpen(true);
                  }}
                >
                  Create profile
                </button>
              </div>
            ) : (
              <>
                <section className="profile-hero">
                  <div className="profile-hero__row">
                    <div className="profile-hero__avatar-wrap">
                      <button
                        type="button"
                        className="profile-hero__avatar"
                        onClick={() => fileRef.current?.click()}
                        disabled={busy}
                        title="Change avatar"
                        aria-label="Change avatar"
                      >
                        {profile.avatarDataUrl ? (
                          <img src={profile.avatarDataUrl} alt="" />
                        ) : (
                          <span className="profile-hero__initial">
                            {initial}
                          </span>
                        )}
                        <span className="profile-hero__avatar-edit">
                          <CameraIcon />
                        </span>
                      </button>
                      <input
                        ref={fileRef}
                        type="file"
                        accept="image/*"
                        hidden
                        onChange={(e) => {
                          const f = e.target.files?.[0] ?? null;
                          e.target.value = "";
                          void handleAvatar(f);
                        }}
                      />
                    </div>

                    <div className="profile-hero__meta">
                      <div className="profile-hero__badges">
                        <span className="profile-hero__badge">On device</span>
                        {streak > 0 ? (
                          <span className="profile-hero__badge profile-hero__badge--hot">
                            🔥 {streak} day streak
                          </span>
                        ) : null}
                      </div>
                      {editingName ? (
                        <input
                          className="profile-hero__name-input"
                          value={nameDraft}
                          autoFocus
                          maxLength={64}
                          disabled={busy}
                          onChange={(e) => setNameDraft(e.target.value)}
                          onBlur={() => void commitName()}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") {
                              e.preventDefault();
                              void commitName();
                            }
                            if (e.key === "Escape") {
                              // First Esc only cancels the rename; stop it from
                              // bubbling to the window handler that closes the
                              // whole dialog.
                              e.preventDefault();
                              e.stopPropagation();
                              setNameDraft(profile.name);
                              setEditingName(false);
                            }
                          }}
                        />
                      ) : (
                        <button
                          type="button"
                          className="profile-hero__name"
                          onClick={() => {
                            setNameDraft(profile.name);
                            setEditingName(true);
                          }}
                          title="Rename"
                        >
                          {profile.name}
                          <EditIcon />
                        </button>
                      )}
                      <p className="profile-hero__sub">
                        {profile.createdAt
                          ? `Joined ${formatJoined(profile.createdAt)} · `
                          : null}
                        Name and photo stay on this machine — separate from the
                        provider accounts below.
                      </p>
                      <div className="profile-hero__actions">
                        <button
                          type="button"
                          className="profile-btn profile-btn--ghost profile-btn--sm"
                          disabled={busy}
                          onClick={() => fileRef.current?.click()}
                        >
                          {profile.avatarDataUrl ? "Change photo" : "Add photo"}
                        </button>
                        {profile.avatarDataUrl ? (
                          <button
                            type="button"
                            className="profile-btn profile-btn--ghost profile-btn--sm"
                            onClick={() => void clearAvatar()}
                            disabled={busy}
                          >
                            Remove
                          </button>
                        ) : null}
                      </div>
                    </div>
                  </div>
                </section>

                <section className="profile-stats" aria-label="Activity stats">
                  <StatCard
                    value={stats?.currentStreak ?? 0}
                    label="Current streak"
                    hint="days"
                  />
                  <StatCard
                    value={stats?.longestStreak ?? 0}
                    label="Longest streak"
                    hint="days"
                  />
                  <StatCard
                    value={stats?.totalActiveDays ?? 0}
                    label="Active days"
                    hint="rolling period"
                  />
                  <StatCard
                    value={
                      yearTokens > 0
                        ? formatActivityTokens(yearTokens)
                        : yearMessages
                    }
                    label={yearTokens > 0 ? "OpenAI tokens" : "Messages"}
                    hint={yearTokens > 0 ? "official usage" : "sent"}
                  />
                </section>

                <section className="profile-streak">
                  <div className="profile-streak__head">
                    <div>
                      <h2 className="profile-streak__title">Activity</h2>
                      <p className="profile-streak__hint">
                        {hasActivity
                          ? [
                              yearMessages > 0
                                ? `${yearMessages} ${plural(yearMessages, "Grok message")}`
                                : null,
                              yearTokens > 0
                                ? `${formatActivityTokens(yearTokens)} OpenAI tokens`
                                : null,
                            ]
                              .filter(Boolean)
                              .join(" · ") + " in the rolling period"
                          : "Send a message to start your streak"}
                      </p>
                    </div>
                    {streak > 0 ? (
                      <span className="profile-streak__pill">
                        🔥 {streak} day{streak === 1 ? "" : "s"}
                      </span>
                    ) : null}
                  </div>

                  {hasActivity ? (
                    <div className="streak-scroll">
                      <div
                        className="streak"
                        style={
                          {
                            "--streak-weeks": String(Math.max(grid.weeks, 1)),
                          } as CSSProperties
                        }
                      >
                        <div className="streak__months" aria-hidden>
                          {labels.map((m) => (
                            <span
                              key={`${m.label}-${m.col}`}
                              className="streak__month"
                              style={{ gridColumn: m.col + 1 }}
                            >
                              {m.label}
                            </span>
                          ))}
                        </div>
                        <div className="streak__body">
                          <div className="streak__dows" aria-hidden>
                            {WEEKDAYS.map((w, i) => (
                              <span key={i} className="streak__dow">
                                {w}
                              </span>
                            ))}
                          </div>
                          <div
                            className="streak__grid"
                            role="img"
                            aria-label="Activity heatmap"
                            onMouseLeave={() => setHoverCell(null)}
                          >
                            {grid.cells.map((c, i) =>
                              c.level < 0 ? (
                                <span
                                  key={`pad-${i}`}
                                  className="streak__cell streak__cell--pad"
                                />
                              ) : (
                                <button
                                  type="button"
                                  key={c.date || i}
                                  className={`streak__cell streak__cell--l${c.level}${
                                    hoverCell?.date === c.date ? " is-hot" : ""
                                  }`}
                                  aria-label={
                                    c.count || c.tokenCount
                                      ? `${c.date}: ${[
                                          c.count
                                            ? `${c.count} ${plural(c.count, "Grok message")}`
                                            : null,
                                          c.tokenCount
                                            ? `${c.tokenCount} OpenAI tokens`
                                            : null,
                                        ]
                                          .filter(Boolean)
                                          .join(", ")}`
                                      : `${c.date}: no activity`
                                  }
                                  onMouseEnter={(e) => {
                                    const rect = (
                                      e.currentTarget as HTMLElement
                                    ).getBoundingClientRect();
                                    const pos = clampTooltipPosition(
                                      rect.left + rect.width / 2,
                                      rect.top,
                                    );
                                    setHoverCell({
                                      date: c.date,
                                      count: c.count,
                                      tokenCount: c.tokenCount,
                                      x: pos.x,
                                      y: pos.y,
                                    });
                                  }}
                                  onFocus={(e) => {
                                    const rect = (
                                      e.currentTarget as HTMLElement
                                    ).getBoundingClientRect();
                                    const pos = clampTooltipPosition(
                                      rect.left + rect.width / 2,
                                      rect.top,
                                    );
                                    setHoverCell({
                                      date: c.date,
                                      count: c.count,
                                      tokenCount: c.tokenCount,
                                      x: pos.x,
                                      y: pos.y,
                                    });
                                  }}
                                  onBlur={() => setHoverCell(null)}
                                />
                              ),
                            )}
                          </div>
                        </div>
                        <div className="streak__legend">
                          <span>Less</span>
                          {[0, 1, 2, 3, 4].map((l) => (
                            <span
                              key={l}
                              className={`streak__cell streak__cell--l${l}`}
                            />
                          ))}
                          <span>More</span>
                        </div>
                      </div>
                      {hoverCell && typeof document !== "undefined"
                        ? createPortal(
                            <div
                              className="streak__tooltip"
                              style={
                                {
                                  left: hoverCell.x,
                                  top: hoverCell.y,
                                } as CSSProperties
                              }
                              role="tooltip"
                            >
                              <strong>
                                {hoverCell.count || hoverCell.tokenCount
                                  ? [
                                      hoverCell.count
                                        ? `${hoverCell.count} ${plural(hoverCell.count, "Grok message")}`
                                        : null,
                                      hoverCell.tokenCount
                                        ? `${formatActivityTokens(hoverCell.tokenCount)} OpenAI tokens`
                                        : null,
                                    ]
                                      .filter(Boolean)
                                      .join(" · ")
                                  : "No activity"}
                              </strong>
                              <span>{formatDayLabel(hoverCell.date)}</span>
                            </div>,
                            document.body,
                          )
                        : null}
                    </div>
                  ) : (
                    <div className="profile-streak__empty">
                      Your heatmap will fill in from Grok messages and official
                      OpenAI token usage.
                    </div>
                  )}
                </section>

                {openaiAuth.signedIn ? (
                  <section className="profile-usage" aria-label="Codex usage">
                    <div className="profile-usage__head">
                      <span className="profile-usage__mark" aria-hidden>
                        <OpenAILogo size={15} />
                      </span>
                      <div className="profile-usage__copy">
                        <h2 className="profile-usage__title">Codex usage</h2>
                        <p className="profile-usage__hint">
                          Live allowance reported by OpenAI
                        </p>
                      </div>
                      <div className="profile-usage__actions">
                        {codexUsage ? (
                          <span
                            className="profile-usage__freshness"
                            role="status"
                          >
                            {codexUsageError
                              ? `${codexUsageError.title} · Last confirmed values`
                              : codexUsageUpdatedAt
                                ? `Updated ${new Date(
                                    codexUsageUpdatedAt,
                                  ).toLocaleTimeString(undefined, {
                                    hour: "numeric",
                                    minute: "2-digit",
                                    second: "2-digit",
                                  })}`
                                : null}
                          </span>
                        ) : null}
                        <button
                          type="button"
                          className={`profile-usage__refresh${codexUsageLoading ? " is-loading" : ""}`}
                          onClick={() => void refreshCodexUsage()}
                          disabled={codexUsageLoading}
                          aria-label="Refresh Codex usage"
                          title="Refresh usage"
                        >
                          <RefreshIcon />
                        </button>
                      </div>
                    </div>
                    {codexUsageLoading && !codexUsage ? (
                      <div className="profile-usage__loading" role="status">
                        Checking current limits…
                      </div>
                    ) : codexUsageError && !codexUsage ? (
                      <div className="profile-usage__unavailable" role="status">
                        {codexUsageError.message}
                      </div>
                    ) : codexUsage?.primary || codexUsage?.secondary ? (
                      <div className="profile-usage__limits">
                        {codexUsage.primary ? (
                          <UsageLimitRow
                            usage={codexUsage.primary}
                            fallbackLabel="Primary limit"
                          />
                        ) : null}
                        {codexUsage.secondary ? (
                          <UsageLimitRow
                            usage={codexUsage.secondary}
                            fallbackLabel="Secondary limit"
                          />
                        ) : null}
                      </div>
                    ) : (
                      <div className="profile-usage__unavailable" role="status">
                        No usage-limit data is available for this account.
                      </div>
                    )}
                  </section>
                ) : null}

                <section
                  className="profile-account"
                  aria-label="Connected accounts"
                >
                  <div className="profile-account__head">
                    <h2 className="profile-account__title">
                      Connected accounts
                    </h2>
                    <p className="profile-account__hint">
                      Provider sign-ins for models and billing — separate from
                      your local profile above.
                    </p>
                  </div>
                  <ProviderAccountCard
                    providerName="Grok"
                    signedIn={auth.signedIn}
                    meta={
                      auth.signedIn
                        ? [auth.email, formatPlanLabel(auth.plan)]
                            .filter(Boolean)
                            .join(" · ") || "Signed in"
                        : "Not signed in · SuperGrok or X Premium"
                    }
                    logo={<GrokLogo size={16} />}
                    busy={authBusy}
                    signInLabel="Sign in with SuperGrok"
                    onLogin={onLogin}
                    onLogout={onLogout}
                  />
                  <ProviderAccountCard
                    providerName="OpenAI"
                    signedIn={openaiAuth.signedIn}
                    meta={
                      openaiAuth.signedIn
                        ? [openaiAuth.email, formatPlanLabel(openaiAuth.plan)]
                            .filter(Boolean)
                            .join(" · ") || "Signed in"
                        : "Not signed in · For GPT models"
                    }
                    logo={<OpenAILogo size={16} />}
                    busy={openaiAuthBusy}
                    signInLabel="Sign in with OpenAI"
                    onLogin={onOpenAILogin}
                    onLogout={onOpenAILogout}
                  />
                </section>
              </>
            )}
          </div>
        )}
      </div>

      {createOpen ? (
        <div
          className="profile-create-backdrop"
          role="presentation"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget && profile) setCreateOpen(false);
          }}
        >
          <div
            className="profile-create"
            role="dialog"
            aria-modal="true"
            aria-label="Create profile"
          >
            <div className="profile-create__mark" aria-hidden>
              <AppLogo size={22} />
            </div>
            <h2 className="profile-create__title">What should we call you?</h2>
            <p className="profile-create__copy">
              This name stays on your device and shows in the sidebar. You can
              change it anytime.
            </p>
            <input
              className="profile-create__input"
              placeholder="Your name"
              value={createName}
              maxLength={64}
              autoFocus
              disabled={busy}
              onChange={(e) => setCreateName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  void handleCreate();
                }
              }}
            />
            <div className="profile-create__actions">
              {profile ? (
                <button
                  type="button"
                  className="profile-btn profile-btn--ghost"
                  onClick={() => setCreateOpen(false)}
                  disabled={busy}
                >
                  Cancel
                </button>
              ) : null}
              <button
                type="button"
                className="profile-btn profile-btn--primary"
                disabled={busy || !createName.trim()}
                onClick={() => void handleCreate()}
              >
                {busy ? "Saving…" : "Continue"}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
});

const StatCard = memo(function StatCard({
  value,
  label,
  hint,
}: {
  value: number | string;
  label: string;
  hint?: string;
}) {
  return (
    <div className="profile-stat">
      <span className="profile-stat__value">{value}</span>
      <span className="profile-stat__label">{label}</span>
      {hint ? <span className="profile-stat__hint">{hint}</span> : null}
    </div>
  );
});

const UsageLimitRow = memo(function UsageLimitRow({
  usage,
  fallbackLabel,
}: {
  usage: CodexUsageWindow;
  fallbackLabel: string;
}) {
  const usedPercent = Math.min(100, Math.max(0, usage.usedPercent));
  const remainingPercent = Math.max(0, 100 - usedPercent);
  const remainingLabel = new Intl.NumberFormat(undefined, {
    maximumFractionDigits: 1,
  }).format(remainingPercent);
  return (
    <div className="profile-usage__limit">
      <div className="profile-usage__limit-copy">
        <span className="profile-usage__limit-name">
          {usageWindowLabel(usage.windowMinutes, fallbackLabel)}
        </span>
        <span className="profile-usage__remaining">{remainingLabel}% left</span>
      </div>
      <div
        className={`profile-usage__track${remainingPercent <= 20 ? " is-low" : ""}`}
        role="progressbar"
        aria-label={`${usageWindowLabel(usage.windowMinutes, fallbackLabel)} remaining`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={remainingPercent}
      >
        <span style={{ width: `${remainingPercent}%` }} />
      </div>
      <span className="profile-usage__reset">
        {usageResetLabel(usage.resetsAt)}
      </span>
    </div>
  );
});

const ProviderAccountCard = memo(function ProviderAccountCard({
  providerName,
  signedIn,
  meta,
  logo,
  busy,
  signInLabel,
  onLogin,
  onLogout,
}: {
  providerName: string;
  signedIn: boolean;
  meta: string;
  logo: ReactNode;
  busy?: boolean;
  signInLabel: string;
  onLogin?: () => void;
  onLogout?: () => void;
}) {
  return (
    <div className="profile-account__card">
      <div className="profile-account__identity">
        <span
          className={`profile-account__mark${signedIn ? " is-online" : ""}`}
          aria-hidden
        >
          {logo}
        </span>
        <div className="profile-account__copy">
          <div className="profile-account__name">{providerName}</div>
          <div className="profile-account__meta">{meta}</div>
        </div>
      </div>
      <div className="profile-account__actions">
        {signedIn ? (
          onLogout ? (
            <button
              type="button"
              className="profile-btn profile-btn--ghost"
              disabled={busy}
              onClick={onLogout}
            >
              {busy ? "Signing out…" : "Sign out"}
            </button>
          ) : null
        ) : onLogin ? (
          <button
            type="button"
            className="profile-btn profile-btn--primary"
            disabled={busy}
            onClick={onLogin}
          >
            {busy ? "Signing in…" : signInLabel}
          </button>
        ) : null}
      </div>
    </div>
  );
});

function BackIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M15 6 9 12l6 6"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M6 6l12 12M18 6 6 18"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
    </svg>
  );
}

function RefreshIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M20 11a8 8 0 1 0-2.34 5.66M20 4v7h-7"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function CameraIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M4 8.5A2.5 2.5 0 0 1 6.5 6h1.2l1.1-1.6A1.5 1.5 0 0 1 10 3.5h4a1.5 1.5 0 0 1 1.2.9L16.3 6h1.2A2.5 2.5 0 0 1 20 8.5v9A2.5 2.5 0 0 1 17.5 20h-11A2.5 2.5 0 0 1 4 17.5v-9Z"
        stroke="currentColor"
        strokeWidth="1.6"
      />
      <circle cx="12" cy="13" r="3.2" stroke="currentColor" strokeWidth="1.6" />
    </svg>
  );
}

function EditIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M4 20h4l10.5-10.5a1.5 1.5 0 0 0 0-2.12L16.62 5.5a1.5 1.5 0 0 0-2.12 0L4 16v4Z"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
    </svg>
  );
}
