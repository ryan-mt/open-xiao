import assert from "node:assert/strict";
import test from "node:test";
import {
  advanceTerminalSequence,
  forgetTerminalSessionForCwd,
  liveTerminalSessionIdForCwd,
  newTerminalSessionIdForCwd,
  terminalSessionIdForCwd,
} from "../../src/terminalId.ts";

test("terminalSessionIdForCwd is stable and path-normalized", () => {
  const a = terminalSessionIdForCwd(String.raw`C:\Users\me\proj`);
  const b = terminalSessionIdForCwd("c:/Users/me/proj");
  assert.equal(a, b);
  assert.match(a, /^term-[0-9a-f]{8}$/);
});

test("newTerminalSessionIdForCwd creates a distinct valid incarnation", () => {
  const cwd = String.raw`C:\Users\me\proj`;
  const first = newTerminalSessionIdForCwd(cwd);
  const second = newTerminalSessionIdForCwd(cwd);

  assert.notEqual(first, second);
  assert.match(first, /^term-[0-9a-f]{8}-[a-z0-9]+-[a-z0-9]+$/);
  assert.ok(first.length <= 64);
});

test("advanceTerminalSequence drops duplicates", () => {
  assert.equal(advanceTerminalSequence(5, 5), null);
  assert.equal(advanceTerminalSequence(5, 4), null);
  assert.equal(advanceTerminalSequence(5, 6), 6);
  assert.equal(advanceTerminalSequence(5, 8), 8);
});

test("liveTerminalSessionIdForCwd is stable until forgotten", () => {
  const cwd = String.raw`C:\Users\me\live-proj`;
  const first = liveTerminalSessionIdForCwd(cwd);
  const second = liveTerminalSessionIdForCwd(cwd);
  assert.equal(first, second);
  assert.match(first, /^term-[0-9a-f]{8}-[a-z0-9]+-[a-z0-9]+$/);
  assert.ok(first.length <= 64);

  forgetTerminalSessionForCwd(cwd);
  const third = liveTerminalSessionIdForCwd(cwd);
  assert.notEqual(third, first);
});

test("liveTerminalSessionIdForCwd treats path spellings as one workspace", () => {
  const a = liveTerminalSessionIdForCwd(String.raw`C:\Users\me\shared`);
  const b = liveTerminalSessionIdForCwd("c:/users/me/shared");
  assert.equal(a, b);
});

test("liveTerminalSessionIdForCwd keeps workspaces separate", () => {
  const a = liveTerminalSessionIdForCwd(String.raw`C:\Users\me\proj-one`);
  const b = liveTerminalSessionIdForCwd(String.raw`C:\Users\me\proj-two`);
  assert.notEqual(a, b);
});
