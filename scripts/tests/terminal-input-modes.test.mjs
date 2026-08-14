import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import {
  DISABLE_TERMINAL_INPUT_MODES,
  RESET_STALE_TERMINAL_INPUT_MODES,
  appendTerminalOutputTail,
  shouldResetTerminalInputModes,
} from "../../src/terminalInputModes.ts";

const require = createRequire(import.meta.url);
const { Terminal } = require("@xterm/xterm");

function write(term, data) {
  return new Promise((resolve) => term.write(data, resolve));
}

test("stale xterm mouse reports are caught after a PowerShell prompt", () => {
  const tail = appendTerminalOutputTail(
    "",
    "\x1b[?1003h\x1b[?1006h\r\nPS C:\\Users\\me\\project> \x1b]133;B\x07",
  );

  assert.equal(shouldResetTerminalInputModes(tail, "\x1b[I"), true);
  assert.equal(shouldResetTerminalInputModes(tail, "\x1b[<555;40;1M"), true);
  assert.match(DISABLE_TERMINAL_INPUT_MODES, /\x1b\[\?1003l/);
  assert.match(DISABLE_TERMINAL_INPUT_MODES, /\x1b\[\?1006l/);
  assert.doesNotMatch(RESET_STALE_TERMINAL_INPUT_MODES, /\x1b\[\?2004l/);
  assert.match(DISABLE_TERMINAL_INPUT_MODES, /\x1b\[\?2004l/);
});

test("mouse reports still reach an active TUI and normal shell input is untouched", () => {
  const tui = appendTerminalOutputTail(
    "",
    "Code · GPT-5.6 Sol      Balance\r\n",
  );
  const prompt = appendTerminalOutputTail("", "PS C:\\Users\\me> ");

  assert.equal(shouldResetTerminalInputModes(tui, "\x1b[<40;8;0M"), false);
  assert.equal(shouldResetTerminalInputModes(prompt, "npm test"), false);
});

test("PowerShell OSC 133 and narrow cmd prompts are recognized", () => {
  assert.equal(
    shouldResetTerminalInputModes("custom prompt\x1b]133;B\x07", "\x1b[O"),
    true,
  );
  assert.equal(
    shouldResetTerminalInputModes("C:\\repo>", "\x1b[<10;2;0m"),
    true,
  );
  assert.equal(
    shouldResetTerminalInputModes("\x1b[32mPS C:\\repo>\x1b[0m ", "\x1b[O"),
    false,
  );
});

test("recovery sequence disables xterm mouse tracking", async () => {
  const term = new Terminal();
  await write(term, "\x1b[?1003h\x1b[?1006h");
  await write(term, "\x1b[?2004h");
  assert.equal(term._core.coreMouseService._activeProtocol, "ANY");

  await write(term, RESET_STALE_TERMINAL_INPUT_MODES);
  assert.equal(term._core.coreMouseService._activeProtocol, "NONE");
  assert.equal(term._core.coreService.decPrivateModes.bracketedPasteMode, true);
  term.dispose();
});
