/**
 * Per-connection rate limits (contract C7). Fixed hourly windows stored in the server-only `rateLimits`
 * collection, keyed by a SHA-256 of (action, window, key) so no raw IP or group code is stored.
 * `expiresAt` is a Firestore TTL field (see firestore.indexes.json); the daily retention job also sweeps it.
 *
 * App Check is the primary control: every callable requires a valid token, and submitArtwork and createGroup refuse
 * a token that was already used (appCheck.ts). These limits are a backstop.
 */
import { createHash } from "node:crypto";
import { RATE_LIMITS, type RateAction } from "./constants";
import { fail } from "./errors";
import type { Db } from "./store";

/**
 * Proxies that append to X-Forwarded-For in front of the function: Firebase Hosting appends the visitor's
 * address, then Google's front end appends Hosting's. So the visitor is the entry just before the last one.
 * A caller that bypasses Hosting can forge the earlier entries and so pick a fresh bucket, but on submitArtwork and
 * createGroup each App Check token works only once (appCheck.ts), so every call still costs a new attestation.
 *
 * Production reads the TRUSTED_PROXY_HOPS param (index.ts, default below). The "x-forwarded-for shape" log line
 * (entry count and the index used, never the addresses) shows whether the default is right.
 */
export const DEFAULT_TRUSTED_PROXY_HOPS = 1;
export const MAX_TRUSTED_PROXY_HOPS = 5;

/** A usable hop count from the param value; anything missing or odd falls back to the default. */
export function resolveTrustedProxyHops(raw: unknown): number {
  const n = typeof raw === "string" && /^\d+$/.test(raw.trim()) ? Number(raw.trim()) : raw;
  return typeof n === "number" && Number.isInteger(n) && n >= 0 && n <= MAX_TRUSTED_PROXY_HOPS ? n : DEFAULT_TRUSTED_PROXY_HOPS;
}

function expandIpv6(ip: string): string[] | null {
  const halves = ip.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 1 ? head.length !== 8 : missing < 1) return null;
  const all = [...head, ...new Array<string>(halves.length === 2 ? missing : 0).fill("0"), ...tail];
  if (!all.every((g) => /^[0-9a-f]{1,4}$/.test(g))) return null;
  return all.map((g) => g.replace(/^0+(?=[0-9a-f])/, ""));
}

/** IPv4 as-is (port stripped), IPv4-mapped IPv6 as IPv4, other IPv6 grouped by /64 (one household/phone). */
export function normalizeIp(raw: string): string {
  let ip = raw.trim().toLowerCase();
  const bracketed = /^\[([^\]]+)\](?::\d+)?$/.exec(ip);
  if (bracketed) ip = bracketed[1];
  const zone = ip.indexOf("%");
  if (zone >= 0) ip = ip.slice(0, zone);
  const v4 = /^(\d{1,3}(?:\.\d{1,3}){3})(?::\d+)?$/.exec(ip);
  if (v4) return v4[1];
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(ip);
  if (mapped) return mapped[1];
  if (ip.includes(":")) {
    const groups = expandIpv6(ip);
    if (groups) return `${groups.slice(0, 4).join(":")}::/64`;
  }
  return ip.slice(0, 64) || "unknown";
}

export type ClientIpInfo = {
  ip: string;
  /** Number of X-Forwarded-For entries. */
  entries: number;
  /** 0-based index (from the left) of the entry used, or null when the socket address was used. */
  index: number | null;
};

export function clientIpInfo(
  headers: Record<string, string | string[] | undefined>,
  socketIp?: string,
  hops: number = DEFAULT_TRUSTED_PROXY_HOPS,
): ClientIpInfo {
  const raw = headers["x-forwarded-for"];
  const list = (Array.isArray(raw) ? raw.join(",") : raw ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (list.length > hops) {
    const index = list.length - 1 - hops;
    return { ip: normalizeIp(list[index]), entries: list.length, index };
  }
  if (list.length) return { ip: normalizeIp(list[0]), entries: list.length, index: 0 };
  return { ip: normalizeIp(socketIp ?? ""), entries: 0, index: null };
}

export function clientIp(
  headers: Record<string, string | string[] | undefined>,
  socketIp?: string,
  hops: number = DEFAULT_TRUSTED_PROXY_HOPS,
): string {
  return clientIpInfo(headers, socketIp, hops).ip;
}

export type XffShape = { reason: "cold-start" | "sample"; xffEntries: number; indexUsed: number | null; trustedProxyHops: number };

/**
 * Logs the SHAPE of X-Forwarded-For (how many entries, which index was used): once per instance (cold
 * start), then for a small sample of requests. Never the addresses themselves.
 */
export function xffShapeLogger(
  log: (fields: XffShape) => void,
  opts: { sampleRate?: number; random?: () => number } = {},
): (info: ClientIpInfo, hops: number) => void {
  const sampleRate = opts.sampleRate ?? 0.01;
  const random = opts.random ?? Math.random;
  let first = true;
  return (info, hops) => {
    const reason = first ? "cold-start" : random() < sampleRate ? "sample" : null;
    first = false;
    if (reason) log({ reason, xffEntries: info.entries, indexUsed: info.index, trustedProxyHops: hops });
  };
}

/** The art-day bucket: one group code on one connection. */
export function groupRateKey(groupPublicId: string, ip: string): string {
  return `group:${groupPublicId}|ip:${ip}`;
}

export function rateLimitDocId(action: RateAction, key: string, windowStart: number): string {
  const digest = createHash("sha256").update(`cfac-rate:${action}:${windowStart}:${key}`).digest("hex");
  return `${action}_${digest}`;
}

const MESSAGES: Record<RateAction, string> = {
  submitArtwork:
    "Lots of pictures have been sent from this connection in the last hour. Please wait a little while and try again.",
  submitArtworkGroup:
    "Lots of pictures have been sent for this group from this connection in the last hour. Please wait a little while and try again.",
  createGroup:
    "Lots of groups have been started from this connection in the last hour. Please wait a little while and try again.",
};

/** `key` is the client IP, or groupRateKey(group, ip) for submitArtworkGroup. Only its hash is stored. */
export async function consumeRateLimit(db: Db, action: RateAction, key: string, nowMs: number): Promise<void> {
  const { max, windowMs } = RATE_LIMITS[action];
  const windowStart = Math.floor(nowMs / windowMs) * windowMs;
  const ref = db.doc(`rateLimits/${rateLimitDocId(action, key, windowStart)}`);
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const count = snap.exists ? Number(snap.data()?.count ?? 0) : 0;
    if (count >= max) fail("resource-exhausted", MESSAGES[action]);
    tx.set(ref, {
      action,
      count: count + 1,
      windowStart: new Date(windowStart),
      expiresAt: new Date(windowStart + 2 * windowMs),
    });
  });
}
