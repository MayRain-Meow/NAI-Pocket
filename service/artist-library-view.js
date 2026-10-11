import { isNaxV5Artist, normalizeArtistIdentity } from '../public/artist-index-v5.js';
import { validateStyleAttributes, attributesFromLegacy, summarizeStyleEvidence, STYLE_ATTRIBUTES } from '../public/artist-style-schema.js';
import { artistListOptions, listArtistsView, coverExample } from '../public/artist-list-view.js';
import { normalizeArtistPreference } from './artist-browser.js';

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

export function createArtistLibraryView({ store, preferences, roster = [], names = [], imageUrl, clock = { now: () => Date.now() } }) {
  const builtIn = new Map();
  for (const name of names) builtIn.set(normalizeArtistIdentity(name), { name, aliases: [] });
  for (const row of roster) builtIn.set(normalizeArtistIdentity(row.artist), { name: row.artist, aliases: row.aliases || [] });
  let cache = null;

  async function catalog() {
    const revision = await store.revision();
    if (cache?.revision === revision) return cache;
    const { profiles, examples, observations, preferences: saved } = await store.snapshot();
    const prepared = new Map(profiles.map(row => [row.artist, row]));
    const prefs = new Map(saved.map(row => [row.artist, row]));
    const exampleMap = new Map();
    for (const row of examples) {
      const storage = prepared.get(row.artist)?.storage_id || '';
      if (!exampleMap.has(row.artist)) exampleMap.set(row.artist, []);
      exampleMap.get(row.artist).push({ id: row.id, model: 'original', source_type: 'original', rotation_sample: 0, storage });
    }
    const evidence = new Map();
    for (const row of observations) {
      if (!evidence.has(row.artist)) evidence.set(row.artist, []);
      evidence.get(row.artist).push(observation(row));
    }
    const keys = new Set([...builtIn.keys(), ...prepared.keys(), ...prefs.keys()]);
    const entries = [];
    for (const key of keys) {
      const pack = prepared.get(key), pref = prefs.get(key), known = builtIn.get(key);
      const images = exampleMap.get(key) || [];
      const cover = coverExample(images, '');
      entries.push({ artist: key, name: pack?.display_name || known?.name || key, indexed: isNaxV5Artist(key),
        aliases: pack ? json(pack.aliases_json, []) : known?.aliases || [], favorite: Boolean(pref?.favorite), note: pref?.note || '',
        danbooru: null, danbooruStatus: EMPTY_STATUS, observations: evidence.get(key) || [], exampleCount: images.length,
        coverUrl: cover ? imageUrl(cover.id, 'thumb', cover.storage) : '', coverModel: cover ? 'original' : '', coverSourceType: cover ? 'original' : '',
        coverExampleId: '', exampleModels: images.length ? ['original'] : [] });
    }
    cache = { revision, entries, examples: exampleMap };
    return cache;
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
    return { artist: key, name: pack?.display_name || known?.name || key, indexed: isNaxV5Artist(key),
      aliases: pack ? json(pack.aliases_json, []) : known?.aliases || [], favorite: Boolean(preference?.favorite), note: preference?.note || '',
      danbooru: null, danbooruStatus: EMPTY_STATUS, examples, observations, naxPreviews: [], naxExample: null,
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
      const { entries, examples } = await catalog();
      return listArtistsView(entries, examples, options, { model, sort, fail, thumbUrl: cover => imageUrl(cover.id, 'thumb', cover.storage) });
    },
    profile,
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
