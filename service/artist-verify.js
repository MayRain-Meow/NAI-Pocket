// Artist name check against Danbooru (1.9.2, owner 2026-10-22): tags from elsewhere often carry
// misspelled or invented artist names, which NovelAI silently ignores. One name costs at most
// three public read-only requests (tag → active alias → artist other names), paced to one per
// second across all callers and cached, so a pasted prompt cannot hammer Danbooru.

const API = 'https://danbooru.donmai.us';
const CACHE_MS = 7 * 24 * 3600 * 1000, CACHE_MAX = 1000, INTERVAL_MS = 1000;
const fail = (message, status = 502) => Object.assign(new Error(message), { status });

export const danbooruTagName = value => String(value ?? '').trim().replace(/^artist\s*:\s*/i, '').replace(/\\([()])/g, '$1')
  .trim().replace(/\s+/g, '_').toLowerCase();
const displayName = tag => String(tag || '').replace(/_/g, ' ');

export function createArtistNameVerifier({ http, clock = { now: () => Date.now() }, wait = ms => new Promise(resolve => setTimeout(resolve, ms)) }) {
  const cache = new Map();
  let next = 0;
  async function get(path, params, signal) {
    const now = clock.now(), at = Math.max(now, next);
    next = at + INTERVAL_MS;
    if (at > now) await wait(at - now);
    let response;
    try {
      response = await http.fetch(`${API}/${path}?${new URLSearchParams(params)}`, { method: 'GET', headers: { Accept: 'application/json' }, credentials: 'omit', signal });
    } catch (error) { if (error?.name === 'AbortError') throw error; throw fail('无法连接 Danbooru，请检查网络。'); }
    if (response.status === 429) throw fail('Danbooru 请求过于频繁，请稍后再试。', 429);
    if (!response.ok) throw fail(`Danbooru 返回 ${response.status}。`);
    const rows = await response.json();
    return Array.isArray(rows) ? rows : [];
  }
  const tag = async (name, signal) => (await get('tags.json', { 'search[name]': name, only: 'name,category,post_count' }, signal))[0] || null;

  async function check(name, signal) {
    const found = await tag(name, signal);
    if (found) {
      if (Number(found.category) === 1) return { status: Number(found.post_count) > 0 ? 'artist' : 'no-posts', name: displayName(found.name), postCount: Number(found.post_count) || 0 };
      // A general / character / copyright tag: the name is not an artist, so treating it as one is a misidentification.
      return { status: 'not-artist', name: displayName(found.name), postCount: Number(found.post_count) || 0, category: Number(found.category) };
    }
    const alias = (await get('tag_aliases.json', { 'search[antecedent_name]': name, 'search[status]': 'active', only: 'consequent_name' }, signal))[0];
    if (alias?.consequent_name) {
      const target = await tag(alias.consequent_name, signal);
      if (target && Number(target.category) === 1) return { status: 'alias', name: displayName(target.name), postCount: Number(target.post_count) || 0 };
      return { status: 'not-artist', name: displayName(alias.consequent_name), postCount: Number(target?.post_count) || 0, category: Number(target?.category) };
    }
    // Other names (pixiv ids, Japanese names, old spellings) recorded on Danbooru artist entries.
    const artist = (await get('artists.json', { 'search[any_name_matches]': name, only: 'name,is_deleted,is_banned', limit: '3' }, signal)).find(row => !row.is_deleted);
    if (artist?.name) return { status: artist.is_banned ? 'banned' : 'alias', name: displayName(artist.name) };
    return { status: 'absent' };
  }

  return {
    async verify(value, { signal } = {}) {
      const name = danbooruTagName(value);
      if (!name || name.length > 120 || /[\s,]/.test(name)) throw fail('画师名无效。', 400);
      const cached = cache.get(name);
      if (cached && cached.expiresAt > clock.now()) return cached.result;
      const result = { query: displayName(name), ...await check(name, signal), checkedAt: clock.now() };
      cache.set(name, { result, expiresAt: clock.now() + CACHE_MS });
      while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
      return result;
    }
  };
}
