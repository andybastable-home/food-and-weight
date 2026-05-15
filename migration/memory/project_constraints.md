---
name: project-constraints
description: Hard constraints on this hobby project — no paid services, OAuth client ID is public-by-design
metadata:
  type: project
---

No paid subscriptions, ever — free tiers only. The OAuth client ID is committed in `sync.js` and is intentionally a public identifier (token client doesn't use a client secret in the browser). Authorised JS origins on the Google Cloud Console "Food and Weight" project are exactly two: `https://andybastable-home.github.io` and `http://localhost:8000`.

**Why:** Personal hobby project, not a product. Public OAuth client IDs are the standard pattern for SPA / PWA flows.

**How to apply:** Reject any suggestion that needs a paid plan and propose a free alternative. If local dev needs a port other than 8000, flag it — Andy needs to add the origin in the Cloud Console manually. Never suggest moving the client ID out of source.
