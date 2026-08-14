export type SidebarStageBackdropVariant = "beta" | "dev" | "official";
export type EnvironmentIdentificationPillLabel = "Dev" | "Beta" | "Official";

export function resolveSidebarStageBackdropVariant(
  stageLabel: string | null | undefined,
  enabled = true,
): SidebarStageBackdropVariant | null {
  if (!enabled) return null;
  const normalized = (stageLabel ?? "").trim().toLowerCase();
  if (normalized === "beta" || normalized === "nightly") return "beta";
  if (normalized === "dev") return "dev";
  if (normalized === "official" || normalized === "latest") return "official";
  return null;
}

export function resolveEnvironmentIdentificationPillLabel(
  stageLabel: string | null | undefined,
): EnvironmentIdentificationPillLabel | null {
  const normalized = (stageLabel ?? "").trim().toLowerCase();
  if (normalized === "dev") return "Dev";
  if (normalized === "beta" || normalized === "nightly") return "Beta";
  if (normalized === "official" || normalized === "latest") return "Official";
  return null;
}
