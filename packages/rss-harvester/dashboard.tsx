function formatDate(value?: string | null): string {
  if (!value) return 'n/a';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

function RssDashboard(ctx: any) {
  const StatusPill = ctx.StatusPill;
  const Detail = ctx.Detail;
  const slice = ctx.dashboard?.workerData?.['rss-harvester'] ?? {};
  const config = slice.config ?? { feeds: '' };
  const feeds = Array.isArray(slice.feeds)
    ? slice.feeds
    : String(config.feeds ?? '').split('\n').map((line) => line.trim()).filter(Boolean);
  const recentItems = Array.isArray(slice.recentItems) ? slice.recentItems : [];
  const lastRun = slice.lastRun ?? null;
  const job = ctx.dashboard?.cron?.jobs?.find((entry: any) => entry.name === 'rss-fetch');
  const pendingCount = recentItems.filter((item: any) => item.state === 'queued' || item.state === 'approved').length;

  return (
    <>
      <section className="grid top-grid tab-page">
        <article className="panel">
          <div className="panel-head">
            <div>
              <p className="panel-kicker">RSS Harvester</p>
              <h2>Feed intake</h2>
            </div>
            <StatusPill tone={feeds.length > 0 ? 'good' : 'warning'}>
              {feeds.length > 0 ? `${feeds.length} feed${feeds.length === 1 ? '' : 's'}` : 'not configured'}
            </StatusPill>
          </div>
          <div className="detail-body">
            <div className="detail-grid">
              <Detail label="Job" value={job?.enabled ? 'enabled' : 'disabled'} />
              <Detail label="Cron" value={job?.cron ?? 'n/a'} />
              <Detail label="Recent items" value={String(recentItems.length)} />
              <Detail label="Actionable" value={String(pendingCount)} />
            </div>
          </div>
          <div className="panel-actions">
            <button
              type="button"
              disabled={ctx.busyKey === 'run-rss-fetch' || job?.running}
              onClick={() => ctx.triggerRun('run-rss-fetch', '/api/cron-jobs/rss-fetch/run', 'RSS fetch started.')}
            >
              {job?.running ? 'Running...' : 'Run now'}
            </button>
          </div>
        </article>

        <article className="panel">
          <div className="panel-head">
            <div>
              <p className="panel-kicker">Last run</p>
              <h2>{lastRun ? formatDate(lastRun.ranAt) : 'No run yet'}</h2>
            </div>
            <StatusPill tone={lastRun?.errors?.length ? 'warning' : lastRun ? 'info' : 'muted'}>
              {lastRun?.errors?.length ? `${lastRun.errors.length} issue${lastRun.errors.length === 1 ? '' : 's'}` : 'status'}
            </StatusPill>
          </div>
          {lastRun ? (
            <div className="detail-body">
              <div className="detail-grid">
                <Detail label="Feeds checked" value={String(lastRun.feedCount ?? 0)} />
                <Detail label="Published" value={String(lastRun.publishedCount ?? 0)} />
              </div>
              {lastRun.errors?.length ? (
                <div className="timeline">
                  {lastRun.errors.map((error: any) => (
                    <div className="timeline-event warning" key={`${error.feedUrl}-${error.message}`}>
                      <div>
                        <strong>{error.feedUrl}</strong>
                        <span>{error.message}</span>
                      </div>
                      <StatusPill tone="warning">warning</StatusPill>
                    </div>
                  ))}
                </div>
              ) : null}
            </div>
          ) : (
            <p className="empty-state">Run the job once or wait for the next schedule.</p>
          )}
        </article>
      </section>

      <section className="panel tab-page">
        <div className="panel-head">
          <div>
            <p className="panel-kicker">Recent items</p>
            <h2>Published to the Item Bus</h2>
          </div>
          <StatusPill tone="muted">{recentItems.length} items</StatusPill>
        </div>
        <div className="stack-list compact">
          {recentItems.map((item: any) => (
            <button
              className="summary-row"
              type="button"
              key={item.id}
              onClick={() => ctx.setSelectedQueueItemId?.(item.id)}
            >
              <div>
                <strong>{item.title}</strong>
                <span>{item.shortDesc}</span>
                <span>{formatDate(item.addedAt)}</span>
              </div>
              <StatusPill tone={ctx.queueItemTone ? ctx.queueItemTone(item.state) : 'muted'}>{item.state}</StatusPill>
            </button>
          ))}
          {recentItems.length === 0 ? <p className="empty-state">No RSS items have been published yet.</p> : null}
        </div>
      </section>
    </>
  );
}

window.bfrost.registerDashboardView({
  workerId: 'rss-harvester',
  kind: 'worker-dashboard',
  surfaceIds: ['rss-harvester-dashboard'],
  menu: {
    icon: 'rss',
    group: 'Workers',
    order: 35,
    label: 'RSS',
  },
  count: (ctx: any) => {
    const items = ctx.dashboard?.workerData?.['rss-harvester']?.recentItems ?? [];
    return Array.isArray(items)
      ? items.filter((item: any) => item.state === 'queued' || item.state === 'approved').length
      : undefined;
  },
  render: (ctx: any) => <RssDashboard {...ctx} />,
  queueItemDetail: (item: any) => {
    if (item?.producerWorkerId !== 'rss-harvester' && item?.payload?.feedUrl === undefined) return null;
    const feedUrl = item.payload?.feedUrl ?? item.payload?.source?.feedUrl;
    const publishedAt = item.payload?.publishedAt ?? item.payload?.article?.publishedAt;
    return (
      <div className="detail-section">
        <p className="panel-kicker">RSS provenance</p>
        <div className="detail-grid">
          {feedUrl ? <div className="detail"><span>Feed URL</span><strong>{feedUrl}</strong></div> : null}
          {publishedAt ? <div className="detail"><span>Published</span><strong>{formatDate(publishedAt)}</strong></div> : null}
        </div>
      </div>
    );
  },
});

declare global {
  interface Window {
    bfrost: {
      registerDashboardView: (view: any) => void;
      [key: string]: any;
    };
  }
}
