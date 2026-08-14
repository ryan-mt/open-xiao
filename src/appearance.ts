export type InterfaceFontId =
  | "system"
  | "segoe-ui"
  | "dm-sans"
  | "arial"
  | "georgia";

export type MonoFontId =
  | "system"
  | "consolas"
  | "cascadia-code"
  | "jetbrains-mono"
  | "sf-mono";

export type AppearancePreferences = {
  glassOpacity: number;
  interfaceFont: InterfaceFontId;
  interfaceSize: number;
  monoFont: MonoFontId;
  monoSize: number;
  advanced: boolean;
  promptFont: InterfaceFontId;
  promptSize: number;
  terminalFont: MonoFontId;
  terminalSize: number;
};

export const INTERFACE_FONT_OPTIONS = [
  { id: "system", label: "System default" },
  { id: "segoe-ui", label: "Segoe UI" },
  { id: "dm-sans", label: "DM Sans" },
  { id: "arial", label: "Arial" },
  { id: "georgia", label: "Georgia" },
] as const satisfies ReadonlyArray<{ id: InterfaceFontId; label: string }>;

export const MONO_FONT_OPTIONS = [
  { id: "system", label: "System default" },
  { id: "consolas", label: "Consolas" },
  { id: "cascadia-code", label: "Cascadia Code" },
  { id: "jetbrains-mono", label: "JetBrains Mono" },
  { id: "sf-mono", label: "SF Mono" },
] as const satisfies ReadonlyArray<{ id: MonoFontId; label: string }>;

export const INTERFACE_SIZE_OPTIONS = [14, 15, 16, 17, 18, 19, 20].map(
  (size) => ({ id: String(size), label: `${size} px` }),
);
export const MONO_SIZE_OPTIONS = [11, 12, 13, 14, 15, 16, 17, 18].map(
  (size) => ({ id: String(size), label: `${size} px` }),
);
export const TERMINAL_SIZE_OPTIONS = [10, 11, 12, 13, 14, 15, 16].map(
  (size) => ({ id: String(size), label: `${size} px` }),
);

export const DEFAULT_APPEARANCE_PREFERENCES: AppearancePreferences = {
  glassOpacity: 80,
  interfaceFont: "system",
  interfaceSize: 16,
  monoFont: "system",
  monoSize: 13,
  advanced: false,
  promptFont: "system",
  promptSize: 16,
  terminalFont: "system",
  terminalSize: 12,
};

const STORAGE_KEY = "open-xiao:appearance-v1";
const INTERFACE_FONT_IDS = new Set<InterfaceFontId>(
  INTERFACE_FONT_OPTIONS.map((option) => option.id),
);
const MONO_FONT_IDS = new Set<MonoFontId>(
  MONO_FONT_OPTIONS.map((option) => option.id),
);

const SANS_STACKS: Record<InterfaceFontId, string> = {
  system:
    '"DM Sans", -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif',
  "segoe-ui": '"Segoe UI", system-ui, sans-serif',
  "dm-sans": '"DM Sans", "Segoe UI", system-ui, sans-serif',
  arial: 'Arial, "Helvetica Neue", sans-serif',
  georgia: 'Georgia, "Times New Roman", serif',
};

const MONO_STACKS: Record<MonoFontId, string> = {
  system:
    '"Cascadia Code", "SF Mono", "JetBrains Mono", Consolas, "Liberation Mono", Menlo, monospace',
  consolas: 'Consolas, "Liberation Mono", Menlo, monospace',
  "cascadia-code": '"Cascadia Code", Consolas, monospace',
  "jetbrains-mono": '"JetBrains Mono", Consolas, monospace',
  "sf-mono": '"SF Mono", "SFMono-Regular", Menlo, Consolas, monospace',
};

function clamp(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.round(value)));
}

export function normalizeAppearancePreferences(
  value: Partial<AppearancePreferences>,
): AppearancePreferences {
  return {
    glassOpacity: clamp(
      value.glassOpacity ?? DEFAULT_APPEARANCE_PREFERENCES.glassOpacity,
      40,
      100,
      DEFAULT_APPEARANCE_PREFERENCES.glassOpacity,
    ),
    interfaceFont: INTERFACE_FONT_IDS.has(value.interfaceFont as InterfaceFontId)
      ? (value.interfaceFont as InterfaceFontId)
      : DEFAULT_APPEARANCE_PREFERENCES.interfaceFont,
    interfaceSize: clamp(
      value.interfaceSize ?? DEFAULT_APPEARANCE_PREFERENCES.interfaceSize,
      14,
      20,
      DEFAULT_APPEARANCE_PREFERENCES.interfaceSize,
    ),
    monoFont: MONO_FONT_IDS.has(value.monoFont as MonoFontId)
      ? (value.monoFont as MonoFontId)
      : DEFAULT_APPEARANCE_PREFERENCES.monoFont,
    monoSize: clamp(
      value.monoSize ?? DEFAULT_APPEARANCE_PREFERENCES.monoSize,
      11,
      18,
      DEFAULT_APPEARANCE_PREFERENCES.monoSize,
    ),
    advanced:
      typeof value.advanced === "boolean"
        ? value.advanced
        : DEFAULT_APPEARANCE_PREFERENCES.advanced,
    promptFont: INTERFACE_FONT_IDS.has(value.promptFont as InterfaceFontId)
      ? (value.promptFont as InterfaceFontId)
      : DEFAULT_APPEARANCE_PREFERENCES.promptFont,
    promptSize: clamp(
      value.promptSize ?? DEFAULT_APPEARANCE_PREFERENCES.promptSize,
      14,
      20,
      DEFAULT_APPEARANCE_PREFERENCES.promptSize,
    ),
    terminalFont: MONO_FONT_IDS.has(value.terminalFont as MonoFontId)
      ? (value.terminalFont as MonoFontId)
      : DEFAULT_APPEARANCE_PREFERENCES.terminalFont,
    terminalSize: clamp(
      value.terminalSize ?? DEFAULT_APPEARANCE_PREFERENCES.terminalSize,
      10,
      16,
      DEFAULT_APPEARANCE_PREFERENCES.terminalSize,
    ),
  };
}

function isStoredAppearancePreferences(
  value: unknown,
): value is AppearancePreferences {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.glassOpacity === "number" &&
    candidate.glassOpacity >= 40 &&
    candidate.glassOpacity <= 100 &&
    INTERFACE_FONT_IDS.has(candidate.interfaceFont as InterfaceFontId) &&
    typeof candidate.interfaceSize === "number" &&
    candidate.interfaceSize >= 14 &&
    candidate.interfaceSize <= 20 &&
    MONO_FONT_IDS.has(candidate.monoFont as MonoFontId) &&
    typeof candidate.monoSize === "number" &&
    candidate.monoSize >= 11 &&
    candidate.monoSize <= 18 &&
    typeof candidate.advanced === "boolean" &&
    INTERFACE_FONT_IDS.has(candidate.promptFont as InterfaceFontId) &&
    typeof candidate.promptSize === "number" &&
    candidate.promptSize >= 14 &&
    candidate.promptSize <= 20 &&
    MONO_FONT_IDS.has(candidate.terminalFont as MonoFontId) &&
    typeof candidate.terminalSize === "number" &&
    candidate.terminalSize >= 10 &&
    candidate.terminalSize <= 16
  );
}

export function loadAppearancePreferences(): AppearancePreferences {
  try {
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null");
    if (isStoredAppearancePreferences(stored)) {
      return normalizeAppearancePreferences(stored);
    }
  } catch {
    /* ignore */
  }
  return { ...DEFAULT_APPEARANCE_PREFERENCES };
}

export function saveAppearancePreferences(
  preferences: AppearancePreferences,
): AppearancePreferences {
  const normalized = normalizeAppearancePreferences(preferences);
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(normalized));
  } catch {
    /* current session still updates */
  }
  return normalized;
}

export function interfaceFontStack(id: InterfaceFontId): string {
  return SANS_STACKS[id];
}

export function monoFontStack(id: MonoFontId): string {
  return MONO_STACKS[id];
}

type AppearanceRoot = {
  style: {
    fontSize: string;
    setProperty(name: string, value: string): void;
  };
};

export function applyAppearancePreferences(
  preferences: AppearancePreferences,
  root: AppearanceRoot = document.documentElement,
): AppearancePreferences {
  const normalized = normalizeAppearancePreferences(preferences);
  const promptFont = normalized.advanced
    ? normalized.promptFont
    : normalized.interfaceFont;
  const promptSize = normalized.advanced
    ? normalized.promptSize
    : normalized.interfaceSize;
  const terminalFont = normalized.advanced
    ? normalized.terminalFont
    : normalized.monoFont;
  const terminalSize = normalized.advanced
    ? normalized.terminalSize
    : normalized.monoSize;

  root.style.fontSize = `${normalized.interfaceSize}px`;
  root.style.setProperty("--glass-opacity", `${normalized.glassOpacity}%`);
  root.style.setProperty(
    "--font-sans",
    interfaceFontStack(normalized.interfaceFont),
  );
  root.style.setProperty("--font-mono", monoFontStack(normalized.monoFont));
  root.style.setProperty("--font-composer", interfaceFontStack(promptFont));
  root.style.setProperty("--font-terminal", monoFontStack(terminalFont));
  root.style.setProperty("--font-size-code", `${normalized.monoSize}px`);
  root.style.setProperty("--font-size-prompt", `${promptSize}px`);
  root.style.setProperty("--font-size-terminal", `${terminalSize}px`);
  return normalized;
}
