# Status

## Current phase
**Phase 0 — Project skeleton ✅ complete.** Ready for Phase 1.

## Last completed
- Pages enabled on `main`, app served at `https://andybastable-home.github.io/food-and-weight/`.
- Installed to Pixel 8a home screen, launches standalone, verified offline (airplane mode).
- SVG-only icon proved sufficient for Android Chrome install — no PNG fallback needed.

## Next step
**Phase 1 — Food diary MVP**
- Add Dexie.js (CDN script, no build step) and an `entries` table: `{id, type: 'food', text, timestamp}`.
- Single-screen UI: large text input ("what did you eat?"), Save button, list of today's entries with timestamps.
- Date navigation (prev/next day arrows; default to today).
- Edit/delete entries.
- Bump service-worker `CACHE_VERSION` and add Dexie URL to the shell list.
- Verify: log entries throughout a day on the phone — friction should already beat paper.

## Phase 0 acceptance
- [x] Pages URL serves the app over HTTPS
- [x] App installs to home screen and launches standalone (no browser chrome)
- [x] App loads with no network (service worker caches the shell)

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
