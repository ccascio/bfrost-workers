# BFrost Store & Platform Roadmap — Path to v1.0

Date: 2026-05-25
Scope: cross-repo (BFrost · BFrost-Website · BFrost-Workers)
Audience priority: **non-developer end users first**, worker authors second.

> This is the strategic, prioritized layer that sits **above** the three detailed
> trackers and sequences the work needed to credibly tag **v1.0** across all three
> repos. It does not duplicate them — each workstream points to the tracker that
> owns the line-item detail:
>
> - **[`BFrost/ROADMAP.md`](../BFrost/ROADMAP.md)** — platform contract, Workstreams 1–7.
> - **[`BFrost/LOWCODE_ROADMAP.md`](../BFrost/LOWCODE_ROADMAP.md)** — non-developer UX, Workstreams A–G.
> - **[`BFrost-Website/ROADMAP.md`](../BFrost-Website/ROADMAP.md)** — registry, API, publishing, Phases 0–4.
>
> The previous contents of this file (the worker-catalog build order) are preserved
> intact in **§7 — The Worker Catalog**. The catalog is good; it simply isn't the
> whole roadmap.

---

## 1. What "v1.0" Means — The Promises

v1.0 is the point where BFrost is honestly recommendable to a non-developer **and**
safe to extend. Every item below must serve one of these promises. If a planned
task serves none of them, it is not v1.0 scope.

1. **Install without a terminal.** A non-developer downloads a signed installer,
   opens it, and lands in a working dashboard — no Node, no `.env`, no `npm`.
2. **Guided setup ends in a real result.** A first-run wizard walks them through a
   model, a channel, and one worker, then runs it so they see output before they
   finish.
3. **Install a community worker safely.** They browse the in-app store, click
   Install, see a **plain-language permission consent dialog backed by an enforced
   runtime**, approve, and the worker runs.
4. **Operate and recover without fear.** Change a schedule, preview the effect,
   undo a mistake, restore from a backup — all from the dashboard.
5. **The contract can't silently drift.** Host, registry, and website share one
   manifest/enum definition; a mismatch fails CI, not production. (This promise
   exists because it broke in production on 2026-05-25 — see §3.)
6. **Authors can publish without hand-editing JSON.** `bfrost pack` + a publish
   path takes a worker folder to a listed, validated, installable entry.
7. **It is observably healthy.** Per-worker success rates, run durations, and last
   failure reasons are visible; the registry poller reports what it ingested.

**Non-goals for v1.0** are unchanged from the existing roadmaps and listed in §9.

---

## 2. Effort Weighting (the "balanced flagship push")

The user delegated the balance; this is the proposed split, made explicit so it
can be pushed back on:

| Bucket | Share | Phases | Rationale |
|---|---:|---|---|
| **Keystone / technical foundation** | ~40% | Phase 1 | Permission runtime + contract integrity unblock promises 3, 5, 6 and every "do a real action safely" worker. Nothing durable ships on a cracked foundation. |
| **Non-developer headline** | ~30% | Phases 2–3 | Wizard, preview/undo, channels, one-click install. This is what makes BFrost *feel* outstanding to the target user. |
| **Ecosystem & authoring** | ~20% | Phase 4 | CLI, self-serve publishing, catalog growth. Feeds the store once the platform is trustworthy. |
| **Quality, docs, launch gates** | ~10% | Ongoing | Tests, a11y, metrics, docs site, demo. The difference between "works for me" and "shippable." |

---

## 3. Current State — Honest Cross-Repo Read

Updated after the Phase 1 close on **2026-05-28**. Phase 1 is declared done: all
three workstreams (1A contract integrity, 1B permission/action runtime, 1C poller
observability) have shipped implementations and CI gates. Phase 2 has also shipped
several operator-facing pieces. What remains for v1.0 is: finishing the App.tsx
decomposition, the CLI packaging path, the installer, and the docs/launch surface.

**What is solid today**
- Worker-first contract holds; core routing goes through the worker registry,
  Item Bus, per-worker storage, local-worker loader, and adapter interfaces.
- Local TypeScript workers compile and run; dashboard bundles are served through
  the host and share the host React runtime.
- BFrost-Workers now contains source-backed community workers plus core catalog
  entries and installable packages for `core.news`, `core.publisher.x`, and
  `core.research`.
- Website registry, D1-backed API, FTS search, author pages, OAuth, advisories,
  admin sync endpoints, and public sync-status UI are live.
- In-app Store installs from bundles; backups, safe mode, factory reset, the
  first-run wizard, undo/discard flows, schedule preview, and Discord channel
  setup are shipped.

**Phase 1 — DONE ✓ (2026-05-28)**
- **1A manifest contract:** `@bfrost/manifest-schema` package created in
  `packages/manifest-schema/`; `generate-enums.js` now writes the package source
  alongside the dist artifacts; `check:manifest` CI gate is live in both BFrost
  and BFrost-Website (BFrost-Website's first CI workflow). The 2026-05-25 class
  of enum drift is permanently gated: a new trust level or permission that isn't
  handled in `App.tsx`/`styles.css` or declared in `src/types.ts` fails CI before
  reaching production. Next hardening step (Phase 2+): wire BFrost and BFrost-Website
  to import from the package via npm dependency rather than local copies.
- **1B permission/action runtime:** BFrost has `ActionRequest`, `ActionApproval`,
  `ActionResult`, the `action_requests` store, an Actions dashboard tab with
  approve/reject/history, permission scopes on `WorkerManifest.permissions`,
  `assertPermission`, file/shell action primitives, audit events, and passing
  action-runtime tests. Install-time permission consent dialog shipped in BFrost
  Store (intercepts Install → shows plain-language permission list → Approve &
  Install). `VITE_TRUST_TIERS_UNLOCKED=true` flipped in BFrost-Website (live once
  Cloudflare Pages env var updated). Deferred: network-domain scopes,
  credential-scope allowlists, and the Playwright/session primitive.
- **1C poller observability:** Website poller failures are no longer silent. The
  API exposes sync status, per-id results, and admin sync state; the Store page
  renders registry/sync health so a bad ingest is visible instead of mysterious.

**Phase 2 progress already landed**
- Per-worker metrics are live in the Health tab via
  `GET /api/dashboard/job-metrics`, with success rate, latency chips, sparklines,
  and last-failure excerpts.
- Guarded SQLite restore/import landed on 2026-05-28: backups are opened
  read-only, checked with `PRAGMA integrity_check`, audited, and copied aside
  before restore.
- Accessibility work has started landing, including dialog semantics and keyboard
  affordances around the Store/worker flows.
- Low-code operator UX is materially better: first-run setup, optional worker
  selection, schedule previews, undo/discard, Store install/update/sideload, and
  Discord notifications are all present.

**What still blocks v1.0**
- Finish deferred action scopes: network domains, credential access, and
  browser/session automation.
- Publish `@bfrost/manifest-schema` to npm and wire BFrost + BFrost-Website to
  depend on it (currently the package exists and `generate-enums.js` writes it;
  the npm dep wiring is a hardening step, not a blocker for Phase 1 close).
- Add the frontend smoke test that proves schema-rendered job forms still render
  and submit after UI changes.
- Continue reducing `App.tsx` and any residual core-resident worker UI under the
  worker-first boundary.
- Ship the packaging path: `bfrost pack`, `bfrost worker install`, install/update
  metadata, and the registry publishing loop needed for Website Phase 3.
- Finish the docs site, tutorials/videos, deep-link install flow, and installer
  polish that make the store usable by non-developers.
- Update Cloudflare Pages env var `VITE_TRUST_TIERS_UNLOCKED=true` and redeploy
  BFrost-Website to make trust-tier badges live in production.

**Current practical critical path**
1. Finish deferred action scopes (network domains, credentials, Playwright) and
   the frontend smoke test — Phase 2 cleanup.
2. Publish `@bfrost/manifest-schema` and wire the npm dep into BFrost + BFrost-Website.
3. Add CLI packaging/install commands and publish the current worker bundles with
   reproducible metadata.
4. Continue `App.tsx` extraction — last core-resident worker UI into worker bundles.
5. Finish docs, deep links, and installer flow once the contract and packaging
   surfaces stop moving.

---

## 4. Phase 1 — Foundation & Contract Integrity ✓ DONE 2026-05-28 *(keystone, ~40%)*

Nothing in Phases 2–4 is durable until this lands. Three workstreams, roughly parallel.
All three workstreams are shipped. See §3 (Current State) for the full status.

### 1A — Single Manifest Contract (`@bfrost/manifest-schema`)

**Why:** prevents the 2026-05-25 class of bug permanently and unblocks Website Phase 1's CI gate.

- Extract `WorkerManifest` + its Zod schema from `BFrost/src/workers/types.ts` and
  `src/admin-api.ts` into a published `@bfrost/manifest-schema` package.
- Make it the **single source of truth** for the `TrustLevel`, `WorkerCategory`,
  and `WorkerPermission` enums. Generate three artifacts from it: TS types, the Zod
  schema, and a **JSON Schema** consumed by `BFrost-Workers/schema.json`, the
  registry CI validator, and the D1 migration that defines `CHECK(trust IN …)`.
- BFrost, BFrost-Website, and the registry CI all depend on the package; a new
  category or trust value is a one-line bump that propagates everywhere.
- **CI gate (BFrost):** adding an enum value without bumping the shared package fails CI.

**Exit criterion (the test that would have caught today's outage):** one
integration test exercises the full chain — *host serializes a manifest → registry
ingests it → website type-checks and renders it → a D1 query returns it.* A drifted
enum fails that test in CI, never in production.

> Detail owners: Website ROADMAP "Schema Source of Truth"; LOWCODE Cross-Repo table (top item).

### 1B — Permission & Action Runtime

**Why:** the keystone for promises 3 and 6 and the unlock for the website's trust
tiers (`VITE_TRUST_TIERS_UNLOCKED`).

Implements **ROADMAP.md Workstream 5** in full:
- `ActionRequest` / `ActionApproval` / `ActionResult` types; an approval queue
  table; a dashboard review surface rendered through the worker UI registry.
- Action classes: `read-only` · `draft` · `approved-write` · `trusted-automation` · `blocked`.
- Per-worker / per-channel / per-agent scopes: filesystem paths, shell allowlist,
  network domains, credential access. **Deny-by-default.**
- Every proposed and executed action audited (`workerId`, actor, inputs, outputs,
  approval state, timestamp).
- Safe primitives workers compose: scoped file read, file-draft (diff preview),
  shell-with-allowlist, inspect/extract browser session.

**Exit criterion:** a worker requests a file write, the user approves a diff in the
dashboard, the action runs, and the result is in the audit log. With this live, the
website flips `VITE_TRUST_TIERS_UNLOCKED=true` and Trusted/Verified/Core badges
become meaningful.

### 1C — Store Sync Hardening & Poller Observability

**Why:** small, cheap, and directly fixes the "is it even deployed?" debugging dance.

- `pollRegistry` logs **per-id upsert success/failure**; a failed row never looks
  like "no change."
- New admin endpoint `GET /v1/admin/sync-status` returns the last poll's per-id
  results, timestamp, and any constraint errors.
- The in-app Store tab and the website surface "last synced N minutes ago" and warn
  if the last sync had failures.
- Backfill: the D1 `trust` `CHECK` and `worker_versions.bundle_url` fixes already
  applied on 2026-05-25 (migration `0002_core_trust.sql`) become part of the
  generated schema in 1A so they can't regress.

**Exit criterion:** a malformed or drifted worker in the registry produces a visible,
attributable error within one poll cycle — never silent.

---

## 5. Phase 2 — Guided Setup & Safe Operation *(non-dev headline, part of ~30%)*

The headline functional leap for the target user. **Decision, stated explicitly:**
ship the **first-run wizard in Phase 2** (no packaging work, and it's the prerequisite
flow the installer reuses); defer the **packaged installer to Phase 3**. Rationale:
the wizard delivers the "guided setup ends in a result" promise immediately and
de-risks the installer by proving the flow in-browser first.

- **First-run wizard** (LOWCODE Workstream A, step flow): welcome → pick provider
  (Local / OpenAI / Anthropic, each with a Test button) → pick channels → pick
  starter workers → collect credentials from manifests → first run triggered live.
  Resumable; re-runnable from the existing "Getting started" checklist.
  - Promotes `core.providers.openai` / `core.providers.anthropic` from the ROADMAP
    wish list to shipped workers, so a user with a ChatGPT/Claude key never needs a
    local model to start.
- **Preview-before-save** (LOWCODE C): schedule, prompt, and source-rule edits show
  "here's what this would have produced on the last run" before Save.
- **Finish App.tsx decomposition** (LOWCODE C / ROADMAP WS1): the last core-resident
  worker UI moves into worker bundles. Hard prerequisite for a clean store/catalog UI.
- **Per-worker metrics in Health** (ROADMAP WS6): success rate, p50/p95 duration,
  last failure reason — feeds promise 7 and the stuck-detector already shipped.

**Exit criterion:** a non-developer goes from a fresh dashboard to a worker that has
run, configured entirely through guided forms, and can preview + undo any change.

---

## 6. Phase 3 — Reach & One-Click Install *(non-dev headline, rest of ~30%)*

Now that the permission runtime (1B) exists, the install-consent loop is real, and
the channels a non-dev actually asks for can ship.

- **Email channel** (`core.channels.email`, LOWCODE B): SMTP-out + IMAP-in, provider
  auto-detect (Gmail/Fastmail/iCloud), test-send + fetch-latest verifiers.
- **WhatsApp channel** (`core.channels.whatsapp`, LOWCODE B): ship Cloud API as the
  documented default; Web bridge behind an "advanced / personal use" toggle. *(See
  §8 open decision.)*
- **One-click install, end-to-end** (Website Phase 4 + LOWCODE D): `bfrost://install`
  deep-link handler (macOS first) → **permission consent dialog backed by 1B** →
  download, verify sha256, extract, enable. The website Install button already fires
  the deep link; this completes the host side.
- **Desktop installer** (LOWCODE Workstream A, packaging): signed `.dmg` / `.exe` /
  AppImage bundling Node + sqlite + ffmpeg, reusing the Phase 2 wizard as first-run.
  *(See §8 open decision: Tauri vs. Electron.)*

**Exit criterion:** a non-developer installs BFrost from a signed installer, completes
the wizard, opens the Store tab, installs a community worker through the consent
dialog, and runs it — no terminal, no filesystem.

---

## 7. Phase 4 — Authoring & Catalog Growth *(ecosystem, ~20%)*

With a trustworthy platform and a real install path, invest in the supply side.

- **`bfrost pack` CLI** (Website Phase 3): validate locally, esbuild-bundle with the
  host's settings, emit `dist/`, tar the folder (no `node_modules`).
- **`bfrost worker install <spec>` CLI** (Website Phase 3): fetch from store, show
  consent, extract, rescan — the terminal equivalent of one-click.
- **Self-serve publishing** end-to-end: `bfrost pack` → `POST /v1/publish` (already
  live) → listed entry. Closes the loop the website's publish page describes.
- **Admin API completeness** (Website Phase 3 / LOWCODE Cross-Repo): rescan +
  uninstall as first-class host operations.

### The Worker Catalog (folded in, intact)

The catalog below is the original build order from the prior version of this file. It
remains the "what to build" plan once the platform is trustworthy. Prioritize the
**Sprint 1–2** families first — they have the least OAuth, the strongest local-first
fit, and the cleanest demo loop, which matches the non-developer-first stance.

**Build order (unchanged):**

- **Sprint 1 — Local Knowledge Intake:** Filesystem Watcher · Web Page Harvester ·
  MarkItDown Document Converter · Markdown Notes Publisher · Email Digest Publisher.
- **Sprint 2 — Research Workbench:** arXiv Search · Semantic Scholar · Crossref DOI
  Resolver · Zotero · YouTube Transcript.
- **Sprint 3 — Collaboration Pack:** GitHub · Slack · Notion · Google Drive · Calendar.
- **Sprint 4 — Publishing Pack:** Ghost · Bluesky · Email Sender/Channel · Slack
  Digest · Buffer.
- **Sprint 5 — Developer Ops Pack:** Sentry · CI Monitor · Release Notes Generator ·
  Code Search · Dependency/CVE Monitor.
- **Sprint 6 — Bridge Pack:** Webhook Inbox · Webhook Sender · Generic REST Poller ·
  MCP Bridge · OpenAPI Bridge.

**Highest value + easiest (ship opportunistically):** Web Page Harvester · Webhook
Inbox · Markdown Notes Publisher · arXiv Search · Crossref DOI Resolver · MarkItDown
Converter · Email Digest Publisher · Bluesky Publisher · ntfy/Apprise · SQLite/DuckDB.

**Bridge workers with multiplicative value:** MCP Bridge, OpenAPI Bridge, Generic
REST Poller, Webhook Inbox, Apprise — each unlocks many integrations without
hand-writing every connector. Build after the catalog has concrete examples and the
permission runtime (1B) can gate them. MCP and browser/Playwright workers are
read-only + allowlist-by-default until 1B is proven.

> The full candidate bank (≈200 connectors across Knowledge, Document AI, Web/Search,
> Productivity, Channels, Publishing, DevOps, Data, Security, Commerce, AI/Retrieval,
> Home/IoT) and the source links are retained in the appendix at the end of this file.

---

## 8. Quality, Docs & Launch Gates *(ongoing, ~10%)*

These run in parallel with Phases 1–4 and must close before tagging v1.0.

- **Frontend smoke test** for the schema-rendered job form (ROADMAP WS6 — last open item there).
- **Accessibility pass** on the dashboard: keyboard nav, focus management, contrast (ROADMAP WS6).
- **Backups + guarded restore/import** including worker-owned tables (ROADMAP WS6;
  daily snapshots already ship per LOWCODE F).
- **Docs site** (Astro/VitePress) generated from `workers/README.md`, manifest
  docstrings, and per-worker READMEs; "For everyone" + "For authors" tiers (ROADMAP WS7, LOWCODE G).
- **Scripted demo** (asciinema/video): install → enable → configure → run → disable → delete.
- **Worker Gallery** page listing built-ins as installable examples (ROADMAP WS7).
- **Website SEO/SSR decision** executed (Astro vs. Vite+SSR) so per-worker pages get
  correct OG cards and indexing (Website open question).

---

## 9. Open Decisions (owed by the project, consolidated)

Pulled from all three roadmaps' open-question sections. These gate work and should be
decided early:

| Decision | Affects | Recommendation |
|---|---|---|
| **Permission strictness default** (1B) | every action worker | Deny-by-default with prompts; read-only is the only no-prompt class. |
| **Worker id namespace** — flat vs. scoped (`@alice/x`) | immutable once first real submission lands | Decide before opening public submissions; flat is simpler now, scoped avoids collisions at scale. |
| **Installer shell** — Tauri vs. Electron | Phase 3 packaging | Tauri (smaller) unless a blocker appears. |
| **WhatsApp path** — Cloud API vs. Web bridge | Phase 3 channel | Cloud API as documented default; Web bridge behind "advanced." |
| **Website rendering** — Astro vs. Vite+SSR | SEO, §8 | Astro for free per-page static generation. |
| **Item Bus subscription** — push vs. pull | future real-time consumers | Pull now (matches scheduler); revisit when a push use case appears. |
| **Registry governance** — who merges PRs | scaling submissions | Define before public submissions or the queue blocks on one person. |
| **Built-in dashboard payload deprecation** — break in 0.x or carry through 1.0 | App.tsx cleanup | Break in 0.x while the audience is small. |

---

## 10. Sequencing Summary

```
Phase 1  ██████████████████  Foundation & Contract Integrity   (keystone, ~40%)
  1A Shared manifest schema + enum source of truth + drift test
  1B Permission & action runtime  →  unlocks trust tiers + install consent
  1C Poller observability + sync hardening

Phase 2  ████████████        Guided Setup & Safe Operation      (non-dev, ~15%)
  First-run wizard · cloud provider workers · preview-before-save
  App.tsx decomposition · per-worker metrics

Phase 3  ████████████        Reach & One-Click Install          (non-dev, ~15%)
  Email + WhatsApp channels · deep-link + consent loop · desktop installer

Phase 4  ████████            Authoring & Catalog Growth         (ecosystem, ~20%)
  bfrost pack / install CLI · self-serve publishing · catalog Sprints 1–6

Ongoing  ████                Quality · a11y · docs site · demo · gallery (~10%)
```

Phase 1 is the only hard gate — 1A and 1B unblock most of what follows. Within
Phase 1, **1A first** (cheap, stops active bleeding), then **1B** (large, keystone),
with **1C** landing alongside 1A.

---

## 11. Out of Scope for v1.0

Unchanged from the existing roadmaps:
- Loading workers from arbitrary remote URLs; anonymous-publisher sandboxing.
- Hosted/cloud BFrost; running workers in the cloud.
- Multi-user / multi-tenant; team-scoped access control (unlisted links are the only privacy mechanism).
- Paid workers or premium listings — the store is free forever.
- A full npm-compatible registry protocol; AST-level security verification.
- Windows/Linux deep-link handling (macOS first).
- Native mobile clients (dashboard stays responsive).

---

## Appendix — Full Worker Candidate Bank & Sources

> Retained verbatim from the prior catalog research. Use as the long-tail backlog;
> group into packs as in §7.

### Scoring legend
- **Value:** 5 = broadly useful, repeated workflows, strong store appeal.
- **Ease:** S = one worker with settings/job/dashboard · M = OAuth, pagination,
  complex payloads · L = broad API coverage, heavy runtime, or security concerns.
- **Fit:** producer · consumer · assistant tool · channel · provider · bridge.

### Phase 0 store-quality assets (make every future worker cheaper)
Complete worker template pack · worker contract validator · QA smoke runner ·
catalog package command · HTTP API worker helper · OAuth callback pattern ·
permission profile docs · dashboard component examples.

### Worker families (candidate bank)
- **Knowledge & Research:** arXiv · Semantic Scholar · Crossref · PubMed/NCBI ·
  Zotero · OpenAlex · Wikipedia/Wikidata · Hacker News · Reddit · YouTube Transcript ·
  Podcast/RSS Transcript · Obsidian · Joplin · Logseq · Readwise.
- **Document AI:** MarkItDown · Docling · Unstructured · Apache Tika · OCR · Table
  Extractor · Invoice/Receipt Extractor · Contract Analyzer · Citation Extractor ·
  Semantic Chunker.
- **Web, Search & Scraping:** Playwright Browser · Firecrawl · Apify · Browserless ·
  Sitemap Crawler · Change Monitor · Brave Search · Tavily/Exa/Kagi · Perplexity ·
  Screenshot Analyzer.
- **Productivity & Collaboration:** Google Sheets · Airtable · Excel/OneDrive ·
  SharePoint · Confluence · Jira · Linear · Trello · Asana · ClickUp · Todoist ·
  Google Tasks · MS To Do · Zoom · Meet/Calendar Brief.
- **Channels & Notifications:** Discord · Slack · Email · Matrix · Signal · WhatsApp ·
  Teams · ntfy · Apprise · Pushover · PagerDuty/Opsgenie.
- **Publishing & Distribution:** Ghost · Medium · LinkedIn · Bluesky · Mastodon ·
  X/Twitter · Reddit · Buffer · Hootsuite/Sprout · Slack Digest · Email Digest · PDF Report.
- **Developer Operations:** GitHub · GitLab · Bitbucket · CI Monitor · Release Notes ·
  Sentry · Datadog · Grafana/Prometheus · New Relic · PostHog · Code Search ·
  Dependency Update Monitor · Docker Registry Monitor.
- **Databases & Data Movement:** SQLite/DuckDB · Postgres · MySQL/MariaDB · MongoDB ·
  Redis · Elasticsearch/OpenSearch · BigQuery · Snowflake · S3/GCS/Azure Blob ·
  CSV/JSON/Parquet Loader · Airbyte Bridge · Meltano/Singer Bridge.
- **Personal Knowledge & Local-First:** Local Folder Inbox · Markdown Notes Publisher ·
  Apple Notes · Apple Reminders · CalDAV/CardDAV · Contacts · Local Clipboard Inbox ·
  Local Screenshot Inbox · Voice Memo Transcriber.
- **Security & OSINT:** NVD/CVE Monitor · GitHub Advisory Monitor · OSV.dev ·
  VirusTotal · Have I Been Pwned · Shodan/Censys · AbuseIPDB · Security Headers/SSL
  Labs · Cloudflare Audit · 1Password/Bitwarden Vault Search.
- **Commerce, Finance & Business Ops:** Stripe · Shopify · WooCommerce · Square ·
  PayPal · QuickBooks · Xero · Plaid · Ramp/Brex · HubSpot · Salesforce · Zendesk · Intercom.
- **AI, Models & Retrieval:** Ollama · OpenRouter · Gemini · Mistral · Groq ·
  Together/Fireworks · Hugging Face Inference · Replicate · Whisper · Deepgram/AssemblyAI ·
  ElevenLabs TTS · Chroma · Qdrant · Weaviate · pgvector · LanceDB/FAISS · Cohere/Jina Reranker.
- **Home, IoT & Automation Bridges:** Home Assistant · MQTT · Node-RED · Matter/Thread ·
  Philips Hue · Shelly · Frigate/NVR · Weather Station.

### Source links
- LangChain integrations: https://docs.langchain.com/oss/python/integrations/providers/
- LangChain document loaders: https://docs.langchain.com/oss/python/integrations/document_loaders
- LlamaIndex data connectors: https://docs.llamaindex.ai/en/stable/module_guides/loading/connector/
- n8n integrations: https://n8n.io/integrations
- Zapier apps: https://help.zapier.com/hc/en-us/categories/8495901804429
- Make integrations: https://www.make.com/en/integrations
- Pipedream apps/docs: https://pipedream.com/docs/apps/
- Model Context Protocol servers: https://github.com/modelcontextprotocol/servers
- Awesome MCP servers: https://github.com/appcypher/awesome-mcp-servers
- Smithery registry API: https://smithery.ai/docs/api-reference/servers/list-all-servers
- Meltano Hub: https://hub.meltano.com/
- Airbyte docs: https://docs.airbyte.com/
- Node-RED library: https://flows.nodered.org/
- Home Assistant integrations: https://www.home-assistant.io/integrations/
- Microsoft MarkItDown: https://github.com/microsoft/markitdown
- Docling: https://www.docling.ai/
- Unstructured: https://docs.unstructured.io/open-source
- Apache Tika: https://tika.apache.org/index.html
- Semantic Scholar API: https://www.semanticscholar.org/product/api
- Crossref REST API: https://support.crossref.org/hc/en-us/articles/214320426-REST-API
- Zotero Web API: https://www.zotero.org/support/dev/web_api/v3/basics
- NCBI APIs: https://www.ncbi.nlm.nih.gov/home/develop/api/
