/**
 * finalizeSubmission is idempotent: asking again can never submit a piece twice. So a call that fails in transport
 * (a dropped connection, a timeout, a 5xx) is simply asked again on the next round, instead of showing an error for
 * an upload the server already has (and inviting a duplicate). Only a definite answer about the request itself
 * (not found, a bad token, refused...) ends the wait with that error. If no call ever got an answer, the last error
 * is thrown.
 */
const DEFINITE = /(invalid-argument|failed-precondition|not-found|permission-denied|unauthenticated|already-exists|out-of-range|unimplemented)$/;

export type FinalizeOutcome = "submitted" | "processing";

export async function pollFinalize(
  call: () => Promise<unknown>,
  opts: { attempts: number; delayMs: number; sleep?: (ms: number) => Promise<void> },
): Promise<FinalizeOutcome> {
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  let answered = false;
  let lastError: unknown = null;
  for (let i = 0; i < opts.attempts; i++) {
    try {
      const res = await call();
      if ((res as { data?: { status?: unknown } | null } | null)?.data?.status === "submitted") return "submitted";
      answered = true;
    } catch (err) {
      const code = err && typeof err === "object" && "code" in err ? String((err as { code: unknown }).code) : "";
      if (DEFINITE.test(code)) throw err;
      lastError = err;
    }
    if (i < opts.attempts - 1) await sleep(opts.delayMs);
  }
  if (answered) return "processing";
  throw lastError ?? new Error("The server did not answer.");
}
