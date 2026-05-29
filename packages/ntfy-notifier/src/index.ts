import { z } from 'zod';
import type { BackendWorkerModule, QueueItem, WorkerJobManifest, WorkerManifest } from 'bfrost';
import { filterItemsForConsumer, loadQueue, openWorkerKv, recordEventSafe, saveQueue, setConsumerMetadata, withQueueLock } from 'bfrost';

const WORKER_ID = 'ntfy-notifier';
const JOB_ID = 'ntfy-send';

interface NtfyParams {
  serverUrl: string;
  topic: string;
  itemTypes: string[];
  maxItemsPerRun: number;
  priority: 'default' | 'low' | 'high';
  tags: string[];
  includeSourceUrl: boolean;
}

interface NtfyRunSummary {
  ranAt: string;
  requestedCount: number;
  sentCount: number;
  errors: Array<{ itemId: string; title: string; message: string }>;
}

const NtfyParamsSchema = z.object({
  serverUrl: z.string().trim().min(1).default('https://ntfy.sh'),
  topic: z.string().trim().default(''),
  itemTypes: z.array(z.string().trim().min(1)).default(['news.article', 'research.paper', 'web.page', 'webhook.event']),
  maxItemsPerRun: z.coerce.number().int().min(1).max(20).default(5),
  priority: z.enum(['default', 'low', 'high']).default('default'),
  tags: z.array(z.string().trim().min(1)).default(['bfrost']),
  includeSourceUrl: z.coerce.boolean().default(true),
}).strict();

const defaultParams: NtfyParams = {
  serverUrl: 'https://ntfy.sh',
  topic: '',
  itemTypes: ['news.article', 'research.paper', 'web.page', 'webhook.event'],
  maxItemsPerRun: 5,
  priority: 'default',
  tags: ['bfrost'],
  includeSourceUrl: true,
};

function normalizeServerUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('Only http and https ntfy servers are supported.');
  }
  return url.toString().replace(/\/+$/, '');
}

function priorityHeader(priority: NtfyParams['priority']): string | undefined {
  if (priority === 'low') return '2';
  if (priority === 'high') return '4';
  return undefined;
}

function messageFor(item: QueueItem, includeSourceUrl: boolean): string {
  const lines = [item.shortDesc || item.title];
  if (includeSourceUrl && item.url) lines.push('', item.url);
  return lines.join('\n').slice(0, 1800);
}

async function notifyItem(item: QueueItem, params: NtfyParams): Promise<void> {
  const serverUrl = normalizeServerUrl(params.serverUrl);
  const endpoint = `${serverUrl}/${encodeURIComponent(params.topic)}`;
  const headers: Record<string, string> = {
    Title: item.title.slice(0, 120),
  };
  if (params.tags.length > 0) headers.Tags = params.tags.join(',');
  if (item.url && params.includeSourceUrl) headers.Click = item.url;
  const priority = priorityHeader(params.priority);
  if (priority) headers.Priority = priority;

  const res = await fetch(endpoint, {
    method: 'POST',
    headers,
    body: messageFor(item, params.includeSourceUrl),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`ntfy returned HTTP ${res.status}`);
}

async function markNotified(itemId: string, patch: Record<string, unknown>): Promise<void> {
  await withQueueLock(async () => {
    const queue = await loadQueue();
    const live = queue.find((entry) => entry.id === itemId);
    if (live) {
      setConsumerMetadata(live, WORKER_ID, patch);
      await saveQueue(queue);
    }
  });
}

async function runNtfySend(rawParams?: Record<string, unknown>): Promise<{ summary: string; itemCount: number }> {
  const params = NtfyParamsSchema.parse({ ...defaultParams, ...(rawParams ?? {}) });
  const errors: NtfyRunSummary['errors'] = [];
  let sentCount = 0;

  if (!params.topic.trim()) {
    return { summary: 'ntfy Notifier skipped: no topic configured in Jobs.', itemCount: 0 };
  }

  const candidates = filterItemsForConsumer(await loadQueue(), WORKER_ID, {
    itemTypes: params.itemTypes,
    states: ['queued', 'approved', 'seen'],
    excludeAlreadyHandled: true,
  }).slice(0, params.maxItemsPerRun);

  for (const item of candidates) {
    try {
      await notifyItem(item, params);
      await markNotified(item.id, {
        status: 'sent',
        sentAt: new Date().toISOString(),
        topic: params.topic,
        serverUrl: params.serverUrl,
      });
      sentCount += 1;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      errors.push({ itemId: item.id, title: item.title, message });
      await markNotified(item.id, { status: 'failed', failedAt: new Date().toISOString(), error: message });
    }
  }

  const lastRun: NtfyRunSummary = {
    ranAt: new Date().toISOString(),
    requestedCount: candidates.length,
    sentCount,
    errors,
  };
  await openWorkerKv(WORKER_ID).set('last-run', lastRun);
  await recordEventSafe({
    category: 'worker',
    action: errors.length > 0 ? 'ntfy_send_completed_with_errors' : 'ntfy_send_completed',
    severity: errors.length > 0 ? 'warning' : 'info',
    summary: `ntfy Notifier sent ${sentCount} notification${sentCount === 1 ? '' : 's'}.`,
    metadata: { workerId: WORKER_ID, ...lastRun },
  });

  return {
    itemCount: sentCount,
    summary: candidates.length === 0
      ? 'ntfy Notifier found no eligible Item Bus entries.'
      : `ntfy Notifier sent ${sentCount} notification${sentCount === 1 ? '' : 's'}; ${errors.length} failed.`,
  };
}

async function recentNotifications(): Promise<QueueItem[]> {
  const queue = await loadQueue();
  return queue
    .filter((item) => Boolean(item.metadata?.[WORKER_ID]))
    .sort((a, b) => {
      const aMeta = a.metadata?.[WORKER_ID] ?? {};
      const bMeta = b.metadata?.[WORKER_ID] ?? {};
      return new Date(String(bMeta.sentAt ?? bMeta.failedAt ?? b.addedAt)).getTime()
        - new Date(String(aMeta.sentAt ?? aMeta.failedAt ?? a.addedAt)).getTime();
    })
    .slice(0, 20);
}

const ntfyJob: WorkerJobManifest = {
  id: JOB_ID,
  workerId: WORKER_ID,
  label: 'Send ntfy notifications',
  description: 'Send selected Item Bus entries to an ntfy topic.',
  defaultEnabled: false,
  defaultCron: '*/30 * * * *',
  defaultModelAlias: '',
  approvalRequiredDefault: false,
  approvalRequiredEditable: false,
  defaultPrompt: '',
  prompt: { editable: false },
  paramsSchema: NtfyParamsSchema,
  defaultParams,
  dashboardFields: [
    { key: 'serverUrl', label: 'ntfy server URL', type: 'text', defaultValue: defaultParams.serverUrl, placeholder: 'https://ntfy.sh' },
    { key: 'topic', label: 'Topic', type: 'text', defaultValue: defaultParams.topic, placeholder: 'my-private-topic', helpText: 'Create a hard-to-guess topic name, then subscribe to it in the ntfy mobile or desktop app.' },
    { key: 'itemTypes', label: 'Item types', type: 'string-list', defaultValue: defaultParams.itemTypes, rows: 4, helpText: 'One Item Bus type per line.' },
    { key: 'maxItemsPerRun', label: 'Max notifications per run', type: 'number', defaultValue: defaultParams.maxItemsPerRun, min: 1, max: 20, step: 1 },
    { key: 'priority', label: 'Priority', type: 'select', defaultValue: defaultParams.priority, options: [{ value: 'default', label: 'Default' }, { value: 'low', label: 'Low' }, { value: 'high', label: 'High' }] },
    { key: 'tags', label: 'ntfy tags', type: 'string-list', defaultValue: defaultParams.tags, rows: 2, helpText: 'Optional ntfy tags, one per line.' },
    { key: 'includeSourceUrl', label: 'Include source URL', type: 'boolean', defaultValue: defaultParams.includeSourceUrl },
  ],
  run: async (_modelId, params) => runNtfySend(params),
};

const manifest: WorkerManifest = {
  manifestVersion: 1,
  bfrostApiVersion: '0.1',
  id: WORKER_ID,
  name: 'ntfy Notifier',
  displayName: 'ntfy Notifier',
  version: '0.1.0',
  description: 'Sends selected Item Bus entries to an ntfy topic.',
  tagline: 'Pushes BFrost items to your phone or desktop through ntfy.',
  builtIn: false,
  kind: 'feature',
  permissions: ['network:http', 'network:https'],
  jobs: [ntfyJob],
  ownedSettings: [
    {
      key: 'ntfy-notifier-job',
      label: 'ntfy notification job',
      description: 'Schedule, topic, and item filters for ntfy notifications.',
      scope: 'job',
      storageKey: 'admin.settings.jobs.ntfy-send',
      dashboardTarget: 'jobs',
    },
  ],
  dashboard: {
    routes: [
      {
        id: 'ntfy-notifier-dashboard',
        label: 'ntfy',
        description: 'Notification status, recent sends, and manual run controls.',
        path: '/api/workers/ntfy-notifier/dashboard',
      },
    ],
  },
};

const module: BackendWorkerModule = {
  manifest,
  async loadDashboardData() {
    const kv = openWorkerKv(WORKER_ID);
    const [lastRun, notifications] = await Promise.all([
      kv.get<NtfyRunSummary>('last-run'),
      recentNotifications(),
    ]);
    return {
      lastRun: lastRun ?? null,
      recentNotifications: notifications,
    };
  },
};

export default module;
