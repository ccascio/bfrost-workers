# System Health Check

Turns PagerDuty, Datadog, Sentry, and custom health signals into an operations status report.

## What it does

System Health Check queries connected monitoring services and reports:

1. Active incidents — ongoing outages or incidents with severity and status.
2. Errors and warnings — new errors or warning patterns since the last check.
3. Performance anomalies — unusual latency, error rates, or resource usage.
4. Resolved items — incidents or alerts resolved since the last check.

It prioritizes by severity and includes the affected service plus a direct link when the monitoring service provides one. If no issues are found, the worker reports `All systems nominal`.

The worker has built-in checks for PagerDuty, Datadog, and Sentry. Additional HTTPS source endpoints are optional and are only needed for status pages, internal exports, JSON/text snapshots, or monitoring tools that are not covered directly. If no monitoring credentials, custom endpoints, or context notes are available, the run reports `setup-needed`.

## Inputs and outputs

- Integrations: PagerDuty, Datadog, Sentry, status pages, or compatible health endpoints
- Job: `system-health-check`
- Default schedule: `0 14 * * *`
- Produces Item Bus items of type `ops.health-report` when publishing is enabled, including nominal reports
- Stores settings and run history in worker-scoped KV

## Configure

The worker uses environment variable names instead of storing token values in the Config form. This is intentional: PagerDuty, Datadog, and Sentry credentials are secrets, and BFrost should not copy those secrets into `worker.json`, dashboard state, logs, or store packages. The worker stores names like `DATADOG_API_KEY`; the real value lives in the local BFrost `.env` file and is read by `process.env` when the job runs.

Because `.env` is loaded when BFrost starts, restart BFrost after adding or changing these values.

### 1. Create provider credentials

- PagerDuty: create a REST API token with read access to incidents.
- Datadog: create an API key and an application key. Use a read-only role/user where possible; the worker reads monitors and alert events.
- Sentry: create an auth token with read access for organization/project/issues/events data, then note the organization slug and project slug.

Provider docs:

- PagerDuty API access keys: https://support.pagerduty.com/main/docs/api-access-keys
- Datadog API and application keys: https://docs.datadoghq.com/account_management/api-app-keys/
- Sentry authentication and scopes: https://docs.sentry.io/api/auth/ and https://docs.sentry.io/api/permissions/

### 2. Add values to BFrost `.env`

Edit `.env` in the BFrost project root and add only the services you use:

```text
PAGERDUTY_API_TOKEN=...
DATADOG_API_KEY=...
DATADOG_APP_KEY=...
SENTRY_AUTH_TOKEN=...
SENTRY_ORG=my-org
SENTRY_PROJECT=api
```

For multiple Sentry projects, put one project slug per line in the Config field instead of using `SENTRY_PROJECT`.

### 3. Match the names in Config

In the BFrost Config tab, open **System Health Check sources** and set:

- **PagerDuty token env var**: defaults to `PAGERDUTY_API_TOKEN`.
- **Datadog API/app key env vars**: defaults to `DATADOG_API_KEY` and `DATADOG_APP_KEY`.
- **Datadog API site**: defaults to `https://api.datadoghq.com`; use your regional Datadog site if needed.
- **Sentry token/org/projects**: defaults to `SENTRY_AUTH_TOKEN`, `SENTRY_ORG`, and `SENTRY_PROJECT` when fields are blank.
- **Additional health endpoints**: optional; one API/export/status URL per line for sources not covered by built-in connectors.
- **Context notes**: service priorities, manual incident context, or pasted summaries.
- **Publish report to Item Bus**: whether each run should publish a queue item.

The Config value must be the variable name, not the token. For example, if `.env` contains `DATADOG_API_KEY=abc123`, the Config field should contain `DATADOG_API_KEY`, not `abc123`.

### 4. Restart and run

Example context:

```text
Watch production, API latency, payment flows, and worker queues. Escalate customer-impacting issues first.
```

After saving `.env`, restart BFrost, open the System Health Check dashboard, and click **Run now**. If the result is `setup-needed`, check that at least one connector has both the required `.env` value and matching Config variable name.

## Run settings

In the Jobs tab, tune lookback hours, max issues, priority threshold, schedule, model, and the prompt. The first run uses the lookback window; later runs check from the previous run timestamp.

## Permissions

- `network:https` to fetch configured source endpoints.
- `storage:worker-kv` to store settings, last-run summaries, and run history.

## Notes

This worker does not store secrets in `worker.json`. Put API tokens in local environment variables and reference their variable names in Config.
