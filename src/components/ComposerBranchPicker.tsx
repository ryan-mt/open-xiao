import { memo, useEffect, useRef, useState } from "react";
import type { GitRef } from "../git";
import { filterGitRefs } from "../gitRefs";

type Props = {
  branch?: string | null;
  refs: readonly GitRef[];
  refsLoading?: boolean;
  selectedBaseRef?: string | null;
  canSelectBaseRef: boolean;
  gitLoading?: boolean;
  onRequestRefs: () => void;
  onSelectBaseRef: (name: string) => void;
  onRefreshBranch: () => void;
  onOpenChanges: () => void;
};

export const ComposerBranchPicker = memo(function ComposerBranchPicker({
  branch,
  refs,
  refsLoading = false,
  selectedBaseRef,
  canSelectBaseRef,
  gitLoading = false,
  onRequestRefs,
  onSelectBaseRef,
  onRefreshBranch,
  onOpenChanges,
}: Props) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const selectedRef = refs.find((gitRef) => gitRef.name === selectedBaseRef);
  const branchLabel = gitLoading
    ? "Checking..."
    : canSelectBaseRef && selectedRef && !selectedRef.current
      ? `Base: ${selectedRef.shortName}`
      : branch || selectedRef?.shortName || "No branch";
  const visibleRefs = filterGitRefs(refs, query);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setOpen(false);
      triggerRef.current?.focus();
    };
    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKeyDown, true);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown, true);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    inputRef.current?.focus();
  }, [open]);

  const close = () => {
    setOpen(false);
    setQuery("");
  };

  const toggle = () => {
    if (open) {
      close();
      return;
    }
    setOpen(true);
    onRequestRefs();
  };

  return (
    <div ref={rootRef} className="composer-context-strip__group composer-context-strip__group--branch">
      <button
        ref={triggerRef}
        type="button"
        className="composer-context-strip__trigger"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={toggle}
        title={branchLabel}
      >
        <GitBranchIcon />
        <span>{branchLabel}</span>
        <ChevronDownIcon />
      </button>
      {open ? (
        <div
          className="composer-context-strip__menu composer-context-strip__menu--branch"
          role="dialog"
          aria-label="Branch refs"
        >
          <div className="composer-context-strip__search">
            <SearchIcon />
            <input
              ref={inputRef}
              type="search"
              value={query}
              placeholder="Search refs..."
              aria-label="Search refs..."
              onChange={(event) => setQuery(event.target.value)}
            />
          </div>
          <div className="composer-context-strip__refs" role="listbox" aria-label="Refs">
            {visibleRefs.length > 0 ? (
              visibleRefs.map((gitRef) => {
                const selected = canSelectBaseRef
                  ? gitRef.name === selectedBaseRef
                  : gitRef.current;
                return (
                  <button
                    key={gitRef.name}
                    type="button"
                    role="option"
                    aria-selected={selected}
                    className={`composer-context-strip__ref${gitRef.current ? " is-current" : ""}${selected ? " is-selected" : ""}`}
                    onClick={() => {
                      if (canSelectBaseRef) onSelectBaseRef(gitRef.name);
                      close();
                    }}
                  >
                    <GitBranchIcon />
                    <span>{gitRef.shortName}</span>
                    {selected && canSelectBaseRef ? (
                      <small>base</small>
                    ) : gitRef.current ? (
                      <small>current</small>
                    ) : gitRef.kind === "remote" ? (
                      <small>remote</small>
                    ) : null}
                  </button>
                );
              })
            ) : refsLoading ? (
              <p className="composer-context-strip__empty">Loading refs...</p>
            ) : (
              <p className="composer-context-strip__empty">No refs found.</p>
            )}
          </div>
          <div className="composer-context-strip__menu-actions">
            <button
              type="button"
              className="composer-context-strip__item"
              onClick={() => {
                close();
                onRequestRefs();
                onRefreshBranch();
              }}
            >
              <RefreshIcon />
              <span>Refresh status</span>
            </button>
            <button
              type="button"
              className="composer-context-strip__item"
              onClick={() => {
                close();
                onOpenChanges();
              }}
            >
              <ChangesIcon />
              <span>Open changes</span>
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
});

function GitBranchIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden>
      <circle cx="6" cy="5" r="2" stroke="currentColor" strokeWidth="1.6" />
      <circle cx="18" cy="6" r="2" stroke="currentColor" strokeWidth="1.6" />
      <circle cx="6" cy="19" r="2" stroke="currentColor" strokeWidth="1.6" />
      <path d="M6 7v10M8 12h3a7 7 0 0 0 7-4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
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

function RefreshIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden>
      <path d="M20 11a8 8 0 1 0-2.3 5.7M20 5v6h-6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function ChangesIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden>
      <path d="M5 5h14M5 12h9M5 19h12" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

function SearchIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden>
      <circle cx="11" cy="11" r="6.5" stroke="currentColor" strokeWidth="1.6" />
      <path d="m16 16 4.5 4.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}
