import { z } from 'zod';
import { generateText } from 'ai';
import type { AdminApiRoute, BackendWorkerModule, WorkerJobManifest, WorkerManifest } from 'bfrost';
import { BadRequestError, findModel, getChatModel, getJobPrompt, isModelProviderConfigured, openWorkerKv, publishItem, recordEventSafe } from 'bfrost';

const WORKER_ID = "issue-triage";
const JOB_ID = "issue-triage";
const SETTINGS_KEY = 'settings';
const HISTORY_KEY = 'history';
const LLM_TIMEOUT_MS = 120_000;
const SOURCE_CHAR_LIMIT = 4_000;
const DEFAULT_PROMPT = "You are a product engineering issue triage assistant. Categorize issues as bug, feature, support, docs, or question; recommend priority and owner; identify duplicates or missing reproduction details.";

type Priority = 'low' | 'medium' | 'high' | 'urgent';

interface AutomationSettings { sourceEndpoints: string; bearerTokenEnv: string; contextNotes: string; publishItems: boolean }
interface AutomationItem { title: string; priority: Priority; category: string; summary: string; action: string; source?: string; draft?: string }
interface AutomationRunSummary { ranAt: string; sourceCount: number; fetchedCount: number; publishedCount: number; urgentCount: number; llmUsed: boolean; status: 'ok' | 'setup-needed' | 'partial' | 'error'; summary: string; items: AutomationItem[]; errors: Array<{ source: string; message: string }> }

const SettingsSchema = z.object({
  sourceEndpoints: z.string().default(''),
  bearerTokenEnv: z.string().default("LINEAR_API_KEY,GITHUB_TOKEN"),
  contextNotes: z.string().default(''),
  publishItems: z.boolean().default(true),
}).strict();

const JobParamsSchema = z.object({
  lookbackHours: z.number().int().min(1).max(720).catch(24),
  maxItems: z.number().int().min(1).max(50).catch(12),
  priorityThreshold: z.enum(['low', 'medium', 'high', 'urgent']).catch('medium'),
}).strict();
type JobParams = z.infer<typeof JobParamsSchema>;

const AutomationItemSchema = z.object({
  title: z.string().min(1).max(200),
  priority: z.enum(['low', 'medium', 'high', 'urgent']).default('medium'),
  category: z.string().min(1).max(80).default('general'),
  summary: z.string().min(1).max(800),
  action: z.string().min(1).max(500),
  source: z.string().optional(),
  draft: z.string().optional(),
});
const LlmResultSchema = z.object({ summary: z.string().min(1).max(1200), urgentCount: z.number().int().min(0).default(0), items: z.array(AutomationItemSchema).default([]) });
type LlmResult = z.infer<typeof LlmResultSchema>;

async function loadSettings(): Promise<AutomationSettings> {
  const stored = await openWorkerKv(WORKER_ID).get<Partial<AutomationSettings>>(SETTINGS_KEY);
  return SettingsSchema.parse(stored ?? {});
}

async function saveSettings(settings: AutomationSettings): Promise<AutomationSettings> {
  const parsed = SettingsSchema.parse(settings);
  await openWorkerKv(WORKER_ID).set(SETTINGS_KEY, parsed);
  return parsed;
}

function sourceEndpoints(settings: AutomationSettings): string[] {
  return settings.sourceEndpoints.split('\n').map((line) => line.trim()).filter(Boolean);
}

function tokenEnvNames(settings: AutomationSettings): string[] {
  return settings.bearerTokenEnv.split(',').map((line) => line.trim()).filter(Boolean);
}

function envValue(name: string): string {
  const value = process.env[name];
  return value && value.trim() ? value.trim() : '';
}

function orderedTokenEnvNames(source: string, settings: AutomationSettings): string[] {
  const names = tokenEnvNames(settings);
  const lower = source.toLowerCase();
  const preferred = names.filter((name) => {
    const key = name.toLowerCase();
    return (lower.includes('googleapis.com') && (key.includes('google') || key.includes('gmail')))
      || (lower.includes('slack.com') && key.includes('slack'))
      || (lower.includes('github.com') && key.includes('github'))
      || (lower.includes('linear') && key.includes('linear'))
      || (lower.includes('pagerduty') && key.includes('pagerduty'))
      || (lower.includes('datadog') && key.includes('datadog'))
      || (lower.includes('sentry') && key.includes('sentry'))
      || (lower.includes('osv.dev') && key.includes('osv'));
  });
  return [...preferred, ...names.filter((name) => !preferred.includes(name))];
}

function authorizationHeaderForSource(source: string, settings: AutomationSettings): string {
  for (const name of orderedTokenEnvNames(source, settings)) {
    const value = envValue(name);
    if (value) return 'Bearer ' + value;
  }
  return '';
}

function hasConfiguredToken(settings: AutomationSettings): boolean {
  return tokenEnvNames(settings).some((name) => Boolean(envValue(name)));
}

function trimText(value: string, limit = SOURCE_CHAR_LIMIT): string {
  const cleaned = value.replace(/\s+/g, ' ').trim();
  return cleaned.length > limit ? cleaned.slice(0, limit) + '... (truncated, total ' + cleaned.length + ' chars)' : cleaned;
}

function summarizePayload(value: unknown): string {
  if (typeof value === 'string') return trimText(value);
  return trimText(JSON.stringify(value, null, 2));
}

async function fetchSources(settings: AutomationSettings): Promise<{ records: Array<{ source: string; body: string }>; errors: Array<{ source: string; message: string }> }> {
  const records: Array<{ source: string; body: string }> = [];
  const errors: Array<{ source: string; message: string }> = [];
  for (const source of sourceEndpoints(settings)) {
    try {
      const url = new URL(source);
      if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('Only HTTP(S) endpoints are supported.');
      const headers: Record<string, string> = { Accept: 'application/json, text/plain;q=0.8, */*;q=0.5' };
      const authorization = authorizationHeaderForSource(source, settings);
      if (authorization) headers.Authorization = authorization;
      const response = await fetch(url, { headers, signal: AbortSignal.timeout(25_000) });
      const text = await response.text();
      if (!response.ok) {
        errors.push({ source, message: 'HTTP ' + response.status + ': ' + trimText(text, 300) });
        continue;
      }
      try { records.push({ source, body: summarizePayload(JSON.parse(text)) }); }
      catch { records.push({ source, body: trimText(text) }); }
    } catch (err) {
      errors.push({ source, message: err instanceof Error ? err.message : String(err) });
    }
  }
  if (settings.contextNotes.trim()) records.unshift({ source: 'operator-notes', body: trimText(settings.contextNotes, SOURCE_CHAR_LIMIT) });
  return { records, errors };
}

function priorityRank(priority: Priority): number {
  return { low: 0, medium: 1, high: 2, urgent: 3 }[priority] ?? 1;
}

function fallbackResult(records: Array<{ source: string; body: string }>, params: JobParams, errors: Array<{ source: string; message: string }>): LlmResult {
  const items = records.slice(0, params.maxItems).map((record, index) => ({
    title: index === 0 && record.source === 'operator-notes' ? 'Operator context' : 'Source ' + (index + 1) + ': ' + record.source,
    priority: (errors.length > 0 ? 'high' : 'medium') as Priority,
    category: "Issue triage report",
    summary: trimText(record.body, 450) || 'No readable content returned by this source.',
    action: 'Review this source and configure an AI provider for richer classification and drafting.',
    source: record.source,
  }));
  const summary = records.length === 0
    ? "Issue Triage" + ' needs at least one source endpoint or context note before it can produce a report.'
    : "Issue Triage" + ' processed ' + records.length + ' source' + (records.length === 1 ? '' : 's') + ' without an AI provider.';
  return { summary, urgentCount: errors.length > 0 ? errors.length : 0, items };
}

function extractJsonObject(text: string): unknown {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) throw new Error('No JSON object found in LLM output');
  return JSON.parse(text.slice(start, end + 1));
}

async function analyzeWithLlm(modelId: string, records: Array<{ source: string; body: string }>, settings: AutomationSettings, params: JobParams, errors: Array<{ source: string; message: string }>): Promise<{ result: LlmResult; llmUsed: boolean }> {
  const model = findModel(modelId);
  if (!model || !isModelProviderConfigured(model)) return { result: fallbackResult(records, params, errors), llmUsed: false };
  const system = await getJobPrompt(JOB_ID, DEFAULT_PROMPT);
  const sourceText = records.map((record, index) => '[' + (index + 1) + '] source: ' + record.source + '\n' + record.body).join('\n\n');
  const prompt = [
    '/no_think',
    'Worker: ' + WORKER_ID,
    'Lookback hours: ' + params.lookbackHours,
    'Maximum items: ' + params.maxItems,
    'Minimum priority threshold: ' + params.priorityThreshold,
    'Operator context:',
    settings.contextNotes || '(none)',
    'Source fetch errors:',
    errors.length ? JSON.stringify(errors, null, 2) : '(none)',
    '',
    'Sources:',
    sourceText || '(no source data)',
    '',
    'Return only JSON with this shape:',
    '{ "summary": "short operator-ready summary", "urgentCount": 0, "items": [{ "title": "short title", "priority": "low|medium|high|urgent", "category": "category", "summary": "what happened", "action": "next action", "source": "source URL/name", "draft": "optional draft response or release note" }] }',
    'Rules: include at most ' + params.maxItems + ' items; do not invent facts; keep drafts concise.',
  ].join('\n');
  const { text } = await generateText({ model: getChatModel(model), system, prompt, abortSignal: AbortSignal.timeout(LLM_TIMEOUT_MS) });
  try {
    const parsed = LlmResultSchema.parse(extractJsonObject(text));
    const filtered = parsed.items.filter((item) => priorityRank(item.priority) >= priorityRank(params.priorityThreshold)).slice(0, params.maxItems);
    return { result: { summary: parsed.summary, urgentCount: parsed.urgentCount || filtered.filter((item) => item.priority === 'urgent').length, items: filtered }, llmUsed: true };
  } catch (err) {
    const preview = text.length > 3000 ? text.slice(0, 3000) + '\n... (truncated, total ' + text.length + ' chars)' : text;
    console.log('[' + WORKER_ID + '] LLM parse error - raw output follows:\n--- LLM OUTPUT BEGIN ---\n' + preview + '\n--- LLM OUTPUT END ---');
    return { result: fallbackResult(records, params, errors), llmUsed: false };
  }
}

async function runAutomation(modelId: string, params: JobParams): Promise<{ summary: string; itemCount: number }> {
  const settings = await loadSettings();
  const endpoints = sourceEndpoints(settings);
  const { records, errors } = await fetchSources(settings);
  const { result, llmUsed } = await analyzeWithLlm(modelId, records, settings, params, errors);
  const now = new Date().toISOString();
  const status: AutomationRunSummary['status'] = endpoints.length === 0 && !settings.contextNotes.trim() ? 'setup-needed' : errors.length > 0 && records.length === 0 ? 'error' : errors.length > 0 ? 'partial' : 'ok';
  let publishedCount = 0;
  if (settings.publishItems && result.items.length > 0) {
    await publishItem({ producerWorkerId: WORKER_ID, itemType: "issue.triage", tags: ["issues","linear","triage"].concat([status]), title: "Issue triage report", shortDesc: result.summary, payload: { summary: result.summary, urgentCount: result.urgentCount, items: result.items, status, sourceCount: endpoints.length, fetchedCount: records.length, errors, generatedAt: now }, selectionReason: "Issue Triage" + ' generated this report from configured sources.' });
    publishedCount = 1;
  }
  const run: AutomationRunSummary = { ranAt: now, sourceCount: endpoints.length, fetchedCount: records.length, publishedCount, urgentCount: result.urgentCount, llmUsed, status, summary: result.summary, items: result.items, errors };
  const kv = openWorkerKv(WORKER_ID);
  await kv.set('last-run', run);
  const history = ((await kv.get<AutomationRunSummary[]>(HISTORY_KEY)) ?? []).filter(Boolean).slice(0, 19);
  await kv.set(HISTORY_KEY, [run, ...history]);
  await recordEventSafe({ category: 'worker', action: status === 'ok' ? WORKER_ID + '_completed' : WORKER_ID + '_' + status, severity: status === 'ok' ? 'info' : 'warning', summary: result.summary, metadata: { workerId: WORKER_ID, jobId: JOB_ID, status, urgentCount: result.urgentCount, errors } });
  return { summary: result.summary, itemCount: publishedCount };
}

const job: WorkerJobManifest = {
  id: JOB_ID,
  workerId: WORKER_ID,
  label: "Issue triage",
  description: "Reviews incoming issues, bugs, and feature requests and recommends labels, priority, and ownership.",
  defaultEnabled: true,
  defaultCron: "30 17 * * 1-5",
  defaultModelAlias: '',
  approvalRequiredDefault: false,
  approvalRequiredEditable: false,
  defaultPrompt: DEFAULT_PROMPT,
  prompt: { editable: true, helpText: 'Tune how the worker evaluates source data and writes operator-ready output.' },
  paramsSchema: JobParamsSchema,
  defaultParams: { lookbackHours: 24, maxItems: 12, priorityThreshold: 'medium' },
  dashboardFields: [
    { key: 'lookbackHours', label: 'Lookback hours', type: 'number', defaultValue: 24, min: 1, max: 720, helpText: 'How much source history this run should consider.' },
    { key: 'maxItems', label: 'Max items', type: 'number', defaultValue: 12, min: 1, max: 50, helpText: 'Maximum number of findings, messages, or notes to include.' },
    { key: 'priorityThreshold', label: 'Priority threshold', type: 'select', defaultValue: 'medium', options: [{ value: 'low', label: 'Low and above' }, { value: 'medium', label: 'Medium and above' }, { value: 'high', label: 'High and above' }, { value: 'urgent', label: 'Urgent only' }], helpText: 'Filter lower-priority items out of the final report.' },
  ],
  presets: [
    { id: 'quiet-summary', label: 'Quiet summary', description: 'Short report with high-signal items only.', cron: "30 17 * * 1-5", params: { lookbackHours: 24, maxItems: 8, priorityThreshold: 'high' } },
    { id: 'full-sweep', label: 'Full sweep', description: 'Broader scan with low-priority context included.', cron: "30 17 * * 1-5", params: { lookbackHours: 72, maxItems: 20, priorityThreshold: 'low' } },
  ],
  run: async (modelId: string, params?: Record<string, unknown>) => runAutomation(modelId, JobParamsSchema.parse(params ?? {})),
};

const manifest: WorkerManifest = {
  manifestVersion: 1,
  bfrostApiVersion: '0.1',
  bfrostEngineRange: '>=0.3.0',
  id: WORKER_ID,
  name: "Issue Triage",
  displayName: "Issue Triage",
  version: '0.1.0',
  description: "Reviews incoming issues, bugs, and feature requests and recommends labels, priority, and ownership.",
  tagline: "Reviews incoming issues and suggests priority, category, owner, and next action.",
  owner: '@ccascio',
  builtIn: false,
  kind: 'feature',
  jobs: [job],
  chatPrompts: [
    { label: 'Latest report', description: 'Ask what the worker found most recently.', prompt: "Show me the latest Issue Triage report and the highest-priority actions." },
    { label: 'Setup help', description: 'Ask how to connect sources.', prompt: "Help me configure Issue Triage source endpoints and credentials." },
  ],
  ownedSettings: [
    { key: WORKER_ID + '-config', label: "Issue Triage sources", description: "Issue tracker endpoints", scope: 'worker', storageKey: 'worker.' + WORKER_ID + '.settings', dashboardTarget: 'config' },
    { key: WORKER_ID + '-job', label: "Issue triage schedule", description: 'Cron, model, prompt, and run parameters.', scope: 'job', storageKey: 'admin.settings.jobs.' + JOB_ID, dashboardTarget: 'jobs' },
  ],
  dashboard: {
    settings: [{
      id: WORKER_ID + '-config', label: "Issue Triage sources", description: "Issue tracker endpoints", tab: 'config', path: '/api/workers/' + WORKER_ID + '/settings',
      fields: [
        { key: 'sourceEndpoints', label: "Issue tracker endpoints", type: 'textarea', defaultValue: '', rows: 8, placeholder: "https://api.linear.app/graphql\nhttps://api.github.com/repos/OWNER/REPO/issues?state=open&since=YYYY-MM-DDTHH:MM:SSZ", helpText: 'One HTTP(S) endpoint per line. Endpoints can be native APIs, internal exports, webhooks, or JSON/text snapshots.', seedPath: WORKER_ID + '.settings.sourceEndpoints' },
        { key: 'bearerTokenEnv', label: 'Bearer token env vars', type: 'text', defaultValue: "LINEAR_API_KEY,GITHUB_TOKEN", placeholder: "LINEAR_API_KEY,GITHUB_TOKEN", helpText: 'Comma-separated environment variable names. The first variable with a value is used as a Bearer token.', seedPath: WORKER_ID + '.settings.bearerTokenEnv' },
        { key: 'contextNotes', label: 'Context notes', type: 'textarea', defaultValue: '', rows: 6, placeholder: "Product areas: onboarding, billing, worker runtime, dashboard. Escalate regressions and customer-impacting bugs.", helpText: 'Optional instructions, priorities, account names, or pasted context to include in every run.', seedPath: WORKER_ID + '.settings.contextNotes' },
        { key: 'publishItems', label: 'Publish report to Item Bus', type: 'boolean', defaultValue: true, helpText: "When enabled, each run publishes the report as a issue.triage item." },
      ],
    }],
    routes: [{ id: WORKER_ID + '-dashboard', label: "Issues", description: "Reviews incoming issues, bugs, and feature requests and recommends labels, priority, and ownership.", tab: 'worker', path: '/api/workers/' + WORKER_ID + '/dashboard' }],
  },
};

const routes: AdminApiRoute[] = [
  { method: 'GET', path: '/api/workers/' + WORKER_ID + '/settings', workerIds: [WORKER_ID], handle: async () => ({ status: 200, body: await loadSettings() }) },
  { method: 'POST', path: '/api/workers/' + WORKER_ID + '/settings', workerIds: [WORKER_ID], handle: async (ctx) => { const body = await ctx.readJsonBody(ctx.req, SettingsSchema); for (const endpoint of sourceEndpoints(body)) { try { new URL(endpoint); } catch { throw new BadRequestError('Invalid source endpoint URL: ' + endpoint); } } return { status: 200, body: await saveSettings(body) }; } },
];

const module: BackendWorkerModule = {
  manifest,
  apiRoutes: routes,
  async loadDashboardData() {
    const kv = openWorkerKv(WORKER_ID);
    const [settings, lastRun, history] = await Promise.all([loadSettings(), kv.get<AutomationRunSummary>('last-run'), kv.get<AutomationRunSummary[]>(HISTORY_KEY)]);
    return { settings, sourceCount: sourceEndpoints(settings).length, tokenConfigured: hasConfiguredToken(settings), lastRun: lastRun ?? null, history: Array.isArray(history) ? history.slice(0, 10) : [] };
  },
};

export default module;
