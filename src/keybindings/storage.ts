import {
  DEFAULT_KEYBINDINGS,
  KEYBINDING_COMMANDS,
  type KeybindingCommand,
  type KeybindingRule,
  type KeybindingWhen,
} from "./types.ts";
import { parseKeybindingShortcut } from "./parser.ts";

export function keybindingDefaultFor(command: KeybindingCommand): KeybindingRule | null {
  return DEFAULT_KEYBINDINGS.find((binding) => binding.command === command) ?? null;
}

export function isDefaultKeybinding(rule: KeybindingRule): boolean {
  const defaultRule = keybindingDefaultFor(rule.command);
  return (
    rule.key === (defaultRule?.key ?? "") &&
    rule.when === defaultRule?.when
  );
}

function isKnownCommand(command: string): command is KeybindingCommand {
  return KEYBINDING_COMMANDS.some((definition) => definition.command === command);
}

function isKnownWhen(value: unknown): value is KeybindingWhen {
  return ["terminalFocus", "!terminalFocus", "previewOpen", "modelPickerOpen"].includes(
    String(value),
  );
}

export function normalizeStoredKeybindings(value: unknown): KeybindingRule[] {
  const stored = new Map<KeybindingCommand, KeybindingRule>();
  for (const entry of Array.isArray(value) ? value : []) {
    if (!entry || typeof entry !== "object") continue;
    const candidate = entry as { command?: unknown; key?: unknown; when?: unknown };
    if (typeof candidate.command !== "string" || !isKnownCommand(candidate.command)) continue;
    if (typeof candidate.key !== "string") continue;
    if (candidate.key.trim() !== "" && !parseKeybindingShortcut(candidate.key)) continue;
    const when = candidate.when === undefined || candidate.when === "" ? undefined : candidate.when;
    if (when !== undefined && !isKnownWhen(when)) continue;
    stored.set(candidate.command, {
      command: candidate.command,
      key: candidate.key.trim(),
      ...(when ? { when } : {}),
    });
  }

  return KEYBINDING_COMMANDS.map((definition) => {
    const existing = stored.get(definition.command);
    if (existing) return existing;
    return keybindingDefaultFor(definition.command) ?? {
      command: definition.command,
      key: "",
    };
  });
}

export function updateKeybinding(
  keybindings: ReadonlyArray<KeybindingRule>,
  command: KeybindingCommand,
  key: string,
  when?: KeybindingWhen,
): KeybindingRule[] {
  const next = keybindings.filter((binding) => binding.command !== command);
  next.push({ command, key: key.trim(), ...(when ? { when } : {}) });
  return normalizeStoredKeybindings(next);
}
