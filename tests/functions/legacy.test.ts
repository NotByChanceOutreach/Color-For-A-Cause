import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { paths } from "../../functions/src/constants";
import type { ProcessOptions } from "../../functions/src/image";
import {
  CONSENT_MISSING,
  FRAMING_UNKNOWN,
  LEGACY_USAGE,
  parseLegacyArgs,
  reprocessLegacySubmission,
  runLegacyReprocess,
  type LegacyDeps,
} from "../../functions/src/legacy";
import { moderateSubmission } from "../../functions/src/moderate";
import { FakeBucket, FakeDb, JPEG_BYTES, NOW, beforeTransaction, fakeOps, loseCommitAnswer, moderateDeps } from "./fixtures";

const ID = `sub_${"a".repeat(32)}`;
const OTHER = `sub_${"b".repeat(32)}`;
const CON = `con_${"c".repeat(32)}`;
const DAY = 24 * 60 * 60 * 1000;
const V2 = paths.derivedV2(ID);
const OLD = paths.derived(ID);

/** Bytes that sniff as JPEG, each recognisable, so the tests can tell which image a result was made from. */
const UPLOAD = Buffer.concat([JPEG_BYTES, Buffer.from("original upload, with GPS")]);
const BROWSER_MADE = Buffer.concat([JPEG_BYTES, Buffer.from("browser-made, turned and cropped by the artist")]);

type Call = { input: string; opts: ProcessOptions };

/** A stand-in for processImage that labels its output with what it was made from and records every call. */
function labellingProcess(calls: Call[], failOn: string | null = null) {
  return async (input: Buffer, opts: ProcessOptions) => {
    const label = input.equals(UPLOAD) ? "upload" : input.equals(BROWSER_MADE) ? "browser-made" : "other";
    calls.push({ input: label, opts });
    if (label === failOn) throw new Error("Input buffer contains unsupported image format");
    return {
      stripped: { data: Buffer.from(`stripped-of:${label}`), width: 40, height: 30 },
      derived: { data: Buffer.from(`public-of:${label}`), width: 20, height: 15 },
    };
  };
}

const PERMISSIONS = {
  store: true,
  displayPublic: true,
  social: true,
  reproduce: false,
  promotional: false,
  collectible: false,
  sellCollectible: false,
  showAttribution: true,
  showMessage: true,
};

/** A row as the old two-upload flow (9b2fc57) stored it: no stripped, no generations, raw email and file name. */
function legacyRow(overrides: Record<string, unknown> = {}) {
  return {
    id: ID,
    number: "NBC-ART-000007",
    status: "submitted",
    submitterRole: "self",
    attributionKind: "firstName",
    attributionText: "Sky",
    ageRange: null,
    organizationName: "Troop 5",
    showOrganization: true,
    message: "hi mom",
    email: "kid@example.com",
    permissions: { ...PERMISSIONS },
    consentId: CON,
    flags: [],
    originalName: "Emma Smith age 7.jpg",
    originalMime: "image/jpeg",
    originalPath: paths.upload(ID),
    derivedPath: OLD,
    createdAt: new Date(NOW - 30 * DAY),
    ...overrides,
  };
}

/** The old consent record: role, permissions and userAgent. */
function legacyConsent(overrides: Record<string, unknown> = {}) {
  return {
    id: CON,
    submissionId: ID,
    documentVersion: "0.1-DRAFT-LEGAL-REVIEW",
    submitterRole: "self",
    permissions: { ...PERMISSIONS },
    timestamp: new Date(NOW - 30 * DAY),
    userAgent: "Mozilla/5.0",
    ...overrides,
  };
}

function world(opts: { row?: Record<string, unknown>; consent?: Record<string, unknown> | null; upload?: Buffer; browserMade?: Buffer | null } = {}) {
  const db = new FakeDb();
  const bucket = new FakeBucket();
  db.patch(`submissions/${ID}`, opts.row ?? legacyRow());
  if (opts.consent !== null) db.patch(`consents/${CON}`, opts.consent ?? legacyConsent());
  bucket.put(paths.upload(ID), opts.upload ?? UPLOAD);
  const browserMade = opts.browserMade === null ? null : bucket.put(OLD, opts.browserMade ?? BROWSER_MADE);
  const calls: Call[] = [];
  const deps: LegacyDeps = {
    db,
    ops: fakeOps,
    now: () => NOW,
    runToken: "run-1",
    download: bucket.download,
    save: bucket.create,
    generationOf: bucket.generationOf,
    remove: bucket.remove,
    process: labellingProcess(calls),
    // The query on consents where submissionId == the id, as scripts/reprocess-legacy.mjs runs it.
    consentIdsFor: async (submissionId) =>
      [...db.docs.entries()]
        .filter(([p, d]) => p.startsWith("consents/") && p.split("/").length === 2 && d.submissionId === submissionId)
        .map(([p]) => p.split("/")[1]),
  };
  return { db, bucket, deps, browserMade, calls };
}

const row = (db: FakeDb) => db.data(`submissions/${ID}`)!;

describe("G legacy reprocess: the artist's turn and crop are kept (round 3, item 1)", () => {
  it("the public image is made from the browser-made derivative with no turn and no crop; stripped.jpg from the original", async () => {
    const { db, bucket, deps, calls } = world();
    const res = await reprocessLegacySubmission(deps, ID, { write: true });
    expect(res.outcome).toBe("reprocessed");
    expect(calls).toEqual([
      { input: "upload", opts: { rotate: 0, cropPct: 0 } },
      { input: "browser-made", opts: { rotate: 0, cropPct: 0 } },
    ]);
    expect(bucket.objects.get(V2)?.data.toString()).toBe("public-of:browser-made");
    expect(bucket.objects.get(paths.stripped(ID))?.data.toString()).toBe("stripped-of:upload");
    expect(row(db)).toMatchObject({
      status: "submitted",
      stripped: true,
      derivedPath: V2,
      derivedGeneration: bucket.objects.get(V2)?.generation,
      derivedMd5: bucket.objects.get(V2)?.md5,
      strippedGeneration: bucket.objects.get(paths.stripped(ID))?.generation,
      originalPath: paths.stripped(ID),
      width: 20,
      height: 15,
    });
    expect(row(db)).not.toHaveProperty("needsStaffLook");
    expect(row(db)).not.toHaveProperty("processingLease");
    expect(row(db)).not.toHaveProperty("legacyLeftovers");
    // Both old files went after the commit: the browser-made derivative and the upload.
    expect(bucket.has(OLD)).toBe(false);
    expect(bucket.has(paths.upload(ID))).toBe(false);
    expect(db.collection("auditLogs").some((a) => a.action === "legacy-reprocess" && a.target === ID)).toBe(true);
  });

  it.each([
    ["missing", null, null],
    ["not an image", Buffer.from("<html>not a picture</html>"), null],
    ["unreadable by sharp", BROWSER_MADE, "browser-made"],
  ] as const)("old derivative %s: the public image comes from the original, and the row is flagged for a person", async (_what, browserMade, failOn) => {
    const { db, bucket, deps, calls } = world({ browserMade });
    const res = await reprocessLegacySubmission({ ...deps, process: labellingProcess(calls, failOn) }, ID, { write: true });
    expect(res.outcome).toBe("reprocessed");
    expect(res.notes).toEqual(expect.arrayContaining(["public-from=original", "framing=unknown"]));
    expect(bucket.objects.get(V2)?.data.toString()).toBe("public-of:upload");
    expect(row(db)).toMatchObject({ needsStaffLook: FRAMING_UNKNOWN, derivedPath: V2 });
    expect(row(db).flags).toContain(FRAMING_UNKNOWN);
    expect(db.collection("auditLogs").find((a) => a.action === "legacy-reprocess")?.detail).toBe(FRAMING_UNKNOWN);
  });

  it("afterwards staff can publish it, and the Art Wall gets the image with the artist's framing", async () => {
    const { db, bucket, deps } = world({ row: legacyRow({ ageRange: "18_plus" }) });
    await reprocessLegacySubmission(deps, ID, { write: true });
    const generation = String(row(db).derivedGeneration);
    await moderateSubmission(moderateDeps(db, bucket), { uid: "staff", role: "ADMIN" }, { id: ID, status: "approved", derivedGeneration: generation });
    expect(bucket.objects.get(paths.gallery(ID))?.data.toString()).toBe("public-of:browser-made");
    expect(db.data(`publicGallery/${ID}`)?.imageUrl).toBe(bucket.liveUrl(paths.gallery(ID)));
  });
});

describe("G legacy reprocess: the old image is never deleted before the new state is committed (item 2)", () => {
  it("derived/public.jpg is deleted only by its exact generation, and only once the row points at public-v2.jpg", async () => {
    const { db, bucket, deps, browserMade } = world();
    const deletes: Array<{ path: string; generation?: string; derivedPath: unknown }> = [];
    const watched: LegacyDeps = {
      ...deps,
      remove: async (path, generation) => {
        deletes.push({ path, generation, derivedPath: row(db).derivedPath });
        await bucket.remove(path, generation);
      },
    };
    expect((await reprocessLegacySubmission(watched, ID, { write: true })).outcome).toBe("reprocessed");
    const old = deletes.filter((d) => d.path === OLD);
    expect(old).toEqual([{ path: OLD, generation: browserMade!.generation, derivedPath: V2 }]);
  });

  it("the row moves on while the images are made: 'changed', the row keeps its old image, only this run's files go", async () => {
    const { db, bucket, deps, browserMade, calls } = world();
    const process = labellingProcess(calls);
    const moving: LegacyDeps = {
      ...deps,
      process: async (input, opts) => {
        if (input.equals(BROWSER_MADE)) db.patch(`submissions/${ID}`, { status: "archived" });
        return process(input, opts);
      },
    };
    expect((await reprocessLegacySubmission(moving, ID, { write: true })).outcome).toBe("changed");
    expect(row(db)).toMatchObject({ status: "archived", derivedPath: OLD });
    expect(bucket.objects.get(OLD)?.generation).toBe(browserMade!.generation);
    expect(bucket.has(V2)).toBe(false);
    expect(bucket.has(paths.stripped(ID))).toBe(false);
    expect(bucket.has(paths.upload(ID))).toBe(true);
  });

  it("the row is archived after the new images were saved, just before the commit: the same, nothing lost", async () => {
    const { db, bucket, deps, browserMade } = world();
    beforeTransaction(db, 2, async () => db.patch(`submissions/${ID}`, { status: "archived" })); // 1 = lease, 2 = commit
    expect((await reprocessLegacySubmission(deps, ID, { write: true })).outcome).toBe("changed");
    expect(row(db).derivedPath).toBe(OLD);
    expect(bucket.objects.get(OLD)?.generation).toBe(browserMade!.generation);
    expect(bucket.has(V2)).toBe(false);
    expect(row(db)).not.toHaveProperty("stripped", true);
  });

  it("a 503 while saving public-v2.jpg: the row still shows its old image, the lease is released, and a rerun completes", async () => {
    const { db, bucket, deps, browserMade } = world();
    const flaky: LegacyDeps = {
      ...deps,
      save: async (path, data) => {
        if (path === V2) throw Object.assign(new Error("503 Service Unavailable"), { code: 503 });
        return bucket.create(path, data);
      },
    };
    await expect(reprocessLegacySubmission(flaky, ID, { write: true })).rejects.toThrow(/503/);
    expect(row(db).derivedPath).toBe(OLD);
    expect(bucket.objects.get(OLD)?.generation).toBe(browserMade!.generation);
    expect(row(db)).not.toHaveProperty("processingLease");
    expect(bucket.has(paths.upload(ID))).toBe(true);

    expect((await reprocessLegacySubmission({ ...deps, runToken: "run-2" }, ID, { write: true })).outcome).toBe("reprocessed");
    expect(row(db)).toMatchObject({ derivedPath: V2, strippedGeneration: bucket.objects.get(paths.stripped(ID))?.generation });
    expect(bucket.has(OLD)).toBe(false);
  });

  it("a delete that fails after the commit leaves legacyLeftovers; a later run finishes the cleanup", async () => {
    const { db, bucket, deps, browserMade } = world();
    let failed = false;
    const flaky: LegacyDeps = {
      ...deps,
      remove: async (path, generation) => {
        if (path === OLD && !failed) {
          failed = true;
          throw new Error("503 Service Unavailable");
        }
        await bucket.remove(path, generation);
      },
    };
    expect((await reprocessLegacySubmission(flaky, ID, { write: true })).outcome).toBe("reprocessed-cleanup-pending");
    expect(row(db)).toMatchObject({ stripped: true, derivedPath: V2, legacyLeftovers: { derived: browserMade!.generation } });
    expect(bucket.has(V2)).toBe(true);

    expect((await reprocessLegacySubmission(deps, ID, { write: false })).outcome).toBe("would-clean-up");
    expect((await reprocessLegacySubmission(deps, ID, { write: true })).outcome).toBe("cleaned-up");
    expect(bucket.has(OLD)).toBe(false);
    expect(bucket.has(paths.upload(ID))).toBe(false);
    expect(row(db)).not.toHaveProperty("legacyLeftovers");
    expect((await reprocessLegacySubmission(deps, ID, { write: true })).outcome).toBe("not-legacy");
  });

  it("a commit whose answer was lost is still 'reprocessed', with its images intact", async () => {
    const { db, bucket, deps } = world();
    loseCommitAnswer(db, 2); // 1 = lease, 2 = commit
    expect((await reprocessLegacySubmission(deps, ID, { write: true })).outcome).toBe("reprocessed");
    expect(row(db).derivedGeneration).toBe(bucket.objects.get(V2)?.generation);
  });
});

describe("G legacy reprocess: what the old flow left behind (item 3)", () => {
  it.each([
    ["image/jpeg", "artwork.jpg"],
    ["image/png", "artwork.png"],
    [undefined, "artwork.jpg"],
  ])("the stored file name becomes generic (%s)", async (mime, name) => {
    const { db, deps } = world({ row: legacyRow({ originalMime: mime }) });
    await reprocessLegacySubmission(deps, ID, { write: true });
    expect(row(db).originalName).toBe(name);
  });

  it("an unknown age is locked private with no email, and its consent record is narrowed the same way", async () => {
    const { db, deps } = world({ consent: legacyConsent({ email: "kid@example.com" }) });
    const res = await reprocessLegacySubmission(deps, ID, { write: true });
    expect(res.notes).toEqual(expect.arrayContaining(["protections=locked", "consent=narrowed"]));
    expect(row(db)).toMatchObject({ email: null, showOrganization: false, minorProtectionsApplied: true });
    expect(row(db).permissions).toMatchObject({ store: true, displayPublic: false, social: false, showAttribution: false, showMessage: false });
    const consent = db.data(`consents/${CON}`)!;
    expect(consent.permissions).toEqual({ ...PERMISSIONS, displayPublic: false, social: false, showAttribution: false, showMessage: false });
    expect(consent).toMatchObject({ email: null, minorProtectionsApplied: true, protectionsAppliedBy: "legacy-reprocess", permissionsAsSubmitted: PERMISSIONS });
  });

  it("never widens the consent record, and narrows the row to it: a permission the record did not give goes off on the row", async () => {
    const narrower = { ...PERMISSIONS, social: false, showMessage: false };
    const { db, deps } = world({
      row: legacyRow({ ageRange: "18_plus" }),
      consent: legacyConsent({ permissions: narrower, email: "kid@example.com" }),
    });
    const res = await reprocessLegacySubmission(deps, ID, { write: true });
    expect(res.notes).toEqual(expect.arrayContaining(["protections=kept", "row=narrowed-to-consent", "consent=unchanged"]));
    expect(db.data(`consents/${CON}`)).toEqual(legacyConsent({ permissions: narrower, email: "kid@example.com" }));
    expect(row(db)).toMatchObject({ email: "kid@example.com", minorProtectionsApplied: false });
    expect(row(db).permissions).toEqual(narrower);
  });

  it("a row wider than its consent is narrowed to it, so staff cannot publish what the record never allowed (round 4, E)", async () => {
    const { db, bucket, deps } = world({
      row: legacyRow({ ageRange: "18_plus" }),
      consent: legacyConsent({ permissions: { ...PERMISSIONS, displayPublic: false, showAttribution: false }, email: "kid@example.com" }),
    });
    const dry = await reprocessLegacySubmission(deps, ID, { write: false });
    expect(dry.notes).toEqual(expect.arrayContaining(["protections=kept", "row=narrowed-to-consent", "consent=unchanged"]));
    await reprocessLegacySubmission(deps, ID, { write: true });
    expect(row(db).permissions).toEqual({ ...PERMISSIONS, displayPublic: false, showAttribution: false });
    expect(db.data(`consents/${CON}`)?.permissions).toEqual({ ...PERMISSIONS, displayPublic: false, showAttribution: false });
    const generation = String(row(db).derivedGeneration);
    await moderateSubmission(moderateDeps(db, bucket), { uid: "staff", role: "ADMIN" }, { id: ID, status: "approved", derivedGeneration: generation });
    expect(row(db).status).toBe("approved");
    expect(db.data(`publicGallery/${ID}`)).toBeUndefined();
    expect(bucket.has(paths.gallery(ID))).toBe(false);
  });

  it("both ways at once: the row is narrowed to the record and the record to the row (never widened)", async () => {
    const { db, deps } = world({
      row: legacyRow({ ageRange: "18_plus", permissions: { ...PERMISSIONS, social: false } }),
      consent: legacyConsent({ permissions: { ...PERMISSIONS, displayPublic: false } }),
    });
    await reprocessLegacySubmission(deps, ID, { write: true });
    const both = { ...PERMISSIONS, social: false, displayPublic: false };
    expect(row(db).permissions).toEqual(both);
    expect(db.data(`consents/${CON}`)?.permissions).toEqual(both);
    expect(db.data(`consents/${CON}`)?.permissionsAsSubmitted).toEqual({ ...PERMISSIONS, displayPublic: false });
  });

  it("the row loses its email when its consent record holds none (the row never says more than the record)", async () => {
    const { db, deps } = world({ row: legacyRow({ ageRange: "18_plus" }) });
    const res = await reprocessLegacySubmission(deps, ID, { write: true });
    expect(res.notes).toContain("row=narrowed-to-consent");
    expect(row(db)).toMatchObject({ email: null, showOrganization: true, minorProtectionsApplied: false });
    expect(row(db).permissions).toMatchObject({ displayPublic: true, showAttribution: true });
  });

  it("a consent record of another submission is not touched, and with no record of its own the row is locked (fails closed)", async () => {
    const other = world({ row: legacyRow({ ageRange: "18_plus" }), consent: legacyConsent({ submissionId: OTHER }) });
    const res = await reprocessLegacySubmission(other.deps, ID, { write: true });
    expect(res.outcome).toBe("reprocessed-locked-no-consent");
    expect(res.notes).toContain("consent=missing");
    expect(other.db.data(`consents/${CON}`)).toEqual(legacyConsent({ submissionId: OTHER }));
    expect(row(other.db).permissions).toEqual({ ...LOCKED, store: true });
  });
});

/** Every permission off: what a locked row keeps is only `store`. */
const LOCKED = Object.fromEntries(Object.keys(PERMISSIONS).map((k) => [k, false])) as Record<keyof typeof PERMISSIONS, boolean>;
const REAL = `con_${"d".repeat(32)}`;
const PRIVATE = { ...LOCKED, store: true };

/** Approve with the generation the reviewer saw; true when the piece ended up on the Art Wall. */
async function publishes(db: FakeDb, bucket: FakeBucket): Promise<boolean> {
  const generation = String(row(db).derivedGeneration);
  await moderateSubmission(moderateDeps(db, bucket), { uid: "staff", role: "ADMIN" }, { id: ID, status: "approved", derivedGeneration: generation });
  return db.data(`publicGallery/${ID}`) !== undefined || bucket.has(paths.gallery(ID));
}

describe("round 5, A: the legacy consent lookup fails closed", () => {
  /** An adult row with every public choice on, and the real record (its submissionId is this row) saying private. */
  function adultWithRealPrivateRecord(consentId: unknown) {
    const w = world({ row: legacyRow({ ageRange: "18_plus", consentId }), consent: null });
    w.db.patch(`consents/${REAL}`, legacyConsent({ id: REAL, permissions: PRIVATE }));
    return w;
  }

  it.each([
    ["P1: consentId names a record that does not exist", `con_${"e".repeat(32)}`],
    ["P3: consentId is empty (malformed)", ""],
    ["consentId is not a string", 42],
    ["consentId has a bad shape", "../consents/x"],
  ])("%s: the real record is found by its submissionId and decides; nothing is published", async (_what, consentId) => {
    const { db, bucket, deps } = adultWithRealPrivateRecord(consentId);
    const dry = await reprocessLegacySubmission(deps, ID, { write: false });
    expect(dry.notes).toEqual(expect.arrayContaining(["row=narrowed-to-consent", "consent=unchanged"]));
    expect(dry.notes).not.toContain("consent=missing");
    const res = await reprocessLegacySubmission(deps, ID, { write: true });
    expect(res.outcome).toBe("reprocessed");
    expect(row(db).permissions).toEqual(PRIVATE);
    expect(row(db)).not.toHaveProperty("needsStaffLook");
    expect(await publishes(db, bucket)).toBe(false);
  });

  it("P1b: consentId points at another submission's wide record: that one is ignored (and untouched); the real private one decides", async () => {
    const { db, bucket, deps } = adultWithRealPrivateRecord(CON);
    db.patch(`consents/${CON}`, legacyConsent({ submissionId: OTHER, permissions: { ...PERMISSIONS } }));
    const res = await reprocessLegacySubmission(deps, ID, { write: true });
    expect(res.outcome).toBe("reprocessed");
    expect(row(db).permissions).toEqual(PRIVATE);
    expect(db.data(`consents/${CON}`)).toEqual(legacyConsent({ submissionId: OTHER, permissions: { ...PERMISSIONS } }));
    expect(await publishes(db, bucket)).toBe(false);
  });

  it.each([
    ["P2: the record was deleted", { consentId: CON }, null],
    ["consentId points at another submission's record and none names this one", { consentId: CON }, { submissionId: OTHER }],
    ["no consentId and no record", { consentId: null }, null],
  ] as const)("%s: locked private, flagged for a person, reported as locked; nothing is published", async (_what, fields, consent) => {
    const { db, bucket, deps, browserMade } = world({
      row: legacyRow({ ageRange: "18_plus", ...fields }),
      consent: consent === null ? null : legacyConsent(consent),
    });
    const dry = await reprocessLegacySubmission(deps, ID, { write: false });
    expect(dry.outcome).toBe("would-reprocess");
    expect(dry.notes.join(" ")).toContain("protections=locked consent=missing will-lock");

    const res = await reprocessLegacySubmission(deps, ID, { write: true });
    expect(res.outcome).toBe("reprocessed-locked-no-consent");
    expect(res.notes).toEqual(expect.arrayContaining(["protections=locked", "consent=missing"]));
    expect(row(db)).toMatchObject({
      permissions: PRIVATE,
      showOrganization: false,
      email: null,
      minorProtectionsApplied: true,
      needsStaffLook: CONSENT_MISSING,
      stripped: true,
    });
    expect(row(db).flags).toContain(CONSENT_MISSING);
    expect(db.collection("auditLogs").find((a) => a.action === "legacy-reprocess")?.detail).toBe(CONSENT_MISSING);
    // The framing was known, so the old derivative was used and is cleaned up as usual.
    expect(bucket.has(OLD)).toBe(false);
    expect(browserMade).not.toBeNull();
    expect(await publishes(db, bucket)).toBe(false);
  });

  it("a locked row that also lost its framing carries both flags; the consent look comes first", async () => {
    const { db, deps } = world({ row: legacyRow({ ageRange: "18_plus" }), consent: null, browserMade: null });
    expect((await reprocessLegacySubmission(deps, ID, { write: true })).outcome).toBe("reprocessed-locked-no-consent");
    expect(row(db).needsStaffLook).toBe(CONSENT_MISSING);
    expect(row(db).flags).toEqual(expect.arrayContaining([CONSENT_MISSING, FRAMING_UNKNOWN]));
  });

  it("a delete that fails after a locked commit still says locked, with cleanup=pending", async () => {
    const { db, bucket, deps } = world({ row: legacyRow({ ageRange: "18_plus" }), consent: null });
    const flaky: LegacyDeps = {
      ...deps,
      remove: async (path, generation) => {
        if (path === paths.upload(ID)) throw new Error("503 Service Unavailable");
        await bucket.remove(path, generation);
      },
    };
    const res = await reprocessLegacySubmission(flaky, ID, { write: true });
    expect(res.outcome).toBe("reprocessed-locked-no-consent");
    expect(res.notes).toContain("cleanup=pending");
    expect(row(db).legacyLeftovers).toBeDefined();
  });

  it("the record decides the lock too: the row says guardian, its record says self (unknown age) -> locked (P4)", async () => {
    const { db, bucket, deps } = world({ row: legacyRow({ submitterRole: "guardian", ageRange: null }), consent: legacyConsent({ submitterRole: "self" }) });
    const dry = await reprocessLegacySubmission(deps, ID, { write: false });
    expect(dry.notes).toEqual(expect.arrayContaining(["protections=locked", "row=narrowed-to-consent"]));
    await reprocessLegacySubmission(deps, ID, { write: true });
    expect(row(db)).toMatchObject({ minorProtectionsApplied: true, email: null, showOrganization: false });
    expect(row(db).permissions).toEqual({ ...PERMISSIONS, ...LOCKED, store: true });
    expect(await publishes(db, bucket)).toBe(false);
  });

  it.each([
    ["the record says the artist is under 13", { ageRange: "under_13" }],
    ["the record says the age is unknown", { ageRange: "prefer_not" }],
    ["the record says protections were applied", { minorProtectionsApplied: true }],
    ["the record names another role", { submitterRole: "organization" }],
    ["the record names no valid role", { submitterRole: "robot" }],
  ])("%s: an 18+ row follows it and is locked", async (_what, fields) => {
    const { db, bucket, deps } = world({ row: legacyRow({ ageRange: "18_plus" }), consent: legacyConsent(fields) });
    await reprocessLegacySubmission(deps, ID, { write: true });
    expect(row(db).minorProtectionsApplied).toBe(true);
    expect(row(db).permissions).toMatchObject({ displayPublic: false, showAttribution: false, social: false });
    expect(await publishes(db, bucket)).toBe(false);
  });

  it("the record's public choices off: the row follows, even for an adult whose choices stand", async () => {
    const { db, bucket, deps } = world({
      row: legacyRow({ ageRange: "18_plus" }),
      consent: legacyConsent({ permissions: { ...PERMISSIONS, displayPublic: false } }),
    });
    await reprocessLegacySubmission(deps, ID, { write: true });
    expect(row(db)).toMatchObject({ minorProtectionsApplied: false });
    expect(row(db).permissions).toMatchObject({ displayPublic: false, showAttribution: true });
    expect(await publishes(db, bucket)).toBe(false);
  });

  it("legitimate flows still work: an adult's matching record (18+ in the record too) is published; a guardian's for a child too", async () => {
    for (const [fields, record] of [
      [{ ageRange: "18_plus" }, { ageRange: "18_plus" }],
      [{ submitterRole: "guardian", ageRange: "under_13" }, { submitterRole: "guardian" }],
      [{ submitterRole: "organization", ageRange: "13_17", guardianConsentAttested: true }, { submitterRole: "organization" }],
    ] as const) {
      const { db, bucket, deps } = world({ row: legacyRow(fields), consent: legacyConsent(record) });
      expect((await reprocessLegacySubmission(deps, ID, { write: true })).outcome).toBe("reprocessed");
      expect(row(db).minorProtectionsApplied).toBe(false);
      expect(await publishes(db, bucket)).toBe(true);
    }
  });

  it("a record that stops naming this submission between the lookup and the commit counts as missing: locked", async () => {
    const { db, deps } = world({ row: legacyRow({ ageRange: "18_plus" }) });
    beforeTransaction(db, 2, async () => db.patch(`consents/${CON}`, { submissionId: OTHER })); // 1 = lease, 2 = commit
    expect((await reprocessLegacySubmission(deps, ID, { write: true })).outcome).toBe("reprocessed-locked-no-consent");
    expect(row(db).permissions).toEqual(PRIVATE);
  });
});

describe("round 5, B: the old derivative is kept when it was not used", () => {
  it.each([
    ["not an image", Buffer.from("<html>not a picture</html>"), null],
    ["unreadable by sharp", BROWSER_MADE, "browser-made"],
  ] as const)("old derivative %s: not recorded as a leftover and not deleted; the dry run says public-from=original", async (_what, browserMade, failOn) => {
    const { db, bucket, deps, calls, browserMade: old } = world({ browserMade });
    const process = labellingProcess(calls, failOn);
    const dry = await reprocessLegacySubmission({ ...deps, process }, ID, { write: false });
    expect(dry.notes).toEqual(expect.arrayContaining(["public-from=original", "framing=unknown"]));
    expect(dry.notes).not.toContain("public-from=old-derivative");

    const res = await reprocessLegacySubmission({ ...deps, process }, ID, { write: true });
    expect(res.outcome).toBe("reprocessed");
    expect(row(db)).toMatchObject({ needsStaffLook: FRAMING_UNKNOWN, derivedPath: V2 });
    expect(row(db)).not.toHaveProperty("legacyLeftovers");
    expect(bucket.objects.get(OLD)?.generation).toBe(old!.generation); // kept for the person who looks
    expect(bucket.has(paths.upload(ID))).toBe(false); // the upload (with GPS) still goes
  });

  it("a usable old derivative is recorded, used and deleted; the dry run says so because it will be", async () => {
    const { db, bucket, deps, browserMade } = world();
    const deletes: Array<{ path: string; generation?: string }> = [];
    const dry = await reprocessLegacySubmission(deps, ID, { write: false });
    expect(dry.notes).toContain("public-from=old-derivative");
    await reprocessLegacySubmission({ ...deps, remove: async (p, g) => (deletes.push({ path: p, generation: g }), bucket.remove(p, g)) }, ID, {
      write: true,
    });
    expect(deletes).toContainEqual({ path: OLD, generation: browserMade!.generation });
    expect(bucket.objects.get(V2)?.data.toString()).toBe("public-of:browser-made");
    expect(row(db)).not.toHaveProperty("needsStaffLook");
  });
});

describe("G legacy reprocess: adults and guardians keep their choices", () => {

  it.each([
    ["an adult", { ageRange: "18_plus" }],
    ["a guardian", { submitterRole: "guardian", ageRange: "under_13" }],
  ])("%s keeps their choices, and their email when the consent record holds one", async (_name, fields) => {
    // The record names the same role as the row (as 9b2fc57 wrote it); a different role would lock the row.
    const role = "submitterRole" in fields ? fields.submitterRole : "self";
    const { db, deps } = world({ row: legacyRow(fields), consent: legacyConsent({ email: "kid@example.com", submitterRole: role }) });
    await reprocessLegacySubmission(deps, ID, { write: true });
    expect(row(db)).toMatchObject({ email: "kid@example.com", showOrganization: true, minorProtectionsApplied: false });
    expect(row(db).permissions).toMatchObject({ displayPublic: true, showAttribution: true });
  });

  it("an organization with a known minor and no confirmation is locked (never refused)", async () => {
    const { db, deps } = world({ row: legacyRow({ submitterRole: "organization", ageRange: "13_17" }) });
    expect((await reprocessLegacySubmission(deps, ID, { write: true })).outcome).toBe("reprocessed");
    expect(row(db).permissions).toMatchObject({ displayPublic: false });
  });
});

describe("G legacy reprocess: dry run and refusals", () => {
  it("dry run (the default) lists what would happen and changes nothing", async () => {
    const { db, bucket, deps } = world();
    const before = { db: db.snapshot(), objects: [...bucket.objects.keys()].sort() };
    expect(await reprocessLegacySubmission(deps, ID, { write: false })).toEqual({
      outcome: "would-reprocess",
      notes: ["public-from=old-derivative", "protections=locked", "consent=narrowed", "original-name=generic"],
    });
    expect(db.snapshot()).toBe(before.db);
    expect([...bucket.objects.keys()].sort()).toEqual(before.objects);
  });

  it("dry run without the old derivative says the framing is unknown", async () => {
    const { deps } = world({ row: legacyRow({ ageRange: "18_plus" }), browserMade: null });
    expect(await reprocessLegacySubmission(deps, ID, { write: false })).toEqual({
      outcome: "would-reprocess",
      notes: ["public-from=original", "framing=unknown", "protections=kept", "row=narrowed-to-consent", "consent=unchanged", "original-name=generic"],
    });
  });

  it("dry run with no consent record prints consent=missing will-lock (and the adult row shows as locked)", async () => {
    const { db, bucket, deps } = world({ row: legacyRow({ ageRange: "18_plus" }), browserMade: null, consent: null });
    const before = { db: db.snapshot(), objects: [...bucket.objects.keys()].sort() };
    expect(await reprocessLegacySubmission(deps, ID, { write: false })).toEqual({
      outcome: "would-reprocess",
      notes: ["public-from=original", "framing=unknown", "protections=locked", "consent=missing", "will-lock", "original-name=generic"],
    });
    expect(db.snapshot()).toBe(before.db);
    expect([...bucket.objects.keys()].sort()).toEqual(before.objects);
  });

  it.each([
    ["already processed", { stripped: true }],
    ["approved", { status: "approved" }],
    ["still uploading", { status: "uploading" }],
    ["archived", { status: "archived" }],
  ])("skips a row that is not a candidate: %s", async (_name, fields) => {
    const { db, deps } = world({ row: legacyRow(fields) });
    const before = db.snapshot();
    expect((await reprocessLegacySubmission(deps, ID, { write: true })).outcome).toBe("not-legacy");
    expect(db.snapshot()).toBe(before);
  });

  it("reports missing rows, malformed ids and missing originals", async () => {
    const { bucket, deps } = world();
    expect((await reprocessLegacySubmission(deps, OTHER, { write: true })).outcome).toBe("not-found");
    expect((await reprocessLegacySubmission(deps, "sub_x", { write: true })).outcome).toBe("not-found");
    bucket.objects.delete(paths.upload(ID));
    expect((await reprocessLegacySubmission(deps, ID, { write: true })).outcome).toBe("no-original");
  });

  it.each([
    ["unreadable", UPLOAD, "upload"],
    ["not-an-image", Buffer.from("<html><script>alert(1)</script></html>"), null],
  ] as const)("%s: leaves everything in place for a person and releases the lease", async (outcome, upload, failOn) => {
    const { db, bucket, deps, browserMade, calls } = world({ upload });
    expect((await reprocessLegacySubmission({ ...deps, process: labellingProcess(calls, failOn) }, ID, { write: true })).outcome).toBe(outcome);
    expect(bucket.has(paths.upload(ID))).toBe(true);
    expect(bucket.objects.get(OLD)?.generation).toBe(browserMade!.generation);
    expect(bucket.has(V2)).toBe(false);
    expect(row(db).stripped).toBeUndefined();
    expect(row(db)).not.toHaveProperty("processingLease");
  });

  it("an image error that is not a known decode failure stops the piece with an error, changes nothing, and a later run finishes", async () => {
    const { db, bucket, deps, browserMade } = world();
    const odd: LegacyDeps = {
      ...deps,
      process: async () => {
        throw new Error("vips_something: unexpected");
      },
    };
    await expect(reprocessLegacySubmission(odd, ID, { write: true })).rejects.toThrow(/unexpected/);
    expect(row(db).stripped).toBeUndefined();
    expect(row(db)).not.toHaveProperty("processingLease");
    expect(bucket.has(paths.upload(ID))).toBe(true);
    expect(bucket.objects.get(OLD)?.generation).toBe(browserMade!.generation);
    expect((await reprocessLegacySubmission(deps, ID, { write: true })).outcome).toBe("reprocessed");
  });

  it("another live run holds the row: busy", async () => {
    const { db, deps } = world({ row: legacyRow({ processingLease: { generation: "1", owner: "run-0", until: NOW + 60_000 } }) });
    const before = db.snapshot();
    expect((await reprocessLegacySubmission(deps, ID, { write: true })).outcome).toBe("busy");
    expect(db.snapshot()).toBe(before);
  });
});

describe("G legacy reprocess: the script's command line and output", () => {
  it("--project is required; dry run unless --write; --id must be a submission id", () => {
    expect(() => parseLegacyArgs([])).toThrow(/--project is required/);
    expect(() => parseLegacyArgs(["--write"])).toThrow(/--project is required/);
    expect(() => parseLegacyArgs(["--project"])).toThrow(/needs a value/);
    expect(() => parseLegacyArgs(["--project", "Not A Project"])).toThrow(/project id/);
    expect(() => parseLegacyArgs(["--project", "demo-cfac", "--id", "../x"])).toThrow(/sub_/);
    expect(() => parseLegacyArgs(["--project", "demo-cfac", "--force"])).toThrow(/Unknown argument/);
    expect(parseLegacyArgs(["--project", "notbychance-color-for-a-cause"])).toEqual({
      project: "notbychance-color-for-a-cause",
      bucket: null,
      id: null,
      write: false,
    });
    expect(parseLegacyArgs(["--project", "demo-cfac", "--id", ID, "--write"])).toMatchObject({ id: ID, write: true });
    expect(LEGACY_USAGE).toMatch(/--project/);
  });

  it("prints one line per id (outcome and plan words), never names, messages, emails or file names", async () => {
    const { db, deps } = world();
    db.patch(`submissions/${OTHER}`, { ...legacyRow(), id: OTHER, status: "approved" });
    const lines: string[] = [];
    const flaky: LegacyDeps = { ...deps, generationOf: async (p) => (p.includes(OTHER) ? Promise.reject(new Error("503 kid@example.com")) : deps.generationOf(p)) };
    const dry = await runLegacyReprocess(flaky, [ID, OTHER, "sub_x"], { write: false }, (l) => lines.push(l));
    expect(lines).toEqual([
      `${ID} would-reprocess public-from=old-derivative protections=locked consent=narrowed original-name=generic`,
      `${OTHER} not-legacy`,
      "(malformed id) not-found",
    ]);
    expect(dry).toEqual({ "would-reprocess": 1, "not-legacy": 1, "not-found": 1 });

    const written: string[] = [];
    const counts = await runLegacyReprocess(flaky, [ID], { write: true }, (l) => written.push(l));
    expect(counts).toEqual({ reprocessed: 1 });
    expect(written[0]).toMatch(new RegExp(`^${ID} reprocessed( [a-z-]+=[a-z-]+)+$`));

    const errors: string[] = [];
    db.patch(`submissions/${OTHER}`, { status: "submitted" });
    await runLegacyReprocess(flaky, [OTHER], { write: true }, (l) => errors.push(l));
    expect(errors).toEqual([`${OTHER} error:Error`]);
    expect([...lines, ...written, ...errors].join("\n")).not.toMatch(/Sky|hi mom|kid@example|Troop|Emma/);
  });

  it("the script is only wiring: --project via parseLegacyArgs, the built module, and rows with leftovers are candidates", () => {
    const src = readFileSync("scripts/reprocess-legacy.mjs", "utf8");
    expect(src).toMatch(/parseLegacyArgs\(process\.argv\.slice\(2\)\)/);
    expect(src).toMatch(/require\("\.\/lib\/legacy\.js"\)/);
    expect(src).toMatch(/runLegacyReprocess\(/);
    expect(src).toMatch(/applicationDefault\(\)/);
    expect(src).toMatch(/d\.get\("stripped"\) !== true \|\| d\.get\("legacyLeftovers"\) != null/);
    // It reads only ids, the stripped flag and legacyLeftovers from rows; row contents never reach the console.
    expect(src).not.toMatch(/attributionText|organizationName|\.get\("(email|message|originalName)"\)|d\.data\(\)/);
  });
});
