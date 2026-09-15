import type { Collectible } from "../types";

/**
 * The only keys upsertCollectible accepts (mirrors COLLECTIBLE_FIELDS in functions/src/validation.ts, which
 * rejects anything else). Rows read back from Firestore also carry createdAt/updatedAt/updatedBy.
 */
export const COLLECTIBLE_FIELDS = [
  "id",
  "submissionId",
  "status",
  "chain",
  "contract",
  "tokenId",
  "txHash",
  "metadataUri",
  "marketplaceUrl",
  "impactPackage",
  "impactStatus",
  "impactVerified",
] as const satisfies readonly (keyof Collectible)[];

export type CollectiblePayload = Pick<Collectible, (typeof COLLECTIBLE_FIELDS)[number]>;

export function collectiblePayload(c: Collectible): CollectiblePayload {
  const source = c as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of COLLECTIBLE_FIELDS) out[key] = key === "impactVerified" ? source[key] === true : (source[key] ?? null);
  return out as CollectiblePayload;
}
