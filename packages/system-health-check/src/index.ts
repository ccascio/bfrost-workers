import { z } from 'zod';
import { generateText } from 'ai';
import type { AdminApiRoute, BackendWorkerModule, WorkerJobManifest, WorkerManifest } from 'bfrost';
import {
  BadRequestError,
  findModel,
  getChatModel,
  getJobPrompt,
  isModelProviderConfigured,
  openWorkerKv,
  publishItem,
  recordEventSafe,
} from 'bfrost';

const WORKER_ID = 'system-health-check';
const JOB_ID = 'system-health-check';
const SETTINGS_KEY = 'settings';
const HISTORY_KEY = 'history';
const LLM_TIMEOUT_MS = 120_000;
const SOURCE_CHAR_LIMIT = 1_200;

const DEFAULT_PROMPT = `You are an operations health analyst. Produce a concise health check across connected monitoring services.

Report exactly these categories when data is available:
1. Active incidents - ongoing outages or incidents with severity and status.
2. Errors and warnings - new errors or warning patterns since the last check.
3. Performance anomalies - unusual latency, error rates, or resource usage.
4. Resolved items - incidents or alerts resolved since the last check.

Prioritize by severity. For each issue, include the service affected and a direct link if available. If all systems are healthy, say "All systems nominal" and keep the summary brief. Do not invent incidents or metrics that are not present in the source data.`;

type Priority = 'low' | 'medium' | 'high' | 'urgent';
type HealthCategory = 'active_incident' | 'error_warning' | 'performance_anomaly' | 'resolved_item';

interface HealthSettings {
  sourceEndpoints: string;
  bearerTokenEnv: string;
  pagerDutyTokenEnv: string;
  datadogApiKeyEnv: string;
  datadogAppKeyEnv: string;
  datadogSite: string;
  sentryTokenEnv: string;
  sentryOrg: string;
  sentryProjects: string;
  contextNotes: string;
  publishItems: boolean;
}

interface HealthSignal {
  category: HealthCategory;
  provider: string;
  title: string;
  priority: Priority;
  status: string;
  service: string;
  summary: string;
  url?: string;
  observedAt?: string;
}

interface AutomationItem {
  title: string;
  priority: Priority;
  category: string;
  summary: string;
  action: string;
  service?: string;
  source?: string;
  url?: string;
}

interface AutomationRunSummary {
  ranAt: string;
  since: string;
  sourceCount: number;
  fetchedCount: number;
  publishedCount: number;
  urgentCount: number;
  llmUsed: boolean;
  status: 'ok' | 'setup-needed' | 'partial' | 'error';
  summary: string;
  items: AutomationItem[];
  errors: Array<{ source: string; message: string }>;
}

const SettingsSchema = z.object({
  sourceEndpoints: z.string().default(''),
  bearerTokenEnv: z.string().default('PAGERDUTY_API_TOKEN,DATADOG_API_KEY,SENTRY_AUTH_TOKEN'),
  pagerDutyTokenEnv: z.string().default('PAGERDUTY_API_TOKEN'),
  datadogApiKeyEnv: z.string().default('DATADOG_API_KEY'),
  datadogAppKeyEnv: z.string().default('DATADOG_APP_KEY'),
  datadogSite: z.string().default('https://api.datadoghq.com'),
  sentryTokenEnv: z.string().default('SENTRY_AUTH_TOKEN'),
  sentryOrg: z.string().default(''),
  sentryProjects: z.string().default(''),
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
  summary: z.string().min(1).max(900),
  action: z.string().min(1).max(500),
  service: z.string().optional(),
  source: z.string().optional(),
  url: z.string().optional(),
});
const LlmResultSchema = z.object({
  summary: z.string().min(1).max(1_200),
  urgentCount: z.number().int().min(0).default(0),
  items: z.array(AutomationItemSchema).default([]),
});
type LlmResult = z.infer<typeof LlmResultSchema>;

async function loadSettings(): Promise<HealthSettings> {
  const stored = await openWorkerKv(WORKER_ID).get<Partial<HealthSettings>>(SETTINGS_KEY);
  return SettingsSchema.parse(stored ?? {});
}

async function saveSettings(settings: HealthSettings): Promise<HealthSettings> {
  const parsed = SettingsSchema.parse(settings);
  await openWorkerKv(WORKER_ID).set(SETTINGS_KEY, parsed);
  return parsed;
}

function lines(value: string): string[] {
  return value.split('\n').map((line) => line.trim()).filter(Boolean);
}

function csv(value: string): string[] {
  return value.split(',').map((line) => line.trim()).filter(Boolean);
}

function sourceEndpoints(settings: HealthSettings): string[] {
  return lines(settings.sourceEndpoints);
}

function envValue(name: string): string {
  const value = process.env[name];
  return value && value.trim() ? value.trim() : '';
}

function firstEnv(names: string): string {
  for (const name of csv(names)) {
    const value = envValue(name);
    if (value) return value;
  }
  return '';
}

function hasConfiguredIntegration(settings: HealthSettings): boolean {
  return Boolean(
    firstEnv(settings.pagerDutyTokenEnv)
      || (firstEnv(settings.datadogApiKeyEnv) && firstEnv(settings.datadogAppKeyEnv))
      || (firstEnv(settings.sentryTokenEnv) && (settings.sentryOrg || envValue('SENTRY_ORG')) && (settings.sentryProjects || envValue('SENTRY_PROJECT')))
      || sourceEndpoints(settings).length > 0
      || settings.contextNotes.trim(),
  );
}

function trimText(value: string, limit = SOURCE_CHAR_LIMIT): string {
  const cleaned = value.replace(/\s+/g, ' ').trim();
  return cleaned.length > limit ? cleaned.slice(0, limit) + '... (truncated, total ' + cleaned.length + ' chars)' : cleaned;
}

function dateOrNull(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function sinceFrom(lastRun: AutomationRunSummary | null, params: JobParams): string {
  if (lastRun?.ranAt) return lastRun.ranAt;
  return new Date(Date.now() - params.lookbackHours * 60 * 60 * 1000).toISOString();
}

function priorityRank(priority: Priority): number {
  return { low: 0, medium: 1, high: 2, urgent: 3 }[priority] ?? 1;
}

function signalSort(a: HealthSignal, b: HealthSignal): number {
  const byPriority = priorityRank(b.priority) - priorityRank(a.priority);
  if (byPriority !== 0) return byPriority;
  return (b.observedAt ?? '').localeCompare(a.observedAt ?? '');
}

function mapPagerDutyPriority(status: string, urgency: string): Priority {
  if (status === 'triggered') return urgency === 'high' ? 'urgent' : 'high';
  if (status === 'acknowledged') return urgency === 'high' ? 'high' : 'medium';
  return 'low';
}

function mapDatadogPriority(state: string): Priority {
  const normalized = state.toLowerCase();
  if (normalized.includes('alert')) return 'high';
  if (normalized.includes('warn')) return 'medium';
  if (normalized.includes('no data')) return 'medium';
  return 'low';
}

function mapSentryPriority(level: string): Priority {
  const normalized = level.toLowerCase();
  if (normalized === 'fatal') return 'urgent';
  if (normalized === 'error') return 'high';
  if (normalized === 'warning') return 'medium';
  return 'low';
}

function datadogAppBase(site: string): string {
  try {
    const url = new URL(site);
    const host = url.hostname.replace(/^api\./, 'app.');
    return `${url.protocol}//${host}`;
  } catch {
    return 'https://app.datadoghq.com';
  }
}

async function fetchText(url: string, headers: Record<string, string>): Promise<{ ok: boolean; status: number; text: string }> {
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(25_000) });
  return { ok: response.ok, status: response.status, text: await response.text() };
}

async function fetchJson(url: string, headers: Record<string, string>): Promise<{ ok: boolean; status: number; body: unknown; text: string }> {
  const result = await fetchText(url, headers);
  let body: unknown = result.text;
  try {
    body = JSON.parse(result.text);
  } catch {
    // Keep text body for diagnostics and custom endpoint summaries.
  }
  return { ...result, body };
}

function summarizePayload(value: unknown): string {
  if (typeof value === 'string') return trimText(value);
  return trimText(JSON.stringify(value, null, 2));
}

async function fetchCustomEndpoints(settings: HealthSettings): Promise<{ signals: HealthSignal[]; records: Array<{ source: string; body: string }>; errors: Array<{ source: string; message: string }> }> {
  const signals: HealthSignal[] = [];
  const records: Array<{ source: string; body: string }> = [];
  const errors: Array<{ source: string; message: string }> = [];

  for (const source of sourceEndpoints(settings)) {
    try {
      const url = new URL(source);
      if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('Only HTTP(S) endpoints are supported.');
      const headers: Record<string, string> = { Accept: 'application/json, text/plain;q=0.8, */*;q=0.5' };
      const token = firstEnv(settings.bearerTokenEnv);
      if (token) headers.Authorization = 'Bearer ' + token;
      const result = await fetchJson(source, headers);
      if (!result.ok) {
        errors.push({ source, message: 'HTTP ' + result.status + ': ' + trimText(result.text, 300) });
        continue;
      }
      records.push({ source, body: summarizePayload(result.body) });
    } catch (err) {
      errors.push({ source, message: err instanceof Error ? err.message : String(err) });
    }
  }

  return { signals, records, errors };
}

async function fetchPagerDuty(settings: HealthSettings, since: string): Promise<{ signals: HealthSignal[]; records: Array<{ source: string; body: string }>; errors: Array<{ source: string; message: string }> }> {
  const token = firstEnv(settings.pagerDutyTokenEnv);
  if (!token) return { signals: [], records: [], errors: [] };

  const source = 'PagerDuty';
  const url = new URL('https://api.pagerduty.com/incidents');
  url.searchParams.append('statuses[]', 'triggered');
  url.searchParams.append('statuses[]', 'acknowledged');
  url.searchParams.append('statuses[]', 'resolved');
  url.searchParams.set('since', since);
  url.searchParams.set('until', new Date().toISOString());
  url.searchParams.set('limit', '100');

  try {
    const result = await fetchJson(url.toString(), {
      Accept: 'application/vnd.pagerduty+json;version=2',
      Authorization: 'Token token=' + token,
    });
    if (!result.ok) return { signals: [], records: [], errors: [{ source, message: 'HTTP ' + result.status + ': ' + trimText(result.text, 300) }] };

    const body = result.body as { incidents?: any[] };
    const incidents = Array.isArray(body.incidents) ? body.incidents : [];
    const signals = incidents.map((incident): HealthSignal => {
      const status = String(incident.status ?? 'unknown');
      const urgency = String(incident.urgency ?? '');
      const service = String(incident.service?.summary ?? incident.service?.id ?? 'unknown service');
      return {
        category: status === 'resolved' ? 'resolved_item' : 'active_incident',
        provider: source,
        title: String(incident.title ?? incident.summary ?? 'PagerDuty incident'),
        priority: mapPagerDutyPriority(status, urgency),
        status,
        service,
        summary: trimText(String(incident.summary ?? incident.title ?? status), 500),
        url: typeof incident.html_url === 'string' ? incident.html_url : incident.self,
        observedAt: dateOrNull(incident.updated_at) ?? dateOrNull(incident.created_at),
      };
    });
    return { signals, records: [{ source, body: summarizePayload(body) }], errors: [] };
  } catch (err) {
    return { signals: [], records: [], errors: [{ source, message: err instanceof Error ? err.message : String(err) }] };
  }
}

async function fetchDatadog(settings: HealthSettings, since: string): Promise<{ signals: HealthSignal[]; records: Array<{ source: string; body: string }>; errors: Array<{ source: string; message: string }> }> {
  const apiKey = firstEnv(settings.datadogApiKeyEnv);
  const appKey = firstEnv(settings.datadogAppKeyEnv);
  if (!apiKey || !appKey) return { signals: [], records: [], errors: [] };

  const site = settings.datadogSite.replace(/\/+$/, '') || 'https://api.datadoghq.com';
  const appBase = datadogAppBase(site);
  const headers = {
    Accept: 'application/json',
    'DD-API-KEY': apiKey,
    'DD-APPLICATION-KEY': appKey,
  };
  const signals: HealthSignal[] = [];
  const records: Array<{ source: string; body: string }> = [];
  const errors: Array<{ source: string; message: string }> = [];

  try {
    const monitorResult = await fetchJson(`${site}/api/v1/monitor?group_states=alert,warn,no%20data`, headers);
    if (!monitorResult.ok) {
      errors.push({ source: 'Datadog monitors', message: 'HTTP ' + monitorResult.status + ': ' + trimText(monitorResult.text, 300) });
    } else {
      const monitors = Array.isArray(monitorResult.body) ? monitorResult.body as any[] : [];
      records.push({ source: 'Datadog monitors', body: summarizePayload(monitors) });
      for (const monitor of monitors) {
        const state = String(monitor.overall_state ?? monitor.state ?? 'unknown');
        const lower = `${monitor.name ?? ''} ${monitor.query ?? ''}`.toLowerCase();
        const tags = Array.isArray(monitor.tags) ? monitor.tags.map(String) : [];
        const serviceTag = tags.find((tag) => tag.startsWith('service:'));
        signals.push({
          category: lower.includes('latency') || lower.includes('duration') || lower.includes('p95') || lower.includes('cpu') || lower.includes('memory')
            ? 'performance_anomaly'
            : 'error_warning',
          provider: 'Datadog',
          title: String(monitor.name ?? 'Datadog monitor'),
          priority: mapDatadogPriority(state),
          status: state,
          service: serviceTag ? serviceTag.slice('service:'.length) : tags[0] ?? 'unknown service',
          summary: trimText(String(monitor.message ?? monitor.query ?? state), 500),
          url: monitor.id !== undefined ? `${appBase}/monitors/${monitor.id}` : undefined,
          observedAt: monitor.modified ? new Date(Number(monitor.modified) * 1000).toISOString() : undefined,
        });
      }
    }
  } catch (err) {
    errors.push({ source: 'Datadog monitors', message: err instanceof Error ? err.message : String(err) });
  }

  try {
    const start = Math.floor(new Date(since).getTime() / 1000);
    const end = Math.floor(Date.now() / 1000);
    const eventResult = await fetchJson(`${site}/api/v1/events?start=${start}&end=${end}&sources=alert`, headers);
    if (eventResult.ok) {
      const events = ((eventResult.body as { events?: any[] }).events ?? []).filter(Boolean);
      records.push({ source: 'Datadog alert events', body: summarizePayload(events) });
      for (const event of events) {
        const title = String(event.title ?? '');
        const text = String(event.text ?? '');
        if (!/recovered|resolved/i.test(title + ' ' + text)) continue;
        signals.push({
          category: 'resolved_item',
          provider: 'Datadog',
          title: title || 'Datadog alert recovered',
          priority: 'low',
          status: 'resolved',
          service: Array.isArray(event.tags) ? String(event.tags.find((tag: string) => tag.startsWith('service:')) ?? 'unknown service').replace(/^service:/, '') : 'unknown service',
          summary: trimText(text || title, 500),
          url: event.url,
          observedAt: event.date_happened ? new Date(Number(event.date_happened) * 1000).toISOString() : undefined,
        });
      }
    }
  } catch (err) {
    errors.push({ source: 'Datadog alert events', message: err instanceof Error ? err.message : String(err) });
  }

  return { signals, records, errors };
}

async function fetchSentry(settings: HealthSettings, since: string): Promise<{ signals: HealthSignal[]; records: Array<{ source: string; body: string }>; errors: Array<{ source: string; message: string }> }> {
  const token = firstEnv(settings.sentryTokenEnv);
  const org = settings.sentryOrg.trim() || envValue('SENTRY_ORG');
  const projects = lines(settings.sentryProjects || envValue('SENTRY_PROJECT'));
  if (!token || !org || projects.length === 0) return { signals: [], records: [], errors: [] };

  const headers = { Accept: 'application/json', Authorization: 'Bearer ' + token };
  const sinceMs = new Date(since).getTime();
  const signals: HealthSignal[] = [];
  const records: Array<{ source: string; body: string }> = [];
  const errors: Array<{ source: string; message: string }> = [];

  for (const project of projects) {
    for (const query of ['is:unresolved', 'is:resolved']) {
      const source = `Sentry ${project} ${query}`;
      const url = `https://sentry.io/api/0/projects/${encodeURIComponent(org)}/${encodeURIComponent(project)}/issues/?query=${encodeURIComponent(query)}&limit=50`;
      try {
        const result = await fetchJson(url, headers);
        if (!result.ok) {
          errors.push({ source, message: 'HTTP ' + result.status + ': ' + trimText(result.text, 300) });
          continue;
        }
        const issues = Array.isArray(result.body) ? result.body as any[] : [];
        records.push({ source, body: summarizePayload(issues) });
        for (const issue of issues) {
          const lastSeen = new Date(String(issue.lastSeen ?? issue.last_seen ?? issue.firstSeen ?? 0)).getTime();
          if (Number.isFinite(sinceMs) && Number.isFinite(lastSeen) && lastSeen < sinceMs) continue;
          const level = String(issue.level ?? issue.metadata?.type ?? 'error');
          signals.push({
            category: query === 'is:resolved' ? 'resolved_item' : 'error_warning',
            provider: 'Sentry',
            title: String(issue.title ?? issue.culprit ?? 'Sentry issue'),
            priority: query === 'is:resolved' ? 'low' : mapSentryPriority(level),
            status: query === 'is:resolved' ? 'resolved' : String(issue.status ?? 'unresolved'),
            service: String(issue.project?.slug ?? project),
            summary: trimText(String(issue.metadata?.value ?? issue.culprit ?? issue.title ?? level), 500),
            url: typeof issue.permalink === 'string' ? issue.permalink : undefined,
            observedAt: dateOrNull(issue.lastSeen) ?? dateOrNull(issue.firstSeen),
          });
        }
      } catch (err) {
        errors.push({ source, message: err instanceof Error ? err.message : String(err) });
      }
    }
  }

  return { signals, records, errors };
}

async function collectHealthData(settings: HealthSettings, since: string): Promise<{ signals: HealthSignal[]; records: Array<{ source: string; body: string }>; errors: Array<{ source: string; message: string }> }> {
  const results = await Promise.all([
    fetchPagerDuty(settings, since),
    fetchDatadog(settings, since),
    fetchSentry(settings, since),
    fetchCustomEndpoints(settings),
  ]);
  const signals = results.flatMap((result) => result.signals).sort(signalSort);
  const records = results.flatMap((result) => result.records);
  const errors = results.flatMap((result) => result.errors);
  if (settings.contextNotes.trim()) {
    records.unshift({ source: 'operator-notes', body: trimText(settings.contextNotes, SOURCE_CHAR_LIMIT) });
  }
  return { signals, records, errors };
}

function fallbackResult(signals: HealthSignal[], records: Array<{ source: string; body: string }>, params: JobParams, errors: Array<{ source: string; message: string }>, hasConfiguredChecks: boolean): LlmResult {
  const filteredSignals = signals
    .filter((signal) => priorityRank(signal.priority) >= priorityRank(params.priorityThreshold))
    .slice(0, params.maxItems);

  if (filteredSignals.length > 0) {
    return {
      summary: `System Health Check found ${filteredSignals.length} health signal${filteredSignals.length === 1 ? '' : 's'} requiring attention.`,
      urgentCount: filteredSignals.filter((signal) => signal.priority === 'urgent').length,
      items: filteredSignals.map((signal) => ({
        title: signal.title,
        priority: signal.priority,
        category: signal.category.replace(/_/g, ' '),
        summary: `${signal.provider} - ${signal.service}: ${signal.summary}`,
        action: signal.category === 'resolved_item' ? 'Confirm no follow-up is needed.' : 'Review the linked service and escalate if customer impact is confirmed.',
        service: signal.service,
        source: signal.provider,
        url: signal.url,
      })),
    };
  }

  if (hasConfiguredChecks && errors.length === 0) {
    return { summary: 'All systems nominal.', urgentCount: 0, items: [] };
  }

  if (records.length > 0) {
    return {
      summary: `System Health Check processed ${records.length} source${records.length === 1 ? '' : 's'} without detecting structured incidents.`,
      urgentCount: errors.length,
      items: records.slice(0, params.maxItems).map((record) => ({
        title: record.source,
        priority: errors.length > 0 ? 'high' : 'medium',
        category: 'source data',
        summary: trimText(record.body, 450) || 'No readable content returned by this source.',
        action: 'Review this source and configure an AI provider for richer classification.',
        source: record.source,
      })),
    };
  }

  return {
    summary: 'No monitoring integrations, source endpoints, or context notes are configured yet.',
    urgentCount: 0,
    items: [],
  };
}

function extractJsonObject(text: string): unknown {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) throw new Error('No JSON object found in LLM output');
  return JSON.parse(text.slice(start, end + 1));
}

async function analyzeWithLlm(
  modelId: string,
  signals: HealthSignal[],
  records: Array<{ source: string; body: string }>,
  settings: HealthSettings,
  params: JobParams,
  errors: Array<{ source: string; message: string }>,
  since: string,
  hasConfiguredChecks: boolean,
): Promise<{ result: LlmResult; llmUsed: boolean }> {
  const model = findModel(modelId);
  if (!model || !isModelProviderConfigured(model)) {
    return { result: fallbackResult(signals, records, params, errors, hasConfiguredChecks), llmUsed: false };
  }

  const system = await getJobPrompt(JOB_ID, DEFAULT_PROMPT);
  const signalText = signals.map((signal, index) => {
    return [
      `[${index + 1}] category: ${signal.category}`,
      `provider: ${signal.provider}`,
      `service: ${signal.service}`,
      `title: ${signal.title}`,
      `priority: ${signal.priority}`,
      `status: ${signal.status}`,
      `link: ${signal.url ?? '(none)'}`,
      `summary: ${signal.summary}`,
    ].join('\n');
  }).join('\n\n');
  const recordText = records.map((record, index) => `[${index + 1}] source: ${record.source}\n${record.body}`).join('\n\n');
  const prompt = [
    '/no_think',
    'Health check since: ' + since,
    'Maximum issues: ' + params.maxItems,
    'Minimum priority threshold: ' + params.priorityThreshold,
    'Operator context:',
    settings.contextNotes || '(none)',
    'Fetch errors:',
    errors.length ? JSON.stringify(errors, null, 2) : '(none)',
    '',
    'Structured monitoring signals:',
    signalText || '(none)',
    '',
    'Raw source records:',
    recordText || '(none)',
    '',
    'Return only JSON with this shape:',
    '{ "summary": "brief health summary or All systems nominal", "urgentCount": 0, "items": [{ "title": "short issue title", "priority": "low|medium|high|urgent", "category": "active incidents|errors and warnings|performance anomalies|resolved items", "summary": "what happened and service affected", "action": "next action", "service": "service name", "source": "PagerDuty|Datadog|Sentry|custom", "url": "direct link if available" }] }',
    'If no active incidents, errors, warnings, performance anomalies, or resolved items are present, return summary "All systems nominal" and an empty items array.',
  ].join('\n');

  const { text } = await generateText({
    model: getChatModel(model),
    system,
    prompt,
    abortSignal: AbortSignal.timeout(LLM_TIMEOUT_MS),
  });

  try {
    const parsed = LlmResultSchema.parse(extractJsonObject(text));
    const filtered = parsed.items.filter((item) => priorityRank(item.priority) >= priorityRank(params.priorityThreshold)).slice(0, params.maxItems);
    return {
      result: {
        summary: filtered.length === 0 && signals.length === 0 && errors.length === 0 && hasConfiguredChecks ? 'All systems nominal.' : parsed.summary,
        urgentCount: parsed.urgentCount || filtered.filter((item) => item.priority === 'urgent').length,
        items: filtered,
      },
      llmUsed: true,
    };
  } catch {
    const preview = text.length > 3000 ? text.slice(0, 3000) + '\n... (truncated, total ' + text.length + ' chars)' : text;
    console.log('[' + WORKER_ID + '] LLM parse error - raw output follows:\n--- LLM OUTPUT BEGIN ---\n' + preview + '\n--- LLM OUTPUT END ---');
    return { result: fallbackResult(signals, records, params, errors, hasConfiguredChecks), llmUsed: false };
  }
}

async function runAutomation(modelId: string, params: JobParams): Promise<{ summary: string; itemCount: number }> {
  const kv = openWorkerKv(WORKER_ID);
  const settings = await loadSettings();
  const previousRun = await kv.get<AutomationRunSummary>('last-run');
  const since = sinceFrom(previousRun ?? null, params);
  const hasConfiguredChecks = hasConfiguredIntegration(settings);
  const { signals, records, errors } = await collectHealthData(settings, since);
  const { result, llmUsed } = await analyzeWithLlm(modelId, signals, records, settings, params, errors, since, hasConfiguredChecks);
  const now = new Date().toISOString();
  const status: AutomationRunSummary['status'] = !hasConfiguredChecks
    ? 'setup-needed'
    : errors.length > 0 && records.length === 0 && signals.length === 0
    ? 'error'
    : errors.length > 0
    ? 'partial'
    : 'ok';

  let publishedCount = 0;
  if (settings.publishItems && status !== 'setup-needed') {
    await publishItem({
      producerWorkerId: WORKER_ID,
      itemType: 'ops.health-report',
      tags: ['health', status, result.items.length > 0 ? 'attention' : 'nominal'],
      title: 'System health report',
      shortDesc: result.summary,
      payload: {
        summary: result.summary,
        urgentCount: result.urgentCount,
        items: result.items,
        status,
        since,
        sourceCount: sourceEndpoints(settings).length,
        fetchedCount: records.length,
        signalCount: signals.length,
        errors,
        generatedAt: now,
      },
      selectionReason: 'System Health Check generated this report from connected monitoring services.',
    });
    publishedCount = 1;
  }

  const run: AutomationRunSummary = {
    ranAt: now,
    since,
    sourceCount: sourceEndpoints(settings).length,
    fetchedCount: records.length,
    publishedCount,
    urgentCount: result.urgentCount,
    llmUsed,
    status,
    summary: result.summary,
    items: result.items,
    errors,
  };

  await kv.set('last-run', run);
  const history = ((await kv.get<AutomationRunSummary[]>(HISTORY_KEY)) ?? []).filter(Boolean).slice(0, 19);
  await kv.set(HISTORY_KEY, [run, ...history]);

  await recordEventSafe({
    category: 'worker',
    action: status === 'ok' ? WORKER_ID + '_completed' : WORKER_ID + '_' + status,
    severity: status === 'ok' ? 'info' : 'warning',
    summary: result.summary,
    metadata: { workerId: WORKER_ID, jobId: JOB_ID, status, urgentCount: result.urgentCount, errors },
  });

  return { summary: result.summary, itemCount: publishedCount };
}

const job: WorkerJobManifest = {
  id: JOB_ID,
  workerId: WORKER_ID,
  label: 'System health check',
  description: 'Checks connected monitoring services for active incidents, errors, performance anomalies, and recently resolved items.',
  defaultEnabled: true,
  defaultCron: '0 14 * * *',
  defaultModelAlias: '',
  approvalRequiredDefault: false,
  approvalRequiredEditable: false,
  defaultPrompt: DEFAULT_PROMPT,
  prompt: {
    editable: true,
    helpText: 'Tune how the worker prioritizes incidents, warnings, anomalies, and resolved items.',
  },
  paramsSchema: JobParamsSchema,
  defaultParams: { lookbackHours: 24, maxItems: 12, priorityThreshold: 'low' },
  dashboardFields: [
    { key: 'lookbackHours', label: 'Lookback hours', type: 'number', defaultValue: 24, min: 1, max: 720, helpText: 'Used for the first run; later runs check since the previous successful run.' },
    { key: 'maxItems', label: 'Max issues', type: 'number', defaultValue: 12, min: 1, max: 50, helpText: 'Maximum number of health findings to include.' },
    { key: 'priorityThreshold', label: 'Priority threshold', type: 'select', defaultValue: 'low', options: [
      { value: 'low', label: 'Low and above' },
      { value: 'medium', label: 'Medium and above' },
      { value: 'high', label: 'High and above' },
      { value: 'urgent', label: 'Urgent only' },
    ], helpText: 'Filter lower-priority items out of the final report.' },
  ],
  presets: [
    { id: 'quiet-summary', label: 'Quiet summary', description: 'Only high-severity health findings.', cron: '0 14 * * *', params: { lookbackHours: 24, maxItems: 8, priorityThreshold: 'high' } },
    { id: 'full-sweep', label: 'Full sweep', description: 'Include low-severity resolved and warning items.', cron: '0 14 * * *', params: { lookbackHours: 72, maxItems: 20, priorityThreshold: 'low' } },
  ],
  run: async (modelId: string, params?: Record<string, unknown>) => runAutomation(modelId, JobParamsSchema.parse(params ?? {})),
};

const manifest: WorkerManifest = {
  manifestVersion: 1,
  bfrostApiVersion: '0.1',
  bfrostEngineRange: '>=0.3.0',
  id: WORKER_ID,
  name: 'System Health Check',
  displayName: 'System Health Check',
  version: '0.2.0',
  description: 'Checks connected monitoring services for active incidents, errors, warnings, performance anomalies, and resolved items.',
  tagline: 'Turns PagerDuty, Datadog, Sentry, and custom health signals into an operations status report.',
  owner: '@ccascio',
  builtIn: false,
  kind: 'feature',
  jobs: [job],
  chatPrompts: [
    { label: 'Latest report', description: 'Ask what the worker found most recently.', prompt: 'Show me the latest System Health Check report and the highest-priority actions.' },
    { label: 'Setup help', description: 'Ask how to connect monitoring services.', prompt: 'Help me connect PagerDuty, Datadog, and Sentry to System Health Check.' },
  ],
  ownedSettings: [
    { key: WORKER_ID + '-config', label: 'System Health Check sources', description: 'Monitoring service credentials, optional source endpoints, and operator context.', scope: 'worker', storageKey: 'worker.' + WORKER_ID + '.settings', dashboardTarget: 'config' },
    { key: WORKER_ID + '-job', label: 'System health check schedule', description: 'Cron, model, prompt, and run parameters.', scope: 'job', storageKey: 'admin.settings.jobs.' + JOB_ID, dashboardTarget: 'jobs' },
  ],
  dashboard: {
    settings: [{
      id: WORKER_ID + '-config',
      label: 'System Health Check sources',
      description: 'Connect monitoring services by entering environment variable names; the secret values stay in local .env.',
      tab: 'config',
      path: '/api/workers/' + WORKER_ID + '/settings',
      fields: [
        { key: 'pagerDutyTokenEnv', label: 'PagerDuty token env var', type: 'text', defaultValue: 'PAGERDUTY_API_TOKEN', placeholder: 'PAGERDUTY_API_TOKEN', helpText: 'Optional. Put the actual PagerDuty REST API token in your local .env as this variable name; BFrost stores only the variable name here. Used to read active, acknowledged, and resolved incidents.' },
        { key: 'datadogApiKeyEnv', label: 'Datadog API key env var', type: 'text', defaultValue: 'DATADOG_API_KEY', placeholder: 'DATADOG_API_KEY', helpText: 'Optional. Put your Datadog API key in .env as this variable name. Datadog requires both an API key and an application key for read API calls.' },
        { key: 'datadogAppKeyEnv', label: 'Datadog app key env var', type: 'text', defaultValue: 'DATADOG_APP_KEY', placeholder: 'DATADOG_APP_KEY', helpText: 'Optional. Put your Datadog application key in .env as this variable name. Scope it to the minimum read permissions needed for monitors/events.' },
        { key: 'datadogSite', label: 'Datadog API site', type: 'text', defaultValue: 'https://api.datadoghq.com', placeholder: 'https://api.datadoghq.eu', helpText: 'Use your Datadog site, such as https://api.datadoghq.com or https://api.datadoghq.eu.' },
        { key: 'sentryTokenEnv', label: 'Sentry token env var', type: 'text', defaultValue: 'SENTRY_AUTH_TOKEN', placeholder: 'SENTRY_AUTH_TOKEN', helpText: 'Optional. Put a Sentry auth token in .env as this variable name. The token needs read access for project/issues/events data.' },
        { key: 'sentryOrg', label: 'Sentry organization slug', type: 'text', defaultValue: '', placeholder: 'my-org', helpText: 'Your Sentry organization slug. If blank, the worker reads SENTRY_ORG from the local environment.' },
        { key: 'sentryProjects', label: 'Sentry projects', type: 'textarea', defaultValue: '', rows: 3, placeholder: 'api\nweb-dashboard', helpText: 'One Sentry project slug per line. If blank, the worker reads SENTRY_PROJECT from the local environment.' },
        { key: 'sourceEndpoints', label: 'Additional health endpoints', type: 'textarea', defaultValue: '', rows: 6, placeholder: 'https://status.example.com/api/status\nhttps://internal.example.com/health-report.json', helpText: 'Optional. Add status pages, internal exports, JSON snapshots, or other HTTP(S) sources not covered by built-in connectors.' },
        { key: 'bearerTokenEnv', label: 'Additional endpoint bearer token env vars', type: 'text', defaultValue: 'PAGERDUTY_API_TOKEN,DATADOG_API_KEY,SENTRY_AUTH_TOKEN', placeholder: 'CUSTOM_HEALTH_TOKEN', helpText: 'Optional. Comma-separated .env variable names. Used only for Additional health endpoints that accept Authorization: Bearer tokens.' },
        { key: 'contextNotes', label: 'Context notes', type: 'textarea', defaultValue: '', rows: 6, placeholder: 'Watch production, API latency, payment flows, and worker queues. Call out anything that needs same-day action.', helpText: 'Optional instructions, service priorities, or pasted incident summaries to include in every run.' },
        { key: 'publishItems', label: 'Publish report to Item Bus', type: 'boolean', defaultValue: true, helpText: 'When enabled, each non-setup run publishes an ops.health-report item, including All systems nominal reports.' },
      ],
    }],
    routes: [{ id: WORKER_ID + '-dashboard', label: 'Health', description: 'Health reports across connected monitoring services.', tab: 'worker', path: '/api/workers/' + WORKER_ID + '/dashboard' }],
  },
};

const routes: AdminApiRoute[] = [
  { method: 'GET', path: '/api/workers/' + WORKER_ID + '/settings', workerIds: [WORKER_ID], handle: async () => ({ status: 200, body: await loadSettings() }) },
  {
    method: 'POST',
    path: '/api/workers/' + WORKER_ID + '/settings',
    workerIds: [WORKER_ID],
    handle: async (ctx) => {
      const body = await ctx.readJsonBody(ctx.req, SettingsSchema);
      for (const endpoint of sourceEndpoints(body)) {
        try { new URL(endpoint); }
        catch { throw new BadRequestError('Invalid source endpoint URL: ' + endpoint); }
      }
      return { status: 200, body: await saveSettings(body) };
    },
  },
];

const module: BackendWorkerModule = {
  manifest,
  apiRoutes: routes,
  async loadDashboardData() {
    const kv = openWorkerKv(WORKER_ID);
    const [settings, lastRun, history] = await Promise.all([
      loadSettings(),
      kv.get<AutomationRunSummary>('last-run'),
      kv.get<AutomationRunSummary[]>(HISTORY_KEY),
    ]);
    return {
      settings,
      sourceCount: sourceEndpoints(settings).length,
      tokenConfigured: hasConfiguredIntegration(settings),
      lastRun: lastRun ?? null,
      history: Array.isArray(history) ? history.slice(0, 10) : [],
    };
  },
};

export default module;
