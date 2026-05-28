# Crossref DOI Resolver

Crossref DOI Resolver is a BFrost assistant-tool worker. It lets the assistant resolve a DOI or search publication titles through Crossref and return structured metadata.

## Tools

- `resolveCrossrefWork`

Inputs:

- `mode` - `doi` or `title`
- `query` - DOI, DOI URL, or title search text
- `rows` - number of title-search results, 1-10

The tool returns JSON with DOI, title, authors, venue/container title, year, type, publisher, source URL, and Crossref score when available.

## Settings

- `contactEmail` - optional email address passed to Crossref's `mailto` parameter. Crossref recommends this for API etiquette and reliability.

## Low-Code Setup

1. Install and enable the worker.
2. Optionally add a contact email in Config.
3. Ask BFrost to look up a DOI or find metadata for a paper title.

Example: "Use Crossref to resolve DOI 10.1145/3368089.3409749."

## Operational Notes

This worker uses the public Crossref REST API over HTTPS and stores only recent lookup history in its private KV namespace.
