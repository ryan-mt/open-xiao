import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { createPortal } from "react-dom";
import { FileCode2, Files, X } from "lucide-react";
import { usePresence } from "../usePresence";

export type RightPanelPage = "review" | "browser" | "files";

type ToggleProps = {
  open: boolean;
  onToggle: () => void;
  /** Compact badge when closed (e.g. 3 changed files). */
  badge?: string | null;
  className?: string;
  title?: string;
};

/** Compact right-panel toggle (PanelRight icon). */
export function RightPanelToggle({
  open,
  onToggle,
  badge = null,
  className = "",
  title,
}: ToggleProps) {
  const label = open ? "Hide right panel" : "Show right panel";
  return (
    <button
      type="button"
      className={`right-panel-toggle${open ? " is-open" : ""}${badge ? " has-badge" : ""}${className ? ` ${className}` : ""}`}
      aria-pressed={open}
      aria-label={badge ? `${label}, ${badge}` : label}
      title={title ?? label}
      onClick={onToggle}
    >
      <PanelRightIcon />
      {badge ? (
        <span className="right-panel-toggle__badge" aria-hidden>
          {badge}
        </span>
      ) : null}
    </button>
  );
}

/** Bottom terminal panel toggle (PanelBottom icon). */
export function TerminalToggle({
  open,
  onToggle,
  className = "",
  title,
}: Omit<ToggleProps, "badge">) {
  const label = open ? "Hide terminal" : "Show terminal";
  return (
    <button
      type="button"
      className={`right-panel-toggle${open ? " is-open" : ""}${className ? ` ${className}` : ""}`}
      aria-pressed={open}
      aria-label={label}
      title={title ?? `${label} (Ctrl+\`)`}
      onClick={onToggle}
    >
      <PanelBottomIcon />
    </button>
  );
}

type PageSwitcherProps = {
  page: RightPanelPage;
  onPageChange: (page: RightPanelPage) => void;
  reviewStats?: {
    fileCount: number;
    additions: number;
    deletions: number;
  } | null;
  previewUrl?: string | null;
  filesAvailable?: boolean;
  filesMeta?: string | null;
  fileTabs?: readonly string[];
  activeFilePath?: string | null;
  onActivateFiles?: () => void;
  onActivateFile?: (path: string) => void;
  onCloseFile?: (path: string) => void;
  onClosePage?: () => void;
  onMenuOpenChange?: (open: boolean) => void;
  beforeMenuOpen?: () => void | Promise<void>;
};

type MenuPos = { top: number; left: number };

/**
 * Inside the open right panel: current surface tab + page menu.
 * Menu is portaled to body so panel body content never paints through it.
 */
export function RightPanelPageSwitcher({
  page,
  onPageChange,
  reviewStats = null,
  previewUrl = null,
  filesAvailable = true,
  filesMeta = null,
  fileTabs = [],
  activeFilePath = null,
  onActivateFiles,
  onActivateFile,
  onCloseFile,
  onClosePage,
  onMenuOpenChange,
  beforeMenuOpen,
}: PageSwitcherProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const currentBtnRef = useRef<HTMLButtonElement>(null);
  const addBtnRef = useRef<HTMLButtonElement>(null);
  const [menuPos, setMenuPos] = useState<MenuPos | null>(null);
  const menuPresence = usePresence(menuOpen, 140);

  useEffect(() => {
    onMenuOpenChange?.(menuOpen);
    return () => onMenuOpenChange?.(false);
  }, [menuOpen, onMenuOpenChange]);

  const reviewMeta =
    reviewStats && reviewStats.fileCount > 0
      ? `${reviewStats.fileCount} file${reviewStats.fileCount === 1 ? "" : "s"}`
      : "No changes";
  const previewMeta = (() => {
    if (!previewUrl) return "Local preview";
    try {
      return new URL(previewUrl).host;
    } catch {
      return "Local preview";
    }
  })();
  const pageLabel =
    page === "review" ? "Review" : page === "browser" ? "Browser" : "Files";
  const pageMeta =
    page === "review"
      ? reviewMeta
      : page === "browser"
        ? previewMeta
        : (filesMeta ?? "Workspace files");

  const toggleMenu = async () => {
    if (menuOpen) {
      setMenuOpen(false);
      return;
    }
    try {
      await beforeMenuOpen?.();
    } catch {
      return;
    }
    setMenuOpen(true);
  };

  const placeMenu = () => {
    if (!menuOpen) {
      setMenuPos(null);
      return;
    }
    const anchor = addBtnRef.current ?? currentBtnRef.current;
    const menu = menuRef.current;
    if (!anchor) return;

    const rect = anchor.getBoundingClientRect();
    const gap = 6;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const menuW = menu?.offsetWidth ?? 200;
    const menuH = menu?.offsetHeight ?? 96;

    let top = rect.bottom + gap;
    if (top + menuH > vh - 8) {
      top = Math.max(8, rect.top - menuH - gap);
    }

    // Prefer left-align under the page pill group; keep fully on-screen.
    const groupLeft = rootRef.current?.getBoundingClientRect().left ?? rect.left;
    let left = groupLeft;
    left = Math.min(Math.max(8, left), vw - menuW - 8);

    setMenuPos({ top, left });
  };

  useLayoutEffect(() => {
    if (!menuPresence.present) {
      setMenuPos(null);
      return;
    }
    placeMenu();
    const id = requestAnimationFrame(() => placeMenu());
    return () => cancelAnimationFrame(id);
  }, [
    menuPresence.present,
    menuPresence.visible,
    page,
    reviewMeta,
    previewMeta,
    filesMeta,
  ]);

  useEffect(() => {
    if (!menuOpen) return;
    const onDoc = (e: MouseEvent) => {
      const t = e.target as Node;
      if (rootRef.current?.contains(t)) return;
      if (menuRef.current?.contains(t)) return;
      setMenuOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      setMenuOpen(false);
    };
    const onReposition = () => placeMenu();
    document.addEventListener("mousedown", onDoc);
    // Capture so Escape closes the menu before App's window handler runs.
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("resize", onReposition);
    window.addEventListener("scroll", onReposition, true);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("resize", onReposition);
      window.removeEventListener("scroll", onReposition, true);
    };
  }, [menuOpen]);

  const menuStyle: CSSProperties = menuPos
    ? {
        top: menuPos.top,
        left: menuPos.left,
        visibility: "visible",
      }
    : {
        top: 0,
        left: 0,
        visibility: "hidden",
      };

  const menu =
    menuPresence.present && typeof document !== "undefined"
      ? createPortal(
          <div
            ref={menuRef}
            className={`right-panel-pages__menu right-panel-menu right-panel-pages__menu--portal${menuPresence.visible ? " is-open" : ""}`}
            role="menu"
            aria-hidden={!menuPresence.visible}
            style={menuStyle}
          >
            <button
              type="button"
              role="menuitem"
              className={page === "browser" ? "is-active" : undefined}
              onClick={(event) => {
                event.currentTarget.blur();
                onPageChange("browser");
                setMenuOpen(false);
              }}
            >
              <BrowserIcon />
              <span className="right-panel-pages__menu-text">
                <strong>Browser</strong>
                <small>{previewMeta}</small>
              </span>
            </button>
            <button
              type="button"
              role="menuitem"
              className={page === "files" ? "is-active" : undefined}
              disabled={!filesAvailable}
              onClick={(event) => {
                if (!filesAvailable) return;
                event.currentTarget.blur();
                onPageChange("files");
                setMenuOpen(false);
              }}
            >
              <Files aria-hidden />
              <span className="right-panel-pages__menu-text">
                <strong>Files</strong>
                <small>
                  {filesAvailable
                    ? (filesMeta ?? "Workspace files")
                    : "Open a project first"}
                </small>
              </span>
            </button>
            <button
              type="button"
              role="menuitem"
              className={page === "review" ? "is-active" : undefined}
              onClick={(event) => {
                event.currentTarget.blur();
                onPageChange("review");
                setMenuOpen(false);
              }}
            >
              <ReviewIcon />
              <span className="right-panel-pages__menu-text">
                <strong>Review</strong>
                <small>{reviewMeta}</small>
              </span>
            </button>
          </div>,
          document.body,
        )
      : null;

  return (
    <div
      className={`right-panel-pages${page === "files" ? " is-file-tabs" : ""}`}
      ref={rootRef}
    >
      {page === "files" ? (
        <div
          className="right-panel-pages__file-tabs"
          role="tablist"
          aria-label="Open files"
        >
          <div
            className={`right-panel-pages__file-tab${activeFilePath === null ? " is-active" : ""}`}
          >
            <button
              type="button"
              role="tab"
              aria-selected={activeFilePath === null}
              onClick={onActivateFiles}
            >
              <Files aria-hidden />
              <span>Files</span>
            </button>
            {onClosePage ? (
              <button
                type="button"
                aria-label="Close Files"
                onClick={onClosePage}
              >
                <X aria-hidden />
              </button>
            ) : null}
          </div>
          {fileTabs.map((path) => {
            const label = path.slice(path.lastIndexOf("/") + 1);
            return (
              <div
                key={path}
                className={`right-panel-pages__file-tab${activeFilePath === path ? " is-active" : ""}`}
                title={path}
              >
                <button
                  type="button"
                  role="tab"
                  aria-selected={activeFilePath === path}
                  className="right-panel-pages__file-tab-main"
                  onClick={() => onActivateFile?.(path)}
                >
                  <FileCode2 aria-hidden />
                  <span>{label}</span>
                </button>
                <button
                  type="button"
                  className="right-panel-pages__file-tab-close"
                  aria-label={`Close ${label}`}
                  onClick={() => onCloseFile?.(path)}
                >
                  <X aria-hidden />
                </button>
              </div>
            );
          })}
        </div>
      ) : (
        <div
          className={`right-panel-pages__tab${onClosePage ? " has-close" : ""}`}
        >
          {onClosePage ? (
            <button
              type="button"
              className="right-panel-pages__close"
              aria-label={`Close ${pageLabel.toLowerCase()} tab`}
              title={`Close ${pageLabel}`}
              onClick={onClosePage}
            >
              <span className="right-panel-pages__surface-icon">
                {page === "review" ? <ReviewIcon /> : <BrowserIcon />}
              </span>
              <span className="right-panel-pages__close-icon">
                <CloseIcon />
              </span>
            </button>
          ) : null}
          <button
            ref={currentBtnRef}
            type="button"
            className="right-panel-pages__current"
            aria-label={`${pageLabel}, ${pageMeta}`}
            title={pageLabel}
            onClick={() => void toggleMenu()}
          >
            {!onClosePage ? (
              page === "review" ? (
                <ReviewIcon />
              ) : (
                <BrowserIcon />
              )
            ) : null}
            <span className="right-panel-pages__label">{pageLabel}</span>
          </button>
        </div>
      )}

      <button
        ref={addBtnRef}
        type="button"
        className={`right-panel-pages__add${menuOpen ? " is-open" : ""}`}
        aria-label="Open page menu"
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        title="Pages"
        onClick={() => void toggleMenu()}
      >
        <PlusIcon />
      </button>

      {menu}
    </div>
  );
}

function PanelRightIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden>
      <rect
        x="3.5"
        y="4.5"
        width="17"
        height="15"
        rx="2.2"
        stroke="currentColor"
        strokeWidth="1.7"
      />
      <path d="M14.5 4.5v15" stroke="currentColor" strokeWidth="1.7" />
    </svg>
  );
}

/** Same frame as PanelRight, divider runs horizontal (bottom strip). */
function PanelBottomIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden>
      <rect
        x="3.5"
        y="4.5"
        width="17"
        height="15"
        rx="2.2"
        stroke="currentColor"
        strokeWidth="1.7"
      />
      <path d="M3.5 14.5h17" stroke="currentColor" strokeWidth="1.7" />
    </svg>
  );
}

function PlusIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M12 5v14M5 12h14"
        stroke="currentColor"
        strokeWidth="1.9"
        strokeLinecap="round"
      />
    </svg>
  );
}

function ReviewIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinejoin="round"
      />
      <path
        d="M14 2v6h6"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M9 13h6M9 17h4"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
      />
    </svg>
  );
}

function BrowserIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden>
      <rect x="3.5" y="4" width="17" height="16" rx="2" stroke="currentColor" strokeWidth="1.7" />
      <path d="M3.5 8.5h17" stroke="currentColor" strokeWidth="1.7" />
      <circle cx="6.5" cy="6.25" r=".75" fill="currentColor" />
      <circle cx="9" cy="6.25" r=".75" fill="currentColor" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M7 7l10 10M17 7 7 17"
        stroke="currentColor"
        strokeWidth="1.9"
        strokeLinecap="round"
      />
    </svg>
  );
}
