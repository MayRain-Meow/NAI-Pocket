// The app's 画风数据: one downloaded file read by the shared ranker, and the local /api/artists answers
// (vibe / like / styleIndex / vibeTags) matching the server's shapes.
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { STYLE_PACK_MAGIC, readStylePack, decodeStyleIndex, rankStyle, centerQuery, styleProfileOf } from '../public/style-rank.js';
import { createLocalStyleIndex, validateStyleManifest, validateStyleModelManifest } from '../service/style-index-local.js';
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
// 画风概览 (1.8.2): standout words as z-scores against every artist, and the closest artists with
// covers from the installed packs.
{
  const overview = (await view.profile('gamma')).styleProfile;
  assert.equal(overview.images, 1);
  assert.deepEqual(overview.strengths.map(word => word.id), ['gloomy'], 'gamma stands out on 暗调阴郁 only');
  assert.ok(overview.strengths[0].z >= 0.8);
  assert.deepEqual(overview.similar.map(item => item.artist).sort(), ['alpha', 'beta'], 'the other indexed artists, gamma itself excluded');
  assert.ok(overview.similar.every(item => ['/img/a1', '/img/a2', '/img/b1'].includes(item.thumbUrl)), 'covers come from the installed packs');
  assert.equal(styleProfileOf(fromPack, 'nobody'), null, 'an artist outside the index has no overview');
}
assert.equal((await view.styleInfo()).chips.length, 2);
assert.equal(reads, 1, 'decoded once per install, not per request');

// A corrupt file reads as "no data" rather than breaking the artist page.
bytes = new Uint8Array(file.subarray(0, 50)); styleIndex.reset();
assert.equal((await view.list({})).styleIndex, false);
assert.match((await view.styleInfo()).error, /不完整|格式/);
// 以图找画师 (1.8.0): a picture's raw embedding is centred on the index mean, then ranks artists like
// 找相似 does, with the cover being the artist's image closest to the picture.
{
  const withMean = decodeStyleIndex({ meta: { ...meta, mean: floats([0, 0, 0.5, 0]) }, rows, vectors: new Uint8Array(vectors) });
  assert.equal(centerQuery(fromPack, [1, 0, 0, 0]), null, 'an index without a mean cannot take pictures');
  const watery = centerQuery(withMean, [Math.sqrt(0.75), 0, 0.5, 0]); // unit length, so after the mean only axis 0 is left
  assert.ok(Math.abs(watery[2]) < 1e-6 && watery[0] > 0.99, 'the library mean is removed before comparing');
  const ranked = [...rankStyle(withMean, { image: { key: 'p1', vector: watery } })].sort((a, b) => b[1].score - a[1].score);
  assert.deepEqual(ranked.map(([name]) => name), ['alpha', 'beta', 'gamma'], 'artists rank by closeness to the picture');
  assert.equal(ranked.length, 3, 'no artist is excluded for a picture');
  assert.equal(rankStyle(withMean, { image: { key: 'p1', vector: watery } }).get('alpha').exampleId, 'a1', 'the cover is the image closest to the picture');
  const blended = rankStyle(withMean, { vibe: 'gloomy', image: { key: 'p1', vector: watery }, like: 'alpha' });
  assert.ok(blended.has('alpha'), 'a picture replaces like, so the liked artist is not removed');
  assert.notEqual(rankStyle(withMean, { image: { key: 'p2', vector: centerQuery(withMean, [0, 0, 1, 0]) } }), rankStyle(withMean, { image: { key: 'p1', vector: watery } }), 'each picture has its own cache entry');
}
// 以图找画师 in the app (0.6.0): the host embeds the picture; the view ranks image=<id> like the server,
// reports imageSearch only with a model and an index that has a mean, and answers 410 for a forgotten id.
{
  const meanMeta = { ...meta, mean: floats([0, 0, 0, 0]) };
  const header2 = Buffer.from(JSON.stringify({ format: 'nai-pocket-style-index', formatVersion: 1, version: 't', meta: meanMeta, rows }));
  const length2 = Buffer.alloc(4); length2.writeUInt32LE(header2.length);
  const withMean = new Uint8Array(Buffer.concat([Buffer.from(STYLE_PACK_MAGIC), length2, header2, vectors]));
  let modelPresent = false;
  const pictures = new Map([['pic1', Float32Array.from([0, 0, 1, 0])]]);
  const images = { available: async () => modelPresent, vector: id => pictures.get(id) || null };
  const index2 = createLocalStyleIndex({ async read() { return withMean; } });
  const view2 = createArtistLibraryView({ store: createArtistLibraryViewStore(db), preferences: createArtistBrowserStore(db), imageUrl: id => '/img/' + id, styleIndex: index2, styleImages: images });
  assert.equal((await view2.list({})).imageSearch, false, 'no model: no picture button');
  modelPresent = true;
  assert.equal((await view2.list({})).imageSearch, true, 'model and an index with a mean: picture button');
  assert.equal((await view2.styleInfo()).imageSearch, true);
  const byPicture = await view2.list({ image: 'pic1' });
  assert.equal(byPicture.artists[0].artist, 'gamma', 'the artist closest to the picture first');
  assert.equal(byPicture.artists[0].coverUrl, '/img/c1');
  await assert.rejects(view2.list({ image: 'gone' }), error => error.status === 410);
  const noMean = createArtistLibraryView({ store: createArtistLibraryViewStore(db), preferences: createArtistBrowserStore(db), imageUrl: id => id,
    styleIndex: createLocalStyleIndex({ async read() { return new Uint8Array(file); } }), styleImages: images });
  assert.equal((await noMean.list({})).imageSearch, false, 'an index without a mean cannot take pictures');
  const modelBase = 'https://github.com/MayRain-Meow/NAI-Pocket/releases/download/style-model-x';
  const modelManifest = { format: 'nai-pocket-style-model', formatVersion: 1, model: 'clip-vit-large-patch14-vision-int8', file: { url: modelBase + '/vision.onnx', bytes: 307001500, sha256: 'b'.repeat(64) } };
  assert.equal(validateStyleModelManifest(modelManifest, modelBase + '/style-model.json').file.bytes, 307001500);
  assert.throws(() => validateStyleModelManifest({ ...modelManifest, file: { ...modelManifest.file, url: modelBase + '/vision.bin' } }), /ONNX|下载链接/);
  assert.throws(() => validateStyleModelManifest({ ...modelManifest, file: { ...modelManifest.file, bytes: 600 * 1024 * 1024 } }), /大小/);
}
console.log('style index local passed');
