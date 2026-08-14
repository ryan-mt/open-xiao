import { useEffect, useState } from "react";
import { listSnapshots } from "../auth";
import type { Message } from "../types";
import type { ReviewFileChange, ReviewScope } from "../reviewChanges";
import {
  filterToolIdsWithSnapshots,
  mutationToolIdsForUndo,
  toolIdsFromReviewFiles,
} from "../snapshotUndo";

type ReviewUndoAvailabilityOptions = {
  activeId: string | null;
  activeMessages: readonly Message[];
  activeStreaming: boolean;
  chatReviewFiles: readonly ReviewFileChange[];
  reviewOpen: boolean;
  reviewScope: ReviewScope;
  snapshotEpoch: number;
};

export function useReviewUndoAvailability({
  activeId,
  activeMessages,
  activeStreaming,
  chatReviewFiles,
  reviewOpen,
  reviewScope,
  snapshotEpoch,
}: ReviewUndoAvailabilityOptions): boolean {
  const [available, setAvailable] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setAvailable(false);
    if (!reviewOpen || activeStreaming || !activeId || reviewScope === "git") {
      return;
    }
    const reviewToolIds = toolIdsFromReviewFiles(chatReviewFiles);
    const candidates =
      reviewScope === "session"
        ? mutationToolIdsForUndo(activeMessages, "session")
        : reviewToolIds.length > 0
          ? reviewToolIds
          : mutationToolIdsForUndo(activeMessages, "turn");
    if (candidates.length === 0) return;

    void listSnapshots(activeId)
      .then((snapshots) => {
        if (!cancelled) {
          setAvailable(filterToolIdsWithSnapshots(candidates, snapshots).length > 0);
        }
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [
    activeId,
    activeMessages,
    activeStreaming,
    chatReviewFiles,
    reviewOpen,
    reviewScope,
    snapshotEpoch,
  ]);

  return available;
}
