import { describe, expect, it } from "vitest";
import { finalizeSubmission } from "../../functions/src/finalize";
import { startSubmission } from "../../functions/src/submit";
import { handleOriginalUpload } from "../../functions/src/uploadTrigger";
import { CTX, FakeBucket, FakeDb, expectCode, fakeOps, startDeps, triggerDeps, uploadEvent, validSubmit } from "./fixtures";

async function started() {
  const db = new FakeDb();
  const bucket = new FakeBucket();
  const { deps } = startDeps(db);
  const res = await startSubmission(deps, validSubmit(), CTX);
  return { db, bucket, id: res.id, token: res.finalizeToken, number: res.number };
}

const submitAudits = (db: FakeDb) => db.collection("auditLogs").filter((a) => a.action === "submit").length;

describe("C3 finalizeSubmission: token and status guard", () => {
  it("rejects a wrong token without writing", async () => {
    const { db, id } = await started();
    const before = db.snapshot();
    await expectCode(finalizeSubmission(db, fakeOps, { id, finalizeToken: "A".repeat(43) }), "permission-denied");
    expect(db.snapshot()).toBe(before);
  });

  it("rejects malformed input and unknown ids", async () => {
    const { db, id, token } = await started();
    await expectCode(finalizeSubmission(db, fakeOps, { id, finalizeToken: "short" }), "invalid-argument");
    await expectCode(finalizeSubmission(db, fakeOps, { id: "sub_123", finalizeToken: token }), "invalid-argument");
    await expectCode(finalizeSubmission(db, fakeOps, { id, finalizeToken: token, status: "approved" }), "invalid-argument");
    await expectCode(finalizeSubmission(db, fakeOps, { id: `sub_${"f".repeat(32)}`, finalizeToken: token }), "not-found");
  });

  it("fails for uploads the server refused, with the reason in plain words", async () => {
    const { db, id, token } = await started();
    db.patch(`submissions/${id}`, { status: "rejected_upload", rejectReason: "too_large" });
    const err = await expectCode(finalizeSubmission(db, fakeOps, { id, finalizeToken: token }), "failed-precondition");
    expect(err.message).toMatch(/too large/i);
  });

  it("answers 'submitted' for a piece already past uploading, without writing", async () => {
    const { db, id, token, number } = await started();
    db.patch(`submissions/${id}`, { status: "approved" });
    const before = db.snapshot();
    expect(await finalizeSubmission(db, fakeOps, { id, finalizeToken: token })).toEqual({ ok: true, id, number, status: "submitted" });
    expect(db.snapshot()).toBe(before);
  });
});

describe("C3 finalizeSubmission: race with the upload trigger", () => {
  it("finalize first: remembers the request, the trigger completes it, counted once", async () => {
    const { db, bucket, id, token, number } = await started();

    const first = await finalizeSubmission(db, fakeOps, { id, finalizeToken: token });
    expect(first).toEqual({ ok: true, id, number, status: "processing" });
    expect(db.data(`submissions/${id}`)).toMatchObject({ status: "uploading", finalizeRequested: true });

    const quiet = db.snapshot();
    expect(await finalizeSubmission(db, fakeOps, { id, finalizeToken: token })).toEqual(first);
    expect(db.snapshot()).toBe(quiet);

    const out = await handleOriginalUpload(uploadEvent(bucket, id), triggerDeps(db, bucket));
    expect(out.outcome).toBe("submitted");
    expect(db.data(`submissions/${id}`)?.status).toBe("submitted");
    expect(db.data("counters/public")?.artworkSubmitted).toBe(1);
    expect(submitAudits(db)).toBe(1);

    const done = db.snapshot();
    expect(await finalizeSubmission(db, fakeOps, { id, finalizeToken: token })).toEqual({ ok: true, id, number, status: "submitted" });
    expect(await finalizeSubmission(db, fakeOps, { id, finalizeToken: token })).toEqual({ ok: true, id, number, status: "submitted" });
    expect(db.snapshot()).toBe(done);
    expect(db.data("counters/public")?.artworkSubmitted).toBe(1);
  });

  it("trigger first: finalize submits, then repeats are no-ops", async () => {
    const { db, bucket, id, token, number } = await started();

    const out = await handleOriginalUpload(uploadEvent(bucket, id), triggerDeps(db, bucket));
    expect(out.outcome).toBe("processed");
    expect(db.data(`submissions/${id}`)).toMatchObject({ status: "uploading", stripped: true });
    expect(db.data("counters/public")).toBeUndefined();

    expect(await finalizeSubmission(db, fakeOps, { id, finalizeToken: token })).toEqual({ ok: true, id, number, status: "submitted" });
    expect(db.data("counters/public")?.artworkSubmitted).toBe(1);

    const done = db.snapshot();
    expect(await finalizeSubmission(db, fakeOps, { id, finalizeToken: token })).toEqual({ ok: true, id, number, status: "submitted" });
    expect(db.snapshot()).toBe(done);
    expect(submitAudits(db)).toBe(1);
  });

  it("never submits a piece whose server image is missing", async () => {
    const { db, id, token } = await started();
    db.patch(`submissions/${id}`, { stripped: true, derivedGeneration: null });
    expect((await finalizeSubmission(db, fakeOps, { id, finalizeToken: token })).status).toBe("processing");
    expect(db.data(`submissions/${id}`)?.status).toBe("uploading");
  });
});
