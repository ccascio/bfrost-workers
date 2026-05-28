function formatDate(value?: string | null): string {
  if (!value) return 'n/a';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

function ArxivGuide() {
  return (
    <details className="panel tab-page worker-help-footer">
      <summary>
        <span className="panel-kicker">Guide</span>
        <strong>How to use arXiv Search</strong>
      </summary>
      <div className="detail-body">
        <div className="detail-grid">
          <div className="detail-block">
            <span>What it does</span>
            <p>
              Searches arXiv on a schedule and publishes new matches to the Item Bus as <code>research.paper</code> items.
              Other workers, such as Markdown Notes, can then consume those papers.
            </p>
          </div>
          <div className="detail-block">
            <span>Where to configure it</span>
            <p>
              Open Jobs, select <strong>Fetch arXiv papers</strong>, then edit the search query, max papers, sort order,
              schedule, and optional category allowlist. This dashboard only shows status and recent output.
            </p>
          </div>
          <div className="detail-block">
            <span>Example setup</span>
            <p>
              Start with <code>cat:cs.AI OR cat:cs.CL</code>, max 10 papers, newest submitted first, and no category
              allowlist. For a narrower watch, try <code>all:"retrieval augmented generation"</code>.
            </p>
          </div>
          <div className="detail-block">
            <span>FAQ</span>
            <p>
              No papers? Broaden the query, remove category filters, or check the last run warning. Repeated papers are
              skipped because the worker remembers arXiv IDs it already published.
            </p>
          </div>
        </div>
      </div>
    </details>
  );
}

function ArxivDashboard(ctx: any) {
  const StatusPill = ctx.StatusPill;
  const Detail = ctx.Detail;
  const slice = ctx.dashboard?.workerData?.['arxiv-search'] ?? {};
  const papers = Array.isArray(slice.recentPapers) ? slice.recentPapers : [];
  const lastRun = slice.lastRun ?? null;
  const job = ctx.dashboard?.cron?.jobs?.find((entry: any) => entry.name === 'arxiv-search-fetch');

  return (
    <>
      <section className="grid top-grid tab-page">
        <article className="panel">
          <div className="panel-head">
            <div>
              <p className="panel-kicker">arXiv Search</p>
              <h2>{lastRun?.query || 'Ready for a search'}</h2>
            </div>
            <StatusPill tone={lastRun?.errors?.length ? 'warning' : 'good'}>{lastRun?.errors?.length ? 'check run' : 'ready'}</StatusPill>
          </div>
          <div className="detail-body">
            <div className="detail-grid">
              <Detail label="Recent papers" value={String(papers.length)} />
              <Detail label="Last query" value={lastRun?.query ?? 'n/a'} />
            </div>
          </div>
          <div className="panel-actions">
            <button
              type="button"
              disabled={ctx.busyKey === 'run-arxiv-search' || job?.running}
              onClick={() => ctx.triggerRun('run-arxiv-search', '/api/cron-jobs/arxiv-search-fetch/run', 'arXiv search started.')}
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
                <Detail label="Found" value={String(lastRun.foundCount ?? 0)} />
                <Detail label="Published" value={String(lastRun.publishedCount ?? 0)} />
                <Detail label="Skipped" value={String(lastRun.skippedCount ?? 0)} />
              </div>
              {lastRun.errors?.length ? (
                <div className="timeline">
                  {lastRun.errors.map((error: any) => (
                    <div className="timeline-event warning" key={error.message}>
                      <div><strong>arXiv API</strong><span>{error.message}</span></div>
                      <StatusPill tone="warning">warning</StatusPill>
                    </div>
                  ))}
                </div>
              ) : null}
            </div>
          ) : (
            <p className="empty-state">Configure the arXiv job in Jobs, then run it once or enable its schedule.</p>
          )}
        </article>
      </section>

      <section className="panel tab-page">
        <div className="panel-head">
          <div>
            <p className="panel-kicker">Recent papers</p>
            <h2>Published to the Item Bus</h2>
          </div>
          <StatusPill tone="muted">{papers.length} papers</StatusPill>
        </div>
        <div className="stack-list compact">
          {papers.map((item: any) => (
            <button className="summary-row" type="button" key={item.id} onClick={() => ctx.setSelectedQueueItemId?.(item.id)}>
              <div>
                <strong>{item.title}</strong>
                <span>{item.shortDesc}</span>
                <span>{formatDate(item.addedAt)}</span>
              </div>
              <StatusPill tone={ctx.queueItemTone ? ctx.queueItemTone(item.state) : 'muted'}>{item.state}</StatusPill>
            </button>
          ))}
          {papers.length === 0 ? <p className="empty-state">No arXiv papers have been published yet.</p> : null}
        </div>
      </section>

      <ArxivGuide />
    </>
  );
}

window.bfrost.registerDashboardView({
  workerId: 'arxiv-search',
  kind: 'worker-dashboard',
  surfaceIds: ['arxiv-search-dashboard'],
  menu: {
    icon: 'search',
    group: 'Workers',
    order: 37,
    label: 'arXiv',
  },
  count: (ctx: any) => {
    const items = ctx.dashboard?.workerData?.['arxiv-search']?.recentPapers ?? [];
    return Array.isArray(items) ? items.filter((item: any) => item.state === 'queued' || item.state === 'approved').length : undefined;
  },
  render: (ctx: any) => <ArxivDashboard {...ctx} />,
  queueItemDetail: (item: any) => {
    if (item?.producerWorkerId !== 'arxiv-search') return null;
    const payload = item.payload ?? {};
    return (
      <div className="detail-section">
        <p className="panel-kicker">arXiv paper</p>
        <div className="detail-grid">
          {payload.paperId ? <div className="detail"><span>Paper</span><strong>{payload.paperId}</strong></div> : null}
          {payload.publishedAt ? <div className="detail"><span>Published</span><strong>{formatDate(payload.publishedAt)}</strong></div> : null}
          {payload.pdfUrl ? <div className="detail"><span>PDF</span><strong>{payload.pdfUrl}</strong></div> : null}
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
