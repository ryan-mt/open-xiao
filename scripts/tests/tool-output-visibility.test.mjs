import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const messageList = readFileSync(
  join(root, "src/components/MessageList.tsx"),
  "utf8",
);

test("live command output stays collapsed until the user expands it", () => {
  const toolRow = messageList.slice(
    messageList.indexOf("function ToolCallRow("),
    messageList.indexOf("function toolPresentation("),
  );

  assert.doesNotMatch(
    toolRow,
    /toolActivityKind\(call\.name\) === "command"[\s\S]*?setOpen\(true\)/,
  );
});
