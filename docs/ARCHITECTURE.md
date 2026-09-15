# Architecture

## Shape

Vite + React + TypeScript SPA. Public visitors have **no accounts**. Staff use Firebase Auth (email) in production, or a local demo staff session.

```
Browser (public)
  → read coloring pages (static + Firestore)
  → print (CSS + PDF)
  → submit via HTTPS callable / demo API
       → original stored privately
       → derived preview/thumbnail created
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

Unsigned client writes are an abuse magnet. Production submissions go through Cloud Functions that:

1. mint a random submission id
2. issue a short-lived signed upload URL
3. validate magic bytes + size
4. store the **original unchanged**
5. write derived assets (EXIF/GPS stripped)
6. assign `NBC-ART-######` from a server counter

## Print

- On-screen print route uses `@media print` (no chrome, letter, margins).
- PDFs are the 300 DPI US Letter files from the coloring-book library.
- Activity packs are merged with pdf-lib; an instruction+QR cover is generated in code (exact text).

## Frontend composition

Routes in `src/App.tsx`. Layout is illustrated but semantic (`header`, `main`, `nav`, `footer`). Motion is CSS-only and silenced by `prefers-reduced-motion`.
