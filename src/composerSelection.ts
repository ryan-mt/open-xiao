const SURROUND_PAIRS = new Map<string, string>([
  ["(", ")"],
  ["[", "]"],
  ["{", "}"],
  ["'", "'"],
  ['"', '"'],
  ["“", "”"],
  ["`", "`"],
  ["<", ">"],
  ["«", "»"],
  ["*", "*"],
  ["_", "_"],
]);

export type ComposerSurroundResult = {
  value: string;
  selectionStart: number;
  selectionEnd: number;
};

export function surroundComposerSelection(
  value: string,
  selectionStart: number,
  selectionEnd: number,
  input: string,
): ComposerSurroundResult | null {
  const close = SURROUND_PAIRS.get(input);
  if (!close) return null;

  const start = Math.max(0, Math.min(selectionStart, selectionEnd, value.length));
  const end = Math.max(0, Math.min(Math.max(selectionStart, selectionEnd), value.length));
  if (start === end) return null;

  const selected = value.slice(start, end);
  return {
    value: `${value.slice(0, start)}${input}${selected}${close}${value.slice(end)}`,
    selectionStart: start + input.length,
    selectionEnd: start + input.length + selected.length,
  };
}
