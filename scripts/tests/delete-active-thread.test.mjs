import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const store = readFileSync(join(root, "src/store.ts"), "utf8");
const app = readFileSync(join(root, "src/App.tsx"), "utf8");

/** Mirror of pickNextLiveThreadId — keep in sync with store.ts. */
function pickNextLiveThreadId(threads, excludeId) {
  for (const t of threads) {
    if (excludeId && t.id === excludeId) continue;
    if (t.archivedAt != null) continue;
    return t.id;
  }
  return null;
}

test("pickNextLiveThreadId skips archived chats", () => {
  const threads = [
    { id: "arch-1", archivedAt: 99 },
    { id: "live-1", archivedAt: null },
  ];
  assert.equal(pickNextLiveThreadId(threads, "gone"), "live-1");
  assert.equal(pickNextLiveThreadId(threads, "live-1"), null);
  assert.equal(pickNextLiveThreadId(threads, null), "live-1");
});

test("store exports live-thread helpers", () => {
  assert.match(store, /export function liveThreads/);
  assert.match(store, /export function pickNextLiveThreadId/);
  assert.match(store, /archivedAt == null/);
  // loadActiveId must not revive archived stored ids
  assert.match(store, /if \(live\.length === 0\) return null/);
  assert.match(store, /live\.some\(\(t\) => t\.id === stored\)/);
});

test("handleDelete never selects archived next thread", () => {
  assert.match(app, /pickNextLiveThreadId/);
  assert.match(app, /Never jump into an archived chat/);
  assert.doesNotMatch(
    app,
    /if \(activeId === id\) setActiveId\(next\[0\]\.id\)/,
  );
  // Hydrate creates a live thread when only archives remain
  assert.match(app, /liveThreads\(nextThreads\)\.length === 0/);
});
