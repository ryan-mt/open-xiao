import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

export type SelectOption<T extends string = string> = {
  id: T;
  label: string;
};

type Props<T extends string> = {
  value: T;
  options: readonly SelectOption<T>[];
  onChange: (value: T) => void;
  disabled?: boolean;
  /** Accessible name for the trigger. */
  "aria-label"?: string;
  className?: string;
  /** Prefer menu opening downward (settings) vs upward (composer). */
  placement?: "up" | "down";
};

type MenuPos = { top: number; left: number; minWidth: number };

export function Select<T extends string>({
  value,
  options,
  onChange,
  disabled,
  "aria-label": ariaLabel,
  className,
  placement = "down",
}: Props<T>) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [menuPos, setMenuPos] = useState<MenuPos | null>(null);

  const selected = options.find((o) => o.id === value) ?? options[0];
  const label = selected?.label ?? "";

  const placeMenu = () => {
    if (!open) {
      setMenuPos(null);
      return;
    }
    const btn = btnRef.current;
    const menu = menuRef.current;
    if (!btn) return;

    const rect = btn.getBoundingClientRect();
    const gap = 6;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const menuW = Math.max(menu?.offsetWidth ?? 0, rect.width);
    const menuH = menu?.offsetHeight ?? options.length * 36 + 12;

    let top: number;
    if (placement === "up") {
      top = rect.top - menuH - gap;
      if (top < 8) {
        top = Math.min(rect.bottom + gap, vh - menuH - 8);
      }
    } else {
      top = rect.bottom + gap;
      if (top + menuH > vh - 8) {
        top = Math.max(8, rect.top - menuH - gap);
      }
    }
    top = Math.max(8, Math.min(top, vh - menuH - 8));

    // Align right edge to trigger (settings controls sit on the right).
    let left = rect.right - menuW;
    left = Math.min(Math.max(8, left), vw - menuW - 8);

    setMenuPos({ top, left, minWidth: rect.width });
  };

  useLayoutEffect(() => {
    if (!open) {
      setMenuPos(null);
      return;
    }
    placeMenu();
    const id = requestAnimationFrame(() => placeMenu());
    return () => cancelAnimationFrame(id);
  }, [open, value, options, placement]);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      const t = e.target as Node;
      if (rootRef.current?.contains(t)) return;
      if (menuRef.current?.contains(t)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        setOpen(false);
      }
    };
    const onReposition = () => placeMenu();
    document.addEventListener("mousedown", onDoc);
    // Capture so Escape closes menu before parent dialog handlers.
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("resize", onReposition);
    window.addEventListener("scroll", onReposition, true);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("resize", onReposition);
      window.removeEventListener("scroll", onReposition, true);
    };
  }, [open]);

  const menu =
    open && typeof document !== "undefined"
      ? createPortal(
          <div
            ref={menuRef}
            className="cselect__menu"
            role="listbox"
            style={
              menuPos
                ? {
                    top: menuPos.top,
                    left: menuPos.left,
                    minWidth: menuPos.minWidth,
                    visibility: "visible",
                  }
                : { visibility: "hidden", top: 0, left: 0 }
            }
          >
            {options.map((o) => {
              const active = o.id === value;
              return (
                <button
                  key={o.id}
                  type="button"
                  role="option"
                  aria-selected={active}
                  className={`cselect__item${active ? " is-active" : ""}`}
                  onClick={() => {
                    onChange(o.id);
                    setOpen(false);
                  }}
                >
                  <span className="cselect__item-label">{o.label}</span>
                  {active ? <CheckIcon /> : null}
                </button>
              );
            })}
          </div>,
          document.body,
        )
      : null;

  return (
    <div
      className={`cselect${open ? " is-open" : ""}${className ? ` ${className}` : ""}`}
      ref={rootRef}
    >
      <button
        ref={btnRef}
        type="button"
        className={`cselect__trigger${open ? " is-open" : ""}`}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="cselect__value">{label}</span>
        <ChevronIcon />
      </button>
      {menu}
    </div>
  );
}

function ChevronIcon() {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 12 12"
      fill="none"
      aria-hidden
      className="cselect__chev"
    >
      <path
        d="M3 4.5 6 7.5 9 4.5"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 14 14"
      fill="none"
      aria-hidden
      className="cselect__check"
    >
      <path
        d="M3 7.2 5.8 10 11 4"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
