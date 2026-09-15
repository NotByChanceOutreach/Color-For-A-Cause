/**
 * submitArtwork (contract C1): validate, apply minor protections, rate-limit, write the consent and the
 * 'uploading' submission, and hand back ONE signed PUT URL for submissions/{id}/original/upload plus a
 * finalize token. The browser no longer uploads a derivative; the Storage trigger makes it.
 */
import { CONSENT_VERSION, UPLOADING, paths } from "./constants";
import { fail } from "./errors";
import { applyMinorProtections } from "./minors";
import { flagSubmission } from "./moderation";
import { audit, type Db, type Ops } from "./store";
import {
  genericOriginalName,
  hashFinalizeToken,
  newFinalizeToken,
  newId,
  uploadRequestHeaders,
  uploadUrlConfig,
  type SignedUploadConfig,
} from "./upload";
import { cleanText, dropLoneSurrogates, parseSubmitRequest } from "./validation";

export interface SubmitDeps {
  db: Db;
  ops: Ops;
  now(): number;
  /**
   * Spend one unit of the caller's hourly budget: the per-(group, IP) bucket when `groupPublicId` names a
   * group that exists, otherwise the per-IP bucket. Throws resource-exhausted when it is used up.
   */
  rateLimit(groupPublicId: string | null): Promise<void>;
  groupExists(publicId: string): Promise<boolean>;
  nextArtNumber(): Promise<string>;
  signUpload(path: string, config: SignedUploadConfig): Promise<string>;
}

export type SubmitResponse = {
  id: string;
  number: string;
  uploadUrl: string;
  uploadHeaders: Record<string, string>;
  finalizeToken: string;
  expiresAt: string;
};

export const STORE_REQUIRED = "We need permission to store the picture in order to receive it.";

export async function startSubmission(deps: SubmitDeps, raw: unknown, ctx: { userAgent: string }): Promise<SubmitResponse> {
  const parsed = parseSubmitRequest(raw);
  if (!parsed.permissions.store) fail("failed-precondition", STORE_REQUIRED);
  const { request, minorProtectionsApplied, guardianConsentAttested } = applyMinorProtections(parsed);

  // Only a group that exists earns the larger art-day bucket; a made-up code spends the plain per-IP budget
  // before it is refused, so guessing codes is rate-limited too.
  const groupLive = request.groupPublicId ? await deps.groupExists(request.groupPublicId) : false;
  await deps.rateLimit(groupLive ? request.groupPublicId : null);
  if (request.groupPublicId && !groupLive) {
    fail("invalid-argument", "That group code is not active any more. You can still send the art without it.");
  }

  const { db, ops } = deps;
  const id = newId("sub");
  const consentId = newId("con");
  const number = await deps.nextArtNumber();
  const finalizeToken = newFinalizeToken();
  const upload = uploadUrlConfig(request.originalMime, deps.now());
  const flags = flagSubmission(`${request.message} ${request.attributionText} ${request.organizationName ?? ""}`);

  await db.runTransaction(async (tx) => {
    tx.create(db.doc(`consents/${consentId}`), {
      id: consentId,
      submissionId: id,
      documentVersion: CONSENT_VERSION,
      submitterRole: request.submitterRole,
      ageRange: request.ageRange,
      permissions: request.permissions,
      minorProtectionsApplied,
      guardianConsentAttested,
      timestamp: ops.serverTimestamp(),
      userAgent: cleanText(dropLoneSurrogates(ctx.userAgent), false).slice(0, 300),
    });
    tx.create(db.doc(`submissions/${id}`), {
      id,
      number,
      pageId: request.pageId,
      status: UPLOADING,
      submitterRole: request.submitterRole,
      attributionKind: request.attributionKind,
      attributionText: request.attributionText,
      ageRange: request.ageRange,
      organizationName: request.organizationName,
      showOrganization: request.showOrganization,
      message: request.message,
      email: request.email,
      groupId: request.groupPublicId,
      flags,
      consentId,
      createdAt: ops.serverTimestamp(),
      reviewedAt: null,
      reviewedBy: null,
      staffNote: null,
      originalName: genericOriginalName(request.originalMime),
      originalMime: request.originalMime,
      originalBytes: request.originalBytes,
      originalPath: paths.upload(id),
      derivedPath: paths.derived(id),
      permissions: request.permissions,
      minorProtectionsApplied,
      rotate: request.rotate,
      cropPct: request.cropPct,
      finalizeTokenHash: hashFinalizeToken(finalizeToken),
      finalizeRequested: false,
      stripped: false,
      derivedGeneration: null,
      derivedMd5: null,
    });
    audit(tx, db, ops, { actor: "public", action: "submit-start", target: id, detail: number });
  });

  const uploadUrl = await deps.signUpload(paths.upload(id), upload);
  return {
    id,
    number,
    uploadUrl,
    uploadHeaders: uploadRequestHeaders(request.originalMime),
    finalizeToken,
    expiresAt: new Date(upload.expires).toISOString(),
  };
}
