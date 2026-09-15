import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { MAX_UPLOAD_BYTES, UPLOAD_TYPES } from "../../functions/src/constants";
import { AppError } from "../../functions/src/errors";
import { startSubmission } from "../../functions/src/submit";
import { uploadRequestHeaders, uploadUrlConfig } from "../../functions/src/upload";
import { CTX, KNOWN_GROUP, NOW, expectCode, startDeps, validSubmit } from "./fixtures";

describe("C1 submitArtwork: one signed PUT for the original", () => {
  it("returns only the original's upload URL and a finalize token", async () => {
    const { deps, signed } = startDeps();
    const res = await startSubmission(deps, validSubmit(), CTX);
    expect(Object.keys(res).sort()).toEqual(["expiresAt", "finalizeToken", "id", "number", "uploadHeaders", "uploadUrl"]);
    expect(res.id).toMatch(/^sub_[0-9a-f]{32}$/);
    expect(signed).toHaveLength(1);
    expect(signed[0].path).toBe(`submissions/${res.id}/original/upload`);
    expect(res.uploadUrl).toContain(`submissions/${res.id}/original/upload`);
    expect(JSON.stringify(res)).not.toMatch(/derived/i);
  });

  it("signs a V4 write URL for at most 5 minutes with the size-range header and exact type", async () => {
    const { deps, signed } = startDeps();
    const res = await startSubmission(deps, validSubmit({ originalMime: "image/png" }), CTX);
    const cfg = signed[0].config;
    expect(cfg.version).toBe("v4");
    expect(cfg.action).toBe("write");
    expect(cfg.expires - NOW).toBe(5 * 60 * 1000);
    expect(cfg.contentType).toBe("image/png");
    expect(cfg.extensionHeaders).toEqual({ "x-goog-content-length-range": "1,15728640" });
    expect(res.uploadHeaders).toEqual({ "Content-Type": "image/png", "x-goog-content-length-range": "1,15728640" });
    expect(Date.parse(res.expiresAt)).toBe(NOW + 5 * 60 * 1000);
  });

  it("never signs longer than 5 minutes, for every allowed type", () => {
    expect(MAX_UPLOAD_BYTES).toBe(15_728_640);
    for (const type of UPLOAD_TYPES) {
      const cfg = uploadUrlConfig(type, NOW);
      expect(cfg.expires - NOW).toBeLessThanOrEqual(5 * 60 * 1000);
      expect(cfg.contentType).toBe(type);
      expect(uploadRequestHeaders(type)).toEqual({ "Content-Type": type, "x-goog-content-length-range": "1,15728640" });
    }
  });

  it.each(["image/jpeg", "image/png", "image/heic", "image/heif", "image/webp"])("accepts %s", async (type) => {
    const { deps, signed } = startDeps();
    await startSubmission(deps, validSubmit({ originalMime: type }), CTX);
    expect(signed[0].config.contentType).toBe(type);
  });

  it.each(["image/gif", "image/svg+xml", "text/html", "image/jpg", "application/pdf", "", null])("rejects type %j", async (type) => {
    const { deps, signed, db } = startDeps();
    await expectCode(startSubmission(deps, validSubmit({ originalMime: type }), CTX), "invalid-argument");
    expect(signed).toHaveLength(0);
    expect(db.docs.size).toBe(0);
  });

  it("allows 1 byte to 15 MB, whole bytes only", async () => {
    const { deps } = startDeps();
    await startSubmission(deps, validSubmit({ originalBytes: MAX_UPLOAD_BYTES }), CTX);
    await startSubmission(deps, validSubmit({ originalBytes: 1 }), CTX);
    for (const bad of [0, -1, MAX_UPLOAD_BYTES + 1, 12.5, "100", null]) {
      await expectCode(startSubmission(deps, validSubmit({ originalBytes: bad }), CTX), "invalid-argument");
    }
  });

  it("stores only the SHA-256 of the finalize token and a generic file name", async () => {
    const { deps, db } = startDeps();
    const res = await startSubmission(deps, validSubmit({ originalName: "Jane Smith 12 Oak Street.jpg" }), CTX);
    const row = db.data(`submissions/${res.id}`)!;
    expect(res.finalizeToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(row.finalizeTokenHash).toBe(createHash("sha256").update(res.finalizeToken).digest("hex"));
    expect(db.snapshot()).not.toContain(res.finalizeToken);
    expect(db.snapshot()).not.toContain("Jane Smith");
    expect(row).toMatchObject({
      status: "uploading",
      originalName: "artwork.jpg",
      originalPath: `submissions/${res.id}/original/upload`,
      stripped: false,
      derivedGeneration: null,
      finalizeRequested: false,
    });
    const consent = db.data(`consents/${row.consentId}`)!;
    expect(consent.documentVersion).toBe("0.1-DRAFT-LEGAL-REVIEW");
  });

  it("refuses without storage permission and writes nothing", async () => {
    const { deps, db, signed } = startDeps();
    const perms = { ...(validSubmit().permissions as object), store: false };
    await expectCode(startSubmission(deps, validSubmit({ permissions: perms }), CTX), "failed-precondition");
    expect(db.docs.size).toBe(0);
    expect(signed).toHaveLength(0);
  });

  it("rate-limits before writing anything", async () => {
    const { deps, db } = startDeps(undefined, {
      rateLimit: async () => {
        throw new AppError("resource-exhausted", "slow down");
      },
    });
    await expectCode(startSubmission(deps, validSubmit(), CTX), "resource-exhausted");
    expect(db.docs.size).toBe(0);
  });

  it("only accepts group codes that exist", async () => {
    const { deps, db } = startDeps();
    const res = await startSubmission(deps, validSubmit({ groupId: KNOWN_GROUP }), CTX);
    expect(db.data(`submissions/${res.id}`)?.groupId).toBe(KNOWN_GROUP);
    await expectCode(startSubmission(deps, validSubmit({ groupId: "0123456789ab" }), CTX), "invalid-argument");
  });

  it("an existing group code uses the group bucket; none or a made-up one spends the per-IP bucket", async () => {
    const { deps, buckets } = startDeps();
    await startSubmission(deps, validSubmit({ groupId: KNOWN_GROUP }), CTX);
    await startSubmission(deps, validSubmit(), CTX);
    await expectCode(startSubmission(deps, validSubmit({ groupId: "0123456789ab" }), CTX), "invalid-argument");
    expect(buckets).toEqual([KNOWN_GROUP, null, null]);
  });

  it("keeps an odd user agent readable instead of refusing the art", async () => {
    const { deps, db } = startDeps();
    const res = await startSubmission(deps, validSubmit(), { userAgent: "Mozilla\ud800/5.0​" });
    const consentId = db.data(`submissions/${res.id}`)?.consentId;
    expect(db.data(`consents/${consentId}`)?.userAgent).toBe("Mozilla/5.0");
  });
});
