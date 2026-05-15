# Status

## Current phase
**Phase 3 — Google Sheets sync** (OAuth spike complete; real sync wiring is next)

## Last completed
- **OAuth + Sheets spike (v0.3.0 → v0.3.5)** — proven end-to-end on the phone:
  - Google Identity Services token client, scope `drive.file openid email`.
  - First launch: one consent screen + account picker. After that, silent re-auth on every reload, no UI at all.
  - Test sheet creation + row append both work via the Sheets REST API.
  - Code lives in `sync.js`, fully standalone — does not touch `app.js` or the Dexie store yet.
  - UI is a temporary `<details>` panel at the bottom of the page.
- Phase 2 ✅ — multi-type entries + tabs in real use since 2026-05-11.

## Spike learnings (worth keeping in mind for the real wiring)
- **PWA WebView cookie isolation** is real. Without `use_fedcm_for_prompt: true` plus a stored `hint` (the user's email), every silent re-auth would re-prompt the account picker. Both knobs are required for the "auth once forever" UX.
- **Email capture** needs the `openid email` scopes alongside `drive.file`, then a one-shot call to `oauth2/v3/userinfo` after first connect. The captured email goes in `localStorage` and is passed as `hint` on every later token request.
- **`prompt: ''`** is the documented "silent if possible" mode. `prompt: 'none'` was tried first and just hung — error never surfaced through `callback` or `error_callback`.
- **`error_callback`** on `initTokenClient` is mandatory for diagnostics — popup/FedCM failures don't go through `callback`.
- **No client secret** in browser code — token client doesn't use it; it's stashed for if a backend ever gets added.
- **Cloud Console origins**: only `https://andybastable-home.github.io` and `http://localhost:8000` are authorised. Adding more requires editing the OAuth client.

## Next step
1. **Decide the sync surface** before building it:
   - Append-on-save mirror was the chosen model (each new entry → one row in the Sheet, log-style).
   - Edits and deletes — do they update the existing row, or just append a "diff" row? Lean toward update-by-id since the Dexie row has a stable `id` that can live in column A.
   - What happens to entries created while offline / before connecting? Need a "to sync" queue (could just be: any entry without a `syncedAt` timestamp gets pushed when a token is available).
2. **Replace the spike panel with a real Settings affordance.** A small gear icon in the header → modal with Connect / Sheet link / Disconnect. Move the spike `<details>` out of the bottom of the page.
3. **Wire `db.entries` save/edit/delete hooks** to enqueue sync work, with the userinfo `hint` already in place.
4. Add a small "last synced" indicator somewhere unobtrusive.

## Phase 3 acceptance
- [ ] After Connect, every new entry appears as a row in the Sheet within a few seconds (when online).
- [ ] Edits and deletes propagate to the Sheet.
- [ ] Offline-created entries flush on next online + token-available moment.
- [ ] Disconnecting clears the local sheet ID + email pin and stops sync attempts.
- [ ] Reload of the PWA never shows an OAuth UI once the user has connected once.

## Phase 4 preview (designed, not started)
- AI-driven calorie classification — text-only quick estimate + multimodal recipe/bowl flow.
- Design + verified Gemini API shape + prompt templates: `notes/ai-calorie-spike.md`.
- Do not start until Phase 3 Sheets sync is fully shipped.

## Known follow-ups (not blockers)
- The `<details>` "Sheets sync (spike)" panel is intentionally ugly — replace as part of the design pass.
- Spike uses `valueInputOption=USER_ENTERED` so Sheets parses dates/numbers; might switch to `RAW` once the column types are settled.
- No Sheet schema versioning — if the row format changes later, will need a migration story.
- Tokens last ~1 hour; long sessions need a refresh-on-demand path before each Sheets call (the `ensureFreshToken` helper is already there but only triggers on first call after expiry).

## Notes for next session
- Spike code: `sync.js` (standalone). Do not delete — the OAuth init, token refresh, and userinfo capture all stay; just the UI/log bits get replaced.
- Cloud Console project: "Food and Weight" under the personal Google account. OAuth Client ID is hard-coded in `sync.js` (it's a public identifier, fine to commit).
- Service worker cache name is versioned (`fw-shell-vX.Y.Z`); bump it whenever shell files change so updates roll cleanly.
- Update this file at the end of each working session.
