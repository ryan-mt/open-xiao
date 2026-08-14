import { getModel } from "./models.ts";
import { resolveMessageParts } from "./messageParts.ts";
import type { Message, MessagePart, ToolCall } from "./types.ts";

/** Rough char->token estimate (English/code mix). */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.max(1, Math.ceil(text.length / 4));
}

/**
 * Always-present server system prompt + tool schema overhead.
 * Not exact (project prompts vary); keeps empty chats from reading as 0/limit.
 */
export const SYSTEM_PROMPT_OVERHEAD = 1_200;

/** Per-message role/framing overhead in the chat request. */
const MESSAGE_FRAMING_TOKENS = 8;

/** Match assistantContentForApi truncation so meter tracks API-bound history. */
const TOOL_ARGS_BUDGET = 1_200;
const TOOL_RESULT_BUDGET = 4_000;

function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}…`;
}

function estimateToolCallTokens(call: ToolCall): number {
  const name = (call.name || "tool").trim() || "tool";
  const args = clip((call.args || "").trim(), TOOL_ARGS_BUDGET);
  const result = clip((call.result || "").trim(), TOOL_RESULT_BUDGET);
  const status =
    call.status === "running"
      ? "running"
      : call.status === "error"
        ? "error"
        : "done";
  const lines = [`[tool ${name} · ${status}]`];
  if (args) lines.push(`args: ${args}`);
  if (result) lines.push(`result:\n${result}`);
  else if (status === "running") {
    lines.push("result: (interrupted before tool finished)");
  }
  return estimateTokens(lines.join("\n"));
}

/**
 * Estimate tokens a message contributes toward the next model request.
 * Assistant turns prefer content + tool transcript (API history shape) over
 * raw thinking once tools/content exist; live thinking still counts while the
 * turn is open and otherwise empty of API-bound text.
 */
export function estimateMessageTokens(m: Message): number {
  let n = 0;

  if (m.role === "assistant") {
    const content = m.content || "";
    if (content) n += estimateTokens(content);

    // Resolve parts (preferred over the flat toolCalls mirror) so messages
    // whose mirror is missing or stale still count their tool transcript.
    const tools = resolveMessageParts(m).filter(
      (p): p is Extract<MessagePart, { type: "tool" }> => p.type === "tool",
    );
    if (tools.length > 0) {
      for (const part of tools) n += estimateToolCallTokens(part.call);
    } else if (m.thinking) {
      // Reasoning is not always resent on later turns, but it occupies the
      // live context while the model is producing it.
      n += estimateTokens(m.thinking);
    }
  } else {
    if (m.content) n += estimateTokens(m.content);
    if (m.thinking) n += estimateTokens(m.thinking);
  }

  if (m.attachments?.length) {
    // images burn more context; fixed budget per image
    n += m.attachments.length * 800;
  }

  if (n > 0) n += MESSAGE_FRAMING_TOKENS;
  return n;
}

export function parseContextK(context: string): number {
  const m = /^([\d.]+)\s*([kKmM])?$/.exec(context.trim());
  if (!m) return 0;
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n <= 0) return 0;
  const u = (m[2] || "").toLowerCase();
  if (u === "m") return Math.round(n * 1_000_000);
  if (u === "k") return Math.round(n * 1_000);
  return Math.round(n);
}

export function contextUsage(
  messages: Message[],
  modelId: string,
  draftText = "",
  draftAttachmentCount = 0,
) {
  const model = getModel(modelId);
  const limit = parseContextK(model.context);
  let used =
    SYSTEM_PROMPT_OVERHEAD +
    messages.reduce((sum, m) => sum + estimateMessageTokens(m), 0);
  const draft = draftText.trim();
  if (draft) used += estimateTokens(draft) + MESSAGE_FRAMING_TOKENS;
  if (draftAttachmentCount > 0) {
    used += Math.floor(draftAttachmentCount) * 800;
  }
  const ratio = limit > 0 ? Math.min(1, used / limit) : 0;
  return { used, limit, ratio, label: model.context };
}
