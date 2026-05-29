/**
 * Finance Analyst — core.finance-analyst (standalone reinstallable package)
 *
 * Consumes `finance.news` items and attaches a structured, INFORMATIONAL read of
 * the likely market impact to each (direction, magnitude, horizon, confidence,
 * priced-in, mechanism). Never gives buy/sell advice. SDK-only port of the
 * built-in worker — imports nothing but `bfrost`, `ai`, and node built-ins.
 */

import { generateText } from 'ai';
import { z } from 'zod';
import type { BackendWorkerModule, WorkerManifest, QueueItem } from 'bfrost';
import {
  getChatModel,
  findModel,
  loadQueue,
  saveQueue,
  withQueueLock,
  filterItemsForConsumer,
  setConsumerMetadata,
  recordEventSafe,
  notifyOperatorChannels,
  getJobPrompt,
} from 'bfrost';

const WORKER_ID = 'core.finance-analyst';
const JOB_ID = 'finance-analysis';
const SUBSCRIBES_TO = 'finance.news';
const LLM_EXCERPT_CHARS = 1_000;

const INVESTOR_LENSES = [
  { value: 'none', label: 'No lens (balanced)' },
  { value: 'long-value', label: 'Long-term / value' },
  { value: 'swing-momentum', label: 'Swing / momentum' },
  { value: 'short-seller', label: 'Short seller' },
  { value: 'income', label: 'Income / dividend' },
  { value: 'macro', label: 'Macro / thematic' },
];

const LENS_FRAMING: Record<string, string> = {
  'none': 'Give a balanced read for a generalist investor.',
  'long-value': 'Weigh the read toward durable fundamentals and multi-quarter implications; discount short-term noise.',
  'swing-momentum': 'Weigh the read toward near-term price catalysts and momentum over the next few days.',
  'short-seller': 'Weigh the read toward downside risk and what could go wrong; flag short-squeeze risk where relevant.',
  'income': 'Weigh the read toward dividend safety, cash flow, and capital-return implications.',
  'macro': 'Weigh the read toward macro/sector transmission and how it propagates to this name.',
};

const DEFAULT_ANALYSIS_PROMPT = `You are a sober financial analyst writing a short, INFORMATIONAL read on each news item for an investor who already follows the name.

Ground every statement ONLY in the provided article text — never invent numbers or facts. Do NOT give buy/sell/hold advice. Your job is to characterise the likely market reaction and the mechanism, and to be honest about uncertainty (including whether the move is probably already priced in).`;

const DIRECTIONS = ['up', 'down', 'mixed', 'unclear'];
const MAGNITUDES = ['low', 'moderate', 'high'];
const HORIZONS = ['intraday', 'days', 'weeks', 'months', 'unclear'];
const CONFIDENCES = ['low', 'medium', 'high'];
const PRICED_IN = ['likely', 'partly', 'unlikely', 'unclear'];

interface AnalysisDecision {
  url: string;
  direction: string;
  magnitude: string;
  horizon: string;
  confidence: string;
  pricedIn: string;
  mechanism: string;
  note?: string;
}

const DEFAULT_PARAMS = { maxItems: 8, investorLens: 'none', notifyOnAnalysis: false };
const paramsSchema = z.object({
  maxItems: z.number().int().min(1).max(25).catch(DEFAULT_PARAMS.maxItems),
  investorLens: z.string().refine((value) => value in LENS_FRAMING).catch(DEFAULT_PARAMS.investorLens),
  notifyOnAnalysis: z.boolean().catch(DEFAULT_PARAMS.notifyOnAnalysis),
});

function pruneQueue(queue: QueueItem[], nowMs: number, retentionMs = 7 * 24 * 60 * 60 * 1000): QueueItem[] {
  return queue.filter((it) => {
    const age = nowMs - Date.parse(it.addedAt);
    if (['seen', 'rejected', 'posted'].includes(it.state) && age > retentionMs) return false;
    return true;
  });
}

function payloadOf(item: QueueItem): Record<string, unknown> {
  const p = (item as unknown as { payload?: unknown }).payload;
  return p && typeof p === 'object' ? (p as Record<string, unknown>) : {};
}

function tickersOf(item: QueueItem): string[] {
  const t = payloadOf(item).tickers;
  return Array.isArray(t) ? (t as unknown[]).filter((x): x is string => typeof x === 'string') : [];
}

function articleTextOf(item: QueueItem): string {
  const p = payloadOf(item);
  const text = typeof p.articleText === 'string' ? p.articleText : '';
  const snippet = typeof p.snippet === 'string' ? p.snippet : '';
  return (text || snippet).slice(0, LLM_EXCERPT_CHARS);
}

function extractJsonArray(text: string): unknown {
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start === -1 || end === -1 || end <= start) throw new Error('No JSON array found in LLM output');
  return JSON.parse(text.slice(start, end + 1));
}

function oneOf(v: unknown, allowed: string[]): string | null {
  return typeof v === 'string' && allowed.includes(v) ? v : null;
}

function parseAnalysisDecisions(text: string): Map<string, AnalysisDecision> {
  const arr = extractJsonArray(text);
  if (!Array.isArray(arr)) throw new Error('LLM output is not a JSON array');
  const map = new Map<string, AnalysisDecision>();
  for (const raw of arr) {
    if (!raw || typeof raw !== 'object') continue;
    const r = raw as Record<string, unknown>;
    const url = typeof r.url === 'string' ? r.url : '';
    const direction = oneOf(r.direction, DIRECTIONS);
    const magnitude = oneOf(r.magnitude, MAGNITUDES);
    const horizon = oneOf(r.horizon, HORIZONS);
    const confidence = oneOf(r.confidence, CONFIDENCES);
    const pricedIn = oneOf(r.pricedIn, PRICED_IN);
    const mechanism = typeof r.mechanism === 'string' ? r.mechanism.slice(0, 400) : '';
    if (!url || !direction || !magnitude || !horizon || !confidence || !pricedIn || !mechanism) continue;
    map.set(url, {
      url,
      direction,
      magnitude,
      horizon,
      confidence,
      pricedIn,
      mechanism,
      note: typeof r.note === 'string' ? r.note.slice(0, 280) : undefined,
    });
  }
  return map;
}

const ARROW: Record<string, string> = { up: '↑', down: '↓', mixed: '↔', unclear: '?' };

async function runFinanceAnalysis(
  modelId: string,
  params = DEFAULT_PARAMS,
): Promise<{ summary: string; itemCount: number }> {
  const nowMs = Date.now();

  return withQueueLock(async () => {
    const queue = pruneQueue(await loadQueue(), nowMs);
    const pending = filterItemsForConsumer(queue, WORKER_ID, {
      itemType: SUBSCRIBES_TO,
      excludeAlreadyHandled: true,
    });

    if (pending.length === 0) {
      await saveQueue(queue);
      return { summary: 'Finance analyst: no new finance.news items to analyse.', itemCount: 0 };
    }

    const batch = pending
      .slice()
      .sort((a, b) => Date.parse(b.addedAt) - Date.parse(a.addedAt))
      .slice(0, params.maxItems);

    const modelOption = findModel(modelId);
    if (!modelOption) throw new Error(`Unknown model: ${modelId}`);

    const lensFraming = LENS_FRAMING[params.investorLens] ?? LENS_FRAMING['none'];
    const promptTemplate = await getJobPrompt(JOB_ID, DEFAULT_ANALYSIS_PROMPT);

    const payload = batch.map((it) => ({ url: it.url, tickers: tickersOf(it), title: it.title, text: articleTextOf(it) }));
    const system =
      'You output only a valid JSON array. Never invent URLs; use only URLs present verbatim in the input. Never give buy/sell advice.';
    const prompt =
      '/no_think\n' +
      `${promptTemplate}\n\nInvestor focus: ${lensFraming}\n\n` +
      'Return a JSON array, one object per item: {"url": string, "direction": "up"|"down"|"mixed"|"unclear", ' +
      '"magnitude": "low"|"moderate"|"high", "horizon": "intraday"|"days"|"weeks"|"months"|"unclear", ' +
      '"confidence": "low"|"medium"|"high", "pricedIn": "likely"|"partly"|"unlikely"|"unclear", ' +
      '"mechanism": string (<=300 chars), "note": string (optional, <=200 chars)}.\n\n' +
      `Items:\n${JSON.stringify(payload, null, 2)}`;

    const { text } = await generateText({ model: getChatModel(modelOption), system, prompt });

    let reads: Map<string, AnalysisDecision>;
    try {
      reads = parseAnalysisDecisions(text);
    } catch (err) {
      const preview = text.length > 3000 ? text.slice(0, 3000) + `\n… (truncated)` : text;
      console.log('[FinanceAnalyst] LLM parse error — raw output:\n--- BEGIN ---\n' + preview + '\n--- END ---');
      throw new Error(`LLM analysis output not valid: ${err instanceof Error ? err.message : err}`);
    }

    const analyzedAt = new Date().toISOString();
    const analyzed: { item: QueueItem; read: AnalysisDecision }[] = [];
    for (const item of batch) {
      const read = reads.get(item.url);
      if (!read) continue;
      setConsumerMetadata(item, WORKER_ID, {
        analyzedAt,
        direction: read.direction,
        magnitude: read.magnitude,
        horizon: read.horizon,
        confidence: read.confidence,
        pricedIn: read.pricedIn,
        mechanism: read.mechanism,
        note: read.note ?? null,
      });
      analyzed.push({ item, read });
    }

    await saveQueue(queue);

    if (params.notifyOnAnalysis && analyzed.length > 0) {
      const lines = analyzed.slice(0, 6).map(({ item, read }) => {
        const who = tickersOf(item).slice(0, 3).join(', ') || item.title.slice(0, 40);
        const arrow = ARROW[read.direction] ?? '?';
        return `• ${who} ${arrow} ${read.magnitude}/${read.horizon} (${read.confidence} conf, priced-in: ${read.pricedIn})\n  ${read.mechanism}`;
      });
      const more = analyzed.length > 6 ? `\n…and ${analyzed.length - 6} more.` : '';
      const msg = `🧭 Finance reads — ${analyzed.length} update(s). Informational only, not advice:\n${lines.join('\n')}${more}`;
      try {
        await notifyOperatorChannels(msg);
      } catch (err) {
        console.warn('[FinanceAnalyst] notify failed:', err);
      }
    }

    await recordEventSafe({
      category: 'worker',
      action: 'finance_analysis',
      summary: `Finance analyst: analysed ${analyzed.length} of ${batch.length} item(s).`,
      metadata: { workerId: WORKER_ID, analyzed: analyzed.length, batch: batch.length },
    });

    return { summary: `Finance analyst: attached a read to ${analyzed.length} item(s).`, itemCount: analyzed.length };
  });
}

const manifest: WorkerManifest = {
  id: WORKER_ID,
  name: 'Finance Analyst',
  displayName: 'Finance Analyst',
  version: '0.1.0',
  description: 'Reads finance.news items and attaches a structured, informational read of the likely market impact.',
  tagline:
    'Reads the finance news collected for your watchlist and writes a short, sober take on each — likely direction, size, horizon, confidence, and whether it is already priced in. Informational only, never buy/sell advice.',
  builtIn: false,
  dashboard: {
    routes: [
      {
        id: 'finance-analyst-dashboard',
        label: 'Finance Analyst',
        description: 'Review analysed finance.news items, pending work, and recent analysis runs.',
        path: '/api/workers/core.finance-analyst/dashboard',
      },
    ],
  },
  ownedSettings: [
    {
      key: 'finance-analysis-job',
      label: 'Finance analysis schedule',
      description: 'Cron, model, analysis prompt, and parameters for the finance analyst job.',
      scope: 'job',
      storageKey: 'admin.settings.jobs.finance-analysis',
      dashboardTarget: 'jobs',
    },
  ],
  jobs: [
    {
      id: JOB_ID,
      workerId: WORKER_ID,
      label: 'Finance Analysis',
      description: 'Analyses unhandled finance.news items and annotates each with a structured impact read.',
      defaultEnabled: false,
      defaultCron: '20 7,13,19 * * 1-5',
      defaultModelAlias: '',
      approvalRequiredDefault: false,
      approvalRequiredEditable: false,
      defaultPrompt: DEFAULT_ANALYSIS_PROMPT,
      prompt: { editable: true, helpText: 'Instructions for how the AI should read each finance news item. Keep it informational — not buy/sell advice.' },
      paramsSchema,
      defaultParams: DEFAULT_PARAMS,
      dashboardFields: [
        { key: 'maxItems', label: 'Items to analyse per run', type: 'number', defaultValue: DEFAULT_PARAMS.maxItems, min: 1, max: 25 },
        {
          key: 'investorLens',
          label: 'Investor lens',
          type: 'select',
          defaultValue: DEFAULT_PARAMS.investorLens,
          options: INVESTOR_LENSES.map((l) => ({ value: l.value, label: l.label })),
        },
        { key: 'notifyOnAnalysis', label: 'Send the reads to my channel', type: 'boolean', defaultValue: DEFAULT_PARAMS.notifyOnAnalysis },
      ],
      run: (modelId: string, params: unknown) => runFinanceAnalysis(modelId, paramsSchema.parse(params ?? {})),
    },
  ],
};

function analysisOf(item: QueueItem): Record<string, unknown> | null {
  const metadata = item.metadata?.[WORKER_ID];
  return metadata && typeof metadata === 'object' ? metadata : null;
}

function compactAnalysis(item: QueueItem) {
  const read = analysisOf(item);
  return {
    id: item.id,
    title: item.title,
    shortDesc: item.shortDesc,
    url: item.url,
    addedAt: item.addedAt,
    tickers: tickersOf(item),
    analyzedAt: typeof read?.analyzedAt === 'string' ? read.analyzedAt : null,
    direction: typeof read?.direction === 'string' ? read.direction : 'unclear',
    magnitude: typeof read?.magnitude === 'string' ? read.magnitude : 'low',
    horizon: typeof read?.horizon === 'string' ? read.horizon : 'unclear',
    confidence: typeof read?.confidence === 'string' ? read.confidence : 'low',
    pricedIn: typeof read?.pricedIn === 'string' ? read.pricedIn : 'unclear',
    mechanism: typeof read?.mechanism === 'string' ? read.mechanism : '',
    note: typeof read?.note === 'string' ? read.note : null,
  };
}

const module_: BackendWorkerModule = {
  manifest,
  async loadDashboardData() {
    const queue = await loadQueue();
    const financeItems = queue
      .filter((item) => item.itemType === SUBSCRIBES_TO)
      .sort((a, b) => Date.parse(b.addedAt) - Date.parse(a.addedAt));
    return {
      pendingCount: financeItems.filter((item) => !analysisOf(item)).length,
      analysedItems: financeItems.filter((item) => Boolean(analysisOf(item))).slice(0, 30).map(compactAnalysis),
    };
  },
};
export default module_;
export { manifest };
