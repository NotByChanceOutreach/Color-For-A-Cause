/**
 * Server-side image work with sharp (contract C2).
 *
 * (a) stripped original: EXIF orientation applied, converted to sRGB, EVERY metadata block dropped
 *     (EXIF incl. GPS, XMP, IPTC, ICC), long edge capped at STRIPPED_MAX_EDGE, JPEG.
 * (b) public derivative: made from (a), then the artist's own quarter-turn and edge-crop choices,
 *     long edge capped at PUBLIC_MAX_EDGE, JPEG.
 *
 * Note: the prebuilt sharp binaries decode AVIF-flavoured HEIF but not HEVC-encoded iPhone HEIC. Such
 * uploads fail here and are marked rejected_upload ("unreadable"); the web form therefore does not ask
 * iOS for HEIC, so Safari hands over a JPEG instead.
 */
import sharp from "sharp";
import { MAX_INPUT_PIXELS, PUBLIC_MAX_EDGE, STRIPPED_MAX_EDGE } from "./constants";
import type { Rotation } from "./validation";

sharp.cache(false);

export type ImageOut = { data: Buffer; width: number; height: number };
export type ProcessedImage = { stripped: ImageOut; derived: ImageOut };
export type ProcessOptions = { rotate: Rotation; cropPct: number };

/** Symmetric edge crop. Symmetric, so it selects the same region before or after a quarter turn. */
export function cropRect(width: number, height: number, pct: number) {
  if (!pct || pct <= 0) return null;
  const left = Math.floor(width * pct);
  const top = Math.floor(height * pct);
  const w = width - 2 * left;
  const h = height - 2 * top;
  if (w < 1 || h < 1 || (left === 0 && top === 0)) return null;
  return { left, top, width: w, height: h };
}

const INSIDE = { fit: "inside" as const, withoutEnlargement: true };

export async function processImage(input: Buffer, opts: ProcessOptions): Promise<ProcessedImage> {
  const stripped = await sharp(input, { failOn: "error", limitInputPixels: MAX_INPUT_PIXELS, autoOrient: true })
    .flatten({ background: "#ffffff" })
    .resize({ width: STRIPPED_MAX_EDGE, height: STRIPPED_MAX_EDGE, ...INSIDE })
    .toColourspace("srgb")
    .jpeg({ quality: 90 })
    .toBuffer({ resolveWithObject: true });

  // Crop and turn in two passes: sharp applies an explicit rotation before an extract in one pipeline.
  let pipeline = sharp(stripped.data, { failOn: "error" });
  const crop = cropRect(stripped.info.width, stripped.info.height, opts.cropPct);
  if (crop) {
    const cropped = await sharp(stripped.data, { failOn: "error" }).extract(crop).raw().toBuffer({ resolveWithObject: true });
    pipeline = sharp(cropped.data, {
      raw: { width: cropped.info.width, height: cropped.info.height, channels: cropped.info.channels },
    });
  }
  if (opts.rotate) pipeline = pipeline.rotate(opts.rotate);
  const derived = await pipeline
    .resize({ width: PUBLIC_MAX_EDGE, height: PUBLIC_MAX_EDGE, ...INSIDE })
    .jpeg({ quality: 85 })
    .toBuffer({ resolveWithObject: true });

  return {
    stripped: { data: stripped.data, width: stripped.info.width, height: stripped.info.height },
    derived: { data: derived.data, width: derived.info.width, height: derived.info.height },
  };
}
