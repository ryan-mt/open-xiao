import { ChevronDown, Ellipsis, TriangleAlert } from "lucide-react";
import {
  type KeybindingCommand,
  type KeybindingWhen,
} from "../../keybindings";
import { KeybindingCapture } from "./KeybindingCapture";
import {
  KEYBINDING_WHEN_OPTIONS,
  type KeybindingPageRow,
} from "./page.logic";

type Props = {
  row: KeybindingPageRow;
  recording: KeybindingCommand | null;
  onStartRecording: (command: KeybindingCommand) => void;
  onStopRecording: () => void;
  onChange: (
    command: KeybindingCommand,
    key: string,
    when?: KeybindingWhen,
  ) => void;
};

export function KeybindingRow({
  row,
  recording,
  onStartRecording,
  onStopRecording,
  onChange,
}: Props) {
  const isRecording = recording === row.definition.command;
  const reset = () => {
    onChange(
      row.definition.command,
      row.defaultRule?.key ?? "",
      row.defaultRule?.when,
    );
  };

  return (
    <div className="keybindings-page__row" role="row">
      <div className="keybindings-page__command" role="cell">
        <span title={row.definition.command}>{row.definition.label}</span>
      </div>
      <div className="keybindings-page__key" role="cell">
        <KeybindingCapture
          row={row}
          recording={isRecording}
          onStart={() => onStartRecording(row.definition.command)}
          onCapture={(key) => {
            onChange(row.definition.command, key, row.rule.when);
            onStopRecording();
          }}
          onCancel={onStopRecording}
        />
      </div>
      <WhenPicker
        label={row.definition.label}
        value={row.rule.when}
        onChange={(when) =>
          onChange(row.definition.command, row.rule.key, when)
        }
      />
      <div className="keybindings-page__status" role="cell">
        <ConflictWarning conflicts={row.conflicts} />
        {row.isCustom ? (
          <details
            className="keybindings-page__actions"
            name="keybinding-actions"
            onKeyDown={(event) => {
              if (event.key !== "Escape") return;
              event.preventDefault();
              event.stopPropagation();
              event.currentTarget.removeAttribute("open");
            }}
          >
            <summary
              className="keybindings-page__actions-trigger"
              aria-label={`Actions for ${row.definition.label}`}
            >
              <Ellipsis aria-hidden />
            </summary>
            <div role="menu" className="keybindings-page__actions-menu">
              <button
                type="button"
                role="menuitem"
                onClick={(event) => {
                  event.currentTarget
                    .closest("details")
                    ?.removeAttribute("open");
                  reset();
                }}
              >
                Reset to default
              </button>
              <button
                type="button"
                role="menuitem"
                className="is-destructive"
                onClick={(event) => {
                  event.currentTarget
                    .closest("details")
                    ?.removeAttribute("open");
                  onChange(row.definition.command, "", row.rule.when);
                }}
              >
                Remove
              </button>
            </div>
          </details>
        ) : null}
      </div>
    </div>
  );
}

function WhenPicker({
  label,
  value,
  onChange,
}: {
  label: string;
  value?: KeybindingWhen;
  onChange: (value?: KeybindingWhen) => void;
}) {
  const display =
    KEYBINDING_WHEN_OPTIONS.find((option) => option.value === (value ?? ""))
      ?.label ?? "Always";
  return (
    <div className="keybindings-page__when" role="cell">
      <details
        className="keybindings-page__when-picker"
        name="keybinding-when"
        onKeyDown={(event) => {
          if (event.key !== "Escape") return;
          event.preventDefault();
          event.stopPropagation();
          event.currentTarget.removeAttribute("open");
        }}
      >
        <summary aria-label={`Edit when clause for ${label}`}>
          <span>{display}</span>
          <ChevronDown aria-hidden />
        </summary>
        <div className="keybindings-page__when-menu" role="menu">
          {KEYBINDING_WHEN_OPTIONS.map((option) => (
            <button
              key={option.value}
              type="button"
              role="menuitemradio"
              aria-checked={(value ?? "") === option.value}
              onClick={(event) => {
                event.currentTarget
                  .closest("details")
                  ?.removeAttribute("open");
                onChange(option.value || undefined);
              }}
            >
              {option.label}
            </button>
          ))}
        </div>
      </details>
    </div>
  );
}

function ConflictWarning({ conflicts }: { conflicts: ReadonlyArray<string> }) {
  if (conflicts.length === 0) return null;
  const description = `Conflicts with ${conflicts.join(", ")}`;
  return (
    <span
      className="keybindings-page__warning"
      title={`${description}. The later matching binding wins.`}
      aria-label={`${description}. The later matching binding wins.`}
      role="img"
    >
      <TriangleAlert aria-hidden />
    </span>
  );
}
