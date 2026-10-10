import { NAX_V5_ARTISTS, isNaxV5Artist, normalizeArtistIdentity } from '../public/artist-index-v5.js';

const fail = message => Object.assign(new Error(message), { status: 400 });
const nameKey = value => {
  if (typeof value !== 'string' || value.length > 180 || /[\u0000-\u001f]|:\/\//.test(value)) throw fail('画师名称无效。');
  const key = normalizeArtistIdentity(value);
  if (!key || key.length > 160) throw fail('画师名称无效。');
  return key;
};
const bounded = (value, fallback, max) => Math.max(1, Math.min(max, Number.parseInt(value, 10) || fallback));

export function normalizeArtistPreference(input, { partial = false } = {}) {
  const artist = nameKey(input?.artist);
  const hasFavorite = Object.hasOwn(input, 'favorite'), hasNote = Object.hasOwn(input, 'note');
  if (partial ? !hasFavorite && !hasNote : !hasFavorite || !hasNote) throw fail('收藏或备注数据不完整。');
  if (hasFavorite && typeof input.favorite !== 'boolean') throw fail('收藏状态无效。');
  if (hasNote && (typeof input.note !== 'string' || input.note.length > 2000)) throw fail('备注最多 2000 个字符。');
  return { artist, favorite: input.favorite === true, note: hasNote ? input.note : '', hasFavorite, hasNote };
}


export function createArtistBrowserService({ store, resources = null, names = NAX_V5_ARTISTS, roster = [], clock = { now: () => Date.now() } }) {
  const builtIn = new Map(roster.map(row => [nameKey(row.artist), row]));
  const catalog = new Map([...names.map(name => [normalizeArtistIdentity(name), name]), ...[...builtIn].map(([key,row]) => [key,row.artist])]);
  const profile = (key, row, prepared = null) => ({ artist: prepared?.displayName || catalog.get(key) || key, indexed: isNaxV5Artist(key),
    favorite: Boolean(row?.favorite), note: row?.note || '', updatedAt: row?.updated_at || null,
    source: prepared ? 'resource-pack' : builtIn.has(key) ? 'built-in-roster' : catalog.has(key) ? 'public-nax-index' : 'local',
    aliases: prepared?.aliases || builtIn.get(key)?.aliases || [], exampleCount: prepared?.exampleCount || 0,
    annotatedCount: prepared?.annotatedCount || 0, reviewedCount: prepared?.reviewedCount || 0,
    coverUrl: prepared?.coverUrl || null, examples: [], observations: [], naxExample: null });
  async function get(value) {
    const key = nameKey(value), prepared = await resources?.get(key);
    const result = profile(key, await store.get(key));
    if (prepared) Object.assign(result, prepared, { source: 'resource-pack', coverUrl:prepared.examples[0]?.thumbUrl || null, exampleCount: prepared.examples.length,
      annotatedCount: new Set(prepared.observations.map(item=>item.exampleId)).size,
      reviewedCount: new Set(prepared.observations.filter(item=>item.reviewed).map(item=>item.exampleId)).size });
    return result;
  }
  return {
    async list(query = {}, {signal} = {}) {
      signal?.throwIfAborted();
      const saved = new Map((await store.all()).map(row => [row.artist, row]));
      signal?.throwIfAborted();
      const dataset = await resources?.catalog() || { sets: [], profiles: [] };
      signal?.throwIfAborted();
      const prepared = new Map(dataset.profiles.map(item => [item.artist,item]));
      const q = normalizeArtistIdentity(String(query.q || '').trim().slice(0, 160));
      const favoriteOnly = query.favorite === '1' || query.favorite === true;
      const confirmedOnly = query.confirmed === '1' || query.confirmed === true;
      let attributes = {};
      try { if(query.attributes)attributes=typeof query.attributes==='string'?JSON.parse(query.attributes):query.attributes; }
      catch { throw fail('画风筛选条件无效。'); }
      if (!attributes || typeof attributes !== 'object' || Array.isArray(attributes)) throw fail('画风筛选条件无效。');
      const matching = confirmedOnly || Object.keys(attributes).length ? await resources?.matching({attributes,confirmedOnly,signal}) || new Set() : null;
      const keys = new Set([...catalog.keys(), ...saved.keys(), ...prepared.keys()]);
      let favorites = 0;
      const artists = [];
      for (const key of keys) {
        const row = saved.get(key), item = profile(key, row, prepared.get(key));
        if (item.favorite) favorites++;
        if (favoriteOnly && !item.favorite) continue;
        if (matching && !matching.has(key)) continue;
        if (q && ![key,...item.aliases.map(normalizeArtistIdentity),normalizeArtistIdentity(item.note)].some(text=>text.includes(q))) continue;
        artists.push(item);
      }
      artists.sort((a,b) => Number(b.favorite)-Number(a.favorite) || a.artist.localeCompare(b.artist));
      const limit=bounded(query.limit,24,100), total=artists.length, pages=Math.max(1,Math.ceil(total/limit));
      const page=Math.min(pages,bounded(query.page,1,100000));
      return { artists: artists.slice((page-1)*limit,page*limit), total, page, pages, limit, favorites, catalogTotal:keys.size,
        resources: { installed:dataset.sets.length>0, sets:dataset.sets, artists:prepared.size } };
    },
    get,
    async save(input = {}) {
      const preference=normalizeArtistPreference(input,{partial:true}), key=preference.artist;
      await store.save({ ...preference, updatedAt:clock.now() });
      return get(key);
    },
    async identities() {
      const dataset=await resources?.catalog() || {profiles:[]};
      const profiles = new Map([...builtIn].map(([key,row])=>[key,{displayName:row.artist,aliases:row.aliases}]));
      for(const row of dataset.profiles)profiles.set(row.artist,row);
      return { names:[...new Set([...(await store.all()).map(row=>catalog.get(row.artist)||row.artist),...[...profiles.values()].map(row=>row.displayName)])],
        aliases:[...profiles.values()].flatMap(row=>row.aliases.map(alias=>[alias,row.displayName])) };
    }
  };
}
