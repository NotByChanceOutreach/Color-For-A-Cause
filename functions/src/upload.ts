/**
 * Upload primitives (contract C1): signed PUT URL options, the finalize token, magic-byte sniffing.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { UPLOAD_CONTENT_LENGTH_RANGE, UPLOAD_TYPES, UPLOAD_URL_TTL_MS, type UploadType } from "./constants";

export type SignedUploadConfig = {
  version: "v4";
  action: "write";
  expires: number;
  contentType: UploadType;
  extensionHeaders: Record<string, string>;
};

/**
 * V4 signed PUT for the original only. Content-Type and x-goog-content-length-range are signed,
 * so the browser must send exactly these headers and Cloud Storage refuses anything outside 1 B–15 MB.
 */
export function uploadUrlConfig(contentType: UploadType, nowMs: number): SignedUploadConfig {
  return {
    version: "v4",
    action: "write",
    expires: nowMs + UPLOAD_URL_TTL_MS,
    contentType,
    extensionHeaders: { "x-goog-content-length-range": UPLOAD_CONTENT_LENGTH_RANGE },
  };
}

/** The exact headers the client must send with the PUT. */
export function uploadRequestHeaders(contentType: UploadType): Record<string, string> {
  return { "Content-Type": contentType, "x-goog-content-length-range": UPLOAD_CONTENT_LENGTH_RANGE };
}

export function isUploadType(v: unknown): v is UploadType {
  return typeof v === "string" && (UPLOAD_TYPES as readonly string[]).includes(v);
}

export function newId(prefix: "sub" | "con" | "grp" | "col"): string {
  return `${prefix}_${randomBytes(16).toString("hex")}`;
}

export function newGroupPublicId(): string {
  return randomBytes(6).toString("hex");
}

/** 32 random bytes. Only its SHA-256 is stored. */
export function newFinalizeToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashFinalizeToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function finalizeTokenMatches(token: string, storedHash: unknown): boolean {
  if (typeof storedHash !== "string" || !/^[0-9a-f]{64}$/.test(storedHash)) return false;
  const a = Buffer.from(hashFinalizeToken(token), "hex");
  const b = Buffer.from(storedHash, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}

export type SniffedFormat = "jpeg" | "png" | "webp" | "heif";

export function sniffImage(buf: Uint8Array): SniffedFormat | null {
  if (buf.length < 12) return null;
  const ascii = (start: number, end: number) => Buffer.from(buf.subarray(start, end)).toString("latin1");
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "jpeg";
  if (buf[0] === 0x89 && ascii(1, 4) === "PNG" && buf[4] === 0x0d && buf[5] === 0x0a) return "png";
  if (ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") return "webp";
  if (ascii(4, 8) === "ftyp" && ["heic", "heix", "heif", "mif1", "msf1", "hevc", "hevx"].includes(ascii(8, 12).toLowerCase())) {
    return "heif";
  }
  return null;
}

export function formatMatchesContentType(format: SniffedFormat, contentType: UploadType): boolean {
  switch (format) {
    case "jpeg":
      return contentType === "image/jpeg";
    case "png":
      return contentType === "image/png";
    case "webp":
      return contentType === "image/webp";
    case "heif":
      return contentType === "image/heic" || contentType === "image/heif";
  }
}

/** The original file name can carry personal info, so we never store it. */
export function genericOriginalName(contentType: UploadType): string {
  const ext = { "image/jpeg": "jpg", "image/png": "png", "image/heic": "heic", "image/heif": "heif", "image/webp": "webp" }[
    contentType
  ];
  return `artwork.${ext}`;
}
