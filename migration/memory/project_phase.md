---
name: project-phase
description: Current phase of the food-and-weight PWA — frame for what kind of work is in flight
metadata:
  type: project
---

Phase 3 — Google Sheets sync. The OAuth spike is complete and proven end-to-end on phone (silent re-auth via FedCM + stored email hint, scope `drive.file openid email`). Spike code lives standalone in `sync.js`. Real wiring into Dexie save/edit/delete hooks is the next block of work.

**Why:** Phase 1 (local PWA) and Phase 2 (multi-type entries + tabs) shipped. Sync was the blocker for using the app across devices, and OAuth on a PWA-in-WebView is the part that needed proving — that's now done.

**How to apply:** [[reference-status-md]] has the live next-step list, so don't re-derive it. This memory just sets the frame so a cold session knows what kind of work it's looking at without reading STATUS end-to-end.
