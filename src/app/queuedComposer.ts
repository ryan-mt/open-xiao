import type { QueuedSend } from "../sendQueue.ts";
import { appendReviewComments } from "../reviewComments.ts";

export function queuedComposerDraft(item: QueuedSend): string {
  if (
    item.reviewComments?.length &&
    item.apiText === appendReviewComments("", item.reviewComments)
  ) {
    return "";
  }
  return item.text;
}
