# WordPress Publisher

WordPress Publisher is a BFrost consumer worker. It reads eligible `news.article` items from the Item Bus, asks the configured BFrost model to draft publication-ready HTML, and stores a local draft for operator review before anything is sent to WordPress.

## Consumes

- `news.article`

The worker records its result under `metadata["wordpress-publisher"]` and never writes into another worker namespace.

## Settings

- `baseUrl` - WordPress site root URL.
- `username` - WordPress username.
- `applicationPassword` - WordPress Application Password.
- `defaultStatus` - `draft`, `pending`, `publish`, or `private`.
- `postType` - REST collection name, usually `posts`.
- `categorySlugs` - category slugs resolved against the cached WordPress categories.
- `tagSlugs` - tag slugs resolved against the cached WordPress tags.
- `brandVoice` - optional brand voice and wording guidelines.
- `audience` - intended reader persona.
- `tonePreset` - factual, expert, friendly, executive, tutorial, SEO-focused, or custom.
- `contentFormat` - news brief, long-form article, tutorial, landing page, listicle, FAQ, or product update.
- `ctaText` - optional call to action to include when natural.
- Content selection filters for the Item Bus:
  - `allowedHosts` / `blockedHosts` - filter by `payload.source.host`.
  - `allowedFeedUrls` - filter RSS Harvester items by feed URL.
  - `requiredTags` / `excludedTags` - filter queue tags and `payload.llmTags`.
  - `minimumRelevanceScore` - filter RSS Harvester `payload.relevanceScore`.
  - `includeKeywords` / `excludeKeywords` - match title, summary, description, and excerpt.
  - `consumeApprovedOnly` - only consume queue items approved by the operator.
- `modelAlias` - optional BFrost model alias. Blank uses the platform default.
- `prompt` - optional custom article style prompt; combined with the structured JSON output contract.

Settings are stored in the worker KV namespace under `worker.wordpress-publisher.settings`. The password can also be supplied through `WORDPRESS_APPLICATION_PASSWORD`.

## Dashboard

The worker ships a runtime dashboard bundle with setup status, schedule status, cached taxonomy/capability counts, manual run controls, workspace tabs for Drafts / WordPress Posts / WordPress Pages / Taxonomies / Media, a state-filtered draft inbox, and a WordPress-like editor with a main title/body area, Visual/HTML modes, sticky publish/sidebar panels, field-level LLM improvement prompts, featured media controls, post/page scheduling, page parent/template/menu-order controls, request-changes/regenerate actions, archive/discard, remote import/update actions, and an explicit create-in-WordPress action. The scheduled job now generates local drafts by default; WordPress writes happen only after operator action.

## Operational Notes

The scheduled job is disabled by default. Enable it after saving credentials and testing one manual run. The worker refreshes categories and tags on save and on enable when credentials are available. Generated drafts and version snapshots are stored in the worker-owned SQLite namespace, and queue items are annotated only under `metadata["wordpress-publisher"]`. The REST client now discovers WordPress post types, statuses, taxonomies, and the current user, and includes typed helpers for posts, pages, categories, and tags.
