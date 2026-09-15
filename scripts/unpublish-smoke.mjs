/**
 * OBSOLETE — DO NOT RUN. Kept only for history.
 * Part of the smoke set for the removed two-upload flow; it resets a real staff password on production and
 * prints a password-reset link. It exits before touching anything. See README.md "Deploy".
 */
import { createRequire } from "module";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { randomBytes } from "crypto";

console.error("scripts/unpublish-smoke.mjs is obsolete and must not be run. See README.md > Deploy.");
process.exit(1);

const require = createRequire(join(dirname(fileURLToPath(import.meta.url)), "../functions/package.json"));
const { applicationDefault, initializeApp } = require("firebase-admin/app");
const { getAuth } = require("firebase-admin/auth");
const { getFirestore } = require("firebase-admin/firestore");

const PROJECT = "notbychance-color-for-a-cause";
const ORIGIN = "https://notbychance-color-for-a-cause.web.app";
const API_KEY = "AIzaSyABL-2A-4M_KRKEgB86yDZfeCxWPXQR8mY";
const ID = process.argv[2] || "sub_9b95b66e6b57620b493a87f2c3ef305d";

initializeApp({ credential: applicationDefault(), projectId: PROJECT });
const auth = getAuth();
const db = getFirestore();
const pass = `Nbc-${randomBytes(12).toString("base64url")}!a1`;
await auth.updateUser("jSFe5TX1xSV9Zr15Qq9YPP60Bse2", { password: pass });
const login = await fetch(
  `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${API_KEY}`,
  {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "nbc@notbychanceoutreach.com", password: pass, returnSecureToken: true }),
  },
).then((r) => r.json());
const res = await fetch(`${ORIGIN}/c/moderateSubmission`, {
  method: "POST",
  headers: { "Content-Type": "application/json", Authorization: `Bearer ${login.idToken}` },
  body: JSON.stringify({ data: { id: ID, status: "archived", note: "unpublish smoke" } }),
});
const gal = await db.doc(`publicGallery/${ID}`).get();
process.stdout.write(JSON.stringify({ http: res.status, body: await res.text(), galleryExists: gal.exists }, null, 2) + "\n");
const link = await auth.generatePasswordResetLink("nbc@notbychanceoutreach.com");
process.stderr.write(`RESET=${link}\n`);
