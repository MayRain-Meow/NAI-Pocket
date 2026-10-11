import { ARTIST_STAT_FIELDS, DANBOORU_ARTIST_ID_BATCH, selectDanbooruArtistStats } from '../public/danbooru-artist-stats.js';

// Danbooru facts for the app's artists, read from the public API by artist id (the id is
// recorded in the prepared examples). One batch per call, paced; results use the same shape as
// the server's /api/artists/stats so the shared artist-library UI works unchanged.
const fail = (message, status = 502) => Object.assign(new Error(message), { status });
const API = 'https://danbooru.donmai.us/artists.json';
const BATCH_INTERVAL_MS = 1000;

export function publicDanbooruStats(row) {
  if (!row || !row.synced_at) return null;
  let homepages = [];
  try { homepages = JSON.parse(row.homepages_json || '[]'); } catch { homepages = []; }
  return { postCount: row.post_count ?? null, createdAt: row.created_at ?? null, updatedAt: row.updated_at ?? null,
    homepages: Array.isArray(homepages) ? homepages : [], syncedAt: Number(row.synced_at) || 0, source: 'danbooru.donmai.us' };
}

export function createArtistDanbooruStats({ store, http, clock = { now: () => Date.now() }, wait = ms => new Promise(resolve => setTimeout(resolve, ms)) }) {
  let lastRequestAt = 0;
  async function fetchByIds(ids, signal) {
    const delay = lastRequestAt + BATCH_INTERVAL_MS - clock.now();
    if (delay > 0) await wait(delay);
    lastRequestAt = clock.now();
    const url = new URL(API);
    url.search = new URLSearchParams({ 'search[id]': ids.join(','), limit: String(ids.length + 10), only: ARTIST_STAT_FIELDS }).toString();
    let response;
    try { response = await http.fetch(url.href, { method: 'GET', headers: { Accept: 'application/json' }, credentials: 'omit', signal }); }
    catch (error) { if (error?.name === 'AbortError') throw error; throw fail('无法连接 Danbooru，请检查网络。'); }
    if (response.status === 429) throw fail('Danbooru 请求过于频繁，请稍后再试。', 429);
    if (!response.ok) throw fail(`Danbooru 返回 ${response.status}。`);
    const records = await response.json();
    const stats = new Map();
    for (const record of Array.isArray(records) ? records : []) {
      const parsed = selectDanbooruArtistStats(record);
      if (parsed) stats.set(parsed.id, parsed);
    }
    return stats;
  }
  async function apply(rows, signal) {
    const result = { requested: rows.length, synced: 0, skipped: 0, missing: 0, failed: 0, artists: [], remaining: 0, errors: [] };
    const now = clock.now();
    let stats = new Map();
    if (rows.length) {
      try { stats = await fetchByIds(rows.map(row => row.danbooru_id), signal); }
      catch (error) {
        if (error?.name === 'AbortError') throw error;
        result.failed = rows.length; result.errors.push(String(error.message || error).slice(0, 200));
        result.remaining = await store.remaining();
        return result;
      }
    }
    for (const row of rows) {
      const found = stats.get(row.danbooru_id);
      // A missing id is recorded too, so an artist gone upstream is not retried every round.
      await store.save({ artist: row.artist, danbooruId: row.danbooru_id, postCount: found?.postCount ?? null, createdAt: found?.createdAt ?? null,
        updatedAt: found?.updatedAt ?? null, homepages: found?.homepages || [], syncedAt: now, status: found ? 'available' : 'absent' });
      if (found) { result.synced += 1; result.artists.push({ artist: row.artist, postCount: found.postCount ?? null, createdAt: found.createdAt ?? null, updatedAt: found.updatedAt ?? null }); }
      else result.missing += 1;
    }
    result.remaining = await store.remaining();
    return result;
  }
  return {
    async get(artist) { return publicDanbooruStats(await store.get(artist)); },
    // One artist (detail page 刷新) or, without a name, the next batch of least recently synced artists.
    async sync({ artist = '' } = {}, { signal } = {}) {
      if (artist) {
        const id = await store.artistId(artist);
        if (!id) return { requested: 1, synced: 0, skipped: 1, missing: 0, failed: 0, artists: [], remaining: await store.remaining(), errors: [] };
        return apply([{ artist, danbooru_id: id }], signal);
      }
      return apply(await store.pending(DANBOORU_ARTIST_ID_BATCH), signal);
    }
  };
}
