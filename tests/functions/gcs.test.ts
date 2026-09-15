/**
 * functions/src/gcs.ts against a stand-in for the Cloud Storage client: what the publish copy asks Storage for, and
 * what it does when a download token shows up anyway. (tests/rules/storage.rules.test.ts runs the same adapters
 * against the Storage emulator.)
 */
import { describe, expect, it } from "vitest";
import { DOWNLOAD_TOKENS_KEY, GALLERY_CACHE_CONTROL, tokenlessMediaUrl } from "../../functions/src/constants";
import { hasDownloadToken, storageAdapters } from "../../functions/src/gcs";
import { DestinationExists, GenerationMismatch } from "../../functions/src/moderate";

type Obj = { generation: string; metadata: Record<string, string> };
type Call = { op: string; path: string; generation?: string; body?: Record<string, unknown>; opts?: Record<string, unknown> };

const httpError = (code: number) => Object.assign(new Error(`HTTP ${code}`), { code });

/** Just enough of @google-cloud/storage's Bucket / File for gcs.ts, with generations and custom metadata. */
class FakeGcs {
  name = "notbychance-color-for-a-cause.firebasestorage.app";
  objects = new Map<string, Obj>();
  calls: Call[] = [];
  /** A service that copies the source's custom metadata (tokens included) despite our own map. */
  copiesSourceTokens = false;
  failRevoke: number | null = null;
  private next = 100;

  put(path: string, metadata: Record<string, string> = {}) {
    this.next += 1;
    this.objects.set(path, { generation: String(this.next), metadata });
    return String(this.next);
  }

  file(path: string, opts?: { generation?: string }) {
    const gcs = this;
    return {
      name: path,
      metadata: undefined as unknown,
      async copy(dest: { name: string }, options: Record<string, unknown>) {
        gcs.calls.push({ op: "copy", path, generation: opts?.generation, body: options });
        const src = gcs.objects.get(path);
        if (!src || (opts?.generation && src.generation !== opts.generation)) throw httpError(404);
        if (gcs.objects.has(dest.name)) throw httpError(412);
        const metadata = { ...(options.metadata as Record<string, string>) };
        if (gcs.copiesSourceTokens && src.metadata[DOWNLOAD_TOKENS_KEY]) metadata[DOWNLOAD_TOKENS_KEY] = src.metadata[DOWNLOAD_TOKENS_KEY];
        const generation = gcs.put(dest.name, metadata);
        return [dest, { resource: { name: dest.name, generation, metadata: { ...metadata } } }];
      },
      async setMetadata(body: { metadata: Record<string, string | null> }, o: Record<string, unknown>) {
        gcs.calls.push({ op: "setMetadata", path, generation: opts?.generation, body, opts: o });
        if (gcs.failRevoke !== null) throw httpError(gcs.failRevoke);
        const obj = gcs.objects.get(path);
        if (!obj) throw httpError(404);
        if (o.ifGenerationMatch !== obj.generation) throw httpError(412);
        for (const [k, v] of Object.entries(body.metadata)) {
          if (v === null) delete obj.metadata[k];
          else obj.metadata[k] = v;
        }
        return [obj];
      },
      async delete() {
        gcs.calls.push({ op: "delete", path, generation: opts?.generation });
        const obj = gcs.objects.get(path);
        if (obj && (!opts?.generation || obj.generation === opts.generation)) gcs.objects.delete(path);
      },
      async getMetadata() {
        const obj = gcs.objects.get(path);
        if (!obj) throw httpError(404);
        return [{ generation: obj.generation, metadata: { ...obj.metadata } }];
      },
    };
  }
}

const SRC = `submissions/sub_${"1".repeat(32)}/derived/public.jpg`;
const DEST = `gallery/sub_${"1".repeat(32)}/public.jpg`;

function setup() {
  const gcs = new FakeGcs();
  const adapters = storageAdapters(gcs as unknown as Parameters<typeof storageAdapters>[0]);
  return { gcs, adapters };
}

describe("A gcs.ts publish copy: no bearer URL for a public image", () => {
  it("asks for a pinned, create-only copy with public cache headers and a metadata map of its own, and returns the tokenless URL", async () => {
    const { gcs, adapters } = setup();
    const generation = gcs.put(SRC, { [DOWNLOAD_TOKENS_KEY]: "browser-made-legacy-token" });
    const out = await adapters.publishCopy(SRC, generation, DEST);
    const copy = gcs.calls.find((c) => c.op === "copy")!;
    expect(copy).toMatchObject({ path: SRC, generation });
    expect(copy.body).toEqual({
      contentType: "image/jpeg",
      cacheControl: GALLERY_CACHE_CONTROL,
      metadata: { sourceGeneration: generation },
      preconditionOpts: { ifGenerationMatch: 0 },
    });
    expect(out.url).toBe(tokenlessMediaUrl(gcs.name, DEST));
    expect(out.url).toBe(`https://firebasestorage.googleapis.com/v0/b/${gcs.name}/o/gallery%2Fsub_${"1".repeat(32)}%2Fpublic.jpg?alt=media`);
    expect(out.url).not.toMatch(/token/);
    expect(gcs.objects.get(DEST)?.metadata).toEqual({ sourceGeneration: generation });
    expect(gcs.calls.map((c) => c.op)).toEqual(["copy"]); // no revoke needed: no token came along
  });

  it("if a token came along with the copy anyway, it is revoked (pinned to the new generation) before the URL is handed out", async () => {
    const { gcs, adapters } = setup();
    gcs.copiesSourceTokens = true;
    const generation = gcs.put(SRC, { [DOWNLOAD_TOKENS_KEY]: "browser-made-legacy-token" });
    const out = await adapters.publishCopy(SRC, generation, DEST);
    const revoke = gcs.calls.find((c) => c.op === "setMetadata")!;
    expect(revoke).toMatchObject({ path: DEST, generation: out.generation, body: { metadata: { [DOWNLOAD_TOKENS_KEY]: null } }, opts: { ifGenerationMatch: out.generation } });
    expect(gcs.objects.get(DEST)?.metadata[DOWNLOAD_TOKENS_KEY]).toBeUndefined();
  });

  it("if that revoke fails, the copy is deleted by its generation and the publish fails", async () => {
    const { gcs, adapters } = setup();
    gcs.copiesSourceTokens = true;
    gcs.failRevoke = 503;
    const generation = gcs.put(SRC, { [DOWNLOAD_TOKENS_KEY]: "browser-made-legacy-token" });
    await expect(adapters.publishCopy(SRC, generation, DEST)).rejects.toThrow(/503/);
    expect(gcs.objects.has(DEST)).toBe(false);
    expect(gcs.calls.at(-1)).toMatchObject({ op: "delete", path: DEST });
  });

  it("a source generation that is gone is GenerationMismatch; an existing destination is DestinationExists", async () => {
    const { gcs, adapters } = setup();
    const generation = gcs.put(SRC);
    await expect(adapters.publishCopy(SRC, String(Number(generation) - 1), DEST)).rejects.toBeInstanceOf(GenerationMismatch);
    gcs.put(DEST);
    await expect(adapters.publishCopy(SRC, generation, DEST)).rejects.toBeInstanceOf(DestinationExists);
  });
});

describe("A gcs.ts revokeTokens", () => {
  it("removes the tokens key from exactly that generation, and only while it is live", async () => {
    const { gcs, adapters } = setup();
    const generation = gcs.put(DEST, { [DOWNLOAD_TOKENS_KEY]: "minted-by-a-reader", sourceGeneration: "7" });
    await adapters.revokeTokens(DEST, generation);
    expect(gcs.objects.get(DEST)?.metadata).toEqual({ sourceGeneration: "7" });
    expect(gcs.calls[0]).toMatchObject({ op: "setMetadata", generation, opts: { ifGenerationMatch: generation } });
  });

  it("a missing object (404) or another generation (412) is not an error; anything else is", async () => {
    const { gcs, adapters } = setup();
    await expect(adapters.revokeTokens(DEST, "5")).resolves.toBeUndefined();
    gcs.put(DEST, { [DOWNLOAD_TOKENS_KEY]: "t" });
    await expect(adapters.revokeTokens(DEST, "5")).resolves.toBeUndefined();
    gcs.failRevoke = 503;
    await expect(adapters.revokeTokens(DEST, "5")).rejects.toThrow(/503/);
  });

  it("hasDownloadToken reads the tokens key of an object resource", () => {
    expect(hasDownloadToken({ metadata: { [DOWNLOAD_TOKENS_KEY]: "a,b" } })).toBe(true);
    expect(hasDownloadToken({ metadata: { [DOWNLOAD_TOKENS_KEY]: "" } })).toBe(false);
    expect(hasDownloadToken({ metadata: { sourceGeneration: "1" } })).toBe(false);
    expect(hasDownloadToken({})).toBe(false);
    expect(hasDownloadToken(undefined)).toBe(false);
  });
});
