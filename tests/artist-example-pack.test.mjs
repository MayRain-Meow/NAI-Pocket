// V5 例图 (0.6.5): an examples pack attaches generated pictures to artists by name without owning
// them, shows them in the artist page's 生成 group with their generation record, and is installed,
// replaced and removed without touching the artist packs.
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { APP_SCHEMA } from '../service/storage/schema.js';
import { runSteps } from '../service/port-flow.js';
import { createArtistResourceStore } from '../service/storage/artist-resources.js';
import { createArtistResourceService } from '../service/artist-resources.js';
import { createArtistPackInstaller, validateArtistPack } from '../service/artist-pack.js';
import { validateArtistPackCatalog } from '../service/artist-pack-catalog.js';
import { createArtistLibraryView } from '../service/artist-library-view.js';
import { createArtistLibraryViewStore } from '../service/storage/artist-library-view.js';
import { createArtistBrowserStore } from '../service/storage/artist-browser.js';
import { packFixture, catalogFixture, examplesPackFixture, EXAMPLE_RECORD } from './artist-pack-fixtures.mjs';
import { buildArtistExamplePacks } from '../scripts/build-artist-example-packs.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const record = EXAMPLE_RECORD, examplesFixture = examplesPackFixture;

// Format: generated only, a known model, local images, no annotations. Older apps refuse it at the
// sourceType check, which is the reason the kind needs no new format version.
assert.equal(validateArtistPack(examplesFixture().manifest).kind, 'examples');
for (const mutate of [
  manifest => { manifest.artists[0].examples[0].sourceType = 'original'; },
  manifest => { manifest.artists[0].examples[0].model = 'sdxl'; },
  manifest => { manifest.artists[0].examples[0].observations = [{ id: 'o' }]; },
  manifest => { manifest.artists[0].examples = []; },
  manifest => { manifest.kind = 'other'; }
]) { const manifest = structuredClone(examplesFixture().manifest); mutate(manifest); assert.throws(() => validateArtistPack(manifest), error => error.status === 400); }
const withoutKind = structuredClone(examplesFixture().manifest); delete withoutKind.kind;
assert.throws(() => validateArtistPack(withoutKind), /只能包含原作例图/, 'what an older app sees');
const { catalog } = catalogFixture();
assert.equal(validateArtistPackCatalog({ ...catalog, kind: 'examples' }, 'https://github.com/a/b/releases/download/t/catalog.json').kind, 'examples');
assert.equal(validateArtistPackCatalog(catalog, 'https://github.com/a/b/releases/download/t/catalog.json').kind, 'artists');

const database = new DatabaseSync(':memory:'); database.exec(APP_SCHEMA);
const transaction = program => { database.exec('BEGIN'); try { const result = runSteps(program()); database.exec('COMMIT'); return result; } catch (error) { database.exec('ROLLBACK'); throw error; } };
const store = createArtistResourceStore(database, transaction), installer = createArtistPackInstaller({ store });
const reads = [];
const resources = createArtistResourceService({ store, files: { async stat() { return { isFile: true, size: 100 }; }, async read(path) { reads.push(path); return packFixture().buffer; } } });
const view = createArtistLibraryView({ store: createArtistLibraryViewStore(database), preferences: createArtistBrowserStore(database), imageUrl: (id, tier, storage) => `/img/${storage}/${id}/${tier}` });

// Attaches to an artist owned by an artist pack, in either install order.
await installer.install(packFixture());
await installer.install(examplesFixture());
let profile = await view.profile('fixture_artist');
assert.equal(profile.resourceSet.id, 'pack-a', 'the artist pack still owns the artist');
assert.deepEqual(profile.examples.map(item => [item.id, item.sourceType, item.model, item.rotationSample]), [['pack-example', 'original', 'original', false], ['v5-example', 'generated', 'v5', true]]);
const generated = profile.examples[1];
assert.equal(generated.metadata.prompt, record.prompt, 'the generation record travels with the picture');
assert.equal(generated.metadata.params.steps, 28);
assert.equal(generated.previewUrl, '/img/v5-stage-one/v5-example/preview', 'served from the examples set’s own directory');
assert.equal(profile.coverExampleId, 'pack-example', 'an original stays the cover');
assert.deepEqual(profile.exampleModels.sort(), ['original', 'v5']);
await resources.image('v5-example', 'preview'); assert.match(reads.at(-1), /v5-stage-one\/v5-example-preview\.png$/);

// An artist pack update leaves the attached pictures alone, and vice versa.
await installer.install(packFixture({ version: 'two', directory: 'staged-two' }));
assert.equal((await view.profile('fixture_artist')).examples.length, 2);
assert.equal((await installer.install(examplesFixture({ version: 'v5-two', directory: 'v5-stage-two' }))).previousDirectory, 'v5-stage-one');
assert.deepEqual((await store.activeDirectories()).sort(), ['staged-two', 'v5-stage-two']);
assert.equal((await view.profile('fixture_artist')).examples[1].previewUrl, '/img/v5-stage-two/v5-example/preview');

// An artist no artist pack knows still appears, by the name the examples pack gives.
await installer.install(examplesFixture({ id: 'v5-examples-2b', directory: 'v5-stage-b', artist: 'Only_V5', exampleId: 'v5-only' }));
const list = await view.list({ query: 'only_v5' });
assert.equal(list.artists[0].name, 'Only_V5');
assert.equal(list.artists[0].coverUrl, '/img/v5-stage-b/v5-only/thumb', 'with no original, the V5 picture is the cover');
const summary = await view.summary();
assert.equal(summary.sampleExamples, 2, 'generated pictures are counted apart from the annotated originals');
assert.equal(summary.totalExamples, 1);

// One ID, one kind: neither pack type can take over the other's set.
const clash = packFixture({ directory: 'clash' }); clash.manifest.id = 'v5-examples-1a';
await assert.rejects(installer.install(clash), error => error.status === 409);
const stolen = examplesFixture({ id: 'pack-a', directory: 'clash-2', exampleId: 'v5-other' });
await assert.rejects(installer.install(stolen), error => error.status === 409);
await assert.rejects(installer.install(examplesFixture({ id: 'v5-examples-3c', directory: 'clash-3' })), error => error.status === 409, 'an example ID belongs to one examples set');

// The settings section lists the kinds apart and removes only the examples sets.
assert.deepEqual((await resources.catalog()).sets.map(row => [row.id, row.kind]), [['pack-a', 'artists'], ['v5-examples-1a', 'examples'], ['v5-examples-2b', 'examples']]);
assert.deepEqual(await resources.generatedCount(), { artists: 2, examples: 2 });
assert.deepEqual(await store.removeExamples(), { removed: 2 });
assert.deepEqual(await store.activeDirectories(), ['staged-two'], 'removed directories are swept at the next start');
profile = await view.profile('fixture_artist');
assert.deepEqual(profile.examples.map(item => item.id), ['pack-example']);
assert.equal((await view.list({ query: 'only_v5' })).total, 0);
await assert.rejects(resources.image('v5-example'), error => error.status === 404);
database.close();

// Producer: a prepared collection becomes catalog + shards an app installs as examples packs.
const work = fs.mkdtempSync(path.join(process.env.TMP || os.tmpdir(), 'nai-example-packs-'));
try {
  const images = path.join(work, 'images'); fs.mkdirSync(images);
  for (const tier of ['thumb', 'preview']) fs.writeFileSync(path.join(images, `ex-one-${tier}.png`), packFixture().buffer);
  fs.writeFileSync(path.join(work, 'prepared.json'), JSON.stringify({ format: 'nai-pocket-example-collection', formatVersion: 1, id: 'v5-test', version: 'v5-2026', title: 'V5 例图',
    artists: [{ artist: 'Producer_Artist', examples: [{ id: 'ex-one', model: 'v5', width: 1024, height: 1024, metadata: record,
      images: { thumb: { name: 'ex-one-thumb.png', ext: 'png' }, preview: { name: 'ex-one-preview.png', ext: 'png' } } }] }] }));
  const built = await buildArtistExamplePacks({ sourceFile: path.join(work, 'prepared.json'), imageDirectory: images, outputDirectory: path.join(work, 'out') });
  assert.equal(built.kind, 'examples');
  assert.equal(validateArtistPackCatalog(built, 'https://github.com/a/b/releases/download/t/catalog.json').shards[0].examples, 1);
  assert.ok(fs.statSync(path.join(work, 'out', built.shards[0].file)).size > 0);
} finally { fs.rmSync(work, { recursive: true, force: true }); }
console.log('artist example pack tests passed');
