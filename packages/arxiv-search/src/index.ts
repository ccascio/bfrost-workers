import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { BackendWorkerModule, QueueItem, WorkerJobManifest, WorkerManifest } from 'bfrost';
import { loadQueue, openWorkerKv, publishItem, recordEventSafe } from 'bfrost';

const WORKER_ID = 'arxiv-search';
const JOB_ID = 'arxiv-search-fetch';
const ARXIV_API = 'https://export.arxiv.org/api/query';
const USER_AGENT = 'BFrost-arXivSearch/0.1 (local worker)';
const ARXIV_TIMEOUT_MS = 45_000;

interface ArxivConfig {
  query: string;
  maxResults: number;
  sortBy: 'submittedDate' | 'lastUpdatedDate' | 'relevance';
  includeCategories: string[];
}

interface ArxivPaper {
  id: string;
  title: string;
  abstract: string;
  url: string;
  pdfUrl: string;
  authors: string[];
  categories: string[];
  publishedAt: string;
  updatedAt: string;
  doi?: string;
}

interface ArxivRunSummary {
  ranAt: string;
  query: string;
  foundCount: number;
  publishedCount: number;
  skippedCount: number;
  errors: Array<{ message: string }>;
}

const ArxivConfigSchema = z.object({
  query: z.string().trim().min(1).default('cat:cs.AI OR cat:cs.CL'),
  maxResults: z.coerce.number().int().min(1).max(50).default(10),
  sortBy: z.enum(['submittedDate', 'lastUpdatedDate', 'relevance']).default('submittedDate'),
  includeCategories: z.array(z.string().trim().min(1)).default([]),
}).strict();

const defaultConfig: ArxivConfig = {
  query: 'cat:cs.AI OR cat:cs.CL',
  maxResults: 10,
  sortBy: 'submittedDate',
  includeCategories: [],
};

function stripXml(value: string): string {
  return value
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function firstMatch(body: string, pattern: RegExp): string {
  return body.match(pattern)?.[1]?.trim() ?? '';
}

function allMatches(body: string, pattern: RegExp): string[] {
  return Array.from(body.matchAll(pattern)).map((match) => stripXml(match[1] ?? '')).filter(Boolean);
}

function isoDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString();
}

function seenKey(id: string): string {
  return `seen-${createHash('sha256').update(id).digest('hex')}`;
}

function parsePapers(xml: string): ArxivPaper[] {
  const entries = xml.matchAll(/<entry>([\s\S]*?)<\/entry>/gi);
  const papers: ArxivPaper[] = [];

  for (const match of entries) {
    const body = match[1] ?? '';
    const id = stripXml(firstMatch(body, /<id>([\s\S]*?)<\/id>/i));
    const title = stripXml(firstMatch(body, /<title>([\s\S]*?)<\/title>/i));
    const abstract = stripXml(firstMatch(body, /<summary>([\s\S]*?)<\/summary>/i));
    const authors = allMatches(body, /<author>\s*<name>([\s\S]*?)<\/name>\s*<\/author>/gi);
    const categories = Array.from(body.matchAll(/<category[^>]*term=["']([^"']+)["'][^>]*\/>/gi)).map((cat) => cat[1]).filter(Boolean);
    const pdfUrl = firstMatch(body, /<link[^>]*title=["']pdf["'][^>]*href=["']([^"']+)["'][^>]*>/i);
    const doi = stripXml(firstMatch(body, /<arxiv:doi[^>]*>([\s\S]*?)<\/arxiv:doi>/i));
    if (!id || !title) continue;
    papers.push({
      id,
      title,
      abstract,
      url: id,
      pdfUrl,
      authors,
      categories,
      publishedAt: isoDate(firstMatch(body, /<published>([\s\S]*?)<\/published>/i)),
      updatedAt: isoDate(firstMatch(body, /<updated>([\s\S]*?)<\/updated>/i)),
      doi: doi || undefined,
    });
  }

  return papers;
}

function buildUrl(config: ArxivConfig): string {
  const url = new URL(ARXIV_API);
  url.searchParams.set('search_query', config.query);
  url.searchParams.set('start', '0');
  url.searchParams.set('max_results', String(config.maxResults));
  url.searchParams.set('sortBy', config.sortBy);
  url.searchParams.set('sortOrder', 'descending');
  return url.toString();
}

function passesCategoryFilter(paper: ArxivPaper, includeCategories: string[]): boolean {
  if (includeCategories.length === 0) return true;
  return paper.categories.some((category) => includeCategories.includes(category));
}

async function runArxivSearch(params?: Record<string, unknown>): Promise<{ summary: string; itemCount: number }> {
  const config = ArxivConfigSchema.parse({ ...defaultConfig, ...(params ?? {}) });
  const kv = openWorkerKv(WORKER_ID);
  const errors: ArxivRunSummary['errors'] = [];
  let foundCount = 0;
  let publishedCount = 0;
  let skippedCount = 0;

  try {
    const res = await fetch(buildUrl(config), {
      headers: { 'User-Agent': USER_AGENT },
      signal: AbortSignal.timeout(ARXIV_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`arXiv API returned HTTP ${res.status}`);
    const papers = parsePapers(await res.text()).filter((paper) => passesCategoryFilter(paper, config.includeCategories));
    foundCount = papers.length;

    for (const paper of papers) {
      if (await kv.get(seenKey(paper.id))) {
        skippedCount += 1;
        continue;
      }
      await publishItem({
        producerWorkerId: WORKER_ID,
        itemType: 'research.paper',
        tags: ['arxiv', ...paper.categories.slice(0, 5)],
        title: paper.title,
        shortDesc: paper.abstract.slice(0, 500) || `arXiv paper by ${paper.authors.slice(0, 3).join(', ')}`,
        url: paper.url,
        payload: {
          source: { host: 'arxiv.org', label: 'arXiv' },
          paperId: paper.id.replace(/^https?:\/\/arxiv\.org\/abs\//, ''),
          title: paper.title,
          abstract: paper.abstract,
          authors: paper.authors,
          categories: paper.categories,
          publishedAt: paper.publishedAt,
          updatedAt: paper.updatedAt,
          doi: paper.doi,
          pdfUrl: paper.pdfUrl,
        },
        selectionReason: `Matched arXiv query: ${config.query}`,
      });
      await kv.set(seenKey(paper.id), { seenAt: new Date().toISOString(), query: config.query });
      publishedCount += 1;
    }
  } catch (err) {
    errors.push({ message: err instanceof Error ? err.message : String(err) });
  }

  const lastRun: ArxivRunSummary = {
    ranAt: new Date().toISOString(),
    query: config.query,
    foundCount,
    publishedCount,
    skippedCount,
    errors,
  };
  await kv.set('last-run', lastRun);
  await recordEventSafe({
    category: 'worker',
    action: errors.length > 0 ? 'arxiv_search_failed' : 'arxiv_search_completed',
    severity: errors.length > 0 ? 'warning' : 'info',
    summary: `arXiv Search published ${publishedCount} new paper${publishedCount === 1 ? '' : 's'}.`,
    metadata: { workerId: WORKER_ID, ...lastRun },
  });

  return {
    itemCount: publishedCount,
    summary: errors.length > 0
      ? `arXiv Search failed: ${errors[0]?.message}`
      : `arXiv Search published ${publishedCount} new paper${publishedCount === 1 ? '' : 's'} from ${foundCount} result${foundCount === 1 ? '' : 's'}.`,
  };
}

async function recentPapers(): Promise<QueueItem[]> {
  const queue = await loadQueue();
  return queue
    .filter((item) => item.producerWorkerId === WORKER_ID)
    .sort((a, b) => new Date(b.addedAt).getTime() - new Date(a.addedAt).getTime())
    .slice(0, 20);
}

const arxivJob: WorkerJobManifest = {
  id: JOB_ID,
  workerId: WORKER_ID,
  label: 'Fetch arXiv papers',
  description: 'Search arXiv and publish new matching papers as research.paper items.',
  defaultEnabled: false,
  defaultCron: '0 8 * * 1',
  defaultModelAlias: '',
  approvalRequiredDefault: false,
  approvalRequiredEditable: false,
  defaultPrompt: '',
  prompt: { editable: false },
  paramsSchema: ArxivConfigSchema,
  defaultParams: defaultConfig,
  dashboardFields: [
    { key: 'query', label: 'Search query', type: 'text', defaultValue: defaultConfig.query, placeholder: 'cat:cs.AI OR all:"local agents"', helpText: 'Use arXiv query syntax. Examples: cat:cs.AI, au:"Goodfellow", all:"retrieval augmented generation".' },
    { key: 'maxResults', label: 'Max papers per run', type: 'number', defaultValue: defaultConfig.maxResults, min: 1, max: 50, step: 1 },
    { key: 'sortBy', label: 'Sort by', type: 'select', defaultValue: defaultConfig.sortBy, options: [{ value: 'submittedDate', label: 'Newest submitted' }, { value: 'lastUpdatedDate', label: 'Recently updated' }, { value: 'relevance', label: 'Relevance' }] },
    { key: 'includeCategories', label: 'Require categories', type: 'string-list', defaultValue: defaultConfig.includeCategories, rows: 3, helpText: 'Optional category allowlist, one per line, such as cs.AI or cs.CL.' },
  ],
  run: async (_modelId, params) => runArxivSearch(params),
};

const manifest: WorkerManifest = {
  manifestVersion: 1,
  bfrostApiVersion: '0.1',
  id: WORKER_ID,
  name: 'arXiv Search',
  displayName: 'arXiv Search',
  version: '0.1.0',
  description: 'Searches arXiv on a schedule and publishes matching papers to the Item Bus.',
  tagline: 'Watches arXiv for papers you care about and sends the useful ones into BFrost.',
  builtIn: false,
  kind: 'feature',
  jobs: [arxivJob],
  ownedSettings: [
    {
      key: 'arxiv-search-job',
      label: 'arXiv search job',
      description: 'Schedule and query parameters for arXiv paper intake.',
      scope: 'job',
      storageKey: 'admin.settings.jobs.arxiv-search-fetch',
      dashboardTarget: 'jobs',
    },
  ],
  dashboard: {
    routes: [
      {
        id: 'arxiv-search-dashboard',
        label: 'arXiv',
        description: 'arXiv search status, recent papers, and manual run controls.',
        path: '/api/workers/arxiv-search/dashboard',
      },
    ],
  },
};

const module: BackendWorkerModule = {
  manifest,
  async loadDashboardData() {
    const kv = openWorkerKv(WORKER_ID);
    const [lastRun, papers] = await Promise.all([
      kv.get<ArxivRunSummary>('last-run'),
      recentPapers(),
    ]);
    return {
      lastRun: lastRun ?? null,
      recentPapers: papers,
    };
  },
};

export default module;
