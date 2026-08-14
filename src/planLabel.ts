/** Normalize xAI / Grok subscription labels for UI. */
export function formatPlanLabel(plan?: string | null): string {
  if (!plan?.trim()) return "Free";
  const raw = plan.trim();
  const lower = raw.toLowerCase().replace(/[_-]+/g, " ");
  const compact = lower.replace(/\s+/g, "");

  if (
    compact.includes("supergrokheavy") ||
    compact.includes("grokheavy") ||
    compact.includes("supergrokpro") ||
    (compact.includes("heavy") && compact.includes("supergrok")) ||
    compact === "heavy"
  ) {
    return "SuperGrok Heavy";
  }
  if (compact.includes("supergroklite")) {
    return "SuperGrok Lite";
  }
  if (compact.includes("supergrok") || compact === "groksuper") {
    return "SuperGrok";
  }
  if (
    compact.includes("xpremium") ||
    compact.includes("premiumplus") ||
    lower.includes("x premium")
  ) {
    return "X Premium";
  }
  if (compact.includes("premium")) return "Premium";
  if (compact.includes("pro") && !compact.includes("project")) return "Pro";
  if (compact.includes("free") || compact.includes("basic")) return "Free";

  return raw
    .split(/[\s_-]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ")
    .replace(/Supergrok/gi, "SuperGrok");
}
