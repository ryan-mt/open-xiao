import { useEffect, useRef, useState } from "react";
import type { Project } from "../types";

type Props = {
  projects: Project[];
  projectId: string | null;
  projectName?: string | null;
  onSelectProject: (id: string | null) => void;
  onAddProject?: () => void;
};

/**
 * Empty-thread hero - headline + project picker only.
 * Composer sits below (parent layout).
 */
export function Welcome({
  projects,
  projectId,
  projectName,
  onSelectProject,
  onAddProject,
}: Props) {
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (menuRef.current?.contains(e.target as Node)) return;
      setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  // Prefer the selected id over a separately-passed name so the title never
  // lags when the picker changes project while an empty thread still has an
  // older projectId elsewhere in the app.
  const selectedName =
    (projectId
      ? projects.find((p) => p.id === projectId)?.name
      : null) ??
    projectName ??
    null;
  const hasProject = Boolean(selectedName);
  const canChoose = projects.length > 0;

  const selector = canChoose ? (
    <span className="draft-hero__picker" ref={menuRef}>
      <button
        type="button"
        className={`draft-hero__project${hasProject ? " is-set" : ""}`}
        aria-label={hasProject ? "Change project" : "Choose a project"}
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        {selectedName ?? "Choose a project"}
      </button>
      {open ? (
        <div className="draft-hero__menu" role="listbox">
          {projects.map((p) => (
            <button
              key={p.id}
              type="button"
              role="option"
              aria-selected={p.id === projectId}
              className={`draft-hero__option${p.id === projectId ? " is-active" : ""}`}
              onClick={() => {
                onSelectProject(p.id);
                setOpen(false);
              }}
            >
              {p.name}
            </button>
          ))}
          {onAddProject ? (
            <>
              <div className="draft-hero__sep" role="separator" />
              <button
                type="button"
                className="draft-hero__option draft-hero__option--add"
                onClick={() => {
                  setOpen(false);
                  onAddProject();
                }}
              >
                <FolderPlusIcon />
                New project
              </button>
            </>
          ) : null}
        </div>
      ) : null}
    </span>
  ) : null;

  return (
    <div className={`draft-hero${canChoose ? "" : " draft-hero--no-projects"}`}>
      <h1 className="draft-hero__title">
        {hasProject ? (
          <>What should we build in {selector}?</>
        ) : canChoose ? (
          <>{selector} to start</>
        ) : (
          <>What should we work on?</>
        )}
      </h1>
      {!canChoose ? (
        <>
          <p className="draft-hero__description">
            Add a project to start your first thread.
          </p>
          <button
            type="button"
            className="draft-hero__add"
            onClick={onAddProject}
          >
            <FolderPlusIcon />
            Add project
          </button>
        </>
      ) : null}
    </div>
  );
}

function FolderPlusIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden>
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
    </svg>
  );
}
