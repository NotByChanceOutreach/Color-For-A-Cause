/**
 * Replay protection for submitArtwork and createGroup (contract C7).
 *
 * `consumeAppCheckToken: true` (options.ts) makes firebase-functions ask App Check to burn the token, but it does
 * NOT refuse a token that was already burned: it only reports `request.app.alreadyConsumed` and leaves the
 * decision to the handler (firebase-functions 6.x, lib/v2/providers/https.d.ts). This module makes that decision.
 *
 * It fails closed: with consumeAppCheckToken set, a genuine first use always reports `alreadyConsumed: false`
 * (the Admin SDK coerces a missing answer to false), so anything else (true, missing, no App Check data at all)
 * is refused before any work is done.
 */
import { fail } from "./errors";

export const REPLAYED_TOKEN_MESSAGE = "This request was already used. Please reload the page and try again.";

export type AppCheckContext = { app?: { alreadyConsumed?: boolean } | undefined };

export function refuseReplayedAppCheckToken(req: AppCheckContext): void {
  if (req.app?.alreadyConsumed !== false) fail("unauthenticated", REPLAYED_TOKEN_MESSAGE);
}
