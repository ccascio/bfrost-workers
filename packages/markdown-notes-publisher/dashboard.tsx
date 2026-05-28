function formatDate(value?: string | null): string {
  if (!value) return 'n/a';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

function MarkdownGuide() {
  return (
    <details className="panel tab-page worker-help-footer">
      <summary>
        <span className="panel-kicker">Guide</span>
        <strong>How to use Markdown Notes</strong>
      </summary>
      <div className="detail-body">
        <div className="detail-grid">
          <div className="detail-block">
            <span>What it does</span>
            <p>
              Consumes Item Bus entries and requests local <code>.md</code> file writes. It works well with
              <code>news.article</code> and <code>research.paper</code> items from News or arXiv Search.
            </p>
          </div>
          <div className="detail-block">
            <span>Where to configure it</span>
            <p>
              Open Jobs, select <strong>Write Markdown notes</strong>, then set the notes folder, item types, max notes
              per run, filename template, frontmatter, schedule, and approval settings.
            </p>
          </div>
          <div className="detail-block">
            <span>Example setup</span>
            <p>
              Use <code>~/Documents/BFrost Notes</code>, item types <code>news.article</code> and <code>research.paper</code>,
              max 3 notes per run, and filename template <code>{'{date}-{slug}.md'}</code>.
            </p>
          </div>
          <div className="detail-block">
            <span>FAQ</span>
            <p>
              No notes? Make sure another worker has produced matching Item Bus items and that this worker has not already
              handled them. Pending items need file-write approval before BFrost creates files on disk.
            </p>
          </div>
        </div>
      </div>
    </details>
  );
}

function MarkdownNotesDashboard(ctx: any) {
  const StatusPill = ctx.StatusPill;
  const Detail = ctx.Detail;
  const slice = ctx.dashboard?.workerData?.['markdown-notes-publisher'] ?? {};
  const config = slice.config ?? {};
  const recentNotes = Array.isArray(slice.recentNotes) ? slice.recentNotes : [];
  const lastRun = slice.lastRun ?? null;
  const job = ctx.dashboard?.cron?.jobs?.find((entry: any) => entry.name === 'markdown-notes-write');
  const approvalNeeded = recentNotes.filter((item: any) => item.metadata?.['markdown-notes-publisher']?.status === 'approval-needed').length;

  return (
    <>
      <section className="grid top-grid tab-page">
        <article className="panel">
          <div className="panel-head">
            <div>
              <p className="panel-kicker">Markdown Notes</p>
              <h2>{lastRun ? 'Note output' : 'Ready to write notes'}</h2>
            </div>
            <StatusPill tone={approvalNeeded > 0 ? 'warning' : 'good'}>{approvalNeeded > 0 ? 'approval' : 'ready'}</StatusPill>
          </div>
          <div className="detail-body">
            <div className="detail-grid">
              <Detail label="Recent notes" value={String(recentNotes.length)} />
              <Detail label="Needs approval" value={String(approvalNeeded)} />
            </div>
          </div>
          <div className="panel-actions">
            <button
              type="button"
              disabled={ctx.busyKey === 'run-markdown-notes' || job?.running}
              onClick={() => ctx.triggerRun('run-markdown-notes', '/api/cron-jobs/markdown-notes-write/run', 'Markdown note run started.')}
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
                <Detail label="Written" value={String(lastRun.writtenCount ?? 0)} />
                <Detail label="Approval" value={String(lastRun.pendingApprovalCount ?? 0)} />
              </div>
            </div>
          ) : (
            <p className="empty-state">No Markdown notes have been requested yet.</p>
          )}
        </article>
      </section>

      <section className="panel tab-page">
        <div className="panel-head">
          <div>
            <p className="panel-kicker">Recent notes</p>
            <h2>Files requested by this worker</h2>
          </div>
          <StatusPill tone="muted">{recentNotes.length} items</StatusPill>
        </div>
        <div className="stack-list compact">
          {recentNotes.map((item: any) => {
            const meta = item.metadata?.['markdown-notes-publisher'] ?? {};
            return (
              <button className="summary-row" type="button" key={item.id} onClick={() => ctx.setSelectedQueueItemId?.(item.id)}>
                <div>
                  <strong>{item.title}</strong>
                  <span>{meta.filePath || item.shortDesc}</span>
                  <span>{formatDate(meta.requestedAt)}</span>
                </div>
                <StatusPill tone={meta.status === 'written' ? 'good' : meta.error ? 'warning' : 'info'}>{meta.status || 'noted'}</StatusPill>
              </button>
            );
          })}
          {recentNotes.length === 0 ? <p className="empty-state">No note files have been requested yet.</p> : null}
        </div>
      </section>

      <MarkdownGuide />
    </>
  );
}

window.bfrost.registerDashboardView({
  workerId: 'markdown-notes-publisher',
  kind: 'worker-dashboard',
  surfaceIds: ['markdown-notes-dashboard'],
  menu: {
    icon: 'file-text',
    group: 'Workers',
    order: 36,
    label: 'Notes',
  },
  count: (ctx: any) => {
    const items = ctx.dashboard?.workerData?.['markdown-notes-publisher']?.recentNotes ?? [];
    return Array.isArray(items)
      ? items.filter((item: any) => item.metadata?.['markdown-notes-publisher']?.status === 'approval-needed').length
      : undefined;
  },
  render: (ctx: any) => <MarkdownNotesDashboard {...ctx} />,
  queueItemDetail: (item: any) => {
    const meta = item?.metadata?.['markdown-notes-publisher'];
    if (!meta) return null;
    return (
      <div className="detail-section">
        <p className="panel-kicker">Markdown note</p>
        <div className="detail-grid">
          {meta.filePath ? <div className="detail"><span>File</span><strong>{meta.filePath}</strong></div> : null}
          {meta.status ? <div className="detail"><span>Status</span><strong>{meta.status}</strong></div> : null}
          {meta.requestId ? <div className="detail"><span>Action</span><strong>{meta.requestId}</strong></div> : null}
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
