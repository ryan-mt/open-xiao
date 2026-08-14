import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../../", import.meta.url);

const values = new Map();
globalThis.localStorage = {
  getItem(key) {
    return values.get(key) ?? null;
  },
  setItem(key, value) {
    values.set(key, String(value));
  },
  removeItem(key) {
    values.delete(key);
  },
};

const {
  clearStash,
  loadStash,
  mergeStashAttachments,
  prepareStashAttachments,
  removeStashEntry,
  stashPrompt,
  takeStashEntry,
} = await import("../../src/promptStash.ts");

test.beforeEach(() => clearStash());

test("prompt stash is newest-first, durable, and capped at 20", () => {
  for (let index = 0; index < 21; index += 1) {
    const result = stashPrompt(`prompt ${index}`, []);
    assert.equal(result.written, true);
    assert.equal(result.evicted, index === 20);
  }
  const entries = loadStash();
  assert.equal(entries.length, 20);
  assert.equal(entries[0].prompt, "prompt 20");
  assert.equal(entries.at(-1).prompt, "prompt 1");
});

test("restoring consumes one stash entry and delete leaves the others", () => {
  const first = stashPrompt("first", []).entry;
  const second = stashPrompt("second", []).entry;
  assert.ok(first && second);
  assert.equal(takeStashEntry(first.id).entry?.prompt, "first");
  assert.equal(takeStashEntry(first.id).entry, null);
  assert.equal(removeStashEntry(second.id), true);
  assert.deepEqual(loadStash(), []);
});

test("malformed persisted entries are ignored", () => {
  localStorage.setItem(
    "open-xiao.prompt-stash.v1",
    JSON.stringify([{}, { id: "broken" }]),
  );
  assert.deepEqual(loadStash(), []);
});

test("stash keeps prepared images and records images that could not fit", () => {
  const small = {
    id: "small",
    name: "small.png",
    mime: "image/png",
    dataUrl: "data:image/png;base64,AA==",
  };
  const entry = stashPrompt("images", [small], ["large.png"]).entry;
  assert.ok(entry);
  assert.deepEqual(
    entry.attachments.map((attachment) => attachment.id),
    ["small"],
  );
  assert.deepEqual(entry.droppedNames, ["large.png"]);
});

test("stash preparation preserves small images and reports unencodable large ones", async () => {
  const small = {
    id: "small",
    name: "small.png",
    mime: "image/png",
    dataUrl: "data:image/png;base64,AA==",
  };
  const large = {
    ...small,
    id: "large",
    name: "large.png",
    dataUrl: `data:image/png;base64,${"a".repeat(1_300_001)}`,
  };
  const prepared = await prepareStashAttachments([small, large]);
  assert.deepEqual(
    prepared.attachments.map((attachment) => attachment.id),
    ["small"],
  );
  assert.deepEqual(prepared.droppedNames, ["large.png"]);
});

test("stash preparation re-encodes oversized images when canvas is available", async () => {
  const originalImage = globalThis.Image;
  const originalDocument = globalThis.document;
  class FakeImage {
    naturalWidth = 3000;
    naturalHeight = 2000;
    set src(_value) {
      queueMicrotask(() => this.onload?.());
    }
  }
  globalThis.Image = FakeImage;
  globalThis.document = {
    createElement() {
      return {
        width: 0,
        height: 0,
        getContext() {
          return {
            drawImage() {},
            fillRect() {},
            fillStyle: "",
          };
        },
        toDataURL() {
          return "data:image/webp;base64,compressed";
        },
      };
    },
  };
  try {
    const prepared = await prepareStashAttachments([
      {
        id: "large",
        name: "large.png",
        mime: "image/png",
        dataUrl: `data:image/png;base64,${"a".repeat(1_300_001)}`,
      },
    ]);
    assert.equal(prepared.attachments[0].mime, "image/webp");
    assert.equal(prepared.attachments[0].name, "large.webp");
    assert.equal(prepared.droppedNames.length, 0);
  } finally {
    if (originalImage === undefined)
      Reflect.deleteProperty(globalThis, "Image");
    else globalThis.Image = originalImage;
    if (originalDocument === undefined)
      Reflect.deleteProperty(globalThis, "document");
    else globalThis.document = originalDocument;
  }
});

test("stash preparation enforces the per-entry attachment budget", async () => {
  const attachments = Array.from({ length: 3 }, (_, index) => ({
    id: String(index),
    name: `${index}.png`,
    mime: "image/png",
    dataUrl: `data:image/png;base64,${"a".repeat(999_980)}`,
  }));
  const prepared = await prepareStashAttachments(attachments);
  assert.deepEqual(
    prepared.attachments.map((attachment) => attachment.id),
    ["0", "1"],
  );
  assert.deepEqual(prepared.droppedNames, ["2.png"]);
});

test("stash restore refuses to overflow the composer image limit", () => {
  const attachment = (id) => ({
    id,
    name: `${id}.png`,
    mime: "image/png",
    dataUrl: `data:image/png;base64,${id}`,
  });
  assert.equal(
    mergeStashAttachments(
      Array.from({ length: 8 }, (_, index) => attachment(`current-${index}`)),
      [attachment("stashed")],
    ),
    null,
  );
  assert.equal(
    mergeStashAttachments([attachment("same")], [attachment("same")])?.length,
    1,
  );
});

test("stash menu keeps the compact command-item structure and metrics", async () => {
  const [composer, styles] = await Promise.all([
    readFile(new URL("src/components/Composer.tsx", root), "utf8"),
    readFile(new URL("src/styles.css", root), "utf8"),
  ]);
  const menu = composer.slice(
    composer.indexOf("{stashOpen ? ("),
    composer.indexOf("{attachments.length > 0 ? ("),
  );

  assert.match(menu, /className={`composer__stash-row/);
  assert.doesNotMatch(menu, /composer__stash-restore/);
  assert.match(menu, /<StashCloseIcon \/>/);
  assert.match(styles, /\.composer__stash-menu\s*{[\s\S]*border-radius: 20px/);
  assert.match(styles, /\.composer__stash-row\s*{[\s\S]*min-height: 1\.75rem/);
  assert.match(
    styles,
    /\.composer__stash-row\.is-active\s*{\s*background: color-mix\(in srgb, var\(--foreground\) 9%, transparent\)/,
  );
});
