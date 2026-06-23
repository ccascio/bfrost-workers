import { useEffect, useMemo, useState } from 'react';

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

function formatDate(value?: string | null): string {
  if (!value) return 'n/a';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

function wpMeta(item: any): Record<string, any> {
  return item?.metadata?.['wordpress-publisher'] ?? {};
}

function linesToList(value: string): string[] {
  return value.split('\n').map((line) => line.trim()).filter(Boolean);
}

function listToLines(value: unknown): string {
  return Array.isArray(value) ? value.filter((entry) => typeof entry === 'string').join('\n') : '';
}

function optionalInt(value: string): number | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const parsed = Number(trimmed);
  return Number.isInteger(parsed) ? parsed : null;
}

function displayText(value: unknown, fallback = ''): string {
  const raw = typeof value === 'string' ? value : fallback;
  const withoutTags = raw.replace(/<[^>]*>/g, ' ');
  if (typeof document === 'undefined') return withoutTags.replace(/\s+/g, ' ').trim();
  const textarea = document.createElement('textarea');
  textarea.innerHTML = withoutTags;
  return textarea.value.replace(/\s+/g, ' ').trim();
}

const workspaceTabs = [
  { id: 'drafts', label: 'Drafts', description: 'Review and publish' },
  { id: 'posts', label: 'Posts', description: 'Import or update' },
  { id: 'pages', label: 'Pages', description: 'Manage pages' },
  { id: 'taxonomies', label: 'Taxonomies', description: 'Categories and tags' },
  { id: 'media', label: 'Media', description: 'Images and uploads' },
] as const;

function WordPressPublisherStyles() {
  return (
    <style>{`
      .wp-publisher {
        --wp-accent: #3858e9;
        --wp-accent-dark: #163bb8;
        --wp-ink: #111827;
        --wp-green: #18794e;
        --wp-soft-blue: rgba(56, 88, 233, 0.08);
        --wp-soft-green: rgba(24, 121, 78, 0.09);
        display: grid;
        gap: 1rem;
      }

      .wp-command-panel {
        position: relative;
        overflow: hidden;
        border-color: rgba(56, 88, 233, 0.16);
        background:
          linear-gradient(135deg, rgba(255,255,255,0.96), rgba(247,250,255,0.94) 52%, rgba(246,255,249,0.92)),
          var(--panel);
      }

      .wp-command-panel::before {
        content: '';
        position: absolute;
        inset: 0 0 auto;
        height: 4px;
        background: linear-gradient(90deg, var(--wp-accent), var(--wp-green));
      }

      .wp-command-main {
        display: grid;
        grid-template-columns: minmax(0, 1fr) auto;
        gap: 1.2rem;
        align-items: start;
      }

      .wp-command-title {
        display: grid;
        gap: 0.45rem;
      }

      .wp-command-title h2 {
        margin: 0;
        color: var(--wp-ink);
        font-size: clamp(1.8rem, 3.1vw, 2.6rem);
        line-height: 1.05;
      }

      .wp-command-title p {
        max-width: 58rem;
        margin: 0;
        color: var(--muted);
        font-size: 0.98rem;
        line-height: 1.55;
      }

      .wp-command-actions {
        display: grid;
        justify-items: end;
        gap: 0.7rem;
      }

      .wp-command-actions button {
        min-width: 9.5rem;
        justify-content: center;
        background: var(--wp-ink);
        color: #fff;
        border-color: var(--wp-ink);
      }

      .wp-command-actions button:hover:not(:disabled) {
        background: var(--wp-accent-dark);
        border-color: var(--wp-accent-dark);
      }

      .wp-status-grid {
        display: grid;
        grid-template-columns: repeat(4, minmax(8.5rem, 1fr));
        gap: 0.75rem;
        margin-top: 1.2rem;
      }

      .wp-stat {
        display: grid;
        gap: 0.2rem;
        min-width: 0;
        padding: 0.85rem 0.95rem;
        border: 1px solid rgba(24, 36, 51, 0.09);
        border-radius: 8px;
        background: rgba(255, 255, 255, 0.7);
      }

      .wp-stat span {
        color: var(--muted);
        font-size: 0.78rem;
        font-weight: 700;
        text-transform: uppercase;
      }

      .wp-stat strong {
        color: var(--wp-ink);
        font-size: 1.35rem;
        line-height: 1.1;
      }

      .wp-tabs {
        position: sticky;
        top: 0.75rem;
        z-index: 5;
        display: grid;
        grid-template-columns: repeat(5, minmax(8rem, 1fr));
        gap: 0.45rem;
        padding: 0.45rem;
        border: 1px solid rgba(24, 36, 51, 0.08);
        border-radius: 8px;
        background: rgba(255, 255, 255, 0.86);
        box-shadow: 0 12px 30px rgba(15, 23, 42, 0.08);
        backdrop-filter: blur(10px);
      }

      .wp-tab-button {
        display: grid;
        gap: 0.15rem;
        justify-items: start;
        min-height: 3.4rem;
        padding: 0.65rem 0.8rem;
        box-shadow: none;
        text-align: left;
      }

      .wp-tab-button strong {
        color: var(--text);
        font-size: 0.92rem;
      }

      .wp-tab-button span {
        color: var(--muted);
        font-size: 0.76rem;
      }

      .wp-tab-button[aria-pressed="true"] {
        border-color: rgba(56, 88, 233, 0.28);
        background: var(--wp-soft-blue);
      }

      .wp-review-workspace {
        display: grid;
        grid-template-columns: minmax(18rem, 24rem) minmax(0, 1fr);
        gap: 1rem;
        align-items: start;
      }

      .wp-left-rail {
        position: sticky;
        top: 6rem;
        display: grid;
        gap: 1rem;
        align-self: start;
      }

      .wp-draft-queue {
        max-height: min(34rem, calc(100vh - 28rem));
        overflow: auto;
      }

      .wp-list-toolbar {
        display: flex;
        flex-wrap: wrap;
        gap: 0.5rem;
        align-items: center;
        justify-content: space-between;
      }

      .wp-draft-row {
        display: grid;
        grid-template-columns: minmax(0, 1fr) auto;
        align-items: flex-start;
        text-align: left;
        transition: border-color 0.15s ease, background 0.15s ease, transform 0.15s ease;
      }

      .wp-draft-row .status-pill {
        white-space: nowrap;
      }

      .wp-draft-row:hover:not(:disabled) {
        transform: translateY(-1px);
      }

      .wp-draft-row.selected {
        border-color: rgba(56, 88, 233, 0.38);
        background: rgba(56, 88, 233, 0.08);
      }

      .wp-editor-panel {
        min-width: 0;
      }

      .wp-editor-panel > .panel-head {
        align-items: flex-start;
        padding-bottom: 0.9rem;
        border-bottom: 1px solid rgba(24, 36, 51, 0.08);
      }

      .wp-editor-layout {
        display: grid;
        grid-template-columns: minmax(0, 1fr);
        gap: 1rem;
        align-items: start;
      }

      .wp-editor-main {
        min-width: 0;
      }

      .wp-editor-sidebar {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 0.85rem;
        min-width: 0;
      }

      .wp-editor-card {
        margin: 0;
        min-width: 0;
        max-width: 100%;
        box-shadow: none;
        background: rgba(255, 255, 255, 0.58);
      }

      .wp-editor-card input,
      .wp-editor-card select,
      .wp-editor-card textarea {
        min-width: 0;
        max-width: 100%;
      }

      .wp-publish-card {
        grid-column: 1 / -1;
      }

      .wp-publish-card .detail-grid {
        grid-template-columns: repeat(4, minmax(0, 1fr));
      }

      .wp-left-rail .wp-publish-card .detail-grid {
        grid-template-columns: repeat(2, minmax(0, 1fr));
      }

      .wp-publish-controls {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 0.75rem;
      }

      .wp-left-rail .wp-publish-controls,
      .wp-left-rail .wp-sidebar-actions {
        grid-template-columns: 1fr;
      }

      .wp-title-input {
        font-size: 1.55rem;
        font-weight: 750;
        letter-spacing: 0;
        padding: 0.95rem 1rem;
      }

      .wp-editor-mode {
        display: inline-flex;
        flex-wrap: wrap;
        gap: 0.45rem;
        padding: 0.35rem;
        border: 1px solid rgba(24, 36, 51, 0.08);
        border-radius: 8px;
        background: rgba(255, 255, 255, 0.62);
      }

      .wp-editor-canvas {
        margin-top: 0.9rem;
        min-height: 500px;
        border: 1px solid rgba(24, 36, 51, 0.11);
        border-radius: 8px;
        background: #fff;
        box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.9);
      }

      .wp-editor-canvas-body {
        max-width: 820px;
        margin: 0 auto;
        padding: 1.4rem;
        color: #1f2937;
        line-height: 1.65;
      }

      .wp-sidebar-actions {
        display: grid;
        grid-template-columns: repeat(3, minmax(0, 1fr));
        gap: 0.5rem;
      }

      .wp-sidebar-actions a {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        min-height: 2.55rem;
      }

      .wp-toolbar-panel .panel-actions {
        display: grid;
        grid-template-columns: minmax(12rem, 0.9fr) minmax(16rem, 1.25fr) auto;
        align-items: stretch;
      }

      .wp-toolbar-panel .panel-actions > input,
      .wp-toolbar-panel .panel-actions > select {
        width: 100%;
      }

      .wp-toolbar-panel .panel-actions > button {
        min-width: 7.5rem;
        justify-content: center;
        white-space: nowrap;
      }

      .wp-toolbar-panel .summary-row {
        display: grid;
        grid-template-columns: minmax(0, 1fr) minmax(18rem, 32rem);
        align-items: center;
      }

      .wp-toolbar-panel .summary-row .panel-actions {
        display: grid;
        grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
        gap: 0.45rem;
        margin-top: 0;
      }

      .wp-toolbar-panel .summary-row .panel-actions > button {
        white-space: nowrap;
      }

      .wp-toolbar-panel .summary-row .panel-actions > a {
        justify-self: end;
      }

      .wp-toolbar-panel .summary-row .panel-actions > .status-pill {
        justify-content: center;
      }

      .wp-media-thumb {
        width: 72px;
        height: 72px;
        object-fit: cover;
        border: 1px solid var(--border-subtle);
        border-radius: 8px;
      }

      @media (max-width: 1280px) {
        .wp-review-workspace {
          grid-template-columns: 1fr;
        }

        .wp-draft-queue {
          max-height: none;
          overflow: visible;
        }

        .wp-left-rail {
          position: static;
        }
      }

      @media (max-width: 900px) {
        .wp-command-main,
        .wp-status-grid,
        .wp-tabs,
        .wp-editor-sidebar,
        .wp-publish-card .detail-grid,
        .wp-publish-controls,
        .wp-sidebar-actions,
        .wp-toolbar-panel .panel-actions,
        .wp-toolbar-panel .summary-row {
          grid-template-columns: 1fr;
        }

        .wp-command-actions {
          justify-items: stretch;
        }

        .wp-command-actions button {
          width: 100%;
        }

        .wp-tabs {
          position: static;
        }
      }
    `}</style>
  );
}

const wpFullControl = {
  width: '100%',
  boxSizing: 'border-box',
} as const;

function WordPressDashboard(ctx: any) {
  const StatusPill = ctx.StatusPill;
  const Detail = ctx.Detail;
  const slice = ctx.dashboard?.workerData?.['wordpress-publisher'] ?? {};
  const settings = slice.settings ?? {};
  const taxonomy = slice.taxonomy ?? { categories: [], tags: [], capabilities: null, refreshedAt: null };
  const recentPosts = Array.isArray(slice.recentPosts) ? slice.recentPosts : [];
  const recentDrafts = Array.isArray(slice.recentDrafts) ? slice.recentDrafts : [];
  const job = ctx.dashboard?.cron?.jobs?.find((entry: any) => entry.name === 'wordpress-publish');
  const [selectedDraftId, setSelectedDraftId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionBusy, setActionBusy] = useState<string | null>(null);
  const [draftForm, setDraftForm] = useState<Record<string, string>>({});
  const [draftStateFilter, setDraftStateFilter] = useState<string>('active');
  const [draftItems, setDraftItems] = useState<any[]>(recentDrafts);
  const [draftPage, setDraftPage] = useState(1);
  const [draftLoading, setDraftLoading] = useState(false);
  const [workspaceTab, setWorkspaceTab] = useState<'drafts' | 'posts' | 'pages' | 'taxonomies' | 'media'>('drafts');
  const [remoteStatus, setRemoteStatus] = useState<string>('');
  const [remoteSearch, setRemoteSearch] = useState<string>('');
  const [remoteItems, setRemoteItems] = useState<any[]>([]);
  const [remotePage, setRemotePage] = useState(1);
  const [remoteLoading, setRemoteLoading] = useState(false);
  const [remoteError, setRemoteError] = useState<string | null>(null);
  const [mediaItems, setMediaItems] = useState<any[]>([]);
  const [mediaPage, setMediaPage] = useState(1);
  const [mediaSearch, setMediaSearch] = useState('');
  const [mediaSourceUrl, setMediaSourceUrl] = useState('');
  const [mediaAltText, setMediaAltText] = useState('');
  const [mediaLoading, setMediaLoading] = useState(false);
  const [mediaPickerOpen, setMediaPickerOpen] = useState(false);
  const [editorMode, setEditorMode] = useState<'visual' | 'html'>('visual');
  const filteredDrafts = useMemo(() => {
    if (draftStateFilter === 'all') return draftItems;
    if (draftStateFilter === 'active') return draftItems.filter((draft: any) => draft.state !== 'archived' && draft.state !== 'published_to_wp');
    return draftItems.filter((draft: any) => draft.state === draftStateFilter);
  }, [draftItems, draftStateFilter]);
  const selectedDraft = useMemo(
    () => filteredDrafts.find((draft: any) => draft.id === selectedDraftId) ?? filteredDrafts[0] ?? null,
    [filteredDrafts, selectedDraftId],
  );
  useEffect(() => {
    if (!selectedDraft) return;
    setDraftForm({
      title: selectedDraft.title || '',
      slug: selectedDraft.slug || '',
      excerpt: selectedDraft.excerpt || '',
      contentHtml: selectedDraft.contentHtml || '',
      targetStatus: selectedDraft.targetStatus || 'draft',
      publishDate: selectedDraft.publishDate || '',
      pageParent: selectedDraft.pageParent === null || selectedDraft.pageParent === undefined ? '' : String(selectedDraft.pageParent),
      pageMenuOrder: selectedDraft.pageMenuOrder === null || selectedDraft.pageMenuOrder === undefined ? '' : String(selectedDraft.pageMenuOrder),
      pageTemplate: selectedDraft.pageTemplate || '',
      featuredMediaId: selectedDraft.featuredMediaId === null || selectedDraft.featuredMediaId === undefined ? '' : String(selectedDraft.featuredMediaId),
      categorySlugs: listToLines(selectedDraft.categorySlugs),
      tagSlugs: listToLines(selectedDraft.tagSlugs),
      operatorNotes: selectedDraft.operatorNotes || '',
    });
  }, [selectedDraft?.id, selectedDraft?.updatedAt]);

  const postedCount = recentPosts.filter((item: any) => wpMeta(item).postId).length;
  const failedCount = recentPosts.filter((item: any) => wpMeta(item).failedAt).length;
  const selectedDraftLocked = selectedDraft?.state === 'published_to_wp' || selectedDraft?.state === 'archived';
  const remoteCollection = workspaceTab === 'pages' ? 'pages' : 'posts';
  const selectedFeaturedMedia = draftForm.featuredMediaId
    ? mediaItems.find((item: any) => String(item.id) === String(draftForm.featuredMediaId))
    : null;

  function updateDraftForm(key: string, value: string) {
    setDraftForm((current) => ({ ...current, [key]: value }));
  }

  async function loadDraftPage(page = draftPage) {
    setDraftLoading(true);
    setActionError(null);
    try {
      const params = new URLSearchParams({ page: String(page), limit: '20' });
      if (draftStateFilter !== 'all' && draftStateFilter !== 'active') params.set('state', draftStateFilter);
      const data = await apiJson<{ drafts?: any[] }>(`/api/workers/wordpress-publisher/drafts?${params.toString()}`);
      setDraftItems(Array.isArray(data.drafts) ? data.drafts : []);
      setDraftPage(page);
      setSelectedDraftId(null);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setDraftLoading(false);
    }
  }

  async function loadRemoteContent(collection = remoteCollection, page = remotePage) {
    setRemotePage(page);
    setRemoteLoading(true);
    setRemoteError(null);
    try {
      const params = new URLSearchParams({ collection, perPage: '20', page: String(page) });
      if (remoteStatus) params.set('status', remoteStatus);
      if (remoteSearch.trim()) params.set('search', remoteSearch.trim());
      const data = await apiJson<{ items?: any[] }>(`/api/workers/wordpress-publisher/remote-content?${params.toString()}`);
      setRemoteItems(Array.isArray(data.items) ? data.items : []);
    } catch (err) {
      setRemoteError(err instanceof Error ? err.message : String(err));
      setRemoteItems([]);
    } finally {
      setRemoteLoading(false);
    }
  }

  async function loadMedia(page = mediaPage) {
    setMediaPage(page);
    setMediaLoading(true);
    setActionError(null);
    try {
      const params = new URLSearchParams({ perPage: '30', page: String(page) });
      if (mediaSearch.trim()) params.set('search', mediaSearch.trim());
      const data = await apiJson<{ items?: any[] }>(`/api/workers/wordpress-publisher/media?${params.toString()}`);
      setMediaItems(Array.isArray(data.items) ? data.items : []);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
      setMediaItems([]);
    } finally {
      setMediaLoading(false);
    }
  }

  async function assignFeaturedMedia(mediaId: number) {
    if (!selectedDraft?.id) {
      setActionError('Choose a draft in the Drafts tab first, then return to Media to set its featured image.');
      return;
    }
    setActionError(null);
    setActionBusy(`feature-${mediaId}`);
    try {
      await apiJson(`/api/workers/wordpress-publisher/draft?id=${encodeURIComponent(selectedDraft.id)}`, {
        method: 'PATCH',
        body: JSON.stringify({ featuredMediaId: mediaId }),
      });
      updateDraftForm('featuredMediaId', String(mediaId));
      await ctx.refreshDashboard?.();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setActionBusy(null);
    }
  }

  async function chooseFeaturedMedia(mediaId: number) {
    await assignFeaturedMedia(mediaId);
    setMediaPickerOpen(false);
  }

  async function uploadMediaUrl() {
    if (!mediaSourceUrl.trim()) return;
    setMediaLoading(true);
    setActionError(null);
    try {
      const data = await apiJson<{ media?: any }>('/api/workers/wordpress-publisher/media/upload-from-url', {
        method: 'POST',
        body: JSON.stringify({ sourceUrl: mediaSourceUrl.trim(), altText: mediaAltText.trim() }),
      });
      setMediaSourceUrl('');
      setMediaAltText('');
      await loadMedia(1);
      if (data.media?.id && selectedDraft?.id) await chooseFeaturedMedia(Number(data.media.id));
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setMediaLoading(false);
    }
  }

  useEffect(() => {
    if (workspaceTab === 'drafts') void loadDraftPage(1);
    if (workspaceTab === 'posts' || workspaceTab === 'pages') void loadRemoteContent(workspaceTab === 'pages' ? 'pages' : 'posts', 1);
    if (workspaceTab === 'media') void loadMedia(1);
  }, [workspaceTab, draftStateFilter]);

  async function improveDraftField(field: string, label: string) {
    if (!selectedDraft?.id) return;
    const instruction = prompt(`How should BFrost improve the ${label}?`, `Improve the ${label} while preserving the current intent.`);
    if (!instruction?.trim()) return;
    setActionError(null);
    setActionBusy(`improve-${field}`);
    try {
      const data = await apiJson<{ draft?: any }>(`/api/workers/wordpress-publisher/draft/improve-field?id=${encodeURIComponent(selectedDraft.id)}`, {
        method: 'POST',
        body: JSON.stringify({ field, instruction }),
      });
      const draft = data.draft;
      if (draft) {
        setDraftForm({
          title: draft.title || '',
          slug: draft.slug || '',
          excerpt: draft.excerpt || '',
          contentHtml: draft.contentHtml || '',
          targetStatus: draft.targetStatus || 'draft',
          publishDate: draft.publishDate || '',
          pageParent: draft.pageParent === null || draft.pageParent === undefined ? '' : String(draft.pageParent),
          pageMenuOrder: draft.pageMenuOrder === null || draft.pageMenuOrder === undefined ? '' : String(draft.pageMenuOrder),
          pageTemplate: draft.pageTemplate || '',
          featuredMediaId: draft.featuredMediaId === null || draft.featuredMediaId === undefined ? '' : String(draft.featuredMediaId),
          categorySlugs: listToLines(draft.categorySlugs),
          tagSlugs: listToLines(draft.tagSlugs),
          operatorNotes: draft.operatorNotes || '',
        });
      }
      await ctx.refreshDashboard?.();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setActionBusy(null);
    }
  }

  async function saveDraftEdits(draft: any) {
    if (!draft?.id) return;
    setActionError(null);
    setActionBusy(`save-${draft.id}`);
    try {
      await apiJson(`/api/workers/wordpress-publisher/draft?id=${encodeURIComponent(draft.id)}`, {
        method: 'PATCH',
        body: JSON.stringify({
          title: draftForm.title || '',
          slug: draftForm.slug || '',
          excerpt: draftForm.excerpt || '',
          contentHtml: draftForm.contentHtml || '',
          targetStatus: draftForm.targetStatus || 'draft',
          publishDate: draftForm.publishDate || '',
          pageParent: optionalInt(draftForm.pageParent || ''),
          pageMenuOrder: optionalInt(draftForm.pageMenuOrder || ''),
          pageTemplate: draftForm.pageTemplate || '',
          featuredMediaId: optionalInt(draftForm.featuredMediaId || ''),
          categorySlugs: linesToList(draftForm.categorySlugs || ''),
          tagSlugs: linesToList(draftForm.tagSlugs || ''),
          operatorNotes: draftForm.operatorNotes || '',
        }),
      });
      await ctx.refreshDashboard?.();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setActionBusy(null);
    }
  }

  async function importRemoteContent(item: any) {
    if (!item?.id) return;
    setActionError(null);
    setActionBusy(`import-${item.id}`);
    try {
      const data = await apiJson<{ draft?: any }>('/api/workers/wordpress-publisher/remote-content/import', {
        method: 'POST',
        body: JSON.stringify({ collection: remoteCollection, id: Number(item.id) }),
      });
      if (data.draft?.id) {
        setWorkspaceTab('drafts');
        setSelectedDraftId(data.draft.id);
      }
      await ctx.refreshDashboard?.();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setActionBusy(null);
    }
  }

  async function updateRemoteFromDraft(item: any) {
    if (!item?.id || !selectedDraft?.id) return;
    const confirmation = prompt(`This will overwrite WordPress ${remoteCollection.slice(0, -1)} #${item.id} with the selected draft. Type UPDATE ${item.id} to continue:`);
    if (confirmation !== `UPDATE ${item.id}`) return;
    setActionError(null);
    setActionBusy(`update-remote-${item.id}`);
    try {
      await apiJson('/api/workers/wordpress-publisher/remote-content/update-from-draft', {
        method: 'POST',
        body: JSON.stringify({ collection: remoteCollection, id: Number(item.id), draftId: selectedDraft.id }),
      });
      await loadRemoteContent(remoteCollection);
      await ctx.refreshDashboard?.();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setActionBusy(null);
    }
  }

  async function archiveDraft(draft: any) {
    if (!draft?.id) return;
    if (!confirm(`Archive draft "${draft.title || draft.id}"? This does not delete anything from WordPress.`)) return;
    setActionError(null);
    setActionBusy(`archive-${draft.id}`);
    try {
      await apiJson(`/api/workers/wordpress-publisher/draft/archive?id=${encodeURIComponent(draft.id)}`, { method: 'POST' });
      setSelectedDraftId(null);
      await ctx.refreshDashboard?.();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setActionBusy(null);
    }
  }

  async function publishDraft(draft: any) {
    if (!draft?.id) return;
    if (!confirm(`Create this ${draft.contentType || 'post'} in WordPress as ${draft.targetStatus || 'draft'}?`)) return;
    setActionError(null);
    setActionBusy(`publish-${draft.id}`);
    try {
      await apiJson(`/api/workers/wordpress-publisher/draft/publish?id=${encodeURIComponent(draft.id)}`, { method: 'POST' });
      await ctx.refreshDashboard?.();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setActionBusy(null);
    }
  }

  async function requestChanges(draft: any) {
    if (!draft?.id) return;
    const changeRequest = prompt('What should the LLM change in the next revision?');
    if (!changeRequest?.trim()) return;
    setActionError(null);
    setActionBusy(`changes-${draft.id}`);
    try {
      await apiJson(`/api/workers/wordpress-publisher/draft/request-changes?id=${encodeURIComponent(draft.id)}`, {
        method: 'POST',
        body: JSON.stringify({ changeRequest }),
      });
      await ctx.refreshDashboard?.();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setActionBusy(null);
    }
  }

  async function regenerateDraft(draft: any) {
    if (!draft?.id) return;
    const fallback = draft.changeRequest || '';
    const changeRequest = prompt('Regenerate using this change request:', fallback);
    if (!changeRequest?.trim()) return;
    setActionError(null);
    setActionBusy(`regenerate-${draft.id}`);
    try {
      await apiJson(`/api/workers/wordpress-publisher/draft/regenerate?id=${encodeURIComponent(draft.id)}`, {
        method: 'POST',
        body: JSON.stringify({ changeRequest }),
      });
      await ctx.refreshDashboard?.();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setActionBusy(null);
    }
  }

  return (
    <div className="wp-publisher">
      <WordPressPublisherStyles />

      <section className="panel tab-page wp-command-panel">
        <div className="wp-command-main">
          <div className="wp-command-title">
            <p className="panel-kicker">WordPress Publisher</p>
            <h2>Review, refine, and ship WordPress content</h2>
            <p>
              Turn approved queue items into local drafts, polish them in BFrost, then publish to WordPress only when the draft is ready.
            </p>
          </div>
          <div className="wp-command-actions">
            <StatusPill tone={slice.configured ? 'good' : 'warning'}>
              {slice.configured ? 'configured' : 'setup needed'}
            </StatusPill>
            <button
              type="button"
              disabled={ctx.busyKey === 'run-wordpress-publish' || job?.running || !slice.configured}
              onClick={() => ctx.triggerRun('run-wordpress-publish', '/api/cron-jobs/wordpress-publish/run', 'WordPress publish started.')}
            >
              {job?.running ? 'Running...' : 'Run now'}
            </button>
          </div>
        </div>
        <div className="wp-status-grid">
          <div className="wp-stat">
            <span>Active drafts</span>
            <strong>{String(recentDrafts.filter((draft: any) => draft.state !== 'archived' && draft.state !== 'published_to_wp').length)}</strong>
          </div>
          <div className="wp-stat">
            <span>Published</span>
            <strong>{String(postedCount)}</strong>
          </div>
          <div className="wp-stat">
            <span>Failures</span>
            <strong>{String(failedCount)}</strong>
          </div>
          <div className="wp-stat">
            <span>Taxonomy cache</span>
            <strong>{taxonomy.refreshedAt ? `${taxonomy.categories?.length ?? 0}/${taxonomy.tags?.length ?? 0}` : 'empty'}</strong>
          </div>
        </div>
      </section>

      <nav className="wp-tabs tab-page" aria-label="WordPress publisher workspace">
        {workspaceTabs.map((tab) => (
          <button
            key={tab.id}
            type="button"
            className="wp-tab-button"
            aria-pressed={workspaceTab === tab.id}
            onClick={() => setWorkspaceTab(tab.id)}
          >
            <strong>{tab.label}</strong>
            <span>{tab.description}</span>
          </button>
        ))}
      </nav>

      {workspaceTab === 'drafts' ? (
      <div className="wp-review-workspace tab-page">
      <div className="wp-left-rail">
        <section className="panel wp-draft-queue">
          <div className="panel-head">
            <div>
              <p className="panel-kicker">Review queue</p>
              <h2>Drafts and activity</h2>
            </div>
            <StatusPill tone={failedCount > 0 ? 'warning' : filteredDrafts.length > 0 ? 'info' : postedCount > 0 ? 'info' : 'muted'}>
              {filteredDrafts.length} drafts
            </StatusPill>
          </div>
          <div className="wp-list-toolbar" style={{ marginTop: '1rem' }}>
            <div className="panel-actions" style={{ marginTop: 0 }}>
              <select value={draftStateFilter} onChange={(event) => { setDraftPage(1); setDraftStateFilter(event.currentTarget.value); }}>
                <option value="active">Active drafts</option>
                <option value="generated">Generated</option>
                <option value="needs_changes">Needs changes</option>
                <option value="failed">Failed</option>
                <option value="published_to_wp">Published</option>
                <option value="archived">Archived</option>
                <option value="all">All</option>
              </select>
              <button type="button" disabled={draftLoading} onClick={() => void loadDraftPage(1)}>Refresh</button>
            </div>
            <span className="footnote">Page {draftPage}</span>
          </div>
          <div className="stack-list compact">
            {filteredDrafts.map((draft: any) => (
              <button
                className={`summary-row wp-draft-row${selectedDraft?.id === draft.id ? ' selected' : ''}`}
                type="button"
                key={draft.id}
                onClick={() => setSelectedDraftId(draft.id)}
              >
                <div>
                  <strong>{displayText(draft.title, 'Untitled draft')}</strong>
                  <span>{displayText(draft.excerpt, 'Generated draft waiting for review.')}</span>
                  <span>{formatDate(draft.updatedAt)}</span>
                </div>
                <StatusPill tone={draft.state === 'needs_changes' ? 'warning' : draft.state === 'published_to_wp' ? 'good' : draft.state === 'archived' ? 'muted' : 'info'}>
                  {draft.state || 'generated'}
                </StatusPill>
              </button>
            ))}
            {filteredDrafts.length === 0 ? null : <hr />}
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
                    <strong>{displayText(item.title, 'Untitled item')}</strong>
                    <span>{displayText(meta.postUrl || item.shortDesc)}</span>
                    <span>{formatDate(meta.postedAt || meta.failedAt || item.stateChangedAt)}</span>
                  </div>
                  <StatusPill tone={meta.failedAt ? 'warning' : 'good'}>{meta.failedAt ? 'failed' : (meta.postStatus || 'posted')}</StatusPill>
                </button>
              );
            })}
            {recentPosts.length === 0 && filteredDrafts.length === 0 ? <p className="empty-state">No WordPress drafts match this filter. Run the job to generate one for review.</p> : null}
          </div>
          <div className="panel-actions">
            <button type="button" disabled={draftLoading || draftPage <= 1} onClick={() => void loadDraftPage(draftPage - 1)}>Previous drafts</button>
            <span>Page {draftPage}</span>
            <button type="button" disabled={draftLoading || draftItems.length < 20} onClick={() => void loadDraftPage(draftPage + 1)}>Next drafts</button>
          </div>
        </section>

        {selectedDraft ? (
          <section className="panel wp-editor-card wp-publish-card">
            <div className="panel-head">
              <div>
                <p className="panel-kicker">Publish</p>
                <h3>Status and actions</h3>
              </div>
            </div>
            <div className="detail-grid">
              <Detail label="Type" value={selectedDraft.contentType || 'post'} />
              <Detail label="Updated" value={formatDate(selectedDraft.updatedAt)} />
              <Detail label="Versions" value={String(selectedDraft.versionCount ?? 1)} />
              <Detail label="WordPress" value={selectedDraft.wpLink ? selectedDraft.wpLink : 'not sent yet'} />
            </div>
            <div className="wp-publish-controls">
              <label className="detail-block">
                <span>Status</span>
                <select style={wpFullControl} value={draftForm.targetStatus || 'draft'} disabled={selectedDraftLocked} onChange={(event) => updateDraftForm('targetStatus', event.currentTarget.value)}>
                  <option value="draft">Draft</option>
                  <option value="pending">Pending review</option>
                  <option value="private">Private</option>
                  <option value="publish">Publish immediately</option>
                  <option value="future">Future</option>
                </select>
              </label>
              <label className="detail-block">
                <span>Publish date</span>
                <input style={wpFullControl} type="datetime-local" value={draftForm.publishDate || ''} disabled={selectedDraftLocked} onChange={(event) => updateDraftForm('publishDate', event.currentTarget.value)} />
              </label>
            </div>
            <div className="wp-sidebar-actions">
              <button type="button" disabled={Boolean(actionBusy) || selectedDraftLocked} onClick={() => void saveDraftEdits(selectedDraft)}>
                {actionBusy === `save-${selectedDraft.id}` ? 'Saving...' : 'Save local draft'}
              </button>
              <button type="button" disabled={Boolean(actionBusy) || selectedDraftLocked} onClick={() => void publishDraft(selectedDraft)}>
                {actionBusy === `publish-${selectedDraft.id}` ? 'Publishing...' : `Create ${selectedDraft.contentType || 'post'} in WordPress`}
              </button>
              <button type="button" disabled={Boolean(actionBusy) || selectedDraft.state === 'archived'} onClick={() => void archiveDraft(selectedDraft)}>
                {actionBusy === `archive-${selectedDraft.id}` ? 'Archiving...' : 'Archive'}
              </button>
              {selectedDraft.wpLink ? <a href={selectedDraft.wpLink} target="_blank" rel="noreferrer">Open WordPress</a> : null}
            </div>
          </section>
        ) : null}
      </div>

      {selectedDraft ? (
        <section className="panel wp-editor-panel">
          <div className="panel-head">
            <div>
              <p className="panel-kicker">Review workspace</p>
              <h2>{displayText(draftForm.title || selectedDraft.title, 'Untitled draft')}</h2>
              <p className="footnote">Local BFrost draft. Use the Publish panel when you are ready to write to WordPress.</p>
            </div>
            <StatusPill tone={selectedDraft.state === 'failed' ? 'warning' : selectedDraft.state === 'published_to_wp' ? 'good' : selectedDraft.state === 'archived' ? 'muted' : 'info'}>
              {selectedDraft.state}
            </StatusPill>
          </div>

          {selectedDraft.errorMessage ? <p className="error-text">{selectedDraft.errorMessage}</p> : null}
          {actionError ? <p className="error-text">{actionError}</p> : null}

          <div className="wp-editor-layout">
            <div className="detail-body wp-editor-main">
              <label className="detail-block">
                <span>Title <button type="button" disabled={selectedDraftLocked || Boolean(actionBusy)} onClick={() => void improveDraftField('title', 'title')}>Improve</button></span>
                <input
                  className="wp-title-input"
                  type="text"
                  value={draftForm.title || ''}
                  disabled={selectedDraftLocked}
                  placeholder="Add title"
                  onChange={(event) => updateDraftForm('title', event.currentTarget.value)}
                />
              </label>
              <label className="detail-block">
                <span>Permalink / slug <button type="button" disabled={selectedDraftLocked || Boolean(actionBusy)} onClick={() => void improveDraftField('slug', 'slug')}>Improve</button></span>
                <input type="text" value={draftForm.slug || ''} disabled={selectedDraftLocked} placeholder="post-url-slug" onChange={(event) => updateDraftForm('slug', event.currentTarget.value)} />
              </label>

              <div className="wp-editor-mode" style={{ marginTop: '1rem' }}>
                <button type="button" className={editorMode === 'visual' ? 'primary' : ''} onClick={() => setEditorMode('visual')}>Visual</button>
                <button type="button" className={editorMode === 'html' ? 'primary' : ''} onClick={() => setEditorMode('html')}>HTML</button>
                <button type="button" disabled={selectedDraftLocked || Boolean(actionBusy)} onClick={() => void improveDraftField('contentHtml', 'HTML body')}>Improve body</button>
              </div>

              {editorMode === 'html' ? (
                <label className="detail-block">
                  <span>HTML body</span>
                  <textarea rows={22} value={draftForm.contentHtml || ''} disabled={selectedDraftLocked} onChange={(event) => updateDraftForm('contentHtml', event.currentTarget.value)} />
                </label>
              ) : (
                <div className="wp-editor-canvas">
                  <div className="detail-body wp-editor-canvas-body" dangerouslySetInnerHTML={{ __html: draftForm.contentHtml || selectedDraft.contentHtml || '<p>No content.</p>' }} />
                </div>
              )}

              <label className="detail-block">
                <span>Excerpt <button type="button" disabled={selectedDraftLocked || Boolean(actionBusy)} onClick={() => void improveDraftField('excerpt', 'excerpt')}>Improve</button></span>
                <textarea rows={4} value={draftForm.excerpt || ''} disabled={selectedDraftLocked} onChange={(event) => updateDraftForm('excerpt', event.currentTarget.value)} />
              </label>
            </div>

            <aside className="detail-body wp-editor-sidebar">
              <section className="panel wp-editor-card">
                <div className="panel-head">
                  <div>
                    <p className="panel-kicker">Featured image</p>
                    <h3>Media</h3>
                  </div>
                </div>
                {selectedFeaturedMedia?.thumbnailUrl ? (
                  <img
                    src={selectedFeaturedMedia.thumbnailUrl}
                    alt={selectedFeaturedMedia.altText || selectedFeaturedMedia.title || 'Featured image'}
                    style={{ width: '100%', maxHeight: 180, objectFit: 'cover', borderRadius: 12, border: '1px solid var(--border-subtle)' }}
                  />
                ) : draftForm.featuredMediaId ? (
                  <p className="empty-state">Selected media ID: {draftForm.featuredMediaId}</p>
                ) : (
                  <p className="empty-state">No featured image selected.</p>
                )}
                <div className="panel-actions">
                  <button type="button" disabled={selectedDraftLocked || !slice.configured} onClick={() => { setMediaPickerOpen(true); void loadMedia(); }}>Choose image</button>
                  <button type="button" disabled={selectedDraftLocked || !draftForm.featuredMediaId} onClick={() => updateDraftForm('featuredMediaId', '')}>Remove</button>
                </div>
              </section>

              <section className="panel wp-editor-card">
                <div className="panel-head">
                  <div>
                    <p className="panel-kicker">Taxonomies</p>
                    <h3>Categories and tags</h3>
                  </div>
                </div>
                <label className="detail-block">
                  <span>Category slugs <button type="button" disabled={selectedDraftLocked || Boolean(actionBusy)} onClick={() => void improveDraftField('categorySlugs', 'category slugs')}>Improve</button></span>
                  <textarea style={wpFullControl} rows={4} value={draftForm.categorySlugs || ''} disabled={selectedDraftLocked} onChange={(event) => updateDraftForm('categorySlugs', event.currentTarget.value)} />
                </label>
                <label className="detail-block">
                  <span>Tag slugs <button type="button" disabled={selectedDraftLocked || Boolean(actionBusy)} onClick={() => void improveDraftField('tagSlugs', 'tag slugs')}>Improve</button></span>
                  <textarea style={wpFullControl} rows={4} value={draftForm.tagSlugs || ''} disabled={selectedDraftLocked} onChange={(event) => updateDraftForm('tagSlugs', event.currentTarget.value)} />
                </label>
              </section>

              {selectedDraft.contentType === 'page' ? (
                <section className="panel wp-editor-card">
                  <div className="panel-head">
                    <div>
                      <p className="panel-kicker">Page</p>
                      <h3>Page attributes</h3>
                    </div>
                  </div>
                  <label className="detail-block">
                    <span>Parent page ID</span>
                    <input style={wpFullControl} type="number" value={draftForm.pageParent || ''} disabled={selectedDraftLocked} onChange={(event) => updateDraftForm('pageParent', event.currentTarget.value)} />
                  </label>
                  <label className="detail-block">
                    <span>Menu order</span>
                    <input style={wpFullControl} type="number" value={draftForm.pageMenuOrder || ''} disabled={selectedDraftLocked} onChange={(event) => updateDraftForm('pageMenuOrder', event.currentTarget.value)} />
                  </label>
                  <label className="detail-block">
                    <span>Template</span>
                    <input style={wpFullControl} type="text" value={draftForm.pageTemplate || ''} disabled={selectedDraftLocked} placeholder="default or theme template slug" onChange={(event) => updateDraftForm('pageTemplate', event.currentTarget.value)} />
                  </label>
                </section>
              ) : null}

              <section className="panel wp-editor-card">
                <div className="panel-head">
                  <div>
                    <p className="panel-kicker">AI tools</p>
                    <h3>Improve draft</h3>
                  </div>
                </div>
                {selectedDraft.changeRequest ? <blockquote><strong>Requested changes:</strong> {selectedDraft.changeRequest}</blockquote> : null}
                <div className="panel-actions">
                  <button type="button" disabled={Boolean(actionBusy) || selectedDraftLocked} onClick={() => void requestChanges(selectedDraft)}>Request changes</button>
                  <button type="button" disabled={Boolean(actionBusy) || selectedDraftLocked} onClick={() => void regenerateDraft(selectedDraft)}>
                    {actionBusy === `regenerate-${selectedDraft.id}` ? 'Regenerating...' : 'Regenerate draft'}
                  </button>
                  <button type="button" disabled={selectedDraftLocked || Boolean(actionBusy)} onClick={() => void improveDraftField('title', 'title')}>Improve title</button>
                  <button type="button" disabled={selectedDraftLocked || Boolean(actionBusy)} onClick={() => void improveDraftField('excerpt', 'excerpt')}>Improve excerpt</button>
                </div>
                <label className="detail-block">
                  <span>Operator notes</span>
                  <textarea style={wpFullControl} rows={3} value={draftForm.operatorNotes || ''} disabled={selectedDraftLocked} onChange={(event) => updateDraftForm('operatorNotes', event.currentTarget.value)} />
                </label>
              </section>
            </aside>
          </div>
        </section>
      ) : (
        <section className="panel wp-editor-panel">
          <div className="panel-head">
            <div>
              <p className="panel-kicker">Review workspace</p>
              <h2>No draft selected</h2>
              <p className="footnote">Choose a draft from the review queue or run the worker to generate a new local draft.</p>
            </div>
          </div>
          <p className="empty-state">No WordPress drafts match this filter. Run the job or change the filter to review older drafts.</p>
        </section>
      )}
      </div>
      ) : null}

      {workspaceTab === 'posts' || workspaceTab === 'pages' ? (
        <section className="panel tab-page wp-toolbar-panel">
          <div className="panel-head">
            <div>
              <p className="panel-kicker">Remote WordPress</p>
              <h2>{workspaceTab === 'pages' ? 'Pages' : 'Posts'}</h2>
            </div>
            <StatusPill tone={remoteError ? 'warning' : remoteItems.length ? 'info' : 'muted'}>
              {remoteLoading ? 'loading' : `${remoteItems.length} loaded`}
            </StatusPill>
          </div>
          <div className="panel-actions">
            <select value={remoteStatus} onChange={(event) => { setRemotePage(1); setRemoteStatus(event.currentTarget.value); }}>
              <option value="">Default status</option>
              <option value="publish">Published</option>
              <option value="draft">Draft</option>
              <option value="pending">Pending</option>
              <option value="private">Private</option>
              <option value="any">Any</option>
            </select>
            <input type="search" placeholder="Search WordPress" value={remoteSearch} onChange={(event) => setRemoteSearch(event.currentTarget.value)} />
            <button type="button" disabled={remoteLoading || !slice.configured} onClick={() => void loadRemoteContent(remoteCollection, 1)}>
              {remoteLoading ? 'Searching...' : 'Search'}
            </button>
          </div>
          {remoteError ? <p className="error-text">{remoteError}</p> : null}
          {actionError && (workspaceTab === 'posts' || workspaceTab === 'pages') ? <p className="error-text">{actionError}</p> : null}
          <p className="empty-state">
            Selected local draft for updates: {selectedDraft?.title ? <strong>{displayText(selectedDraft.title)}</strong> : 'none'}.
            Use the Drafts tab to choose a different draft.
          </p>
          <div className="stack-list compact">
            {remoteItems.map((item: any) => (
              <div className="summary-row" key={item.id}>
                <div>
                  <strong dangerouslySetInnerHTML={{ __html: item.title || `(untitled #${item.id})` }} />
                  <span>{item.slug || item.type || ''}</span>
                  <span>{item.status || 'unknown'}</span>
                </div>
                <div className="panel-actions">
                  <button type="button" disabled={Boolean(actionBusy)} onClick={() => void importRemoteContent(item)}>
                    {actionBusy === `import-${item.id}` ? 'Importing...' : 'Import as draft'}
                  </button>
                  <button type="button" disabled={Boolean(actionBusy) || !selectedDraft?.id || selectedDraftLocked} onClick={() => void updateRemoteFromDraft(item)}>
                    {actionBusy === `update-remote-${item.id}` ? 'Updating...' : 'Update from selected draft'}
                  </button>
                  {item.link ? <a href={item.link} target="_blank" rel="noreferrer">Open</a> : null}
                  <StatusPill tone={item.status === 'publish' ? 'good' : item.status === 'draft' ? 'muted' : 'info'}>{item.status || 'n/a'}</StatusPill>
                </div>
              </div>
            ))}
            {!remoteLoading && remoteItems.length === 0 ? <p className="empty-state">No remote {workspaceTab === 'pages' ? 'pages' : 'posts'} loaded yet. Click Refresh.</p> : null}
          </div>
          <div className="panel-actions">
            <button type="button" disabled={remoteLoading || remotePage <= 1} onClick={() => void loadRemoteContent(remoteCollection, remotePage - 1)}>Previous</button>
            <span>Page {remotePage}</span>
            <button type="button" disabled={remoteLoading || remoteItems.length < 20} onClick={() => void loadRemoteContent(remoteCollection, remotePage + 1)}>Next</button>
          </div>
        </section>
      ) : null}

      {mediaPickerOpen && selectedDraft ? (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Choose featured image"
          style={{
            position: 'fixed',
            inset: 0,
            zIndex: 9999,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: '4vh 4vw',
            background: 'rgba(0,0,0,0.62)',
            backdropFilter: 'blur(3px)',
          }}
          onClick={(event) => {
            if (event.target === event.currentTarget) setMediaPickerOpen(false);
          }}
        >
        <section
          className="panel tab-page"
          style={{
            width: 'min(1180px, 92vw)',
            height: 'min(860px, 88vh)',
            maxHeight: '88vh',
            overflow: 'auto',
            boxShadow: '0 24px 80px rgba(0,0,0,0.45)',
          }}
        >
          <div className="panel-head">
            <div>
              <p className="panel-kicker">Choose featured image</p>
              <h2>{displayText(selectedDraft.title, 'Untitled draft')}</h2>
            </div>
            <button type="button" onClick={() => setMediaPickerOpen(false)}>Close</button>
          </div>
          {actionError ? <p className="error-text">{actionError}</p> : null}
          <div className="panel-actions">
            <input type="search" placeholder="Search media" value={mediaSearch} onChange={(event) => setMediaSearch(event.currentTarget.value)} />
            <button type="button" disabled={mediaLoading || !slice.configured} onClick={() => void loadMedia(1)}>{mediaLoading ? 'Searching...' : 'Search'}</button>
          </div>
          <div className="detail-grid">
            <label className="detail-block">
              <span>Upload from image URL</span>
              <input type="url" placeholder="https://example.com/image.jpg" value={mediaSourceUrl} onChange={(event) => setMediaSourceUrl(event.currentTarget.value)} />
            </label>
            <label className="detail-block">
              <span>Alt text</span>
              <input type="text" value={mediaAltText} onChange={(event) => setMediaAltText(event.currentTarget.value)} />
            </label>
          </div>
          <div className="panel-actions">
            <button type="button" disabled={mediaLoading || !mediaSourceUrl.trim() || !slice.configured} onClick={() => void uploadMediaUrl()}>
              Upload and use for this draft
            </button>
          </div>
          <div className="stack-list compact">
            {mediaItems.map((item: any) => (
              <button className="summary-row" type="button" key={item.id} disabled={Boolean(actionBusy)} onClick={() => void chooseFeaturedMedia(Number(item.id))}>
                <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'center' }}>
                  {item.thumbnailUrl || item.sourceUrl ? (
                    <img
                      src={item.thumbnailUrl || item.sourceUrl}
                      alt={displayText(item.altText || item.title, `Media #${item.id}`)}
                      style={{ width: 72, height: 72, objectFit: 'cover', borderRadius: 8, border: '1px solid var(--border-subtle)' }}
                      loading="lazy"
                    />
                  ) : null}
                  <div>
                    <strong>{displayText(item.title, `Media #${item.id}`)}</strong>
                    <span>{item.mimeType || item.sourceUrl}</span>
                    <span>ID {item.id} — click to use as this draft's featured image</span>
                  </div>
                </div>
                <StatusPill tone="info">Select</StatusPill>
              </button>
            ))}
            {!mediaLoading && mediaItems.length === 0 ? <p className="empty-state">No media loaded yet. Search, refresh, or upload from a URL.</p> : null}
          </div>
          <div className="panel-actions">
            <button type="button" disabled={mediaLoading || mediaPage <= 1} onClick={() => void loadMedia(mediaPage - 1)}>Previous media</button>
            <span>Page {mediaPage}</span>
            <button type="button" disabled={mediaLoading || mediaItems.length < 30} onClick={() => void loadMedia(mediaPage + 1)}>Next media</button>
          </div>
        </section>
        </div>
      ) : null}

      {workspaceTab === 'media' ? (
        <section className="panel tab-page wp-toolbar-panel">
          <div className="panel-head">
            <div>
              <p className="panel-kicker">WordPress media library</p>
              <h2>Media</h2>
            </div>
            <StatusPill tone={mediaItems.length ? 'info' : 'muted'}>{mediaLoading ? 'loading' : `${mediaItems.length} loaded`}</StatusPill>
          </div>
          {actionError ? <p className="error-text">{actionError}</p> : null}
          <p className="empty-state">
            Media library browser. To attach an image to content, open a draft and click <strong>Choose image</strong> in the Featured media field.
            This avoids accidentally updating the wrong WordPress post/page.
          </p>
          <div className="panel-actions">
            <input type="search" placeholder="Search media" value={mediaSearch} onChange={(event) => setMediaSearch(event.currentTarget.value)} />
            <button type="button" disabled={mediaLoading || !slice.configured} onClick={() => void loadMedia(1)}>{mediaLoading ? 'Searching...' : 'Search'}</button>
          </div>
          <div className="detail-grid">
            <label className="detail-block">
              <span>Upload from image URL</span>
              <input type="url" placeholder="https://example.com/image.jpg" value={mediaSourceUrl} onChange={(event) => setMediaSourceUrl(event.currentTarget.value)} />
            </label>
            <label className="detail-block">
              <span>Alt text</span>
              <input type="text" value={mediaAltText} onChange={(event) => setMediaAltText(event.currentTarget.value)} />
            </label>
          </div>
          <div className="panel-actions">
            <button type="button" disabled={mediaLoading || !mediaSourceUrl.trim() || !slice.configured} onClick={() => void uploadMediaUrl()}>
              {selectedDraft?.id ? 'Upload and select for draft' : 'Upload to media library'}
            </button>
          </div>
          <div className="stack-list compact">
            {mediaItems.map((item: any) => (
              <div className="summary-row" key={item.id}>
                <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'center' }}>
                  {item.thumbnailUrl || item.sourceUrl ? (
                    <img
                      src={item.thumbnailUrl || item.sourceUrl}
                      alt={displayText(item.altText || item.title, `Media #${item.id}`)}
                      style={{ width: 72, height: 72, objectFit: 'cover', borderRadius: 8, border: '1px solid var(--border-subtle)' }}
                      loading="lazy"
                    />
                  ) : null}
                  <div>
                    <strong>{displayText(item.title, `Media #${item.id}`)}</strong>
                    <span>{item.mimeType || item.sourceUrl}</span>
                    <span>ID {item.id}</span>
                  </div>
                </div>
                <div className="panel-actions">
                  {item.sourceUrl ? <a href={item.sourceUrl} target="_blank" rel="noreferrer">Open file</a> : null}
                  <StatusPill tone="info">{item.id}</StatusPill>
                </div>
              </div>
            ))}
            {!mediaLoading && mediaItems.length === 0 ? <p className="empty-state">No media loaded yet. Click Refresh or upload from a URL.</p> : null}
          </div>
          <div className="panel-actions">
            <button type="button" disabled={mediaLoading || mediaPage <= 1} onClick={() => void loadMedia(mediaPage - 1)}>Previous media</button>
            <span>Page {mediaPage}</span>
            <button type="button" disabled={mediaLoading || mediaItems.length < 30} onClick={() => void loadMedia(mediaPage + 1)}>Next media</button>
          </div>
        </section>
      ) : null}

      {workspaceTab === 'taxonomies' ? (
        <section className="panel tab-page">
          <div className="panel-head">
            <div>
              <p className="panel-kicker">WordPress taxonomy cache</p>
              <h2>Categories and tags</h2>
            </div>
            <StatusPill tone={taxonomy.refreshedAt ? 'info' : 'muted'}>{taxonomy.refreshedAt ? 'cached' : 'empty'}</StatusPill>
          </div>
          <div className="detail-grid">
            <div className="detail-block"><span>Categories</span><p>{(taxonomy.categories || []).slice(0, 30).map((term: any) => term.slug).join(', ') || 'None cached.'}</p></div>
            <div className="detail-block"><span>Tags</span><p>{(taxonomy.tags || []).slice(0, 30).map((term: any) => term.slug).join(', ') || 'None cached.'}</p></div>
          </div>
          <div className="panel-actions">
            <button type="button" disabled={!slice.configured} onClick={() => void apiJson('/api/workers/wordpress-publisher/refresh-taxonomies', { method: 'POST' }).then(() => ctx.refreshDashboard?.()).catch((err) => setActionError(err instanceof Error ? err.message : String(err)))}>
              Refresh taxonomies/capabilities
            </button>
          </div>
        </section>
      ) : null}
    </div>
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
    const drafts = ctx.dashboard?.workerData?.['wordpress-publisher']?.recentDrafts ?? [];
    const failures = Array.isArray(posts) ? posts.filter((item: any) => wpMeta(item).failedAt).length : 0;
    return failures || (Array.isArray(drafts) ? drafts.filter((draft: any) => draft.state === 'needs_changes').length : undefined);
  },
  render: (ctx: any) => <WordPressDashboard {...ctx} />,
  queueItemDetail: (item: any) => {
    const meta = wpMeta(item);
    if (!meta.postId && !meta.failedAt && !meta.draftId) return null;
    return (
      <div className="detail-section">
        <p className="panel-kicker">WordPress publisher</p>
        <div className="detail-grid">
          {meta.draftId ? <div className="detail"><span>Draft ID</span><strong>{String(meta.draftId)}</strong></div> : null}
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
