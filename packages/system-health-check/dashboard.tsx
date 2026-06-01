function formatDate(value?: string | null): string {
  if (!value) return 'n/a';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

function toneForPriority(priority: string): string {
  if (priority === 'urgent') return 'bad';
  if (priority === 'high') return 'warning';
  if (priority === 'medium') return 'info';
  return 'muted';
}

function toneForStatus(status?: string): string {
  if (status === 'ok') return 'good';
  if (status === 'setup-needed') return 'warning';
  if (status === 'error') return 'bad';
  if (status === 'partial') return 'warning';
  return 'muted';
}

function WorkerDashboard(ctx: any) {
  const StatusPill = ctx.StatusPill ?? ((props: any) => <span>{props.children}</span>);
  const Detail = ctx.Detail ?? ((props: any) => <div className="detail"><span>{props.label}</span><strong>{props.value}</strong></div>);
  const slice = ctx.dashboard?.workerData?.["system-health-check"] ?? {};
  const settings = slice.settings ?? {};
  const sourceCount = Number(slice.sourceCount ?? 0);
  const tokenConfigured = Boolean(slice.tokenConfigured);
  const lastRun = slice.lastRun ?? null;
  const history = Array.isArray(slice.history) ? slice.history : [];
  const items = Array.isArray(lastRun?.items) ? lastRun.items : [];
  const errors = Array.isArray(lastRun?.errors) ? lastRun.errors : [];
  const job = ctx.dashboard?.cron?.jobs?.find((entry: any) => entry.name === "system-health-check" || entry.id === "system-health-check");
  const integrationConfigured = Boolean(tokenConfigured);
  const readyLabel = integrationConfigured
    ? 'services configured'
    : sourceCount > 0
    ? String(sourceCount) + ' custom source' + (sourceCount === 1 ? '' : 's')
    : settings.contextNotes
    ? 'notes only'
    : 'setup needed';

  return (
    <>
      <section className="grid top-grid tab-page">
        <article className="panel">
          <div className="panel-head">
            <div><p className="panel-kicker">System Health Check</p><h2>{integrationConfigured || sourceCount > 0 || settings.contextNotes ? 'Ready to run' : 'Connect monitoring'}</h2></div>
            <StatusPill tone={integrationConfigured || sourceCount > 0 || settings.contextNotes ? 'good' : 'warning'}>{readyLabel}</StatusPill>
          </div>
          <div className="detail-body">
            <div className="detail-grid">
              <Detail label="Job" value={job?.enabled ? 'enabled' : 'disabled'} />
              <Detail label="Cron" value={job?.cron ?? "0 14 * * *"} />
              <Detail label="Integrations" value={integrationConfigured ? 'configured' : 'not detected'} />
              <Detail label="Publishes" value="ops.health-report" />
              <Detail label="Last status" value={lastRun?.status ?? 'n/a'} />
              <Detail label="Urgent" value={String(lastRun?.urgentCount ?? 0)} />
            </div>
            {settings.contextNotes ? <p className="empty-state" style={{ marginTop: '0.75rem' }}>{String(settings.contextNotes).slice(0, 220)}</p> : null}
          </div>
          <div className="panel-actions">
            <button type="button" disabled={ctx.busyKey === 'run-system-health-check' || job?.running} onClick={() => ctx.triggerRun?.('run-system-health-check', '/api/cron-jobs/system-health-check/run', 'System health check started.')}>
              {job?.running ? 'Running...' : 'Run now'}
            </button>
          </div>
        </article>

        <article className="panel">
          <div className="panel-head">
            <div><p className="panel-kicker">Last run</p><h2>{lastRun ? formatDate(lastRun.ranAt) : 'No run yet'}</h2></div>
            <StatusPill tone={toneForStatus(lastRun?.status)}>{lastRun?.status ?? 'idle'}</StatusPill>
          </div>
          {lastRun ? (
            <div className="detail-body">
              <p>{lastRun.summary}</p>
              <div className="detail-grid">
                <Detail label="Fetched" value={String(lastRun.fetchedCount ?? 0)} />
                <Detail label="Published" value={String(lastRun.publishedCount ?? 0)} />
                <Detail label="AI" value={lastRun.llmUsed ? 'used' : 'fallback'} />
                <Detail label="Errors" value={String(errors.length)} />
              </div>
              {errors.length ? <div className="timeline">{errors.map((error: any) => <div className="timeline-event warning" key={String(error.source) + String(error.message)}><div><strong>{error.source}</strong><span>{error.message}</span></div><StatusPill tone="warning">warning</StatusPill></div>)}</div> : null}
            </div>
          ) : <p className="empty-state">Run the job once or wait for the next schedule.</p>}
        </article>
      </section>

      <section className="panel tab-page">
        <div className="panel-head"><div><p className="panel-kicker">Output</p><h2>System health report</h2></div><StatusPill tone="muted">{items.length} items</StatusPill></div>
        <div className="stack-list compact">
          {items.map((item: any, index: number) => (
            <div className="summary-row" key={String(item.title) + index}>
              <div>
                <strong>{item.title}</strong>
                <span>{item.summary}</span>
                <span>{item.action}</span>
                {item.url ? <a href={item.url} target="_blank" rel="noreferrer">{item.url}</a> : null}
                {item.draft ? <pre style={{ whiteSpace: 'pre-wrap', marginTop: '0.5rem' }}>{item.draft}</pre> : null}
              </div>
              <StatusPill tone={toneForPriority(item.priority)}>{item.priority}</StatusPill>
            </div>
          ))}
          {items.length === 0 ? <p className="empty-state">No health findings have been produced yet.</p> : null}
        </div>
      </section>

      <section className="panel tab-page">
        <div className="panel-head"><div><p className="panel-kicker">History</p><h2>Recent runs</h2></div><StatusPill tone="muted">{history.length} runs</StatusPill></div>
        <div className="timeline">
          {history.map((run: any) => <div className={run.status === 'ok' ? 'timeline-event' : 'timeline-event warning'} key={run.ranAt}><div><strong>{formatDate(run.ranAt)}</strong><span>{run.summary}</span></div><StatusPill tone={toneForStatus(run.status)}>{run.status}</StatusPill></div>)}
          {history.length === 0 ? <p className="empty-state">No run history yet.</p> : null}
        </div>
      </section>

      <details className="panel tab-page worker-help-footer">
        <summary>About System Health Check</summary>
        <div className="detail-body">
          <p><strong>What it does</strong></p>
          <p>Checks connected monitoring services and writes a short health report covering active incidents, new errors or warnings, performance anomalies, and items resolved since the previous check. It is meant to answer "is anything on fire, what service is affected, and where should I click next?"</p>
          <p><strong>Why env vars are needed</strong></p>
          <p>PagerDuty, Datadog, and Sentry do not expose incident and monitoring data publicly. The worker needs read-only API credentials to call those services, but the Config form stores only environment variable names such as <code>DATADOG_API_KEY</code>. The secret values stay in your local BFrost <code>.env</code> file and are read only when the job runs.</p>
          <p><strong>Where to configure</strong></p>
          <ul><li><strong>Config tab</strong> - PagerDuty, Datadog, and Sentry environment variable names, optional custom endpoints, and operator context.</li><li><strong>Jobs tab</strong> - schedule, model, prompt, lookback window, item limit, and priority threshold.</li></ul>
          <p><strong>Inputs / outputs</strong></p><p>Reads PagerDuty, Datadog, Sentry, status pages, or compatible health endpoints. Produces <code>ops.health-report</code> items when publishing is enabled.</p>
          <p><strong>Are custom endpoints required?</strong></p>
          <p>No. Built-in connectors run when their credentials are present. Additional endpoints are only for status pages, internal exports, or monitoring tools that are not covered directly.</p>
          <p><strong>How to set it up</strong></p>
          <ol><li>Create read-only credentials in the provider console: PagerDuty REST API token, Datadog API key plus application key, and/or a Sentry auth token.</li><li>Add the secret values to <code>.env</code> in the BFrost project root.</li><li>Restart BFrost so the process can read the new environment values.</li><li>In Config, keep the default variable names or change them to match the names you added to <code>.env</code>.</li><li>Run the job once from the dashboard.</li></ol>
          <p><strong>Example .env</strong></p><pre style={{ fontSize: '0.8rem', background: 'var(--surface-2, #f5f5f5)', padding: '0.5rem', borderRadius: '4px', whiteSpace: 'pre-wrap' }}>{`PAGERDUTY_API_TOKEN=...
DATADOG_API_KEY=...
DATADOG_APP_KEY=...
SENTRY_AUTH_TOKEN=...
SENTRY_ORG=my-org
SENTRY_PROJECT=api`}</pre>
          <p><strong>FAQ</strong></p><p><em>Why did I get setup-needed?</em> The job could not find any usable monitoring credentials, custom endpoints, or context notes. Check that the variable names in Config exactly match the names in <code>.env</code>, then restart BFrost after editing <code>.env</code>.</p><p><em>What happens when everything is healthy?</em> The worker reports <strong>All systems nominal</strong> and publishes a low-noise health report when publishing is enabled.</p>
        </div>
      </details>
    </>
  );
}

window.bfrost.registerDashboardView({
  workerId: "system-health-check",
  kind: 'worker-dashboard',
  surfaceIds: ["system-health-check-dashboard"],
  menu: { icon: "activity", group: 'Workers', order: 60, label: "Health" },
  count: (ctx: any) => {
    const items = ctx.dashboard?.workerData?.["system-health-check"]?.lastRun?.items ?? [];
    return Array.isArray(items) ? items.filter((item: any) => item.priority === 'urgent' || item.priority === 'high').length : undefined;
  },
  render: (ctx: any) => <WorkerDashboard {...ctx} />,
  queueItemDetail: (item: any) => {
    if (item?.producerWorkerId !== "system-health-check" && item?.itemType !== "ops.health-report") return null;
    const payload = item.payload ?? {};
    const items = Array.isArray(payload.items) ? payload.items : [];
    return <div className="detail-section"><p className="panel-kicker">System Health Check</p><p>{payload.summary ?? item.shortDesc}</p><div className="detail-grid"><div className="detail"><span>Status</span><strong>{payload.status ?? 'n/a'}</strong></div><div className="detail"><span>Items</span><strong>{items.length}</strong></div><div className="detail"><span>Urgent</span><strong>{payload.urgentCount ?? 0}</strong></div></div></div>;
  },
});

declare global { interface Window { bfrost: { registerDashboardView: (view: any) => void; [key: string]: any } } }
