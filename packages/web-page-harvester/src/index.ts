import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { BackendWorkerModule, QueueItem, WorkerJobManifest, WorkerManifest } from 'bfrost';
import { loadQueue, openWorkerKv, publishItem, recordEventSafe } from 'bfrost';

const WORKER_ID = 'web-page-harvester';
const JOB_ID = 'web-page-fetch';
const USER_AGENT = 'BFrost-WebPageHarvester/0.1 (local worker)';

interface WebPageParams {
  urls: string[];
  maxPagesPerRun: number;
  refetchHours: number;
  tags: string[];
}

interface SeenPage {
  fetchedAt: string;
  contentHash: string;
}

interface WebPageRunSummary {
  ranAt: string;
  requestedCount: number;
  fetchedCount: number;
  publishedCount: number;
  skippedCount: number;
  errors: Array<{ url: string; message: string }>;
}

const WebPageParamsSchema = z.object({
  urls: z.array(z.string().trim().min(1)).default([]),
  maxPagesPerRun: z.coerce.number().int().min(1).max(25).default(5),
  refetchHours: z.coerce.number().int().min(0).max(8760).default(168),
  tags: z.array(z.string().trim().min(1)).default(['web']),
}).strict();

const defaultParams: WebPageParams = {
  urls: [],
  maxPagesPerRun: 5,
  refetchHours: 168,
  tags: ['web'],
};

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function seenKey(url: string): string {
  return `seen-${hash(url)}`;
}

function normalizeUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('Only http and https URLs are supported.');
  }
  url.hash = '';
  return url.toString();
}

function hostFor(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return 'web';
  }
}

function decodeHtml(value: string): string {
  const named: Record<string, string> = {
    amp: '&',
    lt: '<',
    gt: '>',
    quot: '"',
    apos: "'",
    nbsp: ' ',
  };
  return value
    .replace(/&#(\d+);/g, (_match, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_match, code) => String.fromCharCode(parseInt(code, 16)))
    .replace(/&([a-z]+);/gi, (match, name) => named[name.toLowerCase()] ?? match);
}

function firstMatch(body: string, pattern: RegExp): string {
  return body.match(pattern)?.[1]?.trim() ?? '';
}

function stripHtml(html: string): string {
  return decodeHtml(html)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<svg[\s\S]*?<\/svg>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function metaContent(html: string, name: string): string {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return firstMatch(html, new RegExp(`<meta[^>]+(?:name|property)=["']${escaped}["'][^>]+content=["']([^"']+)["'][^>]*>`, 'i'))
    || firstMatch(html, new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+(?:name|property)=["']${escaped}["'][^>]*>`, 'i'));
}

function pageTitle(html: string, url: string): string {
  const title = stripHtml(firstMatch(html, /<title[^>]*>([\s\S]*?)<\/title>/i));
  return title || hostFor(url);
}

function pageDescription(html: string, text: string): string {
  return stripHtml(metaContent(html, 'description') || metaContent(html, 'og:description') || text).slice(0, 500);
}

function shouldSkipForFreshness(seen: SeenPage | null | undefined, refetchHours: number): boolean {
  if (!seen || refetchHours === 0) return false;
  const fetchedAt = Date.parse(seen.fetchedAt);
  if (Number.isNaN(fetchedAt)) return false;
  return Date.now() - fetchedAt < refetchHours * 60 * 60 * 1000;
}

async function runWebPageFetch(rawParams?: Record<string, unknown>): Promise<{ summary: string; itemCount: number }> {
  const params = WebPageParamsSchema.parse({ ...defaultParams, ...(rawParams ?? {}) });
  const kv = openWorkerKv(WORKER_ID);
  const errors: WebPageRunSummary['errors'] = [];
  let fetchedCount = 0;
  let publishedCount = 0;
  let skippedCount = 0;
  const urls = params.urls.slice(0, params.maxPagesPerRun);

  for (const rawUrl of urls) {
    let url = rawUrl;
    try {
      url = normalizeUrl(rawUrl);
      const seen = await kv.get<SeenPage>(seenKey(url));
      if (shouldSkipForFreshness(seen, params.refetchHours)) {
        skippedCount += 1;
        continue;
      }

      const res = await fetch(url, {
        headers: { 'User-Agent': USER_AGENT },
        signal: AbortSignal.timeout(20_000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const html = await res.text();
      const text = stripHtml(html);
      const contentHash = hash(text.slice(0, 100_000));
      fetchedCount += 1;
      if (seen?.contentHash === contentHash) {
        await kv.set(seenKey(url), { fetchedAt: new Date().toISOString(), contentHash });
        skippedCount += 1;
        continue;
      }

      const finalUrl = normalizeUrl(res.url || url);
      const title = pageTitle(html, finalUrl);
      const shortDesc = pageDescription(html, text) || `Web page from ${hostFor(finalUrl)}.`;
      await publishItem({
        producerWorkerId: WORKER_ID,
        itemType: 'web.page',
        tags: Array.from(new Set(['web', hostFor(finalUrl), ...params.tags])).slice(0, 12),
        title,
        shortDesc,
        url: finalUrl,
        payload: {
          source: { host: hostFor(finalUrl), label: hostFor(finalUrl) },
          title,
          finalUrl,
          fetchedAt: new Date().toISOString(),
          contentHash,
          text: text.slice(0, 8000),
          description: shortDesc,
        },
        selectionReason: `Fetched by Web Page Harvester from ${finalUrl}.`,
      });
      await kv.set(seenKey(url), { fetchedAt: new Date().toISOString(), contentHash });
      publishedCount += 1;
    } catch (err) {
      errors.push({ url, message: err instanceof Error ? err.message : String(err) });
    }
  }

  const lastRun: WebPageRunSummary = {
    ranAt: new Date().toISOString(),
    requestedCount: urls.length,
    fetchedCount,
    publishedCount,
    skippedCount,
    errors,
  };
  await kv.set('last-run', lastRun);
  await recordEventSafe({
    category: 'worker',
    action: errors.length > 0 ? 'web_page_fetch_completed_with_errors' : 'web_page_fetch_completed',
    severity: errors.length > 0 ? 'warning' : 'info',
    summary: `Web Page Harvester published ${publishedCount} page${publishedCount === 1 ? '' : 's'}.`,
    metadata: { workerId: WORKER_ID, ...lastRun },
  });

  return {
    itemCount: publishedCount,
    summary: urls.length === 0
      ? 'Web Page Harvester skipped: no URLs configured in Jobs.'
      : `Web Page Harvester published ${publishedCount} page${publishedCount === 1 ? '' : 's'}; ${skippedCount} skipped.`,
  };
}

async function recentPages(): Promise<QueueItem[]> {
  const queue = await loadQueue();
  return queue
    .filter((item) => item.producerWorkerId === WORKER_ID)
    .sort((a, b) => new Date(b.addedAt).getTime() - new Date(a.addedAt).getTime())
    .slice(0, 20);
}

const webPageJob: WorkerJobManifest = {
  id: JOB_ID,
  workerId: WORKER_ID,
  label: 'Fetch web pages',
  description: 'Fetch configured web pages and publish changed pages as web.page items.',
  defaultEnabled: false,
  defaultCron: '0 */6 * * *',
  defaultModelAlias: '',
  approvalRequiredDefault: false,
  approvalRequiredEditable: false,
  defaultPrompt: '',
  prompt: { editable: false },
  paramsSchema: WebPageParamsSchema,
  defaultParams,
  dashboardFields: [
    { key: 'urls', label: 'Page URLs', type: 'string-list', defaultValue: defaultParams.urls, rows: 5, helpText: 'One http or https page per line. The worker publishes a web.page item when content changes.' },
    { key: 'maxPagesPerRun', label: 'Max pages per run', type: 'number', defaultValue: defaultParams.maxPagesPerRun, min: 1, max: 25, step: 1 },
    { key: 'refetchHours', label: 'Minimum hours between checks', type: 'number', defaultValue: defaultParams.refetchHours, min: 0, max: 8760, step: 1, helpText: 'Use 0 to check every run. Unchanged pages are skipped.' },
    { key: 'tags', label: 'Extra tags', type: 'string-list', defaultValue: defaultParams.tags, rows: 3, helpText: 'Optional tags added to every published page.' },
  ],
  run: async (_modelId, params) => runWebPageFetch(params),
};

const manifest: WorkerManifest = {
  manifestVersion: 1,
  bfrostApiVersion: '0.1',
  id: WORKER_ID,
  name: 'Web Page Harvester',
  displayName: 'Web Page Harvester',
  version: '0.1.0',
  description: 'Fetches configured web pages on a schedule and publishes changed pages to the Item Bus.',
  tagline: 'Watches simple web pages for changes and turns them into BFrost items.',
  builtIn: false,
  kind: 'feature',
  permissions: ['network:http', 'network:https'],
  jobs: [webPageJob],
  ownedSettings: [
    {
      key: 'web-page-harvester-job',
      label: 'Web page harvest job',
      description: 'Schedule and page list for web page intake.',
      scope: 'job',
      storageKey: 'admin.settings.jobs.web-page-fetch',
      dashboardTarget: 'jobs',
    },
  ],
  dashboard: {
    routes: [
      {
        id: 'web-page-harvester-dashboard',
        label: 'Web Pages',
        description: 'Page fetch status, recent web.page items, and manual run controls.',
        path: '/api/workers/web-page-harvester/dashboard',
      },
    ],
  },
};

const module: BackendWorkerModule = {
  manifest,
  async loadDashboardData() {
    const kv = openWorkerKv(WORKER_ID);
    const [lastRun, pages] = await Promise.all([
      kv.get<WebPageRunSummary>('last-run'),
      recentPages(),
    ]);
    return {
      lastRun: lastRun ?? null,
      recentPages: pages,
    };
  },
};

export default module;
