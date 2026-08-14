import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import {
  ChevronDown,
  ChevronRight,
  ChevronsDownUp,
  ChevronsUpDown,
  Columns2,
  FileDiff,
  ListFilter,
  Rows3,
  Search,
  WrapText,
  X,
} from "lucide-react";
import {
  dirNameOf,
  fileNameOf,
  filterReviewFiles,
  formatCompactDiffCount,
  type ReviewDiffLine,
  type ReviewDiffStyle,
  type ReviewFileChange,
  type ReviewFileStatus,
  type ReviewScope,
  summarizeReviewChanges,
} from "../reviewChanges";
import {
  buildReviewCommentSelection,
  type ReviewCommentSelection,
} from "../reviewComments";
import type { GitStatus } from "../git";
import { usePresence } from "../usePresence";
import { ReviewGitPage } from "./GitControls";
import {
  RightPanelPageSwitcher,
  type RightPanelPage,
} from "./RightPanelControls";

type Props = {
  open: boolean;
  files: readonly ReviewFileChange[];
  scope: ReviewScope;
  onScopeChange: (scope: ReviewScope) => void;
  diffStyle: ReviewDiffStyle;
  onDiffStyleChange: (style: ReviewDiffStyle) => void;
  activePath: string | null;
  onSelectFile: (path: string | null) => void;
  onClose: () => void;
  /** Optional label when empty (e.g. still streaming). */
  streaming?: boolean;
  /** Working-tree git page (shown above diffs when scope is git). */
  gitStatus?: GitStatus | null;
  gitLoading?: boolean;
  gitBusy?: boolean;
  onGitCommit?: (message: string) => boolean | Promise<boolean>;
  onGitPush?: () => void | Promise<void>;
  onGitOpenPr?: () => void | Promise<void>;
  gitPrUrl?: string | null;
  onGitRefresh?: () => void | Promise<void>;
  /** Switch between Review / Browser pages inside the right panel. */
  onPageChange?: (page: RightPanelPage) => void;
  filesAvailable?: boolean;
  filesMeta?: string | null;
  /** Restore files from pre-mutation snapshots for the current review scope. */
  canUndo?: boolean;
  undoBusy?: boolean;
  onUndoChanges?: () => void | Promise<void>;
  onAddComment?: (
    file: ReviewFileChange,
    selection: ReviewCommentSelection,
    body: string,
  ) => void;
};

type DiffSelection = {
  filePath: string;
  anchorLine: number;
  focusLine: number;
};

type DiffCommentEditor = {
  filePath: string;
  startLine: number;
  endLine: number;
  body: string;
};

const WIDTH_MIN = 320;
/** Floor while the file list is open (list ≈220 + readable diff column). */
const WIDTH_MIN_WITH_LIST = 480;
const WIDTH_MAX = 1200;
const WIDTH_DEFAULT = 560;
const WIDTH_KEY = "review-panel-width";

function loadReviewPanelWidth(): number {
  try {
    const width = Number(localStorage.getItem(WIDTH_KEY));
    if (Number.isFinite(width) && width >= WIDTH_MIN && width <= WIDTH_MAX) {
      return width;
    }
  } catch {
    /* ignore */
  }
  return WIDTH_DEFAULT;
}

function StatusGlyph({ status }: { status: ReviewFileStatus }) {
  const label =
    status === "added" ? "A" : status === "deleted" ? "D" : "M";
  return (
    <span
      className={`review-panel__kind review-panel__kind--${status}`}
      title={status}
      aria-label={status}
    >
      {label}
    </span>
  );
}

function DiffStat({
  additions,
  deletions,
  layout = "inline",
}: {
  additions: number;
  deletions: number;
  layout?: "inline" | "aligned";
}) {
  return (
    <span
      className={
        layout === "aligned"
          ? "review-panel__stat review-panel__stat--aligned"
          : "review-panel__stat"
      }
      aria-label={`${additions} additions, ${deletions} deletions`}
    >
      <b>+{formatCompactDiffCount(additions)}</b>
      <em>-{formatCompactDiffCount(deletions)}</em>
    </span>
  );
}

function pairSplitLines(lines: ReviewDiffLine[]): {
  left: ReviewDiffLine[];
  right: ReviewDiffLine[];
} {
  const left: ReviewDiffLine[] = [];
  const right: ReviewDiffLine[] = [];
  for (const line of lines) {
    if (line.kind === "meta") {
      left.push(line);
      right.push(line);
    } else if (line.kind === "del") {
      left.push(line);
      right.push({ kind: "ctx", code: "" });
    } else if (line.kind === "add") {
      left.push({ kind: "ctx", code: "" });
      right.push(line);
    } else {
      left.push(line);
      right.push(line);
    }
  }
  return { left, right };
}

function DiffLineRow({
  line,
  side,
  lineIndex,
  selected = false,
  selectionEnd = false,
  commentable = false,
  onPointerDown,
  onPointerEnter,
  onAddComment,
}: {
  line: ReviewDiffLine;
  side?: "left" | "right";
  lineIndex?: number;
  selected?: boolean;
  selectionEnd?: boolean;
  commentable?: boolean;
  onPointerDown?: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onPointerEnter?: () => void;
  onAddComment?: () => void;
}) {
  const gutter =
    line.kind === "add"
      ? "+"
      : line.kind === "del"
        ? "−"
        : line.kind === "meta"
          ? "…"
          : " ";
  return (
    <div
      className={`${
        line.kind === "add"
          ? "review-diff__line review-diff__line--add"
          : line.kind === "del"
            ? "review-diff__line review-diff__line--del"
            : line.kind === "meta"
              ? "review-diff__line review-diff__line--meta"
              : "review-diff__line"
      }${selected ? " is-selected" : ""}${selectionEnd ? " is-selection-end" : ""}`}
      data-side={side}
      data-review-line-index={lineIndex}
      onPointerDown={onPointerDown}
      onPointerEnter={onPointerEnter}
    >
      {commentable ? (
        <button
          type="button"
          className="review-diff__comment-add"
          aria-label={`Comment on line ${line.newLine ?? line.oldLine ?? (lineIndex ?? 0) + 1}`}
          title="Add comment"
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.stopPropagation();
            onAddComment?.();
          }}
        >
          +
        </button>
      ) : null}
      <span className="review-diff__number" aria-hidden>
        {line.newLine ?? line.oldLine ?? ""}
      </span>
      <span className="review-diff__gutter" aria-hidden>
        {gutter}
      </span>
      <span className="review-diff__code">{line.code || "\u00a0"}</span>
    </div>
  );
}

function FileDiffBody({
  file,
  style,
  collapsed,
  onToggle,
  index = 0,
  selection,
  commentEditor,
  onLinePointerDown,
  onLinePointerEnter,
  onOpenComment,
  onCommentBodyChange,
  onSubmitComment,
  onCancelComment,
}: {
  file: ReviewFileChange;
  style: ReviewDiffStyle;
  collapsed: boolean;
  onToggle: () => void;
  index?: number;
  selection: DiffSelection | null;
  commentEditor: DiffCommentEditor | null;
  onLinePointerDown: (
    filePath: string,
    lineIndex: number,
    event: ReactPointerEvent<HTMLDivElement>,
  ) => void;
  onLinePointerEnter: (filePath: string, lineIndex: number) => void;
  onOpenComment: (file: ReviewFileChange, lineIndex: number) => void;
  onCommentBodyChange: (value: string) => void;
  onSubmitComment: (file: ReviewFileChange) => void;
  onCancelComment: () => void;
}) {
  const name = fileNameOf(file.path);
  const dir = dirNameOf(file.displayPath || file.path);
  const bodyPresence = usePresence(!collapsed, 200);

  return (
    <section
      className={`review-diff right-panel-anim-item${collapsed ? " is-collapsed" : ""}`}
      data-path={file.path}
      aria-label={`Diff ${file.displayPath}`}
      style={{ ["--rp-i" as string]: index }}
    >
      <header className="review-diff__head">
        <button
          type="button"
          className="review-diff__toggle"
          aria-expanded={!collapsed}
          aria-label={collapsed ? "Expand file diff" : "Collapse file diff"}
          onClick={onToggle}
        >
          <span className={`review-diff__chev${collapsed ? "" : " is-open"}`} aria-hidden>
            <ChevronRight size={12} strokeWidth={1.8} />
          </span>
          <StatusGlyph status={file.status} />
          <span className="review-diff__title">
            <span className="review-diff__name">{name}</span>
            {dir ? <span className="review-diff__dir">{dir}</span> : null}
          </span>
        </button>
        <DiffStat additions={file.additions} deletions={file.deletions} />
      </header>
      {bodyPresence.present ? (
        <div
          className={`review-diff__body right-panel-collapse${bodyPresence.visible ? " is-open" : ""}`}
          aria-hidden={!bodyPresence.visible}
        >
          <div className="right-panel-collapse__inner">
            {file.header ? (
              <div className="review-diff__header" title={file.header}>
                {file.header}
              </div>
            ) : null}
            {/* Scroll lives here (not on the collapse grid) so long lines are
                not clipped mid-token by overflow:hidden ancestors. */}
            <div className="review-diff__scroll">
              {style === "split" ? (
                <div className="review-diff__split" role="table">
                  {(() => {
                    const { left, right } = pairSplitLines(file.lines);
                    return left.map((l, i) => (
                      <div key={i} className="review-diff__split-row">
                        <DiffLineRow line={l} side="left" />
                        <DiffLineRow
                          line={right[i] ?? { kind: "ctx", code: "" }}
                          side="right"
                        />
                      </div>
                    ));
                  })()}
                </div>
              ) : (
                <div className="review-diff__pre" role="table">
                  {file.lines.map((line, i) => {
                    const bounds =
                      selection?.filePath === file.path
                        ? {
                            start: Math.min(selection.anchorLine, selection.focusLine),
                            end: Math.max(selection.anchorLine, selection.focusLine),
                          }
                        : null;
                    const selected =
                      line.kind !== "meta" &&
                      bounds != null &&
                      i >= bounds.start &&
                      i <= bounds.end;
                    const editorAfter =
                      commentEditor?.filePath === file.path &&
                      i === commentEditor.endLine;
                    return (
                      <div key={i} className="review-diff__row-wrap">
                        <DiffLineRow
                          line={line}
                          lineIndex={i}
                          selected={selected}
                          selectionEnd={selected && i === bounds?.end}
                          commentable={line.kind !== "meta"}
                          onPointerDown={
                            line.kind === "meta"
                              ? undefined
                              : (event) =>
                                  onLinePointerDown(file.path, i, event)
                          }
                          onPointerEnter={
                            line.kind === "meta"
                              ? undefined
                              : () => onLinePointerEnter(file.path, i)
                          }
                          onAddComment={() => onOpenComment(file, i)}
                        />
                        {editorAfter ? (
                          <div className="review-diff__comment-editor">
                            <textarea
                              autoFocus
                              value={commentEditor.body}
                              placeholder="Add a comment..."
                              aria-label={`Comment on ${file.displayPath} ${buildReviewCommentSelection(file, commentEditor.startLine, commentEditor.endLine)?.rangeLabel ?? "selection"}`}
                              onChange={(event) =>
                                onCommentBodyChange(event.target.value)
                              }
                              onKeyDown={(event) => {
                                if (event.key === "Escape") {
                                  event.preventDefault();
                                  onCancelComment();
                                } else if (
                                  event.key === "Enter" &&
                                  (event.ctrlKey || event.metaKey)
                                ) {
                                  event.preventDefault();
                                  onSubmitComment(file);
                                }
                              }}
                            />
                            <div className="review-diff__comment-actions">
                              <span>Ctrl+Enter to add</span>
                              <button type="button" onClick={onCancelComment}>
                                Cancel
                              </button>
                              <button
                                type="button"
                                className="is-primary"
                                disabled={!commentEditor.body.trim()}
                                onClick={() => onSubmitComment(file)}
                              >
                                Comment
                              </button>
                            </div>
                          </div>
                        ) : null}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}

export function ReviewChangesPanel({
  open,
  files,
  scope,
  onScopeChange,
  diffStyle,
  onDiffStyleChange,
  activePath,
  onSelectFile,
  onClose,
  streaming = false,
  gitStatus = null,
  gitLoading = false,
  gitBusy = false,
  onGitCommit,
  onGitPush,
  onGitOpenPr,
  gitPrUrl = null,
  onGitRefresh,
  onPageChange,
  filesAvailable = false,
  filesMeta = null,
  canUndo = false,
  undoBusy = false,
  onUndoChanges,
  onAddComment,
}: Props) {
  const [filter, setFilter] = useState("");
  const [listOpen, setListOpen] = useState(false);
  const [wordWrap, setWordWrap] = useState(true);
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const [scopeMenuOpen, setScopeMenuOpen] = useState(false);
  const [panelWidth, setPanelWidth] = useState(loadReviewPanelWidth);
  const [resizing, setResizing] = useState(false);
  const [selection, setSelection] = useState<DiffSelection | null>(null);
  const [commentEditor, setCommentEditor] =
    useState<DiffCommentEditor | null>(null);
  const selectingRef = useRef(false);
  const filterRef = useRef<HTMLInputElement>(null);
  const scopeMenuRef = useRef<HTMLDivElement>(null);
  const previewRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLElement>(null);
  const widthRef = useRef(panelWidth);
  const resizeRef = useRef<{
    pointerId: number;
    startX: number;
    startWidth: number;
  } | null>(null);
  widthRef.current = panelWidth;

  const panelPresence = usePresence(open, 220);
  const listPresence = usePresence(listOpen && open, 200);
  const scopeMenuPresence = usePresence(scopeMenuOpen, 140);

  const filtered = useMemo(
    () => filterReviewFiles(files, filter),
    [files, filter],
  );
  const summary = useMemo(() => summarizeReviewChanges(files), [files]);
  const filteredSummary = useMemo(
    () => summarizeReviewChanges(filtered),
    [filtered],
  );

  // Keep active file valid when the list shrinks / filter changes.
  useEffect(() => {
    if (!open) return;
    if (filtered.length === 0) {
      if (activePath) onSelectFile(null);
      return;
    }
    if (activePath && filtered.some((f) => f.path === activePath)) return;
    onSelectFile(filtered[0].path);
  }, [open, filtered, activePath, onSelectFile]);

  // Reset local UI when panel closes or scope flips.
  useEffect(() => {
    if (!open) {
      setFilter("");
      setScopeMenuOpen(false);
      setCollapsed(new Set());
    }
  }, [open]);

  useEffect(() => {
    setCollapsed(new Set());
    setFilter("");
    setSelection(null);
    setCommentEditor(null);
  }, [scope]);

  useEffect(() => {
    const finishSelection = () => {
      selectingRef.current = false;
      document.body.style.userSelect = "";
    };
    window.addEventListener("pointerup", finishSelection);
    window.addEventListener("pointercancel", finishSelection);
    return () => {
      window.removeEventListener("pointerup", finishSelection);
      window.removeEventListener("pointercancel", finishSelection);
    };
  }, []);

  const onLinePointerDown = useCallback(
    (
      filePath: string,
      lineIndex: number,
      event: ReactPointerEvent<HTMLDivElement>,
    ) => {
      if (event.button !== 0) return;
      event.preventDefault();
      selectingRef.current = true;
      document.body.style.userSelect = "none";
      setCommentEditor(null);
      setSelection({ filePath, anchorLine: lineIndex, focusLine: lineIndex });
    },
    [],
  );

  const onLinePointerEnter = useCallback(
    (filePath: string, lineIndex: number) => {
      if (!selectingRef.current) return;
      setSelection((current) =>
        current?.filePath === filePath
          ? { ...current, focusLine: lineIndex }
          : current,
      );
    },
    [],
  );

  const openCommentEditor = useCallback(
    (file: ReviewFileChange, lineIndex: number) => {
      const bounds =
        selection?.filePath === file.path
          ? {
              start: Math.min(selection.anchorLine, selection.focusLine),
              end: Math.max(selection.anchorLine, selection.focusLine),
            }
          : null;
      const inSelection =
        bounds != null && lineIndex >= bounds.start && lineIndex <= bounds.end;
      const startLine = inSelection ? bounds.start : lineIndex;
      const endLine = inSelection ? bounds.end : lineIndex;
      setSelection({
        filePath: file.path,
        anchorLine: startLine,
        focusLine: endLine,
      });
      setCommentEditor({ filePath: file.path, startLine, endLine, body: "" });
    },
    [selection],
  );

  const submitComment = useCallback(
    (file: ReviewFileChange) => {
      if (!commentEditor || commentEditor.filePath !== file.path) return;
      const body = commentEditor.body.trim();
      if (!body) return;
      const built = buildReviewCommentSelection(
        file,
        commentEditor.startLine,
        commentEditor.endLine,
      );
      if (!built) return;
      onAddComment?.(file, built, body);
      setCommentEditor(null);
      setSelection(null);
    },
    [commentEditor, onAddComment],
  );

  useEffect(() => {
    if (!scopeMenuOpen) return;
    const onDoc = (e: MouseEvent) => {
      if (!scopeMenuRef.current?.contains(e.target as Node)) {
        setScopeMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [scopeMenuOpen]);

  // Scroll active file card into view in the stacked preview.
  useEffect(() => {
    if (!open || !activePath || !previewRef.current) return;
    const el = previewRef.current.querySelector(
      `[data-path="${CSS.escape(activePath)}"]`,
    );
    if (el instanceof HTMLElement) {
      el.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }
  }, [open, activePath]);

  const allCollapsed =
    filtered.length > 0 && filtered.every((f) => collapsed.has(f.path));

  const toggleAll = useCallback(() => {
    setCollapsed((prev) => {
      if (filtered.length === 0) return prev;
      if (filtered.every((f) => prev.has(f.path))) return new Set();
      return new Set(filtered.map((f) => f.path));
    });
  }, [filtered]);

  const toggleOne = useCallback((path: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);

  const finishResize = useCallback(
    (e?: ReactPointerEvent<HTMLDivElement>) => {
      const resize = resizeRef.current;
      if (resize && e?.currentTarget.hasPointerCapture(resize.pointerId)) {
        e.currentTarget.releasePointerCapture(resize.pointerId);
      }
      resizeRef.current = null;
      setResizing(false);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      try {
        localStorage.setItem(WIDTH_KEY, String(widthRef.current));
      } catch {
        /* ignore */
      }
    },
    [],
  );

  const onResizeStart = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      e.preventDefault();
      e.currentTarget.setPointerCapture(e.pointerId);
      resizeRef.current = {
        pointerId: e.pointerId,
        startX: e.clientX,
        startWidth: panelWidth,
      };
      setResizing(true);
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
    },
    [panelWidth],
  );

  const onResizeMove = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      const resize = resizeRef.current;
      if (!resize || resize.pointerId !== e.pointerId) return;
      const containerWidth =
        panelRef.current?.parentElement?.clientWidth ?? window.innerWidth;
      const floor = listOpen ? WIDTH_MIN_WITH_LIST : WIDTH_MIN;
      const availableMax = Math.max(floor, containerWidth - WIDTH_MIN);
      const max = Math.min(WIDTH_MAX, availableMax);
      const next = resize.startWidth + resize.startX - e.clientX;
      setPanelWidth(Math.min(max, Math.max(floor, next)));
    },
    [listOpen],
  );

  // If the file list is shown again after a very narrow resize, lift the floor.
  useEffect(() => {
    if (!listOpen) return;
    setPanelWidth((w) => (w < WIDTH_MIN_WITH_LIST ? WIDTH_MIN_WITH_LIST : w));
  }, [listOpen]);

  useEffect(
    () => () => {
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    },
    [],
  );

  const onFilterKeyDown = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    if (filtered.length === 0) return;
    const idx = activePath
      ? filtered.findIndex((f) => f.path === activePath)
      : -1;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      const next = filtered[Math.min(filtered.length - 1, Math.max(0, idx) + 1)];
      if (next) onSelectFile(next.path);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      const next = filtered[Math.max(0, (idx < 0 ? 0 : idx) - 1)];
      if (next) onSelectFile(next.path);
    } else if (e.key === "Enter" && activePath) {
      e.preventDefault();
      setCollapsed((prev) => {
        const next = new Set(prev);
        next.delete(activePath);
        return next;
      });
    }
  };

  if (!panelPresence.present) return null;

  const panelClosing = !open && panelPresence.present;
  const scopeLabel =
    scope === "turn"
      ? "Latest turn"
      : scope === "session"
        ? "This chat"
        : "Working tree";
  const emptyHint = streaming
    ? "Waiting for file edits…"
    : scope === "turn"
      ? "No file changes in the last turn."
      : scope === "session"
        ? "No file changes in this chat yet."
        : "Working tree is clean.";

  return (
    <aside
      ref={panelRef}
      className={`review-panel right-panel-shell${open ? " is-open" : ""}${panelClosing ? " is-closing" : ""}${listOpen ? "" : " is-list-collapsed"}${wordWrap ? " is-wrap" : ""}${resizing ? " is-resizing" : ""}`}
      aria-label="Review changes"
      aria-hidden={!open}
      data-review-panel="true"
      data-state={open ? "open" : panelClosing ? "closed" : "opening"}
      style={{ "--review-panel-width": `${panelWidth}px` } as CSSProperties}
    >
      <div
        className="review-panel__resizer"
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize review panel"
        title="Drag to resize"
        onPointerDown={onResizeStart}
        onPointerMove={onResizeMove}
        onPointerUp={finishResize}
        onPointerCancel={finishResize}
      />
      <div className="right-panel-shell__inner">
      {onPageChange ? (
        <div className="review-panel__tabs right-panel-anim-head">
          <RightPanelPageSwitcher
            page="review"
            onPageChange={onPageChange}
            filesAvailable={filesAvailable}
            filesMeta={filesMeta}
            reviewStats={
              summary.fileCount > 0
                ? {
                    fileCount: summary.fileCount,
                    additions: summary.additions,
                    deletions: summary.deletions,
                  }
                : null
            }
            onClosePage={onClose}
          />
        </div>
      ) : null}
      <header className="review-panel__header right-panel-anim-head">
        <div className="review-panel__header-left" ref={scopeMenuRef}>
          <div className="review-panel__scope">
            <button
              type="button"
              className="review-panel__scope-btn"
              aria-haspopup="listbox"
              aria-expanded={scopeMenuOpen}
              aria-label={`Diff scope: ${scopeLabel}`}
              onClick={() => setScopeMenuOpen((v) => !v)}
            >
              <span className="review-panel__scope-label">{scopeLabel}</span>
              <ChevronDown
                className={`right-panel-menu-chev${scopeMenuOpen ? " is-open" : ""}`}
                size={12}
                strokeWidth={1.8}
                aria-hidden
              />
            </button>
            {scopeMenuPresence.present ? (
              <div
                className={`review-panel__scope-menu right-panel-menu${scopeMenuPresence.visible ? " is-open" : ""}`}
                role="listbox"
                aria-hidden={!scopeMenuPresence.visible}
              >
                <button
                  type="button"
                  role="option"
                  aria-selected={scope === "turn"}
                  className={scope === "turn" ? "is-active" : undefined}
                  onClick={() => {
                    onScopeChange("turn");
                    setScopeMenuOpen(false);
                  }}
                >
                  Latest turn
                </button>
                <button
                  type="button"
                  role="option"
                  aria-selected={scope === "session"}
                  className={scope === "session" ? "is-active" : undefined}
                  onClick={() => {
                    onScopeChange("session");
                    setScopeMenuOpen(false);
                  }}
                >
                  This chat
                </button>
                <button
                  type="button"
                  role="option"
                  aria-selected={scope === "git"}
                  className={scope === "git" ? "is-active" : undefined}
                  onClick={() => {
                    onScopeChange("git");
                    setScopeMenuOpen(false);
                  }}
                >
                  Working tree
                </button>
              </div>
            ) : null}
          </div>
          {summary.fileCount > 0 ? (
            <>
              <DiffStat
                additions={summary.additions}
                deletions={summary.deletions}
              />
              <span className="review-panel__count" title="Changed files">
                {summary.fileCount} file{summary.fileCount === 1 ? "" : "s"}
              </span>
            </>
          ) : null}
        </div>
        <div className="review-panel__header-right">
          {scope !== "git" && onUndoChanges ? (
            <button
              type="button"
              className="review-panel__undo-btn"
              disabled={!canUndo || undoBusy}
              aria-label={
                scope === "turn"
                  ? "Undo file changes from last turn"
                  : "Undo file changes from this chat"
              }
              title={
                !canUndo
                  ? "No restorable snapshots for this scope"
                  : scope === "turn"
                    ? "Restore files to before the last agent turn"
                    : "Restore files to before agent edits in this chat"
              }
              onClick={() => void onUndoChanges()}
            >
              {undoBusy ? "Undoing…" : "Undo"}
            </button>
          ) : null}
          <button
            type="button"
            className={`review-panel__icon-btn${listOpen ? " is-active" : ""}`}
            aria-pressed={listOpen}
            aria-label={listOpen ? "Hide file list" : "Show file list"}
            title={listOpen ? "Hide file list" : "Show file list"}
            onClick={() => setListOpen((v) => !v)}
          >
            <ListFilter size={14} strokeWidth={1.8} aria-hidden />
          </button>
          {filtered.length > 0 ? (
            <button
              type="button"
              className="review-panel__icon-btn"
              aria-label={allCollapsed ? "Expand all files" : "Collapse all files"}
              title={allCollapsed ? "Expand all" : "Collapse all"}
              onClick={toggleAll}
            >
              {allCollapsed ? (
                <ChevronsUpDown size={14} strokeWidth={1.7} aria-hidden />
              ) : (
                <ChevronsDownUp size={14} strokeWidth={1.7} aria-hidden />
              )}
            </button>
          ) : null}
          <div className="review-panel__style-toggle" role="group" aria-label="Diff layout">
            <button
              type="button"
              className={diffStyle === "unified" ? "is-active" : undefined}
              aria-pressed={diffStyle === "unified"}
              aria-label="Unified diff"
              title="Unified"
              onClick={() => onDiffStyleChange("unified")}
            >
              <Rows3 size={14} strokeWidth={1.8} aria-hidden />
            </button>
            <button
              type="button"
              className={diffStyle === "split" ? "is-active" : undefined}
              aria-pressed={diffStyle === "split"}
              aria-label="Split diff"
              title="Split"
              onClick={() => onDiffStyleChange("split")}
            >
              <Columns2 size={14} strokeWidth={1.7} aria-hidden />
            </button>
          </div>
          <button
            type="button"
            className={`review-panel__icon-btn${wordWrap ? " is-active" : ""}`}
            aria-pressed={wordWrap}
            aria-label={wordWrap ? "Disable diff line wrapping" : "Enable diff line wrapping"}
            title={wordWrap ? "Disable line wrapping" : "Enable line wrapping"}
            onClick={() => setWordWrap((value) => !value)}
          >
            <WrapText size={14} strokeWidth={1.8} aria-hidden />
          </button>
          {!onPageChange ? (
            <button
              type="button"
              className="review-panel__close"
              aria-label="Close review panel"
              title="Close"
              onClick={onClose}
            >
              <X size={14} strokeWidth={2} aria-hidden />
            </button>
          ) : null}
        </div>
      </header>

      <div className="review-panel__body right-panel-anim-body">
        {listPresence.present ? (
          <div
            className={`review-panel__list right-panel-list-shell${listPresence.visible ? " is-open" : ""}`}
            aria-label="Changed files"
            aria-hidden={!listPresence.visible}
          >
            <div className="review-panel__list-inner">
              <div className="review-panel__filter">
                <Search size={13} strokeWidth={1.8} aria-hidden />
                <input
                  ref={filterRef}
                  type="search"
                  value={filter}
                  placeholder="Filter files…"
                  aria-label="Filter changed files"
                  onChange={(e) => setFilter(e.target.value)}
                  onKeyDown={onFilterKeyDown}
                />
                {filter ? (
                  <span className="review-panel__filter-meta">
                    {filteredSummary.fileCount}/{summary.fileCount}
                  </span>
                ) : null}
              </div>
              {filtered.length === 0 ? (
                <div className="review-panel__list-empty">
                  {files.length === 0 ? emptyHint : "No files match this filter."}
                </div>
              ) : (
                <ul className="review-panel__files">
                  {filtered.map((f, idx) => {
                    const active = f.path === activePath;
                    return (
                      <li
                        key={f.path}
                        className="right-panel-anim-item"
                        style={{ ["--rp-i" as string]: idx }}
                      >
                        <button
                          type="button"
                          className={`review-panel__file${active ? " is-active" : ""}`}
                          aria-current={active ? "true" : undefined}
                          onClick={() => {
                            onSelectFile(f.path);
                            setCollapsed((prev) => {
                              const next = new Set(prev);
                              next.delete(f.path);
                              return next;
                            });
                          }}
                        >
                          <StatusGlyph status={f.status} />
                          <span className="review-panel__file-text">
                            <span className="review-panel__file-name">
                              {fileNameOf(f.path)}
                            </span>
                            <span className="review-panel__file-path" title={f.path}>
                              {dirNameOf(f.displayPath || f.path) || f.displayPath}
                            </span>
                          </span>
                          <DiffStat
                            additions={f.additions}
                            deletions={f.deletions}
                            layout="aligned"
                          />
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          </div>
        ) : null}

        <div className="review-panel__preview" ref={previewRef}>
          {scope === "git" && onGitCommit && onGitPush ? (
            <div className="review-panel__git-page right-panel-anim-item">
              <ReviewGitPage
                status={gitStatus}
                loading={gitLoading}
                busy={gitBusy}
                onCommit={onGitCommit}
                onPush={onGitPush}
                onOpenPr={onGitOpenPr}
                prUrl={gitPrUrl}
                onRefresh={onGitRefresh}
              />
            </div>
          ) : null}
          {filtered.length === 0 ? (
            scope === "git" && onGitCommit && onGitPush ? (
              <div className="review-panel__empty review-panel__empty--compact right-panel-anim-item">
                <p>{emptyHint}</p>
              </div>
            ) : (
            <div className="review-panel__empty right-panel-anim-item">
              <div className="review-panel__empty-icon" aria-hidden>
                <FileDiff size={28} strokeWidth={1.5} />
              </div>
              <p>{emptyHint}</p>
              {streaming ? (
                <span className="review-panel__empty-hint">
                  Edits appear here as tools finish.
                </span>
              ) : null}
            </div>
            )
          ) : (
            <div className="review-panel__stack">
              {filtered.map((f, idx) => (
                <FileDiffBody
                  key={f.path}
                  file={f}
                  style={diffStyle}
                  collapsed={collapsed.has(f.path)}
                  index={idx}
                  onToggle={() => {
                    onSelectFile(f.path);
                    toggleOne(f.path);
                  }}
                  selection={selection}
                  commentEditor={commentEditor}
                  onLinePointerDown={onLinePointerDown}
                  onLinePointerEnter={onLinePointerEnter}
                  onOpenComment={openCommentEditor}
                  onCommentBodyChange={(body) =>
                    setCommentEditor((current) =>
                      current ? { ...current, body } : current,
                    )
                  }
                  onSubmitComment={submitComment}
                  onCancelComment={() => setCommentEditor(null)}
                />
              ))}
            </div>
          )}
        </div>
      </div>
      </div>
    </aside>
  );
}
