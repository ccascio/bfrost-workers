# Daily Briefing

Turns your calendar, email, and message context into a focused daily briefing.

## What it does

Builds a concise summary of calendar, email, and message context from configured source endpoints.

The worker reads configured HTTPS source endpoints, optional operator context notes, and an optional Bearer token from environment variables. Each scheduled run asks the selected BFrost model to produce a concise operational report. If no model provider is configured, it still records a fallback digest from fetched source text.

## Inputs and outputs

- Integrations: Google Calendar, Gmail, Slack, or compatible export/API endpoints
- Job: `daily-briefing`
- Default schedule: `30 14 * * 1-5`
- Produces Item Bus items of type `briefing.digest` when publishing is enabled
- Stores settings and run history in worker-scoped KV

## Configure

In the BFrost Config tab, open **Daily Briefing sources** and set:

- **Source endpoints**: one API/export URL per line.
- **Bearer token env vars**: comma-separated environment variable names. The first one with a value is sent as `Authorization: Bearer ...`.
- **Context notes**: priorities, style preferences, account names, or pasted context.
- **Publish report to Item Bus**: whether each run should publish a queue item.

Example endpoints:

```text
https://www.googleapis.com/calendar/v3/calendars/primary/events
https://gmail.googleapis.com/gmail/v1/users/me/messages
https://slack.com/api/conversations.history?channel=C012345
```

Example context:

```text
My working hours are 09:00-18:00 Europe/Rome. Highlight meetings needing preparation and unanswered urgent messages.
```

## Run settings

In the Jobs tab, tune lookback hours, max items, priority threshold, schedule, model, and the prompt. The default prompt is intentionally editable so teams can adapt labels and tone without changing code.

## Permissions

- `network:https` to fetch configured source endpoints.
- `storage:worker-kv` to store settings, last-run summaries, and run history.

## Notes

This worker does not store secrets in `worker.json`. Put API tokens in local environment variables and reference their variable names in Config.
