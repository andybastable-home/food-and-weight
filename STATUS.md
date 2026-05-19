# Status

## Current phase
**Phase 7 🚧 — Schema v3 enrichment** (v0.9.0; coded, pending verification on phone + PC).

Extends the sheet schema with AI-lineage and intensity metadata so the export can support LLM weekly/monthly analysis without confidently-wrong inferences. New columns: `raw_input`, `ai_suggested_title`, `ai_suggested_calories`, `calorie_source`, `calorie_confidence`, `effort`. Weight entries are now AM-fasted by convention (timestamp = noon-of-day, time_category = Morning). Back-dating convention written to `Metadata!B2`.

## Verification checklist (Phase 7)
1. PC: connect existing v2 sheet → migration v2→v3 runs, 6 new header columns added, weight rows backfilled with `Morning`, food/workout rows with calories get `calorie_source=user`, workout rows get `effort=low`, `Metadata!B1=3`, `Metadata!B2` has convention note.
2. Add food via ✨ flow, accept estimate as-is → row shows raw_input ≠ value (when AI canonicalised), `calorie_source=gemini`, `calorie_confidence` populated.
3. Add food via ✨ flow, revise the kcal number → `ai_suggested_calories` preserves Gemini's number, `calories` reflects revision, `calorie_source` still `gemini`.
4. Add food directly (no ✨) → `raw_input = value`, ai_* blank, `calorie_source=user`.
5. Add weight today → timestamp = noon of currentDate, `time_category=Morning`.
6. Add workout → Low/Med/High pill row defaults to Low; selection saved in `effort` col.
7. Phone refresh after PC adds → all new cols pull cleanly into Dexie.

## Phase 6 ✅ — Cross-device sync (v0.8.1, verified phone + PC end-to-end)
Stable UUIDs as sync identity, attach-existing-sheet UX, schema versioning (Metadata tab), manual "Refresh from sheet" button, cross-device delete propagation on pull.

## Spike learnings (still relevant)
- **PWA WebView cookie isolation**: `use_fedcm_for_prompt: true` + stored `hint` (email) are both required for silent re-auth on Android.
- **`prompt: ''`** = silent if prior consent; `prompt: 'none'` hangs silently — don't use.
- **Cloud Console origins**: only `https://andybastable-home.github.io` and `http://localhost:8000` are authorised.
- **`drive.file` scope persists across PWA uninstall + reinstall** for the same `client_id` — a fresh install can re-attach to a previously-created sheet by ID without re-picking. (Validated 2026-05-19 with v0.8.0 PC attach.)

## Next steps (post Phase 7)
1. **Goals tab.** Second sheet tab with target weight, weekly loss target, maintenance kcal estimate. Bundled into the LLM-analysis export so the model has goal context without re-prompting.
2. **Split AI context: food vs workouts.** Currently one diet-profile textarea feeds both food and workout estimations. Add a second textarea for workout-specific context and route through to `requestWorkoutEstimation` only.
3. **Multi-modal food calorie classification.** Camera/upload on the food form, up to 3 photos sent inline to Gemini alongside text + diet context. Local-only, not persisted to the sheet.

## Known follow-ups
- No "last synced" indicator.
- Service worker cache: `fw-shell-v0.9.0`.
