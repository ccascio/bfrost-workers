# Issue Triage

Reviews incoming issues and suggests priority, category, owner, and next action.

## What it does

Reviews incoming issues, bugs, and feature requests and recommends labels, priority, and ownership.

The worker reads configured HTTPS source endpoints, optional operator context notes, and an optional Bearer token from environment variables. Each scheduled run asks the selected BFrost model to produce a concise operational report. If no model provider is configured, it still records a fallback digest from fetched source text.

## Inputs and outputs

- Integrations: Linear, GitHub Issues, or compatible issue export/API endpoints
- Job: `issue-triage`
- Default schedule: `30 17 * * 1-5`
- Produces Item Bus items of type `issue.triage` when publishing is enabled
- Stores settings and run history in worker-scoped KV

## Configure

In the BFrost Config tab, open **Issue Triage sources** and set:

- **Source endpoints**: one API/export URL per line.
- **Bearer token env vars**: comma-separated environment variable names. The first one with a value is sent as `Authorization: Bearer ...`.
- **Context notes**: priorities, style preferences, account names, or pasted context.
- **Publish report to Item Bus**: whether each run should publish a queue item.

Example endpoints:

```text
https://api.linear.app/graphql
https://api.github.com/repos/OWNER/REPO/issues?state=open&since=YYYY-MM-DDTHH:MM:SSZ
```

Example context:

```text
Product areas: onboarding, billing, worker runtime, dashboard. Escalate regressions and customer-impacting bugs.
```

## Run settings

In the Jobs tab, tune lookback hours, max items, priority threshold, schedule, model, and the prompt. The default prompt is intentionally editable so teams can adapt labels and tone without changing code.

## Permissions

- `network:https` to fetch configured source endpoints.
- `storage:worker-kv` to store settings, last-run summaries, and run history.

## Notes

This worker does not store secrets in `worker.json`. Put API tokens in local environment variables and reference their variable names in Config.
