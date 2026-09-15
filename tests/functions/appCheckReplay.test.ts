// @vitest-environment node
/**
 * Replay protection (B), driven through the REAL firebase-functions onCall wrapper: the exported submitArtwork,
 * createGroup and finalizeSubmission from functions/src/index.ts, served by express, with App Check's verifyToken
 * given real consume semantics (the first consume answers alreadyConsumed: false, every later one true).
 *
 * If refuseReplayedAppCheckToken were removed from a replay-protected callable, the second use of a token would
 * reach the handler and answer 400 (invalid-argument, the bad test data) instead of 401.
 */
import type { Server } from "node:http";
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { REPLAYED_TOKEN_MESSAGE, refuseReplayedAppCheckToken } from "../../functions/src/appCheck";
import { expectSyncCode } from "./fixtures";

const fnRequire = createRequire(resolve("functions/package.json"));
type Reply = { status: number; body: { result?: unknown; error?: { status?: string; message?: string } } };

let server: Server | null = null;
let base = "";
let restore: () => void = () => undefined;
const consumed = new Set<string>();
const verified: Array<{ token: string; consume: boolean }> = [];

beforeAll(async () => {
  // Offline: a demo project, no credentials. Nothing below talks to Google.
  process.env.FIREBASE_CONFIG = JSON.stringify({ projectId: "demo-cfac", storageBucket: "demo-cfac.appspot.com" });
  process.env.GCLOUD_PROJECT = "demo-cfac";
  const fns = await import("../../functions/src/index");

  const { getAppCheck } = fnRequire("firebase-admin/app-check");
  const proto = Object.getPrototypeOf(getAppCheck());
  const original = proto.verifyToken;
  proto.verifyToken = async function verifyToken(token: string, options?: { consume?: boolean }) {
    verified.push({ token, consume: options?.consume === true });
    if (!token.startsWith("good-")) throw new Error("invalid App Check token");
    const result: Record<string, unknown> = { appId: "1:0:web:demo", token: { app_id: "1:0:web:demo" } };
    if (options?.consume) {
      result.alreadyConsumed = consumed.has(token);
      consumed.add(token);
    }
    return result;
  };
  restore = () => {
    proto.verifyToken = original;
  };

  const express = fnRequire("express");
  const app = express();
  app.use(express.json());
  const exported: Record<string, (req: unknown, res: unknown) => unknown> = {
    submitArtwork: fns.submitArtwork as never,
    createGroup: fns.createGroup as never,
    finalizeSubmission: fns.finalizeSubmission as never,
  };
  for (const [name, fn] of Object.entries(exported)) app.post(`/${name}`, (req: unknown, res: unknown) => fn(req, res));
  server = await new Promise<Server>((ok) => {
    const s: Server = app.listen(0, "127.0.0.1", () => ok(s));
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  restore();
  await new Promise<void>((ok) => (server ? server.close(() => ok()) : ok()));
});

async function call(name: string, data: unknown, token?: string): Promise<Reply> {
  const res = await fetch(`${base}/${name}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: "https://notbychance-color-for-a-cause.web.app",
      ...(token ? { "x-firebase-appcheck": token } : {}),
    },
    body: JSON.stringify({ data }),
  });
  return { status: res.status, body: (await res.json()) as Reply["body"] };
}

describe("B replay protection through the real onCall wrapper", () => {
  it.each([
    ["submitArtwork", {}],
    ["createGroup", { label: 5 }],
  ])("%s: a fresh token reaches the handler; the same token again is refused with 401 before any work", async (name, data) => {
    const token = `good-${name}-1`;
    const first = await call(name, data, token);
    // The handler ran: it refused the (deliberately bad) data, which it can only do after the token check.
    expect(first.status).toBe(400);
    expect(first.body.error?.status).toBe("INVALID_ARGUMENT");
    expect(verified.filter((v) => v.token === token)).toEqual([{ token, consume: true }]);

    const replay = await call(name, data, token);
    expect(replay.status).toBe(401);
    expect(replay.body.error).toEqual({ status: "UNAUTHENTICATED", message: REPLAYED_TOKEN_MESSAGE });

    // A new token works again.
    expect((await call(name, data, `good-${name}-2`)).status).toBe(400);
  });

  it("finalizeSubmission does not consume tokens, so the browser's retries keep working", async () => {
    const token = "good-finalize";
    for (let i = 0; i < 3; i++) {
      const r = await call("finalizeSubmission", {}, token);
      expect(r.status).toBe(400);
      expect(r.body.error?.status).toBe("INVALID_ARGUMENT");
    }
    expect(verified.filter((v) => v.token === token).every((v) => !v.consume)).toBe(true);
  });

  it("missing and invalid tokens are refused by the framework", async () => {
    expect((await call("submitArtwork", {})).status).toBe(401);
    expect((await call("submitArtwork", {}, "forged")).status).toBe(401);
    expect((await call("createGroup", {}, "forged")).status).toBe(401);
  });
});

describe("B refuseReplayedAppCheckToken fails closed", () => {
  it.each([
    ["already consumed", { app: { alreadyConsumed: true } }],
    ["no consume answer", { app: {} }],
    ["no App Check data", {}],
  ])("refuses: %s", (_name, req) => {
    const err = expectSyncCode(() => refuseReplayedAppCheckToken(req), "unauthenticated");
    expect(err.message).toBe(REPLAYED_TOKEN_MESSAGE);
  });

  it("lets a first use through", () => {
    expect(() => refuseReplayedAppCheckToken({ app: { alreadyConsumed: false } })).not.toThrow();
  });
});
