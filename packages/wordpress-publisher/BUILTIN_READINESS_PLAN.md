# WordPress Publisher Built-in Readiness Plan

Progress tracker for raising `workers/local/wordpress-publisher` to a professional built-in-quality worker while preserving BFrost's worker-first contract. All feature work should stay inside this worker directory until the final promotion/mirroring step.

## Goals

- Manage WordPress content through the out-of-the-box WordPress REST API.
- Support posts, pages, categories, tags, media, post types, statuses, revisions/previews, and publish workflows where available.
- Let users configure publication status, content type, tone, structure, visual style, and reusable templates.
- Add an operator GUI for reviewing generated drafts, requesting changes, approving publication, and inspecting WordPress state.
- Ship with tests, docs, safe defaults, and migration notes sufficient for built-in worker review.

## Current baseline

- [x] Consumes `news.article` Item Bus items.
- [x] Creates WordPress posts through `/wp-json/wp/v2/<postType>`.
- [x] Supports Application Password auth.
- [x] Caches categories and tags.
- [x] Default WordPress status is `draft`.
- [x] Lets users customize a single prompt.
- [x] Provides a basic dashboard and queue-item detail panel.
- [ ] Does not yet support operator review before creating/updating WordPress content.
- [ ] Does not yet manage pages, media, category/tag creation, revisions, previews, or multiple content templates.
- [ ] Does not yet have professional-grade tests, docs, or built-in packaging review.

## Non-negotiable constraints

- [ ] Do not edit BFrost core to add WordPress features.
- [ ] Keep worker-specific data in `openWorkerKv` / `openWorkerDb` and Item Bus `metadata["wordpress-publisher"]` only.
- [ ] Do not add worker-specific dashboard fields to top-level dashboard payloads.
- [ ] Keep secrets out of `worker.json`; credentials remain settings/env-backed.
- [ ] Prefer safe publishing defaults: generated content starts as `draft` unless the user explicitly chooses otherwise.

## Phase 1 — Product specification and data model

- [x] Define the professional workflow states:
  - `generated`: LLM draft created locally but not sent to WordPress.
  - `needs_changes`: operator requested revision.
  - `approved`: operator approved publication/update.
  - `published_to_wp`: WordPress object created or updated.
  - `failed`: generation or WordPress API call failed.
- [x] Decide local storage layout:
  - KV for global settings and cached capabilities.
  - Worker DB tables for draft records, revision requests, generated versions, WordPress object links, and audit events.
- [x] Define stable draft record fields: source queue item id, content type, title, slug, excerpt, HTML/content blocks, status, categories, tags, featured media id, SEO/meta fields if supported, generation prompt snapshot, operator notes, WordPress id/link/status.
- [ ] Define migration path from existing queue metadata-only behavior to durable draft records.
- [x] Add settings schema versioning so built-in promotion can migrate older local settings safely.

## Phase 2 — WordPress REST client expansion

Use only standard WordPress REST APIs first; plugin-specific APIs can be optional later.

- [x] Add typed client methods for posts:
  - list/get/create/update/delete posts via `/wp/v2/posts`.
  - support `status`, `slug`, `date`, `categories`, `tags`, `featured_media`, `excerpt`, `content`, `author`, `format`, and `_fields`.
- [x] Add typed client methods for pages:
  - list/get/create/update/delete pages via `/wp/v2/pages`.
  - support `status`, `slug`, `parent`, `menu_order`, `template`, `featured_media`, `excerpt`, and `content`.
- [x] Add taxonomy management:
  - list/get/create/update/delete categories via `/wp/v2/categories`.
  - list/get/create/update/delete tags via `/wp/v2/tags`.
  - resolve by slug; optionally create missing terms when enabled.
- [ ] Add media management:
  - [x] list media via `/wp/v2/media`.
  - [x] upload media from URL via `/wp/v2/media` with filename/content type and alt text.
  - [x] set featured image/media on posts/pages.
  - [ ] richer caption/description editing and local file upload.
- [x] Add site capability discovery:
  - `/wp/v2/types`, `/wp/v2/statuses`, `/wp/v2/taxonomies`, `/wp/v2/users/me`, and API root discovery.
  - cache supported post types, statuses, templates, taxonomies, and current user capabilities.
- [ ] Add preview/revision helpers where available:
  - fetch rendered content and links returned by WordPress.
  - list revisions/autosaves if permissions allow.
- [x] Normalize errors into actionable messages for credentials, permissions, invalid status, missing terms, and media upload failures.

## Phase 3 — Configuration UX and defaults

- [ ] Expand worker settings while keeping `defaultStatus = draft`:
  - default content target: post or page.
  - default post status: draft/pending/private/publish/future.
  - default category/tag behavior: fixed terms, LLM-suggested terms, create missing terms, or operator-only.
  - default author if WordPress exposes choices.
  - default featured image behavior: none, upload from source image, or generated placeholder workflow.
- [ ] Add tone controls:
  - [x] brand voice summary.
  - [x] audience/persona.
  - [x] tone preset: factual, expert, friendly, executive, tutorial, SEO-focused, custom.
  - [ ] reading level.
  - [ ] banned phrases/claims.
- [ ] Add look-and-feel controls:
  - [x] content format preset: news brief, long-form article, tutorial, landing page, listicle, FAQ, product update.
  - [ ] heading style and depth.
  - [ ] paragraph length.
  - [ ] callout boxes, bullet density, CTA text, source attribution style.
  - [x] CTA text.
  - allowed HTML tags / block style constraints.
  - optional CSS class wrappers compatible with WordPress themes.
- [ ] Add reusable templates:
  - post template and page template stored as settings/draft templates.
  - variables for title, summary, source URL, source host, categories, CTA, and custom notes.
- [x] Add Content selection settings for source/topic control based on available Item Bus metadata.
- [ ] Separate worker-wide settings from per-run job parameters:
  - global site, credential, default style, default status in Config.
  - one-off source selection, max drafts per run, and generation mode in Jobs if needed.

## Phase 4 — LLM generation pipeline

- [ ] Replace single HTML generation with structured draft generation:
  - [x] JSON output containing title, slug suggestion, excerpt, content HTML, and categories/tags suggestions.
  - [ ] meta summary and rationale.
  - [x] parse and validate with clear raw-output logging on failure.
  - [ ] repair/retry on parse failure.
- [ ] Preserve `/no_think` prefix and avoid explicit `maxOutputTokens` for LMStudio compatibility.
- [ ] Cap source excerpts and include only relevant source fields.
- [x] Add prompt composition from tone/look/template settings.
- [ ] Add content safety checks:
  - no unsupported HTML tags.
  - no invented facts beyond source material.
  - source attribution included when configured.
  - title/excerpt length bounds.
- [ ] Add revision generation:
  - [x] operator enters change request.
  - [x] worker generates a revised draft using original source, current draft, style settings, and requested changes.
  - [x] previous versions remain available.

## Phase 5 — Review and approval GUI

- [ ] Add dashboard sections:
  - [x] setup/capability status.
  - [x] draft inbox grouped by workflow state.
  - [x] WordPress content browser for recent posts/pages.
  - [x] taxonomy/media cache status.
  - [ ] guide/troubleshooting footer.
- [ ] Add draft detail view:
  - source item summary.
  - [x] rendered HTML preview.
  - [x] field-level LLM improvement prompts for title, slug, excerpt, HTML, categories, and tags.
  - [x] editable title, slug, excerpt, content, status, categories, and tags.
  - [x] editable page parent/template and publish date.
  - generated rationale and prompt snapshot.
  - WordPress preview/link once created.
- [ ] Add actions:
  - [x] generate draft.
  - [x] request changes.
  - [x] regenerate draft from requested changes.
  - [x] approve and create WordPress object.
  - [x] update existing WordPress object.
  - [x] save as local draft.
  - [x] discard/archive.
  - [x] refresh WordPress taxonomies/capabilities.
- [ ] Require explicit approval by default before WordPress create/update.
- [ ] Show clear status pills and error recovery actions.
- [ ] Ensure dashboard tolerates missing data and older host helpers with optional chaining/fallbacks.

## Phase 6 — Backend routes and action runtime

- [ ] Add route families under `/api/workers/wordpress-publisher/...`:
  - settings: load/save/test connection.
  - [x] capabilities: refresh/list post types, statuses, taxonomies, templates, users.
  - [ ] drafts: list/get/create/regenerate/update/archive.
  - [x] publish: approve/create/update WordPress object.
  - taxonomies: refresh/create/update/delete where enabled.
  - media: upload/list/set featured media.
- [ ] Validate all request bodies with Zod.
- [ ] Add optimistic locking/version fields for draft edits to prevent overwrites.
- [ ] Record audit events for generation, revision, approval, WordPress create/update/delete, and failures.
- [ ] Keep destructive actions gated and explicit; default to archive/local-only rather than delete remote content.

## Phase 7 — Worker behavior changes

- [ ] Change scheduled job from immediate WordPress creation to draft generation by default.
- [ ] Add an opt-in setting/job mode for auto-create with chosen status for advanced users.
- [ ] Store generation output as a local draft before any WordPress API write.
- [ ] When publishing succeeds, update both draft record and Item Bus metadata.
- [ ] Support pages as first-class targets, not just custom `postType` strings.
- [ ] Support multiple drafts per run only when operator config allows it.

## Phase 8 — Tests

- [ ] Unit tests for settings defaults and migrations.
- [ ] Unit tests for WordPress REST client URL/body construction and error normalization.
- [ ] Unit tests for taxonomy slug resolution and optional term creation.
- [ ] Unit tests for LLM structured-output parsing and invalid-output diagnostics.
- [ ] Unit tests for draft workflow state transitions.
- [ ] Route tests for settings, drafts, revisions, publish, capabilities, and validation failures.
- [ ] Dashboard smoke test if the project has a harness available; otherwise document manual verification steps.
- [ ] Build gate: `npm run build:server` or full `npm run build` depending on touched files.

## Phase 9 — Documentation and operator polish

- [ ] Rewrite README with:
  - setup requirements for Application Passwords.
  - exact WordPress permissions needed.
  - supported WordPress APIs/features.
  - posts vs pages workflow.
  - review/approval workflow.
  - style/tone/template examples.
  - troubleshooting for auth, permissions, REST disabled, invalid SSL, and status restrictions.
- [ ] Add example prompts/templates for common site types.
- [ ] Document safe publishing defaults and how to enable auto-publishing.
- [ ] Add release notes and migration notes from current `1.3.0` behavior.

## Phase 10 — Built-in promotion checklist

Only start this phase after local-worker behavior is stable and reviewed.

- [ ] Run the BFrost worker validator skill against the worker.
- [ ] Confirm no core files contain WordPress-specific references except the eventual built-in worker location if promotion is approved.
- [ ] Decide final built-in id and migration strategy. Avoid changing state namespaces without an explicit migration plan.
- [ ] Mirror code into `src/workers/builtin/...` only after explicit approval for built-in promotion.
- [ ] Convert `worker.json` metadata to built-in manifest/module structure if required by the built-in pattern.
- [ ] Add built-in tests next to the built-in worker files.
- [ ] Run `npm run build` and `npm test`.
- [ ] Verify dashboard route and bundle load in a running BFrost instance.

## Suggested implementation order

1. [x] Add durable draft storage and workflow states.
2. [ ] Expand WordPress client for posts/pages/taxonomies/capabilities.
3. [x] Change scheduled job to generate local drafts by default.
4. [ ] Add review/revision/publish backend routes.
5. [ ] Build the draft review dashboard.
6. [ ] Add tone/look/template settings and structured LLM output.
7. [ ] Add media and richer taxonomy management.
8. [ ] Add tests and docs.
9. [ ] Validate and prepare built-in promotion.

## Progress log

- 2026-06-22: Added worker-owned SQLite draft storage (`drafts`, `draft_events`) with workflow states, settings schema versioning, and durable draft records.
- 2026-06-22: Changed the scheduled job to generate local review drafts by default instead of immediately creating WordPress posts.
- 2026-06-22: Added draft API routes for list/get/edit/request-changes and surfaced recent drafts in dashboard data and the dashboard activity panel.
- 2026-06-22: Verified backend build with `npm run build:server` and local worker/dashboard bundles with `npx esbuild` smoke builds.
- 2026-06-22: Expanded the WordPress REST client for posts/pages, category/tag creation, capability discovery, typed list/get/create/update/delete content helpers, and normalized auth/permission/endpoint errors.
- 2026-06-22: Added capability cache routes and a draft publish route that creates WordPress content only after an explicit dashboard action.
- 2026-06-22: Added a dashboard review panel with HTML preview, request-changes action, and explicit create-in-WordPress action.
- 2026-06-22: Added true LLM draft regeneration from operator change requests using the original source item plus current draft HTML.
- 2026-06-22: Switched generation/regeneration to structured JSON output with title, slug, excerpt, HTML, category suggestions, and tag suggestions; added brand voice, audience, tone preset, content format, and CTA configuration controls.
- 2026-06-22: Added draft version history in worker-owned SQLite storage. Initial generations and regenerated drafts now preserve version snapshots, and draft detail responses include version history.
- 2026-06-22: Added editable draft review fields for title, slug, status, excerpt, categories, tags, HTML body, and operator notes; manual saves create draft version snapshots.
- 2026-06-22: Added archive/discard workflow for drafts, state-filtered draft inbox, archived queue metadata, and archive audit events.
- 2026-06-22: Evolved the dashboard into workspace tabs: Drafts, WordPress Posts, WordPress Pages, and Taxonomies. Added a remote WordPress content browser backed by a worker-owned route for listing posts/pages via the REST API.
- 2026-06-22: Added remote content actions: import an existing WordPress post/page as a local draft, and update a remote post/page from the selected local draft.
- 2026-06-22: Added post/page scheduling and page-specific edit fields: publish date, page parent ID, menu order, and page template. These fields are used when creating or updating WordPress content.
- 2026-06-22: Added Media workspace support: list WordPress media, upload media from an image URL, assign featured media IDs to drafts, and send featured media when creating/updating posts/pages.
- 2026-06-22: Added field-level LLM improvement actions in the draft editor for title, slug, excerpt, HTML body, category slugs, and tag slugs. Each action prompts the operator for targeted instructions and stores a draft version snapshot.
- 2026-06-22: Added grouped WordPress Config sections and Content selection filters for Item Bus news.article items: source host allow/block, RSS feed allowlist, required/excluded tags, minimum relevance score, required/excluded keywords, and approved-only mode.
- 2026-06-22: Started WordPress-like draft editor UX inside the worker dashboard: prominent title/permalink, Visual/HTML body tabs, main editor column, sticky publish/featured image/taxonomy/page/AI sidebar, and safer local-draft-focused actions.

## Open questions

- [ ] Should this worker keep consuming only `news.article`, or should it also accept other item types such as `research.report`, `content.brief`, or operator-created drafts?
- [ ] Should auto-publish ever be allowed by default for built-in users, or always require explicit enablement?
- [ ] Should generated pages support WordPress page templates discovered from the active theme?
- [ ] Should the worker support plugin APIs later, such as Yoast/RankMath SEO metadata, WooCommerce products, or Gutenberg block serialization?
- [ ] Should the final built-in worker preserve id `wordpress-publisher` or adopt a namespaced id such as `core.publisher.wordpress` with migration support?
