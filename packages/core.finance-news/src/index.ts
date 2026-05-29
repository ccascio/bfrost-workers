/**
 * Finance News — core.finance-news (standalone reinstallable package)
 *
 * Searches the web for developments on a watchlist of tickers/companies,
 * optionally runs an LLM relevance pass with an editable prompt, publishes
 * `finance.news` items to the Item Bus, and can notify the operator's channels
 * when relevant items are found. SDK-only port of the built-in worker — imports
 * nothing but `bfrost`, `ai`, and node built-ins. Informational only; not advice.
 */

import https from 'node:https';
import http from 'node:http';
import { generateText } from 'ai';
import { z } from 'zod';
import type { BackendWorkerModule, WorkerManifest, QueueItem } from 'bfrost';
import { openWorkerKv, getChatModel, findModel, publishItem, recordEventSafe, notifyOperatorChannels, getJobPrompt, loadQueue } from 'bfrost';

const WORKER_ID = 'core.finance-news';
const JOB_ID = 'finance-news-scan';
const ITEM_TYPE = 'finance.news';
const LLM_EXCERPT_CHARS = 1_000;
const ARTICLE_FETCH_CHARS = 4_000;
const kv = openWorkerKv(WORKER_ID);

const FINANCE_CATEGORIES = [
  { value: 'earnings', label: 'Earnings & guidance', keywords: ['earnings', 'guidance', 'results', 'revenue', 'EPS'] },
  { value: 'ratings', label: 'Analyst ratings', keywords: ['upgrade', 'downgrade', 'price target', 'analyst', 'initiated'] },
  { value: 'ma', label: 'M&A', keywords: ['merger', 'acquisition', 'takeover', 'acquire', 'deal'] },
  { value: 'regulatory', label: 'Regulatory & legal', keywords: ['lawsuit', 'investigation', 'SEC', 'antitrust', 'probe'] },
  { value: 'insider', label: 'Insider & management', keywords: ['insider', 'stake', 'CEO', 'resign', 'appoint'] },
  { value: 'macro', label: 'Macro & rates', keywords: ['Federal Reserve', 'interest rate', 'inflation', 'tariff'] },
  { value: 'dividend', label: 'Dividends & buybacks', keywords: ['dividend', 'buyback', 'repurchase', 'payout'] },
  { value: 'product', label: 'Product & operations', keywords: ['launch', 'partnership', 'contract', 'recall'] },
];
const CATEGORY_VALUES = FINANCE_CATEGORIES.map((c) => c.value);

const INVESTOR_LENSES = [
  { value: 'none', label: 'No lens (general relevance)' },
  { value: 'long-value', label: 'Long-term / value' },
  { value: 'swing-momentum', label: 'Swing / momentum' },
  { value: 'short-seller', label: 'Short seller' },
  { value: 'income', label: 'Income / dividend' },
  { value: 'macro', label: 'Macro / thematic' },
];
const LENS_FRAMING: Record<string, string> = {
  'none': 'Judge whether each item is materially relevant to an investor following these names.',
  'long-value': 'Prioritise durable, fundamental developments; downweight short-term noise.',
  'swing-momentum': 'Prioritise near-term catalysts that could move the price within days.',
  'short-seller': 'Prioritise negative catalysts and risks; note short-squeeze risk.',
  'income': 'Prioritise developments affecting dividend safety and capital return.',
  'macro': 'Prioritise macro and sector developments and how they bear on these names.',
};

const DEFAULT_WATCHLIST = ['AAPL', 'NVDA', 'Federal Reserve'];
const DEFAULT_RELEVANCE_PROMPT = `You are a financial-news relevance filter working for an investor.

For each article, decide whether it is *materially relevant* — a real development a holder of these names would want to know about — versus noise (recaps, listicles, generic market wraps, ads, stale repeats).

Be strict: when in doubt, mark it not relevant. Never invent URLs; only use URLs present verbatim in the input. Do not give buy/sell advice — only judge relevance and say in one short sentence why it could matter.`;

const DEFAULT_PARAMS = {
  watchlist: DEFAULT_WATCHLIST,
  categories: [...CATEGORY_VALUES],
  maxResultsPerName: 8,
  maxItems: 12,
  seenTtlHours: 48,
  dateRestrict: 'd1',
  investorLens: 'none',
  relevanceFilter: true,
  notifyOnRelevant: false,
};

const paramsSchema = z.object({
  watchlist: z.array(z.string().trim().min(1)).min(1).catch(DEFAULT_PARAMS.watchlist),
  categories: z.array(z.string().refine((value) => CATEGORY_VALUES.includes(value))).min(1).catch(DEFAULT_PARAMS.categories),
  maxResultsPerName: z.number().int().min(1).max(20).catch(DEFAULT_PARAMS.maxResultsPerName),
  maxItems: z.number().int().min(1).max(40).catch(DEFAULT_PARAMS.maxItems),
  seenTtlHours: z.number().int().min(1).max(168).catch(DEFAULT_PARAMS.seenTtlHours),
  dateRestrict: z.enum(['d1', 'w1', 'm1']).catch('d1'),
  investorLens: z.string().refine((value) => value in LENS_FRAMING).catch(DEFAULT_PARAMS.investorLens),
  relevanceFilter: z.boolean().catch(DEFAULT_PARAMS.relevanceFilter),
  notifyOnRelevant: z.boolean().catch(DEFAULT_PARAMS.notifyOnRelevant),
});

interface SearchResult { title: string; link: string; snippet: string; }

async function searchGoogle(query: string, opts: { num?: number; dateRestrict?: string } = {}): Promise<SearchResult[]> {
  const apiKey = process.env.GOOGLE_API_KEY || '';
  const cx = process.env.GOOGLE_SEARCH_ENGINE_ID || '';
  if (!apiKey || !cx) {
    throw new Error('Google Web Search is not configured. Set GOOGLE_API_KEY and GOOGLE_SEARCH_ENGINE_ID in BFrost Config.');
  }
  const params = new URLSearchParams({ key: apiKey, cx, q: query, num: String(opts.num ?? 8), sort: 'date' });
  if (opts.dateRestrict) params.set('dateRestrict', opts.dateRestrict);
  return new Promise((resolve) => {
    https.get(`https://www.googleapis.com/customsearch/v1?${params}`, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        try {
          const d = JSON.parse(Buffer.concat(chunks).toString());
          resolve((d.items ?? []).map((it: any) => ({ title: String(it.title ?? ''), link: String(it.link ?? ''), snippet: String(it.snippet ?? '') })));
        } catch { resolve([]); }
      });
      res.on('error', () => resolve([]));
    }).on('error', () => resolve([]));
  });
}

async function fetchArticleText(rawUrl: string): Promise<string> {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => resolve(''), 12_000);
    const mod = rawUrl.startsWith('https://') ? https : http;
    const req = mod.get(rawUrl, { headers: { 'User-Agent': 'BFrost-Finance/0.1' } }, (res) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400) { clearTimeout(timeout); resolve(''); return; }
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        clearTimeout(timeout);
        const raw = Buffer.concat(chunks);
        const html = raw.toString('utf8', 0, Math.min(raw.length, 150_000));
        const stripped = html
          .replace(/<script[\s\S]*?<\/script>/gi, '')
          .replace(/<style[\s\S]*?<\/style>/gi, '')
          .replace(/<[^>]+>/g, ' ')
          .replace(/\s{2,}/g, ' ')
          .trim();
        resolve(stripped.slice(0, ARTICLE_FETCH_CHARS));
      });
      res.on('error', () => { clearTimeout(timeout); resolve(''); });
    });
    req.on('error', () => { clearTimeout(timeout); resolve(''); });
  });
}

function buildQueries(watchlist: string[], categories: string[]): { name: string; query: string }[] {
  const cats = FINANCE_CATEGORIES.filter((c) => categories.includes(c.value));
  const keywords = [...new Set(cats.flatMap((c) => c.keywords))].slice(0, 12);
  const orGroup = keywords.length ? ` (${keywords.join(' OR ')})` : '';
  return watchlist.map((name) => ({ name, query: `"${name}"${orGroup}` }));
}

function tagCategory(text: string): string {
  const lower = text.toLowerCase();
  for (const cat of FINANCE_CATEGORIES) if (cat.keywords.some((kw) => lower.includes(kw.toLowerCase()))) return cat.value;
  return 'general';
}

function matchTickers(text: string, watchlist: string[], producedBy: string): string[] {
  const lower = text.toLowerCase();
  return [...new Set([producedBy, ...watchlist.filter((n) => lower.includes(n.toLowerCase()))])];
}

function hostOf(url: string): string {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; }
}

function extractJsonArray(text: string): unknown {
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start === -1 || end === -1 || end <= start) throw new Error('No JSON array found in LLM output');
  return JSON.parse(text.slice(start, end + 1));
}

interface RelevanceDecision { url: string; relevant: boolean; reason: string; }
function parseRelevance(text: string): Map<string, RelevanceDecision> {
  const arr = extractJsonArray(text);
  if (!Array.isArray(arr)) throw new Error('LLM output is not a JSON array');
  const map = new Map<string, RelevanceDecision>();
  for (const raw of arr) {
    if (!raw || typeof raw !== 'object') continue;
    const r = raw as Record<string, unknown>;
    const url = typeof r.url === 'string' ? r.url : '';
    const reason = typeof r.reason === 'string' ? r.reason.slice(0, 240) : '';
    if (!url || typeof r.relevant !== 'boolean' || !reason) continue;
    map.set(url, { url, relevant: r.relevant, reason });
  }
  return map;
}

interface Candidate { result: SearchResult; name: string; tickers: string[]; category: string; fullText: string; }

async function runFinanceNewsScan(modelId: string, params = DEFAULT_PARAMS): Promise<{ summary: string; itemCount: number }> {
  const now = new Date();
  const nowMs = now.getTime();
  const ttlMs = params.seenTtlHours * 60 * 60 * 1000;

  const storedSeen = (await kv.get<Record<string, string>>('seen')) ?? {};
  const seen: Record<string, string> = {};
  for (const [url, ts] of Object.entries(storedSeen)) {
    const tsMs = Date.parse(ts);
    if (!Number.isNaN(tsMs) && nowMs - tsMs < ttlMs) seen[url] = ts;
  }

  const queries = buildQueries(params.watchlist, params.categories);
  const byUrl = new Map<string, { result: SearchResult; name: string }>();
  for (const { name, query } of queries) {
    const results = await searchGoogle(query, { num: params.maxResultsPerName, dateRestrict: params.dateRestrict });
    for (const r of results) {
      if (!r.link || seen[r.link] || byUrl.has(r.link)) continue;
      byUrl.set(r.link, { result: r, name });
    }
  }
  const discovered = [...byUrl.values()].slice(0, Math.max(params.maxItems * 2, params.maxItems));

  if (discovered.length === 0) {
    await kv.set('seen', seen);
    await kv.set('last-run', {
      ranAt: now.toISOString(),
      discovered: 0,
      candidates: 0,
      published: 0,
      watchlist: params.watchlist,
      relevanceFilter: params.relevanceFilter,
    });
    return { summary: 'Finance news: no new articles found for your watchlist.', itemCount: 0 };
  }

  const candidates: Candidate[] = [];
  for (const { result, name } of discovered) {
    let fullText = result.snippet ?? '';
    const fetched = await fetchArticleText(result.link);
    if (fetched) fullText = fetched;
    const tagText = `${result.title} ${result.snippet ?? ''} ${fullText}`;
    candidates.push({
      result,
      name,
      tickers: matchTickers(`${result.title} ${result.snippet ?? ''}`, params.watchlist, name),
      category: tagCategory(tagText),
      fullText,
    });
  }

  let relevanceByUrl = new Map<string, RelevanceDecision>();
  let kept = candidates;
  if (params.relevanceFilter) {
    const modelOption = findModel(modelId);
    if (!modelOption) throw new Error(`Unknown model: ${modelId}`);
    const lensFraming = LENS_FRAMING[params.investorLens] ?? LENS_FRAMING['none'];
    const payload = candidates.map((c) => ({ url: c.result.link, title: c.result.title, snippet: c.result.snippet ?? '', excerpt: c.fullText.slice(0, LLM_EXCERPT_CHARS) }));
    const system = 'You output only a valid JSON array. Never invent URLs; only use URLs present verbatim in the provided input.';
    const promptTemplate = await getJobPrompt(JOB_ID, DEFAULT_RELEVANCE_PROMPT);
    const prompt =
      '/no_think\n' +
      `${promptTemplate}\n\nInvestor focus: ${lensFraming}\n\n` +
      'Return a JSON array; one object per article: {"url": string, "relevant": boolean, "reason": string (<=200 chars)}.\n\n' +
      `Articles:\n${JSON.stringify(payload, null, 2)}`;
    const { text } = await generateText({ model: getChatModel(modelOption), system, prompt });
    try {
      relevanceByUrl = parseRelevance(text);
    } catch (err) {
      const preview = text.length > 3000 ? text.slice(0, 3000) + '\n… (truncated)' : text;
      console.log('[FinanceNews] LLM parse error — raw output:\n--- BEGIN ---\n' + preview + '\n--- END ---');
      throw new Error(`LLM relevance output not valid: ${err instanceof Error ? err.message : err}`);
    }
    kept = candidates.filter((c) => relevanceByUrl.get(c.result.link)?.relevant);
  }
  kept = kept.slice(0, params.maxItems);

  for (const c of kept) {
    const decision = relevanceByUrl.get(c.result.link);
    await publishItem({
      producerWorkerId: WORKER_ID,
      itemType: ITEM_TYPE,
      tags: [c.category, ...c.tickers],
      title: c.result.title.slice(0, 200) || 'Untitled',
      shortDesc: (decision?.reason || c.result.snippet || '').slice(0, 400),
      url: c.result.link,
      payload: {
        tickers: c.tickers,
        category: c.category,
        source: { host: hostOf(c.result.link), title: c.result.title },
        snippet: c.result.snippet ?? '',
        articleText: c.fullText.slice(0, ARTICLE_FETCH_CHARS),
        relevanceReason: decision?.reason ?? null,
        producedFor: c.name,
        fetchedAt: now.toISOString(),
      },
      selectionReason: decision?.reason,
    });
    seen[c.result.link] = now.toISOString();
  }

  await kv.set('seen', seen);
  await kv.set('last-run', {
    ranAt: now.toISOString(),
    discovered: discovered.length,
    candidates: candidates.length,
    published: kept.length,
    watchlist: params.watchlist,
    relevanceFilter: params.relevanceFilter,
  });

  if (params.notifyOnRelevant && kept.length > 0) {
    const lines = kept.slice(0, 6).map((c) => {
      const who = c.tickers.slice(0, 3).join(', ');
      return `• ${who}: ${relevanceByUrl.get(c.result.link)?.reason || c.result.title}`;
    });
    const more = kept.length > 6 ? `\n…and ${kept.length - 6} more.` : '';
    const label = params.relevanceFilter ? 'relevant update(s)' : 'new item(s)';
    try {
      await notifyOperatorChannels(`📈 Finance watch — ${kept.length} ${label}:\n${lines.join('\n')}${more}`);
    } catch (err) {
      console.warn('[FinanceNews] notify failed:', err);
    }
  }

  await recordEventSafe({
    category: 'worker',
    action: 'finance_news_scan',
    summary: `Finance news: published ${kept.length} of ${candidates.length} candidate(s).`,
    metadata: { workerId: WORKER_ID, kept: kept.length, candidates: candidates.length },
  });

  const filtered = params.relevanceFilter ? ` (${candidates.length} reviewed)` : '';
  return { summary: `Finance news: published ${kept.length} item(s) for ${params.watchlist.length} name(s)${filtered}.`, itemCount: kept.length };
}

const manifest: WorkerManifest = {
  id: WORKER_ID,
  name: 'Finance News',
  displayName: 'Finance News Watch',
  version: '0.1.0',
  description: 'Scans the web for developments on a watchlist of tickers/companies and queues finance.news items.',
  tagline:
    'Follows the companies and themes you care about, optionally has the AI keep only what is materially relevant, and can ping your channel when something matters. Informational only — never trading advice.',
  builtIn: false,
  requiredDependencies: [{ key: 'googleSearchConfigured', label: 'Google Web Search', settingsTarget: 'config' }],
  dashboard: {
    routes: [
      {
        id: 'finance-news-dashboard',
        label: 'Finance News Watch',
        description: 'Review the latest finance scan status, queued articles, and run guidance.',
        path: '/api/workers/core.finance-news/dashboard',
      },
    ],
  },
  ownedSettings: [
    {
      key: 'finance-news-job',
      label: 'Finance news schedule',
      description: 'Cron, model, relevance prompt, and scan parameters for the finance news job.',
      scope: 'job',
      storageKey: 'admin.settings.jobs.finance-news-scan',
      dashboardTarget: 'jobs',
    },
  ],
  jobs: [
    {
      id: JOB_ID,
      workerId: WORKER_ID,
      label: 'Finance News Scan',
      description: 'Searches each watchlist name, optionally filters for relevance with AI, and queues finance.news items.',
      defaultEnabled: false,
      defaultCron: '0 7,13,19 * * 1-5',
      defaultModelAlias: '',
      approvalRequiredDefault: false,
      approvalRequiredEditable: false,
      defaultPrompt: DEFAULT_RELEVANCE_PROMPT,
      prompt: { editable: true, helpText: 'How the AI judges whether a finance article is materially relevant. Applies only when the relevance filter is on. Keep it about relevance — not buy/sell advice.' },
      paramsSchema,
      defaultParams: DEFAULT_PARAMS,
      dashboardFields: [
        { key: 'watchlist', label: 'Watchlist (tickers or company names)', type: 'string-list', defaultValue: DEFAULT_WATCHLIST, placeholder: 'e.g. AAPL, Apple, Federal Reserve' },
        { key: 'categories', label: 'News categories to search', type: 'string-list', defaultValue: DEFAULT_PARAMS.categories, suggestions: [...CATEGORY_VALUES] },
        { key: 'investorLens', label: 'Investor lens', type: 'select', defaultValue: DEFAULT_PARAMS.investorLens, options: INVESTOR_LENSES.map((l) => ({ value: l.value, label: l.label })) },
        { key: 'maxResultsPerName', label: 'Articles to check per name', type: 'number', defaultValue: DEFAULT_PARAMS.maxResultsPerName, min: 1, max: 20 },
        { key: 'maxItems', label: 'Max items to queue per run', type: 'number', defaultValue: DEFAULT_PARAMS.maxItems, min: 1, max: 40 },
        { key: 'seenTtlHours', label: 'Avoid repeats for (hours)', type: 'number', defaultValue: DEFAULT_PARAMS.seenTtlHours, min: 1, max: 168 },
        { key: 'dateRestrict', label: 'Search window', type: 'select', defaultValue: DEFAULT_PARAMS.dateRestrict, options: [{ label: 'Past day', value: 'd1' }, { label: 'Past week', value: 'w1' }, { label: 'Past month', value: 'm1' }] },
        { key: 'relevanceFilter', label: 'Filter for relevance with AI', type: 'boolean', defaultValue: DEFAULT_PARAMS.relevanceFilter },
        { key: 'notifyOnRelevant', label: 'Notify my channel when relevant items are found', type: 'boolean', defaultValue: DEFAULT_PARAMS.notifyOnRelevant },
      ],
      run: (modelId: string, params: unknown) => runFinanceNewsScan(modelId, paramsSchema.parse(params ?? {})),
    },
  ],
};

function isFinanceNewsItem(item: QueueItem): boolean {
  return item.producerWorkerId === WORKER_ID || item.itemType === ITEM_TYPE;
}

function compactItem(item: QueueItem) {
  const payload = item.payload && typeof item.payload === 'object' ? item.payload : {};
  return {
    id: item.id,
    title: item.title,
    shortDesc: item.shortDesc,
    url: item.url,
    state: item.state,
    addedAt: item.addedAt,
    tags: item.tags ?? [],
    category: typeof payload.category === 'string' ? payload.category : null,
    tickers: Array.isArray(payload.tickers) ? payload.tickers.filter((ticker): ticker is string => typeof ticker === 'string') : [],
    relevanceReason: typeof payload.relevanceReason === 'string' ? payload.relevanceReason : item.selectionReason ?? null,
    sourceHost:
      payload.source && typeof payload.source === 'object' && typeof (payload.source as Record<string, unknown>).host === 'string'
        ? ((payload.source as Record<string, unknown>).host as string)
        : null,
  };
}

const module_: BackendWorkerModule = {
  manifest,
  async loadDashboardData() {
    const [queue, lastRun] = await Promise.all([
      loadQueue(),
      kv.get<Record<string, unknown>>('last-run'),
    ]);
    return {
      lastRun: lastRun ?? null,
      recentItems: queue
        .filter(isFinanceNewsItem)
        .sort((a, b) => Date.parse(b.addedAt) - Date.parse(a.addedAt))
        .slice(0, 30)
        .map(compactItem),
    };
  },
};
export default module_;
export { manifest };
