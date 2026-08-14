import assert from "node:assert/strict";
import test from "node:test";

import {
  clearStreamErrorDismissal,
  dismissStreamError,
  visibleStreamError,
} from "../../src/streamErrorDismissal.ts";

const aborted = {
  category: "connectivity",
  title: "Reply interrupted",
  message: "The provider connection ended early.",
  retryable: true,
  action: null,
};

test("stream error dismissal is scoped to the thread and exact error", () => {
  let dismissals = new Map();
  dismissals = dismissStreamError(dismissals, "thread-a", aborted);

  assert.equal(visibleStreamError(dismissals, "thread-a", aborted), null);
  assert.equal(visibleStreamError(dismissals, "thread-b", aborted), aborted);

  const replacement = { ...aborted, message: "The provider process crashed." };
  assert.equal(
    visibleStreamError(dismissals, "thread-a", replacement),
    replacement,
  );

  const settingsAction = { ...aborted, retryable: false, action: "settings" };
  assert.equal(
    visibleStreamError(dismissals, "thread-a", settingsAction),
    settingsAction,
  );
});

test("starting a new turn clears the prior dismissal", () => {
  let dismissals = dismissStreamError(new Map(), "thread-a", aborted);
  dismissals = clearStreamErrorDismissal(dismissals, "thread-a");

  assert.equal(visibleStreamError(dismissals, "thread-a", aborted), aborted);
  assert.equal(visibleStreamError(dismissals, "thread-a", null), null);
});
