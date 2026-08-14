/**
 * Composer `@file` mentions — aligned with standard trigger detection and
 * OpenCode `@path` insertion (plain textarea, no Lexical chips).
 */

export type FileMentionTrigger = {
  kind: "path";
  query: string;
  rangeStart: number;
  rangeEnd: number;
};

export type FileMentionSearchOwner = {
  generation: number;
  projectPath: string;
  query: string;
  rangeStart: number;
  rangeEnd: number;
};

export function ownsFileMentionSearch(
  owner: FileMentionSearchOwner,
  generation: number,
  projectPath: string | null,
  trigger: FileMentionTrigger | null,
): boolean {
  return Boolean(
    trigger &&
    owner.generation === generation &&
    owner.projectPath === projectPath &&
    owner.query === trigger.query &&
    owner.rangeStart === trigger.rangeStart &&
    owner.rangeEnd === trigger.rangeEnd,
  );
}

const SIMPLE_MENTION_PATH_REGEX = /^[^\s@"\\]+$/;

function clampCursor(text: string, cursor: number): number {
  if (!Number.isFinite(cursor)) return text.length;
  return Math.max(0, Math.min(text.length, Math.floor(cursor)));
}

function isWhitespace(char: string): boolean {
  return char === " " || char === "\n" || char === "\t" || char === "\r";
}

/** Reverse the escaping serializeFileMentionPath applies inside quotes. */
function unescapeMentionPath(raw: string): string {
  let out = "";
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (c === "\\" && i + 1 < raw.length) {
      out += raw[i + 1];
      i++;
    } else {
      out += c;
    }
  }
  return out;
}

/**
 * Detect an active `@path` trigger at the cursor. Understands both the bare
 * whitespace-delimited token and the quoted form (@"path with spaces") that
 * serializeFileMentionPath emits. Slash drafts (`/` at line start) are left to
 * slashCommands — not handled here.
 */
export function detectFileMentionTrigger(
  text: string,
  cursorInput: number,
): FileMentionTrigger | null {
  const cursor = clampCursor(text, cursorInput);
  // Do not compete with whole-draft slash commands.
  if (text.startsWith("/") && !text.includes("\n") && !text.includes("\r")) {
    return null;
  }

  // Scan backwards for an '@' at a word boundary (start of text or preceded by
  // whitespace). Do not stop at spaces/tabs: quoted mentions span them. Do stop
  // at newlines — a mention is single-line.
  let at = -1;
  for (let i = cursor - 1; i >= 0; i--) {
    const ch = text[i] ?? "";
    if (ch === "\n" || ch === "\r") break;
    if (ch !== "@") continue;
    const before = i > 0 ? (text[i - 1] ?? "") : "";
    if (before === "" || isWhitespace(before)) {
      at = i;
      break;
    }
    // '@' not at a boundary (e.g. an email) — keep scanning further back.
  }
  if (at < 0) return null;

  const after = text[at + 1] ?? "";
  if (after === '"') {
    // Quoted mention: find the closing quote (it may sit past the cursor).
    let close = -1;
    for (let j = at + 2; j < text.length; j++) {
      const c = text[j] ?? "";
      if (c === "\\") {
        j++;
        continue;
      }
      if (c === '"') {
        close = j;
        break;
      }
    }
    if (close >= 0 && cursor > close + 1) {
      // Cursor sits after the completed mention — not editing it.
      return null;
    }
    const innerEnd = close >= 0 ? close : cursor;
    return {
      kind: "path",
      query: unescapeMentionPath(text.slice(at + 2, innerEnd)),
      rangeStart: at,
      rangeEnd: close >= 0 ? close + 1 : cursor,
    };
  }

  // Bare mention: runs until the next whitespace.
  let end = at + 1;
  while (end < text.length && !isWhitespace(text[end] ?? "")) end++;
  if (cursor > end) return null;
  return {
    kind: "path",
    query: text.slice(at + 1, cursor),
    rangeStart: at,
    rangeEnd: cursor,
  };
}

/** Quote paths that need it (spaces, @, quotes, backslashes). */
export function serializeFileMentionPath(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  if (SIMPLE_MENTION_PATH_REGEX.test(normalized)) {
    return normalized;
  }
  return `"${normalized.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** Insert `@path` (OpenCode style) replacing the active trigger range. */
export function applyFileMentionSelection(
  text: string,
  trigger: FileMentionTrigger,
  path: string,
): { text: string; cursor: number } {
  const mention = `@${serializeFileMentionPath(path)} `;
  const safeStart = Math.max(0, Math.min(text.length, trigger.rangeStart));
  const safeEnd = Math.max(safeStart, Math.min(text.length, trigger.rangeEnd));
  const next = `${text.slice(0, safeStart)}${mention}${text.slice(safeEnd)}`;
  return { text: next, cursor: safeStart + mention.length };
}

export type FileMentionMenuItem = {
  key: string;
  path: string;
  name: string;
  parent: string;
  isDir: boolean;
  label: string;
  description: string;
};

export function toFileMentionMenuItem(entry: {
  path: string;
  name: string;
  parent: string;
  isDir: boolean;
}): FileMentionMenuItem {
  return {
    key: `${entry.isDir ? "dir" : "file"}:${entry.path}`,
    path: entry.path,
    name: entry.name,
    parent: entry.parent,
    isDir: entry.isDir,
    label: entry.name,
    description: entry.parent || (entry.isDir ? "folder" : "project root"),
  };
}
