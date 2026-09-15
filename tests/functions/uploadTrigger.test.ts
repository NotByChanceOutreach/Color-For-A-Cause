import { describe, expect, it } from "vitest";
import { MAX_UPLOAD_BYTES, paths } from "../../functions/src/constants";
import { finalizeSubmission } from "../../functions/src/finalize";
import { UPLOAD_TRIGGER_OPTIONS } from "../../functions/src/options";
import { startSubmission } from "../../functions/src/submit";
import { isOutOfMemory, isTransientError, isUnreadableImage } from "../../functions/src/transient";
import {
  GIVE_UP_AFTER_MS,
  GIVE_UP_MIN_FAILURES,
  LEASE_MS,
  LeaseBusy,
  handleOriginalUpload,
  type UploadEvent,
} from "../../functions/src/uploadTrigger";
import {
  CTX,
  FakeBucket,
  FakeDb,
  JPEG_BYTES,
  NOW,
  failTransactions,
  fakeOps,
  fakeProcess,
  loseCommitAnswer,
  reviewable,
  startDeps,
  triggerDeps,
  uploadEvent,
  validSubmit,
} from "./fixtures";

async function uploading(submit: Record<string, unknown> = {}) {
  const db = new FakeDb();
  const bucket = new FakeBucket();
  const { deps } = startDeps(db);
  const res = await startSubmission(deps, validSubmit(submit), CTX);
  return { db, bucket, id: res.id, token: res.finalizeToken };
}

/** A promise that resolves when `open()` is called, and a signal for "the run got here". */
function gate() {
  let open!: () => void;
  let reached!: () => void;
  const opened = new Promise<void>((r) => (open = r));
  const arrived = new Promise<void>((r) => (reached = r));
  return { open, opened, reached, arrived };
}

/** The live objects' generations and the row, for "nothing was damaged" checks. */
function liveGenerations(bucket: FakeBucket, id: string) {
  return {
    stripped: bucket.objects.get(paths.stripped(id))?.generation ?? null,
    derived: bucket.objects.get(paths.derived(id))?.generation ?? null,
  };
}

describe("C2 upload trigger", () => {
  it("ignores every object that is not an original upload", async () => {
    const { db, bucket, id } = await uploading();
    for (const name of [paths.stripped(id), paths.derived(id), paths.gallery(id), "coloring-pages/E01/print.png", "submissions/sub_x/original/upload"]) {
      bucket.put(name, JPEG_BYTES);
      const out = await handleOriginalUpload({ name, generation: "1", size: JPEG_BYTES.length, contentType: "image/jpeg" }, triggerDeps(db, bucket));
      expect(out.outcome).toBe("ignored");
      expect(bucket.has(name)).toBe(true);
    }
  });

  it("writes the stripped original and the public image, deletes the upload, records generation and md5", async () => {
    const { db, bucket, id } = await uploading();
    const ev = uploadEvent(bucket, id);
    const out = await handleOriginalUpload(ev, triggerDeps(db, bucket));
    expect(out.outcome).toBe("processed");
    expect(bucket.has(paths.upload(id))).toBe(false);
    const derived = bucket.objects.get(paths.derived(id))!;
    expect(bucket.objects.get(paths.stripped(id))?.data.toString()).toBe("stripped-jpeg");
    expect(derived.data.toString()).toBe("public-jpeg");
    const row = db.data(`submissions/${id}`)!;
    expect(row).toMatchObject({
      status: "uploading",
      stripped: true,
      derivedGeneration: derived.generation,
      derivedMd5: derived.md5,
      strippedGeneration: bucket.objects.get(paths.stripped(id))?.generation,
      originalPath: paths.stripped(id),
      derivedPath: paths.derived(id),
    });
    expect(row).not.toHaveProperty("processingLease");
    expect(row).not.toHaveProperty("processingAttempts");
  });

  it("passes the artist's rotate and crop choices to the image step", async () => {
    const { db, bucket, id } = await uploading({ rotate: 270, cropPct: 0.15 });
    let seen: unknown = null;
    await handleOriginalUpload(
      uploadEvent(bucket, id),
      triggerDeps(db, bucket, {
        process: async (input, opts) => {
          seen = opts;
          return { stripped: { data: input, width: 1, height: 1 }, derived: { data: input, width: 1, height: 1 } };
        },
      }),
    );
    expect(seen).toEqual({ rotate: 270, cropPct: 0.15 });
  });

  const bad: Array<[string, (bucket: FakeBucket, id: string) => UploadEvent, string, Partial<Parameters<typeof triggerDeps>[2]>?]> = [
    ["over 15 MB", (b, id) => ({ ...uploadEvent(b, id), size: MAX_UPLOAD_BYTES + 1 }), "too_large"],
    ["empty", (b, id) => ({ ...uploadEvent(b, id), size: 0 }), "empty"],
    ["a type we never signed", (b, id) => uploadEvent(b, id, JPEG_BYTES, "image/gif"), "wrong_type"],
    ["a different type than declared", (b, id) => uploadEvent(b, id, JPEG_BYTES, "image/png"), "wrong_type"],
    ["not an image", (b, id) => uploadEvent(b, id, Buffer.from("<html><script>alert(1)</script></html>")), "not_an_image"],
    ["PNG bytes sent as JPEG", (b, id) => uploadEvent(b, id, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49])), "not_an_image"],
    [
      "undecodable",
      (b, id) => uploadEvent(b, id),
      "unreadable",
      {
        process: async () => {
          throw new Error("heif: Unsupported codec");
        },
      },
    ],
  ];

  it.each(bad)("marks rejected_upload FIRST, then deletes the upload: %s", async (_name, makeEvent, reason, overrides) => {
    const { db, bucket, id } = await uploading();
    const ev = makeEvent(bucket, id);
    const statusWhenDeleted: unknown[] = [];
    const out = await handleOriginalUpload(
      ev,
      triggerDeps(db, bucket, {
        ...(overrides ?? {}),
        remove: async (path, generation) => {
          if (path === paths.upload(id)) statusWhenDeleted.push(db.data(`submissions/${id}`)?.status);
          await bucket.remove(path, generation);
        },
      }),
    );
    expect(out).toEqual({ outcome: "rejected", reason });
    expect(statusWhenDeleted).toEqual(["rejected_upload"]);
    expect(bucket.has(paths.upload(id))).toBe(false);
    expect(bucket.has(paths.derived(id))).toBe(false);
    expect(db.data(`submissions/${id}`)).toMatchObject({ status: "rejected_upload", rejectReason: reason });
    expect(db.collection("auditLogs").some((a) => a.action === "upload-rejected" && a.detail === reason)).toBe(true);
  });

  it("deletes uploads for submissions that are not uploading, and leaves them unchanged", async () => {
    const { db, bucket, id } = await reviewable();
    const before = db.data(`submissions/${id}`);
    const out = await handleOriginalUpload(uploadEvent(bucket, id), triggerDeps(db, bucket, { leaseOwner: "invocation-2" }));
    expect(out.outcome).toBe("not-uploading");
    expect(bucket.has(paths.upload(id))).toBe(false);
    expect(db.data(`submissions/${id}`)).toEqual(before);
  });

  it("deletes uploads for unknown submissions", async () => {
    const db = new FakeDb();
    const bucket = new FakeBucket();
    const id = `sub_${"e".repeat(32)}`;
    const out = await handleOriginalUpload(uploadEvent(bucket, id), triggerDeps(db, bucket));
    expect(out.outcome).toBe("missing");
    expect(bucket.has(paths.upload(id))).toBe(false);
    expect(db.docs.size).toBe(0);
  });

  it("drops a second upload once the first was processed", async () => {
    const { db, bucket, id } = await uploading();
    await handleOriginalUpload(uploadEvent(bucket, id), triggerDeps(db, bucket));
    const generation = db.data(`submissions/${id}`)?.derivedGeneration;
    const out = await handleOriginalUpload(uploadEvent(bucket, id), triggerDeps(db, bucket, { leaseOwner: "invocation-2" }));
    expect(out.outcome).toBe("already-processed");
    expect(bucket.has(paths.upload(id))).toBe(false);
    expect(db.data(`submissions/${id}`)?.derivedGeneration).toBe(generation);
  });

  it("an event for a generation older than the one being processed is superseded (it was overwritten)", async () => {
    const { db, bucket, id } = await uploading();
    const ev = uploadEvent(bucket, id);
    db.patch(`submissions/${id}`, { processingLease: { generation: "9000000000000000000", owner: "invocation-0", until: NOW + 60_000 } });
    const out = await handleOriginalUpload(ev, triggerDeps(db, bucket));
    expect(out.outcome).toBe("superseded");
  });

  it("a newer PUT while an older one is being processed waits (busy, kept), and is dropped once the first is done", async () => {
    const { db, bucket, id } = await uploading();
    db.patch(`submissions/${id}`, { processingLease: { generation: "1", owner: "invocation-0", until: NOW + 60_000 } });
    const ev = uploadEvent(bucket, id);
    await expect(handleOriginalUpload(ev, triggerDeps(db, bucket))).rejects.toBeInstanceOf(LeaseBusy);
    expect(bucket.has(paths.upload(id))).toBe(true);

    // The first run commits its derivative (of the older generation) meanwhile.
    db.patch(`submissions/${id}`, { processingLease: null, stripped: true, derivedGeneration: "1", strippedGeneration: "1" });
    expect((await handleOriginalUpload(ev, triggerDeps(db, bucket, { leaseOwner: "invocation-2" }))).outcome).toBe("already-processed");
    expect(bucket.has(paths.upload(id))).toBe(false);
  });

  it("an expired lease can be taken over", async () => {
    const { db, bucket, id } = await uploading();
    const ev = uploadEvent(bucket, id);
    db.patch(`submissions/${id}`, { processingLease: { generation: ev.generation, owner: "crashed", until: NOW - 1 } });
    expect((await handleOriginalUpload(ev, triggerDeps(db, bucket))).outcome).toBe("processed");
  });
});

describe("C2 upload trigger: delivery and retries", () => {
  it("runs with retry on; the lease outlives the trigger timeout (keeps duplicate work rare, not needed for safety)", () => {
    expect(UPLOAD_TRIGGER_OPTIONS.retry).toBe(true);
    expect(LEASE_MS).toBeGreaterThan(UPLOAD_TRIGGER_OPTIONS.timeoutSeconds * 1000);
  });

  it("a busy lease THROWS so the event is redelivered, and the upload is kept", async () => {
    const { db, bucket, id } = await uploading();
    const ev = uploadEvent(bucket, id);
    db.patch(`submissions/${id}`, { processingLease: { generation: ev.generation, owner: "invocation-0", until: NOW + 60_000 } });
    const before = db.snapshot();
    await expect(handleOriginalUpload(ev, triggerDeps(db, bucket))).rejects.toBeInstanceOf(LeaseBusy);
    expect(bucket.has(paths.upload(id))).toBe(true);
    expect(db.snapshot()).toBe(before);
  });

  it("a failure before the commit keeps the upload, frees the lease, and the retry clears the leftovers and completes", async () => {
    const { db, bucket, id, token } = await uploading();
    await finalizeSubmission(db, fakeOps, { id, finalizeToken: token }); // the browser is already waiting
    const ev = uploadEvent(bucket, id);
    failTransactions(db, [2]); // 1 = claim, 2 = the final transaction

    await expect(handleOriginalUpload(ev, triggerDeps(db, bucket))).rejects.toThrow(/UNAVAILABLE/);
    expect(bucket.has(paths.upload(id))).toBe(true);
    const mid = db.data(`submissions/${id}`)!;
    expect(mid).toMatchObject({ status: "uploading", stripped: false, derivedGeneration: null });
    expect(mid).not.toHaveProperty("processingLease");
    const leftovers = liveGenerations(bucket, id);
    expect(leftovers.derived).not.toBeNull();

    // Eventarc redelivers the same event to a new invocation.
    const out = await handleOriginalUpload(ev, triggerDeps(db, bucket, { leaseOwner: "invocation-2" }));
    expect(out.outcome).toBe("submitted");
    expect(bucket.has(paths.upload(id))).toBe(false);
    const live = liveGenerations(bucket, id);
    expect(live.derived).not.toBe(leftovers.derived);
    expect(db.data(`submissions/${id}`)).toMatchObject({ status: "submitted", stripped: true, derivedGeneration: live.derived, strippedGeneration: live.stripped });
    expect(db.data("counters/public")?.artworkSubmitted).toBe(1);
  });

  it("a crash after the commit but before the delete: the redelivery deletes the upload as already processed", async () => {
    const { db, bucket, id } = await uploading();
    const ev = uploadEvent(bucket, id);
    let failed = false;
    const flaky = triggerDeps(db, bucket, {
      remove: async (path, generation) => {
        if (path === paths.upload(id) && !failed) {
          failed = true;
          throw new Error("503 from Cloud Storage");
        }
        await bucket.remove(path, generation);
      },
    });
    await expect(handleOriginalUpload(ev, flaky)).rejects.toThrow(/503/);
    expect(bucket.has(paths.upload(id))).toBe(true);
    const committed = db.data(`submissions/${id}`)!;
    expect(committed.stripped).toBe(true);

    const out = await handleOriginalUpload(ev, triggerDeps(db, bucket, { leaseOwner: "invocation-2" }));
    expect(out.outcome).toBe("already-processed");
    expect(bucket.has(paths.upload(id))).toBe(false);
    expect(db.data(`submissions/${id}`)).toEqual(committed);
  });

  it("duplicate delivery: the same event twice at once is processed exactly once", async () => {
    const { db, bucket, id, token } = await uploading();
    await finalizeSubmission(db, fakeOps, { id, finalizeToken: token });
    const ev = uploadEvent(bucket, id);
    let saves = 0;
    const deps = (owner: string) =>
      triggerDeps(db, bucket, {
        leaseOwner: owner,
        save: async (path, data) => {
          saves += 1;
          return bucket.create(path, data);
        },
      });

    const results = await Promise.allSettled([handleOriginalUpload(ev, deps("a")), handleOriginalUpload(ev, deps("b"))]);
    const done = results.filter((r) => r.status === "fulfilled").map((r) => (r as PromiseFulfilledResult<{ outcome: string }>).value.outcome);
    const failed = results.filter((r) => r.status === "rejected").map((r) => (r as PromiseRejectedResult).reason);
    expect(done).toContain("submitted");
    // The sibling either found the lease busy (and will be retried) or arrived after the row was submitted.
    for (const outcome of done.filter((o) => o !== "submitted")) expect(outcome).toBe("not-uploading");
    for (const reason of failed) expect(reason).toBeInstanceOf(LeaseBusy);

    // Whichever copy was told to retry now finds the work done (the row is already 'submitted').
    expect((await handleOriginalUpload(ev, deps("c"))).outcome).toBe("not-uploading");
    expect(saves).toBe(2); // one stripped + one derived
    expect(bucket.has(paths.upload(id))).toBe(false);
    expect(db.data("counters/public")?.artworkSubmitted).toBe(1);
    expect(db.collection("auditLogs").filter((a) => a.action === "submit")).toHaveLength(1);
  });
});

describe("C2 upload trigger: a lost commit answer is success, never 'stale' (A1)", () => {
  it("the SDK re-runs the final transaction after it landed: the objects stay and the piece is submitted once", async () => {
    const { db, bucket, id, token } = await uploading();
    await finalizeSubmission(db, fakeOps, { id, finalizeToken: token });
    const ev = uploadEvent(bucket, id);
    loseCommitAnswer(db, 2); // 1 = claim, 2 = the final transaction

    const out = await handleOriginalUpload(ev, triggerDeps(db, bucket));
    expect(out.outcome).toBe("submitted");
    const live = liveGenerations(bucket, id);
    expect(live.stripped).not.toBeNull();
    expect(live.derived).not.toBeNull();
    expect(db.data(`submissions/${id}`)).toMatchObject({ status: "submitted", derivedGeneration: live.derived, strippedGeneration: live.stripped });
    expect(bucket.has(paths.upload(id))).toBe(false);
    expect(db.data("counters/public")?.artworkSubmitted).toBe(1);
    expect(db.collection("auditLogs").filter((a) => a.action === "submit")).toHaveLength(1);
  });

  it("without a waiting browser the re-run answers 'processed'", async () => {
    const { db, bucket, id } = await uploading();
    loseCommitAnswer(db, 2);
    const out = await handleOriginalUpload(uploadEvent(bucket, id), triggerDeps(db, bucket));
    expect(out.outcome).toBe("processed");
    expect(db.data(`submissions/${id}`)?.derivedGeneration).toBe(liveGenerations(bucket, id).derived);
  });

  it("a re-run claim transaction finds its own lease and carries on", async () => {
    const { db, bucket, id } = await uploading();
    loseCommitAnswer(db, 1);
    expect((await handleOriginalUpload(uploadEvent(bucket, id), triggerDeps(db, bucket))).outcome).toBe("processed");
  });
});

describe("C2 upload trigger: transient Storage errors are retried, not refusals (A2)", () => {
  it("a 503 while saving keeps the upload and the row, releases the lease and rethrows; the retry completes", async () => {
    const { db, bucket, id } = await uploading();
    const ev = uploadEvent(bucket, id);
    const flaky = triggerDeps(db, bucket, {
      save: async (path, data) => {
        if (path === paths.derived(id)) throw Object.assign(new Error("503 Service Unavailable"), { code: 503 });
        return bucket.create(path, data);
      },
    });
    await expect(handleOriginalUpload(ev, flaky)).rejects.toThrow(/503/);
    expect(bucket.has(paths.upload(id))).toBe(true);
    const row = db.data(`submissions/${id}`)!;
    expect(row.status).toBe("uploading");
    expect(row).not.toHaveProperty("rejectReason");
    expect(row).not.toHaveProperty("processingLease");
    expect(row.processingAttempts).toBe(0); // a known temporary failure is refunded

    const out = await handleOriginalUpload(ev, triggerDeps(db, bucket, { leaseOwner: "invocation-2" }));
    expect(out.outcome).toBe("processed");
    expect(db.data(`submissions/${id}`)?.derivedGeneration).toBe(liveGenerations(bucket, id).derived);
    expect(bucket.has(paths.upload(id))).toBe(false);
  });

  it("a 503 while downloading keeps the upload and rethrows; the retry completes", async () => {
    const { db, bucket, id } = await uploading();
    const ev = uploadEvent(bucket, id);
    const flaky = triggerDeps(db, bucket, {
      download: async () => {
        throw Object.assign(new Error("503 Service Unavailable"), { code: 503 });
      },
    });
    await expect(handleOriginalUpload(ev, flaky)).rejects.toThrow(/503/);
    expect(bucket.has(paths.upload(id))).toBe(true);
    expect(db.data(`submissions/${id}`)?.status).toBe("uploading");
    expect((await handleOriginalUpload(ev, triggerDeps(db, bucket, { leaseOwner: "invocation-2" }))).outcome).toBe("processed");
  });

});

describe("C2 upload trigger: giving up needs 20 hours AND 5 counted failures (round 3)", () => {
  const HOUR = 60 * 60 * 1000;
  const storage503 = () => Object.assign(new Error("503 Service Unavailable"), { code: 503 });
  const mystery = () => new Error("something nobody expected");
  const failing = (db: FakeDb, bucket: FakeBucket, owner: string, at: number, err: () => unknown) =>
    triggerDeps(db, bucket, {
      leaseOwner: owner,
      now: () => at,
      download: async () => {
        throw err();
      },
    });

  it("the budget is a time cap inside Eventarc's 24 h retry window, not a count", () => {
    expect(GIVE_UP_AFTER_MS).toBe(20 * HOUR);
    expect(GIVE_UP_AFTER_MS).toBeLessThan(24 * HOUR);
    expect(GIVE_UP_MIN_FAILURES).toBe(5);
  });

  it("a Storage outage of any length never refuses a good picture: every known temporary failure is refunded", async () => {
    const { db, bucket, id } = await uploading();
    const ev = uploadEvent(bucket, id);
    for (let i = 0; i < 12; i++) {
      await expect(handleOriginalUpload(ev, failing(db, bucket, `outage-${i}`, NOW + i * 2 * HOUR, storage503))).rejects.toThrow(/503/);
      const row = db.data(`submissions/${id}`)!;
      expect(row.processingAttempts).toBe(0);
      expect(row.status).toBe("uploading");
      expect(bucket.has(paths.upload(id))).toBe(true);
    }
    const out = await handleOriginalUpload(ev, triggerDeps(db, bucket, { leaseOwner: "recovered", now: () => NOW + 23 * HOUR }));
    expect(out.outcome).toBe("processed");
    expect(bucket.has(paths.upload(id))).toBe(false);
  });

  const TEMPORARY: Array<[string, () => unknown]> = [
    ["Storage 500", () => Object.assign(new Error("backend error"), { code: 500 })],
    ["Storage 429", () => Object.assign(new Error("rate limited"), { code: 429 })],
    ["gaxios response 502", () => Object.assign(new Error("bad gateway"), { response: { status: 502 } })],
    ["ECONNRESET", () => Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" })],
    ["ETIMEDOUT", () => Object.assign(new Error("connect ETIMEDOUT"), { code: "ETIMEDOUT" })],
    ["socket hang up", () => new Error("socket hang up")],
    ["a wrapped socket error", () => new Error("fetch failed", { cause: { code: "UND_ERR_SOCKET" } })],
    ["Firestore UNAVAILABLE", () => Object.assign(new Error("14 UNAVAILABLE: no connection"), { code: 14 })],
    ["Firestore DEADLINE_EXCEEDED", () => Object.assign(new Error("4 DEADLINE_EXCEEDED: deadline"), { code: 4 })],
    ["Firestore ABORTED", () => Object.assign(new Error("10 ABORTED: contention"), { code: 10 })],
    ["Firestore RESOURCE_EXHAUSTED", () => Object.assign(new Error("8 RESOURCE_EXHAUSTED: quota"), { code: 8 })],
  ];
  it.each(TEMPORARY)("%s is refunded and rethrown", async (_name, err) => {
    const { db, bucket, id } = await uploading();
    const ev = uploadEvent(bucket, id);
    await expect(handleOriginalUpload(ev, failing(db, bucket, "a", NOW, err))).rejects.toBeTruthy();
    expect(db.data(`submissions/${id}`)?.processingAttempts).toBe(0);
    expect(db.data(`submissions/${id}`)).not.toHaveProperty("processingLease");
    expect(bucket.has(paths.upload(id))).toBe(true);
  });

  it("a Firestore UNAVAILABLE on the final transaction is refunded too", async () => {
    const { db, bucket, id } = await uploading();
    const ev = uploadEvent(bucket, id);
    failTransactions(db, [2], "14 UNAVAILABLE: the database hiccuped");
    await expect(handleOriginalUpload(ev, triggerDeps(db, bucket))).rejects.toThrow(/UNAVAILABLE/);
    expect(db.data(`submissions/${id}`)?.processingAttempts).toBe(0);
  });

  it("unknown failures count, but 5 of them within 20 hours do not refuse the picture", async () => {
    const { db, bucket, id } = await uploading();
    const ev = uploadEvent(bucket, id);
    for (let i = 0; i < GIVE_UP_MIN_FAILURES; i++) {
      await expect(handleOriginalUpload(ev, failing(db, bucket, `u-${i}`, NOW + i * HOUR, mystery))).rejects.toThrow(/nobody expected/);
      expect(db.data(`submissions/${id}`)?.processingAttempts).toBe(i + 1);
    }
    const out = await handleOriginalUpload(ev, triggerDeps(db, bucket, { leaseOwner: "healthy", now: () => NOW + 6 * HOUR }));
    expect(out.outcome).toBe("processed");
  });

  it("after 20 hours and 5 counted failures the upload is refused, and the row is marked before the upload goes", async () => {
    const { db, bucket, id } = await uploading();
    const ev = uploadEvent(bucket, id);
    for (let i = 0; i < GIVE_UP_MIN_FAILURES; i++) {
      await expect(handleOriginalUpload(ev, failing(db, bucket, `u-${i}`, NOW + i * HOUR, mystery))).rejects.toThrow();
    }
    const statusWhenDeleted: unknown[] = [];
    const out = await handleOriginalUpload(
      ev,
      triggerDeps(db, bucket, {
        leaseOwner: "late",
        now: () => NOW + GIVE_UP_AFTER_MS,
        remove: async (path, generation) => {
          if (path === paths.upload(id)) statusWhenDeleted.push(db.data(`submissions/${id}`)?.status);
          await bucket.remove(path, generation);
        },
      }),
    );
    expect(out).toEqual({ outcome: "rejected", reason: "processing_failed" });
    expect(statusWhenDeleted).toEqual(["rejected_upload"]);
    expect(db.data(`submissions/${id}`)).toMatchObject({ status: "rejected_upload", rejectReason: "processing_failed" });
    expect(bucket.has(paths.upload(id))).toBe(false);
  });

  it("after 20 hours but fewer than 5 counted failures the picture is still processed", async () => {
    const { db, bucket, id } = await uploading();
    const ev = uploadEvent(bucket, id);
    for (let i = 0; i < GIVE_UP_MIN_FAILURES - 1; i++) {
      await expect(handleOriginalUpload(ev, failing(db, bucket, `u-${i}`, NOW + i * HOUR, mystery))).rejects.toThrow();
    }
    const out = await handleOriginalUpload(ev, triggerDeps(db, bucket, { leaseOwner: "late", now: () => NOW + 21 * HOUR }));
    expect(out.outcome).toBe("processed");
  });

  it("a slow fifth attempt that outlives its lease counts, but the next delivery before 20 hours still processes (S6)", async () => {
    const { db, bucket, id } = await uploading();
    const ev = uploadEvent(bucket, id);
    for (let i = 0; i < GIVE_UP_MIN_FAILURES - 1; i++) {
      await expect(handleOriginalUpload(ev, failing(db, bucket, `u-${i}`, NOW + i * HOUR, mystery))).rejects.toThrow();
    }
    const g = gate();
    const slow = handleOriginalUpload(
      ev,
      triggerDeps(db, bucket, {
        leaseOwner: "slow",
        now: () => NOW + 5 * HOUR,
        process: async () => {
          g.reached();
          await g.opened;
          return fakeProcess();
        },
      }),
    );
    await g.arrived;
    // It never reached its own error handling (the platform timed it out): the attempt stays counted.
    expect(db.data(`submissions/${id}`)?.processingAttempts).toBe(GIVE_UP_MIN_FAILURES);
    const next = await handleOriginalUpload(ev, triggerDeps(db, bucket, { leaseOwner: "next", now: () => NOW + 5 * HOUR + LEASE_MS + 1 }));
    expect(next.outcome).toBe("processed");
    g.open();
    expect((await slow).outcome).toBe("stale");
    expect(db.data(`submissions/${id}`)?.status).toBe("uploading");
    expect(db.data(`submissions/${id}`)?.stripped).toBe(true);
  });

  /** The instance ran out of something: never a refusal (round 4, C). Strings from the shipped libvips/libjpeg/libpng and Node. */
  const OUT_OF_RESOURCES: Array<[string, () => unknown]> = [
    ["vips_malloc: out of memory", () => new Error("vips_malloc: out of memory")],
    ["std::bad_alloc", () => new Error("std::bad_alloc")],
    ["libjpeg's own out-of-memory", () => new Error("VipsJpeg: Insufficient memory (case 4)")],
    ["a header failure that wraps libjpeg's out-of-memory", () => new Error("Input buffer has corrupt header: VipsJpeg: Insufficient memory (case 4)")],
    ["libpng's insufficient memory", () => new Error("pngload_buffer: Insufficient memory to process iCCP chunk")],
    ["insufficient memory", () => new Error("insufficient memory")],
    ["Not enough memory", () => new Error("Not enough memory")],
    ["Memory allocation error", () => new Error("Memory allocation error")],
    ["memory allocation failed", () => new Error("vips: memory allocation failed")],
    ["unable to create thread", () => new Error("vips_threadset_add: unable to create thread")],
    ["Node's Array buffer allocation failed", () => new RangeError("Array buffer allocation failed")],
    ["ENOMEM", () => Object.assign(new Error("spawn ENOMEM"), { code: "ENOMEM" })],
    ["ENOSPC (a full memory-backed /tmp)", () => Object.assign(new Error("ENOSPC: no space left on device, write"), { code: "ENOSPC" })],
    ["No space left on device", () => new Error("vips__file_open_write: unable to write: No space left on device")],
    ["an ENOMEM code alone", () => Object.assign(new Error("spawn failed"), { code: "ENOMEM" })],
    ["an ENOSPC code alone", () => Object.assign(new Error("write failed"), { code: "ENOSPC" })],
  ];
  it.each(OUT_OF_RESOURCES)("%s: retried and counted, never a refusal", async (_name, make) => {
    const { db, bucket, id } = await uploading();
    const ev = uploadEvent(bucket, id);
    const err = make();
    expect(isOutOfMemory(err)).toBe(true);
    expect(isUnreadableImage(err)).toBe(false);
    const oom = triggerDeps(db, bucket, {
      leaseOwner: "oom",
      process: async () => {
        throw err;
      },
    });
    await expect(handleOriginalUpload(ev, oom)).rejects.toBe(err);
    const row = db.data(`submissions/${id}`)!;
    expect(row).toMatchObject({ status: "uploading", processingAttempts: 1 });
    expect(row).not.toHaveProperty("rejectReason");
    expect(row).not.toHaveProperty("processingLease");
    expect(bucket.has(paths.upload(id))).toBe(true);
    expect((await handleOriginalUpload(ev, triggerDeps(db, bucket, { leaseOwner: "retry" }))).outcome).toBe("processed");
  });

  /** What sharp 0.35 says for files it cannot decode, recorded from real corrupt inputs (image.test.ts checks them live). */
  const DECODE_FAILURES = [
    "Input buffer contains unsupported image format",
    "Input buffer has corrupt header: VipsJpeg: premature end of JPEG image\nVipsJpeg: Bogus marker length\nVipsJpeg: premature end of JPEG image",
    "Input buffer has corrupt header: VipsJpeg: premature end of JPEG image\nVipsJpeg: JPEG datastream contains no image",
    "Input buffer has corrupt header:",
    "Input buffer has corrupt header: webp: unable to parse image",
    "Input buffer has corrupt header: source: bad seek to 1024\nheif: Invalid input: Unspecified: Insufficient input data (2.0)",
    "vipspng: libpng read error",
    "pngload_buffer: load error\npngload_buffer: load error",
    "Input image exceeds pixel limit",
    "Input Buffer is empty",
    "heif: Unsupported codec",
    "VipsJpeg: Corrupt JPEG data: premature end of data segment",
    "VipsJpeg: Premature end of JPEG file",
    "VipsJpeg: Invalid JPEG file structure: two SOI markers",
    "IDAT: CRC error",
  ];
  it.each(DECODE_FAILURES)("a known decode failure is a refusal (unreadable): %j", async (message) => {
    const { db, bucket, id } = await uploading();
    const err = new Error(message);
    expect(isUnreadableImage(err)).toBe(true);
    expect(isOutOfMemory(err)).toBe(false);
    const out = await handleOriginalUpload(
      uploadEvent(bucket, id),
      triggerDeps(db, bucket, {
        process: async () => {
          throw err;
        },
      }),
    );
    expect(out).toEqual({ outcome: "rejected", reason: "unreadable" });
    expect(db.data(`submissions/${id}`)).toMatchObject({ status: "rejected_upload", rejectReason: "unreadable" });
    expect(bucket.has(paths.upload(id))).toBe(false);
  });

  const UNKNOWN_IMAGE_ERRORS = [
    "Unknown error", // sharp, when libvips left no message (its process-wide error buffer was cleared by another call)
    "vips_colourspace: no known route from 'b-w' to 'srgb'",
    "extract_area: bad extract area",
    "VipsJpeg: a message this list has never seen",
    "Expected positive integer for width but received -1 of type number",
    "Cannot read properties of undefined (reading 'width')",
  ];
  it.each(UNKNOWN_IMAGE_ERRORS)("any other image error is rethrown and counted, never an immediate refusal: %j", async (message) => {
    const { db, bucket, id } = await uploading();
    const ev = uploadEvent(bucket, id);
    expect(isUnreadableImage(new Error(message))).toBe(false);
    const odd = triggerDeps(db, bucket, {
      leaseOwner: "odd",
      process: async () => {
        throw new Error(message);
      },
    });
    await expect(handleOriginalUpload(ev, odd)).rejects.toThrow(message);
    expect(db.data(`submissions/${id}`)).toMatchObject({ status: "uploading", processingAttempts: 1 });
    expect(db.data(`submissions/${id}`)).not.toHaveProperty("rejectReason");
    expect(bucket.has(paths.upload(id))).toBe(true);
  });

  it("an image error nobody recognises can only be ended by the 20 hour cap", async () => {
    const { db, bucket, id } = await uploading();
    const ev = uploadEvent(bucket, id);
    const odd = (owner: string, at: number) =>
      triggerDeps(db, bucket, {
        leaseOwner: owner,
        now: () => at,
        process: async () => {
          throw new Error("vips_something: unexpected");
        },
      });
    for (let i = 0; i < GIVE_UP_MIN_FAILURES + 2; i++) {
      await expect(handleOriginalUpload(ev, odd(`odd-${i}`, NOW + i * HOUR))).rejects.toThrow(/unexpected/);
      expect(db.data(`submissions/${id}`)?.status).toBe("uploading");
    }
    expect(await handleOriginalUpload(ev, odd("late", NOW + GIVE_UP_AFTER_MS))).toEqual({ outcome: "rejected", reason: "processing_failed" });
  });

  it("strings and error-less values are classified too", () => {
    expect(isOutOfMemory("Not enough memory")).toBe(true);
    expect(isOutOfMemory(null)).toBe(false);
    expect(isUnreadableImage("Input buffer contains unsupported image format")).toBe(false); // not an Error
    expect(isUnreadableImage(null)).toBe(false);
  });

  it("the age is measured from the object's creation time when the event carries it", async () => {
    const old = await uploading();
    old.db.patch(`submissions/${old.id}`, { processingAttempts: GIVE_UP_MIN_FAILURES });
    const oldEvent = { ...uploadEvent(old.bucket, old.id), timeCreatedMs: NOW - 21 * HOUR };
    expect((await handleOriginalUpload(oldEvent, triggerDeps(old.db, old.bucket))).outcome).toBe("rejected");

    const fresh = await uploading();
    fresh.db.patch(`submissions/${fresh.id}`, { processingAttempts: GIVE_UP_MIN_FAILURES });
    const freshEvent = { ...uploadEvent(fresh.bucket, fresh.id), timeCreatedMs: NOW - HOUR };
    expect((await handleOriginalUpload(freshEvent, triggerDeps(fresh.db, fresh.bucket))).outcome).toBe("processed");
  });

  it("the first claim records processingSince, later claims keep it, and the commit clears it", async () => {
    const { db, bucket, id } = await uploading();
    const ev = uploadEvent(bucket, id);
    await expect(handleOriginalUpload(ev, failing(db, bucket, "first", NOW, mystery))).rejects.toThrow();
    expect(db.data(`submissions/${id}`)?.processingSince).toBe(NOW);
    await expect(handleOriginalUpload(ev, failing(db, bucket, "second", NOW + HOUR, mystery))).rejects.toThrow();
    expect(db.data(`submissions/${id}`)?.processingSince).toBe(NOW);
    await handleOriginalUpload(ev, triggerDeps(db, bucket, { leaseOwner: "third", now: () => NOW + 2 * HOUR }));
    expect(db.data(`submissions/${id}`)).not.toHaveProperty("processingSince");
  });
});

describe("C2 which failures are known to be temporary (transient.ts)", () => {
  it.each([
    [{ code: 503 }],
    [{ code: 500 }],
    [{ code: 429 }],
    [{ code: 408 }],
    [{ code: "503" }],
    [{ status: 504 }],
    [{ response: { status: 503 } }],
    [{ code: 14 }],
    [{ code: 4 }],
    [{ code: 10 }],
    [{ code: 8 }],
    [{ code: "unavailable" }],
    [{ code: "deadline-exceeded" }],
    [{ code: "ECONNRESET" }],
    [{ code: "EAI_AGAIN" }],
    [new Error("14 UNAVAILABLE: No connection established")],
    [new Error("DEADLINE_EXCEEDED: took too long")],
    [new Error("socket hang up")],
    [new Error("outer", { cause: new Error("inner", { cause: { code: "ETIMEDOUT" } }) })],
  ])("temporary: %j", (err) => {
    expect(isTransientError(err)).toBe(true);
  });

  it.each([
    [{ code: 400 }],
    [{ code: 403 }],
    [{ code: 404 }],
    [{ code: 412 }],
    [{ code: 3 }],
    [{ code: 7 }],
    [{ code: 9 }],
    [{ code: "permission-denied" }],
    [new Error("boom")],
    [new Error("503 Service Unavailable")],
    [null],
    ["UNAVAILABLE"],
  ])("unknown: %j", (err) => {
    expect(isTransientError(err)).toBe(false);
  });
});

describe("C2 upload trigger: fencing, so a run that outlived its lease cannot do harm (A3)", () => {
  it("a zombie that resumes after another run committed leaves the committed objects, row and upload state alone", async () => {
    const { db, bucket, id, token } = await uploading();
    await finalizeSubmission(db, fakeOps, { id, finalizeToken: token });
    const ev = uploadEvent(bucket, id);
    const g = gate();
    const zombie = handleOriginalUpload(
      ev,
      triggerDeps(db, bucket, {
        leaseOwner: "zombie",
        process: async () => {
          g.reached();
          await g.opened;
          return fakeProcess();
        },
      }),
    );
    await g.arrived;

    // The zombie's lease runs out; a redelivery takes over and finishes.
    const successor = await handleOriginalUpload(ev, triggerDeps(db, bucket, { leaseOwner: "successor", now: () => NOW + LEASE_MS + 1 }));
    expect(successor.outcome).toBe("submitted");
    const committed = db.data(`submissions/${id}`);
    const live = liveGenerations(bucket, id);

    g.open();
    expect((await zombie).outcome).toBe("stale");
    expect(liveGenerations(bucket, id)).toEqual(live);
    expect(db.data(`submissions/${id}`)).toEqual(committed);
    expect(db.data(`submissions/${id}`)?.derivedGeneration).toBe(live.derived);
    expect(db.data("counters/public")?.artworkSubmitted).toBe(1);
  });

  it("a zombie that already wrote its objects: the successor replaces them by generation; the zombie's cleanup spares the successor's", async () => {
    const { db, bucket, id } = await uploading();
    const ev = uploadEvent(bucket, id);
    const g = gate();
    const zombie = handleOriginalUpload(
      ev,
      triggerDeps(db, bucket, {
        leaseOwner: "zombie",
        save: async (path, data) => {
          const made = await bucket.create(path, data);
          if (path === paths.derived(id)) {
            g.reached();
            await g.opened;
          }
          return made;
        },
      }),
    );
    await g.arrived;
    const zombieObjects = liveGenerations(bucket, id);

    const successor = await handleOriginalUpload(ev, triggerDeps(db, bucket, { leaseOwner: "successor", now: () => NOW + LEASE_MS + 1 }));
    expect(successor.outcome).toBe("processed");
    const live = liveGenerations(bucket, id);
    expect(live.derived).not.toBe(zombieObjects.derived);
    expect(live.stripped).not.toBe(zombieObjects.stripped);

    g.open();
    expect((await zombie).outcome).toBe("stale");
    expect(liveGenerations(bucket, id)).toEqual(live);
    expect(db.data(`submissions/${id}`)).toMatchObject({ stripped: true, derivedGeneration: live.derived, strippedGeneration: live.stripped });
  });

  it("a zombie cannot refuse the upload while the successor holds the row", async () => {
    const { db, bucket, id } = await uploading();
    const ev = uploadEvent(bucket, id);
    const z = gate();
    const s = gate();
    const zombie = handleOriginalUpload(
      ev,
      triggerDeps(db, bucket, {
        leaseOwner: "zombie",
        process: async () => {
          z.reached();
          await z.opened;
          // A known decode failure: the zombie tries to refuse the upload (an unknown error would only be rethrown).
          throw new Error("Input buffer contains unsupported image format");
        },
      }),
    );
    await z.arrived;
    const successor = handleOriginalUpload(
      ev,
      triggerDeps(db, bucket, {
        leaseOwner: "successor",
        now: () => NOW + LEASE_MS + 1,
        process: async () => {
          s.reached();
          await s.opened;
          return fakeProcess();
        },
      }),
    );
    await s.arrived;

    z.open();
    expect((await zombie).outcome).toBe("stale");
    expect(db.data(`submissions/${id}`)?.status).toBe("uploading");
    expect(bucket.has(paths.upload(id))).toBe(true); // the successor still needs it

    s.open();
    expect((await successor).outcome).toBe("processed");
    expect(bucket.has(paths.upload(id))).toBe(false);
  });
});

describe("C2 upload trigger: the signed URL used twice (A4)", () => {
  it("a generation overwritten before its run downloads it is 'superseded', not refused; the newer one is processed", async () => {
    const { db, bucket, id } = await uploading();
    const first = uploadEvent(bucket, id);
    let second: UploadEvent | null = null;
    const out = await handleOriginalUpload(
      first,
      triggerDeps(db, bucket, {
        download: async (path, generation) => {
          second = uploadEvent(bucket, id); // the same URL PUT again: a newer generation replaces the first
          return bucket.download(path, generation);
        },
      }),
    );
    expect(out.outcome).toBe("superseded");
    const row = db.data(`submissions/${id}`)!;
    expect(row.status).toBe("uploading");
    expect(row).not.toHaveProperty("rejectReason");
    expect(row).not.toHaveProperty("processingLease");
    expect(row.processingAttempts).toBe(0); // a superseded run does not count against the limit
    expect(bucket.has(paths.upload(id))).toBe(true);

    const next = await handleOriginalUpload(second!, triggerDeps(db, bucket, { leaseOwner: "invocation-2" }));
    expect(next.outcome).toBe("processed");
    expect(bucket.has(paths.upload(id))).toBe(false);
    expect(db.data(`submissions/${id}`)?.derivedGeneration).toBe(liveGenerations(bucket, id).derived);
  });
});
