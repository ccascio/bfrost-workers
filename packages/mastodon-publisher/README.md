# Mastodon Publisher

Mastodon Publisher is a BFrost consumer worker. It reads eligible `news.article` items from the Item Bus and posts them to a configured Mastodon instance.

## Consumes

- `news.article`

The worker records its result under `metadata["mastodon-publisher"]` and never writes into another worker namespace.

## Settings

- `instanceUrl` - Mastodon instance root URL.
- `accessToken` - Mastodon API access token.
- `visibility` - `public`, `unlisted`, or `private`.
- `maxItemsPerRun` - number of queue items to publish per job run.
- `template` - status template supporting `{title}`, `{summary}`, `{url}`, and `{hashtags}`.

Settings are stored in the worker KV namespace under `worker.mastodon-publisher.config`.

## Dashboard

The worker ships a runtime dashboard bundle with setup status, schedule status, manual run controls, and recent post outcomes.

## Operational Notes

The scheduled job is disabled by default. Enable it after saving credentials and testing one manual run.
