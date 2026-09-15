import puppeteer from "puppeteer-core"; // installed in web/node_modules

const ORIGIN = "https://notbychance-color-for-a-cause.web.app";
const chrome =
  process.env.CHROME ||
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";

const browser = await puppeteer.launch({
  executablePath: chrome,
  headless: true,
  args: ["--no-sandbox", "--disable-gpu"],
});
const page = await browser.newPage();
page.setDefaultTimeout(25000);
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => {
  if (m.type() === "error") errors.push(m.text());
});
const failed = [];
page.on("requestfailed", (r) => failed.push(`${r.method()} ${r.url()} ${r.failure()?.errorText}`));

async function visit(path) {
  const res = await page.goto(`${ORIGIN}${path}`, { waitUntil: "networkidle2" });
  const title = await page.title();
  const h1 = await page.$eval("h1", (el) => el.textContent).catch(() => null);
  return { path, status: res?.status(), title, h1 };
}

const routes = [];
for (const p of ["/", "/color", "/submit", "/wall", "/host", "/grown-ups", "/staff/login", "/packs", "/impact", "/print/happy-pup", "/submit?group=88ef3642f2ac"]) {
  routes.push(await visit(p));
}

await page.setViewport({ width: 375, height: 812 });
routes.push({ ...(await visit("/submit")), viewport: 375 });
await page.setViewport({ width: 1440, height: 900 });
routes.push({ ...(await visit("/")), viewport: 1440 });

await browser.close();
process.stdout.write(JSON.stringify({ routes, errors, failed }, null, 2) + "\n");
if (errors.length) process.exitCode = 2;
