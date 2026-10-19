// Offline Android-host generation factory, real Chromium image codecs, no paid API.
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createServer } from 'node:http';
import { deflateSync } from 'node:zlib';
import { build } from 'esbuild';
import { makePngFixture } from '../../tests/png-metadata-fixtures.mjs';

if (!process.env.PLAYWRIGHT_MODULE) throw new Error('Set PLAYWRIGHT_MODULE to an existing Playwright index.mjs.');
const { chromium } = await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE).href);
const appRoot = path.resolve(import.meta.dirname, '..');
const bundled = await build({ absWorkingDir: appRoot, bundle: true, format: 'esm', write: false, target: 'chrome110',
  stdin: { resolveDir: appRoot, contents: `
    export { createNativeGenerationClient } from './src/novelai.js';
    export { createBrowserFocusedInpaintCodec } from '../public/focused-inpaint-browser.js';
    export { sanitizeGenerationState } from '../public/generation-payload.js';
    export { focusedInpaintPlan, FOCUSED_IMAGE_MAX_BYTES } from '../public/focused-inpaint.js';
    export { extractStandardPngMetadata, normalizeNovelAiMetadata } from '../public/png-metadata.js';
    export { createQueueControl } from '../service/queue-control.js';
    export { Buffer } from 'buffer';` },
  plugins: [{ name: 'versioned-shared-imports', setup(builder) {
    builder.onResolve({ filter: /\.js\?v=/ }, args => ({ path: path.resolve(args.resolveDir, args.path.split('?')[0]) }));
  } }]
});
const server = createServer((req, res) => {
  if (req.url === '/fixture.js') { res.writeHead(200, { 'Content-Type': 'text/javascript' }); res.end(bundled.outputFiles[0].text); }
  else if (req.url === '/') { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end('<!doctype html><title>Offline focused codec</title>'); }
  else { res.writeHead(404); res.end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
let browser;
try {
  browser = await chromium.launch({ executablePath: process.env.CHROME_BIN || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
  const page = await browser.newPage();
  const externalRequests = [];
  await page.route('**/*', route => {
    if (route.request().url().startsWith(origin + '/')) return route.continue();
    externalRequests.push(route.request().url()); return route.abort();
  });
  await page.goto(origin);
  const sourceWidth = 3072, sourceHeight = 96;
  const region = { x: 2304, y: 16, width: 128, height: 64, sourceWidth, sourceHeight };
  const pixels = Buffer.alloc(sourceWidth * sourceHeight * 4), mask = Buffer.alloc(pixels.length);
  for (let y = 0; y < sourceHeight; y++) for (let x = 0; x < sourceWidth; x++) {
    const at = (y * sourceWidth + x) * 4;
    pixels.set([x % 251, y * 2, (x + y * 3) % 256, x % 3 === 0 ? 0 : x % 3 === 1 ? 37 : 255], at);
    mask.set(x >= 2336 && x < 2400 && y >= 32 && y < 64 ? [255, 255, 255, 255] : [0, 0, 0, 255], at);
  }
  const filters = [0, 1, 2, 3, 4].map(filter => makePngFixture({ width: sourceWidth, height: sourceHeight, rgba: pixels, filter, splitIdat: true }).toString('base64'));
  function chunk(type, data) {
    const result = Buffer.alloc(data.length + 12); result.writeUInt32BE(data.length); result.write(type, 4); data.copy(result, 8);
    let crc = 0xffffffff;
    for (const byte of result.subarray(4, -4)) { crc ^= byte; for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); }
    result.writeUInt32BE((crc ^ 0xffffffff) >>> 0, result.length - 4); return result;
  }
  function smallPng(type, depth, scanline, extras = []) {
    const header = Buffer.alloc(13); header.writeUInt32BE(2); header.writeUInt32BE(1, 4); header[8] = depth; header[9] = type;
    return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk('IHDR', header), ...extras,
      chunk('IDAT', deflateSync(Buffer.from(scanline))), chunk('IEND', Buffer.alloc(0))]).toString('base64');
  }
  const colorFixtures = [
    { png: smallPng(2, 8, [0, 1, 2, 3, 201, 202, 203]), rgba: [1, 2, 3, 255, 201, 202, 203, 255] },
    { png: smallPng(0, 8, [0, 41, 207]), rgba: [41, 41, 41, 255, 207, 207, 207, 255] },
    { png: smallPng(4, 8, [0, 41, 0, 207, 37]), rgba: [41, 41, 41, 0, 207, 207, 207, 37] },
    { png: smallPng(3, 1, [0, 0b01000000], [chunk('PLTE', Buffer.from([11, 22, 33, 77, 88, 99])), chunk('tRNS', Buffer.from([0, 37]))]), rgba: [11, 22, 33, 0, 77, 88, 99, 37] },
    { png: smallPng(2, 8, [0, 1, 2, 3, 201, 202, 203], [chunk('tRNS', Buffer.from([0, 1, 0, 2, 0, 3]))]), rgba: [1, 2, 3, 0, 201, 202, 203, 255] }
  ];
  const rotatedTiff = Buffer.from([77, 77, 0, 42, 0, 0, 0, 8, 0, 1, 1, 18, 0, 3, 0, 0, 0, 1, 0, 6, 0, 0, 0, 0, 0, 0]);
  const rotatedPng = smallPng(2, 8, [0, 1, 2, 3, 201, 202, 203], [chunk('eXIf', rotatedTiff)]);
  const result = await page.evaluate(async ({ filters, colorFixtures, maskPng, region, unsupported, rotatedPng }) => {
    const m = await import('/fixture.js'), codec = m.createBrowserFocusedInpaintCodec();
    const assert = (value, message) => { if (!value) throw new Error(message); };
    const from64 = value => m.Buffer.from(value, 'base64');
    const equal = (a, b) => a.length === b.length && a.every((byte, index) => byte === b[index]);
    const source = await codec.decode(from64(filters[0]));
    for (const input of filters) {
      const decoded = await codec.decode(from64(input));
      assert(equal(decoded.data, source.data), 'PNG filter/split-IDAT source pixels changed');
    }
    const encodedSource = await codec.encode(source), roundtrip = await codec.decode(encodedSource);
    assert(equal(roundtrip.data, source.data), 'PNG roundtrip lost alpha or hidden RGB');
    const nativePng = await createImageBitmap(new Blob([encodedSource], { type: 'image/png' }));
    assert(nativePng.width === source.width && nativePng.height === source.height, 'native decoder rejected authored PNG'); nativePng.close();
    await codec.decode(from64(rotatedPng)).then(() => { throw new Error('rotated PNG accepted'); }, error => assert(/旋转/.test(error.message), 'wrong big-endian PNG EXIF error'));
    for (const fixture of colorFixtures) {
      const decoded = await codec.decode(from64(fixture.png));
      assert(equal(decoded.data, fixture.rgba), 'non-RGBA PNG palette/alpha decoding mismatch');
      assert(equal((await codec.decode(await codec.encode(decoded))).data, fixture.rgba), 'non-RGBA PNG roundtrip mismatch');
    }
    const regionPlan = m.focusedInpaintPlan(region, source.width, source.height);
    const generated = { width: regionPlan.width, height: regionPlan.height, data: new Uint8Array(regionPlan.width * regionPlan.height * 4) };
    for (let i = 0; i < generated.data.length; i += 4) generated.data.set([233, 100, 20, 255], i);
    const generatedPng = await codec.encode(generated), calls = [];
    const state = m.sanitizeGenerationState({
      prompt: '手部修补, offline fixture', negativePrompt: 'bad hands', model: 'nai-diffusion-5-full', seedMode: 'fixed', seed: 42,
      params: { width: source.width, height: source.height, steps: 23, scale: 5 }, v4Options: { useCoords: true },
      imageWorkflow: { mode: 'inpaint', strength: .55, baseImage: { source: 'asset', id: 'a'.repeat(32) }, maskImage: { source: 'asset', id: 'b'.repeat(32) }, inpaintRegion: region },
      characters: [{ name: 'inside', prompt: 'blue glove', centers: [{ x: 2368 / source.width, y: .5 }] },
        { name: 'outside', prompt: 'red coat', centers: [{ x: 0, y: 0 }] }]
    });
    let sourceBase64 = filters[4], responseBytes = generatedPng;
    const client = m.createNativeGenerationClient({ settings: { naiTimeoutMs: 30_000 }, ids: { request: () => 'offline-focused' },
      assets: { async base64ForRef(ref) { return ref.id === 'a'.repeat(32) ? sourceBase64 : maskPng; } },
      generationProvider: async () => ({ id: 'official', label: 'offline', token: 'fixture-not-a-token', apiUrl: 'https://offline.invalid/generate' }),
      http: { async fetch(url, options) {
        assert(url === 'https://offline.invalid/generate', 'unexpected provider URL');
        calls.push(JSON.parse(options.body));
        return new Response(responseBytes, { headers: { 'content-type': 'image/png' } });
      } }
    });
    const stateBefore = JSON.stringify(state), result = await client.generateImage(state, 42);
    assert(calls.length === 1, 'native focused path must issue exactly one mocked paid request');
    assert(JSON.stringify(state) === stateBefore && result.effectiveState === state, 'native generation mutated original state');
    const actual = calls[0].parameters;
    assert(actual.width === regionPlan.width && actual.height === regionPlan.height, 'native request did not use crop work dimensions');
    assert(actual.v4_prompt.caption.char_captions.length === 1, 'out-of-crop character leaked into native request');
    assert(actual.v4_prompt.caption.char_captions[0].centers[0].x === .5, 'native request did not map original character coordinates');
    const upload = await codec.decode(from64(actual.image)), uploadMask = await codec.decode(from64(actual.mask));
    assert(upload.width === regionPlan.width && uploadMask.height === regionPlan.height, 'mock paid request did not contain real work PNGs');
    assert(uploadMask.data.every((byte, index) => index % 4 === 3 ? byte === 255 : byte === 0 || byte === 255), 'work mask is not opaque binary black/white');
    const full = await codec.decode(result.buffer);
    assert(full.width === source.width && full.height === source.height, 'native composite changed full canvas dimensions');
    let preservedPixels = 0, changedPixels = 0;
    for (let y = 0; y < full.height; y++) for (let x = 0; x < full.width; x++) {
      const at = (y * full.width + x) * 4, selected = x >= 2336 && x < 2400 && y >= 32 && y < 64;
      const expected = selected ? [233, 100, 20, 255] : source.data.subarray(at, at + 4);
      assert(equal(full.data.subarray(at, at + 4), expected), `native composite changed unexpected RGBA at ${x},${y}`);
      if (selected) changedPixels++; else preservedPixels++;
    }
    const extracted = m.extractStandardPngMetadata(result.buffer), metadata = m.normalizeNovelAiMetadata(extracted.metadata, extracted);
    assert(metadata.params.width === source.width && metadata.params.height === source.height, 'native PNG metadata contains crop dimensions');
    assert(metadata.characters.length === 2 && metadata.characters[1].centers[0].x === 0, 'native PNG lost full-canvas characters');
    assert(metadata.prompt === state.prompt && metadata.params.steps === 23, 'native PNG parameters changed');
    const retryable = m.createQueueControl({ settings: {} }).retryable;
    responseBytes = await codec.encode({ width: 2, height: 2, data: new Uint8Array(16) });
    let compositeFailure;
    try { await client.generateImage(state, 43); } catch (error) { compositeFailure = error; }
    assert(compositeFailure?.imageReceived === true && !retryable(compositeFailure), 'paid native composite failure became retryable');
    const countBefore = calls.length;
    sourceBase64 = unsupported;
    let unsupportedFailure;
    try { await client.generateImage(state, 44); } catch (error) { unsupportedFailure = error; }
    assert(unsupportedFailure && calls.length === countBefore, 'unsupported source reached mocked paid endpoint');
    await Promise.all([
      codec.decode(from64(filters[0]), { signal: AbortSignal.abort() }).then(() => { throw new Error('decode ignored abort'); }, error => assert(error.name === 'AbortError', 'decode wrong abort error')),
      codec.encode(source, { signal: AbortSignal.abort() }).then(() => { throw new Error('encode ignored abort'); }, error => assert(error.name === 'AbortError', 'encode wrong abort error')),
      codec.decode(new Uint8Array(m.FOCUSED_IMAGE_MAX_BYTES + 1)).then(() => { throw new Error('oversized bytes accepted'); }, error => assert(/64 MiB/.test(error.message), 'wrong byte-limit error'))
    ]);
    const excessive = from64(filters[0]); new DataView(excessive.buffer, excessive.byteOffset).setUint32(16, 16384);
    new DataView(excessive.buffer, excessive.byteOffset).setUint32(20, 16384);
    await codec.decode(excessive).then(() => { throw new Error('oversized decoded image accepted'); }, error => assert(/1600/.test(error.message), 'wrong pixel-limit error'));

    const canvas = new OffscreenCanvas(16, 12), context = canvas.getContext('2d');
    context.fillStyle = '#79a4db'; context.fillRect(0, 0, 16, 12);
    const jpeg = new Uint8Array(await (await canvas.convertToBlob({ type: 'image/jpeg' })).arrayBuffer());
    const webp = new Uint8Array(await (await canvas.convertToBlob({ type: 'image/webp' })).arrayBuffer());
    for (const opaque of [jpeg, webp]) {
      const decoded = await codec.decode(opaque), encoded = await codec.encode(decoded), recovered = await codec.decode(encoded);
      assert(decoded.width === 16 && decoded.height === 12 && equal(decoded.data, recovered.data), 'opaque JPEG/WebP RGBA could not roundtrip through PNG');
    }
    // A genuine EXIF orientation entry must be rejected before browser auto-orientation.
    const tiff = orientation => {
      const bytes = new Uint8Array(26), v = new DataView(bytes.buffer); bytes.set([73, 73]);
      v.setUint16(2, 42, true); v.setUint32(4, 8, true); v.setUint16(8, 1, true);
      v.setUint16(10, 0x112, true); v.setUint16(12, 3, true); v.setUint32(14, 1, true); v.setUint16(18, orientation, true); return bytes;
    };
    const exifJpeg = orientation => {
      const data = tiff(orientation), segment = new Uint8Array(data.length + 10);
      segment.set([255, 225]); new DataView(segment.buffer).setUint16(2, data.length + 8);
      segment.set([69, 120, 105, 102, 0, 0], 4); segment.set(data, 10);
      return m.Buffer.concat([jpeg.subarray(0, 2), segment, jpeg.subarray(2)]);
    };
    assert((await codec.decode(exifJpeg(1))).width === 16, 'upright JPEG EXIF rejected');
    await codec.decode(exifJpeg(6)).then(() => { throw new Error('rotated JPEG accepted'); }, error => assert(/旋转/.test(error.message), 'wrong EXIF rotation error'));
    const exifWebp = orientation => {
      const data = tiff(orientation), segment = new Uint8Array(data.length + 8);
      segment.set([69, 88, 73, 70]); new DataView(segment.buffer).setUint32(4, data.length, true); segment.set(data, 8);
      const result = m.Buffer.concat([webp, segment]); new DataView(result.buffer, result.byteOffset).setUint32(4, result.length - 8, true); return result;
    };
    assert((await codec.decode(exifWebp(1))).width === 16, 'upright WebP EXIF rejected');
    await codec.decode(exifWebp(6)).then(() => { throw new Error('rotated WebP accepted'); }, error => assert(/旋转/.test(error.message), 'wrong WebP rotation error'));
    context.clearRect(0, 0, 16, 12); context.fillStyle = '#79a4db55'; context.fillRect(0, 0, 16, 12);
    const transparentWebp = new Uint8Array(await (await canvas.convertToBlob({ type: 'image/webp' })).arrayBuffer());
    await codec.decode(transparentWebp).then(() => { throw new Error('transparent WebP accepted'); }, error => assert(/透明/.test(error.message), 'wrong transparent WebP error'));
    return { preservedPixels, changedPixels, workWidth: regionPlan.width, workHeight: regionPlan.height, mockedCalls: calls.length, codec: 'real Chromium PNG/CompressionStream/JPEG/WebP' };
  }, { filters, colorFixtures, region, rotatedPng, maskPng: makePngFixture({ width: sourceWidth, height: sourceHeight, rgba: mask }).toString('base64'),
    unsupported: makePngFixture({ width: sourceWidth, height: sourceHeight, rgba: pixels, interlace: 1 }).toString('base64') });
  assert.deepEqual(externalRequests, [], 'all fixture work remains offline');
  assert.equal(result.preservedPixels, sourceWidth * sourceHeight - 64 * 32);
  assert.equal(result.changedPixels, 64 * 32);
  assert.equal(result.mockedCalls, 2);
  console.log('native focused inpaint:', JSON.stringify(result));
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
}
