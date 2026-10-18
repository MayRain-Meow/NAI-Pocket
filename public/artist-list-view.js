// The artist library's list page rules: option checks, admission through the shared filter,
// sort order, paging and cover choice. The Node server and the Android app both serve the
// same artist-library UI, so both build their catalog and then call this module; neither keeps
// its own copy of the ordering or cover rules.
import { filterArtistCatalog, usableObservations } from './artist-catalog.js?v=1.8.8';

export const ARTIST_LIST_MODELS = new Set(['v5', 'v4.5', 'v4', 'v3', 'original', 'unknown']);
export const ARTIST_LIST_SORTS = new Set(['default', 'posts', 'danbooru_created', 'examples', 'relevance']);

const defaultFail = (message, status = 400) => Object.assign(new Error(message), { status });
const compareNames = (a, b) => String(a.artist).localeCompare(String(b.artist), 'en');

// Descending comparison for one optional numeric parameter. A null/undefined
// value always sorts last, so "not synced" never outranks a real value.
export function compareOptionalDesc(a, b, compareTies) {
  const left = a ?? null, right = b ?? null;
  if (left === null && right === null) return compareTies();
  if (left === null) return 1;
  if (right === null) return -1;
  return right - left || compareTies();
}

export function coverExample(examples = [], preferredId = '') {
  const source = item => item?.sourceType ?? item?.source_type ?? '';
  const rotation = item => Boolean(item?.rotationSample ?? item?.rotation_sample);
  if (preferredId) {
    const chosen = examples.find(item => item?.id === preferredId);
    if (chosen) return chosen;
  }
  return examples.find(item => source(item) !== 'nax' && !rotation(item))
    || examples.find(item => source(item) !== 'nax')
    || examples[0] || null;
}

// Validated before any catalog work, in the order the server always used.
export function artistListOptions(options = {}, fail = defaultFail) {
  const model = String(options.model || '');
  if (model && !ARTIST_LIST_MODELS.has(model)) throw fail('模型筛选无效。');
  const sort = options.sort === undefined || options.sort === '' ? 'default' : String(options.sort);
  if (!ARTIST_LIST_SORTS.has(sort)) throw fail('画师排序方式无效。');
  return { model, sort };
}

// True when admission needs every artist's observations, not only the visible page's.
export const artistListNeedsEvidence = (options = {}, model = '') => Boolean(options.query || model || options.annotated || options.confirmedOnly
  || Object.keys(options.facets || {}).length || Object.keys(options.attributes || {}).length);

// `catalog`: entries shaped like the server's catalog entries. `examples`: Map of artist to
// example rows ({ id, model, source_type, rotation_sample, ... }). `thumbUrl(cover)` builds the
// host's thumbnail route for the chosen cover.
// `styleRank` (optional): Map(artist -> { score, exampleId }) from the style index ("按感觉找" or
// "像这位画师"). When given, only ranked artists are admitted, they are ordered by that score, and the
// best-matching example becomes the cover so the card shows why it was picked.
export function listArtistsView(catalog, examples, options = {}, { model = '', sort = 'default', fail = defaultFail,
  thumbUrl = cover => `/api/artists/examples/${cover.id}/thumb`, styleRank = null, vibeTags = null } = {}) {
  let filtered;
  // `relevance` is the only sort that changes WHICH artists are admitted, because it
  // turns the exact all-in-one-example filter into a ranked partial match. Every
  // other sort keeps filtering exactly as before.
  const relevance = sort === 'relevance';
  try { filtered = filterArtistCatalog(catalog, { ...options, model, rank: relevance }); } catch (error) { throw fail(error.message); }
  const styleMatches = filtered.styleMatches || new Map();
  if (styleRank) filtered.artists = filtered.artists.filter(artist => styleRank.has(artist.artist));
  const scoreOf = artist => styleMatches.get(artist.artist)?.score || 0;
  if (styleRank) filtered.artists.sort((a, b) => styleRank.get(b.artist).score - styleRank.get(a.artist).score || compareNames(a, b));
  else filtered.artists.sort(sort === 'posts' ? (a, b) => compareOptionalDesc(a.danbooru?.postCount, b.danbooru?.postCount, () => compareNames(a, b))
    : sort === 'danbooru_created' ? (a, b) => compareOptionalDesc(a.danbooru?.createdAt, b.danbooru?.createdAt, () => compareNames(a, b))
      : sort === 'examples' ? (a, b) => b.exampleCount - a.exampleCount || Number(b.favorite) - Number(a.favorite) || compareNames(a, b)
        : sort === 'relevance' ? (a, b) => scoreOf(b) - scoreOf(a) || Number(b.favorite) - Number(a.favorite) || b.exampleCount - a.exampleCount || compareNames(a, b)
          : (a, b) => Number(b.favorite) - Number(a.favorite) || b.exampleCount - a.exampleCount || compareNames(a, b));
  const offset = Math.min(filtered.artists.length, Math.max(0, Math.floor(Number(options.offset) || 0)));
  const limit = Math.min(80, Math.max(1, Math.floor(Number(options.limit) || 40)));
  const visible = filtered.artists.slice(offset, offset + limit).map(profile => {
    // Default browse skips observations during admission; only this page needs
    // them, for cover choice and the three chips. Facet/search already filled the map.
    
    const matching = filtered.matchedObservations.has(profile.artist)
      ? (filtered.matchedObservations.get(profile.artist) || [])
      : usableObservations(profile, options).filter(item => !model || item.model === model);
    const images = examples.get(profile.artist) || [];
    // Tier order is unchanged: an evidence-matching example wins, then a
    // model-matching one. Within a tier a NAX sample no longer wins the cover, but
    // an explicit model filter still shows that model's example as before.
    const evidenceMatches = images.filter(image => matching.some(item => item.exampleId === image.id));
    const modelMatches = images.filter(image => !model || image.model === model);
    // A chosen cover wins inside each tier, so an explicit pick is respected
    // without breaking the model filter's meaning.
    const chosen = String(profile.coverExampleId || '');
    const styleCover = styleRank ? images.find(image => image.id === styleRank.get(profile.artist)?.exampleId) : null;
    const cover = styleCover || coverExample(evidenceMatches, chosen) || coverExample(modelMatches, chosen) || coverExample(images, chosen);
    return { ...profile,
      styleMatch: styleMatches.get(profile.artist) || null,
      ...(styleRank?.get(profile.artist)?.hits ? { styleHits: styleRank.get(profile.artist).hits } : {}),
      ...(vibeTags ? { vibeTags: vibeTags(profile.artist) } : {}),
      coverUrl: cover ? thumbUrl(cover) : '', coverModel: cover?.model || '', coverSourceType: cover?.source_type || '',
      coverIsChosen: Boolean(chosen && cover?.id === chosen), observations: matching.filter(item => item.exampleId === cover?.id) };
  });
  // The classification travels as ONE nested object (see the server history for why it is nested).
  return { artists: visible, total: filtered.artists.length, offset, limit, sort, report: filtered.report,
    ranked: Boolean(filtered.ranked), styleRanked: Boolean(styleRank) };
}
