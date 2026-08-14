import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  BOOT_EXIT_MS,
  BOOT_HOLD_MS,
  BOOT_MAX_WAIT_MS,
  remainingBootHold,
} from "../../src/bootSplashTiming.ts";

const component = readFileSync(
  new URL("../../src/components/BootSplash.tsx", import.meta.url),
  "utf8",
);
const styles = readFileSync(
  new URL("../../src/styles.css", import.meta.url),
  "utf8",
);

test("boot splash presents the full app instead of a detached rail", () => {
  assert.match(component, /boot-splash__identity/);
  assert.match(component, /APP_FAVICON_SRC/);
  assert.doesNotMatch(component, /boot-splash__rail/);
  assert.doesNotMatch(component, /SidebarStageBackdrop/);
});

test("sidebar, workspace, and chrome enter as one full-app composition", () => {
  assert.match(styles, /@keyframes boot-sidebar-compose/);
  assert.match(styles, /@keyframes boot-workspace-compose/);
  assert.match(styles, /@keyframes boot-chrome-compose/);
  assert.match(styles, /@keyframes boot-sidebar-enter/);
  assert.match(styles, /@keyframes boot-workspace-enter/);
  assert.match(styles, /@keyframes boot-chrome-enter/);
  assert.match(styles, /\.shell\.is-booting > \.sidebar-v2\s*\{[\s\S]*opacity:\s*0\.72/);
  assert.match(styles, /\.shell\.is-booting > \.inset\s*\{[\s\S]*opacity:\s*0\.68/);
  assert.match(
    styles,
    /\.boot-splash::before\s*\{[\s\S]*var\(--background\) 28%/,
  );
  assert.match(
    styles,
    /@media \(prefers-reduced-motion: reduce\)[\s\S]*\.boot-splash__identity/,
  );
  assert.doesNotMatch(styles, /@keyframes boot-rail-arrive/);
  assert.doesNotMatch(styles, /@keyframes boot-rail-dock/);
});

test("boot hold starts at the first visible paint and stays long enough to read", () => {
  assert.equal(BOOT_HOLD_MS, 3000);
  assert.equal(BOOT_EXIT_MS, 1000);
  assert.equal(BOOT_MAX_WAIT_MS, 8000);
  assert.equal(remainingBootHold(2000, 2200, BOOT_HOLD_MS), 2800);
  assert.match(component, /requestAnimationFrame/);
  assert.match(component, /firstPaintAt/);
  assert.match(component, /BOOT_MAX_WAIT_MS/);
  assert.match(component, /Storage should not make the entire app unusable/);
  assert.match(component, /getCurrentWindow\(\)\.show\(\)/);
  assert.ok(
    component.indexOf("markVisible();") <
      component.indexOf("getCurrentWindow().show()"),
  );
  assert.match(component, /onExitStart\?\.\(\)/);
  assert.match(styles, /--boot-exit-ms:\s*1000ms/);
});
