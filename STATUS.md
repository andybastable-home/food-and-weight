# Status

## Current phase
**Phase 8.5 🚧 — Rolling-avg calorie target + DailyTargets sheet tab** (v0.13.0; coded, pending verification on phone).

7-day trailing weight average (days strictly before the target date) replaces the single most-recent weight. Activity multiplier bumped 1.2 → 1.3 (NEAT-adjusted sedentary). New `DailyTargets` tab in the Google Sheet: `date | target_kcal | weight_avg_kg | window_days`. Schema bumped to v4 with backfill migration.

## Verification checklist (Phase 8.5)
1. Version `v0.13.0` shown in brand header and footer.
2. Settings preview reads "Estimated maintenance: NNNN kcal/day (7-day weight average × 1.3 baseline activity; logged activity adds on top)."
3. Today's target ~8% higher than pre-upgrade (multiplier 1.2 → 1.3).
4. Navigate to a date ≥3 months old with food entries — target reflects rolling avg weight from that period, not today's weight.
5. Sparse week: window with some missing days still renders a target (LOCF fills gaps within 14-day staleness limit).
6. Log a weight for today → refresh → today's food-tab target unchanged; tomorrow's will include the new weight.
7. Sheet: `DailyTargets` tab exists, header = `date | target_kcal | weight_avg_kg | window_days`, spot-check 3 rows.
8. Sheet: log a food entry → DailyTargets row for today updated. Log a weight on D → D+1..D+7 rows updated.
9. Sheet: `Metadata!B1 = 4`; B2 mentions DailyTargets and Mifflin-St Jeor × 1.3.
10. Offline: historic dates show correct targets without a network round-trip.

## Phase 8 ✅ — Local fuzzy-match chip for repeat foods (v0.10.0–v0.12.1, verified)

Extends the sheet schema with AI-lineage and intensity metadata so the export can support LLM weekly/monthly analysis without confidently-wrong inferences. New columns: `raw_input`, `ai_suggested_title`, `ai_suggested_calories`, `calorie_source`, `calorie_confidence`, `effort`. Weight entries are now AM-fasted by convention (timestamp = noon-of-day, time_category = Morning). Back-dating convention written to `Metadata!B2`.

## Phase 7 ✅ — Schema v3 enrichment (v0.9.0, verified)

## Phase 6 ✅ — Cross-device sync (v0.8.1, verified)
Stable UUIDs as sync identity, attach-existing-sheet UX, schema versioning (Metadata tab), manual "Refresh from sheet" button, cross-device delete propagation on pull.

## Spike learnings (still relevant)
- **PWA WebView cookie isolation**: `use_fedcm_for_prompt: true` + stored `hint` (email) are both required for silent re-auth on Android.
- **`prompt: ''`** = silent if prior consent; `prompt: 'none'` hangs silently — don't use.
- **Cloud Console origins**: only `https://andybastable-home.github.io` and `http://localhost:8000` are authorised.
- **`drive.file` scope persists across PWA uninstall + reinstall** for the same `client_id` — a fresh install can re-attach to a previously-created sheet by ID without re-picking. (Validated 2026-05-19 with v0.8.0 PC attach.)

## Next steps (post Phase 8.5)
1. **Goals tab (Phase 9).** User-set aspirations: target weight, weekly deficit. DailyTargets already provides per-day maintenance estimate; Goals tab adds the user's stated goal on top.
2. **Split AI context: food vs activity.** Add a second textarea for activity-specific context.
3. **Multi-modal food calorie classification.** Camera/upload on the food form → Gemini vision.

## Known follow-ups
- No "last synced" indicator.
- Service worker cache: `fw-shell-v0.13.0`.
