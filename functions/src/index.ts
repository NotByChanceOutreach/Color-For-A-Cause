/**
 * Cloud Functions entry point: wiring only (Admin SDK adapters, function options, error mapping).
 * The rules live in the imported modules and are unit-tested in tests/functions.
 */
import { randomUUID } from "node:crypto";
import { initializeApp } from "firebase-admin/app";
import { FieldPath, FieldValue, Timestamp, getFirestore, type DocumentReference, type Transaction } from "firebase-admin/firestore";
import { getStorage } from "firebase-admin/storage";
import * as logger from "firebase-functions/logger";
import { defineInt } from "firebase-functions/params";
import { setGlobalOptions } from "firebase-functions/v2";
import { HttpsError, onCall, type CallableRequest } from "firebase-functions/v2/https";
import { onSchedule } from "firebase-functions/v2/scheduler";
import { onObjectFinalized } from "firebase-functions/v2/storage";
import { refuseReplayedAppCheckToken } from "./appCheck";
import { upsertCollectible as runUpsertCollectible } from "./collectibles";
import { REGION, UPLOAD_PATH_RE } from "./constants";
import { AppError } from "./errors";
import { finalizeSubmission as runFinalize } from "./finalize";
import { storageAdapters } from "./gcs";
import { createGroup as runCreateGroup, getGroup as runGetGroup, type GroupDeps } from "./groups";
import { processImage } from "./image";
import { moderateSubmission as runModerate, readPublishClaim } from "./moderate";
import { CALLABLE_OPTIONS, REPLAY_PROTECTED_OPTIONS, RETENTION_SCHEDULE, UPLOAD_TRIGGER_OPTIONS } from "./options";
import {
  DEFAULT_TRUSTED_PROXY_HOPS,
  clientIpInfo,
  consumeRateLimit,
  groupRateKey,
  resolveTrustedProxyHops,
  xffShapeLogger,
} from "./rateLimit";
import {
  deleteAbandonedRow,
  releaseExpiredPublishClaim,
  runRetention,
  type ExistingSubmission,
  type GalleryState,
  type RetentionState,
} from "./retention";
import type { Db, Ops, Tx } from "./store";
import { startSubmission } from "./submit";
import { LeaseBusy, handleOriginalUpload } from "./uploadTrigger";

setGlobalOptions({ region: REGION, maxInstances: 20 });

initializeApp();
const firestore = getFirestore();
const bucket = getStorage().bucket();
const storage = storageAdapters(bucket);

/**
 * How many proxies append to X-Forwarded-For in front of the callables (see rateLimit.ts). Deploy-time param,
 * default 1; check the "x-forwarded-for shape" log after a deploy before changing it.
 */
const trustedProxyHopsParam = defineInt("TRUSTED_PROXY_HOPS", {
  default: DEFAULT_TRUSTED_PROXY_HOPS,
  description: "Proxies that append to X-Forwarded-For before the callables (Hosting + Google front end = 1).",
});

// ---------------------------------------------------------------- adapters

function adaptTx(t: Transaction): Tx {
  return {
    get: (ref) => t.get(ref as DocumentReference),
    set: (ref, data, options) =>
      options ? t.set(ref as DocumentReference, data, options) : t.set(ref as DocumentReference, data),
    update: (ref, data) => t.update(ref as DocumentReference, data),
    create: (ref, data) => t.create(ref as DocumentReference, data),
    delete: (ref) => t.delete(ref as DocumentReference),
  };
}

const db: Db = {
  doc: (path) => firestore.doc(path),
  newDoc: (collection) => firestore.collection(collection).doc(),
  get: (ref) => (ref as DocumentReference).get(),
  runTransaction: (fn) => firestore.runTransaction((t) => fn(adaptTx(t))),
};

const ops: Ops = {
  increment: (n) => FieldValue.increment(n),
  serverTimestamp: () => FieldValue.serverTimestamp(),
  deleteField: () => FieldValue.delete(),
};

function rethrow(err: unknown): never {
  if (err instanceof AppError) throw new HttpsError(err.code, err.message);
  if (err instanceof HttpsError) throw err;
  logger.error("callable failed", err);
  throw new HttpsError("internal", "Something went wrong on our side. Please try again.");
}

function handler<T>(fn: (req: CallableRequest<unknown>) => Promise<T>) {
  return async (req: CallableRequest<unknown>): Promise<T> => {
    try {
      return await fn(req);
    } catch (err) {
      return rethrow(err);
    }
  };
}

function actorOf(req: CallableRequest<unknown>) {
  const role = req.auth?.token?.role;
  return { uid: req.auth?.uid ?? "", role: typeof role === "string" ? role : "" };
}

function trustedProxyHops(): number {
  // IntParam.value() reads 0 when the variable is unset; the CLI sets it (default 1) at deploy time.
  return process.env.TRUSTED_PROXY_HOPS === undefined
    ? DEFAULT_TRUSTED_PROXY_HOPS
    : resolveTrustedProxyHops(trustedProxyHopsParam.value());
}

// Once per instance, then ~1% of calls: entry count and index used, never the addresses.
const logXffShape = xffShapeLogger((fields) => logger.info("x-forwarded-for shape", fields));

function ipOf(req: CallableRequest<unknown>): string {
  const hops = trustedProxyHops();
  const info = clientIpInfo(req.rawRequest.headers, req.rawRequest.ip ?? req.rawRequest.socket?.remoteAddress, hops);
  logXffShape(info, hops);
  return info.ip;
}

async function nextArtNumber(): Promise<string> {
  const counter = firestore.doc("counters/art");
  const n = await firestore.runTransaction(async (tx) => {
    const snap = await tx.get(counter);
    const next = Number(snap.data()?.n ?? 0) + 1;
    tx.set(counter, { n: next }, { merge: true });
    return next;
  });
  return `NBC-ART-${String(n).padStart(6, "0")}`;
}

async function findGroupByPublicId(publicId: string) {
  const snap = await firestore.collection("groups").where("publicId", "==", publicId).limit(1).get();
  return snap.empty ? null : snap.docs[0].data();
}

function groupDeps(rateLimit: () => Promise<void>): GroupDeps {
  return { db, ops, now: Date.now, rateLimit, findByPublicId: findGroupByPublicId };
}

// ---------------------------------------------------------------- public callables

export const submitArtwork = onCall(
  REPLAY_PROTECTED_OPTIONS,
  handler((req) => {
    // Before any work: an App Check token that was already used is refused (appCheck.ts).
    refuseReplayedAppCheckToken(req);
    const ip = ipOf(req);
    return startSubmission(
      {
        db,
        ops,
        now: Date.now,
        rateLimit: (group) =>
          group
            ? consumeRateLimit(db, "submitArtworkGroup", groupRateKey(group, ip), Date.now())
            : consumeRateLimit(db, "submitArtwork", ip, Date.now()),
        groupExists: async (publicId) => (await findGroupByPublicId(publicId)) !== null,
        nextArtNumber,
        signUpload: async (path, config) => (await bucket.file(path).getSignedUrl(config))[0],
      },
      req.data,
      { userAgent: String(req.rawRequest.headers["user-agent"] ?? "") },
    );
  }),
);

export const finalizeSubmission = onCall(
  CALLABLE_OPTIONS,
  handler((req) => runFinalize(db, ops, req.data)),
);

export const createGroup = onCall(
  REPLAY_PROTECTED_OPTIONS,
  handler((req) => {
    refuseReplayedAppCheckToken(req);
    return runCreateGroup(groupDeps(() => consumeRateLimit(db, "createGroup", ipOf(req), Date.now())), req.data);
  }),
);

export const getGroup = onCall(
  CALLABLE_OPTIONS,
  handler((req) => runGetGroup(groupDeps(async () => undefined), req.data)),
);

// ---------------------------------------------------------------- staff callables

export const moderateSubmission = onCall(
  CALLABLE_OPTIONS,
  handler((req) =>
    runModerate(
      {
        db,
        ops,
        now: Date.now,
        publishCopy: storage.publishCopy,
        generationOf: storage.generationOf,
        remove: storage.removeObject,
        revokeTokens: storage.revokeTokens,
      },
      actorOf(req),
      req.data,
    ),
  ),
);

export const upsertCollectible = onCall(
  CALLABLE_OPTIONS,
  handler((req) => runUpsertCollectible({ db, ops }, actorOf(req), req.data)),
);

// ---------------------------------------------------------------- storage trigger (C2)

export const onOriginalUploaded = onObjectFinalized(UPLOAD_TRIGGER_OPTIONS, async (event) => {
  const object = event.data;
  if (!object.name || !UPLOAD_PATH_RE.test(object.name)) return;
  try {
    const result = await handleOriginalUpload(
      {
        name: object.name,
        generation: String(object.generation),
        size: Number(object.size),
        contentType: object.contentType,
        timeCreatedMs: Date.parse(String(object.timeCreated ?? "")),
      },
      {
        db,
        ops,
        now: Date.now,
        leaseOwner: randomUUID(),
        download: storage.download,
        save: storage.saveJpeg,
        generationOf: storage.generationOf,
        remove: storage.removeObject,
        process: processImage,
      },
    );
    logger.info("original upload handled", { name: object.name, ...result });
  } catch (err) {
    // Throwing makes Eventarc redeliver the event (UPLOAD_TRIGGER_OPTIONS.retry).
    if (err instanceof LeaseBusy) logger.info("original upload busy; will be retried", { name: object.name });
    else logger.error("original upload failed; will be retried", { name: object.name, err });
    throw err;
  }
});

// ---------------------------------------------------------------- retention (C8)

const DOC_ID = FieldPath.documentId();
const RETENTION_STATE = "system/retention";

export const purgeAbandonedUploads = onSchedule(RETENTION_SCHEDULE, async () => {
  const result = await runRetention(
    {
      findCandidates: async (status, cutoff, limit, after) => {
        // Oldest first, served by the (status ASC, createdAt ASC) composite index in firestore.indexes.json.
        const base = firestore
          .collection("submissions")
          .where("status", "==", status)
          .where("createdAt", "<", Timestamp.fromDate(cutoff))
          .orderBy("createdAt", "asc")
          .orderBy(DOC_ID, "asc");
        const snap = await (after ? base.startAfter(after.at, after.id) : base).limit(limit).get();
        return snap.docs.map((d) => ({ id: d.id, data: d.data() }));
      },
      // Re-reads the row in a transaction and deletes it (with its consent) only if it is still abandoned.
      deleteAbandoned: (id, nowMs) => deleteAbandonedRow(db, id, nowMs),
      deleteStoragePrefix: (prefix) => bucket.deleteFiles({ prefix, force: true }),
      deleteDocs: async (docPaths) => {
        const batch = firestore.batch();
        for (const p of docPaths) batch.delete(firestore.doc(p));
        await batch.commit();
      },
      deleteExpiredRateLimits: async (now, limit) => {
        const snap = await firestore.collection("rateLimits").where("expiresAt", "<", Timestamp.fromDate(now)).limit(limit).get();
        if (snap.empty) return 0;
        const batch = firestore.batch();
        for (const d of snap.docs) batch.delete(d.ref);
        await batch.commit();
        return snap.size;
      },
      findOldConsents: async (cutoff, limit, after) => {
        // Single-field range + order on `timestamp` (automatic index), then document id.
        const base = firestore
          .collection("consents")
          .where("timestamp", "<", Timestamp.fromDate(cutoff))
          .orderBy("timestamp", "asc")
          .orderBy(DOC_ID, "asc");
        const snap = await (after ? base.startAfter(after.at, after.id) : base).limit(limit).get();
        return snap.docs.map((d) => ({ id: d.id, submissionId: d.get("submissionId"), at: d.get("timestamp") }));
      },
      existingSubmissions: async (ids) => {
        const found = new Map<string, ExistingSubmission>();
        for (let i = 0; i < ids.length; i += 100) {
          const snaps = await firestore.getAll(...ids.slice(i, i + 100).map((id) => firestore.doc(`submissions/${id}`)));
          for (const s of snaps) {
            if (!s.exists) continue;
            const derivedPath = s.get("derivedPath");
            const look = s.get("needsStaffLook");
            found.set(s.id, {
              stripped: s.get("stripped") === true,
              derivedPath: typeof derivedPath === "string" ? derivedPath : null,
              needsStaffLook: look !== undefined && look !== null && look !== false && look !== "",
            });
          }
        }
        return found;
      },
      listGalleryObjects: async (limit, startAt) => {
        const [files] = await bucket.getFiles({
          prefix: "gallery/",
          maxResults: limit,
          autoPaginate: false,
          ...(startAt ? { startOffset: startAt } : {}),
        });
        return files.map((f) => ({
          name: f.name,
          generation: f.metadata?.generation === undefined || f.metadata?.generation === null ? null : String(f.metadata.generation),
          createdMs: Date.parse(String(f.metadata?.timeCreated ?? "")),
        }));
      },
      galleryState: async (ids) => {
        const found = new Map<string, GalleryState>();
        for (let i = 0; i < ids.length; i += 100) {
          const chunk = ids.slice(i, i + 100);
          // The submission rows FIRST, then the publicGallery docs (see retention.ts part 4).
          const rows = await firestore.getAll(...chunk.map((id) => firestore.doc(`submissions/${id}`)));
          const walls = await firestore.getAll(...chunk.map((id) => firestore.doc(`publicGallery/${id}`)));
          chunk.forEach((id, k) => {
            const claim = rows[k].exists ? rows[k].get("publishClaim") : undefined;
            const recorded = rows[k].exists ? rows[k].get("galleryGeneration") : undefined;
            found.set(id, {
              onWall: walls[k].exists,
              // A malformed claim counts as released (0), exactly as moderate.ts treats it.
              claimUntil: claim === undefined || claim === null ? null : (readPublishClaim(claim)?.until ?? 0),
              recorded: typeof recorded === "string" ? recorded : null,
            });
          });
        }
        return found;
      },
      releaseExpiredClaim: (id, nowMs) => releaseExpiredPublishClaim(db, ops, id, nowMs),
      revokeGalleryTokens: (name, generation) => storage.revokeTokens(name, generation),
      deleteObjectGeneration: (name, generation) => storage.removeObject(name, generation),
      listSubmissionObjects: async (limit, startAt) => {
        const [files] = await bucket.getFiles({
          prefix: "submissions/",
          maxResults: limit,
          autoPaginate: false,
          ...(startAt ? { startOffset: startAt } : {}),
        });
        return files.map((f) => ({ name: f.name, createdMs: Date.parse(String(f.metadata?.timeCreated ?? "")) }));
      },
      deleteObject: async (name) => {
        await bucket.file(name).delete({ ignoreNotFound: true });
      },
      loadState: async () => {
        const data = (await firestore.doc(RETENTION_STATE).get()).data() ?? {};
        const c = data.consentCursor as { at?: unknown; id?: unknown } | null | undefined;
        return {
          consentCursor: c && typeof c.id === "string" && c.at instanceof Timestamp ? { at: c.at, id: c.id } : null,
          storageCursor: typeof data.storageCursor === "string" ? data.storageCursor : null,
          galleryCursor: typeof data.galleryCursor === "string" ? data.galleryCursor : null,
        } satisfies RetentionState;
      },
      saveState: async (state) => {
        await firestore.doc(RETENTION_STATE).set({ ...state, updatedAt: FieldValue.serverTimestamp() });
      },
      record: async (summary) => {
        await firestore.collection("auditLogs").add({
          at: FieldValue.serverTimestamp(),
          actor: "system",
          action: "retention",
          target: "submissions",
          detail: summary,
        });
      },
      warn: (message, fields) => logger.warn(message, fields),
      clock: Date.now,
    },
    Date.now(),
  );
  logger.info("retention run", {
    deleted: result.deleted.length,
    orphanConsentsDeleted: result.orphanConsentsDeleted,
    orphanObjectsDeleted: result.orphanObjectsDeleted,
    leftoverUploadsDeleted: result.leftoverUploadsDeleted,
    galleryLeftoversDeleted: result.galleryLeftoversDeleted,
    failures: result.failures,
    rateLimitsDeleted: result.rateLimitsDeleted,
    stoppedEarly: result.stoppedEarly,
  });
});
