export const MAX_BYTES = 15 * 1024 * 1024;
export const ALLOWED_MIME = [
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/webp",
  "image/heic",
  "image/heif",
];

export function looksAllowed(file: File): string | null {
  if (file.size > MAX_BYTES) return "That picture is too large. Try one under 15 MB.";
  const mime = file.type.toLowerCase();
  const name = file.name.toLowerCase();
  const okMime = !mime || ALLOWED_MIME.includes(mime);
  const okName = /\.(jpe?g|png|webp|heic|heif)$/i.test(name);
  if (!okMime && !okName) return "Please send a photo (JPG, PNG, WEBP, or HEIC).";
  if (/\.(svg|html?|js|exe|pdf)$/i.test(name)) return "That file type cannot be uploaded.";
  return null;
}

export async function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Could not read the picture."));
    reader.onload = () => resolve(String(reader.result));
    reader.readAsDataURL(file);
  });
}

/** Draw through canvas: strips EXIF/GPS from the public derivative. Original File is untouched. */
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
