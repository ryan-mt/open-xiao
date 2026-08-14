import type { ImageAttachment } from "./types.ts";
import { createId } from "./types.ts";

const KEY = "open-xiao.prompt-stash.v1";
const MAX_ENTRIES = 20;
const MAX_IMAGE_DATA_URL = 1_300_000;
const MAX_ENTRY_ATTACHMENT_CHARS = 2_700_000;
const MAX_IMAGE_DIMENSION = 2048;
const QUALITY_STEPS = [0.92, 0.85, 0.78, 0.68] as const;
const SCALE_STEPS = [1, 0.75, 0.55] as const;

export type StashEntry = {
  id: string;
  createdAt: number;
  prompt: string;
  attachments: ImageAttachment[];
  droppedNames: string[];
};

function partitionAttachments(atts: ImageAttachment[]): {
  attachments: ImageAttachment[];
  droppedNames: string[];
} {
  const attachments: ImageAttachment[] = [];
  const droppedNames: string[] = [];
  let usedChars = 0;
  for (const a of atts) {
    if (usedChars + a.dataUrl.length > MAX_ENTRY_ATTACHMENT_CHARS) {
      droppedNames.push(a.name || "image");
      continue;
    }
    usedChars += a.dataUrl.length;
    attachments.push(a);
  }
  return { attachments, droppedNames };
}

function nameForMime(name: string, mime: string): string {
  const extension = mime === "image/webp" ? ".webp" : ".jpg";
  const dot = name.lastIndexOf(".");
  return `${dot > 0 ? name.slice(0, dot) : name}${extension}`;
}

async function compressAttachment(
  attachment: ImageAttachment,
): Promise<ImageAttachment | null> {
  if (attachment.dataUrl.length <= MAX_IMAGE_DATA_URL) return attachment;
  if (typeof document === "undefined" || typeof Image === "undefined") return null;

  const image = new Image();
  try {
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(new Error("Could not decode image"));
      image.src = attachment.dataUrl;
    });
  } catch {
    return null;
  }

  const baseDimension = Math.min(
    MAX_IMAGE_DIMENSION,
    Math.max(image.naturalWidth, image.naturalHeight),
  );
  for (const scale of SCALE_STEPS) {
    const dimension = Math.max(1, Math.round(baseDimension * scale));
    const ratio = Math.min(
      1,
      dimension / Math.max(image.naturalWidth, image.naturalHeight),
    );
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(image.naturalWidth * ratio));
    canvas.height = Math.max(1, Math.round(image.naturalHeight * ratio));
    const context = canvas.getContext("2d");
    if (!context) return null;

    let mime = "image/webp";
    try {
      if (!canvas.toDataURL(mime, QUALITY_STEPS[0]).startsWith(`data:${mime}`)) {
        mime = "image/jpeg";
        context.fillStyle = "#fff";
        context.fillRect(0, 0, canvas.width, canvas.height);
      }
      context.drawImage(image, 0, 0, canvas.width, canvas.height);
      for (const quality of QUALITY_STEPS) {
        const dataUrl = canvas.toDataURL(mime, quality);
        if (dataUrl.length <= MAX_IMAGE_DATA_URL) {
          return {
            ...attachment,
            name: nameForMime(attachment.name, mime),
            mime,
            dataUrl,
          };
        }
      }
    } catch {
      continue;
    }
  }
  return null;
}

export async function prepareStashAttachments(
  attachments: ImageAttachment[],
): Promise<{ attachments: ImageAttachment[]; droppedNames: string[] }> {
  const candidates: ImageAttachment[] = [];
  const droppedNames: string[] = [];
  for (const attachment of attachments) {
    const compressed = await compressAttachment(attachment);
    if (compressed) candidates.push(compressed);
    else droppedNames.push(attachment.name || "image");
  }
  const partitioned = partitionAttachments(candidates);
  return {
    attachments: partitioned.attachments,
    droppedNames: [...droppedNames, ...partitioned.droppedNames],
  };
}

export function mergeStashAttachments(
  current: ImageAttachment[],
  stashed: ImageAttachment[],
  limit = 8,
): ImageAttachment[] | null {
  const ids = new Set(current.map((attachment) => attachment.id));
  const payloads = new Set(
    current.map(
      (attachment) =>
        `${attachment.mime}\u0000${attachment.name}\u0000${attachment.dataUrl}`,
    ),
  );
  const merged = [...current];
  for (const attachment of stashed) {
    const payload = `${attachment.mime}\u0000${attachment.name}\u0000${attachment.dataUrl}`;
    if (ids.has(attachment.id) || payloads.has(payload)) continue;
    merged.push(attachment);
    ids.add(attachment.id);
    payloads.add(payload);
  }
  return merged.length <= limit ? merged : null;
}

function read(): StashEntry[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((value): value is StashEntry => {
      if (!value || typeof value !== "object") return false;
      const entry = value as Partial<StashEntry>;
      return (
        typeof entry.id === "string" &&
        typeof entry.prompt === "string" &&
        typeof entry.createdAt === "number" &&
        Number.isFinite(entry.createdAt) &&
        Array.isArray(entry.droppedNames) &&
        entry.droppedNames.every((name) => typeof name === "string") &&
        Array.isArray(entry.attachments) &&
        entry.attachments.every(
          (attachment) =>
            !!attachment &&
            typeof attachment.id === "string" &&
            typeof attachment.name === "string" &&
            typeof attachment.mime === "string" &&
            typeof attachment.dataUrl === "string",
        )
      );
    });
  } catch {
    return [];
  }
}

function write(entries: StashEntry[]): boolean {
  try {
    localStorage.setItem(KEY, JSON.stringify(entries));
    return true;
  } catch {
    return false;
  }
}

export function loadStash(): StashEntry[] {
  return read();
}

export function stashPrompt(
  prompt: string,
  attachments: ImageAttachment[],
  droppedNames: string[] = [],
): { entry: StashEntry | null; written: boolean; evicted: boolean } {
  const text = prompt.trim();
  if (!text && attachments.length === 0) {
    return { entry: null, written: false, evicted: false };
  }
  const entry: StashEntry = {
    id: createId(),
    createdAt: Date.now(),
    prompt: text,
    attachments,
    droppedNames,
  };
  const next = [entry, ...read()];
  let evicted = false;
  if (next.length > MAX_ENTRIES) {
    next.length = MAX_ENTRIES;
    evicted = true;
  }
  const written = write(next);
  return { entry: written ? entry : null, written, evicted };
}

export function takeStashEntry(id: string): {
  entry: StashEntry | null;
  removed: boolean;
} {
  const entries = read();
  const entry = entries.find((e) => e.id === id) ?? null;
  if (!entry) return { entry: null, removed: true };
  const removed = write(entries.filter((e) => e.id !== id));
  return { entry: removed ? entry : null, removed };
}

export function removeStashEntry(id: string): boolean {
  return write(read().filter((e) => e.id !== id));
}

export function clearStash(): void {
  write([]);
}
