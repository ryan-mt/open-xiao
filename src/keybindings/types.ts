export const THREAD_JUMP_COMMANDS = [
  "thread.jump.1",
  "thread.jump.2",
  "thread.jump.3",
  "thread.jump.4",
  "thread.jump.5",
  "thread.jump.6",
  "thread.jump.7",
  "thread.jump.8",
  "thread.jump.9",
] as const;

export const MODEL_PICKER_JUMP_COMMANDS = [
  "modelPicker.jump.1",
  "modelPicker.jump.2",
  "modelPicker.jump.3",
  "modelPicker.jump.4",
  "modelPicker.jump.5",
  "modelPicker.jump.6",
  "modelPicker.jump.7",
  "modelPicker.jump.8",
  "modelPicker.jump.9",
] as const;

export type KeybindingCommand =
  | "sidebar.toggle"
  | "terminal.toggle"
  | "commandPalette.toggle"
  | "filePicker.toggle"
  | "projectSearch.toggle"
  | "composer.stash"
  | "chat.new"
  | "chat.newWorktree"
  | "settings.open"
  | "diff.toggle"
  | "preview.toggle"
  | "preview.refresh"
  | "preview.focusUrl"
  | "modelPicker.toggle"
  | (typeof MODEL_PICKER_JUMP_COMMANDS)[number]
  | "thread.previous"
  | "thread.next"
  | (typeof THREAD_JUMP_COMMANDS)[number]
  | "rightPanel.toggle"
  | "rightPanel.browser"
  | "rightPanel.review"
  | "rightPanel.files"
  | "theme.toggle"
  | "theme.system"
  | "agent.plan"
  | "agent.build"
  | "permission.auto"
  | "permission.ask"
  | "profile.open"
  | "project.add"
  | "undo.lastTurn"
  | "dismiss";

export type KeybindingWhen =
  | "terminalFocus"
  | "!terminalFocus"
  | "previewOpen"
  | "modelPickerOpen";

export type KeybindingRule = {
  key: string;
  command: KeybindingCommand;
  when?: KeybindingWhen;
};

export type KeybindingCommandDefinition = {
  command: KeybindingCommand;
  label: string;
  category: string;
  defaultKey: string | null;
  defaultWhen?: KeybindingWhen;
};

export type KeybindingShortcut = {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  modKey: boolean;
};

export type KeybindingEventLike = Pick<
  KeyboardEvent,
  "key" | "code" | "metaKey" | "ctrlKey" | "shiftKey" | "altKey"
>;

export type KeybindingContext = {
  terminalFocus: boolean;
  previewOpen: boolean;
  modelPickerOpen: boolean;
};

const definitions: KeybindingCommandDefinition[] = [
  { command: "chat.new", label: "Chat: New", category: "Chat", defaultKey: "mod+n", defaultWhen: "!terminalFocus" },
  { command: "chat.newWorktree", label: "Chat: New in worktree", category: "Chat", defaultKey: null },
  { command: "commandPalette.toggle", label: "Command Palette: Toggle", category: "Navigation", defaultKey: "mod+k", defaultWhen: "!terminalFocus" },
  { command: "composer.stash", label: "Composer: Stash", category: "Composer", defaultKey: "mod+s", defaultWhen: "!terminalFocus" },
  { command: "diff.toggle", label: "Diff: Toggle", category: "Panels", defaultKey: "mod+d", defaultWhen: "!terminalFocus" },
  { command: "filePicker.toggle", label: "File Picker: Toggle", category: "Navigation", defaultKey: "mod+p", defaultWhen: "!terminalFocus" },
  { command: "modelPicker.toggle", label: "Model Picker: Toggle", category: "Composer", defaultKey: "mod+shift+m", defaultWhen: "!terminalFocus" },
  ...MODEL_PICKER_JUMP_COMMANDS.map((command, index) => ({
    command,
    label: `Model Picker: Jump ${index + 1}`,
    category: "Composer",
    defaultKey: `mod+${index + 1}`,
    defaultWhen: "modelPickerOpen" as const,
  })),
  { command: "preview.focusUrl", label: "Preview: Focus URL", category: "Preview", defaultKey: "mod+l", defaultWhen: "previewOpen" },
  { command: "preview.refresh", label: "Preview: Refresh", category: "Preview", defaultKey: "mod+r", defaultWhen: "previewOpen" },
  { command: "preview.toggle", label: "Preview: Toggle", category: "Preview", defaultKey: "mod+shift+j", defaultWhen: "!terminalFocus" },
  { command: "projectSearch.toggle", label: "Project Search: Focus", category: "Navigation", defaultKey: "mod+shift+f", defaultWhen: "!terminalFocus" },
  { command: "settings.open", label: "Settings: Open", category: "Navigation", defaultKey: "mod+,", defaultWhen: "!terminalFocus" },
  { command: "sidebar.toggle", label: "Sidebar: Toggle", category: "Navigation", defaultKey: "mod+b" },
  { command: "terminal.toggle", label: "Terminal: Toggle", category: "Panels", defaultKey: "mod+backquote" },
  { command: "thread.previous", label: "Thread: Previous", category: "Threads", defaultKey: "mod+arrowup", defaultWhen: "!terminalFocus" },
  { command: "thread.next", label: "Thread: Next", category: "Threads", defaultKey: "mod+arrowdown", defaultWhen: "!terminalFocus" },
  ...THREAD_JUMP_COMMANDS.map((command, index) => ({
    command,
    label: `Thread: Jump ${index + 1}`,
    category: "Threads",
    defaultKey: `mod+${index + 1}`,
    defaultWhen: "!terminalFocus" as const,
  })),
  { command: "rightPanel.toggle", label: "Right Panel: Toggle", category: "Panels", defaultKey: "mod+alt+b", defaultWhen: "!terminalFocus" },
  { command: "rightPanel.browser", label: "Right Panel: Open Browser", category: "Panels", defaultKey: null },
  { command: "rightPanel.review", label: "Right Panel: Open Review", category: "Panels", defaultKey: null },
  { command: "rightPanel.files", label: "Right Panel: Open Files", category: "Panels", defaultKey: null },
  { command: "theme.toggle", label: "Theme: Toggle", category: "Appearance", defaultKey: "mod+shift+t", defaultWhen: "!terminalFocus" },
  { command: "theme.system", label: "Theme: Use system", category: "Appearance", defaultKey: null },
  { command: "agent.plan", label: "Agent: Plan mode", category: "Agent", defaultKey: null },
  { command: "agent.build", label: "Agent: Build mode", category: "Agent", defaultKey: null },
  { command: "permission.auto", label: "Permission: Auto", category: "Agent", defaultKey: null },
  { command: "permission.ask", label: "Permission: Ask", category: "Agent", defaultKey: null },
  { command: "profile.open", label: "Profile: Open", category: "Account", defaultKey: null },
  { command: "project.add", label: "Project: Add", category: "Projects", defaultKey: null },
  { command: "undo.lastTurn", label: "Undo: Last agent turn", category: "Agent", defaultKey: "mod+shift+z", defaultWhen: "!terminalFocus" },
  { command: "dismiss", label: "Dismiss: Close or stop", category: "Navigation", defaultKey: "escape" },
];

export const KEYBINDING_COMMANDS: ReadonlyArray<KeybindingCommandDefinition> = definitions;

export const DEFAULT_KEYBINDINGS: ReadonlyArray<KeybindingRule> = definitions.flatMap(
  ({ command, defaultKey, defaultWhen }) =>
    defaultKey
      ? [{ command, key: defaultKey, ...(defaultWhen ? { when: defaultWhen } : {}) }]
      : [],
);
