# Web Page Harvester

Web Page Harvester fetches configured pages on a schedule and publishes changed
content as `web.page` items on the BFrost Item Bus.

## What it produces

- `itemType`: `web.page`
- `producerWorkerId`: `web-page-harvester`
- Payload includes the final URL, fetched time, content hash, description, and a
  text excerpt.

## Configure

Open **Jobs** and edit **Fetch web pages**.

- **Page URLs**: one `http` or `https` page per line.
- **Max pages per run**: caps how many URLs are fetched on each run.
- **Minimum hours between checks**: avoids refetching unchanged pages too often.
- **Extra tags**: added to every published item.

## Example

Add a docs changelog, a product updates page, and a competitor page. Run every 6
hours, keep max pages at 5, and set minimum hours between checks to 24.

## Notes

This worker is intentionally simple. It strips HTML and stores a text excerpt; it
does not run browser JavaScript. Use it for static pages, changelogs, docs, and
simple public pages.
