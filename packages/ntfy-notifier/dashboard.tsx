function formatDate(value?: string | null): string {
  if (!value) return 'n/a';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

function NtfyGuide() {
  return (
    <details className="panel tab-page worker-help-footer">
      <summary>
        <span className="panel-kicker">Guide</span>
        <strong>How to use ntfy Notifier</strong>
      </summary>
      <div className="detail-body">
        <div className="detail-grid">
          <div className="detail-block">
            <span>What it does</span>
            <p>
              Reads new Item Bus entries and sends a push notification to an <code>ntfy</code> topic. It records send
              status in its own metadata namespace without changing the item state.
            </p>
          </div>
          <div className="detail-block">
            <span>Where to configure it</span>
            <p>
              Open Jobs, select <strong>Send ntfy notifications</strong>, then set the server, topic, item types,
              schedule, priority, and max notifications per run.
            </p>
          </div>
          <div className="detail-block">
            <span>Example setup</span>
            <p>
              Use <code>https://ntfy.sh</code>, create a hard-to-guess topic, subscribe in the ntfy app, and start with
              <code>news.article</code>, <code>research.paper</code>, <code>web.page</code>, and <code>webhook.event</code>.
            </p>
          </div>
          <div className="detail-block">
            <span>FAQ</span>
            <p>
              No notifications? Make sure the topic is configured in Jobs and that eligible Item Bus items exist. Already
              handled items are skipped so you do not get repeats.
            </p>
          </div>
        </div>
      </div>
    </details>
  );
}

function NtfyDashboard(ctx: any) {
  const StatusPill = ctx.StatusPill ?? ((props: any) => <span>{props.children}</span>);
  const Detail = ctx.Detail ?? ((props: any) => <div className="detail"><span>{props.label}</span><strong>{props.value}</strong></div>);
  const slice = ctx.dashboard?.workerData?.['ntfy-notifier'] ?? {};
  const notifications = Array.isArray(slice.recentNotifications) ? slice.recentNotifications : [];
  const lastRun = slice.lastRun ?? null;
  const job = ctx.dashboard?.cron?.jobs?.find((entry: any) => entry.name === 'ntfy-send');
  const failures = notifications.filter((item: any) => item.metadata?.['ntfy-notifier']?.status === 'failed').length;

  return (
    <>
      <section className="grid top-grid tab-page">
        <article className="panel">
          <div className="panel-head">
            <div>
              <p className="panel-kicker">ntfy Notifier</p>
              <h2>{lastRun ? 'Notification output' : 'Ready to send'}</h2>
            </div>
            <StatusPill tone={failures > 0 ? 'warning' : 'good'}>{failures > 0 ? 'check sends' : 'ready'}</StatusPill>
          </div>
          <div className="detail-body">
            <div className="detail-grid">
              <Detail label="Job" value={job?.enabled ? 'enabled' : 'disabled'} />
              <Detail label="Recent sends" value={String(notifications.length)} />
            </div>
          </div>
          <div className="panel-actions">
            <button
              type="button"
              disabled={ctx.busyKey === 'run-ntfy-send' || job?.running}
              onClick={() => ctx.triggerRun('run-ntfy-send', '/api/cron-jobs/ntfy-send/run', 'ntfy notification run started.')}
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
                <Detail label="Requested" value={String(lastRun.requestedCount ?? 0)} />
                <Detail label="Sent" value={String(lastRun.sentCount ?? 0)} />
                <Detail label="Errors" value={String(lastRun.errors?.length ?? 0)} />
              </div>
            </div>
          ) : (
            <p className="empty-state">Configure a topic in Jobs, then run once or enable the schedule.</p>
          )}
        </article>
      </section>

      <section className="panel tab-page">
        <div className="panel-head">
          <div>
            <p className="panel-kicker">Recent sends</p>
            <h2>Items handled by this worker</h2>
          </div>
          <StatusPill tone="muted">{notifications.length} items</StatusPill>
        </div>
        <div className="stack-list compact">
          {notifications.map((item: any) => {
            const meta = item.metadata?.['ntfy-notifier'] ?? {};
            return (
              <button className="summary-row" type="button" key={item.id} onClick={() => ctx.setSelectedQueueItemId?.(item.id)}>
                <div>
                  <strong>{item.title}</strong>
                  <span>{meta.topic ? `Topic: ${meta.topic}` : item.shortDesc}</span>
                  <span>{formatDate(meta.sentAt || meta.failedAt || item.addedAt)}</span>
                </div>
                <StatusPill tone={meta.status === 'sent' ? 'good' : 'warning'}>{meta.status || 'notified'}</StatusPill>
              </button>
            );
          })}
          {notifications.length === 0 ? <p className="empty-state">No notifications have been sent yet.</p> : null}
        </div>
      </section>

      <NtfyGuide />
    </>
  );
}

window.bfrost.registerDashboardView({
  workerId: 'ntfy-notifier',
  kind: 'worker-dashboard',
  surfaceIds: ['ntfy-notifier-dashboard'],
  menu: {
    icon: 'bell',
    group: 'Workers',
    order: 41,
    label: 'ntfy',
  },
  count: (ctx: any) => {
    const items = ctx.dashboard?.workerData?.['ntfy-notifier']?.recentNotifications ?? [];
    return Array.isArray(items) ? items.filter((item: any) => item.metadata?.['ntfy-notifier']?.status === 'failed').length : undefined;
  },
  render: (ctx: any) => <NtfyDashboard {...ctx} />,
  queueItemDetail: (item: any) => {
    const meta = item?.metadata?.['ntfy-notifier'];
    if (!meta) return null;
    return (
      <div className="detail-section">
        <p className="panel-kicker">ntfy notification</p>
        <div className="detail-grid">
          {meta.status ? <div className="detail"><span>Status</span><strong>{meta.status}</strong></div> : null}
          {meta.topic ? <div className="detail"><span>Topic</span><strong>{meta.topic}</strong></div> : null}
          {meta.sentAt ? <div className="detail"><span>Sent</span><strong>{formatDate(meta.sentAt)}</strong></div> : null}
          {meta.failedAt ? <div className="detail"><span>Failed</span><strong>{formatDate(meta.failedAt)}</strong></div> : null}
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
