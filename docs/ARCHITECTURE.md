# Architecture

## Shape

Vite + React + TypeScript SPA. Public visitors have **no accounts**. Staff use Firebase Auth (email) in production, or a local demo staff session.

```
Browser (public)
  → read coloring pages (static + Firestore)
  → print (CSS + PDF)
  → submit via HTTPS callable / demo API
       → original uploaded privately (one signed PUT)
       → server strips metadata and makes the public-size image
       → moderation flags (heuristic, not auto-reject)
       → staff reviews

Staff dashboard
  → approve / hold / request changes / reject / feature / archive
  → attach impact package when a collectible is created
  → never auto-publish
```

## Two backends, one API

`src/lib/api.ts` is the only UI dependency.

| Mode | When | Persistence |
|---|---|---|
| **Demo** (default) | no Firebase config | IndexedDB + in-memory blobs |
| **Firebase** | `VITE_FIREBASE_API_KEY` set | Firestore + Storage + Functions |

Demo mode exists so a parent can print and a reviewer can approve **tonight** without cloud credentials. The schema matches production.

## Why public users never write Firestore

Unsigned client writes are an abuse magnet. Every callable enforces App Check; `submitArtwork` and `createGroup` also consume their limited-use token, refuse a token that was already used, and are rate-limited per IP. Production submissions:

1. `submitArtwork` allowlist-validates every field, applies the minor protections, mints a random id and an `NBC-ART-######` number, and returns **one** signed PUT URL for `submissions/{id}/original/upload` (5 minutes, 1 B to 15 MB, image types only) plus a finalize token (only its SHA-256 is stored).
2. The browser uploads the original. It never uploads a public image.
3. The Storage trigger `onOriginalUploaded` (with `retry: true`) takes a lease carrying a token unique to the run, checks size, type and magic bytes, then sharp auto-rotates, strips all metadata (EXIF/GPS/XMP/ICC) and caps the size. It writes `original/stripped.jpg` and `derived/public.jpg` create-only, records `derivedGeneration`, `derivedMd5`, `strippedGeneration`, `stripped=true` in a transaction that requires its token, and only then deletes the unstripped upload. A lease held by another run throws so the event is redelivered. Any other failure releases the lease and rethrows, so Eventarc redelivers; a known temporary one (a Storage 5xx or 429, a network error, Firestore UNAVAILABLE / DEADLINE_EXCEEDED / ABORTED / RESOURCE_EXHAUSTED; `functions/src/transient.ts`) is refunded and never counts, so no outage, however long, can refuse a good picture. The upload is refused as `processing_failed` only when it is older than 20 hours (inside Eventarc's 24-hour retry window) AND at least 5 attempts ended in an unknown failure, a crash or a timeout. Only a known decode failure (an explicit allowlist in `functions/src/transient.ts`) refuses a picture as unreadable; sharp running out of memory, threads or `/tmp` space, and any image error nobody recognises, are retried and counted, so only the 20-hour cap can end them. A refused file marks the row before the upload is deleted; a redelivered event after the commit finds the row already processed and deletes the upload. Safety does not rest on the clock: a run that outlives its lease (10 min, longer than the 120 s timeout) can no longer commit, overwrite or delete anything another run made (see the header of `functions/src/uploadTrigger.ts`).
4. `finalizeSubmission` moves the piece to `submitted` once the server image exists. If the trigger is still working it records `finalizeRequested`, and the trigger's own transaction submits the piece when it finishes. Exactly one transaction flips the row, so counters move once.
5. Staff act only through callables. `moderateSubmission` publishes in three steps: a transaction takes a publish claim; the claim holder copies the exact generation the reviewer saw of the derivative the row records in `derivedPath` (`derived/public.jpg`, or `derived/public-v2.jpg` for a reprocessed legacy piece) to `gallery/{id}/public.jpg` (create-only, `Cache-Control: public, max-age=300`, no download token); a second transaction commits the status, the public document (whose `imageUrl` is the tokenless URL) and the committed gallery generation. `storage.rules` serves the gallery image only while its `publicGallery` document exists, and checks that on every read of the tokenless URL. A concurrent publisher that loses the claim never touches Storage. The claim (5 min) is longer than the callable timeout (60 s). Unpublishing goes the other way round: a transaction moves the status and removes the public document first, then the recorded gallery generation's download tokens are revoked (a reader may have minted one with `getDownloadURL`) and exactly that generation is deleted. A publish claim past its expiry counts as released: a new publish takes it over, and every other decision removes it in its own transaction, after which the stalled publisher can never commit.
6. `purgeAbandonedUploads` runs daily. Oldest first, it re-reads each upload that never finished (older than 24 h) in a transaction and deletes it with its consent record only if it is still abandoned, then its files, logging and skipping any row that fails. It also sweeps consent records and files under `submissions/{id}/` that are older than 24 h and whose submission no longer exists (plus leftover uploads of processed pieces and the old browser-made image of a reprocessed legacy piece, unless its row carries `needsStaffLook`), and Art Wall files older than an hour whose `publicGallery` document is gone and whose row carries no live publish claim (an expired claim is removed first), their download tokens revoked and then deleted by the generation the listing returned, a bounded page at a time with cursors saved in `system/retention`, within a time budget.

Counters are updated with `FieldValue.increment` on real transitions; nothing scans a collection.

## Print

- On-screen print route uses `@media print` (no chrome, letter, margins).
- PDFs are the 300 DPI US Letter files from the coloring-book library.
- Activity packs are merged with pdf-lib; an instruction+QR cover is generated in code (exact text).

## Frontend composition

Routes in `src/App.tsx`. Layout is illustrated but semantic (`header`, `main`, `nav`, `footer`). Motion is CSS-only and silenced by `prefers-reduced-motion`.
