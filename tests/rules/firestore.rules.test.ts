/**
 * Firestore security rules, exercised against the real emulator.
 * Run with `npm run test:rules` (never part of plain `npm test`).
 *
 * Every persona is tried against every collection: allowed reads must return
 * the seeded data, forbidden reads (get, list, filtered list, collection-group)
 * must be PERMISSION_DENIED, and every client write must be denied because
 * all mutations go through Cloud Functions.
 */
import { afterAll, beforeAll, describe, it } from "vitest";
import {
  assertFails,
  assertSucceeds,
  type RulesTestContext,
  type RulesTestEnvironment,
} from "@firebase/rules-unit-testing";
import {
  ADMIN_ONLY,
  CON,
  COL,
  EVERYONE,
  GRP,
  NOBODY,
  PERSONAS,
  QUEUE_STAFF,
  SUB,
  contextFor,
  startEnv,
  verdict,
  type Persona,
} from "./support";

type Db = ReturnType<RulesTestContext["firestore"]>;

const SEED: Record<string, Record<string, unknown>> = {
  [`publicGallery/${SUB}`]: {
    id: SUB,
    number: "NBC-ART-000001",
    status: "approved",
    public: true,
    attributionKind: "anonymous",
    attributionText: "",
    message: "",
    permissions: { displayPublic: true, showAttribution: false, showMessage: false },
    imageUrl: "https://example.invalid/gallery.jpg",
  },
  "counters/public": {
    artworkSubmitted: 1,
    artistsParticipating: 1,
    collectiblesCreated: 0,
    tentsFunded: 0,
    sleepingBagsFunded: 0,
  },
  "counters/art": { n: 1 },
  [`submissions/${SUB}`]: {
    id: SUB,
    number: "NBC-ART-000001",
    status: "submitted",
    submitterRole: "guardian",
    ageRange: "under_13",
    email: "parent@example.org",
    message: "hello",
    consentId: CON,
    flags: [],
  },
  [`submissions/${SUB}/private/notes`]: { note: "subcollection" },
  [`consents/${CON}`]: { id: CON, submissionId: SUB, documentVersion: "test", permissions: { store: true } },
  "auditLogs/log_1": { actor: "public", action: "submit", target: SUB, detail: "" },
  [`groups/${GRP}`]: { id: GRP, publicId: "a1b2c3d4e5f6", label: "Art day" },
  [`collectibles/${COL}`]: { id: COL, submissionId: SUB, status: "draft", impactVerified: false },
  "impactRecords/imp_1": { collectibleId: COL, package: "A", status: "funded", verified: true },
  "coloringPages/page-active": { title: "Active page", active: true },
  "coloringPages/page-draft": { title: "Draft page", active: false },
  "consentDocuments/v0-1": { status: "published", body: "published copy" },
  "consentDocuments/v0-2": { status: "draft", body: "draft copy" },
  "siteSettings/public": { headline: "Color For A Cause" },
  "rateLimits/ip_0123456789abcdef": { count: 3, expiresAt: new Date(Date.now() + 3_600_000) },
  "unlistedCollection/doc": { secret: true },
};

type Read = { what: string; run: (db: Db) => Promise<unknown>; allowed: readonly Persona[] };

// Allowed reads must return real seeded data, so a missing seed doc can never
// masquerade as a pass.
const get = (path: string) => async (db: Db) => {
  const snap = await db.doc(path).get();
  if (!snap.exists) throw new Error(`seed document ${path} is missing`);
  return snap;
};
const list = (col: string, field?: string, value?: unknown) => async (db: Db) => {
  const ref = db.collection(col);
  const snap = await (field ? ref.where(field, "==", value) : ref).get();
  if (snap.empty) throw new Error(`seed collection ${col} is empty`);
  return snap;
};
const group = (col: string) => (db: Db) => db.collectionGroup(col).get();

const MONEY_STAFF: readonly Persona[] = ["REVIEWER", "IMPACT_MANAGER", "ADMIN"];
const IMPACT_STAFF: readonly Persona[] = ["IMPACT_MANAGER", "ADMIN"];
const ART_STAFF: readonly Persona[] = ["ART_MANAGER", "ADMIN"];

const READS: Read[] = [
  // Public surfaces.
  { what: "get publicGallery doc", run: get(`publicGallery/${SUB}`), allowed: EVERYONE },
  { what: "list publicGallery (Art Wall)", run: list("publicGallery"), allowed: EVERYONE },
  { what: "get counters/public", run: get("counters/public"), allowed: EVERYONE },
  { what: "get counters/art", run: get("counters/art"), allowed: NOBODY },
  { what: "list counters", run: list("counters"), allowed: NOBODY },

  // Review queue.
  { what: "get submission", run: get(`submissions/${SUB}`), allowed: QUEUE_STAFF },
  { what: "list submissions", run: list("submissions"), allowed: QUEUE_STAFF },
  { what: "list submissions where status == submitted", run: list("submissions", "status", "submitted"), allowed: QUEUE_STAFF },
  { what: "get submission subcollection doc", run: get(`submissions/${SUB}/private/notes`), allowed: NOBODY },
  { what: "list submission subcollection", run: list(`submissions/${SUB}/private`), allowed: NOBODY },

  // ADMIN-only records.
  { what: "get consent", run: get(`consents/${CON}`), allowed: ADMIN_ONLY },
  { what: "list consents", run: list("consents"), allowed: ADMIN_ONLY },
  { what: "list consents where submissionId == sub", run: list("consents", "submissionId", SUB), allowed: ADMIN_ONLY },
  { what: "get audit log", run: get("auditLogs/log_1"), allowed: ADMIN_ONLY },
  { what: "list audit logs", run: list("auditLogs"), allowed: ADMIN_ONLY },

  // Groups: only via the getGroup callable.
  { what: "get group", run: get(`groups/${GRP}`), allowed: NOBODY },
  { what: "list groups", run: list("groups"), allowed: NOBODY },
  { what: "list groups where publicId == qr", run: list("groups", "publicId", "a1b2c3d4e5f6"), allowed: NOBODY },

  // Collectibles / impact.
  { what: "get collectible", run: get(`collectibles/${COL}`), allowed: MONEY_STAFF },
  { what: "list collectibles", run: list("collectibles"), allowed: MONEY_STAFF },
  { what: "get impact record", run: get("impactRecords/imp_1"), allowed: IMPACT_STAFF },
  { what: "list impact records", run: list("impactRecords"), allowed: IMPACT_STAFF },

  // Library and public copy.
  { what: "get active coloring page", run: get("coloringPages/page-active"), allowed: EVERYONE },
  { what: "get inactive coloring page", run: get("coloringPages/page-draft"), allowed: ART_STAFF },
  { what: "list coloring pages where active == true", run: list("coloringPages", "active", true), allowed: EVERYONE },
  { what: "list all coloring pages", run: list("coloringPages"), allowed: ART_STAFF },
  { what: "get published consent document", run: get("consentDocuments/v0-1"), allowed: EVERYONE },
  { what: "get draft consent document", run: get("consentDocuments/v0-2"), allowed: ADMIN_ONLY },
  { what: "list consent documents where status == published", run: list("consentDocuments", "status", "published"), allowed: EVERYONE },
  { what: "list all consent documents", run: list("consentDocuments"), allowed: ADMIN_ONLY },
  { what: "get site settings", run: get("siteSettings/public"), allowed: EVERYONE },
  { what: "list site settings", run: list("siteSettings"), allowed: EVERYONE },

  // Server-only.
  { what: "get rate limit", run: get("rateLimits/ip_0123456789abcdef"), allowed: NOBODY },
  { what: "list rate limits", run: list("rateLimits"), allowed: NOBODY },
  { what: "get unlisted collection doc", run: get("unlistedCollection/doc"), allowed: NOBODY },
  { what: "list unlisted collection", run: list("unlistedCollection"), allowed: NOBODY },

  // Collection-group queries are never allowed (no {path=**} read rules).
  ...[
    "submissions",
    "consents",
    "auditLogs",
    "groups",
    "collectibles",
    "impactRecords",
    "rateLimits",
    "publicGallery",
    "private",
  ].map((col): Read => ({ what: `collectionGroup(${col})`, run: group(col), allowed: NOBODY })),
];

/** [collection path, existing doc id] — every one must reject every client write. */
const WRITE_TARGETS: [string, string][] = [
  ["publicGallery", SUB],
  ["counters", "public"],
  ["counters", "art"],
  ["submissions", SUB],
  [`submissions/${SUB}/private`, "notes"],
  ["consents", CON],
  ["auditLogs", "log_1"],
  ["groups", GRP],
  ["collectibles", COL],
  ["impactRecords", "imp_1"],
  ["coloringPages", "page-active"],
  ["consentDocuments", "v0-1"],
  ["siteSettings", "public"],
  ["rateLimits", "ip_0123456789abcdef"],
  ["unlistedCollection", "doc"],
];

type Write = { what: string; run: (db: Db, persona: Persona) => Promise<unknown> };
const WRITES: Write[] = WRITE_TARGETS.flatMap(([col, id]): Write[] => [
  {
    what: `create ${col}/<new>`,
    run: (db, persona) => db.collection(col).doc(`client-${persona}`).set({ status: "approved", by: persona }),
  },
  {
    what: `update ${col}/${id}`,
    run: (db) => db.doc(`${col}/${id}`).update({ status: "approved", tampered: true }),
  },
  {
    what: `overwrite ${col}/${id}`,
    run: (db) => db.doc(`${col}/${id}`).set({ tampered: true }),
  },
  {
    what: `delete ${col}/${id}`,
    run: (db) => db.doc(`${col}/${id}`).delete(),
  },
]);

let env: RulesTestEnvironment;
const dbs = {} as Record<Persona, Db>;

beforeAll(async () => {
  env = await startEnv("firestore");
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    await Promise.all(Object.entries(SEED).map(([path, data]) => db.doc(path).set(data)));
  });
  // One Firestore instance per persona (useEmulator cannot run twice).
  for (const p of PERSONAS) dbs[p] = contextFor(env, p).firestore();
});

afterAll(async () => {
  if (!env) return;
  await env.clearFirestore();
  await env.cleanup();
});

describe("Firestore reads", () => {
  for (const r of READS) {
    describe(r.what, () => {
      for (const p of PERSONAS) {
        const ok = verdict(r.allowed, p);
        it(`${p}: ${ok ? "allowed" : "denied"}`, async () => {
          if (ok) await assertSucceeds(r.run(dbs[p]));
          else await assertFails(r.run(dbs[p]));
        });
      }
    });
  }
});

describe("Firestore client writes are denied everywhere", () => {
  for (const w of WRITES) {
    describe(w.what, () => {
      for (const p of PERSONAS) {
        it(`${p}: denied`, async () => {
          await assertFails(w.run(dbs[p], p));
        });
      }
    });
  }
});

describe("Firestore role claim is matched exactly", () => {
  const forged: [string, Record<string, unknown>][] = [
    ["lower-case admin", { role: "admin" }],
    ["role as a list", { role: ["ADMIN"] }],
    ["padded role", { role: " ADMIN" }],
    ["admin flag instead of role", { admin: true }],
  ];
  for (const [label, claims] of forged) {
    it(`${label}: cannot read submissions, consents or audit logs`, async () => {
      const db = env.authenticatedContext(`forged-${label.replace(/\s+/g, "-")}`, claims).firestore();
      await assertFails(db.doc(`submissions/${SUB}`).get());
      await assertFails(db.collection("submissions").get());
      await assertFails(db.doc(`consents/${CON}`).get());
      await assertFails(db.collection("auditLogs").get());
    });
  }
});
