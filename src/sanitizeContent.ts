/**
 * Client-side belt-and-suspenders filter matching backend chat.rs sanitizer.
 * Drops tool-protocol dumps so they never render even if a backend path misses.
 */

const PROTOCOL_MARKERS = [
  "[tool",
  "<tool",
  "</tool",
  "<function",
  "</function",
  "<parameter",
  "</parameter",
  "<|recipient|>",
  "<|channel|>",
  "<|tool",
] as const;

function findCi(hay: string, needle: string): number {
  return hay.toLowerCase().indexOf(needle.toLowerCase());
}

function startsWithProtocolField(line: string, field: string): boolean {
  if (!line.startsWith(field)) return false;
  const rest = line.slice(field.length).trimStart();
  return (
    !rest ||
    rest.startsWith(":") ||
    rest.startsWith("=") ||
    rest.startsWith("{") ||
    rest.startsWith("[")
  );
}

// "functions.<tool>" followed by "(" or a "key=" argument is a protocol call;
// plain prose such as "functions.php handles routing." must NOT match.
function looksLikeFunctionsCall(lower: string): boolean {
  const m = /^functions\.([a-z0-9_]+)([\s\S]*)$/.exec(lower);
  if (!m) return false;
  const rest = (m[2] ?? "").trimStart();
  if (rest.startsWith("(")) return true;
  return /^[a-z_][a-z0-9_]*\s*=/.test(rest);
}

function isToolProtocolLine(line: string): boolean {
  const lower = line.trim().toLowerCase();
  if (!lower) return false;
  if (
    lower.startsWith("assistant to=") ||
    lower.startsWith("analysis to=") ||
    lower.startsWith("commentary to=") ||
    lower.startsWith("to=functions") ||
    lower.startsWith("recipient=functions.") ||
    looksLikeFunctionsCall(lower) ||
    ((lower.startsWith("assistant ") ||
      lower.startsWith("analysis ") ||
      lower.startsWith("commentary ")) &&
      lower.includes("functions."))
  ) {
    return true;
  }
  if (
    (lower.startsWith("invoke tool ") || lower.startsWith("invoking tool ")) &&
    (lower.includes(" path ") ||
      lower.includes(" filepath") ||
      lower.includes(" arguments") ||
      lower.includes(" command "))
  ) {
    return true;
  }
  return [
    "recipient_name",
    "tool_call",
    "tool_result",
    "tool_use",
    "tool_request",
    "function_call",
    "call_tool",
    "run_tool",
  ].some((field) => startsWithProtocolField(lower, field));
}

export function containsToolProtocol(text: string): boolean {
  const lower = text.toLowerCase();
  if (PROTOCOL_MARKERS.some((m) => lower.includes(m))) return true;
  if (lower.split("\n").some(isToolProtocolLine)) return true;

  if (
    lower.includes("·") &&
    (lower.includes(" path ") ||
      lower.includes(" filepath ") ||
      lower.includes(" pattern ") ||
      lower.includes(" offset ") ||
      lower.includes(" command ") ||
      lower.includes("·path") ||
      lower.includes("·filepath") ||
      lower.includes("·pattern")) &&
    (lower.includes("tool ") ||
      lower.includes("[tool") ||
      lower.includes("grep") ||
      lower.includes("read") ||
      lower.includes("edit") ||
      lower.includes("bash") ||
      lower.includes("glob") ||
      lower.includes("write"))
  ) {
    return true;
  }

  if (
    lower.split("\n").some((line) => {
      const t = line.trimStart();
      return (
        t.startsWith("tool ") &&
        (t.includes("·") ||
          t.includes(" path ") ||
          t.includes(" filepath ") ||
          t.includes(" pattern "))
      );
    })
  ) {
    return true;
  }

  const compact = lower.replace(/\s+/g, "");
  if (
    compact.includes('"type":"function"') &&
    compact.includes('"name":') &&
    (compact.includes('"arguments":') || compact.includes('"parameters":'))
  ) {
    return true;
  }
  if (
    compact.includes('"tool_calls":[') ||
    compact.includes('"function_call":{')
  ) {
    return true;
  }
  if (
    (compact.includes('"tool_calls"') || compact.includes('"function_call"')) &&
    (compact.includes('"name":') || compact.includes('"arguments":'))
  ) {
    return true;
  }
  return false;
}

function stripToolProtocol(text: string): string {
  let out = text;

  while (true) {
    const start = findCi(out, "[tool");
    if (start < 0) break;
    const close = out.indexOf("]", start);
    const end = close >= 0 ? close + 1 : out.length;
    out = `${out.slice(0, start)} ${out.slice(end)}`;
  }

  const pairs: [string, string][] = [
    ["<tool_call", "</tool_call>"],
    ["<tool_use", "</tool_use>"],
    ["<tool", "</tool>"],
    ["<function_call", "</function_call>"],
    ["<function", "</function>"],
    ["<parameter", "</parameter>"],
  ];
  for (const [open, close] of pairs) {
    while (true) {
      const start = findCi(out, open);
      if (start < 0) break;
      const after = start + open.length;
      const closeAt = findCi(out.slice(after), close);
      let end: number;
      if (closeAt >= 0) end = after + closeAt + close.length;
      else {
        const gt = out.indexOf(">", after);
        end = gt >= 0 ? gt + 1 : out.length;
      }
      out = `${out.slice(0, start)} ${out.slice(end)}`;
    }
  }

  for (const token of [
    "<|recipient|>",
    "<|channel|>",
    "<|tool_call_begin|>",
    "<|tool_call_end|>",
    "<|tool_calls_section_begin|>",
    "<|tool_calls_section_end|>",
  ]) {
    while (true) {
      const i = findCi(out, token);
      if (i < 0) break;
      out = `${out.slice(0, i)} ${out.slice(i + token.length)}`;
    }
  }

  const cleaned = out
    .split("\n")
    .filter((line) => {
      const lower = line.trim().toLowerCase();
      if (!lower) return true;
      if (
        lower.startsWith("assistant to=") ||
        lower.startsWith("analysis to=") ||
        lower.startsWith("commentary to=") ||
        lower.startsWith("to=functions") ||
        lower.startsWith("recipient=") ||
        lower.startsWith("recipient_name") ||
        lower.startsWith("tool_call") ||
        lower.startsWith("function_call") ||
        lower.startsWith("call tool") ||
        lower.startsWith("invoke tool") ||
        looksLikeFunctionsCall(lower) ||
        (lower.startsWith("tool ") && lower.includes("·"))
      ) {
        return false;
      }
      return !containsToolProtocol(line);
    })
    .join("\n");

  return cleaned
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Drop tool-protocol / keep only safe prose for chat text parts. */
export function sanitizeUserFacingContent(text: string): string {
  if (!text) return "";
  // Preserve spacing for streamed chunks when clean.
  if (!containsToolProtocol(text)) return text;
  const stripped = stripToolProtocol(text);
  if (!stripped || containsToolProtocol(stripped)) return "";
  return stripped;
}

/** Thinking channel: strip protocol, keep short rationale. */
export function sanitizeThinkingContent(text: string): string {
  if (!text) return "";
  if (!containsToolProtocol(text)) return text;
  const stripped = stripToolProtocol(text);
  if (!stripped || containsToolProtocol(stripped)) return "";
  return stripped;
}
