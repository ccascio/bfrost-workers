import { z } from 'zod';
import type { BackendWorkerModule, WorkerJobManifest, WorkerManifest } from 'bfrost';
import {
  loadTaxonomySnapshot,
  recentWordPressPosts,
  refreshTaxonomies,
  runWordPressPublisher,
} from './job.js';
import { wordpressRoutes } from './routes.js';
import { loadPublicWpSettings, loadWpSettings, WORKER_ID } from './settings.js';

const WP_JOB_ID = 'wordpress-publish';
const DEFAULT_WP_PROMPT =
  'You are a careful content writer. Customize this prompt to set tone, voice, length, and structure. Return publication-ready HTML.';

const wordpressJob: WorkerJobManifest = {
  id: WP_JOB_ID,
  workerId: WORKER_ID,
  label: 'WordPress publish',
  description: 'Pick an eligible news.article item and publish it to the configured WordPress site.',
  defaultEnabled: false,
  defaultCron: '0 */6 * * *',
  defaultModelAlias: '',
  approvalRequiredDefault: true,
  approvalRequiredEditable: true,
  defaultPrompt: DEFAULT_WP_PROMPT,
  prompt: {
    editable: false,
    helpText: 'Edit the prompt in the Config tab. That field is the source of truth.',
  },
  paramsSchema: z.object({}).strict(),
  defaultParams: {},
  dashboardFields: [],
  run: async () => {
    const result = await runWordPressPublisher();
    return { summary: result.summary, itemCount: result.itemCount };
  },
};

const manifest: WorkerManifest = {
  manifestVersion: 1,
  bfrostApiVersion: '0.1',
  id: WORKER_ID,
  name: 'WordPress Publisher',
  displayName: 'WordPress Publisher',
  version: '1.3.0',
  description: 'Publishes news.article items from the Item Bus to your WordPress site via the REST API.',
  tagline: 'Publishes news.article items from the Item Bus to your WordPress site via the REST API.',
  builtIn: false,
  kind: 'feature',
  ownedSettings: [
    {
      key: 'wordpress-publisher-config',
      label: 'WordPress site',
      description: 'Base URL, username, application password, post status, taxonomies, and prompt.',
      scope: 'worker',
      storageKey: `worker.${WORKER_ID}.settings`,
      dashboardTarget: 'config',
    },
  ],
  jobs: [wordpressJob],
  dashboard: {
    settings: [
      {
        id: 'wordpress-publisher-config',
        label: 'WordPress connection',
        description: 'Application Password authentication and article-generation settings.',
        tab: 'config',
        path: '/api/workers/wordpress-publisher/settings',
        fields: [
          {
            key: 'baseUrl',
            label: 'WordPress base URL',
            type: 'text',
            defaultValue: '',
            placeholder: 'https://my-site.example.com',
            helpText: 'No trailing slash, no /wp-json - just the site root.',
            seedPath: 'wordpress-publisher.settings.baseUrl',
          },
          {
            key: 'username',
            label: 'WordPress username',
            type: 'text',
            defaultValue: '',
            seedPath: 'wordpress-publisher.settings.username',
          },
          {
            key: 'applicationPassword',
            label: 'Application Password',
            type: 'secret-reference',
            defaultValue: '',
            placeholder: 'xxxx xxxx xxxx xxxx xxxx xxxx',
            helpText: 'Generate one at Users > Profile > Application Passwords.',
            seedPath: 'wordpress-publisher.settings.applicationPassword',
          },
          {
            key: 'defaultStatus',
            label: 'Publish as',
            type: 'select',
            defaultValue: 'draft',
            options: [
              { value: 'draft', label: 'Draft' },
              { value: 'pending', label: 'Pending review' },
              { value: 'publish', label: 'Publish immediately' },
              { value: 'private', label: 'Private' },
            ],
            seedPath: 'wordpress-publisher.settings.defaultStatus',
          },
          {
            key: 'postType',
            label: 'Post type',
            type: 'text',
            defaultValue: 'posts',
            helpText: 'REST collection name, usually posts.',
            seedPath: 'wordpress-publisher.settings.postType',
          },
          {
            key: 'categorySlugs',
            label: 'Category slugs',
            type: 'string-list',
            defaultValue: [],
            rows: 3,
            helpText: 'One slug per line. Saved slugs are resolved against cached WordPress categories.',
            seedPath: 'wordpress-publisher.settings.categorySlugs',
          },
          {
            key: 'tagSlugs',
            label: 'Tag slugs',
            type: 'string-list',
            defaultValue: [],
            rows: 3,
            seedPath: 'wordpress-publisher.settings.tagSlugs',
          },
          {
            key: 'modelAlias',
            label: 'Model alias',
            type: 'text',
            defaultValue: '',
            helpText: 'Leave blank to use the BFrost default model.',
            seedPath: 'wordpress-publisher.settings.modelAlias',
          },
          {
            key: 'prompt',
            label: 'Article style prompt',
            type: 'textarea',
            defaultValue: '',
            rows: 10,
            helpText: 'Controls tone, structure, and length. Leave blank to use the built-in default.',
            seedPath: 'wordpress-publisher.settings.prompt',
          },
        ],
      },
    ],
    routes: [
      {
        id: 'wordpress-publisher-dashboard',
        label: 'WordPress',
        description: 'WordPress publishing status, cached taxonomies, recent posts, and manual run controls.',
        path: '/api/workers/wordpress-publisher/dashboard',
      },
    ],
  },
};

const module: BackendWorkerModule = {
  manifest,
  apiRoutes: wordpressRoutes,
  lifecycle: {
    async onEnable() {
      try {
        await refreshTaxonomies();
      } catch {
        // Settings are often incomplete on first enable. The Config tab surfaces this.
      }
    },
  },
  async loadDashboardData() {
    const [settings, privateSettings, taxonomy, recentPosts] = await Promise.all([
      loadPublicWpSettings(),
      loadWpSettings(),
      loadTaxonomySnapshot(),
      recentWordPressPosts(),
    ]);
    return {
      settings,
      configured: Boolean(privateSettings.baseUrl && privateSettings.username && privateSettings.applicationPassword),
      taxonomy,
      recentPosts,
    };
  },
};

export default module;
