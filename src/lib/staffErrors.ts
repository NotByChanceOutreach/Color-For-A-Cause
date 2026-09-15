/** Staff lists the signed-in role is not allowed to read (Firestore rules answer permission-denied). */
export const ROLE_CANNOT_SEE = "Your role can't see this.";
export const LIST_FAILED = "We could not load this list. Please try again.";

export class RoleCannotSeeError extends Error {
  readonly code = "permission-denied";
  constructor() {
    super(ROLE_CANNOT_SEE);
    this.name = "RoleCannotSeeError";
  }
}

export function isPermissionDenied(err: unknown): boolean {
  if (err instanceof RoleCannotSeeError) return true;
  const code = err && typeof err === "object" && "code" in err ? String((err as { code: unknown }).code) : "";
  return code === "permission-denied" || code.endsWith("/permission-denied") || code === "storage/unauthorized";
}

/** Turns a failed staff read into the sentence the page shows. */
export function staffLoadError(err: unknown, fallback: string = LIST_FAILED): string {
  return isPermissionDenied(err) ? ROLE_CANNOT_SEE : fallback;
}

/** Backend helper: rethrow a read failure as something the staff pages can explain. */
export function asStaffReadError(err: unknown): Error {
  return isPermissionDenied(err) ? new RoleCannotSeeError() : new Error(LIST_FAILED);
}
