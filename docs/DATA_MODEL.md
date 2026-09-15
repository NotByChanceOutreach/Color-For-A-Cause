# Data model

IDs for submissions, groups, and assets are **opaque random** (not sequential guessable paths). Display numbers (`NBC-ART-000123`) are a separate monotonic counter.

## coloringPages

`id`, `title`, `slug`, `complexity` (`easy|standard|detailed`), `tags[]`, `characters[]`, `orientation`, `active`, `featured`, `displayOrder`, `createdAt`, asset paths (`thumb`, `preview`, `png`, `pdf`).

## submissions

`id`, `number`, `pageId | null` (`unknown` if they picked “I don’t remember”), `status` (see below), `submitterRole`, `attributionKind` (`firstName|nickname|anonymous`), `attributionText`, `ageRange | null`, `organizationName | null`, `showOrganization`, `message`, `email | null`, `groupId | null`, `flags[]`, `consentId`, `createdAt`, `reviewedAt`, `reviewedBy`.

Statuses: `submitted | needs_changes | hold | approved | featured | scheduled | collectible_created | available | collected | impact_funded | impact_fulfilled | archived | rejected`

Server-only statuses before a person sees the piece: `uploading` (waiting for the file) and `rejected_upload` (the server refused the file; `rejectReason` says why). Both are deleted after 24 h.

Server upload fields: `originalPath`, `derivedPath`, `originalName` (always generic, e.g. `artwork.jpg`), `stripped`, `derivedGeneration`, `derivedMd5`, `strippedGeneration`, `rotate`, `cropPct`, `finalizeTokenHash`, `finalizeRequested`, `minorProtectionsApplied`, `publicArtistKey` (while public), `processingLease` (while the upload trigger or the legacy reprocess script works: `{generation, owner, until}`, where `owner` is the run's fencing token), `processingAttempts` (attempts that ended in an unknown failure, a crash or a timeout; known temporary failures are refunded; the upload is refused only when this is at least 5 AND the upload is older than 20 h; removed once processed), `processingSince` (when the first attempt started; removed once processed), `needsStaffLook` (`legacy-consent-missing`: a reprocessed legacy piece with no consent record of its own, locked private; or `legacy-framing-unknown`: a reprocessed legacy piece whose public image was made from the original, so the artist's turn and crop are unknown; each also in `flags`; while it is set, retention keeps the old `derived/public.jpg`), `legacyLeftovers` (`{derived, upload}`: generations a legacy reprocess still has to delete; `derived` only when the old image was used; removed once they are gone), `publishClaim` (while a publish is in flight), `galleryGeneration` (the committed `gallery/{id}/public.jpg` generation, while public), `galleryOrphan` (a gallery generation whose removal after unpublishing failed; the next moderation or publish removes it).

Public Art Wall only reads `approved` and later public states. Internal flags never go public.

## Storage layout

- `submissions/{id}/original/upload`: the browser's upload; deleted by the server once processed
- `submissions/{id}/original/stripped.jpg`: the original with every metadata block removed (private)
- `submissions/{id}/derived/public.jpg`: server-made public-size image (staff review this)
- `submissions/{id}/derived/public-v2.jpg`: the server-made public-size image of a piece sent before the server privacy check, made by `scripts/reprocess-legacy.mjs` from the old browser-made image. The row's `derivedPath` says which of the two a piece uses; review and publishing follow it
- `gallery/{id}/public.jpg`: a copy of the reviewed generation, only while public (`Cache-Control: public, max-age=300`, no download token: read through the tokenless URL in `publicGallery/{id}.imageUrl`, which `storage.rules` allows only while that document exists); everything under `submissions/` is `private, max-age=0`

## consents

`id`, `submissionId`, `documentVersion`, `submitterRole`, `ageRange`, `permissions{}` (as stored, after minor protections), `minorProtectionsApplied`, `guardianConsentAttested`, `timestamp`, `userAgent`.

Records of pieces reprocessed by `scripts/reprocess-legacy.mjs` may also carry `permissionsAsSubmitted` (the permissions as first given, kept once), `protectionsAppliedAt` and `protectionsAppliedBy: legacy-reprocess`; their `permissions` were narrowed to today's minor protections, never widened, and an `email` was removed where the protected row keeps none. A legacy row whose `consentId` does not lead to a record naming it is matched by `submissionId`; with no record at all it is locked private and flagged `legacy-consent-missing`.

## Server-only collections

- `rateLimits`: hashed (action, hour, IP) or (action, hour, group code + IP) keys with `count` and a TTL `expiresAt`
- `system/retention`: the retention job's cursors for its orphan sweeps
- `artistKeys`: hashed public bylines with a reference count, for the "artists participating" counter
- `counters/art`: the `NBC-ART` sequence; `counters/public`: public totals, changed only by increments

## consentDocuments

Admin-editable versioned HTML/markdown. `status: draft|published|retired`. Current public form uses the published version. **v0.1 is a draft for legal review.**

## groups / groupActivities

Public random `publicId` for QR (`/submit?group=`). No personal data in the QR. The `createGroup`/`getGroup` callables return only `publicId`, `label` and `createdAt`; the internal `grp_` document id never leaves the server. Labels are cleaned like every public text when created and cleaned again when read (labels stored before these rules were raw); with nothing readable left the label is "Art day".

## collectibles

Ready for chain fields (`chain`, `contract`, `tokenId`, `txHash`, `metadataUri`, `marketplaceUrl`) — all nullable. No minting in this release.

## impactRecords

`collectibleId`, `package` (`A|B`), `status` (`not_yet_funded|funded|purchased|distributed`), `tents`, `sleepingBags`, `verified`, `notes` (staff only).

Public counters sum **verified** records only.

## auditLogs

Append-only. Actor, action, target, timestamp, payload summary. No deletes.

## siteSettings

Public copy, featured ids, published consent version. Counters are derived, not typed by hand.
