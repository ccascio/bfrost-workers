import { z } from 'zod';
import { openWorkerKv } from 'bfrost';

export const WORKER_ID = 'wordpress-publisher';
export const SETTINGS_KEY = 'settings';
export const SETTINGS_SCHEMA_VERSION = 1;
export const MASKED_SECRET = '********';

const PostStatusSchema = z.enum(['publish', 'draft', 'pending', 'private', 'future']);

export const WpSettingsSchema = z.object({
  schemaVersion: z.number().int().default(SETTINGS_SCHEMA_VERSION),
  baseUrl: z.string().default(''),
  username: z.string().default(''),
  applicationPassword: z.string().default(''),
  defaultStatus: PostStatusSchema.default('draft'),
  postType: z.string().default('posts'),
  categorySlugs: z.array(z.string()).default([]),
  tagSlugs: z.array(z.string()).default([]),
  prompt: z.string().default(''),
  brandVoice: z.string().default(''),
  audience: z.string().default(''),
  tonePreset: z.string().default('factual'),
  contentFormat: z.string().default('news-brief'),
  ctaText: z.string().default(''),
  allowedHosts: z.array(z.string()).default([]),
  blockedHosts: z.array(z.string()).default([]),
  allowedFeedUrls: z.array(z.string()).default([]),
  requiredTags: z.array(z.string()).default([]),
  excludedTags: z.array(z.string()).default([]),
  minimumRelevanceScore: z.number().default(0),
  includeKeywords: z.array(z.string()).default([]),
  excludeKeywords: z.array(z.string()).default([]),
  consumeApprovedOnly: z.boolean().default(false),
  modelAlias: z.string().default(''),
}).strict();

export type WpSettings = z.infer<typeof WpSettingsSchema>;
export type WpPostStatus = z.infer<typeof PostStatusSchema>;

export function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, '');
}

function envFallback(value: string, envVar: string): string {
  if (value.trim()) return value.trim();
  const fromEnv = process.env[envVar];
  return typeof fromEnv === 'string' ? fromEnv.trim() : '';
}

function normalizeSlugs(slugs: string[]): string[] {
  return slugs.map((slug) => slug.trim()).filter(Boolean);
}

export async function loadWpSettings(): Promise<WpSettings> {
  const stored = await openWorkerKv(WORKER_ID).get<Partial<WpSettings> | string>(SETTINGS_KEY);
  const raw = typeof stored === 'string' ? safeJson(stored) : stored;
  const parsed = WpSettingsSchema.parse(raw ?? {});
  return {
    ...parsed,
    baseUrl: envFallback(parsed.baseUrl, 'WORDPRESS_BASE_URL'),
    username: envFallback(parsed.username, 'WORDPRESS_USERNAME'),
    applicationPassword: envFallback(parsed.applicationPassword, 'WORDPRESS_APPLICATION_PASSWORD'),
    postType: parsed.postType.trim() || 'posts',
    categorySlugs: normalizeSlugs(parsed.categorySlugs),
    tagSlugs: normalizeSlugs(parsed.tagSlugs),
    allowedHosts: normalizeSlugs(parsed.allowedHosts).map((host) => host.toLowerCase()),
    blockedHosts: normalizeSlugs(parsed.blockedHosts).map((host) => host.toLowerCase()),
    allowedFeedUrls: normalizeSlugs(parsed.allowedFeedUrls),
    requiredTags: normalizeSlugs(parsed.requiredTags).map((tag) => tag.toLowerCase()),
    excludedTags: normalizeSlugs(parsed.excludedTags).map((tag) => tag.toLowerCase()),
    includeKeywords: normalizeSlugs(parsed.includeKeywords).map((keyword) => keyword.toLowerCase()),
    excludeKeywords: normalizeSlugs(parsed.excludeKeywords).map((keyword) => keyword.toLowerCase()),
    minimumRelevanceScore: Number.isFinite(parsed.minimumRelevanceScore) ? parsed.minimumRelevanceScore : 0,
  };
}

export async function saveWpSettings(partial: Partial<WpSettings>): Promise<WpSettings> {
  const kv = openWorkerKv(WORKER_ID);
  const current = await loadStoredSettings();
  const next = WpSettingsSchema.parse({
    ...current,
    ...partial,
    baseUrl: typeof partial.baseUrl === 'string' ? normalizeBaseUrl(partial.baseUrl) : current.baseUrl,
    postType: typeof partial.postType === 'string' && partial.postType.trim() ? partial.postType.trim() : current.postType,
    categorySlugs: Array.isArray(partial.categorySlugs) ? normalizeSlugs(partial.categorySlugs) : current.categorySlugs,
    tagSlugs: Array.isArray(partial.tagSlugs) ? normalizeSlugs(partial.tagSlugs) : current.tagSlugs,
    allowedHosts: Array.isArray(partial.allowedHosts) ? normalizeSlugs(partial.allowedHosts).map((host) => host.toLowerCase()) : current.allowedHosts,
    blockedHosts: Array.isArray(partial.blockedHosts) ? normalizeSlugs(partial.blockedHosts).map((host) => host.toLowerCase()) : current.blockedHosts,
    allowedFeedUrls: Array.isArray(partial.allowedFeedUrls) ? normalizeSlugs(partial.allowedFeedUrls) : current.allowedFeedUrls,
    requiredTags: Array.isArray(partial.requiredTags) ? normalizeSlugs(partial.requiredTags).map((tag) => tag.toLowerCase()) : current.requiredTags,
    excludedTags: Array.isArray(partial.excludedTags) ? normalizeSlugs(partial.excludedTags).map((tag) => tag.toLowerCase()) : current.excludedTags,
    includeKeywords: Array.isArray(partial.includeKeywords) ? normalizeSlugs(partial.includeKeywords).map((keyword) => keyword.toLowerCase()) : current.includeKeywords,
    excludeKeywords: Array.isArray(partial.excludeKeywords) ? normalizeSlugs(partial.excludeKeywords).map((keyword) => keyword.toLowerCase()) : current.excludeKeywords,
  });
  await kv.set(SETTINGS_KEY, next);
  return next;
}

export async function loadPublicWpSettings(): Promise<WpSettings> {
  return publicWpSettings(await loadWpSettings());
}

export function publicWpSettings(settings: WpSettings): WpSettings {
  return {
    ...settings,
    applicationPassword: settings.applicationPassword ? MASKED_SECRET : '',
  };
}

async function loadStoredSettings(): Promise<WpSettings> {
  const stored = await openWorkerKv(WORKER_ID).get<Partial<WpSettings> | string>(SETTINGS_KEY);
  const raw = typeof stored === 'string' ? safeJson(stored) : stored;
  return WpSettingsSchema.parse(raw ?? {});
}

function safeJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
}
