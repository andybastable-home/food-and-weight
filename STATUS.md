# Status

## Current state
**v1.1.5 shipped.** No work in flight.

1.x covers the full feature set: food/activity/measurements logging, local Dexie store, one-phone↔one-sheet Google Sheets sync (schema v5), AI calorie/effort estimation (Gemini) with stored reasoning, local fuzzy repeat-food chip, rolling-average maintenance target, Progress charts (weight + trend, calories vs target, net balance), day-type header differentiation, swipe-to-change-day, and the deficit/surplus calorie tile.

**v1.1.0 — humane progress redesign.** Replaced the brittle weekly-goal pace ring (which could swing from "ahead" to "off track" on one normal meal) with a forgiving, encouraging model:
- **Day view:** the calorie wheel is now coloured off the **trailing 7-day rolling deficit**, not today, so one heavy day can't repaint a week of real progress. Today's number stays as the (neutral) hero; an affirming line frames it against the week. Alarm-red softened to amber.
- **Weekly tile ("This Week"):** a beautiful ring showing an optimistically-framed weight-loss **rate band** (Great progress / Steady drop / Holding steady / Edging up), graded off the *conservative* end of a range derived two ways — forecast from the rolling deficit (low) and the actual weight-trend regression (high). Gain warning needs a two-layer guard (deficit surplus AND scale flat/up). Sub-0.2 kg/wk shows words, not false-precision numbers.
- **Settings:** retired the weekly-goal rate, weekend-ratio, and weekend-days controls (the new model keys on rolling deficit + weight trend, not a user target). Sheet schema untouched; the goal rows in Metadata are now vestigial but harmless.

## Future work
Nothing planned or scheduled — both are "maybe, later":

1. **Multi-modal (photo-assisted) calorie estimation.** Camera/upload on the food form → Gemini vision. (The earlier stub camera button was removed at 1.0; start fresh.)
2. **Weekly LLM diet advice.** Periodic Gemini summary/coaching over recent intake + weight trend.

## Reference
- PWA / Google auth gotchas (silent re-auth, Cloud Console origins, `drive.file` persistence) → `notes/auth-learnings.md`.
