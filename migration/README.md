# New-machine setup

One-shot. After running these steps on the new PC, **delete this whole `migration/` folder** and commit the deletion.

## 1. Repo + SSH

Generate a fresh SSH key on the new machine and add the public half at https://github.com/settings/keys, then clone:

```bash
ssh-keygen -t ed25519 -C "<email>"
# add ~/.ssh/id_ed25519.pub to GitHub
git clone git@github.com:andybastable-home/food-and-weight.git
cd food-and-weight
```

`gh` (optional, only if you want PRs from CLI): `gh auth login` → GitHub.com → SSH.

## 2. Drop the project allowlist into place

`.claude/` is gitignored, so `settings.local.json` rides along here in `migration/` instead of inside `.claude/`. Copy it across:

```bash
mkdir -p .claude
cp migration/settings.local.json .claude/settings.local.json
```

This is the old machine's allowlist with the six `mcp__playwright__*` entries stripped.

## 3. Seed the Claude memory system

The memory directory is per-user-account, not in the repo. Find it after you've opened Claude Code in this project once (it'll be created automatically). On Windows it's roughly:

```
C:\Users\<you>\.claude\projects\C--<path-slug-of-this-repo>\memory\
```

Copy the contents of `migration/memory/` into there (six files: `MEMORY.md` + five individual memory files).

## 4. Verify

In Claude Code in this project:

1. Ask `where are we?` — should answer using `CLAUDE.md` + the seeded memory + `STATUS.md`, no `styles.css` or `app.js` reads.
2. Confirm Playwright is gone — there should be no `mcp__playwright__*` server registered (`claude mcp list` shows nothing for playwright).
3. `git status` should show `migration/` as deleted (after you remove it) plus a clean tree otherwise.

## 5. Clean up

```bash
git rm -r migration/
git commit -m "Remove migration scaffolding after new-PC setup"
git push
```
