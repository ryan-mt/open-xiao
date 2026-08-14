import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthModal } from "./AuthModal";

afterEach(cleanup);

describe("AuthModal", () => {
  it("owns Escape and restores focus when it closes", () => {
    const returnTarget = document.createElement("button");
    document.body.append(returnTarget);
    returnTarget.focus();
    const returnFocusRef = { current: returnTarget };
    const onCancel = vi.fn();
    const { rerender } = render(
      <AuthModal
        open
        loggingIn
        provider="grok"
        onCancel={onCancel}
        returnFocusRef={returnFocusRef}
      />,
    );

    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Dismiss" }));
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onCancel).toHaveBeenCalledOnce();

    rerender(
      <AuthModal
        open={false}
        loggingIn={false}
        provider="grok"
        onCancel={onCancel}
        returnFocusRef={returnFocusRef}
      />,
    );
    expect(document.activeElement).toBe(returnTarget);
    expect(returnFocusRef.current).toBeNull();
    returnTarget.remove();
  });

  it("keeps tab and programmatic focus inside the dialog", () => {
    render(
      <AuthModal
        open
        loggingIn
        provider="openai"
        device={{
          userCode: "CODE",
          verificationUri: "https://example.com/device",
          expiresInSeconds: 600,
          intervalSeconds: 5,
        }}
        onCancel={vi.fn()}
      />,
    );
    const first = screen.getByRole("button", { name: "Copy" });
    const last = screen.getByRole("button", { name: "Dismiss" });
    last.focus();
    fireEvent.keyDown(window, { key: "Tab" });
    expect(document.activeElement).toBe(first);

    const outside = document.createElement("button");
    document.body.append(outside);
    outside.focus();
    expect(document.activeElement).toBe(first);
    outside.remove();
  });
});
