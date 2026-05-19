# Status

## Current phase
**Phase 8 🚧 — Local fuzzy-match chip for repeat foods** (v0.10.0; coded, pending verification on phone).

Extends the sheet schema with AI-lineage and intensity metadata so the export can support LLM weekly/monthly analysis without confidently-wrong inferences. New columns: `raw_input`, `ai_suggested_title`, `ai_suggested_calories`, `calorie_source`, `calorie_confidence`, `effort`. Weight entries are now AM-fasted by convention (timestamp = noon-of-day, time_category = Morning). Back-dating convention written to `Metadata!B2`.

## Verification checklist (Phase 8)
1. Boot: `frequentFoods.length > 0` in DevTools console (items with ≥3 occurrences).
2. Type "cof" in food form → chip shows "☕ Coffee" + kcal after ~200 ms. Clear → chip gone.
3. Typo tolerance: "ofee", "coffe" → still matches; "xyzzy" → no chip.
4. Tap chip → input becomes canonical title, kcal filled, status shows "↩ Matched past entry (Nx)".
5. Save chip-matched entry → `calorieSource: 'match'`, `aiSuggestedTitle`/`aiSuggestedCalories` set, `rawInput` = original typed text.
6. Chip then ✨ → chip disappears, Gemini fires normally, saved entry has `calorieSource: 'gemini'`.
7. Workout tab → no chip; ✨ still works.
8. Offline reload → chip still works (uFuzzy pre-cached by SW).
9. Sheet round-trip → `calorie_source` column shows `match`.

## Phase 7 ✅ — Schema v3 enrichment (v0.9.0, verified)

## Phase 6 ✅ — Cross-device sync (v0.8.1, verified)
Stable UUIDs as sync identity, attach-existing-sheet UX, schema versioning (Metadata tab), manual "Refresh from sheet" button, cross-device delete propagation on pull.

## Spike learnings (still relevant)
- **PWA WebView cookie isolation**: `use_fedcm_for_prompt: true` + stored `hint` (email) are both required for silent re-auth on Android.
- **`prompt: ''`** = silent if prior consent; `prompt: 'none'` hangs silently — don't use.
- **Cloud Console origins**: only `https://andybastable-home.github.io` and `http://localhost:8000` are authorised.
- **`drive.file` scope persists across PWA uninstall + reinstall** for the same `client_id` — a fresh install can re-attach to a previously-created sheet by ID without re-picking. (Validated 2026-05-19 with v0.8.0 PC attach.)

## Next steps (post Phase 8)
1. **Goals tab.** Second sheet tab with target weight, weekly loss target, maintenance kcal estimate.
2. **Split AI context: food vs workouts.** Add a second textarea for workout-specific context.
3. **Multi-modal food calorie classification.** Camera/upload on the food form → Gemini vision.

## Known follow-ups
- No "last synced" indicator.
- Service worker cache: `fw-shell-v0.10.0`.
