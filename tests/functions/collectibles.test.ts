import { describe, expect, it } from "vitest";
import { contributionDelta, impactContribution, upsertCollectible } from "../../functions/src/collectibles";
import { expectCode, fakeOps, reviewable, validSubmit } from "./fixtures";

const IMPACT = { uid: "staff-impact", role: "IMPACT_MANAGER" };
const withCollectiblePermission = { permissions: { ...(validSubmit().permissions as object), collectible: true } };

function collectible(submissionId: string, overrides: Record<string, unknown> = {}) {
  return {
    id: null,
    submissionId,
    status: "created",
    chain: null,
    contract: null,
    tokenId: null,
    txHash: null,
    metadataUri: null,
    marketplaceUrl: null,
    impactPackage: "A",
    impactStatus: "funded",
    impactVerified: true,
    ...overrides,
  };
}

describe("collectibles: counters by increments", () => {
  it("unverified records count for nothing; packages add tents and bags", () => {
    expect(impactContribution({ status: "created", impactVerified: false, impactPackage: "B", impactStatus: "funded" })).toEqual({
      collectiblesCreated: 0,
      tentsFunded: 0,
      sleepingBagsFunded: 0,
    });
    expect(impactContribution({ status: "created", impactVerified: true, impactPackage: "B", impactStatus: "distributed" })).toEqual({
      collectiblesCreated: 1,
      tentsFunded: 1,
      sleepingBagsFunded: 6,
    });
    expect(contributionDelta(null, { status: "draft", impactVerified: true, impactPackage: "A", impactStatus: "not_yet_funded" })).toEqual({});
  });

  it("only impact staff can write", async () => {
    const { db, id } = await reviewable({ submit: withCollectiblePermission });
    await expectCode(upsertCollectible({ db, ops: fakeOps }, { uid: "r", role: "REVIEWER" }, collectible(id)), "permission-denied");
    await expectCode(upsertCollectible({ db, ops: fakeOps }, { uid: "", role: "" }, collectible(id)), "permission-denied");
  });

  it("needs the artist's collectible permission", async () => {
    const { db, id } = await reviewable();
    await expectCode(upsertCollectible({ db, ops: fakeOps }, IMPACT, collectible(id)), "failed-precondition");
    await upsertCollectible({ db, ops: fakeOps }, IMPACT, collectible(id, { status: "none" }));
  });

  it("moves the public counters by the difference only", async () => {
    const { db, id } = await reviewable({ submit: withCollectiblePermission });
    const deps = { db, ops: fakeOps };
    const { id: colId } = await upsertCollectible(deps, IMPACT, collectible(id));
    expect(colId).toMatch(/^col_[0-9a-f]{32}$/);
    expect(db.data("counters/public")).toMatchObject({ collectiblesCreated: 1, tentsFunded: 1, sleepingBagsFunded: 2 });

    await upsertCollectible(deps, IMPACT, collectible(id, { id: colId, impactPackage: "B" }));
    expect(db.data("counters/public")).toMatchObject({ collectiblesCreated: 1, tentsFunded: 1, sleepingBagsFunded: 6 });

    await upsertCollectible(deps, IMPACT, collectible(id, { id: colId, impactPackage: "B" }));
    expect(db.data("counters/public")).toMatchObject({ collectiblesCreated: 1, tentsFunded: 1, sleepingBagsFunded: 6 });

    await upsertCollectible(deps, { uid: "a", role: "ADMIN" }, collectible(id, { id: colId, impactVerified: false }));
    expect(db.data("counters/public")).toMatchObject({ collectiblesCreated: 0, tentsFunded: 0, sleepingBagsFunded: 0 });
  });

  it("rejects unknown fields, unsafe links and re-pointing", async () => {
    const { db, id } = await reviewable({ submit: withCollectiblePermission });
    const other = await reviewable({ db, submit: withCollectiblePermission });
    const deps = { db, ops: fakeOps };
    await expectCode(upsertCollectible(deps, IMPACT, { ...collectible(id), price: 5 }), "invalid-argument");
    await expectCode(upsertCollectible(deps, IMPACT, collectible(id, { metadataUri: "javascript:alert(1)" })), "invalid-argument");
    const { id: colId } = await upsertCollectible(deps, IMPACT, collectible(id));
    await expectCode(upsertCollectible(deps, IMPACT, collectible(other.id, { id: colId })), "invalid-argument");
  });
});
