import { invoke } from "@tauri-apps/api/core";
import type { Model, ThinkingLevel } from "./models";
import { isTauri } from "./lib/isTauri";

export type OpenCodeModel = {
  id: string;
  name: string;
  upstreamProvider: string;
  upstreamProviderName: string;
  contextWindow: number | null;
  variants: ThinkingLevel[];
};

export type OpenCodeStatus = {
  installed: boolean;
  ready: boolean;
  version: string | null;
  latestVersion: string | null;
  updateAvailable: boolean;
  connectedProviders: string[];
  models: OpenCodeModel[];
  checkedAt: number;
  message: string;
};

export type OpenCodeUpdateResult = {
  status: OpenCodeStatus;
  output: string;
};

export const EMPTY_OPENCODE_STATUS: OpenCodeStatus = {
  installed: false,
  ready: false,
  version: null,
  latestVersion: null,
  updateAvailable: false,
  connectedProviders: [],
  models: [],
  checkedAt: 0,
  message: "OpenCode has not been checked yet.",
};

export function isOpenCodeReadyForWorkspace(
  enabled: boolean,
  status: OpenCodeStatus,
  statusWorkspacePath: string | null,
  workspacePath: string | null,
  modelId?: string,
): boolean {
  return (
    enabled &&
    workspacePath !== null &&
    status.checkedAt > 0 &&
    status.ready &&
    statusWorkspacePath === workspacePath &&
    (modelId == null ||
      status.models.some((model) => `opencode::${model.id}` === modelId))
  );
}

export async function getOpenCodeStatus(
  projectPath?: string | null,
): Promise<OpenCodeStatus> {
  if (!isTauri()) return EMPTY_OPENCODE_STATUS;
  return invoke<OpenCodeStatus>("opencode_status", {
    projectPath: projectPath ?? null,
  });
}

export async function updateOpenCode(
  projectPath?: string | null,
): Promise<OpenCodeUpdateResult> {
  if (!isTauri()) {
    throw new Error("OpenCode update requires the desktop app.");
  }
  return invoke<OpenCodeUpdateResult>("opencode_update", {
    projectPath: projectPath ?? null,
  });
}

function compactContext(value: number | null): string {
  if (!value || value <= 0) return "—";
  if (value >= 1_000_000 && value % 1_000_000 === 0) {
    return `${value / 1_000_000}M`;
  }
  if (value >= 1_000) return `${Math.round(value / 1_000)}k`;
  return String(value);
}

export function openCodeModelsForCatalog(models: OpenCodeModel[]): Model[] {
  return models.map((model) => {
    const supportedThinking = model.variants.length > 0 ? model.variants : (["off"] as ThinkingLevel[]);
    const defaultThinking = supportedThinking.includes("medium")
      ? "medium"
      : supportedThinking.includes("high")
        ? "high"
        : supportedThinking[0];
    return {
      id: `opencode::${model.id}`,
      label: model.name,
      description: `${model.upstreamProviderName} via OpenCode`,
      provider: "opencode",
      subProvider: model.upstreamProviderName,
      thinking: supportedThinking.some((level) => level !== "off"),
      defaultThinking,
      supportedThinking,
      context: compactContext(model.contextWindow),
    };
  });
}

const ENABLED_KEY = "open-xiao:opencode-enabled";
const HEALTH_INTERVAL_KEY = "open-xiao:opencode-health-interval";
export const OPENCODE_HEALTH_INTERVALS = [0, 60, 300, 900, 1800] as const;

export function normalizeOpenCodeHealthInterval(value: unknown): number {
  return typeof value === "number" &&
    OPENCODE_HEALTH_INTERVALS.includes(
      value as (typeof OPENCODE_HEALTH_INTERVALS)[number],
    )
    ? value
    : 300;
}

export function loadOpenCodeEnabled(): boolean {
  try {
    return localStorage.getItem(ENABLED_KEY) !== "false";
  } catch {
    return true;
  }
}

export function saveOpenCodeEnabled(enabled: boolean): void {
  try {
    localStorage.setItem(ENABLED_KEY, String(enabled));
  } catch {
    // Persistence is best effort; the current app session still updates.
  }
}

export function loadOpenCodeHealthInterval(): number {
  try {
    const raw = localStorage.getItem(HEALTH_INTERVAL_KEY);
    if (raw == null) return 300;
    return normalizeOpenCodeHealthInterval(Number(raw));
  } catch {
    return 300;
  }
}

export function saveOpenCodeHealthInterval(seconds: number): void {
  try {
    localStorage.setItem(
      HEALTH_INTERVAL_KEY,
      String(normalizeOpenCodeHealthInterval(seconds)),
    );
  } catch {
    // Persistence is best effort; the current app session still updates.
  }
}
