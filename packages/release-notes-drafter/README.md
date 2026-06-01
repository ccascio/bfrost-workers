# Release Notes Drafter

Turns merged PRs and changelog entries into clear user-facing release notes.

## What it does

Drafts user-facing release notes from merged PR or changelog source data.

The worker reads configured HTTPS source endpoints, optional operator context notes, and an optional Bearer token from environment variables. Each scheduled run asks the selected BFrost model to produce a concise operational report. If no model provider is configured, it still records a fallback digest from fetched source text.

## Inputs and outputs

- Integrations: GitHub merged PRs, changelog exports, or release feed endpoints
- Job: `release-notes-draft`
- Default schedule: `*/30 * * * *`
- Produces Item Bus items of type `release.notes-draft` when publishing is enabled
- Stores settings and run history in worker-scoped KV

## Configure

In the BFrost Config tab, open **Release Notes Drafter sources** and set:

- **Source endpoints**: one API/export URL per line.
- **Bearer token env vars**: comma-separated environment variable names. The first one with a value is sent as `Authorization: Bearer ...`.
- **Context notes**: priorities, style preferences, account names, or pasted context.
- **Publish report to Item Bus**: whether each run should publish a queue item.

Example endpoints:

```text
https://api.github.com/repos/OWNER/REPO/pulls?state=closed&sort=updated&direction=desc
https://api.github.com/repos/OWNER/REPO/releases/latest
```

Example context:

```text
Audience: product users, not engineers. Group by Added, Improved, Fixed, and Internal only when relevant.
```

## Run settings

In the Jobs tab, tune lookback hours, max items, priority threshold, schedule, model, and the prompt. The default prompt is intentionally editable so teams can adapt labels and tone without changing code.

## Permissions

- `network:https` to fetch configured source endpoints.
- `storage:worker-kv` to store settings, last-run summaries, and run history.

## Notes

This worker does not store secrets in `worker.json`. Put API tokens in local environment variables and reference their variable names in Config.
