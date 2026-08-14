import {
  ACCESS_MODES,
  AGENT_MODES,
  ALL_MODELS,
  PERMISSION_MODES,
  THINKING_LEVELS,
  getModel,
  type AccessMode,
  type AgentMode,
  type PermissionMode,
  type ThinkingLevel,
} from "./models.ts";
import { THEME_CATALOG, isThemeMode, type ThemeMode } from "./theme.ts";

/** Handlers supplied by the app shell (Composer / palette share these). */
export type SlashCommandHandlers = {
  newChat: () => void;
  setModel: (id: string) => boolean | void;
  setThinking: (level: ThinkingLevel) => ThinkingLevel;
  setAccessMode: (mode: AccessMode) => void;
  setAgentMode: (mode: AgentMode) => void;
  setPermissionMode: (mode: PermissionMode) => void;
  openReview: () => void;
  toggleTheme: () => void;
  setTheme: (mode: ThemeMode) => void;
  /**
   * Fold older turns in the active thread toward ~60% context.
   * Return false to keep the draft (e.g. streaming / no thread).
   */
  compact: () => boolean | void;
  /**
   * Restore files from the last agent turn's snapshots.
   * Return false to keep the draft (e.g. nothing to undo / streaming).
   */
  undoLastTurn: () => boolean | void | Promise<boolean | void>;
  notify: (message: string, kind?: "info" | "success" | "error") => void;
};

export type SlashArgOption = {
  id: string;
  label: string;
  description?: string;
  /** Extra tokens matched when filtering (ids, aliases). */
  keywords?: string[];
};

export type SlashCommandDef = {
  id: string;
  /** Primary trigger without leading slash, e.g. "model". */
  name: string;
  /** Alternate names without leading slash. */
  aliases?: string[];
  description: string;
  /** Shown in the menu as `/name <hint>`. */
  argsHint?: string;
  /** When set, bare `/cmd` lists these; `/cmd value` resolves against them. */
  argOptions?: SlashArgOption[];
  /**
   * When true with `argOptions`, bare `/cmd` still runs (e.g. `/theme` toggles).
   * Default: args required whenever `argOptions` is non-empty.
   */
  argsOptional?: boolean;
  /**
   * Run the command. Return false to keep the menu open (e.g. unknown arg).
   * Return true / void to clear the composer draft.
   */
  run: (
    args: string,
    handlers: SlashCommandHandlers,
  ) => boolean | void;
};

/** Draft is only a slash command candidate (leading `/`, single line). */
export function isSlashDraft(value: string): boolean {
  if (!value.startsWith("/")) return false;
  if (value.includes("\n") || value.includes("\r")) return false;
  return true;
}

/**
 * Active slash query while the user is typing a command.
 * Open when the draft is `/` or `/token...` on one line (no leading space after `/` starts a path-like token).
 */
export function getSlashQuery(value: string): string | null {
  if (!isSlashDraft(value)) return null;
  // Allow "/model grok" while typing; reject mid-prose by requiring start-of-input only.
  return value.slice(1);
}

export type ParsedSlash = {
  name: string;
  args: string;
  /** Raw token after `/` before first whitespace (lowercased for match). */
  nameRaw: string;
};

export function parseSlashInput(value: string): ParsedSlash | null {
  if (!isSlashDraft(value)) return null;
  const body = value.slice(1);
  const match = /^(\S*)(?:\s+(.*))?$/s.exec(body);
  if (!match) return null;
  const nameRaw = match[1] ?? "";
  const args = (match[2] ?? "").trim();
  return {
    name: nameRaw.toLowerCase(),
    nameRaw,
    args,
  };
}

function normalizeNeedle(s: string): string {
  return s.trim().toLowerCase();
}

function optionMatches(option: SlashArgOption, needle: string): boolean {
  if (!needle) return true;
  const n = normalizeNeedle(needle);
  if (option.id.toLowerCase() === n) return true;
  if (option.label.toLowerCase().includes(n)) return true;
  if (option.description?.toLowerCase().includes(n)) return true;
  if (option.keywords?.some((k) => k.toLowerCase().includes(n) || n.includes(k.toLowerCase()))) {
    return true;
  }
  // Fuzzy-ish: all chars of needle appear in id in order
  const id = option.id.toLowerCase();
  if (id.includes(n)) return true;
  return false;
}

export function findCommand(
  commands: readonly SlashCommandDef[],
  name: string,
): SlashCommandDef | undefined {
  const n = normalizeNeedle(name);
  if (!n) return undefined;
  return commands.find(
    (c) =>
      c.name === n ||
      c.id === n ||
      (c.aliases?.some((a) => a === n) ?? false),
  );
}

export function resolveArgOption(
  command: SlashCommandDef,
  args: string,
): SlashArgOption | undefined {
  if (!command.argOptions || command.argOptions.length === 0) return undefined;
  const n = normalizeNeedle(args);
  if (!n) return undefined;
  // Prefer exact id, then exact label, then unique prefix / fuzzy.
  const exactId = command.argOptions.find((o) => o.id.toLowerCase() === n);
  if (exactId) return exactId;
  const exactLabel = command.argOptions.find(
    (o) => o.label.toLowerCase() === n,
  );
  if (exactLabel) return exactLabel;
  const matches = command.argOptions.filter((o) => optionMatches(o, n));
  if (matches.length === 1) return matches[0];
  // Unique id prefix
  const prefix = command.argOptions.filter((o) =>
    o.id.toLowerCase().startsWith(n),
  );
  if (prefix.length === 1) return prefix[0];
  return undefined;
}

export type SlashMenuItem =
  | {
      kind: "command";
      key: string;
      command: SlashCommandDef;
      label: string;
      hint: string;
      description: string;
    }
  | {
      kind: "arg";
      key: string;
      command: SlashCommandDef;
      option: SlashArgOption;
      label: string;
      hint: string;
      description: string;
    };

/**
 * Build the autocomplete list for the current draft.
 * - `/` or `/mo` → matching commands
 * - `/model` or `/model gr` → arg options when the command defines them
 */
export function buildSlashMenuItems(
  value: string,
  commands: readonly SlashCommandDef[] = SLASH_COMMANDS,
): SlashMenuItem[] {
  const parsed = parseSlashInput(value);
  if (!parsed) return [];

  const { name, args, nameRaw } = parsed;

  // `/` only — show all commands
  if (!nameRaw && !args) {
    return commands.map((c) => commandToItem(c));
  }

  // Exact command match (by name/alias) → args mode when applicable
  const exact = findCommand(commands, name);
  const trailingSpace = /\s$/.test(value) || args.length > 0;

  if (exact && (trailingSpace || args.length > 0 || value === `/${exact.name}` || exact.aliases?.some((a) => value === `/${a}`))) {
    // Bare command with no args and no trailing space still shows the command itself
    // plus arg options when user typed trailing space or started args.
    if (exact.argOptions && exact.argOptions.length > 0 && (trailingSpace || args.length > 0)) {
      const opts = exact.argOptions.filter((o) => optionMatches(o, args));
      return opts.map((o) => argToItem(exact, o));
    }
    // Command that takes no structured args, or user hasn't opened args yet:
    // if fully typed name with no args, show just this command (Enter runs it).
    if (!args && !trailingSpace) {
      return [commandToItem(exact)];
    }
    if (!exact.argOptions?.length && !args) {
      return [commandToItem(exact)];
    }
  }

  // Filter commands by name prefix / includes
  const needle = name;
  const matched = commands.filter((c) => commandMatches(c, needle));
  return matched.map((c) => commandToItem(c));
}

function commandMatches(c: SlashCommandDef, needle: string): boolean {
  if (!needle) return true;
  const n = needle.toLowerCase();
  if (c.name.startsWith(n) || c.name.includes(n)) return true;
  if (c.id.startsWith(n) || c.id.includes(n)) return true;
  if (c.aliases?.some((a) => a.startsWith(n) || a.includes(n))) return true;
  if (c.description.toLowerCase().includes(n)) return true;
  return false;
}

function commandToItem(c: SlashCommandDef): SlashMenuItem {
  return {
    kind: "command",
    key: `cmd-${c.id}`,
    command: c,
    label: `/${c.name}`,
    hint: c.argsHint ? c.argsHint : "",
    description: c.description,
  };
}

function argToItem(c: SlashCommandDef, o: SlashArgOption): SlashMenuItem {
  return {
    kind: "arg",
    key: `arg-${c.id}-${o.id}`,
    command: c,
    option: o,
    label: o.label,
    hint: o.id,
    description: o.description ?? c.description,
  };
}

/**
 * Apply a menu selection into the draft text (Tab / click partial).
 * - Command without required picker → keep as `/name ` if it has arg options, else `/name`
 * - Arg option → `/name optionId`
 */
export function applySlashMenuSelection(
  item: SlashMenuItem,
): string {
  if (item.kind === "command") {
    if (item.command.argOptions && item.command.argOptions.length > 0) {
      return `/${item.command.name} `;
    }
    return `/${item.command.name}`;
  }
  return `/${item.command.name} ${item.option.id}`;
}

export type SlashExecuteResult =
  | { ok: true; clearDraft: true }
  | { ok: false; reason: "not-slash" | "unknown" | "bad-args" | "incomplete" };

/**
 * Execute a full slash line (Enter on bare draft or after selection).
 * Does not clear draft itself — caller clears when `ok`.
 */
export function executeSlashInput(
  value: string,
  handlers: SlashCommandHandlers,
  commands: readonly SlashCommandDef[] = SLASH_COMMANDS,
): SlashExecuteResult {
  const parsed = parseSlashInput(value);
  if (!parsed) return { ok: false, reason: "not-slash" };

  const { name, args, nameRaw } = parsed;
  if (!nameRaw) {
    // Just `/`
    return { ok: false, reason: "incomplete" };
  }

  const command = findCommand(commands, name);
  if (!command) {
    handlers.notify(`Unknown command: /${nameRaw}`, "error");
    return { ok: false, reason: "unknown" };
  }

  if (command.argOptions && command.argOptions.length > 0) {
    if (!args) {
      if (command.argsOptional) {
        const result = command.run("", handlers);
        if (result === false) return { ok: false, reason: "bad-args" };
        return { ok: true, clearDraft: true };
      }
      // Prefer leaving menu open — caller should not clear.
      return { ok: false, reason: "incomplete" };
    }
    const option = resolveArgOption(command, args);
    if (!option) {
      handlers.notify(
        `Unknown argument for /${command.name}: ${args}`,
        "error",
      );
      return { ok: false, reason: "bad-args" };
    }
    const result = command.run(option.id, handlers);
    if (result === false) return { ok: false, reason: "bad-args" };
    return { ok: true, clearDraft: true };
  }

  const result = command.run(args, handlers);
  if (result === false) return { ok: false, reason: "bad-args" };
  return { ok: true, clearDraft: true };
}

/** Execute a concrete menu item (Enter on highlighted row). */
export function executeSlashMenuItem(
  item: SlashMenuItem,
  handlers: SlashCommandHandlers,
): SlashExecuteResult {
  if (item.kind === "command") {
    if (
      item.command.argOptions &&
      item.command.argOptions.length > 0 &&
      !item.command.argsOptional
    ) {
      // Expand to args picker — not a completed run.
      return { ok: false, reason: "incomplete" };
    }
    const result = item.command.run("", handlers);
    if (result === false) return { ok: false, reason: "bad-args" };
    return { ok: true, clearDraft: true };
  }
  const result = item.command.run(item.option.id, handlers);
  if (result === false) return { ok: false, reason: "bad-args" };
  return { ok: true, clearDraft: true };
}

function modelOptions(): SlashArgOption[] {
  return ALL_MODELS.map((m) => ({
    id: m.id,
    label: m.label,
    description: m.description,
    keywords: [m.id, m.badge ?? "", m.context].filter(Boolean),
  }));
}

function thinkingOptions(): SlashArgOption[] {
  return THINKING_LEVELS.map((t) => ({
    id: t.id,
    label: t.label,
    description: t.description,
    keywords: [t.id],
  }));
}

function accessOptions(): SlashArgOption[] {
  return ACCESS_MODES.map((a) => ({
    id: a.id,
    label: a.label,
    description: a.description,
    keywords: [a.id, a.id === "full" ? "all" : "project"],
  }));
}

function agentOptions(): SlashArgOption[] {
  return AGENT_MODES.map((a) => ({
    id: a.id,
    label: a.label,
    description: a.description,
    keywords: [a.id, a.id === "plan" ? "readonly" : "code"],
  }));
}

function permissionOptions(): SlashArgOption[] {
  return PERMISSION_MODES.map((p) => ({
    id: p.id,
    label: p.label,
    description: p.description,
    keywords: [p.id, p.id === "ask" ? "approve" : "yolo"],
  }));
}

export function slashCommandsForModel(modelId: string): SlashCommandDef[] {
  const allowedThinking = new Set(getModel(modelId).supportedThinking);
  return SLASH_COMMANDS.map((command) => {
    if (command.id === "thinking") {
      const argOptions = thinkingOptions().filter((option) =>
        allowedThinking.has(option.id as ThinkingLevel),
      );
      return {
        ...command,
        argsHint: argOptions.map((option) => option.id).join(" · "),
        argOptions,
      };
    }
    return command;
  });
}

export const SLASH_COMMANDS: SlashCommandDef[] = [
  {
    id: "new",
    name: "new",
    aliases: ["clear"],
    description: "Start a new chat in the current project",
    run: (_args, h) => {
      h.newChat();
      h.notify("New chat", "info");
    },
  },
  {
    id: "model",
    name: "model",
    aliases: ["m"],
    description: "Switch chat model",
    argsHint: "name",
    argOptions: modelOptions(),
    run: (args, h) => {
      const model = getModel(args);
      // getModel falls back to default — only accept known ids
      const known = ALL_MODELS.some((m) => m.id === args);
      if (!known) {
        h.notify(`Unknown model: ${args}`, "error");
        return false;
      }
      if (h.setModel(model.id) === false) return false;
      h.notify(`Model: ${model.label}`, "success");
    },
  },
  {
    id: "thinking",
    name: "thinking",
    aliases: ["think", "t"],
    description: "Set thinking / reasoning level",
    argsHint: "off · low · medium · high",
    argOptions: thinkingOptions(),
    run: (args, h) => {
      const level = THINKING_LEVELS.find((t) => t.id === args);
      if (!level) {
        h.notify(`Unknown thinking level: ${args}`, "error");
        return false;
      }
      const effective = h.setThinking(level.id);
      const effectiveLevel =
        THINKING_LEVELS.find((option) => option.id === effective) ?? level;
      h.notify(`Thinking: ${effectiveLevel.label}`, "success");
    },
  },
  {
    id: "access",
    name: "access",
    aliases: ["a"],
    description: "Set tool filesystem access mode",
    argsHint: "workspace · full",
    argOptions: accessOptions(),
    run: (args, h) => {
      const mode = ACCESS_MODES.find((a) => a.id === args);
      if (!mode) {
        h.notify(`Unknown access mode: ${args}`, "error");
        return false;
      }
      h.setAccessMode(mode.id);
      h.notify(`Access: ${mode.label}`, "success");
    },
  },
  {
    id: "compact",
    name: "compact",
    aliases: ["squash"],
    description: "Fold older turns to free context (~60% target)",
    run: (_args, h) => {
      const result = h.compact();
      if (result === false) return false;
    },
  },
  {
    id: "agent",
    name: "agent",
    aliases: ["mode"],
    description: "Set agent mode (Plan read-only or Build)",
    argsHint: "plan · build",
    argOptions: agentOptions(),
    run: (args, h) => {
      const mode = AGENT_MODES.find((a) => a.id === args);
      if (!mode) {
        h.notify(`Unknown agent mode: ${args}`, "error");
        return false;
      }
      h.setAgentMode(mode.id);
      h.notify(`Agent: ${mode.label}`, "success");
    },
  },
  {
    id: "build",
    name: "build",
    description: "Switch to Build mode (full coding tools)",
    run: (_args, h) => {
      h.setAgentMode("build");
      h.notify("Agent: Build", "success");
    },
  },
  {
    id: "permission",
    name: "permission",
    aliases: ["perm", "ask"],
    description: "Set tool permission mode (Auto or Ask)",
    argsHint: "auto · ask",
    argOptions: permissionOptions(),
    run: (args, h) => {
      const mode = PERMISSION_MODES.find((p) => p.id === args);
      if (!mode) {
        h.notify(`Unknown permission mode: ${args}`, "error");
        return false;
      }
      h.setPermissionMode(mode.id);
      h.notify(`Permission: ${mode.label}`, "success");
    },
  },
  {
    id: "undo",
    name: "undo",
    aliases: ["revert"],
    description: "Undo file changes from the last agent turn",
    run: (_args, h) => {
      const result = h.undoLastTurn();
      if (result === false) return false;
    },
  },
  {
    id: "review",
    name: "review",
    aliases: ["diff"],
    description: "Open the Review changes panel",
    run: (_args, h) => {
      h.openReview();
    },
  },
  {
    id: "theme",
    name: "theme",
    description: "Switch application theme",
    argsHint: THEME_CATALOG.map((theme) => theme.id).join(" · "),
    argsOptional: true,
    argOptions: [
      {
        id: "toggle",
        label: "Toggle",
        description: "Switch between light and dark",
        keywords: ["toggle", "switch"],
      },
      ...THEME_CATALOG.map((theme) => ({
        id: theme.id,
        label: theme.name,
        description: theme.description,
      })),
    ],
    run: (args, h) => {
      const v = (args || "toggle").toLowerCase();
      if (v === "toggle" || v === "") {
        h.toggleTheme();
        h.notify("Theme toggled", "info");
        return;
      }
      if (isThemeMode(v)) {
        h.setTheme(v);
        const selected = THEME_CATALOG.find((theme) => theme.id === v);
        h.notify(`Theme: ${selected?.name ?? v}`, "success");
        return;
      }
      h.notify(`Unknown theme: ${args}`, "error");
      return false;
    },
  },
  {
    id: "help",
    name: "help",
    aliases: ["?"],
    description: "List available slash commands",
    run: (_args, h) => {
      const lines = SLASH_COMMANDS.map((c) => {
        const usage = c.argsHint ? `/${c.name} ${c.argsHint}` : `/${c.name}`;
        return `${usage} — ${c.description}`;
      });
      h.notify(lines.join(" · "), "info");
    },
  },
];
