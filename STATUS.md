# Status

## Current phase
**Phase 9 🚧 — Weekly Goal: pace tile + weekly deficit chart** (v0.15.0; coded, pending verification on phone).

New "Weekly Goal" section at the bottom of the Progress overlay. Pace tile (circular ring, four states: behind / on pace / ahead / way ahead) shows how the current Mon–Sun week's cumulative deficit compares to where it should be by now, given the day-type weighting (weekday vs weekend). Weekly Deficit chart below: ~10 weeks of bars vs the goal-rate reference line; current week visually muted to avoid being read as a complete week. Settings overlay grows a "Weekly Goal" section: kg/week loss goal, weekend ratio, weekend days. Defaults: 0.6 kg/wk, R = 0.5, Fri–Sun.

## Verification checklist (Phase 9)
1. Version `v0.15.0` shown in brand header and footer.
2. Settings → "Weekly Goal" section: kg/wk input, weekend ratio input, day chips (Mon–Sun). Editing any field updates the preview line ("weekday −X · weekend −Y"). Values persist across reload.
3. Progress overlay scrolls to a new "Weekly Goal" section at the bottom (under the existing three charts).
4. **Pace tile**: ring colour matches state. Centre shows percent of pace. Subtitle copy matches state — "Banked X kcal — eat more, this isn't sustainable" on way-ahead.
5. **Pace tile partial-day**: a fresh Monday morning with no food shows a small actual + small expected; ratio ≈ 100% (not 0%, not infinity).
6. **Pace tile day-type**: with R = 0.5 and Fri–Sun weekend, weekday targets should be higher than weekend targets. By end-of-Thursday with intent achieved, the ring should be "ahead" (banked for the weekend).
7. **Weekly chart**: ~10 weeks of bars. Goal line is a dashed horizontal reference. Current week bar is muted (not coloured green/red like complete weeks).
8. Goal kg/wk = 0 → tile shows "Set a goal in Settings to see your weekly pace"; chart shows zero-line + bars (no goal reference).
9. No profile (sex/age/height missing) → tile shows "Set your profile…"; chart shows "Set your profile…" empty state.

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

## Next steps (post Phase 9)
1. **Multi-modal food calorie classification.** Camera/upload on the food form → Gemini vision.
2. **Optional:** sync goal config to Metadata sheet (currently localStorage only — single-device assumption holds).

## Known follow-ups
- No "last synced" indicator.
- Service worker cache: `fw-shell-v0.15.0`.
