import { describe, expect, it } from "vitest";
import { AGE_RANGES, PERMISSION_KEYS, SUBMITTER_ROLES } from "../../functions/src/constants";
import { MINOR_LOCKED_PERMISSIONS, applyMinorProtections } from "../../functions/src/minors";
import { startSubmission } from "../../functions/src/submit";
import { parseSubmitRequest } from "../../functions/src/validation";
import * as form from "../../src/lib/minors";
import { CTX, expectCode, expectSyncCode, startDeps, validSubmit } from "./fixtures";

const ALL_ON = Object.fromEntries(PERMISSION_KEYS.map((k) => [k, true]));
const CONTRACT_LOCKED = [
  "displayPublic",
  "social",
  "reproduce",
  "promotional",
  "collectible",
  "sellCollectible",
  "showAttribution",
  "showMessage",
];
const ages = [...AGE_RANGES, null] as const;
type Age = (typeof ages)[number];
const isMinor = (age: Age) => age === "under_13" || age === "13_17";
const isAdult = (age: Age) => age === "18_plus";

/** The policy, written out independently of the code under test. */
function expected(age: Age, role: string, attested: boolean): "stand" | "attested" | "locked" | "refused" {
  if (role === "guardian" || isAdult(age)) return "stand";
  if (role === "organization") {
    if (attested) return "attested";
    return isMinor(age) ? "refused" : "locked";
  }
  return "locked"; // self / someone_else with an unknown age or under 18
}

function request(age: Age, role: string, attested: boolean) {
  return parseSubmitRequest(
    validSubmit({
      ageRange: age,
      submitterRole: role,
      permissions: ALL_ON,
      email: "grownup@example.com",
      organizationName: "Troop 5",
      showOrganization: true,
      guardianConsentAttested: attested,
    }),
  );
}

const matrix = ages.flatMap((age) => SUBMITTER_ROLES.flatMap((role) => [false, true].map((attested) => [age, role, attested] as const)));

describe("C5 minors enforcement matrix (unknown age = possible minor)", () => {
  it("covers every age (including null and prefer_not), role and attestation", () => {
    expect(matrix).toHaveLength(5 * 4 * 2);
  });

  it.each(matrix)("age %j / %s / attested=%s", (age, role, attested) => {
    const req = request(age, role, attested);
    const want = expected(age, role, attested);
    if (want === "refused") {
      expectSyncCode(() => applyMinorProtections(req), "failed-precondition");
      return;
    }
    const out = applyMinorProtections(req);
    if (want === "locked") {
      for (const key of CONTRACT_LOCKED) expect(out.request.permissions[key as keyof typeof out.request.permissions]).toBe(false);
      expect(out.request.permissions.store).toBe(true);
      expect(out.request.email).toBeNull();
      expect(out.request.showOrganization).toBe(false);
      expect(out.minorProtectionsApplied).toBe(true);
      expect(out.guardianConsentAttested).toBe(false);
    } else {
      expect(out.request.permissions).toEqual(req.permissions);
      expect(out.request.email).toBe("grownup@example.com");
      expect(out.request.showOrganization).toBe(true);
      expect(out.minorProtectionsApplied).toBe(false);
      expect(out.guardianConsentAttested).toBe(want === "attested");
    }
  });

  it("public sharing needs 18+, a guardian, or an organization that attests", () => {
    for (const [age, role, attested] of matrix) {
      const want = expected(age, role, attested);
      const canShare = want === "stand" || want === "attested";
      expect(canShare).toBe(isAdult(age) || role === "guardian" || (role === "organization" && attested));
    }
  });

  it("locks exactly the contract's list", () => {
    expect([...MINOR_LOCKED_PERMISSIONS].sort()).toEqual([...CONTRACT_LOCKED].sort());
  });
});

describe("C5 what gets stored", () => {
  it("a child sending their own art: stored private, no email", async () => {
    const { deps, db } = startDeps();
    const res = await startSubmission(
      deps,
      validSubmit({ ageRange: "under_13", permissions: ALL_ON, email: "kid@example.com", organizationName: "School", showOrganization: true }),
      CTX,
    );
    const row = db.data(`submissions/${res.id}`)!;
    expect(row.email).toBeNull();
    expect(row.showOrganization).toBe(false);
    expect(row.permissions).toMatchObject({ store: true, displayPublic: false, collectible: false, showAttribution: false });
    expect(db.snapshot()).not.toContain("kid@example.com");
    expect(db.data(`consents/${row.consentId}`)).toMatchObject({ minorProtectionsApplied: true, guardianConsentAttested: false });
  });

  it.each([
    ["self", "prefer_not"],
    ["self", null],
    ["someone_else", "prefer_not"],
    ["someone_else", null],
  ])("%s with age %j: treated as a possible minor, stored private, no email", async (role, ageRange) => {
    const { deps, db } = startDeps();
    const res = await startSubmission(
      deps,
      validSubmit({ submitterRole: role, ageRange, permissions: ALL_ON, email: "maybe.kid@example.com", organizationName: "Club", showOrganization: true }),
      CTX,
    );
    const row = db.data(`submissions/${res.id}`)!;
    expect(row.permissions).toEqual({ ...ALL_ON, ...Object.fromEntries(CONTRACT_LOCKED.map((k) => [k, false])) });
    expect(row.email).toBeNull();
    expect(row.showOrganization).toBe(false);
    expect(db.snapshot()).not.toContain("maybe.kid@example.com");
    expect(db.data(`consents/${row.consentId}`)).toMatchObject({ minorProtectionsApplied: true, ageRange });
  });

  it("an adult's own choices stand", async () => {
    const { deps, db } = startDeps();
    const res = await startSubmission(deps, validSubmit({ ageRange: "18_plus", permissions: ALL_ON, email: "adult@example.com" }), CTX);
    const row = db.data(`submissions/${res.id}`)!;
    expect(row.permissions).toEqual(ALL_ON);
    expect(row.email).toBe("adult@example.com");
  });

  it("an organization must attest for a known minor, and the attestation is kept with the consent", async () => {
    const { deps, db } = startDeps();
    await expectCode(startSubmission(deps, validSubmit({ submitterRole: "organization", ageRange: "13_17" }), CTX), "failed-precondition");
    expect(db.docs.size).toBe(0);
    const res = await startSubmission(
      deps,
      validSubmit({ submitterRole: "organization", ageRange: "13_17", guardianConsentAttested: true }),
      CTX,
    );
    const row = db.data(`submissions/${res.id}`)!;
    expect(row.permissions).toMatchObject({ displayPublic: true });
    expect(db.data(`consents/${row.consentId}`)).toMatchObject({ guardianConsentAttested: true, submitterRole: "organization" });
  });

  it("an organization with no age: private without the attestation, its choices with it", async () => {
    const { deps, db } = startDeps();
    const quiet = await startSubmission(deps, validSubmit({ submitterRole: "organization", ageRange: "prefer_not", permissions: ALL_ON }), CTX);
    expect(db.data(`submissions/${quiet.id}`)?.permissions).toMatchObject({ displayPublic: false, showAttribution: false });
    const attested = await startSubmission(
      deps,
      validSubmit({ submitterRole: "organization", ageRange: null, permissions: ALL_ON, guardianConsentAttested: true }),
      CTX,
    );
    const row = db.data(`submissions/${attested.id}`)!;
    expect(row.permissions).toEqual(ALL_ON);
    expect(db.data(`consents/${row.consentId}`)).toMatchObject({ guardianConsentAttested: true, minorProtectionsApplied: false });
  });

  it("a guardian's choices stand", async () => {
    const { deps, db } = startDeps();
    const res = await startSubmission(deps, validSubmit({ submitterRole: "guardian", ageRange: "under_13", permissions: ALL_ON }), CTX);
    expect(db.data(`submissions/${res.id}`)?.permissions).toEqual(ALL_ON);
    const unknown = await startSubmission(deps, validSubmit({ submitterRole: "guardian", ageRange: "prefer_not", permissions: ALL_ON }), CTX);
    expect(db.data(`submissions/${unknown.id}`)?.permissions).toEqual(ALL_ON);
  });
});

describe("C5 the form mirrors the server", () => {
  it.each(matrix)("age %j / %s / attested=%s", (age, role, attested) => {
    const want = expected(age, role, attested);
    expect(form.minorLockApplies(age, role, attested)).toBe(want === "locked");
    // The form insists on the confirmation exactly where the server would refuse without it.
    expect(form.needsGuardianAttestation(age, role)).toBe(expected(age, role, false) === "refused");
    // ...and offers it wherever it would unlock sharing.
    expect(form.asksGuardianAttestation(age, role)).toBe(role === "organization" && expected(age, role, false) !== "stand");
  });

  it("locks the same permission list and explains unknown ages in plain words", () => {
    expect([...form.MINOR_LOCKED_KEYS].sort()).toEqual([...MINOR_LOCKED_PERMISSIONS].sort());
    expect(form.lockReason("prefer_not", "self")).toBe(
      "To share this publicly, tell us the artist is 18 or older, or have a parent or guardian send it.",
    );
    expect(form.lockReason(null, "someone_else")).toBe(form.UNKNOWN_AGE_LOCK_REASON);
    expect(form.lockReason("under_13", "self")).toBe(form.MINOR_LOCK_REASON);
    expect(form.lockReason("prefer_not", "organization")).toContain(form.UNKNOWN_AGE_LOCK_REASON);
  });
});
