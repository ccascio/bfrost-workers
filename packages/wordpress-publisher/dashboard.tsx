function formatDate(value?: string | null): string {
  if (!value) return 'n/a';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

function wpMeta(item: any): Record<string, any> {
  return item?.metadata?.['wordpress-publisher'] ?? {};
}

function WordPressDashboard(ctx: any) {
  const StatusPill = ctx.StatusPill;
  const Detail = ctx.Detail;
  const slice = ctx.dashboard?.workerData?.['wordpress-publisher'] ?? {};
  const settings = slice.settings ?? {};
  const taxonomy = slice.taxonomy ?? { categories: [], tags: [], refreshedAt: null };
  const recentPosts = Array.isArray(slice.recentPosts) ? slice.recentPosts : [];
  const job = ctx.dashboard?.cron?.jobs?.find((entry: any) => entry.name === 'wordpress-publish');
  const postedCount = recentPosts.filter((item: any) => wpMeta(item).postId).length;
  const failedCount = recentPosts.filter((item: any) => wpMeta(item).failedAt).length;

  return (
    <>
      <section className="grid top-grid tab-page">
        <article className="panel">
          <div className="panel-head">
            <div>
              <p className="panel-kicker">WordPress Publisher</p>
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
              <Detail label="Post status" value={settings.defaultStatus ?? 'draft'} />
              <Detail label="Post type" value={settings.postType ?? 'posts'} />
            </div>
          </div>
          <div className="panel-actions">
            <button
              type="button"
              disabled={ctx.busyKey === 'run-wordpress-publish' || job?.running || !slice.configured}
              onClick={() => ctx.triggerRun('run-wordpress-publish', '/api/cron-jobs/wordpress-publish/run', 'WordPress publish started.')}
            >
              {job?.running ? 'Running...' : 'Run now'}
            </button>
          </div>
        </article>

        <article className="panel">
          <div className="panel-head">
            <div>
              <p className="panel-kicker">WordPress cache</p>
              <h2>Taxonomies</h2>
            </div>
            <StatusPill tone={taxonomy.refreshedAt ? 'info' : 'muted'}>
              {taxonomy.refreshedAt ? 'cached' : 'empty'}
            </StatusPill>
          </div>
          <div className="detail-body">
            <div className="detail-grid">
              <Detail label="Categories" value={String(taxonomy.categories?.length ?? 0)} />
              <Detail label="Tags" value={String(taxonomy.tags?.length ?? 0)} />
              <Detail label="Refreshed" value={formatDate(taxonomy.refreshedAt)} />
              <Detail label="Recent failures" value={String(failedCount)} />
            </div>
          </div>
        </article>
      </section>

      <section className="panel tab-page">
        <div className="panel-head">
          <div>
            <p className="panel-kicker">Recent posts</p>
            <h2>WordPress activity</h2>
          </div>
          <StatusPill tone={failedCount > 0 ? 'warning' : postedCount > 0 ? 'info' : 'muted'}>
            {postedCount} posted
          </StatusPill>
        </div>
        <div className="stack-list compact">
          {recentPosts.map((item: any) => {
            const meta = wpMeta(item);
            return (
              <button
                className="summary-row"
                type="button"
                key={item.id}
                onClick={() => ctx.setSelectedQueueItemId?.(item.id)}
              >
                <div>
                  <strong>{item.title}</strong>
                  <span>{meta.postUrl || item.shortDesc}</span>
                  <span>{formatDate(meta.postedAt || meta.failedAt || item.stateChangedAt)}</span>
                </div>
                <StatusPill tone={meta.failedAt ? 'warning' : 'good'}>{meta.failedAt ? 'failed' : (meta.postStatus || 'posted')}</StatusPill>
              </button>
            );
          })}
          {recentPosts.length === 0 ? <p className="empty-state">No WordPress publishing attempts yet.</p> : null}
        </div>
      </section>
    </>
  );
}

window.bfrost.registerDashboardView({
  workerId: 'wordpress-publisher',
  kind: 'worker-dashboard',
  surfaceIds: ['wordpress-publisher-dashboard'],
  menu: {
    icon: 'article',
    group: 'Workers',
    order: 60,
    label: 'WordPress',
  },
  count: (ctx: any) => {
    const posts = ctx.dashboard?.workerData?.['wordpress-publisher']?.recentPosts ?? [];
    return Array.isArray(posts) ? posts.filter((item: any) => wpMeta(item).failedAt).length : undefined;
  },
  render: (ctx: any) => <WordPressDashboard {...ctx} />,
  queueItemDetail: (item: any) => {
    const meta = wpMeta(item);
    if (!meta.postId && !meta.failedAt) return null;
    return (
      <div className="detail-section">
        <p className="panel-kicker">WordPress publisher</p>
        <div className="detail-grid">
          {meta.postId ? <div className="detail"><span>Post ID</span><strong>{String(meta.postId)}</strong></div> : null}
          {meta.postStatus ? <div className="detail"><span>Status</span><strong>{meta.postStatus}</strong></div> : null}
          {meta.postType ? <div className="detail"><span>Post type</span><strong>{meta.postType}</strong></div> : null}
          {meta.postedAt ? <div className="detail"><span>Posted</span><strong>{formatDate(meta.postedAt)}</strong></div> : null}
          {meta.failedAt ? <div className="detail"><span>Failed</span><strong>{formatDate(meta.failedAt)}</strong></div> : null}
        </div>
        {meta.postUrl ? (
          <a className="detail-title" href={meta.postUrl} target="_blank" rel="noreferrer">
            Open WordPress post
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
