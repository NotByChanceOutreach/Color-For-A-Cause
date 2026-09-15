import { CONSENT_VERSION } from "../data/consent";
import { PAGES } from "../data/pages";
import type {
  AuditLog,
  Collectible,
  ConsentRecord,
  Group,
  PublicCounters,
  StaffRole,
  Submission,
  SubmitInput,
} from "../types";
import { isPublicOnWall } from "../types";
import { formatArtNumber, randomId } from "./ids";
import { flagSubmission } from "./moderation";
import { displayName } from "./files";

const DB = "nbc-color-for-a-cause";
const VER = 1;

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, VER);
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const name of ["submissions", "consents", "audits", "groups", "collectibles", "meta"]) {
        if (!db.objectStoreNames.contains(name)) db.createObjectStore(name, { keyPath: "id" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function all<T>(store: string): Promise<T[]> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, "readonly");
    const req = tx.objectStore(store).getAll();
    req.onsuccess = () => resolve(req.result as T[]);
    req.onerror = () => reject(req.error);
  });
}

async function put(store: string, value: unknown) {
  const db = await openDb();
  return new Promise<void>((resolve, reject) => {
    const tx = db.transaction(store, "readwrite");
    tx.objectStore(store).put(value);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function get<T>(store: string, id: string): Promise<T | undefined> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, "readonly");
    const req = tx.objectStore(store).get(id);
    req.onsuccess = () => resolve(req.result as T | undefined);
    req.onerror = () => reject(req.error);
  });
}

async function nextNumber(): Promise<number> {
  const meta = (await get<{ id: string; n: number }>("meta", "counter")) ?? { id: "counter", n: 0 };
  meta.n += 1;
  await put("meta", meta);
  return meta.n;
}

async function audit(actor: string, action: string, target: string, detail: string) {
  const row: AuditLog = {
    id: randomId("log"),
    at: new Date().toISOString(),
    actor,
    action,
    target,
    detail,
  };
  await put("audits", row);
}

export const demoApi = {
  mode: "demo" as const,

  async listPages() {
    return PAGES.filter((p) => p.active);
  },

  async getPage(slug: string) {
    return PAGES.find((p) => p.slug === slug && p.active) ?? null;
  },

  async submit(input: SubmitInput): Promise<Submission> {
    if (!input.permissions.store) {
      throw new Error("We need permission to store the picture in order to receive it.");
    }
    const n = await nextNumber();
    const id = randomId("sub");
    const consentId = randomId("con");
    const flags = flagSubmission(`${input.message} ${input.attributionText} ${input.organizationName ?? ""}`);
    const consent: ConsentRecord = {
      id: consentId,
      submissionId: id,
      documentVersion: CONSENT_VERSION,
      submitterRole: input.submitterRole,
      permissions: input.permissions,
      timestamp: new Date().toISOString(),
      userAgent: navigator.userAgent,
    };
    const sub: Submission = {
      id,
      number: formatArtNumber(n),
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
      flags,
      consentId,
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
    await put("consents", consent);
    await put("submissions", sub);
    await audit("public", "submit", id, sub.number);
    return sub;
  },

  async getSubmission(id: string) {
    return (await get<Submission>("submissions", id)) ?? null;
  },

  async waitForStaff() {
    return;
  },

  async listGallery(): Promise<Submission[]> {
    const rows = await all<Submission>("submissions");
    return rows
      .filter((s) => isPublicOnWall(s))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  },

  async listAllSubmissions(): Promise<Submission[]> {
    const rows = await all<Submission>("submissions");
    return rows.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  },

  async moderate(
    actor: string,
    id: string,
    status: Submission["status"],
    note?: string,
  ) {
    const row = await get<Submission>("submissions", id);
    if (!row) throw new Error("Submission not found.");
    row.status = status;
    row.reviewedAt = new Date().toISOString();
    row.reviewedBy = actor;
    if (note !== undefined) row.staffNote = note;
    await put("submissions", row);
    await audit(actor, `status:${status}`, id, note ?? "");
    return row;
  },

  async counters(): Promise<PublicCounters> {
    const subs = await all<Submission>("submissions");
    const cols = await all<Collectible>("collectibles");
    const publicArt = subs.filter((s) => isPublicOnWall(s));
    const names = new Set(
      publicArt.map((s) => displayName(s.attributionKind, s.attributionText).toLowerCase()),
    );
    let tents = 0;
    let bags = 0;
    for (const c of cols) {
      if (!c.impactVerified) continue;
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
    }
    return {
      artworkSubmitted: subs.length,
      artistsParticipating: names.size,
      collectiblesCreated: cols.filter((c) => c.status === "created" && c.impactVerified).length,
      tentsFunded: tents,
      sleepingBagsFunded: bags,
    };
  },

  async login(email: string, password: string): Promise<{ email: string; role: StaffRole }> {
    if (import.meta.env.PROD) {
      throw new Error("Staff sign-in is not available until Not By Chance accounts are connected.");
    }
    const expectEmail = import.meta.env.VITE_DEMO_STAFF_EMAIL || "staff@localhost";
    const expectPass = import.meta.env.VITE_DEMO_STAFF_PASSWORD || "local-dev-only";
    if (email.trim() !== expectEmail || password !== expectPass) {
      throw new Error("That staff sign-in did not match.");
    }
    sessionStorage.setItem("nbc-staff", JSON.stringify({ email, role: "ADMIN" }));
    await audit(email, "login", "staff", "demo");
    return { email, role: "ADMIN" };
  },

  currentStaff(): { email: string; role: StaffRole } | null {
    const raw = sessionStorage.getItem("nbc-staff");
    if (!raw) return null;
    try {
      return JSON.parse(raw) as { email: string; role: StaffRole };
    } catch {
      return null;
    }
  },

  logout() {
    sessionStorage.removeItem("nbc-staff");
  },

  async audits() {
    const rows = await all<AuditLog>("audits");
    return rows.sort((a, b) => b.at.localeCompare(a.at));
  },

  async createGroup(label: string): Promise<Group> {
    const g: Group = {
      id: randomId("grp"),
      publicId: randomId("g").replace("g_", "").slice(0, 12),
      label: label || "Art day",
      createdAt: new Date().toISOString(),
    };
    await put("groups", g);
    return g;
  },

  async getGroupByPublicId(publicId: string) {
    const rows = await all<Group>("groups");
    return rows.find((g) => g.publicId === publicId) ?? null;
  },

  async listGroups() {
    return all<Group>("groups");
  },

  async listCollectibles() {
    return all<Collectible>("collectibles");
  },

  async upsertCollectible(c: Collectible) {
    await put("collectibles", c);
    await audit("staff", "collectible", c.id, c.status);
    return c;
  },
};
