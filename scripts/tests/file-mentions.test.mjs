import assert from "node:assert/strict";
import test from "node:test";

import {
  applyFileMentionSelection,
  detectFileMentionTrigger,
  ownsFileMentionSearch,
  serializeFileMentionPath,
  toFileMentionMenuItem,
} from "../../src/fileMentions.ts";

test("mention search ownership includes generation, project, query, and range", () => {
  const owner = {
    generation: 7,
    projectPath: "C:/repo/a",
    query: "src",
    rangeStart: 4,
    rangeEnd: 8,
  };
  const trigger = {
    kind: "path",
    query: "src",
    rangeStart: 4,
    rangeEnd: 8,
  };
  assert.equal(ownsFileMentionSearch(owner, 7, "C:/repo/a", trigger), true);
  assert.equal(ownsFileMentionSearch(owner, 8, "C:/repo/a", trigger), false);
  assert.equal(ownsFileMentionSearch(owner, 7, "C:/repo/b", trigger), false);
  assert.equal(
    ownsFileMentionSearch(owner, 7, "C:/repo/a", { ...trigger, query: "test" }),
    false,
  );
  assert.equal(
    ownsFileMentionSearch(owner, 7, "C:/repo/a", { ...trigger, rangeEnd: 9 }),
    false,
  );
});

test("detectFileMentionTrigger finds @ token at cursor", () => {
  const text = "please check @App";
  const t = detectFileMentionTrigger(text, text.length);
  assert.ok(t);
  assert.equal(t.query, "App");
  assert.equal(t.rangeStart, text.indexOf("@"));
  assert.equal(t.rangeEnd, text.length);
});

test("detectFileMentionTrigger ignores slash drafts", () => {
  assert.equal(detectFileMentionTrigger("/model", 6), null);
  assert.equal(detectFileMentionTrigger("/@", 2), null);
});

test("detectFileMentionTrigger supports mid-line and empty query", () => {
  const text = "see @ and more";
  // cursor right after bare @
  const t = detectFileMentionTrigger(text, text.indexOf("@") + 1);
  assert.ok(t);
  assert.equal(t.query, "");
  assert.equal(t.rangeStart, text.indexOf("@"));
});

test("detectFileMentionTrigger understands quoted paths with spaces", () => {
  const text = 'open @"my files/a b.ts" now';
  const at = text.indexOf("@");
  const closeQuote = text.indexOf('"', at + 2);
  // Cursor inside the quoted path (past an inner space).
  const t = detectFileMentionTrigger(text, text.indexOf("a b"));
  assert.ok(t);
  assert.equal(t.query, "my files/a b.ts");
  assert.equal(t.rangeStart, at);
  assert.equal(t.rangeEnd, closeQuote + 1);

  // Still typing — no closing quote yet.
  const partial = 'see @"my fi';
  const p = detectFileMentionTrigger(partial, partial.length);
  assert.ok(p);
  assert.equal(p.query, "my fi");
  assert.equal(p.rangeStart, partial.indexOf("@"));
  assert.equal(p.rangeEnd, partial.length);

  // Cursor after the completed mention — no active trigger.
  assert.equal(detectFileMentionTrigger(text, text.length), null);
});

test("serializeFileMentionPath quotes paths with spaces", () => {
  assert.equal(serializeFileMentionPath("src/App.tsx"), "src/App.tsx");
  assert.equal(
    serializeFileMentionPath("my files/a b.ts"),
    '"my files/a b.ts"',
  );
});

test("applyFileMentionSelection replaces trigger with @path + space", () => {
  const text = "fix @App";
  const trigger = detectFileMentionTrigger(text, text.length);
  assert.ok(trigger);
  const next = applyFileMentionSelection(text, trigger, "src/App.tsx");
  assert.equal(next.text, "fix @src/App.tsx ");
  assert.equal(next.cursor, next.text.length);
});

test("toFileMentionMenuItem builds labels", () => {
  const item = toFileMentionMenuItem({
    path: "src/components/Composer.tsx",
    name: "Composer.tsx",
    parent: "src/components",
    isDir: false,
  });
  assert.equal(item.label, "Composer.tsx");
  assert.equal(item.description, "src/components");
  assert.equal(item.key, "file:src/components/Composer.tsx");
});
