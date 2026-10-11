import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { buildArtistAnnotationPacks, danbooruRemoteImages, ANNOTATION_PACK_VERSION, ANNOTATION_PACK_TITLE } from '../scripts/build-artist-annotation-packs.mjs';
import { artistShard } from '../scripts/build-artist-packs.mjs';
import { packFixture } from './artist-pack-fixtures.mjs';
import { APP_SCHEMA } from '../service/storage/schema.js';
import { createArtistPackInstaller } from '../service/artist-pack.js';
import { createArtistResourceStore } from '../service/storage/artist-resources.js';
import { runSteps } from '../service/port-flow.js';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const md5 = index => hash(String(index)).slice(0, 32);
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'nai-annotation-producer-')), sourceFile = path.join(temporary, 'source.json');
const template = packFixture().manifest.artists[0].examples[0];
function example(id, rating, index, variant = { type: '720x720', width: 2, height: 2, fileExt: 'webp' }) {
  const value = structuredClone(template); value.id = id;
  value.metadata = { provider: 'Danbooru', postId: index, rating, remoteMd5: md5(index), variant, postUrl: `https://danbooru.donmai.us/posts/${index}` };
  value.images = { thumb: { name: `${id}-thumb.webp`, ext: 'webp' }, preview: { name: `${id}-preview.webp`, ext: 'webp' } };
  value.observations = [{ ...value.observations[0], id: `obs-${id}`, exampleId: id, note: `标注文本 ${id}` }];
  return value;
}
const source = { format: 'nai-pocket-artist-collection', formatVersion: 1, id: 'test-originals', version: 'full-1', title: 'Synthetic full', synthetic: true, artists: [
  { artist: 'Safe_Artist', aliases: ['安全'], examples: [example('safe-g', 'g', 1), example('safe-s', 's', 2), example('safe-q', 'q', 3)] },
  { artist: 'Explicit_Only', aliases: [], examples: [example('only-e', 'e', 4)] },
  { artist: 'Sample_Artist', aliases: [], examples: [example('sample-g', 'g', 5, { type: 'sample', width: 2, height: 2, fileExt: 'jpg' }), example('bad-variant', 's', 6, { type: 'original', fileExt: 'png' })] },
  { artist: 'Empty_Artist', aliases: [], examples: [] }
] };
await fs.writeFile(sourceFile, JSON.stringify(source));

assert.deepEqual(danbooruRemoteImages({ provider: 'Danbooru', remoteMd5: 'edf829c359d0737baa2999ca09e3952c', variant: { type: '720x720', fileExt: 'webp' } }),
  { thumb: 'https://cdn.donmai.us/360x360/ed/f8/edf829c359d0737baa2999ca09e3952c.jpg', preview: 'https://cdn.donmai.us/720x720/ed/f8/edf829c359d0737baa2999ca09e3952c.webp' });
assert.equal(danbooruRemoteImages({ provider: 'Other', remoteMd5: md5(1), variant: { type: '720x720', fileExt: 'webp' } }), null);
assert.equal(danbooruRemoteImages({ provider: 'Danbooru', remoteMd5: 'not-md5', variant: { type: '720x720', fileExt: 'webp' } }), null);

const output = path.join(temporary, 'packs');
const { catalog, stats } = await buildArtistAnnotationPacks({ sourceFile, outputDirectory: output });
assert.equal(catalog.version, ANNOTATION_PACK_VERSION); assert.equal(catalog.title, ANNOTATION_PACK_TITLE); assert.equal(catalog.id, 'test-originals');
assert.deepEqual(stats.droppedByRating, { q: 1, e: 1 }); assert.equal(stats.droppedWithoutRemote, 1); assert.equal(stats.keptExamples, 3);
assert.equal(catalog.artists, 4, 'artists without kept examples remain listed by name'); assert.equal(catalog.examples, 3);
assert.deepEqual(catalog.artistsByExampleCount, { 0: 2, 1: 1, 2: 1, 3: 0, 4: 0 });
await assert.rejects(fs.access(path.join(output, 'INCOMPLETE.json')));
const listed = (await fs.readdir(output)).sort();
assert.deepEqual(listed, ['catalog.json', ...catalog.shards.map(shard => shard.file)].sort());

const database = new DatabaseSync(':memory:'); database.exec(APP_SCHEMA);
const transaction = program => { database.exec('BEGIN'); try { const result = runSteps(program()); database.exec('COMMIT'); return result; } catch (error) { database.exec('ROLLBACK'); throw error; } };
const installer = createArtistPackInstaller({ store: createArtistResourceStore(database, transaction) });
const seen = new Map();
try {
  for (const [index, shard] of catalog.shards.entries()) {
    const bytes = await fs.readFile(path.join(output, shard.file));
    assert.equal(hash(bytes), shard.sha256);
    // Walk local headers: the archive must hold exactly one entry, manifest.json.
    const names = []; let offset = 0, manifest;
    while (bytes.readUInt32LE(offset) === 0x04034b50) {
      const size = bytes.readUInt32LE(offset + 18), nameSize = bytes.readUInt16LE(offset + 26), start = offset + 30 + nameSize;
      const name = bytes.toString('utf8', offset + 30, start); names.push(name);
      if (name === 'manifest.json') manifest = JSON.parse(bytes.subarray(start, start + size));
      offset = start + size;
    }
    assert.deepEqual(names, ['manifest.json'], 'no image files inside annotation packs');
    assert.equal(manifest.id, `${source.id}-${artistShard(manifest.artists[0].artist)}`, 'same pack IDs and partition as the full packs');
    for (const artist of manifest.artists) for (const item of artist.examples) {
      assert.equal(item.images, undefined); assert.ok(['g', 's'].includes(item.metadata.rating)); seen.set(item.id, item);
    }
    const text = bytes.toString('utf8');
    for (const banned of ['safe-q', 'only-e', 'bad-variant', md5(3), md5(4)]) assert.ok(!text.includes(banned), `excluded ${banned} leaves no trace`);
    assert.equal((await installer.install({ directory: `annotation-${index}`, manifest, files: [] })).installed, true);
  }
  assert.deepEqual([...seen.keys()].sort(), ['safe-g', 'safe-s', 'sample-g']);
  assert.equal(seen.get('safe-g').observations[0].note, '标注文本 safe-g', 'annotations of kept examples are preserved');
  assert.equal(seen.get('sample-g').remoteImages.preview, `https://cdn.donmai.us/sample/${md5(5).slice(0, 2)}/${md5(5).slice(2, 4)}/sample-${md5(5)}.jpg`);
  const rows = database.prepare('SELECT DISTINCT thumb_ext FROM artist_resource_examples').all();
  assert.deepEqual(rows.map(row => row.thumb_ext), ['remote']);
  assert.equal(database.prepare('SELECT COUNT(*) AS n FROM artist_resource_profiles').get().n, 4);
  assert.equal(database.prepare('SELECT COUNT(*) AS n FROM artist_resource_observations').get().n, 3);
} finally { database.close(); }

await assert.rejects(buildArtistAnnotationPacks({ sourceFile, outputDirectory: output }), error => error.code === 'EEXIST', 'never overwrite an earlier delivery');
const leaking = structuredClone(source); leaking.artists[0].examples[0].metadata.originalSourceUrl = 'D:\\private\\image.png';
await fs.writeFile(sourceFile, JSON.stringify(leaking));
await assert.rejects(buildArtistAnnotationPacks({ sourceFile, outputDirectory: path.join(temporary, 'leaking') }), /possible private credential or local path/);
await assert.rejects(fs.access(path.join(temporary, 'leaking')));
// Private text on an excluded (q/e) example is never published, so it cannot fail the scan.
const excludedOnly = structuredClone(source); excludedOnly.artists[0].examples[2].metadata.originalSourceUrl = 'D:\\private\\image.png';
await fs.writeFile(sourceFile, JSON.stringify(excludedOnly));
assert.equal((await buildArtistAnnotationPacks({ sourceFile, outputDirectory: path.join(temporary, 'excluded') })).catalog.examples, 3);
console.log('Artist annotation pack producer passed: g/s only, q/e and their annotations excluded, manifest-only ZIPs, CDN pointers, stable shard IDs, installable output and private-data scan.');
console.log(`Annotation producer fixture: ${temporary}`);
