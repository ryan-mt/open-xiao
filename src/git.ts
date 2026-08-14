import { invoke } from "@tauri-apps/api/core";
import {
  normalizeReviewPath,
  shortReviewPath,
  annotateReviewDiffLines,
  type ReviewDiffLine,
  type ReviewFileChange,
  type ReviewFileStatus,
} from "./reviewChanges";
import { isTauri } from "./lib/isTauri";

export type GitFileStat = {
  path: string;
  status: string;
  insertions: number;
  deletions: number;
};

export type GitStatus = {
  isRepo: boolean;
  root: string | null;
  branch: string | null;
  upstream: string | null;
  isDefaultBranch: boolean;
  hasPrimaryRemote: boolean;
  hasUpstream: boolean;
  aheadCount: number;
  behindCount: number;
  hasWorkingTreeChanges: boolean;
  workingTree: {
    files: GitFileStat[];
    insertions: number;
    deletions: number;
  };
  detached: boolean;
  error: string | null;
};

export type GitFileDiff = {
  path: string;
  status: string;
  insertions: number;
  deletions: number;
  patch: string;
};

export type GitDiffResult = {
  isRepo: boolean;
  root: string | null;
  branch: string | null;
  files: GitFileDiff[];
  insertions: number;
  deletions: number;
  truncated: boolean;
  error: string | null;
};

export type GitCommitResult = {
  committed: boolean;
  commitSha: string | null;
  subject: string | null;
  skippedNoChanges: boolean;
};

export type GitPushResult = {
  pushed: boolean;
  branch: string | null;
  upstream: string | null;
  setUpstream: boolean;
  detail: string;
};

export type GitWorktreeResult = {
  path: string;
  branch: string;
  warning: string | null;
};

export type GitRef = {
  name: string;
  shortName: string;
  kind: "local" | "remote";
  current: boolean;
};

export type GitPrResult = {
  url: string;
  created: boolean;
};

export { resolveWorkspacePath } from "./gitWorkspace";

const EMPTY_STATUS: GitStatus = {
  isRepo: false,
  root: null,
  branch: null,
  upstream: null,
  isDefaultBranch: false,
  hasPrimaryRemote: false,
  hasUpstream: false,
  aheadCount: 0,
  behindCount: 0,
  hasWorkingTreeChanges: false,
  workingTree: { files: [], insertions: 0, deletions: 0 },
  detached: false,
  error: null,
};

export async function fetchGitStatus(path: string): Promise<GitStatus> {
  if (!isTauri() || !path.trim()) return EMPTY_STATUS;
  return invoke<GitStatus>("git_status", { path });
}

export async function fetchGitDiff(path: string): Promise<GitDiffResult> {
  if (!isTauri() || !path.trim()) {
    return {
      isRepo: false,
      root: null,
      branch: null,
      files: [],
      insertions: 0,
      deletions: 0,
      truncated: false,
      error: null,
    };
  }
  return invoke<GitDiffResult>("git_diff", { path });
}

export async function gitCommit(
  path: string,
  message: string,
  paths?: string[],
): Promise<GitCommitResult> {
  if (!isTauri()) throw new Error("Git commit requires the desktop app");
  return invoke<GitCommitResult>("git_commit", {
    path,
    message,
    paths: paths ?? null,
  });
}

export async function gitPush(
  path: string,
  setUpstream = false,
): Promise<GitPushResult> {
  if (!isTauri()) throw new Error("Git push requires the desktop app");
  return invoke<GitPushResult>("git_push", {
    path,
    setUpstream,
  });
}

export async function fetchGitRefs(path: string): Promise<GitRef[]> {
  if (!isTauri() || !path.trim()) return [];
  return invoke<GitRef[]>("git_list_refs", { path });
}

export async function gitWorktreeCreate(
  path: string,
  threadId: string,
  baseRef: string,
): Promise<GitWorktreeResult> {
  if (!isTauri()) throw new Error("Git worktree requires the desktop app");
  return invoke<GitWorktreeResult>("git_worktree_create", {
    path,
    threadId,
    baseRef,
  });
}

export async function gitWorktreeRemove(
  path: string,
  worktreePath: string,
): Promise<GitWorktreeResult> {
  if (!isTauri()) throw new Error("Git worktree requires the desktop app");
  return invoke<GitWorktreeResult>("git_worktree_remove", {
    path,
    worktreePath,
  });
}

export async function gitOpenPr(path: string): Promise<GitPrResult> {
  if (!isTauri()) throw new Error("Open PR requires the desktop app");
  return invoke<GitPrResult>("git_pr_open", { path });
}

function isDiffMetaLine(line: string): boolean {
  const t = line.trim();
  return (
    t === "…" ||
    t === "..." ||
    t.startsWith("@@") ||
    t.startsWith("---") ||
    t.startsWith("+++") ||
    t.startsWith("diff --git ") ||
    t.startsWith("index ") ||
    t.startsWith("new file mode") ||
    t.startsWith("deleted file mode") ||
    t.startsWith("old mode") ||
    t.startsWith("new mode") ||
    t.startsWith("similarity index") ||
    t.startsWith("rename from") ||
    t.startsWith("rename to") ||
    t.startsWith("Binary files ") ||
    t.startsWith("\\ ")
  );
}

function parsePatchLines(patch: string): ReviewDiffLine[] {
  if (!patch.trim()) return [];
  const out: ReviewDiffLine[] = [];
  // Outside a hunk, `---`/`+++` are file headers (meta). Inside a hunk they are
  // deleted/added lines whose content itself starts with `-`/`+` (e.g. a removed
  // SQL `-- comment` arrives as `--- comment`), so position decides the kind.
  let inHunk = false;
  for (const raw of patch.replace(/\r\n/g, "\n").split("\n")) {
    const t = raw.trim();
    if (t.startsWith("@@")) {
      inHunk = true;
      out.push({ kind: "meta", code: raw.replace(/^[+\- ]/, "") });
      continue;
    }
    if (t.startsWith("\\ ")) {
      out.push({ kind: "meta", code: raw.replace(/^[+\- ]/, "") });
      continue;
    }
    if (!inHunk && isDiffMetaLine(raw)) {
      out.push({ kind: "meta", code: raw.replace(/^[+\- ]/, "") });
      continue;
    }
    if (raw.startsWith("+")) {
      out.push({ kind: "add", code: raw.slice(1) });
      continue;
    }
    if (raw.startsWith("-")) {
      out.push({ kind: "del", code: raw.slice(1) });
      continue;
    }
    if (raw.startsWith(" ")) {
      out.push({ kind: "ctx", code: raw.slice(1) });
      continue;
    }
    if (raw.trim()) out.push({ kind: "ctx", code: raw });
  }
  return annotateReviewDiffLines(out);
}

function toReviewStatus(status: string): ReviewFileStatus {
  const s = status.toLowerCase();
  if (s === "added" || s === "untracked") return "added";
  if (s === "deleted") return "deleted";
  return "modified";
}

/** Convert backend git diff into the shared Review panel model. */
export function gitDiffToReviewFiles(diff: GitDiffResult | null): ReviewFileChange[] {
  if (!diff?.isRepo || !diff.files?.length) return [];
  return diff.files
    .map((f, i) => {
      const path = normalizeReviewPath(f.path);
      const lines = parsePatchLines(f.patch);
      return {
        path,
        displayPath: shortReviewPath(path),
        status: toReviewStatus(f.status),
        additions: f.insertions,
        deletions: f.deletions,
        header: path,
        lines,
        toolName: "git",
        toolId: `git:${path}:${i}`,
        messageId: "git-working-tree",
      } satisfies ReviewFileChange;
    })
    .sort((a, b) =>
      a.path.localeCompare(b.path, undefined, {
        numeric: true,
        sensitivity: "base",
      }),
    );
}

export function summarizeGitStatus(status: GitStatus | null): {
  fileCount: number;
  additions: number;
  deletions: number;
} | null {
  if (!status?.isRepo || !status.hasWorkingTreeChanges) return null;
  return {
    fileCount: status.workingTree.files.length,
    additions: status.workingTree.insertions,
    deletions: status.workingTree.deletions,
  };
}

export function formatGitBranchLabel(status: GitStatus | null): string | null {
  if (!status?.isRepo) return null;
  if (status.detached) return "detached";
  return status.branch;
}

export function formatAheadBehind(status: GitStatus | null): string | null {
  if (!status?.isRepo) return null;
  const parts: string[] = [];
  if (status.aheadCount > 0) parts.push(`↑${status.aheadCount}`);
  if (status.behindCount > 0) parts.push(`↓${status.behindCount}`);
  return parts.length ? parts.join(" ") : null;
}

/** Suggest a short commit subject from changed paths. */
export function suggestCommitMessage(status: GitStatus | null): string {
  if (!status?.isRepo || !status.hasWorkingTreeChanges) return "";
  const files = status.workingTree.files;
  if (files.length === 0) return "";
  const names = files.slice(0, 3).map((f) => {
    const parts = f.path.replace(/\\/g, "/").split("/");
    return parts[parts.length - 1] || f.path;
  });
  const more = files.length > 3 ? ` (+${files.length - 3})` : "";
  const verb =
    files.every((f) => f.status === "added")
      ? "Add"
      : files.every((f) => f.status === "deleted")
        ? "Remove"
        : "Update";
  return `${verb} ${names.join(", ")}${more}`;
}
