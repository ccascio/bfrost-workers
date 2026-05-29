import { useEffect, useMemo, useState } from 'react';

const WORKER_ID = 'markdown-notes-publisher';
const JOB_ID = 'markdown-notes-write';
const DEFAULT_OUTPUT_DIR = '~/Documents/BFrost Notes';
const MAX_UPLOAD_BYTES = 1024 * 1024;

interface NoteFile {
  name: string;
  path: string;
  sizeBytes: number;
  updatedAt: string;
  indexed: boolean;
}

interface SearchResult {
  name: string;
  path: string;
  excerpt: string;
  updatedAt: string;
  score: number;
  model: string;
  provider: string;
}

function formatDate(value?: string | null): string {
  if (!value) return 'n/a';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

function formatBytes(value?: number): string {
  if (!Number.isFinite(value ?? NaN)) return 'n/a';
  if ((value ?? 0) < 1024) return `${value} B`;
  if ((value ?? 0) < 1024 * 1024) return `${Math.round((value ?? 0) / 102.4) / 10} KB`;
  return `${Math.round((value ?? 0) / 1024 / 102.4) / 10} MB`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function inlineMarkdown(value: string): string {
  return escapeHtml(value)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>');
}

function markdownToHtml(source: string): string {
  const lines = source.split(/\r?\n/);
  const html: string[] = [];
  let inList = false;
  let inCode = false;

  function closeList() {
    if (inList) {
      html.push('</ul>');
      inList = false;
    }
  }

  for (const line of lines) {
    if (line.trim().startsWith('```')) {
      closeList();
      html.push(inCode ? '</code></pre>' : '<pre><code>');
      inCode = !inCode;
      continue;
    }
    if (inCode) {
      html.push(`${escapeHtml(line)}\n`);
      continue;
    }
    if (!line.trim()) {
      closeList();
      continue;
    }
    const heading = line.match(/^(#{1,4})\s+(.+)$/);
    if (heading) {
      closeList();
      const level = heading[1].length;
      html.push(`<h${level}>${inlineMarkdown(heading[2])}</h${level}>`);
      continue;
    }
    const bullet = line.match(/^[-*]\s+(.+)$/);
    if (bullet) {
      if (!inList) {
        html.push('<ul>');
        inList = true;
      }
      html.push(`<li>${inlineMarkdown(bullet[1])}</li>`);
      continue;
    }
    closeList();
    html.push(`<p>${inlineMarkdown(line)}</p>`);
  }
  closeList();
  if (inCode) html.push('</code></pre>');
  return html.join('\n');
}

async function apiJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    credentials: 'include',
    ...init,
    headers: {
      ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
      ...(init?.headers ?? {}),
    },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error ?? res.statusText);
  return data as T;
}

function outputDirFromJob(job: any): string {
  const value = job?.params?.outputDir;
  return typeof value === 'string' && value.trim() ? value : DEFAULT_OUTPUT_DIR;
}

function MarkdownGuide({ itemTypes }: { itemTypes: Array<{ value: string; label?: string; description?: string }> }) {
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
              <code>news.article</code>, <code>research.paper</code>, <code>web.page</code>, and <code>webhook.event</code>.
            </p>
          </div>
          <div className="detail-block">
            <span>Where to configure it</span>
            <p>
              Open Jobs, select <strong>Write Markdown notes</strong>, then choose the notes folder, item types,
              max notes per run, filename template, schedule, and approval settings.
            </p>
          </div>
          <div className="detail-block">
            <span>Available item types</span>
            <p>
              {itemTypes.length
                ? itemTypes.map((item) => `${item.value}${item.description ? ` (${item.description})` : ''}`).join('; ')
                : 'The Jobs panel shows the suggested Item Bus types as selectable chips.'}
            </p>
          </div>
          <div className="detail-block">
            <span>Semantic search</span>
            <p>
              Written and uploaded notes are embedded with the embedding provider/model selected in BFrost Config.
              Existing files can be added with <strong>Index folder</strong>.
            </p>
          </div>
          <div className="detail-block">
            <span>FAQ</span>
            <p>
              No notes? Make sure another worker has produced matching Item Bus items and that this worker has not already
              handled them. Pending writes must be approved in Actions before files appear on disk.
            </p>
          </div>
        </div>
      </div>
    </details>
  );
}

function NotesFolderPanel({ ctx, StatusPill }: { ctx: any; StatusPill: any }) {
  const job = ctx.dashboard?.cron?.jobs?.find((entry: any) => entry.name === JOB_ID);
  const outputDir = useMemo(() => outputDirFromJob(job), [job]);
  const [files, setFiles] = useState<NoteFile[]>([]);
  const [selected, setSelected] = useState<{ name: string; path: string; content: string } | null>(null);
  const [viewMode, setViewMode] = useState<'formatted' | 'raw'>('formatted');
  const [query, setQuery] = useState('');
  const [searchResults, setSearchResults] = useState<SearchResult[] | null>(null);
  const [indexedCount, setIndexedCount] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function refreshFiles() {
    setBusy((current) => current ?? 'refresh');
    setError(null);
    try {
      const params = new URLSearchParams({ outputDir });
      const data = await apiJson<{ files: NoteFile[]; indexedCount: number }>(`/api/workers/${WORKER_ID}/files?${params.toString()}`);
      setFiles(Array.isArray(data.files) ? data.files : []);
      setIndexedCount(Number(data.indexedCount ?? 0));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy((current) => current === 'refresh' ? null : current);
    }
  }

  async function openFile(name: string) {
    setBusy('read');
    setError(null);
    try {
      const data = await apiJson<{ name: string; path: string; content: string }>(`/api/workers/${WORKER_ID}/file`, {
        method: 'POST',
        body: JSON.stringify({ outputDir, filename: name }),
      });
      setSelected(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  async function uploadFile(file: File | null) {
    if (!file) return;
    setBusy('upload');
    setNotice(null);
    setError(null);
    try {
      if (file.size > MAX_UPLOAD_BYTES) throw new Error('Keep uploads under 1 MB.');
      const content = await file.text();
      const data = await apiJson<{ ok: boolean; name: string; message: string }>(`/api/workers/${WORKER_ID}/upload`, {
        method: 'POST',
        body: JSON.stringify({ outputDir, filename: file.name, content }),
      });
      setNotice(data.message);
      if (data.ok) {
        await refreshFiles();
        await openFile(data.name);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  async function indexFolder() {
    setBusy('index');
    setNotice(null);
    setError(null);
    try {
      const data = await apiJson<{ indexedCount: number; errorCount: number }>(`/api/workers/${WORKER_ID}/index`, {
        method: 'POST',
        body: JSON.stringify({ outputDir, limit: 20 }),
      });
      setNotice(`Indexed ${data.indexedCount} file${data.indexedCount === 1 ? '' : 's'}${data.errorCount ? `; ${data.errorCount} skipped` : ''}.`);
      await refreshFiles();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  async function search() {
    const trimmed = query.trim();
    if (!trimmed) return;
    setBusy('search');
    setNotice(null);
    setError(null);
    try {
      const data = await apiJson<{ indexedCount: number; results: SearchResult[] }>(`/api/workers/${WORKER_ID}/search`, {
        method: 'POST',
        body: JSON.stringify({ outputDir, query: trimmed, limit: 8 }),
      });
      setIndexedCount(Number(data.indexedCount ?? 0));
      setSearchResults(Array.isArray(data.results) ? data.results : []);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  useEffect(() => {
    void refreshFiles();
  }, [outputDir]);

  const formatted = selected ? markdownToHtml(selected.content) : '';

  return (
    <section className="panel tab-page">
      <div className="panel-head">
        <div>
          <p className="panel-kicker">Notes folder</p>
          <h2>Browse, preview, upload, and search notes</h2>
        </div>
        <StatusPill tone={indexedCount > 0 ? 'good' : 'muted'}>{indexedCount} indexed</StatusPill>
      </div>

      <div className="detail-body">
        <div className="detail-grid">
          <div className="detail"><span>Folder</span><strong>{outputDir}</strong></div>
          <div className="detail"><span>Files</span><strong>{String(files.length)}</strong></div>
        </div>

        <div className="panel-actions">
          <button type="button" onClick={() => void refreshFiles()} disabled={busy === 'refresh'}>Refresh</button>
          <button type="button" onClick={() => void indexFolder()} disabled={busy === 'index' || files.length === 0}>Index folder</button>
          <label className="file-picker">
            <span>{busy === 'upload' ? 'Uploading...' : 'Upload .md'}</span>
            <input
              type="file"
              accept=".md,.markdown,text/markdown,text/plain"
              disabled={busy === 'upload'}
              onChange={(event) => {
                const file = event.currentTarget.files?.[0] ?? null;
                event.currentTarget.value = '';
                void uploadFile(file);
              }}
            />
          </label>
        </div>
        <p className="empty-state">Uploads use the Actions approval flow before BFrost writes the file into the folder.</p>

        <div className="field">
          <span>Semantic search</span>
          <div className="list-custom-entry">
            <input
              type="search"
              value={query}
              placeholder="Search notes by meaning"
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  void search();
                }
              }}
            />
            <button type="button" onClick={() => void search()} disabled={busy === 'search' || !query.trim()}>
              Search
            </button>
          </div>
          <small>Uses the embedding model selected in BFrost Config. Click Index folder for files that were already there.</small>
        </div>

        {notice ? <p className="empty-state">{notice}</p> : null}
        {error ? <p className="empty-state warning">{error}</p> : null}

        {searchResults ? (
          <div className="stack-list compact">
            {searchResults.map((result) => (
              <button className="summary-row" type="button" key={result.path} onClick={() => void openFile(result.name)}>
                <div>
                  <strong>{result.name}</strong>
                  <span>{result.excerpt || result.path}</span>
                  <span>{formatDate(result.updatedAt)} · score {result.score}</span>
                </div>
                <StatusPill tone="info">{result.provider}</StatusPill>
              </button>
            ))}
            {searchResults.length === 0 ? <p className="empty-state">No semantic matches yet. Index the folder or save a new note first.</p> : null}
          </div>
        ) : null}

        <div className="detail-grid">
          <div className="stack-list compact">
            {files.map((file) => (
              <button className="summary-row" type="button" key={file.path} onClick={() => void openFile(file.name)}>
                <div>
                  <strong>{file.name}</strong>
                  <span>{formatBytes(file.sizeBytes)} · {formatDate(file.updatedAt)}</span>
                  <span>{file.path}</span>
                </div>
                <StatusPill tone={file.indexed ? 'good' : 'muted'}>{file.indexed ? 'indexed' : 'not indexed'}</StatusPill>
              </button>
            ))}
            {files.length === 0 ? <p className="empty-state">No Markdown files found in the configured notes folder.</p> : null}
          </div>

          <div className="detail-section">
            <div className="panel-head">
              <div>
                <p className="panel-kicker">Preview</p>
                <h2>{selected?.name ?? 'Select a file'}</h2>
              </div>
              {selected ? (
                <div className="panel-actions">
                  <button type="button" aria-pressed={viewMode === 'formatted'} onClick={() => setViewMode('formatted')}>Formatted</button>
                  <button type="button" aria-pressed={viewMode === 'raw'} onClick={() => setViewMode('raw')}>Raw</button>
                </div>
              ) : null}
            </div>
            {selected ? (
              viewMode === 'formatted' ? (
                <div
                  className="detail-body"
                  style={{ maxHeight: 520, overflow: 'auto' }}
                  dangerouslySetInnerHTML={{ __html: formatted }}
                />
              ) : (
                <pre className="detail-body" style={{ maxHeight: 520, overflow: 'auto', whiteSpace: 'pre-wrap' }}>{selected.content}</pre>
              )
            ) : (
              <p className="empty-state">Choose a note from the list to preview it here.</p>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}

function MarkdownNotesDashboard(ctx: any) {
  const StatusPill = ctx.StatusPill ?? ((props: any) => <span>{props.children}</span>);
  const Detail = ctx.Detail ?? ((props: any) => <div className="detail"><span>{props.label}</span><strong>{props.value}</strong></div>);
  const slice = ctx.dashboard?.workerData?.[WORKER_ID] ?? {};
  const recentNotes = Array.isArray(slice.recentNotes) ? slice.recentNotes : [];
  const availableItemTypes = Array.isArray(slice.availableItemTypes) ? slice.availableItemTypes : [];
  const lastRun = slice.lastRun ?? null;
  const job = ctx.dashboard?.cron?.jobs?.find((entry: any) => entry.name === JOB_ID);
  const approvalNeeded = recentNotes.filter((item: any) => item.metadata?.[WORKER_ID]?.status === 'approval-needed').length;

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
              onClick={() => ctx.triggerRun?.('run-markdown-notes', `/api/cron-jobs/${JOB_ID}/run`, 'Markdown note run started.')}
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

      <NotesFolderPanel ctx={ctx} StatusPill={StatusPill} />

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
            const meta = item.metadata?.[WORKER_ID] ?? {};
            return (
              <button className="summary-row" type="button" key={item.id} onClick={() => ctx.setSelectedQueueItemId?.(item.id)}>
                <div>
                  <strong>{item.title}</strong>
                  <span>{meta.filePath || item.shortDesc}</span>
                  <span>{formatDate(meta.requestedAt)} · {meta.semanticIndexStatus || 'index pending'}</span>
                </div>
                <StatusPill tone={meta.status === 'written' ? 'good' : meta.error ? 'warning' : 'info'}>{meta.status || 'noted'}</StatusPill>
              </button>
            );
          })}
          {recentNotes.length === 0 ? <p className="empty-state">No note files have been requested yet.</p> : null}
        </div>
      </section>

      <MarkdownGuide itemTypes={availableItemTypes} />
    </>
  );
}

window.bfrost.registerDashboardView({
  workerId: WORKER_ID,
  kind: 'worker-dashboard',
  surfaceIds: ['markdown-notes-dashboard'],
  menu: {
    icon: 'file-text',
    group: 'Workers',
    order: 36,
    label: 'Notes',
  },
  count: (ctx: any) => {
    const items = ctx.dashboard?.workerData?.[WORKER_ID]?.recentNotes ?? [];
    return Array.isArray(items)
      ? items.filter((item: any) => item.metadata?.[WORKER_ID]?.status === 'approval-needed').length
      : undefined;
  },
  render: (ctx: any) => <MarkdownNotesDashboard {...ctx} />,
  queueItemDetail: (item: any) => {
    const meta = item?.metadata?.[WORKER_ID];
    if (!meta) return null;
    return (
      <div className="detail-section">
        <p className="panel-kicker">Markdown note</p>
        <div className="detail-grid">
          {meta.filePath ? <div className="detail"><span>File</span><strong>{meta.filePath}</strong></div> : null}
          {meta.status ? <div className="detail"><span>Status</span><strong>{meta.status}</strong></div> : null}
          {meta.semanticIndexStatus ? <div className="detail"><span>Semantic index</span><strong>{meta.semanticIndexStatus}</strong></div> : null}
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
