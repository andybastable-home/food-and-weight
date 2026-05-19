# Status

## Current phase
**Phase 6 ✅ — Cross-device sync** (v0.8.1; verified phone + PC end-to-end).

Stable UUIDs as sync identity, attach-existing-sheet UX, schema versioning (Metadata tab), manual "Refresh from sheet" button, and cross-device delete propagation on pull. Verified: PC add → phone refresh shows it; phone delete → PC refresh removes it.

## Spike learnings (still relevant)
- **PWA WebView cookie isolation**: `use_fedcm_for_prompt: true` + stored `hint` (email) are both required for silent re-auth on Android.
- **`prompt: ''`** = silent if prior consent; `prompt: 'none'` hangs silently — don't use.
- **Cloud Console origins**: only `https://andybastable-home.github.io` and `http://localhost:8000` are authorised.
- **`drive.file` scope persists across PWA uninstall + reinstall** for the same `client_id` — a fresh install can re-attach to a previously-created sheet by ID without re-picking. (Validated 2026-05-19 with v0.8.0 PC attach.)

## Next steps
1. **Split AI context: food vs workouts.** Currently one diet-profile textarea feeds both food and workout estimations. Add a second textarea for workout-specific context (e.g. typical durations, perceived intensity baselines, kcal/min rules of thumb) and route it through to `requestWorkoutEstimation` only. Likely needs a second `AI_Context_Workout!A2` cell on the sheet.
2. **Multi-modal food calorie classification.** Camera/upload button on the food form lets Andy attach up to 3 photos. Thumbnails render in the form with delete X. On ✨ estimate, photos are sent inline to Gemini alongside the text + diet context. Photos are local-only (Dexie blob field or object URL) — not persisted to the sheet.

## Known follow-ups
- No "last synced" indicator.
- Service worker cache: `fw-shell-v0.8.1`.
