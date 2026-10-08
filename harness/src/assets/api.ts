import type { DatabaseSync } from 'node:sqlite';
import { ApiError } from '../api/protocol.ts';
import { dictionaryView, loadDictionary } from './avatars.ts';
import { facets, itemDetail, listItems, type ItemQuery, type SortKey } from './catalog.ts';
import { assignCategory, decideAvatar, refreshAssetIndex, type AvatarDecision } from './derive.ts';
import { answerReview, reviewList, type ReviewAnswer, type ReviewChoice, type ReviewType } from './review.ts';
import { applyTaxonomy, currentTaxonomy, listProposals, proposeTaxonomy, rejectTaxonomy, taxonomyView, vocabularyContext } from './taxonomy.ts';

/**
 * The `assets.*` methods of the local API (docs/local-api.md): the catalog BOOTH products and local assets share.
 * Reads bring the catalog up to date first, so a view never shows items derived with an older dictionary or vocabulary.
 * The old `asset.*` methods (the local asset registry) and `booth.catalog` keep working unchanged.
 */
export const ASSET_METHODS = ['assets.items', 'assets.facets', 'assets.item', 'assets.category.assign', 'assets.avatar.decide', 'assets.review.list',
  'assets.review.answer', 'assets.taxonomy.get', 'assets.taxonomy.propose', 'assets.taxonomy.apply', 'assets.taxonomy.reject', 'assets.dictionary.get',
  'assets.refresh'] as const;

const bad = (message: string): ApiError => new ApiError('BAD_REQUEST', message);
function text(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim()) throw bad(`参数 ${name} 应为非空字符串`);
  return value;
}
function optionalText(value: unknown, name: string): string | undefined {
  return value === undefined || value === null || value === '' ? undefined : text(value, name);
}
function optionalInt(value: unknown, name: string): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw bad(`参数 ${name} 应为非负整数`);
  return value;
}
function optionalBool(value: unknown, name: string): boolean | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'boolean') throw bad(`参数 ${name} 应为 true 或 false`);
  return value;
}
function oneOf<T extends string>(value: unknown, name: string, allowed: readonly T[]): T | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string' || !allowed.includes(value as T)) throw bad(`参数 ${name} 只能是 ${allowed.join('、')}`);
  return value as T;
}

export function itemQuery(params: Record<string, unknown>): ItemQuery {
  return { category: optionalText(params.category, 'category'), avatar: optionalText(params.avatar, 'avatar'),
    bucket: oneOf(params.bucket, 'bucket', ['unknown', 'universal'] as const), includePending: optionalBool(params.includePending, 'includePending'),
    query: typeof params.query === 'string' ? params.query : undefined, source: oneOf(params.source, 'source', ['booth', 'local'] as const),
    owned: optionalBool(params.owned, 'owned'), sort: oneOf<SortKey>(params.sort, 'sort', ['name', 'listing', 'acquired', 'adaptation']),
    direction: oneOf(params.direction, 'direction', ['asc', 'desc'] as const), limit: optionalInt(params.limit, 'limit'), offset: optionalInt(params.offset, 'offset') };
}
function reviewAnswer(value: unknown, name: string): ReviewAnswer {
  if (!value || typeof value !== 'object') throw bad(`参数 ${name} 应为 {id, choice, target?}`);
  const answer = value as Record<string, unknown>;
  return { id: text(answer.id, `${name}.id`), choice: oneOf<ReviewChoice>(answer.choice, `${name}.choice`, ['accept', 'reject', 'same_as', 'shares_body'])
    ?? (() => { throw bad(`参数 ${name}.choice 不能为空`); })(), ...(optionalText(answer.target, `${name}.target`) ? { target: String(answer.target) } : {}) };
}

function dispatch(db: DatabaseSync, method: string, params: Record<string, unknown>): unknown {
  switch (method) {
    case 'assets.items': refreshAssetIndex(db); return listItems(db, itemQuery(params));
    case 'assets.facets': refreshAssetIndex(db);
      return facets(db, { ...itemQuery(params), top: optionalInt(params.top, 'top'), avatarFilter: optionalText(params.avatarFilter, 'avatarFilter') });
    case 'assets.item': refreshAssetIndex(db); return itemDetail(db, text(params.id, 'id'));
    case 'assets.category.assign': {
      if (!('category' in params)) throw bad('参数 category 应为分类 id、路径，或 null 表示未分类');
      const category = params.category === null ? null : text(params.category, 'category');
      refreshAssetIndex(db);
      return assignCategory(db, text(params.id, 'id'), category);
    }
    case 'assets.avatar.decide': {
      const decision = oneOf<AvatarDecision>(params.decision, 'decision', ['confirm', 'reject', 'add', 'clear']);
      if (!decision) throw bad('参数 decision 不能为空');
      refreshAssetIndex(db);
      decideAvatar(db, text(params.id, 'id'), text(params.avatar, 'avatar'), decision);
      return itemDetail(db, text(params.id, 'id'));
    }
    case 'assets.review.list': refreshAssetIndex(db);
      return reviewList(db, { type: oneOf<ReviewType>(params.type, 'type', ['category', 'avatar', 'dictionary']), limit: optionalInt(params.limit, 'limit'),
        offset: optionalInt(params.offset, 'offset') });
    case 'assets.review.answer': {
      refreshAssetIndex(db);
      if (Array.isArray(params.answers)) return { results: params.answers.map((answer, i) => answerReview(db, reviewAnswer(answer, `answers[${i}]`))) };
      return answerReview(db, reviewAnswer(params, 'params'));
    }
    case 'assets.taxonomy.get': {
      const taxonomy = currentTaxonomy(db), dict = loadDictionary(db);
      return { ...taxonomyView(taxonomy), dictionaryVersion: dict.version, proposals: listProposals(db),
        context: vocabularyContext(taxonomy, dict.version, dict.entries.length) };
    }
    case 'assets.taxonomy.propose':
      return proposeTaxonomy(db, { operations: params.operations, reason: text(params.reason, 'reason'),
        proposedBy: oneOf(params.proposedBy, 'proposedBy', ['ai', 'human'] as const) ?? 'ai' });
    case 'assets.taxonomy.apply': {
      const applied = applyTaxonomy(db, text(params.proposalId, 'proposalId'));
      return { ...applied, refresh: refreshAssetIndex(db) };
    }
    case 'assets.taxonomy.reject': rejectTaxonomy(db, text(params.proposalId, 'proposalId')); return { ok: true };
    case 'assets.dictionary.get': return dictionaryView(loadDictionary(db));
    case 'assets.refresh': return refreshAssetIndex(db, { force: optionalBool(params.all, 'all') ?? false });
    default: throw new ApiError('UNKNOWN_METHOD', `未知方法 ${method}`);
  }
}

/** Run one `assets.*` method; errors carrying a code become API errors with that code. */
export function assetsApi(db: DatabaseSync, method: string, params: Record<string, unknown>): unknown {
  try { return dispatch(db, method, params); }
  catch (error) {
    if (error instanceof ApiError) throw error;
    const code = (error as { code?: string }).code;
    if (code === 'BAD_REQUEST' || code === 'NOT_FOUND' || code === 'STALE' || code === 'CONFLICT') throw new ApiError(code, (error as Error).message);
    throw error;
  }
}
