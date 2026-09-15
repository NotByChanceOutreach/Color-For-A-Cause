/**
 * Framework-free error type for the callable logic. index.ts converts it to an HttpsError,
 * which keeps these modules unit-testable without loading firebase-functions.
 */
export type ErrorCode =
  | "invalid-argument"
  | "failed-precondition"
  | "permission-denied"
  | "not-found"
  | "resource-exhausted"
  | "aborted"
  | "unauthenticated"
  | "internal";

export class AppError extends Error {
  readonly code: ErrorCode;
  constructor(code: ErrorCode, message: string) {
    super(message);
    this.name = "AppError";
    this.code = code;
  }
}

export function fail(code: ErrorCode, message: string): never {
  throw new AppError(code, message);
}
