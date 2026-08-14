import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const sidebar = readFileSync(
  new URL("../../src/components/Sidebar.tsx", import.meta.url),
  "utf8",
);
const app = readFileSync(new URL("../../src/App.tsx", import.meta.url), "utf8");
const styles = readFileSync(
  new URL("../../src/styles.css", import.meta.url),
  "utf8",
);

test("sidebar exposes current T3 thread and resize actions", () => {
  assert.match(sidebar, /shouldOpenNewThreadProjectPicker\(\s*scopeKey,\s*projects\.length,\s*event\.shiftKey/s);
  assert.match(sidebar, /New thread in current project: Shift\+click/);
  assert.match(sidebar, /Copy thread ID/);
  assert.match(sidebar, /onDoubleClick=\{resetSidebarWidth\}/);
  assert.match(sidebar, /Double-click to reset/);
});

test("sidebar footer keeps navigation actions in one compact icon row", () => {
  assert.match(sidebar, /className="sidebar-v2__footer-actions"/);
  assert.match(sidebar, /aria-label="Usage"/);
  assert.match(sidebar, /aria-label="Providers"/);
  assert.match(sidebar, /aria-label="Settings"/);
});

test("narrow windows overlay the sidebar without squeezing the chat surface", () => {
  assert.match(app, /--sidebar-width.*sidebarWidth/);
  assert.match(app, /mobileSidebarOpen/);
  assert.match(app, /window\.matchMedia\("\(max-width: 640px\)"\)/);
  assert.match(
    app,
    /const effectiveSidebarOpen = isNarrowViewport\s*\? mobileSidebarOpen\s*:\s*sidebarOpen/,
  );
  assert.match(app, /<SidebarV2\s+open=\{effectiveSidebarOpen\}/);
  assert.match(sidebar, /className="sidebar-v2__mobile-backdrop"/);
  assert.match(sidebar, /aria-label="Close sidebar"/);
  assert.match(
    styles,
    /@media \(max-width: 640px\)[\s\S]*?\.sidebar-v2\s*\{\s*z-index:\s*30;[\s\S]*?\.sidebar-v2__gap\s*\{\s*width:\s*0;/,
  );
  assert.match(
    styles,
    /\.sidebar-float\.is-open\s*\{[\s\S]*?left:\s*calc\(min\(var\(--sidebar-width\)/,
  );
});
