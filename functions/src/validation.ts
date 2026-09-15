/**
 * Allowlist validation for every callable (contract C6).
 * Unknown fields are rejected, enums are checked, free text is cleaned and length-capped.
 * Messages for public callables are shown to visitors, so they are written in plain language.
 */
import {
  AGE_RANGES,
  ATTRIBUTION_KINDS,
  COLLECTIBLE_ID_RE,
  COLLECTIBLE_STATUSES,
  FINALIZE_TOKEN_RE,
  GENERATION_RE,
  GROUP_PUBLIC_ID_RE,
  IMPACT_PACKAGES,
  IMPACT_STATUSES,
  MAX_UPLOAD_BYTES,
  PAGE_IDS,
  PERMISSION_KEYS,
  SUBMISSION_ID_RE,
  SUBMISSION_STATUSES,
  SUBMITTER_ROLES,
  TEXT_LIMITS,
  UPLOAD_TYPES,
  type AgeRange,
  type AttributionKind,
  type Permissions,
  type SubmissionStatus,
  type SubmitterRole,
  type UploadType,
} from "./constants";
import { fail } from "./errors";
import { dropLoneSurrogates, hasLoneSurrogate, hasReadableText, scrubText } from "./textCore";

type Obj = Record<string, unknown>;

const BAD_SHAPE = "The request was not in the expected shape.";

/** Plain object with only allowlisted keys; anything else is invalid-argument. */
export function allowlisted(raw: unknown, allowed: readonly string[]): Obj {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) fail("invalid-argument", BAD_SHAPE);
  const proto = Object.getPrototypeOf(raw);
  if (proto !== Object.prototype && proto !== null) fail("invalid-argument", BAD_SHAPE);
  const obj = raw as Obj;
  for (const key of Object.keys(obj)) {
    if (!allowed.includes(key)) {
      const shown = /^[A-Za-z0-9_]{1,40}$/.test(key) ? `: ${key}` : "";
      fail("invalid-argument", `Unexpected field in the request${shown}.`);
    }
  }
  return obj;
}

// ---------------------------------------------------------------- text cleaning (textCore.ts, shared with the forms)

// The rules (what is invisible, blank, junk or real text) live in textCore.ts, a byte-for-byte copy of
// src/lib/textCore.ts. They are applied until the text stops changing, so no joiner is judged against a character
// that is about to be removed, and none is left trailing.
export { dropLoneSurrogates, hasLoneSurrogate, hasReadableText };

export const UNREADABLE_TEXT = "Some of that text has characters we could not read. Please type it again.";

/** Cleaned (textCore.ts scrubText), NFC, trimmed. Lone surrogates are refused. */
export function cleanText(value: string, multiline: boolean): string {
  if (hasLoneSurrogate(value)) fail("invalid-argument", UNREADABLE_TEXT);
  return scrubText(value, multiline, true);
}

/**
 * The same cleaning for text already stored (rows and group labels saved under older rules, cleaned again before
 * the public sees them). Never throws: lone surrogates are dropped, anything that is not a string is empty.
 */
export function cleanStoredText(value: unknown, multiline: boolean): string {
  return typeof value === "string" ? scrubText(dropLoneSurrogates(value), multiline, true) : "";
}

/**
 * How a byline is compared (the "artists participating" count): every ignorable character removed (joiners and
 * variation selectors too), blank characters and runs of whitespace as one space, NFC, trimmed, case-folded.
 * Never throws, because it also runs on rows stored before cleanText refused lone surrogates.
 */
export function bylineKey(value: string): string {
  const s = scrubText(dropLoneSurrogates(value), false, false).replace(/\s+/g, " ").trim();
  // Upper then lower folds more pairs than lower alone (e.g. "ß" and "SS").
  return s.toUpperCase().toLowerCase().normalize("NFC");
}

function text(o: Obj, key: string, max: number, label: string, multiline = false): string {
  const v = o[key];
  if (v === undefined || v === null) return "";
  if (typeof v !== "string") fail("invalid-argument", `${label} must be text.`);
  if (hasLoneSurrogate(v)) fail("invalid-argument", `${label} has characters we could not read. Please type it again.`);
  const s = cleanText(v, multiline);
  if (s.length > max) fail("invalid-argument", `${label} is too long (${max} characters at most).`);
  return s;
}

function nullableText(o: Obj, key: string, max: number, label: string): string | null {
  return text(o, key, max, label) || null;
}

function oneOf<T extends string>(
  o: Obj,
  key: string,
  allowed: readonly T[],
  opts: { label: string; fallback?: T; message?: string },
): T {
  const v = o[key];
  if (v === undefined && opts.fallback !== undefined) return opts.fallback;
  if (typeof v !== "string" || !(allowed as readonly string[]).includes(v)) {
    fail("invalid-argument", opts.message ?? `${opts.label} is not one of the allowed choices.`);
  }
  return v as T;
}

function nullableOneOf<T extends string>(o: Obj, key: string, allowed: readonly T[], label: string): T | null {
  if (o[key] === undefined || o[key] === null) return null;
  return oneOf(o, key, allowed, { label });
}

function flag(o: Obj, key: string, label: string): boolean {
  const v = o[key];
  if (v === undefined || v === null) return false;
  if (typeof v !== "boolean") fail("invalid-argument", `${label} must be true or false.`);
  return v;
}

function pattern(o: Obj, key: string, re: RegExp, label: string): string {
  const v = o[key];
  if (typeof v !== "string" || !re.test(v)) fail("invalid-argument", `${label} is missing or malformed.`);
  return v;
}

function nullablePattern(o: Obj, key: string, re: RegExp, label: string): string | null {
  if (o[key] === undefined || o[key] === null || o[key] === "") return null;
  return pattern(o, key, re, label);
}

const EMAIL_RE = /^[^\s@<>()[\]\\,;:"]{1,64}@(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}$/;

function email(o: Obj): string | null {
  const s = text(o, "email", TEXT_LIMITS.email, "Email");
  if (!s) return null;
  if (!EMAIL_RE.test(s)) fail("invalid-argument", "That email address doesn't look right. You can also leave it empty.");
  return s;
}

function permissions(raw: unknown): Permissions {
  const out = Object.fromEntries(PERMISSION_KEYS.map((k) => [k, false])) as Permissions;
  if (raw === undefined || raw === null) return out;
  const o = allowlisted(raw, PERMISSION_KEYS);
  for (const key of PERMISSION_KEYS) out[key] = flag(o, key, `Permission "${key}"`);
  return out;
}

export type Rotation = 0 | 90 | 180 | 270;

/** Quarter turns only. Anything else from a stored row becomes 0. */
export function normalizeRotation(v: unknown): Rotation {
  return v === 90 || v === 180 || v === 270 ? v : 0;
}

/** Edge crop as a fraction of each side, 0 to 0.2, two decimals. */
export function normalizeCrop(v: unknown): number {
  if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) return 0;
  return Math.min(0.2, Math.round(v * 100) / 100);
}

// ---------------------------------------------------------------- submitArtwork

export const SUBMIT_FIELDS = [
  "pageId",
  "submitterRole",
  "attributionKind",
  "attributionText",
  "ageRange",
  "organizationName",
  "showOrganization",
  "message",
  "email",
  "groupId",
  "permissions",
  "originalMime",
  "originalBytes",
  "originalName",
  "rotate",
  "cropPct",
  "guardianConsentAttested",
] as const;

export type SubmitRequest = {
  pageId: string | null;
  submitterRole: SubmitterRole;
  attributionKind: AttributionKind;
  attributionText: string;
  ageRange: AgeRange | null;
  organizationName: string | null;
  showOrganization: boolean;
  message: string;
  email: string | null;
  groupPublicId: string | null;
  permissions: Permissions;
  originalMime: UploadType;
  originalBytes: number;
  rotate: Rotation;
  cropPct: number;
  guardianConsentAttested: boolean;
};

export const PHOTO_TYPES_MESSAGE = "Please send a photo (JPG, PNG, or WEBP).";
export const TOO_LARGE_MESSAGE = "That picture is too large. Try one under 15 MB.";
export const NAME_REQUIRED = "Please type a first name or nickname we can read, or choose Anonymous.";

export function parseSubmitRequest(raw: unknown): SubmitRequest {
  const o = allowlisted(raw, SUBMIT_FIELDS);

  const pageId = nullableOneOf(o, "pageId", PAGE_IDS, "The coloring page");
  const submitterRole = oneOf(o, "submitterRole", SUBMITTER_ROLES, { label: "Who made this", fallback: "self" });
  const attributionKind = oneOf(o, "attributionKind", ATTRIBUTION_KINDS, { label: "Name choice", fallback: "anonymous" });
  let attributionText = text(o, "attributionText", TEXT_LIMITS.attributionText, "Name or nickname");
  if (attributionKind === "anonymous") attributionText = "";
  // A name with no letter, digit or symbol left once invisible and blank characters are gone is refused,
  // not silently anonymized.
  else if (!hasReadableText(attributionText)) fail("invalid-argument", NAME_REQUIRED);

  const ageRange = nullableOneOf(o, "ageRange", AGE_RANGES, "Age range");
  const organizationName = nullableText(o, "organizationName", TEXT_LIMITS.organizationName, "Organization");
  const showOrganization = flag(o, "showOrganization", "Show organization") && organizationName !== null;
  const message = text(o, "message", TEXT_LIMITS.message, "Your message", true);
  const groupPublicId = nullablePattern(o, "groupId", GROUP_PUBLIC_ID_RE, "Group code");

  const originalMime = oneOf(o, "originalMime", UPLOAD_TYPES, { label: "Picture type", message: PHOTO_TYPES_MESSAGE });
  const bytes = o.originalBytes;
  if (typeof bytes !== "number" || !Number.isInteger(bytes) || bytes < 1) {
    fail("invalid-argument", "That picture looks empty. Please choose it again.");
  }
  if (bytes > MAX_UPLOAD_BYTES) fail("invalid-argument", TOO_LARGE_MESSAGE);
  // Shape-checked only: the stored name is always generic because file names can carry personal info.
  text(o, "originalName", TEXT_LIMITS.originalName, "File name");

  const rotate = o.rotate;
  if (rotate !== undefined && rotate !== null && rotate !== 0 && normalizeRotation(rotate) === 0) {
    fail("invalid-argument", "Rotation must be a quarter turn.");
  }
  const crop = o.cropPct;
  if (crop !== undefined && crop !== null && (typeof crop !== "number" || !Number.isFinite(crop) || crop < 0 || crop > 0.2)) {
    fail("invalid-argument", "Crop must be between 0 and 20 percent.");
  }

  return {
    pageId,
    submitterRole,
    attributionKind,
    attributionText,
    ageRange,
    organizationName,
    showOrganization,
    message,
    email: email(o),
    groupPublicId,
    permissions: permissions(o.permissions),
    originalMime,
    originalBytes: bytes,
    rotate: normalizeRotation(rotate),
    cropPct: normalizeCrop(crop),
    guardianConsentAttested: flag(o, "guardianConsentAttested", "Guardian confirmation"),
  };
}

// ---------------------------------------------------------------- finalizeSubmission

export function parseFinalizeRequest(raw: unknown): { id: string; finalizeToken: string } {
  const o = allowlisted(raw, ["id", "finalizeToken"]);
  return {
    id: pattern(o, "id", SUBMISSION_ID_RE, "Submission id"),
    finalizeToken: pattern(o, "finalizeToken", FINALIZE_TOKEN_RE, "Upload confirmation"),
  };
}

// ---------------------------------------------------------------- moderateSubmission

export type ModerateRequest = {
  id: string;
  status: SubmissionStatus;
  derivedGeneration: string | null;
  note: string;
};

export function parseModerateRequest(raw: unknown): ModerateRequest {
  const o = allowlisted(raw, ["id", "status", "derivedGeneration", "note"]);
  return {
    id: pattern(o, "id", SUBMISSION_ID_RE, "Submission id"),
    status: oneOf(o, "status", SUBMISSION_STATUSES, { label: "Status" }),
    derivedGeneration: nullablePattern(o, "derivedGeneration", GENERATION_RE, "derivedGeneration"),
    note: text(o, "note", TEXT_LIMITS.note, "Internal note", true),
  };
}

// ---------------------------------------------------------------- groups

export const GROUP_LABEL_FALLBACK = "Art day";

/** The label is cleaned like every public text; with nothing readable left it becomes the fallback. */
export function parseCreateGroupRequest(raw: unknown): { label: string } {
  const o = allowlisted(raw ?? {}, ["label"]);
  const label = text(o, "label", TEXT_LIMITS.groupLabel, "Group label");
  return { label: hasReadableText(label) ? label : GROUP_LABEL_FALLBACK };
}

export function parseGetGroupRequest(raw: unknown): { publicId: string } {
  const o = allowlisted(raw, ["publicId"]);
  return { publicId: pattern(o, "publicId", GROUP_PUBLIC_ID_RE, "Group code") };
}

// ---------------------------------------------------------------- upsertCollectible

export type CollectibleRequest = {
  id: string | null;
  submissionId: string;
  status: (typeof COLLECTIBLE_STATUSES)[number];
  chain: string | null;
  contract: string | null;
  tokenId: string | null;
  txHash: string | null;
  metadataUri: string | null;
  marketplaceUrl: string | null;
  impactPackage: (typeof IMPACT_PACKAGES)[number] | null;
  impactStatus: (typeof IMPACT_STATUSES)[number] | null;
  impactVerified: boolean;
};

function link(o: Obj, key: string, label: string, protocols: string[]): string | null {
  const s = text(o, key, 500, label);
  if (!s) return null;
  let parsed: URL;
  try {
    parsed = new URL(s);
  } catch {
    fail("invalid-argument", `${label} must be a full link.`);
  }
  if (!protocols.includes(parsed.protocol) || /\s/.test(s)) {
    fail("invalid-argument", `${label} must start with ${protocols.join(" or ")}//.`);
  }
  return s;
}

export const COLLECTIBLE_FIELDS = [
  "id",
  "submissionId",
  "status",
  "chain",
  "contract",
  "tokenId",
  "txHash",
  "metadataUri",
  "marketplaceUrl",
  "impactPackage",
  "impactStatus",
  "impactVerified",
] as const;

export function parseCollectibleRequest(raw: unknown): CollectibleRequest {
  const o = allowlisted(raw, COLLECTIBLE_FIELDS);
  return {
    id: nullablePattern(o, "id", COLLECTIBLE_ID_RE, "Collectible id"),
    submissionId: pattern(o, "submissionId", SUBMISSION_ID_RE, "Submission id"),
    status: oneOf(o, "status", COLLECTIBLE_STATUSES, { label: "Collectible status" }),
    chain: nullablePattern(o, "chain", /^[a-z0-9-]{1,40}$/, "Chain"),
    contract: nullablePattern(o, "contract", /^[A-Za-z0-9:._-]{1,100}$/, "Contract"),
    tokenId: nullablePattern(o, "tokenId", /^[A-Za-z0-9._-]{1,100}$/, "Token id"),
    txHash: nullablePattern(o, "txHash", /^[A-Za-z0-9]{1,130}$/, "Transaction hash"),
    metadataUri: link(o, "metadataUri", "Metadata link", ["https:", "ipfs:", "ar:"]),
    marketplaceUrl: link(o, "marketplaceUrl", "Marketplace link", ["https:"]),
    impactPackage: nullableOneOf(o, "impactPackage", IMPACT_PACKAGES, "Impact package"),
    impactStatus: nullableOneOf(o, "impactStatus", IMPACT_STATUSES, "Impact status"),
    impactVerified: flag(o, "impactVerified", "Impact verified"),
  };
}
