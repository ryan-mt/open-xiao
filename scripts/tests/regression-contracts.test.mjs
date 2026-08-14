import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const read = (path) => readFileSync(join(root, path), "utf8");

test("archive and Git operations retain active workspace ownership", () => {
  const app = read("src/App.tsx");
  const archive = app.slice(
    app.indexOf("const handleArchive ="),
    app.indexOf("const handleUnarchive ="),
  );
  assert.match(archive, /streamingThreadIdsRef\.current\.includes\(id\)/);
  assert.match(archive, /sendingByThreadRef\.current\.has\(id\)/);
  assert.match(archive, /setSendQueue\(\(prev\) => prev\.filter/);
  assert.match(archive, /prioritySendByThreadRef\.current\.delete\(id\)/);

  const refresh = app.slice(
    app.indexOf("const refreshGit ="),
    app.indexOf("const scheduleGitRefresh ="),
  );
  assert.match(refresh, /activeWorkspacePathRef\.current !== path/);
  const workspaceEffect = app.slice(
    app.indexOf("// Poll / refresh git when project/worktree changes"),
    app.indexOf("// After agent finishes editing files"),
  );
  assert.match(workspaceEffect, /gitReqSeqRef\.current \+= 1/);
  assert.match(workspaceEffect, /setGitStatus\(null\)/);
  assert.match(workspaceEffect, /setGitDiff\(null\)/);
});

test("commit drafts clear only after a confirmed commit", () => {
  const app = read("src/App.tsx");
  const controls = read("src/components/GitControls.tsx");
  assert.match(
    app,
    /async \(message: string\): Promise<boolean>[\s\S]*return result\.committed/,
  );
  assert.match(controls, /\.then\(\(committed\) => \{\s*if \(committed\)/);
});

test("OAuth cancellation waits for the original login promise to settle", () => {
  const app = read("src/App.tsx");
  const grokCancel = app.slice(
    app.indexOf("const handleCancelLogin ="),
    app.indexOf("const handleLogout ="),
  );
  const openaiCancel = app.slice(
    app.indexOf("const handleCancelOpenAILogin ="),
    app.indexOf("const handleOpenAILogout ="),
  );
  assert.doesNotMatch(grokCancel, /setAuthBusy\(false\)/);
  assert.doesNotMatch(openaiCancel, /setOpenAIAuthBusy\(false\)/);
});

test("Profile and Settings own their modal layer and keyboard behavior", () => {
  const app = read("src/App.tsx");
  assert.match(
    app,
    /const openSettings = useCallback\(\(\) => \{\s*if \(profileOpen\) return/,
  );
  const dispatcher = read("src/app/keybindingDispatcher.ts");
  assert.match(dispatcher, /if \(current\.blocked\) return/);
  assert.match(dispatcher, /event\.stopPropagation\(\)/);

  const settings = read("src/components/SettingsModal.tsx");
  assert.match(settings, /dialogRef/);
  assert.match(settings, /e\.key !== "Tab"/);
  assert.match(settings, /document\.addEventListener\("focusin"/);
  assert.match(settings, /previouslyFocused\?\.isConnected/);
});

test("Model listboxes implement standard focus navigation", () => {
  const modelSelect = read("src/components/ModelSelect.tsx");
  for (const key of ["ArrowDown", "ArrowUp", "Home", "End", "Escape"]) {
    assert.match(modelSelect, new RegExp(`"${key}"`));
  }
  assert.match(modelSelect, /typeaheadRef/);
  assert.match(modelSelect, /\[role="option"\]\[aria-selected="true"\]/);
  assert.match(modelSelect, /tabIndex=\{-1\}/);
});

test("SQLite fallback, profile date, provider recovery, and process contracts stay wired", () => {
  const store = read("src/store.ts");
  assert.doesNotMatch(store, /pending-sqlite/);
  assert.match(store, /state: "pending-set"/);
  assert.match(store, /state: "pending-remove"/);
  assert.match(store, /readSqliteWithRetry/);
  assert.match(store, /if \(!canPersistStore\(\)\) return/);

  const profile = read("src/profile.ts");
  assert.match(
    profile,
    /invoke<ProfileStats>\("profile_stats", \{\s*days,\s*today: localDayKey\(\)/,
  );

  const chat = read("src-tauri/src/chat.rs");
  assert.doesNotMatch(chat, /if let Ok\(retry_out\)/);
  assert.doesNotMatch(chat, /if let Ok\(tail_out\)/);

  const terminal = read("src-tauri/src/terminal.rs");
  const wait = terminal.slice(
    terminal.indexOf("let result = child.wait();"),
    terminal.indexOf("let (exit_code, error)", terminal.indexOf("let result = child.wait();")),
  );
  assert.ok(
    wait.indexOf("output_handle.join()") < wait.indexOf("finish_session"),
  );

  const tools = read("src-tauri/src/tools.rs");
  // Bash output must be drained into a bounded buffer (pipe deadlock + OOM guard).
  assert.match(tools, /struct DrainState/);
  assert.match(tools, /fn drain_pipe/);
  assert.match(tools, /Command execution does not support UNC workdirs/);

  // OpenAI runs natively through the Responses API — no Codex CLI wrapper.
  assert.doesNotMatch(read("src-tauri/src/lib.rs"), /mod codex;/);
});

test("async thread-save failures reach the UI and block native close", () => {
  const store = read("src/store.ts");
  const app = read("src/App.tsx");
  const closeHandler = app.slice(
    app.indexOf("win.onCloseRequested"),
    app.indexOf("closeCleanup.add", app.indexOf("win.onCloseRequested")),
  );

  assert.match(store, /subscribeThreadsSaveResults/);
  assert.match(app, /subscribeThreadsSaveResults\(handleThreadsSaveResult\)/);
  assert.match(closeHandler, /const saveResult = await flushStore\(\)/);
  assert.ok(
    closeHandler.indexOf('saveResult === "failed"') <
      closeHandler.indexOf("await win.destroy()"),
  );
});
