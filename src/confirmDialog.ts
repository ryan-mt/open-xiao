export type ConfirmDialogVariant = "default" | "destructive";

export type ConfirmDialogState =
  | { readonly status: "idle" }
  | {
      readonly status: "confirming";
      readonly message: string;
      readonly variant: ConfirmDialogVariant;
    };

type PendingConfirmation = {
  readonly message: string;
  readonly variant: ConfirmDialogVariant;
  readonly resolve: (confirmed: boolean) => void;
};

const idleState: ConfirmDialogState = { status: "idle" };
let state: ConfirmDialogState = idleState;
let active: PendingConfirmation | null = null;
let queue: PendingConfirmation[] = [];
const listeners = new Set<() => void>();

function publish(next: ConfirmDialogState): void {
  state = next;
  for (const listener of listeners) listener();
}

function showNext(): void {
  active = queue.shift() ?? null;
  publish(
    active
      ? {
          status: "confirming",
          message: active.message,
          variant: active.variant,
        }
      : idleState,
  );
}

export function readConfirmDialogState(): ConfirmDialogState {
  return state;
}

export function subscribeConfirmDialog(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function requestConfirmDialog(
  message: string,
  options?: { readonly variant?: ConfirmDialogVariant },
): Promise<boolean> {
  return new Promise((resolve) => {
    const pending: PendingConfirmation = {
      message,
      variant: options?.variant ?? "default",
      resolve,
    };
    if (active) {
      queue.push(pending);
      return;
    }
    active = pending;
    publish({
      status: "confirming",
      message: pending.message,
      variant: pending.variant,
    });
  });
}

export function respondToConfirmDialog(confirmed: boolean): void {
  if (!active || state.status !== "confirming") return;
  const completed = active;
  active = null;
  completed.resolve(confirmed);
  showNext();
}

export function resetConfirmDialogForTests(): void {
  active?.resolve(false);
  for (const pending of queue) pending.resolve(false);
  active = null;
  queue = [];
  publish(idleState);
}
