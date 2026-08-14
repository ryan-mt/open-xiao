const OUTPUT_TAIL_LIMIT = 4096;
const ANSI_CSI = /\x1b\[[0-?]*[ -/]*[@-~]/g;
const ANSI_OSC = /\x1b\][^\x07]*(?:\x07|\x1b\\)/g;
const INPUT_REPORT =
  /^(?:(?:\x1b\[(?:I|O|<\d+;\d+;\d+[Mm]|\d+;\d+;\d+M))|(?:\x1b\[M[\s\S]{3}))+$/;

export const RESET_STALE_TERMINAL_INPUT_MODES =
  "\x1b[?9l\x1b[?1000l\x1b[?1001l\x1b[?1002l\x1b[?1003l" +
  "\x1b[?1004l\x1b[?1005l\x1b[?1006l\x1b[?1015l\x1b[?1016l";

export const DISABLE_TERMINAL_INPUT_MODES = `${RESET_STALE_TERMINAL_INPUT_MODES}\x1b[?2004l`;

export function appendTerminalOutputTail(
  current: string,
  chunk: string,
): string {
  return `${current}${chunk}`.slice(-OUTPUT_TAIL_LIMIT);
}

function outputEndsAtWindowsShellPrompt(output: string): boolean {
  if (/\x1b\]133;B(?:\x07|\x1b\\)\s*$/.test(output)) return true;
  const plain = output
    .replace(ANSI_OSC, "")
    .replace(ANSI_CSI, "")
    .replace(/\r/g, "");
  const line = plain.slice(plain.lastIndexOf("\n") + 1);
  return /^[a-z]:\\[^<>|]{0,1000}>\s*$/i.test(line);
}

export function shouldResetTerminalInputModes(
  recentOutput: string,
  input: string,
): boolean {
  return (
    INPUT_REPORT.test(input) && outputEndsAtWindowsShellPrompt(recentOutput)
  );
}
