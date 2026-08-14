import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { AccessMode, AgentMode, PermissionMode } from "./models";
import { isTauri } from "./lib/isTauri";

export type AutomationSchedule =
  | { type: "interval"; everyMinutes: number }
  | { type: "fixed_time"; timeOfDay: string; weekdays: number[] };

export type AutomationRunStatus =
  | "never"
  | "running"
  | "succeeded"
  | "failed";

export type AutomationTask = {
  id: string;
  title: string;
  prompt: string;
  enabled: boolean;
  schedule: AutomationSchedule;
  projectId: string;
  modelId: string;
  accessMode: AccessMode;
  permissionMode: PermissionMode;
  agentMode: AgentMode;
  createdAt: number;
  updatedAt: number;
  nextRunAt: number | null;
  lastRunAt: number | null;
  lastRunStatus: AutomationRunStatus;
  lastError: string | null;
  lastThreadId: string | null;
  runCount: number;
};

export type AutomationUpsertInput = Pick<
  AutomationTask,
  | "title"
  | "prompt"
  | "enabled"
  | "schedule"
  | "projectId"
  | "modelId"
  | "accessMode"
  | "permissionMode"
  | "agentMode"
> & { id?: string };

export type AutomationDueEvent = Pick<
  AutomationTask,
  | "title"
  | "prompt"
  | "projectId"
  | "modelId"
  | "accessMode"
  | "permissionMode"
  | "agentMode"
> & { taskId: string };

const WEB_STORAGE_KEY = "open-xiao-automations-v1";

function loadWebTasks(): AutomationTask[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(WEB_STORAGE_KEY) ?? "[]");
    return Array.isArray(parsed) ? (parsed as AutomationTask[]) : [];
  } catch {
    return [];
  }
}

function saveWebTasks(tasks: AutomationTask[]): void {
  localStorage.setItem(WEB_STORAGE_KEY, JSON.stringify(tasks));
}

export function nextAutomationRunAt(
  schedule: AutomationSchedule,
  fromMs = Date.now(),
): number {
  if (schedule.type === "interval") {
    return fromMs + Math.max(1, Math.floor(schedule.everyMinutes)) * 60_000;
  }
  const match = /^(\d{2}):(\d{2})$/.exec(schedule.timeOfDay);
  if (!match) throw new Error("Time must use 24-hour HH:MM format");
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) throw new Error("Time must use 24-hour HH:MM format");
  const weekdays = new Set(schedule.weekdays);
  for (let offset = 0; offset <= 7; offset += 1) {
    const candidate = new Date(fromMs);
    candidate.setDate(candidate.getDate() + offset);
    candidate.setHours(hour, minute, 0, 0);
    if (candidate.getTime() <= fromMs) continue;
    if (weekdays.size > 0 && !weekdays.has(candidate.getDay())) continue;
    return candidate.getTime();
  }
  throw new Error("Could not calculate the next automation run");
}

function newWebId(): string {
  return `automation-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export async function listAutomations(): Promise<AutomationTask[]> {
  return isTauri() ? invoke("automation_list") : loadWebTasks();
}

export async function upsertAutomation(input: AutomationUpsertInput): Promise<AutomationTask> {
  if (isTauri()) return invoke("automation_upsert", { input });
  const tasks = loadWebTasks();
  const existing = input.id ? tasks.find((task) => task.id === input.id) : undefined;
  if (existing?.lastRunStatus === "running") {
    throw new Error("Cannot edit an automation while it is running");
  }
  const now = Date.now();
  const task: AutomationTask = {
    ...input,
    id: input.id ?? newWebId(),
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    nextRunAt: input.enabled ? nextAutomationRunAt(input.schedule, now) : null,
    lastRunAt: existing?.lastRunAt ?? null,
    lastRunStatus: existing?.lastRunStatus ?? "never",
    lastError: existing?.lastError ?? null,
    lastThreadId: existing?.lastThreadId ?? null,
    runCount: existing?.runCount ?? 0,
  };
  saveWebTasks([task, ...tasks.filter((candidate) => candidate.id !== task.id)]);
  return task;
}

export async function setAutomationEnabled(
  id: string,
  enabled: boolean,
): Promise<AutomationTask> {
  if (isTauri()) return invoke("automation_set_enabled", { id, enabled });
  const tasks = loadWebTasks();
  const task = tasks.find((candidate) => candidate.id === id);
  if (!task) throw new Error("Automation not found");
  const updated = {
    ...task,
    enabled,
    updatedAt: Date.now(),
    nextRunAt: enabled ? nextAutomationRunAt(task.schedule) : null,
  };
  saveWebTasks(tasks.map((candidate) => (candidate.id === id ? updated : candidate)));
  return updated;
}

export async function deleteAutomation(id: string): Promise<void> {
  if (isTauri()) return invoke("automation_delete", { id });
  saveWebTasks(loadWebTasks().filter((task) => task.id !== id));
}

export async function runAutomationNow(id: string): Promise<AutomationTask> {
  if (isTauri()) return invoke("automation_run_now", { id });
  const tasks = loadWebTasks();
  const task = tasks.find((candidate) => candidate.id === id);
  if (!task) throw new Error("Automation not found");
  if (task.lastRunStatus === "running") throw new Error("Automation is already running");
  const updated: AutomationTask = {
    ...task,
    lastRunStatus: "running",
    lastRunAt: Date.now(),
    lastError: null,
    nextRunAt: task.enabled ? nextAutomationRunAt(task.schedule) : null,
  };
  saveWebTasks(tasks.map((candidate) => (candidate.id === id ? updated : candidate)));
  window.dispatchEvent(
    new CustomEvent<AutomationDueEvent>("open-xiao:automation-due", {
      detail: { taskId: task.id, ...task },
    }),
  );
  return updated;
}

export async function recordAutomationRun(input: {
  id: string;
  succeeded: boolean;
  error?: string | null;
  threadId?: string | null;
}): Promise<AutomationTask> {
  if (isTauri()) return invoke("automation_record_run", input);
  const tasks = loadWebTasks();
  const task = tasks.find((candidate) => candidate.id === input.id);
  if (!task) throw new Error("Automation not found");
  const updated: AutomationTask = {
    ...task,
    lastRunStatus: input.succeeded ? "succeeded" : "failed",
    lastError: input.error ?? null,
    lastThreadId: input.threadId ?? null,
    runCount: task.runCount + 1,
    updatedAt: Date.now(),
  };
  saveWebTasks(tasks.map((candidate) => (candidate.id === input.id ? updated : candidate)));
  return updated;
}

export function markAutomationRunning(
  tasks: AutomationTask[],
  id: string,
  startedAt = Date.now(),
): AutomationTask[] {
  return tasks.map((task) =>
    task.id === id
      ? {
          ...task,
          lastRunStatus: "running",
          lastRunAt: startedAt,
          lastError: null,
        }
      : task,
  );
}

export async function subscribeAutomationDue(
  callback: (event: AutomationDueEvent) => void,
): Promise<UnlistenFn> {
  if (isTauri()) {
    return listen<AutomationDueEvent>("automation://due", (event) => callback(event.payload));
  }
  const onDue = (event: Event) => callback((event as CustomEvent<AutomationDueEvent>).detail);
  window.addEventListener("open-xiao:automation-due", onDue);
  const timer = window.setInterval(() => {
    const now = Date.now();
    const tasks = loadWebTasks();
    for (const task of tasks) {
      if (
        task.enabled &&
        task.lastRunStatus !== "running" &&
        task.nextRunAt != null &&
        task.nextRunAt <= now
      ) {
        void runAutomationNow(task.id);
      }
    }
  }, 5_000);
  return () => {
    window.removeEventListener("open-xiao:automation-due", onDue);
    window.clearInterval(timer);
  };
}
