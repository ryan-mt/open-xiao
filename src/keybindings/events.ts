import type { KeybindingCommand } from "./types.ts";

export const KEYBINDING_COMMAND_EVENT = "open-xiao:keybinding-command";

export type KeybindingCommandEventDetail = {
  command: KeybindingCommand;
  index?: number;
};

export function emitKeybindingCommand(command: KeybindingCommand, index?: number): void {
  if (typeof window === "undefined") return;
  const detail: KeybindingCommandEventDetail = {
    command,
    ...(index === undefined ? {} : { index }),
  };
  window.dispatchEvent(new CustomEvent(KEYBINDING_COMMAND_EVENT, { detail }));
}
