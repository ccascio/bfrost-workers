/**
 * Daily News Digest — core.news (standalone reinstallable package)
 *
 * Uses Google Custom Search to find articles matching configured interests,
 * scores and deduplicates them, then queues them for review.
 */

import https from 'node:https';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { generateText } from 'ai';
import type { BackendWorkerModule, WorkerManifest, AdminApiRoute } from 'bfrost';
import {
  openWorkerKv,
  getChatModel,
  findModel,
  loadQueue,
  saveQueue,
  withQueueLock,
  recordEventSafe,
  BadRequestError,
} from 'bfrost';

const WORKER_ID = 'core.news';
const JOB_ID = 'news-digest';
const kv = openWorkerKv(WORKER_ID);

// ── Types ─────────────────────────────────────────────────────────────────────

type QueueItemState = 'seen' | 'rejected' | 'queued' | 'approved' | 'posted' | 'failed';
interface QueueItem {
  id: string; title: string; shortDesc: string; url: string; addedAt: string;
  state: QueueItemState; sourceHost?: string; sourceScore?: number; sourceLabel?: string;
  articleTitle?: string; articleDescription?: string; articleExcerpt?: string;
  articleFetched?: boolean; articleFinalUrl?: string; digestRunId?: string;
  [key: string]: unknown;
}

interface SourceQualityRules {
  minScore: number;
  allowHosts: string[];
  blockHosts: string[];
  preferredHosts: string[];
  lowQualityHosts: string[];
}

// ── Queue helpers ─────────────────────────────────────────────────────────────

function pruneQueue(queue: QueueItem[], nowMs: number, retentionMs = 7 * 24 * 60 * 60 * 1000): QueueItem[] {
  return queue.filter((it) => {
    const age = nowMs - Date.parse(it.addedAt);
    if (['seen', 'rejected'].includes(it.state) && age > retentionMs) return false;
    if (it.state === 'posted' && age > retentionMs) return false;
    return true;
  });
}

function createQueueItem(draft: Omit<QueueItem, 'id'>): QueueItem {
  const { url, addedAt, title } = draft;
  const id = 'qi_' + createHash('sha256').update(`${url}|${addedAt}|${title}`).digest('hex').slice(0, 16);
  return { id, ...draft };
}

function canonicalizeUrl(rawUrl: string): string | null {
  try {
    const u = new URL(rawUrl);
    u.hash = '';
    for (const key of ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content']) u.searchParams.delete(key);
    return u.toString().replace(/\/$/, '').toLowerCase();
  } catch { return null; }
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
        try { const d = JSON.parse(Buffer.concat(chunks).toString()); resolve((d.items ?? []).map((it: any) => ({ title: String(it.title ?? ''), link: String(it.link ?? ''), snippet: String(it.snippet ?? '') }))); }
        catch { resolve([]); }
      });
      res.on('error', () => resolve([]));
    }).on('error', () => resolve([]));
  });
}

// ── Article fetcher ────────────────────────────────────────────────────────────

async function fetchArticleText(rawUrl: string): Promise<{ title: string; description: string; excerpt: string; finalUrl: string; fetched: boolean }> {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => resolve({ title: '', description: '', excerpt: '', finalUrl: rawUrl, fetched: false }), 12_000);
    const mod = rawUrl.startsWith('https://') ? https : http;
    const req = mod.get(rawUrl, { headers: { 'User-Agent': 'BFrost-News/0.1' } }, (res) => {
      const finalUrl = (res.headers['location'] as string) || rawUrl;
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400) {
        clearTimeout(timeout);
        resolve({ title: '', description: '', excerpt: '', finalUrl, fetched: false });
        return;
      }
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        clearTimeout(timeout);
        const raw = Buffer.concat(chunks);
        const html = raw.toString('utf8', 0, Math.min(raw.length, 150_000));
        const title = (html.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1] ?? '').trim();
        const desc = (html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']{0,500})["']/i)?.[1] ?? '').trim();
        const stripped = html
          .replace(/<script[\s\S]*?<\/script>/gi, '')
          .replace(/<style[\s\S]*?<\/style>/gi, '')
          .replace(/<[^>]+>/g, ' ')
          .replace(/\s{2,}/g, ' ').trim();
        resolve({ title, description: desc, excerpt: stripped.slice(0, 3_000), finalUrl, fetched: true });
      });
      res.on('error', () => { clearTimeout(timeout); resolve({ title: '', description: '', excerpt: '', finalUrl, fetched: false }); });
    });
    req.on('error', () => { clearTimeout(timeout); resolve({ title: '', description: '', excerpt: '', finalUrl, fetched: false }); });
  });
}

// ── Source quality ─────────────────────────────────────────────────────────────

async function loadSourceQualityRules(): Promise<SourceQualityRules> {
  const r = await kv.get<Partial<SourceQualityRules>>('source-quality-rules');
  return {
    minScore: typeof r?.minScore === 'number' ? r.minScore : 0,
    allowHosts: Array.isArray(r?.allowHosts) ? r.allowHosts : [],
    blockHosts: Array.isArray(r?.blockHosts) ? r.blockHosts : [],
    preferredHosts: Array.isArray(r?.preferredHosts) ? r.preferredHosts : [],
    lowQualityHosts: Array.isArray(r?.lowQualityHosts) ? r.lowQualityHosts : [],
  };
}

function hostOf(url: string): string {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; }
}

interface SourceScore { score: number; label: 'high' | 'medium' | 'low' | 'blocked' | 'allowlisted'; reasons: string[]; }

function assessSource(url: string, rules: SourceQualityRules): SourceScore {
  const host = hostOf(url);
  if (rules.blockHosts.some((h) => host === h || host.endsWith('.' + h))) return { score: -1, label: 'blocked', reasons: [`Blocked host: ${host}.`] };
  if (rules.allowHosts.some((h) => host === h || host.endsWith('.' + h))) return { score: 10, label: 'allowlisted', reasons: [`Allowlisted host: ${host}.`] };
  let score = 5;
  const reasons: string[] = [];
  if (rules.preferredHosts.some((h) => host === h || host.endsWith('.' + h))) { score += 3; reasons.push(`Preferred host: ${host}.`); }
  if (rules.lowQualityHosts.some((h) => host === h || host.endsWith('.' + h))) { score -= 3; reasons.push(`Low quality host: ${host}.`); }
  score = Math.max(0, Math.min(10, score));
  const label = score >= 7 ? 'high' : score >= 4 ? 'medium' : 'low';
  return { score, label, reasons };
}

// ── Params schema ─────────────────────────────────────────────────────────────

const DEFAULT_INTERESTS = ['AI and software', 'Technology news', 'Science'];
const DEFAULT_PARAMS = { interests: DEFAULT_INTERESTS, maxResultsPerInterest: 5, dateRestrict: 'd3', maxQueueAdditions: 20, fetchArticles: true };
const paramsSchema = {
  parse: (v: unknown) => {
    const raw = (typeof v === 'object' && v !== null ? v : {}) as Record<string, unknown>;
    return {
      interests: Array.isArray(raw.interests) ? (raw.interests as unknown[]).filter((i) => typeof i === 'string') : DEFAULT_PARAMS.interests,
      maxResultsPerInterest: typeof raw.maxResultsPerInterest === 'number' ? Math.min(20, Math.max(1, raw.maxResultsPerInterest)) : DEFAULT_PARAMS.maxResultsPerInterest,
      dateRestrict: typeof raw.dateRestrict === 'string' && raw.dateRestrict.trim() ? raw.dateRestrict.trim() : DEFAULT_PARAMS.dateRestrict,
      maxQueueAdditions: typeof raw.maxQueueAdditions === 'number' ? Math.min(50, Math.max(1, raw.maxQueueAdditions)) : DEFAULT_PARAMS.maxQueueAdditions,
      fetchArticles: typeof raw.fetchArticles === 'boolean' ? raw.fetchArticles : DEFAULT_PARAMS.fetchArticles,
    };
  },
} as any;

// ── Main job ──────────────────────────────────────────────────────────────────

async function runNewsDigest(modelId: string, params = DEFAULT_PARAMS): Promise<{ summary: string; itemCount: number }> {
  const rules = await loadSourceQualityRules();
  const runId = new Date().toISOString().replace(/[:.]/g, '-');
  await recordEventSafe({ category: 'news', action: 'digest_started', summary: `News digest started (interests: ${params.interests.join(', ')}).`, metadata: { workerId: WORKER_ID, interests: params.interests } });

  // Collect search results
  const seenUrls = new Set<string>();
  interface Candidate { url: string; title: string; snippet: string; interest: string; }
  const candidates: Candidate[] = [];

  for (const interest of params.interests) {
    const results = await searchGoogle(`${interest} latest news`, { num: params.maxResultsPerInterest, dateRestrict: params.dateRestrict });
    for (const r of results) {
      const canon = canonicalizeUrl(r.link);
      if (!canon || seenUrls.has(canon)) continue;
      seenUrls.add(canon);
      candidates.push({ url: r.link, title: r.title, snippet: r.snippet, interest });
    }
  }

  if (candidates.length === 0) {
    return { summary: `News digest: no results found for interests: ${params.interests.join(', ')}.`, itemCount: 0 };
  }

  return withQueueLock(async () => {
    const nowMs = Date.now();
    const queue = pruneQueue(await loadQueue() as QueueItem[], nowMs);
    const existingUrls = new Set(queue.map((it) => canonicalizeUrl(it.url)).filter(Boolean));

    let added = 0;
    const newItems: QueueItem[] = [];

    for (const candidate of candidates) {
      if (added >= params.maxQueueAdditions) break;
      const canon = canonicalizeUrl(candidate.url);
      if (canon && existingUrls.has(canon)) continue;

      const src = assessSource(candidate.url, rules);
      if (src.label === 'blocked') continue;
      if (src.score < rules.minScore) continue;

      const addedAt = new Date().toISOString();
      let articleTitle = candidate.title;
      let articleDescription = candidate.snippet;
      let articleExcerpt = '';
      let articleFetched = false;
      let articleFinalUrl = candidate.url;

      if (params.fetchArticles) {
        const article = await fetchArticleText(candidate.url);
        if (article.title) articleTitle = article.title;
        if (article.description) articleDescription = article.description;
        articleExcerpt = article.excerpt;
        articleFetched = article.fetched;
        articleFinalUrl = article.finalUrl;
      }

      const item = createQueueItem({
        title: articleTitle || candidate.title,
        shortDesc: articleDescription || candidate.snippet,
        url: candidate.url,
        addedAt,
        state: 'queued',
        sourceHost: hostOf(candidate.url),
        sourceScore: src.score,
        sourceLabel: src.label,
        sourceReasons: src.reasons,
        articleTitle,
        articleDescription,
        articleExcerpt,
        articleFetched,
        articleFinalUrl,
        digestRunId: runId,
      });

      newItems.push(item);
      if (canon) existingUrls.add(canon);
      added++;
    }

    const updatedQueue = [...newItems, ...queue];
    await saveQueue(updatedQueue as any);

    await recordEventSafe({ category: 'news', action: 'digest_completed', summary: `News digest: added ${added} items to queue.`, metadata: { workerId: WORKER_ID, addedCount: added, candidateCount: candidates.length } });

    return { summary: `News digest: added ${added} new articles to the queue (${candidates.length} candidates found).`, itemCount: added };
  });
}

// ── API routes ─────────────────────────────────────────────────────────────────

const apiRoutes: AdminApiRoute[] = [
  {
    method: 'GET',
    path: '/api/news/source-quality',
    handler: async () => loadSourceQualityRules(),
  },
  {
    method: 'POST',
    path: '/api/news/source-quality',
    handler: async (_ctx, body) => {
      if (typeof body !== 'object' || body === null) throw new BadRequestError('Invalid body');
      const b = body as Partial<SourceQualityRules>;
      const current = await loadSourceQualityRules();
      const next: SourceQualityRules = {
        minScore: typeof b.minScore === 'number' ? b.minScore : current.minScore,
        allowHosts: Array.isArray(b.allowHosts) ? b.allowHosts : current.allowHosts,
        blockHosts: Array.isArray(b.blockHosts) ? b.blockHosts : current.blockHosts,
        preferredHosts: Array.isArray(b.preferredHosts) ? b.preferredHosts : current.preferredHosts,
        lowQualityHosts: Array.isArray(b.lowQualityHosts) ? b.lowQualityHosts : current.lowQualityHosts,
      };
      await kv.set('source-quality-rules', next);
      return next;
    },
  },
];

// ── Manifest ──────────────────────────────────────────────────────────────────

const DEFAULT_PROMPT = `You are a careful news curator. Review each article in the list and decide whether to keep it in the queue.

Remove items that are:
- Duplicate or near-duplicate of another item
- Pure opinion with no factual content
- Clickbait or sensationalism
- Sponsored content or press releases

Keep items that are informative, factual, and relevant to the stated interests.

Return a JSON array of item numbers to KEEP (e.g. [1, 3, 5]). Return ALL item numbers to keep everything.`;

const manifest: WorkerManifest = {
  id: WORKER_ID,
  name: 'News',
  displayName: 'Daily News Digest',
  version: '0.1.0',
  description: 'Collects, evaluates, deduplicates, and queues news digest items.',
  tagline: 'Pulls articles from sources you choose, scores them for quality, and queues a short digest you can review before anything else uses it.',
  builtIn: false,
  requiredDependencies: [
    { key: 'googleSearchConfigured', label: 'Google Web Search', settingsTarget: 'config' },
  ],
  ownedSettings: [
    { key: 'news-digest-job', label: 'News digest schedule', description: 'Cron, model, prompt, and parameter settings for the news digest job.', scope: 'job', storageKey: 'admin.settings.jobs.news-digest', dashboardTarget: 'jobs' },
    { key: 'source-quality-rules', label: 'Source quality rules', description: 'Min score, allowed/blocked/preferred hosts for source assessment.', scope: 'worker', storageKey: 'worker.core.news.source-quality-rules', dashboardTarget: 'config' },
  ],
  dashboard: {
    settings: [
      {
        id: 'source-quality-rules',
        label: 'Source quality rules',
        description: 'Rules used to score and filter news sources.',
        tab: 'config',
        path: '/api/news/source-quality',
        fields: [
          { key: 'minScore', label: 'Min score (0–10)', type: 'number', defaultValue: 0, min: 0, max: 10 },
          { key: 'allowHosts', label: 'Always allow (hosts)', type: 'string-list', defaultValue: [], placeholder: 'e.g. reuters.com' },
          { key: 'blockHosts', label: 'Always block (hosts)', type: 'string-list', defaultValue: [], placeholder: 'e.g. spammy.com' },
          { key: 'preferredHosts', label: 'Preferred hosts (+3 score)', type: 'string-list', defaultValue: [], placeholder: 'e.g. nytimes.com' },
          { key: 'lowQualityHosts', label: 'Low quality hosts (−3 score)', type: 'string-list', defaultValue: [], placeholder: 'e.g. prnewswire.com' },
        ],
      },
    ],
    routes: [
      { id: 'news-runs', label: 'News runs', description: 'Recent news digest run summaries.', tab: 'queue', path: '/api/dashboard#queue' },
    ],
  },
  jobs: [
    {
      id: JOB_ID,
      workerId: WORKER_ID,
      label: 'News Digest',
      description: 'Fetches articles matching your interests and queues them for review.',
      defaultEnabled: false,
      defaultCron: '0 7 * * *',
      defaultModelAlias: '',
      approvalRequiredDefault: false,
      approvalRequiredEditable: false,
      defaultPrompt: DEFAULT_PROMPT,
      prompt: { editable: true, helpText: 'These instructions guide the AI when filtering fetched articles.' },
      paramsSchema,
      defaultParams: DEFAULT_PARAMS,
      dashboardFields: [
        { key: 'interests', label: 'Interests (topics)', type: 'string-list', defaultValue: DEFAULT_INTERESTS, suggestions: ['AI and software', 'Technology news', 'Science', 'World news', 'Business', 'Markets and finance', 'Climate and environment', 'Health', 'Startups', 'Cybersecurity'], placeholder: 'e.g. AI and software' },
        { key: 'maxResultsPerInterest', label: 'Max results per interest', type: 'number', defaultValue: DEFAULT_PARAMS.maxResultsPerInterest, min: 1, max: 20 },
        { key: 'dateRestrict', label: 'Date restrict', type: 'text', defaultValue: DEFAULT_PARAMS.dateRestrict },
        { key: 'maxQueueAdditions', label: 'Max queue additions', type: 'number', defaultValue: DEFAULT_PARAMS.maxQueueAdditions, min: 1, max: 50 },
        { key: 'fetchArticles', label: 'Fetch article content', type: 'boolean', defaultValue: DEFAULT_PARAMS.fetchArticles },
      ],
      presets: [
        { id: 'tech-weekday-mornings', label: 'Tech weekday mornings', description: 'AI, software, and science — Monday through Friday at 7 am.', cron: '0 7 * * 1-5', params: { interests: ['AI and software', 'Technology news', 'Science'], maxResultsPerInterest: 5, dateRestrict: 'd1' } },
        { id: 'daily-world-news', label: 'Daily world news', description: 'Broad interests — every morning at 8 am.', cron: '0 8 * * *', params: { interests: ['World news', 'Technology news', 'Science', 'Business'], maxResultsPerInterest: 5, dateRestrict: 'd1' } },
      ],
      run: (_modelId, params) => runNewsDigest(_modelId, paramsSchema.parse(params ?? {})),
    },
  ],
};

const module_: BackendWorkerModule = { manifest, apiRoutes };
export default module_;
export { manifest };
