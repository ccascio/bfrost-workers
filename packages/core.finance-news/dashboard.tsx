const WORKER_ID = 'core.finance-news';
const JOB_ID = 'finance-news-scan';

function hostFromUrl(url: string): string {
  try {
    return new URL(url).host.replace(/^www\./, '');
  } catch {
    return url;
  }
}

function arrayOfStrings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
}

function FinanceNewsDashboard(ctx: any) {
  const { activeWorkerTab, dashboard, busyKey, triggerRun, formatDate, StatusPill, Detail } = ctx;
  const slice = dashboard?.workerData?.[WORKER_ID] ?? {};
  const job = (dashboard?.cron?.jobs ?? []).find((entry: any) => entry.name === JOB_ID || entry.workerId === WORKER_ID);
  const runs = (dashboard?.cron?.runs ?? []).filter((run: any) => run.job === JOB_ID);
  const latestRun = runs[0] ?? null;
  const recentItems = Array.isArray(slice.recentItems) ? slice.recentItems.slice(0, 12) : [];
  const queuedCount = recentItems.filter((item: any) => item.state === 'queued' || item.state === 'approved').length;

  return (
    <section className="grid worker-dashboard-grid tab-page">
      <article className="panel">
        <div className="panel-head">
          <div>
            <p className="panel-kicker">{activeWorkerTab?.worker?.name ?? 'Finance News'}</p>
            <h2>Scan output</h2>
          </div>
          <StatusPill tone={job?.enabled ? 'info' : 'muted'}>{job?.enabled ? 'Scheduled' : 'Paused'}</StatusPill>
        </div>
        <div className="detail-grid">
          <Detail label="Latest run" value={latestRun ? `${latestRun.status} - ${formatDate(latestRun.startedAt)}` : 'No run yet'} />
          <Detail label="Items in latest run" value={latestRun?.itemCount == null ? 'n/a' : String(latestRun.itemCount)} />
          <Detail label="Recent output" value={`${recentItems.length} items`} />
          <Detail label="Needs review" value={`${queuedCount} items`} />
        </div>
        {latestRun?.error ? <p className="error-text">{latestRun.error}</p> : null}
        <div className="panel-actions wrap">
          <button
            className="primary"
            disabled={busyKey === `run-${JOB_ID}` || job?.running}
            onClick={() => void triggerRun(`run-${JOB_ID}`, `/api/cron-jobs/${JOB_ID}/run`, 'Finance news scan started.')}
          >
            {job?.running ? 'Running...' : 'Run now'}
          </button>
          <span className="empty-state">Schedule, prompt, model, and watchlist live in Jobs.</span>
        </div>
      </article>

      <article className="panel">
        <div className="panel-head">
          <div>
            <p className="panel-kicker">Recent articles</p>
            <h2>What the cronjob found</h2>
          </div>
          <StatusPill tone={recentItems.length ? 'info' : 'muted'}>{recentItems.length} shown</StatusPill>
        </div>
        <div className="stack-list">
          {recentItems.map((item: any) => (
            <div className="queue-item" key={item.id}>
              <div className="queue-copy">
                <a href={item.url} target="_blank" rel="noreferrer"><strong>{item.title}</strong></a>
                <span className="queue-meta">
                  {arrayOfStrings(item.tickers).join(', ') || item.category || 'finance'} - {item.sourceHost || hostFromUrl(item.url)} - {formatDate(item.addedAt)}
                </span>
                <p>{item.relevanceReason || item.shortDesc}</p>
              </div>
              <StatusPill tone={item.state === 'failed' ? 'warning' : item.state === 'queued' ? 'info' : 'muted'}>{item.state}</StatusPill>
            </div>
          ))}
          {recentItems.length === 0 ? <p className="empty-state">No finance.news items have been queued yet.</p> : null}
        </div>
      </article>

      <article className="panel">
        <div className="panel-head">
          <div>
            <p className="panel-kicker">Guide</p>
            <h2>Reading the results</h2>
          </div>
        </div>
        <details className="detail-block" open={recentItems.length === 0}>
          <summary>What should I check after a run?</summary>
          <p>Confirm the latest run succeeded, then scan the recent articles list. Queued or approved items are available for downstream workers such as Finance Analyst.</p>
        </details>
        <details className="detail-block">
          <summary>Where do I change the watchlist?</summary>
          <p>Open Jobs, select Finance News Scan, then edit the watchlist, categories, schedule, model, and relevance prompt there.</p>
        </details>
        <details className="detail-block">
          <summary>Is this trading advice?</summary>
          <p>No. The worker collects and filters news for review. It does not recommend buying, selling, or holding any security.</p>
        </details>
      </article>
    </section>
  );
}

window.bfrost.registerDashboardView({
  workerId: WORKER_ID,
  kind: 'finance-news',
  surfaceIds: ['finance-news-dashboard'],
  menu: { icon: 'newspaper', group: 'Workers', order: 24, label: 'Finance News' },
  count: (ctx: any) => {
    const items = ctx.dashboard?.workerData?.[WORKER_ID]?.recentItems ?? [];
    return Array.isArray(items) ? items.length : undefined;
  },
  render: (ctx: any) => <FinanceNewsDashboard {...ctx} />,
});

declare global {
  interface Window {
    bfrost: {
      registerDashboardView: (view: any) => void;
      [key: string]: any;
    };
  }
}
