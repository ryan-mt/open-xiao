import assert from "node:assert/strict";
import test from "node:test";
import {
  clampTerminalHeight,
  TERMINAL_HEIGHT_DEFAULT,
  TERMINAL_HEIGHT_MAX_VH,
  TERMINAL_HEIGHT_MIN,
} from "../../src/terminalHeight.ts";

test("clampTerminalHeight enforces compact terminal bounds", () => {
  assert.equal(clampTerminalHeight(300, 900), 300);
  assert.equal(clampTerminalHeight(TERMINAL_HEIGHT_MIN - 50, 900), TERMINAL_HEIGHT_MIN);
  assert.equal(clampTerminalHeight(2000, 900), Math.round(900 * TERMINAL_HEIGHT_MAX_VH));
});

test("clampTerminalHeight falls back to the default for invalid input", () => {
  assert.equal(clampTerminalHeight(Number.NaN, 900), TERMINAL_HEIGHT_DEFAULT);
  assert.equal(clampTerminalHeight(Number.POSITIVE_INFINITY, 900), TERMINAL_HEIGHT_DEFAULT);
});

test("clampTerminalHeight never inverts on tiny viewports", () => {
  // Max floor is the minimum itself, so min <= result always holds.
  assert.equal(clampTerminalHeight(5000, 100), TERMINAL_HEIGHT_MIN);
});
