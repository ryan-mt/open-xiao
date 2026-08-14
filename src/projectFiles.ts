import type { ProjectSearchEntry } from "./auth";

export type ProjectFileTreeNode = ProjectSearchEntry & {
  children: ProjectFileTreeNode[];
};

export async function settleOwnedProjectEntriesRequest<T>(
  request: Promise<T>,
  handlers: {
    isCurrent: () => boolean;
    onSuccess: (value: T) => void;
    onError: (error: unknown) => void;
    onSettled: () => void;
  },
): Promise<void> {
  try {
    const value = await request;
    if (handlers.isCurrent()) handlers.onSuccess(value);
  } catch (error) {
    if (handlers.isCurrent()) handlers.onError(error);
  } finally {
    if (handlers.isCurrent()) handlers.onSettled();
  }
}

function sortTree(nodes: ProjectFileTreeNode[]): void {
  nodes.sort(
    (left, right) =>
      Number(right.isDir) - Number(left.isDir) ||
      left.name.localeCompare(right.name, undefined, { sensitivity: "base" }),
  );
  for (const node of nodes) sortTree(node.children);
}

export function buildProjectFileTree(
  entries: readonly ProjectSearchEntry[],
): ProjectFileTreeNode[] {
  const nodes = new Map<string, ProjectFileTreeNode>();
  for (const entry of entries) {
    nodes.set(entry.path, { ...entry, children: [] });
  }

  const roots: ProjectFileTreeNode[] = [];
  for (const node of nodes.values()) {
    const parent = node.parent ? nodes.get(node.parent) : null;
    if (parent?.isDir) parent.children.push(node);
    else roots.push(node);
  }
  sortTree(roots);
  return roots;
}

export function filterProjectFileTree(
  nodes: readonly ProjectFileTreeNode[],
  query: string,
): ProjectFileTreeNode[] {
  const tokens = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return nodes.slice();

  const filterNode = (
    node: ProjectFileTreeNode,
  ): ProjectFileTreeNode | null => {
    const haystack = node.path.toLocaleLowerCase();
    const selfMatches = tokens.every((token) => haystack.includes(token));
    if (selfMatches) return node;
    const children = node.children.flatMap((child) => {
      const match = filterNode(child);
      return match ? [match] : [];
    });
    return children.length > 0 ? { ...node, children } : null;
  };

  return nodes.flatMap((node) => {
    const match = filterNode(node);
    return match ? [match] : [];
  });
}

export function openProjectFileTab(
  openPaths: readonly string[],
  path: string,
): string[] {
  return openPaths.includes(path) ? openPaths.slice() : [...openPaths, path];
}

export function closeProjectFileTab(
  openPaths: readonly string[],
  activePath: string | null,
  path: string,
): { openPaths: string[]; activePath: string | null } {
  const index = openPaths.indexOf(path);
  if (index < 0) return { openPaths: openPaths.slice(), activePath };
  const next = openPaths.filter((entry) => entry !== path);
  if (activePath !== path) return { openPaths: next, activePath };
  return {
    openPaths: next,
    activePath: next[Math.min(index, next.length - 1)] ?? null,
  };
}

export function filePreviewLanguage(path: string): string {
  const name = path.slice(path.lastIndexOf("/") + 1).toLocaleLowerCase();
  if (name === "dockerfile") return "dockerfile";
  const extension = name.includes(".")
    ? name.slice(name.lastIndexOf(".") + 1)
    : "";
  switch (extension) {
    case "js":
    case "jsx":
    case "mjs":
    case "cjs":
      return "javascript";
    case "ts":
    case "tsx":
    case "mts":
    case "cts":
      return "typescript";
    case "json":
    case "jsonc":
      return "json";
    case "css":
    case "scss":
    case "less":
      return "css";
    case "html":
    case "htm":
    case "xml":
    case "svg":
      return "xml";
    case "md":
    case "mdx":
      return "markdown";
    case "rs":
      return "rust";
    case "py":
      return "python";
    case "sh":
    case "bash":
    case "ps1":
      return "shell";
    case "yml":
    case "yaml":
      return "yaml";
    case "sql":
      return "sql";
    case "go":
      return "go";
    case "java":
      return "java";
    case "c":
    case "h":
      return "c";
    case "cpp":
    case "cc":
    case "hpp":
      return "cpp";
    default:
      return "text";
  }
}
