import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  codenameFromSeed,
  isTaskToolName,
  parseTaskArgs,
  parseTaskResult,
  parseTaskRole,
  taskInstanceName,
  taskLiveDetail,
  taskPresentation,
  taskRoleLabel,
} from "../../src/taskTool.ts";
import { presentTaskFailure } from "../../src/lib/userFacingError.ts";
import {
  finalizeRunningTools,
  MAX_PROVIDER_OUTPUT_BYTES,
  upsertToolOutputPart,
  upsertToolResultPart,
  upsertToolStartPart,
} from "../../src/messageParts.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");

test("isTaskToolName recognizes aliases", () => {
  assert.equal(isTaskToolName("task"), true);
  assert.equal(isTaskToolName("spawn_subagent"), true);
  assert.equal(isTaskToolName("agent"), true);
  assert.equal(isTaskToolName("read"), false);
});

test("parseTaskRole maps aliases", () => {
  assert.equal(parseTaskRole("explore"), "explore");
  assert.equal(parseTaskRole("code-review"), "reviewer");
  assert.equal(parseTaskRole("builder"), "build");
  assert.equal(parseTaskRole("general"), "build");
  assert.equal(parseTaskRole("build"), "build");
  assert.equal(parseTaskRole("wizard"), null);
  assert.equal(taskRoleLabel("build"), "Build");
});

test("parseTaskArgs reads description and role", () => {
  const a = parseTaskArgs(
    JSON.stringify({
      description: "Find auth",
      prompt: "Where is login?",
      subagent_type: "explore",
    }),
  );
  assert.equal(a.description, "Find auth");
  assert.equal(a.prompt, "Where is login?");
  assert.equal(a.role, "explore");
  assert.equal(taskRoleLabel(a.role), "Explore");
});

test("parseTaskResult extracts envelope body", () => {
  const raw = `<task role="explore" state="completed">
<summary>Find auth</summary>
<task_result>
Login lives in src/auth.ts
</task_result>
</task>`;
  const p = parseTaskResult(raw);
  assert.ok(p);
  assert.equal(p.role, "explore");
  assert.equal(p.state, "completed");
  assert.equal(p.summary, "Find auth");
  assert.match(p.body, /Login lives in src\/auth\.ts/);
});

test("parseTaskResult preserves structured task error state", () => {
  const parsed = parseTaskResult(`<task role="explore" state="error">
<summary>Inspect errors</summary>
<task_error>The delegated request timed out.</task_error>
</task>`);
  assert.equal(parsed?.state, "error");
  assert.equal(parsed?.body, "The delegated request timed out.");
  const failure = presentTaskFailure(parsed?.body ?? "");
  assert.equal(failure.title, "Connection interrupted");
});

test("task failure separates partial findings from provider error", () => {
  const failure = presentTaskFailure(
    [
      "Subagent stopped after partial progress: " +
        "The service is receiving too many requests. " +
        "Provider said: Retry after 10 seconds.",
      "Partial report:",
      "Found the relevant implementation in src/foo.ts.",
      "Processed child tools: read (ok), read (ok)",
    ].join("\n"),
  );

  assert.equal(failure.title, "Too many requests");
  assert.equal(
    failure.message,
    "The provider is receiving too many requests. Wait a moment, then retry.",
  );
  assert.equal(failure.detail, "Retry after 10 seconds.");
  assert.equal(
    failure.partialReport,
    "Found the relevant implementation in src/foo.ts.",
  );
  const visible = [
    failure.title,
    failure.message,
    failure.detail,
    failure.partialReport,
  ].join("\n");
  assert.doesNotMatch(visible, /Provider said:|Processed child tools:|Details:/);
  assert.equal(visible.match(/Retry after 10 seconds\./g)?.length, 1);
});

test("partial report keeps marker-like headings inside model text", () => {
  const failure = presentTaskFailure(
    [
      "Subagent stopped after partial progress: Request blocked",
      "Partial report:",
      "Findings",
      "Processed child tools: this heading is part of the report",
      "More evidence after the heading.",
      "Processed child tools: read (ok)",
    ].join("\n"),
  );
  assert.match(failure.partialReport, /this heading is part of the report/);
  assert.match(failure.partialReport, /More evidence after the heading/);
  assert.doesNotMatch(failure.partialReport, /read \(ok\)$/);
});

test("plain task failure hides raw technical implementation details", () => {
  const failure = presentTaskFailure(
    "internal request failed at reqwest::stream::decoder line 431",
  );
  assert.equal(failure.title, "Subagent could not finish");
  assert.equal(failure.message, "The delegated task stopped before it finished.");
  assert.equal(failure.detail, "");
  assert.equal(failure.partialReport, "");
  assert.doesNotMatch(`${failure.title}\n${failure.message}`, /reqwest|decoder|431/i);
});

test("taskLiveDetail prefers active child tool", () => {
  const call = {
    id: "task-1",
    name: "task",
    args: JSON.stringify({
      description: "Find auth",
      subagent_type: "explore",
    }),
    status: "running",
    children: [
      {
        id: "c1",
        name: "grep",
        args: JSON.stringify({ pattern: "login" }),
        status: "done",
        result: "ok",
      },
      {
        id: "c2",
        name: "read",
        args: JSON.stringify({ path: "src/auth.ts" }),
        status: "running",
      },
    ],
  };
  const detail = taskLiveDetail(call, (c) => {
    if (c.name === "read") return { title: "Read", detail: "src/auth.ts" };
    if (c.name === "grep") return { title: "Grep", detail: "login" };
    return { title: c.name, detail: "" };
  });
  assert.equal(detail, "Read · src/auth.ts");
});

test("taskPresentation titles by role", () => {
  const call = {
    id: "task-1",
    name: "task",
    args: JSON.stringify({
      description: "Review diff",
      subagent_type: "reviewer",
    }),
    status: "running",
  };
  const p = taskPresentation(call, () => ({ title: "x", detail: "" }));
  assert.equal(p.title, "Reviewer");
  assert.equal(p.role, "reviewer");
  assert.equal(p.detail, "Review diff");
  assert.match(p.codename, /^[a-z]+-[a-z]+$/);
});

test("codename is stable and prefers envelope name", () => {
  assert.equal(codenameFromSeed("task-abc"), codenameFromSeed("task-abc"));
  assert.notEqual(codenameFromSeed("task-a"), codenameFromSeed("task-b"));
  // Locked to Rust `codename_from_seed` (FNV-1a + same word lists).
  assert.equal(codenameFromSeed("task-1"), "solid-wren");
  assert.equal(codenameFromSeed("task-abc"), "bold-wolf");
  assert.equal(codenameFromSeed("call_xyz"), "bold-ash");
  assert.equal(codenameFromSeed("abc-def"), "calm-kite");
  // Live UI uses tool id; after complete prefers envelope name from same seed.
  assert.equal(
    taskInstanceName({
      id: "task-1",
      name: "task",
      args: "{}",
      status: "running",
    }),
    "solid-wren",
  );
  const withName = {
    id: "task-1",
    name: "task",
    args: "{}",
    status: "done",
    result: `<task role="build" name="eager-fox" state="completed">
<summary>x</summary>
<task_result>ok</task_result>
</task>`,
  };
  assert.equal(taskInstanceName(withName), "eager-fox");
  const p = parseTaskResult(withName.result);
  assert.equal(p.role, "build");
  assert.equal(p.name, "eager-fox");
});

test("namespaced child tool ids nest under parent without collision", () => {
  let m = {
    id: "a1",
    role: "assistant",
    content: "",
    createdAt: 1,
    parts: [],
  };
  m = upsertToolStartPart(m, {
    id: "task-a",
    name: "task",
    args: JSON.stringify({ description: "A", subagent_type: "explore" }),
  });
  m = upsertToolStartPart(m, {
    id: "task-b",
    name: "task",
    args: JSON.stringify({ description: "B", subagent_type: "explore" }),
  });
  // Same raw child id, different parent namespaces (as backend emits).
  m = upsertToolStartPart(m, {
    id: "task-a::call_0",
    name: "grep",
    args: JSON.stringify({ pattern: "a" }),
    parentId: "task-a",
  });
  m = upsertToolStartPart(m, {
    id: "task-b::call_0",
    name: "grep",
    args: JSON.stringify({ pattern: "b" }),
    parentId: "task-b",
  });
  m = upsertToolResultPart(m, {
    id: "task-a::call_0",
    name: "grep",
    ok: true,
    result: "a.ts:1",
    parentId: "task-a",
  });
  m = upsertToolResultPart(m, {
    id: "task-b::call_0",
    name: "grep",
    ok: true,
    result: "b.ts:1",
    parentId: "task-b",
  });
  assert.equal(m.parts.length, 2);
  const a = m.parts.find((p) => p.call.id === "task-a").call;
  const b = m.parts.find((p) => p.call.id === "task-b").call;
  assert.equal(a.children.length, 1);
  assert.equal(b.children.length, 1);
  assert.equal(a.children[0].id, "task-a::call_0");
  assert.equal(b.children[0].id, "task-b::call_0");
  assert.match(a.children[0].result, /a\.ts/);
  assert.match(b.children[0].result, /b\.ts/);
});

test("nested tool start/result attaches under parent task", () => {
  let m = {
    id: "a1",
    role: "assistant",
    content: "",
    createdAt: 1,
    parts: [],
  };
  m = upsertToolStartPart(m, {
    id: "task-1",
    name: "task",
    args: JSON.stringify({
      description: "Find auth",
      subagent_type: "explore",
    }),
  });
  m = upsertToolStartPart(m, {
    id: "child-1",
    name: "grep",
    args: JSON.stringify({ pattern: "login" }),
    parentId: "task-1",
    awaitingApproval: true,
    approvalReason: "Search generated files",
  });
  m = upsertToolResultPart(m, {
    id: "child-1",
    name: "grep",
    ok: true,
    result: "src/auth.ts:12",
    parentId: "task-1",
  });
  m = upsertToolResultPart(m, {
    id: "task-1",
    name: "task",
    ok: true,
    result: `<task role="explore" state="completed">
<summary>Find auth</summary>
<task_result>Done</task_result>
</task>`,
  });

  const parts = m.parts ?? [];
  assert.equal(parts.length, 1);
  assert.equal(parts[0].type, "tool");
  assert.equal(parts[0].call.id, "task-1");
  assert.equal(parts[0].call.status, "done");
  assert.equal(parts[0].call.children?.length, 1);
  assert.equal(parts[0].call.children[0].id, "child-1");
  assert.equal(parts[0].call.children[0].status, "done");
  assert.equal(
    parts[0].call.children[0].approvalReason,
    "Search generated files",
  );
  assert.match(parts[0].call.children[0].result ?? "", /auth/);
});

test("failed parent task preserves completed child results", () => {
  let m = {
    id: "a1",
    role: "assistant",
    content: "",
    createdAt: 1,
    parts: [],
  };
  m = upsertToolStartPart(m, {
    id: "task-1",
    name: "task",
    args: JSON.stringify({ description: "Inspect errors", subagent_type: "explore" }),
  });
  for (const [id, path] of [
    ["read-1", "src/foo.ts"],
    ["read-2", "src/bar.ts"],
  ]) {
    m = upsertToolStartPart(m, {
      id,
      name: "read",
      args: JSON.stringify({ path }),
      parentId: "task-1",
    });
    m = upsertToolResultPart(m, {
      id,
      name: "read",
      ok: true,
      result: `Contents of ${path}`,
      parentId: "task-1",
    });
  }
  m = upsertToolResultPart(m, {
    id: "task-1",
    name: "task",
    ok: false,
    result: "The service is receiving too many requests.",
  });

  const task = m.parts[0].call;
  assert.equal(task.status, "error");
  assert.deepEqual(
    task.children.map((child) => child.status),
    ["done", "done"],
  );
  assert.match(task.children[0].result, /foo\.ts/);
  assert.match(task.children[1].result, /bar\.ts/);
});

test("streamed bash output attaches to a nested subagent tool", () => {
  const message = {
    id: "a1",
    role: "assistant",
    content: "",
    createdAt: 1,
    parts: [
      {
        type: "tool",
        id: "task-1",
        call: {
          id: "task-1",
          name: "task",
          args: "{}",
          status: "running",
          children: [
            { id: "child-bash", name: "bash", args: "{}", status: "running" },
          ],
        },
      },
    ],
  };
  const next = upsertToolOutputPart(message, {
    id: "child-bash",
    text: "hello\n",
  });
  assert.equal(next.parts[0].call.children[0].result, "hello\n");
});

test("streamed tool output redacts secrets split across chunks", () => {
  const message = {
    id: "a1",
    role: "assistant",
    content: "",
    createdAt: 1,
    parts: [
      {
        type: "tool",
        id: "bash-1",
        call: { id: "bash-1", name: "bash", args: "{}", status: "running" },
      },
    ],
  };
  const prefix = "token eyJabcdefghij.eyJklmnopqrst.";
  const first = upsertToolOutputPart(message, { id: "bash-1", text: prefix });
  const next = upsertToolOutputPart(first, {
    id: "bash-1",
    text: "uvwxyz123456",
  });
  const result = next.parts[0].call.result;
  assert.match(result, /\[REDACTED TOKEN\]/);
  assert.doesNotMatch(result, /eyJabcdefghij/);
});

test("final and live tool output share one deterministic byte bound", () => {
  const message = {
    id: "a1",
    role: "assistant",
    content: "",
    createdAt: 1,
    parts: [
      {
        type: "tool",
        id: "bash-1",
        call: { id: "bash-1", name: "bash", args: "{}", status: "running" },
      },
    ],
  };
  const oversized = `HEAD${"\u{1f642}".repeat(MAX_PROVIDER_OUTPUT_BYTES)}TAIL`;
  const live = upsertToolOutputPart(message, {
    id: "bash-1",
    text: oversized,
  });
  const final = upsertToolResultPart(message, {
    id: "bash-1",
    name: "bash",
    ok: true,
    result: oversized,
  });
  const liveResult = live.parts[0].call.result;
  const finalResult = final.parts[0].call.result;

  assert.equal(
    Buffer.byteLength(liveResult, "utf8") <= MAX_PROVIDER_OUTPUT_BYTES,
    true,
  );
  assert.equal(
    Buffer.byteLength(finalResult, "utf8") <= MAX_PROVIDER_OUTPUT_BYTES,
    true,
  );
  assert.match(finalResult, /earlier output trimmed/);
  assert.equal(finalResult.endsWith("TAIL"), true);
  assert.equal(finalResult, liveResult);
});

test("cumulative tool output snapshots replace rather than duplicate live output", () => {
  const message = {
    id: "a1",
    role: "assistant",
    content: "",
    createdAt: 1,
    parts: [
      {
        type: "tool",
        id: "bash-1",
        call: { id: "bash-1", name: "bash", args: "{}", status: "running" },
      },
    ],
  };
  const first = upsertToolOutputPart(message, {
    id: "bash-1",
    text: "line1\n",
    replace: true,
  });
  const next = upsertToolOutputPart(first, {
    id: "bash-1",
    text: "line1\nline2\n",
    replace: true,
  });

  assert.equal(next.parts[0].call.result, "line1\nline2\n");
});

test("finalizeRunningTools closes nested children", () => {
  const m = {
    id: "a1",
    role: "assistant",
    content: "",
    createdAt: 1,
    parts: [
      {
        type: "tool",
        id: "task-1",
        call: {
          id: "task-1",
          name: "task",
          args: "{}",
          status: "running",
          children: [
            {
              id: "c1",
              name: "read",
              args: "{}",
              status: "running",
            },
          ],
        },
      },
    ],
  };
  const next = finalizeRunningTools(m, "Stopped", "error");
  const call = next.parts[0].call;
  assert.equal(call.status, "error");
  assert.equal(call.children[0].status, "error");
  assert.match(call.children[0].result ?? "", /Stopped/);
});

test("parent task result settles open nested children", () => {
  let m = {
    id: "a1",
    role: "assistant",
    content: "",
    createdAt: 1,
    parts: [],
  };
  m = upsertToolStartPart(m, {
    id: "task-1",
    name: "task",
    args: JSON.stringify({ description: "x", subagent_type: "explore" }),
  });
  m = upsertToolStartPart(m, {
    id: "child-open",
    name: "read",
    args: JSON.stringify({ path: "a.ts" }),
    parentId: "task-1",
  });
  m = upsertToolResultPart(m, {
    id: "task-1",
    name: "task",
    ok: true,
    result: `<task role="explore" state="completed">
<summary>x</summary>
<task_result>ok</task_result>
</task>`,
  });
  const kids = m.parts[0].call.children;
  assert.equal(kids.length, 1);
  assert.equal(kids[0].status, "done");
  assert.match(kids[0].result ?? "", /Subagent finished/);
});

test("awaitingApproval is wired for parked tools including task", () => {
  let m = {
    id: "a1",
    role: "assistant",
    content: "",
    createdAt: 1,
    parts: [],
  };
  m = upsertToolStartPart(m, {
    id: "task-1",
    name: "task",
    args: JSON.stringify({ description: "x", subagent_type: "general" }),
    awaitingApproval: true,
    approvalReason: "Spawn a subagent with its own tools",
  });
  assert.equal(m.parts[0].call.status, "awaiting");
  assert.match(m.parts[0].call.approvalReason ?? "", /subagent/i);
});

test("stream handlers and UI wire parentId + task card", () => {
  const auth = readFileSync(join(root, "src/auth.ts"), "utf8");
  const app = readFileSync(join(root, "src/App.tsx"), "utf8");
  const list = readFileSync(
    join(root, "src/components/MessageList.tsx"),
    "utf8",
  );
  const batch = readFileSync(join(root, "src/streamBatch.ts"), "utf8");
  const chat = readFileSync(join(root, "src-tauri/src/chat.rs"), "utf8");
  const sub = readFileSync(join(root, "src-tauri/src/subagent.rs"), "utf8");
  assert.match(auth, /parentId/);
  assert.match(batch, /parentId/);
  assert.match(app, /parentId/);
  assert.match(app, /awaitingApproval/);
  assert.match(list, /is-task/);
  assert.match(list, /tool-task__children/);
  assert.match(list, /isTaskToolName/);
  assert.match(list, /presentTaskFailure/);
  assert.doesNotMatch(list, /Details:/);
  assert.match(chat, /parent_id: Some\(parent_id\)/);
  assert.match(chat, /child_tools: Some/);
  assert.match(sub, /ChildToolEvent::Start/);
  assert.match(sub, /clip_child_progress_result/);
});
