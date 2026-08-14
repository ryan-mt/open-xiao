import { resolveMessageParts, type TimelineGroup } from "./messageParts.ts";
import type { Message, ToolCall } from "./types";

export type PlanStepStatus =
  | "pending"
  | "inProgress"
  | "completed"
  | "cancelled";

export type PlanStep = {
  step: string;
  status: PlanStepStatus;
};

/** Latest agent todo list for a thread (from todowrite). */
export type ActivePlanState = {
  createdAt: number;
  messageId: string;
  toolId: string;
  steps: PlanStep[];
  explanation?: string | null;
};

export function isTodoToolName(name: string): boolean {
  const n = name.toLowerCase().replace(/[\s-]+/g, "_");
  return n === "todowrite" || n === "todo_write" || n === "todo";
}

/** Keep one latest todo snapshot at the first todo position in an assistant turn. */
export function foldTodoTimelineGroups(
  groups: readonly TimelineGroup[],
): TimelineGroup[] {
  let latestTodo: ToolCall | null = null;
  let todoCount = 0;
  for (const group of groups) {
    if (group.kind !== "tools") continue;
    for (const call of group.calls) {
      if (!isTodoToolName(call.name)) continue;
      latestTodo = call;
      todoCount += 1;
    }
  }
  if (!latestTodo || todoCount < 2) return groups.slice();

  const folded: TimelineGroup[] = [];
  let inserted = false;
  for (const group of groups) {
    if (group.kind !== "tools") {
      folded.push(group);
      continue;
    }
    const calls: ToolCall[] = [];
    for (const call of group.calls) {
      if (!isTodoToolName(call.name)) {
        calls.push(call);
        continue;
      }
      if (!inserted) {
        calls.push(latestTodo);
        inserted = true;
      }
    }
    if (calls.length > 0) folded.push({ ...group, calls });
  }
  return folded;
}

function normalizeStatus(raw: unknown): PlanStepStatus {
  if (typeof raw !== "string") return "pending";
  const s = raw.trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (s === "completed" || s === "complete" || s === "done") return "completed";
  if (s === "in_progress" || s === "inprogress" || s === "active") {
    return "inProgress";
  }
  if (s === "cancelled" || s === "canceled") return "cancelled";
  return "pending";
}

function stepFromUnknown(entry: unknown): PlanStep | null {
  if (!entry || typeof entry !== "object") return null;
  const rec = entry as Record<string, unknown>;
  const content =
    typeof rec.content === "string"
      ? rec.content.trim()
      : typeof rec.step === "string"
        ? rec.step.trim()
        : typeof rec.text === "string"
          ? rec.text.trim()
          : "";
  if (!content) return null;
  return { step: content, status: normalizeStatus(rec.status) };
}

function stepsFromTodosArray(todos: unknown): PlanStep[] | null {
  if (!Array.isArray(todos) || todos.length === 0) return null;
  const steps: PlanStep[] = [];
  for (const entry of todos) {
    const step = stepFromUnknown(entry);
    if (step) steps.push(step);
  }
  return steps.length > 0 ? steps : null;
}

/** Parse plan steps from todowrite tool args or result payload. */
export function parsePlanStepsFromToolPayload(
  raw: string | undefined | null,
): PlanStep[] | null {
  if (!raw?.trim()) return null;
  const text = raw.trim();

  // Direct JSON object/array
  try {
    const parsed: unknown = JSON.parse(text);
    if (Array.isArray(parsed)) return stepsFromTodosArray(parsed);
    if (parsed && typeof parsed === "object") {
      const rec = parsed as Record<string, unknown>;
      const fromTodos = stepsFromTodosArray(rec.todos);
      if (fromTodos) return fromTodos;
      const fromPlan = stepsFromTodosArray(rec.plan);
      if (fromPlan) return fromPlan;
    }
  } catch {
    /* fall through */
  }

  // Backend result: "Updated todos: 2/4 [...]" or legacy "Updated todos:\n[...]"
  const jsonStart = text.indexOf("[");
  const jsonObj = text.indexOf("{");
  const start =
    jsonStart >= 0 && (jsonObj < 0 || jsonStart < jsonObj)
      ? jsonStart
      : jsonObj;
  if (start >= 0) {
    // Prefer balanced JSON slice so trailing prose never breaks parse.
    const slice = extractJsonValue(text, start);
    if (slice) {
      try {
        const parsed: unknown = JSON.parse(slice);
        if (Array.isArray(parsed)) return stepsFromTodosArray(parsed);
        if (parsed && typeof parsed === "object") {
          const rec = parsed as Record<string, unknown>;
          return (
            stepsFromTodosArray(rec.todos) ?? stepsFromTodosArray(rec.plan)
          );
        }
      } catch {
        /* ignore */
      }
    }
  }

  return null;
}

/** Extract a balanced JSON array/object starting at `start`. */
function extractJsonValue(text: string, start: number): string | null {
  const open = text[start];
  if (open !== "[" && open !== "{") return null;
  const close = open === "[" ? "]" : "}";
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escape) {
        escape = false;
        continue;
      }
      if (ch === "\\") {
        escape = true;
        continue;
      }
      if (ch === "\"") inString = false;
      continue;
    }
    if (ch === "\"") {
      inString = true;
      continue;
    }
    if (ch === open) depth += 1;
    else if (ch === close) {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  // Fallback for partial/streaming payloads.
  return text.slice(start);
}

/**
 * Prefer tool result over args: args are the model call payload and can lag
 * behind a later "Updated todos: …" result, or stay stuck on the first write.
 */
export function planStepsFromToolCall(call: ToolCall): PlanStep[] | null {
  return (
    parsePlanStepsFromToolPayload(call.result) ??
    parsePlanStepsFromToolPayload(call.args)
  );
}

/** True when any step is still open (pending / in progress). */
export function planHasOpenSteps(steps: readonly PlanStep[]): boolean {
  return steps.some(
    (s) => s.status === "pending" || s.status === "inProgress",
  );
}

/**
 * When the agent finishes a turn without a final todowrite, open steps would
 * otherwise spin forever in the Plan panel. Mark them completed on success.
 */
export function completeOpenPlanSteps(
  steps: readonly PlanStep[],
): PlanStep[] {
  if (!planHasOpenSteps(steps)) return steps.slice();
  return steps.map((s) =>
    s.status === "pending" || s.status === "inProgress"
      ? { ...s, status: "completed" as const }
      : s,
  );
}

function serializeTodosPayload(steps: readonly PlanStep[]): string {
  return JSON.stringify(
    steps.map((s) => ({
      content: s.step,
      status:
        s.status === "inProgress"
          ? "in_progress"
          : s.status === "cancelled"
            ? "cancelled"
            : s.status === "completed"
              ? "completed"
              : "pending",
    })),
  );
}

/**
 * On a successful stream settle, flip leftover open todos to completed on the
 * latest todowrite tool call so Plan / tool rows show  N/N instead of spinning.
 */
function settledTodoResult(steps: readonly PlanStep[]): string {
  const completed = completeOpenPlanSteps(steps);
  const compact = serializeTodosPayload(completed);
  const done = completed.filter(
    (s) => s.status === "completed" || s.status === "cancelled",
  ).length;
  return `Updated todos: ${done}/${completed.length} ${compact}`;
}

function messageHasTodoTool(m: Message): boolean {
  const parts = m.parts ?? [];
  if (parts.length > 0) {
    return parts.some(
      (p) => p.type === "tool" && isTodoToolName(p.call.name),
    );
  }
  return (m.toolCalls ?? []).some((t) => isTodoToolName(t.name));
}

export function settleIncompleteTodosOnMessage(m: Message): Message {
  const parts = m.parts ?? [];
  if (parts.length === 0) {
    const tools = m.toolCalls;
    if (!tools?.length) return m;
    let changed = false;
    const nextTools = tools.map((t) => {
      if (!isTodoToolName(t.name)) return t;
      const steps = planStepsFromToolCall(t);
      if (!steps || !planHasOpenSteps(steps)) return t;
      changed = true;
      return { ...t, result: settledTodoResult(steps) };
    });
    return changed ? { ...m, toolCalls: nextTools } : m;
  }

  let changed = false;
  const nextParts = parts.map((p) => {
    if (p.type !== "tool" || !isTodoToolName(p.call.name)) return p;
    const steps = planStepsFromToolCall(p.call);
    if (!steps || !planHasOpenSteps(steps)) return p;
    changed = true;
    return {
      ...p,
      call: {
        ...p.call,
        result: settledTodoResult(steps),
      },
    };
  });
  if (!changed) return m;

  // Keep legacy toolCalls mirror in sync without importing messageParts helpers
  // (Node test runner cannot resolve extensionless TS re-exports cleanly).
  const nextToolCalls = nextParts
    .filter((p): p is Extract<typeof p, { type: "tool" }> => p.type === "tool")
    .map((p) => p.call);

  return {
    ...m,
    parts: nextParts,
    toolCalls: nextToolCalls.length > 0 ? nextToolCalls : m.toolCalls,
  };
}

/**
 * Close leftover open todos on the latest todowrite in the thread.
 * Models often create the plan on turn 1 and never rewrite it on the final
 * turn — settling only the streaming message leaves Plan stuck at 0/N.
 */
export function settleIncompleteTodosInMessages(
  messages: ReadonlyArray<Message>,
): Message[] {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i];
    if (!m || m.role !== "assistant") continue;
    if (!messageHasTodoTool(m)) continue;
    const settled = settleIncompleteTodosOnMessage(m);
    if (settled === m) return messages as Message[];
    const next = messages.slice();
    next[i] = settled;
    return next;
  }
  return messages as Message[];
}

/**
 * Latest todowrite in the thread (newest message first).
 * Persists across follow-up turns until a newer todowrite replaces it.
 */
export function deriveActivePlanState(
  messages: ReadonlyArray<Message>,
): ActivePlanState | null {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i];
    if (!m || m.role !== "assistant") continue;
    const parts = resolveMessageParts(m);
    for (let j = parts.length - 1; j >= 0; j -= 1) {
      const p = parts[j];
      if (!p || p.type !== "tool") continue;
      if (!isTodoToolName(p.call.name)) continue;
      const steps = planStepsFromToolCall(p.call);
      if (!steps) continue;
      return {
        createdAt: m.createdAt,
        messageId: m.id,
        toolId: p.call.id,
        steps,
      };
    }
  }
  return null;
}

export function planProgress(plan: ActivePlanState): {
  done: number;
  total: number;
  activeLabel: string | null;
} {
  const total = plan.steps.length;
  let done = 0;
  let activeLabel: string | null = null;
  for (const s of plan.steps) {
    if (s.status === "completed" || s.status === "cancelled") done += 1;
    else if (s.status === "inProgress" && !activeLabel) activeLabel = s.step;
  }
  return { done, total, activeLabel };
}

export function planInlineSummary(steps: readonly PlanStep[]): {
  done: number;
  total: number;
  label: string;
  allDone: boolean;
} {
  const total = steps.length;
  const done = steps.filter(
    (step) => step.status === "completed" || step.status === "cancelled",
  ).length;
  const label =
    steps.find((step) => step.status === "inProgress")?.step ??
    steps.find((step) => step.status === "pending")?.step ??
    steps[steps.length - 1]?.step ??
    "Plan";
  return { done, total, label, allDone: total > 0 && done === total };
}

export function formatPlanTimestamp(ts: number): string {
  try {
    return new Date(ts).toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  } catch {
    return "";
  }
}
