function formatDate(value?: string | null): string {
  if (!value) return 'n/a';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

function CrossrefGuide() {
  return (
    <details className="panel tab-page worker-help-footer">
      <summary>
        <span className="panel-kicker">Guide</span>
        <strong>How to use Crossref DOI Resolver</strong>
      </summary>
      <div className="detail-body">
        <div className="detail-grid">
          <div className="detail-block">
            <span>What it does</span>
            <p>
              Adds the assistant tool <code>resolveCrossrefWork</code>. The assistant can use it to resolve a DOI or
              search publication titles, then return authors, venue, year, DOI, publisher, and source URL.
            </p>
          </div>
          <div className="detail-block">
            <span>Where to configure it</span>
            <p>
              Open Config, select <strong>Crossref</strong>, and add an optional contact email. There is no Jobs setup
              because this is an assistant tool, not a scheduled worker.
            </p>
          </div>
          <div className="detail-block">
            <span>Example prompts</span>
            <p>
              Ask: <code>Use Crossref to look up DOI 10.1145/3368089.3409712</code>. For titles, ask:
              <code>Find Crossref metadata for "Attention Is All You Need"</code>.
            </p>
          </div>
          <div className="detail-block">
            <span>FAQ</span>
            <p>
              No history? The assistant has not used the tool yet. Weak result? Prefer DOI lookup when possible, or ask
              for several title candidates so you can choose the best match.
            </p>
          </div>
        </div>
      </div>
    </details>
  );
}

function CrossrefDashboard(ctx: any) {
  const StatusPill = ctx.StatusPill;
  const Detail = ctx.Detail;
  const slice = ctx.dashboard?.workerData?.['crossref-doi-resolver'] ?? {};
  const history = Array.isArray(slice.history) ? slice.history : [];
  const config = slice.config ?? {};

  return (
    <>
      <section className="grid top-grid tab-page">
        <article className="panel">
          <div className="panel-head">
            <div>
              <p className="panel-kicker">Crossref</p>
              <h2>{slice.toolName || 'resolveCrossrefWork'}</h2>
            </div>
            <StatusPill tone="good">assistant tool</StatusPill>
          </div>
          <div className="detail-body">
            <div className="detail-grid">
              <Detail label="Contact email" value={config.contactEmail ? 'set' : 'optional'} />
              <Detail label="Recent lookups" value={String(history.length)} />
            </div>
          </div>
        </article>

        <article className="panel">
          <div className="panel-head">
            <div>
              <p className="panel-kicker">Latest lookup</p>
              <h2>{history[0]?.query || 'No lookup yet'}</h2>
            </div>
            <StatusPill tone={history.length ? 'info' : 'muted'}>{history[0]?.mode || 'idle'}</StatusPill>
          </div>
          {history[0] ? (
            <div className="detail-body">
              <div className="detail-grid">
                <Detail label="Results" value={String(history[0].resultCount ?? 0)} />
                <Detail label="When" value={formatDate(history[0].lookedUpAt)} />
              </div>
            </div>
          ) : (
            <p className="empty-state">The assistant has not used Crossref yet.</p>
          )}
        </article>
      </section>

      <section className="panel tab-page">
        <div className="panel-head">
          <div>
            <p className="panel-kicker">History</p>
            <h2>Recent Crossref lookups</h2>
          </div>
          <StatusPill tone="muted">{history.length} lookups</StatusPill>
        </div>
        <div className="stack-list compact">
          {history.map((entry: any) => (
            <div className="summary-row" key={`${entry.lookedUpAt}-${entry.query}`}>
              <div>
                <strong>{entry.query}</strong>
                <span>{entry.mode} lookup · {entry.resultCount} result{entry.resultCount === 1 ? '' : 's'}</span>
                <span>{formatDate(entry.lookedUpAt)}</span>
              </div>
              <StatusPill tone="info">{entry.mode}</StatusPill>
            </div>
          ))}
          {history.length === 0 ? <p className="empty-state">No Crossref lookups yet.</p> : null}
        </div>
      </section>

      <CrossrefGuide />
    </>
  );
}

window.bfrost.registerDashboardView({
  workerId: 'crossref-doi-resolver',
  kind: 'worker-dashboard',
  surfaceIds: ['crossref-doi-dashboard'],
  menu: {
    icon: 'book-open',
    group: 'Workers',
    order: 38,
    label: 'Crossref',
  },
  count: () => undefined,
  render: (ctx: any) => <CrossrefDashboard {...ctx} />,
});

declare global {
  interface Window {
    bfrost: {
      registerDashboardView: (view: any) => void;
      [key: string]: any;
    };
  }
}
