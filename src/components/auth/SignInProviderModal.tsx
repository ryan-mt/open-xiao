import { useEffect, useRef } from "react";
import { GrokLogo } from "../GrokLogo";
import { OpenAILogo } from "../OpenAILogo";

const FOCUSABLE =
  'button:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])';

export type SignInProvider = "grok" | "openai";

type Props = {
  open: boolean;
  grokBusy?: boolean;
  openaiBusy?: boolean;
  grokSignedIn?: boolean;
  openaiSignedIn?: boolean;
  onClose: () => void;
  onSelect: (provider: SignInProvider) => void;
};

export function SignInProviderModal({
  open,
  grokBusy = false,
  openaiBusy = false,
  grokSignedIn = false,
  openaiSignedIn = false,
  onClose,
  onSelect,
}: Props) {
  const cardRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    if (!open) return;
    const previouslyFocused =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    const card = cardRef.current;
    const focusable = () =>
      card
        ? Array.from(card.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
            (element) => !element.hidden,
          )
        : [];

    (focusable()[0] ?? card)?.focus();

    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopImmediatePropagation();
        closeRef.current();
        return;
      }
      if (event.key !== "Tab") return;
      const elements = focusable();
      if (elements.length === 0) {
        event.preventDefault();
        card?.focus();
        return;
      }
      const first = elements[0];
      const last = elements[elements.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    const onFocus = (event: FocusEvent) => {
      if (card && event.target instanceof Node && !card.contains(event.target)) {
        (focusable()[0] ?? card).focus();
      }
    };

    window.addEventListener("keydown", onKey, true);
    document.addEventListener("focusin", onFocus, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      document.removeEventListener("focusin", onFocus, true);
      if (previouslyFocused?.isConnected) previouslyFocused.focus();
    };
  }, [open]);

  if (!open) return null;

  const grokDisabled = grokBusy || grokSignedIn;
  const openaiDisabled = openaiBusy || openaiSignedIn;

  return (
    <div
      className="auth-modal auth-provider-picker"
      role="dialog"
      aria-modal="true"
      aria-label="Sign in"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) closeRef.current();
      }}
    >
      <div
        ref={cardRef}
        className="auth-modal__card auth-provider-picker__card"
        tabIndex={-1}
      >
        <h2 className="auth-modal__title">Sign in</h2>
        <p className="auth-modal__desc">
          Choose the provider you want to use with Open Xiao.
        </p>
        <div className="auth-provider-picker__options">
          <button
            type="button"
            className="auth-provider-picker__option"
            disabled={grokDisabled}
            onClick={() => onSelect("grok")}
          >
            <span className="auth-provider-picker__logo auth-provider-picker__logo--grok">
              <GrokLogo size={24} title="Grok" />
            </span>
            <span className="auth-provider-picker__copy">
              <strong>Grok</strong>
              <small>SuperGrok or X Premium</small>
            </span>
            <span className="auth-provider-picker__status">
              {grokSignedIn ? "Connected" : grokBusy ? "Signing in…" : "Continue"}
            </span>
          </button>
          <button
            type="button"
            className="auth-provider-picker__option"
            disabled={openaiDisabled}
            onClick={() => onSelect("openai")}
          >
            <span className="auth-provider-picker__logo auth-provider-picker__logo--openai">
              <OpenAILogo size={24} />
            </span>
            <span className="auth-provider-picker__copy">
              <strong>OpenAI</strong>
              <small>ChatGPT Plus, Pro, or Business</small>
            </span>
            <span className="auth-provider-picker__status">
              {openaiSignedIn
                ? "Connected"
                : openaiBusy
                  ? "Signing in…"
                  : "Continue"}
            </span>
          </button>
        </div>
        <button
          type="button"
          className="auth-modal__cancel"
          onClick={() => closeRef.current()}
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
