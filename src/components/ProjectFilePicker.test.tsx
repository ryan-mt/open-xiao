import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { searchProjectEntries } from "../auth";
import { ProjectFilePicker } from "./ProjectFilePicker";

vi.mock("../auth", () => ({
  searchProjectEntries: vi.fn(),
}));

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.mocked(searchProjectEntries).mockReset();
});

describe("ProjectFilePicker", () => {
  it("settles loading and reports a failed search", async () => {
    vi.useFakeTimers();
    vi.mocked(searchProjectEntries).mockRejectedValue(new Error("project missing"));
    render(
      <ProjectFilePicker
        open
        projectName="Project"
        projectPath="C:/project"
        onPick={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(90);
      await Promise.resolve();
    });
    expect(screen.getByText("File search failed.")).toBeTruthy();
    expect(screen.queryByText("Searching files...")).toBeNull();
  });
});
