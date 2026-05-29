import { z } from 'zod';
import type { AdminApiRoute, BackendWorkerModule, QueueItem, WorkerManifest } from 'bfrost';
import { BadRequestError, loadQueue, openWorkerKv, publishItem, recordEventSafe } from 'bfrost';

const WORKER_ID = 'webhook-inbox';
const SETTINGS_KEY = 'config';
const HISTORY_KEY = 'history';

interface WebhookConfig {
  token: string;
  sourceLabel: string;
}

interface WebhookHistoryItem {
  receivedAt: string;
  title: string;
  source: string;
  itemId: string;
}

const WebhookConfigSchema = z.object({
  token: z.string().trim().default(''),
  sourceLabel: z.string().trim().min(1).default('Webhook'),
}).strict();

const WebhookBodySchema = z.object({
  token: z.string().optional(),
  title: z.string().optional(),
  eventType: z.string().optional(),
  source: z.string().optional(),
  url: z.string().optional(),
  tags: z.union([z.array(z.string()), z.string()]).optional(),
  payload: z.unknown().optional(),
  text: z.string().optional(),
}).passthrough();

async function loadConfig(): Promise<WebhookConfig> {
  const stored = await openWorkerKv(WORKER_ID).get<Partial<WebhookConfig>>(SETTINGS_KEY);
  return WebhookConfigSchema.parse(stored ?? {});
}

async function saveConfig(input: WebhookConfig): Promise<WebhookConfig> {
  const parsed = WebhookConfigSchema.parse(input);
  await openWorkerKv(WORKER_ID).set(SETTINGS_KEY, parsed);
  return parsed;
}

function headerValue(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value[0] ?? '';
  return value ?? '';
}

function validUrl(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    return new URL(value).toString();
  } catch {
    return null;
  }
}

function titleFor(body: Record<string, unknown>, config: WebhookConfig): string {
  const explicit = typeof body.title === 'string' ? body.title.trim() : '';
  const eventType = typeof body.eventType === 'string' ? body.eventType.trim() : '';
  return explicit || eventType || `${config.sourceLabel} event`;
}

function sourceFor(body: Record<string, unknown>, config: WebhookConfig): string {
  const source = typeof body.source === 'string' ? body.source.trim() : '';
  return source || config.sourceLabel;
}

function tagsFor(body: Record<string, unknown>): string[] {
  const raw = Array.isArray(body.tags)
    ? body.tags
    : typeof body.tags === 'string'
      ? body.tags.split(/[,\n]/)
      : [];
  return Array.from(new Set(['webhook', ...raw.map(String).map((tag) => tag.trim()).filter(Boolean)])).slice(0, 12);
}

async function saveHistory(item: WebhookHistoryItem): Promise<void> {
  const kv = openWorkerKv(WORKER_ID);
  const history = (await kv.get<WebhookHistoryItem[]>(HISTORY_KEY)) ?? [];
  await kv.set(HISTORY_KEY, [item, ...history].slice(0, 25));
}

async function recentItems(): Promise<QueueItem[]> {
  const queue = await loadQueue();
  return queue
    .filter((item) => item.producerWorkerId === WORKER_ID)
    .sort((a, b) => new Date(b.addedAt).getTime() - new Date(a.addedAt).getTime())
    .slice(0, 20);
}

const manifest: WorkerManifest = {
  manifestVersion: 1,
  bfrostApiVersion: '0.1',
  id: WORKER_ID,
  name: 'Webhook Inbox',
  displayName: 'Webhook Inbox',
  version: '0.1.0',
  description: 'Accepts JSON webhook posts and publishes them to the Item Bus as webhook.event items.',
  tagline: 'Gives low-code tools a simple local URL for sending events into BFrost.',
  builtIn: false,
  kind: 'feature',
  jobs: [],
  ownedSettings: [
    {
      key: 'webhook-inbox-config',
      label: 'Webhook inbox',
      description: 'Endpoint token and default labeling for inbound JSON webhook events.',
      scope: 'worker',
      storageKey: `worker.${WORKER_ID}.config`,
      dashboardTarget: 'config',
    },
  ],
  dashboard: {
    settings: [
      {
        id: 'webhook-inbox-config',
        label: 'Webhook Inbox',
        description: 'Token and labels used for inbound webhook events.',
        tab: 'config',
        path: '/api/workers/webhook-inbox/settings',
        fields: [
          { key: 'token', label: 'Webhook token', type: 'text', defaultValue: '', placeholder: 'paste-a-random-token', helpText: 'Optional but recommended. Send it as ?token=... or x-bfrost-webhook-token.', seedPath: 'webhook-inbox.config.token' },
          { key: 'sourceLabel', label: 'Source label', type: 'text', defaultValue: 'Webhook', helpText: 'Shown on dashboard items when the webhook payload has no source field.', seedPath: 'webhook-inbox.config.sourceLabel' },
        ],
      },
    ],
    routes: [
      {
        id: 'webhook-inbox-dashboard',
        label: 'Webhooks',
        description: 'Inbound webhook endpoint, recent events, and setup examples.',
        path: '/api/workers/webhook-inbox/dashboard',
      },
    ],
  },
};

const routes: AdminApiRoute[] = [
  {
    method: 'GET',
    path: '/api/workers/webhook-inbox/settings',
    workerIds: [WORKER_ID],
    handle: async () => ({ status: 200, body: await loadConfig() }),
  },
  {
    method: 'POST',
    path: '/api/workers/webhook-inbox/settings',
    workerIds: [WORKER_ID],
    handle: async (ctx) => {
      const body = await ctx.readJsonBody(ctx.req, WebhookConfigSchema);
      return { status: 200, body: await saveConfig(body) };
    },
  },
  {
    method: 'POST',
    path: '/api/workers/webhook-inbox/ingest',
    workerIds: [WORKER_ID],
    handle: async (ctx) => {
      const config = await loadConfig();
      const body = await ctx.readJsonBody(ctx.req, WebhookBodySchema);
      const receivedToken = body.token ?? ctx.url.searchParams.get('token') ?? headerValue(ctx.req.headers['x-bfrost-webhook-token']);
      if (config.token && receivedToken !== config.token) {
        throw new BadRequestError('Webhook token missing or invalid.');
      }

      const record = { ...body } as Record<string, unknown>;
      delete record.token;
      const title = titleFor(record, config);
      const source = sourceFor(record, config);
      const url = validUrl(record.url) ?? `https://bfrost.local/webhook-inbox/${encodeURIComponent(Date.now().toString())}`;
      const text = typeof record.text === 'string' ? record.text : '';
      const payload = record.payload === undefined ? record : record.payload;
      const item = await publishItem({
        producerWorkerId: WORKER_ID,
        itemType: 'webhook.event',
        tags: tagsFor(record),
        title,
        shortDesc: text.slice(0, 500) || `Webhook event from ${source}.`,
        url,
        payload: {
          source: { host: 'webhook', label: source },
          receivedAt: new Date().toISOString(),
          eventType: typeof record.eventType === 'string' ? record.eventType : '',
          payload: typeof payload === 'object' && payload !== null ? payload as Record<string, unknown> : { value: payload },
        },
        selectionReason: `Received by Webhook Inbox from ${source}.`,
      });
      const historyItem = { receivedAt: new Date().toISOString(), title, source, itemId: item.id };
      await saveHistory(historyItem);
      await recordEventSafe({
        category: 'worker',
        action: 'webhook_event_received',
        severity: 'info',
        summary: `Webhook Inbox received ${title}.`,
        metadata: { workerId: WORKER_ID, source, itemId: item.id },
      });
      return { status: 200, body: { ok: true, itemId: item.id, title } };
    },
  },
];

const module: BackendWorkerModule = {
  manifest,
  apiRoutes: routes,
  async loadDashboardData() {
    const kv = openWorkerKv(WORKER_ID);
    const [config, history, items] = await Promise.all([
      loadConfig(),
      kv.get<WebhookHistoryItem[]>(HISTORY_KEY),
      recentItems(),
    ]);
    return {
      config,
      history: Array.isArray(history) ? history : [],
      recentItems: items,
      endpointPath: '/api/workers/webhook-inbox/ingest',
    };
  },
};

export default module;
