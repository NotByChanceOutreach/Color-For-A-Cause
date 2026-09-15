import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mkdirSync, writeFileSync } from "node:fs";

const require = createRequire(import.meta.url);
const puppeteer = require("puppeteer-core");
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "previews", "human-validation");
const BASE = "http://127.0.0.1:5173";
const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const ART = path.join(ROOT, "public", "art", "pup-color.jpg");
mkdirSync(OUT, { recursive: true });

const notes = [];
const log = (id, status, n) => {
  notes.push({ id, status, n });
  console.log(`[${status}] ${id} — ${n}`);
};

async function clickText(page, label) {
  const ok = await page.evaluate((want) => {
    const el = [...document.querySelectorAll("button, a, label")].find((n) =>
      (n.textContent || "").replace(/\s+/g, " ").trim().toLowerCase().includes(want.toLowerCase()),
    );
    if (!el) return false;
    el.click();
    return true;
  }, label);
  if (!ok) throw new Error("missing " + label);
  await new Promise((r) => setTimeout(r, 200));
}

async function walkSubmit(page, { name, message, pickPage, extraPerms }) {
  await page.goto(`${BASE}/submit`, { waitUntil: "networkidle0" });
  if (pickPage) {
    await page.evaluate((title) => {
      const b = [...document.querySelectorAll("button.page-card")].find((el) =>
        (el.textContent || "").includes(title),
      );
      b?.click();
    }, pickPage);
  }
  await clickText(page, "Next");
  const input = await page.$('input[name="photo-file"]');
  await input.uploadFile(ART);
  await page.waitForSelector("img.preview-art");
  await clickText(page, "Next");
  await page.waitForFunction(() => /look what you made/i.test(document.body.innerText));
  await clickText(page, "Next");
  await page.waitForSelector("#attr");
  if (name) {
    await page.click("#attr", { clickCount: 3 });
    await page.type("#attr", name);
  }
  await clickText(page, "Next");
  await page.waitForSelector("#msg");
  await page.type("#msg", message);
  await clickText(page, "Next");
  await page.waitForSelector('input[name="store"]');
  if (Array.isArray(extraPerms)) {
    await page.click('input[name="store"]');
    for (const p of extraPerms) await page.click(`input[name="${p}"]`);
  }
  await page.click('button[type="submit"]');
}

const browser = await puppeteer.launch({ executablePath: CHROME, headless: "new" });
const page = await browser.newPage();
page.setDefaultTimeout(20000);
await page.setViewport({ width: 1440, height: 900 });

try {
  // Missing required store permission
  await walkSubmit(page, { name: "Alex", message: "Stay warm.", pickPage: "Happy Pup" });
  await new Promise((r) => setTimeout(r, 600));
  const missing = await page.evaluate(() => document.body.innerText);
  const stillOnSubmit = page.url().includes("/submit") && !page.url().includes("success");
  log(
    "missing-store",
    stillOnSubmit && /need permission to store|check the form|Whoops/i.test(missing) ? "PASS" : "FAIL",
    `${page.url()} | ${missing.slice(0, 240).replaceAll("\n", " | ")}`,
  );

  // XSS
  await walkSubmit(page, {
    name: "Sam",
    message: '<script>window.__xss=1</script><img src=x onerror="window.__xss=1"> hello',
    pickPage: "Happy Pup",
    extraPerms: ["displayPublic", "showMessage", "showAttribution"],
  });
  await page.waitForFunction(() => location.pathname.includes("/submit/success/"));
  const xssId = page.url().split("/").pop();
  const xssFired = await page.evaluate(() => window.__xss === 1);
  log("xss-not-executed-on-success", !xssFired ? "PASS" : "FAIL", page.url());

  // Email + address flags
  await walkSubmit(page, {
    name: "Pat",
    message: "email me kid@example.com I live at 12 Oak Street",
    pickPage: "Simple Snug",
    extraPerms: ["displayPublic", "showMessage"],
  });
  await page.waitForFunction(() => location.pathname.includes("/submit/success/"));
  const flagId = page.url().split("/").pop();

  await page.goto(`${BASE}/staff/login`, { waitUntil: "networkidle0" });
  if (page.url().includes("login")) {
    await page.click("#pw", { clickCount: 3 });
    await page.type("#pw", "local-dev-only");
    await page.click('button[type="submit"]');
    await page.waitForFunction(() => location.pathname === "/staff");
  }
  await page.goto(`${BASE}/staff/submissions/${flagId}`, { waitUntil: "networkidle0" });
  const flagText = await page.evaluate(() => document.body.innerText);
  log(
    "email-address-flags",
    /possible_email/.test(flagText) && /possible_address/.test(flagText) ? "PASS" : "FAIL",
    flagText.match(/Flags:[^|]+/)?.[0] || flagText.slice(0, 300).replaceAll("\n", " | "),
  );

  await page.goto(`${BASE}/staff/submissions/${xssId}`, { waitUntil: "networkidle0" });
  const xssStaff = await page.evaluate(() => document.body.innerText);
  const xssExec = await page.evaluate(() => window.__xss === 1);
  log("xss-staff-text", /script/i.test(xssStaff) && !xssExec ? "PASS" : "FAIL", "message shown as text; no execution");

  // Unapproved chalk id from prior run
  await page.goto(`${BASE}/wall/sub_3e894a2bd1e2eaa98cb161278c3031bc`, { waitUntil: "networkidle0" });
  const hidden = await page.evaluate(() => document.body.innerText);
  log(
    "prior-unapproved-url",
    /not on the wall/i.test(hidden) ? "PASS" : "FAIL",
    hidden.slice(0, 200).replaceAll("\n", " | "),
  );

  // Group submit two artworks
  await page.goto(`${BASE}/submit/group`, { waitUntil: "networkidle0" });
  await page.type("#org", "Community Table");
  const files = await page.$$('input[type="file"]');
  await files[0].uploadFile(ART);
  const nameInputs = await page.$$("fieldset input[type='text'], fieldset input:not([type])");
  // fill first artist name
  const inputs = await page.$$("fieldset input");
  if (inputs[1]) await inputs[1].type("ArtistOne");
  await clickText(page, "Add another artwork");
  const files2 = await page.$$('input[type="file"]');
  await files2[files2.length - 1].uploadFile(ART);
  await page.click('button[type="submit"]');
  await new Promise((r) => setTimeout(r, 1500));
  const groupBody = await page.evaluate(() => document.body.innerText);
  log("group-submit", /NBC-ART-/.test(groupBody) ? "PASS" : "PARTIALLY VERIFIED", groupBody.slice(0, 400).replaceAll("\n", " | "));

  await page.goto(`${BASE}/submit?group=abc123public`, { waitUntil: "networkidle0" });
  const qrLand = await page.evaluate(() => document.body.innerText);
  log("qr-landing", /send us your art/i.test(qrLand) ? "PASS" : "FAIL", page.url());

  await page.setViewport({ width: 768, height: 1024 });
  await page.goto(`${BASE}/color`, { waitUntil: "networkidle0" });
  const scroll768 = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 8);
  log("tablet-no-hscroll", !scroll768 ? "PASS" : "FAIL", `scrollWidth overflow=${scroll768}`);
  await page.setViewport({ width: 375, height: 812 });
  await page.goto(`${BASE}/submit`, { waitUntil: "networkidle0" });
  const scroll375 = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 8);
  log("mobile-no-hscroll", !scroll375 ? "PASS" : "FAIL", `overflow=${scroll375}`);
} catch (e) {
  log("followup-runner", "FAIL", String(e.stack || e));
} finally {
  writeFileSync(path.join(OUT, "followup.json"), JSON.stringify(notes, null, 2));
  await browser.close();
}
