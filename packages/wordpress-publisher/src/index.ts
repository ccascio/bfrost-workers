import { z } from 'zod';
import type { BackendWorkerModule, WorkerJobManifest, WorkerManifest } from 'bfrost';
import {
  loadTaxonomySnapshot,
  recentWordPressDrafts,
  recentWordPressPosts,
  refreshTaxonomies,
  runWordPressPublisher,
} from './job.js';
import { ensureDraftStorage } from './drafts.js';
import { wordpressRoutes } from './routes.js';
import { loadPublicWpSettings, loadWpSettings, WORKER_ID } from './settings.js';

const WP_JOB_ID = 'wordpress-publish';
const DEFAULT_WP_PROMPT =
  'You are a careful content writer. Customize this prompt to set tone, voice, length, and structure. Return publication-ready HTML.';

const wordpressJob: WorkerJobManifest = {
  id: WP_JOB_ID,
  workerId: WORKER_ID,
  label: 'WordPress publish',
  description: 'Pick an eligible news.article item and generate a WordPress draft for operator review.',
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
  version: '1.4.0',
  description: 'Generates reviewable WordPress drafts from news.article items and prepares them for publishing via the REST API.',
  tagline: 'Generates reviewable WordPress drafts before anything is sent to WordPress.',
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
        fieldGroups: [
          { id: 'connection', label: 'Connection', description: 'WordPress site URL and credentials.' },
          { id: 'publishing', label: 'Publishing defaults', description: 'Default content type, status, taxonomy, and model.' },
          { id: 'selection', label: 'Content selection', description: 'Choose which news.article items are eligible for WordPress drafts.' },
          { id: 'style', label: 'Tone and look', description: 'Brand voice, audience, tone, format, CTA, and prompt.' },
        ],
        fields: [
          {
            key: 'baseUrl',
            group: 'connection',
            label: 'WordPress base URL',
            type: 'text',
            defaultValue: '',
            placeholder: 'https://my-site.example.com',
            helpText: 'No trailing slash, no /wp-json - just the site root.',
            seedPath: 'wordpress-publisher.settings.baseUrl',
          },
          {
            key: 'username',
            group: 'connection',
            label: 'WordPress username',
            type: 'text',
            defaultValue: '',
            seedPath: 'wordpress-publisher.settings.username',
          },
          {
            key: 'applicationPassword',
            group: 'connection',
            label: 'Application Password',
            type: 'secret-reference',
            defaultValue: '',
            placeholder: 'xxxx xxxx xxxx xxxx xxxx xxxx',
            helpText: 'Generate one at Users > Profile > Application Passwords.',
            seedPath: 'wordpress-publisher.settings.applicationPassword',
          },
          {
            key: 'defaultStatus',
            group: 'publishing',
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
            group: 'publishing',
            label: 'Post type',
            type: 'text',
            defaultValue: 'posts',
            helpText: 'REST collection name, usually posts.',
            seedPath: 'wordpress-publisher.settings.postType',
          },
          {
            key: 'categorySlugs',
            group: 'publishing',
            label: 'Category slugs',
            type: 'string-list',
            defaultValue: [],
            rows: 3,
            helpText: 'One slug per line. Saved slugs are resolved against cached WordPress categories.',
            seedPath: 'wordpress-publisher.settings.categorySlugs',
          },
          {
            key: 'tagSlugs',
            group: 'publishing',
            label: 'Tag slugs',
            type: 'string-list',
            defaultValue: [],
            rows: 3,
            seedPath: 'wordpress-publisher.settings.tagSlugs',
          },
          {
            key: 'allowedHosts',
            group: 'selection',
            label: 'Allowed source hosts',
            type: 'string-list',
            defaultValue: [],
            rows: 4,
            helpText: 'Only use news from these hosts. Leave empty to allow any host.',
            seedPath: 'wordpress-publisher.settings.allowedHosts',
          },
          {
            key: 'blockedHosts',
            group: 'selection',
            label: 'Blocked source hosts',
            type: 'string-list',
            defaultValue: [],
            rows: 4,
            helpText: 'Never use news from these hosts.',
            seedPath: 'wordpress-publisher.settings.blockedHosts',
          },
          {
            key: 'allowedFeedUrls',
            group: 'selection',
            label: 'Allowed RSS feed URLs',
            type: 'string-list',
            defaultValue: [],
            rows: 4,
            helpText: 'For rss-harvester items, only use articles from these feed URLs.',
            seedPath: 'wordpress-publisher.settings.allowedFeedUrls',
          },
          {
            key: 'requiredTags',
            group: 'selection',
            label: 'Required tags/topics',
            type: 'string-list',
            defaultValue: [],
            rows: 4,
            helpText: 'At least one of these item tags or LLM topic tags must be present.',
            seedPath: 'wordpress-publisher.settings.requiredTags',
          },
          {
            key: 'excludedTags',
            group: 'selection',
            label: 'Excluded tags/topics',
            type: 'string-list',
            defaultValue: [],
            rows: 4,
            helpText: 'Reject items with any of these tags or LLM topic tags.',
            seedPath: 'wordpress-publisher.settings.excludedTags',
          },
          {
            key: 'minimumRelevanceScore',
            group: 'selection',
            label: 'Minimum relevance score',
            type: 'number',
            defaultValue: 0,
            min: 0,
            max: 5,
            step: 1,
            helpText: 'For rss-harvester items with relevanceScore, require this score or higher. 0 disables.',
            seedPath: 'wordpress-publisher.settings.minimumRelevanceScore',
          },
          {
            key: 'includeKeywords',
            group: 'selection',
            label: 'Required keywords',
            type: 'string-list',
            defaultValue: [],
            rows: 4,
            helpText: 'At least one keyword must appear in the title, summary, description, or excerpt.',
            seedPath: 'wordpress-publisher.settings.includeKeywords',
          },
          {
            key: 'excludeKeywords',
            group: 'selection',
            label: 'Excluded keywords',
            type: 'string-list',
            defaultValue: [],
            rows: 4,
            helpText: 'Reject items containing any of these keywords.',
            seedPath: 'wordpress-publisher.settings.excludeKeywords',
          },
          {
            key: 'consumeApprovedOnly',
            group: 'selection',
            label: 'Only consume approved queue items',
            type: 'boolean',
            defaultValue: false,
            helpText: 'When enabled, WordPress drafts are generated only from items approved in the queue.',
            seedPath: 'wordpress-publisher.settings.consumeApprovedOnly',
          },
          {
            key: 'brandVoice',
            group: 'style',
            label: 'Brand voice',
            type: 'textarea',
            defaultValue: '',
            rows: 4,
            helpText: 'Describe the site voice, point of view, and wording preferences.',
            seedPath: 'wordpress-publisher.settings.brandVoice',
          },
          {
            key: 'audience',
            group: 'style',
            label: 'Audience',
            type: 'text',
            defaultValue: '',
            placeholder: 'e.g. IT leaders, developers, local customers',
            seedPath: 'wordpress-publisher.settings.audience',
          },
          {
            key: 'tonePreset',
            group: 'style',
            label: 'Tone preset',
            type: 'select',
            defaultValue: 'factual',
            options: [
              { value: 'factual', label: 'Factual' },
              { value: 'expert', label: 'Expert' },
              { value: 'friendly', label: 'Friendly' },
              { value: 'executive', label: 'Executive' },
              { value: 'tutorial', label: 'Tutorial' },
              { value: 'seo-focused', label: 'SEO-focused' },
              { value: 'custom', label: 'Custom' },
            ],
            seedPath: 'wordpress-publisher.settings.tonePreset',
          },
          {
            key: 'contentFormat',
            group: 'style',
            label: 'Content format',
            type: 'select',
            defaultValue: 'news-brief',
            options: [
              { value: 'news-brief', label: 'News brief' },
              { value: 'long-form-article', label: 'Long-form article' },
              { value: 'tutorial', label: 'Tutorial' },
              { value: 'landing-page', label: 'Landing page' },
              { value: 'listicle', label: 'Listicle' },
              { value: 'faq', label: 'FAQ' },
              { value: 'product-update', label: 'Product update' },
            ],
            seedPath: 'wordpress-publisher.settings.contentFormat',
          },
          {
            key: 'ctaText',
            group: 'style',
            label: 'Call to action',
            type: 'text',
            defaultValue: '',
            placeholder: 'Optional CTA to weave into the conclusion',
            seedPath: 'wordpress-publisher.settings.ctaText',
          },
          {
            key: 'modelAlias',
            group: 'publishing',
            label: 'Model alias',
            type: 'text',
            defaultValue: '',
            helpText: 'Leave blank to use the BFrost default model.',
            seedPath: 'wordpress-publisher.settings.modelAlias',
          },
          {
            key: 'prompt',
            group: 'style',
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
        description: 'WordPress draft review status, cached taxonomies, recent posts, and manual run controls.',
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
      await ensureDraftStorage();
      try {
        await refreshTaxonomies();
      } catch {
        // Settings are often incomplete on first enable. The Config tab surfaces this.
      }
    },
  },
  async loadDashboardData() {
    const [settings, privateSettings, taxonomy, recentPosts, recentDrafts] = await Promise.all([
      loadPublicWpSettings(),
      loadWpSettings(),
      loadTaxonomySnapshot(),
      recentWordPressPosts(),
      recentWordPressDrafts(),
    ]);
    return {
      settings,
      configured: Boolean(privateSettings.baseUrl && privateSettings.username && privateSettings.applicationPassword),
      taxonomy,
      recentPosts,
      recentDrafts,
    };
  },
};

export default module;
