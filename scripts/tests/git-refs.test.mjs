import assert from "node:assert/strict";
import test from "node:test";

import {
  filterGitRefs,
  resolveWorktreeBaseRef,
} from "../../src/gitRefs.ts";

const refs = [
  {
    name: "refs/heads/main",
    shortName: "main",
    kind: "local",
    current: true,
  },
  {
    name: "refs/heads/feature/search",
    shortName: "feature/search",
    kind: "local",
    current: false,
  },
  {
    name: "refs/remotes/origin/main",
    shortName: "origin/main",
    kind: "remote",
    current: false,
  },
];

test("worktree base ref keeps an available selection and otherwise uses current", () => {
  assert.equal(
    resolveWorktreeBaseRef(refs, "refs/heads/feature/search"),
    "refs/heads/feature/search",
  );
  assert.equal(resolveWorktreeBaseRef(refs, "refs/heads/missing"), "refs/heads/main");
  assert.equal(resolveWorktreeBaseRef([], null), null);
});

test("ref search matches short names and keeps local refs before remotes", () => {
  assert.deepEqual(
    filterGitRefs(refs, "main").map((ref) => ref.name),
    ["refs/heads/main", "refs/remotes/origin/main"],
  );
  assert.deepEqual(
    filterGitRefs(refs, "origin").map((ref) => ref.name),
    ["refs/remotes/origin/main"],
  );
});
