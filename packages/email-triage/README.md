# Email Triage

Sorts inbox items by urgency and drafts replies for messages that need a fast response.

## What it does

Categorizes and prioritizes inbox context, with draft responses for urgent items.

The worker reads configured HTTPS source endpoints, optional operator context notes, and an optional Bearer token from environment variables. Each scheduled run asks the selected BFrost model to produce a concise operational report. If no model provider is configured, it still records a fallback digest from fetched source text.

## Inputs and outputs

- Integrations: Gmail or compatible inbox export/API endpoints
- Job: `email-triage`
- Default schedule: `0 17 * * 1-5`
- Produces Item Bus items of type `email.triage` when publishing is enabled
- Stores settings and run history in worker-scoped KV

## Configure

In the BFrost Config tab, open **Email Triage sources** and set:

- **Source endpoints**: one API/export URL per line.
- **Bearer token env vars**: comma-separated environment variable names. The first one with a value is sent as `Authorization: Bearer ...`.
- **Context notes**: priorities, style preferences, account names, or pasted context.
- **Publish report to Item Bus**: whether each run should publish a queue item.

Example endpoints:

```text
https://gmail.googleapis.com/gmail/v1/users/me/messages?q=newer_than:2d
https://api.example.com/inbox/export.json
```

Example context:

```text
Prioritize customer issues, finance/legal requests, and anything blocking today. Draft replies in my concise style.
```

## Run settings

In the Jobs tab, tune lookback hours, max items, priority threshold, schedule, model, and the prompt. The default prompt is intentionally editable so teams can adapt labels and tone without changing code.

## Permissions

- `network:https` to fetch configured source endpoints.
- `storage:worker-kv` to store settings, last-run summaries, and run history.

## Notes

This worker does not store secrets in `worker.json`. Put API tokens in local environment variables and reference their variable names in Config.
