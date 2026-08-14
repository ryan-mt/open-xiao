import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      if (specifier.startsWith(".") && !/\.[a-z]+$/i.test(specifier)) {
        return nextResolve(`${specifier}.ts`, context);
      }
      throw error;
    }
  },
});

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const read = (path) => readFileSync(join(root, path), "utf8");

test("OpenCode provider page and update notice use backend-owned actions", () => {
  const app = read("src/App.tsx");
  const opencode = read("src/opencode.ts");
  const page = read("src/components/ProvidersPage.tsx");
  const logo = read("src/components/OpenCodeLogo.tsx");

  assert.match(app, /<ProvidersPage/);
  assert.match(app, /<OpenCodeUpdateNotice/);
  assert.match(opencode, /invoke<OpenCodeStatus>\("opencode_status"/);
  assert.match(opencode, /invoke<OpenCodeUpdateResult>\("opencode_update"/);
  assert.doesNotMatch(page, /command\s*:/);
  assert.match(page, /Health check interval/);
  assert.match(page, /Update OpenCode/);
  assert.match(page, /<OpenCodeLogo/);
  assert.doesNotMatch(page, /Sparkles|TerminalSquare/);
  assert.match(logo, /viewBox="0 0 32 40"/);
  assert.match(page, /redactedPlaceholder/);
  assert.match(page, /Toggle OpenAI account email visibility/);
  assert.match(page, /revealed \? value : redacted/);
});

test("disabled OpenCode never starts a status runtime", () => {
  const app = read("src/App.tsx");

  assert.match(
    app,
    /const refreshOpenCode = useCallback[\s\S]*?if \(!openCodeEnabled\) \{[\s\S]*?return;[\s\S]*?getOpenCodeStatus/,
  );
});

test("only the latest project-scoped OpenCode refresh may publish status", () => {
  const app = read("src/App.tsx");
  const refresh = app.slice(
    app.indexOf("const refreshOpenCode"),
    app.indexOf("const refreshAntigravity"),
  );

  const requestAt = refresh.indexOf(
    "const requestId = ++openCodeRefreshRequestRef.current",
  );
  const responseAt = refresh.indexOf(
    "const status = projectPath",
  );
  const ownershipAt = refresh.indexOf(
    "if (requestId !== openCodeRefreshRequestRef.current) return;",
  );
  const publishAt = refresh.indexOf("configureOpenCodeModels(", responseAt);

  assert.ok(requestAt >= 0);
  assert.ok(responseAt > requestAt);
  assert.ok(ownershipAt > responseAt);
  assert.ok(publishAt > ownershipAt);
  assert.match(refresh, /const projectPath = activeWorkspacePath/);
  assert.match(
    refresh,
    /openCodeStatusProjectPathRef\.current = projectPath;\s*setOpenCodeStatus\(status\)/,
  );
  assert.match(refresh, /finally \{\s*if \(requestId === openCodeRefreshRequestRef\.current\)/);
});

test("corrupt OpenCode health intervals fall back to a supported value", async () => {
  const originalLocalStorage = globalThis.localStorage;
  const values = new Map();
  globalThis.localStorage = {
    getItem(key) {
      return values.get(key) ?? null;
    },
    setItem(key, value) {
      values.set(key, String(value));
    },
  };

  try {
    const opencode = await import(`../../src/opencode.ts?interval=${Date.now()}`);
    for (const supported of [0, 60, 300, 900, 1800]) {
      values.set("open-xiao:opencode-health-interval", String(supported));
      assert.equal(opencode.loadOpenCodeHealthInterval(), supported);
    }
    for (const corrupt of [30, 31, 86_400_000, Number.MAX_VALUE, "nope"]) {
      values.set("open-xiao:opencode-health-interval", String(corrupt));
      assert.equal(opencode.loadOpenCodeHealthInterval(), 300);
    }
  } finally {
    if (originalLocalStorage === undefined) {
      Reflect.deleteProperty(globalThis, "localStorage");
    } else {
      globalThis.localStorage = originalLocalStorage;
    }
  }
});

test("OpenCode update results cannot overwrite a newer project refresh", () => {
  const app = read("src/App.tsx");
  const update = app.slice(
    app.indexOf("const handleOpenCodeUpdate"),
    app.indexOf("const activeWorkspacePath", app.indexOf("const handleOpenCodeUpdate")),
  );

  const requestAt = update.indexOf(
    "const requestId = ++openCodeRefreshRequestRef.current",
  );
  const responseAt = update.indexOf("const result = await updateOpenCode");
  const ownershipAt = update.indexOf(
    "if (requestId !== openCodeRefreshRequestRef.current) return;",
  );
  const publishAt = update.indexOf("configureOpenCodeModels(", responseAt);

  assert.ok(requestAt >= 0);
  assert.ok(responseAt > requestAt);
  assert.ok(ownershipAt > responseAt);
  assert.ok(publishAt > ownershipAt);
  assert.match(
    update,
    /catch \(error\) \{\s*if \(requestId !== openCodeRefreshRequestRef\.current\) return;/,
  );
});

test("only the latest Antigravity refresh may publish status", () => {
  const app = read("src/App.tsx");
  const refresh = app.slice(
    app.indexOf("const refreshAntigravity"),
    app.indexOf("useEffect(() =>", app.indexOf("const refreshAntigravity")),
  );

  const requestAt = refresh.indexOf(
    "const requestId = ++antigravityRefreshRequestRef.current",
  );
  const responseAt = refresh.indexOf("const status = await getAntigravityStatus");
  const ownershipAt = refresh.indexOf(
    "if (requestId !== antigravityRefreshRequestRef.current) return;",
  );
  const publishAt = refresh.indexOf("configureAntigravityModels(", responseAt);

  assert.ok(requestAt >= 0);
  assert.ok(responseAt > requestAt);
  assert.ok(ownershipAt > responseAt);
  assert.ok(publishAt > ownershipAt);
  assert.match(
    refresh,
    /finally \{\s*if \(requestId === antigravityRefreshRequestRef\.current\)/,
  );

  const toggle = app.slice(
    app.indexOf("const handleAntigravityEnabledChange"),
    app.indexOf("const handleOpenCodeEnabledChange"),
  );
  assert.match(toggle, /antigravityRefreshRequestRef\.current \+= 1/);
});

test("provider refresh failures retain model metadata but mark status unavailable", () => {
  const app = read("src/App.tsx");
  const openCodeRefresh = app.slice(
    app.indexOf("const refreshOpenCode"),
    app.indexOf("const refreshAntigravity"),
  );
  const openCodeCatch = openCodeRefresh.slice(
    openCodeRefresh.indexOf("} catch (error)"),
    openCodeRefresh.indexOf("} finally"),
  );
  const antigravityRefresh = app.slice(
    app.indexOf("const refreshAntigravity"),
    app.indexOf("useEffect(() =>", app.indexOf("const refreshAntigravity")),
  );
  const antigravityCatch = antigravityRefresh.slice(
    antigravityRefresh.indexOf("} catch (error)"),
    antigravityRefresh.indexOf("} finally"),
  );
  const openCodeSuccess = openCodeRefresh.slice(
    openCodeRefresh.indexOf("const status = await getOpenCodeStatus"),
    openCodeRefresh.indexOf("} catch (error)"),
  );
  const antigravitySuccess = antigravityRefresh.slice(
    antigravityRefresh.indexOf("const status = await getAntigravityStatus"),
    antigravityRefresh.indexOf("} catch (error)"),
  );

  assert.doesNotMatch(openCodeSuccess, /:\s*\[\]/);
  assert.doesNotMatch(openCodeCatch, /configureOpenCodeModels\(\[\]\)/);
  assert.match(
    openCodeCatch,
    /setOpenCodeStatus\(\(current\) => \(\{ \.\.\.current, ready: false \}\)\)/,
  );
  assert.doesNotMatch(antigravitySuccess, /:\s*\[\]/);
  assert.doesNotMatch(
    antigravityCatch,
    /configureAntigravityModels\(\[\]\)/,
  );
  assert.match(
    antigravityCatch,
    /setAntigravityStatus\(\(current\) => \(\{ \.\.\.current, ready: false \}\)\)/,
  );
});

test("OpenCode availability belongs to the active project path", async () => {
  const app = read("src/App.tsx");
  const { EMPTY_OPENCODE_STATUS, isOpenCodeReadyForWorkspace } = await import(
    `../../src/opencode.ts?workspace=${Date.now()}`
  );

  const ready = { ...EMPTY_OPENCODE_STATUS, checkedAt: 1, ready: true };
  ready.models = [
    {
      id: "openai/gpt-x",
      name: "GPT X",
      upstreamProvider: "openai",
      upstreamProviderName: "OpenAI",
      contextWindow: 100_000,
      variants: ["medium"],
    },
  ];
  assert.equal(
    isOpenCodeReadyForWorkspace(
      true,
      ready,
      "C:/project",
      "C:/project",
      "opencode::openai/gpt-x",
    ),
    true,
  );
  assert.equal(
    isOpenCodeReadyForWorkspace(true, ready, "C:/project", "C:/worktree"),
    false,
  );
  assert.equal(
    isOpenCodeReadyForWorkspace(
      true,
      ready,
      "C:/project",
      "C:/project",
      "opencode::openai/missing",
    ),
    false,
  );
  assert.equal(
    isOpenCodeReadyForWorkspace(true, ready, "C:/project", null),
    false,
  );
  assert.match(
    app,
    /const activeWorkspacePath = useMemo\([\s\S]*?resolveWorkspacePath\(activeProject\?\.path, active\?\.worktreePath\)/,
  );
  assert.match(
    app,
    /const activeProviderSignedIn =[\s\S]*?isOpenCodeReadyForWorkspace\([\s\S]*?: providerAvailability\[activeModelProvider\]/,
  );
  assert.match(
    app,
    /const sendTargetAvailability = useCallback\([\s\S]*?resolveWorkspacePath\([\s\S]*?isOpenCodeReadyForWorkspace\(/,
  );
  assert.match(
    app,
    /openCodeStatusByWorkspaceRef\.current\.get\(workspacePath\)/,
  );
  assert.match(
    app,
    /void checkOpenCodeWorkspace\(targetWorkspacePath\)\.catch/,
  );
  assert.match(
    app,
    /!openCodeStatusByWorkspaceRef\.current\.has\(targetWorkspacePath\)/,
  );
  assert.match(
    app,
    /generation !== openCodeWorkspaceCheckGenerationRef\.current[\s\S]*?!openCodeEnabledRef\.current/,
  );
  assert.match(
    app,
    /const handleOpenCodeUpdate[\s\S]*?openCodeWorkspaceCheckGenerationRef\.current \+= 1;[\s\S]*?openCodeStatusByWorkspaceRef\.current\.clear\(\)/,
  );
  assert.match(
    app,
    /if \(openCodeUpdatingRef\.current\) \{\s*return Promise\.reject\(new Error\("OpenCode is updating\."\)\);\s*\}/,
  );
  assert.match(
    app,
    /const refreshQueuedOpenCodeWorkspaces = useCallback\([\s\S]*?for \(const threadId of drainAfterRef\.current\)[\s\S]*?checkOpenCodeWorkspace\(workspacePath\)/,
  );
  assert.match(
    app,
    /refreshQueuedOpenCodeWorkspaces\(\);[\s\S]*?openCodeHealthInterval \* 1_000/,
  );
  assert.match(
    app,
    /const targetProviderAvailable = sendTargetAvailability\(target\);/,
  );
  assert.equal(
    (app.match(/if \(!sendTargetAvailability\(target\)\)/g) ?? []).length,
    2,
  );
  const toggle = app.slice(
    app.indexOf("const handleOpenCodeEnabledChange"),
    app.indexOf("const handleOpenCodeHealthIntervalChange"),
  );
  assert.match(toggle, /openCodeRefreshRequestRef\.current \+= 1/);
  assert.doesNotMatch(toggle, /openCodeUpdatingRef\.current = false/);
  assert.match(
    app,
    /const updateToken = \+\+openCodeUpdateTokenRef\.current;[\s\S]*?finally \{\s*if \(updateToken === openCodeUpdateTokenRef\.current\) \{\s*openCodeUpdatingRef\.current = false;/,
  );
  assert.match(
    app,
    /useEffect\(\(\) => \{\s*if \(openCodeUpdating\) return;\s*void refreshOpenCode\(\);\s*void refreshAntigravity\(\);\s*refreshQueuedOpenCodeWorkspaces\(\)/,
  );
});
