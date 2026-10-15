// Packs a built style index (meta.json, images.json, vectors.bin) into the app's single download file
// plus the small manifest the app reads first. Both go into one GitHub Release.
//   node scripts/style-index/pack.mjs <index dir> <new output dir> <version> <release download base URL>
// e.g. ... .tmp/apk-style/out .tmp/apk-style/release 2026-10-15 https://github.com/MayRain-Meow/NAI-Pocket/releases/download/artist-style-2026-10-15
// The app's index holds only g/s originals that are in the public annotation packs (build.py SUBSET).

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { STYLE_PACK_MAGIC, readStylePack, decodeStyleIndex } from '../../public/style-rank.js';
import { validateStyleManifest } from '../../service/style-index-local.js';

const [dir, out, version, base, ...extra] = process.argv.slice(2);
if (!dir || !out || !/^[0-9A-Za-z._-]{1,40}$/.test(version || '') || !base || extra.length) throw new Error('Usage: node scripts/style-index/pack.mjs <index dir> <new output dir> <version> <release download base URL>');
if (fs.existsSync(out)) throw new Error(`Output exists: ${out}`);
const meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8'));
const rows = JSON.parse(fs.readFileSync(path.join(dir, 'images.json'), 'utf8'));
const vectors = fs.readFileSync(path.join(dir, 'vectors.bin'));
const header = Buffer.from(JSON.stringify({ format: 'nai-pocket-style-index', formatVersion: 1, version, meta, rows }), 'utf8');
const length = Buffer.alloc(4); length.writeUInt32LE(header.length);
const file = Buffer.concat([Buffer.from(STYLE_PACK_MAGIC, 'ascii'), length, header, vectors]);
// Round trip through the app's own reader before anything is written.
const ix = decodeStyleIndex(readStylePack(new Uint8Array(file.buffer, file.byteOffset, file.byteLength)));
const name = `style-index-${version}.bin`, sha256 = crypto.createHash('sha256').update(file).digest('hex');
const manifest = validateStyleManifest({ format: 'nai-pocket-style-manifest', formatVersion: 1, version, model: meta.model, builtAt: meta.builtAt,
  images: ix.rows.length, artists: ix.names.length, chips: ix.chips.size, file: { url: `${base.replace(/\/$/, '')}/${name}`, bytes: file.length, sha256 } });
fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, name), file);
fs.writeFileSync(path.join(out, 'style-index.json'), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(JSON.stringify({ ...manifest, file: { ...manifest.file, mib: +(file.length / 1048576).toFixed(1) } }));
