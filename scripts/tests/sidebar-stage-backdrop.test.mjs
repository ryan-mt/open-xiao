import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  resolveEnvironmentIdentificationPillLabel,
  resolveSidebarStageBackdropVariant,
} from "../../src/components/SidebarStageBackdrop.logic.ts";

const styles = readFileSync(
  new URL("../../src/styles.css", import.meta.url),
  "utf8",
);
const component = readFileSync(
  new URL("../../src/components/SidebarStageBackdrop.tsx", import.meta.url),
  "utf8",
);

test("every release channel resolves to its Xiao sidebar artwork", () => {
  assert.equal(resolveSidebarStageBackdropVariant("Dev"), "dev");
  assert.equal(resolveSidebarStageBackdropVariant("Beta"), "beta");
  assert.equal(resolveSidebarStageBackdropVariant("Official"), "official");
  assert.equal(resolveSidebarStageBackdropVariant("latest"), "official");
  assert.equal(resolveSidebarStageBackdropVariant("Official", false), null);
  assert.equal(
    resolveEnvironmentIdentificationPillLabel("Official"),
    "Official",
  );
});

test("beta artwork is pink and dev artwork is yellow", () => {
  assert.match(
    component,
    /function BetaSkyArt[\s\S]*?<stop offset="0\.5" stopColor="#831843"/i,
  );
  assert.match(
    styles,
    /\.stage-blueprint--dev,\s*\.stage-blueprint--official\s*\{[\s\S]*--stage-bp-mid:\s*#e7a91a/i,
  );
});

test("the default dark theme uses the quiet T3 Code surface hierarchy", () => {
  const darkPalette =
    styles.match(/\.dark,\s*\nhtml\.dark\s*\{([\s\S]*?)\n\}/)?.[1] ?? "";

  assert.match(darkPalette, /--background:\s*var\(--color-neutral-950\)/);
  assert.match(darkPalette, /--primary:\s*oklch\(0\.588 0\.217 264\)/);
  assert.match(darkPalette, /--accent:\s*rgb\(255 255 255 \/ 4%\)/);
  assert.match(darkPalette, /--sidebar:\s*#000/);
  assert.match(darkPalette, /--sidebar-row-hover:\s*rgb\(255 255 255 \/ 8%\)/);
  assert.match(
    darkPalette,
    /--sidebar-row-active:\s*rgb\(255 255 255 \/ 11%\)/,
  );
  assert.match(
    darkPalette,
    /--sidebar-row-selected:\s*rgb\(255 255 255 \/ 7%\)/,
  );
  assert.match(
    styles,
    /html\.dark\[data-theme="dark"\] \.sidebar-v2__inner \.sidebar-stage-backdrop\s*\{\s*display:\s*none;/,
  );
});
