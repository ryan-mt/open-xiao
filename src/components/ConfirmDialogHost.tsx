import {
  useEffect,
  useId,
  useRef,
  useSyncExternalStore,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { createPortal } from "react-dom";
import {
  readConfirmDialogState,
  respondToConfirmDialog,
  subscribeConfirmDialog,
} from "../confirmDialog";

type ConfirmationCopy = {
  title: string;
  description: string | null;
};

export function resolveConfirmDialogCopy(message: string): ConfirmationCopy {
  const normalized = message.trim();
  const lines = normalized.split("\n");
  const questionIndex = lines.findIndex((line) => line.trim().endsWith("?"));
  if (questionIndex >= 0) {
    const title = lines[questionIndex]?.trim() || "Confirm action";
    const description = lines
      .filter((_, index) => index !== questionIndex)
      .join("\n")
      .trim();
    return { title, description: description || null };
  }
  return {
    title: "Confirm action",
    description: normalized || "This action requires your confirmation.",
  };
}

export function ConfirmDialogHost() {
  const state = useSyncExternalStore(
    subscribeConfirmDialog,
    readConfirmDialogState,
    readConfirmDialogState,
  );
  const dialogRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const descriptionId = useId();

  useEffect(() => {
    if (state.status !== "confirming") return;
    const previouslyFocused =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    const dialog = dialogRef.current;
    const focusFrame = window.requestAnimationFrame(() => {
      dialog?.querySelector<HTMLButtonElement>("[data-confirm-cancel]")?.focus();
    });
    const onFocus = (event: FocusEvent) => {
      if (event.target instanceof Node && dialog && !dialog.contains(event.target)) {
        dialog.querySelector<HTMLButtonElement>("[data-confirm-cancel]")?.focus();
      }
    };
    document.addEventListener("focusin", onFocus, true);
    return () => {
      window.cancelAnimationFrame(focusFrame);
      document.removeEventListener("focusin", onFocus, true);
      if (previouslyFocused?.isConnected) previouslyFocused.focus();
    };
  }, [state]);

  if (state.status !== "confirming" || typeof document === "undefined") {
    return null;
  }
  const copy = resolveConfirmDialogCopy(state.message);
  const onDialogKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    event.stopPropagation();
    if (event.key === "Escape") {
      event.preventDefault();
      respondToConfirmDialog(false);
      return;
    }
    if (event.key !== "Tab") return;
    const dialog = dialogRef.current;
    if (!dialog) return;
    const buttons = [...dialog.querySelectorAll<HTMLButtonElement>("button")];
    const first = buttons[0];
    const last = buttons[buttons.length - 1];
    if (!first || !last) return;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  return createPortal(
    <div
      className="confirm-dialog__backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) respondToConfirmDialog(false);
      }}
    >
      <div
        ref={dialogRef}
        className="confirm-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={copy.description ? descriptionId : undefined}
        onKeyDown={onDialogKeyDown}
      >
        <div className="confirm-dialog__copy">
          <h2 id={titleId}>{copy.title}</h2>
          {copy.description ? (
            <p id={descriptionId}>{copy.description}</p>
          ) : null}
        </div>
        <div className="confirm-dialog__actions">
          <button
            type="button"
            className="confirm-dialog__button"
            data-confirm-cancel
            onClick={() => respondToConfirmDialog(false)}
          >
            Cancel
          </button>
          <button
            type="button"
            className={`confirm-dialog__button confirm-dialog__button--confirm${state.variant === "destructive" ? " is-destructive" : ""}`}
            onClick={() => respondToConfirmDialog(true)}
          >
            Confirm
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
