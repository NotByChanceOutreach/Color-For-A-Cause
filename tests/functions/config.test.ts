import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { REGION } from "../../functions/src/constants";

const firebase = JSON.parse(readFileSync("firebase.json", "utf8"));
const functionsPkg = JSON.parse(readFileSync("functions/package.json", "utf8"));

describe("C10 runtime", () => {
  it("runs on Node 22 in us-central1", () => {
    expect(firebase.functions[0].runtime).toBe("nodejs22");
    expect(functionsPkg.engines.node).toBe("22");
    expect(REGION).toBe("us-central1");
    const fnRewrites = firebase.hosting.rewrites.filter((r: { function?: unknown }) => r.function);
    expect(fnRewrites.map((r: { function: { functionId: string } }) => r.function.functionId).sort()).toEqual([
      "createGroup",
      "finalizeSubmission",
      "getGroup",
      "moderateSubmission",
      "submitArtwork",
      "upsertCollectible",
    ]);
    for (const r of fnRewrites) expect(r.function.region).toBe("us-central1");
  });

  it("sharp is a runtime dependency of the functions", () => {
    expect(functionsPkg.dependencies.sharp).toBeTruthy();
  });
});

describe("README deploy steps", () => {
  const readme = readFileSync("README.md", "utf8");

  it("never tells anyone to enforce App Check on Cloud Storage (the wall's tokenless <img> URLs cannot carry a token)", () => {
    expect(readme).toMatch(/Do not enforce App Check for Cloud Storage/);
    expect(readme).not.toMatch(/Enforce\*\* for both/);
    expect(readme).toMatch(/Cloud Firestore:[^\n]*only when/);
  });

  it("names the IAM role the cross-service Art Wall rule needs", () => {
    expect(readme).toMatch(/roles\/firebaserules\.firestoreServiceAgent/);
    expect(readme).toMatch(/gcp-sa-firebasestorage\.iam\.gserviceaccount\.com/);
    expect(readFileSync("storage.rules", "utf8")).toMatch(/firestore\.exists\(\/databases\/\(default\)\/documents\/publicGallery\/\$\(submissionId\)\)/);
  });
});

describe("a deploy is picked up at once", () => {
  type HeaderRule = { source?: string; regex?: string; headers: Array<{ key: string; value: string }> };
  const rules = firebase.hosting.headers as HeaderRule[];
  const cacheFor = (path: string) =>
    rules
      .filter((r) => (r.source !== undefined ? r.source === path || r.source === "**" : new RegExp(r.regex ?? "$^").test(path)))
      .flatMap((r) => r.headers)
      .filter((h) => h.key === "Cache-Control")
      .map((h) => h.value);

  it("index.html and every SPA route (served the index.html fallback) are revalidated: Cache-Control no-cache", () => {
    for (const path of ["/index.html", "/", "/wall", "/submit", "/submit/success/sub_0123", "/staff/submissions"]) {
      expect(cacheFor(path), path).toEqual(["no-cache"]);
    }
    const spa = firebase.hosting.rewrites.find((r: { source: string }) => r.source === "**");
    expect(spa.destination).toBe("/index.html");
  });

  it("hashed assets and the printables keep their own caching", () => {
    expect(cacheFor("/assets/index-CTQMy9Qa.js")).toEqual([]);
    expect(cacheFor("/library/print/happy-pup.pdf")).not.toContain("no-cache");
  });
});

describe("Content-Security-Policy header", () => {
  const all = firebase.hosting.headers.find((h: { source: string }) => h.source === "**");
  const csp: string = all.headers.find((h: { key: string }) => h.key === "Content-Security-Policy")?.value ?? "";
  const directive = (name: string) =>
    csp
      .split(";")
      .map((s) => s.trim())
      .find((d) => d === name || d.startsWith(`${name} `)) ?? "";

  it("locks down scripts, plugins, base and framing", () => {
    expect(directive("default-src")).toBe("default-src 'self'");
    expect(directive("script-src")).toMatch(/^script-src 'self' /);
    expect(directive("script-src")).not.toMatch(/unsafe-inline|unsafe-eval|\*|data:|blob:/);
    expect(directive("style-src")).not.toMatch(/unsafe-inline/);
    expect(directive("object-src")).toBe("object-src 'none'");
    expect(directive("frame-ancestors")).toBe("frame-ancestors 'none'");
    expect(directive("base-uri")).toBe("base-uri 'self'");
    expect(directive("form-action")).toBe("form-action 'self'");
    expect(csp).not.toMatch(/https?:\/\/\*|'unsafe-eval'/);
  });

  it("allows what the app actually talks to", () => {
    for (const origin of [
      "https://firestore.googleapis.com",
      "https://firebasestorage.googleapis.com",
      "https://storage.googleapis.com",
      "https://identitytoolkit.googleapis.com",
      "https://securetoken.googleapis.com",
      "https://content-firebaseappcheck.googleapis.com",
    ]) {
      expect(directive("connect-src")).toContain(origin);
    }
    expect(directive("script-src")).toContain("https://www.google.com/recaptcha/");
    expect(directive("script-src")).toContain("https://www.gstatic.com/recaptcha/");
    expect(directive("frame-src")).toContain("https://www.google.com/recaptcha/");
    expect(directive("style-src")).toContain("https://fonts.googleapis.com");
    expect(directive("font-src")).toContain("https://fonts.gstatic.com");
    expect(directive("img-src")).toContain("https://firebasestorage.googleapis.com");
  });
});

describe("no full-collection scans in the functions", () => {
  it("every server read is a document, a filtered query, or limited", () => {
    const src = readdirSync("functions/src")
      .filter((f) => f.endsWith(".ts"))
      .map((f) => readFileSync(`functions/src/${f}`, "utf8"))
      .join("\n");
    expect(src).not.toMatch(/\.collection\(\s*"[^"]+"\s*\)\s*\.get\(\)/);
    expect(src).not.toMatch(/bumpPublicCounters/);
    const queries = [...src.matchAll(/\.collection\("[^"]+"\)((?:\s*\.\w+\([^)]*\))*)\s*\.get\(\)/g)].map((m) => m[1]);
    for (const chain of queries) expect(chain).toMatch(/\.limit\(/);
  });
});
