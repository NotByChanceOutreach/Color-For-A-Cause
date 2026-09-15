/**
 * Daily retention (contract C8).
 *
 * 1. Abandoned uploads: submissions stuck in 'uploading' or 'rejected_upload' for more than 24h never reached a
 *    person. They are handled OLDEST FIRST (the (status ASC, createdAt ASC) index), one row at a time. The query
 *    answer may be stale by the time a row's turn comes, so a transaction re-reads the row and deletes it and its
 *    consent record only if it is STILL abandoned (a row that moved on, e.g. finalized late, is left alone). Only
 *    after that commit are the Storage objects under submissions/{id}/ deleted; if that fails, part 3 finds them.
 *    A row that is already gone also has its objects deleted (the SDK re-ran a delete whose commit answer was lost;
 *    submission ids are never reused). A row that fails is logged and skipped, so it cannot stall the run.
 * 2. Orphan consents: consent records older than 24h whose submission no longer exists.
 * 3. Orphan objects: objects under submissions/{id}/ older than 24h whose submission doc is missing, an unstripped
 *    upload older than 24h that a processed (stripped) submission no longer needs, and the old browser-made
 *    derived/public.jpg of a reprocessed legacy piece that now uses derived/public-v2.jpg (legacy.ts), unless that
 *    row carries needsStaffLook (a person is asked to look at it; the old image may be the only copy with the
 *    artist's framing).
 * 4. Gallery leftovers: gallery/{id}/public.jpg older than an hour whose publicGallery doc is gone (an unpublish
 *    whose file removal failed, a publish that never committed). storage.rules already refuses tokenless reads of
 *    them; this revokes any download token they carry (a reader may have minted one while the piece was on the wall)
 *    and deletes them, each pinned to the generation the listing returned. That generation is read BEFORE the
 *    database is, and the submission row is read before the publicGallery doc: a publisher commits a copy only while
 *    holding the publish claim it took before copying (moderate.ts), so a copy whose row shows no claim, and whose
 *    doc is missing after that, can never be committed; a newer copy has another generation and is left alone.
 *    A claim past its `until` (a publisher that died or stalled) counts as released: a transaction removes it first
 *    (releaseExpiredPublishClaim; the stalled publisher's commit needs its own claim id, so it can never commit
 *    afterwards), then the row and the doc are read again and the rule above applies. A live claim keeps the file.
 * 5. Expired rate-limit counters (the TTL policy also removes these).
 *
 * Sweeps 2, 3 and 4 walk their collection a bounded page at a time and persist a cursor (system/retention), so each
 * day continues where the last one stopped and wraps around at the end. Nothing scans a whole collection in one run.
 *
 * Time budget: part 1 stops starting new rows after ABANDONED_BUDGET_MS, and parts 2-5 stop starting new pages
 * after SWEEP_DEADLINE_MS, so the cursor save and the audit record always fit inside RETENTION_SCHEDULE's timeout.
 */
import {
  CONSENT_ID_RE,
  GALLERY_LEFTOVER_MIN_AGE_MS,
  GALLERY_OBJECT_RE,
  REJECTED_UPLOAD,
  RETENTION_MS,
  SUBMISSION_ID_RE,
  SUBMISSION_OBJECT_RE,
  UPLOADING,
  paths,
} from "./constants";
import { hasReleasedClaim, isLiveClaim } from "./moderate";
import { toMillis, type Data, type Db, type Ops } from "./store";

export const RETENTION_STATUSES: readonly string[] = [UPLOADING, REJECTED_UPLOAD];

/** Part 1 starts no new row after this much time (the scheduled function times out at 540 s). */
export const ABANDONED_BUDGET_MS = 300_000;
/** Parts 2-4 start no new page after this much time since the run began. */
export const SWEEP_DEADLINE_MS = 450_000;

export type Candidate = { id: string; data: Data };
/** Query cursor: the ordering value (opaque to this module) and the document id. */
export type DocCursor = { at: unknown; id: string };
export type ConsentRow = { id: string; submissionId: unknown; at: unknown };
export type StoredFile = { name: string; createdMs: number };
/** A listed gallery object and the generation the listing returned (null when the listing did not say). */
export type GalleryFile = { name: string; generation: string | null; createdMs: number };
export type RetentionState = { consentCursor: DocCursor | null; storageCursor: string | null; galleryCursor?: string | null };
export type ExistingSubmission = { stripped: boolean; derivedPath?: string | null; needsStaffLook?: boolean };
/**
 * What the database says about a gallery object's piece (the row read first, then the publicGallery doc).
 * claimUntil: null when the row carries no publish claim, else the claim's `until` (0 for a malformed claim, which
 * moderate.ts treats as released too).
 */
export type GalleryState = { onWall: boolean; claimUntil: number | null; recorded: string | null };

export function isAbandoned(c: Candidate, nowMs: number): boolean {
  if (!SUBMISSION_ID_RE.test(c.id)) return false;
  if (!RETENTION_STATUSES.includes(String(c.data.status))) return false;
  const created = toMillis(c.data.createdAt);
  return created !== null && created < nowMs - RETENTION_MS;
}

/** Re-checks every row the query returned; the query is an optimization, this is the rule. */
export function selectAbandoned(rows: Candidate[], nowMs: number): Candidate[] {
  return rows.filter((row) => isAbandoned(row, nowMs));
}

/**
 * One transaction: re-read the submission and, only if it is still abandoned, delete it and its consent record.
 * Returns whether the row is gone afterwards: true when this deleted it, and also when it was already gone (the
 * Admin SDK re-runs a transaction whose commit answer was lost, and the re-run finds the row deleted by the first
 * attempt), so the caller still removes the Storage objects. Submission ids are never reused, so objects under a
 * missing row's prefix belong to nobody. False when the row is still there (it moved on).
 */
export async function deleteAbandonedRow(db: Db, id: string, nowMs: number): Promise<boolean> {
  if (!SUBMISSION_ID_RE.test(id)) return false;
  const ref = db.doc(`submissions/${id}`);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const row = snap.exists ? snap.data() : undefined;
    if (!row) return true;
    if (!isAbandoned({ id, data: row }, nowMs)) return false;
    tx.delete(ref);
    const consentId = row.consentId;
    if (typeof consentId === "string" && CONSENT_ID_RE.test(consentId)) tx.delete(db.doc(`consents/${consentId}`));
    return true;
  });
}

/**
 * One transaction: remove the row's publish claim if it counts as released (past its `until`, or malformed).
 * Returns true when the row carries no live claim afterwards (none, removed, or no row), false when a live claim is
 * there (a publisher may be about to commit its copy). Once removed, the stalled publisher that held it can never
 * commit (its commit requires its own claim id), so its copy is an ordinary leftover.
 */
export async function releaseExpiredPublishClaim(db: Db, ops: Ops, id: string, nowMs: number): Promise<boolean> {
  if (!SUBMISSION_ID_RE.test(id)) return false;
  const ref = db.doc(`submissions/${id}`);
  return db.runTransaction(async (tx) => {
    const row = (await tx.get(ref)).data();
    if (!row || row.publishClaim === undefined || row.publishClaim === null) return true;
    if (isLiveClaim(row.publishClaim, nowMs)) return false;
    if (hasReleasedClaim(row, nowMs)) tx.update(ref, { publishClaim: ops.deleteField() });
    return true;
  });
}

export interface RetentionDeps {
  /** Rows with this status and createdAt < cutoff, ordered by (createdAt ASC, id ASC), after `after`. */
  findCandidates(status: string, cutoff: Date, limit: number, after: DocCursor | null): Promise<Candidate[]>;
  /** deleteAbandonedRow: true when the row (still abandoned) and its consent were deleted, or the row is gone. */
  deleteAbandoned(id: string, nowMs: number): Promise<boolean>;
  deleteStoragePrefix(prefix: string): Promise<void>;
  deleteDocs(docPaths: string[]): Promise<void>;
  deleteExpiredRateLimits(now: Date, limit: number): Promise<number>;
  /** Consents with timestamp < cutoff, ordered by (timestamp ASC, id ASC), after `after`. */
  findOldConsents(cutoff: Date, limit: number, after: DocCursor | null): Promise<ConsentRow[]>;
  /** Which of these submission ids still have a document, and whether each one was processed (stripped). */
  existingSubmissions(ids: string[]): Promise<Map<string, ExistingSubmission>>;
  /** Objects under submissions/, in name order, starting at `startAt` (inclusive) when given. */
  listSubmissionObjects(limit: number, startAt: string | null): Promise<StoredFile[]>;
  deleteObject(name: string): Promise<void>;
  /** Objects under gallery/, in name order, with their generation, starting at `startAt` (inclusive) when given. */
  listGalleryObjects(limit: number, startAt: string | null): Promise<GalleryFile[]>;
  /**
   * For every id: whether publicGallery/{id} exists, the `until` of the publish claim submissions/{id} carries (if
   * any), and the gallery generation it records. MUST read the submission row before the publicGallery doc.
   */
  galleryState(ids: string[]): Promise<Map<string, GalleryState>>;
  /** releaseExpiredPublishClaim: true when the row carries no live publish claim afterwards. */
  releaseExpiredClaim(id: string, nowMs: number): Promise<boolean>;
  /** Remove every download token from exactly that generation; a missing object is not an error. */
  revokeGalleryTokens(name: string, generation: string): Promise<void>;
  /** Delete exactly that generation; a missing object (or another generation) is not an error. */
  deleteObjectGeneration(name: string, generation: string): Promise<void>;
  loadState(): Promise<RetentionState>;
  saveState(state: RetentionState): Promise<void>;
  record(summary: string): Promise<void>;
  /** Operational log. Ids and error text only; never personal data. */
  warn(message: string, fields: Record<string, unknown>): void;
  /** Milliseconds, for the time budget. */
  clock(): number;
}

export type RetentionOptions = { batchSize: number; maxBatches: number; abandonedBudgetMs: number; sweepDeadlineMs: number };

export const DEFAULT_RETENTION_OPTIONS: RetentionOptions = {
  batchSize: 200,
  maxBatches: 10,
  abandonedBudgetMs: ABANDONED_BUDGET_MS,
  sweepDeadlineMs: SWEEP_DEADLINE_MS,
};

export type RetentionResult = {
  deleted: string[];
  rateLimitsDeleted: number;
  orphanConsentsDeleted: number;
  orphanObjectsDeleted: number;
  leftoverUploadsDeleted: number;
  galleryLeftoversDeleted: number;
  failures: number;
  /** A time budget ran out; the rest waits for the next run. */
  stoppedEarly: boolean;
};

function errorText(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).slice(0, 300);
}

export async function runRetention(deps: RetentionDeps, nowMs: number, options: Partial<RetentionOptions> = {}): Promise<RetentionResult> {
  const opts = { ...DEFAULT_RETENTION_OPTIONS, ...options };
  const result: RetentionResult = {
    deleted: [],
    rateLimitsDeleted: 0,
    orphanConsentsDeleted: 0,
    orphanObjectsDeleted: 0,
    leftoverUploadsDeleted: 0,
    galleryLeftoversDeleted: 0,
    failures: 0,
    stoppedEarly: false,
  };
  const cutoff = new Date(nowMs - RETENTION_MS);
  const started = deps.clock();
  const past = (ms: number) => {
    if (deps.clock() - started < ms) return false;
    result.stoppedEarly = true;
    return true;
  };

  // 1. Abandoned uploads, oldest first.
  abandoned: for (const status of RETENTION_STATUSES) {
    let after: DocCursor | null = null;
    for (let i = 0; i < opts.maxBatches; i++) {
      if (past(opts.abandonedBudgetMs)) break abandoned;
      const rows = await deps.findCandidates(status, cutoff, opts.batchSize, after);
      for (const victim of selectAbandoned(rows, nowMs)) {
        if (past(opts.abandonedBudgetMs)) break abandoned;
        let removed: boolean;
        try {
          removed = await deps.deleteAbandoned(victim.id, nowMs);
        } catch (err) {
          result.failures += 1;
          deps.warn("retention: could not remove an abandoned upload; skipped", { id: victim.id, error: errorText(err) });
          continue;
        }
        if (!removed) continue; // it moved on since the query (e.g. finalized late): not ours to delete
        result.deleted.push(victim.id);
        try {
          await deps.deleteStoragePrefix(paths.submissionPrefix(victim.id));
        } catch (err) {
          result.failures += 1;
          deps.warn("retention: files of a removed upload are left for the orphan sweep", { id: victim.id, error: errorText(err) });
        }
      }
      if (rows.length < opts.batchSize) break;
      const last = rows[rows.length - 1];
      after = { at: last.data.createdAt, id: last.id };
    }
  }

  const state = await deps.loadState();

  // 2. Orphan consents.
  let consentCursor = state.consentCursor;
  for (let i = 0; i < opts.maxBatches; i++) {
    if (past(opts.sweepDeadlineMs)) break;
    const rows = await deps.findOldConsents(cutoff, opts.batchSize, consentCursor);
    const ids = [...new Set(rows.map((r) => r.submissionId).filter((s): s is string => typeof s === "string" && SUBMISSION_ID_RE.test(s)))];
    const existing = ids.length ? await deps.existingSubmissions(ids) : new Map<string, ExistingSubmission>();
    for (const row of rows) {
      // A consent whose submission id is missing or malformed is kept for a person to look at.
      if (!CONSENT_ID_RE.test(row.id) || typeof row.submissionId !== "string" || !SUBMISSION_ID_RE.test(row.submissionId)) continue;
      if (existing.has(row.submissionId)) continue;
      try {
        await deps.deleteDocs([`consents/${row.id}`]);
        result.orphanConsentsDeleted += 1;
      } catch (err) {
        result.failures += 1;
        deps.warn("retention: could not remove an orphan consent; skipped", { id: row.id, error: errorText(err) });
      }
    }
    if (rows.length < opts.batchSize) {
      consentCursor = null; // reached the end: start from the oldest again next time
      break;
    }
    const last = rows[rows.length - 1];
    consentCursor = { at: last.at, id: last.id };
  }

  // 3. Orphan Storage objects under submissions/{id}/, and leftover uploads of processed submissions.
  let storageCursor = state.storageCursor;
  for (let i = 0; i < opts.maxBatches; i++) {
    if (past(opts.sweepDeadlineMs)) break;
    // The listing starts AT the cursor (inclusive), so ask for one more and drop the cursor object itself:
    // every page then brings up to batchSize new objects, and a short page means the end was reached.
    const files = await deps.listSubmissionObjects(opts.batchSize + (storageCursor ? 1 : 0), storageCursor);
    const page = files.filter((f) => f.name !== storageCursor);
    const byId = new Map<string, StoredFile[]>();
    for (const f of page) {
      const id = SUBMISSION_OBJECT_RE.exec(f.name)?.[1];
      if (id) byId.set(id, [...(byId.get(id) ?? []), f]);
    }
    const existing = byId.size ? await deps.existingSubmissions([...byId.keys()]) : new Map<string, ExistingSubmission>();
    for (const [id, objects] of byId) {
      const row = existing.get(id);
      for (const f of objects) {
        if (!Number.isFinite(f.createdMs) || f.createdMs >= cutoff.getTime()) continue;
        // A processed row never needs its unstripped upload again (its removal after processing kept failing).
        // Legacy rows (never stripped) keep theirs: scripts/reprocess-legacy.mjs needs it. A reprocessed legacy row
        // uses derived/public-v2.jpg, so its old browser-made derived/public.jpg is a leftover too, unless the row asks
        // a person to look at it (needsStaffLook): then the old image is kept for them.
        const leftoverUpload = row?.stripped === true && f.name === paths.upload(id);
        const oldDerivative =
          row?.stripped === true && row.needsStaffLook !== true && row.derivedPath === paths.derivedV2(id) && f.name === paths.derived(id);
        if (row && !leftoverUpload && !oldDerivative) continue;
        try {
          await deps.deleteObject(f.name);
          if (row) result.leftoverUploadsDeleted += 1;
          else result.orphanObjectsDeleted += 1;
        } catch (err) {
          result.failures += 1;
          deps.warn("retention: could not remove an orphan object; skipped", { id, error: errorText(err) });
        }
      }
    }
    if (page.length < opts.batchSize) {
      storageCursor = null; // reached the end: start from the first object again next time
      break;
    }
    storageCursor = page[page.length - 1].name;
  }

  // 4. Gallery leftovers (see the header for why the pinned delete cannot hit a copy that is being committed).
  let galleryCursor = state.galleryCursor ?? null;
  for (let i = 0; i < opts.maxBatches; i++) {
    if (past(opts.sweepDeadlineMs)) break;
    const files = await deps.listGalleryObjects(opts.batchSize + (galleryCursor ? 1 : 0), galleryCursor);
    const page = files.filter((f) => f.name !== galleryCursor);
    const old = page.filter(
      (f): f is GalleryFile & { generation: string } =>
        GALLERY_OBJECT_RE.test(f.name) &&
        typeof f.generation === "string" &&
        Number.isFinite(f.createdMs) &&
        f.createdMs < nowMs - GALLERY_LEFTOVER_MIN_AGE_MS,
    );
    const idOf = (name: string) => GALLERY_OBJECT_RE.exec(name)?.[1] ?? "";
    const ids = [...new Set(old.map((f) => idOf(f.name)))];
    const states = ids.length ? await deps.galleryState(ids) : new Map<string, GalleryState>();
    for (const f of old) {
      const id = idOf(f.name);
      let s = states.get(id);
      // Unknown, on the wall, or recorded as live: not a leftover.
      if (!s || s.onWall || s.recorded === f.generation) continue;
      if (s.claimUntil !== null) {
        // A live claim: a publisher may be about to commit this very copy.
        if (s.claimUntil > nowMs) continue;
        // An expired claim is released first (fencing), then the row and the doc are read again.
        try {
          if (!(await deps.releaseExpiredClaim(id, nowMs))) continue;
          s = (await deps.galleryState([id])).get(id);
        } catch (err) {
          result.failures += 1;
          deps.warn("retention: could not release an expired publish claim; skipped", { id, error: errorText(err) });
          continue;
        }
        if (!s || s.onWall || s.claimUntil !== null || s.recorded === f.generation) continue;
      }
      try {
        await deps.revokeGalleryTokens(f.name, f.generation);
      } catch (err) {
        // The delete below still goes ahead; if it fails too, the next run revokes again.
        deps.warn("retention: could not revoke the download tokens of a gallery leftover", { id, error: errorText(err) });
      }
      try {
        await deps.deleteObjectGeneration(f.name, f.generation);
        result.galleryLeftoversDeleted += 1;
      } catch (err) {
        result.failures += 1;
        deps.warn("retention: could not remove a gallery leftover; skipped", { id, error: errorText(err) });
      }
    }
    if (page.length < opts.batchSize) {
      galleryCursor = null; // reached the end: start from the first object again next time
      break;
    }
    galleryCursor = page[page.length - 1].name;
  }

  await deps.saveState({ consentCursor, storageCursor, galleryCursor });

  // 5. Expired rate-limit counters.
  for (let i = 0; i < opts.maxBatches; i++) {
    if (past(opts.sweepDeadlineMs)) break;
    const n = await deps.deleteExpiredRateLimits(new Date(nowMs), opts.batchSize);
    result.rateLimitsDeleted += n;
    if (n < opts.batchSize) break;
  }

  const parts: string[] = [];
  if (result.deleted.length) parts.push(`${result.deleted.length} abandoned upload(s) older than 24h removed`);
  if (result.orphanConsentsDeleted) parts.push(`${result.orphanConsentsDeleted} orphan consent record(s) removed`);
  if (result.orphanObjectsDeleted) parts.push(`${result.orphanObjectsDeleted} orphan file(s) removed`);
  if (result.leftoverUploadsDeleted) parts.push(`${result.leftoverUploadsDeleted} leftover upload(s) of processed art removed`);
  if (result.galleryLeftoversDeleted) parts.push(`${result.galleryLeftoversDeleted} Art Wall file(s) left behind after unpublishing removed`);
  if (result.failures) parts.push(`${result.failures} item(s) skipped after an error`);
  if (result.stoppedEarly) parts.push("stopped early to stay within the time limit; the rest continues tomorrow");
  if (parts.length) await deps.record(parts.join("; "));
  return result;
}
