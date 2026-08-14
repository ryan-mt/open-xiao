import { useState, type CSSProperties } from "react";
import {
  applyAppearancePreferences,
  interfaceFontStack,
  INTERFACE_FONT_OPTIONS,
  INTERFACE_SIZE_OPTIONS,
  loadAppearancePreferences,
  monoFontStack,
  MONO_FONT_OPTIONS,
  MONO_SIZE_OPTIONS,
  saveAppearancePreferences,
  TERMINAL_SIZE_OPTIONS,
  type AppearancePreferences,
} from "../../appearance";
import { THEME_CATALOG, type ThemeMode } from "../../theme";
import { Select } from "../Select";

export const APPEARANCE_THEME_PAGE_SIZE = 6;

type AppearancePageProps = {
  theme: ThemeMode;
  onThemeChange: (value: ThemeMode) => void;
  themePage: number;
  onThemePageChange: (value: number) => void;
};

export function AppearancePage({
  theme,
  onThemeChange,
  themePage,
  onThemePageChange,
}: AppearancePageProps) {
  const [appearance, setAppearance] = useState(loadAppearancePreferences);
  const schemeThemes = THEME_CATALOG.slice(0, 3);
  const authoredThemes = THEME_CATALOG.slice(3);
  const themePageCount = Math.ceil(
    authoredThemes.length / APPEARANCE_THEME_PAGE_SIZE,
  );
  const visibleThemes = authoredThemes.slice(
    themePage * APPEARANCE_THEME_PAGE_SIZE,
    (themePage + 1) * APPEARANCE_THEME_PAGE_SIZE,
  );
  const selectedDefinition = THEME_CATALOG.find(
    (definition) => definition.id === theme,
  );
  const activeScheme =
    theme === "system" || theme === "light" || theme === "dark"
      ? theme
      : selectedDefinition?.appearance === "light"
        ? "light"
        : "dark";

  const updateAppearance = (patch: Partial<AppearancePreferences>) => {
    const next = saveAppearancePreferences({ ...appearance, ...patch });
    applyAppearancePreferences(next);
    setAppearance(next);
  };

  return (
    <div className="appearance-page">
      <header className="appearance-page__header">
        <h2 className="settings-v2__title">Appearance</h2>
        <p className="settings-v2__lede">
          Choose how Open Xiao looks and reads across chat, code, and terminal.
        </p>
      </header>

      <section className="appearance-section">
        <h3 className="appearance-section__title">Color scheme</h3>
        <div
          className="appearance-scheme-grid"
          role="radiogroup"
          aria-label="Color scheme"
        >
          {schemeThemes.map((option) => {
            const previewStyle = {
              "--theme-preview-bg": option.preview.background,
              "--theme-preview-surface": option.preview.surface,
              "--theme-preview-fg": option.preview.foreground,
              "--theme-preview-accent": option.preview.accent,
            } as CSSProperties;
            const selected = activeScheme === option.id;
            return (
              <label
                key={option.id}
                className={`appearance-scheme-card${selected ? " is-selected" : ""}`}
                style={previewStyle}
              >
                <input
                  type="radio"
                  name="appearance-scheme"
                  value={option.id}
                  checked={selected}
                  onChange={() => onThemeChange(option.id)}
                />
                <span
                  className={`appearance-scheme-preview${option.id === "system" ? " is-system" : ""}`}
                  aria-hidden
                >
                  <span className="appearance-scheme-preview__rail">
                    <span />
                    <span />
                    <span />
                  </span>
                  <span className="appearance-scheme-preview__canvas">
                    <span className="appearance-scheme-preview__line is-wide" />
                    <span className="appearance-scheme-preview__line" />
                    <span className="appearance-scheme-preview__panel">
                      <span />
                      <span />
                      <span />
                    </span>
                    <span className="appearance-scheme-preview__composer" />
                  </span>
                </span>
                <span className="appearance-scheme-card__label">
                  {option.id === "system"
                    ? "System"
                    : option.id === "light"
                      ? "Light"
                      : "Dark"}
                </span>
              </label>
            );
          })}
        </div>
      </section>

      <section className="appearance-section">
        <div className="appearance-section__head">
          <h3 className="appearance-section__title">Themes</h3>
          <nav
            className="appearance-theme-pagination"
            aria-label="Theme pages"
          >
            {Array.from({ length: themePageCount }, (_, page) => (
              <button
                key={page}
                type="button"
                className={themePage === page ? "is-active" : undefined}
                aria-label={`Theme page ${page + 1}`}
                aria-current={themePage === page ? "page" : undefined}
                onClick={() => onThemePageChange(page)}
              />
            ))}
          </nav>
        </div>
        <div
          className="appearance-theme-grid"
          role="radiogroup"
          aria-label="Open Xiao themes"
        >
          {visibleThemes.map((option) => {
            const previewStyle = {
              "--theme-preview-bg": option.preview.background,
              "--theme-preview-surface": option.preview.surface,
              "--theme-preview-fg": option.preview.foreground,
              "--theme-preview-accent": option.preview.accent,
            } as CSSProperties;
            return (
              <label
                key={option.id}
                className={`appearance-theme-card${theme === option.id ? " is-selected" : ""}`}
                style={previewStyle}
              >
                <input
                  type="radio"
                  name="application-theme"
                  value={option.id}
                  checked={theme === option.id}
                  onChange={() => onThemeChange(option.id)}
                />
                <span className="appearance-theme-card__swatches" aria-hidden>
                  <span className="appearance-theme-swatch is-background" />
                  <span className="appearance-theme-swatch is-surface" />
                </span>
                <span className="appearance-theme-card__name">{option.name}</span>
              </label>
            );
          })}
        </div>
      </section>

      <section className="appearance-section appearance-glass">
        <div>
          <h3 className="appearance-section__title">Glass opacity</h3>
          <p className="appearance-section__description">
            Control the transparency of menus, dialogs, and the composer.
          </p>
        </div>
        <div className="appearance-glass__control">
          <output htmlFor="appearance-glass-opacity">
            {appearance.glassOpacity}%
          </output>
          <input
            id="appearance-glass-opacity"
            type="range"
            min="40"
            max="100"
            step="5"
            value={appearance.glassOpacity}
            aria-label="Glass opacity"
            onChange={(event) =>
              updateAppearance({ glassOpacity: Number(event.target.value) })
            }
          />
        </div>
      </section>

      <section className="appearance-section appearance-typography">
        <div className="appearance-section__head appearance-typography__head">
          <h3 className="appearance-section__title appearance-section__title--large">
            Typography
          </h3>
          <label className="appearance-advanced">
            <span>Advanced</span>
            <button
              type="button"
              role="switch"
              aria-checked={appearance.advanced}
              className={`settings-v2__switch${appearance.advanced ? " is-on" : ""}`}
              onClick={() =>
                updateAppearance({ advanced: !appearance.advanced })
              }
            >
              <span className="settings-v2__switch-thumb" />
            </button>
          </label>
        </div>

        <AppearanceFontRow
          title="Interface font"
          description="Everything outside code blocks and the terminal."
          fontValue={appearance.interfaceFont}
          fontOptions={INTERFACE_FONT_OPTIONS}
          sizeValue={appearance.interfaceSize}
          sizeOptions={INTERFACE_SIZE_OPTIONS}
          preview="Open Xiao keeps tools quiet, readable, and close to the work."
          previewStyle={{
            fontFamily: interfaceFontStack(appearance.interfaceFont),
            fontSize: `${appearance.interfaceSize}px`,
          }}
          onFontChange={(interfaceFont) => updateAppearance({ interfaceFont })}
          onSizeChange={(interfaceSize) => updateAppearance({ interfaceSize })}
        />

        <AppearanceFontRow
          title="Monospace font"
          description="Code blocks, diffs, file previews, and the terminal."
          fontValue={appearance.monoFont}
          fontOptions={MONO_FONT_OPTIONS}
          sizeValue={appearance.monoSize}
          sizeOptions={MONO_SIZE_OPTIONS}
          preview={'const result = await xiao.run("Inspect this workspace");'}
          previewStyle={{
            fontFamily: monoFontStack(appearance.monoFont),
            fontSize: `${appearance.monoSize}px`,
          }}
          onFontChange={(monoFont) => updateAppearance({ monoFont })}
          onSizeChange={(monoSize) => updateAppearance({ monoSize })}
        />

        {appearance.advanced ? (
          <>
            <AppearanceFontRow
              title="Prompt font"
              description="Composer text while you write instructions."
              fontValue={appearance.promptFont}
              fontOptions={INTERFACE_FONT_OPTIONS}
              sizeValue={appearance.promptSize}
              sizeOptions={INTERFACE_SIZE_OPTIONS}
              preview="Review the changed files and explain only what matters."
              previewStyle={{
                fontFamily: interfaceFontStack(appearance.promptFont),
                fontSize: `${appearance.promptSize}px`,
              }}
              onFontChange={(promptFont) => updateAppearance({ promptFont })}
              onSizeChange={(promptSize) => updateAppearance({ promptSize })}
            />
            <AppearanceFontRow
              title="Terminal font"
              description="The integrated terminal and live command output."
              fontValue={appearance.terminalFont}
              fontOptions={MONO_FONT_OPTIONS}
              sizeValue={appearance.terminalSize}
              sizeOptions={TERMINAL_SIZE_OPTIONS}
              preview="PS C:\\workspace> npm run build"
              previewStyle={{
                fontFamily: monoFontStack(appearance.terminalFont),
                fontSize: `${appearance.terminalSize}px`,
              }}
              onFontChange={(terminalFont) => updateAppearance({ terminalFont })}
              onSizeChange={(terminalSize) => updateAppearance({ terminalSize })}
            />
          </>
        ) : null}
      </section>
    </div>
  );
}

function AppearanceFontRow<T extends string>({
  title,
  description,
  fontValue,
  fontOptions,
  sizeValue,
  sizeOptions,
  preview,
  previewStyle,
  onFontChange,
  onSizeChange,
}: {
  title: string;
  description: string;
  fontValue: T;
  fontOptions: ReadonlyArray<{ id: T; label: string }>;
  sizeValue: number;
  sizeOptions: ReadonlyArray<{ id: string; label: string }>;
  preview: string;
  previewStyle: CSSProperties;
  onFontChange: (value: T) => void;
  onSizeChange: (value: number) => void;
}) {
  return (
    <div className="appearance-font-row">
      <div className="appearance-font-row__head">
        <div>
          <h4>{title}</h4>
          <p>{description}</p>
        </div>
        <div className="appearance-font-row__controls">
          <Select
            value={fontValue}
            options={fontOptions}
            onChange={onFontChange}
            aria-label={title}
          />
          <Select
            value={String(sizeValue)}
            options={sizeOptions}
            onChange={(value) => onSizeChange(Number(value))}
            aria-label={`${title} size`}
          />
        </div>
      </div>
      <div className="appearance-font-row__preview" style={previewStyle}>
        {preview}
      </div>
    </div>
  );
}
