import { randomBytes, randomUUID } from "crypto";
import * as admin from "firebase-admin";
import { HttpsError, onCall } from "firebase-functions/v2/https";
import { onObjectFinalized } from "firebase-functions/v2/storage";
import { setGlobalOptions } from "firebase-functions/v2";
import { flagSubmission } from "./moderation";

setGlobalOptions({ region: "us-central1", maxInstances: 20 });

admin.initializeApp();
const db = admin.firestore();
const bucket = admin.storage().bucket();

const MAX = 15 * 1024 * 1024;
const ALLOWED = ["image/jpeg", "image/jpg", "image/png", "image/webp", "image/heic", "image/heif"];
const CONSENT_VERSION = "0.1-DRAFT-LEGAL-REVIEW";
const PUBLIC_STATUSES = new Set([
  "approved",
  "featured",
  "scheduled",
  "collectible_created",
  "available",
  "collected",
  "impact_funded",
  "impact_fulfilled",
]);
const STAFF_MODERATE = new Set(["ADMIN", "REVIEWER"]);
const STAFF_IMPACT = new Set(["ADMIN", "IMPACT_MANAGER"]);

function roleOf(auth: { token?: Record<string, unknown> } | undefined): string {
  const role = auth?.token?.role;
  return typeof role === "string" ? role : "";
}

function hexId(prefix: string, bytes = 16): string {
  return `${prefix}_${randomBytes(bytes).toString("hex")}`;
}

function emptyPerms() {
  return {
    store: false,
    displayPublic: false,
    social: false,
    reproduce: false,
    promotional: false,
    collectible: false,
    sellCollectible: false,
    showAttribution: false,
    showMessage: false,
  };
}

function sanitizePerms(raw: unknown) {
  const src = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const out = emptyPerms();
  for (const key of Object.keys(out) as (keyof typeof out)[]) {
    out[key] = Boolean(src[key]);
  }
  return out;
}

function sniff(buf: Buffer): boolean {
  if (buf.length < 12) return false;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return true;
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return true;
  if (buf.slice(0, 4).toString("ascii") === "RIFF" && buf.slice(8, 12).toString("ascii") === "WEBP") {
    return true;
  }
  if (buf.slice(4, 8).toString("ascii") === "ftyp") {
    const brand = buf.slice(8, 12).toString("ascii").toLowerCase();
    return ["heic", "heif", "mif1", "msf1", "heix"].includes(brand);
  }
  return false;
}

async function nextArtNumber(): Promise<string> {
  const counter = db.doc("counters/art");
  const n = await db.runTransaction(async (tx) => {
    const snap = await tx.get(counter);
    const next = (snap.data()?.n ?? 0) + 1;
    tx.set(counter, { n: next }, { merge: true });
    return next;
  });
  return `NBC-ART-${String(n).padStart(6, "0")}`;
}

async function signedPut(path: string, contentType: string): Promise<string> {
  const [url] = await bucket.file(path).getSignedUrl({
    version: "v4",
    action: "write",
    expires: Date.now() + 15 * 60 * 1000,
    contentType,
  });
  return url;
}

async function publicImageUrl(path: string): Promise<string> {
  const token = randomUUID();
  const file = bucket.file(path);
  await file.setMetadata({ metadata: { firebaseStorageDownloadTokens: token } });
  const encoded = encodeURIComponent(path);
  return `https://firebasestorage.googleapis.com/v0/b/${bucket.name}/o/${encoded}?alt=media&token=${token}`;
}

async function bumpPublicCounters() {
  const art = await db.doc("counters/art").get();
  const gallery = await db.collection("publicGallery").get();
  const names = new Set<string>();
  gallery.forEach((docSnap) => {
    const d = docSnap.data();
    names.add(String(d.attributionText || "anonymous").toLowerCase());
  });
  const impact = await db.collection("collectibles").get();
  let tents = 0;
  let bags = 0;
  let created = 0;
  impact.forEach((docSnap) => {
    const c = docSnap.data();
    if (c.status === "created" && c.impactVerified) created += 1;
    if (!c.impactVerified) return;
    if (c.impactStatus === "funded" || c.impactStatus === "purchased" || c.impactStatus === "distributed") {
      if (c.impactPackage === "A") {
        tents += 1;
        bags += 2;
      }
      if (c.impactPackage === "B") {
        tents += 1;
        bags += 6;
      }
    }
  });
  await db.doc("counters/public").set(
    {
      artworkSubmitted: art.data()?.n ?? 0,
      artistsParticipating: names.size,
      collectiblesCreated: created,
      tentsFunded: tents,
      sleepingBagsFunded: bags,
    },
    { merge: true },
  );
}

export const submitArtwork = onCall({ cors: true }, async (req) => {
  const permissions = sanitizePerms(req.data?.permissions);
  if (!permissions.store) {
    throw new HttpsError("failed-precondition", "We need permission to store the picture in order to receive it.");
  }
  const originalBytes = Number(req.data?.originalBytes ?? 0);
  if (!Number.isFinite(originalBytes) || originalBytes <= 0 || originalBytes > MAX) {
    throw new HttpsError("invalid-argument", "That picture is too large. Try one under 15 MB.");
  }
  const originalMime = String(req.data?.originalMime || "image/jpeg").toLowerCase();
  if (!ALLOWED.includes(originalMime)) {
    throw new HttpsError("invalid-argument", "Please send a photo (JPG, PNG, WEBP, or HEIC).");
  }
  const id = hexId("sub");
  const consentId = hexId("con");
  const number = await nextArtNumber();
  const originalPath = `submissions/${id}/original/upload`;
  const derivedPath = `submissions/${id}/derived/public.jpg`;
  const now = admin.firestore.FieldValue.serverTimestamp();
  const message = String(req.data?.message ?? "").slice(0, 2000);
  const attributionText = String(req.data?.attributionText ?? "").slice(0, 80);
  const organizationName = req.data?.organizationName ? String(req.data.organizationName).slice(0, 120) : null;
  const flags = flagSubmission(`${message} ${attributionText} ${organizationName ?? ""}`);

  await db.doc(`consents/${consentId}`).set({
    id: consentId,
    submissionId: id,
    documentVersion: CONSENT_VERSION,
    submitterRole: req.data?.submitterRole ?? "self",
    permissions,
    timestamp: now,
    userAgent: String(req.rawRequest?.headers?.["user-agent"] ?? "").slice(0, 300),
  });

  await db.doc(`submissions/${id}`).set({
    id,
    number,
    pageId: req.data?.pageId ?? null,
    status: "uploading",
    submitterRole: req.data?.submitterRole ?? "self",
    attributionKind: req.data?.attributionKind ?? "anonymous",
    attributionText,
    ageRange: req.data?.ageRange ?? null,
    organizationName,
    showOrganization: Boolean(req.data?.showOrganization),
    message,
    email: req.data?.email ? String(req.data.email).slice(0, 200) : null,
    groupId: req.data?.groupId ? String(req.data.groupId).slice(0, 64) : null,
    flags,
    consentId,
    createdAt: now,
    reviewedAt: null,
    reviewedBy: null,
    staffNote: null,
    originalName: String(req.data?.originalName ?? "").slice(0, 200),
    originalMime,
    originalBytes,
    originalPath,
    derivedPath,
    permissions,
  });

  await db.collection("auditLogs").add({
    at: now,
    actor: "public",
    action: "submit-start",
    target: id,
    detail: number,
  });

  const originalUploadUrl = await signedPut(originalPath, originalMime);
  const derivedUploadUrl = await signedPut(derivedPath, "image/jpeg");
  return {
    id,
    number,
    originalUploadUrl,
    derivedUploadUrl,
    originalContentType: originalMime,
  };
});

export const finalizeSubmission = onCall({ cors: true }, async (req) => {
  const id = String(req.data?.id ?? "");
  if (!id.startsWith("sub_")) throw new HttpsError("invalid-argument", "Missing submission.");
  const snap = await db.doc(`submissions/${id}`).get();
  if (!snap.exists) throw new HttpsError("not-found", "We could not find that upload.");
  const row = snap.data() ?? {};
  const originalPath = String(row.originalPath ?? "");
  const derivedPath = String(row.derivedPath ?? "");
  const [orig] = await bucket.file(originalPath).getMetadata().catch(() => [null]);
  const [derived] = await bucket.file(derivedPath).getMetadata().catch(() => [null]);
  if (!orig || !derived) {
    throw new HttpsError("failed-precondition", "Whoops. That picture didn’t make it through. Let’s try again.");
  }
  if (Number(orig.size ?? 0) > MAX) {
    await bucket.file(originalPath).delete().catch(() => undefined);
    throw new HttpsError("invalid-argument", "That picture is too large. Try one under 15 MB.");
  }
  const [head] = await bucket.file(originalPath).download({ start: 0, end: 31 });
  if (!sniff(Buffer.from(head))) {
    await bucket.file(originalPath).delete().catch(() => undefined);
    throw new HttpsError("invalid-argument", "Please send a photo (JPG, PNG, WEBP, or HEIC).");
  }
  await db.doc(`submissions/${id}`).update({ status: "submitted" });
  await db.collection("auditLogs").add({
    at: admin.firestore.FieldValue.serverTimestamp(),
    actor: "public",
    action: "submit",
    target: id,
    detail: row.number ?? "",
  });
  await bumpPublicCounters().catch(() => undefined);
  return { ok: true, id, number: row.number };
});

export const moderateSubmission = onCall({ cors: true }, async (req) => {
  const role = roleOf(req.auth);
  if (!STAFF_MODERATE.has(role)) throw new HttpsError("permission-denied", "Staff only.");
  const id = String(req.data?.id ?? "");
  const status = String(req.data?.status ?? "");
  const note = String(req.data?.note ?? "").slice(0, 2000);
  if (!id || !status) throw new HttpsError("invalid-argument", "id and status required");
  const ref = db.doc(`submissions/${id}`);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError("not-found", "Submission not found.");
  const row = snap.data() ?? {};
  await ref.update({
    status,
    reviewedAt: admin.firestore.FieldValue.serverTimestamp(),
    reviewedBy: req.auth?.uid ?? "",
    staffNote: note,
  });

  const displayPublic = Boolean(row.permissions?.displayPublic);
  const shouldPublish = PUBLIC_STATUSES.has(status) && displayPublic;
  if (shouldPublish) {
    const galleryPath = `gallery/${id}/public.jpg`;
    await bucket.file(String(row.derivedPath)).copy(bucket.file(galleryPath));
    const imageUrl = await publicImageUrl(galleryPath);
    const showAttribution = Boolean(row.permissions?.showAttribution);
    const showMessage = Boolean(row.permissions?.showMessage);
    await db.doc(`publicGallery/${id}`).set({
      id,
      number: row.number,
      pageId: row.pageId ?? null,
      status,
      public: true,
      attributionKind: showAttribution ? row.attributionKind : "anonymous",
      attributionText: showAttribution ? row.attributionText ?? "" : "",
      organizationName: row.showOrganization ? row.organizationName ?? null : null,
      showOrganization: Boolean(row.showOrganization),
      message: showMessage ? row.message ?? "" : "",
      permissions: {
        ...emptyPerms(),
        displayPublic: true,
        showAttribution,
        showMessage,
      },
      imageUrl,
      createdAt: row.createdAt ?? admin.firestore.FieldValue.serverTimestamp(),
      reviewedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  } else {
    await db.doc(`publicGallery/${id}`).delete().catch(() => undefined);
    await bucket
      .file(`gallery/${id}/public.jpg`)
      .delete()
      .catch(() => undefined);
  }

  await db.collection("auditLogs").add({
    at: admin.firestore.FieldValue.serverTimestamp(),
    actor: req.auth?.uid ?? "",
    action: `status:${status}`,
    target: id,
    detail: note,
  });
  await bumpPublicCounters().catch(() => undefined);
  return { ok: true };
});

export const createGroup = onCall({ cors: true }, async (req) => {
  const label = String(req.data?.label || "Art day").slice(0, 120);
  const id = hexId("grp");
  const publicId = randomBytes(6).toString("hex");
  const createdAt = new Date().toISOString();
  await db.doc(`groups/${id}`).set({
    id,
    publicId,
    label,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });
  return { id, publicId, label, createdAt };
});

export const getGroup = onCall({ cors: true }, async (req) => {
  const publicId = String(req.data?.publicId ?? "");
  if (!publicId) return null;
  const snap = await db.collection("groups").where("publicId", "==", publicId).limit(1).get();
  if (snap.empty) return null;
  const d = snap.docs[0].data();
  return { id: d.id, publicId: d.publicId, label: d.label, createdAt: new Date().toISOString() };
});

export const upsertCollectible = onCall({ cors: true }, async (req) => {
  const role = roleOf(req.auth);
  if (!STAFF_IMPACT.has(role)) throw new HttpsError("permission-denied", "Staff only.");
  const id = String(req.data?.id ?? hexId("col"));
  await db.doc(`collectibles/${id}`).set({ ...req.data, id }, { merge: true });
  await bumpPublicCounters().catch(() => undefined);
  return { ok: true, id };
});

export const onOriginalUploaded = onObjectFinalized({ region: "us-central1" }, async (event) => {
  const object = event.data;
  if (!object.name?.includes("/original/")) return;
  if ((object.size ? Number(object.size) : 0) > MAX) {
    await bucket.file(object.name).delete().catch(() => undefined);
  }
});
