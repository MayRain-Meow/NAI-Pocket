// A tiny synthetic 画风数据 file (public/style-rank.js pack format) for the app tests: 4-dim vectors,
// one chip per axis, artists and example ids chosen by the caller. Not real CLIP data.
import crypto from 'node:crypto';
import { STYLE_PACK_MAGIC } from '../public/style-rank.js';

const DIMS = 4;
const floats = values => Buffer.from(new Float32Array(values).buffer).toString('base64');
export const STYLE_FIXTURE_CHIPS = Object.freeze([
  { id: 'watercolor', label: '水彩', group: '画法', axis: 0 },
  { id: 'gloomy', label: '暗调阴郁', group: '氛围', axis: 2 }
]);

// images: [[exampleId, artist, [x, y, z, w] int8]]
export function stylePackFixture(images, { version = 'fixture-1', tags = {}, base = 'https://github.com/MayRain-Meow/NAI-Pocket/releases/download/artist-style-fixture' } = {}) {
  const rows = images.map(([id, artist]) => [id, artist]);
  const vectors = Buffer.alloc(images.length * (DIMS + 4));
  images.forEach(([, , values], i) => { values.forEach((v, d) => vectors.writeInt8(v, i * (DIMS + 4) + d)); vectors.writeFloatLE(1 / 127, i * (DIMS + 4) + DIMS); });
  const chips = STYLE_FIXTURE_CHIPS.map(({ id, label, group, axis }) => ({ id, label, group, vector: floats([0, 1, 2, 3].map(d => d === axis ? 1 : 0)) }));
  const meta = { version: 1, model: 'fixture', dims: DIMS, count: rows.length, artists: new Set(rows.map(row => row[1])).size, builtAt: 1, hub: {}, tags, chips, mean: floats([0, 0, 0, 0]) };
  const header = Buffer.from(JSON.stringify({ format: 'nai-pocket-style-index', formatVersion: 1, version, meta, rows }));
  const length = Buffer.alloc(4); length.writeUInt32LE(header.length);
  const bytes = Buffer.concat([Buffer.from(STYLE_PACK_MAGIC), length, header, vectors]);
  const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
  const manifest = { format: 'nai-pocket-style-manifest', formatVersion: 1, version, model: 'fixture', builtAt: 1, images: rows.length, artists: meta.artists,
    chips: chips.length, file: { url: `${base}/style-index-${version}.bin`, bytes: bytes.length, sha256 } };
  return { bytes, sha256, manifest };
}
