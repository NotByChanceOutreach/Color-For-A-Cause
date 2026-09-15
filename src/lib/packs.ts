import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import QRCode from "qrcode";
import { pageBySlug, pdfUrl } from "../data/pages";

export async function buildActivityPack(opts: {
  slugs: string[];
  copies: number;
  origin: string;
  groupPublicId?: string;
  includeInstructions?: boolean;
}): Promise<Blob> {
  const out = await PDFDocument.create();
  const copies = Math.min(50, Math.max(1, opts.copies));
  if (opts.includeInstructions !== false) {
    await makeCover(out, opts.origin, opts.groupPublicId);
  }
  for (const slug of opts.slugs) {
    const page = pageBySlug(slug);
    if (!page) continue;
    const bytes = await fetch(pdfUrl(slug)).then((r) => r.arrayBuffer());
    const src = await PDFDocument.load(bytes);
    for (let c = 0; c < copies; c++) {
      const copied = await out.copyPages(src, src.getPageIndices());
      copied.forEach((p) => out.addPage(p));
    }
  }
  const saved = await out.save();
  return new Blob([Uint8Array.from(saved)], { type: "application/pdf" });
}

async function makeCover(
  doc: PDFDocument,
  origin: string,
  groupPublicId?: string,
) {
  const page = doc.addPage([612, 792]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  page.drawRectangle({ x: 0, y: 0, width: 612, height: 792, color: rgb(1, 1, 1) });
  page.drawText("COLOR FOR A CAUSE", {
    x: 56,
    y: 720,
    size: 22,
    font: bold,
    color: rgb(0.16, 0.12, 0.08),
  });
  page.drawText("A project of Not By Chance Outreach", {
    x: 56,
    y: 696,
    size: 11,
    font,
    color: rgb(0.25, 0.25, 0.25),
  });
  const lines = [
    "1. Pick a page you like.",
    "2. Color it any way you want. Markers, crayons, paint, jokes, glitter if your grown-up is brave.",
    "3. Add a message if you feel like it. Funny is fine. Quiet is fine.",
    "4. Take a picture of the finished page.",
    "5. Open the camera on a phone and point it at this QR code, or visit the website.",
    "6. Send the picture back to us. A person reviews every piece before anything is shown in public.",
  ];
  let y = 640;
  page.drawText("How to play", { x: 56, y, size: 14, font: bold, color: rgb(0.16, 0.12, 0.08) });
  y -= 28;
  for (const line of lines) {
    page.drawText(line.slice(0, 95), { x: 56, y, size: 11, font, color: rgb(0.15, 0.15, 0.15) });
    y -= 22;
  }
  const dest = groupPublicId ? `${origin}/submit?group=${groupPublicId}` : `${origin}/submit`;
  const qrUrl = await QRCode.toDataURL(dest, { margin: 1, width: 280 });
  const png = await doc.embedPng(await (await fetch(qrUrl)).arrayBuffer());
  page.drawImage(png, { x: 186, y: 220, width: 240, height: 240 });
  page.drawText("Send your art here", {
    x: 210,
    y: 196,
    size: 12,
    font: bold,
    color: rgb(0.16, 0.12, 0.08),
  });
  page.drawText(dest, { x: 56, y: 170, size: 9, font, color: rgb(0.3, 0.3, 0.3) });
  page.drawText("No account. No wallet. Printing is free.", {
    x: 56,
    y: 72,
    size: 10,
    font,
    color: rgb(0.25, 0.25, 0.25),
  });
  return page;
}

export function downloadBlob(blob: Blob, filename: string) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}
