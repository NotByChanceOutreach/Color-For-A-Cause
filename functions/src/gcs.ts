/**
 * Cloud Storage adapters over the Admin SDK bucket, shared by index.ts and scripts/reprocess-legacy.mjs.
 *
 * - Private images (stripped original, review derivative) are written CREATE-ONLY (ifGenerationMatch=0) with
 *   private cache headers; a 412 becomes ObjectExists.
 * - Reads are pinned to a generation; a 404 becomes ObjectGone.
 * - Deletes take the generation to delete; a missing object (or another generation) is not an error.
 * - The publish copy is pinned to the reviewed source generation and create-only at the destination. It carries NO
 *   download token (a token URL bypasses storage.rules and outlives the piece's time on the wall): the wall reads it
 *   through tokenlessMediaUrl, which the rules check on every read.
 * - revokeTokens removes every download token from one generation of an object. Firebase can mint a token for any
 *   reader the rules let through (getDownloadURL), so a gallery object's tokens are revoked before it is deleted
 *   (moderate.ts unpublish, retention.ts gallery leftovers): if the delete then fails, the leftover is still
 *   unreadable to everyone.
 */
import type { getStorage } from "firebase-admin/storage";
import { DOWNLOAD_TOKENS_KEY, GALLERY_CACHE_CONTROL, PRIVATE_CACHE_CONTROL, tokenlessMediaUrl } from "./constants";
import { DestinationExists, GenerationMismatch } from "./moderate";
import { ObjectExists, ObjectGone, type StoredObject } from "./uploadTrigger";

type Bucket = ReturnType<ReturnType<typeof getStorage>["bucket"]>;

export function storageStatus(err: unknown): number | undefined {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === "number" ? code : undefined;
}

/** Whether an object resource's custom metadata carries at least one download token. */
export function hasDownloadToken(resource: unknown): boolean {
  const custom = (resource as { metadata?: Record<string, unknown> | null } | null | undefined)?.metadata;
  const tokens = custom?.[DOWNLOAD_TOKENS_KEY];
  return typeof tokens === "string" && tokens.trim() !== "";
}

export function storageAdapters(bucket: Bucket) {
  async function saveJpeg(path: string, data: Buffer): Promise<StoredObject> {
    const file = bucket.file(path);
    try {
      await file.save(data, {
        resumable: false,
        contentType: "image/jpeg",
        metadata: { cacheControl: PRIVATE_CACHE_CONTROL },
        // Create-only: no run ever overwrites an object (see the safety argument in uploadTrigger.ts).
        preconditionOpts: { ifGenerationMatch: 0 },
      });
    } catch (err) {
      if (storageStatus(err) === 412) throw new ObjectExists(path);
      throw err;
    }
    let meta = file.metadata;
    if (!meta?.generation || !meta?.md5Hash) [meta] = await file.getMetadata();
    return { generation: String(meta.generation), md5: String(meta.md5Hash) };
  }

  async function removeObject(path: string, generation?: string): Promise<void> {
    await bucket.file(path, generation ? { generation } : undefined).delete({ ignoreNotFound: true });
  }

  /**
   * Remove every download token from exactly `generation` of `path` (a metadata PATCH that sets the tokens key to
   * null, conditional on that generation still being live). A missing object or another generation is not an error.
   */
  async function revokeTokens(path: string, generation: string): Promise<void> {
    try {
      await bucket
        .file(path, { generation })
        .setMetadata({ metadata: { [DOWNLOAD_TOKENS_KEY]: null } }, { ifGenerationMatch: generation });
    } catch (err) {
      const status = storageStatus(err);
      if (status === 404 || status === 412) return;
      throw err;
    }
  }

  async function download(path: string, generation: string): Promise<Buffer> {
    try {
      const [data] = await bucket.file(path, { generation }).download();
      return data;
    } catch (err) {
      if (storageStatus(err) === 404) throw new ObjectGone(path);
      throw err;
    }
  }

  async function generationOf(path: string): Promise<string | null> {
    try {
      const [meta] = await bucket.file(path).getMetadata();
      return meta.generation === undefined || meta.generation === null ? null : String(meta.generation);
    } catch (err) {
      if (storageStatus(err) === 404) return null;
      throw err;
    }
  }

  /**
   * Publish copy (moderate.ts): source pinned to the reviewed generation, destination create-only
   * (ifGenerationMatch=0), public cache headers, and a custom metadata map of our own (which generation of the
   * derivative was published). That map replaces the source's, so a download token on the source (a browser-made
   * legacy derivative) is never copied. Should a token show up on the copy anyway, it is revoked before the copy is
   * used; if that fails the copy is deleted and the publish fails. Returns the tokenless URL.
   */
  async function publishCopy(src: string, generation: string, dest: string): Promise<{ generation: string; url: string }> {
    let created: string;
    let resource: unknown;
    try {
      const [copied, resp] = await bucket.file(src, { generation }).copy(bucket.file(dest), {
        contentType: "image/jpeg",
        cacheControl: GALLERY_CACHE_CONTROL,
        metadata: { sourceGeneration: generation },
        preconditionOpts: { ifGenerationMatch: 0 },
      });
      resource = (resp as { resource?: unknown } | undefined)?.resource ?? copied.metadata;
      let made = (resource as { generation?: unknown } | undefined)?.generation;
      if (made === undefined) {
        const [meta] = await copied.getMetadata();
        resource = meta;
        made = meta.generation;
      }
      created = String(made);
    } catch (err) {
      const status = storageStatus(err);
      if (status === 404) throw new GenerationMismatch();
      if (status === 412) throw new DestinationExists();
      throw err;
    }
    if (hasDownloadToken(resource)) {
      try {
        await revokeTokens(dest, created);
      } catch (err) {
        await removeObject(dest, created).catch(() => undefined);
        throw err;
      }
    }
    return { generation: created, url: tokenlessMediaUrl(bucket.name, dest) };
  }

  return { saveJpeg, removeObject, revokeTokens, download, generationOf, publishCopy };
}
