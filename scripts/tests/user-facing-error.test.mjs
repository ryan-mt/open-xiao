import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  normalizeStoredError,
  normalizeUserFacingError,
  redactSensitiveText,
  redactSensitiveValues,
} from "../../src/lib/userFacingError.ts";

const root = new URL("../../", import.meta.url);

test("provider quota payload becomes one safe actionable error", () => {
  const error = normalizeUserFacingError(
    `chat failed (402 Payment Required): {"code":"personal-team-blocked:spending-limit","error":"You have run out of credits. Add credits at https://grok.com/?token=secret"}`,
    { provider: "grok" },
  );

  assert.equal(error.category, "quota");
  assert.equal(error.title, "Usage limit reached");
  assert.equal(error.action, null);
  assert.equal(error.retryable, false);
  assert.match(error.message, /provider|usage/i);
  assert.doesNotMatch(error.message, /Settings/);
  assert.doesNotMatch(error.message, /402|personal-team|https?:|secret|{/i);
});

test("OAuth access denial is treated as user cancellation", () => {
  for (const message of [
    "OAuth authorization was denied",
    "access_denied",
    "Sign-in request denied",
  ]) {
    const error = normalizeUserFacingError(message, { provider: "openai" });
    assert.equal(error.category, "cancellation", message);
  }
});

test("stored legacy errors are normalized before rendering", () => {
  const error = normalizeStoredError(
    `HTTP 429 {"error":{"message":"rate_limit_exceeded"}}`,
    "openai",
  );
  assert.equal(error?.category, "rate-limit");
  assert.doesNotMatch(error?.message ?? "", /429|rate_limit|{/i);
});

test("permission errors point to the composer controls, not Settings", () => {
  const error = normalizeUserFacingError("HTTP 403 Forbidden");

  assert.equal(error.category, "permission");
  assert.equal(error.action, null);
  assert.match(error.message, /Access and Permissions/);
});

test("rejected request bodies are not reported as connection drops", () => {
  const error = normalizeUserFacingError(
    "The OpenAI service could not accept this request (status 400).",
    { provider: "openai" },
  );

  assert.equal(error.category, "generic");
  assert.notEqual(error.title, "Connection interrupted");
});

test("transport-level failures still classify as connectivity", () => {
  const error = normalizeUserFacingError(
    "OpenAI request: error sending request for url (https://chatgpt.com/backend-api/codex/responses)",
    { provider: "openai" },
  );

  assert.equal(error.category, "connectivity");
  assert.equal(error.title, "Connection interrupted");
});

test("provider detail survives normalization for the error card", () => {
  const error = normalizeUserFacingError(
    "The OpenAI service could not accept this request (status 400). Provider said: Invalid value for 'include'.",
    { provider: "openai" },
  );

  assert.equal(error.detail, "Invalid value for 'include'.");
  assert.doesNotMatch(error.message, /Invalid value/);

  const stored = normalizeStoredError(
    { category: "generic", detail: "Invalid value for 'include'." },
    "openai",
  );
  assert.equal(stored?.detail, "Invalid value for 'include'.");
});

test("provider detail stops before appended subagent progress", () => {
  const error = normalizeUserFacingError(
    [
      "The service is receiving too many requests.",
      "Provider said: Retry after 10 seconds.",
      "Partial report:",
      "Found src/foo.ts.",
    ].join("\n"),
  );

  assert.equal(error.detail, "Retry after 10 seconds.");
  assert.doesNotMatch(error.detail ?? "", /Partial report|src\/foo/);
});

test("backend not-allowed wording is classified as permission", () => {
  const error = normalizeUserFacingError(
    "The delegated request is not allowed with the current permissions.",
  );
  assert.equal(error.category, "permission");
  assert.equal(error.retryable, false);
});

test("method-not-allowed protocol errors are not user permission failures", () => {
  const error = normalizeUserFacingError("HTTP 405 Method Not Allowed");
  assert.equal(error.category, "generic");
  assert.equal(error.retryable, true);
});

test("server errors mentioning current permissions remain retryable", () => {
  const error = normalizeUserFacingError(
    "HTTP 500: failed to load current permissions",
  );
  assert.equal(error.category, "connectivity");
  assert.equal(error.retryable, true);
});

test("multiline provider detail survives until task progress markers", () => {
  const error = normalizeUserFacingError(
    [
      "Request failed.",
      "Provider said: first line",
      "second line",
      "Processed child tools: read (ok)",
    ].join("\n"),
  );
  assert.equal(error.detail, "first line\nsecond line");
});

test("technical secret patterns are redacted from compact tool labels", () => {
  const text = redactSensitiveText(
    "curl https://example.com?access_token=abc123 -H 'Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.payload.signature'",
  );
  assert.doesNotMatch(text, /abc123|eyJhbGci|payload\.signature/);
  assert.match(text, /REDACTED/);
});

test("tool argument redaction removes identity and named secrets without truncation", () => {
  const padding = "x".repeat(700);
  const text = redactSensitiveValues(
    `{"token":"plain-token","signature":"plain-signature","id_token":"identity-secret","OPENAI_API_KEY":"api-secret","padding":"${padding}"}`,
  );
  assert.doesNotMatch(
    text,
    /plain-token|plain-signature|identity-secret|api-secret/,
  );
  assert.match(text, /\[REDACTED\]/);
  assert.match(text, new RegExp(`${padding.slice(-40)}"}`));
});

test("tool arguments are redacted at ingestion and expanded-view boundaries", async () => {
  const [app, messageList] = await Promise.all([
    readFile(new URL("src/App.tsx", root), "utf8"),
    readFile(new URL("src/components/MessageList.tsx", root), "utf8"),
  ]);
  assert.match(app, /args: redactSensitiveValues\(args\)/);
  assert.match(messageList, /args: redactSensitiveValues\(call\.args\)/);
});
