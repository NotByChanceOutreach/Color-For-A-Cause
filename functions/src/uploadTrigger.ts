/**
 * Storage finalize trigger for submissions/{id}/original/upload (contract C2).
 *
 * 1. Claim. A transaction records a processing lease {generation, owner, until} and counts the attempt. `owner` is
 *    a token unique to this run: the fencing token. A live lease held by another run for the same generation (a
 *    duplicate delivery) or for an OLDER generation (the signed URL was used again) THROWS LeaseBusy, so Eventarc
 *    redelivers later and the upload is kept. An event for a generation older than the leased one is 'superseded'.
 *    The row is marked 'rejected_upload' (processing_failed) instead only when BOTH hold: the upload is older than
 *    GIVE_UP_AFTER_MS (20 h, inside Eventarc's 24 h retry window) and at least GIVE_UP_MIN_FAILURES attempts were
 *    counted. A known temporary failure (transient.ts) is refunded and never counts; an unknown failure, or a run
 *    that never got as far as its own error handling (a crash, a timeout), does.
 * 2. Refusals (size, type, magic bytes, undecodable) first mark the row 'rejected_upload' in a transaction that
 *    requires our lease; only then is the upload deleted. "Undecodable" is only a KNOWN decode failure (the
 *    allowlist in transient.ts isUnreadableImage); any other error from sharp is rethrown and counted. If the pinned generation is gone (404: overwritten by a
 *    newer PUT), the run lets go of its lease and stops as 'superseded'; the newer generation's event does the work.
 * 3. sharp's output is written CREATE-ONLY (ifGenerationMatch=0) to original/stripped.jpg and derived/public.jpg.
 *    An object already there is a leftover of a run that never committed: it is deleted by its exact generation.
 * 4. A transaction records derivedGeneration, derivedMd5, strippedGeneration and stripped=true, only while our lease
 *    token is still on the row; if the browser already asked to finalize, the same transaction moves the row to
 *    'submitted' (see finalize.ts). If the row already records this run's generations, our own earlier attempt of
 *    this transaction landed (the Admin SDK re-runs a transaction whose commit answer was lost): that is success.
 * 5. Only after that commit is the unstripped upload deleted (pinned to its generation).
 *
 * Failures (a Storage 5xx, a failed transaction, sharp out of memory or any sharp error that is not a known decode
 * failure, anything unexpected): the run lets go of its
 * lease (refunding the attempt when the failure is known to be temporary) and rethrows, so Eventarc redelivers and
 * the upload is still there. Whatever the run wrote is a leftover the next run clears. A crash or a timeout leaves
 * the lease to expire and the attempt counted.
 *
 * WHY A RUN THAT OUTLIVES ITS LEASE CANNOT DO HARM. A lease is time-based, and a run that timed out may keep
 * executing (the platform does not kill it), so the lease alone proves nothing. Safety comes from fencing:
 *   - every row write a run makes (commit, refusal, lease release) is a transaction that requires its own lease
 *     token on the row. Tokens are never reused, so once another run has claimed the row, all of them fail;
 *   - a run never overwrites an object: saves are create-only;
 *   - a run deletes only generations it created itself, or a leftover whose generation it read BEFORE confirming it
 *     still held the lease. A generation read before that check existed before any later claim, and nothing can be
 *     committed while we hold the lease, so the leftover was never committed by anyone;
 *   - a run deletes the upload only once the row no longer needs it (processed, submitted, refused or gone).
 * LEASE_MS > UPLOAD_TRIGGER_OPTIONS.timeoutSeconds only keeps duplicate work rare; correctness does not depend on it.
 */
import { MAX_UPLOAD_BYTES, REJECTED_UPLOAD, UPLOAD_PATH_RE, UPLOADING, paths, type RejectReason } from "./constants";
import { markSubmitted } from "./finalize";
import type { ProcessedImage, ProcessOptions } from "./image";
import { audit, toMillis, type Data, type Db, type Ops } from "./store";
import { isTransientError, isUnreadableImage } from "./transient";
import { formatMatchesContentType, isUploadType, sniffImage } from "./upload";
import { normalizeCrop, normalizeRotation } from "./validation";

export const LEASE_MS = 10 * 60 * 1000;
/**
 * Giving up needs BOTH: the upload is at least this old (below Eventarc's 24 h retry window, so a late redelivery
 * still finds the row to mark and the upload to delete)...
 */
export const GIVE_UP_AFTER_MS = 20 * 60 * 60 * 1000;
/** ...and at least this many attempts were counted (unknown failures, crashes and timeouts; never a refunded one). */
export const GIVE_UP_MIN_FAILURES = 5;

/** Thrown when another live run holds the lease for this upload; the event is retried later. */
export class LeaseBusy extends Error {
  constructor(id: string) {
    super(`upload for ${id} is being processed by another run; retry later`);
    this.name = "LeaseBusy";
  }
}

/** ObjectStore.download: that generation of the object no longer exists (HTTP 404). */
export class ObjectGone extends Error {
  constructor(path: string) {
    super(`${path}: that generation no longer exists`);
    this.name = "ObjectGone";
  }
}

/** ObjectStore.save: the create-only write was refused because an object is already there (HTTP 412). */
export class ObjectExists extends Error {
  constructor(path: string) {
    super(`${path} already exists`);
    this.name = "ObjectExists";
  }
}

/** A run found that it no longer holds the row (another run claimed it, or the row moved on). */
export class LostLease extends Error {
  constructor(readonly keepUpload: boolean) {
    super("this run no longer holds the processing lease");
    this.name = "LostLease";
  }
}

export type UploadEvent = {
  name: string;
  generation: string;
  size: number;
  contentType: string | undefined;
  /** The object's creation time (event data timeCreated), when known. */
  timeCreatedMs?: number;
};
export type StoredObject = { generation: string; md5: string };

export interface ObjectStore {
  /** Exactly `generation` of `path`. Throws ObjectGone when that generation no longer exists. */
  download(path: string, generation: string): Promise<Buffer>;
  /** Create-only (ifGenerationMatch=0). Throws ObjectExists when `path` already holds an object. */
  save(path: string, data: Buffer): Promise<StoredObject>;
  /** The live generation at `path`, or null when there is none. */
  generationOf(path: string): Promise<string | null>;
  /** Delete; a missing object is not an error. With `generation`, only that generation. */
  remove(path: string, generation?: string): Promise<void>;
}

export interface UploadDeps extends ObjectStore {
  db: Db;
  ops: Ops;
  now(): number;
  /** Unique per invocation: the fencing token recorded in the lease. */
  leaseOwner: string;
  process(input: Buffer, opts: ProcessOptions): Promise<ProcessedImage>;
}

export type UploadOutcome =
  | "ignored"
  | "missing"
  | "not-uploading"
  | "already-processed"
  | "superseded"
  | "rejected"
  | "processed"
  | "submitted"
  | "stale";

export type UploadResult = { outcome: UploadOutcome; reason?: RejectReason };

export type Lease = { generation: string; owner: string; until: number };

export function readLease(v: unknown): Lease | null {
  if (!v || typeof v !== "object") return null;
  const l = v as Record<string, unknown>;
  return typeof l.generation === "string" && typeof l.owner === "string" && typeof l.until === "number"
    ? { generation: l.generation, owner: l.owner, until: l.until }
    : null;
}

/** Cloud Storage generations grow over time for one object name. */
export function isNewerGeneration(a: string, b: string): boolean {
  try {
    return BigInt(a) > BigInt(b);
  } catch {
    return false;
  }
}

function attemptsOf(row: Data): number {
  const n = row.processingAttempts;
  return typeof n === "number" && Number.isInteger(n) && n > 0 ? n : 0;
}

/**
 * When the upload started: the earliest of the object's creation time, the row's createdAt and the first claim
 * (processingSince, recorded by the first claim so there is always an anchor).
 */
export function uploadStartedAt(ev: UploadEvent, row: Data, now: number): number {
  const anchors = [ev.timeCreatedMs, toMillis(row.createdAt), row.processingSince].filter(
    (v): v is number => typeof v === "number" && Number.isFinite(v),
  );
  return anchors.length ? Math.min(...anchors) : now;
}

/** The upload is still needed while the row waits for a derivative: another run may be about to use it. */
function uploadStillNeeded(cur: Data | undefined): boolean {
  return !!cur && cur.status === UPLOADING && typeof cur.derivedGeneration !== "string";
}

/**
 * Create-only write of `path`. When something is already there, its generation is read FIRST and then
 * `confirmLeftover` must confirm the caller still owns the row (it throws LostLease otherwise); only then is exactly
 * that generation deleted and the write tried again. Shared with legacy.ts.
 */
export async function saveCreateOnly(
  store: Pick<ObjectStore, "save" | "generationOf" | "remove">,
  path: string,
  data: Buffer,
  confirmLeftover: (generation: string) => Promise<void>,
): Promise<StoredObject> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await store.save(path, data);
    } catch (err) {
      if (!(err instanceof ObjectExists)) throw err;
    }
    const leftover = await store.generationOf(path);
    if (leftover === null) continue; // removed meanwhile: just try again
    await confirmLeftover(leftover);
    await store.remove(path, leftover);
  }
  throw new Error(`${path} keeps being recreated by another writer; will retry`);
}

type Claim =
  | { kind: "claimed"; row: Data; attemptsBefore: number }
  | { kind: "exhausted" | "missing" | "not-uploading" | "already-processed" | "superseded" | "busy" };

export async function handleOriginalUpload(ev: UploadEvent, deps: UploadDeps): Promise<UploadResult> {
  const match = UPLOAD_PATH_RE.exec(ev.name);
  if (!match) return { outcome: "ignored" };
  const id = match[1];
  const { db, ops } = deps;
  const ref = db.doc(`submissions/${id}`);

  const claim = await db.runTransaction<Claim>(async (tx) => {
    const snap = await tx.get(ref);
    const row = snap.exists ? snap.data() : undefined;
    if (!row) return { kind: "missing" };
    if (row.status !== UPLOADING) return { kind: "not-uploading" };
    if (typeof row.derivedGeneration === "string") return { kind: "already-processed" };
    const now = deps.now();
    const lease = readLease(row.processingLease);
    const attempts = attemptsOf(row);
    // Our own claim seen again: the SDK re-ran this transaction after losing its commit answer.
    if (lease?.owner === deps.leaseOwner) return { kind: "claimed", row, attemptsBefore: Math.max(0, attempts - 1) };
    if (lease && lease.until > now) {
      // The leased generation is newer: ours was overwritten, so there is nothing left to process.
      if (isNewerGeneration(lease.generation, ev.generation)) return { kind: "superseded" };
      // A duplicate delivery of the same generation, or a newer PUT: wait until the holder finishes or lets go.
      return { kind: "busy" };
    }
    if (attempts >= GIVE_UP_MIN_FAILURES && now - uploadStartedAt(ev, row, now) >= GIVE_UP_AFTER_MS) {
      tx.update(ref, {
        status: REJECTED_UPLOAD,
        rejectReason: "processing_failed",
        rejectedAt: ops.serverTimestamp(),
        processingLease: ops.deleteField(),
      });
      audit(tx, db, ops, { actor: "system", action: "upload-rejected", target: id, detail: "processing_failed" });
      return { kind: "exhausted" };
    }
    // Counted now; refunded if this run ends in a known temporary failure. A crash or timeout keeps it counted.
    tx.update(ref, {
      processingLease: { generation: ev.generation, owner: deps.leaseOwner, until: now + LEASE_MS },
      processingAttempts: attempts + 1,
      ...(typeof row.processingSince === "number" ? {} : { processingSince: now }),
    });
    return { kind: "claimed", row, attemptsBefore: attempts };
  });

  // Keep the upload: the run holding the lease needs it, and if that run dies the retry will too.
  if (claim.kind === "busy") throw new LeaseBusy(id);
  if (claim.kind === "exhausted") {
    // The row already says 'rejected_upload', so the upload can go (a failed delete is redone by the redelivery).
    await deps.remove(ev.name, ev.generation);
    return { outcome: "rejected", reason: "processing_failed" };
  }
  if (claim.kind !== "claimed") {
    // Not ours to process (unknown id, already submitted/reviewed/processed, or an overwritten generation).
    await deps.remove(ev.name, ev.generation);
    return { outcome: claim.kind };
  }

  const attemptsBefore = claim.attemptsBefore;
  const release = (refund: boolean) =>
    db.runTransaction(async (tx) => {
      const cur = (await tx.get(ref)).data();
      if (!cur || readLease(cur.processingLease)?.owner !== deps.leaseOwner) return;
      tx.update(ref, { processingLease: ops.deleteField(), ...(refund ? { processingAttempts: attemptsBefore } : {}) });
    });

  try {
    return await processClaimed(ev, deps, id, claim.row, release);
  } catch (err) {
    // Keep the upload, let go of the lease so the redelivery can start at once, and rethrow so Eventarc redelivers
    // (UPLOAD_TRIGGER_OPTIONS.retry). A known temporary failure is refunded: no outage, however long, can use up
    // the budget. An unknown one counts toward GIVE_UP_MIN_FAILURES.
    await release(isTransientError(err)).catch(() => undefined);
    throw err;
  }
}

async function processClaimed(
  ev: UploadEvent,
  deps: UploadDeps,
  id: string,
  row: Data,
  release: (refund: boolean) => Promise<void>,
): Promise<UploadResult> {
  const { db, ops } = deps;
  const ref = db.doc(`submissions/${id}`);
  const me = deps.leaseOwner;
  const written: Array<StoredObject & { path: string }> = [];

  /** Still waiting for a derivative and still carrying OUR lease token. */
  const ownsRow = (cur: Data | undefined): cur is Data =>
    !!cur && cur.status === UPLOADING && typeof cur.derivedGeneration !== "string" && readLease(cur.processingLease)?.owner === me;

  const stale = async (keepUpload: boolean): Promise<UploadResult> => {
    // Only the generations this run created; never an object another run made.
    for (const w of written) await deps.remove(w.path, w.generation);
    if (!keepUpload) await deps.remove(ev.name, ev.generation);
    return { outcome: "stale" };
  };

  const reject = async (reason: RejectReason): Promise<UploadResult> => {
    // The row is marked first: from then on every redelivery (and retention) deletes the upload, so a refused
    // file (which may carry EXIF/GPS) cannot outlive the row, and the upload is never deleted while the row waits.
    const verdict = await db.runTransaction<"marked" | "keep" | "drop">(async (tx) => {
      const cur = (await tx.get(ref)).data();
      if (!ownsRow(cur)) return uploadStillNeeded(cur) ? "keep" : "drop";
      tx.update(ref, {
        status: REJECTED_UPLOAD,
        rejectReason: reason,
        rejectedAt: ops.serverTimestamp(),
        processingLease: ops.deleteField(),
      });
      audit(tx, db, ops, { actor: "system", action: "upload-rejected", target: id, detail: reason });
      return "marked";
    });
    if (verdict === "keep") return { outcome: "stale" };
    await deps.remove(ev.name, ev.generation);
    return verdict === "marked" ? { outcome: "rejected", reason } : { outcome: "stale" };
  };

  const size = Number(ev.size);
  if (!Number.isFinite(size) || size < 1) return reject("empty");
  if (size > MAX_UPLOAD_BYTES) return reject("too_large");
  const contentType = ev.contentType;
  if (!isUploadType(contentType) || contentType !== row.originalMime) return reject("wrong_type");

  let input: Buffer;
  try {
    input = await deps.download(ev.name, ev.generation);
  } catch (err) {
    // Anything but a definite 404 is transient: the caller releases the lease and rethrows.
    if (!(err instanceof ObjectGone)) throw err;
    // Overwritten by a newer PUT of the same signed URL: that generation's own event does the work.
    await release(true);
    return { outcome: "superseded" };
  }
  if (input.length < 1) return reject("empty");
  if (input.length > MAX_UPLOAD_BYTES) return reject("too_large");
  const format = sniffImage(input);
  if (!format || !formatMatchesContentType(format, contentType)) return reject("not_an_image");

  let processed: ProcessedImage;
  try {
    processed = await deps.process(input, { rotate: normalizeRotation(row.rotate), cropPct: normalizeCrop(row.cropPct) });
  } catch (err) {
    // Only a known decode failure is about the picture. Anything else (out of memory, threads, disk, an unknown
    // sharp error) is rethrown: the caller releases the lease, the attempt counts, and only the cap can end it.
    if (!isUnreadableImage(err)) throw err;
    return reject("unreadable");
  }

  // Read the leftover's generation first (saveCreateOnly), then check the row: see the header for why that order.
  const confirmLeftover = async (leftover: string) => {
    const cur = (await db.get(ref)).data();
    if (!ownsRow(cur) || cur.strippedGeneration === leftover) throw new LostLease(uploadStillNeeded(cur));
  };
  let saved: { stripped: StoredObject; derived: StoredObject };
  try {
    const strippedObj = await saveCreateOnly(deps, paths.stripped(id), processed.stripped.data, confirmLeftover);
    written.push({ path: paths.stripped(id), ...strippedObj });
    const derivedObj = await saveCreateOnly(deps, paths.derived(id), processed.derived.data, confirmLeftover);
    written.push({ path: paths.derived(id), ...derivedObj });
    saved = { stripped: strippedObj, derived: derivedObj };
  } catch (err) {
    if (err instanceof LostLease) return stale(err.keepUpload);
    throw err;
  }
  const { stripped, derived } = saved;

  type Commit = { outcome: "processed" | "submitted" } | { outcome: "stale"; keepUpload: boolean };
  // If this throws, the caller releases the lease and rethrows: the upload is still there for the retry.
  const commit = await db.runTransaction<Commit>(async (tx) => {
    const cur = (await tx.get(ref)).data();
    if (cur && cur.derivedGeneration === derived.generation && cur.strippedGeneration === stripped.generation) {
      // Our own earlier attempt of this transaction committed; its answer was lost. Success, never 'stale'.
      return { outcome: cur.status === UPLOADING ? "processed" : "submitted" };
    }
    if (!ownsRow(cur) || readLease(cur.processingLease)?.generation !== ev.generation) {
      return { outcome: "stale", keepUpload: uploadStillNeeded(cur) };
    }
    tx.update(ref, {
      stripped: true,
      derivedGeneration: derived.generation,
      derivedMd5: derived.md5,
      strippedGeneration: stripped.generation,
      originalPath: paths.stripped(id),
      derivedPath: paths.derived(id),
      storedMime: "image/jpeg",
      width: processed.derived.width,
      height: processed.derived.height,
      processedAt: ops.serverTimestamp(),
      processingLease: ops.deleteField(),
      processingAttempts: ops.deleteField(),
      processingSince: ops.deleteField(),
    });
    if (cur.finalizeRequested === true) {
      markSubmitted(tx, db, ops, id, cur);
      return { outcome: "submitted" };
    }
    return { outcome: "processed" };
  });

  if (commit.outcome === "stale") return stale(commit.keepUpload);
  // Committed: the unstripped upload never outlives a finished run. If this delete fails, the throw makes
  // Eventarc redeliver, and the redelivery deletes it as 'already-processed'.
  await deps.remove(ev.name, ev.generation);
  return { outcome: commit.outcome };
}
