# Status

## Current phase
**Phase 10 🚧 — Store Gemini reasoning for review/calibration** (v0.16.0; coded, pending verification on phone).

Gemini's `reasoning` field (already returned in every estimate response, previously thrown away after showing in the form) is now persisted on the entry and synced to the sheet as a new column P (`ai_reasoning`). Sheet schema bumps v4 → v5. New `migrateSheetV4ToV5` appends the column; old rows are left blank. The point: periodically review the sheet for items whose final logged calories diverge from `ai_suggested_calories`, and use `ai_reasoning` to spot which assumptions to encode as personal facts.

## Verification checklist (Phase 10)
1. Version `v0.16.0` shown in brand header and footer.
2. Add a food entry via ✨ (e.g. "two slices of toast with butter"). Open the sheet → newest row → column P should contain Gemini's reasoning text.
3. Add a user-entered food entry (no ✨). Column P should be blank on that row.
4. Retro-estimate an old entry (long-press → ✨). Column P should populate on that row.
5. Open the sheet → Metadata!B1 reads `5`.
6. Pull a v4 sheet on a fresh device: `[sync] Migrating sheet v4→v5…` in the console, then `[sync] Sheet at v5`. Entries tab gains the new header cell P1=`ai_reasoning`; older rows leave P blank.

## Phase 9 ✅ — Weekly Goal: pace tile + weekly deficit chart (v0.15.0–v0.15.4)

## Phase 8.6 ✅ — Progress charts view (v0.14.0–v0.14.5)
Chart icon (⤻) opens full-screen Progress overlay with three SVG charts (weight trend, calories vs target, net balance) and 7d/30d/90d/All range chips. Single Dexie query per render; all computation in-memory.

## Phase 8.5 ✅ — Rolling-avg calorie target + DailyTargets sheet tab (v0.13.2)

## Phase 8 ✅ — Local fuzzy-match chip for repeat foods (v0.10.0–v0.12.1, verified)

## Phase 7 ✅ — Schema v3 enrichment (v0.9.0, verified)
Sheet schema extended with AI-lineage and intensity metadata: `raw_input`, `ai_suggested_title`, `ai_suggested_calories`, `calorie_source`, `calorie_confidence`, `effort`. Weight entries are AM-fasted by convention. Back-dating convention written to `Metadata!B2`.

## Phase 6 ✅ — Cross-device sync (v0.8.1, verified)
Stable UUIDs as sync identity, attach-existing-sheet UX, schema versioning (Metadata tab), manual "Refresh from sheet" button, cross-device delete propagation on pull.

## Spike learnings (still relevant)
- **PWA WebView cookie isolation**: `use_fedcm_for_prompt: true` + stored `hint` (email) are both required for silent re-auth on Android.
- **`prompt: ''`** = silent if prior consent; `prompt: 'none'` hangs silently — don't use.
- **Cloud Console origins**: only `https://andybastable-home.github.io` and `http://localhost:8000` are authorised.
- **`drive.file` scope persists across PWA uninstall + reinstall** for the same `client_id` — a fresh install can re-attach to a previously-created sheet by ID without re-picking. (Validated 2026-05-19 with v0.8.0 PC attach.)

## Next steps (post Phase 10)
1. **Multi-modal food calorie classification.** Camera/upload on the food form → Gemini vision. (Stub camera button already exists in the food form but does nothing yet.)
2. **Three-tier day types (Exemplar / Wine / Free / Recovery).** Current weekday/weekend split can't fully capture Fri-with-wine vs Sat-free. Per-day mode picker would model the real week.

## Known follow-ups
- No "last synced" indicator.
- Service worker cache: `fw-shell-v0.16.0`.
