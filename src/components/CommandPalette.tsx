import {
  ArrowLeft,
  FileSearch,
  FolderPlus,
  PanelLeftClose,
  PanelLeftOpen,
  Search,
  Settings,
  SquarePen,
  TerminalSquare,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { Project, Thread } from "../types";
import { ProjectFavicon } from "./ProjectFavicon";
import { filterNewThreadProjects } from "./newThreadProjectPicker";

export type CommandPaletteView = "root" | "new-thread-in";

export type PaletteAction = {
  id: string;
  label: string;
  hint?: string;
  group: string;
  run: () => void;
};

type PaletteItem = {
  key: string;
  label: string;
  description?: string;
  hint?: string;
  group: string;
  icon: ReactNode;
  run: () => void;
};

type Props = {
  open: boolean;
  threads: Thread[];
  projects: Project[];
  actions: PaletteAction[];
  activeThreadId?: string | null;
  activeProjectId?: string | null;
  workingThreadIds?: string[];
  view?: CommandPaletteView;
  onSelectThread: (id: string) => void;
  onNewThreadInProject?: (projectId: string) => void;
  onBack?: () => void;
  onClose: () => void;
};

const ROOT_ACTION_IDS = new Set([
  "new",
  "new-worktree",
  "go-file",
  "search",
  "add-project",
  "settings",
]);

function actionIcon(id: string): ReactNode {
  if (id === "new" || id === "new-worktree") return <SquarePen />;
  if (id === "go-file") return <FileSearch />;
  if (id === "search") return <Search />;
  if (id === "add-project") return <FolderPlus />;
  if (id === "settings") return <Settings />;
  if (id === "toggle-terminal") return <TerminalSquare />;
  if (id === "sidebar") return <PanelLeftClose />;
  return <PanelLeftOpen />;
}

function relativeTime(timestamp: number): string {
  const seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1000));
  if (seconds < 45) return "now";
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)}h ago`;
  return `${Math.round(seconds / 86400)}d ago`;
}

function shortcutModifier(): string {
  if (typeof navigator === "undefined") return "Ctrl";
  return /Mac|iPhone|iPad|iPod/i.test(
    navigator.platform || navigator.userAgent,
  )
    ? "Cmd"
    : "Ctrl";
}

export function CommandPalette({
  open,
  threads,
  projects,
  actions,
  activeThreadId = null,
  activeProjectId = null,
  workingThreadIds = [],
  view = "root",
  onSelectThread,
  onNewThreadInProject,
  onBack,
  onClose,
}: Props) {
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const projectById = useMemo(
    () => new Map(projects.map((project) => [project.id, project])),
    [projects],
  );
  const working = useMemo(() => new Set(workingThreadIds), [workingThreadIds]);
  const projectPickerOpen = view === "new-thread-in";
  const orderedProjects = useMemo(() => {
    if (!activeProjectId) return projects;
    const current = projects.find((project) => project.id === activeProjectId);
    if (!current) return projects;
    return [current, ...projects.filter((project) => project.id !== activeProjectId)];
  }, [activeProjectId, projects]);

  const items = useMemo<PaletteItem[]>(() => {
    if (projectPickerOpen) {
      return filterNewThreadProjects(orderedProjects, query).map(
        (project, projectIndex) => ({
          key: `project:${project.id}`,
          label: project.name,
          description: project.path,
          hint:
            projectIndex < 9
              ? `${shortcutModifier()}+${projectIndex + 1}`
              : undefined,
          group: "Projects",
          icon: <ProjectFavicon path={project.path} size={15} />,
          run: () => onNewThreadInProject?.(project.id),
        }),
      );
    }
    const needle = query.trim().toLowerCase();
    const actionItems = actions
      .filter((action) =>
        needle
          ? `${action.label} ${action.group}`.toLowerCase().includes(needle)
          : ROOT_ACTION_IDS.has(action.id),
      )
      .map((action) => ({
        key: `action:${action.id}`,
        label: action.label,
        hint: action.hint,
        group: "Actions",
        icon: actionIcon(action.id),
        run: action.run,
      }));

    const threadItems = [...threads]
      .sort((left, right) => right.updatedAt - left.updatedAt)
      .filter((thread) => {
        if (!needle) return true;
        const project = thread.projectId ? projectById.get(thread.projectId) : null;
        return `${thread.title} ${project?.name ?? ""} ${thread.worktreeBranch ?? ""}`
          .toLowerCase()
          .includes(needle);
      })
      .slice(0, needle ? 16 : 8)
      .map((thread) => {
        const project = thread.projectId ? projectById.get(thread.projectId) : null;
        const status = working.has(thread.id)
          ? "Working"
          : thread.settledAt != null
            ? "Settled"
            : "";
        const description = [
          project?.name ?? "Chat",
          thread.worktreeBranch ? `#${thread.worktreeBranch}` : null,
          thread.id === activeThreadId ? "Current thread" : null,
        ]
          .filter(Boolean)
          .join(" · ");
        return {
          key: `thread:${thread.id}`,
          label: thread.title,
          description: status ? `${status} · ${description}` : description,
          hint: relativeTime(thread.updatedAt),
          group: "Recent Threads",
          icon: <ProjectFavicon path={project?.path ?? null} size={15} />,
          run: () => onSelectThread(thread.id),
        };
      });
    return [...actionItems, ...threadItems];
  }, [
    actions,
    activeThreadId,
    onNewThreadInProject,
    onSelectThread,
    orderedProjects,
    projectById,
    projectPickerOpen,
    query,
    threads,
    working,
  ]);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setIndex(0);
    const timer = window.setTimeout(() => inputRef.current?.focus(), 20);
    return () => window.clearTimeout(timer);
  }, [open, view]);

  useEffect(() => setIndex(0), [query]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopImmediatePropagation();
        onClose();
      } else if (
        projectPickerOpen &&
        event.key === "Backspace" &&
        query.length === 0
      ) {
        event.preventDefault();
        event.stopImmediatePropagation();
        onBack?.();
      } else if (event.key === "ArrowDown") {
        event.preventDefault();
        event.stopImmediatePropagation();
        setIndex((current) => Math.min(items.length - 1, current + 1));
      } else if (event.key === "ArrowUp") {
        event.preventDefault();
        event.stopImmediatePropagation();
        setIndex((current) => Math.max(0, current - 1));
      } else if (event.key === "Enter") {
        const item = items[index];
        if (!item) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        item.run();
        onClose();
      } else if (
        projectPickerOpen &&
        (event.metaKey || event.ctrlKey) &&
        !event.shiftKey &&
        !event.altKey &&
        /^[1-9]$/.test(event.key)
      ) {
        const item = items[Number(event.key) - 1];
        if (!item) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        item.run();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [index, items, onBack, onClose, open, projectPickerOpen, query.length]);

  if (!open) return null;
  let lastGroup = "";

  return (
    <div
      className="modal-backdrop cmdk-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        className="cmdk"
        role="dialog"
        aria-modal="true"
        aria-label={projectPickerOpen ? "Choose a project" : "Command palette"}
        data-command-palette-view={view}
      >
        <div className="cmdk__search">
          {projectPickerOpen ? (
            <button
              type="button"
              className="cmdk__back"
              onClick={onBack}
              aria-label="Back to command palette"
            >
              <ArrowLeft size={15} strokeWidth={1.7} />
            </button>
          ) : (
            <Search size={15} strokeWidth={1.7} aria-hidden />
          )}
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={
              projectPickerOpen
                ? "Search..."
                : "Search commands, projects, and threads..."
            }
            aria-label={
              projectPickerOpen
                ? "Search projects"
                : "Search commands, projects, and threads"
            }
          />
        </div>
        <div className="cmdk__list" role="listbox">
          {items.length === 0 ? (
            <div className="cmdk__empty">No matches.</div>
          ) : (
            items.map((item, itemIndex) => {
              const showGroup = item.group !== lastGroup;
              lastGroup = item.group;
              return (
                <div key={item.key}>
                  {showGroup ? <div className="cmdk__group">{item.group}</div> : null}
                  <button
                    type="button"
                    role="option"
                    aria-selected={itemIndex === index}
                    className={`cmdk__item${itemIndex === index ? " is-active" : ""}`}
                    onMouseEnter={() => setIndex(itemIndex)}
                    onClick={() => {
                      item.run();
                      onClose();
                    }}
                  >
                    <span className="cmdk__icon" aria-hidden>{item.icon}</span>
                    <span className="cmdk__copy">
                      <span className="cmdk__title">{item.label}</span>
                      {item.description ? (
                        <span className="cmdk__description">{item.description}</span>
                      ) : null}
                    </span>
                    {item.hint ? <span className="cmdk__hint">{item.hint}</span> : null}
                  </button>
                </div>
              );
            })
          )}
        </div>
        <div className="cmdk__footer">
          <span><kbd>↑</kbd><kbd>↓</kbd> Navigate</span>
          <span><kbd>Enter</kbd> Select</span>
          {projectPickerOpen ? <span><kbd>Backspace</kbd> Back</span> : null}
          <span><kbd>Esc</kbd> Close</span>
        </div>
      </div>
    </div>
  );
}
