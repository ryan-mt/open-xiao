import {
  KEYBINDING_COMMANDS,
  isDefaultKeybinding,
  keybindingDefaultFor,
  keybindingConflictLabels,
  type KeybindingRule,
  type KeybindingWhen,
} from "../../keybindings";

export type KeybindingPageRow = {
  definition: (typeof KEYBINDING_COMMANDS)[number];
  rule: KeybindingRule;
  defaultRule: KeybindingRule | null;
  conflicts: ReadonlyArray<string>;
  isCustom: boolean;
};

export function buildKeybindingRows(
  keybindings: ReadonlyArray<KeybindingRule>,
  query: string,
): ReadonlyArray<KeybindingPageRow> {
  const needle = query.trim().toLowerCase();
  return KEYBINDING_COMMANDS.map((definition) => {
    const rule =
      keybindings.find((binding) => binding.command === definition.command) ??
      keybindingDefaultFor(definition.command) ?? {
        command: definition.command,
        key: "",
      };
    const defaultRule = keybindingDefaultFor(definition.command);
    return {
      definition,
      rule,
      defaultRule,
      conflicts: keybindingConflictLabels(
        definition.command,
        rule.key,
        rule.when,
        keybindings,
      ),
      isCustom: !isDefaultKeybinding(rule),
    } satisfies KeybindingPageRow;
  }).filter((row) => {
    if (!needle) return true;
    return [
      row.definition.label,
      row.definition.category,
      row.definition.command,
      row.rule.key,
      row.rule.when ?? "always",
      row.isCustom ? "custom" : "default",
    ].some((value) => value.toLowerCase().includes(needle));
  });
}

export const KEYBINDING_WHEN_OPTIONS: ReadonlyArray<{
  value: "" | KeybindingWhen;
  label: string;
}> = [
  { value: "", label: "Always" },
  { value: "!terminalFocus", label: "Not in terminal" },
  { value: "terminalFocus", label: "Terminal focused" },
  { value: "previewOpen", label: "Preview open" },
  { value: "modelPickerOpen", label: "Model picker open" },
];
