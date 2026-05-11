# Status

## Current phase
**Phase 2 — Multi-type entries + tabs** (built, awaiting on-phone verification)

## Last completed
- Phase 1 ✅ — food diary in real daily use since 2026-05-11.
- 4-tab segmented control (Food / Weight / Waist / Workout) above the entry form. Default tab: Food.
- `TYPES` config in `app.js` is the single source of truth for per-type behavior (placeholder, input kind, unit, time-on-add flag, display formatter). Add/edit/render all read from it.
- Weight & Waist: number input with `kg` / `cm` suffix baked into the field; `inputmode="decimal"` for the right keyboard on Android.
- Food & Workout: text input + `<input type="time">` defaulted to "now" on today and "12:00" on past days, editable.
- All edit forms include a time field, so any timestamp can be corrected after the fact (preserves the entry's original day).
- Schema unchanged — existing food entries continue to render under the Food tab.
- SW `CACHE_VERSION` bumped to `v0.2.0`.

## Next step
1. On the Pixel 8a, fully close the PWA from recents then reopen — gives the new service worker a clean slate.
2. **Smoke test**:
   - Food tab still works — log an entry, confirm timestamp shows the time you actually picked.
   - Weight tab: enter `72.5`, save, confirm "72.5 kg" appears with today's time.
   - Waist tab: enter `88`, save, confirm "88 cm" appears.
   - Workout tab: enter `30 min walk`, save, confirm it lands with the time you picked.
   - Tap a measurement entry → edit form has the number field + time. Change the time, save, confirm both persist.
   - Switch tabs while editing — edit cancels cleanly.
   - Date nav still works on every tab.
3. Look out for layout issues on the form row (text + time + Save) on a narrow screen — it should wrap if cramped.

## Phase 2 acceptance
- [ ] Each of the four entry types works end-to-end (add, render, edit, delete)
- [ ] Weight & waist values display with the right unit and 1 dp precision
- [ ] Food & workout entries can be timestamped at add time and the time can be corrected via edit
- [ ] Tab switch is instant and clears any in-flight edit
- [ ] Layout holds up on the Pixel 8a portrait viewport

## Deferred from the original Phase 2
- Daily summary view (today's totals at a glance) — not yet needed; revisit after real use shows whether it's missed.

## Known follow-ups (not blockers)
- Delete still uses browser `confirm()` — replace with inline undo in the design pass.
- Tabs always show all four — no way to hide unused ones. Probably fine forever.
- No "Today" jump-back button when navigating back in time. Could add as a chip in the date nav if it's missed.
- The `<input type="time">` on Android shows a clock picker by default; some users find this slower than a wheel. Acceptable for now.

## Design intent (unchanged from Phase 0)
- Calm sage-green accent on warm off-white; auto dark mode via `prefers-color-scheme`.
- System font stack; tokens in CSS custom properties at the top of `styles.css`.
- Dedicated **design iteration pass** still pending — slot in once enough surface exists to style coherently.

## Notes for next session
- Plan: `~/.claude/plans/i-have-an-idea-mossy-pebble.md` (Phase 2 description updated to match what shipped).
- All paths are relative — Pages serves under `/food-and-weight/` subpath; absolute paths would break.
- Service worker cache name is versioned (`fw-shell-vX.Y.Z`); bump it whenever shell files change so updates roll cleanly.
- Update this file at the end of each working session.
