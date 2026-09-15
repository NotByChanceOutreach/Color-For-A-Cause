import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import QRCode from "qrcode";
import { writeFileSync } from "node:fs";

const slugs = ["happy-pup","simple-snug","friendly-lodge","waving-pup","big-winter-hat","lantern-friend","two-friends","stacked-bags"];
const origin = "http://127.0.0.1:5173";
const groupPublicId = "g_demoPublic12";

const out = await PDFDocument.create();
const page = out.addPage([612, 792]);
const font = await out.embedFont(StandardFonts.Helvetica);
const bold = await out.embedFont(StandardFonts.HelveticaBold);
page.drawRectangle({ x: 0, y: 0, width: 612, height: 792, color: rgb(1, 1, 1) });
page.drawText("COLOR FOR A CAUSE", { x: 56, y: 720, size: 22, font: bold, color: rgb(0.16, 0.12, 0.08) });
const dest = `${origin}/submit?group=${groupPublicId}`;
const qr = await QRCode.toDataURL(dest, { margin: 1, width: 280 });
const png = await out.embedPng(Buffer.from(qr.split(",")[1], "base64"));
page.drawImage(png, { x: 186, y: 220, width: 240, height: 240 });
page.drawText(dest, { x: 56, y: 170, size: 9, font, color: rgb(0.3, 0.3, 0.3) });

for (const slug of slugs) {
  const bytes = await fetch(`${origin}/library/print/${slug}.pdf`).then((r) => r.arrayBuffer());
  const src = await PDFDocument.load(bytes);
  const copied = await out.copyPages(src, src.getPageIndices());
  copied.forEach((p) => out.addPage(p));
}
const saved = await out.save();
writeFileSync("previews/human-validation/easy-pack-fixed.pdf", saved);
console.log("pages", out.getPageCount(), "dest", dest);
