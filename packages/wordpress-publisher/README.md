# WordPress Publisher

WordPress Publisher is a BFrost consumer worker. It reads eligible `news.article` items from the Item Bus, asks the configured BFrost model to draft publication-ready HTML, and creates a WordPress post through the REST API.

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
- `modelAlias` - optional BFrost model alias. Blank uses the platform default.
- `prompt` - optional custom article style prompt.

Settings are stored in the worker KV namespace under `worker.wordpress-publisher.settings`. The password can also be supplied through `WORDPRESS_APPLICATION_PASSWORD`.

## Dashboard

The worker ships a runtime dashboard bundle with setup status, schedule status, cached taxonomy counts, manual run controls, and recent post outcomes.

## Operational Notes

The scheduled job is disabled by default. Enable it after saving credentials and testing one manual run. The worker refreshes categories and tags on save and on enable when credentials are available.
