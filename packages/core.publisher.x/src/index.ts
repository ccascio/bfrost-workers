/**
 * Post to X — core.publisher.x (standalone reinstallable package)
 *
 * Selects approved queue items, drafts a tweet with an LLM, and posts to X.
 * Credentials are stored in worker KV and synced with the local .env file.
 */

import crypto from 'node:crypto';
import https from 'node:https';
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

const WORKER_ID = 'core.publisher.x';
const JOB_ID = 'tweet-post';
const X_MAX_CHARS = 280;
const API_URL = 'https://api.twitter.com/2/tweets';

// ── Credential helpers ────────────────────────────────────────────────────────

interface XCredentials {
  xConsumerKey?: string;
  xConsumerSecret?: string;
  xAccessToken?: string;
  xAccessTokenSecret?: string;
  xUsername?: string;
}

const kv = openWorkerKv(WORKER_ID);

async function resolveXCreds() {
  const stored = (await kv.get<XCredentials>('credentials')) ?? {};
  return {
    consumerKey: stored.xConsumerKey?.trim() || process.env.X_CONSUMER_KEY || '',
    consumerSecret: stored.xConsumerSecret?.trim() || process.env.X_CONSUMER_SECRET || '',
    accessToken: stored.xAccessToken?.trim() || process.env.X_ACCESS_TOKEN || '',
    accessTokenSecret: stored.xAccessTokenSecret?.trim() || process.env.X_ACCESS_TOKEN_SECRET || '',
    username: stored.xUsername?.trim() || process.env.X_USERNAME || '',
  };
}

function percentEncode(str: string): string {
  return encodeURIComponent(str).replace(/[!*'()]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
}

function buildOAuthHeader(creds: ReturnType<typeof resolveXCreds> extends Promise<infer T> ? T : never): string {
  const params: Record<string, string> = {
    oauth_consumer_key: creds.consumerKey,
    oauth_nonce: crypto.randomBytes(16).toString('hex'),
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp: Math.floor(Date.now() / 1000).toString(),
    oauth_token: creds.accessToken,
    oauth_version: '1.0',
  };
  const paramString = Object.keys(params).sort()
    .map((k) => `${percentEncode(k)}=${percentEncode(params[k])}`).join('&');
  const baseString = `POST&${percentEncode(API_URL)}&${percentEncode(paramString)}`;
  const signingKey = `${percentEncode(creds.consumerSecret)}&${percentEncode(creds.accessTokenSecret)}`;
  const signature = crypto.createHmac('sha1', signingKey).update(baseString).digest('base64');
  params.oauth_signature = signature;
  return 'OAuth ' + Object.keys(params).sort()
    .map((k) => `${percentEncode(k)}="${percentEncode(params[k])}"`)
    .join(', ');
}

class TweetPostError extends Error {
  constructor(public readonly statusCode: number, public readonly body: string, msg: string) {
    super(msg);
  }
  isDuplicate() { return this.statusCode === 403 && /\bduplicate\b/i.test(this.body); }
}

async function postTweet(text: string) {
  const creds = await resolveXCreds();
  const missing = [
    ['X_CONSUMER_KEY', creds.consumerKey], ['X_CONSUMER_SECRET', creds.consumerSecret],
    ['X_ACCESS_TOKEN', creds.accessToken], ['X_ACCESS_TOKEN_SECRET', creds.accessTokenSecret],
  ].filter(([, v]) => !v).map(([k]) => k);
  if (missing.length) throw new Error(`Missing X credentials: ${missing.join(', ')}`);

  const body = JSON.stringify({ text });
  const authorization = buildOAuthHeader(creds);

  return new Promise<{ id: string; text: string }>((resolve, reject) => {
    const req = https.request(API_URL, {
      method: 'POST',
      headers: { Authorization: authorization, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        const respBody = Buffer.concat(chunks).toString();
        const status = res.statusCode ?? 0;
        if (status >= 200 && status < 300) {
          const parsed = JSON.parse(respBody);
          if (!parsed?.data?.id) { reject(new TweetPostError(status, respBody, 'Missing data.id')); return; }
          resolve({ id: String(parsed.data.id), text: String(parsed.data.text ?? text) });
        } else {
          reject(new TweetPostError(status, respBody, `X API error ${status}: ${respBody.slice(0, 300)}`));
        }
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ── Queue helpers (not in SDK) ────────────────────────────────────────────────

type QueueItemState = 'seen' | 'rejected' | 'queued' | 'approved' | 'posted' | 'failed';
interface QueueItem {
  id: string; title: string; shortDesc: string; url: string;
  addedAt: string; state: QueueItemState; attemptCount?: number;
  postedAt?: string; failedAt?: string; postedNote?: string; failedNote?: string;
  [key: string]: unknown;
}

function pruneQueue(queue: QueueItem[], nowMs: number, retentionMs = 7 * 24 * 60 * 60 * 1000): QueueItem[] {
  return queue.filter((it) => {
    const age = nowMs - Date.parse(it.addedAt);
    if (['seen', 'rejected'].includes(it.state) && age > retentionMs) return false;
    if (it.state === 'posted' && age > retentionMs) return false;
    return true;
  });
}

function markPosted(item: QueueItem, note: string) {
  item.state = 'posted';
  item.postedAt = new Date().toISOString();
  item.postedNote = note;
}

function markFailed(item: QueueItem, note: string, maxAttempts: number) {
  item.attemptCount = (item.attemptCount ?? 0) + 1;
  item.failedAt = new Date().toISOString();
  item.failedNote = note;
  if ((item.attemptCount ?? 0) >= maxAttempts) item.state = 'rejected';
  else item.state = 'failed';
}

function markDuplicateRejected(item: QueueItem) {
  item.state = 'rejected';
  item.failedNote = 'X rejected as duplicate content.';
}

function canonicalizeUrl(url: string): string | null {
  try {
    const u = new URL(url);
    u.hash = '';
    u.searchParams.delete('utm_source');
    u.searchParams.delete('utm_medium');
    u.searchParams.delete('utm_campaign');
    u.searchParams.delete('utm_term');
    u.searchParams.delete('utm_content');
    return u.toString().replace(/\/$/, '').toLowerCase();
  } catch { return null; }
}

// ── Params schema (duck-typed) ────────────────────────────────────────────────

const DEFAULT_PARAMS = { signature: '', maxContentLength: 250, eligibilityWindowHours: 72, maxAttempts: 3, maxLlmCandidates: 5 };
const paramsSchema = {
  parse: (v: unknown) => {
    const raw = (typeof v === 'object' && v !== null ? v : {}) as Record<string, unknown>;
    return {
      signature: typeof raw.signature === 'string' ? raw.signature : DEFAULT_PARAMS.signature,
      maxContentLength: typeof raw.maxContentLength === 'number' ? Math.min(280, Math.max(1, raw.maxContentLength)) : DEFAULT_PARAMS.maxContentLength,
      eligibilityWindowHours: typeof raw.eligibilityWindowHours === 'number' ? raw.eligibilityWindowHours : DEFAULT_PARAMS.eligibilityWindowHours,
      maxAttempts: typeof raw.maxAttempts === 'number' ? raw.maxAttempts : DEFAULT_PARAMS.maxAttempts,
      maxLlmCandidates: typeof raw.maxLlmCandidates === 'number' ? raw.maxLlmCandidates : DEFAULT_PARAMS.maxLlmCandidates,
    };
  },
} as any;

// ── Default prompt ────────────────────────────────────────────────────────────

const DEFAULT_PROMPT = `Pick ONE item from the list below — the one most likely to resonate on X — and write a tweet for it.

Constraints for the tweet text:
- Max {maxContentLength} characters. The system will append "{signature}" automatically; do NOT include it yourself.
- Do NOT include URLs, links, or @mentions.
- Avoid hashtags unless they genuinely add reach.
- Choose exactly one tone: "factual", "witty", or "provocative".
- Never attack individuals, invoke protected-class references, or write content that risks account suspension.

EXCLUDE items on these topics: US/EU elections, partisan politics, culture-war topics, religion, active geopolitical conflicts, celebrity gossip unrelated to tech.

Output ONLY one of these JSON objects, nothing else:
- To post: {"itemNumber": <number>, "url": "<copied verbatim>", "tone": "factual|witty|provocative", "text": "<tweet body>"}
- To skip: {"skip": "<brief reason>"}

Items:

{items}`;

// ── Main job ──────────────────────────────────────────────────────────────────

async function runTweetPost(modelId: string, params = DEFAULT_PARAMS): Promise<{ summary: string; itemCount: number }> {
  const creds = await resolveXCreds();
  const missingCreds = [
    ['X_CONSUMER_KEY', creds.consumerKey], ['X_CONSUMER_SECRET', creds.consumerSecret],
    ['X_ACCESS_TOKEN', creds.accessToken], ['X_ACCESS_TOKEN_SECRET', creds.accessTokenSecret],
  ].filter(([, v]) => !v).map(([k]) => k);
  if (missingCreds.length) throw new Error(`Missing X credentials: ${missingCreds.join(', ')}`);

  return withQueueLock(async () => {
    const nowMs = Date.now();
    const settings = await kv.get<{ approvalRequired?: boolean; prompt?: string }>('job-settings') ?? {};
    const approvalRequired = settings.approvalRequired ?? true;
    const promptTemplate = (typeof settings.prompt === 'string' && settings.prompt.trim()) ? settings.prompt : DEFAULT_PROMPT;

    const queue = pruneQueue(await loadQueue() as QueueItem[], nowMs);
    const eligible = queue.filter((it) => {
      const publishable = approvalRequired ? (it.state === 'approved' || it.state === 'failed') : (it.state === 'queued' || it.state === 'approved' || it.state === 'failed');
      if (!publishable) return false;
      if ((it.attemptCount ?? 0) >= params.maxAttempts) return false;
      const age = nowMs - Date.parse(it.addedAt);
      return age < params.eligibilityWindowHours * 60 * 60 * 1000;
    });

    if (eligible.length === 0) {
      await saveQueue(queue as any);
      return { summary: `Tweet job: no eligible items (queue: ${queue.length}).`, itemCount: 0 };
    }

    const candidates = eligible.sort((a, b) => Date.parse(b.addedAt) - Date.parse(a.addedAt)).slice(0, params.maxLlmCandidates);

    const list = candidates.map((it, i) => `[${i + 1}] itemNumber: ${i + 1}\n    url: ${it.url}\n    title: ${it.title}\n    shortDesc: ${it.shortDesc}`).join('\n\n');
    const prompt = promptTemplate
      .split('{items}').join(list)
      .split('{maxContentLength}').join(String(params.maxContentLength))
      .split('{signature}').join(params.signature);

    const modelOption = findModel(modelId);
    if (!modelOption) throw new Error(`Unknown model: ${modelId}`);

    const { text: llmText } = await generateText({
      model: getChatModel(modelOption),
      system: 'You are a social media writer. Output only valid JSON.',
      prompt: '/no_think\n' + prompt,
      maxTokens: 400,
    });

    let parsed: unknown;
    try {
      const start = llmText.indexOf('{'), end = llmText.lastIndexOf('}');
      if (start === -1 || end <= start) throw new Error('No JSON object');
      parsed = JSON.parse(llmText.slice(start, end + 1));
    } catch (err) {
      throw new Error(`LLM output not JSON: ${err instanceof Error ? err.message : err}`);
    }

    if (typeof parsed !== 'object' || parsed === null) throw new Error('LLM output not an object');

    if ('skip' in (parsed as any)) {
      await saveQueue(queue as any);
      return { summary: `Tweet job: LLM skipped (${(parsed as any).skip}).`, itemCount: 0 };
    }

    const selection = parsed as { itemNumber?: number; url?: string; tone?: string; text?: string };
    if (!selection.text) throw new Error('LLM response missing text field');

    // Resolve item
    let target = selection.itemNumber !== undefined ? candidates[selection.itemNumber - 1] : undefined;
    if (!target && selection.url) {
      target = candidates.find((c) => c.url === selection.url);
      if (!target) {
        const selCanon = canonicalizeUrl(selection.url);
        target = selCanon ? candidates.find((c) => canonicalizeUrl(c.url) === selCanon) : undefined;
      }
    }
    if (!target) {
      await saveQueue(queue as any);
      return { summary: `Tweet job: could not resolve LLM selection.`, itemCount: 0 };
    }

    const queueTarget = queue.find((it) => it.url === target!.url);
    if (!queueTarget) throw new Error('Selected URL disappeared from queue during processing.');

    const fullText = selection.text + params.signature;
    const tweetText = [...fullText].length <= X_MAX_CHARS ? fullText : [...selection.text].slice(0, Math.max(0, X_MAX_CHARS - [...params.signature].length - 1)).join('').replace(/\s+\S*$/, '').trimEnd() + '…' + params.signature;

    try {
      const posted = await postTweet(tweetText);
      markPosted(queueTarget, `Published to X in ${selection.tone ?? 'factual'} tone.`);
      await saveQueue(queue as any);
      const username = creds.username || 'i';
      await recordEventSafe({ category: 'x', action: 'posted', summary: `Published tweet: ${queueTarget.title}`, metadata: { workerId: WORKER_ID, tweetId: posted.id, url: queueTarget.url } });
      return { summary: `Tweet published (${selection.tone ?? 'factual'}):\n${tweetText}\n\nhttps://x.com/${username}/status/${posted.id}`, itemCount: 1 };
    } catch (err) {
      if (err instanceof TweetPostError && err.isDuplicate()) {
        markDuplicateRejected(queueTarget);
        await saveQueue(queue as any);
        return { summary: `Tweet job: X rejected as duplicate. Item marked permanently skipped.`, itemCount: 0 };
      }
      markFailed(queueTarget, err instanceof Error ? err.message : String(err), params.maxAttempts);
      await saveQueue(queue as any);
      throw err;
    }
  });
}

// ── API routes ────────────────────────────────────────────────────────────────

const apiRoutes: AdminApiRoute[] = [
  {
    method: 'GET',
    path: '/api/x-credentials',
    handler: async () => {
      const stored = (await kv.get<XCredentials>('credentials')) ?? {};
      return {
        xConsumerKey: stored.xConsumerKey ? '••••••' : '',
        xConsumerSecret: stored.xConsumerSecret ? '••••••' : '',
        xAccessToken: stored.xAccessToken ? '••••••' : '',
        xAccessTokenSecret: stored.xAccessTokenSecret ? '••••••' : '',
        xUsername: stored.xUsername ?? '',
      };
    },
  },
  {
    method: 'POST',
    path: '/api/x-credentials',
    handler: async (_ctx, body) => {
      if (typeof body !== 'object' || body === null) throw new BadRequestError('Invalid body');
      const b = body as XCredentials;
      const current = (await kv.get<XCredentials>('credentials')) ?? {};
      const next: XCredentials = { ...current };
      for (const key of ['xConsumerKey', 'xConsumerSecret', 'xAccessToken', 'xAccessTokenSecret', 'xUsername'] as const) {
        if (typeof b[key] === 'string' && b[key]!.trim()) next[key] = b[key];
      }
      await kv.set('credentials', next);
      return { ok: true };
    },
  },
];

// ── Manifest ──────────────────────────────────────────────────────────────────

const manifest: WorkerManifest = {
  id: WORKER_ID,
  name: 'X Publisher',
  displayName: 'Post to X',
  version: '0.1.0',
  description: 'Selects approved queue items and drafts or publishes X posts.',
  tagline: 'Turns digest items you have approved into X posts. Drafts go out only after you say yes — nothing is published behind your back.',
  builtIn: false,
  requiredCredentials: [
    { key: 'xConfigured', label: 'X API credentials', settingsTarget: 'health-x' },
  ],
  ownedSettings: [
    { key: 'tweet-post-job', label: 'Tweet post schedule', description: 'Cron, approval, model, prompt, and parameter settings for the X publisher job.', scope: 'job', storageKey: 'admin.settings.jobs.tweet-post', dashboardTarget: 'jobs' },
    { key: 'x-credentials', label: 'X credentials', description: 'Local environment values used for X publishing.', scope: 'worker', storageKey: '.env.X_*', dashboardTarget: 'health' },
  ],
  dashboard: {
    settings: [
      {
        id: 'x-credentials',
        label: 'X credentials',
        description: 'OAuth 1.0a app credentials used by the X publishing job.',
        tab: 'config',
        path: '/api/x-credentials',
        fields: [
          { key: 'xConsumerKey', label: 'Consumer (API) key', type: 'secret-reference', defaultValue: '', placeholder: 'Configured in local .env', helpText: 'Stored as X_CONSUMER_KEY.' },
          { key: 'xConsumerSecret', label: 'Consumer (API) secret', type: 'secret-reference', defaultValue: '', placeholder: 'Configured in local .env', helpText: 'Stored as X_CONSUMER_SECRET.' },
          { key: 'xAccessToken', label: 'Access token', type: 'secret-reference', defaultValue: '', placeholder: 'Configured in local .env', helpText: 'Stored as X_ACCESS_TOKEN.' },
          { key: 'xAccessTokenSecret', label: 'Access token secret', type: 'secret-reference', defaultValue: '', placeholder: 'Configured in local .env', helpText: 'Stored as X_ACCESS_TOKEN_SECRET.' },
          { key: 'xUsername', label: 'X handle (optional)', type: 'text', defaultValue: '', helpText: 'Stored as X_USERNAME.' },
        ],
      },
    ],
    routes: [
      { id: 'queue-publishing', label: 'Publishing queue', description: 'Approved queue items consumed by the X publisher.', tab: 'queue', path: '/api/queue-item' },
    ],
  },
  jobs: [
    {
      id: JOB_ID,
      workerId: WORKER_ID,
      label: 'Tweet Post',
      description: 'Chooses a strong queue item and writes a bounded post for X.',
      defaultEnabled: false,
      defaultCron: '45 0,7 * * *',
      defaultModelAlias: '',
      approvalRequiredDefault: true,
      approvalRequiredEditable: true,
      defaultPrompt: DEFAULT_PROMPT,
      prompt: { editable: true, helpText: 'Available placeholders: {items}, {maxContentLength}, {signature}.' },
      paramsSchema,
      defaultParams: DEFAULT_PARAMS,
      dashboardFields: [
        { key: 'signature', label: 'Signature', type: 'text', defaultValue: DEFAULT_PARAMS.signature },
        { key: 'maxContentLength', label: 'Max content length', type: 'number', defaultValue: DEFAULT_PARAMS.maxContentLength, min: 1, max: 280 },
        { key: 'eligibilityWindowHours', label: 'Eligibility window (hours)', type: 'number', defaultValue: DEFAULT_PARAMS.eligibilityWindowHours, min: 1, max: 168 },
        { key: 'maxAttempts', label: 'Max post attempts', type: 'number', defaultValue: DEFAULT_PARAMS.maxAttempts, min: 1, max: 10 },
        { key: 'maxLlmCandidates', label: 'Max LLM candidates', type: 'number', defaultValue: DEFAULT_PARAMS.maxLlmCandidates, min: 1, max: 20 },
      ],
      run: (_modelId, params) => runTweetPost(_modelId, paramsSchema.parse(params ?? {})),
    },
  ],
};

const module_: BackendWorkerModule = { manifest, apiRoutes };
export default module_;
export { manifest };
