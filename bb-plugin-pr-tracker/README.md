# bb-plugin-pr-tracker

A BB plugin that lists your open GitHub pull requests with their Actions/check
status in a right-panel tab, with a Merge button.

## What it does

- Adds a **Pull requests** tab to the thread right panel.
- Lists open PRs grouped by repository, with a status dot:
  green (passing), red (failing), pulsing yellow (running), grey (no checks).
- Shows check counts and the names of failing checks.
- Refreshes every minute, or immediately with the refresh button.
- Enables **Merge** only when checks pass, the PR is not a draft, and GitHub
  reports it as mergeable. Confirming squash-merges the PR.

Reads use your local `gh` login. Only the merge mints the Claude Code GitHub
App bot token via `~/.claude/bin/gh-bot-token`, so the merge is attributed to
the bot. The token never reaches the frontend.

## Install

```sh
bb plugin install git:https://github.com/joshmuthumani/bb-plugins \
  --subdirectory bb-plugin-pr-tracker --yes
```

Versioned installs use per-plugin tags:

```sh
git tag pr-tracker-v0.1.0 && git push origin pr-tracker-v0.1.0

bb plugin install git:https://github.com/joshmuthumani/bb-plugins@0.1.0 \
  --subdirectory bb-plugin-pr-tracker --tag-prefix pr-tracker- --yes
```

## Configure

```sh
bb plugin config pr-tracker set repos "owner/repo,owner/repo"
```

The setting is a comma-separated allowlist: only those repositories are listed,
and only those can be merged into.

## Develop

```sh
npm install
npx tsc --noEmit
bb plugin build
bb plugin install .
```

`dist/` is committed because git installs load the prebuilt artifacts. Rebuild
and commit it after changing `server.ts` or `app.tsx`.
