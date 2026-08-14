import {
  Component,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { flushSync } from "react-dom";
import { open } from "@tauri-apps/plugin-dialog";
import { CircleCheck } from "lucide-react";
import { requestConfirmDialog } from "./confirmDialog";
import {
  loadSidebarWidth,
  SidebarFloatingControls,
  SidebarV2,
} from "./components/Sidebar";
import {
  canSettle,
  DEFAULT_AUTO_SETTLE_AFTER_DAYS,
  effectiveSettled,
  isSidebarThreadVisible,
  wakeThreadForAttention,
} from "./components/Sidebar.logic";
import { MessageList } from "./components/MessageList";
import { Composer } from "./components/Composer";
import { ComposerContextStrip } from "./components/ComposerContextStrip";
import { ConfirmDialogHost } from "./components/ConfirmDialogHost";
import { BrowserPreviewPanel } from "./components/BrowserPreviewPanel";
import {
  RightPanelToggle,
  TerminalToggle,
  type RightPanelPage,
} from "./components/RightPanelControls";
import { Welcome } from "./components/Welcome";
import { BootSplash } from "./components/BootSplash";
import { AuthModal } from "./components/AuthModal";
import { SignInProviderModal } from "./components/auth/SignInProviderModal";
import { ProfilePage } from "./components/ProfilePage";
import { UsagePage } from "./components/UsagePage";
import {
  OpenCodeUpdateNotice,
  ProvidersPage,
} from "./components/ProvidersPage";
import {
  settleIncompleteTodosInMessages,
  settleIncompleteTodosOnMessage,
} from "./plan";
import {
  CommandPalette,
  type CommandPaletteView,
  type PaletteAction,
} from "./components/CommandPalette";
import { ProjectFilePicker } from "./components/ProjectFilePicker";
import type { SlashCommandHandlers } from "./slashCommands";
import {
  getProfile,
  recordActivity,
  recordOpenAITokenActivity,
  type UserProfile,
} from "./profile";
import {
  approveChatTool,
  cancelChatStream,
  cancelLogin,
  cancelOpenAILogin,
  denyChatTool,
  getAuthStatus,
  getOpenAIAuthStatus,
  listSnapshots,
  loginWithGrok,
  loginWithOpenAI,
  logoutGrok,
  logoutOpenAI,
  onAuthStatus,
  onDeviceCode,
  onOpenAIAuthStatus,
  onOpenAIDeviceCode,
  registerProjectRoot,
  rejectChatUserInput,
  replyToChatUserInput,
  restoreSnapshots,
  streamChat,
  unregisterProjectRoot,
  type AuthStatus,
  type ChatMsg,
  type DeviceCodeEvent,
  type OpenAIAuthStatus,
} from "./auth";
import type { UserInputRequest } from "./userInput";
import {
  createId,
  createProject,
  createThread,
  type ImageAttachment,
  type Message,
  type Project,
  type Thread,
} from "./types";
import {
  appendTextPart,
  appendThinkingPart,
  finalizeRunningTools,
  isEmptyAssistantTurn,
  markToolRunning,
  upsertToolOutputPart,
  upsertToolResultPart,
  upsertToolStartPart,
} from "./messageParts";
import {
  agentNotificationBody,
  titleFromPrompt,
  messageToChat,
} from "./app/messageChat";
import {
  needsOrdinaryThreadForProjectSelection,
  rebindThreadProjectOnSelection,
} from "./app/projectSelection";
import { useKeybindingDispatcher } from "./app/keybindingDispatcher";
import {
  canClearStashedComposer,
  isCurrentComposerOwner,
} from "./composerOwnership";
import { forkThreadAtMessage } from "./app/threadFork";
import { findSendTargetProject, resolveSendTarget } from "./app/sendTarget";
import { queuedComposerDraft } from "./app/queuedComposer";
import { createAsyncCleanupGuard } from "./asyncCleanup";
import { createThreadStore, type ThreadStoreSetOpts } from "./app/threadStore";
import {
  followUpAfterInterrupt,
  stripFollowUpInterruptNote,
} from "./chat/followUpInterrupt";
import { isTauri } from "./lib/isTauri";
import { projectLiveFileChanges } from "./liveFileChanges";
import {
  collectReviewFileChanges,
  loadReviewDiffStyle,
  saveReviewDiffStyle,
  type ReviewDiffStyle,
  type ReviewFileChange,
  type ReviewScope,
} from "./reviewChanges";
import {
  appendReviewComments,
  type ReviewComment,
  type ReviewCommentSelection,
} from "./reviewComments";
import { collectPendingApprovals, runApprovalBatch } from "./toolApproval";
import { resolveThreadAttentionById } from "./threadAttention";
import {
  filterToolIdsWithSnapshots,
  mutationToolIdsForUndo,
  toolIdsFromReviewFiles,
} from "./snapshotUndo";
import { ReviewChangesPanel } from "./components/ReviewChangesPanel";
import { TerminalPanel } from "./components/TerminalPanel";
import { OpenInControls } from "./components/OpenInControls";
import {
  fetchGitDiff,
  fetchGitRefs,
  fetchGitStatus,
  gitCommit,
  gitDiffToReviewFiles,
  gitOpenPr,
  gitPush,
  gitWorktreeCreate,
  gitWorktreeRemove,
  summarizeGitStatus,
  type GitDiffResult,
  type GitRef,
  type GitStatus,
} from "./git";
import { resolveWorktreeBaseRef } from "./gitRefs";
import { openProjectIn, type OpenInTarget } from "./openIn";
import { resolveWorkspacePath, workspaceValueForPath } from "./gitWorkspace";
import {
  flushStore,
  hydrateStore,
  loadActiveId,
  liveThreads,
  loadPrefs,
  loadProjects,
  loadThreads,
  pickNextLiveThreadId,
  saveActiveId,
  savePrefs,
  saveProjects,
  saveThreads,
  subscribeThreadsSaveResults,
  type SaveResult,
} from "./store";
import {
  configureAntigravityModels,
  configureOpenCodeModels,
  providerOf,
  reconcileAvailableModelId,
  supportsFastMode,
  thinkingForModel,
  type AccessMode,
  type AgentMode,
  type PermissionMode,
  type ModelProvider,
  type ProviderAvailability,
  type ThinkingLevel,
} from "./models";
import {
  antigravityModelsForCatalog,
  EMPTY_ANTIGRAVITY_STATUS,
  getAntigravityStatus,
  loadAntigravityEnabled,
  saveAntigravityEnabled,
  type AntigravityStatus,
} from "./antigravity";
import {
  EMPTY_OPENCODE_STATUS,
  getOpenCodeStatus,
  isOpenCodeReadyForWorkspace,
  loadOpenCodeEnabled,
  loadOpenCodeHealthInterval,
  openCodeModelsForCatalog,
  saveOpenCodeEnabled,
  saveOpenCodeHealthInterval,
  updateOpenCode,
  type OpenCodeStatus,
} from "./opencode";
import {
  canSelectModelForThread,
  lockedProviderForThread,
  modelPermissionConflict,
  threadModelId,
} from "./threadModel";
import {
  applyTheme,
  loadTheme,
  resolveTheme,
  saveTheme,
  type ThemeMode,
} from "./theme";
import { useToast } from "./toast";
import {
  ensureNotifyPermission,
  installNotificationSoundUnlock,
  notifyAgentDone,
} from "./desktopNotify";
import { contextUsage } from "./contextMeter";
import { isImportedCodexThread } from "./codexImportedThreads";
import {
  applyCompactionIfCurrent,
  compactMessages,
  formatCompactResultToast,
} from "./compactHistory";
import { installZoomHotkeys } from "./zoom";
import {
  sanitizeThinkingContent,
  sanitizeUserFacingContent,
} from "./sanitizeContent";
import {
  createUserFacingError,
  normalizeUserFacingError,
  redactSensitiveValues,
  safeErrorMessage,
  type UserFacingError,
} from "./lib/userFacingError";
import {
  clearStreamErrorDismissal,
  dismissStreamError,
  visibleStreamError,
  type StreamErrorDismissals,
} from "./streamErrorDismissal";
import {
  loadStash,
  mergeStashAttachments,
  prepareStashAttachments,
  removeStashEntry,
  stashPrompt,
  takeStashEntry,
  type StashEntry,
} from "./promptStash";
import {
  createQueuedSend,
  queueForThread,
  removeQueued,
  takeNextForThread,
  type QueuedSend,
} from "./sendQueue";
import { createRafStreamBatcher } from "./streamBatch";
import {
  applyStreamOverlay,
  createStreamOverlayStore,
  materializeStreamOverlays,
} from "./streamOverlay";
import {
  emitKeybindingCommand,
  type KeybindingRule,
} from "./keybindings";
import "./App.css";

const FilePreviewPanel = lazy(() => import("./components/FilePreviewPanel"));
const SettingsModal = lazy(() =>
  import("./components/SettingsModal").then((module) => ({
    default: module.SettingsModal,
  })),
);

class SettingsLoadBoundary extends Component<
  { children: ReactNode; onError: () => void },
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: unknown) {
    console.error("Failed to load Settings", error);
    this.props.onError();
  }

  render() {
    return this.state.failed ? null : this.props.children;
  }
}

export default function App() {
  const toast = useToast();
  const initialPrefs = useMemo(() => loadPrefs(), []);
  const [projects, setProjects] = useState<Project[]>(loadProjects);
  const projectsRef = useRef(projects);
  projectsRef.current = projects;
  const threadStoreRef = useRef<ReturnType<typeof createThreadStore> | null>(
    null,
  );
  if (!threadStoreRef.current) {
    threadStoreRef.current = createThreadStore(loadThreads());
  }
  const threadStore = threadStoreRef.current;
  const threads = useSyncExternalStore(
    threadStore.subscribe,
    threadStore.getSnapshot,
    threadStore.getSnapshot,
  );
  const threadsRef = useRef(threads);
  threadsRef.current = threads;
  const setThreads = useCallback(
    (
      updater: Thread[] | ((prev: Thread[]) => Thread[]),
      opts?: ThreadStoreSetOpts,
    ) => {
      const next = threadStore.setThreads(updater, opts);
      threadsRef.current = next;
      return next;
    },
    [threadStore],
  );
  /** Live stream tokens live here — not in `threads` — so Sidebar stays idle. */
  const streamOverlayRef = useRef<ReturnType<
    typeof createStreamOverlayStore
  > | null>(null);
  if (!streamOverlayRef.current) {
    streamOverlayRef.current = createStreamOverlayStore();
  }
  const streamOverlay = streamOverlayRef.current;
  const streamOverlayMap = useSyncExternalStore(
    streamOverlay.subscribe,
    streamOverlay.getSnapshot,
    streamOverlay.getSnapshot,
  );
  const composerEpochRef = useRef(0);
  const [activeId, setActiveIdState] = useState<string | null>(() => {
    const list = loadThreads();
    const live = liveThreads(list);
    return loadActiveId(list, live[0]?.id ?? null);
  });
  const setActiveId = useCallback((next: SetStateAction<string | null>) => {
    composerEpochRef.current += 1;
    setActiveIdState(next);
  }, []);
  const activeIdRef = useRef(activeId);
  activeIdRef.current = activeId;
  const [activeProjectId, setActiveProjectId] = useState<string | null>(() => {
    const id = initialPrefs.activeProjectId;
    if (!id) return null;
    return loadProjects().some((p) => p.id === id) ? id : null;
  });
  const [draft, setDraftState] = useState("");
  const setDraft = useCallback<Dispatch<SetStateAction<string>>>((next) => {
    composerEpochRef.current += 1;
    setDraftState(next);
  }, []);
  const [attachments, setAttachmentsState] = useState<ImageAttachment[]>([]);
  const setAttachments = useCallback<
    Dispatch<SetStateAction<ImageAttachment[]>>
  >((next) => {
    composerEpochRef.current += 1;
    setAttachmentsState(next);
  }, []);
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const attachmentsRef = useRef(attachments);
  attachmentsRef.current = attachments;
  const [reviewComments, setReviewComments] = useState<ReviewComment[]>([]);
  const [query, setQuery] = useState("");
  const [sidebarSearchOpen, setSidebarSearchOpen] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(initialPrefs.sidebarOpen);
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const [isNarrowViewport, setIsNarrowViewport] = useState(() =>
    window.matchMedia("(max-width: 640px)").matches,
  );
  const [keybindings, setKeybindings] = useState<ReadonlyArray<KeybindingRule>>(
    initialPrefs.keybindings,
  );
  const [sidebarWidth, setSidebarWidth] = useState(loadSidebarWidth);
  const effectiveSidebarOpen = isNarrowViewport
    ? mobileSidebarOpen
    : sidebarOpen;
  const setEffectiveSidebarOpen = useCallback(
    (open: boolean) => {
      if (isNarrowViewport) setMobileSidebarOpen(open);
      else setSidebarOpen(open);
    },
    [isNarrowViewport],
  );
  const toggleEffectiveSidebar = useCallback(() => {
    if (isNarrowViewport) setMobileSidebarOpen((open) => !open);
    else setSidebarOpen((open) => !open);
  }, [isNarrowViewport]);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [filesOpen, setFilesOpen] = useState(false);
  const [terminalOpen, setTerminalOpen] = useState(false);
  /** Which page is shown when the right panel is open. */
  const [rightPanelPage, setRightPanelPage] =
    useState<RightPanelPage>("review");
  const [reviewScope, setReviewScope] = useState<ReviewScope>("turn");
  const [reviewDiffStyle, setReviewDiffStyleState] =
    useState<ReviewDiffStyle>(loadReviewDiffStyle);
  const setReviewDiffStyle = useCallback((style: ReviewDiffStyle) => {
    setReviewDiffStyleState(saveReviewDiffStyle(style));
  }, []);
  const [reviewActivePath, setReviewActivePath] = useState<string | null>(null);
  const [gitStatus, setGitStatus] = useState<GitStatus | null>(null);
  const [gitStatusPath, setGitStatusPath] = useState<string | null>(null);
  const [gitDiff, setGitDiff] = useState<GitDiffResult | null>(null);
  const [gitDiffPath, setGitDiffPath] = useState<string | null>(null);
  const [gitLoading, setGitLoading] = useState(false);
  const [gitRefs, setGitRefs] = useState<GitRef[]>([]);
  const [gitRefsPath, setGitRefsPath] = useState<string | null>(null);
  const [gitRefsLoading, setGitRefsLoading] = useState(false);
  const gitRefsReqSeqRef = useRef(0);
  const [worktreeBaseRefByProject, setWorktreeBaseRefByProject] = useState<
    Record<string, string>
  >({});
  const [gitBusy, setGitBusy] = useState(false);
  const [gitPrUrl, setGitPrUrl] = useState<string | null>(null);
  const [worktreeCreateBusy, setWorktreeCreateBusy] = useState(false);
  const worktreeCreateBusyRef = useRef(false);
  const worktreeCreateProjectIdRef = useRef<string | null>(null);
  const worktreeDeleteBusyRef = useRef<Set<string>>(new Set());
  const stashBusyRef = useRef(false);
  const gitRefreshTimerRef = useRef<number | null>(null);
  const gitReqSeqRef = useRef(0);
  const [modelId, setModelId] = useState(initialPrefs.modelId);
  const [thinking, setThinking] = useState<ThinkingLevel>(() =>
    thinkingForModel(initialPrefs.modelId, initialPrefs.thinking),
  );
  const [openaiFastMode, setOpenAIFastMode] = useState(
    () => initialPrefs.openaiFastMode,
  );
  const [accessMode, setAccessMode] = useState<AccessMode>(
    () => initialPrefs.accessMode,
  );
  const [permissionMode, setPermissionMode] = useState<PermissionMode>(
    () => initialPrefs.permissionMode,
  );
  const [agentMode, setAgentMode] = useState<AgentMode>(
    () => initialPrefs.agentMode,
  );
  /** Tool id currently being approved/denied (Ask mode UI). */
  const [approvalBusyId, setApprovalBusyId] = useState<string | null>(null);
  const [approvalAttentionEpoch, setApprovalAttentionEpoch] = useState(0);
  const [pendingUserInputByThread, setPendingUserInputByThread] = useState<
    Record<string, UserInputRequest>
  >({});
  const [userInputBusyByThread, setUserInputBusyByThread] = useState<
    Record<string, string>
  >({});
  const [undoBusy, setUndoBusy] = useState(false);
  /** Bumped after snapshot restore so canUndo re-lists. */
  const [snapshotEpoch, setSnapshotEpoch] = useState(0);
  const [canUndoReview, setCanUndoReview] = useState(false);
  const [collapseThinking, setCollapseThinking] = useState(
    () => initialPrefs.collapseThinking,
  );
  const [notifyOnAgentComplete, setNotifyOnAgentComplete] = useState(
    () => initialPrefs.notifyOnAgentComplete,
  );
  const [notifyOnAgentError, setNotifyOnAgentError] = useState(
    () => initialPrefs.notifyOnAgentError,
  );
  /** Thread ids currently receiving a stream (supports parallel chats). */
  const [streamingThreadIds, setStreamingThreadIds] = useState<string[]>([]);
  /** stream start epoch ms per thread id */
  const [streamStartedAtById, setStreamStartedAtById] = useState<
    Record<string, number>
  >({});
  const [streamErrorDismissals, setStreamErrorDismissals] =
    useState<StreamErrorDismissals>(() => new Map());
  const abortByThreadRef = useRef<Map<string, AbortController>>(new Map());
  /** Per-thread generation so stale channels can't patch UI after stop/resend. */
  const streamGenByThreadRef = useRef<Map<string, number>>(new Map());
  /** Live rAF batcher per thread — Stop flushes before abort so last-frame tokens survive. */
  const streamBatchByThreadRef = useRef<
    Map<string, { flush: () => void; dispose: () => void }>
  >(new Map());
  const saveWarnRef = useRef<string | null>(null);

  const [auth, setAuth] = useState<AuthStatus>({ signedIn: false });
  const [authKnown, setAuthKnown] = useState(false);
  const [authBusy, setAuthBusy] = useState(false);
  const [openaiAuth, setOpenAIAuth] = useState<OpenAIAuthStatus>({
    signedIn: false,
  });
  const [openaiAuthKnown, setOpenAIAuthKnown] = useState(false);
  const [openaiAuthBusy, setOpenAIAuthBusy] = useState(false);
  const [authModalProvider, setAuthModalProvider] = useState<
    "grok" | "openai" | null
  >(null);
  const [signInPickerOpen, setSignInPickerOpen] = useState(false);
  const [deviceCode, setDeviceCode] = useState<DeviceCodeEvent | null>(null);
  const [openaiDeviceCode, setOpenAIDeviceCode] =
    useState<DeviceCodeEvent | null>(null);
  const [authError, setAuthError] = useState<string | null>(null);
  const authReturnFocusRef = useRef<HTMLElement | null>(null);
  const captureAuthReturnFocus = () => {
    if (authReturnFocusRef.current?.isConnected) return;
    authReturnFocusRef.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
  };

  const [theme, setTheme] = useState<ThemeMode>(() => {
    const m = loadTheme();
    applyTheme(m);
    return m;
  });
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [usageOpen, setUsageOpen] = useState(false);
  const [providersOpen, setProvidersOpen] = useState(false);
  const [antigravityEnabled, setAntigravityEnabled] = useState(
    loadAntigravityEnabled,
  );
  const [antigravityStatus, setAntigravityStatus] =
    useState<AntigravityStatus>(EMPTY_ANTIGRAVITY_STATUS);
  const [antigravityChecking, setAntigravityChecking] = useState(false);
  const [antigravityError, setAntigravityError] = useState<string | null>(null);
  const antigravityRefreshRequestRef = useRef(0);
  const [openCodeEnabled, setOpenCodeEnabled] = useState(loadOpenCodeEnabled);
  const [openCodeHealthInterval, setOpenCodeHealthInterval] = useState(
    loadOpenCodeHealthInterval,
  );
  const [openCodeStatus, setOpenCodeStatus] = useState<OpenCodeStatus>(
    EMPTY_OPENCODE_STATUS,
  );
  const [openCodeChecking, setOpenCodeChecking] = useState(false);
  const [openCodeUpdating, setOpenCodeUpdating] = useState(false);
  const openCodeUpdatingRef = useRef(false);
  const openCodeUpdateTokenRef = useRef(0);
  const [openCodeError, setOpenCodeError] = useState<string | null>(null);
  const openCodeRefreshRequestRef = useRef(0);
  const openCodeStatusProjectPathRef = useRef<string | null>(null);
  const openCodeStatusByWorkspaceRef = useRef<
    Map<string, OpenCodeStatus>
  >(new Map());
  const openCodeCheckByWorkspaceRef = useRef<
    Map<string, Promise<OpenCodeStatus>>
  >(new Map());
  const openCodeWorkspaceCheckGenerationRef = useRef(0);
  const openCodeEnabledRef = useRef(openCodeEnabled);
  openCodeEnabledRef.current = openCodeEnabled;
  const [openCodeReadinessEpoch, setOpenCodeReadinessEpoch] = useState(0);
  const [dismissedOpenCodeVersion, setDismissedOpenCodeVersion] = useState<
    string | null
  >(null);
  /** Full-app vortex while bulk-archiving chats from Settings. */
  const [archivingAll, setArchivingAll] = useState(false);
  const [importingCodexChats, setImportingCodexChats] = useState(false);
  const [unimportingCodexChats, setUnimportingCodexChats] = useState(false);
  /** Chat-area fold animation while `/compact` rewrites the active thread. */
  const [compacting, setCompacting] = useState(false);
  const compactingRef = useRef(false);
  const [profileOpen, setProfileOpen] = useState(false);
  const [userProfile, setUserProfile] = useState<UserProfile | null>(null);
  const openSettings = useCallback(() => {
    if (profileOpen) return;
    if (providersOpen) return;
    if (usageOpen) return;
    setSettingsOpen(true);
  }, [profileOpen, providersOpen, usageOpen]);
  const openUsage = useCallback(() => {
    setSettingsOpen(false);
    setProvidersOpen(false);
    setProfileOpen(false);
    setUsageOpen(true);
  }, []);
  const closeUsage = useCallback(() => setUsageOpen(false), []);
  const openProviders = useCallback(() => {
    setSettingsOpen(false);
    setProfileOpen(false);
    setUsageOpen(false);
    setProvidersOpen(true);
  }, []);
  const openProfile = useCallback(() => {
    setSettingsOpen(false);
    setProvidersOpen(false);
    setUsageOpen(false);
    setProfileOpen(true);
  }, []);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [paletteView, setPaletteView] =
    useState<CommandPaletteView>("root");
  const [filePickerOpen, setFilePickerOpen] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [renameDraft, setRenameDraft] = useState("");
  const [sendQueue, setSendQueue] = useState<QueuedSend[]>([]);
  const [stashEntries, setStashEntries] = useState<StashEntry[]>(loadStash);
  const sendQueueRef = useRef(sendQueue);
  sendQueueRef.current = sendQueue;
  const notifyCompleteRef = useRef(notifyOnAgentComplete);
  notifyCompleteRef.current = notifyOnAgentComplete;
  const notifyErrorRef = useRef(notifyOnAgentError);
  notifyErrorRef.current = notifyOnAgentError;
  /** Thread ids that finished streaming and may have a queued follow-up. */
  const drainAfterRef = useRef<string[]>([]);
  /** Prefer this queued item on next drain (Send now). */
  const prioritySendByThreadRef = useRef<Map<string, QueuedSend>>(new Map());
  const streamingThreadIdsRef = useRef(streamingThreadIds);
  streamingThreadIdsRef.current = streamingThreadIds;

  const enqueueDrain = useCallback((threadId: string) => {
    const q = drainAfterRef.current;
    if (!q.includes(threadId)) q.push(threadId);
  }, []);

  /** Blocks overlapping send/drain on the same thread before markStreaming runs. */
  const sendingByThreadRef = useRef<Set<string>>(new Set());

  const markStreaming = useCallback((threadId: string, startedAt: number) => {
    setStreamingThreadIds((prev) =>
      prev.includes(threadId) ? prev : [...prev, threadId],
    );
    setStreamStartedAtById((prev) => ({ ...prev, [threadId]: startedAt }));
  }, []);

  const clearStreaming = useCallback((threadId: string) => {
    sendingByThreadRef.current.delete(threadId);
    setStreamingThreadIds((prev) => prev.filter((id) => id !== threadId));
    setStreamStartedAtById((prev) => {
      if (!(threadId in prev)) return prev;
      const next = { ...prev };
      delete next[threadId];
      return next;
    });
  }, []);

  useEffect(() => installZoomHotkeys(), []);
  useEffect(() => installNotificationSoundUnlock(), []);

  // Durable store: hydrate SQLite → memory, then re-sync React state.
  // Prevents empty/default chats overwriting real history on first paint.
  const storeReadyRef = useRef(!isTauri());
  const [storeReady, setStoreReady] = useState(() => !isTauri());
  const [bootRevealStarted, setBootRevealStarted] = useState(false);
  const handleBootExitStart = useCallback(() => setBootRevealStarted(true), []);
  /** Bumped after hydrated state is applied; next effect opens the save gate. */
  const [hydrateEpoch, setHydrateEpoch] = useState(0);
  useEffect(() => {
    let cancelled = false;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let retryDelayMs = 100;

    const hydrate = async (): Promise<void> => {
      try {
        await hydrateStore();
      } catch {
        if (cancelled) return;
        retryTimer = setTimeout(() => {
          retryTimer = null;
          void hydrate();
        }, retryDelayMs);
        retryDelayMs = Math.min(retryDelayMs * 2, 2_000);
        return;
      }
      if (cancelled) return;
      const nextProjects = loadProjects();
      let nextThreads = loadThreads();
      // Ensure at least one live (non-archived) thread after hydrate.
      if (liveThreads(nextThreads).length === 0) {
        nextThreads = [createThread(null), ...nextThreads];
      }
      const nextPrefs = loadPrefs();
      const nextActive = loadActiveId(
        nextThreads,
        liveThreads(nextThreads)[0]?.id ?? null,
      );
      // Apply hydrated state first; save gate opens only after this render commits.
      setProjects(nextProjects);
      setThreads(nextThreads);
      setActiveId(nextActive);
      const selectedThread = nextThreads.find(
        (thread) => thread.id === nextActive,
      );
      const selectedModelId =
        threadModelId(selectedThread) ?? nextPrefs.modelId;
      setModelId(selectedModelId);
      setThinking(thinkingForModel(selectedModelId, nextPrefs.thinking));
      setOpenAIFastMode(nextPrefs.openaiFastMode);
      setAccessMode(nextPrefs.accessMode);
      setPermissionMode(nextPrefs.permissionMode);
      setAgentMode(nextPrefs.agentMode);
      setSidebarOpen(nextPrefs.sidebarOpen);
      setCollapseThinking(nextPrefs.collapseThinking);
      setNotifyOnAgentComplete(nextPrefs.notifyOnAgentComplete);
      setNotifyOnAgentError(nextPrefs.notifyOnAgentError);
      setActiveProjectId(
        nextPrefs.activeProjectId &&
          nextProjects.some((p) => p.id === nextPrefs.activeProjectId)
          ? nextPrefs.activeProjectId
          : null,
      );
      setHydrateEpoch((n) => n + 1);
    };

    void hydrate();
    return () => {
      cancelled = true;
      if (retryTimer != null) clearTimeout(retryTimer);
    };
  }, []);

  useEffect(() => {
    if (hydrateEpoch === 0) return;
    storeReadyRef.current = true;
    setStoreReady(true);
  }, [hydrateEpoch]);

  useEffect(() => {
    const media = window.matchMedia("(max-width: 640px)");
    const syncViewport = () => {
      setIsNarrowViewport(media.matches);
      if (media.matches) setMobileSidebarOpen(false);
    };
    syncViewport();
    media.addEventListener("change", syncViewport);
    return () => media.removeEventListener("change", syncViewport);
  }, []);

  const materializeThreadsForPersistence = useCallback(() => {
    for (const batch of streamBatchByThreadRef.current.values()) batch.flush();
    return setThreads(
      materializeStreamOverlays(
        threadsRef.current,
        streamOverlay.getSnapshot(),
      ),
      { immediate: true },
    );
  }, [setThreads, streamOverlay]);

  const handleThreadsSaveResult = useCallback(
    (result: SaveResult) => {
      if (result === "ok") {
        saveWarnRef.current = null;
        return;
      }
      if (saveWarnRef.current === result) return;
      saveWarnRef.current = result;
      if (result === "stripped") {
        toast.info("Saved chats without large images (storage limit)");
      } else {
        toast.error(
          "Could not save chats. Keep the app open, free disk space, and try again.",
        );
      }
    },
    [toast],
  );

  useEffect(
    () => subscribeThreadsSaveResults(handleThreadsSaveResult),
    [handleThreadsSaveResult],
  );

  // Flush pending chat writes when app hides / closes (incl. Tauri window X).
  useEffect(() => {
    const onHide = () => {
      // Snapshot latest React state into the debounced writer, then flush.
      if (storeReadyRef.current) {
        saveThreads(materializeThreadsForPersistence(), { immediate: true });
      }
      void flushStore();
    };
    const onVis = () => {
      if (document.visibilityState === "hidden") onHide();
    };
    window.addEventListener("pagehide", onHide);
    window.addEventListener("beforeunload", onHide);
    document.addEventListener("visibilitychange", onVis);

    const closeCleanup = createAsyncCleanupGuard();
    if (isTauri()) {
      void (async () => {
        try {
          const { getCurrentWindow } = await import("@tauri-apps/api/window");
          const win = getCurrentWindow();
          const unlistenClose = await win.onCloseRequested(async (event) => {
            event.preventDefault();
            if (storeReadyRef.current) {
              saveThreads(materializeThreadsForPersistence(), {
                immediate: true,
              });
            }
            const saveResult = await flushStore();
            if (saveResult === "failed") return;
            await win.destroy();
          });
          closeCleanup.add(unlistenClose);
        } catch {
          /* missing permission / non-desktop */
        }
      })();
    }

    return () => {
      window.removeEventListener("pagehide", onHide);
      window.removeEventListener("beforeunload", onHide);
      document.removeEventListener("visibilitychange", onVis);
      closeCleanup.dispose();
      void flushStore();
    };
  }, [materializeThreadsForPersistence]);

  // Re-register saved project and worktree roots with the Rust allowlist on launch.
  useEffect(() => {
    if (!isTauri() || !storeReady) return;
    const paths = new Set<string>();
    for (const p of loadProjects()) paths.add(p.path);
    for (const t of loadThreads()) {
      if (t.worktreePath) paths.add(t.worktreePath);
    }
    for (const path of paths) {
      void registerProjectRoot(path).catch(() => {
        /* path may be gone */
      });
    }
  }, [storeReady]);

  useEffect(() => {
    if (!storeReadyRef.current) return;
    saveProjects(projects);
  }, [projects]);

  // After stream settles or structural chat edits, push SQLite promptly
  // so a hard kill still keeps history (debounce alone is 280ms).
  const persistThreadsNow = useCallback(() => {
    if (!storeReadyRef.current) return;
    saveThreads(threadsRef.current, { immediate: true });
    void flushStore();
  }, []);

  useEffect(() => {
    if (!storeReady || !storeReadyRef.current) return;
    saveThreads(threads);
  }, [threads, storeReady]);

  useEffect(() => {
    if (!storeReadyRef.current) return;
    savePrefs({
      modelId,
      thinking,
      openaiFastMode,
      accessMode,
      permissionMode,
      agentMode,
      sidebarOpen,
      activeProjectId,
      collapseThinking,
      keybindings: [...keybindings],
      notifyOnAgentComplete,
      notifyOnAgentError,
    });
  }, [
    modelId,
    thinking,
    openaiFastMode,
    accessMode,
    permissionMode,
    agentMode,
    sidebarOpen,
    activeProjectId,
    collapseThinking,
    keybindings,
    notifyOnAgentComplete,
    notifyOnAgentError,
  ]);

  useEffect(() => {
    if (!storeReadyRef.current) return;
    saveActiveId(activeId);
  }, [activeId]);

  useEffect(() => {
    applyTheme(theme);
    saveTheme(theme);
  }, [theme]);

  useEffect(() => {
    if (theme !== "system") return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => applyTheme("system");
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [theme]);

  useEffect(() => {
    void getAuthStatus()
      .then((status) => {
        setAuth(status);
        setAuthKnown(true);
      })
      .catch(() => {
        setAuth({ signedIn: false });
        setAuthKnown(true);
      });
    void getOpenAIAuthStatus()
      .then((status) => {
        setOpenAIAuth(status);
        setOpenAIAuthKnown(true);
      })
      .catch(() => {
        setOpenAIAuth({ signedIn: false });
        setOpenAIAuthKnown(true);
      });
    void getProfile()
      .then(setUserProfile)
      .catch(() => setUserProfile(null));
    let cancelled = false;
    const unsubs: Array<() => void> = [];
    void onDeviceCode((e) => {
      captureAuthReturnFocus();
      setDeviceCode(e);
      setAuthModalProvider("grok");
    }).then((u) => {
      if (cancelled) u();
      else unsubs.push(u);
    });
    void onAuthStatus((s) => {
      setAuth(s);
      setAuthKnown(true);
    }).then((u) => {
      if (cancelled) u();
      else unsubs.push(u);
    });
    void onOpenAIDeviceCode((e) => {
      captureAuthReturnFocus();
      setOpenAIDeviceCode(e);
      setAuthModalProvider("openai");
    }).then((u) => {
      if (cancelled) u();
      else unsubs.push(u);
    });
    void onOpenAIAuthStatus((s) => {
      setOpenAIAuth(s);
      setOpenAIAuthKnown(true);
    }).then((u) => {
      if (cancelled) u();
      else unsubs.push(u);
    });
    return () => {
      cancelled = true;
      unsubs.forEach((u) => u());
    };
  }, []);

  const active = useMemo(
    () => threads.find((c) => c.id === activeId) ?? null,
    [threads, activeId],
  );
  const activeLockedProvider = lockedProviderForThread(active);
  const activeProject = useMemo(
    () =>
      projects.find((p) => p.id === (active?.projectId ?? activeProjectId)) ??
      null,
    [projects, active, activeProjectId],
  );
  const activeWorkspacePath = useMemo(
    () => resolveWorkspacePath(activeProject?.path, active?.worktreePath),
    [activeProject?.path, active?.worktreePath],
  );
  const providerAvailability = useMemo<ProviderAvailability>(
    () => ({
      grok: authKnown && auth.signedIn,
      openai: openaiAuthKnown && openaiAuth.signedIn,
      antigravity:
        antigravityEnabled &&
        antigravityStatus.checkedAt > 0 &&
        antigravityStatus.ready,
      opencode:
        !openCodeUpdatingRef.current &&
        activeWorkspacePath !== null &&
        isOpenCodeReadyForWorkspace(
          openCodeEnabled,
          openCodeStatusByWorkspaceRef.current.get(activeWorkspacePath) ??
            EMPTY_OPENCODE_STATUS,
          activeWorkspacePath,
          activeWorkspacePath,
        ),
    }),
    [
      auth.signedIn,
      authKnown,
      antigravityEnabled,
      antigravityStatus.checkedAt,
      antigravityStatus.ready,
      openaiAuth.signedIn,
      openaiAuthKnown,
      openCodeEnabled,
      activeWorkspacePath,
      openCodeReadinessEpoch,
    ],
  );
  const modelSelectionAvailability = useMemo<ProviderAvailability>(
    () => ({
      ...providerAvailability,
      antigravity: antigravityEnabled,
      opencode: openCodeEnabled,
    }),
    [antigravityEnabled, openCodeEnabled, providerAvailability],
  );
  useEffect(() => {
    if (!authKnown || !openaiAuthKnown) return;
    if (activeLockedProvider) return;
    const nextModelId = reconcileAvailableModelId(
      modelId,
      modelSelectionAvailability,
    );
    if (!nextModelId || nextModelId === modelId) return;
    setModelId(nextModelId);
    setThinking((current) => thinkingForModel(nextModelId, current));
    if (activeId) {
      setThreads((previous) =>
        previous.map((thread) =>
          thread.id === activeId && thread.messages.length === 0
            ? { ...thread, modelId: nextModelId }
            : thread,
        ),
      );
    }
  }, [
    activeId,
    activeLockedProvider,
    authKnown,
    modelId,
    openaiAuthKnown,
    modelSelectionAvailability,
    setThreads,
  ]);
  const activeModelProvider = providerOf(modelId);
  const activeProviderSignedIn =
    activeModelProvider === "opencode"
      ? !openCodeUpdatingRef.current &&
        isOpenCodeReadyForWorkspace(
          openCodeEnabled,
          activeWorkspacePath === null
            ? EMPTY_OPENCODE_STATUS
            : (openCodeStatusByWorkspaceRef.current.get(activeWorkspacePath) ??
                EMPTY_OPENCODE_STATUS),
          activeWorkspacePath,
          activeWorkspacePath,
          modelId,
        )
      : providerAvailability[activeModelProvider];

  const activeStreamOverlay =
    activeId != null ? streamOverlayMap.get(activeId) : undefined;

  /** Messages for the open chat (durable thread + live stream overlay). */
  const activeMessages = useMemo(
    () => applyStreamOverlay(active?.messages ?? [], activeStreamOverlay),
    [active?.messages, activeStreamOverlay],
  );
  const activeReviewComments = useMemo(
    () =>
      activeId
        ? reviewComments.filter((comment) => comment.threadId === activeId)
        : [],
    [activeId, reviewComments],
  );

  const checkOpenCodeWorkspace = useCallback(
    (workspacePath: string): Promise<OpenCodeStatus> => {
      if (openCodeUpdatingRef.current) {
        return Promise.reject(new Error("OpenCode is updating."));
      }
      const pending = openCodeCheckByWorkspaceRef.current.get(workspacePath);
      if (pending) return pending;
      const generation = openCodeWorkspaceCheckGenerationRef.current;
      const request = getOpenCodeStatus(workspacePath)
        .then((status) => {
          if (
            generation !== openCodeWorkspaceCheckGenerationRef.current ||
            !openCodeEnabledRef.current
          ) {
            return status;
          }
          openCodeStatusByWorkspaceRef.current.set(workspacePath, status);
          setOpenCodeReadinessEpoch((current) => current + 1);
          return status;
        })
        .catch((error) => {
          if (
            generation !== openCodeWorkspaceCheckGenerationRef.current ||
            !openCodeEnabledRef.current
          ) {
            throw error;
          }
          const current = openCodeStatusByWorkspaceRef.current.get(workspacePath);
          openCodeStatusByWorkspaceRef.current.set(workspacePath, {
            ...(current ?? EMPTY_OPENCODE_STATUS),
            ready: false,
          });
          setOpenCodeReadinessEpoch((value) => value + 1);
          throw error;
        })
        .finally(() => {
          if (openCodeCheckByWorkspaceRef.current.get(workspacePath) === request) {
            openCodeCheckByWorkspaceRef.current.delete(workspacePath);
          }
        });
      openCodeCheckByWorkspaceRef.current.set(workspacePath, request);
      return request;
    },
    [],
  );

  const sendTargetAvailability = useCallback(
    (target: NonNullable<ReturnType<typeof resolveSendTarget>>): boolean => {
      if (target.provider === "opencode" && openCodeUpdatingRef.current) {
        return false;
      }
      if (target.provider !== "opencode") {
        return providerAvailability[target.provider];
      }
      const project = findSendTargetProject(projectsRef.current, target);
      const workspacePath = resolveWorkspacePath(
        project?.path,
        target.existing?.worktreePath,
      );
      return (
        workspacePath !== null &&
        isOpenCodeReadyForWorkspace(
          openCodeEnabled,
          openCodeStatusByWorkspaceRef.current.get(workspacePath) ??
            EMPTY_OPENCODE_STATUS,
          workspacePath,
          workspacePath,
          target.modelId,
        )
      );
    },
    [openCodeEnabled, providerAvailability],
  );

  const refreshQueuedOpenCodeWorkspaces = useCallback(() => {
    if (!openCodeEnabled || openCodeUpdatingRef.current) return;
    const workspaces = new Set<string>();
    for (const threadId of drainAfterRef.current) {
      const target = resolveSendTarget(
        threadsRef.current,
        threadId,
        activeProjectId,
        modelId,
      );
      if (!target || target.provider !== "opencode") continue;
      const project = findSendTargetProject(projectsRef.current, target);
      const workspacePath = resolveWorkspacePath(
        project?.path,
        target.existing?.worktreePath,
      );
      if (workspacePath) workspaces.add(workspacePath);
    }
    for (const workspacePath of workspaces) {
      void checkOpenCodeWorkspace(workspacePath).catch(() => undefined);
    }
  }, [activeProjectId, checkOpenCodeWorkspace, modelId, openCodeEnabled]);

  const refreshOpenCode = useCallback(async () => {
    if (openCodeUpdatingRef.current) return;
    const requestId = ++openCodeRefreshRequestRef.current;
    const projectPath = activeWorkspacePath;
    if (!openCodeEnabled) {
      openCodeWorkspaceCheckGenerationRef.current += 1;
      configureOpenCodeModels([]);
      openCodeStatusProjectPathRef.current = null;
      openCodeStatusByWorkspaceRef.current.clear();
      openCodeCheckByWorkspaceRef.current.clear();
      setOpenCodeReadinessEpoch((current) => current + 1);
      setOpenCodeStatus(EMPTY_OPENCODE_STATUS);
      setOpenCodeError(null);
      setOpenCodeChecking(false);
      return;
    }
    setOpenCodeChecking(true);
    setOpenCodeError(null);
    try {
      const status = projectPath
        ? await checkOpenCodeWorkspace(projectPath)
        : await getOpenCodeStatus(null);
      if (requestId !== openCodeRefreshRequestRef.current) return;
      if (status.ready) {
        configureOpenCodeModels(openCodeModelsForCatalog(status.models));
      }
      openCodeStatusProjectPathRef.current = projectPath;
      setOpenCodeStatus(status);
    } catch (error) {
      if (requestId !== openCodeRefreshRequestRef.current) return;
      openCodeStatusProjectPathRef.current = projectPath;
      setOpenCodeStatus((current) => ({ ...current, ready: false }));
      setOpenCodeError(
        error instanceof Error
          ? error.message
          : "Could not check OpenCode provider status.",
      );
    } finally {
      if (requestId === openCodeRefreshRequestRef.current) {
        setOpenCodeChecking(false);
      }
    }
  }, [activeWorkspacePath, checkOpenCodeWorkspace, openCodeEnabled]);

  const refreshAntigravity = useCallback(async () => {
    const requestId = ++antigravityRefreshRequestRef.current;
    if (!antigravityEnabled) {
      configureAntigravityModels([]);
      setAntigravityStatus(EMPTY_ANTIGRAVITY_STATUS);
      setAntigravityError(null);
      setAntigravityChecking(false);
      return;
    }
    setAntigravityChecking(true);
    setAntigravityError(null);
    try {
      const status = await getAntigravityStatus();
      if (requestId !== antigravityRefreshRequestRef.current) return;
      if (status.ready) {
        configureAntigravityModels(antigravityModelsForCatalog(status.models));
      }
      setAntigravityStatus(status);
    } catch (error) {
      if (requestId !== antigravityRefreshRequestRef.current) return;
      setAntigravityStatus((current) => ({ ...current, ready: false }));
      setAntigravityError(
        error instanceof Error
          ? error.message
          : "Could not check Antigravity provider status.",
      );
    } finally {
      if (requestId === antigravityRefreshRequestRef.current) {
        setAntigravityChecking(false);
      }
    }
  }, [antigravityEnabled]);

  useEffect(() => {
    if (openCodeUpdating) return;
    void refreshOpenCode();
    void refreshAntigravity();
    refreshQueuedOpenCodeWorkspaces();
  }, [
    openCodeUpdating,
    refreshAntigravity,
    refreshOpenCode,
    refreshQueuedOpenCodeWorkspaces,
  ]);

  useEffect(() => {
    if (openCodeHealthInterval === 0) return;
    const id = window.setInterval(
      () => {
        void refreshOpenCode();
        void refreshAntigravity();
        refreshQueuedOpenCodeWorkspaces();
      },
      openCodeHealthInterval * 1_000,
    );
    return () => window.clearInterval(id);
  }, [
    openCodeHealthInterval,
    refreshAntigravity,
    refreshOpenCode,
    refreshQueuedOpenCodeWorkspaces,
  ]);

  const handleAntigravityEnabledChange = useCallback(
    (enabled: boolean) => {
      antigravityRefreshRequestRef.current += 1;
      saveAntigravityEnabled(enabled);
      setAntigravityEnabled(enabled);
      if (!enabled) configureAntigravityModels([]);
      else if (antigravityStatus.ready) {
        configureAntigravityModels(
          antigravityModelsForCatalog(antigravityStatus.models),
        );
      }
    },
    [antigravityStatus],
  );

  const handleOpenCodeEnabledChange = useCallback(
    (enabled: boolean) => {
      openCodeRefreshRequestRef.current += 1;
      openCodeWorkspaceCheckGenerationRef.current += 1;
      openCodeCheckByWorkspaceRef.current.clear();
      saveOpenCodeEnabled(enabled);
      setOpenCodeEnabled(enabled);
      if (!enabled) {
        configureOpenCodeModels([]);
        openCodeStatusProjectPathRef.current = null;
        openCodeStatusByWorkspaceRef.current.clear();
        setOpenCodeReadinessEpoch((current) => current + 1);
      }
      else if (openCodeStatus.ready) {
        configureOpenCodeModels(openCodeModelsForCatalog(openCodeStatus.models));
      }
    },
    [openCodeStatus],
  );

  const handleOpenCodeHealthIntervalChange = useCallback((seconds: number) => {
    saveOpenCodeHealthInterval(seconds);
    setOpenCodeHealthInterval(seconds);
  }, []);

  const handleOpenCodeUpdate = useCallback(async () => {
    if (openCodeUpdatingRef.current) return;
    openCodeUpdatingRef.current = true;
    const updateToken = ++openCodeUpdateTokenRef.current;
    const requestId = ++openCodeRefreshRequestRef.current;
    const projectPath = activeWorkspacePath;
    openCodeWorkspaceCheckGenerationRef.current += 1;
    openCodeCheckByWorkspaceRef.current.clear();
    openCodeStatusByWorkspaceRef.current.clear();
    setOpenCodeReadinessEpoch((current) => current + 1);
    setOpenCodeUpdating(true);
    setOpenCodeError(null);
    try {
      const result = await updateOpenCode(projectPath);
      if (requestId !== openCodeRefreshRequestRef.current) return;
      if (openCodeEnabled && result.status.ready) {
        configureOpenCodeModels(openCodeModelsForCatalog(result.status.models));
      }
      if (projectPath) {
        openCodeStatusByWorkspaceRef.current.set(projectPath, result.status);
        setOpenCodeReadinessEpoch((current) => current + 1);
      }
      openCodeStatusProjectPathRef.current = projectPath;
      setOpenCodeStatus(result.status);
      setDismissedOpenCodeVersion(null);
      toast.success(
        result.status.version
          ? `OpenCode updated to ${result.status.version}`
          : "OpenCode updated",
      );
    } catch (error) {
      if (requestId !== openCodeRefreshRequestRef.current) return;
      const message =
        error instanceof Error ? error.message : String(error);
      setOpenCodeError(message);
      toast.error(message || "OpenCode update failed.");
    } finally {
      if (updateToken === openCodeUpdateTokenRef.current) {
        openCodeUpdatingRef.current = false;
        setOpenCodeUpdating(false);
      }
    }
  }, [activeWorkspacePath, openCodeEnabled, toast]);

  /** Agent tools + git operate on the thread worktree when present. */
  const activeWorkspacePathRef = useRef(activeWorkspacePath);
  activeWorkspacePathRef.current = activeWorkspacePath;
  const activeGitStatus = workspaceValueForPath(
    gitStatus,
    gitStatusPath,
    activeWorkspacePath,
  );
  const activeGitDiff = workspaceValueForPath(
    gitDiff,
    gitDiffPath,
    activeWorkspacePath,
  );
  const activeGitRefs =
    activeWorkspacePath && gitRefsPath === activeWorkspacePath ? gitRefs : [];
  const activeWorktreeBaseRef = resolveWorktreeBaseRef(
    activeGitRefs,
    activeProject ? worktreeBaseRefByProject[activeProject.id] : null,
  );

  useEffect(() => {
    setGitPrUrl(null);
  }, [activeId, activeWorkspacePath, activeGitStatus?.branch]);

  const activeStreaming =
    activeId != null && streamingThreadIds.includes(activeId);
  const visibleActiveStreamError = activeStreaming
    ? null
    : visibleStreamError(
        streamErrorDismissals,
        activeId,
        active?.lastError ?? null,
      );
  const activeSettled =
    active != null &&
    effectiveSettled(active, {
      nowMs: Date.now(),
      autoSettleAfterDays: DEFAULT_AUTO_SETTLE_AFTER_DAYS,
      working: activeStreaming,
    });
  const activeStreamStartedAt =
    activeId != null ? (streamStartedAtById[activeId] ?? null) : null;

  // Match draft-hero gate: hide hero once this thread is working OR has messages
  const isEmpty = activeMessages.length === 0 && !activeStreaming;

  const usage = useMemo(
    () => contextUsage(activeMessages, modelId, draft, attachments.length),
    [activeMessages, modelId, draft, attachments.length],
  );

  // Only project file changes while the active turn is streaming.
  const liveFileChanges = useMemo(
    () => (activeStreaming ? projectLiveFileChanges(activeMessages) : null),
    [activeStreaming, activeMessages],
  );

  // Review panel: turn/session from chat tools; git scope from working tree.
  // Skip full diff parse while the panel is closed (composer uses lighter projection).
  const chatReviewFiles = useMemo(() => {
    if (!reviewOpen) return [];
    return collectReviewFileChanges(
      activeMessages,
      reviewScope === "git" ? "turn" : reviewScope,
    );
  }, [activeMessages, reviewScope, reviewOpen]);

  const gitReviewFiles = useMemo(
    () => gitDiffToReviewFiles(activeGitDiff),
    [activeGitDiff],
  );

  const reviewFiles = useMemo(
    () => (reviewScope === "git" ? gitReviewFiles : chatReviewFiles),
    [reviewScope, gitReviewFiles, chatReviewFiles],
  );

  const handleAddReviewComment = useCallback(
    (
      file: ReviewFileChange,
      selection: ReviewCommentSelection,
      body: string,
    ) => {
      if (!activeId) return;
      const messageIndex = activeMessages.findIndex(
        (message) => message.id === file.messageId,
      );
      const through =
        messageIndex >= 0
          ? activeMessages.slice(0, messageIndex + 1)
          : activeMessages;
      const turnNumber = Math.max(
        1,
        through.filter((message) => message.role === "user").length,
      );
      const comment: ReviewComment = {
        ...selection,
        id: createId(),
        threadId: activeId,
        sectionId:
          reviewScope === "git"
            ? `turn:${activeId}`
            : `turn:${file.messageId}`,
        sectionTitle:
          reviewScope === "git" ? "Working tree" : `Turn ${turnNumber}`,
        body,
      };
      setReviewComments((current) => [...current, comment]);
      window.requestAnimationFrame(() => {
        document.querySelector<HTMLTextAreaElement>("textarea.composer__input")?.focus();
      });
    },
    [activeId, activeMessages, reviewScope],
  );

  const pendingApprovals = useMemo(
    () => collectPendingApprovals(activeMessages),
    [activeMessages],
  );
  const attentionByThreadId = useMemo(
    () =>
      resolveThreadAttentionById(
        threads,
        streamOverlay.getSnapshot(),
        pendingUserInputByThread,
      ),
    [approvalAttentionEpoch, pendingUserInputByThread, streamOverlay, threads],
  );
  const attentionByThreadIdRef = useRef(attentionByThreadId);
  attentionByThreadIdRef.current = attentionByThreadId;
  const pendingUserInput = activeId
    ? (pendingUserInputByThread[activeId] ?? null)
    : null;

  useEffect(() => {
    if (attentionByThreadId.size === 0) return;
    const now = Date.now();
    let changed = false;
    setThreads(
      (current) => {
        const next = current.map((thread) => {
          if (!attentionByThreadId.has(thread.id)) return thread;
          const woke = wakeThreadForAttention(thread, now);
          if (woke === thread) return thread;
          changed = true;
          return woke;
        });
        return changed ? next : current;
      },
      { immediate: true },
    );
    if (changed) persistThreadsNow();
  }, [attentionByThreadId, persistThreadsNow, setThreads]);

  // Whether Review undo is available for the current turn/session scope.
  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      if (
        !reviewOpen ||
        activeStreaming ||
        !activeId ||
        reviewScope === "git"
      ) {
        if (!cancelled) setCanUndoReview(false);
        return;
      }
      const candidates =
        reviewScope === "session"
          ? mutationToolIdsForUndo(activeMessages, "session")
          : toolIdsFromReviewFiles(chatReviewFiles).length > 0
            ? toolIdsFromReviewFiles(chatReviewFiles)
            : mutationToolIdsForUndo(activeMessages, "turn");
      if (candidates.length === 0) {
        if (!cancelled) setCanUndoReview(false);
        return;
      }
      const snaps = await listSnapshots(activeId);
      if (cancelled) return;
      const usable = filterToolIdsWithSnapshots(candidates, snaps);
      setCanUndoReview(usable.length > 0);
    };
    void run();
    return () => {
      cancelled = true;
    };
  }, [
    activeId,
    activeMessages,
    chatReviewFiles,
    reviewOpen,
    reviewScope,
    snapshotEpoch,
    activeStreaming,
  ]);

  // Pill after stream finishes: prefer live tool edits, else turn summary
  // (header-accurate +N/-N), then working-tree stats when idle.
  const composerFileChanges = useMemo(() => {
    if (liveFileChanges) return liveFileChanges;
    // Prefer header-accurate live projection even after stream settles so the
    // pill matches tool result "+417 -127" rather than truncated body counts.
    const projected = projectLiveFileChanges(activeMessages);
    if (projected) return projected;
    const turnFiles = collectReviewFileChanges(activeMessages, "turn");
    if (turnFiles.length > 0) {
      let a = 0;
      let d = 0;
      for (const f of turnFiles) {
        a += f.additions;
        d += f.deletions;
      }
      return { fileCount: turnFiles.length, additions: a, deletions: d };
    }
    return summarizeGitStatus(activeGitStatus);
  }, [liveFileChanges, activeMessages, activeGitStatus]);

  const rightPanelOpen = reviewOpen || previewOpen || filesOpen;

  const closeRightPanel = useCallback(() => {
    setReviewOpen(false);
    setPreviewOpen(false);
    setFilesOpen(false);
  }, []);

  const openRightPanelPage = useCallback(
    (page: RightPanelPage, opts?: { reviewScope?: ReviewScope }) => {
      setReviewOpen(page === "review");
      setPreviewOpen(page === "browser");
      setFilesOpen(page === "files");
      setRightPanelPage(page);
      if (page === "review" && opts?.reviewScope)
        setReviewScope(opts.reviewScope);
    },
    [],
  );

  const toggleRightPanel = useCallback(() => {
    if (rightPanelOpen) {
      closeRightPanel();
      return;
    }
    // Prefer the last open page; Review is the default.
    if (rightPanelPage === "browser") {
      openRightPanelPage("browser");
    } else if (rightPanelPage === "files") {
      openRightPanelPage("files");
    } else {
      openRightPanelPage("review");
    }
  }, [
    rightPanelOpen,
    closeRightPanel,
    rightPanelPage,
    openRightPanelPage,
  ]);

  const closeReviewChanges = closeRightPanel;
  const closeBrowserPreview = closeRightPanel;
  const closeFilePreview = closeRightPanel;

  const openReviewPanel = useCallback(
    (scope: ReviewScope = "turn") => {
      openRightPanelPage("review", { reviewScope: scope });
    },
    [openRightPanelPage],
  );

  const handleRightPanelPageChange = useCallback(
    (page: RightPanelPage) => {
      openRightPanelPage(page);
    },
    [openRightPanelPage],
  );

  const rightPanelBadge = useMemo(() => {
    if (rightPanelOpen) return null;
    if (composerFileChanges && composerFileChanges.fileCount > 0) {
      return String(composerFileChanges.fileCount);
    }
    return null;
  }, [rightPanelOpen, composerFileChanges]);

  const refreshGit = useCallback(
    async (opts?: { includeDiff?: boolean }) => {
      const path = activeWorkspacePath;
      if (!path || !isTauri()) {
        setGitStatus(null);
        setGitStatusPath(null);
        setGitDiff(null);
        setGitDiffPath(null);
        setGitLoading(false);
        return;
      }
      const seq = ++gitReqSeqRef.current;
      setGitLoading(true);
      try {
        const wantDiff =
          opts?.includeDiff === true || (reviewOpen && reviewScope === "git");
        if (wantDiff) {
          const [status, diff] = await Promise.all([
            fetchGitStatus(path),
            fetchGitDiff(path),
          ]);
          if (
            seq !== gitReqSeqRef.current ||
            activeWorkspacePathRef.current !== path
          )
            return;
          setGitStatus(status);
          setGitStatusPath(path);
          setGitDiff(diff);
          setGitDiffPath(path);
        } else {
          const status = await fetchGitStatus(path);
          if (
            seq !== gitReqSeqRef.current ||
            activeWorkspacePathRef.current !== path
          )
            return;
          setGitStatus(status);
          setGitStatusPath(path);
        }
      } catch (e) {
        if (
          seq !== gitReqSeqRef.current ||
          activeWorkspacePathRef.current !== path
        )
          return;
        const msg = safeErrorMessage(
          e,
          "Git information is unavailable for this project.",
        );
        setGitStatus({
          isRepo: false,
          root: null,
          branch: null,
          upstream: null,
          isDefaultBranch: false,
          hasPrimaryRemote: false,
          hasUpstream: false,
          aheadCount: 0,
          behindCount: 0,
          hasWorkingTreeChanges: false,
          workingTree: { files: [], insertions: 0, deletions: 0 },
          detached: false,
          error: msg,
        });
        setGitStatusPath(path);
        setGitDiff(null);
        setGitDiffPath(null);
      } finally {
        if (
          seq === gitReqSeqRef.current &&
          activeWorkspacePathRef.current === path
        ) {
          setGitLoading(false);
        }
      }
    },
    [activeWorkspacePath, reviewOpen, reviewScope],
  );

  const loadGitRefs = useCallback(async (path: string): Promise<GitRef[]> => {
    if (!isTauri() || !path.trim()) return [];
    const seq = ++gitRefsReqSeqRef.current;
    setGitRefsLoading(true);
    try {
      const refs = await fetchGitRefs(path);
      if (seq === gitRefsReqSeqRef.current) {
        setGitRefs(refs);
        setGitRefsPath(path);
      }
      return refs;
    } finally {
      if (seq === gitRefsReqSeqRef.current) setGitRefsLoading(false);
    }
  }, []);

  const requestActiveGitRefs = useCallback(() => {
    const path = activeWorkspacePath;
    if (!path) return;
    void loadGitRefs(path).catch((error) => {
      toast.error(safeErrorMessage(error, "Could not load Git refs."));
    });
  }, [activeWorkspacePath, loadGitRefs, toast]);

  const handleSelectWorktreeBaseRef = useCallback(
    (name: string) => {
      const projectId = activeProject?.id;
      if (!projectId) return;
      setWorktreeBaseRefByProject((current) => ({
        ...current,
        [projectId]: name,
      }));
    },
    [activeProject?.id],
  );

  const scheduleGitRefresh = useCallback(
    (opts?: { includeDiff?: boolean; delayMs?: number }) => {
      if (gitRefreshTimerRef.current !== null) {
        window.clearTimeout(gitRefreshTimerRef.current);
      }
      const delay = opts?.delayMs ?? 280;
      gitRefreshTimerRef.current = window.setTimeout(() => {
        gitRefreshTimerRef.current = null;
        void refreshGit({ includeDiff: opts?.includeDiff });
      }, delay);
    },
    [refreshGit],
  );

  const handleGitCommit = useCallback(
    async (message: string): Promise<boolean> => {
      const path = activeWorkspacePath;
      if (!path) return false;
      setGitBusy(true);
      try {
        const result = await gitCommit(path, message);
        if (result.skippedNoChanges) {
          toast.info("Nothing to commit");
        } else if (result.committed) {
          const short = result.commitSha?.slice(0, 7) ?? "";
          toast.success(
            short
              ? `Committed ${short}${result.subject ? ` · ${result.subject}` : ""}`
              : "Committed",
          );
        }
        if (activeWorkspacePathRef.current === path) {
          await refreshGit({ includeDiff: true });
        }
        return result.committed;
      } catch (e) {
        toast.error(safeErrorMessage(e, "Could not create the commit."));
        return false;
      } finally {
        setGitBusy(false);
      }
    },
    [activeWorkspacePath, refreshGit, toast],
  );

  const handleGitPush = useCallback(async () => {
    const path = activeWorkspacePath;
    if (!path) return;
    setGitBusy(true);
    try {
      const result = await gitPush(path, !activeGitStatus?.hasUpstream);
      toast.success(
        result.setUpstream
          ? `Pushed ${result.branch ?? ""} (upstream set)`.trim()
          : `Pushed ${result.branch ?? ""}`.trim(),
      );
      if (activeWorkspacePathRef.current === path) {
        await refreshGit({ includeDiff: true });
      }
    } catch (e) {
      toast.error(safeErrorMessage(e, "Could not push this branch."));
    } finally {
      setGitBusy(false);
    }
  }, [activeWorkspacePath, activeGitStatus?.hasUpstream, refreshGit, toast]);

  const handleGitOpenPr = useCallback(async () => {
    const path = activeWorkspacePath;
    const branch = activeGitStatus?.branch;
    const canOpen = Boolean(
      path &&
      activeGitStatus?.isRepo &&
      branch &&
      !activeGitStatus.detached &&
      !activeGitStatus.isDefaultBranch &&
      activeGitStatus.hasPrimaryRemote &&
      activeGitStatus.hasUpstream &&
      activeGitStatus.aheadCount === 0,
    );
    if (!path || !branch || !canOpen) return;
    if (
      !(await requestConfirmDialog(
        `Open or create a pull request for pushed branch “${branch}”?`,
      ))
    ) {
      return;
    }
    if (activeWorkspacePathRef.current !== path) return;

    setGitBusy(true);
    try {
      const result = await gitOpenPr(path);
      if (activeWorkspacePathRef.current === path) setGitPrUrl(result.url);
      toast.success(
        `${result.created ? "PR created" : "PR ready"} · ${result.url}`,
      );
      if (activeWorkspacePathRef.current === path) {
        await refreshGit({ includeDiff: true });
      }
    } catch (e) {
      toast.error(safeErrorMessage(e, "Could not open the pull request."));
    } finally {
      setGitBusy(false);
    }
  }, [activeWorkspacePath, activeGitStatus, refreshGit, toast]);

  // Poll / refresh git when project/worktree changes, stream ends, or review opens on git scope.
  useEffect(() => {
    if (gitRefreshTimerRef.current !== null) {
      window.clearTimeout(gitRefreshTimerRef.current);
      gitRefreshTimerRef.current = null;
    }
    gitReqSeqRef.current += 1;
    setGitStatus(null);
    setGitStatusPath(null);
    setGitDiff(null);
    setGitDiffPath(null);
    setGitLoading(Boolean(activeWorkspacePath && isTauri()));
    void refreshGit({ includeDiff: reviewOpen && reviewScope === "git" });
  }, [activeWorkspacePath]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (reviewOpen && reviewScope === "git") {
      void refreshGit({ includeDiff: true });
    }
  }, [reviewOpen, reviewScope]); // eslint-disable-line react-hooks/exhaustive-deps

  // After agent finishes editing files, refresh working tree with a short debounce.
  useEffect(() => {
    if (activeStreaming) return;
    if (!activeWorkspacePath) return;
    scheduleGitRefresh({
      includeDiff: reviewOpen && reviewScope === "git",
      delayMs: 450,
    });
  }, [
    activeStreaming,
    active?.messages?.length,
    activeWorkspacePath,
    scheduleGitRefresh,
    reviewOpen,
    reviewScope,
  ]);

  useEffect(() => {
    return () => {
      if (gitRefreshTimerRef.current !== null) {
        window.clearTimeout(gitRefreshTimerRef.current);
      }
    };
  }, []);

  // Reset review selection when leaving the thread.
  useEffect(() => {
    setReviewActivePath(null);
    setReviewOpen(false);
    setReviewScope("turn");
  }, [activeId]);

  const updateThread = useCallback(
    (id: string, updater: (c: Thread) => Thread, opts?: ThreadStoreSetOpts) => {
      // Keep threadsRef in lockstep so interrupt → Send now can read the
      // finalized assistant/tool transcript without waiting on a render tick.
      // Only allocate a new array when the target thread actually changes.
      setThreads((prev) => {
        const idx = prev.findIndex((c) => c.id === id);
        if (idx < 0) return prev;
        const cur = prev[idx];
        const updated = updater(cur);
        if (updated === cur) return prev;
        const next = prev.slice();
        next[idx] = updated;
        threadsRef.current = next;
        return next;
      }, opts);
    },
    [setThreads],
  );

  const handleModelChange = useCallback(
    (id: string): boolean => {
      const activeThread = activeIdRef.current
        ? threadsRef.current.find((thread) => thread.id === activeIdRef.current)
        : null;
      if (!canSelectModelForThread(activeThread, id)) {
        toast.info("Start a new thread to switch AI provider");
        return false;
      }
      const permissionConflict = modelPermissionConflict(id, permissionMode);
      if (permissionConflict) {
        toast.info(permissionConflict);
        return false;
      }
      setModelId(id);
      setThinking((current) => thinkingForModel(id, current));
      if (activeThread) {
        updateThread(activeThread.id, (thread) =>
          thread.modelId === id
            ? thread
            : { ...thread, modelId: id, updatedAt: Date.now() },
        );
      }
      return true;
    },
    [permissionMode, toast, updateThread],
  );

  const handleCompactThread = useCallback((): boolean => {
    const id = activeIdRef.current;
    if (!id) {
      toast.info("No active chat to compact");
      return false;
    }
    if (compactingRef.current) return false;
    if (streamingThreadIdsRef.current.includes(id)) {
      toast.error("Wait for the reply to finish before compacting");
      return false;
    }
    const thread = threadsRef.current.find((t) => t.id === id);
    if (!thread) {
      toast.info("No active chat to compact");
      return false;
    }
    if (thread.messages.length === 0) {
      toast.info("Nothing to compact");
      return false;
    }

    const result = compactMessages(
      thread.messages,
      threadModelId(thread) ?? modelId,
    );
    if (!result.changed) {
      toast.info(formatCompactResultToast(result));
      return true;
    }

    compactingRef.current = true;
    setCompacting(true);

    const reduced =
      typeof window !== "undefined" &&
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    // Hold the fold animation, then swap messages so the meter/timeline settle together.
    const effectMs = reduced ? 80 : 980;
    const sourceMessages = thread.messages;

    window.setTimeout(() => {
      // Thread may have been deleted/switched mid-effect — only rewrite if still present.
      const still = threadsRef.current.some((t) => t.id === id);
      if (still) {
        let applied = false;
        updateThread(
          id,
          (c) => {
            const next = applyCompactionIfCurrent(
              c,
              sourceMessages,
              result.messages,
            );
            applied = next !== c;
            return next;
          },
          { immediate: true },
        );
        if (applied) {
          persistThreadsNow();
          toast.success(formatCompactResultToast(result));
        } else {
          toast.info("Chat changed before compaction finished");
        }
      }
      setCompacting(false);
      compactingRef.current = false;
    }, effectMs);

    return true;
  }, [modelId, toast, updateThread, persistThreadsNow]);

  const handleApproveTool = useCallback(
    async (toolId: string, threadId?: string | null) => {
      const sid = threadId ?? activeIdRef.current;
      if (!sid || !toolId.trim()) return;
      setApprovalBusyId(toolId);
      try {
        await approveChatTool(sid, toolId);
        const overlay = streamOverlay.get(sid);
        if (overlay) {
          streamOverlay.set(
            sid,
            {
              assistantId: overlay.assistantId,
              message: markToolRunning(overlay.message, toolId),
            },
            { notify: activeIdRef.current === sid, immediate: true },
          );
        }
        setApprovalAttentionEpoch((current) => current + 1);
      } catch (e) {
        toast.error(
          safeErrorMessage(e, "Could not approve the requested action."),
        );
      } finally {
        setApprovalBusyId((cur) => (cur === toolId ? null : cur));
      }
    },
    [streamOverlay, toast],
  );

  const handleDenyTool = useCallback(
    async (toolId: string, threadId?: string | null) => {
      const sid = threadId ?? activeIdRef.current;
      if (!sid || !toolId.trim()) return;
      setApprovalBusyId(toolId);
      try {
        await denyChatTool(sid, toolId);
      } catch (e) {
        toast.error(
          safeErrorMessage(e, "Could not deny the requested action."),
        );
      } finally {
        setApprovalBusyId((cur) => (cur === toolId ? null : cur));
      }
    },
    [toast],
  );

  const clearPendingUserInput = useCallback((threadId: string, requestId?: string) => {
    setPendingUserInputByThread((current) => {
      const existing = current[threadId];
      if (!existing || (requestId && existing.requestId !== requestId)) return current;
      const next = { ...current };
      delete next[threadId];
      return next;
    });
  }, []);

  const handleSubmitUserInput = useCallback(
    async (answers: string[][]) => {
      const sid = activeIdRef.current;
      if (!sid) return;
      const request = pendingUserInputByThread[sid];
      if (!request || userInputBusyByThread[sid]) return;
      setUserInputBusyByThread((current) => ({
        ...current,
        [sid]: request.requestId,
      }));
      try {
        await replyToChatUserInput(sid, request.requestId, answers);
        clearPendingUserInput(sid, request.requestId);
      } catch (error) {
        toast.error(safeErrorMessage(error, "Could not send the answer."));
      } finally {
        setUserInputBusyByThread((current) => {
          if (current[sid] !== request.requestId) return current;
          const next = { ...current };
          delete next[sid];
          return next;
        });
      }
    },
    [clearPendingUserInput, pendingUserInputByThread, toast, userInputBusyByThread],
  );

  const handleRejectUserInput = useCallback(async () => {
    const sid = activeIdRef.current;
    if (!sid) return;
    const request = pendingUserInputByThread[sid];
    if (!request || userInputBusyByThread[sid]) return;
    setUserInputBusyByThread((current) => ({
      ...current,
      [sid]: request.requestId,
    }));
    try {
      await rejectChatUserInput(sid, request.requestId);
      clearPendingUserInput(sid, request.requestId);
    } catch (error) {
      toast.error(safeErrorMessage(error, "Could not dismiss the question."));
    } finally {
      setUserInputBusyByThread((current) => {
        if (current[sid] !== request.requestId) return current;
        const next = { ...current };
        delete next[sid];
        return next;
      });
    }
  }, [clearPendingUserInput, pendingUserInputByThread, toast, userInputBusyByThread]);

  const handleApproveAllTools = useCallback(async () => {
    const id = activeIdRef.current;
    if (!id) return;
    const pending = collectPendingApprovals(
      // Use latest overlay-merged view via activeMessages is not available here;
      // re-read from overlay + threads.
      (() => {
        const base =
          threadsRef.current.find((t) => t.id === id)?.messages ?? [];
        const ov = streamOverlay.get(id);
        if (!ov) return base;
        const idx = base.findIndex((m) => m.id === ov.assistantId);
        if (idx < 0) return [...base, ov.message];
        const next = base.slice();
        next[idx] = ov.message;
        return next;
      })(),
    );
    await runApprovalBatch(id, pending, (threadId, toolId) =>
      handleApproveTool(toolId, threadId),
    );
  }, [handleApproveTool, streamOverlay]);

  const handleDenyAllTools = useCallback(async () => {
    const id = activeIdRef.current;
    if (!id) return;
    const base = threadsRef.current.find((t) => t.id === id)?.messages ?? [];
    const ov = streamOverlay.get(id);
    let messages = base;
    if (ov) {
      const idx = base.findIndex((m) => m.id === ov.assistantId);
      if (idx < 0) messages = [...base, ov.message];
      else {
        messages = base.slice();
        messages[idx] = ov.message;
      }
    }
    const pending = collectPendingApprovals(messages);
    await runApprovalBatch(id, pending, (threadId, toolId) =>
      handleDenyTool(toolId, threadId),
    );
  }, [handleDenyTool, streamOverlay]);

  const handleUndoSnapshots = useCallback(
    async (scope: "turn" | "session"): Promise<boolean> => {
      const sid = activeIdRef.current;
      if (!sid) {
        toast.info("No active chat");
        return false;
      }
      if (streamingThreadIdsRef.current.includes(sid)) {
        toast.info("Wait for the agent to finish before undoing");
        return false;
      }
      if (undoBusy) return false;
      setUndoBusy(true);
      try {
        const messages =
          threadsRef.current.find((t) => t.id === sid)?.messages ?? [];
        const candidates = mutationToolIdsForUndo(messages, scope);
        if (candidates.length === 0) {
          toast.info(
            scope === "turn"
              ? "No file edits in the last turn to undo"
              : "No file edits in this chat to undo",
          );
          return false;
        }
        const snaps = await listSnapshots(sid);
        const toolIds = filterToolIdsWithSnapshots(candidates, snaps);
        if (toolIds.length === 0) {
          toast.info(
            "No restorable snapshots (edits may predate capture or already undone)",
          );
          return false;
        }
        const report = await restoreSnapshots(sid, toolIds);
        setSnapshotEpoch((n) => n + 1);
        if (activeProjectId) {
          void refreshGit({ includeDiff: true });
        }
        const n = report.restored.length;
        if (n > 0) {
          toast.success(n === 1 ? `Restored 1 file` : `Restored ${n} files`);
        }
        if (report.errors.length > 0) {
          toast.error("Some files could not be restored.");
        }
        return n > 0;
      } catch (e) {
        toast.error(safeErrorMessage(e, "Could not restore the file changes."));
        return false;
      } finally {
        setUndoBusy(false);
      }
    },
    // refreshGit / activeProjectId are stable enough for undo UX
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [toast, undoBusy, activeProjectId],
  );

  const handleUndoReviewScope = useCallback(async () => {
    if (reviewScope === "git") return;
    await handleUndoSnapshots(reviewScope === "session" ? "session" : "turn");
  }, [handleUndoSnapshots, reviewScope]);

  /** Local composer `/` commands — never forwarded to the model. */
  const slashHandlers = useMemo<SlashCommandHandlers>(
    () => ({
      newChat: () => handleNew(activeProjectId),
      setModel: (id) => {
        return handleModelChange(id);
      },
      setThinking: (level) => {
        const effective = thinkingForModel(modelId, level);
        setThinking(effective);
        return effective;
      },
      setAccessMode: (mode) => setAccessMode(mode),
      setAgentMode: (mode) => setAgentMode(mode),
      setPermissionMode: (mode) => setPermissionMode(mode),
      openReview: () => openRightPanelPage("review"),
      toggleTheme: () =>
        setTheme((t) => {
          return resolveTheme(t) === "dark" ? "light" : "dark";
        }),
      setTheme: (mode) => setTheme(mode),
      compact: () => handleCompactThread(),
      undoLastTurn: () => handleUndoSnapshots("turn"),
      notify: (message, kind = "info") => {
        if (kind === "success") toast.success(message);
        else if (kind === "error") toast.error(message);
        else toast.info(message);
      },
    }),
    // handleNew closes over activeProjectId; toast is stable enough for prefs UX.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      activeProjectId,
      handleCompactThread,
      handleModelChange,
      handleUndoSnapshots,
      modelId,
      openRightPanelPage,
      toast,
    ],
  );

  const handleNew = (projectId: string | null = activeProjectId) => {
    const c = createThread(projectId, "New chat", modelId);
    setThreads((prev) => [c, ...prev]);
    setActiveId(c.id);
    setActiveProjectId(projectId);
    setDraft("");
    setAttachments([]);
    setRenaming(false);
  };

  const openNewThreadProjectPicker = useCallback(() => {
    setFilePickerOpen(false);
    setPaletteView("new-thread-in");
    setPaletteOpen(true);
  }, []);

  /** Keep the selected project and an adoptable active thread in sync. */
  const handleProjectSelection = useCallback(
    (projectId: string | null) => {
      setActiveProjectId(projectId);
      const threadId = activeIdRef.current;
      if (!threadId) return;
      const thread = threadsRef.current.find(
        (candidate) => candidate.id === threadId,
      );
      if (thread && needsOrdinaryThreadForProjectSelection(thread, projectId)) {
        const created = createThread(projectId, "New chat", modelId);
        setThreads((prev) => [created, ...prev]);
        setActiveId(created.id);
        setDraft("");
        setAttachments([]);
        setRenaming(false);
        return;
      }
      updateThread(
        threadId,
        (thread) => rebindThreadProjectOnSelection(thread, projectId),
        { immediate: true },
      );
    },
    [modelId, setThreads, updateThread],
  );

  /** New thread with an isolated git worktree (agent edits stay off main tree). */
  const handleNewInWorktree = useCallback(
    async (projectId: string | null = activeProjectId) => {
      if (!projectId) {
        toast.info("Open a project first");
        return;
      }
      const project = projects.find((p) => p.id === projectId);
      if (!project?.path) {
        toast.info("Open a project first");
        return;
      }
      if (!isTauri()) {
        toast.error("Worktrees require the desktop app");
        return;
      }
      if (worktreeCreateBusyRef.current) return;

      const pending = createThread(projectId, "New chat", modelId);
      const composerOwner = {
        activeId: activeIdRef.current,
        epoch: composerEpochRef.current,
      };
      worktreeCreateBusyRef.current = true;
      worktreeCreateProjectIdRef.current = projectId;
      setWorktreeCreateBusy(true);
      try {
        const refs =
          gitRefsPath === project.path ? gitRefs : await loadGitRefs(project.path);
        const baseRef = resolveWorktreeBaseRef(
          refs,
          worktreeBaseRefByProject[projectId],
        );
        if (!baseRef) {
          throw new Error(
            "Choose a base branch from the Composer before creating a worktree.",
          );
        }
        // Backend creation must succeed before the thread becomes visible locally.
        const wt = await gitWorktreeCreate(project.path, pending.id, baseRef);
        if (
          !projectsRef.current.some((candidate) => candidate.id === projectId)
        ) {
          try {
            await gitWorktreeRemove(project.path, wt.path);
            await unregisterProjectRoot(wt.path);
          } catch {
            /* backend keeps the path registered when cleanup cannot finish */
          }
          toast.info(
            "Project was removed before the worktree finished creating",
          );
          return;
        }
        // Allowlist tools/FS against the new worktree path immediately (not only on next boot).
        try {
          await registerProjectRoot(wt.path);
        } catch {
          /* backend create already registered in most paths; ignore duplicate */
        }
        const title = wt.branch.startsWith("xiao/")
          ? `Worktree ${wt.branch.slice(5, 13)}`
          : wt.branch;
        const created: Thread = {
          ...pending,
          title,
          worktreePath: wt.path,
          worktreeBranch: wt.branch,
        };
        setThreads((prev) => [created, ...prev]);
        if (
          isCurrentComposerOwner(
            composerOwner,
            activeIdRef.current,
            composerEpochRef.current,
          )
        ) {
          setActiveId(created.id);
          setActiveProjectId(projectId);
          setDraft("");
          setAttachments([]);
          setRenaming(false);
        }
        persistThreadsNow();
        toast.success(`Worktree ready · ${wt.branch}`);
      } catch (e) {
        toast.error(safeErrorMessage(e, "Could not create the worktree."));
      } finally {
        worktreeCreateBusyRef.current = false;
        worktreeCreateProjectIdRef.current = null;
        setWorktreeCreateBusy(false);
      }
    },
    [
      activeProjectId,
      gitRefs,
      gitRefsPath,
      loadGitRefs,
      modelId,
      persistThreadsNow,
      projects,
      toast,
      worktreeBaseRefByProject,
    ],
  );

  const handleDelete = async (id: string) => {
    const thread = threadsRef.current.find((t) => t.id === id);
    if (!thread) return;
    const isWorktree = Boolean(thread.worktreePath);
    const isStreaming = streamingThreadIdsRef.current.includes(id);
    const isSending = sendingByThreadRef.current.has(id);

    if (isWorktree && (isStreaming || isSending)) {
      toast.error("Stop this worktree task before deleting it");
      return;
    }
    if (worktreeDeleteBusyRef.current.has(id)) return;
    let worktreeRemovalWarning: string | null = null;

    if (
      thread.worktreePath &&
      !(await requestConfirmDialog(
        `Delete “${thread.title}” and remove its worktree?\n\n${thread.worktreePath}\n\nThe branch will be kept.`,
        { variant: "destructive" },
      ))
    ) {
      return;
    }

    if (thread.worktreePath) {
      const project = projects.find((p) => p.id === thread.projectId);
      if (!project?.path) {
        toast.error(
          "Cannot remove worktree because its parent project is missing",
        );
        return;
      }
      worktreeDeleteBusyRef.current.add(id);
      try {
        const removal = await gitWorktreeRemove(
          project.path,
          thread.worktreePath,
        );
        worktreeRemovalWarning = removal.warning;
      } catch (e) {
        toast.error(
          safeErrorMessage(
            e,
            "Could not remove the worktree. Save or revert its changes first.",
          ),
        );
        return;
      } finally {
        worktreeDeleteBusyRef.current.delete(id);
      }
    } else if (isStreaming) {
      // Preserve existing behavior for normal chats: cancel only this stream.
      const ac = abortByThreadRef.current.get(id);
      ac?.abort();
      abortByThreadRef.current.delete(id);
      const prevGen = streamGenByThreadRef.current.get(id) ?? 0;
      streamGenByThreadRef.current.set(id, prevGen + 1);
      void cancelChatStream(id);
      clearStreaming(id);
      drainAfterRef.current = drainAfterRef.current.filter((x) => x !== id);
    }

    setSendQueue((q) => q.filter((item) => item.threadId !== id));
    streamBatchByThreadRef.current.get(id)?.dispose();
    streamBatchByThreadRef.current.delete(id);
    streamGenByThreadRef.current.delete(id);
    prioritySendByThreadRef.current.delete(id);
    sendingByThreadRef.current.delete(id);
    streamOverlay.clear(id, { notify: false, immediate: true });
    const wasActive = activeIdRef.current === id;
    if (wasActive) {
      setDraft("");
      setAttachments([]);
    }
    setThreads((prev) => {
      const next = prev.filter((c) => c.id !== id);
      if (!wasActive) return next;

      // Never jump into an archived chat (sidebar hides those).
      const nextLiveId = pickNextLiveThreadId(next, null);
      if (nextLiveId) {
        const live = next.find((t) => t.id === nextLiveId)!;
        const nextModelId = threadModelId(live);
        if (nextModelId) {
          setModelId(nextModelId);
          setThinking((current) => thinkingForModel(nextModelId, current));
        }
        setActiveId(live.id);
        setActiveProjectId(live.projectId);
        return next;
      }
      const fresh = createThread(activeProjectId, "New chat", modelId);
      setActiveId(fresh.id);
      return [fresh, ...next];
    });
    // Ensure delete lands on disk even if the app is closed immediately.
    persistThreadsNow();
    if (worktreeRemovalWarning) {
      toast.error(`Thread deleted. ${worktreeRemovalWarning}`);
    } else {
      toast.info(isWorktree ? "Worktree and thread deleted" : "Thread deleted");
    }
  };

  const handleSettle = (id: string) => {
    const needsAttention = attentionByThreadIdRef.current.has(id);
    const working =
      streamingThreadIdsRef.current.includes(id) ||
      sendingByThreadRef.current.has(id);
    if (!canSettle({ working, needsAttention })) {
      toast.info(
        needsAttention
          ? "Resolve the request before settling this chat"
          : "Stop the agent before settling this chat",
      );
      return;
    }
    updateThread(id, (c) => ({
      ...c,
      settledAt: Date.now(),
      snoozedUntil: null,
    }));
  };

  const handleUnsettle = (id: string) => {
    updateThread(id, (c) => ({
      ...c,
      settledAt: null,
      updatedAt: Date.now(),
    }));
  };

  /** Move a chat into Settings → Archive (hidden from the sidebar). */
  const handleArchive = (id: string) => {
    if (
      streamingThreadIdsRef.current.includes(id) ||
      sendingByThreadRef.current.has(id)
    ) {
      toast.info("Stop the agent before archiving this chat");
      return;
    }
    const now = Date.now();
    const remaining = threadsRef.current.filter(
      (t) => t.id !== id && t.archivedAt == null,
    );
    setSendQueue((prev) => prev.filter((item) => item.threadId !== id));
    drainAfterRef.current = drainAfterRef.current.filter(
      (threadId) => threadId !== id,
    );
    prioritySendByThreadRef.current.delete(id);
    updateThread(id, (c) => ({
      ...c,
      archivedAt: now,
      settledAt: c.settledAt ?? now,
      snoozedUntil: null,
      pinned: false,
    }));
    if (activeIdRef.current === id) {
      setDraft("");
      setAttachments([]);
      if (remaining[0]) {
        const nextModelId = threadModelId(remaining[0]);
        if (nextModelId) {
          setModelId(nextModelId);
          setThinking((current) => thinkingForModel(nextModelId, current));
        }
        setActiveId(remaining[0].id);
        setActiveProjectId(remaining[0].projectId);
      } else {
        const fresh = createThread(activeProjectId, "New chat", modelId);
        setThreads((prev) => [fresh, ...prev]);
        setActiveId(fresh.id);
      }
    }
    toast.info("Chat archived");
  };

  const handleUnarchive = (id: string, opts?: { silent?: boolean }) => {
    updateThread(id, (c) => ({
      ...c,
      archivedAt: null,
      settledAt: null,
      snoozedUntil: null,
      updatedAt: Date.now(),
    }));
    if (!opts?.silent) toast.success("Chat restored");
  };

  /**
   * Archive every non-archived, non-working chat with a full-app vortex effect.
   * Chats currently streaming stay open so in-flight work is not buried.
   * Spawns one empty active thread only when the open chat itself is archived.
   */
  const handleArchiveAll = useCallback(() => {
    if (archivingAll) return;
    const now = Date.now();
    const workingIds = new Set(streamingThreadIdsRef.current);
    const live = threadsRef.current.filter((t) => t.archivedAt == null);
    // Skip working chats and the no-op case: only empty "New chat" left.
    const toArchive = live.filter((t) => {
      if (workingIds.has(t.id)) return false;
      return t.messages.length > 0 || t.title !== "New chat" || t.pinned;
    });
    if (toArchive.length === 0) {
      toast.info(
        workingIds.size > 0
          ? "Nothing to archive — working chats stay open"
          : "Nothing to archive",
      );
      return;
    }

    const archiveIds = new Set(toArchive.map((t) => t.id));

    setArchivingAll(true);
    // Keep Settings mounted so it gets sucked into the vortex with the shell
    // (closing it first made the effect look like a lone spinner overlay).
    setPaletteOpen(false);
    setProfileOpen(false);

    // Drop queued sends only for chats we are about to archive.
    setSendQueue((prev) =>
      prev.filter((item) => !archiveIds.has(item.threadId)),
    );
    drainAfterRef.current = drainAfterRef.current.filter(
      (id) => !archiveIds.has(id),
    );
    for (const id of archiveIds) {
      prioritySendByThreadRef.current.delete(id);
    }

    const reduced =
      typeof window !== "undefined" &&
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    // Slightly longer than CSS 1.7s so the final keyframe holds before settle.
    const effectMs = reduced ? 80 : 1820;

    window.setTimeout(() => {
      const activeStillOpen =
        activeIdRef.current != null && !archiveIds.has(activeIdRef.current);
      const needFresh = !activeStillOpen;

      setThreads((prev) => {
        const next = prev.map((t) => {
          if (!archiveIds.has(t.id)) return t;
          return {
            ...t,
            archivedAt: now,
            settledAt: t.settledAt ?? now,
            snoozedUntil: null,
            pinned: false,
          };
        });
        if (!needFresh) return next;
        const fresh = createThread(activeProjectId, "New chat", modelId);
        setActiveId(fresh.id);
        return [fresh, ...next];
      });

      if (needFresh) {
        setDraft("");
        setAttachments([]);
        setRenaming(false);
        setReviewOpen(false);
      }

      window.setTimeout(() => persistThreadsNow(), 0);
      const n = toArchive.length;
      const keptWorking = live.filter((t) => workingIds.has(t.id)).length;
      const base = n === 1 ? "Archived 1 chat" : `Archived ${n} chats`;
      toast.success(
        keptWorking > 0 ? `${base} · kept ${keptWorking} working` : base,
      );
      setSettingsOpen(false);
      setArchivingAll(false);
    }, effectMs);
  }, [activeProjectId, archivingAll, modelId, persistThreadsNow, toast]);

  const handleImportCodexChats = useCallback(async () => {
    if (importingCodexChats) return;
    setImportingCodexChats(true);
    try {
      const { importCodexChats, mergeCodexChats } = await import(
        "./codexImport"
      );
      const imported = await importCodexChats();
      if (imported.threads.length === 0) {
        toast.info("No importable Codex chats were found");
        return;
      }
      const fallbackModelId = providerOf(modelId) === "openai" ? modelId : undefined;
      const merged = mergeCodexChats(
        threadsRef.current,
        imported.threads,
        projectsRef.current,
        fallbackModelId,
      );
      if (merged.added === 0 && merged.updated === 0) {
        toast.info(
          merged.unchanged === 1
            ? "Codex chat is already up to date"
            : `${merged.unchanged} Codex chats are already up to date`,
        );
        return;
      }
      setThreads(merged.threads, { immediate: true });
      persistThreadsNow();
      const saveResult = await flushStore();
      if (saveResult === "failed") {
        toast.error("Codex chats were imported but could not be saved to disk");
        return;
      }
      const changes = [
        merged.added > 0 ? `${merged.added} added` : null,
        merged.updated > 0 ? `${merged.updated} updated` : null,
      ]
        .filter(Boolean)
        .join(" · ");
      const skipped = imported.skippedFiles
        ? ` · ${imported.skippedFiles} files skipped`
        : "";
      toast.success(`Codex chats imported · ${changes}${skipped}`);
    } catch (error) {
      toast.error(safeErrorMessage(error, "Could not import Codex chats."));
    } finally {
      setImportingCodexChats(false);
    }
  }, [importingCodexChats, modelId, persistThreadsNow, setThreads, toast]);

  const handleUnimportCodexChats = useCallback(async () => {
    if (unimportingCodexChats) return;
    const imported = threadsRef.current.filter(isImportedCodexThread);
    if (imported.length === 0) {
      toast.info("No imported Codex chats to remove");
      return;
    }
    if (imported.some((thread) => thread.worktreePath)) {
      toast.error(
        "Remove worktrees from imported Codex chats before unimporting them",
      );
      return;
    }
    setUnimportingCodexChats(true);
    try {
      const confirmed = await requestConfirmDialog(
        `Remove ${imported.length === 1 ? "1 imported Codex chat" : `${imported.length} imported Codex chats`} from Open Xiao?\n\nAny running imported chats will be stopped. The original chats in Codex will not be changed.`,
        { variant: "destructive" },
      );
      if (!confirmed) return;
      const { removeImportedCodexChats } = await import("./codexImport");
      const result = removeImportedCodexChats(threadsRef.current);
      const removedSet = new Set(result.removedIds);
      setSendQueue((queue) =>
        queue.filter((item) => !removedSet.has(item.threadId)),
      );
      drainAfterRef.current = drainAfterRef.current.filter(
        (id) => !removedSet.has(id),
      );
      for (const id of removedSet) {
        const wasWorking =
          streamingThreadIdsRef.current.includes(id) ||
          sendingByThreadRef.current.has(id);
        const controller = abortByThreadRef.current.get(id);
        controller?.abort();
        abortByThreadRef.current.delete(id);
        if (wasWorking) {
          const generation = streamGenByThreadRef.current.get(id) ?? 0;
          streamGenByThreadRef.current.set(id, generation + 1);
          void cancelChatStream(id);
          clearStreaming(id);
        }
        streamBatchByThreadRef.current.get(id)?.dispose();
        streamBatchByThreadRef.current.delete(id);
        streamGenByThreadRef.current.delete(id);
        prioritySendByThreadRef.current.delete(id);
        sendingByThreadRef.current.delete(id);
        streamOverlay.clear(id, { notify: false, immediate: true });
      }

      let nextThreads = result.threads;
      if (activeIdRef.current && removedSet.has(activeIdRef.current)) {
        setDraft("");
        setAttachments([]);
        const nextLiveId = pickNextLiveThreadId(nextThreads, null);
        if (nextLiveId) {
          const next = nextThreads.find((thread) => thread.id === nextLiveId)!;
          const nextModelId = threadModelId(next);
          if (nextModelId) {
            setModelId(nextModelId);
            setThinking((current) => thinkingForModel(nextModelId, current));
          }
          setActiveId(next.id);
          setActiveProjectId(next.projectId);
        } else {
          const fresh = createThread(activeProjectId, "New chat", modelId);
          nextThreads = [fresh, ...nextThreads];
          setActiveId(fresh.id);
        }
      }
      setThreads(nextThreads, { immediate: true });
      persistThreadsNow();
      const saveResult = await flushStore();
      if (saveResult === "failed") {
        toast.error("Codex chats were removed but the change could not be saved");
        return;
      }
      toast.success(
        result.removedIds.length === 1
          ? "Unimported 1 Codex chat"
          : `Unimported ${result.removedIds.length} Codex chats`,
      );
    } catch (error) {
      toast.error(safeErrorMessage(error, "Could not unimport Codex chats."));
    } finally {
      setUnimportingCodexChats(false);
    }
  }, [
    activeProjectId,
    clearStreaming,
    modelId,
    persistThreadsNow,
    setThreads,
    streamOverlay,
    toast,
    unimportingCodexChats,
  ]);

  const handlePin = (id: string, pinned: boolean) => {
    updateThread(id, (c) => {
      if (pinned) {
        return {
          ...c,
          pinned: true,
          // Pinning brings the chat back to the active shelf.
          archivedAt: null,
          settledAt: null,
          snoozedUntil: null,
          updatedAt: Date.now(),
        };
      }
      return { ...c, pinned: false };
    });
  };

  const handleSnooze = (id: string, untilMs: number) => {
    const needsAttention = attentionByThreadIdRef.current.has(id);
    const working =
      streamingThreadIdsRef.current.includes(id) ||
      sendingByThreadRef.current.has(id);
    if (!canSettle({ working, needsAttention })) {
      toast.info(
        needsAttention
          ? "Resolve the request before snoozing this chat"
          : "Stop the agent before snoozing this chat",
      );
      return;
    }
    updateThread(id, (c) => ({
      ...c,
      snoozedUntil: untilMs,
      wokeAt: null,
    }));
  };

  const handleUnsnooze = (id: string) => {
    updateThread(id, (c) => ({
      ...c,
      snoozedUntil: null,
      wokeAt: Date.now(),
    }));
  };

  const handleSelectThread = (id: string) => {
    const selected = threadsRef.current.find((thread) => thread.id === id);
    if (!selected) return;
    const selectedModelId = threadModelId(selected);
    if (selectedModelId) {
      setModelId(selectedModelId);
      setThinking((current) => thinkingForModel(selectedModelId, current));
    }
    setActiveProjectId(selected.projectId);
    if (activeIdRef.current !== id) {
      setDraft("");
      setAttachments([]);
    }
    setActiveId(id);
    // Pull any silent background-stream patches into the next paint.
    threadStore.flush();
    updateThread(
      id,
      (c) => ({
        ...c,
        lastVisitedAt: Date.now(),
        // Visiting clears the Woke pill.
        wokeAt: null,
      }),
      { immediate: true },
    );
  };

  // Natural snooze expiry → stamp wokeAt and clear snoozedUntil.
  useEffect(() => {
    const tick = () => {
      const now = Date.now();
      setThreads((prev) => {
        let changed = false;
        const next = prev.map((t) => {
          if (t.snoozedUntil != null && t.snoozedUntil <= now) {
            changed = true;
            return {
              ...t,
              snoozedUntil: null,
              wokeAt: t.wokeAt ?? t.snoozedUntil,
            };
          }
          return t;
        });
        return changed ? next : prev;
      });
    };
    tick();
    const id = window.setInterval(tick, 15_000);
    return () => window.clearInterval(id);
  }, []);

  const handleRename = (id: string, title: string) => {
    const t = title.trim();
    if (!t) return;
    updateThread(id, (c) => ({ ...c, title: t, updatedAt: Date.now() }));
  };

  const handleCopyThreadId = useCallback(
    async (id: string) => {
      try {
        await navigator.clipboard.writeText(id);
        toast.success("Thread ID copied");
      } catch (error) {
        toast.error(safeErrorMessage(error, "Could not copy the thread ID."));
      }
    },
    [toast],
  );

  const commitTopbarRename = () => {
    if (activeId && renameDraft.trim()) {
      handleRename(activeId, renameDraft);
    }
    setRenaming(false);
  };

  const handleStop = async (
    threadId?: string | null,
    opts?: { mode?: "stop" | "send-now" },
  ) => {
    const stoppedId = threadId ?? activeId;
    if (!stoppedId || !streamingThreadIdsRef.current.includes(stoppedId))
      return;
    const mode = opts?.mode ?? "stop";
    // 1) Drain rAF buffer while isLive() still allows patchAssistant.
    // 2) Merge overlay → threads before abort/gen bump so a racing finally
    //    cannot clear the live overlay before Stop commits it.
    streamBatchByThreadRef.current.get(stoppedId)?.flush();
    const start = streamStartedAtById[stoppedId];
    const durationMs =
      start != null ? Math.max(0, Date.now() - start) : undefined;
    const overlay = streamOverlay.get(stoppedId);
    // Commit interrupted assistant (incl. tool rows) before drain/send-now
    // so the next history build sees partial work, not a stale empty shell.
    flushSync(() => {
      updateThread(stoppedId, (c) => {
        let msgs = applyStreamOverlay(c.messages, overlay);
        msgs = [...msgs];
        for (let i = msgs.length - 1; i >= 0; i--) {
          if (msgs[i].role !== "assistant") continue;
          let m = msgs[i];
          if (durationMs != null) m = { ...m, durationMs };
          // Soft cut for Send now: keep partial work, don't mark tools failed.
          m = finalizeRunningTools(
            m,
            mode === "send-now"
              ? "Interrupted by follow-up"
              : "Stopped before tool finished",
            mode === "send-now" ? "done" : "error",
          );
          msgs[i] = m;
          break;
        }
        return {
          ...c,
          messages: msgs,
          lastError: mode === "send-now" ? null : c.lastError,
          updatedAt: Date.now(),
        };
      });
      streamOverlay.clear(stoppedId, { immediate: true });
    });
    const ac = abortByThreadRef.current.get(stoppedId);
    ac?.abort();
    abortByThreadRef.current.delete(stoppedId);
    const prevGen = streamGenByThreadRef.current.get(stoppedId) ?? 0;
    streamGenByThreadRef.current.set(stoppedId, prevGen + 1);
    try {
      await cancelChatStream(stoppedId);
    } catch (error) {
      toast.error(
        safeErrorMessage(
          error,
          "Stopped locally, but could not cancel the backend task.",
        ),
      );
    } finally {
      clearPendingUserInput(stoppedId);
      enqueueDrain(stoppedId);
      clearStreaming(stoppedId);
    }
  };

  const handleFocusSearch = () => {
    setEffectiveSidebarOpen(true);
    setSidebarSearchOpen(true);
    window.requestAnimationFrame(() => {
      const input = document.querySelector(
        ".sb-search-inline",
      ) as HTMLInputElement | null;
      input?.focus();
    });
  };

  const handleAddProject = async () => {
    const composerOwner = {
      activeId: activeIdRef.current,
      epoch: composerEpochRef.current,
    };
    const stillOwnsComposer = () =>
      isCurrentComposerOwner(
        composerOwner,
        activeIdRef.current,
        composerEpochRef.current,
      );
    try {
      if (!isTauri()) {
        const path = window.prompt("Project folder path");
        if (!path?.trim()) return;
        const p = createProject(path.trim());
        setProjects((prev) => {
          if (prev.some((x) => x.path === p.path)) return prev;
          return [p, ...prev];
        });
        if (stillOwnsComposer()) {
          setActiveProjectId(p.id);
          handleNew(p.id);
        }
        toast.success("Project added");
        return;
      }
      const selected = await open({
        directory: true,
        multiple: false,
        title: "Add project folder",
      });
      if (!selected || Array.isArray(selected)) return;
      const registered = await registerProjectRoot(selected);
      const existing = projects.find(
        (x) => x.path === registered || x.path === selected,
      );
      if (existing) {
        if (stillOwnsComposer()) {
          setActiveProjectId(existing.id);
          handleNew(existing.id);
        }
        return;
      }
      const p = createProject(registered);
      setProjects((prev) => [p, ...prev]);
      const t = createThread(p.id, "New chat", modelId);
      setThreads((prev) => [t, ...prev]);
      if (stillOwnsComposer()) {
        setActiveProjectId(p.id);
        setActiveId(t.id);
        setDraft("");
        setAttachments([]);
      }
      toast.success(`Opened ${p.name}`);
    } catch (e) {
      console.error(e);
      toast.error("Could not add project");
    }
  };

  const handleRemoveProject = async (id: string) => {
    if (worktreeCreateProjectIdRef.current === id) {
      toast.info(
        "Wait for the worktree to finish creating before removing this project",
      );
      return;
    }
    const worktreeThreads = threadsRef.current.filter(
      (t) => t.projectId === id && Boolean(t.worktreePath),
    );
    if (worktreeThreads.length > 0) {
      const label =
        worktreeThreads.length === 1
          ? "the worktree task"
          : `all ${worktreeThreads.length} worktree tasks`;
      toast.error(`Remove ${label} before removing this project`);
      return;
    }
    const projectThreads = threadsRef.current.filter((t) => t.projectId === id);
    const activeWork = projectThreads.some(
      (thread) =>
        streamingThreadIdsRef.current.includes(thread.id) ||
        sendingByThreadRef.current.has(thread.id) ||
        sendQueueRef.current.some((item) => item.threadId === thread.id),
    );
    if (activeWork) {
      toast.error("Stop active tasks and remove queued messages before removing this project");
      return;
    }
    const removed = projectsRef.current.find((p) => p.id === id);
    if (!removed) return;
    try {
      await unregisterProjectRoot(removed.path);
    } catch (error) {
      console.error(error);
      toast.error("Could not remove project");
      return;
    }
    setProjects((prev) => prev.filter((p) => p.id !== id));
    setThreads((prev) =>
      prev.map((t) => (t.projectId === id ? { ...t, projectId: null } : t)),
    );
    if (activeProjectId === id) setActiveProjectId(null);
    toast.info("Project removed");
  };

  const handleToggleProject = (id: string) => {
    setProjects((prev) =>
      prev.map((p) => (p.id === id ? { ...p, collapsed: !p.collapsed } : p)),
    );
  };

  const handleLogin = async () => {
    setAuthError(null);
    setDeviceCode(null);
    captureAuthReturnFocus();
    setAuthModalProvider("grok");
    setAuthBusy(true);
    try {
      const s = await loginWithGrok();
      setAuth(s);
      setAuthModalProvider(null);
      setDeviceCode(null);
      toast.success("Signed in to Grok");
    } catch (e) {
      const error = normalizeUserFacingError(e, { provider: "grok" });
      if (error.category === "cancellation") {
        setAuthModalProvider(null);
        setDeviceCode(null);
        setAuthError(null);
        return;
      }
      setAuthError(error.message);
    } finally {
      setAuthBusy(false);
    }
  };

  const handleCancelLogin = () => {
    void cancelLogin();
    setAuthModalProvider(null);
    setDeviceCode(null);
    setAuthError(null);
    // Keep login actions disabled until the in-flight auth_login call observes
    // cancellation and its finally block acknowledges backend completion.
  };

  const handleLogout = async () => {
    setAuthBusy(true);
    try {
      setAuth(await logoutGrok());
      toast.info("Signed out of Grok");
    } catch {
      toast.error("Could not sign out of Grok. Try again.");
    } finally {
      setAuthBusy(false);
    }
  };

  const handleOpenAILogin = async () => {
    setAuthError(null);
    setOpenAIDeviceCode(null);
    captureAuthReturnFocus();
    setAuthModalProvider("openai");
    setOpenAIAuthBusy(true);
    try {
      const status = await loginWithOpenAI();
      setOpenAIAuth(status);
      setAuthModalProvider(null);
      setOpenAIDeviceCode(null);
      toast.success("Signed in to OpenAI");
    } catch (e) {
      const error = normalizeUserFacingError(e, { provider: "openai" });
      if (error.category === "cancellation") {
        setAuthModalProvider(null);
        setOpenAIDeviceCode(null);
        setAuthError(null);
        return;
      }
      setAuthError(error.message);
    } finally {
      setOpenAIAuthBusy(false);
    }
  };

  const handleCancelOpenAILogin = () => {
    void cancelOpenAILogin();
    setAuthModalProvider(null);
    setOpenAIDeviceCode(null);
    setAuthError(null);
    // The login promise owns busy state and clears it after backend teardown.
  };

  const handleOpenAILogout = async () => {
    setOpenAIAuthBusy(true);
    try {
      setOpenAIAuth(await logoutOpenAI());
      toast.info("Signed out of OpenAI");
    } catch {
      toast.error("Could not sign out of OpenAI. Try again.");
    } finally {
      setOpenAIAuthBusy(false);
    }
  };

  const requestProviderLogin = (provider: ModelProvider) => {
    if (provider === "openai") {
      void handleOpenAILogin();
    } else if (provider === "opencode" || provider === "antigravity") {
      openProviders();
    } else {
      void handleLogin();
    }
  };

  const requestActiveProviderLogin = () => {
    requestProviderLogin(providerOf(modelId));
  };

  const runStream = async (opts: {
    convId: string;
    history: Message[];
    assistantId: string;
    project: Project | null;
    /** When set, tools/git cwd is the worktree instead of project.path. */
    worktreePath?: string | null;
  }) => {
    const { convId, history, assistantId, project, worktreePath } = opts;
    setStreamErrorDismissals((current) =>
      clearStreamErrorDismissal(current, convId),
    );
    const workspacePath = resolveWorkspacePath(project?.path, worktreePath);
    const streamThread = threadsRef.current.find(
      (thread) => thread.id === convId,
    );
    const streamModelId = threadModelId(streamThread) ?? modelId;
    const streamThinking = thinkingForModel(streamModelId, thinking);
    const streamProvider = providerOf(streamModelId);
    const startedAt = Date.now();
    const prevGen = streamGenByThreadRef.current.get(convId) ?? 0;
    const gen = prevGen + 1;
    streamGenByThreadRef.current.set(convId, gen);
    clearPendingUserInput(convId);

    // Stop only a previous stream on this same thread (not other chats).
    const prevAc = abortByThreadRef.current.get(convId);
    if (prevAc) {
      prevAc.abort();
      await cancelChatStream(convId);
    }

    const ac = new AbortController();
    abortByThreadRef.current.set(convId, ac);
    markStreaming(convId, startedAt);

    const isLive = () =>
      !ac.signal.aborted && streamGenByThreadRef.current.get(convId) === gen;
    /** Same generation still owns this thread (ok after user Stop). */
    const isOwnGen = () => streamGenByThreadRef.current.get(convId) === gen;

    /** Live mirror of the assistant message — threads store stays stable until settle. */
    let assistantSnap: Message = {
      id: assistantId,
      role: "assistant",
      content: "",
      createdAt: startedAt,
    };
    // Seed overlay so the open chat can paint before the first token.
    streamOverlay.set(
      convId,
      { assistantId, message: assistantSnap },
      { notify: activeIdRef.current === convId, immediate: true },
    );

    const patchAssistant = (
      patch: (m: Message) => Message,
      opts?: { allowAborted?: boolean },
    ) => {
      if (opts?.allowAborted ? !isOwnGen() : !isLive()) return;
      assistantSnap = patch(assistantSnap);
      // Token/tool patches stay on the overlay store. The durable threads
      // snapshot is rewritten only on settle so Sidebar/Settings/palette
      // do not re-render ~60fps while the open chat streams.
      const isActiveView = activeIdRef.current === convId;
      streamOverlay.set(
        convId,
        { assistantId, message: assistantSnap },
        { notify: isActiveView },
      );
    };

    // Coalesce token and tool IPC onto one React commit per frame.
    // Client sanitize is a last line of defense — backend already strips protocol.
    const batch = createRafStreamBatcher({
      onChunk: (chunk) => {
        const safe = sanitizeUserFacingContent(chunk);
        if (!safe) return;
        patchAssistant((m) => appendTextPart(m, safe));
      },
      onThinking: (chunk) => {
        const safe = sanitizeThinkingContent(chunk);
        if (!safe) return;
        patchAssistant((m) => appendThinkingPart(m, safe));
      },
      onToolStart: ({
        id,
        name,
        args,
        awaitingApproval,
        approvalReason,
        parentId,
      }) => {
        patchAssistant(
          (m) =>
            upsertToolStartPart(m, {
              id,
              name,
              args: redactSensitiveValues(args),
              awaitingApproval,
              approvalReason,
              parentId,
            }),
        );
        if (awaitingApproval) {
          setApprovalAttentionEpoch((current) => current + 1);
        }
      },
      onToolResult: ({ id, name, ok, result, parentId, imageUrl }) => {
        const hadPendingApproval =
          collectPendingApprovals([assistantSnap]).length > 0;
        patchAssistant((m) =>
          upsertToolResultPart(m, { id, name, ok, result, parentId, imageUrl }),
        );
        if (hadPendingApproval) {
          setApprovalAttentionEpoch((current) => current + 1);
        }
      },
      onToolOutput: ({ id, text, replace }) => {
        patchAssistant((m) => upsertToolOutputPart(m, { id, text, replace }));
      },
    });
    streamBatchByThreadRef.current.set(convId, batch);

    /** Captured for finally — avoid a second setState wiping catch's lastError. */
    let streamError: UserFacingError | null = null;
    let userAborted = false;
    try {
      // Only user/assistant from client - system prompt is injected server-side.
      const chatMessages: ChatMsg[] = [];
      for (const m of history) {
        const cm = messageToChat(m);
        if (cm) chatMessages.push(cm);
      }

      await streamChat({
        streamId: convId,
        messages: chatMessages,
        model: streamModelId,
        thinking: streamThinking,
        fastMode: openaiFastMode && supportsFastMode(streamModelId),
        projectPath: workspacePath,
        accessMode,
        permissionMode,
        agentMode,
        onChunk: batch.onChunk,
        onThinking: batch.onThinking,
        onToolStart: batch.onToolStart,
        onToolResult: batch.onToolResult,
        onToolOutput: batch.onToolOutput,
        onUserInput: (request) => {
          if (!isLive()) return;
          setPendingUserInputByThread((current) => ({
            ...current,
            [convId]: request,
          }));
        },
        onUserInputResolved: (requestId) => {
          if (!isOwnGen()) return;
          clearPendingUserInput(convId, requestId);
        },
        onUsage: (usage) => {
          if (streamProvider !== "openai") return;
          void recordOpenAITokenActivity(usage.totalTokens).catch(() => {
            /* non-fatal */
          });
        },
        signal: ac.signal,
      });
      // Drain any tokens still sitting in the rAF buffer before settle.
      if (isLive()) batch.flush();
    } catch (e) {
      if (isLive()) {
        batch.flush();
        const error = normalizeUserFacingError(e, {
          provider: streamProvider,
          fallbackMessage: "The model could not complete this reply.",
        });
        if (error.category === "cancellation" || ac.signal.aborted) {
          userAborted = true;
        } else {
          streamError = error;
          patchAssistant((m) => {
            return finalizeRunningTools(m, error.message);
          });
          if (error.category === "auth") {
            if (streamProvider === "openai") {
              setOpenAIAuth({ signedIn: false });
            } else if (streamProvider === "grok") {
              setAuth({ signedIn: false });
            }
          }
        }
      } else if (ac.signal.aborted) {
        // Stop already flushed via streamBatchByThreadRef; mark abort for settle.
        userAborted = true;
      }
    } finally {
      if (streamBatchByThreadRef.current.get(convId) === batch) {
        streamBatchByThreadRef.current.delete(convId);
      }
      batch.dispose();
      const durationMs = Math.max(0, Date.now() - startedAt);
      const genLive = streamGenByThreadRef.current.get(convId) === gen;
      if (genLive) clearPendingUserInput(convId);
      const aborted = userAborted || ac.signal.aborted;

      if (genLive && !streamError && !aborted) {
        // Stream returned Ok but produced nothing visible — surface why Working died.
        if (isEmptyAssistantTurn(assistantSnap)) {
          streamError = createUserFacingError("connectivity", {
            provider: streamProvider,
          });
        } else {
          const hanging = (assistantSnap.parts ?? []).some(
            (p) => p.type === "tool" && p.call.status === "running",
          );
          if (hanging) {
            streamError = createUserFacingError("connectivity", {
              provider: streamProvider,
            });
            patchAssistant((m) =>
              finalizeRunningTools(m, "Stream ended before this tool finished"),
            );
          } else {
            // Same-turn todowrite: close leftover open steps on this message.
            assistantSnap = settleIncompleteTodosOnMessage(assistantSnap);
          }
        }
      } else if (genLive && aborted) {
        patchAssistant(
          (m) => finalizeRunningTools(m, "Stopped before tool finished"),
          { allowAborted: true },
        );
      }

      if (genLive) {
        assistantSnap = {
          ...assistantSnap,
          durationMs: assistantSnap.durationMs ?? durationMs,
        };
        const shouldSettlePlan = !streamError && !aborted;
        // Commit live overlay into durable threads once, then drop overlay.
        updateThread(
          convId,
          (c) => {
            let messages = c.messages.map((m) =>
              m.id === assistantId ? assistantSnap : m,
            );
            if (!messages.some((m) => m.id === assistantId)) {
              messages = [...messages, assistantSnap];
            }
            // Plan often lives on an earlier assistant turn; settle that too.
            if (shouldSettlePlan) {
              messages = settleIncompleteTodosInMessages(messages);
              const settledSelf = messages.find((m) => m.id === assistantId);
              if (settledSelf) assistantSnap = settledSelf;
            }
            return {
              ...c,
              messages,
              // Own this generation: set error or clear sticky Failed from prior turns.
              lastError: streamError,
              updatedAt: Date.now(),
            };
          },
          { immediate: true },
        );
        streamOverlay.clear(convId, { immediate: true });
      } else {
        // Superseded generation: only drop overlay if it still points at
        // this assistant (a newer runStream may already own the slot).
        const live = streamOverlay.get(convId);
        if (live?.assistantId === assistantId) {
          streamOverlay.clear(convId, {
            notify: activeIdRef.current === convId,
            immediate: true,
          });
        }
      }
      if (!genLive) return;
      if (abortByThreadRef.current.get(convId) === ac) {
        abortByThreadRef.current.delete(convId);
      }
      clearStreaming(convId);
      enqueueDrain(convId);
      // Final answer must hit SQLite promptly (not only after 280ms debounce).
      window.setTimeout(() => persistThreadsNow(), 0);

      // Desktop OS banner when the agent settles (skip user Stop + in-view app).
      if (!aborted) {
        const openThread = (id: string) => handleSelectThread(id);
        if (streamError) {
          if (notifyErrorRef.current) {
            void notifyAgentDone({
              title: streamError.title,
              body: agentNotificationBody("error"),
              threadId: convId,
              kind: "error",
              skipIfInView: false,
              onActivate: openThread,
            });
          }
        } else if (notifyCompleteRef.current) {
          void notifyAgentDone({
            title: "Agent finished",
            body: agentNotificationBody("complete"),
            threadId: convId,
            kind: "complete",
            skipIfInView: false,
            onActivate: openThread,
          });
        }
      }
    }
  };

  const handleSendPayload = async (
    text: string,
    atts: ImageAttachment[],
    opts?: {
      clearComposer?: boolean;
      threadId?: string | null;
      /** API-only body (e.g. interrupt steer). UI stores `text` instead. */
      apiText?: string;
      reviewCommentIds?: string[];
    },
  ) => {
    const clearComposer = opts?.clearComposer ?? true;
    const displayText = text;
    const apiText = opts?.apiText ?? text;
    if (!displayText && !apiText && atts.length === 0) return;

    const targetId = opts?.threadId !== undefined ? opts.threadId : activeId;
    const target = resolveSendTarget(
      threadsRef.current,
      targetId,
      activeProjectId,
      modelId,
    );
    if (!target) {
      if (targetId === activeId) {
        toast.error("This chat no longer has a valid model. Start a new chat.");
      }
      return;
    }
    const projectForSend = findSendTargetProject(projects, target);
    const targetProviderAvailable = sendTargetAvailability(target);
    if (!targetProviderAvailable) {
      requestProviderLogin(target.provider);
      return;
    }

    // Block only if THIS thread is already streaming or mid-send (other chats can run in parallel).
    if (
      targetId &&
      (streamingThreadIdsRef.current.includes(targetId) ||
        sendingByThreadRef.current.has(targetId) ||
        worktreeDeleteBusyRef.current.has(targetId))
    ) {
      return;
    }

    const existing = target.existing;
    // Claim known thread before any await so concurrent Enter cannot double-append.
    if (existing) sendingByThreadRef.current.add(existing.id);

    if (target.provider === "grok") {
      void recordActivity(1).catch(() => {
        /* non-fatal */
      });
    }

    // Bubble shows only what the user typed; API may get a steering prefix.
    const userMsg: Message = {
      id: createId(),
      role: "user",
      content: displayText,
      attachments: atts.length ? atts : undefined,
      createdAt: Date.now(),
    };
    const apiUserMsg: Message =
      apiText === displayText ? userMsg : { ...userMsg, content: apiText };
    const assistantId = createId();
    const assistantMsg: Message = {
      id: assistantId,
      role: "assistant",
      content: "",
      createdAt: Date.now(),
    };

    const prevMessages = existing?.messages ?? [];
    const history = [...prevMessages, apiUserMsg];
    const nextTitle =
      prevMessages.length === 0
        ? existing?.title && existing.title !== "New chat"
          ? existing.title
          : titleFromPrompt(displayText || "Image")
        : (existing?.title ?? "New chat");

    let convId = existing?.id ?? "";
    // Only rebind the visible project when the send targets the thread the user
    // is looking at; a background (queued/drain) send must not change it. A new
    // thread becomes active, so it may rebind.
    const rebindActiveProject = existing == null || existing.id === activeId;
    flushSync(() => {
      if (existing) {
        convId = existing.id;
        setThreads((prev) =>
          prev.map((c) =>
            c.id === existing.id
              ? {
                  ...c,
                  modelId: target.modelId,
                  title: nextTitle,
                  messages: [...c.messages, userMsg, assistantMsg],
                  updatedAt: Date.now(),
                  // Sending un-settles and unsnoozes the thread.
                  settledAt: null,
                  snoozedUntil: null,
                  lastError: null,
                  lastVisitedAt: Date.now(),
                }
              : c,
          ),
        );
      } else {
        const created = createThread(
          target.projectId,
          nextTitle,
          target.modelId,
        );
        const c: Thread = {
          ...created,
          messages: [userMsg, assistantMsg],
          updatedAt: Date.now(),
        };
        convId = c.id;
        sendingByThreadRef.current.add(convId);
        setThreads((prev) => [c, ...prev]);
        setActiveId(c.id);
      }
      if (rebindActiveProject) setActiveProjectId(target.projectId);
      if (clearComposer) {
        setDraft("");
        setAttachments([]);
        if (opts?.reviewCommentIds?.length) {
          const ids = new Set(opts.reviewCommentIds);
          setReviewComments((current) =>
            current.filter((comment) => !ids.has(comment.id)),
          );
        }
      }
      // Streaming clock starts in runStream (single source of truth).
    });
    sendingByThreadRef.current.add(convId);
    // Persist user turn immediately so history survives kill mid-stream.
    persistThreadsNow();

    try {
      await runStream({
        convId,
        history,
        assistantId,
        project: projectForSend,
        worktreePath: existing?.worktreePath ?? null,
      });
    } finally {
      sendingByThreadRef.current.delete(convId);
    }
  };

  const handleSend = async (override?: string) => {
    if (notifyCompleteRef.current || notifyErrorRef.current) {
      void ensureNotifyPermission();
    }
    const text = (override ?? draft).trim();
    // Defense in depth: slash lines are handled in Composer and must not hit the API.
    if (text.startsWith("/") && !text.includes("\n")) return;
    const atts = override != null ? [] : attachments;
    const comments = override == null ? activeReviewComments : [];
    const displayText =
      text || comments.map((comment) => comment.body.trim()).filter(Boolean).join("\n\n");
    const apiText = appendReviewComments(text, comments);
    await handleSendPayload(displayText, atts, {
      apiText,
      reviewCommentIds: comments.map((comment) => comment.id),
    });
  };

  const handleQueue = () => {
    if (!activeId || !activeStreaming) return;
    const text = draft.trim();
    // Slash commands are local UI actions — never queue them as chat turns.
    if (text.startsWith("/") && !text.includes("\n")) return;
    const comments = activeReviewComments;
    if (!text && attachments.length === 0 && comments.length === 0) return;
    const displayText =
      text || comments.map((comment) => comment.body.trim()).filter(Boolean).join("\n\n");
    const apiText = appendReviewComments(text, comments);
    setSendQueue((q) => [
      ...q,
      createQueuedSend(activeId, displayText, attachments, apiText, comments),
    ]);
    setDraft("");
    setAttachments([]);
    if (comments.length) {
      const ids = new Set(comments.map((comment) => comment.id));
      setReviewComments((current) =>
        current.filter((comment) => !ids.has(comment.id)),
      );
    }
    toast.info("Queued - sends when ready");
  };

  /** Pull a queued item back into the composer so the user can edit it. */
  const handleEditQueued = async (id: string) => {
    if (!activeId) return;
    const targetThreadId = activeId;
    const item =
      sendQueueRef.current.find(
        (q) => q.id === id && q.threadId === targetThreadId,
      ) ?? null;
    if (!item) return;

    const pendingText = draft.trim();
    const pendingAtts = attachments.length;
    const pendingComments = activeReviewComments.length;
    if (pendingText || pendingAtts > 0 || pendingComments > 0) {
      const ok = await requestConfirmDialog(
        "Replace the current draft, attachments, and review comments with this queued message?",
      );
      if (!ok) return;
    }
    if (
      activeIdRef.current !== targetThreadId ||
      !sendQueueRef.current.some(
        (queued) => queued.id === id && queued.threadId === targetThreadId,
      )
    ) {
      return;
    }

    // Drop from queue (and any Send-now priority pointer to the same item).
    setSendQueue((q) => removeQueued(q, id));
    const pri = prioritySendByThreadRef.current.get(targetThreadId);
    if (pri?.id === id) prioritySendByThreadRef.current.delete(targetThreadId);

    setDraft(queuedComposerDraft(item));
    setAttachments(item.attachments.length ? [...item.attachments] : []);
    setReviewComments((current) => [
      ...current.filter((comment) => comment.threadId !== targetThreadId),
      ...(item.reviewComments ?? []),
    ]);
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        const el = document.querySelector<HTMLTextAreaElement>(
          "textarea.composer__input",
        );
        if (!el) return;
        el.focus();
        const end = el.value.length;
        try {
          el.setSelectionRange(end, end);
        } catch {
          /* ignore */
        }
      });
    });
  };

  /** Cut across the live agent, keep partial turn, send this queue item now. */
  const handleSendNowQueued = async (id: string) => {
    if (!activeId) return;
    const item =
      sendQueueRef.current.find(
        (q) => q.id === id && q.threadId === activeId,
      ) ?? null;
    if (!item) return;
    setSendQueue((q) => removeQueued(q, id));
    prioritySendByThreadRef.current.delete(activeId);

    if (!streamingThreadIdsRef.current.includes(activeId)) {
      void (async () => {
        const before = threadsRef.current.find((t) => t.id === activeId);
        const msgCount = before?.messages.length ?? 0;
        await handleSendPayload(item.text, item.attachments, {
          clearComposer: false,
          threadId: activeId,
          apiText: item.apiText,
        });
        // Same safety net as the drain path: if the send never claimed the
        // thread (signed out / busy guard), put the item back instead of
        // silently dropping it.
        const after = threadsRef.current.find((t) => t.id === activeId);
        const grew = (after?.messages.length ?? 0) > msgCount;
        const claimed =
          sendingByThreadRef.current.has(activeId) ||
          streamingThreadIdsRef.current.includes(activeId);
        if (!grew && !claimed) {
          setSendQueue((q) => {
            if (q.some((x) => x.id === item.id)) return q;
            return [...q, item];
          });
        }
      })();
      return;
    }

    prioritySendByThreadRef.current.set(activeId, item);
    await handleStop(activeId, { mode: "send-now" });
    toast.info("Sending now");
  };

  const handleStash = async () => {
    if (stashBusyRef.current) return;
    stashBusyRef.current = true;
    const composerOwner = {
      activeId: activeIdRef.current,
      epoch: composerEpochRef.current,
    };
    const prompt = draft;
    const sourceAttachments = attachments;
    let prepared: Awaited<ReturnType<typeof prepareStashAttachments>>;
    try {
      prepared = await prepareStashAttachments(sourceAttachments);
    } catch {
      toast.error("Could not prepare images for stash");
      return;
    } finally {
      stashBusyRef.current = false;
    }
    const { entry, written, evicted } = stashPrompt(
      prompt,
      prepared.attachments,
      prepared.droppedNames,
    );
    if (!written || !entry) {
      toast.error("Could not stash prompt");
      return;
    }
    setStashEntries(loadStash());
    if (
      !canClearStashedComposer({
        owner: composerOwner,
        activeId: activeIdRef.current,
        epoch: composerEpochRef.current,
        capturedDraft: prompt,
        currentDraft: draftRef.current,
        capturedAttachmentIds: sourceAttachments.map(
          (attachment) => attachment.id,
        ),
        currentAttachmentIds: attachmentsRef.current.map(
          (attachment) => attachment.id,
        ),
      })
    ) {
      return;
    }
    setDraft((current) => (current === prompt ? "" : current));
    const sourceIds = new Set(
      sourceAttachments.map((attachment) => attachment.id),
    );
    setAttachments((current) =>
      current.filter((attachment) => !sourceIds.has(attachment.id)),
    );
    if (entry.droppedNames.length) {
      toast.info(
        `Stashed without ${entry.droppedNames.length} image${entry.droppedNames.length === 1 ? "" : "s"} that could not fit`,
      );
    } else {
      toast.info(evicted ? "Stashed (oldest dropped)" : "Stashed");
    }
  };

  const handleRestoreStash = (id: string) => {
    const candidate = loadStash().find((entry) => entry.id === id);
    if (!candidate) return;
    const mergedAttachments = mergeStashAttachments(
      attachments,
      candidate.attachments,
    );
    if (!mergedAttachments) {
      toast.error("Remove some composer images before restoring this stash");
      return;
    }
    const result = takeStashEntry(id);
    setStashEntries(loadStash());
    if (!result.removed) {
      toast.error("Could not remove the stashed prompt from storage");
      return;
    }
    const entry = result.entry;
    if (!entry) return;
    // Append prompt if composer already has text; image-only keeps text.
    setDraft((current) => {
      if (!entry.prompt) return current;
      const cur = current.trim();
      if (!cur) return entry.prompt;
      return `${current.replace(/\s+$/, "")}\n\n${entry.prompt}`;
    });
    setAttachments(mergedAttachments);
    if (entry.droppedNames.length) {
      toast.info("Some large images were not kept in stash");
    }
  };

  const handleRemoveStash = (id: string) => {
    if (!removeStashEntry(id)) {
      toast.error("Could not delete the stashed prompt");
    }
    setStashEntries(loadStash());
  };

  useEffect(() => {
    const pending = drainAfterRef.current;
    if (pending.length === 0) return;
    const still: string[] = [];
    const launched: Array<{
      threadId: string;
      text: string;
      apiText?: string;
      attachments: ImageAttachment[];
      /** Put back on queue if send no-ops (auth / busy). */
      requeue?: QueuedSend;
    }> = [];
    let restQueue = sendQueueRef.current;
    for (const threadId of pending) {
      if (
        streamingThreadIds.includes(threadId) ||
        sendingByThreadRef.current.has(threadId)
      ) {
        still.push(threadId);
        continue;
      }
      const target = resolveSendTarget(
        threadsRef.current,
        threadId,
        activeProjectId,
        modelId,
      );
      const targetProject = target
        ? findSendTargetProject(projects, target)
        : null;
      const targetWorkspacePath = target
        ? resolveWorkspacePath(
            targetProject?.path,
            target.existing?.worktreePath,
          )
        : null;
      const targetProviderAvailable = target
        ? sendTargetAvailability(target)
        : false;
      if (
        target?.provider === "opencode" &&
        openCodeEnabled &&
        !openCodeUpdatingRef.current &&
        targetWorkspacePath &&
        !targetProviderAvailable &&
        !openCodeStatusByWorkspaceRef.current.has(targetWorkspacePath)
      ) {
        void checkOpenCodeWorkspace(targetWorkspacePath).catch(() => undefined);
      }
      if (!target || !targetProviderAvailable) {
        still.push(threadId);
        continue;
      }
      const priority = prioritySendByThreadRef.current.get(threadId);
      if (priority) {
        prioritySendByThreadRef.current.delete(threadId);
        restQueue = removeQueued(restQueue, priority.id);
        launched.push({
          threadId,
          // Display = original queue text; API gets interrupt steer only.
          text: priority.text,
          apiText: followUpAfterInterrupt(priority.apiText ?? priority.text),
          attachments: priority.attachments,
          requeue: priority,
        });
        continue;
      }
      const { next, rest } = takeNextForThread(restQueue, threadId);
      if (!next) continue;
      restQueue = rest;
      launched.push({
        threadId,
        text: next.text,
        apiText: next.apiText,
        attachments: next.attachments,
        requeue: next,
      });
    }
    drainAfterRef.current = still;
    if (launched.length === 0) return;
    setSendQueue(restQueue);
    for (const item of launched) {
      void (async () => {
        const before = threadsRef.current.find((t) => t.id === item.threadId);
        const msgCount = before?.messages.length ?? 0;
        await handleSendPayload(item.text, item.attachments, {
          clearComposer: false,
          threadId: item.threadId,
          apiText: item.apiText,
        });
        // If send never claimed the thread (auth / busy), put the item back.
        const after = threadsRef.current.find((t) => t.id === item.threadId);
        const grew = (after?.messages.length ?? 0) > msgCount;
        const claimed =
          sendingByThreadRef.current.has(item.threadId) ||
          streamingThreadIdsRef.current.includes(item.threadId);
        if (!grew && !claimed && item.requeue) {
          setSendQueue((q) => {
            if (q.some((x) => x.id === item.requeue!.id)) return q;
            return [...q, item.requeue!];
          });
        }
      })();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- drain once after stream id clears
  }, [
    streamingThreadIds,
    providerAvailability,
    openCodeReadinessEpoch,
    openCodeUpdating,
    checkOpenCodeWorkspace,
  ]);

  /** Edit user message: truncate after it, put text in draft. */
  const handleEditUser = async (messageId: string) => {
    if (!activeId || activeStreaming) return;
    const targetThreadId = activeId;
    const thread = threads.find((t) => t.id === targetThreadId);
    if (!thread) return;
    const idx = thread.messages.findIndex((m) => m.id === messageId);
    if (idx < 0) return;
    const msg = thread.messages[idx];
    if (msg.role !== "user") return;

    // Don't clobber an in-progress draft the user typed after the message.
    const pendingText = draft.trim();
    const pendingAtts = attachments.length;
    if (pendingText || pendingAtts > 0) {
      const ok = await requestConfirmDialog(
        "Replace the current composer draft with this message?",
      );
      if (!ok) return;
    }

    if (activeIdRef.current !== targetThreadId) return;
    const currentThread = threadsRef.current.find(
      (candidate) => candidate.id === targetThreadId,
    );
    const currentIndex =
      currentThread?.messages.findIndex(
        (message) => message.id === messageId && message.role === "user",
      ) ?? -1;
    if (!currentThread || currentIndex < 0) return;
    const currentMessage = currentThread.messages[currentIndex];
    if (!currentMessage) return;

    setDraft(stripFollowUpInterruptNote(currentMessage.content));
    setAttachments(currentMessage.attachments ? [...currentMessage.attachments] : []);
    updateThread(targetThreadId, (c) => ({
      ...c,
      messages: c.messages.slice(0, currentIndex),
      // Clear any prior stream error; user is rewriting this turn.
      lastError: null,
      updatedAt: Date.now(),
    }));
    // Focus composer after React paints the restored draft.
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        const el = document.querySelector<HTMLTextAreaElement>(
          "textarea.composer__input",
        );
        if (!el) return;
        el.focus();
        const end = el.value.length;
        try {
          el.setSelectionRange(end, end);
        } catch {
          /* ignore */
        }
      });
    });
    toast.info("Editing — send to resubmit");
  };

  /** Fork at a user message without mutating the source thread. */
  const handleForkUser = async (messageId: string) => {
    const sourceId = activeIdRef.current;
    if (!sourceId || activeStreaming) return;
    if (
      streamingThreadIdsRef.current.includes(sourceId) ||
      sendingByThreadRef.current.has(sourceId)
    ) {
      return;
    }
    const source = threadsRef.current.find((thread) => thread.id === sourceId);
    if (!source) return;
    const selected = source.messages.find(
      (message) => message.id === messageId && message.role === "user",
    );
    if (!selected) return;
    if (draft.trim() || attachments.length > 0) {
      const replace = await requestConfirmDialog(
        "Replace the current composer draft with the forked message?",
      );
      if (!replace) return;
    }

    if (
      activeIdRef.current !== sourceId ||
      streamingThreadIdsRef.current.includes(sourceId) ||
      sendingByThreadRef.current.has(sourceId)
    ) {
      return;
    }
    const currentSource = threadsRef.current.find(
      (thread) => thread.id === sourceId,
    );
    const currentSelected = currentSource?.messages.find(
      (message) => message.id === messageId && message.role === "user",
    );
    if (!currentSource || !currentSelected) return;

    const fork = forkThreadAtMessage(currentSource, messageId);
    if (!fork) return;
    setThreads((previous) => [fork, ...previous]);
    setActiveId(fork.id);
    setActiveProjectId(fork.projectId);
    if (fork.modelId) {
      setModelId(fork.modelId);
      setThinking((current) => thinkingForModel(fork.modelId!, current));
    }
    setDraft(stripFollowUpInterruptNote(currentSelected.content));
    setAttachments(
      currentSelected.attachments?.map((attachment) => ({
        ...attachment,
        id: createId(),
      })) ?? [],
    );
    setRenaming(false);
    window.setTimeout(() => persistThreadsNow(), 0);
    window.requestAnimationFrame(() => {
      const composer = document.querySelector<HTMLTextAreaElement>(
        "textarea.composer__input",
      );
      composer?.focus();
    });
    toast.info("Forked to a new chat — edit and send when ready");
  };

  /** Retry from a user message: drop that turn onward and resend. */
  const handleRetryUser = async (messageId: string) => {
    if (!activeId || activeStreaming) return;
    const target = resolveSendTarget(
      threadsRef.current,
      activeId,
      activeProjectId,
      modelId,
    );
    const thread = target?.existing;
    if (!target || !thread) return;
    if (!sendTargetAvailability(target)) {
      requestProviderLogin(target.provider);
      return;
    }
    const idx = thread.messages.findIndex((m) => m.id === messageId);
    if (idx < 0) return;
    const msg = thread.messages[idx];
    if (msg.role !== "user") return;

    if (
      streamingThreadIdsRef.current.includes(activeId) ||
      sendingByThreadRef.current.has(activeId) ||
      worktreeDeleteBusyRef.current.has(activeId)
    ) {
      return;
    }
    sendingByThreadRef.current.add(activeId);

    const assistantId = createId();
    const assistantMsg: Message = {
      id: assistantId,
      role: "assistant",
      content: "",
      createdAt: Date.now(),
    };
    const history = [...thread.messages.slice(0, idx + 1)];
    updateThread(activeId, (c) => ({
      ...c,
      modelId: target.modelId,
      messages: [...history, assistantMsg],
      lastError: null,
      updatedAt: Date.now(),
    }));

    const projectForSend = findSendTargetProject(projects, target);

    try {
      await runStream({
        convId: activeId,
        history,
        assistantId,
        project: projectForSend,
        worktreePath: thread.worktreePath ?? null,
      });
    } finally {
      sendingByThreadRef.current.delete(activeId);
    }
  };

  /** Regenerate last assistant reply. */
  const handleRegenerate = async (messageId: string) => {
    if (!activeId || activeStreaming) return;
    const target = resolveSendTarget(
      threadsRef.current,
      activeId,
      activeProjectId,
      modelId,
    );
    const thread = target?.existing;
    if (!target || !thread) return;
    if (!sendTargetAvailability(target)) {
      requestProviderLogin(target.provider);
      return;
    }
    const idx = thread.messages.findIndex((m) => m.id === messageId);
    if (idx < 0 || thread.messages[idx].role !== "assistant") return;

    const history = thread.messages.slice(0, idx);
    const lastUser = [...history].reverse().find((m) => m.role === "user");
    if (!lastUser) {
      toast.error("Nothing to regenerate");
      return;
    }

    if (
      streamingThreadIdsRef.current.includes(activeId) ||
      sendingByThreadRef.current.has(activeId) ||
      worktreeDeleteBusyRef.current.has(activeId)
    ) {
      return;
    }
    sendingByThreadRef.current.add(activeId);

    const assistantId = createId();
    const assistantMsg: Message = {
      id: assistantId,
      role: "assistant",
      content: "",
      createdAt: Date.now(),
    };

    updateThread(activeId, (c) => ({
      ...c,
      modelId: target.modelId,
      messages: [...history, assistantMsg],
      lastError: null,
      updatedAt: Date.now(),
    }));

    const projectForSend = findSendTargetProject(projects, target);

    try {
      await runStream({
        convId: activeId,
        history,
        assistantId,
        project: projectForSend,
        worktreePath: thread.worktreePath ?? null,
      });
    } finally {
      sendingByThreadRef.current.delete(activeId);
    }
  };

  const openActiveProjectIn = useCallback(
    async (target: OpenInTarget, label: string) => {
      const path = activeWorkspacePath?.trim() || activeProject?.path?.trim();
      if (!path) {
        toast.info("No project open");
        return;
      }
      try {
        await openProjectIn(path, target);
      } catch (e) {
        toast.error(safeErrorMessage(e, `Could not open ${label}.`));
      }
    },
    [activeWorkspacePath, activeProject?.path, toast],
  );

  const toggleTerminal = useCallback(() => {
    setTerminalOpen((v) => !v);
  }, []);

  const paletteActions = useMemo<PaletteAction[]>(
    () => [
      {
        id: "new",
        label: "New chat",
        hint: "Cmd+N",
        group: "Actions",
        run: () => handleNew(activeProjectId),
      },
      {
        id: "new-worktree",
        label: "New task in worktree",
        hint: "Isolated branch",
        group: "Actions",
        run: () => void handleNewInWorktree(activeProjectId),
      },
      {
        id: "search",
        label: "Search chats",
        group: "Actions",
        run: handleFocusSearch,
      },
      {
        id: "go-file",
        label: "Go to file",
        hint: "Ctrl+P",
        group: "Actions",
        run: () => {
          setPaletteOpen(false);
          setFilePickerOpen(true);
        },
      },
      {
        id: "sidebar",
        label: effectiveSidebarOpen ? "Collapse sidebar" : "Expand sidebar",
        hint: "Cmd+B",
        group: "Actions",
        run: toggleEffectiveSidebar,
      },
      {
        id: "toggle-terminal",
        label: terminalOpen ? "Hide terminal" : "Show terminal",
        hint: "Ctrl+`",
        group: "Actions",
        run: () => toggleTerminal(),
      },
      {
        id: "settings",
        label: "Open settings",
        hint: "Cmd+,",
        group: "Actions",
        run: openSettings,
      },
      {
        id: "usage",
        label: "Open usage",
        group: "Actions",
        run: openUsage,
      },
      {
        id: "right-panel",
        label: rightPanelOpen ? "Hide right panel" : "Show right panel",
        group: "Actions",
        run: () => toggleRightPanel(),
      },
      {
        id: "right-panel-browser",
        label: "Open Browser page",
        group: "Actions",
        run: () => openRightPanelPage("browser"),
      },
      {
        id: "right-panel-review",
        label: "Open Review page",
        group: "Actions",
        run: () => openRightPanelPage("review"),
      },
      {
        id: "right-panel-files",
        label: "Open Files page",
        group: "Actions",
        run: () => openRightPanelPage("files"),
      },
      {
        id: "agent-plan",
        label:
          agentMode === "plan" ? "Agent: Plan (active)" : "Switch to Plan mode",
        group: "Agent",
        run: () => {
          setAgentMode("plan");
          toast.info("Agent: Plan");
        },
      },
      {
        id: "agent-build",
        label:
          agentMode === "build"
            ? "Agent: Build (active)"
            : "Switch to Build mode",
        group: "Agent",
        run: () => {
          setAgentMode("build");
          toast.info("Agent: Build");
        },
      },
      {
        id: "permission-auto",
        label:
          permissionMode === "auto"
            ? "Permission: Auto (active)"
            : "Permission: Auto (run tools immediately)",
        group: "Agent",
        run: () => {
          setPermissionMode("auto");
          toast.info("Permission: Auto");
        },
      },
      {
        id: "permission-ask",
        label:
          permissionMode === "ask"
            ? activeModelProvider === "antigravity"
              ? "Permission: Ask (unsupported by Antigravity)"
              : activeModelProvider === "openai"
              ? "Permission: Read-only (active)"
              : "Permission: Ask (active)"
            : activeModelProvider === "antigravity"
              ? "Permission: Ask (unsupported by Antigravity)"
              : activeModelProvider === "openai"
              ? "Permission: Read-only (disable mutations)"
              : "Permission: Ask (approve bash & edits)",
        group: "Agent",
        run: () => {
          if (activeModelProvider === "antigravity") {
            toast.info("Antigravity headless mode supports Auto or Plan, not interactive Ask");
            return;
          }
          setPermissionMode("ask");
          toast.info(
            activeModelProvider === "openai"
              ? "Permission: Read-only"
              : "Permission: Ask",
          );
        },
      },
      {
        id: "undo-last-turn",
        label: "Undo last agent turn (files)",
        group: "Agent",
        run: () => {
          void handleUndoSnapshots("turn");
        },
      },
      {
        id: "profile",
        label: "Open profile",
        group: "Actions",
        run: openProfile,
      },
      {
        id: "theme-toggle",
        label: "Toggle dark / light",
        group: "Appearance",
        run: () =>
          setTheme((t) => {
            return resolveTheme(t) === "dark" ? "light" : "dark";
          }),
      },
      {
        id: "theme-system",
        label: "Use system theme",
        group: "Appearance",
        run: () => setTheme("system"),
      },
      {
        id: "add-project",
        label: "Add project from disk",
        group: "Projects",
        run: () => void handleAddProject(),
      },
      ...(activeProject
        ? ([
            {
              id: "review-git",
              label: "Review working tree (Git)",
              group: "Projects",
              run: () => openReviewPanel("git"),
            },
            {
              id: "open-explorer",
              label: "Open in File Explorer",
              group: "Projects",
              run: () => void openActiveProjectIn("explorer", "File Explorer"),
            },
            {
              id: "open-terminal",
              label: "Open in Terminal",
              group: "Projects",
              run: () => void openActiveProjectIn("terminal", "Terminal"),
            },
            {
              id: "open-git-bash",
              label: "Open in Git Bash",
              group: "Projects",
              run: () => void openActiveProjectIn("gitBash", "Git Bash"),
            },
            {
              id: "open-wsl",
              label: "Open in WSL",
              group: "Projects",
              run: () => void openActiveProjectIn("wsl", "WSL"),
            },
          ] satisfies PaletteAction[])
        : []),
      {
        id: "auth-grok",
        label: auth.signedIn ? "Sign out of Grok" : "Sign in with SuperGrok",
        group: "Account",
        run: () => (auth.signedIn ? void handleLogout() : void handleLogin()),
      },
      {
        id: "auth-openai",
        label: openaiAuth.signedIn
          ? "Sign out of OpenAI"
          : "Sign in with OpenAI",
        group: "Account",
        run: () =>
          openaiAuth.signedIn
            ? void handleOpenAILogout()
            : void handleOpenAILogin(),
      },
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      activeProjectId,
      activeProject,
      effectiveSidebarOpen,
      toggleEffectiveSidebar,
      terminalOpen,
      toggleTerminal,
      auth.signedIn,
      openaiAuth.signedIn,
      openActiveProjectIn,
      openReviewPanel,
      rightPanelOpen,
      toggleRightPanel,
      openRightPanelPage,
      agentMode,
      activeModelProvider,
      permissionMode,
      handleUndoSnapshots,
      handleNewInWorktree,
      openSettings,
      openUsage,
      openProfile,
      toast,
    ],
  );

  // Stop via the latest handleStop: the keydown listener below only
  // re-registers when its deps change, and a stale closure would read a
  // pre-stream streamStartedAtById and drop the stopped turn's durationMs.
  const handleStopRef = useRef(handleStop);
  useEffect(() => {
    handleStopRef.current = handleStop;
  }, [handleStop]);

  useKeybindingDispatcher({
    keybindings,
    blocked:
      authModalProvider != null ||
      signInPickerOpen ||
      profileOpen ||
      settingsOpen ||
      usageOpen ||
      providersOpen,
    previewOpen,
    actions: {
      toggleSidebar: toggleEffectiveSidebar,
      toggleTerminal,
      toggleCommandPalette: () => {
        setFilePickerOpen(false);
        if (paletteOpen) {
          setPaletteOpen(false);
        } else {
          setPaletteView("root");
          setPaletteOpen(true);
        }
      },
      toggleFilePicker: () => {
        setPaletteOpen(false);
        setFilePickerOpen((value) => !value);
      },
      newChat: () => handleNew(activeProjectId),
      newChatInWorktree: () => void handleNewInWorktree(activeProjectId),
      openSettings,
      focusProjectSearch: handleFocusSearch,
      toggleDiff: () => {
        if (reviewOpen) closeRightPanel();
        else openRightPanelPage("review");
      },
      togglePreview: () => {
        if (previewOpen) closeRightPanel();
        else openRightPanelPage("browser");
      },
      toggleRightPanel,
      openRightPanelPage,
      toggleTheme: () =>
        setTheme((value) =>
          resolveTheme(value) === "dark" ? "light" : "dark",
        ),
      useSystemTheme: () => setTheme("system"),
      setPlanMode: () => {
        setAgentMode("plan");
        toast.info("Agent: Plan");
      },
      setBuildMode: () => {
        setAgentMode("build");
        toast.info("Agent: Build");
      },
      setPermissionAuto: () => {
        setPermissionMode("auto");
        toast.info("Permission: Auto");
      },
      setPermissionAsk: () => {
        if (activeModelProvider === "antigravity") {
          toast.info(
            "Antigravity headless mode supports Auto or Plan, not interactive Ask",
          );
          return;
        }
        setPermissionMode("ask");
        toast.info(
          activeModelProvider === "openai"
            ? "Permission: Read-only"
            : "Permission: Ask",
        );
      },
      openProfile,
      addProject: () => void handleAddProject(),
      undoLastTurn: () => void handleUndoSnapshots("turn"),
      dismiss: () => {
        if (filePickerOpen) setFilePickerOpen(false);
        else if (paletteOpen) setPaletteOpen(false);
        else if (terminalOpen) setTerminalOpen(false);
        else if (rightPanelOpen) closeRightPanel();
        else if (activeId && streamingThreadIdsRef.current.includes(activeId)) {
          void handleStopRef.current(activeId);
        }
      },
      emitCommand: emitKeybindingCommand,
    },
  });

  const settledThreadNotice = activeSettled ? (
    <div className="thread-settled-note" role="status">
      <span className="thread-settled-note__mark" aria-hidden>
        <CircleCheck size={14} strokeWidth={1.9} />
      </span>
      <span className="thread-settled-note__copy">
        <strong>Settled</strong>
        <span>History stays here. Send a message to wake this chat.</span>
      </span>
      <button
        type="button"
        className="thread-settled-note__wake"
        onClick={() => active && handleUnsettle(active.id)}
      >
        Wake
      </button>
    </div>
  ) : null;

  return (
    <div
      className={`shell${archivingAll ? " is-archiving-all" : ""}${bootRevealStarted ? " is-booted" : " is-booting"}${activeStreaming ? " is-streaming" : ""}`}
      style={{ ["--sidebar-width" as string]: `${sidebarWidth}px` }}
    >
      <BootSplash
        ready={storeReady}
        onExitStart={handleBootExitStart}
      />
      {archivingAll ? (
        <div className="archive-vortex" role="status" aria-live="polite">
          <div className="archive-vortex__veil" aria-hidden />
          <div className="archive-vortex__core" aria-hidden>
            <span className="archive-vortex__ring archive-vortex__ring--a" />
            <span className="archive-vortex__ring archive-vortex__ring--b" />
            <span className="archive-vortex__ring archive-vortex__ring--c" />
            <span className="archive-vortex__hole" />
          </div>
          <div className="archive-vortex__shards" aria-hidden>
            {Array.from({ length: 24 }, (_, i) => (
              <span
                key={i}
                className="archive-vortex__shard"
                style={{ ["--shard-i" as string]: i }}
              />
            ))}
          </div>
          <p className="archive-vortex__label">Archiving chats…</p>
        </div>
      ) : null}
      <SidebarV2
        open={effectiveSidebarOpen}
        width={sidebarWidth}
        onWidthChange={setSidebarWidth}
        onOpenChange={setEffectiveSidebarOpen}
        keybindings={keybindings}
        projects={projects}
        threads={threads}
        activeId={activeId}
        activeProjectId={activeProjectId}
        query={query}
        onQueryChange={setQuery}
        searchOpen={sidebarSearchOpen}
        onSearchOpenChange={(next) => {
          setSidebarSearchOpen(next);
          if (!next) setQuery("");
        }}
        onSelectThread={(id) => {
          handleSelectThread(id);
          if (isNarrowViewport) setMobileSidebarOpen(false);
        }}
        onSelectProject={(projectId) => {
          handleProjectSelection(projectId);
          if (isNarrowViewport) setMobileSidebarOpen(false);
        }}
        onNewThread={(projectId) => {
          handleNew(projectId);
          if (isNarrowViewport) setMobileSidebarOpen(false);
        }}
        onOpenNewThreadProjectPicker={openNewThreadProjectPicker}
        onNewThreadInWorktree={(id) => void handleNewInWorktree(id)}
        worktreeCreateBusy={worktreeCreateBusy}
        onDeleteThread={handleDelete}
        onCopyThreadId={handleCopyThreadId}
        onRenameThread={handleRename}
        onSettleThread={handleSettle}
        onUnsettleThread={handleUnsettle}
        onArchiveThread={handleArchive}
        onPinThread={handlePin}
        onSnoozeThread={handleSnooze}
        onUnsnoozeThread={handleUnsnooze}
        onAddProject={() => void handleAddProject()}
        onRemoveProject={(id) => void handleRemoveProject(id)}
        onToggleProject={handleToggleProject}
        auth={auth}
        authBusy={authBusy}
        openaiAuth={openaiAuth}
        openaiAuthBusy={openaiAuthBusy}
        userProfile={userProfile}
        onOpenSignIn={() => setSignInPickerOpen(true)}
        onLogout={() => void handleLogout()}
        onOpenAILogout={() => void handleOpenAILogout()}
        onOpenSettings={openSettings}
        onOpenUsage={openUsage}
        onOpenProviders={openProviders}
        onOpenProfile={openProfile}
        workingThreadIds={streamingThreadIds}
        workingStartedAtById={streamStartedAtById}
        attentionByThreadId={attentionByThreadId}
      />

      <main
        className={`inset${isEmpty ? " inset--hero" : " inset--chat"}${effectiveSidebarOpen ? "" : " inset--rail-collapsed"}${reviewOpen ? " inset--review-open" : ""}${previewOpen ? " inset--preview-open" : ""}${filesOpen ? " inset--files-open" : ""}${rightPanelOpen ? " inset--right-open" : ""}${terminalOpen ? " inset--terminal-open" : ""}${compacting ? " is-compacting" : ""}`}
      >
        <div className="inset__center">
          {compacting ? (
            <div className="compact-fx" role="status" aria-live="polite">
              <div className="compact-fx__veil" aria-hidden />
              <div className="compact-fx__core" aria-hidden>
                <span className="compact-fx__ring compact-fx__ring--a" />
                <span className="compact-fx__ring compact-fx__ring--b" />
                <span className="compact-fx__orb" />
                <span className="compact-fx__fold compact-fx__fold--1" />
                <span className="compact-fx__fold compact-fx__fold--2" />
                <span className="compact-fx__fold compact-fx__fold--3" />
                <span className="compact-fx__fold compact-fx__fold--4" />
              </div>
              <p className="compact-fx__label">Compacting context…</p>
            </div>
          ) : null}
          <SidebarFloatingControls
            open={effectiveSidebarOpen}
            onToggle={toggleEffectiveSidebar}
            onNew={() => handleNew(activeProjectId)}
            onFocusSearch={handleFocusSearch}
          />

          {/* Empty / hero: no topbar — floating right-panel toggle. */}
          {isEmpty ? (
            <div className="right-panel-float">
              <TerminalToggle open={terminalOpen} onToggle={toggleTerminal} />
              <RightPanelToggle
                open={rightPanelOpen}
                onToggle={toggleRightPanel}
                badge={rightPanelBadge}
              />
            </div>
          ) : null}

          {!isEmpty ? (
            <header className="topbar">
              <div className="topbar__stack">
                {renaming ? (
                  <input
                    className="topbar__rename"
                    value={renameDraft}
                    autoFocus
                    onChange={(e) => setRenameDraft(e.target.value)}
                    onBlur={commitTopbarRename}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        commitTopbarRename();
                      }
                      if (e.key === "Escape") {
                        setRenaming(false);
                      }
                    }}
                  />
                ) : (
                  <button
                    type="button"
                    className="topbar__title topbar__title-btn"
                    title="Double-click to rename"
                    onDoubleClick={() => {
                      setRenameDraft(active?.title ?? "");
                      setRenaming(true);
                    }}
                  >
                    {activeProject ? (
                      <span
                        className="topbar__crumb"
                        title={activeWorkspacePath ?? activeProject.path}
                      >
                        <span className="topbar__project">
                          {activeProject.name}
                        </span>
                        <span className="topbar__sep" aria-hidden>
                          /
                        </span>
                      </span>
                    ) : null}
                    <span className="topbar__thread">
                      {active?.title ?? "New chat"}
                    </span>
                    {active?.worktreeBranch || active?.worktreePath ? (
                      <span
                        className="topbar__worktree"
                        title={
                          active.worktreePath
                            ? `Worktree: ${active.worktreePath}`
                            : undefined
                        }
                      >
                        {active.worktreeBranch ?? "worktree"}
                      </span>
                    ) : null}
                  </button>
                )}
              </div>
              <div className="topbar__actions">
                {activeWorkspacePath || activeProject ? (
                  <OpenInControls
                    projectPath={activeWorkspacePath ?? activeProject!.path}
                    onError={(message) => toast.error(message)}
                  />
                ) : null}
                <TerminalToggle open={terminalOpen} onToggle={toggleTerminal} />
                <RightPanelToggle
                  open={rightPanelOpen}
                  onToggle={toggleRightPanel}
                  badge={rightPanelBadge}
                />
              </div>
            </header>
          ) : null}

          {isEmpty ? (
            <div className="hero-stage">
              <div className="hero-stage__center">
                <Welcome
                  projects={projects}
                  projectId={activeProjectId}
                  projectName={activeProject?.name}
                  onSelectProject={handleProjectSelection}
                  onAddProject={() => void handleAddProject()}
                />
                {projects.length > 0 ? (
                  <div className="hero-stage__composer">
                    {settledThreadNotice}
                    <Composer
                      value={draft}
                      onChange={setDraft}
                      onSubmit={() => void handleSend()}
                      onStop={handleStop}
                      onQueue={handleQueue}
                      streaming={activeStreaming}
                      autoFocus
                      signedIn={activeProviderSignedIn}
                      signedOutPlaceholder={
                        activeModelProvider === "openai"
                          ? "Sign in with OpenAI to use GPT models..."
                          : activeModelProvider === "antigravity"
                            ? "Install or sign in to Google Antigravity CLI..."
                            : activeModelProvider === "opencode"
                              ? "Connect an upstream provider in OpenCode..."
                              : "Sign in with SuperGrok to chat..."
                      }
                      onRequestLogin={requestActiveProviderLogin}
                      placeholder={
                        activeProject
                          ? `Ask about ${activeProject.name}...`
                          : "Ask anything..."
                      }
                      modelId={modelId}
                      thinking={thinking}
                      fastMode={openaiFastMode}
                      accessMode={accessMode}
                      agentMode={agentMode}
                      permissionMode={permissionMode}
                      keybindings={keybindings}
                      providerAvailability={modelSelectionAvailability}
                      lockedProvider={activeLockedProvider}
                      onModelChange={handleModelChange}
                      onThinkingChange={setThinking}
                      onFastModeChange={setOpenAIFastMode}
                      onAccessModeChange={setAccessMode}
                      onAgentModeChange={setAgentMode}
                      onPermissionModeChange={setPermissionMode}
                      pendingApprovals={pendingApprovals}
                      approvalBusyId={approvalBusyId}
                      onApproveTool={(id) => void handleApproveTool(id)}
                      onDenyTool={(id) => void handleDenyTool(id)}
                      onApproveAllTools={() => void handleApproveAllTools()}
                      onDenyAllTools={() => void handleDenyAllTools()}
                      pendingUserInput={pendingUserInput}
                      userInputBusy={
                        activeId != null &&
                        userInputBusyByThread[activeId] ===
                          pendingUserInput?.requestId
                      }
                      onSubmitUserInput={(answers) =>
                        void handleSubmitUserInput(answers)
                      }
                      onRejectUserInput={() => void handleRejectUserInput()}
                      attachments={attachments}
                      onAttachmentsChange={setAttachments}
                      attachmentScopeId={activeId}
                      contextUsed={usage.used}
                      contextLimit={usage.limit}
                      sendQueue={
                        activeId ? queueForThread(sendQueue, activeId) : []
                      }
                      onRemoveQueued={(id) =>
                        setSendQueue((q) => removeQueued(q, id))
                      }
                      onEditQueued={handleEditQueued}
                      onSendNowQueued={handleSendNowQueued}
                      stashEntries={stashEntries}
                      onStash={handleStash}
                      onRestoreStash={handleRestoreStash}
                      onRemoveStash={handleRemoveStash}
                      liveFileChanges={composerFileChanges}
                      onOpenReviewChanges={() =>
                        openRightPanelPage("review")
                      }
                      reviewOpen={reviewOpen}
                      slashHandlers={slashHandlers}
                      projectPath={activeWorkspacePath}
                      reviewComments={activeReviewComments}
                      onRemoveReviewComment={(id) =>
                        setReviewComments((current) =>
                          current.filter((comment) => comment.id !== id),
                        )
                      }
                    />
                    {activeProject ? (
                      <ComposerContextStrip
                        worktreePath={active?.worktreePath}
                        branch={
                          active?.worktreeBranch ?? activeGitStatus?.branch
                        }
                        refs={activeGitRefs}
                        refsLoading={gitRefsLoading}
                        selectedBaseRef={activeWorktreeBaseRef}
                        gitLoading={gitLoading}
                        worktreeBusy={worktreeCreateBusy}
                        canCreateWorktree={
                          !worktreeCreateBusy && !active?.worktreePath
                        }
                        onCreateWorktree={() =>
                          void handleNewInWorktree(activeProject.id)
                        }
                        onRequestRefs={requestActiveGitRefs}
                        onSelectBaseRef={handleSelectWorktreeBaseRef}
                        onRefreshBranch={() => void refreshGit()}
                        onOpenChanges={() => openRightPanelPage("review")}
                      />
                    ) : null}
                  </div>
                ) : null}
              </div>
            </div>
          ) : (
            <>
              <MessageList
                messages={activeMessages}
                streaming={activeStreaming}
                streamStartedAt={activeStreaming ? activeStreamStartedAt : null}
                lastError={visibleActiveStreamError}
                collapseThinking={collapseThinking}
                onEditUser={handleEditUser}
                onRetryUser={(id) => void handleRetryUser(id)}
                onForkUser={handleForkUser}
                onRegenerate={(id) => void handleRegenerate(id)}
                onRetryError={
                  active?.lastError && !activeStreaming
                    ? () => {
                        const lastAsst = [...activeMessages]
                          .reverse()
                          .find((m) => m.role === "assistant");
                        if (lastAsst) void handleRegenerate(lastAsst.id);
                      }
                    : undefined
                }
                onDismissError={
                  activeId && visibleActiveStreamError
                    ? () =>
                        setStreamErrorDismissals((current) =>
                          dismissStreamError(
                            current,
                            activeId,
                            visibleActiveStreamError,
                          ),
                        )
                    : undefined
                }
                onOpenErrorSettings={openSettings}
                onApproveTool={(id) => void handleApproveTool(id)}
                onDenyTool={(id) => void handleDenyTool(id)}
                approvalBusyId={approvalBusyId}
                onOpenReviewChanges={() => openReviewPanel("turn")}
              />
              <div className="dock">
                {settledThreadNotice}
                <Composer
                  value={draft}
                  onChange={setDraft}
                  onSubmit={() => void handleSend()}
                  onStop={handleStop}
                  onQueue={handleQueue}
                  streaming={activeStreaming}
                  autoFocus
                  signedIn={activeProviderSignedIn}
                  signedOutPlaceholder={
                    activeModelProvider === "openai"
                      ? "Sign in with OpenAI to use GPT models..."
                      : activeModelProvider === "antigravity"
                        ? "Install or sign in to Google Antigravity CLI..."
                      : activeModelProvider === "opencode"
                        ? "Connect an upstream provider in OpenCode..."
                      : "Sign in with SuperGrok to chat..."
                  }
                  onRequestLogin={requestActiveProviderLogin}
                  placeholder={
                    activeProject
                      ? `Ask about ${activeProject.name}...`
                      : "Ask anything..."
                  }
                  modelId={modelId}
                  thinking={thinking}
                  fastMode={openaiFastMode}
                  accessMode={accessMode}
                  agentMode={agentMode}
                  permissionMode={permissionMode}
                  keybindings={keybindings}
                  providerAvailability={modelSelectionAvailability}
                  lockedProvider={activeLockedProvider}
                  onModelChange={handleModelChange}
                  onThinkingChange={setThinking}
                  onFastModeChange={setOpenAIFastMode}
                  onAccessModeChange={setAccessMode}
                  onAgentModeChange={setAgentMode}
                  onPermissionModeChange={setPermissionMode}
                  pendingApprovals={pendingApprovals}
                  approvalBusyId={approvalBusyId}
                  onApproveTool={(id) => void handleApproveTool(id)}
                  onDenyTool={(id) => void handleDenyTool(id)}
                  onApproveAllTools={() => void handleApproveAllTools()}
                  onDenyAllTools={() => void handleDenyAllTools()}
                  pendingUserInput={pendingUserInput}
                  userInputBusy={
                    activeId != null &&
                    userInputBusyByThread[activeId] === pendingUserInput?.requestId
                  }
                  onSubmitUserInput={(answers) => void handleSubmitUserInput(answers)}
                  onRejectUserInput={() => void handleRejectUserInput()}
                  attachments={attachments}
                  onAttachmentsChange={setAttachments}
                  attachmentScopeId={activeId}
                  contextUsed={usage.used}
                  contextLimit={usage.limit}
                  sendQueue={
                    activeId ? queueForThread(sendQueue, activeId) : []
                  }
                  onRemoveQueued={(id) =>
                    setSendQueue((q) => removeQueued(q, id))
                  }
                  onEditQueued={handleEditQueued}
                  onSendNowQueued={handleSendNowQueued}
                  stashEntries={stashEntries}
                  onStash={handleStash}
                  onRestoreStash={handleRestoreStash}
                  onRemoveStash={handleRemoveStash}
                  liveFileChanges={composerFileChanges}
                  onOpenReviewChanges={() => openRightPanelPage("review")}
                  reviewOpen={reviewOpen}
                  slashHandlers={slashHandlers}
                  projectPath={activeWorkspacePath}
                  reviewComments={activeReviewComments}
                  onRemoveReviewComment={(id) =>
                    setReviewComments((current) =>
                      current.filter((comment) => comment.id !== id),
                    )
                  }
                />
                {activeProject ? (
                  <ComposerContextStrip
                    worktreePath={active?.worktreePath}
                    branch={active?.worktreeBranch ?? activeGitStatus?.branch}
                    refs={activeGitRefs}
                    refsLoading={gitRefsLoading}
                    selectedBaseRef={activeWorktreeBaseRef}
                    gitLoading={gitLoading}
                    worktreeBusy={worktreeCreateBusy}
                    canCreateWorktree={
                      !worktreeCreateBusy && !active?.worktreePath
                    }
                    onCreateWorktree={() =>
                      void handleNewInWorktree(activeProject.id)
                    }
                    onRequestRefs={requestActiveGitRefs}
                    onSelectBaseRef={handleSelectWorktreeBaseRef}
                    onRefreshBranch={() => void refreshGit()}
                    onOpenChanges={() => openRightPanelPage("review")}
                  />
                ) : null}
              </div>
              {/* Bottom dock: the terminal is a sibling
                  after the composer so it never squeezes the chat timeline. */}
              <TerminalPanel
                open={terminalOpen}
                cwd={activeWorkspacePath ?? activeProject?.path ?? null}
                onClose={() => setTerminalOpen(false)}
                onOpenExternal={
                  activeWorkspacePath || activeProject
                    ? () => void openActiveProjectIn("terminal", "Terminal")
                    : undefined
                }
              />
            </>
          )}

          {isEmpty ? (
            <TerminalPanel
              open={terminalOpen}
              cwd={activeWorkspacePath ?? activeProject?.path ?? null}
              onClose={() => setTerminalOpen(false)}
              onOpenExternal={
                activeWorkspacePath || activeProject
                  ? () => void openActiveProjectIn("terminal", "Terminal")
                  : undefined
              }
            />
          ) : null}
        </div>

        <BrowserPreviewPanel
          open={previewOpen}
          workspacePath={activeWorkspacePath}
          suppressed={
            paletteOpen ||
            settingsOpen ||
            usageOpen ||
            providersOpen ||
            profileOpen ||
            authModalProvider != null ||
            signInPickerOpen
          }
          onClose={closeBrowserPreview}
          onPageChange={handleRightPanelPageChange}
          reviewStats={
            composerFileChanges && composerFileChanges.fileCount > 0
              ? {
                  fileCount: composerFileChanges.fileCount,
                  additions: composerFileChanges.additions,
                  deletions: composerFileChanges.deletions,
                }
              : null
          }
        />

        <ReviewChangesPanel
          open={reviewOpen}
          files={reviewFiles}
          scope={reviewScope}
          onScopeChange={(scope) => {
            setReviewScope(scope);
            if (scope === "git") {
              void refreshGit({ includeDiff: true });
            }
          }}
          diffStyle={reviewDiffStyle}
          onDiffStyleChange={setReviewDiffStyle}
          activePath={reviewActivePath}
          onSelectFile={setReviewActivePath}
          onClose={closeReviewChanges}
          streaming={activeStreaming && reviewScope !== "git"}
          gitStatus={activeGitStatus}
          gitLoading={gitLoading}
          gitBusy={gitBusy}
          onGitCommit={handleGitCommit}
          onGitPush={handleGitPush}
          onGitOpenPr={handleGitOpenPr}
          gitPrUrl={gitPrUrl}
          onGitRefresh={() =>
            void refreshGit({
              includeDiff: true,
            })
          }
          onPageChange={handleRightPanelPageChange}
          filesAvailable={Boolean(activeWorkspacePath ?? activeProject?.path)}
          filesMeta={activeProject?.name ?? null}
          canUndo={canUndoReview}
          undoBusy={undoBusy}
          onUndoChanges={() => void handleUndoReviewScope()}
          onAddComment={handleAddReviewComment}
        />

        <Suspense fallback={null}>
          <FilePreviewPanel
            open={filesOpen}
            workspacePath={activeWorkspacePath ?? activeProject?.path ?? null}
            projectName={activeProject?.name ?? null}
            reviewStats={
              composerFileChanges && composerFileChanges.fileCount > 0
                ? {
                    fileCount: composerFileChanges.fileCount,
                    additions: composerFileChanges.additions,
                    deletions: composerFileChanges.deletions,
                  }
                : null
            }
            onClose={closeFilePreview}
            onPageChange={handleRightPanelPageChange}
          />
        </Suspense>

      </main>

      {authModalProvider === "openai" ? (
        <AuthModal
          provider="openai"
          open
          loggingIn={openaiAuthBusy}
          device={openaiDeviceCode}
          error={authError}
          onCancel={handleCancelOpenAILogin}
          returnFocusRef={authReturnFocusRef}
        />
      ) : (
        <AuthModal
          provider="grok"
          open={authModalProvider === "grok"}
          loggingIn={authBusy}
          device={deviceCode}
          error={authError}
          onCancel={handleCancelLogin}
          returnFocusRef={authReturnFocusRef}
        />
      )}

      <SignInProviderModal
        open={signInPickerOpen}
        grokBusy={authBusy}
        openaiBusy={openaiAuthBusy}
        grokSignedIn={auth.signedIn}
        openaiSignedIn={openaiAuth.signedIn}
        onClose={() => setSignInPickerOpen(false)}
        onSelect={(provider) => {
          setSignInPickerOpen(false);
          if (provider === "grok") void handleLogin();
          else void handleOpenAILogin();
        }}
      />

      {settingsOpen ? (
        <SettingsLoadBoundary
          onError={() => {
            setSettingsOpen(false);
            toast.error("Could not load Settings. Restart Open Xiao and try again.");
          }}
        >
          <Suspense fallback={null}>
            <SettingsModal
              open={settingsOpen}
              blocked={authModalProvider != null || signInPickerOpen}
              theme={theme}
              onThemeChange={setTheme}
              collapseThinking={collapseThinking}
              onCollapseThinkingChange={setCollapseThinking}
              notifyOnAgentComplete={notifyOnAgentComplete}
              onNotifyOnAgentCompleteChange={setNotifyOnAgentComplete}
              notifyOnAgentError={notifyOnAgentError}
              onNotifyOnAgentErrorChange={setNotifyOnAgentError}
              keybindings={keybindings}
              onKeybindingsChange={setKeybindings}
              grokAuth={auth}
              grokAuthBusy={authBusy}
              onGrokLogin={() => void handleLogin()}
              onGrokLogout={() => void handleLogout()}
              openaiAuth={openaiAuth}
              openaiAuthBusy={openaiAuthBusy}
              onOpenAILogin={() => void handleOpenAILogin()}
              onOpenAILogout={() => void handleOpenAILogout()}
              threads={threads}
              projects={projects}
              onUnarchiveThread={handleUnarchive}
              onDeleteThread={handleDelete}
              onOpenThread={(id) => {
                handleUnarchive(id, { silent: true });
                handleSelectThread(id);
                const t = threadsRef.current.find((x) => x.id === id);
                if (t) setActiveProjectId(t.projectId);
                setSettingsOpen(false);
                toast.success("Chat restored");
              }}
              onArchiveAll={() => void handleArchiveAll()}
              archiveAllBusy={archivingAll}
              onImportCodexChats={() => void handleImportCodexChats()}
              importCodexChatsBusy={importingCodexChats}
              importedCodexChatCount={threads.filter(isImportedCodexThread).length}
              onUnimportCodexChats={() => void handleUnimportCodexChats()}
              unimportCodexChatsBusy={unimportingCodexChats}
              workingThreadIds={streamingThreadIds}
              onClose={() => setSettingsOpen(false)}
            />
          </Suspense>
        </SettingsLoadBoundary>
      ) : null}

      <UsagePage open={usageOpen} onClose={closeUsage} />

      <ProvidersPage
        open={providersOpen}
        grokAuth={auth}
        openaiAuth={openaiAuth}
        antigravityStatus={antigravityStatus}
        antigravityEnabled={antigravityEnabled}
        openCodeStatus={openCodeStatus}
        openCodeEnabled={openCodeEnabled}
        healthInterval={openCodeHealthInterval}
        checking={openCodeChecking || antigravityChecking}
        updating={openCodeUpdating}
        error={openCodeError ?? antigravityError}
        onClose={() => setProvidersOpen(false)}
        onRefresh={() => {
          void refreshOpenCode();
          void refreshAntigravity();
        }}
        onUpdate={() => void handleOpenCodeUpdate()}
        onAntigravityEnabledChange={handleAntigravityEnabledChange}
        onOpenCodeEnabledChange={handleOpenCodeEnabledChange}
        onHealthIntervalChange={handleOpenCodeHealthIntervalChange}
      />

      {openCodeEnabled &&
      openCodeStatus.updateAvailable &&
      openCodeStatus.latestVersion &&
      dismissedOpenCodeVersion !== openCodeStatus.latestVersion ? (
        <OpenCodeUpdateNotice
          version={openCodeStatus.latestVersion}
          updating={openCodeUpdating}
          onUpdate={() => void handleOpenCodeUpdate()}
          onOpen={openProviders}
          onDismiss={() =>
            setDismissedOpenCodeVersion(openCodeStatus.latestVersion)
          }
        />
      ) : null}

      <ProfilePage
        open={profileOpen}
        auth={auth}
        authBusy={authBusy}
        openaiAuth={openaiAuth}
        openaiAuthBusy={openaiAuthBusy}
        onClose={() => setProfileOpen(false)}
        onProfileChange={setUserProfile}
        onLogin={() => void handleLogin()}
        onLogout={() => void handleLogout()}
        onOpenAILogin={() => void handleOpenAILogin()}
        onOpenAILogout={() => void handleOpenAILogout()}
      />

      <CommandPalette
        open={paletteOpen}
        view={paletteView}
        threads={threads.filter(
          (t) => t.archivedAt == null && isSidebarThreadVisible(t),
        )}
        projects={projects}
        actions={paletteActions}
        activeThreadId={activeId}
        activeProjectId={activeProjectId}
        workingThreadIds={streamingThreadIds}
        onSelectThread={(id) => {
          handleSelectThread(id);
          const t = threads.find((x) => x.id === id);
          if (t) setActiveProjectId(t.projectId);
        }}
        onNewThreadInProject={handleNew}
        onBack={() => setPaletteView("root")}
        onClose={() => setPaletteOpen(false)}
      />
      <ProjectFilePicker
        open={filePickerOpen}
        projectName={activeProject?.name ?? null}
        projectPath={activeWorkspacePath ?? activeProject?.path ?? null}
        onPick={(entry) => {
          setDraft((current) => {
            const spacer = current && !/\s$/.test(current) ? " " : "";
            return `${current}${spacer}@${entry.path} `;
          });
        }}
        onClose={() => setFilePickerOpen(false)}
      />
      <ConfirmDialogHost />
    </div>
  );
}
