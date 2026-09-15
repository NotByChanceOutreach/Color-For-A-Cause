import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const firestore = readFileSync("firestore.rules", "utf8");
const storage = readFileSync("storage.rules", "utf8");

describe("security rules source", () => {
  it("denies public writes to submissions", () => {
    expect(firestore).toMatch(/match \/submissions\/\{id\}/);
    expect(firestore).toMatch(/allow read, write: if isReviewer/);
  });
  it("lets anyone read the public gallery collection", () => {
    expect(firestore).toMatch(/match \/publicGallery\/\{id\}/);
    expect(firestore).toMatch(/allow read: if true/);
  });
  it("does not allow unauthenticated original uploads via rules", () => {
    expect(storage).toMatch(/match \/submissions\/\{submissionId\}\/original/);
    expect(storage).toMatch(/allow write: if false/);
  });
  it("does not make original or derived paths publicly readable", () => {
    expect(storage).not.toMatch(/match \/submissions\/\{submissionId\}\/original[\s\S]{0,120}allow read: if true/);
    expect(storage).toMatch(/match \/submissions\/\{submissionId\}\/derived/);
  });
  it("only publishes gallery objects as a separate public prefix", () => {
    expect(storage).toMatch(/match \/gallery\/\{submissionId\}/);
  });
  it("makes audit logs append-only", () => {
    expect(firestore).toMatch(/allow update, delete: if false/);
  });
});
