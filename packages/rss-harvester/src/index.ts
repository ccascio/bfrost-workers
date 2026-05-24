import { createHash } from 'node:crypto';
import { z } from 'zod';
import type {
  AdminApiRoute,
  BackendWorkerModule,
  QueueItem,
  WorkerJobManifest,
  WorkerManifest,
} from 'bfrost';
import { BadRequestError, loadQueue, openWorkerKv, publishItem, recordEventSafe } from 'bfrost';

const WORKER_ID = 'rss-harvester';
const JOB_ID = 'rss-fetch';
const SETTINGS_KEY = 'config';
const USER_AGENT = 'BFrost-RSSHarvester/1.1';

interface HarvesterConfig {
  feeds: string;
}

interface RssRunSummary {
  ranAt: string;
  feedCount: number;
  publishedCount: number;
  errors: Array<{ feedUrl: string; message: string }>;
}

interface ParsedEntry {
  title: string;
  link: string;
  summary: string;
  publishedAt: string;
}

const HarvesterConfigSchema = z.object({
  feeds: z.string().default(''),
}).strict();

async function loadHarvesterConfig(): Promise<HarvesterConfig> {
  const stored = await openWorkerKv(WORKER_ID).get<Partial<HarvesterConfig> | string>(SETTINGS_KEY);
  if (typeof stored === 'string') {
    try {
      return HarvesterConfigSchema.parse(JSON.parse(stored));
    } catch {
      return { feeds: stored };
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
  return config.feeds
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

function feedHost(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
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
    const pattern = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i');
    const value = firstMatch(body, pattern);
    if (value) return value;
  }
  return '';
}

function dateOrNow(value: string): string {
  if (!value) return new Date().toISOString();
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return new Date().toISOString();
  return parsed.toISOString();
}

function parseEntries(xml: string): ParsedEntry[] {
  const items: ParsedEntry[] = [];
  const isAtom = /<feed[\s>]/i.test(xml);
  const tag = isAtom ? 'entry' : 'item';
  const entries = xml.matchAll(new RegExp(`<${tag}[\\s\\S]*?>([\\s\\S]*?)<\\/${tag}>`, 'gi'));

  for (const match of entries) {
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
    ).slice(0, 500);
    const rawDate = isAtom
      ? firstMatch(body, /<(?:published|updated)[^>]*>([\s\S]*?)<\/(?:published|updated)>/i)
      : firstMatch(body, /<pubDate[^>]*>([\s\S]*?)<\/pubDate>/i);

    if (link) {
      items.push({
        title,
        link,
        summary,
        publishedAt: dateOrNow(rawDate),
      });
    }
  }
  return items;
}

async function runRssFetch() {
  const kv = openWorkerKv(WORKER_ID);
  const config = await loadHarvesterConfig();
  const feedUrls = configuredFeeds(config);
  const errors: RssRunSummary['errors'] = [];

  if (feedUrls.length === 0) {
    return { summary: 'RSS Harvester skipped: no feeds configured.', itemCount: 0 };
  }

  let published = 0;
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
        if (seen) continue;
        await publishItem({
          producerWorkerId: WORKER_ID,
          itemType: 'news.article',
          tags: ['rss', feedHost(url)],
          title: article.title || article.link,
          shortDesc: article.summary || `RSS item from ${feedHost(url)}.`,
          url: article.link,
          payload: {
            source: {
              host: feedHost(url),
              label: feedHost(url),
              feedUrl: url,
            },
            article: {
              title: article.title,
              description: article.summary,
              excerpt: article.summary,
              finalUrl: article.link,
              publishedAt: article.publishedAt,
            },
            title: article.title,
            url: article.link,
            summary: article.summary,
            publishedAt: article.publishedAt,
            feedUrl: url,
          },
          selectionReason: `Published by RSS feed ${url}.`,
        });
        await kv.set(seenKey(article.link), { feedUrl: url, seenAt: new Date().toISOString() });
        published += 1;
      }
    } catch (err) {
      errors.push({ feedUrl: url, message: err instanceof Error ? err.message : String(err) });
    }
  }

  const lastRun: RssRunSummary = {
    ranAt: new Date().toISOString(),
    feedCount: feedUrls.length,
    publishedCount: published,
    errors,
  };
  await kv.set('last-run', lastRun);

  await recordEventSafe({
    category: 'worker',
    action: errors.length > 0 ? 'rss_fetch_completed_with_errors' : 'rss_fetch_completed',
    severity: errors.length > 0 ? 'warning' : 'info',
    summary: `RSS Harvester published ${published} new article${published === 1 ? '' : 's'}.`,
    metadata: { workerId: WORKER_ID, feedCount: feedUrls.length, published, errors },
  });

  const summary = `RSS Harvester published ${published} new article${published === 1 ? '' : 's'} from ${feedUrls.length} feed${feedUrls.length === 1 ? '' : 's'}.`;
  return { summary, itemCount: published };
}

async function recentItems(): Promise<QueueItem[]> {
  const queue = await loadQueue();
  return queue
    .filter((item) => item.producerWorkerId === WORKER_ID || item.payload?.feedUrl)
    .sort((a, b) => new Date(b.addedAt).getTime() - new Date(a.addedAt).getTime())
    .slice(0, 20);
}

const rssFetchJob: WorkerJobManifest = {
  id: JOB_ID,
  workerId: WORKER_ID,
  label: 'RSS fetch',
  description: 'Fetch configured RSS/Atom feeds and publish new articles.',
  defaultEnabled: true,
  defaultCron: '*/15 * * * *',
  defaultModelAlias: '',
  approvalRequiredDefault: false,
  approvalRequiredEditable: false,
  defaultPrompt: '',
  prompt: { editable: false },
  paramsSchema: z.object({}).strict(),
  defaultParams: {},
  dashboardFields: [],
  run: async () => runRssFetch(),
};

const manifest: WorkerManifest = {
  manifestVersion: 1,
  bfrostApiVersion: '0.1',
  id: WORKER_ID,
  name: 'RSS Harvester',
  displayName: 'RSS Harvester',
  version: '1.1.0',
  description: 'Polls RSS and Atom feeds on a schedule and publishes news.article items to the Item Bus.',
  tagline: 'Polls RSS and Atom feeds on a schedule and publishes news.article items to the Item Bus.',
  builtIn: false,
  kind: 'feature',
  jobs: [rssFetchJob],
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
        label: 'Feed URLs',
        description: 'RSS and Atom sources polled by the worker.',
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
            helpText: 'One URL per line. RSS and Atom formats are both supported.',
            seedPath: 'rss-harvester.config.feeds',
          },
        ],
      },
    ],
    routes: [
      {
        id: 'rss-harvester-dashboard',
        label: 'RSS',
        description: 'Feed status, latest fetched items, and manual run controls.',
        path: '/api/workers/rss-harvester/dashboard',
      },
    ],
  },
};

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
        try {
          new URL(feed);
        } catch {
          throw new BadRequestError(`Invalid feed URL: ${feed}`);
        }
      }
      const saved = await saveHarvesterConfig({ feeds: feeds.join('\n') });
      return { status: 200, body: saved };
    },
  },
];

const module: BackendWorkerModule = {
  manifest,
  apiRoutes: routes,
  async loadDashboardData() {
    const [config, items] = await Promise.all([loadHarvesterConfig(), recentItems()]);
    const kv = openWorkerKv(WORKER_ID);
    const lastRun = await kv.get<RssRunSummary>('last-run');
    const feeds = configuredFeeds(config);
    return {
      config,
      feedCount: feeds.length,
      feeds,
      lastRun: lastRun ?? null,
      recentItems: items,
    };
  },
};

export default module;
