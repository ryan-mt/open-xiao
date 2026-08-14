import { Channel, invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { forwardAbort } from "./abortCancellation";
import type {
  AccessMode,
  AgentMode,
  PermissionMode,
  ThinkingLevel,
} from "./models";
import { isTauri } from "./lib/isTauri";
import { createId } from "./types";
import type { UserInputQuestion, UserInputRequest } from "./userInput";

export type AuthStatus = {
  signedIn: boolean;
  email?: string | null;
  name?: string | null;
  plan?: string | null;
  expiresAt?: number | null;
};

export type GrokAuthStatus = AuthStatus;

export type OpenAIAuthStatus = {
  signedIn: boolean;
  email?: string | null;
  plan?: string | null;
  loginInProgress?: boolean;
};

export type CodexUsageWindow = {
  usedPercent: number;
  windowMinutes?: number | null;
  resetsAt?: number | null;
};

export type CodexUsageStatus = {
  primary?: CodexUsageWindow | null;
  secondary?: CodexUsageWindow | null;
};

export type DeviceCodeEvent = {
  userCode: string;
  verificationUri: string;
  expiresInSeconds: number;
  intervalSeconds: number;
};

export type GrokDeviceCodeEvent = DeviceCodeEvent;

export async function getAuthStatus(): Promise<AuthStatus> {
  if (!isTauri()) {
    return { signedIn: false };
  }
  return invoke<AuthStatus>("auth_status");
}

export async function loginWithGrok(): Promise<AuthStatus> {
  if (!isTauri()) {
    throw new Error(
      "OAuth only works in the Tauri desktop app (npm run tauri dev)",
    );
  }
  return invoke<AuthStatus>("auth_login");
}

export async function logoutGrok(): Promise<AuthStatus> {
  if (!isTauri()) {
    return { signedIn: false };
  }
  return invoke<AuthStatus>("auth_logout");
}

export async function cancelLogin(): Promise<void> {
  if (!isTauri()) return;
  try {
    await invoke("auth_cancel_login");
  } catch {
    /* ignore */
  }
}

export async function registerProjectRoot(path: string): Promise<string> {
  if (!isTauri()) return path;
  return invoke<string>("project_register", { path });
}

export async function unregisterProjectRoot(path: string): Promise<void> {
  if (!isTauri()) return;
  await invoke("project_unregister", { path });
}

export async function onDeviceCode(
  cb: (e: DeviceCodeEvent) => void,
): Promise<UnlistenFn> {
  if (!isTauri()) return () => {};
  return listen<DeviceCodeEvent>("auth://device-code", (ev) => cb(ev.payload));
}

export async function onAuthStatus(
  cb: (s: AuthStatus) => void,
): Promise<UnlistenFn> {
  if (!isTauri()) return () => {};
  return listen<AuthStatus>("auth://status", (ev) => cb(ev.payload));
}

export const getGrokAuthStatus = getAuthStatus;
export const cancelGrokLogin = cancelLogin;
export const onGrokDeviceCode = onDeviceCode;
export const onGrokAuthStatus = onAuthStatus;

export async function getOpenAIAuthStatus(): Promise<OpenAIAuthStatus> {
  if (!isTauri()) {
    return { signedIn: false };
  }
  return invoke<OpenAIAuthStatus>("openai_auth_status");
}

export async function getCodexUsage(): Promise<CodexUsageStatus> {
  if (!isTauri()) {
    return {};
  }
  return invoke<CodexUsageStatus>("openai_codex_usage");
}

export async function loginWithOpenAI(): Promise<OpenAIAuthStatus> {
  if (!isTauri()) {
    throw new Error(
      "OAuth only works in the Tauri desktop app (npm run tauri dev)",
    );
  }
  return invoke<OpenAIAuthStatus>("openai_auth_login");
}

export async function logoutOpenAI(): Promise<OpenAIAuthStatus> {
  if (!isTauri()) {
    return { signedIn: false };
  }
  return invoke<OpenAIAuthStatus>("openai_auth_logout");
}

export async function cancelOpenAILogin(): Promise<void> {
  if (!isTauri()) return;
  try {
    await invoke("openai_auth_cancel_login");
  } catch {
    /* ignore */
  }
}

export async function onOpenAIDeviceCode(
  cb: (e: DeviceCodeEvent) => void,
): Promise<UnlistenFn> {
  if (!isTauri()) return () => {};
  return listen<DeviceCodeEvent>("openai-auth://device-code", (ev) =>
    cb(ev.payload),
  );
}

export async function onOpenAIAuthStatus(
  cb: (s: OpenAIAuthStatus) => void,
): Promise<UnlistenFn> {
  if (!isTauri()) return () => {};
  return listen<OpenAIAuthStatus>("openai-auth://status", (ev) =>
    cb(ev.payload),
  );
}

export type ContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

export type ChatMsg = {
  role: string;
  content: string | ContentPart[] | null;
};

export type ProjectFile = {
  relativePath: string;
  content: string;
};

export type ProjectContext = {
  path: string;
  name: string;
  tree: string;
  files: ProjectFile[];
  truncated: boolean;
};

export async function getProjectContext(path: string): Promise<ProjectContext> {
  if (!isTauri()) {
    throw new Error("Project scan requires Tauri backend");
  }
  return invoke<ProjectContext>("project_context", { path });
}

/** Composer `@` path autocomplete hit (relative to project root). */
export type ProjectSearchEntry = {
  path: string;
  name: string;
  parent: string;
  isDir: boolean;
};

/**
 * Search project files/folders for `@` mentions.
 * Empty query returns a shallow/priority sample (OpenCode recent-style bootstrap).
 */
export async function searchProjectEntries(
  path: string,
  query: string,
  limit = 80,
): Promise<ProjectSearchEntry[]> {
  if (!isTauri()) return [];
  try {
    return await invoke<ProjectSearchEntry[]>("project_search_entries", {
      path,
      query,
      limit,
    });
  } catch {
    return [];
  }
}

export async function listProjectEntries(
  path: string,
): Promise<ProjectSearchEntry[]> {
  if (!isTauri()) return [];
  return invoke<ProjectSearchEntry[]>("project_entries", { path });
}

export type ProjectFilePreview = {
  relativePath: string;
  contents: string | null;
  dataUrl: string | null;
  byteLength: number;
  truncated: boolean;
};

export async function readProjectFile(
  path: string,
  relativePath: string,
): Promise<ProjectFilePreview> {
  if (!isTauri()) {
    throw new Error("File preview requires the desktop app");
  }
  return invoke<ProjectFilePreview>("project_read_file", {
    path,
    relativePath,
  });
}

/** Representative project logo/favicon. Null means the UI should show a folder. */
export async function getProjectFavicon(path: string): Promise<string | null> {
  if (!isTauri()) return null;
  try {
    return await invoke<string | null>("project_favicon", { path });
  } catch {
    return null;
  }
}

export type StreamEvent =
  | { kind: "content"; text: string }
  | { kind: "thinking"; text: string }
  | {
      kind: "tool_start";
      id: string;
      name: string;
      args: string;
      awaitingApproval?: boolean;
      approvalReason?: string | null;
      /** Nested under a parent `task` tool when set. */
      parentId?: string | null;
    }
  | {
      kind: "tool_result";
      id: string;
      name: string;
      ok: boolean;
      result: string;
      /** Nested under a parent `task` tool when set. */
      parentId?: string | null;
      /** Image data URL from a multimodal read, when any. */
      imageUrl?: string | null;
    }
  | {
      kind: "tool_output";
      id: string;
      text: string;
      replace: boolean;
    }
  | {
      kind: "user_input_requested";
      requestId: string;
      questions: UserInputQuestion[];
    }
  | { kind: "user_input_resolved"; requestId: string }
  | {
      kind: "usage";
      inputTokens: number;
      outputTokens: number;
      totalTokens: number;
    };

export type StreamHandlers = {
  onChunk: (text: string) => void;
  onThinking?: (text: string) => void;
  onToolStart?: (t: {
    id: string;
    name: string;
    args: string;
    awaitingApproval?: boolean;
    approvalReason?: string;
    parentId?: string;
  }) => void;
  onToolResult?: (t: {
    id: string;
    name: string;
    ok: boolean;
    result: string;
    parentId?: string;
    imageUrl?: string;
  }) => void;
  /** Incremental output from a running tool (foreground bash). */
  onToolOutput?: (t: { id: string; text: string; replace?: boolean }) => void;
  onUserInput?: (request: UserInputRequest) => void;
  onUserInputResolved?: (requestId: string) => void;
  onUsage?: (usage: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
  }) => void;
  signal?: AbortSignal;
};

const activeChatRequests = new Map<string, string>();

/** Ask the Rust backend to stop the current request for one chat stream. */
export async function cancelChatStream(
  streamId: string,
  requestId?: string,
): Promise<void> {
  if (!isTauri()) return;
  const sid = streamId.trim();
  if (!sid) return;
  const rid = requestId?.trim() || activeChatRequests.get(sid);
  if (!rid) return;
  await invoke("chat_cancel", { streamId: sid, requestId: rid });
}

/** Approve a tool parked in Ask permission mode. */
export async function approveChatTool(
  streamId: string,
  toolId: string,
): Promise<void> {
  if (!isTauri()) return;
  await invoke("chat_tool_approve", {
    streamId: streamId.trim(),
    toolId: toolId.trim(),
  });
}

/** Deny a tool parked in Ask permission mode. */
export async function denyChatTool(
  streamId: string,
  toolId: string,
): Promise<void> {
  if (!isTauri()) return;
  await invoke("chat_tool_deny", {
    streamId: streamId.trim(),
    toolId: toolId.trim(),
  });
}

export async function replyToChatUserInput(
  streamId: string,
  requestId: string,
  answers: string[][],
): Promise<void> {
  if (!isTauri()) return;
  await invoke("chat_user_input_reply", {
    streamId: streamId.trim(),
    requestId: requestId.trim(),
    answers,
  });
}

export async function rejectChatUserInput(
  streamId: string,
  requestId: string,
): Promise<void> {
  if (!isTauri()) return;
  await invoke("chat_user_input_reject", {
    streamId: streamId.trim(),
    requestId: requestId.trim(),
  });
}

export type SnapshotRestoreReport = {
  restored: string[];
  errors: string[];
};

export type SnapshotInfo = {
  toolId: string;
  streamId: string;
  path: string;
  displayPath: string;
  kind: string;
  createdAt: number;
};

/** List pre-mutation snapshots captured for one chat stream (thread id). */
export async function listSnapshots(streamId: string): Promise<SnapshotInfo[]> {
  if (!isTauri()) return [];
  const sid = streamId.trim();
  if (!sid) return [];
  try {
    return await invoke<SnapshotInfo[]>("snapshot_list", { streamId: sid });
  } catch {
    return [];
  }
}

/** Restore files from pre-mutation snapshots (session undo). */
export async function restoreSnapshots(
  streamId: string,
  toolIds: string[],
): Promise<SnapshotRestoreReport> {
  if (!isTauri()) {
    throw new Error("Restore requires the desktop app");
  }
  return invoke<SnapshotRestoreReport>("snapshot_restore", {
    streamId: streamId.trim(),
    toolIds,
  });
}

/** Stream chat (and optional project agent tools) via Rust backend. */
export async function streamChat(
  opts: {
    /** Stable id for this stream — use the thread id so cancel is per-chat. */
    streamId: string;
    messages: ChatMsg[];
    model: string;
    thinking?: ThinkingLevel;
    /** OpenAI Fast mode. Ignored unless the selected model supports it. */
    fastMode?: boolean;
    projectPath?: string | null;
    /** workspace = sandboxed to project; full = absolute paths allowed. */
    accessMode?: AccessMode;
    permissionMode?: PermissionMode;
    agentMode?: AgentMode;
  } & StreamHandlers,
): Promise<void> {
  if (!isTauri()) {
    throw new Error("Chat API requires Tauri backend");
  }

  const streamId = opts.streamId.trim();
  if (!streamId) {
    throw new Error("streamId required");
  }

  if (opts.signal?.aborted) {
    return;
  }

  const channel = new Channel<StreamEvent>();
  channel.onmessage = (ev) => {
    if (opts.signal?.aborted) return;
    switch (ev.kind) {
      case "thinking":
        opts.onThinking?.(ev.text);
        break;
      case "content":
        opts.onChunk(ev.text);
        break;
      case "tool_start":
        opts.onToolStart?.({
          id: ev.id,
          name: ev.name,
          args: ev.args,
          awaitingApproval: Boolean(ev.awaitingApproval),
          approvalReason: ev.approvalReason ?? undefined,
          parentId: ev.parentId ?? undefined,
        });
        break;
      case "tool_result":
        opts.onToolResult?.({
          id: ev.id,
          name: ev.name,
          ok: ev.ok,
          result: ev.result,
          parentId: ev.parentId ?? undefined,
          imageUrl: ev.imageUrl ?? undefined,
        });
        break;
      case "tool_output":
        opts.onToolOutput?.({ id: ev.id, text: ev.text, replace: ev.replace });
        break;
      case "user_input_requested":
        opts.onUserInput?.({ requestId: ev.requestId, questions: ev.questions });
        break;
      case "user_input_resolved":
        opts.onUserInputResolved?.(ev.requestId);
        break;
      case "usage":
        opts.onUsage?.({
          inputTokens: ev.inputTokens,
          outputTokens: ev.outputTokens,
          totalTokens: ev.totalTokens,
        });
        break;
    }
  };

  const reasoningEffort =
    opts.thinking && opts.thinking !== "off" ? opts.thinking : null;
  const requestId = createId();
  activeChatRequests.set(streamId, requestId);

  const stopForwarding = opts.signal
    ? forwardAbort(opts.signal, () => cancelChatStream(streamId, requestId))
    : () => undefined;
  try {
    if (opts.signal?.aborted) return;
    // One native pipeline: the Rust backend routes the model to its provider.
    await invoke("chat_stream", {
      streamId,
      requestId,
      messages: opts.messages,
      model: opts.model,
      reasoningEffort,
      serviceTier: opts.fastMode ? "priority" : null,
      projectPath: opts.projectPath ?? null,
      accessMode: opts.accessMode === "full" ? "full" : "workspace",
      permissionMode: opts.permissionMode === "ask" ? "ask" : "auto",
      agentMode: opts.agentMode === "plan" ? "plan" : "build",
      onChunk: channel,
    });
  } finally {
    stopForwarding();
    if (activeChatRequests.get(streamId) === requestId) {
      activeChatRequests.delete(streamId);
    }
  }
}
