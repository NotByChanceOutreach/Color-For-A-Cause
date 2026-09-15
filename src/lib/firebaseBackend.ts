/**
 * Production backend: Firestore + Storage + callable Functions.
 * Public visitors never write Firestore or Storage rules-side: every write is a callable, and the one
 * upload is a short-lived signed PUT for the original. The server makes the public image (EXIF/GPS removed).
 * Staff never write Firestore directly either: moderation and collectibles go through callables.
 */
import { initializeApp } from "firebase/app";
import { ReCaptchaEnterpriseProvider, initializeAppCheck } from "firebase/app-check";
import {
  browserLocalPersistence,
  indexedDBLocalPersistence,
  initializeAuth,
  onAuthStateChanged,
  signInWithEmailAndPassword,
  signOut,
  type Auth,
  type User,
} from "firebase/auth";
import { collection, doc, getDoc, getDocs, getFirestore, type Firestore } from "firebase/firestore";
import { getFunctions, httpsCallableFromURL, type Functions } from "firebase/functions";
import { getBlob, getMetadata, getStorage, ref, type FirebaseStorage } from "firebase/storage";
import type {
  AuditLog,
  Collectible,
  Group,
  PublicCounters,
  StaffRole,
  Submission,
  SubmitInput,
} from "../types";
import { isPublicOnWall } from "../types";
import { collectiblePayload } from "./collectibles";
import { uploadContentType } from "./files";
import { pollFinalize } from "./finalizeRetry";
import { ServerRefusal, explainServerError } from "./refusals";
import { RoleCannotSeeError, asStaffReadError, isPermissionDenied } from "./staffErrors";

export const firebaseReady = Boolean(import.meta.env.VITE_FIREBASE_API_KEY);

const STAFF_ROLES: StaffRole[] = ["ADMIN", "REVIEWER", "ART_MANAGER", "IMPACT_MANAGER"];
const TRY_AGAIN = "Whoops. That picture didn’t make it through. Let’s try again.";
const STORE_REQUIRED = "We need permission to store the picture in order to receive it.";
const PHOTO_TYPES = "Please send a photo (JPG, PNG, or WEBP).";
/** Rows staff never see: the upload never finished or was refused by the server check. */
const NOT_FOR_REVIEW = new Set(["uploading", "rejected_upload"]);

let auth: Auth | null = null;
let db: Firestore | null = null;
let functions: Functions | null = null;
let storage: FirebaseStorage | null = null;
let staffCache: { email: string; role: StaffRole } | null = null;
let resolveReady: () => void = () => undefined;
const staffReady = new Promise<void>((r) => {
  resolveReady = r;
});

if (firebaseReady) {
  const app = initializeApp({
    apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
    authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
    projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
    storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
    messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
    appId: import.meta.env.VITE_FIREBASE_APP_ID,
  });
  // Staff sign in with email + password only. No popup/redirect resolver means no Google auth
  // iframe or gapi script is loaded on public pages (keeps the Content-Security-Policy tight).
  auth = initializeAuth(app, { persistence: [indexedDBLocalPersistence, browserLocalPersistence] });
  db = getFirestore(app);
  functions = getFunctions(app, "us-central1");
  storage = getStorage(app);
  const siteKey = import.meta.env.VITE_FIREBASE_APPCHECK_SITE_KEY;
  if (siteKey) {
    try {
      initializeAppCheck(app, {
        provider: new ReCaptchaEnterpriseProvider(siteKey),
        isTokenAutoRefreshEnabled: true,
      });
    } catch {
      /* Already initialized (hot reload). Every callable enforces App Check. */
    }
  }
  onAuthStateChanged(auth, (user) => {
    void applyUser(user).finally(() => resolveReady());
  });
} else {
  resolveReady();
}

async function applyUser(user: User | null) {
  if (!user) {
    staffCache = null;
    return;
  }
  const tok = await user.getIdTokenResult();
  const role = tok.claims.role;
  if (typeof role === "string" && (STAFF_ROLES as string[]).includes(role)) {
    staffCache = { email: user.email || user.uid, role: role as StaffRole };
  } else {
    staffCache = null;
  }
}

function needFn(): Functions {
  if (!functions) throw new Error("Firebase is not configured.");
  return functions;
}

const CALL_TIMEOUT_MS = 45_000;

/** Reject instead of waiting forever (if reCAPTCHA is blocked, App Check never answers). */
function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("We could not reach Not By Chance just now. Please try again in a moment.")),
      ms,
    );
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

/**
 * Callables go through the same-origin Hosting rewrite (/c/<name>).
 * submitArtwork and createGroup send limited-use App Check tokens: the server consumes each one and refuses a
 * token that was already used, so every call here asks App Check for a fresh one.
 */
function callable(name: string, limitedUseAppCheckTokens = false, timeoutMs = CALL_TIMEOUT_MS) {
  const origin =
    typeof window !== "undefined" && window.location?.origin
      ? window.location.origin
      : "https://notbychance-color-for-a-cause.web.app";
  const fn = httpsCallableFromURL(needFn(), `${origin}/c/${name}`, { limitedUseAppCheckTokens, timeout: timeoutMs });
  return (data?: unknown) => withTimeout(fn(data), timeoutMs + 5_000);
}

function cacheKey(id: string) {
  return `nbc-sub-${id}`;
}

function remember(sub: Submission) {
  try {
    sessionStorage.setItem(cacheKey(sub.id), JSON.stringify(sub));
  } catch {
    /* private mode / quota */
  }
}

function recall(id: string): Submission | null {
  try {
    const raw = sessionStorage.getItem(cacheKey(id));
    return raw ? (JSON.parse(raw) as Submission) : null;
  } catch {
    return null;
  }
}

function stamp(value: unknown): string {
  if (!value) return new Date().toISOString();
  if (typeof value === "string") return value;
  if (typeof value === "object" && value && "toDate" in value && typeof (value as { toDate: () => Date }).toDate === "function") {
    return (value as { toDate: () => Date }).toDate().toISOString();
  }
  return new Date().toISOString();
}

function asPublic(id: string, data: Record<string, unknown>): Submission {
  const permissions = (data.permissions as Submission["permissions"]) ?? {
    store: false,
    displayPublic: true,
    social: false,
    reproduce: false,
    promotional: false,
    collectible: false,
    sellCollectible: false,
    showAttribution: Boolean(data.showAttribution),
    showMessage: Boolean(data.showMessage),
  };
  return {
    id,
    number: String(data.number ?? ""),
    pageId: (data.pageId as string | null) ?? null,
    status: data.status as Submission["status"],
    submitterRole: "self",
    attributionKind: (data.attributionKind as Submission["attributionKind"]) ?? "anonymous",
    attributionText: String(data.attributionText ?? ""),
    ageRange: null,
    organizationName: (data.organizationName as string | null) ?? null,
    showOrganization: Boolean(data.showOrganization),
    message: permissions.showMessage ? String(data.message ?? "") : "",
    email: null,
    groupId: null,
    flags: [],
    consentId: "",
    createdAt: stamp(data.createdAt),
    reviewedAt: data.reviewedAt ? stamp(data.reviewedAt) : null,
    reviewedBy: null,
    staffNote: null,
    imageDataUrl: String(data.imageUrl ?? data.imageDataUrl ?? ""),
    originalName: "",
    originalMime: "image/jpeg",
    originalBytes: 0,
    permissions,
  };
}

const PUBLIC_MESSAGES = /(invalid-argument|failed-precondition|resource-exhausted)$/;
const STAFF_MESSAGES = /(invalid-argument|failed-precondition|resource-exhausted|permission-denied|aborted|not-found)$/;

/** Server messages for these codes are written for people; everything else gets the fallback (./refusals.ts). */
const friendly = explainServerError;

/** PUT with exactly the headers the URL was signed for (Content-Type + size range). */
async function putSigned(url: string, body: Blob, headers: Record<string, string>) {
  const res = await fetch(url, { method: "PUT", headers, body });
  if (!res.ok) throw new Error(TRY_AGAIN);
}

type StartResponse = {
  id: string;
  number: string;
  uploadUrl: string;
  uploadHeaders: Record<string, string>;
  finalizeToken: string;
};

const FINALIZE_ATTEMPTS = 20;
const FINALIZE_DELAY_MS = 1500;

/**
 * finalizeSubmission is idempotent. While the server is still making the public image it answers
 * "processing" and remembers the request; the server finishes the hand-off by itself, so after
 * ~30 seconds we stop waiting and let the artist go. A call lost in transport is simply asked
 * again (./finalizeRetry.ts), so a dropped answer does not turn an accepted upload into an error.
 */
async function finalizeWithPatience(id: string, finalizeToken: string): Promise<"submitted" | "processing"> {
  const finish = callable("finalizeSubmission");
  return pollFinalize(() => finish({ id, finalizeToken }), { attempts: FINALIZE_ATTEMPTS, delayMs: FINALIZE_DELAY_MS });
}

/** The server-made image, fetched with the reviewer's own credentials, plus the generation they saw. */
async function loadDerivative(path: unknown): Promise<{ url: string; generation: string | null }> {
  if (!storage || typeof path !== "string" || !path) return { url: "", generation: null };
  try {
    const r = ref(storage, path);
    const meta = await getMetadata(r);
    const blob = await getBlob(r);
    return { url: URL.createObjectURL(blob), generation: meta.generation || null };
  } catch {
    return { url: "", generation: null };
  }
}

function hydrateStaff(
  row: Record<string, unknown>,
  id: string,
  image: { url: string; generation: string | null } = { url: "", generation: null },
): Submission {
  return {
    id,
    number: String(row.number ?? ""),
    pageId: (row.pageId as string | null) ?? null,
    status: row.status as Submission["status"],
    submitterRole: (row.submitterRole as Submission["submitterRole"]) ?? "self",
    attributionKind: (row.attributionKind as Submission["attributionKind"]) ?? "anonymous",
    attributionText: String(row.attributionText ?? ""),
    ageRange: (row.ageRange as Submission["ageRange"]) ?? null,
    organizationName: (row.organizationName as string | null) ?? null,
    showOrganization: Boolean(row.showOrganization),
    message: String(row.message ?? ""),
    email: (row.email as string | null) ?? null,
    groupId: (row.groupId as string | null) ?? null,
    flags: Array.isArray(row.flags) ? (row.flags as string[]) : [],
    consentId: String(row.consentId ?? ""),
    createdAt: stamp(row.createdAt),
    reviewedAt: row.reviewedAt ? stamp(row.reviewedAt) : null,
    reviewedBy: (row.reviewedBy as string | null) ?? null,
    staffNote: (row.staffNote as string | null) ?? null,
    imageDataUrl: image.url,
    derivedGeneration: image.generation,
    stripped: row.stripped === true,
    originalName: String(row.originalName ?? ""),
    originalMime: String(row.originalMime ?? ""),
    originalBytes: Number(row.originalBytes ?? 0),
    permissions: row.permissions as Submission["permissions"],
  };
}

const emptyCounters = (): PublicCounters => ({
  artworkSubmitted: 0,
  artistsParticipating: 0,
  collectiblesCreated: 0,
  tentsFunded: 0,
  sleepingBagsFunded: 0,
});

export const firebaseApi = {
  mode: "firebase" as const,

  async waitForStaff() {
    await staffReady;
  },

  async listPages() {
    const { PAGES } = await import("../data/pages");
    return PAGES.filter((p) => p.active);
  },

  async getPage(slug: string) {
    const { PAGES } = await import("../data/pages");
    return PAGES.find((p) => p.slug === slug && p.active) ?? null;
  },

  async submit(input: SubmitInput): Promise<Submission> {
    // A refusal of this one piece (like the server's failed-precondition), so a group batch flags it and goes on.
    if (!input.permissions.store) throw new ServerRefusal("failed-precondition", STORE_REQUIRED);
    const contentType = uploadContentType(input.file);
    if (!contentType) throw new Error(PHOTO_TYPES);
    try {
      const started = await callable("submitArtwork", true)({
        pageId: input.pageId,
        submitterRole: input.submitterRole,
        attributionKind: input.attributionKind,
        attributionText: input.attributionText,
        ageRange: input.ageRange,
        organizationName: input.organizationName,
        showOrganization: input.showOrganization,
        message: input.message,
        email: input.email,
        groupId: input.groupId,
        permissions: input.permissions,
        originalMime: contentType,
        originalBytes: input.file.size,
        rotate: input.rotate,
        cropPct: input.cropPct,
        guardianConsentAttested: input.guardianConsentAttested,
      });
      const data = started.data as StartResponse;
      await putSigned(data.uploadUrl, input.file, data.uploadHeaders);
      await finalizeWithPatience(data.id, data.finalizeToken);
      const sub: Submission = {
        id: data.id,
        number: data.number,
        pageId: input.pageId,
        status: "submitted",
        submitterRole: input.submitterRole,
        attributionKind: input.attributionKind,
        attributionText: input.attributionText,
        ageRange: input.ageRange,
        organizationName: input.organizationName,
        showOrganization: input.showOrganization,
        message: input.message,
        email: null,
        groupId: input.groupId,
        flags: [],
        consentId: "",
        createdAt: new Date().toISOString(),
        reviewedAt: null,
        reviewedBy: null,
        staffNote: null,
        imageDataUrl: input.previewDataUrl,
        originalName: "",
        originalMime: contentType,
        originalBytes: input.file.size,
        permissions: input.permissions,
      };
      remember(sub);
      return sub;
    } catch (err) {
      // A refusal keeps its code: the forms flag the one piece the server refused (GroupSubmit.tsx, Submit.tsx).
      throw friendly(err, TRY_AGAIN, PUBLIC_MESSAGES, true);
    }
  },

  async getSubmission(id: string) {
    const cached = recall(id);
    if (cached) return cached;
    if (!db) return null;
    const pub = await getDoc(doc(db, "publicGallery", id));
    if (pub.exists()) {
      const mapped = asPublic(id, pub.data() as Record<string, unknown>);
      if (isPublicOnWall(mapped)) return mapped;
    }
    if (staffCache) return this.getStaffSubmission(id).catch(() => null);
    return null;
  },

  /**
   * The full staff view, straight from the submission record (never the public projection).
   * Throws RoleCannotSeeError when the signed-in role may not read submissions; other failures give null.
   */
  async getStaffSubmission(id: string): Promise<Submission | null> {
    if (!db || !staffCache) return null;
    let row: Record<string, unknown>;
    try {
      const snap = await getDoc(doc(db, "submissions", id));
      if (!snap.exists()) return null;
      row = snap.data() as Record<string, unknown>;
    } catch (err) {
      if (isPermissionDenied(err)) throw new RoleCannotSeeError();
      return null;
    }
    return hydrateStaff(row, id, await loadDerivative(row.derivedPath));
  },

  async listGallery(): Promise<Submission[]> {
    if (!db) return [];
    const snap = await getDocs(collection(db, "publicGallery"));
    return snap.docs
      .map((d) => asPublic(d.id, d.data() as Record<string, unknown>))
      .filter((s) => isPublicOnWall(s))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  },

  /** Throws RoleCannotSeeError when the role may not read submissions (IMPACT_MANAGER). */
  async listAllSubmissions(): Promise<Submission[]> {
    if (!db || !staffCache) return [];
    try {
      const snap = await getDocs(collection(db, "submissions"));
      return snap.docs
        .filter((d) => !NOT_FOR_REVIEW.has(String(d.data().status)))
        .map((d) => hydrateStaff(d.data() as Record<string, unknown>, d.id))
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    } catch (err) {
      throw asStaffReadError(err);
    }
  },

  async moderate(
    actor: string,
    id: string,
    status: Submission["status"],
    note?: string,
    derivedGeneration?: string | null,
  ) {
    void actor;
    try {
      await callable("moderateSubmission")({
        id,
        status,
        note: note ?? "",
        derivedGeneration: derivedGeneration ?? null,
      });
    } catch (err) {
      throw friendly(err, "That change did not save. Please try again.", STAFF_MESSAGES);
    }
    const next = await this.getStaffSubmission(id);
    if (!next) throw new Error("Submission not found.");
    return next;
  },

  async counters(): Promise<PublicCounters> {
    if (!db) return emptyCounters();
    const snap = await getDoc(doc(db, "counters", "public"));
    if (!snap.exists()) return emptyCounters();
    const d = snap.data() as Partial<PublicCounters>;
    return { ...emptyCounters(), ...d };
  },

  async login(email: string, password: string): Promise<{ email: string; role: StaffRole }> {
    if (!auth) throw new Error("Staff sign-in is not connected.");
    const cred = await signInWithEmailAndPassword(auth, email.trim(), password);
    const tok = await cred.user.getIdTokenResult(true);
    const role = tok.claims.role;
    if (typeof role !== "string" || !(STAFF_ROLES as string[]).includes(role)) {
      await signOut(auth);
      staffCache = null;
      throw new Error("This account is not authorized for staff tools.");
    }
    staffCache = { email: cred.user.email || email, role: role as StaffRole };
    return staffCache;
  },

  currentStaff(): { email: string; role: StaffRole } | null {
    return staffCache;
  },

  logout() {
    staffCache = null;
    if (auth) void signOut(auth);
  },

  /** Admin only (rules deny everyone else, so other roles get RoleCannotSeeError without a request). */
  async audits() {
    if (!db) return [];
    if (staffCache?.role !== "ADMIN") throw new RoleCannotSeeError();
    try {
      const snap = await getDocs(collection(db, "auditLogs"));
      return snap.docs
        .map((d) => {
          const row = d.data() as Record<string, unknown>;
          const item: AuditLog = {
            id: d.id,
            at: stamp(row.at),
            actor: String(row.actor ?? ""),
            action: String(row.action ?? ""),
            target: String(row.target ?? ""),
            detail: String(row.detail ?? ""),
          };
          return item;
        })
        .sort((a, b) => b.at.localeCompare(a.at));
    } catch (err) {
      throw asStaffReadError(err);
    }
  },

  async createGroup(label: string): Promise<Group> {
    try {
      // Short timeout: the pack and batch pages fall back to printing/sending without a group code.
      const res = await callable("createGroup", true, 10_000)({ label: label || "Art day" });
      return res.data as Group;
    } catch (err) {
      throw friendly(err, "We could not start a group right now. Please try again.", PUBLIC_MESSAGES);
    }
  },

  async getGroupByPublicId(publicId: string) {
    const res = await callable("getGroup")({ publicId });
    return (res.data as Group | null) ?? null;
  },

  /** Throws RoleCannotSeeError when the role may not read collectibles (ART_MANAGER). */
  async listCollectibles() {
    if (!db || !staffCache) return [];
    try {
      const snap = await getDocs(collection(db, "collectibles"));
      return snap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<Collectible, "id">) }));
    } catch (err) {
      throw asStaffReadError(err);
    }
  },

  async upsertCollectible(c: Collectible) {
    try {
      // Only the allowlisted fields: rows read back also carry server fields the callable rejects.
      await callable("upsertCollectible")(collectiblePayload(c));
    } catch (err) {
      throw friendly(err, "That change did not save. Please try again.", STAFF_MESSAGES);
    }
    return c;
  },
};
