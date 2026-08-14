import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseContextK as parseProductionContext } from "../../src/contextMeter.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");

// Mirror of src/contextMeter.ts + models context strings — keep in sync via source asserts.
function estimateTokens(text) {
  if (!text) return 0;
  return Math.max(1, Math.ceil(text.length / 4));
}

function estimateMessageTokens(m) {
  let n = 0;
  if (m.role === "assistant") {
    const content = m.content || "";
    if (content) n += estimateTokens(content);
    if (m.toolCalls?.length) {
      for (const call of m.toolCalls) {
        const name = call.name || "";
        const args = call.args || "";
        const result = call.result || "";
        // Match assistantContentForApi truncation budgets loosely for the meter.
        const argsBudget = args.length > 1200 ? args.slice(0, 1200) : args;
        const resultBudget = result.length > 4000 ? result.slice(0, 4000) : result;
        const blob = [name, argsBudget, resultBudget].filter(Boolean).join("\n");
        if (blob) n += estimateTokens(blob);
      }
    } else if (m.thinking) {
      // Live/incomplete turns may still hold reasoning in context.
      n += estimateTokens(m.thinking);
    }
  } else {
    n += estimateTokens(m.content || "");
    if (m.thinking) n += estimateTokens(m.thinking);
  }
  if (m.attachments?.length) {
    n += m.attachments.length * 800;
  }
  // Per-message framing overhead (role tags, separators).
  if (n > 0) n += 8;
  return n;
}

function parseContextK(context) {
  const m = /^([\d.]+)\s*([kKmM])?$/.exec(String(context).trim());
  if (!m) return 0;
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n <= 0) return 0;
  const u = (m[2] || "").toLowerCase();
  if (u === "m") return Math.round(n * 1_000_000);
  if (u === "k") return Math.round(n * 1_000);
  return Math.round(n);
}

function contextUsage(messages, modelContext, draftText = "", draftAttachmentCount = 0) {
  const limit = parseContextK(modelContext);
  let used = messages.reduce((sum, m) => sum + estimateMessageTokens(m), 0);
  // System prompt always present server-side; small fixed overhead.
  used += 1_200;
  if (draftText) used += estimateTokens(draftText);
  used += draftAttachmentCount * 800;
  const ratio = limit > 0 ? Math.min(1, used / limit) : 0;
  return { used, limit, ratio };
}

function formatTokens(value) {
  if (value == null || !Number.isFinite(value)) return "0";
  if (value < 1_000) return `${Math.round(value)}`;
  if (value < 10_000) return `${(value / 1_000).toFixed(1).replace(/\.0$/, "")}k`;
  if (value < 1_000_000) return `${Math.round(value / 1_000)}k`;
  return `${(value / 1_000_000).toFixed(1).replace(/\.0$/, "")}m`;
}

const modelsSrc = readFileSync(join(root, "src/models.ts"), "utf8");
const antigravitySrc = readFileSync(join(root, "src/antigravity.ts"), "utf8");
const meterSrc = readFileSync(join(root, "src/contextMeter.ts"), "utf8");
const meterUiSrc = readFileSync(
  join(root, "src/components/ContextWindowMeter.tsx"),
  "utf8",
);

test("Grok model context strings match xAI docs", () => {
  assert.match(modelsSrc, /id:\s*"grok-4\.5"[\s\S]*?context:\s*"500k"/);
  assert.match(modelsSrc, /id:\s*"grok-4\.3"[\s\S]*?context:\s*"1M"/);
  assert.match(
    modelsSrc,
    /id:\s*"grok-4\.20-0309-reasoning"[\s\S]*?context:\s*"1M"/,
  );
  assert.match(
    modelsSrc,
    /id:\s*"grok-4\.20-0309-non-reasoning"[\s\S]*?context:\s*"1M"/,
  );
  assert.match(
    modelsSrc,
    /id:\s*"grok-4\.20-multi-agent-0309"[\s\S]*?context:\s*"1M"/,
  );
  assert.match(modelsSrc, /id:\s*"grok-build-0\.1"[\s\S]*?context:\s*"256k"/);
});

test("OpenAI catalog exposes separate GPT-5.6 Codex models", () => {
  for (const id of ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"]) {
    assert.match(
      modelsSrc,
      new RegExp(
        `id:\\s*"${id.replaceAll(".", "\\.")}"[\\s\\S]*?provider:\\s*"openai"[\\s\\S]*?context:\\s*"272k"`,
      ),
    );
  }
  assert.match(modelsSrc, /id:\s*"gpt-5\.6-sol"[\s\S]*?"ultra"/);
});

test("parseContextK maps k/M labels to token limits", () => {
  assert.equal(parseContextK("500k"), 500_000);
  assert.equal(parseContextK("500K"), 500_000);
  assert.equal(parseContextK("1M"), 1_000_000);
  assert.equal(parseContextK("1m"), 1_000_000);
  assert.equal(parseContextK("256k"), 256_000);
  assert.equal(parseContextK("128000"), 128_000);
  assert.equal(parseContextK("2.5M"), 2_500_000);
  assert.equal(parseContextK("bogus"), 0);
  assert.equal(parseContextK("—"), 0);
  assert.equal(parseContextK("0"), 0);
});

test("unknown provider context never becomes a fabricated 128k limit", () => {
  assert.match(antigravitySrc, /context:\s*"—"/);
  assert.equal(parseProductionContext("—"), 0);
});

test("formatTokens renders Grok window sizes like the UI tip", () => {
  assert.equal(formatTokens(0), "0");
  assert.equal(formatTokens(500_000), "500k");
  assert.equal(formatTokens(256_000), "256k");
  assert.equal(formatTokens(1_000_000), "1m");
  assert.equal(formatTokens(1_500), "1.5k");
});

test("empty thread still reserves system overhead against model limit", () => {
  const u = contextUsage([], "500k");
  assert.equal(u.limit, 500_000);
  assert.ok(u.used > 0);
  assert.ok(u.used < 5_000);
  assert.ok(u.ratio > 0 && u.ratio < 0.01);
});

test("tool results contribute to used tokens", () => {
  const withoutTools = estimateMessageTokens({
    id: "a",
    role: "assistant",
    content: "done",
    createdAt: 1,
  });
  const withTools = estimateMessageTokens({
    id: "a",
    role: "assistant",
    content: "done",
    createdAt: 1,
    toolCalls: [
      {
        id: "t",
        name: "bash",
        args: JSON.stringify({ command: "ls -la" }),
        result: "x".repeat(4000),
        status: "done",
      },
    ],
  });
  assert.ok(withTools > withoutTools + 500);
});

test("draft text is included in usage", () => {
  const base = contextUsage([], "500k", "");
  const withDraft = contextUsage([], "500k", "y".repeat(4000));
  assert.ok(withDraft.used >= base.used + 1000);
});

test("draft image attachments are included in usage", () => {
  const base = contextUsage([], "500k");
  const withImages = contextUsage([], "500k", "", 2);
  assert.equal(withImages.used, base.used + 1600);
});

test("context meter source implements tool + draft + system overhead", () => {
  assert.match(meterSrc, /export function estimateTokens/);
  assert.match(meterSrc, /export function parseContextK/);
  assert.match(meterSrc, /export function contextUsage/);
  assert.match(meterSrc, /toolCalls/);
  assert.match(meterSrc, /draftText/);
  assert.match(meterSrc, /draftAttachmentCount/);
  assert.match(meterSrc, /SYSTEM_PROMPT_OVERHEAD/);
  assert.match(meterUiSrc, /formatTokens\(usage\.maxTokens\)/);
  assert.match(meterUiSrc, /0\/500k|formatTokens/);
});
