import { z } from 'zod';
import { BadRequestError, type AdminApiRoute } from 'bfrost';
import { loadTaxonomySnapshot, refreshTaxonomies } from './job.js';
import { ping } from './wp-client.js';
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
    method: 'POST',
    path: '/api/workers/wordpress-publisher/ping',
    workerIds: [WORKER_ID],
    handle: async () => {
      const settings = await loadWpSettings();
      if (!settings.baseUrl || !settings.username || !settings.applicationPassword) {
        throw new BadRequestError('Set base URL, username, and application password before pinging.');
      }
      return {
        status: 200,
        body: await ping({
          baseUrl: settings.baseUrl,
          username: settings.username,
          applicationPassword: settings.applicationPassword,
        }),
      };
    },
  },
];
