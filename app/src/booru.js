import { Buffer } from 'buffer';
import { BOORU_CATEGORIES, BOORU_DEFAULTS, booruRules, matchesBooruRule } from '../../public/booru-core.js';

const ORIGIN = 'https://danbooru.donmai.us';
const MEDIA_HOSTS = new Set(['cdn.donmai.us', 'danbooru.donmai.us']);
const RATINGS = ['g', 's', 'q', 'e'];
const PAGE_SIZE = 40;
const MAX_IMAGE_BYTES = 32 * 1024 ** 2;
const fail = (status, message) => Object.assign(new Error(message), { status });
const integer = (value, fallback, low, high) => Number.isFinite(Number(value)) ? Math.max(low, Math.min(high, Math.floor(Number(value)))) : fallback;
export function booruMediaUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || !MEDIA_HOSTS.has(url.hostname) || url.port || url.username || url.password || url.search || url.hash) return '';
    if (!/\.(png|jpe?g|webp|gif|avif)$/i.test(url.pathname)) return '';
    return url.href;
  } catch { return ''; }
}
function preferences(input = {}) {
  return {
    timeout: integer(input.timeout, 30, 5, 120), cacheMiB: integer(input.cacheMiB, 32, 0, 128),
    blacklist: booruRules(input.blacklist), outputFilter: booruRules(input.outputFilter),
    categories: Array.isArray(input.categories) ? BOORU_CATEGORIES.filter(x => input.categories.includes(x)) : [...BOORU_DEFAULTS.categories],
    spaces: input.spaces === true, escapeParentheses: input.escapeParentheses === true
  };
}
function normalizePost(raw) {
  if (!Number.isSafeInteger(Number(raw?.id)) || Number(raw.id) <= 0 || raw.is_deleted || !RATINGS.includes(raw.rating)) return null;
  if (!['jpg', 'jpeg', 'png', 'webp', 'gif', 'avif'].includes(String(raw.file_ext || '').toLowerCase())) return null;
  const tags = Object.fromEntries(BOORU_CATEGORIES.map(category => [category, String(raw[`tag_string_${category}`] || '').split(/\s+/).filter(Boolean).slice(0, 1000)]));
  const media = {
    preview: booruMediaUrl(raw.preview_file_url) || booruMediaUrl(raw.large_file_url),
    sample: booruMediaUrl(raw.large_file_url) || booruMediaUrl(raw.file_url),
    original: booruMediaUrl(raw.file_url)
  };
  if (!media.preview) media.preview = media.sample;
  return {
    id: String(raw.id), width: Number(raw.image_width) || 0, height: Number(raw.image_height) || 0,
    score: Number(raw.score) || 0, favorites: Number(raw.fav_count) || 0, rating: raw.rating,
    date: String(raw.created_at || '').slice(0, 30), size: Number(raw.file_size) || 0,
    extension: String(raw.file_ext).toLowerCase(), tags, media,
    allTags: [...new Set([...Object.values(tags).flat(), ...String(raw.tag_string || '').split(/\s+/).filter(Boolean)])]
  };
}
export function createBooruService({ http, vault, now = () => new Date() }) {
  let config = preferences(), credentials = { username: '', apiKey: '' }, loaded, writes = Promise.resolve();
  const posts = new Map(), cache = new Map();
  let cacheBytes = 0, cacheEpoch = 0;
  const ready = () => loaded ||= (async () => {
    const data = await vault.read();
    config = preferences(data.preferences);
    credentials = { username: String(data.credentials?.username || ''), apiKey: String(data.credentials?.apiKey || '') };
  })().catch(() => { loaded = null; throw fail(500, '画廊设置无法读取，请重试。'); });
  function trimCache() {
    while (cacheBytes > config.cacheMiB * 1024 ** 2 && cache.size) {
      const key = cache.keys().next().value;
      cacheBytes -= cache.get(key).bytes.byteLength; cache.delete(key);
    }
  }
  function clearCache() { cacheEpoch++; cache.clear(); cacheBytes = 0; }
  function status() {
    return { ...structuredClone(config), configured: Boolean(credentials.username && credentials.apiKey),
      cacheBytes, cacheCount: cache.size };
  }
  function remember(post) {
    posts.delete(post.id); posts.set(post.id, post);
    while (posts.size > 600) posts.delete(posts.keys().next().value);
    return post;
  }
  const blocked = post => post.allTags.some(tag => matchesBooruRule(tag, config.blacklist));
  function visiblePost(post, detail = false) {
    const { media, allTags, tags, ...summary } = post;
    return { ...summary, source: `${ORIGIN}/posts/${post.id}`, preview: Boolean(media.preview), original: Boolean(media.original),
      ...(detail ? { tags } : {}) };
  }
  async function request(url, { signal, json = true } = {}) {
    signal?.throwIfAborted();
    const controller = new AbortController(), abort = () => controller.abort(signal.reason);
    signal?.addEventListener('abort', abort, { once: true });
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, config.timeout * 1000);
    const headers = { Accept: json ? 'application/json' : 'image/*', 'User-Agent': 'NAI-Pocket-Endfield/0.7.10 (Danbooru gallery)' };
    if (json && credentials.username && credentials.apiKey) {
      if (new URL(url).origin !== ORIGIN) throw fail(400, '画廊请求地址无效。');
      headers.Authorization = `Basic ${Buffer.from(`${credentials.username}:${credentials.apiKey}`).toString('base64')}`;
    }
    try {
      const response = await http.fetch(url, { headers, redirect: 'error', credentials: 'omit', signal: controller.signal });
      signal?.throwIfAborted();
      if (response.status === 401) throw fail(401, 'Danbooru 账号或 API Key 无效，请在画廊设置中检查。');
      if (response.status === 403) throw fail(403, 'Danbooru 拒绝了访问，请检查网络或账号权限。');
      if (response.status === 429) throw fail(429, 'Danbooru 请求过于频繁，请稍后重试。');
      if (response.status === 422) throw fail(422, '搜索条件超出站点限制，请减少标签（普通账号通常最多两个）或检查查询。');
      if (!response.ok) throw fail(502, `Danbooru 暂时无法读取（HTTP ${response.status}）。`);
      if (json) {
        const text = await response.text();
        if (text.length > 8 * 1024 ** 2) throw fail(502, 'Danbooru 返回的数据过大。');
        try { return JSON.parse(text); } catch { throw fail(502, 'Danbooru 返回格式异常，可能需要检查网络。'); }
      }
      const type = (response.headers.get('content-type') || '').split(';')[0].toLowerCase();
      if (!['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif'].includes(type)) throw fail(502, '站点未返回可显示的图片。');
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.byteLength > MAX_IMAGE_BYTES) throw fail(413, '这张图片超过 32 MB，请通过来源页面查看。');
      return { bytes, type };
    } catch (error) {
      signal?.throwIfAborted();
      if (timedOut) throw fail(504, 'Danbooru 请求超时，请检查网络或增加超时时间。');
      if (error.status) throw error;
      // Never reflect upstream response bodies, URLs, Basic auth or bridge errors.
      throw fail(502, '无法连接 Danbooru，请检查网络后重试。');
    } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
  }
  async function getPost(id, signal) {
    if (!/^[1-9]\d{0,12}$/.test(String(id))) throw fail(400, '图片编号无效。');
    let post = posts.get(String(id));
    if (!post) {
      post = normalizePost(await request(`${ORIGIN}/posts/${id}.json`, { signal }));
      if (!post || post.id !== String(id)) throw fail(404, '图片不存在或暂不支持查看。');
      remember(post);
    }
    if (blocked(post)) throw fail(403, '这张图片已被内容黑名单屏蔽。');
    return post;
  }
  return {
    async settings() { await ready(); return status(); },
    async save(input) {
      await ready();
      const operation = writes.then(async () => {
        const next = preferences({ ...config, ...input });
        let nextCredentials = { ...credentials };
        if (input.clearCredentials === true) nextCredentials = { username: '', apiKey: '' };
        else if (input.username !== undefined || input.apiKey !== undefined) {
          const username = String(input.username || '').trim(), apiKey = String(input.apiKey || '').trim();
          if (!username || !apiKey || username.length > 120 || apiKey.length > 256 || /[:\r\n]/.test(username) || /[\r\n]/.test(apiKey)) throw fail(400, '请同时填写有效的用户名和 API Key。');
          nextCredentials = { username, apiKey };
        }
        await vault.write({ preferences: next, credentials: nextCredentials });
        config = next; credentials = nextCredentials; clearCache();
        return status();
      });
      writes = operation.catch(() => {});
      return operation;
    },
    async test({ signal } = {}) {
      await ready();
      const raw = await request(`${ORIGIN}/posts.json?limit=1&tags=rating%3Ag`, { signal });
      if (!Array.isArray(raw)) throw fail(502, 'Danbooru 返回格式异常。');
      return { ok: true, authenticated: Boolean(credentials.username && credentials.apiKey) };
    },
    async list(input = {}, { signal } = {}) {
      await ready();
      const page = integer(input.page, 1, 1, 1000), sort = ['latest', 'score', 'favcount'].includes(input.sort) ? input.sort : 'latest';
      const ratings = String(input.ratings || 'g').split(',').filter(x => RATINGS.includes(x));
      if (!ratings.length) throw fail(400, '至少选择一个内容分级。');
      const period = ['day', 'week', 'month'].includes(input.period) ? input.period : '';
      const url = new URL(period ? '/explore/posts/popular.json' : '/posts.json', ORIGIN);
      url.searchParams.set('page', String(page)); url.searchParams.set('limit', String(PAGE_SIZE));
      let q = String(input.q || '').trim().slice(0, 1000);
      if (period && q) throw fail(400, '排行榜不支持标签搜索，请切换到搜索。');
      if (period) {
        url.searchParams.set('scale', period);
        if (period === 'day') {
          const date = new Date(now()); date.setUTCDate(date.getUTCDate() - 1);
          url.searchParams.set('date', date.toISOString().slice(0, 10));
        }
      } else {
        if (/[，,]/.test(q)) q = q.split(/[,，]+/).map(x => x.trim().replace(/\s+/g, '_')).filter(Boolean).join(' ');
        // The explicit controls own sorting/rating. Filter again locally even if a
        // query contains OR operators or an upstream search changes its semantics.
        q = q.split(/\s+/).filter(x => !/^-?(?:rating|order|limit|page):/i.test(x)).join(' ');
        if (ratings.length < 4) q += ` rating:${ratings.join(',')}`;
        if (sort !== 'latest') q += ` order:${sort}`;
        url.searchParams.set('tags', q.trim());
      }
      const raw = await request(url.href, { signal });
      if (!Array.isArray(raw)) throw fail(502, 'Danbooru 返回格式异常。');
      let filtered = 0, unavailable = 0;
      const result = [];
      for (const value of raw) {
        const post = normalizePost(value);
        if (!post || !ratings.includes(post.rating) || blocked(post)) { filtered++; continue; }
        if (!post.media.preview) { unavailable++; continue; }
        result.push(visiblePost(remember(post)));
      }
      return { posts: result, page, hasMore: raw.length >= PAGE_SIZE, filtered, unavailable,
        period, date: url.searchParams.get('date') || '' };
    },
    async detail(id, { signal } = {}) { await ready(); return visiblePost(await getPost(id, signal), true); },
    async image(id, tier = 'sample', { signal } = {}) {
      await ready();
      if (!['preview', 'sample', 'original'].includes(tier)) throw fail(400, '图片尺寸无效。');
      const post = await getPost(id, signal), url = post.media[tier];
      if (!url) throw fail(404, '站点未提供这张图片，请检查账号权限或打开来源。');
      if (tier === 'original' && post.size > MAX_IMAGE_BYTES) throw fail(413, '原图超过 32 MB，请通过来源页面下载。');
      signal?.throwIfAborted();
      let value = cache.get(url);
      if (value) { cache.delete(url); cache.set(url, value); }
      else {
        const epoch = cacheEpoch;
        value = await request(url, { signal, json: false });
        if (tier === 'preview' && value.bytes.byteLength > 4 * 1024 ** 2) throw fail(413, '缩略图过大，请打开图片详情查看。');
        if (epoch === cacheEpoch && config.cacheMiB > 0 && value.bytes.byteLength <= config.cacheMiB * 1024 ** 2) {
          if (cache.has(url)) cacheBytes -= cache.get(url).bytes.byteLength;
          cache.set(url, value); cacheBytes += value.bytes.byteLength; trimCache();
        }
      }
      return { ...value, name: `danbooru-${post.id}.${post.extension}` };
    },
    async clearCache() { await ready(); const freedBytes = cacheBytes; clearCache(); return { freedBytes, ...status() }; }
  };
}
