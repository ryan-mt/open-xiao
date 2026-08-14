import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const styles = readFileSync(new URL("../../src/styles.css", import.meta.url), "utf8");
const composer = readFileSync(
  new URL("../../src/components/Composer.tsx", import.meta.url),
  "utf8",
);
const modelSelect = readFileSync(
  new URL("../../src/components/ModelSelect.tsx", import.meta.url),
  "utf8",
);

function cssRule(selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return styles.match(new RegExp(`${escaped}\\s*\\{([\\s\\S]*?)\\}`))?.[1] ?? "";
}

test("composer keeps the nested frame with a restrained focus outline", () => {
  assert.match(cssRule(".composer__shell"), /border-radius:\s*22px/);
  assert.match(cssRule(".composer__surface"), /border-radius:\s*20px/);
  assert.match(
    cssRule(".composer__shell:has(.composer__input:focus) .composer__surface::after"),
    /border-color:/,
  );
});

test("send control keeps compact geometry with Xiao color and quiet focus state", () => {
  assert.match(cssRule(".composer__shell"), /--composer-send:\s*#2f65d9/);
  const send = cssRule(".composer__send");
  assert.match(send, /border-radius:\s*9999px/);
  assert.match(send, /border:\s*1px solid/);
  assert.match(send, /background:\s*var\(--composer-send\)/);
  assert.match(send, /box-shadow:\s*inset/);
  assert.match(
    cssRule(".composer__send:focus-visible"),
    /background:\s*var\(--composer-send-hover\)/,
  );
  assert.match(
    cssRule(".composer__send:not\(:disabled\):active"),
    /scale\(1\)/,
  );
});

test("composer footer follows the full control grouping", () => {
  assert.doesNotMatch(composer, /className="composer__ctrl"/);
  assert.doesNotMatch(modelSelect, /className={`msel__perm/);

  const modelControls = modelSelect.slice(modelSelect.indexOf("return ("));
  assert.ok(
    modelControls.indexOf("msel__access") < modelControls.indexOf("msel__agent"),
    "access should render before Build/Plan",
  );

  assert.doesNotMatch(composer, /composer__tasks/);
  assert.match(modelSelect, /accessFull \? "Full access" : "Workspace"/);
});

test("keyboard focus highlights one footer control without drawing stray lines", () => {
  assert.doesNotMatch(
    styles,
    /\.composer__shell:focus-within \.composer__surface::after/,
  );
  assert.match(
    styles,
    /\.composer__shell:has\(\.composer__input:focus\) \.composer__surface::after/,
  );
  assert.match(
    styles,
    /\.msel__trigger:focus-visible,[\s\S]*?\.msel__agent:focus-visible[\s\S]*?outline:\s*none/,
  );
});
