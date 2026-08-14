import { invoke } from "@tauri-apps/api/core";
import type {
  ImageAttachment,
  Message,
  MessagePart,
  Project,
  Thread,
  ToolCall,
  ToolCallStatus,
} from "./types";
import { createThread } from "./types";
import { normalizeWorkspacePath } from "./gitWorkspace";
import { isTauri } from "./lib/isTauri";
import { createKeyedSerialQueue } from "./keyedSerialQueue";
import { normalizeStoredError } from "./lib/userFacingError";
import { finalizeRunningTools } from "./messageParts";
import {
  DEFAULT_ACCESS_MODE,
  DEFAULT_AGENT_MODE,
  DEFAULT_MODEL_ID,
  DEFAULT_PERMISSION_MODE,
  DEFAULT_THINKING,
  isKnownModelId,
  type AccessMode,
  type AgentMode,
  type PermissionMode,
  type ThinkingLevel,
} from "./models";
import {
  DEFAULT_KEYBINDINGS,
  normalizeStoredKeybindings,
  type KeybindingRule,
} from "./keybindings";

const PROJECTS_KEY = "grok-projects-v1";
const THREADS_KEY = "grok-threads-v1";
const ACTIVE_KEY = "grok-active-v1";
const PREFS_KEY = "grok-prefs-v1";

/** Max data URL length kept on disk (full images stay in memory only). */
const MAX_STORED_DATA_URL = 8_000;

export type AppPrefs = {
  modelId: string;
  thinking: ThinkingLevel;
  /** OpenAI priority routing; never inherited by other providers. */
  openaiFastMode: boolean;
  /** Tool FS scope: workspace-only vs full machine paths. */
  accessMode: AccessMode;
  /** auto = run tools; ask = approve mutations/bash first. */
  permissionMode: PermissionMode;
  /** plan = read-only tools; build = full agent. */
  agentMode: AgentMode;
  sidebarOpen: boolean;
  activeProjectId: string | null;
  /** When true, thinking blocks start collapsed to the label only. */
  collapseThinking: boolean;
  /** User-editable app shortcuts; terminal/composer navigation remains local. */
  keybindings: KeybindingRule[];
  /** OS notification when an agent turn finishes (only if app not focused). */
  notifyOnAgentComplete: boolean;
  /** OS notification when an agent turn fails (only if app not focused). */
  notifyOnAgentError: boolean;
};

export type SaveResult = "ok" | "stripped" | "failed";

const VALID_THINKING = new Set<ThinkingLevel>([
  "off",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
]);
const VALID_ACCESS = new Set<AccessMode>(["workspace", "full"]);
const VALID_PERMISSION = new Set<PermissionMode>(["auto", "ask"]);
const VALID_AGENT = new Set<AgentMode>(["plan", "build"]);
const VALID_MESSAGE_ROLES = new Set<Message["role"]>([
  "user",
  "assistant",
  "system",
]);
const VALID_TOOL_STATUSES = new Set<ToolCallStatus>([
  "awaiting",
  "running",
  "done",
  "error",
  "denied",
]);

/** In-memory mirror so sync loaders work after async hydrate from SQLite. */
const mem = new Map<string, string>();
let hydrated = false;
let hydratePromise: Promise<void> | null = null;
let revisionCounter = 0;

const LOCAL_RECORD_VERSION = 1;
const KV_GET_RETRY_DELAYS_MS = [10, 25] as const;

type TauriLocalRecord =
  | {
      version: typeof LOCAL_RECORD_VERSION;
      revision: string;
      state: "pending-set";
      value: string;
    }
  | {
      version: typeof LOCAL_RECORD_VERSION;
      revision: string;
      state: "pending-remove";
    }
  | {
      version: typeof LOCAL_RECORD_VERSION;
      revision: string;
      state: "cache";
      value: string;
    };

type StagedSet = {
  key: string;
  value: string;
  revision: string;
  localStaged: boolean;
  tauri: boolean;
};

type StagedRemove = {
  key: string;
  revision: string;
  localStaged: boolean;
  tauri: boolean;
};

type StagedKvOperation = StagedSet | StagedRemove;

function parseTauriLocalRecord(raw: string | null): TauriLocalRecord | null {
  if (raw == null) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<TauriLocalRecord>;
    if (
      parsed.version !== LOCAL_RECORD_VERSION ||
      typeof parsed.revision !== "string"
    ) {
      return null;
    }
    if (parsed.state === "pending-remove") {
      return {
        version: LOCAL_RECORD_VERSION,
        revision: parsed.revision,
        state: parsed.state,
      };
    }
    if (
      (parsed.state === "pending-set" || parsed.state === "cache") &&
      typeof parsed.value === "string"
    ) {
      return {
        version: LOCAL_RECORD_VERSION,
        revision: parsed.revision,
        state: parsed.state,
        value: parsed.value,
      };
    }
    return null;
  } catch {
    return null;
  }
}

function readTauriLocalRecord(key: string): TauriLocalRecord | null {
  return parseTauriLocalRecord(localStorage.getItem(key));
}

function writeTauriLocalRecord(key: string, record: TauriLocalRecord): boolean {
  try {
    localStorage.setItem(key, JSON.stringify(record));
    return true;
  } catch {
    return false;
  }
}

function nextRevision(): string {
  revisionCounter += 1;
  return `${Date.now().toString(36)}-${revisionCounter.toString(36)}`;
}

function lsGet(key: string): string | null {
  if (mem.has(key)) return mem.get(key) ?? null;
  try {
    const raw = localStorage.getItem(key);
    if (!isTauri()) return raw;
    const record = parseTauriLocalRecord(raw);
    if (!record || record.state === "pending-remove") return null;
    return record.value;
  } catch {
    return null;
  }
}

function canPersistStore(): boolean {
  return !isTauri() || hydrated;
}

const inFlightKvWrites = new Set<Promise<unknown>>();
const enqueueKvWrite = createKeyedSerialQueue();
const latestKvOperations = new Map<string, string>();
const failedKvOperations = new Map<string, StagedKvOperation>();

/** Register a fire-and-forget kv write so flushStore can await it before exit. */
function trackKvWrite(p: Promise<unknown>): void {
  inFlightKvWrites.add(p);
  void p.finally(() => {
    inFlightKvWrites.delete(p);
  });
}

function stageKvSet(key: string, value: string): StagedSet {
  mem.set(key, value);
  const revision = nextRevision();
  latestKvOperations.set(key, revision);
  failedKvOperations.delete(key);
  if (!isTauri()) {
    let localStaged = false;
    try {
      localStorage.setItem(key, value);
      localStaged = true;
    } catch {
      /* reported by the queued completion */
    }
    return { key, value, revision, localStaged, tauri: false };
  }

  const localStaged = writeTauriLocalRecord(key, {
    version: LOCAL_RECORD_VERSION,
    revision,
    state: "pending-set",
    value,
  });
  return { key, value, revision, localStaged, tauri: true };
}

function stageKvRemove(key: string): StagedRemove {
  mem.delete(key);
  const revision = nextRevision();
  latestKvOperations.set(key, revision);
  failedKvOperations.delete(key);
  if (!isTauri()) {
    let localStaged = false;
    try {
      localStorage.removeItem(key);
      localStaged = true;
    } catch {
      /* reported by the queued completion */
    }
    return { key, revision, localStaged, tauri: false };
  }

  const localStaged = writeTauriLocalRecord(key, {
    version: LOCAL_RECORD_VERSION,
    revision,
    state: "pending-remove",
  });
  return { key, revision, localStaged, tauri: true };
}

function finishLocalSet(operation: StagedSet): void {
  if (latestKvOperations.get(operation.key) !== operation.revision) return;
  latestKvOperations.delete(operation.key);
  const cached = writeTauriLocalRecord(operation.key, {
    version: LOCAL_RECORD_VERSION,
    revision: operation.revision,
    state: "cache",
    value: operation.value,
  });
  if (cached || operation.localStaged) return;
  try {
    // Staging failed, so any surviving record belongs to an older intent.
    localStorage.removeItem(operation.key);
  } catch {
    /* SQLite is already authoritative */
  }
}

function finishLocalRemove(operation: StagedRemove): void {
  if (latestKvOperations.get(operation.key) !== operation.revision) return;
  latestKvOperations.delete(operation.key);
  try {
    localStorage.removeItem(operation.key);
  } catch {
    /* SQLite is already authoritative */
  }
}

function clearFailedKvOperation(operation: StagedKvOperation): void {
  if (failedKvOperations.get(operation.key)?.revision === operation.revision) {
    failedKvOperations.delete(operation.key);
  }
}

function recordFailedKvOperation(operation: StagedKvOperation): boolean {
  // Thread writes have their own payload-aware retry path below.
  if (operation.key === THREADS_KEY) return operation.localStaged;
  if (latestKvOperations.get(operation.key) !== operation.revision) return true;
  if (operation.localStaged) {
    latestKvOperations.delete(operation.key);
    clearFailedKvOperation(operation);
    return true;
  }
  failedKvOperations.set(operation.key, operation);
  return false;
}

function retryLocalSetStage(operation: StagedSet): StagedSet {
  if (
    operation.localStaged ||
    latestKvOperations.get(operation.key) !== operation.revision
  ) {
    return operation;
  }
  return {
    ...operation,
    localStaged: writeTauriLocalRecord(operation.key, {
      version: LOCAL_RECORD_VERSION,
      revision: operation.revision,
      state: "pending-set",
      value: operation.value,
    }),
  };
}

function retryLocalRemoveStage(operation: StagedRemove): StagedRemove {
  if (
    operation.localStaged ||
    latestKvOperations.get(operation.key) !== operation.revision
  ) {
    return operation;
  }
  return {
    ...operation,
    localStaged: writeTauriLocalRecord(operation.key, {
      version: LOCAL_RECORD_VERSION,
      revision: operation.revision,
      state: "pending-remove",
    }),
  };
}

function commitKvSet(operation: StagedSet): Promise<boolean> {
  const write = enqueueKvWrite(operation.key, async () => {
    if (!operation.tauri) {
      if (latestKvOperations.get(operation.key) !== operation.revision) return true;
      if (!operation.localStaged) {
        try {
          localStorage.setItem(operation.key, operation.value);
        } catch {
          return recordFailedKvOperation(operation);
        }
      }
      latestKvOperations.delete(operation.key);
      clearFailedKvOperation(operation);
      return true;
    }
    operation = retryLocalSetStage(operation);
    try {
      await invoke("kv_set", { key: operation.key, value: operation.value });
      finishLocalSet(operation);
      clearFailedKvOperation(operation);
      return true;
    } catch {
      return recordFailedKvOperation(operation);
    }
  });
  trackKvWrite(write);
  return write;
}

function commitKvRemove(operation: StagedRemove): Promise<boolean> {
  const write = enqueueKvWrite(operation.key, async () => {
    if (!operation.tauri) {
      if (latestKvOperations.get(operation.key) !== operation.revision) return true;
      if (!operation.localStaged) {
        try {
          localStorage.removeItem(operation.key);
        } catch {
          return recordFailedKvOperation(operation);
        }
      }
      latestKvOperations.delete(operation.key);
      clearFailedKvOperation(operation);
      return true;
    }
    operation = retryLocalRemoveStage(operation);
    try {
      await invoke("kv_remove", { key: operation.key });
      finishLocalRemove(operation);
      clearFailedKvOperation(operation);
      return true;
    } catch {
      return recordFailedKvOperation(operation);
    }
  });
  trackKvWrite(write);
  return write;
}

function kvSet(key: string, value: string): Promise<boolean> {
  return commitKvSet(stageKvSet(key, value));
}

function kvRemove(key: string): Promise<boolean> {
  return commitKvRemove(stageKvRemove(key));
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function readSqliteWithRetry(key: string): Promise<string | null> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= KV_GET_RETRY_DELAYS_MS.length; attempt += 1) {
    try {
      return await invoke<string | null>("kv_get", { key });
    } catch (error) {
      lastError = error;
      const delay = KV_GET_RETRY_DELAYS_MS[attempt];
      if (delay == null) break;
      await wait(delay);
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error(`Failed to read durable store key ${key}`);
}

function replacePendingSetWithCache(
  key: string,
  pending: Extract<TauriLocalRecord, { state: "pending-set" }>,
): void {
  try {
    const current = readTauriLocalRecord(key);
    if (
      current?.state !== "pending-set" ||
      current.revision !== pending.revision
    ) {
      return;
    }
    writeTauriLocalRecord(key, {
      version: LOCAL_RECORD_VERSION,
      revision: pending.revision,
      state: "cache",
      value: pending.value,
    });
  } catch {
    /* replaying the same intent next launch is safe */
  }
}

function removePendingRecord(
  key: string,
  pending: Extract<TauriLocalRecord, { state: "pending-remove" }>,
): void {
  try {
    const current = readTauriLocalRecord(key);
    if (
      current?.state !== "pending-remove" ||
      current.revision !== pending.revision
    ) {
      return;
    }
    localStorage.removeItem(key);
  } catch {
    /* replaying the same intent next launch is safe */
  }
}

async function hydrateTauriKey(key: string): Promise<string | null> {
  let localRecord: TauriLocalRecord | null;
  try {
    localRecord = readTauriLocalRecord(key);
  } catch (error) {
    throw error instanceof Error
      ? error
      : new Error(`Failed to read local store key ${key}`);
  }

  const fromDb = await readSqliteWithRetry(key);
  if (localRecord?.state === "pending-set") {
    await invoke("kv_set", { key, value: localRecord.value });
    replacePendingSetWithCache(key, localRecord);
    return localRecord.value;
  }
  if (localRecord?.state === "pending-remove") {
    await invoke("kv_remove", { key });
    removePendingRecord(key, localRecord);
    return null;
  }

  if (fromDb == null) {
    try {
      localStorage.removeItem(key);
    } catch {
      /* SQLite remains authoritative */
    }
    return null;
  }

  const revision = localRecord?.revision ?? nextRevision();
  writeTauriLocalRecord(key, {
    version: LOCAL_RECORD_VERSION,
    revision,
    state: "cache",
    value: fromDb,
  });
  return fromDb;
}

/** Load durable store into memory before trusting load* results in Tauri. */
export async function hydrateStore(): Promise<void> {
  if (hydrated) return;
  if (hydratePromise) return hydratePromise;

  const currentHydration = (async () => {
    const keys = [THREADS_KEY, PROJECTS_KEY, PREFS_KEY, ACTIVE_KEY] as const;
    if (!isTauri()) {
      for (const key of keys) {
        try {
          const value = localStorage.getItem(key);
          if (value != null) mem.set(key, value);
        } catch {
          /* browser storage remains best-effort */
        }
      }
      hydrated = true;
      return;
    }

    const hydratedValues = new Map<string, string>();
    for (const key of keys) {
      const value = await hydrateTauriKey(key);
      if (value != null) hydratedValues.set(key, value);
    }

    for (const key of keys) {
      const value = hydratedValues.get(key);
      if (value == null) mem.delete(key);
      else mem.set(key, value);
    }
    hydrated = true;
  })();
  hydratePromise = currentHydration;
  try {
    await currentHydration;
  } finally {
    if (hydratePromise === currentHydration) hydratePromise = null;
  }
}

export function isStoreHydrated(): boolean {
  return hydrated;
}

export function loadPrefs(): AppPrefs {
  const defaults: AppPrefs = {
    modelId: DEFAULT_MODEL_ID,
    thinking: DEFAULT_THINKING,
    openaiFastMode: false,
    accessMode: DEFAULT_ACCESS_MODE,
    permissionMode: DEFAULT_PERMISSION_MODE,
    agentMode: DEFAULT_AGENT_MODE,
    sidebarOpen: true,
    activeProjectId: null,
    collapseThinking: false,
    keybindings: [...DEFAULT_KEYBINDINGS],
    notifyOnAgentComplete: true,
    notifyOnAgentError: true,
  };
  try {
    const raw = lsGet(PREFS_KEY);
    if (!raw) return defaults;
    const p = JSON.parse(raw) as Partial<AppPrefs>;
    const storedModelId =
      typeof p.modelId === "string" ? p.modelId.trim() : "";
    const modelId =
      storedModelId && isKnownModelId(storedModelId)
        ? storedModelId
        : defaults.modelId;
    const thinking =
      typeof p.thinking === "string" &&
      VALID_THINKING.has(p.thinking as ThinkingLevel)
        ? (p.thinking as ThinkingLevel)
        : defaults.thinking;
    const accessMode =
      typeof p.accessMode === "string" &&
      VALID_ACCESS.has(p.accessMode as AccessMode)
        ? (p.accessMode as AccessMode)
        : defaults.accessMode;
    const permissionMode =
      typeof p.permissionMode === "string" &&
      VALID_PERMISSION.has(p.permissionMode as PermissionMode)
        ? (p.permissionMode as PermissionMode)
        : defaults.permissionMode;
    const agentMode =
      typeof p.agentMode === "string" &&
      VALID_AGENT.has(p.agentMode as AgentMode)
        ? (p.agentMode as AgentMode)
        : defaults.agentMode;
    return {
      modelId,
      thinking,
      openaiFastMode:
        typeof p.openaiFastMode === "boolean"
          ? p.openaiFastMode
          : defaults.openaiFastMode,
      accessMode,
      permissionMode,
      agentMode,
      sidebarOpen:
        typeof p.sidebarOpen === "boolean" ? p.sidebarOpen : defaults.sidebarOpen,
      activeProjectId:
        typeof p.activeProjectId === "string" || p.activeProjectId === null
          ? p.activeProjectId
          : defaults.activeProjectId,
      collapseThinking:
        typeof p.collapseThinking === "boolean"
          ? p.collapseThinking
          : defaults.collapseThinking,
      keybindings: normalizeStoredKeybindings(p.keybindings),
      notifyOnAgentComplete:
        typeof p.notifyOnAgentComplete === "boolean"
          ? p.notifyOnAgentComplete
          : defaults.notifyOnAgentComplete,
      notifyOnAgentError:
        typeof p.notifyOnAgentError === "boolean"
          ? p.notifyOnAgentError
          : defaults.notifyOnAgentError,
    };
  } catch {
    return defaults;
  }
}

export function savePrefs(prefs: AppPrefs) {
  if (!canPersistStore()) return;
  const raw = JSON.stringify(prefs);
  void kvSet(PREFS_KEY, raw);
}

export function loadProjects(): Project[] {
  try {
    const raw = lsGet(PROJECTS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    const now = Date.now();
    return parsed.flatMap((value): Project[] => {
      if (value == null || typeof value !== "object") return [];
      const project = value as Partial<Project>;
      if (
        typeof project.id !== "string" ||
        !project.id.trim() ||
        typeof project.name !== "string" ||
        !project.name.trim() ||
        typeof project.path !== "string" ||
        !project.path.trim()
      ) {
        return [];
      }
      const createdAt = finiteNumber(project.createdAt) ?? now;
      return [
        {
          id: project.id,
          name: project.name,
          path: project.path,
          createdAt,
          updatedAt: finiteNumber(project.updatedAt) ?? createdAt,
          collapsed: Boolean(project.collapsed),
        },
      ];
    });
  } catch {
    return [];
  }
}

export function saveProjects(projects: Project[]) {
  if (!canPersistStore()) return;
  const raw = JSON.stringify(projects);
  void kvSet(PROJECTS_KEY, raw);
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function normalizeToolCalls(value: unknown, depth = 0): ToolCall[] | undefined {
  if (!Array.isArray(value)) return undefined;
  if (depth >= 20) return [];
  return value.flatMap((entry): ToolCall[] => {
    if (entry == null || typeof entry !== "object") return [];
    const call = entry as Partial<ToolCall>;
    if (
      typeof call.id !== "string" ||
      typeof call.name !== "string" ||
      typeof call.args !== "string" ||
      typeof call.status !== "string" ||
      !VALID_TOOL_STATUSES.has(call.status as ToolCallStatus)
    ) {
      return [];
    }
    const normalized: ToolCall = {
      id: call.id,
      name: call.name,
      args: call.args,
      status: call.status as ToolCallStatus,
    };
    if (typeof call.result === "string") normalized.result = call.result;
    if (typeof call.approvalReason === "string") {
      normalized.approvalReason = call.approvalReason;
    }
    if (typeof call.imageUrl === "string") normalized.imageUrl = call.imageUrl;
    const children = normalizeToolCalls(call.children, depth + 1);
    if (children) normalized.children = children;
    return [normalized];
  });
}

function normalizeMessageParts(value: unknown): MessagePart[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.flatMap((entry): MessagePart[] => {
    if (entry == null || typeof entry !== "object") return [];
    const part = entry as Partial<MessagePart>;
    if (
      (part.type === "thinking" || part.type === "text") &&
      typeof part.id === "string" &&
      typeof part.text === "string"
    ) {
      return [{ type: part.type, id: part.id, text: part.text }];
    }
    if (part.type === "tool" && typeof part.id === "string") {
      const calls = normalizeToolCalls([part.call]);
      if (calls?.[0]) return [{ type: "tool", id: part.id, call: calls[0] }];
    }
    return [];
  });
}

function normalizeAttachments(value: unknown): ImageAttachment[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.flatMap((entry): ImageAttachment[] => {
    if (entry == null || typeof entry !== "object") return [];
    const attachment = entry as Partial<ImageAttachment>;
    if (
      typeof attachment.id !== "string" ||
      typeof attachment.name !== "string" ||
      typeof attachment.mime !== "string" ||
      typeof attachment.dataUrl !== "string"
    ) {
      return [];
    }
    return [attachment as ImageAttachment];
  });
}

function normalizeMessage(value: unknown, fallbackCreatedAt: number): Message | null {
  if (value == null || typeof value !== "object") return null;
  const message = value as Partial<Message>;
  if (
    typeof message.id !== "string" ||
    !message.id ||
    typeof message.role !== "string" ||
    !VALID_MESSAGE_ROLES.has(message.role as Message["role"])
  ) {
    return null;
  }
  const normalized: Message = {
    id: message.id,
    role: message.role as Message["role"],
    content: typeof message.content === "string" ? message.content : "",
    createdAt: finiteNumber(message.createdAt) ?? fallbackCreatedAt,
  };
  if (typeof message.thinking === "string") normalized.thinking = message.thinking;
  const toolCalls = normalizeToolCalls(message.toolCalls);
  if (toolCalls) normalized.toolCalls = toolCalls;
  const parts = normalizeMessageParts(message.parts);
  if (parts) normalized.parts = parts;
  const attachments = normalizeAttachments(message.attachments);
  if (attachments) normalized.attachments = attachments;
  const durationMs = finiteNumber(message.durationMs);
  if (durationMs != null) normalized.durationMs = durationMs;
  return finalizeRunningTools(
    normalized,
    "Interrupted by app restart",
    "error",
  );
}

function normalizeThreads(parsed: unknown[]): Thread[] {
  const out: Thread[] = [];
  for (const raw of parsed) {
    // Salvage per entry: one malformed record must not poison (or wipe) the rest.
    if (raw == null || typeof raw !== "object") continue;
    const t = raw as Partial<Thread>;
    if (
      typeof t.id !== "string" ||
      !t.id ||
      typeof t.title !== "string"
    ) {
      continue;
    }
    const rawMessages = Array.isArray(t.messages) ? t.messages : [];
    const fallbackCreatedAt =
      finiteNumber(t.createdAt) ?? finiteNumber(t.updatedAt) ?? Date.now();
    const messages = rawMessages.flatMap((message): Message[] => {
      const normalized = normalizeMessage(message, fallbackCreatedAt);
      return normalized ? [normalized] : [];
    });
    const firstMsgAt = messages[0]?.createdAt;
    const createdAt =
      finiteNumber(t.createdAt) != null
        ? (t.createdAt as number)
        : typeof firstMsgAt === "number"
          ? firstMsgAt
          : fallbackCreatedAt;
    out.push({
      id: t.id,
      title: t.title,
      projectId: typeof t.projectId === "string" ? t.projectId : null,
      messages,
      createdAt,
      updatedAt: finiteNumber(t.updatedAt) ?? createdAt,
      pinned: Boolean(t.pinned),
      modelId: typeof t.modelId === "string" ? t.modelId : null,
      settledAt: finiteNumber(t.settledAt),
      snoozedUntil: finiteNumber(t.snoozedUntil),
      wokeAt: finiteNumber(t.wokeAt),
      lastVisitedAt: finiteNumber(t.lastVisitedAt),
      lastError: normalizeStoredError(t.lastError),
      archivedAt: finiteNumber(t.archivedAt),
      worktreePath: normalizeWorkspacePath(t.worktreePath),
      worktreeBranch: normalizeWorkspacePath(t.worktreeBranch),
    });
  }
  return out;
}

/**
 * Sync load of threads. Before hydrate finishes in Tauri, returns [] so the
 * UI does not mint a throwaway "New chat" that can later overwrite SQLite.
 */
export function loadThreads(): Thread[] {
  try {
    const raw = lsGet(THREADS_KEY);
    if (!raw) {
      if (!hydrated && isTauri()) return [];
      return [createThread(null)];
    }
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed) || parsed.length === 0) {
      if (!hydrated && isTauri()) return [];
      return [createThread(null)];
    }
    const projectIds = new Set(loadProjects().map((project) => project.id));
    const normalized = normalizeThreads(parsed).map((thread) =>
      thread.projectId !== null && !projectIds.has(thread.projectId)
        ? { ...thread, projectId: null }
        : thread,
    );
    return normalized.length > 0 ? normalized : [createThread(null)];
  } catch {
    if (!hydrated && isTauri()) return [];
    return [createThread(null)];
  }
}

function stripHeavyAttachments(threads: Thread[]): Thread[] {
  return threads.map((t) => ({
    ...t,
    messages: t.messages.map((m) => {
      if (!m.attachments?.length) return m;
      return {
        ...m,
        attachments: m.attachments.map((a) =>
          a.dataUrl && a.dataUrl.length > MAX_STORED_DATA_URL
            ? {
                ...a,
                dataUrl: "",
                name: a.name || "image",
              }
            : a,
        ),
      };
    }),
  }));
}

let saveThreadsTimer: ReturnType<typeof setTimeout> | null = null;
/** Latest threads object graph waiting to be stringified (cheap to overwrite). */
let pendingThreadsLive: Thread[] | null = null;
type PendingThreadsPayload = {
  raw: string;
  stripped: boolean;
  operation: StagedSet;
};
let pendingThreadsPayload: PendingThreadsPayload | null = null;
let failedThreadsPayload: PendingThreadsPayload | null = null;
let saveThreadsInFlight: Promise<SaveResult> | null = null;
const threadsSaveResultListeners = new Set<(result: SaveResult) => void>();

export function subscribeThreadsSaveResults(
  listener: (result: SaveResult) => void,
): () => void {
  threadsSaveResultListeners.add(listener);
  return () => threadsSaveResultListeners.delete(listener);
}

function publishThreadsSaveResult(result: SaveResult): void {
  for (const listener of threadsSaveResultListeners) listener(result);
}

function canPersistThreads(): boolean {
  return canPersistStore();
}

/** Serialize once — never call this on every stream frame. */
function materializeThreadsPayload(
  threads: Thread[],
): PendingThreadsPayload | null {
  let raw: string;
  try {
    raw = JSON.stringify(threads);
  } catch {
    return null;
  }

  return {
    raw,
    stripped: false,
    operation: stageKvSet(THREADS_KEY, raw),
  };
}

function takePendingPayload(): PendingThreadsPayload | null {
  if (pendingThreadsLive) {
    const live = pendingThreadsLive;
    pendingThreadsLive = null;
    const built = materializeThreadsPayload(live);
    if (built) pendingThreadsPayload = built;
  }
  const payload = pendingThreadsPayload;
  pendingThreadsPayload = null;
  return payload;
}

async function flushThreadsToDisk(): Promise<SaveResult> {
  const payload = takePendingPayload();
  if (!payload) return "ok";

  const ok = await commitKvSet(payload.operation);
  if (ok) {
    failedThreadsPayload = null;
    return payload.stripped ? "stripped" : "ok";
  }

  // Last resort: strip images and retry once.
  try {
    const threads = JSON.parse(payload.raw) as Thread[];
    const stripped = JSON.stringify(stripHeavyAttachments(threads));
    const ok2 = await commitKvSet(stageKvSet(THREADS_KEY, stripped));
    if (ok2) {
      failedThreadsPayload = null;
      return "stripped";
    }
    failedThreadsPayload = payload;
    return "failed";
  } catch {
    failedThreadsPayload = payload;
    return "failed";
  }
}

function kickThreadsFlush(): Promise<SaveResult> {
  // Chain onto any in-flight write so flushStore() can always await the tip.
  const run = async (): Promise<SaveResult> => {
    const result = await flushThreadsToDisk();
    if (pendingThreadsLive || pendingThreadsPayload) {
      return run();
    }
    return result;
  };
  const next = (saveThreadsInFlight ?? Promise.resolve("ok" as SaveResult))
    .catch(() => "failed" as SaveResult)
    .then(() => run());
  let tracked: Promise<SaveResult>;
  tracked = next
    .then((result) => {
      publishThreadsSaveResult(result);
      return result;
    })
    .finally(() => {
      if (saveThreadsInFlight === tracked) {
        saveThreadsInFlight = null;
      }
    });
  saveThreadsInFlight = tracked;
  return tracked;
}

function scheduleThreadsFlush(ms: number) {
  if (saveThreadsTimer != null) clearTimeout(saveThreadsTimer);
  saveThreadsTimer = setTimeout(() => {
    saveThreadsTimer = null;
    kickThreadsFlush();
  }, ms);
}

/**
 * Persist threads. During streaming, only retain the latest object graph and
 * stringify once on the debounced flush (OpenCode-style). Immediate saves
 * still materialize now so settle/delete/crash paths stay durable.
 */
export function saveThreads(
  threads: Thread[],
  opts?: { immediate?: boolean },
): SaveResult {
  if (!canPersistThreads()) return "failed";

  pendingThreadsLive = threads;

  if (opts?.immediate) {
    // Materialize once for crash-safe settle/delete; SQLite write still async.
    const built = materializeThreadsPayload(threads);
    pendingThreadsLive = null;
    if (!built) return "failed";
    pendingThreadsPayload = built;
    scheduleThreadsFlush(0);
    return built.stripped ? "stripped" : "ok";
  }

  // Streaming / high-churn path: defer JSON.stringify until flush.
  // Longer debounce while agents stream many tool patches.
  scheduleThreadsFlush(700);
  return "ok";
}

/** Force pending thread writes to disk (call on visibility hide / before unload). */
export async function flushStore(): Promise<SaveResult> {
  let result: SaveResult = "ok";
  for (const operation of [...failedKvOperations.values()]) {
    if (latestKvOperations.get(operation.key) !== operation.revision) {
      clearFailedKvOperation(operation);
      continue;
    }
    if ("value" in operation) {
      void commitKvSet(operation);
    } else {
      void commitKvRemove(operation);
    }
  }
  if (saveThreadsTimer != null) {
    clearTimeout(saveThreadsTimer);
    saveThreadsTimer = null;
  }
  // Always go through the same write chain as kickThreadsFlush — never call
  // flushThreadsToDisk concurrently or a stale payload can win the last kv_set.
  if (!pendingThreadsLive && !pendingThreadsPayload && failedThreadsPayload) {
    pendingThreadsPayload = failedThreadsPayload;
    failedThreadsPayload = null;
  }
  if (pendingThreadsLive || pendingThreadsPayload) {
    kickThreadsFlush();
  }
  if (saveThreadsInFlight) {
    result = await saveThreadsInFlight;
  }
  // One more pass if a save landed while we awaited.
  if (pendingThreadsLive || pendingThreadsPayload) {
    kickThreadsFlush();
    if (saveThreadsInFlight) result = await saveThreadsInFlight;
  }
  // Also wait for any fire-and-forget kv writes (prefs/projects/activeId) so a
  // window destroyed right after a settings change cannot lose them.
  while (inFlightKvWrites.size > 0) {
    const batch = [...inFlightKvWrites];
    const settled = await Promise.allSettled(batch);
    if (
      settled.some(
        (entry) => entry.status === "rejected" || entry.value === false,
      )
    ) {
      result = "failed";
    }
  }
  if (failedKvOperations.size > 0) result = "failed";
  return result;
}

/** Prefer non-archived threads for the open chat (archived stay in Settings only). */
export function liveThreads(threads: readonly Thread[]): Thread[] {
  return threads.filter((t) => t.archivedAt == null);
}

/**
 * Next thread to open after deleting `excludeId`.
 * Never jumps into the archive; returns null when only archived chats remain
 * (caller should spawn a fresh empty chat).
 */
export function pickNextLiveThreadId(
  threads: readonly Thread[],
  excludeId: string | null | undefined,
): string | null {
  for (const t of threads) {
    if (excludeId && t.id === excludeId) continue;
    if (t.archivedAt != null) continue;
    return t.id;
  }
  return null;
}

export function loadActiveId(
  threads: Thread[],
  fallback: string | null,
): string | null {
  const live = liveThreads(threads);
  // If every chat is archived, leave active unset — UI should open a fresh thread.
  if (live.length === 0) return null;
  try {
    const stored = lsGet(ACTIVE_KEY);
    if (stored && live.some((t) => t.id === stored)) return stored;
    if (fallback && live.some((t) => t.id === fallback)) return fallback;
    return live[0]?.id ?? null;
  } catch {
    if (fallback && live.some((t) => t.id === fallback)) return fallback;
    return live[0]?.id ?? null;
  }
}

export function saveActiveId(id: string | null) {
  if (!canPersistStore()) return;
  if (id) {
    void kvSet(ACTIVE_KEY, id);
  } else {
    void kvRemove(ACTIVE_KEY);
  }
}
