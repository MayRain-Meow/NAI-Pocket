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
  return { meta, rows, dims, vectors, scales, artists, names, profiles, chips, hub: meta.hub || {}, tags: meta.tags || {}, chipRanks: new Map(), cache: new Map() };
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

// Rank artists. `vibe`: chip ids (prefix "-" to avoid). `like`: an artist name. Either or both.
// Returns Map(artist -> { score, exampleId, hits? }) over every indexed artist.
export function rankStyle(ix, { vibe = '', like = '' } = {}) {
  const key = `${vibe}|${like}`;
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
  if (like) {
    const target = ix.artists.get(like);
    if (!target) throw fail('这位画师还没有画风索引。', 404);
    const q = ix.profiles.subarray(target.profile * ix.dims, (target.profile + 1) * ix.dims);
    const vibeActive = scores.size > 0;
    for (const [name, entry] of ix.artists) {
      if (name === like) continue;
      // Hub-corrected (CSLS, precomputed offline): an artist close to everyone is pushed down.
      const similarity = 2 * dotProfile(ix, entry.profile, q) - (ix.hub[name] || 0);
      const prior = scores.get(name);
      // The cover is the candidate's image closest to the target artist, so the card shows the likeness.
      let best = entry.rows[0], bestScore = -Infinity;
      for (const i of entry.rows) { const s = dotRow(ix, i, q); if (s > bestScore) { bestScore = s; best = i; } }
      // With chips as well, both count; the similarity scale is larger, so it is quartered.
      scores.set(name, { score: vibeActive ? prior.score + similarity * 0.25 : similarity, exampleId: vibeActive ? prior.exampleId : ix.rows[best][0] });
    }
    scores.delete(like);
  }
  if (ix.cache.size > 30) ix.cache.delete(ix.cache.keys().next().value);
  ix.cache.set(key, scores);
  return scores;
}
