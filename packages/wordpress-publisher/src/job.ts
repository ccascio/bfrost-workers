import { generateText } from 'ai';
import {
  applyConsumerFailure,
  applyConsumerSuccess,
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
import { createPost, fetchCategories, fetchTags, type WpTaxonomyTerm } from './wp-client.js';
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

function defaultPrompt(): string {
  return [
    'You are a careful content writer. Given a news source title, description, and excerpt,',
    'write a publication-ready article in clean HTML (use <p>, <h2>, <ul>, <strong> only).',
    '',
    'Style:',
    '- Direct, calm, factual. No hype. No SEO filler.',
    '- 400-700 words. Open with a one-sentence hook.',
    '- Stay grounded in the source material. Do not invent vendor claims or statistics.',
    '- Close with a one-paragraph takeaway.',
    '',
    'Return ONLY the HTML body. No <html>, no <head>, no <body>, no markdown fences.',
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

async function generateArticleBody(settings: WpSettings, item: QueueItem): Promise<string> {
  const model = resolveModel(settings);
  const payload = newsPayload(item);
  const userBlock = [
    `Title: ${articleTitle(item, payload)}`,
    `Description: ${articleDescription(item, payload)}`,
    `Source URL: ${articleUrl(item, payload)}`,
    `Source host: ${payload.source?.host ?? ''}`,
    '',
    'Excerpt:',
    articleExcerpt(item, payload),
  ].join('\n');

  const result = await generateText({
    model: getChatModel(model) as Parameters<typeof generateText>[0]['model'],
    system: settings.prompt.trim() || defaultPrompt(),
    prompt: `/no_think\n${userBlock}`,
    temperature: 0.4,
  });
  const text = result.text?.trim();
  if (!text) throw new Error('WordPress publisher: model returned empty body.');
  return text;
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

export async function refreshTaxonomies(): Promise<{ categories: number; tags: number }> {
  const settings = await loadWpSettings();
  if (!hasCredentials(settings)) {
    throw new Error('WordPress publisher: set base URL, username, and application password first.');
  }
  const kv = openWorkerKv(WORKER_ID);
  const [categories, tags] = await Promise.all([
    fetchCategories(authFromSettings(settings)),
    fetchTags(authFromSettings(settings)),
  ]);
  await kv.set('categories', categories);
  await kv.set('tags', tags);
  await kv.set('taxonomies-refreshed-at', new Date().toISOString());
  return { categories: categories.length, tags: tags.length };
}

export async function loadTaxonomySnapshot(): Promise<{
  categories: WpTaxonomyTerm[];
  tags: WpTaxonomyTerm[];
  refreshedAt: string | null;
}> {
  const kv = openWorkerKv(WORKER_ID);
  const [categories, tags, refreshedAt] = await Promise.all([
    kv.get<WpTaxonomyTerm[]>('categories'),
    kv.get<WpTaxonomyTerm[]>('tags'),
    kv.get<string>('taxonomies-refreshed-at'),
  ]);
  return {
    categories: categories ?? [],
    tags: tags ?? [],
    refreshedAt: refreshedAt ?? null,
  };
}

export async function recentWordPressPosts(): Promise<QueueItem[]> {
  const queue = await loadQueue();
  return queue
    .filter((item) => Boolean(item.metadata?.[WORKER_ID]?.postId || item.metadata?.[WORKER_ID]?.failedAt))
    .sort((a, b) => {
      const aMeta = a.metadata?.[WORKER_ID] ?? {};
      const bMeta = b.metadata?.[WORKER_ID] ?? {};
      const aTime = String(aMeta.postedAt ?? aMeta.failedAt ?? a.stateChangedAt ?? a.addedAt);
      const bTime = String(bMeta.postedAt ?? bMeta.failedAt ?? b.stateChangedAt ?? b.addedAt);
      return new Date(bTime).getTime() - new Date(aTime).getTime();
    })
    .slice(0, 20);
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

  const kv = openWorkerKv(WORKER_ID);

  return await withQueueLock(async () => {
    const queue = await loadQueue();
    const target = filterItemsForConsumer(queue, WORKER_ID, {
      itemType: 'news.article',
      states: ['queued', 'approved'],
      excludeAlreadyHandled: true,
    })[0];

    if (!target) {
      return { status: 'noop', itemCount: 0, summary: 'No eligible news.article items to publish to WordPress.' };
    }

    try {
      const payload = newsPayload(target);
      const body = await generateArticleBody(settings, target);
      const categories = await pickTermIds(kv, 'categories', settings.categorySlugs);
      const tags = await pickTermIds(kv, 'tags', settings.tagSlugs);
      const result = await createPost(authFromSettings(settings), {
        title: articleTitle(target, payload),
        content: body,
        excerpt: articleDescription(target, payload),
        status: settings.defaultStatus,
        categories,
        tags,
        postType: settings.postType,
      });

      applyConsumerSuccess(target, WORKER_ID, {
        postedId: String(result.id),
        metadata: {
          postId: result.id,
          postUrl: result.link,
          postStatus: result.status,
          postSlug: result.slug,
          postType: settings.postType,
          postedAt: new Date().toISOString(),
        },
      });
      await saveQueue(queue);

      await recordEventSafe({
        category: 'worker',
        action: 'wordpress_publish_completed',
        summary: `WordPress ${result.status}: ${result.link}`,
        metadata: { workerId: WORKER_ID, postId: result.id, status: result.status, postType: settings.postType },
      });
      return { status: 'ok' as const, itemCount: 1, summary: `Posted as ${result.status}: ${result.link}` };
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
        action: 'wordpress_publish_failed',
        severity: 'error',
        summary: `WordPress publish failed: ${message}`,
        metadata: { workerId: WORKER_ID },
      });
      return { status: 'failed' as const, itemCount: 0, summary: message };
    }
  });
}
