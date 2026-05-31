# Status

## Current state
**v1.4.0 shipped.** No work in flight. Latest: **pending (planned-ahead) entries** — picking a future-on-today time-category pill makes a food/activity entry a tentative plan (button reads "Plan"); it stays local, never syncs, and is excluded from all real totals/history/frequents until **Confirm** promotes it to a real entry (via the prefilled form). Ring shows a faded arc for planned food; "calories to play with" nets planned food/activity. Bundled in: retuned category boundaries (Breakfast 04–09, Morning 09–12, Dinner 17–19, Evening 19–04).

1.x covers the full feature set: food/activity/measurements logging, local Dexie store, one-phone↔one-sheet Google Sheets sync (schema v5), AI calorie/effort estimation (Gemini) with stored reasoning, local fuzzy repeat-food chip, rolling-average maintenance target, Progress charts (weight + trend, calories vs target, net balance), day-type header differentiation, swipe-to-change-day, and the deficit/surplus calorie tile.

**v1.1.0 — humane progress redesign.** Replaced the brittle weekly-goal pace ring (which could swing from "ahead" to "off track" on one normal meal) with a forgiving, encouraging model:
- **Day view:** the calorie wheel is now coloured off the **trailing 7-day rolling deficit**, not today, so one heavy day can't repaint a week of real progress. Today's number stays as the (neutral) hero; an affirming line frames it against the week. Alarm-red softened to amber.
- **Weekly tile ("This Week"):** a beautiful ring showing an optimistically-framed weight-loss **rate band** (Great progress / Steady drop / Holding steady / Edging up), graded off the *conservative* end of a range derived two ways — forecast from the rolling deficit (low) and the actual weight-trend regression (high). Gain warning needs a two-layer guard (deficit surplus AND scale flat/up). Sub-0.2 kg/wk shows words, not false-precision numbers.
- **Settings:** retired the weekly-goal rate, weekend-ratio, and weekend-days controls (the new model keys on rolling deficit + weight trend, not a user target). Sheet schema untouched. The vestigial goal rows in Metadata (`A6:B8`) are now blanked on every sync (v1.6.1) so they no longer linger.

## Future work
Nothing planned or scheduled — both are "maybe, later":

1. **Weekly LLM diet advice.** Periodic Gemini summary/coaching over recent intake + weight trend.

## Reference
- PWA / Google auth gotchas (silent re-auth, Cloud Console origins, `drive.file` persistence) → `notes/auth-learnings.md`.
