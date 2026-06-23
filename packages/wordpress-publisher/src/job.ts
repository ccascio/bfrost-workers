import { generateText } from 'ai';
import {
  applyConsumerFailure,
  applyConsumerSuccess,
  setConsumerMetadata,
  filterItemsForConsumer,
  findModel,
  getChatModel,
  getDefaultModel,
  loadQueue,
  openWorkerKv,
  recordEventSafe,
  saveQueue,
  withQueueLock,
  type QueueItem,
} from 'bfrost';
import { createContent, discoverCapabilities, fetchCategories, fetchTags, type WpCapabilitiesSnapshot, type WpTaxonomyTerm } from './wp-client.js';
import { createDraft, getDraft, recordDraftEvent, recordDraftVersion, updateDraft, listDrafts, type DraftPatchInput, type WordPressDraft } from './drafts.js';
import { loadWpSettings, WORKER_ID, type WpSettings } from './settings.js';

interface NewsPayload {
  source?: { host?: string; label?: string };
  article?: { title?: string; description?: string; excerpt?: string; finalUrl?: string };
  title?: string;
  summary?: string;
  url?: string;
}

interface CachedTerm {
  id: number;
  name: string;
  slug: string;
}

interface GeneratedArticleDraft {
  title: string;
  slug: string;
  excerpt: string;
  contentHtml: string;
  categorySlugs: string[];
  tagSlugs: string[];
}

export const IMPROVABLE_DRAFT_FIELDS = ['title', 'slug', 'excerpt', 'contentHtml', 'categorySlugs', 'tagSlugs'] as const;
export type ImprovableDraftField = typeof IMPROVABLE_DRAFT_FIELDS[number];

function defaultPrompt(): string {
  return [
    'You are a careful content writer. Given a news source title, description, and excerpt,',
    'write publication-ready WordPress content in clean HTML (use <p>, <h2>, <ul>, <li>, <strong> only).',
    '',
    'Style:',
    '- Direct, calm, factual. No hype. No SEO filler.',
    '- 400-700 words. Open with a one-sentence hook.',
    '- Stay grounded in the source material. Do not invent vendor claims or statistics.',
    '- Close with a one-paragraph takeaway.',
  ].join('\n');
}

function newsPayload(item: QueueItem): NewsPayload {
  return (item.payload ?? {}) as NewsPayload;
}

function articleTitle(item: QueueItem, payload = newsPayload(item)): string {
  return payload.article?.title || payload.title || item.title;
}

function articleDescription(item: QueueItem, payload = newsPayload(item)): string {
  return payload.article?.description || payload.summary || item.shortDesc;
}

function articleUrl(item: QueueItem, payload = newsPayload(item)): string {
  return payload.article?.finalUrl || payload.url || item.url;
}

function articleExcerpt(item: QueueItem, payload = newsPayload(item)): string {
  const excerpt = payload.article?.excerpt || payload.article?.description || payload.summary || item.shortDesc;
  return excerpt.slice(0, 1000);
}

function resolveModel(settings: WpSettings) {
  if (settings.modelAlias.trim()) {
    const model = findModel(settings.modelAlias.trim());
    if (!model) throw new Error(`WordPress publisher: model alias "${settings.modelAlias}" not found.`);
    return model;
  }
  return getDefaultModel();
}

function sourcePromptBlock(item: QueueItem): string {
  const payload = newsPayload(item);
  return [
    `Title: ${articleTitle(item, payload)}`,
    `Description: ${articleDescription(item, payload)}`,
    `Source URL: ${articleUrl(item, payload)}`,
    `Source host: ${payload.source?.host ?? ''}`,
    '',
    'Excerpt:',
    articleExcerpt(item, payload),
  ].join('\n');
}

function generationSystemPrompt(settings: WpSettings): string {
  const styleControls = [
    settings.brandVoice.trim() ? `Brand voice: ${settings.brandVoice.trim()}` : '',
    settings.audience.trim() ? `Audience: ${settings.audience.trim()}` : '',
    settings.tonePreset.trim() ? `Tone preset: ${settings.tonePreset.trim()}` : '',
    settings.contentFormat.trim() ? `Content format: ${settings.contentFormat.trim()}` : '',
    settings.ctaText.trim() ? `Call to action to include when natural: ${settings.ctaText.trim()}` : '',
  ].filter(Boolean);
  return [
    settings.prompt.trim() || defaultPrompt(),
    styleControls.length ? '' : '',
    ...styleControls,
    '',
    'Output contract:',
    'Return ONLY valid JSON. No markdown fences. No commentary.',
    'Shape:',
    '{',
    '  "title": "SEO-safe WordPress title",',
    '  "slug": "optional-url-slug",',
    '  "excerpt": "short WordPress excerpt, 1-2 sentences",',
    '  "contentHtml": "publication-ready HTML body only",',
    '  "categorySlugs": ["optional-existing-or-suggested-category-slug"],',
    '  "tagSlugs": ["optional-tag-slug"]',
    '}',
    'contentHtml must not include <html>, <head>, <body>, scripts, iframes, or markdown fences.',
  ].join('\n');
}

function stripJsonFences(text: string): string {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return (fenced ? fenced[1] : trimmed).trim();
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.map((entry) => (typeof entry === 'string' ? entry.trim() : '')).filter(Boolean).slice(0, 12)
    : [];
}

function safeSlug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 90);
}

function parseGeneratedDraft(text: string, fallbackTitle: string, fallbackExcerpt: string): GeneratedArticleDraft {
  try {
    const parsed = JSON.parse(stripJsonFences(text)) as Record<string, unknown>;
    const contentHtml = typeof parsed.contentHtml === 'string' ? parsed.contentHtml.trim() : '';
    if (!contentHtml) throw new Error('missing contentHtml');
    const title = typeof parsed.title === 'string' && parsed.title.trim() ? parsed.title.trim() : fallbackTitle;
    const excerpt = typeof parsed.excerpt === 'string' && parsed.excerpt.trim() ? parsed.excerpt.trim() : fallbackExcerpt;
    const rawSlug = typeof parsed.slug === 'string' ? parsed.slug : '';
    return {
      title,
      slug: safeSlug(rawSlug || title),
      excerpt,
      contentHtml,
      categorySlugs: stringArray(parsed.categorySlugs).map(safeSlug).filter(Boolean),
      tagSlugs: stringArray(parsed.tagSlugs).map(safeSlug).filter(Boolean),
    };
  } catch (err) {
    const preview = text.length > 3000 ? `${text.slice(0, 3000)}\n… (truncated, total ${text.length} chars)` : text;
    console.log('[WordPressPublisher] LLM parse error — raw output follows:\n--- LLM OUTPUT BEGIN ---\n' + preview + '\n--- LLM OUTPUT END ---');
    throw new Error(`WordPress publisher: LLM output was not valid draft JSON: ${err instanceof Error ? err.message : err}`);
  }
}

async function runStructuredArticleGeneration(
  settings: WpSettings,
  userBlock: string,
  fallbackTitle: string,
  fallbackExcerpt: string,
  emptyMessage: string,
): Promise<GeneratedArticleDraft> {
  const model = resolveModel(settings);
  const result = await generateText({
    model: getChatModel(model) as Parameters<typeof generateText>[0]['model'],
    system: generationSystemPrompt(settings),
    prompt: `/no_think\n${userBlock}`,
    temperature: 0.4,
  });
  const text = result.text?.trim();
  if (!text) throw new Error(emptyMessage);
  return parseGeneratedDraft(text, fallbackTitle, fallbackExcerpt);
}

export async function generateArticleBody(settings: WpSettings, item: QueueItem): Promise<string> {
  return (await generateArticleDraft(settings, item)).contentHtml;
}

async function generateArticleDraft(settings: WpSettings, item: QueueItem): Promise<GeneratedArticleDraft> {
  const payload = newsPayload(item);
  return runStructuredArticleGeneration(
    settings,
    sourcePromptBlock(item),
    articleTitle(item, payload),
    articleDescription(item, payload),
    'WordPress publisher: model returned empty draft.',
  );
}

async function generateArticleRevision(settings: WpSettings, item: QueueItem, draft: WordPressDraft, changeRequest: string): Promise<GeneratedArticleDraft> {
  const userBlock = [
    'Revise the existing WordPress draft using the operator change request.',
    'Keep the result grounded in the original source.',
    '',
    'Original source:',
    sourcePromptBlock(item),
    '',
    'Current draft:',
    `Title: ${draft.title}`,
    `Slug: ${draft.slug}`,
    `Excerpt: ${draft.excerpt}`,
    'HTML:',
    draft.contentHtml.slice(0, 6000),
    '',
    'Operator change request:',
    changeRequest,
  ].join('\n');
  return runStructuredArticleGeneration(
    settings,
    userBlock,
    draft.title,
    draft.excerpt,
    'WordPress publisher: model returned empty revision.',
  );
}

async function pickTermIds(kv: ReturnType<typeof openWorkerKv>, key: string, slugs: string[]): Promise<number[]> {
  if (slugs.length === 0) return [];
  const cached = (await kv.get<CachedTerm[]>(key)) ?? [];
  return slugs
    .map((slug) => cached.find((term) => term.slug === slug)?.id)
    .filter((id): id is number => typeof id === 'number');
}

function authFromSettings(settings: WpSettings) {
  return {
    baseUrl: settings.baseUrl,
    username: settings.username,
    applicationPassword: settings.applicationPassword,
  };
}

function hasCredentials(settings: WpSettings): boolean {
  return Boolean(settings.baseUrl && settings.username && settings.applicationPassword);
}

function itemSourceHost(item: QueueItem): string {
  const payload = newsPayload(item) as Record<string, any>;
  return String(payload.source?.host ?? '').toLowerCase();
}

function itemFeedUrl(item: QueueItem): string {
  const payload = newsPayload(item) as Record<string, any>;
  return String(payload.source?.feedUrl ?? payload.feedUrl ?? '');
}

function itemTags(item: QueueItem): string[] {
  const payload = newsPayload(item) as Record<string, any>;
  const tags = [
    ...(Array.isArray((item as any).tags) ? (item as any).tags : []),
    ...(Array.isArray(payload.llmTags) ? payload.llmTags : []),
  ];
  return tags.map((tag) => String(tag).toLowerCase()).filter(Boolean);
}

function itemRelevanceScore(item: QueueItem): number | null {
  const payload = newsPayload(item) as Record<string, any>;
  return typeof payload.relevanceScore === 'number' ? payload.relevanceScore : null;
}

function searchableText(item: QueueItem): string {
  const payload = newsPayload(item);
  return [
    item.title,
    item.shortDesc,
    payload.title,
    payload.summary,
    payload.article?.title,
    payload.article?.description,
    payload.article?.excerpt,
  ].filter(Boolean).join('\n').toLowerCase();
}

function matchesContentSelection(item: QueueItem, settings: WpSettings): boolean {
  const host = itemSourceHost(item);
  if (settings.blockedHosts.length && host && settings.blockedHosts.some((blocked) => host === blocked || host.endsWith(`.${blocked}`))) return false;
  if (settings.allowedHosts.length && !settings.allowedHosts.some((allowed) => host === allowed || host.endsWith(`.${allowed}`))) return false;
  const feedUrl = itemFeedUrl(item);
  if (settings.allowedFeedUrls.length && !settings.allowedFeedUrls.includes(feedUrl)) return false;
  const tags = itemTags(item);
  if (settings.requiredTags.length && !settings.requiredTags.some((tag) => tags.includes(tag))) return false;
  if (settings.excludedTags.length && settings.excludedTags.some((tag) => tags.includes(tag))) return false;
  const relevanceScore = itemRelevanceScore(item);
  if (settings.minimumRelevanceScore > 0 && relevanceScore !== null && relevanceScore < settings.minimumRelevanceScore) return false;
  const text = searchableText(item);
  if (settings.includeKeywords.length && !settings.includeKeywords.some((keyword) => text.includes(keyword))) return false;
  if (settings.excludeKeywords.length && settings.excludeKeywords.some((keyword) => text.includes(keyword))) return false;
  return true;
}

export async function refreshTaxonomies(): Promise<{ categories: number; tags: number }> {
  const settings = await loadWpSettings();
  if (!hasCredentials(settings)) {
    throw new Error('WordPress publisher: set base URL, username, and application password first.');
  }
  const kv = openWorkerKv(WORKER_ID);
  const [categories, tags, capabilities] = await Promise.all([
    fetchCategories(authFromSettings(settings)),
    fetchTags(authFromSettings(settings)),
    discoverCapabilities(authFromSettings(settings)),
  ]);
  await kv.set('categories', categories);
  await kv.set('tags', tags);
  await kv.set('capabilities', capabilities);
  await kv.set('taxonomies-refreshed-at', new Date().toISOString());
  return { categories: categories.length, tags: tags.length };
}

export async function loadTaxonomySnapshot(): Promise<{
  categories: WpTaxonomyTerm[];
  tags: WpTaxonomyTerm[];
  capabilities: WpCapabilitiesSnapshot | null;
  refreshedAt: string | null;
}> {
  const kv = openWorkerKv(WORKER_ID);
  const [categories, tags, capabilities, refreshedAt] = await Promise.all([
    kv.get<WpTaxonomyTerm[]>('categories'),
    kv.get<WpTaxonomyTerm[]>('tags'),
    kv.get<WpCapabilitiesSnapshot>('capabilities'),
    kv.get<string>('taxonomies-refreshed-at'),
  ]);
  return {
    categories: categories ?? [],
    tags: tags ?? [],
    capabilities: capabilities ?? null,
    refreshedAt: refreshedAt ?? null,
  };
}

export async function recentWordPressPosts(): Promise<QueueItem[]> {
  const queue = await loadQueue();
  return queue
    .filter((item) => Boolean(item.metadata?.[WORKER_ID]?.postId || item.metadata?.[WORKER_ID]?.failedAt || item.metadata?.[WORKER_ID]?.draftId))
    .sort((a, b) => {
      const aMeta = a.metadata?.[WORKER_ID] ?? {};
      const bMeta = b.metadata?.[WORKER_ID] ?? {};
      const aTime = String(aMeta.postedAt ?? aMeta.failedAt ?? aMeta.draftedAt ?? a.stateChangedAt ?? a.addedAt);
      const bTime = String(bMeta.postedAt ?? bMeta.failedAt ?? bMeta.draftedAt ?? b.stateChangedAt ?? b.addedAt);
      return new Date(bTime).getTime() - new Date(aTime).getTime();
    })
    .slice(0, 20);
}

export async function recentWordPressDrafts(): Promise<WordPressDraft[]> {
  return listDrafts(20);
}

function fieldInstruction(field: ImprovableDraftField): string {
  if (field === 'title') return 'Return only the improved title as plain text.';
  if (field === 'slug') return 'Return only a URL-safe slug. Lowercase words separated by hyphens.';
  if (field === 'excerpt') return 'Return only the improved WordPress excerpt, 1-2 sentences, as plain text.';
  if (field === 'contentHtml') return 'Return only the improved HTML body. No markdown fences, no <html>, no <head>, no <body>.';
  if (field === 'categorySlugs') return 'Return only a comma-separated list of URL-safe category slugs.';
  return 'Return only a comma-separated list of URL-safe tag slugs.';
}

function parseSlugList(text: string): string[] {
  return text
    .replace(/^```[a-z]*|```$/gi, '')
    .split(/[\n,]/)
    .map((entry) => safeSlug(entry.trim()))
    .filter(Boolean)
    .slice(0, 12);
}

export async function improveWordPressDraftField(
  draftId: string,
  field: ImprovableDraftField,
  instruction: string,
): Promise<WordPressDraft> {
  const settings = await loadWpSettings();
  const draft = await getDraft(draftId);
  if (!draft) throw new Error(`WordPress draft not found: ${draftId}`);
  if (draft.state === 'published_to_wp' || draft.state === 'archived') {
    throw new Error(`Draft ${draftId} cannot be improved from state ${draft.state}.`);
  }
  const source = (await loadQueue()).find((entry) => entry.id === draft.sourceItemId);
  const currentValue = field === 'categorySlugs' || field === 'tagSlugs'
    ? (field === 'categorySlugs' ? draft.categorySlugs : draft.tagSlugs).join(', ')
    : String(draft[field] ?? '');
  const userBlock = [
    `Improve this WordPress draft field: ${field}`,
    fieldInstruction(field),
    '',
    'Operator instruction:',
    instruction,
    '',
    'Current field value:',
    currentValue,
    '',
    'Draft context:',
    `Title: ${draft.title}`,
    `Excerpt: ${draft.excerpt}`,
    `Slug: ${draft.slug}`,
    `Categories: ${draft.categorySlugs.join(', ')}`,
    `Tags: ${draft.tagSlugs.join(', ')}`,
    '',
    source ? `Original source:\n${sourcePromptBlock(source)}` : '',
  ].filter(Boolean).join('\n');

  const model = resolveModel(settings);
  const result = await generateText({
    model: getChatModel(model) as Parameters<typeof generateText>[0]['model'],
    system: settings.prompt.trim() || defaultPrompt(),
    prompt: `/no_think\n${userBlock}`,
    temperature: 0.35,
  });
  const raw = result.text?.trim();
  if (!raw) throw new Error(`WordPress publisher: model returned empty improvement for ${field}.`);
  const cleaned = stripJsonFences(raw).trim();

  const patch: DraftPatchInput = { errorMessage: '' };
  if (field === 'title') patch.title = cleaned.replace(/^['"]|['"]$/g, '').trim();
  else if (field === 'slug') patch.slug = safeSlug(cleaned);
  else if (field === 'excerpt') patch.excerpt = cleaned;
  else if (field === 'contentHtml') patch.contentHtml = cleaned;
  else if (field === 'categorySlugs') patch.categorySlugs = parseSlugList(cleaned);
  else patch.tagSlugs = parseSlugList(cleaned);

  const improved = await updateDraft(draft.id, patch);
  await recordDraftVersion(improved, `Improved ${field}: ${instruction}`);
  await recordDraftEvent(draft.id, 'field_improved', `Improved ${field}.`, { field, instruction });
  await recordEventSafe({
    category: 'worker',
    action: 'wordpress_draft_field_improved',
    summary: `WordPress draft field improved: ${field}`,
    metadata: { workerId: WORKER_ID, draftId: draft.id, field },
  });
  return improved;
}

export async function regenerateWordPressDraft(draftId: string, changeRequest?: string): Promise<WordPressDraft> {
  const settings = await loadWpSettings();
  const draft = await getDraft(draftId);
  if (!draft) throw new Error(`WordPress draft not found: ${draftId}`);
  if (draft.state === 'published_to_wp') {
    throw new Error('Published WordPress drafts cannot be regenerated. Create a new draft instead.');
  }

  const requestedChange = (changeRequest ?? draft.changeRequest).trim();
  if (!requestedChange) throw new Error('A change request is required before regenerating a draft.');

  const queue = await loadQueue();
  const source = queue.find((entry) => entry.id === draft.sourceItemId);
  if (!source) throw new Error(`Source queue item not found for draft ${draft.id}.`);

  try {
    const generated = await generateArticleRevision(settings, source, draft, requestedChange);
    const revised = await updateDraft(draft.id, {
      state: 'generated',
      title: generated.title,
      slug: generated.slug,
      excerpt: generated.excerpt,
      contentHtml: generated.contentHtml,
      categorySlugs: generated.categorySlugs.length ? generated.categorySlugs : draft.categorySlugs,
      tagSlugs: generated.tagSlugs.length ? generated.tagSlugs : draft.tagSlugs,
      changeRequest: requestedChange,
      errorMessage: '',
    });
    await recordDraftVersion(revised, requestedChange);
    await recordDraftEvent(draft.id, 'regenerated', 'Draft regenerated from operator change request.', {
      changeRequest: requestedChange,
      previousUpdatedAt: draft.updatedAt,
    });

    await withQueueLock(async () => {
      const lockedQueue = await loadQueue();
      const item = lockedQueue.find((entry) => entry.id === draft.sourceItemId);
      if (item) {
        setConsumerMetadata(item, WORKER_ID, {
          draftId: draft.id,
          draftState: revised.state,
          revisedAt: revised.updatedAt,
        });
        await saveQueue(lockedQueue);
      }
    });

    await recordEventSafe({
      category: 'worker',
      action: 'wordpress_draft_regenerated',
      summary: `WordPress draft regenerated: ${draft.title}`,
      metadata: { workerId: WORKER_ID, draftId: draft.id },
    });
    return revised;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const failed = await updateDraft(draft.id, { state: 'failed', errorMessage: message });
    await recordDraftEvent(draft.id, 'failed', `Draft regeneration failed: ${message}`);
    await recordEventSafe({
      category: 'worker',
      action: 'wordpress_draft_regeneration_failed',
      severity: 'error',
      summary: `WordPress draft regeneration failed: ${message}`,
      metadata: { workerId: WORKER_ID, draftId: draft.id },
    });
    return failed;
  }
}

export async function archiveWordPressDraft(draftId: string): Promise<WordPressDraft> {
  const draft = await getDraft(draftId);
  if (!draft) throw new Error(`WordPress draft not found: ${draftId}`);
  const archived = await updateDraft(draft.id, { state: 'archived' });
  await recordDraftEvent(draft.id, 'archived', 'Draft archived by operator.');
  await withQueueLock(async () => {
    const queue = await loadQueue();
    const item = queue.find((entry) => entry.id === draft.sourceItemId);
    if (item) {
      setConsumerMetadata(item, WORKER_ID, {
        draftId: draft.id,
        draftState: 'archived',
        archivedAt: archived.updatedAt,
      });
      await saveQueue(queue);
    }
  });
  await recordEventSafe({
    category: 'worker',
    action: 'wordpress_draft_archived',
    summary: `WordPress draft archived: ${draft.title}`,
    metadata: { workerId: WORKER_ID, draftId: draft.id },
  });
  return archived;
}

export async function publishWordPressDraft(draftId: string): Promise<WordPressDraft> {
  const settings = await loadWpSettings();
  if (!hasCredentials(settings)) {
    throw new Error('WordPress credentials missing. Open Config and fill in base URL, username, and application password.');
  }
  const draft = await getDraft(draftId);
  if (!draft) throw new Error(`WordPress draft not found: ${draftId}`);
  if (!['generated', 'approved', 'needs_changes', 'failed'].includes(draft.state)) {
    throw new Error(`Draft ${draftId} cannot be published from state ${draft.state}.`);
  }

  const kv = openWorkerKv(WORKER_ID);
  const categories = draft.contentType === 'post' ? await pickTermIds(kv, 'categories', draft.categorySlugs.length ? draft.categorySlugs : settings.categorySlugs) : [];
  const tags = draft.contentType === 'post' ? await pickTermIds(kv, 'tags', draft.tagSlugs.length ? draft.tagSlugs : settings.tagSlugs) : [];
  const collectionName = draft.contentType === 'page' ? 'pages' : (settings.postType || 'posts');

  try {
    const result = await createContent(authFromSettings(settings), {
      title: draft.title,
      content: draft.contentHtml,
      excerpt: draft.excerpt,
      slug: draft.slug,
      status: draft.targetStatus,
      date: draft.publishDate || undefined,
      parent: draft.contentType === 'page' ? draft.pageParent ?? undefined : undefined,
      menuOrder: draft.contentType === 'page' ? draft.pageMenuOrder ?? undefined : undefined,
      template: draft.contentType === 'page' ? draft.pageTemplate || undefined : undefined,
      featuredMedia: draft.featuredMediaId ?? undefined,
      categories,
      tags,
      postType: collectionName,
    });

    const published = await updateDraft(draft.id, {
      state: 'published_to_wp',
      wpId: result.id,
      wpLink: result.link,
      wpStatus: result.status,
      errorMessage: '',
      publishedAt: new Date().toISOString(),
    });
    await recordDraftEvent(draft.id, 'published_to_wp', `Created WordPress ${draft.contentType} ${result.id}.`, result);

    await withQueueLock(async () => {
      const queue = await loadQueue();
      const item = queue.find((entry) => entry.id === draft.sourceItemId);
      if (item) {
        applyConsumerSuccess(item, WORKER_ID, {
          postedId: String(result.id),
          metadata: {
            draftId: draft.id,
            draftState: 'published_to_wp',
            postId: result.id,
            postUrl: result.link,
            postStatus: result.status,
            postSlug: result.slug,
            postType: collectionName,
            postedAt: published.publishedAt ?? new Date().toISOString(),
          },
        });
        await saveQueue(queue);
      }
    });

    await recordEventSafe({
      category: 'worker',
      action: 'wordpress_publish_completed',
      summary: `WordPress ${result.status}: ${result.link}`,
      metadata: { workerId: WORKER_ID, draftId: draft.id, postId: result.id, status: result.status, postType: collectionName },
    });
    return published;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const failed = await updateDraft(draft.id, { state: 'failed', errorMessage: message });
    await recordDraftEvent(draft.id, 'failed', message);
    await recordEventSafe({
      category: 'worker',
      action: 'wordpress_publish_failed',
      severity: 'error',
      summary: `WordPress publish failed: ${message}`,
      metadata: { workerId: WORKER_ID, draftId: draft.id },
    });
    throw new Error(message);
  }
}

export async function runWordPressPublisher(): Promise<{ summary: string; status: 'ok' | 'noop' | 'failed'; itemCount: number }> {
  const settings = await loadWpSettings();
  if (!hasCredentials(settings)) {
    return {
      status: 'noop',
      itemCount: 0,
      summary: 'WordPress credentials missing. Open Config and fill in base URL, username, and application password.',
    };
  }

  return await withQueueLock(async () => {
    const queue = await loadQueue();
    const eligible = filterItemsForConsumer(queue, WORKER_ID, {
      itemType: 'news.article',
      states: settings.consumeApprovedOnly ? ['approved'] : ['queued', 'approved'],
      excludeAlreadyHandled: true,
    }).filter((item) => matchesContentSelection(item, settings));
    const target = eligible[0];

    if (!target) {
      return { status: 'noop', itemCount: 0, summary: 'No eligible news.article items matched the WordPress content selection filters.' };
    }

    try {
      const generated = await generateArticleDraft(settings, target);
      const promptSnapshot = generationSystemPrompt(settings);
      const contentType = settings.postType === 'pages' || settings.postType === 'page' ? 'page' : 'post';
      const draft = await createDraft({
        sourceItemId: target.id,
        sourceItemType: target.itemType,
        contentType,
        title: generated.title,
        slug: generated.slug,
        excerpt: generated.excerpt,
        contentHtml: generated.contentHtml,
        targetStatus: settings.defaultStatus,
        categorySlugs: generated.categorySlugs.length ? generated.categorySlugs : settings.categorySlugs,
        tagSlugs: generated.tagSlugs.length ? generated.tagSlugs : settings.tagSlugs,
        promptSnapshot,
      });

      setConsumerMetadata(target, WORKER_ID, {
        draftId: draft.id,
        draftState: draft.state,
        targetStatus: draft.targetStatus,
        draftedAt: draft.createdAt,
      });
      await saveQueue(queue);

      await recordEventSafe({
        category: 'worker',
        action: 'wordpress_draft_generated',
        summary: `WordPress draft ready for review: ${draft.title}`,
        metadata: { workerId: WORKER_ID, draftId: draft.id, targetStatus: draft.targetStatus, postType: settings.postType },
      });
      return { status: 'ok' as const, itemCount: 1, summary: `Draft ready for review: ${draft.title}` };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      applyConsumerFailure(target, WORKER_ID, {
        errorMessage: message,
        maxAttempts: 3,
        metadata: {
          failedAt: new Date().toISOString(),
        },
      });
      await saveQueue(queue);
      await recordEventSafe({
        category: 'worker',
        action: 'wordpress_draft_failed',
        severity: 'error',
        summary: `WordPress draft generation failed: ${message}`,
        metadata: { workerId: WORKER_ID },
      });
      return { status: 'failed' as const, itemCount: 0, summary: message };
    }
  });
}
