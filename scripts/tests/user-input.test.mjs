import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  normalizeUserInputAnswers,
  userInputAnswersComplete,
} from "../../src/userInput.ts";

const request = {
  requestId: "req-1",
  questions: [
    {
      header: "Runtime",
      question: "Which runtime?",
      options: [{ label: "OpenCode", description: "Use the CLI" }],
      multiple: false,
      custom: true,
    },
    {
      header: "Checks",
      question: "Which checks?",
      options: [
        { label: "Tests", description: "Run tests" },
        { label: "Build", description: "Run build" },
      ],
      multiple: true,
      custom: false,
    },
  ],
};

test("structured answers preserve question order and single-choice semantics", () => {
  const answers = normalizeUserInputAnswers(
    request,
    [["OpenCode"], ["Tests", "Build", "Tests"]],
    ["Native", ""],
  );
  assert.deepEqual(answers, [["Native"], ["Tests", "Build"]]);
  assert.equal(userInputAnswersComplete(answers), true);
  assert.equal(userInputAnswersComplete([["Native"], []]), false);
});

test("native stream events are wired through IPC, app state, and the composer", async () => {
  const [auth, app, composer] = await Promise.all([
    readFile(new URL("../../src/auth.ts", import.meta.url), "utf8"),
    readFile(new URL("../../src/App.tsx", import.meta.url), "utf8"),
    readFile(new URL("../../src/components/Composer.tsx", import.meta.url), "utf8"),
  ]);

  assert.match(auth, /case "user_input_requested"/);
  assert.match(auth, /invoke\("chat_user_input_reply"/);
  assert.match(auth, /invoke\("chat_user_input_reject"/);
  assert.match(app, /onUserInput: \(request\) =>/);
  assert.match(app, /pendingUserInput=\{pendingUserInput\}/);
  assert.match(composer, /<UserInputDock/);
});

test("only the current stream generation clears its pending user input", async () => {
  const app = await readFile(
    new URL("../../src/App.tsx", import.meta.url),
    "utf8",
  );
  const finallyBlock = app.slice(
    app.indexOf("    } finally {", app.indexOf("const runStream")),
    app.indexOf("      if (!genLive) return;", app.indexOf("const runStream")),
  );
  const ownershipCheck = finallyBlock.indexOf(
    "const genLive = streamGenByThreadRef.current.get(convId) === gen;",
  );
  const cleanup = finallyBlock.indexOf("if (genLive) clearPendingUserInput(convId);");

  assert.ok(ownershipCheck >= 0, "stream finally should resolve generation ownership");
  assert.ok(cleanup > ownershipCheck, "pending input cleanup must belong to the live generation");
});

test("answer submission busy state is scoped to its owning thread", async () => {
  const app = await readFile(
    new URL("../../src/App.tsx", import.meta.url),
    "utf8",
  );

  assert.match(app, /const \[userInputBusyByThread, setUserInputBusyByThread\]/);
  assert.match(app, /if \(!request \|\| userInputBusyByThread\[sid\]\) return;/);
  assert.doesNotMatch(app, /userInputBusyId/);
});
