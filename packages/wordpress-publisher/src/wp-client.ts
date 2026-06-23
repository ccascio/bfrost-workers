export interface WpAuth {
  baseUrl: string;
  username: string;
  applicationPassword: string;
}

export interface WpTaxonomyTerm {
  id: number;
  name: string;
  slug: string;
  description?: string;
  count?: number;
  parent?: number;
}

export interface WpContentInput {
  title: string;
  content: string;
  excerpt?: string;
  status: 'publish' | 'draft' | 'pending' | 'private' | 'future';
  categories?: number[];
  tags?: number[];
  slug?: string;
  date?: string;
  featuredMedia?: number;
  author?: number;
  parent?: number;
  menuOrder?: number;
  template?: string;
  format?: string;
  postType?: string;
}

export type WpPostInput = WpContentInput;

export interface WpContentResult {
  id: number;
  link: string;
  status: string;
  slug: string;
  type?: string;
  title?: string;
  excerpt?: string;
  content?: string;
}

export type WpPostResult = WpContentResult;

export interface WpContentListOptions {
  collection?: string;
  status?: string;
  search?: string;
  page?: number;
  perPage?: number;
  fields?: string[];
}

export interface WpContentTypeInfo {
  slug: string;
  name: string;
  restBase: string;
  description?: string;
  hierarchical?: boolean;
}

export interface WpStatusInfo {
  slug: string;
  name: string;
  public?: boolean;
  private?: boolean;
  protected?: boolean;
}

export interface WpTaxonomyInfo {
  slug: string;
  name: string;
  restBase: string;
  types: string[];
  hierarchical?: boolean;
}

export interface WpCapabilitiesSnapshot {
  user: { id: number; name: string; url: string };
  types: WpContentTypeInfo[];
  statuses: WpStatusInfo[];
  taxonomies: WpTaxonomyInfo[];
}

export interface WpMediaItem {
  id: number;
  link: string;
  sourceUrl: string;
  thumbnailUrl: string;
  title: string;
  altText: string;
  mimeType: string;
}

const REST_ROOT = '/wp-json/wp/v2';

function authHeader(auth: WpAuth): string {
  return `Basic ${Buffer.from(`${auth.username}:${auth.applicationPassword}`, 'utf8').toString('base64')}`;
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '');
}

function collection(value: string | undefined): string {
  const clean = (value || 'posts').replace(/^\/+|\/+$/g, '');
  return clean || 'posts';
}

function query(params: Record<string, string | number | undefined>): string {
  const url = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== '') url.set(key, String(value));
  }
  const text = url.toString();
  return text ? `?${text}` : '';
}

function normalizeWpError(status: number, statusText: string, pathAndQuery: string, body: string): Error {
  let message = body.slice(0, 500);
  try {
    const parsed = JSON.parse(body) as { code?: unknown; message?: unknown };
    if (typeof parsed.message === 'string') message = parsed.message;
  } catch {
    // keep text body
  }
  if (status === 401) message = `WordPress authentication failed. Check username and Application Password. ${message}`;
  if (status === 403) message = `WordPress permission denied for ${pathAndQuery}. The user may not be allowed to manage this content. ${message}`;
  if (status === 404) message = `WordPress endpoint not found for ${pathAndQuery}. Check REST API availability and post type rest_base. ${message}`;
  return new Error(`WordPress ${status} ${statusText}: ${message}`);
}

async function wpFetch(auth: WpAuth, pathAndQuery: string, init: RequestInit = {}): Promise<unknown> {
  const url = `${normalizeBaseUrl(auth.baseUrl)}${REST_ROOT}${pathAndQuery}`;
  const headers = new Headers(init.headers);
  headers.set('Authorization', authHeader(auth));
  if (init.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');

  const res = await fetch(url, { ...init, headers, signal: init.signal ?? AbortSignal.timeout(20_000) });
  const text = await res.text();
  if (!res.ok) throw normalizeWpError(res.status, res.statusText, pathAndQuery, text);
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`WordPress returned non-JSON response for ${pathAndQuery}: ${text.slice(0, 200)}`);
  }
}

function parseContent(res: unknown, fallbackStatus = ''): WpContentResult {
  const row = res as Record<string, unknown>;
  const title = row.title && typeof row.title === 'object' ? (row.title as { rendered?: unknown }).rendered : row.title;
  const content = row.content && typeof row.content === 'object' ? (row.content as { rendered?: unknown }).rendered : row.content;
  const excerpt = row.excerpt && typeof row.excerpt === 'object' ? (row.excerpt as { rendered?: unknown }).rendered : row.excerpt;
  if (typeof row.id !== 'number' || typeof row.link !== 'string') {
    throw new Error(`WordPress content response missing id/link: ${JSON.stringify(res).slice(0, 200)}`);
  }
  return {
    id: row.id,
    link: row.link,
    status: typeof row.status === 'string' ? row.status : fallbackStatus,
    slug: typeof row.slug === 'string' ? row.slug : '',
    type: typeof row.type === 'string' ? row.type : undefined,
    title: typeof title === 'string' ? title : undefined,
    content: typeof content === 'string' ? content : undefined,
    excerpt: typeof excerpt === 'string' ? excerpt : undefined,
  };
}

function contentBody(content: Partial<WpContentInput>): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  if (content.title !== undefined) body.title = content.title;
  if (content.content !== undefined) body.content = content.content;
  if (content.status !== undefined) body.status = content.status;
  if (content.excerpt) body.excerpt = content.excerpt;
  if (content.categories?.length) body.categories = content.categories;
  if (content.tags?.length) body.tags = content.tags;
  if (content.slug) body.slug = content.slug;
  if (content.date) body.date = content.date;
  if (typeof content.featuredMedia === 'number') body.featured_media = content.featuredMedia;
  if (typeof content.author === 'number') body.author = content.author;
  if (typeof content.parent === 'number') body.parent = content.parent;
  if (typeof content.menuOrder === 'number') body.menu_order = content.menuOrder;
  if (content.template) body.template = content.template;
  if (content.format) body.format = content.format;
  return body;
}

async function listTaxonomy(auth: WpAuth, taxonomy: 'categories' | 'tags'): Promise<WpTaxonomyTerm[]> {
  const out: WpTaxonomyTerm[] = [];
  for (let page = 1; page <= 20; page += 1) {
    const batch = (await wpFetch(auth, `/${taxonomy}?per_page=100&page=${page}&_fields=id,name,slug,description,count,parent`)) as Array<Record<string, unknown>>;
    if (!Array.isArray(batch) || batch.length === 0) break;
    for (const term of batch) {
      if (typeof term.id === 'number' && typeof term.name === 'string' && typeof term.slug === 'string') {
        out.push({
          id: term.id,
          name: term.name,
          slug: term.slug,
          description: typeof term.description === 'string' ? term.description : undefined,
          count: typeof term.count === 'number' ? term.count : undefined,
          parent: typeof term.parent === 'number' ? term.parent : undefined,
        });
      }
    }
    if (batch.length < 100) break;
  }
  return out;
}

export async function fetchCategories(auth: WpAuth): Promise<WpTaxonomyTerm[]> {
  return listTaxonomy(auth, 'categories');
}

export async function fetchTags(auth: WpAuth): Promise<WpTaxonomyTerm[]> {
  return listTaxonomy(auth, 'tags');
}

export async function createCategory(auth: WpAuth, input: { name: string; slug?: string; description?: string; parent?: number }): Promise<WpTaxonomyTerm> {
  const res = await wpFetch(auth, '/categories', { method: 'POST', body: JSON.stringify(input) }) as Record<string, unknown>;
  if (typeof res.id !== 'number' || typeof res.name !== 'string' || typeof res.slug !== 'string') {
    throw new Error(`WordPress category response missing id/name/slug: ${JSON.stringify(res).slice(0, 200)}`);
  }
  return { id: res.id, name: res.name, slug: res.slug, description: typeof res.description === 'string' ? res.description : undefined };
}

export async function createTag(auth: WpAuth, input: { name: string; slug?: string; description?: string }): Promise<WpTaxonomyTerm> {
  const res = await wpFetch(auth, '/tags', { method: 'POST', body: JSON.stringify(input) }) as Record<string, unknown>;
  if (typeof res.id !== 'number' || typeof res.name !== 'string' || typeof res.slug !== 'string') {
    throw new Error(`WordPress tag response missing id/name/slug: ${JSON.stringify(res).slice(0, 200)}`);
  }
  return { id: res.id, name: res.name, slug: res.slug, description: typeof res.description === 'string' ? res.description : undefined };
}

export async function ping(auth: WpAuth): Promise<{ id: number; name: string; url: string }> {
  const res = (await wpFetch(auth, '/users/me?_fields=id,name,url')) as { id?: unknown; name?: unknown; url?: unknown };
  return {
    id: typeof res.id === 'number' ? res.id : 0,
    name: typeof res.name === 'string' ? res.name : '',
    url: typeof res.url === 'string' ? res.url : '',
  };
}

export async function discoverCapabilities(auth: WpAuth): Promise<WpCapabilitiesSnapshot> {
  const [user, rawTypes, rawStatuses, rawTaxonomies] = await Promise.all([
    ping(auth),
    wpFetch(auth, '/types?context=edit'),
    wpFetch(auth, '/statuses?context=edit'),
    wpFetch(auth, '/taxonomies?context=edit'),
  ]);

  const types = Object.entries((rawTypes ?? {}) as Record<string, Record<string, unknown>>).map(([slug, value]) => ({
    slug,
    name: typeof value.name === 'string' ? value.name : slug,
    restBase: typeof value.rest_base === 'string' ? value.rest_base : slug,
    description: typeof value.description === 'string' ? value.description : undefined,
    hierarchical: typeof value.hierarchical === 'boolean' ? value.hierarchical : undefined,
  }));
  const statuses = Object.entries((rawStatuses ?? {}) as Record<string, Record<string, unknown>>).map(([slug, value]) => ({
    slug,
    name: typeof value.name === 'string' ? value.name : slug,
    public: typeof value.public === 'boolean' ? value.public : undefined,
    private: typeof value.private === 'boolean' ? value.private : undefined,
    protected: typeof value.protected === 'boolean' ? value.protected : undefined,
  }));
  const taxonomies = Object.entries((rawTaxonomies ?? {}) as Record<string, Record<string, unknown>>).map(([slug, value]) => ({
    slug,
    name: typeof value.name === 'string' ? value.name : slug,
    restBase: typeof value.rest_base === 'string' ? value.rest_base : slug,
    types: Array.isArray(value.types) ? value.types.filter((entry): entry is string => typeof entry === 'string') : [],
    hierarchical: typeof value.hierarchical === 'boolean' ? value.hierarchical : undefined,
  }));
  return { user, types, statuses, taxonomies };
}

export async function listContent(auth: WpAuth, options: WpContentListOptions = {}): Promise<WpContentResult[]> {
  const fields = options.fields?.join(',') || 'id,link,status,slug,type,title,excerpt';
  const path = `/${collection(options.collection)}${query({
    per_page: options.perPage ?? 20,
    page: options.page ?? 1,
    status: options.status,
    search: options.search,
    _fields: fields,
  })}`;
  const res = await wpFetch(auth, path) as unknown[];
  return Array.isArray(res) ? res.map((entry) => parseContent(entry, options.status ?? '')) : [];
}

export async function getContent(auth: WpAuth, collectionName: string, id: number): Promise<WpContentResult> {
  return parseContent(await wpFetch(auth, `/${collection(collectionName)}/${id}?context=edit`));
}

export async function createContent(auth: WpAuth, input: WpContentInput): Promise<WpContentResult> {
  return parseContent(await wpFetch(auth, `/${collection(input.postType)}`, {
    method: 'POST',
    body: JSON.stringify(contentBody(input)),
  }), input.status);
}

export async function updateContent(auth: WpAuth, collectionName: string, id: number, input: Partial<WpContentInput>): Promise<WpContentResult> {
  return parseContent(await wpFetch(auth, `/${collection(collectionName)}/${id}`, {
    method: 'POST',
    body: JSON.stringify(contentBody(input)),
  }), input.status);
}

export async function deleteContent(auth: WpAuth, collectionName: string, id: number, force = false): Promise<{ deleted: boolean; previous?: WpContentResult }> {
  const res = await wpFetch(auth, `/${collection(collectionName)}/${id}${query({ force: force ? 'true' : undefined })}`, { method: 'DELETE' }) as Record<string, unknown>;
  return {
    deleted: Boolean(res.deleted),
    previous: res.previous ? parseContent(res.previous) : undefined,
  };
}

function parseMedia(res: unknown): WpMediaItem {
  const row = res as Record<string, unknown>;
  const title = row.title && typeof row.title === 'object' ? (row.title as { rendered?: unknown }).rendered : row.title;
  if (typeof row.id !== 'number') throw new Error(`WordPress media response missing id: ${JSON.stringify(res).slice(0, 200)}`);
  const mediaDetails = row.media_details && typeof row.media_details === 'object' ? row.media_details as Record<string, unknown> : {};
  const sizes = mediaDetails.sizes && typeof mediaDetails.sizes === 'object' ? mediaDetails.sizes as Record<string, unknown> : {};
  const thumbnail = sizes.thumbnail && typeof sizes.thumbnail === 'object' ? sizes.thumbnail as { source_url?: unknown } : null;
  const medium = sizes.medium && typeof sizes.medium === 'object' ? sizes.medium as { source_url?: unknown } : null;
  const sourceUrl = typeof row.source_url === 'string' ? row.source_url : '';
  return {
    id: row.id,
    link: typeof row.link === 'string' ? row.link : '',
    sourceUrl,
    thumbnailUrl: typeof thumbnail?.source_url === 'string'
      ? thumbnail.source_url
      : typeof medium?.source_url === 'string'
        ? medium.source_url
        : sourceUrl,
    title: typeof title === 'string' ? title : '',
    altText: typeof row.alt_text === 'string' ? row.alt_text : '',
    mimeType: typeof row.mime_type === 'string' ? row.mime_type : '',
  };
}

export async function listMedia(auth: WpAuth, options: { search?: string; page?: number; perPage?: number } = {}): Promise<WpMediaItem[]> {
  const res = await wpFetch(auth, `/media${query({
    per_page: options.perPage ?? 20,
    page: options.page ?? 1,
    search: options.search,
    _fields: 'id,link,source_url,title,alt_text,mime_type,media_details',
  })}`) as unknown[];
  return Array.isArray(res) ? res.map(parseMedia) : [];
}

export async function uploadMediaFromUrl(auth: WpAuth, input: { sourceUrl: string; filename?: string; altText?: string; title?: string }): Promise<WpMediaItem> {
  const source = await fetch(input.sourceUrl, { signal: AbortSignal.timeout(30_000) });
  if (!source.ok) throw new Error(`Could not fetch media source ${input.sourceUrl}: ${source.status} ${source.statusText}`);
  const contentType = source.headers.get('content-type') || 'application/octet-stream';
  const bytes = Buffer.from(await source.arrayBuffer());
  const inferredName = input.filename || new URL(input.sourceUrl).pathname.split('/').filter(Boolean).pop() || `bfrost-media-${Date.now()}`;
  const headers = new Headers();
  headers.set('Content-Type', contentType);
  headers.set('Content-Disposition', `attachment; filename="${inferredName.replace(/"/g, '')}"`);
  const uploaded = parseMedia(await wpFetch(auth, '/media', { method: 'POST', headers, body: bytes as any }));
  const patch: Record<string, unknown> = {};
  if (input.altText) patch.alt_text = input.altText;
  if (input.title) patch.title = input.title;
  if (Object.keys(patch).length === 0) return uploaded;
  return parseMedia(await wpFetch(auth, `/media/${uploaded.id}`, { method: 'POST', body: JSON.stringify(patch) }));
}

export async function createPost(auth: WpAuth, post: WpPostInput): Promise<WpPostResult> {
  return createContent(auth, { ...post, postType: post.postType ?? 'posts' });
}
