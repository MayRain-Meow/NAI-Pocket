// Note: Public search quota and glossary boundaries are documented in

export const POINTS = Object.freeze({ search: 3, related: 2, artists: 1 });
const DAY_MS = 86_400_000, BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000;
export const beijingDay = timestamp => Math.floor((timestamp + BEIJING_OFFSET_MS) / DAY_MS);

function failure(status, message, extra = {}) {
  return Object.assign(new Error(message), { status }, extra);
}

export function refillQuota(quota, perMinute, now) {
  const day = beijingDay(now);
  return { ...quota,
    bucket: Math.min(perMinute, quota.bucket + Math.max(0, now - quota.at) * perMinute / 60_000),
    at: now, day, used: day !== quota.day ? 0 : quota.used
  };
}

// The host applies refillQuota before this check, including rejected requests.
export function chargeQuotaPoints(quota, type, perMinute, dailyPoints, now) {
  const cost = POINTS[type];
  const wait = ms => Math.max(1, Math.ceil(ms));
  if (quota.cooldownUntil > now) throw failure(429, '公共搜索服务要求稍后再试。', { retryAfterMs: wait(quota.cooldownUntil - now) });
  if (quota.used + cost > dailyPoints) throw failure(429, '今日公共搜索额度已用完，北京时间零点重置。', { retryAfterMs: wait((quota.day + 1) * DAY_MS - BEIJING_OFFSET_MS - now) });
  if (quota.bucket < cost) throw failure(429, '公共搜索额度正在恢复。', { retryAfterMs: wait((cost - quota.bucket) * 60_000 / perMinute) });
  return { ...quota, bucket: quota.bucket - cost, used: quota.used + cost };
}

export function quotaRetryAfterMs(value, now) {
  if (!value) return 60_000;
  const seconds = Number(value);
  const ms = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(value) - now;
  return Number.isFinite(ms) ? Math.min(60 * 60 * 1000, Math.max(1000, Math.ceil(ms))) : 60_000;
}

export const MODE_PRESETS = Object.freeze({
  precise_lookup: { top_k: 20, limit: 10, popularity_weight: 0.15, use_segmentation: false, group_mode: 'off', max_per_group: 2 },
  subject_describe: { top_k: 20, limit: 20, popularity_weight: 0.15, use_segmentation: false, group_mode: 'off', max_per_group: 2 },
  // The upstream web UI uses Top K 80 here, but the public REST schema caps top_k at 50.
  concept_explore: { top_k: 50, limit: 80, popularity_weight: 0.15, use_segmentation: true, group_mode: 'expand', max_per_group: 2 },
  full_scene: { top_k: 5, limit: 80, popularity_weight: 0.15, use_segmentation: true, group_mode: 'diverse', max_per_group: 2 }
});

const ALLOWED_LAYERS = new Set(['英文', '中文扩展词', '释义', '中文核心词', 'artist']);
const ALLOWED_CATEGORIES = new Set(['General', 'Artist', 'Copyright', 'Character', 'Meta']);
const ALLOWED_GROUP_MODES = new Set(['off', 'expand', 'diverse']);

function numberValue(...values) {
  for (const value of values) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

function arrayValue(value) {
  if (Array.isArray(value)) return value;
  if (value == null || value === '') return [];
  return [value];
}

export function normalizeTagResult(item = {}) {
  const tag = String(item.tag ?? item.name ?? item.tag_name ?? item.english ?? item.value ?? '').trim();
  if (!tag) return null;
  return {
    tag,
    cnName: String(item.cn_name ?? item.chinese_name ?? item.cn ?? item.translation ?? item.zh_name ?? item.core_cn ?? '').trim(),
    category: String(item.category ?? item.type ?? item.tag_category ?? '').trim(),
    nsfw: String(item.nsfw ?? '').trim(),
    score: numberValue(item.score, item.final_score, item.similarity, item.relevance, item.npmi),
    semanticScore: numberValue(item.semantic_score),
    postCount: numberValue(item.post_count, item.count, item.frequency, item.posts),
    source: String(item.source ?? '').trim(),
    layer: String(item.layer ?? '').trim(),
    wiki: String(item.wiki ?? item.description ?? item.explanation ?? '').trim(),
    sources: arrayValue(item.sources).map(String)
  };
}

export function normalizeArtistResult(item = {}) {
  const artist = String(item.artist ?? item.name ?? item.tag ?? '').trim();
  if (!artist) return null;
  return {
    artist,
    coocCount: numberValue(item.cooc_count, item.cooccurrence_count, item.count),
    postCount: numberValue(item.post_count, item.posts),
    score: numberValue(item.score, item.npmi, item.relevance),
    sources: arrayValue(item.sources).map(String),
    topTags: arrayValue(item.top_tags).map(tag => {
      if (typeof tag === 'string') return { tag, cnName: '' };
      return normalizeTagResult(tag) || { tag: '', cnName: '' };
    }).filter(tag => tag.tag)
  };
}

function resultsArray(data) {
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.results)) return data.results;
  if (Array.isArray(data?.data?.results)) return data.data.results;
  return [];
}

function sanitizeList(value, allowed, fallback) {
  const items = arrayValue(value).map(item => String(item).trim()).filter(item => allowed.has(item));
  return items.length ? [...new Set(items)] : [...fallback];
}

export function targetLayers(value) {
  return sanitizeList(value, ALLOWED_LAYERS, ['英文', '中文扩展词', '释义', '中文核心词']);
}

export function targetCategories(value, legacyCategory = 'all') {
  if (Array.isArray(value) && value.length) return sanitizeList(value, ALLOWED_CATEGORIES, ['General', 'Character', 'Copyright']);
  const key = String(legacyCategory || 'all').toLowerCase();
  if (key === 'general') return ['General'];
  if (key === 'character') return ['Character'];
  if (key === 'copyright') return ['Copyright'];
  return ['General', 'Character', 'Copyright'];
}

export function groupMode(value, fallback = 'off') {
  const mode = String(value || fallback);
  return ALLOWED_GROUP_MODES.has(mode) ? mode : fallback;
}

export function buildSemanticSearchRequest(input = {}) {
  const query = String(input.query || '').trim().slice(0, 1000);
  if (!query) throw new Error('语义搜索内容不能为空。');
  const mode = MODE_PRESETS[input.mode] ? input.mode : 'subject_describe';
  const preset = MODE_PRESETS[mode];
  const payload = {
    query,
    // Public FastAPI schema: top_k 1..50; result limit 1..500.
    top_k: Math.min(50, Math.max(1, Number(input.topK) || preset.top_k)),
    limit: Math.min(500, Math.max(1, Number(input.limit) || preset.limit)),
    popularity_weight: Math.min(1, Math.max(0, Number(input.popularityWeight ?? preset.popularity_weight))),
    show_nsfw: input.showNsfw !== false,
    use_segmentation: input.useSegmentation ?? preset.use_segmentation,
    target_layers: targetLayers(input.targetLayers),
    target_categories: targetCategories(input.targetCategories, input.category),
    group_mode: groupMode(input.groupMode, preset.group_mode),
    max_per_group: Math.min(50, Math.max(1, Number(input.maxPerGroup) || preset.max_per_group))
  };
  return { query, mode, payload };
}

export function buildRelatedTagsRequest(input = {}) {
  const tags = arrayValue(input.tags).map(value => String(value).trim()).filter(Boolean).slice(0, 200);
  if (!tags.length) throw new Error('至少需要一个已选 Tag。');
  return { tags, limit: Math.min(200, Math.max(1, Number(input.limit) || 50)), show_nsfw: input.showNsfw !== false };
}

export function buildArtistRecommendationsRequest(input = {}) {
  const tags = arrayValue(input.tags).map(value => String(value).trim()).filter(Boolean).slice(0, 200);
  if (!tags.length) throw new Error('至少需要一个已选 Tag。');
  return {
    tags,
    limit: Math.min(100, Math.max(1, Number(input.limit) || 64)),
    min_cooc: Math.min(100, Math.max(1, Number(input.minCooc) || 3)),
    show_nsfw: input.showNsfw !== false
  };
}

export function mapSemanticSearchResponse(data, endpoint, query, mode, payload) {
  return {
    provider: endpoint,
    cached: false,
    query,
    mode,
    request: payload,
    keywords: arrayValue(data?.keywords).map(String),
    prompt: String(data?.prompt ?? data?.tags_all ?? '').trim(),
    results: resultsArray(data).map(normalizeTagResult).filter(Boolean),
    correctionNote: String(data?.correction_note ?? '').trim(),
    corrections: data?.corrections ?? null
  };
}

export function mapRelatedTagsResponse(data, endpoint) {
  return {
    provider: endpoint,
    cached: false,
    results: resultsArray(data).map(normalizeTagResult).filter(Boolean),
    correctionNote: String(data?.correction_note ?? '').trim(),
    corrections: data?.corrections ?? null
  };
}

export function mapArtistRecommendationsResponse(data, endpoint) {
  return { provider: endpoint, cached: false, results: resultsArray(data).map(normalizeArtistResult).filter(Boolean) };
}
