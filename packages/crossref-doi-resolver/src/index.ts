import { z } from 'zod';
import type { AdminApiRoute, BackendWorkerModule, WorkerManifest, WorkerToolManifest } from 'bfrost';
import { BadRequestError, openWorkerKv, recordEventSafe } from 'bfrost';

const WORKER_ID = 'crossref-doi-resolver';
const SETTINGS_KEY = 'config';
const HISTORY_KEY = 'history';
const CROSSREF_API = 'https://api.crossref.org';
const USER_AGENT = 'BFrost-CrossrefDoiResolver/0.1 (local worker)';

interface CrossrefConfig {
  contactEmail: string;
}

interface CrossrefHistoryItem {
  lookedUpAt: string;
  mode: 'doi' | 'title';
  query: string;
  resultCount: number;
}

interface CrossrefWork {
  DOI?: string;
  title?: string[];
  subtitle?: string[];
  author?: Array<{ given?: string; family?: string; name?: string }>;
  containerTitle?: string[];
  'container-title'?: string[];
  published?: { 'date-parts'?: number[][] };
  issued?: { 'date-parts'?: number[][] };
  URL?: string;
  type?: string;
  publisher?: string;
  abstract?: string;
  score?: number;
}

const CrossrefConfigSchema = z.object({
  contactEmail: z.string().trim().default(''),
}).strict();

const ToolInputSchema = z.object({
  mode: z.enum(['doi', 'title']).default('title'),
  query: z.string().trim().min(1),
  rows: z.coerce.number().int().min(1).max(10).default(5),
}).strict();

function cleanDoi(value: string): string {
  return value.trim().replace(/^https?:\/\/(dx\.)?doi\.org\//i, '').replace(/^doi:\s*/i, '');
}

function first(value?: string[]): string {
  return Array.isArray(value) ? value.find(Boolean) ?? '' : '';
}

function authorName(author: { given?: string; family?: string; name?: string }): string {
  if (author.name) return author.name;
  return [author.given, author.family].filter(Boolean).join(' ');
}

function yearFrom(work: CrossrefWork): string {
  const parts = work.published?.['date-parts'] ?? work.issued?.['date-parts'];
  const year = parts?.[0]?.[0];
  return typeof year === 'number' ? String(year) : '';
}

function formatWork(work: CrossrefWork): Record<string, unknown> {
  const doi = work.DOI ?? '';
  return {
    doi,
    title: first(work.title),
    subtitle: first(work.subtitle),
    authors: (work.author ?? []).slice(0, 12).map(authorName).filter(Boolean),
    containerTitle: first(work['container-title'] ?? work.containerTitle),
    year: yearFrom(work),
    type: work.type ?? '',
    publisher: work.publisher ?? '',
    url: work.URL || (doi ? `https://doi.org/${doi}` : ''),
    score: work.score,
  };
}

async function loadConfig(): Promise<CrossrefConfig> {
  const stored = await openWorkerKv(WORKER_ID).get<Partial<CrossrefConfig>>(SETTINGS_KEY);
  return CrossrefConfigSchema.parse(stored ?? {});
}

async function saveConfig(input: CrossrefConfig): Promise<CrossrefConfig> {
  const parsed = CrossrefConfigSchema.parse(input);
  await openWorkerKv(WORKER_ID).set(SETTINGS_KEY, parsed);
  return parsed;
}

async function saveHistory(item: CrossrefHistoryItem): Promise<void> {
  const kv = openWorkerKv(WORKER_ID);
  const history = (await kv.get<CrossrefHistoryItem[]>(HISTORY_KEY)) ?? [];
  await kv.set(HISTORY_KEY, [item, ...history].slice(0, 25));
}

function apiUrl(path: string, config: CrossrefConfig, params?: Record<string, string>): string {
  const url = new URL(path, CROSSREF_API);
  if (config.contactEmail) url.searchParams.set('mailto', config.contactEmail);
  for (const [key, value] of Object.entries(params ?? {})) {
    if (value) url.searchParams.set(key, value);
  }
  return url.toString();
}

async function fetchJson(url: string): Promise<any> {
  const res = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`Crossref API returned HTTP ${res.status}`);
  return await res.json();
}

async function resolveCrossref(input: z.infer<typeof ToolInputSchema>): Promise<Record<string, unknown>[]> {
  const config = await loadConfig();
  if (input.mode === 'doi') {
    const doi = cleanDoi(input.query);
    const body = await fetchJson(apiUrl(`/works/${encodeURIComponent(doi)}`, config));
    const work = body?.message as CrossrefWork | undefined;
    const result = work ? [formatWork(work)] : [];
    await saveHistory({ lookedUpAt: new Date().toISOString(), mode: 'doi', query: input.query, resultCount: result.length });
    return result;
  }

  const body = await fetchJson(apiUrl('/works', config, {
    'query.title': input.query,
    rows: String(input.rows),
    select: 'DOI,title,subtitle,author,container-title,published,issued,URL,type,publisher,score',
  }));
  const works = Array.isArray(body?.message?.items) ? body.message.items as CrossrefWork[] : [];
  const result = works.map(formatWork);
  await saveHistory({ lookedUpAt: new Date().toISOString(), mode: 'title', query: input.query, resultCount: result.length });
  return result;
}

const resolveDoiTool: WorkerToolManifest = {
  id: 'crossref-resolve-doi',
  workerId: WORKER_ID,
  name: 'resolveCrossrefWork',
  description: 'Resolve a DOI or search publication titles using Crossref. Returns title, authors, venue, year, DOI, and source URL.',
  inputSchema: ToolInputSchema,
  defaultEnabled: true,
  permissions: ['network:https'],
  execute: async (rawInput) => {
    const input = ToolInputSchema.parse(rawInput ?? {});
    const results = await resolveCrossref(input);
    await recordEventSafe({
      category: 'worker',
      action: 'crossref_lookup_completed',
      severity: 'info',
      summary: `Crossref returned ${results.length} result${results.length === 1 ? '' : 's'} for ${input.mode} lookup.`,
      metadata: { workerId: WORKER_ID, mode: input.mode, query: input.query, resultCount: results.length },
    });
    return JSON.stringify({ results }, null, 2);
  },
};

const manifest: WorkerManifest = {
  manifestVersion: 1,
  bfrostApiVersion: '0.1',
  id: WORKER_ID,
  name: 'Crossref DOI Resolver',
  displayName: 'Crossref DOI Resolver',
  version: '0.1.0',
  description: 'Adds a BFrost assistant tool for resolving DOIs and finding publication metadata through Crossref.',
  tagline: 'Lets the BFrost assistant look up DOI, author, venue, and citation metadata from Crossref.',
  builtIn: false,
  kind: 'feature',
  jobs: [],
  tools: [resolveDoiTool],
  ownedSettings: [
    {
      key: 'crossref-doi-config',
      label: 'Crossref polite pool',
      description: 'Optional contact email used for Crossref API requests.',
      scope: 'worker',
      storageKey: `worker.${WORKER_ID}.config`,
      dashboardTarget: 'config',
    },
  ],
  dashboard: {
    settings: [
      {
        id: 'crossref-doi-config',
        label: 'Crossref',
        description: 'Optional API etiquette settings for DOI lookups.',
        tab: 'config',
        path: '/api/workers/crossref-doi-resolver/settings',
        fields: [
          { key: 'contactEmail', label: 'Contact email', type: 'text', defaultValue: '', placeholder: 'you@example.com', helpText: 'Optional. Crossref recommends a contact email for reliable API access.', seedPath: 'crossref-doi-resolver.config.contactEmail' },
        ],
      },
    ],
    routes: [
      {
        id: 'crossref-doi-dashboard',
        label: 'Crossref',
        description: 'Recent DOI/title lookups and assistant-tool status.',
        path: '/api/workers/crossref-doi-resolver/dashboard',
      },
    ],
  },
};

const routes: AdminApiRoute[] = [
  {
    method: 'GET',
    path: '/api/workers/crossref-doi-resolver/settings',
    workerIds: [WORKER_ID],
    handle: async () => ({ status: 200, body: await loadConfig() }),
  },
  {
    method: 'POST',
    path: '/api/workers/crossref-doi-resolver/settings',
    workerIds: [WORKER_ID],
    handle: async (ctx) => {
      const body = await ctx.readJsonBody(ctx.req, CrossrefConfigSchema);
      if (body.contactEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.contactEmail)) {
        throw new BadRequestError('Contact email must be blank or a valid email address.');
      }
      const saved = await saveConfig(body);
      return { status: 200, body: saved };
    },
  },
];

const module: BackendWorkerModule = {
  manifest,
  apiRoutes: routes,
  async loadDashboardData() {
    const kv = openWorkerKv(WORKER_ID);
    const [config, history] = await Promise.all([
      loadConfig(),
      kv.get<CrossrefHistoryItem[]>(HISTORY_KEY),
    ]);
    return {
      config,
      history: history ?? [],
      toolName: resolveDoiTool.name,
    };
  },
};

export default module;
