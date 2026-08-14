import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const targetDir = path.join(root, "src-tauri", "target-beta");

process.env.CARGO_TARGET_DIR = targetDir;

const build =
  process.platform === "win32"
    ? spawn("npm run build:beta", {
        cwd: root,
        stdio: "inherit",
        env: process.env,
        shell: true,
      })
    : spawn("npm", ["run", "build:beta"], {
        cwd: root,
        stdio: "inherit",
        env: process.env,
      });

build.on("exit", (code) => {
  if (code !== 0) process.exit(code ?? 1);

  const tauri =
    process.platform === "win32"
      ? spawn(
          "npx tauri dev --config src-tauri/tauri.beta.conf.json --no-watch",
          {
            cwd: root,
            stdio: "inherit",
            env: process.env,
            shell: true,
          },
        )
      : spawn(
          "npx",
          [
            "tauri",
            "dev",
            "--config",
            "src-tauri/tauri.beta.conf.json",
            "--no-watch",
          ],
          {
            cwd: root,
            stdio: "inherit",
            env: process.env,
          },
        );

  tauri.on("exit", (tauriCode) => process.exit(tauriCode ?? 0));
});
