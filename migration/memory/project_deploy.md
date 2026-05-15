---
name: project-deploy
description: Deploy target — GitHub Pages from main, no build step
metadata:
  type: project
---

Deploy target is GitHub Pages serving the `main` branch of `andybastable-home/food-and-weight`, published at `https://andybastable-home.github.io/food-and-weight/`. There is no build step — the source files at the repo root (`index.html`, `app.js`, `styles.css`, `sync.js`, `service-worker.js`, `manifest.json`) are the deployed artefacts. Push to `main` = deploy.

**How to apply:** When verifying changes, the options are: push to main and reload the live URL on phone/desktop, or run `python -m http.server 8000` from the repo root and hit `http://localhost:8000`. The service worker cache is versioned (`fw-shell-vX.Y.Z`) — bump the version in `service-worker.js` whenever shell files change, otherwise updates won't roll cleanly.
