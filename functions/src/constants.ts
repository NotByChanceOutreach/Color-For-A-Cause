/**
 * Server-side constants for Color For A Cause.
 *
 * Several lists mirror the client (src/types.ts, src/data/pages.ts, src/data/consent.ts, src/lib/minors.ts,
 * src/lib/collectibles.ts). The "server lists match the site" block in tests/functions/validation.test.ts and
 * "the form mirrors the server" in tests/functions/minors.test.ts fail if they drift apart.
 */

export const REGION = "us-central1";

/** The only browser origins allowed to call the callables directly (Hosting rewrites are same-origin). */
export const ALLOWED_ORIGINS: string[] = [
  "https://notbychance-color-for-a-cause.web.app",
  "https://notbychance-color-for-a-cause.firebaseapp.com",
];

/** Consent wording/version is Not By Chance's legal decision. Do not change it here. */
export const CONSENT_VERSION = "0.1-DRAFT-LEGAL-REVIEW";

// ---- Uploads (contract C1/C2) ----
export const MAX_UPLOAD_BYTES = 15 * 1024 * 1024; // 15728640
export const UPLOAD_CONTENT_LENGTH_RANGE = `1,${MAX_UPLOAD_BYTES}`;
export const UPLOAD_URL_TTL_MS = 5 * 60 * 1000;
export const UPLOAD_TYPES = ["image/jpeg", "image/png", "image/heic", "image/heif", "image/webp"] as const;
export type UploadType = (typeof UPLOAD_TYPES)[number];

/** Long-edge caps for the server-made images. */
export const STRIPPED_MAX_EDGE = 4096;
export const PUBLIC_MAX_EDGE = 2048;
/** Refuse to decode absurdly large images (decompression bombs). */
export const MAX_INPUT_PIXELS = 100_000_000;

export const REJECT_REASONS = [
  "empty",
  "too_large",
  "wrong_type",
  "not_an_image",
  "unreadable",
  "missing_upload",
  "processing_failed",
] as const;
export type RejectReason = (typeof REJECT_REASONS)[number];

// ---- Identifiers ----
export const SUBMISSION_ID_RE = /^sub_[0-9a-f]{32}$/;
export const CONSENT_ID_RE = /^con_[0-9a-f]{32}$/;
export const COLLECTIBLE_ID_RE = /^col_[0-9a-f]{32}$/;
export const GROUP_PUBLIC_ID_RE = /^[0-9a-f]{12}$/;
/** 32 random bytes, base64url, no padding. */
export const FINALIZE_TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
/** Cloud Storage object generations are positive int64 values sent as decimal strings. */
export const GENERATION_RE = /^[1-9][0-9]{0,19}$/;

// ---- Submission lifecycle ----
/** Statuses a person can set (mirrors SubmissionStatus in src/types.ts). */
export const SUBMISSION_STATUSES = [
  "submitted",
  "needs_changes",
  "hold",
  "approved",
  "featured",
  "scheduled",
  "collectible_created",
  "available",
  "collected",
  "impact_funded",
  "impact_fulfilled",
  "archived",
  "rejected",
] as const;
export type SubmissionStatus = (typeof SUBMISSION_STATUSES)[number];

/** Server-only statuses before a person ever sees the piece. */
export const UPLOADING = "uploading";
export const REJECTED_UPLOAD = "rejected_upload";

export const PUBLIC_STATUSES: readonly SubmissionStatus[] = [
  "approved",
  "featured",
  "scheduled",
  "collectible_created",
  "available",
  "collected",
  "impact_funded",
  "impact_fulfilled",
];

export const SUBMITTER_ROLES = ["self", "guardian", "organization", "someone_else"] as const;
export type SubmitterRole = (typeof SUBMITTER_ROLES)[number];
export const ATTRIBUTION_KINDS = ["firstName", "nickname", "anonymous"] as const;
export type AttributionKind = (typeof ATTRIBUTION_KINDS)[number];
export const AGE_RANGES = ["prefer_not", "under_13", "13_17", "18_plus"] as const;
export type AgeRange = (typeof AGE_RANGES)[number];

export const PERMISSION_KEYS = [
  "store",
  "displayPublic",
  "social",
  "reproduce",
  "promotional",
  "collectible",
  "sellCollectible",
  "showAttribution",
  "showMessage",
] as const;
export type PermissionKey = (typeof PERMISSION_KEYS)[number];
export type Permissions = Record<PermissionKey, boolean>;

/** The real coloring-page ids (mirrors src/data/pages.ts). */
export const PAGE_IDS = [
  "E01", "E02", "E03", "E04", "E05", "E06", "E07", "E08",
  "S01", "S02", "S03", "S04", "S05", "S06", "S07", "S08",
  "D01", "D02", "D03", "D04", "D05", "D06", "D07", "D08",
] as const;

// ---- Staff ----
export const STAFF_ROLES = ["ADMIN", "REVIEWER", "ART_MANAGER", "IMPACT_MANAGER"] as const;
export type StaffRole = (typeof STAFF_ROLES)[number];

// ---- Collectibles ----
export const COLLECTIBLE_STATUSES = ["none", "draft", "created"] as const;
export const IMPACT_PACKAGES = ["A", "B"] as const;
export const IMPACT_STATUSES = ["not_yet_funded", "funded", "purchased", "distributed"] as const;

// ---- Free-text caps (UTF-16 code units, same as the browser's maxLength) ----
export const TEXT_LIMITS = {
  attributionText: 80,
  organizationName: 120,
  message: 2000,
  email: 254,
  note: 2000,
  groupLabel: 120,
  originalName: 255,
} as const;

// ---- Abuse controls (contract C7) ----
// App Check (limited-use tokens) is the primary control; these per-connection caps are a backstop sized for
// shared connections (a school or shelter Wi-Fi behind one address).
export const RATE_LIMITS = {
  /** Per client IP, no group code. */
  submitArtwork: { max: 120, windowMs: 60 * 60 * 1000 },
  /** Per (existing group publicId, client IP): an art day sending a whole room's pictures. */
  submitArtworkGroup: { max: 300, windowMs: 60 * 60 * 1000 },
  /** Per client IP. */
  createGroup: { max: 10, windowMs: 60 * 60 * 1000 },
} as const;
export type RateAction = keyof typeof RATE_LIMITS;

// ---- Retention (contract C8) ----
export const RETENTION_MS = 24 * 60 * 60 * 1000;

// ---- Storage layout ----
export const UPLOAD_PATH_RE = /^submissions\/(sub_[0-9a-f]{32})\/original\/upload$/;
/** Any object that belongs to one submission (retention's orphan sweep groups by this id). */
export const SUBMISSION_OBJECT_RE = /^submissions\/(sub_[0-9a-f]{32})\//;
/** A published Art Wall copy (retention's gallery-leftover sweep). */
export const GALLERY_OBJECT_RE = /^gallery\/(sub_[0-9a-f]{32})\/public\.jpg$/;
/** A gallery object younger than this is never judged a leftover (a publish may be between its copy and commit). */
export const GALLERY_LEFTOVER_MIN_AGE_MS = 60 * 60 * 1000;

/**
 * Published Art Wall copies (gallery/{id}/public.jpg): public, but cacheable for five minutes only, so a piece taken
 * off the wall stops being served from browser and proxy caches soon after. They carry NO download token: the wall
 * loads them through tokenlessMediaUrl, which storage.rules checks on every read.
 */
export const GALLERY_CACHE_CONTROL = "public, max-age=300";
/** Everything under submissions/ (unreviewed, staff-only): never cached by shared caches. */
export const PRIVATE_CACHE_CONTROL = "private, max-age=0";

/** The custom metadata key in which Firebase Storage keeps an object's download tokens (bearer URLs). */
export const DOWNLOAD_TOKENS_KEY = "firebaseStorageDownloadTokens";

/**
 * The Firebase Storage read URL of an object WITHOUT a download token. Firebase serves it only when storage.rules
 * allow the reader (for gallery/{id}/public.jpg: while publicGallery/{id} exists), so it stops working the moment the
 * piece leaves the wall, unlike a token URL, which bypasses the rules for as long as the token exists.
 */
export function tokenlessMediaUrl(bucket: string, path: string): string {
  return `https://firebasestorage.googleapis.com/v0/b/${bucket}/o/${encodeURIComponent(path)}?alt=media`;
}

function assertSubmissionId(id: string): string {
  if (!SUBMISSION_ID_RE.test(id)) throw new Error(`Refusing to build a storage path for id ${JSON.stringify(id)}`);
  return id;
}

export const paths = {
  upload: (id: string) => `submissions/${assertSubmissionId(id)}/original/upload`,
  stripped: (id: string) => `submissions/${assertSubmissionId(id)}/original/stripped.jpg`,
  derived: (id: string) => `submissions/${assertSubmissionId(id)}/derived/public.jpg`,
  /**
   * The server-made derivative of a piece sent before the server privacy check (legacy.ts). It gets its own path so
   * the old browser-made derived/public.jpg is never touched until the new one is committed; the row's derivedPath
   * says which of the two a submission uses.
   */
  derivedV2: (id: string) => `submissions/${assertSubmissionId(id)}/derived/public-v2.jpg`,
  gallery: (id: string) => `gallery/${assertSubmissionId(id)}/public.jpg`,
  submissionPrefix: (id: string) => `submissions/${assertSubmissionId(id)}/`,
};
