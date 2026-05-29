# Markdown Notes Publisher

Markdown Notes Publisher is a BFrost consumer worker. It turns selected Item Bus entries into local `.md` files that work well with Obsidian, Logseq, Joplin import folders, static-site notes, or a plain folder.

## Consumes

- `news.article`
- `research.paper`
- `web.page`
- `webhook.event`
- Any additional item type documented by another worker

The worker records its status in `metadata.markdown-notes-publisher` on each item. It does not change another worker's metadata.

## Job Settings

- `outputDir` - local folder for generated Markdown files. `~/Documents/BFrost Notes` is the default.
- `itemTypes` - Item Bus types to turn into notes. The Jobs panel shows known types as selectable chips.
- `maxItemsPerRun` - maximum notes requested in one run.
- `filenameTemplate` - supports `{date}`, `{type}`, `{slug}`, and `{id}`.
- `frontmatter` - adds YAML metadata for note apps and static-site generators.
- `includeSourceUrl` - includes a source link in the note body.

These are declared as job parameters and are edited from BFrost's Jobs panel.

## Dashboard

The Notes dashboard shows the configured notes folder and the Markdown files already present there. You can:

- Refresh the file list.
- Open a file in formatted preview or raw Markdown view.
- Upload a local `.md` or `.markdown` file into the notes folder.
- Index existing notes for semantic search.
- Search indexed notes by meaning using BFrost's selected embedding provider/model.

Generated and uploaded notes are embedded after the file write is approved. Files that already existed in the folder need the `Index folder` action once before they appear in semantic search.

## Permissions

This worker needs scoped local file-read and file-write permission. BFrost uses the action runtime for file operations: reads are recorded, and writes create approval requests with diff previews before files are created or changed.

## Low-Code Setup

1. Install and enable the worker.
2. Open Jobs, select `Write Markdown notes`, choose a notes folder, and select the item types you want from the suggested chips.
3. Run a producer such as RSS Harvester, News, or arXiv Search.
4. Run `Write Markdown notes`.
5. Approve the file-write action in BFrost's Actions tab.
6. Open Notes to preview files, upload existing notes, or index the folder for semantic search.

## Operational Notes

The job is disabled by default because it writes files. It is best to run it manually at first, then enable the schedule once the folder and filename template look right. Semantic search depends on the embedding model configured in BFrost; if the model is offline, note writing still works, but indexing reports an error.
