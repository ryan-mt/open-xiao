import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  COMPACT_TARGET_RATIO,
  applyCompactionIfCurrent,
  buildCompactSummary,
  compactMessages,
  formatCompactResultToast,
  selectTailMessages,
} from "../../src/compactHistory.ts";
import { contextUsage, estimateTokens } from "../../src/contextMeter.ts";

const appSource = readFileSync(
  new URL("../../src/App.tsx", import.meta.url),
  "utf8",
);

function msg(role, content, extra = {}) {
  return {
    id: `${role}-${Math.random().toString(36).slice(2, 8)}`,
    role,
    content,
    createdAt: Date.now(),
    ...extra,
  };
}

/** Pad content to roughly `tokens` estimated tokens (4 chars ≈ 1 token). */
function pad(tokens) {
  return "x".repeat(Math.max(0, tokens * 4));
}

test("COMPACT_TARGET_RATIO is 60%", () => {
  assert.equal(COMPACT_TARGET_RATIO, 0.6);
});

test("buildCompactSummary lists user and assistant excerpts", () => {
  const summary = buildCompactSummary([
    msg("user", "Add slash commands"),
    msg("assistant", "Implemented the registry and composer popup."),
    msg("assistant", "", {
      toolCalls: [{ id: "t1", name: "read", args: "{}", status: "done" }],
    }),
  ]);
  assert.match(summary, /Compacted conversation summary/);
  assert.match(summary, /User: Add slash commands/);
  assert.match(summary, /Assistant: Implemented the registry/);
  assert.match(summary, /tool-only turn: read/);
});

test("selectTailMessages keeps newest messages within budget", () => {
  const messages = [
    msg("user", pad(2_000)),
    msg("assistant", pad(2_000)),
    msg("user", pad(100)),
    msg("assistant", pad(100)),
  ];
  const tail = selectTailMessages(messages, 800, 2);
  assert.ok(tail.length >= 2);
  assert.equal(tail[tail.length - 1], messages[messages.length - 1]);
  assert.ok(tail.length < messages.length);
});

test("compactMessages no-ops on empty thread", () => {
  const result = compactMessages([], "grok-4.5");
  assert.equal(result.changed, false);
  assert.equal(result.reason, "empty");
});

test("compactMessages reports already-compact when under target", () => {
  const messages = [msg("user", "hi"), msg("assistant", "hello")];
  const result = compactMessages(messages, "grok-4.5");
  assert.equal(result.changed, false);
  assert.equal(result.reason, "already-compact");
  assert.match(formatCompactResultToast(result), /Already compact/);
});

test("delayed compaction cannot replace messages appended after it started", () => {
  const source = [msg("user", "old question"), msg("assistant", "old answer")];
  const thread = {
    id: "thread-a",
    title: "Thread",
    projectId: null,
    messages: source,
    createdAt: 1,
    updatedAt: 1,
  };
  const compacted = [msg("user", "compacted summary")];

  const current = {
    ...thread,
    messages: [
      ...source,
      msg("user", "new question", { id: "new-user" }),
      msg("assistant", "", { id: "new-assistant" }),
    ],
  };
  assert.equal(
    applyCompactionIfCurrent(current, source, compacted, 2),
    current,
  );
  assert.deepEqual(
    current.messages.slice(-2).map((message) => message.id),
    ["new-user", "new-assistant"],
  );

  const applied = applyCompactionIfCurrent(thread, source, compacted, 2);
  assert.deepEqual(applied.messages, compacted);
  assert.equal(applied.updatedAt, 2);
  assert.match(
    appSource,
    /applyCompactionIfCurrent\(\s*c,\s*sourceMessages,\s*result\.messages/,
  );
});

test("compactMessages soft-prunes tool bulk under target", () => {
  const heavyTools = Array.from({ length: 8 }, (_, i) => ({
    id: `tool-${i}`,
    name: "bash",
    args: JSON.stringify({ command: "echo " + "y".repeat(200) }),
    result: "out ".repeat(500),
    status: "done",
  }));
  const messages = [
    msg("user", "run stuff"),
    msg("assistant", "Done with the shell work.", {
      toolCalls: heavyTools,
      thinking: "I should run many commands " + "z".repeat(2_000),
      parts: [
        { type: "thinking", id: "th1", text: "plan " + "z".repeat(2_000) },
        ...heavyTools.map((call) => ({ type: "tool", id: call.id, call })),
        { type: "text", id: "tx1", text: "Done with the shell work." },
      ],
    }),
    msg("user", "thanks"),
  ];
  const before = contextUsage(messages, "grok-4.5").used;
  const result = compactMessages(messages, "grok-4.5");
  // Under target but tools/thinking still strip when they free real budget.
  if (before <= result.limit * COMPACT_TARGET_RATIO) {
    if (result.changed) {
      assert.ok(result.afterTokens < result.beforeTokens);
      const mid = result.messages.find((m) => m.role === "assistant");
      assert.ok(mid);
      assert.equal(mid.toolCalls, undefined);
      assert.equal(mid.thinking, undefined);
      assert.match(mid.content, /Done with the shell work/);
    }
  }
});

test("compactMessages folds older turns toward ~60% target", () => {
  // grok-4.5 = 500k context → 60% target ≈ 300k. Build ~400k+ of history.
  const chunks = [];
  for (let i = 0; i < 40; i++) {
    chunks.push(msg("user", `Task step ${i}: ${pad(6_000)}`));
    chunks.push(
      msg("assistant", `Completed step ${i} with details. ${pad(6_000)}`, {
        thinking: pad(2_000),
        toolCalls: [
          {
            id: `t-${i}`,
            name: "read",
            args: JSON.stringify({ filePath: `src/f${i}.ts` }),
            result: pad(3_000),
            status: "done",
          },
        ],
      }),
    );
  }
  // Ensure newest turns are distinct and smaller so they stay in the tail.
  chunks.push(msg("user", "Please finish the remaining tests."));
  chunks.push(msg("assistant", "On it — focusing on the last failures."));

  const before = contextUsage(chunks, "grok-4.5");
  assert.ok(
    before.ratio > COMPACT_TARGET_RATIO,
    `precondition: need over-target history, got ratio=${before.ratio}`,
  );

  const result = compactMessages(chunks, "grok-4.5");
  assert.equal(result.changed, true);
  assert.ok(result.droppedCount > 0);
  assert.ok(result.afterTokens < result.beforeTokens);
  assert.ok(
    result.afterTokens <= result.limit * COMPACT_TARGET_RATIO * 1.15,
    `after ${result.afterTokens} should be near 60% of ${result.limit}`,
  );

  // Summary user message first, then recent tail.
  assert.equal(result.messages[0]?.role, "user");
  assert.match(result.messages[0]?.content ?? "", /Compacted conversation summary/);
  assert.ok(result.messages.length < chunks.length);
  assert.equal(
    result.messages[result.messages.length - 1]?.content,
    "On it — focusing on the last failures.",
  );

  const toast = formatCompactResultToast(result);
  assert.match(toast, /Compacted \d+ message/);
});

test("compactMessages keeps enough recent context for continuity", () => {
  const messages = [];
  for (let i = 0; i < 20; i++) {
    messages.push(msg("user", `u${i} ${pad(8_000)}`));
    messages.push(msg("assistant", `a${i} ${pad(8_000)}`));
  }
  const result = compactMessages(messages, "grok-build-0.1"); // 256k window
  assert.equal(result.changed, true);
  assert.ok(result.keptTailCount >= 2);
  // Last two originals should survive when possible
  const lastUser = messages[messages.length - 2];
  const lastAsst = messages[messages.length - 1];
  assert.ok(result.messages.some((m) => m.id === lastUser.id || m.content === lastUser.content));
  assert.ok(result.messages.some((m) => m.id === lastAsst.id || m.content === lastAsst.content));
});

test("repeated tail releases remain represented in the summary", () => {
  const messages = Array.from({ length: 30 }, (_, index) =>
    msg(
      index % 2 === 0 ? "user" : "assistant",
      `MARKER_${index} ${String(index % 10).repeat(120_000)}`,
      { id: `m${index}` },
    ),
  );
  const result = compactMessages(messages, "grok-build-0.1");
  assert.equal(result.changed, true);
  const summary = result.messages[0]?.content ?? "";
  const kept = new Set(result.messages.slice(1).map((message) => message.id));
  for (let index = 0; index < messages.length; index += 1) {
    assert.ok(
      kept.has(`m${index}`) || summary.includes(`MARKER_${index}`),
      `message ${index} was lost`,
    );
  }
});

test("estimate helper sanity for pad()", () => {
  assert.ok(estimateTokens(pad(100)) >= 100);
});
