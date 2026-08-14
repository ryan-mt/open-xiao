export type AppStage = "dev" | "beta" | "latest";

const raw =
  (import.meta.env.VITE_APP_STAGE as string | undefined)?.trim().toLowerCase() ??
  "";

export const APP_STAGE: AppStage =
  raw === "beta" || raw === "nightly"
    ? "beta"
    : raw === "latest" || raw === "official"
      ? "latest"
      : raw === "dev"
        ? "dev"
        : import.meta.env.DEV
          ? "dev"
          : "latest";

export const APP_STAGE_LABEL =
  APP_STAGE === "beta" ? "Beta" : APP_STAGE === "dev" ? "Dev" : null;

export const APP_ENVIRONMENT_LABEL = APP_STAGE_LABEL ?? "Official";

export const APP_BASE_NAME = "Open Xiao";

export const APP_DISPLAY_NAME = APP_STAGE_LABEL
  ? `${APP_BASE_NAME} (${APP_STAGE_LABEL})`
  : APP_BASE_NAME;

/** Beta and official channels use their matching artwork. */
export const APP_ICON_VARIANT: "nightly" | "official" =
  APP_STAGE === "beta" ? "nightly" : "official";

export const APP_BRAND_LOGO_SRC =
  APP_ICON_VARIANT === "nightly" ? "/logonew_nightly.png" : "/logonew_offical.png";

export const APP_FAVICON_SRC =
  APP_ICON_VARIANT === "nightly"
    ? "/grok-favicon-nightly.png"
    : "/grok-favicon-official.png";
