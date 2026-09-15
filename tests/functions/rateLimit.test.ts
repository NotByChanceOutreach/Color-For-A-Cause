import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { RATE_LIMITS } from "../../functions/src/constants";
import { CALLABLE_OPTIONS, REPLAY_PROTECTED_OPTIONS } from "../../functions/src/options";
import {
  DEFAULT_TRUSTED_PROXY_HOPS,
  clientIp,
  clientIpInfo,
  consumeRateLimit,
  groupRateKey,
  normalizeIp,
  rateLimitDocId,
  resolveTrustedProxyHops,
  xffShapeLogger,
  type XffShape,
} from "../../functions/src/rateLimit";
import { FakeDb, NOW, expectCode } from "./fixtures";

const HOUR = 60 * 60 * 1000;
const GROUP = "abcdef012345";

async function spend(db: FakeDb, n: number, action: keyof typeof RATE_LIMITS, key: string) {
  for (let i = 0; i < n; i++) await consumeRateLimit(db, action, key, NOW + i);
}

describe("C7 rate limits (backstop behind App Check)", () => {
  it("limits match the contract", () => {
    expect(RATE_LIMITS.submitArtwork).toEqual({ max: 120, windowMs: HOUR });
    expect(RATE_LIMITS.submitArtworkGroup).toEqual({ max: 300, windowMs: HOUR });
    expect(RATE_LIMITS.createGroup).toEqual({ max: 10, windowMs: HOUR });
  });

  it("allows 120 submissions an hour per address, then resource-exhausted", async () => {
    const db = new FakeDb();
    await spend(db, 120, "submitArtwork", "203.0.113.5");
    await expectCode(consumeRateLimit(db, "submitArtwork", "203.0.113.5", NOW + 200), "resource-exhausted");
    await consumeRateLimit(db, "submitArtwork", "198.51.100.7", NOW + 201);
    await consumeRateLimit(db, "submitArtwork", "203.0.113.5", NOW + HOUR);
  });

  it("an existing group gets its own 300-an-hour bucket per (group, address)", async () => {
    const db = new FakeDb();
    const key = groupRateKey(GROUP, "203.0.113.5");
    await spend(db, 300, "submitArtworkGroup", key);
    const err = await expectCode(consumeRateLimit(db, "submitArtworkGroup", key, NOW + 400), "resource-exhausted");
    expect(err.message).toMatch(/this group/);
    // The plain per-IP bucket is untouched, and other groups or addresses have their own.
    await consumeRateLimit(db, "submitArtwork", "203.0.113.5", NOW + 401);
    await consumeRateLimit(db, "submitArtworkGroup", groupRateKey("0123456789ab", "203.0.113.5"), NOW + 402);
    await consumeRateLimit(db, "submitArtworkGroup", groupRateKey(GROUP, "198.51.100.7"), NOW + 403);
    expect(groupRateKey(GROUP, "203.0.113.5")).not.toBe(groupRateKey(GROUP, "203.0.113.6"));
  });

  it("allows 10 new groups an hour per address", async () => {
    const db = new FakeDb();
    await spend(db, 10, "createGroup", "203.0.113.5");
    const err = await expectCode(consumeRateLimit(db, "createGroup", "203.0.113.5", NOW), "resource-exhausted");
    expect(err.message).toMatch(/wait/i);
    await consumeRateLimit(db, "submitArtwork", "203.0.113.5", NOW);
  });

  it("stores a hash, a count and a TTL expiry, never the address or group code", async () => {
    const db = new FakeDb();
    await consumeRateLimit(db, "createGroup", "203.0.113.5", NOW + 5 * 60 * 1000);
    await consumeRateLimit(db, "submitArtworkGroup", groupRateKey(GROUP, "203.0.113.5"), NOW);
    const paths = [...db.docs.keys()];
    expect(paths.some((p) => /^rateLimits\/createGroup_[0-9a-f]{64}$/.test(p))).toBe(true);
    expect(paths.some((p) => /^rateLimits\/submitArtworkGroup_[0-9a-f]{64}$/.test(p))).toBe(true);
    expect(db.snapshot()).not.toContain("203.0.113.5");
    expect(db.snapshot()).not.toContain(GROUP);
    const row = db.data(paths.find((p) => p.includes("createGroup_"))!)!;
    expect(row.count).toBe(1);
    expect((row.expiresAt as Date).getTime()).toBe(NOW + 2 * HOUR);
    expect(rateLimitDocId("createGroup", "203.0.113.5", NOW)).not.toBe(rateLimitDocId("createGroup", "203.0.113.6", NOW));
  });
});

describe("C7 client address from X-Forwarded-For", () => {
  it("uses the visitor address Hosting appends, not spoofable earlier entries", () => {
    expect(clientIp({ "x-forwarded-for": "203.0.113.5, 35.191.0.1" })).toBe("203.0.113.5");
    expect(clientIp({ "x-forwarded-for": "6.6.6.6, 203.0.113.5, 35.191.0.1" })).toBe("203.0.113.5");
    expect(clientIp({ "x-forwarded-for": ["203.0.113.5", "35.191.0.1"] })).toBe("203.0.113.5");
    expect(clientIp({ "x-forwarded-for": "203.0.113.5" })).toBe("203.0.113.5");
    expect(clientIp({}, "::ffff:198.51.100.7")).toBe("198.51.100.7");
    expect(clientIp({})).toBe("unknown");
  });

  it("honours the configured hop count and reports which index it used", () => {
    const h = { "x-forwarded-for": "6.6.6.6, 203.0.113.5, 35.191.0.1, 35.191.0.2" };
    expect(clientIpInfo(h, undefined, 0)).toEqual({ ip: "35.191.0.2", entries: 4, index: 3 });
    expect(clientIpInfo(h, undefined, 1)).toEqual({ ip: "35.191.0.1", entries: 4, index: 2 });
    expect(clientIpInfo(h, undefined, 2)).toEqual({ ip: "203.0.113.5", entries: 4, index: 1 });
    expect(clientIpInfo({}, "198.51.100.7", 1)).toEqual({ ip: "198.51.100.7", entries: 0, index: null });
  });

  it("TRUSTED_PROXY_HOPS: default 1, odd values fall back to it", () => {
    expect(DEFAULT_TRUSTED_PROXY_HOPS).toBe(1);
    expect(resolveTrustedProxyHops(undefined)).toBe(1);
    expect(resolveTrustedProxyHops(2)).toBe(2);
    expect(resolveTrustedProxyHops("2")).toBe(2);
    expect(resolveTrustedProxyHops(0)).toBe(0);
    for (const bad of ["x", -1, 9, 1.5, "", null]) expect(resolveTrustedProxyHops(bad)).toBe(1);
  });

  it("logs the header SHAPE once per instance, then a sample, and never an address", () => {
    const logged: XffShape[] = [];
    let roll = 0.5;
    const log = xffShapeLogger((f) => logged.push(f), { sampleRate: 0.01, random: () => roll });
    const info = clientIpInfo({ "x-forwarded-for": "203.0.113.5, 35.191.0.1" }, undefined, 1);
    log(info, 1);
    log(info, 1);
    log(info, 1);
    expect(logged).toEqual([{ reason: "cold-start", xffEntries: 2, indexUsed: 0, trustedProxyHops: 1 }]);
    roll = 0.001;
    log(info, 1);
    expect(logged).toHaveLength(2);
    expect(logged[1].reason).toBe("sample");
    expect(JSON.stringify(logged)).not.toMatch(/203\.0\.113|35\.191/);
  });

  it("groups an IPv6 /64 together and strips ports", () => {
    expect(normalizeIp("2001:db8:1:2:3:4:5:6")).toBe(normalizeIp("2001:DB8:1:2:ffff::1"));
    expect(normalizeIp("2001:db8:1:2:3:4:5:6")).not.toBe(normalizeIp("2001:db8:1:3::1"));
    expect(normalizeIp("[2001:db8::1]:443")).toBe("2001:db8:0:0::/64");
    expect(normalizeIp("203.0.113.5:8080")).toBe("203.0.113.5");
  });

  it("index.ts wires the param, the shape log and the buckets", () => {
    const src = readFileSync("functions/src/index.ts", "utf8");
    expect(src).toMatch(/defineInt\("TRUSTED_PROXY_HOPS", \{\s*default: DEFAULT_TRUSTED_PROXY_HOPS/);
    expect(src).toMatch(/xffShapeLogger\(\(fields\) => logger\.info\("x-forwarded-for shape", fields\)\)/);
    expect(src).toMatch(/consumeRateLimit\(db, "submitArtworkGroup", groupRateKey\(group, ip\)/);
    expect(src).toMatch(/consumeRateLimit\(db, "submitArtwork", ip,/);
    expect(src).toMatch(/consumeRateLimit\(db, "createGroup", ipOf\(req\)/);
  });
});

describe("C7 App Check and CORS", () => {
  const origins = ["https://notbychance-color-for-a-cause.web.app", "https://notbychance-color-for-a-cause.firebaseapp.com"];

  it("callable options: App Check enforced, two-origin CORS, replay protection where required", () => {
    expect(CALLABLE_OPTIONS).toEqual({ enforceAppCheck: true, cors: origins, timeoutSeconds: 60 });
    expect(REPLAY_PROTECTED_OPTIONS).toEqual({ enforceAppCheck: true, cors: origins, timeoutSeconds: 60, consumeAppCheckToken: true });
  });

  it("every callable is wired with those options", () => {
    const src = readFileSync("functions/src/index.ts", "utf8");
    const wired = Object.fromEntries([...src.matchAll(/export const (\w+) = onCall\(\s*(\w+)/g)].map((m) => [m[1], m[2]]));
    expect(wired).toEqual({
      submitArtwork: "REPLAY_PROTECTED_OPTIONS",
      finalizeSubmission: "CALLABLE_OPTIONS",
      createGroup: "REPLAY_PROTECTED_OPTIONS",
      getGroup: "CALLABLE_OPTIONS",
      moderateSubmission: "CALLABLE_OPTIONS",
      upsertCollectible: "CALLABLE_OPTIONS",
    });
    expect(src.match(/onCall\(/g)).toHaveLength(6);
  });

  it("the site asks for limited-use tokens on submitArtwork and createGroup", () => {
    const src = readFileSync("src/lib/firebaseBackend.ts", "utf8");
    expect(src).toMatch(/callable\("submitArtwork", true[,)]/);
    expect(src).toMatch(/callable\("createGroup", true[,)]/);
    expect(src).toMatch(/httpsCallableFromURL\([^;]*\{ limitedUseAppCheckTokens,/);
  });
});
