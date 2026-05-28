import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import type { BackendWorkerModule, QueueItem, WorkerJobManifest, WorkerManifest } from 'bfrost';
import {
  filterItemsForConsumer,
  loadQueue,
  openWorkerKv,
  recordEventSafe,
  requestFileWrite,
  saveQueue,
  setConsumerMetadata,
  withQueueLock,
} from 'bfrost';

const WORKER_ID = 'markdown-notes-publisher';
const JOB_ID = 'markdown-notes-write';

interface MarkdownConfig {
  outputDir: string;
  itemTypes: string[];
  maxItemsPerRun: number;
  filenameTemplate: string;
  frontmatter: boolean;
  includeSourceUrl: boolean;
}

interface NoteRunSummary {
  ranAt: string;
  requestedCount: number;
  writtenCount: number;
  pendingApprovalCount: number;
  errors: Array<{ itemId: string; title: string; message: string }>;
}

const MarkdownParamsSchema = z.object({
  outputDir: z.string().trim().min(1).default('~/Documents/BFrost Notes'),
  itemTypes: z.array(z.string().trim().min(1)).default(['news.article', 'research.paper']),
  maxItemsPerRun: z.coerce.number().int().min(1).max(20).default(3),
  filenameTemplate: z.string().trim().min(1).default('{date}-{slug}.md'),
  frontmatter: z.coerce.boolean().default(true),
  includeSourceUrl: z.coerce.boolean().default(true),
}).strict();

const defaultConfig: MarkdownConfig = {
  outputDir: '~/Documents/BFrost Notes',
  itemTypes: ['news.article', 'research.paper'],
  maxItemsPerRun: 3,
  filenameTemplate: '{date}-{slug}.md',
  frontmatter: true,
  includeSourceUrl: true,
};

function expandHome(value: string): string {
  if (value === '~') return os.homedir();
  if (value.startsWith('~/')) return path.join(os.homedir(), value.slice(2));
  return value;
}

function slugify(value: string): string {
  const slug = value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return (slug || 'note').slice(0, 80);
}

function yamlString(value: string): string {
  return JSON.stringify(value.replace(/\r?\n/g, ' '));
}

function itemSummary(item: QueueItem): string {
  const payload = item.payload ?? {};
  const article = (payload.article ?? {}) as Record<string, unknown>;
  const abstract = typeof payload.abstract === 'string' ? payload.abstract : '';
  const summary = typeof payload.summary === 'string' ? payload.summary : '';
  const description = typeof article.description === 'string' ? article.description : '';
  const excerpt = typeof article.excerpt === 'string' ? article.excerpt : '';
  return (abstract || summary || description || excerpt || item.shortDesc || '').trim();
}

function itemAuthors(item: QueueItem): string[] {
  const authors = (item.payload ?? {}).authors;
  return Array.isArray(authors) ? authors.map(String).filter(Boolean) : [];
}

function filenameFor(item: QueueItem, config: MarkdownConfig): string {
  const date = new Date().toISOString().slice(0, 10);
  const safeType = slugify(item.itemType ?? 'item');
  const filename = config.filenameTemplate
    .replaceAll('{date}', date)
    .replaceAll('{type}', safeType)
    .replaceAll('{slug}', slugify(item.title))
    .replaceAll('{id}', slugify(item.id));
  return filename.endsWith('.md') ? filename : `${filename}.md`;
}

function markdownFor(item: QueueItem, config: MarkdownConfig): string {
  const summary = itemSummary(item);
  const authors = itemAuthors(item);
  const lines: string[] = [];

  if (config.frontmatter) {
    lines.push('---');
    lines.push(`title: ${yamlString(item.title)}`);
    lines.push(`source_url: ${yamlString(item.url)}`);
    lines.push(`item_type: ${yamlString(item.itemType ?? '')}`);
    lines.push(`item_id: ${yamlString(item.id)}`);
    lines.push(`created: ${yamlString(new Date().toISOString())}`);
    if (authors.length > 0) lines.push(`authors: [${authors.map(yamlString).join(', ')}]`);
    lines.push('---');
    lines.push('');
  }

  lines.push(`# ${item.title}`);
  lines.push('');
  if (summary) {
    lines.push(summary);
    lines.push('');
  }
  if (authors.length > 0) {
    lines.push(`Authors: ${authors.join(', ')}`);
    lines.push('');
  }
  if (config.includeSourceUrl && item.url) {
    lines.push(`[Open source](${item.url})`);
    lines.push('');
  }
  lines.push('## BFrost');
  lines.push('');
  lines.push(`- Item type: \`${item.itemType ?? 'unknown'}\``);
  lines.push(`- Item ID: \`${item.id}\``);
  lines.push(`- Added: ${item.addedAt}`);
  return `${lines.join('\n').trim()}\n`;
}

async function runMarkdownNotes(params?: Record<string, unknown>): Promise<{ summary: string; itemCount: number }> {
  const config = MarkdownParamsSchema.parse({ ...defaultConfig, ...(params ?? {}) });
  const outputDir = path.resolve(expandHome(config.outputDir));
  let requestedCount = 0;
  let writtenCount = 0;
  let pendingApprovalCount = 0;
  const errors: NoteRunSummary['errors'] = [];
  const candidates = filterItemsForConsumer(await loadQueue(), WORKER_ID, {
    itemTypes: config.itemTypes,
    states: ['queued', 'approved', 'seen'],
    excludeAlreadyHandled: true,
  }).slice(0, config.maxItemsPerRun);

  for (const item of candidates) {
    const filename = filenameFor(item, config);
    const filePath = path.join(outputDir, filename);
    const content = markdownFor(item, config);
    requestedCount += 1;
    try {
      const result = await requestFileWrite(WORKER_ID, filePath, content, {
        rationale: `Markdown Notes Publisher wants to create a note for "${item.title}".`,
      });
      await withQueueLock(async () => {
        const queue = await loadQueue();
        const live = queue.find((entry) => entry.id === item.id);
        if (live) {
          setConsumerMetadata(live, WORKER_ID, {
            filePath,
            requestId: result.requestId,
            requestedAt: new Date().toISOString(),
            status: result.approved ? 'written' : 'approval-needed',
          });
          await saveQueue(queue);
        }
      });
      if (result.approved) writtenCount += 1;
      else pendingApprovalCount += 1;
    } catch (err) {
      errors.push({ itemId: item.id, title: item.title, message: err instanceof Error ? err.message : String(err) });
      await withQueueLock(async () => {
        const queue = await loadQueue();
        const live = queue.find((entry) => entry.id === item.id);
        if (live) {
          setConsumerMetadata(live, WORKER_ID, {
            failedAt: new Date().toISOString(),
            error: err instanceof Error ? err.message : String(err),
          });
          await saveQueue(queue);
        }
      });
    }
  }

  const lastRun: NoteRunSummary = {
    ranAt: new Date().toISOString(),
    requestedCount,
    writtenCount,
    pendingApprovalCount,
    errors,
  };
  await openWorkerKv(WORKER_ID).set('last-run', lastRun);
  await recordEventSafe({
    category: 'worker',
    action: errors.length > 0 ? 'markdown_notes_completed_with_errors' : 'markdown_notes_completed',
    severity: errors.length > 0 ? 'warning' : 'info',
    summary: `Markdown Notes requested ${requestedCount} note${requestedCount === 1 ? '' : 's'} and wrote ${writtenCount}.`,
    metadata: { workerId: WORKER_ID, ...lastRun },
  });

  return {
    itemCount: writtenCount,
    summary: requestedCount === 0
      ? 'Markdown Notes found no eligible Item Bus entries.'
      : `Markdown Notes requested ${requestedCount} note${requestedCount === 1 ? '' : 's'}; ${writtenCount} written, ${pendingApprovalCount} awaiting approval.`,
  };
}

async function recentNotes(): Promise<QueueItem[]> {
  const queue = await loadQueue();
  return queue
    .filter((item) => Boolean(item.metadata?.[WORKER_ID]))
    .sort((a, b) => {
      const aMeta = a.metadata?.[WORKER_ID] ?? {};
      const bMeta = b.metadata?.[WORKER_ID] ?? {};
      return new Date(String(bMeta.requestedAt ?? b.addedAt)).getTime() - new Date(String(aMeta.requestedAt ?? a.addedAt)).getTime();
    })
    .slice(0, 20);
}

const markdownJob: WorkerJobManifest = {
  id: JOB_ID,
  workerId: WORKER_ID,
  label: 'Write Markdown notes',
  description: 'Create Markdown notes from eligible Item Bus entries.',
  defaultEnabled: false,
  defaultCron: '0 18 * * *',
  defaultModelAlias: '',
  approvalRequiredDefault: true,
  approvalRequiredEditable: false,
  defaultPrompt: '',
  prompt: { editable: false },
  paramsSchema: MarkdownParamsSchema,
  defaultParams: defaultConfig,
  dashboardFields: [
    { key: 'outputDir', label: 'Notes folder', type: 'text', defaultValue: defaultConfig.outputDir, placeholder: '~/Documents/BFrost Notes', helpText: 'A local folder for generated .md files. Each write asks for approval before the file is created.' },
    { key: 'itemTypes', label: 'Item types', type: 'string-list', defaultValue: defaultConfig.itemTypes, rows: 3, helpText: 'One Item Bus type per line. Start with news.article and research.paper.' },
    { key: 'maxItemsPerRun', label: 'Max notes per run', type: 'number', defaultValue: defaultConfig.maxItemsPerRun, min: 1, max: 20, step: 1 },
    { key: 'filenameTemplate', label: 'Filename template', type: 'text', defaultValue: defaultConfig.filenameTemplate, helpText: 'Supports {date}, {type}, {slug}, and {id}.' },
    { key: 'frontmatter', label: 'Add YAML frontmatter', type: 'boolean', defaultValue: defaultConfig.frontmatter },
    { key: 'includeSourceUrl', label: 'Include source URL', type: 'boolean', defaultValue: defaultConfig.includeSourceUrl },
  ],
  run: async (_modelId, params) => runMarkdownNotes(params),
};

const manifest: WorkerManifest = {
  manifestVersion: 1,
  bfrostApiVersion: '0.1',
  id: WORKER_ID,
  name: 'Markdown Notes Publisher',
  displayName: 'Markdown Notes Publisher',
  version: '0.1.0',
  description: 'Turns selected Item Bus entries into Markdown notes in a folder you choose.',
  tagline: 'Saves useful BFrost items as local Markdown files for Obsidian, Logseq, Joplin, or any notes folder.',
  builtIn: false,
  kind: 'feature',
  permissions: ['file:write:*'],
  jobs: [markdownJob],
  ownedSettings: [
    {
      key: 'markdown-notes-job',
      label: 'Markdown note job',
      description: 'Schedule and note-writing parameters for Markdown output.',
      scope: 'job',
      storageKey: 'admin.settings.jobs.markdown-notes-write',
      dashboardTarget: 'jobs',
    },
  ],
  dashboard: {
    routes: [
      {
        id: 'markdown-notes-dashboard',
        label: 'Notes',
        description: 'Markdown note output, recent writes, and approval status.',
        path: '/api/workers/markdown-notes-publisher/dashboard',
      },
    ],
  },
};

const module: BackendWorkerModule = {
  manifest,
  async loadDashboardData() {
    const kv = openWorkerKv(WORKER_ID);
    const [lastRun, notes] = await Promise.all([
      kv.get<NoteRunSummary>('last-run'),
      recentNotes(),
    ]);
    return {
      lastRun: lastRun ?? null,
      recentNotes: notes,
    };
  },
};

export default module;
