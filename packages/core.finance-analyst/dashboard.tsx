const WORKER_ID = 'core.finance-analyst';
const JOB_ID = 'finance-analysis';

function arrayOfStrings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
}

function FinanceAnalystDashboard(ctx: any) {
  const { activeWorkerTab, dashboard, busyKey, triggerRun, formatDate, StatusPill, Detail } = ctx;
  const slice = dashboard?.workerData?.[WORKER_ID] ?? {};
  const job = (dashboard?.cron?.jobs ?? []).find((entry: any) => entry.name === JOB_ID || entry.workerId === WORKER_ID);
  const runs = (dashboard?.cron?.runs ?? []).filter((run: any) => run.job === JOB_ID);
  const latestRun = runs[0] ?? null;
  const analysedItems = Array.isArray(slice.analysedItems) ? slice.analysedItems.slice(0, 12) : [];
  const pendingCount = typeof slice.pendingCount === 'number' ? slice.pendingCount : 0;

  return (
    <section className="grid worker-dashboard-grid tab-page">
      <article className="panel">
        <div className="panel-head">
          <div>
            <p className="panel-kicker">{activeWorkerTab?.worker?.name ?? 'Finance Analyst'}</p>
            <h2>Analysis output</h2>
          </div>
          <StatusPill tone={job?.enabled ? 'info' : 'muted'}>{job?.enabled ? 'Scheduled' : 'Paused'}</StatusPill>
        </div>
        <div className="detail-grid">
          <Detail label="Latest run" value={latestRun ? `${latestRun.status} - ${formatDate(latestRun.startedAt)}` : 'No run yet'} />
          <Detail label="Analysed in latest run" value={latestRun?.itemCount == null ? 'n/a' : String(latestRun.itemCount)} />
          <Detail label="Recent reads" value={`${analysedItems.length} items`} />
          <Detail label="Pending finance.news" value={`${pendingCount} items`} />
        </div>
        {latestRun?.error ? <p className="error-text">{latestRun.error}</p> : null}
        <div className="panel-actions wrap">
          <button
            className="primary"
            disabled={busyKey === `run-${JOB_ID}` || job?.running}
            onClick={() => void triggerRun(`run-${JOB_ID}`, `/api/cron-jobs/${JOB_ID}/run`, 'Finance analysis started.')}
          >
            {job?.running ? 'Running...' : 'Run now'}
          </button>
          <span className="empty-state">Schedule, prompt, model, and investor lens live in Jobs.</span>
        </div>
      </article>

      <article className="panel">
        <div className="panel-head">
          <div>
            <p className="panel-kicker">Recent reads</p>
            <h2>What the analyst wrote</h2>
          </div>
          <StatusPill tone={analysedItems.length ? 'info' : 'muted'}>{analysedItems.length} shown</StatusPill>
        </div>
        <div className="stack-list">
          {analysedItems.map((item: any) => (
            <div className="queue-item" key={item.id}>
              <div className="queue-copy">
                <a href={item.url} target="_blank" rel="noreferrer"><strong>{item.title}</strong></a>
                <span className="queue-meta">
                  {arrayOfStrings(item.tickers).join(', ') || 'finance'} - {item.direction}/{item.magnitude} - {formatDate(item.analyzedAt || item.addedAt)}
                </span>
                <p>{item.mechanism || item.note || item.shortDesc}</p>
                {item.pricedIn ? <span className="queue-reason">Priced in: {item.pricedIn}; confidence: {item.confidence}; horizon: {item.horizon}</span> : null}
              </div>
              <StatusPill tone={item.direction === 'down' ? 'warning' : item.direction === 'up' ? 'info' : 'muted'}>{item.direction}</StatusPill>
            </div>
          ))}
          {analysedItems.length === 0 ? <p className="empty-state">No finance.news items have been analysed yet.</p> : null}
        </div>
      </article>

      <article className="panel">
        <div className="panel-head">
          <div>
            <p className="panel-kicker">Guide</p>
            <h2>Reading the reads</h2>
          </div>
        </div>
        <details className="detail-block" open={analysedItems.length === 0}>
          <summary>What does the analyst add?</summary>
          <p>It attaches a structured, informational read to each finance.news item: direction, magnitude, horizon, confidence, priced-in risk, and mechanism.</p>
        </details>
        <details className="detail-block">
          <summary>Why are items pending?</summary>
          <p>Pending items are finance.news articles that have not yet received this worker's metadata. Run the job manually or enable its schedule in Jobs.</p>
        </details>
        <details className="detail-block">
          <summary>Is this trading advice?</summary>
          <p>No. The read is a summary of likely market impact and uncertainty based on the article text only.</p>
        </details>
      </article>
    </section>
  );
}

window.bfrost.registerDashboardView({
  workerId: WORKER_ID,
  kind: 'finance-analyst',
  surfaceIds: ['finance-analyst-dashboard'],
  menu: { icon: 'line-chart', group: 'Workers', order: 25, label: 'Finance Analyst' },
  count: (ctx: any) => {
    const items = ctx.dashboard?.workerData?.[WORKER_ID]?.analysedItems ?? [];
    return Array.isArray(items) ? items.length : undefined;
  },
  render: (ctx: any) => <FinanceAnalystDashboard {...ctx} />,
});

declare global {
  interface Window {
    bfrost: {
      registerDashboardView: (view: any) => void;
      [key: string]: any;
    };
  }
}
