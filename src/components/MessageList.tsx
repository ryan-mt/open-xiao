import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { ImageAttachment, Message, ToolCall } from "../types";
import {
  normalizeUserFacingError,
  presentTaskFailure,
  redactSensitiveText,
  redactSensitiveValues,
  type UserFacingError,
} from "../lib/userFacingError";
import {
  compactTimelineGroups,
  groupMessageParts,
  resolveMessageParts,
} from "../messageParts";
import { Markdown } from "./Markdown";
import { ExpandedImageDialog } from "./ExpandedImageDialog";
import {
  buildExpandedImagePreview,
  type ExpandedImagePreview,
} from "./ExpandedImagePreview";
import {
  foldTodoTimelineGroups,
  isTodoToolName,
  parsePlanStepsFromToolPayload,
  planInlineSummary,
  type PlanStep,
  type PlanStepStatus,
} from "../plan";
import {
  collectMessageReviewFileChanges,
  parseToolResultHeaderStats,
} from "../reviewChanges";
import { ChangedFilesCard } from "./ChangedFilesCard";
import {
  sanitizeThinkingContent,
  sanitizeUserFacingContent,
} from "../sanitizeContent";
import {
  isTaskToolName,
  parseTaskResult,
  taskPresentation,
  taskRoleClass,
  type TaskRole,
} from "../taskTool";
import { stripFollowUpInterruptNote } from "../chat/followUpInterrupt";
import { parseJsonObject } from "../lib/parseJsonObject";
import {
  isEditTool,
  isFileMutationTool,
  isWriteTool,
} from "../review/mutationTools";
import { toolActivityKind } from "../toolActivity";

type ScrollMode = "following-end" | "anchoring-new-turn" | "free";

type Props = {
  messages: Message[];
  streaming: boolean;
  /** Epoch ms when the active stream began (for live "Working Nm"). */
  streamStartedAt?: number | null;
  /** Last stream failure for this thread (sidebar Failed + in-chat banner). */
  lastError?: UserFacingError | null;
  /** Prefer collapsed thinking labels (user can still expand per block). */
  collapseThinking?: boolean;
  onEditUser?: (messageId: string) => void;
  onRetryUser?: (messageId: string) => void;
  onForkUser?: (messageId: string) => void;
  onRegenerate?: (messageId: string) => void;
  /** Retry the last failed turn from the stream-error banner. */
  onRetryError?: () => void;
  onDismissError?: () => void;
  onOpenErrorSettings?: () => void;
  /** Approve a tool parked in Ask mode. */
  onApproveTool?: (toolId: string) => void;
  /** Deny a tool parked in Ask mode. */
  onDenyTool?: (toolId: string) => void;
  approvalBusyId?: string | null;
  /** Open the existing Review Changes panel for the active turn. */
  onOpenReviewChanges?: () => void;
};

const NEAR_BOTTOM_PX = 80;
const ANCHOR_TOP_PAD = 12;

export const MessageList = memo(function MessageList({
  messages,
  streaming,
  streamStartedAt = null,
  lastError = null,
  collapseThinking = false,
  onEditUser,
  onRetryUser,
  onForkUser,
  onRegenerate,
  onRetryError,
  onDismissError,
  onOpenErrorSettings,
  onApproveTool,
  onDenyTool,
  approvalBusyId = null,
  onOpenReviewChanges,
}: Props) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const modeRef = useRef<ScrollMode>("following-end");
  const anchorMsgIdRef = useRef<string | null>(null);
  const lastUserIdRef = useRef<string | null>(null);
  /** True only for real user input (wheel/touch/drag), not programmatic stick. */
  const userScrollIntentRef = useRef(false);
  const programmaticScrollRef = useRef(false);
  const progScrollClearTimer = useRef(0);
  const [showJump, setShowJump] = useState(false);
  const [mode, setMode] = useState<ScrollMode>("following-end");
  const [imagePreview, setImagePreview] =
    useState<ExpandedImagePreview | null>(null);

  const lastUserId = (() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === "user") return messages[i].id;
    }
    return null;
  })();

  const distanceFromBottom = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return 0;
    return el.scrollHeight - el.scrollTop - el.clientHeight;
  }, []);

  const markProgrammaticScroll = useCallback(() => {
    programmaticScrollRef.current = true;
    window.clearTimeout(progScrollClearTimer.current);
    // Keep flag through scroll events + layout; tool rows can multi-frame grow.
    progScrollClearTimer.current = window.setTimeout(() => {
      programmaticScrollRef.current = false;
    }, 80);
  }, []);

  const scrollToEnd = useCallback(
    (behavior: ScrollBehavior = "auto") => {
      const el = scrollRef.current;
      if (!el) return;
      markProgrammaticScroll();
      const top = el.scrollHeight;
      if (behavior === "smooth") {
        el.scrollTo({ top, behavior });
      } else {
        el.scrollTop = top;
      }
    },
    [markProgrammaticScroll],
  );

  const pinAnchorTop = useCallback(() => {
    const sc = scrollRef.current;
    const id = anchorMsgIdRef.current;
    if (!sc || !id) return false;
    const node = sc.querySelector(
      `[data-msg-id="${CSS.escape(id)}"]`,
    ) as HTMLElement | null;
    if (!node) return false;
    const nextTop = Math.max(0, node.offsetTop - ANCHOR_TOP_PAD);
    if (Math.abs(sc.scrollTop - nextTop) > 1) {
      markProgrammaticScroll();
      sc.scrollTop = nextTop;
    }
    return true;
  }, [markProgrammaticScroll]);

  const applyScroll = useCallback(() => {
    const sc = scrollRef.current;
    if (!sc) return;
    // Don't fight the user while they are actively scrolling away.
    if (userScrollIntentRef.current && modeRef.current === "free") {
      setShowJump(distanceFromBottom() > NEAR_BOTTOM_PX && messages.length > 0);
      return;
    }

    const m = modeRef.current;

    if (m === "free") {
      setShowJump(distanceFromBottom() > NEAR_BOTTOM_PX && messages.length > 0);
      return;
    }

    if (m === "following-end") {
      scrollToEnd("auto");
      setShowJump(false);
      return;
    }

    // anchoring-new-turn: pin user bubble until the turn no longer fits,
    // then stick to bottom so tool rows / edits stay in view.
    const id = anchorMsgIdRef.current;
    const node = id
      ? (sc.querySelector(
          `[data-msg-id="${CSS.escape(id)}"]`,
        ) as HTMLElement | null)
      : null;
    if (!node) {
      modeRef.current = "following-end";
      setMode("following-end");
      scrollToEnd("auto");
      return;
    }

    const turnBottom = (() => {
      const arts = sc.querySelectorAll(".timeline__list > .turn");
      const last = arts[arts.length - 1] as HTMLElement | undefined;
      if (!last) return node.offsetTop + node.offsetHeight;
      return last.offsetTop + last.offsetHeight;
    })();

    const usable = Math.max(120, sc.clientHeight - 24);
    const turnHeight = turnBottom - node.offsetTop;
    // Switch early (before overflow) so edit/write rows aren't clipped.
    if (turnHeight > usable * 0.85 || distanceFromBottom() > NEAR_BOTTOM_PX) {
      modeRef.current = "following-end";
      setMode("following-end");
      scrollToEnd("auto");
      setShowJump(false);
      return;
    }

    pinAnchorTop();
    setShowJump(false);
  }, [distanceFromBottom, messages.length, pinAnchorTop, scrollToEnd]);

  // New user turn -> anchor that message near top
  useLayoutEffect(() => {
    if (!lastUserId) return;
    if (lastUserId === lastUserIdRef.current) return;
    lastUserIdRef.current = lastUserId;
    anchorMsgIdRef.current = lastUserId;
    userScrollIntentRef.current = false;
    modeRef.current = "anchoring-new-turn";
    setMode("anchoring-new-turn");
    // next frame so DOM has the new bubble
    requestAnimationFrame(() => {
      pinAnchorTop();
      requestAnimationFrame(applyScroll);
    });
  }, [lastUserId, pinAnchorTop, applyScroll]);

  // Content growth while streaming / tools — one rAF so token bursts
  // do not force multiple layout reads in the same frame.
  const scrollRafRef = useRef(0);
  const scheduleApplyScroll = useCallback(() => {
    if (scrollRafRef.current) return;
    scrollRafRef.current = requestAnimationFrame(() => {
      scrollRafRef.current = 0;
      applyScroll();
    });
  }, [applyScroll]);

  useLayoutEffect(() => {
    scheduleApplyScroll();
  }, [messages, streaming, scheduleApplyScroll]);

  useEffect(
    () => () => {
      if (scrollRafRef.current) {
        cancelAnimationFrame(scrollRafRef.current);
        scrollRafRef.current = 0;
      }
    },
    [],
  );

  // ResizeObserver: markdown/code/tool rows grow async (edit/write collapse, hljs, etc.)
  useEffect(() => {
    const list = listRef.current;
    if (!list || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => {
      if (modeRef.current === "free") {
        setShowJump(
          distanceFromBottom() > NEAR_BOTTOM_PX && messages.length > 0,
        );
        return;
      }
      // Single rAF coalesce — double-rAF was burning two frames per tool row.
      scheduleApplyScroll();
    });
    ro.observe(list);
    return () => {
      ro.disconnect();
    };
  }, [distanceFromBottom, messages.length, scheduleApplyScroll]);

  // User scroll intent -> free vs following (ignore programmatic stick scrolls)
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;

    let intentClearTimer = 0;
    const markUserIntent = (e: Event) => {
      if (programmaticScrollRef.current) return;
      // Clicks on tools/buttons are not "scroll away" intent.
      const t = e.target;
      if (t instanceof Element) {
        if (
          t.closest(
            "button, a, input, textarea, summary, [role='button'], .tool, .msg-action",
          )
        ) {
          return;
        }
      }
      userScrollIntentRef.current = true;
      window.clearTimeout(intentClearTimer);
      intentClearTimer = window.setTimeout(() => {
        userScrollIntentRef.current = false;
      }, 160);
    };

    const onScroll = () => {
      if (programmaticScrollRef.current) {
        // Still sync jump affordance after our own stick.
        if (modeRef.current === "following-end") setShowJump(false);
        return;
      }

      const near = distanceFromBottom() <= NEAR_BOTTOM_PX;
      if (near) {
        userScrollIntentRef.current = false;
        if (modeRef.current !== "following-end") {
          modeRef.current = "following-end";
          setMode("following-end");
        }
        setShowJump(false);
        return;
      }

      // Only leave stick modes when the user actually scrolled.
      if (!userScrollIntentRef.current) return;

      if (modeRef.current === "anchoring-new-turn") {
        const id = anchorMsgIdRef.current;
        const node = id
          ? (el.querySelector(
              `[data-msg-id="${CSS.escape(id)}"]`,
            ) as HTMLElement | null)
          : null;
        if (node) {
          const expected = Math.max(0, node.offsetTop - ANCHOR_TOP_PAD);
          if (Math.abs(el.scrollTop - expected) <= 48) return;
        }
      }

      if (modeRef.current !== "free") {
        modeRef.current = "free";
        setMode("free");
      }
      setShowJump(messages.length > 0);
    };

    el.addEventListener("wheel", markUserIntent, { passive: true });
    el.addEventListener("touchstart", markUserIntent, { passive: true });
    el.addEventListener("pointerdown", markUserIntent, { passive: true });
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      el.removeEventListener("wheel", markUserIntent);
      el.removeEventListener("touchstart", markUserIntent);
      el.removeEventListener("pointerdown", markUserIntent);
      el.removeEventListener("scroll", onScroll);
      window.clearTimeout(intentClearTimer);
    };
  }, [distanceFromBottom, messages.length]);

  // Thread switch: reset stick
  useEffect(() => {
    modeRef.current = "following-end";
    setMode("following-end");
    userScrollIntentRef.current = false;
    anchorMsgIdRef.current = lastUserId;
    lastUserIdRef.current = lastUserId;
    requestAnimationFrame(() => scrollToEnd("auto"));
    // only when first message id set changes (thread swap)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages[0]?.id]);

  useEffect(() => {
    return () => window.clearTimeout(progScrollClearTimer.current);
  }, []);

  const jumpToEnd = () => {
    userScrollIntentRef.current = false;
    modeRef.current = "following-end";
    setMode("following-end");
    setShowJump(false);
    scrollToEnd("smooth");
  };

  const lastAssistantId = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === "assistant") return messages[i].id;
    }
    return null;
  }, [messages]);

  const onExpandImage = useCallback((preview: ExpandedImagePreview) => {
    setImagePreview(preview);
  }, []);

  if (messages.length === 0) return null;

  return (
    <div
      ref={scrollRef}
      className={`chat-scroll${streaming ? " is-streaming" : ""}${mode === "following-end" ? " is-following" : ""}`}
    >
      <div className="timeline" ref={listRef}>
        <div className="timeline__list">
          {messages.map((m, i) => {
            const isLast = i === messages.length - 1;
            const isStreamingAssistant =
              streaming && isLast && m.role === "assistant";

            // Hide empty streaming shell - Working row covers it
            if (
              isStreamingAssistant &&
              resolveMessageParts(m).length === 0
            ) {
              return null;
            }

            return (
              <TurnArticle
                key={m.id}
                message={m}
                streamingAssistant={isStreamingAssistant}
                collapseThinking={collapseThinking}
                canEdit={!streaming && !!onEditUser}
                canRetry={!streaming && !!onRetryUser}
                canFork={!streaming && !!onForkUser}
                canRegenerate={
                  !streaming &&
                  !!onRegenerate &&
                  m.id === lastAssistantId
                }
                latestAssistant={m.id === lastAssistantId}
                onExpandImage={onExpandImage}
                onEditUser={onEditUser}
                onRetryUser={onRetryUser}
                onForkUser={onForkUser}
                onRegenerate={onRegenerate}
                onApproveTool={onApproveTool}
                onDenyTool={onDenyTool}
                approvalBusyId={approvalBusyId}
                onOpenReviewChanges={onOpenReviewChanges}
              />
            );
          })}

          {streaming ? (
            <div className="turn turn--working">
              <WorkingLabel startedAt={streamStartedAt} />
            </div>
          ) : lastError ? (
            <div className="turn turn--error" role="alert">
              <div className={`stream-error is-${lastError.category}`}>
                <span className="stream-error__signal" aria-hidden />
                <div className="stream-error__body">
                  <span className="stream-error__label">{lastError.title}</span>
                  <span className="stream-error__msg">{lastError.message}</span>
                  {lastError.detail ? (
                    <span className="stream-error__detail">
                      {lastError.detail}
                    </span>
                  ) : null}
                  <div className="stream-error__actions">
                    {lastError.retryable && onRetryError ? (
                      <button
                        type="button"
                        className="stream-error__action is-primary"
                        onClick={onRetryError}
                      >
                        Try again
                      </button>
                    ) : lastError.action === "settings" &&
                      onOpenErrorSettings ? (
                      <button
                        type="button"
                        className="stream-error__action"
                        onClick={onOpenErrorSettings}
                      >
                        Open Settings
                      </button>
                    ) : null}
                    {onDismissError ? (
                      <button
                        type="button"
                        className="stream-error__action"
                        onClick={onDismissError}
                      >
                        Dismiss
                      </button>
                    ) : null}
                  </div>
                </div>
              </div>
            </div>
          ) : null}

          <div className="timeline__spacer" aria-hidden />
        </div>
      </div>

      {showJump ? (
        <div className="timeline__jump-wrap">
          <button type="button" className="timeline__jump" onClick={jumpToEnd}>
            <JumpIcon />
            Jump to latest
          </button>
        </div>
      ) : null}

      {imagePreview ? (
        <ExpandedImageDialog
          preview={imagePreview}
          onClose={() => setImagePreview(null)}
        />
      ) : null}
    </div>
  );
});

const TurnArticle = memo(function TurnArticle({
  message,
  streamingAssistant,
  collapseThinking,
  canEdit,
  canRetry,
  canFork,
  canRegenerate,
  latestAssistant,
  onExpandImage,
  onEditUser,
  onRetryUser,
  onForkUser,
  onRegenerate,
  onApproveTool,
  onDenyTool,
  approvalBusyId,
  onOpenReviewChanges,
}: {
  message: Message;
  streamingAssistant: boolean;
  collapseThinking: boolean;
  canEdit: boolean;
  canRetry: boolean;
  canFork: boolean;
  canRegenerate: boolean;
  latestAssistant: boolean;
  onExpandImage: (preview: ExpandedImagePreview) => void;
  onEditUser?: (messageId: string) => void;
  onRetryUser?: (messageId: string) => void;
  onForkUser?: (messageId: string) => void;
  onRegenerate?: (messageId: string) => void;
  onApproveTool?: (toolId: string) => void;
  onDenyTool?: (toolId: string) => void;
  approvalBusyId?: string | null;
  onOpenReviewChanges?: () => void;
}) {
  return (
    <article
      data-msg-id={message.id}
      className={`turn turn--${message.role}`}
      data-role={message.role}
    >
      {message.role === "user" ? (
        <UserBubble
          content={stripFollowUpInterruptNote(message.content)}
          attachments={message.attachments}
          onExpandImage={onExpandImage}
          onEdit={canEdit && onEditUser ? () => onEditUser(message.id) : undefined}
          onRetry={
            canRetry && onRetryUser ? () => onRetryUser(message.id) : undefined
          }
          onFork={
            canFork && onForkUser ? () => onForkUser(message.id) : undefined
          }
        />
      ) : (
        <AssistantTurn
          message={message}
          durationMs={message.durationMs}
          streaming={streamingAssistant}
          collapseThinking={collapseThinking}
          onRegenerate={
            canRegenerate && onRegenerate
              ? () => onRegenerate(message.id)
              : undefined
          }
          onApproveTool={onApproveTool}
          onDenyTool={onDenyTool}
          approvalBusyId={approvalBusyId}
          latestAssistant={latestAssistant}
          onOpenReviewChanges={onOpenReviewChanges}
        />
      )}
    </article>
  );
});

const UserBubble = memo(function UserBubble({
  content,
  attachments,
  onExpandImage,
  onEdit,
  onRetry,
  onFork,
}: {
  content: string;
  attachments?: ImageAttachment[];
  onExpandImage?: (preview: ExpandedImagePreview) => void;
  onEdit?: () => void;
  onRetry?: () => void;
  onFork?: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const images = (attachments ?? []).filter((a) => a.dataUrl);
  const hasBubble = images.length > 0 || !!content;
  const hasActions = !!(onEdit || onRetry || onFork || content);
  return (
    <div className="turn__user">
      {hasBubble ? (
        <div className="turn__user-bubble">
          {images.length > 0 ? (
            <div
              className={`turn__atts${images.length === 1 ? " is-single" : ""}`}
            >
              {images.map((a) => (
                <div key={a.id} className="turn__att">
                  <button
                    type="button"
                    className="turn__att-btn"
                    aria-label={`Preview ${a.name}`}
                    onClick={() => {
                      const preview = buildExpandedImagePreview(images, a.id);
                      if (preview) onExpandImage?.(preview);
                    }}
                  >
                    <img
                      src={a.dataUrl}
                      alt={a.name}
                      className="turn__att-img"
                      draggable={false}
                    />
                  </button>
                </div>
              ))}
            </div>
          ) : null}
          {content ? (
            <div className="turn__user-text">{content}</div>
          ) : null}
        </div>
      ) : null}
      {hasActions ? (
        <div className="turn__meta turn__meta--user is-visible">
          {onEdit ? (
            <button
              type="button"
              className="turn__action turn__action--edit"
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                onEdit();
              }}
              title="Edit message"
              aria-label="Edit message"
            >
              <PencilIcon />
            </button>
          ) : null}
          {onRetry ? (
            <button
              type="button"
              className="turn__action"
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                onRetry();
              }}
              title="Retry"
              aria-label="Retry message"
            >
              <RetryIcon />
            </button>
          ) : null}
          {onFork ? (
            <button
              type="button"
              className="turn__action"
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                onFork();
              }}
              title="Fork to new chat"
              aria-label="Fork to new chat"
            >
              <ForkIcon />
            </button>
          ) : null}
          {content ? (
            <button
              type="button"
              className="turn__action"
              title={copied ? "Copied" : "Copy"}
              aria-label={copied ? "Copied" : "Copy message"}
              onClick={async (e) => {
                e.preventDefault();
                e.stopPropagation();
                try {
                  await navigator.clipboard.writeText(content);
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1000);
                } catch {
                  /* ignore */
                }
              }}
            >
              {copied ? <CheckIcon /> : <CopyIcon />}
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
});

const AssistantTurn = memo(function AssistantTurn({
  message,
  durationMs,
  streaming,
  collapseThinking = false,
  onRegenerate,
  onApproveTool,
  onDenyTool,
  approvalBusyId,
  latestAssistant,
  onOpenReviewChanges,
}: {
  message: Message;
  durationMs?: number;
  streaming: boolean;
  collapseThinking?: boolean;
  onRegenerate?: () => void;
  onApproveTool?: (toolId: string) => void;
  onDenyTool?: (toolId: string) => void;
  approvalBusyId?: string | null;
  latestAssistant: boolean;
  onOpenReviewChanges?: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const [workExpanded, setWorkExpanded] = useState(false);
  const groups = useMemo(() => {
    const raw = foldTodoTimelineGroups(
      groupMessageParts(resolveMessageParts(message)),
    );
    // Hide historical tool-protocol leaks in stored threads.
    return raw
      .map((g) => {
        if (g.kind === "text") {
          const text = sanitizeUserFacingContent(g.text);
          return text ? { ...g, text } : null;
        }
        if (g.kind === "thinking") {
          const text = sanitizeThinkingContent(g.text);
          return text ? { ...g, text } : null;
        }
        return g;
      })
      .filter((g): g is NonNullable<typeof g> => g != null);
  }, [message]);
  const content = useMemo(
    () =>
      groups
        .filter((g) => g.kind === "text")
        .map((g) => g.text)
        .join(""),
    [groups],
  );
  const hasWork = groups.some((g) => g.kind === "thinking" || g.kind === "tools");
  const hasFileMutation = groups.some(
    (g) =>
      g.kind === "tools" &&
      g.calls.some((c) => isFileMutationTool(c.name)),
  );
  const hasPlan = groups.some(
    (g) => g.kind === "tools" && g.calls.some((c) => isTodoToolName(c.name)),
  );
  const hasAny = hasWork || !!content.trim();
  const changedFiles = useMemo(
    () => collectMessageReviewFileChanges(message),
    [message],
  );
  const settled = !streaming;
  const durationLabel =
    settled && durationMs != null && durationMs > 0
      ? formatElapsed(durationMs)
      : null;
  // Settled turns fold intermediate work under "Worked for ...".
  // Keep file write/edit diffs visible so mutations aren't buried after the answer.
  const foldWork =
    settled && hasWork && !!content.trim() && !hasFileMutation && !hasPlan;
  const showWork = streaming || !foldWork || workExpanded;
  const displayGroups = useMemo(
    () =>
      foldWork
        ? groups
        : compactTimelineGroups(
            groups,
            workExpanded,
            undefined,
            (call) => isTodoToolName(call.name),
          ),
    [foldWork, groups, workExpanded],
  );
  let liveGroupIndex = -1;
  if (streaming) {
    for (let index = displayGroups.length - 1; index >= 0; index -= 1) {
      if (displayGroups[index]?.kind !== "work-toggle") {
        liveGroupIndex = index;
        break;
      }
    }
  }

  useEffect(() => {
    if (streaming) setWorkExpanded(false);
  }, [streaming]);

  return (
    <div className="turn__assistant">
      {foldWork && durationLabel ? (
        <button
          type="button"
          className="turn-fold"
          aria-expanded={workExpanded}
          onClick={() => setWorkExpanded((v) => !v)}
        >
          <span>Worked for {durationLabel}</span>
          <span className="turn-fold__chev" aria-hidden>
            {workExpanded ? <ChevronDownIcon /> : <ChevronRightIcon />}
          </span>
        </button>
      ) : null}

      {displayGroups.map((g, i) => {
        if (g.kind === "work-toggle") {
          const noun = g.onlyTools
            ? g.hiddenCount === 1
              ? "tool call"
              : "tool calls"
            : g.hiddenCount === 1
              ? "log entry"
              : "log entries";
          return (
            <button
              key={g.key}
              type="button"
              className="work-log__toggle"
              aria-expanded={g.expanded}
              onClick={() => setWorkExpanded((value) => !value)}
            >
              <span className="work-log__toggle-icon" aria-hidden>
                <ChevronIcon open={g.expanded} />
              </span>
              <span>
                {g.expanded
                  ? `Show fewer ${g.onlyTools ? "tool calls" : "log entries"}`
                  : `+${g.hiddenCount} previous ${noun}`}
              </span>
            </button>
          );
        }
        if (g.kind === "thinking") {
          if (!showWork) return null;
          // Live while this is the trailing group OR while the turn is still
          // streaming (progressive thinking must stay open after tools land).
          const live = i === liveGroupIndex;
          return (
            <ThinkingBlock
              key={g.key}
              text={g.text}
              live={live}
              streaming={streaming}
              collapseByDefault={collapseThinking}
              durationLabel={
                !streaming && durationLabel ? durationLabel : null
              }
            />
          );
        }
        if (g.kind === "tools") {
          if (!showWork) return null;
          return (
            <ToolStack
              key={g.key}
              calls={g.calls}
              turnActive={streaming}
              onApproveTool={onApproveTool}
              onDenyTool={onDenyTool}
              approvalBusyId={approvalBusyId}
            />
          );
        }
        return (
          <Markdown
            key={g.key}
            content={g.text}
            streaming={i === liveGroupIndex && !!g.text}
          />
        );
      })}

      {settled && changedFiles.length > 0 ? (
        <ChangedFilesCard
          files={changedFiles}
          latestTurn={latestAssistant}
          onOpenDiff={onOpenReviewChanges}
        />
      ) : null}

      {settled && hasAny ? (
        <div className="turn__meta">
          {!foldWork && durationLabel ? (
            <span className="turn__worked">Worked for {durationLabel}</span>
          ) : null}
          {onRegenerate ? (
            <button type="button" className="turn__copy" onClick={onRegenerate}>
              Regenerate
            </button>
          ) : null}
          {content.trim() ? (
            <button
              type="button"
              className="turn__copy"
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(content);
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1000);
                } catch {
                  /* ignore */
                }
              }}
            >
              {copied ? "Copied" : "Copy"}
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
});

/** OpenCode-style: shimmer while reasoning streams; settled shows optional duration. */
function ThinkingBlock({
  text,
  live,
  streaming = false,
  collapseByDefault = false,
  durationLabel = null,
}: {
  text: string;
  live: boolean;
  /** Whole assistant turn still open — keep body visible for progressive text. */
  streaming?: boolean;
  collapseByDefault?: boolean;
  durationLabel?: string | null;
}) {
  const bodyRef = useRef<HTMLPreElement>(null);
  const manuallyToggledRef = useRef(false);
  const hasBody = !!text.trim();
  const [expanded, setExpanded] = useState(!collapseByDefault);
  const active = live;

  useEffect(() => {
    if (manuallyToggledRef.current) return;
    setExpanded(!collapseByDefault);
  }, [collapseByDefault, live, streaming]);

  useEffect(() => {
    if (!active || !bodyRef.current) return;
    bodyRef.current.scrollTop = bodyRef.current.scrollHeight;
  }, [text, active]);

  // Empty shell only while waiting for the first reasoning token.
  if (!hasBody && !live && !streaming) return null;
  if (!hasBody && streaming && !live) return null;

  const showBody = hasBody && expanded;
  const canToggle = hasBody;

  const settledLabel =
    durationLabel && hasBody
      ? `Thought for ${durationLabel}`
      : "Thinking";
  const label = active ? (
    <TextShimmer text="Thinking" active />
  ) : (
    <span className="think__label">{settledLabel}</span>
  );

  return (
    <div
      className={`think${active ? " is-live" : ""}${showBody ? "" : " is-collapsed"}`}
    >
      {canToggle ? (
        <button
          type="button"
          className="think__head think__head--btn"
          aria-expanded={expanded}
          onClick={() => {
            manuallyToggledRef.current = true;
            setExpanded((v) => !v);
          }}
        >
          {label}
          <span className="think__chev" aria-hidden>
            {expanded ? <ChevronDownIcon /> : <ChevronRightIcon />}
          </span>
        </button>
      ) : (
        <div className="think__head">{label}</div>
      )}
      {showBody ? (
        <pre ref={bodyRef} className="think__text">
          {text}
        </pre>
      ) : null}
    </div>
  );
}

/** Light sweep across label while the model is reasoning (OpenCode TextShimmer). */
function TextShimmer({ text, active }: { text: string; active: boolean }) {
  return (
    <span
      className="text-shimmer"
      data-active={active ? "true" : "false"}
      aria-label={text}
    >
      <span className="text-shimmer__stack">
        <span className="text-shimmer__base" aria-hidden>
          {text}
        </span>
        <span
          className="text-shimmer__glow"
          data-run={active ? "true" : "false"}
          aria-hidden
        >
          {text}
        </span>
      </span>
    </span>
  );
}

function ToolStack({
  calls,
  turnActive,
  onApproveTool,
  onDenyTool,
  approvalBusyId,
}: {
  calls: ToolCall[];
  turnActive: boolean;
  onApproveTool?: (toolId: string) => void;
  onDenyTool?: (toolId: string) => void;
  approvalBusyId?: string | null;
}) {
  return (
    <section
      className="tool-stack"
      aria-label={
        calls.length === 1 ? "1 tool call" : `${calls.length} tool calls`
      }
    >
      <div className="tool-stack__list">
        {calls.map((t) => (
          <ToolCallRow
            key={t.id}
            call={t}
            turnActive={turnActive}
            onApproveTool={onApproveTool}
            onDenyTool={onDenyTool}
            approvalBusyId={approvalBusyId}
          />
        ))}
      </div>

    </section>
  );
}

function ToolCallRow({
  call,
  turnActive,
  nested = false,
  onApproveTool,
  onDenyTool,
  approvalBusyId,
}: {
  call: ToolCall;
  turnActive: boolean;
  /** Nested under a parent task card — compact, no further nesting UI. */
  nested?: boolean;
  onApproveTool?: (toolId: string) => void;
  onDenyTool?: (toolId: string) => void;
  approvalBusyId?: string | null;
}) {
  const mutation = isFileMutationTool(call.name);
  const todoTool = isTodoToolName(call.name);
  const taskTool = isTaskToolName(call.name);
  const taskResult = taskTool ? parseTaskResult(call.result) : null;
  const awaiting = call.status === "awaiting";
  const running = call.status === "running" || awaiting;
  const failed =
    call.status === "error" ||
    call.status === "denied" ||
    taskResult?.state === "error";
  const displayCall = call.args
    ? { ...call, args: redactSensitiveValues(call.args) }
    : call;
  const { title, detail, role: taskRole, codename: taskCodename = "" } =
    toolPresentation(displayCall);
  const expanded = buildExpandedView(displayCall);
  // Line-change badges are only meaningful for write/edit — never for Read/Grep/Bash.
  const stats = mutation ? parseDiffStats(displayCall, expanded) : null;
  const canExpand = expanded != null;
  const [open, setOpen] = useState(false);
  const todoSummary =
    expanded?.kind === "todo" ? planInlineSummary(expanded.steps) : null;

  // Multimodal reads: show the image the model sees as soon as it lands.
  const imageAutoOpenedRef = useRef(false);
  useEffect(() => {
    if (expanded?.kind !== "image" || imageAutoOpenedRef.current) return;
    imageAutoOpenedRef.current = true;
    setOpen(true);
  }, [expanded]);

  const preview =
    detail &&
    normalizeCompactToolLabel(detail).toLowerCase() !==
      normalizeCompactToolLabel(title).toLowerCase()
      ? detail
      : null;

  const showSuccess = !running && !failed;
  const showNeutral = running && turnActive;

  const roleClass = taskTool ? ` ${taskRoleClass(taskRole ?? null)}` : "";
  const statusLabel = awaiting
    ? "Waiting for approval"
    : running
      ? "Running"
      : failed
        ? "Failed"
        : "Completed";
  const ariaLabelBase = todoSummary
    ? `Plan: ${todoSummary.label}, ${todoSummary.done} of ${todoSummary.total} complete`
    : taskCodename
      ? preview
        ? `${title} ${taskCodename} ${preview}`
        : `${title} ${taskCodename}`
      : preview
        ? `${title} ${preview}`
        : title;
  const ariaLabel = `${ariaLabelBase}, ${statusLabel}`;

  return (
    <div
      className={`tool-row${running ? " is-running" : ""}${awaiting ? " is-awaiting" : ""}${failed ? " is-error" : ""}${open ? " is-open" : ""}${mutation ? " is-mutation" : ""}${todoTool ? " is-todo" : ""}${taskTool ? " is-task" : ""}${nested ? " is-nested" : ""}${roleClass}`}
    >
      <div
        className={`tool-row__head${canExpand ? " is-clickable" : ""}`}
        role={canExpand ? "button" : undefined}
        tabIndex={canExpand ? 0 : undefined}
        aria-expanded={canExpand ? open : undefined}
        aria-label={ariaLabel}
        onClick={() => canExpand && setOpen((v) => !v)}
        onKeyDown={(e) => {
          if (!canExpand) return;
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            setOpen((v) => !v);
          }
        }}
      >
        {todoSummary && expanded?.kind === "todo" ? (
          <span
            className={`tool-row__line tool-plan${todoSummary.allDone ? " is-done" : ""}`}
          >
            <span className="tool-plan__chev" aria-hidden>
              {canExpand ? (
                <span className={`tool-row__chev${open ? " is-open" : ""}`}>
                  <ChevronIcon open={open} />
                </span>
              ) : null}
            </span>
            <span className="tool-plan__segments" aria-hidden>
              {expanded.steps.map((step, index) => (
                <span
                  key={`${index}:${step.step}`}
                  className={`tool-plan__segment is-${step.status}`}
                />
              ))}
            </span>
            <span className="tool-plan__label">{todoSummary.label}</span>
            <span className="tool-plan__count" aria-hidden>
              {todoSummary.done}/{todoSummary.total}
            </span>
          </span>
        ) : (
          <>
            <span className="tool-row__kind" aria-hidden>
              {taskTool ? (
                running ? (
                  <span className="tool-row__task-spinner" />
                ) : (
                  <ToolKindIcon name={call.name} />
                )
              ) : (
                <ToolKindIcon name={call.name} />
              )}
            </span>
            <span className="tool-row__line">
              <span className="tool-row__title">{title}</span>
              {taskCodename ? (
                <span className="tool-row__codename" title="Subagent instance">
                  {taskCodename}
                </span>
              ) : null}
              {preview ? <span className="tool-row__detail">{preview}</span> : null}
              {stats && !failed ? (
                <span className="tool-row__stats" aria-label="line changes">
                  <span className="tool-row__stat tool-row__stat--add">
                    +{stats.additions}
                  </span>
                  <span className="tool-row__stat tool-row__stat--del">
                    -{stats.deletions}
                  </span>
                </span>
              ) : null}
            </span>
            <span className="tool-row__trail">
              <span className="tool-row__chev-slot" aria-hidden>
                {canExpand ? (
                  <span className={`tool-row__chev${open ? " is-open" : ""}`}>
                    <ChevronIcon open={open} />
                  </span>
                ) : null}
              </span>
              <span className="tool-row__status" title={statusLabel}>
                {failed ? (
                  <StatusX />
                ) : showSuccess ? (
                  <StatusCheck />
                ) : showNeutral ? (
                  <StatusMinus />
                ) : (
                  <StatusCheck />
                )}
              </span>
            </span>
          </>
        )}
      </div>
      {awaiting && onApproveTool && onDenyTool ? (
        <div
          className="tool-row__approval"
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => e.stopPropagation()}
        >
          {call.approvalReason ? (
            <span className="tool-row__approval-reason">{call.approvalReason}</span>
          ) : (
            <span className="tool-row__approval-reason">Needs approval</span>
          )}
          <button
            type="button"
            className="tool-row__approval-btn tool-row__approval-btn--deny"
            disabled={approvalBusyId != null}
            onClick={() => onDenyTool(call.id)}
          >
            Deny
          </button>
          <button
            type="button"
            className="tool-row__approval-btn tool-row__approval-btn--ok"
            disabled={approvalBusyId != null}
            onClick={() => onApproveTool(call.id)}
          >
            {approvalBusyId === call.id ? "…" : "Approve"}
          </button>
        </div>
      ) : null}
      {open && expanded ? (
        <div
          className={`tool-row__body${
            expanded.kind === "diff"
              ? " is-diff"
              : expanded.kind === "todo"
                ? " is-todo"
                : expanded.kind === "task"
                  ? " is-task"
                  : expanded.kind === "image"
                    ? " is-image"
                    : " is-text"
          }`}
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => e.stopPropagation()}
          onPointerDown={(e) => e.stopPropagation()}
        >
          {expanded.kind === "task" ? (
            <div className="tool-task" role="region" aria-label="Subagent task">
              {expanded.children.length > 0 ? (
                <div className="tool-task__children" aria-label="Subagent tools">
                  {expanded.children.map((child) => (
                    <ToolCallRow
                      key={child.id}
                      call={child}
                      turnActive={turnActive && running}
                      nested
                      onApproveTool={onApproveTool}
                      onDenyTool={onDenyTool}
                      approvalBusyId={approvalBusyId}
                    />
                  ))}
                </div>
              ) : null}
              {expanded.report ? (
                <pre className="tool-row__pre tool-task__report">
                  {expanded.report}
                </pre>
              ) : null}
              {expanded.error ? (
                <pre className="tool-row__pre tool-task__report is-error">
                  {expanded.error}
                </pre>
              ) : !expanded.report && running ? (
                <div className="tool-task__waiting">Running subagent…</div>
              ) : null}
            </div>
          ) : expanded.kind === "diff" ? (
            <div className="tool-diff" role="region" aria-label="Diff">
              {expanded.header ? (
                <div className="tool-diff__header">{expanded.header}</div>
              ) : null}
              <div className="tool-diff__pre" role="table">
                {expanded.lines.map((line, i) => (
                  <div
                    key={i}
                    className={
                      line.kind === "add"
                        ? "tool-diff__line tool-diff__line--add"
                        : line.kind === "del"
                          ? "tool-diff__line tool-diff__line--del"
                          : line.kind === "meta"
                            ? "tool-diff__line tool-diff__line--meta"
                            : "tool-diff__line"
                    }
                  >
                    <span className="tool-diff__gutter" aria-hidden>
                      {line.kind === "add"
                        ? "+"
                        : line.kind === "del"
                          ? "−"
                          : line.kind === "meta"
                            ? "…"
                            : " "}
                    </span>
                    <span className="tool-diff__code">{line.code}</span>
                  </div>
                ))}
              </div>
            </div>
          ) : expanded.kind === "todo" ? (
            <ToolTodoList steps={expanded.steps} />
          ) : expanded.kind === "image" ? (
            <figure className="tool-image" role="region" aria-label="Image read">
              <img
                className="tool-image__img"
                src={expanded.src}
                alt={expanded.caption || "Image read by the agent"}
              />
              {expanded.caption ? (
                <figcaption className="tool-image__caption">
                  {expanded.caption}
                </figcaption>
              ) : null}
            </figure>
          ) : (
            <pre className={`tool-row__pre${failed ? " is-error" : ""}`}>
              {expanded.text}
            </pre>
          )}
        </div>
      ) : null}
    </div>
  );
}

function ToolTodoStepIcon({ status }: { status: PlanStepStatus }) {
  if (status === "completed") {
    return (
      <span className="tool-todo__ico tool-todo__ico--done" aria-hidden>
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none">
          <path
            d="M5 12.5 10 17.5 19 7"
            stroke="currentColor"
            strokeWidth="2.4"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </span>
    );
  }
  if (status === "inProgress") {
    return (
      <span className="tool-todo__ico tool-todo__ico--active" aria-hidden>
        <span className="tool-todo__spinner" />
      </span>
    );
  }
  if (status === "cancelled") {
    return (
      <span className="tool-todo__ico tool-todo__ico--cancelled" aria-hidden>
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none">
          <path
            d="M7 7l10 10M17 7 7 17"
            stroke="currentColor"
            strokeWidth="2.2"
            strokeLinecap="round"
          />
        </svg>
      </span>
    );
  }
  return (
    <span className="tool-todo__ico tool-todo__ico--pending" aria-hidden>
      <span className="tool-todo__dot" />
    </span>
  );
}

function ToolTodoList({ steps }: { steps: readonly PlanStep[] }) {
  return (
    <ul className="tool-todo" aria-label="Todo list">
      {steps.map((step, idx) => (
        <li
          key={`${idx}:${step.step}`}
          className={`tool-todo__item is-${step.status}`}
        >
          <ToolTodoStepIcon status={step.status} />
          <span className="tool-todo__text">{step.step}</span>
        </li>
      ))}
    </ul>
  );
}

function shortPath(p: string): string {
  if (!p) return p;
  const norm = p.replace(/\\/g, "/");
  // Prefer path relative-looking tail (src/..., package.json, etc.)
  const markers = ["/src/", "/src-tauri/", "/scripts/", "/public/"];
  const lower = norm.toLowerCase();
  for (const m of markers) {
    const idx = lower.lastIndexOf(m);
    if (idx >= 0) return norm.slice(idx + 1);
  }
  // Strip Windows drive + users home prefix noise
  const parts = norm.split("/").filter(Boolean);
  if (parts.length > 4) return parts.slice(-3).join("/");
  return norm;
}

function toolFilePath(args: Record<string, unknown>): string {
  const raw =
    typeof args.filePath === "string"
      ? args.filePath
      : typeof args.file_path === "string"
        ? args.file_path
        : typeof args.path === "string"
          ? args.path
          : "";
  return shortPath(raw);
}

function todoToolDetail(call: ToolCall): string {
  const steps =
    parsePlanStepsFromToolPayload(call.result) ??
    parsePlanStepsFromToolPayload(call.args);
  if (!steps || steps.length === 0) return "";
  const done = steps.filter(
    (s) => s.status === "completed" || s.status === "cancelled",
  ).length;
  const active = steps.find((s) => s.status === "inProgress");
  if (active) return `${done}/${steps.length} · ${active.step}`;
  return `${done}/${steps.length}`;
}

function mutationToolDetail(call: ToolCall, fallback: string): string {
  const changed = (call.result ?? "")
    .split(/\r?\n/)
    .map((line) =>
      line.match(/^(?:Created|Wrote|Edited|Deleted)\s+(.*?)(?:\s+\([^)]*\))?(?:\s+\+\d+(?:\s+-\d+)?)?\s*$/i),
    )
    .filter((match): match is RegExpMatchArray => match != null)
    .map((match) => shortPath(match[1] ?? ""))
    .filter(Boolean);
  if (changed.length === 0) return fallback;
  return changed.length === 1 ? changed[0] : `${changed[0]} +${changed.length - 1} more`;
}

function toolPresentation(call: ToolCall): {
  title: string;
  detail: string;
  role?: TaskRole | null;
  codename?: string;
} {
  if (isTaskToolName(call.name)) {
    return taskPresentation(call, (child) => toolPresentation(child));
  }
  const args = parseJsonObject(call.args);
  const path =
    typeof args.path === "string" ? redactSensitiveText(args.path, 180) : "";
  const query =
    typeof args.query === "string" ? redactSensitiveText(args.query, 180) : "";
  const pattern =
    typeof args.pattern === "string"
      ? redactSensitiveText(args.pattern, 180)
      : typeof args.query === "string"
        ? redactSensitiveText(args.query, 180)
        : "";
  const url =
    typeof args.url === "string" ? redactSensitiveText(args.url, 180) : "";
  const filePath = toolFilePath(args);
  // Prefer relative path from successful tool result header when args path is noisy.
  const fromResult = filePathFromResult(call.result);
  const detailPath = filePath || fromResult;
  const normalizedName = call.name.trim().toLowerCase();
  switch (normalizedName) {
    case "read":
    case "read_file":
      return { title: "Read", detail: detailPath };
    case "list_dir":
    case "ls":
    case "list":
      return { title: "List dir", detail: detailPath || "." };
    case "grep":
    case "search_text":
    case "rg":
      return {
        title: "Grep",
        detail: query || pattern || detailPath,
      };
    case "glob":
    case "find_files":
      return { title: "Glob", detail: pattern || detailPath };
    case "write":
    case "write_file":
      return {
        title: "File change",
        detail: mutationToolDetail(call, detailPath),
      };
    case "edit":
    case "edit_file":
    case "str_replace":
      return {
        title: "File change",
        detail: mutationToolDetail(call, detailPath),
      };
    case "patch":
    case "apply_patch":
      return {
        title: "File change",
        detail: mutationToolDetail(call, detailPath),
      };
    case "delete":
    case "delete_file":
      return {
        title: "File change",
        detail: mutationToolDetail(call, detailPath),
      };
    case "bash":
    case "shell":
    case "run_command":
      return {
        title: "Ran command",
        detail:
          typeof args.command === "string"
            ? redactSensitiveText(args.command, 180)
            : typeof args.cmd === "string"
              ? redactSensitiveText(args.cmd, 180)
              : "",
      };
    case "webfetch":
    case "web_fetch":
    case "fetch":
      return { title: "WebFetch", detail: url };
    case "websearch":
    case "web_search":
    case "search_web":
      return {
        title: "Web Search",
        detail:
          query ||
          (typeof args.q === "string"
            ? redactSensitiveText(args.q, 180)
            : "") ||
          (typeof args.search === "string"
            ? redactSensitiveText(args.search, 180)
            : ""),
      };
    case "todowrite":
    case "todo_write":
    case "todo": {
      const todoDetail = todoToolDetail(call);
      return { title: "Todo", detail: todoDetail };
    }
    case "task":
    case "spawn_subagent":
    case "agent": {
      // Handled above via isTaskToolName; keep for exhaustiveness if name not rewritten.
      return taskPresentation(call, (child) => toolPresentation(child));
    }
    case "preview_snapshot":
    case "browser_snapshot":
      return { title: "Open Xiao · preview_snapshot", detail: "" };
    default: {
      const kind = toolActivityKind(normalizedName);
      if (kind === "command") {
        const executable =
          typeof args.executable === "string"
            ? redactSensitiveText(args.executable, 80)
            : "";
        const commandArgs = Array.isArray(args.args)
          ? args.args.filter((value): value is string => typeof value === "string").join(" ")
          : typeof args.args === "string"
            ? args.args
            : "";
        return {
          title: "Ran command",
          detail:
            typeof args.command === "string"
              ? redactSensitiveText(args.command, 180)
              : typeof args.cmd === "string"
                ? redactSensitiveText(args.cmd, 180)
                : redactSensitiveText(`${executable} ${commandArgs}`.trim(), 180),
        };
      }
      if (kind === "file_change") {
        return {
          title: "File change",
          detail: mutationToolDetail(call, detailPath || path),
        };
      }
      if (kind === "read") return { title: "Read", detail: detailPath };
      if (kind === "search") {
        return { title: "Search", detail: query || pattern || url || detailPath };
      }
      if (kind === "mcp") {
        const server = typeof args.server === "string" ? args.server : "";
        const tool = typeof args.tool === "string" ? args.tool : "";
        return { title: "MCP tool call", detail: [server, tool].filter(Boolean).join(" · ") };
      }
      if (kind === "image") return { title: "Image view", detail: detailPath };
      if (kind === "task") return { title: "Agent task", detail: query || path };
      if (kind === "todo") return { title: "Plan", detail: todoToolDetail(call) };
      return {
        title: capitalizePhrase(normalizeCompactToolLabel(call.name.replace(/_/g, " "))),
        detail: path || query || pattern || url,
      };
    }
  }
}

type DiffStats = { additions: number; deletions: number };

function filePathFromResult(result?: string): string {
  if (!result) return "";
  const first = result.split("\n")[0] ?? "";
  // "Edited src/a.ts (...)" / "Wrote src/a.ts  +3 -1" / "Created src/a.ts  +10"
  const m = first.match(
    /^(?:Created|Wrote|Edited|Deleted)\s+(\S+?)(?:\s+\(|\s+\+|\s*$)/i,
  );
  return m ? shortPath(m[1]) : "";
}

function countDiffLineStats(lines: DiffLine[]): DiffStats {
  let additions = 0;
  let deletions = 0;
  for (const line of lines) {
    if (line.kind === "add") additions += 1;
    else if (line.kind === "del") deletions += 1;
  }
  return { additions, deletions };
}

function parseDiffStats(
  call: ToolCall,
  expanded: ExpandedView | null,
): DiffStats | null {
  // Read/grep/bash/etc. never get +N -M badges.
  if (!isFileMutationTool(call.name)) return null;

  // Backend stamps full churn on the header; diff body is only a preview.
  const header = parseToolResultHeaderStats(call.result);
  if (header) {
    // Hide pure no-op +0 -0 noise unless we want to show it for edits that
    // explicitly reported no change — still useful as confirmation.
    return header;
  }
  // Count colored diff lines from expanded view / result body
  if (expanded?.kind === "diff" && expanded.lines.length > 0) {
    const s = countDiffLineStats(expanded.lines);
    if (s.additions || s.deletions) return s;
  }
  const src = call.result ?? "";
  if (src.includes("\n")) {
    let additions = 0;
    let deletions = 0;
    for (const line of src.split("\n").slice(1)) {
      if (isDiffAddLine(line)) additions += 1;
      else if (isDiffDelLine(line)) deletions += 1;
    }
    if (additions || deletions) return { additions, deletions };
  }
  // Last resort: derive from args payload (running edit before result lands)
  const fromArgs = diffFromArgs(call);
  if (fromArgs) {
    const s = countDiffLineStats(fromArgs.lines);
    if (s.additions || s.deletions) return s;
  }
  return null;
}

type DiffLine = {
  kind: "add" | "del" | "ctx" | "meta";
  /** Full display text without forcing a leading marker into the code span. */
  code: string;
};

type ExpandedView =
  | { kind: "diff"; header: string; lines: DiffLine[] }
  | { kind: "todo"; steps: PlanStep[] }
  | {
      kind: "task";
      children: ToolCall[];
      report: string;
      error: string;
    }
  | { kind: "image"; src: string; caption: string }
  | { kind: "text"; text: string };

function isDiffMetaLine(line: string): boolean {
  const t = line.trim();
  return (
    t === "…" ||
    t === "..." ||
    t.startsWith("@@") ||
    t.startsWith("---") ||
    t.startsWith("+++") ||
    /^diff --git /.test(t)
  );
}

function isDiffAddLine(line: string): boolean {
  return line.startsWith("+") && !line.startsWith("+++");
}

function isDiffDelLine(line: string): boolean {
  return line.startsWith("-") && !line.startsWith("---");
}

function parseDiffBodyLines(bodyLines: string[]): DiffLine[] {
  return bodyLines.map((text) => {
    if (isDiffMetaLine(text)) {
      return { kind: "meta" as const, code: text.replace(/^[+\- ]/, "") };
    }
    if (isDiffAddLine(text)) return { kind: "add" as const, code: text.slice(1) };
    if (isDiffDelLine(text)) return { kind: "del" as const, code: text.slice(1) };
    if (text.startsWith(" ")) return { kind: "ctx" as const, code: text.slice(1) };
    return { kind: "ctx" as const, code: text };
  });
}

function linesAsDiff(
  kind: "add" | "del",
  text: string,
  limit = 200,
): DiffLine[] {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const slice = lines.slice(0, limit);
  const out: DiffLine[] = slice.map((l) => ({ kind, code: l }));
  if (lines.length > limit) {
    out.push({ kind: "meta", code: `… ${lines.length - limit} more lines` });
  }
  return out;
}

function diffFromArgs(call: ToolCall): { header: string; lines: DiffLine[] } | null {
  if (!call.args?.trim()) return null;
  const args = parseJsonObject(call.args);
  const filePath = toolFilePath(args);
  if (isEditTool(call.name)) {
    const oldS =
      typeof args.oldString === "string"
        ? args.oldString
        : typeof args.old_string === "string"
          ? args.old_string
          : "";
    const newS =
      typeof args.newString === "string"
        ? args.newString
        : typeof args.new_string === "string"
          ? args.new_string
          : "";
    if (!oldS && !newS) return null;
    const lines: DiffLine[] = [
      ...linesAsDiff("del", oldS),
      ...linesAsDiff("add", newS),
    ];
    return { header: filePath || "Edit", lines };
  }
  if (isWriteTool(call.name)) {
    const content = typeof args.content === "string" ? args.content : "";
    if (!content) return null;
    return {
      header: filePath || "Write",
      lines: linesAsDiff("add", content),
    };
  }
  return null;
}

function buildExpandedView(call: ToolCall): ExpandedView | null {
  const taskResult = isTaskToolName(call.name)
    ? parseTaskResult(call.result)
    : null;
  const failed =
    call.status === "error" ||
    call.status === "denied" ||
    taskResult?.state === "error";
  const resultRaw = call.result ?? "";
  const result = resultRaw.trim();
  const argsDiff = isFileMutationTool(call.name) ? diffFromArgs(call) : null;

  // Multimodal read: show the image the model received.
  if (call.imageUrl && !failed) {
    return {
      kind: "image",
      src: call.imageUrl,
      caption: result || "Image read",
    };
  }

  // task / subagent: nested tools + cleaned final report (not raw XML envelope).
  if (isTaskToolName(call.name)) {
    const children = call.children ?? [];
    const rawBody = (taskResult?.body ?? result).trim();
    const failure = failed ? presentTaskFailure(rawBody) : null;
    const report = failure
      ? sanitizeUserFacingContent(failure.partialReport).trim()
      : rawBody;
    const error = failure
      ? [
          failure.title,
          failure.message,
          failure.detail ? `Provider detail: ${failure.detail}` : "",
        ]
          .filter(Boolean)
          .join("\n")
      : "";
    if (
      children.length > 0 ||
      report ||
      error ||
      call.status === "running" ||
      call.status === "awaiting"
    ) {
      return { kind: "task", children, report, error };
    }
    return null;
  }

  // todowrite: checklist UI — never dump raw JSON args/result.
  if (isTodoToolName(call.name) && !failed) {
    const steps =
      parsePlanStepsFromToolPayload(call.result) ??
      parsePlanStepsFromToolPayload(call.args);
    if (steps && steps.length > 0) {
      return { kind: "todo", steps };
    }
  }

  if (failed) {
    const error = normalizeUserFacingError(
      `${call.status} ${result || call.args || ""}`,
      {
        fallbackTitle: "Action could not finish",
        fallbackMessage:
          "The tool could not complete this action. Review the request and try again.",
      },
    );
    return {
      kind: "text",
      text: `${error.title}\n${error.message}`,
    };
  }

  // write / edit: always prefer a real line diff (result body, else args).
  if (isFileMutationTool(call.name)) {
    if (result) {
      const lines = resultRaw.replace(/\r\n/g, "\n").split("\n");
      const header = (lines[0] ?? "").trim();
      const bodyLines = lines.slice(1);
      const hasDiff = bodyLines.some(
        (l) =>
          isDiffAddLine(l) ||
          isDiffDelLine(l) ||
          isDiffMetaLine(l) ||
          l.trim() === "…" ||
          l.trim() === "...",
      );
      if (hasDiff) {
        return {
          kind: "diff",
          header: header || argsDiff?.header || "Diff",
          lines: parseDiffBodyLines(bodyLines),
        };
      }
    }
    if (argsDiff) {
      const header =
        (result ? result.split("\n")[0]?.trim() : "") || argsDiff.header;
      return { kind: "diff", header, lines: argsDiff.lines };
    }
    if (result) return { kind: "text", text: result };
  }

  if (result) {
    // Guard: never surface pretty-printed todo JSON as plain text.
    if (isTodoToolName(call.name)) {
      const steps =
        parsePlanStepsFromToolPayload(call.result) ??
        parsePlanStepsFromToolPayload(call.args);
      if (steps && steps.length > 0) return { kind: "todo", steps };
      // Strip "Updated todos:\n..." noise if parse somehow failed mid-stream.
      const cleaned = result.replace(/^Updated todos:\s*/i, "").trim();
      if (cleaned && cleaned !== result) {
        const again = parsePlanStepsFromToolPayload(cleaned);
        if (again && again.length > 0) return { kind: "todo", steps: again };
      }
    }
    return { kind: "text", text: result };
  }

  if (call.args?.trim()) {
    if (isTodoToolName(call.name)) {
      const steps = parsePlanStepsFromToolPayload(call.args);
      if (steps && steps.length > 0) return { kind: "todo", steps };
    }
    try {
      return {
        kind: "text",
        text: JSON.stringify(JSON.parse(call.args), null, 2),
      };
    } catch {
      return { kind: "text", text: call.args.trim() };
    }
  }
  return null;
}

function normalizeCompactToolLabel(value: string): string {
  return value.replace(/\s+(?:complete|completed)\s*$/i, "").trim();
}

function capitalizePhrase(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return value;
  return `${trimmed.charAt(0).toUpperCase()}${trimmed.slice(1)}`;
}



/** Settled elapsed: `1.2s` - `12s` - `2m 5s` */
export function formatElapsed(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "0ms";
  if (ms < 1_000) return `${Math.max(1, Math.round(ms))}ms`;
  if (ms < 10_000) {
    const tenths = Math.round(ms / 100) / 10;
    return tenths >= 10 ? "10s" : `${tenths.toFixed(1)}s`;
  }
  if (ms < 60_000) return `${Math.round(ms / 1_000)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1_000);
  if (seconds === 0) return `${minutes}m`;
  if (seconds === 60) return `${minutes + 1}m`;
  return `${minutes}m ${seconds}s`;
}

/**
 * Live working clock for the in-chat Working row.
 * Matches sidebar WorkingDuration: seconds under 1m, then whole minutes only.
 */
function formatWorkingClock(ms: number): string {
  const elapsedSeconds = Number.isFinite(ms)
    ? Math.max(0, Math.floor(ms / 1000))
    : 0;
  const hours = Math.floor(elapsedSeconds / 3600);
  const minutes = Math.floor((elapsedSeconds % 3600) / 60);
  const seconds = elapsedSeconds % 60;
  if (hours > 0) return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  if (minutes > 0) return `${minutes}m`;
  return `${seconds}s`;
}

/** Live "Working Nm" - mutates text node so stream updates don't re-render. */
function WorkingLabel({ startedAt }: { startedAt: number | null }) {
  const textRef = useRef<HTMLSpanElement>(null);
  const start = startedAt ?? Date.now();
  const initial = formatWorkingClock(Date.now() - start);

  useEffect(() => {
    const tick = () => {
      if (textRef.current) {
        textRef.current.textContent = formatWorkingClock(Date.now() - start);
      }
    };
    tick();
    const id = window.setInterval(tick, 1000);
    return () => window.clearInterval(id);
  }, [start]);

  return (
    <div className="working" aria-live="polite" aria-label={`Working ${initial}`}>
      <span className="working__dots" aria-hidden>
        <i />
        <i />
        <i />
      </span>
      <span className="working__text">
        Working <span ref={textRef} className="working__timer">{initial}</span>
      </span>
    </div>
  );
}

function ChevronIcon({ open }: { open: boolean }) {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden
      className={open ? "chev-open" : undefined}
    >
      <path
        d="M6 9l6 6 6-6"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function ChevronDownIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M6 9l6 6 6-6"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function ChevronRightIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M9 6l6 6-6 6"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function ToolKindIcon({ name }: { name: string }) {
  const n = name.toLowerCase();
  const kind = toolActivityKind(name);
  if (isTaskToolName(n) || n === "task" || n.includes("subagent")) {
    // Nested-squares mark (OpenCode subagent affordance).
    return (
      <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden>
        <rect
          x="2"
          y="2"
          width="12"
          height="12"
          rx="1.5"
          stroke="currentColor"
          strokeWidth="1.5"
        />
        <path
          d="M4.5 5C4.5 4.72386 4.72386 4.5 5 4.5H11C11.2761 4.5 11.5 4.72386 11.5 5V11C11.5 11.2761 11.2761 11.5 11 11.5H5C4.72386 11.5 4.5 11.2761 4.5 11V5Z"
          fill="currentColor"
        />
      </svg>
    );
  }
  if (n.includes("todo")) {
    return (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden>
        <path
          d="M9 6h11M9 12h11M9 18h11"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
        />
        <path
          d="M4.5 6.2 5.8 7.5 8 5"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <path
          d="M4.5 12.2 5.8 13.5 8 11"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <circle cx="6.2" cy="18" r="1.2" fill="currentColor" />
      </svg>
    );
  }
  if (kind === "mcp") {
    return (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden>
        <path d="M8 7.5h8v9H8z" stroke="currentColor" strokeWidth="1.7" />
        <path d="M10 4v3.5M14 4v3.5M10 16.5V20M14 16.5V20M4 10h4M16 10h4M4 14h4M16 14h4" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
      </svg>
    );
  }
  if (kind === "image") {
    return (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden>
        <rect x="3" y="4" width="18" height="16" rx="2" stroke="currentColor" strokeWidth="1.7" />
        <circle cx="9" cy="10" r="2" stroke="currentColor" strokeWidth="1.7" />
        <path d="m5 18 5-5 3 3 2-2 4 4" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    );
  }
  if (n === "patch" || n === "apply_patch" || n === "applypatch") {
    // Plus/minus patch mark.
    return (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden>
        <path
          d="M7 4v8M3 8h8"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
        />
        <path
          d="M13 16h8"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
        />
      </svg>
    );
  }
  if (n.includes("read") || n.includes("list") || n.includes("dir")) {
    return (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden>
        <path
          d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z"
          stroke="currentColor"
          strokeWidth="1.8"
        />
        <circle cx="12" cy="12" r="3" stroke="currentColor" strokeWidth="1.8" />
      </svg>
    );
  }
  if (n.includes("websearch") || n.includes("web_search") || n === "search_web") {
    // Globe icon for the web-search affordance.
    return (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden>
        <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="1.8" />
        <path
          d="M3 12h18"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
        />
        <path
          d="M12 3c2.5 2.8 3.8 5.8 3.8 9s-1.3 6.2-3.8 9c-2.5-2.8-3.8-5.8-3.8-9s1.3-6.2 3.8-9Z"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinejoin="round"
        />
      </svg>
    );
  }
  if (n.includes("webfetch") || n.includes("web_fetch") || n === "fetch") {
    return (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden>
        <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="1.8" />
        <path
          d="M3 12h18"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
        />
        <path
          d="M12 3c2.5 2.8 3.8 5.8 3.8 9s-1.3 6.2-3.8 9c-2.5-2.8-3.8-5.8-3.8-9s1.3-6.2 3.8-9Z"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinejoin="round"
        />
      </svg>
    );
  }
  if (n.includes("search") || n.includes("grep") || n.includes("glob")) {
    return (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden>
        <circle cx="11" cy="11" r="6.5" stroke="currentColor" strokeWidth="1.8" />
        <path
          d="M16 16l5 5"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
        />
      </svg>
    );
  }
  if (
    n.includes("write") ||
    n.includes("edit") ||
    n.includes("patch") ||
    n.includes("replace")
  ) {
    return (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden>
        <path
          d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5Z"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    );
  }
  if (n.includes("bash") || n.includes("shell") || n.includes("command")) {
    return (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden>
        <path
          d="M4 17l6-5-6-5M12 19h8"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    );
  }
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M13 2L4 14h7l-1 8 9-12h-7l1-8Z"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function StatusCheck() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M5 13l4 4L19 7"
        stroke="currentColor"
        strokeWidth="2.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function StatusX() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M6 6l12 12M18 6L6 18"
        stroke="currentColor"
        strokeWidth="2.2"
        strokeLinecap="round"
      />
    </svg>
  );
}

function StatusMinus() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M6 12h12"
        stroke="currentColor"
        strokeWidth="2.2"
        strokeLinecap="round"
      />
    </svg>
  );
}

function JumpIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M12 5v14M5 12l7 7 7-7"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function PencilIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden>
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

function RetryIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M21 12a9 9 0 1 1-2.64-6.36"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
      <path
        d="M21 3v6h-6"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function ForkIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden>
      <circle cx="6" cy="5" r="2" stroke="currentColor" strokeWidth="1.8" />
      <circle cx="18" cy="6" r="2" stroke="currentColor" strokeWidth="1.8" />
      <circle cx="6" cy="19" r="2" stroke="currentColor" strokeWidth="1.8" />
      <path
        d="M6 7v10M8 11h3a7 7 0 0 0 7-3"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
    </svg>
  );
}

function CopyIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden>
      <rect
        x="9"
        y="9"
        width="11"
        height="11"
        rx="2"
        stroke="currentColor"
        strokeWidth="1.8"
      />
      <path
        d="M5 15V5a2 2 0 0 1 2-2h10"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M5 13l4 4L19 7"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
