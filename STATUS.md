# Status

## Current phase
**Phase 6 — Cross-device sync** (v0.8.0; needs phone verification + PC attach test)

Goal: PC-as-second-device. Stable UUIDs, attach-existing-sheet UX, schema versioning, manual refresh.

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

## Next steps (verification)
1. **Backup the sheet in Drive** — done.
2. Launch v0.8.0 on phone: watch console for `Migrating sheet v1→v2…` then `Sheet at v2`. Open the sheet in Drive: column A is uuids, `Metadata!B1 = 2`.
3. Reload phone: migration must NOT run again.
4. Add/edit/delete an entry on phone → confirm sheet stays at v2 with uuids.
5. Open the URL in Chrome on PC, sign in to same account, paste sheet URL in Settings → Connect.
6. Add a food entry on PC, then on phone tap "Refresh from sheet" — PC entry appears.

## Known follow-ups
- No "last synced" indicator.
- Camera button (📷) in food form is wired to a file picker but does nothing yet.
- No tombstones — cross-device deletes don't propagate to other devices' local cache. Accepted per "don't worry about it" policy.
- Service worker cache: `fw-shell-v0.8.0`.
