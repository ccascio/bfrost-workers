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
  const config = slice.config ?? { feeds: '', interests: '', relevanceThreshold: 3 };
  const feeds = Array.isArray(slice.feeds)
    ? slice.feeds
    : String(config.feeds ?? '').split('\n').map((line: string) => line.trim()).filter(Boolean);
  const interests = Array.isArray(slice.interests)
    ? slice.interests
    : String(config.interests ?? '').split('\n').map((line: string) => line.trim()).filter(Boolean);
  const recentItems = Array.isArray(slice.recentItems) ? slice.recentItems : [];
  const lastRun = slice.lastRun ?? null;
  const providerConfigured = slice.providerConfigured ?? false;
  const job = ctx.dashboard?.cron?.jobs?.find((entry: any) => entry.name === 'rss-fetch');
  const pendingCount = recentItems.filter((item: any) => item.state === 'queued' || item.state === 'approved').length;

  const llmStatus = !providerConfigured
    ? 'no model'
    : interests.length === 0
    ? 'off (no interests)'
    : `on · threshold ${config.relevanceThreshold ?? 3}/5`;

  return (
    <>
      <section className="grid top-grid tab-page">
        <article className="panel">
          <div className="panel-head">
            <div>
              <p className="panel-kicker">RSS & Feed Digest</p>
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
              <Detail label="AI filter" value={llmStatus} />
              <Detail label="Interests" value={interests.length > 0 ? `${interests.length} topic${interests.length === 1 ? '' : 's'}` : 'none'} />
            </div>
            {interests.length > 0 ? (
              <div style={{ marginTop: '0.75rem' }}>
                <p className="panel-kicker" style={{ marginBottom: '0.25rem' }}>Topics</p>
                <ul style={{ margin: 0, paddingLeft: '1.25rem' }}>
                  {interests.map((topic: string) => (
                    <li key={topic} style={{ fontSize: '0.85rem' }}>{topic}</li>
                  ))}
                </ul>
              </div>
            ) : null}
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
                {lastRun.llmUsed ? (
                  <Detail label="AI filtered" value={String(lastRun.filteredCount ?? 0)} />
                ) : null}
                {lastRun.llmUsed ? (
                  <Detail label="AI filter" value="active" />
                ) : null}
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
              {!lastRun.llmUsed && interests.length > 0 && !providerConfigured ? (
                <p className="empty-state" style={{ marginTop: '0.5rem' }}>
                  AI filtering is configured but no model provider is set up. Configure a provider to enable relevance filtering.
                </p>
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

      <details className="panel tab-page worker-help-footer">
        <summary>About RSS &amp; Feed Digest</summary>
        <div className="detail-body">
          <p><strong>What it does</strong></p>
          <p>Polls your RSS and Atom feeds on a schedule. When Interests are configured, an AI model scores each new article for relevance (1–5) and drops articles below your threshold. Matching articles get a clean AI-written summary and topic tags before landing in the Item Bus as <code>news.article</code> items.</p>
          <p><strong>Where to configure</strong></p>
          <ul>
            <li><strong>Config tab</strong> — Feed URLs and Interests (worker-wide).</li>
            <li><strong>Jobs tab → RSS fetch &amp; filter</strong> — schedule, max items per run, relevance threshold, and the AI prompt.</li>
          </ul>
          <p><strong>Inputs / outputs</strong></p>
          <p>Reads RSS/Atom over HTTP. Produces <code>news.article</code> items on the Item Bus. No items consumed.</p>
          <p><strong>Example interests</strong></p>
          <pre style={{ fontSize: '0.8rem', background: 'var(--surface-2, #f5f5f5)', padding: '0.5rem', borderRadius: '4px' }}>
{`AI and machine learning
startup funding
climate and energy policy`}
          </pre>
          <p><strong>FAQ</strong></p>
          <p><em>Articles aren't being filtered even though I set interests.</em> — Check that a model provider is configured (Settings → Providers). The AI filter only runs when a provider is available. If no provider is set up, all articles are published without filtering.</p>
          <p><em>Everything is being filtered out.</em> — Lower the relevance threshold (try 2) or broaden your interest descriptions.</p>
        </div>
      </details>
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
    const relevanceScore = item.payload?.relevanceScore;
    const llmTags = item.payload?.llmTags;
    return (
      <div className="detail-section">
        <p className="panel-kicker">RSS provenance</p>
        <div className="detail-grid">
          {feedUrl ? <div className="detail"><span>Feed URL</span><strong>{feedUrl}</strong></div> : null}
          {publishedAt ? <div className="detail"><span>Published</span><strong>{new Date(publishedAt).toLocaleString()}</strong></div> : null}
          {relevanceScore !== undefined ? <div className="detail"><span>Relevance</span><strong>{relevanceScore}/5</strong></div> : null}
          {llmTags?.length ? <div className="detail"><span>AI tags</span><strong>{llmTags.join(', ')}</strong></div> : null}
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
