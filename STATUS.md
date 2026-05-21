# Status

## Current phase
**Phase 8.6 🚧 — Progress charts view** (v0.14.0; coded, pending verification on phone).

Chart icon (⤻) in header opens full-screen Progress overlay. Three SVG charts: Weight trend (raw + 7-day avg line), Calories vs Target (bars + dashed target line), Net Balance (bars from zero baseline). Range chips: 7d / 30d / 90d / All (default 30d). Single Dexie query per render; all computation in-memory.

## Verification checklist (Phase 8.6)
1. Version `v0.14.0` shown in brand header and footer.
2. Chart icon appears left of gear in header; tap target ≥ 44 px.
3. Tap icon → Progress overlay opens; close button (×) returns to entry view. Tap backdrop also closes.
4. Range chips: 7d/30d/90d/All. Default 30d. Each tap re-renders all three charts.
5. **Weight chart**: today's dot matches most recent weight entry. 7-day avg line visible when ≥ 2 avg points exist.
6. **Calories chart**: today's bar matches food total on Food tab. Dashed target line tracks expected maintenance.
7. **Net balance chart**: a day with food > target shows an upward (red) bar; surplus day with activity shows smaller bar.
8. Offline: all charts render from local Dexie (no network needed).
9. "All" range: renders from first ever entry to today.

## Phase 8.5 ✅ — Rolling-avg calorie target + DailyTargets sheet tab (v0.13.2)

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
2. **Multi-modal food calorie classification.** Camera/upload on the food form → Gemini vision.

## Known follow-ups
- No "last synced" indicator.
- Service worker cache: `fw-shell-v0.13.2`.
