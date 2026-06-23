import { randomUUID } from 'node:crypto';
import { openWorkerDb, type WorkerTableHandle } from 'bfrost';
import { WORKER_ID, type WpPostStatus } from './settings.js';

export const DRAFT_SCHEMA_VERSION = 1;

export const DRAFT_STATES = ['generated', 'needs_changes', 'approved', 'published_to_wp', 'failed', 'archived'] as const;
export type DraftState = typeof DRAFT_STATES[number];

export const CONTENT_TYPES = ['post', 'page'] as const;
export type WpContentType = typeof CONTENT_TYPES[number];

interface DraftRow extends Record<string, unknown> {
  id: string;
  schema_version: number;
  source_item_id: string;
  source_item_type: string;
  state: DraftState;
  content_type: WpContentType;
  title: string;
  slug: string;
  excerpt: string;
  content_html: string;
  target_status: WpPostStatus;
  publish_date: string;
  page_parent: number | null;
  page_menu_order: number | null;
  page_template: string;
  featured_media_id: number | null;
  category_slugs_json: string;
  tag_slugs_json: string;
  prompt_snapshot: string;
  operator_notes: string;
  change_request: string;
  wp_id: number | null;
  wp_link: string;
  wp_status: string;
  error_message: string;
  created_at: string;
  updated_at: string;
  published_at: string | null;
}

interface DraftEventRow extends Record<string, unknown> {
  id: string;
  draft_id: string;
  event_type: string;
  message: string;
  metadata_json: string;
  created_at: string;
}

interface DraftVersionRow extends Record<string, unknown> {
  id: string;
  draft_id: string;
  version_number: number;
  title: string;
  slug: string;
  excerpt: string;
  content_html: string;
  publish_date: string;
  page_parent: number | null;
  page_menu_order: number | null;
  page_template: string;
  featured_media_id: number | null;
  category_slugs_json: string;
  tag_slugs_json: string;
  change_request: string;
  created_at: string;
}

export interface WordPressDraft {
  id: string;
  schemaVersion: number;
  sourceItemId: string;
  sourceItemType: string;
  state: DraftState;
  contentType: WpContentType;
  title: string;
  slug: string;
  excerpt: string;
  contentHtml: string;
  targetStatus: WpPostStatus;
  publishDate: string;
  pageParent: number | null;
  pageMenuOrder: number | null;
  pageTemplate: string;
  featuredMediaId: number | null;
  categorySlugs: string[];
  tagSlugs: string[];
  promptSnapshot: string;
  operatorNotes: string;
  changeRequest: string;
  wpId: number | null;
  wpLink: string;
  wpStatus: string;
  errorMessage: string;
  createdAt: string;
  updatedAt: string;
  publishedAt: string | null;
  versionCount?: number;
}

export interface DraftCreateInput {
  sourceItemId: string;
  sourceItemType: string;
  contentType: WpContentType;
  title: string;
  slug?: string;
  excerpt?: string;
  contentHtml: string;
  targetStatus: WpPostStatus;
  publishDate?: string;
  pageParent?: number | null;
  pageMenuOrder?: number | null;
  pageTemplate?: string;
  featuredMediaId?: number | null;
  categorySlugs?: string[];
  tagSlugs?: string[];
  promptSnapshot: string;
}

export interface WordPressDraftVersion {
  id: string;
  draftId: string;
  versionNumber: number;
  title: string;
  slug: string;
  excerpt: string;
  contentHtml: string;
  publishDate: string;
  pageParent: number | null;
  pageMenuOrder: number | null;
  pageTemplate: string;
  featuredMediaId: number | null;
  categorySlugs: string[];
  tagSlugs: string[];
  changeRequest: string;
  createdAt: string;
}

export interface DraftPatchInput {
  state?: DraftState;
  contentType?: WpContentType;
  title?: string;
  slug?: string;
  excerpt?: string;
  contentHtml?: string;
  targetStatus?: WpPostStatus;
  publishDate?: string;
  pageParent?: number | null;
  pageMenuOrder?: number | null;
  pageTemplate?: string;
  featuredMediaId?: number | null;
  categorySlugs?: string[];
  tagSlugs?: string[];
  operatorNotes?: string;
  changeRequest?: string;
  wpId?: number | null;
  wpLink?: string;
  wpStatus?: string;
  errorMessage?: string;
  publishedAt?: string | null;
}

interface DraftTables {
  drafts: WorkerTableHandle<DraftRow>;
  events: WorkerTableHandle<DraftEventRow>;
  versions: WorkerTableHandle<DraftVersionRow>;
}

let tablesPromise: Promise<DraftTables> | null = null;

function nowIso(): string {
  return new Date().toISOString();
}

function jsonArray(value: string): string[] {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === 'string') : [];
  } catch {
    return [];
  }
}

function toRow(draft: WordPressDraft): DraftRow {
  return {
    id: draft.id,
    schema_version: draft.schemaVersion,
    source_item_id: draft.sourceItemId,
    source_item_type: draft.sourceItemType,
    state: draft.state,
    content_type: draft.contentType,
    title: draft.title,
    slug: draft.slug,
    excerpt: draft.excerpt,
    content_html: draft.contentHtml,
    target_status: draft.targetStatus,
    publish_date: draft.publishDate,
    page_parent: draft.pageParent,
    page_menu_order: draft.pageMenuOrder,
    page_template: draft.pageTemplate,
    featured_media_id: draft.featuredMediaId,
    category_slugs_json: JSON.stringify(draft.categorySlugs),
    tag_slugs_json: JSON.stringify(draft.tagSlugs),
    prompt_snapshot: draft.promptSnapshot,
    operator_notes: draft.operatorNotes,
    change_request: draft.changeRequest,
    wp_id: draft.wpId,
    wp_link: draft.wpLink,
    wp_status: draft.wpStatus,
    error_message: draft.errorMessage,
    created_at: draft.createdAt,
    updated_at: draft.updatedAt,
    published_at: draft.publishedAt,
  };
}

function fromRow(row: DraftRow): WordPressDraft {
  return {
    id: row.id,
    schemaVersion: row.schema_version,
    sourceItemId: row.source_item_id,
    sourceItemType: row.source_item_type,
    state: row.state,
    contentType: row.content_type,
    title: row.title,
    slug: row.slug,
    excerpt: row.excerpt,
    contentHtml: row.content_html,
    targetStatus: row.target_status,
    publishDate: row.publish_date,
    pageParent: row.page_parent,
    pageMenuOrder: row.page_menu_order,
    pageTemplate: row.page_template,
    featuredMediaId: row.featured_media_id,
    categorySlugs: jsonArray(row.category_slugs_json),
    tagSlugs: jsonArray(row.tag_slugs_json),
    promptSnapshot: row.prompt_snapshot,
    operatorNotes: row.operator_notes,
    changeRequest: row.change_request,
    wpId: row.wp_id,
    wpLink: row.wp_link,
    wpStatus: row.wp_status,
    errorMessage: row.error_message,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    publishedAt: row.published_at,
  };
}

function fromVersionRow(row: DraftVersionRow): WordPressDraftVersion {
  return {
    id: row.id,
    draftId: row.draft_id,
    versionNumber: row.version_number,
    title: row.title,
    slug: row.slug,
    excerpt: row.excerpt,
    contentHtml: row.content_html,
    publishDate: row.publish_date,
    pageParent: row.page_parent,
    pageMenuOrder: row.page_menu_order,
    pageTemplate: row.page_template,
    featuredMediaId: row.featured_media_id,
    categorySlugs: jsonArray(row.category_slugs_json),
    tagSlugs: jsonArray(row.tag_slugs_json),
    changeRequest: row.change_request,
    createdAt: row.created_at,
  };
}

async function getTables(): Promise<DraftTables> {
  if (!tablesPromise) {
    tablesPromise = (async () => {
      const db = await openWorkerDb(WORKER_ID);
      const drafts = await db.defineTable<DraftRow>('drafts', {
        columns: [
          { name: 'id', type: 'TEXT', primaryKey: true },
          { name: 'schema_version', type: 'INTEGER', notNull: true, default: DRAFT_SCHEMA_VERSION },
          { name: 'source_item_id', type: 'TEXT', notNull: true },
          { name: 'source_item_type', type: 'TEXT', notNull: true, default: '' },
          { name: 'state', type: 'TEXT', notNull: true, default: 'generated' },
          { name: 'content_type', type: 'TEXT', notNull: true, default: 'post' },
          { name: 'title', type: 'TEXT', notNull: true, default: '' },
          { name: 'slug', type: 'TEXT', notNull: true, default: '' },
          { name: 'excerpt', type: 'TEXT', notNull: true, default: '' },
          { name: 'content_html', type: 'TEXT', notNull: true, default: '' },
          { name: 'target_status', type: 'TEXT', notNull: true, default: 'draft' },
          { name: 'publish_date', type: 'TEXT', notNull: true, default: '' },
          { name: 'page_parent', type: 'INTEGER' },
          { name: 'page_menu_order', type: 'INTEGER' },
          { name: 'page_template', type: 'TEXT', notNull: true, default: '' },
          { name: 'featured_media_id', type: 'INTEGER' },
          { name: 'category_slugs_json', type: 'TEXT', notNull: true, default: '[]' },
          { name: 'tag_slugs_json', type: 'TEXT', notNull: true, default: '[]' },
          { name: 'prompt_snapshot', type: 'TEXT', notNull: true, default: '' },
          { name: 'operator_notes', type: 'TEXT', notNull: true, default: '' },
          { name: 'change_request', type: 'TEXT', notNull: true, default: '' },
          { name: 'wp_id', type: 'INTEGER' },
          { name: 'wp_link', type: 'TEXT', notNull: true, default: '' },
          { name: 'wp_status', type: 'TEXT', notNull: true, default: '' },
          { name: 'error_message', type: 'TEXT', notNull: true, default: '' },
          { name: 'created_at', type: 'TEXT', notNull: true },
          { name: 'updated_at', type: 'TEXT', notNull: true },
          { name: 'published_at', type: 'TEXT' },
        ],
        indexes: [
          { name: 'state_updated', columns: ['state', 'updated_at'] },
          { name: 'source_item', columns: ['source_item_id'] },
          { name: 'wp_id', columns: ['wp_id'] },
        ],
      });
      const events = await db.defineTable<DraftEventRow>('draft_events', {
        columns: [
          { name: 'id', type: 'TEXT', primaryKey: true },
          { name: 'draft_id', type: 'TEXT', notNull: true },
          { name: 'event_type', type: 'TEXT', notNull: true },
          { name: 'message', type: 'TEXT', notNull: true, default: '' },
          { name: 'metadata_json', type: 'TEXT', notNull: true, default: '{}' },
          { name: 'created_at', type: 'TEXT', notNull: true },
        ],
        indexes: [{ name: 'draft_created', columns: ['draft_id', 'created_at'] }],
      });
      const versions = await db.defineTable<DraftVersionRow>('draft_versions', {
        columns: [
          { name: 'id', type: 'TEXT', primaryKey: true },
          { name: 'draft_id', type: 'TEXT', notNull: true },
          { name: 'version_number', type: 'INTEGER', notNull: true },
          { name: 'title', type: 'TEXT', notNull: true, default: '' },
          { name: 'slug', type: 'TEXT', notNull: true, default: '' },
          { name: 'excerpt', type: 'TEXT', notNull: true, default: '' },
          { name: 'content_html', type: 'TEXT', notNull: true, default: '' },
          { name: 'publish_date', type: 'TEXT', notNull: true, default: '' },
          { name: 'page_parent', type: 'INTEGER' },
          { name: 'page_menu_order', type: 'INTEGER' },
          { name: 'page_template', type: 'TEXT', notNull: true, default: '' },
          { name: 'featured_media_id', type: 'INTEGER' },
          { name: 'category_slugs_json', type: 'TEXT', notNull: true, default: '[]' },
          { name: 'tag_slugs_json', type: 'TEXT', notNull: true, default: '[]' },
          { name: 'change_request', type: 'TEXT', notNull: true, default: '' },
          { name: 'created_at', type: 'TEXT', notNull: true },
        ],
        indexes: [
          { name: 'draft_version', columns: ['draft_id', 'version_number'], unique: true },
          { name: 'draft_created', columns: ['draft_id', 'created_at'] },
        ],
      });
      return { drafts, events, versions };
    })();
  }
  return tablesPromise;
}

export async function ensureDraftStorage(): Promise<void> {
  await getTables();
}

export async function createDraft(input: DraftCreateInput): Promise<WordPressDraft> {
  const tables = await getTables();
  const stamp = nowIso();
  const draft: WordPressDraft = {
    id: randomUUID(),
    schemaVersion: DRAFT_SCHEMA_VERSION,
    sourceItemId: input.sourceItemId,
    sourceItemType: input.sourceItemType,
    state: 'generated',
    contentType: input.contentType,
    title: input.title,
    slug: input.slug ?? '',
    excerpt: input.excerpt ?? '',
    contentHtml: input.contentHtml,
    targetStatus: input.targetStatus,
    publishDate: input.publishDate ?? '',
    pageParent: input.pageParent ?? null,
    pageMenuOrder: input.pageMenuOrder ?? null,
    pageTemplate: input.pageTemplate ?? '',
    featuredMediaId: input.featuredMediaId ?? null,
    categorySlugs: input.categorySlugs ?? [],
    tagSlugs: input.tagSlugs ?? [],
    promptSnapshot: input.promptSnapshot,
    operatorNotes: '',
    changeRequest: '',
    wpId: null,
    wpLink: '',
    wpStatus: '',
    errorMessage: '',
    createdAt: stamp,
    updatedAt: stamp,
    publishedAt: null,
  };
  tables.drafts.insert(toRow(draft));
  await recordDraftVersion(draft, 'Initial generated draft.');
  await recordDraftEvent(draft.id, 'generated', 'Draft generated locally and queued for review.');
  return draft;
}

export async function listDrafts(limit = 50, state?: DraftState, offset = 0): Promise<WordPressDraft[]> {
  const tables = await getTables();
  const cappedLimit = Math.max(1, Math.min(100, Math.floor(limit)));
  const cappedOffset = Math.max(0, Math.floor(offset));
  const rows = tables.drafts.findAll({
    where: state ? { state } as Partial<DraftRow> : undefined,
    orderBy: 'updated_at DESC',
    limit: cappedLimit,
    offset: cappedOffset,
  });
  return rows.map((row) => {
    const draft = fromRow(row);
    draft.versionCount = tables.versions.count({ draft_id: draft.id });
    return draft;
  });
}

export async function getDraft(id: string): Promise<WordPressDraft | null> {
  const tables = await getTables();
  const row = tables.drafts.findOne({ id });
  if (!row) return null;
  const draft = fromRow(row);
  draft.versionCount = tables.versions.count({ draft_id: draft.id });
  return draft;
}

export async function updateDraft(id: string, patch: DraftPatchInput): Promise<WordPressDraft> {
  const existing = await getDraft(id);
  if (!existing) throw new Error(`WordPress draft not found: ${id}`);
  const next: WordPressDraft = {
    ...existing,
    ...patch,
    categorySlugs: patch.categorySlugs ?? existing.categorySlugs,
    tagSlugs: patch.tagSlugs ?? existing.tagSlugs,
    updatedAt: nowIso(),
  };
  const tables = await getTables();
  tables.drafts.update({ id }, toRow(next));
  if (patch.state && patch.state !== existing.state) {
    await recordDraftEvent(id, patch.state, `Draft state changed from ${existing.state} to ${patch.state}.`);
  }
  return next;
}

export async function recordDraftVersion(draft: WordPressDraft, changeRequest = ''): Promise<WordPressDraftVersion> {
  const tables = await getTables();
  const versionNumber = tables.versions.count({ draft_id: draft.id }) + 1;
  const row: DraftVersionRow = {
    id: randomUUID(),
    draft_id: draft.id,
    version_number: versionNumber,
    title: draft.title,
    slug: draft.slug,
    excerpt: draft.excerpt,
    content_html: draft.contentHtml,
    publish_date: draft.publishDate,
    page_parent: draft.pageParent,
    page_menu_order: draft.pageMenuOrder,
    page_template: draft.pageTemplate,
    featured_media_id: draft.featuredMediaId,
    category_slugs_json: JSON.stringify(draft.categorySlugs),
    tag_slugs_json: JSON.stringify(draft.tagSlugs),
    change_request: changeRequest,
    created_at: nowIso(),
  };
  tables.versions.insert(row);
  return fromVersionRow(row);
}

export async function listDraftVersions(draftId: string): Promise<WordPressDraftVersion[]> {
  const tables = await getTables();
  return tables.versions
    .findAll({ where: { draft_id: draftId }, orderBy: 'version_number DESC', limit: 50 })
    .map(fromVersionRow);
}

export async function recordDraftEvent(
  draftId: string,
  eventType: string,
  message: string,
  metadata: Record<string, unknown> = {},
): Promise<void> {
  const tables = await getTables();
  tables.events.insert({
    id: randomUUID(),
    draft_id: draftId,
    event_type: eventType,
    message,
    metadata_json: JSON.stringify(metadata),
    created_at: nowIso(),
  });
}

export async function listDraftEvents(draftId: string): Promise<Array<{ eventType: string; message: string; metadata: Record<string, unknown>; createdAt: string }>> {
  const tables = await getTables();
  return tables.events.findAll({ where: { draft_id: draftId }, orderBy: 'created_at DESC', limit: 50 }).map((row) => {
    let metadata: Record<string, unknown> = {};
    try {
      const parsed = JSON.parse(row.metadata_json);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) metadata = parsed as Record<string, unknown>;
    } catch {
      metadata = {};
    }
    return { eventType: row.event_type, message: row.message, metadata, createdAt: row.created_at };
  });
}
