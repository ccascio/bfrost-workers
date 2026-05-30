# RSS & Feed Digest

An LLM-enhanced BFrost producer worker. Polls RSS and Atom feeds on a schedule, applies AI relevance filtering against your stated interests, and publishes enriched `news.article` items to the Item Bus.

## What it does

1. **Fetches** all configured RSS/Atom feeds every 15 minutes (configurable).
2. **Deduplicates** — each article link is hashed and tracked; the same article is never published twice.
3. **Filters with AI** — when you configure Interests, the worker batches new articles and asks the model to score each one for relevance (1–5). Articles below your threshold are silently dropped.
4. **Enriches summaries** — instead of the raw RSS `<description>` field, items get a clean 1–2 sentence summary written by the model.
5. **Publishes** enriched `news.article` items carrying the LLM-written summary, relevance score, and topic tags.

When no interests are configured (or no model provider is set up), the worker falls back to harvesting everything without LLM processing — same behaviour as v1.x.

## Produces

- `news.article`

Payload shape is backwards-compatible with v1.x. New fields added in v2.0:
- `payload.relevanceScore` — LLM score 1–5 (present only when LLM ran)
- `payload.llmTags` — 1–3 topic keywords assigned by the model

## Settings

| Setting | Default | Description |
|---|---|---|
| `feeds` | _(empty)_ | Newline-separated RSS/Atom feed URLs |
| `interests` | _(empty)_ | Newline-separated interest topics. Leave blank to harvest everything. |
| `relevanceThreshold` | `3` | Score cutoff (1–5). Articles below this score are dropped. |
| `maxItemsPerRun` | `30` | Max articles to LLM-process per run. Extras are deferred. |

Settings are stored under `worker.rss-harvester.config` in the worker KV namespace.

## Job

**`rss-fetch`** — fetches feeds and publishes enriched items. Default schedule: every 15 minutes.

The job prompt is operator-editable from the Jobs panel if you want to tune the LLM's scoring criteria.

## Presets

| Preset | Cron | Max items | Threshold |
|---|---|---|---|
| High-volume intake | `*/15 * * * *` | 100 | 1 |
| Focused digest | `0 * * * *` | 30 | 4 |
| Daily sweep | `0 7 * * *` | 60 | 3 |

## Dashboard

- Feed count and schedule status
- AI filter status (active/off, threshold, topic list)
- Last-run stats: feeds checked, published, AI-filtered count
- Recently published Item Bus items with relevance score in detail view
- Manual run button

## Operational notes

- Deduplication is keyed on a SHA-256 hash of the entry link.
- Filtered (rejected) articles are still marked as seen so they are not re-evaluated on the next run.
- LLM calls are batched (15 articles per call) to stay within context limits.
- If the LLM returns an unparseable response for a batch, that batch is published without filtering and a warning is logged.
- The `/no_think` prefix on prompts suppresses reasoning tokens on models that support it (e.g. Qwen3), keeping output clean JSON.
