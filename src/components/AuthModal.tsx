import { useEffect, useRef, useState } from "react";
import type { DeviceCodeEvent } from "../auth";

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

type CommonProps = {
  open: boolean;
  loggingIn: boolean;
  error?: string | null;
  onCancel?: () => void;
  returnFocusRef?: { current: HTMLElement | null };
};

export type AuthModalProps = CommonProps & {
  provider: "grok" | "openai";
  device?: DeviceCodeEvent | null;
};

export function AuthModal(props: AuthModalProps) {
  const { open, loggingIn, error, onCancel, provider, returnFocusRef } = props;
  const [copied, setCopied] = useState(false);
  const cardRef = useRef<HTMLDivElement>(null);
  const cancelRef = useRef(onCancel);
  cancelRef.current = onCancel;

  useEffect(() => {
    if (!open) {
      setCopied(false);
      return;
    }
    const previouslyFocused =
      returnFocusRef?.current ??
      (document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null);
    const card = cardRef.current;
    const focusable = () =>
      card
        ? Array.from(card.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
            (element) => !element.hidden,
          )
        : [];

    (focusable()[0] ?? card)?.focus();

    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && cancelRef.current) {
        event.preventDefault();
        event.stopImmediatePropagation();
        cancelRef.current();
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
      if (returnFocusRef) returnFocusRef.current = null;
    };
  }, [open]);

  if (!open) return null;

  const isGrok = provider === "grok";
  const title = isGrok ? "Sign in with SuperGrok" : "Sign in with OpenAI";
  const device = props.device;

  return (
    <div
      className="auth-modal"
      role="dialog"
      aria-modal="true"
      aria-label={title}
    >
      <div ref={cardRef} className="auth-modal__card" tabIndex={-1}>
        <h2 className="auth-modal__title">{title}</h2>
        <p className="auth-modal__desc">
          {isGrok
            ? "Use your xAI / Grok subscription (SuperGrok or X Premium). A browser window will open - approve access, then return here."
            : "Use your ChatGPT account (Plus, Pro, or Business). A browser window will open - approve access, then return here."}
        </p>

        {device ? (
          <div className="auth-modal__code-box">
            <div className="auth-modal__code-label">Your code</div>
            <div className="auth-modal__code">{device.userCode}</div>
            <button
              type="button"
              className="auth-modal__copy"
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(device.userCode);
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1200);
                } catch {
                  /* ignore */
                }
              }}
            >
              {copied ? "Copied" : "Copy"}
            </button>
            <p className="auth-modal__link-text">
              Browser should open automatically. If not, visit{" "}
              <a
                href={device.verificationUri}
                target="_blank"
                rel="noreferrer"
              >
                {device.verificationUri}
              </a>{" "}
              and enter the code above.
            </p>
            <p className="auth-modal__hint">
              Waiting for approval... expires in ~
              {Math.round(device.expiresInSeconds / 60)} min
            </p>
          </div>
        ) : loggingIn ? (
          <p className="auth-modal__hint">Starting device login...</p>
        ) : null}

        {error ? <p className="auth-modal__error">{error}</p> : null}

        {onCancel ? (
          <button type="button" className="auth-modal__cancel" onClick={onCancel}>
            Dismiss
          </button>
        ) : null}
      </div>
    </div>
  );
}
