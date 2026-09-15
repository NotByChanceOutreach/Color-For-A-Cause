/**
 * OBSOLETE — DO NOT RUN. Kept only for history.
 * Written for the removed two-upload flow (it PUTs a browser-made derivative to `derivedUploadUrl`, which
 * submitArtwork no longer returns) and writes to production. It exits before touching anything.
 * See README.md "Deploy" for the current release checks.
 */
import { createRequire } from "module";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

console.error("scripts/submit-unapproved.mjs is obsolete (removed two-upload flow) and must not be run. See README.md > Deploy.");
process.exit(1);

const require = createRequire(join(dirname(fileURLToPath(import.meta.url)), "../functions/package.json"));
const { applicationDefault, initializeApp } = require("firebase-admin/app");
const { getFirestore } = require("firebase-admin/firestore");

const PROJECT = "notbychance-color-for-a-cause";
const ORIGIN = "https://notbychance-color-for-a-cause.web.app";
const JPEG = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../public/library/thumbs/happy-pup.jpg"));

initializeApp({ credential: applicationDefault(), projectId: PROJECT });
const db = getFirestore();

async function callable(name, data) {
  const res = await fetch(`${ORIGIN}/c/${name}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ data }),
  });
  const json = await res.json();
  if (!res.ok || json.error) throw new Error(`${name}: ${JSON.stringify(json.error || json)}`);
  return json.result;
}

async function send(message, extra = {}) {
  const started = await callable("submitArtwork", {
    pageId: "E01",
    submitterRole: "self",
    attributionKind: "anonymous",
    attributionText: "",
    ageRange: "prefer_not",
    organizationName: null,
    showOrganization: false,
    message,
    email: extra.email ?? null,
    groupId: null,
    permissions: {
      store: true,
      displayPublic: false,
      social: false,
      reproduce: false,
      promotional: false,
      collectible: false,
      sellCollectible: false,
      showAttribution: false,
      showMessage: true,
    },
    originalMime: "image/jpeg",
    originalBytes: JPEG.length,
    originalName: "unapproved.jpg",
  });
  await fetch(started.originalUploadUrl, { method: "PUT", headers: { "Content-Type": "image/jpeg" }, body: JPEG });
  await fetch(started.derivedUploadUrl, { method: "PUT", headers: { "Content-Type": "image/jpeg" }, body: JPEG });
  await callable("finalizeSubmission", { id: started.id });
  const row = await db.doc(`submissions/${started.id}`).get();
  const gal = await fetch(
    `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents/publicGallery/${started.id}`,
  );
  const orig = await fetch(
    `https://firebasestorage.googleapis.com/v0/b/notbychance-color-for-a-cause.firebasestorage.app/o/${encodeURIComponent(`submissions/${started.id}/original/upload`)}?alt=media`,
  );
  return {
    id: started.id,
    number: started.number,
    flags: row.data()?.flags ?? [],
    message: row.data()?.message,
    gallery: gal.status,
    original: orig.status,
  };
}

const rows = {
  chalk: await send("I like eating chalk lol"),
  phone: await send("call me at 555-123-4567"),
  email: await send("reach me at kid@example.com"),
  address: await send("I live at 12 Oak Street"),
  html: await send("<script>alert(1)</script><b>hi</b>"),
};
process.stdout.write(JSON.stringify(rows, null, 2) + "\n");
