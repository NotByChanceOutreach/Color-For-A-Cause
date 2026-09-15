#!/usr/bin/env node
/**
 * One-off: put submissions sent before the server privacy check through the same processing as the upload
 * trigger, so staff can review and publish them. The logic lives in functions/src/legacy.ts (unit-tested in
 * tests/functions/legacy.test.ts); this file only wires the Admin SDK to it.
 *
 *   npm --prefix functions run build
 *   node scripts/reprocess-legacy.mjs --project <firebase-project-id>            # dry run: what it would do
 *   node scripts/reprocess-legacy.mjs --project <firebase-project-id> --write    # apply
 *   node scripts/reprocess-legacy.mjs --project <id> --id sub_<32 hex> --write   # one submission
 *
 * Credentials: Application Default Credentials (`gcloud auth application-default login`).
 * --bucket defaults to <project>.firebasestorage.app. Output: one "<id> <outcome> [plan words]" line per id (for
 * example "sub_... would-reprocess public-from=old-derivative protections=locked consent=narrowed
 * original-name=generic") and the totals. Never names, messages or emails. Run one copy at a time.
 */
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const functionsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "functions");
const require = createRequire(join(functionsDir, "package.json"));

if (!existsSync(join(functionsDir, "lib", "legacy.js"))) {
  console.error("functions/lib is missing. Run `npm --prefix functions run build` first.");
  process.exit(1);
}

const { LEGACY_STATUSES, parseLegacyArgs, runLegacyReprocess } = require("./lib/legacy.js");
const { storageAdapters } = require("./lib/gcs.js");
const { processImage } = require("./lib/image.js");

let args;
try {
  args = parseLegacyArgs(process.argv.slice(2));
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(2);
}

const { applicationDefault, initializeApp } = require("firebase-admin/app");
const { FieldPath, FieldValue, getFirestore } = require("firebase-admin/firestore");
const { getStorage } = require("firebase-admin/storage");

initializeApp({
  credential: applicationDefault(),
  projectId: args.project,
  storageBucket: args.bucket ?? `${args.project}.firebasestorage.app`,
});
const firestore = getFirestore();
const storage = storageAdapters(getStorage().bucket());

const db = {
  doc: (path) => firestore.doc(path),
  newDoc: (collection) => firestore.collection(collection).doc(),
  get: (ref) => ref.get(),
  runTransaction: (fn) =>
    firestore.runTransaction((t) =>
      fn({
        get: (ref) => t.get(ref),
        set: (ref, data, options) => (options ? t.set(ref, data, options) : t.set(ref, data)),
        update: (ref, data) => t.update(ref, data),
        create: (ref, data) => t.create(ref, data),
        delete: (ref) => t.delete(ref),
      }),
    ),
};

const ops = {
  increment: (n) => FieldValue.increment(n),
  serverTimestamp: () => FieldValue.serverTimestamp(),
  deleteField: () => FieldValue.delete(),
};

/**
 * Candidate ids, a page at a time: status IN the legacy statuses, then stripped !== true (not reprocessed yet) or
 * legacyLeftovers still recorded (reprocessed, but an old file could not be deleted yet).
 */
async function* candidateIds() {
  if (args.id) {
    yield args.id;
    return;
  }
  let last = null;
  for (;;) {
    let q = firestore
      .collection("submissions")
      .where("status", "in", [...LEGACY_STATUSES])
      .orderBy(FieldPath.documentId())
      .limit(200);
    if (last) q = q.startAfter(last);
    const snap = await q.get();
    for (const d of snap.docs) if (d.get("stripped") !== true || d.get("legacyLeftovers") != null) yield d.id;
    if (snap.size < 200) return;
    last = snap.docs[snap.docs.length - 1].id;
  }
}

console.log(args.write ? "Reprocessing (--write)." : "Dry run: nothing will be changed. Add --write to apply.");
const counts = await runLegacyReprocess(
  {
    db,
    ops,
    now: Date.now,
    runToken: randomUUID(),
    download: storage.download,
    save: storage.saveJpeg,
    generationOf: storage.generationOf,
    remove: storage.removeObject,
    process: processImage,
    // The records that name a submission, for a row whose consentId does not lead to its own record. Ids only.
    consentIdsFor: async (submissionId) => {
      const snap = await firestore.collection("consents").where("submissionId", "==", submissionId).limit(50).get();
      return snap.docs.map((d) => d.id);
    },
  },
  candidateIds(),
  { write: args.write },
  (line) => console.log(line),
);
console.log("Totals:", JSON.stringify(counts));
process.exit(Object.keys(counts).some((k) => k.startsWith("error")) ? 1 : 0);
