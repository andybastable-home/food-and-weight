# Project notes for Claude

## Constraints

- **No paid subscriptions, ever.** This is a personal hobby project. Any solution that requires a paid plan (GitHub Pro, hosting tiers, paid APIs beyond free quotas, etc.) is off the table — find a free alternative or flag the constraint and ask. Free tiers of services (Gemini, Apps Script, GitHub Pages on public repos, Cloudflare/Netlify free) are fine.

## Repo

- Personal repo: `andybastable-home/food-and-weight` on github.com (public).
- SSH key for this repo is `~/.ssh/github_home_laptop` — already wired via repo-local `core.sshCommand`.
- The `gh` CLI on this machine is authed against Unity's internal GitHub host, **not** github.com. Don't run `gh` commands that assume github.com without first confirming auth, and never re-auth in a way that would clobber the Unity credentials.
