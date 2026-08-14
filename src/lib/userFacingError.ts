export type ErrorProvider = "grok" | "openai" | "antigravity" | "opencode";

export type UserFacingErrorCategory =
  | "auth"
  | "quota"
  | "rate-limit"
  | "connectivity"
  | "cancellation"
  | "permission"
  | "workspace"
  | "generic";

export type UserFacingError = {
  category: UserFacingErrorCategory;
  title: string;
  message: string;
  retryable: boolean;
  action: "settings" | null;
  provider?: ErrorProvider;
  /** Provider-supplied reason, kept separate so the canned message stays stable. */
  detail?: string | null;
};

type NormalizeOptions = {
  provider?: ErrorProvider;
  fallbackTitle?: string;
  fallbackMessage?: string;
};

export function redactSensitiveValues(value: string): string {
  let text = value;
  text = text.replace(
    /-----BEGIN [^-]+PRIVATE KEY-----[\s\S]*?-----END [^-]+PRIVATE KEY-----/gi,
    "[REDACTED PRIVATE KEY]",
  );
  text = text.replace(
    /\b(?:bearer|basic)\s+[a-z0-9._~+/-]+=*/gi,
    "[REDACTED AUTH]",
  );
  text = text.replace(
    /\b(?:sk-|ghp_|github_pat_)[a-z0-9._~+/-]{12,}=*/gi,
    "[REDACTED TOKEN]",
  );
  text = text.replace(
    /\beyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{8,}\b/g,
    "[REDACTED TOKEN]",
  );
  text = text.replace(
    /(["']?(?:[a-z0-9]+[_-])*(?:access[_-]?token|refresh[_-]?token|id[_-]?token|api[_-]?key|client[_-]?secret|token|secret|signature|password|cookie|authorization)["']?\s*[:=]\s*)["']?[^"',\s}]+/gi,
    "$1[REDACTED]",
  );
  text = text.replace(
    /([?&](?:token|key|api_key|access_token|refresh_token|id_token|code|secret|signature)=)[^&#\s]+/gi,
    "$1[REDACTED]",
  );
  return text;
}

export function redactSensitiveText(value: string, maxLength = 600): string {
  const text = redactSensitiveValues(value);
  if (text.length > maxLength) {
    return `${text.slice(0, maxLength).trimEnd()}…`;
  }
  return text;
}

const CATEGORIES = new Set<UserFacingErrorCategory>([
  "auth",
  "quota",
  "rate-limit",
  "connectivity",
  "cancellation",
  "permission",
  "workspace",
  "generic",
]);

function collectSignal(value: unknown, depth = 0): string {
  if (depth > 2 || value == null) return "";
  if (typeof value === "string") return value.slice(0, 8_000);
  if (value instanceof Error) {
    return [value.name, value.message].filter(Boolean).join(" ");
  }
  if (typeof value !== "object") return String(value);

  const record = value as Record<string, unknown>;
  return [
    record.name,
    record.code,
    record.status,
    record.statusText,
    record.message,
    record.error,
    record.error_description,
    record.cause,
  ]
    .map((part) => collectSignal(part, depth + 1))
    .filter(Boolean)
    .join(" ")
    .slice(0, 8_000);
}

function classify(signal: string): UserFacingErrorCategory {
  const text = signal.toLowerCase();
  if (
    /\babort(?:ed)?\b|\bcancel(?:led|ed)?\b|access_denied|(?:oauth|sign[- ]?in|authori[sz]ation)(?: [a-z]+){0,2} denied/.test(
      text,
    )
  ) {
    return "cancellation";
  }
  if (
    /\b402\b|quota|credit|spending[-_ ]limit|usage limit|billing|subscription|plan limit|insufficient[_ -]funds/.test(
      text,
    )
  ) {
    return "quota";
  }
  if (/\b429\b|rate[-_ ]limit|too many requests|resource exhausted/.test(text)) {
    return "rate-limit";
  }
  if (
    /\b401\b|unauthori[sz]ed|unauthenticated|not signed in|sign in again|session expired|token expired|invalid[_ -]grant/.test(
      text,
    )
  ) {
    return "auth";
  }
  if (
    /\b403\b|\bdenied\b|permission denied|access denied|forbidden|approval denied|not approved|not allowed (?:with|under) (?:the )?(?:current )?permissions/.test(
      text,
    )
  ) {
    return "permission";
  }
  if (
    /workspace|project root|outside (?:the )?(?:project|workspace)|path escapes|missing parent project|directory unavailable/.test(
      text,
    )
  ) {
    return "workspace";
  }
  if (
    /\b408\b|\b5\d\d\b|timeout|timed out|network|dns|socket|connection|fetch failed|error sending request|stream stalled|connection reset|broken pipe/.test(
      text,
    )
  ) {
    return "connectivity";
  }
  return "generic";
}

function providerName(provider?: ErrorProvider): string {
  return provider === "openai"
    ? "OpenAI"
    : provider === "grok"
      ? "Grok"
      : provider === "antigravity"
        ? "Antigravity"
      : provider === "opencode"
        ? "OpenCode"
        : "The provider";
}

export function createUserFacingError(
  category: UserFacingErrorCategory,
  options: NormalizeOptions = {},
): UserFacingError {
  const { provider, fallbackTitle, fallbackMessage } = options;
  const name = providerName(provider);
  switch (category) {
    case "auth":
      return {
        category,
        title: "Sign in required",
        message: `${name} session is no longer valid. Sign in again from Settings.`,
        retryable: false,
        action: "settings",
        provider,
      };
    case "quota":
      return {
        category,
        title: "Usage limit reached",
        message: `${name} reported a usage limit. Check the account's plan or usage with the provider, or switch to another provider.`,
        retryable: false,
        action: null,
        provider,
      };
    case "rate-limit":
      return {
        category,
        title: "Too many requests",
        message: "The provider is receiving too many requests. Wait a moment, then retry.",
        retryable: true,
        action: null,
        provider,
      };
    case "connectivity":
      return {
        category,
        title: "Connection interrupted",
        message: "The response was interrupted. Check the connection and try again.",
        retryable: true,
        action: null,
        provider,
      };
    case "permission":
      return {
        category,
        title: "Permission needed",
        message:
          "The requested action is not allowed. Review Access and Permissions below the composer.",
        retryable: false,
        action: null,
        provider,
      };
    case "workspace":
      return {
        category,
        title: "Workspace unavailable",
        message: "Open a valid project folder and try the request again.",
        retryable: false,
        action: null,
        provider,
      };
    case "cancellation":
      return {
        category,
        title: "Cancelled",
        message: "The request was cancelled.",
        retryable: false,
        action: null,
        provider,
      };
    default:
      return {
        category: "generic",
        title: fallbackTitle ?? "Request could not finish",
        message:
          fallbackMessage ??
          "Open Xiao could not complete this action. Try again in a moment.",
        retryable: true,
        action: null,
        provider,
      };
  }
}

const PROVIDER_DETAIL_MARKER = "Provider said: ";

function extractProviderDetail(signal: string): string | null {
  const index = signal.lastIndexOf(PROVIDER_DETAIL_MARKER);
  if (index === -1) return null;
  const remainder = signal
    .slice(index + PROVIDER_DETAIL_MARKER.length)
    .replace(/\r\n/g, "\n");
  const boundary = ["\nPartial report:", "\nProcessed child tools:"]
    .map((marker) => remainder.indexOf(marker))
    .filter((position) => position >= 0)
    .reduce((earliest, position) => Math.min(earliest, position), remainder.length);
  const detail = remainder.slice(0, boundary).trim();
  return detail || null;
}

export function normalizeUserFacingError(
  error: unknown,
  options: NormalizeOptions = {},
): UserFacingError {
  const signal = collectSignal(error);
  return {
    ...createUserFacingError(classify(signal), options),
    detail: extractProviderDetail(signal),
  };
}

export type TaskFailurePresentation = {
  title: string;
  message: string;
  detail: string;
  partialReport: string;
};

const PARTIAL_FAILURE_PREFIX = "Subagent stopped after partial progress: ";
const PARTIAL_REPORT_MARKER = "\nPartial report:\n";
const PROCESSED_TOOLS_MARKER = "\nProcessed child tools:";

function splitPartialTaskFailure(raw: string): {
  cause: string;
  partialReport: string;
} {
  const normalized = raw.replace(/\r\n/g, "\n").trim();
  const body = normalized.startsWith(PARTIAL_FAILURE_PREFIX)
    ? normalized.slice(PARTIAL_FAILURE_PREFIX.length)
    : normalized;
  const reportIndex = body.indexOf(PARTIAL_REPORT_MARKER);
  const toolsIndex = body.lastIndexOf(PROCESSED_TOOLS_MARKER);
  const causeEnd = [reportIndex, toolsIndex]
    .filter((index) => index >= 0)
    .reduce((earliest, index) => Math.min(earliest, index), body.length);
  const cause = body.slice(0, causeEnd).trim();
  if (reportIndex < 0) return { cause, partialReport: "" };

  const reportStart = reportIndex + PARTIAL_REPORT_MARKER.length;
  const reportEnd = toolsIndex > reportStart ? toolsIndex : body.length;
  return {
    cause,
    partialReport: body.slice(reportStart, reportEnd).trim(),
  };
}

export function presentTaskFailure(raw: string): TaskFailurePresentation {
  const { cause, partialReport } = splitPartialTaskFailure(raw);
  const error = normalizeUserFacingError(cause || raw, {
    fallbackTitle: "Subagent could not finish",
    fallbackMessage: "The delegated task stopped before it finished.",
  });
  return {
    title: error.title,
    message: error.message,
    detail: error.detail ? redactSensitiveText(error.detail, 1_000) : "",
    partialReport: partialReport
      ? redactSensitiveText(partialReport, 12_000)
      : "",
  };
}

export function normalizeCodexUsageError(error: unknown): UserFacingError {
  const normalized = normalizeUserFacingError(error, {
    provider: "openai",
    fallbackTitle: "Usage unavailable",
    fallbackMessage: "Could not load Codex usage right now.",
  });
  if (normalized.category !== "permission") return normalized;
  return {
    ...normalized,
    title: "Codex access unavailable",
    message:
      "This OpenAI account cannot access Codex usage data. Check the account's Codex access or sign in with another account.",
  };
}

export function normalizeStoredError(
  value: unknown,
  provider?: ErrorProvider,
): UserFacingError | null {
  if (!value) return null;
  if (typeof value === "object") {
    const category = (value as { category?: unknown }).category;
    if (typeof category === "string" && CATEGORIES.has(category as UserFacingErrorCategory)) {
      const storedProvider = (value as { provider?: unknown }).provider;
      const storedDetail = (value as { detail?: unknown }).detail;
      return {
        ...createUserFacingError(category as UserFacingErrorCategory, {
          provider:
            storedProvider === "grok" ||
            storedProvider === "openai" ||
            storedProvider === "antigravity" ||
            storedProvider === "opencode"
              ? storedProvider
              : provider,
        }),
        detail:
          typeof storedDetail === "string" && storedDetail.trim().length > 0
            ? storedDetail
            : null,
      };
    }
  }
  return normalizeUserFacingError(value, { provider });
}

export function safeErrorMessage(
  error: unknown,
  fallbackMessage: string,
): string {
  return normalizeUserFacingError(error, {
    fallbackMessage,
  }).message;
}
