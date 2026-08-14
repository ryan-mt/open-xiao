import assert from "node:assert/strict";
import test from "node:test";

import {
  completeOpenPlanSteps,
  deriveActivePlanState,
  foldTodoTimelineGroups,
  parsePlanStepsFromToolPayload,
  planHasOpenSteps,
  planInlineSummary,
  planProgress,
  planStepsFromToolCall,
  settleIncompleteTodosInMessages,
  settleIncompleteTodosOnMessage,
} from "../../src/plan.ts";

test("todo snapshots update one chip anchored at the first plan position", () => {
  const oldTodo = {
    id: "todo-old",
    name: "todowrite",
    args: '{"todos":[{"content":"Inspect","status":"in_progress"}]}',
    status: "done",
  };
  const newTodo = {
    id: "todo-new",
    name: "todowrite",
    args: '{"todos":[{"content":"Inspect","status":"completed"}]}',
    status: "done",
  };
  const groups = foldTodoTimelineGroups([
    { kind: "tools", key: "first", calls: [oldTodo] },
    { kind: "text", key: "checkpoint", text: "Checkpoint" },
    { kind: "tools", key: "latest", calls: [newTodo, { ...oldTodo, id: "read", name: "read" }] },
  ]);

  assert.deepEqual(groups.map((group) => group.kind), ["tools", "text", "tools"]);
  assert.equal(groups[0].calls[0].id, "todo-new");
  assert.deepEqual(groups[2].calls.map((call) => call.id), ["read"]);
});

test("inline plan summary follows the latest T3 folded-plan label priority", () => {
  assert.deepEqual(
    planInlineSummary([
      { step: "Inspect current UI", status: "completed" },
      { step: "Wire child events", status: "inProgress" },
      { step: "Run verification", status: "pending" },
    ]),
    {
      done: 1,
      total: 3,
      label: "Wire child events",
      allDone: false,
    },
  );

  assert.equal(
    planInlineSummary([
      { step: "First pending", status: "pending" },
      { step: "Second pending", status: "pending" },
    ]).label,
    "First pending",
  );

  assert.deepEqual(
    planInlineSummary([
      { step: "Implemented", status: "completed" },
      { step: "Superseded", status: "cancelled" },
    ]),
    {
      done: 2,
      total: 2,
      label: "Superseded",
      allDone: true,
    },
  );
});

test("normalize and parse prefer completed aliases", () => {
  const steps = parsePlanStepsFromToolPayload(
    JSON.stringify({
      todos: [
        { content: "A", status: "done" },
        { content: "B", status: "in_progress" },
        { content: "C", status: "pending" },
      ],
    }),
  );
  assert.ok(steps);
  assert.equal(steps[0].status, "completed");
  assert.equal(steps[1].status, "inProgress");
  assert.equal(steps[2].status, "pending");
});

test("planStepsFromToolCall prefers result over stale args", () => {
  const call = {
    id: "t1",
    name: "todowrite",
    args: JSON.stringify({
      todos: [
        { content: "One", status: "in_progress" },
        { content: "Two", status: "pending" },
      ],
    }),
    result:
      'Updated todos: 2/2 [{"content":"One","status":"completed"},{"content":"Two","status":"completed"}]',
    status: "done",
  };
  const steps = planStepsFromToolCall(call);
  assert.ok(steps);
  assert.equal(steps.every((s) => s.status === "completed"), true);
  assert.equal(planHasOpenSteps(steps), false);
});

test("completeOpenPlanSteps closes leftover open items", () => {
  const closed = completeOpenPlanSteps([
    { step: "Rewrite CSS", status: "inProgress" },
    { step: "Wrap panels", status: "pending" },
    { step: "Sync tests", status: "pending" },
  ]);
  assert.equal(closed.every((s) => s.status === "completed"), true);
  const prog = planProgress({
    createdAt: 1,
    messageId: "m",
    toolId: "t",
    steps: closed,
  });
  assert.equal(prog.done, 3);
  assert.equal(prog.total, 3);
});

test("settleIncompleteTodosOnMessage rewrites latest open todowrite", () => {
  const message = {
    id: "a1",
    role: "assistant",
    content: "Done.",
    createdAt: 100,
    parts: [
      {
        type: "tool",
        id: "todo1",
        call: {
          id: "todo1",
          name: "todowrite",
          args: JSON.stringify({
            todos: [
              { content: "Rewrite right-panel CSS", status: "in_progress" },
              { content: "Wrap PlanSidebar", status: "pending" },
              { content: "Sync usePresence", status: "pending" },
            ],
          }),
          result:
            'Updated todos: 0/3 [{"content":"Rewrite right-panel CSS","status":"in_progress"},{"content":"Wrap PlanSidebar","status":"pending"},{"content":"Sync usePresence","status":"pending"}]',
          status: "done",
        },
      },
      { type: "text", id: "txt", text: "Done." },
    ],
  };

  const settled = settleIncompleteTodosOnMessage(message);
  const plan = deriveActivePlanState([settled]);
  assert.ok(plan);
  assert.equal(plan.steps.length, 3);
  assert.equal(
    plan.steps.every((s) => s.status === "completed"),
    true,
  );
  const prog = planProgress(plan);
  assert.equal(prog.done, 3);
  assert.equal(prog.total, 3);
  assert.match(settled.parts[0].call.result, /Updated todos: 3\/3/);
});

test("settleIncompleteTodosOnMessage is a no-op when already complete", () => {
  const message = {
    id: "a2",
    role: "assistant",
    content: "ok",
    createdAt: 1,
    parts: [
      {
        type: "tool",
        id: "todo2",
        call: {
          id: "todo2",
          name: "todowrite",
          args: JSON.stringify({
            todos: [{ content: "Only", status: "completed" }],
          }),
          result:
            'Updated todos: 1/1 [{"content":"Only","status":"completed"}]',
          status: "done",
        },
      },
    ],
  };
  const settled = settleIncompleteTodosOnMessage(message);
  assert.equal(settled, message);
});

test("settleIncompleteTodosInMessages closes plan on earlier turn", () => {
  const planMsg = {
    id: "a-plan",
    role: "assistant",
    content: "Starting.",
    createdAt: 10,
    parts: [
      {
        type: "tool",
        id: "todo-early",
        call: {
          id: "todo-early",
          name: "todowrite",
          args: JSON.stringify({
            todos: [
              { content: "Tạo component BootSplash", status: "in_progress" },
              { content: "Thêm CSS animation", status: "pending" },
              { content: "Gắn vào App.tsx", status: "pending" },
              { content: "Verify TypeScript build", status: "pending" },
            ],
          }),
          result:
            'Updated todos: 0/4 [{"content":"Tạo component BootSplash","status":"in_progress"},{"content":"Thêm CSS animation","status":"pending"},{"content":"Gắn vào App.tsx","status":"pending"},{"content":"Verify TypeScript build","status":"pending"}]',
          status: "done",
        },
      },
      { type: "text", id: "t1", text: "Starting." },
    ],
  };
  const finalMsg = {
    id: "a-final",
    role: "assistant",
    content: "Boot splash is done.",
    createdAt: 20,
    parts: [{ type: "text", id: "t2", text: "Boot splash is done." }],
  };

  const settled = settleIncompleteTodosInMessages([
    { id: "u1", role: "user", content: "do it", createdAt: 1 },
    planMsg,
    { id: "u2", role: "user", content: "continue", createdAt: 15 },
    finalMsg,
  ]);
  const plan = deriveActivePlanState(settled);
  assert.ok(plan);
  assert.equal(plan.messageId, "a-plan");
  assert.equal(
    plan.steps.every((s) => s.status === "completed"),
    true,
  );
  assert.equal(planProgress(plan).done, 4);
  assert.equal(settled[settled.length - 1], finalMsg);
});
