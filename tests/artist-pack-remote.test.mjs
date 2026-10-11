import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { APP_SCHEMA } from '../service/storage/schema.js';
import { runSteps } from '../service/port-flow.js';
import { createArtistResourceStore } from '../service/storage/artist-resources.js';
import { createArtistResourceService, REMOTE_IMAGE_CONCURRENCY } from '../service/artist-resources.js';
import { createArtistPackInstaller, validateArtistPack, validateRemoteImageUrl } from '../service/artist-pack.js';
import { packFixture, remotePackFixture, REMOTE_MD5 } from './artist-pack-fixtures.mjs';

// Minimal synthetic encodings: enough for MIME sniffing and dimension parsing.
const jpeg = Buffer.from('ffd8ffc0001108000200020301220002110103110100ffd9', 'hex');
const webp = Buffer.concat([Buffer.from('RIFF'), Buffer.from([22, 0, 0, 0]), Buffer.from('WEBPVP8X'), Buffer.from([10, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 1, 0, 0])]);
const thumbUrl = `https://cdn.donmai.us/360x360/ed/f8/${REMOTE_MD5}.jpg`, previewUrl = `https://cdn.donmai.us/720x720/ed/f8/${REMOTE_MD5}.webp`;

// Format: a remote example replaces images, adds no files, and only accepts the CDN shape.
const remote = remotePackFixture(), parsed = validateArtistPack(remote.manifest);
assert.equal(parsed.files.length, 0, 'remote examples add nothing to pack.files');
assert.deepEqual(parsed.artists[0].examples[0].remoteImages, { thumb: thumbUrl, preview: previewUrl });
assert.equal(parsed.artists[0].examples[0].images, undefined);
for (const url of [`https://cdn.donmai.us/sample/ed/f8/sample-${REMOTE_MD5}.jpg`, `https://cdn.donmai.us/180x180/ed/f8/${REMOTE_MD5}.jpg`, `https://cdn.donmai.us/720x720/ed/f8/${REMOTE_MD5}.png`])
  assert.equal(validateRemoteImageUrl(url), url);
const badUrls = [
  thumbUrl.replace('https:', 'http:'), thumbUrl.replace('cdn.donmai.us', 'danbooru.donmai.us'), thumbUrl.replace('cdn.donmai.us', 'cdn.donmai.us.evil.test'),
  thumbUrl.replace('cdn.donmai.us', 'example.com'), thumbUrl + '?token=x', thumbUrl + '?', thumbUrl + '#x', thumbUrl.replace('cdn.donmai.us', 'cdn.donmai.us:8443'),
  thumbUrl.replace('cdn.donmai.us', 'cdn.donmai.us:443'), thumbUrl.replace('https://', 'https://user:pass@'), thumbUrl.replace('360x360', 'original'),
  thumbUrl.replace('/ed/f8/', '/ED/F8/'), thumbUrl.replace(REMOTE_MD5, REMOTE_MD5.toUpperCase()), thumbUrl.replace('.jpg', '.gif'),
  thumbUrl.replace('/ed/f8/', '/ed/f8/../'), thumbUrl.replace('/ed/f8/', '/ed/'), `https://cdn.donmai.us/360x360/ed/f8/${REMOTE_MD5.slice(1)}.jpg`, '', null, 42
];
for (const url of badUrls) {
  assert.throws(() => validateRemoteImageUrl(url), error => error.status === 400, String(url));
  const manifest = structuredClone(remote.manifest); manifest.artists[0].examples[0].remoteImages.thumb = url;
  assert.throws(() => validateArtistPack(manifest), error => error.status === 400, `pack rejects ${url}`);
}
for (const mutate of [
  example => { example.images = structuredClone(packFixture().manifest.artists[0].examples[0].images); },
  example => { delete example.remoteImages; },
  example => { delete example.remoteImages.preview; },
  example => { example.remoteImages.original = previewUrl; },
  example => { example.remoteImages = [thumbUrl, previewUrl]; }
]) {
  const manifest = structuredClone(remote.manifest); mutate(manifest.artists[0].examples[0]);
  assert.throws(() => validateArtistPack(manifest), error => error.status === 400);
}

function harness({ fetchImpl, files: initial, timeout } = {}) {
  const database = new DatabaseSync(':memory:'); database.exec(APP_SCHEMA);
  const transaction = program => { database.exec('BEGIN'); try { const result = runSteps(program()); database.exec('COMMIT'); return result; } catch (error) { database.exec('ROLLBACK'); throw error; } };
  const store = createArtistResourceStore(database, transaction), installer = createArtistPackInstaller({ store });
  const missing = () => Object.assign(new Error('missing'), { code: 'ENOENT' });
  const stored = new Map(initial || []), writes = [], calls = [];
  const files = {
    async stat(path) { if (!stored.has(path)) throw missing(); return { isFile: true, size: stored.get(path).length }; },
    async read(path) { if (!stored.has(path)) throw missing(); return stored.get(path); },
    async write(path, bytes) { writes.push(path); stored.set(path, Buffer.from(bytes)); return path; }
  };
  const http = { fetch: async (url, init) => { calls.push({ url, init }); return fetchImpl(url, init); } };
  const resources = createArtistResourceService({ store, files, http, ...(timeout ? { remoteTimeoutMs: timeout } : {}) });
  return { database, store, installer, resources, stored, writes, calls };
}
const ok = (bytes, type) => new Response(bytes, { status: 200, headers: { 'content-type': type } });
const serve = url => url.endsWith('.jpg') ? ok(jpeg, 'image/jpeg') : ok(webp, 'image/webp');

// Storage + fetch-once caching; a manifest-only ZIP installs.
{
  const h = harness({ fetchImpl: serve });
  try {
    const result = await h.installer.install(remotePackFixture());
    assert.equal(result.installed, true); assert.equal(result.examples, 1, 'example count no longer derives from image files');
    const row = h.database.prepare("SELECT thumb_ext,preview_ext,metadata_json FROM artist_resource_examples WHERE id='remote-example'").get();
    assert.equal(row.thumb_ext, 'remote'); assert.equal(row.preview_ext, 'remote');
    const metadata = JSON.parse(row.metadata_json);
    assert.deepEqual(metadata.remoteImages, { thumb: thumbUrl, preview: previewUrl }); assert.equal(metadata.rating, 'g', 'source metadata is retained');
    const first = await h.resources.image('remote-example', 'thumb');
    assert.equal(first.contentType, 'image/jpeg'); assert.deepEqual(Buffer.from(first.buffer), jpeg);
    assert.equal(h.calls.length, 1); assert.equal(h.calls[0].url, thumbUrl);
    const init = h.calls[0].init, headers = Object.fromEntries(Object.entries(init.headers).map(([key, value]) => [key.toLowerCase(), value]));
    assert.equal(init.credentials, 'omit'); assert.equal(init.redirect, 'error'); assert.equal(init.method, 'GET');
    assert.deepEqual(Object.keys(headers).sort(), ['accept', 'user-agent'], 'no credential, cookie or token headers');
    assert.match(headers['user-agent'], /^NAI-Pocket\//);
    assert.deepEqual(h.writes, ['artist-cache/remote-example-thumb.jpg']);
    const second = await h.resources.image('remote-example', 'thumb');
    assert.deepEqual(Buffer.from(second.buffer), jpeg); assert.equal(h.calls.length, 1, 'second read is served from the local cache');
    const preview = await h.resources.image('remote-example', 'preview');
    assert.equal(preview.contentType, 'image/webp'); assert.equal(h.calls.at(-1).url, previewUrl);
    assert.ok(h.stored.has('artist-cache/remote-example-preview.webp'));
    // A corrupt cache file is ignored and refreshed rather than served.
    h.stored.set('artist-cache/remote-example-thumb.jpg', Buffer.from('not an image'));
    assert.deepEqual(Buffer.from((await h.resources.image('remote-example', 'thumb')).buffer), jpeg); assert.equal(h.calls.length, 3);
    const profile = await h.resources.get('remote_artist');
    await assert.rejects(h.resources.image('remote-example', 'thumb', { revision: 'older-directory' }), error => error.status === 409);
    assert.equal((await h.resources.image('remote-example', 'thumb', { revision: profile.resourceSet.revision })).contentType, 'image/jpeg');
    // A tampered URL in the database is refused before any network request.
    h.database.prepare("UPDATE artist_resource_examples SET metadata_json=? WHERE id='remote-example'").run(JSON.stringify({ remoteImages: { thumb: 'https://evil.example/360x360/ed/f8/x.jpg' } }));
    h.stored.clear(); const before = h.calls.length;
    await assert.rejects(h.resources.image('remote-example', 'thumb'), error => error.status === 422); assert.equal(h.calls.length, before);
  } finally { h.database.close(); }
}

// Mixed pack: local files and remote pointers coexist; the local path is unchanged.
{
  const local = packFixture({ version: 'mixed', directory: 'mixed-stage' }), extra = remotePackFixture().manifest.artists[0];
  local.manifest.artists.push(extra);
  const h = harness({ fetchImpl: serve, files: [['artist-resources/mixed-stage/pack-example-thumb.png', local.buffer]] });
  try {
    const result = await h.installer.install(local); assert.equal(result.examples, 2);
    assert.deepEqual(Buffer.from((await h.resources.image('pack-example', 'thumb')).buffer), local.buffer); assert.equal(h.calls.length, 0);
    assert.equal((await h.resources.image('remote-example', 'thumb')).contentType, 'image/jpeg'); assert.equal(h.calls.length, 1);
    const rows = h.database.prepare('SELECT id,thumb_ext FROM artist_resource_examples ORDER BY id').all().map(row => [row.id, row.thumb_ext]);
    assert.deepEqual(rows, [['pack-example', 'png'], ['remote-example', 'remote']]);
    // A full private pack still requires exactly its declared files.
    const missingFile = packFixture({ version: 'x', directory: 'x-stage' }); missingFile.files = [];
    await assert.rejects(h.installer.install(missingFile), error => error.status === 400);
  } finally { h.database.close(); }
}

// Failures: clear 502/404 errors and nothing cached.
for (const [label, fetchImpl, status] of [
  ['network', async () => { throw new TypeError('Native HTTP request failed'); }, 502],
  ['server error', async () => new Response('busy', { status: 503 }), 502],
  ['gone', async () => new Response('nope', { status: 404 }), 404],
  ['not an image', async () => ok(Buffer.from('<html></html>'), 'image/jpeg'), 502],
  ['wrong type', async () => ok(webp, 'image/webp'), 502],
  ['oversized', async () => new Response(jpeg, { status: 200, headers: { 'content-type': 'image/jpeg', 'content-length': String(5 * 1024 * 1024) } }), 502]
]) {
  const h = harness({ fetchImpl });
  try {
    await h.installer.install(remotePackFixture());
    await assert.rejects(h.resources.image('remote-example', 'thumb'), error => error.status === status && (status !== 502 || label !== 'network' || error.message === '无法从 Danbooru 读取这张例图，请检查网络。'), label);
    assert.equal(h.writes.length, 0, `${label}: nothing cached`);
  } finally { h.database.close(); }
}

// Abort before and during a fetch; a timeout maps to 502.
{
  const hanging = (url, init) => new Promise((resolve, reject) => init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true }));
  const h = harness({ fetchImpl: hanging, timeout: 50 });
  try {
    await h.installer.install(remotePackFixture());
    const before = new AbortController(); before.abort();
    await assert.rejects(h.resources.image('remote-example', 'thumb', { signal: before.signal }), { name: 'AbortError' }); assert.equal(h.calls.length, 0);
    const during = new AbortController(), pending = h.resources.image('remote-example', 'thumb', { signal: during.signal, revision: undefined });
    await new Promise(resolve => setTimeout(resolve, 5)); assert.equal(h.calls.length, 1); during.abort();
    await assert.rejects(pending, { name: 'AbortError' }); assert.equal(h.writes.length, 0);
    await assert.rejects(h.resources.image('remote-example', 'thumb'), error => error.status === 502, 'timeout'); assert.equal(h.writes.length, 0);
  } finally { h.database.close(); }
}

// At most REMOTE_IMAGE_CONCURRENCY fetches run at once; queued aborts free their place.
{
  let active = 0, peak = 0; const release = [];
  const gated = url => { active++; peak = Math.max(peak, active); return new Promise(resolve => release.push(() => { active--; resolve(serve(url)); })); };
  const h = harness({ fetchImpl: gated });
  try {
    await h.installer.install(remotePackFixture());
    const queuedAbort = new AbortController();
    const requests = Array.from({ length: 7 }, (_, index) => h.resources.image('remote-example', index % 2 ? 'preview' : 'thumb', index === 5 ? { signal: queuedAbort.signal } : {}));
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(h.calls.length, REMOTE_IMAGE_CONCURRENCY); assert.equal(REMOTE_IMAGE_CONCURRENCY, 4);
    queuedAbort.abort(); await assert.rejects(requests[5], { name: 'AbortError' });
    while (release.length || h.calls.length < 6) { release.shift()?.(); await new Promise(resolve => setTimeout(resolve, 5)); }
    const results = await Promise.allSettled(requests);
    assert.deepEqual(results.map(result => result.status), ['fulfilled', 'fulfilled', 'fulfilled', 'fulfilled', 'fulfilled', 'rejected', 'fulfilled']);
    assert.equal(peak, 4); assert.equal(h.calls.length, 6, 'the request aborted while queued never reached the network');
  } finally { h.database.close(); }
}
console.log('Artist remote packs passed: Danbooru CDN pointer validation, manifest-only install, remote storage, fetch-once cache, mixed packs, 502/404 failures without caching, abort/timeout and bounded concurrency.');
