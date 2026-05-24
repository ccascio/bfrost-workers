import { z } from 'zod';
import { openWorkerKv } from 'bfrost';

export const WORKER_ID = 'wordpress-publisher';
export const SETTINGS_KEY = 'settings';
export const MASKED_SECRET = '********';

const PostStatusSchema = z.enum(['publish', 'draft', 'pending', 'private', 'future']);

export const WpSettingsSchema = z.object({
  baseUrl: z.string().default(''),
  username: z.string().default(''),
  applicationPassword: z.string().default(''),
  defaultStatus: PostStatusSchema.default('draft'),
  postType: z.string().default('posts'),
  categorySlugs: z.array(z.string()).default([]),
  tagSlugs: z.array(z.string()).default([]),
  prompt: z.string().default(''),
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
