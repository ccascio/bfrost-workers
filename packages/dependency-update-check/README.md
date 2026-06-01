# Dependency Update Check

Reviews dependency update feeds for security patches, outdated packages, and risky upgrades.

## What it does

Scans configured dependency/security endpoints for outdated packages, patches, and breaking-change risks.

The worker reads configured HTTPS source endpoints, optional operator context notes, and an optional Bearer token from environment variables. Each scheduled run asks the selected BFrost model to produce a concise operational report. If no model provider is configured, it still records a fallback digest from fetched source text.

## Inputs and outputs

- Integrations: GitHub Dependabot, OSV, npm registry, or compatible dependency export endpoints
- Job: `dependency-update-check`
- Default schedule: `30 20 * * 1`
- Produces Item Bus items of type `dev.dependency-report` when publishing is enabled
- Stores settings and run history in worker-scoped KV

## Configure

In the BFrost Config tab, open **Dependency Update Check sources** and set:

- **Source endpoints**: one API/export URL per line.
- **Bearer token env vars**: comma-separated environment variable names. The first one with a value is sent as `Authorization: Bearer ...`.
- **Context notes**: priorities, style preferences, account names, or pasted context.
- **Publish report to Item Bus**: whether each run should publish a queue item.

Example endpoints:

```text
https://api.github.com/repos/OWNER/REPO/dependabot/alerts
https://api.osv.dev/v1/querybatch
https://registry.npmjs.org/PACKAGE
```

Example context:

```text
Prioritize security updates, runtime dependencies, and packages used in production deploy paths. Flag likely breaking changes.
```

## Run settings

In the Jobs tab, tune lookback hours, max items, priority threshold, schedule, model, and the prompt. The default prompt is intentionally editable so teams can adapt labels and tone without changing code.

## Permissions

- `network:https` to fetch configured source endpoints.
- `storage:worker-kv` to store settings, last-run summaries, and run history.

## Notes

This worker does not store secrets in `worker.json`. Put API tokens in local environment variables and reference their variable names in Config.
