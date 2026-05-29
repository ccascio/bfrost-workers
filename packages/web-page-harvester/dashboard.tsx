function formatDate(value?: string | null): string {
  if (!value) return 'n/a';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

function WebPageGuide() {
  return (
    <details className="panel tab-page worker-help-footer">
      <summary>
        <span className="panel-kicker">Guide</span>
        <strong>How to use Web Page Harvester</strong>
      </summary>
      <div className="detail-body">
        <div className="detail-grid">
          <div className="detail-block">
            <span>What it does</span>
            <p>
              Fetches a list of pages and publishes changed content to the Item Bus as <code>web.page</code> items.
              Markdown Notes can consume those items if you add <code>web.page</code> to its item types.
            </p>
          </div>
          <div className="detail-block">
            <span>Where to configure it</span>
            <p>
              Open Jobs, select <strong>Fetch web pages</strong>, then add page URLs, schedule, max pages per run,
              refetch spacing, and optional tags.
            </p>
          </div>
          <div className="detail-block">
            <span>Example setup</span>
            <p>
              Add one product changelog, one docs page, and one competitor page. Run every 6 hours, keep max pages at 5,
              and set the minimum hours between checks to 24.
            </p>
          </div>
          <div className="detail-block">
            <span>FAQ</span>
            <p>
              No new items? The page may be unchanged or still inside the refetch window. Use 0 hours to force a check
              on every run while testing.
            </p>
          </div>
        </div>
      </div>
    </details>
  );
}

function WebPageDashboard(ctx: any) {
  const StatusPill = ctx.StatusPill ?? ((props: any) => <span>{props.children}</span>);
  const Detail = ctx.Detail ?? ((props: any) => <div className="detail"><span>{props.label}</span><strong>{props.value}</strong></div>);
  const slice = ctx.dashboard?.workerData?.['web-page-harvester'] ?? {};
  const pages = Array.isArray(slice.recentPages) ? slice.recentPages : [];
  const lastRun = slice.lastRun ?? null;
  const job = ctx.dashboard?.cron?.jobs?.find((entry: any) => entry.name === 'web-page-fetch');

  return (
    <>
      <section className="grid top-grid tab-page">
        <article className="panel">
          <div className="panel-head">
            <div>
              <p className="panel-kicker">Web Page Harvester</p>
              <h2>{lastRun ? 'Page intake' : 'Ready to fetch pages'}</h2>
            </div>
            <StatusPill tone={lastRun?.errors?.length ? 'warning' : 'good'}>{lastRun?.errors?.length ? 'check run' : 'ready'}</StatusPill>
          </div>
          <div className="detail-body">
            <div className="detail-grid">
              <Detail label="Job" value={job?.enabled ? 'enabled' : 'disabled'} />
              <Detail label="Recent pages" value={String(pages.length)} />
            </div>
          </div>
          <div className="panel-actions">
            <button
              type="button"
              disabled={ctx.busyKey === 'run-web-page-fetch' || job?.running}
              onClick={() => ctx.triggerRun('run-web-page-fetch', '/api/cron-jobs/web-page-fetch/run', 'Web page fetch started.')}
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
            <StatusPill tone={lastRun?.errors?.length ? 'warning' : lastRun ? 'info' : 'muted'}>status</StatusPill>
          </div>
          {lastRun ? (
            <div className="detail-body">
              <div className="detail-grid">
                <Detail label="Fetched" value={String(lastRun.fetchedCount ?? 0)} />
                <Detail label="Published" value={String(lastRun.publishedCount ?? 0)} />
                <Detail label="Skipped" value={String(lastRun.skippedCount ?? 0)} />
              </div>
              {Array.isArray(lastRun.errors) && lastRun.errors.length ? (
                <div className="timeline">
                  {lastRun.errors.map((error: any) => (
                    <div className="timeline-event warning" key={`${error.url}-${error.message}`}>
                      <div><strong>{error.url}</strong><span>{error.message}</span></div>
                      <StatusPill tone="warning">warning</StatusPill>
                    </div>
                  ))}
                </div>
              ) : null}
            </div>
          ) : (
            <p className="empty-state">Configure page URLs in Jobs, then run once or enable the schedule.</p>
          )}
        </article>
      </section>

      <section className="panel tab-page">
        <div className="panel-head">
          <div>
            <p className="panel-kicker">Recent pages</p>
            <h2>Published to the Item Bus</h2>
          </div>
          <StatusPill tone="muted">{pages.length} pages</StatusPill>
        </div>
        <div className="stack-list compact">
          {pages.map((item: any) => (
            <button className="summary-row" type="button" key={item.id} onClick={() => ctx.setSelectedQueueItemId?.(item.id)}>
              <div>
                <strong>{item.title}</strong>
                <span>{item.shortDesc}</span>
                <span>{formatDate(item.addedAt)}</span>
              </div>
              <StatusPill tone={ctx.queueItemTone ? ctx.queueItemTone(item.state) : 'muted'}>{item.state}</StatusPill>
            </button>
          ))}
          {pages.length === 0 ? <p className="empty-state">No web pages have been published yet.</p> : null}
        </div>
      </section>

      <WebPageGuide />
    </>
  );
}

window.bfrost.registerDashboardView({
  workerId: 'web-page-harvester',
  kind: 'worker-dashboard',
  surfaceIds: ['web-page-harvester-dashboard'],
  menu: {
    icon: 'globe',
    group: 'Workers',
    order: 39,
    label: 'Web Pages',
  },
  count: (ctx: any) => {
    const items = ctx.dashboard?.workerData?.['web-page-harvester']?.recentPages ?? [];
    return Array.isArray(items) ? items.filter((item: any) => item.state === 'queued' || item.state === 'approved').length : undefined;
  },
  render: (ctx: any) => <WebPageDashboard {...ctx} />,
  queueItemDetail: (item: any) => {
    if (item?.producerWorkerId !== 'web-page-harvester') return null;
    const payload = item.payload ?? {};
    return (
      <div className="detail-section">
        <p className="panel-kicker">Web page</p>
        <div className="detail-grid">
          {payload.finalUrl ? <div className="detail"><span>URL</span><strong>{payload.finalUrl}</strong></div> : null}
          {payload.fetchedAt ? <div className="detail"><span>Fetched</span><strong>{formatDate(payload.fetchedAt)}</strong></div> : null}
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
