import { isNaxV5Artist, normalizeArtistIdentity } from '../public/artist-index-v5.js';
import { validateStyleAttributes, attributesFromLegacy, summarizeStyleEvidence, STYLE_ATTRIBUTES } from '../public/artist-style-schema.js';
import { artistListOptions, listArtistsView, coverExample } from '../public/artist-list-view.js';
import { rankStyle, vibeTagsOf, styleProfileOf, centerQuery } from '../public/style-rank.js';
import { normalizeArtistPreference } from './artist-browser.js';
import { publicDanbooruStats } from './artist-danbooru-stats.js';

// The local app serves the artist-library UI (the same UI as the server site) from installed
// resource packs and the user's own favourites/notes. Responses follow the server's
// /api/artists, /api/artists/profile and /api/artists/summary shapes; list admission, order,
// paging and cover choice come from the shared artist-list-view module.

const fail = (message, status = 400) => Object.assign(new Error(message), { status });
const json = (value, fallback) => { try { return value ? JSON.parse(value) : fallback; } catch { return fallback; } };
const EMPTY_STATUS = Object.freeze({ status: '', detail: '', checkedAt: 0, confirmedUnavailable: false });
const automatic = row => !row.reviewed && ['assistant-visual', 'danbooru-tags'].includes(row.source);
const link = value => {
  try { const url = new URL(value); return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url.href : ''; }
  catch { return ''; }
};
function observation(row, withProvenance = false) {
  let attributes;
  try { attributes = validateStyleAttributes(json(row.attributes_json, {})); } catch { attributes = {}; }
  return { id: row.id, exampleId: row.example_id, model: row.model || 'original', facets: json(row.facets_json, {}), note: row.note || '',
    schemaVersion: row.schema_version || 1, attributes, ...(withProvenance ? { provenance: json(row.provenance_json, {}) } : {}),
    reviewed: Boolean(row.reviewed), source: row.source, automatic: automatic(row), updatedAt: row.updated_at ?? null };
}
const boolParam = value => value === '1' || value === true;

// `styleIndex` (optional, service/style-index-local.js): the downloaded 画风数据. Without it 按感觉找 /
// 找相似 answer 503 and cards carry no vibe words, as on a server without an index.
// `styleImages` (optional, app/src/style-images.js): 以图找画师 — { available(): Promise<boolean>,
// vector(id) } for pictures the host has embedded; `image=<id>` then ranks like the server's.
export function createArtistLibraryView({ store, preferences, roster = [], names = [], imageUrl, danbooru = null, styleIndex = null, styleImages = null, clock = { now: () => Date.now() } }) {
  const builtIn = new Map();
  for (const name of names) builtIn.set(normalizeArtistIdentity(name), { name, aliases: [] });
  for (const row of roster) builtIn.set(normalizeArtistIdentity(row.artist), { name: row.artist, aliases: row.aliases || [] });
  let cache = null;

  // Pages of rows small enough for the native bridge; see the storage module.
  const PAGE = 1000;
  async function pages(read) {
    const rows = [];
    for (let after = ''; ;) {
      const page = await read(after, PAGE);
      rows.push(...page);
      if (page.length < PAGE) return rows;
      after = page.at(-1).id;
    }
  }

  async function load(revision) {
    const profiles = await store.profiles(), saved = await store.preferences();
    const facts = new Map((store.danbooruPage ? await pages(async (after, limit) => (await store.danbooruPage(after, limit)).map(row => ({ ...row, id: row.artist }))) : []).map(row => [row.artist, publicDanbooruStats(row)]));
    const examples = await pages(store.examplesPage), observations = await pages(store.observationsPage);
    const prepared = new Map(profiles.map(row => [row.artist, row]));
    const prefs = new Map(saved.map(row => [row.artist, row]));
    const exampleMap = new Map();
    examples.sort((a, b) => a.position - b.position || (a.id < b.id ? -1 : 1));
    for (const row of examples) {
      const storage = prepared.get(row.artist)?.storage_id || '';
      if (!exampleMap.has(row.artist)) exampleMap.set(row.artist, []);
      exampleMap.get(row.artist).push({ id: row.id, model: 'original', source_type: 'original', rotation_sample: 0, storage });
    }
    const evidence = new Map(), byId = new Map();
    for (const row of observations) {
      const item = observation(row);
      byId.set(item.id, item);
      if (!evidence.has(row.artist)) evidence.set(row.artist, []);
      evidence.get(row.artist).push(item);
    }
    const keys = new Set([...builtIn.keys(), ...prepared.keys(), ...prefs.keys()]);
    const entries = [];
    for (const key of keys) {
      const pack = prepared.get(key), pref = prefs.get(key), known = builtIn.get(key);
      const images = exampleMap.get(key) || [];
      const cover = coverExample(images, '');
      entries.push({ artist: key, name: pack?.display_name || known?.name || key, indexed: isNaxV5Artist(key),
        aliases: pack ? json(pack.aliases_json, []) : known?.aliases || [], favorite: Boolean(pref?.favorite), note: pref?.note || '',
        danbooru: facts.get(key) || null, danbooruStatus: EMPTY_STATUS, observations: evidence.get(key) || [], exampleCount: images.length,
        coverUrl: cover ? imageUrl(cover.id, 'thumb', cover.storage) : '', coverModel: cover ? 'original' : '', coverSourceType: cover ? 'original' : '',
        coverExampleId: '', exampleModels: images.length ? ['original'] : [] });
    }
    return { revision, entries, examples: exampleMap, byId, notes: false };
  }

  async function catalog({ notes = false } = {}) {
    for (let attempt = 0; ; attempt++) {
      const revision = await store.revision();
      if (cache?.revision !== revision) cache = await load(revision);
      // Descriptions are only searched by a typed query; they are attached once, on demand.
      if (notes && !cache.notes) {
        for (const row of await pages(store.notesPage)) { const item = cache.byId.get(row.id); if (item) item.note = row.note; }
        cache.notes = true;
      }
      // Pages are separate bridge commands; a pack replacement in between means reading again.
      if (await store.revision() === revision || attempt >= 2) return cache;
      cache = null;
    }
  }

  async function profile(value) {
    const key = normalizeArtistIdentity(String(value || '')).slice(0, 160);
    if (!key) throw fail('画师名称无效。');
    const { profile: pack, examples: rows, observations: notes, preference } = await store.artist(key);
    const known = builtIn.get(key), storage = pack?.storage_id || '';
    const examples = rows.map(row => ({ id: row.id, artist: key, sourceType: 'original', sourceUrl: link(row.source_url), model: 'original', note: row.note || '',
      metadata: json(row.metadata_json, {}), width: row.width, height: row.height, createdAt: null, rotationSample: false, naxPreview: false,
      thumbUrl: imageUrl(row.id, 'thumb', storage), previewUrl: imageUrl(row.id, 'preview', storage) }));
    const observations = notes.map(row => observation(row, true));
    const cover = coverExample(examples, '');
    const style = styleIndex ? await styleIndex.ready() : null;
    // 画风概览: covers of the closest artists come from the installed packs (absent ones show a name only).
    let styleProfile = style ? styleProfileOf(style, key) : null;
    if (styleProfile) {
      const { examples: byArtist } = await catalog();
      styleProfile = { ...styleProfile, similar: styleProfile.similar.map(item => {
        const row = (byArtist.get(item.artist) || []).find(example => example.id === item.exampleId);
        return { ...item, thumbUrl: row ? imageUrl(row.id, 'thumb', row.storage) : '' };
      }) };
    }
    return { artist: key, ...(style ? { vibeTags: vibeTagsOf(style)(key) } : {}), ...(styleProfile ? { styleProfile } : {}), name: pack?.display_name || known?.name || key, indexed: isNaxV5Artist(key),
      aliases: pack ? json(pack.aliases_json, []) : known?.aliases || [], favorite: Boolean(preference?.favorite), note: preference?.note || '',
      danbooru: danbooru ? await danbooru.get(key) : null, danbooruStatus: EMPTY_STATUS, examples, observations, naxPreviews: [], naxExample: null,
      evidenceSummary: { ...summarizeStyleEvidence(examples, observations, examples.length ? 'original' : ''), model: examples.length ? 'original' : '' },
      exampleCount: examples.length, naxPreviewCount: 0, coverUrl: cover?.thumbUrl || '', coverModel: cover ? 'original' : '', coverSourceType: cover ? 'original' : '',
      coverExampleId: cover ? cover.id : '', coverIsChosen: false, exampleModels: examples.length ? ['original'] : [],
      resourceSet: pack ? { id: pack.set_id, revision: storage } : null };
  }

  return {
    async list(query = {}) {
      let facets, attributes;
      try { facets = JSON.parse(query.facets || '{}'); attributes = JSON.parse(query.attributes || '{}'); }
      catch { throw fail('画风筛选格式无效。'); }
      const options = { query: query.query || '', facets, attributes, model: query.model || '', favorite: boolParam(query.favorite),
        annotated: boolParam(query.annotated), confirmedOnly: boolParam(query.confirmedOnly), includeAutomatic: query.includeAutomatic !== '0',
        offset: query.offset, limit: query.limit, sort: query.sort || 'default' };
      const { model, sort } = artistListOptions(options, fail);
      const style = styleIndex ? await styleIndex.ready() : null;
      let styleRank = null;
      if (query.vibe || query.like || query.image) {
        if (!style) throw fail('还没有画风数据：在 设置 → 画风数据 下载后可按感觉找画师、找相似。', 503);
        let image = null;
        if (query.image) {
          const raw = styleImages?.vector(String(query.image));
          if (!raw) throw fail('这张图片的检索已过期，请重新选择图片。', 410);
          const vector = centerQuery(style, raw);
          if (!vector) throw fail('画风数据不支持以图找画师，请更新画风数据。', 503);
          image = { key: String(query.image), vector };
        }
        styleRank = rankStyle(style, { vibe: String(query.vibe || ''), like: String(query.like || ''), image });
      }
      const { entries, examples } = await catalog({ notes: Boolean(String(options.query || '').trim()) });
      return { ...listArtistsView(entries, examples, options, { model, sort, fail, styleRank, vibeTags: style ? vibeTagsOf(style) : null,
        thumbUrl: cover => imageUrl(cover.id, 'thumb', cover.storage) }), styleIndex: Boolean(style),
        imageSearch: Boolean(style?.mean) && Boolean(styleImages && await styleImages.available()) };
    },
    profile,
    styleInfo: async () => {
      const info = styleIndex ? await styleIndex.info() : { available: false, chips: [] };
      return info.available ? { ...info, imageSearch: Boolean(styleImages && await styleImages.available()) } : info;
    },
    async save(input = {}) {
      // Favourite and note are the user's own data; aliases and evidence come from packs.
      const value = { artist: input.artist, ...(Object.hasOwn(input, 'favorite') ? { favorite: input.favorite } : {}), ...(Object.hasOwn(input, 'note') ? { note: input.note } : {}) };
      const preference = normalizeArtistPreference(value, { partial: true });
      await preferences.save({ ...preference, updatedAt: clock.now() });
      return profile(preference.artist);
    },
    async summary() {
      const { entries } = await catalog();
      let withExamples = 0, totalExamples = 0, annotated = 0, tagged = 0;
      for (const entry of entries) {
        if (!entry.exampleCount) continue;
        withExamples++; totalExamples += entry.exampleCount;
        const byExample = new Set(entry.observations.map(item => item.exampleId));
        annotated += byExample.size;
        const isTagged = item => { const values = { ...attributesFromLegacy(item.facets || {}), ...item.attributes };
          return STYLE_ATTRIBUTES.some(definition => definition.options.some(option => Array.isArray(values[definition.key]) && values[definition.key].includes(option.value))); };
        tagged += new Set(entry.observations.filter(isTagged).map(item => item.exampleId)).size;
      }
      return { totalArtists: entries.length, artistsWithExamples: withExamples, artistsWithoutExamples: entries.length - withExamples,
        totalExamples, examplesWithTags: tagged, examplesWithoutTags: totalExamples - tagged, allExamples: totalExamples, sampleExamples: 0,
        unannotatedExamples: totalExamples - annotated, unjudgedExamples: annotated - tagged,
        // No upstream statistics or availability checks run on the phone: report them as unknown.
        danbooruStats: { total: 0, withPosts: 0, withoutPosts: 0, unsynced: 0, lastSyncedAt: 0 },
        availability: { confirmedGone: 0, available: 0, noEligibleWork: 0, unchecked: entries.length - withExamples } };
    }
  };
}
