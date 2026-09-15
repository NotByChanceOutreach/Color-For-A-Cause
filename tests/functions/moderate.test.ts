import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { GALLERY_CACHE_CONTROL, PRIVATE_CACHE_CONTROL, SUBMISSION_STATUSES, paths, tokenlessMediaUrl } from "../../functions/src/constants";
import { ORPHAN_LEFT, PUBLISH_CLAIM_MS, artistKey, canModerate, moderateSubmission } from "../../functions/src/moderate";
import { CALLABLE_OPTIONS } from "../../functions/src/options";
import type { Tx } from "../../functions/src/store";
import {
  FakeBucket,
  FakeDb,
  NOW,
  TEST_BUCKET,
  beforeTransaction,
  expectCode,
  failTransactions,
  loseCommitAnswer,
  moderateDeps,
  reviewable,
  validSubmit,
} from "./fixtures";

const ADMIN = { uid: "staff-admin", role: "ADMIN" };
const REVIEWER = { uid: "staff-reviewer", role: "REVIEWER" };
const ART = { uid: "staff-art", role: "ART_MANAGER" };

describe("C4 publishing copies the derivative the row records (derivedPath)", () => {
  it("a reprocessed legacy piece is published from derived/public-v2.jpg", async () => {
    const { db, bucket, id } = await reviewable();
    // As legacy.ts leaves such a row: the server-made image at public-v2.jpg, recorded on the row.
    const v2 = bucket.put(paths.derivedV2(id), Buffer.from("server-made, with the artist's framing"));
    db.patch(`submissions/${id}`, { derivedPath: paths.derivedV2(id), derivedGeneration: v2.generation });
    await moderateSubmission(moderateDeps(db, bucket), ADMIN, { id, status: "approved", derivedGeneration: v2.generation });
    expect(bucket.objects.get(paths.gallery(id))?.data.toString()).toBe("server-made, with the artist's framing");
    expect(db.data(`publicGallery/${id}`)?.imageUrl).toBe(bucket.liveUrl(paths.gallery(id)));
  });

  it.each([
    ["the original upload", (id: string) => paths.upload(id)],
    ["the gallery copy", (id: string) => paths.gallery(id)],
    ["another piece's derivative", () => paths.derived(`sub_${"f".repeat(32)}`)],
    ["a link", () => "https://example.test/x.jpg"],
    ["not text", () => 42],
  ])("a derivedPath that is not a server-made image of this piece is refused: %s", async (_what, bad) => {
    const { db, bucket, id, generation } = await reviewable();
    db.patch(`submissions/${id}`, { derivedPath: bad(id) });
    await expectCode(moderateSubmission(moderateDeps(db, bucket), ADMIN, { id, status: "approved", derivedGeneration: generation }), "failed-precondition");
    expect(bucket.has(paths.gallery(id))).toBe(false);
    expect(db.data(`publicGallery/${id}`)).toBeUndefined();
  });

  it("if derivedPath changes between the claim and the commit, nothing is published and the copy is removed", async () => {
    const { db, bucket, id, generation } = await reviewable();
    bucket.afterCopy = async () => {
      db.patch(`submissions/${id}`, { derivedPath: paths.derivedV2(id) });
    };
    await expectCode(moderateSubmission(moderateDeps(db, bucket), ADMIN, { id, status: "approved", derivedGeneration: generation }), "failed-precondition");
    expect(bucket.has(paths.gallery(id))).toBe(false);
    expect(db.data(`publicGallery/${id}`)).toBeUndefined();
    expect(db.data(`submissions/${id}`)).not.toHaveProperty("publishClaim");
  });
});

describe("C4 moderateSubmission: allowlists", () => {
  it.each(["", "IMPACT_MANAGER", "admin", "PUBLIC", "OWNER"])("refuses role %j before doing anything", async (role) => {
    const { db, bucket, id, generation } = await reviewable();
    const before = db.snapshot();
    await expectCode(
      moderateSubmission(moderateDeps(db, bucket), { uid: "someone", role }, { id, status: "approved", derivedGeneration: generation }),
      "permission-denied",
    );
    expect(bucket.copies).toBe(0);
    expect(db.snapshot()).toBe(before);
  });

  it.each(["sub_123", `sub_${"A".repeat(32)}`, `sub_${"a".repeat(33)}`, "../gallery/x", "", 42, null])("rejects id %j", async (id) => {
    const { db, bucket } = await reviewable();
    await expectCode(moderateSubmission(moderateDeps(db, bucket), ADMIN, { id, status: "hold" }), "invalid-argument");
  });

  it.each(["uploading", "rejected_upload", "published", "APPROVED", "", null, 3])("rejects status %j", async (status) => {
    const { db, bucket, id, generation } = await reviewable();
    await expectCode(moderateSubmission(moderateDeps(db, bucket), ADMIN, { id, status, derivedGeneration: generation }), "invalid-argument");
  });

  it("rejects unknown fields and malformed generations", async () => {
    const { db, bucket, id, generation } = await reviewable();
    const deps = moderateDeps(db, bucket);
    await expectCode(moderateSubmission(deps, ADMIN, { id, status: "approved", derivedGeneration: generation, role: "ADMIN" }), "invalid-argument");
    for (const bad of ["abc", "0", "-5", 12, "1".repeat(21)]) {
      await expectCode(moderateSubmission(deps, ADMIN, { id, status: "approved", derivedGeneration: bad }), "invalid-argument");
    }
    expect(bucket.copies).toBe(0);
  });

  it.each([...SUBMISSION_STATUSES])("accepts allowlisted status %s", async (status) => {
    const { db, bucket, id, generation } = await reviewable();
    const res = await moderateSubmission(moderateDeps(db, bucket), ADMIN, { id, status, derivedGeneration: generation });
    expect(res.status).toBe(status);
    expect(db.data(`submissions/${id}`)?.status).toBe(status);
    expect(db.data(`submissions/${id}`)).not.toHaveProperty("publishClaim");
  });

  it("ART_MANAGER only moves approved art between approved and featured", async () => {
    expect(canModerate("ART_MANAGER", "approved", "featured")).toBe(true);
    expect(canModerate("ART_MANAGER", "featured", "approved")).toBe(true);
    expect(canModerate("ART_MANAGER", "submitted", "approved")).toBe(false);
    expect(canModerate("ART_MANAGER", "featured", "rejected")).toBe(false);
    expect(canModerate("IMPACT_MANAGER", "submitted", "hold")).toBe(false);

    const { db, bucket, id, generation } = await reviewable();
    const deps = moderateDeps(db, bucket);
    await expectCode(moderateSubmission(deps, ART, { id, status: "approved", derivedGeneration: generation }), "permission-denied");
    await moderateSubmission(deps, REVIEWER, { id, status: "approved", derivedGeneration: generation });
    await moderateSubmission(deps, ART, { id, status: "featured", derivedGeneration: generation });
    expect(db.data(`publicGallery/${id}`)?.status).toBe("featured");
  });

  it("refuses submissions that never finished uploading", async () => {
    const { db, bucket, id, generation } = await reviewable();
    for (const status of ["uploading", "rejected_upload"]) {
      db.patch(`submissions/${id}`, { status });
      await expectCode(
        moderateSubmission(moderateDeps(db, bucket), ADMIN, { id, status: "approved", derivedGeneration: generation }),
        "failed-precondition",
      );
    }
    expect(bucket.copies).toBe(0);
  });
});

describe("C4 publishing is pinned to the generation the reviewer saw", () => {
  it("copies derived/public.jpg to gallery/{id}/public.jpg and writes only public fields", async () => {
    const { db, bucket, id, generation } = await reviewable({ submit: { email: "grownup@example.com", message: "Hi Mom" } });
    const res = await moderateSubmission(moderateDeps(db, bucket), REVIEWER, {
      id,
      status: "approved",
      derivedGeneration: generation,
      note: "lovely",
    });
    expect(res).toEqual({ ok: true, id, status: "approved" });
    expect(bucket.copies).toBe(1);
    expect(bucket.objects.get(paths.gallery(id))?.data.toString()).toBe("public-jpeg");
    const pub = db.data(`publicGallery/${id}`)!;
    expect(pub).toMatchObject({ id, status: "approved", attributionText: "Sky", message: "Hi Mom", public: true });
    expect(pub.imageUrl).toBe(bucket.liveUrl(paths.gallery(id)));
    for (const key of ["email", "ageRange", "flags", "staffNote", "consentId", "derivedPath", "finalizeTokenHash", "submitterRole"]) {
      expect(pub).not.toHaveProperty(key);
    }
    expect(db.data(`submissions/${id}`)).toMatchObject({ status: "approved", reviewedBy: "staff-reviewer", staffNote: "lovely" });
    expect(db.data(`submissions/${id}`)).not.toHaveProperty("publishClaim");
    expect(db.data("counters/public")?.artistsParticipating).toBe(1);
  });

  it("refuses a stale generation and publishes nothing", async () => {
    const { db, bucket, id, generation } = await reviewable();
    await expectCode(
      moderateSubmission(moderateDeps(db, bucket), ADMIN, { id, status: "approved", derivedGeneration: String(Number(generation) - 1) }),
      "failed-precondition",
    );
    expect(bucket.has(paths.gallery(id))).toBe(false);
    expect(db.data(`publicGallery/${id}`)).toBeUndefined();
    expect(db.data(`submissions/${id}`)?.status).toBe("submitted");
  });

  it("refuses when the stored object no longer is that generation, and drops its claim", async () => {
    const { db, bucket, id, generation } = await reviewable();
    bucket.put(paths.derived(id), Buffer.from("swapped after review"));
    await expectCode(
      moderateSubmission(moderateDeps(db, bucket), ADMIN, { id, status: "approved", derivedGeneration: generation }),
      "failed-precondition",
    );
    expect(bucket.has(paths.gallery(id))).toBe(false);
    expect(db.data(`publicGallery/${id}`)).toBeUndefined();
    expect(db.data(`submissions/${id}`)).not.toHaveProperty("publishClaim");
  });

  it("requires derivedGeneration to publish, but not to hold", async () => {
    const { db, bucket, id } = await reviewable();
    const deps = moderateDeps(db, bucket);
    await expectCode(moderateSubmission(deps, ADMIN, { id, status: "approved" }), "invalid-argument");
    await moderateSubmission(deps, ADMIN, { id, status: "hold", note: "check the message" });
    expect(db.data(`submissions/${id}`)?.status).toBe("hold");
  });

  it("won't publish a piece that skipped the server privacy check", async () => {
    const { db, bucket, id, generation } = await reviewable();
    db.patch(`submissions/${id}`, { stripped: false });
    await expectCode(
      moderateSubmission(moderateDeps(db, bucket), ADMIN, { id, status: "approved", derivedGeneration: generation }),
      "failed-precondition",
    );
    expect(bucket.copies).toBe(0);
  });

  it("approval without display permission publishes nothing", async () => {
    const permissions = { ...(validSubmit().permissions as object), displayPublic: false };
    const { db, bucket, id, generation } = await reviewable({ submit: { permissions } });
    await moderateSubmission(moderateDeps(db, bucket), ADMIN, { id, status: "approved", derivedGeneration: generation });
    expect(db.data(`submissions/${id}`)?.status).toBe("approved");
    expect(bucket.has(paths.gallery(id))).toBe(false);
    expect(db.data(`publicGallery/${id}`)).toBeUndefined();
    expect(db.data("counters/public")?.artistsParticipating).toBeUndefined();
  });

  it("approved -> featured copies nothing and counts nothing", async () => {
    const { db, bucket, id, generation } = await reviewable();
    const deps = moderateDeps(db, bucket);
    await moderateSubmission(deps, ADMIN, { id, status: "approved", derivedGeneration: generation });
    await moderateSubmission(deps, ADMIN, { id, status: "featured", derivedGeneration: generation });
    expect(bucket.copies).toBe(1);
    expect(db.data("counters/public")?.artistsParticipating).toBe(1);
    expect(db.data(`publicGallery/${id}`)?.status).toBe("featured");
  });

  it("unpublishing deletes the gallery object and record, and the counter follows", async () => {
    const { db, bucket, id, generation } = await reviewable();
    const deps = moderateDeps(db, bucket);
    await moderateSubmission(deps, ADMIN, { id, status: "approved", derivedGeneration: generation });
    expect(db.data(`submissions/${id}`)?.galleryGeneration).toBe(bucket.objects.get(paths.gallery(id))?.generation);
    await moderateSubmission(deps, ADMIN, { id, status: "archived" });
    expect(bucket.has(paths.gallery(id))).toBe(false);
    expect(db.data(`publicGallery/${id}`)).toBeUndefined();
    expect(db.data("counters/public")?.artistsParticipating).toBe(0);
    const row = db.data(`submissions/${id}`)!;
    for (const key of ["publicArtistKey", "galleryGeneration", "galleryOrphan"]) expect(row).not.toHaveProperty(key);
  });

  it("publish, unpublish, publish again works", async () => {
    const { db, bucket, id, generation } = await reviewable();
    const deps = moderateDeps(db, bucket);
    await moderateSubmission(deps, ADMIN, { id, status: "approved", derivedGeneration: generation });
    await moderateSubmission(deps, ADMIN, { id, status: "hold" });
    await moderateSubmission(deps, ADMIN, { id, status: "approved", derivedGeneration: generation });
    expect(db.data(`publicGallery/${id}`)?.imageUrl).toBe(bucket.liveUrl(paths.gallery(id)));
    expect(db.data("counters/public")?.artistsParticipating).toBe(1);
  });

  it("counts distinct public bylines with increments only", async () => {
    const db = new FakeDb();
    const bucket = new FakeBucket();
    const a = await reviewable({ db, bucket });
    const b = await reviewable({ db, bucket, submit: { attributionText: "  SKY " } });
    const c = await reviewable({ db, bucket, submit: { attributionKind: "anonymous" } });
    const deps = moderateDeps(db, bucket);
    for (const s of [a, b, c]) await moderateSubmission(deps, ADMIN, { id: s.id, status: "approved", derivedGeneration: s.generation });
    expect(db.data("counters/public")?.artistsParticipating).toBe(2);
    await moderateSubmission(deps, ADMIN, { id: a.id, status: "archived" });
    expect(db.data("counters/public")?.artistsParticipating).toBe(2);
    await moderateSubmission(deps, ADMIN, { id: b.id, status: "rejected" });
    expect(db.data("counters/public")?.artistsParticipating).toBe(1);
    expect(artistKey(db.data(`submissions/${c.id}`)!)).not.toBe(artistKey(db.data(`submissions/${a.id}`)!));
  });

  it("artist keys compare names after NFC and without invisible characters", () => {
    const row = (attributionText: string) => ({ attributionKind: "firstName", attributionText, permissions: { showAttribution: true } });
    expect(artistKey(row("Zoë"))).toBe(artistKey(row("Zoë")));
    expect(artistKey(row("ZOË"))).toBe(artistKey(row("zoë")));
    expect(artistKey(row("Sky​"))).toBe(artistKey(row("sky")));
    expect(artistKey(row("Sky"))).not.toBe(artistKey(row("Skye")));
    // Never throws on rows stored before lone surrogates were refused.
    expect(() => artistKey(row("Sky\ud800"))).not.toThrow();
  });
});

describe("C4 concurrent publishes (F6)", () => {
  const publishBoth = (db: FakeDb, bucket: FakeBucket, id: string, generation: string) =>
    Promise.allSettled([
      moderateSubmission(moderateDeps(db, bucket), ADMIN, { id, status: "approved", derivedGeneration: generation }),
      moderateSubmission(moderateDeps(db, bucket), REVIEWER, { id, status: "featured", derivedGeneration: generation }),
    ]);

  it("the claim outlives the callable timeout (the invariant)", () => {
    expect(PUBLISH_CLAIM_MS).toBeGreaterThan(CALLABLE_OPTIONS.timeoutSeconds * 1000);
  });

  it("two publishes at once: one wins, one is told to reload, and the public doc points at the live image", async () => {
    const { db, bucket, id, generation } = await reviewable();
    const results = await publishBoth(db, bucket, id, generation);
    const won = results.filter((r) => r.status === "fulfilled");
    const lost = results.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(1);
    expect((lost[0].reason as { code?: string }).code).toBe("aborted");

    expect(bucket.copies).toBe(1);
    const pub = db.data(`publicGallery/${id}`)!;
    expect(bucket.has(paths.gallery(id))).toBe(true);
    expect(pub.imageUrl).toBe(bucket.liveUrl(paths.gallery(id)));
    expect(pub.status).toBe(db.data(`submissions/${id}`)?.status);
    expect(db.data("counters/public")?.artistsParticipating).toBe(1);
    expect(db.data(`submissions/${id}`)).not.toHaveProperty("publishClaim");
  });

  it("the second publisher arrives while the first is copying: it never touches Storage", async () => {
    const { db, bucket, id, generation } = await reviewable();
    let resume!: () => void;
    let copying!: () => void;
    const started = new Promise<void>((r) => (copying = r));
    bucket.beforeCopy = () =>
      new Promise<void>((r) => {
        resume = r;
        copying();
      });
    const first = moderateSubmission(moderateDeps(db, bucket), ADMIN, { id, status: "approved", derivedGeneration: generation });
    await started;
    bucket.beforeCopy = null;
    const removals: string[] = [];
    const second = moderateDeps(db, bucket, {
      remove: async (p, g) => {
        removals.push(p);
        await bucket.remove(p, g);
      },
      publishCopy: async (...args) => {
        removals.push(`copy:${args[2]}`);
        return bucket.publishCopy(...args);
      },
    });
    const err = await expectCode(moderateSubmission(second, REVIEWER, { id, status: "approved", derivedGeneration: generation }), "aborted");
    expect(err.message).toMatch(/publishing this picture right now/);
    expect(removals).toEqual([]);

    resume();
    await first;
    expect(db.data(`publicGallery/${id}`)?.imageUrl).toBe(bucket.liveUrl(paths.gallery(id)));
    expect(db.data(`submissions/${id}`)?.status).toBe("approved");

    // After the first one finished, a late second publish of the same thing is a no-op change, not a copy.
    await moderateSubmission(second, REVIEWER, { id, status: "approved", derivedGeneration: generation });
    expect(bucket.copies).toBe(1);
    expect(removals.filter((r) => r.startsWith("copy:"))).toEqual([]);
    expect(db.data(`publicGallery/${id}`)?.imageUrl).toBe(bucket.liveUrl(paths.gallery(id)));
  });

  it("if the row moves while the copy runs, the publisher deletes only the generation it created", async () => {
    const { db, bucket, id, generation } = await reviewable();
    let other: { generation: string } | null = null;
    bucket.afterCopy = async () => {
      bucket.afterCopy = null;
      // Another reviewer holds the piece meanwhile, and some other writer replaces the gallery file.
      await moderateSubmission(moderateDeps(db, bucket), REVIEWER, { id, status: "hold", note: "wait" });
      other = bucket.put(paths.gallery(id), Buffer.from("not ours"));
    };
    await expectCode(moderateSubmission(moderateDeps(db, bucket), ADMIN, { id, status: "approved", derivedGeneration: generation }), "aborted");
    expect(bucket.objects.get(paths.gallery(id))?.generation).toBe(other!.generation);
    expect(db.data(`publicGallery/${id}`)).toBeUndefined();
    expect(db.data(`submissions/${id}`)?.status).toBe("hold");
    expect(db.data(`submissions/${id}`)).not.toHaveProperty("publishClaim");
    expect(db.data("counters/public")?.artistsParticipating).toBeUndefined();
  });

  it("a copy that fails outright releases the claim, so the next try works", async () => {
    const { db, bucket, id, generation } = await reviewable();
    const broken = moderateDeps(db, bucket, {
      publishCopy: async () => {
        throw new Error("503 from Cloud Storage");
      },
    });
    await expect(moderateSubmission(broken, ADMIN, { id, status: "approved", derivedGeneration: generation })).rejects.toThrow(/503/);
    expect(db.data(`submissions/${id}`)).not.toHaveProperty("publishClaim");
    expect(db.data(`submissions/${id}`)?.status).toBe("submitted");
    await moderateSubmission(moderateDeps(db, bucket), ADMIN, { id, status: "approved", derivedGeneration: generation });
    expect(db.data(`publicGallery/${id}`)?.imageUrl).toBe(bucket.liveUrl(paths.gallery(id)));
  });

  it("a live claim from another publisher blocks; an expired one (a run that died) is taken over and its leftover file replaced", async () => {
    const { db, bucket, id, generation } = await reviewable();
    db.patch(`submissions/${id}`, { publishClaim: { id: "dead-run", to: "approved", generation, until: NOW + 60_000 } });
    bucket.put(paths.gallery(id), Buffer.from("leftover"));
    await expectCode(moderateSubmission(moderateDeps(db, bucket), ADMIN, { id, status: "approved", derivedGeneration: generation }), "aborted");
    expect(bucket.objects.get(paths.gallery(id))?.data.toString()).toBe("leftover");

    db.patch(`submissions/${id}`, { publishClaim: { id: "dead-run", to: "approved", generation, until: NOW - 1 } });
    await moderateSubmission(moderateDeps(db, bucket), ADMIN, { id, status: "approved", derivedGeneration: generation });
    expect(bucket.objects.get(paths.gallery(id))?.data.toString()).toBe("public-jpeg");
    expect(db.data(`publicGallery/${id}`)?.imageUrl).toBe(bucket.liveUrl(paths.gallery(id)));
  });
});

describe("C4 unpublish vs publish: the database goes first, then exactly the stored generation", () => {
  const publishNow = (db: FakeDb, bucket: FakeBucket, id: string, generation: string, status = "approved") =>
    moderateSubmission(moderateDeps(db, bucket), ADMIN, { id, status, derivedGeneration: generation });

  /** The wall is consistent: either no public doc, or a doc whose image is the live gallery object. */
  function expectConsistent(db: FakeDb, bucket: FakeBucket, id: string) {
    const pub = db.data(`publicGallery/${id}`);
    if (pub) {
      expect(pub.imageUrl).toBe(bucket.liveUrl(paths.gallery(id)));
      expect(db.data(`submissions/${id}`)?.galleryGeneration).toBe(bucket.objects.get(paths.gallery(id))?.generation);
    }
    return pub;
  }

  it("the public doc is gone before the file is deleted", async () => {
    const { db, bucket, id, generation } = await reviewable();
    await publishNow(db, bucket, id, generation);
    const docWhenDeleted: unknown[] = [];
    await moderateSubmission(
      moderateDeps(db, bucket, {
        remove: async (p, g) => {
          docWhenDeleted.push(db.data(`publicGallery/${id}`));
          await bucket.remove(p, g);
        },
      }),
      ADMIN,
      { id, status: "rejected" },
    );
    expect(docWhenDeleted).toEqual([undefined]);
    expect(bucket.has(paths.gallery(id))).toBe(false);
  });

  it.each([
    ["rejected", ADMIN],
    ["hold", REVIEWER],
  ])("ART_MANAGER approved -> featured commits just before a %s: the %s is refused and nothing is deleted", async (status, who) => {
    const { db, bucket, id, generation } = await reviewable();
    await publishNow(db, bucket, id, generation);
    beforeTransaction(db, 1, async () => {
      await moderateSubmission(moderateDeps(db, bucket), ART, { id, status: "featured", derivedGeneration: generation });
    });
    await expectCode(moderateSubmission(moderateDeps(db, bucket), who, { id, status }), "aborted");
    expect(db.data(`submissions/${id}`)?.status).toBe("featured");
    expect(expectConsistent(db, bucket, id)?.status).toBe("featured");
    expect(bucket.has(paths.gallery(id))).toBe(true);
  });

  it.each([
    ["rejected", ADMIN],
    ["hold", REVIEWER],
  ])("a %s commits just before ART_MANAGER approved -> featured: the curate is refused, the piece is fully off the wall", async (status, who) => {
    const { db, bucket, id, generation } = await reviewable();
    await publishNow(db, bucket, id, generation);
    beforeTransaction(db, 1, async () => {
      await moderateSubmission(moderateDeps(db, bucket), who, { id, status });
    });
    await expectCode(moderateSubmission(moderateDeps(db, bucket), ART, { id, status: "featured", derivedGeneration: generation }), "aborted");
    expect(db.data(`submissions/${id}`)?.status).toBe(status);
    expect(db.data(`publicGallery/${id}`)).toBeUndefined();
    expect(bucket.has(paths.gallery(id))).toBe(false);
  });

  it("a stale unpublish (read 'approved') after another reviewer held and re-published: refused, the new image stays", async () => {
    const { db, bucket, id, generation } = await reviewable();
    await publishNow(db, bucket, id, generation);
    beforeTransaction(db, 1, async () => {
      await moderateSubmission(moderateDeps(db, bucket), REVIEWER, { id, status: "hold" });
      await publishNow(db, bucket, id, generation, "featured");
    });
    await expectCode(moderateSubmission(moderateDeps(db, bucket), ADMIN, { id, status: "archived" }), "aborted");
    const pub = expectConsistent(db, bucket, id);
    expect(pub?.status).toBe("featured");
    expect(bucket.copies).toBe(2); // the re-published copy is the live one (expectConsistent checks its generation)
  });

  it("a stale unpublish while a publisher is copying: refused, and the publisher's commit points at a live image", async () => {
    const { db, bucket, id, generation } = await reviewable();
    await publishNow(db, bucket, id, generation);
    let resume!: () => void;
    let copying!: () => void;
    const started = new Promise<void>((r) => (copying = r));
    let publisher: Promise<unknown> | null = null;
    beforeTransaction(db, 1, async () => {
      await moderateSubmission(moderateDeps(db, bucket), REVIEWER, { id, status: "hold" });
      bucket.beforeCopy = () =>
        new Promise<void>((r) => {
          resume = r;
          copying();
        });
      publisher = publishNow(db, bucket, id, generation);
      await started;
      bucket.beforeCopy = null;
    });
    await expectCode(moderateSubmission(moderateDeps(db, bucket), ADMIN, { id, status: "archived" }), "aborted");
    resume();
    await publisher;
    expect(db.data(`submissions/${id}`)?.status).toBe("approved");
    expect(expectConsistent(db, bucket, id)).toBeTruthy();
  });

  it("refuses to unpublish while a live publish claim is held", async () => {
    const { db, bucket, id, generation } = await reviewable();
    await publishNow(db, bucket, id, generation);
    db.patch(`submissions/${id}`, { publishClaim: { id: "someone", to: "approved", generation, until: NOW + 60_000 } });
    const err = await expectCode(moderateSubmission(moderateDeps(db, bucket), ADMIN, { id, status: "rejected" }), "aborted");
    expect(err.message).toMatch(/publishing this picture right now/);
    expect(expectConsistent(db, bucket, id)).toBeTruthy();
  });

  it("an unpublish transaction that fails has deleted nothing: the doc still points at a live image, and the retry works", async () => {
    const { db, bucket, id, generation } = await reviewable();
    await publishNow(db, bucket, id, generation);
    failTransactions(db, [1]);
    await expect(moderateSubmission(moderateDeps(db, bucket), ADMIN, { id, status: "rejected" })).rejects.toThrow(/UNAVAILABLE/);
    expect(expectConsistent(db, bucket, id)).toBeTruthy();
    expect(bucket.has(paths.gallery(id))).toBe(true);

    await moderateSubmission(moderateDeps(db, bucket), ADMIN, { id, status: "rejected" });
    expect(db.data(`publicGallery/${id}`)).toBeUndefined();
    expect(bucket.has(paths.gallery(id))).toBe(false);
  });

  it("if the file cannot be removed, staff are told to press again; pressing again removes it", async () => {
    const { db, bucket, id, generation } = await reviewable();
    await publishNow(db, bucket, id, generation);
    const live = bucket.objects.get(paths.gallery(id))!.generation;
    const broken = moderateDeps(db, bucket, {
      remove: async () => {
        throw new Error("503 from Cloud Storage");
      },
    });
    const err = await expectCode(moderateSubmission(broken, ADMIN, { id, status: "rejected" }), "aborted");
    expect(err.message).toBe(ORPHAN_LEFT);
    expect(db.data(`publicGallery/${id}`)).toBeUndefined();
    expect(db.data(`submissions/${id}`)).toMatchObject({ status: "rejected", galleryOrphan: live });

    await moderateSubmission(moderateDeps(db, bucket), ADMIN, { id, status: "rejected" });
    expect(bucket.has(paths.gallery(id))).toBe(false);
    expect(db.data(`submissions/${id}`)).not.toHaveProperty("galleryOrphan");
  });

  it("publishing again after a failed file removal clears the recorded orphan first", async () => {
    const { db, bucket, id, generation } = await reviewable();
    await publishNow(db, bucket, id, generation);
    const broken = moderateDeps(db, bucket, {
      remove: async () => {
        throw new Error("503 from Cloud Storage");
      },
    });
    await expectCode(moderateSubmission(broken, ADMIN, { id, status: "hold" }), "aborted");
    await publishNow(db, bucket, id, generation);
    expect(expectConsistent(db, bucket, id)).toBeTruthy();
    expect(bucket.copies).toBe(2);
    expect(db.data(`submissions/${id}`)).not.toHaveProperty("galleryOrphan");
  });

  it("art published before galleryGeneration existed: unpublish looks up the live generation and removes it", async () => {
    const { db, bucket, id, generation } = await reviewable();
    await publishNow(db, bucket, id, generation);
    db.patch(`submissions/${id}`, { galleryGeneration: undefined });
    await moderateSubmission(moderateDeps(db, bucket), ADMIN, { id, status: "archived" });
    expect(db.data(`publicGallery/${id}`)).toBeUndefined();
    expect(bucket.has(paths.gallery(id))).toBe(false);
  });

  it("a publish whose commit answer was lost is a success, and its image stays", async () => {
    const { db, bucket, id, generation } = await reviewable();
    loseCommitAnswer(db, 2); // 1 = claim, 2 = commit
    await publishNow(db, bucket, id, generation);
    expect(expectConsistent(db, bucket, id)).toBeTruthy();
    expect(db.data("counters/public")?.artistsParticipating).toBe(1);
  });

  it("a publish commit that landed but reported an error keeps its image", async () => {
    const { db, bucket, id, generation } = await reviewable();
    const original = db.runTransaction.bind(db);
    let n = 0;
    db.runTransaction = (async (fn: (tx: Tx) => Promise<unknown>) => {
      n += 1;
      const out = await original(fn);
      if (n === 2) throw new Error("DEADLINE_EXCEEDED");
      return out;
    }) as FakeDb["runTransaction"];
    await publishNow(db, bucket, id, generation);
    expect(expectConsistent(db, bucket, id)).toBeTruthy();
  });

  it("a publisher that outlived its claim cannot delete the image the next publisher committed", async () => {
    const { db, bucket, id, generation } = await reviewable();
    let resume!: () => void;
    let arrived!: () => void;
    const paused = new Promise<void>((r) => (resume = r));
    const atCleanup = new Promise<void>((r) => (arrived = r));
    const zombie = moderateSubmission(
      moderateDeps(db, bucket, {
        generationOf: async (p) => {
          arrived();
          await paused;
          return bucket.generationOf(p);
        },
      }),
      ADMIN,
      { id, status: "approved", derivedGeneration: generation },
    );
    await atCleanup;
    // The zombie's claim runs out; another reviewer publishes and commits.
    await moderateSubmission(moderateDeps(db, bucket, { now: () => NOW + PUBLISH_CLAIM_MS + 1 }), REVIEWER, {
      id,
      status: "featured",
      derivedGeneration: generation,
    });
    const live = bucket.objects.get(paths.gallery(id))!.generation;
    resume();
    await expectCode(zombie, "aborted");
    expect(bucket.objects.get(paths.gallery(id))?.generation).toBe(live);
    expect(expectConsistent(db, bucket, id)?.status).toBe("featured");
  });
});

describe("A Art Wall images are tokenless and rules-gated (round 4)", () => {
  it("the public doc holds the tokenless URL, and the gallery object carries no token even when the derivative had one", async () => {
    const { db, bucket, id, generation } = await reviewable();
    bucket.objects.get(paths.derived(id))!.token = "a-token-on-the-source";
    await moderateSubmission(moderateDeps(db, bucket), ADMIN, { id, status: "approved", derivedGeneration: generation });
    const url = String(db.data(`publicGallery/${id}`)?.imageUrl);
    expect(url).toBe(tokenlessMediaUrl(TEST_BUCKET, paths.gallery(id)));
    expect(url).toBe(`https://firebasestorage.googleapis.com/v0/b/${TEST_BUCKET}/o/gallery%2F${id}%2Fpublic.jpg?alt=media`);
    expect(url).not.toMatch(/token/);
    expect(bucket.tokenOf(paths.gallery(id))).toBeUndefined();
  });

  it("unpublishing revokes a token a reader minted while the piece was on the wall, then deletes exactly that generation", async () => {
    const { db, bucket, id, generation } = await reviewable();
    await moderateSubmission(moderateDeps(db, bucket), ADMIN, { id, status: "approved", derivedGeneration: generation });
    const live = bucket.objects.get(paths.gallery(id))!.generation;
    bucket.mintToken(paths.gallery(id));
    bucket.log = [];
    await moderateSubmission(moderateDeps(db, bucket), ADMIN, { id, status: "rejected" });
    expect(bucket.log).toEqual([`revoke:${paths.gallery(id)}@${live}`, `remove:${paths.gallery(id)}@${live}`]);
    expect(bucket.has(paths.gallery(id))).toBe(false);
  });

  it("if the file cannot be deleted, its token is revoked anyway: the leftover is unreadable to everyone at once", async () => {
    const { db, bucket, id, generation } = await reviewable();
    await moderateSubmission(moderateDeps(db, bucket), ADMIN, { id, status: "approved", derivedGeneration: generation });
    bucket.mintToken(paths.gallery(id));
    const broken = moderateDeps(db, bucket, {
      remove: async () => {
        throw new Error("503 from Cloud Storage");
      },
    });
    const err = await expectCode(moderateSubmission(broken, ADMIN, { id, status: "hold" }), "aborted");
    expect(err.message).toBe(ORPHAN_LEFT);
    expect(db.data(`publicGallery/${id}`)).toBeUndefined();
    expect(bucket.has(paths.gallery(id))).toBe(true);
    expect(bucket.tokenOf(paths.gallery(id))).toBeUndefined();
  });

  it("a revoke that fails does not stop the delete", async () => {
    const { db, bucket, id, generation } = await reviewable();
    await moderateSubmission(moderateDeps(db, bucket), ADMIN, { id, status: "approved", derivedGeneration: generation });
    const flaky = moderateDeps(db, bucket, {
      revokeTokens: async () => {
        throw new Error("503 from Cloud Storage");
      },
    });
    await moderateSubmission(flaky, ADMIN, { id, status: "archived" });
    expect(bucket.has(paths.gallery(id))).toBe(false);
  });

  it("a leftover copy with a minted token is revoked and deleted by its generation before the new copy is made", async () => {
    const { db, bucket, id, generation } = await reviewable();
    const leftover = bucket.put(paths.gallery(id), Buffer.from("leftover")).generation;
    bucket.mintToken(paths.gallery(id));
    bucket.log = [];
    await moderateSubmission(moderateDeps(db, bucket), ADMIN, { id, status: "approved", derivedGeneration: generation });
    expect(bucket.log).toEqual([`revoke:${paths.gallery(id)}@${leftover}`, `remove:${paths.gallery(id)}@${leftover}`]);
    expect(bucket.objects.get(paths.gallery(id))?.data.toString()).toBe("public-jpeg");
    expect(bucket.tokenOf(paths.gallery(id))).toBeUndefined();
  });

  it("index.ts wires the revoke into moderation", () => {
    expect(readFileSync("functions/src/index.ts", "utf8")).toMatch(/revokeTokens: storage\.revokeTokens/);
  });
});

describe("B expired publish claims count as released everywhere (round 4)", () => {
  const expired = (generation: string) => ({ id: "dead-run", to: "approved", generation, until: NOW - 1 });

  it.each(["hold", "rejected", "archived", "needs_changes"])("%s removes an expired claim inside its own transaction", async (status) => {
    const { db, bucket, id, generation } = await reviewable();
    db.patch(`submissions/${id}`, { publishClaim: expired(generation) });
    await moderateSubmission(moderateDeps(db, bucket), ADMIN, { id, status });
    expect(db.data(`submissions/${id}`)?.status).toBe(status);
    expect(db.data(`submissions/${id}`)).not.toHaveProperty("publishClaim");
  });

  it("a malformed claim counts as released too", async () => {
    const { db, bucket, id } = await reviewable();
    db.patch(`submissions/${id}`, { publishClaim: { id: 7 } });
    await moderateSubmission(moderateDeps(db, bucket), ADMIN, { id, status: "hold" });
    expect(db.data(`submissions/${id}`)).not.toHaveProperty("publishClaim");
  });

  it("a live claim is left alone (its publisher's commit sees the row moved and backs out)", async () => {
    const { db, bucket, id, generation } = await reviewable();
    const live = { id: "busy-run", to: "approved", generation, until: NOW + 60_000 };
    db.patch(`submissions/${id}`, { publishClaim: live });
    await moderateSubmission(moderateDeps(db, bucket), ADMIN, { id, status: "hold" });
    expect(db.data(`submissions/${id}`)?.publishClaim).toEqual(live);
  });

  it("unpublishing a piece that still carries an expired claim works and removes the claim", async () => {
    const { db, bucket, id, generation } = await reviewable();
    await moderateSubmission(moderateDeps(db, bucket), ADMIN, { id, status: "approved", derivedGeneration: generation });
    db.patch(`submissions/${id}`, { publishClaim: expired(generation) });
    await moderateSubmission(moderateDeps(db, bucket), ADMIN, { id, status: "archived" });
    expect(db.data(`submissions/${id}`)).not.toHaveProperty("publishClaim");
    expect(db.data(`publicGallery/${id}`)).toBeUndefined();
    expect(bucket.has(paths.gallery(id))).toBe(false);
  });

  it("a stalled publisher cannot commit after staff rejected the piece and released its expired claim", async () => {
    const { db, bucket, id, generation } = await reviewable();
    let resume!: () => void;
    let copied!: () => void;
    const atCopy = new Promise<void>((r) => (copied = r));
    bucket.afterCopy = () =>
      new Promise<void>((r) => {
        resume = r;
        copied();
      });
    const stalled = moderateSubmission(moderateDeps(db, bucket), ADMIN, { id, status: "approved", derivedGeneration: generation });
    await atCopy;
    bucket.afterCopy = null;
    // Its claim runs out; a reviewer rejects the piece.
    await moderateSubmission(moderateDeps(db, bucket, { now: () => NOW + PUBLISH_CLAIM_MS + 1 }), REVIEWER, { id, status: "rejected" });
    expect(db.data(`submissions/${id}`)).not.toHaveProperty("publishClaim");
    resume();
    await expectCode(stalled, "aborted");
    expect(db.data(`submissions/${id}`)?.status).toBe("rejected");
    expect(db.data(`publicGallery/${id}`)).toBeUndefined();
    expect(bucket.has(paths.gallery(id))).toBe(false); // the stalled publisher removed its own copy
    expect(db.data("counters/public")?.artistsParticipating).toBeUndefined();
  });
});

describe("Storage cache headers and preconditions", () => {
  it("gallery copies are public for five minutes and carry no token; everything under submissions/ stays private and is create-only", () => {
    expect(GALLERY_CACHE_CONTROL).toBe("public, max-age=300");
    expect(PRIVATE_CACHE_CONTROL).toBe("private, max-age=0");
    const src = readFileSync("functions/src/gcs.ts", "utf8");
    const copy = src.slice(src.indexOf("async function publishCopy"));
    expect(copy).toMatch(/cacheControl: GALLERY_CACHE_CONTROL/);
    expect(copy).toMatch(/metadata: \{ sourceGeneration: generation \}/);
    expect(copy).toMatch(/url: tokenlessMediaUrl\(bucket\.name, dest\)/);
    expect(copy).not.toMatch(/randomUUID|token=|firebaseStorageDownloadTokens: token/);
    expect(copy).toMatch(/ifGenerationMatch: 0/);
    const save = src.slice(src.indexOf("async function saveJpeg"), src.indexOf("async function removeObject"));
    expect(save).toMatch(/cacheControl: PRIVATE_CACHE_CONTROL/);
    expect(save).toMatch(/preconditionOpts: \{ ifGenerationMatch: 0 \}/);
    expect(save).toMatch(/=== 412\) throw new ObjectExists/);
    const download = src.slice(src.indexOf("async function download"), src.indexOf("async function generationOf"));
    expect(download).toMatch(/=== 404\) throw new ObjectGone/);
  });
});
