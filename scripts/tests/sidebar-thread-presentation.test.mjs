import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { storedModelDisplay } from "../../src/models.ts";
import {
  SETTLED_TAIL_INITIAL_COUNT,
  SETTLED_TAIL_PAGE_COUNT,
} from "../../src/components/Sidebar.logic.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const read = (path) => readFileSync(join(root, path), "utf8");

test("persisted thread models retain their own provider identity", () => {
  assert.deepEqual(storedModelDisplay("gpt-5.6-sol"), {
    label: "GPT-5.6 Sol",
    provider: "openai",
  });
  assert.deepEqual(storedModelDisplay("grok-4.5"), {
    label: "Grok 4.5",
    provider: "grok",
  });
  assert.deepEqual(storedModelDisplay("opencode::openai/gpt-5.4"), {
    label: "openai/gpt-5.4",
    provider: "opencode",
  });
  assert.deepEqual(
    storedModelDisplay("antigravity::gemini-3.6-flash-low"),
    {
      label: "gemini-3.6-flash-low",
      provider: "antigravity",
    },
  );
  assert.equal(storedModelDisplay("unknown-model"), null);
});

test("sidebar rows use thread-owned provider branding and details", () => {
  const sidebar = read("src/components/Sidebar.tsx");
  assert.match(sidebar, /storedModelDisplay\(t\.modelId\)/);
  assert.match(sidebar, /ThreadProviderLogo provider=\{model\.provider\}/);
  assert.match(sidebar, /className="sb-card__branch"/);
  assert.match(sidebar, /className="sb-thread-tip"/);
});

test("sidebar thread density matches the compact row metrics", () => {
  const styles = read("src/styles.css");
  const threadList = styles.match(/\.sb-thread-list \{(?<rules>[\s\S]*?)\n\}/)?.groups?.rules;
  const card = styles.match(/\.sb-row__surface--card \{(?<rules>[\s\S]*?)\n\}/)?.groups?.rules;

  assert.ok(threadList);
  assert.match(threadList, /gap: 0;/);
  assert.match(
    threadList,
    /font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;/,
  );
  assert.ok(card);
  assert.match(card, /height: 4\.875rem;/);
  assert.match(card, /padding: 0\.5rem 0\.625rem;/);
  assert.match(styles, /\.sb-card__project \{[\s\S]*?line-height: 1rem;/);
  assert.match(styles, /\.sb-row__time \{[\s\S]*?line-height: 1rem;/);
  assert.match(styles, /\.sb-card__status \{[\s\S]*?font-weight: 500;[\s\S]*?line-height: 1rem;/);
  assert.match(
    styles,
    /\.sb-row\.is-recede \.sb-card__title,[\s\S]*?font-weight: 400;/,
  );
});

test("settled shelf keeps the compact T3 disclosure contract", () => {
  const sidebar = read("src/components/Sidebar.tsx");
  const styles = read("src/styles.css");
  const rowSurface = styles.match(
    /(?:^|\n)\.sb-row__surface \{(?<rules>[\s\S]*?)\n\}/,
  )?.groups?.rules;
  const slimItem = styles.match(
    /\.sb-row--slim \{(?<rules>[\s\S]*?)\n\}/,
  )?.groups?.rules;
  const slimRow = styles.match(
    /\.sb-row__surface--slim \{(?<rules>[\s\S]*?)\n\}/,
  )?.groups?.rules;
  const shelf = styles.match(
    /\.sb-shelf-toggle \{(?<rules>[\s\S]*?)\n\}/,
  )?.groups?.rules;
  const showMore = styles.match(
    /\.sb-show-more \{(?<rules>[\s\S]*?)\n\}/,
  )?.groups?.rules;

  assert.equal(SETTLED_TAIL_INITIAL_COUNT, 10);
  assert.equal(SETTLED_TAIL_PAGE_COUNT, 25);
  assert.match(sidebar, /`Settled \(\$\{settledThreads\.length\}\)`/);
  assert.match(sidebar, /Math\.min\(hiddenSettledCount, SETTLED_TAIL_PAGE_COUNT\)/);
  assert.ok(rowSurface);
  assert.match(rowSurface, /width: 100%;/);
  assert.match(rowSurface, /overflow: hidden;/);
  assert.match(rowSurface, /cursor: pointer;/);
  assert.match(rowSurface, /user-select: none;/);
  assert.ok(slimItem);
  assert.match(slimItem, /content-visibility: auto;/);
  assert.match(slimItem, /contain-intrinsic-size: auto 34px;/);
  assert.ok(slimRow);
  assert.match(slimRow, /height: 2\.25rem;/);
  assert.match(slimRow, /gap: 0\.625rem;/);
  assert.match(slimRow, /padding: 0 0\.625rem;/);
  assert.ok(shelf);
  assert.match(shelf, /margin-top: 0\.75rem;/);
  assert.match(shelf, /margin-bottom: 0\.25rem;/);
  assert.ok(showMore);
  assert.match(showMore, /height: 2\.25rem;/);
});

test("expanded image preview portals above the complete app shell", () => {
  const dialog = read("src/components/ExpandedImageDialog.tsx");
  assert.match(dialog, /createPortal\(/);
  assert.match(dialog, /document\.body/);
  assert.match(dialog, /event\.key === "Escape"/);
  assert.match(dialog, /event\.key === "ArrowLeft"/);
  assert.match(dialog, /event\.key !== "ArrowRight"/);
});
