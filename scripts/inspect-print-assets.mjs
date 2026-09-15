import { PDFDocument } from "pdf-lib";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import QRCode from "qrcode";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "previews", "human-validation");
mkdirSync(OUT, { recursive: true });

const EASY = ["happy-pup", "simple-snug", "friendly-lodge", "waving-pup", "big-winter-hat", "lantern-friend", "two-friends", "stacked-bags"];
const MIXED = ["happy-pup", "simple-snug", "friendly-lodge", "warm-drink", "little-camp", "helping-hands", "mountain-camp", "sharing-warmth"];

async function inspectOne(slug) {
  const buf = readFileSync(path.join(ROOT, "public", "library", "print", `${slug}.pdf`));
  const doc = await PDFDocument.load(buf);
  const pages = doc.getPages();
  const sizes = pages.map((p) => {
    const { width, height } = p.getSize();
    return { width, height, inches: [+(width / 72).toFixed(2), +(height / 72).toFixed(2)] };
  });
  return { slug, pageCount: pages.length, sizes, magic: buf.slice(0, 5).toString() };
}

async function mergePack(slugs, copies, filename, includeCover) {
  const out = await PDFDocument.create();
  if (includeCover) {
    const page = out.addPage([612, 792]);
    const dest = "http://127.0.0.1:5173/submit?group=TESTPUBLICID";
    const qr = await QRCode.toDataURL(dest, { margin: 1, width: 200 });
    const png = await out.embedPng(Buffer.from(qr.split(",")[1], "base64"));
    page.drawImage(png, { x: 206, y: 280, width: 200, height: 200 });
    page.drawText("COLOR FOR A CAUSE", { x: 56, y: 720, size: 18 });
    page.drawText(dest, { x: 56, y: 250, size: 9 });
  }
  for (const slug of slugs) {
    const src = await PDFDocument.load(readFileSync(path.join(ROOT, "public", "library", "print", `${slug}.pdf`)));
    for (let c = 0; c < copies; c++) {
      const copied = await out.copyPages(src, src.getPageIndices());
      copied.forEach((p) => out.addPage(p));
    }
  }
  const bytes = await out.save();
  writeFileSync(path.join(OUT, filename), bytes);
  const loaded = await PDFDocument.load(bytes);
  return {
    filename,
    pageCount: loaded.getPageCount(),
    firstSize: loaded.getPage(0).getSize(),
    slugs,
    copies,
  };
}

const one = await inspectOne("happy-pup");
const easy = await mergePack(EASY, 1, "easy-pack.pdf", true);
const mixed = await mergePack(MIXED, 1, "mixed-pack.pdf", true);
const custom = await mergePack(["happy-pup", "warm-drink", "night-watch"], 2, "custom-2copies.pdf", true);

const png = readFileSync(path.join(ROOT, "public", "library", "print", "happy-pup.png"));
const pngHeader = { magic: png.slice(0, 8).toString("hex"), bytes: png.length };

writeFileSync(
  path.join(OUT, "print-assets.json"),
  JSON.stringify({ one, easy, mixed, custom, pngHeader, qrSample: "http://127.0.0.1:5173/submit?group=TESTPUBLICID" }, null, 2),
);
console.log(JSON.stringify({ one, easy: easy.pageCount, mixed: mixed.pageCount, custom: custom.pageCount, pngHeader }, null, 2));
