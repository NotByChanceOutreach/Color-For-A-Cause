export const MAX_BYTES = 15 * 1024 * 1024;

/** What the server accepts (functions/src/constants.ts UPLOAD_TYPES). The form itself never sends HEIC/HEIF. */
export const UPLOAD_TYPES = ["image/jpeg", "image/png", "image/heic", "image/heif", "image/webp"] as const;
export type UploadType = (typeof UPLOAD_TYPES)[number];

/**
 * What the photo pickers ask for. Leaving HEIC out makes iPhones hand over a JPEG,
 * which the server can always open (most iPhone HEIC files it cannot).
 */
export const PHOTO_ACCEPT = "image/jpeg,image/png,image/webp";

export const PHOTO_TYPES_MESSAGE = "Please send a photo (JPG, PNG, or WEBP).";
export const HEIC_MESSAGE =
  "That photo is in the iPhone HEIC format, which we can't open. Please send it as a JPG or PNG instead.";

const BY_EXTENSION: Record<string, UploadType> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
};

/**
 * HEIC/HEIF, by type OR by extension. The server cannot decode most iPhone HEIC files and would only refuse the
 * picture after the artist had already been told it arrived, so the form says so up front.
 */
export function isHeic(file: File): boolean {
  return /^image\/hei[cf](-sequence)?$/i.test(file.type) || /\.hei[cf]$/i.test(file.name);
}

/** The exact Content-Type the upload will be signed for, or null if we won't send this file. */
export function uploadContentType(file: File): UploadType | null {
  if (isHeic(file)) return null;
  const mime = file.type.toLowerCase();
  if (mime === "image/jpg" || mime === "image/pjpeg") return "image/jpeg";
  if ((UPLOAD_TYPES as readonly string[]).includes(mime)) return mime as UploadType;
  if (mime && mime !== "application/octet-stream") return null;
  const ext = /\.([a-z0-9]+)$/i.exec(file.name)?.[1]?.toLowerCase() ?? "";
  return BY_EXTENSION[ext] ?? null;
}

export function looksAllowed(file: File): string | null {
  if (file.size > MAX_BYTES) return "That picture is too large. Try one under 15 MB.";
  if (file.size === 0) return "That picture looks empty. Please choose it again.";
  if (/\.(svg|html?|js|exe|pdf)$/i.test(file.name)) return "That file type cannot be uploaded.";
  if (isHeic(file)) return HEIC_MESSAGE;
  if (!uploadContentType(file)) return PHOTO_TYPES_MESSAGE;
  return null;
}

/**
 * Local preview only: draws through a canvas on this device. It is never uploaded;
 * the server makes the public image from the original.
 */
export async function makeDerivative(
  file: File,
  opts: { maxEdge: number; quality?: number; rotate?: number; cropPct?: number },
): Promise<{ dataUrl: string; width: number; height: number }> {
  const url = URL.createObjectURL(file);
  try {
    const img = await loadImage(url);
    const rot = ((opts.rotate ?? 0) % 360 + 360) % 360;
    const swap = rot === 90 || rot === 270;
    const srcW = img.naturalWidth;
    const srcH = img.naturalHeight;
    const scale = Math.min(1, opts.maxEdge / Math.max(srcW, srcH));
    const w = Math.max(1, Math.round((swap ? srcH : srcW) * scale));
    const h = Math.max(1, Math.round((swap ? srcW : srcH) * scale));
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Canvas unavailable");
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, w, h);
    ctx.translate(w / 2, h / 2);
    ctx.rotate((rot * Math.PI) / 180);
    const crop = Math.min(0.3, Math.max(0, opts.cropPct ?? 0));
    const dw = swap ? h : w;
    const dh = swap ? w : h;
    const sx = srcW * crop;
    const sy = srcH * crop;
    const sw = srcW * (1 - 2 * crop);
    const sh = srcH * (1 - 2 * crop);
    ctx.drawImage(img, sx, sy, sw, sh, -dw / 2, -dh / 2, dw, dh);
    return {
      dataUrl: canvas.toDataURL("image/jpeg", opts.quality ?? 0.86),
      width: w,
      height: h,
    };
  } finally {
    URL.revokeObjectURL(url);
  }
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () =>
      reject(new Error("We could not open that picture. Try a JPG or PNG."));
    img.src = src;
  });
}

export function displayName(kind: string, text: string): string {
  if (kind === "anonymous" || !text.trim()) return "Anonymous Artist";
  return text.trim();
}
