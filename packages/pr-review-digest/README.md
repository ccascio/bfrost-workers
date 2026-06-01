# PR Review Digest

Summarizes open PRs, review state, blockers, and the next reviews to do.

## What it does

Summarizes open pull requests, review status, blockers, and what needs attention.

The worker reads configured HTTPS source endpoints, optional operator context notes, and an optional Bearer token from environment variables. Each scheduled run asks the selected BFrost model to produce a concise operational report. If no model provider is configured, it still records a fallback digest from fetched source text.

The token setting intentionally asks for an environment variable name, not the token itself. Keep the actual GitHub token in the local BFrost `.env` file, then reference its name from Config.

## Inputs and outputs

- Integrations: GitHub pull request API or compatible code-review export endpoints
- Job: `pr-review-digest`
- Default schedule: `0 20 * * 1-5`
- Produces Item Bus items of type `dev.pr-review-digest` when publishing is enabled
- Stores settings and run history in worker-scoped KV

## Configure

In the BFrost Config tab, open **PR Review Digest sources** and set:

- **Source endpoints**: one API/export URL per line.
- **Bearer token env var names**: comma-separated environment variable names. For GitHub, this is usually `GITHUB_TOKEN`. Do not paste `GITHUB_TOKEN=...` here.
- **Context notes**: priorities, style preferences, account names, or pasted context.
- **Publish report to Item Bus**: whether each run should publish a queue item.

Example `.env`:

```text
GITHUB_TOKEN=github_pat_...
```

In Config, the matching value should be only:

```text
GITHUB_TOKEN
```

Example endpoints:

```text
https://api.github.com/repos/OWNER/REPO/pulls?state=open
https://api.github.com/repos/OWNER/REPO/pulls/123/reviews
```

Example context:

```text
Focus on PRs waiting on me, stale PRs, failing CI, requested changes, and risky large diffs.
```

## Run settings

In the Jobs tab, tune lookback hours, max items, priority threshold, schedule, model, and the prompt. The default prompt is intentionally editable so teams can adapt labels and tone without changing code.

## Permissions

- `network:https` to fetch configured source endpoints.
- `storage:worker-kv` to store settings, last-run summaries, and run history.

## Notes

This worker does not store secrets in `worker.json`, worker settings, or the store package. Put API tokens in local environment variables, reference their variable names in Config, and restart BFrost after editing `.env`.
