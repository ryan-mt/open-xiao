/**
 * Pure helpers for worktree path resolution + slug sanitization.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  normalizeWorkspacePath,
  resolveWorkspacePath,
} from "../../src/gitWorkspace.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");

describe("resolveWorkspacePath", () => {
  it("prefers and trims the thread worktree", () => {
    assert.equal(
      resolveWorkspacePath("C:/proj", "  C:/proj-worktrees/a  "),
      "C:/proj-worktrees/a",
    );
  });

  it("falls back to the trimmed project when worktree is empty or invalid", () => {
    assert.equal(resolveWorkspacePath(" C:/proj ", null), "C:/proj");
    assert.equal(resolveWorkspacePath("C:/proj", "  "), "C:/proj");
    assert.equal(resolveWorkspacePath("C:/proj", 42), "C:/proj");
  });

  it("returns null when both paths are missing or invalid", () => {
    assert.equal(resolveWorkspacePath(null, null), null);
    assert.equal(resolveWorkspacePath("", ""), null);
    assert.equal(resolveWorkspacePath({}, false), null);
  });
});

describe("normalizeWorkspacePath", () => {
  it("safely normalizes persisted path fields", () => {
    assert.equal(normalizeWorkspacePath("  C:/worktree  "), "C:/worktree");
    assert.equal(normalizeWorkspacePath(undefined), null);
    assert.equal(normalizeWorkspacePath(123), null);
  });
});

describe("frontend worktree backend contract", () => {
  const gitSource = readFileSync(join(root, "src/git.ts"), "utf8");
  const appSource = readFileSync(join(root, "src/App.tsx"), "utf8");
  const tauriLibSource = readFileSync(join(root, "src-tauri/src/lib.rs"), "utf8");
  const gitControlsSource = readFileSync(
    join(root, "src/components/GitControls.tsx"),
    "utf8",
  );

  it("uses the Sprint B invoke names and exact argument objects", () => {
    assert.match(
      gitSource,
      /invoke<GitRef\[]>\("git_list_refs", \{ path \}\)/,
    );
    assert.match(
      gitSource,
      /invoke<GitWorktreeResult>\("git_worktree_create", \{[\s\S]*?path,[\s\S]*?threadId,[\s\S]*?baseRef,[\s\S]*?\}\)/,
    );
    assert.match(tauriLibSource, /git::git_list_refs/);
    assert.match(
      appSource,
      /gitWorktreeCreate\(project\.path, pending\.id, baseRef\)/,
    );
    assert.match(
      gitSource,
      /invoke<GitWorktreeResult>\("git_worktree_remove", \{[\s\S]*?path,[\s\S]*?worktreePath,[\s\S]*?\}\)/,
    );
    assert.match(
      gitSource,
      /invoke<GitPrResult>\("git_pr_open", \{ path \}\)/,
    );
    assert.doesNotMatch(gitSource, /"git_open_pr"/);
  });

  it("routes target-thread and active UI paths through the effective workspace", () => {
    assert.match(
      appSource,
      /resolveWorkspacePath\(activeProject\?\.path, active\?\.worktreePath\)/,
    );
    assert.equal(
      (appSource.match(/projectPath=\{activeWorkspacePath\}/g) ?? []).length,
      2,
    );
    assert.match(appSource, /worktreePath: existing\?\.worktreePath \?\? null/);
    assert.equal(
      (appSource.match(/worktreePath: thread\.worktreePath \?\? null/g) ?? [])
        .length,
      2,
    );
  });

  it("removes worktrees before local deletion and blocks unsafe project removal", () => {
    const deleteStart = appSource.indexOf("const handleDelete = async");
    const deleteEnd = appSource.indexOf("const handleSettle", deleteStart);
    const deleteSource = appSource.slice(deleteStart, deleteEnd);
    assert.ok(deleteStart >= 0 && deleteEnd > deleteStart);
    assert.match(deleteSource, /if \(isWorktree && \(isStreaming \|\| isSending\)\)/);
    assert.match(deleteSource, /worktreeDeleteBusyRef\.current\.add\(id\)/);
    assert.ok(
      deleteSource.indexOf("await gitWorktreeRemove") <
        deleteSource.indexOf("setThreads"),
    );
    assert.match(appSource, /worktreeThreads\.length > 0/);
    assert.match(appSource, /worktreeCreateProjectIdRef\.current === id/);
  });

  it("keeps partial worktree removal as success with a visible warning", () => {
    const rustSource = readFileSync(
      join(root, "src-tauri/src/git.rs"),
      "utf8",
    );
    const deleteStart = appSource.indexOf("const handleDelete = async");
    const deleteEnd = appSource.indexOf("const handleSettle", deleteStart);
    const deleteSource = appSource.slice(deleteStart, deleteEnd);

    assert.match(gitSource, /warning: string \| null/);
    assert.match(rustSource, /pub warning: Option<String>/);
    assert.doesNotMatch(
      rustSource,
      /unregister_dir\(&app, &result\.path\)[\s\S]*?\?;/,
    );
    assert.match(deleteSource, /const removal = await gitWorktreeRemove/);
    assert.match(deleteSource, /worktreeRemovalWarning = removal\.warning/);
    assert.ok(
      deleteSource.indexOf("worktreeRemovalWarning = removal.warning") <
        deleteSource.indexOf("setThreads"),
    );
  });

  it("only enables PR creation for a fully pushed feature branch", () => {
    assert.match(gitControlsSource, /!status\.isDefaultBranch/);
    assert.match(gitControlsSource, /status\.hasUpstream/);
    assert.match(gitControlsSource, /status\.aheadCount === 0/);
    assert.match(
      appSource,
      /await requestConfirmDialog\([\s\S]*?pull request/,
    );
    assert.doesNotMatch(appSource, /window\.confirm\(/);
    assert.match(appSource, /setGitPrUrl\(null\);[\s\S]*?activeWorkspacePath/);
    assert.match(gitControlsSource, /className="review-git__pr-url"/);
  });
});
