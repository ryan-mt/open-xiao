import { describe, expect, it } from "vitest";
import {
  automationRelativeTime,
  automationScheduleLabel,
} from "./AutomationsPage";

describe("automation presentation", () => {
  it("formats interval and weekday schedules", () => {
    expect(
      automationScheduleLabel({ type: "interval", everyMinutes: 1 }),
    ).toBe("Every 1 minute");
    expect(
      automationScheduleLabel({
        type: "fixed_time",
        timeOfDay: "09:00",
        weekdays: [1, 2, 3, 4, 5],
      }),
    ).toBe("Weekdays at 09:00");
  });

  it("does not label overdue work as upcoming", () => {
    expect(automationRelativeTime(500, 1_000)).toBe("due now");
    expect(automationRelativeTime(null, 1_000)).toBe("Not scheduled");
  });
});
