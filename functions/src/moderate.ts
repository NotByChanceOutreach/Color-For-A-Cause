/**
 * moderateSubmission (contract C4).
 *
 * - Staff only, by role claim. ADMIN and REVIEWER can set any status; ART_MANAGER can only move
 *   already-approved art between 'approved' and 'featured' (curating the wall).
 * - Publishing (F6: concurrent publishes of one submission):
 *     1. A transaction records a publish claim on the submission (claim id, target status, the reviewed
 *        derivedGeneration, expiry). It fails if another live claim exists or the row moved on.
 *     2. Only the claim holder touches Storage. An object already at gallery/{id}/public.jpg can only be a leftover
 *        (a publisher that died, or an unpublish whose file removal failed): the holder reads its generation, then
 *        confirms it still holds the claim and the row does not record that generation as live, and deletes exactly
 *        that generation (its download tokens revoked first). It then copies submissions/{id}/derived/public.jpg,
 *        pinned to the reviewed generation, to gallery/{id}/public.jpg with ifGenerationMatch=0 (create only), public
 *        cache headers and NO download token: publicGallery/{id}.imageUrl is the tokenless URL, which storage.rules
 *        check on every read (readable only while publicGallery/{id} exists).
 *     3. A second transaction checks the claim is still its own and the row unchanged, then commits the status,
 *        the publicGallery doc, the counters, galleryGeneration (the committed object) and clears the claim. If the
 *        row already records this copy's generation, an earlier attempt of this commit landed: that is success.
 *   If the copy fails, a transaction removes the claim. If the commit fails and the row does not record the copy,
 *   the holder deletes only the generation it created.
 * - Unpublishing is database first. A transaction re-checks the status, refuses while a live publish claim is held,
 *   moves the status, deletes the publicGallery doc and moves galleryGeneration to galleryOrphan. Only after that
 *   commit are that generation's download tokens revoked (a reader may have minted one with getDownloadURL while the
 *   piece was on the wall) and exactly that generation deleted (and galleryOrphan cleared). So the wall never shows a
 *   doc whose image is gone, and a transaction that fails has deleted nothing. If the file removal fails, staff are
 *   asked to press the button again; any later moderation (or a new publish) of the piece removes the recorded orphan,
 *   and retention.ts removes it too.
 * - Expired claims: a claim past its `until` belongs to a publisher that died or stalled. It counts as released
 *   everywhere: a new publish takes it over, and every other decision (hold, reject, archive, unpublish, curate)
 *   removes it inside its own transaction, as retention.ts does before it removes a leftover copy. The stalled
 *   publisher's commit requires its own claim id, so it can never commit afterwards.
 * - Fencing: claim ids are never reused and every row write a publisher makes is a transaction that requires its own
 *   claim id; Storage writes are create-only and every delete names a generation. A publisher that outlives its
 *   claim (it timed out but kept running) therefore can neither publish nor delete another publisher's image.
 *   PUBLISH_CLAIM_MS > CALLABLE_OPTIONS.timeoutSeconds only keeps such takeovers rare.
 * - Counters move with FieldValue.increment, only when a piece actually goes on or off the wall.
 */
import { createHash, randomUUID } from "node:crypto";
import { PAGE_IDS, PUBLIC_STATUSES, SUBMISSION_STATUSES, paths, type SubmissionStatus } from "./constants";
import { fail } from "./errors";
import { audit, type Data, type Db, type DocRef, type Ops, type Tx } from "./store";
import { bylineKey, cleanStoredText, hasReadableText, parseModerateRequest, type ModerateRequest } from "./validation";

export type Actor = { uid: string; role: string };

export const PUBLISH_CLAIM_MS = 5 * 60 * 1000;

const STAFF_WHO_MODERATE = new Set(["ADMIN", "REVIEWER", "ART_MANAGER"]);
const CHANGED = "The picture changed since you opened it. Reload and look again.";
const MOVED = "Someone else just changed this submission. Reload and try again.";
const PUBLISHING = "Someone else is publishing this picture right now. Reload in a minute and look again.";
const NOT_CHECKED =
  "This picture has not been through the server privacy check, so it cannot be published. Ask the artist to send it again.";
export const ORPHAN_LEFT =
  "The art is off the Art Wall, but its picture file could not be removed yet. Please press the same button again.";

/** Thrown by ModerateDeps.publishCopy when the pinned source generation is not live any more. */
export class GenerationMismatch extends Error {
  constructor() {
    super("generation mismatch");
    this.name = "GenerationMismatch";
  }
}

/** Thrown by ModerateDeps.publishCopy when the destination already exists (ifGenerationMatch=0 failed). */
export class DestinationExists extends Error {
  constructor() {
    super("destination exists");
    this.name = "DestinationExists";
  }
}

export interface ModerateDeps {
  db: Db;
  ops: Ops;
  now(): number;
  /**
   * Copy exactly `generation` of `src` to `dest`, only if `dest` does not exist (ifGenerationMatch=0), with
   * public cache headers and no download token. Returns the created generation and its tokenless URL.
   * Throws GenerationMismatch when the source generation is gone, DestinationExists when `dest` exists.
   */
  publishCopy(src: string, generation: string, dest: string): Promise<{ generation: string; url: string }>;
  /** The live generation at `path`, or null when there is none. */
  generationOf(path: string): Promise<string | null>;
  /** Delete exactly `generation` of `path`; a missing object (or another generation) is not an error. */
  remove(path: string, generation: string): Promise<void>;
  /** Remove every download token from exactly `generation` of `path`; a missing object is not an error. */
  revokeTokens(path: string, generation: string): Promise<void>;
}

export function isSubmissionStatus(v: unknown): v is SubmissionStatus {
  return typeof v === "string" && (SUBMISSION_STATUSES as readonly string[]).includes(v);
}

export function canModerate(role: string, from: SubmissionStatus, to: SubmissionStatus): boolean {
  if (role === "ADMIN" || role === "REVIEWER") return true;
  if (role === "ART_MANAGER") {
    return (from === "approved" && to === "featured") || (from === "featured" && to === "approved");
  }
  return false;
}

export function isPublicState(status: unknown, permissions: unknown): boolean {
  const displayPublic = (permissions as { displayPublic?: unknown } | null | undefined)?.displayPublic;
  return isSubmissionStatus(status) && PUBLIC_STATUSES.includes(status) && displayPublic === true;
}

export type PlanAction = "publish" | "unpublish" | "update-public" | "none";
export type Plan = { from: SubmissionStatus; to: SubmissionStatus; action: PlanAction };

export function planModeration(row: Data, to: SubmissionStatus): Plan {
  const from = row.status as SubmissionStatus;
  const was = isPublicState(from, row.permissions);
  const will = isPublicState(to, row.permissions);
  const action: PlanAction = !was && will ? "publish" : was && !will ? "unpublish" : was && will ? "update-public" : "none";
  return { from, to, action };
}

/**
 * Distinct public bylines drive "artists participating". All anonymous pieces count as one, and so does a name
 * with nothing readable in it.
 */
export function artistKey(row: Data): string {
  const perms = row.permissions as { showAttribution?: unknown } | undefined;
  const key =
    perms?.showAttribution === true && row.attributionKind !== "anonymous" && typeof row.attributionText === "string"
      ? bylineKey(row.attributionText)
      : "";
  const byline = hasReadableText(key) ? key : "anonymous";
  return createHash("sha256").update(`cfac-artist:${byline}`).digest("hex");
}

/**
 * Only what the public may see. Never email, age, flags, notes, or internal paths. Stored text is cleaned again
 * here, so a row saved under older rules cannot put invisible or blank text on the wall; the page id and the name
 * kind are copied only when they are one of the known values (rows from 9b2fc57 stored them unchecked).
 */
export function publicGalleryDoc(id: string, row: Data, status: SubmissionStatus, imageUrl: string, ops: Ops): Data {
  const perms = (row.permissions ?? {}) as Record<string, unknown>;
  const showAttribution = perms.showAttribution === true;
  const showMessage = perms.showMessage === true;
  const name = showAttribution && row.attributionKind !== "anonymous" ? cleanStoredText(row.attributionText, false) : "";
  const named = hasReadableText(name);
  const org = row.showOrganization === true ? cleanStoredText(row.organizationName, false) : "";
  const showOrganization = hasReadableText(org);
  const pageId = typeof row.pageId === "string" && (PAGE_IDS as readonly string[]).includes(row.pageId) ? row.pageId : null;
  return {
    id,
    number: String(row.number ?? ""),
    pageId,
    status,
    public: true,
    attributionKind: named ? (row.attributionKind === "nickname" ? "nickname" : "firstName") : "anonymous",
    attributionText: named ? name : "",
    organizationName: showOrganization ? org : null,
    showOrganization,
    message: showMessage ? cleanStoredText(row.message, true) : "",
    permissions: {
      store: false,
      displayPublic: true,
      social: false,
      reproduce: false,
      promotional: false,
      collectible: false,
      sellCollectible: false,
      showAttribution,
      showMessage,
    },
    imageUrl,
    createdAt: row.createdAt ?? ops.serverTimestamp(),
    reviewedAt: ops.serverTimestamp(),
  };
}

type PublishClaim = { id: string; to: string; generation: string; until: number };

export function readPublishClaim(v: unknown): PublishClaim | null {
  if (!v || typeof v !== "object") return null;
  const c = v as Record<string, unknown>;
  return typeof c.id === "string" && typeof c.to === "string" && typeof c.generation === "string" && typeof c.until === "number"
    ? { id: c.id, to: c.to, generation: c.generation, until: c.until }
    : null;
}

/** A claim a publisher may still be acting on. An expired or malformed claim counts as released. */
export function isLiveClaim(v: unknown, now: number): boolean {
  const claim = readPublishClaim(v);
  return claim !== null && claim.until > now;
}

/** The row carries a publish claim that counts as released (expired or malformed): it should be removed. */
export function hasReleasedClaim(row: Data | undefined, now: number): boolean {
  return !!row && row.publishClaim !== undefined && row.publishClaim !== null && !isLiveClaim(row.publishClaim, now);
}

/** Revoke the download tokens of one gallery generation, then delete it. A failed revoke does not stop the delete. */
async function removeGalleryGeneration(deps: ModerateDeps, path: string, generation: string): Promise<void> {
  await deps.revokeTokens(path, generation).catch(() => undefined);
  await deps.remove(path, generation);
}

/**
 * The server-made derivative a row records in derivedPath: derived/public.jpg (upload trigger), or
 * derived/public-v2.jpg (a piece sent before the server privacy check, reprocessed by legacy.ts). A row without a
 * derivedPath uses derived/public.jpg. Anything else is not a server-made image of this piece: null.
 */
export function derivedSource(id: string, row: Data): string | null {
  const recorded = row.derivedPath;
  if (recorded === undefined || recorded === null) return paths.derived(id);
  return recorded === paths.derived(id) || recorded === paths.derivedV2(id) ? recorded : null;
}

function checkPublishable(row: Data, input: ModerateRequest): void {
  if (row.stripped !== true || typeof row.derivedGeneration !== "string") fail("failed-precondition", NOT_CHECKED);
  if (!derivedSource(input.id, row)) fail("failed-precondition", NOT_CHECKED);
  if (!input.derivedGeneration) fail("invalid-argument", "derivedGeneration is required to publish.");
  if (input.derivedGeneration !== row.derivedGeneration) fail("failed-precondition", CHANGED);
}

/**
 * Status, public doc, counters and audit for one decision, inside the caller's transaction. The caller has
 * already read `cur` (the submission) in `tx`; this does the remaining reads, then every write.
 */
async function commitDecision(
  tx: Tx,
  deps: ModerateDeps,
  cur: Data,
  plan: Plan,
  input: ModerateRequest,
  actor: Actor,
  imageUrl: string,
  extra: Data = {},
): Promise<void> {
  const { db, ops } = deps;
  const id = input.id;
  const galleryRef = db.doc(`publicGallery/${id}`);
  const countersRef = db.doc("counters/public");

  let keyRef: DocRef | null = null;
  let key: string | null = null;
  if (plan.action === "publish") {
    key = artistKey(cur);
    keyRef = db.doc(`artistKeys/${key}`);
  } else if (plan.action === "unpublish" && typeof cur.publicArtistKey === "string" && /^[0-9a-f]{64}$/.test(cur.publicArtistKey)) {
    keyRef = db.doc(`artistKeys/${cur.publicArtistKey}`);
  }
  const keySnap = keyRef ? await tx.get(keyRef) : null;
  const keyCount = keySnap?.exists ? Number(keySnap.data()?.count ?? 0) : 0;
  const gallerySnap = plan.action === "update-public" ? await tx.get(galleryRef) : null;

  const update: Data = {
    status: input.status,
    reviewedAt: ops.serverTimestamp(),
    reviewedBy: actor.uid,
    staffNote: input.note,
    ...extra,
  };
  // An expired claim is released: a stalled publisher holding it can never commit after this (it needs its claim id).
  if (plan.action !== "publish" && hasReleasedClaim(cur, deps.now())) update.publishClaim = ops.deleteField();
  if (plan.action === "publish" && keyRef && key) {
    tx.set(galleryRef, publicGalleryDoc(id, cur, input.status, imageUrl, ops));
    update.publicArtistKey = key;
    if (keyCount <= 0) {
      tx.set(keyRef, { count: 1 });
      tx.set(countersRef, { artistsParticipating: ops.increment(1) }, { merge: true });
    } else {
      tx.set(keyRef, { count: ops.increment(1) }, { merge: true });
    }
  } else if (plan.action === "update-public" && gallerySnap?.exists) {
    tx.update(galleryRef, { status: input.status, reviewedAt: ops.serverTimestamp() });
  } else if (plan.action === "unpublish") {
    tx.delete(galleryRef);
    update.publicArtistKey = ops.deleteField();
    if (keyRef && keySnap?.exists) {
      if (keyCount <= 1) {
        tx.delete(keyRef);
        tx.set(countersRef, { artistsParticipating: ops.increment(-1) }, { merge: true });
      } else {
        tx.set(keyRef, { count: ops.increment(-1) }, { merge: true });
      }
    }
  }
  tx.update(db.doc(`submissions/${id}`), update);
  audit(tx, db, ops, { actor: actor.uid, action: `status:${input.status}`, target: id, detail: input.note });
}

async function publish(deps: ModerateDeps, actor: Actor, input: ModerateRequest, plan: Plan): Promise<void> {
  const { db, ops } = deps;
  const id = input.id;
  const ref = db.doc(`submissions/${id}`);
  const galleryPath = paths.gallery(id);
  const claim: PublishClaim = {
    id: randomUUID(),
    to: input.status,
    generation: String(input.derivedGeneration),
    until: deps.now() + PUBLISH_CLAIM_MS,
  };
  const holdsClaim = (cur: Data | undefined): cur is Data => !!cur && readPublishClaim(cur.publishClaim)?.id === claim.id;

  // 1. Claim. Losing publishers stop here, before touching Storage. The copy source is the derivative the row
  //    records (derivedPath), read in the same transaction as the generation check.
  let source = "";
  await db.runTransaction(async (tx) => {
    const cur = (await tx.get(ref)).data();
    if (!cur || cur.status !== plan.from) fail("aborted", MOVED);
    // An expired claim is taken over. (Our own claim can show up here when the SDK re-runs this transaction after
    // losing its commit answer.)
    if (isLiveClaim(cur.publishClaim, deps.now()) && readPublishClaim(cur.publishClaim)?.id !== claim.id) fail("aborted", PUBLISHING);
    checkPublishable(cur, input);
    source = derivedSource(id, cur) ?? "";
    tx.update(ref, { publishClaim: claim });
  });

  const releaseClaim = () =>
    db.runTransaction(async (tx) => {
      const cur = (await tx.get(ref)).data();
      if (holdsClaim(cur)) tx.update(ref, { publishClaim: ops.deleteField() });
    });

  // 2. Clear a leftover, then copy.
  let copied: { generation: string; url: string };
  try {
    const leftover = await deps.generationOf(galleryPath);
    if (leftover !== null) {
      // Generation first, then the claim check: a generation read before we confirm the claim is still ours
      // predates any later publisher, and nothing is committed while we hold the claim.
      const cur = (await db.get(ref)).data();
      if (!holdsClaim(cur) || cur.galleryGeneration === leftover) fail("aborted", MOVED);
      await removeGalleryGeneration(deps, galleryPath, leftover);
    }
    copied = await deps.publishCopy(source, claim.generation, galleryPath);
  } catch (err) {
    await releaseClaim().catch(() => undefined);
    if (err instanceof GenerationMismatch) fail("failed-precondition", CHANGED);
    if (err instanceof DestinationExists) fail("aborted", PUBLISHING);
    throw err;
  }

  // 3. Commit, still holding the claim.
  try {
    await db.runTransaction(async (tx) => {
      const cur = (await tx.get(ref)).data();
      if (cur && cur.galleryGeneration === copied.generation) return; // our own earlier attempt landed
      if (!holdsClaim(cur) || cur.status !== plan.from) fail("aborted", MOVED);
      if (cur.derivedGeneration !== claim.generation || derivedSource(id, cur) !== source) fail("failed-precondition", CHANGED);
      await commitDecision(tx, deps, cur, plan, input, actor, copied.url, {
        publishClaim: ops.deleteField(),
        galleryGeneration: copied.generation,
        // The path now holds our copy, so any recorded orphan generation is gone.
        galleryOrphan: ops.deleteField(),
      });
    });
  } catch (err) {
    // A commit whose answer was lost may still have landed: delete our copy only if the row certainly does not
    // record it. If the row cannot be read, leave the copy; the next publish clears it as a leftover.
    let recorded: boolean | null;
    try {
      recorded = (await db.get(ref)).data()?.galleryGeneration === copied.generation;
    } catch {
      recorded = null;
    }
    if (recorded === true) return;
    if (recorded === false) await deps.remove(galleryPath, copied.generation).catch(() => undefined);
    await releaseClaim().catch(() => undefined);
    throw err;
  }
}

/** Returns the gallery generation to delete now that the database no longer points at it (null: none). */
async function unpublish(deps: ModerateDeps, actor: Actor, input: ModerateRequest, plan: Plan, seen: Data): Promise<string | null> {
  const { db, ops } = deps;
  const id = input.id;
  const ref = db.doc(`submissions/${id}`);
  const recordedBefore = typeof seen.galleryGeneration === "string";
  // Art published before galleryGeneration was recorded: look up the live object. While the row is public no
  // publisher can copy (that needs a non-public row and a claim), so it cannot change before the transaction.
  const legacyGeneration = recordedBefore ? null : await deps.generationOf(paths.gallery(id));
  return db.runTransaction(async (tx) => {
    const cur = (await tx.get(ref)).data();
    if (!cur || cur.status !== plan.from || planModeration(cur, input.status).action !== "unpublish") fail("aborted", MOVED);
    if (isLiveClaim(cur.publishClaim, deps.now())) fail("aborted", PUBLISHING);
    const recorded = typeof cur.galleryGeneration === "string" ? cur.galleryGeneration : null;
    if (recordedBefore !== (recorded !== null)) fail("aborted", MOVED);
    const live = recorded ?? legacyGeneration;
    await commitDecision(tx, deps, cur, plan, input, actor, "", {
      galleryGeneration: ops.deleteField(),
      ...(live ? { galleryOrphan: live } : {}),
    });
    return live;
  });
}

/**
 * Revoke the download tokens of the gallery generation the row records as an orphan (galleryOrphan), delete it,
 * then clear the record.
 * `known`: the generation the caller just recorded, null for "nothing recorded", undefined to read the row.
 * Returns false only when an orphan is recorded and its removal failed.
 */
async function removeRecordedOrphan(deps: ModerateDeps, id: string, known: string | null | undefined): Promise<boolean> {
  const { db, ops } = deps;
  const ref = db.doc(`submissions/${id}`);
  let orphan: unknown = known;
  if (orphan === undefined) {
    try {
      orphan = (await db.get(ref)).data()?.galleryOrphan;
    } catch {
      return true; // unknown for now; the record stays and the next moderation retries
    }
  }
  if (typeof orphan !== "string") return true;
  try {
    await removeGalleryGeneration(deps, paths.gallery(id), orphan);
  } catch {
    return false;
  }
  await db
    .runTransaction(async (tx) => {
      const cur = (await tx.get(ref)).data();
      if (cur && cur.galleryOrphan === orphan) tx.update(ref, { galleryOrphan: ops.deleteField() });
    })
    .catch(() => undefined);
  return true;
}

export async function moderateSubmission(
  deps: ModerateDeps,
  actor: Actor,
  raw: unknown,
): Promise<{ ok: true; id: string; status: SubmissionStatus }> {
  if (!STAFF_WHO_MODERATE.has(actor.role)) fail("permission-denied", "Staff only.");
  const input = parseModerateRequest(raw);
  const { db } = deps;
  const id = input.id;
  const ref = db.doc(`submissions/${id}`);

  const snap = await db.get(ref);
  const row = snap.exists ? snap.data() : undefined;
  if (!row) fail("not-found", "Submission not found.");
  if (!isSubmissionStatus(row.status)) fail("failed-precondition", "This submission is not ready for review yet.");
  if (!canModerate(actor.role, row.status, input.status)) {
    fail("permission-denied", "Your staff role cannot make that change.");
  }
  const plan = planModeration(row, input.status);

  if (plan.action === "publish") {
    checkPublishable(row, input);
    await publish(deps, actor, input, plan);
    return { ok: true, id, status: input.status };
  }

  let orphan: string | null | undefined;
  let failure: unknown = null;
  try {
    if (plan.action === "unpublish") {
      orphan = await unpublish(deps, actor, input, plan, row);
    } else {
      await db.runTransaction(async (tx) => {
        const cur = (await tx.get(ref)).data();
        if (!cur || cur.status !== plan.from) fail("aborted", MOVED);
        await commitDecision(tx, deps, cur, plan, input, actor, "");
      });
    }
  } catch (err) {
    failure = err;
    orphan = undefined;
  }
  // The public file goes only once the database no longer points at it: this unpublish's, or one an earlier
  // attempt could not remove (pressing the button again retries it).
  const cleared = await removeRecordedOrphan(deps, id, orphan);
  if (failure) throw failure;
  if (!cleared) fail("aborted", ORPHAN_LEFT);
  return { ok: true, id, status: input.status };
}
