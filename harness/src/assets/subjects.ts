import type { DatabaseSync } from 'node:sqlite';

/**
 * One catalog item, whichever index it comes from: a BOOTH product ('booth:<item id>') or a local asset
 * ('local:<asset id>'). Everything the catalog derives is read from what is already stored: a BOOTH product's JSON is
 * in booth_item.metadata_json, so no rule here ever needs the network.
 */
export interface Subject {
  id: string;
  source: 'booth' | 'local';
  ref: string;
  name: string;
  shop: string;
  shopKey: string;
  url: string | null;
  owned: boolean;
  status: string;
  tags: string[];
  images: string[];
  description: string;
  variations: string[];
  /** BOOTH's own category and its parent; '' for local assets. */
  boothCategory: string;
  boothParent: string;
  price: string | null;
  publishedAt: string | null;
  /** The source row's updated_at: a changed row is derived again. */
  updatedAt: string;
  /** When Harness first saw it in the person's library (BOOTH) or registered it (local). */
  acquiredAt: string | null;
  local?: { path: string; kind: string; license: string };
}

export const subjectId = (source: 'booth' | 'local', ref: string): string => `${source}:${ref}`;
export function parseSubjectId(id: string): { source: 'booth' | 'local'; ref: string } | undefined {
  const match = /^(booth|local):(.+)$/.exec(id);
  return match ? { source: match[1] as 'booth' | 'local', ref: match[2]! } : undefined;
}

const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const text = (value: unknown): string => typeof value === 'string' ? value : '';
export function stringList(raw: string): string[] {
  try { const value = JSON.parse(raw) as unknown; return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && item.trim() !== '') : []; }
  catch { return []; }
}

/** The facts a BOOTH product's stored JSON carries beyond the indexed columns. */
export function boothFacts(metadataJson: string, fallbackCategory: string): Pick<Subject, 'boothCategory' | 'boothParent' | 'description' |
  'variations' | 'price' | 'publishedAt' | 'shopKey'> {
  let meta: Record<string, unknown> = {};
  try { meta = object(JSON.parse(metadataJson)); } catch { /* an unreadable document says nothing */ }
  const category = object(meta.category), shop = object(meta.shop);
  const price = typeof meta.price === 'string' ? meta.price : typeof meta.price === 'number' ? `¥ ${meta.price}` : null;
  return { boothCategory: text(category.name) || fallbackCategory, boothParent: text(object(category.parent).name),
    description: text(meta.description), price, publishedAt: text(meta.published_at) || null, shopKey: text(shop.subdomain),
    variations: Array.isArray(meta.variations) ? meta.variations.map(item => text(object(item).name).trim()).filter(Boolean) : [] };
}

export interface BoothRow { item_id: string; name: string; shop_name: string; item_url: string; category: string; owned: number; status: string;
  tags_json: string; images_json: string; metadata_json: string; updated_at: string; indexed_at: string }
export interface LocalRow { id: string; path: string; name: string; kind: string; status: string; license: string; tags_json: string;
  created_at: string; updated_at: string }

export function boothSubject(row: BoothRow): Subject {
  const facts = boothFacts(row.metadata_json, row.category);
  return { id: subjectId('booth', row.item_id), source: 'booth', ref: row.item_id, name: row.name, shop: row.shop_name,
    ...facts, shopKey: facts.shopKey || row.shop_name, url: row.item_url, owned: row.owned === 1, status: row.status,
    tags: stringList(row.tags_json), images: stringList(row.images_json), updatedAt: row.updated_at, acquiredAt: row.indexed_at };
}
export function localSubject(row: LocalRow): Subject {
  return { id: subjectId('local', row.id), source: 'local', ref: row.id, name: row.name, shop: '', shopKey: '', url: null, owned: true,
    status: row.status, tags: stringList(row.tags_json), images: [], description: '', variations: [], boothCategory: '', boothParent: '',
    price: null, publishedAt: null, updatedAt: row.updated_at, acquiredAt: row.created_at,
    local: { path: row.path, kind: row.kind, license: row.license } };
}

const BOOTH_COLUMNS = 'item_id, name, shop_name, item_url, category, owned, status, tags_json, images_json, metadata_json, updated_at, indexed_at';
const LOCAL_COLUMNS = 'id, path, name, kind, status, license, tags_json, created_at, updated_at';
export function boothRows(db: DatabaseSync, itemIds?: string[]): BoothRow[] {
  return (itemIds ? db.prepare(`SELECT ${BOOTH_COLUMNS} FROM booth_item WHERE item_id IN (SELECT value FROM json_each(?))`).all(JSON.stringify(itemIds))
    : db.prepare(`SELECT ${BOOTH_COLUMNS} FROM booth_item`).all()) as unknown as BoothRow[];
}
export function localRows(db: DatabaseSync, ids?: string[]): LocalRow[] {
  return (ids ? db.prepare(`SELECT ${LOCAL_COLUMNS} FROM asset WHERE id IN (SELECT value FROM json_each(?))`).all(JSON.stringify(ids))
    : db.prepare(`SELECT ${LOCAL_COLUMNS} FROM asset`).all()) as unknown as LocalRow[];
}
export function loadSubject(db: DatabaseSync, id: string): Subject | undefined {
  const parsed = parseSubjectId(id);
  if (!parsed) return undefined;
  if (parsed.source === 'booth') { const row = boothRows(db, [parsed.ref])[0]; return row ? boothSubject(row) : undefined; }
  const row = localRows(db, [parsed.ref])[0];
  return row ? localSubject(row) : undefined;
}
