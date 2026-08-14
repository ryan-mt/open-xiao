import { APP_DISPLAY_NAME, APP_FAVICON_SRC } from "./branding";
import { isTauri as isTauriRuntime } from "./lib/isTauri";

export type DesktopNotifyKind = "complete" | "error";

const activeByTag = new Map<string, Notification>();
let nativePermission: NotifyPermissionState | null = null;
let audioContext: AudioContext | null = null;

/** True when the user is looking at the app (skip OS banner noise). */
export function isAppInView(): boolean {
  try {
    return (
      typeof document !== "undefined" &&
      document.visibilityState === "visible" &&
      typeof document.hasFocus === "function" &&
      document.hasFocus()
    );
  } catch {
    // Fail closed: treat as in-view so we do not spam banners.
    return true;
  }
}

export type NotifyPermissionState =
  | "unsupported"
  | "granted"
  | "denied"
  | "default";

export async function getNotifyPermission(): Promise<NotifyPermissionState> {
  if (isTauriRuntime()) {
    try {
      const { isPermissionGranted } = await import(
        "@tauri-apps/plugin-notification"
      );
      if (await isPermissionGranted()) {
        nativePermission = "granted";
        return "granted";
      }
      return nativePermission === "denied" ? "denied" : "default";
    } catch {
      return "unsupported";
    }
  }
  if (typeof window === "undefined" || !("Notification" in window)) {
    return "unsupported";
  }
  try {
    const p = Notification.permission;
    if (p === "granted" || p === "denied" || p === "default") return p;
    return "unsupported";
  } catch {
    return "unsupported";
  }
}

/** Prefer calling from a user gesture (e.g. enabling the setting). */
export async function ensureNotifyPermission(): Promise<boolean> {
  const state = await getNotifyPermission();
  if (state === "unsupported") return false;
  if (state === "granted") return true;
  if (state === "denied") return false;
  if (isTauriRuntime()) {
    try {
      const { requestPermission } = await import(
        "@tauri-apps/plugin-notification"
      );
      const next = await requestPermission();
      nativePermission =
        next === "granted"
          ? "granted"
          : next === "denied"
            ? "denied"
            : "default";
      return next === "granted";
    } catch {
      return false;
    }
  }
  try {
    const next = await Notification.requestPermission();
    return next === "granted";
  } catch {
    return false;
  }
}

function getAudioContext(): AudioContext | null {
  if (audioContext) return audioContext;
  if (typeof window === "undefined") return null;
  const AudioContextCtor =
    window.AudioContext ??
    (window as typeof window & { webkitAudioContext?: typeof AudioContext })
      .webkitAudioContext;
  if (!AudioContextCtor) return null;
  try {
    audioContext = new AudioContextCtor();
    return audioContext;
  } catch {
    return null;
  }
}

/** Unlock Web Audio on the first user gesture so delayed completion tones work. */
export function installNotificationSoundUnlock(): () => void {
  if (typeof window === "undefined") return () => undefined;
  const unlock = () => {
    const ctx = getAudioContext();
    if (ctx?.state === "suspended") void ctx.resume();
  };
  window.addEventListener("pointerdown", unlock, { passive: true });
  window.addEventListener("keydown", unlock);
  return () => {
    window.removeEventListener("pointerdown", unlock);
    window.removeEventListener("keydown", unlock);
  };
}

async function playNotificationSound(kind: DesktopNotifyKind): Promise<void> {
  const ctx = getAudioContext();
  if (!ctx) return;
  try {
    if (ctx.state === "suspended") await ctx.resume();
    if (ctx.state !== "running") return;
    const start = ctx.currentTime;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(0.055, start + 0.015);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.42);
    gain.connect(ctx.destination);

    const frequencies = kind === "error" ? [392, 294] : [659, 880];
    frequencies.forEach((frequency, index) => {
      const oscillator = ctx.createOscillator();
      oscillator.type = "sine";
      oscillator.frequency.setValueAtTime(frequency, start);
      oscillator.connect(gain);
      oscillator.start(start + index * 0.12);
      oscillator.stop(start + 0.3 + index * 0.12);
    });
  } catch {
    /* audio feedback is best-effort */
  }
}

async function focusAppWindow(): Promise<void> {
  try {
    window.focus();
  } catch {
    /* ignore */
  }
  if (!isTauriRuntime()) return;
  try {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    const win = getCurrentWindow();
    try {
      await win.unminimize();
    } catch {
      /* missing ACL / not minimized */
    }
    try {
      await win.show();
    } catch {
      /* missing ACL */
    }
    try {
      await win.setFocus();
    } catch {
      /* missing ACL */
    }
  } catch {
    /* non-desktop or API unavailable */
  }
}

export type NotifyAgentDoneOpts = {
  title: string;
  body: string;
  threadId: string;
  kind?: DesktopNotifyKind;
  /** Default true — no OS toast while the window is focused + visible. */
  skipIfInView?: boolean;
  onActivate?: (threadId: string) => void;
};

/**
 * Fire a system notification when an agent turn settles.
 * No-ops safely when unsupported, denied, or (by default) app is in view.
 */
export async function notifyAgentDone(
  opts: NotifyAgentDoneOpts,
): Promise<void> {
  const kind = opts.kind ?? "complete";
  await playNotificationSound(kind);

  if (opts.skipIfInView !== false && isAppInView()) return;

  const body = (opts.body || "").replace(/\s+/g, " ").trim().slice(0, 180);
  const title = (opts.title || APP_DISPLAY_NAME).trim().slice(0, 120);

  if (isTauriRuntime()) {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("agent_notify", {
        title,
        body,
      });
      return;
    } catch {
      /* fall through to the browser API if available */
    }
  }

  const permission = await getNotifyPermission();
  if (permission !== "granted") return;

  if (typeof window === "undefined" || !("Notification" in window)) return;

  let webPermission: NotificationPermission;
  try {
    webPermission = Notification.permission;
  } catch {
    return;
  }
  if (webPermission !== "granted") return;

  const tag = `grok-agent-${kind}-${opts.threadId}`;

  try {
    const prev = activeByTag.get(tag);
    if (prev) {
      try {
        prev.close();
      } catch {
        /* ignore */
      }
      activeByTag.delete(tag);
    }

    // `renotify` is widely supported but missing from older DOM lib typings.
    const n = new Notification(title, {
      body,
      icon: APP_FAVICON_SRC,
      tag,
      renotify: true,
    } as NotificationOptions);
    activeByTag.set(tag, n);

    n.onclick = () => {
      void focusAppWindow();
      try {
        opts.onActivate?.(opts.threadId);
      } catch {
        /* never let activate crash the handler */
      }
      try {
        n.close();
      } catch {
        /* ignore */
      }
      if (activeByTag.get(tag) === n) activeByTag.delete(tag);
    };

    n.onerror = () => {
      if (activeByTag.get(tag) === n) activeByTag.delete(tag);
    };

    n.onclose = () => {
      if (activeByTag.get(tag) === n) activeByTag.delete(tag);
    };
  } catch {
    /* constructor throws if permission revoked mid-flight */
  }
}
