# Markdown Notes Publisher

Markdown Notes Publisher is a BFrost consumer worker. It turns selected Item Bus entries into local `.md` files that work well with Obsidian, Logseq, Joplin import folders, static-site notes, or a plain folder.

## Consumes

- `news.article`
- `research.paper`
- Any additional item type you add in the job settings

The worker records its status in `metadata.markdown-notes-publisher` on each item. It does not change another worker's metadata.

## Job Settings

- `outputDir` - local folder for generated Markdown files. `~/Documents/BFrost Notes` is the default.
- `itemTypes` - Item Bus types to turn into notes, one per line.
- `maxItemsPerRun` - maximum notes requested in one run.
- `filenameTemplate` - supports `{date}`, `{type}`, `{slug}`, and `{id}`.
- `frontmatter` - adds YAML metadata for note apps and static-site generators.
- `includeSourceUrl` - includes a source link in the note body.

These are declared as job parameters and are edited from BFrost's Jobs panel.

## Permissions

This worker needs scoped local file-write permission. BFrost uses the action runtime for actual writes: each note write creates an approval request with a diff preview before the file is created.

## Low-Code Setup

1. Install and enable the worker.
2. Open Jobs, select `Write Markdown notes`, choose a notes folder, and keep the default item types unless you know you need more.
3. Run a producer such as RSS Harvester, News, or arXiv Search.
4. Run `Write Markdown notes`.
5. Approve the file-write action in BFrost's Actions tab.

## Operational Notes

The job is disabled by default because it writes files. It is best to run it manually at first, then enable the schedule once the folder and filename template look right.
