# PR Review Digest

Summarizes open PRs, review state, blockers, and the next reviews to do.

## What it does

Summarizes open pull requests, review status, blockers, and what needs attention.

The worker reads configured HTTPS source endpoints, optional operator context notes, and an optional Bearer token from environment variables. Each scheduled run asks the selected BFrost model to produce a concise operational report. If no model provider is configured, it still records a fallback digest from fetched source text.

## Inputs and outputs

- Integrations: GitHub pull request API or compatible code-review export endpoints
- Job: `pr-review-digest`
- Default schedule: `0 20 * * 1-5`
- Produces Item Bus items of type `dev.pr-review-digest` when publishing is enabled
- Stores settings and run history in worker-scoped KV

## Configure

In the BFrost Config tab, open **PR Review Digest sources** and set:

- **Source endpoints**: one API/export URL per line.
- **Bearer token env vars**: comma-separated environment variable names. The first one with a value is sent as `Authorization: Bearer ...`.
- **Context notes**: priorities, style preferences, account names, or pasted context.
- **Publish report to Item Bus**: whether each run should publish a queue item.

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

This worker does not store secrets in `worker.json`. Put API tokens in local environment variables and reference their variable names in Config.
