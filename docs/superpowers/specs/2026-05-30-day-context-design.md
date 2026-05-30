# Day Context Feature — Design Spec

**Date:** 2026-05-30  
**Status:** Approved

## Summary

Replace the unused skip-day feature with a "day context" note — a free-text annotation attached to a calendar day. Long pressing the date label opens an overlay to add, edit, or delete the note. The note is displayed as a quiet label just below the date in the nav header, visible on all tabs.

## Data

- New entry type `day_context` added to the `TYPES` map in `app.js`.
  - `inputKind: 'text'`, `isCollapsible: false`, `formatDisplay: (e) => e.text`
  - No calorie fields; excluded from all calorie/deficit/progress calculations.
- Stored in the existing IndexedDB `entries` store (`FoodAndWeight` / `entries`), same shape as other entries: `{ uuid, type: 'day_context', timestamp, text, rawInput, synced }`.
- At most one `day_context` entry per day, enforced in load/save logic (not the schema).
- `loadSkipMarker` renamed to `loadDayContext`; same query pattern, filters on `type === 'day_context'`.
- `createSkipMarker` renamed to `createDayContext`; `removeSkipMarker` renamed to `removeDayContext`.
- Sync: `entryToRow` / `syncEntriesToSheet` / `deleteEntryFromSheet` already handle arbitrary types — no changes to `sync.js`. Context rows appear in the Entries sheet with `type = 'day_context'` and the note text in the `notes` column; all calorie/AI columns blank.
- `skip_food` type removed from `TYPES` map. No migration needed (skip feature was never used).

## UI — Overlay

The existing `#skip-overlay` HTML element is repurposed in place:

| State | Title | Hint | Input placeholder | Buttons |
|---|---|---|---|---|
| No existing context | "Add day note" | "Add context for this day — e.g. giving blood, travelling, big event." | "e.g. giving blood" | Save, Cancel |
| Existing context | "Edit day note" | (same) | (pre-filled with existing text) | Save, Delete, Cancel |

- Dismiss by tapping outside the overlay (existing behaviour preserved).
- Confirm (Save) saves and syncs; Delete removes and syncs; Cancel closes with no action.
- No tab restriction — long press works on any tab and any day (past or present).

## UI — Context Label

- New element `<p id="day-context-label" class="date-nav-context hidden">` inserted in `index.html` directly below `#date-sub` inside `.date-nav-label`.
- `renderDateNav()` extended to load `day_context` for `currentDate` and populate / show/hide this element.
- Styling: `date-nav-context` class — small (13px), muted colour, similar visual weight to `date-nav-sub`. No interactive affordance; it's a read-only annotation.
- Visible on all tabs. Updates immediately when navigating between days.

## UI — Long Press

- `attachLongPress(els.dateNavLabel, openSkipPrompt)` call updated to `openContextPrompt`.
- `openContextPrompt` loads the current day's context entry, populates the overlay accordingly (empty or pre-filled), and shows it.
- The `longPressAttached` guard (prevents double-attach) is preserved as-is.

## State

- Module-level `let dayContext = null` replaces `let skipMarker = null`.
- Reset to `null` on date/tab change in `setDate` / `setTab`.

## What Does Not Change

- `sync.js` — no changes.
- `entryToRow` — no changes.
- All calorie calculations, progress charts, weekly goal, and deficit logic ignore `day_context` entries (they have no `calories` field, so existing guards already exclude them).
- The `loadEntries` function filters by type, so `day_context` never appears in the food/workout/measurements lists.

## Out of Scope

- Multiple context notes per day.
- Context notes visible in the progress charts.
- Any UI to browse historical context notes.
