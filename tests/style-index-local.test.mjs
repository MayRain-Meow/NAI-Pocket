// The app's 画风数据: one downloaded file read by the shared ranker, and the local /api/artists answers
// (vibe / like / styleIndex / vibeTags) matching the server's shapes.
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { STYLE_PACK_MAGIC, readStylePack, decodeStyleIndex, rankStyle } from '../public/style-rank.js';
import { createLocalStyleIndex, validateStyleManifest } from '../service/style-index-local.js';
import { APP_SCHEMA } from '../service/storage/schema.js';
import { createArtistLibraryView } from '../service/artist-library-view.js';
import { createArtistLibraryViewStore } from '../service/storage/artist-library-view.js';
import { createArtistBrowserStore } from '../service/storage/artist-browser.js';

// A 4-dim index: two "watercolor" artists, one "dark" artist; chip vectors point along the axes.
const dims = 4, floats = values => Buffer.from(new Float32Array(values).buffer).toString('base64');
const rows = [['a1', 'alpha'], ['a2', 'alpha'], ['b1', 'beta'], ['c1', 'gamma']];
const raw = [[120, 10, 0, 0], [100, 30, 0, 0], [90, 60, 0, 0], [0, 0, 127, 0]];
const vectors = Buffer.alloc(rows.length * (dims + 4));
raw.forEach((values, i) => { values.forEach((v, d) => vectors.writeInt8(v, i * (dims + 4) + d)); vectors.writeFloatLE(1 / 127, i * (dims + 4) + dims); });
const meta = { version: 1, model: 'test', dims, count: 4, artists: 3, builtAt: 1, hub: {}, tags: { alpha: ['watercolor'] },
  chips: [{ id: 'watercolor', label: '水彩', group: '画法', vector: floats([1, 0, 0, 0]) }, { id: 'gloomy', label: '暗调阴郁', group: '氛围', vector: floats([0, 0, 1, 0]) }] };
const header = Buffer.from(JSON.stringify({ format: 'nai-pocket-style-index', formatVersion: 1, version: 't', meta, rows }));
const length = Buffer.alloc(4); length.writeUInt32LE(header.length);
const file = Buffer.concat([Buffer.from(STYLE_PACK_MAGIC), length, header, vectors]);

// Pack round trip equals decoding the three server files.
const fromPack = decodeStyleIndex(readStylePack(new Uint8Array(file)));
const fromFiles = decodeStyleIndex({ meta, rows, vectors: new Uint8Array(vectors) });
assert.deepEqual([...rankStyle(fromPack, { vibe: 'watercolor' })], [...rankStyle(fromFiles, { vibe: 'watercolor' })]);
assert.equal([...rankStyle(fromPack, { vibe: 'gloomy' })].sort((a, b) => b[1].score - a[1].score)[0][0], 'gamma');
assert.throws(() => readStylePack(new Uint8Array(file.subarray(0, 40))), /不完整|格式/);
assert.throws(() => decodeStyleIndex({ meta, rows, vectors: new Uint8Array(vectors.subarray(1)) }), /不完整/);

// Manifest: GitHub Release asset, same repository as the manifest, bounded size, real checksum.
const base = 'https://github.com/MayRain-Meow/NAI-Pocket/releases/download/artist-style-t';
const manifest = { format: 'nai-pocket-style-manifest', formatVersion: 1, version: 't', images: 4, artists: 3, chips: 2, file: { url: `${base}/style-index-t.bin`, bytes: file.length, sha256: 'a'.repeat(64) } };
assert.equal(validateStyleManifest(manifest, `${base}/style-index.json`).file.bytes, file.length);
assert.throws(() => validateStyleManifest({ ...manifest, file: { ...manifest.file, url: 'https://example.com/x.bin' } }), /GitHub|下载链接/);
assert.throws(() => validateStyleManifest(manifest, 'https://github.com/someone/else/releases/download/x/style-index.json'), /同一个仓库/);
assert.throws(() => validateStyleManifest({ ...manifest, file: { ...manifest.file, sha256: '' } }), /校验值/);

// The local view: without data, vibe search is refused and nothing else changes; with it, the list
// ranks, reports styleIndex and vibeTags, and the cover is the matching example.
const db = new DatabaseSync(':memory:');
db.exec(APP_SCHEMA);
db.prepare("INSERT INTO artist_resource_sets(id,version,title,synthetic) VALUES ('set-a','1','fixture',1)").run();
for (const [id, artist] of [...rows, ['d1', 'delta']]) {
  if (!db.prepare('SELECT 1 FROM artist_resource_profiles WHERE artist=?').get(artist))
    db.prepare("INSERT INTO artist_resource_profiles(artist,display_name,aliases_json,set_id) VALUES (?,?,'[]','set-a')").run(artist, artist);
  db.prepare("INSERT INTO artist_resource_examples(id,artist,position,width,height,thumb_ext,preview_ext) VALUES (?,?,0,512,768,'remote','remote')").run(id, artist);
}
let bytes = null, reads = 0;
const styleIndex = createLocalStyleIndex({ async read() { reads++; return bytes; } });
const view = createArtistLibraryView({ store: createArtistLibraryViewStore(db), preferences: createArtistBrowserStore(db), imageUrl: id => `/img/${id}`, styleIndex });
const plain = await view.list({});
assert.equal(plain.styleIndex, false);
assert.equal(plain.total, 4);
await assert.rejects(view.list({ vibe: 'watercolor' }), error => error.status === 503 && /画风数据/.test(error.message));
assert.deepEqual(await view.styleInfo(), { available: false, error: '', chips: [] });

bytes = new Uint8Array(file); styleIndex.reset(); reads = 0;
const ranked = await view.list({ vibe: 'watercolor' });
assert.equal(ranked.styleIndex, true);
assert.equal(ranked.styleRanked, true);
assert.deepEqual(ranked.artists.map(item => item.artist), ['alpha', 'beta', 'gamma'], 'only indexed artists, best first');
assert.equal(ranked.artists[0].coverUrl, '/img/a1', 'the best-matching example is the cover');
assert.deepEqual(ranked.artists[0].vibeTags, ['水彩']);
const similar = await view.list({ like: 'alpha' });
assert.equal(similar.artists[0].artist, 'beta', '找相似 ranks the closest artist first');
assert.deepEqual((await view.profile('alpha')).vibeTags, ['水彩'], 'the detail carries the vibe words');
assert.equal((await view.styleInfo()).chips.length, 2);
assert.equal(reads, 1, 'decoded once per install, not per request');

// A corrupt file reads as "no data" rather than breaking the artist page.
bytes = new Uint8Array(file.subarray(0, 50)); styleIndex.reset();
assert.equal((await view.list({})).styleIndex, false);
assert.match((await view.styleInfo()).error, /不完整|格式/);
console.log('style index local passed');
