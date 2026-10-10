import {
  POINTS, beijingDay, refillQuota, chargeQuotaPoints, quotaRetryAfterMs,
  normalizeTagResult, normalizeArtistResult, targetLayers, targetCategories, groupMode, MODE_PRESETS,
  buildSemanticSearchRequest, buildRelatedTagsRequest, buildArtistRecommendationsRequest,
  mapSemanticSearchResponse, mapRelatedTagsResponse, mapArtistRecommendationsResponse
} from '../public/danbooru-search-core.js';

// Site-wide point budget for the public service (search/related/artists cost
// 3/2/1 points; the day resets at 00:00 Asia/Shanghai). Shared by both
// endpoints so the mirror is an availability path, never extra quota.

export function createSearchService({ settings, cache, hash, recordPublicTagNames, http = { fetch: (...args) => globalThis.fetch(...args) }, clock = { now: () => Date.now() } }) {
const quota = { bucket: settings.danbooruSearchPointsPerMinute, at: clock.now(), day: beijingDay(clock.now()), used: 0, cooldownUntil: 0, active: 0 };

function failure(status, message, extra = {}) {
  return Object.assign(new Error(message), { status }, extra);
}

function refill(now) {
  Object.assign(quota, refillQuota(quota, settings.danbooruSearchPointsPerMinute, now));
}

function chargePoints(type, now = clock.now()) {
  refill(now);
  Object.assign(quota, chargeQuotaPoints(quota, type, settings.danbooruSearchPointsPerMinute, settings.danbooruSearchDailyPoints, now));
}

function danbooruSearchStatus() {
  refill(clock.now());
  return { credentialed: Boolean(settings.danbooruSearchApiKey), pointsPerMinute: settings.danbooruSearchPointsPerMinute, availablePoints: Math.floor(quota.bucket),
    dailyPoints: settings.danbooruSearchDailyPoints, dailyUsed: quota.used, cooldownMs: Math.max(0, quota.cooldownUntil - clock.now()), active: quota.active };
}

async function stableKey(type, payload) { return hash(new TextEncoder().encode(type + ':' + JSON.stringify(payload))); }
async function readCache(key) {
 const row = await cache.get(key); if (!row) return null;
 if (Number(row.expires_at) <= clock.now()) { await cache.remove(key); return null; }
 try { return JSON.parse(row.response_json); } catch { return null; }
}
async function writeCache(key, type, value, ttlMs) { const now = clock.now(); await cache.write(key, type, JSON.stringify(value), now + ttlMs, now); }

async function fetchJson(baseUrl, path, payload, signal) {
  const url = `${String(baseUrl).replace(/\/$/, '')}${path}`;
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, settings.danbooruSearchTimeoutMs);
  // A disconnected browser request releases the upstream call.
  const cancel = () => controller.abort();
  signal?.addEventListener('abort', cancel, { once: true });
  const credentialed = Boolean(settings.danbooruSearchApiKey) && baseUrl === settings.danbooruSearchUrl;
  try {
    const response = await http.fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json', Accept: 'application/json',
        ...(credentialed ? { Authorization: `Bearer ${settings.danbooruSearchApiKey}`, 'X-DanbooruSearch-Client': settings.danbooruSearchClient,
          ...(settings.danbooruSearchSite ? { 'X-DanbooruSearch-Site': settings.danbooruSearchSite } : {}) } : {})
      },
      body: JSON.stringify(payload),
      signal: controller.signal
    });
    if (response.status === 429) {
      const wait = quotaRetryAfterMs(response.headers?.get?.('retry-after'), clock.now());
      quota.cooldownUntil = Math.max(quota.cooldownUntil, clock.now() + wait);
      throw failure(429, '公共搜索服务额度已满，请稍后再试。', { retryAfterMs: wait, final: true });
    }
    // 502, not 401: an upstream refusal must not open this app's login page.
    if (response.status === 401 || response.status === 403) throw failure(502, `公共搜索服务拒绝了${credentialed ? '登记的 API Key' : '匿名调用'}（HTTP ${response.status}）。`, { final: true });
    const text = await response.text();
    let data;
    try { data = text ? JSON.parse(text) : {}; } catch { data = { error: text.slice(0, 1000) }; }
    if (!response.ok) {
      const error = new Error(`DanbooruSearch ${response.status}: ${data?.detail || data?.error || response.statusText}`);
      error.status = response.status;
      throw error;
    }
    return data;
  } catch (error) {
    if (error.name === 'AbortError' && !timedOut) throw failure(499, '搜索已取消。', { final: true });
    if (error.name === 'AbortError') throw new Error(`DanbooruSearch 请求超时（${Math.round(settings.danbooruSearchTimeoutMs / 1000)} 秒）。Space 可能正在冷启动。`);
    throw error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', cancel);
  }
}

async function requestWithFallback(path, payload, signal) {
  if (!settings.danbooruSearchEnabled) throw new Error('DanbooruSearch 已在服务器配置中关闭。');
  const endpoints = [settings.danbooruSearchUrl, settings.danbooruSearchFallbackUrl].filter(Boolean);
  if (signal?.aborted) throw failure(499, '搜索已取消。');
  // The public service allows one concurrent call per caller.
  if (quota.active >= 1) throw failure(429, '上一项公共搜索尚未结束，请稍后重试。', { retryAfterMs: 1000 });
  chargePoints(path.split('/').at(-1));
  quota.active++;
  try {
    let lastError;
    for (const endpoint of endpoints) {
      try {
        const data = await fetchJson(endpoint, path, payload, signal);
        return { data, endpoint };
      } catch (error) {
        lastError = error;
        // Quota, credential and cancellation outcomes are never retried on the mirror.
        if (error.final) throw error;
      }
    }
    throw lastError || new Error('DanbooruSearch 服务不可用。');
  } finally {
    quota.active--;
  }
}

async function capture(results) {
  try { await recordPublicTagNames(results); } catch { /* The glossary is best effort and never fails a search. */ }
}

async function semanticSearch(input = {}, { signal } = {}) {
  const { query, mode, payload } = buildSemanticSearchRequest(input);
  const cacheKey = await stableKey('search', payload);
  const cached = await readCache(cacheKey);
  if (cached) { await capture(cached.results); return { ...cached, cached: true }; }
  const { data, endpoint } = await requestWithFallback('/api/search', payload, signal);
  const value = mapSemanticSearchResponse(data, endpoint, query, mode, payload);
  await writeCache(cacheKey, 'search', value, settings.danbooruSearchCacheMs);
  await capture(value.results);
  return value;
}

async function relatedTags(input = {}, { signal } = {}) {
  const payload = buildRelatedTagsRequest(input);
  const cacheKey = await stableKey('related', payload);
  const cached = await readCache(cacheKey);
  if (cached) { await capture(cached.results); return { ...cached, cached: true }; }
  const { data, endpoint } = await requestWithFallback('/api/related', payload, signal);
  const value = mapRelatedTagsResponse(data, endpoint);
  await writeCache(cacheKey, 'related', value, Math.min(settings.danbooruSearchCacheMs, 3 * 60 * 60 * 1000));
  await capture(value.results);
  return value;
}

async function artistRecommendations(input = {}, { signal } = {}) {
  const payload = buildArtistRecommendationsRequest(input);
  const cacheKey = await stableKey('artists', payload);
  const cached = await readCache(cacheKey);
  if (cached) return { ...cached, cached: true };
  const { data, endpoint } = await requestWithFallback('/api/artists', payload, signal);
  const value = mapArtistRecommendationsResponse(data, endpoint);
  await writeCache(cacheKey, 'artists', value, settings.danbooruSearchCacheMs);
  await capture(value.results.flatMap(item => item.topTags));
  return value;
}

const __test = { normalizeTagResult, normalizeArtistResult, targetLayers, targetCategories, groupMode, MODE_PRESETS, quota, POINTS };

return { danbooruSearchStatus, semanticSearch, relatedTags, artistRecommendations, __test };
}
