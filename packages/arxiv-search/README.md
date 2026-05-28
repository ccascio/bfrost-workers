# arXiv Search

arXiv Search is a BFrost producer worker. It runs a saved arXiv query and publishes new matching papers as `research.paper` items on the Item Bus.

## Produces

- `research.paper`

Each item includes `payload.title`, `payload.abstract`, `payload.authors`, `payload.categories`, `payload.publishedAt`, `payload.updatedAt`, `payload.paperId`, and `payload.pdfUrl`.

## Job Settings

- `query` - arXiv search query. Examples: `cat:cs.AI`, `cat:cs.CL OR all:"agents"`, `au:"Goodfellow"`.
- `maxResults` - maximum papers fetched per run.
- `sortBy` - newest submitted, recently updated, or relevance.
- `includeCategories` - optional category allowlist, one per line.

These are declared as job parameters and are edited from BFrost's Jobs panel.

## Low-Code Setup

1. Install and enable the worker.
2. Open Jobs, select `Fetch arXiv papers`, and adjust the query if needed. The default follows AI and computational linguistics papers.
3. Click Run now in the arXiv worker dashboard.
4. Open the Item Bus or the Markdown Notes worker to use the published papers.

## Operational Notes

The worker deduplicates by arXiv entry URL in its private KV store. It uses only the public arXiv API and does not require credentials.
