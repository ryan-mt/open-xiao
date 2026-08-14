/**
 * API-only steering for queue "Send now". Never store/show this in the user bubble —
 * it is injected when building the request history only.
 */
export const FOLLOW_UP_INTERRUPT_NOTE =
  "[Follow-up sent while the previous agent turn was still in progress. " +
  "You already have the prior assistant/tool transcript above — retain that " +
  "context. Finish incomplete work unless this message clearly supersedes it.]";

export function followUpAfterInterrupt(text: string): string {
  const body = text.trim();
  return body
    ? `${FOLLOW_UP_INTERRUPT_NOTE}\n\n${body}`
    : FOLLOW_UP_INTERRUPT_NOTE;
}

/** Strip a leaked interrupt note from older messages (display / edit / title). */
export function stripFollowUpInterruptNote(text: string): string {
  const t = text.trimStart();
  if (
    !t.startsWith(
      "[Follow-up sent while the previous agent turn was still in progress.",
    )
  ) {
    return text;
  }
  const close = t.indexOf("]");
  if (close < 0) return text;
  return t.slice(close + 1).replace(/^\s*\n+/, "").trimStart();
}
