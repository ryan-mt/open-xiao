import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { createPortal } from "react-dom";
import { ChartNoAxesColumn, Copy, Settings } from "lucide-react";
import type { Project, Thread } from "../types";
import type { ThreadAttentionKind } from "../threadAttention";
import { APP_BASE_NAME } from "../branding";
import { storedModelDisplay, type ModelProvider } from "../models";
import { formatPlanLabel } from "../planLabel";
import type { UserProfile } from "../profile";
import { AppLogo } from "./AppLogo";
import { AntigravityLogo } from "./AntigravityLogo";
import { GrokLogo } from "./GrokLogo";
import { OpenAILogo } from "./OpenAILogo";
import { OpenCodeLogo } from "./OpenCodeLogo";
import { ProjectFavicon } from "./ProjectFavicon";
import {
  resolveEnvironmentIdentificationPillLabel,
  resolveSidebarStageBackdropVariant,
  SidebarStageBackdrop,
  useEnvironmentIdentificationMode,
  useEnvironmentStageLabel,
} from "./SidebarStageBackdrop";
import {
  canSettle,
  canSnooze,
  DEFAULT_AUTO_SETTLE_AFTER_DAYS,
  formatWorkingDurationLabel,
  hasUnseenCompletion,
  isSidebarThreadVisible,
  isTrailingDoubleClick,
  isWokeVisible,
  planForwardThreadId,
  resolveAdjacentThreadId,
  resolveSidebarThreadBucket,
  resolveSettledTimestampMs,
  resolveSidebarV2Status,
  SETTLED_TAIL_INITIAL_COUNT,
  SETTLED_TAIL_PAGE_COUNT,
  sortSettledThreadsForSidebarV2,
  sortSnoozedThreadsForSidebarV2,
  sortThreadsForSidebarV2,
  syncSidebarProjectScope,
} from "./Sidebar.logic";
import {
  resolveSnoozePresets,
  snoozeWakeLabel,
  type SnoozePreset,
} from "./Sidebar.snooze";
import { shouldOpenNewThreadProjectPicker } from "./newThreadProjectPicker";
import {
  KEYBINDING_COMMAND_EVENT,
  shouldShowThreadJumpHintsForModifiers,
  type KeybindingRule,
} from "../keybindings";

const WIDTH_MIN = 240;
const WIDTH_MAX = 420;
const WIDTH_DEFAULT = 272;
const WIDTH_KEY = "grok-sidebar-width";
const SETTLED_SHELF_EXPANDED_KEY = "grok-sidebar-settled-expanded";
const SNOOZED_SHELF_EXPANDED_KEY = "grok-sidebar-snoozed-expanded";
/** Exit animation before row leaves the active shelf (settle / snooze). */
const ROW_EXIT_MS = 460;

function loadShelfExpanded(key: string, fallback: boolean): boolean {
  try {
    const raw = localStorage.getItem(key);
    if (raw === "1" || raw === "true") return true;
    if (raw === "0" || raw === "false") return false;
  } catch {
    /* ignore */
  }
  return fallback;
}

function saveShelfExpanded(key: string, expanded: boolean): void {
  try {
    localStorage.setItem(key, expanded ? "1" : "0");
  } catch {
    /* ignore */
  }
}

type AuthUser = {
  signedIn: boolean;
  name?: string | null;
  email?: string | null;
  plan?: string | null;
};

/** One-line account summary: per-provider plan labels, or "not signed in". */
function accountSummaryLine(
  auth: AuthUser,
  openaiAuth: AuthUser,
  hasProfile: boolean,
): string {
  const grok = auth.signedIn ? formatPlanLabel(auth.plan) : null;
  const openai = openaiAuth.signedIn
    ? `OpenAI · ${formatPlanLabel(openaiAuth.plan)}`
    : null;
  const joined = [grok, openai].filter(Boolean).join(" + ");
  if (joined) return joined;
  return hasProfile ? "Local profile · Not signed in" : "Not signed in";
}

type Props = {
  open: boolean;
  width: number;
  onWidthChange: (w: number) => void;
  onOpenChange: (open: boolean) => void;
  keybindings: ReadonlyArray<KeybindingRule>;
  projects: Project[];
  threads: Thread[];
  activeId: string | null;
  activeProjectId: string | null;
  query: string;
  onQueryChange: (q: string) => void;
  searchOpen?: boolean;
  onSearchOpenChange?: (open: boolean) => void;
  onSelectThread: (id: string) => void;
  onSelectProject: (id: string | null) => void;
  onNewThread: (projectId: string | null) => void;
  onOpenNewThreadProjectPicker: () => void;
  /** Optional: create a thread bound to a fresh git worktree. */
  onNewThreadInWorktree?: (projectId: string | null) => void;
  worktreeCreateBusy?: boolean;
  onDeleteThread: (id: string) => void;
  onCopyThreadId?: (id: string) => void | Promise<void>;
  onRenameThread?: (id: string, title: string) => void;
  onSettleThread: (id: string) => void;
  onUnsettleThread: (id: string) => void;
  onArchiveThread: (id: string) => void;
  onPinThread: (id: string, pinned: boolean) => void;
  onSnoozeThread: (id: string, untilMs: number) => void;
  onUnsnoozeThread: (id: string) => void;
  onAddProject: () => void;
  onRemoveProject: (id: string) => void;
  onToggleProject: (id: string) => void;
  auth: AuthUser;
  authBusy?: boolean;
  openaiAuth: AuthUser;
  openaiAuthBusy?: boolean;
  userProfile?: UserProfile | null;
  onOpenSignIn: () => void;
  onLogout: () => void;
  onOpenAILogout: () => void;
  onOpenSettings?: () => void;
  onOpenUsage?: () => void;
  onOpenProviders?: () => void;
  onOpenProfile?: () => void;
  /** Threads currently streaming — Working status. */
  workingThreadIds?: string[];
  /** Stream start ms by thread id — working duration. */
  workingStartedAtById?: Record<string, number>;
  attentionByThreadId: ReadonlyMap<string, ThreadAttentionKind>;
  autoSettleAfterDays?: number;
};

export function loadSidebarWidth(): number {
  try {
    const n = Number(localStorage.getItem(WIDTH_KEY));
    if (Number.isFinite(n) && n >= WIDTH_MIN && n <= WIDTH_MAX) return n;
  } catch {
    /* ignore */
  }
  return WIDTH_DEFAULT;
}

function relativeShort(ts: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 45) return "now";
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  if (s < 86400 * 7) return `${Math.round(s / 86400)}d`;
  return `${Math.round(s / (86400 * 7))}w`;
}

function isMac() {
  return (
    typeof navigator !== "undefined" &&
    /Mac|iPhone|iPad|iPod/i.test(navigator.platform || navigator.userAgent)
  );
}

function lastAssistantAt(t: Thread): number | null {
  const msgs = t.messages;
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (m.role === "assistant" && (m.content?.trim() || m.parts?.length)) {
      return m.createdAt;
    }
  }
  return null;
}

type ScopeKey = "all" | "inbox" | string;
type RowBucket = "active" | "snoozed" | "settled";

export const SidebarV2 = memo(function SidebarV2({
  open,
  width,
  onWidthChange,
  onOpenChange,
  keybindings,
  projects,
  threads,
  activeId,
  activeProjectId,
  query,
  onQueryChange,
  searchOpen = false,
  onSearchOpenChange,
  onSelectThread,
  onSelectProject,
  onNewThread,
  onOpenNewThreadProjectPicker,
  onNewThreadInWorktree,
  worktreeCreateBusy = false,
  onDeleteThread,
  onCopyThreadId,
  onRenameThread,
  onSettleThread,
  onArchiveThread,
  onPinThread,
  onUnsettleThread,
  onSnoozeThread,
  onUnsnoozeThread,
  onAddProject,
  onRemoveProject,
  auth,
  authBusy,
  openaiAuth,
  openaiAuthBusy,
  userProfile = null,
  onOpenSignIn,
  onLogout,
  onOpenAILogout,
  onOpenSettings,
  onOpenUsage,
  onOpenProviders,
  onOpenProfile,
  workingThreadIds = [],
  workingStartedAtById = {},
  attentionByThreadId,
  autoSettleAfterDays = DEFAULT_AUTO_SETTLE_AFTER_DAYS,
}: Props) {
  const workingSet = useMemo(
    () => new Set(workingThreadIds),
    [workingThreadIds],
  );
  const state = open ? "expanded" : "collapsed";
  const collapsibleMode = open ? "" : "offcanvas";
  const dragging = useRef(false);
  const widthRef = useRef(width);
  const [isDragging, setIsDragging] = useState(false);
  const [scopeKey, setScopeKey] = useState<ScopeKey>("all");
  const [scopeOpen, setScopeOpen] = useState(false);
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  const [settledShelfExpanded, setSettledShelfExpanded] = useState(() =>
    loadShelfExpanded(SETTLED_SHELF_EXPANDED_KEY, true),
  );
  const [snoozedShelfExpanded, setSnoozedShelfExpanded] = useState(() =>
    loadShelfExpanded(SNOOZED_SHELF_EXPANDED_KEY, false),
  );
  const [settledVisibleCount, setSettledVisibleCount] = useState(
    SETTLED_TAIL_INITIAL_COUNT,
  );
  const [now, setNow] = useState(() => Date.now());
  const [snoozeWakeTick, setSnoozeWakeTick] = useState(0);
  const [showJumpHints, setShowJumpHints] = useState(false);
  /** Thread ids playing exit animation before settle/snooze commits. */
  const [exitingIds, setExitingIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const exitTimersRef = useRef<Map<string, number>>(new Map());
  widthRef.current = width;

  useEffect(() => {
    return () => {
      for (const timer of exitTimersRef.current.values()) {
        window.clearTimeout(timer);
      }
      exitTimersRef.current.clear();
    };
  }, []);

  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(id);
  }, []);

  useEffect(() => {
    if (!scopeOpen) return;
    const onDoc = (e: MouseEvent) => {
      const t = e.target as HTMLElement | null;
      if (t?.closest?.("[data-scope-menu]")) return;
      setScopeOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [scopeOpen]);

  useEffect(() => {
    if (!userMenuOpen) return;
    const onDoc = (e: MouseEvent) => {
      const t = e.target as HTMLElement | null;
      if (t?.closest?.("[data-user-menu]")) return;
      setUserMenuOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [userMenuOpen]);

  // Jump hints while holding Ctrl/Cmd (no other mods).
  useEffect(() => {
    const sync = (e: KeyboardEvent) => {
      setShowJumpHints(shouldShowThreadJumpHintsForModifiers(e, keybindings));
    };
    const clear = () => setShowJumpHints(false);
    window.addEventListener("keydown", sync);
    window.addEventListener("keyup", sync);
    window.addEventListener("blur", clear);
    return () => {
      window.removeEventListener("keydown", sync);
      window.removeEventListener("keyup", sync);
      window.removeEventListener("blur", clear);
    };
  }, [keybindings]);

  const onResizeStart = useCallback(
    (e: React.PointerEvent) => {
      if (!open) {
        onOpenChange(true);
        return;
      }
      e.preventDefault();
      dragging.current = true;
      setIsDragging(true);
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";

      const onMove = (ev: PointerEvent) => {
        if (!dragging.current) return;
        const next = Math.min(WIDTH_MAX, Math.max(WIDTH_MIN, ev.clientX));
        widthRef.current = next;
        onWidthChange(next);
      };
      const onUp = () => {
        dragging.current = false;
        setIsDragging(false);
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        try {
          localStorage.setItem(WIDTH_KEY, String(widthRef.current));
        } catch {
          /* ignore */
        }
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
    },
    [open, onOpenChange, onWidthChange],
  );

  const resetSidebarWidth = useCallback(() => {
    try {
      localStorage.removeItem(WIDTH_KEY);
    } catch {
      /* ignore */
    }
    widthRef.current = WIDTH_DEFAULT;
    onWidthChange(WIDTH_DEFAULT);
  }, [onWidthChange]);

  const projectById = useMemo(() => {
    const m = new Map<string, Project>();
    for (const p of projects) m.set(p.id, p);
    return m;
  }, [projects]);
  const projectIds = useMemo(
    () => projects.map((project) => project.id),
    [projects],
  );

  useEffect(() => {
    setScopeKey((current) =>
      syncSidebarProjectScope(current, activeProjectId, projectIds),
    );
  }, [activeProjectId, projectIds]);

  const q = query.trim().toLowerCase();

  const scopedThreads = useMemo(() => {
    // Archived chats live only in Settings → Archive.
    let list = threads.filter(
      (t) => t.archivedAt == null && isSidebarThreadVisible(t),
    );
    if (scopeKey === "inbox") list = list.filter((t) => !t.projectId);
    else if (scopeKey !== "all")
      list = list.filter((t) => t.projectId === scopeKey);
    if (q) list = list.filter((t) => t.title.toLowerCase().includes(q));
    return list;
  }, [threads, scopeKey, q]);

  // Reset settled paging when scope/search changes.
  const settledResetKey = `${scopeKey}|${q}`;
  const lastSettledResetKeyRef = useRef(settledResetKey);
  if (lastSettledResetKeyRef.current !== settledResetKey) {
    lastSettledResetKeyRef.current = settledResetKey;
    if (settledVisibleCount !== SETTLED_TAIL_INITIAL_COUNT) {
      setSettledVisibleCount(SETTLED_TAIL_INITIAL_COUNT);
    }
  }

  const { activeThreads, snoozedThreads, settledThreads } = useMemo(() => {
    void snoozeWakeTick;
    const preciseNow = Date.now();
    const active: Thread[] = [];
    const snoozed: Thread[] = [];
    const settled: Thread[] = [];
    for (const thread of scopedThreads) {
      const bucket = resolveSidebarThreadBucket(thread, {
        nowMs: preciseNow,
        autoSettleAfterDays,
        working: workingSet.has(thread.id),
        needsAttention: attentionByThreadId.has(thread.id),
      });
      if (bucket === "snoozed") snoozed.push(thread);
      else if (bucket === "settled") settled.push(thread);
      else active.push(thread);
    }
    return {
      activeThreads: sortThreadsForSidebarV2(active),
      snoozedThreads: sortSnoozedThreadsForSidebarV2(snoozed),
      settledThreads: sortSettledThreadsForSidebarV2(settled),
    };
  }, [
    attentionByThreadId,
    autoSettleAfterDays,
    scopedThreads,
    snoozeWakeTick,
    workingSet,
  ]);

  // Arm timer for earliest snooze wake.
  useEffect(() => {
    const nextWake =
      snoozedThreads.length > 0 && snoozedThreads[0]?.snoozedUntil != null
        ? snoozedThreads[0].snoozedUntil
        : Number.NaN;
    if (Number.isNaN(nextWake)) return;
    const delayMs = Math.min(
      Math.max(0, nextWake - Date.now()) + 50,
      2_147_483_647,
    );
    const id = window.setTimeout(
      () => setSnoozeWakeTick((t) => t + 1),
      delayMs,
    );
    return () => window.clearTimeout(id);
  }, [snoozedThreads]);

  const visibleSettledThreads = useMemo(() => {
    if (q) return settledThreads;
    if (settledThreads.length <= settledVisibleCount) return settledThreads;
    const visible = settledThreads.slice(0, settledVisibleCount);
    if (activeId) {
      const routeThread = settledThreads
        .slice(settledVisibleCount)
        .find((t) => t.id === activeId);
      if (routeThread) visible.push(routeThread);
    }
    return visible;
  }, [activeId, q, settledThreads, settledVisibleCount]);

  const hiddenSettledCount =
    settledThreads.length - visibleSettledThreads.length;

  const renderedSettledThreads = useMemo(() => {
    if (q) return visibleSettledThreads;
    if (settledShelfExpanded) return visibleSettledThreads;
    if (!activeId) return [];
    const routeThread = visibleSettledThreads.find((t) => t.id === activeId);
    return routeThread ? [routeThread] : [];
  }, [activeId, q, settledShelfExpanded, visibleSettledThreads]);

  const visibleSnoozedThreads = useMemo(() => {
    if (q) return snoozedThreads;
    if (snoozedShelfExpanded) return snoozedThreads;
    if (!activeId) return [];
    const routeThread = snoozedThreads.find((t) => t.id === activeId);
    return routeThread ? [routeThread] : [];
  }, [activeId, q, snoozedShelfExpanded, snoozedThreads]);

  const orderedActiveIds = useMemo(
    () => activeThreads.map((t) => t.id),
    [activeThreads],
  );
  const orderedVisibleIds = useMemo(
    () => [
      ...activeThreads.map((t) => t.id),
      ...visibleSnoozedThreads.map((t) => t.id),
      ...renderedSettledThreads.map((t) => t.id),
    ],
    [activeThreads, visibleSnoozedThreads, renderedSettledThreads],
  );

  // Jump 1–9 + prev/next
  const selectThread = useCallback(
    (t: Thread) => {
      onSelectThread(t.id);
    },
    [onSelectThread],
  );

  useEffect(() => {
    const onCommand = (event: Event) => {
      const command = (event as CustomEvent<{ command?: string }>).detail
        ?.command;
      if (command !== "thread.previous" && command !== "thread.next" && !command?.startsWith("thread.jump.")) {
        return;
      }

      const targetId = command.startsWith("thread.jump.")
        ? orderedActiveIds[Number(command.slice("thread.jump.".length)) - 1]
        : resolveAdjacentThreadId({
            threadIds: orderedActiveIds,
            currentThreadId: activeId,
            direction: command === "thread.previous" ? "previous" : "next",
          });
      if (!targetId) return;
      const target = threads.find((thread) => thread.id === targetId);
      if (target) selectThread(target);
    };

    window.addEventListener(KEYBINDING_COMMAND_EVENT, onCommand);
    return () => window.removeEventListener(KEYBINDING_COMMAND_EVENT, onCommand);
  }, [activeId, orderedActiveIds, selectThread, threads]);

  const beginRowExit = useCallback((id: string, commit: () => void) => {
    if (exitTimersRef.current.has(id)) return;
    setExitingIds((prev) => {
      if (prev.has(id)) return prev;
      const next = new Set(prev);
      next.add(id);
      return next;
    });
    const timer = window.setTimeout(() => {
      exitTimersRef.current.delete(id);
      setExitingIds((prev) => {
        if (!prev.has(id)) return prev;
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
      commit();
    }, ROW_EXIT_MS);
    exitTimersRef.current.set(id, timer);
  }, []);

  const handleSettle = useCallback(
    (id: string) => {
      if (
        exitTimersRef.current.has(id) ||
        !canSettle({
          working: workingSet.has(id),
          needsAttention: attentionByThreadId.has(id),
        })
      ) {
        return;
      }
      const nextId =
        activeId === id
          ? planForwardThreadId({
              orderedActiveIds,
              currentId: id,
              parkingIds: new Set([id, ...exitingIds]),
            })
          : null;
      // Switch focus immediately so the chat pane doesn't stick on a leaving row.
      if (nextId) {
        const t = threads.find((x) => x.id === nextId);
        if (t) selectThread(t);
        else onSelectThread(nextId);
      } else if (activeId === id) {
        onNewThread(
          threads.find((x) => x.id === id)?.projectId ?? activeProjectId,
        );
      }
      beginRowExit(id, () => onSettleThread(id));
    },
    [
      activeId,
      activeProjectId,
      attentionByThreadId,
      beginRowExit,
      exitingIds,
      onNewThread,
      onSelectThread,
      onSettleThread,
      orderedActiveIds,
      selectThread,
      threads,
      workingSet,
    ],
  );

  const handleSnooze = useCallback(
    (id: string, untilMs: number) => {
      const thread = threads.find((candidate) => candidate.id === id);
      if (
        exitTimersRef.current.has(id) ||
        !thread ||
        !canSnooze(thread, {
          nowMs: Date.now(),
          working: workingSet.has(id),
          needsAttention: attentionByThreadId.has(id),
        })
      ) {
        return;
      }
      const nextId =
        activeId === id
          ? planForwardThreadId({
              orderedActiveIds,
              currentId: id,
              parkingIds: new Set([id, ...exitingIds]),
            })
          : null;
      if (nextId) {
        const t = threads.find((x) => x.id === nextId);
        if (t) selectThread(t);
        else onSelectThread(nextId);
      } else if (activeId === id) {
        onNewThread(
          threads.find((x) => x.id === id)?.projectId ?? activeProjectId,
        );
      }
      beginRowExit(id, () => onSnoozeThread(id, untilMs));
    },
    [
      activeId,
      activeProjectId,
      attentionByThreadId,
      beginRowExit,
      exitingIds,
      onNewThread,
      onSelectThread,
      onSnoozeThread,
      orderedActiveIds,
      selectThread,
      threads,
      workingSet,
    ],
  );

  const scopeLabel =
    scopeKey === "all"
      ? "All projects"
      : scopeKey === "inbox"
        ? "Inbox"
        : (projectById.get(scopeKey)?.name ?? "Project");

  const newProjectId =
    scopeKey !== "all" && scopeKey !== "inbox" ? scopeKey : activeProjectId;

  const kbdMod = isMac() ? "Cmd" : "Ctrl";
  const totalScoped =
    activeThreads.length + snoozedThreads.length + settledThreads.length;

  const jumpLabelFor = (id: string): string | null => {
    if (!showJumpHints) return null;
    const idx = orderedVisibleIds.indexOf(id);
    if (idx < 0 || idx > 8) return null;
    return `${kbdMod}${idx + 1}`;
  };

  const handleArchive = useCallback(
    (id: string) => {
      if (exitTimersRef.current.has(id)) return;
      const isActiveShelf = activeThreads.some((t) => t.id === id);
      if (!isActiveShelf) {
        onArchiveThread(id);
        return;
      }
      const nextId =
        activeId === id
          ? planForwardThreadId({
              orderedActiveIds,
              currentId: id,
              parkingIds: new Set([id, ...exitingIds]),
            })
          : null;
      if (nextId) {
        const t = threads.find((x) => x.id === nextId);
        if (t) selectThread(t);
        else onSelectThread(nextId);
      } else if (activeId === id) {
        onNewThread(
          threads.find((x) => x.id === id)?.projectId ?? activeProjectId,
        );
      }
      beginRowExit(id, () => onArchiveThread(id));
    },
    [
      activeId,
      activeProjectId,
      activeThreads,
      beginRowExit,
      exitingIds,
      onArchiveThread,
      onNewThread,
      onSelectThread,
      orderedActiveIds,
      selectThread,
      threads,
    ],
  );

  const renderRow = (t: Thread, bucket: RowBucket) => {
    const working = workingSet.has(t.id);
    const attention = attentionByThreadId.get(t.id) ?? null;
    const variant: "card" | "slim" =
      bucket === "active" ? "card" : "slim";
    const variantAction =
      bucket === "snoozed"
        ? ("unsnooze" as const)
        : bucket === "settled"
          ? ("unsettle" as const)
          : ("settle" as const);
    const exiting = bucket === "active" && exitingIds.has(t.id);
    return (
      <ThreadRowV2
        key={`${t.id}:${bucket}`}
        t={t}
        variant={variant}
        variantAction={variantAction}
        active={t.id === activeId}
        working={working}
        attention={attention}
        workingStartedAt={workingStartedAtById[t.id] ?? null}
        exiting={exiting}
        projectName={
          t.projectId
            ? (projectById.get(t.projectId)?.name ?? null)
            : "Inbox"
        }
        projectPath={
          t.projectId ? (projectById.get(t.projectId)?.path ?? null) : null
        }
        now={now}
        jumpLabel={jumpLabelFor(t.id)}
        onSelect={() => selectThread(t)}
        onDelete={() => onDeleteThread(t.id)}
        onCopyId={
          onCopyThreadId ? () => void onCopyThreadId(t.id) : undefined
        }
        onRename={
          onRenameThread
            ? (title) => onRenameThread(t.id, title)
            : undefined
        }
        onSettle={() => handleSettle(t.id)}
        onUnsettle={() => onUnsettleThread(t.id)}
        onArchive={() => handleArchive(t.id)}
        onPin={(pinned) => onPinThread(t.id, pinned)}
        onSnooze={(preset) => handleSnooze(t.id, preset.snoozedUntil)}
        onUnsnooze={() => onUnsnoozeThread(t.id)}
      />
    );
  };

  return (
    <div
      className={`sidebar-v2${isDragging ? " is-resizing" : ""}`}
      data-state={state}
      data-collapsible={collapsibleMode}
      data-sidebar-version="v2"
      style={{ ["--sidebar-width" as string]: `${width}px` }}
    >
      <div className="sidebar-v2__gap" aria-hidden />
      <button
        type="button"
        className="sidebar-v2__mobile-backdrop"
        aria-label="Close sidebar"
        onClick={() => onOpenChange(false)}
      />

      <aside className="sidebar-v2__container" aria-hidden={!open}>
        <div className="sidebar-v2__inner">
          <SidebarChromeHeader />

          <div className="sb-fixed">
            <div className="sb-fixed__row">
              <button
                type="button"
                className="sb-menu-btn sb-menu-btn--grow"
                onClick={() => {
                  onSearchOpenChange?.(true);
                  window.requestAnimationFrame(() => {
                    const el = document.querySelector(
                      ".sb-search-inline",
                    ) as HTMLInputElement | null;
                    el?.focus();
                  });
                }}
                aria-label="Search chats"
              >
                <SearchIcon />
                <span className="sb-menu-btn__label">Search</span>
              </button>
              <button
                type="button"
                className="sb-menu-btn sb-menu-btn--icon"
                onClick={(event) => {
                  if (
                    shouldOpenNewThreadProjectPicker(
                      scopeKey,
                      projects.length,
                      event.shiftKey,
                    )
                  ) {
                    onOpenNewThreadProjectPicker();
                    return;
                  }
                  onNewThread(newProjectId);
                }}
                aria-label="New thread"
                title={
                  projects.length > 1
                    ? `New thread (${kbdMod}N)\nNew thread in current project: Shift+click`
                    : `New thread (${kbdMod}N)`
                }
              >
                <PenIcon />
              </button>
              {newProjectId && onNewThreadInWorktree ? (
                <button
                  type="button"
                  className="sb-menu-btn sb-menu-btn--icon"
                  disabled={worktreeCreateBusy}
                  onClick={() => onNewThreadInWorktree(newProjectId)}
                  aria-label="New task in worktree"
                  title={
                    worktreeCreateBusy
                      ? "Creating worktree…"
                      : "New task in worktree"
                  }
                >
                  <WorktreeIcon />
                </button>
              ) : null}
            </div>

            <div className="sb-fixed__row" data-scope-menu>
              <div className="sb-scope">
                <button
                  type="button"
                  className="sb-menu-btn sb-menu-btn--grow"
                  aria-label="Filter threads by project"
                  aria-expanded={scopeOpen}
                  onClick={() => setScopeOpen((v) => !v)}
                >
                  {scopeKey === "inbox" ? <MsgIcon /> : <FolderIcon />}
                  <span className="sb-menu-btn__label">{scopeLabel}</span>
                  <ChevronDownIcon open={scopeOpen} />
                </button>
                {scopeOpen ? (
                  <div className="sb-scope__menu" role="listbox">
                    <ScopeItem
                      active={scopeKey === "all"}
                      icon={<FolderIcon />}
                      label="All projects"
                      onPick={() => {
                        setScopeKey("all");
                        setScopeOpen(false);
                      }}
                    />
                    <ScopeItem
                      active={scopeKey === "inbox"}
                      icon={<MsgIcon />}
                      label="Inbox"
                      onPick={() => {
                        setScopeKey("inbox");
                        onSelectProject(null);
                        setScopeOpen(false);
                      }}
                    />
                    {projects.map((p) => (
                      <ScopeItem
                        key={p.id}
                        active={scopeKey === p.id}
                        icon={<FolderIcon />}
                        label={p.name}
                        onPick={() => {
                          setScopeKey(p.id);
                          onSelectProject(p.id);
                          setScopeOpen(false);
                        }}
                        onRemove={() => onRemoveProject(p.id)}
                      />
                    ))}
                  </div>
                ) : null}
              </div>
              <button
                type="button"
                className="sb-menu-btn sb-menu-btn--icon"
                onClick={onAddProject}
                aria-label="New project"
                title="New project"
              >
                <FolderPlusIcon />
              </button>
            </div>

            {searchOpen || !onSearchOpenChange ? (
              <div className="sb-search-field">
                <SearchIcon />
                <input
                  className="sb-search-inline"
                  role="searchbox"
                  aria-label="Search threads"
                  placeholder="Search chats..."
                  value={query}
                  onChange={(e) => onQueryChange(e.target.value)}
                  onKeyDown={(event) => {
                    if (event.key !== "Escape") return;
                    event.preventDefault();
                    onQueryChange("");
                    onSearchOpenChange?.(false);
                  }}
                />
                {query ? (
                  <button
                    type="button"
                    className="sb-clear"
                    onClick={() => onQueryChange("")}
                    aria-label="Clear search"
                  >
                    <XIcon />
                  </button>
                ) : null}
              </div>
            ) : null}
          </div>

          <div className="sidebar-v2__content scrollbar-hide">
            <ul className="sb-thread-list" role="list">
              {activeThreads.map((t) => renderRow(t, "active"))}

              {snoozedThreads.length > 0 ? (
                <li className="sb-shelf-head list-none">
                  <button
                    type="button"
                    className="sb-shelf-toggle sb-shelf-toggle--snoozed"
                    aria-expanded={snoozedShelfExpanded}
                    onClick={() =>
                      setSnoozedShelfExpanded((v) => {
                        const next = !v;
                        saveShelfExpanded(SNOOZED_SHELF_EXPANDED_KEY, next);
                        return next;
                      })
                    }
                  >
                    <span className="sb-shelf-toggle__label">
                      {snoozedShelfExpanded
                        ? "Snoozed"
                        : `Snoozed (${snoozedThreads.length})`}
                    </span>
                    <span className="sb-shelf-toggle__rule" aria-hidden />
                    <ChevronDownIcon open={snoozedShelfExpanded} />
                  </button>
                </li>
              ) : null}
              {visibleSnoozedThreads.map((t) => renderRow(t, "snoozed"))}

              {settledThreads.length > 0 ? (
                <li className="sb-shelf-head list-none">
                  <button
                    type="button"
                    className="sb-shelf-toggle"
                    aria-expanded={settledShelfExpanded}
                    onClick={() =>
                      setSettledShelfExpanded((v) => {
                        const next = !v;
                        saveShelfExpanded(SETTLED_SHELF_EXPANDED_KEY, next);
                        return next;
                      })
                    }
                  >
                    <span className="sb-shelf-toggle__label">
                      {settledShelfExpanded
                        ? "Settled"
                        : `Settled (${settledThreads.length})`}
                    </span>
                    <span className="sb-shelf-toggle__rule" aria-hidden />
                    <ChevronDownIcon open={settledShelfExpanded} />
                  </button>
                </li>
              ) : null}
              {renderedSettledThreads.map((t) => renderRow(t, "settled"))}

              {settledShelfExpanded && hiddenSettledCount > 0 ? (
                <li className="list-none">
                  <button
                    type="button"
                    className="sb-show-more"
                    onClick={() =>
                      setSettledVisibleCount(
                        (n) => n + SETTLED_TAIL_PAGE_COUNT,
                      )
                    }
                  >
                    <PlusIcon />
                    Show{" "}
                    {Math.min(hiddenSettledCount, SETTLED_TAIL_PAGE_COUNT)}{" "}
                    more
                  </button>
                </li>
              ) : null}
            </ul>

            {totalScoped === 0 ? (
              <div className="sb-empty">
                {projects.length === 0 ? (
                  <>
                    <span>No projects yet</span>
                    <button
                      type="button"
                      className="sb-empty__btn"
                      onClick={onAddProject}
                    >
                      <PlusIcon />
                      Add project
                    </button>
                  </>
                ) : scopeKey !== "all" ? (
                  `No threads in ${scopeLabel} yet`
                ) : (
                  "No threads yet"
                )}
              </div>
            ) : null}
          </div>

          <div className="sidebar-v2__footer">
            <div className="sidebar-v2__footer-actions">
              {onOpenSettings ? (
                <button
                  type="button"
                  className="sidebar-v2__footer-action"
                  onClick={onOpenSettings}
                  aria-label="Settings"
                  title="Settings"
                >
                  <Settings size={16} strokeWidth={1.6} aria-hidden />
                </button>
              ) : null}
              {onOpenProviders ? (
                <button
                  type="button"
                  className="sidebar-v2__footer-action"
                  onClick={onOpenProviders}
                  aria-label="Providers"
                  title="Providers"
                >
                  <ProvidersIcon />
                </button>
              ) : null}
              {onOpenUsage ? (
                <button
                  type="button"
                  className="sidebar-v2__footer-action"
                  onClick={onOpenUsage}
                  aria-label="Usage"
                  title="Usage"
                >
                  <ChartNoAxesColumn size={16} strokeWidth={1.6} aria-hidden />
                </button>
              ) : null}
            </div>
            {userProfile || auth.signedIn || openaiAuth.signedIn ? (
              <div className="sidebar-v2__user-wrap" data-user-menu>
                <button
                  type="button"
                  className="sidebar-v2__user"
                  onClick={() => setUserMenuOpen((v) => !v)}
                  aria-expanded={userMenuOpen}
                  aria-haspopup="menu"
                  title="Account"
                  disabled={authBusy || openaiAuthBusy}
                >
                  <span className="sidebar-v2__avatar">
                    {userProfile?.avatarDataUrl ? (
                      <img
                        src={userProfile.avatarDataUrl}
                        alt=""
                        className="sidebar-v2__avatar-img"
                      />
                    ) : userProfile?.name ? (
                      <span className="sidebar-v2__avatar-letter">
                        {userProfile.name.trim().charAt(0).toUpperCase() ||
                          "G"}
                      </span>
                    ) : (
                      <AppLogo size={16} />
                    )}
                  </span>
                  <span className="sidebar-v2__user-meta">
                    <span className="sidebar-v2__user-name">
                      {userProfile?.name ||
                        auth.name ||
                        auth.email ||
                        openaiAuth.email ||
                        "Account"}
                    </span>
                    <span className="sidebar-v2__user-plan">
                      {accountSummaryLine(auth, openaiAuth, Boolean(userProfile))}
                    </span>
                  </span>
                  <ChevronDownIcon open={userMenuOpen} />
                </button>
                {userMenuOpen ? (
                  <div className="sidebar-v2__user-menu" role="menu">
                    {onOpenProfile ? (
                      <button
                        type="button"
                        role="menuitem"
                        className="sidebar-v2__user-menu-item"
                        onClick={() => {
                          setUserMenuOpen(false);
                          onOpenProfile();
                        }}
                      >
                        <UserIcon />
                        {userProfile ? "Profile" : "Create profile"}
                      </button>
                    ) : null}
                    {auth.signedIn ? (
                      <button
                        type="button"
                        role="menuitem"
                        className="sidebar-v2__user-menu-item sidebar-v2__user-menu-item--danger"
                        disabled={authBusy}
                        onClick={() => {
                          setUserMenuOpen(false);
                          onLogout();
                        }}
                      >
                        <LogoutIcon />
                        Sign out of Grok
                      </button>
                    ) : null}
                    {openaiAuth.signedIn ? (
                      <button
                        type="button"
                        role="menuitem"
                        className="sidebar-v2__user-menu-item sidebar-v2__user-menu-item--danger"
                        disabled={openaiAuthBusy}
                        onClick={() => {
                          setUserMenuOpen(false);
                          onOpenAILogout();
                        }}
                      >
                        <LogoutIcon />
                        Sign out of OpenAI
                      </button>
                    ) : null}
                    {!auth.signedIn || !openaiAuth.signedIn ? (
                      <button
                        type="button"
                        role="menuitem"
                        className="sidebar-v2__user-menu-item"
                        disabled={authBusy || openaiAuthBusy}
                        onClick={() => {
                          setUserMenuOpen(false);
                          onOpenSignIn();
                        }}
                      >
                        <LoginIcon />
                        {authBusy || openaiAuthBusy ? "Signing in..." : "Sign in"}
                      </button>
                    ) : null}
                  </div>
                ) : null}
              </div>
            ) : (
              <div className="sidebar-v2__footer-stack">
                {onOpenProfile ? (
                  <button
                    type="button"
                    className="sidebar-v2__cta sidebar-v2__cta--outline"
                    onClick={onOpenProfile}
                  >
                    Create profile
                  </button>
                ) : null}
                <button
                  type="button"
                  className="sidebar-v2__cta sidebar-v2__cta--outline"
                  onClick={onOpenSignIn}
                  disabled={authBusy || openaiAuthBusy}
                >
                  {authBusy || openaiAuthBusy ? "Signing in..." : "Sign in"}
                </button>
              </div>
            )}
          </div>
        </div>

        <div
          className="sidebar-v2__resizer"
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize sidebar"
          onPointerDown={onResizeStart}
          onDoubleClick={resetSidebarWidth}
          title="Drag to resize. Double-click to reset"
        />
      </aside>
    </div>
  );
});

function SidebarChromeHeader() {
  const stageLabel = useEnvironmentStageLabel();
  const idMode = useEnvironmentIdentificationMode();
  const backdropVariant = resolveSidebarStageBackdropVariant(
    stageLabel,
    idMode === "artwork",
  );
  const pillLabel =
    idMode === "pill"
      ? resolveEnvironmentIdentificationPillLabel(stageLabel)
      : null;
  const onBackdrop = backdropVariant !== null;

  return (
    <div
      className={`sb-chrome-header${onBackdrop ? " sb-chrome-header--stage" : ""}`}
    >
      {backdropVariant ? (
        <SidebarStageBackdrop variant={backdropVariant} />
      ) : null}
      <span
        className={`sb-chrome-brand${onBackdrop ? " sb-chrome-brand--on-stage" : ""}`}
      >
        <span className="sb-chrome-wordmark">{APP_BASE_NAME}</span>
      </span>
      {pillLabel ? (
        <span className="sb-chrome-pill" data-environment-identification="pill">
          {pillLabel}
        </span>
      ) : null}
    </div>
  );
}

function ScopeItem({
  active,
  icon,
  label,
  onPick,
  onRemove,
}: {
  active: boolean;
  icon: React.ReactNode;
  label: string;
  onPick: () => void;
  onRemove?: () => void;
}) {
  return (
    <div className={`sb-scope__item${active ? " is-active" : ""}`}>
      <button type="button" className="sb-scope__pick" onClick={onPick}>
        {icon}
        <span>{label}</span>
      </button>
      {onRemove ? (
        <button
          type="button"
          className="sb-scope__more"
          aria-label={`Remove ${label}`}
          title="Remove project"
          onClick={(e) => {
            e.stopPropagation();
            onRemove();
          }}
        >
          <XIcon />
        </button>
      ) : null}
    </div>
  );
}

/** Mutates the timer text node so the parent thread row never re-renders each second. */
function WorkingDuration({ startedAt }: { startedAt: number | null }) {
  const textRef = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (startedAt == null) return;
    const tick = () => {
      if (textRef.current) {
        textRef.current.textContent = formatWorkingDurationLabel(
          Date.now() - startedAt,
        );
      }
    };
    tick();
    const id = window.setInterval(tick, 1_000);
    return () => window.clearInterval(id);
  }, [startedAt]);
  if (startedAt == null) return null;
  return (
    <span className="sb-working-duration" ref={textRef}>
      {formatWorkingDurationLabel(Date.now() - startedAt)}
    </span>
  );
}

function SnoozeMenu({
  open,
  onOpenChange,
  onSnooze,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onSnooze: (preset: SnoozePreset) => void;
}) {
  const presets = useMemo(
    () => (open ? resolveSnoozePresets(new Date()) : []),
    [open],
  );
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      const t = e.target as HTMLElement | null;
      if (rootRef.current?.contains(t)) return;
      onOpenChange(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open, onOpenChange]);

  return (
    <div className="sb-snooze" ref={rootRef} data-thread-selection-safe>
      <button
        type="button"
        className="sb-row__action"
        aria-label="Snooze thread"
        aria-expanded={open}
        onClick={(e) => {
          e.stopPropagation();
          onOpenChange(!open);
        }}
        onDoubleClick={(e) => e.stopPropagation()}
      >
        <ClockIcon />
      </button>
      {open ? (
        <div className="sb-snooze__menu" role="menu">
          {presets.map((preset) => (
            <button
              key={preset.id}
              type="button"
              role="menuitem"
              className="sb-snooze__item"
              onClick={(e) => {
                e.stopPropagation();
                onOpenChange(false);
                onSnooze(preset);
              }}
            >
              <span>{preset.label}</span>
              <span className="sb-snooze__when">{preset.whenLabel}</span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

type ThreadCtxMenuState = {
  x: number;
  y: number;
};

type ThreadDetailsPosition = {
  top: number;
  left: number;
  width: number;
};

function ThreadProviderLogo({ provider }: { provider: ModelProvider }) {
  if (provider === "openai") return <OpenAILogo size={13} />;
  if (provider === "antigravity") return <AntigravityLogo size={13} />;
  if (provider === "opencode") return <OpenCodeLogo size={13} />;
  return <GrokLogo size={13} />;
}

function ThreadDetailsTooltip({
  id,
  position,
  title,
  projectName,
  projectPath,
  branch,
  model,
}: {
  id: string;
  position: ThreadDetailsPosition;
  title: string;
  projectName: string | null;
  projectPath: string | null;
  branch: string | null;
  model: ReturnType<typeof storedModelDisplay>;
}) {
  return createPortal(
    <div
      id={id}
      role="tooltip"
      className="sb-thread-tip"
      style={{ top: position.top, left: position.left, width: position.width }}
    >
      <strong className="sb-thread-tip__title">{title}</strong>
      <div className="sb-thread-tip__meta">
        {projectName ? (
          <span>
            <ProjectFavicon path={projectPath} size={13} />
            <span>{projectName}</span>
          </span>
        ) : null}
        {branch ? (
          <span>
            <WorktreeIcon />
            <span>{branch}</span>
          </span>
        ) : null}
        {model ? (
          <span>
            <ThreadProviderLogo provider={model.provider} />
            <span>{model.label}</span>
          </span>
        ) : null}
      </div>
    </div>,
    document.body,
  );
}

const ThreadRowV2 = memo(function ThreadRowV2({
  t,
  variant,
  variantAction,
  active,
  working,
  attention,
  workingStartedAt,
  exiting = false,
  projectName,
  projectPath,
  now,
  jumpLabel,
  onSelect,
  onDelete,
  onCopyId,
  onRename,
  onSettle,
  onUnsettle,
  onArchive,
  onPin,
  onSnooze,
  onUnsnooze,
}: {
  t: Thread;
  variant: "card" | "slim";
  variantAction: "settle" | "unsettle" | "unsnooze";
  active: boolean;
  working: boolean;
  attention: ThreadAttentionKind | null;
  workingStartedAt: number | null;
  exiting?: boolean;
  projectName: string | null;
  projectPath: string | null;
  now: number;
  jumpLabel: string | null;
  onSelect: () => void;
  onDelete: () => void;
  onCopyId?: () => void;
  onRename?: (title: string) => void;
  onSettle: () => void;
  onUnsettle: () => void;
  onArchive: () => void;
  onPin: (pinned: boolean) => void;
  onSnooze: (preset: SnoozePreset) => void;
  onUnsnooze: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(t.title);
  const [snoozeOpen, setSnoozeOpen] = useState(false);
  const [ctxMenu, setCtxMenu] = useState<ThreadCtxMenuState | null>(null);
  const [detailsPosition, setDetailsPosition] =
    useState<ThreadDetailsPosition | null>(null);
  const ctxMenuRef = useRef<HTMLDivElement>(null);
  const surfaceRef = useRef<HTMLDivElement>(null);
  const detailsTimerRef = useRef(0);
  const isPinned = Boolean(t.pinned);

  const status = resolveSidebarV2Status({
    attention,
    working,
    lastError: t.lastError,
  });
  const isUnread = hasUnseenCompletion({
    lastAssistantAt: lastAssistantAt(t),
    lastVisitedAt: t.lastVisitedAt,
    working,
  });
  const isWoke = isWokeVisible({
    wokeAt: t.wokeAt,
    lastVisitedAt: t.lastVisitedAt,
  });
  const isInFlight = working;
  const shouldRecede =
    !attention &&
    (status === "ready" || isInFlight) &&
    !isUnread &&
    !isWoke &&
    !active &&
    !isPinned;

  const time =
    variantAction === "unsettle"
      ? relativeShort(resolveSettledTimestampMs(t), now)
      : relativeShort(t.updatedAt, now);
  const wakeText =
    t.snoozedUntil != null ? snoozeWakeLabel(t.snoozedUntil, now) : null;
  const showSnooze =
    variantAction === "settle" &&
    canSnooze(t, {
      nowMs: now,
      working,
      needsAttention: attention !== null,
    });
  const settleAllowed = canSettle({
    working,
    needsAttention: attention !== null,
  });
  const branch = t.worktreeBranch?.trim() || null;
  const model = storedModelDisplay(t.modelId);
  const detailsId = `sidebar-thread-details-${t.id}`;
  const attentionLabel =
    status === "approval"
      ? "Needs approval"
      : status === "input"
        ? "Needs answer"
        : null;

  const topStatus =
    attentionLabel
      ? {
          label: attentionLabel,
          kind: "attention" as const,
          className: "is-attention",
        }
      : status === "working"
        ? { label: "Working", kind: "working" as const, className: "is-working" }
        : status === "failed"
          ? { label: "Failed", kind: "failed" as const, className: "is-failed" }
          : isWoke
            ? { label: "Woke", kind: "woke" as const, className: "is-woke" }
            : isUnread
              ? { label: "Done", kind: "done" as const, className: "is-done" }
              : null;

  useEffect(() => {
    if (!ctxMenu) return;
    const onDocDown = (e: MouseEvent) => {
      const el = e.target as HTMLElement | null;
      if (ctxMenuRef.current?.contains(el)) return;
      setCtxMenu(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setCtxMenu(null);
    };
    const onScroll = () => setCtxMenu(null);
    document.addEventListener("mousedown", onDocDown);
    document.addEventListener("keydown", onKey);
    window.addEventListener("scroll", onScroll, true);
    return () => {
      document.removeEventListener("mousedown", onDocDown);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", onScroll, true);
    };
  }, [ctxMenu]);

  useEffect(
    () => () => {
      window.clearTimeout(detailsTimerRef.current);
    },
    [],
  );

  useEffect(() => {
    if (!detailsPosition) return;
    const close = () => setDetailsPosition(null);
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    return () => {
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
    };
  }, [detailsPosition]);

  useEffect(() => {
    if (!ctxMenu || !ctxMenuRef.current) return;
    const menu = ctxMenuRef.current;
    const rect = menu.getBoundingClientRect();
    const pad = 8;
    let x = ctxMenu.x;
    let y = ctxMenu.y;
    if (x + rect.width > window.innerWidth - pad) {
      x = Math.max(pad, window.innerWidth - rect.width - pad);
    }
    if (y + rect.height > window.innerHeight - pad) {
      y = Math.max(pad, window.innerHeight - rect.height - pad);
    }
    if (x !== ctxMenu.x || y !== ctxMenu.y) {
      setCtxMenu({ x, y });
    }
  }, [ctxMenu]);

  const commit = () => {
    const next = draft.trim();
    if (next && next !== t.title) onRename?.(next);
    else setDraft(t.title);
    setEditing(false);
  };

  const onKeyDown = (e: ReactKeyboardEvent) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onSelect();
    }
  };

  const onClick = (e: ReactMouseEvent) => {
    if (isTrailingDoubleClick(e.detail)) return;
    onSelect();
  };

  const onDoubleClick = (e: ReactMouseEvent) => {
    e.preventDefault();
    if (!onRename) return;
    if ((e.target as HTMLElement).closest("button, a, input")) return;
    closeDetails();
    setDraft(t.title);
    setEditing(true);
  };

  const onContextMenu = (e: ReactMouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if ((e.target as HTMLElement).closest("button, a, input")) return;
    setSnoozeOpen(false);
    setCtxMenu({ x: e.clientX, y: e.clientY });
  };

  const closeCtx = () => setCtxMenu(null);

  const openDetails = () => {
    const rect = surfaceRef.current?.getBoundingClientRect();
    if (!rect) return;
    const gap = 4;
    const edge = 8;
    const preferredWidth = 320;
    const rightSpace = window.innerWidth - rect.right - gap - edge;
    const useRight = rightSpace >= 220;
    const availableWidth = useRight
      ? rightSpace
      : Math.max(180, rect.left - gap - edge);
    const width = Math.min(preferredWidth, availableWidth);
    setDetailsPosition({
      top: Math.max(edge, Math.min(rect.top, window.innerHeight - 152)),
      left: useRight
        ? rect.right + gap
        : Math.max(edge, rect.left - gap - width),
      width,
    });
  };

  const queueDetails = () => {
    window.clearTimeout(detailsTimerRef.current);
    detailsTimerRef.current = window.setTimeout(openDetails, 400);
  };

  const closeDetails = () => {
    window.clearTimeout(detailsTimerRef.current);
    setDetailsPosition(null);
  };

  const runCtx = (action: () => void) => {
    closeCtx();
    action();
  };

  const favIcon = <ProjectFavicon path={projectPath} size={16} className="sb-project-icon" />;

  const rowClass = [
    "sb-row",
    variant === "card" ? "sb-row--card" : "sb-row--slim",
    active ? "is-active" : "",
    working ? "is-working" : "",
    attention ? "is-attention" : "",
    isPinned ? "is-pinned" : "",
    shouldRecede ? "is-recede" : "",
    isInFlight && !active ? "is-inflight" : "",
    snoozeOpen ? "is-snooze-open" : "",
    ctxMenu ? "is-ctx-open" : "",
    exiting ? "is-exiting" : "",
  ]
    .filter(Boolean)
    .join(" ");

  const contextMenu =
    ctxMenu && typeof document !== "undefined"
      ? createPortal(
          <div
            ref={ctxMenuRef}
            className="sb-ctx-menu"
            role="menu"
            style={{ left: ctxMenu.x, top: ctxMenu.y }}
            data-thread-selection-safe
            onClick={(e) => e.stopPropagation()}
            onContextMenu={(e) => {
              e.preventDefault();
              e.stopPropagation();
            }}
          >
            <button
              type="button"
              role="menuitem"
              className="sb-ctx-menu__item"
              onClick={() => runCtx(() => onCopyId?.())}
              disabled={!onCopyId}
            >
              <Copy size={14} strokeWidth={1.7} aria-hidden />
              <span>Copy thread ID</span>
            </button>
            <button
              type="button"
              role="menuitem"
              className="sb-ctx-menu__item"
              onClick={() => runCtx(() => onPin(!isPinned))}
            >
              <PinIcon filled={isPinned} />
              <span>{isPinned ? "Unpin chat" : "Pin chat"}</span>
            </button>
            <button
              type="button"
              role="menuitem"
              className="sb-ctx-menu__item"
              onClick={() => runCtx(onArchive)}
            >
              <ArchiveIcon />
              <span>Archive chat</span>
            </button>
            <div className="sb-ctx-menu__sep" role="separator" />
            <button
              type="button"
              role="menuitem"
              className="sb-ctx-menu__item sb-ctx-menu__item--danger"
              onClick={() => runCtx(onDelete)}
            >
              <TrashIcon />
              <span>Delete chat</span>
            </button>
          </div>,
          document.body,
        )
      : null;
  const detailsTooltip =
    detailsPosition && typeof document !== "undefined" ? (
      <ThreadDetailsTooltip
        id={detailsId}
        position={detailsPosition}
        title={t.title}
        projectName={projectName}
        projectPath={projectPath}
        branch={branch}
        model={model}
      />
    ) : null;

  if (variant === "slim") {
    return (
      <li className={rowClass} data-thread-item>
        {editing ? (
          <input
            className="sb-row__rename"
            value={draft}
            autoFocus
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                commit();
              }
              if (e.key === "Escape") {
                setDraft(t.title);
                setEditing(false);
              }
            }}
            onClick={(e) => e.stopPropagation()}
          />
        ) : (
          <div
            ref={surfaceRef}
            role="button"
            tabIndex={0}
            className="sb-row__surface sb-row__surface--slim"
            aria-describedby={detailsPosition ? detailsId : undefined}
            onClick={onClick}
            onDoubleClick={onDoubleClick}
            onContextMenu={onContextMenu}
            onKeyDown={onKeyDown}
            onMouseEnter={queueDetails}
            onMouseLeave={closeDetails}
            onFocusCapture={openDetails}
            onBlurCapture={(e) => {
              if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
                closeDetails();
              }
            }}
          >
            <span className="sb-row__fav" aria-hidden>
              {favIcon}
            </span>
            <span
              className={`sb-row__title${isUnread || isWoke || attention ? " is-emphasis" : ""}`}
            >
              {t.title}
            </span>
            <span className="sb-row__meta-slot">
              <span className="sb-row__time">
                {variantAction === "unsnooze" && wakeText ? (
                  <span className="sb-wake-label">{wakeText}</span>
                ) : isWoke ? (
                  <span className="sb-card__status is-woke" role="status">
                    <AlarmIcon />
                    Woke
                  </span>
                ) : (
                  time
                )}
              </span>
              <span className="sb-row__actions">
                {variantAction === "unsnooze" ? (
                  <button
                    type="button"
                    className="sb-row__action"
                    aria-label="Wake thread now"
                    onClick={(e) => {
                      e.stopPropagation();
                      onUnsnooze();
                    }}
                  >
                    <AlarmOffIcon />
                  </button>
                ) : variantAction === "unsettle" ? (
                  <button
                    type="button"
                    className="sb-row__action"
                    aria-label="Un-settle thread"
                    onClick={(e) => {
                      e.stopPropagation();
                      onUnsettle();
                    }}
                  >
                    <UndoIcon />
                  </button>
                ) : (
                  <button
                    type="button"
                    className="sb-row__action"
                    aria-label="Settle thread"
                    onClick={(e) => {
                      e.stopPropagation();
                      onSettle();
                    }}
                  >
                    <CheckIcon />
                  </button>
                )}
              </span>
            </span>
            {jumpLabel ? (
              <span className="sb-jump-hint" aria-hidden>
                {jumpLabel}
              </span>
            ) : null}
          </div>
        )}
        {contextMenu}
        {detailsTooltip}
      </li>
    );
  }

  return (
    <li className={rowClass} data-thread-item>
      {editing ? (
        <input
          className="sb-row__rename sb-row__rename--card"
          value={draft}
          autoFocus
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              commit();
            }
            if (e.key === "Escape") {
              setDraft(t.title);
              setEditing(false);
            }
          }}
          onClick={(e) => e.stopPropagation()}
        />
      ) : (
        <div
          ref={surfaceRef}
          role="button"
          tabIndex={0}
          className="sb-row__surface sb-row__surface--card"
          aria-describedby={detailsPosition ? detailsId : undefined}
          onClick={onClick}
          onDoubleClick={onDoubleClick}
          onContextMenu={onContextMenu}
          onKeyDown={onKeyDown}
          onMouseEnter={queueDetails}
          onMouseLeave={closeDetails}
          onFocusCapture={openDetails}
          onBlurCapture={(e) => {
            if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
              closeDetails();
            }
          }}
        >
          <div className="sb-card">
            <div className="sb-card__top">
              <span className="sb-row__fav" aria-hidden>
                {favIcon}
              </span>
              {projectName ? (
                <span className="sb-card__project">{projectName}</span>
              ) : (
                <span className="sb-card__spacer" />
              )}
              {isPinned ? (
                <span className="sb-card__pin" aria-label="Pinned">
                  <PinIcon filled />
                </span>
              ) : null}
              <span className="sb-row__meta-slot">
                <span className="sb-row__time">
                  {topStatus ? (
                    <span
                      className={`sb-card__status ${topStatus.className}`}
                    >
                      {topStatus.kind === "working" ? (
                        <CircleDashedIcon />
                      ) : topStatus.kind === "done" ? (
                        <CheckCircleIcon />
                      ) : topStatus.kind === "woke" ? (
                        <AlarmIcon />
                      ) : null}
                      <span role="status">{topStatus.label}</span>
                      {status === "working" ? (
                        <WorkingDuration startedAt={workingStartedAt} />
                      ) : null}
                    </span>
                  ) : (
                    time
                  )}
                </span>
                <span className="sb-row__actions">
                  {showSnooze ? (
                    <SnoozeMenu
                      open={snoozeOpen}
                      onOpenChange={setSnoozeOpen}
                      onSnooze={onSnooze}
                    />
                  ) : null}
                  <button
                    type="button"
                    className="sb-row__action sb-row__action--label"
                    aria-label="Settle thread"
                    disabled={!settleAllowed}
                    title={
                      attention
                        ? "Resolve the request before settling"
                        : working
                          ? "Stop the agent before settling"
                          : undefined
                    }
                    onClick={(e) => {
                      e.stopPropagation();
                      onSettle();
                    }}
                  >
                    <CheckIcon />
                    Settle
                  </button>
                </span>
              </span>
            </div>
            <div
              className={`sb-card__title${isUnread || isWoke || attention ? " is-emphasis" : ""}`}
            >
              {t.title}
            </div>
            <div className="sb-card__foot">
              {branch ? (
                <span className="sb-card__branch" title={t.worktreePath ?? branch}>
                  {branch}
                </span>
              ) : (
                <span className="sb-card__spacer" />
              )}
              {model ? (
                <span className="sb-card__model" aria-hidden>
                  <ThreadProviderLogo provider={model.provider} />
                </span>
              ) : null}
            </div>
          </div>
          {jumpLabel ? (
            <span className="sb-jump-hint" aria-hidden>
              {jumpLabel}
            </span>
          ) : null}
        </div>
      )}
      {contextMenu}
      {detailsTooltip}
    </li>
  );
});

function CircleDashedIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden
      className="sb-card__status-icon"
    >
      <path
        d="M12 3a9 9 0 0 1 9 9"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
        className="sb-spin-arc"
      />
      <circle
        cx="12"
        cy="12"
        r="9"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeDasharray="2.5 3.5"
        opacity="0.35"
      />
    </svg>
  );
}

export function SidebarFloatingControls({
  open,
  onToggle,
  onNew,
  onFocusSearch,
}: {
  open: boolean;
  onToggle: () => void;
  onNew: () => void;
  onFocusSearch?: () => void;
}) {
  return (
    <div className={`sidebar-float${open ? " is-open" : ""}`}>
      <button
        type="button"
        className="sidebar-float__btn"
        onClick={onToggle}
        aria-label="Toggle Sidebar"
        title="Toggle Sidebar (Ctrl+B)"
      >
        <PanelIcon />
      </button>
      <button
        type="button"
        className="sidebar-float__btn sidebar-float__extra"
        onClick={onFocusSearch}
        aria-label="Search"
        tabIndex={open ? -1 : 0}
      >
        <SearchIcon />
      </button>
      <button
        type="button"
        className="sidebar-float__btn sidebar-float__extra"
        onClick={onNew}
        aria-label="New chat"
        tabIndex={open ? -1 : 0}
      >
        <PenIcon />
      </button>
    </div>
  );
}

function PanelIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden>
      <rect
        x="3"
        y="4"
        width="18"
        height="16"
        rx="2"
        stroke="currentColor"
        strokeWidth="1.75"
      />
      <path d="M9 4v16" stroke="currentColor" strokeWidth="1.75" />
    </svg>
  );
}

function SearchIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden>
      <circle cx="11" cy="11" r="6.5" stroke="currentColor" strokeWidth="1.75" />
      <path
        d="M16 16l4.5 4.5"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
      />
    </svg>
  );
}

function PlusIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M12 5v14M5 12h14"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
      />
    </svg>
  );
}

function PenIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5Z"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function WorktreeIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden>
      <circle cx="6" cy="6" r="2" stroke="currentColor" strokeWidth="1.6" />
      <circle cx="18" cy="6" r="2" stroke="currentColor" strokeWidth="1.6" />
      <circle cx="6" cy="18" r="2" stroke="currentColor" strokeWidth="1.6" />
      <path
        d="M6 8v8M6 12h8a4 4 0 0 0 4-4"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
    </svg>
  );
}

function FolderPlusIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M3 7.5A2.5 2.5 0 0 1 5.5 5H9l2 2h7.5A2.5 2.5 0 0 1 21 9.5V12"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
      <path
        d="M14 17h6M17 14v6"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
      <path
        d="M3 16.5V9.5"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
    </svg>
  );
}

function MsgIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M4 6.5A2.5 2.5 0 0 1 6.5 4h11A2.5 2.5 0 0 1 20 6.5v7A2.5 2.5 0 0 1 17.5 16H9l-4 3.5V6.5Z"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function XIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden>
      <path
        d="M3.5 3.5l7 7M10.5 3.5l-7 7"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
    </svg>
  );
}

function FolderIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M3 7.5A2.5 2.5 0 0 1 5.5 5H9l2 2h7.5A2.5 2.5 0 0 1 21 9.5v7A2.5 2.5 0 0 1 18.5 19h-13A2.5 2.5 0 0 1 3 16.5v-9Z"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function ChevronDownIcon({ open }: { open?: boolean }) {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden
      className={open ? "is-open" : undefined}
      style={{
        transform: open ? "rotate(180deg)" : undefined,
        transition: "transform 150ms ease",
      }}
    >
      <path
        d="M6 9l6 6 6-6"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function ProvidersIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden>
      <rect x="4" y="4" width="6" height="6" rx="1.5" stroke="currentColor" strokeWidth="1.6" />
      <rect x="14" y="4" width="6" height="6" rx="1.5" stroke="currentColor" strokeWidth="1.6" />
      <rect x="9" y="14" width="6" height="6" rx="1.5" stroke="currentColor" strokeWidth="1.6" />
      <path d="M7 10v2h10v-2M12 12v2" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

function UserIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden>
      <circle cx="12" cy="8" r="3.5" stroke="currentColor" strokeWidth="1.6" />
      <path
        d="M5 19.5c1.5-3 4-4.5 7-4.5s5.5 1.5 7 4.5"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
    </svg>
  );
}

function LogoutIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M9 7V6a2 2 0 0 1 2-2h7a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-7a2 2 0 0 1-2-2v-1"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
      <path
        d="M13 12H4m0 0 3-3m-3 3 3 3"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function LoginIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M15 7V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h7a2 2 0 0 0 2-2v-1"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
      <path
        d="M10 12h10m0 0-3-3m3 3-3 3"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M5 12.5 10 17.5 19 7"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function CheckCircleIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden
      className="sb-card__status-icon"
    >
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="1.6" />
      <path
        d="M8 12.5 11 15.5 16.5 9"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function UndoIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M9 14 4 9l5-5"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M4 9h10a6 6 0 1 1 0 12h-3"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
    </svg>
  );
}

function ClockIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden>
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="1.6" />
      <path
        d="M12 7v5l3 2"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
    </svg>
  );
}

function AlarmIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden
      className="sb-card__status-icon"
    >
      <circle cx="12" cy="13" r="7" stroke="currentColor" strokeWidth="1.6" />
      <path
        d="M12 10v3l2 1.5M5 5l2.5 2M19 5l-2.5 2"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
    </svg>
  );
}

function AlarmOffIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M4 4l16 16M5 5l2 2M19 5l-2 2"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
      <path
        d="M6.5 10.5a7 7 0 0 0 10.8 7.3"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
      <path
        d="M18.5 14a7 7 0 0 0-8-8"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
    </svg>
  );
}

function PinIcon({ filled = false }: { filled?: boolean }) {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M12 17v5M9.5 3h5l1 6 3.5 2.5V14H5v-2.5L8.5 9 9.5 3Z"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
        fill={filled ? "currentColor" : "none"}
      />
    </svg>
  );
}

function ArchiveIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M4 7.5h16v11A1.5 1.5 0 0 1 18.5 20h-13A1.5 1.5 0 0 1 4 18.5v-11Z"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
      <path
        d="M3 5.5A1.5 1.5 0 0 1 4.5 4h15A1.5 1.5 0 0 1 21 5.5V7.5H3V5.5Z"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
      <path
        d="M10 12h4"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
    </svg>
  );
}

function TrashIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2M6.5 7l.8 11.2A1.5 1.5 0 0 0 8.8 19.5h6.4a1.5 1.5 0 0 0 1.5-1.3L17.5 7"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export { SidebarV2 as Sidebar };
