# Data model

IDs for submissions, groups, and assets are **opaque random** (not sequential guessable paths). Display numbers (`NBC-ART-000123`) are a separate monotonic counter.

## coloringPages

`id`, `title`, `slug`, `complexity` (`easy|standard|detailed`), `tags[]`, `characters[]`, `orientation`, `active`, `featured`, `displayOrder`, `createdAt`, asset paths (`thumb`, `preview`, `png`, `pdf`).

## submissions

`id`, `number`, `pageId | null` (`unknown` if they picked “I don’t remember”), `status` (see below), `submitterRole`, `attributionKind` (`firstName|nickname|anonymous`), `attributionText`, `ageRange | null`, `organizationName | null`, `showOrganization`, `message`, `email | null`, `groupId | null`, `flags[]`, `consentId`, `createdAt`, `reviewedAt`, `reviewedBy`.

Statuses: `submitted | needs_changes | hold | approved | featured | scheduled | collectible_created | available | collected | impact_funded | impact_fulfilled | archived | rejected`

Public Art Wall only reads `approved` and later public states. Internal flags never go public.

## submissionAssets

`originalPath` (private), `derivedPreviewPath`, `thumbnailPath`, `mime`, `bytes`, `width`, `height`. Original is never overwritten.

## consents

`id`, `submissionId`, `documentVersion`, `submitterRole`, `permissions{}`, `timestamp`, `userAgent`.

## consentDocuments

Admin-editable versioned HTML/markdown. `status: draft|published|retired`. Current public form uses the published version. **v0.1 is a draft for legal review.**

## groups / groupActivities

Public random `publicId` for QR (`/submit?group=`). No personal data in the QR.

## collectibles

Ready for chain fields (`chain`, `contract`, `tokenId`, `txHash`, `metadataUri`, `marketplaceUrl`) — all nullable. No minting in this release.

## impactRecords

`collectibleId`, `package` (`A|B`), `status` (`not_yet_funded|funded|purchased|distributed`), `tents`, `sleepingBags`, `verified`, `notes` (staff only).

Public counters sum **verified** records only.

## auditLogs

Append-only. Actor, action, target, timestamp, payload summary. No deletes.

## siteSettings

Public copy, featured ids, published consent version. Counters are derived, not typed by hand.
