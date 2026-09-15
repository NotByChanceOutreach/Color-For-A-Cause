# Color For A Cause

Community art project of [Not By Chance Outreach](https://notbychanceoutreach.com/).

Print a free coloring page. Make it yours. Send it back. A person reviews every piece before anything is public.

No account. No wallet. No email required to print.

GitHub: `https://github.com/NotByChanceOutreach/Color-For-A-Cause`

## Local

```bash
npm install
npm test
npm run dev
```

Open http://127.0.0.1:5173

Local staff sign-in uses `.env.development` (not committed). Copy `.env.example` for the demo keys. That login is never used in production.

## Production

Firebase project: `notbychance-color-for-a-cause` under the Not By Chance Outreach Google organization.

1. Public Firebase web config lives in `.env.production` (not a secret).
2. Staff accounts are Firebase Auth users with custom claim `role=ADMIN|REVIEWER|ART_MANAGER|IMPACT_MANAGER`.
3. Deploy: follow **Deploy** below, in order.
4. **Legal review of consent v0.1 before treating permissions as final.**

Public visitors never write Firestore. Uploads go through Cloud Functions and signed URLs. Unapproved art is not on the Art Wall.

## Deploy

Run from this folder with the Firebase CLI and `gcloud` signed in as someone with Owner (or equivalent) on `notbychance-color-for-a-cause`. Steps 1–4 are setup that normally lasts from one release to the next.

> **This release (the server privacy check) needs steps 1 and 4 done again, before step 6. Do not skip them.**
>
> - **Step 1, CORS: run it again.** `cors.json` changed: it now allows the `x-goog-content-length-range` header, which the new signed upload URL requires and browsers ask about before every upload. With the CORS applied for the previous release, **every public upload fails** (phone, group, guardian, organization and adult), and staff review images do not load, so approve and feature are refused.
> - **Step 4, all of it: Cloud Scheduler API and the cross-service rules grant.** Enable the Cloud Scheduler API (the daily retention job needs it). Grant the Cloud Storage for Firebase service agent `roles/firebaserules.firestoreServiceAgent` (Storage rules read Firestore). Without that grant, **every newly published Art Wall image returns 403**.
> - Then work through **After the deploy** below.

1. **CORS on the upload bucket** (the browser PUTs the original to a signed URL):

   ```bash
   gcloud storage buckets update gs://notbychance-color-for-a-cause.firebasestorage.app --cors-file=cors.json
   ```

2. **Signed URLs.** The functions' runtime service account signs upload URLs through IAM, so it needs `roles/iam.serviceAccountTokenCreator` **on itself**. For 2nd-gen functions that is the Compute Engine default account unless you set another:

   ```bash
   PROJECT_NUMBER=$(gcloud projects describe notbychance-color-for-a-cause --format="value(projectNumber)")
   SA="${PROJECT_NUMBER}-compute@developer.gserviceaccount.com"
   gcloud iam service-accounts add-iam-policy-binding "$SA" \
     --member="serviceAccount:$SA" --role=roles/iam.serviceAccountTokenCreator \
     --project notbychance-color-for-a-cause
   ```

3. **App Check with reCAPTCHA Enterprise.** In the Firebase console, App Check → Apps, register the web app with the reCAPTCHA Enterprise provider. The site key must allow both Hosting domains (`notbychance-color-for-a-cause.web.app` and `.firebaseapp.com`). Put the key in `.env.production` as `VITE_FIREBASE_APPCHECK_SITE_KEY`. Every callable enforces App Check, so the site does not work without this.

4. **Cloud Scheduler API** (runs the daily `purgeAbandonedUploads` job):

   ```bash
   gcloud services enable cloudscheduler.googleapis.com --project notbychance-color-for-a-cause
   ```

   **Cross-service rules.** `storage.rules` serves an Art Wall image only while its `publicGallery` document exists, which means Cloud Storage reads Firestore. Grant the Cloud Storage for Firebase service agent the role it needs for that (`firebase deploy --only storage` also offers to do it):

   ```bash
   PROJECT_NUMBER=$(gcloud projects describe notbychance-color-for-a-cause --format="value(projectNumber)")
   gcloud projects add-iam-policy-binding notbychance-color-for-a-cause \
     --member="serviceAccount:service-${PROJECT_NUMBER}@gcp-sa-firebasestorage.iam.gserviceaccount.com" \
     --role=roles/firebaserules.firestoreServiceAgent
   ```

5. **Check everything locally**, then build:

   ```bash
   npm ci && npm run lint && npm test && npm run test:rules
   npm --prefix functions ci && npm --prefix functions run build
   npm run build
   ```

6. **Deploy all parts together.** The functions, rules, indexes and site depend on each other, so do not deploy one without the others:

   ```bash
   firebase deploy --project notbychance-color-for-a-cause \
     --only functions,firestore:rules,firestore:indexes,storage,hosting
   ```

   The functions read one deploy-time param, `TRUSTED_PROXY_HOPS` (default `1`: Hosting plus Google's front end). Accept the default. After the first real submission, find the `x-forwarded-for shape` log line in Cloud Logging. It shows only the number of entries and the index used, never an address. Change the param (in `functions/.env.notbychance-color-for-a-cause`) only if that line shows the wrong hop.

   New Firestore indexes build in the background. Wait until the `submissions (status ASC, createdAt ASC)` index shows **Enabled** in the console before relying on the retention job.

7. **App Check enforcement: Cloud Firestore only, and only after checking.** Every callable already enforces App Check in its own code, and uploads use signed URLs, so nothing here is needed for the submit flow.
   - **Do not enforce App Check for Cloud Storage.** Art Wall images load through tokenless Firebase Storage URLs in plain `<img>` tags (`storage.rules` decides on every read whether the piece is still on the wall). An `<img>` cannot carry an App Check token, so enforcement would break every image on the wall.
   - **Cloud Firestore:** after the deploy, open App Check → APIs → Cloud Firestore and watch the request metrics on the live site for a day or two. Turn on **Enforce** only when they show that the site's requests are verified (the site sends App Check tokens). Then open `/wall` in a private window and check that the art still loads; if it does not, turn enforcement off again.

### After the deploy

Check each of these on the live site before telling anyone the release is done:

1. **One phone submit, end to end.** On a phone (mobile data, not the office Wi-Fi), send one test picture through `/submit`. It must reach the thank-you page with an art number. If it says the picture didn't make it through, step 1 (CORS) was not re-applied.
2. **One approve.** As staff, open that test piece in the review queue. Its image must load. Approve it with "show on the Art Wall" allowed (use an adult test piece). An image that does not load, or an approve that is refused, also points at step 1.
3. **`/wall` images in a private window.** Open `/wall` in a private (incognito) window, signed out. The test piece's image and the older pieces must all load. A broken image on a newly published piece means the step 4 grant is missing. Then unpublish or reject the test piece and check it leaves the wall.
4. **App Check is enforced on the functions.** Nothing to switch on: every callable checks App Check in its own code. A submit from the live site working (item 1) shows the site sends valid tokens.
5. **App Check is NOT enforced on Cloud Storage.** In App Check → APIs, Cloud Storage must show "Unenforced". Enforcing it breaks every image on the Art Wall.

`scripts/prod-smoke.mjs`, `scripts/submit-unapproved.mjs` and `scripts/unpublish-smoke.mjs` are **obsolete**. They were written for the removed two-upload flow and reset a staff password, so they now exit immediately. Do not use them against production.

### Pieces sent before the server privacy check

Submissions from the old two-upload flow that are still `submitted`, `hold` or `needs_changes` have no server-made image, so staff cannot publish them, and their original upload (which may carry GPS data) is still stored. After deploying, put them through the same processing as new uploads:

```bash
npm --prefix functions run build
gcloud auth application-default login
node scripts/reprocess-legacy.mjs --project notbychance-color-for-a-cause            # dry run: lists what it would do
node scripts/reprocess-legacy.mjs --project notbychance-color-for-a-cause --write    # apply
```

Add `--id sub_…` to handle one submission, and `--bucket <name>` if the bucket is not `<project>.firebasestorage.app`. Run one copy at a time. What it does for each piece:

- The old form let the artist turn and crop the picture but applied that only to the browser-made `derived/public.jpg`. So the **public image is made from that old browser-made image** (with no further turn or crop, so all metadata is dropped) and written to a new path, `derived/public-v2.jpg`; the row's `derivedPath` then points at it. `original/stripped.jpg` is made from the original upload.
- If the old browser-made image is missing or unreadable, the public image is made from the original instead and the row is flagged `legacy-framing-unknown` (shown with the flags in the review queue): look at it before publishing. The old image, if there is one, is kept for you to compare (neither the script nor the retention job deletes it while the row carries `needsStaffLook`).
- Today's minor protections are applied to the row's permissions, organization line and email, decided from the row **and** its own consent record: a permission stays on only where both say yes, and the row is locked if the record says the artist may be a minor or names a different role. The same narrowing is applied to the consent record (never widened; the permissions as first given are kept in `permissionsAsSubmitted`). The stored file name becomes generic.
- **No consent record, no public use.** The row's own record is the one its `consentId` names, if that record names this submission back; otherwise any record whose `submissionId` is this submission. If none is found (missing, deleted, a malformed `consentId`, or one that points at another submission's record), the row is **locked private**: only "store" stays on, every public choice is off, and the email is removed. It is flagged `legacy-consent-missing` and reported as `reprocessed-locked-no-consent`. The dry run shows these as `consent=missing will-lock`. Staff can still review the piece but cannot publish it. Find out what the artist agreed to before changing anything by hand.
- The original upload is deleted (and the old browser-made image, when it was used for the public image), each by its exact generation, only after the new state is committed. If a delete fails the row keeps `legacyLeftovers`; run the script again (or let the daily retention job) finish it.

The dry run prints one line per id with the plan, for example `sub_… would-reprocess public-from=old-derivative protections=locked consent=narrowed original-name=generic`; it never prints names, messages, emails or file names. It opens the old browser-made image the same way `--write` does, so `public-from=old-derivative` means that image will really be used. Stop and look at every line with `will-lock` or `framing=unknown` before running `--write`.

Old pieces that are already approved, featured, rejected or archived are not candidates: they keep their original upload (ADMIN-only). Ask a developer before removing those.

## Docs

See `docs/` for architecture, data model, security, privacy, and the checklist.

## Claims we will not make

Submitting art does not mint an NFT, guarantee funding, promise investment value, or create a tax deduction by itself.
