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
3. Deploy: `npm test` then `npm run build` then `firebase deploy --project notbychance-color-for-a-cause`
4. **Legal review of consent v0.1 before treating permissions as final.**

Public visitors never write Firestore. Uploads go through Cloud Functions and signed URLs. Unapproved art is not on the Art Wall.

## Docs

See `docs/` for architecture, data model, security, privacy, and the checklist.

## Claims we will not make

Submitting art does not mint an NFT, guarantee funding, promise investment value, or create a tax deduction by itself.
