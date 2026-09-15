# Security model

## Threats (upload-centric)

| Threat | Control |
|---|---|
| Public Firestore writes | Denied in rules; Functions only |
| Bucket listing | `list` denied; randomized ids |
| MIME spoofing | Signed Content-Type; Storage trigger checks magic bytes and decodes with sharp. The server accepts jpeg/png/webp/heic/heif and refuses what it cannot decode; the form refuses HEIC/HEIF up front (by type and by extension) and asks for a JPG or PNG, because most iPhone HEIC files cannot be decoded |
| Oversize | Signed `x-goog-content-length-range: 1,15728640`; trigger re-checks; 100 MP decode cap |
| Location/EXIF leak | Server strips all metadata; the public image is server-made, never client-made |
| Picture swapped after review | Publishing copies only the object generation the reviewer saw |
| Two reviewers publish or unpublish at once | A publish claim is taken in a transaction first; only the claim holder copies (create-only), and a leftover at the gallery path is deleted only by its generation after the claim is re-checked. The committed gallery generation is stored on the submission (`galleryGeneration`). Unpublishing is database first: a transaction re-checks the status, refuses while a live publish claim is held, moves the status and deletes the public doc; only then is exactly the stored generation deleted. A failed removal is recorded (`galleryOrphan`) and retried by the next moderation or publish, so the wall never shows a doc whose image is gone. A claim past its expiry counts as released: a new publish takes it over, and hold, reject, archive, unpublish and curate remove it in their own transaction; the stalled publisher's commit needs its own claim id, so it can never commit afterwards |
| Art Wall file left behind after unpublishing | Gallery objects carry no download token (a token URL bypasses the rules and outlives the piece's time on the wall). The wall reads them through the tokenless URL, and `storage.rules` serves `gallery/{id}/public.jpg` only while `publicGallery/{id}` exists (cross-service `firestore.exists`), so a leftover is unreadable at once. A token a reader minted with `getDownloadURL` while the piece was on the wall is revoked on unpublish before the file is deleted. The daily retention job also revokes and deletes leftovers: older than 1 h, doc gone, no live publish claim on the row (an expired one is removed first), not the recorded generation, by the generation the listing returned (read before the database, row before doc). Shared caches keep a copy for at most 5 minutes (`public, max-age=300`). Pieces published before this change keep the token URL their public document already holds until they are next unpublished |
| Lost, duplicated or slow upload events | Storage trigger runs with `retry: true`. Each run carries a unique lease token; every commit, refusal and lease release is a transaction that requires that token, sharp's output is written create-only, and deletes name a generation, so a run that outlives its lease (it timed out but kept running) cannot overwrite or delete another run's work. A busy lease throws so the event is redelivered; any other failure releases the lease and rethrows. Known temporary failures (Storage 5xx/429, network errors, Firestore UNAVAILABLE / DEADLINE_EXCEEDED / ABORTED / RESOURCE_EXHAUSTED) refund the attempt, so an outage of any length cannot refuse a good picture; the upload is refused (`processing_failed`) only once it is older than 20 h (inside Eventarc's 24 h retry window) AND at least 5 attempts ended in an unknown failure, a crash or a timeout. only a known decode failure (an explicit allowlist) is a refusal; running out of memory, threads or `/tmp` space, or any unrecognised image error, is retried and counted, so only the 20 h cap can end it; a commit whose answer was lost is recognised as success; a refused file marks the row before the upload is deleted; the unstripped upload is deleted only after the result is committed |
| Abandoned uploads | Daily purge, oldest first, of `uploading`/`rejected_upload` older than 24 h. Each row is re-read and deleted (with its consent) in a transaction only if it is still abandoned, so a row finalized late is left alone; its files go only after that commit. One bad row is logged and skipped; a time budget leaves room for the sweeps and the audit record. Orphan consents and files (submission gone, older than 24 h) and leftover uploads of processed pieces are swept too |
| Replay/automation | App Check enforced on every callable (the primary control). `submitArtwork`/`createGroup` consume their limited-use token, and the handler itself refuses a token that was already used (`request.app.alreadyConsumed`; firebase-functions only reports it), before doing any work. Per-connection backstop limits per hour: 120 submissions per IP, 300 per (existing group code, IP), 10 new groups per IP; activity packs reuse one group code per browser session. The IP is read from `X-Forwarded-For` using the `TRUSTED_PROXY_HOPS` param (default 1); a sampled log line records only the entry count and the index used. Residual, accepted (see "Replay: what rests on Google" below) |
| Invisible or fake text | Every Unicode default-ignorable and format (Cf) character is stripped by property, not by a hand list, except where it is real text: ZWJ in emoji sequences, ZWJ/ZWNJ between letters of scripts that use them (Persian, Indic, Sinhala; never Latin, Greek, Cyrillic, CJK or Hangul, where they only hide text), emoji and keycap selectors, ideographic and Mongolian variation selectors after their letters, and the three RGI subdivision flags. Blank-by-design characters (every So/Lo whose Unicode name says BLANK or FILLER, plus U+303F, U+FFFC and the empty noteheads) count as spaces; U+FFFD is removed. Cleaning repeats until nothing changes, so a joiner is judged against the characters actually kept and never left trailing. Text is NFC after cleaning; lone surrogates are refused; a name needs a letter, digit, symbol or #/* keycap. Stored text (and legacy group labels, page ids and name kinds) is cleaned or checked again before the public sees it, artist keys compare the cleaned, case-folded name, and the moderation flags look through invisible characters. The forms run the very same file (`src/lib/textCore.ts` is a byte copy of `functions/src/textCore.ts`) |
| Injected scripts | Content-Security-Policy header on Hosting (no inline or eval scripts) |
| XSS in messages | Stored as text; rendered as text nodes, never `innerHTML` |
| HTML/script upload | Extension + magic bytes; no SVG/HTML accept |
| Path traversal | Server builds storage paths |
| ID enumeration | UUIDs; sequential numbers are not storage keys |
| Spam/bots | App Check + rate limit on Functions; demo mode local-only |
| Privilege escalation | Custom claims `role`; rules check claims; UI hides by role |
| CSRF | Firebase callable + App Check; demo is same-origin |
| Staff session theft | Firebase Auth; demo password never shipped to production |

## Replay: what rests on Google

The replay control is bounded, not absolute. Three parts of it are Google's, and we accept them:

- **Consumption atomicity.** The handler refuses anything but a first use as reported by App Check (`request.app.alreadyConsumed === false`). If two calls with the same token arrive at once, only Google's consume endpoint decides which one is first; we cannot make it atomic ourselves, and could only test it against a stub.
- **Token-string canonicalization.** firebase-admin verifies the token locally with `jsonwebtoken`, which accepts up to 16 spellings of the same RS256 signature (the spare bits of the last base64url character), and then sends that exact string to Google to consume. If Google recorded "used" against the raw string rather than the token's identity, one attestation could buy up to 16 protected calls. That is bounded, and it is Google's to get right.
- **The cost floor.** Every `submitArtwork` and `createGroup` call costs one fresh reCAPTCHA Enterprise attestation. A headless bot that passes the score threshold can still mint tokens, so its throughput is bounded by attestation cost and quota plus the per-IP backstop limits, not eliminated. (Forging `X-Forwarded-For` on the direct function URL gets a fresh per-IP bucket, but not a free token.)

## Roles (least privilege)

- **ADMIN** — everything
- **REVIEWER** — submissions moderate, not settings/pages
- **ART_MANAGER** — coloring pages, featured wall (can only move approved art between approved and featured)
- **IMPACT_MANAGER** — collectibles impact fields, verified counters

## Content moderation

Heuristics **flag** (phone, email, address-like, URLs, hate/sexual/threat lexicons). They never auto-reject. Humor such as “I like eating chalk” is not a flag by itself. Humans publish.

## Secrets

No service-account keys in the client. `VITE_*` is public config only.
