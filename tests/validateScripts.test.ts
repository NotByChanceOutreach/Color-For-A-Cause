import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * The local browser walk-throughs (scripts/human-validate.mjs, scripts/followup-validate.mjs) must choose 18+ before
 * they expect the naming field: with an unknown age the form treats the artist as a possible minor and hides it.
 */
describe("local validation scripts follow the minor lock", () => {
  it.each(["scripts/human-validate.mjs", "scripts/followup-validate.mjs"])("%s chooses 18+ before waiting for the name field", (file) => {
    const src = readFileSync(file, "utf8");
    const waits = [...src.matchAll(/waitForSelector\("#attr"\)/g)];
    expect(waits.length).toBeGreaterThan(0);
    for (const m of waits) {
      expect(src.slice(Math.max(0, (m.index ?? 0) - 300), m.index)).toMatch(/page\.select\("#age", "18_plus"\)/);
    }
  });

  it("the group walk-through chooses 18+ for the row before typing the artist's name", () => {
    const src = readFileSync("scripts/followup-validate.mjs", "utf8");
    expect(src).toMatch(/page\.select\("#age-0", "18_plus"\);\s*await page\.waitForSelector\("#name-0"\);\s*await page\.type\("#name-0"/);
  });
});
