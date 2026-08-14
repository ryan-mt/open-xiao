import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  needsOrdinaryThreadForProjectSelection,
  rebindThreadProjectOnSelection,
} from "../../src/app/projectSelection.ts";
import { syncSidebarProjectScope } from "../../src/components/Sidebar.logic.ts";
import { workspaceValueForPath } from "../../src/gitWorkspace.ts";
import { createThread } from "../../src/types.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const read = (path) => readFileSync(join(root, path), "utf8");

test("Git snapshots are visible only for their owning workspace", () => {
  const status = { fileCount: 54, additions: 3663, deletions: 437 };
  assert.equal(
    workspaceValueForPath(status, "C:/projects/grokapp", "C:/projects/xiao"),
    null,
  );
  assert.equal(
    workspaceValueForPath(status, "C:/projects/grokapp", "C:/projects/grokapp"),
    status,
  );
});

test("Project selection rebinds drafts and adopts only unowned threads", () => {
  const empty = createThread("grokapp", "New chat");
  const rebound = rebindThreadProjectOnSelection(empty, "xiao", 123);
  assert.equal(rebound.projectId, "xiao");
  assert.equal(rebound.updatedAt, 123);

  const populated = {
    ...empty,
    messages: [
      {
        id: "message",
        role: "user",
        content: "keep this thread in grokapp",
        createdAt: 1,
      },
    ],
  };
  assert.equal(rebindThreadProjectOnSelection(populated, "xiao"), populated);

  const inbox = { ...populated, projectId: null };
  const adopted = rebindThreadProjectOnSelection(inbox, "xiao", 456);
  assert.equal(adopted.projectId, "xiao");
  assert.equal(adopted.updatedAt, 456);
  assert.equal(rebindThreadProjectOnSelection(populated, null), populated);

  const worktree = {
    ...empty,
    worktreePath: "C:/worktrees/xiao-task",
    worktreeBranch: "xiao/task",
  };
  assert.equal(rebindThreadProjectOnSelection(worktree, "xiao"), worktree);
  assert.equal(needsOrdinaryThreadForProjectSelection(worktree, "xiao"), true);
  assert.equal(
    needsOrdinaryThreadForProjectSelection(worktree, "grokapp"),
    false,
  );
  assert.equal(
    needsOrdinaryThreadForProjectSelection(populated, "xiao"),
    false,
  );
});

test("Sidebar project scope follows the project selected elsewhere", () => {
  const projects = ["grokapp", "xiao"];
  assert.equal(syncSidebarProjectScope("grokapp", "xiao", projects), "xiao");
  assert.equal(syncSidebarProjectScope("all", "xiao", projects), "all");
  assert.equal(syncSidebarProjectScope("inbox", "xiao", projects), "inbox");
  assert.equal(syncSidebarProjectScope("removed", null, projects), "all");
});

test("Sidebar project selection resolves thread ownership before its next send", () => {
  const app = read("src/App.tsx");
  assert.match(
    app,
    /const handleProjectSelection = useCallback\([\s\S]*?rebindThreadProjectOnSelection\(thread, projectId\)/,
  );
  assert.match(
    app,
    /onSelectProject=\{\(projectId\) => \{\s*handleProjectSelection\(projectId\);\s*if \(isNarrowViewport\) setMobileSidebarOpen\(false\);\s*\}\}/,
  );
  assert.match(app, /onSelectProject=\{handleProjectSelection\}/);

  const sidebar = read("src/components/Sidebar.tsx");
  const selectThread = sidebar.slice(
    sidebar.indexOf("const selectThread = useCallback"),
    sidebar.indexOf("const beginRowExit = useCallback"),
  );
  assert.doesNotMatch(selectThread, /onSelectProject\(t\.projectId\)/);
});

test("project removal waits for backend unregister and rejects active work", () => {
  const app = read("src/App.tsx");
  const auth = read("src/auth.ts");
  const removal = app.slice(
    app.indexOf("const handleRemoveProject"),
    app.indexOf("const handleToggleProject"),
  );

  assert.match(removal, /const handleRemoveProject = async/);
  assert.match(removal, /streamingThreadIdsRef\.current\.includes/);
  assert.match(removal, /sendingByThreadRef\.current\.has/);
  assert.match(removal, /sendQueueRef\.current\.some/);

  const unregisterAt = removal.indexOf("await unregisterProjectRoot");
  const removeStateAt = removal.indexOf("setProjects(");
  assert.ok(unregisterAt >= 0);
  assert.ok(removeStateAt > unregisterAt);
  assert.match(removal, /catch \(error\) \{[\s\S]*?Could not remove project/);
  assert.match(
    auth,
    /export async function unregisterProjectRoot[\s\S]*?await invoke\("project_unregister"[\s\S]*?\n\}/,
  );
  assert.doesNotMatch(
    auth.slice(
      auth.indexOf("export async function unregisterProjectRoot"),
      auth.indexOf("export async function onDeviceCode"),
    ),
    /catch/,
  );
});
