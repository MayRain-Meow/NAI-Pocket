import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { createImageResponseParser, imageMimeFromMagic, sniffImageResponse, upstreamErrorMessage } from '../service/image-response.js';
import { createGenerationClient } from '../service/generation.js';
import { sanitizeGenerationState } from '../public/generation-payload.js';

const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.from('fixture-png-body-0123456789abcdef0123456789abcdef0123456789')]);
const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('fixture-jpeg-body-0123456789abcdef0123456789abcdef01234567')]);
const webp = Buffer.concat([Buffer.from('RIFF'), Buffer.from([40, 0, 0, 0]), Buffer.from('WEBPVP8 fixture-webp-0123456789abcdef0123456789abcdef0123')]);

function syntheticZip(filename, content) {
  const name = Buffer.from(filename);
  const compressed = zlib.deflateRawSync(content);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(8, 8);
  local.writeUInt32LE(compressed.length, 18); local.writeUInt32LE(content.length, 22); local.writeUInt16LE(name.length, 26);
  const centralOffset = local.length + name.length + compressed.length;
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(8, 10);
  central.writeUInt32LE(compressed.length, 20); central.writeUInt32LE(content.length, 24); central.writeUInt16LE(name.length, 28);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(1, 8); eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(central.length + name.length, 12); eocd.writeUInt32LE(centralOffset, 16);
  return Buffer.concat([local, name, compressed, central, name, eocd]);
}

// The parser's ZIP routing is checked with this fixture reader (one deflated entry, as built above);
// the generation client's real extractor is exercised end to end at the bottom.
const extractZipImage = buffer => {
  const nameLength = buffer.readUInt16LE(26), extraLength = buffer.readUInt16LE(28), compressedSize = buffer.readUInt32LE(18);
  const start = 30 + nameLength + extraLength;
  return { buffer: zlib.inflateRawSync(buffer.subarray(start, start + compressedSize)), filename: buffer.subarray(30, 30 + nameLength).toString('utf8') };
};
const parser = createImageResponseParser({ binary: Buffer, extractZipImage });
const parse = (body, options = {}) => parser.parse({ bytes: typeof body === 'string' ? Buffer.from(body) : body, defaultSeed: 7, ...options });
const json = value => Buffer.from(JSON.stringify(value));
let passed = 0;
const check = (name, fn) => { fn(); passed += 1; };

check('magic bytes', () => {
  assert.equal(imageMimeFromMagic(png), 'image/png');
  assert.equal(imageMimeFromMagic(jpeg), 'image/jpeg');
  assert.equal(imageMimeFromMagic(webp), 'image/webp');
  assert.equal(imageMimeFromMagic(Buffer.from('<html>')), '');
  assert.equal(sniffImageResponse(syntheticZip('a.png', png)), 'zip');
  assert.equal(sniffImageResponse(Buffer.from('\uFEFF  {"a":1}')), 'json');
  assert.equal(sniffImageResponse(Buffer.from('\n[1]')), 'json');
  assert.equal(sniffImageResponse(Buffer.from('event: final\ndata: {}')), 'sse');
  assert.equal(sniffImageResponse(Buffer.from('data: x')), 'sse');
  assert.equal(sniffImageResponse(Buffer.from('hello')), 'unknown');
});

check('raw images ignore the declared content-type', () => {
  for (const [bytes, mime] of [[png, 'image/png'], [jpeg, 'image/jpeg'], [webp, 'image/webp']]) {
    const result = parse(bytes);
    assert.equal(result.kind, 'image'); assert.equal(result.source, 'raw');
    assert.equal(result.mime, mime); assert.deepEqual(result.buffer, bytes); assert.equal(result.seed, 7);
  }
});

check('zip', () => {
  const result = parse(syntheticZip('image_0.webp', webp));
  assert.equal(result.source, 'zip'); assert.equal(result.mime, 'image/webp');
  assert.equal(result.filename, 'image_0.webp'); assert.deepEqual(result.buffer, webp);
});

check('NovelAI JSON with and without a data: prefix, with its seed', () => {
  const plain = parse(json({ images: [{ image: png.toString('base64'), seed: 99 }] }));
  assert.equal(plain.source, 'json'); assert.deepEqual(plain.buffer, png); assert.equal(plain.seed, 99);
  const prefixed = parse(json({ images: [{ image: `data:image/webp;base64,${webp.toString('base64')}` }] }));
  assert.deepEqual(prefixed.buffer, webp); assert.equal(prefixed.mime, 'image/webp'); assert.equal(prefixed.seed, 7);
});

check('OpenAI-style and other JSON shapes', () => {
  assert.deepEqual(parse(json({ created: 1, data: [{ b64_json: png.toString('base64') }] })).buffer, png);
  assert.deepEqual(parse(json({ image: `data:image/jpeg;base64,${jpeg.toString('base64')}` })).buffer, jpeg);
  assert.deepEqual(parse(json({ code: 0, result: { output: webp.toString('base64'), seed: 5 } })).buffer, webp);
  assert.equal(parse(json({ code: 0, result: { output: webp.toString('base64'), seed: 5 } })).seed, 5, 'a seed beside the image is kept');
  assert.equal(parse(json({ seed: 11, output: png.toString('base64') })).seed, 11, 'a top-level seed is kept');
  assert.deepEqual(parse(json({ images: [png.toString('base64')] })).buffer, png, 'an array of base64 strings');
  assert.deepEqual(parse(json([{ image: png.toString('base64') }])).buffer, png, 'a top-level array');
  assert.deepEqual(parse(json({ data: [{ url: 'https://cdn.example/x' }], b: { image: png.toString('base64') } })).buffer, png, 'an embedded image wins over a link');
});

check('links: https only, one hop', () => {
  const link = parse(json({ data: [{ url: 'https://cdn.example/out/1' }], seed: 3 }));
  assert.deepEqual(link, { kind: 'url', url: 'https://cdn.example/out/1', seed: 3 });
  assert.equal(parse(json({ output: 'https://cdn.example/a.png?sig=1' })).kind, 'url', 'an image-looking path under any key');
  assert.equal(parse(json({ images: ['https://cdn.example/a'] })).kind, 'url');
  assert.throws(() => parse(json({ url: 'http://cdn.example/a.png' })), /不是 HTTPS/);
  assert.throws(() => parse(json({ url: 'https://cdn.example/a.png' }), { allowUrl: false }), /另一个链接/);
  assert.throws(() => parse(json({ homepage: 'https://example.com/about' })), /NovelAI|没有图片/, 'an unrelated link is not an image');
});

check('event streams', () => {
  const stream = [
    'event: intermediate', `data: ${JSON.stringify({ event_type: 'intermediate', image: jpeg.toString('base64') })}`, '',
    'event: final', `data: ${JSON.stringify({ event_type: 'final', image: png.toString('base64'), seed: 8 })}`, '', 'data: [DONE]', ''
  ].join('\n');
  const result = parse(stream);
  assert.equal(result.source, 'sse'); assert.deepEqual(result.buffer, png); assert.equal(result.seed, 8, 'the last image wins');
  assert.deepEqual(parse(`data: ${webp.toString('base64')}\n\n`).buffer, webp, 'a bare base64 payload');
  assert.throws(() => parse('data: {"error":"queue full"}\n\n'), error => error.message === 'queue full' && error.status === 502);
});

check('bare base64 body', () => {
  const result = parse(png.toString('base64'));
  assert.equal(result.source, 'base64'); assert.deepEqual(result.buffer, png);
});

check('upstream errors are passed through', () => {
  const cases = [
    [{ error: 'insufficient quota' }, 'insufficient quota'],
    [{ error: { message: 'bad key', code: 401 } }, 'bad key'],
    [{ success: false, message: '余额不足' }, '余额不足'],
    [{ detail: [{ msg: 'field required' }] }, 'field required'],
    [{ code: 1, msg: 'busy' }, 'busy'],
    [{ errors: ['e1', 'e2'] }, 'e1']
  ];
  for (const [body, text] of cases) assert.throws(() => parse(json(body)), error => error.message === text && error.status === 502, JSON.stringify(body));
  assert.equal(upstreamErrorMessage({ error: 'x'.repeat(900) }).length, 500, 'trimmed to 500 characters');
  assert.throws(() => parse(json({ images: [] }), { noImageMessage: 'NovelAI JSON 返回中没有图片。' }), /^Error: NovelAI JSON 返回中没有图片。$/);
});

check('non-images are rejected', () => {
  assert.throws(() => parse('<html><body>502 Bad Gateway</body></html>'), /不是图片/);
  assert.throws(() => parse(json({ images: [{ image: Buffer.from('not an image at all, just text that is long enough').toString('base64') }] })), /不是图片/);
  assert.throws(() => parse('{"broken": '), /无法解析/);
  assert.throws(() => parse(Buffer.alloc(0)), /不是图片/);
});

check('depth and node bounds', () => {
  let deep = { image: png.toString('base64') };
  for (let index = 0; index < 12; index += 1) deep = { next: deep };
  assert.throws(() => parse(json(deep)), /没有图片/, 'an image nested deeper than the bound is not searched');
  const wide = { items: Array.from({ length: 6000 }, (_, index) => index), image: png.toString('base64') };
  assert.throws(() => parse(json(wide)), /没有图片/, 'the walk stops after the node budget');
});

// Through the generation client: content-type is ignored, a JSON link is followed once over https.
const requests = [];
let reply;
const client = createGenerationClient({
  settings: { naiTimeoutMs: 2000 }, assets: {}, binary: Buffer, inflateRaw: zlib.inflateRawSync, ids: { request: () => 'test00' },
  generationProvider: async () => ({ id: 'relay', label: 'relay', token: 'relay-token-unused', apiUrl: 'https://relay.invalid/generate' }),
  http: { async fetch(url, options) { requests.push({ url, method: options.method }); return reply(url); } }
});
const state = sanitizeGenerationState({ prompt: '1girl', model: 'nai-diffusion-4-5-full', params: { width: 832, height: 1216, steps: 28 } });
reply = () => new Response(webp, { headers: { 'content-type': 'application/octet-stream' } });
assert.equal((await client.generateImage(state, 42)).mime, 'image/webp', 'a mislabelled raw image is identified by its bytes');
reply = () => new Response(syntheticZip('image_0.png', png), { headers: { 'content-type': 'binary/octet-stream' } });
{ const zipped = await client.generateImage(state, 42); assert.deepEqual(zipped.buffer, png); assert.equal(zipped.filename, 'image_0.png'); }
reply = url => url.includes('relay.invalid') ? Response.json({ data: [{ url: 'https://cdn.invalid/1.png' }] }) : new Response(png, { headers: { 'content-type': 'image/png' } });
requests.length = 0;
const linked = await client.generateImage(state, 42);
assert.deepEqual(linked.buffer, png); assert.equal(linked.seed, 42);
assert.deepEqual(requests.map(item => `${item.method} ${item.url}`), ['POST https://relay.invalid/generate', 'GET https://cdn.invalid/1.png']);
reply = url => url.includes('relay.invalid') ? Response.json({ url: 'https://cdn.invalid/a.png' }) : Response.json({ url: 'https://cdn.invalid/b.png' });
await assert.rejects(client.generateImage(state, 42), /另一个链接/, 'no second hop');
reply = url => url.includes('relay.invalid') ? Response.json({ url: 'https://cdn.invalid/a.png' }) : new Response('gone', { status: 404 });
await assert.rejects(client.generateImage(state, 42), error => /HTTP 404/.test(error.message) && error.status === 502);
reply = () => Response.json({ error: 'insufficient quota' });
await assert.rejects(client.generateImage(state, 42), /insufficient quota/);
passed += 1;

console.log(`image response sniffing: ${passed} groups passed (raw/zip/NovelAI/OpenAI/link/event-stream/base64/errors/bounds/client)`);
