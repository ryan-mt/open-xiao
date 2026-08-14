import { useEffect, useRef } from "react";
import {
  formatShortcutLabel,
  keybindingFromKeyboardEvent,
} from "../../keybindings";
import type { KeybindingPageRow } from "./page.logic";

type Props = {
  row: KeybindingPageRow;
  recording: boolean;
  onStart: () => void;
  onCapture: (value: string) => void;
  onCancel: () => void;
};

export function KeybindingCapture({
  row,
  recording,
  onStart,
  onCapture,
  onCancel,
}: Props) {
  const ref = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (recording) ref.current?.focus();
  }, [recording]);

  if (recording) {
    return (
      <input
        ref={ref}
        data-keybinding-capture=""
        className="keybindings-page__capture-input"
        aria-label={`Press a shortcut for ${row.definition.label}`}
        value=""
        readOnly
        placeholder="Press shortcut"
        onBlur={onCancel}
        onKeyDown={(event) => {
          if (event.key === "Tab") return;
          event.preventDefault();
          event.stopPropagation();
          if (event.key === "Escape") {
            onCancel();
            return;
          }
          const value = keybindingFromKeyboardEvent(event.nativeEvent);
          if (value) onCapture(value);
        }}
      />
    );
  }

  return (
    <button
      type="button"
      className="keybindings-page__capture"
      aria-label={`Edit shortcut for ${row.definition.label}`}
      onClick={onStart}
    >
      <KeyPill value={row.rule.key} />
      <span className="keybindings-page__edit-label">Edit</span>
    </button>
  );
}

function KeyPill({ value }: { value: string }) {
  if (!value) {
    return <span className="keybindings-page__unassigned">Unassigned</span>;
  }
  const label = formatShortcutLabel(value);
  const parts = label.includes("+")
    ? label.split("+")
    : (label.match(/[⌘⌃⌥⇧]|[^⌘⌃⌥⇧]+/g) ?? [label]);
  return (
    <span className="keybindings-page__pill-group" aria-hidden>
      {parts.map((part, index) => (
        <kbd className="keybindings-page__pill" key={`${part}-${index}`}>
          {part}
        </kbd>
      ))}
    </span>
  );
}
