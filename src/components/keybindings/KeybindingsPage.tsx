import { FileJson, Info, Plus, Search, X } from "lucide-react";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import {
  keybindingFromKeyboardEvent,
  updateKeybinding,
  type KeybindingCommand,
  type KeybindingRule,
  type KeybindingWhen,
} from "../../keybindings";
import { isTauri } from "../../lib/isTauri";
import { KeybindingRow } from "./KeybindingRow";
import {
  buildKeybindingRows,
  KEYBINDING_WHEN_OPTIONS,
  type KeybindingPageRow,
} from "./page.logic";

type Props = {
  keybindings: ReadonlyArray<KeybindingRule>;
  onChange: (keybindings: KeybindingRule[]) => void;
};

export function KeybindingsPage({ keybindings, onChange }: Props) {
  const [query, setQuery] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [recording, setRecording] = useState<KeybindingCommand | null>(null);
  const [adding, setAdding] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const rows = useMemo(
    () => buildKeybindingRows(keybindings, query),
    [keybindings, query],
  );
  const allRows = useMemo(
    () => buildKeybindingRows(keybindings, ""),
    [keybindings],
  );
  const availableRows = useMemo(
    () => allRows.filter((row) => !row.rule.key),
    [allRows],
  );

  const update = (
    command: KeybindingCommand,
    key: string,
    when?: KeybindingWhen,
  ) => {
    onChange(updateKeybinding(keybindings, command, key, when));
  };

  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (
        !(event.metaKey || event.ctrlKey) ||
        event.altKey ||
        event.key.toLowerCase() !== "f"
      ) {
        return;
      }
      const target = event.target;
      if (
        target !== searchRef.current &&
        target instanceof HTMLElement &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.isContentEditable)
      ) {
        return;
      }
      event.preventDefault();
      setSearchOpen(true);
      requestAnimationFrame(() => {
        searchRef.current?.focus();
        searchRef.current?.select();
      });
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const count = rows.length + (adding ? 1 : 0);

  return (
    <div className="keybindings-page">
      <section
        className="keybindings-page__section"
        aria-labelledby="keybindings-title"
      >
        <div className="keybindings-page__heading">
          <h2 id="keybindings-title">Keybindings</h2>
          <div className="keybindings-page__heading-actions">
            {searchOpen ? (
              <label className="keybindings-page__search">
                <Search aria-hidden />
                <span className="sr-only">Search keybindings</span>
                <input
                  ref={searchRef}
                  autoFocus
                  value={query}
                  onChange={(event) => setQuery(event.currentTarget.value)}
                  onBlur={() => {
                    if (!query) setSearchOpen(false);
                  }}
                  onKeyDown={(event) => {
                    if (event.key !== "Escape") return;
                    event.preventDefault();
                    event.stopPropagation();
                    setQuery("");
                    setSearchOpen(false);
                  }}
                  placeholder="Search keybindings"
                  aria-label="Search keybindings"
                />
              </label>
            ) : (
              <span className="keybindings-page__count">
                {count} {count === 1 ? "binding" : "bindings"}
              </span>
            )}
            {!searchOpen ? (
              <HeaderIconButton
                label="Search keybindings"
                onClick={() => setSearchOpen(true)}
              >
                <Search aria-hidden />
              </HeaderIconButton>
            ) : null}
            <HeaderIconButton
              label="Add keybinding"
              disabled={availableRows.length === 0 || adding}
              onClick={() => setAdding(true)}
            >
              <Plus aria-hidden />
            </HeaderIconButton>
            <HeaderIconButton
              label="Keybindings are stored in app settings"
              disabled
            >
              <FileJson aria-hidden />
            </HeaderIconButton>
          </div>
        </div>

        {!isTauri() ? (
          <div className="keybindings-page__browser-note">
            <Info aria-hidden />
            <p>
              Some shortcuts may be claimed by the browser before Open Xiao
              sees them. Use the desktop app for better keybinding support.
            </p>
          </div>
        ) : null}

        <div
          className="keybindings-page__table"
          role="table"
          aria-label="Open Xiao keybindings"
        >
          <div className="keybindings-page__header" role="row">
            <span role="columnheader">Command</span>
            <span role="columnheader">Keybinding</span>
            <span role="columnheader">When</span>
            <span role="columnheader">Status</span>
          </div>
          {adding ? (
            <NewKeybindingRow
              options={availableRows}
              onSave={(command, key, when) => {
                update(command, key, when);
                setAdding(false);
              }}
              onCancel={() => setAdding(false)}
            />
          ) : null}
          {rows.map((row) => (
            <KeybindingRow
              key={row.definition.command}
              row={row}
              recording={recording}
              onStartRecording={setRecording}
              onStopRecording={() => setRecording(null)}
              onChange={update}
            />
          ))}
          {rows.length === 0 && !adding ? (
            <p className="keybindings-page__empty">
              No keybindings match your search.
            </p>
          ) : null}
        </div>
      </section>
    </div>
  );
}

function HeaderIconButton({
  label,
  disabled = false,
  onClick,
  children,
}: {
  label: string;
  disabled?: boolean;
  onClick?: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      className="keybindings-page__header-action"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

function NewKeybindingRow({
  options,
  onSave,
  onCancel,
}: {
  options: ReadonlyArray<KeybindingPageRow>;
  onSave: (
    command: KeybindingCommand,
    key: string,
    when?: KeybindingWhen,
  ) => void;
  onCancel: () => void;
}) {
  const [command, setCommand] = useState<KeybindingCommand | "">("");
  const [key, setKey] = useState("");
  const [when, setWhen] = useState<KeybindingWhen | "">("");
  const [recording, setRecording] = useState(false);

  const capture = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Tab") return;
    event.preventDefault();
    event.stopPropagation();
    if (event.key === "Escape") {
      setRecording(false);
      setKey("");
      return;
    }
    const next = keybindingFromKeyboardEvent(event.nativeEvent);
    if (!next) return;
    setKey(next);
    setRecording(false);
  };

  return (
    <div className="keybindings-page__row is-new" role="row">
      <div className="keybindings-page__command" role="cell">
        <select
          value={command}
          aria-label="Command for new keybinding"
          onChange={(event) =>
            setCommand(event.currentTarget.value as KeybindingCommand)
          }
        >
          <option value="">Command</option>
          {options.map((row) => (
            <option
              key={row.definition.command}
              value={row.definition.command}
            >
              {row.definition.label}
            </option>
          ))}
        </select>
      </div>
      <div className="keybindings-page__key" role="cell">
        <input
          data-keybinding-capture=""
          value={recording ? "" : key}
          placeholder={recording ? "Press shortcut" : "Unassigned"}
          aria-label="Keybinding for new command"
          onFocus={() => setRecording(true)}
          onBlur={() => setRecording(false)}
          onChange={(event) => setKey(event.currentTarget.value)}
          onKeyDown={capture}
        />
        <button
          type="button"
          className="keybindings-page__save"
          disabled={!command || !key}
          onClick={() => {
            if (command && key) onSave(command, key, when || undefined);
          }}
        >
          Save
        </button>
      </div>
      <label className="keybindings-page__when" role="cell">
        <span className="sr-only">When for new keybinding</span>
        <select
          value={when}
          aria-label="When for new keybinding"
          onChange={(event) =>
            setWhen(event.currentTarget.value as KeybindingWhen | "")
          }
        >
          {KEYBINDING_WHEN_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </label>
      <div className="keybindings-page__status" role="cell">
        <button
          type="button"
          className="keybindings-page__actions-trigger"
          aria-label="Cancel new keybinding"
          onClick={onCancel}
        >
          <X aria-hidden />
        </button>
      </div>
    </div>
  );
}
