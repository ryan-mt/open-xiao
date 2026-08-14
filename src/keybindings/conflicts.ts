import { KEYBINDING_COMMANDS } from "./types.ts";
import type { KeybindingCommand, KeybindingRule, KeybindingWhen } from "./types.ts";
import {
  parseKeybindingShortcut,
  shortcutConflictKey,
} from "./parser.ts";

function conditionsOverlap(left: KeybindingWhen | undefined, right: KeybindingWhen | undefined): boolean {
  if (!left || !right || left === right) return true;
  return !(
    (left === "terminalFocus" && right === "!terminalFocus") ||
    (left === "!terminalFocus" && right === "terminalFocus")
  );
}

export function keybindingConflictLabels(
  command: KeybindingCommand,
  key: string,
  when: KeybindingWhen | undefined,
  keybindings: ReadonlyArray<KeybindingRule>,
  platform = typeof navigator === "undefined" ? "" : navigator.platform,
): ReadonlyArray<string> {
  const shortcut = parseKeybindingShortcut(key);
  if (!shortcut) return [];
  const target = shortcutConflictKey(shortcut, platform);
  const conflicts = new Set<string>();
  for (const binding of keybindings) {
    if (binding.command === command || !binding.key) continue;
    const candidate = parseKeybindingShortcut(binding.key);
    if (
      candidate &&
      shortcutConflictKey(candidate, platform) === target &&
      conditionsOverlap(when, binding.when)
    ) {
      conflicts.add(commandLabel(binding.command));
    }
  }
  return [...conflicts].sort((left, right) => left.localeCompare(right));
}

export function commandLabel(command: KeybindingCommand): string {
  return KEYBINDING_COMMANDS.find((definition) => definition.command === command)?.label ?? command;
}

export function shouldShowThreadJumpHintsForModifiers(
  event: Pick<KeyboardEvent, "metaKey" | "ctrlKey" | "shiftKey" | "altKey">,
  keybindings: ReadonlyArray<KeybindingRule>,
  platform = typeof navigator === "undefined" ? "" : navigator.platform,
): boolean {
  if (event.shiftKey || event.altKey) return false;
  const mac = /Mac|iPhone|iPad|iPod/i.test(platform);
  return keybindings.some((binding) => {
    if (!binding.command.startsWith("thread.jump.")) return false;
    const shortcut = parseKeybindingShortcut(binding.key);
    return Boolean(
      shortcut &&
        shortcut.modKey &&
        event.metaKey === mac &&
        event.ctrlKey === !mac &&
        !shortcut.metaKey &&
        !shortcut.ctrlKey &&
        !shortcut.shiftKey &&
        !shortcut.altKey,
    );
  });
}
