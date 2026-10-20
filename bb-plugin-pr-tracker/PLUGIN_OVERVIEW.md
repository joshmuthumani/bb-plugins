Review and merge pull requests without leaving BB.

## What you get

- A **Pull requests** tab in the thread right panel.
- Every open PR in your configured repositories, grouped by repo.
- Live check status: passing, failing, running, or none, with failing check
  names listed inline.
- A Merge button that stays disabled until checks are green, the PR is not a
  draft, and GitHub reports no conflicts. Confirming performs a squash merge.
- A refresh button plus a one-minute automatic refresh.

## How it works

The plugin shells out to the `gh` CLI using your existing GitHub login to read
PRs and check runs. Merges use the Claude Code GitHub App bot token, minted on
the server for the target repository, so the merge is attributed to the bot
rather than your user account. The bot token never leaves the server process.

Only repositories in the `repos` setting are listed, and the server re-checks
that allowlist and every merge condition before merging.

## Requirements

- The `gh` CLI, authenticated locally.
- `~/.claude/bin/gh-bot-token` for bot-attributed merges.
- Branch protection that permits the bot to merge (otherwise GitHub will
  reject the merge even when checks pass).
