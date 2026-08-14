import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { listSnapshots } from "../auth";
import { useReviewUndoAvailability } from "./useReviewUndoAvailability";

vi.mock("../auth", () => ({
  listSnapshots: vi.fn(),
}));

const mutationMessage = {
  id: "assistant-1",
  role: "assistant" as const,
  content: "",
  createdAt: 1,
  parts: [
    {
      type: "tool" as const,
      id: "tool-1",
      call: {
        id: "tool-1",
        name: "write",
        args: "{}",
        status: "done" as const,
        result: "ok",
      },
    },
  ],
};

function options(activeId: string) {
  return {
    activeId,
    activeMessages: [mutationMessage],
    activeStreaming: false,
    chatReviewFiles: [],
    reviewOpen: true,
    reviewScope: "turn" as const,
    snapshotEpoch: 0,
  };
}

afterEach(() => {
  vi.mocked(listSnapshots).mockReset();
});

describe("useReviewUndoAvailability", () => {
  it("clears stale availability while a new thread lookup fails", async () => {
    vi.mocked(listSnapshots)
      .mockResolvedValueOnce([
        {
          toolId: "tool-1",
          streamId: "thread-a",
          path: "a.txt",
          displayPath: "a.txt",
          kind: "created",
          createdAt: 1,
        },
      ])
      .mockRejectedValueOnce(new Error("snapshot lookup failed"));
    const { result, rerender } = renderHook(
      ({ hookOptions }) => useReviewUndoAvailability(hookOptions),
      { initialProps: { hookOptions: options("thread-a") } },
    );
    await waitFor(() => expect(result.current).toBe(true));

    act(() => rerender({ hookOptions: options("thread-b") }));
    expect(result.current).toBe(false);
    await waitFor(() => expect(listSnapshots).toHaveBeenCalledTimes(2));
    expect(result.current).toBe(false);
  });
});
