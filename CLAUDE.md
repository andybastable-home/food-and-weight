# Project notes for Claude

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

## Repo

- Personal repo: `andybastable-home/food-and-weight` on github.com (public).
- Authenticated via SSH; the local clone uses whatever default key is configured for github.com on this machine.
