# RSS Harvester

RSS Harvester is a BFrost producer worker. It polls configured RSS and Atom feed URLs and publishes new entries as `news.article` items on the Item Bus.

## Produces

- `news.article`

Each item includes source/feed metadata in `payload.source` and article metadata in `payload.article`, plus legacy-friendly `title`, `url`, `summary`, `publishedAt`, and `feedUrl` fields.

## Settings

- `feeds` - newline-separated RSS or Atom feed URLs.

Settings are stored in the worker KV namespace under `worker.rss-harvester.config`.

## Dashboard

The worker ships a runtime dashboard bundle with:

- feed count and schedule status
- a manual `rss-fetch` run button
- last-run summary and feed errors
- recently published Item Bus items

## Operational Notes

Deduplication is keyed by a SHA-256 hash of the entry link. The worker writes only to its own KV namespace and only publishes through the Item Bus.
