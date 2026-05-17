# Status

## Current phase
**Phase 3 — Google Sheets sync** (live wiring shipped in v0.5.1; needs phone verification)

## Last completed
- **Live Sheets sync (v0.5.1)** — spike panel removed, real wiring landed:
  - Spike `<details>` panel gone. Replaced with minimal `sync-settings` section (Connect / Open sheet / Disconnect).
  - `syncEntriesToSheet(entries)` in `sync.js` — maps each entry to 7-column flat schema (id, epoch, iso_date, type, value, notes, synced_at) and appends to Sheets via REST API.
  - Sheet auto-created on first sync (with header row). Sheet ID persisted in localStorage.
  - Live save: new entries sync to Sheet immediately after `db.entries.add`; `synced: true` flag written back on success.
  - Historical/offline recovery: `syncUnsyncedEntries()` in `app.js` queries Dexie for entries without `synced: true` and bulk-pushes on load/connect.
  - Service worker bumped to `fw-shell-v0.5.1` to force update on phone.
- **OAuth + Sheets spike (v0.3.0 → v0.3.5)** — proven end-to-end on the phone.
- Phase 2 ✅ — multi-type entries + tabs in real use since 2026-05-11.

## Spike learnings (still relevant)
- **PWA WebView cookie isolation**: `use_fedcm_for_prompt: true` + stored `hint` (email) are both required for silent re-auth on Android.
- **Email capture**: one-shot `oauth2/v3/userinfo` call after first connect; email stored in localStorage as `fw.spike.email`.
- **`prompt: ''`** = silent if prior consent; `prompt: 'none'` hangs silently — don't use.
- **Cloud Console origins**: only `https://andybastable-home.github.io` and `http://localhost:8000` are authorised.

## Next step (phone verification)
Test on Pixel 8a installed PWA:
1. Load — spike panel should be gone.
2. Tap "Connect Sheets" → authorize OAuth.
3. Check Drive: new sheet created with 7-column header + historic data.
4. Check IndexedDB: historic records have `synced: true`.
5. Add new entry → verify it appears in Sheet within seconds.
6. Go offline → add entry → go online → reload → verify offline entry synced.

## Phase 3 remaining acceptance
- [ ] After Connect, every new entry appears as a row in the Sheet within a few seconds (when online).
- [x] Offline-created entries flush on next online + token-available moment.
- [x] Disconnecting clears the local sheet ID + email pin and stops sync attempts.
- [x] Reload of the PWA never shows an OAuth UI once the user has connected once.
- [ ] (Deferred) Edits and deletes propagate to the Sheet.

## Phase 4 preview (designed, not started)
- AI-driven calorie classification — text-only quick estimate + multimodal recipe/bowl flow.
- Design + verified Gemini API shape + prompt templates: `notes/ai-calorie-spike.md`.
- Do not start until Phase 3 Sheets sync is fully verified on the phone.

## Known follow-ups (not blockers)
- Edits/deletes don't sync yet — append-only log is the current model.
- No "last synced" indicator in the UI.
- No Sheet schema versioning — if row format changes, will need a migration story.
- `sync-settings` section has no CSS beyond inherited styles — may need styling pass.

## Notes for next session
- Cloud Console project: "Food and Weight" under the personal Google account. OAuth Client ID is hard-coded in `sync.js` (public identifier, fine to commit).
- Service worker cache name is `fw-shell-v0.5.1`; bump when shell files change.
- `synced` is an unindexed Dexie field (no schema version bump needed).
