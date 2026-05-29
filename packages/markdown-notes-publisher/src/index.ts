import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import type { AdminApiRoute, BackendWorkerModule, QueueItem, WorkerJobManifest, WorkerManifest, WorkerTableHandle } from 'bfrost';
import {
  BadRequestError,
  embedText,
  filterItemsForConsumer,
  loadQueue,
  openWorkerDb,
  openWorkerKv,
  recordEventSafe,
  requestFileRead,
  requestFileWrite,
  saveQueue,
  setConsumerMetadata,
  withQueueLock,
} from 'bfrost';

const WORKER_ID = 'markdown-notes-publisher';
const JOB_ID = 'markdown-notes-write';
const DEFAULT_OUTPUT_DIR = '~/Documents/BFrost Notes';
const MAX_NOTE_BYTES = 512 * 1024;
const MAX_UPLOAD_BYTES = 1024 * 1024;
const MAX_EMBED_CHARS = 12000;

const AVAILABLE_ITEM_TYPES = [
  { value: 'news.article', label: 'News articles', description: 'Built-in News and RSS Harvester articles.' },
  { value: 'research.paper', label: 'Research papers', description: 'arXiv Search papers and academic research items.' },
  { value: 'web.page', label: 'Web pages', description: 'Web Page Harvester captures.' },
  { value: 'webhook.event', label: 'Webhook events', description: 'Incoming JSON events from Webhook Inbox.' },
];

interface MarkdownConfig {
  outputDir: string;
  itemTypes: string[];
  maxItemsPerRun: number;
  filenameTemplate: string;
  frontmatter: boolean;
  includeSourceUrl: boolean;
}

interface NoteFile {
  name: string;
  path: string;
  sizeBytes: number;
  updatedAt: string;
  indexed: boolean;
}

interface NoteVectorRow extends Record<string, unknown> {
  file_path: string;
  name: string;
  output_dir: string;
  content_hash: string;
  excerpt: string;
  embedding_json: string;
  embedding_provider: string;
  embedding_model: string;
  updated_at: string;
}

interface NoteRunSummary {
  ranAt: string;
  requestedCount: number;
  writtenCount: number;
  pendingApprovalCount: number;
  errors: Array<{ itemId: string; title: string; message: string }>;
}

const MarkdownParamsSchema = z.object({
  outputDir: z.string().trim().min(1).default(DEFAULT_OUTPUT_DIR),
  itemTypes: z.array(z.string().trim().min(1)).default(['news.article', 'research.paper']),
  maxItemsPerRun: z.coerce.number().int().min(1).max(20).default(3),
  filenameTemplate: z.string().trim().min(1).default('{date}-{slug}.md'),
  frontmatter: z.coerce.boolean().default(true),
  includeSourceUrl: z.coerce.boolean().default(true),
}).strict();

const defaultConfig: MarkdownConfig = {
  outputDir: DEFAULT_OUTPUT_DIR,
  itemTypes: ['news.article', 'research.paper'],
  maxItemsPerRun: 3,
  filenameTemplate: '{date}-{slug}.md',
  frontmatter: true,
  includeSourceUrl: true,
};

const NotesFolderBodySchema = z.object({
  outputDir: z.string().trim().min(1).default(DEFAULT_OUTPUT_DIR),
}).strict();

const NoteFileBodySchema = NotesFolderBodySchema.extend({
  filename: z.string().trim().min(1),
}).strict();

const UploadFileBodySchema = NoteFileBodySchema.extend({
  content: z.string().max(MAX_UPLOAD_BYTES, 'Markdown file is too large. Keep uploads under 1 MB.'),
}).strict();

const SearchBodySchema = NotesFolderBodySchema.extend({
  query: z.string().trim().min(1),
  limit: z.coerce.number().int().min(1).max(20).default(8),
}).strict();

const IndexFolderBodySchema = NotesFolderBodySchema.extend({
  limit: z.coerce.number().int().min(1).max(50).default(20),
}).strict();

function expandHome(value: string): string {
  if (value === '~') return os.homedir();
  if (value.startsWith('~/')) return path.join(os.homedir(), value.slice(2));
  return value;
}

function resolveNotesDir(outputDir: string): string {
  return path.resolve(expandHome(outputDir || DEFAULT_OUTPUT_DIR));
}

function safeMarkdownFilename(value: string): string {
  const basename = path.basename(value.trim()).replace(/[^A-Za-z0-9._ ()-]+/g, '-').trim();
  const parsed = path.parse(basename || `note-${Date.now()}.md`);
  if (parsed.ext.toLowerCase() === '.md' || parsed.ext.toLowerCase() === '.markdown') return basename;
  return `${parsed.name || 'note'}.md`;
}

function resolveNoteFile(outputDir: string, filename: string): { outputDir: string; name: string; filePath: string } {
  const dir = resolveNotesDir(outputDir);
  const name = safeMarkdownFilename(filename);
  const filePath = path.resolve(dir, name);
  const relative = path.relative(dir, filePath);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new BadRequestError('Markdown file must stay inside the configured notes folder.');
  }
  return { outputDir: dir, name, filePath };
}

function isMarkdownFile(name: string): boolean {
  return name.toLowerCase().endsWith('.md') || name.toLowerCase().endsWith('.markdown');
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

async function noteVectorTable(): Promise<WorkerTableHandle<NoteVectorRow>> {
  const db = await openWorkerDb(WORKER_ID);
  return db.defineTable<NoteVectorRow>('note_vectors', {
    columns: [
      { name: 'file_path', type: 'TEXT', primaryKey: true },
      { name: 'name', type: 'TEXT', notNull: true },
      { name: 'output_dir', type: 'TEXT', notNull: true },
      { name: 'content_hash', type: 'TEXT', notNull: true },
      { name: 'excerpt', type: 'TEXT', notNull: true },
      { name: 'embedding_json', type: 'TEXT', notNull: true },
      { name: 'embedding_provider', type: 'TEXT', notNull: true },
      { name: 'embedding_model', type: 'TEXT', notNull: true },
      { name: 'updated_at', type: 'TEXT', notNull: true },
    ],
    indexes: [
      { name: 'output_dir', columns: ['output_dir'] },
      { name: 'updated_at', columns: ['updated_at'] },
    ],
  });
}

function hashContent(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

function excerptFor(content: string): string {
  return content.replace(/\s+/g, ' ').trim().slice(0, 260);
}

async function indexNoteFile(outputDir: string, filePath: string, content: string): Promise<NoteVectorRow> {
  if (Buffer.byteLength(content, 'utf8') > MAX_NOTE_BYTES) {
    throw new Error('File is too large to index semantically.');
  }
  const embedding = await embedText(`${path.basename(filePath)}\n\n${content.slice(0, MAX_EMBED_CHARS)}`);
  const now = new Date().toISOString();
  const row: NoteVectorRow = {
    file_path: path.resolve(filePath),
    name: path.basename(filePath),
    output_dir: resolveNotesDir(outputDir),
    content_hash: hashContent(content),
    excerpt: excerptFor(content),
    embedding_json: JSON.stringify(embedding.embedding),
    embedding_provider: embedding.provider,
    embedding_model: embedding.model,
    updated_at: now,
  };
  const table = await noteVectorTable();
  table.upsert(row, ['file_path']);
  return row;
}

async function indexNoteFileBestEffort(outputDir: string, filePath: string, content: string): Promise<{ ok: true } | { ok: false; message: string }> {
  try {
    await indexNoteFile(outputDir, filePath, content);
    return { ok: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await recordEventSafe({
      category: 'worker',
      action: 'markdown_note_index_failed',
      severity: 'warning',
      summary: `Markdown Notes could not create an embedding for ${path.basename(filePath)}.`,
      metadata: { workerId: WORKER_ID, filePath, error: message },
    });
    return { ok: false, message };
  }
}

function cosineSimilarity(a: number[], b: number[]): number {
  const length = Math.min(a.length, b.length);
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < length; i += 1) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (!length || normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

function parseVector(row: NoteVectorRow): number[] {
  const parsed = JSON.parse(row.embedding_json) as unknown;
  return Array.isArray(parsed) ? parsed.map(Number).filter((value) => Number.isFinite(value)) : [];
}

async function listMarkdownFiles(outputDir: string): Promise<{ outputDir: string; files: NoteFile[]; indexedCount: number }> {
  const dir = resolveNotesDir(outputDir);
  await fs.mkdir(dir, { recursive: true });
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const table = await noteVectorTable();
  const indexedRows = table.findAll({ where: { output_dir: dir }, limit: 1000 });
  const indexedPaths = new Set(indexedRows.map((row) => row.file_path));
  const files: NoteFile[] = [];

  for (const entry of entries) {
    if (!entry.isFile() || !isMarkdownFile(entry.name)) continue;
    const filePath = path.join(dir, entry.name);
    const stat = await fs.stat(filePath);
    files.push({
      name: entry.name,
      path: filePath,
      sizeBytes: stat.size,
      updatedAt: stat.mtime.toISOString(),
      indexed: indexedPaths.has(path.resolve(filePath)),
    });
  }

  files.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
  return { outputDir: dir, files, indexedCount: indexedRows.length };
}

async function readNoteFile(outputDir: string, filename: string): Promise<{ name: string; path: string; content: string }> {
  const resolved = resolveNoteFile(outputDir, filename);
  const stat = await fs.stat(resolved.filePath);
  if (!stat.isFile() || !isMarkdownFile(resolved.name)) {
    throw new BadRequestError('Choose a Markdown file from the notes folder.');
  }
  if (stat.size > MAX_NOTE_BYTES) {
    throw new BadRequestError('File is too large to preview in the dashboard.');
  }
  const content = await requestFileRead(WORKER_ID, resolved.filePath);
  return { name: resolved.name, path: resolved.filePath, content };
}

async function searchNotes(outputDir: string, query: string, limit: number): Promise<{ outputDir: string; indexedCount: number; results: unknown[] }> {
  const dir = resolveNotesDir(outputDir);
  const table = await noteVectorTable();
  const rows = table.findAll({ where: { output_dir: dir }, limit: 1000 });
  if (rows.length === 0) return { outputDir: dir, indexedCount: 0, results: [] };

  const queryEmbedding = await embedText(query);
  const results = rows
    .map((row) => ({
      name: row.name,
      path: row.file_path,
      excerpt: row.excerpt,
      updatedAt: row.updated_at,
      model: row.embedding_model,
      provider: row.embedding_provider,
      score: cosineSimilarity(queryEmbedding.embedding, parseVector(row)),
    }))
    .filter((result) => result.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((result) => ({ ...result, score: Number(result.score.toFixed(3)) }));

  return { outputDir: dir, indexedCount: rows.length, results };
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
      const semanticIndex = result.approved ? await indexNoteFileBestEffort(outputDir, filePath, content) : null;
      await withQueueLock(async () => {
        const queue = await loadQueue();
        const live = queue.find((entry) => entry.id === item.id);
        if (live) {
          setConsumerMetadata(live, WORKER_ID, {
            filePath,
            requestId: result.requestId,
            requestedAt: new Date().toISOString(),
            status: result.approved ? 'written' : 'approval-needed',
            semanticIndexStatus: semanticIndex?.ok ? 'indexed' : semanticIndex ? 'not-indexed' : 'pending-write',
            semanticIndexError: semanticIndex && !semanticIndex.ok ? semanticIndex.message : undefined,
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

const markdownApiRoutes: AdminApiRoute[] = [
  {
    method: 'GET',
    path: '/api/workers/markdown-notes-publisher/files',
    workerIds: [WORKER_ID],
    async handle({ url }) {
      const outputDir = url.searchParams.get('outputDir') || DEFAULT_OUTPUT_DIR;
      return { status: 200, body: await listMarkdownFiles(outputDir) };
    },
  },
  {
    method: 'POST',
    path: '/api/workers/markdown-notes-publisher/file',
    workerIds: [WORKER_ID],
    async handle({ req, readJsonBody }) {
      const body = await readJsonBody(req, NoteFileBodySchema);
      return { status: 200, body: await readNoteFile(body.outputDir, body.filename) };
    },
  },
  {
    method: 'POST',
    path: '/api/workers/markdown-notes-publisher/upload',
    workerIds: [WORKER_ID],
    async handle({ req, readJsonBody }) {
      const body = await readJsonBody(req, UploadFileBodySchema);
      if (Buffer.byteLength(body.content, 'utf8') > MAX_UPLOAD_BYTES) {
        throw new BadRequestError('Markdown file is too large. Keep uploads under 1 MB.');
      }
      const resolved = resolveNoteFile(body.outputDir, body.filename);
      const write = await requestFileWrite(WORKER_ID, resolved.filePath, body.content, {
        rationale: `Markdown Notes Publisher wants to upload "${resolved.name}" into the notes folder.`,
      });
      const semanticIndex = write.approved ? await indexNoteFileBestEffort(resolved.outputDir, resolved.filePath, body.content) : null;
      return {
        status: 200,
        body: {
          ok: write.approved,
          requestId: write.requestId,
          name: resolved.name,
          path: resolved.filePath,
          semanticIndex,
          message: write.approved
            ? 'File written to the notes folder.'
            : 'Upload requested. Approve the file write in Actions to create the file.',
        },
      };
    },
  },
  {
    method: 'POST',
    path: '/api/workers/markdown-notes-publisher/search',
    workerIds: [WORKER_ID],
    async handle({ req, readJsonBody }) {
      const body = await readJsonBody(req, SearchBodySchema);
      return { status: 200, body: await searchNotes(body.outputDir, body.query, body.limit) };
    },
  },
  {
    method: 'POST',
    path: '/api/workers/markdown-notes-publisher/index',
    workerIds: [WORKER_ID],
    async handle({ req, readJsonBody }) {
      const body = await readJsonBody(req, IndexFolderBodySchema);
      const listing = await listMarkdownFiles(body.outputDir);
      const files = listing.files.slice(0, body.limit);
      const indexed: string[] = [];
      const errors: Array<{ name: string; message: string }> = [];

      for (const file of files) {
        try {
          if (file.sizeBytes > MAX_NOTE_BYTES) {
            errors.push({ name: file.name, message: 'File is too large to index.' });
            continue;
          }
          const content = await requestFileRead(WORKER_ID, file.path);
          await indexNoteFile(listing.outputDir, file.path, content);
          indexed.push(file.name);
        } catch (err) {
          errors.push({ name: file.name, message: err instanceof Error ? err.message : String(err) });
        }
      }

      return {
        status: 200,
        body: {
          outputDir: listing.outputDir,
          indexed,
          indexedCount: indexed.length,
          errorCount: errors.length,
          errors,
        },
      };
    },
  },
];

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
    {
      key: 'itemTypes',
      label: 'Item types',
      type: 'string-list',
      defaultValue: defaultConfig.itemTypes,
      rows: 4,
      suggestions: AVAILABLE_ITEM_TYPES.map((item) => item.value),
      placeholder: 'custom.item.type',
      helpText: 'Select from known Item Bus types. Add a custom type only when another worker documents it.',
    },
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
  version: '0.2.0',
  description: 'Turns selected Item Bus entries into Markdown notes in a folder you choose.',
  tagline: 'Saves useful BFrost items as local Markdown files for Obsidian, Logseq, Joplin, or any notes folder.',
  builtIn: false,
  kind: 'feature',
  permissions: ['file:read:*', 'file:write:*'],
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
  apiRoutes: markdownApiRoutes,
  async loadDashboardData() {
    const kv = openWorkerKv(WORKER_ID);
    const [lastRun, notes] = await Promise.all([
      kv.get<NoteRunSummary>('last-run'),
      recentNotes(),
    ]);
    return {
      availableItemTypes: AVAILABLE_ITEM_TYPES,
      defaultOutputDir: DEFAULT_OUTPUT_DIR,
      lastRun: lastRun ?? null,
      recentNotes: notes,
    };
  },
};

export default module;
