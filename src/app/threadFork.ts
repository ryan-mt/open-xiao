import {
  createId,
  createThread,
  type Message,
  type ToolCall,
  type Thread,
} from "../types.ts";

export function getForkedThreadTitle(title: string): string {
  const match = /^(.*) \(fork #(\d+)\)$/.exec(title.trim());
  if (!match) return `${title.trim() || "New chat"} (fork #1)`;
  return `${match[1]} (fork #${Number(match[2]) + 1})`;
}

function cloneMessage(message: Message): Message {
  const toolIds = new Map<string, string>();
  const toolId = (id: string) => {
    const existing = toolIds.get(id);
    if (existing) return existing;
    const next = createId();
    toolIds.set(id, next);
    return next;
  };
  const cloneTool = (call: ToolCall): ToolCall => ({
    ...call,
    id: toolId(call.id),
    children: call.children?.map(cloneTool),
  });

  return {
    ...message,
    id: createId(),
    attachments: message.attachments?.map((attachment) => ({
      ...attachment,
      id: createId(),
    })),
    toolCalls: message.toolCalls?.map(cloneTool),
    parts: message.parts?.map((part) => {
      if (part.type === "tool") {
        return { ...part, id: createId(), call: cloneTool(part.call) };
      }
      return { ...part, id: createId() };
    }),
  };
}

export function forkThreadAtMessage(
  source: Thread,
  messageId: string,
): Thread | null {
  const boundary = source.messages.findIndex(
    (message) => message.id === messageId && message.role === "user",
  );
  if (boundary < 0) return null;

  const fork = createThread(
    source.projectId,
    getForkedThreadTitle(source.title),
    source.modelId,
  );
  return {
    ...fork,
    messages: source.messages.slice(0, boundary).map(cloneMessage),
  };
}
