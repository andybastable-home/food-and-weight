# Status

## Current state
**v1.0.0 shipped.** No work in flight.

1.0 covers the full feature set: food/activity/measurements logging, local Dexie store, one-phone↔one-sheet Google Sheets sync (schema v5), AI calorie/effort estimation (Gemini) with stored reasoning, local fuzzy repeat-food chip, rolling-average maintenance target, weekly-goal pace tile, Progress charts (weight + trend, calories vs target, net balance), day-type header differentiation, swipe-to-change-day, and the deficit/surplus calorie tile.

## Future work
Nothing planned or scheduled — both are "maybe, later":

1. **Multi-modal (photo-assisted) calorie estimation.** Camera/upload on the food form → Gemini vision. (The earlier stub camera button was removed at 1.0; start fresh.)
2. **Weekly LLM diet advice.** Periodic Gemini summary/coaching over recent intake + weight trend.

## Reference
- PWA / Google auth gotchas (silent re-auth, Cloud Console origins, `drive.file` persistence) → `notes/auth-learnings.md`.
