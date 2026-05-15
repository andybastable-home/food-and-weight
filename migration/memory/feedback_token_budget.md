---
name: feedback-token-budget
description: Pro-tier token discipline — no Playwright, no styles.css, no full-file reads by default
metadata:
  type: feedback
---

This project runs on Claude Pro with hard usage limits. Default behaviour:
- Do not call any `mcp__playwright__*` tool. Playwright MCP is uninstalled; UI verification is manual — describe what to check and let Andy run it.
- Do not read `styles.css` unless the task is visual styling.
- Do not read the root-level `01-*.png` … `07-*.png` spike screenshots as images.
- Read `STATUS.md` once per session, not on every turn.
- Grep before reading; only read a whole file once you know which one matters.
- Andy may run git operations himself to save tokens — don't auto-commit unless asked.

**Why:** Project moved from a LiteLLM unlimited setup to personal Claude Pro on 2026-05. The previous habit of liberal Playwright snapshots and full-file reads was the main cost driver and is no longer affordable.

**How to apply:** Mirrors the CLAUDE.md preamble — this is the durable copy in case CLAUDE.md drifts or is paraphrased away. If a future request would burn a lot of context (e.g. "check the whole UI"), push back with a narrower alternative before doing it.
