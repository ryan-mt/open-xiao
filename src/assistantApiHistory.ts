export const MAX_TOOL_ONLY_HISTORY_CHARS = 24_000;

const OMITTED_TOOL_ACTIVITY =
  "[Earlier tool activity omitted to keep the next request focused.]\n\n";

/**
 * Completed turns are represented by their final answer. Interrupted tool-only
 * turns retain the newest work, bounded so one long run cannot dominate every
 * later request in the thread.
 */
export function assistantHistoryPayload(
  finalContent: string,
  toolTranscript: string,
): string {
  const answer = finalContent.trim();
  if (answer) return answer;

  const transcript = toolTranscript.trim();
  if (transcript.length <= MAX_TOOL_ONLY_HISTORY_CHARS) return transcript;

  const tailLength = MAX_TOOL_ONLY_HISTORY_CHARS - OMITTED_TOOL_ACTIVITY.length;
  return `${OMITTED_TOOL_ACTIVITY}${transcript.slice(-tailLength)}`;
}
