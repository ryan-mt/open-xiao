import { invoke } from "@tauri-apps/api/core";
import { isTauri } from "./lib/isTauri";
import { rollingActivityStats } from "./profileActivity";

export type UserProfile = {
  id: number;
  name: string;
  avatarDataUrl: string | null;
  createdAt: number;
  updatedAt: number;
};

export type DayCount = {
  date: string;
  count: number;
  tokenCount: number;
};

export type ProfileStats = {
  currentStreak: number;
  longestStreak: number;
  totalActiveDays: number;
  totalMessages: number;
  totalOpenAITokens: number;
  days: DayCount[];
};

/** Local-day key YYYY-MM-DD for streak recording. */
export function localDayKey(d = new Date()): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export async function getProfile(): Promise<UserProfile | null> {
  if (!isTauri()) {
    try {
      const raw = localStorage.getItem("grok-profile");
      if (!raw) return null;
      return JSON.parse(raw) as UserProfile;
    } catch {
      return null;
    }
  }
  return invoke<UserProfile | null>("profile_get");
}

export async function createProfile(name: string): Promise<UserProfile> {
  if (!isTauri()) {
    const now = Date.now();
    const p: UserProfile = {
      id: 1,
      name: name.trim(),
      avatarDataUrl: null,
      createdAt: now,
      updatedAt: now,
    };
    localStorage.setItem("grok-profile", JSON.stringify(p));
    return p;
  }
  return invoke<UserProfile>("profile_create", { name });
}

export async function updateProfile(opts: {
  name?: string;
  avatarDataUrl?: string | null;
  clearAvatar?: boolean;
}): Promise<UserProfile> {
  if (!isTauri()) {
    const cur = await getProfile();
    if (!cur) throw new Error("No profile yet");
    const next: UserProfile = {
      ...cur,
      name: opts.name?.trim() || cur.name,
      avatarDataUrl: opts.clearAvatar
        ? null
        : opts.avatarDataUrl !== undefined
          ? opts.avatarDataUrl
          : cur.avatarDataUrl,
      updatedAt: Date.now(),
    };
    localStorage.setItem("grok-profile", JSON.stringify(next));
    return next;
  }
  return invoke<UserProfile>("profile_update", {
    name: opts.name,
    avatarDataUrl: opts.avatarDataUrl ?? null,
    clearAvatar: opts.clearAvatar ?? false,
  });
}

export async function getProfileStats(days = 371): Promise<ProfileStats> {
  if (!isTauri()) {
    try {
      const raw = localStorage.getItem("grok-activity");
      const map = raw ? (JSON.parse(raw) as Record<string, number>) : {};
      const tokenRaw = localStorage.getItem("grok-openai-token-activity");
      const tokenMap = tokenRaw
        ? (JSON.parse(tokenRaw) as Record<string, number>)
        : {};
      return rollingActivityStats(map, tokenMap, days);
    } catch {
      return {
        currentStreak: 0,
        longestStreak: 0,
        totalActiveDays: 0,
        totalMessages: 0,
        totalOpenAITokens: 0,
        days: [],
      };
    }
  }
  return invoke<ProfileStats>("profile_stats", {
    days,
    today: localDayKey(),
  });
}

export async function recordActivity(amount = 1): Promise<void> {
  const day = localDayKey();
  if (!isTauri()) {
    try {
      const raw = localStorage.getItem("grok-activity");
      const map = raw ? (JSON.parse(raw) as Record<string, number>) : {};
      map[day] = (map[day] ?? 0) + amount;
      localStorage.setItem("grok-activity", JSON.stringify(map));
    } catch {
      /* ignore */
    }
    return;
  }
  await invoke("profile_record_activity", { day, amount });
}

export async function recordOpenAITokenActivity(amount: number): Promise<void> {
  if (!Number.isFinite(amount) || amount <= 0) return;
  const tokens = Math.floor(amount);
  const day = localDayKey();
  if (!isTauri()) {
    try {
      const raw = localStorage.getItem("grok-openai-token-activity");
      const map = raw ? (JSON.parse(raw) as Record<string, number>) : {};
      map[day] = (map[day] ?? 0) + tokens;
      localStorage.setItem("grok-openai-token-activity", JSON.stringify(map));
    } catch {
      /* ignore */
    }
    return;
  }
  await invoke("profile_record_openai_tokens", { day, amount: tokens });
}

/** Compress image file to a reasonable data URL for avatar storage. */
export function fileToAvatarDataUrl(file: File, maxPx = 256): Promise<string> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      try {
        const scale = Math.min(1, maxPx / Math.max(img.width, img.height));
        const w = Math.max(1, Math.round(img.width * scale));
        const h = Math.max(1, Math.round(img.height * scale));
        const canvas = document.createElement("canvas");
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext("2d");
        if (!ctx) {
          reject(new Error("Canvas unavailable"));
          return;
        }
        ctx.drawImage(img, 0, 0, w, h);
        resolve(canvas.toDataURL("image/jpeg", 0.88));
      } catch (e) {
        reject(e instanceof Error ? e : new Error(String(e)));
      } finally {
        URL.revokeObjectURL(url);
      }
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("Could not read image"));
    };
    img.src = url;
  });
}
