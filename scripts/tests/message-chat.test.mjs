import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";

registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      if (specifier.startsWith(".") && !/\.[a-z]+$/i.test(specifier)) {
        return nextResolve(`${specifier}.ts`, context);
      }
      throw error;
    }
  },
});

const { agentNotificationBody } = await import("../../src/app/messageChat.ts");

test("agent notifications never expose prompt-derived thread titles", () => {
  const secret = "CONFIDENTIAL local-canary customer source";
  const complete = agentNotificationBody("complete", secret);
  const error = agentNotificationBody("error", secret, "token=also-secret");

  assert.equal(complete, "Open the app to review the result.");
  assert.equal(error, "Open the app to review the error.");
  assert.doesNotMatch(`${complete} ${error}`, /CONFIDENTIAL|token=/);
});
