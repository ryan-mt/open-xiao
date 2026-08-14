import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { ModelSelect } from "./ModelSelect";
import { ToolApprovalDock } from "./ToolApprovalDock";
import { UserInputDock } from "./UserInputDock";
import { ContextWindowMeter } from "./ContextWindowMeter";
import {
  shouldUseCompactComposerFooter,
} from "./composerFooterLayout";
import type {
  AccessMode,
  AgentMode,
  PermissionMode,
  ProviderAvailability,
  ThinkingLevel,
  ModelProvider,
} from "../models";
import type { ImageAttachment } from "../types";
import type { PendingApproval } from "../toolApproval";
import { fileToAttachment } from "../types";
import type { LiveFileChangeSummary } from "../liveFileChanges";
import { ExpandedImageDialog } from "./ExpandedImageDialog";
import {
  buildExpandedImagePreview,
  type ExpandedImagePreview,
} from "./ExpandedImagePreview";
import type { QueuedSend } from "../sendQueue";
import type { StashEntry } from "../promptStash";
import {
  applySlashMenuSelection,
  buildSlashMenuItems,
  executeSlashInput,
  executeSlashMenuItem,
  getSlashQuery,
  slashCommandsForModel,
  type SlashCommandHandlers,
  type SlashMenuItem,
} from "../slashCommands";
import { searchProjectEntries } from "../auth";
import {
  applyFileMentionSelection,
  detectFileMentionTrigger,
  ownsFileMentionSearch,
  toFileMentionMenuItem,
  type FileMentionMenuItem,
  type FileMentionTrigger,
} from "../fileMentions";
import { surroundComposerSelection } from "../composerSelection";
import {
  KEYBINDING_COMMAND_EVENT,
  type KeybindingRule,
} from "../keybindings";
import { formatCompactDiffCount } from "../reviewChanges";
import type { ReviewComment } from "../reviewComments";
import type { UserInputRequest } from "../userInput";

const STASH_SNIPPET_MAX = 90;
const STASH_PULSE_MS = 1200;
const FILE_MENTION_DEBOUNCE_MS = 120;
const FILE_MENTION_LIMIT = 80;

type Props = {
  value: string;
  disabled?: boolean;
  placeholder?: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  onStop?: () => void;
  /** Queue current draft while a stream is running. */
  onQueue?: () => void;
  streaming?: boolean;
  autoFocus?: boolean;
  signedIn?: boolean;
  signedOutPlaceholder?: string;
  onRequestLogin?: () => void;
  modelId: string;
  thinking: ThinkingLevel;
  fastMode: boolean;
  accessMode: AccessMode;
  agentMode: AgentMode;
  permissionMode: PermissionMode;
  keybindings?: ReadonlyArray<KeybindingRule>;
  providerAvailability: ProviderAvailability;
  lockedProvider?: ModelProvider | null;
  onModelChange: (id: string) => void;
  onThinkingChange: (level: ThinkingLevel) => void;
  onFastModeChange: (enabled: boolean) => void;
  onAccessModeChange: (mode: AccessMode) => void;
  onAgentModeChange: (mode: AgentMode) => void;
  onPermissionModeChange: (mode: PermissionMode) => void;
  /** Tools parked in Ask mode waiting for approval. */
  pendingApprovals?: PendingApproval[];
  approvalBusyId?: string | null;
  onApproveTool?: (toolId: string) => void;
  onDenyTool?: (toolId: string) => void;
  onApproveAllTools?: () => void;
  onDenyAllTools?: () => void;
  pendingUserInput?: UserInputRequest | null;
  userInputBusy?: boolean;
  onSubmitUserInput?: (answers: string[][]) => void;
  onRejectUserInput?: () => void;
  attachments?: ImageAttachment[];
  onAttachmentsChange?: (next: ImageAttachment[]) => void;
  /** Invalidates in-flight image conversion when the active chat changes. */
  attachmentScopeId?: string | null;
  contextUsed?: number;
  contextLimit?: number;
  sendQueue?: QueuedSend[];
  onRemoveQueued?: (id: string) => void;
  /** Load queued item back into the composer for editing. */
  onEditQueued?: (id: string) => void;
  /** Interrupt live agent and send this queued item immediately. */
  onSendNowQueued?: (id: string) => void;
  stashEntries?: StashEntry[];
  onStash?: () => void;
  onRestoreStash?: (id: string) => void;
  onRemoveStash?: (id: string) => void;
  /** Live file edit summary for the active turn (Codex-style pill above composer). */
  liveFileChanges?: LiveFileChangeSummary | null;
  /** Open/toggle the review-changes side panel. */
  onOpenReviewChanges?: () => void;
  /** Whether the review panel is currently open (active pill state). */
  reviewOpen?: boolean;
  /** Local `/` commands (never sent to the model). */
  slashHandlers?: SlashCommandHandlers | null;
  /** Active project root for `@file` autocomplete. */
  projectPath?: string | null;
  reviewComments?: readonly ReviewComment[];
  onRemoveReviewComment?: (id: string) => void;
};

function stashEntrySnippet(entry: StashEntry): string {
  const trimmed = entry.prompt.trim().replace(/\s+/g, " ");
  if (trimmed.length > 0) {
    return trimmed.length > STASH_SNIPPET_MAX
      ? `${trimmed.slice(0, STASH_SNIPPET_MAX)}…`
      : trimmed;
  }
  const imageCount = entry.attachments.length + entry.droppedNames.length;
  return imageCount > 0
    ? `(${imageCount} image${imageCount === 1 ? "" : "s"})`
    : "(empty)";
}

function formatRelativeTime(ts: number): string {
  const sec = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (sec < 45) return "just now";
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m`;
  const hr = Math.round(min / 60);
  if (hr < 48) return `${hr}h`;
  const day = Math.round(hr / 24);
  if (day < 14) return `${day}d`;
  return new Date(ts).toLocaleDateString();
}

function ComposerMenuLayer({
  anchor,
  children,
}: {
  anchor: HTMLElement | null;
  children: ReactNode;
}) {
  const [position, setPosition] = useState<{
    bottom: number;
    left: number;
    maxHeight: number;
    width: number;
  } | null>(null);

  useLayoutEffect(() => {
    if (!anchor) {
      setPosition(null);
      return;
    }
    const update = () => {
      const rect = anchor.getBoundingClientRect();
      setPosition({
        bottom: window.innerHeight - rect.top + 8,
        left: rect.left,
        maxHeight: Math.max(96, rect.top - 24),
        width: rect.width,
      });
    };
    update();
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    const observer =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(update);
    observer?.observe(anchor);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
    };
  }, [anchor]);

  if (!position) return null;
  return createPortal(
    <div
      className="composer__menu-layer"
      style={{
        bottom: position.bottom,
        left: position.left,
        maxHeight: position.maxHeight,
        width: position.width,
      }}
    >
      {children}
    </div>,
    document.body,
  );
}

function isModKey(e: { metaKey: boolean; ctrlKey: boolean }): boolean {
  return e.metaKey || e.ctrlKey;
}

export function Composer({
  value,
  disabled,
  placeholder = "Ask anything...",
  onChange,
  onSubmit,
  onStop,
  onQueue,
  streaming,
  autoFocus,
  signedIn = true,
  signedOutPlaceholder = "Sign in to chat...",
  onRequestLogin,
  modelId,
  thinking,
  fastMode,
  accessMode,
  agentMode,
  permissionMode,
  keybindings = [],
  providerAvailability,
  lockedProvider = null,
  onModelChange,
  onThinkingChange,
  onFastModeChange,
  onAccessModeChange,
  onAgentModeChange,
  onPermissionModeChange,
  pendingApprovals = [],
  approvalBusyId = null,
  onApproveTool,
  onDenyTool,
  onApproveAllTools,
  onDenyAllTools,
  pendingUserInput = null,
  userInputBusy = false,
  onSubmitUserInput,
  onRejectUserInput,
  attachments = [],
  onAttachmentsChange,
  attachmentScopeId = null,
  contextUsed,
  contextLimit,
  sendQueue = [],
  onRemoveQueued,
  onEditQueued,
  onSendNowQueued,
  stashEntries = [],
  onStash,
  onRestoreStash,
  onRemoveStash,
  liveFileChanges = null,
  onOpenReviewChanges,
  reviewOpen = false,
  slashHandlers = null,
  projectPath = null,
  reviewComments = [],
  onRemoveReviewComment,
}: Props) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const stashMenuRef = useRef<HTMLDivElement>(null);
  const [composerMenuAnchor, setComposerMenuAnchor] =
    useState<HTMLDivElement | null>(null);
  const slashMenuRef = useRef<HTMLDivElement>(null);
  const atMenuRef = useRef<HTMLDivElement>(null);
  const [imagePreview, setImagePreview] = useState<ExpandedImagePreview | null>(
    null,
  );
  const [stashOpen, setStashOpen] = useState(false);
  const [stashHighlightId, setStashHighlightId] = useState<string | null>(null);
  const [stashPulse, setStashPulse] = useState<{
    key: number;
    active: boolean;
  }>({ key: 0, active: false });
  const stashPulseKeyRef = useRef(0);
  const stashPulseTimeoutRef = useRef<number | null>(null);
  const [footerCompact, setFooterCompact] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const dragDepthRef = useRef(0);
  const [slashIndex, setSlashIndex] = useState(0);
  /** User dismissed the menu with Escape until the draft leaves slash mode. */
  const [slashDismissed, setSlashDismissed] = useState(false);
  const [cursorPos, setCursorPos] = useState(0);
  const [atDismissed, setAtDismissed] = useState(false);
  const [atIndex, setAtIndex] = useState(0);
  const [atItems, setAtItems] = useState<FileMentionMenuItem[]>([]);
  const [atLoading, setAtLoading] = useState(false);
  const atSearchGenRef = useRef(0);
  const atTriggerRef = useRef<FileMentionTrigger | null>(null);
  const projectPathRef = useRef(projectPath);
  projectPathRef.current = projectPath;
  const attachmentScopeRef = useRef(attachmentScopeId);
  const attachmentEpochRef = useRef(0);
  const attachmentsRef = useRef(attachments);
  if (attachmentScopeRef.current !== attachmentScopeId) {
    attachmentScopeRef.current = attachmentScopeId;
    attachmentEpochRef.current += 1;
  }
  attachmentsRef.current = attachments;

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(Math.max(el.scrollHeight, 24), 200)}px`;
  }, [value]);

  useEffect(() => {
    if (autoFocus) ref.current?.focus();
  }, [autoFocus]);

  useEffect(() => {
    return () => {
      if (stashPulseTimeoutRef.current !== null) {
        window.clearTimeout(stashPulseTimeoutRef.current);
      }
    };
  }, []);

  useLayoutEffect(() => {
    const form = formRef.current;
    if (!form) return;
    const measure = () => shouldUseCompactComposerFooter(form.clientWidth);
    setFooterCompact(measure());
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      setFooterCompact((prev) => {
        const next = measure();
        return prev === next ? prev : next;
      });
    });
    observer.observe(form);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (stashEntries.length === 0) {
      setStashHighlightId(null);
      return;
    }
    if (!stashEntries.some((e) => e.id === stashHighlightId)) {
      setStashHighlightId(stashEntries[0]?.id ?? null);
    }
  }, [stashEntries, stashHighlightId]);

  const pulseStashBadge = useCallback(() => {
    stashPulseKeyRef.current += 1;
    setStashPulse({ key: stashPulseKeyRef.current, active: true });
    if (stashPulseTimeoutRef.current !== null) {
      window.clearTimeout(stashPulseTimeoutRef.current);
    }
    stashPulseTimeoutRef.current = window.setTimeout(() => {
      stashPulseTimeoutRef.current = null;
      setStashPulse((cur) => ({ ...cur, active: false }));
    }, STASH_PULSE_MS);
  }, []);

  const hasContent =
    value.trim().length > 0 ||
    attachments.length > 0 ||
    reviewComments.length > 0;
  const canSend = hasContent && !disabled && !streaming && signedIn;
  const canQueue =
    hasContent && !!streaming && signedIn && !!onQueue && !disabled;
  const canStash = hasContent && !!onStash;

  const slashQuery = slashHandlers ? getSlashQuery(value) : null;
  const slashCommands = useMemo(
    () => slashCommandsForModel(modelId),
    [modelId],
  );
  const slashItems = useMemo<SlashMenuItem[]>(() => {
    if (slashQuery == null || !slashHandlers) return [];
    return buildSlashMenuItems(value, slashCommands);
  }, [slashCommands, slashQuery, slashHandlers, value]);
  const slashOpen =
    !!slashHandlers &&
    slashQuery != null &&
    !slashDismissed &&
    slashItems.length > 0 &&
    signedIn &&
    !disabled;

  const atTrigger = useMemo(() => {
    if (!projectPath || !signedIn || disabled) return null;
    if (slashOpen || slashQuery != null) return null;
    return detectFileMentionTrigger(value, cursorPos);
  }, [
    projectPath,
    signedIn,
    disabled,
    slashOpen,
    slashQuery,
    value,
    cursorPos,
  ]);

  useEffect(() => {
    atTriggerRef.current = atTrigger;
  }, [atTrigger]);

  // Menu navigation only when there are selectable rows. Loading-only must not
  // trap Enter/arrows (user can still send while search is in flight).
  const atMenuEligible =
    !!atTrigger && !atDismissed && signedIn && !disabled && !slashOpen;
  const atOpen = atMenuEligible && atItems.length > 0;
  const atSearching = atMenuEligible && atLoading && atItems.length === 0;

  useEffect(() => {
    if (slashQuery == null) {
      setSlashDismissed(false);
    }
  }, [slashQuery]);

  useEffect(() => {
    if (!atTrigger) {
      atSearchGenRef.current += 1;
      setAtDismissed(false);
      setAtItems([]);
      setAtLoading(false);
    }
  }, [atTrigger]);

  // Reset highlight when the filtered list identity changes (draft edits).
  const slashItemsKey = slashItems.map((i) => i.key).join("|");
  useEffect(() => {
    setSlashIndex(0);
  }, [slashItemsKey]);

  const atItemsKey = atItems.map((i) => i.key).join("|");
  useEffect(() => {
    setAtIndex(0);
  }, [atItemsKey]);

  // Debounced project path search for `@` mentions.
  useEffect(() => {
    if (!atTrigger || !projectPath || atDismissed) {
      atSearchGenRef.current += 1;
      setAtLoading(false);
      setAtItems([]);
      return;
    }
    const gen = ++atSearchGenRef.current;
    const owner = {
      generation: gen,
      projectPath,
      query: atTrigger.query,
      rangeStart: atTrigger.rangeStart,
      rangeEnd: atTrigger.rangeEnd,
    };
    const ownsSearch = () =>
      ownsFileMentionSearch(
        owner,
        atSearchGenRef.current,
        projectPathRef.current,
        atTriggerRef.current,
      );
    setAtItems([]);
    setAtLoading(true);
    const handle = window.setTimeout(() => {
      void searchProjectEntries(
        projectPath,
        atTrigger.query,
        FILE_MENTION_LIMIT,
      )
        .then((entries) => {
          if (!ownsSearch()) return;
          setAtItems(entries.map(toFileMentionMenuItem));
        })
        .catch(() => {
          if (ownsSearch()) setAtItems([]);
        })
        .finally(() => {
          if (ownsSearch()) setAtLoading(false);
        });
    }, FILE_MENTION_DEBOUNCE_MS);
    return () => {
      window.clearTimeout(handle);
    };
  }, [atTrigger, projectPath, atDismissed]);

  const syncCursor = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    setCursorPos(el.selectionStart ?? el.value.length);
  }, []);

  const applySurroundSelection = useCallback(
    (input: string, el: HTMLTextAreaElement): boolean => {
      const next = surroundComposerSelection(
        el.value,
        el.selectionStart,
        el.selectionEnd,
        input,
      );
      if (!next) return false;

      const direction = el.selectionDirection;
      setSlashDismissed(false);
      setAtDismissed(false);
      onChange(next.value);
      setCursorPos(next.selectionEnd);
      requestAnimationFrame(() => {
        const current = ref.current;
        if (!current) return;
        current.focus();
        current.setSelectionRange(
          next.selectionStart,
          next.selectionEnd,
          direction,
        );
        setCursorPos(next.selectionEnd);
      });
      return true;
    },
    [onChange],
  );

  const runSlashItem = useCallback(
    (item: SlashMenuItem) => {
      if (!slashHandlers) return;
      const result = executeSlashMenuItem(item, slashHandlers);
      if (result.ok) {
        onChange("");
        setSlashDismissed(false);
        return;
      }
      if (result.reason === "incomplete") {
        onChange(applySlashMenuSelection(item));
        setSlashDismissed(false);
      }
    },
    [slashHandlers, onChange],
  );

  const runAtItem = useCallback(
    (item: FileMentionMenuItem) => {
      const trigger = atTriggerRef.current;
      if (!trigger) return;
      const { text, cursor } = applyFileMentionSelection(
        value,
        trigger,
        item.path,
      );
      onChange(text);
      setAtDismissed(false);
      setAtItems([]);
      // Restore caret after React commits the new value.
      requestAnimationFrame(() => {
        const el = ref.current;
        if (!el) return;
        el.focus();
        el.setSelectionRange(cursor, cursor);
        setCursorPos(cursor);
      });
    },
    [value, onChange],
  );

  const trySubmit = () => {
    // Prefer @-file selection when the path menu is open.
    if (atOpen && atItems[atIndex]) {
      runAtItem(atItems[atIndex]!);
      return;
    }

    // Local slash commands replace send — never forward `/model …` to the API.
    if (slashHandlers && getSlashQuery(value) != null) {
      if (slashOpen && slashItems[slashIndex]) {
        runSlashItem(slashItems[slashIndex]!);
        return;
      }
      const result = executeSlashInput(value, slashHandlers, slashCommands);
      if (result.ok) {
        onChange("");
        setSlashDismissed(false);
        return;
      }
      if (result.reason === "incomplete") {
        // Keep draft + menu so the user can pick an arg.
        return;
      }
      // unknown / bad-args: notify already fired; do not send to model.
      return;
    }

    if (streaming) {
      if (canQueue) {
        attachmentEpochRef.current += 1;
        onQueue?.();
        return;
      }
      onStop?.();
      return;
    }
    if (!signedIn) {
      onRequestLogin?.();
      return;
    }
    if (canSend) {
      attachmentEpochRef.current += 1;
      onSubmit();
    }
  };

  const doStash = useCallback(() => {
    if (!canStash) return;
    onStash?.();
    pulseStashBadge();
  }, [canStash, onStash, pulseStashBadge]);

  const addFiles = async (files: FileList | File[]) => {
    if (!onAttachmentsChange) return;
    const list = Array.from(files).filter((f) => f.type.startsWith("image/"));
    if (list.length === 0) return;
    const epoch = attachmentEpochRef.current;
    const scopeId = attachmentScopeRef.current;
    const next: ImageAttachment[] = [];
    for (const f of list.slice(0, 6)) {
      try {
        next.push(await fileToAttachment(f));
      } catch {
        /* skip invalid / oversized */
      }
    }
    if (next.length === 0) return;
    if (
      attachmentEpochRef.current !== epoch ||
      attachmentScopeRef.current !== scopeId
    ) {
      return;
    }
    const merged = [...attachmentsRef.current, ...next].slice(0, 8);
    attachmentsRef.current = merged;
    onAttachmentsChange(merged);
  };

  const contextUsage = useMemo(() => {
    if (contextUsed == null || contextLimit == null || contextLimit <= 0) {
      return null;
    }
    return {
      usedTokens: contextUsed,
      maxTokens: contextLimit,
      usedPercentage: Math.min(100, (contextUsed / contextLimit) * 100),
    };
  }, [contextUsed, contextLimit]);

  // ⌘/Ctrl+S stash or open menu; Escape closes stash
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (stashOpen) {
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          setStashOpen(false);
          return;
        }
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
          if (stashEntries.length === 0) return;
          event.preventDefault();
          event.stopPropagation();
          const currentIndex = stashEntries.findIndex(
            (e) => e.id === stashHighlightId,
          );
          const offset = event.key === "ArrowDown" ? 1 : -1;
          const base = currentIndex >= 0 ? currentIndex : offset === 1 ? -1 : 0;
          const nextIndex =
            (base + offset + stashEntries.length) % stashEntries.length;
          setStashHighlightId(stashEntries[nextIndex]?.id ?? null);
          return;
        }
        if (event.key === "Enter") {
          if (
            event.target instanceof HTMLElement &&
            event.target.closest("button[aria-label]")
          ) {
            return;
          }
          const entry =
            stashEntries.find((e) => e.id === stashHighlightId) ??
            stashEntries[0];
          if (!entry) return;
          event.preventDefault();
          event.stopPropagation();
          onRestoreStash?.(entry.id);
          setStashOpen(false);
          return;
        }
        if (event.key === "Backspace" && isModKey(event)) {
          const entry =
            stashEntries.find((e) => e.id === stashHighlightId) ??
            stashEntries[0];
          if (!entry) return;
          event.preventDefault();
          event.stopPropagation();
          onRemoveStash?.(entry.id);
          return;
        }
      }

    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [
    stashOpen,
    stashEntries,
    stashHighlightId,
    onRestoreStash,
    onRemoveStash,
    hasContent,
    canStash,
    doStash,
  ]);

  useEffect(() => {
    const onCommand = (event: Event) => {
      const detail = (event as CustomEvent<{ command?: string }>).detail;
      if (detail?.command !== "composer.stash") return;

      const active = document.activeElement;
      const inComposer =
        !!formRef.current &&
        (formRef.current.contains(active) || active === document.body);
      if (!inComposer && active instanceof HTMLElement) {
        const tag = active.tagName;
        if (tag === "INPUT" || tag === "TEXTAREA" || active.isContentEditable) return;
      }
      if (hasContent && canStash) {
        doStash();
      } else if (stashEntries.length > 0) {
        setStashOpen((open) => !open);
      }
    };
    window.addEventListener(KEYBINDING_COMMAND_EVENT, onCommand);
    return () => window.removeEventListener(KEYBINDING_COMMAND_EVENT, onCommand);
  }, [canStash, doStash, hasContent, stashEntries.length]);

  // Click outside stash menu
  useEffect(() => {
    if (!stashOpen) return;
    const onDoc = (e: MouseEvent) => {
      const t = e.target as Node;
      if (stashMenuRef.current?.contains(t)) return;
      if (
        t instanceof Element &&
        t.closest('[data-prompt-stash-badge="true"]')
      ) {
        return;
      }
      setStashOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [stashOpen]);

  useEffect(() => {
    setStashOpen(false);
  }, [value]);

  // Click outside slash menu dismisses until draft changes out of slash mode
  useEffect(() => {
    if (!slashOpen) return;
    const onDoc = (e: MouseEvent) => {
      const t = e.target as Node;
      if (slashMenuRef.current?.contains(t)) return;
      if (ref.current?.contains(t)) return;
      setSlashDismissed(true);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [slashOpen]);

  // Click outside @ file menu
  useEffect(() => {
    if (!atOpen) return;
    const onDoc = (e: MouseEvent) => {
      const t = e.target as Node;
      if (atMenuRef.current?.contains(t)) return;
      if (ref.current?.contains(t)) return;
      setAtDismissed(true);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [atOpen]);

  const showStop = !!streaming && !hasContent;

  const liveChangesRevision = liveFileChanges
    ? `${liveFileChanges.fileCount}:${liveFileChanges.additions}:${liveFileChanges.deletions}`
    : null;

  return (
    <div className="composer">
      {sendQueue.length > 0 ? (
        <div className="composer__queue" aria-label="Queued messages">
          {sendQueue.map((item, i) => (
            <div key={item.id} className="composer__queue-item">
              <span className="composer__queue-badge">#{i + 1}</span>
              <span className="composer__queue-text">
                {item.text ||
                  (item.attachments.length
                    ? `${item.attachments.length} image${item.attachments.length > 1 ? "s" : ""}`
                    : "Empty")}
              </span>
              {item.attachments.length > 0 ? (
                <span className="composer__queue-atts">
                  {item.attachments.length} img
                </span>
              ) : null}
              {onEditQueued ? (
                <button
                  type="button"
                  className="composer__queue-edit"
                  aria-label="Edit queued message"
                  title="Edit — move back to composer"
                  onClick={() => onEditQueued(item.id)}
                >
                  <QueueEditIcon />
                </button>
              ) : null}
              {onSendNowQueued ? (
                <button
                  type="button"
                  className="composer__queue-send-now"
                  aria-label="Send now"
                  title="Send now — soft-cuts the agent and continues with prior tool context"
                  onClick={() => onSendNowQueued(item.id)}
                >
                  Send now
                </button>
              ) : null}
              <button
                type="button"
                className="composer__queue-x"
                aria-label="Remove from queue"
                onClick={() => onRemoveQueued?.(item.id)}
              >
                ×
              </button>
            </div>
          ))}
        </div>
      ) : null}

      {pendingApprovals.length > 0 && onApproveTool && onDenyTool ? (
        <ToolApprovalDock
          items={pendingApprovals}
          busyId={approvalBusyId}
          onApprove={onApproveTool}
          onDeny={onDenyTool}
          onApproveAll={onApproveAllTools}
          onDenyAll={onDenyAllTools}
        />
      ) : null}

      {pendingUserInput && onSubmitUserInput && onRejectUserInput ? (
        <UserInputDock
          request={pendingUserInput}
          busy={userInputBusy}
          onSubmit={onSubmitUserInput}
          onReject={onRejectUserInput}
        />
      ) : null}

      {liveFileChanges ? (
        <button
          type="button"
          className={`composer-live-changes${reviewOpen ? " is-active" : ""}${onOpenReviewChanges ? " is-clickable" : ""}`}
          aria-live="polite"
          aria-pressed={reviewOpen || undefined}
          aria-label={
            reviewOpen
              ? `${liveFileChanges.fileCount} files changed. Hide review panel`
              : `${liveFileChanges.fileCount} files changed, +${liveFileChanges.additions} -${liveFileChanges.deletions}. Open review`
          }
          title={reviewOpen ? "Hide review changes" : "Review changes"}
          disabled={!onOpenReviewChanges}
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            onOpenReviewChanges?.();
          }}
        >
          <ChangesIcon />
          <span key={liveChangesRevision ?? "0"}>
            <span>
              {formatCompactDiffCount(liveFileChanges.fileCount)}{" "}
              {liveFileChanges.fileCount === 1 ? "file" : "files"} changed
            </span>
            <b>+{formatCompactDiffCount(liveFileChanges.additions)}</b>
            <em>-{formatCompactDiffCount(liveFileChanges.deletions)}</em>
          </span>
        </button>
      ) : null}

      <form
        ref={formRef}
        data-chat-composer-form="true"
        className={`composer__shell${streaming ? " is-streaming" : ""}${!signedIn ? " is-locked" : ""}${dragOver ? " is-dragover" : ""}${footerCompact ? " is-footer-compact" : ""}`}
        onSubmit={(e) => {
          e.preventDefault();
          trySubmit();
        }}
        onDragEnter={(e) => {
          e.preventDefault();
          dragDepthRef.current += 1;
          if (e.dataTransfer?.types?.includes("Files")) setDragOver(true);
        }}
        onDragOver={(e) => {
          e.preventDefault();
        }}
        onDragLeave={(e) => {
          e.preventDefault();
          dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
          if (dragDepthRef.current === 0) setDragOver(false);
        }}
        onDrop={(e) => {
          e.preventDefault();
          dragDepthRef.current = 0;
          setDragOver(false);
          if (e.dataTransfer.files?.length) void addFiles(e.dataTransfer.files);
        }}
      >
        <div className="composer__surface">
          <div ref={setComposerMenuAnchor} className="composer__main">
            {stashEntries.length > 0 ? (
              <button
                type="button"
                data-prompt-stash-badge="true"
                className={`composer__stash-badge${stashOpen || stashPulse.active ? " is-open" : ""}`}
                aria-label={`Stashed prompts: ${stashEntries.length}. Open stash.`}
                aria-expanded={stashOpen}
                onPointerDown={(e) => {
                  e.preventDefault();
                }}
                onClick={() => setStashOpen((o) => !o)}
              >
                <BookmarkIcon />
                Stash
                <span
                  key={stashPulse.key}
                  className={`composer__stash-count${stashPulse.active ? " is-pulse" : ""}`}
                >
                  {stashEntries.length}
                </span>
              </button>
            ) : null}

            {stashOpen ? (
              <ComposerMenuLayer anchor={composerMenuAnchor}>
                <div
                  ref={stashMenuRef}
                  className="composer__stash-menu"
                  role="menu"
                  aria-label="Stashed prompts"
                >
                  <div className="composer__stash-menu-label">
                    <BookmarkIcon />
                    Stashed prompts
                  </div>
                  {stashEntries.length === 0 ? (
                    <p className="composer__stash-empty">
                      Nothing stashed yet. Press Ctrl+S with a prompt in the
                      composer to stash it.
                    </p>
                  ) : (
                    stashEntries.map((entry) => {
                      const highlighted = entry.id === stashHighlightId;
                      return (
                        <div
                          key={entry.id}
                          className={`composer__stash-row${highlighted ? " is-active" : ""}`}
                          role="menuitem"
                          onMouseDown={(e) => e.preventDefault()}
                          onMouseMove={() => {
                            if (stashHighlightId !== entry.id) {
                              setStashHighlightId(entry.id);
                            }
                          }}
                          onClick={() => {
                            onRestoreStash?.(entry.id);
                            setStashOpen(false);
                          }}
                        >
                          {entry.attachments.length > 0 ? (
                            <span
                              className="composer__stash-thumbs"
                              aria-hidden
                            >
                              {entry.attachments
                                .slice(0, 3)
                                .map((a) =>
                                  a.dataUrl ? (
                                    <img
                                      key={a.id}
                                      src={a.dataUrl}
                                      alt=""
                                      className="composer__stash-thumb"
                                    />
                                  ) : null,
                                )}
                            </span>
                          ) : (
                            <span className="composer__stash-ico" aria-hidden>
                              <BookmarkIcon />
                            </span>
                          )}
                          <span className="composer__stash-prompt">
                            {stashEntrySnippet(entry)}
                          </span>
                          {entry.droppedNames.length > 0 ? (
                            <span className="composer__stash-warn">
                              {entry.droppedNames.length} dropped
                            </span>
                          ) : null}
                          <span className="composer__stash-time">
                            {formatRelativeTime(entry.createdAt)}
                          </span>
                          <button
                            type="button"
                            className="composer__stash-del"
                            aria-label="Delete stashed prompt"
                            onClick={(e) => {
                              e.stopPropagation();
                              onRemoveStash?.(entry.id);
                            }}
                          >
                            <StashCloseIcon />
                          </button>
                        </div>
                      );
                    })
                  )}
                </div>
              </ComposerMenuLayer>
            ) : null}

            {attachments.length > 0 ? (
              <div className="composer__atts">
                {attachments.map((a) => (
                  <div key={a.id} className="composer__att">
                    {a.dataUrl ? (
                      <button
                        type="button"
                        className="composer__att-btn"
                        aria-label={`Preview ${a.name}`}
                        onClick={() => {
                          const preview = buildExpandedImagePreview(
                            attachments,
                            a.id,
                          );
                          if (preview) setImagePreview(preview);
                        }}
                      >
                        <img src={a.dataUrl} alt={a.name} draggable={false} />
                      </button>
                    ) : (
                      <div className="composer__att-fallback">{a.name}</div>
                    )}
                    <button
                      type="button"
                      className="composer__att-x"
                      aria-label={`Remove ${a.name}`}
                      onClick={() => {
                        attachmentEpochRef.current += 1;
                        const next = attachments.filter((x) => x.id !== a.id);
                        attachmentsRef.current = next;
                        onAttachmentsChange?.(next);
                      }}
                    >
                      ×
                    </button>
                  </div>
                ))}
              </div>
            ) : null}

            {reviewComments.length > 0 ? (
              <div
                className="composer__review-comments"
                aria-label="Review comments"
              >
                {reviewComments.map((comment) => (
                  <span key={comment.id} className="composer__review-comment">
                    <ReviewCommentIcon />
                    <strong>{comment.filePath}</strong>
                    <span>{comment.rangeLabel}</span>
                    <button
                      type="button"
                      aria-label={`Remove review comment for ${comment.filePath} ${comment.rangeLabel}`}
                      onClick={() => onRemoveReviewComment?.(comment.id)}
                    >
                      ×
                    </button>
                  </span>
                ))}
              </div>
            ) : null}

            <div className="composer__body">
              {slashOpen ? (
                <div
                  ref={slashMenuRef}
                  className="composer__slash-menu"
                  role="listbox"
                  aria-label="Slash commands"
                  id="composer-slash-listbox"
                >
                  <div className="composer__slash-menu-label">Commands</div>
                  {slashItems.map((item, i) => {
                    const active = i === slashIndex;
                    return (
                      <button
                        key={item.key}
                        type="button"
                        role="option"
                        aria-selected={active}
                        id={`composer-slash-opt-${i}`}
                        className={`composer__slash-item${active ? " is-active" : ""}`}
                        onMouseEnter={() => setSlashIndex(i)}
                        onMouseDown={(e) => {
                          // Keep focus in textarea; run on click.
                          e.preventDefault();
                        }}
                        onClick={() => runSlashItem(item)}
                      >
                        <span className="composer__slash-item-main">
                          <span className="composer__slash-item-label">
                            {item.label}
                          </span>
                          {item.hint ? (
                            <span className="composer__slash-item-hint">
                              {item.hint}
                            </span>
                          ) : null}
                        </span>
                        <span className="composer__slash-item-desc">
                          {item.description}
                        </span>
                      </button>
                    );
                  })}
                </div>
              ) : null}

              {atOpen || atSearching ? (
                <div
                  ref={atMenuRef}
                  className="composer__slash-menu composer__at-menu"
                  role="listbox"
                  aria-label="Project files"
                  id="composer-at-listbox"
                >
                  <div className="composer__slash-menu-label">Files</div>
                  {atSearching ? (
                    <div className="composer__at-empty">
                      Searching project files…
                    </div>
                  ) : (
                    atItems.map((item, i) => {
                      const active = i === atIndex;
                      return (
                        <button
                          key={item.key}
                          type="button"
                          role="option"
                          aria-selected={active}
                          id={`composer-at-opt-${i}`}
                          className={`composer__slash-item${active ? " is-active" : ""}`}
                          title={item.path}
                          onMouseEnter={() => setAtIndex(i)}
                          onMouseDown={(e) => {
                            e.preventDefault();
                          }}
                          onClick={() => runAtItem(item)}
                        >
                          <span className="composer__slash-item-main">
                            <span className="composer__slash-item-label">
                              {item.isDir ? `${item.label}/` : item.label}
                            </span>
                            <span className="composer__slash-item-hint">
                              {item.isDir ? "folder" : "file"}
                            </span>
                          </span>
                          <span className="composer__slash-item-desc">
                            {item.description}
                          </span>
                        </button>
                      );
                    })
                  )}
                </div>
              ) : null}

              <textarea
                ref={ref}
                className="composer__input"
                rows={1}
                value={value}
                disabled={(disabled && !streaming) || !signedIn}
                placeholder={
                  signedIn
                    ? streaming && hasContent
                      ? "Enter to queue..."
                      : projectPath && slashHandlers
                        ? `${placeholder} (@ files · / commands)`
                        : projectPath
                          ? `${placeholder} (@ for files)`
                          : slashHandlers
                            ? `${placeholder} (/ for commands)`
                            : placeholder
                    : signedOutPlaceholder
                }
                role="combobox"
                aria-expanded={slashOpen || atOpen}
                aria-controls={
                  slashOpen
                    ? "composer-slash-listbox"
                    : atOpen
                      ? "composer-at-listbox"
                      : undefined
                }
                aria-activedescendant={
                  slashOpen
                    ? `composer-slash-opt-${slashIndex}`
                    : atOpen
                      ? `composer-at-opt-${atIndex}`
                      : undefined
                }
                aria-autocomplete={slashOpen || atOpen ? "list" : undefined}
                onBeforeInput={(e) => {
                  const inputEvent = e.nativeEvent as InputEvent;
                  if (
                    inputEvent.inputType !== "insertText" ||
                    inputEvent.isComposing ||
                    typeof inputEvent.data !== "string"
                  ) {
                    return;
                  }
                  if (
                    applySurroundSelection(inputEvent.data, e.currentTarget)
                  ) {
                    e.preventDefault();
                  }
                }}
                onChange={(e) => {
                  setSlashDismissed(false);
                  setAtDismissed(false);
                  onChange(e.target.value);
                  setCursorPos(
                    e.target.selectionStart ?? e.target.value.length,
                  );
                }}
                onSelect={syncCursor}
                onClick={syncCursor}
                onKeyUp={syncCursor}
                onPaste={(e) => {
                  const items = e.clipboardData?.items;
                  if (!items) return;
                  const files: File[] = [];
                  for (const item of items) {
                    if (
                      item.kind === "file" &&
                      item.type.startsWith("image/")
                    ) {
                      const f = item.getAsFile();
                      if (f) files.push(f);
                    }
                  }
                  if (files.length) {
                    e.preventDefault();
                    void addFiles(files);
                  }
                }}
                onKeyDown={(e) => {
                  if (atOpen) {
                    if (e.key === "ArrowDown") {
                      e.preventDefault();
                      setAtIndex((i) =>
                        atItems.length === 0
                          ? 0
                          : Math.min(atItems.length - 1, i + 1),
                      );
                      return;
                    }
                    if (e.key === "ArrowUp") {
                      e.preventDefault();
                      setAtIndex((i) => Math.max(0, i - 1));
                      return;
                    }
                    if (e.key === "Tab") {
                      const item = atItems[atIndex];
                      if (item) {
                        e.preventDefault();
                        runAtItem(item);
                      }
                      return;
                    }
                    if (e.key === "Escape") {
                      e.preventDefault();
                      e.stopPropagation();
                      setAtDismissed(true);
                      return;
                    }
                  }

                  if (slashOpen) {
                    if (e.key === "ArrowDown") {
                      e.preventDefault();
                      setSlashIndex((i) =>
                        Math.min(slashItems.length - 1, i + 1),
                      );
                      return;
                    }
                    if (e.key === "ArrowUp") {
                      e.preventDefault();
                      setSlashIndex((i) => Math.max(0, i - 1));
                      return;
                    }
                    if (e.key === "Tab") {
                      const item = slashItems[slashIndex];
                      if (item) {
                        e.preventDefault();
                        onChange(applySlashMenuSelection(item));
                        setSlashDismissed(false);
                      }
                      return;
                    }
                    if (e.key === "Escape") {
                      e.preventDefault();
                      e.stopPropagation();
                      setSlashDismissed(true);
                      return;
                    }
                  }

                  if (
                    !e.defaultPrevented &&
                    !e.nativeEvent.isComposing &&
                    !isModKey(e) &&
                    applySurroundSelection(e.key, e.currentTarget)
                  ) {
                    e.preventDefault();
                    return;
                  }

                  if (
                    e.key === "Enter" &&
                    !e.shiftKey &&
                    !e.nativeEvent.isComposing
                  ) {
                    e.preventDefault();
                    trySubmit();
                  }
                }}
              />
            </div>
          </div>

          <div
            data-chat-composer-footer="true"
            data-chat-composer-footer-compact={footerCompact ? "true" : "false"}
            className={`composer__footer${footerCompact ? " is-compact" : ""}`}
          >
            <div className="composer__controls">
              <ModelSelect
                modelId={modelId}
                thinking={thinking}
                fastMode={fastMode}
                accessMode={accessMode}
                agentMode={agentMode}
                permissionMode={permissionMode}
                keybindings={keybindings}
                providerAvailability={providerAvailability}
                lockedProvider={lockedProvider}
                disabled={disabled}
                compact={footerCompact}
                onModelChange={onModelChange}
                onThinkingChange={onThinkingChange}
                onFastModeChange={onFastModeChange}
                onAccessModeChange={onAccessModeChange}
                onAgentModeChange={onAgentModeChange}
                onPermissionModeChange={onPermissionModeChange}
              />

            </div>

            <div
              data-chat-composer-actions="right"
              className="composer__actions"
            >
              {contextUsage ? (
                <ContextWindowMeter usage={contextUsage} />
              ) : null}

              {showStop ? (
                <button
                  type="button"
                  className="composer__send is-stop"
                  onPointerDown={(e) => e.preventDefault()}
                  onClick={() => onStop?.()}
                  aria-label="Stop generation"
                  title="Stop"
                >
                  <StopIcon />
                </button>
              ) : (
                <button
                  type="submit"
                  className={`composer__send${canQueue ? " is-queue" : ""}`}
                  disabled={signedIn ? !(canSend || canQueue) : false}
                  onPointerDown={(e) => {
                    // Preserve focus in textarea after send/stop.
                    if (signedIn) e.preventDefault();
                  }}
                  aria-label={canQueue ? "Queue message" : "Send message"}
                  title={
                    canQueue ? "Queue" : signedIn ? "Send" : "Sign in to send"
                  }
                >
                  {canQueue ? <QueueIcon /> : <ArrowUpIcon />}
                </button>
              )}
            </div>
          </div>
        </div>
      </form>

      {imagePreview ? (
        <ExpandedImageDialog
          preview={imagePreview}
          onClose={() => setImagePreview(null)}
        />
      ) : null}
    </div>
  );
}

function ReviewCommentIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M5 5.5h14v10H9l-4 3v-13Z"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function ChangesIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinejoin="round"
      />
      <path
        d="M14 2v6h6"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M9 13h6M9 17h4"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
      />
    </svg>
  );
}

function BookmarkIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M6 4h12a1 1 0 0 1 1 1v16l-7-4-7 4V5a1 1 0 0 1 1-1z"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function StashCloseIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M6 6l12 12M18 6 6 18"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
      />
    </svg>
  );
}

function ArrowUpIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden>
      <path
        d="M7 11.5V2.5M7 2.5L3 6.5M7 2.5L11 6.5"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function QueueEditIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M12 20h9M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5Z"
        stroke="currentColor"
        strokeWidth="1.85"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function QueueIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M4 6h16M4 12h10M4 18h16"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
    </svg>
  );
}

function StopIcon() {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 12 12"
      fill="currentColor"
      aria-hidden
    >
      <rect x="2" y="2" width="8" height="8" rx="1.5" />
    </svg>
  );
}
