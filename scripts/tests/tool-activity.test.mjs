import assert from "node:assert/strict";
import test from "node:test";

import { toolActivityKind } from "../../src/toolActivity.ts";

test("provider lifecycle tool types map to stable Open Xiao groups", () => {
  assert.equal(toolActivityKind("command_execution"), "command");
  assert.equal(toolActivityKind("file_change"), "file_change");
  assert.equal(toolActivityKind("mcp_tool_call"), "mcp");
  assert.equal(toolActivityKind("dynamic_tool_call"), "other");
  assert.equal(toolActivityKind("collab_agent_tool_call"), "task");
  assert.equal(toolActivityKind("web_search"), "search");
  assert.equal(toolActivityKind("image_view"), "image");
});

test("native and OpenCode names classify without case or separator drift", () => {
  assert.equal(toolActivityKind("Bash"), "command");
  assert.equal(toolActivityKind("multi-edit"), "file_change");
  assert.equal(toolActivityKind("Read_File"), "read");
  assert.equal(toolActivityKind("WebFetch"), "search");
  assert.equal(toolActivityKind("spawn_subagent"), "task");
  assert.equal(toolActivityKind("TodoWrite"), "todo");
});
