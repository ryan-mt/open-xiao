import assert from "node:assert/strict";
import test from "node:test";

function createStorage() {
  const values = new Map();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
    clear: () => values.clear(),
  };
}

function createRoot() {
  const values = new Map();
  return {
    style: {
      fontSize: "",
      getPropertyValue: (name) => values.get(name) ?? "",
      setProperty: (name, value) => values.set(name, String(value)),
    },
  };
}

globalThis.localStorage = createStorage();

const {
  DEFAULT_APPEARANCE_PREFERENCES,
  applyAppearancePreferences,
  loadAppearancePreferences,
  normalizeAppearancePreferences,
  saveAppearancePreferences,
} = await import("../../src/appearance.ts");

test("appearance preferences persist and malformed values fall back safely", () => {
  localStorage.clear();
  saveAppearancePreferences({
    ...DEFAULT_APPEARANCE_PREFERENCES,
    glassOpacity: 65,
    interfaceFont: "segoe-ui",
    interfaceSize: 17,
    monoFont: "consolas",
    monoSize: 14,
    advanced: true,
    promptFont: "dm-sans",
    promptSize: 15,
    terminalFont: "cascadia-code",
    terminalSize: 13,
  });

  assert.deepEqual(loadAppearancePreferences(), {
    glassOpacity: 65,
    interfaceFont: "segoe-ui",
    interfaceSize: 17,
    monoFont: "consolas",
    monoSize: 14,
    advanced: true,
    promptFont: "dm-sans",
    promptSize: 15,
    terminalFont: "cascadia-code",
    terminalSize: 13,
  });

  localStorage.setItem(
    "open-xiao:appearance-v1",
    JSON.stringify({
      glassOpacity: 300,
      interfaceFont: "comic-sans",
      interfaceSize: -4,
      monoFont: null,
      monoSize: "large",
      advanced: "yes",
    }),
  );
  assert.deepEqual(loadAppearancePreferences(), DEFAULT_APPEARANCE_PREFERENCES);
});

test("normalization clamps numeric preferences and keeps supported fonts", () => {
  assert.deepEqual(
    normalizeAppearancePreferences({
      ...DEFAULT_APPEARANCE_PREFERENCES,
      glassOpacity: 103,
      interfaceFont: "dm-sans",
      interfaceSize: 42,
      monoFont: "jetbrains-mono",
      monoSize: 4,
      promptSize: 99,
      terminalSize: 0,
    }),
    {
      ...DEFAULT_APPEARANCE_PREFERENCES,
      glassOpacity: 100,
      interfaceFont: "dm-sans",
      interfaceSize: 20,
      monoFont: "jetbrains-mono",
      monoSize: 11,
      promptSize: 20,
      terminalSize: 10,
    },
  );
});

test("appearance preferences become the shared CSS contract", () => {
  const root = createRoot();
  applyAppearancePreferences(
    {
      ...DEFAULT_APPEARANCE_PREFERENCES,
      glassOpacity: 70,
      interfaceFont: "segoe-ui",
      interfaceSize: 17,
      monoFont: "consolas",
      monoSize: 14,
      advanced: true,
      promptFont: "dm-sans",
      promptSize: 15,
      terminalFont: "cascadia-code",
      terminalSize: 13,
    },
    root,
  );

  assert.equal(root.style.fontSize, "17px");
  assert.equal(root.style.getPropertyValue("--glass-opacity"), "70%");
  assert.match(root.style.getPropertyValue("--font-sans"), /Segoe UI/);
  assert.match(root.style.getPropertyValue("--font-mono"), /Consolas/);
  assert.match(root.style.getPropertyValue("--font-composer"), /DM Sans/);
  assert.match(root.style.getPropertyValue("--font-terminal"), /Cascadia Code/);
  assert.equal(root.style.getPropertyValue("--font-size-code"), "14px");
  assert.equal(root.style.getPropertyValue("--font-size-prompt"), "15px");
  assert.equal(root.style.getPropertyValue("--font-size-terminal"), "13px");
});

test("simple typography shares mono preferences with the terminal", () => {
  const root = createRoot();
  applyAppearancePreferences(
    {
      ...DEFAULT_APPEARANCE_PREFERENCES,
      monoFont: "jetbrains-mono",
      monoSize: 14,
      advanced: false,
      terminalFont: "consolas",
      terminalSize: 11,
    },
    root,
  );

  assert.match(root.style.getPropertyValue("--font-terminal"), /JetBrains Mono/);
  assert.equal(root.style.getPropertyValue("--font-size-terminal"), "14px");
});
