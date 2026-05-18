# Status

## Current phase
**Phase 5 — Workout calorie tracking + Settings Save button** (v0.6.4; needs phone verification)

## Last completed
- **Workout calorie tracking + Settings Save button (v0.6.4)**:
  - Settings modal close button changed to explicit "Save & Close" primary button.
  - Workout tab now shows calories input + ✨ AI estimator (uses conservative workout prompt with age/sex/height/weight).
  - Workout calories shown on entry rows and delete-confirm rows.
  - Daily totals bar now shows `Food: X / Target: Y + Z = W kcal` (workout calories added to target) on both Food and Workout tabs.
  - Retro ✨ button on workout entries without calories routes to `requestWorkoutEstimation`.
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
1. Settings modal: confirm close button reads "Save & Close" and dismisses the modal.
2. Workout tab: type "1 hour mowing the lawn", tap ✨ — verify conservative calorie estimate fills in.
3. Save workout entry — confirm row shows kcal on the right.
4. Check bottom bar reads e.g. `Food: 0 / Target: 2100 + 350 = 2450 kcal`.
5. Add a Food entry — confirm Food total updates, target string stays correct.
6. Switch to Food tab — confirm same totals bar format.

## Known follow-ups
- Edits/deletes don't sync yet — append-only log.
- No "last synced" indicator.
- Camera button (📷) in food form is wired to a file picker but does nothing yet — Phase 5 candidate.
- `AI_Context` pull only fires if local is blank; no explicit "pull latest from sheet" button yet.
- Service worker cache: `fw-shell-v0.6.4`.
