/** Parse a JSON object string; empty/invalid input yields `{}`. */
export function parseJsonObject(args: string): Record<string, unknown> {
  try {
    const o = JSON.parse(args || "{}");
    return o && typeof o === "object" && !Array.isArray(o)
      ? (o as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}
