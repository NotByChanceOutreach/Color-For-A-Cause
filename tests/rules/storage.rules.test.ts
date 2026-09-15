/**
 * Storage security rules, exercised against the real emulator.
 * Run with `npm run test:rules` (never part of plain `npm test`).
 *
 * Only `get` is ever granted: the public Art Wall image to everyone while its
 * publicGallery document exists (a cross-service rule: the Firestore emulator
 * of the same demo project is seeded), the server-made derivative to queue
 * staff, originals to ADMIN. Nobody can list any prefix, and no client can
 * write anywhere (uploads use signed URLs, which bypass rules).
 */
import { createRequire } from "node:module";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DOWNLOAD_TOKENS_KEY, GALLERY_CACHE_CONTROL, tokenlessMediaUrl } from "../../functions/src/constants";
import { storageAdapters } from "../../functions/src/gcs";
import {
  assertFails,
  assertSucceeds,
  type RulesTestContext,
  type RulesTestEnvironment,
} from "@firebase/rules-unit-testing";
import {
  ADMIN_ONLY,
  EVERYONE,
  NOBODY,
  OTHER_SUB,
  PERSONAS,
  PROJECT_ID,
  QUEUE_STAFF,
  SUB,
  contextFor,
  startEnv,
  verdict,
  type Persona,
} from "./support";

type Bucket = ReturnType<RulesTestContext["storage"]>;

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0xff, 0xd9]);

/** A piece that was never published: nothing on the wall, nothing in publicGallery. */
const NEW_SUB = `sub_${"3".repeat(32)}`;

const PATHS = {
  gallery: `gallery/${SUB}/public.jpg`,
  galleryLeftover: `gallery/${OTHER_SUB}/public.jpg`,
  galleryBadId: "gallery/not-a-submission/public.jpg",
  galleryOtherFile: `gallery/${SUB}/original.jpg`,
  derived: `submissions/${SUB}/derived/public.jpg`,
  derivedV2: `submissions/${SUB}/derived/public-v2.jpg`,
  upload: `submissions/${SUB}/original/upload`,
  stripped: `submissions/${SUB}/original/stripped.jpg`,
  library: "coloring-pages/page-01/thumb.png",
  unlisted: "exports/consents.csv",
} as const;

type Read = { what: string; path: string; allowed: readonly Persona[] };
const OBJECTS: Read[] = [
  { what: "gallery public image of a piece on the wall", path: PATHS.gallery, allowed: EVERYONE },
  { what: "gallery image left behind, no publicGallery doc", path: PATHS.galleryLeftover, allowed: NOBODY },
  { what: "gallery image under a non-submission id", path: PATHS.galleryBadId, allowed: NOBODY },
  { what: "gallery file other than public.jpg", path: PATHS.galleryOtherFile, allowed: NOBODY },
  { what: "server derivative", path: PATHS.derived, allowed: QUEUE_STAFF },
  { what: "server derivative of a reprocessed legacy piece", path: PATHS.derivedV2, allowed: QUEUE_STAFF },
  { what: "original upload", path: PATHS.upload, allowed: ADMIN_ONLY },
  { what: "stripped original", path: PATHS.stripped, allowed: ADMIN_ONLY },
  { what: "coloring-page library asset", path: PATHS.library, allowed: EVERYONE },
  { what: "object outside every known prefix", path: PATHS.unlisted, allowed: NOBODY },
];

const LIST_PREFIXES = [
  "",
  "gallery",
  `gallery/${SUB}`,
  "submissions",
  `submissions/${SUB}`,
  `submissions/${SUB}/derived`,
  `submissions/${SUB}/original`,
  "coloring-pages",
  "coloring-pages/page-01",
  "exports",
];

/** Existing objects (overwrite / metadata / delete) plus fresh paths (create). */
const EXISTING_WRITE_TARGETS = [
  PATHS.gallery,
  PATHS.derived,
  PATHS.upload,
  PATHS.stripped,
  PATHS.library,
  PATHS.unlisted,
];
const NEW_WRITE_TARGETS = [
  `submissions/${OTHER_SUB}/original/upload`, // the signed-URL path, via rules instead
  `submissions/${OTHER_SUB}/derived/public.jpg`, // a client-made derivative
  `gallery/${NEW_SUB}/public.jpg`, // self-publishing to the Art Wall
  "coloring-pages/page-99/thumb.png",
  "anything/else.bin",
];

const put = (bucket: Bucket, path: string) =>
  Promise.resolve().then(() => bucket.ref(path).put(JPEG, { contentType: "image/jpeg" }));

let env: RulesTestEnvironment;
const buckets = {} as Record<Persona, Bucket>;

/** The public Art Wall document of a piece, as moderateSubmission writes it (only its existence matters here). */
const wallDoc = (id: string) => ({ id, status: "approved", public: true, imageUrl: "https://example.invalid/gallery.jpg" });

beforeAll(async () => {
  env = await startEnv("storage");
  await env.clearStorage();
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async (ctx) => {
    const bucket = ctx.storage();
    await Promise.all(Object.values(PATHS).map((path) => put(bucket, path)));
    // SUB is on the wall; OTHER_SUB's gallery file is a leftover (no document).
    await ctx.firestore().doc(`publicGallery/${SUB}`).set(wallDoc(SUB));
  });
  for (const p of PERSONAS) buckets[p] = contextFor(env, p).storage();
});

afterAll(async () => {
  if (!env) return;
  await env.clearStorage();
  await env.clearFirestore();
  await env.cleanup();
});

describe("Art Wall image: readable only while its publicGallery document exists", () => {
  const ON_WALL = `sub_${"2".repeat(32)}`;
  const path = `gallery/${ON_WALL}/public.jpg`;

  it("readable by everyone while the piece is on the wall; unreadable by everyone once the doc is gone, though the file remains", async () => {
    await env.withSecurityRulesDisabled(async (ctx) => {
      await put(ctx.storage(), path);
      await ctx.firestore().doc(`publicGallery/${ON_WALL}`).set(wallDoc(ON_WALL));
    });
    for (const p of PERSONAS) {
      await assertSucceeds(buckets[p].ref(path).getMetadata());
      await assertSucceeds(buckets[p].ref(path).getDownloadURL());
    }

    // Unpublished (the doc goes first), and the file removal failed: the object is still there.
    await env.withSecurityRulesDisabled(async (ctx) => {
      await ctx.firestore().doc(`publicGallery/${ON_WALL}`).delete();
    });
    for (const p of PERSONAS) {
      await assertFails(buckets[p].ref(path).getMetadata());
      await assertFails(buckets[p].ref(path).getDownloadURL());
    }
    await env.withSecurityRulesDisabled(async (ctx) => {
      const meta = await ctx.storage().ref(path).getMetadata();
      if (meta.contentType !== "image/jpeg") throw new Error("the leftover object should still exist");
    });
  });
});

describe("Storage object reads (get)", () => {
  for (const o of OBJECTS) {
    describe(`${o.what} (${o.path})`, () => {
      for (const p of PERSONAS) {
        const ok = verdict(o.allowed, p);
        it(`${p}: metadata ${ok ? "allowed" : "denied"}`, async () => {
          const pr = buckets[p].ref(o.path).getMetadata();
          if (ok) await assertSucceeds(pr);
          else await assertFails(pr);
        });
        it(`${p}: download URL ${ok ? "allowed" : "denied"}`, async () => {
          const pr = buckets[p].ref(o.path).getDownloadURL();
          if (ok) await assertSucceeds(pr);
          else await assertFails(pr);
        });
      }
    });
  }
});

describe("Storage listing is denied for everyone", () => {
  for (const prefix of LIST_PREFIXES) {
    describe(`list "${prefix || "/"}"`, () => {
      for (const p of PERSONAS) {
        it(`${p}: listAll denied`, async () => {
          await assertFails(buckets[p].ref(prefix).listAll());
        });
        it(`${p}: paged list denied`, async () => {
          await assertFails(buckets[p].ref(prefix).list({ maxResults: 10 }));
        });
      }
    });
  }
});

describe("Storage client writes are denied everywhere", () => {
  for (const path of EXISTING_WRITE_TARGETS) {
    describe(path, () => {
      for (const p of PERSONAS) {
        it(`${p}: overwrite denied`, async () => {
          await assertFails(put(buckets[p], path));
        });
        it(`${p}: metadata update denied`, async () => {
          await assertFails(buckets[p].ref(path).updateMetadata({ contentType: "text/html" }));
        });
        it(`${p}: delete denied`, async () => {
          await assertFails(buckets[p].ref(path).delete());
        });
      }
    });
  }
  for (const path of NEW_WRITE_TARGETS) {
    describe(path, () => {
      for (const p of PERSONAS) {
        it(`${p}: create denied`, async () => {
          await assertFails(put(buckets[p], path));
        });
      }
    });
  }
});

describe("Storage role claim is matched exactly", () => {
  const forged: [string, Record<string, unknown>][] = [
    ["lower-case admin", { role: "admin" }],
    ["role as a list", { role: ["ADMIN"] }],
    ["admin flag instead of role", { admin: true }],
  ];
  for (const [label, claims] of forged) {
    it(`${label}: cannot read originals or derivatives`, async () => {
      const bucket = env.authenticatedContext(`forged-${label.replace(/\s+/g, "-")}`, claims).storage();
      await assertFails(bucket.ref(PATHS.upload).getMetadata());
      await assertFails(bucket.ref(PATHS.stripped).getMetadata());
      await assertFails(bucket.ref(PATHS.derived).getMetadata());
    });
  }
});

describe("Art Wall image through the real publish copy (functions/src/gcs.ts): tokenless and rules-gated (round 4, A)", () => {
  type GcsModule = typeof import("../../functions/node_modules/@google-cloud/storage");
  const host = () => process.env.FIREBASE_STORAGE_EMULATOR_HOST ?? "";
  /** The production URL the public doc stores, pointed at the emulator. */
  const viaEmulator = (url: string) => url.replace("https://firebasestorage.googleapis.com", `http://${host()}`);
  /** The Cloud Storage client the Admin SDK wraps (index.ts), talking to the emulator; the rules-unit-testing bucket. */
  function adminBucket() {
    const { Storage } = createRequire(path.resolve("functions/package.json"))("@google-cloud/storage") as GcsModule;
    return new Storage({ projectId: PROJECT_ID, apiEndpoint: `http://${host()}` }).bucket(PROJECT_ID);
  }
  const setWall = (id: string, onWall: boolean) =>
    env.withSecurityRulesDisabled(async (ctx) => {
      const ref = ctx.firestore().doc(`publicGallery/${id}`);
      await (onWall ? ref.set(wallDoc(id)) : ref.delete());
    });

  /** A derivative uploaded through the Firebase SDK (the emulator gives it a download token), then the publish copy. */
  async function published(id: string) {
    const src = `submissions/${id}/derived/public.jpg`;
    const dest = `gallery/${id}/public.jpg`;
    await env.withSecurityRulesDisabled(async (ctx) => {
      await put(ctx.storage(), src);
    });
    const bucket = adminBucket();
    const storage = storageAdapters(bucket as unknown as Parameters<typeof storageAdapters>[0]);
    const [srcMeta] = await bucket.file(src).getMetadata();
    const srcToken = String(srcMeta.metadata?.[DOWNLOAD_TOKENS_KEY] ?? "").split(",")[0];
    const generation = await storage.generationOf(src);
    if (!generation) throw new Error("the source should exist");
    const copy = await storage.publishCopy(src, generation, dest);
    return { bucket, storage, src, dest, srcToken, copy };
  }

  it("the copy carries no token, not even the source's; anyone reads it tokenless while it is on the wall, nobody once the doc is gone", async () => {
    const id = `sub_${"4".repeat(32)}`;
    const { bucket, dest, srcToken, copy } = await published(id);
    expect(srcToken).not.toBe(""); // the source really carries a token, so "not copied" means something
    expect(copy.url).toBe(tokenlessMediaUrl(PROJECT_ID, dest));
    expect(copy.url).not.toMatch(/token=/);
    const [destMeta] = await bucket.file(dest).getMetadata();
    expect(destMeta.metadata?.[DOWNLOAD_TOKENS_KEY]).toBeUndefined();
    expect(destMeta.cacheControl).toBe(GALLERY_CACHE_CONTROL);

    await setWall(id, true);
    const onWall = await fetch(viaEmulator(copy.url)); // anonymous: no Authorization header, no token
    expect(onWall.status).toBe(200);
    expect(new Uint8Array(await onWall.arrayBuffer())).toEqual(JPEG);

    // Off the wall (the doc goes first; say the file removal then failed): the same URL is refused at once.
    await setWall(id, false);
    expect((await fetch(viaEmulator(copy.url))).status).toBe(403);
    // And the source's token never opens the copy.
    expect((await fetch(`${viaEmulator(copy.url)}&token=${srcToken}`)).status).toBe(403);
  });

  it("a token a reader minted while the piece was on the wall dies with the unpublish (tokens revoked, then that generation deleted)", async () => {
    const id = `sub_${"5".repeat(32)}`;
    const { storage, dest, copy } = await published(id);
    await setWall(id, true);
    const minted = await buckets.anonymous.ref(dest).getDownloadURL();
    expect(minted).toMatch(/[?&]token=/); // getDownloadURL mints one for any reader the rules let through
    expect((await fetch(minted)).status).toBe(200);

    // Unpublish, as moderate.ts does it: the doc first, then revokeTokens and removeObject of the recorded generation.
    // (The emulator keeps tokens outside the object's custom metadata, so the revoke alone cannot be observed here;
    // production keeps them in firebaseStorageDownloadTokens, which revokeTokens clears: tests/functions/gcs.test.ts.)
    await setWall(id, false);
    await storage.revokeTokens(dest, copy.generation);
    await storage.removeObject(dest, copy.generation);
    expect((await fetch(minted)).status).not.toBe(200);
    expect((await fetch(viaEmulator(copy.url))).status).not.toBe(200);
  });
});

describe("Storage rules leave the seeded objects intact", () => {
  it("every seeded object still exists and is unchanged in type", async () => {
    await env.withSecurityRulesDisabled(async (ctx) => {
      const bucket = ctx.storage();
      for (const path of Object.values(PATHS)) {
        const meta = await bucket.ref(path).getMetadata();
        if (meta.contentType !== "image/jpeg") throw new Error(`${path} was modified`);
      }
    });
  });
});
