import assert from "node:assert/strict";
import test from "node:test";
import {
  buildProjectFileTree,
  closeProjectFileTab,
  filePreviewLanguage,
  filterProjectFileTree,
  openProjectFileTab,
  settleOwnedProjectEntriesRequest,
} from "../../src/projectFiles.ts";

const entries = [
  { path: "src", name: "src", parent: "", isDir: true },
  { path: "src/App.tsx", name: "App.tsx", parent: "src", isDir: false },
  { path: "src/lib", name: "lib", parent: "src", isDir: true },
  {
    path: "src/lib/theme.ts",
    name: "theme.ts",
    parent: "src/lib",
    isDir: false,
  },
  { path: "package.json", name: "package.json", parent: "", isDir: false },
];

test("project file tree keeps directories first and preserves nested paths", () => {
  const tree = buildProjectFileTree(entries);
  assert.deepEqual(
    tree.map((node) => node.path),
    ["src", "package.json"],
  );
  assert.deepEqual(
    tree[0].children.map((node) => node.path),
    ["src/lib", "src/App.tsx"],
  );
});

test("file search keeps matching ancestors but removes unrelated siblings", () => {
  const tree = filterProjectFileTree(buildProjectFileTree(entries), "theme");
  assert.deepEqual(
    tree.map((node) => node.path),
    ["src"],
  );
  assert.deepEqual(
    tree[0].children.map((node) => node.path),
    ["src/lib"],
  );
  assert.deepEqual(
    tree[0].children[0].children.map((node) => node.path),
    ["src/lib/theme.ts"],
  );
});

test("file tabs reuse open paths and choose a deterministic fallback on close", () => {
  assert.deepEqual(openProjectFileTab(["src/App.tsx"], "src/App.tsx"), [
    "src/App.tsx",
  ]);
  const opened = openProjectFileTab(["src/App.tsx"], "package.json");
  assert.deepEqual(opened, ["src/App.tsx", "package.json"]);
  assert.deepEqual(
    closeProjectFileTab(opened, "package.json", "package.json"),
    {
      openPaths: ["src/App.tsx"],
      activePath: "src/App.tsx",
    },
  );
});

test("file preview maps common source extensions to highlight grammars", () => {
  assert.equal(filePreviewLanguage("src/App.tsx"), "typescript");
  assert.equal(filePreviewLanguage("package.json"), "json");
  assert.equal(filePreviewLanguage("README.md"), "markdown");
  assert.equal(filePreviewLanguage("LICENSE"), "text");
});

test("an older workspace response cannot overwrite the latest file entries", async () => {
  const deferred = () => {
    let resolve;
    const promise = new Promise((next) => {
      resolve = next;
    });
    return { promise, resolve };
  };
  const requestA = deferred();
  const requestB = deferred();
  let activeWorkspace = "A";
  let currentRequestId = 1;
  let renderedEntries = [];
  let loading = true;

  const load = (workspace, requestId, request) =>
    settleOwnedProjectEntriesRequest(request.promise, {
      isCurrent: () =>
        requestId === currentRequestId && workspace === activeWorkspace,
      onSuccess: (next) => {
        renderedEntries = next;
      },
      onError: () => assert.fail("unexpected load error"),
      onSettled: () => {
        loading = false;
      },
    });

  const pendingA = load("A", 1, requestA);
  activeWorkspace = "B";
  currentRequestId = 2;
  loading = true;
  const pendingB = load("B", 2, requestB);

  requestB.resolve([{ path: "B/file.ts" }]);
  await pendingB;
  requestA.resolve([{ path: "A/file.ts" }]);
  await pendingA;

  assert.deepEqual(renderedEntries, [{ path: "B/file.ts" }]);
  assert.equal(loading, false);
});
