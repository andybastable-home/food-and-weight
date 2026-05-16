# AI calorie classification — design spike

> Written 2026-05-15 on Opus, intended as a reasoning gift for the Sonnet-driven implementation that follows. Captures the decisions and the verified API shape so the implementer doesn't have to re-derive them.
>
> **Updated 2026-05-16:** Model name (`gemini-2.5-flash-lite`) is current. When implementing Phase 4, check Google's published rate limits for the free tier — they may shift, but the decision to use the lite variant remains sound unless the constraints change materially.

## Goal

Two related capabilities to bolt onto the existing food entry flow:

1. **Text-only quick estimate.** User types something like `beans + 1 piece of toast`, taps a sparkle button, gets a calorie estimate that uses *what the system has previously learned about this user* ("a slice of bread for Andy is 80g home-baked sourdough", "a tin of beans means a half-tin in practice"). The estimate is editable before save.
2. **Multimodal portion estimate.** User snaps two photos — *what was made* (recipe / pot) and *what's in the bowl* — adds a weight (bowl content in grams) and a short description. The model estimates the calories of the served portion by reasoning about ingredients × portion fraction.

## Non-goals (v1)

- Automatic facts extraction from past entries / corrections — defer to v2 once the manual loop is shaping up.
- Macro splits (P/F/C). Calories only for v1.
- Backend / proxy. Pure client-side, user-supplied API key.
- Caching of model outputs. Each request is fresh.

---

## Architecture decisions

### Provider: Google Gemini, model `gemini-2.5-flash-lite`

**Why Gemini:** the no-paid-subs constraint rules out Claude/OpenAI. Gemini has a usable free tier and native multimodal in the same model — no separate vision step.

**Why 2.5-flash-lite specifically:**
- `gemini-2.0-flash` is being retired (June 2026 per Google's deprecation notice). Don't ship onto a dying model.
- Free-tier limits (Google's published numbers, March 2026): `2.5-flash-lite` = **15 RPM / 1000 RPD**, `2.5-flash` = 10 RPM / 250 RPD, `2.5-pro` = 5 RPM / 50 RPD. Lite has the most headroom and is more than fast enough for "user taps a button, waits 2s".
- Quality is sufficient for "rough calorie estimate from a description" — this isn't a frontier-model task.
- Upgrade path is trivial: change the model string. If lite turns out to under-perform on the multimodal portion task, swap to `2.5-flash` (still free, just tighter daily cap).

**Privacy caveat to call out in the UI:** Gemini's free tier reserves the right to use prompts/outputs for model improvement. Food descriptions + meal photos are mildly personal. A one-line disclosure in the AI settings panel is probably enough; this is a personal hobby app, not a regulated product.

### API key handling: user-supplied, localStorage

Same shape as the existing Sheets OAuth — the user brings their own credentials, the app never sees a server.

- Settings panel: "Gemini API key" text field. Get one at https://aistudio.google.com/app/apikey (free, no credit card needed).
- Stored in `localStorage` under `geminiApiKey`. Never synced to the Sheet.
- Without a key, the sparkle button is disabled with a tooltip pointing at the settings.
- No server-side validation of the key — first real request just succeeds or 403s, and the UI surfaces the error.

### Personal facts: a Dexie table the user curates manually

New Dexie store: `personalFacts`. Schema sketch:

```js
{
  id: <auto>,
  fact: 'A slice of my bread is 80g, home-baked sourdough',
  category: 'bread' | 'beans' | 'portion' | 'free' | ...,  // free-text tag, used for retrieval
  addedAt: timestamp,
  source: 'user' | 'ai-suggested',  // ai-suggested is v2; user-only for now
  active: boolean  // soft-delete so the user can disable without losing
}
```

Retrieval policy for v1: include **all active facts** in every request. They're short. If the count grows beyond ~30, switch to a category-keyed lookup (parse the user prompt for category keywords, include matching facts only).

Settings UI for facts: a simple list with add/edit/delete/toggle-active. No fancy AI extraction yet.

### Where this lives in the codebase

- `ai.js` — new file. Mirrors `sync.js`'s shape (one module, one responsibility, fully standalone). Exports: `estimateFromText({ description, facts, apiKey })`, `estimateFromPhotos({ description, weightGrams, recipePhoto, bowlPhoto, facts, apiKey })`.
- `app.js` — adds the sparkle button on the food-entry form, wires it to the `ai.js` calls, surfaces results into the existing entry-edit UI so the user can accept/edit before save.
- `index.html` — script tag for `ai.js`, settings affordance for the API key + the personal-facts CRUD.
- Dexie schema bump: add `personalFacts` store + `aiEstimated` (boolean) and `aiBreakdown` (JSON) optional columns on entries. Bump the Dexie version number; existing entries are untouched.

---

## Verified Gemini API shape

Both flows use the same endpoint with `responseMimeType: application/json` + a `responseSchema` so the model is forced to return parseable JSON.

### Endpoint

```
POST https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent?key={API_KEY}
Content-Type: application/json
```

### Common output schema

```json
{
  "calories": 0,
  "confidence": "high",
  "breakdown": [
    { "item": "string", "grams": 0, "calories": 0, "assumption": "string" }
  ],
  "questions": ["string"]
}
```

- `calories`: total estimate, rounded to nearest 10.
- `confidence`: `"high" | "medium" | "low"`. Low = the user really should review.
- `breakdown`: per-item rationale. Lets the user see what the model assumed and edit anything wrong.
- `questions`: when the model is uncertain in a way that asking would help, it puts the question(s) here. The UI shows them under the estimate; the user can answer, and the answer becomes a candidate `personalFact` (offered, not auto-saved).

`responseSchema` block to put in `generationConfig`:

```json
{
  "type": "OBJECT",
  "properties": {
    "calories":   { "type": "INTEGER" },
    "confidence": { "type": "STRING", "enum": ["high", "medium", "low"] },
    "breakdown": {
      "type": "ARRAY",
      "items": {
        "type": "OBJECT",
        "properties": {
          "item":       { "type": "STRING" },
          "grams":      { "type": "NUMBER" },
          "calories":   { "type": "INTEGER" },
          "assumption": { "type": "STRING" }
        },
        "required": ["item", "calories", "assumption"]
      }
    },
    "questions": { "type": "ARRAY", "items": { "type": "STRING" } }
  },
  "required": ["calories", "confidence", "breakdown", "questions"]
}
```

### System instruction (shared base)

```
You are a calorie estimator embedded in a personal food-tracking PWA. Your single
user is one specific person; treat the personal facts below as ground truth about
their habits, portions, and ingredients — they override generic assumptions.

Output STRICTLY the JSON schema you have been given. No prose outside it.

Calibration rules:
- Round calorie totals to the nearest 10.
- Use confidence:"high" only when the personal facts cover the major variables.
  Use "medium" for typical home-cooked items where you've made one or two
  reasonable assumptions. Use "low" when you're guessing at a major variable
  (portion size, fat content, recipe composition).
- The breakdown must add up to within 5% of the total. If not, redo.
- Use the questions array sparingly — only when the answer would meaningfully
  shift the estimate AND the user could plausibly answer it. Maximum 2 questions.
  Don't ask about anything already covered by a personal fact.
- Never invent personal facts. If there's no fact about a food, fall back to
  generic averages and say so in the assumption field.

Personal facts:
{FACTS}
```

`{FACTS}` is filled at request time — one bullet per active fact:
```
- A slice of my bread is 80g, home-baked sourdough
- A tin of beans (Heinz) is 415g, but I usually eat half a tin
- "A bowl of porridge" for me means 50g oats dry weight + 250ml semi-skimmed milk
```

### Flow 1 — text-only request body

```json
{
  "systemInstruction": { "parts": [{ "text": "<system instruction with facts inlined>" }] },
  "contents": [{
    "role": "user",
    "parts": [{ "text": "beans + 1 piece of toast" }]
  }],
  "generationConfig": {
    "responseMimeType": "application/json",
    "responseSchema": { "...as above..." }
  }
}
```

### Flow 2 — multimodal request body (recipe photo + bowl photo)

```json
{
  "systemInstruction": { "parts": [{ "text": "<system instruction with facts inlined>" }] },
  "contents": [{
    "role": "user",
    "parts": [
      { "text": "PHOTO 1 = the whole pot of what was made. PHOTO 2 = my serving in a bowl. Bowl content weighs 380g. Description: lentil + sweet potato curry, made roughly to my usual recipe." },
      { "inline_data": { "mime_type": "image/jpeg", "data": "<base64 of recipe pic>" } },
      { "inline_data": { "mime_type": "image/jpeg", "data": "<base64 of bowl pic>" } }
    ]
  }],
  "generationConfig": {
    "responseMimeType": "application/json",
    "responseSchema": { "...as above..." }
  }
}
```

A small wrapper in `ai.js` resizes the photos before base64-encoding. Phone-sized JPEGs at original resolution are a few MB each; we want them under ~1 MB combined to be polite to the rate-limit token budget. A long edge of 1024px at JPEG quality 0.85 is plenty for the model to count peas. **Do not send PNG** for photos — JPEG at q=0.85 is half the bytes for the same model usefulness.

The 20 MB total request size is a hard ceiling Google enforces; with two resized JPEGs we'll be far under it, but the ai.js wrapper should still throw a clear error if a single image is over (e.g.) 4 MB before encoding.

### Multimodal prompting note (the bit that's easy to get wrong)

The model needs to know **which photo is which**. The order of `parts` matters: the text part that labels the photos should come *before* the photos, and the labels should match the order the photos appear ("PHOTO 1 = ...", "PHOTO 2 = ..."). This is how the Gemini docs do it and it's reliable.

Don't ask the model to do exact gram-counting from photos — it's not what it's good at. Frame the multimodal task as: *here's what was cooked (photo 1, qualitative — what's in it), here's the served portion (photo 2, qualitative — how much of the pot it looks like), and here's the actual served weight (text, authoritative — 380g).* The model uses photo 1 to identify ingredients, photo 2 + the weight to anchor the portion size, and reasons about calorie density from the ingredient mix.

---

## Open questions to resolve before implementation

These are decisions the implementer will hit. Captured here so they don't have to be re-discovered:

1. **Where does the sparkle button live?** Options: (a) inline in the food entry text field, like a magic-wand suffix; (b) separate "AI estimate" toggle that swaps the calorie field for an AI-driven mini-flow. Lean toward (a) — keeps the flow one-tap.

2. **Should the AI estimate replace the user's calorie field on accept, or live alongside?** Lean toward replace, with `aiEstimated: true` flagged on the entry so it's visible in history (e.g. small ✨ marker).

3. **What happens if the user edits the AI estimate?** Save the edit + the original AI estimate side by side. Useful raw material for v2 self-improvement.

4. **Personal facts seed.** Should the app ship with a "starter facts" prompt the first time the user enables AI? Probably not — let it stay empty until the user adds one, and surface a "looks like you'd benefit from a fact about X" hint when the AI's `questions` array fires repeatedly on the same topic. (That hint is v2; v1 is just the manual CRUD.)

5. **Multimodal: one photo or two?** Two is the goal but the UI should also accept just one (just the bowl, no recipe). The system instruction handles this fine — the model will lower confidence and use the questions array.

6. **Rate-limit handling.** 1000 RPD is generous for one user but not infinite. The UI should track requests-today in localStorage and warn at 80%. A 429 from Google should surface as a clear "you've hit today's free quota; try again after midnight Pacific" message, not a generic error.

7. **Cost of being wrong.** When the model returns `confidence: "low"`, the UI should be visually obvious about it (yellow border, "double-check this" copy). Trust calibration is a feature, not a backstop.

---

## What to build first (suggested order for the Sonnet-driven implementation)

Each step is committable / shippable on its own.

1. **Standalone `spike-ai.html`** at repo root (gitignored or deleted after) — a textarea + key field + JSON output. Just enough to verify the request shape works end-to-end with a real key against the real API. Don't move to step 2 until this returns clean JSON for both flows.
2. **`ai.js`** module with `estimateFromText` only. Hard-code an empty facts list. Wire to a "✨ Estimate" button on the existing food entry form. Show the JSON result raw under the form. Ship.
3. **Personal facts CRUD.** New Dexie store, settings panel, plumbed into `estimateFromText`. Ship.
4. **Result UI polish.** Render the breakdown nicely; surface the questions; let the user accept/edit/discard. Ship.
5. **Multimodal `estimateFromPhotos`.** Add the photo capture inputs. Image resize util. New code path through the same accept/edit UI. Ship.
6. **Daily-quota counter + 429 handling.** Ship.

Anything beyond step 6 (auto-fact-extraction, macro splits, history-aware adjustments) is v2 and explicitly out of scope here.

---

## Sources for the API specifics

- [Gemini structured outputs (responseSchema)](https://ai.google.dev/gemini-api/docs/structured-output)
- [Gemini image understanding (inline_data shape)](https://ai.google.dev/gemini-api/docs/image-understanding)
- [Gemini API rate limits (free tier numbers)](https://ai.google.dev/gemini-api/docs/rate-limits)
