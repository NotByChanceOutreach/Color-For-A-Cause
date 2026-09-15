/**
 * Fakes for the Cloud Functions logic: an in-memory Firestore that enforces the transaction rules the
 * code relies on (reads before writes, atomic commit, FieldValue sentinels, and optimistic concurrency:
 * a transaction whose reads changed before it commits is re-run, as Firestore does) and an in-memory
 * bucket with object generations.
 */
import { createHash } from "node:crypto";
import { expect } from "vitest";
import { paths, tokenlessMediaUrl } from "../../functions/src/constants";
import { finalizeSubmission } from "../../functions/src/finalize";
import type { ProcessedImage } from "../../functions/src/image";
import { DestinationExists, GenerationMismatch, type ModerateDeps } from "../../functions/src/moderate";
import type { Data, Db, DocRef, Ops, Snap, Tx } from "../../functions/src/store";
import { startSubmission, type SubmitDeps } from "../../functions/src/submit";
import type { SignedUploadConfig } from "../../functions/src/upload";
import {
  ObjectExists,
  ObjectGone,
  handleOriginalUpload,
  type UploadDeps,
  type UploadEvent,
} from "../../functions/src/uploadTrigger";

export const NOW = Date.UTC(2026, 8, 15, 12, 0, 0);
export const SERVER_TS = "__server_ts__";
export const CTX = { userAgent: "vitest" };
export const KNOWN_GROUP = "abcdef012345";

type Sentinel = { __op: "inc"; n: number } | { __op: "ts" } | { __op: "del" };

function isSentinel(v: unknown): v is Sentinel {
  return typeof v === "object" && v !== null && "__op" in v;
}

export const fakeOps: Ops = {
  increment: (n) => ({ __op: "inc", n }),
  serverTimestamp: () => ({ __op: "ts" }),
  deleteField: () => ({ __op: "del" }),
};

function write(m: Map<string, Data>, path: string, data: Data, merge: boolean) {
  const next: Data = merge ? { ...(m.get(path) ?? {}) } : {};
  for (const [key, value] of Object.entries(data)) {
    if (isSentinel(value)) {
      if (value.__op === "del") delete next[key];
      else if (value.__op === "ts") next[key] = SERVER_TS;
      else next[key] = (typeof next[key] === "number" ? (next[key] as number) : 0) + value.n;
    } else {
      next[key] = structuredClone(value);
    }
  }
  m.set(path, next);
}

type Write = { path: string; apply: (m: Map<string, Data>) => void };

export class FakeDb implements Db {
  docs = new Map<string, Data>();
  /** Bumped on every committed write, like Firestore's update time. */
  versions = new Map<string, number>();
  transactions = 0;
  /** Transactions re-run because a document they read changed before they committed. */
  conflicts = 0;
  private seq = 0;

  doc(path: string): DocRef {
    return { path };
  }

  newDoc(collection: string): DocRef {
    this.seq += 1;
    return { path: `${collection}/auto${String(this.seq).padStart(5, "0")}` };
  }

  async get(ref: DocRef): Promise<Snap> {
    return this.snap(ref.path);
  }

  data(path: string): Data | undefined {
    const d = this.docs.get(path);
    return d ? structuredClone(d) : undefined;
  }

  /** A write from outside any transaction (another process, a console edit). */
  patch(path: string, fields: Data) {
    this.docs.set(path, { ...(this.docs.get(path) ?? {}), ...fields });
    this.bump(path);
  }

  collection(name: string): Data[] {
    return [...this.docs.entries()]
      .filter(([p]) => p.startsWith(`${name}/`) && p.split("/").length === 2)
      .map(([, d]) => d);
  }

  snapshot(): string {
    return JSON.stringify([...this.docs.entries()].sort(([a], [b]) => a.localeCompare(b)));
  }

  private bump(path: string) {
    this.versions.set(path, (this.versions.get(path) ?? 0) + 1);
  }

  private snap(path: string): Snap {
    const copy = this.data(path);
    return { exists: copy !== undefined, data: () => copy };
  }

  async runTransaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    for (let attempt = 0; attempt < 5; attempt++) {
      this.transactions += 1;
      const reads = new Map<string, number>();
      const writes: Write[] = [];
      const queue = (path: string, apply: Write["apply"]) => {
        writes.push({ path, apply });
      };
      const tx: Tx = {
        get: async (ref) => {
          if (writes.length) throw new Error("Firestore transactions require all reads to be executed before all writes.");
          if (!reads.has(ref.path)) reads.set(ref.path, this.versions.get(ref.path) ?? 0);
          return this.snap(ref.path);
        },
        set: (ref, data, options) => queue(ref.path, (m) => write(m, ref.path, data, options?.merge === true)),
        update: (ref, data) =>
          queue(ref.path, (m) => {
            if (!m.has(ref.path)) throw new Error(`NOT_FOUND ${ref.path}`);
            write(m, ref.path, data, true);
          }),
        create: (ref, data) =>
          queue(ref.path, (m) => {
            if (m.has(ref.path)) throw new Error(`ALREADY_EXISTS ${ref.path}`);
            write(m, ref.path, data, false);
          }),
        delete: (ref) =>
          queue(ref.path, (m) => {
            m.delete(ref.path);
          }),
      };
      const result = await fn(tx);
      if ([...reads].some(([p, v]) => (this.versions.get(p) ?? 0) !== v)) {
        this.conflicts += 1;
        continue;
      }
      const staged = new Map(this.docs);
      for (const w of writes) w.apply(staged);
      this.docs = staged;
      for (const w of writes) this.bump(w.path);
      return result;
    }
    throw new Error("ABORTED: too much contention on these documents.");
  }
}

/** Make the Nth runTransaction call (1-based, counted from now) throw before it runs, once each. */
export function failTransactions(db: FakeDb, calls: number[], message = "UNAVAILABLE: the database hiccuped") {
  const original = db.runTransaction.bind(db);
  let n = 0;
  db.runTransaction = (async (fn: (tx: Tx) => Promise<unknown>) => {
    n += 1;
    if (calls.includes(n)) throw new Error(message);
    return original(fn);
  }) as FakeDb["runTransaction"];
}

/**
 * The Nth runTransaction call (1-based, counted from now) commits, "loses" the commit answer, and runs the same
 * function again, as the Admin SDK does after a retryable commit error (DEADLINE_EXCEEDED, UNAVAILABLE...).
 */
export function loseCommitAnswer(db: FakeDb, call: number) {
  const original = db.runTransaction.bind(db);
  let n = 0;
  db.runTransaction = (async (fn: (tx: Tx) => Promise<unknown>) => {
    n += 1;
    if (n === call) await original(fn);
    return original(fn);
  }) as FakeDb["runTransaction"];
}

/** Run `hook` (another writer) just before the Nth runTransaction call (1-based, counted from now). */
export function beforeTransaction(db: FakeDb, call: number, hook: () => Promise<void>) {
  const original = db.runTransaction.bind(db);
  let n = 0;
  let fired = false;
  db.runTransaction = (async (fn: (tx: Tx) => Promise<unknown>) => {
    n += 1;
    if (n === call && !fired) {
      fired = true;
      await hook();
    }
    return original(fn);
  }) as FakeDb["runTransaction"];
}

type StoredBlob = { data: Buffer; generation: string; md5: string; token?: string };

/** The bucket name the fakes use in URLs. */
export const TEST_BUCKET = "test";

export class FakeBucket {
  objects = new Map<string, StoredBlob>();
  copies = 0;
  /** Every Storage call that revokes or deletes, in order ("revoke:<path>@<gen>", "remove:<path>@<gen>"). */
  log: string[] = [];
  /** Test hooks around the publish copy (to interleave concurrent publishers). */
  beforeCopy: (() => Promise<void>) | null = null;
  afterCopy: (() => Promise<void>) | null = null;
  private generation = 1_700_000_000_000_000;
  private minted = 0;

  put(path: string, data: Buffer) {
    this.generation += 1;
    const obj = { data, generation: String(this.generation), md5: createHash("md5").update(data).digest("base64") };
    this.objects.set(path, obj);
    return { generation: obj.generation, md5: obj.md5 };
  }

  has(path: string) {
    return this.objects.has(path);
  }

  /** Create-only write (ifGenerationMatch=0), like index.ts's saveJpeg. */
  create = async (path: string, data: Buffer) => {
    if (this.objects.has(path)) throw new ObjectExists(path);
    return this.put(path, data);
  };

  generationOf = async (path: string) => this.objects.get(path)?.generation ?? null;

  remove = async (path: string, generation?: string) => {
    this.log.push(`remove:${path}@${generation ?? "*"}`);
    const o = this.objects.get(path);
    if (o && (!generation || o.generation === generation)) this.objects.delete(path);
  };

  /** Like gcs.ts revokeTokens: only that generation, a missing object is not an error. */
  revokeTokens = async (path: string, generation: string) => {
    this.log.push(`revoke:${path}@${generation}`);
    const o = this.objects.get(path);
    if (o && o.generation === generation) delete o.token;
  };

  /** A reader the rules let through asks Firebase for a download URL: Firebase mints a token on the object. */
  mintToken(path: string): string {
    const o = this.objects.get(path);
    if (!o) throw new Error(`no object at ${path}`);
    this.minted += 1;
    o.token = `minted-${this.minted}`;
    return o.token;
  }

  /** The download token on the live object at `path`, if any. */
  tokenOf(path: string): string | undefined {
    return this.objects.get(path)?.token;
  }

  /** Pinned read; a generation that is not live any more is a 404 (ObjectGone). */
  download = async (path: string, generation: string) => {
    const o = this.objects.get(path);
    if (!o || o.generation !== generation) throw new ObjectGone(path);
    return o.data;
  };

  /**
   * Source pinned to `generation`, destination create-only, and NO download token (a token on the source is never
   * copied), like gcs.ts. Returns the tokenless URL.
   */
  publishCopy = async (src: string, generation: string, dest: string) => {
    if (this.beforeCopy) await this.beforeCopy();
    const o = this.objects.get(src);
    if (!o || o.generation !== generation) throw new GenerationMismatch();
    if (this.objects.has(dest)) throw new DestinationExists();
    this.copies += 1;
    const created = this.put(dest, o.data);
    if (this.afterCopy) await this.afterCopy();
    return { generation: created.generation, url: tokenlessMediaUrl(TEST_BUCKET, dest) };
  };

  /** The tokenless URL of the object that is live at `path` right now (the rules decide who reads it), or null. */
  liveUrl(path: string): string | null {
    return this.objects.has(path) ? tokenlessMediaUrl(TEST_BUCKET, path) : null;
  }
}

export function validSubmit(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    pageId: "E01",
    submitterRole: "self",
    attributionKind: "nickname",
    attributionText: "Sky",
    ageRange: "18_plus",
    organizationName: null,
    showOrganization: false,
    message: "Stay warm.",
    email: null,
    groupId: null,
    permissions: {
      store: true,
      displayPublic: true,
      social: false,
      reproduce: false,
      promotional: false,
      collectible: false,
      sellCollectible: false,
      showAttribution: true,
      showMessage: true,
    },
    originalMime: "image/jpeg",
    originalBytes: 123_456,
    ...overrides,
  };
}

export function startDeps(db: FakeDb = new FakeDb(), extra: Partial<SubmitDeps> = {}) {
  const signed: Array<{ path: string; config: SignedUploadConfig }> = [];
  const buckets: Array<string | null> = [];
  let n = 0;
  const deps: SubmitDeps = {
    db,
    ops: fakeOps,
    now: () => NOW,
    rateLimit: async (group) => {
      buckets.push(group);
    },
    groupExists: async (publicId) => publicId === KNOWN_GROUP,
    nextArtNumber: async () => `NBC-ART-${String(++n).padStart(6, "0")}`,
    signUpload: async (path, config) => {
      signed.push({ path, config });
      return `https://storage.googleapis.com/test-bucket/${path}?X-Goog-Signature=test`;
    },
    ...extra,
  };
  return { deps, db, signed, buckets };
}

/** Twelve-plus bytes that sniff as a JPEG. */
export const JPEG_BYTES = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0]);

export const fakeProcess = async (): Promise<ProcessedImage> => ({
  stripped: { data: Buffer.from("stripped-jpeg"), width: 40, height: 30 },
  derived: { data: Buffer.from("public-jpeg"), width: 20, height: 15 },
});

export function triggerDeps(db: FakeDb, bucket: FakeBucket, overrides: Partial<UploadDeps> = {}): UploadDeps {
  return {
    db,
    ops: fakeOps,
    now: () => NOW,
    leaseOwner: "invocation-1",
    download: bucket.download,
    save: bucket.create,
    generationOf: bucket.generationOf,
    remove: bucket.remove,
    process: fakeProcess,
    ...overrides,
  };
}

export function uploadEvent(bucket: FakeBucket, id: string, data: Buffer = JPEG_BYTES, contentType = "image/jpeg"): UploadEvent {
  const path = paths.upload(id);
  const { generation } = bucket.put(path, data);
  return { name: path, generation, size: data.length, contentType };
}

/** A submission that went through the whole public flow and waits for a reviewer. */
export async function reviewable(
  opts: { db?: FakeDb; bucket?: FakeBucket; submit?: Record<string, unknown> } = {},
) {
  const db = opts.db ?? new FakeDb();
  const bucket = opts.bucket ?? new FakeBucket();
  const { deps } = startDeps(db);
  const res = await startSubmission(deps, validSubmit(opts.submit), CTX);
  await handleOriginalUpload(uploadEvent(bucket, res.id), triggerDeps(db, bucket));
  await finalizeSubmission(db, fakeOps, { id: res.id, finalizeToken: res.finalizeToken });
  const generation = String(db.data(`submissions/${res.id}`)?.derivedGeneration);
  return { db, bucket, id: res.id, generation };
}

export function moderateDeps(db: FakeDb, bucket: FakeBucket, overrides: Partial<ModerateDeps> = {}): ModerateDeps {
  return {
    db,
    ops: fakeOps,
    now: () => NOW,
    publishCopy: bucket.publishCopy,
    generationOf: bucket.generationOf,
    remove: bucket.remove,
    revokeTokens: bucket.revokeTokens,
    ...overrides,
  };
}

export async function expectCode(work: Promise<unknown>, code: string): Promise<Error> {
  try {
    await work;
  } catch (err) {
    expect((err as { code?: unknown }).code).toBe(code);
    return err as Error;
  }
  throw new Error(`expected an error with code ${code}, but the call succeeded`);
}

export function expectSyncCode(fn: () => unknown, code: string): Error {
  try {
    fn();
  } catch (err) {
    expect((err as { code?: unknown }).code).toBe(code);
    return err as Error;
  }
  throw new Error(`expected an error with code ${code}, but the call succeeded`);
}
