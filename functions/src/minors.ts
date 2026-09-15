/**
 * Minor protections (contract C5). The server is the authority; the client only mirrors this
 * (src/lib/minors.ts, checked by tests/functions/minors.test.ts).
 *
 * Protective default: an artist whose age we do not know (ageRange null or 'prefer_not') is treated as a
 * possible minor. Public sharing needs one of:
 *   - ageRange '18_plus';
 *   - submitterRole 'guardian' (a parent or guardian is sending; their choices stand);
 *   - submitterRole 'organization' with guardianConsentAttested: true (kept with the consent record).
 *
 * Otherwise:
 *   - 'self' / 'someone_else' with ageRange null, 'prefer_not', 'under_13' or '13_17': every public/sharing
 *     choice is forced off, the organization line is hidden, and no email is stored.
 *   - 'organization' with an artist known to be under 18 and no attestation: refused (failed-precondition).
 *   - 'organization' with an unknown age and no attestation: stored private, exactly like the line above.
 */
import {
  AGE_RANGES,
  PERMISSION_KEYS,
  SUBMITTER_ROLES,
  type AgeRange,
  type PermissionKey,
  type Permissions,
  type SubmitterRole,
} from "./constants";
import { fail } from "./errors";
import type { Data } from "./store";
import type { SubmitRequest } from "./validation";

export const MINOR_AGE_RANGES: readonly AgeRange[] = ["under_13", "13_17"];

export const MINOR_LOCKED_PERMISSIONS: readonly PermissionKey[] = [
  "displayPublic",
  "social",
  "reproduce",
  "promotional",
  "collectible",
  "sellCollectible",
  "showAttribution",
  "showMessage",
];

export const GUARDIAN_ATTESTATION_REQUIRED =
  "Some artists are under 18. Please confirm a parent or guardian said yes before sending.";

/** Known to be under 18. */
export function isMinorAge(age: AgeRange | null | undefined): boolean {
  return age != null && MINOR_AGE_RANGES.includes(age);
}

/** The only answer that lets an artist's own choices stand without a guardian. */
export function isAdultAge(age: AgeRange | null | undefined): boolean {
  return age === "18_plus";
}

export type MinorOutcome = {
  request: SubmitRequest;
  minorProtectionsApplied: boolean;
  guardianConsentAttested: boolean;
};

function lock(req: SubmitRequest): MinorOutcome {
  const permissions = { ...req.permissions };
  for (const key of MINOR_LOCKED_PERMISSIONS) permissions[key] = false;
  return {
    request: { ...req, permissions, showOrganization: false, email: null },
    minorProtectionsApplied: true,
    guardianConsentAttested: false,
  };
}

export function applyMinorProtections(req: SubmitRequest): MinorOutcome {
  if (req.submitterRole === "guardian" || isAdultAge(req.ageRange)) {
    return { request: req, minorProtectionsApplied: false, guardianConsentAttested: false };
  }
  if (req.submitterRole === "organization") {
    if (req.guardianConsentAttested === true) {
      return { request: req, minorProtectionsApplied: false, guardianConsentAttested: true };
    }
    if (isMinorAge(req.ageRange)) fail("failed-precondition", GUARDIAN_ATTESTATION_REQUIRED);
  }
  return lock(req);
}

export type StoredRowProtection = {
  permissions: Permissions;
  showOrganization: boolean;
  email: string | null;
  minorProtectionsApplied: boolean;
};

const roleOf = (v: unknown): SubmitterRole | null =>
  (SUBMITTER_ROLES as readonly string[]).includes(String(v)) ? (v as SubmitterRole) : null;
const ageOf = (v: unknown): AgeRange | null => ((AGE_RANGES as readonly string[]).includes(String(v)) ? (v as AgeRange) : null);

/** Today's rule on one set of facts: may the artist's own choices stand (applyMinorProtections, never refusing)? */
function choicesStand(role: SubmitterRole | null, age: AgeRange | null, attested: boolean): boolean {
  return role === "guardian" || isAdultAge(age) || (role === "organization" && attested);
}

/**
 * Whether the consent record lets the row's choices stand. The record decides together with the row: it must name a
 * valid role, the SAME role as the row, must not say protections were applied, and today's rule must let choices
 * stand on the record's own facts. Records from 9b2fc57 stored no age and no attestation; for those two facts only,
 * the row's answer is used.
 */
function recordLetsStand(record: Data, rowRole: SubmitterRole, row: Data): boolean {
  const role = roleOf(record.submitterRole);
  if (role === null || role !== rowRole) return false;
  if (record.minorProtectionsApplied === true) return false;
  const age = record.ageRange !== undefined ? ageOf(record.ageRange) : ageOf(row.ageRange);
  const attested =
    record.guardianConsentAttested !== undefined ? record.guardianConsentAttested === true : row.guardianConsentAttested === true;
  return choicesStand(role, age, attested);
}

/**
 * The same rules for a row stored before they existed (legacy.ts). It never refuses: a row the form would refuse
 * today (an organization, a known minor, no confirmation) is locked instead, like any other possible minor.
 *
 * `consents`: the row's own consent record(s). Not given: the row alone decides. Given, the row can never say more
 * than any record (in 9b2fc57 staff could write either one directly, so the two can disagree):
 *   - a permission stays on only where the row AND every record say yes;
 *   - the lock is decided from the row AND the records: the choices stand only if they stand on the row's facts AND
 *     on every record's (recordLetsStand). A record that says the artist is a possible minor locks the row;
 *   - the email goes when a record holds none;
 *   - an EMPTY list means no record was found: the row fails closed, locked private (only `store` kept, every public
 *     choice off, no organization line, no email).
 * Nothing is ever widened.
 */
export function protectStoredRow(row: Data, consents?: readonly Data[]): StoredRowProtection {
  const role: SubmitterRole = roleOf(row.submitterRole) ?? "self";
  const age = ageOf(row.ageRange);
  const stored = (row.permissions ?? {}) as Record<string, unknown>;
  const records = consents ?? [];
  const given = records.map((c) => (c.permissions ?? {}) as Record<string, unknown>);
  const permissions = Object.fromEntries(
    PERMISSION_KEYS.map((k) => [k, stored[k] === true && given.every((g) => g[k] === true)]),
  ) as Permissions;
  const noRecord = consents !== undefined && consents.length === 0;
  const stands =
    !noRecord && choicesStand(role, age, row.guardianConsentAttested === true) && records.every((c) => recordLetsStand(c, role, row));
  if (stands) {
    const recordsHoldEmail = records.every((c) => typeof c.email === "string" && c.email !== "");
    return {
      permissions,
      showOrganization: row.showOrganization === true,
      email: recordsHoldEmail && typeof row.email === "string" && row.email ? row.email : null,
      minorProtectionsApplied: false,
    };
  }
  for (const key of MINOR_LOCKED_PERMISSIONS) permissions[key] = false;
  return { permissions, showOrganization: false, email: null, minorProtectionsApplied: true };
}

/** Whether the protection turns off a permission the stored row has on. */
export function narrowsRow(row: Data, protection: StoredRowProtection): boolean {
  const stored = (row.permissions ?? {}) as Record<string, unknown>;
  return PERMISSION_KEYS.some((k) => stored[k] === true && protection.permissions[k] !== true);
}
