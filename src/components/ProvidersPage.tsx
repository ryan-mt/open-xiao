import { memo, useEffect, useMemo, useState } from "react";
import {
  ArrowLeft,
  ArrowUpCircle,
  ChevronDown,
  Minus,
  RefreshCw,
  X,
} from "lucide-react";
import type { AuthStatus, OpenAIAuthStatus } from "../auth";
import type { AntigravityStatus } from "../antigravity";
import {
  OPENCODE_HEALTH_INTERVALS,
  type OpenCodeStatus,
} from "../opencode";
import { AntigravityLogo } from "./AntigravityLogo";
import { GrokLogo } from "./GrokLogo";
import { OpenAILogo } from "./OpenAILogo";
import { OpenCodeLogo } from "./OpenCodeLogo";
import "./ProvidersPage.css";

type Props = {
  open: boolean;
  grokAuth: AuthStatus;
  openaiAuth: OpenAIAuthStatus;
  antigravityStatus: AntigravityStatus;
  antigravityEnabled: boolean;
  openCodeStatus: OpenCodeStatus;
  openCodeEnabled: boolean;
  healthInterval: number;
  checking: boolean;
  updating: boolean;
  error: string | null;
  onClose: () => void;
  onRefresh: () => void;
  onUpdate: () => void;
  onAntigravityEnabledChange: (enabled: boolean) => void;
  onOpenCodeEnabledChange: (enabled: boolean) => void;
  onHealthIntervalChange: (seconds: number) => void;
};

const REDACTED_TEXT_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";

function redactedPlaceholder(value: string): string {
  let state = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    state ^= value.charCodeAt(index);
    state = Math.imul(state, 0x01000193);
  }

  const nextChar = () => {
    state = Math.imul(state ^ (state >>> 13), 0x85ebca6b);
    state = Math.imul(state ^ (state >>> 16), 0xc2b2ae35);
    return REDACTED_TEXT_ALPHABET[Math.abs(state) % REDACTED_TEXT_ALPHABET.length] ?? "x";
  };

  return Array.from(value, (character) => {
    if (character === "@" || character === "." || character === "-" || character === "_") {
      return character;
    }
    return nextChar();
  }).join("");
}

function checkedLabel(checkedAt: number): string {
  if (!checkedAt) return "Not checked yet";
  const elapsed = Math.max(0, Date.now() - checkedAt);
  if (elapsed < 60_000) return "Checked just now";
  const minutes = Math.floor(elapsed / 60_000);
  return `Checked ${minutes}m ago`;
}

function StatusDot({ ready }: { ready: boolean }) {
  return <span className={`providers-page__dot${ready ? " is-ready" : ""}`} />;
}

export const ProvidersPage = memo(function ProvidersPage({
  open,
  grokAuth,
  openaiAuth,
  antigravityStatus,
  antigravityEnabled,
  openCodeStatus,
  openCodeEnabled,
  healthInterval,
  checking,
  updating,
  error,
  onClose,
  onRefresh,
  onUpdate,
  onAntigravityEnabledChange,
  onOpenCodeEnabledChange,
  onHealthIntervalChange,
}: Props) {
  const [antigravityDetails, setAntigravityDetails] = useState(false);
  const [openCodeDetails, setOpenCodeDetails] = useState(false);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose, open]);

  if (!open) return null;

  const intervalIndex = Math.max(
    0,
    OPENCODE_HEALTH_INTERVALS.indexOf(
      healthInterval as (typeof OPENCODE_HEALTH_INTERVALS)[number],
    ),
  );
  const changeInterval = (offset: number) => {
    const next = Math.min(
      OPENCODE_HEALTH_INTERVALS.length - 1,
      Math.max(0, intervalIndex + offset),
    );
    onHealthIntervalChange(OPENCODE_HEALTH_INTERVALS[next]);
  };
  const openCodeReady = openCodeEnabled && openCodeStatus.ready;
  const antigravityReady = antigravityEnabled && antigravityStatus.ready;
  const antigravitySummary = !antigravityEnabled
    ? "Disabled"
    : antigravityReady
      ? `${antigravityStatus.models.length} models available`
      : antigravityStatus.message;
  const openCodeSummary = !openCodeEnabled
    ? "Disabled"
    : openCodeReady
      ? `${openCodeStatus.connectedProviders.length} connected providers · ${openCodeStatus.models.length} models available`
      : openCodeStatus.message;

  return (
    <div className="providers-page" role="dialog" aria-modal="true" aria-label="Providers">
      <header className="providers-page__topbar">
        <button type="button" className="providers-page__back" onClick={onClose}>
          <ArrowLeft size={16} />
          <span>Back</span>
        </button>
        <span className="providers-page__topbar-title">Providers</span>
        <button type="button" className="providers-page__close" onClick={onClose} aria-label="Close providers">
          <X size={17} />
        </button>
      </header>

      <main className="providers-page__canvas">
        <section className="providers-page__section" aria-labelledby="providers-page-heading">
          <div className="providers-page__section-header">
            <h1 id="providers-page-heading">Providers</h1>
            <div className="providers-page__refresh-status">
              <span>{checkedLabel(Math.max(openCodeStatus.checkedAt, antigravityStatus.checkedAt))}</span>
              <button
                type="button"
                className="providers-page__icon-button"
                onClick={onRefresh}
                disabled={checking}
                aria-label="Refresh provider status"
              >
                <RefreshCw size={14} className={checking ? "is-spinning" : ""} />
              </button>
            </div>
          </div>

          <div className="providers-page__rows">
            <div className="providers-page__settings-row">
              <div className="providers-page__settings-copy">
                <h2>Health check interval</h2>
                <p>
                  Refresh provider availability, versions, auth state, and model metadata in the background.
                  Set this to 0 seconds to rely on manual refreshes.
                </p>
              </div>
              <div className="providers-page__health-control">
                <div className="providers-page__stepper">
                  <button type="button" onClick={() => changeInterval(-1)} disabled={intervalIndex === 0} aria-label="Decrease provider health check interval">
                    <Minus size={13} />
                  </button>
                  <output aria-label="Provider health check interval in seconds">{healthInterval}</output>
                  <button type="button" onClick={() => changeInterval(1)} disabled={intervalIndex === OPENCODE_HEALTH_INTERVALS.length - 1} aria-label="Increase provider health check interval">+</button>
                </div>
                <span>seconds</span>
              </div>
            </div>

            {error ? <div className="providers-page__error" role="alert">{error}</div> : null}

            <ProviderRow
              icon={<GrokLogo size={20} />}
              name="Grok"
              ready={grokAuth.signedIn}
              summary={grokAuth.signedIn ? `Signed in${grokAuth.email ? ` as ${grokAuth.email}` : ""}` : "Sign in with SuperGrok to use Grok models."}
            />
            <ProviderRow
              icon={<OpenAILogo size={20} />}
              name="OpenAI"
              ready={openaiAuth.signedIn}
              summary={
                openaiAuth.signedIn
                  ? openaiAuth.email
                    ? <>Signed in as <RedactedEmail value={openaiAuth.email} /></>
                    : "Signed in"
                  : "Sign in with OpenAI to use GPT models."
              }
            />

            <article className="providers-page__provider">
              <div className="providers-page__provider-row">
                <div className="providers-page__provider-main">
                  <div className="providers-page__provider-icon">
                    <AntigravityLogo size={18} />
                    <StatusDot ready={antigravityReady} />
                  </div>
                  <div className="providers-page__provider-copy">
                    <div className="providers-page__provider-title">
                      <strong>Antigravity</strong>
                      {antigravityStatus.version ? <code>v{antigravityStatus.version}</code> : null}
                    </div>
                    <p>{antigravitySummary}</p>
                  </div>
                </div>
                <div className="providers-page__provider-actions">
                  <button
                    type="button"
                    className="providers-page__details-button"
                    onClick={() => setAntigravityDetails((value) => !value)}
                    aria-expanded={antigravityDetails}
                    aria-controls="antigravity-provider-details"
                    aria-label="Toggle Antigravity details"
                  >
                    <ChevronDown size={14} className={antigravityDetails ? "is-open" : ""} />
                  </button>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={antigravityEnabled}
                    className={`providers-page__switch${antigravityEnabled ? " is-on" : ""}`}
                    onClick={() => onAntigravityEnabledChange(!antigravityEnabled)}
                    aria-label={`${antigravityEnabled ? "Disable" : "Enable"} Antigravity`}
                  ><span /></button>
                </div>
              </div>

              {antigravityDetails ? (
                <div className="providers-page__provider-details" id="antigravity-provider-details">
                  <div>
                    <span>Models</span>
                    <p>{antigravityStatus.models.length} available in the model picker</p>
                  </div>
                  <p className="providers-page__credential-note">
                    Credentials remain in Google Antigravity CLI. Xiao wraps its supported headless JSON stream and conversation resume contract.
                  </p>
                  <p className="providers-page__credential-note">
                    Auto and Plan modes are supported. Ask mode is unavailable because the CLI cannot relay interactive approvals in headless mode.
                  </p>
                  <p className="providers-page__credential-note">
                    Workspace access enables the Antigravity terminal sandbox; Full access still keeps Antigravity's hard security boundaries.
                  </p>
                </div>
              ) : null}
            </article>

            <article className="providers-page__provider">
              <div className="providers-page__provider-row">
                <div className="providers-page__provider-main">
                  <div className="providers-page__provider-icon">
                    <OpenCodeLogo size={18} />
                    <StatusDot ready={openCodeReady} />
                  </div>
                  <div className="providers-page__provider-copy">
                    <div className="providers-page__provider-title">
                      <strong>OpenCode</strong>
                      {openCodeStatus.version ? <code>v{openCodeStatus.version}</code> : null}
                      {openCodeStatus.updateAvailable ? (
                        <button type="button" className="providers-page__update-indicator" onClick={onUpdate} disabled={updating} aria-label="Update OpenCode">
                          {updating ? <RefreshCw size={13} className="is-spinning" /> : <ArrowUpCircle size={13} />}
                        </button>
                      ) : null}
                    </div>
                    <p>{openCodeSummary}</p>
                  </div>
                </div>
                <div className="providers-page__provider-actions">
                  <button
                    type="button"
                    className="providers-page__details-button"
                    onClick={() => setOpenCodeDetails((value) => !value)}
                    aria-expanded={openCodeDetails}
                    aria-controls="opencode-provider-details"
                    aria-label="Toggle OpenCode details"
                  >
                    <ChevronDown size={14} className={openCodeDetails ? "is-open" : ""} />
                  </button>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={openCodeEnabled}
                    className={`providers-page__switch${openCodeEnabled ? " is-on" : ""}`}
                    onClick={() => onOpenCodeEnabledChange(!openCodeEnabled)}
                    aria-label={`${openCodeEnabled ? "Disable" : "Enable"} OpenCode`}
                  ><span /></button>
                </div>
              </div>

              {openCodeDetails ? (
                <div className="providers-page__provider-details" id="opencode-provider-details">
                  <div>
                    <span>Connected providers</span>
                    <p>{openCodeStatus.connectedProviders.length > 0 ? openCodeStatus.connectedProviders.join(", ") : "None reported"}</p>
                  </div>
                  <div>
                    <span>Models</span>
                    <p>{openCodeStatus.models.length} available in the model picker</p>
                  </div>
                  <p className="providers-page__credential-note">
                    Credentials remain in OpenCode. Open Xiao reads the provider and model metadata it reports.
                  </p>
                  {openCodeStatus.updateAvailable ? (
                    <button type="button" className="providers-page__update" onClick={onUpdate} disabled={updating}>
                      {updating ? <RefreshCw size={13} className="is-spinning" /> : <ArrowUpCircle size={13} />}
                      {updating ? "Updating…" : openCodeStatus.latestVersion ? `Update to ${openCodeStatus.latestVersion}` : "Update OpenCode"}
                    </button>
                  ) : null}
                </div>
              ) : null}
            </article>
          </div>
        </section>
      </main>
    </div>
  );
});

function ProviderRow({
  icon,
  name,
  ready,
  summary,
}: {
  icon: React.ReactNode;
  name: string;
  ready: boolean;
  summary: React.ReactNode;
}) {
  return (
    <article className="providers-page__provider">
      <div className="providers-page__provider-row">
        <div className="providers-page__provider-main">
          <div className="providers-page__provider-icon">
            {icon}
            <StatusDot ready={ready} />
          </div>
          <div className="providers-page__provider-copy">
            <div className="providers-page__provider-title"><strong>{name}</strong></div>
            <p>{summary}</p>
          </div>
        </div>
        <span className="providers-page__provider-meta">Xiao runtime</span>
      </div>
    </article>
  );
}

function RedactedEmail({ value }: { value: string }) {
  const [revealed, setRevealed] = useState(false);
  const redacted = useMemo(() => redactedPlaceholder(value), [value]);

  return (
    <button
      type="button"
      className={`providers-page__redacted-email${revealed ? " is-revealed" : " is-redacted"}`}
      onClick={() => setRevealed((current) => !current)}
      aria-label="Toggle OpenAI account email visibility"
      title={revealed ? "Hide email" : "Click to reveal email"}
    >
      {revealed ? value : redacted}
    </button>
  );
}

export function OpenCodeUpdateNotice({
  version,
  updating,
  onUpdate,
  onOpen,
  onDismiss,
}: {
  version: string;
  updating: boolean;
  onUpdate: () => void;
  onOpen: () => void;
  onDismiss: () => void;
}) {
  return (
    <aside className="opencode-update-notice" role="status" aria-live="polite">
      <div className="opencode-update-notice__mark"><OpenCodeLogo size={16} /></div>
      <button type="button" className="opencode-update-notice__copy" onClick={onOpen}>
        <strong>OpenCode {version} is available</strong>
        <span>Update OpenCode, then refresh its connected models.</span>
      </button>
      <button type="button" className="opencode-update-notice__action" onClick={onUpdate} disabled={updating}>
        {updating ? "Updating…" : "Update"}
      </button>
      <button type="button" className="opencode-update-notice__dismiss" onClick={onDismiss} aria-label="Dismiss OpenCode update"><X size={14} /></button>
    </aside>
  );
}
