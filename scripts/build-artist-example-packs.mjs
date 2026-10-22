// Builds examples packs (0.6.5): generated example pictures attached to artists by name, sharded
// like the artist packs so each shard stays under the native archive limit. Local output only;
// no database, credential, server or upload access.
// Input: { format:'nai-pocket-example-collection', formatVersion:1, id, version, title,
//   artists:[{ artist, examples:[{ id, model, width, height, metadata, images:{ thumb:{name,ext}, preview:{name,ext} } }] }] }
// with every named image in <image-directory>.
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { normalizeArtistIdentity } from '../public/artist-index-v5.js';
import { validateArtistPack } from '../service/artist-pack.js';
import { artistShard, fields, scan, readPreparedArtistImage, finishArtistShards, writeArtistPackOutput } from './build-artist-packs.mjs';

const fail = message => { throw new Error(message); };

export async function prepareArtistExamples({ sourceFile, imageDirectory }) {
  const sourcePath = path.resolve(sourceFile), imageRoot = await fs.realpath(imageDirectory);
  if ((await fs.stat(sourcePath)).size > 128 * 1024 * 1024) fail('Prepared source exceeds 128 MiB');
  const input = JSON.parse(await fs.readFile(sourcePath, 'utf8'));
  fields(input, ['format', 'formatVersion', 'id', 'version', 'title', 'artists'], 'Collection');
  if (input.format !== 'nai-pocket-example-collection' || input.formatVersion !== 1 || typeof input.id !== 'string' || !/^[A-Za-z0-9_-]{1,90}$/.test(input.id)
    || !Array.isArray(input.artists) || !input.artists.length) fail('Invalid prepared example collection');
  scan(input);
  const source = { id: input.id, kind: 'examples', version: input.version, title: input.title, synthetic: false };
  const buckets = new Map(), identities = new Set(), exampleIds = new Set();
  for (const row of input.artists) {
    fields(row, ['artist', 'examples'], 'Artist');
    const identity = normalizeArtistIdentity(row.artist);
    if (identities.has(identity)) fail('Duplicate normalized artist identity'); identities.add(identity);
    const artist = { artist: row.artist, examples: [] };
    for (const example of row.examples) {
      fields(example, ['id', 'model', 'width', 'height', 'metadata', 'images'], 'Example');
      if (exampleIds.has(example.id)) fail('Duplicate example ID across collection'); exampleIds.add(example.id);
      fields(example.images, ['thumb', 'preview'], 'Images');
      const images = {};
      for (const tier of ['thumb', 'preview']) {
        const image = example.images[tier]; fields(image, ['name', 'ext'], 'Image');
        if (image.name !== `${example.id}-${tier}.${image.ext}`) fail('Image ID and filename differ');
        const actual = await readPreparedArtistImage(imageRoot, image.name);
        images[tier] = { name: image.name, ext: image.ext, bytes: actual.bytes.length, sha256: actual.sha256 };
      }
      artist.examples.push({ id: example.id, sourceType: 'generated', model: example.model, width: example.width, height: example.height,
        metadata: structuredClone(example.metadata ?? {}), images, observations: [] });
    }
    const shard = artistShard(identity), manifest = { format: 'nai-pocket-artist-pack', formatVersion: 1, kind: 'examples', id: `${source.id}-${shard}`,
      version: source.version, title: source.title, synthetic: false, artists: [artist] };
    validateArtistPack(manifest);
    if (!buckets.has(shard)) buckets.set(shard, { ...manifest, artists: [] }); buckets.get(shard).artists.push(artist);
  }
  return { source, packs: finishArtistShards(buckets), imageRoot };
}

export async function buildArtistExamplePacks({ sourceFile, imageDirectory, outputDirectory }) {
  const { source, packs, imageRoot } = await prepareArtistExamples({ sourceFile, imageDirectory });
  return writeArtistPackOutput({ source, packs, imageRoot, outputDirectory });
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [sourceFile, imageDirectory, outputDirectory, ...extra] = process.argv.slice(2);
  if (!sourceFile || !imageDirectory || !outputDirectory || extra.length) throw new Error('Usage: node scripts/build-artist-example-packs.mjs <prepared.json> <image-directory> <new-output-directory>');
  const catalog = await buildArtistExamplePacks({ sourceFile, imageDirectory, outputDirectory });
  console.log(`Prepared ${catalog.shards.length} examples packs: ${catalog.artists} artists, ${catalog.examples} pictures. Local output only; nothing uploaded.`);
}
