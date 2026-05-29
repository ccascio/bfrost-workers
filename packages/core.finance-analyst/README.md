# Finance Analyst (`core.finance-analyst`)

Standalone, reinstallable package version of the built-in finance-analyst **consumer**. Subscribes to `finance.news` items and attaches a structured, informational read of likely market impact to each, optionally delivering a digest to your channel.

> **Informational only — not financial advice.** It never tells you to buy, sell, or hold. It characterises a *likely* reaction and mechanism, grounded only in the article text, and is required to express uncertainty (including whether a move is probably already priced in).

## Consumes / writes

- **Consumes:** unhandled `finance.news` items on the Item Bus.
- **Writes:** its read into `metadata['core.finance-analyst']` — it does **not** change item state.

Per-item read: `direction`, `magnitude`, `horizon`, `confidence`, `pricedIn`, `mechanism`, optional `note`, `analyzedAt`.

## Configuration (Jobs panel)

Items per run, investor lens, editable analysis prompt, and a "send the reads to my channel" toggle (uses `notifyOperatorChannels` from the BFrost SDK).

Pairs with the **Finance News** producer (`core.finance-news`), or any producer emitting `finance.news` items with an `articleText`/`snippet` payload. Default cron runs ~20 minutes after the finance-news scan presets.

## Notes

- Reads only the article text the producer stored; it never fetches anything itself.
- Analyses one article at a time (batched into a single model call per run); it does not yet combine multiple articles about the same name into one thesis.
