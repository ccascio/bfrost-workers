/**
 * Research Notes — core.research (standalone reinstallable package)
 *
 * Searches configured topics with Google Custom Search, fetches article content,
 * synthesizes a Markdown research note with an LLM, and saves it locally.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import https from 'node:https';
import type { BackendWorkerModule, WorkerManifest, AdminApiRoute } from 'bfrost';
import { openWorkerKv, getChatModel, findModel, recordEventSafe, BadRequestError } from 'bfrost';
import { generateText } from 'ai';

const WORKER_ID = 'core.research';
const JOB_ID = 'personal-research';

const kv = openWorkerKv(WORKER_ID);

// ── Storage helpers ────────────────────────────────────────────────────────────

interface ResearchSettings { topics: string[]; }
interface ResearchNoteRecord { id: string; title: string; topics: string[]; createdAt: string; filePath: string; sourceCount: number; }

async function loadResearchSettings(): Promise<ResearchSettings> {
  const s = await kv.get<Partial<ResearchSettings>>('settings');
  return { topics: Array.isArray(s?.topics) ? (s!.topics as string[]).map((t) => t.trim()).filter(Boolean) : [] };
}

async function saveResearchSettings(input: ResearchSettings): Promise<ResearchSettings> {
  const s = { topics: input.topics.map((t) => t.trim()).filter(Boolean) };
  await kv.set('settings', s);
  return s;
}

async function listResearchNotes(limit = 20): Promise<ResearchNoteRecord[]> {
  const notes = await kv.get<ResearchNoteRecord[]>('notes');
  return (notes ?? []).slice(0, limit);
}

function researchNotesDir(): string {
  return process.env.BFROST_RESEARCH_DIR || path.join(process.cwd(), 'data', 'research');
}

// ── Google Search ─────────────────────────────────────────────────────────────

interface SearchResult { title: string; link: string; snippet: string; }

async function searchGoogle(query: string, opts: { num?: number; dateRestrict?: string } = {}): Promise<SearchResult[]> {
  const apiKey = process.env.GOOGLE_CSE_API_KEY || '';
  const cx = process.env.GOOGLE_CSE_ID || '';
  if (!apiKey || !cx) return [];

  const params = new URLSearchParams({ key: apiKey, cx, q: query, num: String(opts.num ?? 5) });
  if (opts.dateRestrict) params.set('dateRestrict', opts.dateRestrict);

  return new Promise((resolve) => {
    const url = `https://www.googleapis.com/customsearch/v1?${params}`;
    https.get(url, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        try {
          const data = JSON.parse(Buffer.concat(chunks).toString());
          const items: SearchResult[] = (data.items ?? []).map((it: any) => ({
            title: String(it.title ?? ''),
            link: String(it.link ?? ''),
            snippet: String(it.snippet ?? ''),
          }));
          resolve(items);
        } catch { resolve([]); }
      });
      res.on('error', () => resolve([]));
    }).on('error', () => resolve([]));
  });
}

// ── Article fetcher ────────────────────────────────────────────────────────────

async function fetchArticleText(url: string): Promise<{ title: string; content: string; fetched: boolean }> {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => resolve({ title: '', content: '', fetched: false }), 10_000);
    try {
      const mod = url.startsWith('https://') ? https : require('node:http');
      const req = mod.get(url, { headers: { 'User-Agent': 'BFrost-Research/0.1' } }, (res: any) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          clearTimeout(timeout);
          resolve({ title: '', content: '', fetched: false });
          return;
        }
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          clearTimeout(timeout);
          const html = Buffer.concat(chunks).toString('utf8', 0, Math.min(Buffer.concat(chunks).length, 200_000));
          const titleMatch = html.match(/<title[^>]*>([^<]*)<\/title>/i);
          const title = titleMatch ? titleMatch[1].trim() : '';
          // Strip scripts, styles, nav, header, footer
          const stripped = html
            .replace(/<script[\s\S]*?<\/script>/gi, '')
            .replace(/<style[\s\S]*?<\/style>/gi, '')
            .replace(/<nav[\s\S]*?<\/nav>/gi, '')
            .replace(/<header[\s\S]*?<\/header>/gi, '')
            .replace(/<footer[\s\S]*?<\/footer>/gi, '')
            .replace(/<[^>]+>/g, ' ')
            .replace(/\s{2,}/g, ' ')
            .trim();
          resolve({ title, content: stripped.slice(0, 8_000), fetched: true });
        });
        res.on('error', () => { clearTimeout(timeout); resolve({ title: '', content: '', fetched: false }); });
      });
      req.on('error', () => { clearTimeout(timeout); resolve({ title: '', content: '', fetched: false }); });
    } catch { clearTimeout(timeout); resolve({ title: '', content: '', fetched: false }); }
  });
}

// ── Params schema (duck-typed) ────────────────────────────────────────────────

const DEFAULT_PARAMS = { maxTopics: 5, resultsPerTopic: 5, dateRestrict: 'm1' };
const paramsSchema = {
  parse: (v: unknown) => {
    const raw = (typeof v === 'object' && v !== null ? v : {}) as Record<string, unknown>;
    return {
      maxTopics: typeof raw.maxTopics === 'number' ? Math.min(20, Math.max(1, raw.maxTopics)) : DEFAULT_PARAMS.maxTopics,
      resultsPerTopic: typeof raw.resultsPerTopic === 'number' ? Math.min(20, Math.max(1, raw.resultsPerTopic)) : DEFAULT_PARAMS.resultsPerTopic,
      dateRestrict: typeof raw.dateRestrict === 'string' && raw.dateRestrict.trim() ? raw.dateRestrict.trim() : DEFAULT_PARAMS.dateRestrict,
    };
  },
} as any;

// ── Default prompt ─────────────────────────────────────────────────────────────

const DEFAULT_PROMPT = `You are a personal research analyst.

Synthesize the provided web findings into a concise research note.

Focus on:
- what changed or seems important
- why it matters
- practical implications
- open questions to track next

Avoid hype. Prefer concrete facts over speculation. Include source links in a final "Sources" section.

Return Markdown only.`;

// ── Main job ──────────────────────────────────────────────────────────────────

async function runPersonalResearch(modelId: string, params = DEFAULT_PARAMS): Promise<{ summary: string; itemCount: number }> {
  const allTopics = (await loadResearchSettings()).topics;
  const topics = allTopics.slice(0, params.maxTopics);

  if (topics.length === 0) {
    return { summary: 'Research: no topics configured. Add topics in the Research settings.', itemCount: 0 };
  }

  await recordEventSafe({ category: 'research', action: 'started', summary: `Research started for ${topics.length} topics.`, metadata: { workerId: WORKER_ID, topics } });

  // Collect findings
  interface Finding extends SearchResult { topic: string; articleTitle: string; articleContent: string; fetched: boolean; }
  const allFindings: Finding[] = [];
  const seenLinks = new Set<string>();

  for (const topic of topics) {
    const query = `${topic} latest research developments`;
    const results = await searchGoogle(query, { num: params.resultsPerTopic, dateRestrict: params.dateRestrict });
    for (let i = 0; i < results.length; i += 3) {
      const batch = results.slice(i, i + 3);
      await Promise.all(batch.map(async (r) => {
        if (seenLinks.has(r.link)) return;
        seenLinks.add(r.link);
        const article = await fetchArticleText(r.link);
        allFindings.push({ ...r, topic, articleTitle: article.title || r.title, articleContent: article.content || r.snippet, fetched: article.fetched });
      }));
    }
  }

  if (allFindings.length === 0) {
    return { summary: `Research: no web results found for ${topics.join(', ')}.`, itemCount: 0 };
  }

  // Synthesize
  const jobSettings = await kv.get<{ prompt?: string }>('job-settings');
  const systemPrompt = (typeof jobSettings?.prompt === 'string' && jobSettings.prompt.trim()) ? jobSettings.prompt : DEFAULT_PROMPT;
  const modelOption = findModel(modelId);
  if (!modelOption) throw new Error(`Unknown model: ${modelId}`);

  const sourcesText = allFindings.map((f, i) =>
    `[${i + 1}] Topic: ${f.topic}\nTitle: ${f.articleTitle}\nURL: ${f.link}\nFetched: ${f.fetched ? 'yes' : 'no'}\nExcerpt: ${(f.articleContent || f.snippet).slice(0, 1200)}`
  ).join('\n\n');

  const { text } = await generateText({
    model: getChatModel(modelOption),
    system: systemPrompt,
    prompt: `/no_think\nResearch topics: ${topics.join(', ')}\n\nWrite a dated Markdown research note from these findings.\n\nFindings:\n\n${sourcesText}`,
    maxTokens: 4000,
  });

  // Save note
  const now = new Date();
  const createdAt = now.toISOString();
  const slug = topics[0].toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'research';
  const id = `${createdAt.replace(/[:.]/g, '-')}-${slug}`;
  const title = `${topics.join(', ')} — ${createdAt.slice(0, 10)}`;
  const notesDir = researchNotesDir();
  const filePath = path.join(notesDir, `${id}.md`);
  const body = `# ${title}\n\n${text.trim()}\n`;

  await fs.mkdir(notesDir, { recursive: true });
  await fs.writeFile(filePath, body, 'utf8');

  const record: ResearchNoteRecord = { id, title, topics, createdAt, filePath, sourceCount: allFindings.length };
  const existing = await kv.get<ResearchNoteRecord[]>('notes') ?? [];
  await kv.set('notes', [record, ...existing].slice(0, 100));

  await recordEventSafe({ category: 'research', action: 'note_created', summary: `Created research note: ${record.title}`, metadata: { workerId: WORKER_ID, id: record.id, topics, filePath, sourceCount: record.sourceCount } });

  return { summary: `Research: created note "${record.title}" with ${record.sourceCount} sources.\nSaved to ${filePath}`, itemCount: 1 };
}

// ── API routes ────────────────────────────────────────────────────────────────

const apiRoutes: AdminApiRoute[] = [
  {
    method: 'GET',
    path: '/api/research/settings',
    handler: async () => {
      const s = await loadResearchSettings();
      const notes = await listResearchNotes(20);
      return { settings: s, notes };
    },
  },
  {
    method: 'POST',
    path: '/api/research/settings',
    handler: async (_ctx, body) => {
      if (typeof body !== 'object' || body === null) throw new BadRequestError('Invalid body');
      const b = body as { topics?: unknown };
      const topics = Array.isArray(b.topics) ? b.topics.filter((t) => typeof t === 'string') : [];
      return saveResearchSettings({ topics });
    },
  },
];

// ── Manifest ──────────────────────────────────────────────────────────────────

const manifest: WorkerManifest = {
  id: WORKER_ID,
  name: 'Research',
  displayName: 'Research Notes',
  version: '0.1.0',
  description: 'Creates durable Markdown research notes from configured topics.',
  tagline: 'Writes a Markdown research note on each topic you care about, on a schedule. Notes are saved locally so you can read, edit, and keep them.',
  builtIn: false,
  requiredDependencies: [
    { key: 'googleSearchConfigured', label: 'Google Web Search', settingsTarget: 'config' },
  ],
  ownedSettings: [
    { key: 'personal-research-job', label: 'Personal research schedule', description: 'Cron, model, prompt, and parameter settings for the research job.', scope: 'job', storageKey: 'admin.settings.jobs.personal-research', dashboardTarget: 'jobs' },
    { key: 'research-topics', label: 'Research topics', description: 'Topics selected in the Research tab.', scope: 'worker', storageKey: 'research.settings', dashboardTarget: 'research' },
  ],
  dashboard: {
    settings: [
      { id: 'research-topics', label: 'Research topics', description: 'Topics used by the personal research job.', tab: 'research', path: '/api/research/settings' },
    ],
    routes: [
      { id: 'research-notes', label: 'Research notes', description: 'Generated Markdown notes.', tab: 'research', path: '/api/dashboard#research' },
    ],
  },
  jobs: [
    {
      id: JOB_ID,
      workerId: WORKER_ID,
      label: 'Personal Research',
      description: 'Searches configured topics and writes concise research notes.',
      defaultEnabled: false,
      defaultCron: '0 7 * * 1',
      defaultModelAlias: '',
      approvalRequiredDefault: false,
      approvalRequiredEditable: false,
      defaultPrompt: DEFAULT_PROMPT,
      prompt: {
        editable: true,
        helpText: 'These instructions tell the AI how to turn raw search results into a research note.',
        examples: [
          { label: 'Default analyst', description: 'Balanced summary with sources.', value: DEFAULT_PROMPT },
          { label: 'Executive brief', description: 'One short paragraph per topic.', value: `You are a research assistant writing for a busy executive.\n\nFor each topic, write exactly one paragraph (3–5 sentences): what happened, why it matters, and one concrete action to consider.\n\nBe direct. No bullet points. No hype. End with a "Sources" section.\n\nReturn Markdown only.` },
        ],
      },
      paramsSchema,
      defaultParams: DEFAULT_PARAMS,
      dashboardFields: [
        { key: 'maxTopics', label: 'Max topics', type: 'number', defaultValue: DEFAULT_PARAMS.maxTopics, min: 1, max: 20 },
        { key: 'resultsPerTopic', label: 'Results per topic', type: 'number', defaultValue: DEFAULT_PARAMS.resultsPerTopic, min: 1, max: 20 },
        { key: 'dateRestrict', label: 'Date restrict', type: 'text', defaultValue: DEFAULT_PARAMS.dateRestrict },
      ],
      run: (_modelId, params) => runPersonalResearch(_modelId, paramsSchema.parse(params ?? {})),
    },
  ],
};

const module_: BackendWorkerModule = { manifest, apiRoutes };
export default module_;
export { manifest };
