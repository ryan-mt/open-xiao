import type { ReviewDiffLine, ReviewFileChange } from "./reviewChanges.ts";

export type ReviewCommentSelection = {
  filePath: string;
  startIndex: number;
  endIndex: number;
  rangeLabel: string;
  diff: string;
};

export type ReviewComment = ReviewCommentSelection & {
  id: string;
  threadId: string;
  sectionId: string;
  sectionTitle: string;
  body: string;
};

function displayLineNumber(line: ReviewDiffLine): number | null {
  return line.newLine ?? line.oldLine ?? null;
}

function singleLineLabel(line: ReviewDiffLine): string {
  const number = displayLineNumber(line);
  if (number == null) return "line";
  if (line.kind === "add") return `+${number}`;
  if (line.kind === "del") return `-${number}`;
  return String(number);
}

function syntheticHunkHeader(lines: readonly ReviewDiffLine[]): string {
  const oldLines = lines.flatMap((line) =>
    line.oldLine == null ? [] : [line.oldLine],
  );
  const newLines = lines.flatMap((line) =>
    line.newLine == null ? [] : [line.newLine],
  );
  const oldStart = oldLines[0] ?? 0;
  const newStart = newLines[0] ?? 0;
  return `@@ -${oldStart},${oldLines.length} +${newStart},${newLines.length} @@`;
}

export function buildReviewCommentSelection(
  file: ReviewFileChange,
  fromLineIndex: number,
  toLineIndex: number,
): ReviewCommentSelection | null {
  const startLine = Math.min(fromLineIndex, toLineIndex);
  const endLine = Math.max(fromLineIndex, toLineIndex);
  const selectable = file.lines
    .map((line, lineIndex) => ({ line, lineIndex }))
    .filter(({ line }) => line.kind !== "meta");
  const selected = selectable.filter(
    ({ lineIndex }) => lineIndex >= startLine && lineIndex <= endLine,
  );
  if (selected.length === 0) return null;

  const startIndex = selectable.findIndex(
    ({ lineIndex }) => lineIndex === selected[0]?.lineIndex,
  );
  const endIndex = selectable.findIndex(
    ({ lineIndex }) => lineIndex === selected[selected.length - 1]?.lineIndex,
  );
  const first = selected[0]!.line;
  const last = selected[selected.length - 1]!.line;
  const firstNumber = displayLineNumber(first);
  const lastNumber = displayLineNumber(last);
  const rangeLabel =
    selected.length === 1
      ? singleLineLabel(first)
      : firstNumber != null && lastNumber != null
        ? `${firstNumber} to ${lastNumber}`
        : `${startIndex + 1} to ${endIndex + 1}`;

  const diffLines: string[] = [];
  let currentHunk: string | null = null;
  for (const { line } of selected) {
    const header = line.hunkHeader ?? syntheticHunkHeader(selected.map((item) => item.line));
    if (header !== currentHunk) {
      diffLines.push(header);
      currentHunk = header;
    }
    diffLines.push(
      line.raw ??
        `${line.kind === "add" ? "+" : line.kind === "del" ? "-" : " "}${line.code}`,
    );
  }

  return {
    filePath: file.displayPath || file.path,
    startIndex,
    endIndex,
    rangeLabel,
    diff: diffLines.join("\n"),
  };
}

function escapeAttribute(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export function serializeReviewComment(comment: ReviewComment): string {
  return `<review_comment sectionId="${escapeAttribute(comment.sectionId)}" sectionTitle="${escapeAttribute(comment.sectionTitle)}" filePath="${escapeAttribute(comment.filePath)}" startIndex="${comment.startIndex}" endIndex="${comment.endIndex}" rangeLabel="${escapeAttribute(comment.rangeLabel)}">\n${comment.body.trim()}\n\`\`\`diff\n${comment.diff}\n\`\`\`\n</review_comment>`;
}

export function appendReviewComments(
  text: string,
  comments: readonly ReviewComment[],
): string {
  const parts = comments.map(serializeReviewComment);
  const trimmed = text.trim();
  return trimmed ? [trimmed, ...parts].join("\n\n") : parts.join("\n\n");
}
