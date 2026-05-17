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

## Working under a token budget

This project runs on Claude Pro with hard usage limits. Be deliberate about context.

- **No browser automation.** Playwright MCP is not installed and must not be re-introduced. UI verification is manual — describe what to check and Andy will run it in a browser and report back.
- **Don't read the spike PNG screenshots** at the repo root (`01-*.png` … `07-*.png` if they exist) as images. They are May-2026 spike artifacts and irrelevant to current work.
- **Don't read `styles.css` unless the task is visual styling.** It is ~14 KB of CSS that's irrelevant to sync/data work.
- **Read `STATUS.md` once per session, not repeatedly.** It is the source of truth for current phase + next steps.
- **Prefer Grep over reading whole files** when locating a symbol or string. Read the whole file only after you know which one matters.
- **No speculative refactors, no "while we're here" cleanup.** Do exactly what was asked.
- **Skip end-of-turn recap prose.** A one-line "done; STATUS updated" is enough.
- **Andy may run git commands manually** (commit/push) to save tokens. Don't auto-commit unless explicitly asked; when changes are ready, just say so and let him drive.

## STATUS.md discipline

`STATUS.md` is loaded into context every session. Keep it lean:
- Current phase block + next 2–3 steps + open questions only.
- When a phase closes, archive the detail to a phase-specific note or just delete it — don't accrete.

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
