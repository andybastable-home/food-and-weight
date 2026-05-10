# Status

## Current phase
**Phase 0 — Project skeleton**

## Last completed
- Repo SSH access verified (uses `~/.ssh/github_home_laptop` via repo-local `core.sshCommand`)
- `CLAUDE.md` created (no-subscriptions constraint, repo notes, gh auth note)
- Project skeleton scaffolded: `index.html`, `manifest.json`, `service-worker.js`, `styles.css`, `app.js`, SVG icon

## Next step
1. Commit & push the scaffold (Andy can do this, or ask Claude to).
2. **Andy: enable GitHub Pages** — Repo → Settings → Pages → Source: `Deploy from a branch` → Branch: `main` / `/ (root)`.
3. **Verify on Pixel 8a**: open `https://andybastable-home.github.io/food-and-weight/` in Chrome → menu → "Add to Home Screen" → confirm it launches standalone, then airplane mode → confirm it still loads.

## Phase 0 acceptance
- [ ] Pages URL serves the app over HTTPS
- [ ] App installs to home screen and launches standalone (no browser chrome)
- [ ] App loads with no network (service worker caches the shell)

## Design intent (set in Phase 0, refine later)
- Calm sage-green accent on warm off-white; auto dark mode via `prefers-color-scheme`.
- System font stack (no web-font fetch — better offline + faster first paint).
- Generous spacing, big tap targets, soft shadows, ~20px corner radius on cards.
- Tokens live in CSS custom properties at the top of `styles.css` — easy to retune in one place.
- Dedicated **design iteration pass** to be slotted in once Phase 1 has real content to style.

## Notes for next session
- Plan: `~/.claude/plans/i-have-an-idea-mossy-pebble.md`
- All paths are relative — Pages serves under `/food-and-weight/` subpath; absolute paths would break.
- Service worker cache name is versioned (`fw-shell-vX.Y.Z` in `service-worker.js`); bump it whenever shell files change so updates roll cleanly.
- Update this file at the end of each working session.
