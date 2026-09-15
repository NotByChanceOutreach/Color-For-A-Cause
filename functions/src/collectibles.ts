/**
 * upsertCollectible: the only write path for collectibles/impact (clients never write Firestore).
 * Public counters change by the difference between the old and new record, with FieldValue.increment.
 */
import { fail } from "./errors";
import { audit, type Data, type Db, type Ops } from "./store";
import { newId } from "./upload";
import { parseCollectibleRequest } from "./validation";

export type ImpactCounts = { collectiblesCreated: number; tentsFunded: number; sleepingBagsFunded: number };

const FUNDED = new Set(["funded", "purchased", "distributed"]);
const IMPACT_ROLES = new Set(["ADMIN", "IMPACT_MANAGER"]);

/** What one collectible adds to the public counters. Unverified records add nothing. */
export function impactContribution(c: Data | null | undefined): ImpactCounts {
  const out: ImpactCounts = { collectiblesCreated: 0, tentsFunded: 0, sleepingBagsFunded: 0 };
  if (!c || c.impactVerified !== true) return out;
  if (c.status === "created") out.collectiblesCreated = 1;
  if (typeof c.impactStatus === "string" && FUNDED.has(c.impactStatus)) {
    if (c.impactPackage === "A") {
      out.tentsFunded = 1;
      out.sleepingBagsFunded = 2;
    } else if (c.impactPackage === "B") {
      out.tentsFunded = 1;
      out.sleepingBagsFunded = 6;
    }
  }
  return out;
}

export function contributionDelta(before: Data | null | undefined, after: Data | null | undefined): Partial<ImpactCounts> {
  const a = impactContribution(before);
  const b = impactContribution(after);
  const delta: Partial<ImpactCounts> = {};
  for (const key of Object.keys(a) as (keyof ImpactCounts)[]) {
    if (b[key] !== a[key]) delta[key] = b[key] - a[key];
  }
  return delta;
}

export async function upsertCollectible(
  deps: { db: Db; ops: Ops },
  actor: { uid: string; role: string },
  raw: unknown,
): Promise<{ ok: true; id: string }> {
  if (!IMPACT_ROLES.has(actor.role)) fail("permission-denied", "Staff only.");
  const input = parseCollectibleRequest(raw);
  const id = input.id ?? newId("col");
  const { db, ops } = deps;

  await db.runTransaction(async (tx) => {
    const colRef = db.doc(`collectibles/${id}`);
    const prev = (await tx.get(colRef)).data() ?? null;
    const sub = (await tx.get(db.doc(`submissions/${input.submissionId}`))).data();
    if (!sub) fail("not-found", "Submission not found.");
    if (prev && prev.submissionId !== input.submissionId) {
      fail("invalid-argument", "A collectible cannot be moved to a different submission.");
    }
    const perms = sub.permissions as { collectible?: unknown } | undefined;
    if (input.status !== "none" && perms?.collectible !== true) {
      fail("failed-precondition", "The artist did not give permission for a collectible.");
    }
    const next: Data = {
      id,
      submissionId: input.submissionId,
      status: input.status,
      chain: input.chain,
      contract: input.contract,
      tokenId: input.tokenId,
      txHash: input.txHash,
      metadataUri: input.metadataUri,
      marketplaceUrl: input.marketplaceUrl,
      impactPackage: input.impactPackage,
      impactStatus: input.impactStatus,
      impactVerified: input.impactVerified,
      createdAt: prev?.createdAt ?? ops.serverTimestamp(),
      updatedAt: ops.serverTimestamp(),
      updatedBy: actor.uid,
    };
    tx.set(colRef, next);
    const delta = contributionDelta(prev, next);
    const entries = Object.entries(delta);
    if (entries.length) {
      tx.set(db.doc("counters/public"), Object.fromEntries(entries.map(([k, v]) => [k, ops.increment(v ?? 0)])), { merge: true });
    }
    audit(tx, db, ops, { actor: actor.uid, action: "collectible", target: id, detail: `${input.submissionId} ${input.status}` });
  });
  return { ok: true, id };
}
