# Security model

## Threats (upload-centric)

| Threat | Control |
|---|---|
| Public Firestore writes | Denied in rules; Functions only |
| Bucket listing | `list` denied; randomized ids |
| MIME spoofing | Magic-byte check server-side; allow jpeg/png/webp/heic |
| Oversize | 15 MB hard limit |
| XSS in messages | Stored as text; rendered as text nodes, never `innerHTML` |
| HTML/script upload | Extension + magic bytes; no SVG/HTML accept |
| Path traversal | Server builds storage paths |
| ID enumeration | UUIDs; sequential numbers are not storage keys |
| Spam/bots | App Check + rate limit on Functions; demo mode local-only |
| Privilege escalation | Custom claims `role`; rules check claims; UI hides by role |
| CSRF | Firebase callable + App Check; demo is same-origin |
| Staff session theft | Firebase Auth; demo password never shipped to production |

## Roles (least privilege)

- **ADMIN** — everything
- **REVIEWER** — submissions moderate, not settings/pages
- **ART_MANAGER** — coloring pages, featured wall
- **IMPACT_MANAGER** — collectibles impact fields, verified counters

## Content moderation

Heuristics **flag** (phone, email, address-like, URLs, hate/sexual/threat lexicons). They never auto-reject. Humor such as “I like eating chalk” is not a flag by itself. Humans publish.

## Secrets

No service-account keys in the client. `VITE_*` is public config only.
