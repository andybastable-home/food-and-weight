# PWA / Google auth learnings

Hard-won gotchas from the Sheets-sync spikes. Not obvious from the code, so kept here.

- **PWA WebView cookie isolation**: `use_fedcm_for_prompt: true` + a stored `hint` (email) are both required for silent re-auth on Android.
- **`prompt: ''`** = silent if prior consent already granted; **`prompt: 'none'`** hangs silently — don't use it.
- **Cloud Console authorised origins**: only `https://andybastable-home.github.io` and `http://localhost:8000`.
- **`drive.file` scope persists across PWA uninstall + reinstall** for the same `client_id` — a fresh install can re-attach to a previously-created sheet by ID without re-picking. (Validated 2026-05-19 with v0.8.0 PC attach.)
