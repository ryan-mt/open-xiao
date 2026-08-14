import { useEffect, useRef } from "react";
import {
  resolveShortcutCommand,
  type KeybindingCommand,
  type KeybindingRule,
} from "../keybindings";
import { isTerminalFocusedElement } from "../terminal";

type RightPanelPage = "browser" | "review" | "files";

export type KeybindingDispatcherActions = {
  toggleSidebar: () => void;
  toggleTerminal: () => void;
  toggleCommandPalette: () => void;
  toggleFilePicker: () => void;
  newChat: () => void;
  newChatInWorktree: () => void;
  openSettings: () => void;
  focusProjectSearch: () => void;
  toggleDiff: () => void;
  togglePreview: () => void;
  toggleRightPanel: () => void;
  openRightPanelPage: (page: RightPanelPage) => void;
  toggleTheme: () => void;
  useSystemTheme: () => void;
  setPlanMode: () => void;
  setBuildMode: () => void;
  setPermissionAuto: () => void;
  setPermissionAsk: () => void;
  openProfile: () => void;
  addProject: () => void;
  undoLastTurn: () => void;
  dismiss: () => void;
  emitCommand: (command: KeybindingCommand, index?: number) => void;
};

export type KeybindingDispatcherOptions = {
  keybindings: ReadonlyArray<KeybindingRule>;
  blocked: boolean;
  previewOpen: boolean;
  actions: KeybindingDispatcherActions;
};

function dispatchCommand(
  command: KeybindingCommand,
  actions: KeybindingDispatcherActions,
): void {
  if (command.startsWith("thread.jump.")) {
    actions.emitCommand(command);
    return;
  }

  switch (command) {
    case "sidebar.toggle":
      actions.toggleSidebar();
      return;
    case "terminal.toggle":
      actions.toggleTerminal();
      return;
    case "commandPalette.toggle":
      actions.toggleCommandPalette();
      return;
    case "filePicker.toggle":
      actions.toggleFilePicker();
      return;
    case "projectSearch.toggle":
      actions.focusProjectSearch();
      return;
    case "composer.stash":
    case "preview.refresh":
    case "preview.focusUrl":
    case "modelPicker.toggle":
      actions.emitCommand(command);
      return;
    case "chat.new":
      actions.newChat();
      return;
    case "chat.newWorktree":
      actions.newChatInWorktree();
      return;
    case "settings.open":
      actions.openSettings();
      return;
    case "diff.toggle":
      actions.toggleDiff();
      return;
    case "preview.toggle":
      actions.togglePreview();
      return;
    case "thread.previous":
    case "thread.next":
      actions.emitCommand(command);
      return;
    case "rightPanel.toggle":
      actions.toggleRightPanel();
      return;
    case "rightPanel.browser":
      actions.openRightPanelPage("browser");
      return;
    case "rightPanel.review":
      actions.openRightPanelPage("review");
      return;
    case "rightPanel.files":
      actions.openRightPanelPage("files");
      return;
    case "theme.toggle":
      actions.toggleTheme();
      return;
    case "theme.system":
      actions.useSystemTheme();
      return;
    case "agent.plan":
      actions.setPlanMode();
      return;
    case "agent.build":
      actions.setBuildMode();
      return;
    case "permission.auto":
      actions.setPermissionAuto();
      return;
    case "permission.ask":
      actions.setPermissionAsk();
      return;
    case "profile.open":
      actions.openProfile();
      return;
    case "project.add":
      actions.addProject();
      return;
    case "undo.lastTurn":
      actions.undoLastTurn();
      return;
    case "dismiss":
      actions.dismiss();
      return;
    default:
      return;
  }
}

export function useKeybindingDispatcher(
  options: KeybindingDispatcherOptions,
): void {
  const optionsRef = useRef(options);
  optionsRef.current = options;

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const current = optionsRef.current;
      if (current.blocked) return;

      const target = event.target instanceof Element ? event.target : null;
      const terminalFocus = isTerminalFocusedElement(target);
      const command = resolveShortcutCommand(event, current.keybindings, {
        terminalFocus,
        previewOpen: current.previewOpen,
        modelPickerOpen: false,
      });
      if (!command || command.startsWith("modelPicker.jump.")) return;

      // The terminal owns all input except its explicit toggle command.
      if (terminalFocus && command !== "terminal.toggle") return;

      event.preventDefault();
      event.stopPropagation();
      dispatchCommand(command, current.actions);
    };

    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}
