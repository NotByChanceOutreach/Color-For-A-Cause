/**
 * Production backend: Firestore + Storage + callable Functions.
 * Public visitors never write Firestore; originals are not publicly readable.
 */
import { initializeApp } from "firebase/app";
import { ReCaptchaEnterpriseProvider, initializeAppCheck } from "firebase/app-check";
import {
  signInWithEmailAndPassword,
  signOut,
  onAuthStateChanged,
  getAuth,
  type Auth,
  type User,
} from "firebase/auth";
import {
  collection,
  doc,
  getDoc,
  getDocs,
  getFirestore,
  type Firestore,
} from "firebase/firestore";
import { getFunctions, httpsCallable, type Functions } from "firebase/functions";
import { getDownloadURL, getStorage, ref, type FirebaseStorage } from "firebase/storage";
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

export const firebaseReady = Boolean(import.meta.env.VITE_FIREBASE_API_KEY);

const STAFF_ROLES: StaffRole[] = ["ADMIN", "REVIEWER", "ART_MANAGER", "IMPACT_MANAGER"];

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
  auth = getAuth(app);
  db = getFirestore(app);
  functions = getFunctions(app, "us-central1");
  storage = getStorage(app);
  const siteKey = import.meta.env.VITE_FIREBASE_APPCHECK_SITE_KEY;
  if (siteKey) {
    initializeAppCheck(app, {
      provider: new ReCaptchaEnterpriseProvider(siteKey),
      isTokenAutoRefreshEnabled: true,
    });
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

function whoops(err: unknown, fallback: string) {
  const code = err && typeof err === "object" && "code" in err ? String((err as { code: string }).code) : "";
  const msg = err instanceof Error ? err.message : "";
  if (/failed-precondition/i.test(code) || /store the picture|storage permission/i.test(msg)) {
    return new Error("We need permission to store the picture in order to receive it.");
  }
  if (/invalid-argument/i.test(code) && msg) return new Error(msg.replace(/^Firebase:\s*/i, "").replace(/\s*\([^)]*\)\.?$/, "").trim() || fallback);
  return new Error(fallback);
}

function dataUrlToBlob(dataUrl: string): Blob {
  const [head, data] = dataUrl.split(",");
  const mime = /data:([^;]+)/.exec(head)?.[1] || "image/jpeg";
  const bin = atob(data);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

async function putSigned(url: string, body: Blob, contentType: string) {
  const res = await fetch(url, { method: "PUT", headers: { "Content-Type": contentType }, body });
  if (!res.ok) throw new Error("Whoops. That picture didn’t make it through. Let’s try again.");
}

async function hydrateStaff(row: Record<string, unknown>, id: string): Promise<Submission> {
  let imageDataUrl = String(row.imageUrl ?? "");
  if (!imageDataUrl && storage && typeof row.derivedPath === "string") {
    try {
      imageDataUrl = await getDownloadURL(ref(storage, row.derivedPath));
    } catch {
      imageDataUrl = "";
    }
  }
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
    imageDataUrl,
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
    if (!input.permissions.store) {
      throw new Error("We need permission to store the picture in order to receive it.");
    }
    try {
      const start = httpsCallable(needFn(), "submitArtwork");
      const started = await start({
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
        originalMime: input.file.type || "image/jpeg",
        originalBytes: input.file.size,
        originalName: input.file.name,
      });
      const data = started.data as {
        id: string;
        number: string;
        originalUploadUrl: string;
        derivedUploadUrl: string;
        originalContentType: string;
      };
      await putSigned(data.originalUploadUrl, input.file, data.originalContentType);
      await putSigned(data.derivedUploadUrl, dataUrlToBlob(input.derivedDataUrl), "image/jpeg");
      const finish = httpsCallable(needFn(), "finalizeSubmission");
      await finish({ id: data.id });
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
        email: input.email,
        groupId: input.groupId,
        flags: [],
        consentId: "",
        createdAt: new Date().toISOString(),
        reviewedAt: null,
        reviewedBy: null,
        staffNote: null,
        imageDataUrl: input.derivedDataUrl,
        originalName: input.file.name,
        originalMime: input.file.type,
        originalBytes: input.file.size,
        permissions: input.permissions,
      };
      remember(sub);
      return sub;
    } catch (err) {
      throw whoops(err, "Whoops. That picture didn’t make it through. Let’s try again.");
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
    if (staffCache) {
      const snap = await getDoc(doc(db, "submissions", id));
      if (snap.exists()) return hydrateStaff(snap.data() as Record<string, unknown>, id);
    }
    return null;
  },

  async listGallery(): Promise<Submission[]> {
    if (!db) return [];
    const snap = await getDocs(collection(db, "publicGallery"));
    return snap.docs
      .map((d) => asPublic(d.id, d.data() as Record<string, unknown>))
      .filter((s) => isPublicOnWall(s))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  },

  async listAllSubmissions(): Promise<Submission[]> {
    if (!db || !staffCache) return [];
    const snap = await getDocs(collection(db, "submissions"));
    const rows = await Promise.all(
      snap.docs
        .filter((d) => d.data().status !== "uploading")
        .map((d) => hydrateStaff(d.data() as Record<string, unknown>, d.id)),
    );
    return rows.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  },

  async moderate(actor: string, id: string, status: Submission["status"], note?: string) {
    void actor;
    const fn = httpsCallable(needFn(), "moderateSubmission");
    await fn({ id, status, note: note ?? "" });
    const next = await this.getSubmission(id);
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

  async audits() {
    if (!db || !staffCache) return [];
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
  },

  async createGroup(label: string): Promise<Group> {
    const fn = httpsCallable(needFn(), "createGroup");
    const res = await fn({ label: label || "Art day" });
    return res.data as Group;
  },

  async getGroupByPublicId(publicId: string) {
    const fn = httpsCallable(needFn(), "getGroup");
    const res = await fn({ publicId });
    return (res.data as Group | null) ?? null;
  },

  async listGroups() {
    if (!db || !staffCache) return [];
    const snap = await getDocs(collection(db, "groups"));
    return snap.docs.map((d) => {
      const row = d.data() as Record<string, unknown>;
      const g: Group = {
        id: d.id,
        publicId: String(row.publicId ?? ""),
        label: String(row.label ?? ""),
        createdAt: stamp(row.createdAt),
      };
      return g;
    });
  },

  async listCollectibles() {
    if (!db || !staffCache) return [];
    const snap = await getDocs(collection(db, "collectibles"));
    return snap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<Collectible, "id">) }));
  },

  async upsertCollectible(c: Collectible) {
    const fn = httpsCallable(needFn(), "upsertCollectible");
    await fn(c);
    return c;
  },
};
