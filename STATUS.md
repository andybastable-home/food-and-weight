# Status

## Current phase
**Quick fixes toward 1.0 — Phase A ✅, Phase B 🚧 awaiting review gate** (v0.17.0).

Phase A ✅ (functional): Item 1 deficit/surplus wording + `is-near` "small" calmer-grey variant (±150 kcal); "target"→"maintenance" in detail line + no-profile hint. Item 2 swipe left/right to change day (handlers on `.container`, 60px / 1.5× horizontal threshold, guarded against future days + interactive controls). Item 3 `data-daytype` hook + placeholder CSS.

Phase B 🚧: scope expanded to a **full-app** visual pass (Andy's call). `notes/visual-preview.html` built — self-contained, light + dark, covering: day screen (header w/ chart+gear icons, day-type headers, tabs, real collapsed→expanded Food form, entries with combined pastel-wash + left-edge tint), Measurements tab, all 5 calorie-tile states, Progress charts overlay, Settings pane. (The "focus reveals pills" idea was dropped — it was a misread of the existing form, which already reveals all fields on "Log Food".) **Awaiting Andy's review/approval before any real style change.**

## Next steps
1. **REVIEW GATE:** Andy opens `notes/visual-preview.html` (light + dark) and approves / requests changes. Do not touch `styles.css`/`index.html` until then.
2. **Phase C:** port approved styles into `styles.css`/`index.html`, finalize Item 3 colors, bump to v0.17.1, commit + push.

## Phase 10 ✅ — Store Gemini reasoning for review/calibration (v0.16.0)
Gemini's `reasoning` persisted on the entry + synced to sheet column P (`ai_reasoning`); sheet schema v4→v5 via `migrateSheetV4ToV5`. Old/user-entered rows leave P blank.

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
- Service worker cache: `fw-shell-v0.17.0`.
