/**
 * Human-flow validation against the running Vite app.
 * Usage: node scripts/human-validate.mjs
 */
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const puppeteer = require("puppeteer-core");

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "previews", "human-validation");
const BASE = "http://127.0.0.1:5173";
const CHROME = process.env.CHROME || "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const ART = path.join(ROOT, "public", "art", "pup-color.jpg");

mkdirSync(OUT, { recursive: true });

const report = [];
const consoleErrors = [];
const failedRequests = [];

function log(id, status, notes) {
  report.push({ id, status, notes });
  console.log(`[${status}] ${id} — ${notes}`);
}

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: "new",
  args: ["--hide-scrollbars", "--no-first-run"],
});
const page = await browser.newPage();
page.setDefaultTimeout(20000);
page.on("pageerror", (e) => consoleErrors.push(String(e)));
page.on("console", (msg) => {
  if (msg.type() === "error") consoleErrors.push(msg.text());
});
page.on("requestfailed", (req) => {
  failedRequests.push(`${req.method()} ${req.url()} ${req.failure()?.errorText || ""}`);
});

const client = await page.createCDPSession();
await client.send("Page.setDownloadBehavior", {
  behavior: "allow",
  downloadPath: OUT,
});

async function shot(name) {
  await page.screenshot({ path: path.join(OUT, `${name}.png`), fullPage: true });
}

try {
  await page.setViewport({ width: 1440, height: 900 });
  await page.goto(BASE, { waitUntil: "networkidle0" });
  await shot("01-home");
  const h1 = await page.$eval("h1", (el) => el.innerText);
  log("home-load", h1.toLowerCase().includes("stay warm") ? "PASS" : "FAIL", `h1=${JSON.stringify(h1)}`);

  await page.click('a[href="/color"]');
  await page.waitForSelector(".page-card");
  await shot("02-color");
  log("color-library", "PASS", "library cards rendered");

  await page.click('a[href="/color/happy-pup"]');
  await page.waitForSelector(".detail-stage img");
  const src = await page.$eval(".detail-stage img", (el) => el.getAttribute("src"));
  log("page-detail", src?.includes("happy-pup") ? "PASS" : "FAIL", `preview=${src}`);
  await shot("03-detail");

  const pdfHref = await page.$eval('a[href$="happy-pup.pdf"]', (el) => el.href);
  const pngHref = await page.$eval('a[href$="happy-pup.png"]', (el) => el.href);
  const pdfRes = await fetch(pdfHref);
  const pngRes = await fetch(pngHref);
  const pdfBuf = Buffer.from(await pdfRes.arrayBuffer());
  const pngBuf = Buffer.from(await pngRes.arrayBuffer());
  writeFileSync(path.join(OUT, "happy-pup.pdf"), pdfBuf);
  writeFileSync(path.join(OUT, "happy-pup.png"), pngBuf);
  const pdfOk = pdfRes.ok && pdfBuf.slice(0, 5).toString() === "%PDF-";
  const pngOk = pngRes.ok && pngBuf[0] === 0x89 && pngBuf[1] === 0x50;
  log("pdf-download", pdfOk ? "PASS" : "FAIL", `status=${pdfRes.status} bytes=${pdfBuf.length} magic=${pdfBuf.slice(0, 8).toString()}`);
  log("png-download", pngOk ? "PASS" : "FAIL", `status=${pngRes.status} bytes=${pngBuf.length}`);

  await page.evaluate(() => {
    const b = [...document.querySelectorAll("button")].find((el) => /print me/i.test(el.textContent || ""));
    if (!b) throw new Error("Print me button missing");
    b.click();
  });
  await page.waitForFunction(() => location.pathname.includes("/print/happy-pup"));
  await page.waitForSelector(".print-sheet img");
  const printSrc = await page.$eval(".print-sheet img", (el) => el.getAttribute("src"));
  const headerHidden = await page.evaluate(() => !document.querySelector(".site-header") || getComputedStyle(document.querySelector(".site-header")).display);
  await shot("04-print");
  log(
    "print-view",
    printSrc?.includes("happy-pup.png") ? "PASS" : "FAIL",
    `src=${printSrc}; headerInDOM=${!!(await page.$(".site-header"))} (print CSS hides it)`,
  );

  await page.goto(`${BASE}/print/happy-pup`, { waitUntil: "networkidle0" });
  await page.setViewport({ width: 375, height: 812 });
  await shot("04-print-375");
  log("print-mobile-route", page.url().includes("/print/happy-pup") ? "PASS" : "FAIL", page.url());

  await page.setViewport({ width: 1440, height: 900 });
  await page.goto(`${BASE}/color/happy-pup`, { waitUntil: "networkidle0" });
  log("nav-after-print", page.url().includes("/color/happy-pup") ? "PASS" : "FAIL", page.url());

  for (const route of ["/color", "/submit", "/wall", "/host", "/grown-ups", "/staff/login", "/packs", "/impact"]) {
    const res = await page.goto(`${BASE}${route}`, { waitUntil: "networkidle0" });
    log(`direct-${route.replaceAll("/", "") || "home"}`, res?.ok() ? "PASS" : "FAIL", `${route} status=${res?.status()}`);
  }

  async function clickText(label) {
    const ok = await page.evaluate((want) => {
      const el = [...document.querySelectorAll("button, a, label")].find((n) =>
        (n.textContent || "").replace(/\s+/g, " ").trim().toLowerCase().includes(want.toLowerCase()),
      );
      if (!el) return false;
      el.click();
      return true;
    }, label);
    if (!ok) throw new Error(`control not found: ${label}`);
    await new Promise((r) => setTimeout(r, 250));
  }

  await page.goto(`${BASE}/packs`, { waitUntil: "networkidle0" });
  await shot("05-packs");
  const before = Date.now();
  await clickText("Easy activity pack");
  await new Promise((r) => setTimeout(r, 4000));
  log("activity-pack-click", "PARTIALLY VERIFIED", `clicked Easy pack; wait 4s for blob download to ${OUT}`);

  await page.setViewport({ width: 375, height: 812 });
  await page.goto(`${BASE}/submit`, { waitUntil: "networkidle0" });
  await shot("06-submit-375");
  await clickText("Next");
  await page.waitForSelector('input[name="photo-file"]');
  const fileInput = await page.$('input[name="photo-file"]');
  await fileInput.uploadFile(ART);
  await page.waitForSelector("img.preview-art", { timeout: 10000 });
  await shot("07-submit-preview");
  await clickText("Next");
  await page.waitForFunction(() => /look what you made/i.test(document.body.innerText));
  await clickText("Next");
  await page.waitForSelector("#attr");
  await page.type("#attr", "Jamie");
  await clickText("Next");
  await page.waitForSelector("#msg");
  await page.type("#msg", "I like eating chalk lol");
  await clickText("Next");
  await page.waitForSelector('input[name="store"]');
  const checks = await page.$$eval('form input[type="checkbox"]', (els) =>
    els.map((e) => ({ name: e.name, checked: e.checked })),
  );
  log("consent-unchecked", checks.every((c) => !c.checked) ? "PASS" : "FAIL", JSON.stringify(checks));
  await page.click('input[name="store"]');
  await page.click('input[name="displayPublic"]');
  await page.click('input[name="showAttribution"]');
  await page.click('input[name="showMessage"]');
  await page.click('button[type="submit"]');
  await page.waitForFunction(() => location.pathname.includes("/submit/success/"), { timeout: 10000 });
  const successText = await page.evaluate(() => document.body.innerText);
  log("submission-success", /NBC-ART-\d{6}/.test(successText) ? "PASS" : "FAIL", successText.slice(0, 280).replaceAll("\n", " | "));
  await shot("08-success");
  const approvedId = page.url().split("/").pop();
  await page.reload({ waitUntil: "networkidle0" });
  const afterReload = await page.evaluate(() => document.body.innerText);
  log("success-refresh", /NBC-ART-\d{6}/.test(afterReload) ? "PASS" : "FAIL", page.url());

  // Second unapproved submission with phone
  await page.goto(`${BASE}/submit`, { waitUntil: "networkidle0" });
  await clickText("Next");
  const fileInput2 = await page.$('input[name="photo-file"]');
  await fileInput2.uploadFile(ART);
  await page.waitForSelector("img.preview-art");
  await clickText("Next");
  await page.waitForFunction(() => /look what you made/i.test(document.body.innerText));
  await clickText("Next");
  await page.waitForSelector("#attr");
  await page.type("#attr", "PrivateKid");
  await clickText("Next");
  await page.waitForSelector("#msg");
  await page.type("#msg", "call me at 555-123-4567");
  await clickText("Next");
  await page.waitForSelector('input[name="store"]');
  await page.click('input[name="store"]');
  await page.click('button[type="submit"]');
  await page.waitForFunction(() => location.pathname.includes("/submit/success/"), { timeout: 10000 });
  const unapprovedUrl = page.url();
  const unapprovedId = unapprovedUrl.split("/").pop();
  log("second-submission", "PASS", unapprovedUrl);

  await page.setViewport({ width: 1440, height: 900 });
  await page.goto(`${BASE}/staff/login`, { waitUntil: "networkidle0" });
  await page.click("#pw", { clickCount: 3 });
  await page.type("#pw", "local-dev-only");
  await page.click('button[type="submit"]');
  await page.waitForFunction(() => location.pathname.startsWith("/staff") && !location.pathname.includes("login"));
  await shot("09-staff");
  log("staff-login", "PASS", page.url());

  await page.goto(`${BASE}/staff/submissions`, { waitUntil: "networkidle0" });
  await shot("10-queue");
  const hrefs = await page.$$eval("table a", (as) => as.map((a) => a.getAttribute("href")));
  log("staff-queue", hrefs.length >= 2 ? "PASS" : "FAIL", JSON.stringify(hrefs));

  if (hrefs[0]) {
    await page.goto(`${BASE}${hrefs[0]}`, { waitUntil: "networkidle0" });
    const staffBody = await page.evaluate(() => document.body.innerText);
    log("staff-review", staffBody.includes("Approve") ? "PASS" : "FAIL", staffBody.slice(0, 500).replaceAll("\n", " | "));
    const chalkPage = staffBody.includes("chalk");
    const phonePage = staffBody.includes("555-123-4567") || staffBody.includes("possible_phone");
    if (chalkPage) log("chalk-humor", !/possible_harmful/.test(staffBody) ? "PASS" : "FAIL", "chalk submission on review");
    if (phonePage) log("phone-flag", /possible_phone/.test(staffBody) ? "PASS" : "FAIL", "phone submission flags");
    await clickText("Approve");
    await new Promise((r) => setTimeout(r, 400));
    await shot("11-approved");
  }

  await page.goto(`${BASE}/wall`, { waitUntil: "networkidle0" });
  await shot("12-wall");
  const wallPieces = await page.$$eval(".wall-piece", (els) => els.map((e) => e.getAttribute("href")));
  log("art-wall-after-approve", wallPieces.length >= 1 ? "PASS" : "FAIL", JSON.stringify(wallPieces));
  const wallHasPrivate = (await page.evaluate(() => document.body.innerText)).includes("PrivateKid");
  const wallHasPhone = (await page.evaluate(() => document.body.innerText)).includes("555-123");
  log("unapproved-not-on-wall", !wallHasPrivate && !wallHasPhone ? "PASS" : "FAIL", `private=${wallHasPrivate} phone=${wallHasPhone}`);

  await page.goto(`${BASE}/wall/${unapprovedId}`, { waitUntil: "networkidle0" });
  const hidden = await page.evaluate(() => document.body.innerText);
  log(
    "unapproved-direct-url",
    /not on the wall/i.test(hidden) && !/555-123/.test(hidden) ? "PASS" : "FAIL",
    hidden.slice(0, 240).replaceAll("\n", " | "),
  );

  if (wallPieces[0]) {
    await page.goto(`${BASE}${wallPieces[0]}`, { waitUntil: "networkidle0" });
    await shot("13-artwork");
    const hasSlider = !!(await page.$("#reveal"));
    if (hasSlider) {
      await page.focus("#reveal");
      await page.keyboard.press("ArrowRight");
    }
    log("before-after", hasSlider ? "PASS" : "FAIL", `slider=${hasSlider} url=${page.url()}`);
  }

  await page.goto(BASE, { waitUntil: "networkidle0" });
  await page.keyboard.press("Tab");
  const focus1 = await page.evaluate(() => document.activeElement?.textContent?.slice(0, 40));
  log("keyboard-skip", /skip/i.test(focus1 || "") ? "PASS" : "PARTIALLY VERIFIED", `first tab=${JSON.stringify(focus1)}`);

  log("console-errors", consoleErrors.length === 0 ? "PASS" : "FAIL", JSON.stringify(consoleErrors.slice(0, 20)));
  log(
    "failed-requests",
    failedRequests.filter((u) => !u.includes("favicon") && !u.includes("chrome-extension")).length === 0
      ? "PASS"
      : "FAIL",
    JSON.stringify(failedRequests.slice(0, 20)),
  );
} catch (err) {
  log("runner", "FAIL", String(err?.stack || err));
} finally {
  writeFileSync(path.join(OUT, "report.json"), JSON.stringify({ report, consoleErrors, failedRequests }, null, 2));
  await browser.close();
}
