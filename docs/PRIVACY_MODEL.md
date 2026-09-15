# Privacy model

Data minimization is the default. Printing requires **nothing**.

## We collect (only if they submit art)

- The photo they chose
- Optional first name / nickname / “Anonymous”
- Optional coarse age range (never an exact age for minors on the public wall)
- Optional organization name
- Optional message
- Optional email (confirmation only)
- Who is submitting (me / guardian / organization / someone else)
- Consent permissions + version + time

## We do not collect

Home address, precise location, diagnosis, disability, treatment/recovery status, classroom, wallet address, or government ID.

Organization type is a free-text label. We **never infer** that an artist is in recovery, disabled, or a student because an organization submitted their work.

## Public attribution

Only the chosen display name (or Anonymous Artist), optional authorized org line, and the message **if that permission was granted**.

## Minors

Guardian must be the submitter. Public display and collectible permissions stay off until a guardian explicitly grants them. Exact ages are not shown publicly.

**Protective default: an unknown age is treated as a possible minor.** A piece can be shared publicly only when one of these is true:

- the age range is **18+**;
- a **parent or guardian** is the sender (`submitterRole: guardian`);
- an **organization** is the sender and confirms that a parent or guardian agreed (`guardianConsentAttested: true`, kept with the consent record).

Otherwise, when the sender is the artist (`self`) or someone else (`someone_else`) and the age range is missing, "Prefer not to say", "Under 13" or "13–17", the server stores every public or sharing permission as off (`displayPublic`, `social`, `reproduce`, `promotional`, `collectible`, `sellCollectible`, `showAttribution`, `showMessage`), hides the organization line (`showOrganization: false`) and keeps no email. The consent record notes `minorProtectionsApplied: true`. The art is still received and kept private.

An organization sending art by someone known to be under 18 without that confirmation is refused. When the organization gives no age and no confirmation, the piece is kept private as above.

The server enforces all of this (`functions/src/minors.ts`). The forms only mirror it: while the lock applies they hide the public-naming question and the email field, switch the sharing permissions off, and explain in plain words: "To share this publicly, tell us the artist is 18 or older, or have a parent or guardian send it."

## Photo metadata

The server removes EXIF (including GPS location), XMP, IPTC and colour-profile data from every photo before a person reviews it. The file exactly as uploaded is deleted once processed.

Pieces sent before this server check existed still have their original upload (ADMIN-only) and cannot be published. For those still waiting for a reviewer (`submitted`, `hold`, `needs_changes`), `scripts/reprocess-legacy.mjs` makes the stripped copy from the original, makes the public image from the old browser-made image (which holds the artist's own turn and crop; all metadata is dropped again), applies today's minor protections to their permissions, organization line and email and narrows the consent record the same way (never widening it), replaces the stored file name with a generic one, and only then deletes the old upload and the old browser-made image (see README.md). A piece whose old browser-made image is missing is flagged for a person, because its framing is unknown. The protections are decided from the row and its own consent record together (the record can lock the row, never widen it), and a piece with no consent record of its own is locked private (only storage allowed) and flagged `legacy-consent-missing`: no consent record, no public use.

Not covered, known: old pieces that are already approved, featured, rejected or archived keep their original upload (ADMIN-only), and so do old pieces the script had to leave for a person (too large, not an image, unreadable). Their consent records keep the browser's user-agent string, as new ones do.

## Retention

Originals (with metadata removed) are kept for review, safety, and (if permitted) collection use. Archiving a public item does **not** destroy the original. Deletion requests are a staff procedure (documented, not a silent automatic purge of evidence of consent).

Uploads that never finished, or that the server refused, never reached a person. They are deleted together with their consent record and files after 24 hours (each one is re-checked at that moment, so a piece that arrived late is kept). The same daily job removes consent records and stored files that are older than 24 hours and whose submission no longer exists, and any unprocessed upload a processed piece left behind.

An Art Wall picture is readable only while the piece is on the wall. If its file could not be removed when the piece came off the wall, the storage rules stop serving it at once, and the daily job deletes it (after an hour, so a publish in progress is never touched).

## Legal

Consent copy is **draft, for legal review before launch**. This software does not give legal advice.
