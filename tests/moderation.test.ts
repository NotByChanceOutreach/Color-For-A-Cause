import { describe, expect, it } from "vitest";
import { flagSubmission, isHarmlessWeirdness } from "../src/lib/moderation";
import { formatArtNumber } from "../src/lib/ids";
import { looksAllowed } from "../src/lib/files";
import { PAGES, matchesFilter } from "../src/data/pages";
import { emptyPermissions } from "../src/data/consent";
import { isPublicOnWall } from "../src/types";

describe("moderation", () => {
  it("flags email, phone, url, handle, address-like text", () => {
    expect(flagSubmission("reach me at kid@example.com")).toContain("possible_email");
    expect(flagSubmission("call 555-123-4567")).toContain("possible_phone");
    expect(flagSubmission("see https://example.com")).toContain("possible_url");
    expect(flagSubmission("follow @coolartist")).toContain("possible_social_handle");
    expect(flagSubmission("I live at 12 Oak Street")).toContain("possible_address");
  });

  it("does not reject chalk humor", () => {
    expect(flagSubmission("I like eating chalk lol")).toEqual([]);
    expect(isHarmlessWeirdness("I like eating chalk lol")).toBe(true);
  });

  it("flags harmful language without auto-deciding", () => {
    expect(flagSubmission("nazi")).toContain("possible_harmful_language");
  });
});

describe("library", () => {
  it("has 24 unique slugs and three complexities", () => {
    expect(PAGES).toHaveLength(24);
    expect(new Set(PAGES.map((p) => p.slug)).size).toBe(24);
    expect(PAGES.filter((p) => p.complexity === "easy")).toHaveLength(8);
  });

  it("filters by complexity and tags", () => {
    expect(PAGES.filter((p) => matchesFilter(p, "lantern")).length).toBeGreaterThan(0);
    expect(PAGES.filter((p) => matchesFilter(p, "easy")).every((p) => p.complexity === "easy")).toBe(true);
  });
});

describe("files", () => {
  it("rejects oversize and scripts", () => {
    const big = { name: "a.jpg", type: "image/jpeg", size: 16 * 1024 * 1024 } as File;
    expect(looksAllowed(big)).toMatch(/too large/i);
    const js = new File(["alert(1)"], "x.js", { type: "text/javascript" });
    expect(looksAllowed(js)).toBeTruthy();
  });

  it("accepts jpeg names", () => {
    const f = new File([new Uint8Array([0xff, 0xd8])], "pic.jpg", { type: "image/jpeg" });
    expect(looksAllowed(f)).toBeNull();
  });
});

describe("numbers and consent defaults", () => {
  it("formats NBC-ART numbers", () => {
    expect(formatArtNumber(123)).toBe("NBC-ART-000123");
  });
  it("starts with no pre-checked permissions", () => {
    const p = emptyPermissions();
    expect(Object.values(p).every((v) => v === false)).toBe(true);
  });

  it("keeps approved art off the wall without display consent", () => {
    expect(isPublicOnWall({ status: "approved", permissions: { displayPublic: false } })).toBe(false);
    expect(isPublicOnWall({ status: "submitted", permissions: { displayPublic: true } })).toBe(false);
    expect(isPublicOnWall({ status: "approved", permissions: { displayPublic: true } })).toBe(true);
  });
});
