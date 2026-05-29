function formatDate(value?: string | null): string {
  if (!value) return 'n/a';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

function WebhookGuide() {
  return (
    <details className="panel tab-page worker-help-footer">
      <summary>
        <span className="panel-kicker">Guide</span>
        <strong>How to use Webhook Inbox</strong>
      </summary>
      <div className="detail-body">
        <div className="detail-grid">
          <div className="detail-block">
            <span>What it does</span>
            <p>
              Accepts JSON posts at <code>/api/workers/webhook-inbox/ingest</code> and publishes each request as a
              <code>webhook.event</code> item on the Item Bus.
            </p>
          </div>
          <div className="detail-block">
            <span>Where to configure it</span>
            <p>
              Open Config, select <strong>Webhook Inbox</strong>, then set an optional token and default source label.
              There is no schedule because outside tools call the endpoint directly.
            </p>
          </div>
          <div className="detail-block">
            <span>Example curl</span>
            <p>
              <code>{'curl -X POST http://127.0.0.1:3030/api/workers/webhook-inbox/ingest?token=YOUR_TOKEN -H "Content-Type: application/json" -d \'{"title":"New order","source":"Shop"}\''}</code>
            </p>
          </div>
          <div className="detail-block">
            <span>FAQ</span>
            <p>
              Getting a token error? Check the Config value and pass it either as <code>?token=...</code> or the
              <code>x-bfrost-webhook-token</code> header.
            </p>
          </div>
        </div>
      </div>
    </details>
  );
}

function WebhookDashboard(ctx: any) {
  const StatusPill = ctx.StatusPill ?? ((props: any) => <span>{props.children}</span>);
  const Detail = ctx.Detail ?? ((props: any) => <div className="detail"><span>{props.label}</span><strong>{props.value}</strong></div>);
  const slice = ctx.dashboard?.workerData?.['webhook-inbox'] ?? {};
  const config = slice.config ?? {};
  const history = Array.isArray(slice.history) ? slice.history : [];
  const recentItems = Array.isArray(slice.recentItems) ? slice.recentItems : [];
  const endpoint = slice.endpointPath || '/api/workers/webhook-inbox/ingest';

  return (
    <>
      <section className="grid top-grid tab-page">
        <article className="panel">
          <div className="panel-head">
            <div>
              <p className="panel-kicker">Webhook Inbox</p>
              <h2>Inbound events</h2>
            </div>
            <StatusPill tone={config.token ? 'good' : 'warning'}>{config.token ? 'token set' : 'open endpoint'}</StatusPill>
          </div>
          <div className="detail-body">
            <div className="detail-grid">
              <Detail label="Endpoint" value={endpoint} />
              <Detail label="Recent events" value={String(history.length)} />
            </div>
          </div>
        </article>

        <article className="panel">
          <div className="panel-head">
            <div>
              <p className="panel-kicker">Latest event</p>
              <h2>{history[0]?.title || 'No events yet'}</h2>
            </div>
            <StatusPill tone={history.length ? 'info' : 'muted'}>{history[0]?.source || 'idle'}</StatusPill>
          </div>
          {history[0] ? (
            <div className="detail-body">
              <div className="detail-grid">
                <Detail label="Source" value={history[0].source} />
                <Detail label="Received" value={formatDate(history[0].receivedAt)} />
              </div>
            </div>
          ) : (
            <p className="empty-state">Post JSON to the endpoint to create the first webhook.event item.</p>
          )}
        </article>
      </section>

      <section className="panel tab-page">
        <div className="panel-head">
          <div>
            <p className="panel-kicker">Recent events</p>
            <h2>Published to the Item Bus</h2>
          </div>
          <StatusPill tone="muted">{recentItems.length} items</StatusPill>
        </div>
        <div className="stack-list compact">
          {recentItems.map((item: any) => (
            <button className="summary-row" type="button" key={item.id} onClick={() => ctx.setSelectedQueueItemId?.(item.id)}>
              <div>
                <strong>{item.title}</strong>
                <span>{item.shortDesc}</span>
                <span>{formatDate(item.addedAt)}</span>
              </div>
              <StatusPill tone={ctx.queueItemTone ? ctx.queueItemTone(item.state) : 'muted'}>{item.state}</StatusPill>
            </button>
          ))}
          {recentItems.length === 0 ? <p className="empty-state">No webhook events have been published yet.</p> : null}
        </div>
      </section>

      <WebhookGuide />
    </>
  );
}

window.bfrost.registerDashboardView({
  workerId: 'webhook-inbox',
  kind: 'worker-dashboard',
  surfaceIds: ['webhook-inbox-dashboard'],
  menu: {
    icon: 'inbox',
    group: 'Workers',
    order: 40,
    label: 'Webhooks',
  },
  count: (ctx: any) => {
    const items = ctx.dashboard?.workerData?.['webhook-inbox']?.recentItems ?? [];
    return Array.isArray(items) ? items.filter((item: any) => item.state === 'queued' || item.state === 'approved').length : undefined;
  },
  render: (ctx: any) => <WebhookDashboard {...ctx} />,
  queueItemDetail: (item: any) => {
    if (item?.producerWorkerId !== 'webhook-inbox') return null;
    const payload = item.payload ?? {};
    const source = payload.source ?? {};
    return (
      <div className="detail-section">
        <p className="panel-kicker">Webhook event</p>
        <div className="detail-grid">
          {source.label ? <div className="detail"><span>Source</span><strong>{source.label}</strong></div> : null}
          {payload.eventType ? <div className="detail"><span>Event type</span><strong>{payload.eventType}</strong></div> : null}
          {payload.receivedAt ? <div className="detail"><span>Received</span><strong>{formatDate(payload.receivedAt)}</strong></div> : null}
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
