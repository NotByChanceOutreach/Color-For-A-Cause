/**
 * OBSOLETE — DO NOT RUN. Kept only for history.
 * Written for the removed two-upload flow (it PUTs a browser-made derivative to `derivedUploadUrl`, which
 * submitArtwork no longer returns), and it resets a real staff password on production. It exits before
 * touching anything. See README.md "Deploy" for the current release checks.
 *
 * (Was: production smoke: submit → unapproved privacy → staff approve → Art Wall.)
 */
import { createRequire } from "module";
import { randomBytes } from "crypto";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

console.error("scripts/prod-smoke.mjs is obsolete (removed two-upload flow) and must not be run. See README.md > Deploy.");
process.exit(1);

const require = createRequire(join(dirname(fileURLToPath(import.meta.url)), "../functions/package.json"));
const { applicationDefault, initializeApp } = require("firebase-admin/app");
const { getAuth } = require("firebase-admin/auth");
const { getFirestore } = require("firebase-admin/firestore");
const { getStorage } = require("firebase-admin/storage");

const PROJECT = "notbychance-color-for-a-cause";
const ORIGIN = "https://notbychance-color-for-a-cause.web.app";
const API_KEY = "AIzaSyABL-2A-4M_KRKEgB86yDZfeCxWPXQR8mY";
const STAFF_EMAIL = "nbc@notbychanceoutreach.com";
const JPEG = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "../public/library/thumbs/happy-pup.jpg"),
);

initializeApp({ credential: applicationDefault(), projectId: PROJECT });
const auth = getAuth();
const db = getFirestore();
const bucket = getStorage().bucket("notbychance-color-for-a-cause.firebasestorage.app");

const staffPass = `Nbc-${randomBytes(12).toString("base64url")}!a1`;
await auth.updateUser("jSFe5TX1xSV9Zr15Qq9YPP60Bse2", { password: staffPass });

async function callable(name, data, idToken) {
  const headers = { "Content-Type": "application/json" };
  if (idToken) headers.Authorization = `Bearer ${idToken}`;
  const res = await fetch(`${ORIGIN}/c/${name}`, {
    method: "POST",
    headers,
    body: JSON.stringify({ data }),
  });
  const json = await res.json();
  if (!res.ok || json.error) throw new Error(`${name}: ${JSON.stringify(json.error || json)}`);
  return json.result;
}

const perms = {
  store: true,
  displayPublic: true,
  social: false,
  reproduce: false,
  promotional: false,
  collectible: false,
  sellCollectible: false,
  showAttribution: true,
  showMessage: true,
};

const started = await callable("submitArtwork", {
  pageId: "E01",
  submitterRole: "self",
  attributionKind: "nickname",
  attributionText: "Smoke Tester",
  ageRange: "18_plus",
  organizationName: null,
  showOrganization: false,
  message: "I like eating chalk lol",
  email: null,
  groupId: null,
  permissions: perms,
  originalMime: "image/jpeg",
  originalBytes: JPEG.length,
  originalName: "smoke.jpg",
});

const putOrig = await fetch(started.originalUploadUrl, {
  method: "PUT",
  headers: { "Content-Type": started.originalContentType },
  body: JPEG,
});
const derived = JPEG;
const putDer = await fetch(started.derivedUploadUrl, {
  method: "PUT",
  headers: { "Content-Type": "image/jpeg" },
  body: derived,
});
if (!putOrig.ok || !putDer.ok) {
  throw new Error(`upload failed orig=${putOrig.status} der=${putDer.status}`);
}
await callable("finalizeSubmission", { id: started.id });

const unauthSub = await fetch(
  `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents/submissions/${started.id}`,
);
const unauthGal = await fetch(
  `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents/publicGallery/${started.id}`,
);
const origUrl = `https://firebasestorage.googleapis.com/v0/b/notbychance-color-for-a-cause.firebasestorage.app/o/${encodeURIComponent(`submissions/${started.id}/original/upload`)}?alt=media`;
const origGet = await fetch(origUrl);
const wallHtml = await fetch(`${ORIGIN}/wall/${started.id}`).then((r) => r.text());
const wallList = await fetch(`${ORIGIN}/wall`).then((r) => r.text());

const login = await fetch(
  `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${API_KEY}`,
  {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: STAFF_EMAIL, password: staffPass, returnSecureToken: true }),
  },
).then((r) => r.json());
if (!login.idToken) throw new Error(`staff login failed: ${JSON.stringify(login)}`);

await callable("moderateSubmission", { id: started.id, status: "approved", note: "smoke" }, login.idToken);

const pub = await db.doc(`publicGallery/${started.id}`).get();
const wallAfter = await fetch(`${ORIGIN}/wall/${started.id}`).then((r) => r.text());

const missingStore = await callable("submitArtwork", {
  ...{
    pageId: "E01",
    submitterRole: "self",
    attributionKind: "anonymous",
    attributionText: "",
    ageRange: null,
    organizationName: null,
    showOrganization: false,
    message: "",
    email: null,
    groupId: null,
    originalMime: "image/jpeg",
    originalBytes: 10,
    originalName: "x.jpg",
  },
  permissions: { ...perms, store: false },
}).catch((e) => e.message);

const phone = await db.doc(`submissions/${started.id}`).get();

const out = {
  submissionId: started.id,
  number: started.number,
  unauthSubmissionStatus: unauthSub.status,
  unauthGalleryBefore: unauthGal.status,
  originalPublicStatus: origGet.status,
  wallRouteBeforeHasNotOnWall: wallHtml.includes("not on the wall") || wallHtml.includes("Color For A Cause"),
  wallListMentionsSmokeBefore: wallList.includes("Smoke Tester"),
  publicGalleryAfterApprove: pub.exists,
  publicHasEmail: Boolean(pub.data()?.email),
  publicHasFlags: Array.isArray(pub.data()?.flags) && pub.data().flags.length > 0,
  staffSawFlags: phone.data()?.flags || [],
  missingStoreError: missingStore,
  originalPath: phone.data()?.originalPath,
};
process.stdout.write(JSON.stringify(out, null, 2) + "\n");
const reset = await auth.generatePasswordResetLink(STAFF_EMAIL);
process.stderr.write(`STAFF_RESET_LINK=${reset}\n`);
void bucket;
