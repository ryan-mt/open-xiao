import { File, Search } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { searchProjectEntries, type ProjectSearchEntry } from "../auth";

type Props = {
  open: boolean;
  projectName: string | null;
  projectPath: string | null;
  onPick: (entry: ProjectSearchEntry) => void;
  onClose: () => void;
};

export function ProjectFilePicker({
  open,
  projectName,
  projectPath,
  onPick,
  onClose,
}: Props) {
  const [query, setQuery] = useState("");
  const [entries, setEntries] = useState<ProjectSearchEntry[] | null>([]);
  const [loading, setLoading] = useState(false);
  const [index, setIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const requestRef = useRef(0);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setEntries([]);
    setIndex(0);
    const timer = window.setTimeout(() => inputRef.current?.focus(), 20);
    return () => window.clearTimeout(timer);
  }, [open, projectPath]);

  useEffect(() => {
    const request = ++requestRef.current;
    if (!open || !projectPath) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setEntries((current) => current ?? []);
    const timer = window.setTimeout(() => {
      void searchProjectEntries(projectPath, query, 80)
        .then((next) => {
          if (request !== requestRef.current) return;
          setEntries(next.filter((entry) => !entry.isDir));
          setIndex(0);
        })
        .catch(() => {
          if (request !== requestRef.current) return;
          setEntries(null);
        })
        .finally(() => {
          if (request === requestRef.current) setLoading(false);
        });
    }, 90);
    return () => window.clearTimeout(timer);
  }, [open, projectPath, query]);

  const files = useMemo(() => entries?.slice(0, 60) ?? [], [entries]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onClose();
      } else if (event.key === "ArrowDown") {
        event.preventDefault();
        setIndex((current) => Math.min(files.length - 1, current + 1));
      } else if (event.key === "ArrowUp") {
        event.preventDefault();
        setIndex((current) => Math.max(0, current - 1));
      } else if (event.key === "Enter") {
        const entry = files[index];
        if (!entry) return;
        event.preventDefault();
        onPick(entry);
        onClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [files, index, onClose, onPick, open]);

  if (!open) return null;

  return (
    <div
      className="modal-backdrop cmdk-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="cmdk" role="dialog" aria-modal="true" aria-label="Project files">
        <label className="cmdk__search">
          <Search size={15} strokeWidth={1.7} aria-hidden />
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search files..."
            aria-label="Search project files"
          />
        </label>
        <div className="cmdk__list" role="listbox">
          {projectName ? <div className="cmdk__group">{projectName}</div> : null}
          {!projectPath ? (
            <div className="cmdk__empty">Open a project chat to search its files.</div>
          ) : entries === null ? (
            <div className="cmdk__empty">File search failed.</div>
          ) : loading && files.length === 0 ? (
            <div className="cmdk__empty">Searching files...</div>
          ) : files.length === 0 ? (
            <div className="cmdk__empty">No matching files.</div>
          ) : (
            files.map((entry, itemIndex) => (
              <button
                key={entry.path}
                type="button"
                role="option"
                aria-selected={itemIndex === index}
                className={`cmdk__item cmdk__item--file${itemIndex === index ? " is-active" : ""}`}
                onMouseEnter={() => setIndex(itemIndex)}
                onClick={() => {
                  onPick(entry);
                  onClose();
                }}
              >
                <File className="cmdk__icon" size={15} strokeWidth={1.55} aria-hidden />
                <span className="cmdk__copy">
                  <span className="cmdk__title">{entry.name}</span>
                  <span className="cmdk__description">{entry.path}</span>
                </span>
              </button>
            ))
          )}
        </div>
        <div className="cmdk__footer">
          <span><kbd>↑</kbd><kbd>↓</kbd> Navigate</span>
          <span><kbd>Enter</kbd> Add reference</span>
          <span><kbd>Esc</kbd> Close</span>
        </div>
      </div>
    </div>
  );
}

export default ProjectFilePicker;
