import type { UserFacingError } from "./lib/userFacingError";

export type Role = "user" | "assistant" | "system";

export type ImageAttachment = {
  id: string;
  name: string;
  mime: string;
  /** data: URL for preview + API */
  dataUrl: string;
};

export type ToolCallStatus =
  | "awaiting"
  | "running"
  | "done"
  | "error"
  | "denied";

export type ToolCall = {
  id: string;
  name: string;
  args: string;
  result?: string;
  status: ToolCallStatus;
  /** Present while Ask mode parks a risky tool. */
  approvalReason?: string;
  /** Image data URL from a multimodal read (UI preview of model input). */
  imageUrl?: string;
  /**
   * Nested tools from a `task` subagent (UI progress). Not sent back to the API
   * as separate tool messages — the parent task result already summarizes them.
   */
  children?: ToolCall[];
};

/** Chronological assistant timeline blocks (thinking / text / tools). */
export type MessagePart =
  | { type: "thinking"; id: string; text: string }
  | { type: "text"; id: string; text: string }
  | { type: "tool"; id: string; call: ToolCall };

export type Message = {
  id: string;
  role: Role;
  content: string;
  thinking?: string;
  toolCalls?: ToolCall[];
  /** Ordered stream parts; when present, preferred over flat fields for UI. */
  parts?: MessagePart[];
  attachments?: ImageAttachment[];
  createdAt: number;
  /** Wall-clock ms the assistant spent on this turn (set when stream ends). */
  durationMs?: number;
};

/** A chat thread inside a project. */
export type Thread = {
  id: string;
  title: string;
  messages: Message[];
  /** Creation time — Sidebar V2 active list sorts by this (static). */
  createdAt: number;
  updatedAt: number;
  pinned?: boolean;
  projectId: string | null;
  /** Model selected for this thread; its provider locks after the first turn. */
  modelId?: string | null;
  /** Explicit settle timestamp (ms). Null/undefined = not settled. */
  settledAt?: number | null;
  /** Wake time while snoozed (ms). */
  snoozedUntil?: number | null;
  /** When a snooze ended; drives Woke pill until visited. */
  wokeAt?: number | null;
  /** Last time the user opened this thread (ms). */
  lastVisitedAt?: number | null;
  /** Last stream/send error surface for Failed status. */
  lastError?: UserFacingError | null;
  /**
   * When set, the thread is archived: hidden from the sidebar and listed
   * under Settings → Archive until restored.
   */
  archivedAt?: number | null;
  /**
   * Optional isolated git worktree path for this thread. When set, agent tools
   * and git UI use this directory instead of the project root.
   */
  worktreePath?: string | null;
  /** Branch checked out in the worktree (display + Open PR). */
  worktreeBranch?: string | null;
};

/** Local workspace folder. */
export type Project = {
  id: string;
  name: string;
  path: string;
  createdAt: number;
  updatedAt: number;
  collapsed?: boolean;
};

export type Conversation = Thread;

export function createId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function projectNameFromPath(path: string): string {
  const norm = path.replace(/[\\/]+$/, "");
  const parts = norm.split(/[/\\]/).filter(Boolean);
  return parts[parts.length - 1] || path;
}

export function createProject(path: string, name?: string): Project {
  const now = Date.now();
  return {
    id: createId(),
    name: name ?? projectNameFromPath(path),
    path,
    createdAt: now,
    updatedAt: now,
    collapsed: false,
  };
}

export function createThread(
  projectId: string | null = null,
  title = "New chat",
  modelId?: string | null,
): Thread {
  const now = Date.now();
  return {
    id: createId(),
    title,
    messages: [],
    createdAt: now,
    updatedAt: now,
    pinned: false,
    projectId,
    modelId: modelId?.trim() || null,
    settledAt: null,
    snoozedUntil: null,
    wokeAt: null,
    lastVisitedAt: null,
    lastError: null,
    archivedAt: null,
    worktreePath: null,
    worktreeBranch: null,
  };
}

/** @deprecated use createThread */
export function createConversation(title = "New chat"): Thread {
  return createThread(null, title);
}

export function timeGroupLabel(updatedAt: number, now = Date.now()): string {
  const startOfDay = (t: number) => {
    const d = new Date(t);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  };
  const today = startOfDay(now);
  const day = startOfDay(updatedAt);
  const diffDays = Math.round((today - day) / 86_400_000);

  if (diffDays <= 0) return "Today";
  if (diffDays === 1) return "Yesterday";
  if (diffDays < 7) return `${diffDays} days ago`;
  if (diffDays < 30) {
    const w = Math.floor(diffDays / 7);
    return `${w} week${w > 1 ? "s" : ""} ago`;
  }
  const m = Math.floor(diffDays / 30);
  return `${m} month${m > 1 ? "s" : ""} ago`;
}

/** Max bytes per image attachment (decoded file size). */
export const MAX_IMAGE_BYTES = 6 * 1024 * 1024;

export async function fileToAttachment(file: File): Promise<ImageAttachment> {
  if (!file.type.startsWith("image/")) {
    throw new Error("Not an image file");
  }
  if (file.size > MAX_IMAGE_BYTES) {
    throw new Error(
      `Image too large (max ${Math.round(MAX_IMAGE_BYTES / (1024 * 1024))}MB)`,
    );
  }
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error("read failed"));
    reader.readAsDataURL(file);
  });
  // Verify the browser can decode it as an image (blocks spoofed MIME).
  await new Promise<void>((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve();
    img.onerror = () => reject(new Error("Invalid image data"));
    img.src = dataUrl;
  });
  return {
    id: createId(),
    name: file.name || "image",
    mime: file.type || "image/png",
    dataUrl,
  };
}
