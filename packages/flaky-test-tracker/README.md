# Flaky Test Tracker

Finds tests that pass and fail intermittently across recent CI runs.

## What it does

Tracks intermittent test failures across recent CI runs and highlights likely flaky tests.

The worker reads configured HTTPS source endpoints, optional operator context notes, and an optional Bearer token from environment variables. Each scheduled run asks the selected BFrost model to produce a concise operational report. If no model provider is configured, it still records a fallback digest from fetched source text.

## Inputs and outputs

- Integrations: GitHub Actions, CI exports, JUnit summaries, or compatible test-report endpoints
- Job: `flaky-test-tracker`
- Default schedule: `0 18 * * 1`
- Produces Item Bus items of type `dev.flaky-test-report` when publishing is enabled
- Stores settings and run history in worker-scoped KV

## Configure

In the BFrost Config tab, open **Flaky Test Tracker sources** and set:

- **Source endpoints**: one API/export URL per line.
- **Bearer token env vars**: comma-separated environment variable names. The first one with a value is sent as `Authorization: Bearer ...`.
- **Context notes**: priorities, style preferences, account names, or pasted context.
- **Publish report to Item Bus**: whether each run should publish a queue item.

Example endpoints:

```text
https://api.github.com/repos/OWNER/REPO/actions/runs?per_page=20
https://api.github.com/repos/OWNER/REPO/actions/runs/RUN_ID/jobs
```

Example context:

```text
Flag tests or suites that fail intermittently, especially if later reruns pass. Include workflow, branch, and failure pattern.
```

## Run settings

In the Jobs tab, tune lookback hours, max items, priority threshold, schedule, model, and the prompt. The default prompt is intentionally editable so teams can adapt labels and tone without changing code.

## Permissions

- `network:https` to fetch configured source endpoints.
- `storage:worker-kv` to store settings, last-run summaries, and run history.

## Notes

This worker does not store secrets in `worker.json`. Put API tokens in local environment variables and reference their variable names in Config.
