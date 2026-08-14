import { memo, useEffect, useRef, useState } from "react";
import type { GitRef } from "../git";
import { ComposerBranchPicker } from "./ComposerBranchPicker";

type OpenMenu = "workspace" | null;

type Props = {
  worktreePath?: string | null;
  branch?: string | null;
  refs: readonly GitRef[];
  refsLoading?: boolean;
  selectedBaseRef?: string | null;
  gitLoading?: boolean;
  worktreeBusy?: boolean;
  canCreateWorktree: boolean;
  onCreateWorktree: () => void;
  onRequestRefs: () => void;
  onSelectBaseRef: (name: string) => void;
  onRefreshBranch: () => void;
  onOpenChanges: () => void;
};

export const ComposerContextStrip = memo(function ComposerContextStrip({
  worktreePath,
  branch,
  refs,
  refsLoading = false,
  selectedBaseRef,
  gitLoading = false,
  worktreeBusy = false,
  canCreateWorktree,
  onCreateWorktree,
  onRequestRefs,
  onSelectBaseRef,
  onRefreshBranch,
  onOpenChanges,
}: Props) {
  const [openMenu, setOpenMenu] = useState<OpenMenu>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const workspaceLabel = worktreePath ? "Worktree" : "Local checkout";

  useEffect(() => {
    if (!openMenu) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpenMenu(null);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpenMenu(null);
    };
    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKeyDown, true);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown, true);
    };
  }, [openMenu]);

  return (
    <div ref={rootRef} className="composer-context-strip">
      <div className="composer-context-strip__group">
        <button
          type="button"
          className="composer-context-strip__trigger"
          aria-haspopup="menu"
          aria-expanded={openMenu === "workspace"}
          onClick={() => setOpenMenu((current) => (current === "workspace" ? null : "workspace"))}
        >
          <FolderIcon worktree={Boolean(worktreePath)} />
          <span>{workspaceLabel}</span>
          <ChevronDownIcon />
        </button>
        {openMenu === "workspace" ? (
          <div className="composer-context-strip__menu" role="menu" aria-label="Workspace">
            <button
              type="button"
              className="composer-context-strip__item is-selected"
              role="menuitem"
              onClick={() => setOpenMenu(null)}
            >
              <FolderIcon worktree={Boolean(worktreePath)} />
              <span>{workspaceLabel}</span>
              <CheckIcon />
            </button>
            {!worktreePath ? (
              <button
                type="button"
                className="composer-context-strip__item"
                role="menuitem"
                disabled={!canCreateWorktree || worktreeBusy}
                onClick={() => {
                  setOpenMenu(null);
                  onCreateWorktree();
                }}
              >
                <FolderIcon worktree />
                <span>{worktreeBusy ? "Creating worktree..." : "New worktree"}</span>
              </button>
            ) : null}
          </div>
        ) : null}
      </div>

      <ComposerBranchPicker
        branch={branch}
        refs={refs}
        refsLoading={refsLoading}
        selectedBaseRef={selectedBaseRef}
        canSelectBaseRef={!worktreePath}
        gitLoading={gitLoading}
        onRequestRefs={onRequestRefs}
        onSelectBaseRef={onSelectBaseRef}
        onRefreshBranch={onRefreshBranch}
        onOpenChanges={onOpenChanges}
      />
    </div>
  );
});

function FolderIcon({ worktree = false }: { worktree?: boolean }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden>
      <path d="M3 6.5h6l2 2h10v9.5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6.5Z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
      {worktree ? <path d="M8 13h8M12 10v6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /> : null}
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg className="composer-context-strip__check" viewBox="0 0 16 16" fill="none" aria-hidden>
      <path d="m3.5 8 3 3 6-6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function ChevronDownIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden>
      <path d="m5 6.5 3 3 3-3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
