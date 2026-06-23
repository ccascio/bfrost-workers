import { z } from 'zod';
import { BadRequestError, type AdminApiRoute } from 'bfrost';
import { archiveWordPressDraft, IMPROVABLE_DRAFT_FIELDS, improveWordPressDraftField, loadTaxonomySnapshot, publishWordPressDraft, regenerateWordPressDraft, refreshTaxonomies } from './job.js';
import { createDraft, DRAFT_STATES, getDraft, listDraftEvents, listDraftVersions, listDrafts, recordDraftVersion, updateDraft, type DraftState } from './drafts.js';
import { getContent, listContent, listMedia, ping, updateContent, uploadMediaFromUrl } from './wp-client.js';
import {
  loadPublicWpSettings,
  loadWpSettings,
  MASKED_SECRET,
  normalizeBaseUrl,
  publicWpSettings,
  saveWpSettings,
  WORKER_ID,
  WpSettingsSchema,
} from './settings.js';

const SaveBodySchema = WpSettingsSchema.partial();

const DraftPatchSchema = z.object({
  state: z.enum(DRAFT_STATES).optional(),
  title: z.string().optional(),
  slug: z.string().optional(),
  excerpt: z.string().optional(),
  contentHtml: z.string().optional(),
  targetStatus: z.enum(['publish', 'draft', 'pending', 'private', 'future']).optional(),
  publishDate: z.string().optional(),
  pageParent: z.number().int().nullable().optional(),
  pageMenuOrder: z.number().int().nullable().optional(),
  pageTemplate: z.string().optional(),
  featuredMediaId: z.number().int().positive().nullable().optional(),
  categorySlugs: z.array(z.string()).optional(),
  tagSlugs: z.array(z.string()).optional(),
  operatorNotes: z.string().optional(),
  changeRequest: z.string().optional(),
}).strict();

const RequestChangesSchema = z.object({
  changeRequest: z.string().min(1),
}).strict();

const RegenerateDraftSchema = z.object({
  changeRequest: z.string().optional(),
}).strict();

const ImproveFieldSchema = z.object({
  field: z.enum(IMPROVABLE_DRAFT_FIELDS),
  instruction: z.string().min(1),
}).strict();

const RemoteContentSchema = z.object({
  collection: z.enum(['posts', 'pages']),
  id: z.number().int().positive(),
}).strict();

const UpdateRemoteFromDraftSchema = RemoteContentSchema.extend({
  draftId: z.string().min(1),
});

const UploadMediaFromUrlSchema = z.object({
  sourceUrl: z.string().url(),
  filename: z.string().optional(),
  altText: z.string().optional(),
  title: z.string().optional(),
}).strict();

const SetFeaturedMediaSchema = z.object({
  collection: z.enum(['posts', 'pages']),
  id: z.number().int().positive(),
  mediaId: z.number().int().positive(),
}).strict();

function requiredId(url: URL): string {
  const id = url.searchParams.get('id')?.trim();
  if (!id) throw new BadRequestError('Missing draft id.');
  return id;
}

function parseDraftState(value: string | null): DraftState | undefined {
  if (!value) return undefined;
  if ((DRAFT_STATES as readonly string[]).includes(value)) return value as DraftState;
  throw new BadRequestError(`Invalid draft state: ${value}`);
}

function authFromLoadedSettings(settings: Awaited<ReturnType<typeof loadWpSettings>>) {
  if (!settings.baseUrl || !settings.username || !settings.applicationPassword) {
    throw new BadRequestError('Set base URL, username, and application password first.');
  }
  return {
    baseUrl: settings.baseUrl,
    username: settings.username,
    applicationPassword: settings.applicationPassword,
  };
}

function draftStatus(value: string): 'publish' | 'draft' | 'pending' | 'private' | 'future' {
  return ['publish', 'draft', 'pending', 'private', 'future'].includes(value) ? value as any : 'draft';
}

export const wordpressRoutes: AdminApiRoute[] = [
  {
    method: 'GET',
    path: '/api/workers/wordpress-publisher/settings',
    workerIds: [WORKER_ID],
    handle: async () => ({ status: 200, body: await loadPublicWpSettings() }),
  },
  {
    method: 'POST',
    path: '/api/workers/wordpress-publisher/settings',
    workerIds: [WORKER_ID],
    handle: async (ctx) => {
      const raw = await ctx.readJsonBody(ctx.req, SaveBodySchema);
      const patch: z.infer<typeof SaveBodySchema> = { ...raw };

      if (typeof patch.baseUrl === 'string') {
        patch.baseUrl = normalizeBaseUrl(patch.baseUrl);
        if (patch.baseUrl) {
          try {
            new URL(patch.baseUrl);
          } catch {
            throw new BadRequestError(`Invalid WordPress base URL: ${patch.baseUrl}`);
          }
        }
      }

      if (patch.applicationPassword === MASKED_SECRET) {
        delete patch.applicationPassword;
      }

      const saved = await saveWpSettings(patch);
      let taxonomies: { categories: number; tags: number } | null = null;
      let refreshError: string | undefined;

      try {
        taxonomies = await refreshTaxonomies();
      } catch (err) {
        refreshError = err instanceof Error ? err.message : String(err);
      }

      return {
        status: 200,
        body: {
          settings: publicWpSettings(saved),
          taxonomies,
          refreshError,
        },
      };
    },
  },
  {
    method: 'POST',
    path: '/api/workers/wordpress-publisher/refresh-taxonomies',
    workerIds: [WORKER_ID],
    handle: async () => ({ status: 200, body: await refreshTaxonomies() }),
  },
  {
    method: 'GET',
    path: '/api/workers/wordpress-publisher/taxonomies',
    workerIds: [WORKER_ID],
    handle: async () => ({ status: 200, body: await loadTaxonomySnapshot() }),
  },
  {
    method: 'GET',
    path: '/api/workers/wordpress-publisher/capabilities',
    workerIds: [WORKER_ID],
    handle: async () => {
      const snapshot = await loadTaxonomySnapshot();
      return { status: 200, body: snapshot.capabilities ?? { user: null, types: [], statuses: [], taxonomies: [] } };
    },
  },
  {
    method: 'POST',
    path: '/api/workers/wordpress-publisher/refresh-capabilities',
    workerIds: [WORKER_ID],
    handle: async () => ({ status: 200, body: await refreshTaxonomies() }),
  },
  {
    method: 'POST',
    path: '/api/workers/wordpress-publisher/ping',
    workerIds: [WORKER_ID],
    handle: async () => {
      const settings = await loadWpSettings();
      return {
        status: 200,
        body: await ping(authFromLoadedSettings(settings)),
      };
    },
  },
  {
    method: 'GET',
    path: '/api/workers/wordpress-publisher/remote-content',
    workerIds: [WORKER_ID],
    handle: async (ctx) => {
      const collection = ctx.url.searchParams.get('collection') === 'pages' ? 'pages' : 'posts';
      const status = ctx.url.searchParams.get('status') || undefined;
      const search = ctx.url.searchParams.get('search') || undefined;
      const page = Number(ctx.url.searchParams.get('page') ?? 1);
      const perPage = Number(ctx.url.searchParams.get('perPage') ?? 20);
      const settings = await loadWpSettings();
      return {
        status: 200,
        body: {
          collection,
          items: await listContent(authFromLoadedSettings(settings), {
            collection,
            status,
            search,
            page: Number.isFinite(page) ? page : 1,
            perPage: Number.isFinite(perPage) ? Math.max(1, Math.min(50, perPage)) : 20,
          }),
        },
      };
    },
  },
  {
    method: 'GET',
    path: '/api/workers/wordpress-publisher/media',
    workerIds: [WORKER_ID],
    handle: async (ctx) => {
      const search = ctx.url.searchParams.get('search') || undefined;
      const page = Number(ctx.url.searchParams.get('page') ?? 1);
      const perPage = Number(ctx.url.searchParams.get('perPage') ?? 20);
      const settings = await loadWpSettings();
      return {
        status: 200,
        body: {
          items: await listMedia(authFromLoadedSettings(settings), {
            search,
            page: Number.isFinite(page) ? page : 1,
            perPage: Number.isFinite(perPage) ? Math.max(1, Math.min(50, perPage)) : 20,
          }),
        },
      };
    },
  },
  {
    method: 'POST',
    path: '/api/workers/wordpress-publisher/media/upload-from-url',
    workerIds: [WORKER_ID],
    handle: async (ctx) => {
      const body = await ctx.readJsonBody(ctx.req, UploadMediaFromUrlSchema);
      const settings = await loadWpSettings();
      return { status: 200, body: { media: await uploadMediaFromUrl(authFromLoadedSettings(settings), body) } };
    },
  },
  {
    method: 'POST',
    path: '/api/workers/wordpress-publisher/media/set-featured',
    workerIds: [WORKER_ID],
    handle: async (ctx) => {
      const body = await ctx.readJsonBody(ctx.req, SetFeaturedMediaSchema);
      const settings = await loadWpSettings();
      const remote = await updateContent(authFromLoadedSettings(settings), body.collection, body.id, {
        featuredMedia: body.mediaId,
      });
      return { status: 200, body: { remote } };
    },
  },
  {
    method: 'POST',
    path: '/api/workers/wordpress-publisher/remote-content/import',
    workerIds: [WORKER_ID],
    handle: async (ctx) => {
      const body = await ctx.readJsonBody(ctx.req, RemoteContentSchema);
      const settings = await loadWpSettings();
      const remote = await getContent(authFromLoadedSettings(settings), body.collection, body.id);
      const draft = await createDraft({
        sourceItemId: `wordpress:${body.collection}:${body.id}`,
        sourceItemType: `wordpress.${body.collection.slice(0, -1)}`,
        contentType: body.collection === 'pages' ? 'page' : 'post',
        title: remote.title || `WordPress ${body.collection.slice(0, -1)} ${body.id}`,
        slug: remote.slug,
        excerpt: remote.excerpt ?? '',
        contentHtml: remote.content ?? '',
        targetStatus: draftStatus(remote.status),
        publishDate: '',
        featuredMediaId: null,
        categorySlugs: [],
        tagSlugs: [],
        promptSnapshot: 'Imported from existing WordPress content.',
      });
      return { status: 200, body: { draft } };
    },
  },
  {
    method: 'POST',
    path: '/api/workers/wordpress-publisher/remote-content/update-from-draft',
    workerIds: [WORKER_ID],
    handle: async (ctx) => {
      const body = await ctx.readJsonBody(ctx.req, UpdateRemoteFromDraftSchema);
      const draft = await getDraft(body.draftId);
      if (!draft) throw new BadRequestError(`Draft not found: ${body.draftId}`, 404);
      const settings = await loadWpSettings();
      const remote = await updateContent(authFromLoadedSettings(settings), body.collection, body.id, {
        title: draft.title,
        slug: draft.slug,
        excerpt: draft.excerpt,
        content: draft.contentHtml,
        status: draft.targetStatus,
        date: draft.publishDate || undefined,
        parent: draft.contentType === 'page' ? draft.pageParent ?? undefined : undefined,
        menuOrder: draft.contentType === 'page' ? draft.pageMenuOrder ?? undefined : undefined,
        template: draft.contentType === 'page' ? draft.pageTemplate || undefined : undefined,
        featuredMedia: draft.featuredMediaId ?? undefined,
      });
      const updated = await updateDraft(draft.id, {
        state: 'published_to_wp',
        wpId: remote.id,
        wpLink: remote.link,
        wpStatus: remote.status,
        errorMessage: '',
        publishedAt: new Date().toISOString(),
      });
      return { status: 200, body: { draft: updated, remote } };
    },
  },
  {
    method: 'GET',
    path: '/api/workers/wordpress-publisher/drafts',
    workerIds: [WORKER_ID],
    handle: async (ctx) => {
      const limit = Number(ctx.url.searchParams.get('limit') ?? 20);
      const page = Number(ctx.url.searchParams.get('page') ?? 1);
      const state = parseDraftState(ctx.url.searchParams.get('state'));
      const safeLimit = Number.isFinite(limit) ? Math.max(1, Math.min(50, limit)) : 20;
      const safePage = Number.isFinite(page) ? Math.max(1, page) : 1;
      return { status: 200, body: { drafts: await listDrafts(safeLimit, state, (safePage - 1) * safeLimit), page: safePage, limit: safeLimit } };
    },
  },
  {
    method: 'GET',
    path: '/api/workers/wordpress-publisher/draft',
    workerIds: [WORKER_ID],
    handle: async (ctx) => {
      const id = requiredId(ctx.url);
      const draft = await getDraft(id);
      if (!draft) throw new BadRequestError(`Draft not found: ${id}`, 404);
      return { status: 200, body: { draft, events: await listDraftEvents(id), versions: await listDraftVersions(id) } };
    },
  },
  {
    method: 'PATCH',
    path: '/api/workers/wordpress-publisher/draft',
    workerIds: [WORKER_ID],
    handle: async (ctx) => {
      const id = requiredId(ctx.url);
      const patch = await ctx.readJsonBody(ctx.req, DraftPatchSchema);
      const draft = await updateDraft(id, patch);
      const contentChanged = ['title', 'slug', 'excerpt', 'contentHtml', 'publishDate', 'pageParent', 'pageMenuOrder', 'pageTemplate', 'featuredMediaId', 'categorySlugs', 'tagSlugs'].some((key) => key in patch);
      if (contentChanged) await recordDraftVersion(draft, 'Manual operator edit.');
      return { status: 200, body: { draft } };
    },
  },
  {
    method: 'POST',
    path: '/api/workers/wordpress-publisher/draft/publish',
    workerIds: [WORKER_ID],
    handle: async (ctx) => {
      const id = requiredId(ctx.url);
      return { status: 200, body: { draft: await publishWordPressDraft(id) } };
    },
  },
  {
    method: 'POST',
    path: '/api/workers/wordpress-publisher/draft/improve-field',
    workerIds: [WORKER_ID],
    handle: async (ctx) => {
      const id = requiredId(ctx.url);
      const body = await ctx.readJsonBody(ctx.req, ImproveFieldSchema);
      return { status: 200, body: { draft: await improveWordPressDraftField(id, body.field, body.instruction) } };
    },
  },
  {
    method: 'POST',
    path: '/api/workers/wordpress-publisher/draft/archive',
    workerIds: [WORKER_ID],
    handle: async (ctx) => {
      const id = requiredId(ctx.url);
      return { status: 200, body: { draft: await archiveWordPressDraft(id) } };
    },
  },
  {
    method: 'POST',
    path: '/api/workers/wordpress-publisher/draft/regenerate',
    workerIds: [WORKER_ID],
    handle: async (ctx) => {
      const id = requiredId(ctx.url);
      const body = await ctx.readJsonBody(ctx.req, RegenerateDraftSchema);
      return { status: 200, body: { draft: await regenerateWordPressDraft(id, body.changeRequest) } };
    },
  },
  {
    method: 'POST',
    path: '/api/workers/wordpress-publisher/draft/request-changes',
    workerIds: [WORKER_ID],
    handle: async (ctx) => {
      const id = requiredId(ctx.url);
      const body = await ctx.readJsonBody(ctx.req, RequestChangesSchema);
      return {
        status: 200,
        body: { draft: await updateDraft(id, { state: 'needs_changes', changeRequest: body.changeRequest }) },
      };
    },
  },
];
