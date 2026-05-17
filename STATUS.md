# Status

## Current phase
**Phase 4 — Retro calorie estimation** (v0.5.5; needs phone verification)

## Last completed
- **Retro calorie estimation via ✨ button (v0.5.5)**:
  - Food entries without calories now show a ✨ button on the right.
  - Tapping ✨ fires Gemini, then expands the row into an inline review form (title + calorie inputs).
  - Save writes updated text, calories, and backfilled timeCategory to Dexie and the Google Sheet (in-place row update via PUT, no duplicate).
  - Row container changed from `<button>` to `<div role="button">` to allow nested buttons.
  - `updateEntryInSheet()` added to sync.js.
- **AI calorie estimation (v0.5.3)**:
  - New "AI" tab in the nav — shows API key field + monospace diet-profile textarea.
  - ✨ sparkle button in the food form fires a Gemini 2.5 Flash request with the food description + profile context.
  - Gemini returns: reformatted emoji title, calorie estimate, confidence (Excellent/Moderate/Low), reasoning.
  - Title and calories fields are updated in-place; user still taps Save manually.
  - Confidence + reasoning displayed in a colour-coded status log below the food input.
  - Profile context stored in `localStorage` (`fw_gemini_context`) and synced to `AI_Context` worksheet in the Google Sheet (push on blur, pull on connect if local is empty).
  - `ensureAIContextSheet()` adds the tab to existing sheets on next connect.
- **Live Sheets sync (v0.5.1)** ✅
- Phase 2 ✅ — multi-type entries + tabs in real use since 2026-05-11.

## Spike learnings (still relevant)
- **PWA WebView cookie isolation**: `use_fedcm_for_prompt: true` + stored `hint` (email) are both required for silent re-auth on Android.
- **`prompt: ''`** = silent if prior consent; `prompt: 'none'` hangs silently — don't use.
- **Cloud Console origins**: only `https://andybastable-home.github.io` and `http://localhost:8000` are authorised.

## Next steps (phone verification)
1. Create a food entry without calories — confirm ✨ appears on its row.
2. Tap ✨ — it should turn ⏳, then expand into an inline form with pre-filled title + calories.
3. Edit the calories slightly, tap Save.
4. Check IndexedDB: entry has `calories` and `timeCategory`.
5. Check Google Sheets: row updated in place (no duplicate), new text/calories/timeCategory visible.

## Known follow-ups
- Edits/deletes don't sync yet — append-only log.
- No "last synced" indicator.
- Camera button (📷) in food form is wired to a file picker but does nothing yet — Phase 5 candidate.
- `AI_Context` pull only fires if local is blank; no explicit "pull latest from sheet" button yet.
- Service worker cache: `fw-shell-v0.5.5`.
