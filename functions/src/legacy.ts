/**
 * One-off reprocessing of submissions sent before the server privacy check (the two-upload flow of 9b2fc57).
 * Run by scripts/reprocess-legacy.mjs after `npm --prefix functions run build`; see README.md.
 *
 * The old flow let the artist turn and crop the picture, but applied that ONLY inside the browser-made
 * derived/public.jpg; the row never recorded it. Therefore:
 *   - the PUBLIC image is made from that browser-made derived/public.jpg (it holds the artist's framing, and the
 *     browser re-encoded it), put through sharp with no turn and no crop so every metadata block is dropped;
 *   - original/stripped.jpg is made from the original upload (EXIF/GPS and every other metadata block removed);
 *   - if the old derivative is missing or unreadable, the public image is made from the original with no turn and no
 *     crop, and the row is flagged for a person (needsStaffLook: 'legacy-framing-unknown', also added to flags).
 *     "Unreadable" is only a known decode failure (transient.ts isUnreadableImage); any other sharp error stops that
 *     piece with an error (nothing is changed), and a later run tries again.
 *
 * A candidate is a row in 'submitted', 'hold' or 'needs_changes' with stripped !== true. For each one:
 *   1. the generations of the upload and of the old derived/public.jpg are read. A dry run stops here and reports
 *      the plan (ids and plan words only);
 *   2. a transaction takes the upload trigger's processing lease (a token unique to this run);
 *   3. both images are made from those exact generations and written CREATE-ONLY to original/stripped.jpg and to a
 *      NEW path, derived/public-v2.jpg. The old derived/public.jpg is not touched: until the commit it is what the
 *      row points at, so a run that stops half way (or a row that moves on) never leaves the row without its image;
 *   4. one transaction, only while the lease token is ours, records the new images (derivedPath = public-v2.jpg),
 *      the generic originalName, today's minor protections on the row's permissions, organization line and email
 *      (minors.ts protectStoredRow), decided from the row AND its own consent record (a permission stays on only
 *      where row AND record say yes; the row is locked when the record says the artist is a possible minor or names
 *      another role; no email unless the record holds one), the same narrowing on that record (record AND row; never
 *      widened; the permissions as first given are kept in permissionsAsSubmitted), and legacyLeftovers: the upload's
 *      generation, and the old derivative's only when it was used for the public image (framing known);
 *   5. only after that commit are those generations deleted, then legacyLeftovers is cleared. If a delete fails
 *      the row keeps legacyLeftovers and a later run finishes the cleanup (retention also removes both files: the
 *      upload of a processed row, and derived/public.jpg of a row that uses public-v2.jpg and needs no staff look).
 *
 * The row's own consent record is the one row.consentId names, but only when that record's submissionId names this
 * submission back; otherwise every record whose submissionId is this submission (a query). If there is none (missing,
 * deleted, a malformed consentId, or one pointing at another submission's record) the reprocess FAILS CLOSED: the row
 * is locked private (only `store` kept, every public choice off, no organization line, no email), flagged
 * needsStaffLook: 'legacy-consent-missing', and reported as 'reprocessed-locked-no-consent' (the dry run prints
 * "consent=missing will-lock").
 */
import { CONSENT_ID_RE, GENERATION_RE, MAX_UPLOAD_BYTES, PERMISSION_KEYS, SUBMISSION_ID_RE, paths } from "./constants";
import type { ImageOut, ProcessedImage, ProcessOptions } from "./image";
import { protectStoredRow, type StoredRowProtection } from "./minors";
import { audit, type Data, type Db, type DocRef, type Ops } from "./store";
import { isUnreadableImage } from "./transient";
import { genericOriginalName, isUploadType, sniffImage } from "./upload";
import { LEASE_MS, LostLease, ObjectGone, readLease, saveCreateOnly, type ObjectStore, type StoredObject } from "./uploadTrigger";

export const LEGACY_STATUSES = ["submitted", "hold", "needs_changes"] as const;
/** needsStaffLook (and a flag): the public image was made from the original, so the artist's turn and crop are unknown. */
export const FRAMING_UNKNOWN = "legacy-framing-unknown";
/** needsStaffLook (and a flag): no consent record names this submission, so the row was locked private. */
export const CONSENT_MISSING = "legacy-consent-missing";

const NO_TURN: ProcessOptions = { rotate: 0, cropPct: 0 };

export type LegacyOutcome =
  | "not-found"
  | "not-legacy"
  | "no-original"
  | "would-reprocess"
  | "would-clean-up"
  | "busy"
  | "too-large"
  | "not-an-image"
  | "unreadable"
  | "changed"
  | "reprocessed"
  | "reprocessed-cleanup-pending"
  /** Reprocessed, but no consent record names this submission: the row was locked private for a person to look at. */
  | "reprocessed-locked-no-consent"
  | "cleaned-up"
  | "cleanup-pending";

/** What happened (or would), plus plan words such as "public-from=old-derivative". Never personal data. */
export type LegacyResult = { outcome: LegacyOutcome; notes: string[] };

/** The exact generations a committed reprocess left to delete. */
export type LegacyLeftovers = { derived: string | null; upload: string | null };

export interface LegacyDeps extends ObjectStore {
  db: Db;
  ops: Ops;
  now(): number;
  /** Unique per run of the script: the lease token. */
  runToken: string;
  process(input: Buffer, opts: ProcessOptions): Promise<ProcessedImage>;
  /** Ids of the consent records whose submissionId is this submission (a query on consents). */
  consentIdsFor(submissionId: string): Promise<string[]>;
}

export function isLegacyCandidate(row: Data | undefined): row is Data {
  return !!row && (LEGACY_STATUSES as readonly string[]).includes(String(row.status)) && row.stripped !== true;
}

export function readLeftovers(v: unknown): LegacyLeftovers | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  const generation = (x: unknown) => (typeof x === "string" && GENERATION_RE.test(x) ? x : null);
  const derived = generation(o.derived);
  const upload = generation(o.upload);
  return derived || upload ? { derived, upload } : null;
}

/** A row this script already reprocessed, whose old files were not all deleted yet. */
export function hasLegacyLeftovers(row: Data | undefined): row is Data {
  return !!row && row.stripped === true && readLeftovers(row.legacyLeftovers) !== null;
}

function consentRefOf(db: Db, row: Data): DocRef | null {
  return typeof row.consentId === "string" && CONSENT_ID_RE.test(row.consentId) ? db.doc(`consents/${row.consentId}`) : null;
}

/**
 * The consent record narrowed to the protected row: a permission stays on only where both the record and the
 * protected row say yes, so nothing is ever widened. An email is removed when the row keeps none. The permissions
 * as first given are kept once, in permissionsAsSubmitted. Null when nothing changes.
 */
export function narrowConsent(consent: Data, protection: StoredRowProtection, ops: Ops): Data | null {
  const stored = (consent.permissions ?? {}) as Record<string, unknown>;
  const permissions = Object.fromEntries(PERMISSION_KEYS.map((k) => [k, stored[k] === true && protection.permissions[k] === true]));
  const narrowed = PERMISSION_KEYS.some((k) => (stored[k] === true) !== permissions[k]);
  const dropEmail = typeof consent.email === "string" && consent.email !== "" && protection.email === null;
  const markLocked = protection.minorProtectionsApplied && consent.minorProtectionsApplied !== true;
  if (!narrowed && !dropEmail && !markLocked) return null;
  return {
    permissions,
    ...(dropEmail ? { email: null } : {}),
    ...(markLocked ? { minorProtectionsApplied: true } : {}),
    ...(consent.permissionsAsSubmitted === undefined ? { permissionsAsSubmitted: consent.permissions ?? {} } : {}),
    protectionsAppliedAt: ops.serverTimestamp(),
    protectionsAppliedBy: "legacy-reprocess",
  };
}

/** A consent record that names this submission, with where it lives. */
type OwnConsent = { ref: DocRef; data: Data };

/**
 * Where the row's own consent record(s) may be: the record row.consentId names, when that record names this
 * submission back; otherwise every record whose submissionId is this submission (a query). Empty when there is none.
 * The caller reads them again (in its transaction) and keeps only records that still name this submission.
 */
async function consentRefsFor(deps: LegacyDeps, id: string, row: Data): Promise<DocRef[]> {
  const direct = consentRefOf(deps.db, row);
  if (direct) {
    const record = (await deps.db.get(direct)).data();
    if (record && record.submissionId === id) return [direct];
  }
  const ids = [...new Set(await deps.consentIdsFor(id))].filter((c) => typeof c === "string" && CONSENT_ID_RE.test(c));
  return ids.map((c) => deps.db.doc(`consents/${c}`));
}

/** The records at `refs` that name submission `id`, read with `read` (a transaction's get, or a plain one). */
async function readOwnConsents(refs: DocRef[], id: string, read: (ref: DocRef) => Promise<Data | undefined>): Promise<OwnConsent[]> {
  const own: OwnConsent[] = [];
  for (const ref of refs) {
    const data = await read(ref);
    if (data && data.submissionId === id) own.push({ ref, data });
  }
  return own;
}

function planNotes(row: Data, framingKnown: boolean, consents: readonly Data[], ops: Ops, dryRun: boolean): string[] {
  const protection = protectStoredRow(row, consents);
  const missing = consents.length === 0;
  const consentNote = missing
    ? "consent=missing"
    : consents.some((c) => narrowConsent(c, protection, ops)) ? "consent=narrowed" : "consent=unchanged";
  // The row said more than its consent record: some of its choices go (a permission, the email, or the lock) for
  // that reason alone.
  const rowAlone = protectStoredRow(row);
  const byRecord =
    !missing &&
    (PERMISSION_KEYS.some((k) => protection.permissions[k] !== rowAlone.permissions[k]) ||
      protection.email !== rowAlone.email ||
      protection.minorProtectionsApplied !== rowAlone.minorProtectionsApplied);
  return [
    framingKnown ? "public-from=old-derivative" : "public-from=original",
    ...(framingKnown ? [] : ["framing=unknown"]),
    protection.minorProtectionsApplied ? "protections=locked" : "protections=kept",
    ...(byRecord ? ["row=narrowed-to-consent"] : []),
    consentNote,
    ...(missing && dryRun ? ["will-lock"] : []),
    "original-name=generic",
  ];
}

/** The public image from the browser-made derivative (the artist's framing), or null when it cannot be used. */
async function publicFromOldDerivative(deps: LegacyDeps, id: string, oldGeneration: string | null): Promise<ImageOut | null> {
  if (oldGeneration === null) return null;
  let bytes: Buffer;
  try {
    bytes = await deps.download(paths.derived(id), oldGeneration);
  } catch (err) {
    if (err instanceof ObjectGone) return null;
    throw err;
  }
  if (bytes.length < 1 || bytes.length > MAX_UPLOAD_BYTES || !sniffImage(bytes)) return null;
  try {
    return (await deps.process(bytes, NO_TURN)).derived;
  } catch (err) {
    if (!isUnreadableImage(err)) throw err;
    return null;
  }
}

/**
 * Delete the generations a committed reprocess recorded in legacyLeftovers, then clear the record. The old
 * derivative goes only while the row points at public-v2.jpg. False when something could not be done yet.
 */
async function removeLeftovers(deps: LegacyDeps, id: string): Promise<boolean> {
  const { db, ops } = deps;
  const ref = db.doc(`submissions/${id}`);
  const row = (await db.get(ref)).data();
  if (!hasLegacyLeftovers(row)) return true;
  const leftovers = readLeftovers(row.legacyLeftovers)!;
  if (leftovers.derived && row.derivedPath !== paths.derivedV2(id)) return false; // not ours to judge: a person looks
  try {
    if (leftovers.derived) await deps.remove(paths.derived(id), leftovers.derived);
    if (leftovers.upload) await deps.remove(paths.upload(id), leftovers.upload);
    await db.runTransaction(async (tx) => {
      const cur = (await tx.get(ref)).data();
      const now = cur ? readLeftovers(cur.legacyLeftovers) : null;
      if (now && now.derived === leftovers.derived && now.upload === leftovers.upload) tx.update(ref, { legacyLeftovers: ops.deleteField() });
    });
  } catch {
    return false;
  }
  return true;
}

export async function reprocessLegacySubmission(deps: LegacyDeps, id: string, opts: { write: boolean }): Promise<LegacyResult> {
  const done = (outcome: LegacyOutcome, notes: string[] = []): LegacyResult => ({ outcome, notes });
  if (!SUBMISSION_ID_RE.test(id)) return done("not-found");
  const { db, ops } = deps;
  const ref = db.doc(`submissions/${id}`);
  const uploadPath = paths.upload(id);
  const row = (await db.get(ref)).data();
  if (!row) return done("not-found");
  // The consent record the row names now; the commit starts over if the row names another one by then.
  const rowConsentId = row.consentId;
  if (hasLegacyLeftovers(row)) {
    if (!opts.write) return done("would-clean-up");
    return done((await removeLeftovers(deps, id)) ? "cleaned-up" : "cleanup-pending");
  }
  if (!isLegacyCandidate(row)) return done("not-legacy");
  const uploadGeneration = await deps.generationOf(uploadPath);
  if (uploadGeneration === null) return done("no-original");
  const oldGeneration = await deps.generationOf(paths.derived(id));
  if (!opts.write) {
    const consents = await readOwnConsents(await consentRefsFor(deps, id, row), id, async (r) => (await db.get(r)).data());
    // The same decode check --write makes, so the plan never claims the old derivative when it will not be used.
    const framingKnown = (await publicFromOldDerivative(deps, id, oldGeneration)) !== null;
    return done(
      "would-reprocess",
      planNotes(
        row,
        framingKnown,
        consents.map((c) => c.data),
        ops,
        true,
      ),
    );
  }

  const me = deps.runToken;
  const owns = (cur: Data | undefined): cur is Data => isLegacyCandidate(cur) && readLease(cur.processingLease)?.owner === me;

  const claim = await db.runTransaction<"claimed" | "busy" | "changed">(async (tx) => {
    const cur = (await tx.get(ref)).data();
    if (!isLegacyCandidate(cur)) return "changed";
    const lease = readLease(cur.processingLease);
    if (lease && lease.until > deps.now() && lease.owner !== me) return "busy";
    tx.update(ref, { processingLease: { generation: uploadGeneration, owner: me, until: deps.now() + LEASE_MS } });
    return "claimed";
  });
  if (claim !== "claimed") return done(claim);

  const release = () =>
    db.runTransaction(async (tx) => {
      const cur = (await tx.get(ref)).data();
      if (cur && readLease(cur.processingLease)?.owner === me) tx.update(ref, { processingLease: ops.deleteField() });
    });
  const written: Array<StoredObject & { path: string }> = [];
  const dropWritten = async () => {
    for (const w of written) await deps.remove(w.path, w.generation);
  };

  try {
    let upload: Buffer;
    try {
      upload = await deps.download(uploadPath, uploadGeneration);
    } catch (err) {
      if (!(err instanceof ObjectGone)) throw err;
      await release();
      return done("no-original");
    }
    // Refusals leave everything in place for a person to look at; the lease is released.
    if (upload.length > MAX_UPLOAD_BYTES) {
      await release();
      return done("too-large");
    }
    if (upload.length < 1 || !sniffImage(upload)) {
      await release();
      return done("not-an-image");
    }
    let fromUpload: ProcessedImage;
    try {
      fromUpload = await deps.process(upload, NO_TURN);
    } catch (err) {
      if (!isUnreadableImage(err)) throw err;
      await release();
      return done("unreadable");
    }
    const fromOld = await publicFromOldDerivative(deps, id, oldGeneration);
    const framingKnown = fromOld !== null;
    const publicImage = fromOld ?? fromUpload.derived;

    const confirmLeftover = async (leftover: string) => {
      const cur = (await db.get(ref)).data();
      if (!owns(cur) || cur.derivedGeneration === leftover || cur.strippedGeneration === leftover) throw new LostLease(true);
    };
    let saved: { stripped: StoredObject; derived: StoredObject };
    try {
      const strippedObj = await saveCreateOnly(deps, paths.stripped(id), fromUpload.stripped.data, confirmLeftover);
      written.push({ path: paths.stripped(id), ...strippedObj });
      const derivedObj = await saveCreateOnly(deps, paths.derivedV2(id), publicImage.data, confirmLeftover);
      written.push({ path: paths.derivedV2(id), ...derivedObj });
      saved = { stripped: strippedObj, derived: derivedObj };
    } catch (err) {
      if (!(err instanceof LostLease)) throw err;
      await dropWritten();
      return done("changed");
    }
    const { stripped, derived } = saved;

    // Where the row's own consent record(s) are (a query may be needed); read again inside the commit transaction.
    const consentRefs = await consentRefsFor(deps, id, row);
    let notes: string[] = [];
    let lockedNoConsent = false;
    const committed = await db.runTransaction(async (tx) => {
      const cur = (await tx.get(ref)).data();
      // Our own earlier attempt landed (the SDK re-ran this transaction after losing its commit answer).
      if (cur && cur.derivedGeneration === derived.generation && cur.strippedGeneration === stripped.generation) {
        lockedNoConsent = Array.isArray(cur.flags) && cur.flags.includes(CONSENT_MISSING);
        return true;
      }
      if (!owns(cur)) return false;
      // The row names another consent record than it did when the lookup was made: start again on a later run.
      if (cur.consentId !== rowConsentId) return false;
      const consents = await readOwnConsents(consentRefs, id, async (r) => {
        const snap = await tx.get(r);
        return snap.exists ? snap.data() : undefined;
      });
      const records = consents.map((c) => c.data);
      // No record names this submission: fail closed (protectStoredRow locks the row private for an empty list).
      lockedNoConsent = records.length === 0;
      const protection = protectStoredRow(cur, records);
      notes = planNotes(cur, framingKnown, records, ops, false);
      const flags = Array.isArray(cur.flags) ? cur.flags.filter((f): f is string => typeof f === "string") : [];
      const looks = [...(lockedNoConsent ? [CONSENT_MISSING] : []), ...(framingKnown ? [] : [FRAMING_UNKNOWN])];
      tx.update(ref, {
        stripped: true,
        derivedGeneration: derived.generation,
        derivedMd5: derived.md5,
        strippedGeneration: stripped.generation,
        originalPath: paths.stripped(id),
        derivedPath: paths.derivedV2(id),
        originalName: isUploadType(cur.originalMime) ? genericOriginalName(cur.originalMime) : "artwork.jpg",
        storedMime: "image/jpeg",
        width: publicImage.width,
        height: publicImage.height,
        processedAt: ops.serverTimestamp(),
        processingLease: ops.deleteField(),
        permissions: protection.permissions,
        showOrganization: protection.showOrganization,
        email: protection.email,
        minorProtectionsApplied: protection.minorProtectionsApplied,
        // The old derivative is a leftover only when it was used (framing known). Otherwise it stays for the person
        // asked to look at the piece (retention keeps it too while the row has needsStaffLook).
        legacyLeftovers: { derived: framingKnown ? oldGeneration : null, upload: uploadGeneration },
        ...(looks.length ? { needsStaffLook: looks[0], flags: [...new Set([...flags, ...looks])] } : {}),
      });
      for (const c of consents) {
        const narrowed = narrowConsent(c.data, protection, ops);
        if (narrowed) tx.update(c.ref, narrowed);
      }
      audit(tx, db, ops, { actor: "system", action: "legacy-reprocess", target: id, detail: looks.join(" ") });
      return true;
    });
    if (!committed) {
      await dropWritten();
      return done("changed");
    }
    // Committed: only now do the upload (and the old derivative, if it was used) go, each by its exact generation.
    const cleaned = await removeLeftovers(deps, id);
    if (lockedNoConsent) return done("reprocessed-locked-no-consent", cleaned ? notes : [...notes, "cleanup=pending"]);
    return done(cleaned ? "reprocessed" : "reprocessed-cleanup-pending", notes);
  } catch (err) {
    // Transient: whatever was written is an uncommitted leftover a later run clears; the upload and the old
    // derivative (still what the row points at) stay.
    await release().catch(() => undefined);
    throw err;
  }
}

export type LegacyArgs = { project: string; bucket: string | null; id: string | null; write: boolean };

export const LEGACY_USAGE =
  "Usage: node scripts/reprocess-legacy.mjs --project <firebase-project-id> [--bucket <bucket>] [--id sub_...] [--write]";

/** Command line of scripts/reprocess-legacy.mjs. --project is required; without --write it is a dry run. */
export function parseLegacyArgs(argv: readonly string[]): LegacyArgs {
  let project: string | null = null;
  let bucket: string | null = null;
  let id: string | null = null;
  let write = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = () => {
      const v = argv[++i];
      if (v === undefined || v.startsWith("--")) throw new Error(`${arg} needs a value.\n${LEGACY_USAGE}`);
      return v;
    };
    if (arg === "--project") project = value();
    else if (arg === "--bucket") bucket = value();
    else if (arg === "--id") id = value();
    else if (arg === "--write") write = true;
    else if (arg === "--dry-run") write = false;
    else throw new Error(`Unknown argument ${JSON.stringify(arg)}.\n${LEGACY_USAGE}`);
  }
  if (!project) throw new Error(`--project is required.\n${LEGACY_USAGE}`);
  if (!/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(project)) throw new Error("--project does not look like a Firebase project id.");
  if (bucket !== null && !/^[a-z0-9][a-z0-9._-]{1,220}[a-z0-9]$/.test(bucket)) throw new Error("--bucket does not look like a bucket name.");
  if (id !== null && !SUBMISSION_ID_RE.test(id)) throw new Error("--id must be sub_ followed by 32 lowercase hex characters.");
  return { project, bucket, id, write };
}

/**
 * Runs the candidates one by one and prints one line per id: "<id> <outcome> [plan words]". Never prints row
 * contents. Returns the count per outcome.
 */
export async function runLegacyReprocess(
  deps: LegacyDeps,
  ids: Iterable<string> | AsyncIterable<string>,
  opts: { write: boolean },
  print: (line: string) => void,
): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for await (const id of ids) {
    let outcome: string;
    let notes: string[] = [];
    try {
      ({ outcome, notes } = await reprocessLegacySubmission(deps, id, opts));
    } catch (err) {
      outcome = `error:${err instanceof Error ? err.name : "unknown"}`;
    }
    counts[outcome] = (counts[outcome] ?? 0) + 1;
    print([SUBMISSION_ID_RE.test(id) ? id : "(malformed id)", outcome, ...notes].join(" "));
  }
  return counts;
}
