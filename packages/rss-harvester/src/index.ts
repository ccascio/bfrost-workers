import { createHash } from 'node:crypto';
import { z } from 'zod';
import { generateText } from 'ai';
import type {
  AdminApiRoute,
  BackendWorkerModule,
  QueueItem,
  WorkerJobManifest,
  WorkerManifest,
} from 'bfrost';
import {
  BadRequestError,
  findModel,
  getChatModel,
  getDefaultModel,
  getJobPrompt,
  isModelProviderConfigured,
  loadQueue,
  openWorkerKv,
  publishItem,
  recordEventSafe,
} from 'bfrost';

const WORKER_ID = 'rss-harvester';
const JOB_ID = 'rss-fetch';
const SETTINGS_KEY = 'config';
const USER_AGENT = 'BFrost-RSSHarvester/2.0';
const LLM_TIMEOUT_MS = 120_000;
const LLM_BATCH_SIZE = 15;
const EXCERPT_CHARS = 400;

// ---------- Config ----------

interface HarvesterConfig {
  feeds: string;
  interests: string;
  relevanceThreshold: number;
  maxItemsPerRun: number;
}

const HarvesterConfigSchema = z.object({
  feeds: z.string().default(''),
  interests: z.string().default(''),
  relevanceThreshold: z.number().int().min(1).max(5).default(3),
  maxItemsPerRun: z.number().int().min(1).max(100).default(30),
}).strict();

const FetchParamsSchema = z.object({
  maxItemsPerRun: z.number().int().min(1).max(100).catch(30),
  relevanceThreshold: z.number().int().min(1).max(5).catch(3),
}).strict();
type FetchParams = z.infer<typeof FetchParamsSchema>;

async function loadHarvesterConfig(): Promise<HarvesterConfig> {
  const stored = await openWorkerKv(WORKER_ID).get<Partial<HarvesterConfig> | string>(SETTINGS_KEY);
  if (typeof stored === 'string') {
    try {
      return HarvesterConfigSchema.parse(JSON.parse(stored));
    } catch {
      return HarvesterConfigSchema.parse({ feeds: stored });
    }
  }
  return HarvesterConfigSchema.parse(stored ?? {});
}

async function saveHarvesterConfig(config: HarvesterConfig): Promise<HarvesterConfig> {
  const parsed = HarvesterConfigSchema.parse(config);
  await openWorkerKv(WORKER_ID).set(SETTINGS_KEY, parsed);
  return parsed;
}

function configuredFeeds(config: HarvesterConfig): string[] {
  return config.feeds.split('\n').map((l) => l.trim()).filter(Boolean);
}

function configuredInterests(config: HarvesterConfig): string[] {
  return config.interests.split('\n').map((l) => l.trim()).filter(Boolean);
}

// ---------- Run summary ----------

interface RssRunSummary {
  ranAt: string;
  feedCount: number;
  publishedCount: number;
  filteredCount: number;
  llmUsed: boolean;
  errors: Array<{ feedUrl: string; message: string }>;
}

// ---------- Feed parsing ----------

interface ParsedEntry {
  title: string;
  link: string;
  summary: string;
  publishedAt: string;
}

function feedHost(url: string): string {
  try { return new URL(url).hostname; } catch { return url; }
}

function seenKey(url: string): string {
  return `seen-${createHash('sha256').update(url).digest('hex')}`;
}

function stripXml(value: string): string {
  return value
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function firstMatch(body: string, pattern: RegExp): string {
  return body.match(pattern)?.[1]?.trim() ?? '';
}

function firstTagContent(body: string, tags: string[]): string {
  for (const tag of tags) {
    const value = firstMatch(body, new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i'));
    if (value) return value;
  }
  return '';
}

function dateOrNow(value: string): string {
  if (!value) return new Date().toISOString();
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? new Date().toISOString() : parsed.toISOString();
}

function parseEntries(xml: string): ParsedEntry[] {
  const isAtom = /<feed[\s>]/i.test(xml);
  const tag = isAtom ? 'entry' : 'item';
  const items: ParsedEntry[] = [];

  for (const match of xml.matchAll(new RegExp(`<${tag}[\\s\\S]*?>([\\s\\S]*?)<\\/${tag}>`, 'gi'))) {
    const body = match[1];
    const title = stripXml(firstMatch(body, /<title[^>]*>([\s\S]*?)<\/title>/i));
    const link = isAtom
      ? firstMatch(body, /<link[^>]*href=["']([^"']+)["'][^>]*>/i)
        || stripXml(firstMatch(body, /<link[^>]*>([\s\S]*?)<\/link>/i))
      : stripXml(firstMatch(body, /<link[^>]*>([\s\S]*?)<\/link>/i))
        || stripXml(firstMatch(body, /<guid[^>]*>([\s\S]*?)<\/guid>/i));
    const summary = stripXml(
      isAtom
        ? firstTagContent(body, ['summary', 'content'])
        : firstTagContent(body, ['description', 'content:encoded']),
    ).slice(0, EXCERPT_CHARS);
    const rawDate = isAtom
      ? firstMatch(body, /<(?:published|updated)[^>]*>([\s\S]*?)<\/(?:published|updated)>/i)
      : firstMatch(body, /<pubDate[^>]*>([\s\S]*?)<\/pubDate>/i);

    if (link) {
      items.push({ title, link, summary, publishedAt: dateOrNow(rawDate) });
    }
  }
  return items;
}

// ---------- LLM enrichment ----------

const DEFAULT_PROMPT = `You are an RSS feed relevance filter. The user has defined their interests. For each article, decide whether it is relevant and write a clean 1-2 sentence summary.

Rules:
- Judge relevance against the user's stated interests. Score 1 (irrelevant) to 5 (highly relevant).
- action must be "queue" if relevanceScore >= threshold, otherwise "reject".
- summary must be 1-2 informative sentences in plain English, derived only from the provided title and description.
- tags must be 1-3 lowercase topic keywords.
- Every input URL must appear exactly once in the output array.
- Output only a JSON array — no markdown fences, no commentary.`;

const LlmDecisionSchema = z.object({
  url: z.string(),
  action: z.enum(['queue', 'reject']),
  relevanceScore: z.number().int().min(1).max(5),
  summary: z.string().min(1).max(500),
  tags: z.array(z.string()).default([]),
});
const LlmDecisionArraySchema = z.array(LlmDecisionSchema);
type LlmDecision = z.infer<typeof LlmDecisionSchema>;

function extractJsonArray(text: string): unknown {
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start === -1 || end === -1 || end <= start) {
    throw new Error('No JSON array found in LLM output');
  }
  return JSON.parse(text.slice(start, end + 1));
}

async function enrichWithLlm(
  modelId: string,
  entries: Array<{ link: string; title: string; summary: string }>,
  interests: string[],
  threshold: number,
  systemPrompt: string,
): Promise<Map<string, LlmDecision>> {
  const model = findModel(modelId);
  if (!model) return new Map();

  const interestLine = `User interests: ${interests.join(', ')}`;
  const thresholdLine = `Relevance threshold (queue if score >= this): ${threshold}`;
  const articleList = entries
    .map((e, i) =>
      `[${i + 1}] url: ${e.link}\n    title: ${e.title || '(no title)'}\n    description: ${e.summary || '(none)'}`,
    )
    .join('\n\n');

  const prompt = `/no_think\n${interestLine}\n${thresholdLine}\n\nArticles:\n${articleList}`;

  const { text } = await generateText({
    model: getChatModel(model),
    system: systemPrompt,
    prompt,
    abortSignal: AbortSignal.timeout(LLM_TIMEOUT_MS),
  });

  let raw: unknown;
  try {
    raw = extractJsonArray(text);
  } catch {
    console.warn(`[RSSHarvester] LLM output was not a JSON array — skipping enrichment batch.`);
    return new Map();
  }

  const parsed = LlmDecisionArraySchema.safeParse(raw);
  if (!parsed.success) {
    console.warn(`[RSSHarvester] LLM output schema mismatch — skipping enrichment batch.`);
    return new Map();
  }

  const allowed = new Set(entries.map((e) => e.link));
  const result = new Map<string, LlmDecision>();
  for (const decision of parsed.data) {
    if (allowed.has(decision.url)) {
      result.set(decision.url, decision);
    }
  }
  return result;
}

// ---------- Main job ----------

async function runRssFetch(modelId: string, params: FetchParams): Promise<{ summary: string; itemCount: number }> {
  const kv = openWorkerKv(WORKER_ID);
  const config = await loadHarvesterConfig();
  const feedUrls = configuredFeeds(config);
  const interests = configuredInterests(config);
  const threshold = params.relevanceThreshold;
  const maxItems = params.maxItemsPerRun;
  const errors: RssRunSummary['errors'] = [];

  if (feedUrls.length === 0) {
    return { summary: 'RSS Harvester skipped: no feeds configured.', itemCount: 0 };
  }

  // Determine whether LLM enrichment will be attempted.
  // findModel may return undefined if the scheduler couldn't resolve the alias;
  // isModelProviderConfigured guards that the resolved provider is actually ready.
  const model = findModel(modelId);
  const useLlm = interests.length > 0 && model !== undefined && isModelProviderConfigured(model);

  // Phase 1: fetch all new entries from all feeds
  const allNew: Array<ParsedEntry & { host: string; feedUrl: string }> = [];

  for (const url of feedUrls) {
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': USER_AGENT },
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) {
        errors.push({ feedUrl: url, message: `HTTP ${res.status}` });
        continue;
      }
      const articles = parseEntries(await res.text());
      for (const article of articles) {
        const seen = await kv.get(seenKey(article.link));
        if (!seen) {
          allNew.push({ ...article, host: feedHost(url), feedUrl: url });
        }
      }
    } catch (err) {
      errors.push({ feedUrl: url, message: err instanceof Error ? err.message : String(err) });
    }
  }

  // Phase 2: LLM enrichment (batched) or passthrough
  let published = 0;
  let filteredOut = 0;
  const systemPrompt = await getJobPrompt(JOB_ID, DEFAULT_PROMPT);

  // Limit total items processed by LLM per run to avoid runaway cost
  const toProcess = allNew.slice(0, maxItems);
  const skippedOverflow = allNew.length - toProcess.length;

  let decisions = new Map<string, LlmDecision>();
  if (useLlm && toProcess.length > 0) {
    // Batch articles in groups of LLM_BATCH_SIZE
    for (let i = 0; i < toProcess.length; i += LLM_BATCH_SIZE) {
      const batch = toProcess.slice(i, i + LLM_BATCH_SIZE);
      const batchDecisions = await enrichWithLlm(
        modelId,
        batch.map((e) => ({ link: e.link, title: e.title, summary: e.summary })),
        interests,
        threshold,
        systemPrompt,
      );
      for (const [url, decision] of batchDecisions) {
        decisions.set(url, decision);
      }
    }
  }

  // Phase 3: publish
  for (const article of toProcess) {
    const decision = decisions.get(article.link);

    // If LLM ran and rejected this article, skip it
    if (useLlm && decision && decision.action === 'reject') {
      filteredOut += 1;
      await kv.set(seenKey(article.link), { feedUrl: article.feedUrl, seenAt: new Date().toISOString(), filtered: true });
      continue;
    }

    // If LLM ran but produced no decision (hallucination / parsing failure), publish as-is
    const enrichedSummary = decision?.summary || article.summary || `RSS item from ${article.host}.`;
    const enrichedTags = decision?.tags ?? [];
    const relevanceScore = decision?.relevanceScore;

    await publishItem({
      producerWorkerId: WORKER_ID,
      itemType: 'news.article',
      tags: ['rss', article.host, ...enrichedTags],
      title: article.title || article.link,
      shortDesc: enrichedSummary,
      url: article.link,
      payload: {
        source: {
          host: article.host,
          label: article.host,
          feedUrl: article.feedUrl,
        },
        article: {
          title: article.title,
          description: enrichedSummary,
          excerpt: enrichedSummary,
          finalUrl: article.link,
          publishedAt: article.publishedAt,
        },
        title: article.title,
        url: article.link,
        summary: enrichedSummary,
        publishedAt: article.publishedAt,
        feedUrl: article.feedUrl,
        ...(relevanceScore !== undefined ? { relevanceScore } : {}),
        ...(enrichedTags.length > 0 ? { llmTags: enrichedTags } : {}),
      },
      selectionReason: useLlm && decision
        ? `Relevance score ${relevanceScore}/5 — ${interests.slice(0, 3).join(', ')}.`
        : `Published by RSS feed ${article.feedUrl}.`,
    });

    await kv.set(seenKey(article.link), { feedUrl: article.feedUrl, seenAt: new Date().toISOString() });
    published += 1;
  }

  const lastRun: RssRunSummary = {
    ranAt: new Date().toISOString(),
    feedCount: feedUrls.length,
    publishedCount: published,
    filteredCount: filteredOut,
    llmUsed: useLlm,
    errors,
  };
  await kv.set('last-run', lastRun);

  await recordEventSafe({
    category: 'worker',
    action: errors.length > 0 ? 'rss_fetch_completed_with_errors' : 'rss_fetch_completed',
    severity: errors.length > 0 ? 'warning' : 'info',
    summary: `RSS Harvester published ${published} article${published === 1 ? '' : 's'}${filteredOut > 0 ? `, filtered ${filteredOut}` : ''}${skippedOverflow > 0 ? `, skipped ${skippedOverflow} (limit)` : ''}.`,
    metadata: { workerId: WORKER_ID, feedCount: feedUrls.length, published, filteredOut, llmUsed: useLlm, errors },
  });

  const parts: string[] = [`RSS Harvester published ${published} new article${published === 1 ? '' : 's'} from ${feedUrls.length} feed${feedUrls.length === 1 ? '' : 's'}`];
  if (filteredOut > 0) parts.push(`filtered ${filteredOut} by relevance`);
  if (skippedOverflow > 0) parts.push(`${skippedOverflow} deferred (run limit)`);
  return { summary: parts.join(', ') + '.', itemCount: published };
}

// ---------- Manifest ----------

const rssFetchJob: WorkerJobManifest = {
  id: JOB_ID,
  workerId: WORKER_ID,
  label: 'RSS fetch & filter',
  description: 'Fetch configured RSS/Atom feeds, filter by relevance with an LLM (when interests are set), and publish enriched news.article items.',
  defaultEnabled: true,
  defaultCron: '*/15 * * * *',
  defaultModelAlias: '',
  approvalRequiredDefault: false,
  approvalRequiredEditable: false,
  defaultPrompt: DEFAULT_PROMPT,
  prompt: { editable: true },
  paramsSchema: FetchParamsSchema,
  defaultParams: { maxItemsPerRun: 30, relevanceThreshold: 3 },
  dashboardFields: [
    {
      key: 'maxItemsPerRun',
      label: 'Max items per run',
      type: 'number',
      defaultValue: 30,
      helpText: 'Maximum number of new articles processed (and LLM-scored) in a single run.',
    },
    {
      key: 'relevanceThreshold',
      label: 'Relevance threshold (1–5)',
      type: 'number',
      defaultValue: 3,
      helpText: 'LLM relevance score required to publish an item. Items below this score are dropped. Has no effect when Interests are empty.',
    },
  ],
  presets: [
    {
      id: 'high-volume',
      label: 'High-volume intake',
      description: 'Harvest everything — no LLM filtering, just rapid intake.',
      cron: '*/15 * * * *',
      params: { maxItemsPerRun: 100, relevanceThreshold: 1 },
    },
    {
      id: 'focused-digest',
      label: 'Focused digest',
      description: 'Strict relevance filter — only highly relevant articles pass.',
      cron: '0 * * * *',
      params: { maxItemsPerRun: 30, relevanceThreshold: 4 },
    },
    {
      id: 'daily-sweep',
      label: 'Daily sweep',
      description: 'Once-a-day batch with balanced relevance filter.',
      cron: '0 7 * * *',
      params: { maxItemsPerRun: 60, relevanceThreshold: 3 },
    },
  ],
  run: async (modelId: string, params?: Record<string, unknown>) =>
    runRssFetch(modelId, FetchParamsSchema.parse(params ?? {})),
};

const manifest: WorkerManifest = {
  manifestVersion: 1,
  bfrostApiVersion: '0.1',
  id: WORKER_ID,
  name: 'RSS Harvester',
  displayName: 'RSS & Feed Digest',
  version: '2.0.0',
  description: 'Polls RSS and Atom feeds, applies LLM relevance filtering against your stated interests, and publishes enriched news.article items to the Item Bus.',
  tagline: 'Polls your RSS feeds and uses AI to surface only what you actually care about — configure your interests and let the model filter the noise.',
  builtIn: false,
  kind: 'feature',
  jobs: [rssFetchJob],
  chatPrompts: [
    {
      label: 'Feed status',
      description: 'Check configured feeds and last run.',
      prompt: 'How many RSS feeds are configured and when did the last fetch run?',
    },
    {
      label: 'Recent articles',
      description: 'Show recent RSS items in the queue.',
      prompt: 'Show me the most recent articles harvested from my RSS feeds.',
    },
    {
      label: 'Relevance setup',
      description: 'Help configure interests for LLM filtering.',
      prompt: 'I want to configure the RSS harvester to filter articles by relevance. What interests should I set and how does the threshold work?',
    },
  ],
  ownedSettings: [
    {
      key: 'rss-harvester-config',
      label: 'Feed URLs',
      description: 'Newline-separated list of RSS or Atom feed URLs to poll.',
      scope: 'worker',
      storageKey: `worker.${WORKER_ID}.config`,
      dashboardTarget: 'config',
    },
  ],
  dashboard: {
    settings: [
      {
        id: 'rss-harvester-config',
        label: 'Feeds & Interests',
        description: 'RSS/Atom sources and relevance filter topics.',
        tab: 'config',
        path: '/api/workers/rss-harvester/settings',
        fields: [
          {
            key: 'feeds',
            label: 'Feed URLs',
            type: 'textarea',
            defaultValue: '',
            rows: 8,
            placeholder: 'https://feeds.example.com/rss\nhttps://another.example.com/atom.xml',
            helpText: 'One URL per line. RSS 2.0 and Atom 1.0 are both supported.',
            seedPath: 'rss-harvester.config.feeds',
          },
          {
            key: 'interests',
            label: 'Interests (one per line)',
            type: 'textarea',
            defaultValue: '',
            rows: 5,
            placeholder: 'AI and machine learning\nstartup funding and venture capital\nclimate policy',
            helpText: 'Describe topics you care about. When set, the AI model scores each article for relevance and drops low-scoring items. Leave blank to harvest everything.',
          },
          {
            key: 'relevanceThreshold',
            label: 'Relevance threshold (1–5)',
            type: 'number',
            defaultValue: 3,
            helpText: 'Articles scoring below this threshold are dropped. 1 = keep almost everything, 5 = keep only highly relevant articles.',
          },
          {
            key: 'maxItemsPerRun',
            label: 'Max items per run',
            type: 'number',
            defaultValue: 30,
            helpText: 'Maximum number of new articles to process in a single run. Extra articles are deferred to the next run.',
          },
        ],
      },
    ],
    routes: [
      {
        id: 'rss-harvester-dashboard',
        label: 'RSS',
        description: 'Feed status, LLM filter stats, latest items, and manual run controls.',
        path: '/api/workers/rss-harvester/dashboard',
      },
    ],
  },
};

// ---------- API routes ----------

async function recentItems(): Promise<QueueItem[]> {
  const queue = await loadQueue();
  return queue
    .filter((item) => item.producerWorkerId === WORKER_ID || item.payload?.feedUrl)
    .sort((a, b) => new Date(b.addedAt).getTime() - new Date(a.addedAt).getTime())
    .slice(0, 20);
}

const routes: AdminApiRoute[] = [
  {
    method: 'GET',
    path: '/api/workers/rss-harvester/settings',
    workerIds: [WORKER_ID],
    handle: async () => ({ status: 200, body: await loadHarvesterConfig() }),
  },
  {
    method: 'POST',
    path: '/api/workers/rss-harvester/settings',
    workerIds: [WORKER_ID],
    handle: async (ctx) => {
      const body = await ctx.readJsonBody(ctx.req, HarvesterConfigSchema);
      const feeds = configuredFeeds(body);
      for (const feed of feeds) {
        try { new URL(feed); }
        catch { throw new BadRequestError(`Invalid feed URL: ${feed}`); }
      }
      const saved = await saveHarvesterConfig({
        feeds: feeds.join('\n'),
        interests: body.interests,
        relevanceThreshold: body.relevanceThreshold,
        maxItemsPerRun: body.maxItemsPerRun,
      });
      return { status: 200, body: saved };
    },
  },
];

// ---------- Module ----------

const module: BackendWorkerModule = {
  manifest,
  apiRoutes: routes,
  async loadDashboardData() {
    const [config, items] = await Promise.all([loadHarvesterConfig(), recentItems()]);
    const kv = openWorkerKv(WORKER_ID);
    const lastRun = await kv.get<RssRunSummary>('last-run');
    const feeds = configuredFeeds(config);
    const interests = configuredInterests(config);
    return {
      config,
      feedCount: feeds.length,
      feeds,
      interests,
      lastRun: lastRun ?? null,
      recentItems: items,
      providerConfigured: isModelProviderConfigured(getDefaultModel()),
    };
  },
};

export default module;
