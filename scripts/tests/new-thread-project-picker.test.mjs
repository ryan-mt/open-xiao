import assert from "node:assert/strict";
import test from "node:test";

import {
  filterNewThreadProjects,
  shouldOpenNewThreadProjectPicker,
} from "../../src/components/newThreadProjectPicker.ts";

const projects = [
  { id: "grokapp", name: "grokapp", path: "C:/Users/nguye/projects/grokapp" },
  { id: "home", name: "nguye", path: "C:/Users/nguye" },
];

test("All projects opens the project picker only when there is a choice", () => {
  assert.equal(shouldOpenNewThreadProjectPicker("all", 2), true);
  assert.equal(shouldOpenNewThreadProjectPicker("all", 2, true), false);
  assert.equal(shouldOpenNewThreadProjectPicker("all", 1), false);
  assert.equal(shouldOpenNewThreadProjectPicker("all", 0), false);
  assert.equal(shouldOpenNewThreadProjectPicker("grokapp", 2), false);
  assert.equal(shouldOpenNewThreadProjectPicker("inbox", 2), false);
});

test("project picker search matches project name and path", () => {
  assert.deepEqual(filterNewThreadProjects(projects, ""), projects);
  assert.deepEqual(filterNewThreadProjects(projects, "GROK"), [projects[0]]);
  assert.deepEqual(filterNewThreadProjects(projects, "users/nguye"), projects);
  assert.deepEqual(filterNewThreadProjects(projects, "missing"), []);
});
