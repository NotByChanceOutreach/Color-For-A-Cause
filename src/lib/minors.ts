import type { AgeRange, ConsentPermissions, SubmitterRole } from "../types";

/**
 * Mirrors functions/src/minors.ts (contract C5). The server enforces these rules;
 * the form only explains them before anyone presses Send.
 *
 * Protective default: when we don't know the artist is 18 or older, we treat them as possibly under 18.
 * Sharing publicly needs age 18+, a parent or guardian sending, or an organization confirming a guardian agreed.
 */
export const MINOR_LOCKED_KEYS: (keyof ConsentPermissions)[] = [
  "displayPublic",
  "social",
  "reproduce",
  "promotional",
  "collectible",
  "sellCollectible",
  "showAttribution",
  "showMessage",
];

/** Known to be under 18. */
export function isMinorAge(age: AgeRange | null | undefined): boolean {
  return age === "under_13" || age === "13_17";
}

export function isAdultAge(age: AgeRange | null | undefined): boolean {
  return age === "18_plus";
}

/** Nothing public, no email: the artist may be under 18 and no guardian has said yes. */
export function minorLockApplies(
  age: AgeRange | null | undefined,
  role: SubmitterRole,
  guardianConsentAttested = false,
): boolean {
  if (role === "guardian" || isAdultAge(age)) return false;
  // An organization with a known minor must confirm first (the server refuses otherwise), so that case is not "locked".
  if (role === "organization") return !guardianConsentAttested && !isMinorAge(age);
  return true;
}

/** Organizations are offered the guardian confirmation whenever the artist may be under 18. */
export function asksGuardianAttestation(age: AgeRange | null | undefined, role: SubmitterRole): boolean {
  return role === "organization" && !isAdultAge(age);
}

/** ...and must give it before sending art by someone known to be under 18. */
export function needsGuardianAttestation(age: AgeRange | null | undefined, role: SubmitterRole): boolean {
  return role === "organization" && isMinorAge(age);
}

export function lockPermissions(perms: ConsentPermissions): ConsentPermissions {
  const out = { ...perms };
  for (const key of MINOR_LOCKED_KEYS) out[key] = false;
  return out;
}

export const MINOR_LOCK_REASON =
  "Because the artist is under 18, only a parent or guardian can say yes to showing or sharing this art. We will still receive it and keep it private.";

/** Shown when the age is unknown ("Prefer not to say"). */
export const UNKNOWN_AGE_LOCK_REASON =
  "To share this publicly, tell us the artist is 18 or older, or have a parent or guardian send it.";

export const ORGANIZATION_LOCK_HINT = "An organization can also confirm that a parent or guardian agreed.";

export function lockReason(age: AgeRange | null | undefined, role: SubmitterRole): string {
  if (isMinorAge(age)) return MINOR_LOCK_REASON;
  return role === "organization" ? `${UNKNOWN_AGE_LOCK_REASON} ${ORGANIZATION_LOCK_HINT}` : UNKNOWN_AGE_LOCK_REASON;
}

export const MINOR_EMAIL_REASON = "We don’t collect email addresses from artists under 18.";

export const UNKNOWN_AGE_EMAIL_REASON =
  "We only ask for an email when the artist is 18 or older, or a parent or guardian is sending.";

export function emailReason(age: AgeRange | null | undefined): string {
  return isMinorAge(age) ? MINOR_EMAIL_REASON : UNKNOWN_AGE_EMAIL_REASON;
}

/** UI confirmation for organizations. Not part of the versioned consent text. */
export const GUARDIAN_ATTESTATION_LABEL = "A parent or guardian of each artist under 18 agreed to these choices.";

export const GUARDIAN_ATTESTATION_REQUIRED =
  "Some artists are under 18. Please confirm a parent or guardian said yes before sending.";
