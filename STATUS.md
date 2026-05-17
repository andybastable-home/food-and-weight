# Status

## Current phase
**Phase 4 — AI calorie estimation** (shipped in v0.5.3; needs phone verification)

## Last completed
- **AI calorie estimation (v0.5.3)**:
  - New "AI" tab in the nav — shows API key field + monospace diet-profile textarea.
  - ✨ sparkle button in the food form fires a Gemini 2.5 Flash request with the food description + profile context.
  - Gemini returns: reformatted emoji title, calorie estimate, confidence (Excellent/Moderate/Low), reasoning.
  - Title and calories fields are updated in-place; user still taps Save manually.
  - Confidence + reasoning displayed in a colour-coded status log below the food input.
  - Profile context stored in `localStorage` (`fw_gemini_context`) and synced to `AI_Context` worksheet in the Google Sheet (push on blur, pull on connect if local is empty).
  - `ensureAIContextSheet()` adds the tab to existing sheets on next connect.
- **Live Sheets sync (v0.5.1)** ✅
- Phase 2 ✅ — multi-type entries + tabs in real use since 2026-05-11.

## Spike learnings (still relevant)
- **PWA WebView cookie isolation**: `use_fedcm_for_prompt: true` + stored `hint` (email) are both required for silent re-auth on Android.
- **`prompt: ''`** = silent if prior consent; `prompt: 'none'` hangs silently — don't use.
- **Cloud Console origins**: only `https://andybastable-home.github.io` and `http://localhost:8000` are authorised.

## Next steps (phone verification)
1. Load PWA — confirm "AI" tab appears in the nav.
2. Go to AI tab → paste Gemini API key → type some diet context notes.
3. Return to Food tab → type a scrappy food description → tap ✨.
4. Verify: title updates with emoji, calories fill in, confidence log appears.
5. Tap Save — confirm entry logs normally.
6. Connect Sheets → check Drive: `AI_Context` worksheet exists, cell A2 has your context.
7. Wipe localStorage → reload → reconnect → confirm context is pulled back from the sheet.

## Known follow-ups
- Edits/deletes don't sync yet — append-only log.
- No "last synced" indicator.
- Camera button (📷) in food form is wired to a file picker but does nothing yet — Phase 5 candidate.
- `AI_Context` pull only fires if local is blank; no explicit "pull latest from sheet" button yet.
- Service worker cache: `fw-shell-v0.5.3`.
