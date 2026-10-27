import { normalizeArtistIdentity } from './artist-index-v5.js?v=1.9.42';

const round = (value, digits = 2) => {
  const scale = 10 ** digits;
  return Math.round((Number(value) + Number.EPSILON) * scale) / scale;
};

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

function hashText(value) {
  let hash = 2166136261;
  for (const char of String(value || '')) {
    hash ^= char.codePointAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function mulberry32(seed) {
  let value = seed >>> 0;
  return () => {
    value += 0x6d2b79f5;
    let result = value;
    result = Math.imul(result ^ (result >>> 15), result | 1);
    result ^= result + Math.imul(result ^ (result >>> 7), result | 61);
    return ((result ^ (result >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffledIndexes(count, seed) {
  const indexes = Array.from({ length: count }, (_, index) => index);
  const random = mulberry32(seed);
  for (let index = indexes.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(random() * (index + 1));
    [indexes[index], indexes[swapIndex]] = [indexes[swapIndex], indexes[index]];
  }
  return indexes;
}

function stratifiedIndexes(count, seed, anchorIndex) {
  const result = Array(count).fill(-1);
  const positions = Array.from({ length: count }, (_, index) => index).filter(index => index !== anchorIndex);
  const shuffled = shuffledIndexes(positions.length, seed).map(index => positions[index]);
  if (anchorIndex >= 0) result[anchorIndex] = anchorIndex;
  if (positions.length > 1 && positions.every((position, index) => shuffled[index] === position)) shuffled.push(shuffled.shift());
  positions.forEach((position, index) => { result[position] = shuffled[index]; });
  return result;
}

export function artistStormLevels(count, delta) {
  const safeCount = clamp(Math.round(Number(count) || 7), 2, 10000);
  const safeDelta = clamp(Math.abs(Number(delta) || 0.3), 0.01, 10);
  const levels = Array.from({ length: safeCount }, (_, index) =>
    round(-safeDelta + (2 * safeDelta * index) / (safeCount - 1), 4));
  if (!levels.some(value => Math.abs(value) < 0.0001)) {
    const closest = levels.reduce((best, value, index) => Math.abs(value) < Math.abs(levels[best]) ? index : best, 0);
    levels[closest] = 0;
    levels.sort((a, b) => a - b);
  }
  return levels;
}

// Artist rotation: every other prompt tag is held fixed and only the `artist:`
// entry changes, so the resulting images differ by artist alone. Artists are
// ordered favourites first, then by how much work upstream holds for them, which
// keeps a rotation focused on the most substantial references.
// Identity key for rotation selection: case and separators are irrelevant, so
// "Horn/Wood", "horn_wood" and "horn wood" are one artist. Letters and digits are
// kept as-is, which includes CJK names — stripping all non-ASCII would collapse
// unrelated Japanese or Chinese artists into one entry.
export function selectionKey(value) {
  return normalizeArtistIdentity(value).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
}

export function orderRotationArtists(candidates = [], options = {}) {
  const max = clamp(Math.round(Number(options.max) || 0) || candidates.length, 1, 10000);
  // Favourites lead only when asked for; a pure "most work upstream" scope must
  // not be reordered by the local favourite flag.
  const favoritesFirst = options.favoritesFirst !== false;
  // Artists that have never produced a rotation image come first, so a later run
  // widens coverage instead of repeating the artists that already have samples.
  const pendingFirst = options.pendingFirst !== false;
  const seen = new Set();
  const ordered = [];
  for (const candidate of Array.isArray(candidates) ? candidates : []) {
    const artist = String(candidate?.artist || candidate?.name || '').trim().slice(0, 160);
    if (!artist) continue;
    const key = selectionKey(artist);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const rotationImages = Number(candidate?.rotationImages);
    ordered.push({
      artist,
      favorite: candidate?.favorite === true,
      postCount: Number.isSafeInteger(Number(candidate?.postCount)) && Number(candidate.postCount) >= 0 ? Number(candidate.postCount) : null,
      exampleCount: Number.isSafeInteger(Number(candidate?.exampleCount)) && Number(candidate.exampleCount) >= 0 ? Number(candidate.exampleCount) : 0,
      rotationImages: Number.isSafeInteger(rotationImages) && rotationImages >= 0 ? rotationImages : 0
    });
  }
  // Never-generated first, then favourites, then the artists upstream holds the
  // most work for. A missing post count sorts after a real one, not as zero.
  ordered.sort((a, b) => (pendingFirst ? a.rotationImages - b.rotationImages : 0)
    || (favoritesFirst ? Number(b.favorite) - Number(a.favorite) : 0)
    || (a.postCount === null ? 1 : 0) - (b.postCount === null ? 1 : 0)
    || (b.postCount || 0) - (a.postCount || 0)
    || a.artist.localeCompare(b.artist, 'en'));
  return ordered.slice(0, max);
}

// Expands an artist list into one entry per image, artists cycling evenly so a
// run never spends its whole budget on the first few names.
export function buildArtistRotationPlan(artists = [], options = {}) {
  const list = Array.isArray(artists) ? artists.filter(item => item?.artist) : [];
  if (!list.length) throw new Error('没有可用于轮换的画师。');
  const perArtist = clamp(Math.round(Number(options.perArtist) || 1), 1, 50);
  const maxImages = clamp(Math.round(Number(options.maxImages) || list.length), 1, 10000);
  const perArtistSafe = Math.min(perArtist, maxImages);
  const entries = [];
  for (let round = 0; round < perArtistSafe && entries.length < maxImages; round += 1) {
    for (const item of list) {
      if (entries.length >= maxImages) break;
      entries.push({ artist: item.artist, favorite: item.favorite === true, postCount: item.postCount ?? null, round: round + 1 });
    }
  }
  return { artists: list.length, perArtist: perArtistSafe, maxImages, count: entries.length, entries };
}

export function buildArtistStormPlan(rawArtists, options = {}) {  if (Array.isArray(rawArtists) && rawArtists.length > 30) throw new Error('Storm 一次最多比较 30 位画师，请先减少启用的画师。');
  const artists = (Array.isArray(rawArtists) ? rawArtists : []).map((artist, index) => ({
    id: String(artist?.id || `artist-${index + 1}`).slice(0, 120),
    text: String(artist?.text || '').trim().slice(0, 300),
    baseWeight: clamp(Number.isFinite(Number(artist?.weight)) ? Number(artist.weight) : 1, -10, 10)
  })).filter(artist => artist.text);
  if (!artists.length) throw new Error('当前没有可用于 Storm 的画师 Tag。');
  if (new Set(artists.map(item => item.id)).size !== artists.length) throw new Error('画师 Tag 标识重复，请重新添加重复的卡片。');
  const identities = new Set(artists.map(item => normalizeArtistIdentity(item.text)));
  const externalArtists = [];
  for (const candidate of (Array.isArray(options.externalArtists) ? options.externalArtists : []).slice(0, 50)) {
    const raw = String(candidate?.text || candidate?.artist || candidate || '').trim().slice(0, 300);
    const identity = normalizeArtistIdentity(raw);
    if (!identity || identities.has(identity)) continue;
    identities.add(identity);
    externalArtists.push({ text: /^artist\s*:/i.test(raw) ? raw : `artist:${raw}`, weight: 1 });
  }

  // mix: every artist visits every level once, shuffled; linked: all artists move together;
  // solo (1.9.27): one artist at a time, up then down; add (1.9.27): weights kept, one candidate each.
  const mode = ['linked', 'solo', 'add'].includes(options.mode) ? options.mode : 'mix';
  if (mode === 'add' && !externalArtists.length) throw new Error('先选几位要试的画师。');
  const variantRow = (variantIndex, isBaseline, externalArtist, offsetOf) => ({
    index: variantIndex + 1, isBaseline, externalArtist,
    weights: artists.map((artist, artistIndex) => {
      const offset = isBaseline ? 0 : offsetOf(artistIndex);
      return { id: artist.id, text: artist.text, baseWeight: artist.baseWeight, offset: round(offset),
        weight: isBaseline ? artist.baseWeight : round(clamp(artist.baseWeight + offset, -10, 10)) };
    })
  });
  let variants, levels, baselineIndex;
  if (mode === 'solo' || mode === 'add') {
    const delta = clamp(Math.abs(Number(options.delta) || 0.3), 0.01, 10);
    levels = mode === 'solo' ? [-delta, 0, delta] : [0];
    baselineIndex = 0;
    const rows = [variantRow(0, true, null, () => 0)];
    if (mode === 'solo') {
      let externalIndex = 0;
      artists.forEach((_, chosen) => [delta, -delta].forEach(offset => rows.push(variantRow(rows.length, false,
        externalArtists.length ? externalArtists[externalIndex++ % externalArtists.length] : null, artistIndex => artistIndex === chosen ? offset : 0))));
    } else externalArtists.forEach(external => rows.push(variantRow(rows.length, false, external, () => 0)));
    variants = rows;
  } else if (mode === 'mix' && Number.isInteger(options.roll) && options.roll >= 0) {
    // A real roll (1.9.28): for each artist, one offset per stratum of the ±delta range (a batch still
    // reaches from low to high), at a random point inside the stratum, in a random order per artist.
    // Steps of 0.01 (1.9.34; 0.05 left one artist only ~12 distinct weights at ±0.3, so most of a large
    // batch merged as duplicates); the baseline (the editor's weights) stays as #1 for reference.
    const delta = clamp(Math.abs(Number(options.delta) || 0.3), 0.01, 10);
    const n = clamp(Math.round(Number(options.count) || 7), 2, 10000) - 1;
    const random = mulberry32(options.roll >>> 0);
    const offsets = artists.map(() => {
      const order = Array.from({ length: n }, (_, index) => index);
      for (let index = n - 1; index > 0; index -= 1) { const swap = Math.floor(random() * (index + 1)); [order[index], order[swap]] = [order[swap], order[index]]; }
      return order.map(stratum => clamp(Math.round((-delta + (2 * delta * (stratum + random())) / n) * 100) / 100, -delta, delta));
    });
    levels = [-delta, delta];
    baselineIndex = 0;
    let externalIndex = 0;
    variants = [variantRow(0, true, null, () => 0), ...Array.from({ length: n }, (_, index) => variantRow(index + 1, false,
      externalArtists.length ? externalArtists[externalIndex++ % externalArtists.length] : null, artistIndex => offsets[artistIndex][index]))];
  } else {
  levels = artistStormLevels(options.count, options.delta);
  baselineIndex = levels.findIndex(value => Math.abs(value) < 0.0001);
  const permutations = artists.map((artist, artistIndex) => {
    if (mode === 'linked' || artistIndex === 0) return levels.map((_, index) => index);
    return stratifiedIndexes(levels.length, hashText(`${artist.id}|${artist.text}|${artistIndex}|${levels.length}`), baselineIndex);
  });

  let externalIndex = 0;
  variants = levels.map((_, variantIndex) => ({
    index: variantIndex + 1,
    isBaseline: variantIndex === baselineIndex,
    externalArtist: variantIndex === baselineIndex || !externalArtists.length ? null : externalArtists[externalIndex++ % externalArtists.length],
    weights: artists.map((artist, artistIndex) => {
      const offset = levels[permutations[artistIndex][variantIndex]];
      return {
        id: artist.id,
        text: artist.text,
        baseWeight: artist.baseWeight,
        offset: round(offset),
        weight: variantIndex === baselineIndex ? artist.baseWeight : round(clamp(artist.baseWeight + offset, -10, 10))
      };
    })
  }));
  }

  // The UI and queue use the same effective (hundredth-precision) plan. Prefer
  // the true baseline when clamping creates an identical non-baseline row.
  const keyFor = variant => JSON.stringify([variant.weights.map(item => item.weight), variant.externalArtist?.text || '']);
  const baselineKey = keyFor(variants[baselineIndex]);
  const seen = new Set();
  const unique = variants.filter(variant => {
    const key = keyFor(variant);
    if ((!variant.isBaseline && key === baselineKey) || seen.has(key)) return false;
    seen.add(key);
    return true;
  }).map((variant, index) => ({ ...variant, index: index + 1 }));

  return {
    mode,
    count: unique.length,
    requestedCount: variants.length,
    delta: round(Math.max(...levels.map(Math.abs))),
    levels: levels.map(value => round(value)),
    baselineIndex: unique.findIndex(item => item.isBaseline) + 1,
    artists,
    externalArtists,
    variants: unique
  };
}

export function collectPositiveRecommendationTags(state = {}) {
  const tags = ['scene', 'camera', 'style', 'misc'].flatMap(key => state.groups?.[key] || []);
  for (const character of state.characters || []) {
    if (character.enabled !== false) tags.push(...(character.promptTags || []));
  }
  return [...new Set(tags.filter(tag => tag.enabled !== false && tag.text)
    .map(tag => String(tag.text).trim().replace(/^artist\s*:\s*/i, '').replace(/\s+/g, '_').toLowerCase()).filter(Boolean))];
}

