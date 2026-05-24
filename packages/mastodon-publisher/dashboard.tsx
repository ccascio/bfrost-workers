function formatDate(value?: string | null): string {
  if (!value) return 'n/a';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

function mastodonMeta(item: any): Record<string, any> {
  return item?.metadata?.['mastodon-publisher'] ?? {};
}

function MastodonDashboard(ctx: any) {
  const StatusPill = ctx.StatusPill;
  const Detail = ctx.Detail;
  const slice = ctx.dashboard?.workerData?.['mastodon-publisher'] ?? {};
  const config = slice.config ?? {};
  const recentPosts = Array.isArray(slice.recentPosts) ? slice.recentPosts : [];
  const job = ctx.dashboard?.cron?.jobs?.find((entry: any) => entry.name === 'mastodon-post');
  const postedCount = recentPosts.filter((item: any) => mastodonMeta(item).mastodonStatusId).length;
  const failedCount = recentPosts.filter((item: any) => mastodonMeta(item).failedAt).length;

  return (
    <>
      <section className="grid top-grid tab-page">
        <article className="panel">
          <div className="panel-head">
            <div>
              <p className="panel-kicker">Mastodon Publisher</p>
              <h2>Publishing status</h2>
            </div>
            <StatusPill tone={slice.configured ? 'good' : 'warning'}>
              {slice.configured ? 'configured' : 'setup needed'}
            </StatusPill>
          </div>
          <div className="detail-body">
            <div className="detail-grid">
              <Detail label="Job" value={job?.enabled ? 'enabled' : 'disabled'} />
              <Detail label="Cron" value={job?.cron ?? 'n/a'} />
              <Detail label="Visibility" value={config.visibility ?? 'public'} />
              <Detail label="Max per run" value={String(config.maxItemsPerRun ?? 3)} />
            </div>
          </div>
          <div className="panel-actions">
            <button
              type="button"
              disabled={ctx.busyKey === 'run-mastodon-post' || job?.running || !slice.configured}
              onClick={() => ctx.triggerRun('run-mastodon-post', '/api/cron-jobs/mastodon-post/run', 'Mastodon post started.')}
            >
              {job?.running ? 'Running...' : 'Run now'}
            </button>
          </div>
        </article>

        <article className="panel">
          <div className="panel-head">
            <div>
              <p className="panel-kicker">Recent outcomes</p>
              <h2>{postedCount} posted</h2>
            </div>
            <StatusPill tone={failedCount > 0 ? 'warning' : postedCount > 0 ? 'info' : 'muted'}>
              {failedCount > 0 ? `${failedCount} failed` : `${recentPosts.length} items`}
            </StatusPill>
          </div>
          <div className="detail-body">
            <div className="detail-grid">
              <Detail label="Posted" value={String(postedCount)} />
              <Detail label="Failed" value={String(failedCount)} />
              <Detail label="Instance" value={config.instanceUrl || 'n/a'} />
            </div>
          </div>
        </article>
      </section>

      <section className="panel tab-page">
        <div className="panel-head">
          <div>
            <p className="panel-kicker">Recent posts</p>
            <h2>Mastodon activity</h2>
          </div>
          <StatusPill tone="muted">{recentPosts.length} items</StatusPill>
        </div>
        <div className="stack-list compact">
          {recentPosts.map((item: any) => {
            const meta = mastodonMeta(item);
            return (
              <button
                className="summary-row"
                type="button"
                key={item.id}
                onClick={() => ctx.setSelectedQueueItemId?.(item.id)}
              >
                <div>
                  <strong>{item.title}</strong>
                  <span>{meta.mastodonUrl || item.shortDesc}</span>
                  <span>{formatDate(meta.postedAt || meta.failedAt || item.stateChangedAt)}</span>
                </div>
                <StatusPill tone={meta.failedAt ? 'warning' : 'good'}>{meta.failedAt ? 'failed' : 'posted'}</StatusPill>
              </button>
            );
          })}
          {recentPosts.length === 0 ? <p className="empty-state">No Mastodon publishing attempts yet.</p> : null}
        </div>
      </section>
    </>
  );
}

window.bfrost.registerDashboardView({
  workerId: 'mastodon-publisher',
  kind: 'worker-dashboard',
  surfaceIds: ['mastodon-publisher-dashboard'],
  menu: {
    icon: 'megaphone',
    group: 'Workers',
    order: 55,
    label: 'Mastodon',
  },
  count: (ctx: any) => {
    const posts = ctx.dashboard?.workerData?.['mastodon-publisher']?.recentPosts ?? [];
    return Array.isArray(posts) ? posts.filter((item: any) => mastodonMeta(item).failedAt).length : undefined;
  },
  render: (ctx: any) => <MastodonDashboard {...ctx} />,
  queueItemDetail: (item: any) => {
    const meta = mastodonMeta(item);
    if (!meta.mastodonStatusId && !meta.failedAt) return null;
    return (
      <div className="detail-section">
        <p className="panel-kicker">Mastodon publisher</p>
        <div className="detail-grid">
          {meta.mastodonStatusId ? <div className="detail"><span>Status ID</span><strong>{meta.mastodonStatusId}</strong></div> : null}
          {meta.visibility ? <div className="detail"><span>Visibility</span><strong>{meta.visibility}</strong></div> : null}
          {meta.postedAt ? <div className="detail"><span>Posted</span><strong>{formatDate(meta.postedAt)}</strong></div> : null}
          {meta.failedAt ? <div className="detail"><span>Failed</span><strong>{formatDate(meta.failedAt)}</strong></div> : null}
        </div>
        {meta.mastodonUrl ? (
          <a className="detail-title" href={meta.mastodonUrl} target="_blank" rel="noreferrer">
            Open Mastodon status
          </a>
        ) : null}
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
