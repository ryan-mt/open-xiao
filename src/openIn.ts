import { invoke } from "@tauri-apps/api/core";
import { isTauri } from "./lib/isTauri";

export type OpenInTarget = "explorer" | "terminal" | "gitBash" | "wsl";

export type OpenInOption = {
  id: OpenInTarget;
  label: string;
  available: boolean;
};

export type OpenInOptions = {
  path: string;
  options: OpenInOption[];
};

const FALLBACK_OPTIONS: OpenInOption[] = [
  { id: "explorer", label: "File Explorer", available: false },
  { id: "terminal", label: "Terminal", available: false },
  { id: "gitBash", label: "Git Bash", available: false },
  { id: "wsl", label: "WSL", available: false },
];

export async function fetchOpenInOptions(
  path: string,
): Promise<OpenInOptions> {
  if (!isTauri() || !path.trim()) {
    return { path, options: FALLBACK_OPTIONS };
  }
  return invoke<OpenInOptions>("project_open_in_options", { path });
}

export async function openProjectIn(
  path: string,
  target: OpenInTarget,
): Promise<void> {
  if (!isTauri()) {
    throw new Error("Open in requires the desktop app");
  }
  await invoke("project_open_in", { path, target });
}
