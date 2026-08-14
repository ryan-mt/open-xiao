import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { build, loadConfigFromFile } from "vite";

const root = new URL("../../", import.meta.url);

async function readJson(path) {
  return JSON.parse(await readFile(new URL(path, root), "utf8"));
}

async function readText(path) {
  return readFile(new URL(path, root), "utf8");
}

test("Tauri beta builds the frontend with the beta Vite mode", async () => {
  const [betaConfig, packageJson] = await Promise.all([
    readJson("src-tauri/tauri.beta.conf.json"),
    readJson("package.json"),
  ]);

  assert.equal(betaConfig.build?.beforeBuildCommand, "npm run build:beta");
  assert.equal(
    packageJson.scripts?.["prepare:codex-sidecar"],
    undefined,
    "Codex CLI sidecar preparation must stay removed",
  );
  assert.match(packageJson.scripts?.["build:beta"] ?? "", /vite build --mode beta/);
});

test("Tauri beta serves the built frontend without a fixed preview port", async () => {
  const [betaConfig, packageJson] = await Promise.all([
    readJson("src-tauri/tauri.beta.conf.json"),
    readJson("package.json"),
  ]);

  assert.equal(betaConfig.build?.beforeDevCommand, null);
  assert.equal(betaConfig.build?.devUrl, null);
  assert.equal(betaConfig.build?.frontendDist, "../dist");
  assert.equal(packageJson.scripts?.["preview:app"], undefined);
});

test("Tauri uses Open Xiao branding and bundles no external binaries", async () => {
  const [mainConfig, betaConfig] = await Promise.all([
    readJson("src-tauri/tauri.conf.json"),
    readJson("src-tauri/tauri.beta.conf.json"),
  ]);

  assert.equal(mainConfig.productName, "Open Xiao");
  assert.equal(betaConfig.productName, "Open Xiao (Beta)");
  assert.equal(mainConfig.bundle?.externalBin, undefined);
  assert.equal(betaConfig.bundle?.externalBin, undefined);
});

test("public release identities use the final Open Xiao namespace", async () => {
  const [
    mainConfig,
    betaConfig,
    cargoToml,
    databaseSource,
    gitSource,
    promptStashSource,
    filePreviewSource,
    authFinderSource,
  ] = await Promise.all([
    readJson("src-tauri/tauri.conf.json"),
    readJson("src-tauri/tauri.beta.conf.json"),
    readText("src-tauri/Cargo.toml"),
    readText("src-tauri/src/db.rs"),
    readText("src-tauri/src/git.rs"),
    readText("src/promptStash.ts"),
    readText("src/components/FilePreviewPanel.tsx"),
    readText("scripts/find-auth.ps1"),
  ]);

  assert.equal(mainConfig.identifier, "com.nguye.openxiao");
  assert.equal(betaConfig.identifier, "com.nguye.openxiao.beta");
  assert.equal(mainConfig.bundle?.publisher, "Open Xiao");
  assert.match(cargoToml, /^authors = \["Open Xiao contributors"\]$/m);
  assert.doesNotMatch(cargoToml, /^authors = \["you"\]$/m);
  assert.match(databaseSource, /const DB_FILE: &str = "open-xiao\.db";/);
  assert.match(gitSource, /common_dir\.join\("open-xiao-worktrees"\)/);
  assert.doesNotMatch(gitSource, /grokapp-worktrees/);
  assert.match(promptStashSource, /const KEY = "open-xiao\.prompt-stash\.v1";/);
  assert.match(filePreviewSource, /"open-xiao\.filePanelWidth"/);
  assert.match(filePreviewSource, /"open-xiao\.fileExplorerOpen"/);
  assert.match(filePreviewSource, /"open-xiao\.renderMarkdown"/);
  assert.match(filePreviewSource, /function loadPanelWidth\(\): number \{\s*try \{/);
  assert.match(filePreviewSource, /function loadBoolean[\s\S]*?try \{/);
  assert.match(filePreviewSource, /function savePreference[\s\S]*?catch \{/);
  assert.match(authFinderSource, /com\.nguye\.openxiao/);
  assert.doesNotMatch(authFinderSource, /com\.nguye\.grokapp/);
});

test("package, Cargo, and Tauri release versions stay aligned", async () => {
  const [packageJson, mainConfig, cargoToml] = await Promise.all([
    readJson("package.json"),
    readJson("src-tauri/tauri.conf.json"),
    readText("src-tauri/Cargo.toml"),
  ]);
  const cargoVersion = cargoToml.match(/^version = "([^"]+)"$/m)?.[1];

  assert.equal(mainConfig.version, packageJson.version);
  assert.equal(cargoVersion, packageJson.version);
});

test("Tauri windows stay hidden until the persisted theme is applied", async () => {
  const [mainConfig, betaConfig] = await Promise.all([
    readJson("src-tauri/tauri.conf.json"),
    readJson("src-tauri/tauri.beta.conf.json"),
  ]);

  assert.equal(mainConfig.app?.windows?.[0]?.visible, false);
  assert.equal(betaConfig.app?.windows?.[0]?.visible, false);
});

test("the production entry chunk stays within Vite's 500 kB budget", async () => {
  const loadedConfig = await loadConfigFromFile(
    { command: "build", mode: "production" },
    fileURLToPath(new URL("vite.config.ts", root)),
  );
  assert.ok(loadedConfig);

  const result = await build({
    ...loadedConfig.config,
    configFile: false,
    logLevel: "silent",
    build: {
      ...loadedConfig.config.build,
      write: false,
    },
  });
  const outputs = Array.isArray(result) ? result : [result];
  const entryChunk = outputs
    .flatMap((output) => output.output)
    .find((output) => output.type === "chunk" && output.isEntry);

  assert.ok(entryChunk);
  assert.ok(
    entryChunk.code.length <= 500_000,
    `production entry chunk is ${entryChunk.code.length} bytes`,
  );
});
