import { memo, useMemo, useState } from "react";
import {
  ChevronRight,
  ChevronsDownUp,
  ChevronsUpDown,
  FileCode2,
  FileDiff,
  Folder,
  FolderClosed,
} from "lucide-react";
import type { ReviewFileChange } from "../reviewChanges";
import {
  buildChangedFilesTree,
  changedFileName,
  selectChangedFilePreview,
  shouldAutoExpandChangedFiles,
  summarizeChangedFileScopes,
  summarizeChangedFiles,
  type ChangedFileTreeNode,
} from "../changedFiles";

type Props = {
  files: readonly ReviewFileChange[];
  latestTurn: boolean;
  onOpenDiff?: () => void;
};

export const ChangedFilesCard = memo(function ChangedFilesCard({
  files,
  latestTurn,
  onOpenDiff,
}: Props) {
  const autoExpanded = useMemo(
    () => shouldAutoExpandChangedFiles(files, latestTurn),
    [files, latestTurn],
  );
  const [expanded, setExpanded] = useState(autoExpanded);
  const [allDirectoriesExpanded, setAllDirectoriesExpanded] =
    useState(autoExpanded);
  const summary = useMemo(() => summarizeChangedFiles(files), [files]);
  const scopes = useMemo(() => summarizeChangedFileScopes(files), [files]);
  const preview = useMemo(() => selectChangedFilePreview(files), [files]);
  const showPreview = latestTurn && !expanded;

  return (
    <section
      className="changed-files"
      data-state={expanded ? "expanded" : showPreview ? "preview" : "collapsed"}
      aria-label={`${files.length} changed ${files.length === 1 ? "file" : "files"}`}
    >
      <header className="changed-files__head">
        <button
          type="button"
          className="changed-files__summary"
          aria-expanded={expanded}
          onClick={() => setExpanded((value) => !value)}
        >
          <ChevronRight
            size={14}
            strokeWidth={1.8}
            className={expanded ? "is-open" : undefined}
            aria-hidden
          />
          <strong>
            {files.length} changed {files.length === 1 ? "file" : "files"}
          </strong>
          <DiffStat additions={summary.additions} deletions={summary.deletions} />
          <span>{expanded ? "Hide files" : "Show files"}</span>
        </button>
        <div className="changed-files__actions">
          {expanded ? (
            <button
              type="button"
              className="changed-files__icon-btn"
              aria-label={
                allDirectoriesExpanded
                  ? "Collapse all folders"
                  : "Expand all folders"
              }
              title={
                allDirectoriesExpanded
                  ? "Collapse all folders"
                  : "Expand all folders"
              }
              onClick={() => setAllDirectoriesExpanded((value) => !value)}
            >
              {allDirectoriesExpanded ? (
                <ChevronsDownUp size={13} aria-hidden />
              ) : (
                <ChevronsUpDown size={13} aria-hidden />
              )}
            </button>
          ) : null}
          <button
            type="button"
            className="changed-files__open"
            aria-label="Open diff"
            onClick={onOpenDiff}
            disabled={!onOpenDiff}
          >
            <FileDiff size={13} aria-hidden />
            <span>Open diff</span>
          </button>
        </div>
      </header>

      {expanded ? (
        <ChangedFilesTree
          files={files}
          allDirectoriesExpanded={allDirectoriesExpanded}
          onOpenDiff={onOpenDiff}
        />
      ) : showPreview ? (
        <div className="changed-files__preview">
          <p>
            {scopes.map((scope, index) => (
              <span key={scope.label}>
                {index > 0 ? <i aria-hidden>·</i> : null}
                <code>{scope.label}</code> {scope.fileCount}{" "}
                {scope.fileCount === 1 ? "file" : "files"}
              </span>
            ))}
          </p>
          <div className="changed-files__chips">
            {preview.map((file) => (
              <button
                key={file.path}
                type="button"
                title={file.path}
                onClick={onOpenDiff}
                disabled={!onOpenDiff}
              >
                <FileCode2 size={12} aria-hidden />
                <span>{changedFileName(file.path)}</span>
              </button>
            ))}
            <button
              type="button"
              className="changed-files__show-all"
              onClick={() => setExpanded(true)}
            >
              Show all {files.length} files
            </button>
          </div>
        </div>
      ) : null}
    </section>
  );
});

function ChangedFilesTree({
  files,
  allDirectoriesExpanded,
  onOpenDiff,
}: {
  files: readonly ReviewFileChange[];
  allDirectoriesExpanded: boolean;
  onOpenDiff?: () => void;
}) {
  const nodes = useMemo(() => buildChangedFilesTree(files), [files]);
  const key = `${allDirectoriesExpanded}:${nodes
    .filter((node) => node.kind === "directory")
    .map((node) => node.path)
    .join("\0")}`;
  const [overrides, setOverrides] = useState<{
    key: string;
    values: Record<string, boolean>;
  }>({ key, values: {} });
  const values = overrides.key === key ? overrides.values : {};

  const renderNode = (node: ChangedFileTreeNode, depth: number) => {
    if (node.kind === "directory") {
      const open = values[node.path] ?? allDirectoriesExpanded;
      return (
        <div key={node.path}>
          <button
            type="button"
            className="changed-files__node"
            style={{ paddingLeft: `${8 + depth * 14}px` }}
            aria-expanded={open}
            onClick={() =>
              setOverrides((current) => ({
                key,
                values: {
                  ...(current.key === key ? current.values : {}),
                  [node.path]: !open,
                },
              }))
            }
          >
            <ChevronRight
              size={14}
              strokeWidth={1.8}
              className={open ? "is-open" : undefined}
              aria-hidden
            />
            {open ? (
              <Folder size={14} aria-hidden />
            ) : (
              <FolderClosed size={14} aria-hidden />
            )}
            <code>{node.name}</code>
            <DiffStat
              additions={node.stat.additions}
              deletions={node.stat.deletions}
            />
          </button>
          {open
            ? node.children.map((child) => renderNode(child, depth + 1))
            : null}
        </div>
      );
    }
    return (
      <button
        key={node.path}
        type="button"
        className="changed-files__node is-file"
        style={{ paddingLeft: `${22 + depth * 14}px` }}
        title={node.path}
        onClick={onOpenDiff}
        disabled={!onOpenDiff}
      >
        <FileCode2 size={14} aria-hidden />
        <code>{node.name}</code>
        <DiffStat
          additions={node.stat.additions}
          deletions={node.stat.deletions}
        />
      </button>
    );
  };

  return <div className="changed-files__tree">{nodes.map((node) => renderNode(node, 0))}</div>;
}

function DiffStat({
  additions,
  deletions,
}: {
  additions: number;
  deletions: number;
}) {
  return (
    <span className="changed-files__stat" aria-label={`${additions} additions, ${deletions} deletions`}>
      <b>+{additions}</b>
      <i>-{deletions}</i>
    </span>
  );
}
