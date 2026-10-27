// Artist style ranking over a decoded CLIP style index, shared by the server (src/style-index.js reads
// the three files from disk) and the app (one downloaded pack file). Pure: no node:*, no fs, no
// Buffer, so it runs in a WebView on ArrayBuffers.

export const STYLE_PACK_MAGIC = 'NAISTYL1';

function decodeFloats(b64) {
  const text = atob(b64), bytes = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i);
  return new Float32Array(bytes.buffer);
}
function normalize(v) { let n = 0; for (const x of v) n += x * x; n = Math.sqrt(n) || 1; for (let i = 0; i < v.length; i++) v[i] /= n; return v; }
const fail = (message, status) => Object.assign(new Error(message), { status });

// meta: meta.json; rows: images.json ([exampleId, artist][]); vectors: Uint8Array of vectors.bin
// (per row: dims int8 values, then a little-endian float32 scale).
export function decodeStyleIndex({ meta, rows, vectors: raw }) {
  const dims = meta.dims, stride = dims + 4;
  if (!raw || raw.byteLength !== rows.length * stride) throw fail('画风索引文件不完整。', 503);
  const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  const vectors = new Int8Array(rows.length * dims), scales = new Float32Array(rows.length);
  for (let i = 0; i < rows.length; i++) {
    vectors.set(new Int8Array(raw.buffer, raw.byteOffset + i * stride, dims), i * dims);
    scales[i] = view.getFloat32(i * stride + dims, true);
  }
  // Artist profiles: the normalised mean of the artist's image vectors (already centered offline).
  const artists = new Map();
  rows.forEach(([, artist], i) => { const entry = artists.get(artist) || { rows: [] }; entry.rows.push(i); artists.set(artist, entry); });
  const names = [...artists.keys()];
  const profiles = new Float32Array(names.length * dims);
  names.forEach((name, a) => {
    const entry = artists.get(name), profile = new Float32Array(dims);
    for (const i of entry.rows) { const s = scales[i], o = i * dims; for (let d = 0; d < dims; d++) profile[d] += vectors[o + d] * s; }
    normalize(profile); profiles.set(profile, a * dims); entry.profile = a;
  });
  const chips = new Map(meta.chips.map(chip => [chip.id, { ...chip, vector: decodeFloats(chip.vector) }]));
  return { meta, rows, dims, vectors, scales, artists, names, profiles, chips, hub: meta.hub || {}, tags: meta.tags || {},
    mean: meta.mean ? decodeFloats(meta.mean) : null, style: decodeStyleSpace(meta.style, rows.length, artists, names.length, dims),
    chipRanks: new Map(), cache: new Map() };
}

// Style space (1.8.3, scripts/style-index/style-projection.py): a learned linear map that keeps what
// separates artists and suppresses content and character design (vehicles, 4-koma, hair colour,
// hairstyle, outfit …). Likeness — 找相似, 以图找画师, 画风相近 — is measured there; feel words stay in
// CLIP space. Image vectors come precomputed (int8 + scale); only a query picture is projected.
// An index without it (older builds) keeps the CLIP-space likeness.
function decodeStyleSpace(style, count, artists, artistCount, dims) {
  if (!style?.matrix || !style.vectors || style.dims !== dims) return null;
  const k = style.k, matrix = decodeFloats(style.matrix), scales = decodeFloats(style.scales);
  const text = atob(style.vectors), vectors = new Int8Array(text.length);
  for (let i = 0; i < text.length; i++) vectors[i] = text.charCodeAt(i) << 24 >> 24;
  if (matrix.length !== dims * k || vectors.length !== count * k || scales.length !== count) return null;
  const profiles = new Float32Array(artistCount * k);
  for (const entry of artists.values()) {
    const profile = new Float32Array(k);
    for (const i of entry.rows) { const s = scales[i], o = i * k; for (let c = 0; c < k; c++) profile[c] += vectors[o + c] * s; }
    normalize(profile); profiles.set(profile, entry.profile * k);
  }
  return { k, matrix, vectors, scales, profiles, hub: style.hub || {} };
}
// A centred picture vector (centerQuery) into the style space.
function projectStyle(ix, centred) {
  const { k, matrix } = ix.style, out = new Float32Array(k);
  for (let d = 0; d < ix.dims; d++) { const v = centred[d]; if (!v) continue; const o = d * k; for (let c = 0; c < k; c++) out[c] += v * matrix[o + c]; }
  return normalize(out);
}

// The app's single-file pack: magic, uint32 LE header length, UTF-8 JSON { format, formatVersion,
// meta, rows }, then the vectors exactly as in vectors.bin.
export function readStylePack(buffer) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  const magic = String.fromCharCode(...bytes.subarray(0, 8));
  if (magic !== STYLE_PACK_MAGIC || bytes.byteLength < 12) throw fail('画风数据文件格式无效。', 400);
  const length = new DataView(bytes.buffer, bytes.byteOffset + 8, 4).getUint32(0, true);
  if (12 + length > bytes.byteLength) throw fail('画风数据文件不完整。', 400);
  const header = JSON.parse(new TextDecoder().decode(bytes.subarray(12, 12 + length)));
  if (header?.format !== 'nai-pocket-style-index' || header.formatVersion !== 1 || !Array.isArray(header.rows) || !Array.isArray(header.meta?.chips)) throw fail('画风数据文件格式无效。', 400);
  return { meta: header.meta, rows: header.rows, vectors: bytes.subarray(12 + length) };
}

// A picture's raw CLIP image embedding, moved into the index's space: normalised, centred on the
// library mean (as every indexed image was), normalised again. Null when the index has no mean.
export function centerQuery(ix, raw) {
  if (!ix.mean || !raw || raw.length !== ix.dims) return null;
  const v = normalize(Float32Array.from(raw));
  for (let d = 0; d < ix.dims; d++) v[d] -= ix.mean[d];
  return normalize(v);
}

const dotRow = (ix, i, q) => { let s = 0; const o = i * ix.dims; for (let d = 0; d < ix.dims; d++) s += ix.vectors[o + d] * q[d]; return s * ix.scales[i]; };
const dotProfile = (ix, a, q) => { let s = 0; const o = a * ix.dims; for (let d = 0; d < ix.dims; d++) s += ix.profiles[o + d] * q[d]; return s; };

export function styleIndexSummary(ix) {
  return { available: true, model: ix.meta.model, builtAt: ix.meta.builtAt, images: ix.rows.length, artists: ix.names.length,
    chips: [...ix.chips.values()].map(({ id, label, group }) => ({ id, label, group })) };
}
// An artist's standout vibe words (precomputed offline). Labels, not ids: a card shows them without
// loading the chip list.
export const vibeTagsOf = ix => artist => (ix.tags[artist] || []).map(id => ix.chips.get(id)?.label).filter(Boolean);

// Single-chip artist scores and the top-10% cut, cached per chip: which chosen words an artist "hits".
function chipRank(ix, id) {
  if (ix.chipRanks.has(id)) return ix.chipRanks.get(id);
  const q = ix.chips.get(id).vector, scores = new Map();
  for (const [name, entry] of ix.artists) {
    const best = entry.rows.map(i => dotRow(ix, i, q)).sort((a, b) => b - a).slice(0, 2);
    scores.set(name, best.reduce((s, x) => s + x, 0) / best.length);
  }
  const sorted = [...scores.values()].sort((a, b) => b - a);
  const result = { scores, cut: sorted[Math.floor(sorted.length * 0.1)] ?? Infinity };
  ix.chipRanks.set(id, result);
  return result;
}

// 画风概览 (1.8.2): how far each feel word stands out for one artist, as a z-score against every
// artist (profile · chip, per-chip mean and spread computed once per index), plus the closest artists.
// Strong words get bars; clearly-absent ones are named too ("不太像"). Nothing here is a verdict
// on quality: it says which words describe this artist's images more than most.
function chipStat(ix, chip) {
  let sum = 0, squares = 0;
  const scores = new Float32Array(ix.names.length);
  for (let a = 0; a < ix.names.length; a++) { const s = dotProfile(ix, a, chip.vector); scores[a] = s; sum += s; squares += s * s; }
  const mean = sum / ix.names.length;
  return { mean, std: Math.sqrt(Math.max(1e-12, squares / ix.names.length - mean * mean)), scores };
}
function chipStats(ix) {
  if (ix.chipStats) return ix.chipStats;
  const stats = ix.chipStatsPartial || new Map();
  for (const [id, chip] of ix.chips) if (!stats.has(id)) stats.set(id, chipStat(ix, chip));
  ix.chipStats = stats; delete ix.chipStatsPartial;
  return stats;
}
// The same statistics one word per call, for a warm-up that yields between words; true when complete.
export function chipStatsStep(ix) {
  if (ix.chipStats) return true;
  const stats = ix.chipStatsPartial ||= new Map();
  for (const [id, chip] of ix.chips) if (!stats.has(id)) { stats.set(id, chipStat(ix, chip)); return false; }
  ix.chipStats = stats; delete ix.chipStatsPartial;
  return true;
}
export function styleProfileOf(ix, artist, { strong = 6, weak = 3, similar = 6 } = {}) {
  const entry = ix.artists.get(artist);
  if (!entry) return null;
  const stats = chipStats(ix);
  const words = [...ix.chips.values()].map(({ id, label, group }) => {
    const { mean, std, scores } = stats.get(id);
    return { id, label, group, z: Math.round(((scores[entry.profile] - mean) / std) * 100) / 100 };
  }).sort((a, b) => b.z - a.z);
  const near = [...rankStyle(ix, { like: artist })].sort((a, b) => b[1].score - a[1].score).slice(0, similar)
    .map(([name, item]) => ({ artist: name, exampleId: item.exampleId }));
  return { images: entry.rows.length, strengths: words.filter(word => word.z >= 0.8).slice(0, strong),
    weaknesses: words.filter(word => word.z <= -1.2).slice(-weak).reverse(), similar: near };
}

// Parse "dreamy,watercolor,-painterly" into wanted and avoided chips; unknown ids are an error.
export function parseVibe(text, ix) {
  const want = [], avoid = [];
  for (const token of String(text || '').split(',').map(item => item.trim()).filter(Boolean).slice(0, 12)) {
    const negative = token.startsWith('-'), id = negative ? token.slice(1) : token;
    if (!ix?.chips.has(id)) throw fail('未知的画风感觉词。', 400);
    (negative ? avoid : want).push(id);
  }
  return { want, avoid };
}

// 混合 (1.9.17): the originals' likeness plus the V5 samples' (scripts/style-index on the owner's V5
// single-artist samples, DATA_DIR/style-index-v5). Measured on 1,319 other people's single-artist V5
// pictures: true artist in the top 10 10.3% (originals) / 7.0% (V5 alone) / 14.6% (both), median rank
// 568 → 304; for feel words the picked artists' V5 pictures showed the word 0.78 / 0.68 / 1.03 (z).
// Each source is put on one scale per query (z-score over its artists), and an artist with both gets
// the sum rescaled to the same spread (1.9.25). Summing raw scores and doubling a lone one made a lone
// score twice as spread out, so artists with only originals took the top of every list once ~10k of
// them had no V5 sample (new-artist share of the top 20: 94% for a 44% share of the library).
// Cover and hits come from the originals (the V5 ranking when there are no originals).
const zScale = map => {
  let n = 0, sum = 0, squares = 0;
  for (const { score } of map.values()) { n += 1; sum += score; squares += score * score; }
  const mean = n ? sum / n : 0, spread = n ? Math.sqrt(Math.max(1e-12, squares / n - mean * mean)) : 1;
  return score => (score - mean) / spread;
};
export function mixStyleRanks(originals, samples) {
  if (!samples) return originals;
  if (!originals) return samples;
  const zo = zScale(originals), zv = zScale(samples);
  let n = 0, sum = 0, squares = 0;
  for (const [name, item] of originals) {
    const other = samples.get(name); if (!other) continue;
    const both = zo(item.score) + zv(other.score); n += 1; sum += both; squares += both * both;
  }
  const spread = n > 1 ? Math.sqrt(Math.max(1e-12, squares / n - (sum / n) ** 2)) : Math.SQRT2;
  const mixed = new Map();
  for (const [name, item] of originals) {
    const other = samples.get(name);
    mixed.set(name, { ...item, score: other ? (zo(item.score) + zv(other.score)) / spread : zo(item.score) });
  }
  for (const [name, item] of samples) if (!mixed.has(name)) mixed.set(name, { ...item, score: zv(item.score) });
  return mixed;
}

// Rank artists. `vibe`: chip ids (prefix "-" to avoid). `like`: an artist name. `image`: a picture,
// { key, vector } with the vector from centerQuery; it is "like" with an outside target. Combinable
// with vibe; like and image are alternatives (image wins).
// Returns Map(artist -> { score, exampleId, hits? }) over every indexed artist.
export function rankStyle(ix, { vibe = '', like = '', image = null } = {}) {
  if (image) like = '';
  const key = `${vibe}|${like}|${image?.key || ''}`;
  if (ix.cache.has(key)) return ix.cache.get(key);
  const { want, avoid } = parseVibe(vibe, ix);
  const scores = new Map();
  if (want.length || avoid.length) {
    // Wanted chips add, avoided chips subtract (at 0.7: "not this" should push down, not dominate).
    const q = new Float32Array(ix.dims);
    for (const id of want) ix.chips.get(id).vector.forEach((v, d) => { q[d] += v; });
    for (const id of avoid) ix.chips.get(id).vector.forEach((v, d) => { q[d] -= 0.7 * v; });
    normalize(q);
    // An artist is as good as their two best-matching images: one stray image should not carry an
    // artist, and an artist's weaker works should not hide a clear match.
    for (const [name, entry] of ix.artists) {
      const ranked = entry.rows.map(i => ({ i, s: dotRow(ix, i, q) })).sort((a, b) => b.s - a.s);
      const top = ranked.slice(0, 2);
      scores.set(name, { score: top.reduce((sum, item) => sum + item.s, 0) / top.length, exampleId: ix.rows[ranked[0].i][0] });
    }
    // Which of the wanted chips each artist hits on its own (top 10% for that chip): the card shows
    // them, so a blend of several words can be read back per artist.
    const ranks = want.map(id => [id, chipRank(ix, id)]);
    for (const [name, entry] of scores) entry.hits = ranks.filter(([, rank]) => rank.scores.get(name) >= rank.cut).map(([id]) => id);
  }
  if (like || image) {
    const target = like ? ix.artists.get(like) : null;
    if (like && !target) throw fail('这位画师还没有画风索引。', 404);
    // In the style space when the index has one, else in CLIP space (same scoring either way).
    const space = ix.style ? { k: ix.style.k, profiles: ix.style.profiles, vectors: ix.style.vectors, scales: ix.style.scales, hub: ix.style.hub }
      : { k: ix.dims, profiles: ix.profiles, vectors: ix.vectors, scales: ix.scales, hub: ix.hub };
    const q = image ? (ix.style ? projectStyle(ix, image.vector) : image.vector) : space.profiles.subarray(target.profile * space.k, (target.profile + 1) * space.k);
    const dotP = a => { let s = 0; const o = a * space.k; for (let c = 0; c < space.k; c++) s += space.profiles[o + c] * q[c]; return s; };
    const dotR = i => { let s = 0; const o = i * space.k; for (let c = 0; c < space.k; c++) s += space.vectors[o + c] * q[c]; return s * space.scales[i]; };
    const vibeActive = scores.size > 0;
    for (const [name, entry] of ix.artists) {
      if (name === like) continue;
      // Hub-corrected (CSLS, precomputed offline): an artist close to everyone is pushed down.
      const similarity = 2 * dotP(entry.profile) - (space.hub[name] || 0);
      const prior = scores.get(name);
      // The cover is the candidate's image closest to the target (artist or picture), so the card shows the likeness.
      let best = entry.rows[0], bestScore = -Infinity;
      for (const i of entry.rows) { const s = dotR(i); if (s > bestScore) { bestScore = s; best = i; } }
      // With chips as well, both count; the similarity scale is larger, so it is quartered.
      scores.set(name, { score: vibeActive ? prior.score + similarity * 0.25 : similarity, exampleId: vibeActive ? prior.exampleId : ix.rows[best][0] });
    }
    if (like) scores.delete(like);
  }
  if (ix.cache.size > 30) ix.cache.delete(ix.cache.keys().next().value);
  ix.cache.set(key, scores);
  return scores;
}

// 依据 over one or two indexes (shared by the website and the app, 1.9.41): 混合 = the originals plus the
// V5 samples, each on its own scale; 'v5' = the samples alone (the originals when an artist has none);
// 原作 = pass no samples. `image.vector` is the picture's raw CLIP embedding; each index centres it on its
// own mean. Returns Map(artist -> { score, exampleId, hits }).
export function rankStyleSources(ix, samples, { vibe = '', like = '', image = null, source = 'mix', unsupported = '画风索引不支持以图找画师，请重建索引。' } = {}) {
  const v5 = source === 'originals' ? null : samples || null;
  const rank = (index, optional) => {
    const vector = image ? centerQuery(index, image.vector) : null;
    if (image && !vector) {
      if (optional) return null;
      throw fail(unsupported, 503);
    }
    try { return rankStyle(index, { vibe, like, image: vector ? { key: image.key, vector } : null }); }
    catch (error) { if (optional && error.status === 404) return null; throw error; }
  };
  if (source === 'v5' && v5) return rank(v5, true) || rank(ix, false);
  return mixStyleRanks(rank(ix, false), v5 ? rank(v5, true) : null);
}

// Storm candidates (1.9.27; shared with the app in 1.9.41): artists to try beside the current mix.
// 风格相近 (near) samples from the artists closest to the mix as a whole (each mix artist's 找相似
// ranking, z-scored and summed); 换换口味 (far) from further down the same ranking; 随机 (random) from
// everyone. With the V5 samples' index present, only artists V5 has drawn are offered (it knows the name).
// `randomInt(n)` returns an integer in [0, n).
const STORM_NEAR = [0, 60], STORM_FAR = [250, 1500];
export function stormCandidatesOf(ix, samples, { artists = [], source = 'near', count = 8, exclude = [] } = {}, randomInt = n => Math.floor(Math.random() * n)) {
  const known = samples ? new Set(samples.names) : null;
  const key = name => String(name || '').replace(/^artist\s*:\s*/i, '').trim().toLowerCase();
  const skip = new Set([...artists, ...exclude].map(key));
  const eligible = name => ix.artists.has(name) && (!known || known.has(name)) && !skip.has(key(name));
  const present = ix.names.filter(name => artists.some(artist => key(artist) === key(name)));
  let pool;
  if (source !== 'random' && present.length) {
    const total = new Map();
    for (const name of present) {
      const ranked = rankStyleSources(ix, samples, { like: name });
      let n = 0, sum = 0, squares = 0;
      for (const { score } of ranked.values()) { n += 1; sum += score; squares += score * score; }
      const mean = sum / n, spread = Math.sqrt(Math.max(1e-12, squares / n - mean * mean));
      for (const [other, item] of ranked) total.set(other, (total.get(other) || 0) + (item.score - mean) / spread);
    }
    const order = [...total].filter(([name]) => eligible(name)).sort((a, b) => b[1] - a[1]).map(([name]) => name);
    const [from, to] = source === 'far' ? STORM_FAR : STORM_NEAR;
    pool = order.slice(from, to);
  } else pool = ix.names.filter(eligible);
  const picked = [];
  const bag = [...pool];
  const size = Math.max(1, Math.min(30, Math.round(Number(count) || 8)));
  while (bag.length && picked.length < size) picked.push(bag.splice(randomInt(bag.length), 1)[0]);
  return { source: source !== 'random' && !present.length ? 'random' : source, basedOn: present, knownOnly: Boolean(known),
    artists: picked.map(name => ({ artist: name, exampleId: ix.rows[ix.artists.get(name).rows[0]][0] })) };
}
