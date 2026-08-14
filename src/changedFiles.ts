import type { ReviewFileChange } from "./reviewChanges.ts";

export type ChangedFileStat = {
  additions: number;
  deletions: number;
};

export type ChangedFileTreeNode =
  | {
      kind: "directory";
      name: string;
      path: string;
      stat: ChangedFileStat;
      children: ChangedFileTreeNode[];
    }
  | {
      kind: "file";
      name: string;
      path: string;
      stat: ChangedFileStat;
    };

type MutableDirectory = {
  name: string;
  path: string;
  stat: ChangedFileStat;
  directories: Map<string, MutableDirectory>;
  files: Extract<ChangedFileTreeNode, { kind: "file" }>[];
};

export const CHANGED_FILES_AUTO_EXPAND_FILE_LIMIT = 5;
export const CHANGED_FILES_AUTO_EXPAND_LINE_LIMIT = 200;
export const CHANGED_FILES_PREVIEW_FILE_LIMIT = 3;

function pathSegments(path: string): string[] {
  return path
    .replace(/\\/g, "/")
    .split("/")
    .filter(Boolean);
}

function compareName(a: { name: string }, b: { name: string }): number {
  return a.name.localeCompare(b.name, undefined, {
    numeric: true,
    sensitivity: "base",
  });
}

function compactDirectory(
  node: Extract<ChangedFileTreeNode, { kind: "directory" }>,
): Extract<ChangedFileTreeNode, { kind: "directory" }> {
  let current = {
    ...node,
    children: node.children.map((child) =>
      child.kind === "directory" ? compactDirectory(child) : child,
    ),
  };
  while (current.children.length === 1 && current.children[0]?.kind === "directory") {
    const child = current.children[0];
    current = {
      kind: "directory",
      name: `${current.name}/${child.name}`,
      path: child.path,
      stat: child.stat,
      children: child.children,
    };
  }
  return current;
}

function toTree(directory: MutableDirectory): ChangedFileTreeNode[] {
  const directories = Array.from(directory.directories.values())
    .sort(compareName)
    .map((child) =>
      compactDirectory({
        kind: "directory",
        name: child.name,
        path: child.path,
        stat: child.stat,
        children: toTree(child),
      }),
    );
  return [...directories, ...directory.files.sort(compareName)];
}

export function summarizeChangedFiles(
  files: readonly ReviewFileChange[],
): ChangedFileStat {
  return files.reduce(
    (total, file) => ({
      additions: total.additions + file.additions,
      deletions: total.deletions + file.deletions,
    }),
    { additions: 0, deletions: 0 },
  );
}

export function buildChangedFilesTree(
  files: readonly ReviewFileChange[],
): ChangedFileTreeNode[] {
  const root: MutableDirectory = {
    name: "",
    path: "",
    stat: { additions: 0, deletions: 0 },
    directories: new Map(),
    files: [],
  };

  for (const file of files) {
    const segments = pathSegments(file.path);
    const name = segments[segments.length - 1];
    if (!name) continue;
    const stat = { additions: file.additions, deletions: file.deletions };
    const ancestors = [root];
    let current = root;
    for (const segment of segments.slice(0, -1)) {
      let next = current.directories.get(segment);
      if (!next) {
        next = {
          name: segment,
          path: current.path ? `${current.path}/${segment}` : segment,
          stat: { additions: 0, deletions: 0 },
          directories: new Map(),
          files: [],
        };
        current.directories.set(segment, next);
      }
      current = next;
      ancestors.push(current);
    }
    current.files.push({
      kind: "file",
      name,
      path: segments.join("/"),
      stat,
    });
    for (const ancestor of ancestors) {
      ancestor.stat.additions += stat.additions;
      ancestor.stat.deletions += stat.deletions;
    }
  }
  return toTree(root);
}

export function shouldAutoExpandChangedFiles(
  files: readonly ReviewFileChange[],
  latestTurn: boolean,
): boolean {
  if (!latestTurn || files.length > CHANGED_FILES_AUTO_EXPAND_FILE_LIMIT) {
    return false;
  }
  const stat = summarizeChangedFiles(files);
  return stat.additions + stat.deletions <= CHANGED_FILES_AUTO_EXPAND_LINE_LIMIT;
}

export function changedFileName(path: string): string {
  const segments = pathSegments(path);
  return segments[segments.length - 1] ?? path;
}

function changedFileScope(path: string): string {
  const segments = pathSegments(path);
  return segments.length > 1 ? (segments[0] ?? "root") : "root";
}

export function summarizeChangedFileScopes(
  files: readonly ReviewFileChange[],
): { label: string; fileCount: number }[] {
  const scopes = new Map<string, { fileCount: number; firstIndex: number }>();
  files.forEach((file, index) => {
    const label = changedFileScope(file.path);
    const current = scopes.get(label);
    scopes.set(label, {
      fileCount: (current?.fileCount ?? 0) + 1,
      firstIndex: current?.firstIndex ?? index,
    });
  });
  return Array.from(scopes, ([label, value]) => ({ label, ...value }))
    .sort(
      (left, right) =>
        right.fileCount - left.fileCount ||
        left.firstIndex - right.firstIndex ||
        left.label.localeCompare(right.label),
    )
    .slice(0, 4)
    .map(({ label, fileCount }) => ({ label, fileCount }));
}

export function selectChangedFilePreview(
  files: readonly ReviewFileChange[],
): ReviewFileChange[] {
  const selected: ReviewFileChange[] = [];
  const paths = new Set<string>();
  const scopes = new Set<string>();
  for (const file of files) {
    const scope = changedFileScope(file.path);
    if (scopes.has(scope)) continue;
    selected.push(file);
    paths.add(file.path);
    scopes.add(scope);
    if (selected.length === CHANGED_FILES_PREVIEW_FILE_LIMIT) return selected;
  }
  for (const file of files) {
    if (paths.has(file.path)) continue;
    selected.push(file);
    if (selected.length === CHANGED_FILES_PREVIEW_FILE_LIMIT) break;
  }
  return selected;
}
