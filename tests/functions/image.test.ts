import { createRequire } from "node:module";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { cropRect, processImage } from "../../functions/src/image";
import { isOutOfMemory, isUnreadableImage } from "../../functions/src/transient";

type SharpModule = typeof import("../../functions/node_modules/sharp").default;
// sharp is a functions dependency, so load it the way the function does.
const sharp = createRequire(path.resolve("functions/package.json"))("sharp") as SharpModule;

/** A phone-like photo: stored sideways with an EXIF rotation, personal EXIF text, GPS, and a Display P3 profile. */
async function phonePhoto(): Promise<Buffer> {
  return sharp({ create: { width: 3000, height: 1200, channels: 3, background: { r: 210, g: 60, b: 40 } } })
    .withMetadata({ orientation: 6 })
    .withExifMerge({
      IFD0: { Artist: "Kid Name", Copyright: "12 Oak Street" },
      IFD3: { GPSLatitudeRef: "N", GPSLatitude: "40/1 26/1 46/1" },
    })
    .withIccProfile("p3")
    .jpeg({ quality: 80 })
    .toBuffer();
}

describe("C2 server image pipeline (real sharp)", () => {
  it("auto-rotates, strips EXIF/GPS/XMP/IPTC/ICC and caps the long edge", async () => {
    const input = await phonePhoto();
    const before = await sharp(input).metadata();
    expect(before.orientation).toBe(6);
    expect(before.exif).toBeDefined();
    expect(before.icc).toBeDefined();
    expect(input.includes(Buffer.from("Kid Name"))).toBe(true);

    const out = await processImage(input, { rotate: 0, cropPct: 0 });
    for (const img of [out.stripped, out.derived]) {
      const m = await sharp(img.data).metadata();
      expect(m.format).toBe("jpeg");
      expect(m.exif).toBeUndefined();
      expect(m.xmp).toBeUndefined();
      expect(m.iptc).toBeUndefined();
      expect(m.icc).toBeUndefined();
      expect(m.orientation).toBeUndefined();
      expect(img.data.includes(Buffer.from("Kid Name"))).toBe(false);
    }
    // Stored 3000x1200 with orientation 6 means it is really 1200 wide and 3000 tall.
    expect([out.stripped.width, out.stripped.height]).toEqual([1200, 3000]);
    expect(out.derived.height).toBe(2048);
    expect(Math.abs(out.derived.width - 819)).toBeLessThanOrEqual(1);
  });

  it("applies the artist's quarter turn and edge crop to the public image only", async () => {
    const out = await processImage(await phonePhoto(), { rotate: 90, cropPct: 0.1 });
    expect([out.stripped.width, out.stripped.height]).toEqual([1200, 3000]);
    // 1200x3000 -> crop 10% per side -> 960x2400 -> quarter turn -> 2400x960 -> cap -> 2048x819
    expect(out.derived.width).toBe(2048);
    expect(Math.abs(out.derived.height - 819)).toBeLessThanOrEqual(1);
  });

  it("flattens transparency onto white", async () => {
    const png = await sharp({ create: { width: 64, height: 48, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
      .png()
      .toBuffer();
    const out = await processImage(png, { rotate: 0, cropPct: 0 });
    const m = await sharp(out.derived.data).metadata();
    expect(m.format).toBe("jpeg");
    expect(m.hasAlpha).toBe(false);
    const { data } = await sharp(out.derived.data).raw().toBuffer({ resolveWithObject: true });
    expect(data[0]).toBeGreaterThan(245);
  });

  it("never enlarges small pictures", async () => {
    const small = await sharp({ create: { width: 300, height: 200, channels: 3, background: "#3366aa" } }).jpeg().toBuffer();
    const out = await processImage(small, { rotate: 0, cropPct: 0 });
    expect([out.derived.width, out.derived.height]).toEqual([300, 200]);
  });

  it("refuses bytes that are not a picture", async () => {
    await expect(processImage(Buffer.from("definitely not an image file"), { rotate: 0, cropPct: 0 })).rejects.toThrow();
  });

  it("crops symmetrically and ignores a zero crop", () => {
    expect(cropRect(1000, 2000, 0.1)).toEqual({ left: 100, top: 200, width: 800, height: 1600 });
    expect(cropRect(1000, 2000, 0)).toBeNull();
    expect(cropRect(3, 3, 0.2)).toBeNull();
  });
});

describe("C2 what real sharp says for pictures it cannot decode is exactly what the trigger refuses (round 4, C)", () => {
  async function brokenPictures(): Promise<Array<[string, Buffer]>> {
    const jpeg = await sharp({ create: { width: 64, height: 48, channels: 3, background: "#cc3333" } }).jpeg().toBuffer();
    const png = await sharp({ create: { width: 64, height: 48, channels: 3, background: "#33cc33" } }).png().toBuffer();
    const webp = await sharp({ create: { width: 64, height: 48, channels: 3, background: "#3333cc" } }).webp().toBuffer();
    const badCrc = Buffer.from(png);
    badCrc[29] ^= 0xff;
    const huge = Buffer.from(png);
    huge.writeUInt32BE(20000, 16);
    huge.writeUInt32BE(20000, 20);
    return [
      ["a truncated JPEG", jpeg.subarray(0, Math.floor(jpeg.length / 2))],
      ["a JPEG header, then garbage", Buffer.concat([jpeg.subarray(0, 20), Buffer.alloc(200, 0x41)])],
      ["a truncated PNG", png.subarray(0, Math.floor(png.length / 2))],
      ["a PNG with a broken CRC", badCrc],
      ["a PNG signature and nothing else", Buffer.concat([png.subarray(0, 8), Buffer.alloc(40, 0)])],
      ["a truncated WebP", webp.subarray(0, Math.floor(webp.length / 2))],
      ["a HEIC-looking stub", Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from("ftypheic"), Buffer.alloc(40, 0)])],
      ["bytes of no known format", Buffer.alloc(100, 9)],
      ["an empty buffer", Buffer.alloc(0)],
      ["a PNG claiming 20000 x 20000 pixels", huge],
    ];
  }

  it("every such failure is on the allowlist, and none is mistaken for running out of memory", async () => {
    const pictures = await brokenPictures();
    let recognised = 0;
    for (const [what, bytes] of pictures) {
      const err = await processImage(bytes, { rotate: 0, cropPct: 0 }).then(
        () => null,
        (e: unknown) => e,
      );
      expect(err, what).toBeInstanceOf(Error);
      expect(isOutOfMemory(err), what).toBe(false);
      // libvips keeps one error buffer for the whole process; when another operation clears it first, sharp can only
      // say "Unknown error". That says nothing about the picture, so it is NOT on the allowlist: it is retried and
      // counted, and the 20 h cap ends it (uploadTrigger.test.ts).
      if ((err as Error).message === "Unknown error") {
        expect(isUnreadableImage(err), what).toBe(false);
        continue;
      }
      expect(isUnreadableImage(err), `${what}: ${(err as Error).message}`).toBe(true);
      recognised += 1;
    }
    expect(recognised).toBeGreaterThanOrEqual(pictures.length - 2);
  });
});
