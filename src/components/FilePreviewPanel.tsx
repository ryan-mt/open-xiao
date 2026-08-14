import hljs from "highlight.js/lib/common";
import {
  ChevronDown,
  ChevronRight,
  Eye,
  FileCode2,
  FileImage,
  FileJson2,
  FileText,
  Folder,
  FolderOpen,
  FolderTree,
  LoaderCircle,
  RefreshCw,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from "react";
import {
  listProjectEntries,
  readProjectFile,
  type ProjectFilePreview,
} from "../auth";
import {
  buildProjectFileTree,
  closeProjectFileTab,
  filePreviewLanguage,
  filterProjectFileTree,
  openProjectFileTab,
  settleOwnedProjectEntriesRequest,
  type ProjectFileTreeNode,
} from "../projectFiles";
import { usePresence } from "../usePresence";
import { Markdown } from "./Markdown";
import {
  RightPanelPageSwitcher,
  type RightPanelPage,
} from "./RightPanelControls";

type Props = {
  open: boolean;
  workspacePath: string | null;
  projectName: string | null;
  reviewStats?: {
    fileCount: number;
    additions: number;
    deletions: number;
  } | null;
  previewUrl?: string | null;
  onClose: () => void;
  onPageChange: (page: RightPanelPage) => void;
};

const PANEL_WIDTH_KEY = "open-xiao.filePanelWidth";
const EXPLORER_OPEN_KEY = "open-xiao.fileExplorerOpen";
const MARKDOWN_RENDER_KEY = "open-xiao.renderMarkdown";
const DEFAULT_PANEL_WIDTH = 560;
const MIN_PANEL_WIDTH = 480;

function loadPanelWidth(): number {
  try {
    const parsed = Number(localStorage.getItem(PANEL_WIDTH_KEY));
    return Number.isFinite(parsed) && parsed >= MIN_PANEL_WIDTH
      ? parsed
      : DEFAULT_PANEL_WIDTH;
  } catch {
    return DEFAULT_PANEL_WIDTH;
  }
}

function loadBoolean(key: string, fallback: boolean): boolean {
  try {
    const stored = localStorage.getItem(key);
    return stored === null ? fallback : stored === "true";
  } catch {
    return fallback;
  }
}

function savePreference(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* Preferences remain usable in memory when storage is unavailable. */
  }
}

function basename(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function highlightedSource(path: string, contents: string): string {
  const language = filePreviewLanguage(path);
  if (language === "text" || !hljs.getLanguage(language)) {
    return escapeHtml(contents);
  }
  try {
    return hljs.highlight(contents, { language }).value;
  } catch {
    return escapeHtml(contents);
  }
}

function FileKindIcon({ path }: { path: string }) {
  const lower = path.toLocaleLowerCase();
  if (/\.(png|jpe?g|gif|webp|bmp)$/.test(lower)) {
    return <FileImage aria-hidden />;
  }
  if (/\.(json|jsonc)$/.test(lower)) return <FileJson2 aria-hidden />;
  if (/\.(md|mdx|txt)$/.test(lower) || !basename(path).includes(".")) {
    return <FileText aria-hidden />;
  }
  return <FileCode2 aria-hidden />;
}

function FileTreeRows({
  nodes,
  depth,
  expanded,
  forceExpanded,
  selectedPath,
  onToggle,
  onOpenFile,
}: {
  nodes: readonly ProjectFileTreeNode[];
  depth: number;
  expanded: ReadonlySet<string>;
  forceExpanded: boolean;
  selectedPath: string | null;
  onToggle: (path: string) => void;
  onOpenFile: (path: string) => void;
}) {
  return nodes.map((node) => {
    const isExpanded = node.isDir && (forceExpanded || expanded.has(node.path));
    return (
      <div
        key={node.path}
        role="treeitem"
        aria-expanded={node.isDir ? isExpanded : undefined}
      >
        <button
          type="button"
          className={`file-tree__row${selectedPath === node.path ? " is-selected" : ""}`}
          style={{ "--file-tree-depth": depth } as CSSProperties}
          title={node.path}
          onClick={() =>
            node.isDir ? onToggle(node.path) : onOpenFile(node.path)
          }
        >
          <span className="file-tree__chevron" aria-hidden>
            {node.isDir ? (
              isExpanded ? (
                <ChevronDown />
              ) : (
                <ChevronRight />
              )
            ) : null}
          </span>
          <span className="file-tree__icon" aria-hidden>
            {node.isDir ? (
              isExpanded ? (
                <FolderOpen />
              ) : (
                <Folder />
              )
            ) : (
              <FileKindIcon path={node.path} />
            )}
          </span>
          <span className="file-tree__name">{node.name}</span>
        </button>
        {node.isDir && isExpanded && node.children.length > 0 ? (
          <FileTreeRows
            nodes={node.children}
            depth={depth + 1}
            expanded={expanded}
            forceExpanded={forceExpanded}
            selectedPath={selectedPath}
            onToggle={onToggle}
            onOpenFile={onOpenFile}
          />
        ) : null}
      </div>
    );
  });
}

export default function FilePreviewPanel({
  open,
  workspacePath,
  projectName,
  reviewStats = null,
  previewUrl = null,
  onClose,
  onPageChange,
}: Props) {
  const presence = usePresence(open, 220);
  const [panelWidth, setPanelWidth] = useState(loadPanelWidth);
  const [resizing, setResizing] = useState(false);
  const resizeRef = useRef({ pointerId: -1, startX: 0, startWidth: 0 });
  const [entries, setEntries] = useState<
    Awaited<ReturnType<typeof listProjectEntries>>
  >([]);
  const [entriesLoading, setEntriesLoading] = useState(false);
  const [entriesError, setEntriesError] = useState<string | null>(null);
  const entriesRequestRef = useRef(0);
  const workspacePathRef = useRef(workspacePath);
  workspacePathRef.current = workspacePath;
  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [openPaths, setOpenPaths] = useState<string[]>([]);
  const [activePath, setActivePath] = useState<string | null>(null);
  const [preview, setPreview] = useState<ProjectFilePreview | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [explorerOpen, setExplorerOpen] = useState(() =>
    loadBoolean(EXPLORER_OPEN_KEY, true),
  );
  const [renderMarkdown, setRenderMarkdown] = useState(() =>
    loadBoolean(MARKDOWN_RENDER_KEY, false),
  );

  const loadEntries = useCallback(async () => {
    const requestId = ++entriesRequestRef.current;
    const targetWorkspace = workspacePath;
    if (!targetWorkspace) {
      setEntries([]);
      setEntriesError(null);
      setEntriesLoading(false);
      return;
    }
    setEntriesLoading(true);
    setEntriesError(null);
    await settleOwnedProjectEntriesRequest(
      listProjectEntries(targetWorkspace),
      {
        isCurrent: () =>
          requestId === entriesRequestRef.current &&
          targetWorkspace === workspacePathRef.current,
        onSuccess: (next) => {
          setEntries(next);
          setExpanded((current) => {
            if (current.size > 0) return current;
            return new Set(
              next
                .filter((entry) => entry.isDir && !entry.parent)
                .map((entry) => entry.path),
            );
          });
        },
        onError: (error) => {
          setEntriesError(
            error instanceof Error
              ? error.message
              : "Could not load workspace files.",
          );
        },
        onSettled: () => setEntriesLoading(false),
      },
    );
  }, [workspacePath]);

  useEffect(() => {
    entriesRequestRef.current += 1;
    setEntries([]);
    setQuery("");
    setExpanded(new Set());
    setOpenPaths([]);
    setActivePath(null);
    setPreview(null);
    setPreviewError(null);
  }, [workspacePath]);

  useEffect(
    () => () => {
      entriesRequestRef.current += 1;
    },
    [],
  );

  useEffect(() => {
    if (open) void loadEntries();
  }, [open, loadEntries]);

  useEffect(() => {
    if (!workspacePath || !activePath) {
      setPreview(null);
      setPreviewError(null);
      setPreviewLoading(false);
      return;
    }
    let cancelled = false;
    setPreview(null);
    setPreviewError(null);
    setPreviewLoading(true);
    void readProjectFile(workspacePath, activePath)
      .then((next) => {
        if (!cancelled) setPreview(next);
      })
      .catch((error) => {
        if (!cancelled) {
          setPreviewError(
            error instanceof Error
              ? error.message
              : "Could not read this file.",
          );
        }
      })
      .finally(() => {
        if (!cancelled) setPreviewLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [workspacePath, activePath]);

  const tree = useMemo(() => buildProjectFileTree(entries), [entries]);
  const visibleTree = useMemo(
    () => filterProjectFileTree(tree, query),
    [tree, query],
  );
  const highlighted = useMemo(
    () =>
      activePath &&
      preview?.contents !== null &&
      preview?.contents !== undefined
        ? highlightedSource(activePath, preview.contents)
        : "",
    [activePath, preview?.contents],
  );
  const lineCount = preview?.contents ? preview.contents.split("\n").length : 1;
  const isMarkdown = activePath ? /\.mdx?$/i.test(activePath) : false;

  const openFile = useCallback((path: string) => {
    setOpenPaths((current) => openProjectFileTab(current, path));
    setActivePath(path);
  }, []);

  const closeFile = useCallback(
    (path: string) => {
      setOpenPaths((current) => {
        const next = closeProjectFileTab(current, activePath, path);
        setActivePath(next.activePath);
        return next.openPaths;
      });
    },
    [activePath],
  );

  const startResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    resizeRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startWidth: panelWidth,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    setResizing(true);
  };
  const moveResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!resizing || resizeRef.current.pointerId !== event.pointerId) return;
    const max = Math.max(MIN_PANEL_WIDTH, window.innerWidth - 320);
    setPanelWidth(
      Math.min(
        max,
        Math.max(
          MIN_PANEL_WIDTH,
          resizeRef.current.startWidth +
            resizeRef.current.startX -
            event.clientX,
        ),
      ),
    );
  };
  const finishResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (resizeRef.current.pointerId !== event.pointerId) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    savePreference(PANEL_WIDTH_KEY, String(panelWidth));
    setResizing(false);
  };

  if (!presence.present) return null;
  const closing = !open && presence.present;
  const crumbs = activePath?.split("/") ?? [];

  return (
    <aside
      className={`file-preview-panel right-panel-shell${open ? " is-open" : ""}${closing ? " is-closing" : ""}${resizing ? " is-resizing" : ""}`}
      aria-label="Workspace files"
      aria-hidden={!open}
      data-state={open ? "open" : closing ? "closed" : "opening"}
      style={{ "--files-panel-width": `${panelWidth}px` } as CSSProperties}
    >
      <div
        className="file-preview-panel__resizer"
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize files panel"
        onPointerDown={startResize}
        onPointerMove={moveResize}
        onPointerUp={finishResize}
        onPointerCancel={finishResize}
      />
      <div className="right-panel-shell__inner">
        <header className="file-preview-panel__tabs right-panel-anim-head">
          <RightPanelPageSwitcher
            page="files"
            onPageChange={onPageChange}
            reviewStats={reviewStats}
            previewUrl={previewUrl}
            filesAvailable={workspacePath !== null}
            filesMeta={projectName ?? "Workspace files"}
            fileTabs={openPaths}
            activeFilePath={activePath}
            onActivateFiles={() => setActivePath(null)}
            onActivateFile={setActivePath}
            onCloseFile={closeFile}
            onClosePage={onClose}
          />
        </header>

        {activePath ? (
          <div className="file-preview-panel__breadcrumb">
            <div className="file-preview-panel__crumbs" title={activePath}>
              <span>{projectName ?? "Project"}</span>
              {crumbs.map((crumb) => (
                <span key={crumb} className="file-preview-panel__crumb">
                  <ChevronRight aria-hidden />
                  <b>{crumb}</b>
                </span>
              ))}
            </div>
            <div className="file-preview-panel__tools">
              {isMarkdown && preview?.contents != null ? (
                <button
                  type="button"
                  className={renderMarkdown ? "is-active" : undefined}
                  aria-pressed={renderMarkdown}
                  aria-label={
                    renderMarkdown
                      ? "Show markdown source"
                      : "Show rendered markdown"
                  }
                  title={
                    renderMarkdown
                      ? "Show markdown source"
                      : "Show rendered markdown"
                  }
                  onClick={() => {
                    setRenderMarkdown((current) => {
                      savePreference(MARKDOWN_RENDER_KEY, String(!current));
                      return !current;
                    });
                  }}
                >
                  <Eye aria-hidden />
                </button>
              ) : null}
              <button
                type="button"
                className={explorerOpen ? "is-active" : undefined}
                aria-pressed={explorerOpen}
                aria-label={
                  explorerOpen ? "Hide file explorer" : "Show file explorer"
                }
                title={
                  explorerOpen ? "Hide file explorer" : "Show file explorer"
                }
                onClick={() => {
                  setExplorerOpen((current) => {
                    savePreference(EXPLORER_OPEN_KEY, String(!current));
                    return !current;
                  });
                }}
              >
                <FolderTree aria-hidden />
              </button>
            </div>
          </div>
        ) : null}

        {preview?.truncated ? (
          <div className="file-preview-panel__notice">
            Preview limited to the first 1 MB of{" "}
            {preview.byteLength.toLocaleString()} bytes.
          </div>
        ) : null}

        <div className="file-preview-panel__body right-panel-anim-body">
          {activePath ? (
            <section
              className="file-preview-panel__surface"
              aria-label={activePath}
            >
              {previewLoading ? (
                <div className="file-preview-panel__state">
                  <LoaderCircle className="is-spinning" aria-hidden />
                  Loading file...
                </div>
              ) : previewError ? (
                <div className="file-preview-panel__state is-error">
                  {previewError}
                </div>
              ) : preview?.dataUrl ? (
                <div className="file-preview-panel__image-wrap">
                  <img src={preview.dataUrl} alt={basename(activePath)} />
                </div>
              ) : preview?.contents !== null &&
                preview?.contents !== undefined ? (
                isMarkdown && renderMarkdown ? (
                  <div className="file-preview-panel__markdown">
                    <Markdown content={preview.contents} />
                  </div>
                ) : (
                  <div className="file-preview-panel__code-scroll">
                    <pre
                      className="file-preview-panel__line-numbers"
                      aria-hidden
                    >
                      {Array.from(
                        { length: lineCount },
                        (_, index) => index + 1,
                      ).join("\n")}
                    </pre>
                    <pre className="file-preview-panel__code">
                      <code
                        className={`hljs language-${filePreviewLanguage(activePath)}`}
                        dangerouslySetInnerHTML={{ __html: highlighted }}
                      />
                    </pre>
                  </div>
                )
              ) : null}
            </section>
          ) : null}

          <aside
            className={`file-explorer right-panel-list-shell${explorerOpen || !activePath ? " is-open" : ""}${!activePath ? " is-only" : ""}`}
            aria-label="File explorer"
          >
            <div className="file-explorer__inner">
              <div className="file-explorer__search-row">
                <button
                  type="button"
                  aria-label="Refresh workspace files"
                  title="Refresh files"
                  disabled={entriesLoading || !workspacePath}
                  onClick={() => void loadEntries()}
                >
                  <RefreshCw
                    className={entriesLoading ? "is-spinning" : undefined}
                    aria-hidden
                  />
                </button>
                <input
                  type="search"
                  value={query}
                  placeholder="Search files"
                  aria-label={`Search ${projectName ?? "project"} files`}
                  spellCheck={false}
                  onChange={(event) => setQuery(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Escape") {
                      setQuery("");
                      event.currentTarget.blur();
                    }
                  }}
                />
              </div>
              <div
                className="file-explorer__tree"
                role="tree"
                aria-label={`${projectName ?? "Project"} files`}
              >
                {!workspacePath ? (
                  <div className="file-explorer__empty">
                    Open a project chat to browse its files.
                  </div>
                ) : entriesError ? (
                  <div className="file-explorer__empty is-error">
                    {entriesError}
                  </div>
                ) : entriesLoading && entries.length === 0 ? (
                  <div className="file-explorer__empty">
                    Loading workspace files...
                  </div>
                ) : visibleTree.length === 0 ? (
                  <div className="file-explorer__empty">No matching files.</div>
                ) : (
                  <FileTreeRows
                    nodes={visibleTree}
                    depth={0}
                    expanded={expanded}
                    forceExpanded={query.trim().length > 0}
                    selectedPath={activePath}
                    onToggle={(path) =>
                      setExpanded((current) => {
                        const next = new Set(current);
                        if (next.has(path)) next.delete(path);
                        else next.add(path);
                        return next;
                      })
                    }
                    onOpenFile={openFile}
                  />
                )}
              </div>
            </div>
          </aside>
        </div>
      </div>
    </aside>
  );
}
