import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const messageList = fs.readFileSync(
  path.join(root, "src/components/MessageList.tsx"),
  "utf8",
);
const app = fs.readFileSync(path.join(root, "src/App.tsx"), "utf8");
const composer = fs.readFileSync(
  path.join(root, "src/components/Composer.tsx"),
  "utf8",
);
const rightPanel = fs.readFileSync(
  path.join(root, "src/components/RightPanelControls.tsx"),
  "utf8",
);
const styles = fs.readFileSync(path.join(root, "src/styles.css"), "utf8");

test("todo plan is an inline folded timeline row", () => {
  assert.match(messageList, /const \[open, setOpen\] = useState\(false\)/);
  assert.match(messageList, /planInlineSummary\(expanded\.steps\)/);
  assert.match(messageList, /className="tool-plan__segments"/);
  assert.match(messageList, /className="tool-plan__chev"/);
  assert.match(messageList, /className="tool-plan__count"/);
  assert.doesNotMatch(messageList, /todoAutoOpenedRef/);
  assert.doesNotMatch(messageList, /C2\.22386 14 2 13\.5V2\.5/);
  assert.match(messageList, /<rect[\s\S]*?width="12"[\s\S]*?height="12"/);
});

test("inline plan uses yellow active and green completed progress", () => {
  assert.match(styles, /--tool-plan-complete:\s*#16a34a/);
  assert.match(styles, /--tool-plan-active:\s*#d99a23/);
  assert.match(styles, /\.dark \.tool-row\.is-todo\s*\{[^}]*#34d399[^}]*#f5c451/);
  assert.match(
    styles,
    /\.tool-plan__segment\.is-completed\s*\{[^}]*var\(--tool-plan-complete\)/,
  );
  assert.match(
    styles,
    /\.tool-plan__segment\.is-inProgress\s*\{[^}]*var\(--tool-plan-active\)/,
  );
  assert.match(
    styles,
    /\.tool-todo__ico--done\s*\{[^}]*var\(--tool-plan-complete\)/,
  );
  assert.match(
    styles,
    /\.tool-todo__ico--active\s*\{[^}]*var\(--tool-plan-active\)/,
  );
  assert.doesNotMatch(
    styles,
    /\.tool-todo__item\.is-inProgress\s*\{[^}]*var\(--tool-plan-active\)/,
  );
});

test("inline plan removes the old Tasks panel", () => {
  assert.doesNotMatch(styles, /\.plan-sidebar\b/);
  assert.doesNotMatch(styles, /\.composer__tasks\b/);
  assert.doesNotMatch(app, /PlanSidebar|planSidebarOpen/);
  assert.doesNotMatch(composer, /onOpenTasks|tasksOpen|taskProgress/);
  assert.match(rightPanel, /RightPanelPage = "review" \| "browser"/);
  assert.doesNotMatch(rightPanel, /PlanIcon|No tasks yet/);
});
