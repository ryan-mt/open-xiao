import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
export default defineConfig(async ({ mode }) => {
  // @ts-expect-error process is a nodejs global
  const envStage = process.env.VITE_APP_STAGE?.trim().toLowerCase();
  const stage =
    envStage ||
    (mode === "beta" ? "beta" : mode === "production" ? "latest" : "dev");

  return {
    plugins: [react()],
    define: {
      "import.meta.env.VITE_APP_STAGE": JSON.stringify(stage),
    },

    build: {
      rollupOptions: {
        output: {
          onlyExplicitManualChunks: true,
          manualChunks(id) {
            const moduleId = id.replaceAll("\\", "/");
            if (!moduleId.includes("/node_modules/")) return;
            if (moduleId.includes("/highlight.js/")) return "hljs";
            if (moduleId.includes("/node_modules/@xterm/")) return "terminal";
            if (moduleId.includes("/node_modules/@tauri-apps/")) return "tauri";
            if (moduleId.includes("/node_modules/lucide-react/")) return "icons";
            if (
              moduleId.includes("/node_modules/react-dom/") ||
              moduleId.includes("/node_modules/react/") ||
              moduleId.includes("/node_modules/scheduler/")
            ) {
              return "react";
            }
            return "vendor";
          },
        },
      },
    },

    // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
    //
    // 1. prevent Vite from obscuring rust errors
    clearScreen: false,
    // 2. tauri expects a fixed port, fail if that port is not available
    server: {
      port: 1420,
      strictPort: true,
      host: host || false,
      hmr: host
        ? {
            protocol: "ws",
            host,
            port: 1421,
          }
        : undefined,
      watch: {
        // 3. tell Vite to ignore watching `src-tauri`
        ignored: ["**/src-tauri/**"],
      },
    },
  };
});
