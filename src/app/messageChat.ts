import type { ChatMsg, ContentPart } from "../auth";
import { assistantContentForApi } from "../messageParts";
import type { Message } from "../types";

export function titleFromPrompt(prompt: string): string {
  const t = prompt.trim().replace(/\s+/g, " ");
  if (!t) return "New chat";
  // Hard cap only for pathological pastes; rename/edit always sees real text.
  return t.length > 120 ? t.slice(0, 120) : t;
}

export function agentNotificationBody(kind: "complete" | "error"): string {
  return kind === "error"
    ? "Open the app to review the error."
    : "Open the app to review the result.";
}

export function messageToChat(m: Message): ChatMsg | null {
  if (m.role !== "user" && m.role !== "assistant") return null;
  const atts = m.attachments?.filter((a) => a.dataUrl) ?? [];
  // Assistant: fold tool rounds into content so interrupt/queue follow-ups
  // still see mid-task work (API history has no separate tool_calls from client).
  const text =
    m.role === "assistant" ? assistantContentForApi(m) : m.content;
  if (atts.length === 0) {
    // Keep empty assistant shells (tool-only turns) so role alternation stays
    // intact for the next request. Drop empty user turns only.
    if (!text.trim()) {
      if (m.role === "assistant") return { role: m.role, content: "" };
      return null;
    }
    return { role: m.role, content: text };
  }
  const parts: ContentPart[] = [];
  if (text.trim()) parts.push({ type: "text", text });
  for (const a of atts) {
    parts.push({ type: "image_url", image_url: { url: a.dataUrl } });
  }
  if (parts.length === 0) {
    if (m.role === "assistant") return { role: m.role, content: "" };
    return null;
  }
  return { role: m.role, content: parts };
}
