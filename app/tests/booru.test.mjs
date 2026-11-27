import assert from 'node:assert/strict';
import { createBooruService, booruMediaUrl } from '../src/booru.js';
import { BOORU_DEFAULTS, booruSelection, matchesBooruRule } from '../../public/booru-core.js';

const post = (id, overrides = {}) => ({ id, rating: 'g', file_ext: 'png', image_width: 512, image_height: 768,
  score: 12, fav_count: 8, created_at: '2026-11-26T10:00:00Z', file_size: 1024,
  preview_file_url: `https://cdn.donmai.us/preview/${id}.png`, large_file_url: `https://cdn.donmai.us/sample/${id}.png`,
  file_url: `https://cdn.donmai.us/original/${id}.png`, tag_string_artist: 'test_artist',
  tag_string_copyright: 'test_work', tag_string_character: 'test_character', tag_string_general: 'sky blue_hair',
  tag_string_meta: 'highres', tag_string: 'test_artist test_work test_character sky blue_hair highres', ...overrides });
let stored = {}, calls = [], requests = 0, response = [post(1)], failure = null, writeFails = false;
const service = createBooruService({
  now: () => new Date('2026-11-27T10:00:00Z'),
  vault: { read: async () => structuredClone(stored), write: async value => { if (writeFails) throw new Error('storage failed'); stored = structuredClone(value); } },
  http: { fetch: async (input, init) => {
    calls.push({ url: new URL(input), init }); requests++;
    if (failure) throw failure;
    if (new URL(input).hostname === 'cdn.donmai.us') return new Response(new Uint8Array(700000), { headers: { 'content-type': 'image/png' } });
    return Response.json(typeof response === 'function' ? response(input) : response);
  } }
});
assert.equal((await service.settings()).configured, false);
await service.save({ username: 'synthetic-user', apiKey: 'synthetic-api-key' });
const status = await service.settings();
assert.equal(status.configured, true);
assert.ok(!JSON.stringify(status).includes('synthetic-'));
await service.list();
assert.equal(calls.at(-1).url.searchParams.get('tags'), 'rating:g');
assert.match(calls.at(-1).init.headers.Authorization, /^Basic /);
assert.equal(calls.at(-1).url.searchParams.has('api_key'), false);
assert.equal(calls.at(-1).init.redirect, 'error');
const detail = await service.detail('1');
assert.deepEqual(detail.tags.general, ['sky', 'blue_hair']);
assert.equal('media' in detail, false, 'no arbitrary URL proxy exposed');
await service.image('1', 'original');
assert.equal(calls.at(-1).init.headers.Authorization, undefined, 'CDN receives no account');
assert.equal(calls.at(-1).url.search, '');
const before = requests;
await service.image('1', 'original');
assert.equal(requests, before, 'cached image avoids network');
await service.clearCache();
assert.equal((await service.settings()).cacheBytes, 0);
assert.ok((await service.detail('1')).tags, 'clearing cache keeps current page usable');
await assert.rejects(service.detail('../users'), /编号无效/);
await assert.rejects(service.image('1', 'https://evil.test/image.png'), /尺寸无效/);
for (const url of ['http://cdn.donmai.us/a.png', 'https://cdn.donmai.us.evil.test/a.png',
  'https://cdn.donmai.us/a.svg', 'https://cdn.donmai.us/a.png?api_key=secret',
  'https://user:pass@cdn.donmai.us/a.png', 'https://cdn.donmai.us:444/a.png',
  'file:///secret.png', 'https://127.0.0.1/a.png']) assert.equal(booruMediaUrl(url), '');
assert.equal(booruMediaUrl('https://cdn.donmai.us/a.png'), 'https://cdn.donmai.us/a.png');
console.log('PASS redacted settings, isolated auth, media allowlist and cache');

response = [post(2, { rating: 's' }), post(3, { tag_string_general: 'rainy_weather' }), post(4), post(5, { file_ext: 'webm' })];
await service.save({ blacklist: 'rainy_*', outputFilter: 'sky', cacheMiB: 1 });
let result = await service.list({ q: 'rating:e order:random sky', ratings: 'g' });
assert.deepEqual(result.posts.map(x => x.id), ['4']);
assert.equal(calls.at(-1).url.searchParams.get('tags'), 'sky rating:g');
assert.equal(result.filtered, 3);
result = await service.list({ period: 'day', ratings: 'g' });
assert.equal(calls.at(-1).url.pathname, '/explore/posts/popular.json');
assert.equal(calls.at(-1).url.searchParams.get('date'), '2026-11-26');
assert.deepEqual(result.posts.map(x => x.id), ['4'], 'rankings apply rating and blacklist');
await assert.rejects(service.list({ period: 'day', q: 'sky' }), /不支持/);
await service.list({ q: 'blue hair, sky', sort: 'favcount' });
assert.equal(calls.at(-1).url.searchParams.get('tags'), 'blue_hair sky rating:g order:favcount');
await service.image('4', 'preview'); await service.image('4', 'original');
assert.equal((await service.settings()).cacheCount, 1, 'LRU respects actual byte budget');
await service.save({ cacheMiB: 0 }); await service.image('4', 'sample');
assert.equal((await service.settings()).cacheBytes, 0, 'zero disables cache');
assert.equal(matchesBooruRule('a[b]', ['a[b]']), true);
assert.equal(matchesBooruRule('aXb', ['a[b]']), false, 'rules are not regular expressions');
const selected = new Set(['general:sky', 'general:blue_hair', 'general:test_(work)', 'artist:blue_hair']);
const selection = booruSelection({ tags: { artist: ['blue_hair'], general: ['sky', 'blue_hair', 'test_(work)'] } }, selected,
  { ...BOORU_DEFAULTS, outputFilter: ['sky'], spaces: true, escapeParentheses: true });
assert.deepEqual(selection.map(x => x.text), ['blue hair', 'test \\(work\\)']);
console.log('PASS query controls, ranking, filters, byte budget and import formatting');

writeFails = true;
await assert.rejects(service.save({ clearCredentials: true }), /storage failed/);
assert.equal((await service.settings()).configured, true, 'failed persistence keeps previous credentials');
writeFails = false;
await service.save({ clearCredentials: true }); assert.equal((await service.settings()).configured, false);
failure = new Error('synthetic-api-key https://private.test');
await assert.rejects(service.list(), error => !error.message.includes('synthetic-api-key') && !error.message.includes('private.test'));
failure = null;
const cancelled = new AbortController(); cancelled.abort();
await assert.rejects(service.list({}, { signal: cancelled.signal }), { name: 'AbortError' });
response = 'not an array';
await assert.rejects(service.list(), /格式异常/);
response = Array.from({ length: 40 }, (_, i) => post(i + 100, { rating: 'e' }));
result = await service.list();
assert.equal(result.posts.length, 0);
assert.equal(result.hasMore, true, 'fully filtered page still allows continuing');
console.log('PASS save failure, redacted errors, cancellation and filtered pagination');
