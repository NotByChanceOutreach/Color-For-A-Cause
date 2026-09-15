/**
 * Function options (contracts C7, C2, C8), kept apart from index.ts so tests can assert them.
 */
import { ALLOWED_ORIGINS } from "./constants";

/**
 * Every callable: App Check enforced, CORS limited to the two Hosting origins. The timeout is the platform
 * default, spelled out because moderate.ts's PUBLISH_CLAIM_MS must stay longer than it.
 */
export const CALLABLE_OPTIONS = {
  enforceAppCheck: true,
  cors: [...ALLOWED_ORIGINS],
  timeoutSeconds: 60,
};

/**
 * submitArtwork and createGroup also ask App Check to consume (burn) the limited-use token. firebase-functions only
 * REPORTS a token that was already used (request.app.alreadyConsumed); it does not refuse it. Each handler refuses
 * it itself, before any work (appCheck.ts, wired in index.ts; tests/functions/appCheckReplay.test.ts).
 */
export const REPLAY_PROTECTED_OPTIONS = {
  ...CALLABLE_OPTIONS,
  consumeAppCheckToken: true,
};

/**
 * sharp needs memory; one image at a time per instance keeps big photos from starving each other.
 * retry: a run that throws (a busy lease, a failed transaction, a crash) is redelivered by Eventarc.
 * uploadTrigger.ts's LEASE_MS must stay longer than timeoutSeconds.
 */
export const UPLOAD_TRIGGER_OPTIONS = {
  memory: "2GiB" as const,
  cpu: 1,
  concurrency: 1,
  timeoutSeconds: 120,
  retry: true,
};

export const RETENTION_SCHEDULE = {
  schedule: "every day 03:30",
  timeZone: "Etc/UTC" as const,
  timeoutSeconds: 540,
};
