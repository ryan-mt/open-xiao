import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { normalizeCodexUsageError } from "../../src/lib/userFacingError.ts";

const root = new URL("../../", import.meta.url);

test("Codex usage is fetched and shown only for a signed-in OpenAI account", async () => {
  const [auth, profile, styles, backend, commands] = await Promise.all([
    readFile(new URL("src/auth.ts", root), "utf8"),
    readFile(new URL("src/components/ProfilePage.tsx", root), "utf8"),
    readFile(new URL("src/styles.css", root), "utf8"),
    readFile(new URL("src-tauri/src/openai_auth.rs", root), "utf8"),
    readFile(new URL("src-tauri/src/lib.rs", root), "utf8"),
  ]);

  assert.match(auth, /invoke<CodexUsageStatus>\("openai_codex_usage"\)/);
  assert.match(backend, /backend-api\/wham\/usage/);
  assert.match(commands, /openai_auth::openai_codex_usage/);
  assert.match(profile, /if \(!open \|\| !openaiAuth\.signedIn\)/);
  assert.match(profile, /setCodexUsage\(null\)/);
  assert.match(
    profile,
    /\{openaiAuth\.signedIn \? \(\s*<section className="profile-usage"/,
  );
  assert.match(profile, /window\.setInterval\(\(\) => \{/);
  assert.match(profile, /\}, 30_000\)/);
  assert.match(profile, /aria-label="Refresh Codex usage"/);
  assert.match(profile, /codexUsageRequestRef\.current === requestId/);
  assert.match(profile, /if \(codexUsageInFlightRef\.current != null\) return/);
  assert.match(profile, /className="profile-usage__actions"/);
  assert.match(profile, /className="profile-usage__freshness"/);
  assert.match(
    styles,
    /\.profile-usage__limit:only-child\s*{\s*grid-column: 1 \/ -1/,
  );
});

test("official OpenAI response tokens feed profile activity", async () => {
  const [openai, chat, auth, app, profile] = await Promise.all([
    readFile(new URL("src-tauri/src/openai.rs", root), "utf8"),
    readFile(new URL("src-tauri/src/chat.rs", root), "utf8"),
    readFile(new URL("src/auth.ts", root), "utf8"),
    readFile(new URL("src/App.tsx", root), "utf8"),
    readFile(new URL("src/profile.ts", root), "utf8"),
  ]);

  assert.match(openai, /pointer\("\/response\/usage\/total_tokens"\)/);
  assert.match(chat, /StreamEvent::Usage/);
  assert.match(auth, /kind: "usage"/);
  assert.match(app, /recordOpenAITokenActivity\(usage\.totalTokens\)/);
  assert.match(app, /target\.provider === "grok"[\s\S]*recordActivity\(1\)/);
  assert.match(profile, /profile_record_openai_tokens/);
});

test("Codex usage presents invalid sessions differently from temporary failures", () => {
  const invalidSession = normalizeCodexUsageError(
    new Error("401 Unauthorized: session expired"),
  );
  const temporary = normalizeCodexUsageError(
    new Error("503 Service Unavailable"),
  );

  assert.equal(invalidSession.category, "auth");
  assert.equal(invalidSession.title, "Sign in required");
  assert.equal(invalidSession.retryable, false);
  assert.equal(temporary.category, "connectivity");
  assert.equal(temporary.title, "Connection interrupted");
  assert.equal(temporary.retryable, true);
});
