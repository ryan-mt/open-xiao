import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const cssPath = path.join(root, "src/styles.css");

test("right panel uses a sibling column and stays fully opaque", () => {
  const css = fs.readFileSync(cssPath, "utf8");

  // Wide layouts reserve a real sibling column. This prevents the panel from
  // painting over the timeline and composer while it opens.
  assert.equal(
    /@keyframes\s+right-panel-shell-in\b/.test(css),
    false,
    "shell-in keyframes must be removed (transition-based motion)",
  );
  assert.equal(
    /@keyframes\s+right-panel-shell-out\b/.test(css),
    false,
    "shell-out keyframes must be removed (transition-based motion)",
  );

  const shell = css.match(/\.right-panel-shell\s*\{([\s\S]*?)\n\}/);
  assert.ok(shell, ".right-panel-shell block exists");
  assert.match(shell[1], /position:\s*relative/);
  assert.match(shell[1], /flex:\s*0\s+0\s+0/);
  assert.match(shell[1], /width:\s*0/);
  assert.match(shell[1], /max-width:\s*0/);
  assert.match(shell[1], /opacity:\s*0/);
  assert.match(
    shell[1],
    /transition:[\s\S]*width\s+var\(--right-panel-duration\)/,
  );
  assert.match(
    shell[1],
    /transition:[\s\S]*flex-basis\s+var\(--right-panel-duration\)/,
  );
  assert.equal(
    /animation\s*:/.test(shell[1]),
    false,
    "shell must not use keyframe animation",
  );

  const openShell = css.match(
    /\.right-panel-shell\.is-open\s*\{([\s\S]*?)\n\}/,
  );
  assert.ok(openShell, ".right-panel-shell.is-open block exists");
  assert.match(
    openShell[1],
    /flex-basis:\s*var\(--right-panel-slot-width/,
  );
  assert.match(openShell[1], /width:\s*var\(--right-panel-slot-width/);
  assert.match(openShell[1], /max-width:\s*var\(--right-panel-slot-width/);
  assert.match(openShell[1], /opacity:\s*1/);
  assert.match(
    css,
    /@starting-style\s*\{\s*\.right-panel-shell\.is-open\s*\{[^}]*flex-basis:\s*0[^}]*width:\s*0[^}]*max-width:\s*0/,
    "newly mounted panels must grow from a zero-width sibling slot",
  );
  for (const component of [
    "ReviewChangesPanel.tsx",
    "BrowserPreviewPanel.tsx",
  ]) {
    const source = fs.readFileSync(
      path.join(root, "src/components", component),
      "utf8",
    );
    assert.match(
      source,
      /right-panel-shell\$\{open \? " is-open"/,
      `${component} must apply the opening class on its first mounted render`,
    );
  }

  const closingShell = css.match(
    /\.right-panel-shell\.is-closing\s*\{([\s\S]*?)\n\}/,
  );
  assert.ok(closingShell, ".right-panel-shell.is-closing block exists");
  assert.match(closingShell[1], /flex-basis:\s*0/);
  assert.match(closingShell[1], /width:\s*0/);
  assert.match(closingShell[1], /max-width:\s*0/);
  assert.match(shell[1], /justify-content:\s*flex-end/);

  // At compact sizes the panel may cover the main workspace, but it must stay
  // within the inset and above the composer instead of crossing the sidebar.
  assert.match(
    css,
    /@media\s*\(max-width:\s*900px\)[\s\S]*?\.review-panel\s*\{[^}]*--right-panel-slot-width:\s*100cqi[^}]*z-index:\s*60/,
  );
  const inner = css.match(
    /(?:^|\n)\.right-panel-shell__inner\s*\{([\s\S]*?)\n\}/,
  );
  assert.ok(inner, ".right-panel-shell__inner block exists");
  assert.match(inner[1], /opacity:\s*1/);
  assert.match(inner[1], /transform:\s*none/);
  assert.match(inner[1], /isolation:\s*isolate/);
  assert.equal(
    /transition\s*:/.test(inner[1]),
    false,
    "inner must not animate independently from the shell",
  );

  assert.match(
    css,
    /\.review-panel\s+\.right-panel-shell__inner\s*\{[^}]*isolation:\s*isolate/,
  );
  assert.match(
    css,
    /\.review-panel\s+\.right-panel-shell__inner\s*\{[^}]*opacity:\s*1/,
  );

  // A positive open-state minimum would override responsive panel sizing.
  assert.equal(
    /\.review-panel\.is-open\s*\{[^}]*min-width\s*:\s*[1-9]/.test(css),
    false,
    "review-panel.is-open must not set a positive min-width during motion",
  );

  // Surfaces that previously used translucent color-mix should be solid.
  const list = css.match(/\.review-panel__list\s*\{([\s\S]*?)\n\}/);
  assert.ok(list);
  assert.match(list[1], /background:\s*var\(--card\)/);
  assert.equal(
    /color-mix\([^)]*transparent/.test(list[1]),
    false,
    "list background must not be translucent",
  );

  const filter = css.match(/\.review-panel__filter\s*\{([\s\S]*?)\n\}/);
  assert.ok(filter);
  assert.match(filter[1], /background:\s*var\(--muted\)/);

  const preview = css.match(/\.review-panel__preview\s*\{([\s\S]*?)\n\}/);
  assert.ok(preview);
  assert.match(preview[1], /background:\s*var\(--card\)/);

  const diff = css.match(/\.review-diff\s*\{([\s\S]*?)\n\}/);
  assert.ok(diff);
  assert.match(diff[1], /background:\s*var\(--card\)/);

  const git = css.match(/\.review-git\s*\{([\s\S]*?)\n\}/);
  assert.ok(git);
  assert.match(git[1], /background:\s*var\(--card\)/);

  // Core motion blocks must still exist exactly once as top-level rules.
  for (const sel of [
    ".right-panel-shell {",
    ".right-panel-shell__inner {",
    ".right-panel-menu {",
    ".right-panel-list-shell {",
    ".right-panel-collapse {",
    ".review-panel__stack {",
  ]) {
    const re = new RegExp(
      `(?:^|\\n)${sel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`,
      "g",
    );
    const n = css.match(re)?.length ?? 0;
    assert.equal(n, 1, `${sel} should appear once, got ${n}`);
  }

  assert.match(css, /--right-panel-duration:\s*220ms/);
});

test("review diff long lines wrap inside the panel instead of clipping", () => {
  const css = fs.readFileSync(cssPath, "utf8");
  const panelTsx = fs.readFileSync(
    path.join(root, "src/components/ReviewChangesPanel.tsx"),
    "utf8",
  );

  assert.match(panelTsx, /className="review-diff__scroll"/);

  // Card must size-contain so max-content children cannot inflate past the shell.
  const diff = css.match(/(?:^|\n)\.review-diff\s*\{([\s\S]*?)\n\}/);
  assert.ok(diff, ".review-diff block exists");
  assert.match(diff[1], /min-width:\s*0/);
  assert.match(diff[1], /max-width:\s*100%/);
  assert.match(diff[1], /contain:\s*inline-size/);

  // Side-panel diffs wrap; bare white-space:pre was clipping mid-token at the edge.
  const code = css.match(/(?:^|\n)\.review-diff__code\s*\{([\s\S]*?)\n\}/);
  assert.ok(code, ".review-diff__code block exists");
  assert.match(code[1], /white-space:\s*pre-wrap/);
  assert.match(code[1], /overflow-wrap:\s*anywhere/);
  assert.match(code[1], /min-width:\s*0/);

  const line = css.match(/(?:^|\n)\.review-diff__line\s*\{([\s\S]*?)\n\}/);
  assert.ok(line);
  assert.match(line[1], /min-width:\s*0/);
  assert.match(line[1], /width:\s*100%/);

  const commentButton = css.match(
    /(?:^|\n)\.review-diff__comment-add\s*\{([\s\S]*?)\n\}/,
  );
  assert.ok(commentButton, ".review-diff__comment-add block exists");
  assert.match(commentButton[1], /left:\s*3\.85rem/);
  assert.match(commentButton[1], /transform:\s*translate\(-50%,\s*-50%\)/);

  const preview = css.match(/(?:^|\n)\.review-panel__preview\s*\{([\s\S]*?)\n\}/);
  assert.ok(preview);
  assert.match(preview[1], /overflow-x:\s*hidden/);

  assert.equal(
    /\.review-diff__split-row\s+\.review-diff__code\s*\{[^}]*text-overflow:\s*ellipsis/.test(
      css,
    ),
    false,
    "split code must not ellipsis-clip mid-token",
  );

  assert.match(
    panelTsx,
    /Stats already show on the page pill|onPageChange \? \(/,
  );
});

test("review panel surface uses the inset width as its sizing reference", () => {
  const css = fs.readFileSync(cssPath, "utf8");

  const inset = css.match(/(?:^|\n)\.inset\s*\{([\s\S]*?)\n\}/);
  assert.ok(inset, ".inset block exists");
  assert.match(inset[1], /container-type:\s*inline-size/);

  const panel = css.match(/(?:^|\n)\.review-panel\s*\{([\s\S]*?)\n\}/);
  assert.ok(panel, ".review-panel block exists");
  assert.match(panel[1], /calc\(100cqi\s*-\s*320px\)/);
  assert.equal(
    /calc\(100%\s*-\s*320px\)/.test(panel[1]),
    false,
    "a percentage here resolves again against the inner panel and leaves a 320px gap",
  );
});
