import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { paths } from "../../functions/src/constants";
import { RETENTION_SCHEDULE } from "../../functions/src/options";
import { PUBLISH_CLAIM_MS, moderateSubmission, readPublishClaim } from "../../functions/src/moderate";
import {
  ABANDONED_BUDGET_MS,
  SWEEP_DEADLINE_MS,
  deleteAbandonedRow,
  isAbandoned,
  releaseExpiredPublishClaim,
  runRetention,
  type Candidate,
  type ConsentRow,
  type DocCursor,
  type ExistingSubmission,
  type GalleryFile,
  type GalleryState,
  type RetentionDeps,
  type RetentionResult,
  type RetentionState,
  type StoredFile,
} from "../../functions/src/retention";
import { toMillis } from "../../functions/src/store";
import { FakeBucket, FakeDb, NOW, expectCode, fakeOps, loseCommitAnswer, moderateDeps, reviewable } from "./fixtures";

const HOUR = 60 * 60 * 1000;
const CONSENT = `con_${"a".repeat(32)}`;
const id = (n: number) => `sub_${String(n).padStart(32, "0")}`;
const con = (n: number) => `con_${String(n).padStart(32, "0")}`;
const row = (status: string, ageMs: number, extra: Record<string, unknown> = {}) => ({
  status,
  createdAt: new Date(NOW - ageMs),
  consentId: CONSENT,
  ...extra,
});

describe("C8 which submissions are abandoned", () => {
  it.each([
    ["uploading for 25h", "uploading", 25 * HOUR, true],
    ["uploading for 23h", "uploading", 23 * HOUR, false],
    ["uploading for exactly 24h", "uploading", 24 * HOUR, false],
    ["rejected_upload for 25h", "rejected_upload", 25 * HOUR, true],
    ["submitted for 30 days", "submitted", 30 * 24 * HOUR, false],
    ["approved for 30 days", "approved", 30 * 24 * HOUR, false],
    ["hold for 30 days", "hold", 30 * 24 * HOUR, false],
  ])("%s", (_name, status, age, expected) => {
    expect(isAbandoned({ id: id(1), data: row(status as string, age as number) }, NOW)).toBe(expected);
  });

  it("reads Firestore timestamps and refuses rows without a date or with odd ids", () => {
    const old = NOW - 25 * HOUR;
    expect(isAbandoned({ id: id(1), data: { status: "uploading", createdAt: { toMillis: () => old } } }, NOW)).toBe(true);
    expect(isAbandoned({ id: id(1), data: { status: "uploading", createdAt: { seconds: old / 1000, nanoseconds: 0 } } }, NOW)).toBe(true);
    expect(isAbandoned({ id: id(1), data: { status: "uploading" } }, NOW)).toBe(false);
    expect(isAbandoned({ id: "sub_bad", data: row("uploading", 30 * HOUR) }, NOW)).toBe(false);
  });
});

type World = {
  candidates?: Record<string, Candidate[]>;
  consents?: ConsentRow[];
  submissions?: string[];
  /** Existing submissions that were processed (stripped). */
  stripped?: string[];
  /** Existing, stripped submissions reprocessed by legacy.ts (derivedPath = public-v2.jpg). */
  v2?: string[];
  /** Existing submissions whose row carries needsStaffLook. */
  staffLook?: string[];
  objects?: StoredFile[];
  gallery?: GalleryFile[];
  galleryStates?: Record<string, GalleryState>;
  state?: RetentionState;
  rateLimitBatches?: number[];
  failPrefix?: (prefix: string) => boolean;
  failRow?: (id: string) => boolean;
  clock?: () => number;
};

/**
 * An in-memory model of what index.ts queries: candidates ordered by (createdAt, id) and paged by cursor,
 * consents ordered by (timestamp, id), objects in name order with an inclusive start.
 */
function world(w: World = {}) {
  const calls = {
    cursors: [] as Array<{ status: string; after: DocCursor | null }>,
    abandoned: [] as string[],
    prefixes: [] as string[],
    docs: [] as string[][],
    objectsDeleted: [] as string[],
    records: [] as string[],
    warnings: [] as Array<{ message: string; fields: Record<string, unknown> }>,
    saved: [] as RetentionState[],
    rateLimitCalls: 0,
    galleryDeleted: [] as Array<{ name: string; generation: string }>,
    revoked: [] as Array<{ name: string; generation: string }>,
    released: [] as string[],
  };
  const states: Record<string, GalleryState> = { ...(w.galleryStates ?? {}) };
  const v2 = new Set(w.v2 ?? []);
  const existing = new Set([...(w.submissions ?? []), ...(w.stripped ?? []), ...v2]);
  const stripped = new Set([...(w.stripped ?? []), ...v2]);
  const gallery = [...(w.gallery ?? [])].sort((a, b) => a.name.localeCompare(b.name));
  const consents = [...(w.consents ?? [])];
  const objects = [...(w.objects ?? [])].sort((a, b) => a.name.localeCompare(b.name));
  const batches = [...(w.rateLimitBatches ?? [0])];
  const byTime = (a: { at: unknown; id: string }, b: { at: unknown; id: string }) =>
    (toMillis(a.at) ?? 0) - (toMillis(b.at) ?? 0) || a.id.localeCompare(b.id);
  const page = <T extends { at: unknown; id: string }>(rows: T[], after: DocCursor | null, limit: number) => {
    const sorted = [...rows].sort(byTime);
    const start = after ? sorted.filter((r) => byTime(r, after) <= 0).length : 0;
    return sorted.slice(start, start + limit);
  };
  const deps: RetentionDeps = {
    findCandidates: async (status, cutoff, limit, after) => {
      calls.cursors.push({ status, after });
      const rows = (w.candidates?.[status] ?? [])
        .filter((c) => (toMillis(c.data.createdAt) ?? Infinity) < cutoff.getTime())
        .map((c) => ({ ...c, at: c.data.createdAt }));
      return page(rows, after, limit).map(({ id: cid, data }) => ({ id: cid, data }));
    },
    deleteAbandoned: async (cid) => {
      if (w.failRow?.(cid)) throw new Error(`ABORTED deleting ${cid}`);
      calls.abandoned.push(cid);
      return true;
    },
    deleteStoragePrefix: async (prefix) => {
      if (w.failPrefix?.(prefix)) throw new Error(`503 deleting ${prefix}`);
      calls.prefixes.push(prefix);
    },
    deleteDocs: async (docPaths) => {
      calls.docs.push(docPaths);
    },
    deleteExpiredRateLimits: async () => {
      calls.rateLimitCalls += 1;
      return batches.shift() ?? 0;
    },
    findOldConsents: async (cutoff, limit, after) =>
      page(
        consents.filter((c) => (toMillis(c.at) ?? Infinity) < cutoff.getTime()),
        after,
        limit,
      ),
    existingSubmissions: async (ids) =>
      new Map<string, ExistingSubmission>(
        ids
          .filter((i) => existing.has(i))
          .map((i) => [
            i,
            {
              stripped: stripped.has(i),
              derivedPath: v2.has(i) ? paths.derivedV2(i) : paths.derived(i),
              needsStaffLook: (w.staffLook ?? []).includes(i),
            },
          ]),
      ),
    listSubmissionObjects: async (limit, startAt) => objects.filter((o) => !startAt || o.name >= startAt).slice(0, limit),
    deleteObject: async (name) => {
      calls.objectsDeleted.push(name);
    },
    listGalleryObjects: async (limit, startAt) => gallery.filter((o) => !startAt || o.name >= startAt).slice(0, limit),
    galleryState: async (ids) =>
      new Map<string, GalleryState>(ids.map((i) => [i, states[i] ?? { onWall: false, claimUntil: null, recorded: null }])),
    releaseExpiredClaim: async (cid, nowMs) => {
      calls.released.push(cid);
      const st = states[cid];
      if (st && st.claimUntil !== null && st.claimUntil > nowMs) return false;
      if (st) states[cid] = { ...st, claimUntil: null };
      return true;
    },
    revokeGalleryTokens: async (name, generation) => {
      calls.revoked.push({ name, generation });
    },
    deleteObjectGeneration: async (name, generation) => {
      calls.galleryDeleted.push({ name, generation });
    },
    loadState: async () => w.state ?? { consentCursor: null, storageCursor: null },
    saveState: async (state) => {
      calls.saved.push(state);
    },
    record: async (summary) => {
      calls.records.push(summary);
    },
    warn: (message, fields) => {
      calls.warnings.push({ message, fields });
    },
    clock: w.clock ?? (() => 0),
  };
  return { deps, calls };
}

describe("C8 abandoned uploads", () => {
  it("deletes the Storage prefix, the submission and its consent, and nothing else", async () => {
    const { deps, calls } = world({
      candidates: {
        uploading: [
          { id: id(1), data: row("uploading", 30 * HOUR) },
          { id: id(2), data: row("uploading", 2 * HOUR) },
          { id: "sub_evil/../..", data: row("uploading", 30 * HOUR) },
          { id: id(4), data: row("submitted", 30 * HOUR) },
        ],
        rejected_upload: [{ id: id(3), data: row("rejected_upload", 48 * HOUR, { consentId: "not-a-consent-id" }) }],
      },
    });
    const res = await runRetention(deps, NOW);
    expect(res.deleted).toEqual([id(1), id(3)]);
    expect(calls.abandoned).toEqual([id(1), id(3)]);
    expect(calls.prefixes).toEqual([`submissions/${id(1)}/`, `submissions/${id(3)}/`]);
    expect(calls.docs).toEqual([]); // the rows and consents go inside deleteAbandoned's transaction
    expect(calls.records).toHaveLength(1);
  });

  it("works oldest first and pages with a cursor from the last row", async () => {
    const rows = [5, 1, 4, 2, 3].map((n) => ({ id: id(n), data: row("uploading", (30 + n) * HOUR) }));
    const { deps, calls } = world({ candidates: { uploading: rows } });
    const res = await runRetention(deps, NOW, { batchSize: 2, maxBatches: 10 });
    expect(res.deleted).toEqual([id(5), id(4), id(3), id(2), id(1)]);
    const cursors = calls.cursors.filter((c) => c.status === "uploading").map((c) => c.after?.id ?? null);
    expect(cursors).toEqual([null, id(4), id(2)]);
    const src = readFileSync("functions/src/index.ts", "utf8");
    expect(src).toMatch(/\.orderBy\("createdAt", "asc"\)\s*\.orderBy\(DOC_ID, "asc"\)/);
    expect(src).toMatch(/startAfter\(after\.at, after\.id\)/);
  });

  it("one bad row is logged and skipped; it cannot stall the rows behind it", async () => {
    const rows = [1, 2, 3].map((n) => ({ id: id(n), data: row("uploading", (40 - n) * HOUR) }));
    const { deps, calls } = world({
      candidates: { uploading: rows },
      failRow: (rid) => rid === id(1) || rid === id(2),
    });
    const res = await runRetention(deps, NOW, { batchSize: 2, maxBatches: 10 });
    expect(res.deleted).toEqual([id(3)]);
    expect(res.failures).toBe(2);
    expect(calls.prefixes).toEqual([`submissions/${id(3)}/`]); // no files go for a row that is still there
    expect(calls.warnings.map((w) => w.fields.id)).toEqual([id(1), id(2)]);
    expect(JSON.stringify(calls.warnings)).not.toMatch(/@/);
    expect(calls.records[0]).toMatch(/2 item\(s\) skipped/);
  });

  it("files that could not be removed after the row went are left for the orphan sweep, and logged", async () => {
    const { deps, calls } = world({
      candidates: { uploading: [{ id: id(1), data: row("uploading", 30 * HOUR) }] },
      failPrefix: () => true,
    });
    const res = await runRetention(deps, NOW);
    expect(res.deleted).toEqual([id(1)]);
    expect(res.failures).toBe(1);
    expect(calls.warnings[0].message).toMatch(/orphan sweep/);
  });

  it("does nothing (and records nothing) when there is nothing to delete", async () => {
    const { deps, calls } = world({});
    const res = await runRetention(deps, NOW);
    expect(res.deleted).toEqual([]);
    expect(calls.prefixes).toEqual([]);
    expect(calls.records).toEqual([]);
  });

  it("pages through expired rate-limit records", async () => {
    const { deps, calls } = world({ rateLimitBatches: [200, 200, 5] });
    const res = await runRetention(deps, NOW);
    expect(res.rateLimitsDeleted).toBe(405);
    expect(calls.rateLimitCalls).toBe(3);
  });

  it("refuses to build a Storage prefix from a malformed id", () => {
    expect(() => paths.submissionPrefix("sub_x")).toThrow();
    expect(() => paths.submissionPrefix("")).toThrow();
    expect(paths.submissionPrefix(id(9))).toBe(`submissions/${id(9)}/`);
  });

  it("the oldest-first query has its composite index", () => {
    const indexes = JSON.parse(readFileSync("firestore.indexes.json", "utf8")).indexes as Array<{
      collectionGroup: string;
      fields: Array<{ fieldPath: string; order: string }>;
    }>;
    const match = indexes.find(
      (ix) =>
        ix.collectionGroup === "submissions" &&
        JSON.stringify(ix.fields) ===
          JSON.stringify([
            { fieldPath: "status", order: "ASCENDING" },
            { fieldPath: "createdAt", order: "ASCENDING" },
          ]),
    );
    expect(match).toBeTruthy();
  });
});

describe("C8 abandoned rows are re-checked in a transaction at delete time", () => {
  const seed = (db: FakeDb, sid: string, status: string, ageMs: number) => {
    db.patch(`submissions/${sid}`, { id: sid, status, createdAt: new Date(NOW - ageMs), consentId: CONSENT });
    db.patch(`consents/${CONSENT}`, { id: CONSENT, submissionId: sid });
  };

  it("a row that turned 'submitted' between the query and the delete is left alone, files and all", async () => {
    const db = new FakeDb();
    seed(db, id(1), "uploading", 30 * HOUR);
    const snapshot = db.data(`submissions/${id(1)}`)!;
    const { deps, calls } = world({});
    deps.findCandidates = async (status) => {
      if (status !== "uploading") return [];
      // The query answered 'uploading'; a late finalize flips the row right after.
      const answer = [{ id: id(1), data: snapshot }];
      db.patch(`submissions/${id(1)}`, { status: "submitted" });
      return answer;
    };
    deps.deleteAbandoned = (sid, now) => deleteAbandonedRow(db, sid, now);
    const res = await runRetention(deps, NOW);
    expect(res.deleted).toEqual([]);
    expect(calls.prefixes).toEqual([]);
    expect(db.data(`submissions/${id(1)}`)?.status).toBe("submitted");
    expect(db.data(`consents/${CONSENT}`)).toBeDefined();
  });

  it("a row still abandoned is deleted with its consent in one transaction, then its files", async () => {
    const db = new FakeDb();
    seed(db, id(1), "rejected_upload", 30 * HOUR);
    const { deps, calls } = world({ candidates: { rejected_upload: [{ id: id(1), data: db.data(`submissions/${id(1)}`)! }] } });
    deps.deleteAbandoned = (sid, now) => deleteAbandonedRow(db, sid, now);
    const before = db.transactions;
    const res = await runRetention(deps, NOW);
    expect(res.deleted).toEqual([id(1)]);
    expect(db.transactions - before).toBe(1);
    expect(db.data(`submissions/${id(1)}`)).toBeUndefined();
    expect(db.data(`consents/${CONSENT}`)).toBeUndefined();
    expect(calls.prefixes).toEqual([`submissions/${id(1)}/`]);
  });

  it("a delete whose commit answer was lost still removes the files: the re-run finds the row gone (round 4, G)", async () => {
    const db = new FakeDb();
    seed(db, id(1), "uploading", 30 * HOUR);
    const { deps, calls } = world({ candidates: { uploading: [{ id: id(1), data: db.data(`submissions/${id(1)}`)! }] } });
    deps.deleteAbandoned = (sid, now) => deleteAbandonedRow(db, sid, now);
    loseCommitAnswer(db, 1); // the delete lands, the SDK loses the answer and runs the transaction again
    const res = await runRetention(deps, NOW);
    expect(res.deleted).toEqual([id(1)]);
    expect(db.data(`submissions/${id(1)}`)).toBeUndefined();
    expect(db.data(`consents/${CONSENT}`)).toBeUndefined();
    expect(calls.prefixes).toEqual([`submissions/${id(1)}/`]);
  });

  it("deleteAbandonedRow refuses young rows, other statuses and malformed ids; a row already gone counts as gone", async () => {
    const db = new FakeDb();
    seed(db, id(1), "uploading", 2 * HOUR);
    seed(db, id(2), "hold", 90 * 24 * HOUR);
    expect(await deleteAbandonedRow(db, id(1), NOW)).toBe(false);
    expect(await deleteAbandonedRow(db, id(2), NOW)).toBe(false);
    expect(await deleteAbandonedRow(db, id(3), NOW)).toBe(true);
    expect(await deleteAbandonedRow(db, "sub_bad", NOW)).toBe(false);
    expect(db.data(`submissions/${id(1)}`)).toBeDefined();
    expect(db.data(`submissions/${id(2)}`)).toBeDefined();
  });

  it("index.ts wires the transactional delete", () => {
    const src = readFileSync("functions/src/index.ts", "utf8");
    expect(src).toMatch(/deleteAbandoned: \(id, nowMs\) => deleteAbandonedRow\(db, id, nowMs\)/);
    expect(src).toMatch(/clock: Date\.now/);
  });
});

describe("C8 time budget", () => {
  it("the budgets leave room for the cursor save and the audit record inside the scheduled timeout", () => {
    expect(ABANDONED_BUDGET_MS).toBeLessThan(SWEEP_DEADLINE_MS);
    expect(SWEEP_DEADLINE_MS).toBeLessThanOrEqual(RETENTION_SCHEDULE.timeoutSeconds * 1000 - 60_000);
  });

  it("a slow backlog stops part 1 early; the sweeps, the cursor save and the audit record still run", async () => {
    let t = 0;
    const rows = Array.from({ length: 12 }, (_, n) => ({ id: id(n + 1), data: row("uploading", (100 - n) * HOUR) }));
    const { deps, calls } = world({
      candidates: { uploading: rows },
      consents: [{ id: con(9), submissionId: id(99), at: new Date(NOW - 48 * HOUR) }],
      clock: () => t,
    });
    const slow = deps.deleteAbandoned;
    deps.deleteAbandoned = async (sid, now) => {
      t += 60_000; // each row takes a minute
      return slow(sid, now);
    };
    const res = await runRetention(deps, NOW);
    expect(res.deleted).toHaveLength(ABANDONED_BUDGET_MS / 60_000);
    expect(res.stoppedEarly).toBe(true);
    expect(res.orphanConsentsDeleted).toBe(1);
    expect(calls.saved).toHaveLength(1);
    expect(calls.records[0]).toMatch(/stopped early/);
  });

  it("the sweeps stop at their deadline too, and the cursor is saved where they stopped", async () => {
    let t = 0;
    const consents = [1, 2, 3, 4].map((n) => ({ id: con(n), submissionId: id(n), at: new Date(NOW - (50 - n) * HOUR) }));
    const { deps, calls } = world({ consents, clock: () => t });
    deps.deleteDocs = async () => {
      t += SWEEP_DEADLINE_MS; // one slow page is all the time there is
    };
    const res = await runRetention(deps, NOW, { batchSize: 2, maxBatches: 10 });
    expect(res.orphanConsentsDeleted).toBe(2);
    expect(res.stoppedEarly).toBe(true);
    expect(calls.saved.at(-1)?.consentCursor?.id).toBe(con(2));
  });
});

describe("C8 orphan consents", () => {
  const old = (hours: number) => new Date(NOW - hours * HOUR);

  it("removes old consents whose submission is gone, keeps the rest", async () => {
    const { deps, calls } = world({
      submissions: [id(1)],
      consents: [
        { id: con(1), submissionId: id(1), at: old(48) }, // submission exists
        { id: con(2), submissionId: id(2), at: old(47) }, // orphan
        { id: con(3), submissionId: "sub_bad", at: old(46) }, // malformed: a person looks at it
        { id: con(4), submissionId: undefined, at: old(45) }, // no link: a person looks at it
        { id: con(5), submissionId: id(5), at: old(44) }, // orphan
        { id: con(6), submissionId: id(6), at: old(2) }, // too new
      ],
    });
    const res = await runRetention(deps, NOW);
    expect(res.orphanConsentsDeleted).toBe(2);
    expect(calls.docs).toEqual([[`consents/${con(2)}`], [`consents/${con(5)}`]]);
    expect(calls.saved.at(-1)?.consentCursor).toBeNull(); // reached the end: wrap around next time
    expect(calls.records[0]).toMatch(/2 orphan consent/);
  });

  it("continues where the last run stopped", async () => {
    const consents = [1, 2, 3].map((n) => ({ id: con(n), submissionId: id(n), at: old(50 - n) }));
    const first = world({ consents });
    await runRetention(first.deps, NOW, { batchSize: 2, maxBatches: 1 });
    expect(first.calls.docs).toEqual([[`consents/${con(1)}`], [`consents/${con(2)}`]]);
    const cursor = first.calls.saved.at(-1)!.consentCursor;
    expect(cursor?.id).toBe(con(2));

    const second = world({ consents, state: { consentCursor: cursor, storageCursor: null } });
    await runRetention(second.deps, NOW, { batchSize: 2, maxBatches: 1 });
    expect(second.calls.docs).toEqual([[`consents/${con(3)}`]]);
  });
});

describe("C8 orphan Storage objects", () => {
  const f = (n: number, rest: string, hours: number): StoredFile => ({ name: `submissions/${id(n)}/${rest}`, createdMs: NOW - hours * HOUR });

  it("removes old objects whose submission doc is missing; keeps live, new and unrecognised ones", async () => {
    const { deps, calls } = world({
      submissions: [id(2)],
      objects: [
        f(1, "derived/public.jpg", 30),
        f(1, "original/stripped.jpg", 30),
        f(2, "derived/public.jpg", 30), // submission exists
        f(3, "original/upload", 2), // too new
        { name: "submissions/sub_bad/derived/public.jpg", createdMs: NOW - 30 * HOUR },
      ],
    });
    const res = await runRetention(deps, NOW);
    expect(res.orphanObjectsDeleted).toBe(2);
    expect(calls.objectsDeleted).toEqual([`submissions/${id(1)}/derived/public.jpg`, `submissions/${id(1)}/original/stripped.jpg`]);
    expect(calls.saved.at(-1)?.storageCursor).toBeNull();
  });

  it("walks the bucket a page at a time and remembers where it stopped", async () => {
    const objects = [1, 2, 3, 4, 5, 6, 7].map((n) => f(n, "derived/public.jpg", 30));
    const first = world({ objects });
    await runRetention(first.deps, NOW, { batchSize: 2, maxBatches: 2 });
    expect(first.calls.objectsDeleted).toEqual(objects.slice(0, 4).map((o) => o.name));
    const cursor = first.calls.saved.at(-1)!.storageCursor;
    expect(cursor).toBe(objects[3].name);

    const second = world({ objects, state: { consentCursor: null, storageCursor: cursor } });
    await runRetention(second.deps, NOW, { batchSize: 2, maxBatches: 3 });
    expect(second.calls.objectsDeleted).toEqual(objects.slice(4).map((o) => o.name));
    expect(second.calls.saved.at(-1)?.storageCursor).toBeNull(); // end reached: wrap around next time
  });

  it("makes progress even one object at a time", async () => {
    const objects = [1, 2, 3].map((n) => f(n, "derived/public.jpg", 30));
    const { deps, calls } = world({ objects });
    await runRetention(deps, NOW, { batchSize: 1, maxBatches: 5 });
    expect(calls.objectsDeleted).toEqual(objects.map((o) => o.name));
  });

  it("an old upload a processed submission no longer needs is removed; a legacy (unstripped) row keeps its upload", async () => {
    const { deps, calls } = world({
      stripped: [id(1)],
      submissions: [id(2)],
      objects: [
        f(1, "original/upload", 30), // processed row: leftover upload
        f(1, "derived/public.jpg", 30), // processed row: kept
        f(1, "original/stripped.jpg", 30), // processed row: kept
        f(2, "original/upload", 30), // legacy row (never stripped): kept for reprocessing
      ],
    });
    const res = await runRetention(deps, NOW);
    expect(calls.objectsDeleted).toEqual([`submissions/${id(1)}/original/upload`]);
    expect(res.leftoverUploadsDeleted).toBe(1);
    expect(res.orphanObjectsDeleted).toBe(0);
    expect(calls.records[0]).toMatch(/leftover upload/);
  });

  it("a reprocessed legacy piece (public-v2.jpg) loses its old browser-made derived/public.jpg; other pieces keep theirs", async () => {
    const { deps, calls } = world({
      v2: [id(1)],
      stripped: [id(2)],
      objects: [
        f(1, "derived/public.jpg", 30), // legacy piece now on public-v2.jpg: leftover
        f(1, "derived/public-v2.jpg", 30), // what it uses now: kept
        f(2, "derived/public.jpg", 30), // a piece from the current flow: kept
      ],
    });
    const res = await runRetention(deps, NOW);
    expect(calls.objectsDeleted).toEqual([`submissions/${id(1)}/derived/public.jpg`]);
    expect(res.leftoverUploadsDeleted).toBe(1);
  });

  it("round 5: a reprocessed legacy piece that needs a staff look keeps its old derived/public.jpg (its upload still goes)", async () => {
    const { deps, calls } = world({
      v2: [id(1), id(2)],
      staffLook: [id(1)],
      objects: [
        f(1, "derived/public.jpg", 30), // needsStaffLook: kept for the person who looks
        f(1, "original/upload", 30), // the unstripped upload of a processed row: still a leftover
        f(2, "derived/public.jpg", 30), // no look needed: leftover
      ],
    });
    await runRetention(deps, NOW);
    expect(calls.objectsDeleted.sort()).toEqual([`submissions/${id(1)}/original/upload`, `submissions/${id(2)}/derived/public.jpg`].sort());
  });

  it("an object that cannot be deleted is logged and skipped", async () => {
    const { deps, calls } = world({ objects: [f(1, "derived/public.jpg", 30), f(2, "derived/public.jpg", 30)] });
    deps.deleteObject = async (name) => {
      if (name.includes(id(1))) throw new Error("403");
      calls.objectsDeleted.push(name);
    };
    const res = await runRetention(deps, NOW);
    expect(res.failures).toBe(1);
    expect(calls.objectsDeleted).toEqual([`submissions/${id(2)}/derived/public.jpg`]);
    expect(calls.warnings[0].fields.id).toBe(id(1));
  });
});

describe("C8 Art Wall files left behind after unpublishing (round 3, D)", () => {
  const HOUR_MS = 60 * 60 * 1000;
  const g = (n: number, generation: string | null, hours: number, rest = "public.jpg"): GalleryFile => ({
    name: `gallery/${id(n)}/${rest}`,
    generation,
    createdMs: NOW - hours * HOUR_MS,
  });
  const gone: GalleryState = { onWall: false, claimUntil: null, recorded: null };

  it("deletes an old gallery file whose publicGallery doc is gone, pinned to the generation the listing returned", async () => {
    const { deps, calls } = world({ gallery: [g(1, "111", 30)], galleryStates: { [id(1)]: gone } });
    const res = await runRetention(deps, NOW);
    expect(calls.galleryDeleted).toEqual([{ name: `gallery/${id(1)}/public.jpg`, generation: "111" }]);
    expect(res.galleryLeftoversDeleted).toBe(1);
    expect(calls.records[0]).toMatch(/Art Wall file/);
  });

  it("keeps a file that is on the wall, under a live publish claim, recorded as live, under an hour old, unlisted or not ours", async () => {
    const { deps, calls } = world({
      gallery: [
        g(1, "1", 30), // on the wall
        g(2, "2", 30), // a live publish claim is on the row: it may be about to commit this copy
        g(3, "3", 30), // the row records this generation as live
        g(4, "4", 0.5), // younger than an hour
        g(5, null, 30), // the listing gave no generation
        g(6, "6", 30, "original.jpg"), // not an Art Wall image
        { name: "gallery/not-a-submission/public.jpg", generation: "7", createdMs: NOW - 30 * HOUR_MS },
        g(8, "8", 30), // the database gave no answer for it
      ],
      galleryStates: {
        [id(1)]: { onWall: true, claimUntil: null, recorded: "1" },
        [id(2)]: { onWall: false, claimUntil: NOW + 60_000, recorded: null },
        [id(3)]: { onWall: false, claimUntil: null, recorded: "3" },
        [id(4)]: gone,
        [id(5)]: gone,
        [id(6)]: gone,
      },
    });
    const answered = deps.galleryState;
    deps.galleryState = async (ids) => {
      const states = await answered(ids);
      states.delete(id(8));
      return states;
    };
    const res = await runRetention(deps, NOW);
    expect(calls.galleryDeleted).toEqual([]);
    expect(res.galleryLeftoversDeleted).toBe(0);
  });

  it("keeps the file of a piece published before galleryGeneration was recorded (on the wall, nothing recorded)", async () => {
    const { deps, calls } = world({ gallery: [g(9, "9", 30)], galleryStates: { [id(9)]: { onWall: true, claimUntil: null, recorded: null } } });
    const res = await runRetention(deps, NOW);
    expect(calls.galleryDeleted).toEqual([]);
    expect(res.galleryLeftoversDeleted).toBe(0);
  });

  it("walks the gallery a page at a time and remembers where it stopped", async () => {
    const gallery = [1, 2, 3, 4, 5].map((n) => g(n, String(n), 30));
    const first = world({ gallery });
    await runRetention(first.deps, NOW, { batchSize: 2, maxBatches: 2 });
    expect(first.calls.galleryDeleted.map((d) => d.name)).toEqual(gallery.slice(0, 4).map((o) => o.name));
    const cursor = first.calls.saved.at(-1)!.galleryCursor;
    expect(cursor).toBe(gallery[3].name);

    const second = world({ gallery, state: { consentCursor: null, storageCursor: null, galleryCursor: cursor } });
    await runRetention(second.deps, NOW, { batchSize: 2, maxBatches: 3 });
    expect(second.calls.galleryDeleted.map((d) => d.name)).toEqual([gallery[4].name]);
    expect(second.calls.saved.at(-1)?.galleryCursor).toBeNull();
  });

  it("a gallery file that cannot be deleted is logged and skipped", async () => {
    const { deps, calls } = world({ gallery: [g(1, "1", 30), g(2, "2", 30)] });
    deps.deleteObjectGeneration = async (name, generation) => {
      if (name.includes(id(1))) throw new Error("503");
      calls.galleryDeleted.push({ name, generation });
    };
    const res = await runRetention(deps, NOW);
    expect(res.failures).toBe(1);
    expect(res.galleryLeftoversDeleted).toBe(1);
    expect(calls.warnings[0].fields.id).toBe(id(1));
  });

  it("index.ts lists with generations, reads the submission rows before the publicGallery docs, and deletes by generation", () => {
    const src = readFileSync("functions/src/index.ts", "utf8");
    const state = src.slice(src.indexOf("galleryState:"), src.indexOf("deleteObjectGeneration:"));
    expect(state.indexOf("submissions/${id}")).toBeGreaterThan(-1);
    expect(state.indexOf("submissions/${id}")).toBeLessThan(state.indexOf("publicGallery/${id}"));
    expect(src).toMatch(/deleteObjectGeneration: \(name, generation\) => storage\.removeObject\(name, generation\)/);
    expect(src).toMatch(/prefix: "gallery\/"/);
    expect(src).toMatch(/releaseExpiredClaim: \(id, nowMs\) => releaseExpiredPublishClaim\(db, ops, id, nowMs\)/);
    expect(src).toMatch(/revokeGalleryTokens: \(name, generation\) => storage\.revokeTokens\(name, generation\)/);
    expect(src).toMatch(/claimUntil: claim === undefined \|\| claim === null \? null : \(readPublishClaim\(claim\)\?\.until \?\? 0\)/);
  });

  it("revokes a leftover's download tokens before deleting it, both pinned to the listed generation", async () => {
    const { deps } = world({ gallery: [g(1, "111", 30)], galleryStates: { [id(1)]: gone } });
    const order: string[] = [];
    deps.revokeGalleryTokens = async (name, generation) => {
      order.push(`revoke ${name} ${generation}`);
    };
    deps.deleteObjectGeneration = async (name, generation) => {
      order.push(`delete ${name} ${generation}`);
    };
    await runRetention(deps, NOW);
    expect(order).toEqual([`revoke gallery/${id(1)}/public.jpg 111`, `delete gallery/${id(1)}/public.jpg 111`]);
  });

  it("a revoke that fails is logged, and the delete still goes ahead", async () => {
    const { deps, calls } = world({ gallery: [g(1, "1", 30)], galleryStates: { [id(1)]: gone } });
    deps.revokeGalleryTokens = async () => {
      throw new Error("503");
    };
    const res = await runRetention(deps, NOW);
    expect(res.galleryLeftoversDeleted).toBe(1);
    expect(calls.galleryDeleted).toHaveLength(1);
    expect(calls.warnings[0].message).toMatch(/revoke/);
  });

  it("an expired claim is released first and the state read again, then the leftover goes; a live claim keeps its file", async () => {
    const { deps, calls } = world({
      gallery: [g(1, "1", 30), g(2, "2", 30)],
      galleryStates: {
        [id(1)]: { onWall: false, claimUntil: NOW - 1, recorded: null },
        [id(2)]: { onWall: false, claimUntil: NOW + 60_000, recorded: null },
      },
    });
    const res = await runRetention(deps, NOW);
    expect(calls.released).toEqual([id(1)]);
    expect(calls.galleryDeleted.map((d) => d.name)).toEqual([`gallery/${id(1)}/public.jpg`]);
    expect(res.galleryLeftoversDeleted).toBe(1);
  });

  it("if the release finds a live claim after all (a new publisher), or fails, the file stays", async () => {
    const found = world({ gallery: [g(1, "1", 30)], galleryStates: { [id(1)]: { onWall: false, claimUntil: NOW - 1, recorded: null } } });
    found.deps.releaseExpiredClaim = async () => false;
    expect((await runRetention(found.deps, NOW)).galleryLeftoversDeleted).toBe(0);

    const failing = world({ gallery: [g(1, "1", 30)], galleryStates: { [id(1)]: { onWall: false, claimUntil: NOW - 1, recorded: null } } });
    failing.deps.releaseExpiredClaim = async () => {
      throw new Error("ABORTED");
    };
    const res = await runRetention(failing.deps, NOW);
    expect(res.galleryLeftoversDeleted).toBe(0);
    expect(res.failures).toBe(1);
    expect(failing.calls.warnings[0].message).toMatch(/expired publish claim/);
  });

  /** Retention's gallery sweep over the in-memory Firestore and bucket the moderation tests use. */
  function sweepOver(db: FakeDb, bucket: FakeBucket): RetentionDeps {
    const { deps } = world();
    deps.listGalleryObjects = async (limit, startAt) =>
      [...bucket.objects.entries()]
        .filter(([name]) => name.startsWith("gallery/") && (!startAt || name >= startAt))
        .sort(([a], [b]) => a.localeCompare(b))
        .slice(0, limit)
        .map(([name, o]) => ({ name, generation: o.generation, createdMs: NOW - 2 * HOUR_MS }));
    deps.galleryState = async (ids) =>
      new Map(
        ids.map((sid) => {
          const row = db.data(`submissions/${sid}`); // the row first...
          const onWall = db.data(`publicGallery/${sid}`) !== undefined; // ...then the public doc
          const recorded = row?.galleryGeneration;
          const claim = row?.publishClaim;
          const claimUntil = claim === undefined || claim === null ? null : (readPublishClaim(claim)?.until ?? 0);
          return [sid, { onWall, claimUntil, recorded: typeof recorded === "string" ? recorded : null }];
        }),
      );
    deps.releaseExpiredClaim = (sid, nowMs) => releaseExpiredPublishClaim(db, fakeOps, sid, nowMs);
    deps.revokeGalleryTokens = (name, generation) => bucket.revokeTokens(name, generation);
    deps.deleteObjectGeneration = (name, generation) => bucket.remove(name, generation);
    return deps;
  }

  /** A publisher whose copy landed and which then never comes back (killed, timed out): its claim stays on the row. */
  async function strandedClaim() {
    const setup = await reviewable();
    let landed!: () => void;
    const copied = new Promise<void>((r) => (landed = r));
    setup.bucket.afterCopy = () => {
      landed();
      return new Promise<void>(() => undefined);
    };
    void moderateSubmission(moderateDeps(setup.db, setup.bucket), ADMIN, {
      id: setup.id,
      status: "approved",
      derivedGeneration: setup.generation,
    }).catch(() => undefined);
    await copied;
    setup.bucket.afterCopy = null;
    expect(setup.db.data(`submissions/${setup.id}`)?.publishClaim).toBeTruthy();
    expect(setup.bucket.has(paths.gallery(setup.id))).toBe(true);
    return setup;
  }

  it("round 4, B: a stranded (expired) claim no longer keeps its leftover: retention releases it, then removes the file", async () => {
    const { db, bucket, id: sid, generation } = await strandedClaim();
    const later = NOW + 24 * HOUR_MS;
    const res = await runRetention(sweepOver(db, bucket), later);
    expect(res.galleryLeftoversDeleted).toBe(1);
    expect(bucket.has(paths.gallery(sid))).toBe(false);
    expect(db.data(`submissions/${sid}`)).not.toHaveProperty("publishClaim");
    expect(db.data(`submissions/${sid}`)?.status).toBe("submitted");
    // The piece can still be published normally afterwards.
    await moderateSubmission(moderateDeps(db, bucket, { now: () => later }), ADMIN, { id: sid, status: "approved", derivedGeneration: generation });
    expect(db.data(`publicGallery/${sid}`)?.imageUrl).toBe(bucket.liveUrl(paths.gallery(sid)));
  });

  it("round 4, B: staff reject releases a stranded claim, and the next retention run removes the leftover", async () => {
    const { db, bucket, id: sid } = await strandedClaim();
    const later = NOW + PUBLISH_CLAIM_MS + 1;
    await moderateSubmission(moderateDeps(db, bucket, { now: () => later }), ADMIN, { id: sid, status: "rejected" });
    expect(db.data(`submissions/${sid}`)).not.toHaveProperty("publishClaim");
    expect(db.data(`submissions/${sid}`)?.status).toBe("rejected");
    const res = await runRetention(sweepOver(db, bucket), NOW + 2 * HOUR_MS);
    expect(res.galleryLeftoversDeleted).toBe(1);
    expect(bucket.has(paths.gallery(sid))).toBe(false);
  });

  it("round 4, B: while the claim is live, the in-flight copy is left alone", async () => {
    const { db, bucket, id: sid } = await strandedClaim();
    const res = await runRetention(sweepOver(db, bucket), NOW + 60_000);
    expect(res.galleryLeftoversDeleted).toBe(0);
    expect(bucket.has(paths.gallery(sid))).toBe(true);
    expect(db.data(`submissions/${sid}`)?.publishClaim).toBeTruthy();
  });

  it("releaseExpiredPublishClaim removes only a claim past its until (or a malformed one)", async () => {
    const db = new FakeDb();
    db.patch(`submissions/${id(1)}`, { publishClaim: { id: "a", to: "approved", generation: "1", until: NOW - 1 } });
    db.patch(`submissions/${id(2)}`, { publishClaim: { id: "b", to: "approved", generation: "1", until: NOW + 1 } });
    db.patch(`submissions/${id(3)}`, { publishClaim: "garbage" });
    db.patch(`submissions/${id(4)}`, { status: "submitted" });
    expect(await releaseExpiredPublishClaim(db, fakeOps, id(1), NOW)).toBe(true);
    expect(await releaseExpiredPublishClaim(db, fakeOps, id(2), NOW)).toBe(false);
    expect(await releaseExpiredPublishClaim(db, fakeOps, id(3), NOW)).toBe(true);
    expect(await releaseExpiredPublishClaim(db, fakeOps, id(4), NOW)).toBe(true);
    expect(await releaseExpiredPublishClaim(db, fakeOps, id(5), NOW)).toBe(true);
    expect(await releaseExpiredPublishClaim(db, fakeOps, "sub_bad", NOW)).toBe(false);
    expect(db.data(`submissions/${id(1)}`)).not.toHaveProperty("publishClaim");
    expect(db.data(`submissions/${id(2)}`)?.publishClaim).toBeTruthy();
    expect(db.data(`submissions/${id(3)}`)).not.toHaveProperty("publishClaim");
  });
  const ADMIN = { uid: "staff-admin", role: "ADMIN" };

  it("an unpublish whose file removal failed: the daily job removes the file, and pressing the button again still works", async () => {
    const { db, bucket, id: sid, generation } = await reviewable();
    await moderateSubmission(moderateDeps(db, bucket), ADMIN, { id: sid, status: "approved", derivedGeneration: generation });
    const failingRemove = moderateDeps(db, bucket, {
      remove: async () => {
        throw new Error("503 from Cloud Storage");
      },
    });
    await expectCode(moderateSubmission(failingRemove, ADMIN, { id: sid, status: "rejected" }), "aborted");
    expect(db.data(`publicGallery/${sid}`)).toBeUndefined();
    expect(bucket.has(paths.gallery(sid))).toBe(true);

    const res = await runRetention(sweepOver(db, bucket), NOW);
    expect(res.galleryLeftoversDeleted).toBe(1);
    expect(bucket.has(paths.gallery(sid))).toBe(false);

    await moderateSubmission(moderateDeps(db, bucket), ADMIN, { id: sid, status: "rejected" });
    expect(db.data(`submissions/${sid}`)).not.toHaveProperty("galleryOrphan");
  });

  it("a publish in flight (copied, not yet committed) is left alone, and its commit points at a live image", async () => {
    const { db, bucket, id: sid, generation } = await reviewable();
    const deps = sweepOver(db, bucket);
    let during: RetentionResult | null = null;
    bucket.afterCopy = async () => {
      bucket.afterCopy = null;
      during = await runRetention(deps, NOW);
    };
    await moderateSubmission(moderateDeps(db, bucket), ADMIN, { id: sid, status: "approved", derivedGeneration: generation });
    expect(during!.galleryLeftoversDeleted).toBe(0);
    expect(db.data(`publicGallery/${sid}`)?.imageUrl).toBe(bucket.liveUrl(paths.gallery(sid)));
    // Once committed, later sweeps keep it too.
    expect((await runRetention(deps, NOW)).galleryLeftoversDeleted).toBe(0);
    expect(bucket.has(paths.gallery(sid))).toBe(true);
  });
});
