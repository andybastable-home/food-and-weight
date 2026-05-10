# Food & Weight

A personal, single-user PWA for logging food, weight, waist, and workouts. Designed to live on the home screen of one phone (Pixel 8a) and stay out of the way.

## Status
Phase 0 — project skeleton. See [`STATUS.md`](./STATUS.md) for current state and next step.

## Run locally
No build step. Serve the directory over HTTP (service workers don't run from `file://`):

```bash
# pick whichever you have
python -m http.server 8000
# or
npx serve .
```

Then open `http://localhost:8000`.

## Deploy
Pushed to `main` → GitHub Pages serves it at `https://andybastable-home.github.io/food-and-weight/`.

## Stack
- Vanilla HTML / CSS / JS — no build pipeline.
- [Dexie.js](https://dexie.org/) for IndexedDB (added in Phase 1).
- Service worker for offline shell.

## Layout
```
index.html         single page, all UI
manifest.json      PWA manifest
service-worker.js  offline shell cache
app.js             UI logic + storage
styles.css         design tokens + styles
icons/             app icons
```
