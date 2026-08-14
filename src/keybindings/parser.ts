import type {
  KeybindingContext,
  KeybindingEventLike,
  KeybindingRule,
  KeybindingShortcut,
  KeybindingWhen,
} from "./types.ts";
import type { KeybindingCommand } from "./types.ts";

function isMacPlatform(platform: string): boolean {
  return /Mac|iPhone|iPad|iPod/i.test(platform);
}

function normalizeKeyToken(token: string): string {
  const normalized = token.toLowerCase();
  if (normalized === "space") return " ";
  if (normalized === "esc") return "escape";
  if (normalized === "backquote" || normalized === "`") return "backquote";
  if (normalized === "comma") return ",";
  return normalized;
}

export function parseKeybindingShortcut(value: string): KeybindingShortcut | null {
  const rawTokens = value.trim().toLowerCase().split("+").map((token) => token.trim());
  const tokens = [...rawTokens];
  let trailingEmptyCount = 0;
  while (tokens[tokens.length - 1] === "") {
    trailingEmptyCount += 1;
    tokens.pop();
  }
  if (trailingEmptyCount > 0) tokens.push("+");
  if (tokens.length === 0 || tokens.some((token) => token.length === 0)) return null;

  let key: string | null = null;
  let metaKey = false;
  let ctrlKey = false;
  let shiftKey = false;
  let altKey = false;
  let modKey = false;

  for (const token of tokens) {
    switch (token) {
      case "cmd":
      case "meta":
        metaKey = true;
        break;
      case "ctrl":
      case "control":
        ctrlKey = true;
        break;
      case "shift":
        shiftKey = true;
        break;
      case "alt":
      case "option":
        altKey = true;
        break;
      case "mod":
        modKey = true;
        break;
      default:
        if (key !== null) return null;
        key = normalizeKeyToken(token);
    }
  }

  if (key === null || (key.includes(" ") && key !== " ")) return null;
  return { key, metaKey, ctrlKey, shiftKey, altKey, modKey };
}

function eventKey(event: KeybindingEventLike): string {
  if (event.code === "Backquote") return "backquote";
  if (event.code === "Comma") return ",";
  return normalizeKeyToken(event.key);
}

function eventKeys(event: KeybindingEventLike): Set<string> {
  const keys = new Set([eventKey(event)]);
  const letter = /^Key([A-Z])$/.exec(event.code)?.[1];
  const digit = /^Digit([0-9])$/.exec(event.code)?.[1];
  if (letter) keys.add(letter.toLowerCase());
  if (digit) keys.add(digit);
  if (event.code === "BracketLeft") keys.add("[");
  if (event.code === "BracketRight") keys.add("]");
  return keys;
}

function matchesShortcut(
  event: KeybindingEventLike,
  shortcut: KeybindingShortcut,
  platform: string,
): boolean {
  const useMetaForMod = isMacPlatform(platform);
  return (
    event.metaKey === (shortcut.metaKey || (shortcut.modKey && useMetaForMod)) &&
    event.ctrlKey === (shortcut.ctrlKey || (shortcut.modKey && !useMetaForMod)) &&
    event.shiftKey === shortcut.shiftKey &&
    event.altKey === shortcut.altKey &&
    eventKeys(event).has(shortcut.key)
  );
}

function matchesWhen(when: KeybindingWhen | undefined, context: KeybindingContext): boolean {
  if (!when) return true;
  const negated = when.startsWith("!");
  const variable = negated ? when.slice(1) : when;
  const value =
    variable === "terminalFocus"
      ? context.terminalFocus
      : variable === "previewOpen"
        ? context.previewOpen
        : variable === "modelPickerOpen"
          ? context.modelPickerOpen
          : false;
  return negated ? !value : value;
}

function whenPriority(when: KeybindingWhen | undefined): number {
  // A positive context such as modelPickerOpen or previewOpen is more
  // specific than the broad !terminalFocus guard used by app commands.
  return when && !when.startsWith("!") ? 1 : 0;
}

export function resolveShortcutCommand(
  event: KeybindingEventLike,
  keybindings: ReadonlyArray<KeybindingRule>,
  context: KeybindingContext,
  platform = typeof navigator === "undefined" ? "" : navigator.platform,
): KeybindingCommand | null {
  let resolved: KeybindingCommand | null = null;
  let resolvedPriority = -1;
  for (let index = keybindings.length - 1; index >= 0; index -= 1) {
    const binding = keybindings[index];
    const shortcut = binding?.key ? parseKeybindingShortcut(binding.key) : null;
    if (shortcut && matchesShortcut(event, shortcut, platform) && matchesWhen(binding.when, context)) {
      const priority = whenPriority(binding.when);
      if (priority > resolvedPriority) {
        resolved = binding.command;
        resolvedPriority = priority;
      }
    }
  }
  return resolved;
}

export function keybindingFromKeyboardEvent(
  event: KeybindingEventLike,
  platform = typeof navigator === "undefined" ? "" : navigator.platform,
): string | null {
  const key = eventKey(event);
  if (["meta", "control", "shift", "alt", "backspace", "dead"].includes(key)) return null;
  const hasModifier = event.metaKey || event.ctrlKey || event.shiftKey || event.altKey;
  const standaloneSpecial = [
    "escape",
    "tab",
    "enter",
    "arrowup",
    "arrowdown",
    "arrowleft",
    "arrowright",
  ].includes(key);
  if (!hasModifier && !standaloneSpecial) return null;

  const parts: string[] = [];
  if (isMacPlatform(platform)) {
    if (event.metaKey) parts.push("mod");
    if (event.ctrlKey) parts.push("ctrl");
  } else {
    if (event.ctrlKey) parts.push("mod");
    if (event.metaKey) parts.push("meta");
  }
  if (event.altKey) parts.push("alt");
  if (event.shiftKey) parts.push("shift");
  parts.push(key === " " ? "space" : key);
  return parts.join("+");
}

function labelForKey(key: string): string {
  return (
    {
      " ": "Space",
      escape: "Esc",
      enter: "Enter",
      tab: "Tab",
      backspace: "Backspace",
      arrowup: "↑",
      arrowdown: "↓",
      arrowleft: "←",
      arrowright: "→",
      backquote: "`",
    } satisfies Record<string, string>
  )[key] ?? (key.length === 1 ? key.toUpperCase() : key);
}

export function formatShortcutLabel(
  value: string,
  platform = typeof navigator === "undefined" ? "" : navigator.platform,
): string {
  const shortcut = parseKeybindingShortcut(value);
  if (!shortcut) return "Unassigned";
  const mac = isMacPlatform(platform);
  const parts: string[] = [];
  if (shortcut.modKey) parts.push(mac ? "⌘" : "Ctrl");
  if (shortcut.metaKey) parts.push(mac ? "⌘" : "Meta");
  if (shortcut.ctrlKey) parts.push(mac ? "⌃" : "Ctrl");
  if (shortcut.altKey) parts.push(mac ? "⌥" : "Alt");
  if (shortcut.shiftKey) parts.push(mac ? "⇧" : "Shift");
  parts.push(labelForKey(shortcut.key));
  return parts.join(mac ? "" : "+");
}

export function shortcutConflictKey(shortcut: KeybindingShortcut, platform: string): string {
  const mac = isMacPlatform(platform);
  return [
    shortcut.key,
    shortcut.metaKey || (shortcut.modKey && mac) ? "meta" : "",
    shortcut.ctrlKey || (shortcut.modKey && !mac) ? "ctrl" : "",
    shortcut.shiftKey ? "shift" : "",
    shortcut.altKey ? "alt" : "",
  ].join("|");
}
