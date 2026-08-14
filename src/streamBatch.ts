/**
 * Coalesce high-frequency stream patches onto rAF (OpenCode-style).
 * One React commit per frame per stream key instead of per token/tool event.
 */

export type StreamBatchHandlers = {
  onChunk: (text: string) => void;
  onThinking?: (text: string) => void;
  onToolStart?: (t: {
    id: string;
    name: string;
    args: string;
    awaitingApproval?: boolean;
    approvalReason?: string;
    parentId?: string;
  }) => void;
  onToolResult?: (t: {
    id: string;
    name: string;
    ok: boolean;
    result: string;
    parentId?: string;
    imageUrl?: string;
  }) => void;
  onToolOutput?: (t: { id: string; text: string; replace?: boolean }) => void;
};

type ToolStart = {
  id: string;
  name: string;
  args: string;
  awaitingApproval?: boolean;
  approvalReason?: string;
  parentId?: string;
};
type ToolResult = {
  id: string;
  name: string;
  ok: boolean;
  result: string;
  parentId?: string;
  imageUrl?: string;
};
type ToolOutput = { id: string; text: string; replace?: boolean };

/**
 * Ordered frame segments. Adjacent same-kind text deltas merge into one
 * segment, but text and tool events keep their true arrival order — a
 * tool_result followed by content in the same frame must still paint the
 * tool row before the new text.
 */
type Segment =
  | { kind: "content"; text: string }
  | { kind: "thinking"; text: string }
  | { kind: "start"; t: ToolStart }
  | { kind: "result"; t: ToolResult }
  | { kind: "output"; t: ToolOutput };

/**
 * Wrap stream handlers so content/thinking deltas merge and flush once per
 * frame. Events keep arrival order; only adjacent same-kind text runs merge.
 */
export function createRafStreamBatcher(
  handlers: StreamBatchHandlers,
): StreamBatchHandlers & { flush: () => void; dispose: () => void } {
  let segments: Segment[] = [];
  let raf = 0;
  let disposed = false;

  const flush = () => {
    raf = 0;
    if (disposed) return;
    const batch = segments;
    segments = [];
    for (const seg of batch) {
      switch (seg.kind) {
        case "content":
          handlers.onChunk(seg.text);
          break;
        case "thinking":
          handlers.onThinking?.(seg.text);
          break;
        case "start":
          handlers.onToolStart?.(seg.t);
          break;
        case "result":
          handlers.onToolResult?.(seg.t);
          break;
        case "output":
          handlers.onToolOutput?.(seg.t);
          break;
      }
    }
  };

  const schedule = () => {
    if (disposed || raf) return;
    raf = requestAnimationFrame(flush);
  };

  const pushText = (kind: "content" | "thinking", text: string) => {
    const last = segments[segments.length - 1];
    if (last && last.kind === kind) {
      last.text += text;
    } else {
      segments.push({ kind, text });
    }
  };

  return {
    onChunk(text) {
      if (disposed || !text) return;
      pushText("content", text);
      schedule();
    },
    onThinking(text) {
      if (disposed || !text) return;
      pushText("thinking", text);
      schedule();
    },
    onToolStart(t) {
      if (disposed) return;
      // Collapse duplicate starts for the same id within the frame, keeping
      // the original position so ordering relative to text stays stable.
      const existing = segments.find(
        (s): s is Extract<Segment, { kind: "start" }> =>
          s.kind === "start" && s.t.id === t.id,
      );
      if (existing) existing.t = t;
      else segments.push({ kind: "start", t });
      schedule();
    },
    onToolResult(t) {
      if (disposed) return;
      const existing = segments.find(
        (s): s is Extract<Segment, { kind: "result" }> =>
          s.kind === "result" && s.t.id === t.id,
      );
      if (existing) existing.t = t;
      else segments.push({ kind: "result", t });
      schedule();
    },
    onToolOutput(t) {
      if (disposed || !t.text) return;
      // Merge adjacent output chunks for the same tool within the frame.
      const last = segments[segments.length - 1];
      if (last && last.kind === "output" && last.t.id === t.id) {
        if (t.replace) last.t = { ...t };
        else last.t.text += t.text;
      } else {
        segments.push({ kind: "output", t: { ...t } });
      }
      schedule();
    },
    flush() {
      if (raf) {
        cancelAnimationFrame(raf);
        raf = 0;
      }
      flush();
    },
    dispose() {
      disposed = true;
      if (raf) {
        cancelAnimationFrame(raf);
        raf = 0;
      }
      // Drop unflushed work — caller is tearing down / aborted.
      segments = [];
    },
  };
}
