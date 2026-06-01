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
  const slice = ctx.dashboard?.workerData?.["briefing"] ?? {};
  const settings = slice.settings ?? {};
  const sourceCount = Number(slice.sourceCount ?? 0);
  const tokenConfigured = Boolean(slice.tokenConfigured);
  const lastRun = slice.lastRun ?? null;
  const history = Array.isArray(slice.history) ? slice.history : [];
  const items = Array.isArray(lastRun?.items) ? lastRun.items : [];
  const errors = Array.isArray(lastRun?.errors) ? lastRun.errors : [];
  const job = ctx.dashboard?.cron?.jobs?.find((entry: any) => entry.name === "daily-briefing" || entry.id === "daily-briefing");
  const readyLabel = sourceCount > 0 ? String(sourceCount) + ' source' + (sourceCount === 1 ? '' : 's') : settings.contextNotes ? 'notes only' : 'setup needed';

  return (
    <>
      <section className="grid top-grid tab-page">
        <article className="panel">
          <div className="panel-head">
            <div><p className="panel-kicker">Daily Briefing</p><h2>{sourceCount > 0 || settings.contextNotes ? 'Ready to run' : 'Configure sources'}</h2></div>
            <StatusPill tone={sourceCount > 0 || settings.contextNotes ? 'good' : 'warning'}>{readyLabel}</StatusPill>
          </div>
          <div className="detail-body">
            <div className="detail-grid">
              <Detail label="Job" value={job?.enabled ? 'enabled' : 'disabled'} />
              <Detail label="Cron" value={job?.cron ?? "30 14 * * 1-5"} />
              <Detail label="Token" value={tokenConfigured ? 'configured' : 'not detected'} />
              <Detail label="Publishes" value="briefing.digest" />
              <Detail label="Last status" value={lastRun?.status ?? 'n/a'} />
              <Detail label="Urgent" value={String(lastRun?.urgentCount ?? 0)} />
            </div>
            {settings.contextNotes ? <p className="empty-state" style={{ marginTop: '0.75rem' }}>{String(settings.contextNotes).slice(0, 220)}</p> : null}
          </div>
          <div className="panel-actions">
            <button type="button" disabled={ctx.busyKey === 'run-daily-briefing' || job?.running} onClick={() => ctx.triggerRun?.('run-daily-briefing', '/api/cron-jobs/daily-briefing/run', 'Daily briefing started.')}>
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
        <div className="panel-head"><div><p className="panel-kicker">Output</p><h2>Daily briefing</h2></div><StatusPill tone="muted">{items.length} items</StatusPill></div>
        <div className="stack-list compact">
          {items.map((item: any, index: number) => (
            <div className="summary-row" key={String(item.title) + index}>
              <div><strong>{item.title}</strong><span>{item.summary}</span><span>{item.action}</span>{item.draft ? <pre style={{ whiteSpace: 'pre-wrap', marginTop: '0.5rem' }}>{item.draft}</pre> : null}</div>
              <StatusPill tone={toneForPriority(item.priority)}>{item.priority}</StatusPill>
            </div>
          ))}
          {items.length === 0 ? <p className="empty-state">No briefing items have been produced yet.</p> : null}
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
        <summary>About Daily Briefing</summary>
        <div className="detail-body">
          <p><strong>What it does</strong></p><p>Builds a concise summary of calendar, email, and message context from configured source endpoints.</p>
          <p><strong>Where to configure</strong></p>
          <ul><li><strong>Config tab</strong> - source endpoints, bearer token environment variables, and operator context.</li><li><strong>Jobs tab</strong> - schedule, model, prompt, lookback window, item limit, and priority threshold.</li></ul>
          <p><strong>Inputs / outputs</strong></p><p>Reads Google Calendar, Gmail, Slack, or compatible export/API endpoints. Produces <code>briefing.digest</code> items when publishing is enabled.</p>
          <p><strong>Example setup</strong></p><pre style={{ fontSize: '0.8rem', background: 'var(--surface-2, #f5f5f5)', padding: '0.5rem', borderRadius: '4px', whiteSpace: 'pre-wrap' }}>https://www.googleapis.com/calendar/v3/calendars/primary/events
https://gmail.googleapis.com/gmail/v1/users/me/messages
https://slack.com/api/conversations.history?channel=C012345</pre>
          <p><strong>FAQ</strong></p><p><em>The report is too generic.</em> Configure an AI provider and add precise Context notes. Without a provider, the worker stores a fallback digest from fetched source text.</p>
        </div>
      </details>
    </>
  );
}

window.bfrost.registerDashboardView({
  workerId: "briefing",
  kind: 'worker-dashboard',
  surfaceIds: ["briefing-dashboard"],
  menu: { icon: "sun", group: 'Workers', order: 60, label: "Briefing" },
  count: (ctx: any) => {
    const items = ctx.dashboard?.workerData?.["briefing"]?.lastRun?.items ?? [];
    return Array.isArray(items) ? items.filter((item: any) => item.priority === 'urgent' || item.priority === 'high').length : undefined;
  },
  render: (ctx: any) => <WorkerDashboard {...ctx} />,
  queueItemDetail: (item: any) => {
    if (item?.producerWorkerId !== "briefing" && item?.itemType !== "briefing.digest") return null;
    const payload = item.payload ?? {};
    const items = Array.isArray(payload.items) ? payload.items : [];
    return <div className="detail-section"><p className="panel-kicker">Daily Briefing</p><p>{payload.summary ?? item.shortDesc}</p><div className="detail-grid"><div className="detail"><span>Status</span><strong>{payload.status ?? 'n/a'}</strong></div><div className="detail"><span>Items</span><strong>{items.length}</strong></div><div className="detail"><span>Urgent</span><strong>{payload.urgentCount ?? 0}</strong></div></div></div>;
  },
});

declare global { interface Window { bfrost: { registerDashboardView: (view: any) => void; [key: string]: any } } }
