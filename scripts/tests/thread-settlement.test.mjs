import assert from "node:assert/strict";
import test from "node:test";

import {
  canSettle,
  canSnooze,
  effectiveSettled,
  effectiveSnoozed,
  isSidebarThreadVisible,
  resolveSidebarThreadBucket,
  wakeThreadForAttention,
} from "../../src/components/Sidebar.logic.ts";

const NOW = 1_800_000_000_000;
const DAY_MS = 86_400_000;

function thread(overrides = {}) {
  return {
    id: "thread-1",
    createdAt: NOW - 30 * DAY_MS,
    updatedAt: NOW - 30 * DAY_MS,
    settledAt: null,
    snoozedUntil: null,
    pinned: false,
    ...overrides,
  };
}

test("explicit and inactive threads settle while recent threads stay active", () => {
  assert.equal(
    effectiveSettled(thread({ settledAt: NOW - DAY_MS }), {
      nowMs: NOW,
      autoSettleAfterDays: 14,
    }),
    true,
  );
  assert.equal(
    effectiveSettled(thread(), {
      nowMs: NOW,
      autoSettleAfterDays: 14,
    }),
    true,
  );
  assert.equal(
    effectiveSettled(thread({ updatedAt: NOW - DAY_MS }), {
      nowMs: NOW,
      autoSettleAfterDays: 14,
    }),
    false,
  );
});

test("working and snoozed threads never present as settled", () => {
  const settled = thread({ settledAt: NOW - DAY_MS });
  assert.equal(
    effectiveSettled(settled, {
      nowMs: NOW,
      autoSettleAfterDays: 14,
      working: true,
    }),
    false,
  );

  const snoozed = thread({
    settledAt: NOW - DAY_MS,
    snoozedUntil: NOW + DAY_MS,
  });
  assert.equal(effectiveSnoozed(snoozed, NOW), true);
  assert.equal(
    effectiveSettled(snoozed, {
      nowMs: NOW,
      autoSettleAfterDays: 14,
    }),
    false,
  );
});

test("a parked thread needing attention returns to the active shelf", () => {
  assert.equal(
    resolveSidebarThreadBucket(
      thread({
        settledAt: NOW - DAY_MS,
        snoozedUntil: NOW + DAY_MS,
      }),
      {
        nowMs: NOW,
        autoSettleAfterDays: 14,
        working: false,
        needsAttention: true,
      },
    ),
    "active",
  );
});

test("attention permanently wakes a parked thread", () => {
  assert.deepEqual(
    wakeThreadForAttention(
      thread({
        updatedAt: NOW - 30 * DAY_MS,
        settledAt: NOW - DAY_MS,
        snoozedUntil: NOW + DAY_MS,
        wokeAt: null,
      }),
      NOW,
    ),
    thread({
      updatedAt: NOW,
      settledAt: null,
      snoozedUntil: null,
      wokeAt: NOW,
    }),
  );
});

test("a thread needing attention cannot be settled", () => {
  assert.equal(
    canSettle({ working: false, needsAttention: true }),
    false,
  );
});

test("a thread needing attention cannot be snoozed", () => {
  assert.equal(
    canSnooze(thread(), {
      nowMs: NOW,
      working: false,
      needsAttention: true,
    }),
    false,
  );
});

test("pinning blocks only automatic settlement", () => {
  assert.equal(
    effectiveSettled(thread({ pinned: true }), {
      nowMs: NOW,
      autoSettleAfterDays: 14,
    }),
    false,
  );
  assert.equal(
    effectiveSettled(thread({ pinned: true, settledAt: NOW - DAY_MS }), {
      nowMs: NOW,
      autoSettleAfterDays: 14,
    }),
    true,
  );
});

test("new drafts stay out of navigation until the first message", () => {
  assert.equal(isSidebarThreadVisible({ messages: [] }), false);
  assert.equal(
    isSidebarThreadVisible({
      messages: [{ id: "user-1", role: "user", content: "hello" }],
    }),
    true,
  );
});
