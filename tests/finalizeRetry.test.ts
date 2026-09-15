import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { pollFinalize } from "../src/lib/finalizeRetry";

const noSleep = async () => undefined;
const answer = (status: string) => ({ data: { status } });
const err = (code: string) => Object.assign(new Error(code), { code });

function script(steps: Array<unknown | Error>) {
  let i = 0;
  const calls = { n: 0 };
  const call = async () => {
    calls.n += 1;
    const step = steps[Math.min(i++, steps.length - 1)];
    if (step instanceof Error) throw step;
    return step;
  };
  return { call, calls };
}

describe("finalize: a lost answer is asked again, never shown as an error for an accepted upload", () => {
  it("a dropped connection, a timeout or a 5xx is retried, and the piece still ends up submitted", async () => {
    const { call, calls } = script([err("functions/unavailable"), new Error("We could not reach Not By Chance just now."), err("functions/internal"), answer("submitted")]);
    expect(await pollFinalize(call, { attempts: 20, delayMs: 1, sleep: noSleep })).toBe("submitted");
    expect(calls.n).toBe(4);
  });

  it("an answer of 'processing' after transport errors lets the artist go", async () => {
    const { call } = script([err("functions/deadline-exceeded"), answer("processing")]);
    expect(await pollFinalize(call, { attempts: 3, delayMs: 1, sleep: noSleep })).toBe("processing");
  });

  it("a definite answer about the request ends the wait with that error", async () => {
    for (const code of ["functions/not-found", "functions/invalid-argument", "functions/failed-precondition", "functions/permission-denied"]) {
      const { call, calls } = script([err(code), answer("submitted")]);
      await expect(pollFinalize(call, { attempts: 5, delayMs: 1, sleep: noSleep })).rejects.toMatchObject({ code });
      expect(calls.n).toBe(1);
    }
  });

  it("when no call ever got an answer, the last error is thrown", async () => {
    const { call, calls } = script([err("functions/unavailable")]);
    await expect(pollFinalize(call, { attempts: 4, delayMs: 1, sleep: noSleep })).rejects.toMatchObject({ code: "functions/unavailable" });
    expect(calls.n).toBe(4);
  });

  it("the production backend uses it", () => {
    const src = readFileSync("src/lib/firebaseBackend.ts", "utf8");
    expect(src).toMatch(/pollFinalize\(\(\) => finish\(\{ id, finalizeToken \}\)/);
  });
});
