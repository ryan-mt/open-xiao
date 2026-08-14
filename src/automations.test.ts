import { describe, expect, it } from "vitest";
import { markAutomationRunning, nextAutomationRunAt } from "./automations";

describe("nextAutomationRunAt", () => {
  it("advances interval schedules from the supplied instant", () => {
    expect(
      nextAutomationRunAt({ type: "interval", everyMinutes: 5 }, 1_000),
    ).toBe(301_000);
  });

  it("rejects invalid fixed times", () => {
    expect(() =>
      nextAutomationRunAt(
        { type: "fixed_time", timeOfDay: "25:00", weekdays: [] },
        Date.now(),
      ),
    ).toThrow("24-hour");
  });
});

describe("markAutomationRunning", () => {
  it("updates only the due task", () => {
    const task = {
      id: "task-1",
      title: "Task",
      prompt: "Run",
      enabled: true,
      schedule: { type: "interval" as const, everyMinutes: 5 },
      projectId: "project-1",
      modelId: "grok-4.5",
      accessMode: "workspace" as const,
      permissionMode: "ask" as const,
      agentMode: "build" as const,
      createdAt: 1,
      updatedAt: 1,
      nextRunAt: 301_000,
      lastRunStatus: "never" as const,
      lastRunAt: null,
      lastError: "old error",
      lastThreadId: null,
      runCount: 0,
    };
    const [updated] = markAutomationRunning([task], "task-1", 123);
    expect(updated).toMatchObject({
      id: "task-1",
      lastRunStatus: "running",
      lastRunAt: 123,
      lastError: null,
    });
  });
});
