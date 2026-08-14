import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import {
  applyAppearancePreferences,
  loadAppearancePreferences,
} from "./appearance";
import { APP_DISPLAY_NAME, APP_FAVICON_SRC } from "./branding";
import { ToastProvider } from "./toast";
import { applyTheme, loadTheme } from "./theme";

const themeReady = applyTheme(loadTheme());
applyAppearancePreferences(loadAppearancePreferences());
document.title = APP_DISPLAY_NAME;

const favicon = document.querySelector<HTMLLinkElement>("link[rel='icon']");
if (favicon) favicon.href = APP_FAVICON_SRC;

// Desktop app: hide browser-style right-click menu.
document.addEventListener("contextmenu", (e) => {
  e.preventDefault();
});

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <ToastProvider>
      <App />
    </ToastProvider>
  </React.StrictMode>,
);

if ("__TAURI_INTERNALS__" in window) {
  void (async () => {
    try {
      await themeReady;
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      const { getCurrentWindow } = await import("@tauri-apps/api/window");
      await getCurrentWindow().show();
    } catch {
      // Rust reveals the window after a timeout if frontend bootstrap fails.
    }
  })();
}
