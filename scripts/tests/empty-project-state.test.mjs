import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const app = readFileSync(new URL("../../src/App.tsx", import.meta.url), "utf8");
const welcome = readFileSync(
  new URL("../../src/components/Welcome.tsx", import.meta.url),
  "utf8",
);

test("the no-project state follows the current T3 add-project flow", () => {
  assert.match(welcome, /What should we work on\?/);
  assert.match(welcome, /Add a project to start your first thread\./);
  assert.match(welcome, /className="draft-hero__add"/);
  assert.match(
    app,
    /projects\.length > 0 \? \(\s*<div className="hero-stage__composer">/,
  );
});
