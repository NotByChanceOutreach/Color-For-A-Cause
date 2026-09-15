import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { NAME_REQUIRED, ServerRefusal, explainServerError, isNameRefusal, isPieceRefusal } from "../src/lib/refusals";

/** The codes the production backend lets through to the public forms (src/lib/firebaseBackend.ts PUBLIC_MESSAGES). */
const PUBLIC = /(invalid-argument|failed-precondition|resource-exhausted)$/;
const callableError = (code: string, message: string) => Object.assign(new Error(message), { code });

describe("server refusals keep their code for the forms (round 4, D)", () => {
  it("a callable refusal of a name becomes a ServerRefusal with the bare code and the server's own words", () => {
    const err = explainServerError(callableError("functions/invalid-argument", NAME_REQUIRED), "fallback", PUBLIC, true);
    expect(err).toBeInstanceOf(ServerRefusal);
    expect((err as ServerRefusal).code).toBe("invalid-argument");
    expect(err.message).toBe(NAME_REQUIRED);
    expect(isNameRefusal(err)).toBe(true);
    expect(isPieceRefusal(err)).toBe(true);
  });

  it("Firebase's prefix and code suffix are removed; a refusal of the piece's choices is a piece refusal too", () => {
    const err = explainServerError(
      callableError("functions/failed-precondition", "Firebase: Some artists are under 18. (functions/failed-precondition)."),
      "fallback",
      PUBLIC,
      true,
    );
    expect(err.message).toBe("Some artists are under 18.");
    expect(isPieceRefusal(err)).toBe(true);
    expect(isNameRefusal(err)).toBe(false);
  });

  it("a rate limit, a failed connection, or a call without keepCode is no piece refusal (the batch stops as before)", () => {
    expect(isPieceRefusal(explainServerError(callableError("functions/resource-exhausted", "Slow down."), "f", PUBLIC, true))).toBe(false);
    const down = explainServerError(callableError("functions/unavailable", "boom"), "fallback", PUBLIC, true);
    expect(down).not.toBeInstanceOf(ServerRefusal);
    expect(down.message).toBe("fallback");
    const staff = explainServerError(callableError("functions/invalid-argument", "x"), "fallback", PUBLIC);
    expect(staff).not.toBeInstanceOf(ServerRefusal);
    expect(staff.message).toBe("x");
  });

  it("the production submit keeps the code, so the forms can flag the refused piece", () => {
    const src = readFileSync("src/lib/firebaseBackend.ts", "utf8");
    const submit = src.slice(src.indexOf("async submit(input"), src.indexOf("async getSubmission("));
    expect(submit).toMatch(/throw friendly\(err, TRY_AGAIN, PUBLIC_MESSAGES, true\);/);
    expect(src).toMatch(/const friendly = explainServerError;/);
    // The browser's own store check is a refusal of that piece too (round 5, E): a group batch flags it and goes on.
    expect(submit).toMatch(/if \(!input\.permissions\.store\) throw new ServerRefusal\("failed-precondition", STORE_REQUIRED\);/);
  });
});
