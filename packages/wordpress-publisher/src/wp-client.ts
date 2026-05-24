export interface WpAuth {
  baseUrl: string;
  username: string;
  applicationPassword: string;
}

export interface WpTaxonomyTerm {
  id: number;
  name: string;
  slug: string;
}

export interface WpPostInput {
  title: string;
  content: string;
  excerpt?: string;
  status: 'publish' | 'draft' | 'pending' | 'private' | 'future';
  categories?: number[];
  tags?: number[];
  slug?: string;
  date?: string;
  postType?: string;
}

export interface WpPostResult {
  id: number;
  link: string;
  status: string;
  slug: string;
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

async function wpFetch(auth: WpAuth, pathAndQuery: string, init: RequestInit = {}): Promise<unknown> {
  const url = `${normalizeBaseUrl(auth.baseUrl)}${REST_ROOT}${pathAndQuery}`;
  const headers = new Headers(init.headers);
  headers.set('Authorization', authHeader(auth));
  if (init.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');

  const res = await fetch(url, { ...init, headers, signal: init.signal ?? AbortSignal.timeout(20_000) });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`WordPress ${res.status} ${res.statusText} for ${pathAndQuery}: ${text.slice(0, 400)}`);
  }
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`WordPress returned non-JSON response for ${pathAndQuery}: ${text.slice(0, 200)}`);
  }
}

async function listTaxonomy(auth: WpAuth, taxonomy: 'categories' | 'tags'): Promise<WpTaxonomyTerm[]> {
  const out: WpTaxonomyTerm[] = [];
  for (let page = 1; page <= 20; page += 1) {
    const batch = (await wpFetch(auth, `/${taxonomy}?per_page=100&page=${page}&_fields=id,name,slug`)) as Array<{
      id?: unknown;
      name?: unknown;
      slug?: unknown;
    }>;
    if (!Array.isArray(batch) || batch.length === 0) break;
    for (const term of batch) {
      if (typeof term.id === 'number' && typeof term.name === 'string' && typeof term.slug === 'string') {
        out.push({ id: term.id, name: term.name, slug: term.slug });
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

export async function ping(auth: WpAuth): Promise<{ name: string; url: string }> {
  const res = (await wpFetch(auth, '/users/me?_fields=id,name,url')) as {
    name?: unknown;
    url?: unknown;
  };
  return {
    name: typeof res.name === 'string' ? res.name : '',
    url: typeof res.url === 'string' ? res.url : '',
  };
}

export async function createPost(auth: WpAuth, post: WpPostInput): Promise<WpPostResult> {
  const body: Record<string, unknown> = {
    title: post.title,
    content: post.content,
    status: post.status,
  };
  if (post.excerpt) body.excerpt = post.excerpt;
  if (post.categories?.length) body.categories = post.categories;
  if (post.tags?.length) body.tags = post.tags;
  if (post.slug) body.slug = post.slug;
  if (post.date) body.date = post.date;

  const res = (await wpFetch(auth, `/${collection(post.postType)}`, {
    method: 'POST',
    body: JSON.stringify(body),
  })) as { id?: unknown; link?: unknown; status?: unknown; slug?: unknown };

  if (typeof res.id !== 'number' || typeof res.link !== 'string') {
    throw new Error(`WordPress create-post response missing id/link: ${JSON.stringify(res).slice(0, 200)}`);
  }

  return {
    id: res.id,
    link: res.link,
    status: typeof res.status === 'string' ? res.status : post.status,
    slug: typeof res.slug === 'string' ? res.slug : '',
  };
}
