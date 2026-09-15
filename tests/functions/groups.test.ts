import { describe, expect, it } from "vitest";
import { createGroup, getGroup, type GroupDeps } from "../../functions/src/groups";
import type { Data } from "../../functions/src/store";
import { FakeDb, NOW, expectCode, fakeOps } from "./fixtures";

function deps(db: FakeDb, rateLimit: () => Promise<void> = async () => undefined): GroupDeps {
  return {
    db,
    ops: fakeOps,
    now: () => NOW,
    rateLimit,
    findByPublicId: async (publicId) => db.collection("groups").find((g: Data) => g.publicId === publicId) ?? null,
  };
}

describe("groups never hand out the internal id", () => {
  it("createGroup returns only publicId, label and createdAt; the grp_ id stays in Firestore", async () => {
    const db = new FakeDb();
    const view = await createGroup(deps(db), { label: "Art day at the library" });
    expect(Object.keys(view).sort()).toEqual(["createdAt", "label", "publicId"]);
    expect(view.publicId).toMatch(/^[0-9a-f]{12}$/);
    expect(JSON.stringify(view)).not.toMatch(/grp_/);
    const [stored] = db.collection("groups");
    expect(stored.id).toMatch(/^grp_[0-9a-f]{32}$/);
    expect(stored.publicId).toBe(view.publicId);
  });

  it("getGroup returns only publicId, label and createdAt, or null", async () => {
    const db = new FakeDb();
    const made = await createGroup(deps(db), { label: "Troop 5" });
    const found = await getGroup(deps(db), { publicId: made.publicId });
    expect(found).toEqual({ publicId: made.publicId, label: "Troop 5", createdAt: expect.any(String) });
    expect(JSON.stringify(found)).not.toMatch(/grp_/);
    expect(await getGroup(deps(db), { publicId: "0123456789ab" })).toBeNull();
    await expectCode(getGroup(deps(db), { publicId: "grp_1" }), "invalid-argument");
  });

  it("createGroup stores and returns a cleaned label, with no joiner left dangling", async () => {
    const db = new FakeDb();
    const made = await createGroup(deps(db), { label: "Art\u{200c}\u{034f}" });
    expect(made.label).toBe("Art");
    expect(db.collection("groups")[0].label).toBe("Art");
    expect((await getGroup(deps(db), { publicId: made.publicId }))?.label).toBe("Art");
  });

  it("createGroup falls back to 'Art day' when nothing readable is left", async () => {
    const db = new FakeDb();
    for (const label of ["\u{2800}\u{2800}", "\u{fffc}", "\u{200b}\u{202e}", "..."]) {
      expect((await createGroup(deps(db), { label })).label).toBe("Art day");
    }
  });

  it("getGroup cleans a label stored under the old rules (9b2fc57 kept it raw), with a safe fallback", async () => {
    const db = new FakeDb();
    const legacy = (publicId: string, label: unknown) => db.patch(`groups/grp_${publicId}`, { id: `grp_${publicId}`, publicId, label });
    legacy("0123456789ab", "\u{200b}\u{202e}evil\u{2800}\u{2800}");
    legacy("0123456789ac", "\u{2800}\u{3164}\u{200d}");
    legacy("0123456789ad", 42);
    legacy("0123456789ae", `${"l".repeat(119)}\u{1f469}\u{200d}\u{1f3a8}`);
    expect((await getGroup(deps(db), { publicId: "0123456789ab" }))?.label).toBe("evil");
    expect((await getGroup(deps(db), { publicId: "0123456789ac" }))?.label).toBe("Art day");
    expect((await getGroup(deps(db), { publicId: "0123456789ad" }))?.label).toBe("Art day");
    // Capped at 120 code units without splitting a character, and no joiner left at the cut.
    expect((await getGroup(deps(db), { publicId: "0123456789ae" }))?.label).toBe("l".repeat(119));
  });

  it("createGroup is rate-limited before anything is written", async () => {
    const db = new FakeDb();
    await expectCode(
      createGroup(
        deps(db, async () => {
          throw Object.assign(new Error("slow down"), { code: "resource-exhausted" });
        }),
        { label: "x" },
      ),
      "resource-exhausted",
    );
    expect(db.docs.size).toBe(0);
  });
});
