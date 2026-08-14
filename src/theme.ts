export type ThemeMode =
  | "system"
  | "light"
  | "dark"
  | "mineral-paper"
  | "inkstone"
  | "ember-ledger"
  | "night-orchard"
  | "salt-lake"
  | "moss-negative"
  | "oxide-terminal"
  | "blue-hour"
  | "cinder-bloom"
  | "lichen-field"
  | "deep-sea-silt"
  | "clay-negative"
  | "sodium-vapor"
  | "aster-static"
  | "bog-copper"
  | "glacier-algae"
  | "petrol-bloom"
  | "chalk-plum"
  | "redshift-mono"
  | "brine-lilac"
  | "phosphor-dust";

export type ThemeAppearance = "system" | "light" | "dark";

export type ThemeDefinition = {
  id: ThemeMode;
  name: string;
  description: string;
  appearance: ThemeAppearance;
  preview: {
    background: string;
    surface: string;
    foreground: string;
    accent: string;
  };
};

export const THEME_CATALOG = [
  {
    id: "system",
    name: "System",
    description: "Moves with your desktop appearance.",
    appearance: "system",
    preview: { background: "#f4f4f5", surface: "#18181b", foreground: "#18181b", accent: "#a1a1aa" },
  },
  {
    id: "light",
    name: "Xiao Light",
    description: "Clean monochrome for bright workspaces.",
    appearance: "light",
    preview: { background: "#fafafa", surface: "#ffffff", foreground: "#18181b", accent: "#18181b" },
  },
  {
    id: "dark",
    name: "Xiao Dark",
    description: "T3-style graphite with a restrained blue signal.",
    appearance: "dark",
    preview: { background: "#0a0a0a", surface: "#151515", foreground: "#f5f5f5", accent: "oklch(0.588 0.217 264)" },
  },
  {
    id: "mineral-paper",
    name: "Mineral Paper",
    description: "Cool drafting paper with cobalt ink.",
    appearance: "light",
    preview: { background: "#edf1f2", surface: "#f8faf9", foreground: "#142024", accent: "#1849a9" },
  },
  {
    id: "inkstone",
    name: "Inkstone",
    description: "Soot black with a restrained celadon signal.",
    appearance: "dark",
    preview: { background: "#0e1413", surface: "#18201d", foreground: "#e5e9e3", accent: "#98c6ad" },
  },
  {
    id: "ember-ledger",
    name: "Ember Ledger",
    description: "Warm carbon with a persimmon command color.",
    appearance: "dark",
    preview: { background: "#171311", surface: "#231b18", foreground: "#f0e9e2", accent: "#df7956" },
  },
  {
    id: "night-orchard",
    name: "Night Orchard",
    description: "Green-black layers with a quince-gold signal.",
    appearance: "dark",
    preview: { background: "#0f150f", surface: "#192117", foreground: "#e5eadf", accent: "#d1b45f" },
  },
  {
    id: "salt-lake",
    name: "Salt Lake",
    description: "Bleached mineral flats with a saline blue trace.",
    appearance: "light",
    preview: { background: "#eef3f1", surface: "#fbfcf8", foreground: "#1d2928", accent: "#247b80" },
  },
  {
    id: "moss-negative",
    name: "Moss Negative",
    description: "Pale lichen stock with dark botanical ink.",
    appearance: "light",
    preview: { background: "#e8ebd9", surface: "#f5f5e9", foreground: "#20281c", accent: "#526f3a" },
  },
  {
    id: "oxide-terminal",
    name: "Oxide Terminal",
    description: "Iron-black machinery with a weathered aqua pulse.",
    appearance: "dark",
    preview: { background: "#151918", surface: "#202725", foreground: "#e4e8df", accent: "#62a69a" },
  },
  {
    id: "blue-hour",
    name: "Blue Hour",
    description: "Pre-dawn indigo with a cold horizon signal.",
    appearance: "dark",
    preview: { background: "#101522", surface: "#192236", foreground: "#e7eaf1", accent: "#7899c8" },
  },
  {
    id: "cinder-bloom",
    name: "Cinder Bloom",
    description: "Charred plum surfaces with a muted orchid flare.",
    appearance: "dark",
    preview: { background: "#191318", surface: "#271d25", foreground: "#eee6eb", accent: "#bd789c" },
  },
  {
    id: "lichen-field",
    name: "Lichen Field",
    description: "Dry stone daylight with an acid moss notation.",
    appearance: "light",
    preview: { background: "#ebede5", surface: "#f9faf4", foreground: "#242820", accent: "#70872d" },
  },
  {
    id: "deep-sea-silt",
    name: "Deep Sea Silt",
    description: "Abyssal teal sediment with a biolume marker.",
    appearance: "dark",
    preview: { background: "#091718", surface: "#112526", foreground: "#dcebea", accent: "#4fb7a8" },
  },
  {
    id: "clay-negative",
    name: "Clay Negative",
    description: "Cool ceramic slip with a fired-earth annotation.",
    appearance: "light",
    preview: { background: "#ece9e5", surface: "#faf8f5", foreground: "#2b2724", accent: "#a4513e" },
  },
  {
    id: "sodium-vapor",
    name: "Sodium Vapor",
    description: "Night concrete under a low-pressure amber lamp.",
    appearance: "dark",
    preview: { background: "#171612", surface: "#25231b", foreground: "#ebe7d8", accent: "#c99b32" },
  },
  {
    id: "aster-static",
    name: "Aster Static",
    description: "Storm-grey violet with a dusty floral frequency.",
    appearance: "dark",
    preview: { background: "#16151c", surface: "#23212c", foreground: "#e9e7ed", accent: "#9990bd" },
  },
  {
    id: "bog-copper",
    name: "Bog Copper",
    description: "Peat-dark green with an oxidized metal glint.",
    appearance: "dark",
    preview: { background: "#111714", surface: "#1d2621", foreground: "#e2e8e1", accent: "#b8754f" },
  },
  {
    id: "glacier-algae",
    name: "Glacier Algae",
    description: "Blue ice paper with a microscopic green signal.",
    appearance: "light",
    preview: { background: "#e7eff0", surface: "#f7fbfa", foreground: "#172a2d", accent: "#2d8a72" },
  },
  {
    id: "petrol-bloom",
    name: "Petrol Bloom",
    description: "Oil-slick navy with a restrained coral spark.",
    appearance: "dark",
    preview: { background: "#0d171c", surface: "#17262d", foreground: "#e1e9eb", accent: "#d4776a" },
  },
  {
    id: "chalk-plum",
    name: "Chalk Plum",
    description: "Powdered mauve stone with concentrated berry ink.",
    appearance: "light",
    preview: { background: "#eee9ed", surface: "#fbf8fa", foreground: "#2e252d", accent: "#874d76" },
  },
  {
    id: "redshift-mono",
    name: "Redshift Mono",
    description: "Graphite space with a dim astronomical red cue.",
    appearance: "dark",
    preview: { background: "#161415", surface: "#242021", foreground: "#ebe7e7", accent: "#bd6262" },
  },
  {
    id: "brine-lilac",
    name: "Brine Lilac",
    description: "Grey tidal paper with a mineral lilac notation.",
    appearance: "light",
    preview: { background: "#e9eaec", surface: "#f8f8fa", foreground: "#27272e", accent: "#716d9a" },
  },
  {
    id: "phosphor-dust",
    name: "Phosphor Dust",
    description: "Brown-black vacuum glass with a faded green readout.",
    appearance: "dark",
    preview: { background: "#151610", surface: "#22241a", foreground: "#e7eadc", accent: "#9eae61" },
  },
] as const satisfies readonly ThemeDefinition[];

const KEY = "grok-theme-v1";

export function isThemeMode(value: string | null): value is ThemeMode {
  return THEME_CATALOG.some((theme) => theme.id === value);
}

export function loadTheme(): ThemeMode {
  try {
    const value = localStorage.getItem(KEY);
    if (isThemeMode(value)) return value;
  } catch {
    /* ignore */
  }
  return "system";
}

export function saveTheme(mode: ThemeMode) {
  try {
    localStorage.setItem(KEY, mode);
  } catch {
    /* ignore */
  }
}

export function resolveTheme(mode: ThemeMode): "light" | "dark" {
  const definition = THEME_CATALOG.find((theme) => theme.id === mode);
  if (definition?.appearance === "light" || definition?.appearance === "dark") {
    return definition.appearance;
  }
  if (typeof window === "undefined") return "light";
  return window.matchMedia("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";
}

/** Apply the selected palette and its light/dark browser appearance. */
export function applyTheme(mode: ThemeMode): Promise<void> {
  const resolved = resolveTheme(mode);
  const appliedTheme = mode === "system" ? resolved : mode;
  const background =
    THEME_CATALOG.find((theme) => theme.id === appliedTheme)?.preview
      .background ?? (resolved === "dark" ? "#0a0a0a" : "#fafafa");
  const root = document.documentElement;
  root.classList.toggle("dark", resolved === "dark");
  root.dataset.theme = appliedTheme;
  root.style.colorScheme = resolved;
  root.style.background = background;
  return syncNativeChrome(mode, resolved, background);
}

/** Keep Windows/macOS title bar + window bg in sync with app theme. */
async function syncNativeChrome(
  mode: ThemeMode,
  resolved: "light" | "dark",
  background: string,
) {
  if (typeof window === "undefined" || !("__TAURI_INTERNALS__" in window)) {
    return;
  }
  try {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    const win = getCurrentWindow();
    await win.setTheme(mode === "system" ? null : resolved);
    await win.setBackgroundColor(background);
  } catch {
    /* browser / missing permission */
  }
}
