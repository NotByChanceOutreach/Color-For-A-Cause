/**
 * One-time staff bootstrap. Run with ADC against the production project.
 * Does not print a standing password; it prints a password-reset link.
 */
import { applicationDefault, initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";

const PROJECT = process.env.GOOGLE_CLOUD_PROJECT || "notbychance-color-for-a-cause";
const EMAIL = process.argv[2] || "nbc@notbychanceoutreach.com";
const ROLE = process.argv[3] || "ADMIN";

initializeApp({ credential: applicationDefault(), projectId: PROJECT });
const auth = getAuth();

const existing = await auth.getUserByEmail(EMAIL).catch(() => null);
const user = existing ?? (await auth.createUser({ email: EMAIL, emailVerified: true, disabled: false }));
await auth.setCustomUserClaims(user.uid, { role: ROLE });
const link = await auth.generatePasswordResetLink(EMAIL);
process.stdout.write(
  JSON.stringify({ email: EMAIL, uid: user.uid, role: ROLE, passwordResetLink: link }, null, 2) + "\n",
);
