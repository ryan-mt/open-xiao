import { invoke } from "@tauri-apps/api/core";
import { isTauri } from "./lib/isTauri";
import type { Model } from "./models";

export type AntigravityModel = {
  id: string;
  name: string;
};

export type AntigravityStatus = {
  installed: boolean;
  ready: boolean;
  version: string | null;
  models: AntigravityModel[];
  checkedAt: number;
  message: string;
};

export const EMPTY_ANTIGRAVITY_STATUS: AntigravityStatus = {
  installed: false,
  ready: false,
  version: null,
  models: [],
  checkedAt: 0,
  message: "Antigravity has not been checked yet.",
};

export async function getAntigravityStatus(): Promise<AntigravityStatus> {
  if (!isTauri()) return EMPTY_ANTIGRAVITY_STATUS;
  return invoke<AntigravityStatus>("antigravity_status");
}

export function antigravityModelsForCatalog(
  models: AntigravityModel[],
): Model[] {
  return models.map((model) => {
    const latestFlash = /^gemini-3\.7-flash-(?:low|medium|high)$/.test(
      model.id,
    );
    return {
      id: `antigravity::${model.id}`,
      label: model.name,
      description: "Google Antigravity CLI",
      provider: "antigravity",
      thinking: false,
      defaultThinking: "off",
      supportedThinking: ["off"],
      context: "—",
      badge: latestFlash ? "New" : undefined,
    };
  });
}

const ENABLED_KEY = "open-xiao:antigravity-enabled";

export function loadAntigravityEnabled(): boolean {
  try {
    return localStorage.getItem(ENABLED_KEY) === "true";
  } catch {
    return false;
  }
}

export function saveAntigravityEnabled(enabled: boolean): void {
  try {
    localStorage.setItem(ENABLED_KEY, String(enabled));
  } catch {
    // Persistence is best effort; the current app session still updates.
  }
}
