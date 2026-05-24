import { z } from 'zod';
import type {
  AdminApiRoute,
  BackendWorkerModule,
  QueueItem,
  WorkerJobManifest,
  WorkerManifest,
} from 'bfrost';
import {
  applyConsumerFailure,
  applyConsumerSuccess,
  BadRequestError,
  filterItemsForConsumer,
  loadQueue,
  openWorkerKv,
  recordEventSafe,
  saveQueue,
  withQueueLock,
} from 'bfrost';

const WORKER_ID = 'mastodon-publisher';
const JOB_ID = 'mastodon-post';
const SETTINGS_KEY = 'config';
const MASKED_SECRET = '********';
const DEFAULT_TEMPLATE = '{title}\n\n{summary}\n\n{url}';

const VisibilitySchema = z.enum(['public', 'unlisted', 'private']);
type Visibility = z.infer<typeof VisibilitySchema>;

interface MastodonConfig {
  instanceUrl: string;
  accessToken: string;
  template: string;
  visibility: Visibility;
  maxItemsPerRun: number;
}

interface ArticleProjection {
  title: string;
  summary: string;
  url: string;
  hashtags: string;
}

interface MastodonResult {
  id: string;
  url: string;
}

const MastodonConfigSchema = z.object({
  instanceUrl: z.string().default(''),
  accessToken: z.string().default(''),
  template: z.string().default(DEFAULT_TEMPLATE),
  visibility: VisibilitySchema.default('public'),
  maxItemsPerRun: z.coerce.number().int().min(1).max(10).default(3),
}).strict();

async function loadMastodonConfig(): Promise<MastodonConfig> {
  const stored = await openWorkerKv(WORKER_ID).get<Partial<MastodonConfig> | string>(SETTINGS_KEY);
  if (typeof stored === 'string') {
    try {
      return MastodonConfigSchema.parse(JSON.parse(stored));
    } catch {
      return MastodonConfigSchema.parse({});
    }
  }
  return MastodonConfigSchema.parse(stored ?? {});
}

async function saveMastodonConfig(patch: Partial<MastodonConfig>): Promise<MastodonConfig> {
  const kv = openWorkerKv(WORKER_ID);
  const current = await loadMastodonConfig();
  const next = MastodonConfigSchema.parse({ ...current, ...patch });
  await kv.set(SETTINGS_KEY, next);
  return next;
}

function publicConfig(config: MastodonConfig): MastodonConfig {
  return {
    ...config,
    accessToken: config.accessToken ? MASKED_SECRET : '',
  };
}

function normalizeInstanceUrl(value: string): string {
  return value.trim().replace(/\/+$/, '');
}

function isConfigured(config: MastodonConfig): boolean {
  return Boolean(config.instanceUrl.trim() && config.accessToken.trim());
}

function articleProjection(item: QueueItem): ArticleProjection {
  const payload = item.payload ?? {};
  const article = typeof payload.article === 'object' && payload.article !== null
    ? payload.article as Record<string, unknown>
    : {};
  const title = stringValue(article.title) || stringValue(payload.title) || item.title;
  const summary = stringValue(article.description)
    || stringValue(article.excerpt)
    || stringValue(payload.summary)
    || item.shortDesc;
  const url = stringValue(article.finalUrl) || stringValue(payload.url) || item.url;
  const hashtags = buildHashtags(item.tags ?? []);
  return { title, summary, url, hashtags };
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function buildHashtags(tags: string[]): string {
  const out: string[] = [];
  for (const tag of tags) {
    const normalized = tag.replace(/[^a-zA-Z0-9_]/g, '');
    if (!normalized || normalized.toLowerCase() === 'rss') continue;
    const hashtag = `#${normalized}`;
    if (!out.includes(hashtag)) out.push(hashtag);
    if (out.length >= 5) break;
  }
  return out.join(' ');
}

function truncateStatus(value: string, url: string, maxChars = 500): string {
  const chars = Array.from(value.trim());
  if (chars.length <= maxChars) return value.trim();
  const suffix = `...\n\n${url}`;
  const suffixLength = Array.from(suffix).length;
  const headLength = Math.max(0, maxChars - suffixLength);
  return `${chars.slice(0, headLength).join('').trimEnd()}${suffix}`;
}

function buildStatus(item: QueueItem, template: string): string {
  const article = articleProjection(item);
  const rendered = template
    .replaceAll('{title}', article.title)
    .replaceAll('{summary}', article.summary)
    .replaceAll('{url}', article.url)
    .replaceAll('{hashtags}', article.hashtags);
  return truncateStatus(rendered, article.url);
}

async function postToMastodon(config: MastodonConfig, status: string): Promise<MastodonResult> {
  const res = await fetch(`${normalizeInstanceUrl(config.instanceUrl)}/api/v1/statuses`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      status,
      visibility: config.visibility,
    }),
    signal: AbortSignal.timeout(15_000),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Mastodon HTTP ${res.status}: ${text.slice(0, 300)}`);
  }
  let parsed: Record<string, unknown>;
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`Mastodon returned non-JSON response: ${text.slice(0, 200)}`);
  }
  const id = stringValue(parsed.id);
  const url = stringValue(parsed.url) || stringValue(parsed.uri);
  if (!id) throw new Error(`Mastodon response missing id: ${text.slice(0, 200)}`);
  return { id, url };
}

async function runMastodonPublisher() {
  const config = await loadMastodonConfig();
  if (!isConfigured(config)) {
    return { summary: 'Mastodon credentials missing. Open Config and set instance URL plus access token.', itemCount: 0 };
  }

  let posted = 0;
  const failures: string[] = [];

  await withQueueLock(async () => {
    const queue = await loadQueue();
    const candidates = filterItemsForConsumer(queue, WORKER_ID, {
      itemType: 'news.article',
      states: ['queued', 'approved'],
      excludeAlreadyHandled: true,
    }).slice(0, config.maxItemsPerRun);

    for (const item of candidates) {
      try {
        const status = buildStatus(item, config.template || DEFAULT_TEMPLATE);
        const result = await postToMastodon(config, status);
        applyConsumerSuccess(item, WORKER_ID, {
          postedId: result.id,
          metadata: {
            mastodonStatusId: result.id,
            mastodonUrl: result.url,
            visibility: config.visibility,
            postedAt: new Date().toISOString(),
          },
        });
        posted += 1;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        failures.push(message);
        applyConsumerFailure(item, WORKER_ID, {
          errorMessage: message,
          maxAttempts: 3,
          metadata: {
            failedAt: new Date().toISOString(),
          },
        });
      }
    }

    if (candidates.length > 0) {
      await saveQueue(queue);
    }
  });

  await recordEventSafe({
    category: 'worker',
    action: failures.length > 0 ? 'mastodon_post_completed_with_errors' : 'mastodon_post_completed',
    severity: failures.length > 0 ? 'warning' : 'info',
    summary: `Mastodon Publisher posted ${posted} item${posted === 1 ? '' : 's'}.`,
    metadata: { workerId: WORKER_ID, posted, failures },
  });

  if (posted === 0 && failures.length === 0) {
    return { summary: 'No eligible news.article items to post to Mastodon.', itemCount: 0 };
  }
  return {
    summary: failures.length > 0
      ? `Posted ${posted} item${posted === 1 ? '' : 's'} to Mastodon with ${failures.length} failure${failures.length === 1 ? '' : 's'}.`
      : `Posted ${posted} item${posted === 1 ? '' : 's'} to Mastodon.`,
    itemCount: posted,
  };
}

async function recentPosts(): Promise<QueueItem[]> {
  const queue = await loadQueue();
  return queue
    .filter((item) => Boolean(item.metadata?.[WORKER_ID]?.mastodonStatusId || item.metadata?.[WORKER_ID]?.failedAt))
    .sort((a, b) => {
      const aTime = stringValue(a.metadata?.[WORKER_ID]?.postedAt) || a.lastAttemptAt || a.stateChangedAt || a.addedAt;
      const bTime = stringValue(b.metadata?.[WORKER_ID]?.postedAt) || b.lastAttemptAt || b.stateChangedAt || b.addedAt;
      return new Date(bTime).getTime() - new Date(aTime).getTime();
    })
    .slice(0, 20);
}

const mastodonJob: WorkerJobManifest = {
  id: JOB_ID,
  workerId: WORKER_ID,
  label: 'Mastodon post',
  description: 'Post eligible news.article items as Mastodon statuses.',
  defaultEnabled: false,
  defaultCron: '*/10 * * * *',
  defaultModelAlias: '',
  approvalRequiredDefault: true,
  approvalRequiredEditable: true,
  defaultPrompt: '',
  prompt: { editable: false },
  paramsSchema: z.object({}).strict(),
  defaultParams: {},
  dashboardFields: [],
  run: async () => runMastodonPublisher(),
};

const manifest: WorkerManifest = {
  manifestVersion: 1,
  bfrostApiVersion: '0.1',
  id: WORKER_ID,
  name: 'Mastodon Publisher',
  displayName: 'Mastodon Publisher',
  version: '0.5.0',
  description: 'Posts news.article summaries to a Mastodon instance using the Mastodon API.',
  tagline: 'Posts news.article summaries to a Mastodon instance using the Mastodon API.',
  builtIn: false,
  kind: 'feature',
  jobs: [mastodonJob],
  ownedSettings: [
    {
      key: 'mastodon-publisher-config',
      label: 'Mastodon settings',
      description: 'Instance URL, access token, post template, visibility, and per-run limit.',
      scope: 'worker',
      storageKey: `worker.${WORKER_ID}.config`,
      dashboardTarget: 'config',
    },
  ],
  dashboard: {
    settings: [
      {
        id: 'mastodon-publisher-config',
        label: 'Mastodon connection',
        description: 'Token and posting preferences for the Mastodon API.',
        tab: 'config',
        path: '/api/workers/mastodon-publisher/settings',
        fields: [
          {
            key: 'instanceUrl',
            label: 'Instance URL',
            type: 'text',
            defaultValue: '',
            placeholder: 'https://mastodon.social',
            helpText: 'Your Mastodon instance root URL. No trailing slash is required.',
            seedPath: 'mastodon-publisher.config.instanceUrl',
          },
          {
            key: 'accessToken',
            label: 'Access token',
            type: 'secret-reference',
            defaultValue: '',
            placeholder: 'Paste an access token',
            helpText: 'Create a token in your Mastodon account developer settings.',
            seedPath: 'mastodon-publisher.config.accessToken',
          },
          {
            key: 'visibility',
            label: 'Visibility',
            type: 'select',
            defaultValue: 'public',
            options: [
              { value: 'public', label: 'Public' },
              { value: 'unlisted', label: 'Unlisted' },
              { value: 'private', label: 'Private' },
            ],
            seedPath: 'mastodon-publisher.config.visibility',
          },
          {
            key: 'maxItemsPerRun',
            label: 'Max items per run',
            type: 'number',
            defaultValue: 3,
            min: 1,
            max: 10,
            step: 1,
            seedPath: 'mastodon-publisher.config.maxItemsPerRun',
          },
          {
            key: 'template',
            label: 'Post template',
            type: 'textarea',
            defaultValue: DEFAULT_TEMPLATE,
            rows: 6,
            helpText: 'Supports {title}, {summary}, {url}, and {hashtags}.',
            seedPath: 'mastodon-publisher.config.template',
          },
        ],
      },
    ],
    routes: [
      {
        id: 'mastodon-publisher-dashboard',
        label: 'Mastodon',
        description: 'Mastodon publishing status, recent posts, and manual run controls.',
        path: '/api/workers/mastodon-publisher/dashboard',
      },
    ],
  },
};

const routes: AdminApiRoute[] = [
  {
    method: 'GET',
    path: '/api/workers/mastodon-publisher/settings',
    workerIds: [WORKER_ID],
    handle: async () => ({ status: 200, body: publicConfig(await loadMastodonConfig()) }),
  },
  {
    method: 'POST',
    path: '/api/workers/mastodon-publisher/settings',
    workerIds: [WORKER_ID],
    handle: async (ctx) => {
      const raw = await ctx.readJsonBody(ctx.req, MastodonConfigSchema.partial());
      const patch: Partial<MastodonConfig> = { ...raw };
      if (typeof patch.instanceUrl === 'string') {
        patch.instanceUrl = normalizeInstanceUrl(patch.instanceUrl);
        if (patch.instanceUrl) {
          try {
            new URL(patch.instanceUrl);
          } catch {
            throw new BadRequestError(`Invalid Mastodon instance URL: ${patch.instanceUrl}`);
          }
        }
      }
      if (patch.accessToken === MASKED_SECRET) {
        delete patch.accessToken;
      }
      const saved = await saveMastodonConfig(patch);
      return { status: 200, body: publicConfig(saved) };
    },
  },
];

const module: BackendWorkerModule = {
  manifest,
  apiRoutes: routes,
  async loadDashboardData() {
    const [config, posts] = await Promise.all([loadMastodonConfig(), recentPosts()]);
    return {
      config: publicConfig(config),
      configured: isConfigured(config),
      recentPosts: posts,
    };
  },
};

export default module;
