# Finance News (`core.finance-news`)

Standalone, reinstallable package version of the built-in finance-news **producer**. Searches the web for developments on a watchlist of tickers/companies, optionally has the AI keep only what is materially relevant, publishes `finance.news` items to the Item Bus, and can notify your channel.

> **Informational only — not financial advice.** It surfaces and filters news; it does not give buy/sell calls and is not a trading signal.

## Produces

`finance.news` items. Payload: `tickers`, `category`, `source`, `snippet`, `articleText` (capped ~4k), `relevanceReason`, `producedFor`, `fetchedAt`. A consumer such as **Finance Analyst** (`core.finance-analyst`) can subscribe and annotate each item.

## Credentials (env)

This standalone build reads Google Custom Search credentials directly from the environment:

- `GOOGLE_CSE_API_KEY` — Google Custom Search API key.
- `GOOGLE_CSE_ID` — Custom Search Engine id (cx).

Without both set, searches return nothing. Google Custom Search has a free-tier daily quota; watchlist size × results-per-name × schedule frequency drives usage.

## Configuration (Jobs panel)

Watchlist, news categories (`earnings`, `ratings`, `ma`, `regulatory`, `insider`, `macro`, `dividend`, `product`), investor lens, editable relevance prompt, the AI relevance toggle, channel-notify toggle, and the usual scan knobs (results per name, max items, repeat window, search window).

## Notes

- Channel notification uses `notifyOperatorChannels` from the BFrost SDK (BFrost ≥ the version that exposes it).
- The relevance pass is a *filter + one-line note*. Deeper impact analysis is the job of the `core.finance-analyst` consumer.
- Higher-signal sourcing (SEC EDGAR, company IR RSS) is a future improvement; this version uses Google web search.
