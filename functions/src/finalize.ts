/**
 * finalizeSubmission (contract C3).
 *
 * The upload trigger (uploadTrigger.ts) and this callable race: the browser calls finalize right after
 * its PUT succeeds, usually while sharp is still working. Design, both sides in Firestore transactions
 * on the same submission document:
 *
 *   finalize:  token ok + 'uploading' + derivative ready     -> 'submitted' (+counter, +audit)
 *              token ok + 'uploading' + derivative not ready -> finalizeRequested = true, answer 'processing'
 *   trigger:   derivative written, row still 'uploading'     -> record derivedGeneration/derivedMd5/stripped
 *              ... and finalizeRequested already true         -> 'submitted' (+counter, +audit) in that same transaction
 *
 * Exactly one transaction observes "uploading + derivative ready + finalize requested" and flips the row, so the
 * counter moves exactly once whichever side commits last. Repeated finalize calls never write: they answer
 * 'processing' (nothing new) or 'submitted' (already done) from the stored state.
 */
import { REJECTED_UPLOAD, UPLOADING, type RejectReason } from "./constants";
import { fail } from "./errors";
import { audit, type Data, type Db, type Ops, type Tx } from "./store";
import { finalizeTokenMatches } from "./upload";
import { PHOTO_TYPES_MESSAGE, TOO_LARGE_MESSAGE, parseFinalizeRequest } from "./validation";

export type FinalizeResult = { ok: true; id: string; number: string; status: "submitted" | "processing" };

const TRY_AGAIN = "Whoops. That picture didn’t make it through. Let’s try again.";

const REJECTION_MESSAGES: Record<RejectReason, string> = {
  empty: "That picture looks empty. Please choose it again.",
  too_large: TOO_LARGE_MESSAGE,
  wrong_type: PHOTO_TYPES_MESSAGE,
  not_an_image: PHOTO_TYPES_MESSAGE,
  unreadable: "We could not open that picture. Try a JPG or PNG.",
  missing_upload: TRY_AGAIN,
  processing_failed: TRY_AGAIN,
};

export function rejectionMessage(reason: unknown): string {
  return typeof reason === "string" && Object.prototype.hasOwnProperty.call(REJECTION_MESSAGES, reason)
    ? REJECTION_MESSAGES[reason as RejectReason]
    : TRY_AGAIN;
}

export function derivativeReady(row: Data): boolean {
  return row.stripped === true && typeof row.derivedGeneration === "string" && row.derivedGeneration.length > 0;
}

/**
 * The single 'uploading' -> 'submitted' transition. Callers must have read the row inside `tx`
 * and seen status 'uploading' with the derivative ready.
 */
export function markSubmitted(tx: Tx, db: Db, ops: Ops, id: string, row: Data): void {
  tx.update(db.doc(`submissions/${id}`), {
    status: "submitted",
    submittedAt: ops.serverTimestamp(),
    finalizeRequested: true,
  });
  tx.set(db.doc("counters/public"), { artworkSubmitted: ops.increment(1) }, { merge: true });
  audit(tx, db, ops, { actor: "public", action: "submit", target: id, detail: String(row.number ?? "") });
}

export async function finalizeSubmission(db: Db, ops: Ops, raw: unknown): Promise<FinalizeResult> {
  const { id, finalizeToken } = parseFinalizeRequest(raw);
  const ref = db.doc(`submissions/${id}`);
  return db.runTransaction<FinalizeResult>(async (tx) => {
    const snap = await tx.get(ref);
    const row = snap.exists ? snap.data() : undefined;
    if (!row) fail("not-found", "We could not find that upload. Please send it again.");
    if (!finalizeTokenMatches(finalizeToken, row.finalizeTokenHash)) {
      fail("permission-denied", "That upload could not be confirmed. Please send it again.");
    }
    const number = String(row.number ?? "");
    if (row.status === REJECTED_UPLOAD) fail("failed-precondition", rejectionMessage(row.rejectReason));
    // Any later status means an earlier call (or the trigger) already submitted it: same answer, no writes.
    if (row.status !== UPLOADING) return { ok: true, id, number, status: "submitted" };
    if (derivativeReady(row)) {
      markSubmitted(tx, db, ops, id, row);
      return { ok: true, id, number, status: "submitted" };
    }
    if (row.finalizeRequested !== true) {
      tx.update(ref, { finalizeRequested: true, finalizeRequestedAt: ops.serverTimestamp() });
    }
    return { ok: true, id, number, status: "processing" };
  });
}
