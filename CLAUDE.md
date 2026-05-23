# Project notes for Claude

## Single user, single device

This app has **exactly one user (Andy) on exactly one device (his Pixel 8a)**. It is not a product, not multi-tenant, not multi-device. Desktop Chrome is dev only; the phone is the only deployment.

Implications:
- No user accounts, no settings for "other users", no role abstractions.
- No multi-device conflict resolution. Sync is one phone ↔ one Google Sheet.
- No onboarding flow, no empty-state copy aimed at strangers, no generic "welcome" UX. Andy already knows what the app does.
- Hard-coded assumptions about Andy's data shape (units, meal times, the specific Google Sheet) are fine and preferred over configurability.
- "What if a user…" edge cases that require a second user or device to trigger are **not real** and should not be coded for.

**Possible future exception:** Andy may eventually share this with a friend or two. That is unlikely, and if it happens it will be a deliberate scoped piece of work — not something to design for speculatively now. Build for one user; the multi-user version is a separate project.

## Primary surface: installed PWA on Android (Pixel 8a)

This app is **used as an installed PWA on Andy's Pixel 8a**, not as a desktop site. Desktop Chrome on Windows is for development and debugging only — it is not the deployment target.

Implications for every change:
- **Touch-first.** Tap targets ≥ 44px. No hover-only affordances. No right-click menus.
- **Mobile viewport.** Design for ~412px wide portrait. Don't add layouts that only make sense at desktop widths.
- **One-handed thumb reach.** Primary actions belong near the bottom of the screen, not the top.
- **Offline / flaky network is normal.** Anything that touches sync must degrade gracefully when offline. Service worker caching matters.
- **Mid-tier mobile perf.** Pixel 8a is capable but not a desktop. Don't ship large dependencies or heavy per-frame work.
- **PWA install flow matters.** Don't break `manifest.json` or the service worker registration without flagging it. Andy can't easily re-install.

When verifying UI work, the canonical test is "open it on the Pixel 8a installed PWA," not "open it in desktop Chrome." Desktop Chrome DevTools device emulation is acceptable for fast iteration but is not the final check.

## Code map

Tiny vanilla web app — no build step. Five source files. Skim this before grepping; only read whole files when the map points you there.

```
index.html         single page; header, footer, all overlays (settings, progress, skip)
app.js             ~2.4 kLOC — all UI, IndexedDB (Dexie), settings, charts
sync.js            ~1.0 kLOC — Google Sheets OAuth + sync, schema migrations
service-worker.js  network-first shell cache; bump CACHE_VERSION on every release
styles.css         design tokens + styles (don't open unless task is visual)
manifest.json      PWA manifest (don't touch without flagging)
icons/, assets/    static assets
.scripts/          export-context.ps1 (Gemini planner workflow)
notes/             design/auth learnings (e.g. auth-learnings.md) — read when relevant
```

### Inside `app.js`

Organized by `// ----` banner comments — grep the banner text to jump:

| Section banner                              | What's there                                                                 |
| ------------------------------------------- | ---------------------------------------------------------------------------- |
| `Service worker`                            | SW registration                                                              |
| `Database`                                  | Dexie schema v1→v3 + upgrades; `SHEET_SCHEMA_VERSION`; weekly-goal defaults  |
| `Type config`                               | `TYPES` map: food / weight / waist / workout / skip_food / measurements      |
| `Date / number helpers`                     | `startOfDay`, `addDays`, `getTimeCategory`, `TIME_CATEGORIES`, etc.          |
| `State + DOM refs`                          | `currentDate`, `currentTab`, `els` (cached DOM lookups)                      |
| `Data access`, `Actions`                    | Dexie reads/writes; `handleAdd`, `createSkipMarker`, `setDate`/`setTab`      |
| `AI estimation`                             | Gemini calls for food + workout                                              |
| `Frequent-items index`                      | uFuzzy local match for repeat foods (threshold 3, min query len 2)           |
| `Weekly goal`                               | `getGoal` / `setGoal` (localStorage)                                         |
| `Settings panel`                            | `initSettingsPanel`, goal preview, `computeMaintenanceTarget` (Mifflin × 1.2)|
| `Rendering`                                 | `renderEntryForm`, `renderEntries`, `renderCalorieTotal`, `buildCalRing`     |
| `Progress charts`                           | weight / calories / net-balance SVG charts; `CHART_W=360, CHART_H=190`       |
| `Weekly goal: pace tile + weekly deficit chart` | meal-curve partial-day scaling; `buildPaceTile`; `buildWeeklyDeficitChart` |
| `Init`                                      | `init()` (called at bottom of file)                                          |

### Inside `sync.js`

Top-of-file constants are the contract: `CLIENT_ID`, `SCOPE`, header arrays (`ENTRIES_HEADER_V{1,2,3}`), `ENTRIES_RANGE_*`, `DAILY_TARGETS_*`, `PROFILE_GOAL_RANGE` (`Metadata!A3:B8`) + `PROFILE_GOAL_KEY_TO_STORAGE`. Then OAuth (`ensureClient`/`requestToken`/`ensureFreshToken`), then per-tab ensurers (`ensureSheet`, `ensureAIContextSheet`, `ensureDailyTargetsSheet`), then schema migrations (`migrateSheetV1ToV2` … `V3ToV4`), then push/pull functions (`syncEntriesToSheet`, `pullEntriesFromSheet`, `pushProfileAndGoalToSheet`, …), then user actions (`actionConnect`/`actionRefresh`/`actionForget`) and `initOnLoad` at the bottom.

Schema-version gating: `SHEET_SCHEMA_VERSION` is the version this build understands; if a sheet reports higher, `schemaCompatible = false` and all Entries reads/writes stall to avoid corrupting a forward-versioned sheet.

### Data shape (quick reference)

- **IndexedDB** `FoodAndWeight` / store `entries`, keyed `++id` with unique `uuid`. Entry shape: `{ uuid, type, timestamp, text?, value?, calories?, timeCategory?, effort?, rawInput?, aiSuggestedTitle?, aiSuggestedCalories?, calorieSource?, calorieConfidence?, aiReasoning?, syncedAt? }`. Skip-day rows use `type: 'skip_food'` with reason in `text`.
- **Google Sheet — three tabs:**
  - `Entries` (cols A–P, v5 header) — see `ENTRIES_HEADER_V5`. Column P (`ai_reasoning`) holds Gemini's free-text explanation for review/calibration; blank on user-entered or pre-v5 rows.
  - `Metadata` — `A1/B1` schema version, `A2/B2` back-dating convention, `A3:B8` profile + weekly goal, plus AI-context rows below.
  - `DailyTargets` — `date, target_kcal, weight_avg_kg, window_days`. Maintenance kcal = Mifflin-St Jeor BMR × 1.2 (sedentary baseline; logged activity adds on top) from the 7-day trailing avg weight (the 7 calendar days strictly before the date).
- **`localStorage`** — sheet/auth (`fw.spike.sheetId`, `fw.spike.sheetGid`, `fw.spike.email`); AI context (`fw_gemini_context`, `fw_gemini_fitness_context`); ready-flags (`fw.aiContext.ready`, `fw.dailyTargets.ready`); profile + goal (`fw_cal_sex`, `fw_cal_age`, `fw_cal_height`, `fw_goal_kg_per_week`, `fw_goal_weekend_ratio`, `fw_goal_weekend_days`).
- **`sessionStorage`** — `fw.sync.token` (cached OAuth token across SW-triggered reloads).

### Maintaining this map

When you split a file, add a new top-level banner in `app.js`/`sync.js`, or change the storage shape, update this section. Don't add line numbers — they drift. Reference banners, function names, or constants instead.

## Working under a token budget

This project runs on Claude Pro with hard usage limits. Be deliberate about context.

- **No browser automation.** Playwright MCP is not installed and must not be re-introduced. UI verification is manual — describe what to check and Andy will run it in a browser and report back.
- **Don't read `styles.css` unless the task is visual styling.** It is ~14 KB of CSS that's irrelevant to sync/data work.
- **Read `STATUS.md` once per session, not repeatedly.** It is the source of truth for current phase + next steps.
- **Prefer Grep over reading whole files** when locating a symbol or string. Read the whole file only after you know which one matters.
- **No speculative refactors, no "while we're here" cleanup.** Do exactly what was asked.
- **Skip end-of-turn recap prose.** A one-line "done; STATUS updated" is enough.
- **Perform git operations** (commit and push) as the final step of every task. Don't wait to be asked — stage relevant files, commit with a clear message, and push. Andy drives git only if he says so explicitly.

## STATUS.md discipline

`STATUS.md` is loaded into context every session. Keep it lean:
- Current phase block + next 2–3 steps + open questions only.
- When a phase closes, archive the detail to a phase-specific note or just delete it — don't accrete.

## Versioning

**Bump the version with every commit.** This app is deployed as a PWA and version numbers are the primary way Andy confirms the correct build loaded on his phone during testing.

- Version lives in two places — always bump both in lockstep: `index.html` (the footer version pill) and `service-worker.js` (`CACHE_VERSION`). Missing one makes the displayed version and cached assets diverge.
- Use semver patch bumps (v0.5.1 → v0.5.2) for most changes; minor bumps (v0.5.x → v0.6.0) for significant feature milestones.

## Constraints

- **No paid subscriptions, ever.** This is a personal hobby project. Any solution that requires a paid plan (GitHub Pro, hosting tiers, paid APIs beyond free quotas, etc.) is off the table — find a free alternative or flag the constraint and ask. Free tiers of services (Gemini, Apps Script, GitHub Pages on public repos, Cloudflare/Netlify free) are fine.

## Gemini as planning agent

Andy occasionally (maybe regularly) uses Gemini Pro as a planning/context agent to maximize token efficiency across multiple models:

1. Run `.scripts/export-context.ps1` (PowerShell) to generate three `.aicontext` files (claude, website, misc) by category.
2. Paste the `.aicontext` files into Gemini as context (Gemini's 1M context window handles them easily).
3. Gemini plans the implementation (designs, pseudocode, API shapes, decision rationale).
4. Andy pastes the Gemini plan into a Claude conversation and Claude implements it (haiku/sonnet).

This workflow trades off: Gemini's context capacity for Claude's implementation speed, leveraging each model's strength. The `.aicontext` files are git-ignored and regenerated on demand.

## Repo

- Personal repo: `andybastable-home/food-and-weight` on github.com (public).
- Authenticated via SSH; the local clone uses whatever default key is configured for github.com on this machine.
